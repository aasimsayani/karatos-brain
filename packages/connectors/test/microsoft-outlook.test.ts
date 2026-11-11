import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, outlookDocMock, outlookEvent, outlookMessage, testPipeline, type OutlookMock, type OutlookMockData, type OutlookMockRecord } from "@karatos/connector-testkit";
import {
  MicrosoftApiError,
  MicrosoftConfigError,
  OUTLOOK_AHEAD_MS,
  OUTLOOK_EVENTS,
  OUTLOOK_LANES,
  OUTLOOK_MESSAGE_SELECT,
  OUTLOOK_PAGE_SIZE,
  OUTLOOK_READ_ROLES,
  OUTLOOK_RENEW_MS,
  OUTLOOK_WRITES,
  OutlookResyncError,
  gmailNormalizer,
  outlookClient,
  outlookConnector,
  outlookMailbox,
  outlookMailboxLabel,
  outlookNormalizer,
  outlookStateOf,
  outlookTime,
  parseOutlookCursor,
  type OutlookClient,
  type OutlookClientOptions,
  type OutlookCursor,
  type OutlookEvent,
  type OutlookOptions,
  type OutlookPage,
  type OutlookState,
} from "../src/index.js";

const guid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
const TENANT = guid("a");
const CLIENT = guid("b");
const SECRET = "s".repeat(40);
const MAILBOX = "sales@store.test";
const KEY = "k".repeat(40);
const NOW = new Date("2026-11-11T12:00:00.000Z");
const RECEIVED = NOW.toISOString();
const SINCE = "2021-11-11T12:00:00.000Z";
const UNTIL = new Date(NOW.getTime() + OUTLOOK_AHEAD_MS).toISOString();
const DAY_MS = 86_400_000;
const GRAPH = "https://graph.microsoft.com/v1.0";
const LOGIN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const BOX = `${GRAPH}/users/${encodeURIComponent(MAILBOX)}`;
const noSleep = async () => {};
const { correspondent } = gmailNormalizer({ correspondentKey: KEY });
const norm = outlookNormalizer(KEY);

function account(extra: Partial<OutlookMockData> = {}): OutlookMockData {
  outlookMessage.reset();
  outlookEvent.reset();
  const inbox = outlookMessage.many(3);
  const sentitems = [outlookMessage.one({ from: { emailAddress: { address: MAILBOX } }, toRecipients: [{ emailAddress: { address: "buyer@vendor.test" } }] })];
  return { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, mailbox: MAILBOX, roles: null, messages: { inbox, sentitems }, events: outlookEvent.many(2), ...extra };
}
const options = (mock: OutlookMock, extra: Partial<OutlookOptions> = {}): OutlookOptions => ({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, mailbox: MAILBOX, correspondentKey: KEY, fetch: mock.fetch, sleep: noSleep, now: () => NOW, ...extra });
const connector = (mock: OutlookMock, extra: Partial<OutlookOptions> = {}) => outlookConnector(options(mock, extra));
const clientFor = (mock: OutlookMock, extra: Partial<OutlookClientOptions> = {}) => outlookClient({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, mailbox: MAILBOX, fetch: mock.fetch, sleep: noSleep, now: () => NOW, ...extra });
async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as OutlookEvent[];
const graphCalls = (mock: OutlookMock) => mock.fetch.calls.filter((c) => c.url.startsWith(GRAPH)).map((c) => c.url);
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
const okPage = (link: Record<string, string>, value: unknown[] = []) => json(200, { value, ...link });
const DELTA_LINK = { "@odata.deltaLink": `${BOX}/mailFolders('inbox')/messages/delta?$deltatoken=d1` };
const NEXT_LINK = { "@odata.nextLink": `${BOX}/mailFolders('inbox')/messages/delta?$skiptoken=s1` };
const TOKEN = jwt({ roles: ["Mail.ReadBasic"] });
const plain = (fetch: typeof globalThis.fetch, extra: Partial<OutlookClientOptions> = {}) => {
  const slept: number[] = [];
  return { c: outlookClient({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, mailbox: MAILBOX, fetch, sleep: async (ms) => void slept.push(ms), now: () => NOW, ...extra }), slept };
};

describe("Outlook settings", () => {
  it("reads a mailbox as an address or an object id, lowercased", () => {
    expect(outlookMailbox(" Sales@Store.Test ")).toBe(MAILBOX);
    expect(outlookMailbox(guid("C"))).toBe(guid("c"));
    expect(outlookMailbox("o'brien+rings@store.test")).toBe("o'brien+rings@store.test");
    for (const bad of ["", "sales", "sales@store", "@store.test", `${"a".repeat(65)}@store.test`, "a b@store.test", "a@store.test/x", "a@store..test", "a@-.test?", 5, null]) expect(outlookMailbox(bad), String(bad)).toBeUndefined();
  });

  it("checks every setting before sending anything", () => {
    const { fetch, sent } = scripted(TOKEN, okPage(DELTA_LINK));
    const base = { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, mailbox: MAILBOX, fetch };
    expect(() => outlookClient({ ...base, tenantId: "contoso.onmicrosoft.com" })).toThrow(new MicrosoftConfigError("MICROSOFT_TENANT_ID is missing or not a directory (tenant) id"));
    expect(() => outlookClient({ ...base, clientId: "app" })).toThrow(new MicrosoftConfigError("MICROSOFT_OUTLOOK_CLIENT_ID is missing or not an application (client) id"));
    for (const clientSecret of ["short", "s".repeat(257), `${"s".repeat(10)} ${"s".repeat(10)}`, undefined as never]) expect(() => outlookClient({ ...base, clientSecret }), String(clientSecret)).toThrow(new MicrosoftConfigError("MICROSOFT_OUTLOOK_CLIENT_SECRET is missing or not in the expected shape"));
    expect(() => outlookClient({ ...base, clientSecret: ` ${"s".repeat(16)} ` })).not.toThrow();
    expect(() => outlookClient({ ...base, clientSecret: "s".repeat(256) })).not.toThrow();
    expect(() => outlookClient({ ...base, mailbox: "sales" })).toThrow(new MicrosoftConfigError("MICROSOFT_OUTLOOK_MAILBOX is missing or not a mailbox address or object id"));
    expect(sent).toHaveLength(0);
  });

  it("names its read roles, lanes and fields", () => {
    expect(OUTLOOK_READ_ROLES).toEqual(["Mail.ReadBasic", "Mail.ReadBasic.All", "Calendars.ReadBasic", "Calendars.ReadBasic.All", "Calendars.Read"]);
    expect(OUTLOOK_MESSAGE_SELECT.split(",")).not.toContain("subject");
    expect(OUTLOOK_MESSAGE_SELECT).toBe("id,conversationId,receivedDateTime,sentDateTime,from,toRecipients,ccRecipients,hasAttachments,importance,isDraft");
    expect(OUTLOOK_LANES).toEqual(["inbox", "sentitems", "calendar"]);
    expect(OUTLOOK_PAGE_SIZE).toBe(100);
    expect([OUTLOOK_AHEAD_MS, OUTLOOK_RENEW_MS]).toEqual([365 * DAY_MS, 182 * DAY_MS]);
  });
});

describe("Outlook paging links", () => {
  it("reads the token out of a user's delta link, and turns down anything else", () => {
    expect(outlookStateOf(`${BOX}/mailFolders('inbox')/messages/delta?$skiptoken=abc`, "/messages/delta")).toEqual({ kind: "skip", token: "abc" });
    expect(outlookStateOf(`${GRAPH}/users('${guid("c")}')/mailfolders/AQMk/messages/delta?$deltatoken=a.b~c=%2B/-_`, "/messages/delta")).toEqual({ kind: "delta", token: "a.b~c=+/-_" });
    expect(outlookStateOf(`${BOX}/calendarView/delta?$deltatoken=x`, "/calendarview/delta")).toEqual({ kind: "delta", token: "x" });
    const bad = [
      5,
      "not a url",
      `${"x".repeat(10_001)}`,
      `https://graph.microsoft.com.evil.test/v1.0/users/x/messages/delta?$skiptoken=a`,
      `http://graph.microsoft.com/v1.0/users/x/messages/delta?$skiptoken=a`,
      `https://u:p@graph.microsoft.com/v1.0/users/x/messages/delta?$skiptoken=a`,
      `${BOX}/messages/delta?$skiptoken=a#x`,
      `${GRAPH}/me/messages/delta?$skiptoken=a`,
      `${GRAPH}/users/x/calendarView/delta?$skiptoken=a`,
      `${BOX}/messages/delta`,
      `${BOX}/messages/delta?$skiptoken=a&$deltatoken=b`,
      `${BOX}/messages/delta?$skiptoken=a&$select=id`,
      `${BOX}/messages/delta?$top=a`,
      `${BOX}/messages/delta?$skiptoken=`,
      `${BOX}/messages/delta?$skiptoken=a%20b`,
      `${BOX}/messages/delta?$skiptoken=${"a".repeat(8193)}`,
      `${GRAPH}/users/%E0%A4%A/messages/delta?$skiptoken=a`,
    ];
    for (const link of bad) expect(outlookStateOf(link, "/messages/delta"), String(link).slice(0, 80)).toBeUndefined();
    expect(outlookStateOf(`${BOX}/messages/delta?$skiptoken=${"a".repeat(8192)}`, "/messages/delta")?.token).toHaveLength(8192);
    expect(outlookStateOf(`${BOX}/MESSAGES/DELTA?$skiptoken=a`, "/messages/delta")).toEqual({ kind: "skip", token: "a" });
  });
});

describe("Outlook client", () => {
  it("signs in once, then sends only GETs with immutable ids and a page size, building every query itself", async () => {
    const mock = outlookDocMock(account());
    const c = clientFor(mock);
    const first = await c.messages("inbox", null, SINCE);
    expect(first.items).toHaveLength(3);
    expect(first.next.kind).toBe("delta");
    await c.events(null, SINCE, UNTIL);
    await c.messages("inbox", first.next, SINCE);
    expect(mock.signIns).toBe(1);
    const urls = graphCalls(mock).map((u) => new URL(u));
    expect(urls[0]!.pathname).toBe(`/v1.0/users/${encodeURIComponent(MAILBOX)}/mailFolders/inbox/messages/delta`);
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({ $select: OUTLOOK_MESSAGE_SELECT, $filter: `receivedDateTime ge ${SINCE}` });
    expect(Object.fromEntries(urls[1]!.searchParams)).toEqual({ startDateTime: SINCE, endDateTime: UNTIL });
    expect(urls[1]!.pathname).toBe(`/v1.0/users/${encodeURIComponent(MAILBOX)}/calendarView/delta`);
    expect([...urls[2]!.searchParams.keys()]).toEqual(["$deltatoken"]);
    expect(mock.fetch.calls.map((x) => x.method)).toEqual(["POST", "GET", "GET", "GET"]);
    expect(mock.prefers).toEqual(Array(3).fill(`IdType="ImmutableId", odata.maxpagesize=${OUTLOOK_PAGE_SIZE}`));
    const { fetch, sent } = scripted(TOKEN, okPage(NEXT_LINK));
    await plain(fetch).c.messages("inbox", { kind: "skip", token: "abc" }, SINCE);
    expect(sent[0]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } });
    expect(sent[1]).toEqual({ url: `${BOX}/mailFolders/inbox/messages/delta?%24skiptoken=abc`, method: "GET", headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json", Prefer: `IdType="ImmutableId", odata.maxpagesize=100` } });
  });

  it("checks a query before sending anything", async () => {
    const { fetch, sent } = scripted(TOKEN, okPage(DELTA_LINK));
    const { c } = plain(fetch);
    await expect(c.messages("drafts" as never, null, SINCE)).rejects.toThrow(new MicrosoftConfigError("Outlook reads only the Inbox and Sent Items"));
    await expect(c.messages("toString" as never, null, SINCE)).rejects.toThrow(MicrosoftConfigError);
    for (const since of ["2021-11-11", "2021-11-11T12:00:00Z", `x${SINCE}`, `${SINCE}x`]) await expect(c.messages("inbox", null, since), since).rejects.toThrow(new MicrosoftConfigError("messages are read from a UTC time"));
    for (const [start, end] of [[SINCE, SINCE], [UNTIL, SINCE], ["2021-11-11", UNTIL], [SINCE, "soon"], [`x${SINCE}`, UNTIL], [SINCE, `${UNTIL}x`]]) await expect(c.events(null, start!, end!), `${start} ${end}`).rejects.toThrow(new MicrosoftConfigError("the calendar is read between two UTC times"));
    await expect(c.messages("inbox", { kind: "skip", token: "a b" }, SINCE)).rejects.toThrow(new MicrosoftApiError("the saved state token isn't in the expected shape", 0));
    expect(sent).toHaveLength(0);
  });

  it("stops before reading when the token can do more than read, naming what it can do", async () => {
    for (const roles of [["Mail.Read"], ["Mail.ReadBasic.All", "Mail.Send"], ["Calendars.ReadWrite"], ["A", "B", "C", "D", "E", "F"]]) {
      const { fetch, sent } = scripted(jwt({ roles }), okPage(DELTA_LINK));
      const e = await plain(fetch).c.messages("inbox", null, SINCE).catch((x: Error) => x);
      expect(e, roles.join()).toEqual(new MicrosoftConfigError(`the app has ${roles.filter((r) => !(OUTLOOK_READ_ROLES as readonly string[]).includes(r)).slice(0, 5).join(", ")}; KaratOS only reads, so give it Application Mail.ReadBasic and Application Calendars.Read for the mailbox and nothing else`));
      expect(sent).toHaveLength(1);
    }
    for (const token of [jwt({ roles: [...OUTLOOK_READ_ROLES] }), jwt({}), "opaque-token"]) {
      const { fetch, sent } = scripted(token, okPage(DELTA_LINK));
      await plain(fetch).c.messages("inbox", null, SINCE);
      expect(sent, token).toHaveLength(2);
    }
  });

  it("explains a sign-in Microsoft turns down", async () => {
    const cases: [Partial<OutlookMockData>, string][] = [
      [{ clientSecret: "x".repeat(40) }, "Microsoft turned down MICROSOFT_OUTLOOK_CLIENT_SECRET: it may have expired or been deleted. Add a new client secret to the app and save it"],
      [{ clientId: guid("d") }, "Microsoft has no app with MICROSOFT_OUTLOOK_CLIENT_ID in this tenant"],
      [{ tenantId: guid("e") }, "Microsoft has no tenant with MICROSOFT_TENANT_ID"],
    ];
    for (const [data, message] of cases) await expect(clientFor(outlookDocMock(account(data))).messages("inbox", null, SINCE)).rejects.toThrow(new MicrosoftConfigError(message));
    const login = (status: number, body: unknown) => (async (url: string) => (String(url) === LOGIN_URL ? new Response(JSON.stringify(body), { status }) : new Response("{}"))) as unknown as typeof globalThis.fetch;
    expect(await plain(login(400, { error_codes: [7000222] })).c.messages("inbox", null, SINCE).catch((e: Error) => e.message)).toContain("turned down MICROSOFT_OUTLOOK_CLIENT_SECRET");
    const raw = (async (url: string) => (String(url) === LOGIN_URL ? new Response("<html>", { status: 502 }) : new Response("{}"))) as unknown as typeof globalThis.fetch;
    expect(await plain(raw).c.messages("inbox", null, SINCE).catch((e: Error) => e.message)).toBe("Microsoft answered HTTP 502 to the sign-in");
    for (const body of [{ error_codes: [1] }, { error_codes: "7000215" }, null, "x"]) {
      const e = (await plain(login(500, body)).c.messages("inbox", null, SINCE).catch((x: Error) => x)) as MicrosoftApiError;
      expect([e.message, e.status, e.constructor]).toEqual(["Microsoft answered HTTP 500 to the sign-in", 500, MicrosoftApiError]);
    }
    for (const body of [{}, { access_token: 5 }, { access_token: "" }, { access_token: "a b" }, null]) {
      const e = (await plain(login(200, body)).c.messages("inbox", null, SINCE).catch((x: Error) => x)) as MicrosoftApiError;
      expect([e.message, e.status], JSON.stringify(body)).toEqual(["Microsoft's sign-in had no access token in the expected shape", 200]);
    }
  });

  it("keeps a token until five minutes before it ends, and signs in again once Graph turns it down", async () => {
    let clock = NOW.getTime();
    const mock = outlookDocMock(account());
    const c = clientFor(mock, { now: () => new Date(clock) });
    await c.messages("inbox", null, SINCE);
    clock += 3599_000 - 5 * 60_000 - 1;
    await c.messages("inbox", null, SINCE);
    expect(mock.signIns).toBe(1);
    clock += 1;
    await c.messages("inbox", null, SINCE);
    expect(mock.signIns).toBe(2);
    mock.revokeTokens();
    await c.messages("inbox", null, SINCE);
    expect(mock.signIns).toBe(3);
    const odd = scripted("t".repeat(20), okPage(DELTA_LINK));
    const login = (async (url: string, init?: RequestInit) => (String(url) === LOGIN_URL ? new Response(JSON.stringify({ access_token: "t".repeat(20), expires_in: "3600" })) : odd.fetch(url, init))) as unknown as typeof globalThis.fetch;
    let signIns = 0;
    const counting = (async (url: string, init?: RequestInit) => {
      if (String(url) === LOGIN_URL) signIns++;
      return login(url, init);
    }) as unknown as typeof globalThis.fetch;
    const o = plain(counting).c;
    await o.messages("inbox", null, SINCE);
    await o.messages("inbox", null, SINCE);
    // A token without a lifetime that reads is used once.
    expect(signIns).toBe(2);
    const twice = scripted(TOKEN, json(401, {}));
    const e = (await plain(twice.fetch).c.messages("inbox", null, SINCE).catch((x: Error) => x)) as MicrosoftApiError;
    expect([e.message, e.status]).toEqual(["Microsoft Graph turned down the app's token twice", 401]);
    expect(twice.sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
  });

  it("waits out throttling as long as Retry-After says, up to a minute, or longer each time, then gives up", async () => {
    const { fetch, sent } = scripted(TOKEN, json(429, {}, { "retry-after": "7" }), json(503, {}, { "retry-after": "600" }), json(504, {}), okPage(DELTA_LINK));
    const { c, slept } = plain(fetch);
    await c.messages("inbox", null, SINCE);
    expect(slept).toEqual([7000, 60_000, 4000]);
    expect(sent).toHaveLength(5);
    const odd = plain(scripted(TOKEN, json(429, {}, { "retry-after": "soon" }), json(429, {}, { "retry-after": "0" }), okPage(DELTA_LINK)).fetch);
    await odd.c.messages("inbox", null, SINCE);
    expect(odd.slept).toEqual([1000, 2000]);
    const always = scripted(TOKEN, json(429, { error: { code: "ApplicationThrottled" } }));
    const a = plain(always.fetch);
    const e = (await a.c.messages("inbox", null, SINCE).catch((x: Error) => x)) as MicrosoftApiError;
    expect([e.message, e.status, e.code]).toEqual(["Microsoft Graph answered HTTP 429 for the mailbox's mail", 429, "ApplicationThrottled"]);
    expect(a.slept).toEqual([1000, 2000, 4000]);
    const none = scripted(TOKEN, json(503, {}));
    await plain(none.fetch, { retries: 0 }).c.events(null, SINCE, UNTIL).catch(() => undefined);
    expect(none.sent).toHaveLength(2);
    for (const status of [500, 502, 400]) {
      const s = scripted(TOKEN, json(status, {}));
      await plain(s.fetch).c.messages("inbox", null, SINCE).catch(() => undefined);
      expect(s.sent, String(status)).toHaveLength(2);
    }
    const mock = outlookDocMock(account({ rateLimited: 2, retryAfter: "3" }));
    const waited: number[] = [];
    await clientFor(mock, { sleep: async (ms) => void waited.push(ms) }).messages("inbox", null, SINCE);
    expect(waited).toEqual([3000, 3000]);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const s = scripted(TOKEN, json(503, {}, { "retry-after": "1" }), okPage(DELTA_LINK));
    globalThis.fetch = s.fetch;
    try {
      const started = Date.now();
      await outlookClient({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, mailbox: MAILBOX }).messages("inbox", null, SINCE);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    } finally {
      globalThis.fetch = real;
    }
    expect(s.sent).toHaveLength(3);
  });

  it("says what is wrong with the app's access or the mailbox, never repeating Graph's words", async () => {
    const mail = await clientFor(outlookDocMock(account({ grants: ["calendar"] }))).messages("inbox", null, SINCE).catch((e: Error) => e);
    expect(mail).toEqual(new MicrosoftConfigError("the app isn't allowed to read the mailbox's mail: assign it Application Mail.ReadBasic for MICROSOFT_OUTLOOK_MAILBOX"));
    const cal = await clientFor(outlookDocMock(account({ grants: ["mail"] }))).events(null, SINCE, UNTIL).catch((e: Error) => e);
    expect(cal).toEqual(new MicrosoftConfigError("the app isn't allowed to read the mailbox's calendar: assign it Application Calendars.Read for MICROSOFT_OUTLOOK_MAILBOX"));
    await expect(clientFor(outlookDocMock(account()), { mailbox: "other@store.test" }).messages("inbox", null, SINCE)).rejects.toThrow("isn't allowed to read the mailbox's mail");
    await expect(plain(scripted(TOKEN, json(404, { error: { code: "ErrorInvalidUser", message: "secret detail" } })).fetch).c.messages("inbox", null, SINCE)).rejects.toThrow(new MicrosoftConfigError("Microsoft Graph has no Exchange Online mailbox at MICROSOFT_OUTLOOK_MAILBOX"));
    const gone = (await plain(scripted(TOKEN, json(410, { error: { code: "SyncStateNotFound" } })).fetch).c.messages("inbox", { kind: "delta", token: "d" }, SINCE).catch((x: Error) => x)) as OutlookResyncError;
    expect([gone.constructor, gone.message, gone.status, gone.code, gone.name, gone instanceof MicrosoftApiError]).toEqual([OutlookResyncError, "Microsoft Graph asked for the mailbox to be read again from the start", 410, "SyncStateNotFound", "OutlookResyncError", true]);
    for (const [body, code] of [[{ error: { code: "bad code!" } }, undefined], [{ error: { code: 5 } }, undefined], [{ error: "x" }, undefined], [{ error: { code: "x".repeat(81) } }, undefined], [{ error: { code: "x".repeat(80) } }, "x".repeat(80)]] as const) {
      const e = (await plain(scripted(TOKEN, json(400, { ...body, message: "secret detail" })).fetch).c.events(null, SINCE, UNTIL).catch((x: Error) => x)) as MicrosoftApiError;
      expect([e.message, e.status, e.code]).toEqual(["Microsoft Graph answered HTTP 400 for the mailbox's calendar", 400, code]);
    }
  });

  it("turns down a page without its list or with paging links that don't read", async () => {
    const bad: [() => Response, string][] = [
      [() => new Response("not json"), "Microsoft Graph answered the mailbox's mail without the value list"],
      [json(200, { value: {} , ...DELTA_LINK }), "Microsoft Graph answered the mailbox's mail without the value list"],
      [json(200, []), "Microsoft Graph answered the mailbox's mail without the value list"],
      [json(200, { value: [] }), "Microsoft Graph's page of the mailbox's mail has neither or both of its next and delta links"],
      [json(200, { value: [], ...DELTA_LINK, ...NEXT_LINK }), "Microsoft Graph's page of the mailbox's mail has neither or both of its next and delta links"],
      [json(200, { value: [], "@odata.nextLink": "https://evil.example.test/v1.0/users/x/messages/delta?$skiptoken=a" }), "Microsoft Graph sent a paging link that isn't the mailbox's mail"],
      [json(200, { value: [], "@odata.nextLink": `${BOX}/messages/delta?$deltatoken=a` }), "Microsoft Graph sent a paging link that isn't the mailbox's mail"],
      [json(200, { value: [], "@odata.deltaLink": `${BOX}/messages/delta?$skiptoken=a` }), "Microsoft Graph sent a paging link that isn't the mailbox's mail"],
      [json(200, { value: [], "@odata.deltaLink": `${BOX}/calendarView/delta?$deltatoken=a` }), "Microsoft Graph sent a paging link that isn't the mailbox's mail"],
    ];
    for (const [answer, message] of bad) {
      const e = (await plain(scripted(TOKEN, answer).fetch).c.messages("inbox", null, SINCE).catch((x: Error) => x)) as MicrosoftApiError;
      expect([e.message, e.status], message).toEqual([message, 200]);
    }
    const page = await plain(scripted(TOKEN, okPage(NEXT_LINK, [{ id: "a" }, null, "x", [1], { id: "b" }])).fetch).c.messages("inbox", null, SINCE);
    expect(page).toEqual({ items: [{ id: "a" }, { id: "b" }], next: { kind: "skip", token: "s1" } });
    const cal = await plain(scripted(TOKEN, okPage({ "@odata.deltaLink": `${BOX}/calendarView/delta?$deltatoken=c1` })).fetch).c.events(null, SINCE, UNTIL);
    expect(cal.next).toEqual({ kind: "delta", token: "c1" });
  });
});

describe("Outlook reading helpers", () => {
  it("reads Graph's times as UTC, with or without their Z", () => {
    expect(outlookTime("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000Z");
    expect(outlookTime("2026-01-02T03:04:05.1234567Z")).toBe("2026-01-02T03:04:05.123Z");
    expect(outlookTime("2026-01-02T03:04:05.5")).toBe("2026-01-02T03:04:05.500Z");
    expect(outlookTime("2026-01-02T23:59:59.99")).toBe("2026-01-02T23:59:59.990Z");
    for (const bad of ["2026-02-30T00:00:00Z", "2026-01-02T24:00:00Z", "2026-01-02T12:60:00Z", "2026-01-02T12:00:60Z", "2026-01-02", "2026-01-02 03:04:05Z", "2026-01-02T03:04:05.12345678Z", "2026-01-02T03:04:05+02:00", "x2026-01-02T03:04:05Z", "2026-01-02T03:04:05Zx", "", null, 5]) expect(outlookTime(bad), String(bad)).toBeUndefined();
  });
});

describe("Outlook events", () => {
  const message = (o: OutlookMockRecord = {}) => {
    outlookMessage.reset();
    return outlookMessage.one(o);
  };
  const event = (o: OutlookMockRecord = {}) => {
    outlookEvent.reset();
    return outlookEvent.one(o);
  };
  const ref = (kind: string, id: string) => expect.stringMatching(new RegExp(`^outlook:${kind}:[0-9a-f]{24}$`)) as unknown as string;

  it("names its event types", () => {
    expect(OUTLOOK_EVENTS).toEqual({ message: "communication.message_logged", removed: "communication.message_removed", appointment: "calendar.appointment_updated", cancelled: "calendar.appointment_cancelled" });
  });

  it("turns a received message into communication.message_logged, with people as correspondent references", () => {
    const [e] = norm.message("inbox", message({ ccRecipients: [{ emailAddress: { address: " Partner@Vendor.Test " } }] }), RECEIVED);
    expect(e!.type).toBe("communication.message_logged");
    expect(e!.occurredAt).toBe("2026-10-02T09:00:00.000Z");
    expect(e!.receivedAt).toBe(RECEIVED);
    expect(e!.payload).toStrictEqual({
      system: "Outlook",
      channel: "email",
      messageId: ref("message", ""),
      threadId: ref("thread", ""),
      folder: "inbox",
      direction: "received",
      sentAt: "2026-10-02T09:00:00.000Z",
      deliveredAt: "2026-10-02T09:00:00.000Z",
      from: correspondent("customer1@example.test"),
      to: [correspondent("sales@store.test")],
      cc: [correspondent("partner@vendor.test")],
      recipientCount: 2,
      hasAttachments: false,
      importance: "normal",
    });
    expect(e!.payload.messageId).not.toBe(e!.payload.threadId);
    expect(e!.idempotencyKey).toMatch(/^outlook:message:[0-9a-f]{24}:[0-9a-f]{12}$/);
    expect(e!.idempotencyKey.split(":")[2]).toBe(String(e!.payload.messageId).split(":")[2]);
    expect(e!.id).toBe(e!.idempotencyKey.replace(/:/g, "_"));
    const all = JSON.stringify(e);
    for (const hidden of ["ring resize", "preview", "Test body", "Test Customer", "customer1@example.test", "Test customer", "AAMkAD", "outlook.office365"]) expect(all, hidden).not.toContain(hidden);
    expect(norm.message("inbox", message(), "2027-01-01T00:00:00.000Z")[0]!.idempotencyKey).toBe(norm.message("inbox", message(), RECEIVED)[0]!.idempotencyKey);
    expect(norm.message("inbox", message({ subject: "other", isRead: true }), RECEIVED)[0]!.idempotencyKey).toBe(norm.message("inbox", message(), RECEIVED)[0]!.idempotencyKey);
    expect(norm.message("inbox", message({ importance: "high" }), RECEIVED)[0]!.idempotencyKey).not.toBe(norm.message("inbox", message(), RECEIVED)[0]!.idempotencyKey);
    expect(norm.message("inbox", message({ id: "AAMkADother=" }), RECEIVED)[0]!.payload.messageId).not.toBe(e!.payload.messageId);
  });

  it("dates a sent message when it was sent, and keeps only what reads", () => {
    const [sent] = norm.message("sentitems", message({ sentDateTime: "2026-10-01T08:00:00Z" }), RECEIVED);
    expect(sent!.payload).toMatchObject({ folder: "sentitems", direction: "sent" });
    expect(sent!.occurredAt).toBe("2026-10-01T08:00:00.000Z");
    expect(norm.message("sentitems", message({ sentDateTime: null }), RECEIVED)[0]!.occurredAt).toBe("2026-10-02T09:00:00.000Z");
    expect(norm.message("inbox", message({ receivedDateTime: null }), RECEIVED)[0]!.occurredAt).toBeUndefined();
    const odd = norm.message("inbox", message({ conversationId: "a b", from: { emailAddress: { address: "not an address" } }, toRecipients: [{ emailAddress: { address: "a@b" } }, { emailAddress: { address: 5 } }, null, "x", {}], ccRecipients: "x", hasAttachments: "yes", importance: "urgent", sentDateTime: "soon" }), RECEIVED)[0]!.payload;
    expect(odd).toStrictEqual({ system: "Outlook", channel: "email", messageId: ref("message", ""), folder: "inbox", direction: "received", deliveredAt: "2026-10-02T09:00:00.000Z", to: [], cc: [], recipientCount: 0 });
    for (const importance of ["low", "normal", "high"]) expect(norm.message("inbox", message({ importance }), RECEIVED)[0]!.payload.importance).toBe(importance);
    expect(norm.message("inbox", message({ hasAttachments: true }), RECEIVED)[0]!.payload.hasAttachments).toBe(true);
  });

  it("keeps fifty people per list with the full count, each once", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ emailAddress: { address: `c${i}@example.test` } }));
    const p = norm.message("inbox", message({ toRecipients: [...many, many[0]], ccRecipients: [{ emailAddress: { address: "C1@example.test" } }] }), RECEIVED)[0]!.payload;
    expect((p.to as unknown[]).length).toBe(50);
    expect((p.to as unknown[])[49]).toEqual(correspondent("c49@example.test"));
    expect(p.recipientCount).toBe(61);
  });

  it("skips drafts, and dead-letters a message that doesn't read, listing why", () => {
    expect(norm.message("inbox", message({ isDraft: true }), RECEIVED)).toEqual([]);
    expect(norm.message("inbox", message({ isDraft: "true" }), RECEIVED)).toHaveLength(1);
    const [e] = norm.message("inbox", message({ id: "", receivedDateTime: "2026-10-02" }), RECEIVED);
    expect(e!.occurredAt).toBeUndefined();
    expect(e!.payload).toStrictEqual({ system: "Outlook", problems: ["message has no id that reads", "message has no time that reads"] });
    expect(e!.idempotencyKey).toMatch(/^outlook:unreadable_message:[0-9a-f]{12}$/);
    expect(e!.id).toBe(e!.idempotencyKey.replace(/:/g, "_"));
    expect(norm.message("inbox", message({ id: "" , receivedDateTime: "x" }), RECEIVED)[0]!.idempotencyKey).not.toBe(e!.idempotencyKey);
    for (const id of [5, "a b", "a:b", "x".repeat(513)]) expect(norm.message("inbox", message({ id }), RECEIVED)[0]!.payload.problems, String(id)).toEqual(["message has no id that reads"]);
    expect(norm.message("inbox", message({ id: "x".repeat(512) }), RECEIVED)[0]!.payload.problems).toBeUndefined();
    for (const raw of [null, "x", []]) expect(norm.message("inbox", raw, RECEIVED)[0]!.payload.problems, JSON.stringify(raw)).toHaveLength(2);
  });

  it("turns a message that left a folder into communication.message_removed", () => {
    const [e] = norm.message("inbox", { "@odata.type": "#microsoft.graph.message", id: "AAMkADgone=", "@removed": { reason: "deleted" } }, RECEIVED);
    expect(e!.type).toBe("communication.message_removed");
    expect(e!.occurredAt).toBe(RECEIVED);
    expect(e!.payload).toStrictEqual({ system: "Outlook", channel: "email", messageId: norm.message("inbox", message({ id: "AAMkADgone=" }), RECEIVED)[0]!.payload.messageId, folder: "inbox" });
    expect(e!.idempotencyKey).toMatch(/^outlook:message:[0-9a-f]{24}:[0-9a-f]{12}$/);
    expect(norm.message("sentitems", { id: "AAMkADgone=", "@removed": {} }, RECEIVED)[0]!.idempotencyKey).not.toBe(e!.idempotencyKey);
    expect(norm.message("inbox", { id: "AAMkADgone=", "@removed": {}, isDraft: true }, RECEIVED)).toHaveLength(1);
    const [dead] = norm.message("inbox", { id: 5, "@removed": { reason: "deleted" } }, RECEIVED);
    expect([dead!.type, dead!.occurredAt, dead!.payload]).toEqual(["communication.message_removed", undefined, { system: "Outlook", problems: ["removed message has no id that reads"] }]);
  });

  it("turns a calendar event into calendar.appointment_updated in UTC, with people as correspondent references", () => {
    const e = norm.appointment(event({ attendees: [{ type: "required", status: { response: "accepted" }, emailAddress: { address: "customer1@example.test" } }, { type: "resource", status: { response: "maybe" }, emailAddress: { address: "room@store.test" } }, { type: "x", emailAddress: { address: "bad" } }] }), RECEIVED);
    expect(e.type).toBe("calendar.appointment_updated");
    expect(e.occurredAt).toBe("2026-10-02T09:00:00.000Z");
    expect(e.payload).toStrictEqual({
      system: "Outlook",
      appointmentId: ref("event", ""),
      status: "confirmed",
      type: "singleInstance",
      start: "2026-10-02T09:00:00.000Z",
      end: "2026-10-02T10:00:00.000Z",
      allDay: false,
      showAs: "busy",
      online: false,
      organizer: correspondent("sales@store.test"),
      attendees: [{ ...correspondent("customer1@example.test"), response: "accepted", kind: "required" }, { ...correspondent("room@store.test"), kind: "resource" }],
      attendeeCount: 2,
      createdAt: "2026-10-01T09:00:00.000Z",
      updatedAt: "2026-10-02T09:00:00.000Z",
    });
    expect(e.idempotencyKey).toMatch(/^outlook:event:[0-9a-f]{24}:[0-9a-f]{12}$/);
    const all = JSON.stringify(e);
    for (const hidden of ["fitting", "bring the ring", "1 Test St", "Test customer", "Test Store", "customer1@example.test", "TEST1"]) expect(all, hidden).not.toContain(hidden);
    expect(norm.appointment(event({ subject: "other", location: {} }), RECEIVED).idempotencyKey).toBe(norm.appointment(event(), RECEIVED).idempotencyKey);
    expect(norm.appointment(event({ showAs: "free" }), RECEIVED).idempotencyKey).not.toBe(norm.appointment(event(), RECEIVED).idempotencyKey);
  });

  it("keeps what reads of an event, and marks a cancelled one", () => {
    const cancelled = norm.appointment(event({ isCancelled: true }), RECEIVED);
    expect([cancelled.type, cancelled.payload.status]).toEqual(["calendar.appointment_cancelled", "cancelled"]);
    expect(norm.appointment(event({ isCancelled: "yes" }), RECEIVED).type).toBe("calendar.appointment_updated");
    const odd = norm.appointment(event({ type: "other", seriesMasterId: "AAMkADseries=", start: { dateTime: "2026-10-02T09:00:00.0000000", timeZone: "Pacific Standard Time" }, end: { dateTime: "soon", timeZone: "UTC" }, isAllDay: "no", showAs: "away", isOnlineMeeting: null, organizer: null, attendees: "x", createdDateTime: null }), RECEIVED).payload;
    expect(odd).toStrictEqual({ system: "Outlook", appointmentId: ref("event", ""), status: "confirmed", seriesId: ref("event", ""), attendees: [], attendeeCount: 0, updatedAt: "2026-10-02T09:00:00.000Z" });
    for (const type of ["singleInstance", "occurrence", "exception", "seriesMaster"]) expect(norm.appointment(event({ type }), RECEIVED).payload.type).toBe(type);
    for (const showAs of ["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"]) expect(norm.appointment(event({ showAs }), RECEIVED).payload.showAs).toBe(showAs);
    for (const response of ["none", "organizer", "tentativelyAccepted", "accepted", "declined", "notResponded"]) expect((norm.appointment(event({ attendees: [{ status: { response }, emailAddress: { address: "a@example.test" } }] }), RECEIVED).payload.attendees as Record<string, unknown>[])[0]!.response).toBe(response);
    for (const kind of ["required", "optional", "resource"]) expect((norm.appointment(event({ attendees: [{ type: kind, emailAddress: { address: "a@example.test" } }] }), RECEIVED).payload.attendees as Record<string, unknown>[])[0]!.kind).toBe(kind);
    const many = Array.from({ length: 55 }, (_, i) => ({ emailAddress: { address: `c${i}@example.test` } }));
    const p = norm.appointment(event({ attendees: many }), RECEIVED).payload;
    expect([(p.attendees as unknown[]).length, p.attendeeCount]).toEqual([50, 55]);
    expect(norm.appointment(event({ isAllDay: true, isOnlineMeeting: true }), RECEIVED).payload).toMatchObject({ allDay: true, online: true });
    expect(norm.appointment(event({ seriesMasterId: "AAMkADseries=" }), RECEIVED).payload.seriesId).not.toBe(norm.appointment(event(), RECEIVED).payload.appointmentId);
  });

  it("dead-letters an event that doesn't read, and cancels one Graph removed", () => {
    const e = norm.appointment(event({ id: null, lastModifiedDateTime: "soon" }), RECEIVED);
    expect([e.occurredAt, e.payload]).toEqual([undefined, { system: "Outlook", problems: ["event has no id that reads", "event has no time that reads"] }]);
    expect(e.idempotencyKey).toMatch(/^outlook:unreadable_event:[0-9a-f]{12}$/);
    for (const raw of [null, "x", []]) expect(norm.appointment(raw, RECEIVED).payload.problems, JSON.stringify(raw)).toHaveLength(2);
    const gone = norm.appointment({ id: "AAMkADgone=", "@removed": { reason: "deleted" } }, RECEIVED);
    expect([gone.type, gone.occurredAt]).toEqual(["calendar.appointment_cancelled", RECEIVED]);
    expect(gone.payload).toStrictEqual({ system: "Outlook", appointmentId: norm.appointment(event({ id: "AAMkADgone=" }), RECEIVED).payload.appointmentId, status: "cancelled", removed: true });
    const dead = norm.appointment({ id: "", "@removed": {} }, RECEIVED);
    expect([dead.occurredAt, dead.payload]).toEqual([undefined, { system: "Outlook", problems: ["removed event has no id that reads"] }]);
  });

  it("turns down a short correspondent key", () => {
    expect(() => outlookNormalizer("short")).toThrow("CORRESPONDENT_HASH_KEY");
  });

  it("builds fixtures that look synthetic", () => {
    assertSynthetic(account());
  });
});

describe("Outlook checkpoint", () => {
  const label = outlookMailboxLabel(MAILBOX);
  const good: OutlookCursor = { pass: "historical", mailbox: label, lane: 1, states: { inbox: { kind: "delta", token: "d1" }, sentitems: { kind: "skip", token: "s1" }, calendar: null }, done: false, since: SINCE, until: UNTIL };
  it("reads a checkpoint it wrote, and turns down anything else", () => {
    expect(parseOutlookCursor(null)).toBeNull();
    expect(parseOutlookCursor(JSON.stringify(good))).toEqual(good);
    expect(parseOutlookCursor(JSON.stringify({ ...good, pass: "incremental", lane: 2, done: true, extra: 1, states: { ...good.states, calendar: { kind: "delta", token: "c", x: 1 } } }))).toEqual({ ...good, pass: "incremental", lane: 2, done: true, states: { ...good.states, calendar: { kind: "delta", token: "c" } } });
    expect(parseOutlookCursor(JSON.stringify({ ...good, lane: 0 }))!.lane).toBe(0);
    const bad = [
      "",
      "x",
      "null",
      "[]",
      ...[
        { ...good, pass: "full" },
        { ...good, mailbox: "mailbox:abc" },
        { ...good, mailbox: `x${label}` },
        { ...good, mailbox: 5 },
        { ...good, lane: -1 },
        { ...good, lane: 3 },
        { ...good, lane: 1.5 },
        { ...good, lane: "1" },
        { ...good, states: { ...good.states, inbox: { kind: "next", token: "a" } } },
        { ...good, states: { ...good.states, inbox: { kind: "skip", token: "a b" } } },
        { ...good, states: { ...good.states, inbox: { kind: "skip", token: 5 } } },
        { ...good, states: { ...good.states, inbox: { token: "a" } } },
        { ...good, states: { ...good.states, inbox: "a" } },
        { ...good, states: { inbox: null, sentitems: null } },
        { ...good, states: null },
        { ...good, done: "false" },
        { ...good, since: "2021-11-11" },
        { ...good, until: "soon" },
        { ...good, since: UNTIL, until: UNTIL },
        { ...good, since: UNTIL, until: SINCE },
      ].map((o) => JSON.stringify(o)),
    ];
    for (const raw of bad) expect(() => parseOutlookCursor(raw), raw).toThrow("Outlook checkpoint is not in the expected shape");
    expect(label).toMatch(/^mailbox:[0-9a-f]{16}$/);
    expect(outlookMailboxLabel("other@store.test")).not.toBe(label);
  });
});

describe("Outlook connector", () => {
  it("passes the shared connector checks", async () => {
    // Three received and one sent message, and two appointments.
    const result = await checkConnectorSync({ makeConnector: () => connector(outlookDocMock(account())), expected: { ingested: 6 } });
    expect(result.full.ingested).toBe(6);
  });

  it("reads the Inbox, Sent Items and the calendar from the start, then stops for good", async () => {
    const mock = outlookDocMock(account({ pageCap: 2 }));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(6);
    const urls = graphCalls(mock).map((u) => new URL(u));
    expect(urls.map((u) => `${u.pathname.split("/").slice(-3).join("/")} ${[...u.searchParams.keys()].join(",")}`)).toEqual([
      "inbox/messages/delta $select,$filter",
      "inbox/messages/delta $skiptoken",
      "sentitems/messages/delta $select,$filter",
      `${encodeURIComponent(MAILBOX)}/calendarView/delta startDateTime,endDateTime`,
    ]);
    expect(urls[0]!.searchParams.get("$filter")).toBe(`receivedDateTime ge ${SINCE}`);
    expect(Object.fromEntries(urls[3]!.searchParams)).toEqual({ startDateTime: SINCE, endDateTime: UNTIL });
    const c = parseOutlookCursor(report.cursor)!;
    expect([c.pass, c.lane, c.done, c.since, c.until, c.mailbox]).toEqual(["historical", 0, true, SINCE, UNTIL, outlookMailboxLabel(MAILBOX)]);
    expect(Object.values(c.states).map((s) => s?.kind)).toEqual(["delta", "delta", "delta"]);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(graphCalls(mock)).toHaveLength(4);
    const deep = outlookDocMock(account());
    await drain(connector(deep, { historyYears: 7 }).historicalImport({ cursor: null } as never));
    expect(new URL(graphCalls(deep)[0]!).searchParams.get("$filter")).toBe("receivedDateTime ge 2019-11-11T12:00:00.000Z");
    expect(() => connector(deep, { historyYears: 0 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(deep, { historyYears: 2.5 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(deep, { mailbox: "sales" })).toThrow(new MicrosoftConfigError("MICROSOFT_OUTLOOK_MAILBOX is missing or not a mailbox address or object id"));
    expect(() => connector(deep, { correspondentKey: "short" })).toThrow("CORRESPONDENT_HASH_KEY");
  });

  it("makes each page one batch whose checkpoint keeps every lane's state, and resumes there", async () => {
    const asked: string[] = [];
    const states: Record<string, OutlookState[]> = { inbox: [{ kind: "skip", token: "i2" }, { kind: "delta", token: "i3" }], sentitems: [{ kind: "delta", token: "s2" }], calendar: [{ kind: "skip", token: "c2" }, { kind: "delta", token: "c3" }] };
    const served: Record<string, number> = { inbox: 0, sentitems: 0, calendar: 0 };
    const fake: OutlookClient = {
      messages: async (folder, state, since) => {
        asked.push(`${folder}:${state?.kind ?? "-"}:${state?.token ?? "-"}:${since}`);
        outlookMessage.reset();
        return { items: [outlookMessage.one()], next: states[folder]![served[folder]!++]! } satisfies OutlookPage;
      },
      events: async (state, start, end) => {
        asked.push(`calendar:${state?.kind ?? "-"}:${state?.token ?? "-"}:${start}:${end}`);
        outlookEvent.reset();
        return { items: [outlookEvent.one()], next: states.calendar![served.calendar!++]! };
      },
    };
    const make = (now = NOW) => outlookConnector({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, mailbox: MAILBOX, correspondentKey: KEY, client: fake, now: () => now });
    const all = await drain(make().historicalImport({ cursor: null } as never));
    expect(asked).toEqual([`inbox:-:-:${SINCE}`, `inbox:skip:i2:${SINCE}`, `sentitems:-:-:${SINCE}`, `calendar:-:-:${SINCE}:${UNTIL}`, `calendar:skip:c2:${SINCE}:${UNTIL}`]);
    const cursors = all.map((b) => parseOutlookCursor(b.cursor ?? null)!);
    expect(cursors.map((c) => [c.lane, c.done, c.states.inbox?.token ?? null, c.states.sentitems?.token ?? null, c.states.calendar?.token ?? null])).toEqual([
      [0, false, "i2", null, null],
      [1, false, "i3", null, null],
      [2, false, "i3", "s2", null],
      [2, false, "i3", "s2", "c2"],
      [0, true, "i3", "s2", "c3"],
    ]);
    expect(cursors.every((c) => c.pass === "historical" && c.since === SINCE && c.until === UNTIL)).toBe(true);
    expect(all.map((b) => (b.events[0] as OutlookEvent).type)).toEqual(["communication.message_logged", "communication.message_logged", "communication.message_logged", "calendar.appointment_updated", "calendar.appointment_updated"]);
    expect(eventsOf(all).every((e) => e.receivedAt === RECEIVED)).toBe(true);
    expect((eventsOf(all)[2]!.payload as { direction: string }).direction).toBe("sent");
    // Resumed mid-pass, it asks again from the page it was on.
    asked.length = 0;
    served.calendar = 1;
    const later = new Date(NOW.getTime() + DAY_MS);
    const rest = await drain(make(later).historicalImport({ cursor: all[3]!.cursor } as never));
    expect(asked).toEqual([`calendar:skip:c2:${SINCE}:${UNTIL}`]);
    expect(parseOutlookCursor(rest[0]!.cursor ?? null)!.done).toBe(true);
    expect(eventsOf(rest)[0]!.receivedAt).toBe(later.toISOString());
    // A checkpoint for another mailbox starts over.
    asked.length = 0;
    served.inbox = 0;
    served.sentitems = 0;
    served.calendar = 0;
    const other = JSON.stringify({ ...cursors[4], mailbox: outlookMailboxLabel("other@store.test") });
    await drain(make().historicalImport({ cursor: other } as never));
    expect(asked[0]).toBe(`inbox:-:-:${SINCE}`);
    // An incremental checkpoint doesn't end the import.
    asked.length = 0;
    served.inbox = 0;
    served.sentitems = 0;
    served.calendar = 0;
    await drain(make().historicalImport({ cursor: JSON.stringify({ ...cursors[4], pass: "incremental" }) } as never));
    expect(asked[0]).toBe(`inbox:-:-:${SINCE}`);
  });

  it("reads only what changed on each later sync, deletions and moves included", async () => {
    const data = account();
    const mock = outlookDocMock(data);
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(first.ingested).toBe(6);
    const quiet = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect([quiet.ingested, quiet.duplicates]).toEqual([0, 0]);
    expect(graphCalls(mock).slice(-3).map((u) => [...new URL(u).searchParams.keys()])).toEqual([["$deltatoken"], ["$deltatoken"], ["$deltatoken"]]);
    outlookMessage.reset();
    mock.putMessage("inbox", outlookMessage.one({ id: "AAMkADnew=", receivedDateTime: "2026-11-11T10:00:00Z" }));
    mock.removeMessage("inbox", String(data.messages!.inbox![0]!.id));
    mock.putEvent({ ...data.events![0]!, isCancelled: true, lastModifiedDateTime: "2026-11-11T09:00:00Z" });
    mock.removeEvent(String(data.events![1]!.id));
    const batches = await drain(connector(mock).incrementalSync({ cursor: quiet.cursor } as never));
    expect(eventsOf(batches).map((e) => e.type).sort()).toEqual(["calendar.appointment_cancelled", "calendar.appointment_cancelled", "communication.message_logged", "communication.message_removed"]);
    const sync = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(sync.ingested).toBe(4);
    expect(parseOutlookCursor(sync.cursor)!.pass).toBe("incremental");
  });

  it("goes on from the import's checkpoint, and lists the calendar again once its window runs short", async () => {
    const mock = outlookDocMock(account());
    const imported = (await drain(connector(mock).historicalImport({ cursor: null } as never))).at(-1)!.cursor!;
    const calls = graphCalls(mock).length;
    const inc = await drain(connector(mock).incrementalSync({ cursor: imported } as never));
    expect(graphCalls(mock).slice(calls).map((u) => [...new URL(u).searchParams.keys()])).toEqual([["$deltatoken"], ["$deltatoken"], ["$deltatoken"]]);
    expect(parseOutlookCursor(inc.at(-1)!.cursor!)).toMatchObject({ pass: "incremental", done: true, until: UNTIL });
    // Half a year on, the calendar is listed again a year ahead; mail goes on from its tokens.
    const later = new Date(Date.parse(UNTIL) - OUTLOOK_RENEW_MS + 1);
    const before = graphCalls(mock).length;
    const renewed = await drain(connector(mock, { now: () => later }).incrementalSync({ cursor: inc.at(-1)!.cursor } as never));
    const urls = graphCalls(mock).slice(before).map((u) => new URL(u));
    expect(urls.map((u) => [...u.searchParams.keys()])).toEqual([["$deltatoken"], ["$deltatoken"], ["startDateTime", "endDateTime"]]);
    expect(urls[2]!.searchParams.get("startDateTime")).toBe(SINCE);
    expect(urls[2]!.searchParams.get("endDateTime")).toBe(new Date(later.getTime() + OUTLOOK_AHEAD_MS).toISOString());
    expect(parseOutlookCursor(renewed.at(-1)!.cursor!)!.until).toBe(new Date(later.getTime() + OUTLOOK_AHEAD_MS).toISOString());
    // A day sooner, it isn't.
    const sooner = new Date(Date.parse(UNTIL) - OUTLOOK_RENEW_MS);
    const mark = graphCalls(mock).length;
    await drain(connector(mock, { now: () => sooner }).incrementalSync({ cursor: inc.at(-1)!.cursor } as never));
    expect(graphCalls(mock).slice(mark).map((u) => [...new URL(u).searchParams.keys()])).toEqual([["$deltatoken"], ["$deltatoken"], ["$deltatoken"]]);
    // Mid-pass, or while the calendar is still being listed, the window stays.
    const mid = { ...parseOutlookCursor(inc.at(-1)!.cursor!)!, lane: 1 };
    const m2 = graphCalls(mock).length;
    await drain(connector(mock, { now: () => later }).incrementalSync({ cursor: JSON.stringify(mid) } as never));
    expect(graphCalls(mock).slice(m2).map((u) => [...new URL(u).searchParams.keys()])).toEqual([["$deltatoken"], ["$deltatoken"]]);
    const listing = { ...parseOutlookCursor(inc.at(-1)!.cursor!)!, states: { ...parseOutlookCursor(inc.at(-1)!.cursor!)!.states, calendar: null } };
    const m3 = graphCalls(mock).length;
    await drain(connector(mock, { now: () => later }).incrementalSync({ cursor: JSON.stringify(listing) } as never));
    expect(new URL(graphCalls(mock).slice(m3)[2]!).searchParams.get("endDateTime")).toBe(UNTIL);
  });

  it("lists a lane again when Graph says its token expired, up to three times a sync", async () => {
    const mock = outlookDocMock(account());
    const imported = (await drain(connector(mock).historicalImport({ cursor: null } as never))).at(-1)!.cursor!;
    mock.expireTokens();
    const before = graphCalls(mock).length;
    const out = await drain(connector(mock).incrementalSync({ cursor: imported } as never));
    expect(graphCalls(mock).slice(before).map((u) => [...new URL(u).searchParams.keys()].join(","))).toEqual(["$deltatoken", "$select,$filter", "$deltatoken", "$select,$filter", "$deltatoken", "startDateTime,endDateTime"]);
    expect(eventsOf(out)).toHaveLength(6);
    let calls = 0;
    const gone: OutlookClient = {
      messages: async () => {
        calls++;
        throw new OutlookResyncError();
      },
      events: async () => ({ items: [], next: { kind: "delta", token: "c" } }),
    };
    const make = () => outlookConnector({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, mailbox: MAILBOX, correspondentKey: KEY, client: gone, now: () => NOW });
    await expect(drain(make().historicalImport({ cursor: null } as never))).rejects.toThrow(OutlookResyncError);
    expect(calls).toBe(4);
    const broken: OutlookClient = { messages: async () => Promise.reject(new MicrosoftApiError("x", 500)), events: gone.events };
    await expect(drain(outlookConnector({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, mailbox: MAILBOX, correspondentKey: KEY, client: broken }).historicalImport({ cursor: null } as never))).rejects.toThrow("x");
  });

  it("dead-letters a record that doesn't read and keeps going", async () => {
    const data = account();
    data.messages!.inbox![0]!.receivedDateTime = "2026-10-02";
    data.messages!.inbox![0]!.receivedDateTime = "2030-01-01T00:00:00Z";
    data.messages!.sentitems![0]!.id = "a b";
    data.events![0]!.lastModifiedDateTime = "soon";
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(outlookDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.deadLettered).toBe(2);
    expect(report.ingested).toBe(4);
  });

  it("reads up to now when no clock is given", async () => {
    const mock = outlookDocMock(account());
    const before = Date.now();
    const { now: _, ...clockless } = options(mock);
    await drain(outlookConnector(clockless).historicalImport({ cursor: null } as never));
    const end = Date.parse(new URL(graphCalls(mock)[2]!).searchParams.get("endDateTime")!);
    expect(end - OUTLOOK_AHEAD_MS).toBeGreaterThanOrEqual(before - 1);
    expect(end - OUTLOOK_AHEAD_MS).toBeLessThanOrEqual(Date.now());
  });

  it("only ever signs in and reads the two folders and the calendar", async () => {
    const mock = outlookDocMock(account());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`))).toEqual(
      new Set([`POST /${TENANT}/oauth2/v2.0/token`, `GET /v1.0/users/${encodeURIComponent(MAILBOX)}/mailFolders/inbox/messages/delta`, `GET /v1.0/users/${encodeURIComponent(MAILBOX)}/mailFolders/sentitems/messages/delta`, `GET /v1.0/users/${encodeURIComponent(MAILBOX)}/calendarView/delta`]),
    );
  });

  it("declares drafting a reply and booking an appointment, each needing approval, and a read-only gate turns both down", async () => {
    const c = connector(outlookDocMock(account()));
    expect(c.source).toBe("microsoft_outlook");
    expect(c.writes).toBe(OUTLOOK_WRITES);
    expect(OUTLOOK_WRITES.map((w) => [w.integration, w.name, w.kind, w.approval, w.dailyCap])).toEqual([
      ["microsoft_outlook", "draft_reply", "draft", "each", 20],
      ["microsoft_outlook", "book_appointment", "append", "each", 20],
    ]);
    const refused = await assertWritesRefused(c);
    expect(refused.map((r) => r.action)).toEqual(["draft_reply", "book_appointment"]);
  });
});

describe("Outlook doc mock", () => {
  it("checks the token, its scope, the first request's options and its state tokens", async () => {
    const data = account();
    const mock = outlookDocMock(data);
    const c = clientFor(mock);
    await c.messages("inbox", null, SINCE);
    const auth = { authorization: `Bearer ${"x".repeat(20)}` };
    expect((await mock.fetch(`${BOX}/mailFolders/inbox/messages/delta`, { headers: auth })).status).toBe(401);
    const page = await c.messages("inbox", null, SINCE);
    const token = (await (await mock.fetch(LOGIN_URL, { method: "POST", body: new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }) })).json()) as { access_token: string };
    const get = (path: string, q: Record<string, string> = {}) => mock.fetch(`${BOX}${path}${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ""}`, { headers: { authorization: `Bearer ${token.access_token}` } });
    expect((await get("/mailFolders/drafts/messages/delta")).status).toBe(404);
    expect((await get("/mailFolders/inbox/messages/delta", { $search: "ring" })).status).toBe(400);
    expect((await get("/mailFolders/inbox/messages/delta", { $filter: "subject eq 'x'" })).status).toBe(400);
    expect((await get("/mailFolders/inbox/messages/delta", { $filter: "receivedDateTime ge soon" })).status).toBe(400);
    const gt = (await (await get("/mailFolders/inbox/messages/delta", { $filter: "receivedDateTime gt 2026-10-03T09:00:00Z" })).json()) as { value: unknown[] };
    expect(gt.value).toHaveLength(2);
    const whole = (await (await get("/mailFolders/inbox/messages/delta")).json()) as { value: Record<string, unknown>[] };
    expect(whole.value[0]).toHaveProperty("subject");
    for (const hidden of ["body", "bodyPreview"]) expect(whole.value[0], hidden).not.toHaveProperty(hidden);
    expect((await get("/mailFolders/inbox/messages/delta", { $deltatoken: page.next.token, $top: "1" })).status).toBe(400);
    expect((await get("/mailFolders/inbox/messages/delta", { $skiptoken: page.next.token })).status).toBe(400);
    expect((await get("/mailFolders/sentitems/messages/delta", { $deltatoken: page.next.token })).status).toBe(400);
    expect((await get("/calendarView/delta", { $deltatoken: page.next.token })).status).toBe(400);
    expect((await get("/mailFolders/inbox/messages/delta", { $deltatoken: "nope" })).status).toBe(400);
    expect((await get("/calendarView/delta", { startDateTime: SINCE })).status).toBe(400);
    expect((await get("/calendarView/delta", { startDateTime: SINCE, endDateTime: UNTIL, $select: "id" })).status).toBe(400);
    const cal = (await (await get("/calendarView/delta", { startDateTime: "2026-10-03T09:30:00Z", endDateTime: UNTIL })).json()) as { value: Record<string, unknown>[] };
    expect(cal.value.map((e) => e.id)).toEqual([data.events![1]!.id]);
    expect(cal.value[0]).toHaveProperty("subject");
    expect(mock.signIns).toBe(2);
    await expect(mock.fetch(`${BOX}/sendMail`, { method: "POST", headers: { authorization: `Bearer ${token.access_token}` } })).rejects.toThrow("not in the vendor's docs");
    const empty = outlookDocMock({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, mailbox: MAILBOX });
    const none = await clientFor(empty).messages("sentitems", null, SINCE);
    expect(none.items).toEqual([]);
    expect((await clientFor(empty).events(null, SINCE, UNTIL)).items).toEqual([]);
    const roles = outlookDocMock({ ...account(), roles: ["Mail.ReadBasic"] });
    await clientFor(roles).messages("inbox", null, SINCE);
    expect((await mock.fetch(LOGIN_URL, { method: "POST", body: new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, scope: "openid", grant_type: "client_credentials" }) })).status).toBe(400);
    expect((await mock.fetch(LOGIN_URL, { method: "POST", body: new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, grant_type: "password" }) })).status).toBe(400);
    // A Request goes where its URL says.
    expect((await mock.fetch(new Request(`${BOX}/calendarView/delta`, { headers: { authorization: `Bearer ${token.access_token}` } }))).status).toBe(400);
    expect((await get("/calendarView/delta", { endDateTime: UNTIL })).status).toBe(400);
    expect((await get("/mailFolders/inbox/messages/delta", { $deltatoken: Buffer.from("{}").toString("base64url") })).status).toBe(400);
    // A message removed before a listing isn't listed; changes page like a listing.
    const paged = outlookDocMock({ ...account(), pageCap: 1 });
    const pc = clientFor(paged);
    let state = (await pc.messages("inbox", null, SINCE)).next;
    while (state.kind === "skip") state = (await pc.messages("inbox", state, SINCE)).next;
    paged.removeMessage("inbox", String(data.messages!.inbox![0]!.id));
    outlookMessage.reset();
    paged.putMessage("inbox", outlookMessage.one({ id: "AAMkADnew=" }));
    const one = await pc.messages("inbox", state, SINCE);
    expect([one.items.length, one.next.kind]).toEqual([1, "skip"]);
    const two = await pc.messages("inbox", one.next, SINCE);
    expect([two.items.length, two.next.kind]).toEqual([1, "delta"]);
    expect([...one.items, ...two.items].map((m) => m.id).sort()).toEqual(["AAMkADnew=", String(data.messages!.inbox![0]!.id)].sort());
    let fresh = await pc.messages("inbox", null, SINCE);
    const ids = fresh.items.map((m) => m.id);
    while (fresh.next.kind === "skip") ids.push(...(fresh = await pc.messages("inbox", fresh.next, SINCE)).items.map((m) => m.id));
    expect(ids).not.toContain(data.messages!.inbox![0]!.id);
    expect(ids).toHaveLength(3);
    // Throttling waits a second when the mock is given no Retry-After.
    const waits: number[] = [];
    await clientFor(outlookDocMock({ ...account(), rateLimited: 1 }), { sleep: async (ms) => void waits.push(ms) }).messages("inbox", null, SINCE);
    expect(waits).toEqual([1000]);
  });
});
