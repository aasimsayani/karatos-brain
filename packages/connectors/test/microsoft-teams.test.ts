import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, teamsChannel, teamsDocMock, teamsMessage, teamsReply, testPipeline, type TeamsMock, type TeamsMockData, type TeamsMockRecord } from "@karatos/connector-testkit";
import {
  MicrosoftApiError,
  MicrosoftConfigError,
  TEAMS_CHANNEL_SELECT,
  TEAMS_EVENTS,
  TEAMS_MAX_CHANNELS,
  TEAMS_OVERLAP_MS,
  TEAMS_PAGE_SIZE,
  TEAMS_READ_ROLES,
  TEAMS_WRITES,
  parseTeamsCursor,
  teamsClient,
  teamsConnector,
  teamsNormalizer,
  teamsSkipOf,
  teamsTeamLabel,
  type TeamsClient,
  type TeamsClientOptions,
  type TeamsCursor,
  type TeamsEvent,
  type TeamsOptions,
} from "../src/index.js";

const guid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
const TENANT = guid("a");
const CLIENT = guid("b");
const TEAM = guid("c");
const SECRET = "s".repeat(40);
const KEY = "k".repeat(40);
const NOW = new Date("2026-11-11T12:00:00.000Z");
const RECEIVED = NOW.toISOString();
const SINCE = "2021-11-11T12:00:00.000Z";
const GRAPH = "https://graph.microsoft.com/v1.0";
const LOGIN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const BASE = `${GRAPH}/teams/${TEAM}`;
const noSleep = async () => {};
const norm = teamsNormalizer(KEY);

function account(extra: Partial<TeamsMockData> = {}): TeamsMockData {
  teamsChannel.reset();
  teamsMessage.reset();
  const [general, repairs] = teamsChannel.many(2) as [TeamsMockRecord, TeamsMockRecord];
  const [a, b, c] = teamsMessage.many(3) as [TeamsMockRecord, TeamsMockRecord, TeamsMockRecord];
  const withReplies = { ...b, replies: [teamsReply(b, 5), teamsReply(b, 10)] };
  return { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, teamId: TEAM, roles: null, channels: [general, repairs], threads: { [String(general.id)]: [a, withReplies], [String(repairs.id)]: [c] }, ...extra };
}
const CH1 = "19:test0000000000000000000000000001@thread.tacv2";
const CH2 = "19:test0000000000000000000000000002@thread.tacv2";
const options = (mock: TeamsMock, extra: Partial<TeamsOptions> = {}): TeamsOptions => ({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, teamId: TEAM, correspondentKey: KEY, fetch: mock.fetch, sleep: noSleep, now: () => NOW, ...extra });
const connector = (mock: TeamsMock, extra: Partial<TeamsOptions> = {}) => teamsConnector(options(mock, extra));
const clientFor = (mock: TeamsMock, extra: Partial<TeamsClientOptions> = {}) => teamsClient({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, teamId: TEAM, fetch: mock.fetch, sleep: noSleep, now: () => NOW, ...extra });
async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as TeamsEvent[];
const graphCalls = (mock: TeamsMock) => mock.fetch.calls.filter((c) => c.url.startsWith(GRAPH)).map((c) => c.url);
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwt = (claims: unknown) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}
/** A fetch that signs in, then answers Graph in turn. */
function scripted(token: string, ...answers: (() => Response)[]) {
  const sent: Sent[] = [];
  let n = 0;
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), method: init?.method, headers: { ...(init?.headers as Record<string, string>) } });
    if (String(url) === LOGIN_URL) return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });
    return answers[Math.min(n++, answers.length - 1)]!();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const NEXT = { "@odata.nextLink": `${BASE}/channels/${CH1}/messages?$top=50&$expand=replies&$skiptoken=s1` };
const okPage = (link: Record<string, string> = {}, value: unknown[] = []) => json(200, { value, ...link });
const TOKEN = jwt({ roles: ["ChannelMessage.Read.All"] });
const plain = (fetch: typeof globalThis.fetch, extra: Partial<TeamsClientOptions> = {}) => {
  const slept: number[] = [];
  return { c: teamsClient({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, teamId: TEAM, fetch, sleep: async (ms) => void slept.push(ms), now: () => NOW, ...extra }), slept };
};

describe("Teams settings", () => {
  it("checks every setting before sending anything", () => {
    const { fetch, sent } = scripted(TOKEN, okPage());
    const base = { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, teamId: TEAM, fetch };
    expect(() => teamsClient({ ...base, tenantId: "contoso.onmicrosoft.com" })).toThrow(new MicrosoftConfigError("MICROSOFT_TENANT_ID is missing or not a directory (tenant) id"));
    expect(() => teamsClient({ ...base, clientId: "app" })).toThrow(new MicrosoftConfigError("MICROSOFT_TEAMS_CLIENT_ID is missing or not an application (client) id"));
    for (const clientSecret of ["short", "s".repeat(15), "s".repeat(257), `${"s".repeat(10)} ${"s".repeat(10)}`, undefined as never]) expect(() => teamsClient({ ...base, clientSecret }), String(clientSecret)).toThrow(new MicrosoftConfigError("MICROSOFT_TEAMS_CLIENT_SECRET is missing or not in the expected shape"));
    expect(() => teamsClient({ ...base, clientSecret: ` ${"s".repeat(16)} ` })).not.toThrow();
    expect(() => teamsClient({ ...base, clientSecret: "s".repeat(256) })).not.toThrow();
    expect(() => teamsClient({ ...base, teamId: "sales" })).toThrow(new MicrosoftConfigError("MICROSOFT_TEAMS_TEAM_ID is missing or not a team's group id"));
    expect(() => teamsClient({ ...base, teamId: guid("C") })).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("names its read roles, page size and channel fields", () => {
    expect(TEAMS_READ_ROLES).toEqual(["ChannelMessage.Read.All", "ChannelSettings.Read.All", "Channel.ReadBasic.All"]);
    expect(TEAMS_PAGE_SIZE).toBe(50);
    expect(TEAMS_CHANNEL_SELECT).toBe("id,membershipType,createdDateTime,isArchived");
    expect([TEAMS_OVERLAP_MS, TEAMS_MAX_CHANNELS]).toEqual([5 * 60_000, 1000]);
  });
});

describe("Teams paging links", () => {
  it("reads the skip token out of a listing's link, and turns down anything else", () => {
    expect(teamsSkipOf(`${BASE}/channels/${CH1}/messages?$top=50&$expand=replies&$skiptoken=abc`, "/messages")).toBe("abc");
    expect(teamsSkipOf(`${BASE}/channels/${encodeURIComponent(CH1)}/messages/1/replies?$skiptoken=a.b~c=%2B/-_`, "/messages/1/replies")).toBe("a.b~c=+/-_");
    expect(teamsSkipOf(`${BASE}/channels?$select=id&$skiptoken=x`, "/channels")).toBe("x");
    expect(teamsSkipOf(`${BASE}/CHANNELS?$skiptoken=x`, "/channels")).toBe("x");
    const bad = [
      5,
      "not a url",
      `${"x".repeat(10_001)}`,
      `${BASE}/${"a/".repeat(5_000)}channels?$skiptoken=a`,
      `https://graph.microsoft.com.evil.test/v1.0/teams/x/channels?$skiptoken=a`,
      `http://graph.microsoft.com/v1.0/teams/x/channels?$skiptoken=a`,
      `https://u:p@graph.microsoft.com/v1.0/teams/x/channels?$skiptoken=a`,
      `https://u@graph.microsoft.com/v1.0/teams/x/channels?$skiptoken=a`,
      `https://:p@graph.microsoft.com/v1.0/teams/x/channels?$skiptoken=a`,
      `${BASE}/channels?$skiptoken=a#x`,
      `${GRAPH}/users/x/channels?$skiptoken=a`,
      `${GRAPH}/teamsx/channels?$skiptoken=a`,
      `${BASE}/channels/x/messages?$skiptoken=a`,
      `${BASE}/channels`,
      `${BASE}/channels?$skiptoken=a&$skiptoken=b`,
      `${BASE}/channels?$skiptoken=a&$filter=x`,
      `${BASE}/channels?$skiptoken=`,
      `${BASE}/channels?$skiptoken=a%20b`,
      `${BASE}/channels?$skiptoken=${"a".repeat(8193)}`,
      `${GRAPH}/teams/%E0%A4%A/channels?$skiptoken=a`,
    ];
    for (const link of bad) expect(teamsSkipOf(link, "/channels"), String(link).slice(0, 80)).toBeUndefined();
    expect(teamsSkipOf(`${BASE}/channels?$skiptoken=${"a".repeat(8192)}`, "/channels")).toHaveLength(8192);
    expect(teamsSkipOf(`${BASE}/${"a/".repeat(4_900)}channels?$skiptoken=a`, "/channels")).toBe("a");
  });
});

describe("Teams client", () => {
  it("signs in once, then sends only GETs, building every query itself", async () => {
    const mock = teamsDocMock(account({ pageCap: 1 }));
    const c = clientFor(mock);
    const channels = await c.channels();
    expect(channels).toEqual([
      { id: CH1, membershipType: "standard", createdDateTime: "2026-09-30T09:00:00.000Z", isArchived: false },
      { id: CH2, membershipType: "standard", createdDateTime: "2026-09-29T09:00:00.000Z", isArchived: false },
    ]);
    const first = await c.messages(CH1, null);
    expect(first.items).toHaveLength(1);
    expect(first.next).toEqual(expect.any(String));
    const second = await c.messages(CH1, first.next);
    expect(second.next).toBeNull();
    const replies = await c.replies(CH1, String(first.items[0]!.id), null);
    expect(replies.items).toHaveLength(1);
    expect(mock.signIns).toBe(1);
    const urls = graphCalls(mock).map((u) => new URL(u));
    expect(urls.map((u) => `${decodeURIComponent(u.pathname)} ${[...u.searchParams.keys()].join(",")}`)).toEqual([
      `/v1.0/teams/${TEAM}/channels $select`,
      `/v1.0/teams/${TEAM}/channels $select,$skiptoken`,
      `/v1.0/teams/${TEAM}/channels/${CH1}/messages $top,$expand`,
      `/v1.0/teams/${TEAM}/channels/${CH1}/messages $top,$expand,$skiptoken`,
      `/v1.0/teams/${TEAM}/channels/${CH1}/messages/${first.items[0]!.id}/replies $top`,
    ]);
    expect(urls[2]!.searchParams.get("$top")).toBe("50");
    expect(urls[2]!.searchParams.get("$expand")).toBe("replies");
    expect(urls[4]!.searchParams.get("$top")).toBe("50");
    expect(new Set(mock.fetch.calls.map((x) => x.method))).toEqual(new Set(["POST", "GET"]));
    const { fetch, sent } = scripted(TOKEN, okPage());
    await plain(fetch).c.messages(CH1, null);
    expect(sent[1]!.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, Accept: "application/json" });
    expect(sent[0]!.method).toBe("POST");
  });

  it("checks a request before sending anything", async () => {
    const { fetch, sent } = scripted(TOKEN, okPage());
    const { c } = plain(fetch);
    await expect(c.messages("general", null)).rejects.toThrow(new MicrosoftApiError("the channel id isn't in the expected shape", 0));
    await expect(c.messages(CH1, "a b")).rejects.toThrow(new MicrosoftApiError("the saved skip token isn't in the expected shape", 0));
    await expect(c.replies(CH1, "12a", null)).rejects.toThrow(new MicrosoftApiError("the message id isn't in the expected shape", 0));
    await expect(c.replies("x", "12", null)).rejects.toThrow("the channel id isn't in the expected shape");
    expect(sent).toHaveLength(0);
    await c.messages("19:abc@thread.skype", "ok");
    expect(new URL(sent[1]!.url).pathname).toBe(`/v1.0/teams/${TEAM}/channels/${encodeURIComponent("19:abc@thread.skype")}/messages`);
    expect(new URL(sent[1]!.url).searchParams.get("$skiptoken")).toBe("ok");
  });

  it("stops before reading when the token can do more than read, naming what it can do", async () => {
    const write = scripted(jwt({ roles: ["ChannelMessage.Read.All", "ChannelMessage.Send", "Group.ReadWrite.All", "a", "b", "c"] }), okPage());
    await expect(plain(write.fetch).c.channels()).rejects.toThrow(new MicrosoftConfigError("the app has ChannelMessage.Send, Group.ReadWrite.All, a, b, c; KaratOS only reads, so install it in the team with ChannelMessage.Read.Group and ChannelSettings.Read.Group and give it nothing else"));
    expect(write.sent).toHaveLength(1);
    for (const roles of [["ChannelMessage.Read.All", "ChannelSettings.Read.All", "Channel.ReadBasic.All"], []]) {
      const ok = scripted(jwt({ roles }), okPage());
      await expect(plain(ok.fetch).c.channels()).resolves.toEqual([]);
    }
    const opaque = scripted("t".repeat(20), okPage());
    await expect(plain(opaque.fetch).c.channels()).resolves.toEqual([]);
    const mock = teamsDocMock(account({ roles: ["Group.Read.All"] }));
    await expect(clientFor(mock).channels()).rejects.toThrow("the app has Group.Read.All");
  });

  it("explains a sign-in Microsoft turns down", async () => {
    const cases: [Partial<TeamsMockData>, Partial<TeamsClientOptions>, unknown][] = [
      [{}, { clientSecret: "x".repeat(20) }, new MicrosoftConfigError("Microsoft turned down MICROSOFT_TEAMS_CLIENT_SECRET: it may have expired or been deleted. Add a new client secret to the app and save it")],
      [{}, { clientId: guid("d") }, new MicrosoftConfigError("Microsoft has no app with MICROSOFT_TEAMS_CLIENT_ID in this tenant")],
      [{ tenantId: guid("e") }, {}, new MicrosoftConfigError("Microsoft has no tenant with MICROSOFT_TENANT_ID")],
    ];
    for (const [data, extra, error] of cases) await expect(clientFor(teamsDocMock(account(data)), extra).channels()).rejects.toThrow(error as Error);
    const expired = (async () => new Response(JSON.stringify({ error: "invalid_client", error_codes: [7000222] }), { status: 401 })) as unknown as typeof globalThis.fetch;
    await expect(plain(expired).c.channels()).rejects.toThrow("Microsoft turned down MICROSOFT_TEAMS_CLIENT_SECRET");
    const down = (async () => new Response("<html>", { status: 503 })) as unknown as typeof globalThis.fetch;
    const e = (await plain(down).c.channels().catch((x: Error) => x)) as MicrosoftApiError;
    expect([e.constructor, e.message, e.status]).toEqual([MicrosoftApiError, "Microsoft answered HTTP 503 to the sign-in", 503]);
    const odd = (async () => new Response(JSON.stringify({ error_codes: "7000215" }), { status: 400 })) as unknown as typeof globalThis.fetch;
    await expect(plain(odd).c.channels()).rejects.toThrow("Microsoft answered HTTP 400 to the sign-in");
    for (const body of [{}, { access_token: 5 }, { access_token: "a b" }, { access_token: "" }, "x"]) {
      const f = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof globalThis.fetch;
      const err = (await plain(f).c.channels().catch((x: Error) => x)) as MicrosoftApiError;
      expect([err.message, err.status], JSON.stringify(body)).toEqual(["Microsoft's sign-in had no access token in the expected shape", 200]);
    }
  });

  it("keeps a token until five minutes before it ends, and signs in again once Graph turns it down", async () => {
    let clock = NOW.getTime();
    const mock = teamsDocMock(account());
    const c = clientFor(mock, { now: () => new Date(clock) });
    await c.channels();
    clock += 3599_000 - 5 * 60_000 - 1;
    await c.channels();
    expect(mock.signIns).toBe(1);
    clock += 1;
    await c.channels();
    expect(mock.signIns).toBe(2);
    mock.revokeTokens();
    await c.channels();
    expect(mock.signIns).toBe(3);
    let signIns = 0;
    const lifeless = (async (url: string) => {
      if (String(url) === LOGIN_URL) {
        signIns++;
        return new Response(JSON.stringify({ access_token: "t".repeat(20), expires_in: "3600" }));
      }
      return okPage()();
    }) as unknown as typeof globalThis.fetch;
    const o = plain(lifeless).c;
    await o.channels();
    await o.channels();
    // A token without a lifetime that reads is used once.
    expect(signIns).toBe(2);
    const twice = scripted(TOKEN, json(401, {}));
    const e = (await plain(twice.fetch).c.channels().catch((x: Error) => x)) as MicrosoftApiError;
    expect([e.message, e.status]).toEqual(["Microsoft Graph turned down the app's token twice", 401]);
    expect(twice.sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
    // Signing in again doesn't use up a retry.
    const then = scripted(TOKEN, json(401, {}), json(503, {}), json(503, {}), json(503, {}), okPage());
    const t = plain(then.fetch);
    await expect(t.c.messages(CH1, null)).resolves.toEqual({ items: [], next: null });
    expect(t.slept).toEqual([1000, 2000, 4000]);
  });

  it("waits out throttling as long as Retry-After says, up to a minute, or longer each time, then gives up", async () => {
    const { fetch, sent } = scripted(TOKEN, json(429, {}, { "retry-after": "7" }), json(503, {}, { "retry-after": "600" }), json(504, {}), okPage());
    const { c, slept } = plain(fetch);
    await c.messages(CH1, null);
    expect(slept).toEqual([7000, 60_000, 4000]);
    expect(sent).toHaveLength(5);
    const odd = plain(scripted(TOKEN, json(429, {}, { "retry-after": "soon" }), json(429, {}, { "retry-after": "0" }), okPage()).fetch);
    await odd.c.messages(CH1, null);
    expect(odd.slept).toEqual([1000, 2000]);
    const always = scripted(TOKEN, json(429, { error: { code: "TooManyRequests" } }));
    const a = plain(always.fetch);
    const e = (await a.c.messages(CH1, null).catch((x: Error) => x)) as MicrosoftApiError;
    expect([e.message, e.status, e.code]).toEqual(["Microsoft Graph answered HTTP 429 for the team", 429, "TooManyRequests"]);
    expect(a.slept).toEqual([1000, 2000, 4000]);
    const none = scripted(TOKEN, json(503, {}));
    await plain(none.fetch, { retries: 0 }).c.messages(CH1, null).catch(() => undefined);
    expect(none.sent).toHaveLength(2);
    for (const status of [500, 502, 400]) {
      const s = scripted(TOKEN, json(status, {}));
      await plain(s.fetch).c.messages(CH1, null).catch(() => undefined);
      expect(s.sent, String(status)).toHaveLength(2);
    }
    const mock = teamsDocMock(account({ rateLimited: 2, retryAfter: "3" }));
    const waited: number[] = [];
    await clientFor(mock, { sleep: async (ms) => void waited.push(ms) }).channels();
    expect(waited).toEqual([3000, 3000]);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const s = scripted(TOKEN, json(503, {}, { "retry-after": "1" }), okPage());
    globalThis.fetch = s.fetch;
    try {
      const started = Date.now();
      await teamsClient({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, teamId: TEAM }).channels();
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    } finally {
      globalThis.fetch = real;
    }
    expect(s.sent).toHaveLength(3);
  });

  it("says what is wrong with the app's access or the team, never repeating Graph's words", async () => {
    const access = new MicrosoftConfigError("the app isn't allowed to read the team: install it in MICROSOFT_TEAMS_TEAM_ID with ChannelMessage.Read.Group and ChannelSettings.Read.Group");
    await expect(clientFor(teamsDocMock(account({ installed: false }))).channels()).rejects.toThrow(access);
    await expect(clientFor(teamsDocMock(account()), { teamId: guid("d") }).messages(CH1, null)).rejects.toThrow(access);
    await expect(clientFor(teamsDocMock(account())).messages("19:gone@thread.tacv2", null)).rejects.toThrow(new MicrosoftConfigError("Microsoft Graph has no team at MICROSOFT_TEAMS_TEAM_ID, or the channel is gone"));
    for (const [body, code] of [[{ error: { code: "bad code!" } }, undefined], [{ error: { code: 5 } }, undefined], [{ error: "x" }, undefined], [null, undefined], [{ error: { code: "x".repeat(81) } }, undefined], [{ error: { code: "x".repeat(80) } }, "x".repeat(80)]] as const) {
      const e = (await plain(scripted(TOKEN, json(400, body === null ? null : { ...body, message: "secret detail" })).fetch).c.messages(CH1, null).catch((x: Error) => x)) as MicrosoftApiError;
      expect([e.message, e.status, e.code]).toEqual(["Microsoft Graph answered HTTP 400 for the team", 400, code]);
    }
  });

  it("turns down a page without its list or with a paging link that doesn't read", async () => {
    const bad: [() => Response, string][] = [
      [() => new Response("not json"), "Microsoft Graph answered the team without the value list"],
      [json(200, { value: {} }), "Microsoft Graph answered the team without the value list"],
      [json(200, []), "Microsoft Graph answered the team without the value list"],
      [() => new Response(JSON.stringify({ value: [] }), { status: 206 }), "Microsoft Graph answered HTTP 206 for the team"],
      [json(200, { value: [], "@odata.nextLink": "https://evil.example.test/v1.0/teams/x/channels/y/messages?$skiptoken=a" }), "Microsoft Graph sent a paging link that isn't the team's"],
      [json(200, { value: [], "@odata.nextLink": `${BASE}/channels?$skiptoken=a` }), "Microsoft Graph sent a paging link that isn't the team's"],
      [json(200, { value: [], "@odata.nextLink": null }), "Microsoft Graph sent a paging link that isn't the team's"],
    ];
    for (const [answer, message] of bad) {
      const e = (await plain(scripted(TOKEN, answer).fetch).c.messages(CH1, null).catch((x: Error) => x)) as MicrosoftApiError;
      expect(e.message, message).toBe(message);
    }
    const page = await plain(scripted(TOKEN, okPage(NEXT, [{ id: "1" }, null, "x", [1], { id: "2" }])).fetch).c.messages(CH1, null);
    expect(page).toEqual({ items: [{ id: "1" }, { id: "2" }], next: "s1" });
    const reply = await plain(scripted(TOKEN, okPage({ "@odata.nextLink": `${BASE}/channels/${CH1}/messages/9/replies?$skiptoken=r1` })).fetch).c.replies(CH1, "9", null);
    expect(reply.next).toBe("r1");
    await expect(plain(scripted(TOKEN, okPage({ "@odata.nextLink": `${BASE}/channels/${CH1}/messages/8/replies?$skiptoken=r1` })).fetch).c.replies(CH1, "9", null)).rejects.toThrow("isn't the team's");
    const endless = plain(scripted(TOKEN, okPage({ "@odata.nextLink": `${BASE}/channels?$skiptoken=again` }, [{ id: CH1 }])).fetch);
    await expect(endless.c.channels()).rejects.toThrow(new MicrosoftApiError("Microsoft Graph listed more pages of channels than a team can have", 200));
  });
});

describe("Teams events", () => {
  const message = (o: TeamsMockRecord = {}) => {
    teamsMessage.reset();
    return teamsMessage.one(o);
  };
  const ref = (kind: string) => expect.stringMatching(new RegExp(`^teams:${kind}:[0-9a-f]{24}$`)) as unknown as string;

  it("names its event types", () => {
    expect(TEAMS_EVENTS).toEqual({ message: "communication.message_logged", deleted: "communication.message_deleted" });
  });

  it("turns a message into communication.message_logged, keeping no text or names", () => {
    const m = message({ importance: "urgent", attachments: [{ id: "a", name: "Test receipt.pdf" }], mentions: [{ id: 0, mentionText: "Test Staff" }, { id: 1 }], reactions: [{ reactionType: "like" }], lastEditedDateTime: "2026-10-02T10:00:00Z" });
    const [e] = norm.message(CH1, m, RECEIVED);
    expect(e!.type).toBe("communication.message_logged");
    expect(e!.occurredAt).toBe("2026-10-02T09:00:00.000Z");
    expect(e!.receivedAt).toBe(RECEIVED);
    expect(e!.payload).toStrictEqual({
      system: "Teams",
      channel: "teams",
      conversationId: ref("channel"),
      messageId: ref("message"),
      threadId: ref("thread"),
      isReply: false,
      sentAt: "2026-10-02T09:00:00.000Z",
      editedAt: "2026-10-02T10:00:00.000Z",
      author: norm.person("00000000-0000-4000-8000-000000000001"),
      authorKind: "person",
      importance: "urgent",
      attachmentCount: 1,
      mentionCount: 2,
      reactionCount: 1,
      textWithheld: true,
    });
    expect(String(e!.payload.author)).toMatch(/^teams_user:[0-9a-f]{32}$/);
    expect(String(e!.payload.messageId).split(":")[2]).toBe(String(e!.payload.threadId).split(":")[2]);
    expect(e!.idempotencyKey).toMatch(/^teams:message:[0-9a-f]{24}:[0-9a-f]{12}$/);
    expect(e!.idempotencyKey.split(":")[2]).toBe(String(e!.payload.messageId).split(":")[2]);
    expect(e!.id).toBe(e!.idempotencyKey.replace(/:/g, "_"));
    const all = JSON.stringify(e);
    for (const hidden of ["ring resize", "Test Staff", "receipt", "order 1001", "teams.microsoft.test", "00000000-0000-4000-8000", "test0000"]) expect(all, hidden).not.toContain(hidden);
    const key = (o: TeamsMockRecord, channel = CH1, when = RECEIVED) => norm.message(channel, message(o), when)[0]!.idempotencyKey;
    expect(key({}, CH1, "2027-01-01T00:00:00.000Z")).toBe(key({}));
    expect(key({ body: { contentType: "text", content: "other" }, etag: "x" })).toBe(key({}));
    expect(key({ reactions: [{}] })).not.toBe(key({}));
    expect(key({}, CH2)).not.toBe(key({}));
    expect(norm.message(CH2, message(), RECEIVED)[0]!.payload.conversationId).not.toBe(e!.payload.conversationId);
    expect(key({ id: "1759395600001" })).not.toBe(key({}));
    expect(teamsNormalizer("j".repeat(40)).person("x")).not.toBe(norm.person("x"));
    expect(norm.person("x")).not.toBe(norm.person("y"));
  });

  it("keeps a reply in its thread, and keeps only what reads", () => {
    const root = message();
    const reply = teamsReply(root, 5);
    const [r] = norm.message(CH1, reply, RECEIVED);
    const [e] = norm.message(CH1, root, RECEIVED);
    expect(r!.payload).toMatchObject({ isReply: true, sentAt: "2026-10-02T09:05:00.000Z", threadId: e!.payload.threadId });
    expect(r!.payload.messageId).not.toBe(e!.payload.messageId);
    const odd = norm.message(CH1, message({ replyToId: "x", importance: "loud", lastEditedDateTime: "soon", attachments: "x", mentions: null, reactions: {}, from: { user: { id: "not a guid" }, application: { id: guid("f") } } }), RECEIVED)[0]!;
    expect(odd.payload).toMatchObject({ isReply: false, author: expect.stringMatching(/^teams_app:[0-9a-f]{24}$/), authorKind: "app", attachmentCount: 0, mentionCount: 0, reactionCount: 0 });
    for (const field of ["importance", "editedAt"]) expect(odd.payload, field).not.toHaveProperty(field);
    for (const from of [null, {}, { user: null, application: { id: 5 } }, "x"]) {
      const p = norm.message(CH1, message({ from }), RECEIVED)[0]!.payload;
      expect([p.authorKind, "author" in p], JSON.stringify(from)).toEqual(["unknown", false]);
    }
    expect(norm.message(CH1, message({ from: { user: { id: guid("D") } } }), RECEIVED)[0]!.payload.author).toBe(norm.person(guid("d")));
  });

  it("skips system notices, and dead-letters a message that doesn't read, listing why", () => {
    for (const messageType of ["systemEventMessage", "chatEvent", "unknownFutureValue", undefined]) expect(norm.message(CH1, message({ messageType }), RECEIVED), String(messageType)).toEqual([]);
    for (const raw of [null, "x", 5]) expect(norm.message(CH1, raw, RECEIVED)).toEqual([]);
    expect(norm.message("general", message(), RECEIVED)).toEqual([]);
    const cases: [TeamsMockRecord, string[]][] = [
      [{ id: "abc" }, ["message has no id that reads"]],
      [{ id: 5 }, ["message has no id that reads"]],
      [{ createdDateTime: "soon" }, ["message has no time that reads"]],
      [{ id: "", createdDateTime: null }, ["message has no id that reads", "message has no time that reads"]],
    ];
    for (const [o, problems] of cases) {
      const [e] = norm.message(CH1, message(o), RECEIVED);
      expect(e!.payload, JSON.stringify(o)).toStrictEqual({ system: "Teams", problems });
      expect(e!.type).toBe("communication.message_logged");
      expect(e!.occurredAt).toBeUndefined();
      expect(e!.idempotencyKey).toMatch(/^teams:unreadable_message:[0-9a-f]{12}$/);
      expect(e!.id).toBe(e!.idempotencyKey.replace(/:/g, "_"));
      expect(JSON.stringify(e)).not.toContain("ring resize");
    }
    expect(norm.message(CH1, message({ id: "abc" }), RECEIVED)[0]!.idempotencyKey).not.toBe(norm.message(CH1, message({ id: "abd" }), RECEIVED)[0]!.idempotencyKey);
  });

  it("turns a deleted message into communication.message_deleted", () => {
    const [e] = norm.message(CH1, message({ deletedDateTime: "2026-10-05T09:00:00Z", body: { content: "" } }), RECEIVED);
    expect(e!.type).toBe("communication.message_deleted");
    expect(e!.occurredAt).toBe("2026-10-05T09:00:00.000Z");
    expect(e!.payload).toStrictEqual({ system: "Teams", channel: "teams", conversationId: ref("channel"), messageId: ref("message"), threadId: ref("thread"), deletedAt: "2026-10-05T09:00:00.000Z" });
    const [kept] = norm.message(CH1, message(), RECEIVED);
    expect(e!.payload.messageId).toBe(kept!.payload.messageId);
    expect(e!.idempotencyKey).not.toBe(kept!.idempotencyKey);
    expect(norm.message(CH1, message({ deletedDateTime: "soon" }), RECEIVED)[0]!.type).toBe("communication.message_logged");
  });

  it("turns down a short correspondent key", () => {
    for (const key of ["short", " ".repeat(40), undefined as never]) expect(() => teamsNormalizer(key)).toThrow("set CORRESPONDENT_HASH_KEY to at least 32 characters; npm run secrets:setup generates one");
    expect(() => teamsNormalizer(` ${"k".repeat(32)} `)).not.toThrow();
  });

  it("builds fixtures that look synthetic", () => {
    assertSynthetic(account());
  });
});

describe("Teams checkpoint", () => {
  const label = teamsTeamLabel(TEAM);
  const good: TeamsCursor = { pass: "historical", team: label, channels: [CH1, CH2], index: 1, skip: "s1", top: "2026-10-02T09:00:00.000Z", marks: { [CH1]: "2026-10-03T09:00:00.000Z" }, done: false, since: SINCE };
  it("reads a checkpoint it wrote, and turns down anything else", () => {
    expect(parseTeamsCursor(null)).toBeNull();
    expect(parseTeamsCursor(JSON.stringify(good))).toEqual(good);
    const between = { ...good, pass: "incremental", channels: null, index: 0, skip: null, top: null, done: true, extra: 1 };
    const { extra: _, ...read } = between;
    expect(parseTeamsCursor(JSON.stringify(between))).toEqual(read);
    expect(parseTeamsCursor(JSON.stringify({ ...good, index: 0, marks: {} }))).toMatchObject({ index: 0, marks: {} });
    expect(parseTeamsCursor(JSON.stringify({ ...good, channels: [], index: 0 }))!.channels).toEqual([]);
    const many = Array.from({ length: TEAMS_MAX_CHANNELS }, (_, i) => `19:c${i}@thread.tacv2`);
    expect(parseTeamsCursor(JSON.stringify({ ...good, channels: many, marks: Object.fromEntries(many.map((c) => [c, SINCE])) }))!.channels).toHaveLength(TEAMS_MAX_CHANNELS);
    const bad = [
      "",
      "x",
      "null",
      "[]",
      ...[
        { ...good, pass: "full" },
        { ...good, team: "team:abc" },
        { ...good, team: `x${label}` },
        { ...good, team: 5 },
        { ...good, channels: "x" },
        { ...good, channels: ["general"] },
        { ...good, channels: [...many, "19:x@thread.tacv2"] },
        { ...good, channels: undefined },
        { ...good, index: -1 },
        { ...good, index: 2 },
        { ...good, channels: null, index: 1 },
        { ...good, index: 1.5 },
        { ...good, index: "1" },
        { ...good, skip: "a b" },
        { ...good, skip: 5 },
        { ...good, skip: undefined },
        { ...good, top: "soon" },
        { ...good, top: "2026-10-02T09:00:00Z" },
        { ...good, top: undefined },
        { ...good, marks: null },
        { ...good, marks: undefined },
        { ...good, marks: [] },
        { ...good, marks: { general: SINCE } },
        { ...good, marks: { [CH1]: "soon" } },
        { ...good, marks: Object.fromEntries([...many, "19:x@thread.tacv2"].map((c) => [c, SINCE])) },
        { ...good, done: "false" },
        { ...good, since: "2021-11-11" },
      ].map((o) => JSON.stringify(o)),
    ];
    for (const raw of bad) expect(() => parseTeamsCursor(raw), raw.slice(0, 120)).toThrow("Teams checkpoint is not in the expected shape");
    expect(label).toMatch(/^team:[0-9a-f]{16}$/);
    expect(teamsTeamLabel(guid("d"))).not.toBe(label);
    // A checkpoint read back is a copy.
    const read2 = parseTeamsCursor(JSON.stringify(good))!;
    expect(read2.channels).not.toBe(good.channels);
  });
});

describe("Teams connector", () => {
  it("passes the shared connector checks", async () => {
    // Three messages and two replies across two channels.
    const result = await checkConnectorSync({ makeConnector: () => connector(teamsDocMock(account())), expected: { ingested: 5 } });
    expect(result.full.ingested).toBe(5);
  });

  it("reads every channel from the start, one page a batch, then stops for good", async () => {
    const mock = teamsDocMock(account({ pageCap: 1 }));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(5);
    const urls = graphCalls(mock).map((u) => new URL(u));
    expect(urls.map((u) => `${decodeURIComponent(u.pathname).split("/").slice(-2).join("/")} ${[...u.searchParams.keys()].join(",")}`)).toEqual([
      `${TEAM}/channels $select`,
      `${TEAM}/channels $select,$skiptoken`,
      `${CH1}/messages $top,$expand`,
      `${CH1}/messages $top,$expand,$skiptoken`,
      `${CH2}/messages $top,$expand`,
    ]);
    const c = parseTeamsCursor(report.cursor)!;
    expect([c.pass, c.channels, c.index, c.skip, c.top, c.done, c.since, c.team]).toEqual(["historical", null, 0, null, null, true, SINCE, teamsTeamLabel(TEAM)]);
    expect(c.marks).toEqual({ [CH1]: "2026-10-03T09:10:00.000Z", [CH2]: "2026-10-04T09:00:00.000Z" });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(graphCalls(mock)).toHaveLength(5);
    expect(() => connector(mock, { historyYears: 0 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { historyYears: 2.5 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { teamId: "sales", client: {} as TeamsClient })).toThrow(new MicrosoftConfigError("MICROSOFT_TEAMS_TEAM_ID is missing or not a team's group id"));
    expect(() => teamsConnector({ ...options(mock), correspondentKey: "short" })).toThrow("CORRESPONDENT_HASH_KEY");
  });

  it("makes each page one batch whose checkpoint says where to go on from, and resumes there", async () => {
    const mock = teamsDocMock(account({ pageCap: 1 }));
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => eventsOf([b]).length)).toEqual([3, 1, 1]);
    const cursors = batches.map((b) => parseTeamsCursor(b.cursor!)!);
    expect(cursors.map((c) => [c.index, c.skip === null, c.top, c.done])).toEqual([
      [0, false, "2026-10-03T09:10:00.000Z", false],
      [1, true, null, false],
      [0, true, null, true],
    ]);
    expect(cursors[1]!.marks).toEqual({ [CH1]: "2026-10-03T09:10:00.000Z" });
    expect(cursors[0]!.channels).toEqual([CH1, CH2]);
    // Resuming from the first batch asks for the page it was on.
    const resumed = teamsDocMock(account({ pageCap: 1 }));
    const rest = await drain(connector(resumed).historicalImport({ cursor: batches[0]!.cursor! } as never));
    expect(eventsOf(rest)).toHaveLength(2);
    expect(graphCalls(resumed).map((u) => new URL(u).searchParams.has("$skiptoken"))).toEqual([true, false]);
    expect(parseTeamsCursor(rest.at(-1)!.cursor!)!.marks).toEqual({ [CH1]: "2026-10-03T09:10:00.000Z", [CH2]: "2026-10-04T09:00:00.000Z" });
    // A checkpoint for another team starts over.
    const other = { ...cursors[0]!, team: teamsTeamLabel(guid("d")) };
    const fresh = teamsDocMock(account());
    expect(eventsOf(await drain(connector(fresh).historicalImport({ cursor: JSON.stringify(other) } as never)))).toHaveLength(5);
    expect(new URL(graphCalls(fresh)[0]!).pathname).toBe(`/v1.0/teams/${TEAM}/channels`);
    // An incremental checkpoint gives the import a fresh start.
    const inc = { ...cursors[2]!, pass: "incremental" };
    expect(eventsOf(await drain(connector(teamsDocMock(account())).historicalImport({ cursor: JSON.stringify(inc) } as never)))).toHaveLength(5);
  });

  it("reads only the threads that changed since the last sync, edits, replies and deletions included", async () => {
    const data = account();
    const mock = teamsDocMock(data);
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const quiet = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG, cursor: first.cursor } as never);
    expect(quiet.ingested).toBe(0);
    const [a, b] = data.threads![CH1]! as [TeamsMockRecord, TeamsMockRecord];
    mock.putReply(CH1, String(a.id), teamsReply(a, 60 * 24 * 30, { lastModifiedDateTime: "2026-11-11T11:00:00.000Z", createdDateTime: "2026-11-11T11:00:00.000Z" }));
    mock.remove(CH2, String(data.threads![CH2]![0]!.id), "2026-11-11T11:30:00.000Z");
    const later = await drain(connector(mock).incrementalSync({ cursor: quiet.cursor } as never));
    const events = eventsOf(later);
    // The thread with the new reply comes again whole, and the one that was newest comes again within the overlap; older ones aren't read.
    expect(events.map((e) => e.type)).toEqual([...Array(5).fill("communication.message_logged"), "communication.message_deleted"]);
    expect(events.filter((e) => e.payload.isReply).length).toBe(3);
    const marks = parseTeamsCursor(later.at(-1)!.cursor!)!.marks;
    expect(marks).toEqual({ [CH1]: "2026-11-11T11:00:00.000Z", [CH2]: "2026-11-11T11:30:00.000Z" });
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG, cursor: quiet.cursor } as never);
    expect(report.ingested).toBe(2);
    expect(b.id).not.toBe(a.id);
  });

  it("reads back five minutes past the newest change, and a new channel from the start", async () => {
    const data = account();
    const mock = teamsDocMock(data);
    const imported = (await drain(connector(mock).historicalImport({ cursor: null } as never))).at(-1)!.cursor!;
    const c = parseTeamsCursor(imported)!;
    // The newest thread in General changed at 09:10 on October 3: within the overlap it is read again, just past it not. The other channel's thread is read again each time.
    const close = { ...c, marks: { ...c.marks, [CH1]: new Date(Date.parse("2026-10-03T09:10:00.000Z") + TEAMS_OVERLAP_MS).toISOString() } };
    expect(eventsOf(await drain(connector(mock).incrementalSync({ cursor: JSON.stringify(close) } as never))).length).toBe(4);
    const far = { ...c, marks: { ...c.marks, [CH1]: new Date(Date.parse("2026-10-03T09:10:00.000Z") + TEAMS_OVERLAP_MS + 1).toISOString() } };
    expect(eventsOf(await drain(connector(mock).incrementalSync({ cursor: JSON.stringify(far) } as never))).length).toBe(1);
    const forgotten = { ...c, marks: {} };
    expect(eventsOf(await drain(connector(mock).incrementalSync({ cursor: JSON.stringify(forgotten) } as never))).length).toBe(5);
    // An incremental sync with no checkpoint reads everything.
    expect(eventsOf(await drain(connector(mock).incrementalSync({ cursor: null } as never))).length).toBe(5);
    // The import reads back only as far as its years.
    const old = account();
    teamsMessage.reset();
    const ancient = teamsMessage.one({ id: "1500000000000", createdDateTime: "2020-01-01T00:00:00.000Z", lastModifiedDateTime: "2020-01-01T00:00:00.000Z" });
    old.threads![CH2] = [...old.threads![CH2]!, ancient];
    expect(eventsOf(await drain(connector(teamsDocMock(old)).historicalImport({ cursor: null } as never))).length).toBe(5);
    expect(eventsOf(await drain(connector(teamsDocMock(old), { historyYears: 7 }).historicalImport({ cursor: null } as never))).length).toBe(6);
  });

  it("reads a thread's other replies when the listing carries only some", async () => {
    const data = account({ expandCap: 1, pageCap: 1 });
    const mock = teamsDocMock(data);
    const out = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(eventsOf(out)).toHaveLength(5);
    const replyCalls = graphCalls(mock).filter((u) => u.includes("/replies"));
    expect(replyCalls).toHaveLength(2);
    expect(new URL(replyCalls[1]!).searchParams.has("$skiptoken")).toBe(true);
    // Reply pages stop at a hundred.
    let pages = 0;
    const endless: TeamsClient = {
      channels: async () => [{ id: CH1 }],
      messages: async () => ({ items: [{ ...teamsMessage.one(), "replies@odata.nextLink": "x" }], next: null }),
      replies: async (_c, _m, skip) => {
        pages++;
        expect(skip === null).toBe(pages === 1);
        return { items: [], next: "more" };
      },
    };
    await drain(teamsConnector({ ...options(mock), client: endless }).historicalImport({ cursor: null } as never));
    expect(pages).toBe(100);
  });

  it("lists the channels once a round, keeping each once and only those that read", async () => {
    const calls: string[] = [];
    const listed: TeamsClient = {
      channels: async () => [{ id: CH1 }, { id: CH1 }, { id: "general" }, { id: 5 }, { id: CH2 }],
      messages: async (channel) => {
        calls.push(channel);
        return { items: [], next: null };
      },
      replies: async () => ({ items: [], next: null }),
    };
    const out = await drain(teamsConnector({ ...options(teamsDocMock(account())), client: listed }).historicalImport({ cursor: null } as never));
    expect(calls).toEqual([CH1, CH2]);
    expect(parseTeamsCursor(out.at(-1)!.cursor!)!.marks).toEqual({});
    const many: TeamsClient = { ...listed, channels: async () => Array.from({ length: TEAMS_MAX_CHANNELS + 5 }, (_, i) => ({ id: `19:c${i}@thread.tacv2` })) };
    calls.length = 0;
    await drain(teamsConnector({ ...options(teamsDocMock(account())), client: many }).historicalImport({ cursor: null } as never));
    expect(calls).toHaveLength(TEAMS_MAX_CHANNELS);
    // A team with no channels finishes at once.
    const none: TeamsClient = { ...listed, channels: async () => [] };
    const empty = await drain(teamsConnector({ ...options(teamsDocMock(account())), client: none }).historicalImport({ cursor: null } as never));
    expect(empty).toHaveLength(1);
    expect(eventsOf(empty)).toEqual([]);
    expect(parseTeamsCursor(empty[0]!.cursor!)).toMatchObject({ channels: null, done: true });
    expect(await drain(teamsConnector({ ...options(teamsDocMock(account())), client: none }).historicalImport({ cursor: empty[0]!.cursor! } as never))).toEqual([]);
  });

  it("dates a thread by its newest change, and keeps reading past one with no time", async () => {
    const seen: string[] = [];
    teamsMessage.reset();
    // The first has no time at all, so it is dead-lettered and doesn't stop the listing.
    const timeless = teamsMessage.one({ lastModifiedDateTime: null, createdDateTime: null });
    const created = teamsMessage.one({ lastModifiedDateTime: "soon" });
    const client: TeamsClient = {
      channels: async () => [{ id: CH1 }],
      messages: async () => ({ items: [timeless, created, "x" as never], next: null }),
      replies: async () => ({ items: [], next: null }),
    };
    const out = await drain(teamsConnector({ ...options(teamsDocMock(account())), client }).historicalImport({ cursor: null } as never));
    for (const e of eventsOf(out)) seen.push(e.type);
    expect(seen).toEqual(["communication.message_logged", "communication.message_logged"]);
    expect(eventsOf(out)[0]!.payload).toHaveProperty("problems");
    // The second has no change time that reads, so it is dated when it was posted.
    expect(parseTeamsCursor(out.at(-1)!.cursor!)!.marks).toEqual({ [CH1]: "2026-10-03T09:00:00.000Z" });
  });

  it("stops the sync on an error from Graph", async () => {
    let tries = 0;
    const broken: TeamsClient = {
      channels: async () => [{ id: CH1 }],
      messages: async () => (tries++, Promise.reject(new MicrosoftApiError("x", 500))),
      replies: async () => ({ items: [], next: null }),
    };
    await expect(drain(teamsConnector({ ...options(teamsDocMock(account())), client: broken }).historicalImport({ cursor: null } as never))).rejects.toThrow("x");
    expect(tries).toBe(1);
  });

  it("reads up to now when no clock is given", async () => {
    const before = Date.now();
    const mock = teamsDocMock(account());
    const { now: _, ...clockless } = options(mock);
    const out = await drain(teamsConnector(clockless).historicalImport({ cursor: null } as never));
    const since = Date.parse(parseTeamsCursor(out.at(-1)!.cursor!)!.since);
    const back = new Date(before);
    back.setUTCFullYear(back.getUTCFullYear() - 5);
    expect(since).toBeGreaterThanOrEqual(back.getTime() - 1);
    expect(eventsOf(out)[0]!.receivedAt >= new Date(before).toISOString()).toBe(true);
  });

  it("only ever signs in and reads the team's channels, messages and replies", async () => {
    const mock = teamsDocMock(account({ expandCap: 1 }));
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG, cursor: first.cursor } as never);
    const replyRoot = String(account().threads![CH1]![1]!.id);
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${decodeURIComponent(new URL(c.url).pathname)}`))).toEqual(
      new Set([`POST /${TENANT}/oauth2/v2.0/token`, `GET /v1.0/teams/${TEAM}/channels`, `GET /v1.0/teams/${TEAM}/channels/${CH1}/messages`, `GET /v1.0/teams/${TEAM}/channels/${CH2}/messages`, `GET /v1.0/teams/${TEAM}/channels/${CH1}/messages/${replyRoot}/replies`]),
    );
  });

  it("declares posting an alert and a daily summary, each needing approval, and a read-only gate turns both down", async () => {
    const c = connector(teamsDocMock(account()));
    expect(c.source).toBe("microsoft_teams");
    expect(c.writes).toBe(TEAMS_WRITES);
    expect(TEAMS_WRITES.map((w) => [w.integration, w.name, w.kind, w.approval, w.dailyCap])).toEqual([
      ["microsoft_teams", "post_alert", "append", "each", 20],
      ["microsoft_teams", "post_daily_summary", "append", "each", 1],
    ]);
    const refused = await assertWritesRefused(c);
    expect(refused.map((r) => r.action)).toEqual(["post_alert", "post_daily_summary"]);
  });
});

describe("Teams doc mock", () => {
  it("checks the token, the team, the query and its skip tokens", async () => {
    const data = account();
    const mock = teamsDocMock(data);
    await clientFor(mock).channels();
    const auth = { authorization: `Bearer ${"x".repeat(20)}` };
    expect((await mock.fetch(`${BASE}/channels`, { headers: auth })).status).toBe(401);
    const token = (await (await mock.fetch(LOGIN_URL, { method: "POST", body: new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }) })).json()) as { access_token: string };
    const get = (path: string, q: Record<string, string> = {}) => mock.fetch(`${BASE}${path}${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ""}`, { headers: { authorization: `Bearer ${token.access_token}` } });
    const whole = (await (await get("/channels")).json()) as { value: Record<string, unknown>[] };
    expect(whole.value[0]).toHaveProperty("displayName");
    expect((await get("/channels", { $filter: "membershipType eq 'private'" })).status).toBe(200);
    expect((await get("/channels", { $search: "x" })).status).toBe(400);
    const ch = `/channels/${encodeURIComponent(CH1)}`;
    expect((await get(`${ch}/messages`, { $top: "51" })).status).toBe(400);
    expect((await get(`${ch}/messages`, { $top: "0" })).status).toBe(400);
    expect((await get(`${ch}/messages`, { $top: "x" })).status).toBe(400);
    expect((await get(`${ch}/messages`, { $expand: "hostedContents" })).status).toBe(400);
    expect((await get(`${ch}/messages`, { $filter: "x" })).status).toBe(400);
    expect((await get(`${ch}/messages`, { $skiptoken: "nope" })).status).toBe(400);
    expect((await get(`${ch}/messages`, { $skiptoken: Buffer.from(JSON.stringify({ kind: "replies", offset: 0 })).toString("base64url") })).status).toBe(400);
    // Twenty a page when no $top is given, and replies only when expanded.
    const plainList = (await (await get(`${ch}/messages`)).json()) as { value: Record<string, unknown>[] };
    expect(plainList.value.map((m) => "replies" in m)).toEqual([false, false]);
    const expanded = (await (await get(`${ch}/messages`, { $expand: "replies" })).json()) as { value: Record<string, unknown>[] };
    expect(expanded.value.map((m) => m["replies@odata.count"])).toEqual([2, 0]);
    expect((expanded.value[0]!.replies as { id: string }[]).map((r) => r.id)).toEqual(["1020010", "1020005"]);
    expect((await get(`/channels/${encodeURIComponent("19:gone@thread.tacv2")}/messages`)).status).toBe(404);
    expect((await get(`${ch}/messages/1/replies`)).status).toBe(404);
    expect((await get(`${ch}/messages/${expanded.value[0]!.id}/replies`, { $top: "99" })).status).toBe(400);
    expect((await mock.fetch(`${GRAPH}/teams/${guid("d")}/channels`, { headers: { authorization: `Bearer ${token.access_token}` } })).status).toBe(403);
    await expect(mock.fetch(`${BASE}/channels/${encodeURIComponent(CH1)}/messages`, { method: "POST", headers: { authorization: `Bearer ${token.access_token}` } })).rejects.toThrow("not in the vendor's docs");
    expect((await mock.fetch(LOGIN_URL, { method: "POST", body: new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, scope: "openid", grant_type: "client_credentials" }) })).status).toBe(400);
    expect((await mock.fetch(LOGIN_URL, { method: "POST", body: new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, grant_type: "password" }) })).status).toBe(400);
    // A Request goes where its URL says.
    expect((await mock.fetch(new Request(`${BASE}/channels`, { headers: { authorization: `Bearer ${token.access_token}` } }))).status).toBe(200);
    const empty = teamsDocMock({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, teamId: TEAM });
    expect(await clientFor(empty).channels()).toEqual([]);
    await expect(clientFor(empty).messages(CH1, null)).rejects.toThrow("the channel is gone");
    // Posting and editing.
    teamsMessage.reset();
    const fresh = teamsMessage.one({ id: "1800000000000" });
    mock.putThread(CH2, fresh);
    mock.putThread(CH2, { ...fresh, importance: "high" });
    mock.putThread("19:new@thread.tacv2", fresh);
    const two = await clientFor(mock).messages(CH2, null);
    // Newest change first: the thread from October 4, then the one edited from October 2.
    expect(two.items.map((m) => [m.id, m.importance])).toEqual([[data.threads![CH2]![0]!.id, "normal"], ["1800000000000", "high"]]);
    mock.putReply(CH2, "1800000000000", teamsReply(fresh, 1));
    mock.putReply(CH2, "1800000000000", teamsReply(fresh, 1, { importance: "high" }));
    const replies = await clientFor(mock).replies(CH2, "1800000000000", null);
    expect(replies.items.map((r) => r.importance)).toEqual(["high"]);
    mock.putReply(CH2, "1800000000000", teamsReply(fresh, 2));
    mock.remove(CH2, String(replies.items[0]!.id), "2026-11-11T00:00:00.000Z");
    const gone = await clientFor(mock).replies(CH2, "1800000000000", null);
    expect(gone.items.map((r) => r.deletedDateTime)).toEqual([null, "2026-11-11T00:00:00.000Z"]);
    expect(gone.items[1]).toMatchObject({ body: { content: "" } });
    // A channel with no threads lists none, and has no replies to list.
    const bare = teamsDocMock({ ...account(), threads: {} });
    expect(await clientFor(bare).messages(CH1, null)).toEqual({ items: [], next: null });
    await expect(clientFor(bare).replies(CH1, "1", null)).rejects.toThrow("the channel is gone");
    // Throttling waits a second when the mock is given no Retry-After.
    const waits: number[] = [];
    await clientFor(teamsDocMock({ ...account(), rateLimited: 1 }), { sleep: async (ms) => void waits.push(ms) }).channels();
    expect(waits).toEqual([1000]);
  });
});
