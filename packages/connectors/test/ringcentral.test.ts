import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import {
  RINGCENTRAL_TEST_NUMBER,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  ringCentralCall,
  ringCentralCustomerNumber,
  ringCentralDocMock,
  ringCentralText,
  ringCentralVoicemail,
  testPipeline,
  type RingCentralMock,
  type RingCentralMockData,
} from "@karatos/connector-testkit";
import {
  RINGCENTRAL_CALL_EVENT,
  RINGCENTRAL_FIRST_LOOKBACK_MS,
  RINGCENTRAL_MESSAGE_EVENT,
  RINGCENTRAL_OVERLAP_MS,
  RINGCENTRAL_PAGE_SIZE,
  RINGCENTRAL_READ_SCOPES,
  RINGCENTRAL_SERVER,
  RINGCENTRAL_WRITES,
  RingCentralApiError,
  RingCentralConfigError,
  formCustomerRefs,
  parseRingCentralCursor,
  ringCentralCallEvent,
  ringCentralClient,
  ringCentralConnector,
  ringCentralErrorCode,
  ringCentralMessageEvent,
  type RingCentralClient,
  type RingCentralCursor,
  type RingCentralEvent,
  type RingCentralOptions,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = ["rc", "client", "test"].join("");
const SECRET = ["rc", "secret", "0".repeat(24)].join("-");
const JWT = [`eyJ${"a".repeat(20)}`, "b".repeat(30), "c".repeat(40)].join(".");
const CUSTOMER_KEY = "c".repeat(40);
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const HOUR_MS = 3_600_000;
const noSleep = async () => {};

/** `ago` hours before NOW. */
const before = (ago: number) => new Date(NOW().getTime() - ago * HOUR_MS).toISOString();

/** Calls, texts and voicemail from 1, 30 and 5,000 hours ago, and from three years ago, past the two read. */
function account(overrides: Partial<RingCentralMockData> = {}): RingCentralMockData {
  ringCentralCall.reset();
  ringCentralText.reset();
  ringCentralVoicemail.reset();
  return {
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    jwt: JWT,
    calls: [1, 30, 5000, 26_400].map((ago) => ringCentralCall.one({ startTime: before(ago) })),
    messages: [
      ...[1, 30, 5000, 26_400].map((ago) => ringCentralText.one({ creationTime: before(ago), lastModifiedTime: before(ago) })),
      ringCentralVoicemail.one({ creationTime: before(2), lastModifiedTime: before(2) }),
    ],
    ...overrides,
  };
}

const connector = (mock: RingCentralMock, overrides: Partial<RingCentralOptions> = {}) =>
  ringCentralConnector({ clientId: CLIENT_ID, clientSecret: SECRET, jwt: JWT, customerKey: CUSTOMER_KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });

const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as RingCentralEvent[];

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string;
}

/** A fetch that answers in turn and records what was sent. */
function scripted(...answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? "") });
    return answers[Math.min(sent.length - 1, answers.length - 1)]!();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const text = (status: number, body: string) => () => new Response(body, { status });
const TOKEN = { access_token: "tok-1", expires_in: 3600, scope: "ReadCallLog ReadMessages" };
const signedIn = json(200, TOKEN);
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof ringCentralClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = ringCentralClient({ clientId: CLIENT_ID, clientSecret: SECRET, jwt: JWT, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const Q = { from: "2026-11-01T00:00:00.000Z", until: "2026-11-11T15:00:00.000Z", page: 1 };
const PAGE = { records: [], navigation: {}, paging: { page: 1, totalPages: 1 } };

describe("RingCentral client", () => {
  it("checks its settings before sending anything", () => {
    const { fetch, sent } = scripted(signedIn);
    const make = (extra: Record<string, string>) => () => ringCentralClient({ clientId: CLIENT_ID, clientSecret: SECRET, jwt: JWT, fetch, ...extra });
    for (const clientId of ["", "short", "x".repeat(7), "x".repeat(65), "has space1", "a/b/c/d/e"]) expect(make({ clientId })).toThrow("RINGCENTRAL_CLIENT_ID is missing or not in the expected shape");
    for (const clientSecret of ["", "s".repeat(15), "s".repeat(257), `${"s".repeat(20)} x`]) expect(make({ clientSecret })).toThrow("RINGCENTRAL_CLIENT_SECRET is missing or not in the expected shape");
    for (const jwt of ["", "a.b", ".b.c", "a.b.", "a.b.c.d", "a..c", `${JWT} `.replace(/ $/, "!"), `a.${"b".repeat(4097)}.c`, `${"a".repeat(2049)}.b.c`, `a.b.${"c".repeat(2049)}`, "a.b+.c"]) expect(make({ jwt })).toThrow("RINGCENTRAL_JWT is missing or not a JWT credential");
    expect(() => ringCentralClient({ clientId: undefined as never, clientSecret: SECRET, jwt: JWT })).toThrow("RINGCENTRAL_CLIENT_ID");
    expect(() => ringCentralClient({ clientId: CLIENT_ID, clientSecret: undefined as never, jwt: JWT })).toThrow("RINGCENTRAL_CLIENT_SECRET");
    expect(() => ringCentralClient({ clientId: CLIENT_ID, clientSecret: SECRET, jwt: undefined as never })).toThrow("RINGCENTRAL_JWT");
    // Settings are trimmed, and the longest ones fit.
    expect(make({ clientId: ` ${"x".repeat(64)} `, clientSecret: "s".repeat(256), jwt: `${"a".repeat(2048)}.${"b".repeat(4096)}.${"c".repeat(2048)}` })).not.toThrow();
    expect(make({ clientId: "x".repeat(8), clientSecret: ` ${"s".repeat(16)}\n` })).not.toThrow();
    expect(sent).toEqual([]);
  });

  it("signs in with the JWT grant and Basic auth, then lists calls with a bearer token", async () => {
    const { fetch, sent } = scripted(signedIn, json(200, PAGE));
    const { c } = client(fetch, { clientId: ` ${CLIENT_ID} `, clientSecret: ` ${SECRET} `, jwt: ` ${JWT} ` });
    expect(await c.page("calls", Q)).toEqual({ rows: [], next: null });
    expect(sent[0]).toEqual({
      url: `${RINGCENTRAL_SERVER}/restapi/oauth/token`,
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: JWT }).toString(),
    });
    expect(sent[1]).toEqual({
      url: `${RINGCENTRAL_SERVER}/restapi/v1.0/account/~/extension/~/call-log?dateFrom=${encodeURIComponent(Q.from)}&dateTo=${encodeURIComponent(Q.until)}&perPage=250&page=1&view=Simple`,
      method: "GET",
      headers: { Authorization: "Bearer tok-1", Accept: "application/json" },
      body: "",
    });
    expect(RINGCENTRAL_PAGE_SIZE).toBe(250);
  });

  it("lists texts and voicemail only from the message store", async () => {
    const { fetch, sent } = scripted(signedIn, json(200, PAGE));
    await client(fetch).c.page("messages", { ...Q, page: 3 });
    const url = new URL(sent[1]!.url);
    expect(url.pathname).toBe("/restapi/v1.0/account/~/extension/~/message-store");
    expect([...url.searchParams]).toEqual([["dateFrom", Q.from], ["dateTo", Q.until], ["perPage", "250"], ["page", "3"], ["messageType", "SMS"], ["messageType", "VoiceMail"]]);
  });

  it("says there is a next page when the answer links one or counts more pages", async () => {
    const answer = async (body: unknown, page = 2) => {
      const { fetch } = scripted(signedIn, json(200, body));
      return (await client(fetch).c.page("calls", { ...Q, page })).next;
    };
    expect(await answer({ records: [], navigation: { nextPage: { uri: "x" } } })).toBe(3);
    expect(await answer({ records: [], navigation: { nextPage: "x" } })).toBeNull();
    expect(await answer({ records: [], navigation: null, paging: { totalPages: 3 } })).toBe(3);
    expect(await answer({ records: [], paging: { totalPages: 2 } })).toBeNull();
    expect(await answer({ records: [], paging: { totalPages: 2.5 } })).toBeNull();
    expect(await answer({ records: [], paging: { totalPages: "9" } })).toBeNull();
    expect(await answer({ records: [], paging: [9] })).toBeNull();
    expect(await answer({ records: [] })).toBeNull();
  });

  it("keeps the rows as RingCentral sent them", async () => {
    const rows = [{ id: "a" }, { id: "b" }];
    const { fetch } = scripted(signedIn, json(200, { records: rows }));
    expect((await client(fetch).c.page("messages", Q)).rows).toEqual(rows);
  });

  it("checks times and pages before sending", async () => {
    const { fetch, sent } = scripted(signedIn, json(200, PAGE));
    const { c } = client(fetch);
    for (const bad of [{ from: "2026-11-01" }, { until: "2026-11-11T15:00:00Z" }, { from: Q.until }, { from: "2026-11-12T00:00:00.000Z" }, { from: `x${Q.from}` }, { from: `0${Q.from}` }, { until: `${Q.until}x` }]) {
      await expect(c.page("calls", { ...Q, ...bad })).rejects.toThrow("calls must be listed between two UTC times");
    }
    for (const page of [0, -1, 1.5, 1001, Number.NaN]) await expect(c.page("messages", { ...Q, page })).rejects.toThrow("messages page is out of range");
    await expect(c.page("calls", { ...Q, page: 0 })).rejects.toMatchObject({ status: 0 });
    await expect(c.page("calls", { ...Q, from: "x" })).rejects.toMatchObject({ status: 0 });
    expect(sent).toEqual([]);
    await c.page("calls", { ...Q, page: 1000 });
    expect(new URL(sent[1]!.url).searchParams.get("page")).toBe("1000");
  });

  it("says when a page has no records list or isn't a JSON object", async () => {
    for (const body of [{ records: {} }, {}]) {
      const { fetch } = scripted(signedIn, json(200, body));
      await expect(client(fetch).c.page("calls", Q)).rejects.toThrow("RingCentral answered the extension's calls without the records list");
    }
    for (const answer of [json(200, []), json(200, null), text(200, "<html>")]) {
      const { fetch } = scripted(signedIn, answer);
      await expect(client(fetch).c.page("messages", Q)).rejects.toThrow(new RingCentralApiError("RingCentral answered the extension's messages with a body that isn't a JSON object", 200));
    }
  });

  it("stops before reading when the token can do more than read, or doesn't say", async () => {
    for (const scope of ["ReadCallLog SMS", "ReadMessages EditMessages RingOut", "ReadCallRecording", "A B C D E F G"]) {
      const { fetch, sent } = scripted(json(200, { ...TOKEN, scope }));
      const extra = scope.split(" ").filter((s) => !(RINGCENTRAL_READ_SCOPES as readonly string[]).includes(s));
      await expect(client(fetch).c.page("calls", Q)).rejects.toThrow(new RingCentralConfigError(`the app has ${extra.slice(0, 5).join(", ")}; KaratOS only reads, so give the app ReadCallLog and ReadMessages and nothing else`));
      expect(sent).toHaveLength(1);
    }
    for (const scope of [undefined, 5, ["ReadCallLog"]]) {
      const { fetch, sent } = scripted(json(200, { ...TOKEN, scope }));
      await expect(client(fetch).c.page("calls", Q)).rejects.toThrow("RingCentral's sign-in didn't say which permissions the app has, so KaratOS can't tell that it only reads");
      expect(sent).toHaveLength(1);
    }
    // Every read permission is fine, as is an empty list, and extra spaces.
    for (const scope of [RINGCENTRAL_READ_SCOPES.join(" "), "", "  ReadCallLog   ReadMessages "]) {
      const { fetch } = scripted(json(200, { ...TOKEN, scope }), json(200, PAGE));
      await expect(client(fetch).c.page("calls", Q)).resolves.toEqual({ rows: [], next: null });
    }
    expect(RINGCENTRAL_READ_SCOPES).toEqual(["ReadCallLog", "ReadMessages", "ReadAccounts", "ReadContacts", "ReadPresence"]);
  });

  it("explains a turned-down sign-in, with RingCentral's error code", async () => {
    const hint = "check RINGCENTRAL_CLIENT_ID, RINGCENTRAL_CLIENT_SECRET and RINGCENTRAL_JWT, and that the app allows the JWT auth flow";
    for (const status of [400, 401]) {
      const { fetch } = scripted(json(status, { error: "invalid_grant", errors: [{ errorCode: "OAU-251" }] }));
      await expect(client(fetch).c.page("calls", Q)).rejects.toThrow(new RingCentralConfigError(`RingCentral turned down the sign-in (OAU-251): ${hint}`));
    }
    const { fetch } = scripted(text(401, "no"));
    await expect(client(fetch).c.page("calls", Q)).rejects.toThrow(new RingCentralConfigError(`RingCentral turned down the sign-in: ${hint}`));
    const { fetch: down } = scripted(json(503, { errorCode: "CMN-211" }));
    await expect(client(down).c.page("calls", Q)).rejects.toMatchObject({ name: "RingCentralApiError", message: "RingCentral answered HTTP 503 to the sign-in", status: 503, code: "CMN-211" });
    const { fetch: made } = scripted(json(201, TOKEN), json(200, PAGE));
    await expect(client(made).c.page("calls", Q)).rejects.toMatchObject({ message: "RingCentral answered HTTP 201 to the sign-in", status: 201 });
  });

  it("says when a sign-in has no access token that reads", async () => {
    for (const reply of [{ ...TOKEN, access_token: undefined }, { ...TOKEN, access_token: "" }, { ...TOKEN, access_token: "has space" }, { ...TOKEN, access_token: "t".repeat(4097) }, { ...TOKEN, access_token: 5 }, [TOKEN], null]) {
      const { fetch } = scripted(json(200, reply));
      await expect(client(fetch).c.page("calls", Q)).rejects.toThrow(new RingCentralApiError("RingCentral's sign-in had no access token in the expected shape", 200));
    }
    const { fetch } = scripted(text(200, "x"));
    await expect(client(fetch).c.page("calls", Q)).rejects.toThrow("RingCentral's sign-in had no access token in the expected shape");
    const { fetch: long, sent } = scripted(json(200, { ...TOKEN, access_token: "t".repeat(4096) }), json(200, PAGE));
    await client(long).c.page("calls", Q);
    expect(sent[1]!.headers.Authorization).toBe(`Bearer ${"t".repeat(4096)}`);
  });

  it("reuses its token until five minutes before it ends, then signs in again", async () => {
    let at = Date.parse("2026-11-11T00:00:00Z");
    const { fetch, sent } = scripted(signedIn, json(200, PAGE), json(200, PAGE), json(200, { ...TOKEN, access_token: "tok-2" }), json(200, PAGE));
    const { c } = client(fetch, { now: () => new Date(at) });
    await c.page("calls", Q);
    at += 55 * 60_000 - 1;
    await c.page("calls", Q);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET"]);
    at += 1;
    await c.page("calls", Q);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
    expect(sent[4]!.headers.Authorization).toBe("Bearer tok-2");
  });

  it("signs in for every read when the token says no lifetime", async () => {
    for (const expires_in of [undefined, "3600", null]) {
      const { fetch, sent } = scripted(json(200, { ...TOKEN, expires_in }), json(200, PAGE), json(200, { ...TOKEN, expires_in }), json(200, PAGE));
      const { c } = client(fetch);
      await c.page("calls", Q);
      await c.page("calls", Q);
      expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
    }
  });

  it("signs in again once on a 401, and gives up on a second", async () => {
    const { fetch, sent } = scripted(signedIn, json(401, {}), json(200, { ...TOKEN, access_token: "tok-2" }), json(200, PAGE));
    await client(fetch).c.page("calls", Q);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
    expect(sent[3]!.headers.Authorization).toBe("Bearer tok-2");
    const { fetch: twice, sent: sent2 } = scripted(signedIn, json(401, { errorCode: "TokenInvalid" }), signedIn, json(401, { errorCode: "TokenInvalid" }), signedIn, json(200, PAGE));
    await expect(client(twice).c.page("calls", Q)).rejects.toMatchObject({ message: "RingCentral turned down the app's token twice", status: 401, code: "TokenInvalid" });
    expect(sent2).toHaveLength(4);
  });

  it("names the permission a 403 is missing, and reports other errors with RingCentral's code", async () => {
    const { fetch } = scripted(signedIn, json(403, {}));
    await expect(client(fetch).c.page("calls", Q)).rejects.toThrow(new RingCentralConfigError("the app isn't allowed to read the extension's calls: give it ReadCallLog"));
    const { fetch: f2 } = scripted(signedIn, json(403, {}));
    await expect(client(f2).c.page("messages", Q)).rejects.toThrow(new RingCentralConfigError("the app isn't allowed to read the extension's messages: give it ReadMessages"));
    const { fetch: f3 } = scripted(signedIn, json(400, { errorCode: "CMN-101" }));
    await expect(client(f3).c.page("messages", Q)).rejects.toMatchObject({ name: "RingCentralApiError", message: "RingCentral answered HTTP 400 for the extension's messages", status: 400, code: "CMN-101" });
    const { fetch: f4 } = scripted(signedIn, json(206, PAGE));
    await expect(client(f4).c.page("calls", Q)).rejects.toMatchObject({ status: 206 });
  });

  it("reads RingCentral's error code only when it is short and plain", () => {
    expect(ringCentralErrorCode({ errorCode: "CMN-102" })).toBe("CMN-102");
    expect(ringCentralErrorCode({ errors: [{ errorCode: "OAU-251" }] })).toBe("OAU-251");
    expect(ringCentralErrorCode({ error: "invalid_grant" })).toBe("invalid_grant");
    expect(ringCentralErrorCode({ errorCode: "CMN-102", errors: [{ errorCode: "x" }], error: "y" })).toBe("CMN-102");
    expect(ringCentralErrorCode({ errors: [{ errorCode: "OAU-251" }], error: "y" })).toBe("OAU-251");
    expect(ringCentralErrorCode({ errors: [], error: "y" })).toBe("y");
    expect(ringCentralErrorCode({ errors: {}, error: "y" })).toBe("y");
    for (const body of [undefined, null, {}, { errorCode: "a b" }, { errorCode: "x".repeat(41) }, { errorCode: "" }, { errorCode: 5 }, { errors: "CMN-1" }, { error: "<script>" }]) expect(ringCentralErrorCode(body)).toBeUndefined();
    expect(ringCentralErrorCode({ errorCode: "x".repeat(40) })).toBe("x".repeat(40));
  });

  it("waits out rate limits as Retry-After says, up to a minute, or backs off", async () => {
    const limited = (after?: string) => json(429, {}, after === undefined ? {} : { "Retry-After": after });
    const { fetch, sent } = scripted(signedIn, limited("3"), limited("600"), limited(), json(200, PAGE));
    const { c, slept } = client(fetch);
    await c.page("calls", Q);
    expect(slept).toEqual([3000, 60_000, 4000]);
    expect(sent).toHaveLength(5);
    const { fetch: f2 } = scripted(signedIn, limited("0"), limited("soon"), limited("-5"), json(200, PAGE));
    const r2 = client(f2);
    await r2.c.page("calls", Q);
    expect(r2.slept).toEqual([1000, 2000, 4000]);
  });

  it("retries 503 and 504 too, then gives up", async () => {
    const { fetch, sent } = scripted(signedIn, json(503, {}), json(504, {}), json(503, {}), json(504, { errorCode: "CMN-211" }));
    const { c, slept } = client(fetch);
    await expect(c.page("calls", Q)).rejects.toMatchObject({ status: 504, code: "CMN-211" });
    expect(slept).toEqual([1000, 2000, 4000]);
    expect(sent).toHaveLength(5);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const { fetch, sent } = scripted(signedIn, json(500, {}));
    await expect(client(fetch).c.page("calls", Q)).rejects.toMatchObject({ status: 500 });
    expect(sent).toHaveLength(2);
    const { fetch: f2, sent: s2 } = scripted(signedIn, json(429, {}));
    const r = client(f2, { retries: 1 });
    await expect(r.c.page("calls", Q)).rejects.toMatchObject({ status: 429 });
    expect(s2).toHaveLength(3);
    expect(r.slept).toEqual([1000]);
    const { fetch: f3, sent: s3 } = scripted(signedIn, json(429, {}));
    await expect(client(f3, { retries: 0 }).c.page("calls", Q)).rejects.toMatchObject({ status: 429 });
    expect(s3).toHaveLength(2);
  });

  it("a 401 doesn't use up a retry", async () => {
    const { fetch, sent } = scripted(signedIn, json(401, {}), signedIn, json(429, {}), json(429, {}), json(429, {}), json(200, PAGE));
    const { c, slept } = client(fetch);
    await expect(c.page("calls", Q)).resolves.toEqual({ rows: [], next: null });
    expect(slept).toEqual([1000, 2000, 4000]);
    expect(sent).toHaveLength(7);
  });

  it("a 401 after a retry still signs in again just once", async () => {
    const { fetch, sent } = scripted(signedIn, json(503, {}), json(401, {}), signedIn, json(200, PAGE));
    const { c, slept } = client(fetch, { retries: 1 });
    await c.page("calls", Q);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
    expect(slept).toEqual([1000]);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(signedIn, json(429, {}, { "Retry-After": "0.001" }), json(200, PAGE));
    globalThis.fetch = fetch;
    try {
      await ringCentralClient({ clientId: CLIENT_ID, clientSecret: SECRET, jwt: JWT }).page("calls", Q);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(3);
  });

  it("only ever signs in and sends GETs to the call log and message store", async () => {
    const mock = ringCentralDocMock(account());
    await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(mock.signIns).toBe(1);
    expect(mock.reads.map((r) => r.kind)).toEqual(["calls", "messages"]);
  });
});

describe("RingCentral events", () => {
  const ctx = { customerKey: CUSTOMER_KEY, receivedAt: RECEIVED };
  const call = (extra: Record<string, unknown> = {}) => {
    ringCentralCall.reset();
    return { ...ringCentralCall.one({}), ...extra };
  };
  const sms = (extra: Record<string, unknown> = {}) => {
    ringCentralText.reset();
    return { ...ringCentralText.one({}), ...extra };
  };
  const voicemail = (extra: Record<string, unknown> = {}) => {
    ringCentralVoicemail.reset();
    return { ...ringCentralVoicemail.one({}), ...extra };
  };
  const refs = (n: number) => formCustomerRefs(CUSTOMER_KEY, { phone: ringCentralCustomerNumber(n) });

  it("logs a call as Quo's do, with the caller as a customer reference and no number or name", () => {
    const { ok, event } = ringCentralCallEvent(call(), ctx);
    expect(ok).toBe(true);
    expect(event.type).toBe(RINGCENTRAL_CALL_EVENT);
    expect(event.occurredAt).toBe("2026-01-01T00:01:00.000Z");
    expect(event.receivedAt).toBe(RECEIVED);
    expect(event.payload).toEqual({
      system: "RingCentral",
      channel: "voice",
      callId: "ringcentral:call:CLtest1",
      customerRefs: refs(1),
      withheldCaller: false,
      direction: "inbound",
      action: "Phone Call",
      result: "Accepted",
      missed: false,
      durationSeconds: 240,
      startedAt: "2026-01-01T00:01:00.000Z",
    });
    expect(event.idempotencyKey).toMatch(/^ringcentral:call:CLtest1:[0-9a-f]{12}$/);
    expect(event.id).toBe(event.idempotencyKey.replace(/:/g, "_"));
    const all = JSON.stringify(event);
    expect(all).not.toContain(ringCentralCustomerNumber(1));
    expect(all).not.toContain("Test Customer");
    expect(all).not.toContain("New York");
    expect(all).not.toContain("s-test");
  });

  it("takes the customer of an outgoing call from who the store called", () => {
    const { event } = ringCentralCallEvent(call({ direction: "Outbound", from: { phoneNumber: RINGCENTRAL_TEST_NUMBER }, to: { phoneNumber: ringCentralCustomerNumber(7) } }), ctx);
    expect(event.payload).toMatchObject({ direction: "outbound", customerRefs: refs(7), missed: false });
    expect(ringCentralCallEvent(call({ direction: "Outbound", result: "Missed" }), ctx).event.payload.missed).toBe(false);
  });

  it("marks an incoming call nobody picked up as missed", () => {
    for (const result of ["Missed", "Voicemail", "Rejected", "Busy", "No Answer", "Hang Up", "Abandoned", "Declined"]) {
      expect(ringCentralCallEvent(call({ result }), ctx).event.payload.missed).toBe(true);
    }
    for (const result of ["Accepted", "Call connected", "Unknown"]) expect(ringCentralCallEvent(call({ result }), ctx).event.payload.missed).toBe(false);
  });

  it("notes a withheld caller and a fax, and drops what doesn't read", () => {
    for (const from of [{}, { phoneNumber: 5 }, undefined, "x"]) {
      const { ok, event } = ringCentralCallEvent(call({ from }), ctx);
      expect(ok).toBe(true);
      expect(event.payload).toMatchObject({ withheldCaller: true, customerRefs: [] });
    }
    expect(ringCentralCallEvent(call({ from: { phoneNumber: "12345" } }), ctx).event.payload).toMatchObject({ withheldCaller: false, customerRefs: [] });
    expect(ringCentralCallEvent(call({ type: "Fax" }), ctx).event.payload.channel).toBe("fax");
    expect(ringCentralCallEvent(call({ type: "SMS" }), ctx).event.payload.channel).toBe("voice");
    for (const duration of [-1, 1.5, "60", undefined]) expect(ringCentralCallEvent(call({ duration }), ctx).event.payload.durationSeconds).toBeUndefined();
    expect(ringCentralCallEvent(call({ duration: 0 }), ctx).event.payload.durationSeconds).toBe(0);
    for (const action of ["<b>", "a<b>", 5, "9 calls", "x".repeat(41)]) expect(ringCentralCallEvent(call({ action }), ctx).event.payload.action).toBeUndefined();
    expect(ringCentralCallEvent(call({ action: `F${"i".repeat(39)}` }), ctx).event.payload.action).toBe(`F${"i".repeat(39)}`);
    expect(ringCentralCallEvent(call({ id: 77 }), ctx).event.payload.callId).toBe("ringcentral:call:77");
    const offset = ringCentralCallEvent(call({ startTime: "2026-01-01T05:00:00.5-05:00" }), ctx).event;
    expect(offset.occurredAt).toBe("2026-01-01T10:00:00.500Z");
    expect(offset.payload.startedAt).toBe("2026-01-01T10:00:00.500Z");
    // A call is dated by when it started, never by anything else.
    expect(ringCentralCallEvent(call({ startTime: undefined, endTime: "2026-01-01T00:05:00Z" }), ctx).ok).toBe(false);
  });

  it("logs a text as Quo's do, with its length but never its words", () => {
    const raw = sms();
    const { ok, event } = ringCentralMessageEvent(raw, ctx);
    expect(ok).toBe(true);
    expect(event.type).toBe(RINGCENTRAL_MESSAGE_EVENT);
    expect(event.occurredAt).toBe("2026-01-01T00:01:00.000Z");
    expect(event.payload).toEqual({
      system: "RingCentral",
      channel: "sms",
      messageId: "ringcentral:message:1001",
      conversationId: "ringcentral:conversation:2001",
      customerRefs: refs(1),
      direction: "inbound",
      status: "Received",
      read: false,
      deleted: false,
      textLength: String(raw.subject).length,
      voicemailSeconds: undefined,
      transcription: undefined,
      sentAt: "2026-01-01T00:01:00.000Z",
      changedAt: "2026-01-01T00:01:00.000Z",
    });
    expect(event.idempotencyKey).toMatch(/^ringcentral:message:1001:[0-9a-f]{12}$/);
    const all = JSON.stringify(event);
    expect(all).not.toContain("ring ready");
    expect(all).not.toContain("Test Customer");
    expect(all).not.toContain(ringCentralCustomerNumber(1));
  });

  it("logs a voicemail with how long it ran and whether it was transcribed, never its words", () => {
    const { ok, event } = ringCentralMessageEvent(voicemail(), ctx);
    expect(ok).toBe(true);
    expect(event.payload).toMatchObject({ channel: "voicemail", messageId: "ringcentral:message:4001", customerRefs: refs(1), voicemailSeconds: 32, transcription: "Completed", textLength: undefined });
    expect(event.payload.conversationId).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("Voice Message");
    expect(ringCentralMessageEvent(sms({ vmTranscriptionStatus: "Completed", attachments: [{ vmDuration: 5 }] }), ctx).event.payload).toMatchObject({ transcription: undefined, voicemailSeconds: undefined });
    const attachments = [{ type: "Text" }, "x", { vmDuration: -1 }, { vmDuration: 1.5 }, { vmDuration: 0 }, { vmDuration: 9 }];
    expect(ringCentralMessageEvent(voicemail({ attachments }), ctx).event.payload.voicemailSeconds).toBe(0);
    for (const attachments of [undefined, {}, [{ vmDuration: "32" }]]) expect(ringCentralMessageEvent(voicemail({ attachments }), ctx).event.payload.voicemailSeconds).toBeUndefined();
    expect(ringCentralMessageEvent(voicemail({ vmTranscriptionStatus: "<x>" }), ctx).event.payload.transcription).toBeUndefined();
  });

  it("takes the customers of an outgoing text from who it went to", () => {
    const to = [{ phoneNumber: ringCentralCustomerNumber(3) }, { phoneNumber: ringCentralCustomerNumber(4) }, "x", { phoneNumber: "short" }];
    const { event } = ringCentralMessageEvent(sms({ direction: "Outbound", from: { phoneNumber: ringCentralCustomerNumber(9) }, to }), ctx);
    expect(event.payload.customerRefs).toEqual([...refs(3), ...refs(4)].sort());
    expect(ringCentralMessageEvent(sms({ direction: "Outbound", to: undefined }), ctx).event.payload.customerRefs).toEqual([]);
    expect(ringCentralMessageEvent(sms({ from: undefined }), ctx).event.payload.customerRefs).toEqual([]);
  });

  it("notes a read, a deleted and a purged message, and drops what doesn't read", () => {
    expect(ringCentralMessageEvent(sms({ readStatus: "Read" }), ctx).event.payload.read).toBe(true);
    expect(ringCentralMessageEvent(sms({ readStatus: undefined }), ctx).event.payload.read).toBe(false);
    expect(ringCentralMessageEvent(sms({ availability: undefined }), ctx).event.payload.deleted).toBe(false);
    const late = ringCentralMessageEvent(sms({ creationTime: "2026-01-01T05:00:00.25-05:00", lastModifiedTime: "2026-01-02T00:00:00Z" }), ctx).event;
    expect(late.occurredAt).toBe("2026-01-01T10:00:00.250Z");
    expect(late.payload).toMatchObject({ sentAt: "2026-01-01T10:00:00.250Z", changedAt: "2026-01-02T00:00:00.000Z" });
    for (const availability of ["Deleted", "Purged"]) expect(ringCentralMessageEvent(sms({ availability }), ctx).event.payload.deleted).toBe(true);
    expect(ringCentralMessageEvent(sms({ availability: "Alive" }), ctx).event.payload.deleted).toBe(false);
    for (const subject of [undefined, 5]) expect(ringCentralMessageEvent(sms({ subject }), ctx).event.payload.textLength).toBeUndefined();
    expect(ringCentralMessageEvent(sms({ subject: "" }), ctx).event.payload.textLength).toBe(0);
    for (const conversationId of [undefined, "", 0, -3, "a b", 1.5]) expect(ringCentralMessageEvent(sms({ conversationId }), ctx).event.payload.conversationId).toBeUndefined();
    expect(ringCentralMessageEvent(sms({ conversationId: "cv_1-x" }), ctx).event.payload.conversationId).toBe("ringcentral:conversation:cv_1-x");
    expect(ringCentralMessageEvent(sms({ messageStatus: "<x>" }), ctx).event.payload.status).toBeUndefined();
    expect(ringCentralMessageEvent(sms({ lastModifiedTime: "later" }), ctx).event.payload.changedAt).toBeUndefined();
    expect(ringCentralMessageEvent(sms({ id: "x".repeat(64) }), ctx).ok).toBe(true);
  });

  it("is a duplicate when read again unchanged, and a new event when it changes", () => {
    const a = ringCentralMessageEvent(sms(), ctx).event;
    expect(ringCentralMessageEvent(sms(), { ...ctx, receivedAt: "2026-11-12T00:00:00.000Z" }).event.idempotencyKey).toBe(a.idempotencyKey);
    expect(ringCentralMessageEvent(sms({ readStatus: "Read" }), ctx).event.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(ringCentralCallEvent(call({ duration: 241 }), ctx).event.idempotencyKey).not.toBe(ringCentralCallEvent(call(), ctx).event.idempotencyKey);
  });

  it("dead-letters a call or message it can't read, saying why", () => {
    const bad = ringCentralCallEvent({ id: "a b", startTime: "2026-02-30T00:00:00Z", direction: "In", result: 5 }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.event.occurredAt).toBeUndefined();
    expect(bad.event.idempotencyKey).toMatch(/^ringcentral:unreadable_call:[0-9a-f]{12}$/);
    expect(bad.event.payload).toEqual({ system: "RingCentral", callId: null, problems: ["call has no id that reads", "call has no start time that reads", "call direction is not Inbound or Outbound", "call has no result that reads"] });
    expect(ringCentralCallEvent("x", ctx).event.payload.problems).toContain("call is not an object");
    // Two calls that can't be read for the same reasons are still two dead letters.
    expect(ringCentralCallEvent({ id: "a b" }, ctx).event.idempotencyKey).not.toBe(ringCentralCallEvent({ id: "c d" }, ctx).event.idempotencyKey);
    expect(ringCentralCallEvent(["x"], ctx).event.payload.problems).toContain("call is not an object");
    expect(ringCentralCallEvent(null, ctx).event.payload.problems).toContain("call is not an object");
    expect(ringCentralCallEvent(call({ result: undefined }), ctx).event.payload).toEqual({ system: "RingCentral", callId: "CLtest1", problems: ["call has no result that reads"] });
    for (const id of [0, -1, 1.5, "", "x".repeat(65)]) expect(ringCentralCallEvent(call({ id }), ctx).ok).toBe(false);
    const msg = ringCentralMessageEvent({ id: 5, type: "Fax", creationTime: "now", direction: "Outbound" }, ctx);
    expect(msg.event.payload).toEqual({ system: "RingCentral", messageId: "5", problems: ["message has no time that reads", "message is not a text or a voicemail"] });
    expect(msg.event.idempotencyKey).toMatch(/^ringcentral:unreadable_message:[0-9a-f]{12}$/);
    expect(ringCentralMessageEvent(7, ctx).event.payload.problems).toEqual(["message is not an object", "message has no id that reads", "message has no time that reads", "message direction is not Inbound or Outbound", "message is not a text or a voicemail"]);
    expect(ringCentralMessageEvent(sms({ type: "Pager" }), ctx).ok).toBe(false);
    expect(ringCentralMessageEvent(sms({ direction: "inbound" }), ctx).ok).toBe(false);
  });
});

describe("RingCentral checkpoint", () => {
  const pass = { from: before(30), until: before(2), step: 1, page: 3 };
  const cursor = (c: unknown) => JSON.stringify(c);

  it("round-trips and turns down any other shape", () => {
    expect(parseRingCentralCursor(null)).toBeNull();
    const good: RingCentralCursor[] = [{ pass, done: false, nextFrom: before(26) }, { pass: null, done: true, nextFrom: before(26) }, { pass: { ...pass, step: 0, page: 1 }, done: true, nextFrom: before(1) }];
    for (const c of good) expect(parseRingCentralCursor(cursor(c))).toEqual(c);
    const bad = [
      "",
      "x",
      "null",
      "[]",
      "5",
      cursor({ pass: null, done: "yes", nextFrom: before(26) }),
      cursor({ pass: null, done: true, nextFrom: "2026-11-01T00:00:00Z" }),
      cursor({ pass: null, done: true }),
      cursor({ pass: { ...pass, from: "x" }, done: false, nextFrom: before(26) }),
      cursor({ pass: { ...pass, until: undefined }, done: false, nextFrom: before(26) }),
      cursor({ pass: { ...pass, step: 2 }, done: false, nextFrom: before(26) }),
      cursor({ pass: { ...pass, step: "0" }, done: false, nextFrom: before(26) }),
      cursor({ pass: { ...pass, page: 0 }, done: false, nextFrom: before(26) }),
      cursor({ pass: { ...pass, page: 1.5 }, done: false, nextFrom: before(26) }),
      cursor({ pass: { ...pass, page: "2" }, done: false, nextFrom: before(26) }),
      cursor({ pass: "x", done: false, nextFrom: before(26) }),
      cursor({ pass: 5, done: false, nextFrom: before(26) }),
      cursor({ done: false, nextFrom: before(26) }),
    ];
    for (const raw of bad) expect(() => parseRingCentralCursor(raw), raw).toThrow("RingCentral checkpoint is not in the expected shape");
    // Only the fields it knows come back.
    expect(parseRingCentralCursor(cursor({ pass: { ...pass, extra: 1 }, done: false, nextFrom: before(26), more: 2 }))).toEqual({ pass, done: false, nextFrom: before(26) });
  });
});

describe("RingCentral connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(ringCentralDocMock(account())), expected: { ingested: 7 } });
    expect(result.full.ingested).toBe(7);
  });

  it("imports two years of calls, then texts and voicemail, then stops for good", async () => {
    const mock = ringCentralDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(7);
    const span = { dateFrom: "2024-11-11T15:00:00.000Z", dateTo: RECEIVED, perPage: "250", page: "1" };
    expect(mock.reads).toEqual([
      { kind: "calls", query: { ...span, view: "Simple" } },
      { kind: "messages", query: { ...span, messageType: "SMS,VoiceMail" } },
    ]);
    expect(memory.events.map((e) => e.type).sort()).toEqual([...Array(3).fill(RINGCENTRAL_CALL_EVENT), ...Array(4).fill(RINGCENTRAL_MESSAGE_EVENT)]);
    expect(memory.events.filter((e) => e.payload.channel === "voicemail")).toHaveLength(1);
    expect(parseRingCentralCursor(report.cursor)).toEqual({ pass: null, done: true, nextFrom: before(24) });
    assertSynthetic(memory.events);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(2);
  });

  it("reads 250 a page, keeping the page in the checkpoint, and resumes there", async () => {
    ringCentralCall.reset();
    const calls = Array.from({ length: 520 }, (_, i) => ringCentralCall.one({ startTime: before(1 + i / 100) }));
    const mock = ringCentralDocMock(account({ calls, messages: [] }));
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([250, 250, 20, 0]);
    expect(new Set(eventsOf(batches).map((e) => e.idempotencyKey)).size).toBe(520);
    const cursors = batches.map((b) => parseRingCentralCursor(b.cursor ?? null)!);
    const span = { from: "2024-11-11T15:00:00.000Z", until: RECEIVED };
    expect(cursors[0]).toEqual({ pass: { ...span, step: 0, page: 2 }, done: false, nextFrom: before(24) });
    expect(cursors[2]).toEqual({ pass: { ...span, step: 1, page: 1 }, done: false, nextFrom: before(24) });
    expect(cursors[3]).toEqual({ pass: null, done: true, nextFrom: before(24) });
    // Resumed after the first page, it reads the rest, even on a later clock.
    const resumed = ringCentralDocMock(account({ calls, messages: [] }));
    const later = () => new Date(NOW().getTime() + 5 * HOUR_MS);
    const rest = await drain(connector(resumed, { now: later }).historicalImport({ cursor: batches[0]!.cursor } as never));
    expect(rest.map((b) => b.events.length)).toEqual([250, 20, 0]);
    expect(resumed.reads[0]!.query).toMatchObject({ page: "2", dateTo: RECEIVED });
    expect(eventsOf(rest).every((e) => e.receivedAt === later().toISOString())).toBe(true);
    expect(parseRingCentralCursor(rest.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: before(24) });
  });

  it("goes on at the page the client names", async () => {
    const asked: number[] = [];
    const client: RingCentralClient = { page: async (kind, q) => (asked.push(q.page), { rows: [], next: kind === "calls" && q.page === 1 ? 5 : null }) };
    const batches = await drain(ringCentralConnector({ clientId: CLIENT_ID, clientSecret: SECRET, jwt: JWT, customerKey: CUSTOMER_KEY, client, now: NOW }).incrementalSync({ cursor: null } as never));
    expect(asked).toEqual([1, 5, 1]);
    expect(parseRingCentralCursor(batches[0]!.cursor ?? null)!.pass!.page).toBe(5);
  });

  it("pages by the page count when there is no next-page link, and by the link when there is no count", async () => {
    ringCentralText.reset();
    const messages = Array.from({ length: 260 }, (_, i) => ringCentralText.one({ creationTime: before(1 + i / 100) }));
    for (const omit of ["nextPage", "paging"] as const) {
      const mock = ringCentralDocMock(account({ calls: [], messages, omit }));
      const batches = await drain(connector(mock).incrementalSync({ cursor: null } as never));
      expect(batches.map((b) => b.events.length)).toEqual([0, 250, 10]);
    }
  });

  it("starts later syncs two days back, then from where each pass began, less a day", async () => {
    const data = account();
    const mock = ringCentralDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const later = () => new Date(NOW().getTime() + 6 * HOUR_MS);
    data.calls![0]!.result = "Missed";
    data.messages![0]!.readStatus = "Read";
    data.messages!.push(ringCentralText.one({ creationTime: before(-3) }));
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // Each mode keeps its own checkpoint, so the first later sync looks back two days.
    expect(mock.reads[2]).toEqual({ kind: "calls", query: { dateFrom: before(42), dateTo: before(-6), perPage: "250", page: "1", view: "Simple" } });
    // The changed call and text and the new text; the rest from the last two days are duplicates.
    expect(sync.ingested).toBe(3);
    expect(sync.duplicates).toBe(3);
    expect(parseRingCentralCursor(sync.cursor)).toEqual({ pass: null, done: false, nextFrom: before(18) });
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads[4]!.query.dateFrom).toBe(before(18));
    expect(RINGCENTRAL_OVERLAP_MS).toBe(24 * HOUR_MS);
  });

  it("looks back two days on a first sync with no checkpoint", async () => {
    const mock = ringCentralDocMock(account());
    const batches = await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(mock.reads[0]!.query.dateFrom).toBe(before(48));
    expect(eventsOf(batches)).toHaveLength(5);
    expect(parseRingCentralCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: false, nextFrom: before(24) });
    expect(RINGCENTRAL_FIRST_LOOKBACK_MS).toBe(48 * HOUR_MS);
  });

  it("keeps saying the import is done through a later sync's pages", async () => {
    ringCentralCall.reset();
    const mock = ringCentralDocMock({ ...account(), calls: Array.from({ length: RINGCENTRAL_PAGE_SIZE + 1 }, (_, i) => ringCentralCall.one({ startTime: before(1 + i / 1000) })), messages: [] });
    const cursor = JSON.stringify({ pass: null, done: true, nextFrom: before(26) } satisfies RingCentralCursor);
    const batches = await drain(connector(mock).incrementalSync({ cursor } as never));
    expect(batches.map((b) => parseRingCentralCursor(b.cursor ?? null)!.done)).toEqual([true, true, true]);
    expect(eventsOf(batches)).toHaveLength(RINGCENTRAL_PAGE_SIZE + 1);
  });

  it("resumes a later sync part way, keeping what it says of the import", async () => {
    const mock = ringCentralDocMock(account());
    const cursor = JSON.stringify({ pass: { from: before(30), until: before(2), step: 1, page: 1 }, done: true, nextFrom: before(26) } satisfies RingCentralCursor);
    const batches = await drain(connector(mock).incrementalSync({ cursor } as never));
    expect(mock.reads).toEqual([{ kind: "messages", query: { dateFrom: before(30), dateTo: before(2), perPage: "250", page: "1", messageType: "SMS,VoiceMail" } }]);
    expect(eventsOf(batches)).toHaveLength(2);
    expect(parseRingCentralCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: before(26) });
  });

  it("dead-letters what it can't read and carries on", async () => {
    const mock = ringCentralDocMock(account({ calls: [ringCentralCall.one({ startTime: before(2), direction: "Sideways" }), ringCentralCall.one({ startTime: before(3) })], messages: [] }));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(1);
    expect(report.deadLettered).toBe(1);
  });

  it("waits out a rate limit inside a sync, and signs in again when its token stops working", async () => {
    const mock = ringCentralDocMock(account({ rateLimits: 2, retryAfter: "2" }));
    const slept: number[] = [];
    const c = connector(mock, { sleep: async (ms) => void slept.push(ms) });
    await drain(c.incrementalSync({ cursor: null } as never));
    expect(slept).toEqual([2000, 2000]);
    mock.revokeTokens();
    await drain(c.incrementalSync({ cursor: null } as never));
    expect(mock.signIns).toBe(2);
  });

  it("stops on a turned-down credential, a token that can do more, or a missing permission", async () => {
    const wrong = ringCentralDocMock(account({ jwt: "x.y.z" }));
    await expect(drain(connector(wrong).incrementalSync({ cursor: null } as never))).rejects.toThrow(/RingCentral turned down the sign-in \(OAU-251\)/);
    const bigger = ringCentralDocMock(account({ scope: "ReadCallLog ReadMessages SMS" }));
    await expect(drain(connector(bigger).incrementalSync({ cursor: null } as never))).rejects.toThrow("the app has SMS; KaratOS only reads");
    expect(bigger.reads).toEqual([]);
    const silent = ringCentralDocMock(account({ scope: null }));
    await expect(drain(connector(silent).incrementalSync({ cursor: null } as never))).rejects.toThrow("didn't say which permissions");
    const forbidden = ringCentralDocMock(account({ forbidden: ["messages"] }));
    await expect(drain(connector(forbidden).incrementalSync({ cursor: null } as never))).rejects.toThrow("give it ReadMessages");
    const badSecret = ringCentralDocMock(account({ clientSecret: "z".repeat(32) }));
    await expect(drain(connector(badSecret).incrementalSync({ cursor: null } as never))).rejects.toThrow(/turned down the sign-in \(OAU-123\)/);
  });

  it("checks its settings", () => {
    const mock = ringCentralDocMock(account());
    expect(() => connector(mock, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY");
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { jwt: "x" })).toThrow("RINGCENTRAL_JWT");
    expect(() => connector(mock, { jwt: "x", client: {} as RingCentralClient })).not.toThrow();
    expect(connector(mock).source).toBe("ringcentral");
  });

  it("reads back as far as told, and up to now when no clock is given", async () => {
    const mock = ringCentralDocMock(account());
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(mock.reads[0]!.query.dateFrom).toBe("2025-11-11T15:00:00.000Z");
    const untils: string[] = [];
    const client: RingCentralClient = { page: async (_k, q) => (untils.push(q.until), { rows: [], next: null }) };
    const t0 = Date.now();
    await drain(ringCentralConnector({ clientId: CLIENT_ID, clientSecret: SECRET, jwt: JWT, customerKey: CUSTOMER_KEY, client }).incrementalSync({ cursor: null } as never));
    expect(Date.parse(untils[0]!)).toBeGreaterThanOrEqual(t0);
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(RINGCENTRAL_WRITES.map((w) => w.name)).toEqual(["send_text", "ring_out"]);
    const c = connector(ringCentralDocMock(account()));
    expect(c.writes).toBe(RINGCENTRAL_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "send_text", integration: "ringcentral", outcome: "refused" },
      { action: "ring_out", integration: "ringcentral", outcome: "refused" },
    ]);
  });
});

describe("RingCentral doc mock", () => {
  it("wants Basic auth, the JWT grant and a form body to sign in", async () => {
    const mock = ringCentralDocMock(account());
    const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`;
    const post = (headers: Record<string, string>, body: string) => mock.fetch(`${RINGCENTRAL_SERVER}/restapi/oauth/token`, { method: "POST", headers, body });
    const form = "application/x-www-form-urlencoded";
    const good = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: JWT }).toString();
    expect((await post({ "content-type": form }, good)).status).toBe(401);
    expect((await post({ authorization: basic, "content-type": "application/json" }, good)).status).toBe(415);
    expect((await post({ authorization: basic }, good)).status).toBe(415);
    expect((await post({ authorization: basic, "content-type": form }, "grant_type=password")).status).toBe(400);
    expect((await post({ authorization: basic, "content-type": form }, good)).status).toBe(200);
    expect(mock.signIns).toBe(1);
  });

  it("wants a token it issued, and checks the parameters and page size", async () => {
    const mock = ringCentralDocMock(account());
    const signIn = await mock.fetch(`${RINGCENTRAL_SERVER}/restapi/oauth/token`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: JWT }).toString(),
    });
    const { access_token } = (await signIn.json()) as { access_token: string };
    const get = (path: string, token = access_token) => mock.fetch(`${RINGCENTRAL_SERVER}/restapi/v1.0/account/~/extension/~/${path}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await get("call-log", "nope")).status).toBe(401);
    expect((await mock.fetch(`${RINGCENTRAL_SERVER}/restapi/v1.0/account/~/extension/~/call-log`)).status).toBe(401);
    expect((await get("call-log?withRecording=true")).status).toBe(400);
    expect((await get("call-log?dateFrom=2026-01-01")).status).toBe(400);
    expect((await get("call-log?dateTo=yesterday")).status).toBe(400);
    expect((await get("call-log?perPage=1001")).status).toBe(400);
    expect((await get("call-log?page=0")).status).toBe(400);
    const page = (await (await get("message-store?messageType=SMS&perPage=2")).json()) as { records: { creationTime: string }[]; paging: { totalPages: number }; navigation: Record<string, unknown> };
    expect(page.records.map((m) => m.creationTime)).toEqual([before(1), before(30)]);
    expect(page.paging.totalPages).toBe(2);
    expect(Object.keys(page.navigation)).toEqual(["firstPage", "nextPage", "lastPage"]);
    const second = (await (await get("message-store?messageType=SMS&perPage=2&page=2")).json()) as { navigation: Record<string, unknown> };
    expect(Object.keys(second.navigation)).toEqual(["firstPage", "previousPage", "lastPage"]);
    const all = (await (await get("call-log")).json()) as { records: unknown[] };
    expect(all.records).toHaveLength(4);
    expect(mock.reads.at(-1)).toEqual({ kind: "calls", query: {} });
  });

  it("lists nothing when it was given no calls or messages", async () => {
    const { calls: _c, messages: _m, ...bare } = account();
    const mock = ringCentralDocMock(bare);
    const { c } = client(mock.fetch);
    expect(await c.page("calls", Q)).toEqual({ rows: [], next: null });
    expect(await c.page("messages", Q)).toEqual({ rows: [], next: null });
  });

  it("answers 429 with or without Retry-After, and 403 for a list it forbids", async () => {
    const one = async (data: Partial<RingCentralMockData>) => {
      const mock = ringCentralDocMock(account(data));
      const { c } = client(mock.fetch, { retries: 0 });
      return c.page("calls", Q).catch((e: unknown) => e);
    };
    expect(await one({ rateLimits: 1 })).toMatchObject({ status: 429, code: "CMN-301" });
    expect(await one({ forbidden: ["calls"] })).toBeInstanceOf(RingCentralConfigError);
  });
});
