import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  TEST_ORG,
  UndocumentedRequestError,
  WIX_MOCK_API,
  WIX_READ_ONLY_PERMISSIONS,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  testPipeline,
  wixContact,
  wixDocMock,
  wixInventoryItem,
  wixOrder,
  wixProductV1,
  wixProductV3,
  wixTestId,
  wixVariantV3,
  type WixMock,
  type WixMockData,
  type WixMockRecord,
} from "@karatos/connector-testkit";
import {
  WIX_CUSTOMER_PREFIX,
  WIX_MAX_WEBHOOK_BYTES,
  WIX_OVERLAP_MS,
  WIX_ROUTES,
  WIX_STALE_DELIVERY_MS,
  WIX_WRITES,
  WixApiError,
  WixConfigError,
  WixCustomerKeyError,
  WixReplayGuard,
  isWixReadPermission,
  parseWixCursor,
  verifyWixWebhook,
  wixCents,
  wixClient,
  wixConnector,
  wixContactEvent,
  wixCustomerRef,
  wixId,
  wixInventoryItemEvents,
  wixOrderEvents,
  wixProductV1Events,
  wixProductV3Events,
  wixQuantity,
  wixTime,
  wixWebhookEvents,
  wixWebhookKey,
  type WixConnectorOptions,
  type WixContext,
  type WixCursor,
  type WixRoute,
  type WixWebhookDelivery,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const APP_ID = wixTestId("abcd", 7);
const SECRET = ["app", "secret", "s".repeat(24)].join("-");
const INSTANCE = wixTestId("cafe", 1);
const OTHER_INSTANCE = wixTestId("cafe", 2);
const REF_KEY = ["customer", "ref", "key", "0".repeat(40)].join("-");
const OTHER_REF_KEY = ["customer", "ref", "key", "1".repeat(40)].join("-");
const NOW = () => new Date("2026-01-20T00:00:00.000Z");
const RECEIVED = "2026-01-20T00:00:00.000Z";
const START = "2000-01-01T00:00:00.000Z";
const FIVE_YEARS = "2021-01-20T00:00:00.000Z";
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;

const reset = () => {
  for (const b of [wixOrder, wixProductV3, wixVariantV3, wixInventoryItem, wixProductV1, wixContact]) b.reset();
};
const app = (permissions = WIX_READ_ONLY_PERMISSIONS, instanceId = INSTANCE) => ({ [APP_ID]: { secret: SECRET, instanceId, permissions } });

/** A refunded line: two rings at $12 each after tax, one refunded. */
const refundedLine = (n: number) => ({
  id: wixTestId("abab", 100 + n),
  catalogReference: { catalogItemId: wixTestId("bbbb", n), options: { variantId: wixTestId("cccc", n) } },
  quantity: 2,
  price: { amount: "12.00" },
  priceBeforeDiscounts: { amount: "12.00" },
  totalDiscount: { amount: "0" },
  totalPriceAfterTax: { amount: "24.00" },
  physicalProperties: { sku: "SKU-TEST-0099" },
  refundQuantity: 1,
});

/** A small synthetic site. See the sync test for what each record gives. */
function site(overrides: Partial<WixMockData> = {}): WixMockData {
  reset();
  return {
    apps: app(),
    catalogVersion: "V3_CATALOG",
    productsV3: [wixProductV3.one(), wixProductV3.one({ visible: false })],
    variantsV3: [wixVariantV3.one(), wixVariantV3.one()],
    inventoryItems: [wixInventoryItem.one(), wixInventoryItem.one({ trackQuantity: false }), wixInventoryItem.one({ quantity: -2 })],
    orders: [
      wixOrder.one(),
      wixOrder.one({ status: "PENDING", paymentStatus: "NOT_PAID" }),
      wixOrder.one({ paymentStatus: "PARTIALLY_REFUNDED", priceSummary: { total: { amount: "24.00" } }, lineItems: [refundedLine(3)] }),
      wixOrder.one({ status: "INITIALIZED", paymentStatus: "NOT_PAID" }),
      wixOrder.one({ updatedDate: "2020-06-01T00:00:00.000Z" }),
      wixOrder.one({ status: "REJECTED" }),
    ],
    contacts: [wixContact.one(), wixContact.one()],
    ...overrides,
  };
}

const options = (mock: WixMock, extra: Partial<WixConnectorOptions> = {}): WixConnectorOptions => ({
  appId: APP_ID,
  appSecret: SECRET,
  instanceId: INSTANCE,
  customerKey: REF_KEY,
  fetch: mock.fetch,
  sleep: async () => {},
  random: () => 0,
  now: NOW,
  ...extra,
});
const connector = (mock: WixMock, extra: Partial<WixConnectorOptions> = {}) => wixConnector(options(mock, extra));

interface Sent {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}
/** A fetch that keeps each request's path and body (the mock keeps only method and URL), with a hook before it is answered. */
function recording(mock: WixMock, before?: (sent: Sent) => void): { fetch: typeof globalThis.fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const one: Sent = { method: init?.method ?? "GET", path: new URL(String(input)).pathname, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined };
    sent.push(one);
    before?.(one);
    return mock.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const dataReads = (sent: Sent[]) => sent.filter((s) => s.path !== "/oauth2/token" && s.path !== "/apps/v1/instance");
const paths = (mock: WixMock) => mock.fetch.calls.map((c) => new URL(c.url).pathname);

const ctx = (key = REF_KEY, instance = INSTANCE): WixContext => ({ receivedAt: RECEIVED, customerRef: (id) => wixCustomerRef(key, instance, id) });

describe("Wix client", () => {
  it("sends only the listed reads, and stops anything else before a request is made", async () => {
    const mock = wixDocMock(site());
    const client = wixClient(options(mock));
    const tries: [string, Record<string, unknown> | undefined][] = [
      ["deleteProduct", undefined],
      ["toString", undefined],
      ["orders", { search: {}, fieldsets: ["FULL"] }],
      ["orders", { search: { filter: {}, fieldsets: [] } }],
      ["orders", { search: [] }],
      ["productsV3", { query: {}, fields: ["URL"] }],
      ["productsV1", { query: { cursorPaging: {} } }],
      ["productsV1", { query: {}, includeVariants: false }],
      ["contacts", [] as unknown as Record<string, unknown>],
    ];
    for (const [route, body] of tries) await expect(client.read(route as WixRoute, body), route).rejects.toBeInstanceOf(WixConfigError);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("lists only GET and POST reads, each one a route the docs list", () => {
    const documented = new Set(wixDocMock({}).api.routes.map((r) => `${r.method} ${r.path}`));
    for (const [name, route] of Object.entries(WIX_ROUTES)) {
      expect(documented.has(`${route.method} ${route.path}`), name).toBe(true);
      if (route.method === "POST") expect(route.path, name).toMatch(/\/(query|search|query-variants)$/);
      else expect(route.method, name).toBe("GET");
    }
  });

  it("stops before reading data when the app holds any manage or write permission", async () => {
    for (const extra of ["SCOPE.DC-STORES.MANAGE-PRODUCTS", "SCOPE.STORES.PRODUCT_WRITE", "SCOPE.ECOM.MODIFY-ORDERS", "SCOPE.CRM.EDIT-CONTACTS", "SCOPE.DC-CONTACTS.MANAGE-CONTACTS", "WIX_DEVELOPERS.READ_AND_REFUND", "SCOPE.ECOM.READ-ORDERS.UPDATE"]) {
      const mock = wixDocMock(site({ apps: app([...WIX_READ_ONLY_PERMISSIONS, extra]) }));
      const { fetch, sent } = recording(mock);
      const client = wixClient(options(mock, { fetch }));
      await expect(client.read("orders", { search: {} })).rejects.toThrow(new RegExp(`holds ${extra.replace(/[.]/g, "\\.")}`));
      expect(sent.map((s) => s.path)).toEqual(["/oauth2/token", "/apps/v1/instance"]);
    }
    // An unreadable entry counts as a write, and is never echoed.
    const odd = wixDocMock(site({ apps: app([...WIX_READ_ONLY_PERMISSIONS, "scope with spaces <script>", 42 as unknown as string]) }));
    await expect(wixClient(options(odd)).read("contacts", {})).rejects.toThrow("holds an unreadable permission, an unreadable permission;");
    // Many: three are named.
    const many = wixDocMock(site({ apps: app([...WIX_READ_ONLY_PERMISSIONS, "A.WRITE", "B.WRITE", "C.WRITE", "D.WRITE"]) }));
    await expect(wixClient(options(many)).read("contacts", {})).rejects.toThrow("A.WRITE, B.WRITE, C.WRITE and more");
  });

  it("recognises read permissions only", () => {
    for (const p of WIX_READ_ONLY_PERMISSIONS) expect(isWixReadPermission(p), p).toBe(true);
    expect(isWixReadPermission(" scope.dc-stores.read-orders ")).toBe(true);
    for (const p of ["SCOPE.STORES.PRODUCT_WRITE", "SCOPE.DC-STORES.MANAGE-ORDERS", "SCOPE.STORES.INVENTORY", "SCOPE.ECOM.CREATE", "", "READ".repeat(30), "SCOPE READ", 7, null]) {
      expect(isWixReadPermission(p), String(p)).toBe(false);
    }
  });

  it("stops when Wix doesn't list the permissions, or answers for another instance", async () => {
    const fake = (instance: Record<string, unknown>) =>
      (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path === "/oauth2/token") return Response.json({ access_token: "t".repeat(32), expires_in: 14_400 });
        if (path === "/apps/v1/instance") return Response.json({ instance });
        throw new Error(`unexpected ${path}`);
      }) as typeof globalThis.fetch;
    const base = { appId: APP_ID, appSecret: SECRET, instanceId: INSTANCE, sleep: async () => {} };
    await expect(wixClient({ ...base, fetch: fake({ instanceId: INSTANCE }) }).checkPermissions()).rejects.toThrow("didn't say which permissions");
    await expect(wixClient({ ...base, fetch: fake({ instanceId: OTHER_INSTANCE, permissions: [] }) }).checkPermissions()).rejects.toThrow("different app instance");
    // A failed check is asked again next time rather than cached.
    let calls = 0;
    const flaky = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/oauth2/token") return Response.json({ access_token: "t".repeat(32) });
      calls++;
      return calls === 1 ? Response.json({ message: "boom" }, { status: 500 }) : Response.json({ instance: { permissions: ["SCOPE.DC-STORES.READ-ORDERS"] } });
    }) as typeof globalThis.fetch;
    const client = wixClient({ ...base, fetch: flaky });
    await expect(client.checkPermissions()).rejects.toThrow("HTTP 500");
    await expect(client.checkPermissions()).resolves.toEqual(["SCOPE.DC-STORES.READ-ORDERS"]);
    await client.checkPermissions();
    expect(calls).toBe(2);
  });

  it("checks its settings before any request", () => {
    const mock = wixDocMock(site());
    expect(() => wixClient(options(mock, { appId: "not-a-guid" }))).toThrow("WIX_APP_ID");
    expect(() => wixClient(options(mock, { appSecret: "short" }))).toThrow("WIX_APP_SECRET");
    expect(() => wixClient(options(mock, { appSecret: "has a space in the middle of it" }))).toThrow("WIX_APP_SECRET");
    expect(() => wixClient(options(mock, { instanceId: "" }))).toThrow("WIX_INSTANCE_ID");
    expect(() => wixClient(options(mock, { appId: undefined as unknown as string }))).toThrow("WIX_APP_ID");
    expect(() => wixConnector(options(mock, { customerKey: "short" }))).toThrow(WixCustomerKeyError);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("explains a refused token without echoing the secret", async () => {
    const wrong = ["wrong", "secret", "w".repeat(24)].join("-");
    const mock = wixDocMock(site());
    const error = await wixClient(options(mock, { appSecret: wrong })).read("contacts", {}).catch((e: unknown) => e as WixApiError);
    expect(error).toBeInstanceOf(WixApiError);
    expect(error.message).toContain("WIX_APP_SECRET");
    expect(error.message).toContain("invalid_client");
    expect(error.message).not.toContain(wrong);
    // The wrong instance is a 400 from the token endpoint, explained the same way.
    const other = await wixClient(options(mock, { instanceId: OTHER_INSTANCE })).read("contacts", {}).catch((e: unknown) => e as WixApiError);
    expect(other.message).toContain("WIX_INSTANCE_ID");
    // A token answer without a token.
    const empty = (async () => Response.json({ expires_in: 10 })) as typeof globalThis.fetch;
    await expect(wixClient({ ...options(mock), fetch: empty }).checkPermissions()).rejects.toThrow("refused the app's token request (HTTP 200)");
  });

  it("explains a missing read permission and reports Wix's error code", async () => {
    const mock = wixDocMock(site({ apps: app(WIX_READ_ONLY_PERMISSIONS.filter((p) => p !== "SCOPE.DC-CONTACTS.READ-CONTACTS")) }));
    const error = await wixClient(options(mock)).read("contacts", { query: {} }).catch((e: unknown) => e as WixApiError);
    expect([error.status, error.code]).toEqual([403, "PERMISSION_DENIED"]);
    expect(error.message).toContain("Permissions page");
  });

  it("renews the token five minutes before it lapses, and once when Wix answers 401", async () => {
    const mock = wixDocMock(site());
    let now = Date.parse("2026-01-20T00:00:00Z");
    const { fetch, sent } = recording(mock);
    const client = wixClient(options(mock, { fetch, clock: () => now }));
    await client.read("catalogVersion");
    await client.read("catalogVersion");
    now += 4 * 3_600_000 - 4 * 60_000;
    await client.read("catalogVersion");
    expect(sent.filter((s) => s.path === "/oauth2/token")).toHaveLength(2);
    // The app was reinstalled: every token so far is gone.
    mock.tokens.clear();
    await expect(client.read("catalogVersion")).resolves.toEqual({ catalogVersion: "V3_CATALOG" });
    expect(sent.filter((s) => s.path === "/oauth2/token")).toHaveLength(3);
    // Still 401 after renewing: the error goes up.
    const revoked = (async (input: string | URL | Request) =>
      new URL(String(input)).pathname === "/oauth2/token" ? Response.json({ access_token: "t".repeat(32), expires_in: 99_999_999 }) : Response.json({}, { status: 401 })) as typeof globalThis.fetch;
    await expect(wixClient({ ...options(mock), fetch: revoked }).checkPermissions()).rejects.toThrow("HTTP 401");
  });

  it("waits on 429 with Retry-After or backoff, then hands the error on", async () => {
    const waits: number[] = [];
    const mock = wixDocMock(site({ rateLimits: [{ retryAfter: 2 }, {}, { retryAfter: 600 }] }));
    const client = wixClient(options(mock, { sleep: async (ms) => void waits.push(ms), random: () => 0.5 }));
    await expect(client.read("catalogVersion")).resolves.toEqual({ catalogVersion: "V3_CATALOG" });
    expect(waits).toEqual([2000, 2500, 60_000]);
    const busy = wixDocMock(site({ rateLimits: [{}, {}, {}] }));
    const error = await wixClient(options(busy, { rateLimitRetries: 2 })).read("catalogVersion").catch((e: unknown) => e as WixApiError);
    expect([error.status, error.code]).toEqual([429, "rate_limited"]);
  });

  it("never follows a redirect", async () => {
    const mock = wixDocMock(site({ redirectTo: "https://attacker.example.test/" }));
    const error = await wixClient(options(mock)).read("catalogVersion").catch((e: unknown) => e as WixApiError);
    expect([error.status, error.code]).toEqual([302, "redirect"]);
    expect(paths(mock)).toEqual(["/oauth2/token", "/apps/v1/instance"]);
    // And asks fetch not to follow one either, so the token never reaches another host.
    const modes: (RequestRedirect | undefined)[] = [];
    const watching = (async (input: string | URL | Request, init?: RequestInit) => {
      modes.push(init?.redirect);
      return mock.fetch(input, init);
    }) as typeof globalThis.fetch;
    await wixClient(options(mock, { fetch: watching })).read("catalogVersion").catch(() => undefined);
    expect(modes).toEqual(["manual", "manual"]);
  });

  it("stops on an answer that isn't a JSON object", async () => {
    const odd = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/oauth2/token") return Response.json({ access_token: "t".repeat(32) });
      if (path === "/apps/v1/instance") return Response.json({ instance: { permissions: [] } });
      return new Response("[]", { status: 200 });
    }) as typeof globalThis.fetch;
    await expect(wixClient({ ...options(wixDocMock({})), fetch: odd }).read("catalogVersion")).rejects.toThrow("with an object");
  });
});

describe("Wix normalizing", () => {
  it("reads Wix times, amounts and counts, and nothing else", () => {
    expect(wixTime("2026-01-01T10:00:00.123456Z")).toBe("2026-01-01T10:00:00.123Z");
    expect(wixTime("2026-01-01T10:00:00-05:00")).toBe("2026-01-01T15:00:00.000Z");
    for (const bad of ["2026-01-01", "2026-01-01T10:00:00", "2026-13-01T10:00:00Z", "", "x".repeat(41), 7]) expect(wixTime(bad)).toBeUndefined();
    expect(wixCents("125.50")).toBe(12_550);
    expect(wixCents("0.005")).toBe(1);
    expect(wixCents(12.5)).toBe(1250);
    expect(wixCents("-3.10")).toBe(-310);
    expect(wixCents("-0.00")).toBe(0);
    for (const bad of ["1e5", "12,50", "", Number.NaN, null, "1".repeat(25)]) expect(wixCents(bad)).toBeNull();
    expect([wixQuantity(3), wixQuantity(1.5), wixQuantity("3")]).toEqual([3, null, null]);
    expect([wixId(wixTestId("aaaa", 1)), wixId("a/b"), wixId("a".repeat(65)), wixId(5)]).toEqual([wixTestId("aaaa", 1), undefined, undefined, undefined]);
  });

  it("turns a paid order into its state and a sale, keeping no personal data", () => {
    reset();
    const order = wixOrder.one();
    const events = wixOrderEvents(order, ctx());
    expect(events.map((e) => e.type)).toEqual(["order.updated", "sale.completed"]);
    const customerId = wixCustomerRef(REF_KEY, INSTANCE, wixTestId("eeee", 1));
    expect(events[0]).toEqual({
      id: `wix_order:${order.id}:2026-01-01T00:15:00.000Z`,
      type: "order.updated",
      occurredAt: "2026-01-01T00:15:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `wix:order:${order.id}:2026-01-01T00:15:00.000Z`,
      payload: {
        orderId: `wix:order:${order.id}`,
        name: "#10001",
        createdAt: "2026-01-01T00:10:00.000Z",
        status: "APPROVED",
        financialStatus: "PAID",
        fulfillmentStatus: "NOT_FULFILLED",
        cancelledAt: null,
        channel: "online",
        currency: "USD",
        totalCents: 120_000,
        lineCount: 1,
        linesComplete: true,
        customerId,
      },
    });
    expect(events[1]!.idempotencyKey).toBe(`wix:sale:${order.id}`);
    expect(events[1]!.payload).toEqual({
      saleId: `wix:order:${order.id}`,
      customerId,
      channel: "online",
      lines: [{ sku: "SKU-TEST-0001", quantity: 1, unitPriceCents: 125_000, discountCents: 5_000 }],
      totalCents: 120_000,
      payments: [{ method: "other", amountCents: 120_000 }],
    });
    const kept = JSON.stringify(events);
    for (const personal of ["@", "Test", "Customer", "Recipient", "555", "Street", "Synthetic", "Engraving", wixTestId("eeee", 1)]) expect(kept).not.toContain(personal);
  });

  it("counts a point of sale order as the store and a cancelled one with its time", () => {
    reset();
    const pos = wixOrderEvents(wixOrder.one({ channelInfo: { type: "POS" }, status: "CANCELED", purchasedDate: "2026-01-02T00:00:00Z" }), ctx());
    expect(pos[0]!.payload).toMatchObject({ channel: "store", cancelledAt: "2026-01-01T00:15:00.000Z", createdAt: "2026-01-02T00:00:00.000Z" });
    expect(pos[1]!.occurredAt).toBe("2026-01-02T00:00:00.000Z");
    // Unreadable fields come through as null, never as raw text.
    const odd = wixOrderEvents(wixOrder.one({ number: "A-1", status: "approved", currency: "usd", buyerInfo: { contactId: "nobody" } }), ctx());
    expect(odd[0]!.payload).toMatchObject({ name: null, status: null, currency: null });
    expect(odd[0]!.payload).not.toHaveProperty("customerId");
  });

  it("makes no sale until the order is paid, nor for a rejected order or unreadable lines", () => {
    reset();
    const types = (o: WixMockRecord) => wixOrderEvents(o, ctx()).map((e) => e.type);
    expect(types(wixOrder.one({ paymentStatus: "NOT_PAID" }))).toEqual(["order.updated"]);
    expect(types(wixOrder.one({ status: "REJECTED" }))).toEqual(["order.updated"]);
    expect(types(wixOrder.one({ priceSummary: { total: { amount: "0" } } }))).toEqual(["order.updated"]);
    expect(types(wixOrder.one({ lineItems: [] }))).toEqual(["order.updated"]);
    expect(types(wixOrder.one({ lineItems: [{ ...refundedLine(1), quantity: 1.5, refundQuantity: 0 }] }))).toEqual(["order.updated"]);
    expect(types(wixOrder.one({ lineItems: [{ ...refundedLine(1), price: undefined, priceBeforeDiscounts: undefined, refundQuantity: 0 }] }))).toEqual(["order.updated"]);
    expect(wixOrderEvents({ id: "bad id" }, ctx())).toEqual([]);
    expect(wixOrderEvents(null as unknown as WixMockRecord, ctx())).toEqual([]);
  });

  it("returns each refunded unit once, so a later refund adds only its new units", () => {
    reset();
    const order = wixOrder.one({ paymentStatus: "PARTIALLY_REFUNDED", lineItems: [{ ...refundedLine(1), quantity: 3, totalPriceAfterTax: { amount: "30.00" }, refundQuantity: 2 }] });
    const first = wixOrderEvents(order, ctx()).filter((e) => e.type === "sale.returned");
    expect(first.map((e) => e.idempotencyKey)).toEqual([`wix:return:${order.id}:${wixTestId("abab", 101)}:1`, `wix:return:${order.id}:${wixTestId("abab", 101)}:2`]);
    expect(first[0]!.payload).toEqual({ saleId: `wix:order:${order.id}`, returnId: `wix:return:${order.id}:${wixTestId("abab", 101)}:1`, lines: [{ sku: "SKU-TEST-0099", quantity: 1, refundCents: 1000 }] });
    const later = wixOrderEvents({ ...order, paymentStatus: "FULLY_REFUNDED", lineItems: [{ ...(order.lineItems as WixMockRecord[])[0], refundQuantity: 3 }] }, ctx()).filter((e) => e.type === "sale.returned");
    expect(later.map((e) => e.idempotencyKey).filter((k) => !first.some((f) => f.idempotencyKey === k))).toHaveLength(1);
    // A hostile count is capped at the line's quantity and at 500 units.
    const big = wixOrderEvents(wixOrder.one({ lineItems: [{ ...refundedLine(2), quantity: 100_000, refundQuantity: 100_000 }] }), ctx());
    expect(big.filter((e) => e.type === "sale.returned")).toHaveLength(500);
    const capped = wixOrderEvents(wixOrder.one({ lineItems: [{ ...refundedLine(2), quantity: 1, refundQuantity: 9 }] }), ctx());
    expect(capped.filter((e) => e.type === "sale.returned")).toHaveLength(1);
    // A line total that can't be read leaves the refund null, for the sales schema to dead-letter.
    const unreadable = wixOrderEvents(wixOrder.one({ lineItems: [{ ...refundedLine(2), totalPriceAfterTax: { amount: "n/a" } }] }), ctx());
    expect(unreadable.find((e) => e.type === "sale.returned")!.payload.lines).toEqual([{ sku: "SKU-TEST-0099", quantity: 1, refundCents: null }]);
    expect(wixOrderEvents(wixOrder.one({ lineItems: [{ ...refundedLine(2), id: undefined }] }), ctx()).filter((e) => e.type === "sale.returned")).toEqual([]);
  });

  it("gives items without a SKU a stable stand-in", () => {
    reset();
    const line = (extra: WixMockRecord) => ({ ...refundedLine(1), refundQuantity: 0, physicalProperties: {}, ...extra });
    const skus = (l: WixMockRecord) => (wixOrderEvents(wixOrder.one({ id: wixTestId("aaaa", 9), lineItems: [l] }), ctx())[1]!.payload.lines as { sku: string }[])[0]!.sku;
    expect(skus(line({}))).toBe(`wix-variant-${wixTestId("cccc", 1)}`);
    expect(skus(line({ catalogReference: { catalogItemId: wixTestId("bbbb", 1) } }))).toBe(`wix-product-${wixTestId("bbbb", 1)}`);
    expect(skus(line({ catalogReference: {} }))).toBe(`wix-line-${wixTestId("aaaa", 9)}-${wixTestId("abab", 101)}`);
    expect(skus(line({ catalogReference: {}, id: undefined }))).toBe(`wix-line-${wixTestId("aaaa", 9)}-0`);
  });

  it("turns a V3 product and its variants into product.updated", () => {
    reset();
    const product = wixProductV3.one();
    const variants = [wixVariantV3.one(), wixVariantV3.one({ productData: { productId: product.id }, sku: "", variantId: undefined, id: wixTestId("cccc", 9), price: {} }), wixVariantV3.one(), wixVariantV3.one({ productData: { productId: product.id }, variantId: "bad id" })];
    const [event] = wixProductV3Events(product, variants, ctx());
    expect(event!.payload).toEqual({
      productId: `wix:product:${product.id}`,
      title: "Test 14K Ring 1",
      status: "visible",
      vendor: "Test Brand",
      productType: "physical",
      tags: [],
      variants: [
        { variantId: `wix:variant:${product.id}:${wixTestId("cccc", 1)}`, sku: "SKU-TEST-0001-V", priceCents: 98_000, inventoryQuantity: null },
        { variantId: `wix:variant:${product.id}:${wixTestId("cccc", 9)}`, sku: `wix-variant-${wixTestId("cccc", 9)}`, priceCents: null, inventoryQuantity: null },
      ],
    });
    // A variant change alone gives a new event.
    const [other] = wixProductV3Events(product, variants.slice(0, 1), ctx());
    expect(other!.idempotencyKey).not.toBe(event!.idempotencyKey);
    const [bare] = wixProductV3Events(wixProductV3.one({ name: "", visible: false, brand: null, productType: "weird type" }), [], ctx());
    expect(bare!.payload).toMatchObject({ title: `Wix product ${wixTestId("bbbb", 2).slice(0, 8)}`, status: "hidden", vendor: null, productType: null });
    expect(wixProductV3Events({ id: "" }, [], ctx())).toEqual([]);
  });

  it("counts V3 inventory items Wix tracks", () => {
    reset();
    const item = wixInventoryItem.one();
    expect(wixInventoryItemEvents(item, ctx())).toEqual([
      {
        id: `wix_count:${item.id}:2026-01-01T00:03:00.000Z:1`,
        type: "inventory.counted",
        occurredAt: "2026-01-01T00:03:00.000Z",
        receivedAt: RECEIVED,
        idempotencyKey: `wix:count:${item.id}:2026-01-01T00:03:00.000Z:1`,
        payload: { sku: "SKU-TEST-0001-V", onHand: 1, variantId: `wix:variant:${wixTestId("bbbb", 1)}:${wixTestId("cccc", 1)}`, productId: `wix:product:${wixTestId("bbbb", 1)}`, locationId: `wix:location:${wixTestId("ffff", 1)}` },
      },
    ]);
    expect(wixInventoryItemEvents(wixInventoryItem.one({ trackQuantity: false }), ctx())).toEqual([]);
    expect(wixInventoryItemEvents(wixInventoryItem.one({ variantId: undefined }), ctx())).toEqual([]);
    const fallback = wixInventoryItemEvents(wixInventoryItem.one({ product: {}, locationId: undefined, quantity: 2.5 }), ctx())[0]!;
    expect(fallback.payload).toEqual({ sku: `wix-variant-${wixTestId("cccc", 4)}`, onHand: null, variantId: `wix:variant:${wixTestId("bbbb", 4)}:${wixTestId("cccc", 4)}`, productId: `wix:product:${wixTestId("bbbb", 4)}` });
    expect(fallback.idempotencyKey).toMatch(/:unknown$/);
  });

  it("turns a V1 product into product.updated and a count per tracked variant", () => {
    reset();
    const product = wixProductV1.one({
      variants: [
        { id: wixTestId("cccc", 1), variant: { sku: "SKU-TEST-0001-A", priceData: { price: 1200 } }, stock: { trackQuantity: true, quantity: 2 } },
        { id: wixTestId("cccc", 2), variant: { priceData: { price: 1300.5 } }, stock: { trackQuantity: false } },
        { id: "bad id" },
      ],
    });
    const events = wixProductV1Events(product, ctx());
    expect(events.map((e) => e.type)).toEqual(["product.updated", "inventory.counted"]);
    expect(events[0]!.payload).toEqual({
      productId: `wix:product:${product.id}`,
      title: "Test 14K Ring 1",
      status: "visible",
      vendor: "Test Brand",
      productType: "physical",
      tags: [],
      variants: [
        { variantId: `wix:variant:${product.id}:${wixTestId("cccc", 1)}`, sku: "SKU-TEST-0001-A", priceCents: 120_000, inventoryQuantity: 2 },
        { variantId: `wix:variant:${product.id}:${wixTestId("cccc", 2)}`, sku: "SKU-TEST-0001", priceCents: 130_050, inventoryQuantity: null },
      ],
    });
    expect(events[1]!.payload).toEqual({ sku: "SKU-TEST-0001-A", onHand: 2, variantId: `wix:variant:${product.id}:${wixTestId("cccc", 1)}`, productId: `wix:product:${product.id}` });
    // No variants: the product stands in, with its own stock.
    const plain = wixProductV1Events(wixProductV1.one({ variants: [], sku: "", brand: 7, productType: "Physical!", visible: false }), ctx());
    expect(plain[0]!.payload).toMatchObject({ status: "hidden", vendor: null, productType: null, variants: [{ variantId: `wix:variant:${wixTestId("bbbb", 2)}:${wixTestId("bbbb", 2)}`, sku: `wix-variant-${wixTestId("bbbb", 2)}`, priceCents: 125_000, inventoryQuantity: 2 }] });
    expect(plain[1]!.payload).toMatchObject({ onHand: 2 });
    expect(wixProductV1Events(wixProductV1.one({ variants: [], stock: { trackInventory: false } }), ctx())).toHaveLength(1);
    expect(wixProductV1Events({}, ctx())).toEqual([]);
  });

  it("turns a contact into a profile under a keyed reference only", () => {
    reset();
    const subscribed = wixContact.one();
    const event = wixContactEvent(subscribed, ctx())!;
    const ref = wixCustomerRef(REF_KEY, INSTANCE, subscribed.id)!;
    expect(ref).toMatch(new RegExp(`^${WIX_CUSTOMER_PREFIX}[0-9a-f]{32}$`));
    expect(event.payload).toEqual({ customerId: ref, name: `Wix customer ${ref.slice(-32, -24)}`, marketingConsent: true });
    expect(event.occurredAt).toBe("2026-01-01T00:04:00.000Z");
    const kept = JSON.stringify(event);
    for (const personal of ["@", "Test", "Customer", "555", "Street", "ring_size", subscribed.id as string]) expect(kept).not.toContain(personal);
    expect(wixContactEvent(wixContact.one(), ctx())!.payload.marketingConsent).toBe(false);
    // Created but never updated: the creation time.
    expect(wixContactEvent(wixContact.one({ updatedDate: undefined }), ctx())!.occurredAt).toBe("2026-01-01T00:09:00.000Z");
    expect(wixContactEvent(wixContact.one({ updatedDate: undefined, createdDate: undefined }), ctx())!.occurredAt).toBeUndefined();
    expect(wixContactEvent({ id: "nobody" }, ctx())).toBeNull();
  });

  it("keys references by the key and the site, so neither can be looked up or matched without both", () => {
    const id = wixTestId("eeee", 1);
    const ref = wixCustomerRef(REF_KEY, INSTANCE, id)!;
    expect(wixCustomerRef(REF_KEY, INSTANCE, id.toUpperCase())).toBe(ref);
    expect(wixCustomerRef(OTHER_REF_KEY, INSTANCE, id)).not.toBe(ref);
    expect(wixCustomerRef(REF_KEY, OTHER_INSTANCE, id)).not.toBe(ref);
    const mac = createHmac("sha256", REF_KEY).update(`wix:contact:v1:${INSTANCE}:${id}`).digest("hex").slice(0, 32);
    expect(ref).toBe(`${WIX_CUSTOMER_PREFIX}${mac}`);
    expect(ref).not.toContain(id.slice(0, 8));
    for (const bad of ["", "nobody", `${id}x`, 5, null]) expect(wixCustomerRef(REF_KEY, INSTANCE, bad)).toBeUndefined();
    expect(() => wixCustomerRef("short", INSTANCE, id)).toThrow(WixCustomerKeyError);
  });
});

describe("Wix sync", () => {
  it("imports, replays, resumes and retries the mocked site", async () => {
    // Products: two, one hidden (2). Inventory: one tracked count, one untracked, one negative, dead-lettered (1).
    // Orders: a paid sale (order, sale), a pending one, a part refund (order, sale, return), a rejected one; Wix leaves out
    // the initialized one, and the filter the one last changed before the five years (7). Contacts: 2.
    const result = await checkConnectorSync({ makeConnector: () => connector(wixDocMock(site())), payloadSchemas: SCHEMAS, expected: { ingested: 12, deadLettered: 1 } });
    expect(result.full.batches).toBe(4);
    expect(parseWixCursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done", catalog: "v3", page: null });
  });

  it("reads the whole catalog, stock and contacts and five years of orders, with the documented bodies", async () => {
    const mock = wixDocMock(site());
    const { fetch, sent } = recording(mock);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /oauth2/token",
      "GET /apps/v1/instance",
      "GET /stores/v3/provision/version",
      "POST /stores/v3/products/query",
      "POST /stores/v3/products/query-variants",
      "POST /stores/v3/inventory-items/query",
      "POST /ecom/v1/orders/search",
      "POST /contacts/v5/contacts/query",
    ]);
    const window = (from: string, limit: number) => ({ filter: { updatedDate: { $gte: from } }, sort: [{ fieldName: "updatedDate", order: "ASC" }], cursorPaging: { limit } });
    const reads = dataReads(sent).map((s) => s.body);
    expect(reads).toEqual([
      undefined,
      { query: window(START, 100) },
      { query: { filter: { "productData.productId": { $in: [wixTestId("bbbb", 1), wixTestId("bbbb", 2)] } }, cursorPaging: { limit: 1000 } } },
      { query: window(START, 1000) },
      { search: { filter: { updatedDate: { $gte: FIVE_YEARS }, status: { $in: ["APPROVED", "CANCELED", "PENDING", "REJECTED"] } }, sort: [{ fieldName: "updatedDate", order: "ASC" }], cursorPaging: { limit: 100 } } },
      { query: window(START, 100) },
    ]);
    expect(memory.events.filter((e) => e.type === "order.updated").map((e) => e.payload.status)).toEqual(["APPROVED", "PENDING", "APPROVED", "REJECTED"]);
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(wixDocMock(site())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 12, deadLettered: 1 });
    expect(new Set(memory.events.map((e) => e.type))).toEqual(new Set(["product.updated", "inventory.counted", "order.updated", "sale.completed", "sale.returned", "customer.profile_updated"]));
    const sales = memory.events.filter((e) => e.type === "sale.completed");
    const profiles = memory.events.filter((e) => e.type === "customer.profile_updated");
    // The buyer's sales and profile share one reference.
    expect(profiles.map((e) => e.payload.customerId)).toContain(sales[0]!.payload.customerId);
    assertSynthetic(memory.events);
  });

  it("pages with Wix's cursor alone, and reads a record that changes mid-import again rather than skipping it", async () => {
    reset();
    const orders = wixOrder.many(250);
    const mock = wixDocMock(site({ orders, productsV3: [], variantsV3: [], inventoryItems: [], contacts: [] }));
    let served = 0;
    // After the first page, an order on it changes, which moves it to the end.
    const { fetch, sent } = recording(mock, (s) => {
      if (s.path === "/ecom/v1/orders/search" && served++ === 1) orders[3]!.updatedDate = "2026-03-01T00:00:00.000Z";
    });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const searches = sent.filter((s) => s.path === "/ecom/v1/orders/search").map((s) => s.body!.search as Record<string, unknown>);
    expect(searches).toHaveLength(3);
    expect(Object.keys(searches[0]!)).toEqual(["filter", "sort", "cursorPaging"]);
    for (const later of searches.slice(1)) expect(Object.keys(later)).toEqual(["cursorPaging"]);
    expect(new Set(memory.events.filter((e) => e.type === "order.updated").map((e) => e.payload.orderId)).size).toBe(250);
    expect(memory.events.filter((e) => e.type === "order.updated")).toHaveLength(251);
    expect(report.duplicates).toBe(1);
    expect(parseWixCursor(report.cursor)!.latest.orders).toBe("2026-03-01T00:00:00.000Z");
  });

  it("reads every page of inventory items, which come without hasNext, and of a product's variants", async () => {
    reset();
    const product = wixProductV3.one();
    const variants = wixVariantV3.many(1500, (n) => ({ productData: { productId: product.id }, variantId: wixTestId("cccc", n), sku: `SKU-TEST-${n}` }));
    const items = wixInventoryItem.many(1500);
    const mock = wixDocMock(site({ productsV3: [product], variantsV3: variants, inventoryItems: items, orders: [], contacts: [] }));
    const { fetch, sent } = recording(mock);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(sent.filter((s) => s.path.endsWith("/query-variants"))).toHaveLength(2);
    expect(sent.filter((s) => s.path.endsWith("/inventory-items/query"))).toHaveLength(2);
    expect((memory.events.find((e) => e.type === "product.updated")!.payload.variants as unknown[]).length).toBe(1500);
    expect(memory.events.filter((e) => e.type === "inventory.counted")).toHaveLength(1500);
  });

  it("reads a Catalog V1 site's products with their variants and stock, and no V3 endpoint", async () => {
    reset();
    const products = [
      wixProductV1.one(),
      wixProductV1.one({ variants: [] }),
      wixProductV1.one({ visible: false }),
      wixProductV1.one({ lastUpdated: "1999-01-01T00:00:00.000Z" }),
    ];
    const mock = wixDocMock(site({ catalogVersion: "V1_CATALOG", productsV1: products, orders: [], contacts: [] }));
    const { fetch, sent } = recording(mock);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(dataReads(sent).map((s) => s.path)).toEqual(["/stores/v3/provision/version", "/stores/v1/products/query", "/ecom/v1/orders/search", "/contacts/v5/contacts/query"]);
    expect(dataReads(sent)[1]!.body).toEqual({ includeVariants: true, query: { filter: JSON.stringify({ lastUpdated: { $gte: START } }), sort: JSON.stringify([{ lastUpdated: "asc" }]), paging: { limit: 100, offset: 0 } } });
    // Hidden products need a manage permission to read, so the two visible ones come back, each with a count.
    expect(report.ingested).toBe(4);
    expect(memory.events.map((e) => e.type)).toEqual(["product.updated", "inventory.counted", "product.updated", "inventory.counted"]);
  });

  it("pages Catalog V1 from the newest change on each page, and by offset through a page changed at once", async () => {
    reset();
    for (const [products, expected] of [
      [wixProductV1.many(250), [[START, 0], ["2026-01-01T01:41:00.000Z", 0], ["2026-01-01T03:20:00.000Z", 0]]],
      [wixProductV1.many(150, () => ({ lastUpdated: "2025-06-01T00:00:00.000Z" })), [[START, 0], ["2025-06-01T00:00:00.000Z", 0], ["2025-06-01T00:00:00.000Z", 100]]],
    ] as const) {
      const mock = wixDocMock(site({ catalogVersion: "V1_CATALOG", productsV1: [...products], orders: [], contacts: [] }));
      const { fetch, sent } = recording(mock);
      const { memory, pipeline } = testPipeline();
      await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
      const windows = sent
        .filter((s) => s.path === "/stores/v1/products/query")
        .map((s) => {
          const q = s.body!.query as { filter: string; paging: { offset: number } };
          return [(JSON.parse(q.filter) as { lastUpdated: { $gte: string } }).lastUpdated.$gte, q.paging.offset];
        });
      expect(windows).toEqual(expected);
      expect(new Set(memory.events.filter((e) => e.type === "product.updated").map((e) => e.payload.productId)).size).toBe(products.length);
    }
  });

  it("reads only orders and contacts when the site has no Stores catalog", async () => {
    const mock = wixDocMock(site({ catalogVersion: "STORES_NOT_INSTALLED" }));
    const report = await runSync({ connector: connector(mock), mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(paths(mock).slice(2)).toEqual(["/stores/v3/provision/version", "/ecom/v1/orders/search", "/contacts/v5/contacts/query"]);
    expect(parseWixCursor(report.cursor)).toMatchObject({ catalog: "none", step: "done" });
  });

  it("stops on a catalog version it doesn't know", async () => {
    const odd = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/oauth2/token") return Response.json({ access_token: "t".repeat(32) });
      if (path === "/apps/v1/instance") return Response.json({ instance: { permissions: [] } });
      return Response.json({ catalogVersion: "V4_CATALOG" });
    }) as typeof globalThis.fetch;
    await expect(runSync({ connector: connector(wixDocMock({}), { fetch: odd }), mode: "historical", ...testPipeline(), organizationId: TEST_ORG, attempts: 1 })).rejects.toThrow("catalog version");
  });

  it("leaves a finished import finished", async () => {
    const done: WixCursor = { pass: "historical", step: "done", catalog: "v3", page: null, after: null, offset: 0, since: { products: START, inventory: START, orders: FIVE_YEARS, contacts: START }, latest: {} };
    const mock = wixDocMock(site());
    const batches = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })) batches.push(b);
    expect([batches, mock.fetch.calls]).toEqual([[], []]);
  });

  it("reads changes since the newest each stream saw, less five minutes, or the last two days with no checkpoint", async () => {
    const data = site();
    const mock = wixDocMock(data);
    const { memory, pipeline } = testPipeline();
    const imported = await runSync({ connector: connector(mock), mode: "historical", memory, pipeline, organizationId: TEST_ORG });
    const latest = parseWixCursor(imported.cursor)!.latest;
    expect(latest).toEqual({ products: "2026-01-01T00:03:00.000Z", inventory: "2026-01-01T00:05:00.000Z", orders: "2026-01-01T01:05:00.000Z", contacts: "2026-01-01T00:07:00.000Z" });
    await memory.saveCheckpoint(TEST_ORG, "wix", "incremental", imported.cursor!);
    data.orders!.push(wixOrder.one({ updatedDate: "2026-01-10T00:00:00.000Z" }));
    const later = wixDocMock(data);
    const { fetch, sent } = recording(later);
    const report = await runSync({ connector: connector(later, { fetch }), mode: "incremental", memory, pipeline, organizationId: TEST_ORG });
    const from = (path: string) => ((sent.find((s) => s.path === path)!.body!.search ?? sent.find((s) => s.path === path)!.body!.query) as { filter: { updatedDate: { $gte: string } } }).filter.updatedDate.$gte;
    expect(from("/ecom/v1/orders/search")).toBe(new Date(Date.parse(latest.orders!) - WIX_OVERLAP_MS).toISOString());
    expect(from("/stores/v3/products/query")).toBe("2025-12-31T23:58:00.000Z");
    expect(from("/contacts/v5/contacts/query")).toBe("2026-01-01T00:02:00.000Z");
    // The new order (order and sale); everything else in the overlap is already stored.
    expect(report.ingested).toBe(2);
    expect(parseWixCursor(report.cursor)).toMatchObject({ pass: "incremental", step: "done", latest: { orders: "2026-01-10T00:00:00.000Z" } });

    // Nothing seen yet, then no checkpoint at all: the last pass's start, then the lookback.
    const empty = wixDocMock(site({ productsV3: [], variantsV3: [], inventoryItems: [], orders: [], contacts: [] }));
    const fresh = recording(empty);
    const first = await runSync({ connector: connector(empty, { fetch: fresh.fetch }), mode: "incremental", ...testPipeline(), organizationId: TEST_ORG });
    expect(parseWixCursor(first.cursor)!.since.orders).toBe("2026-01-18T00:00:00.000Z");
    const again = recording(empty);
    const pipe = testPipeline();
    await pipe.memory.saveCheckpoint(TEST_ORG, "wix", "incremental", first.cursor!);
    await runSync({ connector: connector(empty, { fetch: again.fetch }), mode: "incremental", ...pipe, organizationId: TEST_ORG });
    expect(((again.sent.find((s) => s.path === "/ecom/v1/orders/search")!.body!.search as { filter: { updatedDate: { $gte: string } } }).filter.updatedDate.$gte)).toBe("2026-01-18T00:00:00.000Z");
  });

  it("restarts a stream from the newest change it read when Wix no longer takes a saved cursor", async () => {
    reset();
    const orders = wixOrder.many(250);
    const mock = wixDocMock(site({ orders, productsV3: [], variantsV3: [], inventoryItems: [], contacts: [], rejectCursors: true }));
    const { fetch, sent } = recording(mock);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(new Set(memory.events.filter((e) => e.type === "order.updated").map((e) => e.payload.orderId)).size).toBe(250);
    const starts = sent.filter((s) => s.path === "/ecom/v1/orders/search" && (s.body!.search as Record<string, unknown>).filter).map((s) => ((s.body!.search as { filter: { updatedDate: { $gte: string } } }).filter.updatedDate.$gte));
    expect(starts).toEqual([FIVE_YEARS, orders[99]!.updatedDate, orders[198]!.updatedDate]);

    // A saved cursor with nothing newer to restart from: the error goes up rather than reading the same page forever.
    const stuck: WixCursor = { pass: "historical", step: "orders", catalog: "v3", page: "bm90LWEtY3Vyc29y", after: null, offset: 0, since: { products: START, inventory: START, orders: FIVE_YEARS, contacts: START }, latest: {} };
    const batches = connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(stuck) });
    await expect((async () => { for await (const _ of batches) void _; })()).rejects.toThrow("HTTP 400");
    // Any other error goes up as it is.
    const failing = wixDocMock(site({ apps: app(WIX_READ_ONLY_PERMISSIONS.filter((p) => p !== "SCOPE.DC-STORES.READ-ORDERS")) }));
    const resumed = connector(failing).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...stuck, latest: { orders: "2026-01-01T00:00:00.000Z" } }) });
    await expect((async () => { for await (const _ of resumed) void _; })()).rejects.toThrow("HTTP 403");
  });

  it("waits out a rate limit mid-sync", async () => {
    const waits: number[] = [];
    const mock = wixDocMock(site({ rateLimits: [{ retryAfter: 1 }] }));
    const report = await runSync({ connector: connector(mock, { sleep: async (ms) => void waits.push(ms) }), mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(waits).toEqual([1000]);
    // Without the department schemas the negative count is stored too.
    expect(report.ingested).toBe(13);
  });

  it("rejects a checkpoint that isn't its own", () => {
    const good: WixCursor = { pass: "incremental", step: "orders", catalog: "v1", page: "abc_DEF-123=", after: START, offset: 100, since: { products: START, inventory: START, orders: FIVE_YEARS, contacts: START }, latest: { orders: FIVE_YEARS } };
    expect(parseWixCursor(JSON.stringify(good))).toEqual(good);
    expect(parseWixCursor(null)).toBeNull();
    const bad: unknown[] = [
      "not json",
      "[]",
      "null",
      { ...good, pass: "other" },
      { ...good, step: "refunds" },
      { ...good, catalog: "v2" },
      { ...good, page: "has space" },
      { ...good, page: "" },
      { ...good, after: "2026-01-01T00:00:00Z" },
      { ...good, offset: -1 },
      { ...good, offset: 1.5 },
      { ...good, offset: 2_000_000 },
      { ...good, since: { ...good.since, orders: undefined } },
      { ...good, since: { ...good.since, refunds: START } },
      { ...good, latest: { orders: "yesterday" } },
      { ...good, latest: [] },
      "x".repeat(20_001),
    ];
    for (const b of bad) expect(() => parseWixCursor(typeof b === "string" ? b : JSON.stringify(b)), JSON.stringify(b).slice(0, 60)).toThrow("expected shape");
  });

  it("declares its writes and the gate refuses every one", async () => {
    const c = connector(wixDocMock(site()));
    expect(c.writes).toBe(WIX_WRITES);
    expect(WIX_WRITES.map((w) => w.name)).toEqual(["update_inventory", "update_product"]);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.action, a.outcome])).toEqual([
      ["update_inventory", "refused"],
      ["update_product", "refused"],
    ]);
  });
});

// The app's key pair, made for this run. Wix signs with its private key; the connector holds only the public one.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const nowSeconds = NOW().getTime() / 1000;
const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function jwt(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: "test" }, key: KeyObject = privateKey): string {
  const signing = `${b64(header)}.${b64(claims)}`;
  return `${signing}.${sign("RSA-SHA256", Buffer.from(signing), key).toString("base64url")}`;
}

interface Delivery {
  fqdn?: string;
  slug?: string;
  entity?: WixMockRecord | undefined;
  id?: string;
  eventTime?: string;
  instanceId?: string;
  eventType?: string;
  claims?: Record<string, unknown>;
}
function claimsFor(d: Delivery = {}): Record<string, unknown> {
  const slug = d.slug ?? "created";
  const fqdn = d.fqdn ?? "wix.ecom.v1.order";
  const inner = {
    id: d.id ?? wixTestId("beef", 1),
    entityFqdn: fqdn,
    slug,
    entityId: d.entity?.id,
    eventTime: d.eventTime ?? "2026-01-19T23:59:00.000Z",
    ...(slug === "created" ? { createdEvent: { entity: d.entity } } : slug === "updated" ? { updatedEvent: { currentEntity: d.entity } } : { deletedEvent: {} }),
  };
  return {
    data: JSON.stringify({ eventType: d.eventType ?? `${fqdn}_${slug}`, instanceId: d.instanceId ?? INSTANCE, data: JSON.stringify(inner), identity: JSON.stringify({ identityType: "APP" }) }),
    iat: nowSeconds - 10,
    exp: nowSeconds + 300,
    ...d.claims,
  };
}
const verify = (body: string | Buffer | undefined, key: string | KeyObject | undefined = PEM) => verifyWixWebhook(key, body, { instanceId: INSTANCE, now: NOW() });
const delivered = (d: Delivery = {}) => {
  const check = verify(jwt(claimsFor(d)));
  if (!check.ok) throw new Error(`expected a verified delivery, got ${check.reason}`);
  return check.delivery;
};

describe("Wix webhooks", () => {
  it("verifies a signed delivery and unwraps its event", () => {
    reset();
    const order = wixOrder.one();
    expect(delivered({ entity: order })).toEqual({ eventId: wixTestId("beef", 1), eventType: "wix.ecom.v1.order_created", instanceId: INSTANCE, entityFqdn: "wix.ecom.v1.order", slug: "created", eventTime: "2026-01-19T23:59:00.000Z", entity: order });
    expect(delivered({ slug: "updated", entity: order }).entity).toEqual(order);
    expect(verify(Buffer.from(jwt(claimsFor({ entity: order }))))).toMatchObject({ ok: true });
    // Without exp or iat, and with Wix as the issuer.
    expect(verify(jwt({ ...claimsFor({ entity: order }), exp: undefined, iat: undefined, iss: "wix.com" }))).toMatchObject({ ok: true });
    expect(verify(jwt(claimsFor({ instanceId: INSTANCE.toUpperCase(), entity: order })))).toMatchObject({ ok: true });
  });

  it("refuses a token signed any other way", () => {
    const claims = claimsFor({ entity: { id: wixTestId("aaaa", 1) } });
    const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const good = jwt(claims);
    const [h, p, s] = good.split(".") as [string, string, string];
    // `none`, and HS256 "signed" with the public key, which anyone can read.
    const none = `${b64({ alg: "none" })}.${p}.`;
    const hsSigning = `${b64({ alg: "HS256" })}.${p}`;
    const hs = `${hsSigning}.${createHmac("sha256", PEM).update(hsSigning).digest("base64url")}`;
    const forged = `${h}.${b64({ ...claims, data: (claims.data as string).replace(INSTANCE, INSTANCE) + " " })}.${s}`;
    expect(verify(none)).toEqual({ ok: false, reason: "malformed" });
    expect(verify(`${b64({ alg: "none" })}.${p}.${s}`)).toEqual({ ok: false, reason: "algorithm" });
    expect(verify(hs)).toEqual({ ok: false, reason: "algorithm" });
    expect(verify(jwt(claims, { alg: "RS256", crit: ["exp"] }))).toEqual({ ok: false, reason: "algorithm" });
    expect(verify(jwt(claims, { alg: "PS256" }))).toEqual({ ok: false, reason: "algorithm" });
    expect(verify(forged)).toEqual({ ok: false, reason: "signature" });
    expect(verify(jwt(claims, undefined, otherKey))).toEqual({ ok: false, reason: "signature" });
    expect(verify(`${h}.${p}.${s.slice(0, -4)}AAAA`)).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses an expired, not yet valid or future token, and a foreign issuer", () => {
    const base = claimsFor({ entity: { id: wixTestId("aaaa", 1) } });
    expect(verify(jwt({ ...base, exp: nowSeconds - 61 }))).toEqual({ ok: false, reason: "expired" });
    expect(verify(jwt({ ...base, exp: nowSeconds - 59 }))).toMatchObject({ ok: true });
    expect(verify(jwt({ ...base, nbf: nowSeconds + 120 }))).toEqual({ ok: false, reason: "expired" });
    expect(verify(jwt({ ...base, iat: nowSeconds + 120 }))).toEqual({ ok: false, reason: "expired" });
    expect(verify(jwt({ ...base, exp: "soon" }))).toEqual({ ok: false, reason: "malformed" });
    expect(verify(jwt({ ...base, iss: "attacker.example.test" }))).toEqual({ ok: false, reason: "issuer" });
    expect(verify(jwt({ ...base, iss: 7 }))).toEqual({ ok: false, reason: "issuer" });
  });

  it("refuses another site's event and anything unreadable", () => {
    expect(verify(jwt(claimsFor({ instanceId: OTHER_INSTANCE })))).toEqual({ ok: false, reason: "instance" });
    expect(verify(jwt({ ...claimsFor(), data: JSON.stringify({ eventType: "wix.ecom.v1.order_created", data: "{}" }) }))).toEqual({ ok: false, reason: "instance" });
    for (const claims of [
      { data: "not json" },
      { data: { nested: true } },
      { data: JSON.stringify({ eventType: "Bad Type!", instanceId: INSTANCE, data: "{}" }) },
      { data: JSON.stringify({ eventType: "wix.ecom.v1.order_created", instanceId: INSTANCE, data: 5 }) },
      { data: JSON.stringify({ eventType: "wix.ecom.v1.order_created", instanceId: INSTANCE, data: JSON.stringify({ id: "has space" }) }) },
      { data: JSON.stringify({ eventType: "wix.ecom.v1.order_created", instanceId: INSTANCE, data: "[]" }) },
    ]) {
      expect(verify(jwt(claims)), JSON.stringify(claims).slice(0, 80)).toEqual({ ok: false, reason: "malformed" });
    }
    const signed = (header: string, payload: string) => `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`;
    expect(verify(signed(b64({ alg: "RS256" }), b64("[1]")))).toEqual({ ok: false, reason: "malformed" });
    expect(verify(signed(b64("not json"), b64(claimsFor())))).toEqual({ ok: false, reason: "malformed" });
    expect(verify("only.two")).toEqual({ ok: false, reason: "malformed" });
    expect(verify("a.b.c+d")).toEqual({ ok: false, reason: "malformed" });
    expect(verify("x".repeat(WIX_MAX_WEBHOOK_BYTES + 1))).toEqual({ ok: false, reason: "malformed" });
    expect(verify(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(verifyWixWebhook(undefined, jwt(claimsFor()), { instanceId: INSTANCE, now: NOW() })).toEqual({ ok: false, reason: "missing" });
    // Odd slugs and entity names are dropped, not echoed.
    const odd = delivered({ fqdn: "Bad Name", eventType: "wix.ecom.v1.order_created", slug: "created", entity: { id: wixTestId("aaaa", 1) } });
    expect([odd.entityFqdn, odd.eventTime]).toEqual(["", "2026-01-19T23:59:00.000Z"]);
  });

  it("reads only an RSA public key", () => {
    expect(wixWebhookKey(PEM)?.asymmetricKeyType).toBe("rsa");
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString();
    for (const bad of [ec, "-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----", "", "x".repeat(10_001), undefined]) expect(wixWebhookKey(bad)).toBeUndefined();
    expect(verify(jwt(claimsFor()), ec)).toEqual({ ok: false, reason: "missing" });
    expect(verify(jwt(claimsFor()), publicKey)).toMatchObject({ ok: true });
  });

  it("turns order, contact and inventory item events into the sync's own events, so a replay stores nothing twice", () => {
    reset();
    const order = wixOrder.one();
    const contact = wixContact.one({ id: wixTestId("eeee", 1) });
    const item = wixInventoryItem.one();
    const c = ctx();
    const now = NOW();
    expect(wixWebhookEvents(delivered({ entity: order }), c, now)).toEqual(wixOrderEvents(order, c));
    expect(wixWebhookEvents(delivered({ fqdn: "wix.contacts.v4.contact", slug: "updated", entity: contact }), c, now)).toEqual([wixContactEvent(contact, c)]);
    expect(wixWebhookEvents(delivered({ fqdn: "wix.stores.catalog.v3.inventory_item", slug: "updated", entity: item }), c, now)).toEqual(wixInventoryItemEvents(item, c));
    // Prompts to sync: products, deletions, an unknown entity, an unreadable contact or entity ID.
    expect(wixWebhookEvents(delivered({ fqdn: "wix.stores.catalog.v3.product", entity: wixProductV3.one() }), c, now)).toEqual([]);
    expect(wixWebhookEvents(delivered({ slug: "deleted" }), c, now)).toEqual([]);
    expect(wixWebhookEvents(delivered({ fqdn: "wix.contacts.v4.contact", entity: { id: "nobody" } }), c, now)).toEqual([]);
    expect(wixWebhookEvents(delivered({ entity: { id: "bad id" } }), c, now)).toEqual([]);
    expect(wixWebhookEvents(null as unknown as WixWebhookDelivery, c, now)).toEqual([]);
    // Older than Wix's retries, or with no time: the sync reads it instead.
    expect(wixWebhookEvents(delivered({ entity: order, eventTime: new Date(now.getTime() - WIX_STALE_DELIVERY_MS - 1000).toISOString() }), c, now)).toEqual([]);
    expect(wixWebhookEvents({ ...delivered({ entity: order }), eventTime: undefined }, c, now)).toEqual([]);
    // Through the connector, with its own keys.
    const events = connector(wixDocMock({})).handleWebhook!(delivered({ entity: order })) as { idempotencyKey: string }[];
    expect(events.map((e) => e.idempotencyKey)).toEqual(wixOrderEvents(order, c).map((e) => e.idempotencyKey));
  });

  it("handles each event ID once within Wix's retry window", () => {
    let now = 0;
    const guard = new WixReplayGuard({ clock: () => now });
    const id = wixTestId("beef", 1);
    expect(guard.firstDelivery(id)).toBe(true);
    expect(guard.firstDelivery(id)).toBe(false);
    expect(guard.firstDelivery(id.toUpperCase())).toBe(false);
    now += 48 * 3_600_000;
    expect(guard.firstDelivery(id)).toBe(false);
    now += 1.5 * 3_600_000;
    expect(guard.firstDelivery(id)).toBe(true);
    for (const bad of [undefined, "", "has space", "x".repeat(65)]) expect(guard.firstDelivery(bad)).toBe(false);
    // Full: the oldest ID is forgotten first.
    const small = new WixReplayGuard({ maxEntries: 2, clock: () => 0 });
    expect(["a", "b", "c", "a"].map((x) => small.firstDelivery(x))).toEqual([true, true, true, true]);
    expect(small.firstDelivery("c")).toBe(false);
    expect(new WixReplayGuard().firstDelivery("default-clock")).toBe(true);
  });

  it("keeps hostile input fast", () => {
    const hostile = ["1".repeat(100_000), `${"2026-01-01T00:00:00.".padEnd(50_000, "1")}x`, `${"-".repeat(50_000)}!`, `${"A.".repeat(50_000)}`, `${"a".repeat(100_000)}.`];
    const start = performance.now();
    for (const h of hostile) {
      wixTime(h);
      wixCents(h);
      wixId(h);
      isWixReadPermission(h);
      wixCustomerRef(REF_KEY, INSTANCE, h);
      verify(h);
      verify(`${h}.${h}.${h}`);
      expect(() => parseWixCursor(h)).toThrow();
      wixOrderEvents({ id: wixTestId("aaaa", 1), number: h, status: h, updatedDate: h, priceSummary: { total: { amount: h } }, lineItems: [{ id: h, quantity: 1, physicalProperties: { sku: h }, price: { amount: h } }] }, ctx());
      wixProductV1Events({ id: wixTestId("bbbb", 1), productType: h, name: h, lastUpdated: h }, ctx());
      wixContactEvent({ id: h, email: { subscriptionStatus: { status: h } } }, ctx());
      new WixReplayGuard().firstDelivery(h);
    }
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

describe("Wix doc mock", () => {
  const token = async (mock: WixMock) => ((await (await mock.fetch(`${WIX_MOCK_API}/oauth2/token`, { method: "POST", body: JSON.stringify({ grant_type: "client_credentials", client_id: APP_ID, client_secret: SECRET, instance_id: INSTANCE }) })).json()) as { access_token: string }).access_token;
  const post = async (mock: WixMock, path: string, body: unknown, auth?: string) => {
    const response = await mock.fetch(`${WIX_MOCK_API}${path}`, { method: "POST", headers: { authorization: auth ?? (await token(mock)) }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it("holds only synthetic data and lists its assumptions", () => {
    const data = site();
    assertSynthetic({ ...data, apps: undefined });
    expect(wixDocMock({}).api.assumptions.length).toBeGreaterThan(5);
  });

  it("refuses what the docs don't list, and a bad token request", async () => {
    const mock = wixDocMock(site());
    await expect(mock.fetch(`${WIX_MOCK_API}/stores/v3/inventory-items/update`, { method: "POST" })).rejects.toBeInstanceOf(UndocumentedRequestError);
    await expect(mock.fetch(`${WIX_MOCK_API}/ecom/v1/orders/search`, { method: "GET" })).rejects.toBeInstanceOf(UndocumentedRequestError);
    const tokenWith = async (body: string) => (await mock.fetch(`${WIX_MOCK_API}/oauth2/token`, { method: "POST", body })).status;
    expect(await tokenWith("{")).toBe(400);
    expect(await tokenWith(JSON.stringify({ grant_type: "authorization_code" }))).toBe(400);
    expect(await tokenWith(JSON.stringify({ grant_type: "client_credentials", client_id: 5 }))).toBe(401);
    expect((await post(mock, "/ecom/v1/orders/search", {}, "Bearer nope")).status).toBe(401);
  });

  it("answers bad queries the way the docs describe", async () => {
    const mock = wixDocMock(site());
    const status = async (path: string, body: unknown) => (await post(mock, path, body)).status;
    expect(await status("/ecom/v1/orders/search", "{")).toBe(400);
    expect(await status("/ecom/v1/orders/search", { search: { cursorPaging: { limit: 101 } } })).toBe(400);
    expect(await status("/ecom/v1/orders/search", { search: { filter: { buyerNote: "x" } } })).toBe(400);
    expect(await status("/ecom/v1/orders/search", { search: { filter: { status: { $regex: "x" } } } })).toBe(400);
    expect(await status("/ecom/v1/orders/search", { search: { filter: { updatedDate: { $gte: "yesterday" } } } })).toBe(400);
    expect(await status("/ecom/v1/orders/search", { search: { sort: [{ fieldName: "total" }] } })).toBe(400);
    expect(await status("/ecom/v1/orders/search", { search: { sort: "updatedDate" } })).toBe(400);
    expect(await status("/ecom/v1/orders/search", { search: { cursorPaging: { cursor: "e30" }, filter: {} } })).toBe(400);
    expect(await status("/ecom/v1/orders/search", { search: { cursorPaging: { cursor: 5 } } })).toBe(400);
    expect(await status("/contacts/v5/contacts/query", { query: { sort: [{ fieldName: "updatedDate", order: "DESC" }] } })).toBe(400);
    expect(await status("/stores/v1/products/query", { query: { filter: "{" } })).toBe(428);
    reset();
    const v1 = wixDocMock(site({ catalogVersion: "V1_CATALOG", productsV1: [wixProductV1.one(), wixProductV1.one()] }));
    const v1status = async (body: unknown) => (await post(v1, "/stores/v1/products/query", body)).status;
    expect(await v1status({ query: { filter: "{" } })).toBe(400);
    expect(await v1status({ query: { paging: { limit: 101 } } })).toBe(400);
    expect(await v1status({ query: { filter: JSON.stringify({ ribbon: "New" }) } })).toBe(400);
    expect(await v1status({ query: { sort: JSON.stringify([{ name: "asc" }]) } })).toBe(400);
    expect((await post(v1, "/stores/v3/products/query", {})).status).toBe(428);
    expect((await post(v1, "/stores/v3/products/query-variants", {})).status).toBe(428);
    expect((await post(v1, "/stores/v3/inventory-items/query", {})).status).toBe(428);
    // Defaults: newest first, no variants unless asked, and the docs' default statuses.
    const listed = await post(v1, "/stores/v1/products/query", { query: { sort: JSON.stringify([{ lastUpdated: "desc" }]) } });
    expect((listed.body.products as WixMockRecord[]).map((p) => [p.id, p.variants])).toEqual([[wixTestId("bbbb", 2), undefined], [wixTestId("bbbb", 1), undefined]]);
    const orders = await post(mock, "/ecom/v1/orders/search", { search: { filter: { id: { $ne: "x" } }, sort: [{ fieldName: "updatedDate", order: "DESC" }] } });
    expect((orders.body.orders as WixMockRecord[]).map((o) => o.status)).toEqual(["APPROVED", "APPROVED", "APPROVED"]);
    const lt = await post(mock, "/ecom/v1/orders/search", { search: { filter: { updatedDate: { $lt: "2026-01-01T00:20:00.000Z", $lte: "2026-01-01T00:20:00.000Z", $gt: "2021-01-01T00:00:00.000Z" }, status: "APPROVED" } } });
    expect((lt.body.orders as WixMockRecord[]).map((o) => o.number)).toEqual(["10001"]);
    // Hidden products need the admin permission.
    const limited = wixDocMock(site({ apps: app(WIX_READ_ONLY_PERMISSIONS.filter((p) => p !== "SCOPE.STORES.PRODUCT_READ_ADMIN")) }));
    expect(((await post(limited, "/stores/v3/products/query", {})).body.products as unknown[]).length).toBe(1);
  });
});
