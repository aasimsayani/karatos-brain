import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertWritesRefused, checkConnectorSync, katanaDocMock, katanaInventory, katanaManufacturingOrder, testPipeline, type KatanaMock, type KatanaMockData } from "@karatos/connector-testkit";
import {
  KATANA_API_URL,
  KATANA_COUNT_EVENT,
  KATANA_JOB_EVENT,
  KATANA_OVERLAP_MS,
  KATANA_PAGE_SIZE,
  KATANA_WRITES,
  KatanaApiError,
  KatanaConfigError,
  katanaCents,
  katanaClient,
  katanaConnector,
  katanaCountEvent,
  katanaId,
  katanaNumber,
  katanaOrderEvent,
  katanaRef,
  katanaTime,
  katanaTotalPages,
  parseKatanaCursor,
  type KatanaClient,
  type KatanaEvent,
  type KatanaOptions,
} from "../src/index.js";

// A credential-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["katana", "test", "0".repeat(24)].join("-");
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const DAY_MS = 86_400_000;
const API = "https://api.katanamrp.com/v1";
const noSleep = async () => {};
const ctx = { receivedAt: RECEIVED };

/** An ISO time `ago` days before NOW. */
const ago = (days: number) => new Date(NOW().getTime() - days * DAY_MS).toISOString();

/** Orders created 1, 30, 1,000 and 1,820 days ago, and six years ago, and stock of three materials. */
function account(overrides: Partial<KatanaMockData> = {}): KatanaMockData {
  katanaManufacturingOrder.reset();
  katanaInventory.reset();
  return {
    apiKey: KEY,
    manufacturingOrders: [1, 30, 1000, 1820, 2200].map((d) => katanaManufacturingOrder.one({ created_at: ago(d), updated_at: ago(d), order_created_date: ago(d) })),
    inventory: katanaInventory.many(3),
    ...overrides,
  };
}

const connector = (mock: KatanaMock, overrides: Partial<KatanaOptions> = {}) => katanaConnector({ apiKey: KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as KatanaEvent[];

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
const pages = (total: unknown) => ({ "x-pagination": JSON.stringify({ total_records: "9", total_pages: total, page: "1" }) });
const OK = json(200, { data: [] }, pages("1"));
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof katanaClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = katanaClient({ apiKey: KEY, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const SINCE = "2026-11-10T14:00:00.000Z";

describe("Katana client", () => {
  it("checks its key before sending anything", () => {
    const { fetch, sent } = scripted(OK);
    const make = (apiKey: unknown) => () => katanaClient({ apiKey: apiKey as string, fetch });
    for (const apiKey of ["", "a".repeat(19), "a".repeat(201), `${KEY}!`, `${KEY} x`, `${KEY}/`, undefined]) expect(make(apiKey), String(apiKey)).toThrow("KATANA_API_KEY is missing or not in the expected shape");
    expect(make("")).toThrow(KatanaConfigError);
    for (const ok of ["a".repeat(20), "a".repeat(200), ` ${KEY} `, "A-b_9.".repeat(4)]) expect(make(ok)).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("sends only GET requests to the two lists, with the key as a bearer token", async () => {
    const row = { id: 1 };
    const { fetch, sent } = scripted(json(200, { data: [row] }, pages("3")));
    const { c } = client(fetch, { apiKey: ` ${KEY} ` });
    expect(await c.manufacturingOrders({ field: "created_at_min", since: SINCE }, 1)).toEqual({ rows: [row], more: true });
    expect(await c.manufacturingOrders({ field: "updated_at_min", since: SINCE }, 2)).toEqual({ rows: [row], more: true });
    expect(await c.inventory(3)).toEqual({ rows: [row], more: false });
    const headers = { authorization: `Bearer ${KEY}`, accept: "application/json" };
    expect(sent).toEqual([
      { url: `${API}/manufacturing_orders?include_deleted=true&created_at_min=2026-11-10T14%3A00%3A00.000Z&limit=250&page=1`, method: "GET", headers, body: undefined },
      { url: `${API}/manufacturing_orders?include_deleted=true&updated_at_min=2026-11-10T14%3A00%3A00.000Z&limit=250&page=2`, method: "GET", headers, body: undefined },
      { url: `${API}/inventory?extend=variant&limit=250&page=3`, method: "GET", headers, body: undefined },
    ]);
    expect([KATANA_API_URL, KATANA_PAGE_SIZE]).toEqual([API, 250]);
  });

  it("checks the time and the page before sending", async () => {
    const { fetch, sent } = scripted(OK);
    const { c } = client(fetch);
    for (const since of ["2026-11-10", `x${SINCE}`, `${SINCE}x`, "2026-11-10T14:00:00Z", "2026-11-10T14:00:00.000+00:00"]) {
      await expect(c.manufacturingOrders({ field: "created_at_min", since }, 1), since).rejects.toThrow("manufacturing orders are listed from an ISO UTC time");
      await expect(c.manufacturingOrders({ field: "updated_at_min", since }, 1), since).rejects.toBeInstanceOf(KatanaApiError);
    }
    await expect(c.manufacturingOrders({ field: "status" as never, since: SINCE }, 1)).rejects.toThrow("manufacturing orders are listed by created_at_min or updated_at_min");
    for (const page of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      await expect(c.inventory(page), String(page)).rejects.toThrow("a page must be a whole number from 1");
      await expect(c.manufacturingOrders({ field: "created_at_min", since: SINCE }, page), String(page)).rejects.toThrow("a page must be a whole number from 1");
    }
    expect(sent).toHaveLength(0);
  });

  it("says whether another page follows, from the header or, without it, a full page", async () => {
    const more = async (headers: Record<string, string>, rows: number, page = 1) => (await client(scripted(json(200, { data: Array.from({ length: rows }, (_, i) => ({ id: i })) }, headers)).fetch).c.inventory(page)).more;
    expect(await more(pages("2"), 1)).toBe(true);
    expect(await more(pages("2"), 1, 2)).toBe(false);
    expect(await more(pages(2), 1, 1)).toBe(true);
    expect(await more(pages("0"), 250)).toBe(false);
    expect(await more({}, 249)).toBe(false);
    expect(await more({}, 250)).toBe(true);
    expect(await more({ "x-pagination": "nope" }, 250)).toBe(true);
    expect(await more(pages("x"), 1)).toBe(false);
  });

  it("reads the pagination header", () => {
    expect(katanaTotalPages(JSON.stringify({ total_pages: "4" }))).toBe(4);
    expect(katanaTotalPages(JSON.stringify({ total_pages: 0 }))).toBe(0);
    for (const h of [null, "", "{", "null", "5", JSON.stringify({}), JSON.stringify({ total_pages: "-1" }), JSON.stringify({ total_pages: "1.5" }), JSON.stringify({ total_pages: "" }), JSON.stringify({ total_pages: " 1" }), JSON.stringify({ total_pages: "1234567890" }), JSON.stringify({ total_pages: null }), JSON.stringify({ total_pages: -1 }), JSON.stringify({ total_pages: 1.5 })]) {
      expect(katanaTotalPages(h), String(h)).toBeUndefined();
    }
  });

  it("says when Katana turns down the key, never repeating Katana's words", async () => {
    for (const status of [401, 403]) {
      const turned = scripted(json(status, { message: `bad ${KEY}` }), OK);
      const e = await client(turned.fetch).c.inventory(1).catch((err: Error) => err);
      // Never retried.
      expect(turned.sent).toHaveLength(1);
      expect(e).toBeInstanceOf(KatanaConfigError);
      expect((e as Error).message).toBe(`Katana turned down KATANA_API_KEY (HTTP ${status})`);
    }
    for (const status of [400, 404, 422, 501]) {
      await expect(client(scripted(json(status, {})).fetch).c.inventory(1)).rejects.toMatchObject({ name: "KatanaApiError", status, message: `Katana answered HTTP ${status} for inventory` });
      await expect(client(scripted(json(status, {})).fetch).c.manufacturingOrders({ field: "created_at_min", since: SINCE }, 1)).rejects.toMatchObject({ status, message: `Katana answered HTTP ${status} for manufacturing orders` });
    }
    for (const answer of [json(200, {}), json(200, { data: "a,b" }), json(200, null), json(200, []), text(200, "<html>")]) {
      await expect(client(scripted(answer).fetch).c.inventory(1)).rejects.toThrow("Katana answered without its inventory");
      await expect(client(scripted(answer).fetch).c.manufacturingOrders({ field: "created_at_min", since: SINCE }, 1)).rejects.toThrow("Katana answered without its manufacturing orders");
    }
  });

  it("waits out rate limits and server errors, honoring Retry-After up to a minute, then gives up", async () => {
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "5" }), json(500, {}), json(502, {}, { "retry-after": "600" }), json(503, {}), OK);
    const { c, slept } = client(fetch, { retries: 4 });
    expect(await c.inventory(1)).toEqual({ rows: [], more: false });
    expect(slept).toEqual([5000, 2000, 60_000, 8000]);
    expect(sent).toHaveLength(5);
    expect(sent.every((s) => s.url === sent[0]!.url)).toBe(true);
    const gave = client(scripted(json(504, {})).fetch);
    await expect(gave.c.inventory(1)).rejects.toMatchObject({ status: 504 });
    expect(gave.slept).toEqual([1000, 2000, 4000]);
    const zero = client(scripted(json(429, {}, { "retry-after": "0" }), OK).fetch);
    await zero.c.inventory(1);
    expect(zero.slept).toEqual([1000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const once = scripted(json(400, {}));
    await expect(client(once.fetch).c.inventory(1)).rejects.toMatchObject({ status: 400 });
    expect(once.sent).toHaveLength(1);
    const none = scripted(json(500, {}), OK);
    await expect(client(none.fetch, { retries: 0 }).c.inventory(1)).rejects.toMatchObject({ status: 500 });
    expect(none.sent).toHaveLength(1);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(json(503, {}, { "retry-after": "0.001" }), OK);
    globalThis.fetch = fetch;
    try {
      expect(await katanaClient({ apiKey: KEY }).inventory(1)).toEqual({ rows: [], more: false });
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(2);
  });
});

describe("Katana reading helpers", () => {
  it("reads IDs", () => {
    for (const [v, id] of [[1, "1"], [21_400, "21400"], ["42", "42"], [2 ** 53 - 1, String(2 ** 53 - 1)]] as const) expect(katanaId(v)).toBe(id);
    for (const v of [0, -1, 1.5, "0", "-1", "1.5", "", " 1", "1234567890123456", 2 ** 53, null, undefined, {}]) expect(katanaId(v), String(v)).toBeUndefined();
    expect(katanaRef("order", "1")).toBe("katana:order:1");
  });

  it("reads Katana's times as UTC", () => {
    expect(katanaTime("2026-01-01T10:00:00.000Z")).toBe("2026-01-01T10:00:00.000Z");
    expect(katanaTime("2026-01-01T10:00:00+02:00")).toBe("2026-01-01T08:00:00.000Z");
    expect(katanaTime("2026-01-01T10:00:00.123456Z")).toBe("2026-01-01T10:00:00.123Z");
    expect(katanaTime("2024-02-29T23:59:59Z")).toBe("2024-02-29T23:59:59.000Z");
    for (const v of ["", "+012026-01-01T10:00:00Z", "2026-01-01", "2026-01-01T10:00:00", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T23:60:00Z", "x2026-01-01T10:00:00Z", "2026-01-01T10:00:00Zx", "2026-01-01T10:00:00.1234567Z", 5, null]) {
      expect(katanaTime(v), String(v)).toBeUndefined();
    }
  });

  it("reads numbers and decimal strings, and cents", () => {
    for (const [v, n] of [["7.00000", 7], [" 2.5 ", 2.5], ["-1.00000", -1], ["10.0000000000", 10], [3, 3], [0, 0], ["0", 0], [-0.5, -0.5]] as const) expect(katanaNumber(v), String(v)).toBe(n);
    for (const v of ["", "1e3", "1,000", "$5", ".5", "5.", "1.1234567890123", "1234567890123456", 1e15, -1e15, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, true]) expect(katanaNumber(v), String(v)).toBeNull();
    expect(katanaNumber(999_999_999_999_999)).toBe(999_999_999_999_999);
    for (const [v, c] of [[412.5, 41_250], ["10.0000000000", 1000], [0.005, 1], [-0.005, -1], ["0.29", 29], [19.99, 1999], [-35.1, -3510]] as const) expect(katanaCents(v), String(v)).toBe(c);
    expect(katanaCents("x")).toBeNull();
  });
});

describe("Katana events", () => {
  const order = (overrides: Record<string, unknown> = {}) => {
    katanaManufacturingOrder.reset();
    return katanaOrderEvent(katanaManufacturingOrder.one(overrides), ctx);
  };
  const count = (overrides: Record<string, unknown> = {}) => {
    katanaInventory.reset();
    return katanaCountEvent(katanaInventory.one(overrides), ctx);
  };

  it("keeps what production uses from a manufacturing order, and no notes, serial numbers or custom fields", () => {
    const e = order();
    expect(e).toEqual({
      id: e.idempotencyKey.replace(/:/g, "_"),
      type: KATANA_JOB_EVENT,
      occurredAt: "2026-01-01T01:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^katana:order:21401:[0-9a-f]{12}$/),
      payload: {
        system: "Katana",
        jobId: "katana:order:21401",
        status: "in_progress",
        statusLabel: "IN_PROGRESS",
        deleted: false,
        orderNumber: "MO-1",
        variantRef: "katana:variant:101",
        locationRef: "katana:location:1",
        salesOrderRef: "katana:sales_order:9001",
        plannedQuantity: 2,
        producedQuantity: null,
        materials: "in_stock",
        createdOn: "2026-01-01",
        dueOn: "2026-01-11",
        deliveryDueOn: "2026-01-15",
        completedOn: null,
        totalCostCents: 41_250,
        materialCostCents: 0,
        subassembliesCostCents: 0,
        operationsCostCents: 0,
        plannedSeconds: 7200,
        actualSeconds: 3600,
      },
    });
    expect(KATANA_JOB_EVENT).toBe("manufacturing.job_updated");
    const shown = JSON.stringify(e);
    for (const hidden of ["Engrave", "Ring size", "SN1", "19001"]) expect(shown, hidden).not.toContain(hidden);
  });

  it("reads each status, and a deleted order as cancelled at its deletion", () => {
    for (const [label, status] of [["NOT_STARTED", "open"], ["BLOCKED", "on_hold"], ["IN_PROGRESS", "in_progress"], ["DONE", "completed"]] as const) {
      expect(order({ status: label }).payload).toMatchObject({ status, statusLabel: label });
    }
    for (const label of ["done", "CANCELLED", "", 5, "toString", undefined]) expect(order({ status: label }).payload, String(label)).toMatchObject({ status: "other", statusLabel: null });
    const deleted = order({ deleted_at: "2026-03-01T00:00:00Z", status: "DONE" });
    expect(deleted.occurredAt).toBe("2026-03-01T00:00:00.000Z");
    expect(deleted.payload).toMatchObject({ status: "cancelled", statusLabel: "DONE", deleted: true, completedOn: null });
    expect(order({ deleted_at: "not a time" }).payload).toMatchObject({ status: "in_progress", deleted: false });
  });

  it("reads the material availability and the optional fields only when they read", () => {
    for (const a of ["PROCESSED", "IN_STOCK", "NOT_AVAILABLE", "EXPECTED", "NO_RECIPE", "NOT_APPLICABLE"]) expect(order({ ingredient_availability: a }).payload.materials).toBe(a.toLowerCase());
    for (const a of ["in_stock", "SHORT", 5, null]) expect(order({ ingredient_availability: a }).payload.materials, String(a)).toBeNull();
    const bare = order({
      order_no: "  ",
      variant_id: "x",
      location_id: 0,
      sales_order_id: null,
      planned_quantity: "lots",
      actual_quantity: "1.50000",
      order_created_date: null,
      production_deadline_date: "soon",
      sales_order_delivery_deadline: undefined,
      done_date: "2026-02-01T12:00:00Z",
      total_cost: "x",
      material_cost: "12.345",
      total_planned_time: null,
    });
    expect(bare.payload).toMatchObject({
      orderNumber: null,
      variantRef: null,
      locationRef: null,
      salesOrderRef: null,
      plannedQuantity: null,
      producedQuantity: 1.5,
      createdOn: "2026-01-01",
      dueOn: null,
      deliveryDueOn: null,
      completedOn: "2026-02-01",
      totalCostCents: null,
      materialCostCents: 1235,
      plannedSeconds: null,
    });
    expect(order({ order_no: ` ${"M".repeat(150)} ` }).payload.orderNumber).toBe("M".repeat(100));
    expect(order({ order_created_date: null, created_at: null }).payload.createdOn).toBeNull();
    expect(order({ order_created_date: "2026-03-01T00:00:00Z", created_at: "2026-04-01T00:00:00Z" }).payload.createdOn).toBe("2026-03-01");
    expect(order({ operations_cost: null }).payload.operationsCostCents).toBeNull();
  });

  it("dates an order by its update, or its creation when it has none", () => {
    expect(order({ updated_at: "2026-05-01T00:00:00Z" }).occurredAt).toBe("2026-05-01T00:00:00.000Z");
    expect(order({ updated_at: null, created_at: "2026-04-01T00:00:00Z" }).occurredAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("keys each version of an order by what was kept", () => {
    const a = order();
    expect(order().idempotencyKey).toBe(a.idempotencyKey);
    expect(order({ status: "DONE" }).idempotencyKey).not.toBe(a.idempotencyKey);
    expect(order({ additional_info: "Other notes", updated_at: "2026-05-01T00:00:00Z" }).idempotencyKey).toBe(a.idempotencyKey);
  });

  it("dead-letters an order that doesn't read, listing why", () => {
    const e = katanaOrderEvent({ id: "x", updated_at: "yesterday" }, ctx);
    expect(e).toMatchObject({
      type: KATANA_JOB_EVENT,
      occurredAt: undefined,
      idempotencyKey: expect.stringMatching(/^katana:unreadable_order:[0-9a-f]{12}$/),
      payload: { system: "Katana", jobId: null, problems: ["manufacturing order has no ID that reads", "manufacturing order has no update time that reads"] },
    });
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    expect(order({ updated_at: null, created_at: null }).payload).toEqual({ system: "Katana", jobId: "21401", problems: ["manufacturing order has no update time that reads"] });
    for (const raw of [null, "x", [1]]) expect(katanaOrderEvent(raw, ctx).payload.problems).toHaveLength(2);
  });

  it("counts an item's stock at a location", () => {
    const e = count();
    expect(e).toEqual({
      id: e.idempotencyKey.replace(/:/g, "_"),
      type: KATANA_COUNT_EVENT,
      occurredAt: RECEIVED,
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^katana:count:501:1:2026-11-11:[0-9a-f]{12}$/),
      payload: {
        system: "Katana",
        sku: "GR-14K-1",
        name: "14K yellow casting grain",
        kind: "material",
        onHand: 7,
        committed: 2,
        expected: 0,
        missingOrExcess: -1,
        reorderPoint: 5,
        averageCostCents: 1000,
        valueCents: 7000,
        variantId: "katana:variant:501",
        locationId: "katana:location:1",
      },
    });
    expect(KATANA_COUNT_EVENT).toBe("inventory.counted");
    expect(count().idempotencyKey).toBe(e.idempotencyKey);
    expect(count({ quantity_in_stock: "6.00000" }).idempotencyKey).not.toBe(e.idempotencyKey);
    expect(katanaCountEvent(katanaInventory.one({ variant_id: 501 }), { receivedAt: "2026-11-12T01:00:00.000Z" }).idempotencyKey).toContain(":2026-11-12:");
  });

  it("counts an item without its variant by its ID", () => {
    const e = count({ variant: null, quantity_committed: null });
    expect(e.payload).toMatchObject({ sku: "katana-variant-501", name: null, kind: null, committed: null });
    expect(count({ variant: { sku: "  ", type: "service", product_or_material_name: 5 } }).payload).toMatchObject({ sku: "katana-variant-501", kind: null, name: null });
    expect(count({ variant: { sku: " RING-1 ", type: "product" } }).payload).toMatchObject({ sku: "RING-1", kind: "product" });
    expect(count({ variant: { type: "products" } }).payload.kind).toBeNull();
    expect(count({ variant: { type: "byproduct" } }).payload.kind).toBeNull();
    expect(count({ variant: { sku: "S".repeat(150) } }).payload).toMatchObject({ sku: "S".repeat(100), name: null });
  });

  it("dead-letters a count that doesn't read, listing why", () => {
    const e = katanaCountEvent({ variant_id: "x", location_id: null, quantity_in_stock: "lots" }, ctx);
    expect(e).toMatchObject({
      occurredAt: undefined,
      idempotencyKey: expect.stringMatching(/^katana:unreadable_count:[0-9a-f]{12}$/),
      payload: { system: "Katana", problems: ["inventory row has no item ID that reads", "inventory row has no location ID that reads", "inventory row has no quantity in stock that reads"] },
    });
    expect(count({ location_id: null }).payload.problems).toEqual(["inventory row has no location ID that reads"]);
    expect(count({ quantity_in_stock: null }).payload.problems).toEqual(["inventory row has no quantity in stock that reads"]);
  });
});

describe("Katana checkpoint", () => {
  it("reads a checkpoint it wrote, and turns down anything else", () => {
    const pass = { stage: "orders", page: 2, since: SINCE };
    expect(parseKatanaCursor(null)).toBeNull();
    expect(parseKatanaCursor(JSON.stringify({ pass: null, done: true, nextFrom: SINCE }))).toEqual({ pass: null, done: true, nextFrom: SINCE });
    expect(parseKatanaCursor(JSON.stringify({ pass, done: false, nextFrom: SINCE }))).toEqual({ pass, done: false, nextFrom: SINCE });
    expect(parseKatanaCursor(JSON.stringify({ pass: { ...pass, stage: "stock", extra: 1 }, done: false, nextFrom: SINCE }))).toEqual({ pass: { ...pass, stage: "stock" }, done: false, nextFrom: SINCE });
    for (const raw of [
      "",
      "{",
      "null",
      "[]",
      JSON.stringify({ pass: null, done: "true", nextFrom: SINCE }),
      JSON.stringify({ pass: null, nextFrom: SINCE }),
      JSON.stringify({ pass: null, done: true, nextFrom: "2026-11-10" }),
      JSON.stringify({ pass: null, done: true, nextFrom: "2026-11-10T14:00:00Z" }),
      JSON.stringify({ pass: null, done: true, nextFrom: "2026-02-30T14:00:00.000Z" }),
      JSON.stringify({ pass: null, done: true, nextFrom: `x${SINCE}` }),
      JSON.stringify({ done: true, nextFrom: SINCE }),
      JSON.stringify({ pass: "orders", done: true, nextFrom: SINCE }),
      JSON.stringify({ pass: { ...pass, stage: "materials" }, done: true, nextFrom: SINCE }),
      JSON.stringify({ pass: { ...pass, page: 0 }, done: true, nextFrom: SINCE }),
      JSON.stringify({ pass: { ...pass, page: 1.5 }, done: true, nextFrom: SINCE }),
      JSON.stringify({ pass: { ...pass, page: "2" }, done: true, nextFrom: SINCE }),
      JSON.stringify({ pass: { ...pass, since: "2026-11-10" }, done: true, nextFrom: SINCE }),
    ]) {
      expect(() => parseKatanaCursor(raw), raw).toThrow("Katana checkpoint is not in the expected shape");
    }
  });
});

describe("Katana connector", () => {
  it("passes the shared connector checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(katanaDocMock(account())), expected: { ingested: 7 } });
    expect(result.full.ingested).toBe(7);
  });

  it("imports five years of orders and the stock, then stops for good", async () => {
    const mock = katanaDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(7);
    expect(mock.reads).toEqual([
      { path: "/manufacturing_orders", query: { include_deleted: "true", created_at_min: "2021-11-11T15:00:00.000Z", limit: "250", page: "1" } },
      { path: "/inventory", query: { extend: "variant", limit: "250", page: "1" } },
    ]);
    expect(parseKatanaCursor(report.cursor)).toEqual({ pass: null, done: true, nextFrom: "2026-11-11T14:00:00.000Z" });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested + again.duplicates).toBe(0);
    expect(mock.reads).toHaveLength(2);
  });

  it("pages through orders and then stock, keeping the stage and page in the checkpoint, and resumes there", async () => {
    katanaManufacturingOrder.reset();
    katanaInventory.reset();
    const data: KatanaMockData = {
      apiKey: KEY,
      manufacturingOrders: katanaManufacturingOrder.many(KATANA_PAGE_SIZE + 5, (n) => ({ created_at: ago(n / 100), updated_at: ago(n / 100) })),
      inventory: katanaInventory.many(KATANA_PAGE_SIZE + 1),
    };
    const batches = await drain(connector(katanaDocMock(data)).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([250, 5, 250, 1]);
    const cursors = batches.map((b) => parseKatanaCursor(b.cursor ?? null)!);
    expect(cursors.map((c) => (c.pass ? `${c.pass.stage}:${c.pass.page}` : "end"))).toEqual(["orders:2", "stock:1", "stock:2", "end"]);
    expect(cursors.map((c) => c.done)).toEqual([false, false, false, true]);
    const resumed = katanaDocMock(data);
    // Resumed a day later, the pass keeps where the next later sync starts.
    const rest = await drain(connector(resumed, { now: () => new Date(NOW().getTime() + DAY_MS) }).historicalImport({ cursor: batches[0]!.cursor ?? null } as never));
    expect(eventsOf(rest)).toHaveLength(256);
    expect(parseKatanaCursor(rest.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: cursors[0]!.nextFrom });
    expect(resumed.reads.map((r) => `${r.path}:${r.query.page}:${r.query.created_at_min}`)).toEqual([
      `/manufacturing_orders:2:${cursors[0]!.pass!.since}`,
      "/inventory:1:undefined",
      "/inventory:2:undefined",
    ]);
    const later = katanaDocMock(data);
    const mid = JSON.stringify({ pass: { stage: "orders", page: 2, since: SINCE }, done: true, nextFrom: SINCE });
    const out = await drain(connector(later).incrementalSync({ cursor: mid } as never));
    expect(parseKatanaCursor(out[0]!.cursor ?? null)).toMatchObject({ pass: { stage: "stock", page: 1 }, done: true });
    expect(later.reads[0]!.query).toMatchObject({ updated_at_min: SINCE, page: "2" });
    expect(parseKatanaCursor(out.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: SINCE });
    const midImport = JSON.stringify({ pass: { stage: "stock", page: 1, since: SINCE }, done: false, nextFrom: SINCE });
    const ended = await drain(connector(katanaDocMock(data)).incrementalSync({ cursor: midImport } as never));
    expect(parseKatanaCursor(ended.at(-1)!.cursor ?? null)!.done).toBe(false);
  });

  it("reads orders changed since an hour before the last pass, and the stock again, on each later sync", async () => {
    const data = account();
    const mock = katanaDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // Each mode keeps its own checkpoint, so the first later sync looks back an hour.
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.slice(2)).toEqual([
      { path: "/manufacturing_orders", query: { include_deleted: "true", updated_at_min: "2026-11-11T14:00:00.000Z", limit: "250", page: "1" } },
      { path: "/inventory", query: { extend: "variant", limit: "250", page: "1" } },
    ]);
    expect(first.ingested).toBe(0);
    expect(first.duplicates).toBe(3);
    expect(KATANA_OVERLAP_MS).toBe(3_600_000);
    // An order is finished and another deleted.
    const later = () => new Date(NOW().getTime() + DAY_MS);
    Object.assign(data.manufacturingOrders[1]!, { status: "DONE", done_date: ago(-0.5), updated_at: ago(-0.5) });
    Object.assign(data.manufacturingOrders[2]!, { deleted_at: ago(-0.5), updated_at: ago(-0.5) });
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.at(-2)!.query.updated_at_min).toBe("2026-11-11T14:00:00.000Z");
    // Two changed orders, and the stock counted on a new day.
    expect(sync.ingested).toBe(5);
    expect(parseKatanaCursor(sync.cursor)).toEqual({ pass: null, done: false, nextFrom: "2026-11-12T14:00:00.000Z" });
    const done = JSON.stringify({ pass: null, done: true, nextFrom: SINCE });
    const out = await drain(connector(katanaDocMock(data)).incrementalSync({ cursor: done } as never));
    expect(parseKatanaCursor(out.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-11T14:00:00.000Z" });
  });

  it("dead-letters a row that doesn't read and keeps going", async () => {
    const data = account();
    data.manufacturingOrders[0]!.id = "x";
    data.inventory[0]!.quantity_in_stock = "lots";
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(katanaDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(5);
    expect(report.deadLettered).toBe(2);
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = katanaDocMock(account({ rateLimits: 2 }));
    const slept: number[] = [];
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { sleep: async (ms) => void slept.push(ms) }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(7);
    expect(slept).toEqual([1000, 1000]);
  });

  it("says when the key is turned down inside a sync", async () => {
    const mock = katanaDocMock(account({ apiKey: "another-key-0000000000" }));
    await expect(drain(connector(mock).historicalImport({ cursor: null } as never))).rejects.toThrow("Katana turned down KATANA_API_KEY (HTTP 401)");
  });

  it("reads on past an empty page that says more follow, and doesn't import again once done", async () => {
    const asked: string[] = [];
    const fake: KatanaClient = {
      manufacturingOrders: async (_q, page) => (asked.push(`orders:${page}`), page === 1 ? { rows: [], more: true } : { rows: [{}], more: false }),
      inventory: async (page) => (asked.push(`stock:${page}`), { rows: [], more: false }),
    };
    const batches = await drain(katanaConnector({ apiKey: KEY, client: fake, now: NOW }).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([0, 1, 0]);
    expect(asked).toEqual(["orders:1", "orders:2", "stock:1"]);
    const finished = JSON.stringify({ pass: { stage: "stock", page: 1, since: SINCE }, done: true, nextFrom: SINCE });
    expect(await drain(katanaConnector({ apiKey: KEY, client: fake }).historicalImport({ cursor: finished } as never))).toEqual([]);
    expect(asked).toHaveLength(3);
  });

  it("checks its options", () => {
    const mock = katanaDocMock(account());
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears }), String(historyYears)).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { apiKey: "x" })).toThrow("KATANA_API_KEY");
    expect(() => connector(mock, { apiKey: "x", client: {} as KatanaClient })).not.toThrow();
    expect(connector(mock).source).toBe("katana");
  });

  it("reads back as far as told, and up to now when no clock is given", async () => {
    const mock = katanaDocMock(account());
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(mock.reads[0]!.query.created_at_min).toBe("2025-11-11T15:00:00.000Z");
    const queries: unknown[] = [];
    const fake: KatanaClient = { manufacturingOrders: async (q) => (queries.push(q), { rows: [], more: false }), inventory: async () => ({ rows: [], more: false }) };
    const before = Date.now();
    await drain(katanaConnector({ apiKey: KEY, client: fake }).incrementalSync({ cursor: null } as never));
    const after = Date.now();
    const u = Date.parse((queries[0] as { since: string }).since);
    expect(u).toBeGreaterThanOrEqual(before - KATANA_OVERLAP_MS);
    expect(u).toBeLessThanOrEqual(after - KATANA_OVERLAP_MS);
  });

  it("only ever sends GET requests to the two lists", async () => {
    const mock = katanaDocMock(account());
    await drain(connector(mock).historicalImport({ cursor: null } as never));
    await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`))).toEqual(new Set(["GET /v1/manufacturing_orders", "GET /v1/inventory"]));
  });

  it("declares its write and turns it down while writes are off", async () => {
    expect(KATANA_WRITES.map((w) => w.name)).toEqual(["create_manufacturing_order"]);
    const c = connector(katanaDocMock(account()));
    expect(c.writes).toBe(KATANA_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([{ action: "create_manufacturing_order", integration: "katana", outcome: "refused" }]);
  });
});

describe("Katana doc mock", () => {
  it("checks the key, the filters and the paging", async () => {
    const data = account();
    data.manufacturingOrders[4]!.deleted_at = ago(1);
    const mock = katanaDocMock(data);
    const get = (path: string, auth = `Bearer ${KEY}`) => mock.fetch(`${API}${path}`, { headers: { authorization: auth } });
    expect((await get("/inventory", "Bearer nope")).status).toBe(401);
    for (const q of ["?page=0", "?limit=x", "?created_at_min=yesterday", "?updated_at_min=2026-01-01"]) expect((await get(`/manufacturing_orders${q}`)).status, q).toBe(422);
    const first = await get("/manufacturing_orders?limit=2");
    expect(JSON.parse(first.headers.get("x-pagination")!)).toEqual({ total_records: "4", total_pages: "2", offset: "0", page: "1", first_page: "true", last_page: "false" });
    const all = (await (await get("/manufacturing_orders?include_deleted=true&limit=1000")).json()) as { data: Record<string, unknown>[] };
    expect(all.data).toHaveLength(5);
    expect(all.data[0]!.created_at).toBe(ago(1));
    const bare = (await (await get("/inventory")).json()) as { data: Record<string, unknown>[] };
    expect(bare.data[0]).not.toHaveProperty("variant");
    const extended = (await (await get("/inventory?extend=variant,location")).json()) as { data: Record<string, unknown>[] };
    expect(extended.data[0]).toHaveProperty("variant");
  });
});
