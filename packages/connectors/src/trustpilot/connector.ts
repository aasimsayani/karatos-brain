import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { quoTime } from "../openphone/normalize.js";
import { TRUSTPILOT_BUSINESS_UNIT, TRUSTPILOT_MAX_PAGE, TRUSTPILOT_PAGE_SIZE, trustpilotClient, type TrustpilotClient, type TrustpilotClientOptions } from "./client.js";
import { trustpilotReviewEvent, trustpilotScoreEvent } from "./normalize.js";

/**
 * Trustpilot: the store's public service reviews and its trust score, with
 * low ratings marked for follow-up and reviews the store hasn't answered
 * marked as waiting on a reply, so every bad review gets an owner.
 *
 * Trustpilot lists a store's reviews newest first a page at a time by
 * number, with no filter by date. So each pass reads from the newest and
 * stops at the first page that reaches back past its start:
 *
 * - The historical import reads five years by default.
 * - Each later sync reads the reviews posted in the last 30 days again, so
 *   a reply or an edit in that time is a new event and the rest are
 *   duplicates.
 *
 * Each pass reads the trust score first, with the first page. Each page is
 * one batch and one checkpoint, which keeps the pass's start and the next
 * page, so a resumed pass goes on from that page.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const TRUSTPILOT_WRITES: WriteAction[] = [
  { integration: "trustpilot", name: "reply_to_review", description: "Post the store's public reply to a Trustpilot review", kind: "append", approval: "each", dailyCap: 20 },
  { integration: "trustpilot", name: "send_review_invitation", description: "Invite a customer to review the store on Trustpilot", kind: "append", approval: "each", dailyCap: 50 },
];

const DAY_MS = 86_400_000;
/** Each later sync reads the reviews posted in this many days again. */
export const TRUSTPILOT_RECHECK_DAYS = 30;

/** Where a pass stands: the oldest time it reads back to, and the next page. */
export interface TrustpilotPass {
  since: string;
  /** The next page, from 1. */
  page: number;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes. */
export interface TrustpilotCursor {
  pass: TrustpilotPass | null;
  /** The historical import finished. */
  done: boolean;
}

export interface TrustpilotOptions extends Partial<Pick<TrustpilotClientOptions, "fetch" | "sleep" | "retries">> {
  apiKey: string;
  businessUnitId: string;
  /** Reviews older than this many years are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: TrustpilotClient;
}

const isTime = (v: unknown): v is string => typeof v === "string" && quoTime(v) === v;

export function parseTrustpilotCursor(raw: string | null): TrustpilotCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    // Not JSON: fails the checks below.
  }
  const r = (c ?? {}) as Record<string, unknown>;
  if (typeof r.done === "boolean") {
    if (r.pass === null) return { pass: null, done: r.done };
    // Anything but an object fails the checks below: a string or number has no such fields.
    const p = (r.pass ?? {}) as Record<string, unknown>;
    if (isTime(p.since) && Number.isSafeInteger(p.page) && (p.page as number) >= 1 && (p.page as number) <= TRUSTPILOT_MAX_PAGE) return { pass: { since: p.since, page: p.page as number }, done: r.done };
  }
  throw new Error("Trustpilot checkpoint is not in the expected shape");
}

export function trustpilotConnector(options: TrustpilotOptions): Connector {
  const client = options.client ?? trustpilotClient(options);
  const businessUnitId = options.businessUnitId.trim().toLowerCase();
  if (!TRUSTPILOT_BUSINESS_UNIT.test(businessUnitId)) throw new Error("TRUSTPILOT_BUSINESS_UNIT_ID is missing or not a business unit id");
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads a pass to its end. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(pass: TrustpilotPass, done: boolean, doneAtEnd: boolean): AsyncIterable<SourceBatch> {
    for (let page = pass.page; ; page++) {
      const ctx = { businessUnitId, receivedAt: now().toISOString() };
      const score = page === 1 ? [trustpilotScoreEvent(await client.businessUnit(), ctx).event] : [];
      const rows = await client.reviews(page);
      const reads = rows.map((row) => trustpilotReviewEvent(row, ctx));
      // Kept when posted since the pass's start; one that doesn't read is kept to be dead-lettered.
      const events = [...score, ...reads.filter(({ ok, event }) => !ok || String(event.payload.publishedAt) >= pass.since).map(({ event }) => event)];
      // Newest first, so a page that reaches back past the start is the last; so is a short page, and the last page a pass may ask for.
      const oldest = quoTime((rows.at(-1) as { createdAt?: unknown } | undefined)?.createdAt);
      const last = rows.length < TRUSTPILOT_PAGE_SIZE || page === TRUSTPILOT_MAX_PAGE || (oldest !== null && oldest < pass.since);
      const cursor: TrustpilotCursor = last ? { pass: null, done: doneAtEnd } : { pass: { since: pass.since, page: page + 1 }, done };
      yield { events, cursor: JSON.stringify(cursor) };
      if (last) return;
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseTrustpilotCursor(context.cursor);
    if (saved?.done) return;
    if (saved?.pass) return yield* walk(saved.pass, false, true);
    const from = now();
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    yield* walk({ since: from.toISOString(), page: 1 }, false, true);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseTrustpilotCursor(context.cursor);
    const done = saved?.done ?? false;
    yield* walk(saved?.pass ?? { since: new Date(now().getTime() - TRUSTPILOT_RECHECK_DAYS * DAY_MS).toISOString(), page: 1 }, done, done);
  }

  return { source: "trustpilot", historicalImport, incrementalSync, writes: TRUSTPILOT_WRITES };
}
