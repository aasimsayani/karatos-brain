import { checkVerifyLimit, inVerifyPeriod, type VerifyPeriod, type VerifySource, type VerifySourceRecord } from "@karatos/core";
import type { StripeClient } from "./client.js";
import { fromUnix, stripeRef, type StripeCharge } from "./normalize.js";

/**
 * Stripe's own count and gross of captured charges for a period, from the
 * charges list the connector already imports with its read-only restricted
 * key. Stripe has no count call, so the list is paged and summed here.
 *
 * A charge counts when it succeeded and captured more than nothing, on the
 * day it was created, for the amount captured. Refunds don't lower it: like
 * the brief's gross, it is before refunds, which Stripe lists on their own.
 */

const PAGE_SIZE = 100;

/** Whether a charge counts toward the verified totals, on either side. */
export const stripeChargeCounts = (status: unknown, capturedCents: unknown): capturedCents is number =>
  status === "succeeded" && typeof capturedCents === "number" && Number.isSafeInteger(capturedCents) && capturedCents > 0;

export async function stripeVerify(client: StripeClient, period: VerifyPeriod): Promise<VerifySource[]> {
  const records: VerifySourceRecord[] = [];
  const created = { gte: Math.floor(Date.parse(period.from) / 1000), lt: Math.ceil(Date.parse(period.to) / 1000) };
  let startingAfter: string | undefined;
  for (;;) {
    const page = await client.list<StripeCharge>("/v1/charges", { limit: PAGE_SIZE, created, starting_after: startingAfter });
    for (const charge of page.data) {
      if (!stripeChargeCounts(charge.status, charge.amount_captured) || !inVerifyPeriod(fromUnix(charge.created), period)) continue;
      records.push({ ref: stripeRef("charge", charge.id), cents: charge.amount_captured });
    }
    checkVerifyLimit(records, "Stripe");
    const last = page.data.at(-1);
    if (!page.has_more || !last) break;
    startingAfter = last.id;
  }
  return [{ subject: "charges", records, basis: "Stripe charges created in the period that succeeded, at the amount captured before refunds" }];
}
