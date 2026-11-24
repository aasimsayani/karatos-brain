import { checkVerifyLimit, inVerifyPeriod, type VerifyPeriod, type VerifySource, type VerifySourceRecord } from "@karatos/core";
import type { SquareClient } from "./client.js";
import { SQUARE_ORDER_LOCATIONS_PER_SEARCH, SQUARE_PAGE_SIZES } from "./connector.js";
import { squareCents, squareId, squareRef, squareTime, type SquareRecord } from "./normalize.js";

/**
 * Square's own count and gross of completed orders for a period, from Search
 * Orders and the locations list, both of which the connector already reads
 * with ORDERS_READ and MERCHANT_PROFILE_READ. Square has no count call, so
 * the orders are paged and summed here, ten locations per search, every
 * location included.
 *
 * An order counts as the sales department counts it: completed, with a
 * total above zero, on the day it closed, for its total before returns. A
 * canceled order counts on neither side; returns are their own records.
 *
 * Refunds come from the same searches. Square records a return as part of
 * an order of its own, so a completed order closed in the period carries the
 * returns made that day, whatever day the original sale was. Each return
 * with lines counts once, as the sync records it, at the sum of its lines'
 * totals. The payment refunds the connector also reads from the Refunds API
 * are the money side of the same returns, which the brief doesn't count as
 * refunds, so they aren't what is checked here.
 */

const list = (body: Record<string, unknown>, field: string): SquareRecord[] =>
  Array.isArray(body[field]) ? (body[field] as unknown[]).filter((r): r is SquareRecord => r !== null && typeof r === "object") : [];

export async function squareVerify(client: SquareClient, period: VerifyPeriod): Promise<VerifySource[]> {
  const locations = [...new Set(list(await client.read("locations"), "locations").flatMap((l) => squareId(l.id) ?? []))].sort();
  const records: VerifySourceRecord[] = [];
  const returns: VerifySourceRecord[] = [];
  for (let i = 0; i < locations.length; i += SQUARE_ORDER_LOCATIONS_PER_SEARCH) {
    let cursor: string | undefined;
    for (;;) {
      const body = await client.read("ordersSearch", {
        location_ids: locations.slice(i, i + SQUARE_ORDER_LOCATIONS_PER_SEARCH),
        limit: SQUARE_PAGE_SIZES.orders,
        return_entries: false,
        query: {
          filter: { date_time_filter: { closed_at: { start_at: period.from, end_at: period.to } }, state_filter: { states: ["COMPLETED"] } },
          sort: { sort_field: "CLOSED_AT", sort_order: "ASC" },
        },
        ...(cursor ? { cursor } : {}),
      });
      for (const order of list(body, "orders")) {
        const id = squareId(order.id);
        const cents = squareCents(order.total_money);
        // Square's end_at takes the boundary itself, so the period's edges are applied here.
        if (!id || order.state !== "COMPLETED" || !inVerifyPeriod(squareTime(order.closed_at), period)) continue;
        if (cents !== null && cents > 0) records.push({ ref: squareRef("order", id), cents });
        for (const ret of list(order, "returns")) {
          const uid = squareId(ret.uid);
          const lines = list(ret, "return_line_items");
          if (!uid || !lines.length) continue;
          returns.push({ ref: squareRef("return", `${id}:${uid}`), cents: lines.reduce((sum, l) => sum + (squareCents(l.total_money) ?? 0), 0) });
        }
      }
      checkVerifyLimit(records, "Square");
      checkVerifyLimit(returns, "Square");
      cursor = typeof body.cursor === "string" && body.cursor.length > 0 ? body.cursor : undefined;
      if (!cursor) break;
    }
  }
  return [
    { subject: "sales", records, basis: "Square orders closed in the period that completed, at their total before returns, across every location" },
    { subject: "refunds", records: returns, basis: "returns in Square orders closed in the period that completed, at the sum of their returned items' totals, across every location" },
  ];
}
