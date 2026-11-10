import { describe, expect, it, vi } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { QUO_TEST_LINE, QUO_TEST_NUMBER, QUO_TEST_USER, TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, quoCall, quoCustomerNumber, quoDocMock, quoMessage, testPipeline, type QuoMock, type QuoMockData } from "@karatos/connector-testkit";
import {
  QUO_API_URL,
  QUO_API_VERSION,
  QUO_CALL_EVENT,
  QUO_FIRST_LOOKBACK_MS,
  QUO_MESSAGE_EVENT,
  QUO_OVERLAP_MS,
  QUO_PAGE_SIZE,
  QUO_WRITES,
  QuoApiError,
  QuoConfigError,
  formCustomerRefs,
  parseQuoCursor,
  quoCallEvent,
  quoClient,
  quoConnector,
  quoCustomerRefs,
  quoErrorTitle,
  quoMessageEvent,
  quoTime,
  type QuoClient,
  type QuoCursor,
  type QuoEvent,
  type QuoOptions,
} from "../src/index.js";

// A key-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["quo", "test", "0".repeat(24)].join("_");
const CUSTOMER_KEY = "c".repeat(40);
const NOW = () => new Date("2026-11-10T15:00:00.000Z");
const RECEIVED = "2026-11-10T15:00:00.000Z";
const HOUR_MS = 3_600_000;
const noSleep = async () => {};

/** `ago` hours before NOW. */
const before = (ago: number) => new Date(NOW().getTime() - ago * HOUR_MS).toISOString();

/** Calls and texts made 1, 30 and 5,000 hours ago, and one three years ago, past the two read. */
function workspace(overrides: Partial<QuoMockData> = {}): QuoMockData {
  quoCall.reset();
  quoMessage.reset();
  return {
    apiKey: KEY,
    calls: [1, 30, 5000, 26_400].map((ago) => quoCall.one({ createdAt: before(ago) })),
    messages: [1, 30, 5000, 26_400].map((ago) => quoMessage.one({ createdAt: before(ago), updatedAt: before(ago) })),
    ...overrides,
  };
}

const connector = (mock: QuoMock, overrides: Partial<QuoOptions> = {}) => quoConnector({ apiKey: KEY, customerKey: CUSTOMER_KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });

const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as QuoEvent[];

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
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof quoClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = quoClient({ apiKey: KEY, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const Q = { from: "2026-11-01T00:00:00.000Z", until: "2026-11-10T15:00:00.000Z", after: null };
const PAGE = { data: [], nextCursor: null };

describe("Quo client", () => {
  it("checks the key before sending anything", () => {
    const { fetch, sent } = scripted(json(200, PAGE));
    for (const bad of ["", "short", `${KEY}!`, "a".repeat(257), "a".repeat(15), undefined]) expect(() => quoClient({ apiKey: bad as string, fetch }), String(bad)).toThrow(QuoConfigError);
    expect(() => quoClient({ apiKey: "", fetch })).toThrow("QUO_API_KEY is missing or not in the expected shape");
    expect(() => quoClient({ apiKey: "a".repeat(256), fetch })).not.toThrow();
    expect(() => quoClient({ apiKey: "a".repeat(16), fetch })).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("lists calls with the raw key, the version and inclusive bounds", async () => {
    const { fetch, sent } = scripted(json(200, { data: [{ id: "AC1" }], nextCursor: "abc_-=" }));
    expect(await client(fetch, { apiKey: ` ${KEY} ` }).c.page("calls", Q)).toEqual({ rows: [{ id: "AC1" }], next: "abc_-=" });
    expect(sent).toEqual([
      {
        url: `${QUO_API_URL}/calls?createdAt%5Bgte%5D=2026-11-01T00%3A00%3A00.000Z&createdAt%5Blte%5D=2026-11-10T15%3A00%3A00.000Z&limit=50`,
        method: "GET",
        headers: { Authorization: KEY, Accept: "application/json", "Quo-Api-Version": QUO_API_VERSION },
      },
    ]);
    expect(QUO_API_VERSION).toBe("2026-03-30");
    expect(QUO_PAGE_SIZE).toBe(50);
  });

  it("lists messages with exclusive bounds, and pages with Quo's cursor", async () => {
    const { fetch, sent } = scripted(json(200, PAGE));
    expect(await client(fetch).c.page("messages", { ...Q, after: "eyJsYXN0SWQiOiJVU211a09NaXBhIn0" })).toEqual({ rows: [], next: null });
    expect(sent[0]!.url).toBe(`${QUO_API_URL}/messages?createdAt%5Bgt%5D=2026-11-01T00%3A00%3A00.000Z&createdAt%5Blt%5D=2026-11-10T15%3A00%3A00.000Z&limit=50&after=eyJsYXN0SWQiOiJVU211a09NaXBhIn0`);
  });

  it("checks times and cursors before sending", async () => {
    const { fetch, sent } = scripted(json(200, PAGE));
    const { c } = client(fetch);
    await expect(c.page("calls", { ...Q, from: "2026-11-01" })).rejects.toThrow("calls must be listed between UTC times");
    await expect(c.page("calls", { ...Q, until: "2026-11-10T15:00:00Z" })).rejects.toThrow(QuoApiError);
    await expect(c.page("calls", { ...Q, from: "x2026-11-01T00:00:00.000Z" })).rejects.toThrow(QuoApiError);
    await expect(c.page("calls", { ...Q, until: "2026-11-10T15:00:00.000Zx" })).rejects.toThrow(QuoApiError);
    await expect(c.page("messages", { ...Q, after: "a&limit=1" })).rejects.toThrow("messages page cursor is not in the expected shape");
    await expect(c.page("messages", { ...Q, after: "" })).rejects.toThrow(QuoApiError);
    await expect(c.page("messages", { ...Q, after: "a".repeat(1025) })).rejects.toThrow(QuoApiError);
    expect(sent).toHaveLength(0);
    await c.page("messages", { ...Q, after: "a".repeat(1024) });
    expect(sent).toHaveLength(1);
  });

  it("says when a page has no data list or a next cursor that doesn't read", async () => {
    const { fetch } = scripted(json(200, { nextCursor: null }), json(200, { data: {}, nextCursor: null }), json(200, { data: [] }), json(200, { data: [], nextCursor: "a b" }), json(200, { data: [], nextCursor: 5 }));
    const { c } = client(fetch);
    await expect(c.page("calls", Q)).rejects.toThrow("Quo answered calls without the data list");
    await expect(c.page("calls", Q)).rejects.toThrow("Quo answered calls without the data list");
    await expect(c.page("calls", Q)).rejects.toThrow("Quo answered calls with a next cursor that doesn't read");
    await expect(c.page("messages", Q)).rejects.toThrow("Quo answered messages with a next cursor that doesn't read");
    await expect(c.page("messages", Q)).rejects.toThrow(QuoApiError);
  });

  it("explains a turned-down key, a forbidden read and other errors, with Quo's error class", async () => {
    const env = (status: number, title: unknown) => json(status, { message: "x", docs: "https://quo.com/docs", title });
    const { fetch } = scripted(env(401, "Unauthorized"), env(403, "Forbidden"), env(422, "Unprocessable Entity"), text(500, "oops"), env(404, "<b>"), json(202, PAGE));
    const { c } = client(fetch, { retries: 0 });
    await expect(c.page("calls", Q)).rejects.toMatchObject({ status: 401, title: "Unauthorized", message: "Quo turned down the API key: check QUO_API_KEY, and that it wasn't deleted in Workspace Settings > API" });
    await expect(c.page("calls", Q)).rejects.toMatchObject({ status: 403, title: "Forbidden", message: "Quo's workspace isn't allowed to read calls: the API may be turned off for it" });
    await expect(c.page("messages", Q)).rejects.toMatchObject({ status: 422, message: "Quo answered HTTP 422 for messages (Unprocessable Entity)" });
    await expect(c.page("calls", Q)).rejects.toMatchObject({ status: 500, title: undefined, message: "Quo answered HTTP 500 for calls" });
    await expect(c.page("calls", Q)).rejects.toMatchObject({ status: 404, title: undefined, message: "Quo answered HTTP 404 for calls" });
    await expect(c.page("calls", Q)).rejects.toMatchObject({ status: 202, message: "Quo answered HTTP 202 for calls" });
  });

  it("reads Quo's error class only when it is a few plain words", () => {
    expect(quoErrorTitle({ title: "Bad Request" })).toBe("Bad Request");
    expect(quoErrorTitle({ title: "x".repeat(40) })).toBe("x".repeat(40));
    for (const bad of [{ title: "x".repeat(41) }, { title: "" }, { title: "Bad: Request" }, { title: 4 }, ["title"], null]) expect(quoErrorTitle(bad)).toBeUndefined();
  });

  it("says when a 200 isn't a JSON object", async () => {
    const { fetch } = scripted(text(200, "<html>"), json(200, ["a"]), json(200, null));
    const { c } = client(fetch);
    for (let i = 0; i < 3; i++) await expect(c.page("calls", Q)).rejects.toMatchObject({ status: 200, message: "Quo answered calls with a body that isn't a JSON object" });
  });

  it("waits out rate limits and server errors, backing off, and honors a Retry-After up to a minute", async () => {
    const { fetch, sent } = scripted(json(429, {}), json(500, {}, { "retry-after": "5" }), json(502, {}, { "retry-after": "600" }), json(200, PAGE));
    const { c, slept } = client(fetch);
    expect(await c.page("calls", Q)).toEqual({ rows: [], next: null });
    expect(sent).toHaveLength(4);
    expect(slept).toEqual([1000, 5000, 60_000]);
  });

  it("retries 503 and 504 too, then gives up", async () => {
    const { fetch, sent } = scripted(json(503, {}, { "retry-after": "soon" }), json(504, {}, { "retry-after": "0" }), json(503, {}, { "retry-after": "-3" }), json(504, { title: "Gateway Timeout" }));
    const { c, slept } = client(fetch);
    await expect(c.page("calls", Q)).rejects.toMatchObject({ status: 504, message: "Quo answered HTTP 504 for calls (Gateway Timeout)" });
    expect(sent).toHaveLength(4);
    expect(slept).toEqual([1000, 2000, 4000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const { fetch, sent } = scripted(json(400, {}));
    await expect(client(fetch).c.page("calls", Q)).rejects.toMatchObject({ status: 400 });
    expect(sent).toHaveLength(1);
    const again = scripted(json(429, {}));
    await expect(client(again.fetch, { retries: 1 }).c.page("calls", Q)).rejects.toMatchObject({ status: 429 });
    expect(again.sent).toHaveLength(2);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "0.001" }), json(200, PAGE));
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await quoClient({ apiKey: KEY }).page("calls", Q)).toEqual({ rows: [], next: null });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(2);
  });

  it("only ever sends GETs to List calls and List messages", async () => {
    const mock = quoDocMock(workspace());
    await runSync({ connector: connector(mock), mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`))).toEqual(new Set(["GET /calls", "GET /messages"]));
  });
});

describe("Quo reading helpers", () => {
  it("reads Quo's times as UTC", () => {
    expect(quoTime("2022-01-01T00:00:00Z")).toBe("2022-01-01T00:00:00.000Z");
    expect(quoTime("2022-01-01T00:00:00.123456Z")).toBe("2022-01-01T00:00:00.123Z");
    expect(quoTime("2022-01-01T00:00:00.5Z")).toBe("2022-01-01T00:00:00.500Z");
    expect(quoTime("2022-01-01T08:00:00+08:00")).toBe("2022-01-01T00:00:00.000Z");
    expect(quoTime("1970-01-01T00:00:00Z")).toBe("1970-01-01T00:00:00.000Z");
    for (const bad of ["2022-02-30T00:00:00Z", "2022-13-01T00:00:00Z", "2022-01-01T25:00:00Z", "2022-01-01", "2022-01-01T00:00:00", "x2022-01-01T00:00:00Z", "+002022-01-01T00:00:00Z", "2022-01-01T00:00:00Zx", "1969-12-31T23:59:59Z", "2022-01-01T00:00:00.1234567890Z", 1, null]) {
      expect(quoTime(bad), String(bad)).toBeNull();
    }
  });

  it("makes the same customer references other systems make, for real numbers only", () => {
    const n = quoCustomerNumber(3);
    expect(quoCustomerRefs(CUSTOMER_KEY, [n])).toEqual(formCustomerRefs(CUSTOMER_KEY, { phone: n }));
    expect(quoCustomerRefs(CUSTOMER_KEY, [n, n])).toHaveLength(1);
    expect(quoCustomerRefs(CUSTOMER_KEY, ["anonymous", "Blocked", "12345", "x+12125550100", "+12125550100x", "+0123456789", "+123456", "1234567890", "+1234567890123456", 7, null])).toEqual([]);
    expect(quoCustomerRefs(CUSTOMER_KEY, ["+1234567"])).toHaveLength(1);
    expect(quoCustomerRefs(CUSTOMER_KEY, ["+123456789012345"])).toHaveLength(1);
    const many = Array.from({ length: 12 }, (_, i) => quoCustomerNumber(i));
    expect(quoCustomerRefs(CUSTOMER_KEY, many)).toHaveLength(10);
    const refs = quoCustomerRefs(CUSTOMER_KEY, [quoCustomerNumber(5), quoCustomerNumber(4)]);
    expect(refs).toEqual([...refs].sort());
  });
});

describe("Quo events", () => {
  const ctx = { customerKey: CUSTOMER_KEY, receivedAt: RECEIVED };
  const call = (extra: Record<string, unknown> = {}) => {
    quoCall.reset();
    return { ...quoCall.one({}), ...extra };
  };
  const message = (extra: Record<string, unknown> = {}) => {
    quoMessage.reset();
    return { ...quoMessage.one({}), ...extra };
  };

  it("logs a call as Twilio's do, with the caller as a customer reference and no number", () => {
    const { ok, event } = quoCallEvent(call(), ctx);
    expect(ok).toBe(true);
    expect(event.type).toBe(QUO_CALL_EVENT);
    expect(event.type).toBe("communication.call_logged");
    expect(event.occurredAt).toBe("2026-01-01T00:01:00.000Z");
    expect(event.receivedAt).toBe(RECEIVED);
    expect(event.payload).toEqual({
      system: "Quo",
      channel: "voice",
      callId: "openphone:call:ACtest000001",
      customerRefs: formCustomerRefs(CUSTOMER_KEY, { phone: quoCustomerNumber(1) }),
      withheldCaller: false,
      storeLineId: QUO_TEST_LINE,
      direction: "inbound",
      status: "completed",
      missed: false,
      answeredBy: QUO_TEST_USER,
      durationSeconds: 240,
      forwarded: false,
      aiHandled: false,
      startedAt: "2026-01-01T00:01:00.000Z",
      answeredAt: "2026-01-01T00:01:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain("5550101");
    expect(text).not.toContain("5550199");
    expect(event.idempotencyKey).toMatch(/^openphone:call:ACtest000001:[0-9a-f]{12}$/);
    expect(event.id).toBe(event.idempotencyKey.replace(/:/g, "_"));
  });

  it("marks an incoming call nobody picked up as missed, but not an outgoing one", () => {
    for (const status of ["busy", "no-answer", "canceled", "missed", "abandoned"]) expect(quoCallEvent(call({ status }), ctx).event.payload.missed, status).toBe(true);
    for (const status of ["completed", "answered", "forwarded", "ringing"]) expect(quoCallEvent(call({ status }), ctx).event.payload.missed, status).toBe(false);
    expect(quoCallEvent(call({ status: "no-answer", direction: "outgoing" }), ctx).event.payload).toMatchObject({ missed: false, direction: "outbound" });
  });

  it("notes withheld callers, forwarding and the AI agent, and drops what doesn't read", () => {
    const { event } = quoCallEvent(
      call({
        participants: [{ phoneNumber: QUO_TEST_NUMBER, actorId: QUO_TEST_USER }, { phoneNumber: "Anonymous", actorId: null }, "x", null, { phoneNumber: quoCustomerNumber(9) }],
        forwardedTo: "PNother",
        aiHandled: "ai-agent",
        phoneNumberId: "line-1",
        answeredBy: "staff",
        duration: -1,
        answeredAt: null,
        completedAt: "soon",
      }),
      ctx,
    );
    expect(event.payload).toMatchObject({ customerRefs: [], withheldCaller: true, forwarded: true, aiHandled: true, storeLineId: undefined, answeredBy: undefined, durationSeconds: undefined, answeredAt: undefined, endedAt: undefined });
    expect(quoCallEvent(call({ participants: "none", answeredBy: "SYUagent1", duration: 1.5, aiHandled: "human" }), ctx).event.payload).toMatchObject({ customerRefs: [], withheldCaller: false, answeredBy: "SYUagent1", durationSeconds: undefined, aiHandled: false });
    expect(quoCallEvent(call({ duration: 0, forwardedTo: undefined }), ctx).event.payload).toMatchObject({ durationSeconds: 0, forwarded: false });
    expect(quoCallEvent(call({ participants: [{ phoneNumber: "Restricted", actorId: null }] }), ctx).event.payload).toMatchObject({ customerRefs: [], withheldCaller: true });
  });

  it("logs a text as Twilio's do, with its length but never its words", () => {
    const { ok, event } = quoMessageEvent(message({ media: [{ url: "https://example.com/m.jpg", type: "image/jpeg" }] }), ctx);
    expect(ok).toBe(true);
    expect(event.type).toBe(QUO_MESSAGE_EVENT);
    expect(event.type).toBe("communication.message_logged");
    expect(event.payload).toEqual({
      system: "Quo",
      channel: "mms",
      messageId: "openphone:message:ACmsg000001",
      conversationId: "CNtest000001",
      customerRefs: formCustomerRefs(CUSTOMER_KEY, { phone: quoCustomerNumber(1) }),
      storeLineId: QUO_TEST_LINE,
      direction: "inbound",
      status: "received",
      sentBy: undefined,
      mediaCount: 1,
      textLength: 46,
      sentAt: "2026-01-01T00:01:00.000Z",
      statusAt: "2026-01-01T00:01:00.000Z",
    });
    const text = JSON.stringify(event);
    for (const gone of ["ring ready", "Test Customer", "example.com", "5550101"]) expect(text, gone).not.toContain(gone);
    expect(event.idempotencyKey).toMatch(/^openphone:message:ACmsg000001:[0-9a-f]{12}$/);
  });

  it("takes the customers of an outgoing text from who it went to", () => {
    const out = quoMessageEvent(message({ direction: "outgoing", from: QUO_TEST_NUMBER, to: [quoCustomerNumber(7), quoCustomerNumber(8)], userId: QUO_TEST_USER, status: "delivered", media: "none", text: 5 }), ctx);
    expect(out.event.payload).toMatchObject({
      direction: "outbound",
      channel: "sms",
      customerRefs: quoCustomerRefs(CUSTOMER_KEY, [quoCustomerNumber(7), quoCustomerNumber(8)]),
      sentBy: QUO_TEST_USER,
      status: "delivered",
      mediaCount: 0,
      textLength: undefined,
    });
    expect((out.event.payload.customerRefs as string[]).length).toBe(2);
    expect(quoMessageEvent(message({ direction: "outgoing", to: "x" }), ctx).event.payload.customerRefs).toEqual([]);
    expect(quoMessageEvent(message({ conversationId: "conv", phoneNumberId: null, updatedAt: null }), ctx).event.payload).toMatchObject({ conversationId: undefined, storeLineId: undefined, statusAt: undefined });
  });

  it("is a duplicate when read again unchanged, and a new event when it changes", () => {
    const a = quoCallEvent(call(), ctx).event;
    expect(quoCallEvent(call(), { ...ctx, receivedAt: "2027-01-01T00:00:00.000Z" }).event.idempotencyKey).toBe(a.idempotencyKey);
    expect(quoCallEvent(call({ duration: 241 }), ctx).event.idempotencyKey).not.toBe(a.idempotencyKey);
    const m = quoMessageEvent(message(), ctx).event;
    expect(quoMessageEvent(message({ status: "failed" }), ctx).event.idempotencyKey).not.toBe(m.idempotencyKey);
  });

  it("dead-letters a call or text it can't read, saying why", () => {
    const bad = quoCallEvent({ id: "CA1", createdAt: "soon", direction: "inbound", status: "done" }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.event.occurredAt).toBeUndefined();
    expect(bad.event.payload).toEqual({ system: "Quo", callId: null, problems: ["call has no id that reads", "call has no start time that reads", "call direction is not incoming or outgoing", "call status is not one Quo documents"] });
    expect(bad.event.idempotencyKey).toMatch(/^openphone:unreadable_call:[0-9a-f]{12}$/);
    expect(quoCallEvent("x", ctx).event.payload.problems).toContain("call is not an object");
    expect(quoCallEvent(call({ status: 5 }), ctx).event.payload).toEqual({ system: "Quo", callId: "ACtest000001", problems: ["call status is not one Quo documents"] });
    expect(quoCallEvent(call({ id: `AC${"a".repeat(65)}` }), ctx).ok).toBe(false);
    expect(quoCallEvent(call({ id: "xACabc" }), ctx).ok).toBe(false);
    const badText = quoMessageEvent({ id: "SM1", createdAt: null, direction: "in", status: "read" }, ctx);
    expect(badText.event.payload).toEqual({ system: "Quo", messageId: null, problems: ["message has no id that reads", "message has no time that reads", "message direction is not incoming or outgoing", "message status is not one Quo documents"] });
    expect(badText.event.idempotencyKey).toMatch(/^openphone:unreadable_message:[0-9a-f]{12}$/);
    expect(quoMessageEvent(null, ctx).event.payload.problems).toContain("message is not an object");
    expect(quoMessageEvent(message({ status: 1 }), ctx).event.payload).toMatchObject({ messageId: "ACmsg000001" });
  });
});

describe("Quo checkpoint", () => {
  const pass = { from: "2024-11-10T15:00:00.000Z", until: "2026-11-10T15:00:00.000Z", step: 1, after: "abc" };
  const nextFrom = "2026-11-09T15:00:00.000Z";

  it("round-trips and turns down any other shape", () => {
    expect(parseQuoCursor(null)).toBeNull();
    const c: QuoCursor = { pass, done: false, nextFrom };
    expect(parseQuoCursor(JSON.stringify(c))).toEqual(c);
    expect(parseQuoCursor(JSON.stringify({ pass: { ...pass, step: 0, after: null }, done: true, nextFrom }))).toEqual({ pass: { ...pass, step: 0, after: null }, done: true, nextFrom });
    expect(parseQuoCursor(JSON.stringify({ pass: null, done: true, nextFrom }))).toEqual({ pass: null, done: true, nextFrom });
    for (const bad of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ pass: null, done: true }),
      JSON.stringify({ pass: null, done: "yes", nextFrom }),
      JSON.stringify({ pass: null, done: true, nextFrom: "2026-11-09" }),
      JSON.stringify({ done: true, nextFrom }),
      JSON.stringify({ pass: [], done: false, nextFrom }),
      JSON.stringify({ pass: "x", done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, from: "2024-11-10T15:00:00Z" }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, until: null }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, step: 2 }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, step: "1" }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, after: 3 }, done: false, nextFrom }),
    ]) {
      expect(() => parseQuoCursor(bad), bad).toThrow("Quo checkpoint is not in the expected shape");
    }
  });
});

describe("Quo connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(quoDocMock(workspace())), expected: { ingested: 6 } });
    expect(result.full.ingested).toBe(6);
  });

  it("imports two years of calls, then texts, then stops for good", async () => {
    const mock = quoDocMock(workspace());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(6);
    expect(mock.reads).toEqual([
      { kind: "calls", query: { "createdAt[gte]": "2024-11-10T15:00:00.000Z", "createdAt[lte]": RECEIVED, limit: "50" } },
      { kind: "messages", query: { "createdAt[gt]": "2024-11-10T15:00:00.000Z", "createdAt[lt]": RECEIVED, limit: "50" } },
    ]);
    expect(memory.events.map((e) => e.type).sort()).toEqual([...Array(3).fill(QUO_CALL_EVENT), ...Array(3).fill(QUO_MESSAGE_EVENT)]);
    expect(parseQuoCursor(report.cursor)).toEqual({ pass: null, done: true, nextFrom: before(24) });
    assertSynthetic(memory.events);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(2);
  });

  it("reads 50 a page with Quo's cursor, keeping it in the checkpoint, and resumes there", async () => {
    quoCall.reset();
    const calls = Array.from({ length: 120 }, (_, i) => quoCall.one({ createdAt: before(i + 1) }));
    const mock = quoDocMock(workspace({ calls, messages: [] }));
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([50, 50, 20, 0]);
    const cursors = batches.map((b) => parseQuoCursor(b.cursor ?? null)!);
    const span = { from: "2024-11-10T15:00:00.000Z", until: RECEIVED };
    expect(cursors[0]).toEqual({ pass: { ...span, step: 0, after: Buffer.from("offset:50").toString("base64url") }, done: false, nextFrom: before(24) });
    expect(cursors[2]).toEqual({ pass: { ...span, step: 1, after: null }, done: false, nextFrom: before(24) });
    expect(cursors[3]).toEqual({ pass: null, done: true, nextFrom: before(24) });
    // Resumed after the first page, it reads the rest, even on a later clock.
    const resumed = quoDocMock(workspace({ calls, messages: [] }));
    const later = () => new Date(NOW().getTime() + 5 * HOUR_MS);
    const rest = await drain(connector(resumed, { now: later }).historicalImport({ cursor: batches[0]!.cursor } as never));
    expect(rest.map((b) => b.events.length)).toEqual([50, 20, 0]);
    expect(resumed.reads[0]!.query).toMatchObject({ after: Buffer.from("offset:50").toString("base64url"), "createdAt[lte]": RECEIVED });
    expect(parseQuoCursor(rest.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: before(24) });
  });

  it("starts later syncs two days back, then from where each pass began, less a day", async () => {
    const data = workspace();
    const mock = quoDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const later = () => new Date(NOW().getTime() + 6 * HOUR_MS);
    data.calls[0]!.status = "missed";
    data.messages!.push(quoMessage.one({ createdAt: before(-3) }));
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // Each mode keeps its own checkpoint, so the first later sync looks back two days.
    expect(mock.reads[2]).toEqual({ kind: "calls", query: { "createdAt[gte]": before(42), "createdAt[lte]": before(-6), limit: "50" } });
    // The changed call and the new text; the unchanged call and the texts from 1 and 30 hours ago are duplicates.
    expect(sync.ingested).toBe(2);
    expect(sync.duplicates).toBe(3);
    expect(parseQuoCursor(sync.cursor)).toEqual({ pass: null, done: false, nextFrom: before(18) });
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads[4]!.query["createdAt[gte]"]).toBe(before(18));
    expect(QUO_OVERLAP_MS).toBe(24 * HOUR_MS);
  });

  it("looks back two days on a first sync with no checkpoint", async () => {
    const mock = quoDocMock(workspace());
    const batches = await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(mock.reads[0]!.query["createdAt[gte]"]).toBe(before(48));
    expect(eventsOf(batches)).toHaveLength(4);
    expect(parseQuoCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: false, nextFrom: before(24) });
    expect(QUO_FIRST_LOOKBACK_MS).toBe(48 * HOUR_MS);
  });

  it("keeps saying the import is done through a later sync's pages", async () => {
    quoCall.reset();
    const mock = quoDocMock({ apiKey: KEY, calls: Array.from({ length: QUO_PAGE_SIZE + 1 }, (_, i) => quoCall.one({ createdAt: before(1 + i / 100) })) });
    const cursor = JSON.stringify({ pass: null, done: true, nextFrom: before(26) } satisfies QuoCursor);
    const batches = await drain(connector(mock).incrementalSync({ cursor } as never));
    expect(batches.map((b) => parseQuoCursor(b.cursor ?? null)!.done)).toEqual([true, true, true]);
    expect(eventsOf(batches)).toHaveLength(QUO_PAGE_SIZE + 1);
  });

  it("resumes a later sync part way, keeping what it says of the import", async () => {
    const mock = quoDocMock(workspace());
    const cursor = JSON.stringify({ pass: { from: before(30), until: before(2), step: 1, after: null }, done: true, nextFrom: before(26) } satisfies QuoCursor);
    const batches = await drain(connector(mock).incrementalSync({ cursor } as never));
    expect(mock.reads).toEqual([{ kind: "messages", query: { "createdAt[gt]": before(30), "createdAt[lt]": before(2), limit: "50" } }]);
    expect(parseQuoCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: before(26) });
  });

  it("dead-letters what it can't read and carries on", async () => {
    const mock = quoDocMock(workspace({ calls: [quoCall.one({ createdAt: before(2), status: "lost" }), quoCall.one({ createdAt: before(3) })], messages: [] }));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(1);
    expect(report.deadLettered).toBe(1);
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = quoDocMock(workspace({ rateLimits: 2 }));
    const slept: number[] = [];
    await drain(connector(mock, { sleep: async (ms) => void slept.push(ms) }).incrementalSync({ cursor: null } as never));
    expect(slept).toEqual([1000, 2000]);
  });

  it("stops on a turned-down key", async () => {
    const mock = quoDocMock(workspace({ apiKey: "z".repeat(32) }));
    await expect(drain(connector(mock).incrementalSync({ cursor: null } as never))).rejects.toMatchObject({ status: 401 });
  });

  it("checks its settings", () => {
    const mock = quoDocMock(workspace());
    expect(() => connector(mock, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY");
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { apiKey: "x" })).toThrow("QUO_API_KEY");
    expect(() => connector(mock, { apiKey: "x", client: {} as QuoClient })).not.toThrow();
    expect(connector(mock).source).toBe("openphone");
  });

  it("reads back as far as told, and up to now when no clock is given", async () => {
    const mock = quoDocMock(workspace());
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(mock.reads[0]!.query["createdAt[gte]"]).toBe("2025-11-10T15:00:00.000Z");
    const untils: string[] = [];
    const client: QuoClient = { page: async (_k, q) => (untils.push(q.until), { rows: [], next: null }) };
    const t0 = Date.now();
    await drain(quoConnector({ apiKey: KEY, customerKey: CUSTOMER_KEY, client }).incrementalSync({ cursor: null } as never));
    expect(Date.parse(untils[0]!)).toBeGreaterThanOrEqual(t0);
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(QUO_WRITES.map((w) => w.name)).toEqual(["send_text", "add_contact_note"]);
    const c = connector(quoDocMock(workspace()));
    expect(c.writes).toBe(QUO_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "send_text", integration: "openphone", outcome: "refused" },
      { action: "add_contact_note", integration: "openphone", outcome: "refused" },
    ]);
  });
});

describe("Quo doc mock", () => {
  it("wants the version header and the raw key, and checks its filters", async () => {
    const mock = quoDocMock(workspace());
    const get = (path: string, headers: Record<string, string> = { authorization: KEY, "quo-api-version": "2026-03-30" }) => mock.fetch(`https://api.quo.com${path}`, { headers });
    expect((await get("/calls", { authorization: KEY })).status).toBe(400);
    expect((await get("/calls", { authorization: `Bearer ${KEY}`, "quo-api-version": "2026-03-30" })).status).toBe(401);
    expect((await get("/calls?createdAt[gt]=2026-01-01T00:00:00Z")).status).toBe(400);
    expect((await get("/calls?limit=51")).status).toBe(400);
    expect((await get("/calls?createdAt[gte]=2026-01-01")).status).toBe(400);
    expect((await get("/calls?after=!!")).status).toBe(400);
    const page = (await (await get("/messages?limit=2")).json()) as { data: { createdAt: string }[]; nextCursor: string };
    expect(page.data.map((m) => m.createdAt)).toEqual([before(1), before(30)]);
    expect(page.nextCursor).toBe(Buffer.from("offset:2").toString("base64url"));
  });
});
