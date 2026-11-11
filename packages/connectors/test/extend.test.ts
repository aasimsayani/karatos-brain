import { describe, expect, it } from "vitest";
import { InMemoryWriteAuditLog, READ_ONLY, WriteGate, WritesDisabledError, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  DOC_MOCK_MODULES,
  EXTEND_DOC_PAGES,
  EXTEND_MOCK_BASES,
  EXTEND_MOCK_PAGE_SIZE,
  EXTEND_MOCK_STORE,
  TEST_ORG,
  UndocumentedRequestError,
  assertSynthetic,
  checkConnectorSync,
  extendContract,
  extendDocMock,
  extendOrder,
  extendUuid,
  testPipeline,
  type ExtendMock,
  type ExtendMockData,
  type ExtendMockRecord,
} from "@karatos/connector-testkit";
import {
  EXTEND_ACCEPT,
  EXTEND_API_URLS,
  EXTEND_API_VERSION,
  EXTEND_CLIENT_ASSERTION,
  EXTEND_EVENTS,
  EXTEND_OVERLAP_MS,
  EXTEND_USER_AGENT,
  EXTEND_WINDOW_DAYS,
  EXTEND_WRITES,
  ExtendApiError,
  ExtendConfigError,
  WHATNOT_USER_AGENT,
  extendAmount,
  extendClient,
  extendConnector,
  extendContractEvent,
  extendId,
  extendOrderEvent,
  extendTime,
  isExtendCursor,
  parseExtendCursor,
  type ExtendClient,
  type ExtendClientOptions,
  type ExtendCursor,
  type ExtendEvent,
  type ExtendOptions,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = ["test", "client", "x".repeat(12)].join("-");
const CLIENT_SECRET = ["test", "secret", "y".repeat(24)].join("-");
const TOKEN = ["mock", "token", "1".repeat(8)].join(".");
const STORE = EXTEND_MOCK_STORE;
const NOW_MS = Date.parse("2026-11-11T15:00:00.000Z");
const NOW = () => new Date(NOW_MS);
const RECEIVED = "2026-11-11T15:00:00.000Z";
const DAY = 86_400_000;
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;
const PROD = EXTEND_API_URLS.production;
const noSleep = async () => {};

const reset = () => {
  extendContract.reset();
  extendOrder.reset();
};
/** Three live contracts and three open orders. */
function account(overrides: Partial<ExtendMockData> = {}): ExtendMockData {
  reset();
  return { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, contracts: extendContract.many(3), orders: extendOrder.many(3), ...overrides };
}
/** Contract 1 with overrides. */
const contract = (over: ExtendMockRecord = {}) => {
  reset();
  return { ...extendContract.one(), ...over };
};
/** Order 1 with overrides. */
const order = (over: ExtendMockRecord = {}) => {
  reset();
  return { ...extendOrder.one(), ...over };
};
const options = (mock: ExtendMock, overrides: Partial<ExtendOptions> = {}): ExtendOptions => ({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, storeId: STORE, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const connector = (mock: ExtendMock, overrides: Partial<ExtendOptions> = {}) => extendConnector(options(mock, overrides));
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as ExtendEvent[];
async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}
const reads = (mock: ExtendMock) => mock.reads.map((r) => `${r.path} ${r.query.cursor === undefined ? "first" : "next"}`);

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}
function scripted(responses: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body });
    return responses[Math.min(sent.length - 1, responses.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
/** A token answer; "none" leaves expires_in out. */
const tokenOk = (expires: unknown = 3600) => json(200, { access_token: TOKEN, token_type: "Bearer", ...(expires === "none" ? {} : { expires_in: expires }) });
const noOrders = json(200, { orders: [], limit: 500 });
const noContracts = json(200, { contracts: [] });
const client = (fetch: typeof globalThis.fetch, extra: Partial<ExtendClientOptions> = {}) => {
  const slept: number[] = [];
  const c = extendClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, storeId: STORE, fetch, sleep: async (ms) => void slept.push(ms), now: NOW, ...extra });
  return { c, slept };
};
const GET_HEADERS = { accept: EXTEND_ACCEPT, "content-type": "application/json", "user-agent": EXTEND_USER_AGENT, "x-extend-access-token": TOKEN };
const TOKEN_HEADERS = { accept: "application/json", "content-type": "application/json", "user-agent": EXTEND_USER_AGENT };
const TOKEN_BODY = JSON.stringify({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, client_assertion: EXTEND_CLIENT_ASSERTION });

describe("Extend client", () => {
  it("checks its settings before sending anything", () => {
    const { fetch, sent } = scripted([tokenOk()]);
    const base = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, storeId: STORE, fetch };
    const id = "set EXTEND_CLIENT_ID to the client ID of an API Integration made in the Extend Merchant Portal";
    const secret = "set EXTEND_CLIENT_SECRET to the client secret of the same Extend API Integration";
    const store = "set EXTEND_STORE_ID to the store's ID in Extend, a UUID shown in the Merchant Portal";
    const badCredential = ["", "1234567", "has space-in", "x".repeat(513), "tést-1234", undefined as unknown as string];
    for (const clientId of badCredential) expect(() => extendClient({ ...base, clientId }), String(clientId)).toThrow(new ExtendConfigError(id));
    for (const clientSecret of badCredential) expect(() => extendClient({ ...base, clientSecret }), String(clientSecret)).toThrow(new ExtendConfigError(secret));
    for (const storeId of ["", "not-a-uuid", STORE.slice(1), `${STORE}0`, STORE.replace(/-/g, ""), STORE.replace("a", "g"), undefined as unknown as string]) {
      expect(() => extendClient({ ...base, storeId }), String(storeId)).toThrow(new ExtendConfigError(store));
    }
    for (const environment of ["sandbox", "toString", "Production"]) expect(() => extendClient({ ...base, environment: environment as "demo" })).toThrow(new ExtendConfigError("EXTEND_ENVIRONMENT must be production or demo"));
    for (const ok of ["12345678", "x".repeat(512), `  ${CLIENT_ID}\n`, "a!~b{}|c"]) {
      expect(() => extendClient({ ...base, clientId: ok, clientSecret: ok }), ok).not.toThrow();
    }
    expect(extendClient({ ...base, storeId: ` ${STORE.toUpperCase()} ` }).baseUrl).toBe(PROD);
    expect(extendClient({ ...base, environment: "demo" }).baseUrl).toBe("https://api-demo.helloextend.com");
    expect(extendClient({ ...base, environment: "production" }).baseUrl).toBe("https://api.helloextend.com");
    expect(sent).toHaveLength(0);
    expect(new ExtendConfigError("x").name).toBe("ExtendConfigError");
    expect(new ExtendApiError("x", 500, "boom")).toMatchObject({ name: "ExtendApiError", status: 500, code: "boom" });
  });

  it("trades the client credentials for a token, then sends only GETs of the two searches with it", async () => {
    const { fetch, sent } = scripted([tokenOk(), noContracts, noOrders, noOrders]);
    const { c } = client(fetch, { storeId: STORE.toUpperCase() });
    expect(await c.contracts()).toEqual([]);
    expect(await c.orders(null)).toEqual({ orders: [], nextCursor: null });
    await c.orders("eyJh+b/c=");
    expect(sent).toEqual([
      { url: `${PROD}/auth/oauth/token`, method: "POST", headers: TOKEN_HEADERS, body: TOKEN_BODY },
      { url: `${PROD}/contracts/search?sellerId=${STORE}&typeFilter=pcrs&showAll=true`, method: "GET", headers: GET_HEADERS, body: undefined },
      { url: `${PROD}/orders/search?storeId=${STORE}`, method: "GET", headers: GET_HEADERS, body: undefined },
      { url: `${PROD}/orders/search?storeId=${STORE}&cursor=eyJh%2Bb%2Fc%3D`, method: "GET", headers: GET_HEADERS, body: undefined },
    ]);
    expect(Object.keys(c).sort()).toEqual(["baseUrl", "contracts", "orders"]);
    expect([EXTEND_API_VERSION, EXTEND_ACCEPT, EXTEND_CLIENT_ASSERTION]).toEqual(["2022-02-01", "application/json; version=2022-02-01", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"]);
    expect(EXTEND_USER_AGENT).toBe(WHATNOT_USER_AGENT);
    expect(JSON.stringify(sent.slice(1))).not.toContain(CLIENT_SECRET);
    const demo = scripted([tokenOk(), noOrders]);
    await client(demo.fetch, { environment: "demo" }).c.orders(null);
    expect(demo.sent.map((s) => s.url)).toEqual([`https://api-demo.helloextend.com/auth/oauth/token`, `https://api-demo.helloextend.com/orders/search?storeId=${STORE}`]);
  });

  it("keeps a token until a minute before it runs out, and renews one Extend stops taking once", async () => {
    let at = NOW_MS;
    const { fetch, sent } = scripted([tokenOk(120), noOrders, noOrders, tokenOk(120), noOrders]);
    const { c } = client(fetch, { now: () => new Date(at) });
    await c.orders(null);
    at += 59_999;
    await c.orders(null);
    at += 1;
    await c.orders(null);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
    // No lifetime, or one that isn't a whole number above zero: a token is asked for every time.
    for (const expires of ["none", null, 0, -5, 1.5, "3600"]) {
      const s = scripted([tokenOk(expires), noOrders, tokenOk(expires), noOrders]);
      const { c: each } = client(s.fetch);
      await each.orders(null);
      await each.orders(null);
      expect(s.sent.map((r) => r.method), String(expires)).toEqual(["POST", "GET", "POST", "GET"]);
    }
    const renewed = scripted([tokenOk(), json(401, { code: "unauthorized" }), tokenOk(), noOrders]);
    expect(await client(renewed.fetch).c.orders(null)).toEqual({ orders: [], nextCursor: null });
    expect(renewed.sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
    const twice = scripted([tokenOk(), json(401, { code: "unauthorized" }), tokenOk(), json(401, { code: "unauthorized" })]);
    await expect(client(twice.fetch).c.contracts()).rejects.toThrow(
      new ExtendConfigError("Extend turned down the token for the contracts (HTTP 401, unauthorized); EXTEND_STORE_ID must be the store the API Integration in EXTEND_CLIENT_ID was made for"),
    );
    expect(twice.sent).toHaveLength(4);
  });

  it("explains credentials or a store Extend turns down, without echoing them, and other answers", async () => {
    const tokenWith = async (response: () => Response) => client(scripted([response]).fetch, { retries: 0 }).c.orders(null);
    for (const status of [400, 401, 403]) {
      const error = await tokenWith(json(status, { code: "invalid_client", message: "bad" })).then(() => null, (e: unknown) => e as Error);
      expect(error, String(status)).toEqual(new ExtendConfigError(`Extend turned down EXTEND_CLIENT_ID and EXTEND_CLIENT_SECRET (HTTP ${status}); they must be an API Integration's client ID and secret from the production Merchant Portal`));
      expect(error!.message).not.toContain(CLIENT_SECRET);
      expect(error!.message).not.toContain(CLIENT_ID);
    }
    const demo = await client(scripted([json(401, {})]).fetch, { environment: "demo" }).c.orders(null).then(() => null, (e: unknown) => e as Error);
    expect(demo!.message).toContain("from the demo Merchant Portal");
    await expect(tokenWith(json(404, { code: "not_found" }))).rejects.toThrow(new ExtendApiError("Extend answered HTTP 404 for a token", 404, "not_found"));
    await expect(tokenWith(json(500, null))).rejects.toMatchObject({ status: 500, code: undefined });
    for (const body of [{}, { access_token: 5 }, { access_token: "short" }, { access_token: "has space here" }, { access_token: "x".repeat(8193) }, null]) {
      await expect(tokenWith(json(200, body)), JSON.stringify(body)).rejects.toThrow(new ExtendApiError("Extend answered without a token", 200));
    }
    await expect(tokenWith(() => new Response("{", { status: 200 }))).rejects.toThrow("Extend answered without a token");
    expect(await client(scripted([json(200, { access_token: "a".repeat(8192) }), noOrders]).fetch).c.orders(null)).toEqual({ orders: [], nextCursor: null });

    const searchWith = async (response: () => Response) => client(scripted([tokenOk(), response]).fetch, { retries: 0 }).c.orders(null);
    const store = "EXTEND_STORE_ID must be the store the API Integration in EXTEND_CLIENT_ID was made for";
    await expect(searchWith(json(403, { code: "forbidden", message: "Forbidden" }))).rejects.toThrow(new ExtendConfigError(`Extend turned down the token for the orders (HTTP 403, forbidden); ${store}`));
    await expect(searchWith(json(403, { code: "has space", message: "x" }))).rejects.toThrow(new ExtendConfigError(`Extend turned down the token for the orders (HTTP 403); ${store}`));
    await expect(searchWith(() => new Response("nope", { status: 403 }))).rejects.toBeInstanceOf(ExtendConfigError);
    await expect(searchWith(json(400, { code: "invalid_parameter", message: "customer@example.test is not valid" }))).rejects.toThrow(new ExtendApiError("Extend answered HTTP 400 for the orders (invalid_parameter)", 400, "invalid_parameter"));
    await expect(searchWith(json(404, { code: "c".repeat(65) }))).rejects.toThrow(new ExtendApiError("Extend answered HTTP 404 for the orders", 404));
    expect(await searchWith(json(404, { code: "c".repeat(64) })).catch((e: ExtendApiError) => e.code)).toBe("c".repeat(64));
    await expect(searchWith(json(202, {}))).rejects.toMatchObject({ status: 202 });
    await expect(searchWith(json(501, {}))).rejects.toMatchObject({ status: 501 });
  });

  it("reads only pages and lists that read, and turns down a cursor it wasn't made for", async () => {
    const at = async (body: unknown, cursor: string | null = null) => client(scripted([tokenOk(), json(200, body)]).fetch).c.orders(cursor);
    for (const body of [null, [], 5, {}, { orders: 5 }, { orders: {} }, { orders: [], nextPageCursor: 5 }, { orders: [], nextPageCursor: "c".repeat(4097) }, { orders: [], nextPageCursor: "a b" }]) {
      await expect(at(body), JSON.stringify(body).slice(0, 40)).rejects.toThrow(new ExtendApiError("Extend answered the orders without a page that reads", 200));
    }
    expect(await at({ orders: [{ id: "1" }] })).toEqual({ orders: [{ id: "1" }], nextCursor: null });
    expect(await at({ orders: [], nextPageCursor: null })).toEqual({ orders: [], nextCursor: null });
    expect(await at({ orders: [], nextPageCursor: "" })).toEqual({ orders: [], nextCursor: null });
    expect(await at({ orders: [], nextPageCursor: "n" })).toEqual({ orders: [], nextCursor: "n" });
    expect(await at({ orders: [], nextPageCursor: "c".repeat(4096) })).toEqual({ orders: [], nextCursor: "c".repeat(4096) });
    await expect(at({ orders: [], nextPageCursor: "c1" }, "c1")).rejects.toThrow(new ExtendApiError("Extend answered the orders with the same cursor again", 200));
    expect(await at({ orders: [], nextPageCursor: "c2" }, "c1")).toEqual({ orders: [], nextCursor: "c2" });
    const contracts = async (body: unknown) => client(scripted([tokenOk(), json(200, body)]).fetch).c.contracts();
    for (const body of [null, [], {}, { contracts: 5 }, { contracts: {} }]) await expect(contracts(body), JSON.stringify(body)).rejects.toThrow(new ExtendApiError("Extend answered the contracts without a list that reads", 200));
    expect(await contracts({ contracts: [{ id: "c" }] })).toEqual([{ id: "c" }]);
    const { fetch, sent } = scripted([tokenOk(), noOrders]);
    const { c } = client(fetch);
    for (const cursor of ["", "c".repeat(4097), "a b", "é", 5 as unknown as string]) await expect(c.orders(cursor), String(cursor).slice(0, 5)).rejects.toThrow(new ExtendApiError("a cursor for the orders must be 1 to 4096 visible characters", 0));
    expect(sent).toHaveLength(0);
    expect([isExtendCursor("c".repeat(4096)), isExtendCursor("!~"), isExtendCursor(null)]).toEqual([true, true, false]);
  });

  it("waits out a 429 or 5xx as Retry-After says, up to a minute, else 1, 2 and 4 seconds", async () => {
    const waits = async (headers: Record<string, string>, status = 429) => {
      const { fetch, sent } = scripted([tokenOk(), json(status, { code: "too_many_requests" }, headers), noOrders]);
      const { c, slept } = client(fetch);
      await c.orders(null);
      expect(sent).toHaveLength(3);
      return slept;
    };
    expect(await waits({ "retry-after": "1" })).toEqual([1000]);
    expect(await waits({ "retry-after": "60" })).toEqual([60_000]);
    expect(await waits({ "retry-after": "61" })).toEqual([60_000]);
    for (const value of ["0", "-1", "1.5", "soon"]) expect(await waits({ "retry-after": value }), value).toEqual([1000]);
    expect(await waits({})).toEqual([1000]);
    for (const status of [500, 502, 503, 504]) expect(await waits({ "retry-after": "3" }, status), String(status)).toEqual([3000]);
    const { fetch, sent } = scripted([tokenOk(), json(503, { code: "unavailable" })]);
    const { c, slept } = client(fetch);
    await expect(c.orders(null)).rejects.toMatchObject({ status: 503, code: "unavailable" });
    expect([sent.length, slept]).toEqual([5, [1000, 2000, 4000]]);
    // The token request is waited out the same way.
    const tokenLimited = scripted([json(429, {}, { "retry-after": "2" }), tokenOk(), noOrders]);
    const t = client(tokenLimited.fetch);
    await t.c.orders(null);
    expect([tokenLimited.sent.map((s) => s.method), t.slept]).toEqual([["POST", "POST", "GET"], [2000]]);
    const once = scripted([tokenOk(), json(501, {})]);
    await expect(client(once.fetch).c.orders(null)).rejects.toMatchObject({ status: 501 });
    expect(once.sent).toHaveLength(2);
    const one = scripted([tokenOk(), json(429, {})]);
    await expect(client(one.fetch, { retries: 1 }).c.orders(null)).rejects.toMatchObject({ status: 429 });
    expect(one.sent).toHaveLength(3);
    const forbidden = scripted([tokenOk(), json(403, {})]);
    await expect(client(forbidden.fetch).c.orders(null)).rejects.toBeInstanceOf(ExtendConfigError);
    expect(forbidden.sent).toHaveLength(2);
  });

  it("works with the default sleep, clock and fetch", async () => {
    const original = globalThis.fetch;
    const { fetch, sent } = scripted([tokenOk(), json(429, {}, { "retry-after": "0" }), noOrders]);
    globalThis.fetch = fetch;
    try {
      const started = Date.now();
      await extendClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, storeId: STORE }).orders(null);
      expect(Date.now() - started).toBeGreaterThanOrEqual(990);
      expect(sent).toHaveLength(3);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("Extend events", () => {
  it("reads ids, times and amounts as Extend writes them", () => {
    expect(extendTime(1651787624000)).toBe("2022-05-05T21:53:44.000Z");
    expect(extendTime(1557267465)).toBe("2019-05-07T22:17:45.000Z");
    expect(extendTime(1e9)).toBe("2001-09-09T01:46:40.000Z");
    expect(extendTime(1e10 - 1)).toBe("2286-11-20T17:46:39.000Z");
    expect(extendTime(1e12)).toBe("2001-09-09T01:46:40.000Z");
    expect(extendTime(1e13 - 1)).toBe("2286-11-20T17:46:39.999Z");
    for (const t of [1e9 - 1, 1e10, 1e12 - 1, 1e13, 0, -1651787624000, 1651787624000.5, "1651787624000", null, undefined]) expect(extendTime(t), String(t)).toBeUndefined();
    expect(extendAmount(0)).toBe(0);
    expect(extendAmount(1999)).toBe(1999);
    expect(extendAmount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const a of [-1, 19.99, "1999", null, Number.MAX_SAFE_INTEGER + 1, NaN]) expect(extendAmount(a), String(a)).toBeUndefined();
    expect(extendId(STORE)).toBe(STORE);
    expect(extendId("a".repeat(64))).toBe("a".repeat(64));
    expect(extendId("A_b-9")).toBe("A_b-9");
    for (const id of ["", "a".repeat(65), "a b", "a/b", "customer@example.test", 5, null]) expect(extendId(id), String(id)).toBeUndefined();
  });

  it("reads a contract as its plan, coverage and product, without the customer", () => {
    const raw = contract();
    const { ok, event, updatedAt } = extendContractEvent(raw, RECEIVED);
    expect(ok).toBe(true);
    const id = extendUuid("c0", 1);
    expect(event).toMatchObject({ type: EXTEND_EVENTS.contract, occurredAt: "2026-01-01T01:30:00.000Z", receivedAt: RECEIVED });
    expect(updatedAt).toBe("2026-01-01T01:30:00.000Z");
    expect(event.idempotencyKey).toMatch(new RegExp(`^extend:contract:${id}:[0-9a-f]{16}$`));
    expect(event.id).toBe(event.idempotencyKey.replace(/:/g, "_"));
    expect(event.payload).toEqual({
      system: "Extend",
      contractId: `extend:contract:${id}`,
      status: "live",
      covering: true,
      test: false,
      planId: "10001-jewelry-adh-replace-3y",
      planCategory: "service_contract",
      termMonths: 36,
      serviceType: "repair",
      coverageStatus: "covered_by_adh_and_base_protection_by_extend",
      coverageStartsAt: "2026-01-01T01:00:00.000Z",
      coverageEndsAt: "2028-12-31T01:00:00.000Z",
      currency: "USD",
      purchasePrice: 4901,
      listPrice: 5900,
      purchasedAt: "2026-01-01T01:00:00.000Z",
      createdAt: "2026-01-01T01:00:00.000Z",
      orderId: `extend:order:${extendUuid("0d", 1)}`,
      transactionId: "TEST-ORDER-1",
      customerId: "cust-1",
      product: {
        referenceId: "SKU-TEST-0001",
        name: "Test ring 1",
        purchasePrice: 120001,
        listPrice: 125000,
        purchasedAt: "2026-01-01T01:00:00.000Z",
        fulfilledAt: "2026-01-02T01:00:00.000Z",
        warrantyMonthsParts: 12,
        warrantyMonthsLabor: 12,
      },
    });
    expect(JSON.stringify(event.payload)).not.toMatch(/Test Customer|example\.test|555|Test Street|SERIAL|customers\.extend|TEST-TERMS|Test Jeweler/);
    assertSynthetic(event.payload);
    // Reading it again gives the same key; any change to what is kept gives a new one.
    expect(extendContractEvent(raw, "2026-11-12T00:00:00.000Z").event.idempotencyKey).toBe(event.idempotencyKey);
    expect(extendContractEvent({ ...raw, status: "fulfilled" }, RECEIVED).event.idempotencyKey).not.toBe(event.idempotencyKey);
    expect(extendContractEvent({ ...raw, customer: { name: "Other" } }, RECEIVED).event.idempotencyKey).toBe(event.idempotencyKey);
  });

  it("maps each contract status and the optional fields, leaving out what doesn't read", () => {
    const statuses = ["created", "live", "delivered", "expired", "fulfilled", "cancelled", "refund_requested", "refund_accepted", "refund_denied", "refund_paid", "voided", "pending_termination", "terminated"];
    for (const status of statuses) {
      const { ok, event } = extendContractEvent(contract({ status }), RECEIVED);
      expect([ok, event.payload.status, event.payload.covering], status).toEqual([true, status, status === "live" || status === "delivered"]);
    }
    const sparse = extendContractEvent(
      contract({
        isTest: true,
        listPrice: -1,
        purchaseDate: null,
        createdAt: "x",
        orderId: "a b",
        transactionId: "  ",
        merchantCustomerId: "customer@example.test",
        cancelledAt: 1767225600000,
        refundedAt: 1767225600,
        cancellationReason: "customer_requested",
        plan: { id: 5, category: "other" },
        planDetails: { term_length: 0, service_type: "teleport" },
        coverage: { starts: "soon", ends: 1, status: "unknown", amount: 120001, amountRemaining: 0 },
        product: { referenceId: "r".repeat(150), name: "n".repeat(250), purchasePrice: 1.5, manufacturerWarrantyLengthParts: -12, manufacturerWarrantyLengthLabor: 1 },
      }),
      RECEIVED,
    );
    expect(sparse.ok).toBe(true);
    expect(sparse.event.payload).toEqual({
      system: "Extend",
      contractId: `extend:contract:${extendUuid("c0", 1)}`,
      status: "live",
      covering: true,
      test: true,
      coverageAmount: 120001,
      coverageRemaining: 0,
      currency: "USD",
      purchasePrice: 4901,
      cancelledAt: "2026-01-01T00:00:00.000Z",
      refundedAt: "2026-01-01T00:00:00.000Z",
      cancellationReason: "customer_requested",
      product: { referenceId: "r".repeat(100), name: "n".repeat(200), warrantyMonthsLabor: 1 },
    });
    expect(sparse.event.occurredAt).toBe("2026-01-01T01:30:00.000Z");
    // With no update time, the creation time stands in.
    expect(extendContractEvent(contract({ updatedAt: null }), RECEIVED).event.occurredAt).toBe("2026-01-01T01:00:00.000Z");
    expect(extendContractEvent(contract({ cancellationReason: "bored", plan: null, product: [] }), RECEIVED).event.payload).not.toHaveProperty("cancellationReason");
    expect(extendContractEvent(contract({ product: null }), RECEIVED).event.payload.product).toEqual({});
    expect(extendContractEvent(contract({ purchasePrice: 0 }), RECEIVED).event.payload.purchasePrice).toBe(0);
  });

  it("dead-letters a contract that doesn't read, listing what was wrong", () => {
    const bad = extendContractEvent(contract({ id: "a b", status: "LIVE", purchaseCurrency: "usd", purchasePrice: "49", createdAt: null, updatedAt: null }), RECEIVED);
    expect(bad.ok).toBe(false);
    expect(bad.updatedAt).toBeUndefined();
    expect(bad.event).toMatchObject({ type: "warranty.contract_updated", occurredAt: undefined, receivedAt: RECEIVED });
    expect(bad.event.idempotencyKey).toMatch(/^extend:unreadable_contract:[0-9a-f]{12}$/);
    expect(bad.event.payload).toEqual({
      system: "Extend",
      kind: "contract",
      problems: ["contract has no id that reads", "contract has no status that reads", "contract has no currency that reads", "contract has no purchase price that reads", "contract has no time that reads"],
    });
    for (const raw of [null, 5, "x", [contract()]]) {
      const r = extendContractEvent(raw, RECEIVED);
      expect([r.ok, (r.event.payload.problems as string[])[0]], JSON.stringify(raw).slice(0, 20)).toEqual([false, "contract is not an object"]);
    }
    for (const over of [{ id: null }, { status: null }, { purchaseCurrency: "US" }, { purchasePrice: -1 }, { updatedAt: 1, createdAt: 1 }]) {
      const r = extendContractEvent(contract(over), RECEIVED);
      expect((r.event.payload.problems as string[]).length, JSON.stringify(over)).toBe(1);
    }
    // The same unreadable record always gets the same key.
    expect(extendContractEvent({ id: 1 }, RECEIVED).event.idempotencyKey).toBe(extendContractEvent({ id: 1 }, "2026-11-12T00:00:00.000Z").event.idempotencyKey);
    expect(extendContractEvent({ id: 1 }, RECEIVED).event.idempotencyKey).not.toBe(extendContractEvent({ id: 2 }, RECEIVED).event.idempotencyKey);
  });

  it("reads an order as its status and totals, without the customer or gift", () => {
    const raw = order();
    const { ok, event, updatedAt } = extendOrderEvent(raw, RECEIVED);
    const id = extendUuid("0d", 1);
    expect(ok).toBe(true);
    expect(event).toMatchObject({ type: "order.updated", occurredAt: "2026-01-01T01:30:00.000Z", receivedAt: RECEIVED });
    expect(updatedAt).toBe("2026-01-01T01:30:00.000Z");
    expect(event.idempotencyKey).toMatch(new RegExp(`^extend:order:${id}:[0-9a-f]{16}$`));
    expect(event.payload).toEqual({
      system: "Extend",
      orderId: `extend:order:${id}`,
      createdAt: "2026-01-01T01:00:00.000Z",
      status: "OPEN",
      cancelled: false,
      refunded: false,
      test: false,
      transactionId: "TEST-ORDER-1",
      customerId: "cust-1",
      currency: "USD",
      subtotalCents: 120001,
      shippingCents: 0,
      taxCents: 9600,
      shippingTaxCents: 0,
      discountCents: 0,
      totalCents: 129601,
      lineCount: 1,
    });
    expect(JSON.stringify(event.payload)).not.toMatch(/Test Customer|example\.test|555|Recipient|PO-TEST|Test Jeweler/);
    assertSynthetic(event.payload);
    expect(extendOrderEvent(raw, "2026-11-12T00:00:00.000Z").event.idempotencyKey).toBe(event.idempotencyKey);
    expect(extendOrderEvent({ ...raw, total: 1 }, RECEIVED).event.idempotencyKey).not.toBe(event.idempotencyKey);
  });

  it("maps each order status, and leaves out what isn't there or doesn't read", () => {
    const expected: [string, string, boolean, boolean][] = [
      ["pending", "PENDING", false, false],
      ["open", "OPEN", false, false],
      ["closed", "CLOSED", false, false],
      ["canceled", "CANCELLED", true, false],
      ["voided", "VOIDED", true, false],
      ["refunded", "REFUNDED", false, true],
      ["inactive", "INACTIVE", false, false],
    ];
    for (const [status, name, cancelled, refunded] of expected) {
      const { ok, event } = extendOrderEvent(order({ status }), RECEIVED);
      expect([ok, event.payload.status, event.payload.cancelled, event.payload.refunded], status).toEqual([true, name, cancelled, refunded]);
    }
    for (const status of [undefined, null]) {
      const { ok, event } = extendOrderEvent(order({ status }), RECEIVED);
      expect(ok).toBe(true);
      for (const key of ["status", "cancelled", "refunded"]) expect(event.payload, String(status)).not.toHaveProperty(key);
    }
    const sparse = extendOrderEvent(
      order({ isTest: true, transactionId: 5, merchantCustomerId: "a b", productCostTotal: -1, shippingCostTotal: 1.5, taxCostTotal: "1", shippingTaxCostTotal: null, discountAmountTotal: 5, total: undefined, createdAt: 1767225600000, updatedAt: null, refundedAt: 1767225600, lineItems: [] }),
      RECEIVED,
    );
    expect(sparse.ok).toBe(true);
    expect(sparse.event.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(sparse.event.payload).toEqual({
      system: "Extend",
      orderId: `extend:order:${extendUuid("0d", 1)}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "OPEN",
      cancelled: false,
      refunded: false,
      refundedAt: "2026-01-01T00:00:00.000Z",
      test: true,
      currency: "USD",
      discountCents: 5,
      lineCount: 0,
    });
  });

  it("dead-letters an order that doesn't read, listing what was wrong", () => {
    const bad = extendOrderEvent(order({ id: "", currency: "dollars", status: "shipped", createdAt: 5, updatedAt: "now", lineItems: "x" }), RECEIVED);
    expect([bad.ok, bad.event.occurredAt, bad.updatedAt]).toEqual([false, undefined, undefined]);
    expect(bad.event.idempotencyKey).toMatch(/^extend:unreadable_order:[0-9a-f]{12}$/);
    expect(bad.event.payload).toEqual({
      system: "Extend",
      kind: "order",
      problems: ["order has no id that reads", "order has no currency that reads", "order has a status that doesn't read", "order has no time that reads", "order has no line items that read"],
    });
    for (const raw of [null, [], 7]) expect((extendOrderEvent(raw, RECEIVED).event.payload.problems as string[])[0]).toBe("order is not an object");
    expect((extendOrderEvent(order({ status: 5 }), RECEIVED).event.payload.problems as string[])).toEqual(["order has a status that doesn't read"]);
    expect((extendOrderEvent(order({ lineItems: undefined }), RECEIVED).event.payload.problems as string[])).toEqual(["order has no line items that read"]);
  });
});

describe("Extend connector", () => {
  it("passes the shared sync checks", async () => {
    // Three contracts in one batch, and three orders over two pages of two.
    const result = await checkConnectorSync({ makeConnector: () => connector(extendDocMock(account({ pageSize: 2 }))), payloadSchemas: SCHEMAS, expected: { ingested: 6 } });
    expect(result.full.batches).toBe(3);
    expect(parseExtendCursor(result.full.cursor)).toEqual({ step: null, page: null, since: null, started: NOW_MS });
  });

  it("imports every contract, then every order page by page, and stops for good", async () => {
    reset();
    const mock = extendDocMock({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, contracts: extendContract.many(4), orders: [...extendOrder.many(EXTEND_MOCK_PAGE_SIZE + 1)].reverse() });
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 4 + EXTEND_MOCK_PAGE_SIZE + 1, deadLettered: 0, batches: 3 });
    expect(reads(mock)).toEqual(["/contracts/search first", "/orders/search first", "/orders/search next"]);
    expect(mock.reads[0]!.query).toEqual({ sellerId: STORE, typeFilter: "pcrs", showAll: "true" });
    expect(mock.reads[1]!.query).toEqual({ storeId: STORE });
    expect(mock.tokens).toHaveLength(1);
    expect(memory.events.filter((e) => e.type === "warranty.contract_updated")).toHaveLength(4);
    expect(memory.events.filter((e) => e.type === "order.updated").at(-1)!.payload.orderId).toBe(`extend:order:${extendUuid("0d", 501)}`);
    assertSynthetic(memory.events.map((e) => e.payload));
    expect(JSON.stringify(memory.events.map((e) => e.payload))).not.toMatch(/Test Customer|example\.test|Test Street|Recipient/);
    expect(parseExtendCursor(report.cursor)).toEqual({ step: null, page: null, since: null, started: NOW_MS });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect([again.ingested, mock.reads.length]).toEqual([0, 3]);
  });

  it("checkpoints each read with Extend's cursor, and resumes the import from it", async () => {
    const data = account({ pageSize: 1 });
    const all = await drain(connector(extendDocMock(data)).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const cursors = all.map((b) => parseExtendCursor(b.cursor)!);
    expect(cursors.map((c) => [c.step, c.page === null, c.since, c.started])).toEqual([
      ["orders", true, null, NOW_MS],
      ["orders", false, null, NOW_MS],
      ["orders", false, null, NOW_MS],
      [null, true, null, NOW_MS],
    ]);
    expect(all.map((b) => b.events.length)).toEqual([3, 1, 1, 1]);
    const mock = extendDocMock(data);
    const resumed = await drain(connector(mock, { now: () => new Date(NOW_MS + DAY) }).historicalImport({ organizationId: TEST_ORG, cursor: all[1]!.cursor }));
    expect(reads(mock)).toEqual(["/orders/search next", "/orders/search next"]);
    expect(mock.reads[0]!.query.cursor).toBe(cursors[1]!.page);
    expect(eventsOf(resumed).map((e) => e.payload.orderId)).toEqual([`extend:order:${extendUuid("0d", 2)}`, `extend:order:${extendUuid("0d", 3)}`]);
    // A resumed pass keeps the time it started.
    expect(parseExtendCursor(resumed.at(-1)!.cursor)!.started).toBe(NOW_MS);
    const done = extendDocMock(data);
    expect(await drain(connector(done).historicalImport({ organizationId: TEST_ORG, cursor: all[3]!.cursor }))).toEqual([]);
    expect([done.reads, done.tokens]).toEqual([[], []]);
  });

  it("keeps only what Extend updated in the last 30 days on a first later sync", async () => {
    const at = (daysAgo: number) => NOW_MS - daysAgo * DAY;
    const edge = at(EXTEND_WINDOW_DAYS);
    const data = account({
      contracts: [contract({ id: "c-new", updatedAt: at(1) }), contract({ id: "c-edge", updatedAt: edge }), contract({ id: "c-old", updatedAt: edge - 1 }), contract({ id: "c-bad", status: "?", updatedAt: at(400) })],
      orders: [order({ id: "o-new", updatedAt: Math.floor(at(2) / 1000) }), order({ id: "o-old", updatedAt: Math.floor(edge / 1000) - 1 }), order({ id: "o-created", updatedAt: null, createdAt: at(3) })],
    });
    const events = eventsOf(await drain(connector(extendDocMock(data)).incrementalSync({ organizationId: TEST_ORG, cursor: null })));
    expect(EXTEND_WINDOW_DAYS).toBe(30);
    expect(events.map((e) => e.payload.contractId ?? e.payload.orderId ?? e.payload.kind)).toEqual(["extend:contract:c-new", "extend:contract:c-edge", "contract", "extend:order:o-new", "extend:order:o-created"]);
  });

  it("keeps what changed since a day before the last pass started, and resumes a later sync at its saved page", async () => {
    const started = NOW_MS - 7 * DAY;
    const since = started - EXTEND_OVERLAP_MS;
    expect(EXTEND_OVERLAP_MS).toBe(DAY);
    const data = account({
      pageSize: 1,
      contracts: [contract({ id: "c-in", updatedAt: since }), contract({ id: "c-out", updatedAt: since - 1 })],
      orders: [order({ id: "o-in", createdAt: since / 1000, updatedAt: since / 1000 }), order({ id: "o-out", createdAt: since / 1000 + 1, updatedAt: since / 1000 - 1 })],
    });
    const mock = extendDocMock(data);
    const batches = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ step: null, page: null, since: null, started }) }));
    expect(eventsOf(batches).map((e) => e.payload.contractId ?? e.payload.orderId)).toEqual(["extend:contract:c-in", "extend:order:o-in"]);
    expect(reads(mock)).toEqual(["/contracts/search first", "/orders/search first", "/orders/search next"]);
    expect(batches.map((b) => parseExtendCursor(b.cursor))).toEqual([
      { step: "orders", page: null, since, started: NOW_MS },
      { step: "orders", page: expect.any(String), since, started: NOW_MS },
      { step: null, page: null, since, started: NOW_MS },
    ]);
    // Saved at the second page, a later sync goes on from there with the window it had.
    const resumed = extendDocMock(data);
    const out = await drain(connector(resumed).incrementalSync({ organizationId: TEST_ORG, cursor: batches[1]!.cursor }));
    expect([reads(resumed), eventsOf(out)]).toEqual([["/orders/search next"], []]);
    // A pass that started before 1970 plus a day doesn't go below zero.
    const early = await drain(connector(extendDocMock(account())).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ step: null, page: null, since: null, started: 5 }) }));
    expect(parseExtendCursor(early.at(-1)!.cursor)!.since).toBe(0);
    // Saved before the contracts, a later sync starts with them; a cursor Extend gave is sent back as it was.
    const fake: ExtendClient = {
      baseUrl: PROD,
      contracts: async () => [contract()],
      orders: async (cursor) => (expect(cursor).toBe("opaque-1"), { orders: [], nextCursor: null }),
    };
    const saved: ExtendCursor = { step: "orders", page: "opaque-1", since: 0, started: 1 };
    expect(await drain(extendConnector({ ...options(extendDocMock(account())), client: fake }).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }))).toHaveLength(1);
    const fromContracts = await drain(
      extendConnector({ ...options(extendDocMock(account())), client: { ...fake, orders: async () => ({ orders: [], nextCursor: null }) } }).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ step: "contracts", page: null, since: 0, started: 1 }) }),
    );
    expect(eventsOf(fromContracts).map((e) => e.type)).toEqual(["warranty.contract_updated"]);
  });

  it("keeps what doesn't read as dead letters, on every pass", async () => {
    const data = account();
    data.contracts![0] = { ...data.contracts![0]!, status: "?" };
    data.orders![1] = { ...data.orders![1]!, currency: null };
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(extendDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 4, deadLettered: 2 });
    const later = await runSync({ connector: connector(extendDocMock(data)), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(later).toMatchObject({ ingested: 0, deadLettered: 2 });
  });

  it("stops on credentials or a store Extend turns down, without a checkpoint or a secret in the message", async () => {
    const wrong = extendDocMock({ ...account(), clientSecret: "another-secret-1234" });
    const { memory, pipeline } = testPipeline();
    await expect(runSync({ connector: connector(wrong), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: noSleep })).rejects.toThrow(ExtendConfigError);
    expect(await memory.getCheckpoint(TEST_ORG, "extend", "historical")).toBeNull();
    expect(wrong.reads).toHaveLength(0);
    const other = extendDocMock(account({ storeId: extendUuid("0ee", 9) }));
    const error = await drain(connector(other).historicalImport({ organizationId: TEST_ORG, cursor: null })).then(() => null, (e: unknown) => e as Error);
    expect(error).toEqual(new ExtendConfigError("Extend turned down the token for the contracts (HTTP 403, forbidden); EXTEND_STORE_ID must be the store the API Integration in EXTEND_CLIENT_ID was made for"));
    expect(error!.message).not.toContain(CLIENT_SECRET);
  });

  it("waits out Extend's rate limit and carries on, and reads the demo environment when asked", async () => {
    const slept: number[] = [];
    const mock = extendDocMock(account({ rateLimits: 2 }));
    const events = eventsOf(await drain(connector(mock, { sleep: async (ms) => void slept.push(ms) }).historicalImport({ organizationId: TEST_ORG, cursor: null })));
    expect([events.length, slept]).toEqual([6, [1000, 1000]]);
    const demo = extendDocMock(account({ baseUrl: EXTEND_MOCK_BASES.demo }));
    expect(eventsOf(await drain(connector(demo, { environment: "demo" }).historicalImport({ organizationId: TEST_ORG, cursor: null })))).toHaveLength(6);
    await expect(drain(connector(demo).historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow(UndocumentedRequestError);
  });

  it("uses the real clock by default, and declares its write, turned down", async () => {
    const before = Date.now();
    const out = await drain(extendConnector({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, storeId: STORE, fetch: extendDocMock(account()).fetch, sleep: noSleep }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(Date.parse(eventsOf(out)[0]!.receivedAt)).toBeGreaterThanOrEqual(before);
    expect(parseExtendCursor(out.at(-1)!.cursor)!.started).toBeGreaterThanOrEqual(before);
    const c = connector(extendDocMock(account()));
    expect(c.source).toBe("extend");
    expect(c.writes).toBe(EXTEND_WRITES);
    expect(EXTEND_WRITES).toEqual([{ integration: "extend", name: "cancel_order", description: "Cancel an Extend order and the protection plans on it", kind: "update", approval: "each", dailyCap: 5 }]);
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: READ_ONLY, audit });
    let performed = false;
    for (const action of c.writes ?? []) {
      await expect(gate.run(action, "extend-test", async () => void (performed = true))).rejects.toBeInstanceOf(WritesDisabledError);
    }
    expect(performed).toBe(false);
    expect(audit.entries).toMatchObject([{ action: "cancel_order", integration: "extend" }]);
    expect(audit.entries.map((e) => e.outcome)).not.toContain("performed");
  });

  it("turns down a checkpoint that isn't its own", () => {
    const good: ExtendCursor[] = [
      { step: "contracts", page: null, since: null, started: 0 },
      { step: "orders", page: null, since: 0, started: NOW_MS },
      { step: "orders", page: "c".repeat(4096), since: NOW_MS, started: NOW_MS },
      { step: null, page: null, since: null, started: NOW_MS },
    ];
    expect(parseExtendCursor(null)).toBeNull();
    for (const c of good) expect(parseExtendCursor(JSON.stringify(c))).toEqual(c);
    const bad: unknown[] = [
      "{",
      "null",
      "[]",
      "5",
      {},
      { step: "orders", page: null, since: null },
      { step: "orders", page: null, since: null, started: 0, extra: 1 },
      { step: "claims", page: null, since: null, started: 0 },
      { step: "contracts", page: "abc", since: null, started: 0 },
      { step: null, page: "abc", since: null, started: 0 },
      { step: "orders", page: "", since: null, started: 0 },
      { step: "orders", page: "a b", since: null, started: 0 },
      { step: "orders", page: "c".repeat(4097), since: null, started: 0 },
      { step: "orders", page: 5, since: null, started: 0 },
      { step: "orders", page: null, since: -1, started: 0 },
      { step: "orders", page: null, since: 1.5, started: 0 },
      { step: "orders", page: null, since: "0", started: 0 },
      { step: "orders", page: null, since: null, started: null },
      { step: "orders", page: null, since: null, started: -1 },
      // Another connector's checkpoints.
      { done: true, step: null, page: null },
      { pass: "historical", step: 0, offset: 0, since: 0, nextSince: 0 },
    ];
    for (const raw of bad) expect(() => parseExtendCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("Extend checkpoint is not in the expected shape");
  });
});

describe("Extend doc mock", () => {
  const token = async (mock: ExtendMock, body: unknown = { grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, client_assertion: EXTEND_CLIENT_ASSERTION }, contentType = "application/json") =>
    mock.fetch(`${PROD}/auth/oauth/token`, { method: "POST", headers: { "content-type": contentType }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const issue = async (mock: ExtendMock) => ((await (await token(mock)).json()) as { access_token: string }).access_token;
  const get = async (mock: ExtendMock, path: string, headers: Record<string, string> = {}) => mock.fetch(`${PROD}${path}`, { headers: { accept: EXTEND_ACCEPT, "x-extend-access-token": await issue(mock), ...headers } });
  const body = async (response: Response) => (await response.json()) as { code?: string; contracts?: { id: string }[]; orders?: { id: string }[]; nextPageCursor?: string; limit?: number };

  it("uses only synthetic data, and says where it came from", () => {
    const data = account();
    assertSynthetic([data.contracts, data.orders]);
    const { mock } = extendDocMock(data);
    expect(mock.source).toEqual({ url: EXTEND_DOC_PAGES.contracts, title: "Extend API reference: Search Contracts", retrievedOn: "2026-11-11", version: "2022-02-01" });
    expect(mock.routes.map((r) => `${r.method} ${r.path} ${r.documentedAt}`)).toEqual([
      `POST /auth/oauth/token ${EXTEND_DOC_PAGES.authentication}`,
      `GET /contracts/search ${EXTEND_DOC_PAGES.contracts}`,
      `GET /orders/search ${EXTEND_DOC_PAGES.orders}`,
    ]);
    const module = DOC_MOCK_MODULES.find((m) => m.integration === "extend")!;
    expect(module.watchPages).toEqual(Object.values(EXTEND_DOC_PAGES));
    expect(module.docMocks().map((m) => m.integration)).toEqual(["extend"]);
    expect(Object.values(EXTEND_DOC_PAGES).every((u) => u.startsWith("https://docs.extend.com/reference/"))).toBe(true);
    expect(EXTEND_MOCK_BASES).toEqual(EXTEND_API_URLS);
  });

  it("issues a token only for the documented request and the right credentials", async () => {
    const mock = extendDocMock(account());
    const ok = await token(mock);
    expect(await ok.json()).toEqual({ access_token: "mock.token.00000001", token_type: "Bearer", expires_in: 3600 });
    expect((await token(mock, "{", "application/json")).status).toBe(400);
    expect((await token(mock, {}, "text/plain")).status).toBe(400);
    expect((await token(mock, { grant_type: "password", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, client_assertion: EXTEND_CLIENT_ASSERTION })).status).toBe(400);
    expect((await token(mock, { grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET })).status).toBe(400);
    const wrong = await token(mock, { grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: "nope", client_assertion: EXTEND_CLIENT_ASSERTION });
    expect([wrong.status, (await body(wrong)).code]).toEqual([401, "invalid_client"]);
    expect(mock.tokens).toEqual([{ grant_type: "client_credentials", client_assertion: EXTEND_CLIENT_ASSERTION }]);
    expect(await (await token(extendDocMock(account({ expiresIn: null })))).json()).toEqual({ access_token: "mock.token.00000001", token_type: "Bearer" });
  });

  it("checks the token and version header of each search", async () => {
    const mock = extendDocMock(account());
    const none = await mock.fetch(`${PROD}/orders/search?storeId=${STORE}`, { headers: { accept: EXTEND_ACCEPT } });
    expect([none.status, (await body(none)).code]).toEqual([401, "unauthorized"]);
    expect((await get(mock, `/orders/search?storeId=${STORE}`, { accept: "application/json" })).status).toBe(400);
    expect((await get(mock, `/orders/search?storeId=${STORE}`, { accept: "application/json;version=2021-04-01" })).status).toBe(200);
  });

  it("searches contracts by seller and type, all at once, as the docs say", async () => {
    const data = account();
    data.contracts!.push(contract({ id: "ship-1", type: "shipping_protection" }), contract({ id: "exp-1", status: "expired" }));
    const mock = extendDocMock(data);
    const all = await body(await get(mock, `/contracts/search?sellerId=${STORE}`));
    expect(all.contracts!.map((c) => c.id)).toEqual([extendUuid("c0", 1), extendUuid("c0", 2), extendUuid("c0", 3), "exp-1"]);
    expect(Object.keys(all)).toEqual(["contracts"]);
    expect((await body(await get(mock, `/contracts/search?sellerId=${STORE}&typeFilter=shipping_protection`))).contracts!.map((c) => c.id)).toEqual(["ship-1"]);
    expect((await body(await get(mock, `/contracts/search?sellerId=${STORE}&typeFilter=pcrs,shipping_protection&status=expired&showAll=false`))).contracts!.map((c) => c.id)).toEqual(["exp-1"]);
    for (const q of ["", "?typeFilter=pcrs", `?sellerId=${STORE}&typeFilter=warranty`, `?sellerId=${STORE}&showAll=yes`, `?sellerId=${STORE}&updatedSince=1`]) {
      expect((await get(mock, `/contracts/search${q}`)).status, q).toBe(400);
    }
    const other = await get(mock, `/contracts/search?sellerId=${extendUuid("0ee", 9)}`);
    expect([other.status, (await body(other)).code]).toEqual([403, "forbidden"]);
  });

  it("pages orders oldest first with nextPageCursor, one search parameter at a time", async () => {
    reset();
    const mock = extendDocMock({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, orders: [...extendOrder.many(3)].reverse(), pageSize: 2 });
    const first = await body(await get(mock, `/orders/search?storeId=${STORE}`));
    expect([first.orders!.map((o) => o.id), first.limit]).toEqual([[extendUuid("0d", 1), extendUuid("0d", 2)], 2]);
    const next = await body(await get(mock, `/orders/search?storeId=${STORE}&cursor=${encodeURIComponent(first.nextPageCursor!)}`));
    expect([next.orders!.map((o) => o.id), next.nextPageCursor]).toEqual([[extendUuid("0d", 3)], undefined]);
    for (const q of ["", `?storeId=${STORE}&transactionId=T1`, "?transactionId=T1", `?storeId=${STORE}&cursor=junk`, `?storeId=${STORE}&limit=5`]) {
      expect((await get(mock, `/orders/search${q}`)).status, q).toBe(400);
    }
    expect((await get(mock, `/orders/search?storeId=${extendUuid("0ee", 9)}`)).status).toBe(403);
    expect((await body(await get(extendDocMock({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }), `/orders/search?storeId=${STORE}`))).orders).toEqual([]);
  });

  it("answers 429 with Retry-After", async () => {
    const mock = extendDocMock(account({ rateLimits: 1 }));
    const limited = await token(mock);
    expect([limited.status, limited.headers.get("retry-after"), (await body(limited)).code]).toEqual([429, "1", "too_many_requests"]);
    expect((await token(mock)).status).toBe(200);
  });

  it("throws on a look-alike host and anything the docs don't list", async () => {
    const mock = extendDocMock(account());
    await expect(mock.fetch("https://api.helloextend.com.example.test/orders/search", {})).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${PROD}/orders`, { method: "POST", body: "{}" })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${PROD}/contracts/${extendUuid("c0", 1)}`, { method: "PUT", body: "{}" })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${PROD}/service-orders/search?claimId=x`, {})).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${PROD}/contracts/search`, { method: "POST", body: "{}" })).rejects.toThrow(UndocumentedRequestError);
    expect(mock.fetch.calls).toEqual([]);
  });
});
