import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { JUDGEME_MAX_PAGE, JUDGEME_REVIEW_PAGE, judgemeClient, type JudgemeClient, type JudgemeClientOptions } from "./client.js";
import { judgemeReviewEvent } from "./normalize.js";

/**
 * Judge.me: the store's product and store reviews, each on the product and
 * customer it is about, with low ratings marked for follow-up, so staff can
 * thank fans and look after unhappy buyers.
 *
 * Judge.me lists a shop's reviews a page at a time by number, with no filter
 * by date. So every pass reads every page, and keeps the reviews posted or
 * changed since its day:
 *
 * - The historical import keeps five years by default.
 * - Each later sync keeps what changed since two days before the last pass
 *   started, since Judge.me doesn't say which time zone its times are in.
 *   A review read again unchanged is a duplicate.
 *
 * Each page is one batch and one checkpoint, which keeps the pass's day and
 * the next page, so a resumed pass goes on from that page. Judge.me can send
 * webhooks, but the connector polls so it needs no public route.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const JUDGEME_WRITES: WriteAction[] = [
  { integration: "judgeme", name: "reply_to_review", description: "Post the store's public reply to a Judge.me review", kind: "append", approval: "each", dailyCap: 20 },
  { integration: "judgeme", name: "set_review_visibility", description: "Publish or hide a Judge.me review", kind: "update", approval: "each", dailyCap: 20 },
];

const DAY_MS = 86_400_000;
/** Each later pass starts this many days before the last one did. */
export const JUDGEME_OVERLAP_DAYS = 2;

/** Where a Judge.me pass stands: its day and the next page. */
export interface JudgemePass {
  since: string;
  /** The next page, from 1. */
  page: number;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `nextFrom` is the day the next later sync starts. */
export interface JudgemeCursor {
  pass: JudgemePass | null;
  /** The historical import finished. */
  done: boolean;
  nextFrom: string;
}

export interface JudgemeOptions extends Partial<Pick<JudgemeClientOptions, "fetch" | "sleep" | "retries">> {
  shopDomain: string;
  apiToken: string;
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** Reviews older than this many years are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: JudgemeClient;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && day(Date.parse(`${v}T00:00:00Z`)) === v;

export function parseJudgemeCursor(raw: string | null): JudgemeCursor | null {
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
    if (isDay(p?.since) && Number.isSafeInteger(p.page) && (p.page as number) >= 1) return { pass: { since: p.since, page: p.page as number }, done: r.done, nextFrom: r.nextFrom };
  }
  throw new Error("Judge.me checkpoint is not in the expected shape");
}

export function judgemeConnector(options: JudgemeOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const client = options.client ?? judgemeClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads a pass to its end. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(pass: JudgemePass, done: boolean, doneAtEnd: boolean, nextFrom: string, receivedAt: string): AsyncIterable<SourceBatch> {
    // An ISO time on or after the day sorts at or after the day itself.
    const from = pass.since;
    for (let page = pass.page; ; page++) {
      const rows = await client.reviews(page);
      // Kept when posted or changed since the pass's day; one that doesn't read is kept to be dead-lettered.
      const events = rows
        .map((row) => judgemeReviewEvent(row, { customerKey, receivedAt }))
        .filter(({ ok, event }) => !ok || String(event.payload.editedAt ?? event.payload.publishedAt) >= from)
        .map(({ event }) => event);
      // A short page is the last; so is the last page a pass may ask for.
      const last = rows.length < JUDGEME_REVIEW_PAGE || page === JUDGEME_MAX_PAGE;
      const cursor: JudgemeCursor = last ? { pass: null, done: doneAtEnd, nextFrom } : { pass: { since: pass.since, page: page + 1 }, done, nextFrom };
      yield { events, cursor: JSON.stringify(cursor) };
      if (last) return;
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseJudgemeCursor(context.cursor);
    if (saved?.done) return;
    if (saved?.pass) return yield* walk(saved.pass, false, true, saved.nextFrom, now().toISOString());
    const at = now();
    const from = new Date(at.getTime());
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    yield* walk({ since: day(from.getTime()), page: 1 }, false, true, day(at.getTime() - JUDGEME_OVERLAP_DAYS * DAY_MS), at.toISOString());
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseJudgemeCursor(context.cursor);
    const at = now();
    if (saved?.pass) return yield* walk(saved.pass, saved.done, saved.done, saved.nextFrom, at.toISOString());
    const since = saved?.nextFrom ?? day(at.getTime() - JUDGEME_OVERLAP_DAYS * DAY_MS);
    yield* walk({ since, page: 1 }, saved?.done ?? false, saved?.done ?? false, day(at.getTime() - JUDGEME_OVERLAP_DAYS * DAY_MS), at.toISOString());
  }

  return { source: "judgeme", historicalImport, incrementalSync, writes: JUDGEME_WRITES };
}
