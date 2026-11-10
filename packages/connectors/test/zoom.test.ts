import { describe, expect, it, vi } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, ZOOM_TEST_HOST, assertSynthetic, assertWritesRefused, checkConnectorSync, synthetic, testPipeline, zoomDocMock, zoomMeeting, zoomParticipants, type ZoomMock, type ZoomMockData, type ZoomMockRecord } from "@karatos/connector-testkit";
import {
  ZOOM_API_URL,
  ZOOM_HELD_EVENT,
  ZOOM_OVERLAP_DAYS,
  ZOOM_PAGE_SIZE,
  ZOOM_PAGE_TOKEN,
  ZOOM_READ_SCOPES,
  ZOOM_SPAN_DAYS,
  ZOOM_TOKEN_URL,
  ZOOM_WRITES,
  ZoomApiError,
  ZoomConfigError,
  formCustomerRefs,
  parseZoomCursor,
  zoomClient,
  zoomConnector,
  zoomErrorCode,
  zoomHostRef,
  zoomMeetingEvent,
  zoomSafeTopic,
  zoomUuidPath,
  zoomWriteScopes,
  type ZoomClient,
  type ZoomCursor,
  type ZoomEvent,
  type ZoomOptions,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const ACCOUNT = ["acct", "test", "0".repeat(8)].join("_");
const CLIENT_ID = ["cid", "test", "0".repeat(8)].join("_");
const SECRET = ["zoom", "test", "0".repeat(24)].join("_");
const CUSTOMER_KEY = "c".repeat(40);
const NOW = () => new Date("2026-11-10T15:00:00.000Z");
const RECEIVED = "2026-11-10T15:00:00.000Z";
const DAY_MS = 86_400_000;
const noSleep = async () => {};
const ctx = { customerKey: CUSTOMER_KEY, receivedAt: RECEIVED };

/** `ago` days before NOW, as Zoom writes times. */
const daysAgo = (ago: number, plusMinutes = 0) => new Date(NOW().getTime() - ago * DAY_MS + plusMinutes * 60_000).toISOString().replace(".000Z", "Z");

/** A meeting `ago` days back, and its report with the host and one guest. */
function held(ago: number, overrides: ZoomMockRecord = {}): { meeting: ZoomMockRecord; rows: ZoomMockRecord[] } {
  const meeting = zoomMeeting.one({ start_time: daysAgo(ago), end_time: daysAgo(ago, 30), ...overrides });
  return { meeting, rows: zoomParticipants(meeting, Number(String(meeting.meeting_uuid).slice(6, 12))) };
}

/** Meetings 1, 10 and 100 days ago, and one 300 days ago, past the six months read. */
function account(overrides: Partial<ZoomMockData> = {}): ZoomMockData {
  zoomMeeting.reset();
  const all = [1, 10, 100, 300].map((ago) => held(ago));
  return {
    accountId: ACCOUNT,
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    meetings: all.map((m) => m.meeting),
    participants: Object.fromEntries(all.map((m) => [String(m.meeting.meeting_uuid), m.rows])),
    ...overrides,
  };
}

const connector = (mock: ZoomMock, overrides: Partial<ZoomOptions> = {}) =>
  zoomConnector({ accountId: ACCOUNT, clientId: CLIENT_ID, clientSecret: SECRET, customerKey: CUSTOMER_KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });

const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as ZoomEvent[];

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
const TOKEN = `tok_${"t".repeat(30)}`;
const tokenAnswer = (extra: Record<string, unknown> = {}) => json(200, { access_token: TOKEN, token_type: "bearer", expires_in: 3599, scope: ZOOM_READ_SCOPES.join(" "), api_url: "https://elsewhere.example.test", ...extra });
const EMPTY = { history_meetings: [], next_page_token: "" };
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof zoomClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = zoomClient({ accountId: ACCOUNT, clientId: CLIENT_ID, clientSecret: SECRET, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const Q = { from: "2026-11-01", to: "2026-11-10", next: null };

describe("Zoom client", () => {
  it("checks the app's credentials before sending anything", () => {
    const { fetch, sent } = scripted(tokenAnswer());
    const make = (o: Partial<Parameters<typeof zoomClient>[0]>) => () => zoomClient({ accountId: ACCOUNT, clientId: CLIENT_ID, clientSecret: SECRET, fetch, ...o });
    for (const accountId of ["", "short", "a".repeat(7), "a".repeat(65), "has space1", undefined]) expect(make({ accountId: accountId as string }), String(accountId)).toThrow("ZOOM_ACCOUNT_ID is missing or not in the expected shape");
    for (const clientId of ["", "a".repeat(7), "a".repeat(65), "bad!char1", undefined]) expect(make({ clientId: clientId as string }), String(clientId)).toThrow("ZOOM_CLIENT_ID is missing or not in the expected shape");
    for (const clientSecret of ["", "a".repeat(15), "a".repeat(129), `${SECRET}!`, undefined]) expect(make({ clientSecret: clientSecret as string }), String(clientSecret)).toThrow("ZOOM_CLIENT_SECRET is missing or not in the expected shape");
    expect(make({ accountId: "" })).toThrow(ZoomConfigError);
    for (const ok of [{ accountId: "a".repeat(8) }, { accountId: "a".repeat(64) }, { clientId: "a".repeat(8) }, { clientId: "a".repeat(64) }, { clientSecret: "a".repeat(16) }, { clientSecret: "a".repeat(128) }]) expect(make(ok)).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("signs in with the app's credentials, then reads the meeting history with the token", async () => {
    const { fetch, sent } = scripted(tokenAnswer(), json(200, { history_meetings: [{ meeting_uuid: "a" }], next_page_token: "nxt.Tok_en-1+/=" }));
    const { c } = client(fetch, { accountId: ` ${ACCOUNT} `, clientId: ` ${CLIENT_ID}`, clientSecret: `${SECRET} ` });
    expect(await c.meetings(Q)).toEqual({ rows: [{ meeting_uuid: "a" }], next: "nxt.Tok_en-1+/=" });
    expect(sent[0]).toEqual({
      url: ZOOM_TOKEN_URL,
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: `grant_type=account_credentials&account_id=${ACCOUNT}`,
    });
    // The token answer's api_url is ignored: reads go only to Zoom's fixed address.
    expect(sent[1]).toEqual({
      url: `${ZOOM_API_URL}/report/history_meetings?from=2026-11-01&to=2026-11-10&date_type=start_time&meeting_type=meeting&page_size=300`,
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
      body: undefined,
    });
    expect(ZOOM_TOKEN_URL).toBe("https://zoom.us/oauth/token");
    expect(ZOOM_API_URL).toBe("https://api.zoom.us/v2");
    expect(ZOOM_PAGE_SIZE).toBe(300);
  });

  it("keeps a token until five minutes before it lapses, then asks for a new one", async () => {
    let t = 0;
    const { fetch, sent } = scripted(tokenAnswer(), json(200, EMPTY), json(200, EMPTY), tokenAnswer(), json(200, EMPTY));
    const { c } = client(fetch, { clock: () => t });
    await c.meetings(Q);
    t = (3599 - 300) * 1000 - 1;
    await c.meetings(Q);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET"]);
    t += 1;
    await c.meetings(Q);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
  });

  it("keeps a token ten minutes, less the margin, when Zoom doesn't say how long it lasts", async () => {
    for (const expires_in of [undefined, 0, -5, 1.5, "3599"]) {
      let t = 0;
      const { fetch, sent } = scripted(tokenAnswer({ expires_in }), json(200, EMPTY), json(200, EMPTY), tokenAnswer({ expires_in }), json(200, EMPTY));
      const { c } = client(fetch, { clock: () => t });
      await c.meetings(Q);
      t = 300_000 - 1;
      await c.meetings(Q);
      t = 300_000;
      await c.meetings(Q);
      expect(sent.filter((s) => s.method === "POST"), String(expires_in)).toHaveLength(2);
    }
  });

  it("says when Zoom turns down the app's credentials, or answers without a token", async () => {
    for (const status of [400, 401]) {
      const { fetch } = scripted(json(status, { reason: "Invalid client_id or client_secret", error: "invalid_client" }));
      await expect(client(fetch).c.meetings(Q)).rejects.toThrow(`Zoom turned down the app's credentials (HTTP ${status}): check ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET, and that the app is activated`);
    }
    await expect(client(scripted(json(401, {})).fetch).c.meetings(Q)).rejects.toThrow(ZoomConfigError);
    const answers = [json(403, { code: 4700, message: "x" }), json(200, { token_type: "bearer" }), json(200, ["a"]), text(200, "<html>"), json(200, { access_token: "short" }), json(200, { access_token: "a".repeat(15) }), json(403, { access_token: "a".repeat(20), scope: "report:read:admin" }), json(200, { access_token: "has a space in it ok" }), json(200, { access_token: 12345678901234567 }), json(200, { access_token: "a".repeat(4097) })];
    for (const answer of answers) {
      await expect(client(scripted(answer).fetch, { retries: 0 }).c.meetings(Q)).rejects.toThrow(/^Zoom answered the token request with HTTP (403|200) and no token$/);
    }
    await expect(client(scripted(answers[0]!).fetch).c.meetings(Q)).rejects.toMatchObject({ status: 403, code: 4700, name: "ZoomApiError" });
    await expect(client(scripted(json(200, { access_token: "a".repeat(4096), scope: ZOOM_READ_SCOPES.join(" ") }), json(200, EMPTY)).fetch).c.meetings(Q)).resolves.toEqual({ rows: [], next: null });
    await expect(client(scripted(json(200, { access_token: "a".repeat(16), scope: ZOOM_READ_SCOPES.join(" ") }), json(200, EMPTY)).fetch).c.meetings(Q)).resolves.toEqual({ rows: [], next: null });
  });

  it("won't read with a token that can change anything, lists no scopes, or lacks the report scopes", async () => {
    const read = async (scope: unknown) => {
      const { fetch, sent } = scripted(tokenAnswer({ scope }), json(200, EMPTY));
      const result = await client(fetch).c.meetings(Q).then(() => "read", (e: Error) => e);
      return { result, sent };
    };
    const writes = await read(`${ZOOM_READ_SCOPES.join(" ")} meeting:write:meeting:admin user:update:user:admin a:write b:write c:write d:write`);
    expect(writes.result).toBeInstanceOf(ZoomConfigError);
    expect((writes.result as Error).message).toBe(`the Zoom app can change data (meeting:write:meeting:admin, user:update:user:admin, a:write, b:write, c:write); give it only ${ZOOM_READ_SCOPES.join(" ")}`);
    expect(writes.sent).toHaveLength(1);
    for (const scope of [undefined, "", "   ", 5]) expect(((await read(scope)).result as Error).message).toBe("Zoom's token answer did not list its scopes; the connector won't read without knowing it can only read");
    expect(((await read(ZOOM_READ_SCOPES[0])).result as Error).message).toBe(`the Zoom app is missing ${ZOOM_READ_SCOPES[1]}`);
    expect(((await read("user:read:user:admin")).result as Error).message).toBe(`the Zoom app is missing ${ZOOM_READ_SCOPES.join(" ")}`);
    expect((await read("report:read:admin")).result).toBe("read");
    expect((await read(`  ${ZOOM_READ_SCOPES.join("  ")} user:read:user dashboard:read:admin\n`)).result).toBe("read");
    expect(ZOOM_READ_SCOPES).toEqual(["report:read:list_history_meetings:admin", "report:read:list_meeting_participants:admin"]);
  });

  it("tells a read scope from one that changes anything", () => {
    expect(zoomWriteScopes("report:read:admin report:read:list_history_meetings:admin user:read user:read:user user:read:user:master")).toEqual([]);
    for (const s of ["meeting:write", "meeting:write:admin", "meeting:update:meeting:admin", "report:read:list:x:admin", "Report:read:admin", "report:read:admin:extra", "report:read:a:b", ":read", "report:readx", "report:read:user:owner", "x report:read:admin"]) {
      expect(zoomWriteScopes(s), s).toEqual(s.split(" ").filter((p) => p !== "report:read:admin"));
    }
    for (const none of [undefined, null, "", " ", 1, ["report:read:admin"]]) expect(zoomWriteScopes(none), String(none)).toBeNull();
  });

  it("checks days and page tokens before sending, and keeps Zoom's page token", async () => {
    const { fetch, sent } = scripted(tokenAnswer(), json(200, EMPTY));
    const { c } = client(fetch);
    for (const bad of [{ ...Q, from: "2026-11-1" }, { ...Q, to: "2026-11-10T00:00:00Z" }, { ...Q, from: "x2026-11-01" }, { ...Q, to: "2026-11-100" }]) {
      await expect(c.meetings(bad)).rejects.toThrow("meetings must be listed between YYYY-MM-DD days");
    }
    for (const next of ["", "a b", "a".repeat(513), "tok!"]) await expect(c.meetings({ ...Q, next })).rejects.toThrow("a Zoom page token is not in the expected shape");
    expect(sent).toHaveLength(0);
    await c.meetings({ ...Q, next: "a".repeat(512) });
    expect(new URL(sent[1]!.url).searchParams.get("next_page_token")).toBe("a".repeat(512));
    expect(ZOOM_PAGE_TOKEN.test("aZ09_.=+/-")).toBe(true);
  });

  it("says when a page has no list or a page token that doesn't read", async () => {
    const { fetch } = scripted(
      tokenAnswer(),
      json(200, { next_page_token: "" }),
      json(200, { history_meetings: {}, next_page_token: "" }),
      json(200, { history_meetings: [], next_page_token: "a b" }),
      json(200, { history_meetings: [], next_page_token: 5 }),
      json(200, { history_meetings: [], next_page_token: null }),
      json(200, { history_meetings: [] }),
    );
    const { c } = client(fetch);
    await expect(c.meetings(Q)).rejects.toThrow("Zoom answered the meeting history without the history_meetings list");
    await expect(c.meetings(Q)).rejects.toThrow("Zoom answered the meeting history without the history_meetings list");
    await expect(c.meetings(Q)).rejects.toThrow("Zoom answered the meeting history with a page token that doesn't read");
    await expect(c.meetings(Q)).rejects.toMatchObject({ status: 200, name: "ZoomApiError", message: "Zoom answered the meeting history with a page token that doesn't read" });
    expect(await c.meetings(Q)).toEqual({ rows: [], next: null });
    expect(await c.meetings(Q)).toEqual({ rows: [], next: null });
  });

  it("reads a meeting's participants by its UUID, encoded twice when Zoom asks", async () => {
    const { fetch, sent } = scripted(tokenAnswer(), json(200, { participants: [{ name: "x" }], next_page_token: "p2" }), json(200, { participants: [], next_page_token: "" }), json(200, { participants: [], next_page_token: "" }), json(200, { participants: [], next_page_token: "" }));
    const { c } = client(fetch);
    expect(await c.participants("abc+=Q==", null)).toEqual({ rows: [{ name: "x" }], next: "p2" });
    await c.participants("/ab/c==", "p2");
    await c.participants("ab//c==", null);
    await c.participants("a/b", null);
    expect(sent.slice(1).map((s) => s.url)).toEqual([
      `${ZOOM_API_URL}/report/meetings/abc%2B%3DQ%3D%3D/participants?page_size=300`,
      `${ZOOM_API_URL}/report/meetings/%252Fab%252Fc%253D%253D/participants?page_size=300&next_page_token=p2`,
      `${ZOOM_API_URL}/report/meetings/ab%252F%252Fc%253D%253D/participants?page_size=300`,
      `${ZOOM_API_URL}/report/meetings/a%2Fb/participants?page_size=300`,
    ]);
    expect(zoomUuidPath("/x")).toBe("%252Fx");
    expect(zoomUuidPath("x//y")).toBe("x%252F%252Fy");
    expect(zoomUuidPath("x/y")).toBe("x%2Fy");
    for (const bad of ["", "a".repeat(65), 5]) await expect(c.participants(bad as string, null)).rejects.toThrow("a meeting UUID must be 1 to 64 characters");
    await c.participants("a".repeat(64), null);
    expect(sent).toHaveLength(6);
  });

  it("answers null for a meeting Zoom has no report for, and says when a report has no list", async () => {
    const { fetch } = scripted(tokenAnswer(), json(404, { code: 3001, message: "Meeting does not exist." }), json(200, { next_page_token: "" }), json(404, { code: 3001 }));
    const { c } = client(fetch);
    expect(await c.participants("abc", null)).toBeNull();
    await expect(c.participants("abc", null)).rejects.toThrow("Zoom answered a meeting's participants without the participants list");
    // A 404 for the history itself is an error, not an empty answer.
    await expect(c.meetings(Q)).rejects.toMatchObject({ status: 404, code: 3001, message: "Zoom answered HTTP 404 for the meeting history (code 3001)" });
  });

  it("drops a token Zoom turns down, so the next read asks for a new one", async () => {
    const { fetch, sent } = scripted(tokenAnswer(), json(401, { code: 124, message: "Invalid access token." }), tokenAnswer(), json(200, EMPTY));
    const { c } = client(fetch);
    await expect(c.meetings(Q)).rejects.toMatchObject({ status: 401, code: 124, message: "Zoom turned down the token for the meeting history (code 124)" });
    expect(await c.meetings(Q)).toEqual({ rows: [], next: null });
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
  });

  it("explains a plan without reports and other errors, with Zoom's code when it gives one", async () => {
    const { fetch } = scripted(tokenAnswer(), json(403, { code: 200, message: "No permission." }), json(403, {}), json(400, { code: 4711 }), json(400, { code: "4711" }), json(400, { code: -1 }), json(400, { code: 1.5 }), json(401, null));
    const { c } = client(fetch);
    await expect(c.participants("abc", null)).rejects.toMatchObject({ status: 403, code: 200, message: "Zoom's account isn't allowed to read a meeting's participants (code 200): reports need a Pro plan or higher" });
    await expect(c.meetings(Q)).rejects.toMatchObject({ status: 403, code: undefined, message: "Zoom's account isn't allowed to read the meeting history: reports need a Pro plan or higher" });
    await expect(c.meetings(Q)).rejects.toMatchObject({ status: 400, code: 4711, message: "Zoom answered HTTP 400 for the meeting history (code 4711)" });
    for (let i = 0; i < 3; i++) await expect(c.meetings(Q)).rejects.toMatchObject({ status: 400, code: undefined, message: "Zoom answered HTTP 400 for the meeting history" });
    await expect(c.meetings(Q)).rejects.toMatchObject({ status: 401, message: "Zoom turned down the token for the meeting history" });
    expect(zoomErrorCode({ code: 124 })).toBe(124);
    for (const none of [{ code: 0 }, { code: "1" }, ["x"], null, { code: 2 ** 53 }]) expect(zoomErrorCode(none), JSON.stringify(none)).toBeUndefined();
  });

  it("says when a 200 isn't a JSON object", async () => {
    const { fetch } = scripted(tokenAnswer(), text(200, "<html>"), json(200, ["a"]), json(200, null));
    const { c } = client(fetch);
    for (let i = 0; i < 3; i++) await expect(c.meetings(Q)).rejects.toMatchObject({ status: 200, message: "Zoom answered the meeting history with a body that isn't a JSON object" });
  });

  it("waits out rate limits and server errors, backing off, and honors a Retry-After up to a minute", async () => {
    const { fetch, sent } = scripted(json(429, {}), tokenAnswer(), json(500, {}, { "retry-after": "5" }), json(502, {}, { "retry-after": "600" }), json(200, EMPTY));
    const { c, slept } = client(fetch);
    expect(await c.meetings(Q)).toEqual({ rows: [], next: null });
    expect(sent.map((s) => s.method)).toEqual(["POST", "POST", "GET", "GET", "GET"]);
    expect(slept).toEqual([1000, 5000, 1000 * 60]);
  });

  it("retries 503 and 504 too, then gives up", async () => {
    const { fetch, sent } = scripted(tokenAnswer(), json(503, {}, { "retry-after": "soon" }), json(504, {}, { "retry-after": "0" }), json(503, {}, { "retry-after": "-3" }), json(504, { code: 1 }));
    const { c, slept } = client(fetch);
    await expect(c.meetings(Q)).rejects.toMatchObject({ status: 504, message: "Zoom answered HTTP 504 for the meeting history (code 1)" });
    expect(sent).toHaveLength(5);
    expect(slept).toEqual([1000, 2000, 4000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const { fetch, sent } = scripted(tokenAnswer(), json(400, {}));
    await expect(client(fetch).c.meetings(Q)).rejects.toMatchObject({ status: 400 });
    expect(sent).toHaveLength(2);
    const again = scripted(tokenAnswer(), json(429, {}));
    await expect(client(again.fetch, { retries: 1 }).c.meetings(Q)).rejects.toMatchObject({ status: 429 });
    expect(again.sent).toHaveLength(3);
  });

  it("waits for real, and uses the global fetch and clock, when none is given", async () => {
    const { fetch, sent } = scripted(tokenAnswer(), json(429, {}, { "retry-after": "0.001" }), json(200, EMPTY), json(200, EMPTY));
    vi.stubGlobal("fetch", fetch);
    try {
      const c = zoomClient({ accountId: ACCOUNT, clientId: CLIENT_ID, clientSecret: SECRET });
      expect(await c.meetings(Q)).toEqual({ rows: [], next: null });
      await c.meetings(Q);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "GET"]);
  });

  it("only ever asks for a token and reads the two reports", async () => {
    const mock = zoomDocMock(account());
    await runSync({ connector: connector(mock), mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).origin}${new URL(c.url).pathname.replace(/meetings\/[^/]+\/participants/, "meetings/{uuid}/participants")}`))).toEqual(
      new Set(["POST https://zoom.us/oauth/token", "GET https://api.zoom.us/v2/report/history_meetings", "GET https://api.zoom.us/v2/report/meetings/{uuid}/participants"]),
    );
  });
});

describe("Zoom reading helpers", () => {
  it("keys the host like a customer, but apart from customers", () => {
    const ref = zoomHostRef(CUSTOMER_KEY, " Stylist@Store.test ");
    expect(ref).toMatch(/^zoom:host:[0-9a-f]{24}$/);
    expect(ref).toBe(zoomHostRef(CUSTOMER_KEY, ZOOM_TEST_HOST));
    expect(ref).not.toBe(zoomHostRef("d".repeat(40), ZOOM_TEST_HOST));
    expect(ref).not.toContain(formCustomerRefs(CUSTOMER_KEY, { email: ZOOM_TEST_HOST })[0]!.split(":")[1]!.slice(0, 24));
    for (const none of [undefined, "", "not an email", 5]) expect(zoomHostRef(CUSTOMER_KEY, none), String(none)).toBeUndefined();
  });

  it("keeps a topic only when it names nobody", () => {
    expect(zoomSafeTopic("Bridal consultation", ["Test Customer 1"], ["customer1@example.test"])).toBe("Bridal consultation");
    expect(zoomSafeTopic("Ring sizing for Customer", ["Test Customer 1"], [])).toBeUndefined();
    expect(zoomSafeTopic("Call with customer1", [undefined, 5], [5, "not an address", "Customer1@Example.test"])).toBeUndefined();
    expect(zoomSafeTopic("Call: customer1@example.test", [], ["customer1@example.test"])).toBeUndefined();
    expect(zoomSafeTopic("customer1 repair", [], [" Customer1@example.test "])).toBeUndefined();
    // An address's domain isn't a name.
    expect(zoomSafeTopic("Store visit follow-up", [], ["stylist@store.test"])).toBe("Store visit follow-up");
    expect(zoomSafeTopic("Design review: Al", ["Al Smith"], [])).toBeUndefined();
    expect(zoomSafeTopic("Review (Al)", ["Al Smith"], [])).toBeUndefined();
    expect(zoomSafeTopic("Halo design review", ["Al Smith"], [])).toBe("Halo design review");
    expect(zoomSafeTopic("Design a ring", ["A Smith"], [])).toBe("Design a ring");
    expect(zoomSafeTopic("Ring for Jo", ["Smith,Jo"], [])).toBeUndefined();
    expect(zoomSafeTopic("Ring for Jo", ["J.Jo"], [])).toBeUndefined();
    // Names of three letters or more are matched inside words too.
    expect(zoomSafeTopic("Bobby's ring", ["Bob"], [])).toBeUndefined();
    expect(zoomSafeTopic("x".repeat(200), [], [])).toBe("x".repeat(80));
    expect(zoomSafeTopic(undefined, ["Al"], [])).toBeUndefined();
    expect(zoomSafeTopic("", [], [])).toBeUndefined();
  });
});

describe("Zoom events", () => {
  const base = () => {
    zoomMeeting.reset();
    return held(1);
  };

  it("logs a held meeting with the guest as a customer reference and no names or addresses", () => {
    const { meeting, rows } = base();
    const { ok, event } = zoomMeetingEvent(meeting, rows, ctx);
    expect(ok).toBe(true);
    expect(event).toMatchObject({ type: ZOOM_HELD_EVENT, occurredAt: "2026-11-09T15:00:00.000Z", receivedAt: RECEIVED });
    expect(event.payload).toEqual({
      system: "Zoom",
      meetingUuid: meeting.meeting_uuid,
      meetingId: "81000000001",
      title: "Bridal consultation",
      kind: "bridal",
      startAt: "2026-11-09T15:00:00.000Z",
      endAt: "2026-11-09T15:30:00.000Z",
      durationMinutes: 30,
      hostRef: zoomHostRef(CUSTOMER_KEY, ZOOM_TEST_HOST),
      customerRefs: formCustomerRefs(CUSTOMER_KEY, { email: synthetic.email(1) }),
      participantsRead: true,
      participantCount: 2,
      attendeeCount: 1,
      firstGuestJoinedAt: "2026-11-09T15:00:00.000Z",
      recorded: false,
      screenShared: true,
      summarized: false,
    });
    const all = JSON.stringify(event);
    for (const kept of [synthetic.email(1), synthetic.name(1), ZOOM_TEST_HOST, "Store Stylist", "TstGuest", "16779264"]) expect(all).not.toContain(kept);
    expect(ZOOM_HELD_EVENT).toBe("appointment.held");
    assertSynthetic(meeting);
    assertSynthetic(rows);
  });

  it("drops a topic that names a participant or the host, and still reads its kind", () => {
    const { meeting, rows } = base();
    for (const topic of ["Ring repair for Test Customer 1", "Repair: customer1", "Repair with Store Stylist", "Repair stylist@store.test"]) {
      expect(zoomMeetingEvent({ ...meeting, topic }, rows, ctx).event.payload, topic).toMatchObject({ title: undefined, kind: "repair" });
    }
    expect(zoomMeetingEvent({ ...meeting, topic: "Engagement ring call" }, null, ctx).event.payload).toMatchObject({ title: "Engagement ring call", kind: "bridal" });
    // Each name and address is checked: the host's from the meeting, each guest's from the report.
    expect(zoomMeetingEvent({ ...meeting, topic: "Repair with Morgan", host_display_name: "Morgan Lee" }, null, ctx).event.payload.title).toBeUndefined();
    expect(zoomMeetingEvent({ ...meeting, topic: "Repair for stylist" , host_display_name: "Host" }, null, ctx).event.payload.title).toBeUndefined();
    expect(zoomMeetingEvent({ ...meeting, topic: "Repair for Walker" }, [{ name: "Ann Walker" }], ctx).event.payload.title).toBeUndefined();
    expect(zoomMeetingEvent({ ...meeting, topic: "Repair for annw" }, [{ user_email: "annw@example.test" }], ctx).event.payload.title).toBeUndefined();
    expect(zoomMeetingEvent({ ...meeting, topic: "  " }, rows, ctx).event.payload).toMatchObject({ title: undefined, kind: "other" });
    expect(zoomMeetingEvent({ ...meeting, topic: `${"x".repeat(158)} repair` }, rows, ctx).event.payload).toMatchObject({ title: "x".repeat(80), kind: "other" });
    expect(zoomMeetingEvent({ ...meeting, topic: `${"x".repeat(150)} repair` }, rows, ctx).event.payload).toMatchObject({ title: "x".repeat(80), kind: "repair" });
  });

  it("counts each guest once, leaves the host out, and keeps at most twenty references", () => {
    const { meeting, rows } = base();
    const [host, guest] = rows as [ZoomMockRecord, ZoomMockRecord];
    const rejoin = { ...guest, join_time: daysAgo(1, 10) };
    const later = { ...guest, participant_user_id: "", user_email: "", name: "Walk In", join_time: daysAgo(1, 5) };
    const unnamed = { id: "x" };
    const shouting = { ...host, user_email: ZOOM_TEST_HOST.toUpperCase(), participant_user_id: "" };
    const emailOnly = { user_email: "Customer9@Example.test", join_time: "soon" };
    const read = zoomMeetingEvent(meeting, [rejoin, host, guest, later, unnamed, unnamed, shouting, emailOnly, "x", null], ctx).event.payload;
    expect(read).toMatchObject({ attendeeCount: 4, firstGuestJoinedAt: "2026-11-09T15:00:00.000Z" });
    expect(read.customerRefs).toEqual([...formCustomerRefs(CUSTOMER_KEY, { email: synthetic.email(1) }), ...formCustomerRefs(CUSTOMER_KEY, { email: "customer9@example.test" })].sort());
    // Two people by one name are two when Zoom gives them ids; one address in two cases is one person; the same name without either is one.
    const ids = [{ name: "Guest", participant_user_id: "g1" }, { name: "Guest", participant_user_id: "g2" }];
    expect(zoomMeetingEvent(meeting, ids, ctx).event.payload.attendeeCount).toBe(2);
    expect(zoomMeetingEvent(meeting, [{ user_email: "A@example.test", join_time: "a" }, { user_email: "a@example.test", join_time: "b" }], ctx).event.payload.attendeeCount).toBe(1);
    expect(zoomMeetingEvent(meeting, [{ name: "Guest", join_time: "a" }, { name: "Guest", join_time: "b" }], ctx).event.payload.attendeeCount).toBe(1);
    expect(zoomMeetingEvent(meeting, [{ id: "x" }, { id: "y" }], ctx).event.payload.attendeeCount).toBe(2);
    // Without a host address, a guest without one still counts.
    expect(zoomMeetingEvent({ ...meeting, host_email: undefined }, [{ name: "Guest" }], ctx).event.payload.attendeeCount).toBe(1);
    // A guest who rejoins takes one of the twenty references, not two.
    const rejoined = [{ user_email: synthetic.email(50), participant_user_id: "r" }, ...Array.from({ length: 20 }, (_, i) => ({ user_email: synthetic.email(i + 10), participant_user_id: `g${i}` }))];
    expect(zoomMeetingEvent(meeting, [rejoined[0]!, ...rejoined], ctx).event.payload.customerRefs).toHaveLength(20);
    const crowd = Array.from({ length: 25 }, (_, i) => ({ user_email: synthetic.email(i + 10), participant_user_id: `g${i}` }));
    const many = zoomMeetingEvent(meeting, crowd, ctx).event.payload;
    expect(many).toMatchObject({ attendeeCount: 25 });
    expect(many.customerRefs).toHaveLength(20);
    expect(many.customerRefs).toEqual([...(many.customerRefs as string[])].sort());
    // With no host address, every participant is a guest.
    expect(zoomMeetingEvent({ ...meeting, host_email: undefined }, rows, ctx).event.payload).toMatchObject({ attendeeCount: 2, hostRef: undefined });
    expect((zoomMeetingEvent({ ...meeting, host_email: undefined }, rows, ctx).event.payload.customerRefs as string[])).toHaveLength(2);
  });

  it("has no guests when Zoom had no report, and reads what the meeting used", () => {
    const { meeting } = base();
    expect(zoomMeetingEvent(meeting, null, ctx).event.payload).toMatchObject({ participantsRead: false, attendeeCount: undefined, customerRefs: [], firstGuestJoinedAt: undefined, participantCount: 2 });
    expect(zoomMeetingEvent(meeting, [], ctx).event.payload).toMatchObject({ participantsRead: true, attendeeCount: 0 });
    expect(zoomMeetingEvent({ ...meeting, feature_used: { record_to_computer: true, meeting_summary: true, screen_sharing: false } }, null, ctx).event.payload).toMatchObject({ recorded: true, summarized: true, screenShared: false });
    expect(zoomMeetingEvent({ ...meeting, feature_used: { record_to_cloud: true, screen_sharing: "yes" } }, null, ctx).event.payload).toMatchObject({ recorded: true, screenShared: false });
    for (const feature_used of [["record_to_cloud"], null, "record_to_cloud", 5]) expect(zoomMeetingEvent({ ...meeting, feature_used }, null, ctx).event.payload, String(feature_used)).toMatchObject({ recorded: false, screenShared: false, summarized: false });
  });

  it("drops counts and ids that don't read", () => {
    const { meeting } = base();
    expect(zoomMeetingEvent({ ...meeting, meeting_id: "81000000001", duration: 0, participants: 0 }, null, ctx).event.payload).toMatchObject({ meetingId: "81000000001", durationMinutes: 0, participantCount: 0 });
    for (const meeting_id of [12345678, 1_000_000_000_000, "8100000000x", null, 8.1e10 + 0.5, [81_000_000_001], { id: 81_000_000_001 }]) expect(zoomMeetingEvent({ ...meeting, meeting_id }, null, ctx).event.payload.meetingId, String(meeting_id)).toBeUndefined();
    expect(zoomMeetingEvent({ ...meeting, meeting_id: 123456789 }, null, ctx).event.payload.meetingId).toBe("123456789");
    expect(zoomMeetingEvent({ ...meeting, meeting_id: 999_999_999_999 }, null, ctx).event.payload.meetingId).toBe("999999999999");
    for (const n of [-1, 1.5, "30", null]) expect(zoomMeetingEvent({ ...meeting, duration: n, participants: n }, null, ctx).event.payload, String(n)).toMatchObject({ durationMinutes: undefined, participantCount: undefined });
  });

  it("is a duplicate when read again unchanged, and a new event when it changes", () => {
    const { meeting, rows } = base();
    const a = zoomMeetingEvent(meeting, rows, ctx).event;
    expect(zoomMeetingEvent(structuredClone(meeting), structuredClone(rows), { ...ctx, receivedAt: "2026-11-11T00:00:00.000Z" }).event.idempotencyKey).toBe(a.idempotencyKey);
    const b = zoomMeetingEvent({ ...meeting, duration: 31 }, rows, ctx).event;
    expect(b.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(a.idempotencyKey.slice(0, -13)).toBe(`zoom:meeting:${String(meeting.meeting_uuid)}`);
    expect(a.idempotencyKey.slice(-13)).toMatch(/^:[0-9a-f]{12}$/);
    expect(a.id).toBe(`zoom_meeting_${Buffer.from(String(meeting.meeting_uuid)).toString("hex")}_${a.idempotencyKey.slice(-12)}`);
    // Two UUIDs apart only by + and / get their own ids.
    const plus = zoomMeetingEvent({ ...meeting, meeting_uuid: "abcd+efgh==" }, rows, ctx).event;
    const slash = zoomMeetingEvent({ ...meeting, meeting_uuid: "abcd/efgh==" }, rows, ctx).event;
    expect(plus.id).not.toBe(slash.id);
  });

  it("dead-letters a meeting it can't read, saying why", () => {
    const { meeting } = base();
    const bad = (m: unknown) => zoomMeetingEvent(m, null, ctx);
    const notObject = bad("meeting");
    expect(notObject.ok).toBe(false);
    expect(notObject.event).toMatchObject({ type: ZOOM_HELD_EVENT, occurredAt: undefined, payload: { system: "Zoom", meetingUuid: null } });
    expect(notObject.event.payload.problems).toEqual(["meeting is not an object", "meeting has no UUID that reads", "meeting has no start time that reads", "meeting has no end time that reads"]);
    expect(notObject.event.idempotencyKey).toMatch(/^zoom:unreadable_meeting:[0-9a-f]{12}$/);
    expect(notObject.event.id).toBe(`zoom_unreadable_meeting_${notObject.event.idempotencyKey.slice(-12)}`);
    // Two meetings that can't be read are two dead letters, however alike what was read of them.
    expect(bad("other").event.idempotencyKey).not.toBe(notObject.event.idempotencyKey);
    for (const meeting_uuid of ["short", "a".repeat(7), "a".repeat(65), "has space==", 5, 12_345_678]) expect(bad({ ...meeting, meeting_uuid }).event.payload.problems, String(meeting_uuid)).toEqual(["meeting has no UUID that reads"]);
    expect(bad({ ...meeting, meeting_uuid: "a".repeat(8) }).ok).toBe(true);
    expect(bad({ ...meeting, meeting_uuid: "a".repeat(64) }).ok).toBe(true);
    const ends = bad({ ...meeting, end_time: daysAgo(2) });
    expect(ends.event.payload).toEqual({ system: "Zoom", meetingUuid: meeting.meeting_uuid, problems: ["meeting ends before it starts"] });
    expect(bad({ ...meeting, end_time: meeting.start_time }).ok).toBe(true);
    expect(bad({ ...meeting, start_time: "2026-02-30T10:00:00Z" }).event.payload.problems).toEqual(["meeting has no start time that reads"]);
    expect(bad({ ...meeting, end_time: null }).event.payload.problems).toEqual(["meeting has no end time that reads"]);
    expect(bad({ ...meeting, start_time: "x", end_time: "y" }).event.payload.problems).toEqual(["meeting has no start time that reads", "meeting has no end time that reads"]);
  });
});

describe("Zoom checkpoint", () => {
  const pass = { from: "2026-05-10", until: "2026-11-10", spanFrom: "2026-06-09" };
  const nextFrom = "2026-11-08";

  it("round-trips and turns down any other shape", () => {
    const c: ZoomCursor = { pass, done: false, nextFrom };
    expect(parseZoomCursor(JSON.stringify(c))).toEqual(c);
    expect(parseZoomCursor(JSON.stringify({ pass: null, done: true, nextFrom }))).toEqual({ pass: null, done: true, nextFrom });
    expect(parseZoomCursor(JSON.stringify({ pass: { ...pass, extra: 1 }, done: true, nextFrom, more: 2 }))).toEqual({ pass, done: true, nextFrom });
    expect(parseZoomCursor(null)).toBeNull();
    for (const bad of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ pass: null, done: true }),
      JSON.stringify({ pass: null, done: "yes", nextFrom }),
      JSON.stringify({ pass: null, done: true, nextFrom: "2026-02-30" }),
      JSON.stringify({ pass: null, done: true, nextFrom: "2026-11-08T00:00:00Z" }),
      JSON.stringify({ pass: null, done: true, nextFrom: "x2026-11-08" }),
      JSON.stringify({ done: true, nextFrom }),
      JSON.stringify({ pass: [], done: false, nextFrom }),
      JSON.stringify({ pass: "x", done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, from: "2026-5-10" }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, until: null }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, spanFrom: 3 }, done: false, nextFrom }),
    ]) {
      expect(() => parseZoomCursor(bad), bad).toThrow("Zoom checkpoint is not in the expected shape");
    }
  });
});

describe("Zoom connector", () => {
  it("passes the shared sync checks", async () => {
    // One more meeting in the first month, so the crash after the first batch leaves some to resume.
    const data = () => {
      const first = account();
      const early = held(170);
      return { ...first, meetings: [...first.meetings, early.meeting], participants: { ...first.participants, [String(early.meeting.meeting_uuid)]: early.rows } };
    };
    const result = await checkConnectorSync({ makeConnector: () => connector(zoomDocMock(data())), expected: { ingested: 4 } });
    expect(result.full.ingested).toBe(4);
  });

  it("imports six months of meetings, a month at a time, with who joined, then stops for good", async () => {
    const mock = zoomDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(3);
    const history = mock.reads.filter((r) => r.path === "/report/history_meetings").map((r) => [r.query.from, r.query.to]);
    expect(history).toEqual([
      ["2026-05-10", "2026-06-08"],
      ["2026-06-09", "2026-07-08"],
      ["2026-07-09", "2026-08-07"],
      ["2026-08-08", "2026-09-06"],
      ["2026-09-07", "2026-10-06"],
      ["2026-10-07", "2026-11-05"],
      ["2026-11-06", "2026-11-10"],
    ]);
    expect(mock.reads.filter((r) => r.path !== "/report/history_meetings")).toHaveLength(3);
    expect(parseZoomCursor(report.cursor)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08" });
    expect(mock.signIns).toBe(1);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested + again.duplicates).toBe(0);
    expect(ZOOM_SPAN_DAYS).toBe(30);
  });

  it("makes each history page a batch, keeping the span but not Zoom's token, and resumes the span from its start", async () => {
    zoomMeeting.reset();
    const all = [3, 3, 3].map((ago) => held(ago));
    const data = { ...account(), pageCap: 2, meetings: all.map((m) => m.meeting), participants: Object.fromEntries(all.map((m) => [String(m.meeting.meeting_uuid), m.rows])) };
    const mock = zoomDocMock(data);
    const batches = await drain(connector(mock).incrementalSync({ cursor: JSON.stringify({ pass: null, done: true, nextFrom: "2026-11-01" }) } as never));
    expect(batches.map((b) => b.events.length)).toEqual([2, 1]);
    expect(batches.map((b) => parseZoomCursor(b.cursor ?? null))).toEqual([
      { pass: { from: "2026-11-01", until: "2026-11-10", spanFrom: "2026-11-01" }, done: true, nextFrom: "2026-11-08" },
      { pass: null, done: true, nextFrom: "2026-11-08" },
    ]);
    const resumed = zoomDocMock(data);
    const rest = await drain(connector(resumed).incrementalSync({ cursor: batches[0]!.cursor ?? null } as never));
    expect(eventsOf(rest)).toHaveLength(3);
    expect(resumed.reads[0]!.query).toEqual({ from: "2026-11-01", to: "2026-11-10", date_type: "start_time", meeting_type: "meeting", page_size: "300" });
  });

  it("moves to the next span once a span's last page is read", async () => {
    zoomMeeting.reset();
    const all = [100, 100, 1].map((ago) => held(ago));
    const mock = zoomDocMock({ ...account(), pageCap: 1, meetings: all.map((m) => m.meeting), participants: {} });
    const batches = await drain(connector(mock).incrementalSync({ cursor: JSON.stringify({ pass: null, done: false, nextFrom: "2026-07-01" }) } as never));
    expect(batches.map((b) => [b.events.length, parseZoomCursor(b.cursor ?? null)!.pass?.spanFrom ?? null])).toEqual([
      [0, "2026-07-31"],
      [1, "2026-07-31"],
      [1, "2026-08-30"],
      [0, "2026-09-29"],
      [0, "2026-10-29"],
      [1, null],
    ]);
    expect(batches.every((b) => parseZoomCursor(b.cursor ?? null)!.done === false)).toBe(true);
  });

  it("starts later syncs two days back, then from where each pass ended, less two days", async () => {
    const data = account();
    const mock = zoomDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    data.meetings[0]!.duration = 31;
    const later = () => new Date(NOW().getTime() + DAY_MS);
    const extra = held(-0.5);
    data.meetings.push(extra.meeting);
    data.participants![String(extra.meeting.meeting_uuid)] = extra.rows;
    const reads = mock.reads.length;
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // Each mode keeps its own checkpoint, so the first later sync looks back two days.
    expect(mock.reads[reads]!.query).toMatchObject({ from: "2026-11-09", to: "2026-11-11" });
    expect(sync.ingested).toBe(2);
    expect(sync.duplicates).toBe(0);
    expect(parseZoomCursor(sync.cursor)).toEqual({ pass: null, done: false, nextFrom: "2026-11-09" });
    const next = mock.reads.length;
    const quiet = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads[next]!.query).toMatchObject({ from: "2026-11-09", to: "2026-11-11" });
    expect(quiet.duplicates).toBe(2);
    expect(ZOOM_OVERLAP_DAYS).toBe(2);
  });

  it("looks back two days on a first sync with no checkpoint", async () => {
    const mock = zoomDocMock(account());
    const batches = await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(mock.reads[0]!.query).toMatchObject({ from: "2026-11-08", to: "2026-11-10" });
    expect(eventsOf(batches)).toHaveLength(1);
    expect(parseZoomCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: false, nextFrom: "2026-11-08" });
  });

  it("resumes a pass part way, keeping what it says of the import", async () => {
    const mock = zoomDocMock(account());
    const cursor = JSON.stringify({ pass: { from: "2026-07-01", until: "2026-11-10", spanFrom: "2026-11-01" }, done: true, nextFrom: "2026-10-30" } satisfies ZoomCursor);
    const batches = await drain(connector(mock).incrementalSync({ cursor } as never));
    expect(mock.reads[0]!.query).toMatchObject({ from: "2026-11-01", to: "2026-11-10" });
    expect(eventsOf(batches)).toHaveLength(1);
    expect(parseZoomCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-10-30" });
    const imported = zoomDocMock(account());
    // An import already done reads nothing more, even with a later pass part way.
    expect(await drain(connector(imported).historicalImport({ cursor } as never))).toEqual([]);
    expect(imported.reads).toEqual([]);
    const partway = JSON.stringify({ pass: { from: "2026-07-01", until: "2026-11-10", spanFrom: "2026-10-01" }, done: false, nextFrom: "2026-10-30" } satisfies ZoomCursor);
    const resumedImport = await drain(connector(zoomDocMock(account())).historicalImport({ cursor: partway } as never));
    expect(resumedImport.map((b) => parseZoomCursor(b.cursor ?? null))).toEqual([
      { pass: { from: "2026-07-01", until: "2026-11-10", spanFrom: "2026-10-31" }, done: false, nextFrom: "2026-10-30" },
      { pass: null, done: true, nextFrom: "2026-10-30" },
    ]);
  });

  it("reads every page of a meeting's participants, and keeps a meeting Zoom has no report for", async () => {
    const data = account({ pageCap: 1 });
    delete data.participants![String(data.meetings[1]!.meeting_uuid)];
    const mock = zoomDocMock(data);
    const events = eventsOf(await drain(connector(mock, { historyMonths: 1 }).historicalImport({ cursor: null } as never)));
    expect(events.map((e) => e.payload.attendeeCount)).toEqual([undefined, 1]);
    expect(events.map((e) => e.payload.participantsRead)).toEqual([false, true]);
    expect(mock.reads.filter((r) => r.path.includes("participants") && r.query.meetingId === data.meetings[0]!.meeting_uuid)).toHaveLength(2);
  });

  it("keeps every row of each participant page", async () => {
    const data = account({ pageCap: 2 });
    const uuid = String(data.meetings[0]!.meeting_uuid);
    data.participants![uuid]!.push({ name: "Second Guest", participant_user_id: "TstGuest9999", user_email: synthetic.email(99) });
    const events = eventsOf(await drain(connector(zoomDocMock(data), { historyMonths: 1 }).historicalImport({ cursor: null } as never)));
    expect(events.find((e) => e.payload.meetingUuid === uuid)!.payload.attendeeCount).toBe(2);
  });

  it("reads a span of one day, and keeps a pass going into its last day", async () => {
    zoomMeeting.reset();
    const today = held(0.1);
    const mock = zoomDocMock({ ...account(), meetings: [today.meeting], participants: {} });
    const single = JSON.stringify({ pass: { from: "2026-11-10", until: "2026-11-10", spanFrom: "2026-11-10" }, done: true, nextFrom: "2026-11-08" } satisfies ZoomCursor);
    expect(eventsOf(await drain(connector(mock).incrementalSync({ cursor: single } as never)))).toHaveLength(1);
    const twoSpans = await drain(connector(zoomDocMock(account())).incrementalSync({ cursor: JSON.stringify({ pass: null, done: true, nextFrom: "2026-10-11" }) } as never));
    expect(twoSpans.map((b) => parseZoomCursor(b.cursor ?? null)!.pass?.spanFrom ?? null)).toEqual(["2026-11-10", null]);
  });

  it("skips the participant report for a meeting without a UUID, and dead-letters it", async () => {
    const data = account();
    data.meetings[0]!.meeting_uuid = 5;
    data.meetings.push("not a meeting" as never);
    const mock = zoomDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(2);
    expect(report.deadLettered).toBe(1);
    expect(mock.reads.filter((r) => r.path.includes("participants"))).toHaveLength(2);
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = zoomDocMock(account({ rateLimits: 2 }));
    const slept: number[] = [];
    await drain(connector(mock, { sleep: async (ms) => void slept.push(ms) }).incrementalSync({ cursor: null } as never));
    expect(slept).toEqual([1000, 2000]);
  });

  it("stops on turned-down credentials, a token Zoom stops taking, or a write scope", async () => {
    await expect(drain(connector(zoomDocMock(account({ clientSecret: "z".repeat(32) }))).incrementalSync({ cursor: null } as never))).rejects.toThrow(ZoomConfigError);
    await expect(drain(connector(zoomDocMock(account({ accountId: "other_account" }))).incrementalSync({ cursor: null } as never))).rejects.toThrow("Zoom turned down the app's credentials (HTTP 400)");
    await expect(drain(connector(zoomDocMock(account({ scopes: [...ZOOM_READ_SCOPES, "meeting:write:meeting:admin"] }))).incrementalSync({ cursor: null } as never))).rejects.toThrow("the Zoom app can change data (meeting:write:meeting:admin)");
    const mock = zoomDocMock(account());
    const c = connector(mock);
    await drain(c.incrementalSync({ cursor: null } as never));
    mock.expireTokens();
    await expect(drain(c.incrementalSync({ cursor: null } as never))).rejects.toMatchObject({ status: 401, code: 124 });
    await drain(c.incrementalSync({ cursor: null } as never));
    expect(mock.signIns).toBe(2);
  });

  it("checks its settings", () => {
    const mock = zoomDocMock(account());
    expect(() => connector(mock, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY");
    for (const historyMonths of [0, -1, 1.5]) expect(() => connector(mock, { historyMonths })).toThrow("historyMonths must be a positive whole number");
    expect(() => connector(mock, { clientSecret: "x" })).toThrow("ZOOM_CLIENT_SECRET");
    expect(() => connector(mock, { clientSecret: "x", client: {} as ZoomClient })).not.toThrow();
    expect(connector(mock).source).toBe("zoom");
  });

  it("reads back as far as told, and up to today when no clock is given", async () => {
    const mock = zoomDocMock(account());
    await drain(connector(mock, { historyMonths: 12 }).historicalImport({ cursor: null } as never));
    expect(mock.reads[0]!.query.from).toBe("2025-11-10");
    const spans: string[] = [];
    const client: ZoomClient = { meetings: async (q) => (spans.push(q.to), { rows: [], next: null }), participants: async () => null };
    await drain(zoomConnector({ accountId: ACCOUNT, clientId: CLIENT_ID, clientSecret: SECRET, customerKey: CUSTOMER_KEY, client }).incrementalSync({ cursor: null } as never));
    expect(spans).toEqual([new Date().toISOString().slice(0, 10)]);
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(ZOOM_WRITES.map((w) => w.name)).toEqual(["schedule_meeting"]);
    const c = connector(zoomDocMock(account()));
    expect(c.writes).toBe(ZOOM_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([{ action: "schedule_meeting", integration: "zoom", outcome: "refused" }]);
  });
});

describe("Zoom doc mock", () => {
  it("checks the app's credentials and grant", async () => {
    const mock = zoomDocMock(account());
    const sign = (auth: string, body: string) => mock.fetch("https://zoom.us/oauth/token", { method: "POST", headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" }, body });
    const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`;
    expect((await sign(`Basic ${Buffer.from(`${CLIENT_ID}:wrong`).toString("base64")}`, `grant_type=account_credentials&account_id=${ACCOUNT}`)).status).toBe(401);
    expect((await sign(basic, `grant_type=client_credentials&account_id=${ACCOUNT}`)).status).toBe(400);
    expect((await sign(basic, "grant_type=account_credentials&account_id=other")).status).toBe(400);
    const ok = (await (await sign(basic, `grant_type=account_credentials&account_id=${ACCOUNT}`)).json()) as Record<string, unknown>;
    expect(ok).toMatchObject({ token_type: "bearer", expires_in: 3599, scope: ZOOM_READ_SCOPES.join(" ") });
  });

  it("wants a live token with the report scope, and checks its filters", async () => {
    const mock = zoomDocMock(account());
    const token = ((await (await mock.fetch("https://zoom.us/oauth/token", { method: "POST", headers: { authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}` }, body: `grant_type=account_credentials&account_id=${ACCOUNT}` })).json()) as { access_token: string }).access_token;
    const get = (path: string, bearer = token) => mock.fetch(`https://api.zoom.us/v2${path}`, { headers: { authorization: `Bearer ${bearer}` } });
    expect((await get("/report/history_meetings?from=2026-11-01&to=2026-11-10", "other")).status).toBe(401);
    expect((await get("/report/history_meetings?from=2026-11-01")).status).toBe(400);
    expect((await get("/report/history_meetings?from=2026-10-01&to=2026-11-10")).status).toBe(400);
    expect((await get("/report/history_meetings?from=2026-11-10&to=2026-11-01")).status).toBe(400);
    expect((await get("/report/history_meetings?from=2026-11-01&to=2026-11-10&page_size=301")).status).toBe(400);
    expect((await get("/report/history_meetings?from=2026-11-01&to=2026-11-10&next_page_token=!!")).status).toBe(400);
    expect((await get("/report/history_meetings?from=2026-11-01&to=2026-11-10&type=past")).status).toBe(400);
    expect((await get("/report/history_meetings?from=2026-11-01&to=2026-11-10&date_type=created")).status).toBe(400);
    expect((await get("/report/history_meetings?from=2026-11-01&to=2026-11-10&meeting_type=phone")).status).toBe(400);
    const page = (await (await get("/report/history_meetings?from=2026-11-01&to=2026-11-10")).json()) as { history_meetings: unknown[]; page_size: number };
    expect(page).toMatchObject({ page_size: 30, history_meetings: [{}] });
    expect((await get("/report/meetings/unknown/participants")).status).toBe(404);
    const narrow = zoomDocMock(account({ scopes: [ZOOM_READ_SCOPES[0]!] }));
    const t2 = ((await (await narrow.fetch("https://zoom.us/oauth/token", { method: "POST", headers: { authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}` }, body: `grant_type=account_credentials&account_id=${ACCOUNT}` })).json()) as { access_token: string }).access_token;
    const denied = await narrow.fetch("https://api.zoom.us/v2/report/meetings/x/participants", { headers: { authorization: `Bearer ${t2}` } });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ code: 4711 });
  });

  it("wants a UUID with a slash encoded twice, and lists webinars apart", async () => {
    zoomMeeting.reset();
    const slashed = held(1, { meeting_uuid: "/Tst//Mtg000001==" });
    const webinar = held(1, { type: "Webinar" });
    const mock = zoomDocMock({ ...account(), meetings: [slashed.meeting, webinar.meeting], participants: { "/Tst//Mtg000001==": slashed.rows } });
    const c = zoomClient({ accountId: ACCOUNT, clientId: CLIENT_ID, clientSecret: SECRET, fetch: mock.fetch });
    expect((await c.participants("/Tst//Mtg000001==", null))!.rows).toHaveLength(2);
    const once = await mock.fetch(`https://api.zoom.us/v2/report/meetings/${encodeURIComponent("/Tst//Mtg000001==")}/participants`, { headers: { authorization: "Bearer zoomtok_1_" + "x".repeat(24) } });
    expect(once.status).toBe(404);
    expect((await c.meetings({ from: "2026-11-09", to: "2026-11-09", next: null })).rows).toEqual([slashed.meeting]);
  });
});
