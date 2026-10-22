import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  GMAIL_MOCK_LABELS,
  GMAIL_MOCK_METADATA_SCOPE,
  GMAIL_MOCK_NOW,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  gmailDocMock,
  gmailId,
  gmailInternalDate,
  gmailMessage,
  testPipeline,
  type GmailMock,
  type GmailMockData,
  type GmailMockMessage,
} from "@karatos/connector-testkit";
import {
  GMAIL_API_URL,
  GMAIL_METADATA_HEADERS,
  GMAIL_METADATA_SCOPE,
  GMAIL_TOKEN_URL,
  GMAIL_WRITES,
  GmailApiError,
  GmailConfigError,
  gmailAddresses,
  gmailClient,
  gmailConnector,
  gmailNormalizer,
  gmailReadUrl,
  gmailScopeProblem,
  isConsumerDomain,
  memoryTokenStore,
  newestHistoryId,
  parseGmailCursor,
  type GmailConnectorOptions,
  type GmailCursor,
  type GmailRead,
  type GmailTokenStore,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = ["000000000000", "test.apps.googleusercontent.com"].join("-");
const CLIENT_SECRET = ["GOCSPX", "test", "0".repeat(20)].join("-");
const FIRST_REFRESH = ["1", "", "TEST-refresh"].join("/");
const KEY = ["test", "correspondent", "key", "0".repeat(24)].join("-");
const OTHER_KEY = ["test", "correspondent", "key", "1".repeat(24)].join("-");
const NOW = () => new Date(GMAIL_MOCK_NOW);
const RECEIVED = new Date(GMAIL_MOCK_NOW).toISOString();
const HOUR = 3_600_000;
const YEAR = 365.25 * 24 * HOUR;
const at = (msBeforeNow: number) => gmailInternalDate(new Date(Date.parse(GMAIL_MOCK_NOW) - msBeforeNow).toISOString());
const msg = (overrides: Partial<GmailMockMessage> = {}) => gmailMessage.one(overrides);

const OWNER = "Test Store <owner@store.test>";
const VENDOR = "Casting Desk <orders@vendor-casting.test>";

function mailbox(overrides: Partial<GmailMockData> = {}): GmailMockData {
  gmailMessage.reset();
  return {
    messages: [
      // 1: a customer writes in.
      msg(),
      // 2: the store replies, copying the casting vendor.
      msg({ labelIds: ["SENT"], headers: [{ name: "From", value: OWNER }, { name: "To", value: '"Customer, Test" <customer1@example.test>' }, { name: "Cc", value: VENDOR }, { name: "Subject", value: "Re: Synthetic subject" }] }),
      // 3: the vendor writes, filed under Vendors.
      msg({ labelIds: ["INBOX", "Label_2"], headers: [{ name: "From", value: VENDOR }, { name: "To", value: OWNER }, { name: "Subject", value: "Synthetic casting update" }] }),
      // 4: a draft, which isn't a conversation yet.
      msg({ labelIds: ["DRAFT"] }),
      // 5: spam, which Gmail doesn't list.
      msg({ labelIds: ["SPAM"] }),
      // 6: no internalDate: dead-lettered, not given a made-up time.
      msg({ internalDate: "" }),
    ],
    labels: GMAIL_MOCK_LABELS,
    refreshToken: FIRST_REFRESH,
    historyId: "9100",
    ...overrides,
  };
}

const options = (mock: GmailMock, extra: Partial<GmailConnectorOptions> = {}): GmailConnectorOptions => ({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  tokens: memoryTokenStore(FIRST_REFRESH),
  correspondentKey: KEY,
  fetch: mock.fetch,
  sleep: async () => {},
  now: NOW,
  clock: () => Date.parse(GMAIL_MOCK_NOW),
  ...extra,
});

const connector = (mock: GmailMock, extra: Partial<GmailConnectorOptions> = {}) => gmailConnector(options(mock, extra));
const reads = (mock: GmailMock) => mock.fetch.calls.filter((c) => c.method === "GET").map((c) => decodeURIComponent(c.url.replace(`${GMAIL_API_URL}/users/me/`, "")));
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const tokenAnswer = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const GET = (id = gmailId("18d", 1)): GmailRead => ({ method: "messages.get", id, format: "metadata", metadataHeaders: GMAIL_METADATA_HEADERS });
const hmac = (key: string, address: string) => `correspondent:${createHmac("sha256", key).update(`karatos:correspondent:v1:${address}`).digest("hex").slice(0, 32)}`;
const normalize = gmailNormalizer({ correspondentKey: KEY });

describe("Gmail client", () => {
  it("checks its settings, naming them but never their values", () => {
    const base = options(gmailDocMock(mailbox()));
    expect(() => gmailClient({ ...base, clientSecret: " " })).toThrow(new GmailConfigError("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET"));
    expect(() => gmailClient({ ...base, userId: "owner at store" })).toThrow('GMAIL_USER must be "me" or the mailbox\'s address');
    expect(() => gmailClient({ ...base, userId: "me/../other" })).toThrow(GmailConfigError);
    expect(() => gmailClient({ ...base, userId: " owner@store.test " })).not.toThrow();
  });

  it("allows only its four reads, with metadata format, its fixed headers and no search", async () => {
    const mock = gmailDocMock(mailbox());
    const client = gmailClient(options(mock));
    const refused: unknown[] = [
      { method: "messages.send" },
      { method: "messages.modify", id: "1" },
      { method: "drafts.create" },
      { method: "threads.get", id: "1" },
      { method: "messages.list", q: "after:2020/01/01" },
      { method: "messages.list", labelIds: ["INBOX"] },
      { method: "messages.list", includeSpamTrash: true },
      { method: "messages.list", maxResults: 0 },
      { method: "messages.list", maxResults: 501 },
      { method: "messages.list", maxResults: 1.5 },
      { method: "messages.list", pageToken: "abc&q=x" },
      { ...GET(), format: "full" },
      { ...GET(), format: "raw" },
      { ...GET(), format: "minimal" },
      { ...GET(), metadataHeaders: [...GMAIL_METADATA_HEADERS, "Subject"] },
      { ...GET(), metadataHeaders: ["From", "To"] },
      { ...GET(), metadataHeaders: ["To", "From", "Cc"] },
      { ...GET() as object, metadataHeaders: undefined },
      { ...GET("../labels") },
      { ...GET("1"), snippet: true },
      { method: "history.list", startHistoryId: "9050 OR 1", historyTypes: ["messageAdded"] },
      { method: "history.list", startHistoryId: "9050", historyTypes: [] },
      { method: "history.list", startHistoryId: "9050", historyTypes: ["messageAdded", "draftAdded"] },
      { method: "history.list", startHistoryId: "9050" },
      { method: "labels.list", id: "Label_1" },
      null,
    ];
    for (const request of refused) {
      await expect(client.read(request as GmailRead), JSON.stringify(request)).rejects.toThrow(GmailConfigError);
    }
    // Nothing above reached Google, not even a token refresh.
    expect(mock.fetch.calls).toEqual([]);
    expect(GMAIL_METADATA_HEADERS).toEqual(["From", "To", "Cc"]);
    expect(gmailReadUrl("me", GET("18d0000000000001"))).toBe(`${GMAIL_API_URL}/users/me/messages/18d0000000000001?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`);
    expect(gmailReadUrl("owner@store.test", { method: "labels.list" })).toBe(`${GMAIL_API_URL}/users/owner%40store.test/labels`);
    expect(gmailReadUrl("me", { method: "history.list", startHistoryId: "9050", maxResults: 500, pageToken: "T-1", historyTypes: ["messageAdded", "labelAdded"] })).toBe(
      `${GMAIL_API_URL}/users/me/history?startHistoryId=9050&maxResults=500&pageToken=T-1&historyTypes=messageAdded&historyTypes=labelAdded`,
    );
  });

  it("gets with a bearer token, never in the URL, after refreshing with the client's keys at Google's token endpoint", async () => {
    const mock = gmailDocMock(mailbox());
    const seen: { method: string; url: string; auth: string | null; body: string }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input as string, init);
      seen.push({ method: request.method, url: request.url, auth: request.headers.get("authorization"), body: await request.clone().text() });
      return mock.fetch(request);
    };
    const client = gmailClient(options(mock, { fetch }));
    expect(await client.read({ method: "labels.list" })).toMatchObject({ labels: expect.any(Array) });
    expect(await client.read(GET())).toMatchObject({ id: gmailId("18d", 1) });
    expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([`POST ${GMAIL_TOKEN_URL}`, `GET ${GMAIL_API_URL}/users/me/labels`, `GET ${GMAIL_API_URL}/users/me/messages/${gmailId("18d", 1)}`]);
    const form = new URLSearchParams(seen[0]!.body);
    expect(Object.fromEntries(form)).toEqual({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "refresh_token", refresh_token: FIRST_REFRESH });
    expect(seen[0]!.auth).toBeNull();
    for (const get of seen.slice(1)) {
      expect(get.auth).toBe("Bearer AT-TEST-1");
      expect(get.url).not.toContain("AT-TEST");
      expect(new URL(get.url).searchParams.has("access_token")).toBe(false);
    }
  });

  it("answers null for a 404, so a deleted message or expired history is the connector's call", async () => {
    const client = gmailClient(options(gmailDocMock(mailbox())));
    expect(await client.read(GET("ffff"))).toBeNull();
    expect(await client.read({ method: "history.list", startHistoryId: "1", historyTypes: ["messageAdded"] })).not.toBeNull();
    const old = gmailClient(options(gmailDocMock(mailbox({ historyFloor: "9000" }))));
    expect(await old.read({ method: "history.list", startHistoryId: "1", historyTypes: ["messageAdded"] })).toBeNull();
  });

  it("won't use a connection holding anything beyond gmail.metadata and sign-in scopes", async () => {
    for (const extra of [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.labels",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.insert",
      "https://www.googleapis.com/auth/gmail.settings.basic",
      "https://www.googleapis.com/auth/drive",
      "profile",
    ]) {
      const mock = gmailDocMock(mailbox({ scopes: [GMAIL_MOCK_METADATA_SCOPE, extra] }));
      const error = await failure(gmailClient(options(mock)).read({ method: "labels.list" }));
      expect(error, extra).toBeInstanceOf(GmailConfigError);
      expect(error.message).toContain(`more than metadata access (${extra})`);
      expect(error.message).toContain(`reconnect it with only ${GMAIL_METADATA_SCOPE}`);
      expect(mock.fetch.calls.filter((c) => c.method === "GET"), extra).toEqual([]);
    }
    const signIn = gmailDocMock(mailbox({ scopes: ["openid", GMAIL_MOCK_METADATA_SCOPE, "email", "https://www.googleapis.com/auth/userinfo.email"] }));
    await expect(gmailClient(options(signIn)).read({ method: "labels.list" })).resolves.toMatchObject({ labels: expect.any(Array) });
    const without = gmailDocMock(mailbox({ scopes: ["openid", "email"] }));
    await expect(gmailClient(options(without)).read({ method: "labels.list" })).rejects.toThrow("doesn't hold the gmail.metadata scope");
  });

  it("tells metadata-only scopes from wider ones, and refuses a token that doesn't say", () => {
    expect(gmailScopeProblem(GMAIL_METADATA_SCOPE)).toBeNull();
    expect(gmailScopeProblem(`openid  ${GMAIL_METADATA_SCOPE} email`)).toBeNull();
    expect(gmailScopeProblem(`${GMAIL_METADATA_SCOPE} https://www.googleapis.com/auth/gmail.metadata.extra`)).toContain("more than metadata access");
    expect(gmailScopeProblem(undefined)).toBe("Google didn't say which scopes the token holds");
    expect(gmailScopeProblem(" ")).toBe("Google didn't say which scopes the token holds");
    expect(gmailScopeProblem(["x"])).toBe("Google didn't say which scopes the token holds");
  });

  it("refuses a refresh answer with no scope field before reading any mail", async () => {
    const mock = gmailDocMock(mailbox());
    const fetch: typeof globalThis.fetch = async (input, init) =>
      String(input) === GMAIL_TOKEN_URL ? tokenAnswer({ access_token: "AT-TEST-1", expires_in: 3599, token_type: "Bearer" }) : mock.fetch(input as string, init);
    await expect(gmailClient(options(mock, { fetch })).read({ method: "labels.list" })).rejects.toThrow("Google didn't say which scopes the token holds");
    expect(mock.fetch.calls).toEqual([]);
  });

  it("keeps using the same refresh token, since Google doesn't rotate it, and saves one if Google ever does", async () => {
    const mock = gmailDocMock(mailbox());
    const tokens = memoryTokenStore(FIRST_REFRESH);
    const client = gmailClient(options(mock, { tokens }));
    await client.read({ method: "labels.list" });
    expect(tokens.current).toBe(FIRST_REFRESH);
    const saved: string[] = [];
    const store: GmailTokenStore = { load: async () => FIRST_REFRESH, save: async (t) => void saved.push(t) };
    const rotating: typeof globalThis.fetch = async (input, init) =>
      String(input) === GMAIL_TOKEN_URL ? tokenAnswer({ access_token: "AT-X", expires_in: 3599, scope: GMAIL_METADATA_SCOPE, refresh_token: "1//TEST-new" }) : mock.fetch(input as string, init);
    // The rotated token is saved even though this access token isn't one the mock issued.
    await failure(gmailClient(options(mock, { tokens: store, fetch: rotating })).read({ method: "labels.list" }));
    expect(new Set(saved)).toEqual(new Set(["1//TEST-new"]));
  });

  it("refreshes once for reads at the same time, reuses the access token, and renews it before it expires", async () => {
    const mock = gmailDocMock(mailbox());
    let now = Date.parse(GMAIL_MOCK_NOW);
    const client = gmailClient(options(mock, { clock: () => now }));
    await Promise.all([client.read({ method: "labels.list" }), client.read(GET()), client.read(GET())]);
    expect(mock.refreshes).toBe(1);
    now += 55 * 60_000;
    await client.read({ method: "labels.list" });
    expect(mock.refreshes).toBe(1);
    // Within two minutes of the hour Google gave, a fresh token is fetched first.
    now += 3 * 60_000;
    await client.read({ method: "labels.list" });
    expect(mock.refreshes).toBe(2);
  });

  it("refreshes once when an access token is revoked early, then gives up", async () => {
    const mock = gmailDocMock(mailbox());
    const client = gmailClient(options(mock));
    await client.read({ method: "labels.list" });
    mock.revokeAccessTokens();
    await client.read({ method: "labels.list" });
    expect(mock.refreshes).toBe(2);
    const always401: typeof globalThis.fetch = async (input, init) => (String(input) === GMAIL_TOKEN_URL ? mock.fetch(input as string, init) : tokenAnswer({ error: { code: 401, message: "Invalid Credentials" } }, 401));
    const error = await failure(gmailClient(options(mock, { fetch: always401 })).read({ method: "labels.list" }));
    expect(error).toMatchObject({ name: "GmailApiError", status: 401, message: "Gmail answered HTTP 401: Invalid Credentials" });
  });

  it("asks for a refresh token when there is none, and explains an expired or revoked one", async () => {
    const mock = gmailDocMock(mailbox());
    await expect(gmailClient(options(mock, { tokens: memoryTokenStore(" ") })).read({ method: "labels.list" })).rejects.toThrow(new GmailConfigError("set GMAIL_REFRESH_TOKEN"));
    mock.expireRefreshToken();
    const error = await failure(gmailClient(options(mock)).read({ method: "labels.list" }));
    expect(error).toBeInstanceOf(GmailApiError);
    expect(error.message).toBe("Google refused the token refresh (HTTP 400, invalid_grant); reconnect the mailbox to get a new refresh token (tokens from a consent screen in Testing last 7 days)");
    expect(error.message).not.toContain(FIRST_REFRESH);
    expect(error.message).not.toContain(CLIENT_SECRET);
    const broken: typeof globalThis.fetch = async () => new Response("<html>", { status: 502 });
    await expect(gmailClient(options(mock, { fetch: broken })).read({ method: "labels.list" })).rejects.toThrow("Google refused the token refresh (HTTP 502)");
  });

  it("waits out 429s and per-user rate limits, honouring Retry-After up to a minute", async () => {
    const waits: number[] = [];
    const mock = gmailDocMock(mailbox({ rateLimits: [{ status: 429, retryAfter: 3 }, { status: 403, reason: "userRateLimitExceeded" }, { status: 403, reason: "rateLimitExceeded" }, { status: 429, retryAfter: 600 }] }));
    const client = gmailClient(options(mock, { sleep: async (ms) => void waits.push(ms), unitsPerMinute: 1e12 }));
    await expect(client.read({ method: "labels.list" })).resolves.toMatchObject({ labels: expect.any(Array) });
    expect(waits.filter((w) => w >= 1)).toEqual([3000, 2000, 4000, 60_000]);
  });

  it("gives up after its retries, and stops at once on the daily limit so the sync resumes from its checkpoint", async () => {
    const limited = gmailDocMock(mailbox({ rateLimits: Array.from({ length: 6 }, () => ({ status: 429 as const })) }));
    const error = await failure(gmailClient(options(limited, { rateLimitRetries: 2 })).read({ method: "labels.list" }));
    expect(error).toMatchObject({ name: "GmailApiError", status: 429, message: "Gmail kept rate-limiting the sync (rateLimitExceeded)" });
    const waits: number[] = [];
    const daily = gmailDocMock(mailbox({ rateLimits: [{ status: 403, reason: "dailyLimitExceeded" }] }));
    const stop = await failure(gmailClient(options(daily, { sleep: async (ms) => void waits.push(ms), unitsPerMinute: 1e12 })).read({ method: "labels.list" }));
    expect(stop).toMatchObject({ status: 403, reason: "dailyLimitExceeded" });
    expect(stop.message).toContain("resumes from the checkpoint");
    expect(waits.filter((w) => w >= 1)).toEqual([]);
  });

  it("paces reads by their quota cost, under Gmail's per-mailbox budget", async () => {
    const waits: number[] = [];
    const client = gmailClient(options(gmailDocMock(mailbox()), { sleep: async (ms) => void waits.push(ms), unitsPerMinute: 6000 }));
    await client.read(GET());
    await client.read({ method: "labels.list" });
    await client.read({ method: "labels.list" });
    // 10 ms a unit: a message read costs 20 units, a label list 1.
    expect(waits).toEqual([200, 210]);
  });

  it("reports Google's errors cut short with a hint, and refuses an answer that isn't JSON", async () => {
    const mock = gmailDocMock(mailbox());
    const answer = (response: () => Response): typeof globalThis.fetch => async (input, init) => (String(input) === GMAIL_TOKEN_URL ? mock.fetch(input as string, init) : response());
    const policy = answer(() => tokenAnswer({ error: { code: 403, message: "The domain administrators have disabled Gmail apps.", errors: [{ domain: "global", reason: "domainPolicy" }] } }, 403));
    await expect(gmailClient(options(mock, { fetch: policy })).read({ method: "labels.list" })).rejects.toThrow(
      "Gmail answered HTTP 403: The domain administrators have disabled Gmail apps.; the Workspace admin has turned off Gmail access for apps",
    );
    const long = answer(() => tokenAnswer({ error: { code: 500, message: "x".repeat(500) } }, 500));
    const error = await failure(gmailClient(options(mock, { fetch: long })).read({ method: "labels.list" }));
    expect(error.message.length).toBeLessThan(240);
    const text = answer(() => new Response("ok", { status: 200 }));
    await expect(gmailClient(options(mock, { fetch: text })).read({ method: "labels.list" })).rejects.toThrow("Gmail did not answer with JSON");
    const bare = answer(() => new Response("", { status: 503 }));
    await expect(gmailClient(options(mock, { fetch: bare })).read({ method: "labels.list" })).rejects.toThrow(/^Gmail answered HTTP 503$/);
  });

  it("is answered by a mock that holds the metadata scope to Google's documented limits", async () => {
    const mock = gmailDocMock(mailbox());
    await gmailClient(options(mock)).read({ method: "labels.list" });
    const token = "Bearer AT-TEST-1";
    const get = (path: string) => mock.fetch(`${GMAIL_API_URL}/users/me/${path}`, { headers: { authorization: token } });
    expect((await get("messages?q=from:x")).status).toBe(403);
    expect((await get(`messages/${gmailId("18d", 1)}?format=full`)).status).toBe(403);
    expect((await get(`messages/${gmailId("18d", 1)}?format=raw`)).status).toBe(403);
    expect((await get(`messages/${gmailId("18d", 1)}?format=bogus`)).status).toBe(400);
    expect(await (await get(`messages/${gmailId("18d", 1)}?format=minimal`)).json()).not.toHaveProperty("payload");
    // Without metadataHeaders every header comes back, Subject included: the client always names its three.
    const all = (await (await get(`messages/${gmailId("18d", 1)}?format=metadata`)).json()) as { payload: { headers: { name: string }[] } };
    expect(all.payload.headers.map((h) => h.name)).toContain("Subject");
    expect((await get("messages?pageToken=nonsense")).status).toBe(400);
    expect((await get("history")).status).toBe(400);
    expect((await get("history?startHistoryId=1&pageToken=nonsense")).status).toBe(400);
    expect((await get("labels?access_token=AT-TEST-1")).status).toBe(400);
    const spam = (await (await get("messages?includeSpamTrash=true")).json()) as { messages: unknown[] };
    expect(spam.messages).toHaveLength(6);
    const wide = gmailDocMock(mailbox({ scopes: ["https://www.googleapis.com/auth/gmail.readonly"] }));
    await failure(gmailClient(options(wide)).read({ method: "labels.list" }));
    const full = await wide.fetch(`${GMAIL_API_URL}/users/me/messages/${gmailId("18d", 1)}?format=full`, { headers: { authorization: token } });
    expect(full.status).toBe(200);
    expect(await mock.fetch(GMAIL_TOKEN_URL, { method: "POST", body: "grant_type=refresh_token" })).toMatchObject({ status: 401 });
  });

  it("routes the mock by exact host, so a look-alike token host is refused", async () => {
    const mock = gmailDocMock(mailbox());
    await expect(mock.fetch("https://oauth2.googleapis.com.example.test/token", { method: "POST" })).rejects.toThrow(/not in the vendor's docs/);
  });
});

describe("Gmail normalization", () => {
  const fetched = (m: GmailMockMessage) => ({ ...m, payload: { headers: m.headers } });

  it("keeps who, when, which way, the thread and the labels, and drops the snippet, subject, names and addresses", () => {
    const data = mailbox();
    const events = data.messages.flatMap((m) => normalize.messageEvents(fetched(m), RECEIVED));
    expect(events.map((e) => e.type)).toEqual(["communication.message_logged", "communication.message_logged", "communication.message_logged", "communication.message_logged"]);
    const text = JSON.stringify(events);
    for (const personal of ["@", "Synthetic", "snippet", "subject", "ring size", "TEST-", "Test Customer", "Customer, Test", "customer1", "owner", "Test Store", "Casting Desk", "Message-ID", "sizeEstimate"]) {
      expect(text, personal).not.toContain(personal);
    }
    const [received, sent, vendor] = events;
    expect(received).toMatchObject({
      id: expect.stringMatching(/^gmail_message:18d0000000000001:[0-9a-f]{16}$/),
      idempotencyKey: expect.stringMatching(/^gmail:message:18d0000000000001:[0-9a-f]{16}$/),
      occurredAt: new Date(Number(data.messages[0]!.internalDate)).toISOString(),
      receivedAt: RECEIVED,
      payload: {
        channel: "email",
        messageId: "gmail:message:18d0000000000001",
        threadId: "gmail:thread:18d0000000000001",
        direction: "received",
        sentAt: new Date(Number(data.messages[0]!.internalDate)).toISOString(),
        from: { correspondentId: hmac(KEY, "customer1@example.test"), domain: "example.test" },
        to: [{ correspondentId: hmac(KEY, "owner@store.test"), domain: "store.test" }],
        cc: [],
        recipientCount: 1,
        labelIds: ["CATEGORY_PERSONAL", "INBOX", "UNREAD"],
      },
    });
    expect(Object.keys(received!.payload).sort()).toEqual(["cc", "channel", "direction", "from", "labelIds", "messageId", "recipientCount", "sentAt", "threadId", "to"]);
    expect(sent!.payload).toMatchObject({ direction: "sent", recipientCount: 2, from: { correspondentId: hmac(KEY, "owner@store.test") } });
    // The same person is the same reference whichever header they're in.
    expect((sent!.payload.to as { correspondentId: string }[])[0]!.correspondentId).toBe((received!.payload.from as { correspondentId: string }).correspondentId);
    expect(vendor!.payload).toMatchObject({ from: { domain: "vendor-casting.test" }, labelIds: ["INBOX", "Label_2"] });
  });

  it("keys correspondents with this instance's key, so another key or a plain hash can't match them", () => {
    const address = "customer1@example.test";
    const mine = normalize.correspondent(address).correspondentId;
    expect(mine).toBe(hmac(KEY, address));
    expect(gmailNormalizer({ correspondentKey: KEY }).correspondent(" Customer1@EXAMPLE.test ").correspondentId).toBe(mine);
    expect(gmailNormalizer({ correspondentKey: OTHER_KEY }).correspondent(address).correspondentId).not.toBe(mine);
    expect(mine).not.toContain(createHash("sha256").update(address).digest("hex").slice(0, 32));
    expect(normalize.correspondent("customer2@example.test").correspondentId).not.toBe(mine);
    expect(() => gmailNormalizer({ correspondentKey: "short" })).toThrow("set CORRESPONDENT_HASH_KEY to at least 32 characters");
    expect(() => gmailNormalizer({ correspondentKey: undefined as unknown as string })).toThrow(/CORRESPONDENT_HASH_KEY/);
  });

  it("keeps the domain only for businesses, never for consumer mail services", () => {
    for (const domain of ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "comcast.net", "yahoo.co.uk", "hotmail.fr", "outlook.de", "yahoo.com.au", "GMAIL.COM"]) {
      expect(isConsumerDomain(domain), domain).toBe(true);
      expect(normalize.correspondent(`test-customer-1@${domain}`), domain).toEqual({ correspondentId: expect.stringMatching(/^correspondent:[0-9a-f]{32}$/) });
    }
    for (const domain of ["vendor-casting.test", "gmail.com.vendor.test", "yahoo.example", "store.test", "outlook-jewelry.test"]) {
      expect(isConsumerDomain(domain), domain).toBe(false);
      expect(normalize.correspondent(`sales@${domain}`).domain, domain).toBe(domain);
    }
  });

  it("reads bare addresses out of address headers, without display names", () => {
    expect(gmailAddresses('"Customer, Test" <Customer1@Example.test>, sales@vendor.test')).toEqual(["customer1@example.test", "sales@vendor.test"]);
    expect(gmailAddresses("Team: a@one.test, b@two.test; c@three.test")).toEqual(["a@one.test", "b@two.test", "c@three.test"]);
    expect(gmailAddresses('d@four.test (Desk, Front), "Quoted \\" <x@no.test>" <e@five.test>')).toEqual(["d@four.test", "e@five.test"]);
    expect(gmailAddresses("undisclosed-recipients:;")).toEqual([]);
    expect(gmailAddresses("not an address, <broken@>, @no.test, plain@nodot")).toEqual([]);
    expect(gmailAddresses("")).toEqual([]);
  });

  it("counts every recipient once but keeps at most 50 per header", () => {
    const to = Array.from({ length: 60 }, (_, i) => `list${i}@vendor.test`).join(", ");
    const message = { id: "abc", labelIds: ["INBOX"], internalDate: at(HOUR), payload: { headers: [{ name: "to", value: to }, { name: "TO", value: "list0@vendor.test" }, { name: "Cc", value: "x@vendor.test" }] } };
    const [event] = normalize.messageEvents(message, RECEIVED);
    expect((event!.payload.to as unknown[]).length).toBe(50);
    expect(event!.payload.recipientCount).toBe(61);
    expect(event!.payload).not.toHaveProperty("from");
    expect(event!.payload).not.toHaveProperty("threadId");
  });

  it("stores a new version when the labels change, and the same one whatever order Gmail lists them in", () => {
    const base = { id: "abc", threadId: "abc", internalDate: at(HOUR), payload: { headers: [] } };
    const key = (labelIds: unknown) => normalize.messageEvents({ ...base, labelIds }, RECEIVED)[0]!.idempotencyKey;
    expect(key(["INBOX", "UNREAD"])).toBe(key(["UNREAD", "INBOX", "INBOX"]));
    expect(key(["INBOX", "UNREAD"])).not.toBe(key(["INBOX"]));
    expect(key(["INBOX", "Label_1"])).not.toBe(key(["INBOX"]));
    expect(key("INBOX")).toBe(key([]));
    expect(normalize.messageEvents({ ...base, labelIds: ["INBOX", 7, "bad label"] }, RECEIVED)[0]!.payload.labelIds).toEqual(["INBOX"]);
  });

  it("skips drafts, spam and messages with no usable id, and dead-letters one with no time", () => {
    expect(normalize.messageEvents({ id: "abc", labelIds: ["DRAFT"], internalDate: at(HOUR) }, RECEIVED)).toEqual([]);
    expect(normalize.messageEvents({ id: "abc", labelIds: ["SPAM", "INBOX"], internalDate: at(HOUR) }, RECEIVED)).toEqual([]);
    for (const id of [undefined, "", "../x", 5]) expect(normalize.messageEvents({ id, labelIds: [] }, RECEIVED)).toEqual([]);
    expect(normalize.messageEvents(null as never, RECEIVED)).toEqual([]);
    const [undated] = normalize.messageEvents({ id: "abc", labelIds: [], internalDate: "soon" }, RECEIVED);
    expect(undated!.occurredAt).toBeUndefined();
    expect(undated!.payload).not.toHaveProperty("sentAt");
  });

  it("keeps label names unless they look like an address or a number, or names are turned off", () => {
    const labels = [
      ...GMAIL_MOCK_LABELS,
      { id: "Label_3", name: "Order 20417", type: "user" },
      { id: "Label_4", name: "customer1@example.test", type: "user" },
      { id: "Label_5", type: "user" },
      { id: "CATEGORY_UPDATES", type: "system" },
      { id: "bad id", name: "x", type: "user" },
      null,
    ];
    const events = normalize.labelEvents(labels, RECEIVED);
    expect(events.map((e) => [e.payload.labelId, e.payload.kind, e.payload.name ?? null, e.payload.nameWithheld ?? false])).toEqual([
      ["gmail:label:INBOX", "system", "INBOX", false],
      ["gmail:label:SENT", "system", "SENT", false],
      ["gmail:label:UNREAD", "system", "UNREAD", false],
      ["gmail:label:DRAFT", "system", "DRAFT", false],
      ["gmail:label:SPAM", "system", "SPAM", false],
      ["gmail:label:CATEGORY_PERSONAL", "system", "CATEGORY_PERSONAL", false],
      ["gmail:label:Label_1", "user", "Bridal", false],
      ["gmail:label:Label_2", "user", "Vendors", false],
      ["gmail:label:Label_3", "user", null, true],
      ["gmail:label:Label_4", "user", null, true],
      ["gmail:label:Label_5", "user", null, true],
      ["gmail:label:CATEGORY_UPDATES", "system", "CATEGORY_UPDATES", false],
    ]);
    expect(events[0]).toMatchObject({ type: "communication.label_updated", occurredAt: RECEIVED, idempotencyKey: expect.stringMatching(/^gmail:label:INBOX:[0-9a-f]{16}$/) });
    const dropped = gmailNormalizer({ correspondentKey: KEY, labelNames: "drop" }).labelEvents(GMAIL_MOCK_LABELS, RECEIVED);
    expect(dropped.filter((e) => e.payload.kind === "user").map((e) => e.payload.name ?? null)).toEqual([null, null]);
    // A rename is a new version.
    const renamed = normalize.labelEvents([{ id: "Label_1", name: "Bridal 2.0", type: "user" }], RECEIVED)[0]!;
    expect(renamed.idempotencyKey).not.toBe(events[6]!.idempotencyKey);
    expect(normalize.labelEvents("nope", RECEIVED)).toEqual([]);
  });

  it("records a deletion once, and only for a real message id", () => {
    expect(normalize.deletedEvent("abc", RECEIVED)).toEqual([
      { id: "gmail_message:abc:deleted", type: "communication.message_deleted", occurredAt: RECEIVED, receivedAt: RECEIVED, idempotencyKey: "gmail:message:abc:deleted", payload: { channel: "email", messageId: "gmail:message:abc" } },
    ]);
    expect(normalize.deletedEvent("../x", RECEIVED)).toEqual([]);
  });

  it("finds the newest history id by number, not by text", () => {
    expect(newestHistoryId(["9", "10", "x", undefined, "8"])).toBe("10");
    expect(newestHistoryId([])).toBeNull();
  });

  it("uses synthetic fixtures only", () => {
    expect(() => assertSynthetic(mailbox())).not.toThrow();
  });
});

describe("Gmail sync", () => {
  it("imports, replays, resumes and retries the mocked mailbox", async () => {
    // 8 labels; messages 1 to 3, a draft skipped, spam not listed, and one with no time dead-lettered.
    const result = await checkConnectorSync({ makeConnector: () => connector(gmailDocMock(mailbox())), expected: { ingested: 11, deadLettered: 1 } });
    expect(result.full.batches).toBe(2);
    expect(parseGmailCursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done", pageToken: null, historyId: "9006" });
  });

  it("reads 500 messages a page with metadata only, and never sends a search or a write", async () => {
    const data = mailbox();
    data.messages = gmailMessage.many(501);
    const mock = gmailDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 8 + 501, batches: 3 });
    const lists = reads(mock).filter((r) => r.startsWith("messages?"));
    expect(lists).toEqual(["messages?maxResults=500", expect.stringMatching(/^messages\?maxResults=500&pageToken=[A-Za-z0-9_-]+$/)]);
    const gets = reads(mock).filter((r) => r.startsWith("messages/"));
    expect(gets).toHaveLength(501);
    for (const get of gets) expect(get).toMatch(/^messages\/[0-9a-f]{16}\?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc$/);
    expect(mock.fetch.calls.filter((c) => c.method !== "GET").map((c) => c.url)).toEqual([GMAIL_TOKEN_URL]);
    expect(reads(mock).some((r) => /[?&]q=/.test(r))).toBe(false);
    const stored = JSON.stringify(memory.events);
    for (const personal of ["Synthetic", "customer1", "@", "Test Customer"]) expect(stored, personal).not.toContain(personal);
  });

  it("lists newest first and stops after the first page wholly older than five years", async () => {
    const data = mailbox();
    gmailMessage.reset();
    const ages = [1 * HOUR, 2 * HOUR, 4 * YEAR, 6 * YEAR, 5 * YEAR - 24 * HOUR, 5 * YEAR + 24 * HOUR, 7 * YEAR, 8 * YEAR];
    // Listed by internalDate: 1h, 2h | 4y, 5y-1d | 5y+1d, 6y | 7y, 8y.
    data.messages = ages.map((age) => msg({ internalDate: at(age) }));
    const mock = gmailDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { pageSize: 2 }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(reads(mock).filter((r) => r.startsWith("messages?"))).toHaveLength(3);
    expect(report.ingested - 8).toBe(4);
    const kept = memory.events.filter((e) => e.type === "communication.message_logged").map((e) => Date.parse(GMAIL_MOCK_NOW) - Date.parse(e.occurredAt));
    expect(kept.every((age) => age < 5 * YEAR)).toBe(true);
  });

  it("goes on past a page that is only partly older than the cutoff, in case Gmail's order isn't strict", async () => {
    const data = mailbox();
    gmailMessage.reset();
    // Listed: 1h, 2h | 4y, 6y (partly old) | 7y, 8y (wholly old) | 9y.
    data.messages = [HOUR, 2 * HOUR, 4 * YEAR, 6 * YEAR, 7 * YEAR, 8 * YEAR, 9 * YEAR].map((age) => msg({ internalDate: at(age) }));
    const mock = gmailDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock, { pageSize: 2 }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // The partly old page doesn't end the listing; the wholly old one does, so page 4 is never read.
    expect(reads(mock).filter((r) => r.startsWith("messages?"))).toHaveLength(3);
    expect(memory.events.filter((e) => e.type === "communication.message_logged")).toHaveLength(3);
  });

  it("starts the next history read from the newest message on the first page, and skips one deleted mid-listing", async () => {
    const data = mailbox();
    const mock = gmailDocMock(data);
    const vanish: typeof globalThis.fetch = async (input, init) => (String(input).includes(`/messages/${gmailId("18d", 2)}?`) ? new Response("", { status: 404 }) : mock.fetch(input as string, init));
    const batches = [];
    for await (const b of connector(mock, { fetch: vanish }).historicalImport({ organizationId: TEST_ORG, cursor: null })) batches.push(b);
    expect(parseGmailCursor(batches.at(-1)!.cursor)!.historyId).toBe("9006");
    expect(batches[1]!.events).toHaveLength(3);
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(gmailDocMock(mailbox())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 11, deadLettered: 1 });
    expect(new Set(memory.events.map((e) => e.type))).toEqual(new Set(["communication.label_updated", "communication.message_logged"]));
  });

  it("leaves a finished import finished", async () => {
    const done: GmailCursor = { pass: "historical", step: "done", pageToken: null, since: "2021-01-20T00:00:00.000Z", historyId: "9006", nextFrom: RECEIVED };
    const mock = gmailDocMock(mailbox());
    const batches = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })) batches.push(b);
    expect(batches).toEqual([]);
    expect(mock.fetch.calls).toEqual([]);
  });

  const previous: GmailCursor = { pass: "incremental", step: "done", pageToken: null, since: "2026-01-18T00:00:00.000Z", historyId: "9050", nextFrom: "2026-01-19T00:00:00.000Z" };
  const ref = (m: GmailMockMessage) => ({ message: { id: m.id, threadId: m.threadId } });

  function changedMailbox(extra: Partial<GmailMockData> = {}): GmailMockData {
    const data = mailbox(extra);
    const [first, second] = data.messages;
    const added = msg({ labelIds: ["INBOX", "UNREAD"] });
    const deletedLater = msg();
    data.messages = [{ ...first!, labelIds: ["INBOX", "Label_1"] }, second!, added];
    data.history = [
      { id: "9040", messagesAdded: [ref(second!)] },
      { id: "9060", messagesAdded: [ref(added)] },
      { id: "9061", labelsAdded: [{ ...ref(first!), labelIds: ["Label_1"] }] },
      { id: "9062", messagesAdded: [ref(deletedLater)] },
      { id: "9063", messagesDeleted: [ref(deletedLater)] },
      // Labels removed from a message that is gone by the time it's read again.
      { id: "9064", labelsRemoved: [{ message: { id: gmailId("18d", 99), threadId: gmailId("18d", 99) }, labelIds: ["UNREAD"] }] },
    ];
    return data;
  }

  it("reads the history since the last pass, reading each changed message again for its whole label set", async () => {
    const mock = gmailDocMock(changedMailbox());
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "gmail", "incremental", JSON.stringify(previous));
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 8 + 4, deadLettered: 0, batches: 2 });
    expect(reads(mock)).toEqual([
      "labels",
      "history?startHistoryId=9050&maxResults=500&historyTypes=messageAdded&historyTypes=messageDeleted&historyTypes=labelAdded&historyTypes=labelRemoved",
      `messages/${gmailId("18d", 7)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`,
      `messages/${gmailId("18d", 1)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`,
      `messages/${gmailId("18d", 99)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc`,
    ]);
    const messages = memory.events.filter((e) => e.type !== "communication.label_updated");
    expect(messages.map((e) => [e.type, (e.payload as { messageId: string }).messageId])).toEqual([
      ["communication.message_logged", `gmail:message:${gmailId("18d", 7)}`],
      ["communication.message_logged", `gmail:message:${gmailId("18d", 1)}`],
      ["communication.message_deleted", `gmail:message:${gmailId("18d", 99)}`],
      ["communication.message_deleted", `gmail:message:${gmailId("18d", 8)}`],
    ]);
    expect(messages[1]!.payload).toMatchObject({ labelIds: ["INBOX", "Label_1"] });
    expect(parseGmailCursor(report.cursor)).toEqual({ pass: "incremental", step: "done", pageToken: null, since: "2026-01-18T23:55:00.000Z", historyId: "9100", nextFrom: RECEIVED });
    // A second pass from the new history id finds nothing new.
    const again = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(again).toMatchObject({ ingested: 0 });
  });

  it("pages through the history 500 records at a time before taking the new history id", async () => {
    const data = changedMailbox();
    const first = data.messages[0]!;
    data.history = Array.from({ length: 501 }, (_, i) => ({ id: String(9051 + i), labelsAdded: [{ ...ref(first), labelIds: ["Label_1"] }] }));
    const mock = gmailDocMock(data);
    const batches = [];
    for await (const b of connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(previous) })) batches.push(b);
    expect(reads(mock).filter((r) => r.startsWith("history?"))).toHaveLength(2);
    expect(reads(mock).filter((r) => r.startsWith("messages/"))).toHaveLength(2);
    expect(parseGmailCursor(batches[1]!.cursor)).toMatchObject({ step: "history", historyId: "9050", pageToken: expect.any(String) });
    expect(parseGmailCursor(batches[2]!.cursor)).toMatchObject({ step: "done", historyId: "9100", pageToken: null });
  });

  it("lists back to the previous pass when Gmail no longer has the history, then takes a fresh history id", async () => {
    const data = mailbox({ historyFloor: "9080" });
    gmailMessage.reset();
    // Two messages since the previous pass started, then older ones.
    data.messages = [HOUR, 2 * HOUR, 3 * 24 * HOUR, 4 * 24 * HOUR, 5 * 24 * HOUR].map((age) => msg({ internalDate: at(age) }));
    const mock = gmailDocMock(data);
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "gmail", "incremental", JSON.stringify(previous));
    const report = await runSync({ connector: connector(mock, { pageSize: 2 }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(reads(mock).map((r) => r.split("?")[0])).toEqual(["labels", "history", "messages", "messages/18d0000000000001", "messages/18d0000000000002", "messages", "messages/18d0000000000003", "messages/18d0000000000004"]);
    expect(memory.events.filter((e) => e.type === "communication.message_logged")).toHaveLength(2);
    expect(parseGmailCursor(report.cursor)).toMatchObject({ step: "done", historyId: "9002", since: "2026-01-18T23:55:00.000Z" });
  });

  it("lists back 48 hours on a first incremental pass with no checkpoint", async () => {
    const data = mailbox();
    gmailMessage.reset();
    data.messages = [HOUR, 47 * HOUR, 49 * HOUR, 50 * HOUR].map((age) => msg({ internalDate: at(age) }));
    const mock = gmailDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(8 + 2);
    expect(parseGmailCursor(report.cursor)).toMatchObject({ pass: "incremental", step: "done", since: "2026-01-18T00:00:00.000Z", historyId: "9004" });
  });

  it("starts a pass over from the labels when the previous checkpoint was the import's", async () => {
    const mock = gmailDocMock(changedMailbox());
    const batches = [];
    const imported: GmailCursor = { ...previous, pass: "historical" };
    for await (const b of connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(imported) })) batches.push(b);
    expect(reads(mock)[0]).toBe("labels");
    expect(reads(mock)[1]).toMatch(/^messages\?/);
  });

  it("resumes an interrupted pass at the page it stopped on", async () => {
    const data = mailbox();
    data.messages = gmailMessage.many(5);
    const mock = gmailDocMock(data);
    const first = [];
    for await (const b of connector(mock, { pageSize: 2 }).historicalImport({ organizationId: TEST_ORG, cursor: null })) {
      first.push(b);
      if (first.length === 2) break;
    }
    const stopped = parseGmailCursor(first[1]!.cursor)!;
    expect(stopped).toMatchObject({ step: "messages", pageToken: expect.any(String) });
    const before = reads(mock).length;
    const rest = [];
    for await (const b of connector(mock, { pageSize: 2 }).historicalImport({ organizationId: TEST_ORG, cursor: first[1]!.cursor })) rest.push(b);
    expect(reads(mock)[before]).toBe(`messages?maxResults=2&pageToken=${stopped.pageToken}`);
    expect(rest).toHaveLength(2);
    expect(parseGmailCursor(rest.at(-1)!.cursor)!.historyId).toBe(stopped.historyId);
  });

  it("stops at Gmail's daily limit with the checkpoint where it was, and carries on from there", async () => {
    const data = mailbox();
    data.messages = gmailMessage.many(5);
    const mock = gmailDocMock(data);
    const { memory, pipeline } = testPipeline();
    let calls = 0;
    let limited = true;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input as string, init);
      if (request.method === "GET" && ++calls >= 5 && limited) return tokenAnswer({ error: { code: 403, message: "Daily Limit Exceeded", errors: [{ reason: "dailyLimitExceeded" }] } }, 403);
      return mock.fetch(request);
    };
    const stopped = await runSync({ connector: connector(mock, { fetch, pageSize: 2 }), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: async () => {} }).catch((e: unknown) => e);
    expect(stopped).toMatchObject({ name: "GmailApiError", reason: "dailyLimitExceeded" });
    expect(parseGmailCursor(await memory.getCheckpoint(TEST_ORG, "gmail", "historical"))).toMatchObject({ step: "messages", pageToken: expect.any(String) });
    limited = false;
    const resumed = await runSync({ connector: connector(mock, { fetch, pageSize: 2 }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(resumed.batches).toBe(2);
    expect(memory.events.filter((e) => e.type === "communication.message_logged")).toHaveLength(5);
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: GmailCursor = { pass: "incremental", step: "history", pageToken: "T-1", since: "2026-01-19T00:00:00.000Z", historyId: "9050", nextFrom: "2026-01-19T23:00:00.000Z" };
    expect(parseGmailCursor(JSON.stringify(good))).toEqual(good);
    expect(parseGmailCursor(null)).toBeNull();
    for (const bad of [
      { ...good, pass: "full" },
      { ...good, step: "threads" },
      { ...good, pass: "historical" },
      { ...good, historyId: null },
      { ...good, historyId: "9050 OR 1" },
      { ...good, historyId: 9050 },
      { ...good, pageToken: "a&q=from:x" },
      { ...good, pageToken: 3 },
      { ...good, since: "2026-01-19" },
      { ...good, nextFrom: "2026-13-45T00:00:00Z" },
      { ...good, since: "2026-02-30T00:00:00Z" },
      { ...good, nextFrom: "Mon, 19 Jan 2026 00:00:00 GMT" },
      { ...good, extra: true },
      (({ nextFrom: _, ...rest }) => rest)(good),
      null,
      [],
      "cursor",
    ]) {
      expect(() => parseGmailCursor(JSON.stringify(bad)), JSON.stringify(bad)).toThrow("Gmail checkpoint is not in the expected shape");
    }
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const c = connector(gmailDocMock(mailbox()));
    expect(c.writes).toBe(GMAIL_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.integration, a.action, a.outcome])).toEqual([
      ["gmail", "draft_reply", "refused"],
      ["gmail", "apply_label", "refused"],
    ]);
  });
});
