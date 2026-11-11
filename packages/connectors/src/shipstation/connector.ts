import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { quoTime } from "../openphone/normalize.js";
import { SHIPSTATION_MAX_PAGE, SHIPSTATION_PAGE_SIZE, shipStationClient, type ShipStationClient, type ShipStationClientOptions, type ShipStationList } from "./client.js";
import { shipStationLabelEvent, shipStationShipmentEvent } from "./normalize.js";

/**
 * ShipStation: the store's shipments and labels, with each parcel's
 * insured value next to what was sold and its tracking until it arrives,
 * so high-value parcels are watched until delivered.
 *
 * ShipStation lists shipments by when they last changed and labels by when
 * they were made, oldest first, 100 a page by number, from a time. So:
 *
 * - The historical import reads both lists from two years back, shipments
 *   first.
 * - Each later sync reads shipments changed since the newest change the
 *   last one saw, less five minutes, and labels made in the last 30 days
 *   again, since a label's tracking status changes without the label
 *   being made again. The first later sync looks back two days for
 *   shipments. A record read again unchanged is a duplicate.
 *
 * Each page is one batch, and the checkpoint keeps the list, its start, the
 * next page and the newest change seen, so a resumed sync goes on from
 * that page.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const SHIPSTATION_WRITES: WriteAction[] = [
  { integration: "shipstation", name: "create_label", description: "Buy a shipping label in ShipStation, paid from the account's postage balance", kind: "append", approval: "each", dailyCap: 10 },
  { integration: "shipstation", name: "add_tracking", description: "Add a tracking number to a ShipStation order", kind: "update", approval: "each", dailyCap: 20 },
];

const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;
/** Each later sync reads shipments from this long before the newest change the last one saw. */
export const SHIPSTATION_OVERLAP_MS = 5 * MINUTE_MS;
/** A first later sync with no checkpoint reads shipments changed this far back. */
export const SHIPSTATION_FIRST_LOOKBACK_MS = 2 * DAY_MS;
/** Each later sync reads labels made in this many days again. */
export const SHIPSTATION_LABEL_DAYS = 30;
const LISTS: readonly ShipStationList[] = ["shipments", "labels"];

/** Where a list stands: its start, the next page, and the newest shipment change seen. */
export interface ShipStationPass {
  list: ShipStationList;
  since: string;
  page: number;
  top: string | null;
}

/** Serialized as the runSync checkpoint. */
export interface ShipStationCursor {
  /** The historical import finished. */
  done: boolean;
  /** The newest shipment change a finished pass saw. */
  mark: string | null;
  /** The list being read, or null between syncs. */
  pass: ShipStationPass | null;
}

export interface ShipStationOptions extends Partial<Pick<ShipStationClientOptions, "fetch" | "sleep" | "retries">> {
  apiKey: string;
  /** Records older than this many years are skipped. Defaults to 2. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: ShipStationClient;
}

const isTime = (v: unknown): v is string => typeof v === "string" && quoTime(v) === v;
const mark = (v: unknown) => v === null || isTime(v);

export function parseShipStationCursor(raw: string | null): ShipStationCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    // Not JSON: fails the checks below.
  }
  const r = (c ?? {}) as Record<string, unknown>;
  const p = (r.pass ?? {}) as Record<string, unknown>;
  const pass = r.pass === null || (LISTS.includes(p.list as ShipStationList) && isTime(p.since) && Number.isSafeInteger(p.page) && (p.page as number) >= 1 && (p.page as number) <= SHIPSTATION_MAX_PAGE && mark(p.top));
  if (typeof r.done === "boolean" && mark(r.mark) && pass) {
    return { done: r.done, mark: r.mark as string | null, pass: r.pass === null ? null : { list: p.list as ShipStationList, since: p.since as string, page: p.page as number, top: p.top as string | null } };
  }
  throw new Error("ShipStation checkpoint is not in the expected shape");
}

export function shipStationConnector(options: ShipStationOptions): Connector {
  const client = options.client ?? shipStationClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 2;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads each list to its end, from where `state` stands. `sinceFor` is where a list starts that has no pass yet. */
  async function* read(state: ShipStationCursor, sinceFor: (list: ShipStationList) => string, doneAtEnd: boolean): AsyncIterable<SourceBatch> {
    let shipmentsMark = state.mark;
    let pass = state.pass ?? { list: LISTS[0]!, since: sinceFor(LISTS[0]!), page: 1, top: null };
    for (;;) {
      const page = await client.page(pass.list, pass.since, pass.page);
      const ctx = { receivedAt: now().toISOString() };
      const events = page.rows.map((row) => (pass.list === "shipments" ? shipStationShipmentEvent(row, ctx) : shipStationLabelEvent(row, ctx)).event);
      if (pass.list === "shipments") {
        for (const row of page.rows) {
          const changed = quoTime((row as { modified_at?: unknown } | null)?.modified_at);
          // "" sorts before any time, so a row with no time that reads never moves the mark.
          if ((changed ?? "") > (pass.top ?? "")) pass = { ...pass, top: changed };
        }
      }
      let last = false;
      if (pass.page < page.pages && page.rows.length === SHIPSTATION_PAGE_SIZE && pass.page < SHIPSTATION_MAX_PAGE) pass = { ...pass, page: pass.page + 1 };
      else {
        if (pass.list === "shipments") shipmentsMark = pass.top ?? shipmentsMark;
        const next = LISTS[LISTS.indexOf(pass.list) + 1];
        if (next) pass = { list: next, since: sinceFor(next), page: 1, top: null };
        else last = true;
      }
      const cursor: ShipStationCursor = { done: last ? doneAtEnd : state.done, mark: shipmentsMark, pass: last ? null : pass };
      yield { events, cursor: JSON.stringify(cursor) };
      if (last) return;
    }
  }

  const fresh = (): ShipStationCursor => ({ done: false, mark: null, pass: null });

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseShipStationCursor(context.cursor);
    if (saved?.done) return;
    const floor = now();
    floor.setUTCFullYear(floor.getUTCFullYear() - historyYears);
    yield* read(saved ?? fresh(), () => floor.toISOString(), true);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const state = parseShipStationCursor(context.cursor) ?? fresh();
    const sinceFor = (list: ShipStationList) => {
      if (list === "labels") return new Date(now().getTime() - SHIPSTATION_LABEL_DAYS * DAY_MS).toISOString();
      return new Date(state.mark ? Date.parse(state.mark) - SHIPSTATION_OVERLAP_MS : now().getTime() - SHIPSTATION_FIRST_LOOKBACK_MS).toISOString();
    };
    yield* read(state, sinceFor, state.done);
  }

  return { source: "shipstation", historicalImport, incrementalSync, writes: SHIPSTATION_WRITES };
}
