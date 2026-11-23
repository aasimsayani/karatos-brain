import type { StoredEvent, VerifyPeriod, VerifySource, VerifySourceRecord, VerifySubject } from "@karatos/core";
import { dayBounds } from "./brief.js";

/**
 * Sync verification, the pure part: reading what the instance has synced for
 * a period the way the daily brief counts it, and comparing that with what
 * the source system itself reports. The server reads the events and asks the
 * connector; these functions only count and compare. See docs/verify-sync.md.
 *
 * The rules:
 * - Counts must agree exactly, and so must the records behind them: a period
 *   where one sale is missing and another is extra has equal counts but is a
 *   mismatch.
 * - Money is compared in whole cents. It matches when every record is on
 *   both sides, no record's amount differs by more than the tolerance, and
 *   the totals differ by no more than the tolerance. The tolerance is 0
 *   cents unless the operator sets one.
 * - Periods are whole store days in the store's time zone, from local
 *   midnight to local midnight, so a day is 23 or 25 hours when the clocks
 *   change, as in the brief.
 * - Sales are gross, before refunds, on the day they were sold, as the
 *   brief's gross is. A refunded or partly refunded sale still counts on its
 *   day; its refund is the brief's separate refund figure. A cancelled order
 *   that was never paid was never a sale and counts on neither side.
 */

/** Ids listed for each kind of difference; the counts are always whole. */
export const VERIFY_SAMPLE_IDS = 20;

/** The longest period one verification covers, in store days. */
export const VERIFY_MAX_DAYS = 92;

/** The most synced events one verification reads for a subject; past it the subject is unavailable, never guessed. */
export const VERIFY_MAX_SYNCED_EVENTS = 200_000;

/** The event types each subject's synced side is read from. */
export const VERIFY_EVENT_TYPES: Readonly<Record<VerifySubject, readonly string[]>> = {
  sales: ["sale.completed"],
  charges: ["payment.charge_updated"],
  profiles: ["customer.profile_updated"],
};

export type VerifyMetricName = "sale_count" | "gross_sales" | "charge_count" | "charge_gross" | "profile_count";

/** The metrics each subject is compared on: a count, and its money when it has some. */
export const VERIFY_METRICS: Readonly<Record<VerifySubject, readonly { metric: VerifyMetricName; unit: "count" | "cents" }[]>> = {
  sales: [
    { metric: "sale_count", unit: "count" },
    { metric: "gross_sales", unit: "cents" },
  ],
  charges: [
    { metric: "charge_count", unit: "count" },
    { metric: "charge_gross", unit: "cents" },
  ],
  profiles: [{ metric: "profile_count", unit: "count" }],
};

export type VerifyStatus = "match" | "mismatch" | "unavailable";

/** A verification period: the store days it covers and the instants they run between. */
export interface VerifyPeriodReport extends VerifyPeriod {
  /** First store day, YYYY-MM-DD. */
  startDay: string;
  /** Last store day, included. */
  endDay: string;
  timeZone: string;
}

/** Records on one side only, or on both with different amounts: how many, and some of their ids. */
export interface VerifyDifference {
  count: number;
  /** At most VERIFY_SAMPLE_IDS record ids, sorted. Ids only: sale, charge or keyed profile references. */
  sample: string[];
}

export interface VerifyMetric {
  metric: VerifyMetricName;
  unit: "count" | "cents";
  status: VerifyStatus;
  /** What the source system reports. Null when unavailable. */
  sourceTotal: number | null;
  /** What the instance has synced. Null when unavailable. */
  syncedTotal: number | null;
  /** Synced less source. Null when unavailable. */
  difference: number | null;
  /** For money: the largest difference that still matches, in cents. */
  toleranceCents?: number;
  /** In the source system, not synced. */
  missing: VerifyDifference;
  /** Synced, not in the source system (or synced twice). */
  extra: VerifyDifference;
  /** For money: on both sides with amounts that differ. */
  amountDiffers?: VerifyDifference;
  /** Why it is unavailable. */
  reason?: string;
}

export interface VerifySystemReport {
  system: string;
  /** Unavailable when any metric is, else mismatch when any metric is, else match. */
  status: VerifyStatus;
  period: VerifyPeriodReport;
  metrics: VerifyMetric[];
  /** How each side was counted. */
  basis?: { source: string; synced: string };
  /** Synced events in the period that couldn't be read, such as ones whose payload retention has cleared. The synced side is then a floor. */
  uncountedEvents?: number;
  /** Why the system couldn't be verified, when it couldn't. */
  reason?: string;
}

/** Whole store days from startDay through endDay as the instants they cover. */
export function verifyPeriod(startDay: string, endDay: string, timeZone: string): VerifyPeriodReport {
  return { startDay, endDay, timeZone, from: dayBounds(startDay, timeZone).from, to: dayBounds(endDay, timeZone).to };
}

// ---------------------------------------------------------------------------
// The synced side

export interface SyncedRecords {
  records: VerifySourceRecord[];
  /** Events of the subject that couldn't be read. */
  uncounted: number;
  basis: string;
}

const intCents = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const inPeriod = (at: unknown, period: VerifyPeriod) => {
  const t = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return !Number.isNaN(t) && t >= Date.parse(period.from) && t < Date.parse(period.to);
};

/**
 * What the instance has synced for a subject from one system. `events` are
 * the subject's event types read from the store (VERIFY_EVENT_TYPES), any
 * system; for sales and charges, those that occurred in the period, for
 * profiles those that occurred from the period's start on.
 */
export function syncedRecords(subject: VerifySubject, system: string, events: readonly StoredEvent[], period: VerifyPeriod): SyncedRecords {
  const types = VERIFY_EVENT_TYPES[subject];
  const mine = events.filter((e) => e.source === system && types.includes(e.type));
  let uncounted = 0;

  if (subject === "sales") {
    // Each sale event counts once, as the brief counts it.
    const records: VerifySourceRecord[] = [];
    for (const e of mine) {
      const ref = text(e.payload.saleId);
      const cents = intCents(e.payload.totalCents);
      if (e.payloadClearedAt !== null || ref === null || cents === null) uncounted++;
      else if (inPeriod(e.occurredAt, period)) records.push({ ref, cents });
    }
    return { records, uncounted, basis: "sale.completed events from this system dated in the period, at their totalCents, as the daily brief counts gross sales" };
  }

  if (subject === "charges") {
    // A charge is stored once per state; its latest received state is the one compared.
    const latest = new Map<string, { at: number; status: unknown; cents: unknown }>();
    for (const e of mine) {
      const ref = e.payloadClearedAt === null ? text(e.payload.chargeId) : null;
      if (ref === null) {
        uncounted++;
        continue;
      }
      if (!inPeriod(e.occurredAt, period)) continue;
      const at = Date.parse(e.receivedAt);
      const seen = latest.get(ref);
      if (!seen || at >= seen.at) latest.set(ref, { at, status: e.payload.status, cents: e.payload.capturedCents });
    }
    const records = [...latest.entries()].flatMap(([ref, s]) =>
      s.status === "succeeded" && typeof s.cents === "number" && Number.isSafeInteger(s.cents) && s.cents > 0 ? [{ ref, cents: s.cents }] : [],
    );
    return { records, uncounted, basis: "each charge's latest synced state, counted when it succeeded with an amount captured, dated by when it was made" };
  }

  // Profiles: each one once, by the day it was created.
  const seen = new Set<string>();
  const records: VerifySourceRecord[] = [];
  for (const e of mine) {
    const ref = e.payloadClearedAt === null ? text(e.payload.profileRef) : null;
    if (ref === null) {
      uncounted++;
      continue;
    }
    if (seen.has(ref) || !inPeriod(e.payload.createdAt, period)) continue;
    seen.add(ref);
    records.push({ ref });
  }
  return { records, uncounted, basis: "profiles synced from this system whose creation time falls in the period, each counted once" };
}

// ---------------------------------------------------------------------------
// Comparing

const sample = (refs: string[]): VerifyDifference => ({ count: refs.length, sample: [...refs].sort().slice(0, VERIFY_SAMPLE_IDS) });

function tally(records: readonly VerifySourceRecord[]): Map<string, { n: number; cents: number }> {
  const out = new Map<string, { n: number; cents: number }>();
  for (const r of records) {
    const t = out.get(r.ref) ?? { n: 0, cents: 0 };
    t.n++;
    t.cents += r.cents ?? 0;
    out.set(r.ref, t);
  }
  return out;
}

const sumCents = (records: readonly VerifySourceRecord[]) => records.reduce((s, r) => s + (r.cents ?? 0), 0);

export interface CompareInput {
  subject: VerifySubject;
  source: readonly VerifySourceRecord[];
  synced: readonly VerifySourceRecord[];
  /** The largest difference in cents that still matches. 0 unless set. */
  toleranceCents?: number;
}

/** Compares the two sides of one subject, metric by metric. */
export function compareRecords(input: CompareInput): VerifyMetric[] {
  const tolerance = input.toleranceCents ?? 0;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) throw new RangeError("the tolerance must be a whole number of cents, zero or more");
  const source = tally(input.source);
  const synced = tally(input.synced);
  const missing: string[] = [];
  const extra: string[] = [];
  const differs: string[] = [];
  for (const [ref, s] of source) {
    const y = synced.get(ref);
    for (let i = y?.n ?? 0; i < s.n; i++) missing.push(ref);
    if (y && Math.abs(y.cents - s.cents) > tolerance) differs.push(ref);
  }
  for (const [ref, y] of synced) {
    for (let i = source.get(ref)?.n ?? 0; i < y.n; i++) extra.push(ref);
  }
  const sides = missing.length === 0 && extra.length === 0;

  return VERIFY_METRICS[input.subject].map(({ metric, unit }) => {
    if (unit === "count") {
      const sourceTotal = input.source.length;
      const syncedTotal = input.synced.length;
      return { metric, unit, status: sides ? "match" : "mismatch", sourceTotal, syncedTotal, difference: syncedTotal - sourceTotal, missing: sample(missing), extra: sample(extra) };
    }
    const sourceTotal = sumCents(input.source);
    const syncedTotal = sumCents(input.synced);
    const difference = syncedTotal - sourceTotal;
    const match = sides && differs.length === 0 && Math.abs(difference) <= tolerance;
    return { metric, unit, status: match ? "match" : "mismatch", sourceTotal, syncedTotal, difference, toleranceCents: tolerance, missing: sample(missing), extra: sample(extra), amountDiffers: sample(differs) };
  });
}

const none = (): VerifyDifference => ({ count: 0, sample: [] });

/** The metrics of a subject that couldn't be verified, each saying why. */
export function unavailableMetrics(subjects: readonly VerifySubject[], reason: string): VerifyMetric[] {
  return subjects.flatMap((subject) =>
    VERIFY_METRICS[subject].map(({ metric, unit }) => ({ metric, unit, status: "unavailable" as const, sourceTotal: null, syncedTotal: null, difference: null, missing: none(), extra: none(), reason })),
  );
}

/** A system's status from its metrics: unavailable over mismatch over match. */
export function systemStatus(metrics: readonly VerifyMetric[]): VerifyStatus {
  if (metrics.length === 0 || metrics.some((m) => m.status === "unavailable")) return "unavailable";
  return metrics.some((m) => m.status === "mismatch") ? "mismatch" : "match";
}

/** The source side of one subject from what a connector's verify returned, or undefined when it didn't report it. */
export const sourceFor = (sources: readonly VerifySource[], subject: VerifySubject) => sources.find((s) => s.subject === subject);
