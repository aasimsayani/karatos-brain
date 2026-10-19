import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  hmacSha256,
  loadRecordings,
  replayFetch,
  tamper,
  testPipeline,
  type Recording,
} from "@karatos/connector-testkit";
import {
  SHOPIFY_DEFAULT_API_VERSION,
  ShopifyApiError,
  ShopifyConfigError,
  customerEvents,
  legacyId,
  orderEvents,
  parseShopifyCursor,
  paymentMethod,
  productEvents,
  restOrder,
  shopifyClient,
  shopifyConnector,
  shopifyWebhookEvents,
  toCents,
  updatedSince,
  verifyShopifyWebhook,
  type ShopifyConnectorOptions,
  type ShopifyCursor,
  type ShopifyOrder,
} from "../src/index.js";

const recordings = await loadRecordings(fileURLToPath(new URL("./recordings/shopify-sync.json", import.meta.url)));
const SHOP = "example-store.myshopify.com";
const TOKEN = "shpat_test_not_a_real_token";
const NOW = () => new Date("2026-01-10T00:00:00Z");
const RECEIVED = "2026-01-10T00:00:00.000Z";

/** A fetch that answers from recordings and keeps each request's GraphQL variables. */
function recordingFetch(recs: Recording[] = recordings) {
  const replay = replayFetch(recs);
  const sent: { headers: Headers; variables: Record<string, unknown>; query: string }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    sent.push({ headers: new Headers(init?.headers), variables: body.variables, query: body.query });
    return replay(input, init);
  };
  return Object.assign(fetch, { sent, replay });
}

/**
 * GraphQL sends every query to one URL, so plain replay can't tell pages
 * apart. This answers by operation and page cursor instead, any number of times.
 */
const PAGES: Record<string, Recording> = {
  "Orders:": recordings[0]!,
  "Orders:eyJsYXN0X2lkIjoxMDAyfQ": recordings[1]!,
  "Products:": recordings[2]!,
  "Customers:": recordings[3]!,
};
function graphqlReplay(): typeof globalThis.fetch {
  return async (_input, init) => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { after: string | null } };
    const page = PAGES[`${query.match(/^query (\w+)/)![1]}:${variables.after ?? ""}`];
    if (!page) throw new Error(`no recorded page for ${query.slice(0, 20)} after ${variables.after}`);
    return new Response(JSON.stringify(page.response.body), { status: page.response.status, headers: { "content-type": "application/json" } });
  };
}

const connector = (fetch: typeof globalThis.fetch, extra: Partial<ShopifyConnectorOptions> = {}) =>
  shopifyConnector({ shopDomain: SHOP, accessToken: TOKEN, fetch, now: NOW, sleep: async () => {}, ...extra });

const firstOrder = () => (recordings[0]!.response.body as { data: { orders: { nodes: ShopifyOrder[] } } }).data.orders.nodes[0]!;

async function collect(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

describe("Shopify normalizers", () => {
  it("parse money and ids without floating point", () => {
    expect(toCents("1450.00")).toBe(145000);
    expect(toCents("95.5")).toBe(9550);
    expect(toCents("0.019")).toBe(1);
    expect(toCents(12)).toBe(1200);
    expect(toCents("-3.25")).toBe(-325);
    expect(toCents("abc")).toBeNull();
    expect(toCents(null)).toBeNull();
    expect(toCents(undefined)).toBeNull();
    expect(legacyId("gid://shopify/Order/1001")).toBe("1001");
    expect(legacyId(42)).toBe("42");
  });

  it("map payment gateways onto the sales department's payment methods", () => {
    expect(["shopify_payments", "gift_card", "Cash on Delivery (COD)", "cash", "affirm", "shop_pay_installments", "paypal", "manual", undefined].map(paymentMethod)).toEqual([
      "card",
      "gift_card",
      "cash",
      "cash",
      "financing",
      "financing",
      "card",
      "other",
      "other",
    ]);
  });

  it("turn a paid in-store order into its state, the sale, its refund and its fulfillment", () => {
    const events = orderEvents(firstOrder(), RECEIVED);
    expect(events.map((e) => e.type)).toEqual(["order.updated", "sale.completed", "sale.returned", "fulfillment.updated"]);
    const [state, sale, refund, fulfillment] = events;
    expect(state!.payload).toMatchObject({ orderId: "shopify:order:1001", channel: "store", totalCents: 145000, customerId: "shopify:customer:7001", linesComplete: true });
    expect(sale).toMatchObject({ idempotencyKey: "shopify:sale:1001", occurredAt: "2026-01-02T15:00:05Z" });
    expect(sale!.payload).toEqual({
      saleId: "shopify:order:1001",
      customerId: "shopify:customer:7001",
      channel: "store",
      lines: [
        { sku: "SKU-TEST-0001", quantity: 1, unitPriceCents: 120000, discountCents: 5000 },
        { sku: "SKU-TEST-0002", quantity: 2, unitPriceCents: 15000, discountCents: 0 },
      ],
      totalCents: 145000,
      payments: [{ method: "card", amountCents: 145000 }],
    });
    expect(refund!.payload).toEqual({
      saleId: "shopify:order:1001",
      returnId: "shopify:refund:3001",
      lines: [{ sku: "SKU-TEST-0002", quantity: 1, refundCents: 15000 }],
    });
    expect(fulfillment!.payload).toEqual({ orderId: "shopify:order:1001", fulfillmentId: "shopify:fulfillment:4001", status: "SUCCESS" });
  });

  it("record no sale until the money is taken, or when the lines or total can't be trusted", () => {
    const base = firstOrder();
    const types = (o: ShopifyOrder) => orderEvents(o, RECEIVED).map((e) => e.type);
    expect(types({ ...base, displayFinancialStatus: "PENDING" })).not.toContain("sale.completed");
    expect(types({ ...base, totalPriceSet: { shopMoney: { amount: "0.00" } } })).not.toContain("sale.completed");
    expect(types({ ...base, lineItems: { ...base.lineItems, pageInfo: { hasNextPage: true } } })).not.toContain("sale.completed");
    expect(types({ ...base, lineItems: { nodes: [] } })).not.toContain("sale.completed");
    const unpriced = { ...base, lineItems: { nodes: [{ ...base.lineItems.nodes[0]!, originalUnitPriceSet: { shopMoney: { amount: "n/a" } } }] } };
    expect(types(unpriced)).not.toContain("sale.completed");
  });

  it("skip refunds without lines and stand in for missing SKUs", () => {
    const base = firstOrder();
    const shippingOnly = { ...base, refunds: [{ id: "gid://shopify/Refund/3002", createdAt: "2026-01-06T00:00:00Z", refundLineItems: { nodes: [] } }], fulfillments: [] };
    expect(orderEvents(shippingOnly, RECEIVED).map((e) => e.type)).toEqual(["order.updated", "sale.completed"]);
    const noSku = { ...base, lineItems: { nodes: [{ ...base.lineItems.nodes[0]!, sku: null }, { ...base.lineItems.nodes[1]!, sku: "  ", variant: null }] } };
    const sale = orderEvents(noSku, RECEIVED).find((e) => e.type === "sale.completed")!;
    expect((sale.payload.lines as { sku: string }[]).map((l) => l.sku)).toEqual(["shopify-variant-501", "shopify-line-2"]);
  });

  it("keep only what departments need from products and customers", () => {
    const [product] = productEvents(
      {
        id: "gid://shopify/Product/8001",
        title: "Test Ring",
        status: "ACTIVE",
        vendor: null,
        productType: null,
        tags: undefined as unknown as string[],
        updatedAt: "2026-01-04T12:00:00Z",
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/509", sku: "", price: "95.50", inventoryQuantity: 0 }] },
      },
      RECEIVED,
    );
    expect(product!.payload).toEqual({
      productId: "shopify:product:8001",
      title: "Test Ring",
      status: "ACTIVE",
      vendor: null,
      productType: null,
      tags: [],
      variants: [{ variantId: "shopify:variant:509", sku: "shopify-variant-509", priceCents: 9550, inventoryQuantity: 0 }],
    });
    const [nameless] = customerEvents({ id: "gid://shopify/Customer/7002", displayName: " ", updatedAt: "2026-01-04T13:05:00Z", emailMarketingConsent: null }, RECEIVED);
    expect(nameless!.payload).toEqual({ customerId: "shopify:customer:7002", name: "Shopify customer 7002", marketingConsent: false });
  });
});

describe("Shopify connector against recorded responses", () => {
  it("ships recordings that hold only synthetic data", () => {
    assertSynthetic(recordings);
  });

  it("survives every runSync scenario: full import, replay, resume and retry", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(graphqlReplay()), expected: { ingested: 11, deadLettered: 1 } });
    expect(result.full.batches).toBe(4);
    expect(result.replay.duplicates).toBe(11);
    expect(JSON.parse(result.full.cursor!)).toMatchObject({ stream: "done", latest: { orders: "2026-01-03T16:03:00Z", products: "2026-01-04T12:00:00Z", customers: "2026-01-04T13:05:00Z" } });
  });

  it("pages each stream oldest-updated first from five years back, with the token in a header only", async () => {
    const fetch = recordingFetch();
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(fetch), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(fetch.replay.unused()).toEqual([]);
    expect(fetch.sent.map((s) => [s.query.match(/^query (\w+)/)![1], s.variables.after, s.variables.query])).toEqual([
      ["Orders", null, "updated_at:>='2021-01-10T00:00:00.000Z'"],
      ["Orders", "eyJsYXN0X2lkIjoxMDAyfQ", "updated_at:>='2021-01-10T00:00:00.000Z'"],
      ["Products", null, "updated_at:>='2021-01-10T00:00:00.000Z'"],
      ["Customers", null, "updated_at:>='2021-01-10T00:00:00.000Z'"],
    ]);
    expect(fetch.sent[0]!.headers.get("x-shopify-access-token")).toBe(TOKEN);
    expect(fetch.replay.calls[0]!.url).toBe(`https://${SHOP}/admin/api/${SHOPIFY_DEFAULT_API_VERSION}/graphql.json`);
    expect(fetch.replay.calls[0]!.url).not.toContain(TOKEN);
    expect(fetch.sent.every((s) => !/\bmutation\b/.test(s.query))).toBe(true);
  });

  it("feeds the retail departments payloads their schemas accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(replayFetch(recordings)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // Only the order with no updatedAt is dead-lettered; every department-owned payload validates.
    expect(report).toMatchObject({ ingested: 11, deadLettered: 1 });
  });

  it("leaves a finished import finished", async () => {
    const done: ShopifyCursor = { stream: "done", after: null, since: { orders: "x", products: "x", customers: "x" }, latest: {} };
    const fetch = recordingFetch([]);
    expect(await collect(connector(fetch).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) }))).toEqual([]);
    expect(fetch.sent).toEqual([]);
  });

  it("syncs incrementally from where the last pass got to, or a lookback window on first run", async () => {
    const done: ShopifyCursor = {
      stream: "done",
      after: null,
      since: { orders: "2026-01-01T00:00:00Z", products: "2026-01-01T00:00:00Z", customers: "2026-01-01T00:00:00Z" },
      latest: { orders: "2026-01-03T16:03:00Z" },
    };
    const fetch = recordingFetch();
    const batches = await collect(connector(fetch).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(done) }));
    expect(batches).toHaveLength(4);
    expect(fetch.sent.map((s) => s.variables.query)).toEqual([
      updatedSince("2026-01-03T16:03:00Z"),
      updatedSince("2026-01-03T16:03:00Z"),
      updatedSince("2026-01-01T00:00:00Z"),
      updatedSince("2026-01-01T00:00:00Z"),
    ]);

    const first = recordingFetch();
    await collect(connector(first, { incrementalLookbackHours: 24 }).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(first.sent[0]!.variables.query).toBe(updatedSince("2026-01-09T00:00:00.000Z"));
  });

  it("refuses a checkpoint it didn't write, and a response without nodes", async () => {
    expect(() => parseShopifyCursor('{"stream":"invoices","since":{}}')).toThrow("Shopify checkpoint is not in the expected shape");
    expect(() => parseShopifyCursor("null")).toThrow("Shopify checkpoint is not in the expected shape");
    const empty = recordingFetch([{ request: recordings[0]!.request, response: { status: 200, body: { data: { orders: null } } } }]);
    await expect(collect(connector(empty).historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow("Shopify orders response has no nodes");
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const audit = await assertWritesRefused(connector(replayFetch([])));
    expect(audit.map((e) => [e.action, e.outcome])).toEqual([
      ["adjust_inventory", "refused"],
      ["tag_customer", "refused"],
      ["tag_order", "refused"],
      ["create_draft_order", "refused"],
    ]);
  });
});

describe("Shopify client", () => {
  const throttled = (available: number): Recording => ({
    request: recordings[0]!.request,
    response: {
      status: 200,
      body: {
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        extensions: { cost: { requestedQueryCost: 312, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: available, restoreRate: 100 } } },
      },
    },
  });

  it("checks its settings before sending anything", () => {
    expect(() => shopifyClient({ shopDomain: "example-store.com", accessToken: TOKEN })).toThrow(ShopifyConfigError);
    expect(() => shopifyClient({ shopDomain: SHOP, accessToken: "" })).toThrow("set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET, or SHOPIFY_ADMIN_ACCESS_TOKEN");
    expect(() => shopifyClient({ shopDomain: SHOP, clientId: "id" })).toThrow("set both SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET");
    expect(() => shopifyClient({ shopDomain: SHOP, clientSecret: "secret", accessToken: TOKEN })).toThrow("set both");
    expect(() => shopifyClient({ shopDomain: SHOP, accessToken: TOKEN, apiVersion: "latest" })).toThrow("SHOPIFY_API_VERSION must look like 2026-07");
    expect(shopifyClient({ shopDomain: " Example-Store.myshopify.com ", accessToken: TOKEN, apiVersion: "2026-10" }).endpoint).toBe(
      "https://example-store.myshopify.com/admin/api/2026-10/graphql.json",
    );
  });

  describe("signing in with a Dev Dashboard app", () => {
    const ID = "test-client-id";
    const SECRET = "test-client-secret";
    // A fake Shopify: the token endpoint grants numbered tokens, GraphQL answers 401 for a revoked one.
    function fakeShopify(grant: (n: number) => { status: number; body: unknown } = (n) => ({ status: 200, body: { access_token: `granted-${n}`, scope: "read_orders", expires_in: 86399 } })) {
      const calls: { url: string; token?: string; body: string }[] = [];
      const revoked = new Set<string>();
      let grants = 0;
      const fetch = (async (url: string | URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url: String(url), body: String(init?.body ?? ""), ...(headers["x-shopify-access-token"] ? { token: headers["x-shopify-access-token"] } : {}) });
        if (String(url).endsWith("/admin/oauth/access_token")) {
          const answer = grant(++grants);
          return new Response(JSON.stringify(answer.body), { status: answer.status });
        }
        if (revoked.has(headers["x-shopify-access-token"]!)) return new Response(JSON.stringify({ errors: "[API] Invalid API key or access token" }), { status: 401 });
        return new Response(JSON.stringify({ data: { shop: { name: "Example" } } }), { status: 200 });
      }) as typeof globalThis.fetch;
      return { fetch, calls, revoked };
    }

    it("exchanges the client ID and secret for a token, reuses it, and renews it before it expires", async () => {
      const shopify = fakeShopify();
      let now = 0;
      const client = shopifyClient({ shopDomain: SHOP, clientId: ID, clientSecret: SECRET, fetch: shopify.fetch, clock: () => now });
      await client.query("query { shop { name } }", {});
      await client.query("query { shop { name } }", {});
      expect(shopify.calls.map((c) => c.url)).toEqual([`https://${SHOP}/admin/oauth/access_token`, client.endpoint, client.endpoint]);
      expect(new URLSearchParams(shopify.calls[0]!.body).get("grant_type")).toBe("client_credentials");
      expect(new URLSearchParams(shopify.calls[0]!.body).get("client_id")).toBe(ID);
      expect(shopify.calls[0]!.token).toBeUndefined();
      expect(shopify.calls.slice(1).map((c) => c.token)).toEqual(["granted-1", "granted-1"]);
      // Renewed five minutes before the 24 hours run out.
      now = (86_399 - 299) * 1000;
      await client.query("query { shop { name } }", {});
      expect(shopify.calls.at(-1)!.token).toBe("granted-2");
    });

    it("asks for a new token once when Shopify revokes the current one", async () => {
      const shopify = fakeShopify();
      const client = shopifyClient({ shopDomain: SHOP, clientId: ID, clientSecret: SECRET, fetch: shopify.fetch });
      await client.query("query { shop { name } }", {});
      shopify.revoked.add("granted-1");
      await expect(client.query("query { shop { name } }", {})).resolves.toEqual({ shop: { name: "Example" } });
      expect(shopify.calls.at(-1)!.token).toBe("granted-2");
      shopify.revoked.add("granted-2").add("granted-3");
      await expect(client.query("query { shop { name } }", {})).rejects.toMatchObject({ status: 401 });
    });

    it("explains a refused grant without echoing the secret", async () => {
      const refused = fakeShopify(() => ({ status: 400, body: { error: "shop_not_permitted", error_description: "x" } }));
      const client = shopifyClient({ shopDomain: SHOP, clientId: ID, clientSecret: SECRET, fetch: refused.fetch });
      const error = await client.query("query { shop { name } }", {}).catch((e: unknown) => e);
      expect(error).toMatchObject({ name: "ShopifyApiError", status: 400, code: "shop_not_permitted" });
      expect(String((error as Error).message)).not.toContain(SECRET);
      const garbled = fakeShopify(() => ({ status: 200, body: {} }));
      await expect(shopifyClient({ shopDomain: SHOP, clientId: ID, clientSecret: SECRET, fetch: garbled.fetch }).query("query { a }", {})).rejects.toThrow(
        "Shopify refused the client credentials grant (HTTP 200)",
      );
    });

    it("runs the full recorded sync signed in this way, with the granted token on every page", async () => {
      const shopify = fakeShopify();
      const pages = graphqlReplay();
      const tokens: (string | undefined)[] = [];
      // Token requests go to the fake grant; GraphQL pages replay the recordings.
      const fetch = (async (url: string | URL, init?: RequestInit) => {
        if (String(url).endsWith("/admin/oauth/access_token")) return shopify.fetch(url, init);
        tokens.push(((init?.headers ?? {}) as Record<string, string>)["x-shopify-access-token"]);
        return pages(url, init);
      }) as typeof globalThis.fetch;
      const result = await checkConnectorSync({
        makeConnector: () => shopifyConnector({ shopDomain: SHOP, clientId: ID, clientSecret: SECRET, fetch, now: NOW, sleep: async () => {} }),
        expected: { ingested: 11, deadLettered: 1 },
      });
      expect(result.full.batches).toBe(4);
      // Every page carried a granted token, and each connector reused its token instead of asking per page.
      expect(tokens.every((t) => /^granted-\d+$/.test(t ?? ""))).toBe(true);
      const grants = shopify.calls.filter((c) => c.url.endsWith("/admin/oauth/access_token")).length;
      expect(grants).toBeGreaterThan(0);
      expect(grants).toBeLessThan(tokens.length);
    });
  });

  it("only sends queries", async () => {
    const client = shopifyClient({ shopDomain: SHOP, accessToken: TOKEN, fetch: replayFetch([]) });
    await expect(client.query("mutation { tagsAdd(id: \"x\", tags: []) { userErrors { message } } }", {})).rejects.toThrow("only sends queries");
  });

  it("waits for the cost bucket to refill when throttled, then gives the error to runSync", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const ok = recordings[0]!;
    const client = shopifyClient({ shopDomain: SHOP, accessToken: TOKEN, fetch: replayFetch([throttled(12), ok]), sleep });
    await expect(client.query("query { shop { name } }", {})).resolves.toHaveProperty("orders");
    expect(waits).toEqual([3000]);

    const stuck = shopifyClient({ shopDomain: SHOP, accessToken: TOKEN, fetch: replayFetch([throttled(311), throttled(311), throttled(311)]), sleep, throttleRetries: 2 });
    await expect(stuck.query("query { shop { name } }", {})).rejects.toMatchObject({ name: "ShopifyApiError", code: "THROTTLED", status: 200 });
    expect(waits.slice(1)).toEqual([1000, 1000]);

    const bare = { ...throttled(0), response: { status: 200, body: { errors: [{ extensions: { code: "THROTTLED" } }] } } };
    const noCost = shopifyClient({ shopDomain: SHOP, accessToken: TOKEN, fetch: replayFetch([bare, ok]), sleep });
    await noCost.query("query { shop { name } }", {});
    expect(waits.at(-1)).toBe(2000);
  });

  it("reports HTTP and GraphQL errors without echoing the token", async () => {
    const answer = (status: number, body: unknown): Recording => ({ request: recordings[0]!.request, response: { status, body } });
    const client = (rec: Recording) => shopifyClient({ shopDomain: SHOP, accessToken: TOKEN, fetch: replayFetch([rec]) });
    const unauthorized = client(answer(401, { errors: "[API] Invalid API key or access token" })).query("query { shop { name } }", {});
    await expect(unauthorized).rejects.toBeInstanceOf(ShopifyApiError);
    await expect(client(answer(401, { errors: "x" })).query("query { a }", {})).rejects.toMatchObject({ status: 401, message: expect.not.stringContaining(TOKEN) });
    await expect(client(answer(200, { errors: [{ message: "Field 'nope' doesn't exist" }] })).query("query { a }", {})).rejects.toThrow("Shopify GraphQL error: Field 'nope' doesn't exist");
    await expect(client(answer(200, { errors: [{}] })).query("query { a }", {})).rejects.toThrow("Shopify GraphQL error: unknown");
    await expect(client(answer(200, {})).query("query { a }", {})).rejects.toThrow("Shopify answered without data");
  });

  it("retries a failing page through runSync", async () => {
    const failing: Recording = { request: recordings[0]!.request, response: { status: 503, body: "" } };
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(replayFetch([failing, ...recordings])), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: async () => {} });
    expect(report.ingested).toBe(11);
  });
});

describe("Shopify webhooks", () => {
  const secret = "test-client-secret";
  const restPaid = {
    id: 1001,
    name: "#1001",
    created_at: "2026-01-02T15:00:00Z",
    updated_at: "2026-01-02T16:01:00Z",
    processed_at: "2026-01-02T15:00:05Z",
    cancelled_at: null,
    source_name: "pos",
    financial_status: "partially_refunded",
    fulfillment_status: "fulfilled",
    payment_gateway_names: ["shopify_payments"],
    currency: "USD",
    total_price: "1450.00",
    customer: { id: 7001 },
    line_items: [
      { id: 1, sku: "SKU-TEST-0001", variant_id: 501, quantity: 1, price: "1200.00", total_discount: "50.00" },
      { id: 2, sku: "SKU-TEST-0002", variant_id: 502, quantity: 2, price: "150.00" },
    ],
    refunds: [{ id: 3001, created_at: "2026-01-05T10:00:00Z", refund_line_items: [{ quantity: 1, line_item: { id: 2, sku: "SKU-TEST-0002", variant_id: 502 }, subtotal: "150.00" }] }],
    fulfillments: [{ id: 4001, status: "success", created_at: "2026-01-03T09:00:00Z", updated_at: "2026-01-03T09:00:00Z" }],
  };

  it("accepts a valid signature and rejects tampered, unsigned or wrongly keyed deliveries", () => {
    const body = JSON.stringify(restPaid);
    const signature = hmacSha256(secret, body, "base64");
    expect(verifyShopifyWebhook(secret, body, signature)).toBe(true);
    expect(verifyShopifyWebhook(secret, Buffer.from(body), signature)).toBe(true);
    expect(verifyShopifyWebhook(secret, tamper(body), signature)).toBe(false);
    expect(verifyShopifyWebhook("another-secret", body, signature)).toBe(false);
    expect(verifyShopifyWebhook(secret, body, undefined)).toBe(false);
    expect(verifyShopifyWebhook("", body, signature)).toBe(false);
    expect(verifyShopifyWebhook(secret, body, "not-base64!")).toBe(false);
  });

  it("produces the same events as the sync for the same order, so a webhook after a sync is a duplicate", () => {
    const fromWebhook = shopifyWebhookEvents({ topic: "orders/updated", payload: restPaid }, RECEIVED);
    const fromSync = orderEvents(firstOrder(), RECEIVED);
    expect(fromWebhook.map((e) => e.idempotencyKey)).toEqual(fromSync.map((e) => e.idempotencyKey));
    expect(fromWebhook.find((e) => e.type === "sale.completed")!.payload).toEqual(fromSync.find((e) => e.type === "sale.completed")!.payload);
  });

  it("counts a replayed delivery as a duplicate", async () => {
    const { memory, pipeline } = testPipeline();
    const shopify = connector(replayFetch([]));
    const ingest = async () => {
      const results = [];
      for (const e of shopify.handleWebhook!({ topic: "orders/paid", payload: restPaid })) {
        results.push(await pipeline.ingest({ ...(e as object), organizationId: TEST_ORG, source: "shopify" }));
      }
      return results.map((r) => r.duplicate);
    };
    expect(await ingest()).toEqual([false, false, false, false]);
    expect(await ingest()).toEqual([true, true, true, true]);
    void memory;
  });

  it("reads refunds, products and customers, and ignores topics it doesn't read", () => {
    const refund = shopifyWebhookEvents({ topic: "refunds/create", payload: { ...restPaid.refunds[0], order_id: 1001 } }, RECEIVED);
    expect(refund.map((e) => [e.type, e.idempotencyKey])).toEqual([["sale.returned", "shopify:refund:3001"]]);

    const [product] = shopifyWebhookEvents(
      { topic: "products/update", payload: { id: 8001, title: "Test Ring", status: "active", tags: "bridal, 14k", updated_at: "2026-01-04T12:00:00Z", variants: [{ id: 501, sku: "SKU-TEST-0001", price: "1200.00", inventory_quantity: 3 }] } },
      RECEIVED,
    );
    expect(product!.payload).toMatchObject({ productId: "shopify:product:8001", status: "ACTIVE", tags: ["bridal", "14k"], variants: [{ sku: "SKU-TEST-0001", priceCents: 120000, inventoryQuantity: 3 }] });

    const [customer] = shopifyWebhookEvents(
      { topic: "customers/update", payload: { id: 7001, first_name: "Test", last_name: "Customer", updated_at: "2026-01-04T13:00:00Z", email_marketing_consent: { state: "subscribed" } } },
      RECEIVED,
    );
    expect(customer!.payload).toEqual({ customerId: "shopify:customer:7001", name: "Test Customer", marketingConsent: true });
    expect(shopifyWebhookEvents({ topic: "customers/update", payload: { id: 7003, updated_at: "2026-01-04T13:00:00Z" } }, RECEIVED)[0]!.payload).toMatchObject({ marketingConsent: false, name: "Shopify customer 7003" });

    expect(shopifyWebhookEvents({ topic: "app/uninstalled", payload: {} }, RECEIVED)).toEqual([]);
  });

  it("fills REST gaps with Shopify's defaults", () => {
    const order = restOrder({ id: 5, total_price: "10.00", line_items: [{ id: 9, quantity: 1, price: 10 }] });
    expect(order).toMatchObject({ displayFinancialStatus: null, displayFulfillmentStatus: "UNFULFILLED", customer: null, paymentGatewayNames: [], refunds: [], fulfillments: [] });
    expect(order.lineItems.nodes[0]).toMatchObject({ sku: null, variant: null, totalDiscountSet: { shopMoney: { amount: "0.00" } } });
    const product = shopifyWebhookEvents({ topic: "products/create", payload: { id: 1, title: "T", updated_at: "2026-01-04T12:00:00Z" } }, RECEIVED)[0]!;
    expect(product.payload).toMatchObject({ status: "ACTIVE", tags: [], variants: [] });
    const fulfilled = restOrder({ id: 6, fulfillments: [{ id: 7, created_at: "2026-01-03T09:00:00Z" }], refunds: [{ id: 8 }] });
    expect(fulfilled.fulfillments[0]).toMatchObject({ status: "SUCCESS", updatedAt: "2026-01-03T09:00:00Z" });
    expect(fulfilled.refunds[0]!.refundLineItems.nodes).toEqual([]);
    expect(shopifyWebhookEvents({ topic: "orders/create", payload: undefined as unknown as Record<string, unknown> }, RECEIVED)[0]!.type).toBe("order.updated");
  });
});
