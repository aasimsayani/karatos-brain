import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { shopifyClient, type ShopifyClient, type ShopifyClientOptions } from "./client.js";
import {
  customerEvents,
  orderEvents,
  productEvents,
  type ShopifyCustomer,
  type ShopifyEvent,
  type ShopifyOrder,
  type ShopifyProduct,
} from "./normalize.js";
import { shopifyWebhookEvents, type ShopifyWebhookDelivery } from "./webhooks.js";

/**
 * Reads orders (with refunds and fulfillments), products with their variants
 * and stock, and customers. Each stream is paged by `updated_at`, oldest
 * first, so the cursor can always resume exactly where the last batch ended.
 */

export const SHOPIFY_STREAMS = ["orders", "products", "customers"] as const;
export type ShopifyStream = (typeof SHOPIFY_STREAMS)[number];

/** Declared so they can be gated and audited; none runs while writes are off, and no write scope is requested. */
export const SHOPIFY_WRITES: WriteAction[] = [
  { integration: "shopify", name: "adjust_inventory", description: "Adjust a variant's available stock at a location" },
  { integration: "shopify", name: "tag_customer", description: "Add tags to a customer" },
  { integration: "shopify", name: "tag_order", description: "Add tags to an order" },
  { integration: "shopify", name: "create_draft_order", description: "Create a draft order for a customer to pay" },
  // Both change what a customer pays, so each needs a named person's approval and is capped low.
  { integration: "shopify", name: "set_variant_price", description: "Change a variant's price, such as after a move in the metal price", kind: "update", approval: "each", dailyCap: 10 },
  { integration: "shopify", name: "create_discount_code", description: "Create a single-use discount code for one customer", kind: "append", approval: "each", dailyCap: 10 },
];

const money = "shopMoney { amount currencyCode }";

// Page sizes keep each query's cost under Shopify's single-query limit of 1,000 points.
export const SHOPIFY_QUERIES: Record<ShopifyStream, { query: string; first: number }> = {
  orders: {
    first: 10,
    query: `query Orders($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt updatedAt processedAt cancelledAt sourceName
      displayFinancialStatus displayFulfillmentStatus paymentGatewayNames currencyCode
      totalPriceSet { ${money} }
      customer { id }
      lineItems(first: 50) {
        pageInfo { hasNextPage }
        nodes { id sku quantity variant { id } originalUnitPriceSet { ${money} } totalDiscountSet { ${money} } }
      }
      refunds(first: 10) {
        id createdAt
        refundLineItems(first: 50) { nodes { quantity lineItem { id sku variant { id } } subtotalSet { ${money} } } }
      }
      fulfillments(first: 10) { id status createdAt updatedAt }
    }
  }
}`,
  },
  products: {
    first: 15,
    query: `query Products($first: Int!, $after: String, $query: String) {
  products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title status vendor productType tags updatedAt
      variants(first: 50) { nodes { id sku price inventoryQuantity } }
    }
  }
}`,
  },
  customers: {
    first: 100,
    query: `query Customers($first: Int!, $after: String, $query: String) {
  customers(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { id displayName updatedAt emailMarketingConsent { marketingState } }
  }
}`,
  },
};

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface ShopifyCursor {
  /** The stream being read, or "done" once every stream finished. */
  stream: ShopifyStream | "done";
  /** Shopify's page cursor within that stream. */
  after: string | null;
  /** Lower bound on `updated_at` per stream for this pass, fixed when the pass starts. */
  since: Record<ShopifyStream, string>;
  /** Latest `updated_at` seen per stream; the next incremental pass starts there. */
  latest: Partial<Record<ShopifyStream, string>>;
}

export interface ShopifyConnectorOptions extends ShopifyClientOptions {
  /** Years of history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: ShopifyClient;
}

interface Page<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

export function parseShopifyCursor(raw: string | null): ShopifyCursor | null {
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as ShopifyCursor;
  if (!parsed || typeof parsed !== "object" || !parsed.since || !(parsed.stream === "done" || SHOPIFY_STREAMS.includes(parsed.stream))) {
    throw new Error("Shopify checkpoint is not in the expected shape");
  }
  return parsed;
}

const byStream = (value: string) => Object.fromEntries(SHOPIFY_STREAMS.map((s) => [s, value])) as Record<ShopifyStream, string>;

/** Shopify's search syntax; quotes keep the timestamp one term. */
export const updatedSince = (iso: string) => `updated_at:>='${iso}'`;

export function shopifyConnector(options: ShopifyConnectorOptions): Connector {
  const client = options.client ?? shopifyClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;

  function startPass(mode: "historical" | "incremental", previous: ShopifyCursor | null): ShopifyCursor {
    if (mode === "historical") {
      const start = new Date(now());
      start.setUTCFullYear(start.getUTCFullYear() - historyYears);
      return { stream: SHOPIFY_STREAMS[0], after: null, since: byStream(start.toISOString()), latest: {} };
    }
    const fallback = new Date(now().getTime() - lookbackHours * 3_600_000).toISOString();
    const since = Object.fromEntries(
      SHOPIFY_STREAMS.map((s) => [s, previous?.latest[s] ?? previous?.since[s] ?? fallback]),
    ) as Record<ShopifyStream, string>;
    return { stream: SHOPIFY_STREAMS[0], after: null, since, latest: { ...previous?.latest } };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseShopifyCursor(context.cursor);
    // A finished import stays finished; incremental syncs start a new pass from where the last one got to.
    if (saved?.stream === "done" && mode === "historical") return;
    let cursor: ShopifyCursor = saved === null ? startPass(mode, null) : saved.stream === "done" ? startPass(mode, saved) : saved;

    while (cursor.stream !== "done") {
      const stream: ShopifyStream = cursor.stream;
      const { query, first }: { query: string; first: number } = SHOPIFY_QUERIES[stream];
      const data: Record<ShopifyStream, Page<{ updatedAt?: string }>> = await client.query<Record<ShopifyStream, Page<{ updatedAt?: string }>>>(query, {
        first,
        after: cursor.after,
        query: updatedSince(cursor.since[stream]),
      });
      const page: Page<{ updatedAt?: string }> = data[stream];
      if (!page || !Array.isArray(page.nodes)) throw new Error(`Shopify ${stream} response has no nodes`);
      const receivedAt = now().toISOString();
      const events: ShopifyEvent[] = page.nodes.flatMap((node) => {
        if (stream === "orders") return orderEvents(node as ShopifyOrder, receivedAt);
        if (stream === "products") return productEvents(node as ShopifyProduct, receivedAt);
        return customerEvents(node as ShopifyCustomer, receivedAt);
      });

      const latest: ShopifyCursor["latest"] = { ...cursor.latest };
      for (const node of page.nodes) {
        if (node.updatedAt && (!latest[stream] || node.updatedAt > latest[stream]!)) latest[stream] = node.updatedAt;
      }
      const nextStream: ShopifyCursor["stream"] = SHOPIFY_STREAMS[SHOPIFY_STREAMS.indexOf(stream) + 1] ?? "done";
      cursor = page.pageInfo.hasNextPage && page.pageInfo.endCursor
        ? { ...cursor, after: page.pageInfo.endCursor, latest }
        : { ...cursor, stream: nextStream, after: null, latest };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "shopify",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    handleWebhook: (body) => shopifyWebhookEvents(body as ShopifyWebhookDelivery, now().toISOString()),
    writes: SHOPIFY_WRITES,
  };
}
