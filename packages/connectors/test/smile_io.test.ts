import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import {
  SMILE_DOC_PAGES,
  SMILE_TEST_TIERS,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  smileCustomer,
  smileDocMock,
  smilePointsTransaction,
  synthetic,
  testPipeline,
  type SmileMock,
  type SmileMockData,
} from "@karatos/connector-testkit";
import {
  SMILE_CURSOR,
  SMILE_CUSTOMER_EVENT,
  SMILE_FIRST_LOOKBACK_MS,
  SMILE_OVERLAP_MS,
  SMILE_PAGE_SIZE,
  SMILE_POINTS_EVENT,
  SMILE_READ_SCOPES,
  SMILE_WRITES,
  SmileApiError,
  SmileConfigError,
  formCustomerRefs,
  parseSmileCursor,
  smileClient,
  smileConnector,
  smileCustomerEvent,
  smilePointsEvent,
  smileTierNames,
  type SmileClient,
  type SmileCursor,
  type SmileEvent,
  type SmileOptions,
} from "../src/index.js";

// A key-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const API_KEY = ["api", "test", "0".repeat(24)].join("_");
const CUSTOMER_KEY = "c".repeat(40);
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const BASE = "https://api.smile.io/v1";
const HOUR_MS = 3_600_000;
const FIVE_YEARS = "2021-11-11T15:00:00.000Z";
const noSleep = async () => {};

/** `ago` hours before NOW. */
const before = (ago: number) => new Date(NOW().getTime() - ago * HOUR_MS).toISOString();

/** Customers and transactions that last changed 1, 30 and 5,000 hours ago, and six years ago, past the five read. */
function program(overrides: Partial<SmileMockData> = {}): SmileMockData {
  smileCustomer.reset();
  smilePointsTransaction.reset();
  const ages = [1, 30, 5000, 52_600];
  const customers = ages.map((ago) => smileCustomer.one({ created_at: before(ago + 1), updated_at: before(ago) }));
  const pointsTransactions = ages.map((ago) => smilePointsTransaction.one({ created_at: before(ago), updated_at: before(ago) }));
  return { apiKey: API_KEY, customers, pointsTransactions, ...overrides };
}

const connector = (mock: SmileMock, overrides: Partial<SmileOptions> = {}) => smileConnector({ apiKey: API_KEY, customerKey: CUSTOMER_KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as SmileEvent[];

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

/** A fetch that answers in turn and records what was sent. */
function scripted(...answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) } });
    return answers[Math.min(sent.length - 1, answers.length - 1)]!();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const text = (status: number, body: string) => () => new Response(body, { status });
const PAGE = { customers: [], metadata: { next_cursor: null, previous_cursor: null } };
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof smileClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = smileClient({ apiKey: API_KEY, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const ctx = { customerKey: CUSTOMER_KEY, receivedAt: RECEIVED, tiers: smileTierNames(SMILE_TEST_TIERS) };

describe("Smile.io client", () => {
  it("checks its key before sending anything", () => {
    const { fetch, sent } = scripted(json(200, PAGE));
    for (const apiKey of ["", "test_" + "0".repeat(20), "api_short", `api_${"0".repeat(7)}`, "oa2_" + "0".repeat(20), `api_${"0".repeat(20)} x`, `api_${"0".repeat(257)}`, `api_${"0".repeat(20)}!`, `xapi_${"0".repeat(20)}`]) {
      expect(() => smileClient({ apiKey, fetch }), apiKey).toThrow("SMILE_API_KEY is missing or not in the expected shape: a merchant API key starts with api_");
    }
    expect(() => smileClient({ apiKey: ` api_${"a".repeat(8)} `, fetch })).not.toThrow();
    expect(() => smileClient({ apiKey: `api_${"a-_".repeat(85)}A`, fetch })).not.toThrow();
    expect(() => smileClient({} as never)).toThrow(SmileConfigError);
    expect(sent).toHaveLength(0);
  });

  it("reads the VIP tiers, then a page of customers with their VIP status, changed since a time", async () => {
    const { fetch, sent } = scripted(json(200, { vip_tiers: [{ id: 1 }] }), json(200, { customers: [{ id: 2 }], metadata: { next_cursor: "abc=", previous_cursor: null } }));
    const { c } = client(fetch, { apiKey: ` ${API_KEY} ` });
    expect(await c.vipTiers()).toEqual([{ id: 1 }]);
    expect(await c.page("customers", before(1), null)).toEqual({ rows: [{ id: 2 }], next: "abc=" });
    expect(sent).toEqual([
      { url: `${BASE}/vip_tiers`, method: "GET", headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" } },
      { url: `${BASE}/customers?limit=250&include=vip_status&updated_at_min=${encodeURIComponent(before(1))}`, method: "GET", headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" } },
    ]);
    expect(SMILE_PAGE_SIZE).toBe(250);
    expect(SMILE_READ_SCOPES).toEqual(["customer:read", "points_transaction:read", "vip_tier:read"]);
  });

  it("pages points transactions with Smile's cursor, and reads them all with no start", async () => {
    const { fetch, sent } = scripted(json(200, { points_transactions: [], metadata: { next_cursor: null } }));
    const { c } = client(fetch);
    expect(await c.page("points_transactions", null, "a+/=_.~-")).toEqual({ rows: [], next: null });
    expect(sent[0]!.url).toBe(`${BASE}/points_transactions?limit=250&cursor=a%2B%2F%3D_.%7E-`);
  });

  it("checks cursors and starts before sending", async () => {
    const { fetch, sent } = scripted(json(200, PAGE));
    const { c } = client(fetch);
    for (const cursor of ["", "a b", "a&b", "x".repeat(2049)]) await expect(c.page("customers", null, cursor)).rejects.toThrow("Smile's page cursor isn't in the expected shape");
    await expect(c.page("customers", "yesterday", null)).rejects.toMatchObject({ message: "a list's start must be a time", status: 0, name: "SmileApiError" });
    expect(sent).toHaveLength(0);
    expect(SMILE_CURSOR.test("x".repeat(2048))).toBe(true);
  });

  it("says when an answer has no list, or a next cursor that doesn't read", async () => {
    for (const body of [null, [], "x", { customers: {} }, { points_transactions: [] }]) {
      const { c } = client(scripted(json(200, body)).fetch);
      await expect(c.page("customers", null, null)).rejects.toThrow(new SmileApiError("Smile answered customers without a list", 200));
    }
    const { c: notJson } = client(scripted(text(200, "<html>")).fetch);
    await expect(notJson.vipTiers()).rejects.toThrow("Smile answered vip_tiers without a list");
    for (const metadata of [undefined, null, [], {}, { next_cursor: 5 }, { next_cursor: "a b" }, { next_cursor: "" }]) {
      const { c } = client(scripted(json(200, { customers: [], ...(metadata === undefined ? {} : { metadata }) })).fetch);
      await expect(c.page("customers", null, null)).rejects.toMatchObject({ message: "Smile's customers page had no next cursor in the expected shape", status: 200 });
    }
  });

  it("explains a turned-down key and a missing scope, and reports other errors", async () => {
    const { c: wrong } = client(scripted(json(401, {})).fetch);
    await expect(wrong.vipTiers()).rejects.toThrow(new SmileConfigError("Smile turned down SMILE_API_KEY: check it, and that the store is still on a plan with API access"));
    for (const [list, scope] of [["vip_tiers", "vip_tier:read"], ["customers", "customer:read"], ["points_transactions", "points_transaction:read"]] as const) {
      const { c } = client(scripted(json(403, {})).fetch);
      const call = list === "vip_tiers" ? c.vipTiers() : c.page(list, null, null);
      await expect(call).rejects.toThrow(new SmileConfigError(`SMILE_API_KEY can't read ${list}: make a key with ${scope}`));
    }
    for (const status of [201, 400, 404, 422, 502]) {
      const { c } = client(scripted(json(status, PAGE)).fetch);
      await expect(c.page("customers", null, null)).rejects.toMatchObject({ message: `Smile answered HTTP ${status} for customers`, status, name: "SmileApiError" });
    }
  });

  it("waits out rate limits as Retry-After says, up to a minute, or backs off", async () => {
    const { c, slept } = client(scripted(json(429, {}, { "Retry-After": "7" }), json(429, {}, { "Retry-After": "600" }), json(429, {}, { "Retry-After": "soon" }), json(200, PAGE)).fetch);
    await c.page("customers", null, null);
    expect(slept).toEqual([7000, 60_000, 4000]);
    const { c: c2, slept: s2 } = client(scripted(json(429, {}, { "Retry-After": "0" }), json(429, {}), json(200, PAGE)).fetch);
    await c2.page("customers", null, null);
    expect(s2).toEqual([1000, 2000]);
  });

  it("retries 500 and 503 too, then gives up", async () => {
    const { c, slept } = client(scripted(json(500, {}), json(503, {}), json(500, {}), json(503, {})).fetch);
    await expect(c.page("customers", null, null)).rejects.toMatchObject({ status: 503 });
    expect(slept).toEqual([1000, 2000, 4000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const { c, slept } = client(scripted(json(504, {})).fetch);
    await expect(c.page("customers", null, null)).rejects.toMatchObject({ status: 504 });
    expect(slept).toEqual([]);
    const { c: once, slept: s1 } = client(scripted(json(429, {}), json(429, {})).fetch, { retries: 1 });
    await expect(once.page("customers", null, null)).rejects.toMatchObject({ status: 429 });
    expect(s1).toEqual([1000]);
    const { c: none, slept: s0 } = client(scripted(json(429, {})).fetch, { retries: 0 });
    await expect(none.page("customers", null, null)).rejects.toMatchObject({ status: 429 });
    expect(s0).toEqual([]);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(json(429, {}, { "Retry-After": "0.001" }), json(200, { vip_tiers: [] }));
    globalThis.fetch = fetch;
    try {
      expect(await smileClient({ apiKey: API_KEY }).vipTiers()).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(2);
  });

  it("only ever sends GETs to the three lists", async () => {
    const mock = smileDocMock(program());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect([...new Set(mock.reads.map((r) => r.kind))]).toEqual(["customers", "points_transactions"]);
    expect(mock.api.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/vip_tiers", "GET /v1/customers", "GET /v1/points_transactions"]);
  });
});

describe("Smile.io events", () => {
  const customer = (extra: Record<string, unknown> = {}) => {
    smileCustomer.reset();
    return smileCustomer.one({ created_at: before(3), updated_at: before(1), ...extra });
  };
  const txn = (extra: Record<string, unknown> = {}) => {
    smilePointsTransaction.reset();
    return smilePointsTransaction.one({ created_at: before(2), updated_at: before(1), ...extra });
  };

  it("names tiers from the program's list, dropping ones that don't read", () => {
    expect([...smileTierNames(SMILE_TEST_TIERS)]).toEqual([[1, "Silver"], [2, "Gold"], [3, "Rose Gold"]]);
    const odd = smileTierNames([null, "x", { id: 0, name: "Zero" }, { id: 4, name: "<b>" }, { id: 5, name: 5 }, { id: 6, name: " Platinum " }, { id: 7, name: "x".repeat(41) }, { id: 8, name: "x".repeat(40) }, { id: 9, name: "a<b" }, { id: "10", name: "Ten" }, { id: 11, name: "<b" }]);
    expect([...odd]).toEqual([[6, "Platinum"], [8, "x".repeat(40)]]);
  });

  it("logs a customer's points and tier as Yotpo's are, with no name, birthday or link", () => {
    const r = smileCustomerEvent(customer({ vip_status: { vip_tier_id: 2, vip_tier_expires_at: before(-720), progress_value: 340.5, current_vip_period_end: before(-24), delta_to_retain_vip_tier: 10, next_vip_tier_id: 3, delta_to_next_vip_tier: 159.5 } }), ctx);
    expect(r.ok).toBe(true);
    expect(r.event).toEqual({
      id: r.event.idempotencyKey.replace(/:/g, "_"),
      type: SMILE_CUSTOMER_EVENT,
      occurredAt: before(1),
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^smile_io:customer:701:[0-9a-f]{12}$/),
      payload: {
        system: "Smile.io",
        loyaltyCustomerId: "smile_io:customer:701",
        customerRefs: formCustomerRefs(CUSTOMER_KEY, { email: synthetic.email(1) }),
        state: "member",
        member: true,
        pointsBalance: 120,
        vipTier: "Gold",
        vipTierId: "smile_io:vip_tier:2",
        vipTierUntil: before(-720),
        vipProgress: 340.5,
        vipPeriodEnd: before(-24),
        toRetainVipTier: 10,
        nextVipTier: "Rose Gold",
        toNextVipTier: 159.5,
        createdAt: before(3),
        updatedAt: before(1),
      },
    });
    const kept = JSON.stringify(r.event);
    for (const secret of [synthetic.email(1), "Customer 1", "1004", "loyalty.example.test"]) expect(kept).not.toContain(secret);
    expect(SMILE_CUSTOMER_EVENT).toBe("loyalty.customer_updated");
  });

  it("falls back to the older tier field, and leaves out what doesn't read", () => {
    const r = smileCustomerEvent(customer({ state: "candidate", email: "nope", vip_status: null, vip_tier_id: 1 }), ctx);
    expect(r.event.payload).toMatchObject({ state: "candidate", member: false, customerRefs: [], vipTier: "Silver", vipTierId: "smile_io:vip_tier:1" });
    const bare = smileCustomerEvent(customer({ state: "disabled", vip_status: { vip_tier_id: 99, vip_tier_expires_at: "soon", progress_value: "340", current_vip_period_end: 5, delta_to_retain_vip_tier: Number.NaN, next_vip_tier_id: 0, delta_to_next_vip_tier: Infinity }, vip_tier_id: 2 }), ctx).event.payload;
    expect(bare).toEqual({ system: "Smile.io", loyaltyCustomerId: "smile_io:customer:701", customerRefs: formCustomerRefs(CUSTOMER_KEY, { email: synthetic.email(1) }), state: "disabled", member: false, pointsBalance: 120, vipTier: undefined, vipTierId: "smile_io:vip_tier:99", vipTierUntil: undefined, vipProgress: undefined, vipPeriodEnd: undefined, toRetainVipTier: undefined, nextVipTier: undefined, toNextVipTier: undefined, createdAt: before(3), updatedAt: before(1) });
    const none = smileCustomerEvent(customer({ vip_status: {}, vip_tier_id: null }), ctx).event.payload;
    expect(none).toMatchObject({ vipTier: undefined, vipTierId: undefined, nextVipTier: undefined });
    expect(smileCustomerEvent(customer({ vip_status: { next_vip_tier_id: 7, delta_to_next_vip_tier: 0 } }), ctx).event.payload).toMatchObject({ nextVipTier: undefined, toNextVipTier: 0 });
    expect(smileCustomerEvent(customer({ points_balance: -5 }), ctx).event.payload.pointsBalance).toBe(-5);
  });

  it("dates a customer by their last change, or when they joined when there is none", () => {
    expect(smileCustomerEvent(customer({ updated_at: null }), ctx).event).toMatchObject({ occurredAt: before(3), payload: { updatedAt: before(3) } });
    expect(smileCustomerEvent(customer({ updated_at: "2026-11-11T10:00:00+05:00" }), ctx).event.occurredAt).toBe("2026-11-11T05:00:00.000Z");
  });

  it("logs a points transaction with whose balance and by how much, never its words", () => {
    const r = smilePointsEvent(txn({ internal_note: "Comped after a late repair" }), ctx);
    expect(r.ok).toBe(true);
    expect(r.event).toEqual({
      id: r.event.idempotencyKey.replace(/:/g, "_"),
      type: SMILE_POINTS_EVENT,
      occurredAt: before(2),
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^smile_io:points_transaction:9001:[0-9a-f]{12}$/),
      payload: { system: "Smile.io", transactionId: "smile_io:points_transaction:9001", loyaltyCustomerId: "smile_io:customer:701", pointsChange: 50, direction: "earned", createdAt: before(2) },
    });
    const kept = JSON.stringify(r.event);
    for (const secret of ["Placed an order", "late repair", synthetic.name(1)]) expect(kept).not.toContain(secret);
    expect(smilePointsEvent(txn({ points_change: -200 }), ctx).event.payload).toMatchObject({ pointsChange: -200, direction: "spent" });
    expect(smilePointsEvent(txn({ points_change: 0 }), ctx).event.payload).toMatchObject({ pointsChange: 0, direction: "earned" });
    expect(SMILE_POINTS_EVENT).toBe("loyalty.points_changed");
  });

  it("is a duplicate when read again unchanged, and a new event when it changes", () => {
    const a = smileCustomerEvent(customer(), ctx).event;
    expect(smileCustomerEvent(customer(), { ...ctx, receivedAt: "2026-11-12T00:00:00.000Z" }).event.idempotencyKey).toBe(a.idempotencyKey);
    expect(smileCustomerEvent(customer({ points_balance: 170 }), ctx).event.idempotencyKey).not.toBe(a.idempotencyKey);
    const t = smilePointsEvent(txn(), ctx).event;
    // A note edited later changes nothing kept, so it is the same event.
    expect(smilePointsEvent(txn({ internal_note: "x", updated_at: before(0.5) }), ctx).event.idempotencyKey).toBe(t.idempotencyKey);
  });

  it("dead-letters a customer or transaction it can't read, saying why", () => {
    const c = smileCustomerEvent({ id: "701", state: "vip", points_balance: "120" }, ctx);
    expect(c.ok).toBe(false);
    expect(c.event).toEqual({
      id: c.event.idempotencyKey.replace(/:/g, "_"),
      type: SMILE_CUSTOMER_EVENT,
      occurredAt: undefined,
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^smile_io:unreadable_customer:[0-9a-f]{12}$/),
      payload: { system: "Smile.io", customerId: null, problems: ["customer has no id that reads", "customer has no creation time that reads", "customer has no state that reads", "customer has no points balance that reads"] },
    });
    expect(smileCustomerEvent(customer({ points_balance: 1.5 }), ctx).event.payload).toEqual({ system: "Smile.io", customerId: 701, problems: ["customer has no points balance that reads"] });
    for (const raw of [null, [customer()], "x"]) expect(smileCustomerEvent(raw, ctx).event.payload.problems).toEqual(["customer is not an object", "customer has no id that reads", "customer has no creation time that reads", "customer has no state that reads", "customer has no points balance that reads"]);
    expect(smileCustomerEvent(null, ctx).event.idempotencyKey).not.toBe(smileCustomerEvent("x", ctx).event.idempotencyKey);
    for (const id of [0, -1, 1.5, 2 ** 53]) expect(smileCustomerEvent(customer({ id }), ctx).ok).toBe(false);
    const t = smilePointsEvent({ id: 5, points_change: 2 ** 53 }, ctx);
    expect(t.event).toMatchObject({ occurredAt: undefined, idempotencyKey: expect.stringMatching(/^smile_io:unreadable_points_transaction:[0-9a-f]{12}$/), payload: { system: "Smile.io", transactionId: 5, problems: ["points transaction has no customer that reads", "points transaction has no points change that reads", "points transaction has no time that reads"] } });
    expect(smilePointsEvent(7, ctx).event.payload).toEqual({ system: "Smile.io", transactionId: null, problems: ["points transaction is not an object", "points transaction has no id that reads", "points transaction has no customer that reads", "points transaction has no points change that reads", "points transaction has no time that reads"] });
  });
});

describe("Smile.io checkpoint", () => {
  const marks = { customers: before(1), points_transactions: null };
  const pass = { list: "points_transactions", since: before(30), top: before(2), cursor: "abc=" };
  const cursor = (c: unknown) => JSON.stringify(c);

  it("round-trips and turns down any other shape", () => {
    expect(parseSmileCursor(null)).toBeNull();
    const good: SmileCursor[] = [{ done: false, marks, pass: null }, { done: true, marks, pass: pass as SmileCursor["pass"] }, { done: false, marks: { customers: null, points_transactions: before(3) }, pass: { list: "customers", since: before(1), top: null, cursor: null } }];
    for (const c of good) expect(parseSmileCursor(cursor(c))).toEqual(c);
    const bad = [
      "",
      "x",
      "null",
      "[]",
      "5",
      cursor({ done: "yes", marks, pass: null }),
      cursor({ marks, pass: null }),
      cursor({ done: true, pass: null }),
      cursor({ done: true, marks: { customers: "2026-11-01" }, pass: null }),
      cursor({ done: true, marks: { ...marks, points_transactions: "x" }, pass: null }),
      cursor({ done: true, marks: { ...marks, customers: undefined }, pass: null }),
      cursor({ done: true, marks }),
      cursor({ done: true, marks, pass: { ...pass, list: "referrals" } }),
      cursor({ done: true, marks, pass: { ...pass, since: null } }),
      cursor({ done: true, marks, pass: { ...pass, since: "2026-11-01T00:00:00Z" } }),
      cursor({ done: true, marks, pass: { ...pass, top: "x" } }),
      cursor({ done: true, marks, pass: { ...pass, top: undefined } }),
      cursor({ done: true, marks, pass: { ...pass, cursor: "a b" } }),
      cursor({ done: true, marks, pass: { ...pass, cursor: 5 } }),
      cursor({ done: true, marks, pass: { ...pass, cursor: undefined } }),
      cursor({ done: true, marks, pass: "x" }),
    ];
    for (const raw of bad) expect(() => parseSmileCursor(raw), raw).toThrow("Smile.io checkpoint is not in the expected shape");
    expect(parseSmileCursor(cursor({ done: true, marks: { ...marks, extra: 1 }, pass: { ...pass, extra: 2 }, more: 3 }))).toEqual({ done: true, marks, pass });
  });
});

describe("Smile.io connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(smileDocMock(program())), expected: { ingested: 6 } });
    expect(result.full.ingested).toBe(6);
  });

  it("imports five years of customers, then points transactions, naming each tier, then stops for good", async () => {
    const mock = smileDocMock(program());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(6);
    expect(mock.reads).toEqual([
      { kind: "customers", query: { limit: "250", include: "vip_status", updated_at_min: FIVE_YEARS } },
      { kind: "points_transactions", query: { limit: "250", updated_at_min: FIVE_YEARS } },
    ]);
    expect(memory.events.map((e) => e.type)).toEqual([...Array(3).fill(SMILE_CUSTOMER_EVENT), ...Array(3).fill(SMILE_POINTS_EVENT)]);
    expect(memory.events[0]!.payload).toMatchObject({ vipTier: "Gold", nextVipTier: "Rose Gold" });
    expect(parseSmileCursor(report.cursor)).toEqual({ done: true, marks: { customers: before(1), points_transactions: before(1) }, pass: null });
    assertSynthetic(memory.events);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(2);
  });

  it("reads 250 a page, keeping Smile's cursor in the checkpoint, and resumes there", async () => {
    smileCustomer.reset();
    const customers = Array.from({ length: 520 }, (_, i) => smileCustomer.one({ updated_at: before(1 + i / 100) }));
    const mock = smileDocMock(program({ customers, pointsTransactions: [] }));
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([250, 250, 20, 0]);
    const cursors = batches.map((b) => parseSmileCursor(b.cursor as string)!);
    expect(cursors.map((c) => c.pass?.list ?? null)).toEqual(["customers", "customers", "points_transactions", null]);
    // Newest id first: the first page holds the oldest changes.
    expect(cursors[0]!.pass).toEqual({ list: "customers", since: FIVE_YEARS, top: before(1 + 270 / 100), cursor: expect.any(String) });
    expect(cursors[2]).toEqual({ done: false, marks: { customers: before(1), points_transactions: null }, pass: { list: "points_transactions", since: FIVE_YEARS, top: null, cursor: null } });
    expect(cursors[3]!.done).toBe(true);
    const resumed = smileDocMock(program({ customers, pointsTransactions: [] }));
    const rest = await drain(connector(resumed).historicalImport({ cursor: batches[0]!.cursor } as never));
    expect(rest.map((b) => b.events.length)).toEqual([250, 20, 0]);
    expect(resumed.reads[0]!.query.cursor).toBe(cursors[0]!.pass!.cursor);
  });

  it("reads only what changed since the newest change the last sync saw, less five minutes", async () => {
    const mock = smileDocMock(program());
    const state = { done: true, marks: { customers: before(2), points_transactions: before(40) }, pass: null };
    const batches = await drain(connector(mock).incrementalSync({ cursor: JSON.stringify(state) } as never));
    const less = (iso: string) => new Date(Date.parse(iso) - SMILE_OVERLAP_MS).toISOString();
    expect(mock.reads.map((r) => r.query.updated_at_min)).toEqual([less(before(2)), less(before(40))]);
    expect(eventsOf(batches).map((e) => e.type)).toEqual([SMILE_CUSTOMER_EVENT, SMILE_POINTS_EVENT, SMILE_POINTS_EVENT]);
    expect(parseSmileCursor(batches.at(-1)!.cursor as string)).toEqual({ done: true, marks: { customers: before(1), points_transactions: before(1) }, pass: null });
    expect(SMILE_OVERLAP_MS).toBe(300_000);
  });

  it("looks back two days on a first sync with no checkpoint, and doesn't call the import done", async () => {
    const mock = smileDocMock(program());
    const batches = await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(eventsOf(batches)).toHaveLength(4);
    expect(mock.reads.map((r) => r.query.updated_at_min)).toEqual([before(48), before(48)]);
    expect(SMILE_FIRST_LOOKBACK_MS).toBe(48 * HOUR_MS);
    expect(batches.map((b) => parseSmileCursor(b.cursor as string)!.done)).toEqual([false, false]);
  });

  it("keeps a finished import finished on every page of a later sync", async () => {
    const fake: SmileClient = { vipTiers: async () => [], page: async (_list, _since, cursor) => ({ rows: [], next: cursor ? null : "abc=" }) };
    const state = { done: true, marks: { customers: before(2), points_transactions: before(2) }, pass: null };
    const batches = await drain(connector(smileDocMock(program()), { client: fake }).incrementalSync({ cursor: JSON.stringify(state) } as never));
    expect(batches.map((b) => parseSmileCursor(b.cursor as string)!.done)).toEqual([true, true, true, true]);
  });

  it("marks each list's newest change, whatever order the rows come in, and ignores times that don't read", async () => {
    const asked: unknown[] = [];
    const rows = { customers: [{ updated_at: before(5) }, { updated_at: before(2) }, { updated_at: "x" }, null, { updated_at: before(3) }], points_transactions: [] as unknown[] };
    const fake: SmileClient = { vipTiers: async () => [], page: async (list, since, cursor) => (asked.push([list, since, cursor]), { rows: rows[list], next: null }) };
    const batches = await drain(connector(smileDocMock(program()), { client: fake }).incrementalSync({ cursor: null } as never));
    expect(parseSmileCursor(batches.at(-1)!.cursor as string)!.marks).toEqual({ customers: before(2), points_transactions: null });
    expect(eventsOf(batches).every((e) => e.receivedAt === RECEIVED)).toBe(true);
    // A list that saw nothing keeps its mark.
    const kept = await drain(connector(smileDocMock(program()), { client: fake }).incrementalSync({ cursor: JSON.stringify({ done: true, marks: { customers: null, points_transactions: before(9) }, pass: null }) } as never));
    expect(parseSmileCursor(kept.at(-1)!.cursor as string)!.marks.points_transactions).toBe(before(9));
  });

  it("resumes a later sync part way and keeps saying the import is done", async () => {
    const asked: unknown[] = [];
    const fake: SmileClient = { vipTiers: async () => [], page: async (list, since, cursor) => (asked.push([list, since, cursor]), { rows: [], next: null }) };
    const state = { done: true, marks: { customers: before(1), points_transactions: null }, pass: { list: "points_transactions", since: before(10), top: before(9), cursor: "abc" } };
    const batches = await drain(connector(smileDocMock(program()), { client: fake }).incrementalSync({ cursor: JSON.stringify(state) } as never));
    expect(asked).toEqual([["points_transactions", before(10), "abc"]]);
    expect(parseSmileCursor(batches[0]!.cursor as string)).toEqual({ done: true, marks: { customers: before(1), points_transactions: before(9) }, pass: null });
  });

  it("dead-letters what it can't read and carries on", async () => {
    const data = program();
    data.customers!.push({ id: "bad", updated_at: before(2) });
    data.pointsTransactions!.push({ id: 0, updated_at: before(2) });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(smileDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 6, deadLettered: 2 });
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = smileDocMock(program({ rateLimits: 2, retryAfter: "1" }));
    const slept: number[] = [];
    const batches = await drain(connector(mock, { sleep: async (ms) => void slept.push(ms) }).historicalImport({ cursor: null } as never));
    expect(eventsOf(batches)).toHaveLength(6);
    expect(slept).toEqual([1000, 1000]);
  });

  it("stops on a key that's turned down or missing a scope", async () => {
    await expect(drain(connector(smileDocMock(program({ apiKey: `api_${"9".repeat(20)}` }))).historicalImport({ cursor: null } as never))).rejects.toThrow("Smile turned down SMILE_API_KEY");
    const noTiers = smileDocMock(program({ scopes: ["customer:read", "points_transaction:read"] }));
    await expect(drain(connector(noTiers).historicalImport({ cursor: null } as never))).rejects.toThrow("make a key with vip_tier:read");
    expect(noTiers.reads).toHaveLength(0);
  });

  it("checks its settings", () => {
    const mock = smileDocMock(program());
    expect(() => connector(mock, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY");
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { apiKey: "nope" })).toThrow(SmileConfigError);
    expect(() => connector(mock, { apiKey: "nope", client: { vipTiers: async () => [], page: async () => ({ rows: [], next: null }) } })).not.toThrow();
  });

  it("reads back as far as told, and up to now when no clock is given", async () => {
    const asked: unknown[] = [];
    const fake: SmileClient = { vipTiers: async () => [], page: async (list, since) => (asked.push(since), { rows: [], next: null }) };
    await drain(connector(smileDocMock(program()), { client: fake, historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(asked[0]).toBe("2025-11-11T15:00:00.000Z");
    asked.length = 0;
    await drain(smileConnector({ apiKey: API_KEY, customerKey: CUSTOMER_KEY, client: fake }).incrementalSync({ cursor: null } as never));
    expect(Math.abs(Date.parse(asked[0] as string) - (Date.now() - SMILE_FIRST_LOOKBACK_MS))).toBeLessThan(5000);
  });

  it("declares its write and turns it down while writes are off", async () => {
    expect(SMILE_WRITES).toEqual([{ integration: "smile_io", name: "adjust_points", description: "Add or take away a customer's Smile.io points", kind: "update", approval: "each", dailyCap: 10 }]);
    const c = connector(smileDocMock(program()));
    expect(c.writes).toBe(SMILE_WRITES);
    expect(c.source).toBe("smile_io");
    expect(await assertWritesRefused(c)).toMatchObject([{ action: "adjust_points", integration: "smile_io", outcome: "refused" }]);
  });
});

describe("Smile.io doc mock", () => {
  const get = (mock: SmileMock, path: string, key = API_KEY) => mock.fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${key}` } });

  it("wants the key, the list's scope, and checks the parameters, page size and cursor", async () => {
    const mock = smileDocMock(program());
    expect((await get(mock, "/customers", "nope")).status).toBe(401);
    expect((await mock.fetch(`${BASE}/customers`)).status).toBe(401);
    expect((await get(mock, "/customers?since=1")).status).toBe(400);
    expect((await get(mock, "/customers?limit=251")).status).toBe(400);
    expect((await get(mock, "/customers?limit=0")).status).toBe(400);
    expect((await get(mock, "/customers?updated_at_min=yesterday")).status).toBe(400);
    expect((await get(mock, "/customers?include=perks")).status).toBe(400);
    expect((await get(mock, "/customers?cursor=!!")).status).toBe(400);
    expect((await get(mock, "/points_transactions?include=vip_status")).status).toBe(400);
    const first = (await (await get(mock, "/customers?limit=2")).json()) as { customers: Record<string, unknown>[]; metadata: { previous_cursor: string | null; next_cursor: string } };
    // Newest id first, and no VIP status unless asked for.
    expect(first.customers.map((c) => c.id)).toEqual([704, 703]);
    expect(first.customers[0]).not.toHaveProperty("vip_status");
    expect(first.metadata.previous_cursor).toBeNull();
    const second = (await (await get(mock, `/customers?limit=2&include=vip_status&cursor=${first.metadata.next_cursor}`)).json()) as typeof first;
    expect(second.customers.map((c) => c.id)).toEqual([702, 701]);
    expect(second.customers[0]).toHaveProperty("vip_status");
    expect(second.metadata).toEqual({ previous_cursor: Buffer.from("offset:0").toString("base64url"), next_cursor: null });
    const recent = (await (await get(mock, `/points_transactions?updated_at_min=${encodeURIComponent(before(30))}`)).json()) as { points_transactions: unknown[] };
    expect(recent.points_transactions).toHaveLength(2);
    expect(((await (await get(mock, "/points_transactions?customer_id=701")).json()) as { points_transactions: unknown[] }).points_transactions).toHaveLength(4);
    expect(((await (await get(mock, "/vip_tiers")).json()) as { vip_tiers: unknown[] }).vip_tiers).toEqual(SMILE_TEST_TIERS);
    expect(mock.reads.at(-1)).toEqual({ kind: "points_transactions", query: { customer_id: "701" } });
  });

  it("turns down a key without the scope, takes a write scope as read, and answers 429 with or without Retry-After", async () => {
    const reader = smileDocMock(program({ scopes: ["customer:write"] }));
    expect((await get(reader, "/customers")).status).toBe(200);
    expect((await get(reader, "/points_transactions")).status).toBe(403);
    expect((await get(reader, "/vip_tiers")).status).toBe(403);
    const { customers: _c, pointsTransactions: _p, ...bare } = program();
    const empty = smileDocMock(bare);
    expect(((await (await get(empty, "/customers")).json()) as { customers: unknown[] }).customers).toEqual([]);
    expect(((await (await get(empty, "/points_transactions")).json()) as { points_transactions: unknown[] }).points_transactions).toEqual([]);
    for (const retryAfter of [undefined, "2"]) {
      const mock = smileDocMock(program({ rateLimits: 1, ...(retryAfter === undefined ? {} : { retryAfter }) }));
      const r = await get(mock, "/vip_tiers");
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBe(retryAfter ?? null);
    }
    expect(SMILE_DOC_PAGES.auth).toMatch(/^https:\/\/dev\.smile\.io\//);
  });
});
