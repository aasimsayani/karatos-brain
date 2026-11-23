import { checkVerifyLimit, inVerifyPeriod, type VerifyPeriod, type VerifySource, type VerifySourceRecord } from "@karatos/core";
import type { ShopifyClient } from "./client.js";
import { saleRef, SHOPIFY_PAID_STATUSES, toCents } from "./normalize.js";

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

export async function shopifyVerify(client: ShopifyClient, period: VerifyPeriod): Promise<VerifySource[]> {
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
  return [{ subject: "sales", records, basis: "Shopify orders processed in the period that are paid, partly paid or refunded, at their original total" }];
}
