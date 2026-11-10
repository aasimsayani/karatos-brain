import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { zoomClient, type ZoomClient, type ZoomClientOptions } from "./client.js";
import { zoomMeetingEvent } from "./normalize.js";

/**
 * Zoom: the store's virtual consultations, who met, when and for how long,
 * so clienteling, custom orders and sales see video appointments beside the
 * ones booked in person.
 *
 * Zoom's meeting history lists the account's past meetings that started on
 * a span of days, at most a month at a time, and its participant report
 * lists who joined one. So a pass reads the history span by span and, for
 * each meeting, its participants:
 *
 * - The historical import covers six months by default, the longest Zoom
 *   keeps meeting reports for.
 * - Each later sync covers from two days before the last pass, by day:
 *   Zoom lists a meeting once it has ended, and its day is the account's
 *   own time zone, so the overlap catches both. A meeting read again
 *   unchanged is a duplicate.
 *
 * Each page of the history is one batch. Zoom's page tokens lapse after 15
 * minutes, so a checkpoint keeps the span, not the token, and a resumed pass
 * reads its span again from the first page; what was already read is a
 * duplicate. Zoom can send webhooks, but the connector polls so it needs no
 * public route.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const ZOOM_WRITES: WriteAction[] = [{ integration: "zoom", name: "schedule_meeting", description: "Schedule a Zoom meeting for a consultation" }];

const DAY_MS = 86_400_000;
/** Days in one history request: Zoom takes at most a month. */
export const ZOOM_SPAN_DAYS = 30;
/** Each later pass starts this many days before the last one did. */
export const ZOOM_OVERLAP_DAYS = 2;

/** Where a Zoom pass stands: its days, and the first day of the span it is reading. */
export interface ZoomPass {
  from: string;
  until: string;
  spanFrom: string;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `nextFrom` is the day the next later sync starts. */
export interface ZoomCursor {
  pass: ZoomPass | null;
  /** The historical import finished. */
  done: boolean;
  nextFrom: string;
}

export interface ZoomOptions extends Partial<Pick<ZoomClientOptions, "fetch" | "sleep" | "clock" | "retries">> {
  accountId: string;
  clientId: string;
  clientSecret: string;
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** Meetings older than this many months are skipped. Defaults to 6. */
  historyMonths?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: ZoomClient;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && day(Date.parse(`${v}T00:00:00Z`)) === v;
const addDays = (d: string, n: number) => day(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS);

export function parseZoomCursor(raw: string | null): ZoomCursor | null {
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
    const p = typeof r.pass === "object" && !Array.isArray(r.pass) ? (r.pass as Record<string, unknown>) : null;
    if (p && isDay(p.from) && isDay(p.until) && isDay(p.spanFrom)) return { pass: { from: p.from, until: p.until, spanFrom: p.spanFrom }, done: r.done, nextFrom: r.nextFrom };
  }
  throw new Error("Zoom checkpoint is not in the expected shape");
}

export function zoomConnector(options: ZoomOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const client = options.client ?? zoomClient(options);
  const now = options.now ?? (() => new Date());
  const historyMonths = options.historyMonths ?? 6;
  if (!Number.isInteger(historyMonths) || historyMonths < 1) throw new Error("historyMonths must be a positive whole number");

  /** Every page of a meeting's participant report, or null when Zoom has none. */
  async function participants(uuid: unknown): Promise<unknown[] | null> {
    if (typeof uuid !== "string") return null;
    const rows: unknown[] = [];
    let next: string | null = null;
    do {
      const page = await client.participants(uuid, next);
      if (page === null) return null;
      rows.push(...page.rows);
      next = page.next;
    } while (next !== null);
    return rows;
  }

  /** Reads a pass to its end. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(pass: ZoomPass, done: boolean, doneAtEnd: boolean, nextFrom: string, receivedAt: string): AsyncIterable<SourceBatch> {
    let spanFrom = pass.spanFrom;
    while (spanFrom <= pass.until) {
      const spanTo = [addDays(spanFrom, ZOOM_SPAN_DAYS - 1), pass.until].sort()[0]!;
      let next: string | null = null;
      do {
        const page = await client.meetings({ from: spanFrom, to: spanTo, next });
        const events = [];
        for (const row of page.rows) {
          const uuid = typeof row === "object" && row !== null ? (row as Record<string, unknown>).meeting_uuid : undefined;
          events.push(zoomMeetingEvent(row, await participants(uuid), { customerKey, receivedAt }).event);
        }
        next = page.next;
        const after = next === null ? addDays(spanTo, 1) : spanFrom;
        const cursor: ZoomCursor = after <= pass.until ? { pass: { ...pass, spanFrom: after }, done, nextFrom } : { pass: null, done: doneAtEnd, nextFrom };
        yield { events, cursor: JSON.stringify(cursor) };
      } while (next !== null);
      spanFrom = addDays(spanTo, 1);
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseZoomCursor(context.cursor);
    if (saved?.done) return;
    if (saved?.pass) return yield* walk(saved.pass, false, true, saved.nextFrom, now().toISOString());
    const at = now();
    const from = new Date(at.getTime());
    from.setUTCMonth(from.getUTCMonth() - historyMonths);
    const until = day(at.getTime());
    yield* walk({ from: day(from.getTime()), until, spanFrom: day(from.getTime()) }, false, true, addDays(until, -ZOOM_OVERLAP_DAYS), at.toISOString());
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseZoomCursor(context.cursor);
    const at = now();
    if (saved?.pass) return yield* walk(saved.pass, saved.done, saved.done, saved.nextFrom, at.toISOString());
    const until = day(at.getTime());
    const from = saved?.nextFrom ?? addDays(until, -ZOOM_OVERLAP_DAYS);
    yield* walk({ from, until, spanFrom: from }, saved?.done ?? false, saved?.done ?? false, addDays(until, -ZOOM_OVERLAP_DAYS), at.toISOString());
  }

  return { source: "zoom", historicalImport, incrementalSync, writes: ZOOM_WRITES };
}
