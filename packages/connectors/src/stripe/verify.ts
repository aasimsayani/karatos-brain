import { checkVerifyLimit, inVerifyPeriod, type VerifyPeriod, type VerifySource, type VerifySourceRecord } from "@karatos/core";
import type { StripeClient } from "./client.js";
import { fromUnix, stripeRef, type StripeCharge, type StripeRefund } from "./normalize.js";

/**
 * Stripe's own count and gross of captured charges for a period, from the
 * charges list the connector already imports with its read-only restricted
 * key. Stripe has no count call, so the list is paged and summed here.
 *
 * A charge counts when it succeeded and captured more than nothing, on the
 * day it was created, for the amount captured. Refunds don't lower it: like
 * the brief's gross, it is before refunds, which Stripe lists on their own.
 *
 * Refunds come from the refunds list the connector already imports, with
 * the same key. A refund counts when it succeeded with an amount, on the day
 * it was created, whatever day its charge was; each partial refund of a
 * charge is a record of its own.
 */

const PAGE_SIZE = 100;

/** Whether a charge counts toward the verified totals, on either side. */
export const stripeChargeCounts = (status: unknown, capturedCents: unknown): capturedCents is number =>
  status === "succeeded" && typeof capturedCents === "number" && Number.isSafeInteger(capturedCents) && capturedCents > 0;

/** Whether a refund counts toward the verified totals, on either side. */
export const stripeRefundCounts = (status: unknown, cents: unknown): cents is number => status === "succeeded" && typeof cents === "number" && Number.isSafeInteger(cents) && cents > 0;

/** Every object a Stripe list holds for the period, a page at a time, kept by `pick`. */
async function listPeriod<T extends { id: string; created: number }>(client: StripeClient, path: string, period: VerifyPeriod, pick: (o: T) => VerifySourceRecord | null): Promise<VerifySourceRecord[]> {
  const records: VerifySourceRecord[] = [];
  const created = { gte: Math.floor(Date.parse(period.from) / 1000), lt: Math.ceil(Date.parse(period.to) / 1000) };
  let startingAfter: string | undefined;
  for (;;) {
    const page = await client.list<T>(path, { limit: PAGE_SIZE, created, starting_after: startingAfter });
    for (const o of page.data) {
      const record = inVerifyPeriod(fromUnix(o.created), period) ? pick(o) : null;
      if (record) records.push(record);
    }
    checkVerifyLimit(records, "Stripe");
    const last = page.data.at(-1);
    if (!page.has_more || !last) break;
    startingAfter = last.id;
  }
  return records;
}

export async function stripeVerify(client: StripeClient, period: VerifyPeriod): Promise<VerifySource[]> {
  const charges = await listPeriod<StripeCharge>(client, "/v1/charges", period, (c) => (stripeChargeCounts(c.status, c.amount_captured) ? { ref: stripeRef("charge", c.id), cents: c.amount_captured } : null));
  const refunds = await listPeriod<StripeRefund>(client, "/v1/refunds", period, (r) => (stripeRefundCounts(r.status, r.amount) ? { ref: stripeRef("refund", r.id), cents: r.amount } : null));
  return [
    { subject: "charges", records: charges, basis: "Stripe charges created in the period that succeeded, at the amount captured before refunds" },
    { subject: "payment_refunds", records: refunds, basis: "Stripe refunds created in the period that succeeded, at their amount" },
  ];
}
