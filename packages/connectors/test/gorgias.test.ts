import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import {
  GORGIAS_TEST_AGENT,
  GORGIAS_TEST_DOMAIN,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  gorgiasDocMock,
  gorgiasMessage,
  gorgiasTicket,
  gorgiasTimeOf,
  synthetic,
  testPipeline,
  type GorgiasMock,
  type GorgiasMockData,
} from "@karatos/connector-testkit";
import {
  GORGIAS_CURSOR,
  GORGIAS_FIRST_LOOKBACK_MS,
  GORGIAS_MESSAGE_EVENT,
  GORGIAS_OVERLAP_MS,
  GORGIAS_PAGE_SIZE,
  GORGIAS_READ_SCOPES,
  GORGIAS_TICKET_EVENT,
  GORGIAS_WRITES,
  GorgiasApiError,
  GorgiasConfigError,
  formCustomerRefs,
  gorgiasClient,
  gorgiasConnector,
  gorgiasMessageEvent,
  gorgiasTicketEvent,
  gorgiasTime,
  parseGorgiasCursor,
  type GorgiasClient,
  type GorgiasCursor,
  type GorgiasEvent,
  type GorgiasOptions,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = ["gorgias", "client", "test"].join("-");
const SECRET = ["gs", "secret", "0".repeat(24)].join("-");
const REFRESH = ["gr", "refresh", "1".repeat(24)].join("-");
const CUSTOMER_KEY = "c".repeat(40);
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const BASE = `https://${GORGIAS_TEST_DOMAIN}.gorgias.com`;
const HOUR_MS = 3_600_000;
const noSleep = async () => {};

/** `ago` hours before NOW, as UTC. */
const before = (ago: number) => new Date(NOW().getTime() - ago * HOUR_MS).toISOString();
/** The same, as Gorgias writes it. */
const g = (ago: number) => gorgiasTimeOf(before(ago));

/** Tickets that last changed 1, 30 and 5,000 hours ago, and six years ago, past the five read, each with two messages. */
function helpdesk(overrides: Partial<GorgiasMockData> = {}): GorgiasMockData {
  gorgiasTicket.reset();
  gorgiasMessage.reset();
  const tickets = [1, 30, 5000, 52_600].map((ago) => gorgiasTicket.one({ created_datetime: g(ago + 1), updated_datetime: g(ago) }));
  const messages = tickets.flatMap((t) => [gorgiasMessage.one({ ticket_id: t.id }), gorgiasMessage.one({ ticket_id: t.id, from_agent: true, sender: { id: GORGIAS_TEST_AGENT } })]);
  return { clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: REFRESH, tickets, messages, ...overrides };
}

const connector = (mock: GorgiasMock, overrides: Partial<GorgiasOptions> = {}) =>
  gorgiasConnector({ domain: GORGIAS_TEST_DOMAIN, clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: REFRESH, customerKey: CUSTOMER_KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });

const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as GorgiasEvent[];

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
const TOKEN = { access_token: "tok-1", expires_in: 86400, scope: "openid offline tickets:read" };
const signedIn = json(200, TOKEN);
const PAGE = { object: "list", data: [], meta: { prev_cursor: null, next_cursor: null } };
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof gorgiasClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = gorgiasClient({ domain: GORGIAS_TEST_DOMAIN, clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: REFRESH, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};

describe("Gorgias client", () => {
  it("checks its settings before sending anything", () => {
    const { fetch, sent } = scripted(signedIn);
    const make = (extra: Record<string, string>) => () => gorgiasClient({ domain: GORGIAS_TEST_DOMAIN, clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: REFRESH, fetch, ...extra });
    for (const domain of ["", "-store", "store-", "store.gorgias.com", "a_b", "x".repeat(64), "https://store", "st ore"]) expect(make({ domain })).toThrow("GORGIAS_DOMAIN must be the account's subdomain, such as store for store.gorgias.com");
    for (const clientId of ["", "short12", "x".repeat(129), "has space1", "a/b/c/d/e"]) expect(make({ clientId })).toThrow("GORGIAS_CLIENT_ID is missing or not in the expected shape");
    for (const clientSecret of ["", "s".repeat(15), "s".repeat(257), `${"s".repeat(20)} x`]) expect(make({ clientSecret })).toThrow("GORGIAS_CLIENT_SECRET is missing or not in the expected shape");
    for (const refreshToken of ["", "r".repeat(15), "r".repeat(4097), `${"r".repeat(20)} x`]) expect(make({ refreshToken })).toThrow("GORGIAS_REFRESH_TOKEN is missing or not in the expected shape");
    for (const key of ["domain", "clientId", "clientSecret", "refreshToken"]) expect(make({ [key]: undefined as never })).toThrow(/GORGIAS_/);
    // Settings are trimmed, the domain is lowercased, and the longest ones fit.
    expect(make({ domain: " Store ", clientId: ` ${"x".repeat(128)} `, clientSecret: "s".repeat(256), refreshToken: "r".repeat(4096) })).not.toThrow();
    expect(make({ domain: "a", clientId: "x".repeat(8), clientSecret: ` ${"s".repeat(16)}\n`, refreshToken: `${"r".repeat(16)} ` })).not.toThrow();
    expect(make({ domain: `a${"-".repeat(61)}b` })).not.toThrow();
    expect(sent).toEqual([]);
  });

  it("signs in with the refresh token and Basic auth, then lists tickets newest change first", async () => {
    const { fetch, sent } = scripted(signedIn, json(200, PAGE));
    const { c } = client(fetch, { domain: " TestStore ", clientId: ` ${CLIENT_ID} `, clientSecret: ` ${SECRET} `, refreshToken: ` ${REFRESH} ` });
    expect(await c.tickets(null)).toEqual({ rows: [], next: null });
    expect(sent[0]).toEqual({
      url: `${BASE}/oauth/token`,
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH }).toString(),
    });
    expect(sent[1]).toEqual({ url: `${BASE}/api/tickets?order_by=updated_datetime%3Adesc&limit=100`, method: "GET", headers: { Authorization: "Bearer tok-1", Accept: "application/json" }, body: "" });
    expect(GORGIAS_PAGE_SIZE).toBe(100);
  });

  it("lists a ticket's messages oldest first, and pages with Gorgias's cursor", async () => {
    const { fetch, sent } = scripted(signedIn, json(200, { ...PAGE, meta: { next_cursor: "abc=" } }), json(200, { ...PAGE, meta: {} }));
    const { c } = client(fetch);
    expect(await c.messages(101, null)).toEqual({ rows: [], next: "abc=" });
    expect(await c.tickets("x/y+z")).toEqual({ rows: [], next: null });
    expect(sent[1]!.url).toBe(`${BASE}/api/messages?ticket_id=101&order_by=created_datetime%3Aasc&limit=100`);
    expect(new URL(sent[2]!.url).searchParams.get("cursor")).toBe("x/y+z");
  });

  it("checks cursors and ticket ids before sending", async () => {
    const { fetch, sent } = scripted(signedIn, json(200, PAGE));
    const { c } = client(fetch);
    for (const cursor of ["", "a b", "x".repeat(2049), "a&b", "a?b"]) await expect(c.tickets(cursor)).rejects.toThrow(new GorgiasApiError("Gorgias's page cursor isn't in the expected shape", 0));
    for (const id of [0, -1, 1.5, Number.NaN, 2 ** 53]) await expect(c.messages(id, null)).rejects.toThrow(new GorgiasApiError("a ticket id must be a positive whole number", 0));
    await expect(c.messages(1, "a b")).rejects.toThrow("cursor isn't in the expected shape");
    expect(sent).toEqual([]);
    await c.tickets("x".repeat(2048));
    expect(sent).toHaveLength(2);
  });

  it("keeps the rows as Gorgias sent them", async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const { fetch } = scripted(signedIn, json(200, { ...PAGE, data: rows }));
    expect((await client(fetch).c.tickets(null)).rows).toEqual(rows);
  });

  it("says when a page has no data list or meta, or a next cursor that doesn't read", async () => {
    for (const body of [{ data: {}, meta: {} }, { meta: {} }, { data: [] }, { data: [], meta: [] }, [], null]) {
      const { fetch } = scripted(signedIn, json(200, body));
      await expect(client(fetch).c.tickets(null)).rejects.toThrow(new GorgiasApiError("Gorgias answered /api/tickets without a list of data and its meta", 200));
    }
    const { fetch: html } = scripted(signedIn, text(200, "<html>"));
    await expect(client(html).c.messages(1, null)).rejects.toThrow("Gorgias answered /api/messages without a list of data and its meta");
    for (const next_cursor of [5, "", "a b", { x: 1 }]) {
      const { fetch } = scripted(signedIn, json(200, { data: [], meta: { next_cursor } }));
      await expect(client(fetch).c.tickets(null)).rejects.toThrow(new GorgiasApiError("Gorgias's next page cursor isn't in the expected shape", 200));
    }
  });

  it("stops before reading when the token has a scope that writes, or doesn't say", async () => {
    for (const scope of ["openid tickets:read tickets:write", "write:all", "customers:write macros:write rules:write tags:write users:write account:write"]) {
      const { fetch, sent } = scripted(json(200, { ...TOKEN, scope }));
      const extra = scope.split(" ").filter((s) => !(GORGIAS_READ_SCOPES as readonly string[]).includes(s));
      await expect(client(fetch).c.tickets(null)).rejects.toThrow(new GorgiasConfigError(`the app has ${extra.slice(0, 5).join(", ")}; KaratOS only reads, so connect an app with tickets:read and nothing else that writes`));
      expect(sent).toHaveLength(1);
    }
    for (const scope of [undefined, 5, ["tickets:read"]]) {
      const { fetch, sent } = scripted(json(200, { ...TOKEN, scope }));
      await expect(client(fetch).c.tickets(null)).rejects.toThrow(new GorgiasApiError("Gorgias's sign-in didn't say which scopes the app has, so KaratOS can't tell that it only reads", 200));
      expect(sent).toHaveLength(1);
    }
    for (const scope of [GORGIAS_READ_SCOPES.join(" "), "", "  openid   tickets:read "]) {
      const { fetch } = scripted(json(200, { ...TOKEN, scope }), json(200, PAGE));
      await expect(client(fetch).c.tickets(null)).resolves.toEqual({ rows: [], next: null });
    }
    expect(GORGIAS_READ_SCOPES).toEqual(["openid", "email", "profile", "offline", "tickets:read", "customers:read", "tags:read", "satisfaction_survey:read", "account:read", "users:read"]);
  });

  it("explains a turned-down sign-in, and reports other sign-in errors", async () => {
    const hint = "Gorgias turned down the sign-in: check GORGIAS_CLIENT_ID, GORGIAS_CLIENT_SECRET and GORGIAS_REFRESH_TOKEN, and that the app is still active in the helpdesk";
    for (const status of [400, 401]) {
      const { fetch } = scripted(json(status, { error: "invalid_grant" }));
      await expect(client(fetch).c.tickets(null)).rejects.toThrow(new GorgiasConfigError(hint));
    }
    const { fetch: down } = scripted(json(503, {}));
    await expect(client(down).c.tickets(null)).rejects.toMatchObject({ name: "GorgiasApiError", message: "Gorgias answered HTTP 503 to the sign-in", status: 503 });
    const { fetch: made } = scripted(json(201, TOKEN), json(200, PAGE));
    await expect(client(made).c.tickets(null)).rejects.toThrow(new GorgiasApiError("Gorgias answered HTTP 201 to the sign-in", 201));
  });

  it("says when a sign-in has no access token that reads", async () => {
    for (const reply of [{ ...TOKEN, access_token: undefined }, { ...TOKEN, access_token: "" }, { ...TOKEN, access_token: "has space" }, { ...TOKEN, access_token: "t".repeat(4097) }, { ...TOKEN, access_token: 5 }, [TOKEN], null]) {
      const { fetch } = scripted(json(200, reply));
      await expect(client(fetch).c.tickets(null)).rejects.toThrow(new GorgiasApiError("Gorgias's sign-in had no access token in the expected shape", 200));
    }
    const { fetch } = scripted(text(200, "x"));
    await expect(client(fetch).c.tickets(null)).rejects.toThrow("no access token in the expected shape");
    const { fetch: long, sent } = scripted(json(200, { ...TOKEN, access_token: "t".repeat(4096) }), json(200, PAGE));
    await client(long).c.tickets(null);
    expect(sent[1]!.headers.Authorization).toBe(`Bearer ${"t".repeat(4096)}`);
  });

  it("reuses its token until five minutes before it ends, then signs in again", async () => {
    let at = Date.parse("2026-11-11T00:00:00Z");
    const { fetch, sent } = scripted(json(200, { ...TOKEN, expires_in: 3600 }), json(200, PAGE), json(200, PAGE), json(200, { ...TOKEN, access_token: "tok-2" }), json(200, PAGE));
    const { c } = client(fetch, { now: () => new Date(at) });
    await c.tickets(null);
    at += 55 * 60_000 - 1;
    await c.tickets(null);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET"]);
    at += 1;
    await c.tickets(null);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
    expect(sent[4]!.headers.Authorization).toBe("Bearer tok-2");
  });

  it("signs in for every read when the token says no lifetime", async () => {
    for (const expires_in of [undefined, "3600", Number.POSITIVE_INFINITY]) {
      const { fetch, sent } = scripted(json(200, { ...TOKEN, expires_in }), json(200, PAGE), json(200, { ...TOKEN, expires_in }), json(200, PAGE));
      const { c } = client(fetch);
      await c.tickets(null);
      await c.tickets(null);
      expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
    }
  });

  it("signs in again once on a 401, and gives up on a second", async () => {
    const { fetch, sent } = scripted(signedIn, json(401, {}), json(200, { ...TOKEN, access_token: "tok-2" }), json(200, PAGE));
    await client(fetch).c.tickets(null);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
    expect(sent[3]!.headers.Authorization).toBe("Bearer tok-2");
    const { fetch: twice, sent: sent2 } = scripted(signedIn, json(401, {}), signedIn, json(401, {}), signedIn, json(200, PAGE));
    await expect(client(twice).c.tickets(null)).rejects.toThrow(new GorgiasApiError("Gorgias turned down the app's token twice", 401));
    expect(sent2).toHaveLength(4);
  });

  it("explains a 403 and a 404, and reports other errors", async () => {
    const { fetch } = scripted(signedIn, json(403, {}));
    await expect(client(fetch).c.tickets(null)).rejects.toThrow(new GorgiasConfigError("the app isn't allowed to read the helpdesk's tickets: connect it with tickets:read"));
    const { fetch: f2 } = scripted(signedIn, json(404, {}));
    await expect(client(f2).c.messages(5, null)).rejects.toThrow(new GorgiasConfigError("Gorgias has no account at GORGIAS_DOMAIN, or the ticket is gone"));
    const { fetch: f3 } = scripted(signedIn, json(400, {}));
    await expect(client(f3).c.messages(5, null)).rejects.toThrow(new GorgiasApiError("Gorgias answered HTTP 400 for /api/messages", 400));
    const { fetch: f4 } = scripted(signedIn, json(206, PAGE));
    await expect(client(f4).c.tickets(null)).rejects.toMatchObject({ status: 206 });
  });

  it("waits out rate limits as Retry-After says, up to a minute, or backs off", async () => {
    const limited = (after?: string) => json(429, {}, after === undefined ? {} : { "Retry-After": after });
    const { fetch, sent } = scripted(signedIn, limited("5"), limited("600"), limited(), json(200, PAGE));
    const { c, slept } = client(fetch);
    await c.tickets(null);
    expect(slept).toEqual([5000, 60_000, 4000]);
    expect(sent).toHaveLength(5);
    const { fetch: f2 } = scripted(signedIn, limited("0"), limited("soon"), limited("-5"), json(200, PAGE));
    const r2 = client(f2);
    await r2.c.tickets(null);
    expect(r2.slept).toEqual([1000, 2000, 4000]);
  });

  it("retries 503 and 504 too, then gives up", async () => {
    const { fetch, sent } = scripted(signedIn, json(503, {}), json(504, {}), json(503, {}), json(504, {}));
    const { c, slept } = client(fetch);
    await expect(c.tickets(null)).rejects.toMatchObject({ status: 504 });
    expect(slept).toEqual([1000, 2000, 4000]);
    expect(sent).toHaveLength(5);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const { fetch, sent } = scripted(signedIn, json(500, {}));
    await expect(client(fetch).c.tickets(null)).rejects.toMatchObject({ status: 500 });
    expect(sent).toHaveLength(2);
    const { fetch: f2, sent: s2 } = scripted(signedIn, json(429, {}));
    const r = client(f2, { retries: 1 });
    await expect(r.c.tickets(null)).rejects.toMatchObject({ status: 429 });
    expect(s2).toHaveLength(3);
    expect(r.slept).toEqual([1000]);
    const { fetch: f3, sent: s3 } = scripted(signedIn, json(429, {}));
    await expect(client(f3, { retries: 0 }).c.tickets(null)).rejects.toMatchObject({ status: 429 });
    expect(s3).toHaveLength(2);
  });

  it("a 401 after a retry still signs in again just once", async () => {
    const { fetch, sent } = scripted(signedIn, json(503, {}), json(401, {}), signedIn, json(200, PAGE));
    const { c, slept } = client(fetch, { retries: 1 });
    await c.tickets(null);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
    expect(slept).toEqual([1000]);
  });

  it("a 401 doesn't use up a retry", async () => {
    const { fetch, sent } = scripted(signedIn, json(401, {}), signedIn, json(429, {}), json(200, PAGE));
    const { c, slept } = client(fetch, { retries: 1 });
    await c.tickets(null);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET", "GET"]);
    expect(slept).toEqual([1000]);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(signedIn, json(429, {}, { "Retry-After": "0.001" }), json(200, PAGE));
    globalThis.fetch = fetch;
    try {
      await gorgiasClient({ domain: GORGIAS_TEST_DOMAIN, clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: REFRESH }).tickets(null);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(3);
  });

  it("only ever signs in, lists tickets and lists a ticket's messages", async () => {
    const mock = gorgiasDocMock(helpdesk());
    await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(mock.signIns).toBe(1);
    expect(mock.reads.map((r) => r.kind)).toEqual(["tickets", "messages", "messages", "messages"]);
  });
});

describe("Gorgias reading helpers", () => {
  it("reads Gorgias's times as UTC", () => {
    expect(gorgiasTime("2019-07-05T14:42:00.384938")).toBe("2019-07-05T14:42:00.384Z");
    expect(gorgiasTime("2019-07-05T14:42:00")).toBe("2019-07-05T14:42:00.000Z");
    expect(gorgiasTime("2019-07-05T14:42:00.5Z")).toBe("2019-07-05T14:42:00.500Z");
    expect(gorgiasTime("2019-07-05T14:42:00.123+00:00")).toBe("2019-07-05T14:42:00.123Z");
    for (const bad of ["2019-02-30T00:00:00", "2019-07-05", "2019-07-05T14:42:00+02:00", "2019-07-05T14:42:00.1234567", "x2019-07-05T14:42:00", "2019-07-05T14:42:00x", "2019-07-05T25:00:00", "1960-01-01T00:00:00", 5, null, undefined]) expect(gorgiasTime(bad), String(bad)).toBeNull();
    expect(gorgiasTime("1970-01-01T00:00:00")).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("Gorgias events", () => {
  const ctx = { customerKey: CUSTOMER_KEY, receivedAt: RECEIVED };
  const ticket = (extra: Record<string, unknown> = {}) => {
    gorgiasTicket.reset();
    return { ...gorgiasTicket.one({}), ...extra };
  };
  const message = (extra: Record<string, unknown> = {}) => {
    gorgiasMessage.reset();
    return { ...gorgiasMessage.one({}), ...extra };
  };
  const refs = (n: number) => formCustomerRefs(CUSTOMER_KEY, { email: synthetic.email(n) });

  it("logs a ticket with its status, tags and times, the customer as a reference and no words or names", () => {
    const { ok, event } = gorgiasTicketEvent(ticket(), ctx);
    expect(ok).toBe(true);
    expect(event.type).toBe(GORGIAS_TICKET_EVENT);
    expect(event.occurredAt).toBe("2026-01-01T00:01:00.000Z");
    expect(event.receivedAt).toBe(RECEIVED);
    expect(event.payload).toEqual({
      system: "Gorgias",
      ticketId: "gorgias:ticket:101",
      customerRefs: refs(1),
      status: "open",
      channel: "email",
      via: "email",
      language: "en",
      tags: ["repair"],
      assignedTo: `gorgias_user:${GORGIAS_TEST_AGENT}`,
      startedByStore: false,
      spam: false,
      trashed: false,
      unread: true,
      satisfactionScore: undefined,
      createdAt: "2026-01-01T00:01:00.000Z",
      openedAt: undefined,
      lastReceivedAt: "2026-01-01T00:01:00.000Z",
      lastMessageAt: "2026-01-01T00:01:00.000Z",
      closedAt: undefined,
      snoozedUntil: undefined,
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
    expect(event.idempotencyKey).toMatch(/^gorgias:ticket:101:[0-9a-f]{12}$/);
    expect(event.id).toBe(event.idempotencyKey.replace(/:/g, "_"));
    const all = JSON.stringify(event);
    expect(all).not.toContain(synthetic.email(1));
    expect(all).not.toContain("Test Customer");
    expect(all).not.toContain("ring ready");
    expect(all).not.toContain("Test Agent");
  });

  it("keeps the store's tags tidy, and drops ones that don't read", () => {
    const tags = [{ name: " Repair " }, { name: "repair" }, { name: "VIP" }, { name: "Size 7½" }, { name: "<b>" }, { name: "" }, { name: "x".repeat(41) }, { name: 5 }, "x", { name: "Été" }];
    expect(gorgiasTicketEvent(ticket({ tags }), ctx).event.payload.tags).toEqual(["repair", "size 7½", "vip", "été"].sort());
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `t${String(i).padStart(2, "0")}` }));
    expect(gorgiasTicketEvent(ticket({ tags: many }), ctx).event.payload.tags).toEqual(many.slice(0, 20).map((t) => t.name));
    expect(gorgiasTicketEvent(ticket({ tags: undefined }), ctx).event.payload.tags).toEqual([]);
    expect(gorgiasTicketEvent(ticket({ tags: [{ name: "x".repeat(40) }] }), ctx).event.payload.tags).toEqual(["x".repeat(40)]);
    expect(gorgiasTicketEvent(ticket({ tags: [{ name: " Bridal " }, { name: "a<b>" }, { name: "<b" }, { name: "a>" }] }), ctx).event.payload.tags).toEqual(["bridal"]);
  });

  it("notes a closed, spam, trashed, snoozed or scored ticket, and drops what doesn't read", () => {
    const closed = gorgiasTicketEvent(ticket({ status: "closed", closed_datetime: g(2), opened_datetime: g(3), snooze_datetime: g(-4), from_agent: true, spam: true, trashed_datetime: g(1), is_unread: false, satisfaction_survey: { score: 5 } }), ctx).event.payload;
    expect(closed).toMatchObject({ status: "closed", closedAt: before(2), openedAt: before(3), snoozedUntil: before(-4), startedByStore: true, spam: true, trashed: true, unread: false, satisfactionScore: 5 });
    for (const score of [0, 6, 4.5, "5", null]) expect(gorgiasTicketEvent(ticket({ satisfaction_survey: { score } }), ctx).event.payload.satisfactionScore).toBeUndefined();
    expect(gorgiasTicketEvent(ticket({ satisfaction_survey: { score: 1 } }), ctx).event.payload.satisfactionScore).toBe(1);
    for (const language of ["eng", "EN", 5, null]) expect(gorgiasTicketEvent(ticket({ language }), ctx).event.payload.language).toBeUndefined();
    for (const channel of ["Email", "<x>", "x".repeat(41), 5, "1chat"]) expect(gorgiasTicketEvent(ticket({ channel }), ctx).event.payload.channel).toBeUndefined();
    expect(gorgiasTicketEvent(ticket({ channel: `c${"h".repeat(39)}` }), ctx).event.payload.channel).toBe(`c${"h".repeat(39)}`);
    expect(gorgiasTicketEvent(ticket({ channel: "facebook-messenger_2" }), ctx).event.payload.channel).toBe("facebook-messenger_2");
    for (const bad of ["a<b>", "a>", "Chat", 5]) expect(gorgiasTicketEvent(ticket({ channel: bad, via: bad }), ctx).event.payload).toMatchObject({ channel: undefined, via: undefined });
    const times = gorgiasTicketEvent(ticket({ last_received_message_datetime: g(5), last_message_datetime: g(4) }), ctx).event.payload;
    expect(times).toMatchObject({ lastReceivedAt: before(5), lastMessageAt: before(4) });
    for (const assignee_user of [null, {}, { id: 0 }, { id: "7" }]) expect(gorgiasTicketEvent(ticket({ assignee_user }), ctx).event.payload.assignedTo).toBeUndefined();
    for (const customer of [null, {}, { email: "not an email" }]) expect(gorgiasTicketEvent(ticket({ customer }), ctx).event.payload.customerRefs).toEqual([]);
    expect(gorgiasTicketEvent(ticket({ spam: "true", from_agent: 1, is_unread: "yes" }), ctx).event.payload).toMatchObject({ spam: false, startedByStore: false, unread: false });
    expect(gorgiasTicketEvent(ticket({ trashed_datetime: "soon" }), ctx).event.payload.trashed).toBe(false);
  });

  it("dates a ticket by its last change, or its creation when it has none", () => {
    expect(gorgiasTicketEvent(ticket({ updated_datetime: g(2) }), ctx).event.occurredAt).toBe(before(2));
    const { ok, event } = gorgiasTicketEvent(ticket({ updated_datetime: null }), ctx);
    expect(ok).toBe(true);
    expect(event.occurredAt).toBe("2026-01-01T00:01:00.000Z");
    expect(event.payload.updatedAt).toBe("2026-01-01T00:01:00.000Z");
  });

  it("logs a customer's message as Quo's and Gmail's are, with its length but never its words", () => {
    const raw = message();
    const { ok, event } = gorgiasMessageEvent(raw, ctx);
    expect(ok).toBe(true);
    expect(event.type).toBe(GORGIAS_MESSAGE_EVENT);
    expect(event.occurredAt).toBe("2026-01-01T00:01:00.000Z");
    expect(event.payload).toEqual({
      system: "Gorgias",
      channel: "email",
      via: "email",
      messageId: "gorgias:message:9001",
      conversationId: "gorgias:ticket:101",
      customerRefs: refs(1),
      direction: "inbound",
      sentBy: undefined,
      textLength: String(raw.body_text).length,
      attachmentCount: 0,
      byRule: false,
      failed: false,
      deleted: false,
      sentAt: "2026-01-01T00:01:00.000Z",
      openedAt: undefined,
    });
    expect(event.idempotencyKey).toMatch(/^gorgias:message:9001:[0-9a-f]{12}$/);
    const all = JSON.stringify(event);
    expect(all).not.toContain("ring ready");
    expect(all).not.toContain("Test Customer");
    expect(all).not.toContain(synthetic.email(1));
    expect(all).not.toContain("help@store");
  });

  it("logs the store's reply with who sent it and who it went to, and an internal note with no customer", () => {
    const to = [{ address: synthetic.email(3) }, { address: synthetic.email(4) }, "x", { address: "nope" }];
    const reply = gorgiasMessageEvent(message({ from_agent: true, sender: { id: GORGIAS_TEST_AGENT }, source: { from: { address: "help@store.test" }, to }, sent_datetime: g(1), opened_datetime: g(0.5), attachments: [{}, {}], rule_id: 3 }), ctx).event.payload;
    expect(reply).toMatchObject({ direction: "outbound", sentBy: `gorgias_user:${GORGIAS_TEST_AGENT}`, customerRefs: [...refs(3), ...refs(4)].sort(), sentAt: before(1), openedAt: before(0.5), attachmentCount: 2, byRule: true });
    const note = gorgiasMessageEvent(message({ public: false, from_agent: true, sender: { id: 8 } }), ctx).event.payload;
    expect(note).toMatchObject({ direction: "internal", sentBy: "gorgias_user:8", customerRefs: [] });
    expect(gorgiasMessageEvent(message({ public: false }), ctx).event.payload).toMatchObject({ direction: "internal", sentBy: undefined });
    const many = Array.from({ length: 12 }, (_, i) => ({ address: synthetic.email(i + 1) }));
    expect(gorgiasMessageEvent(message({ from_agent: true, source: { to: many } }), ctx).event.payload.customerRefs).toHaveLength(10);
    expect(gorgiasMessageEvent(message({ from_agent: true, source: { to: [{ address: synthetic.email(2) }, { address: synthetic.email(2).toUpperCase() }] } }), ctx).event.payload.customerRefs).toEqual(refs(2));
    for (const source of [undefined, {}, { to: "x" }]) expect(gorgiasMessageEvent(message({ from_agent: true, source }), ctx).event.payload.customerRefs).toEqual([]);
    expect(gorgiasMessageEvent(message({ source: undefined }), ctx).event.payload.customerRefs).toEqual([]);
  });

  it("notes a failed or deleted message, and drops what doesn't read", () => {
    expect(gorgiasMessageEvent(message({ failed_datetime: g(1), deleted_datetime: g(1) }), ctx).event.payload).toMatchObject({ failed: true, deleted: true });
    expect(gorgiasMessageEvent(message({ failed_datetime: "x", deleted_datetime: 5 }), ctx).event.payload).toMatchObject({ failed: false, deleted: false });
    for (const body_text of [undefined, null, 5]) expect(gorgiasMessageEvent(message({ body_text }), ctx).event.payload.textLength).toBeUndefined();
    expect(gorgiasMessageEvent(message({ body_text: "" }), ctx).event.payload.textLength).toBe(0);
    for (const bad of ["a<b>", "Email", 5]) expect(gorgiasMessageEvent(message({ channel: bad, via: bad }), ctx).event.payload).toMatchObject({ channel: undefined, via: undefined });
    for (const attachments of [undefined, null, {}, "abc"]) expect(gorgiasMessageEvent(message({ attachments }), ctx).event.payload.attachmentCount).toBe(0);
    for (const rule_id of [0, "3", null]) expect(gorgiasMessageEvent(message({ rule_id }), ctx).event.payload.byRule).toBe(false);
    expect(gorgiasMessageEvent(message({ from_agent: true, sender: { id: -1 } }), ctx).event.payload.sentBy).toBeUndefined();
    expect(gorgiasMessageEvent(message({ sent_datetime: "later" }), ctx).event.payload.sentAt).toBe("2026-01-01T00:01:00.000Z");
  });

  it("is a duplicate when read again unchanged, and a new event when it changes", () => {
    const a = gorgiasTicketEvent(ticket(), ctx).event;
    expect(gorgiasTicketEvent(ticket(), { ...ctx, receivedAt: "2026-11-12T00:00:00.000Z" }).event.idempotencyKey).toBe(a.idempotencyKey);
    expect(gorgiasTicketEvent(ticket({ status: "closed" }), ctx).event.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(gorgiasMessageEvent(message({ opened_datetime: g(1) }), ctx).event.idempotencyKey).not.toBe(gorgiasMessageEvent(message(), ctx).event.idempotencyKey);
  });

  it("dead-letters a ticket or message it can't read, saying why", () => {
    const bad = gorgiasTicketEvent({ id: "101", created_datetime: "2026-02-30T00:00:00", status: "Open" }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.event.occurredAt).toBeUndefined();
    expect(bad.event.idempotencyKey).toMatch(/^gorgias:unreadable_ticket:[0-9a-f]{12}$/);
    expect(bad.event.payload).toEqual({ system: "Gorgias", ticketId: null, problems: ["ticket has no id that reads", "ticket has no creation time that reads", "ticket has no status that reads"] });
    for (const raw of ["x", ["x"], null]) expect(gorgiasTicketEvent(raw, ctx).event.payload.problems).toContain("ticket is not an object");
    expect(gorgiasTicketEvent(ticket({ status: undefined }), ctx).event.payload).toEqual({ system: "Gorgias", ticketId: 101, problems: ["ticket has no status that reads"] });
    for (const id of [0, -1, 1.5, 2 ** 53]) expect(gorgiasTicketEvent(ticket({ id }), ctx).ok).toBe(false);
    const msg = gorgiasMessageEvent({ id: 5, created_datetime: "now", public: true }, ctx);
    expect(msg.event.payload).toEqual({ system: "Gorgias", messageId: 5, problems: ["message has no ticket that reads", "message has no time that reads", "message doesn't say whether it is public and who wrote it"] });
    expect(msg.event.idempotencyKey).toMatch(/^gorgias:unreadable_message:[0-9a-f]{12}$/);
    expect(gorgiasMessageEvent(7, ctx).event.payload.problems).toEqual(["message is not an object", "message has no id that reads", "message has no ticket that reads", "message has no time that reads", "message doesn't say whether it is public and who wrote it"]);
    expect(gorgiasMessageEvent(message({ public: "yes" }), ctx).ok).toBe(false);
    expect(gorgiasMessageEvent(message({ from_agent: null }), ctx).ok).toBe(false);
    // Two rows with the same problems are still two dead letters.
    expect(gorgiasTicketEvent({ id: 0 }, ctx).event.idempotencyKey).not.toBe(gorgiasTicketEvent({ id: -1 }, ctx).event.idempotencyKey);
  });
});

describe("Gorgias checkpoint", () => {
  const pass = { floor: before(30), top: before(2), cursor: "abc=" };
  const cursor = (c: unknown) => JSON.stringify(c);

  it("round-trips and turns down any other shape", () => {
    expect(parseGorgiasCursor(null)).toBeNull();
    const good: GorgiasCursor[] = [{ pass, done: false, mark: null }, { pass: null, done: true, mark: before(1) }, { pass: { floor: before(3), top: null, cursor: null }, done: true, mark: before(5) }];
    for (const c of good) expect(parseGorgiasCursor(cursor(c))).toEqual(c);
    const bad = [
      "x",
      "null",
      "[]",
      "5",
      cursor({ pass: null, done: "yes", mark: null }),
      cursor({ pass: null, done: true, mark: "2026-11-01T00:00:00Z" }),
      cursor({ pass: null, done: true }),
      cursor({ pass: { ...pass, floor: "x" }, done: false, mark: null }),
      cursor({ pass: { ...pass, floor: undefined }, done: false, mark: null }),
      cursor({ pass: { ...pass, top: "x" }, done: false, mark: null }),
      cursor({ pass: { ...pass, top: undefined }, done: false, mark: null }),
      cursor({ pass: { ...pass, cursor: "a b" }, done: false, mark: null }),
      cursor({ pass: { ...pass, cursor: 5 }, done: false, mark: null }),
      cursor({ pass: { ...pass, cursor: undefined }, done: false, mark: null }),
      cursor({ pass: "x", done: false, mark: null }),
      cursor({ pass: 5, done: false, mark: null }),
      cursor({ done: false, mark: null }),
    ];
    for (const raw of bad) expect(() => parseGorgiasCursor(raw), raw).toThrow("Gorgias checkpoint is not in the expected shape");
    expect(parseGorgiasCursor(cursor({ pass: { ...pass, extra: 1 }, done: false, mark: null, more: 2 }))).toEqual({ pass, done: false, mark: null });
    expect(GORGIAS_CURSOR.test("abc=")).toBe(true);
    expect(() => parseGorgiasCursor("")).toThrow("Gorgias checkpoint is not in the expected shape");
  });
});

describe("Gorgias connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(gorgiasDocMock(helpdesk())), expected: { ingested: 9 } });
    expect(result.full.ingested).toBe(9);
  });

  it("imports five years of tickets with their messages, stops at the first older one, then stops for good", async () => {
    const mock = gorgiasDocMock(helpdesk());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(9);
    expect(mock.reads).toEqual([
      { kind: "tickets", query: { order_by: "updated_datetime:desc", limit: "100" } },
      ...[101, 102, 103].map((id) => ({ kind: "messages", query: { ticket_id: String(id), order_by: "created_datetime:asc", limit: "100" } })),
    ]);
    expect(memory.events.map((e) => e.type).sort()).toEqual([...Array(6).fill(GORGIAS_MESSAGE_EVENT), ...Array(3).fill(GORGIAS_TICKET_EVENT)]);
    expect(parseGorgiasCursor(report.cursor)).toEqual({ pass: null, done: true, mark: before(1) });
    assertSynthetic(memory.events);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(4);
  });

  it("reads 100 tickets a page, keeping Gorgias's cursor in the checkpoint, and resumes there", async () => {
    gorgiasTicket.reset();
    const tickets = Array.from({ length: 230 }, (_, i) => gorgiasTicket.one({ updated_datetime: g(1 + i / 100) }));
    const mock = gorgiasDocMock(helpdesk({ tickets, messages: [] }));
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([100, 100, 30]);
    const cursors = batches.map((b) => parseGorgiasCursor(b.cursor ?? null)!);
    const floor = "2021-11-11T15:00:00.000Z";
    const at = (n: number) => Buffer.from(`offset:${n}`).toString("base64url");
    expect(cursors[0]).toEqual({ pass: { floor, top: before(1), cursor: at(100) }, done: false, mark: null });
    expect(cursors[2]).toEqual({ pass: null, done: true, mark: before(1) });
    const resumed = gorgiasDocMock(helpdesk({ tickets, messages: [] }));
    const later = () => new Date(NOW().getTime() + 5 * HOUR_MS);
    const rest = await drain(connector(resumed, { now: later }).historicalImport({ cursor: batches[0]!.cursor } as never));
    expect(rest.map((b) => b.events.length)).toEqual([100, 30]);
    expect(resumed.reads[0]!.query.cursor).toBe(at(100));
    expect(parseGorgiasCursor(rest.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, mark: before(1) });
  });

  it("reads every page of a ticket's messages", async () => {
    gorgiasMessage.reset();
    const messages = Array.from({ length: 250 }, () => gorgiasMessage.one({ ticket_id: 101 }));
    const mock = gorgiasDocMock(helpdesk({ messages }));
    const events = eventsOf(await drain(connector(mock).historicalImport({ cursor: null } as never)));
    expect(events.filter((e) => e.type === GORGIAS_MESSAGE_EVENT)).toHaveLength(250);
    expect(mock.reads.filter((r) => r.kind === "messages").map((r) => r.query.ticket_id)).toEqual(["101", "101", "101", "102", "103"]);
  });

  it("gives up on a ticket with more than 50 pages of messages", async () => {
    let pages = 0;
    const client: GorgiasClient = {
      tickets: async () => ({ rows: [gorgiasTicketRow()], next: null }),
      messages: async () => (pages++, { rows: [], next: "more" }),
    };
    await expect(drain(gorgiasConnector({ domain: GORGIAS_TEST_DOMAIN, clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: REFRESH, customerKey: CUSTOMER_KEY, client, now: NOW }).incrementalSync({ cursor: null } as never))).rejects.toThrow("Gorgias listed more than 50 pages of messages on one ticket");
    expect(pages).toBe(50);
  });

  it("reads only the tickets that changed since the last pass, less five minutes", async () => {
    const data = helpdesk();
    const mock = gorgiasDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // A ticket last changed 4 minutes before the mark is re-read; one changed 6 minutes before isn't.
    data.tickets![1]!.updated_datetime = g(1 + 4 / 60);
    data.tickets![2]!.updated_datetime = g(1 + 6 / 60);
    data.tickets![2]!.status = "closed";
    const sync = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // Each mode keeps its own checkpoint, so the first later sync looks back two days: both changed tickets are new.
    expect(sync.ingested).toBe(2);
    const inc = await drain(connector(mock).incrementalSync({ cursor: sync.cursor } as never));
    const changed = eventsOf(inc).filter((e) => e.type === GORGIAS_TICKET_EVENT).map((e) => e.payload.ticketId);
    expect(changed).toEqual(["gorgias:ticket:101", "gorgias:ticket:102"]);
    expect(GORGIAS_OVERLAP_MS).toBe(5 * 60_000);
  });

  it("moves its mark to the newest change it saw, and keeps it when nothing changed", async () => {
    const data = helpdesk();
    const mock = gorgiasDocMock(data);
    const start = JSON.stringify({ pass: null, done: true, mark: before(2) } satisfies GorgiasCursor);
    const first = await drain(connector(mock).incrementalSync({ cursor: start } as never));
    expect(parseGorgiasCursor(first.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, mark: before(1) });
    data.tickets = [];
    const quiet = await drain(connector(mock).incrementalSync({ cursor: first.at(-1)!.cursor } as never));
    expect(parseGorgiasCursor(quiet.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, mark: before(1) });
  });

  it("looks back two days on a first sync with no checkpoint", async () => {
    const mock = gorgiasDocMock(helpdesk());
    const batches = await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(eventsOf(batches).filter((e) => e.type === GORGIAS_TICKET_EVENT).map((e) => e.payload.ticketId)).toEqual(["gorgias:ticket:101", "gorgias:ticket:102"]);
    expect(parseGorgiasCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: false, mark: before(1) });
    expect(GORGIAS_FIRST_LOOKBACK_MS).toBe(48 * HOUR_MS);
  });

  it("keeps saying the import is done through a later sync's pages, and resumes one part way", async () => {
    gorgiasTicket.reset();
    const tickets = Array.from({ length: GORGIAS_PAGE_SIZE + 1 }, (_, i) => gorgiasTicket.one({ updated_datetime: g(1 + i / 1000) }));
    const mock = gorgiasDocMock(helpdesk({ tickets, messages: [] }));
    const start = JSON.stringify({ pass: null, done: true, mark: before(26) } satisfies GorgiasCursor);
    const batches = await drain(connector(mock).incrementalSync({ cursor: start } as never));
    expect(batches.map((b) => parseGorgiasCursor(b.cursor ?? null)!.done)).toEqual([true, true]);
    const mid = parseGorgiasCursor(batches[0]!.cursor ?? null)!;
    expect(mid.mark).toBe(before(26));
    const rest = await drain(connector(mock).incrementalSync({ cursor: batches[0]!.cursor } as never));
    expect(eventsOf(rest)).toHaveLength(1);
    expect(parseGorgiasCursor(rest.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, mark: before(1) });
  });

  it("stops a pass at the first ticket older than its floor, taking one changed right at it, and marks the newest seen", async () => {
    gorgiasTicket.reset();
    const floor = before(10);
    const at = (ago: number) => gorgiasTicket.one({ updated_datetime: g(ago) });
    // Out of order, as Gorgias shouldn't send them: the pass trusts the first older one to end it.
    const pages = [{ rows: [at(5), at(2), at(10), at(11), at(1)], next: "page2" }, { rows: [at(3)], next: null }];
    const asked: (string | null)[] = [];
    const fake: GorgiasClient = { tickets: async (cursor) => (asked.push(cursor), pages[asked.length - 1]!), messages: async () => ({ rows: [], next: null }) };
    const c = connector(gorgiasDocMock(helpdesk()), { client: fake });
    const batches = await drain(c.incrementalSync({ cursor: JSON.stringify({ pass: { floor, top: null, cursor: null }, done: true, mark: null }) } as never));
    expect(asked).toEqual([null]);
    expect(eventsOf(batches).map((e) => e.occurredAt)).toEqual([before(5), before(2), before(10)]);
    expect(eventsOf(batches).every((e) => e.receivedAt === RECEIVED)).toBe(true);
    expect(parseGorgiasCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, mark: before(2) });
  });

  it("dead-letters what it can't read and carries on, reading no messages for it", async () => {
    gorgiasTicket.reset();
    const tickets = [gorgiasTicket.one({ updated_datetime: g(2), status: "Open" }), gorgiasTicket.one({ updated_datetime: g(3) })];
    const mock = gorgiasDocMock(helpdesk({ tickets, messages: [] }));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(1);
    expect(report.deadLettered).toBe(1);
    expect(mock.reads.filter((r) => r.kind === "messages").map((r) => r.query.ticket_id)).toEqual(["102"]);
  });

  it("waits out a rate limit inside a sync, and signs in again when its token stops working", async () => {
    const mock = gorgiasDocMock(helpdesk({ rateLimits: 2, retryAfter: "5" }));
    const slept: number[] = [];
    const c = connector(mock, { sleep: async (ms) => void slept.push(ms) });
    await drain(c.incrementalSync({ cursor: null } as never));
    expect(slept).toEqual([5000, 5000]);
    mock.revokeTokens();
    await drain(c.incrementalSync({ cursor: null } as never));
    expect(mock.signIns).toBe(2);
  });

  it("stops on a turned-down sign-in or a token that can write", async () => {
    const wrong = gorgiasDocMock(helpdesk({ refreshToken: "z".repeat(32) }));
    await expect(drain(connector(wrong).incrementalSync({ cursor: null } as never))).rejects.toThrow("Gorgias turned down the sign-in");
    const bigger = gorgiasDocMock(helpdesk({ scope: "openid tickets:read tickets:write" }));
    await expect(drain(connector(bigger).incrementalSync({ cursor: null } as never))).rejects.toThrow("the app has tickets:write; KaratOS only reads");
    expect(bigger.reads).toEqual([]);
    const silent = gorgiasDocMock(helpdesk({ scope: null }));
    await expect(drain(connector(silent).incrementalSync({ cursor: null } as never))).rejects.toThrow("didn't say which scopes");
    const badSecret = gorgiasDocMock(helpdesk({ clientSecret: "z".repeat(32) }));
    await expect(drain(connector(badSecret).incrementalSync({ cursor: null } as never))).rejects.toThrow("Gorgias turned down the sign-in");
  });

  it("checks its settings", () => {
    const mock = gorgiasDocMock(helpdesk());
    expect(() => connector(mock, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY");
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { domain: "x.y" })).toThrow("GORGIAS_DOMAIN");
    expect(() => connector(mock, { domain: "x.y", client: {} as GorgiasClient })).not.toThrow();
    expect(connector(mock).source).toBe("gorgias");
  });

  it("reads back as far as told, and up to now when no clock is given", async () => {
    const data = helpdesk();
    data.tickets![2]!.updated_datetime = g(10_000);
    const mock = gorgiasDocMock(data);
    const batches = await drain(connector(mock, { historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(parseGorgiasCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, mark: before(1) });
    expect(eventsOf(batches).filter((e) => e.type === GORGIAS_TICKET_EVENT)).toHaveLength(2);
    const seen: string[] = [];
    const client: GorgiasClient = { tickets: async () => ({ rows: [gorgiasTicketRow(new Date().toISOString())], next: null }), messages: async () => (seen.push("m"), { rows: [], next: null }) };
    const out = await drain(gorgiasConnector({ domain: GORGIAS_TEST_DOMAIN, clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: REFRESH, customerKey: CUSTOMER_KEY, client }).incrementalSync({ cursor: null } as never));
    expect(eventsOf(out)[0]!.receivedAt.slice(0, 4)).toBe(String(new Date().getUTCFullYear()));
    expect(seen).toEqual(["m"]);
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(GORGIAS_WRITES).toEqual([
      { integration: "gorgias", name: "add_internal_note", description: "Add an internal note to a Gorgias ticket", kind: "append", approval: "each", dailyCap: 20 },
      { integration: "gorgias", name: "add_tag", description: "Tag a Gorgias ticket", kind: "update", approval: "each", dailyCap: 20 },
    ]);
    const c = connector(gorgiasDocMock(helpdesk()));
    expect(c.writes).toBe(GORGIAS_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "add_internal_note", integration: "gorgias", outcome: "refused" },
      { action: "add_tag", integration: "gorgias", outcome: "refused" },
    ]);
  });
});

/** A readable ticket as Gorgias writes it, changed at `at`. */
function gorgiasTicketRow(at = before(1)) {
  gorgiasTicket.reset();
  return gorgiasTicket.one({ updated_datetime: gorgiasTimeOf(at) });
}

describe("Gorgias doc mock", () => {
  it("wants Basic auth and the refresh grant to sign in", async () => {
    const mock = gorgiasDocMock(helpdesk());
    const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`;
    const post = (headers: Record<string, string>, body: string) => mock.fetch(`${BASE}/oauth/token`, { method: "POST", headers, body });
    const form = "application/x-www-form-urlencoded";
    const good = new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH }).toString();
    expect((await post({ "content-type": form }, good)).status).toBe(401);
    expect((await post({ authorization: basic, "content-type": "application/json" }, good)).status).toBe(400);
    expect((await post({ authorization: basic }, good)).status).toBe(400);
    expect((await post({ authorization: basic, "content-type": form }, "grant_type=authorization_code")).status).toBe(400);
    expect((await post({ authorization: basic, "content-type": form }, good)).status).toBe(200);
    expect(mock.signIns).toBe(1);
  });

  it("wants a token it issued, and checks the parameters, sort, page size and cursor", async () => {
    const mock = gorgiasDocMock(helpdesk());
    const signIn = await mock.fetch(`${BASE}/oauth/token`, { method: "POST", headers: { authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH }).toString() });
    const { access_token } = (await signIn.json()) as { access_token: string };
    const get = (path: string, token = access_token) => mock.fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await get("/api/tickets", "nope")).status).toBe(401);
    expect((await mock.fetch(`${BASE}/api/tickets`)).status).toBe(401);
    expect((await get("/api/tickets?since=2026")).status).toBe(400);
    expect((await get("/api/tickets?order_by=closed_datetime:desc")).status).toBe(400);
    expect((await get("/api/messages?order_by=updated_datetime:desc")).status).toBe(400);
    expect((await get("/api/tickets?limit=101")).status).toBe(400);
    expect((await get("/api/tickets?limit=0")).status).toBe(400);
    expect((await get("/api/tickets?cursor=!!")).status).toBe(400);
    const first = (await (await get("/api/tickets?limit=2")).json()) as { data: { id: number }[]; meta: { prev_cursor: string | null; next_cursor: string } };
    // Newest created first by default.
    expect(first.data.map((t) => t.id)).toEqual([101, 102]);
    expect(first.meta.prev_cursor).toBeNull();
    const second = (await (await get(`/api/tickets?limit=2&cursor=${first.meta.next_cursor}`)).json()) as { data: { id: number }[]; meta: { prev_cursor: string; next_cursor: string | null } };
    expect(second.data.map((t) => t.id)).toEqual([103, 104]);
    expect(second.meta).toEqual({ prev_cursor: Buffer.from("offset:0").toString("base64url"), next_cursor: null });
    const oldest = (await (await get("/api/tickets?order_by=created_datetime:asc&limit=1")).json()) as { data: { id: number }[] };
    expect(oldest.data.map((t) => t.id)).toEqual([104]);
    // Tickets changed at the same moment come in id order.
    const tied = gorgiasDocMock(helpdesk({ tickets: [gorgiasTicket.one({ id: 9, updated_datetime: g(1) }), gorgiasTicket.one({ id: 3, updated_datetime: g(1) })], messages: [] }));
    expect((await drain(connector(tied).incrementalSync({ cursor: null } as never)))[0]!.events.map((e) => e.payload.ticketId)).toEqual(["gorgias:ticket:3", "gorgias:ticket:9"]);
    const all = (await (await get("/api/messages")).json()) as { data: unknown[] };
    expect(all.data).toHaveLength(8);
    expect(mock.reads.at(-1)).toEqual({ kind: "messages", query: {} });
  });

  it("lists nothing when given no tickets or messages, and answers 429 with or without Retry-After", async () => {
    const { tickets: _t, messages: _m, ...bare } = helpdesk();
    const empty = gorgiasDocMock(bare);
    const { c } = client(empty.fetch);
    expect(await c.tickets(null)).toEqual({ rows: [], next: null });
    expect(await c.messages(1, null)).toEqual({ rows: [], next: null });
    for (const retryAfter of [undefined, "2"]) {
      const mock = gorgiasDocMock(helpdesk({ rateLimits: 1, ...(retryAfter === undefined ? {} : { retryAfter }) }));
      const r = client(mock.fetch, { retries: 0 });
      await expect(r.c.tickets(null)).rejects.toMatchObject({ status: 429 });
    }
  });
});
