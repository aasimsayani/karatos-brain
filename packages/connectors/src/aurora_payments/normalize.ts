import { createHash } from "node:crypto";

/**
 * Turns Aurora Payments' (Flute's) records into Brain A events, so each
 * card and ACH settlement can be matched to the deposit on the bank
 * statement and to the sales behind it.
 *
 * - A settlement batch becomes `payout.updated`, with the processor's batch
 *   number, when it was batched, its sales, refunds and net, and whether it
 *   has settled.
 * - A transaction in a batch becomes `balance.transaction_recorded`, with
 *   its type, status, payment method and amounts, under its batch.
 *
 * Each is keyed by its record and a digest of what was kept, so reading one
 * again unchanged is a duplicate and a batch that settles is a new version.
 * Only what reconciling uses is kept: never a customer's name, company,
 * email, phone or masked card number, or the merchant's own name for a
 * payment method. Money is whole cents. A record without an ID or a time
 * that reads is dead-lettered listing what was wrong.
 */

export interface AuroraEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const AURORA_EVENTS = { batch: "payout.updated", transaction: "balance.transaction_recorded" } as const;

const ID = /^[A-Za-z0-9-]{1,64}$/;
// Date.parse turns down minute or second 60; hour 24 it reads as the next day, so it is ruled out here.
const TIME = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):\d{2}:\d{2})(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?$/;
const BATCH_STATUS: Readonly<Record<number, string>> = { 1: "open", 2: "settled" };
const TYPES: Readonly<Record<number, string>> = { 1: "authorization", 2: "sale", 3: "capture", 4: "void", 5: "refund", 6: "verify" };
const METHODS: Readonly<Record<number, string>> = { 1: "card", 2: "ach" };

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
// Anything but an object reads as a record without the fields asked for.
const record = (v: unknown) => (v ?? {}) as Record<string, unknown>;
const text = (v: unknown, max = 60): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);
const idOf = (v: unknown): string | undefined => (typeof v === "string" && ID.test(v) ? v.toLowerCase() : undefined);
/** A word from Flute's numbered list, or "unknown" for a number it doesn't list, or null. */
const word = (words: Readonly<Record<number, string>>, v: unknown): string | null => (Number.isSafeInteger(v) ? (words[v as number] ?? "unknown") : null);
const count = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);

export const auroraRef = (kind: string, id: string) => `aurora:${kind}:${id}`;

/** A Flute time as a UTC ISO time, or undefined. One without a zone is read as UTC. */
export function auroraTime(v: unknown): string | undefined {
  const m = typeof v === "string" ? TIME.exec(v) : null;
  if (!m) return undefined;
  // Seven fraction digits, as .NET writes them, are cut to the millisecond.
  const t = Date.parse(`${m[1]}T${m[2]}${(m[3] ?? "").slice(0, 4)}${m[4] ?? "Z"}`);
  // Date.parse rolls a day like 02-30 into the next month, so the day must read back as itself.
  if (Number.isNaN(t) || new Date(Date.parse(`${m[1]}T00:00:00Z`)).toISOString().slice(0, 10) !== m[1]) return undefined;
  return new Date(t).toISOString();
}

/** Dollars, as Flute writes them (a number), in whole cents, or null. */
export function auroraCents(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) >= 1e12) return null;
  // Rounded on the size, then signed, so half a cent rounds away from zero either way.
  const cents = Math.round(Math.abs(v) * 100);
  return v < 0 ? -cents : cents;
}

export interface AuroraContext {
  receivedAt: string;
}

function event(kind: "batch" | "transaction", raw: unknown, time: unknown, ctx: AuroraContext, payloadOf: (r: Record<string, unknown>) => Record<string, unknown>): AuroraEvent {
  const r = record(raw);
  const problems: string[] = [];
  const id = idOf(r.id);
  if (id === undefined) problems.push(`${kind} has no ID that reads`);
  const at = auroraTime(time);
  if (!at) problems.push(`${kind} has no time that reads`);
  const ok = problems.length === 0;
  const idKey = kind === "batch" ? "payoutId" : "transactionId";
  const payload: Record<string, unknown> = ok ? { system: "Aurora Payments", [idKey]: auroraRef(kind, id!), ...payloadOf(r), occurredAt: at } : { system: "Aurora Payments", [idKey]: id === undefined ? null : auroraRef(kind, id), problems };
  const key = ok ? `aurora:${kind}:${id}:${short(payload)}` : `aurora:unreadable_${kind}:${short(raw)}`;
  return { id: key.replace(/:/g, "_"), type: AURORA_EVENTS[kind], occurredAt: ok ? at : undefined, receivedAt: ctx.receivedAt, idempotencyKey: key, payload };
}

/** The event for one settlement batch. */
export function auroraBatchEvent(raw: unknown, ctx: AuroraContext): AuroraEvent {
  return event("batch", raw, record(raw).batchDateTime, ctx, (r) => ({
    processorBatchNumber: text(r.externalBatchId, 40),
    processor: text(r.paymentProcessorName),
    status: word(BATCH_STATUS, r.statusId),
    transactionCount: count(r.transactionCount),
    salesCents: auroraCents(r.salesAmount),
    refundsCents: auroraCents(r.refundsAmount),
    amountCents: auroraCents(r.netAmount),
    currency: "USD",
  }));
}

/** The event for one transaction in batch `batchId`. */
export function auroraTransactionEvent(raw: unknown, ctx: AuroraContext & { batchId: string }): AuroraEvent {
  return event("transaction", raw, record(raw).date, ctx, (r) => {
    const amount = record(r.amount);
    return {
      payoutId: auroraRef("batch", ctx.batchId.toLowerCase()),
      transactionType: word(TYPES, r.typeId),
      status: text(r.status, 40),
      paymentMethod: word(METHODS, r.paymentMethodTypeId),
      source: text(record(r.source).type, 40),
      currency: typeof r.currencyCode === "string" && /^[A-Z]{3}$/.test(r.currencyCode) ? r.currencyCode : null,
      baseCents: auroraCents(r.baseAmount),
      totalCents: auroraCents(r.totalAmount),
      surchargeCents: auroraCents(r.surchargeAmount),
      taxCents: auroraCents(amount.taxAmount),
      tipCents: auroraCents(amount.tipAmount),
      discountCents: auroraCents(amount.percentageOffAmount),
      cashDiscountCents: auroraCents(amount.cashDiscountAmount),
    };
  });
}
