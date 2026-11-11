import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import {
  TEST_ORG,
  assertWritesRefused,
  checkConnectorSync,
  repairShoprDocMock,
  repairShoprEstimate,
  repairShoprInvoice,
  repairShoprTicket,
  testPipeline,
  type RepairShoprMock,
  type RepairShoprMockData,
  type RepairShoprMockRecord,
} from "@karatos/connector-testkit";
import {
  REPAIRSHOPR_ESTIMATE_LOOKBACK_MS,
  REPAIRSHOPR_EVENTS,
  REPAIRSHOPR_LISTS,
  REPAIRSHOPR_OVERLAP_MS,
  REPAIRSHOPR_WRITES,
  RepairShoprApiError,
  RepairShoprConfigError,
  parseRepairShoprCursor,
  repairShoprCents,
  repairShoprClient,
  repairShoprConnector,
  repairShoprDay,
  repairShoprEvent,
  repairShoprRef,
  repairShoprSubdomain,
  repairShoprTime,
  type RepairShoprClient,
  type RepairShoprEvent,
  type RepairShoprOptions,
  type RepairShoprQuery,
} from "../src/index.js";

// A token-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = ["T", "0".repeat(32)].join("-");
const API = "https://example.repairshopr.com/api/v1";
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const DAY_MS = 86_400_000;
const noSleep = async () => {};

/** An ISO time `days` before NOW. */
const ago = (days: number) => new Date(NOW().getTime() - days * DAY_MS).toISOString();

/** A ticket, estimate and invoice from 10 days, 400 days and six years ago. */
function shop(overrides: Partial<RepairShoprMockData> = {}): RepairShoprMockData {
  for (const b of [repairShoprTicket, repairShoprEstimate, repairShoprInvoice]) b.reset();
  const days = [10, 400, 2200];
  return {
    token: TOKEN,
    tickets: days.map((d) => repairShoprTicket.one({ created_at: ago(d), updated_at: ago(d - 1) })),
    estimates: days.map((d) => repairShoprEstimate.one({ created_at: ago(d), updated_at: ago(d - 1) })),
    invoices: days.map((d) => repairShoprInvoice.one({ created_at: ago(d), updated_at: ago(d - 1) })),
    ...overrides,
  };
}

const connector = (mock: RepairShoprMock, overrides: Partial<RepairShoprOptions> = {}) => repairShoprConnector({ apiToken: TOKEN, subdomain: "example", fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as RepairShoprEvent[];

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
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof repairShoprClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = repairShoprClient({ apiToken: TOKEN, subdomain: "example", fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const SINCE = "2026-11-11T14:00:00.000Z";
const Q: RepairShoprQuery = { list: "tickets", since: SINCE, page: 1 };
const page = (records: unknown[], meta?: unknown) => json(200, meta === undefined ? { tickets: records } : { tickets: records, meta });

describe("RepairShopr client", () => {
  it("checks its token and subdomain before sending anything", () => {
    const { fetch, sent } = scripted(page([]));
    const make = (o: Partial<Parameters<typeof repairShoprClient>[0]>) => () => repairShoprClient({ apiToken: TOKEN, subdomain: "example", fetch, ...o });
    for (const apiToken of ["", "   ", "x".repeat(15), "has a space in it ok", "x".repeat(513), "token!with!marks!", undefined as never]) expect(make({ apiToken }), String(apiToken)).toThrow(new RepairShoprConfigError("REPAIRSHOPR_API_TOKEN is missing or not in the expected shape"));
    expect(make({ apiToken: "x".repeat(16) })).not.toThrow();
    expect(make({ apiToken: `${"Az09._~+/=-".repeat(46)}x` })).not.toThrow();
    expect(make({ apiToken: ` ${TOKEN} ` })).not.toThrow();
    for (const subdomain of ["", "-x", "ex_ample", "ex.ample", "a".repeat(64), "http://example.repairshopr.com", "example.repairshopr.com/path", "example.repairshoprxcom", "example.repairshopr.com.example", "example.syncromsp.com", "a.example.repairshopr.com", undefined as never])
      expect(make({ subdomain }), String(subdomain)).toThrow(new RepairShoprConfigError("REPAIRSHOPR_SUBDOMAIN must be the account's subdomain, like example in example.repairshopr.com"));
    expect(make({ subdomain: "a".repeat(63) })).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("reads a subdomain written as a name, a host or a URL", () => {
    expect(repairShoprSubdomain(" https://Example-1.RepairShopr.com/ ")).toBe("example-1");
    expect(repairShoprSubdomain("example.repairshopr.com")).toBe("example");
    expect(repairShoprSubdomain("Example")).toBe("example");
    expect(repairShoprSubdomain("https://x.repairshopr.com//")).toBeNull();
    expect(repairShoprSubdomain("xhttps://x.repairshopr.com")).toBeNull();
    expect(repairShoprSubdomain("x.repairshopr.comx")).toBeNull();
    expect(repairShoprSubdomain("ex/ample")).toBeNull();
    expect(repairShoprClient({ apiToken: TOKEN, subdomain: "https://Shop.repairshopr.com/" }).baseUrl).toBe("https://shop.repairshopr.com/api/v1");
  });

  it("lists each record type from a time, a page at a time, with the token", async () => {
    const { fetch, sent } = scripted(json(200, { tickets: [{ id: 1 }], estimates: [], invoices: [], meta: { total_pages: 2 } }));
    const { c } = client(fetch);
    expect(await c.list(Q)).toEqual({ records: [{ id: 1 }], more: true });
    await c.list({ list: "estimates", since: SINCE, page: 3 });
    await c.list({ list: "invoices", since: SINCE, page: 2 });
    expect(sent.map((s) => s.url)).toEqual([
      `${API}/tickets?since_updated_at=2026-11-11T14%3A00%3A00.000Z&page=1`,
      `${API}/estimates?created_after=2026-11-11T14%3A00%3A00.000Z&page=3`,
      `${API}/invoices?since_updated_at=2026-11-11T14%3A00%3A00.000Z&page=2`,
    ]);
    for (const s of sent) {
      expect(s.method).toBe("GET");
      expect(s.headers).toEqual({ authorization: `Bearer ${TOKEN}`, accept: "application/json" });
    }
  });

  it("stops at the last page the answer counts, or at an empty page when it counts none", async () => {
    const more = async (answer: () => Response, p = 1) => (await client(scripted(answer).fetch).c.list({ ...Q, page: p })).more;
    expect(await more(page([{ id: 1 }], { total_pages: 2 }), 2)).toBe(false);
    expect(await more(page([{ id: 1 }], { total_pages: 3 }), 2)).toBe(true);
    expect(await more(page([], { total_pages: 0 }))).toBe(false);
    for (const meta of [undefined, {}, { total_pages: "2" }, { total_pages: 1.5 }, null]) {
      expect(await more(page([{ id: 1 }], meta)), JSON.stringify(meta)).toBe(true);
      expect(await more(page([], meta)), JSON.stringify(meta)).toBe(false);
    }
    // Estimates may answer under data.
    expect((await client(scripted(json(200, { data: [{ id: 2 }] })).fetch).c.list({ ...Q, list: "estimates" })).records).toEqual([{ id: 2 }]);
    expect((await client(scripted(json(200, { estimates: [{ id: 3 }], data: [{ id: 2 }] })).fetch).c.list({ ...Q, list: "estimates" })).records).toEqual([{ id: 3 }]);
  });

  it("checks what it is asked for before sending", async () => {
    const { fetch, sent } = scripted(page([]));
    const { c } = client(fetch);
    await expect(c.list({ ...Q, list: "customers" as never })).rejects.toThrow(new RepairShoprApiError("the client reads only the lists the connector uses", 0));
    for (const p of [0, -1, 1.5, Number.NaN, "2" as never]) await expect(c.list({ ...Q, page: p }), String(p)).rejects.toThrow("page must be a whole number, 1 or more");
    for (const since of ["2026-11-11", "2026-11-11T14:00:00Z", "2026-11-11T14:00:00.000+00:00", " 2026-11-11T14:00:00.000Z", "2026-11-11T14:00:00.000Zx", "x2026-11-11T14:00:00.000Z", "yesterday"]) await expect(c.list({ ...Q, since }), since).rejects.toThrow("a list must start from a UTC time");
    expect(sent).toHaveLength(0);
  });

  it("says when RepairShopr turns down the token, never repeating RepairShopr's words", async () => {
    for (const status of [401, 403]) {
      const err = await client(scripted(json(status, { message: "secret detail" })).fetch).c.list(Q).catch((e: Error) => e);
      expect(err).toBeInstanceOf(RepairShoprConfigError);
      expect((err as Error).message).toBe(`RepairShopr turned down REPAIRSHOPR_API_TOKEN for tickets (HTTP ${status}); check the token has the List/Search permission for it`);
    }
    const err = (await client(scripted(json(400, { message: "secret detail" })).fetch).c.list(Q).catch((e: Error) => e)) as RepairShoprApiError;
    expect(err).toBeInstanceOf(RepairShoprApiError);
    expect(err.message).toBe("RepairShopr answered HTTP 400 for tickets");
    expect(err.status).toBe(400);
    expect(err.name).toBe("RepairShoprApiError");
    expect(new RepairShoprConfigError("x").name).toBe("RepairShoprConfigError");
    await expect(client(scripted(json(201, { tickets: [] })).fetch).c.list(Q)).rejects.toThrow("RepairShopr answered HTTP 201 for tickets");
  });

  it("says when an answer isn't a list of records", async () => {
    for (const answer of [text(200, "not json"), json(200, null), json(200, {}), json(200, []), json(200, { tickets: {} }), json(200, { invoices: [] }), json(200, "x")]) {
      const err = (await client(scripted(answer).fetch).c.list(Q).catch((e: Error) => e)) as RepairShoprApiError;
      expect(err.message).toBe("RepairShopr answered without a list of tickets");
      expect(err.status).toBe(200);
    }
  });

  it("waits out the rate limit for a minute, or as Retry-After says, and server errors a few seconds, then gives up", async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const { fetch, sent } = scripted(json(status, {}, { "retry-after": "2" }), page([{ id: 1 }]));
      const { c, slept } = client(fetch);
      expect((await c.list(Q)).records).toHaveLength(1);
      expect(sent).toHaveLength(2);
      expect(slept, String(status)).toEqual([2000]);
    }
    const limited = scripted(json(429, {}, { "retry-after": "600" }), json(429, {}), json(429, {}, { "retry-after": "0" }), json(429, {}, { "retry-after": "soon" }));
    const l = client(limited.fetch);
    await expect(l.c.list(Q)).rejects.toThrow("RepairShopr answered HTTP 429 for tickets");
    expect(limited.sent).toHaveLength(4);
    expect(l.slept).toEqual([60_000, 60_000, 60_000]);
    const down = scripted(json(503, {}));
    const d = client(down.fetch);
    await expect(d.c.list(Q)).rejects.toThrow("RepairShopr answered HTTP 503 for tickets");
    expect(d.slept).toEqual([1000, 2000, 4000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    for (const status of [400, 401, 403, 404, 422, 501]) {
      const { fetch, sent } = scripted(json(status, {}), page([]));
      await expect(client(fetch).c.list(Q)).rejects.toThrow(`HTTP ${status}`);
      expect(sent).toHaveLength(1);
    }
    const { fetch, sent } = scripted(json(503, {}));
    await expect(client(fetch, { retries: 1 }).c.list(Q)).rejects.toThrow("HTTP 503");
    expect(sent).toHaveLength(2);
    const once = scripted(json(503, {}));
    await expect(client(once.fetch, { retries: 0 }).c.list(Q)).rejects.toThrow("HTTP 503");
    expect(once.sent).toHaveLength(1);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "0.01" }), page([]));
    globalThis.fetch = fetch;
    try {
      const started = Date.now();
      await repairShoprClient({ apiToken: TOKEN, subdomain: "example" }).list(Q);
      expect(Date.now() - started).toBeGreaterThanOrEqual(5);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(2);
  });
});

describe("RepairShopr reading helpers", () => {
  it("reads RepairShopr's times and days as UTC", () => {
    expect(repairShoprTime("2026-01-02T10:30:00.000-05:00")).toBe("2026-01-02T15:30:00.000Z");
    expect(repairShoprTime("2026-01-02T10:30:00Z")).toBe("2026-01-02T10:30:00.000Z");
    expect(repairShoprTime(" 2026-01-02T10:30:00.123456+01:00 ")).toBe("2026-01-02T09:30:00.123Z");
    expect(repairShoprTime("2026-01-02")).toBe("2026-01-02T00:00:00.000Z");
    expect(repairShoprTime("2026-01-02T23:59:59")).toBe("2026-01-02T23:59:59.000Z");
    for (const bad of ["2026-02-30", "2026-13-01", "2026-01-02T24:00:00Z", "2026-01-02T10:60:00Z", "2026-01-02T10:30", "2026-01-02T10:30:00.1234567Z", "2026-01-02T10:30:00+0500", "x2026-01-02", "2026-01-02x", "", null, 1_767_312_000, undefined]) expect(repairShoprTime(bad), String(bad)).toBeUndefined();
  });

  it("reads a time with no zone as UTC wherever the server is", () => {
    const tz = process.env.TZ;
    process.env.TZ = "Pacific/Auckland";
    try {
      expect(repairShoprTime("2026-01-02T10:30:00")).toBe("2026-01-02T10:30:00.000Z");
      expect(repairShoprTime("2026-01-02")).toBe("2026-01-02T00:00:00.000Z");
    } finally {
      process.env.TZ = tz;
    }
  });

  it("reads a day as the shop wrote it, whatever its zone", () => {
    expect(repairShoprDay("2026-01-02T23:00:00.000-05:00")).toBe("2026-01-02");
    expect(repairShoprDay(" 2026-01-02 ")).toBe("2026-01-02");
    for (const bad of ["2026-02-30", "soon", null, 5]) expect(repairShoprDay(bad), String(bad)).toBeNull();
  });

  it("reads dollars as cents", () => {
    expect(repairShoprCents("480.0")).toBe(48_000);
    expect(repairShoprCents(" 12.345 ")).toBe(1235);
    expect(repairShoprCents("-0.005")).toBe(-1);
    expect(repairShoprCents(0.005)).toBe(1);
    expect(repairShoprCents(-12.5)).toBe(-1250);
    expect(repairShoprCents("0")).toBe(0);
    expect(repairShoprCents("123456789012")).toBe(12_345_678_901_200);
    for (const bad of ["", "1,000.00", "$5", "1e3", "1.1234567", "1234567890123", ".5", "5.", null, undefined, true, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) expect(repairShoprCents(bad), String(bad)).toBeNull();
  });

  it("makes references", () => {
    expect(repairShoprRef("ticket", 5)).toBe("repairshopr:ticket:5");
  });
});

describe("RepairShopr events", () => {
  const ctx = { receivedAt: RECEIVED };
  const one = (b: { reset(): void; one(o?: RepairShoprMockRecord): RepairShoprMockRecord }, o: RepairShoprMockRecord = {}) => {
    b.reset();
    return b.one(o);
  };

  it("names an event type for each list", () => {
    expect(REPAIRSHOPR_LISTS).toEqual(["tickets", "estimates", "invoices"]);
    expect(REPAIRSHOPR_EVENTS).toEqual({ tickets: "repair.ticket_updated", estimates: "repair.estimate_updated", invoices: "repair.invoice_updated" });
  });

  it("keeps a ticket's number, status and dates, and not its subject, comments or customer's details", () => {
    const e = repairShoprEvent("tickets", one(repairShoprTicket), ctx);
    expect(e.type).toBe("repair.ticket_updated");
    expect(e.occurredAt).toBe("2026-01-02T02:00:00.000Z");
    expect(e.receivedAt).toBe(RECEIVED);
    expect(e.payload).toStrictEqual({
      system: "RepairShopr",
      ticketId: "repairshopr:ticket:1",
      number: "1001",
      status: "Waiting on Parts",
      customerId: "repairshopr:customer:7",
      openedAt: "2026-01-02T00:00:00.000Z",
      dueDate: "2026-01-16",
      updatedAt: "2026-01-02T02:00:00.000Z",
    });
    expect(e.idempotencyKey).toMatch(/^repairshopr:ticket:1:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    const all = JSON.stringify(e);
    for (const hidden of ["crown", "Customer", "example.test", "555", "Test St", "Test Tech", "Watch service"]) expect(all, hidden).not.toContain(hidden);
    expect(repairShoprEvent("tickets", one(repairShoprTicket, { number: "A-9", status: ` ${"S".repeat(80)} `, customer_id: 0, due_date: null, created_at: "soon" }), ctx).payload).toMatchObject({ number: "A-9", status: "S".repeat(60), customerId: null, dueDate: null, openedAt: null });
    expect(repairShoprEvent("tickets", one(repairShoprTicket, { number: 1.5, status: "  " }), ctx).payload).toMatchObject({ number: null, status: null });
    expect(repairShoprEvent("tickets", one(repairShoprTicket, { number: "N".repeat(50) }), ctx).payload.number).toBe("N".repeat(40));
  });

  it("keeps an estimate's status and totals, and not its note", () => {
    const e = repairShoprEvent("estimates", one(repairShoprEstimate), ctx);
    expect(e.type).toBe("repair.estimate_updated");
    expect(e.payload).toStrictEqual({
      system: "RepairShopr",
      estimateId: "repairshopr:estimate:1",
      number: "E2001",
      status: "approved",
      customerId: "repairshopr:customer:7",
      date: "2026-01-02",
      subtotalCents: 45_000,
      taxCents: 3000,
      totalCents: 48_000,
      updatedAt: "2026-01-02T03:00:00.000Z",
    });
    const all = JSON.stringify(e);
    for (const hidden of ["crown", "Customer"]) expect(all, hidden).not.toContain(hidden);
    expect(repairShoprEvent("estimates", one(repairShoprEstimate, { status: "S".repeat(80) }), ctx).payload.status).toBe("S".repeat(60));
    expect(repairShoprEvent("estimates", one(repairShoprEstimate, { subtotal: 450, tax: "x", total: null, date: "later" }), ctx).payload).toMatchObject({ subtotalCents: 45_000, taxCents: null, totalCents: null, date: null });
  });

  it("keeps an invoice's totals and whether it's paid, and not its note, PO number or PDF link", () => {
    const e = repairShoprEvent("invoices", one(repairShoprInvoice), ctx);
    expect(e.type).toBe("repair.invoice_updated");
    expect(e.payload).toStrictEqual({
      system: "RepairShopr",
      invoiceId: "repairshopr:invoice:1",
      number: "3001",
      customerId: "repairshopr:customer:7",
      ticketId: "repairshopr:ticket:1",
      locationId: "repairshopr:location:1",
      date: "2026-01-12",
      dueDate: "2026-01-12",
      subtotalCents: 45_000,
      taxCents: 3000,
      totalCents: 48_000,
      paid: true,
      verifiedPaid: false,
      techMarkedPaid: true,
      updatedAt: "2026-01-12T01:00:00.000Z",
    });
    expect(repairShoprEvent("invoices", one(repairShoprInvoice, { is_paid: true, tech_marked_paid: false }), ctx).payload).toMatchObject({ paid: true, techMarkedPaid: false });
    const all = JSON.stringify(e);
    for (const hidden of ["Picked", "PO-1", "pdf", "Customer"]) expect(all, hidden).not.toContain(hidden);
    expect(repairShoprEvent("invoices", one(repairShoprInvoice, { ticket_id: null, location_id: "1", is_paid: "yes", verified_paid: true, tech_marked_paid: 0, due_date: "2026-01-20" }), ctx).payload).toMatchObject({ ticketId: null, locationId: null, paid: null, verifiedPaid: true, techMarkedPaid: null, dueDate: "2026-01-20" });
  });

  it("dates a record by when it changed, or when it was made", () => {
    expect(repairShoprEvent("tickets", one(repairShoprTicket, { updated_at: null }), ctx).occurredAt).toBe("2026-01-02T00:00:00.000Z");
    expect(repairShoprEvent("tickets", one(repairShoprTicket, { updated_at: "soon" }), ctx).payload.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("keys each version by what was kept, so an unchanged one is a duplicate", () => {
    const a = repairShoprEvent("invoices", one(repairShoprInvoice), ctx);
    expect(repairShoprEvent("invoices", one(repairShoprInvoice), { receivedAt: "2027-01-01T00:00:00.000Z" }).idempotencyKey).toBe(a.idempotencyKey);
    expect(repairShoprEvent("invoices", one(repairShoprInvoice, { verified_paid: true }), ctx).idempotencyKey).not.toBe(a.idempotencyKey);
    expect(repairShoprEvent("invoices", one(repairShoprInvoice, { note: "other" }), ctx).idempotencyKey).toBe(a.idempotencyKey);
    // The same ID in another list is another record.
    expect(repairShoprEvent("tickets", one(repairShoprTicket), ctx).idempotencyKey).toMatch(/^repairshopr:ticket:1:/);
  });

  it("dead-letters a record that doesn't read, listing why", () => {
    const e = repairShoprEvent("tickets", { id: 0, updated_at: "soon" }, ctx);
    expect(e.occurredAt).toBeUndefined();
    expect(e.type).toBe("repair.ticket_updated");
    expect(e.payload).toEqual({ system: "RepairShopr", ticketId: null, problems: ["ticket has no ID that reads", "ticket has no time that reads"] });
    expect(e.idempotencyKey).toMatch(/^repairshopr:unreadable_ticket:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    // Two that read the same way are still two records.
    expect(repairShoprEvent("tickets", { id: 0, updated_at: "later" }, ctx).idempotencyKey).not.toBe(e.idempotencyKey);
    expect(repairShoprEvent("invoices", { id: 4 }, ctx).payload).toEqual({ system: "RepairShopr", invoiceId: "repairshopr:invoice:4", problems: ["invoice has no time that reads"] });
    for (const id of [-1, 1.5, "4", Number.MAX_SAFE_INTEGER + 2]) expect(repairShoprEvent("estimates", { id, updated_at: "2026-01-01" }, ctx).payload.problems, String(id)).toEqual(["estimate has no ID that reads"]);
    for (const raw of [null, "x", []]) expect(repairShoprEvent("tickets", raw, ctx).payload.problems, JSON.stringify(raw)).toHaveLength(2);
  });
});

describe("RepairShopr checkpoint", () => {
  const F = "2021-11-11T15:00:00.000Z";
  const T = "2026-11-11T14:00:00.000Z";
  it("reads a checkpoint it wrote, and turns down anything else", () => {
    expect(parseRepairShoprCursor(null)).toBeNull();
    for (const list of REPAIRSHOPR_LISTS) expect(parseRepairShoprCursor(JSON.stringify({ pass: { list, page: 5 }, done: false, from: F, nextFrom: T }))).toEqual({ pass: { list, page: 5 }, done: false, from: F, nextFrom: T });
    expect(parseRepairShoprCursor(JSON.stringify({ pass: null, done: true, from: F, nextFrom: T, extra: 1 }))).toEqual({ pass: null, done: true, from: F, nextFrom: T });
    expect(parseRepairShoprCursor(JSON.stringify({ pass: { list: "invoices", page: 1 }, done: true, from: F, nextFrom: T }))!.pass).toEqual({ list: "invoices", page: 1 });
    for (const bad of [
      "not json",
      "null",
      "[]",
      "3",
      JSON.stringify({ pass: null, done: "yes", from: F, nextFrom: T }),
      JSON.stringify({ pass: null, from: F, nextFrom: T }),
      JSON.stringify({ pass: null, done: true, from: "2021-11-11", nextFrom: T }),
      JSON.stringify({ pass: null, done: true, nextFrom: T }),
      JSON.stringify({ pass: null, done: true, from: F, nextFrom: "2026-11-11T14:00:00Z" }),
      JSON.stringify({ pass: null, done: true, from: F }),
      JSON.stringify({ done: true, from: F, nextFrom: T }),
      JSON.stringify({ pass: "tickets", done: true, from: F, nextFrom: T }),
      JSON.stringify({ pass: [], done: true, from: F, nextFrom: T }),
      JSON.stringify({ pass: { list: "customers", page: 1 }, done: true, from: F, nextFrom: T }),
      JSON.stringify({ pass: { list: "tickets", page: 0 }, done: true, from: F, nextFrom: T }),
      JSON.stringify({ pass: { list: "tickets", page: 1.5 }, done: true, from: F, nextFrom: T }),
      JSON.stringify({ pass: { list: "tickets", page: "5" }, done: true, from: F, nextFrom: T }),
      JSON.stringify({ pass: { list: "tickets" }, done: true, from: F, nextFrom: T }),
    ])
      expect(() => parseRepairShoprCursor(bad), bad).toThrow("RepairShopr checkpoint is not in the expected shape");
  });
});

describe("RepairShopr connector", () => {
  it("passes the shared connector checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(repairShoprDocMock(shop())), expected: { ingested: 6 } });
    expect(result.full.ingested).toBe(6);
  });

  it("imports five years of tickets, estimates and invoices, then stops for good", async () => {
    const mock = repairShoprDocMock(shop());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(6);
    const events = eventsOf(await drain(connector(repairShoprDocMock(shop())).historicalImport({ cursor: null } as never)));
    expect(events.map((e) => [e.type, Object.keys(e.payload)[1]])).toEqual([
      ["repair.ticket_updated", "ticketId"],
      ["repair.ticket_updated", "ticketId"],
      ["repair.estimate_updated", "estimateId"],
      ["repair.estimate_updated", "estimateId"],
      ["repair.invoice_updated", "invoiceId"],
      ["repair.invoice_updated", "invoiceId"],
    ]);
    expect(mock.reads).toEqual([
      { list: "tickets", query: { since_updated_at: "2021-11-11T15:00:00.000Z", page: "1" } },
      { list: "estimates", query: { created_after: "2021-11-11T15:00:00.000Z", page: "1" } },
      { list: "invoices", query: { since_updated_at: "2021-11-11T15:00:00.000Z", page: "1" } },
    ]);
    expect(parseRepairShoprCursor(report.cursor)).toEqual({ pass: null, done: true, from: "2021-11-11T15:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested + again.duplicates).toBe(0);
    expect(mock.reads).toHaveLength(3);
    // Once the import is done, a later sync's pass under way is no reason to import again.
    const later = JSON.stringify({ pass: { list: "estimates", page: 1 }, done: true, from: "2026-11-11T14:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" });
    expect(await drain(connector(mock).historicalImport({ cursor: later } as never))).toEqual([]);
    expect(mock.reads).toHaveLength(3);
  });

  it("makes each page a batch, keeping the list and the next page, and resumes there", async () => {
    repairShoprTicket.reset();
    const data = shop();
    data.tickets = repairShoprTicket.many(27, () => ({ created_at: ago(5), updated_at: ago(4) }));
    const batches = await drain(connector(repairShoprDocMock(data)).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([25, 2, 2, 2]);
    const cursors = batches.map((b) => parseRepairShoprCursor(b.cursor ?? null)!);
    expect(cursors.map((c) => c.pass)).toEqual([{ list: "tickets", page: 2 }, { list: "estimates", page: 1 }, { list: "invoices", page: 1 }, null]);
    expect(cursors.map((c) => c.done)).toEqual([false, false, false, true]);
    // Resumed a day later, the pass goes on from its page, reading from the same time and keeping where the next later sync starts.
    const resumed = repairShoprDocMock(data);
    const rest = await drain(connector(resumed, { now: () => new Date(NOW().getTime() + DAY_MS) }).historicalImport({ cursor: batches[0]!.cursor ?? null } as never));
    expect(rest.map((b) => b.events.length)).toEqual([2, 2, 2]);
    expect(resumed.reads).toEqual([
      { list: "tickets", query: { since_updated_at: "2021-11-11T15:00:00.000Z", page: "2" } },
      { list: "estimates", query: { created_after: "2021-11-11T15:00:00.000Z", page: "1" } },
      { list: "invoices", query: { since_updated_at: "2021-11-11T15:00:00.000Z", page: "1" } },
    ]);
    expect(parseRepairShoprCursor(rest.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, from: cursors[0]!.from, nextFrom: cursors[0]!.nextFrom });
    expect(eventsOf(rest).map((e) => e.receivedAt)).toContain("2026-11-12T15:00:00.000Z");
    expect(new Set(eventsOf(batches).map((e) => e.idempotencyKey)).size).toBe(31);
  });

  it("reads what changed since an hour before the last pass, and the estimates made 60 days before that", async () => {
    const data = shop();
    const mock = repairShoprDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(REPAIRSHOPR_OVERLAP_MS).toBe(3_600_000);
    expect(REPAIRSHOPR_ESTIMATE_LOOKBACK_MS).toBe(60 * DAY_MS);
    // Each mode keeps its own checkpoint, so the first later sync looks back an hour.
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.slice(3)).toEqual([
      { list: "tickets", query: { since_updated_at: "2026-11-11T14:00:00.000Z", page: "1" } },
      { list: "estimates", query: { created_after: "2026-09-12T14:00:00.000Z", page: "1" } },
      { list: "invoices", query: { since_updated_at: "2026-11-11T14:00:00.000Z", page: "1" } },
    ]);
    // Last week's estimate, read again.
    expect(first.ingested).toBe(0);
    expect(first.duplicates).toBe(1);
    expect(parseRepairShoprCursor(first.cursor)).toEqual({ pass: null, done: false, from: "2026-11-11T14:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" });
    // The customer pays for last week's job.
    data.invoices![0]!.verified_paid = true;
    data.invoices![0]!.updated_at = ago(-0.5);
    const later = () => new Date(NOW().getTime() + DAY_MS);
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.at(-1)!.query.since_updated_at).toBe("2026-11-11T14:00:00.000Z");
    expect(sync.ingested).toBe(1);
    expect(parseRepairShoprCursor(sync.cursor)).toEqual({ pass: null, done: false, from: "2026-11-11T14:00:00.000Z", nextFrom: "2026-11-12T14:00:00.000Z" });
    // A later sync resumed mid-pass reads from the same time, keeping what it knew of the import.
    const mid = JSON.stringify({ pass: { list: "estimates", page: 1 }, done: true, from: "2026-11-01T00:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" });
    const resumed = repairShoprDocMock(data);
    const rest = await drain(connector(resumed).incrementalSync({ cursor: mid } as never));
    expect(resumed.reads).toEqual([
      { list: "estimates", query: { created_after: "2026-09-02T00:00:00.000Z", page: "1" } },
      { list: "invoices", query: { since_updated_at: "2026-11-01T00:00:00.000Z", page: "1" } },
    ]);
    expect(rest.map((b) => parseRepairShoprCursor(b.cursor ?? null))).toEqual([
      { pass: { list: "invoices", page: 1 }, done: true, from: "2026-11-01T00:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" },
      { pass: null, done: true, from: "2026-11-01T00:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" },
    ]);
    const midImport = JSON.stringify({ pass: { list: "invoices", page: 1 }, done: false, from: "2026-11-01T00:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" });
    const ended = await drain(connector(repairShoprDocMock(data)).incrementalSync({ cursor: midImport } as never));
    expect(parseRepairShoprCursor(ended.at(-1)!.cursor ?? null)!.done).toBe(false);
    // A later sync after the import ended keeps saying so.
    const doneCursor = JSON.stringify({ pass: null, done: true, from: "2026-01-01T00:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" });
    const after = await drain(connector(repairShoprDocMock(data)).incrementalSync({ cursor: doneCursor } as never));
    expect(parseRepairShoprCursor(after.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, from: "2026-11-01T00:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" });
    // Last week's ticket, estimate and invoice.
    expect(eventsOf(after)).toHaveLength(3);
  });

  it("dead-letters a record that doesn't read and keeps going", async () => {
    const data = shop();
    data.tickets![0]!.id = "seven";
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(repairShoprDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(5);
    expect(report.deadLettered).toBe(1);
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = repairShoprDocMock(shop({ rateLimits: 2 }));
    const slept: number[] = [];
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { sleep: async (ms) => void slept.push(ms) }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(6);
    expect(slept).toEqual([1000, 1000]);
  });

  it("says when RepairShopr turns the token down, reading nothing", async () => {
    const mock = repairShoprDocMock(shop({ token: `${TOKEN}1` }));
    await expect(drain(connector(mock).historicalImport({ cursor: null } as never))).rejects.toThrow("RepairShopr turned down REPAIRSHOPR_API_TOKEN for tickets (HTTP 401)");
    expect(mock.reads).toHaveLength(0);
  });

  it("checks its options", async () => {
    const mock = repairShoprDocMock(shop());
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears }), String(historyYears)).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { subdomain: "ex.ample" })).toThrow("REPAIRSHOPR_SUBDOMAIN");
    expect(() => connector(mock, { subdomain: "x.y", client: {} as RepairShoprClient })).not.toThrow();
    expect(connector(mock).source).toBe("repairshopr");
    const other = repairShoprDocMock(shop({ baseUrl: "https://shop-2.repairshopr.com" }));
    expect(eventsOf(await drain(connector(other, { subdomain: "https://Shop-2.repairshopr.com/" }).historicalImport({ cursor: null } as never)))).toHaveLength(6);
  });

  it("reads back as far as told, and up to now when no clock is given", async () => {
    const mock = repairShoprDocMock(shop());
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(mock.reads[0]!.query.since_updated_at).toBe("2025-11-11T15:00:00.000Z");
    const queries: RepairShoprQuery[] = [];
    const fake: RepairShoprClient = { baseUrl: API, list: async (q) => (queries.push(q), { records: [], more: false }) };
    const before = Date.now();
    const batches = await drain(repairShoprConnector({ apiToken: TOKEN, subdomain: "example", client: fake }).incrementalSync({ cursor: null } as never));
    const after = Date.now();
    const s = Date.parse(queries[0]!.since);
    expect(s).toBeGreaterThanOrEqual(before - REPAIRSHOPR_OVERLAP_MS);
    expect(s).toBeLessThanOrEqual(after - REPAIRSHOPR_OVERLAP_MS);
    expect(Date.parse(queries[1]!.since)).toBe(s - REPAIRSHOPR_ESTIMATE_LOOKBACK_MS);
    const next = Date.parse(parseRepairShoprCursor(batches.at(-1)!.cursor ?? null)!.nextFrom);
    expect(next).toBeGreaterThanOrEqual(before - REPAIRSHOPR_OVERLAP_MS);
    expect(next).toBeLessThanOrEqual(after - REPAIRSHOPR_OVERLAP_MS);
  });

  it("only ever sends GET requests to the three lists it reads, on the one account", async () => {
    const mock = repairShoprDocMock(shop());
    await drain(connector(mock).historicalImport({ cursor: null } as never));
    await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).origin}${new URL(c.url).pathname}`))).toEqual(new Set(REPAIRSHOPR_LISTS.map((l) => `GET ${API}/${l}`)));
  });

  it("declares no writes, and has none to turn down", async () => {
    expect(REPAIRSHOPR_WRITES).toEqual([]);
    const c = connector(repairShoprDocMock(shop()));
    expect(c.writes).toBe(REPAIRSHOPR_WRITES);
    expect(await assertWritesRefused(c)).toEqual([]);
  });
});

describe("RepairShopr doc mock", () => {
  it("checks the token, the time each list is read from and the paging", async () => {
    repairShoprTicket.reset();
    const mock = repairShoprDocMock({ token: TOKEN, tickets: repairShoprTicket.many(30, (n) => ({ updated_at: ago(30 - n) })) });
    const get = async (path: string, auth = `Bearer ${TOKEN}`) => mock.fetch(`https://example.repairshopr.com/api/v1/${path}`, { method: "GET", headers: { authorization: auth } });
    expect((await get("tickets", "Bearer nope")).status).toBe(401);
    expect((await get("customers")).status).toBe(404);
    for (const q of ["page=0", "page=x", "since_updated_at=soon"]) expect((await get(`tickets?${q}`)).status, q).toBe(400);
    const first = (await (await get("tickets")).json()) as { tickets: RepairShoprMockRecord[]; meta: Record<string, number> };
    expect(first.tickets.map((t) => t.id)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(first.meta).toEqual({ total_pages: 2, total_entries: 30, per_page: 25, page: 1 });
    const second = (await (await get("tickets?page=2")).json()) as { tickets: RepairShoprMockRecord[] };
    expect(second.tickets.map((t) => t.id)).toEqual([26, 27, 28, 29, 30]);
    const since = (await (await get(`tickets?since_updated_at=${encodeURIComponent(ago(3))}`)).json()) as { tickets: RepairShoprMockRecord[] };
    expect(since.tickets.map((t) => t.id)).toEqual([27, 28, 29, 30]);
    const none = (await (await get("estimates")).json()) as { estimates: unknown[]; meta: Record<string, number> };
    expect(none).toEqual({ estimates: [], meta: { total_pages: 0, total_entries: 0, per_page: 50, page: 1 } });
    const limited = repairShoprDocMock({ token: TOKEN, rateLimits: 1 });
    const r = await limited.fetch(`https://example.repairshopr.com/api/v1/invoices`, { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("1");
  });
});
