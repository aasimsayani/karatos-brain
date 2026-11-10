import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { ETSY_EPOCH_MIN, ETSY_LISTING_STATES, ETSY_PAGE_SIZE, etsyClient, type EtsyClient, type EtsyClientOptions, type EtsyRecord } from "./client.js";
import { etsyListingEvents, etsyReceiptEvents, type EtsyBrainEvent, type EtsyContext } from "./normalize.js";

/**
 * Etsy: a shop's orders, sales and refunds, and its listings with their
 * stock, for the sales, inventory and marketing departments.
 *
 * Each pass reads every listing, state by state, then receipts. The first
 * import reads receipts created in the last five years; each sync after
 * reads receipts changed since the last pass started, less a quarter hour.
 * Receipts are read oldest first, 100 at a time, from the time the last
 * page reached (with an offset only past receipts sharing one second), so
 * a page never shifts under the reader. The checkpoint keeps where it got
 * to, and what a pass reads twice comes back as duplicates.
 *
 * Read-only: KaratOS never changes anything on Etsy.
 */

/** Declared so they can be gated and audited; they never run while writes are off, and no write scope is asked for. */
export const ETSY_WRITES: WriteAction[] = [
  { integration: "etsy", name: "update_listing_inventory", description: "Change a listing's stock or price on Etsy" },
  { integration: "etsy", name: "mark_receipt_shipped", description: "Mark an Etsy order shipped with its tracking number" },
];

/** Each incremental pass starts this long before the previous one did. */
export const ETSY_OVERLAP_S = 15 * 60;

/** Where a pass is: a listing state by its position, then receipts, then done. */
const RECEIPTS = ETSY_LISTING_STATES.length;
const DONE = RECEIPTS + 1;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface EtsyCursor {
  pass: "historical" | "incremental";
  /** 0 to 4 for the listing states, 5 for receipts, 6 once the pass is done. */
  step: number;
  /** How far into the current list: listings by offset, receipts past `since`. */
  offset: number;
  /** Epoch seconds the receipts are read from. */
  since: number;
  /** Where the next incremental pass starts. */
  nextSince: number;
}

export interface EtsyConnectorOptions extends EtsyClientOptions {
  /** Years of receipts the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: EtsyClient;
}

const isSeconds = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= ETSY_EPOCH_MIN;

export function parseEtsyCursor(raw: string | null): EtsyCursor | null {
  if (raw === null) return null;
  let c: EtsyCursor | null;
  try {
    c = JSON.parse(raw) as EtsyCursor | null;
  } catch {
    c = null;
  }
  const ok =
    typeof c === "object" &&
    c !== null &&
    (c.pass === "historical" || c.pass === "incremental") &&
    Number.isInteger(c.step) &&
    c.step >= 0 &&
    c.step <= DONE &&
    Number.isSafeInteger(c.offset) &&
    c.offset >= 0 &&
    isSeconds(c.since) &&
    isSeconds(c.nextSince);
  if (!ok || !c) throw new Error("Etsy checkpoint is not in the expected shape");
  return { pass: c.pass, step: c.step, offset: c.offset, since: c.since, nextSince: c.nextSince };
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

/** A receipt's time in the order it was read: created for the import, updated after. */
const timeOf = (r: EtsyRecord, by: "created" | "updated") => {
  const t = by === "created" ? (r.created_timestamp ?? r.create_timestamp) : (r.updated_timestamp ?? r.update_timestamp);
  return isSeconds(t) ? t : undefined;
};

export function etsyConnector(options: EtsyConnectorOptions): Connector {
  const client = options.client ?? etsyClient(options);
  const shopId = options.shopId.trim();
  const now = options.now ?? (() => new Date());
  const historyYears = positive(options.historyYears ?? 5, "historyYears");
  const lookbackHours = positive(options.incrementalLookbackHours ?? 48, "incrementalLookbackHours");

  function start(mode: "historical" | "incremental", saved: EtsyCursor | null, atS: number, at: Date): EtsyCursor {
    let since: number;
    if (mode === "historical") {
      const from = new Date(at);
      from.setUTCFullYear(from.getUTCFullYear() - historyYears);
      since = Math.floor(from.getTime() / 1000);
    } else {
      since = saved?.nextSince ?? atS - lookbackHours * 3600;
    }
    return { pass: mode, step: 0, offset: 0, since: Math.max(since, ETSY_EPOCH_MIN), nextSince: atS - ETSY_OVERLAP_S };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseEtsyCursor(context.cursor);
    const at = now();
    const atS = Math.floor(at.getTime() / 1000);
    // A finished import stays finished; an interrupted pass resumes; anything else starts a new pass.
    if (mode === "historical" && saved?.pass === "historical" && saved.step === DONE) return;
    let c = saved?.pass === mode && saved.step < DONE ? saved : start(mode, saved, atS, at);
    const ctx: EtsyContext = { receivedAt: at.toISOString(), shopId };
    const by = c.pass === "historical" ? "created" : "updated";

    while (c.step < DONE) {
      let events: EtsyBrainEvent[];
      if (c.step < RECEIPTS) {
        const listings = await client.listings(ETSY_LISTING_STATES[c.step]!, c.offset);
        events = listings.flatMap((l) => etsyListingEvents(l, ctx));
        c = listings.length >= ETSY_PAGE_SIZE ? { ...c, offset: c.offset + ETSY_PAGE_SIZE } : { ...c, step: c.step + 1, offset: 0 };
      } else {
        const receipts = await client.receipts({ by, since: c.since, offset: c.offset });
        events = receipts.flatMap((r) => etsyReceiptEvents(r, ctx));
        if (receipts.length < ETSY_PAGE_SIZE) {
          c = { ...c, step: DONE, offset: 0 };
        } else {
          const times = receipts.map((r) => timeOf(r, by));
          const last = times.at(-1);
          // Each page has to move forward, or the receipts would be read forever.
          if (last === undefined || last < c.since) throw new Error("Etsy answered a full page of receipts without a readable time in order");
          // The next page starts at the last time read, past the receipts already read at that second.
          const sameSecond = times.filter((t) => t === last).length;
          c = last === c.since ? { ...c, offset: c.offset + ETSY_PAGE_SIZE } : { ...c, since: last, offset: sameSecond };
        }
      }
      yield { events, cursor: JSON.stringify(c) };
    }
  }

  return {
    source: "etsy",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: ETSY_WRITES,
  };
}
