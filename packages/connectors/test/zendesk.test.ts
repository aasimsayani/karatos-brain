import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import {
  TEST_ORG,
  ZENDESK_DOC_PAGES,
  ZENDESK_TEST_AGENT,
  ZENDESK_TEST_SUBDOMAIN,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  synthetic,
  testPipeline,
  zendeskDocMock,
  zendeskTicket,
  zendeskUser,
  type ZendeskMock,
  type ZendeskMockData,
} from "@karatos/connector-testkit";
import {
  ZENDESK_CURSOR,
  ZENDESK_FIRST_LOOKBACK_S,
  ZENDESK_PAGE_SIZE,
  ZENDESK_PROFILE_EVENT,
  ZENDESK_READ_SCOPES,
  ZENDESK_REFRESH_LIFETIME_S,
  ZENDESK_SCOPES,
  ZENDESK_TICKET_EVENT,
  ZENDESK_WRITES,
  ZendeskApiError,
  ZendeskConfigError,
  formCustomerRefs,
  memoryTokenStore,
  parseZendeskCursor,
  zendeskClient,
  zendeskConnector,
  zendeskTicketEvent,
  zendeskTime,
  zendeskUserEvent,
  type ZendeskClient,
  type ZendeskCursor,
  type ZendeskEvent,
  type ZendeskOptions,
  type ZendeskPage,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = ["karatos", "test"].join("_");
const SECRET = ["zs", "secret", "0".repeat(24)].join("-");
const REFRESH = ["zr", "refresh", "1".repeat(24)].join("-");
const CUSTOMER_KEY = "c".repeat(40);
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const NOW_S = Math.floor(NOW().getTime() / 1000);
const RECEIVED = "2026-11-11T15:00:00.000Z";
const BASE = `https://${ZENDESK_TEST_SUBDOMAIN}.zendesk.com`;
const HOUR_MS = 3_600_000;
const noSleep = async () => {};
const ctx = { customerKey: CUSTOMER_KEY, receivedAt: RECEIVED };

/** `ago` hours before NOW, as Zendesk writes it. */
const before = (ago: number) => new Date(NOW().getTime() - ago * HOUR_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
const ms = (ago: number) => new Date(NOW().getTime() - ago * HOUR_MS).toISOString();

/** Tickets and customers that last changed 1, 30 and 5,000 hours ago, and six years ago, past the five read, plus an agent. */
function helpdesk(overrides: Partial<ZendeskMockData> = {}): ZendeskMockData {
  zendeskTicket.reset();
  zendeskUser.reset();
  const ages = [1, 30, 5000, 52_600];
  const tickets = ages.map((ago) => zendeskTicket.one({ created_at: before(ago + 1), updated_at: before(ago) }));
  const users = [...ages.map((ago) => zendeskUser.one({ created_at: before(ago + 1), updated_at: before(ago) })), zendeskUser.one({ id: ZENDESK_TEST_AGENT, role: "agent", updated_at: before(2) })];
  return { clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: REFRESH, tickets, users, now: NOW, ...overrides };
}

const connector = (mock: ZendeskMock, overrides: Partial<ZendeskOptions> = {}) =>
  zendeskConnector({ subdomain: ZENDESK_TEST_SUBDOMAIN, clientId: CLIENT_ID, clientSecret: SECRET, tokens: memoryTokenStore(mock.refreshToken), customerKey: CUSTOMER_KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });

const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as ZendeskEvent[];

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
const TOKEN = { access_token: "tok-1", token_type: "bearer", expires_in: 1800, refresh_token: "next-refresh-1", scope: "tickets:read users:read" };
const signedIn = json(201, TOKEN);
const PAGE = { tickets: [], after_cursor: "abc", end_of_stream: true };
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof zendeskClient>[0]> = {}) => {
  const slept: number[] = [];
  const tokens = memoryTokenStore(REFRESH);
  const c = zendeskClient({ subdomain: ZENDESK_TEST_SUBDOMAIN, clientId: CLIENT_ID, clientSecret: SECRET, tokens, fetch, now: NOW, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept, tokens };
};
const start = { start: NOW_S - 3600 };

describe("Zendesk client", () => {
  it("checks its settings before sending anything", () => {
    const { fetch, sent } = scripted(signedIn);
    const make = (extra: Record<string, string>) => () => zendeskClient({ subdomain: ZENDESK_TEST_SUBDOMAIN, clientId: CLIENT_ID, clientSecret: SECRET, tokens: memoryTokenStore(REFRESH), fetch, ...extra });
    for (const subdomain of ["", "-store", "store-", "store.zendesk.com", "a_b", "x".repeat(64), "https://store", "st ore"]) expect(make({ subdomain })).toThrow("ZENDESK_SUBDOMAIN must be the account's subdomain, such as store for store.zendesk.com");
    for (const clientId of ["", "x", "a b", "x".repeat(129), "a.b"]) expect(make({ clientId })).toThrow("ZENDESK_CLIENT_ID is missing or not in the expected shape");
    for (const clientSecret of ["", "s".repeat(15), "s".repeat(257), `${"s".repeat(16)} x`]) expect(make({ clientSecret })).toThrow("ZENDESK_CLIENT_SECRET is missing or not in the expected shape");
    expect(make({ subdomain: " TestStore ", clientId: "ab", clientSecret: "s".repeat(16) })).not.toThrow();
    expect(make({ clientId: "x".repeat(128), clientSecret: "s".repeat(256) })).not.toThrow();
    expect(make({ subdomain: "a" })).not.toThrow();
    expect(sent).toHaveLength(0);
    const nothing = { tokens: memoryTokenStore(REFRESH) } as unknown as Parameters<typeof zendeskClient>[0];
    expect(() => zendeskClient(nothing)).toThrow(ZendeskConfigError);
    expect(() => zendeskClient({ ...nothing, subdomain: "a" })).toThrow("ZENDESK_CLIENT_ID");
    expect(() => zendeskClient({ ...nothing, subdomain: "a", clientId: "ab" })).toThrow("ZENDESK_CLIENT_SECRET");
  });

  it("trims its settings before using them", async () => {
    const padded = scripted(signedIn, json(200, PAGE));
    await zendeskClient({ subdomain: ZENDESK_TEST_SUBDOMAIN, clientId: ` ${CLIENT_ID} `, clientSecret: ` ${SECRET} `, tokens: memoryTokenStore(REFRESH), fetch: padded.fetch, now: NOW }).page("tickets", start);
    expect(JSON.parse(padded.sent[0]!.body)).toMatchObject({ client_id: CLIENT_ID, client_secret: SECRET });
  });

  it("refreshes with JSON and the two read scopes, saves the new refresh token, then reads an export", async () => {
    const { fetch, sent } = scripted(signedIn, json(200, { ...PAGE, tickets: [{ id: 1 }], after_cursor: "next=", end_of_stream: false }));
    const { c, tokens } = client(fetch, { subdomain: " TestStore " });
    expect(await c.page("tickets", start)).toEqual({ rows: [{ id: 1 }], cursor: "next=", end: false });
    expect(sent[0]).toEqual({ url: `${BASE}/oauth/tokens`, method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: sent[0]!.body });
    expect(JSON.parse(sent[0]!.body)).toEqual({ grant_type: "refresh_token", refresh_token: REFRESH, client_id: CLIENT_ID, client_secret: SECRET, scope: "tickets:read users:read", refresh_token_expires_in: 7_776_000 });
    expect(tokens.current).toBe("next-refresh-1");
    expect(sent[1]).toEqual({ url: `${BASE}/api/v2/incremental/tickets/cursor?start_time=${NOW_S - 3600}&per_page=1000`, method: "GET", headers: { Authorization: "Bearer tok-1", Accept: "application/json" }, body: "" });
    expect(ZENDESK_SCOPES).toEqual(["tickets:read", "users:read"]);
    expect(ZENDESK_PAGE_SIZE).toBe(1000);
    expect(ZENDESK_REFRESH_LIFETIME_S).toBe(90 * 86_400);
  });

  it("goes on from a cursor, reads the user export, and starts no later than a minute ago", async () => {
    const { fetch, sent } = scripted(json(200, TOKEN), json(200, { users: [], after_cursor: "b", end_of_stream: true }));
    const { c } = client(fetch);
    expect(await c.page("users", { cursor: "a+/=_.~-" })).toEqual({ rows: [], cursor: "b", end: true });
    expect(sent[1]!.url).toBe(`${BASE}/api/v2/incremental/users/cursor?cursor=a%2B%2F%3D_.%7E-&per_page=1000`);
    await c.page("users", { start: NOW_S });
    expect(new URL(sent[2]!.url).searchParams.get("start_time")).toBe(String(NOW_S - 60));
    await c.page("users", { start: NOW_S - 61 });
    expect(new URL(sent[3]!.url).searchParams.get("start_time")).toBe(String(NOW_S - 61));
    await c.page("users", { start: 0 });
    expect(new URL(sent[4]!.url).searchParams.get("start_time")).toBe("0");
  });

  it("checks cursors and starts before sending", async () => {
    const { fetch, sent } = scripted(signedIn);
    const { c } = client(fetch);
    for (const cursor of ["", "a b", "a&b", "x".repeat(2049)]) await expect(c.page("tickets", { cursor })).rejects.toThrow("Zendesk's export cursor isn't in the expected shape");
    for (const s of [-1, 1.5, Number.NaN, 2 ** 53]) await expect(c.page("tickets", { start: s })).rejects.toThrow("an export's start must be whole seconds since 1970");
    await expect(c.page("tickets", { cursor: "a b" })).rejects.toMatchObject({ status: 0, name: "ZendeskApiError" });
    expect(sent).toHaveLength(0);
    expect(ZENDESK_CURSOR.test("x".repeat(2048))).toBe(true);
  });

  it("says when an export has no list or end_of_stream, or a cursor that doesn't read", async () => {
    const bad: unknown[] = [null, [], "x", { tickets: {}, after_cursor: "a", end_of_stream: true }, { users: [], after_cursor: "a", end_of_stream: true }, { tickets: [], after_cursor: "a" }, { tickets: [], after_cursor: "a", end_of_stream: "true" }];
    for (const body of bad) {
      const { c } = client(scripted(signedIn, json(200, body)).fetch);
      await expect(c.page("tickets", start)).rejects.toThrow("Zendesk answered the tickets export without a list and end_of_stream");
    }
    const { c: notJson } = client(scripted(signedIn, text(200, "<html>")).fetch);
    await expect(notJson.page("tickets", start)).rejects.toThrow("without a list");
    for (const after_cursor of [undefined, 5, "a b", null]) {
      const { c } = client(scripted(signedIn, json(200, { tickets: [], ...(after_cursor === undefined ? {} : { after_cursor }), end_of_stream: false })).fetch);
      await expect(c.page("tickets", start)).rejects.toMatchObject({ message: "Zendesk's tickets export had no after_cursor in the expected shape", status: 200 });
    }
    for (const after_cursor of [undefined, 5, "a b"]) {
      const { c } = client(scripted(signedIn, json(200, { tickets: [], ...(after_cursor === undefined ? {} : { after_cursor }), end_of_stream: true })).fetch);
      await expect(c.page("tickets", start)).rejects.toThrow("after_cursor");
    }
    // Only a last page may have no cursor.
    const { c } = client(scripted(signedIn, json(200, { tickets: [{ id: 2 }], after_cursor: null, end_of_stream: true })).fetch);
    expect(await c.page("tickets", start)).toEqual({ rows: [{ id: 2 }], cursor: null, end: true });
  });

  it("stops before reading when the token has a scope that writes", async () => {
    for (const scope of ["read write", "tickets:write", "tickets:read impersonate", "users:read hc:write", "webhooks:read", 5, false, 0, ""]) {
      const { fetch, sent } = scripted(json(200, { ...TOKEN, scope }), json(200, PAGE));
      const { c, tokens } = client(fetch);
      if (scope === "") {
        await expect(c.page("tickets", start)).resolves.toMatchObject({ end: true });
        continue;
      }
      const err = await c.page("tickets", start).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ZendeskConfigError);
      expect((err as Error).message).toMatch(/^the token has .+; KaratOS only reads, so make a token with tickets:read and users:read only$/);
      expect(sent).toHaveLength(1);
      // The refresh token isn't saved from a token that is never used.
      expect(tokens.current).toBe(REFRESH);
    }
    const { c } = client(scripted(json(200, { ...TOKEN, scope: "read write impersonate a:write b:write c:write d:write" })).fetch);
    await expect(c.page("tickets", start)).rejects.toThrow("the token has write, impersonate, a:write, b:write, c:write; KaratOS");
    const { c: odd } = client(scripted(json(200, { ...TOKEN, scope: 5 })).fetch);
    await expect(odd.page("tickets", start)).rejects.toThrow("the token has (unreadable);");
    for (const scope of [ZENDESK_READ_SCOPES.join(" "), "  read  "]) {
      const { c: ok } = client(scripted(json(200, { ...TOKEN, scope }), json(200, PAGE)).fetch);
      await expect(ok.page("tickets", start)).resolves.toMatchObject({ end: true });
    }
    // An answer that doesn't list its scopes is used: the refresh asked for read scopes only.
    const { scope: _, ...unscoped } = TOKEN;
    const { c: bare } = client(scripted(json(200, unscoped), json(200, PAGE)).fetch);
    await expect(bare.page("tickets", start)).resolves.toMatchObject({ end: true });
  });

  it("explains a turned-down sign-in, and reports other sign-in errors", async () => {
    for (const status of [400, 401]) {
      const { c } = client(scripted(json(status, { error: "invalid_grant" })).fetch);
      const err = await c.page("tickets", start).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ZendeskConfigError);
      expect((err as Error).message).toBe("Zendesk turned down the sign-in: check ZENDESK_CLIENT_ID and ZENDESK_CLIENT_SECRET, and authorize the client again if the refresh token expired, was revoked or was already used");
    }
    for (const status of [202, 403, 500]) {
      const { c } = client(scripted(text(status, "")).fetch);
      await expect(c.page("tickets", start)).rejects.toMatchObject({ message: `Zendesk answered HTTP ${status} to the sign-in`, status, name: "ZendeskApiError" });
    }
  });

  it("says when a sign-in has no access token that reads, and checks the stored refresh token", async () => {
    for (const body of [null, [], { access_token: 5 }, { access_token: "" }, { access_token: "a b" }, { access_token: "x".repeat(4097) }]) {
      const { c } = client(scripted(json(200, body)).fetch);
      await expect(c.page("tickets", start)).rejects.toMatchObject({ message: "Zendesk's sign-in had no access token in the expected shape", status: 200 });
    }
    const { c: notJson } = client(scripted(text(200, "nope")).fetch);
    await expect(notJson.page("tickets", start)).rejects.toThrow("no access token");
    for (const stored of ["", "   ", "a b", "x".repeat(4097)]) {
      const { fetch, sent } = scripted(signedIn);
      const { c } = client(fetch, { tokens: memoryTokenStore(stored) });
      await expect(c.page("tickets", start)).rejects.toThrow(new ZendeskConfigError("ZENDESK_REFRESH_TOKEN is missing or not in the expected shape"));
      expect(sent).toHaveLength(0);
    }
    const { fetch, sent } = scripted(signedIn, json(200, PAGE));
    await client(fetch, { tokens: memoryTokenStore(` ${REFRESH} `) }).c.page("tickets", start);
    expect(JSON.parse(sent[0]!.body).refresh_token).toBe(REFRESH);
  });

  it("keeps the stored refresh token when the answer has none that reads", async () => {
    for (const refresh_token of [undefined, 5, "", "a b"]) {
      const { refresh_token: _, ...rest } = TOKEN;
      const { c, tokens } = client(scripted(json(200, { ...rest, ...(refresh_token === undefined ? {} : { refresh_token }) }), json(200, PAGE)).fetch);
      await c.page("tickets", start);
      expect(tokens.current).toBe(REFRESH);
    }
  });

  it("saves the new refresh token before using the access token, and stops if it can't", async () => {
    const order: string[] = [];
    const { fetch } = scripted(signedIn, () => {
      order.push("read");
      return new Response(JSON.stringify(PAGE), { status: 200 });
    });
    const tokens = { load: async () => REFRESH, save: async (t: string) => void order.push(`save ${t}`) };
    await client(fetch, { tokens }).c.page("tickets", start);
    expect(order).toEqual(["save next-refresh-1", "read"]);
    const failing = { load: async () => REFRESH, save: async () => Promise.reject(new Error("database is down")) };
    const { fetch: f2, sent } = scripted(signedIn, json(200, PAGE));
    await expect(client(f2, { tokens: failing }).c.page("tickets", start)).rejects.toThrow("database is down");
    expect(sent).toHaveLength(1);
  });

  it("reuses its token until a minute before it ends, then refreshes with the newest refresh token", async () => {
    let at = NOW().getTime();
    const { fetch, sent } = scripted(json(200, { ...TOKEN, expires_in: 600 }), json(200, PAGE), json(200, PAGE), json(200, { ...TOKEN, access_token: "tok-2", refresh_token: "next-refresh-2" }), json(200, PAGE));
    const { c, tokens } = client(fetch, { now: () => new Date(at) });
    await c.page("tickets", start);
    at += 539_000;
    await c.page("tickets", start);
    expect(sent.filter((s) => s.method === "POST")).toHaveLength(1);
    at += 1000;
    await c.page("tickets", start);
    const posts = sent.filter((s) => s.method === "POST");
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[1]!.body).refresh_token).toBe("next-refresh-1");
    expect(tokens.current).toBe("next-refresh-2");
    expect(sent.at(-1)!.headers.Authorization).toBe("Bearer tok-2");
  });

  it("refreshes for every read when the token says no lifetime", async () => {
    for (const expires_in of [undefined, 0, -5, "600"]) {
      const { expires_in: _, ...rest } = TOKEN;
      const answer = json(200, { ...rest, ...(expires_in === undefined ? {} : { expires_in }) });
      const { fetch, sent } = scripted(answer, json(200, PAGE), answer, json(200, PAGE));
      const { c } = client(fetch);
      await c.page("tickets", start);
      await c.page("tickets", start);
      expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
    }
  });

  it("refreshes once at a time when two reads need a token together", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let posts = 0;
    const fetch = (async (url: string) => {
      if (url.endsWith("/oauth/tokens")) {
        posts++;
        await gate;
        return new Response(JSON.stringify(TOKEN), { status: 200 });
      }
      return new Response(JSON.stringify(PAGE), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const { c } = client(fetch);
    const both = Promise.all([c.page("tickets", start), c.page("tickets", start)]);
    release();
    await both;
    expect(posts).toBe(1);
    // Once that refresh is done, a later one can start.
    const { c: c2 } = client(scripted(json(200, { ...TOKEN, expires_in: 0 }), json(200, PAGE), json(200, { ...TOKEN, expires_in: 0 }), json(200, PAGE)).fetch);
    await c2.page("tickets", start);
    await c2.page("tickets", start);
  });

  it("a failed refresh doesn't stop the next one", async () => {
    const { fetch, sent } = scripted(text(500, ""), signedIn, json(200, PAGE));
    const { c } = client(fetch);
    await expect(c.page("tickets", start)).rejects.toThrow("HTTP 500");
    await expect(c.page("tickets", start)).resolves.toMatchObject({ end: true });
    expect(sent.map((s) => s.method)).toEqual(["POST", "POST", "GET"]);
  });

  it("refreshes once on a 401, and gives up on a second", async () => {
    const { fetch, sent } = scripted(signedIn, json(401, {}), json(201, { ...TOKEN, access_token: "tok-2" }), json(200, PAGE));
    await client(fetch).c.page("tickets", start);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
    expect(sent[3]!.headers.Authorization).toBe("Bearer tok-2");
    const { fetch: twice, sent: s2 } = scripted(signedIn, json(401, {}), signedIn, json(401, {}));
    await expect(client(twice).c.page("tickets", start)).rejects.toMatchObject({ message: "Zendesk turned down the token twice", status: 401 });
    expect(s2).toHaveLength(4);
  });

  it("explains a 403 and a 404, and reports other errors", async () => {
    const { c: forbidden } = client(scripted(signedIn, json(403, {})).fetch);
    await expect(forbidden.page("users", start)).rejects.toThrow(new ZendeskConfigError("the token can't read the users export: exports need a token an admin made, with tickets:read and users:read"));
    const { c: missing } = client(scripted(signedIn, json(404, {})).fetch);
    await expect(missing.page("tickets", start)).rejects.toThrow(new ZendeskConfigError("Zendesk has no account at ZENDESK_SUBDOMAIN"));
    for (const status of [201, 400, 422, 500]) {
      const { c } = client(scripted(signedIn, json(status, PAGE)).fetch);
      await expect(c.page("tickets", start)).rejects.toMatchObject({ message: `Zendesk answered HTTP ${status} for the tickets export`, status, name: "ZendeskApiError" });
    }
  });

  it("waits out rate limits as Retry-After says, up to a minute, or backs off", async () => {
    const { fetch } = scripted(signedIn, json(429, {}, { "Retry-After": "7" }), json(429, {}, { "Retry-After": "600" }), json(429, {}, { "Retry-After": "soon" }), json(200, PAGE));
    const { c, slept } = client(fetch);
    await c.page("tickets", start);
    expect(slept).toEqual([7000, 60_000, 4000]);
    const { c: c2, slept: s2 } = client(scripted(signedIn, json(429, {}, { "Retry-After": "0" }), json(429, {}), json(200, PAGE)).fetch);
    await c2.page("tickets", start);
    expect(s2).toEqual([1000, 2000]);
  });

  it("retries 503 and 504 too, then gives up", async () => {
    const { c, slept } = client(scripted(signedIn, json(503, {}), json(504, {}), json(503, {}), json(504, {})).fetch);
    await expect(c.page("tickets", start)).rejects.toMatchObject({ status: 504 });
    expect(slept).toEqual([1000, 2000, 4000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const { c, slept } = client(scripted(signedIn, json(502, {})).fetch);
    await expect(c.page("tickets", start)).rejects.toMatchObject({ status: 502 });
    expect(slept).toEqual([]);
    const { c: once, slept: s1 } = client(scripted(signedIn, json(429, {}), json(429, {})).fetch, { retries: 1 });
    await expect(once.page("tickets", start)).rejects.toMatchObject({ status: 429 });
    expect(s1).toEqual([1000]);
    const { c: none, slept: s0 } = client(scripted(signedIn, json(429, {})).fetch, { retries: 0 });
    await expect(none.page("tickets", start)).rejects.toMatchObject({ status: 429 });
    expect(s0).toEqual([]);
  });

  it("a 401 after a retry still refreshes just once, and doesn't use up a retry", async () => {
    const { fetch, sent } = scripted(signedIn, json(429, {}), json(401, {}), signedIn, json(200, PAGE));
    const { c, slept } = client(fetch, { retries: 1 });
    await c.page("tickets", start);
    expect(slept).toEqual([1000]);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
    const { fetch: f2 } = scripted(signedIn, json(401, {}), signedIn, json(429, {}), json(200, PAGE));
    const r = client(f2, { retries: 1 });
    await r.c.page("tickets", start);
    expect(r.slept).toEqual([1000]);
  });

  it("waits for real, and uses the global fetch and clock, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(signedIn, json(429, {}, { "Retry-After": "0.001" }), json(200, PAGE));
    globalThis.fetch = fetch;
    try {
      const c = zendeskClient({ subdomain: ZENDESK_TEST_SUBDOMAIN, clientId: CLIENT_ID, clientSecret: SECRET, tokens: memoryTokenStore(REFRESH) });
      const page = await c.page("tickets", { start: Math.floor(Date.now() / 1000) });
      expect(page.end).toBe(true);
      expect(Number(new URL(sent[1]!.url).searchParams.get("start_time"))).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 60);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(3);
  });

  it("only ever refreshes and reads the two exports", async () => {
    const mock = zendeskDocMock(helpdesk());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const paths = new Set(mock.reads.map((r) => r.kind));
    expect([...paths]).toEqual(["tickets", "users"]);
    expect(mock.api.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /oauth/tokens", "GET /api/v2/incremental/tickets/cursor", "GET /api/v2/incremental/users/cursor"]);
  });
});

describe("Zendesk reading helpers", () => {
  it("reads Zendesk's times as UTC", () => {
    expect(zendeskTime("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000Z");
    expect(zendeskTime("2026-01-02T03:04:05.1Z")).toBe("2026-01-02T03:04:05.100Z");
    expect(zendeskTime("2026-01-02T03:04:05.123Z")).toBe("2026-01-02T03:04:05.123Z");
    expect(zendeskTime("1970-01-01T00:00:00Z")).toBe("1970-01-01T00:00:00.000Z");
    for (const bad of [undefined, null, 5, "", "2026-01-02", "2026-01-02T03:04:05", "2026-01-02T03:04:05+01:00", "2026-01-02T03:04:05.1234Z", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "1969-12-31T23:59:59Z", "x2026-01-02T03:04:05Z", "2026-01-02T03:04:05Zx"]) {
      expect(zendeskTime(bad), String(bad)).toBeNull();
    }
  });
});

describe("Zendesk events", () => {
  const row = (extra: Record<string, unknown> = {}) => {
    zendeskTicket.reset();
    return zendeskTicket.one({ created_at: before(3), updated_at: before(1), ...extra });
  };
  const person = (extra: Record<string, unknown> = {}) => {
    zendeskUser.reset();
    return zendeskUser.one({ created_at: before(3), updated_at: before(1), ...extra });
  };

  it("logs a ticket with its status, people, tags and times, and no words or names", () => {
    const r = zendeskTicketEvent(row({ submitter_id: 8, tags: ["Repair", "sizing", "repair"], organization_id: 40, due_at: before(-24), satisfaction_rating: { score: "good", comment: "Lovely" } }), ctx);
    expect(r.ok).toBe(true);
    expect(r.event).toEqual({
      id: r.event.idempotencyKey.replace(/:/g, "_"),
      type: ZENDESK_TICKET_EVENT,
      occurredAt: ms(1),
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^zendesk:ticket:101:[0-9a-f]{12}$/),
      payload: {
        system: "Zendesk",
        ticketId: "zendesk:ticket:101",
        requester: "zendesk_user:501",
        submittedBy: "zendesk_user:8",
        assignedTo: `zendesk_user:${ZENDESK_TEST_AGENT}`,
        organization: "zendesk_organization:40",
        group: "zendesk_group:30",
        brand: "zendesk_brand:1",
        status: "open",
        ticketType: "question",
        priority: "normal",
        channel: "email",
        tags: ["repair", "sizing"],
        satisfaction: "good",
        public: true,
        createdAt: ms(3),
        dueAt: ms(-24),
        updatedAt: ms(1),
      },
    });
    const kept = JSON.stringify(r.event);
    for (const secret of ["Is my ring ready", synthetic.name(1), synthetic.email(1), "Lovely"]) expect(kept).not.toContain(secret);
    expect(ZENDESK_TICKET_EVENT).toBe("communication.ticket_updated");
  });

  it("leaves out what a ticket doesn't have or doesn't read", () => {
    const r = zendeskTicketEvent(
      row({ requester_id: null, submitter_id: 0, assignee_id: -1, group_id: 1.5, brand_id: "1", organization_id: Number.MAX_SAFE_INTEGER + 1, type: null, priority: "Urgent!", via: { channel: 5 }, satisfaction_rating: null, is_public: false, due_at: "soon", tags: "repair" }),
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.event.payload).toEqual({ system: "Zendesk", ticketId: "zendesk:ticket:101", status: "open", tags: [], public: false, createdAt: ms(3), updatedAt: ms(1), requester: undefined, submittedBy: undefined, assignedTo: undefined, organization: undefined, group: undefined, brand: undefined, ticketType: undefined, priority: undefined, channel: undefined, satisfaction: undefined, dueAt: undefined });
    expect(zendeskTicketEvent(row({ via: null, is_public: undefined }), ctx).event.payload).toMatchObject({ channel: undefined, public: true });
    expect(zendeskTicketEvent(row({ satisfaction_rating: { score: "<b>" }, via: { channel: "Web!" } }), ctx).event.payload).toMatchObject({ satisfaction: undefined, channel: undefined });
    expect(zendeskTicketEvent(row({ status: "a".repeat(40), type: "x-y_9" }), ctx).event.payload).toMatchObject({ status: "a".repeat(40), ticketType: "x-y_9" });
    expect(zendeskTicketEvent(row({ status: "a".repeat(41) }), ctx).ok).toBe(false);
    expect(zendeskTicketEvent(row({ status: "9a" }), ctx).ok).toBe(false);
    expect(zendeskTicketEvent(row({ status: "open<" }), ctx).ok).toBe(false);
    expect(zendeskTicketEvent(row({ status: "Open" }), ctx).ok).toBe(false);
  });

  it("keeps the store's tags tidy, and drops ones that don't read", () => {
    const many = Array.from({ length: 30 }, (_, i) => `tag${String(i).padStart(2, "0")}`);
    expect(zendeskTicketEvent(row({ tags: many }), ctx).event.payload.tags).toEqual(many.slice(0, 20));
    const tags = ["ok", "has space", "<b>", "_lead", "é-bague", "a".repeat(40), "a".repeat(41), 5, "x&y'z./q", "Z"];
    expect(zendeskTicketEvent(row({ tags }), ctx).event.payload.tags).toEqual(["a".repeat(40), "ok", "x&y'z./q", "z", "é-bague"].sort());
    expect(zendeskTicketEvent(row({ tags: ["a<"] }), ctx).event.payload.tags).toEqual([]);
  });

  it("dates a ticket by its last change, or its creation when it has none", () => {
    expect(zendeskTicketEvent(row({ updated_at: null }), ctx).event).toMatchObject({ occurredAt: ms(3), payload: { updatedAt: ms(3) } });
    expect(zendeskTicketEvent(row({ updated_at: "x" }), ctx).event.occurredAt).toBe(ms(3));
  });

  it("logs a customer's profile with their references, never their name or address", () => {
    const r = zendeskUserEvent(person({ phone: "+1 (555) 010-0001", organization_id: 40, tags: ["VIP"], notes: "Prefers rose gold", details: "Lives nearby" }), ctx)!;
    expect(r.ok).toBe(true);
    expect(r.event).toEqual({
      id: r.event.idempotencyKey.replace(/:/g, "_"),
      type: ZENDESK_PROFILE_EVENT,
      occurredAt: ms(1),
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^zendesk:user:501:[0-9a-f]{12}$/),
      payload: {
        system: "Zendesk",
        customerId: "zendesk_user:501",
        name: "Zendesk customer 501",
        marketingConsent: false,
        customerRefs: formCustomerRefs(CUSTOMER_KEY, { email: synthetic.email(1), phone: "+1 (555) 010-0001" }),
        organization: "zendesk_organization:40",
        tags: ["vip"],
        verified: true,
        suspended: false,
        deleted: false,
        createdAt: ms(3),
        updatedAt: ms(1),
      },
    });
    expect(r.event.payload.customerRefs).toHaveLength(2);
    const kept = JSON.stringify(r.event);
    for (const secret of [synthetic.name(1), synthetic.email(1), "rose gold", "nearby", "555"]) expect(kept).not.toContain(secret);
    expect(ZENDESK_PROFILE_EVENT).toBe("customer.profile_updated");
  });

  it("skips staff, notes a suspended, unverified or deleted customer, and drops what doesn't read", () => {
    for (const role of ["agent", "admin", undefined, "End-user"]) expect(zendeskUserEvent(person({ role }), ctx)).toBeNull();
    const r = zendeskUserEvent(person({ email: null, organization_id: "40", tags: null, verified: "yes", suspended: true, active: false }), ctx)!;
    expect(r.event.payload).toMatchObject({ customerRefs: [], organization: undefined, tags: [], verified: false, suspended: true, deleted: true });
    expect(zendeskUserEvent(person({ active: undefined, suspended: "true" }), ctx)!.event.payload).toMatchObject({ deleted: false, suspended: false });
    expect(zendeskUserEvent(person({ updated_at: null }), ctx)!.event).toMatchObject({ occurredAt: ms(3), payload: { updatedAt: ms(3) } });
  });

  it("is a duplicate when read again unchanged, and a new event when it changes", () => {
    const a = zendeskTicketEvent(row(), ctx).event;
    expect(zendeskTicketEvent(row(), { ...ctx, receivedAt: "2026-11-12T00:00:00.000Z" }).event.idempotencyKey).toBe(a.idempotencyKey);
    expect(zendeskTicketEvent(row({ status: "solved" }), ctx).event.idempotencyKey).not.toBe(a.idempotencyKey);
    const u = zendeskUserEvent(person(), ctx)!.event;
    expect(zendeskUserEvent(person(), ctx)!.event.idempotencyKey).toBe(u.idempotencyKey);
    expect(zendeskUserEvent(person({ suspended: true }), ctx)!.event.idempotencyKey).not.toBe(u.idempotencyKey);
    // The same record under another customer key is another event: its references differ.
    expect(zendeskUserEvent(person(), { ...ctx, customerKey: "d".repeat(40) })!.event.idempotencyKey).not.toBe(u.idempotencyKey);
  });

  it("dead-letters a ticket or user it can't read, saying why", () => {
    const t = zendeskTicketEvent({ id: "x", status: 5 }, ctx);
    expect(t.ok).toBe(false);
    expect(t.event).toEqual({
      id: t.event.idempotencyKey.replace(/:/g, "_"),
      type: ZENDESK_TICKET_EVENT,
      occurredAt: undefined,
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^zendesk:unreadable_ticket:[0-9a-f]{12}$/),
      payload: { system: "Zendesk", ticketId: null, problems: ["ticket has no id that reads", "ticket has no creation time that reads", "ticket has no status that reads"] },
    });
    expect(zendeskTicketEvent({ id: 3, status: "open" }, ctx).event.payload).toEqual({ system: "Zendesk", ticketId: 3, problems: ["ticket has no creation time that reads"] });
    for (const raw of [null, [row()], "x"]) expect(zendeskTicketEvent(raw, ctx).event.payload.problems).toEqual(["ticket is not an object", "ticket has no id that reads", "ticket has no creation time that reads", "ticket has no status that reads"]);
    expect(zendeskTicketEvent(null, ctx).event.idempotencyKey).not.toBe(zendeskTicketEvent("x", ctx).event.idempotencyKey);
    const u = zendeskUserEvent({ role: "end-user", id: 0 }, ctx)!;
    expect(u).toMatchObject({ ok: false, event: { type: ZENDESK_PROFILE_EVENT, occurredAt: undefined, idempotencyKey: expect.stringMatching(/^zendesk:unreadable_user:[0-9a-f]{12}$/), payload: { system: "Zendesk", userId: null, problems: ["user has no id that reads", "user has no creation time that reads"] } } });
    expect(zendeskUserEvent({ role: "end-user", id: 4 }, ctx)!.event.payload).toEqual({ system: "Zendesk", userId: 4, problems: ["user has no creation time that reads"] });
    for (const raw of [null, [person()], 5]) expect(zendeskUserEvent(raw, ctx)!.event.payload.problems).toEqual(["user is not an object", "user has no id that reads", "user has no creation time that reads"]);
  });
});

describe("Zendesk checkpoint", () => {
  const cursor = (c: unknown) => JSON.stringify(c);

  it("round-trips and turns down any other shape", () => {
    expect(parseZendeskCursor(null)).toBeNull();
    const good: ZendeskCursor[] = [{ done: false, tickets: null, users: null }, { done: true, tickets: "abc=", users: "d" }, { done: false, tickets: "a", users: null }];
    for (const c of good) expect(parseZendeskCursor(cursor(c))).toEqual(c);
    const bad = ["x", "null", "[]", "5", '"s"', cursor({ done: "yes", tickets: null, users: null }), cursor({ tickets: null, users: null }), cursor({ done: true, tickets: "a b", users: null }), cursor({ done: true, tickets: 5, users: null }), cursor({ done: true, tickets: null }), cursor({ done: true, users: null }), cursor({ done: true, tickets: null, users: "" }), cursor({ done: true, tickets: null, users: {} })];
    for (const raw of bad) expect(() => parseZendeskCursor(raw), raw).toThrow("Zendesk checkpoint is not in the expected shape");
    expect(parseZendeskCursor(cursor({ done: true, tickets: "a", users: "b", more: 1 }))).toEqual({ done: true, tickets: "a", users: "b" });
  });
});

describe("Zendesk connector", () => {
  it("passes the shared sync checks", async () => {
    const mock = zendeskDocMock(helpdesk());
    // One store across the runs, as an instance's database is: each refresh retires the last token.
    const tokens = memoryTokenStore(REFRESH);
    const result = await checkConnectorSync({ makeConnector: () => connector(mock, { tokens }), expected: { ingested: 6 } });
    expect(result.full.ingested).toBe(6);
  });

  it("imports five years of tickets, then customers, and stops for good", async () => {
    const mock = zendeskDocMock(helpdesk());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(6);
    const fiveYears = Math.floor(Date.parse("2021-11-11T15:00:00.000Z") / 1000);
    expect(mock.reads).toEqual([
      { kind: "tickets", query: { start_time: String(fiveYears), per_page: "1000" } },
      { kind: "users", query: { start_time: String(fiveYears), per_page: "1000" } },
    ]);
    expect(memory.events.map((e) => e.type)).toEqual([...Array(3).fill(ZENDESK_TICKET_EVENT), ...Array(3).fill(ZENDESK_PROFILE_EVENT)]);
    // Oldest change first, as the export lists them.
    expect(memory.events.slice(0, 3).map((e) => e.payload.ticketId)).toEqual(["zendesk:ticket:103", "zendesk:ticket:102", "zendesk:ticket:101"]);
    const saved = parseZendeskCursor(report.cursor)!;
    expect(saved).toEqual({ done: true, tickets: expect.any(String), users: expect.any(String) });
    assertSynthetic(memory.events);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(2);
  });

  it("checkpoints each page, and a resumed import goes on from the page it reached", async () => {
    zendeskTicket.reset();
    const tickets = Array.from({ length: 2300 }, (_, i) => zendeskTicket.one({ updated_at: before(10 - i / 1000) }));
    zendeskUser.reset();
    const customers = Array.from({ length: 1200 }, (_, i) => zendeskUser.one({ id: 10_000 + i, updated_at: before(10 - i / 1000) }));
    const both = await drain(connector(zendeskDocMock(helpdesk({ tickets, users: customers }))).historicalImport({ cursor: null } as never));
    expect(both.map((b) => b.events.length)).toEqual([1000, 1000, 300, 1000, 200]);
    // The import is done only once the last export's last page is read.
    expect(both.map((b) => parseZendeskCursor(b.cursor as string)!.done)).toEqual([false, false, false, false, true]);
    const mock = zendeskDocMock(helpdesk({ tickets, users: [] }));
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([1000, 1000, 300, 0]);
    const cursors = batches.map((b) => parseZendeskCursor(b.cursor as string)!);
    expect(cursors.map((c) => c.done)).toEqual([false, false, false, true]);
    expect(cursors[0]!.users).toBeNull();
    expect(cursors[3]!.tickets).toBe(cursors[2]!.tickets);
    expect(mock.reads.map((r) => Object.keys(r.query))).toEqual([["start_time", "per_page"], ["cursor", "per_page"], ["cursor", "per_page"], ["start_time", "per_page"]]);
    // Resumed from the first page's checkpoint, it reads the rest.
    const resumed = zendeskDocMock(helpdesk({ tickets, users: [] }));
    const rest = await drain(connector(resumed).historicalImport({ cursor: batches[0]!.cursor } as never));
    expect(rest.map((b) => b.events.length)).toEqual([1000, 300, 0]);
    expect(resumed.reads[0]!.query.cursor).toBe(cursors[0]!.tickets);
  });

  it("reads only what changed since the last sync, from the cursors it ended with", async () => {
    const data = helpdesk();
    const mock = zendeskDocMock(data);
    const { memory, pipeline } = testPipeline();
    const tokens = memoryTokenStore(REFRESH);
    const first = await runSync({ connector: connector(mock, { tokens }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(first.ingested).toBe(4);
    const ended = parseZendeskCursor(first.cursor)!;
    data.tickets!.push(zendeskTicket.one({ id: 900, created_at: before(0.5), updated_at: before(0.5) }));
    data.users!.push(zendeskUser.one({ id: 901, created_at: before(0.5), updated_at: before(0.5) }));
    const later = await runSync({ connector: connector(mock, { tokens }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(later.ingested).toBe(2);
    expect(mock.reads.slice(2)).toEqual([
      { kind: "tickets", query: { cursor: ended.tickets!, per_page: "1000" } },
      { kind: "users", query: { cursor: ended.users!, per_page: "1000" } },
    ]);
    expect(parseZendeskCursor(later.cursor)).toMatchObject({ done: false });
    const quiet = await runSync({ connector: connector(mock, { tokens }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(quiet).toMatchObject({ ingested: 0, deadLettered: 0 });
    expect(mock.refreshes).toBe(3);
  });

  it("looks back two days on a first sync with no checkpoint, and doesn't call the import done", async () => {
    const mock = zendeskDocMock(helpdesk());
    const batches = await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(eventsOf(batches)).toHaveLength(4);
    expect(mock.reads.map((r) => r.query.start_time)).toEqual([String(NOW_S - ZENDESK_FIRST_LOOKBACK_S), String(NOW_S - ZENDESK_FIRST_LOOKBACK_S)]);
    expect(ZENDESK_FIRST_LOOKBACK_S).toBe(172_800);
    expect(batches.map((b) => parseZendeskCursor(b.cursor as string)!.done)).toEqual([false, false]);
  });

  it("keeps the export where it was when a last page has no cursor", async () => {
    const pages: ZendeskPage[] = [
      { rows: [], cursor: null, end: true },
      { rows: [], cursor: null, end: true },
    ];
    const asked: unknown[] = [];
    const fake: ZendeskClient = { page: async (kind, from) => (asked.push([kind, from]), pages.shift()!) };
    const c = connector(zendeskDocMock(helpdesk()), { client: fake });
    const batches = await drain(c.incrementalSync({ cursor: JSON.stringify({ done: true, tickets: "t1", users: null }) } as never));
    expect(asked).toEqual([
      ["tickets", { cursor: "t1" }],
      ["users", { start: NOW_S - ZENDESK_FIRST_LOOKBACK_S }],
    ]);
    expect(batches.map((b) => parseZendeskCursor(b.cursor as string))).toEqual([
      { done: true, tickets: "t1", users: null },
      { done: true, tickets: "t1", users: null },
    ]);
  });

  it("resumes a later sync part way and keeps saying the import is done", async () => {
    const asked: unknown[] = [];
    const fake: ZendeskClient = { page: async (kind, from) => (asked.push([kind, from]), { rows: [], cursor: `${kind}-next`, end: true }) };
    const c = connector(zendeskDocMock(helpdesk()), { client: fake });
    const batches = await drain(c.incrementalSync({ cursor: JSON.stringify({ done: true, tickets: "a", users: "b" }) } as never));
    expect(asked).toEqual([
      ["tickets", { cursor: "a" }],
      ["users", { cursor: "b" }],
    ]);
    expect(batches.map((b) => b.cursor)).toEqual([JSON.stringify({ done: true, tickets: "tickets-next", users: "b" }), JSON.stringify({ done: true, tickets: "tickets-next", users: "users-next" })]);
    // A historical import resumed after its tickets ends with the customers, then calls itself done.
    asked.length = 0;
    const hist = await drain(c.historicalImport({ cursor: JSON.stringify({ done: false, tickets: "a", users: null }) } as never));
    expect(asked[1]).toEqual(["users", { start: Math.floor(Date.parse("2021-11-11T15:00:00.000Z") / 1000) }]);
    expect(parseZendeskCursor(hist.at(-1)!.cursor as string)!.done).toBe(true);
  });

  it("dead-letters what it can't read and carries on", async () => {
    const data = helpdesk();
    data.tickets!.push({ id: "bad", updated_at: before(2) });
    data.users!.push({ role: "end-user", id: 0, updated_at: before(2) });
    const mock = zendeskDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 6, deadLettered: 2 });
  });

  it("waits out a rate limit inside a sync, and refreshes when its token stops working", async () => {
    const mock = zendeskDocMock(helpdesk({ rateLimits: 2, retryAfter: "1" }));
    const slept: number[] = [];
    const tokens = memoryTokenStore(REFRESH);
    const batches = await drain(connector(mock, { tokens, sleep: async (ms) => void slept.push(ms) }).historicalImport({ cursor: null } as never));
    expect(eventsOf(batches)).toHaveLength(6);
    expect(eventsOf(batches).every((e) => e.receivedAt === RECEIVED)).toBe(true);
    expect(slept).toEqual([1000, 1000]);
    mock.revokeTokens();
    const c = connector(mock, { tokens });
    await drain(c.incrementalSync({ cursor: batches.at(-1)!.cursor } as never));
    expect(mock.refreshes).toBe(2);
    expect(tokens.current).toBe(mock.refreshToken);
  });

  it("stops on a turned-down sign-in, a used-up refresh token or a token that can write", async () => {
    const mock = zendeskDocMock(helpdesk());
    await expect(drain(connector(mock, { clientSecret: "x".repeat(20) }).historicalImport({ cursor: null } as never))).rejects.toThrow(ZendeskConfigError);
    // The seed was spent by an earlier refresh: Zendesk turns it down.
    await drain(connector(mock).historicalImport({ cursor: null } as never));
    await expect(drain(connector(mock, { tokens: memoryTokenStore(REFRESH) }).historicalImport({ cursor: null } as never))).rejects.toThrow("authorize the client again");
    const writer = zendeskDocMock(helpdesk({ scope: "read write" }));
    await expect(drain(connector(writer).historicalImport({ cursor: null } as never))).rejects.toThrow("the token has write;");
    expect(writer.reads).toHaveLength(0);
  });

  it("checks its settings", () => {
    const mock = zendeskDocMock(helpdesk());
    expect(() => connector(mock, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY");
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { subdomain: "bad.domain" })).toThrow(ZendeskConfigError);
    expect(() => connector(mock, { client: { page: async () => ({ rows: [], cursor: null, end: true }) }, subdomain: "bad.domain" })).not.toThrow();
  });

  it("reads back as far as told, and up to now when no clock is given", async () => {
    const asked: unknown[] = [];
    const fake: ZendeskClient = { page: async (kind, from) => (asked.push(from), { rows: [], cursor: "c", end: true }) };
    await drain(connector(zendeskDocMock(helpdesk()), { client: fake, historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(asked[0]).toEqual({ start: Math.floor(Date.parse("2025-11-11T15:00:00.000Z") / 1000) });
    asked.length = 0;
    const { now: _, ...rest } = { subdomain: ZENDESK_TEST_SUBDOMAIN, clientId: CLIENT_ID, clientSecret: SECRET, tokens: memoryTokenStore(REFRESH), customerKey: CUSTOMER_KEY, client: fake, now: NOW };
    await drain(zendeskConnector(rest).incrementalSync({ cursor: null } as never));
    const s = (asked[0] as { start: number }).start;
    expect(Math.abs(s - (Math.floor(Date.now() / 1000) - ZENDESK_FIRST_LOOKBACK_S))).toBeLessThan(5);
    const batches = await drain(zendeskConnector({ ...rest, client: { page: async () => ({ rows: [zendeskTicket.one()], cursor: "c", end: true }) } }).incrementalSync({ cursor: null } as never));
    expect(Math.abs(Date.parse((batches[0]!.events[0] as ZendeskEvent).receivedAt) - Date.now())).toBeLessThan(5000);
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(ZENDESK_WRITES).toEqual([
      { integration: "zendesk", name: "add_internal_note", description: "Add an internal note to a Zendesk ticket", kind: "append", approval: "each", dailyCap: 20 },
      { integration: "zendesk", name: "add_tag", description: "Tag a Zendesk ticket", kind: "update", approval: "each", dailyCap: 20 },
    ]);
    const c = connector(zendeskDocMock(helpdesk()));
    expect(c.writes).toBe(ZENDESK_WRITES);
    expect(c.source).toBe("zendesk");
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "add_internal_note", integration: "zendesk", outcome: "refused" },
      { action: "add_tag", integration: "zendesk", outcome: "refused" },
    ]);
  });
});

describe("Zendesk doc mock", () => {
  const refresh = (mock: ZendeskMock, body: Record<string, unknown>, type = "application/json") => mock.fetch(`${BASE}/oauth/tokens`, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
  const good = { grant_type: "refresh_token", refresh_token: REFRESH, client_id: CLIENT_ID, client_secret: SECRET };

  it("wants JSON, the client's keys and the current refresh token, and retires each one it replaces", async () => {
    const mock = zendeskDocMock(helpdesk());
    expect((await refresh(mock, good, "application/x-www-form-urlencoded")).status).toBe(400);
    expect((await mock.fetch(`${BASE}/oauth/tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status).toBe(400);
    expect((await refresh(mock, { ...good, client_secret: "x" })).status).toBe(401);
    expect((await refresh(mock, { ...good, grant_type: "client_credentials" })).status).toBe(400);
    expect((await refresh(mock, { ...good, refresh_token: "old" })).status).toBe(400);
    for (const refresh_token_expires_in of [604_799, 7_776_001, "90"]) expect((await refresh(mock, { ...good, refresh_token_expires_in })).status).toBe(400);
    const first = await refresh(mock, { ...good, scope: "tickets:read", refresh_token_expires_in: 604_800 });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ access_token: "zd-access-1", token_type: "bearer", expires_in: 1800, refresh_token: "zd-refresh-1", refresh_token_expires_in: 604_800, scope: "tickets:read" });
    expect((await refresh(mock, good)).status).toBe(400);
    const second = (await (await refresh(mock, { ...good, refresh_token: "zd-refresh-1" })).json()) as Record<string, unknown>;
    expect(second).toMatchObject({ refresh_token_expires_in: 2_592_000, scope: "read" });
    expect(mock.refreshes).toBe(2);
    expect(mock.refreshBodies).toHaveLength(9);
    // The first access token stopped working with the second refresh.
    expect((await mock.fetch(`${BASE}/api/v2/incremental/tickets/cursor?start_time=0`, { headers: { authorization: "Bearer zd-access-1" } })).status).toBe(401);
    const unscoped = zendeskDocMock(helpdesk({ scope: null, expiresIn: 60 }));
    expect(await (await refresh(unscoped, good)).json()).not.toHaveProperty("scope");
  });

  it("wants a token it issued, and checks the parameters, page size and cursor", async () => {
    const mock = zendeskDocMock(helpdesk());
    const { access_token } = (await (await refresh(mock, good)).json()) as { access_token: string };
    const get = (q: string, token = access_token) => mock.fetch(`${BASE}/api/v2/incremental/tickets/cursor${q}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await get("?start_time=0", "nope")).status).toBe(401);
    expect((await mock.fetch(`${BASE}/api/v2/incremental/tickets/cursor?start_time=0`)).status).toBe(401);
    expect((await get("?start_time=0&since=1")).status).toBe(400);
    expect((await get("")).status).toBe(400);
    expect((await get("?start_time=0&cursor=a")).status).toBe(400);
    expect((await get(`?start_time=${NOW_S - 59}`)).status).toBe(400);
    expect((await get("?start_time=-5")).status).toBe(400);
    expect((await get("?start_time=0&per_page=1001")).status).toBe(400);
    expect((await get("?start_time=0&per_page=0")).status).toBe(400);
    expect((await get("?cursor=bm9wZQ")).status).toBe(400);
    expect((await get(`?start_time=${NOW_S - 60}`)).status).toBe(200);
    const first = (await (await get("?start_time=0&per_page=2&exclude_deleted=true")).json()) as { tickets: { id: number }[]; after_cursor: string; end_of_stream: boolean };
    // Oldest change first.
    expect(first.tickets.map((t) => t.id)).toEqual([104, 103]);
    expect(first.end_of_stream).toBe(false);
    const second = (await (await get(`?cursor=${first.after_cursor}&per_page=2`)).json()) as typeof first;
    expect(second.tickets.map((t) => t.id)).toEqual([102, 101]);
    expect(second.end_of_stream).toBe(true);
    const third = (await (await get(`?cursor=${second.after_cursor}`)).json()) as typeof first;
    expect(third).toMatchObject({ tickets: [], after_cursor: second.after_cursor, end_of_stream: true });
    const all = (await (await get("?start_time=0")).json()) as typeof first;
    expect(all.tickets).toHaveLength(4);
    // Records changed at the same moment come in id order, and a cursor between them keeps its place.
    const tied = zendeskDocMock(helpdesk({ tickets: [zendeskTicket.one({ id: 9, updated_at: before(1) }), zendeskTicket.one({ id: 3, updated_at: before(1) })] }));
    const t = (await (await refresh(tied, good)).json()) as { access_token: string };
    const tget = (q: string) => tied.fetch(`${BASE}/api/v2/incremental/tickets/cursor${q}`, { headers: { authorization: `Bearer ${t.access_token}` } });
    const one = (await (await tget("?start_time=0&per_page=1")).json()) as typeof first;
    expect(one.tickets.map((x) => x.id)).toEqual([3]);
    expect(((await (await tget(`?cursor=${one.after_cursor}`)).json()) as typeof first).tickets.map((x) => x.id)).toEqual([9]);
    // A start time is inclusive.
    const at = Math.floor(Date.parse(before(1)) / 1000);
    expect(((await (await tget(`?start_time=${at}`)).json()) as typeof first).tickets).toHaveLength(2);
    expect(((await (await tget(`?start_time=${at + 1}`)).json()) as typeof first).tickets).toHaveLength(0);
    expect(mock.reads.at(-1)).toEqual({ kind: "tickets", query: { start_time: "0" } });
  });

  it("lists nothing when given no records, answers 429 with or without Retry-After, and uses the real clock by default", async () => {
    const { tickets: _t, users: _u, now: _n, ...bare } = helpdesk();
    const empty = zendeskDocMock(bare);
    const { c } = client(empty.fetch, { tokens: memoryTokenStore(REFRESH), now: () => new Date() });
    expect(await c.page("tickets", { start: 0 })).toMatchObject({ rows: [], end: true });
    expect(await c.page("users", { start: 0 })).toMatchObject({ rows: [], end: true });
    for (const retryAfter of [undefined, "2"]) {
      const mock = zendeskDocMock(helpdesk({ rateLimits: 1, ...(retryAfter === undefined ? {} : { retryAfter }) }));
      const r = client(mock.fetch, { retries: 0 });
      const err = await r.c.page("tickets", start).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 429 });
    }
    expect(ZENDESK_DOC_PAGES.exports).toMatch(/^https:\/\/developer\.zendesk\.com\//);
  });
});
