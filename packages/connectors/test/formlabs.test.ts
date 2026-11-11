import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertWritesRefused, checkConnectorSync, formlabsDocMock, formlabsPrint, testPipeline, type FormlabsMock, type FormlabsMockData, type FormlabsMockRecord } from "@karatos/connector-testkit";
import {
  FORMLABS_API,
  FORMLABS_EVENTS,
  FORMLABS_OVERLAP_MS,
  FORMLABS_PAGE_SIZE,
  FORMLABS_WRITES,
  FormlabsApiError,
  FormlabsConfigError,
  formlabsClient,
  formlabsConnector,
  formlabsPrintEvent,
  formlabsRef,
  formlabsTime,
  parseFormlabsCursor,
  type FormlabsClient,
  type FormlabsEvent,
  type FormlabsOptions,
} from "../src/index.js";

// Shaped like a client ID and secret, assembled at runtime so no scanner mistakes the source for a leak.
const ID = ["id", "0".repeat(20)].join("-");
const SECRET = ["s", "0".repeat(40)].join("");
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const DAY_MS = 86_400_000;
const noSleep = async () => {};
const ACCESS = `tok${"a".repeat(30)}`;
const RANGE = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-11T15:00:00.000Z" };

/** An ISO time `days` before NOW, as Formlabs writes it. */
const ago = (days: number) => new Date(NOW().getTime() - days * DAY_MS).toISOString().replace(".000Z", "Z");

/** Runs made 1, 2, 30 and 400 days ago. */
function account(overrides: Partial<FormlabsMockData> = {}): FormlabsMockData {
  formlabsPrint.reset();
  return { clientId: ID, clientSecret: SECRET, prints: [1, 2, 30, 400].map((d) => formlabsPrint.one({ created_at: ago(d) })), ...overrides };
}

const connector = (mock: FormlabsMock, overrides: Partial<FormlabsOptions> = {}) => formlabsConnector({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as FormlabsEvent[];
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
const token = (expires: unknown = 86_400, value: unknown = ACCESS) => json(200, { access_token: value, token_type: "Bearer", expires_in: expires, scope: "developer-api" });
const page = (results: unknown[], next: unknown = null) => json(200, { count: results.length, next, previous: null, results });
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof formlabsClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = formlabsClient({ clientId: ID, clientSecret: SECRET, fetch, sleep: async (ms) => void slept.push(ms), now: NOW, ...extra });
  return { c, slept };
};

describe("Formlabs client", () => {
  it("checks its client ID and secret before sending anything", () => {
    const { fetch, sent } = scripted(token());
    const make = (o: Partial<Parameters<typeof formlabsClient>[0]>) => () => formlabsClient({ clientId: ID, clientSecret: SECRET, fetch, ...o });
    for (const clientId of ["", "   ", "x".repeat(7), "x".repeat(257), "has space", "id:colon", "id/slash", "id&x=1", undefined as never]) expect(make({ clientId }), String(clientId)).toThrow(new FormlabsConfigError("FORMLABS_CLIENT_ID is missing or not in the expected shape"));
    for (const clientSecret of ["", "x".repeat(15), "x".repeat(513), "has a space in it, so no", "tab\tin\tthe\tsecret\there", `${"x".repeat(15)}\x7f`, undefined as never]) expect(make({ clientSecret }), String(clientSecret)).toThrow(new FormlabsConfigError("FORMLABS_CLIENT_SECRET is missing or not in the expected shape"));
    expect(make({ clientId: "x".repeat(8), clientSecret: "!".repeat(16) })).not.toThrow();
    expect(make({ clientId: "Az09._~-".repeat(32), clientSecret: "~".repeat(512) })).not.toThrow();
    expect(sent).toHaveLength(0);
    expect(formlabsClient({ clientId: ID, clientSecret: SECRET }).baseUrl).toBe("https://api.formlabs.com");
    expect(FORMLABS_API).toBe("https://api.formlabs.com");
  });

  it("signs in with the credentials as trimmed, then lists print runs between two times with GET only", async () => {
    const { fetch, sent } = scripted(token(), page([{ guid: "x" }], "https://api.formlabs.com/developer/v1/prints/?page=3"));
    const { c } = client(fetch, { clientId: ` ${ID}\n`, clientSecret: `\t${SECRET} ` });
    expect(await c.prints(RANGE, 2)).toEqual({ records: [{ guid: "x" }], more: true });
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST https://api.formlabs.com/developer/v1/o/token/",
      "GET https://api.formlabs.com/developer/v1/prints/?date__gt=2026-11-01T00%3A00%3A00.000Z&date__lt=2026-11-11T15%3A00%3A00.000Z&page=2&per_page=100",
    ]);
    expect(sent[0]!.headers).toEqual({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" });
    expect(sent[0]!.body).toBe(`grant_type=client_credentials&client_id=${ID}&client_secret=${SECRET}`);
    expect(sent[1]!.headers).toEqual({ authorization: `Bearer ${ACCESS}`, accept: "application/json" });
    expect(sent[1]!.body).toBeUndefined();
    expect(FORMLABS_PAGE_SIZE).toBe(100);
  });

  it("encodes a secret with form characters in it", async () => {
    const secret = `${"a".repeat(14)}&=+%`;
    const { fetch, sent } = scripted(token(), page([]));
    await client(fetch, { clientSecret: secret }).c.prints(RANGE, 1);
    expect(new URLSearchParams(String(sent[0]!.body)).get("client_secret")).toBe(secret);
    expect(String(sent[0]!.body)).not.toContain("&=");
  });

  it("keeps a token until a minute before it runs out, then signs in again", async () => {
    let clock = NOW().getTime();
    const { fetch, sent } = scripted(token(900), page([]), page([]), token(900, `${ACCESS}2`), page([]));
    const { c } = client(fetch, { now: () => new Date(clock) });
    await c.prints(RANGE, 1);
    clock += 839_000;
    await c.prints(RANGE, 1);
    clock += 1000;
    await c.prints(RANGE, 1);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
    expect(sent[4]!.headers.authorization).toBe(`Bearer ${ACCESS}2`);
    // A lifetime that doesn't read, or more than two days, counts as already run out.
    for (const expires of [0, -5, "900", null, 172_801, 60]) {
      const s = scripted(token(expires), page([]), token(expires), page([]));
      const one = client(s.fetch).c;
      await one.prints(RANGE, 1);
      await one.prints(RANGE, 1);
      expect(s.sent.filter((x) => x.method === "POST"), String(expires)).toHaveLength(2);
    }
    const long = scripted(token(172_800), page([]));
    const l = client(long.fetch).c;
    await l.prints(RANGE, 1);
    await l.prints(RANGE, 1);
    expect(long.sent.filter((x) => x.method === "POST")).toHaveLength(1);
  });

  it("signs in again once when a token is turned down early, then gives up", async () => {
    const { fetch, sent } = scripted(token(), json(401, {}), token(86_400, `${ACCESS}2`), page([{ guid: "b" }]));
    expect((await client(fetch).c.prints(RANGE, 1)).records).toHaveLength(1);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
    expect(sent[3]!.headers.authorization).toBe(`Bearer ${ACCESS}2`);
    const twice = scripted(token(), json(401, {}), token(), json(401, { detail: "secret detail" }));
    const err = (await client(twice.fetch).c.prints(RANGE, 1).catch((e: Error) => e)) as FormlabsConfigError;
    expect(err).toBeInstanceOf(FormlabsConfigError);
    expect(err.message).toBe("Formlabs turned down the token for print runs (HTTP 401); check the credentials on the Dashboard's Developer page");
    expect(twice.sent).toHaveLength(4);
    const forbidden = scripted(token(), json(403, {}));
    await expect(client(forbidden.fetch).c.prints(RANGE, 1)).rejects.toThrow("Formlabs turned down the token for print runs (HTTP 403)");
    expect(forbidden.sent).toHaveLength(2);
  });

  it("says when Formlabs turns down the credentials or answers a sign-in oddly, never repeating Formlabs' words", async () => {
    for (const status of [400, 401, 403]) {
      const err = await client(scripted(json(status, { error: "secret detail" })).fetch).c.prints(RANGE, 1).catch((e: Error) => e);
      expect(err).toBeInstanceOf(FormlabsConfigError);
      expect((err as Error).message).toBe(`Formlabs turned down FORMLABS_CLIENT_ID and FORMLABS_CLIENT_SECRET (HTTP ${status}); check the credentials on the Dashboard's Developer page`);
    }
    const err = (await client(scripted(json(404, { error: "secret detail" })).fetch).c.prints(RANGE, 1).catch((e: Error) => e)) as FormlabsApiError;
    expect(err).toBeInstanceOf(FormlabsApiError);
    expect(err.message).toBe("Formlabs sign-in answered HTTP 404");
    expect(err.status).toBe(404);
    expect(err.name).toBe("FormlabsApiError");
    expect(new FormlabsConfigError("x").name).toBe("FormlabsConfigError");
    await expect(client(scripted(json(201, { access_token: ACCESS, expires_in: 900 })).fetch).c.prints(RANGE, 1)).rejects.toThrow("Formlabs sign-in answered HTTP 201");
    for (const answer of [text(200, "not json"), json(200, null), json(200, {}), token(900, 5), token(900, 1.2345678901234568e21), token(900, "short"), token(900, "a".repeat(15)), token(900, `${"a".repeat(20)} b`), token(900, "a".repeat(8193))]) {
      const e = (await client(scripted(answer).fetch).c.prints(RANGE, 1).catch((x: Error) => x)) as FormlabsApiError;
      expect(e.message).toBe("Formlabs sign-in answered without an access token");
      expect(e.status).toBe(200);
    }
    await expect(client(scripted(token(900, "a".repeat(8192)), page([])).fetch).c.prints(RANGE, 1)).resolves.toEqual({ records: [], more: false });
  });

  it("says when a list answers with an error or without its runs", async () => {
    const err = (await client(scripted(token(), json(400, { detail: "secret detail" })).fetch).c.prints(RANGE, 1).catch((e: Error) => e)) as FormlabsApiError;
    expect(err.message).toBe("Formlabs answered HTTP 400 for print runs");
    expect(err.status).toBe(400);
    await expect(client(scripted(token(), json(201, { results: [] })).fetch).c.prints(RANGE, 1)).rejects.toThrow("Formlabs answered HTTP 201 for print runs");
    for (const answer of [text(200, "not json"), json(200, null), json(200, {}), json(200, []), json(200, { results: {} }), json(200, { items: [] })]) {
      const e = (await client(scripted(token(), answer).fetch).c.prints(RANGE, 1).catch((x: Error) => x)) as FormlabsApiError;
      expect(e.message).toBe("Formlabs answered without a list of print runs");
      expect(e.status).toBe(200);
    }
  });

  it("follows next while it says more follow", async () => {
    const more = async (next: unknown) => (await client(scripted(token(), page([], next)).fetch).c.prints(RANGE, 1)).more;
    expect(await more("https://api.formlabs.com/developer/v1/prints/?page=2")).toBe(true);
    for (const next of [null, "", undefined, 2, true]) expect(await more(next), String(next)).toBe(false);
  });

  it("checks what it is asked for before sending", async () => {
    const { fetch, sent } = scripted(token(), page([]));
    const { c } = client(fetch);
    for (const range of [{ from: "2026-11-01", to: RANGE.to }, { from: RANGE.from, to: "soon" }, { from: RANGE.to, to: RANGE.from }, { from: `x${RANGE.from}`, to: RANGE.to }, { from: RANGE.from, to: `${RANGE.to}x` }]) await expect(c.prints(range, 1), JSON.stringify(range)).rejects.toThrow(new FormlabsApiError("print runs are listed between two UTC times", 0));
    for (const p of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) await expect(c.prints(RANGE, p), String(p)).rejects.toThrow(new FormlabsApiError("page must be a whole number, 1 or more", 0));
    expect(sent).toHaveLength(0);
    await expect(c.prints({ from: RANGE.from, to: RANGE.from }, 1)).resolves.toEqual({ records: [], more: false });
  });

  it("waits out rate limits and server errors, honoring Retry-After up to a minute, then gives up", async () => {
    const { fetch, sent } = scripted(token(), json(429, {}, { "retry-after": "5" }), json(503, {}), json(429, {}, { "retry-after": "600" }), page([]));
    const { c, slept } = client(fetch);
    expect(await c.prints(RANGE, 1)).toEqual({ records: [], more: false });
    expect(slept).toEqual([5000, 2000, 60_000]);
    expect(sent).toHaveLength(5);
    for (const status of [500, 502, 504]) {
      const s = scripted(json(status, {}), token(), page([]));
      expect(await client(s.fetch).c.prints(RANGE, 1), String(status)).toEqual({ records: [], more: false });
    }
    const always = scripted(token(), json(500, {}));
    const r = client(always.fetch);
    await expect(r.c.prints(RANGE, 1)).rejects.toThrow("Formlabs answered HTTP 500 for print runs");
    expect(always.sent).toHaveLength(5);
    expect(r.slept).toEqual([1000, 2000, 4000]);
    const odd = client(scripted(token(), json(429, {}, { "retry-after": "soon" }), page([])).fetch);
    await odd.c.prints(RANGE, 1);
    expect(odd.slept).toEqual([1000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    for (const status of [400, 404, 501]) {
      const s = scripted(token(), json(status, {}));
      await client(s.fetch).c.prints(RANGE, 1).catch(() => undefined);
      expect(s.sent, String(status)).toHaveLength(2);
    }
    const s = scripted(token(), json(503, {}));
    await client(s.fetch, { retries: 1 }).c.prints(RANGE, 1).catch(() => undefined);
    expect(s.sent).toHaveLength(3);
  });

  it("waits for real, and uses the global fetch and clock, when none is given", async () => {
    const real = globalThis.fetch;
    const s = scripted(token(), json(503, {}), page([]), page([]));
    globalThis.fetch = s.fetch;
    try {
      const c = formlabsClient({ clientId: ID, clientSecret: SECRET });
      const started = Date.now();
      await c.prints(RANGE, 1);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      await c.prints(RANGE, 1);
    } finally {
      globalThis.fetch = real;
    }
    expect(s.sent.filter((x) => x.method === "POST")).toHaveLength(1);
  });
});

describe("Formlabs reading helpers", () => {
  it("reads Formlabs' times as UTC", () => {
    expect(formlabsTime("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000Z");
    expect(formlabsTime("2026-01-02T03:04:05.123456+02:00")).toBe("2026-01-02T01:04:05.123Z");
    expect(formlabsTime("2026-01-02T23:59:59-05:00")).toBe("2026-01-03T04:59:59.000Z");
    for (const bad of ["2026-02-30T00:00:00Z", "2026-01-02T24:00:00Z", "2026-01-02T12:60:00Z", "2026-01-02T03:04:05", "2026-01-02", "2026-01-02 03:04:05Z", "2026-01-02T03:04:05.1234567Z", "2026-01-02T03:04:05+0200", "x2026-01-02T03:04:05Z", "2026-01-02T03:04:05Zx", " 2026-01-02T03:04:05Z", "", null, 5]) expect(formlabsTime(bad), String(bad)).toBeUndefined();
  });

  it("makes references", () => {
    expect(formlabsRef("print", "abc")).toBe("formlabs:print:abc");
  });
});

describe("Formlabs events", () => {
  const ctx = { receivedAt: RECEIVED };
  const one = (o: FormlabsMockRecord = {}) => {
    formlabsPrint.reset();
    return formlabsPrint.one(o);
  };

  it("names its event type", () => {
    expect(FORMLABS_EVENTS).toEqual({ print: "manufacturing.print_updated" });
  });

  it("keeps a run's printer, status, resin, layers and times, and nothing about who or what it was for", () => {
    const e = formlabsPrintEvent(one(), ctx);
    expect(e.type).toBe("manufacturing.print_updated");
    expect(e.occurredAt).toBe("2026-10-02T00:00:00.000Z");
    expect(e.receivedAt).toBe(RECEIVED);
    expect(e.payload).toStrictEqual({
      system: "Formlabs",
      printRunId: "formlabs:print:00000000-0000-4000-8000-000000000001",
      printerId: "formlabs:printer:Form4-TestPrinter",
      printerGroup: "Wax room",
      status: "finished",
      success: "success",
      material: "FLCWAX01",
      materialName: "Castable Wax 40",
      volumeMl: 3.2,
      layerCount: 420,
      layerThicknessMm: 0.025,
      partCount: 1,
      estimatedDurationMs: 10_800_000,
      elapsedDurationMs: 10_750_000,
      createdAt: "2026-10-02T00:00:00.000Z",
      startedAt: "2026-10-02T01:00:00.000Z",
      finishedAt: "2026-10-02T04:00:00.000Z",
    });
    const all = JSON.stringify(e);
    for (const hidden of ["Test Customer", "Customer", "Friday", "example.test", "Test Tech", "ring.stl"]) expect(all, hidden).not.toContain(hidden);
    const odd = formlabsPrintEvent(one({ status: "MELTING", print_run_success: { print_run_success: "MAYBE" }, printer: ` ${"P".repeat(70)} `, group: null, material: "M".repeat(50), material_name: "  ", volume_ml: -1, layer_count: 1.5, layer_thickness_mm: Number.POSITIVE_INFINITY, parts: "x", estimated_duration_ms: -1, elapsed_duration_ms: "5", print_started_at: null, print_finished_at: "soon" }), ctx).payload;
    expect(odd).toMatchObject({ status: "unknown", success: "unknown", printerId: `formlabs:printer:${"P".repeat(60)}`, printerGroup: null, material: "M".repeat(40), materialName: null, volumeMl: null, layerCount: null, layerThicknessMm: null, partCount: null, estimatedDurationMs: null, elapsedDurationMs: null, startedAt: null, finishedAt: null });
    const none = formlabsPrintEvent(one({ status: 5, print_run_success: null, printer: null, group: { name: "G".repeat(50) }, volume_ml: 0, layer_count: 0, layer_thickness_mm: "0.05", parts: [], material_name: "N".repeat(70), estimated_duration_ms: 0 }), ctx).payload;
    expect(none).toMatchObject({ status: null, success: null, printerId: null, printerGroup: "G".repeat(40), volumeMl: 0, layerCount: 0, layerThicknessMm: null, partCount: 0, materialName: "N".repeat(60), estimatedDurationMs: 0 });
    const words = ["QUEUED", "PREPRINT", "PRINTING", "PAUSED", "PAUSING", "FINISHED", "ABORTING", "ABORTED", "ERROR", "WAITING_FOR_RESOLUTION", "PREHEAT", "PRECOAT", "POSTCOAT"];
    for (const w of words) expect(formlabsPrintEvent(one({ status: w }), ctx).payload.status).toBe(w.toLowerCase());
    expect(formlabsPrintEvent(one({ status: "finished" }), ctx).payload.status).toBe("unknown");
    for (const w of ["UNKNOWN", "SUCCESS", "FAILURE"]) expect(formlabsPrintEvent(one({ print_run_success: { print_run_success: w } }), ctx).payload.success).toBe(w.toLowerCase());
  });

  it("keys each version by what was kept, so an unchanged one is a duplicate and a finished one is new", () => {
    const a = formlabsPrintEvent(one({ status: "PRINTING", print_finished_at: null }), ctx);
    expect(a.idempotencyKey).toMatch(/^formlabs:print:00000000-0000-4000-8000-000000000001:[0-9a-f]{12}$/);
    expect(a.id).toBe(a.idempotencyKey.replace(/:/g, "_"));
    expect(formlabsPrintEvent(one({ status: "PRINTING", print_finished_at: null }), { receivedAt: "2027-01-01T00:00:00.000Z" }).idempotencyKey).toBe(a.idempotencyKey);
    expect(formlabsPrintEvent(one({ status: "PRINTING", print_finished_at: null, name: "Other", note: null, currently_printing_layer: 9 }), ctx).idempotencyKey).toBe(a.idempotencyKey);
    expect(formlabsPrintEvent(one(), ctx).idempotencyKey).not.toBe(a.idempotencyKey);
    expect(formlabsPrintEvent(one({ status: "PRINTING", print_finished_at: null, guid: "00000000-0000-4000-8000-00000000000A".toUpperCase() }), ctx).idempotencyKey).toMatch(/^formlabs:print:00000000-0000-4000-8000-00000000000a:/);
  });

  it("dead-letters a run that doesn't read, listing why", () => {
    const e = formlabsPrintEvent({ guid: "not-a-guid", created_at: "soon" }, ctx);
    expect(e.occurredAt).toBeUndefined();
    expect(e.type).toBe("manufacturing.print_updated");
    expect(e.payload).toEqual({ system: "Formlabs", printRunId: null, problems: ["print run has no ID that reads", "print run has no time that reads"] });
    expect(e.idempotencyKey).toMatch(/^formlabs:unreadable_print:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    expect(formlabsPrintEvent({ guid: "not-a-guid2", created_at: "soon" }, ctx).idempotencyKey).not.toBe(e.idempotencyKey);
    const t = formlabsPrintEvent({ guid: "00000000-0000-4000-8000-000000000009" }, ctx);
    expect(t.payload).toEqual({ system: "Formlabs", printRunId: "formlabs:print:00000000-0000-4000-8000-000000000009", problems: ["print run has no time that reads"] });
    const i = formlabsPrintEvent({ guid: 5, created_at: "2026-01-01T00:00:00Z" }, ctx);
    expect(i.payload.problems).toEqual(["print run has no ID that reads"]);
    expect(i.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    for (const g of ["00000000-0000-4000-8000-0000000000001", "x00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-00000000000g", "00000000000040008000000000000001"]) expect(formlabsPrintEvent({ guid: g, created_at: "2026-01-01T00:00:00Z" }, ctx).payload.problems, g).toEqual(["print run has no ID that reads"]);
    for (const raw of [null, "x", []]) expect(formlabsPrintEvent(raw, ctx).payload.problems, JSON.stringify(raw)).toHaveLength(2);
  });
});

describe("Formlabs checkpoint", () => {
  const F = "2025-11-11T15:00:00.000Z";
  const T = "2026-11-11T15:00:00.000Z";
  const N = "2026-11-08T15:00:00.000Z";
  it("reads a checkpoint it wrote, and turns down anything else", () => {
    expect(parseFormlabsCursor(null)).toBeNull();
    const pass = { from: F, to: T, page: 3 };
    expect(parseFormlabsCursor(JSON.stringify({ pass, done: true, nextFrom: N }))).toEqual({ pass, done: true, nextFrom: N });
    expect(parseFormlabsCursor(JSON.stringify({ pass: null, done: false, nextFrom: N }))).toEqual({ pass: null, done: false, nextFrom: N });
    expect(parseFormlabsCursor(JSON.stringify({ pass: { from: T, to: T, page: 1 }, done: false, nextFrom: N }))!.pass).toEqual({ from: T, to: T, page: 1 });
    const bad = [
      "",
      "not json",
      "null",
      "[]",
      JSON.stringify({ pass: null, nextFrom: N }),
      JSON.stringify({ pass: null, done: "true", nextFrom: N }),
      JSON.stringify({ pass: null, done: false }),
      JSON.stringify({ pass: null, done: false, nextFrom: "2026-11-08" }),
      JSON.stringify({ done: false, nextFrom: N }),
      JSON.stringify({ pass: {}, done: false, nextFrom: N }),
      JSON.stringify({ pass: { ...pass, from: "2025-11-11" }, done: false, nextFrom: N }),
      JSON.stringify({ pass: { ...pass, to: "soon" }, done: false, nextFrom: N }),
      JSON.stringify({ pass: { ...pass, from: T, to: F }, done: false, nextFrom: N }),
      JSON.stringify({ pass: { ...pass, page: 0 }, done: false, nextFrom: N }),
      JSON.stringify({ pass: { ...pass, page: 1.5 }, done: false, nextFrom: N }),
      JSON.stringify({ pass: { ...pass, page: "3" }, done: false, nextFrom: N }),
    ];
    for (const raw of bad) expect(() => parseFormlabsCursor(raw), raw).toThrow("Formlabs checkpoint is not in the expected shape");
  });
});

describe("Formlabs connector", () => {
  it("passes the shared connector checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(formlabsDocMock(account())), expected: { ingested: 3 } });
    expect(result.full.ingested).toBe(3);
  });

  it("imports a year of print runs, then stops for good", async () => {
    const mock = formlabsDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(3);
    expect(mock.reads[0]).toEqual({ date__gt: "2025-11-11T15:00:00.000Z", date__lt: "2026-11-11T15:00:00.000Z", page: "1", per_page: "100" });
    expect(parseFormlabsCursor(report.cursor)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08T15:00:00.000Z" });
    expect(FORMLABS_OVERLAP_MS).toBe(3 * DAY_MS);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(1);
    // As far back as told.
    const deep = formlabsDocMock(account());
    await drain(connector(deep, { historyYears: 2 }).historicalImport({ cursor: null } as never));
    expect(deep.reads[0]!.date__gt).toBe("2024-11-11T15:00:00.000Z");
    expect(() => connector(deep, { historyYears: 0 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(deep, { historyYears: 1.5 })).toThrow("historyYears must be a positive whole number");
  });

  it("makes each page one batch, keeping the pass's times and next page, and resumes there", async () => {
    const pages: number[] = [];
    const ranges: string[] = [];
    let n = 0;
    const fake: FormlabsClient = {
      baseUrl: FORMLABS_API,
      prints: async (range, p) => (pages.push(p), ranges.push(`${range.from}/${range.to}`), { records: [formlabsPrint.one({ created_at: ago(++n) })], more: p < 3 }),
    };
    formlabsPrint.reset();
    const all = await drain(formlabsConnector({ clientId: ID, clientSecret: SECRET, client: fake, now: NOW }).historicalImport({ cursor: null } as never));
    expect(pages).toEqual([1, 2, 3]);
    expect(new Set(ranges)).toEqual(new Set(["2025-11-11T15:00:00.000Z/2026-11-11T15:00:00.000Z"]));
    expect(all.map((b) => parseFormlabsCursor(b.cursor ?? null))).toEqual([
      { pass: { from: "2025-11-11T15:00:00.000Z", to: "2026-11-11T15:00:00.000Z", page: 2 }, done: false, nextFrom: "2026-11-08T15:00:00.000Z" },
      { pass: { from: "2025-11-11T15:00:00.000Z", to: "2026-11-11T15:00:00.000Z", page: 3 }, done: false, nextFrom: "2026-11-08T15:00:00.000Z" },
      { pass: null, done: true, nextFrom: "2026-11-08T15:00:00.000Z" },
    ]);
    expect(eventsOf(all).every((e) => e.receivedAt === RECEIVED)).toBe(true);
    pages.length = 0;
    ranges.length = 0;
    const resume = JSON.stringify({ pass: { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", page: 3 }, done: false, nextFrom: "2026-01-29T00:00:00.000Z" });
    const rest = await drain(formlabsConnector({ clientId: ID, clientSecret: SECRET, client: fake, now: NOW }).historicalImport({ cursor: resume } as never));
    expect(pages).toEqual([3]);
    expect(ranges).toEqual(["2026-01-01T00:00:00.000Z/2026-02-01T00:00:00.000Z"]);
    expect(rest.map((b) => parseFormlabsCursor(b.cursor ?? null))).toEqual([{ pass: null, done: true, nextFrom: "2026-01-29T00:00:00.000Z" }]);
    // Once done, the import reads nothing, even with a later sync's pass under way.
    pages.length = 0;
    expect(await drain(formlabsConnector({ clientId: ID, clientSecret: SECRET, client: fake, now: NOW }).historicalImport({ cursor: JSON.stringify({ pass: { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", page: 1 }, done: true, nextFrom: "2026-01-29T00:00:00.000Z" }) } as never))).toEqual([]);
    expect(pages).toEqual([]);
  });

  it("pages through the mock newest first", async () => {
    formlabsPrint.reset();
    const prints = Array.from({ length: 205 }, (_, i) => formlabsPrint.one({ created_at: ago(1 + i / 10) }));
    const mock = formlabsDocMock({ clientId: ID, clientSecret: SECRET, prints });
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([100, 100, 5]);
    expect(new Set(eventsOf(batches).map((e) => e.payload.printRunId)).size).toBe(205);
    expect(mock.signIns).toBe(1);
  });

  it("lists the runs made from three days before the last pass ended on each later sync, reading a finished one again", async () => {
    const data = account();
    data.prints![0]!.status = "PRINTING";
    const mock = formlabsDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // Each mode keeps its own checkpoint, so the first later sync looks back three days.
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads[1]).toMatchObject({ date__gt: "2026-11-08T15:00:00.000Z", date__lt: "2026-11-11T15:00:00.000Z" });
    expect(first.ingested).toBe(0);
    expect(first.duplicates).toBe(2);
    expect(parseFormlabsCursor(first.cursor)).toEqual({ pass: null, done: false, nextFrom: "2026-11-08T15:00:00.000Z" });
    data.prints![0]!.status = "FINISHED";
    const later = () => new Date(NOW().getTime() + DAY_MS);
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.at(-1)).toMatchObject({ date__gt: "2026-11-08T15:00:00.000Z", date__lt: "2026-11-12T15:00:00.000Z" });
    expect(sync.ingested).toBe(1);
    expect(parseFormlabsCursor(sync.cursor)).toEqual({ pass: null, done: false, nextFrom: "2026-11-09T15:00:00.000Z" });
    // A later sync resumed mid-pass keeps its times and what it knew of the import.
    const pages: number[] = [];
    const fake: FormlabsClient = { baseUrl: FORMLABS_API, prints: async (range, p) => (pages.push(p), { records: [], more: p < 3 }) };
    const mid = JSON.stringify({ pass: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z", page: 2 }, done: true, nextFrom: "2026-11-07T00:00:00.000Z" });
    const rest = await drain(formlabsConnector({ clientId: ID, clientSecret: SECRET, client: fake, now: NOW }).incrementalSync({ cursor: mid } as never));
    expect(pages).toEqual([2, 3]);
    expect(rest.map((b) => parseFormlabsCursor(b.cursor ?? null))).toEqual([
      { pass: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z", page: 3 }, done: true, nextFrom: "2026-11-07T00:00:00.000Z" },
      { pass: null, done: true, nextFrom: "2026-11-07T00:00:00.000Z" },
    ]);
    const midImport = JSON.stringify({ pass: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z", page: 3 }, done: false, nextFrom: "2026-11-07T00:00:00.000Z" });
    expect(parseFormlabsCursor((await drain(formlabsConnector({ clientId: ID, clientSecret: SECRET, client: fake, now: NOW }).incrementalSync({ cursor: midImport } as never))).at(-1)!.cursor ?? null)!.done).toBe(false);
    // A later sync after the import ended keeps saying so.
    const doneCursor = JSON.stringify({ pass: null, done: true, nextFrom: "2026-11-01T00:00:00.000Z" });
    const after = formlabsDocMock(account());
    const out = await drain(connector(after).incrementalSync({ cursor: doneCursor } as never));
    expect(after.reads[0]).toMatchObject({ date__gt: "2026-11-01T00:00:00.000Z", date__lt: "2026-11-11T15:00:00.000Z" });
    expect(parseFormlabsCursor(out.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08T15:00:00.000Z" });
    expect(eventsOf(out)).toHaveLength(2);
  });

  it("dead-letters a run that doesn't read and keeps going", async () => {
    formlabsPrint.reset();
    const runs = [formlabsPrint.one({ created_at: ago(1) }), formlabsPrint.one({ guid: "nope", created_at: "soon" }), formlabsPrint.one({ created_at: null }), formlabsPrint.one({ created_at: ago(3) })];
    const fake: FormlabsClient = { baseUrl: FORMLABS_API, prints: async () => ({ records: runs, more: false }) };
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: formlabsConnector({ clientId: ID, clientSecret: SECRET, client: fake, now: NOW }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.deadLettered).toBe(2);
    expect(report.ingested).toBe(2);
  });

  it("waits out a rate limit inside a sync, and signs in again when a token is turned down", async () => {
    const mock = formlabsDocMock(account({ rateLimits: 2, expireTokens: 1 }));
    const slept: number[] = [];
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { sleep: async (ms) => void slept.push(ms) }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(3);
    expect(slept).toEqual([1000, 1000]);
    expect(mock.signIns).toBe(2);
  });

  it("says when Formlabs turns the credentials down, reading nothing", async () => {
    const wrongId = formlabsDocMock(account({ clientId: ["other", "0".repeat(10)].join("-") }));
    await expect(drain(connector(wrongId).historicalImport({ cursor: null } as never))).rejects.toThrow("(HTTP 401)");
    const wrongSecret = formlabsDocMock(account({ clientSecret: ["o", "1".repeat(31)].join("") }));
    await expect(drain(connector(wrongSecret).historicalImport({ cursor: null } as never))).rejects.toThrow("(HTTP 400)");
    expect(wrongSecret.reads).toHaveLength(0);
  });

  it("counts a token's lifetime on the connector's clock", async () => {
    let clock = NOW().getTime();
    const mock = formlabsDocMock(account());
    const c = connector(mock, { now: () => new Date(clock) });
    await drain(c.historicalImport({ cursor: null } as never));
    clock += 2 * DAY_MS;
    await drain(c.incrementalSync({ cursor: null } as never));
    expect(mock.signIns).toBe(2);
  });

  it("reads up to now when no clock is given", async () => {
    const mock = formlabsDocMock(account());
    const before = Date.now();
    await drain(formlabsConnector({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch, sleep: noSleep }).historicalImport({ cursor: null } as never));
    const to = Date.parse(mock.reads[0]!.date__lt!);
    expect(to).toBeGreaterThanOrEqual(before);
    expect(to).toBeLessThanOrEqual(Date.now());
  });

  it("only ever asks for a token and lists print runs", async () => {
    const mock = formlabsDocMock(account());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`))).toEqual(new Set(["POST /developer/v1/o/token/", "GET /developer/v1/prints/"]));
  });

  it("declares no writes", async () => {
    const c = connector(formlabsDocMock(account()));
    expect(FORMLABS_WRITES).toEqual([]);
    expect(c.writes).toBe(FORMLABS_WRITES);
    expect(c.source).toBe("formlabs");
    expect(await assertWritesRefused(c)).toEqual([]);
  });
});

describe("Formlabs doc mock", () => {
  it("checks the credentials, the token, the times and the paging", async () => {
    const mock = formlabsDocMock(account());
    const sign = (form: Record<string, string>, type = "application/x-www-form-urlencoded") => mock.fetch(`${FORMLABS_API}/developer/v1/o/token/`, { method: "POST", headers: { "content-type": type }, body: new URLSearchParams(form).toString() });
    expect((await sign({ grant_type: "password", client_id: ID, client_secret: SECRET })).status).toBe(400);
    expect((await sign({ grant_type: "client_credentials", client_id: ID, client_secret: SECRET }, "application/json")).status).toBe(400);
    expect((await sign({ grant_type: "client_credentials", client_id: "x", client_secret: SECRET })).status).toBe(401);
    expect((await sign({ grant_type: "client_credentials", client_id: ID, client_secret: "x" })).status).toBe(400);
    const ok = (await (await sign({ grant_type: "client_credentials", client_id: ID, client_secret: SECRET })).json()) as { access_token: string; expires_in: number };
    expect(ok.expires_in).toBe(86_400);
    const list = (q: string, auth = `Bearer ${ok.access_token}`) => mock.fetch(`${FORMLABS_API}/developer/v1/prints/?${q}`, { headers: { authorization: auth } });
    expect((await list("", "Bearer nope")).status).toBe(401);
    expect((await mock.fetch(`${FORMLABS_API}/developer/v1/prints/`)).status).toBe(401);
    expect((await list("page=0")).status).toBe(404);
    expect((await list("per_page=101")).status).toBe(404);
    expect((await list("date__gt=soon")).status).toBe(400);
    expect((await list("date__lt=soon")).status).toBe(400);
    const all = (await (await list("")).json()) as { count: number; results: { created_at: string }[]; next: unknown; previous: unknown };
    expect(all.count).toBe(4);
    expect(all.results.map((r) => r.created_at)).toEqual([ago(1), ago(2), ago(30), ago(400)]);
    expect([all.next, all.previous]).toEqual([null, null]);
    const two = (await (await list("per_page=1&page=2")).json()) as { next: string; previous: string; results: unknown[] };
    expect(two).toMatchObject({ next: `${FORMLABS_API}/developer/v1/prints/?page=3`, previous: `${FORMLABS_API}/developer/v1/prints/?page=1` });
    expect(two.results).toHaveLength(1);
    // Strictly after and before.
    expect(((await (await list(`date__gt=${ago(2)}&date__lt=${ago(1)}`)).json()) as { count: number }).count).toBe(0);
    expect(await (await formlabsDocMock({ clientId: ID, clientSecret: SECRET }).fetch(`${FORMLABS_API}/developer/v1/o/token/`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=client_credentials&client_id=${ID}&client_secret=${SECRET}` })).json()).toMatchObject({ token_type: "Bearer", scope: "developer-api" });
    await expect(mock.fetch(`${FORMLABS_API}/developer/v1/groups/`, { method: "POST" })).rejects.toThrow("not in the vendor's docs");
  });

  it("lists no runs for an account that has none", async () => {
    const empty = formlabsDocMock({ clientId: ID, clientSecret: SECRET });
    expect(await drain(connector(empty).historicalImport({ cursor: null } as never))).toEqual([{ events: [], cursor: JSON.stringify({ pass: null, done: true, nextFrom: "2026-11-08T15:00:00.000Z" }) }]);
  });
});
