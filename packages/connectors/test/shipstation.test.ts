import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import {
  SHIPSTATION_DOC_PAGES,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  shipStationDocMock,
  shipStationLabel,
  shipStationShipment,
  testPipeline,
  type ShipStationMock,
  type ShipStationMockData,
} from "@karatos/connector-testkit";
import {
  SHIPSTATION_API_URL,
  SHIPSTATION_FIRST_LOOKBACK_MS,
  SHIPSTATION_LABEL_DAYS,
  SHIPSTATION_LABEL_EVENT,
  SHIPSTATION_MAX_PAGE,
  SHIPSTATION_OVERLAP_MS,
  SHIPSTATION_PAGE_SIZE,
  SHIPSTATION_SHIPMENT_EVENT,
  SHIPSTATION_WRITES,
  ShipStationApiError,
  ShipStationConfigError,
  parseShipStationCursor,
  shipStationClient,
  shipStationConnector,
  shipStationLabelEvent,
  shipStationMoney,
  shipStationShipmentEvent,
  type ShipStationClient,
  type ShipStationCursor,
  type ShipStationEvent,
  type ShipStationOptions,
} from "../src/index.js";

// A key-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const API_KEY = ["TEST", "0".repeat(28)].join("_");
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const BASE = "https://api.shipstation.com/v2";
const HOUR_MS = 3_600_000;
const TWO_YEARS = "2024-11-11T15:00:00.000Z";
const LABEL_START = "2026-10-12T15:00:00.000Z";
const noSleep = async () => {};

/** `ago` hours before NOW. */
const before = (ago: number) => new Date(NOW().getTime() - ago * HOUR_MS).toISOString();

/** Shipments and labels from 1, 30 and 5,000 hours ago, and three years ago, past the two read. */
function account(overrides: Partial<ShipStationMockData> = {}): ShipStationMockData {
  shipStationShipment.reset();
  shipStationLabel.reset();
  const ages = [1, 30, 5000, 26_300];
  const shipments = ages.map((ago) => shipStationShipment.one({ created_at: before(ago + 1), modified_at: before(ago) }));
  const labels = ages.map((ago) => shipStationLabel.one({ created_at: before(ago) }));
  return { apiKey: API_KEY, shipments, labels, ...overrides };
}

const connector = (mock: ShipStationMock, overrides: Partial<ShipStationOptions> = {}) => shipStationConnector({ apiKey: API_KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as ShipStationEvent[];

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
const PAGE = { shipments: [], total: 0, page: 1, pages: 1, links: {} };
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof shipStationClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = shipStationClient({ apiKey: API_KEY, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const ctx = { receivedAt: RECEIVED };

describe("ShipStation client", () => {
  it("checks its key before sending anything", () => {
    const { fetch, sent } = scripted(json(200, PAGE));
    for (const apiKey of ["", "a".repeat(19), "a".repeat(129), `${"a".repeat(20)} x`, `${"a".repeat(20)}!`, `${"a".repeat(20)}:`]) {
      expect(() => shipStationClient({ apiKey, fetch }), apiKey).toThrow("SHIPSTATION_API_KEY is missing or not in the expected shape");
    }
    expect(() => shipStationClient({ apiKey: ` ${"a".repeat(20)} `, fetch })).not.toThrow();
    expect(() => shipStationClient({ apiKey: `${"aZ9_+/=-".repeat(16)}`, fetch })).not.toThrow();
    expect(() => shipStationClient({} as never)).toThrow(ShipStationConfigError);
    expect(sent).toHaveLength(0);
  });

  it("reads shipments by their last change and labels by when they were made, oldest first, with the key in API-Key", async () => {
    const { fetch, sent } = scripted(json(200, { ...PAGE, shipments: [{ id: 1 }], page: 2, pages: 5 }), json(200, { labels: [], total: 0, page: 1, pages: 0, links: {} }));
    const { c } = client(fetch, { apiKey: ` ${API_KEY} ` });
    expect(await c.page("shipments", before(2), 2)).toEqual({ rows: [{ id: 1 }], pages: 5 });
    expect(await c.page("labels", before(3), 1)).toEqual({ rows: [], pages: 0 });
    const headers = { "API-Key": API_KEY, accept: "application/json" };
    expect(sent).toEqual([
      { url: `${BASE}/shipments?modified_at_start=${encodeURIComponent(before(2))}&sort_by=modified_at&sort_dir=asc&page_size=100&page=2`, method: "GET", headers },
      { url: `${BASE}/labels?created_at_start=${encodeURIComponent(before(3))}&sort_by=created_at&sort_dir=asc&page_size=100&page=1`, method: "GET", headers },
    ]);
    expect(SHIPSTATION_API_URL).toBe("https://api.shipstation.com/v2");
    expect(SHIPSTATION_PAGE_SIZE).toBe(100);
  });

  it("asks only for pages 1 to the most a pass reads, from a time", async () => {
    const { fetch, sent } = scripted(json(200, PAGE));
    const { c } = client(fetch);
    for (const page of [0, -1, 1.5, SHIPSTATION_MAX_PAGE + 1, Number.NaN]) await expect(c.page("shipments", before(1), page)).rejects.toMatchObject({ message: `a shipments page must be 1 to ${SHIPSTATION_MAX_PAGE}`, status: 0 });
    for (const since of ["", "yesterday"]) await expect(c.page("labels", since, 1)).rejects.toMatchObject({ message: "a labels start must be a time", status: 0 });
    expect(sent).toHaveLength(0);
    expect(await c.page("shipments", before(1), 1)).toEqual({ rows: [], pages: 1 });
    expect(SHIPSTATION_MAX_PAGE).toBe(2000);
    const top = client(scripted(json(200, { ...PAGE, page: SHIPSTATION_MAX_PAGE })).fetch).c;
    expect(await top.page("shipments", before(1), SHIPSTATION_MAX_PAGE)).toEqual({ rows: [], pages: 1 });
  });

  it("says when an answer has no list, no page count, or another page", async () => {
    for (const body of [null, [], "x", {}, { shipments: {} }, { shipments: [] }, { shipments: [], pages: 1.5 }, { shipments: [], pages: "1" }, { labels: [], page: 1, pages: 1 }]) {
      const { c } = client(scripted(json(200, body)).fetch);
      await expect(c.page("shipments", before(1), 1), JSON.stringify(body)).rejects.toMatchObject({ message: "ShipStation answered the shipments without the list and its page count", status: 200 });
    }
    const { c: notJson } = client(scripted(text(200, "<html>")).fetch);
    await expect(notJson.page("labels", before(1), 1)).rejects.toThrow("ShipStation answered the labels without the list and its page count");
    for (const page of [2, "1", undefined]) {
      const { c } = client(scripted(json(200, { ...PAGE, page })).fetch);
      await expect(c.page("shipments", before(1), 1)).rejects.toMatchObject({ message: `ShipStation answered page ${String(page)} of the shipments when asked for page 1`, status: 200 });
    }
    const { c: long } = client(scripted(json(200, { ...PAGE, page: "x".repeat(40) })).fetch);
    await expect(long.page("shipments", before(1), 1)).rejects.toThrow(`ShipStation answered page ${"x".repeat(12)} of the shipments`);
  });

  it("explains a turned-down key or plan, and reports other errors", async () => {
    const { c: wrong } = client(scripted(json(401, {})).fetch);
    const err = await wrong.page("shipments", before(1), 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShipStationConfigError);
    expect((err as Error).message).toBe("ShipStation turned down SHIPSTATION_API_KEY: check it, and that the account's plan includes the API");
    expect((err as Error).message).not.toContain(API_KEY);
    const { c: plan } = client(scripted(json(403, {})).fetch);
    await expect(plan.page("labels", before(1), 1)).rejects.toThrow(new ShipStationConfigError("SHIPSTATION_API_KEY can't read labels: check that the account's plan includes it"));
    for (const status of [201, 400, 404, 501]) {
      const { c } = client(scripted(json(status, PAGE)).fetch);
      const e = await c.page("shipments", before(1), 1).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ShipStationApiError);
      expect(e).toMatchObject({ message: `ShipStation answered HTTP ${status} for the shipments`, status, name: "ShipStationApiError" });
    }
    expect(new ShipStationConfigError("x").name).toBe("ShipStationConfigError");
  });

  it("waits out rate limits as Retry-After says, up to a minute, or backs off", async () => {
    const { fetch, sent } = scripted(json(429, {}, { "Retry-After": "7" }), json(429, {}, { "Retry-After": "900" }), json(429, {}, { "Retry-After": "soon" }), json(200, PAGE));
    const { c, slept } = client(fetch);
    expect(await c.page("shipments", before(1), 1)).toEqual({ rows: [], pages: 1 });
    expect(slept).toEqual([7000, 60_000, 4000]);
    expect(sent).toHaveLength(4);
  });

  it("retries 500, 502, 503 and 504 too, backing off 1, 2 and 4 seconds, then gives up", async () => {
    for (const status of [500, 502, 503, 504]) {
      const { fetch, sent } = scripted(json(status, {}));
      const { c, slept } = client(fetch);
      await expect(c.page("shipments", before(1), 1)).rejects.toMatchObject({ status });
      expect(sent).toHaveLength(4);
      expect(slept).toEqual([1000, 2000, 4000]);
    }
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const once = scripted(json(400, {}));
    await expect(client(once.fetch).c.page("shipments", before(1), 1)).rejects.toMatchObject({ status: 400 });
    expect(once.sent).toHaveLength(1);
    const twice = scripted(json(429, {}));
    const { c, slept } = client(twice.fetch, { retries: 1 });
    await expect(c.page("shipments", before(1), 1)).rejects.toMatchObject({ status: 429 });
    expect(twice.sent).toHaveLength(2);
    expect(slept).toEqual([1000]);
    const zero = scripted(json(429, {}, { "Retry-After": "0" }), json(200, PAGE));
    const { c: z, slept: zs } = client(zero.fetch);
    expect(await z.page("shipments", before(1), 1)).toEqual({ rows: [], pages: 1 });
    expect(zs).toEqual([1000]);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(json(429, {}, { "Retry-After": "0.001" }), json(200, PAGE));
    globalThis.fetch = fetch;
    try {
      expect(await shipStationClient({ apiKey: API_KEY }).page("shipments", before(1), 1)).toEqual({ rows: [], pages: 1 });
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(2);
  });

  it("only ever sends GETs to the two lists", async () => {
    const mock = shipStationDocMock(account());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.map((r) => r.list)).toEqual(["shipments", "labels"]);
    expect(mock.api.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /shipments", "GET /labels"]);
  });
});

describe("ShipStation events", () => {
  const shipment = (extra: Record<string, unknown> = {}) => {
    shipStationShipment.reset();
    return shipStationShipment.one({ created_at: before(3), modified_at: before(1), ...extra });
  };
  const label = (extra: Record<string, unknown> = {}) => {
    shipStationLabel.reset();
    return shipStationLabel.one({ created_at: before(2), ...extra });
  };

  it("reads money in whole cents, when it reads", () => {
    expect(shipStationMoney({ currency: "usd", amount: 2400.556 })).toEqual({ cents: 240_056, currency: "USD" });
    expect(shipStationMoney({ currency: " eur ", amount: 0 })).toEqual({ cents: 0, currency: "EUR" });
    expect(shipStationMoney({ currency: "usd", amount: 1e9 })).toEqual({ cents: 1e11, currency: "USD" });
    for (const v of [null, [], {}, { currency: "usd" }, { currency: "usd", amount: -1 }, { currency: "usd", amount: 1e9 + 1 }, { currency: "usd", amount: Number.NaN }, { currency: "usd", amount: "5" }, { currency: "us", amount: 5 }, { currency: "dollars", amount: 5 }, { currency: 5, amount: 5 }]) {
      expect(shipStationMoney(v), JSON.stringify(v)).toBeUndefined();
    }
  });

  it("logs a shipment with its insured value next to what was paid, and no name, address, phone, email or note", () => {
    const { ok, event } = shipStationShipmentEvent(shipment(), ctx);
    expect(ok).toBe(true);
    expect(event.type).toBe("shipment.updated");
    expect(event).toEqual({
      id: event.idempotencyKey.replace(/:/g, "_"),
      type: SHIPSTATION_SHIPMENT_EVENT,
      occurredAt: before(1),
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^shipstation:shipment:se-7001:[0-9a-f]{12}$/),
      payload: {
        system: "ShipStation",
        shipmentId: "shipstation:shipment:se-7001",
        orderRef: "#1001",
        shipmentNumber: "S-1001",
        storeId: "se-55",
        orderSource: "shopify",
        status: "label_purchased",
        carrierId: "se-123",
        service: "ups_next_day_air",
        confirmation: "adult_signature",
        signatureRequired: true,
        insuranceProvider: "shipsurance",
        insuredCents: 240_000,
        paidCents: 250_000,
        currency: "USD",
        underinsuredCents: 10_000,
        packages: 1,
        items: 1,
        skus: ["RING-14K-01"],
        isReturn: false,
        isGift: true,
        destinationState: "NY",
        destinationCountry: "US",
        shipDate: "2026-01-01T01:01:00.000Z",
        createdAt: before(3),
        modifiedAt: before(1),
      },
    });
    const kept = JSON.stringify(event);
    for (const word of ["Customer", "Test Street", "Testville", "10001", "5550100", "example.test", "doorman", "anniversary", "prong", "High value"]) expect(kept, word).not.toContain(word);
  });

  it("counts insurance only when a provider is set, sums packages in one currency, and never goes below zero short", () => {
    const pkg = (amount: number, currency = "usd") => ({ insured_value: { currency, amount } });
    expect(shipStationShipmentEvent(shipment({ insurance_provider: "none" }), ctx).event.payload).toMatchObject({ insuranceProvider: "none", insuredCents: undefined, underinsuredCents: undefined, currency: "USD" });
    expect(shipStationShipmentEvent(shipment({ insurance_provider: undefined }), ctx).event.payload).toMatchObject({ insuranceProvider: undefined, insuredCents: undefined });
    expect(shipStationShipmentEvent(shipment({ packages: [pkg(1500), pkg(1500)] }), ctx).event.payload).toMatchObject({ insuredCents: 300_000, underinsuredCents: 0, packages: 2 });
    expect(shipStationShipmentEvent(shipment({ packages: [pkg(1500), pkg(1500, "eur")] }), ctx).event.payload).toMatchObject({ insuredCents: undefined, underinsuredCents: undefined });
    expect(shipStationShipmentEvent(shipment({ packages: [pkg(1500), {}] }), ctx).event.payload).toMatchObject({ insuredCents: undefined });
    expect(shipStationShipmentEvent(shipment({ packages: [] }), ctx).event.payload).toMatchObject({ insuredCents: undefined, packages: 0 });
    expect(shipStationShipmentEvent(shipment({ packages: "x" }), ctx).event.payload).toMatchObject({ insuredCents: undefined, packages: 0 });
    expect(shipStationShipmentEvent(shipment({ packages: [pkg(100, "eur")] }), ctx).event.payload).toMatchObject({ insuredCents: 10_000, paidCents: 250_000, currency: "EUR", underinsuredCents: undefined });
    expect(shipStationShipmentEvent(shipment({ amount_paid: null }), ctx).event.payload).toMatchObject({ paidCents: undefined, underinsuredCents: undefined, currency: "USD" });
    expect(shipStationShipmentEvent(shipment({ amount_paid: null, insurance_provider: "none" }), ctx).event.payload).toMatchObject({ currency: undefined });
  });

  it("counts items and keeps up to 20 skus, sorted, and leaves out what doesn't read", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ sku: `SKU-${String(i).padStart(2, "0")}`, quantity: 2 }));
    const p = shipStationShipmentEvent(shipment({ items: [...[...items].reverse(), { sku: "SKU-00", quantity: 1 }, { sku: "a b", quantity: 1 }, { sku: "<b>", quantity: 0 }] }), ctx).event.payload;
    expect(p.items).toBe(52);
    expect(p.skus).toEqual(items.slice(0, 20).map((i) => i.sku));
    expect(shipStationShipmentEvent(shipment({ items: [{ quantity: 1 }, { quantity: -1 }] }), ctx).event.payload).toMatchObject({ items: undefined, skus: [] });
    expect(shipStationShipmentEvent(shipment({ items: [{ quantity: 1.5 }] }), ctx).event.payload).toMatchObject({ items: undefined });
    expect(shipStationShipmentEvent(shipment({ items: null }), ctx).event.payload).toMatchObject({ items: 0, skus: [] });
    const odd = shipStationShipmentEvent(
      shipment({ external_order_id: "order 1", shipment_number: "x".repeat(51), store_id: "-x", order_source_code: 5, carrier_id: null, service_code: "a b", confirmation: "none", is_return: "yes", is_gift: "true", ship_to: { state_province: " ny ", country_code: "usa" }, ship_date: "soon", created_at: "x" }),
      ctx,
    ).event.payload;
    expect(odd).toMatchObject({ orderRef: undefined, shipmentNumber: undefined, storeId: undefined, orderSource: undefined, carrierId: undefined, service: undefined, confirmation: "none", signatureRequired: false, isReturn: false, isGift: false, destinationState: "NY", destinationCountry: undefined, shipDate: undefined, createdAt: undefined });
    expect(shipStationShipmentEvent(shipment({ external_order_id: "x".repeat(50), ship_to: { state_province: "Ontario", country_code: "ca" }, confirmation: undefined }), ctx).event.payload).toMatchObject({ orderRef: "x".repeat(50), destinationState: undefined, destinationCountry: "CA", signatureRequired: false });
    expect(shipStationShipmentEvent(shipment({ ship_to: null, confirmation: "direct_signature" }), ctx).event.payload).toMatchObject({ destinationState: undefined, signatureRequired: true });
  });

  it("logs a label as UPS tracking is, with its costs, insured value and whether it was voided", () => {
    const { ok, event } = shipStationLabelEvent(label(), ctx);
    expect(ok).toBe(true);
    expect(event).toEqual({
      id: event.idempotencyKey.replace(/:/g, "_"),
      type: SHIPSTATION_LABEL_EVENT,
      occurredAt: before(2),
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^shipstation:label:se-9001:[0-9a-f]{12}$/),
      payload: {
        system: "ShipStation",
        shipmentId: "shipstation:label:se-9001",
        shipmentRef: "shipstation:shipment:se-7001",
        orderRef: "#1001",
        carrier: "ups",
        trackingNumber: "1ZTEST100001",
        status: "delivered",
        labelStatus: "completed",
        voided: false,
        voidedAt: undefined,
        service: "ups_next_day_air",
        signatureRequired: true,
        labelCostCents: 4850,
        insuranceCostCents: 2100,
        insuredCents: 240_000,
        currency: "USD",
        isReturn: false,
        international: false,
        destinationState: "NY",
        destinationCountry: "US",
        shipDate: "2026-01-01T01:01:00.000Z",
        createdAt: before(2),
      },
    });
    expect(SHIPSTATION_LABEL_EVENT).toBe("shipment.tracked");
    const kept = JSON.stringify(event);
    for (const word of ["Customer", "Test Street", "10001", "labels.example", "track.example"]) expect(kept, word).not.toContain(word);
  });

  it("maps tracking and label statuses to the shared status", () => {
    const status = (extra: Record<string, unknown>) => shipStationLabelEvent(label(extra), ctx).event.payload.status;
    expect(status({ tracking_status: "in_transit" })).toBe("in_transit");
    expect(status({ tracking_status: "error" })).toBe("exception");
    expect(status({ tracking_status: "unknown" })).toBe("label_created");
    expect(status({ tracking_status: undefined, status: "processing" })).toBe("label_created");
    expect(status({ tracking_status: "unknown", status: "error" })).toBe("exception");
    expect(status({ tracking_status: "toString" })).toBe("label_created");
    const voided = shipStationLabelEvent(label({ status: "voided", voided_at: before(1) }), ctx).event.payload;
    expect(voided).toMatchObject({ status: "unknown", labelStatus: "voided", voided: true, voidedAt: before(1) });
    expect(shipStationLabelEvent(label({ voided: true, voided_at: "x" }), ctx).event.payload).toMatchObject({ status: "unknown", labelStatus: "completed", voided: true, voidedAt: undefined });
    expect(shipStationLabelEvent(label({ voided: "true", voided_at: before(1) }), ctx).event.payload).toMatchObject({ voided: false, voidedAt: undefined });
  });

  it("leaves out what doesn't read on a label", () => {
    const p = shipStationLabelEvent(
      label({ shipment_id: "a b", external_order_id: null, carrier_code: "", tracking_number: "1z test", service_code: 5, confirmation: "delivery", shipment_cost: null, insurance_cost: { currency: "eur", amount: 3 }, packages: [{}], is_return_label: 1, is_international: true, ship_to: [], ship_date: null }),
      ctx,
    ).event.payload;
    expect(p).toMatchObject({ shipmentRef: undefined, orderRef: undefined, carrier: undefined, trackingNumber: undefined, service: undefined, signatureRequired: false, labelCostCents: undefined, insuranceCostCents: 300, insuredCents: undefined, currency: "EUR", isReturn: false, international: true, destinationState: undefined, shipDate: undefined });
    expect(shipStationLabelEvent(label({ tracking_number: "1ztest12", shipment_cost: null, insurance_cost: null, packages: [{ insured_value: { currency: "gbp", amount: 1 } }] }), ctx).event.payload).toMatchObject({ trackingNumber: "1ZTEST12", currency: "GBP", insuredCents: 100 });
    expect(shipStationLabelEvent(label({ tracking_number: "1ZTEST1", shipment_cost: null, insurance_cost: null, packages: null, confirmation: null }), ctx).event.payload).toMatchObject({ trackingNumber: undefined, currency: undefined, signatureRequired: false });
    expect(shipStationLabelEvent(label({ tracking_number: "A".repeat(41) }), ctx).event.payload.trackingNumber).toBeUndefined();
    expect(shipStationLabelEvent(label({ tracking_number: 12345678 }), ctx).event.payload.trackingNumber).toBeUndefined();
    expect(shipStationLabelEvent(label({ tracking_number: "1Z 999 AA1" }), ctx).event.payload.trackingNumber).toBeUndefined();
    expect(shipStationLabelEvent(label({ is_international: "true" }), ctx).event.payload.international).toBe(false);
    expect(shipStationShipmentEvent(shipment({ external_order_id: "<b" }), ctx).event.payload.orderRef).toBeUndefined();
  });

  it("is a duplicate when read again unchanged, and a new event when it changes", () => {
    const a = shipStationShipmentEvent(shipment(), ctx).event;
    expect(shipStationShipmentEvent(shipment(), { receivedAt: before(0.5) }).event.idempotencyKey).toBe(a.idempotencyKey);
    expect(shipStationShipmentEvent(shipment({ shipment_status: "cancelled" }), ctx).event.idempotencyKey).not.toBe(a.idempotencyKey);
    const l = shipStationLabelEvent(label(), ctx).event;
    expect(shipStationLabelEvent(label({ tracking_status: "in_transit" }), ctx).event.idempotencyKey).not.toBe(l.idempotencyKey);
    expect(shipStationLabelEvent(label(), { receivedAt: before(0.5) }).event.idempotencyKey).toBe(l.idempotencyKey);
  });

  it("dead-letters a shipment or label it can't read, saying why", () => {
    const s = shipStationShipmentEvent({ shipment_id: "a b", shipment_status: "shipped" }, ctx);
    expect(s.ok).toBe(false);
    expect(s.event).toEqual({
      id: s.event.idempotencyKey.replace(/:/g, "_"),
      type: SHIPSTATION_SHIPMENT_EVENT,
      occurredAt: undefined,
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^shipstation:unreadable_shipment:[0-9a-f]{12}$/),
      payload: { system: "ShipStation", shipmentId: null, problems: ["shipment has no id that reads", "shipment has no change time that reads", "shipment has no status ShipStation documents"] },
    });
    for (const raw of [null, [shipment()], "x"]) expect(shipStationShipmentEvent(raw, ctx).event.payload.problems).toEqual(["shipment is not an object", "shipment has no id that reads", "shipment has no change time that reads", "shipment has no status ShipStation documents"]);
    expect(shipStationShipmentEvent(null, ctx).event.idempotencyKey).not.toBe(shipStationShipmentEvent("x", ctx).event.idempotencyKey);
    expect(shipStationShipmentEvent(shipment({ shipment_status: "toString" }), ctx).event.payload).toEqual({ system: "ShipStation", shipmentId: "se-7001", problems: ["shipment has no status ShipStation documents"] });
    const l = shipStationLabelEvent({ label_id: 5, status: "printed", created_at: "2026-02-30T00:00:00Z" }, ctx);
    expect(l.event).toMatchObject({ occurredAt: undefined, idempotencyKey: expect.stringMatching(/^shipstation:unreadable_label:[0-9a-f]{12}$/), payload: { system: "ShipStation", labelId: null, problems: ["label has no id that reads", "label has no creation time that reads", "label has no status ShipStation documents"] } });
    expect(shipStationLabelEvent(7, ctx).event.payload.problems).toEqual(["label is not an object", "label has no id that reads", "label has no creation time that reads", "label has no status ShipStation documents"]);
    for (const status of ["processing", "completed", "error", "voided"]) expect(shipStationLabelEvent(label({ status }), ctx).ok).toBe(true);
    for (const shipment_status of ["pending", "processing", "label_purchased", "cancelled"]) expect(shipStationShipmentEvent(shipment({ shipment_status }), ctx).ok).toBe(true);
  });
});

describe("ShipStation checkpoint", () => {
  const cursor = (c: unknown) => JSON.stringify(c);
  const pass = { list: "labels", since: before(30), page: 2, top: null };

  it("round-trips and turns down any other shape", () => {
    const good: ShipStationCursor[] = [
      { done: false, mark: null, pass: null },
      { done: true, mark: before(1), pass: pass as ShipStationCursor["pass"] },
      { done: false, mark: null, pass: { list: "shipments", since: before(1), page: SHIPSTATION_MAX_PAGE, top: before(2) } },
    ];
    for (const c of good) expect(parseShipStationCursor(cursor(c))).toEqual(c);
    expect(parseShipStationCursor(null)).toBeNull();
    const bad = [
      "",
      "x",
      "null",
      "[]",
      "5",
      cursor({ done: "yes", mark: null, pass: null }),
      cursor({ mark: null, pass: null }),
      cursor({ done: true, pass: null }),
      cursor({ done: true, mark: "x", pass: null }),
      cursor({ done: true, mark: "2026-11-01T00:00:00Z", pass: null }),
      cursor({ done: true, mark: null }),
      cursor({ done: true, mark: null, pass: "x" }),
      cursor({ done: true, mark: null, pass: { ...pass, list: "orders" } }),
      cursor({ done: true, mark: null, pass: { ...pass, since: null } }),
      cursor({ done: true, mark: null, pass: { ...pass, since: "2026-11-01T00:00:00Z" } }),
      cursor({ done: true, mark: null, pass: { ...pass, page: 0 } }),
      cursor({ done: true, mark: null, pass: { ...pass, page: 1.5 } }),
      cursor({ done: true, mark: null, pass: { ...pass, page: SHIPSTATION_MAX_PAGE + 1 } }),
      cursor({ done: true, mark: null, pass: { ...pass, top: "x" } }),
      cursor({ done: true, mark: null, pass: { ...pass, top: undefined } }),
    ];
    for (const raw of bad) expect(() => parseShipStationCursor(raw), raw).toThrow("ShipStation checkpoint is not in the expected shape");
    expect(parseShipStationCursor(cursor({ done: true, mark: null, pass: { ...pass, extra: 2 }, more: 3 }))).toEqual({ done: true, mark: null, pass });
  });
});

describe("ShipStation connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(shipStationDocMock(account())), expected: { ingested: 6 } });
    expect(result.full.ingested).toBe(6);
  });

  it("imports two years of shipments, then labels, then stops for good", async () => {
    const mock = shipStationDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(6);
    expect(mock.reads).toEqual([
      { list: "shipments", query: { modified_at_start: TWO_YEARS, sort_by: "modified_at", sort_dir: "asc", page_size: "100", page: "1" } },
      { list: "labels", query: { created_at_start: TWO_YEARS, sort_by: "created_at", sort_dir: "asc", page_size: "100", page: "1" } },
    ]);
    expect(memory.events.map((e) => e.type)).toEqual([...Array(3).fill(SHIPSTATION_SHIPMENT_EVENT), ...Array(3).fill(SHIPSTATION_LABEL_EVENT)]);
    expect(memory.events.slice(0, 3).map((e) => e.occurredAt)).toEqual([before(5000), before(30), before(1)]);
    expect(parseShipStationCursor(report.cursor)).toEqual({ done: true, mark: before(1), pass: null });
    assertSynthetic(memory.events);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(2);
  });

  it("reads 100 a page, keeping the page in the checkpoint, and resumes there", async () => {
    shipStationShipment.reset();
    const shipments = Array.from({ length: 230 }, (_, i) => shipStationShipment.one({ modified_at: before(300 - i) }));
    const mock = shipStationDocMock(account({ shipments, labels: [] }));
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([100, 100, 30, 0]);
    const cursors = batches.map((b) => parseShipStationCursor(b.cursor as string)!);
    expect(cursors.map((c) => c.pass?.list ?? null)).toEqual(["shipments", "shipments", "labels", null]);
    expect(cursors[0]).toEqual({ done: false, mark: null, pass: { list: "shipments", since: TWO_YEARS, page: 2, top: before(201) } });
    expect(cursors[2]).toEqual({ done: false, mark: before(71), pass: { list: "labels", since: TWO_YEARS, page: 1, top: null } });
    expect(cursors[3]).toEqual({ done: true, mark: before(71), pass: null });
    const resumed = shipStationDocMock(account({ shipments, labels: [] }));
    const rest = await drain(connector(resumed).historicalImport({ cursor: batches[0]!.cursor } as never));
    expect(resumed.reads.map((r) => [r.list, r.query.page])).toEqual([["shipments", "2"], ["shipments", "3"], ["labels", "1"]]);
    expect(rest.map((b) => b.events.length)).toEqual([100, 30, 0]);
  });

  it("stops a list at its last page, a short page, or the most a pass reads", async () => {
    const asked: unknown[] = [];
    const full = Array.from({ length: SHIPSTATION_PAGE_SIZE }, () => ({}));
    let pages = 2;
    let rows: unknown[] = full;
    const fake: ShipStationClient = { page: async (list, since, page) => (asked.push([list, page]), { rows, pages }) };
    await drain(connector(shipStationDocMock(account()), { client: fake }).incrementalSync({ cursor: null } as never));
    expect(asked).toEqual([["shipments", 1], ["shipments", 2], ["labels", 1], ["labels", 2]]);
    asked.length = 0;
    pages = 5;
    rows = full.slice(1);
    await drain(connector(shipStationDocMock(account()), { client: fake }).incrementalSync({ cursor: null } as never));
    expect(asked).toEqual([["shipments", 1], ["labels", 1]]);
    asked.length = 0;
    pages = SHIPSTATION_MAX_PAGE + 5;
    rows = full;
    await drain(connector(shipStationDocMock(account()), { client: fake }).incrementalSync({ cursor: JSON.stringify({ done: false, mark: null, pass: { list: "labels", since: before(5), page: SHIPSTATION_MAX_PAGE - 1, top: null } }) } as never));
    expect(asked).toEqual([["labels", SHIPSTATION_MAX_PAGE - 1], ["labels", SHIPSTATION_MAX_PAGE]]);
  });

  it("reads shipments changed since the newest change the last sync saw, less five minutes, and the last 30 days of labels", async () => {
    const mock = shipStationDocMock(account());
    const state = { done: true, mark: before(2), pass: null };
    const batches = await drain(connector(mock).incrementalSync({ cursor: JSON.stringify(state) } as never));
    const less = (iso: string) => new Date(Date.parse(iso) - SHIPSTATION_OVERLAP_MS).toISOString();
    expect(mock.reads.map((r) => r.query.modified_at_start ?? r.query.created_at_start)).toEqual([less(before(2)), LABEL_START]);
    expect(eventsOf(batches).map((e) => e.type)).toEqual([SHIPSTATION_SHIPMENT_EVENT, SHIPSTATION_LABEL_EVENT, SHIPSTATION_LABEL_EVENT]);
    expect(parseShipStationCursor(batches.at(-1)!.cursor as string)).toEqual({ done: true, mark: before(1), pass: null });
    expect(SHIPSTATION_OVERLAP_MS).toBe(300_000);
    expect(SHIPSTATION_LABEL_DAYS).toBe(30);
  });

  it("looks back two days for shipments on a first sync with no checkpoint, and doesn't call the import done", async () => {
    const mock = shipStationDocMock(account());
    const batches = await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(eventsOf(batches)).toHaveLength(4);
    expect(mock.reads.map((r) => r.query.modified_at_start ?? r.query.created_at_start)).toEqual([before(48), LABEL_START]);
    expect(SHIPSTATION_FIRST_LOOKBACK_MS).toBe(48 * HOUR_MS);
    expect(batches.map((b) => parseShipStationCursor(b.cursor as string)!.done)).toEqual([false, false]);
  });

  it("marks the newest shipment change, whatever order the rows come in, ignores times that don't read, and keeps the mark when nothing changed", async () => {
    const rows: Record<string, unknown[]> = { shipments: [{ modified_at: before(5) }, { modified_at: before(2) }, { modified_at: "x" }, null, { modified_at: before(3) }], labels: [{ created_at: before(1), modified_at: before(0) }] };
    const fake: ShipStationClient = { page: async (list) => ({ rows: rows[list]!, pages: 1 }) };
    const batches = await drain(connector(shipStationDocMock(account()), { client: fake }).incrementalSync({ cursor: null } as never));
    expect(parseShipStationCursor(batches.at(-1)!.cursor as string)!.mark).toBe(before(2));
    expect(eventsOf(batches).every((e) => e.receivedAt === RECEIVED)).toBe(true);
    rows.shipments = [];
    const kept = await drain(connector(shipStationDocMock(account()), { client: fake }).incrementalSync({ cursor: JSON.stringify({ done: true, mark: before(9), pass: null }) } as never));
    expect(parseShipStationCursor(kept.at(-1)!.cursor as string)!.mark).toBe(before(9));
  });

  it("keeps a finished import finished on every page, and resumes a later sync part way", async () => {
    const asked: unknown[] = [];
    const fake: ShipStationClient = { page: async (list, since, page) => (asked.push([list, since, page]), { rows: [], pages: 1 }) };
    const state = { done: true, mark: before(1), pass: { list: "labels", since: before(10), page: 3, top: null } };
    const batches = await drain(connector(shipStationDocMock(account()), { client: fake }).incrementalSync({ cursor: JSON.stringify(state) } as never));
    expect(asked).toEqual([["labels", before(10), 3]]);
    expect(parseShipStationCursor(batches[0]!.cursor as string)).toEqual({ done: true, mark: before(1), pass: null });
    const full = Array.from({ length: SHIPSTATION_PAGE_SIZE }, () => ({}));
    const paged: ShipStationClient = { page: async (_list, _since, page) => ({ rows: full, pages: page < 2 ? 2 : 1 }) };
    const done = await drain(connector(shipStationDocMock(account()), { client: paged }).incrementalSync({ cursor: JSON.stringify({ done: true, mark: null, pass: null }) } as never));
    expect(done.map((b) => parseShipStationCursor(b.cursor as string)!.done)).toEqual([true, true, true, true]);
  });

  it("dead-letters what it can't read and carries on", async () => {
    const data = account();
    data.shipments!.push({ shipment_id: "a b", modified_at: before(2) });
    data.labels!.push({ label_id: 0, created_at: before(2) });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(shipStationDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 6, deadLettered: 2 });
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = shipStationDocMock(account({ rateLimits: 2 }));
    const slept: number[] = [];
    const batches = await drain(connector(mock, { sleep: async (ms) => void slept.push(ms) }).historicalImport({ cursor: null } as never));
    expect(eventsOf(batches)).toHaveLength(6);
    expect(slept).toEqual([1000, 1000]);
  });

  it("stops on a key that's turned down", async () => {
    await expect(drain(connector(shipStationDocMock(account({ apiKey: "9".repeat(24) }))).historicalImport({ cursor: null } as never))).rejects.toThrow("ShipStation turned down SHIPSTATION_API_KEY");
  });

  it("checks its settings", () => {
    const mock = shipStationDocMock(account());
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { apiKey: "nope" })).toThrow(ShipStationConfigError);
    expect(() => connector(mock, { apiKey: "nope", client: { page: async () => ({ rows: [], pages: 1 }) } })).not.toThrow();
  });

  it("reads back as far as told, and up to now when no clock is given", async () => {
    const asked: unknown[] = [];
    const fake: ShipStationClient = { page: async (list, since) => (asked.push(since), { rows: [], pages: 1 }) };
    await drain(connector(shipStationDocMock(account()), { client: fake, historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(asked).toEqual(["2025-11-11T15:00:00.000Z", "2025-11-11T15:00:00.000Z"]);
    asked.length = 0;
    await drain(shipStationConnector({ apiKey: API_KEY, client: fake }).incrementalSync({ cursor: null } as never));
    expect(Math.abs(Date.parse(asked[0] as string) - (Date.now() - SHIPSTATION_FIRST_LOOKBACK_MS))).toBeLessThan(5000);
    expect(Math.abs(Date.parse(asked[1] as string) - (Date.now() - SHIPSTATION_LABEL_DAYS * 24 * HOUR_MS))).toBeLessThan(5000);
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(SHIPSTATION_WRITES).toEqual([
      { integration: "shipstation", name: "create_label", description: "Buy a shipping label in ShipStation, paid from the account's postage balance", kind: "append", approval: "each", dailyCap: 10 },
      { integration: "shipstation", name: "add_tracking", description: "Add a tracking number to a ShipStation order", kind: "update", approval: "each", dailyCap: 20 },
    ]);
    const c = connector(shipStationDocMock(account()));
    expect(c.writes).toBe(SHIPSTATION_WRITES);
    expect(c.source).toBe("shipstation");
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "create_label", integration: "shipstation", outcome: "refused" },
      { action: "add_tracking", integration: "shipstation", outcome: "refused" },
    ]);
  });
});

describe("ShipStation doc mock", () => {
  const get = (mock: ShipStationMock, path: string, key = API_KEY) => mock.fetch(`${BASE}${path}`, { headers: { "API-Key": key } });

  it("wants the key, and checks the parameters, page size, sort and times", async () => {
    const mock = shipStationDocMock(account());
    expect((await get(mock, "/shipments", "nope")).status).toBe(401);
    expect((await mock.fetch(`${BASE}/labels`)).status).toBe(401);
    for (const q of ["/shipments?since=1", "/shipments?page_size=501", "/shipments?page_size=0", "/shipments?page=0", "/shipments?sort_by=voided_at", "/shipments?sort_dir=up", "/shipments?modified_at_start=yesterday", "/labels?created_at_start=x", "/labels?modified_at_start=2026-01-01T00:00:00Z", "/labels?shipment_status=pending"]) {
      expect((await get(mock, q)).status, q).toBe(400);
    }
    const first = (await (await get(mock, "/shipments?page_size=2")).json()) as { shipments: Record<string, unknown>[]; total: number; page: number; pages: number };
    // Newest first by default, by creation.
    expect(first.shipments.map((s) => s.shipment_id)).toEqual(["se-7001", "se-7002"]);
    expect(first).toMatchObject({ total: 4, page: 1, pages: 2 });
    const recent = (await (await get(mock, `/shipments?modified_at_start=${encodeURIComponent(before(30))}&sort_by=modified_at&sort_dir=asc`)).json()) as typeof first;
    expect(recent.shipments.map((s) => s.modified_at)).toEqual([before(30), before(1)]);
    const created = (await (await get(mock, `/shipments?created_at_start=${encodeURIComponent(before(31))}`)).json()) as typeof first;
    expect(created.shipments).toHaveLength(2);
    const labels = (await (await get(mock, `/labels?created_at_start=${encodeURIComponent(before(30))}&sort_by=voided_at&page=2&page_size=1`)).json()) as { labels: unknown[]; pages: number };
    expect(labels).toMatchObject({ pages: 2 });
    expect(labels.labels).toHaveLength(1);
    const empty = (await (await get(shipStationDocMock({ apiKey: API_KEY }), "/labels")).json()) as { labels: unknown[]; pages: number };
    expect(empty).toMatchObject({ labels: [], pages: 1 });
    expect(((await (await get(shipStationDocMock({ apiKey: API_KEY }), "/shipments")).json()) as { shipments: unknown[] }).shipments).toEqual([]);
    expect(mock.reads.at(-1)!.list).toBe("labels");
  });

  it("answers 429 with Retry-After", async () => {
    const mock = shipStationDocMock(account({ rateLimits: 1 }));
    const r = await get(mock, "/shipments");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("1");
    expect((await get(mock, "/shipments")).status).toBe(200);
    expect(SHIPSTATION_DOC_PAGES.auth).toMatch(/^https:\/\/docs\.shipstation\.com\//);
  });
});
