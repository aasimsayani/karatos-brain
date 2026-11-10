import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { BIRDEYE_MAX_WINDOW, BIRDEYE_PAGE_SIZE, birdeyeClient, type BirdeyeClient, type BirdeyeClientOptions } from "./client.js";
import { birdeyeDay, birdeyeReviewEvent } from "./normalize.js";

/**
 * Birdeye: a store's reviews from every site Birdeye gathers them from
 * (Google, Facebook, Yelp and others, and its own direct feedback), for
 * marketing and clienteling.
 *
 * The first import reads reviews posted in the last five years; later syncs
 * read reviews changed since the day the last pass started, less a day, as
 * Birdeye filters by day. Reviews come 100 at a time and the checkpoint
 * keeps the offset, so a resumed sync goes on from the page it reached.
 * Each review is stored once per version, so the overlap comes back as
 * duplicates.
 *
 * Read-only: KaratOS never replies to a review or sends a review request.
 */

/** Declared so it can be gated and audited; it never runs while writes are off. */
export const BIRDEYE_WRITES: WriteAction[] = [{ integration: "birdeye", name: "reply_to_review", description: "Post the store's public reply to a review" }];

/** Each incremental pass starts a day before the previous one did, as Birdeye filters by day. */
export const BIRDEYE_OVERLAP_MS = 24 * 3_600_000;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface BirdeyeCursor {
  pass: "historical" | "incremental";
  /** The offset of the next page, or -1 once the pass is done. */
  sindex: number;
  /** A historical pass reads reviews posted from this time; an incremental one, reviews changed from it. */
  since: string;
  /** Where the next incremental pass starts. */
  nextFrom: string;
}

export interface BirdeyeOptions extends Partial<Pick<BirdeyeClientOptions, "fetch" | "sleep" | "retries">> {
  apiKey: string;
  businessId: string;
  /** Years of reviews the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: BirdeyeClient;
}

/** A time exactly as toISOString writes it. Anything that isn't a string never equals what toISOString gives back. */
const isTime = (t: unknown) => {
  const at = Date.parse(t as string);
  return !Number.isNaN(at) && new Date(at).toISOString() === t;
};

export function parseBirdeyeCursor(raw: string | null): BirdeyeCursor | null {
  if (raw === null) return null;
  let c: BirdeyeCursor | null;
  try {
    c = JSON.parse(raw) as BirdeyeCursor | null;
  } catch {
    c = null;
  }
  const ok =
    typeof c === "object" &&
    c !== null &&
    (c.pass === "historical" || c.pass === "incremental") &&
    Number.isSafeInteger(c.sindex) &&
    c.sindex >= -1 &&
    c.sindex < BIRDEYE_MAX_WINDOW &&
    isTime(c.since) &&
    isTime(c.nextFrom);
  if (!ok || !c) throw new Error("Birdeye checkpoint is not in the expected shape");
  return { pass: c.pass, sindex: c.sindex, since: c.since, nextFrom: c.nextFrom };
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

export function birdeyeConnector(options: BirdeyeOptions): Connector {
  const client = options.client ?? birdeyeClient(options);
  const businessId = options.businessId.trim();
  const now = options.now ?? (() => new Date());
  const historyYears = positive(options.historyYears ?? 5, "historyYears");
  const lookbackHours = positive(options.incrementalLookbackHours ?? 48, "incrementalLookbackHours");

  function start(mode: "historical" | "incremental", saved: BirdeyeCursor | null, at: Date): BirdeyeCursor {
    let since: string;
    if (mode === "historical") {
      const from = new Date(at);
      from.setUTCFullYear(from.getUTCFullYear() - historyYears);
      since = from.toISOString();
    } else {
      since = saved?.nextFrom ?? new Date(at.getTime() - lookbackHours * 3_600_000).toISOString();
    }
    return { pass: mode, sindex: 0, since, nextFrom: new Date(at.getTime() - BIRDEYE_OVERLAP_MS).toISOString() };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseBirdeyeCursor(context.cursor);
    const at = now();
    if (mode === "historical" && saved?.pass === "historical" && saved.sindex === -1) return;
    let c = saved?.pass === mode && saved.sindex >= 0 ? saved : start(mode, saved, at);
    const receivedAt = at.toISOString();
    const day = birdeyeDay(c.since);
    while (c.sindex >= 0) {
      const reviews = await client.reviews({ ...(c.pass === "historical" ? { fromDate: day } : { updateFromDate: day }), sindex: c.sindex });
      const events = reviews.flatMap((r) => birdeyeReviewEvent(r, { receivedAt, businessId }) ?? []);
      // A full page may have more behind it; a short one is the last.
      c = { ...c, sindex: reviews.length >= BIRDEYE_PAGE_SIZE ? c.sindex + BIRDEYE_PAGE_SIZE : -1 };
      yield { events, cursor: JSON.stringify(c) };
    }
  }

  return {
    source: "birdeye",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: BIRDEYE_WRITES,
  };
}
