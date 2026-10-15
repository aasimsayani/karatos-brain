import { createHmac, timingSafeEqual } from "node:crypto";
import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";

/**
 * A small sample connector for a fictional shop API, used to prove every
 * helper in the kit works end to end. Real connectors follow the same shape.
 */
export interface DemoShopOrder {
  id: string;
  name: string;
  email: string;
  total: string;
  currency: string;
  created_at?: string;
  updated_at: string;
}

export const DEMO_SHOP_WRITES: WriteAction[] = [
  { integration: "demo_shop", name: "tag_order", description: "Add a tag to an order" },
];

export function orderEvent(order: DemoShopOrder, receivedAt: string) {
  return {
    id: `demo_shop_order_${order.id}_${order.updated_at}`,
    type: "order.created",
    occurredAt: order.created_at,
    receivedAt,
    idempotencyKey: `order-${order.id}-${order.updated_at}`,
    payload: { ...order },
  };
}

export function demoShopConnector(fetch: typeof globalThis.fetch, now = () => "2026-01-10T00:00:00.000Z"): Connector {
  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    let cursor = context.cursor;
    // The sample API has no "since" filter, so a finished import stays finished.
    if (cursor?.startsWith("end:")) return;
    for (;;) {
      const url = new URL("https://demo-shop.example/api/orders");
      url.searchParams.set("limit", "2");
      if (cursor !== null) url.searchParams.set("page_info", cursor);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`demo shop answered ${response.status}`);
      const body = (await response.json()) as { orders: DemoShopOrder[]; next: string | null };
      const next = body.next ?? `end:${body.orders.at(-1)?.id ?? cursor ?? "start"}`;
      yield { events: body.orders.map((o) => orderEvent(o, now())), cursor: next };
      if (body.next === null) return;
      cursor = body.next;
    }
  }
  return {
    source: "demo_shop",
    historicalImport: pages,
    incrementalSync: pages,
    handleWebhook: (body) => [orderEvent(body as DemoShopOrder, now())],
    writes: DEMO_SHOP_WRITES,
  };
}

/** Checks the base64 HMAC header a delivery carries, in constant time. */
export function verifyDemoShopWebhook(secret: string, rawBody: string, header: string | undefined): boolean {
  if (header === undefined) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody, "utf8").digest("base64"));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
