import { createHash } from "node:crypto";
import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { CalendlyApiError, calendlyClient, CALENDLY_UUID, type CalendlyClient, type CalendlyClientOptions, type CalendlyScope } from "./client.js";
import { appointmentEvent, calendlyId, calendlyTime, type CalendlyEvent } from "./normalize.js";

/**
 * Calendly: consultations, bridal appointments, repair drop-offs and the
 * like, as they are booked, cancelled or missed. Calendly's events can be
 * listed by start time but not by when they changed, so:
 *
 * - the historical import reads every event starting from the history
 *   window (two years by default) to a year ahead, earliest first, and
 *   records where it got to, so a resumed import carries on;
 * - each later sync reads events from 30 days back to a year ahead, the
 *   span where bookings get moved, cancelled and marked no-shows.
 *
 * An event's invitees are read again only when the event itself changed
 * since the last sync, or it started in the last 14 days, when a no-show
 * is marked; that keeps a free plan's 50 requests a minute enough. Each
 * invitee becomes one appointment event, and a booking read again is a
 * duplicate.
 *
 * It reads the whole organization's events when the token's owner can, and
 * otherwise only their own. It takes no webhooks: subscribing would need
 * the webhooks:write scope and a paid plan.
 */

/** Declared so they can be gated and audited; none runs while writes are off. */
export const CALENDLY_WRITES: WriteAction[] = [
  { integration: "calendly", name: "book_appointment", description: "Book an appointment in Calendly" },
  { integration: "calendly", name: "cancel_appointment", description: "Cancel an appointment in Calendly" },
  { integration: "calendly", name: "mark_no_show", description: "Mark a Calendly invitee as a no-show" },
];

const DAY = 86_400_000;
/** How far back each later sync looks: where bookings are still moved, cancelled or marked no-shows. */
export const CALENDLY_RECENT_DAYS = 30;
/** Events that started this recently have their invitees read again, for no-shows. */
export const CALENDLY_NO_SHOW_DAYS = 14;
const AHEAD_DAYS = 366;

/** Where a Calendly sync stands. Serialized as the runSync checkpoint. */
export interface CalendlyCursor {
  /** The start time the historical import has read up to, or null once it read everything. */
  through: string | null;
  /** Ids of the events starting exactly at `through` already read, so a resumed import doesn't read them again. */
  readAtThrough: string[];
  /** For events starting in the recent span: a hash of the event as last read, by event id. */
  recent: Record<string, string>;
}

export interface CalendlyOptions extends Partial<Pick<CalendlyClientOptions, "fetch" | "sleep" | "rateLimitRetries">> {
  token: string;
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** Appointments starting earlier than this many years ago are skipped. Defaults to 2. */
  historyYears?: number;
  /** Events per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: CalendlyClient;
}

const HASH = /^[0-9a-f]{12}$/;
const MAX_AT_THROUGH = 10_000;

export function parseCalendlyCursor(raw: string | null): CalendlyCursor | null {
  if (raw === null) return null;
  let c: CalendlyCursor | null;
  try {
    c = JSON.parse(raw) as CalendlyCursor | null;
  } catch {
    c = null;
  }
  const ok =
    typeof c === "object" &&
    c !== null &&
    (c.through === null || calendlyTime(c.through) !== null) &&
    Array.isArray(c.readAtThrough) &&
    c.readAtThrough.length <= MAX_AT_THROUGH &&
    c.readAtThrough.every((id) => typeof id === "string" && CALENDLY_UUID.test(id)) &&
    typeof c.recent === "object" &&
    c.recent !== null &&
    !Array.isArray(c.recent) &&
    Object.entries(c.recent).every(([id, h]) => CALENDLY_UUID.test(id) && typeof h === "string" && HASH.test(h));
  if (!ok || !c) throw new Error("Calendly checkpoint is not in the expected shape");
  return { through: c.through, readAtThrough: c.readAtThrough, recent: c.recent };
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

const iso = (ms: number) => new Date(ms).toISOString();
const eventHash = (event: unknown) => createHash("sha256").update(JSON.stringify(event)).digest("hex").slice(0, 12);

export function calendlyConnector(options: CalendlyOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const client = options.client ?? calendlyClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = positive(options.historyYears ?? 2, "historyYears");
  const batchSize = positive(options.batchSize ?? 200, "batchSize");

  /**
   * Every event starting in the window, earliest first: the organization's
   * when the token's owner is an owner or admin, otherwise their own.
   */
  async function* events(minStart: string, maxStart: string): AsyncIterable<Record<string, unknown>> {
    const me = await client.me();
    let owner: CalendlyScope = { organization: me.organizationUri };
    let token: string | null = null;
    for (;;) {
      let page;
      try {
        page = await client.scheduledEvents(owner, { minStart, maxStart }, token);
      } catch (error) {
        if (error instanceof CalendlyApiError && error.status === 403 && "organization" in owner && token === null) {
          owner = { user: me.userUri };
          continue;
        }
        throw error;
      }
      for (const e of page.collection) yield (typeof e === "object" && e !== null && !Array.isArray(e) ? e : {}) as Record<string, unknown>;
      if (!page.nextPageToken) return;
      token = page.nextPageToken;
    }
  }

  async function invitees(eventId: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let token: string | null = null;
    do {
      const page = await client.invitees(eventId, token);
      out.push(...page.collection);
      token = page.nextPageToken;
    } while (token);
    return out;
  }

  function sync(mode: "historical" | "incremental") {
    return async function* (context: SyncContext): AsyncIterable<SourceBatch> {
      const saved = parseCalendlyCursor(context.cursor);
      const at = now().getTime();
      const receivedAt = iso(at);
      const recentFrom = iso(at - CALENDLY_RECENT_DAYS * DAY);
      const noShowFrom = iso(at - CALENDLY_NO_SHOW_DAYS * DAY);
      const historyStart = new Date(at);
      historyStart.setUTCFullYear(historyStart.getUTCFullYear() - historyYears);
      const historyFrom = historyStart.toISOString();
      const maxStart = iso(at + AHEAD_DAYS * DAY);

      // A historical import resumes just before where it got to and skips the events at that start time it already read.
      let through = mode === "historical" ? (saved?.through ?? null) : null;
      let readAtThrough = through ? (saved?.readAtThrough ?? []) : [];
      const skip = new Set(readAtThrough);
      const resumedAt = through;
      const minStart = mode === "incremental" ? recentFrom : through && through > historyFrom ? iso(Date.parse(through) - 1) : historyFrom;
      const known = saved?.recent ?? {};
      const seen: Record<string, string> = {};
      // Part way through, the checkpoint keeps what it knew as well, so a resumed sync doesn't read those invitees again; at the end it keeps only what this sync saw.
      const cursor = (done: boolean) =>
        JSON.stringify({ through: done ? null : through, readAtThrough: done ? [] : readAtThrough, recent: done ? seen : { ...known, ...seen } } satisfies CalendlyCursor);

      let batch: CalendlyEvent[] = [];
      for await (const ev of events(minStart, maxStart)) {
        const id = calendlyId(ev.uri);
        const start = calendlyTime(ev.start_time);
        if (id && start && start === resumedAt && skip.has(id)) continue;
        const hash = eventHash(ev);
        const missable = start !== null && start >= noShowFrom && start <= receivedAt;
        if (!id || known[id] !== hash || missable) {
          const list = id ? await invitees(id) : [];
          // An event with no invitee that reads is still read once, so what is wrong with it is dead-lettered.
          for (const raw of list.length ? list : [null]) batch.push(appointmentEvent(ev, raw, customerKey, receivedAt).event);
        }
        if (id && start && start >= recentFrom) seen[id] = hash;
        if (start && mode === "historical") {
          if (start !== through) readAtThrough = [];
          through = start;
          if (id && readAtThrough.length < MAX_AT_THROUGH) readAtThrough.push(id);
        }
        if (batch.length >= batchSize) {
          yield { events: batch, cursor: cursor(false) };
          batch = [];
        }
      }
      yield { events: batch, cursor: cursor(true) };
    };
  }

  return {
    source: "calendly",
    historicalImport: sync("historical"),
    incrementalSync: sync("incremental"),
    writes: CALENDLY_WRITES,
  };
}
