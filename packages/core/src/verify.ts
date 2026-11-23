/**
 * Sync verification: what a connector reports about a period straight from
 * the source system, so the server can set it beside what the instance has
 * synced. A connector that can verify reads its system with the same
 * read-only calls and scopes it syncs with, never a write, and hands back
 * record references and amounts only: no names, addresses, emails, phone
 * numbers or raw payloads. See docs/verify-sync.md.
 */

/** A period as the instants [from, to) it covers, ISO 8601 in UTC. */
export interface VerifyPeriod {
  from: string;
  to: string;
}

/**
 * What a set of records counts, which names how the synced side is read:
 * - sales: paid sales by the day they were sold, as `sale.completed` events carry them
 * - charges: captured payments by the day they were made, as `payment.charge_updated` events carry them
 * - profiles: marketing profiles by the day they were created, as `customer.profile_updated` events carry them
 */
export const VERIFY_SUBJECTS = ["sales", "charges", "profiles"] as const;
export type VerifySubject = (typeof VERIFY_SUBJECTS)[number];

/** One record the source system reports in the period. */
export interface VerifySourceRecord {
  /** The same reference the synced events carry: a saleId, chargeId or profileRef. */
  ref: string;
  /** Whole cents, for subjects that carry money. */
  cents?: number;
}

/** What the source system reports for one subject in the period. */
export interface VerifySource {
  subject: VerifySubject;
  /** Every record in the period, by reference. */
  records: VerifySourceRecord[];
  /** One sentence on what the source side counts, for the report. */
  basis: string;
}

/** The most records one verification reads from a source system before it stops and says so. */
export const VERIFY_MAX_SOURCE_RECORDS = 50_000;

/** A verification stopped before it could read the whole period, such as one with too many records. */
export class VerifyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyLimitError";
  }
}

/** Throws once a source has handed back more records than one verification reads. */
export function checkVerifyLimit(records: readonly unknown[], system: string): void {
  if (records.length > VERIFY_MAX_SOURCE_RECORDS) {
    throw new VerifyLimitError(`${system} has more than ${VERIFY_MAX_SOURCE_RECORDS} records in the period; verify a shorter period`);
  }
}

/** True when an ISO instant falls in [from, to). */
export function inVerifyPeriod(at: string | null | undefined, period: VerifyPeriod): boolean {
  if (typeof at !== "string") return false;
  const t = Date.parse(at);
  return !Number.isNaN(t) && t >= Date.parse(period.from) && t < Date.parse(period.to);
}
