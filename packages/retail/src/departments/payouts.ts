import type { EventEnvelope, Reasoner, Recommendation, Signal } from "@karatos/core";
import { z } from "zod";
import { calendarDaysSince, dollars, estimate, extractor, latestBySubject, recommend, signalFrom, value } from "../department.js";

/**
 * Matching payouts to the sales they pay for.
 *
 * The payment connectors write every processor in the same neutral types:
 * `payout.updated` for a payout or settlement batch, `balance.transaction_recorded`
 * for a line of one, and `payment.charge_updated` / `payment.refund_updated`
 * for each charge and refund. These rules read them (they don't own them, so
 * a connector's record is never dead-lettered here) and keep two signals:
 *
 * - `payout.record`, one per payout: what was paid, when, its status, and any
 *   sales, refunds and fees the processor reports alongside;
 * - `payout.line`, one per sale, refund, fee or adjustment, under the payout
 *   that paid it when the processor says which, with what it adds to it.
 *
 * Then finance compares each payout with what it covers, and raises a
 * recommendation when a payout is short, missing or late. See
 * docs/departments/README.md#matching-payouts-to-sales for what each
 * processor gives and the limits.
 */

/** Days after a sale is captured (or, for Stripe, comes available) by which each processor normally pays it out, weekends included. */
export const PAYOUT_SCHEDULE_DAYS: Readonly<Record<string, number>> = {
  stripe: 4,
  authorize_net: 4,
  aurora: 4,
  affirm: 7,
  klarna: 10,
};
/** For a processor not listed above. */
export const DEFAULT_PAYOUT_SCHEDULE_DAYS = 7;
/** A payout this far under what it covers is short: the larger of a dollar and half a percent. */
export const PAYOUT_TOLERANCE_CENTS = 100;
export const PAYOUT_TOLERANCE_SHARE = 0.005;
/** Sales still unpaid this many days past their processor's schedule are called missing, not late. */
export const PAYOUT_MISSING_AFTER_DAYS = 30;
/** How far back payouts and sales are judged. */
export const PAYOUT_LOOKBACK_DAYS = 90;

const NAMES: Readonly<Record<string, string>> = {
  stripe: "Stripe",
  klarna: "Klarna",
  aurora: "Aurora Payments",
  affirm: "Affirm",
  authorize_net: "Authorize.net",
};
/** Processors whose charges say which batch paid them, so a captured charge with none hasn't been paid out yet. */
const BATCHED_CHARGES = new Set(["authorize_net"]);
/** Processors whose lines carry no payout, only the day they come available, and whose payouts sweep everything available. */
const SWEPT = new Set(["stripe"]);
/**
 * Processors whose payout reports every total that makes it up, so a payout
 * read without its lines can still be checked against them. Klarna's totals
 * also carry holdbacks, releases, reversals and debt, so it is checked only
 * against its lines.
 */
const REPORTED_TOTALS = new Set(["affirm", "aurora", "authorize_net"]);

const Cents = z.number().int().nullable().optional();
const Text = z.string().nullable().optional();

const PayoutPayload = z.object({
  payoutId: z.string().min(1),
  amountCents: Cents,
  currency: Text,
  status: Text,
  arrivalDate: Text,
  settledOn: Text,
  salesCents: Cents,
  chargeCents: Cents,
  refundCents: Cents,
  refundsCents: Cents,
  feeCents: Cents,
  commissionCents: Cents,
});

const LinePayload = z.object({
  balanceTransactionId: z.string().min(1).optional(),
  transactionId: z.string().min(1).optional(),
  payoutId: z.string().min(1).nullable().optional(),
  type: Text,
  transactionType: Text,
  status: Text,
  amountCents: Cents,
  netCents: Cents,
  feeCents: Cents,
  totalCents: Cents,
  currency: Text,
  availableOn: Text,
  orderId: Text,
  captureId: Text,
  saleAt: Text,
  capturedAt: Text,
});

const ChargePayload = z.object({
  chargeId: z.string().min(1),
  batchId: z.string().min(1).optional(),
  captured: z.boolean().optional(),
  capturedCents: Cents,
  amountCents: Cents,
  currency: Text,
  orderId: Text,
});

const RefundPayload = z.object({
  refundId: z.string().min(1),
  chargeId: z.string().optional(),
  batchId: z.string().min(1).optional(),
  amountCents: Cents,
  currency: Text,
  status: Text,
});

export type PayoutStatus = "paid" | "pending" | "failed" | "unknown";

/** A payout as the `payout.record` signal keeps it. */
export type PayoutRecord = {
  processor: string;
  payoutId: string;
  amountCents: number | null;
  currency: string | null;
  status: PayoutStatus;
  processorStatus: string | null;
  /** The day it was made or batched. */
  createdOn: string;
  /** The day it lands or settled, when the processor says. */
  arrivalOn: string | null;
  reportedSalesCents: number | null;
  reportedRefundCents: number | null;
  reportedFeeCents: number | null;
}

export type LineCategory = "sale" | "refund" | "fee" | "adjustment";

/** A line as the `payout.line` signal keeps it. */
export type PayoutLine = {
  processor: string;
  lineId: string;
  /** The payout that paid it, when the processor says; null when it says the line is not in one yet, or (Stripe) never says. */
  payoutId: string | null;
  category: LineCategory;
  /** What it adds to its payout, signed: a sale less its fee is positive, a refund or fee negative. */
  netCents: number;
  /** The processor's fee on it, zero or more, when it reports one. */
  feeCents: number;
  currency: string | null;
  /** The day it was captured. */
  on: string;
  /** The day it comes available to pay out, when the processor says. */
  availableOn: string | null;
  orderId: string | null;
  chargeId: string | null;
}

/** The processor a reference like `stripe:payout:po_1` belongs to. */
export const processorOf = (ref: string) => ref.split(":")[0] ?? ref;
const nameOf = (processor: string) => NAMES[processor] ?? processor;
const scheduleOf = (processor: string) => PAYOUT_SCHEDULE_DAYS[processor] ?? DEFAULT_PAYOUT_SCHEDULE_DAYS;
/** The processor's own id, as a person would look it up: `po_1` from `stripe:payout:po_1`. */
const shown = (ref: string) => ref.split(":").slice(2).join(":") || ref;
const day = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v.slice(0, 10))) ? v.slice(0, 10) : null);
const currencyOf = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : null);
const num = (v: number | null | undefined): number | null => (typeof v === "number" ? v : null);

const STATUSES: Readonly<Record<string, PayoutStatus>> = {
  paid: "paid",
  settled: "paid",
  in_transit: "paid",
  pending: "pending",
  open: "pending",
  failed: "failed",
  canceled: "failed",
};

/** Money in its own currency: dollars for US dollars, otherwise the amount and its code. */
export function money(cents: number, currency: string | null): string {
  if (currency === null || currency === "USD") return dollars(cents);
  return `${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function payoutSignal(event: EventEnvelope): Signal[] {
  const parsed = PayoutPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const processor = processorOf(p.payoutId);
  const fee = num(p.feeCents) === null && num(p.commissionCents) === null ? null : (p.feeCents ?? 0) + (p.commissionCents ?? 0);
  const record: PayoutRecord = {
    processor,
    payoutId: p.payoutId,
    amountCents: num(p.amountCents),
    currency: currencyOf(p.currency),
    status: STATUSES[p.status ?? ""] ?? "unknown",
    processorStatus: p.status ?? null,
    createdOn: event.occurredAt.slice(0, 10),
    arrivalOn: day(p.arrivalDate) ?? day(p.settledOn),
    reportedSalesCents: num(p.salesCents) ?? num(p.chargeCents),
    reportedRefundCents: num(p.refundCents) ?? num(p.refundsCents),
    reportedFeeCents: fee,
  };
  return [signalFrom(event, "payout.record", { kind: "payout", id: p.payoutId }, { ...record })];
}

function lineSignal(event: EventEnvelope, line: Omit<PayoutLine, "on"> & { on?: string | null }): Signal {
  const full: PayoutLine = { ...line, on: line.on ?? event.occurredAt.slice(0, 10) };
  return signalFrom(event, "payout.line", { kind: "payout_line", id: full.lineId }, { ...full });
}

/** Stripe balance transaction types that move money out to the bank, or in from it, rather than make up a payout. */
const STRIPE_SKIP = /^(payout|transfer|topup|connect_collection_transfer)/;

function stripeCategory(type: string): LineCategory {
  if (type === "charge" || type === "payment") return "sale";
  if (type === "refund" || type === "payment_refund") return "refund";
  if (type.includes("fee")) return "fee";
  return "adjustment";
}

const KLARNA: Readonly<Record<string, LineCategory>> = { sale: "sale", return: "refund", fee: "fee", commission: "fee" };
const AURORA_DEAD = /void|declin|fail|error|reject/i;

function balanceLine(event: EventEnvelope): Signal[] {
  const parsed = LinePayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const currency = currencyOf(p.currency);
  if (p.balanceTransactionId && processorOf(p.balanceTransactionId) === "stripe") {
    const type = p.type ?? "";
    if (STRIPE_SKIP.test(type) || typeof p.netCents !== "number") return [];
    return [
      lineSignal(event, {
        processor: "stripe",
        lineId: p.balanceTransactionId,
        payoutId: null,
        category: stripeCategory(type),
        netCents: p.netCents,
        feeCents: Math.max(0, p.feeCents ?? 0),
        currency,
        availableOn: day(p.availableOn),
        orderId: null,
        chargeId: null,
      }),
    ];
  }
  if (!p.payoutId || typeof p.payoutId !== "string") return [];
  const processor = processorOf(p.payoutId);
  if (p.transactionId) {
    // Aurora: a sale or capture adds its total; a refund takes it away; anything else moves no money.
    const type = p.transactionType ?? "";
    const sign = type === "sale" || type === "capture" ? 1 : type === "refund" ? -1 : 0;
    if (sign === 0 || typeof p.totalCents !== "number" || AURORA_DEAD.test(p.status ?? "")) return [];
    return [
      lineSignal(event, {
        processor,
        lineId: p.transactionId,
        payoutId: p.payoutId,
        category: sign > 0 ? "sale" : "refund",
        netCents: sign * Math.abs(p.totalCents),
        feeCents: 0,
        currency,
        availableOn: null,
        orderId: null,
        chargeId: null,
      }),
    ];
  }
  // Klarna: each line is signed already; a line has no ID, so its event is its identity.
  if (typeof p.amountCents !== "number") return [];
  const category = KLARNA[p.type ?? ""] ?? "adjustment";
  return [
    lineSignal(event, {
      processor,
      lineId: `${p.payoutId}#${event.id}`,
      payoutId: p.payoutId,
      category,
      netCents: p.amountCents,
      feeCents: category === "fee" ? Math.max(0, -p.amountCents) : 0,
      currency,
      on: day(p.capturedAt) ?? day(p.saleAt),
      availableOn: null,
      orderId: p.orderId ?? null,
      chargeId: p.captureId ?? null,
    }),
  ];
}

function chargeLine(event: EventEnvelope): Signal[] {
  const parsed = ChargePayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const processor = processorOf(p.chargeId);
  if (!p.batchId && !BATCHED_CHARGES.has(processor)) return [];
  const cents = p.capturedCents ?? p.amountCents;
  if (p.captured !== true || typeof cents !== "number" || cents <= 0) return [];
  return [
    lineSignal(event, {
      processor,
      lineId: p.chargeId,
      payoutId: p.batchId ?? null,
      category: "sale",
      netCents: cents,
      feeCents: 0,
      currency: currencyOf(p.currency),
      availableOn: null,
      orderId: p.orderId ?? null,
      chargeId: p.chargeId,
    }),
  ];
}

function refundLine(event: EventEnvelope): Signal[] {
  const parsed = RefundPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  // Only a refund that says which batch it settled in is matched: elsewhere refunds come through the payout's own lines.
  if (!p.batchId || typeof p.amountCents !== "number" || p.status === "failed" || p.status === "canceled") return [];
  return [
    lineSignal(event, {
      processor: processorOf(p.refundId),
      lineId: p.refundId,
      payoutId: p.batchId,
      category: "refund",
      netCents: -Math.abs(p.amountCents),
      feeCents: 0,
      currency: currencyOf(p.currency),
      availableOn: null,
      orderId: null,
      chargeId: p.chargeId ?? null,
    }),
  ];
}

export const payoutExtractor = extractor("finance-payouts", (event) => {
  switch (event.type) {
    case "payout.updated":
      return payoutSignal(event);
    case "balance.transaction_recorded":
      return balanceLine(event);
    case "payment.charge_updated":
      return chargeLine(event);
    case "payment.refund_updated":
      return refundLine(event);
    default:
      return [];
  }
});

/** What a payout should have paid: its lines, or failing those the totals it reports. */
interface Expected {
  cents: number;
  lines: Signal[];
  from: "lines" | "swept" | "reported";
}

const sum = (lines: Signal[]) => lines.reduce((n, s) => n + value<PayoutLine>(s).netCents, 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function expected(payout: PayoutRecord, explicit: Signal[] | undefined, swept: Signal[] | undefined): Expected | null {
  const lines = [...(explicit ?? []), ...(swept ?? [])];
  if (lines.length > 0) {
    // Lines in another currency can't be added to this payout without a rate, so it isn't judged.
    if (lines.some((s) => value<PayoutLine>(s).currency !== payout.currency)) return null;
    return { cents: sum(lines), lines, from: explicit?.length ? "lines" : "swept" };
  }
  if (payout.reportedSalesCents === null || !REPORTED_TOTALS.has(payout.processor)) return null;
  return { cents: payout.reportedSalesCents - Math.abs(payout.reportedRefundCents ?? 0) - Math.abs(payout.reportedFeeCents ?? 0), lines: [], from: "reported" };
}

/**
 * Stripe pays out everything that came available since the last payout, so
 * each line goes to the first payout in its currency made on or after the
 * day it came available. The first payout seen has no known start, so it
 * takes its lines but isn't judged; lines after the last payout are unpaid.
 */
function sweep(payouts: Signal[], lines: Signal[]): { covered: Map<string, Signal[]>; unbounded: Set<string>; unpaid: Signal[] } {
  const covered = new Map<string, Signal[]>();
  const unbounded = new Set<string>();
  const unpaid: Signal[] = [];
  const byKey = new Map<string, Signal[]>();
  for (const p of payouts) {
    const r = value<PayoutRecord>(p);
    if (!SWEPT.has(r.processor) || (r.status !== "paid" && r.status !== "pending")) continue;
    const key = `${r.processor}:${r.currency}`;
    byKey.set(key, [...(byKey.get(key) ?? []), p]);
  }
  for (const list of byKey.values()) {
    list.sort((a, b) => value<PayoutRecord>(a).createdOn.localeCompare(value<PayoutRecord>(b).createdOn));
    unbounded.add(value<PayoutRecord>(list[0]!).payoutId);
  }
  for (const s of lines) {
    const l = value<PayoutLine>(s);
    if (!SWEPT.has(l.processor) || l.payoutId !== null) continue;
    const available = l.availableOn ?? l.on;
    const payout = (byKey.get(`${l.processor}:${l.currency}`) ?? []).find((p) => value<PayoutRecord>(p).createdOn >= available);
    if (!payout) {
      unpaid.push(s);
      continue;
    }
    const id = value<PayoutRecord>(payout).payoutId;
    covered.set(id, [...(covered.get(id) ?? []), s]);
  }
  return { covered, unbounded, unpaid };
}

const recent = (date: string, now: string) => calendarDaysSince(date, now) <= PAYOUT_LOOKBACK_DAYS;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const protects = (cents: number, currency: string | null, basis: string) => (currency === "USD" ? estimate("protects", basis, () => cents) : undefined);

export const payoutReasoner: Reasoner = {
  name: "finance.payout-match",
  reason: ({ organizationId, signals, now }) => {
    const payouts = [...latestBySubject(signals, ["payout.record"]).values()];
    const lines = [...latestBySubject(signals, ["payout.line"]).values()].filter((s) => recent(value<PayoutLine>(s).on, now));
    const known = new Map(payouts.map((p) => [value<PayoutRecord>(p).payoutId, p]));
    const read = new Set(payouts.map((p) => `${value<PayoutRecord>(p).processor}:${value<PayoutRecord>(p).currency}`));
    const explicit = new Map<string, Signal[]>();
    const unbatched: Signal[] = [];
    for (const s of lines) {
      const l = value<PayoutLine>(s);
      if (l.payoutId) explicit.set(l.payoutId, [...(explicit.get(l.payoutId) ?? []), s]);
      else if (!SWEPT.has(l.processor)) unbatched.push(s);
    }
    const swept = sweep(payouts, lines);
    const out: Recommendation[] = [];
    const rec = (key: string, summary: string, confidence: number, expectedImpact: string, impact: ReturnType<typeof protects>, basedOn: Signal[]) =>
      recommend({ department: "finance", key, organizationId, summary, confidence, expectedImpact, impact, basedOn, now });

    for (const p of payouts) {
      const r = value<PayoutRecord>(p);
      const name = nameOf(r.processor);
      if (!recent(r.createdOn, now) || r.amountCents === null) continue;
      if (r.status === "failed") {
        if (r.amountCents <= 0) continue;
        out.push(
          rec(
            `payout_failed_${r.payoutId}`,
            `${name} payout ${shown(r.payoutId)} of ${money(r.amountCents, r.currency)} from ${r.createdOn} ${r.processorStatus === "canceled" ? "was canceled" : "did not go through"}, so the sales it covers are not in the bank. Check the bank account on file with ${name} and that the money was sent again.`,
            0.8,
            `Recovers ${money(r.amountCents, r.currency)} of sales not paid out`,
            protects(r.amountCents, r.currency, `The ${dollars(r.amountCents)} ${name} payout that did not arrive.`),
            [p],
          ),
        );
        continue;
      }
      if (r.status === "pending") {
        const due = addDays(r.arrivalOn ?? r.createdOn, scheduleOf(r.processor));
        const late = calendarDaysSince(due, now);
        if (late <= 0) continue;
        out.push(
          rec(
            `payout_pending_${r.payoutId}`,
            `${name} payout ${shown(r.payoutId)} of ${money(r.amountCents, r.currency)} from ${r.createdOn} still shows as ${r.processorStatus ?? "pending"}, ${plural(late, "day")} after it would normally have landed. Check with ${name} that it was sent.`,
            0.65,
            `Brings in ${money(r.amountCents, r.currency)} paid out late`,
            undefined,
            [p],
          ),
        );
        continue;
      }
      if (r.status !== "paid" || r.currency === null || swept.unbounded.has(r.payoutId)) continue;
      const want = expected(r, explicit.get(r.payoutId), swept.covered.get(r.payoutId));
      if (!want || want.cents <= 0) continue;
      const shortfall = want.cents - r.amountCents;
      if (shortfall <= Math.max(PAYOUT_TOLERANCE_CENTS, Math.round(want.cents * PAYOUT_TOLERANCE_SHARE))) continue;
      const covers =
        want.from === "reported"
          ? `the sales less refunds and fees it reports come to ${money(want.cents, r.currency)}`
          : `the ${plural(want.lines.length, "sale, refund and fee", "sales, refunds and fees")} it covers come to ${money(want.cents, r.currency)}`;
      out.push(
        rec(
          `payout_short_${r.payoutId}`,
          `${name} payout ${shown(r.payoutId)} on ${r.createdOn} paid ${money(r.amountCents, r.currency)}, but ${covers}: ${money(shortfall, r.currency)} short. Ask ${name} for the payout's detail and anything held back.`,
          want.from === "lines" ? 0.75 : want.from === "reported" ? 0.7 : 0.6,
          `Recovers up to ${money(shortfall, r.currency)} paid short`,
          protects(shortfall, r.currency, `The ${dollars(shortfall)} between what the payout covers and what ${name} paid.`),
          [p, ...want.lines],
        ),
      );
    }

    // Lines that name a payout KaratOS has no record of, once that payout should have been made.
    for (const [payoutId, list] of explicit) {
      if (known.has(payoutId)) continue;
      const processor = processorOf(payoutId);
      const newest = list.map((s) => value<PayoutLine>(s).on).sort().at(-1)!;
      if (calendarDaysSince(newest, now) <= scheduleOf(processor)) continue;
      const currencies = new Set(list.map((s) => value<PayoutLine>(s).currency));
      const currency = currencies.size === 1 ? [...currencies][0]! : null;
      const total = sum(list);
      const name = nameOf(processor);
      const worth = currency === null ? "" : ` worth ${money(total, currency)}`;
      out.push(
        rec(
          `payout_unrecorded_${payoutId}`,
          `${name} lists ${plural(list.length, "line")}${worth} under payout ${shown(payoutId)}, but there is no record of that payout. Find the deposit on the bank statement, or ask ${name} for the payout report.`,
          0.6,
          currency === null ? "Accounts for a payout with no record" : `Accounts for ${money(total, currency)} of sales`,
          total > 0 && currency !== null ? protects(total, currency, `The ${dollars(total)} the ${name} lines under this payout add up to.`) : undefined,
          list,
        ),
      );
    }

    // Sales no payout has paid, past when their processor normally pays, for processors whose payouts are read.
    const overdue = new Map<string, { late: Signal[]; missing: Signal[] }>();
    for (const s of [...unbatched, ...swept.unpaid]) {
      const l = value<PayoutLine>(s);
      if (l.category !== "sale" || !read.has(`${l.processor}:${l.currency}`)) continue;
      const past = calendarDaysSince(addDays(l.availableOn ?? l.on, scheduleOf(l.processor)), now);
      if (past <= 0) continue;
      const key = `${l.processor}:${l.currency}`;
      const group = overdue.get(key) ?? { late: [], missing: [] };
      (past > PAYOUT_MISSING_AFTER_DAYS ? group.missing : group.late).push(s);
      overdue.set(key, group);
    }
    for (const [key, group] of overdue) {
      const [processor, currency] = [key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1)];
      const name = nameOf(processor);
      const schedule = scheduleOf(processor);
      const tag = `${processor}_${currency}`;
      if (group.late.length > 0) {
        const total = sum(group.late);
        const oldest = group.late.map((s) => value<PayoutLine>(s).on).sort()[0]!;
        out.push(
          rec(
            `payout_late_${tag}`,
            `${plural(group.late.length, `${name} sale`)} worth ${money(total, currency)}, the oldest from ${oldest}, ${group.late.length === 1 ? "has" : "have"} not been paid out, though ${name} normally pays within ${plural(schedule, "day")}. Check ${name} for a hold or a paused payout schedule.`,
            0.6,
            `Brings in ${money(total, currency)} paid out late`,
            undefined,
            group.late,
          ),
        );
      }
      if (group.missing.length > 0) {
        const total = sum(group.missing);
        const oldest = group.missing.map((s) => value<PayoutLine>(s).on).sort()[0]!;
        out.push(
          rec(
            `payout_missing_${tag}`,
            `${plural(group.missing.length, `${name} sale`)} worth ${money(total, currency)}, the oldest from ${oldest}, ${group.missing.length === 1 ? "is" : "are"} in no payout more than ${PAYOUT_MISSING_AFTER_DAYS} days after ${name} would normally have paid. Ask ${name} where the money went.`,
            0.7,
            `Recovers ${money(total, currency)} of sales never paid out`,
            protects(total, currency, `The ${dollars(total)} of ${name} sales in no payout.`),
            group.missing,
          ),
        );
      }
    }
    return out;
  },
};
