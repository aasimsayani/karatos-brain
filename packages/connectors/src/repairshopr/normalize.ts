import { createHash } from "node:crypto";
import type { RepairShoprList } from "./client.js";

/**
 * Turns RepairShopr's records into Brain A events, so a repair shop's jobs,
 * quotes and what they billed can be followed from intake to payment.
 *
 * - A ticket, the repair job, becomes `repair.ticket_updated`, with its
 *   number, status and dates.
 * - An estimate, the quote for a job, becomes `repair.estimate_updated`.
 * - An invoice becomes `repair.invoice_updated`, with its totals and
 *   whether it is paid.
 *
 * Each is keyed by its record and a digest of what was kept, so reading one
 * again unchanged is a duplicate and a new status or payment is a new
 * version. Only what following the work uses is kept. A customer is kept as
 * their RepairShopr ID, never their name, business name, email, phone or
 * address. A ticket's subject and comments, and an invoice's note, PO
 * number and PDF link, are not kept. Money is whole cents. A record without
 * an ID or a time that reads is dead-lettered listing what was wrong.
 */

export interface RepairShoprEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const REPAIRSHOPR_EVENTS = {
  tickets: "repair.ticket_updated",
  estimates: "repair.estimate_updated",
  invoices: "repair.invoice_updated",
} as const satisfies Record<RepairShoprList, string>;

const KINDS = { tickets: "ticket", estimates: "estimate", invoices: "invoice" } as const satisfies Record<RepairShoprList, string>;
// Date.parse turns down minute or second 60; hour 24 it reads as the next day, so it is ruled out here.
const TIME = /^(\d{4}-\d{2}-\d{2})(?:T((?:[01]\d|2[0-3]):\d{2}:\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?)?$/;
const DECIMAL = /^-?\d{1,12}(\.\d{1,6})?$/;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
// Anything but an object reads as a record without the fields asked for.
const record = (v: unknown) => (v ?? {}) as Record<string, unknown>;
const text = (v: unknown, max = 60): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);
const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
/** A positive whole-number ID, or undefined. */
const idOf = (v: unknown): number | undefined => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : undefined);
/** A number RepairShopr writes as a number on one record and a string on another, as text. */
const numberText = (v: unknown): string | null => (idOf(v) === undefined ? text(v, 40) : String(v));

export const repairShoprRef = (kind: string, id: number) => `repairshopr:${kind}:${id}`;
const refOf = (kind: string, v: unknown): string | null => {
  const id = idOf(v);
  return id === undefined ? null : repairShoprRef(kind, id);
};

/** A time or day as RepairShopr writes it, as a UTC ISO time, or undefined. One without a zone is read as UTC. */
export function repairShoprTime(v: unknown): string | undefined {
  const m = typeof v === "string" ? TIME.exec(v.trim()) : null;
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2] ?? "00:00:00"}${m[3] ?? ""}${m[4] ?? "Z"}`);
  // Date.parse rolls a day like 02-30 into the next month, so the day must read back as itself.
  if (Number.isNaN(t) || new Date(Date.parse(`${m[1]}T00:00:00Z`)).toISOString().slice(0, 10) !== m[1]) return undefined;
  return new Date(t).toISOString();
}

/** The day a RepairShopr date is for, as written (its zone is the shop's), or null. */
export function repairShoprDay(v: unknown): string | null {
  return repairShoprTime(v) === undefined ? null : (v as string).trim().slice(0, 10);
}

/** Dollars, as a number or a decimal string, in whole cents, or null. */
export function repairShoprCents(v: unknown): number | null {
  // A number that isn't finite writes as a word, which isn't a decimal.
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!DECIMAL.test(s)) return null;
  const n = Number(s);
  // Rounded on the size, then signed, so half a cent rounds away from zero either way.
  const cents = Math.round(Math.abs(n) * 100);
  return n < 0 ? -cents : cents;
}

function payloadOf(list: RepairShoprList, r: Record<string, unknown>): Record<string, unknown> {
  switch (list) {
    case "tickets":
      return {
        number: numberText(r.number),
        status: text(r.status),
        customerId: refOf("customer", r.customer_id),
        openedAt: repairShoprTime(r.created_at) ?? null,
        dueDate: repairShoprDay(r.due_date),
      };
    case "estimates":
      return {
        number: numberText(r.number),
        status: text(r.status),
        customerId: refOf("customer", r.customer_id),
        date: repairShoprDay(r.date),
        subtotalCents: repairShoprCents(r.subtotal),
        taxCents: repairShoprCents(r.tax),
        totalCents: repairShoprCents(r.total),
      };
    case "invoices":
      return {
        number: numberText(r.number),
        customerId: refOf("customer", r.customer_id),
        ticketId: refOf("ticket", r.ticket_id),
        locationId: refOf("location", r.location_id),
        date: repairShoprDay(r.date),
        dueDate: repairShoprDay(r.due_date),
        subtotalCents: repairShoprCents(r.subtotal),
        taxCents: repairShoprCents(r.tax),
        totalCents: repairShoprCents(r.total),
        paid: flag(r.is_paid),
        verifiedPaid: flag(r.verified_paid),
        techMarkedPaid: flag(r.tech_marked_paid),
      };
  }
}

export interface RepairShoprContext {
  receivedAt: string;
}

/** The event for one RepairShopr record. One that doesn't read is dead-lettered with its problems. */
export function repairShoprEvent(list: RepairShoprList, raw: unknown, ctx: RepairShoprContext): RepairShoprEvent {
  const r = record(raw);
  const kind = KINDS[list];
  const problems: string[] = [];
  const id = idOf(r.id);
  if (id === undefined) problems.push(`${kind} has no ID that reads`);
  const at = repairShoprTime(r.updated_at) ?? repairShoprTime(r.created_at);
  if (!at) problems.push(`${kind} has no time that reads`);
  const ok = problems.length === 0;
  const payload: Record<string, unknown> = ok ? { system: "RepairShopr", [`${kind}Id`]: repairShoprRef(kind, id!), ...payloadOf(list, r), updatedAt: at } : { system: "RepairShopr", [`${kind}Id`]: id === undefined ? null : repairShoprRef(kind, id), problems };
  const key = ok ? `repairshopr:${kind}:${id}:${short(payload)}` : `repairshopr:unreadable_${kind}:${short(raw)}`;
  return { id: key.replace(/:/g, "_"), type: REPAIRSHOPR_EVENTS[list], occurredAt: ok ? at : undefined, receivedAt: ctx.receivedAt, idempotencyKey: key, payload };
}
