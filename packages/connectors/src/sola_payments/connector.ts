import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { SOLA_REPORT_PAGE, SolaConfigError, solaClient, type SolaClient, type SolaClientOptions } from "./client.js";
import { solaTransactionEvent, solaWallClock } from "./normalize.js";

/**
 * Sola Payments (formerly Cardknox): the store's card and check payments
 * and refunds through its gateway, so finance can reconcile them, layaway
 * installments included, against sales and deposits.
 *
 * Sola's transaction report lists what was entered between two wall-clock
 * times in the account's zone, oldest first, at most 1,000 rows at a time;
 * past that, the next request starts at the last row's time. So a pass
 * reads the report a month at a time, and page by page within each month:
 *
 * - The historical import covers five years by default.
 * - Each later sync covers from two days before the last pass, by day, so
 *   a void or late capture near the end of a day is read again. A row read
 *   again unchanged is a duplicate.
 *
 * Each page is one batch and one checkpoint, which keeps the pass's days
 * and the time the next page starts at, so a resumed pass goes on from
 * there. Sola can send webhooks, but the connector polls so it needs no
 * public route.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const SOLA_WRITES: WriteAction[] = [
  { integration: "sola_payments", name: "create_payment_link", description: "Create a Sola payment link for a layaway installment", kind: "append", approval: "each", dailyCap: 10 },
  { integration: "sola_payments", name: "create_recurring_schedule", description: "Set up a Sola recurring schedule for a layaway", kind: "append", approval: "each", dailyCap: 5 },
];

const DAY_MS = 86_400_000;
/** Days in one report request. */
export const SOLA_SPAN_DAYS = 31;
/** Each later pass starts this many days before the last one did. */
export const SOLA_OVERLAP_DAYS = 2;
export const SOLA_DEFAULT_TIME_ZONE = "America/New_York";

/** Where a Sola pass stands: its last day, and the account-clock time the next page starts at. */
export interface SolaPass {
  until: string;
  begin: string;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `nextFrom` is the day the next later sync starts. */
export interface SolaCursor {
  pass: SolaPass | null;
  /** The historical import finished. */
  done: boolean;
  nextFrom: string;
}

export interface SolaOptions extends Partial<Pick<SolaClientOptions, "fetch" | "sleep" | "retries">> {
  apiKey: string;
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** The account's IANA time zone, which Sola's report times are in. Defaults to America/New_York. */
  timeZone?: string | undefined;
  /** Transactions older than this many years are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: SolaClient;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && day(Date.parse(`${v}T00:00:00Z`)) === v;
const isWall = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) && isDay(v.slice(0, 10)) && Number(v.slice(11, 13)) < 24 && Number(v.slice(14, 16)) < 60 && Number(v.slice(17)) < 60;
const addDays = (d: string, n: number) => day(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS);
const nextSecond = (wall: string) => new Date(Date.parse(`${wall.replace(" ", "T")}Z`) + 1000).toISOString().slice(0, 19).replace("T", " ");

export function parseSolaCursor(raw: string | null): SolaCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    c = null;
  }
  const r = typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
  if (r && typeof r.done === "boolean" && isDay(r.nextFrom)) {
    if (r.pass === null) return { pass: null, done: r.done, nextFrom: r.nextFrom };
    // Anything but an object fails the checks below: a string or number has no such fields.
    const p = r.pass as Record<string, unknown> | undefined;
    if (isDay(p?.until) && isWall(p.begin)) return { pass: { until: p.until, begin: p.begin }, done: r.done, nextFrom: r.nextFrom };
  }
  throw new Error("Sola checkpoint is not in the expected shape");
}

export function solaConnector(options: SolaOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const timeZone = options.timeZone?.trim() || SOLA_DEFAULT_TIME_ZONE;
  try {
    solaWallClock(0, timeZone);
  } catch {
    throw new SolaConfigError("SOLA_TIME_ZONE is not an IANA time zone such as America/New_York");
  }
  const client = options.client ?? solaClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads a pass to its end. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(pass: SolaPass, done: boolean, doneAtEnd: boolean, nextFrom: string, receivedAt: string): AsyncIterable<SourceBatch> {
    let begin = pass.begin;
    for (;;) {
      const spanEnd = `${[addDays(begin.slice(0, 10), SOLA_SPAN_DAYS - 1), pass.until].sort()[0]} 23:59:59`;
      const rows = await client.transactions(begin, spanEnd);
      const reads = rows.map((row) => solaTransactionEvent(row, { customerKey, timeZone, receivedAt }));
      const events = reads.flatMap((r) => (r.event ? [r.event] : []));
      if (rows.length >= SOLA_REPORT_PAGE) {
        // A full page: the next one starts at the last row's time, whose repeats are duplicates. One that wouldn't move on moves a second.
        const last = reads.map((r) => r.wall).filter((w): w is string => w !== undefined && w <= spanEnd).sort().at(-1);
        begin = last && last > begin ? last : nextSecond(begin);
      } else begin = `${addDays(spanEnd.slice(0, 10), 1)} 00:00:00`;
      const more = begin.slice(0, 10) <= pass.until;
      const cursor: SolaCursor = more ? { pass: { ...pass, begin }, done, nextFrom } : { pass: null, done: doneAtEnd, nextFrom };
      yield { events, cursor: JSON.stringify(cursor) };
      if (!more) return;
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseSolaCursor(context.cursor);
    if (saved?.done) return;
    if (saved?.pass) return yield* walk(saved.pass, false, true, saved.nextFrom, now().toISOString());
    const at = now();
    const until = solaWallClock(at.getTime(), timeZone).slice(0, 10);
    const from = new Date(`${until}T00:00:00Z`);
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    yield* walk({ until, begin: `${day(from.getTime())} 00:00:00` }, false, true, addDays(until, -SOLA_OVERLAP_DAYS), at.toISOString());
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseSolaCursor(context.cursor);
    const at = now();
    if (saved?.pass) return yield* walk(saved.pass, saved.done, saved.done, saved.nextFrom, at.toISOString());
    const until = solaWallClock(at.getTime(), timeZone).slice(0, 10);
    const from = saved?.nextFrom ?? addDays(until, -SOLA_OVERLAP_DAYS);
    yield* walk({ until, begin: `${from} 00:00:00` }, saved?.done ?? false, saved?.done ?? false, addDays(until, -SOLA_OVERLAP_DAYS), at.toISOString());
  }

  return { source: "sola_payments", historicalImport, incrementalSync, writes: SOLA_WRITES };
}
