import { checkVerifyLimit, inVerifyPeriod, VERIFY_MAX_SOURCE_RECORDS, VerifyLimitError, type VerifyPeriod, type VerifySource, type VerifySourceRecord } from "@karatos/core";
import type { ShopifyClient } from "./client.js";
import { legacyId, saleRef, SHOPIFY_PAID_STATUSES, toCents } from "./normalize.js";

/**
 * Shopify's own count of paid orders and their gross for a period, read with
 * the orders query the connector already syncs with (read_orders, nothing
 * more). Shopify's aggregate reports need the read_reports scope, which the
 * connector doesn't ask for, so the orders are paged and summed here instead.
 *
 * An order counts as the sales department counts it: paid (paid, partly
 * paid, partly refunded or refunded) with a total above zero, on the day it
 * was processed (or created, when Shopify has no processed time), for its
 * original total before refunds. A cancelled order that was never paid is
 * voided and counts on neither side.
 *
 * Refunds are read the same way, from the orders query and read_orders. An
 * order's updated time moves when it is refunded (the sync finds refunds by
 * it too), so orders updated since the period began, and created before it
 * ended, hold every refund made in it. A refund counts as the sync records
 * it: once, on the day it was created, at the sum of its returned lines'
 * subtotals. A refund with no lines, of shipping or a goodwill amount, is
 * left out on both sides, as the brief leaves it out.
 */

export const SHOPIFY_VERIFY_QUERY = `query VerifyOrders($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: PROCESSED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { id createdAt processedAt displayFinancialStatus totalPriceSet { shopMoney { amount } } }
  }
}`;

/** Few fields per order, so a page this size stays far under Shopify's query cost limit. */
export const SHOPIFY_VERIFY_PAGE_SIZE = 250;

interface VerifyOrder {
  id: string;
  createdAt: string;
  processedAt: string | null;
  displayFinancialStatus: string | null;
  totalPriceSet: { shopMoney: { amount: string } } | null;
}

/** Shopify's search syntax for orders processed in [from, to). */
export const processedIn = (period: VerifyPeriod) => `processed_at:>='${period.from}' processed_at:<'${period.to}'`;

async function verifySales(client: ShopifyClient, period: VerifyPeriod): Promise<VerifySource> {
  const records: VerifySourceRecord[] = [];
  let after: string | null = null;
  for (;;) {
    const data: { orders?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: VerifyOrder[] } } = await client.query(SHOPIFY_VERIFY_QUERY, {
      first: SHOPIFY_VERIFY_PAGE_SIZE,
      after,
      query: processedIn(period),
    });
    const page = data.orders;
    if (!page || !Array.isArray(page.nodes)) throw new Error("Shopify orders response has no nodes");
    for (const order of page.nodes) {
      const cents = toCents(order.totalPriceSet?.shopMoney?.amount);
      if (!SHOPIFY_PAID_STATUSES.has(order.displayFinancialStatus ?? "") || cents === null || cents <= 0) continue;
      // Filtered here too, so the day boundary is exactly the store's whatever the search does at the edges.
      if (!inVerifyPeriod(order.processedAt ?? order.createdAt, period)) continue;
      records.push({ ref: saleRef(order.id), cents });
    }
    checkVerifyLimit(records, "Shopify");
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
    after = page.pageInfo.endCursor;
  }
  return { subject: "sales", records, basis: "Shopify orders processed in the period that are paid, partly paid or refunded, at their original total" };
}

/** The sync reads ten refunds an order and fifty lines a refund; one more refund is asked for here, so an order past that shows. */
export const SHOPIFY_VERIFY_REFUNDS_PER_ORDER = 10;
export const SHOPIFY_VERIFY_REFUND_LINES = 50;
/** As many orders a page as the sync reads with refunds, so a page stays under Shopify's query cost limit. */
export const SHOPIFY_VERIFY_REFUNDS_PAGE_SIZE = 10;

export const SHOPIFY_VERIFY_REFUNDS_QUERY = `query VerifyRefunds($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      refunds(first: ${SHOPIFY_VERIFY_REFUNDS_PER_ORDER + 1}) {
        id createdAt
        refundLineItems(first: ${SHOPIFY_VERIFY_REFUND_LINES}) { pageInfo { hasNextPage } nodes { quantity subtotalSet { shopMoney { amount } } } }
      }
    }
  }
}`;

interface VerifyRefundOrder {
  id: string;
  refunds: { id: string; createdAt: string; refundLineItems: { pageInfo?: { hasNextPage: boolean }; nodes: { quantity: number; subtotalSet: { shopMoney: { amount: string } } | null }[] } | null }[] | null;
}

/** Shopify's search syntax for orders that can hold a refund made in [from, to): updated since it began, created before it ended. */
export const refundableIn = (period: VerifyPeriod) => `updated_at:>='${period.from}' created_at:<'${period.to}'`;

async function verifyRefunds(client: ShopifyClient, period: VerifyPeriod): Promise<VerifySource> {
  const basis = "Shopify refunds created in the period that return items, at the sum of the returned items' subtotals";
  const records: VerifySourceRecord[] = [];
  let scanned = 0;
  let after: string | null = null;
  for (;;) {
    const data: { orders?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: VerifyRefundOrder[] } } = await client.query(SHOPIFY_VERIFY_REFUNDS_QUERY, {
      first: SHOPIFY_VERIFY_REFUNDS_PAGE_SIZE,
      after,
      query: refundableIn(period),
    });
    const page = data.orders;
    if (!page || !Array.isArray(page.nodes)) throw new Error("Shopify orders response has no nodes");
    scanned += page.nodes.length;
    if (scanned > VERIFY_MAX_SOURCE_RECORDS) throw new VerifyLimitError(`Shopify has more than ${VERIFY_MAX_SOURCE_RECORDS} orders updated since the period began; verify a shorter or more recent period`);
    for (const order of page.nodes) {
      const refunds = order.refunds ?? [];
      // Past what one read returns, the order's refunds can't all be seen, so none of the period's are guessed at.
      if (refunds.length > SHOPIFY_VERIFY_REFUNDS_PER_ORDER || refunds.some((r) => r.refundLineItems?.pageInfo?.hasNextPage)) {
        return {
          subject: "refunds",
          records: [],
          basis,
          unavailable: `${saleRef(order.id)} has more than ${SHOPIFY_VERIFY_REFUNDS_PER_ORDER} refunds or a refund with more than ${SHOPIFY_VERIFY_REFUND_LINES} line items, more than the connector reads; check its refunds in Shopify`,
        };
      }
      for (const refund of refunds) {
        const lines = (refund.refundLineItems?.nodes ?? []).filter((l) => l.quantity > 0);
        if (!lines.length || !inVerifyPeriod(refund.createdAt, period)) continue;
        records.push({ ref: `shopify:refund:${legacyId(refund.id)}`, cents: lines.reduce((sum, l) => sum + (toCents(l.subtotalSet?.shopMoney?.amount) ?? 0), 0) });
      }
    }
    checkVerifyLimit(records, "Shopify");
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
    after = page.pageInfo.endCursor;
  }
  return { subject: "refunds", records, basis };
}

export async function shopifyVerify(client: ShopifyClient, period: VerifyPeriod): Promise<VerifySource[]> {
  return [await verifySales(client, period), await verifyRefunds(client, period)];
}
