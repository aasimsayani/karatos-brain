import { createHash } from "node:crypto";
import { formCustomerRefs } from "../custom_forms/customer.js";

/**
 * Turns the rows of Sola's transaction report into Brain A events, in the
 * neutral types the Stripe and Authorize.net connectors emit:
 * payment.charge_updated for sales, captures and authorizations, and
 * payment.refund_updated for refunds and credits.
 *
 * Only what the departments use is kept. A card is kept as its brand only:
 * no masked card number, token, name, address, invoice or description. The
 * customer's email address and phone number only make the keyed customer
 * references Shopify, Klaviyo and forms make, so a payment links to the
 * same person's orders and layaway.
 *
 * Sola writes its report times as wall-clock times (3/3/2022 7:36:34 AM)
 * without a zone; they are read in the account's time zone. Each event is
 * keyed by the transaction and a digest of what was kept, so a row read
 * again unchanged is a duplicate and a void is a new event. A row without
 * a reference number, a time or an amount that reads is dead-lettered
 * listing what was wrong.
 */

export interface SolaEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const SOLA_CHARGE_EVENT = "payment.charge_updated";
export const SOLA_REFUND_EVENT = "payment.refund_updated";

/** Commands that move money, by what they are. Saves, balance checks and gift cards aren't payments here. */
const CHARGES = new Set(["cc:sale", "cc:capture", "cc:postauth", "cc:authonly", "check:sale"]);
const REFUNDS = new Set(["cc:refund", "cc:credit", "check:refund", "check:credit"]);
const BRANDS: Record<string, string> = { visa: "visa", mastercard: "mastercard", amex: "amex", americanexpress: "amex", discover: "discover", jcb: "jcb", diners: "diners", dinersclub: "diners" };
const DECIMAL = /^-?\d{1,12}(\.\d{1,2})?$/;
const SOLA_TIME = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ?(AM|PM)$/i;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);
const pad = (n: number) => String(n).padStart(2, "0");

/** A report row with its field names lowercased, since Sola's casing varies between its pages. */
export function solaRow(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
}

/** A decimal amount in whole cents, or undefined when it isn't one. */
export function solaCents(v: unknown): number | undefined {
  return typeof v === "string" && DECIMAL.test(v.trim()) ? Math.round(Number(v) * 100) : undefined;
}

/** How far a zone is ahead of UTC at an instant, in ms. */
function zoneOffset(t: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(t)
      .map((p) => [p.type, Number(p.value)]),
  );
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - (t - (t % 1000));
}

/** The wall-clock time (YYYY-MM-DD HH:MM:SS) in a zone at an instant. */
export function solaWallClock(t: number, zone: string): string {
  return new Date(t + zoneOffset(t, zone)).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * A time as Sola's report writes it, as the account's wall clock
 * (YYYY-MM-DD HH:MM:SS) and as a UTC ISO time, or undefined when it isn't
 * one. In the hour a clock goes back, the earlier of the two is taken.
 */
export function solaTime(v: unknown, zone: string): { wall: string; iso: string } | undefined {
  const m = typeof v === "string" ? SOLA_TIME.exec(v.trim()) : null;
  if (!m) return undefined;
  const [month, day, year, hour12, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (hour12 < 1 || hour12 > 12 || minute > 59 || second > 59) return undefined;
  const hour = (hour12 % 12) + (m[7]!.toUpperCase() === "PM" ? 12 : 0);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const wall = new Date(asUtc).toISOString().slice(0, 19).replace("T", " ");
  // Date.UTC rolls an impossible day (2/30) into the next month, so the day must read back as itself.
  if (wall.slice(0, 10) !== `${year}-${pad(month)}-${pad(day)}`) return undefined;
  const guess = asUtc - zoneOffset(asUtc, zone);
  const t = asUtc - zoneOffset(guess, zone);
  return { wall, iso: new Date(Math.min(t, guess)).toISOString() };
}

export interface SolaContext {
  customerKey: string;
  /** The account's IANA time zone, which Sola's times are in. */
  timeZone: string;
  receivedAt: string;
}

export type SolaRead = { ok: boolean; event: SolaEvent | null; wall: string | undefined };

/**
 * The event for one report row, or null for a command that isn't a payment.
 * `wall` is the row's time on the account's clock, for paging.
 */
export function solaTransactionEvent(raw: unknown, ctx: SolaContext): SolaRead {
  const r = solaRow(raw);
  const command = typeof r.xcommand === "string" ? r.xcommand.trim().toLowerCase() : "";
  const at = solaTime(r.xentereddate, ctx.timeZone);
  const refund = REFUNDS.has(command);
  if (command && !refund && !CHARGES.has(command)) return { ok: true, event: null, wall: at?.wall };

  const problems: string[] = [];
  const id = typeof r.xrefnum === "string" && /^\d{1,20}$/.test(r.xrefnum) ? r.xrefnum : undefined;
  if (!id) problems.push("transaction has no reference number that reads");
  if (!command) problems.push("transaction has no command");
  if (!at) problems.push("transaction has no time that reads");
  const cents = solaCents(r.xamount);
  if (cents === undefined) problems.push("transaction has no amount that reads");

  const result = typeof r.xresponseresult === "string" ? r.xresponseresult.trim().toLowerCase() : "";
  const voided = r.xvoid === "1" || r.xvoid === 1 || r.xvoid === true;
  const status = result !== "approved" || voided ? "failed" : command === "cc:authonly" ? "pending" : "succeeded";
  const brand = typeof r.xcardtype === "string" ? own(BRANDS, r.xcardtype.toLowerCase().replace(/[^a-z]/g, "")) : undefined;
  const batch = typeof r.xresponsebatch === "string" && /^\d{1,20}$/.test(r.xresponsebatch) ? r.xresponsebatch : undefined;
  const ref = `sola_payments:transaction:${id}`;
  const common = {
    system: "Sola Payments",
    amountCents: cents === undefined ? undefined : Math.abs(cents),
    currency: typeof r.xcurrency === "string" && /^[A-Z]{3}$/.test(r.xcurrency) ? r.xcurrency : "USD",
    status,
    gatewayCommand: command,
    gatewayResult: /^[a-z]{1,20}$/.test(result) ? result : "unknown",
    voided,
    method: command.startsWith("check:") ? "ach" : "card",
    cardBrand: brand ?? null,
    batchId: batch ? `sola_payments:batch:${batch}` : undefined,
    customerRefs: formCustomerRefs(ctx.customerKey, { email: r.xemail, phone: r.xbillphone }).sort(),
  };
  const payload: Record<string, unknown> = refund
    ? { refundId: ref, ...common }
    : { chargeId: ref, ...common, paid: status === "succeeded", captured: status === "succeeded" };

  const ok = problems.length === 0;
  const key = ok ? `sola_payments:transaction:${id}:${short(payload)}` : `sola_payments:unreadable_transaction:${short(raw)}`;
  return {
    ok,
    wall: at?.wall,
    event: {
      id: key.replace(/:/g, "_"),
      type: refund ? SOLA_REFUND_EVENT : SOLA_CHARGE_EVENT,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? at!.iso : undefined,
      receivedAt: ctx.receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: "Sola Payments", transactionId: id ?? null, problems },
    },
  };
}
