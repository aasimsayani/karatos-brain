import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, acumaticaDocMock, acumaticaSalesOrder, acumaticaStockItem, assertSynthetic, assertWritesRefused, checkConnectorSync, testPipeline, type AcumaticaMock, type AcumaticaMockData, type AcumaticaMockRecord } from "@karatos/connector-testkit";
import {
  ACUMATICA_DEFAULT_VERSION,
  ACUMATICA_ENDPOINT_VERSIONS,
  ACUMATICA_ENTITIES,
  ACUMATICA_EVENTS,
  ACUMATICA_OVERLAP_MS,
  ACUMATICA_PAGE_SIZE,
  ACUMATICA_WRITES,
  AcumaticaApiError,
  AcumaticaConfigError,
  acumaticaBaseUrl,
  acumaticaCents,
  acumaticaClient,
  acumaticaConnector,
  acumaticaCustomerRef,
  acumaticaItemEvents,
  acumaticaListParams,
  acumaticaOrderEvent,
  acumaticaTime,
  parseAcumaticaCursor,
  type AcumaticaClient,
  type AcumaticaClientOptions,
  type AcumaticaEvent,
  type AcumaticaOptions,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const BASE = "https://jewelshop.example.test";
const CLIENT_ID = "00000000-0000-4000-8000-000000000001@Company";
const SECRET = ["s", "a".repeat(20)].join("");
const USER = "karatos";
const PASSWORD = ["p", "b".repeat(20)].join("");
const KEY = "k".repeat(64);
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const CTX = { receivedAt: RECEIVED, customerKey: KEY };
const DAY_MS = 86_400_000;
const ACCESS = `tok${"a".repeat(30)}`;
const API = `${BASE}/entity/Default/24.200.001`;
const noSleep = async () => {};
const Q = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-11T15:00:00.000Z", skip: 0 };
const v = (value: unknown) => ({ value });

function account(overrides: Partial<AcumaticaMockData> = {}): AcumaticaMockData {
  acumaticaStockItem.reset();
  acumaticaSalesOrder.reset();
  return { clientId: CLIENT_ID, clientSecret: SECRET, username: USER, password: PASSWORD, stockItems: acumaticaStockItem.many(3), salesOrders: acumaticaSalesOrder.many(2), ...overrides };
}
const base = (fetch?: typeof globalThis.fetch): AcumaticaClientOptions => ({ url: BASE, clientId: CLIENT_ID, clientSecret: SECRET, username: USER, password: PASSWORD, sleep: noSleep, ...(fetch ? { fetch } : {}) });
const connector = (mock: AcumaticaMock, overrides: Partial<AcumaticaOptions> = {}) => acumaticaConnector({ ...base(mock.fetch), customerKey: KEY, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as AcumaticaEvent[];
async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}
/** A fetch that answers in turn and records what was sent. */
function scripted(...answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body });
    return answers[Math.min(sent.length - 1, answers.length - 1)]!();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const token = (expires: unknown = 3600, value: unknown = ACCESS) => json(200, { access_token: value, expires_in: expires, token_type: "Bearer", scope: "api" });
const list = (n: number) => json(200, Array.from({ length: n }, () => ({})));
const client = (fetch: typeof globalThis.fetch, extra: Partial<AcumaticaClientOptions> = {}) => {
  const slept: number[] = [];
  return { c: acumaticaClient({ ...base(fetch), sleep: async (ms) => void slept.push(ms), now: NOW, ...extra }), slept };
};

describe("Acumatica settings", () => {
  it("reads the instance's address", () => {
    expect(acumaticaBaseUrl(" https://example.acumatica.com/ ")).toBe("https://example.acumatica.com");
    expect(acumaticaBaseUrl("https://erp.example.test/Instance//")).toBe("https://erp.example.test/Instance");
    expect(acumaticaBaseUrl("https://erp.example.test:8443/Instance")).toBe("https://erp.example.test:8443/Instance");
    const bad = ["", "erp.example.test", "http://erp.example.test", "https://localhost", "https://10.0.0.1", "https://user:pw@erp.example.test", "https://erp.example.test/?x=1", "https://erp.example.test/#x", "https://ERP.example.test", "https://erp.example.test/a b", "ftp://erp.example.test", "https://-.example.test.", 5, null];
    for (const raw of bad) expect(() => acumaticaBaseUrl(raw), String(raw)).toThrow(new AcumaticaConfigError("ACUMATICA_URL must be the instance's https address, such as https://example.acumatica.com or https://erp.example.test/Instance"));
  });

  it("checks the credentials and version before sending anything", () => {
    const { fetch, sent } = scripted(token());
    const make = (o: Partial<AcumaticaClientOptions>) => () => acumaticaClient({ ...base(fetch), ...o });
    for (const clientId of ["", "x@Company", "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001@", `00000000-0000-4000-8000-000000000001@${"c".repeat(65)}`, "00000000-0000-4000-8000-00000000000g@Company", "x00000000-0000-4000-8000-000000000001@Company", "00000000-0000-4000-8000-000000000001@Company!", undefined as never]) expect(make({ clientId }), String(clientId)).toThrow(new AcumaticaConfigError("ACUMATICA_CLIENT_ID must be the connected application's ID, a GUID, an @ and the tenant"));
    for (const clientSecret of ["", "x".repeat(7), "x".repeat(513), "has a space", `${"x".repeat(8)}\x7f`, undefined as never]) expect(make({ clientSecret }), String(clientSecret)).toThrow(new AcumaticaConfigError("ACUMATICA_CLIENT_SECRET is missing or not in the expected shape"));
    for (const username of ["", "a b", "x".repeat(129), `a\x7f`, undefined as never]) expect(make({ username }), String(username)).toThrow(new AcumaticaConfigError("ACUMATICA_USERNAME is missing or not in the expected shape"));
    for (const password of ["", "x".repeat(513), undefined as never]) expect(make({ password }), String(password)).toThrow(new AcumaticaConfigError("ACUMATICA_PASSWORD is missing"));
    for (const endpointVersion of ["20.200.001", "24.200", "latest"]) expect(make({ endpointVersion }), endpointVersion).toThrow(new AcumaticaConfigError("ACUMATICA_ENDPOINT_VERSION must be one of 23.200.001, 24.200.001, 25.100.001, 25.200.001"));
    expect(make({ clientId: "ABCDEF00-0000-4000-8000-000000000001@My Co_1-2", clientSecret: "!".repeat(8), username: "~", password: " p " })).not.toThrow();
    expect(make({ clientId: `00000000-0000-4000-8000-000000000001@${"c".repeat(64)}`, clientSecret: "~".repeat(512), username: "x".repeat(128), password: "x".repeat(512) })).not.toThrow();
    expect(sent).toHaveLength(0);
    expect(ACUMATICA_ENDPOINT_VERSIONS).toEqual(["23.200.001", "24.200.001", "25.100.001", "25.200.001"]);
    expect(ACUMATICA_DEFAULT_VERSION).toBe("24.200.001");
    expect(acumaticaClient(base()).baseUrl).toBe(BASE);
  });

  it("builds each list's query from fixed fields, a checked window and a skip", () => {
    expect(Object.fromEntries(acumaticaListParams("StockItem", { from: null, to: Q.to, skip: 500 }))).toEqual({
      $select: "InventoryID,Description,ItemClass,ItemStatus,ItemType,BaseUOM,DefaultPrice,LastModified,WarehouseDetails/WarehouseID,WarehouseDetails/QtyOnHand",
      $filter: "LastModified le datetimeoffset'2026-11-11T15:00:00.000+00:00'",
      $top: "500",
      $skip: "500",
      $expand: "WarehouseDetails",
    });
    expect(Object.fromEntries(acumaticaListParams("SalesOrder", Q))).toEqual({
      $select: "OrderType,OrderNbr,Status,Date,CurrencyID,OrderTotal,OrderedQty,CustomerID,LastModified",
      $filter: "LastModified gt datetimeoffset'2026-11-01T00:00:00.000+00:00' and LastModified le datetimeoffset'2026-11-11T15:00:00.000+00:00'",
      $top: "500",
      $skip: "0",
    });
    expect(Object.keys(ACUMATICA_ENTITIES)).toEqual(["StockItem", "SalesOrder"]);
    expect(ACUMATICA_PAGE_SIZE).toBe(500);
    expect(Object.fromEntries(acumaticaListParams("SalesOrder", { ...Q, from: Q.to })).$filter).toContain("gt datetimeoffset'2026-11-11T15:00:00.000+00:00'");
    expect(() => acumaticaListParams("Customer" as never, Q)).toThrow(new AcumaticaConfigError("Acumatica reads only StockItem and SalesOrder"));
    for (const q of [{ ...Q, from: "2026-11-01" }, { ...Q, to: "soon" }, { ...Q, from: Q.to, to: Q.from }, { ...Q, from: `1${Q.from}` }, { ...Q, to: `${Q.to}x` }, { from: null, to: `1${Q.to}`, skip: 0 }]) expect(() => acumaticaListParams("SalesOrder", q), JSON.stringify(q)).toThrow(new AcumaticaConfigError("records are listed between two UTC times"));
    for (const skip of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => acumaticaListParams("SalesOrder", { ...Q, skip }), String(skip)).toThrow(new AcumaticaConfigError("skip must be a whole number, 0 or more"));
  });
});

describe("Acumatica client", () => {
  it("signs in with the password flow, then sends only GETs, with the token in its header", async () => {
    const { fetch, sent } = scripted(token(), list(2));
    const { c } = client(fetch, { clientId: ` ${CLIENT_ID} `, clientSecret: ` ${SECRET}\n`, username: ` ${USER} ` });
    expect(await c.list("SalesOrder", Q)).toEqual({ records: [{}, {}], more: false });
    expect(sent.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([`POST ${BASE}/identity/connect/token`, `GET ${API}/SalesOrder`]);
    expect(sent[0]!.headers).toEqual({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" });
    expect(Object.fromEntries(new URLSearchParams(String(sent[0]!.body)))).toEqual({ grant_type: "password", client_id: CLIENT_ID, client_secret: SECRET, username: USER, password: PASSWORD, scope: "api" });
    expect(sent[1]!.url).toBe(`${API}/SalesOrder?${acumaticaListParams("SalesOrder", Q)}`);
    expect(sent[1]!.headers).toEqual({ authorization: `Bearer ${ACCESS}`, accept: "application/json" });
    expect(sent[1]!.body).toBeUndefined();
    for (const s of sent) expect(s.url).not.toContain(PASSWORD);
    // A password keeps its spaces.
    const spaced = scripted(token(), list(0));
    await client(spaced.fetch, { password: " p w " }).c.list("SalesOrder", Q);
    expect(new URLSearchParams(String(spaced.sent[0]!.body)).get("password")).toBe(" p w ");
  });

  it("reads the version it is told to", async () => {
    const { fetch, sent } = scripted(token(), list(0));
    await client(fetch, { endpointVersion: " 25.200.001 " }).c.list("StockItem", { ...Q, from: null });
    expect(sent[1]!.url.split("?")[0]).toBe(`${BASE}/entity/Default/25.200.001/StockItem`);
  });

  it("says more may follow only after a full page", async () => {
    expect((await client(scripted(token(), list(500)).fetch).c.list("SalesOrder", Q)).more).toBe(true);
    expect((await client(scripted(token(), list(499)).fetch).c.list("SalesOrder", Q)).more).toBe(false);
  });

  it("keeps a token until a minute before it runs out, then signs in again", async () => {
    let clock = NOW().getTime();
    const { fetch, sent } = scripted(token(900), list(0), list(0), token(900, `${ACCESS}2`), list(0));
    const { c } = client(fetch, { now: () => new Date(clock) });
    await c.list("SalesOrder", Q);
    clock += 839_000;
    await c.list("SalesOrder", Q);
    clock += 1000;
    await c.list("SalesOrder", Q);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
    expect(sent[4]!.headers.authorization).toBe(`Bearer ${ACCESS}2`);
    for (const expires of [0, -5, "900", null, 86_401, 60]) {
      const s = scripted(token(expires), list(0), token(expires), list(0));
      const one = client(s.fetch).c;
      await one.list("SalesOrder", Q);
      await one.list("SalesOrder", Q);
      expect(s.sent.filter((x) => x.method === "POST"), String(expires)).toHaveLength(2);
    }
    for (const expires of [86_400, 120]) {
      const s = scripted(token(expires), list(0));
      const one = client(s.fetch).c;
      await one.list("SalesOrder", Q);
      await one.list("SalesOrder", Q);
      expect(s.sent.filter((x) => x.method === "POST"), String(expires)).toHaveLength(1);
    }
  });

  it("signs in again once when a token is turned down early, then says what the role lacks", async () => {
    const { fetch, sent } = scripted(token(), json(401, {}), token(3600, `${ACCESS}2`), list(1));
    expect((await client(fetch).c.list("SalesOrder", Q)).records).toHaveLength(1);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
    expect(sent[3]!.headers.authorization).toBe(`Bearer ${ACCESS}2`);
    const twice = scripted(token(), json(401, {}), token(), json(401, { message: "secret detail" }));
    const err = (await client(twice.fetch).c.list("SalesOrder", Q).catch((e: Error) => e)) as AcumaticaConfigError;
    expect(err).toBeInstanceOf(AcumaticaConfigError);
    expect(err.message).toBe("Acumatica turned down reading SalesOrder (HTTP 401); give the KaratOS user's role view access to it");
    expect(twice.sent).toHaveLength(4);
    const forbidden = scripted(token(), json(403, { message: "secret detail" }));
    await expect(client(forbidden.fetch).c.list("StockItem", { ...Q, from: null })).rejects.toThrow("Acumatica turned down reading StockItem (HTTP 403)");
    expect(forbidden.sent).toHaveLength(2);
  });

  it("says when Acumatica turns down the sign-in or answers it oddly, never repeating Acumatica's words", async () => {
    for (const status of [400, 401, 403]) {
      const e = await client(scripted(json(status, { error: "secret detail" })).fetch).c.list("SalesOrder", Q).catch((x: Error) => x);
      expect(e).toBeInstanceOf(AcumaticaConfigError);
      expect((e as Error).message).toBe(`Acumatica turned down the sign-in (HTTP ${status}); check ACUMATICA_CLIENT_ID, ACUMATICA_CLIENT_SECRET, ACUMATICA_USERNAME and ACUMATICA_PASSWORD, and that the connected application allows the resource owner password flow`);
    }
    const e = (await client(scripted(json(404, { error: "secret detail" })).fetch).c.list("SalesOrder", Q).catch((x: Error) => x)) as AcumaticaApiError;
    expect([e.message, e.status, e.name]).toEqual(["Acumatica sign-in answered HTTP 404", 404, "AcumaticaApiError"]);
    expect(new AcumaticaConfigError("x").name).toBe("AcumaticaConfigError");
    await expect(client(scripted(json(201, { access_token: ACCESS })).fetch).c.list("SalesOrder", Q)).rejects.toThrow("Acumatica sign-in answered HTTP 201");
    for (const answer of [() => new Response("not json"), json(200, null), json(200, {}), token(900, 5), token(900, "a".repeat(15)), token(900, `${"a".repeat(20)} b`), token(900, `${"a".repeat(20)}\n`), token(900, "a".repeat(8193))]) {
      const x = (await client(scripted(answer).fetch).c.list("SalesOrder", Q).catch((y: Error) => y)) as AcumaticaApiError;
      expect([x.message, x.status]).toEqual(["Acumatica sign-in answered without an access token", 200]);
    }
    for (const t of ["a".repeat(16), "a".repeat(8192)]) await expect(client(scripted(token(900, t), list(0)).fetch).c.list("SalesOrder", Q)).resolves.toEqual({ records: [], more: false });
  });

  it("says when a list answers with an error or without its records", async () => {
    const e = (await client(scripted(token(), json(500, { message: "secret detail" })).fetch, { retries: 0 }).c.list("SalesOrder", Q).catch((x: Error) => x)) as AcumaticaApiError;
    expect([e.message, e.status]).toEqual(["Acumatica answered HTTP 500 for SalesOrder", 500]);
    await expect(client(scripted(token(), json(201, [])).fetch).c.list("SalesOrder", Q)).rejects.toThrow("Acumatica answered HTTP 201 for SalesOrder");
    for (const answer of [() => new Response("not json"), json(200, null), json(200, {}), json(200, { value: [] })]) {
      const x = (await client(scripted(token(), answer).fetch).c.list("StockItem", { ...Q, from: null }).catch((y: Error) => y)) as AcumaticaApiError;
      expect([x.message, x.status]).toEqual(["Acumatica answered without a list of StockItem", 200]);
    }
  });

  it("checks a query before sending anything", async () => {
    const { fetch, sent } = scripted(token(), list(0));
    await expect(client(fetch).c.list("SalesOrder", { ...Q, skip: -1 })).rejects.toThrow(AcumaticaConfigError);
    expect(sent).toHaveLength(0);
  });

  it("waits out rate limits and server errors, honoring Retry-After up to a minute, then gives up", async () => {
    const { fetch, sent } = scripted(token(), json(429, {}, { "retry-after": "5" }), json(503, {}), json(429, {}, { "retry-after": "600" }), list(0));
    const { c, slept } = client(fetch);
    expect(await c.list("SalesOrder", Q)).toEqual({ records: [], more: false });
    expect(slept).toEqual([5000, 2000, 60_000]);
    expect(sent).toHaveLength(5);
    for (const status of [500, 502, 504]) expect(await client(scripted(json(status, {}), token(), list(0)).fetch).c.list("SalesOrder", Q), String(status)).toEqual({ records: [], more: false });
    const always = scripted(token(), json(500, {}));
    const r = client(always.fetch);
    await expect(r.c.list("SalesOrder", Q)).rejects.toThrow("Acumatica answered HTTP 500 for SalesOrder");
    expect(always.sent).toHaveLength(5);
    expect(r.slept).toEqual([1000, 2000, 4000]);
    const odd = client(scripted(token(), json(429, {}, { "retry-after": "soon" }), list(0)).fetch);
    await odd.c.list("SalesOrder", Q);
    expect(odd.slept).toEqual([1000]);
    for (const status of [400, 404, 501]) {
      const s = scripted(token(), json(status, {}));
      await client(s.fetch).c.list("SalesOrder", Q).catch(() => undefined);
      expect(s.sent, String(status)).toHaveLength(2);
    }
    const once = scripted(token(), json(503, {}));
    await client(once.fetch, { retries: 1 }).c.list("SalesOrder", Q).catch(() => undefined);
    expect(once.sent).toHaveLength(3);
  });

  it("signs out only when signed in, once, never throwing", async () => {
    const { fetch, sent } = scripted(token(), list(0), () => new Response(null, { status: 204 }), token(3600, `${ACCESS}2`), list(0));
    const { c } = client(fetch);
    await c.signOut();
    expect(sent).toHaveLength(0);
    await c.list("SalesOrder", Q);
    await c.signOut();
    await c.signOut();
    expect(sent.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([`POST ${BASE}/identity/connect/token`, `GET ${API}/SalesOrder`, `POST ${BASE}/entity/auth/logout`]);
    expect(sent[2]!.headers).toEqual({ authorization: `Bearer ${ACCESS}`, accept: "application/json" });
    expect(sent[2]!.body).toBeUndefined();
    // After signing out, the next read signs in again.
    await c.list("SalesOrder", Q);
    expect(sent[3]!.method).toBe("POST");
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    const f = client(scripted(token(), list(0)).fetch);
    await f.c.list("SalesOrder", Q);
    const broken = acumaticaClient({ ...base(failing), now: NOW });
    await expect(broken.signOut()).resolves.toBeUndefined();
  });

  it("signs out without throwing when the sign-out request fails", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      if (calls === 1) return token()();
      if (calls === 2) return list(0)();
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    const { c } = client(fetch);
    await c.list("SalesOrder", Q);
    await expect(c.signOut()).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it("waits for real, and uses the global fetch and clock, when none is given", async () => {
    const real = globalThis.fetch;
    const s = scripted(token(), json(503, {}), list(0), list(0));
    globalThis.fetch = s.fetch;
    try {
      const c = acumaticaClient({ url: BASE, clientId: CLIENT_ID, clientSecret: SECRET, username: USER, password: PASSWORD });
      const started = Date.now();
      await c.list("SalesOrder", Q);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      await c.list("SalesOrder", Q);
    } finally {
      globalThis.fetch = real;
    }
    expect(s.sent.filter((x) => x.method === "POST")).toHaveLength(1);
  });
});

describe("Acumatica reading helpers", () => {
  it("reads Acumatica's times as UTC, only with a zone", () => {
    expect(acumaticaTime("2026-01-02T03:04:05+00:00")).toBe("2026-01-02T03:04:05.000Z");
    expect(acumaticaTime("2026-01-02T03:04:05.1234567-05:00")).toBe("2026-01-02T08:04:05.123Z");
    expect(acumaticaTime("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000Z");
    for (const bad of ["2026-02-30T00:00:00Z", "2026-01-02T24:00:00Z", "2026-01-02T12:60:00Z", "2026-01-02T03:04:05", "2026-01-02", "2026-01-02 03:04:05Z", "2026-01-02T03:04:05.12345678Z", "2026-01-02T03:04:05+0200", "2026-01-02T03:04:05z", "x2026-01-02T03:04:05Z", "2026-01-02T03:04:05Zx", "", null, 5]) expect(acumaticaTime(bad), String(bad)).toBeUndefined();
  });

  it("reads money in whole cents, half a cent away from zero", () => {
    expect(acumaticaCents(1250.5)).toBe(125050);
    expect(acumaticaCents(0.005)).toBe(1);
    expect(acumaticaCents(-0.005)).toBe(-1);
    expect(acumaticaCents(-12.34)).toBe(-1234);
    expect(acumaticaCents(0)).toBe(0);
    expect(acumaticaCents(999_999_999_999.99)).toBe(99_999_999_999_999);
    for (const bad of [1e12, -1e12, Number.NaN, Number.POSITIVE_INFINITY, "12.5", null, undefined]) expect(acumaticaCents(bad), String(bad)).toBeNull();
  });

  it("makes keyed customer references, the same for any case, different by key", () => {
    const a = acumaticaCustomerRef(KEY, "TESTJEWELERS");
    expect(a).toMatch(/^acumatica_customer:[0-9a-f]{32}$/);
    expect(acumaticaCustomerRef(KEY, "testjewelers")).toBe(a);
    expect(acumaticaCustomerRef("j".repeat(64), "TESTJEWELERS")).not.toBe(a);
    expect(acumaticaCustomerRef(KEY, "OTHER")).not.toBe(a);
  });
});

describe("Acumatica events", () => {
  const item = (o: AcumaticaMockRecord = {}) => {
    acumaticaStockItem.reset();
    return acumaticaStockItem.one(o);
  };
  const order = (o: AcumaticaMockRecord = {}) => {
    acumaticaSalesOrder.reset();
    return acumaticaSalesOrder.one(o);
  };

  it("names its event types", () => {
    expect(ACUMATICA_EVENTS).toEqual({ item: "product.updated", stock: "inventory.counted", order: "order.updated" });
  });

  it("turns a stock item into product.updated and a count for each warehouse", () => {
    const [p, main, memo, ...rest] = acumaticaItemEvents(item(), CTX);
    expect(rest).toEqual([]);
    expect(p!.type).toBe("product.updated");
    expect(p!.occurredAt).toBe("2026-10-02T00:00:00.000Z");
    expect(p!.receivedAt).toBe(RECEIVED);
    expect(p!.payload).toStrictEqual({ system: "Acumatica", productId: "acumatica:item:ring-0001", sku: "RING-0001", title: "Test 14K solitaire setting", itemClass: "RINGS", status: "Active", itemType: "Finished Good", unit: "EA", priceCents: 125050, updatedAt: "2026-10-02T00:00:00.000Z" });
    expect(p!.idempotencyKey).toMatch(/^acumatica:item:ring-0001:[0-9a-f]{12}$/);
    expect(p!.id).toBe(p!.idempotencyKey.replace(/:/g, "_"));
    expect(main!.type).toBe("inventory.counted");
    expect(main!.occurredAt).toBe(RECEIVED);
    expect(main!.payload).toStrictEqual({ system: "Acumatica", sku: "RING-0001", onHand: 3, variantId: "acumatica:item:ring-0001", locationId: "acumatica:warehouse:main" });
    expect(main!.idempotencyKey).toMatch(/^acumatica:stock:ring-0001:main:[0-9a-f]{12}$/);
    expect(memo!.payload.onHand).toBe(1);
    expect(memo!.payload.locationId).toBe("acumatica:warehouse:memo");
    // A count is keyed by what it says, not when it was read.
    expect(acumaticaItemEvents(item(), { ...CTX, receivedAt: "2027-01-01T00:00:00.000Z" })[1]!.idempotencyKey).toBe(main!.idempotencyKey);
    expect(acumaticaItemEvents(item(), CTX)[0]!.idempotencyKey).toBe(p!.idempotencyKey);
    const moved = item();
    (moved.WarehouseDetails as AcumaticaMockRecord[])[0]!.QtyOnHand = v(2);
    expect(acumaticaItemEvents(moved, CTX)[1]!.idempotencyKey).not.toBe(main!.idempotencyKey);
    expect(acumaticaItemEvents(moved, CTX)[0]!.idempotencyKey).toBe(p!.idempotencyKey);
    expect(acumaticaItemEvents(item({ DefaultPrice: v(1) }), CTX)[0]!.idempotencyKey).not.toBe(p!.idempotencyKey);
  });

  it("keeps what reads of an item, and skips warehouse lines that don't", () => {
    const odd = acumaticaItemEvents(item({ InventoryID: v(" Ring 7/A#1 "), Description: v(` ${"D".repeat(130)} `), ItemClass: v("C".repeat(50)), ItemStatus: v("  "), ItemType: null, BaseUOM: v("U".repeat(30)), DefaultPrice: v("1"), WarehouseDetails: [{ WarehouseID: v(" WH 2 "), QtyOnHand: v(1.5) }, { WarehouseID: v(""), QtyOnHand: v(1) }, { QtyOnHand: v(1) }, "x", { WarehouseID: v("NEG"), QtyOnHand: v(-2) }, { WarehouseID: v("BIG"), QtyOnHand: v(1e12) }, { WarehouseID: v("NAN"), QtyOnHand: v("3") }] }), CTX);
    expect(odd[0]!.payload).toMatchObject({ productId: "acumatica:item:ring 7/a#1", sku: "Ring 7/A#1", title: "D".repeat(120), itemClass: "C".repeat(40), status: null, itemType: null, unit: "U".repeat(20), priceCents: null });
    expect(odd.slice(1).map((e) => [e.payload.locationId, e.payload.onHand])).toEqual([
      ["acumatica:warehouse:wh 2", 1.5],
      ["acumatica:warehouse:neg", -2],
      ["acumatica:warehouse:big", null],
      ["acumatica:warehouse:nan", null],
    ]);
    expect(acumaticaItemEvents(item({ WarehouseDetails: null }), CTX)).toHaveLength(1);
    expect(acumaticaItemEvents(item({ WarehouseDetails: {} }), CTX)).toHaveLength(1);
  });

  it("dead-letters an item that doesn't read, listing why, with no counts", () => {
    const e = acumaticaItemEvents(item({ InventoryID: v("-bad"), LastModified: v("soon") }), CTX);
    expect(e).toHaveLength(1);
    expect(e[0]!.occurredAt).toBeUndefined();
    expect(e[0]!.payload).toStrictEqual({ system: "Acumatica", problems: ["stock item has no inventory ID that reads", "stock item has no time that reads"] });
    expect(e[0]!.idempotencyKey).toMatch(/^acumatica:unreadable_item:[0-9a-f]{12}$/);
    expect(e[0]!.id).toBe(e[0]!.idempotencyKey.replace(/:/g, "_"));
    expect(acumaticaItemEvents(item({ InventoryID: v("-bad2"), LastModified: v("soon") }), CTX)[0]!.idempotencyKey).not.toBe(e[0]!.idempotencyKey);
    const t = acumaticaItemEvents(item({ LastModified: v("2026-10-02T00:00:00") }), CTX);
    expect(t[0]!.payload.problems).toEqual(["stock item has no time that reads"]);
    // Its counts still read, as they don't hang on its time.
    expect(t).toHaveLength(3);
    for (const id of [5, "", "x".repeat(61), "a\tb", "a:b"]) expect(acumaticaItemEvents(item({ InventoryID: v(id) }), CTX)[0]!.payload.problems, String(id)).toEqual(["stock item has no inventory ID that reads"]);
    expect(acumaticaItemEvents(item({ InventoryID: v("x".repeat(60)) }), CTX)[0]!.payload.problems).toBeUndefined();
    expect(acumaticaItemEvents(item({ InventoryID: "RING-1" }), CTX)[0]!.payload.problems).toEqual(["stock item has no inventory ID that reads"]);
    for (const raw of [null, "x", []]) expect(acumaticaItemEvents(raw, CTX)[0]!.payload.problems, JSON.stringify(raw)).toHaveLength(2);
  });

  it("turns a sales order into order.updated with the customer under a keyed reference", () => {
    const e = acumaticaOrderEvent(order(), CTX);
    expect(e.type).toBe("order.updated");
    expect(e.occurredAt).toBe("2026-10-02T00:00:00.000Z");
    expect(e.payload).toStrictEqual({ system: "Acumatica", orderId: "acumatica:order:so/so000001", orderType: "SO", orderNumber: "SO000001", status: "Open", createdAt: "2026-10-01T00:00:00.000Z", currency: "USD", totalCents: 420025, quantity: 4, customerId: acumaticaCustomerRef(KEY, "TESTJEWELERS"), updatedAt: "2026-10-02T00:00:00.000Z" });
    expect(e.idempotencyKey).toMatch(/^acumatica:order:so\/so000001:[0-9a-f]{12}$/);
    expect(e.id).toMatch(/^acumatica_order_so_so000001_[0-9a-f]{12}$/);
    const all = JSON.stringify(e);
    for (const hidden of ["TESTJEWELERS", "Test note", "PO-TEST"]) expect(all, hidden).not.toContain(hidden);
    expect(acumaticaOrderEvent(order(), { ...CTX, receivedAt: "2027-01-01T00:00:00.000Z" }).idempotencyKey).toBe(e.idempotencyKey);
    expect(acumaticaOrderEvent(order({ Status: v("Completed") }), CTX).idempotencyKey).not.toBe(e.idempotencyKey);
    const odd = acumaticaOrderEvent(order({ Status: v(` ${"S".repeat(50)} `), Date: v("soon"), CurrencyID: v("usd"), OrderTotal: v("1"), OrderedQty: v(Number.NaN), CustomerID: v("") }), CTX).payload;
    expect(odd).toMatchObject({ status: "S".repeat(40), createdAt: null, currency: null, totalCents: null, quantity: null, customerId: null });
    expect(acumaticaOrderEvent(order({ CurrencyID: v("USDX") }), CTX).payload.currency).toBeNull();
    expect(acumaticaOrderEvent(order({ OrderedQty: v(2.5) }), CTX).payload.quantity).toBe(2.5);
  });

  it("dead-letters an order that doesn't read, listing why", () => {
    const e = acumaticaOrderEvent(order({ OrderNbr: v(""), LastModified: null }), CTX);
    expect(e.occurredAt).toBeUndefined();
    expect(e.payload).toStrictEqual({ system: "Acumatica", problems: ["sales order has no type and number that read", "sales order has no time that reads"] });
    expect(e.idempotencyKey).toMatch(/^acumatica:unreadable_order:[0-9a-f]{12}$/);
    expect(acumaticaOrderEvent(order({ OrderType: v("") }), CTX).payload.problems).toEqual(["sales order has no type and number that read"]);
    expect(acumaticaOrderEvent(order({ OrderType: v("") }), CTX).occurredAt).toBe("2026-10-02T00:00:00.000Z");
    expect(acumaticaOrderEvent(order({ LastModified: v("x") }), CTX).payload.problems).toEqual(["sales order has no time that reads"]);
    for (const raw of [null, "x", []]) expect(acumaticaOrderEvent(raw, CTX).payload.problems, JSON.stringify(raw)).toHaveLength(2);
  });

  it("builds fixtures that look synthetic", () => {
    assertSynthetic(account());
  });
});

describe("Acumatica checkpoint", () => {
  const F = "2021-11-11T15:00:00.000Z";
  const T = "2026-11-11T15:00:00.000Z";
  const N = "2026-11-10T15:00:00.000Z";
  it("reads a checkpoint it wrote, and turns down anything else", () => {
    expect(parseAcumaticaCursor(null)).toBeNull();
    for (const step of ["StockItem", "SalesOrder"]) {
      const pass = { from: F, to: T, step, skip: 500 };
      expect(parseAcumaticaCursor(JSON.stringify({ pass, done: true, nextFrom: N }))).toEqual({ pass, done: true, nextFrom: N });
    }
    expect(parseAcumaticaCursor(JSON.stringify({ pass: null, done: false, nextFrom: N }))).toEqual({ pass: null, done: false, nextFrom: N });
    expect(parseAcumaticaCursor(JSON.stringify({ pass: { from: T, to: T, step: "SalesOrder", skip: 0 }, done: false, nextFrom: N }))!.pass).toEqual({ from: T, to: T, step: "SalesOrder", skip: 0 });
    const pass = { from: F, to: T, step: "StockItem", skip: 0 };
    const bad = ["", "x", "null", "[]", ...[{ pass: null, nextFrom: N }, { pass: null, done: "true", nextFrom: N }, { pass: null, done: false }, { pass: null, done: false, nextFrom: "2026-11-10" }, { done: false, nextFrom: N }, { pass: {}, done: false, nextFrom: N }, { pass: { ...pass, from: "2021-11-11" }, done: false, nextFrom: N }, { pass: { ...pass, to: "soon" }, done: false, nextFrom: N }, { pass: { ...pass, from: T, to: F }, done: false, nextFrom: N }, { pass: { ...pass, step: "Customer" }, done: false, nextFrom: N }, { pass: { ...pass, skip: -1 }, done: false, nextFrom: N }, { pass: { ...pass, skip: 1.5 }, done: false, nextFrom: N }, { pass: { ...pass, skip: "0" }, done: false, nextFrom: N }].map((o) => JSON.stringify(o))];
    for (const raw of bad) expect(() => parseAcumaticaCursor(raw), raw).toThrow("Acumatica checkpoint is not in the expected shape");
  });
});

describe("Acumatica connector", () => {
  it("passes the shared connector checks", async () => {
    // Three items with two warehouses each, and two orders.
    const result = await checkConnectorSync({ makeConnector: () => connector(acumaticaDocMock(account())), expected: { ingested: 11 } });
    expect(result.full.ingested).toBe(11);
  });

  it("imports every item, then five years of orders, signs out, and stops for good", async () => {
    const mock = acumaticaDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(11);
    expect(mock.reads.map((r) => [r.entity, r.query.$filter, r.query.$skip])).toEqual([
      ["StockItem", "LastModified le datetimeoffset'2026-11-11T15:00:00.000+00:00'", "0"],
      ["SalesOrder", "LastModified gt datetimeoffset'2021-11-11T15:00:00.000+00:00' and LastModified le datetimeoffset'2026-11-11T15:00:00.000+00:00'", "0"],
    ]);
    expect(mock.signOuts).toBe(1);
    expect(parseAcumaticaCursor(report.cursor)).toEqual({ pass: null, done: true, nextFrom: "2026-11-10T15:00:00.000Z" });
    expect(ACUMATICA_OVERLAP_MS).toBe(DAY_MS);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(2);
    const deep = acumaticaDocMock(account());
    await drain(connector(deep, { historyYears: 7 }).historicalImport({ cursor: null } as never));
    expect(deep.reads[1]!.query.$filter).toContain("gt datetimeoffset'2019-11-11T15:00:00.000+00:00'");
    expect(() => connector(deep, { historyYears: 0 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(deep, { historyYears: 1.5 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(deep, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY must be at least");
  });

  it("makes each page one batch, keeping the step and how many it has read, and resumes there", async () => {
    const asked: string[] = [];
    let signOuts = 0;
    const pages: Record<string, number[]> = { StockItem: [500, 500, 2], SalesOrder: [500, 1] };
    const fake: AcumaticaClient = {
      baseUrl: BASE,
      list: async (entity, q) => {
        asked.push(`${entity}:${q.from ?? "all"}:${q.skip}`);
        const n = pages[entity]![asked.filter((a) => a.startsWith(entity)).length - 1] ?? 0;
        return { records: Array.from({ length: n }, () => acumaticaStockItem.one()), more: n === 500 };
      },
      signOut: async () => void signOuts++,
    };
    acumaticaStockItem.reset();
    const make = () => acumaticaConnector({ ...base(), customerKey: KEY, client: fake, now: NOW });
    const all = await drain(make().historicalImport({ cursor: null } as never));
    const F = "2021-11-11T15:00:00.000Z";
    const T = "2026-11-11T15:00:00.000Z";
    expect(asked).toEqual(["StockItem:all:0", "StockItem:all:500", "StockItem:all:1000", `SalesOrder:${F}:0`, `SalesOrder:${F}:500`]);
    expect(all.map((b) => parseAcumaticaCursor(b.cursor ?? null))).toEqual([
      { pass: { from: F, to: T, step: "StockItem", skip: 500 }, done: false, nextFrom: "2026-11-10T15:00:00.000Z" },
      { pass: { from: F, to: T, step: "StockItem", skip: 1000 }, done: false, nextFrom: "2026-11-10T15:00:00.000Z" },
      { pass: { from: F, to: T, step: "SalesOrder", skip: 0 }, done: false, nextFrom: "2026-11-10T15:00:00.000Z" },
      { pass: { from: F, to: T, step: "SalesOrder", skip: 500 }, done: false, nextFrom: "2026-11-10T15:00:00.000Z" },
      { pass: null, done: true, nextFrom: "2026-11-10T15:00:00.000Z" },
    ]);
    expect(signOuts).toBe(1);
    // Orders read as orders: each record is one event, not an item's three.
    expect(all.map((b) => b.events.length)).toEqual([1500, 1500, 6, 500, 1]);
    expect(eventsOf(all).every((e) => e.receivedAt === RECEIVED)).toBe(true);
    asked.length = 0;
    pages.SalesOrder = [3];
    const mid = { pass: { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", step: "SalesOrder", skip: 500 }, done: false, nextFrom: "2026-01-31T00:00:00.000Z" };
    const rest = await drain(make().historicalImport({ cursor: JSON.stringify(mid) } as never));
    expect(asked).toEqual(["SalesOrder:2026-01-01T00:00:00.000Z:500"]);
    expect(rest.map((b) => parseAcumaticaCursor(b.cursor ?? null))).toEqual([{ pass: null, done: true, nextFrom: "2026-01-31T00:00:00.000Z" }]);
    expect(signOuts).toBe(2);
    asked.length = 0;
    expect(await drain(make().historicalImport({ cursor: JSON.stringify({ ...mid, done: true }) } as never))).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("signs out when a pass fails or is stopped part way", async () => {
    let signOuts = 0;
    const failing: AcumaticaClient = { baseUrl: BASE, list: async () => Promise.reject(new Error("boom")), signOut: async () => void signOuts++ };
    await expect(drain(acumaticaConnector({ ...base(), customerKey: KEY, client: failing, now: NOW }).historicalImport({ cursor: null } as never))).rejects.toThrow("boom");
    expect(signOuts).toBe(1);
    const endless: AcumaticaClient = { baseUrl: BASE, list: async () => ({ records: [], more: true }), signOut: async () => void signOuts++ };
    for await (const _ of acumaticaConnector({ ...base(), customerKey: KEY, client: endless, now: NOW }).historicalImport({ cursor: null } as never)) break;
    expect(signOuts).toBe(2);
  });

  it("reads every item again and the orders changed from a day before the last pass ended on each later sync", async () => {
    const data = account();
    const mock = acumaticaDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // Each mode keeps its own checkpoint, so the first later sync starts a day back.
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.slice(2).map((r) => [r.entity, r.query.$filter])).toEqual([
      ["StockItem", "LastModified le datetimeoffset'2026-11-11T15:00:00.000+00:00'"],
      ["SalesOrder", "LastModified gt datetimeoffset'2026-11-10T15:00:00.000+00:00' and LastModified le datetimeoffset'2026-11-11T15:00:00.000+00:00'"],
    ]);
    expect(first.ingested).toBe(0);
    expect(first.duplicates).toBe(9);
    (data.stockItems![0]!.WarehouseDetails as AcumaticaMockRecord[])[0]!.QtyOnHand = v(2);
    data.salesOrders!.push(acumaticaSalesOrder.one({ LastModified: v("2026-11-12T10:00:00+00:00") }));
    const later = () => new Date(NOW().getTime() + DAY_MS);
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.at(-1)!.query.$filter).toBe("LastModified gt datetimeoffset'2026-11-10T15:00:00.000+00:00' and LastModified le datetimeoffset'2026-11-12T15:00:00.000+00:00'");
    expect(sync.ingested).toBe(2);
    expect(parseAcumaticaCursor(sync.cursor)).toEqual({ pass: null, done: false, nextFrom: "2026-11-11T15:00:00.000Z" });
    // A later sync resumed mid-pass keeps its times and what it knew of the import.
    const fake: AcumaticaClient = { baseUrl: BASE, list: async () => ({ records: [], more: false }), signOut: async () => {} };
    const mid = JSON.stringify({ pass: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z", step: "SalesOrder", skip: 0 }, done: true, nextFrom: "2026-11-09T00:00:00.000Z" });
    const rest = await drain(acumaticaConnector({ ...base(), customerKey: KEY, client: fake, now: NOW }).incrementalSync({ cursor: mid } as never));
    expect(rest.map((b) => parseAcumaticaCursor(b.cursor ?? null))).toEqual([{ pass: null, done: true, nextFrom: "2026-11-09T00:00:00.000Z" }]);
    const midImport = mid.replace('"done":true', '"done":false');
    expect(parseAcumaticaCursor((await drain(acumaticaConnector({ ...base(), customerKey: KEY, client: fake, now: NOW }).incrementalSync({ cursor: midImport } as never))).at(-1)!.cursor ?? null)!.done).toBe(false);
    const after = acumaticaDocMock(account());
    const out = await drain(connector(after).incrementalSync({ cursor: JSON.stringify({ pass: null, done: true, nextFrom: "2026-10-01T00:00:00.000Z" }) } as never));
    expect(after.reads[1]!.query.$filter).toContain("gt datetimeoffset'2026-10-01T00:00:00.000+00:00'");
    expect(parseAcumaticaCursor(out.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-10T15:00:00.000Z" });
  });

  it("pages through the mock", async () => {
    acumaticaStockItem.reset();
    const stockItems = Array.from({ length: 1001 }, () => acumaticaStockItem.one({ WarehouseDetails: [], LastModified: v("2026-10-02T00:00:00+00:00") }));
    const mock = acumaticaDocMock(account({ stockItems, salesOrders: [] }));
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([500, 500, 1, 0]);
    expect(new Set(eventsOf(batches).map((e) => e.payload.sku)).size).toBe(1001);
    expect(mock.signIns).toBe(1);
  });

  it("dead-letters a record that doesn't read and keeps going", async () => {
    const data = account();
    data.salesOrders![0]!.LastModified = v("2026-10-02T00:00:00");
    // Its counts still read, so only the item itself is dead-lettered.
    data.stockItems![0]!.LastModified = v("soon");
    let calls = 0;
    const fake: AcumaticaClient = { baseUrl: BASE, list: async (entity) => ({ records: calls++ < 2 ? (entity === "StockItem" ? data.stockItems! : data.salesOrders!) : [], more: false }), signOut: async () => {} };
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: acumaticaConnector({ ...base(), customerKey: KEY, client: fake, now: NOW }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.deadLettered).toBe(2);
    expect(report.ingested).toBe(9);
  });

  it("waits out a rate limit inside a sync, signs in again when a token ends early, and says what the role can't see", async () => {
    const mock = acumaticaDocMock(account({ rateLimits: 2, expireTokens: 1 }));
    const slept: number[] = [];
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { sleep: async (ms) => void slept.push(ms) }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(11);
    expect(slept).toEqual([1000, 1000]);
    expect(mock.signIns).toBe(2);
    const hidden = acumaticaDocMock(account({ hidden: ["SalesOrder"] }));
    await expect(drain(connector(hidden).historicalImport({ cursor: null } as never))).rejects.toThrow("Acumatica turned down reading SalesOrder (HTTP 403)");
    expect(hidden.signOuts).toBe(1);
  });

  it("says when Acumatica turns down the sign-in, reading nothing", async () => {
    for (const change of [{ clientSecret: ["o", "c".repeat(20)].join("") }, { password: ["o", "d".repeat(20)].join("") }]) {
      const mock = acumaticaDocMock(account(change));
      await expect(drain(connector(mock).historicalImport({ cursor: null } as never))).rejects.toThrow("Acumatica turned down the sign-in (HTTP 400)");
      expect(mock.reads).toHaveLength(0);
    }
  });

  it("counts a token's lifetime on the connector's clock", async () => {
    let clock = NOW().getTime();
    const mock = acumaticaDocMock(account());
    const fetch = mock.fetch;
    const c = acumaticaConnector({ ...base(fetch), customerKey: KEY, now: () => new Date(clock) });
    const real = acumaticaClient({ ...base(fetch), now: () => new Date(clock) });
    await real.list("StockItem", { from: null, to: Q.to, skip: 0 });
    clock += 2 * 3_600_000;
    await real.list("StockItem", { from: null, to: Q.to, skip: 0 });
    expect(mock.signIns).toBe(2);
    await drain(c.historicalImport({ cursor: null } as never));
    expect(mock.signIns).toBe(3);
  });

  it("reads up to now when no clock is given", async () => {
    const mock = acumaticaDocMock(account());
    const before = Date.now();
    await drain(acumaticaConnector({ ...base(mock.fetch), customerKey: KEY }).historicalImport({ cursor: null } as never));
    const to = Date.parse(/le datetimeoffset'([^']+)'/.exec(mock.reads[0]!.query.$filter!)![1]!);
    expect(to).toBeGreaterThanOrEqual(before - 1);
    expect(to).toBeLessThanOrEqual(Date.now());
  });

  it("only ever signs in, lists stock items and sales orders, and signs out", async () => {
    const mock = acumaticaDocMock(account());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`))).toEqual(new Set(["POST /identity/connect/token", "GET /entity/Default/24.200.001/StockItem", "GET /entity/Default/24.200.001/SalesOrder", "POST /entity/auth/logout"]));
  });

  it("declares no writes", async () => {
    const c = connector(acumaticaDocMock(account()));
    expect(ACUMATICA_WRITES).toEqual([]);
    expect(c.writes).toBe(ACUMATICA_WRITES);
    expect(c.source).toBe("acumatica_jewelshop");
    expect(await assertWritesRefused(c)).toEqual([]);
  });
});

describe("Acumatica doc mock", () => {
  it("checks the sign-in, the fields, the filter and paging", async () => {
    const mock = acumaticaDocMock(account());
    const sign = (form: Record<string, string>, type = "application/x-www-form-urlencoded") => mock.fetch(`${BASE}/identity/connect/token`, { method: "POST", headers: { "content-type": type }, body: new URLSearchParams(form).toString() });
    const good = { grant_type: "password", client_id: CLIENT_ID, client_secret: SECRET, username: USER, password: PASSWORD, scope: "api" };
    expect((await sign({ ...good, grant_type: "client_credentials" })).status).toBe(400);
    expect((await sign({ ...good, scope: "api offline_access" })).status).toBe(400);
    expect((await sign(good, "application/json")).status).toBe(400);
    expect(await (await sign({ ...good, client_id: "x" })).json()).toEqual({ error: "invalid_client" });
    expect(await (await sign({ ...good, password: "x" })).json()).toEqual({ error: "invalid_grant" });
    const ok = (await (await sign(good)).json()) as { access_token: string; expires_in: number };
    expect(ok.expires_in).toBe(3600);
    const get = (entity: string, q: Record<string, string>, auth = `Bearer ${ok.access_token}`) => mock.fetch(`${API}/${entity}?${new URLSearchParams(q)}`, { headers: { authorization: auth } });
    const items = Object.fromEntries(acumaticaListParams("StockItem", { from: null, to: Q.to, skip: 0 }));
    const orders = Object.fromEntries(acumaticaListParams("SalesOrder", { from: "2026-10-01T00:00:00.000Z", to: Q.to, skip: 0 }));
    expect((await get("StockItem", items, "Bearer nope")).status).toBe(401);
    expect((await mock.fetch(`${API}/StockItem`)).status).toBe(401);
    expect(((await (await get("StockItem", items)).json()) as unknown[]).length).toBe(3);
    expect(((await (await get("SalesOrder", orders)).json()) as unknown[]).length).toBe(2);
    for (const [entity, q] of [["StockItem", { ...items, $select: "InventoryID" }], ["StockItem", { ...items, $expand: "Attributes" }], ["SalesOrder", { ...orders, $expand: "Details" }], ["SalesOrder", { ...orders, $filter: "Status eq 'Open'" }], ["SalesOrder", { ...orders, $filter: "LastModified gt datetimeoffset'soon'" }], ["SalesOrder", { ...orders, $top: "0" }], ["SalesOrder", { ...orders, $skip: "-1" }]] as const) expect((await get(entity, q)).status, JSON.stringify(q)).toBe(400);
    // Strictly after, and up to and including.
    const exact = { ...orders, $filter: "LastModified gt datetimeoffset'2026-10-02T00:00:00.000+00:00' and LastModified le datetimeoffset'2026-10-03T00:00:00.000+00:00'" };
    expect(((await (await get("SalesOrder", exact)).json()) as unknown[]).length).toBe(1);
    const { $filter: _f, $top: _t, $skip: _s, ...open } = orders;
    expect(((await (await get("SalesOrder", open)).json()) as unknown[]).length).toBe(2);
    expect(((await (await get("SalesOrder", { ...orders, $top: "1", $skip: "1" })).json()) as unknown[]).length).toBe(1);
    expect((await mock.fetch(`${BASE}/entity/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${ok.access_token}` } })).status).toBe(204);
    expect((await get("StockItem", items)).status).toBe(401);
    expect((await mock.fetch(`${BASE}/entity/auth/logout`, { method: "POST" })).status).toBe(204);
    expect(mock.signOuts).toBe(2);
    const empty = acumaticaDocMock({ clientId: CLIENT_ID, clientSecret: SECRET, username: USER, password: PASSWORD, baseUrl: "https://erp.example.test/Instance" });
    const t = (await (await empty.fetch("https://erp.example.test/Instance/identity/connect/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(good).toString() })).json()) as { access_token: string };
    expect(await (await empty.fetch(`https://erp.example.test/Instance/entity/Default/24.200.001/SalesOrder?${new URLSearchParams(orders)}`, { headers: { authorization: `Bearer ${t.access_token}` } })).json()).toEqual([]);
    await expect(mock.fetch(`${API}/SalesOrder`, { method: "PUT" })).rejects.toThrow("not in the vendor's docs");
  });
});
