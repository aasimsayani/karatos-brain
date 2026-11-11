import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { ACUITY_MAX, acuityClient, isAcuityDay, type AcuityClient, type AcuityClientOptions } from "./client.js";
import { acuityAppointmentEvent, acuityFullDayEvent, acuityNames, type AcuityEvent, type AcuityLookups } from "./normalize.js";

/**
 * Acuity Scheduling: consultations, bridal appointments, repair drop-offs
 * and the like, as they are booked, cancelled or missed, for clienteling,
 * custom orders and repairs.
 *
 * Acuity's appointment list has no paging: no offset, page or cursor, only
 * `max` and a minDate/maxDate window. So the connector walks the calendar in
 * windows of at most a month, oldest first, asking for at most 100 (the
 * documented default of `max`) scheduled appointments and then 100 canceled
 * ones, two separate lists. A window that comes back with 100 of either
 * may have more, so it is split in half and each half read again, down to
 * a single day. A single day that still fills a request is read as far as
 * it goes, and a marker saying that day was cut short is dead-lettered, so
 * nothing goes missing silently.
 *
 * - The historical import reads from two years ago (the catalog's history
 *   window) to 90 days ahead, and stops for good once done.
 * - Each later sync reads from 60 days back to 90 days ahead, since
 *   appointments are moved, paid, cancelled and marked no-shows after they
 *   are made, and booked well ahead. What didn't change comes back as
 *   duplicates. A change to an appointment older than that isn't seen.
 *
 * Calendars and appointment types are read once a pass, only for their
 * names. Each window is one batch, and the checkpoint holds the windows
 * still to read, the next one first, so a sync that stops resumes at the
 * window it was on.
 */

/** Declared so it can be gated and audited; it never runs while writes are off, and the client has no way to send it. */
export const ACUITY_WRITES: WriteAction[] = [{ integration: "acuity", name: "cancel_appointment", description: "Cancel an Acuity Scheduling appointment", kind: "update", approval: "each", dailyCap: 5 }];

/** Later syncs read appointments starting this many days back again, since they change after they are made. */
export const ACUITY_REVISIT_DAYS = 60;
/** Every pass reads this many days ahead, since appointments are booked ahead. */
export const ACUITY_AHEAD_DAYS = 90;
/** The most windows a checkpoint holds: halving a month never needs more than a handful. */
const MAX_PENDING = 32;
const DAY_MS = 86_400_000;

/** Days from the first to the last, both included, written YYYY-MM-DD. */
export type AcuityWindow = [from: string, to: string];

/** Serialized as the runSync checkpoint. */
export interface AcuityCursor {
  /** The pass finished: the historical import never runs again, and the next sync starts a fresh pass. */
  done: boolean;
  /** The windows still to read, the next one first, while the pass isn't done. */
  pending: AcuityWindow[];
  /** The last day the pass reads, while it isn't done. */
  end: string | null;
}

export interface AcuityOptions extends AcuityClientOptions {
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** Appointments starting earlier than this many years ago are skipped by the historical import. Defaults to 2. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: AcuityClient;
}

const MESSAGE = "Acuity checkpoint is not in the expected shape";
const FINISHED: AcuityCursor = { done: true, pending: [], end: null };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => day(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS);
const monthEnd = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  return day(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0));
};
/** The window from a day to the end of its month, or to the pass's last day if that comes first. */
const monthWindow = (from: string, end: string): AcuityWindow => {
  const last = monthEnd(from);
  return [from, last < end ? last : end];
};
/** A window of two days or more in two halves, the earlier one first. */
export function splitAcuityWindow([from, to]: AcuityWindow): [AcuityWindow, AcuityWindow] {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  const mid = addDays(from, Math.floor(days / 2) - 1);
  return [
    [from, mid],
    [addDays(mid, 1), to],
  ];
}

export function parseAcuityCursor(raw: string | null): AcuityCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new Error(MESSAGE);
  }
  if (typeof c !== "object" || c === null || Array.isArray(c)) throw new Error(MESSAGE);
  const r = c as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "done,end,pending" || !Array.isArray(r.pending)) throw new Error(MESSAGE);
  const pending = r.pending as unknown[];
  if (r.done === true && pending.length === 0 && r.end === null) return { ...FINISHED, pending: [] };
  if (r.done !== false || !isAcuityDay(r.end) || pending.length === 0 || pending.length > MAX_PENDING) throw new Error(MESSAGE);
  const end = r.end;
  let next: string | null = null;
  for (const w of pending) {
    // Each window lies in one month, its first day no later than its last, and starts the day after the one before it ends.
    if (!Array.isArray(w) || w.length !== 2 || !isAcuityDay(w[0]) || !isAcuityDay(w[1])) throw new Error(MESSAGE);
    const [from, to] = w as AcuityWindow;
    if (to < from || to > monthEnd(from) || to > end || (next !== null && from !== next)) throw new Error(MESSAGE);
    next = addDays(to, 1);
  }
  return { done: false, pending: pending as AcuityWindow[], end };
}

export function acuityConnector(options: AcuityOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const client = options.client ?? acuityClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 2;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** A fresh pass from `from` to `end`. */
  const start = (from: string, end: string): AcuityCursor => ({ done: false, pending: [monthWindow(from, end)], end });

  async function* pass(state: AcuityCursor): AsyncIterable<SourceBatch> {
    if (state.done || state.end === null) return;
    const end = state.end;
    const lookups: AcuityLookups = { types: acuityNames(await client.appointmentTypes()), calendars: acuityNames(await client.calendars()) };
    let pending = state.pending;
    while (pending.length > 0) {
      const window = pending[0]!;
      const [from, to] = window;
      const lists: { rows: unknown[]; canceled: boolean }[] = [];
      for (const canceled of [false, true]) {
        const rows = await client.appointments({ minDate: from, maxDate: to, canceled });
        // A full answer may have left some out: read the window again in halves, unless it is one day.
        if (rows.length >= ACUITY_MAX && from < to) break;
        lists.push({ rows, canceled });
      }
      if (lists.length < 2) {
        pending = [...splitAcuityWindow(window), ...pending.slice(1)];
        continue;
      }
      const receivedAt = now().toISOString();
      const events: AcuityEvent[] = [];
      for (const { rows, canceled } of lists) {
        for (const row of rows) events.push(acuityAppointmentEvent(row, canceled, lookups, customerKey, receivedAt).event);
        if (rows.length >= ACUITY_MAX) events.push(acuityFullDayEvent(from, canceled, receivedAt));
      }
      pending = pending.slice(1);
      if (pending.length === 0 && to < end) pending = [monthWindow(addDays(to, 1), end)];
      yield { events, cursor: JSON.stringify(pending.length > 0 ? ({ done: false, pending, end } satisfies AcuityCursor) : FINISHED) };
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseAcuityCursor(context.cursor);
    const at = now();
    const from = new Date(at.getTime());
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    // A finished import has no window left to read, so it yields nothing.
    yield* pass(saved ?? start(day(from.getTime()), day(at.getTime() + ACUITY_AHEAD_DAYS * DAY_MS)));
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseAcuityCursor(context.cursor);
    const at = now().getTime();
    yield* pass(saved && !saved.done ? saved : start(day(at - ACUITY_REVISIT_DAYS * DAY_MS), day(at + ACUITY_AHEAD_DAYS * DAY_MS)));
  }

  return { source: "acuity", historicalImport, incrementalSync, writes: ACUITY_WRITES };
}
