import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { YOTPO_MAX_PAGE, YOTPO_REVIEW_PAGE, yotpoClient, type YotpoClient, type YotpoClientOptions } from "./client.js";
import { yotpoLoyaltyEvent, yotpoReviewEvent } from "./normalize.js";

/**
 * Yotpo: the store's product and site reviews, and its Loyalty members'
 * points and tiers, so staff can thank fans and look after unhappy buyers.
 *
 * Yotpo lists reviews updated since a day, a page at a time by number, and
 * Loyalty members updated in the last seven days, by cursor. So a pass
 * reads the reviews and then, when Loyalty is set up, the members:
 *
 * - The historical import covers five years of reviews by default.
 *   Loyalty only lists the last seven days, so older balances arrive as
 *   members next change.
 * - Each later sync reads reviews updated since two days before the last
 *   pass started, since Yotpo's data lags an hour and its days aren't
 *   documented as UTC. An unchanged review or balance is a duplicate.
 *
 * Each page is one batch and one checkpoint, which keeps the pass's day,
 * the step and the page, so a resumed pass goes on from that page. Yotpo
 * can send webhooks, but the connector polls so it needs no public route.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const YOTPO_WRITES: WriteAction[] = [
  { integration: "yotpo", name: "reply_to_review", description: "Post the store's public reply to a Yotpo review", kind: "append", approval: "each", dailyCap: 20 },
  { integration: "yotpo", name: "adjust_points", description: "Add or take away a Loyalty member's points", kind: "update", approval: "each", dailyCap: 20 },
];

const DAY_MS = 86_400_000;
/** Each later pass starts this many days before the last one did. */
export const YOTPO_OVERLAP_DAYS = 2;

/** Where a Yotpo pass stands: its day, the step (reviews, then Loyalty), and the next page. */
export interface YotpoPass {
  since: string;
  step: 0 | 1;
  /** The next reviews page, from 1. */
  page: number;
  /** The next Loyalty cursor, or null for the first page. */
  pageInfo: string | null;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `nextFrom` is the day the next later sync starts. */
export interface YotpoCursor {
  pass: YotpoPass | null;
  /** The historical import finished. */
  done: boolean;
  nextFrom: string;
}

export interface YotpoOptions extends Partial<Pick<YotpoClientOptions, "fetch" | "sleep" | "retries" | "loyaltyGuid" | "loyaltyApiKey">> {
  storeId: string;
  apiSecret: string;
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** Reviews older than this many years are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: YotpoClient;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && day(Date.parse(`${v}T00:00:00Z`)) === v;

export function parseYotpoCursor(raw: string | null): YotpoCursor | null {
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
    if (isDay(p?.since) && (p.step === 0 || p.step === 1) && Number.isSafeInteger(p.page) && (p.page as number) >= 1 && (p.pageInfo === null || typeof p.pageInfo === "string")) {
      return { pass: { since: p.since, step: p.step, page: p.page as number, pageInfo: p.pageInfo }, done: r.done, nextFrom: r.nextFrom };
    }
  }
  throw new Error("Yotpo checkpoint is not in the expected shape");
}

export function yotpoConnector(options: YotpoOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const client = options.client ?? yotpoClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");
  const steps = client.loyalty ? 2 : 1;

  /** Reads a pass to its end. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(pass: YotpoPass, done: boolean, doneAtEnd: boolean, nextFrom: string, receivedAt: string): AsyncIterable<SourceBatch> {
    let { page, pageInfo } = pass;
    let step: number = pass.step;
    const ctx = { customerKey, receivedAt };
    while (step < steps) {
      let events;
      if (step === 0) {
        const rows = await client.reviews(pass.since, page);
        events = rows.map((row) => yotpoReviewEvent(row, ctx).event);
        // A short page is the last; so is the last page Yotpo lets a pass ask for.
        if (rows.length === YOTPO_REVIEW_PAGE && page < YOTPO_MAX_PAGE) page++;
        else [step, page] = [1, 1];
      } else {
        const result = await client.loyaltyCustomers(pageInfo);
        events = result.rows.map((row) => yotpoLoyaltyEvent(row, ctx).event);
        if (result.next !== null) pageInfo = result.next;
        else [step, pageInfo] = [2, null];
      }
      const cursor: YotpoCursor = step < steps ? { pass: { since: pass.since, step: step as 0 | 1, page, pageInfo }, done, nextFrom } : { pass: null, done: doneAtEnd, nextFrom };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseYotpoCursor(context.cursor);
    if (saved?.done) return;
    if (saved?.pass) return yield* walk(saved.pass, false, true, saved.nextFrom, now().toISOString());
    const at = now();
    const from = new Date(at.getTime());
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    yield* walk({ since: day(from.getTime()), step: 0, page: 1, pageInfo: null }, false, true, day(at.getTime() - YOTPO_OVERLAP_DAYS * DAY_MS), at.toISOString());
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseYotpoCursor(context.cursor);
    const at = now();
    if (saved?.pass) return yield* walk(saved.pass, saved.done, saved.done, saved.nextFrom, at.toISOString());
    const since = saved?.nextFrom ?? day(at.getTime() - YOTPO_OVERLAP_DAYS * DAY_MS);
    yield* walk({ since, step: 0, page: 1, pageInfo: null }, saved?.done ?? false, saved?.done ?? false, day(at.getTime() - YOTPO_OVERLAP_DAYS * DAY_MS), at.toISOString());
  }

  return { source: "yotpo", historicalImport, incrementalSync, writes: YOTPO_WRITES };
}
