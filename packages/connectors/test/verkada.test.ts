import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import {
  TEST_ORG,
  VERKADA_BASE,
  VERKADA_DOC_PAGES,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  testPipeline,
  verkadaCamera,
  verkadaDocMock,
  type VerkadaMock,
  type VerkadaMockData,
} from "@karatos/connector-testkit";
import {
  VERKADA_FIRST_LOOKBACK_S,
  VERKADA_MAX_LINES,
  VERKADA_OVERLAP_S,
  VERKADA_REGIONS,
  VERKADA_SPACING_MS,
  VERKADA_TOKEN_MS,
  VERKADA_TRAFFIC_EVENT,
  VERKADA_WINDOW_S,
  VERKADA_WRITES,
  VerkadaApiError,
  VerkadaConfigError,
  parseVerkadaCursor,
  verkadaClient,
  verkadaConnector,
  verkadaTrafficEvents,
  type VerkadaClient,
  type VerkadaCursor,
  type VerkadaEvent,
  type VerkadaOptions,
} from "../src/index.js";

// A key-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const API_KEY = ["test", "k".repeat(28)].join("_");
const NOW_MS = Date.parse("2026-11-11T15:30:00.000Z");
const NOW = () => new Date(NOW_MS);
const RECEIVED = "2026-11-11T15:30:00.000Z";
const H = 3600;
const DAY = 24 * H;
/** The last whole hour before NOW, in Unix seconds. */
const TO = Date.parse("2026-11-11T15:00:00.000Z") / 1000;
const YEAR_AGO = Date.parse("2025-11-11T15:00:00.000Z") / 1000;
const TWO_YEARS_AGO = Date.parse("2024-11-11T15:00:00.000Z") / 1000;
const noSleep = async () => {};
const iso = (s: number) => new Date(s * 1000).toISOString();

/** Two cameras, the second counting across two lines, with people only in the last two hours before TO. */
function org(overrides: Partial<VerkadaMockData> = {}): VerkadaMockData {
  const second = { ...verkadaCamera(2), preset_ids: ["line-test-2", "line-test-2b"] };
  return { apiKey: API_KEY, cameras: [verkadaCamera(1), second], count: (_c, _p, start) => (start >= TO - 2 * H ? [5, 4] : null), ...overrides };
}

const connector = (mock: VerkadaMock, overrides: Partial<VerkadaOptions> = {}) => verkadaConnector({ apiKey: API_KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as VerkadaEvent[];

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
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
const text = (status: number, body: string) => () => new Response(body, { status });
const TOKEN = json(200, { token: "tok-1" });
const CAMERAS = json(200, { cameras: [] });
/** A client whose clock stands still unless a test moves it. */
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof verkadaClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = verkadaClient({ apiKey: API_KEY, fetch, sleep: async (ms) => void slept.push(ms), clock: () => 1e9, ...extra });
  return { c, slept };
};
const ctx = { receivedAt: RECEIVED };

describe("Verkada client", () => {
  it("checks its key and region before sending anything", () => {
    const { fetch, sent } = scripted(TOKEN);
    for (const apiKey of ["", "a".repeat(19), "a".repeat(201), `${"a".repeat(20)} x`, `${"a".repeat(20)}.`]) {
      expect(() => verkadaClient({ apiKey, fetch }), apiKey).toThrow("VERKADA_API_KEY is missing or not in the expected shape");
    }
    expect(() => verkadaClient({} as never)).toThrow(VerkadaConfigError);
    expect(() => verkadaClient({ apiKey: ` ${"aZ9_-".repeat(40)} `, fetch })).not.toThrow();
    for (const region of ["", "uk", "us-east"]) expect(() => verkadaClient({ apiKey: API_KEY, region, fetch }), region).toThrow("VERKADA_REGION must be us or eu");
    for (const region of ["us", " EU ", "eu"]) expect(() => verkadaClient({ apiKey: API_KEY, region, fetch })).not.toThrow();
    expect(sent).toHaveLength(0);
    expect([...VERKADA_REGIONS]).toEqual([
      ["us", "https://api.verkada.com"],
      ["eu", "https://api.eu.verkada.com"],
    ]);
  });

  it("trades the key for a token, then reads the cameras and counts with it", async () => {
    const counts = { camera_id: "cam-1", trend_in: [], trend_out: [] };
    const { fetch, sent } = scripted(TOKEN, json(200, { cameras: [{ camera_id: "cam-1", preset_ids: ["p-1", "p-2"] }] }), json(200, counts));
    const { c } = client(fetch, { apiKey: ` ${API_KEY} ` });
    expect(await c.cameras()).toEqual([{ cameraId: "cam-1", presetIds: ["p-1", "p-2"] }]);
    expect(await c.trends("cam-1", "p-2", 7200, 10_800)).toEqual(counts);
    const read = { "x-verkada-auth": "tok-1", accept: "application/json" };
    expect(sent).toEqual([
      { url: "https://api.verkada.com/token", method: "POST", headers: { "x-api-key": API_KEY, accept: "application/json" } },
      { url: "https://api.verkada.com/cameras/v1/occupancy_trend_enabled", method: "GET", headers: read },
      { url: "https://api.verkada.com/cameras/v1/analytics/occupancy_trends?camera_id=cam-1&preset_id=p-2&start_time=7200&end_time=10800&interval=1_hour&type=person", method: "GET", headers: read },
    ]);
  });

  it("goes to the EU address when told", async () => {
    const { fetch, sent } = scripted(TOKEN, CAMERAS);
    await client(fetch, { region: "eu" }).c.cameras();
    expect(sent.map((s) => s.url)).toEqual(["https://api.eu.verkada.com/token", "https://api.eu.verkada.com/cameras/v1/occupancy_trend_enabled"]);
  });

  it("keeps a token until five minutes before it lapses", async () => {
    let t = 1e9;
    const { fetch, sent } = scripted(TOKEN, CAMERAS, CAMERAS, json(200, { token: "tok-2" }), CAMERAS);
    const { c } = client(fetch, { clock: () => t });
    await c.cameras();
    t += VERKADA_TOKEN_MS - 5 * 60_000 - 1;
    await c.cameras();
    t += 1;
    await c.cameras();
    expect(sent.map((s) => s.method + " " + (s.headers["x-verkada-auth"] ?? "token"))).toEqual(["POST token", "GET tok-1", "GET tok-1", "POST token", "GET tok-2"]);
    expect(VERKADA_TOKEN_MS).toBe(30 * 60_000);
  });

  it("signs in again once when a token is turned down, then gives up", async () => {
    const { fetch, sent } = scripted(TOKEN, json(401, {}), json(200, { token: "tok-2" }), CAMERAS);
    expect(await client(fetch).c.cameras()).toEqual([]);
    expect(sent.map((s) => s.headers["x-verkada-auth"] ?? "token")).toEqual(["token", "tok-1", "token", "tok-2"]);
    const { fetch: f2, sent: s2 } = scripted(TOKEN, json(401, {}), json(200, { token: "tok-2" }), json(401, {}));
    await expect(client(f2).c.cameras()).rejects.toThrow(new VerkadaConfigError("Verkada turned down the token VERKADA_API_KEY was traded for: check the key hasn't expired"));
    expect(s2).toHaveLength(4);
  });

  it("explains a key that's turned down, or can't see the cameras, and reports other errors", async () => {
    for (const status of [400, 401, 403]) {
      await expect(client(scripted(json(status, {})).fetch).c.cameras()).rejects.toThrow(new VerkadaConfigError("Verkada turned down VERKADA_API_KEY: check it, that it hasn't expired, and VERKADA_REGION"));
    }
    for (const status of [206, 404, 501]) await expect(client(scripted(json(status, {})).fetch).c.cameras()).rejects.toMatchObject({ message: `Verkada answered HTTP ${status} for a token`, status });
    for (const body of [{}, { token: 5 }, { token: "a b" }, { token: "" }, { token: "x".repeat(4097) }]) {
      await expect(client(scripted(json(200, body)).fetch).c.cameras(), JSON.stringify(body)).rejects.toMatchObject({ message: "Verkada answered without a token", status: 200 });
    }
    await expect(client(scripted(text(200, "<html>")).fetch).c.cameras()).rejects.toThrow("Verkada answered without a token");
    expect(await client(scripted(json(200, { token: "x".repeat(4096) }), CAMERAS).fetch).c.cameras()).toEqual([]);
    await expect(client(scripted(TOKEN, json(403, {})).fetch).c.trends("cam-1", "p-1", 0, H)).rejects.toThrow(new VerkadaConfigError("VERKADA_API_KEY can't read the people counts: check that Occupancy Trends is on for these cameras and the key can see them"));
    for (const status of [206, 400, 404]) {
      const { fetch, sent } = scripted(TOKEN, json(status, {}));
      const error = await client(fetch).c.cameras().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VerkadaApiError);
      expect(error).toMatchObject({ message: `Verkada answered HTTP ${status} for the cameras`, status });
      expect(sent).toHaveLength(2);
    }
  });

  it("says when an answer isn't an object, or the cameras aren't a list, and skips cameras and lines that don't read", async () => {
    for (const body of [null, [], "x", 5]) await expect(client(scripted(TOKEN, json(200, body)).fetch).c.cameras(), JSON.stringify(body)).rejects.toMatchObject({ message: "Verkada answered the cameras with something other than an object", status: 200 });
    await expect(client(scripted(TOKEN, text(200, "<html>")).fetch).c.trends("c", "p", 0, H)).rejects.toThrow("Verkada answered the people counts with something other than an object");
    for (const body of [{}, { cameras: {} }]) await expect(client(scripted(TOKEN, json(200, body)).fetch).c.cameras()).rejects.toMatchObject({ message: "Verkada answered the cameras without a list", status: 200 });
    const cameras = [
      { camera_id: "ok-1", preset_ids: ["p-1", "p 2", 3, "", "x".repeat(65), "x".repeat(64)] },
      { camera_id: "no-lines", preset_ids: [] },
      { camera_id: "bad lines", preset_ids: ["p-1"] },
      { camera_id: "x".repeat(65), preset_ids: ["p-1"] },
      { camera_id: 7, preset_ids: ["p-1"] },
      { camera_id: "no-list", preset_ids: "p-1" },
      null,
      { camera_id: "ok_2", preset_ids: ["P_9"] },
    ];
    expect(await client(scripted(TOKEN, json(200, { cameras })).fetch).c.cameras()).toEqual([
      { cameraId: "ok-1", presetIds: ["p-1", "x".repeat(64)] },
      { cameraId: "ok_2", presetIds: ["P_9"] },
    ]);
  });

  it("asks only for plain ids and a range of whole seconds that ends after it starts", async () => {
    const { fetch, sent } = scripted(TOKEN);
    const { c } = client(fetch);
    for (const [cam, preset] of [["a b", "p"], ["c", "p&x=1"], ["", "p"], ["c", ""]]) await expect(c.trends(cam!, preset!, 0, H)).rejects.toMatchObject({ message: "a camera and preset must be plain ids", status: 0 });
    for (const [start, end] of [[H, H], [2 * H, H], [-1, H], [0.5, H], [0, 1.5], [Number.NaN, H]]) await expect(c.trends("c", "p", start!, end!), `${start} ${end}`).rejects.toMatchObject({ message: "a range must be whole seconds, ending after it starts", status: 0 });
    expect(sent).toHaveLength(0);
  });

  it("waits out a 429 or 5xx 5, 10 and 20 seconds, then gives up, and retries as many times as told", async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const { fetch, sent } = scripted(json(status, {}));
      const { c, slept } = client(fetch, { clock: () => 1e12 + 1e6 * sent.length });
      await expect(c.cameras()).rejects.toMatchObject({ status });
      expect(sent, String(status)).toHaveLength(4);
      expect(slept).toEqual([5000, 10_000, 20_000]);
    }
    const { fetch, sent } = scripted(json(429, {}), TOKEN, CAMERAS);
    expect(await client(fetch, { clock: () => 1e12 + 1e6 * sent.length }).c.cameras()).toEqual([]);
    const { fetch: f0, sent: s0 } = scripted(json(503, {}));
    await expect(client(f0, { retries: 0 }).c.cameras()).rejects.toMatchObject({ status: 503 });
    expect(s0).toHaveLength(1);
    const { fetch: f1, sent: s1 } = scripted(json(501, {}));
    await expect(client(f1).c.cameras()).rejects.toMatchObject({ status: 501 });
    expect(s1).toHaveLength(1);
  });

  it("spaces its calls a quarter second apart", async () => {
    let t = 1e9;
    const { fetch } = scripted(TOKEN, CAMERAS);
    const { c, slept } = client(fetch, { clock: () => t });
    await c.cameras();
    // The token and the read go back to back on a still clock.
    expect(slept).toEqual([VERKADA_SPACING_MS]);
    t += 100;
    await c.cameras();
    expect(slept).toEqual([VERKADA_SPACING_MS, 150]);
    t += VERKADA_SPACING_MS - 1;
    await c.cameras();
    expect(slept).toEqual([VERKADA_SPACING_MS, 150, 1]);
    t += VERKADA_SPACING_MS;
    await c.cameras();
    expect(slept).toEqual([VERKADA_SPACING_MS, 150, 1]);
    expect(VERKADA_SPACING_MS).toBe(250);
  });

  it("waits for real, and uses the global fetch and clock, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(TOKEN, CAMERAS);
    globalThis.fetch = fetch;
    const started = Date.now();
    try {
      expect(await verkadaClient({ apiKey: API_KEY }).cameras()).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(VERKADA_SPACING_MS - 20);
  });

  it("only ever sends the token request and GETs of the two reads", async () => {
    const mock = verkadaDocMock(org());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock, { historyYears: 1 }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`))).toEqual(new Set(["POST /token", "GET /cameras/v1/occupancy_trend_enabled", "GET /cameras/v1/analytics/occupancy_trends"]));
    expect(mock.tokens).toBe(1);
  });
});

describe("Verkada events", () => {
  const T0 = 1_790_000_000 - (1_790_000_000 % H);
  const answer = (extra: Record<string, unknown> = {}) => ({
    camera_id: "cam-1",
    camera_name: "Front door",
    camera_site: "Main Store",
    camera_address: "1 Test Street",
    org_name: "Test Org",
    trend_in: [
      [T0 + H, T0 + 2 * H, 7],
      [T0, T0 + H, 3],
    ],
    trend_out: [
      [T0, T0 + H, 1],
      [T0 + H, T0 + 2 * H, 6],
    ],
    ...extra,
  });

  it("joins each hour's people in and out, in order, dated at the hour's end", () => {
    const events = verkadaTrafficEvents(answer(), "cam-1", "line-1", ctx);
    expect(events.map((e) => e.payload)).toEqual([
      { system: "Verkada", cameraId: "verkada:camera:cam-1", presetId: "line-1", camera: "Front door", site: "Main Store", hourStart: iso(T0), hourEnd: iso(T0 + H), entered: 3, exited: 1 },
      { system: "Verkada", cameraId: "verkada:camera:cam-1", presetId: "line-1", camera: "Front door", site: "Main Store", hourStart: iso(T0 + H), hourEnd: iso(T0 + 2 * H), entered: 7, exited: 6 },
    ]);
    expect(events.map((e) => [e.type, e.occurredAt, e.receivedAt])).toEqual([
      [VERKADA_TRAFFIC_EVENT, iso(T0 + H), RECEIVED],
      [VERKADA_TRAFFIC_EVENT, iso(T0 + 2 * H), RECEIVED],
    ]);
    expect(VERKADA_TRAFFIC_EVENT).toBe("store.traffic_counted");
    expect(events[0]!.idempotencyKey).toMatch(new RegExp(`^verkada:traffic:cam-1:line-1:${T0}:[0-9a-f]{12}$`));
    expect(events[0]!.id).toBe(events[0]!.idempotencyKey.replace(/:/g, "_"));
    const all = JSON.stringify(events);
    for (const hidden of ["Test Street", "Test Org"]) expect(all).not.toContain(hidden);
  });

  it("keeps an hour with only one direction, and leaves out a name or site that doesn't read", () => {
    const [only] = verkadaTrafficEvents(answer({ trend_in: [], trend_out: [[T0, T0 + H, 2]], camera_name: "<b>x</b>", camera_site: " " }), "cam-1", "line-1", ctx);
    expect(only!.payload).toMatchObject({ entered: undefined, exited: 2, camera: undefined, site: undefined });
    const [inOnly] = verkadaTrafficEvents(answer({ trend_in: [[T0, T0 + H, 0]], trend_out: [], camera_name: "x".repeat(200), camera_site: " Annex " }), "cam-1", "line-1", ctx);
    expect(inOnly!.payload).toMatchObject({ entered: 0, exited: undefined, camera: "x".repeat(200), site: "Annex" });
    expect(verkadaTrafficEvents(answer({ camera_name: "x".repeat(201), camera_site: "a\u0007" }), "cam-1", "line-1", ctx)[0]!.payload).toMatchObject({ camera: undefined, site: undefined });
    expect(verkadaTrafficEvents(answer({ camera_name: "a>b", camera_site: "a<b" }), "cam-1", "line-1", ctx)[0]!.payload).toMatchObject({ camera: undefined, site: undefined });
    expect(verkadaTrafficEvents(answer({ camera_name: 5 }), "cam-1", "line-1", ctx)[0]!.payload.camera).toBeUndefined();
    expect(verkadaTrafficEvents(answer({ trend_in: [], trend_out: [] }), "cam-1", "line-1", ctx)).toEqual([]);
  });

  it("is a duplicate when read again unchanged, and a new event when an hour is recounted", () => {
    const a = verkadaTrafficEvents(answer(), "cam-1", "line-1", ctx)[0]!;
    expect(verkadaTrafficEvents(answer(), "cam-1", "line-1", { receivedAt: iso(T0) })[0]!.idempotencyKey).toBe(a.idempotencyKey);
    const recount = verkadaTrafficEvents(answer({ trend_in: [[T0, T0 + H, 4]] }), "cam-1", "line-1", ctx)[0]!;
    expect(recount.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(recount.idempotencyKey.split(":").slice(0, 5)).toEqual(a.idempotencyKey.split(":").slice(0, 5));
    expect(verkadaTrafficEvents(answer(), "cam-1", "line-2", ctx)[0]!.idempotencyKey).not.toBe(a.idempotencyKey);
  });

  it("dead-letters an answer for another camera or without counts, and each hour that doesn't read", () => {
    const whole = [
      [verkadaTrafficEvents(answer({ camera_id: "cam-2" }), "cam-1", "line-1", ctx), ["the answer is not for the camera asked about"]],
      [verkadaTrafficEvents(answer({ trend_in: {} }), "cam-1", "line-1", ctx), ["the answer has no counts in and out"]],
      [verkadaTrafficEvents(answer({ trend_out: undefined }), "cam-1", "line-1", ctx), ["the answer has no counts in and out"]],
      [verkadaTrafficEvents(null, "cam-1", "line-1", ctx), ["the answer is not for the camera asked about", "the answer has no counts in and out"]],
      [verkadaTrafficEvents([], "cam-1", "line-1", ctx), ["the answer is not for the camera asked about", "the answer has no counts in and out"]],
    ] as const;
    for (const [events, problems] of whole) {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: VERKADA_TRAFFIC_EVENT, occurredAt: undefined, receivedAt: RECEIVED, payload: { system: "Verkada", problems } });
      expect(events[0]!.idempotencyKey).toMatch(/^verkada:unreadable_traffic:[0-9a-f]{12}$/);
      expect(events[0]!.id).toBe(events[0]!.idempotencyKey.replace(/:/g, "_"));
    }
    const bad = [[T0, T0 + H], [T0, T0 + H, 1, 2], [T0, T0 + 2 * H, 1], [T0, T0 + H, -1], [T0, T0 + H, 1.5], [0, H, 1], [T0, T0 + H, "1"], "x", null];
    const events = verkadaTrafficEvents(answer({ trend_in: [...bad, [T0, T0 + H, 2]], trend_out: [[T0, T0 + 30, 1]] }), "cam-1", "line-1", ctx);
    const dead = events.filter((e) => e.occurredAt === undefined);
    expect(dead).toHaveLength(bad.length + 1);
    expect(dead.slice(0, bad.length).every((e) => JSON.stringify(e.payload.problems) === JSON.stringify(["an hour of counts in doesn't read"]))).toBe(true);
    expect(dead.at(-1)!.payload.problems).toEqual(["an hour of counts out doesn't read"]);
    expect(new Set(dead.map((e) => e.idempotencyKey)).size).toBe(dead.length);
    expect(events.filter((e) => e.occurredAt !== undefined).map((e) => e.payload)).toMatchObject([{ entered: 2, exited: undefined }]);
  });
});

describe("Verkada checkpoint", () => {
  const good: VerkadaCursor = { done: false, mark: TO - DAY, pass: { from: TO - 2 * DAY, to: TO, lines: ["cam-1|line-1", "cam_2|L-2"], line: 1, at: TO - DAY } };

  it("round-trips and turns down any other shape", () => {
    expect(parseVerkadaCursor(null)).toBeNull();
    expect(parseVerkadaCursor(JSON.stringify(good))).toEqual(good);
    for (const c of [{ done: true, mark: null, pass: null }, { ...good, pass: { ...good.pass!, line: 0, at: TO - 2 * DAY } }, { ...good, pass: { ...good.pass!, at: TO - H } }]) expect(parseVerkadaCursor(JSON.stringify(c))).toEqual(c);
    const p = good.pass!;
    const bad: unknown[] = [
      "nope",
      "null",
      { ...good, done: "no" },
      { ...good, mark: undefined },
      { ...good, mark: TO + 1 },
      { ...good, mark: 0 },
      { ...good, mark: "x" },
      { ...good, pass: undefined },
      { ...good, pass: { ...p, from: p.from + 1 } },
      { ...good, pass: { ...p, to: 1.5 } },
      { ...good, pass: { ...p, from: TO, to: TO } },
      { ...good, pass: { ...p, lines: "cam-1|line-1" } },
      { ...good, pass: { ...p, lines: [], line: 0 } },
      { ...good, pass: { ...p, lines: ["cam-1", "x|y"] } },
      { ...good, pass: { ...p, lines: [["a|b"], "x|y"] } },
      { ...good, pass: { ...p, to: p.to + 1 } },
      { ...good, mark: 3600 * 2 ** 53 },
      { ...good, pass: { ...p, lines: ["cam 1|line-1", "x|y"] } },
      { ...good, pass: { ...p, lines: [5, "x|y"] } },
      { ...good, pass: { ...p, lines: ["a|b|c", "x|y"] } },
      { ...good, pass: { ...p, lines: Array(VERKADA_MAX_LINES + 1).fill("a|b") } },
      { ...good, pass: { ...p, line: 2 } },
      { ...good, pass: { ...p, line: -1 } },
      { ...good, pass: { ...p, line: 0.5 } },
      { ...good, pass: { ...p, at: TO } },
      { ...good, pass: { ...p, at: p.from - H } },
      { ...good, pass: { ...p, at: p.at + 1 } },
    ];
    for (const raw of bad) expect(() => parseVerkadaCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw).slice(0, 120)).toThrow("Verkada checkpoint is not in the expected shape");
    expect(parseVerkadaCursor(JSON.stringify({ ...good, pass: { ...p, lines: Array(VERKADA_MAX_LINES).fill("a|b"), line: VERKADA_MAX_LINES - 1 } }))!.pass!.lines).toHaveLength(VERKADA_MAX_LINES);
  });
});

describe("Verkada connector", () => {
  it("passes the shared sync checks", async () => {
    // People in the first two hours too, so the first batch has events and a resume can be told from a restart.
    const count = (_c: string, _p: string, start: number): [number, number] | null => (start >= TO - 2 * H || start < YEAR_AGO + 2 * H ? [5, 4] : null);
    const result = await checkConnectorSync({ makeConnector: () => connector(verkadaDocMock(org({ count })), { historyYears: 1 }), expected: { ingested: 12 } });
    expect(result.resume!.ingested).toBe(10);
  });

  it("imports every line a week at a time back as far as told, then stops for good", async () => {
    const mock = verkadaDocMock(org());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { historyYears: 1 }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(6);
    const weeks = Math.ceil((TO - YEAR_AGO) / VERKADA_WINDOW_S);
    expect(mock.reads).toHaveLength(3 * weeks);
    expect(mock.reads[0]).toEqual({ camera: "cam-test-1", preset: "line-test-1", start: YEAR_AGO, end: YEAR_AGO + VERKADA_WINDOW_S });
    expect(mock.reads[weeks - 1]).toEqual({ camera: "cam-test-1", preset: "line-test-1", start: YEAR_AGO + (weeks - 1) * VERKADA_WINDOW_S, end: TO });
    expect(mock.reads.slice(weeks).map((r) => r.preset).filter((p, i, a) => a.indexOf(p) === i)).toEqual(["line-test-2", "line-test-2b"]);
    expect(memory.events.map((e) => [e.payload.cameraId, e.payload.presetId, e.payload.hourStart, e.payload.entered])).toEqual([
      ["verkada:camera:cam-test-1", "line-test-1", iso(TO - 2 * H), 5],
      ["verkada:camera:cam-test-1", "line-test-1", iso(TO - H), 5],
      ["verkada:camera:cam-test-2", "line-test-2", iso(TO - 2 * H), 5],
      ["verkada:camera:cam-test-2", "line-test-2", iso(TO - H), 5],
      ["verkada:camera:cam-test-2", "line-test-2b", iso(TO - 2 * H), 5],
      ["verkada:camera:cam-test-2", "line-test-2b", iso(TO - H), 5],
    ]);
    expect(parseVerkadaCursor(report.cursor)).toEqual({ done: true, mark: TO, pass: null });
    expect(new Set(memory.events.map((e) => e.receivedAt))).toEqual(new Set([RECEIVED]));
    assertSynthetic(memory.events);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(3 * weeks);
    expect(VERKADA_WINDOW_S).toBe(7 * DAY);
  });

  it("reads two years back by default, keeps its place in the checkpoint, and resumes there", async () => {
    const asked: [string, string, number, number][] = [];
    const fake: VerkadaClient = { cameras: async () => [{ cameraId: "c", presetIds: ["a", "b"] }], trends: async (c, p, s, e) => (asked.push([c, p, s, e]), { camera_id: c, trend_in: [], trend_out: [] }) };
    const batches = await drain(connector(verkadaDocMock(org()), { client: fake }).historicalImport({ cursor: null } as never));
    const weeks = Math.ceil((TO - TWO_YEARS_AGO) / VERKADA_WINDOW_S);
    expect(asked).toHaveLength(2 * weeks);
    expect(asked[0]).toEqual(["c", "a", TWO_YEARS_AGO, TWO_YEARS_AGO + VERKADA_WINDOW_S]);
    expect(asked[weeks]).toEqual(["c", "b", TWO_YEARS_AGO, TWO_YEARS_AGO + VERKADA_WINDOW_S]);
    const cursors = batches.map((b) => parseVerkadaCursor(b.cursor as string)!);
    expect(cursors[0]).toEqual({ done: false, mark: null, pass: { from: TWO_YEARS_AGO, to: TO, lines: ["c|a", "c|b"], line: 0, at: TWO_YEARS_AGO + VERKADA_WINDOW_S } });
    expect(cursors[weeks - 1]).toEqual({ done: false, mark: null, pass: { from: TWO_YEARS_AGO, to: TO, lines: ["c|a", "c|b"], line: 1, at: TWO_YEARS_AGO } });
    expect(cursors.at(-1)).toEqual({ done: true, mark: TO, pass: null });
    asked.length = 0;
    const rest = await drain(connector(verkadaDocMock(org()), { client: { ...fake, cameras: async () => [] } }).historicalImport({ cursor: batches[weeks - 1]!.cursor } as never));
    expect(asked).toHaveLength(weeks);
    expect(asked[0]).toEqual(["c", "b", TWO_YEARS_AGO, TWO_YEARS_AGO + VERKADA_WINDOW_S]);
    expect(rest).toHaveLength(weeks);
  });

  it("reads from two hours before the last sync ended, the last day on a first sync, and keeps the import's state", async () => {
    const asked: number[][] = [];
    const fake: VerkadaClient = { cameras: async () => [{ cameraId: "c", presetIds: ["a"] }], trends: async (_c, _p, s, e) => (asked.push([s, e]), { camera_id: "c", trend_in: [], trend_out: [] }) };
    const later = await drain(connector(verkadaDocMock(org()), { client: fake }).incrementalSync({ cursor: JSON.stringify({ done: true, mark: TO - 5 * H, pass: null }) } as never));
    expect(asked).toEqual([[TO - 7 * H, TO]]);
    expect(parseVerkadaCursor(later.at(-1)!.cursor as string)).toEqual({ done: true, mark: TO, pass: null });
    asked.length = 0;
    const first = await drain(connector(verkadaDocMock(org()), { client: fake }).incrementalSync({ cursor: null } as never));
    expect(asked).toEqual([[TO - DAY, TO]]);
    expect(parseVerkadaCursor(first.at(-1)!.cursor as string)).toEqual({ done: false, mark: TO, pass: null });
    asked.length = 0;
    // A mark at or past now still reads the last whole hour.
    await drain(connector(verkadaDocMock(org()), { client: fake }).incrementalSync({ cursor: JSON.stringify({ done: true, mark: TO + 3 * H, pass: null }) } as never));
    expect(asked).toEqual([[TO - H, TO]]);
    asked.length = 0;
    await drain(connector(verkadaDocMock(org()), { client: fake }).incrementalSync({ cursor: JSON.stringify({ done: true, mark: TO + H, pass: null }) } as never));
    expect(asked).toEqual([[TO - H, TO]]);
    expect([VERKADA_OVERLAP_S, VERKADA_FIRST_LOOKBACK_S]).toEqual([2 * H, DAY]);
  });

  it("keeps a finished import finished, and the mark, part way through a later sync", async () => {
    const fake: VerkadaClient = { cameras: async () => [{ cameraId: "c", presetIds: ["a", "b"] }], trends: async (c) => ({ camera_id: c, trend_in: [], trend_out: [] }) };
    const batches = await drain(connector(verkadaDocMock(org()), { client: fake }).incrementalSync({ cursor: JSON.stringify({ done: true, mark: TO - 5 * H, pass: null }) } as never));
    expect(batches.map((b) => parseVerkadaCursor(b.cursor as string))).toEqual([
      { done: true, mark: TO - 5 * H, pass: { from: TO - 7 * H, to: TO, lines: ["c|a", "c|b"], line: 1, at: TO - 7 * H } },
      { done: true, mark: TO, pass: null },
    ]);
  });

  it("finishes at once when no camera counts people, and stops when there are more lines than a pass reads", async () => {
    const none: VerkadaClient = { cameras: async () => [], trends: async () => ({}) };
    const batches = await drain(connector(verkadaDocMock(org()), { client: none }).historicalImport({ cursor: null } as never));
    expect(batches).toEqual([{ events: [], cursor: JSON.stringify({ done: true, mark: TO, pass: null }) }]);
    const later = await drain(connector(verkadaDocMock(org()), { client: none }).incrementalSync({ cursor: null } as never));
    expect(later).toEqual([{ events: [], cursor: JSON.stringify({ done: false, mark: TO, pass: null }) }]);
    const many = (n: number): VerkadaClient => ({ cameras: async () => [{ cameraId: "c", presetIds: Array.from({ length: n }, (_, i) => `p${i}`) }], trends: async () => ({ camera_id: "c", trend_in: [], trend_out: [] }) });
    await expect(drain(connector(verkadaDocMock(org()), { client: many(VERKADA_MAX_LINES + 1) }).incrementalSync({ cursor: null } as never))).rejects.toThrow(`Verkada has more than ${VERKADA_MAX_LINES} counting lines, more than one pass reads`);
    expect(await drain(connector(verkadaDocMock(org()), { client: many(VERKADA_MAX_LINES) }).incrementalSync({ cursor: null } as never))).toHaveLength(VERKADA_MAX_LINES);
    expect(VERKADA_MAX_LINES).toBe(500);
  });

  it("dead-letters what it can't read and carries on", async () => {
    const fake: VerkadaClient = {
      cameras: async () => [{ cameraId: "c", presetIds: ["a"] }],
      trends: async () => ({ camera_id: "c", trend_in: [[TO - H, TO, 3], [TO - H, TO, -1]], trend_out: [[TO - H, TO, 1]] }),
    };
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(verkadaDocMock(org()), { client: fake }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 1, deadLettered: 1 });
  });

  it("signs in again when a token lapses mid-sync, and waits out a rate limit", async () => {
    const mock = verkadaDocMock(org({ rateLimits: 1 }));
    let reads = 0;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("occupancy_trends") && ++reads === 2) mock.expireTokens();
      return mock.fetch(input, init);
    }) as typeof globalThis.fetch;
    const slept: number[] = [];
    const batches = await drain(verkadaConnector({ apiKey: API_KEY, fetch, sleep: async (ms) => void slept.push(ms), clock: () => 0, now: NOW }).incrementalSync({ cursor: null } as never));
    expect(eventsOf(batches)).toHaveLength(6);
    expect(mock.tokens).toBe(2);
    expect(slept.filter((ms) => ms !== VERKADA_SPACING_MS)).toEqual([5000]);
  });

  it("stops on a key that's turned down", async () => {
    await expect(drain(connector(verkadaDocMock(org({ apiKey: "z".repeat(24) }))).historicalImport({ cursor: null } as never))).rejects.toThrow("Verkada turned down VERKADA_API_KEY");
  });

  it("checks its settings, and up to now when no clock is given", async () => {
    const mock = verkadaDocMock(org());
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { apiKey: "nope" })).toThrow(VerkadaConfigError);
    expect(() => connector(mock, { region: "mars" })).toThrow("VERKADA_REGION must be us or eu");
    const asked: number[] = [];
    const fake: VerkadaClient = { cameras: async () => [{ cameraId: "c", presetIds: ["a"] }], trends: async (_c, _p, _s, e) => (asked.push(e), { camera_id: "c", trend_in: [], trend_out: [] }) };
    expect(() => connector(mock, { apiKey: "nope", client: fake })).not.toThrow();
    await drain(verkadaConnector({ apiKey: API_KEY, client: fake }).incrementalSync({ cursor: null } as never));
    expect(asked[0]! % H).toBe(0);
    expect(Date.now() / 1000 - asked[0]!).toBeLessThan(H + 5);
    expect(Date.now() / 1000 - asked[0]!).toBeGreaterThanOrEqual(0);
  });

  it("declares no writes, so none can run", async () => {
    expect(VERKADA_WRITES).toEqual([]);
    const c = connector(verkadaDocMock(org()));
    expect(c.writes).toBe(VERKADA_WRITES);
    expect(c.source).toBe("verkada");
    expect(await assertWritesRefused(c)).toEqual([]);
  });
});

describe("Verkada doc mock", () => {
  const signIn = async (mock: VerkadaMock) => ((await (await mock.fetch(`${VERKADA_BASE}/token`, { method: "POST", headers: { "x-api-key": API_KEY } })).json()) as { token: string }).token;
  const get = (mock: VerkadaMock, path: string, token: string) => mock.fetch(`${VERKADA_BASE}${path}`, { headers: { "x-verkada-auth": token } });

  it("wants the key for a token and the token for a read, and checks the camera, line, interval, type and range", async () => {
    const mock = verkadaDocMock(org());
    expect((await mock.fetch(`${VERKADA_BASE}/token`, { method: "POST", headers: { "x-api-key": "nope" } })).status).toBe(401);
    const token = await signIn(mock);
    expect((await get(mock, "/cameras/v1/occupancy_trend_enabled", "nope")).status).toBe(401);
    expect(await (await get(mock, "/cameras/v1/occupancy_trend_enabled", token)).json()).toEqual({ cameras: [{ camera_id: "cam-test-1", preset_ids: ["line-test-1"] }, { camera_id: "cam-test-2", preset_ids: ["line-test-2", "line-test-2b"] }] });
    const base = "/cameras/v1/analytics/occupancy_trends?camera_id=cam-test-1&preset_id=line-test-1";
    for (const q of [`${base}&start_time=0&end_time=7200&org_id=1`, "/cameras/v1/analytics/occupancy_trends?camera_id=nope&preset_id=line-test-1&start_time=0&end_time=7200", "/cameras/v1/analytics/occupancy_trends?camera_id=cam-test-1&start_time=0&end_time=7200", "/cameras/v1/analytics/occupancy_trends?camera_id=cam-test-1&preset_id=line-test-2&start_time=0&end_time=7200", `${base}&interval=1_week&start_time=0&end_time=7200`, `${base}&type=dog&start_time=0&end_time=7200`, `${base}&start_time=7200&end_time=7200`, `${base}&start_time=x&end_time=7200`, `${base}&start_time=0`]) {
      expect((await get(mock, q, token)).status, q).toBe(400);
    }
    expect((await get(mock, `${base}&start_time=0&end_time=7200`, "nope")).status).toBe(401);
    const counts = (await (await get(mock, `${base}&start_time=${TO - 3 * H}&end_time=${TO}&interval=1_hour&type=person`, token)).json()) as Record<string, unknown>;
    expect(counts).toMatchObject({ camera_id: "cam-test-1", camera_name: "Front door 1", camera_site: "Main Store", start_time: TO - 3 * H, end_time: TO, type: "person", trend_in: [[TO - 2 * H, TO - H, 5], [TO - H, TO, 5]], trend_out: [[TO - 2 * H, TO - H, 4], [TO - H, TO, 4]] });
    expect(mock.reads).toEqual([{ camera: "cam-test-1", preset: "line-test-1", start: TO - 3 * H, end: TO }]);
  });

  it("counts 3 in and 2 out each whole hour unless told, from the first whole hour of the range", async () => {
    const mock = verkadaDocMock({ apiKey: API_KEY, cameras: [verkadaCamera(1)] });
    const token = await signIn(mock);
    const counts = (await (await get(mock, `/cameras/v1/analytics/occupancy_trends?camera_id=cam-test-1&preset_id=line-test-1&start_time=${H / 2}&end_time=${3 * H}&interval=15_minutes&type=vehicle`, token)).json()) as Record<string, unknown>;
    expect(counts).toMatchObject({ type: "vehicle", trend_in: [[H, 2 * H, 3], [2 * H, 3 * H, 3]], trend_out: [[H, 2 * H, 2], [2 * H, 3 * H, 2]] });
    const empty = verkadaDocMock({ apiKey: API_KEY });
    expect(((await (await get(empty, "/cameras/v1/occupancy_trend_enabled", await signIn(empty))).json()) as { cameras: unknown[] }).cameras).toEqual([]);
  });

  it("answers 429 past the rate limit, and its tokens lapse when told", async () => {
    const mock = verkadaDocMock(org({ rateLimits: 2 }));
    expect((await mock.fetch(`${VERKADA_BASE}/token`, { method: "POST", headers: { "x-api-key": API_KEY } })).status).toBe(429);
    const token = await signIn(verkadaDocMock(org()));
    expect((await get(mock, "/cameras/v1/occupancy_trend_enabled", token)).status).toBe(429);
    const mine = await signIn(mock);
    expect((await get(mock, "/cameras/v1/occupancy_trend_enabled", mine)).status).toBe(200);
    mock.expireTokens();
    expect((await get(mock, "/cameras/v1/occupancy_trend_enabled", mine)).status).toBe(401);
    expect(mock.tokens).toBe(1);
    expect(VERKADA_DOC_PAGES.requests).toMatch(/^https:\/\/apidocs\.verkada\.com\//);
  });
});
