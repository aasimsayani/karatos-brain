import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertWritesRefused, checkConnectorSync, gemLogicDocMock, gemLogicProduct, testPipeline, type GemLogicMock, type GemLogicMockData } from "@karatos/connector-testkit";
import {
  GEM_LOGIC_EVENTS,
  GEM_LOGIC_WRITES,
  GemLogicApiError,
  GemLogicConfigError,
  gemLogicClient,
  gemLogicConnector,
  gemLogicId,
  gemLogicInstance,
  gemLogicProductEvent,
  gemLogicRef,
  gemLogicTime,
  parseGemLogicCursor,
  type GemLogicClient,
  type GemLogicEvent,
  type GemLogicOptions,
} from "../src/index.js";

// Shaped like an API key, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["k", "0".repeat(31)].join("");
const API = "https://example.gem-logic.com/api";
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const noSleep = async () => {};

/** Two channels: the counter with three products, the web store with two. */
function shop(overrides: Partial<GemLogicMockData> = {}): GemLogicMockData {
  gemLogicProduct.reset();
  return {
    apiKey: KEY,
    marketplaces: [
      { id: 1, marketplace: "Counter" },
      { id: 2, marketplace: "Web store" },
    ],
    products: { "1": gemLogicProduct.many(3), "2": gemLogicProduct.many(2) },
    ...overrides,
  };
}

const connector = (mock: GemLogicMock, overrides: Partial<GemLogicOptions> = {}) => gemLogicConnector({ apiKey: KEY, instance: "example", fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as GemLogicEvent[];
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
const text = (status: number, body: string) => () => new Response(body, { status });
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof gemLogicClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = gemLogicClient({ apiKey: KEY, instance: "example", fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};

describe("Gem Logic client", () => {
  it("checks its key and instance before sending anything", () => {
    const { fetch, sent } = scripted(json(200, []));
    const make = (o: Partial<Parameters<typeof gemLogicClient>[0]>) => () => gemLogicClient({ apiKey: KEY, instance: "example", fetch, ...o });
    for (const apiKey of ["", "   ", "x".repeat(15), "x".repeat(513), "has a space in it", "colon:in:the:key:here", undefined as never]) expect(make({ apiKey }), String(apiKey)).toThrow(new GemLogicConfigError("GEM_LOGIC_API_KEY is missing or not in the expected shape"));
    for (const instance of ["", "-example", "ex_ample", "example.gem-logic.example", "http://example.gem-logic.com", "a.b", "x".repeat(64), undefined as never]) expect(make({ instance }), String(instance)).toThrow(new GemLogicConfigError("GEM_LOGIC_INSTANCE must be the business's instance, like example in example.gem-logic.com"));
    expect(make({ apiKey: "x".repeat(16), instance: "x".repeat(63) })).not.toThrow();
    expect(make({ apiKey: `${"Az09._~+/=-".repeat(46)}az` })).not.toThrow();
    expect(make({ apiKey: ` ${KEY}\n` })).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("reads the instance as a name, a host or a URL", () => {
    expect(gemLogicInstance("example")).toBe("example");
    expect(gemLogicInstance(" https://Example.gem-logic.com/ ")).toBe("example");
    expect(gemLogicInstance("shop-1.gem-logic.com")).toBe("shop-1");
    expect(gemLogicInstance("example.gem-logic.com.example")).toBeNull();
    expect(gemLogicInstance("example.gem-logicxcom")).toBeNull();
    expect(gemLogicInstance("https://example.gem-logic.com//")).toBeNull();
    expect(gemLogicClient({ apiKey: KEY, instance: "https://shop.gem-logic.com" }).baseUrl).toBe("https://shop.gem-logic.com/api");
  });

  it("lists channels and a channel's products with GET only, sending the key as trimmed", async () => {
    const { fetch, sent } = scripted(json(200, [{ id: 1 }]), json(200, [{ id: 9 }]));
    const { c } = client(fetch, { apiKey: `\t${KEY} ` });
    expect(await c.marketplaces()).toEqual([{ id: 1 }]);
    expect(await c.products("ab-1", 3)).toEqual({ records: [{ id: 9 }], more: false });
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([`GET ${API}/marketplaces/`, `GET ${API}/products/ab-1?page=3`]);
    for (const s of sent) {
      expect(s.headers).toEqual({ "x-api-key": KEY, accept: "application/json" });
      expect(s.body).toBeUndefined();
    }
  });

  it("follows a paged answer while next says more follow", async () => {
    const page = async (body: unknown) => (await client(scripted(json(200, body)).fetch).c.products("1", 1));
    expect(await page({ results: [{ id: 1 }], next: `${API}/products/1?page=2` })).toEqual({ records: [{ id: 1 }], more: true });
    for (const next of [null, "", undefined, 2, true]) expect((await page({ results: [], next })).more, String(next)).toBe(false);
    expect((await client(scripted(json(200, { results: [{ id: 1 }], next: "x" })).fetch).c.marketplaces())).toEqual([{ id: 1 }]);
  });

  it("checks what it is asked for before sending", async () => {
    const { fetch, sent } = scripted(json(200, []));
    const { c } = client(fetch);
    for (const id of ["", "a/b", "1?x=2", "a b", "x".repeat(65), "..", "1#"]) await expect(c.products(id, 1), id).rejects.toThrow(new GemLogicApiError("not a sales channel ID", 0));
    for (const page of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) await expect(c.products("1", page), String(page)).rejects.toThrow(new GemLogicApiError("page must be a whole number, 1 or more", 0));
    await expect(c.products("x".repeat(64), 1)).resolves.toEqual({ records: [], more: false });
    expect(sent).toHaveLength(1);
  });

  it("says when Gem Logic turns down the key or answers oddly, never repeating Gem Logic's words", async () => {
    for (const status of [401, 403]) {
      const err = await client(scripted(json(status, { detail: "secret detail" })).fetch).c.marketplaces().catch((e: Error) => e);
      expect(err).toBeInstanceOf(GemLogicConfigError);
      expect((err as Error).message).toBe(`Gem Logic turned down GEM_LOGIC_API_KEY for sales channels (HTTP ${status}); check the key is active on this instance`);
    }
    const err = (await client(scripted(json(404, { detail: "secret detail" })).fetch).c.products("1", 1).catch((e: Error) => e)) as GemLogicApiError;
    expect(err).toBeInstanceOf(GemLogicApiError);
    expect(err.message).toBe("Gem Logic answered HTTP 404 for products");
    expect(err.status).toBe(404);
    expect(err.name).toBe("GemLogicApiError");
    expect(new GemLogicConfigError("x").name).toBe("GemLogicConfigError");
    await expect(client(scripted(json(201, [])).fetch).c.marketplaces()).rejects.toThrow("Gem Logic answered HTTP 201 for sales channels");
    for (const answer of [text(200, "not json"), json(200, null), json(200, {}), json(200, { results: {} }), json(200, { items: [] }), json(200, "list")]) {
      const e = (await client(scripted(answer).fetch).c.products("1", 1).catch((x: Error) => x)) as GemLogicApiError;
      expect(e.message).toBe("Gem Logic answered without a list of products");
      expect(e.status).toBe(200);
    }
  });

  it("waits out rate limits and server errors, honoring Retry-After up to a minute, then gives up", async () => {
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "5" }), json(503, {}), json(429, {}, { "retry-after": "600" }), json(200, []));
    const { c, slept } = client(fetch);
    expect(await c.marketplaces()).toEqual([]);
    expect(slept).toEqual([5000, 2000, 60_000]);
    expect(sent).toHaveLength(4);
    for (const status of [500, 502, 504]) {
      const s = scripted(json(status, {}), json(200, []));
      expect(await client(s.fetch).c.marketplaces(), String(status)).toEqual([]);
    }
    const always = scripted(json(500, {}));
    const r = client(always.fetch);
    await expect(r.c.marketplaces()).rejects.toThrow("Gem Logic answered HTTP 500 for sales channels");
    expect(always.sent).toHaveLength(4);
    expect(r.slept).toEqual([1000, 2000, 4000]);
    const odd = client(scripted(json(429, {}, { "retry-after": "soon" }), json(200, [])).fetch);
    await odd.c.marketplaces();
    expect(odd.slept).toEqual([1000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    for (const status of [400, 401, 404, 501]) {
      const s = scripted(json(status, {}));
      await client(s.fetch).c.marketplaces().catch(() => undefined);
      expect(s.sent, String(status)).toHaveLength(1);
    }
    const s = scripted(json(503, {}));
    await client(s.fetch, { retries: 1 }).c.marketplaces().catch(() => undefined);
    expect(s.sent).toHaveLength(2);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const s = scripted(json(503, {}), json(200, []));
    globalThis.fetch = s.fetch;
    try {
      const started = Date.now();
      expect(await gemLogicClient({ apiKey: KEY, instance: "example" }).marketplaces()).toEqual([]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    } finally {
      globalThis.fetch = real;
    }
    expect(s.sent).toHaveLength(2);
  });
});

describe("Gem Logic reading helpers", () => {
  it("reads Gem Logic's times as UTC", () => {
    expect(gemLogicTime("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000Z");
    expect(gemLogicTime("2026-01-02T03:04:05.123456+02:00")).toBe("2026-01-02T01:04:05.123Z");
    expect(gemLogicTime("2026-01-02 03:04:05")).toBe("2026-01-02T03:04:05.000Z");
    expect(gemLogicTime(" 2026-01-02 ")).toBe("2026-01-02T00:00:00.000Z");
    expect(gemLogicTime("2026-01-02T23:59:59-05:00")).toBe("2026-01-03T04:59:59.000Z");
    for (const bad of ["2026-02-30", "2026-02-30T00:00:00Z", "2026-01-02T24:00:00Z", "2026-01-02T12:60:00Z", "2026-01-02T03:04", "2026-01-02T03:04:05.1234567Z", "2026-01-02X03:04:05Z", "2026-01-02T03:04:05+0200", "x2026-01-02", "2026-01-02x", "", null, 5]) expect(gemLogicTime(bad), String(bad)).toBeUndefined();
  });

  it("reads a time with no zone as UTC wherever the server is", () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(gemLogicTime("2026-07-01 12:00:00")).toBe("2026-07-01T12:00:00.000Z");
    } finally {
      process.env.TZ = tz;
    }
  });

  it("reads IDs written as numbers or strings", () => {
    expect(gemLogicId(12)).toBe("12");
    expect(gemLogicId("AB-12")).toBe("ab-12");
    expect(gemLogicId("x".repeat(64))).toBe("x".repeat(64));
    for (const bad of [0, -1, 1.5, "", "a/b", "x".repeat(65), null, undefined, Number.MAX_SAFE_INTEGER + 1, " 1"]) expect(gemLogicId(bad), String(bad)).toBeUndefined();
    expect(gemLogicId(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(gemLogicRef("product", "1")).toBe("gem_logic:product:1");
  });
});

describe("Gem Logic events", () => {
  const ctx = { receivedAt: RECEIVED, marketplace: { id: "1", name: "Counter" } };
  const one = (o: Record<string, unknown> = {}) => {
    gemLogicProduct.reset();
    return gemLogicProduct.one(o);
  };

  it("names its event type", () => {
    expect(GEM_LOGIC_EVENTS).toEqual({ product: "product.updated" });
  });

  it("keeps a product's SKU, status, channel, images and size, and no image links", () => {
    const e = gemLogicProductEvent(one(), ctx);
    expect(e.type).toBe("product.updated");
    expect(e.occurredAt).toBe("2026-01-02T00:00:00.000Z");
    expect(e.receivedAt).toBe(RECEIVED);
    expect(e.payload).toStrictEqual({
      system: "Gem Logic",
      productId: "gem_logic:product:1",
      marketplaceId: "gem_logic:marketplace:1",
      marketplace: "Counter",
      sku: "RING-1001",
      status: "active",
      createdAt: "2026-01-02T00:00:00.000Z",
      imageCount: 1,
      weight: 3.25,
      height: 2,
      length: 21,
      width: 21,
    });
    expect(JSON.stringify(e)).not.toContain("example.test");
    const odd = gemLogicProductEvent(one({ item_sku: ` ${"S".repeat(90)} `, status: "  ", images: "x", item_weight: "4.5", item_height: -1, item_length: "1e3", item_width: 1e9 }), { ...ctx, marketplace: { id: "2", name: null } }).payload;
    expect(odd).toMatchObject({ marketplace: null, sku: "S".repeat(80), status: null, imageCount: null, weight: 4.5, height: null, length: null, width: null });
    const more = gemLogicProductEvent(one({ status: "S".repeat(50), images: [], item_weight: Number.POSITIVE_INFINITY, item_height: "2", item_length: 0, item_width: 999_999_999.5, item_sku: 5 }), ctx).payload;
    expect(more).toMatchObject({ status: "S".repeat(40), imageCount: 0, weight: null, height: 2, length: 0, width: 999_999_999.5, sku: null });
    for (const v of ["4.", "-1", "1234567890", "1.1234567", true, null]) expect(gemLogicProductEvent(one({ item_weight: v }), ctx).payload.weight, String(v)).toBeNull();
    expect(gemLogicProductEvent(one({ item_weight: "123456789.123456" }), ctx).payload.weight).toBe(123456789.123456);
    expect(gemLogicProductEvent(one({ item_weight: " 4.5 " }), ctx).payload.weight).toBe(4.5);
  });

  it("keys each version by its channel and what was kept, so an unchanged one is a duplicate", () => {
    const a = gemLogicProductEvent(one(), ctx);
    expect(a.idempotencyKey).toMatch(/^gem_logic:product:1:1:[0-9a-f]{12}$/);
    expect(a.id).toBe(a.idempotencyKey.replace(/:/g, "_"));
    expect(gemLogicProductEvent(one(), { ...ctx, receivedAt: "2027-01-01T00:00:00.000Z" }).idempotencyKey).toBe(a.idempotencyKey);
    expect(gemLogicProductEvent(one({ images: [{ id: 1, image: "https://example.test/other.jpg" }] }), ctx).idempotencyKey).toBe(a.idempotencyKey);
    expect(gemLogicProductEvent(one({ status: "sold" }), ctx).idempotencyKey).not.toBe(a.idempotencyKey);
    const web = gemLogicProductEvent(one(), { ...ctx, marketplace: { id: "2", name: "Counter" } });
    expect(web.idempotencyKey).toMatch(/^gem_logic:product:2:1:/);
    expect(gemLogicProductEvent(one({ id: "1" }), ctx).idempotencyKey).toBe(a.idempotencyKey);
  });

  it("dead-letters a product that doesn't read, listing why", () => {
    const e = gemLogicProductEvent({ id: "a/b", created: "soon" }, ctx);
    expect(e.occurredAt).toBeUndefined();
    expect(e.type).toBe("product.updated");
    expect(e.payload).toEqual({ system: "Gem Logic", productId: null, marketplaceId: "gem_logic:marketplace:1", problems: ["product has no ID that reads", "product has no time that reads"] });
    expect(e.idempotencyKey).toMatch(/^gem_logic:unreadable_product:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    expect(gemLogicProductEvent({ id: "a/c", created: "soon" }, ctx).idempotencyKey).not.toBe(e.idempotencyKey);
    const t = gemLogicProductEvent({ id: 7 }, ctx);
    expect(t.payload).toEqual({ system: "Gem Logic", productId: "gem_logic:product:7", marketplaceId: "gem_logic:marketplace:1", problems: ["product has no time that reads"] });
    const i = gemLogicProductEvent({ created: "2026-01-01" }, ctx);
    expect(i.payload.problems).toEqual(["product has no ID that reads"]);
    expect(i.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    for (const raw of [null, "x", []]) expect(gemLogicProductEvent(raw, ctx).payload.problems, JSON.stringify(raw)).toHaveLength(2);
  });
});

describe("Gem Logic checkpoint", () => {
  it("reads a checkpoint it wrote, and turns down anything else", () => {
    expect(parseGemLogicCursor(null)).toBeNull();
    const pass = { index: 2, marketplaceId: "ab-1", page: 3 };
    expect(parseGemLogicCursor(JSON.stringify({ pass, done: true }))).toEqual({ pass, done: true });
    expect(parseGemLogicCursor(JSON.stringify({ pass: null, done: false }))).toEqual({ pass: null, done: false });
    expect(parseGemLogicCursor(JSON.stringify({ pass: { index: 0, marketplaceId: "1", page: 1 }, done: false }))).toEqual({ pass: { index: 0, marketplaceId: "1", page: 1 }, done: false });
    const bad = [
      "",
      "not json",
      "null",
      "[]",
      "5",
      JSON.stringify({ pass: null }),
      JSON.stringify({ pass: null, done: "true" }),
      JSON.stringify({ done: false }),
      JSON.stringify({ pass: {}, done: false }),
      JSON.stringify({ pass: { ...pass, index: -1 }, done: false }),
      JSON.stringify({ pass: { ...pass, index: 1.5 }, done: false }),
      JSON.stringify({ pass: { ...pass, index: "2" }, done: false }),
      JSON.stringify({ pass: { ...pass, page: 0 }, done: false }),
      JSON.stringify({ pass: { ...pass, page: 1.5 }, done: false }),
      JSON.stringify({ pass: { ...pass, page: "3" }, done: false }),
      JSON.stringify({ pass: { ...pass, marketplaceId: "AB-1" }, done: false }),
      JSON.stringify({ pass: { ...pass, marketplaceId: "a/b" }, done: false }),
      JSON.stringify({ pass: { ...pass, marketplaceId: 1 }, done: false }),
      JSON.stringify({ pass: { index: 0, page: 1 }, done: false }),
    ];
    for (const raw of bad) expect(() => parseGemLogicCursor(raw), raw).toThrow("Gem Logic checkpoint is not in the expected shape");
  });
});

describe("Gem Logic connector", () => {
  it("passes the shared connector checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(gemLogicDocMock(shop())), expected: { ingested: 5 } });
    expect(result.full.ingested).toBe(5);
  });

  it("imports every channel's products, a page at a time, then stops for good", async () => {
    const mock = gemLogicDocMock(shop({ pageSize: 2 }));
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(mock.reads.map((r) => `${r.path}${r.query.page ? `?${r.query.page}` : ""}`)).toEqual(["/api/marketplaces/", "/api/products/1?1", "/api/products/1?2", "/api/products/2?1"]);
    expect(batches.map((b) => b.events.length)).toEqual([2, 1, 2]);
    expect(batches.map((b) => parseGemLogicCursor(b.cursor ?? null))).toEqual([
      { pass: { index: 0, marketplaceId: "1", page: 2 }, done: false },
      { pass: { index: 1, marketplaceId: "2", page: 1 }, done: false },
      { pass: null, done: true },
    ]);
    expect(eventsOf(batches).map((e) => e.payload.marketplace)).toEqual(["Counter", "Counter", "Counter", "Web store", "Web store"]);
    expect(eventsOf(batches).every((e) => e.receivedAt === RECEIVED)).toBe(true);
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(gemLogicDocMock(shop())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(first.ingested).toBe(5);
    const again = gemLogicDocMock(shop());
    const second = await runSync({ connector: connector(again), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(second.ingested).toBe(0);
    expect(again.reads).toHaveLength(0);
  });

  it("resumes where its checkpoint stands, or from the start when that channel has moved", async () => {
    const mock = gemLogicDocMock(shop({ pageSize: 2 }));
    const resumed = await drain(connector(mock).historicalImport({ cursor: JSON.stringify({ pass: { index: 0, marketplaceId: "1", page: 2 }, done: false }) } as never));
    expect(mock.reads.map((r) => r.path + (r.query.page ?? ""))).toEqual(["/api/marketplaces/", "/api/products/12", "/api/products/21"]);
    expect(eventsOf(resumed)).toHaveLength(3);
    const moved = gemLogicDocMock(shop({ pageSize: 2 }));
    await drain(connector(moved).historicalImport({ cursor: JSON.stringify({ pass: { index: 1, marketplaceId: "1", page: 2 }, done: false }) } as never));
    expect(moved.reads.map((r) => r.path + (r.query.page ?? ""))).toEqual(["/api/marketplaces/", "/api/products/11", "/api/products/12", "/api/products/21"]);
    const gone = gemLogicDocMock(shop());
    expect(eventsOf(await drain(connector(gone).historicalImport({ cursor: JSON.stringify({ pass: { index: 5, marketplaceId: "9", page: 1 }, done: false }) } as never)))).toHaveLength(5);
  });

  it("ends a pass with no channels, and skips a channel whose ID doesn't read", async () => {
    const none = await drain(connector(gemLogicDocMock(shop({ marketplaces: [] }))).historicalImport({ cursor: null } as never));
    expect(none.map((b) => [b.events.length, parseGemLogicCursor(b.cursor ?? null)])).toEqual([[0, { pass: null, done: true }]]);
    const later = await drain(connector(gemLogicDocMock(shop({ marketplaces: [] }))).incrementalSync({ cursor: JSON.stringify({ pass: null, done: false }) } as never));
    expect(later.map((b) => parseGemLogicCursor(b.cursor ?? null))).toEqual([{ pass: null, done: false }]);
    const asked: string[] = [];
    const fake: GemLogicClient = {
      baseUrl: API,
      marketplaces: async () => [null, { id: "a/b", marketplace: "Bad" }, { id: 3, marketplace: "  " }, "x", { id: "AB", marketplace: ` ${"M".repeat(70)} ` }],
      products: async (id) => (asked.push(id), { records: [gemLogicProduct.one()], more: false }),
    };
    const events = eventsOf(await drain(gemLogicConnector({ apiKey: KEY, instance: "example", client: fake, now: NOW }).historicalImport({ cursor: null } as never)));
    expect(asked).toEqual(["3", "ab"]);
    expect(events.map((e) => e.payload.marketplace)).toEqual([null, "M".repeat(60)]);
  });

  it("reads every product again on each later sync, so only a change is new", async () => {
    const data = shop();
    const mock = gemLogicDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const quiet = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(quiet.ingested).toBe(0);
    expect(quiet.duplicates).toBe(5);
    expect(parseGemLogicCursor(quiet.cursor)).toEqual({ pass: null, done: false });
    data.products!["2"]![0]!.status = "sold";
    const changed = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(changed.ingested).toBe(1);
    // A later sync after the import ended keeps saying so, mid-pass and at its end.
    const paged = gemLogicDocMock(shop({ pageSize: 2 }));
    const after = await drain(connector(paged).incrementalSync({ cursor: JSON.stringify({ pass: null, done: true }) } as never));
    expect(after.map((b) => parseGemLogicCursor(b.cursor ?? null)!.done)).toEqual([true, true, true]);
    const mid = await drain(connector(gemLogicDocMock(shop({ pageSize: 2 }))).incrementalSync({ cursor: JSON.stringify({ pass: { index: 0, marketplaceId: "1", page: 2 }, done: false }) } as never));
    expect(mid.map((b) => parseGemLogicCursor(b.cursor ?? null)!.done)).toEqual([false, false]);
    const first = await drain(connector(gemLogicDocMock(shop())).incrementalSync({ cursor: null } as never));
    expect(parseGemLogicCursor(first.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: false });
  });

  it("dead-letters a product that doesn't read and keeps going", async () => {
    const data = shop();
    data.products!["1"]![1]!.created = "soon";
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(gemLogicDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.deadLettered).toBe(1);
    expect(report.ingested).toBe(4);
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = gemLogicDocMock(shop({ rateLimits: 2 }));
    const slept: number[] = [];
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { sleep: async (ms) => void slept.push(ms) }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(5);
    expect(slept).toEqual([1000, 1000]);
  });

  it("says when Gem Logic turns the key down, reading nothing", async () => {
    const mock = gemLogicDocMock(shop({ apiKey: ["o", "1".repeat(31)].join("") }));
    await expect(drain(connector(mock).historicalImport({ cursor: null } as never))).rejects.toThrow(GemLogicConfigError);
  });

  it("uses the real clock when none is given", async () => {
    const before = Date.now();
    const batches = await drain(gemLogicConnector({ apiKey: KEY, instance: "example", fetch: gemLogicDocMock(shop()).fetch, sleep: noSleep }).historicalImport({ cursor: null } as never));
    const at = Date.parse(eventsOf(batches)[0]!.receivedAt);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it("only ever lists channels and their products", async () => {
    const mock = gemLogicDocMock(shop({ pageSize: 2 }));
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`))).toEqual(new Set(["GET /api/marketplaces/", "GET /api/products/1", "GET /api/products/2"]));
  });

  it("declares no writes", async () => {
    const c = connector(gemLogicDocMock(shop()));
    expect(GEM_LOGIC_WRITES).toEqual([]);
    expect(c.writes).toBe(GEM_LOGIC_WRITES);
    expect(c.source).toBe("gem_logic");
    expect(await assertWritesRefused(c)).toEqual([]);
  });
});

describe("Gem Logic doc mock", () => {
  it("checks the key, finds the channel and pages", async () => {
    const mock = gemLogicDocMock(shop({ pageSize: 2 }));
    const get = async (path: string, key = KEY) => mock.fetch(`https://example.gem-logic.com/api/${path}`, { method: "GET", headers: { "x-api-key": key } });
    expect((await get("marketplaces/", "wrong")).status).toBe(401);
    expect((await mock.fetch("https://example.gem-logic.com/api/marketplaces/")).status).toBe(401);
    expect((await gemLogicDocMock({ apiKey: "" }).fetch("https://example.gem-logic.com/api/marketplaces/", { headers: { "x-api-key": "" } })).status).toBe(401);
    expect((await get("products/9")).status).toBe(404);
    expect((await get("products/1?page=0")).status).toBe(404);
    expect(await (await get("products/1?page=2")).json()).toMatchObject({ count: 3, next: null, previous: "https://example.gem-logic.com/api/products/1?page=1", results: [{ id: 3 }] });
    expect(await (await get("products/1")).json()).toMatchObject({ next: "https://example.gem-logic.com/api/products/1?page=2", previous: null });
    expect(await (await gemLogicDocMock({ apiKey: KEY, marketplaces: [{ id: 4 }] }).fetch(`${API}/products/4`, { headers: { "x-api-key": KEY } })).json()).toEqual([]);
    expect(await (await gemLogicDocMock({ apiKey: KEY }).fetch(`${API}/marketplaces/`, { headers: { "x-api-key": KEY } })).json()).toEqual([]);
    const limited = gemLogicDocMock(shop({ rateLimits: 1 }));
    const r = await limited.fetch(`${API}/marketplaces/`, { headers: { "x-api-key": KEY } });
    expect([r.status, r.headers.get("retry-after")]).toEqual([429, "1"]);
    const unsorted = gemLogicDocMock({ apiKey: KEY, products: { "1": [{ id: 3 }, { id: 1 }, { id: 2 }] } });
    expect(await (await unsorted.fetch(`${API}/products/1`, { headers: { "x-api-key": KEY } })).json()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    await expect(mock.fetch(`${API}/sales/create/`, { method: "POST" })).rejects.toThrow("not in the vendor's docs");
  });
});
