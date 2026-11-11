import { describe, expect, it, vi } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import {
  EJEWELRY_DOC_PAGES,
  EJEWELRY_TEST_CLIENT,
  EJEWELRY_TEST_COMPANY,
  EJEWELRY_TEST_ENVIRONMENT,
  EJEWELRY_TEST_TENANT,
  TEST_ORG,
  UndocumentedRequestError,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  eJewelryDocMock,
  eJewelryGuid,
  eJewelryItem,
  eJewelryPurchaseInvoice,
  eJewelrySalesInvoice,
  eJewelryTime,
  eJewelryVendor,
  testPipeline,
  type EJewelryMock,
  type EJewelryMockData,
} from "@karatos/connector-testkit";
import {
  EJEWELRY_API,
  EJEWELRY_FIRST_LOOKBACK_MS,
  EJEWELRY_LISTS,
  EJEWELRY_OVERLAP_MS,
  EJEWELRY_SCOPE,
  EJEWELRY_SPACING_MS,
  EJEWELRY_TIME,
  EJEWELRY_WRITES,
  EJewelryApiError,
  EJewelryConfigError,
  eJewelryBillEvent,
  eJewelryCents,
  eJewelryConnector,
  eJewelryInstant,
  eJewelryInvoiceEvent,
  eJewelryItemEvent,
  eJewelryVendorEvent,
  ejewelryClient,
  parseEJewelryCursor,
  type EJewelryClient,
  type EJewelryCursor,
  type EJewelryEvent,
  type EJewelryList,
  type EJewelryOptions,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const SECRET = ["sec", "r".repeat(13), "~!"].join("");
const settings = { tenantId: EJEWELRY_TEST_TENANT, environment: EJEWELRY_TEST_ENVIRONMENT, companyId: EJEWELRY_TEST_COMPANY, clientId: EJEWELRY_TEST_CLIENT, clientSecret: SECRET };
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const FIVE_YEARS = "2021-11-11T15:00:00.000Z";
const LOGIN_URL = `https://login.microsoftonline.com/${EJEWELRY_TEST_TENANT}/oauth2/v2.0/token`;
const BASE = `${EJEWELRY_API}/v2.0/${EJEWELRY_TEST_TENANT}/production/api/v2.0/companies(${EJEWELRY_TEST_COMPANY})`;
const noSleep = async () => {};
const ctx = { receivedAt: RECEIVED };
const T = eJewelryTime;

function resetFixtures() {
  for (const b of [eJewelryItem, eJewelryVendor, eJewelrySalesInvoice, eJewelryPurchaseInvoice]) b.reset();
}

/** A tenant with two items, a vendor, a sales invoice and a purchase invoice. */
function account(overrides: Partial<EJewelryMockData> = {}): EJewelryMockData {
  resetFixtures();
  return {
    tenantId: EJEWELRY_TEST_TENANT,
    clientId: EJEWELRY_TEST_CLIENT,
    clientSecret: SECRET,
    items: eJewelryItem.many(2),
    vendors: [eJewelryVendor.one()],
    salesInvoices: [eJewelrySalesInvoice.one({ lastModifiedDateTime: T(10) })],
    purchaseInvoices: [eJewelryPurchaseInvoice.one({ lastModifiedDateTime: T(20) })],
    ...overrides,
  };
}

const connector = (mock: EJewelryMock, overrides: Partial<EJewelryOptions> = {}) => eJewelryConnector({ ...settings, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as EJewelryEvent[];

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch that answers from a list of responses in turn (the last repeats), keeping what was sent. */
function scripted(responses: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string | undefined });
    return responses[Math.min(sent.length - 1, responses.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const token = (expires: unknown = 3599, value: unknown = "tok-1") => json(200, { token_type: "Bearer", expires_in: expires, access_token: value });
const list = (value: unknown[], next?: unknown) => json(200, { value, ...(next === undefined ? {} : { "@odata.nextLink": next }) });

/** A client with a clock that moves only when it sleeps, so spacing and token times are exact. */
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof ejewelryClient>[0]> = {}) => {
  const slept: number[] = [];
  const clock = { t: 1_000_000 };
  const c = ejewelryClient({ ...settings, fetch, sleep: async (ms) => void (slept.push(ms), (clock.t += ms)), clock: () => clock.t, ...extra });
  return { c, slept, clock };
};

describe("e-Jewelry client", () => {
  it("checks its settings before sending anything", () => {
    const bad: [Partial<typeof settings>, string][] = [
      [{ tenantId: "" }, "EJEWELRY_TENANT_ID is missing or not in the expected shape"],
      [{ tenantId: "contoso.onmicrosoft.com" }, "EJEWELRY_TENANT_ID"],
      [{ tenantId: `${EJEWELRY_TEST_TENANT}0` }, "EJEWELRY_TENANT_ID"],
      [{ environment: "" }, "EJEWELRY_ENVIRONMENT"],
      [{ environment: "prod/uction" }, "EJEWELRY_ENVIRONMENT"],
      [{ environment: "p".repeat(51) }, "EJEWELRY_ENVIRONMENT"],
      [{ companyId: "CRONUS" }, "EJEWELRY_COMPANY_ID"],
      [{ clientId: "app" }, "EJEWELRY_CLIENT_ID"],
      [{ clientSecret: "s".repeat(15) }, "EJEWELRY_CLIENT_SECRET"],
      [{ clientSecret: `${"s".repeat(16)} x` }, "EJEWELRY_CLIENT_SECRET"],
      [{ clientSecret: "s".repeat(201) }, "EJEWELRY_CLIENT_SECRET"],
    ];
    for (const [change, message] of bad) {
      expect(() => ejewelryClient({ ...settings, ...change, fetch: () => Promise.reject(new Error("sent")) }), JSON.stringify(change)).toThrow(message);
      expect(() => ejewelryClient({ ...settings, ...change }), JSON.stringify(change)).toThrow(EJewelryConfigError);
    }
    expect(() => ejewelryClient({ ...settings, tenantId: undefined as unknown as string })).toThrow("EJEWELRY_TENANT_ID");
    // Settings are trimmed, GUIDs read in either case, and the longest shapes pass.
    const c = ejewelryClient({ ...settings, tenantId: ` ${EJEWELRY_TEST_TENANT.toUpperCase()} `, environment: "p".repeat(50), clientSecret: "s".repeat(200) });
    expect(c.listUrl("items")).toBe(`${EJEWELRY_API}/v2.0/${EJEWELRY_TEST_TENANT.toUpperCase()}/${"p".repeat(50)}/api/v2.0/companies(${EJEWELRY_TEST_COMPANY})/items`);
    expect(new EJewelryConfigError("x").name).toBe("EJewelryConfigError");
    expect(new EJewelryApiError("x", 500)).toMatchObject({ name: "EJewelryApiError", status: 500 });
  });

  it("signs in with the client credentials, then sends read-only GETs with the token", async () => {
    const { fetch, sent } = scripted([token(), list([{ id: 1 }]), list([])]);
    const { c } = client(fetch);
    expect(c.listUrl("vendors")).toBe(`${BASE}/vendors`);
    expect(await c.page("items", null, null)).toEqual({ rows: [{ id: 1 }], next: null });
    await c.page("salesInvoices", "2026-01-01T00:00:00Z", null);
    expect(sent[0]).toEqual({ url: LOGIN_URL, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: EJEWELRY_TEST_CLIENT, client_secret: SECRET, scope: `${EJEWELRY_API}/.default` }).toString() });
    expect(EJEWELRY_SCOPE).toBe("https://api.businesscentral.dynamics.com/.default");
    const get = { authorization: "Bearer tok-1", accept: "application/json", "data-access-intent": "ReadOnly" };
    expect(sent[1]).toEqual({ url: `${BASE}/items`, method: "GET", headers: get, body: undefined });
    expect(sent[2]).toEqual({ url: `${BASE}/salesInvoices?%24filter=lastModifiedDateTime+ge+2026-01-01T00%3A00%3A00Z`, method: "GET", headers: get, body: undefined });
    expect(sent).toHaveLength(3);
  });

  it("follows a next link as given", async () => {
    const next = `${BASE}/items?$skiptoken=abc`;
    const { fetch, sent } = scripted([token(), list([{ id: 1 }], next), list([])]);
    const { c } = client(fetch);
    expect(await c.page("items", null, null)).toEqual({ rows: [{ id: 1 }], next });
    await c.page("items", "2026-01-01T00:00:00Z", next);
    expect(sent[2]!.url).toBe(next);
  });

  it("keeps a token until five minutes before it lapses", async () => {
    const { fetch, sent } = scripted([token(400), list([]), list([]), token(400, "tok-2"), list([])]);
    const { c, clock } = client(fetch);
    await c.page("items", null, null);
    clock.t += 100_000 - EJEWELRY_SPACING_MS - 1;
    await c.page("items", null, null);
    expect(sent.filter((s) => s.url === LOGIN_URL)).toHaveLength(1);
    clock.t += 1;
    await c.page("items", null, null);
    expect(sent.map((s) => s.url === LOGIN_URL)).toEqual([true, false, false, true, false]);
    expect(sent[4]!.headers.authorization).toBe("Bearer tok-2");
  });

  it("spaces calls a tenth of a second apart", async () => {
    const { fetch } = scripted([token(), list([])]);
    const { c, slept, clock } = client(fetch);
    await c.page("items", null, null);
    expect(slept).toEqual([EJEWELRY_SPACING_MS]);
    clock.t += 30;
    await c.page("items", null, null);
    expect(slept).toEqual([100, 70]);
    clock.t += 100;
    await c.page("items", null, null);
    expect(slept).toEqual([100, 70]);
    expect(EJEWELRY_SPACING_MS).toBe(100);
  });

  it("fetches a token again once when a call is turned down, and stops on a second", async () => {
    const twice = scripted([token(), json(401, {}), token(3599, "tok-2"), list([{ id: 2 }])]);
    expect((await client(twice.fetch).c.page("items", null, null)).rows).toEqual([{ id: 2 }]);
    expect(twice.sent.map((s) => s.headers.authorization)).toEqual([undefined, "Bearer tok-1", undefined, "Bearer tok-2"]);
    const always = scripted([token(), json(401, {}), token(), json(401, {})]);
    await expect(client(always.fetch).c.page("items", null, null)).rejects.toThrow(new EJewelryConfigError("Business Central turned down the app's token: check the app is enabled on the Microsoft Entra Applications page"));
    expect(always.sent).toHaveLength(4);
  });

  it("explains a list it may not read, a wrong company, and other answers", async () => {
    const at = async (response: () => Response) => client(scripted([token(), response]).fetch, { retries: 0 }).c.page("vendors", null, null);
    await expect(at(json(403, {}))).rejects.toThrow(new EJewelryConfigError("The app can't read vendors: give it a read-only permission set that covers them in Business Central"));
    await expect(at(json(404, {}))).rejects.toThrow(new EJewelryConfigError("Business Central has no such company: check EJEWELRY_ENVIRONMENT and EJEWELRY_COMPANY_ID"));
    await expect(at(json(418, {}))).rejects.toMatchObject({ name: "EJewelryApiError", status: 418, message: "Business Central answered HTTP 418 for vendors" });
    await expect(at(json(201, { value: [] }))).rejects.toMatchObject({ status: 201 });
    await expect(at(() => new Response("{", { status: 200 }))).rejects.toThrow(new EJewelryApiError("Business Central answered vendors without a list", 200));
    await expect(at(json(200, { value: {} }))).rejects.toThrow("without a list");
    await expect(at(json(200, null))).rejects.toThrow("without a list");
    await expect(at(list([], 5))).rejects.toThrow(new EJewelryApiError("Business Central answered vendors with a next link off the list", 200));
    await expect(at(list([], `${BASE}/items?$skiptoken=1`))).rejects.toThrow("off the list");
    await expect(at(list([], `${BASE}/vendors`))).rejects.toThrow("off the list");
    await expect(at(list([], `${BASE}/vendorsX?$skiptoken=1`))).rejects.toThrow("off the list");
    await expect(at(list([], null))).rejects.toThrow("off the list");
  });

  it("refuses a list, start or next link it wasn't made for, before sending anything", async () => {
    const { fetch, sent } = scripted([token()]);
    const { c } = client(fetch);
    await expect(c.page("customers" as EJewelryList, null, null)).rejects.toThrow(new EJewelryApiError("not a list KaratOS reads", 0));
    for (const since of ["2026-01-01", "2026-01-01T00:00:00", "2026-01-01T00:00:00+01:00", "2026-13-01T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00.12345678Z", "x 2026-01-01T00:00:00Z"]) {
      await expect(c.page("items", since, null), since).rejects.toThrow(new EJewelryApiError("a start must be a UTC time", 0));
    }
    for (const next of [`${BASE}/vendors?$skiptoken=1`, `${BASE}/items`, `${BASE}/itemsX?a=1`, `https://evil.example.test/?${BASE}/items?`]) {
      await expect(c.page("items", null, next), next).rejects.toThrow(new EJewelryApiError("a next link must stay on the list being read", 0));
    }
    expect(sent).toHaveLength(0);
    expect(EJEWELRY_TIME.test("2026-02-28T23:59:59.1234567Z")).toBe(true);
  });

  it("waits out a 429 or 5xx as Retry-After says, up to a minute, else 5 seconds doubling", async () => {
    const waits = async (headers: Record<string, string>, status = 429) => {
      const { fetch, sent } = scripted([token(), json(status, {}, headers), list([])]);
      const { c, slept } = client(fetch);
      await c.page("items", null, null);
      expect(sent).toHaveLength(3);
      return slept.filter((ms) => ms !== EJEWELRY_SPACING_MS);
    };
    expect(await waits({ "retry-after": "2" })).toEqual([2000]);
    expect(await waits({ "retry-after": "60" })).toEqual([60_000]);
    expect(await waits({ "retry-after": "61" })).toEqual([60_000]);
    for (const value of ["0", "-1", "1.5", "soon", ""]) expect(await waits({ "retry-after": value }), value).toEqual([5000]);
    expect(await waits({})).toEqual([5000]);
    for (const status of [500, 502, 503, 504]) expect(await waits({ "retry-after": "1" }, status), String(status)).toEqual([1000]);
    // 501 is not retried.
    const { fetch, sent } = scripted([token(), json(501, {})]);
    await expect(client(fetch).c.page("items", null, null)).rejects.toMatchObject({ status: 501 });
    expect(sent).toHaveLength(2);
  });

  it("gives up after three retries, keeping the error for runSync", async () => {
    const { fetch, sent } = scripted([token(), json(503, {})]);
    const { c, slept } = client(fetch);
    await expect(c.page("items", null, null)).rejects.toThrow(new EJewelryApiError("Business Central answered HTTP 503 for items", 503));
    expect(sent).toHaveLength(5);
    expect(slept.filter((ms) => ms > EJEWELRY_SPACING_MS)).toEqual([5000, 10_000, 20_000]);
    const once = scripted([token(), json(503, {})]);
    await expect(client(once.fetch, { retries: 1 }).c.page("items", null, null)).rejects.toMatchObject({ status: 503 });
    expect(once.sent).toHaveLength(3);
  });

  it("explains a sign-in Microsoft turns down or answers oddly", async () => {
    const signIn = async (response: () => Response) => client(scripted([response]).fetch, { retries: 0 }).c.page("items", null, null);
    const wrong = new EJewelryConfigError("Microsoft turned down EJEWELRY_CLIENT_ID and EJEWELRY_CLIENT_SECRET: check the app, its secret and EJEWELRY_TENANT_ID");
    await expect(signIn(json(400, {}))).rejects.toThrow(wrong);
    await expect(signIn(json(401, {}))).rejects.toThrow(wrong);
    await expect(signIn(json(403, {}))).rejects.toThrow(new EJewelryApiError("Microsoft answered HTTP 403 for a token", 403));
    await expect(signIn(json(503, {}))).rejects.toMatchObject({ status: 503 });
    const odd = new EJewelryApiError("Microsoft answered without a token", 200);
    for (const response of [() => new Response("{", { status: 200 }), json(200, null), token(3599, 5), token(3599, ""), token(3599, "a b"), token(3599, "t".repeat(8193)), token(0), token(-1), token(1.5), json(200, { access_token: "tok" }), token("soon")]) {
      await expect(signIn(response)).rejects.toThrow(odd);
    }
    // A token's life may come as a string, and the longest token passes.
    const { fetch, sent } = scripted([token("3599", "t".repeat(8192)), list([])]);
    await client(fetch).c.page("items", null, null);
    expect(sent[1]!.headers.authorization).toBe(`Bearer ${"t".repeat(8192)}`);
  });

  it("works with the default clock, sleep and fetch", async () => {
    const original = globalThis.fetch;
    const { fetch, sent } = scripted([token(), list([]), list([])]);
    globalThis.fetch = fetch;
    try {
      const c = ejewelryClient(settings);
      await c.page("items", null, null);
      const started = Date.now();
      await c.page("items", null, null);
      expect(Date.now() - started).toBeGreaterThanOrEqual(EJEWELRY_SPACING_MS - 5);
      expect(sent).toHaveLength(3);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("e-Jewelry events", () => {
  it("reads an item with its price, cost and stock", () => {
    resetFixtures();
    const { ok, event } = eJewelryItemEvent(eJewelryItem.one(), ctx);
    expect(ok).toBe(true);
    const payload = { system: "e-Jewelry", itemId: `bci_e_jewelry:item:${eJewelryGuid(1, 1)}`, sku: "SKU-TEST-0001", name: "Test Ring 1", kind: "inventory", category: "RINGS", active: true, unitPriceCents: 125_050, unitCostCents: 61_025, onHand: 4, unit: "PCS", changedAt: T(1) };
    expect(event.payload).toEqual(payload);
    expect(event).toMatchObject({ type: "accounting.item_updated", occurredAt: T(1), receivedAt: RECEIVED });
    expect(event.idempotencyKey).toMatch(new RegExp(`^bci_e_jewelry:item:${eJewelryGuid(1, 1)}:[0-9a-f]{12}$`));
    expect(event.id).toBe(event.idempotencyKey.replace(/:/g, "_"));
    expect(eJewelryItemEvent({ ...eJewelryItem.one(), type: "Service", blocked: true }, ctx).event.payload).toMatchObject({ kind: "service", active: false });
    expect(eJewelryItemEvent({ ...eJewelryItem.one(), type: "Non-Inventory", blocked: "false" }, ctx).event.payload).toMatchObject({ kind: "non_inventory", active: false });
    const dead = eJewelryItemEvent({ ...eJewelryItem.one(), type: "Bundle" }, ctx);
    expect(dead.ok).toBe(false);
    expect(dead.event.payload).toEqual({ system: "e-Jewelry", kind: "item", id: eJewelryGuid(1, 4), problems: ["item is not a kind KaratOS reads"] });
  });

  it("keeps each event's key until what was kept changes", () => {
    resetFixtures();
    const item = eJewelryItem.one();
    const key = eJewelryItemEvent(item, ctx).event.idempotencyKey;
    expect(eJewelryItemEvent({ ...item, gtin: "123", "@odata.etag": "W/x" }, { receivedAt: "2026-11-12T00:00:00.000Z" }).event.idempotencyKey).toBe(key);
    expect(eJewelryItemEvent({ ...item, unitPrice: 1250.51 }, ctx).event.idempotencyKey).not.toBe(key);
    expect(eJewelryItemEvent({ ...item, id: String(item.id).toUpperCase() }, ctx).event.idempotencyKey).toBe(key);
  });

  it("dead-letters a row with no id or change time, listing what was wrong", () => {
    resetFixtures();
    const item = eJewelryItem.one();
    const cases: [unknown, string, string[]][] = [
      [null, "item", ["item is not an object", "item has no id that reads", "item has no change time that reads", "item is not a kind KaratOS reads"]],
      [[item], "item", ["item is not an object", "item has no id that reads", "item has no change time that reads", "item is not a kind KaratOS reads"]],
      [{ ...item, id: "1" }, "item", ["item has no id that reads"]],
      [{ ...item, id: 5 }, "item", ["item has no id that reads"]],
      [{ ...item, lastModifiedDateTime: "2026-02-30T00:00:00Z" }, "item", ["item has no change time that reads"]],
      [{ ...item, lastModifiedDateTime: "2026-01-01 00:00:00" }, "item", ["item has no change time that reads"]],
      [{ ...item, lastModifiedDateTime: 5 }, "item", ["item has no change time that reads"]],
    ];
    for (const [raw, kind, problems] of cases) {
      const { ok, event } = eJewelryItemEvent(raw, ctx);
      expect(ok, JSON.stringify(raw)).toBe(false);
      expect(event.occurredAt).toBeUndefined();
      expect(event.payload).toMatchObject({ system: "e-Jewelry", kind, problems });
      expect(event.idempotencyKey).toMatch(/^bci_e_jewelry:unreadable_item:[0-9a-f]{12}$/);
      expect(event.type).toBe("accounting.item_updated");
    }
    expect(eJewelryItemEvent({ ...item, id: "1" }, ctx).event.payload.id).toBeNull();
    expect(eJewelryItemEvent({ ...item, lastModifiedDateTime: 5 }, ctx).event.payload.id).toBe(eJewelryGuid(1, 1));
    expect(eJewelryVendorEvent({}, ctx).event.payload).toMatchObject({ kind: "vendor", problems: ["vendor has no id that reads", "vendor has no change time that reads"] });
    expect(eJewelryInvoiceEvent("x", ctx).event.idempotencyKey).toMatch(/^bci_e_jewelry:unreadable_invoice:/);
    expect(eJewelryBillEvent(undefined, ctx).event.payload).toMatchObject({ kind: "bill", problems: ["bill is not an object", "bill has no id that reads", "bill has no change time that reads"] });
  });

  it("keeps text, numbers and codes only when they read", () => {
    resetFixtures();
    const item = eJewelryItem.one();
    const payload = (change: Record<string, unknown>) => eJewelryItemEvent({ ...item, ...change }, ctx).event.payload;
    for (const name of ["<b>Ring</b>", "Ring\u0007", "", "   ", "n".repeat(201), 5]) expect(payload({ displayName: name }).name, JSON.stringify(name)).toBeUndefined();
    expect(payload({ displayName: "  Halo Ring  " }).name).toBe("Halo Ring");
    expect(payload({ displayName: "n".repeat(200) }).name).toBe("n".repeat(200));
    for (const sku of ["-R1", "R 1", "R".repeat(61), "", 7]) expect(payload({ number: sku }).sku, JSON.stringify(sku)).toBeUndefined();
    for (const sku of ["#R1", "R1/2.5_x:y-z", "R".repeat(60)]) expect(payload({ number: sku }).sku).toBe(sku);
    expect(payload({ itemCategoryCode: "" }).category).toBeUndefined();
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, "5", 1e12 + 1, null]) expect(payload({ unitPrice: v, inventory: v }), String(v)).toMatchObject({ unitPriceCents: undefined, onHand: undefined });
    expect(payload({ unitPrice: 1e12, unitCost: -1e12, inventory: -2.5 })).toMatchObject({ unitPriceCents: 1e14, unitCostCents: -1e14, onHand: -2.5 });
    expect(eJewelryCents(10.235)).toBe(1024);
    expect(eJewelryCents(0)).toBe(0);
    expect(eJewelryCents("1")).toBeUndefined();
  });

  it("reads change times to the millisecond, in UTC", () => {
    expect(eJewelryInstant("2026-11-10T12:34:56Z")).toBe("2026-11-10T12:34:56.000Z");
    expect(eJewelryInstant("2026-11-10T12:34:56.5Z")).toBe("2026-11-10T12:34:56.500Z");
    expect(eJewelryInstant("2026-11-10T12:34:56.1239999Z")).toBe("2026-11-10T12:34:56.123Z");
    expect(eJewelryInstant("2028-02-29T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    for (const bad of ["2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-11-10T12:34:56", "2026-11-10T12:34:60Z", "", null, 0]) expect(eJewelryInstant(bad), String(bad)).toBeUndefined();
  });

  it("reads a vendor, blank currency as the company's own and blank blocked as active", () => {
    resetFixtures();
    const vendor = eJewelryVendor.one();
    const { ok, event } = eJewelryVendorEvent(vendor, ctx);
    expect(ok).toBe(true);
    expect(event.payload).toEqual({ system: "e-Jewelry", vendorId: `bci_e_jewelry:vendor:${eJewelryGuid(2, 1)}`, number: "V1001", name: "Test Casting Co 1", currency: undefined, balanceCents: 120_000, active: true, changedAt: T(1) });
    expect(event).toMatchObject({ type: "accounting.vendor_updated", occurredAt: T(1) });
    const v = (change: Record<string, unknown>) => eJewelryVendorEvent({ ...vendor, ...change }, ctx).event.payload;
    expect(v({ blocked: "" }).active).toBe(true);
    for (const blocked of ["All", "Payment", undefined, false]) expect(v({ blocked }).active, String(blocked)).toBe(false);
    expect(v({ currencyCode: "EUR" }).currency).toBe("EUR");
    for (const code of ["eur", "EURO", " EUR"]) expect(v({ currencyCode: code }).currency).toBeUndefined();
    expect(v({ displayName: "<x>" }).name).toBe(`e-Jewelry vendor ${eJewelryGuid(2, 1)}`);
    expect(JSON.stringify(event)).not.toMatch(/Test Street|555-0100|example/);
  });

  it("reads a sales invoice without the customer's name, address, email or phone", () => {
    resetFixtures();
    const invoice = eJewelrySalesInvoice.one();
    const { ok, event } = eJewelryInvoiceEvent(invoice, ctx);
    expect(ok).toBe(true);
    expect(event.payload).toEqual({
      system: "e-Jewelry",
      invoiceId: `bci_e_jewelry:sales_invoice:${eJewelryGuid(3, 1)}`,
      customerId: `bci_e_jewelry:customer:${eJewelryGuid(5, 1)}`,
      number: "S-INV1001",
      txnDate: "2026-01-05",
      dueDate: "2026-02-04",
      totalCents: 240_050,
      taxCents: 20_000,
      balanceCents: 40_050,
      currency: "USD",
      status: "open",
      changedAt: T(1),
    });
    expect(event).toMatchObject({ type: "accounting.invoice_updated", occurredAt: T(1) });
    expect(JSON.stringify(event)).not.toMatch(/Test Customer|Test Street|555-0100|example\.test|C1001/);
    const p = (change: Record<string, unknown>) => eJewelryInvoiceEvent({ ...invoice, ...change }, ctx).event.payload;
    expect(p({ status: "In Review" }).status).toBe("in_review");
    expect(p({ status: "Pending  Approval" }).status).toBe("pending_approval");
    for (const status of [" ", "", "Draft2", "In-Review", "s".repeat(41)]) expect(p({ status }).status, status).toBeUndefined();
    expect(p({ status: "s".repeat(40) }).status).toBe("s".repeat(40));
    for (const d of ["0001-01-01", "2026-02-30", "1899-12-31", "2126-01-01", "2026-1-5", 20260105]) expect(p({ invoiceDate: d, dueDate: d }), String(d)).toMatchObject({ txnDate: undefined, dueDate: undefined });
    expect(p({ invoiceDate: "1900-01-01", dueDate: "2099-12-31" })).toMatchObject({ txnDate: "1900-01-01", dueDate: "2099-12-31" });
    expect(p({ customerId: "C1001" }).customerId).toBeUndefined();
    expect(p({ customerId: eJewelryGuid(5, 1).toUpperCase() }).customerId).toBe(`bci_e_jewelry:customer:${eJewelryGuid(5, 1)}`);
  });

  it("reads a purchase invoice as a bill", () => {
    resetFixtures();
    const bill = eJewelryPurchaseInvoice.one();
    const { ok, event } = eJewelryBillEvent(bill, ctx);
    expect(ok).toBe(true);
    expect(event.payload).toEqual({
      system: "e-Jewelry",
      billId: `bci_e_jewelry:purchase_invoice:${eJewelryGuid(4, 1)}`,
      vendorId: `bci_e_jewelry:vendor:${eJewelryGuid(2, 1)}`,
      number: "P-INV1001",
      vendorInvoiceNumber: "TC-501",
      txnDate: "2026-01-06",
      dueDate: "2026-02-05",
      totalCents: 90_000,
      taxCents: 0,
      currency: "USD",
      status: "open",
      changedAt: T(1),
    });
    expect(event).toMatchObject({ type: "accounting.bill_updated", occurredAt: T(1), idempotencyKey: expect.stringMatching(/^bci_e_jewelry:bill:/) });
    expect(eJewelryBillEvent({ ...bill, vendorId: null }, ctx).event.payload.vendorId).toBeUndefined();
  });
});

describe("e-Jewelry connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(eJewelryDocMock(account({ pageSize: 1 }))), expected: { ingested: 5 } });
    expect(result.full).toMatchObject({ ingested: 5, batches: 5 });
  });

  it("imports every item and vendor, five years of invoices, and stops for good", async () => {
    const mock = eJewelryDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 5, batches: 4, deadLettered: 0 });
    expect(mock.reads).toEqual([
      { list: "items", since: null, skip: 0, intent: "ReadOnly" },
      { list: "vendors", since: null, skip: 0, intent: "ReadOnly" },
      { list: "salesInvoices", since: FIVE_YEARS, skip: 0, intent: "ReadOnly" },
      { list: "purchaseInvoices", since: FIVE_YEARS, skip: 0, intent: "ReadOnly" },
    ]);
    expect(memory.events.map((e) => e.type)).toEqual(["accounting.item_updated", "accounting.item_updated", "accounting.vendor_updated", "accounting.invoice_updated", "accounting.bill_updated"]);
    assertSynthetic(memory.events);
    const cursor = JSON.parse(report.cursor!) as EJewelryCursor;
    expect(cursor).toEqual({ done: true, marks: { items: T(2), vendors: T(1), salesInvoices: T(10), purchaseInvoices: T(20) }, pass: null });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(4);
  });

  it("reads a list a page at a time, keeping the next link, and resumes there", async () => {
    const mock = eJewelryDocMock(account({ pageSize: 1 }));
    const batches = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(batches.map((b) => b.events.length)).toEqual([1, 1, 1, 1, 1]);
    const first = JSON.parse(batches[0]!.cursor) as EJewelryCursor;
    expect(first).toEqual({ done: false, marks: { items: null, vendors: null, salesInvoices: null, purchaseInvoices: null }, pass: { list: "items", since: null, next: `${BASE}/items?%24skiptoken=1`, top: T(1) } });
    const second = JSON.parse(batches[1]!.cursor) as EJewelryCursor;
    expect(second.pass).toEqual({ list: "vendors", since: null, next: null, top: null });
    expect(second.marks.items).toBe(T(2));
    const third = JSON.parse(batches[2]!.cursor) as EJewelryCursor;
    expect(third.pass).toEqual({ list: "salesInvoices", since: FIVE_YEARS, next: null, top: null });
    // Resuming from the first page's checkpoint reads the second page and on.
    const resumed = eJewelryDocMock(account({ pageSize: 1 }));
    const rest = await drain(connector(resumed).historicalImport({ organizationId: TEST_ORG, cursor: batches[0]!.cursor }));
    expect(eventsOf(rest).map((e) => e.payload.sku ?? e.type)).toEqual(["SKU-TEST-0002", "accounting.vendor_updated", "accounting.invoice_updated", "accounting.bill_updated"]);
    expect(resumed.reads[0]).toEqual({ list: "items", since: null, skip: 1, intent: "ReadOnly" });
  });

  it("keeps the newest change a list saw, whatever order rows come in", async () => {
    resetFixtures();
    const items = [eJewelryItem.one({ lastModifiedDateTime: T(30) }), eJewelryItem.one({ lastModifiedDateTime: "2026-01-01T00:40:00.0000001Z" }), eJewelryItem.one({ lastModifiedDateTime: T(5) }), eJewelryItem.one({ lastModifiedDateTime: "2026-01-01T09:00:00" })];
    const mock = eJewelryDocMock(account({ items, pageSize: 2 }));
    const batches = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect((JSON.parse(batches[0]!.cursor) as EJewelryCursor).pass!.top).toBe(T(40));
    expect((JSON.parse(batches[1]!.cursor) as EJewelryCursor).marks.items).toBe(T(40));
    // A row that isn't an object moves nothing.
    const page = { rows: [null, 5, { lastModifiedDateTime: T(3) }], next: null };
    const fake: EJewelryClient = { listUrl: (l) => `${BASE}/${l}`, page: async () => page };
    const out = await drain(eJewelryConnector({ ...settings, client: fake, now: NOW }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect((JSON.parse(out.at(-1)!.cursor) as EJewelryCursor).marks).toEqual({ items: T(3), vendors: T(3), salesInvoices: T(3), purchaseInvoices: T(3) });
  });

  it("reads changes since each list's newest mark, less ten minutes, and keeps a mark when nothing changed", async () => {
    const mock = eJewelryDocMock(account());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const saved = await memory.getCheckpoint(TEST_ORG, "bci_e_jewelry", "historical");
    const less = (t: string) => new Date(Date.parse(t) - EJEWELRY_OVERLAP_MS).toISOString();
    const batches = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: saved }));
    expect(mock.reads.slice(4).map((r) => [r.list, r.since])).toEqual([
      ["items", less(T(2))],
      ["vendors", less(T(1))],
      ["salesInvoices", less(T(10))],
      ["purchaseInvoices", less(T(20))],
    ]);
    expect(eventsOf(batches)).toHaveLength(5);
    expect(JSON.parse(batches.at(-1)!.cursor)).toEqual({ done: true, marks: { items: T(2), vendors: T(1), salesInvoices: T(10), purchaseInvoices: T(20) }, pass: null });
    expect(EJEWELRY_OVERLAP_MS).toBe(600_000);
    // With nothing changed since, every mark stays.
    const quiet = eJewelryDocMock(account({ items: [], vendors: [], salesInvoices: [], purchaseInvoices: [] }));
    const none = await drain(connector(quiet).incrementalSync({ organizationId: TEST_ORG, cursor: saved }));
    expect(JSON.parse(none.at(-1)!.cursor)).toEqual(JSON.parse(saved!));
  });

  it("looks back three days on a first later sync, and leaves the import to do", async () => {
    const mock = eJewelryDocMock(account());
    const batches = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    const back = new Date(NOW().getTime() - EJEWELRY_FIRST_LOOKBACK_MS).toISOString();
    expect(back).toBe("2026-11-08T15:00:00.000Z");
    expect(mock.reads.map((r) => r.since)).toEqual([back, back, back, back]);
    expect(eventsOf(batches)).toHaveLength(0);
    expect(JSON.parse(batches.at(-1)!.cursor)).toMatchObject({ done: false, pass: null });
  });

  it("checks its history and declares its writes, all refused", async () => {
    const mock = eJewelryDocMock(account());
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears }), String(historyYears)).toThrow("historyYears must be a positive whole number");
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(mock.reads[2]!.since).toBe("2025-11-11T15:00:00.000Z");
    const c = connector(mock);
    expect(c.source).toBe("bci_e_jewelry");
    expect(c.writes).toBe(EJEWELRY_WRITES);
    expect(EJEWELRY_WRITES.map((w) => [w.name, w.kind, w.approval, w.dailyCap])).toEqual([
      ["create_sales_quote", "draft", "each", 20],
      ["update_item", "update", "each", 20],
    ]);
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "create_sales_quote", integration: "bci_e_jewelry", outcome: "refused" },
      { action: "update_item", integration: "bci_e_jewelry", outcome: "refused" },
    ]);
  });

  it("stops on a list its permission sets don't cover, keeping the checkpoint", async () => {
    const mock = eJewelryDocMock(account({ forbidden: ["salesInvoices"] }));
    const { memory, pipeline } = testPipeline();
    await expect(runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: noSleep })).rejects.toThrow("The app can't read salesInvoices");
    const saved = JSON.parse((await memory.getCheckpoint(TEST_ORG, "bci_e_jewelry", "historical"))!) as EJewelryCursor;
    expect(saved.pass).toEqual({ list: "salesInvoices", since: FIVE_YEARS, next: null, top: null });
  });

  it("dates its history from the real clock by default", async () => {
    const starts: (string | null)[] = [];
    const fake: EJewelryClient = { listUrl: (l) => `${BASE}/${l}`, page: async (_list, since) => (starts.push(since), { rows: [], next: null }) };
    const before = new Date();
    await drain(eJewelryConnector({ ...settings, client: fake }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const floor = new Date(before);
    floor.setUTCFullYear(floor.getUTCFullYear() - 5);
    expect(starts.slice(0, 2)).toEqual([null, null]);
    expect(Date.parse(starts[2]!) - floor.getTime()).toBeGreaterThanOrEqual(0);
    expect(Date.parse(starts[2]!) - floor.getTime()).toBeLessThan(60_000);
  });

  it("refuses a checkpoint that isn't its own", () => {
    const c = ejewelryClient(settings);
    const marks = { items: null, vendors: null, salesInvoices: null, purchaseInvoices: null };
    const good: EJewelryCursor = { done: false, marks: { ...marks, items: T(1) }, pass: { list: "vendors", since: T(2), next: `${BASE}/vendors?$skiptoken=1`, top: T(3) } };
    expect(parseEJewelryCursor(null, c)).toBeNull();
    expect(parseEJewelryCursor(JSON.stringify(good), c)).toEqual(good);
    expect(parseEJewelryCursor(JSON.stringify({ ...good, extra: 1, pass: null }), c)).toEqual({ ...good, pass: null });
    expect(parseEJewelryCursor(JSON.stringify({ ...good, pass: { ...good.pass, since: null, next: null, top: null } }), c)!.pass).toEqual({ list: "vendors", since: null, next: null, top: null });
    const bad: unknown[] = [
      "{",
      "null",
      "5",
      { ...good, done: "no" },
      { ...good, marks: null },
      { ...good, marks: { ...marks, items: "2026-01-01" } },
      { ...good, marks: { items: null, vendors: null, salesInvoices: null } },
      { ...good, pass: undefined },
      { ...good, pass: { ...good.pass, list: "customers" } },
      { ...good, pass: { ...good.pass, since: "yesterday" } },
      { ...good, pass: { ...good.pass, since: "2026-01-01T00:00:00Z" } },
      { ...good, pass: { ...good.pass, top: 5 } },
      { ...good, pass: { ...good.pass, next: `${BASE}/items?$skiptoken=1` } },
      { ...good, pass: { ...good.pass, next: `${BASE}/vendors` } },
      { ...good, pass: { ...good.pass, next: 5 } },
    ];
    for (const raw of bad) expect(() => parseEJewelryCursor(typeof raw === "string" ? raw : JSON.stringify(raw), c), JSON.stringify(raw)).toThrow("e-Jewelry checkpoint is not in the expected shape");
    expect(EJEWELRY_LISTS).toEqual(["items", "vendors", "salesInvoices", "purchaseInvoices"]);
  });
});

describe("e-Jewelry doc mock", () => {
  const signIn = (mock: EJewelryMock, form: Record<string, string>, tenant = EJEWELRY_TEST_TENANT) =>
    mock.fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  const form = { grant_type: "client_credentials", client_id: EJEWELRY_TEST_CLIENT, client_secret: SECRET, scope: EJEWELRY_SCOPE };
  const get = (mock: EJewelryMock, url: string, auth = "Bearer bc-test-token-1") => mock.fetch(url, { headers: { authorization: auth } });

  it("checks the sign-in's tenant, grant, app, secret and scope", async () => {
    const mock = eJewelryDocMock(account());
    const error = async (r: Response) => [r.status, ((await r.json()) as { error: string }).error];
    expect(await error(await signIn(mock, form, eJewelryGuid(9, 9)))).toEqual([400, "invalid_request"]);
    expect(await error(await signIn(mock, { ...form, grant_type: "password" }))).toEqual([400, "unsupported_grant_type"]);
    expect(await error(await signIn(mock, { ...form, client_id: eJewelryGuid(9, 9) }))).toEqual([400, "unauthorized_client"]);
    expect(await error(await signIn(mock, { ...form, client_secret: "wrong" }))).toEqual([401, "invalid_client"]);
    expect(await error(await signIn(mock, { ...form, scope: "https://graph.microsoft.com/.default" }))).toEqual([400, "invalid_scope"]);
    expect(mock.signIns).toBe(0);
    const ok = await signIn(mock, form);
    expect(await ok.json()).toEqual({ token_type: "Bearer", expires_in: 3599, ext_expires_in: 3599, access_token: "bc-test-token-1" });
    expect(mock.signIns).toBe(1);
  });

  it("wants its token, the right company, a filter it knows and a skip token, and pages with next links", async () => {
    const mock = eJewelryDocMock(account({ pageSize: 1 }));
    await signIn(mock, form);
    const status = async (url: string, auth?: string) => (await get(mock, url, auth)).status;
    expect(await status(`${BASE}/items`, "Bearer other")).toBe(401);
    expect((await mock.fetch(`${BASE}/items`)).status).toBe(401);
    const other = (tenant: string, env: string, company: string) => `${EJEWELRY_API}/v2.0/${tenant}/${env}/api/v2.0/companies(${company})/items`;
    expect(await status(other(eJewelryGuid(9, 9), "production", EJEWELRY_TEST_COMPANY))).toBe(404);
    expect(await status(other(EJEWELRY_TEST_TENANT, "sandbox", EJEWELRY_TEST_COMPANY))).toBe(404);
    expect(await status(other(EJEWELRY_TEST_TENANT, "production", eJewelryGuid(9, 9)))).toBe(404);
    expect(await status(other(EJEWELRY_TEST_TENANT, "production", EJEWELRY_TEST_COMPANY.toUpperCase()))).toBe(200);
    for (const q of ["?$top=5", "?$filter=number eq 'R1'", "?$filter=lastModifiedDateTime gt 2026-01-01T00:00:00Z", "?$skiptoken=x", "?$skiptoken=-1"]) expect(await status(`${BASE}/items${q}`), q).toBe(400);
    const page = (await (await get(mock, `${BASE}/items?$filter=${encodeURIComponent(`lastModifiedDateTime ge ${T(2)}`)}`)).json()) as { value: { id: string }[]; "@odata.nextLink"?: string };
    expect(page.value.map((r) => r.id)).toEqual([eJewelryGuid(1, 2)]);
    expect(page["@odata.nextLink"]).toBeUndefined();
    const first = (await (await get(mock, `${BASE}/items`)).json()) as typeof page;
    expect(first["@odata.nextLink"]).toBe(`${BASE}/items?%24skiptoken=1`);
    const filtered = (await (await get(mock, `${BASE}/items?$filter=${encodeURIComponent(`lastModifiedDateTime ge ${T(0)}`)}`)).json()) as typeof page;
    expect(filtered["@odata.nextLink"]).toBe(`${BASE}/items?${new URLSearchParams({ $filter: `lastModifiedDateTime ge ${T(0)}`, $skiptoken: "1" })}`);
    expect(mock.reads.at(-1)).toEqual({ list: "items", since: T(0), skip: 0, intent: null });
    mock.revokeTokens();
    expect(await status(`${BASE}/items`)).toBe(401);
  });

  it("answers 429, with Retry-After when set, and 403 for a list it may not read", async () => {
    const mock = eJewelryDocMock(account({ rateLimits: 2, retryAfter: "3", forbidden: ["vendors"] }));
    await signIn(mock, form);
    const first = await get(mock, `${BASE}/items`);
    expect([first.status, first.headers.get("retry-after")]).toEqual([429, "3"]);
    await get(mock, `${BASE}/items`);
    expect((await get(mock, `${BASE}/vendors`)).status).toBe(403);
    const plain = eJewelryDocMock(account({ rateLimits: 1 }));
    await signIn(plain, form);
    const limited = await get(plain, `${BASE}/items`);
    expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, null]);
  });

  it("refuses a look-alike host and a request the docs don't list, and keeps its calls", async () => {
    const mock = eJewelryDocMock(account());
    await expect(mock.fetch("https://login.microsoftonline.com.example.test/x", {})).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${BASE}/customers`, {})).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${BASE}/items`, { method: "PATCH", body: "{}" })).rejects.toThrow(UndocumentedRequestError);
    await signIn(mock, form);
    await get(mock, `${BASE}/items`);
    expect(mock.fetch.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });

  it("is built from Business Central's docs pages", () => {
    const { login, api } = eJewelryDocMock(account());
    expect(login.source.url).toBe(EJEWELRY_DOC_PAGES.s2s);
    expect(api.source.url).toBe(EJEWELRY_DOC_PAGES.endpoints);
    expect(api.routes.map((r) => `${r.path} ${r.documentedAt}`)).toEqual([
      `/v2.0/{tenant}/{environment}/api/v2.0/{company}/items ${EJEWELRY_DOC_PAGES.item}`,
      `/v2.0/{tenant}/{environment}/api/v2.0/{company}/vendors ${EJEWELRY_DOC_PAGES.vendor}`,
      `/v2.0/{tenant}/{environment}/api/v2.0/{company}/salesInvoices ${EJEWELRY_DOC_PAGES.salesInvoice}`,
      `/v2.0/{tenant}/{environment}/api/v2.0/{company}/purchaseInvoices ${EJEWELRY_DOC_PAGES.purchaseInvoice}`,
    ]);
  });
});

describe("e-Jewelry edge cases", () => {
  const LETTERS = "abcdef01-0000-4000-8000-00000000000a";

  it("reads GUIDs in either case and refuses anything around one", () => {
    expect(ejewelryClient({ ...settings, tenantId: LETTERS.toUpperCase() }).listUrl("items")).toContain(`/v2.0/${LETTERS.toUpperCase()}/`);
    expect(() => ejewelryClient({ ...settings, tenantId: `x${EJEWELRY_TEST_TENANT}` })).toThrow("EJEWELRY_TENANT_ID");
    expect(() => ejewelryClient({ ...settings, environment: undefined as unknown as string })).toThrow("EJEWELRY_ENVIRONMENT");
    resetFixtures();
    const item = eJewelryItem.one({ id: LETTERS.toUpperCase(), lastModifiedDateTime: T(1) });
    expect(eJewelryItemEvent(item, ctx).event.payload.itemId).toBe(`bci_e_jewelry:item:${LETTERS}`);
  });

  it("refuses a start with anything after it, or an empty one", async () => {
    const { fetch, sent } = scripted([token()]);
    const { c } = client(fetch);
    for (const since of ["2026-01-01T00:00:00Zx", ""]) await expect(c.page("items", since, null), since).rejects.toThrow("a start must be a UTC time");
    expect(sent).toHaveLength(0);
  });

  it("doesn't wait before the first call, even at time zero", async () => {
    const { fetch } = scripted([token(), list([])]);
    const slept: number[] = [];
    const c = ejewelryClient({ ...settings, fetch, sleep: async (ms) => void slept.push(ms), clock: () => 0 });
    await c.page("items", null, null);
    expect(slept).toEqual([100]);
  });

  it("turns down a token answer that isn't 200", async () => {
    const { fetch } = scripted([json(201, { access_token: "tok", expires_in: 3599 })]);
    await expect(client(fetch).c.page("items", null, null)).rejects.toThrow(new EJewelryApiError("Microsoft answered HTTP 201 for a token", 201));
  });

  it("times tokens by the real clock by default", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-11T15:00:00.000Z"));
      const { fetch, sent } = scripted([token(400), list([]), list([]), token(400, "tok-2"), list([])]);
      const c = ejewelryClient({ ...settings, fetch, sleep: noSleep });
      await c.page("items", null, null);
      vi.setSystemTime(new Date("2026-11-11T15:01:39.000Z"));
      await c.page("items", null, null);
      vi.setSystemTime(new Date("2026-11-11T15:01:40.000Z"));
      await c.page("items", null, null);
      expect(sent.map((s) => s.url === LOGIN_URL)).toEqual([true, false, false, true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads only whole days and amounts within a trillion either way", () => {
    resetFixtures();
    const invoice = eJewelrySalesInvoice.one();
    expect(eJewelryInvoiceEvent({ ...invoice, invoiceDate: "2026-01-05T00:00:00Z" }, ctx).event.payload.txnDate).toBeUndefined();
    expect(eJewelryCents(-1e12 - 1)).toBeUndefined();
    expect(eJewelryCents(-1e12)).toBe(-1e14);
  });

  it("keys rows that don't read by everything in them", () => {
    resetFixtures();
    const item = eJewelryItem.one();
    const a = eJewelryItemEvent({ ...item, id: "1" }, ctx).event.idempotencyKey;
    const b = eJewelryItemEvent({ ...item, id: "2" }, ctx).event.idempotencyKey;
    expect(a).not.toBe(b);
    expect(eJewelryItemEvent(undefined, ctx).event.idempotencyKey).toMatch(/^bci_e_jewelry:unreadable_item:[0-9a-f]{12}$/);
  });

  it("refuses a checkpoint whose marks or list are out of place", () => {
    const c = ejewelryClient(settings);
    const none = { items: null, vendors: null, salesInvoices: null, purchaseInvoices: null };
    expect(() => parseEJewelryCursor(JSON.stringify({ done: false, ...none, pass: null }), c)).toThrow("e-Jewelry checkpoint is not in the expected shape");
    expect(() => parseEJewelryCursor(JSON.stringify({ done: false, marks: none, pass: { list: "customers", since: null, next: null, top: null } }), c)).toThrow("e-Jewelry checkpoint is not in the expected shape");
  });

  it("matches the company in any case and keeps counting skip tokens", async () => {
    resetFixtures();
    const mock = eJewelryDocMock({ ...account({ pageSize: 1, items: eJewelryItem.many(3) }), companyId: LETTERS });
    await mock.fetch(LOGIN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: EJEWELRY_TEST_CLIENT, client_secret: SECRET, scope: EJEWELRY_SCOPE }).toString() });
    const url = `${EJEWELRY_API}/v2.0/${EJEWELRY_TEST_TENANT}/production/api/v2.0/companies(${LETTERS.toUpperCase()})/items`;
    const page = async (u: string) => (await (await mock.fetch(u, { headers: { authorization: "Bearer bc-test-token-1" } })).json()) as { value: unknown[]; "@odata.nextLink"?: string };
    const first = await page(url);
    const second = await page(first["@odata.nextLink"]!);
    expect(second["@odata.nextLink"]).toBe(`${url}?%24skiptoken=2`);
    const third = await page(second["@odata.nextLink"]!);
    expect([first.value.length, second.value.length, third.value.length, third["@odata.nextLink"]]).toEqual([1, 1, 1, undefined]);
  });
});
