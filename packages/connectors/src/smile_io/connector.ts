import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { quoTime } from "../openphone/normalize.js";
import { SMILE_CURSOR, smileClient, type SmileClient, type SmileClientOptions, type SmileList } from "./client.js";
import { smileCustomerEvent, smilePointsEvent, smileTierNames } from "./normalize.js";

/**
 * Smile.io: the store's loyalty program. Each customer's points balance
 * and VIP tier, and every points transaction, so staff see a customer's
 * points and tier at the counter and marketing spots lapsed members early.
 *
 * Smile lists customers and points transactions newest first and can
 * filter them to those changed since a time. So:
 *
 * - The historical import reads everything changed in the last five
 *   years, customers first.
 * - Each later sync reads what changed since the newest change the last
 *   one saw, less five minutes; with no checkpoint it looks back two days.
 *   An unchanged record read again is a duplicate.
 *
 * Each sync reads the VIP tiers first, to name each customer's tier. Each
 * page is one batch and one checkpoint, which keeps the list, its start,
 * the newest change seen and Smile's cursor, so a resumed sync goes on
 * from that page.
 */

/** Declared so it can be gated and audited; it doesn't run while writes are off, and the client has no way to send it. */
export const SMILE_WRITES: WriteAction[] = [{ integration: "smile_io", name: "adjust_points", description: "Add or take away a customer's Smile.io points", kind: "update", approval: "each", dailyCap: 10 }];

const MINUTE_MS = 60_000;
/** Each later sync reads back this far past the newest change it last saw. */
export const SMILE_OVERLAP_MS = 5 * MINUTE_MS;
/** With no checkpoint, the first later sync looks this far back. */
export const SMILE_FIRST_LOOKBACK_MS = 48 * 60 * MINUTE_MS;
const LISTS: readonly SmileList[] = ["customers", "points_transactions"];

/** Where a list stands: what it reads from, the newest change it has seen, and the cursor of the next page. */
export interface SmilePass {
  list: SmileList;
  since: string;
  top: string | null;
  cursor: string | null;
}

/** Serialized as the runSync checkpoint. `marks` is the newest change each list's last pass saw. */
export interface SmileCursor {
  /** The historical import finished. */
  done: boolean;
  marks: Record<SmileList, string | null>;
  /** The list being read, or null between syncs. */
  pass: SmilePass | null;
}

export interface SmileOptions extends Partial<Pick<SmileClientOptions, "fetch" | "sleep" | "retries">> {
  apiKey: string;
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** How many years back the historical import reads. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: SmileClient;
}

const isTime = (v: unknown): v is string => typeof v === "string" && quoTime(v) === v;
const mark = (v: unknown) => v === null || isTime(v);

export function parseSmileCursor(raw: string | null): SmileCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    // Not JSON: fails the checks below.
  }
  const r = (c ?? {}) as Record<string, unknown>;
  const m = (r.marks ?? {}) as Record<string, unknown>;
  const p = (r.pass ?? {}) as Record<string, unknown>;
  const pass = r.pass === null || (LISTS.includes(p.list as SmileList) && isTime(p.since) && mark(p.top) && (p.cursor === null || (typeof p.cursor === "string" && SMILE_CURSOR.test(p.cursor))));
  if (typeof r.done === "boolean" && mark(m.customers) && mark(m.points_transactions) && pass) {
    return {
      done: r.done,
      marks: { customers: m.customers as string | null, points_transactions: m.points_transactions as string | null },
      pass: r.pass === null ? null : { list: p.list as SmileList, since: p.since as string, top: p.top as string | null, cursor: p.cursor as string | null },
    };
  }
  throw new Error("Smile.io checkpoint is not in the expected shape");
}

export function smileConnector(options: SmileOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const client = options.client ?? smileClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads each list to its end, from where `state` stands. `sinceFor` is where a list starts that has no pass yet. */
  async function* read(state: SmileCursor, sinceFor: (list: SmileList) => string, doneAtEnd: boolean): AsyncIterable<SourceBatch> {
    const tiers = smileTierNames(await client.vipTiers());
    const marks = { ...state.marks };
    let pass = state.pass ?? { list: LISTS[0]!, since: sinceFor(LISTS[0]!), top: null, cursor: null };
    for (;;) {
      const page = await client.page(pass.list, pass.since, pass.cursor);
      const ctx = { customerKey, receivedAt: now().toISOString(), tiers };
      const events = page.rows.map((row) => (pass.list === "customers" ? smileCustomerEvent(row, ctx) : smilePointsEvent(row, ctx)).event);
      for (const row of page.rows) {
        const changed = quoTime((row as { updated_at?: unknown } | null)?.updated_at);
        // "" sorts before any time, so a row with no time that reads never moves the mark.
        if ((changed ?? "") > (pass.top ?? "")) pass = { ...pass, top: changed };
      }
      let last = false;
      if (page.next) pass = { ...pass, cursor: page.next };
      else {
        marks[pass.list] = pass.top ?? marks[pass.list];
        const next = LISTS[LISTS.indexOf(pass.list) + 1];
        if (next) pass = { list: next, since: sinceFor(next), top: null, cursor: null };
        else last = true;
      }
      const cursor: SmileCursor = { done: last ? doneAtEnd : state.done, marks, pass: last ? null : pass };
      yield { events, cursor: JSON.stringify(cursor) };
      if (last) return;
    }
  }

  const fresh = (): SmileCursor => ({ done: false, marks: { customers: null, points_transactions: null }, pass: null });

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseSmileCursor(context.cursor);
    if (saved?.done) return;
    const floor = now();
    floor.setUTCFullYear(floor.getUTCFullYear() - historyYears);
    yield* read(saved ?? fresh(), () => floor.toISOString(), true);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const state = parseSmileCursor(context.cursor) ?? fresh();
    const sinceFor = (list: SmileList) => {
      const seen = state.marks[list];
      return new Date(seen ? Date.parse(seen) - SMILE_OVERLAP_MS : now().getTime() - SMILE_FIRST_LOOKBACK_MS).toISOString();
    };
    yield* read(state, sinceFor, state.done);
  }

  return { source: "smile_io", historicalImport, incrementalSync, writes: SMILE_WRITES };
}
