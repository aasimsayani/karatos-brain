import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  SLACK_MOCK_BOT,
  SLACK_MOCK_NOW,
  SLACK_MOCK_READ_SCOPES,
  SLACK_MOCK_TEAM,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  hmacSha256,
  slackDocMock,
  slackMessage,
  slackTs,
  slackUserId,
  tamper,
  testPipeline,
  type SlackMock,
  type SlackMockChannel,
  type SlackMockData,
  type SlackMockMessage,
} from "@karatos/connector-testkit";
import {
  SLACK_API_URL,
  SLACK_MAX_CHANNELS,
  SLACK_PACING,
  SLACK_TEXT_INPUT_MAX,
  SLACK_TEXT_KEPT_MAX,
  SLACK_WEBHOOK_TOLERANCE_S,
  SLACK_WRITES,
  SlackApiError,
  SlackConfigError,
  parseSlackCursor,
  slackClient,
  slackConnector,
  slackDistribution,
  slackNormalizer,
  slackReadUrl,
  slackScopeProblem,
  slackTextChannels,
  slackTsFrom,
  slackTsToIso,
  slackUrlVerification,
  slackWebhookEvents,
  verifySlackWebhook,
  type SlackConnectorOptions,
  type SlackCursor,
  type SlackRead,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = ["xoxb", "0".repeat(12), "0".repeat(13), "TESTtokenTESTtoken"].join("-");
const KEY = ["test", "correspondent", "key", "0".repeat(24)].join("-");
const OTHER_KEY = ["test", "correspondent", "key", "1".repeat(24)].join("-");
const SIGNING = ["test", "signing", "secret"].join("-");
const NOW = () => new Date(SLACK_MOCK_NOW);
const NOW_MS = Date.parse(SLACK_MOCK_NOW);
const RECEIVED = new Date(SLACK_MOCK_NOW).toISOString();
const HOUR = 3600;
const DAY = 24 * HOUR;
const YEAR = 365.25 * DAY;

const REPAIRS = "C0TEST0001";
const GENERAL = "C0TEST0002";
const CUSTOM = "G0TEST0003";
const ARCHIVED = "C0TEST0004";
const SECRET_ROOM = "G0TEST0005";

const msg = (overrides: Partial<SlackMockMessage> = {}) => slackMessage.one(overrides);
const channel = (id: string, name: string, extra: Partial<SlackMockChannel> = {}): SlackMockChannel => ({
  id,
  name,
  is_private: id.startsWith("G"),
  is_member: true,
  is_archived: false,
  created: Math.floor(NOW_MS / 1000) - 3 * Math.floor(YEAR),
  num_members: 4,
  messages: [],
  ...extra,
});

/** A synthetic workspace: two channels and a private one the bot is in, one it isn't, an archived one and a private one it can't see. */
function workspace(overrides: Partial<SlackMockData> = {}): SlackMockData {
  slackMessage.reset();
  const parent = msg({ reply_count: 2, latest_reply: slackTs(30 * 60, 3), reactions: [{ name: "gem", count: 2, users: [slackUserId(2), slackUserId(3)] }], files: [{ id: "F0TEST0001", name: "ring-photo.jpg", title: "Synthetic ring photo", url_private: "https://files.slack.com/files-pri/T0TEST0001-F0TEST0001/ring-photo.jpg" }] });
  parent.thread_ts = parent.ts;
  const bot = msg({ bot_id: "B0TEST0002", subtype: "bot_message", text: "Synthetic alert" });
  delete bot.user;
  const join = msg({ subtype: "channel_join", text: `<@${slackUserId(3)}> has joined the channel` });
  const edited = msg({ edited: { user: slackUserId(4), ts: slackTs(10 * 60, 4) } });
  const old = msg({ ts: slackTs(Math.floor(6 * YEAR), 5) });
  const replyA = msg({ ts: slackTs(2 * 60 * 60 - 60, 6), thread_ts: parent.ts, user: slackUserId(2), text: `Thanks <@${slackUserId(1)}>, ready Friday` });
  const replyB = msg({ ts: slackTs(30 * 60, 3), thread_ts: parent.ts, user: slackUserId(3), text: "Synthetic reply" });
  const custom = msg({ text: "Synthetic sketch approved" });
  return {
    token: TOKEN,
    channels: [
      channel(REPAIRS, "repairs", { messages: [parent, bot, join, edited, old], replies: { [parent.ts]: [replyA, replyB] } }),
      channel(GENERAL, "general", { is_member: false, messages: [msg()] }),
      channel(CUSTOM, "custom-orders", { messages: [custom] }),
      channel(ARCHIVED, "order-20417", { is_archived: true }),
      channel(SECRET_ROOM, "owners", { is_member: false, messages: [msg()] }),
    ],
    ...overrides,
  };
}

const options = (mock: SlackMock, extra: Partial<SlackConnectorOptions> = {}): SlackConnectorOptions => ({
  token: TOKEN,
  correspondentKey: KEY,
  fetch: mock.fetch,
  sleep: async () => {},
  now: NOW,
  clock: () => NOW_MS,
  ...extra,
});
const connector = (mock: SlackMock, extra: Partial<SlackConnectorOptions> = {}) => slackConnector(options(mock, extra));
const calls = (mock: SlackMock) => mock.fetch.calls.map((c) => `${c.method} ${decodeURIComponent(c.url.replace(`${SLACK_API_URL}/`, ""))}`);
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const answer = (body: object, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const person = (key: string, id: string) => `slack_user:${createHmac("sha256", key).update(`karatos:correspondent:v1:slack:${id}`).digest("hex").slice(0, 32)}`;
const HISTORY = (channel = REPAIRS): Extract<SlackRead, { method: "conversations.history" }> => ({ method: "conversations.history", channel, oldest: "0" });
const normalize = slackNormalizer({ correspondentKey: KEY });
const withText = slackNormalizer({ correspondentKey: KEY, textChannels: "all" });
const AUTH_OK = { ok: true, team_id: SLACK_MOCK_TEAM, user_id: "U0TESTBOT1", bot_id: SLACK_MOCK_BOT };
const scopesHeader = { "x-oauth-scopes": SLACK_MOCK_READ_SCOPES.join(",") };
/** A fetch that answers auth.test correctly and everything else with `rest`. */
const afterAuth = (rest: () => Response): typeof globalThis.fetch => async (input) => (String(input).endsWith("/auth.test") ? answer(AUTH_OK, 200, scopesHeader) : rest());

describe("Slack client", () => {
  it("takes a bot token only, naming the setting but never its value", () => {
    const base = options(slackDocMock(workspace()));
    expect(() => slackClient({ ...base, token: " " })).toThrow(new SlackConfigError("set SLACK_BOT_TOKEN"));
    for (const prefix of ["xoxp", "xoxa", "xoxe", "xoxr"]) {
      const other = [prefix, "0".repeat(12), "TESTtokenTESTtoken"].join("-");
      const error = (() => {
        try {
          slackClient({ ...base, token: other });
        } catch (e) {
          return e as Error;
        }
      })()!;
      expect(error.message, prefix).toContain("must be the app's bot token (xoxb-)");
      expect(error.message).not.toContain(other);
    }
    expect(() => slackClient({ ...base, token: "xoxb-short" })).toThrow("isn't a Slack bot token");
    expect(() => slackClient({ ...base, token: `${TOKEN}\nx` })).toThrow("isn't a Slack bot token");
    expect(() => slackClient({ ...base, distribution: "public" as never })).toThrow("distribution must be internal or non_marketplace");
    expect(() => slackClient({ ...base, token: ` ${TOKEN} ` })).not.toThrow();
  });

  it("reads SLACK_APP_DISTRIBUTION as internal unless it says non_marketplace", () => {
    expect(slackDistribution(undefined)).toBe("internal");
    expect(slackDistribution(" ")).toBe("internal");
    expect(slackDistribution("internal")).toBe("internal");
    expect(slackDistribution("non_marketplace")).toBe("non_marketplace");
    expect(() => slackDistribution("marketplace")).toThrow("SLACK_APP_DISTRIBUTION must be internal or non_marketplace");
  });

  it("allows only its three reads, with checked arguments, and never a write", async () => {
    const mock = slackDocMock(workspace());
    const client = slackClient(options(mock));
    const refused: unknown[] = [
      { method: "chat.postMessage", channel: REPAIRS, text: "x" },
      { method: "chat.update", channel: REPAIRS, ts: slackTs(1) },
      { method: "chat.delete", channel: REPAIRS, ts: slackTs(1) },
      { method: "conversations.join", channel: GENERAL },
      { method: "conversations.invite", channel: REPAIRS },
      { method: "reactions.add" },
      { method: "files.upload" },
      { method: "files.info", file: "F1" },
      { method: "users.info", user: slackUserId(1) },
      { method: "users.list" },
      { method: "auth.test" },
      { method: "conversations.list", types: ["im"] },
      { method: "conversations.list", types: ["mpim", "public_channel"] },
      { method: "conversations.list", types: [] },
      { method: "conversations.list", types: ["public_channel", "public_channel"] },
      { method: "conversations.list", types: "public_channel" },
      { method: "conversations.list", types: ["public_channel"], limit: 201 },
      { method: "conversations.list", types: ["public_channel"], limit: 0 },
      { method: "conversations.list", types: ["public_channel"], cursor: "abc&token=x" },
      { method: "conversations.list", types: ["public_channel"], exclude_archived: true },
      { ...HISTORY(), latest: slackTs(1) },
      { ...HISTORY(), include_all_metadata: true },
      { ...HISTORY(), inclusive: true },
      { ...HISTORY("D0TEST0001") },
      { ...HISTORY("c0test0001") },
      { ...HISTORY("C0TEST0001&x=1") },
      { ...HISTORY(), oldest: "yesterday" },
      { ...HISTORY(), oldest: undefined },
      { ...HISTORY(), limit: SLACK_PACING.internal.historyPage + 1 },
      { ...HISTORY(), limit: 1.5 },
      { ...HISTORY(), cursor: 7 },
      { method: "conversations.replies", channel: REPAIRS },
      { method: "conversations.replies", channel: REPAIRS, ts: "1.2" },
      { method: "conversations.replies", channel: REPAIRS, ts: slackTs(1), oldest: "now" },
      null,
    ];
    for (const request of refused) {
      await expect(client.read(request as SlackRead), JSON.stringify(request)).rejects.toThrow(SlackConfigError);
    }
    // Nothing above reached Slack, not even auth.test.
    expect(mock.fetch.calls).toEqual([]);
    expect(slackReadUrl({ method: "conversations.list", types: ["public_channel", "private_channel"], limit: 200, cursor: "dGVhbTpDMDYx=" })).toBe(
      `${SLACK_API_URL}/conversations.list?types=public_channel%2Cprivate_channel&limit=200&cursor=dGVhbTpDMDYx%3D`,
    );
    expect(slackReadUrl({ ...HISTORY(), oldest: "1611100800.000000", limit: 200 })).toBe(`${SLACK_API_URL}/conversations.history?channel=C0TEST0001&oldest=1611100800.000000&limit=200`);
    expect(slackReadUrl({ method: "conversations.replies", channel: REPAIRS, ts: slackTs(1), oldest: slackTs(2), limit: 15 }, 15)).toBe(
      `${SLACK_API_URL}/conversations.replies?channel=C0TEST0001&ts=${slackTs(1)}&oldest=${slackTs(2)}&limit=15`,
    );
    expect(() => slackReadUrl({ ...HISTORY(), limit: 16 }, 15)).toThrow("limit must be a whole number from 1 to 15");
  });

  it("checks the token with auth.test once, then gets with the token in the header, never in the URL", async () => {
    const mock = slackDocMock(workspace());
    const seen: { method: string; url: string; auth: string | null }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input as string, init);
      seen.push({ method: request.method, url: request.url, auth: request.headers.get("authorization") });
      return mock.fetch(request);
    };
    const client = slackClient(options(mock, { fetch }));
    await Promise.all([client.read(HISTORY()), client.read(HISTORY(CUSTOM))]);
    await client.read({ method: "conversations.list", types: ["public_channel"] });
    expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([
      `POST ${SLACK_API_URL}/auth.test`,
      `GET ${SLACK_API_URL}/conversations.history`,
      `GET ${SLACK_API_URL}/conversations.history`,
      `GET ${SLACK_API_URL}/conversations.list`,
    ]);
    for (const s of seen) {
      expect(s.auth).toBe(`Bearer ${TOKEN}`);
      expect(s.url).not.toContain(TOKEN);
      expect(new URL(s.url).searchParams.has("token")).toBe(false);
    }
    expect(await client.identity()).toEqual({ teamId: SLACK_MOCK_TEAM, botUserId: "U0TESTBOT1", scopes: SLACK_MOCK_READ_SCOPES, privateChannels: true });
  });

  it("won't use an app holding any write scope or anything beyond its read scopes", async () => {
    for (const extra of ["chat:write", "chat:write.public", "chat:write.customize", "channels:manage", "channels:join", "groups:write", "files:read", "files:write", "users:read", "users:read.email", "im:history", "mpim:history", "reactions:write", "pins:write", "admin", "incoming-webhook", "commands"]) {
      const mock = slackDocMock(workspace({ scopes: [...SLACK_MOCK_READ_SCOPES, extra] }));
      const error = await failure(slackClient(options(mock)).read(HISTORY()));
      expect(error, extra).toBeInstanceOf(SlackConfigError);
      expect(error.message).toContain(`more than read access (${extra})`);
      expect(error.message).toContain("reinstall it with only channels:read, channels:history, groups:read, groups:history");
      // auth.test is the only thing sent: no history was read.
      expect(calls(mock), extra).toEqual(["POST auth.test"]);
    }
  });

  it("stops if Slack doesn't say which scopes the token holds, or the read scopes are incomplete", async () => {
    const hidden = slackDocMock(workspace({ hideScopes: true }));
    await expect(slackClient(options(hidden)).read(HISTORY())).rejects.toThrow("Slack didn't say which scopes the token holds");
    expect(calls(hidden)).toEqual(["POST auth.test"]);
    const half = slackDocMock(workspace({ scopes: ["channels:read", "channels:history", "groups:read"] }));
    await expect(slackClient(options(half)).read(HISTORY())).rejects.toThrow("groups:read and groups:history go together");
    const publicOnly = slackDocMock(workspace({ scopes: ["channels:history", "channels:read"] }));
    expect(await slackClient(options(publicOnly)).identity()).toMatchObject({ privateChannels: false });
  });

  it("tells read-only scopes from anything more", () => {
    expect(slackScopeProblem("channels:read,channels:history")).toBeNull();
    expect(slackScopeProblem(" channels:history , channels:read,groups:history,groups:read ")).toBeNull();
    expect(slackScopeProblem("channels:read")).toBe("the Slack app doesn't hold channels:history");
    expect(slackScopeProblem("groups:read,groups:history")).toBe("the Slack app doesn't hold channels:read and channels:history");
    expect(slackScopeProblem("channels:read,channels:history,groups:history")).toContain("go together");
    expect(slackScopeProblem("channels:read,channels:history,chat:write")).toBe("the Slack app holds more than read access (chat:write)");
    expect(slackScopeProblem("channels:read channels:history")).toContain("more than read access");
    for (const missing of [undefined, null, "", " ", ["channels:read"]]) expect(slackScopeProblem(missing)).toBe("Slack didn't say which scopes the token holds");
  });

  it("stops mid-sync if a later answer shows the app was given more", async () => {
    const mock = slackDocMock(workspace());
    let reads = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await mock.fetch(input as string, init);
      if (String(input).endsWith("/auth.test") || ++reads < 2) return response;
      return answer(await response.json(), 200, { "x-oauth-scopes": [...SLACK_MOCK_READ_SCOPES, "chat:write"].join(",") });
    };
    const client = slackClient(options(mock, { fetch }));
    await client.read(HISTORY());
    await expect(client.read(HISTORY())).rejects.toThrow("more than read access (chat:write)");
  });

  it("refuses a token auth.test doesn't name a bot for, or that names no workspace", async () => {
    const user = slackDocMock(workspace({ userToken: true }));
    await expect(slackClient(options(user)).read(HISTORY())).rejects.toThrow("auth.test names no bot");
    const nameless = afterAuth(() => answer({}));
    const odd: typeof globalThis.fetch = async (input, init) => (String(input).endsWith("/auth.test") ? answer({ ...AUTH_OK, team_id: "nope" }, 200, scopesHeader) : nameless(input, init));
    await expect(slackClient(options(slackDocMock(workspace()), { fetch: odd })).identity()).rejects.toThrow("didn't name the workspace and bot user");
  });

  it("tries auth.test again on the next read after it failed", async () => {
    const mock = slackDocMock(workspace());
    let first = true;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (first) {
        first = false;
        return new Response("", { status: 503 });
      }
      return mock.fetch(input as string, init);
    };
    const client = slackClient(options(mock, { fetch }));
    await expect(client.read(HISTORY())).rejects.toThrow(/^Slack answered HTTP 503$/);
    await expect(client.read(HISTORY())).resolves.toMatchObject({ ok: true });
  });

  it("answers null for a channel or thread the bot can't read, so the sync moves on", async () => {
    const client = slackClient(options(slackDocMock(workspace())));
    expect(await client.read(HISTORY(GENERAL))).toBeNull();
    expect(await client.read(HISTORY(SECRET_ROOM))).toBeNull();
    expect(await client.read(HISTORY("C0NOPE0001"))).toBeNull();
    expect(await client.read({ method: "conversations.replies", channel: REPAIRS, ts: slackTs(1, 99) })).toBeNull();
  });

  it("explains a refused token or a missing scope, and cuts unknown error codes short", async () => {
    const wrong = slackClient(options(slackDocMock({ ...workspace(), token: `${TOKEN}x` })));
    const error = await failure(wrong.read(HISTORY()));
    expect(error).toMatchObject({ name: "SlackApiError", code: "invalid_auth", message: "Slack refused the bot token (invalid_auth); reinstall the app and set a new SLACK_BOT_TOKEN" });
    expect(error.message).not.toContain(TOKEN);
    const mock = slackDocMock(workspace());
    const client = slackClient(options(mock));
    await client.read(HISTORY());
    mock.revoke();
    await expect(client.read(HISTORY())).rejects.toMatchObject({ code: "token_revoked" });
    const missing = afterAuth(() => answer({ ok: false, error: "missing_scope", needed: "groups:history", provided: "channels:read" }));
    await expect(slackClient(options(mock, { fetch: missing })).read(HISTORY())).rejects.toThrow(new SlackConfigError("the Slack app is missing a scope conversations.history needs (needs groups:history)"));
    const vague = afterAuth(() => answer({ ok: false, error: "missing_scope", needed: "<script>" }));
    await expect(slackClient(options(mock, { fetch: vague })).read(HISTORY())).rejects.toThrow(/needs$/);
    const odd = afterAuth(() => answer({ ok: false, error: "Something <b>odd</b>" }));
    await expect(slackClient(options(mock, { fetch: odd })).read(HISTORY())).rejects.toThrow("Slack answered unknown_error to conversations.history");
    const noCode = afterAuth(() => answer({ ok: false }));
    await expect(slackClient(options(mock, { fetch: noCode })).read(HISTORY())).rejects.toMatchObject({ code: "unknown_error" });
    const other = afterAuth(() => answer({ ok: false, error: "invalid_cursor" }));
    await expect(slackClient(options(mock, { fetch: other })).read(HISTORY())).rejects.toMatchObject({ name: "SlackApiError", code: "invalid_cursor" });
    const server = afterAuth(() => answer({ ok: false, error: "fatal_error" }, 500));
    await expect(slackClient(options(mock, { fetch: server })).read(HISTORY())).rejects.toThrow("Slack answered HTTP 500: fatal_error");
    const text = afterAuth(() => new Response("ok", { status: 200 }));
    await expect(slackClient(options(mock, { fetch: text })).read(HISTORY())).rejects.toThrow("Slack did not answer with JSON");
    const authFail: typeof globalThis.fetch = async () => answer({ ok: false, error: "account_inactive" });
    await expect(slackClient(options(mock, { fetch: authFail })).identity()).rejects.toMatchObject({ code: "account_inactive" });
  });

  it("waits out 429s for their Retry-After, up to five minutes, then gives up to the sync", async () => {
    const waits: number[] = [];
    const mock = slackDocMock(workspace({ rateLimits: [{}, { retryAfter: 3 }, { retryAfter: 61 }, { retryAfter: 9999 }] }));
    const client = slackClient(options(mock, { sleep: async (ms) => void waits.push(ms) }));
    await expect(client.read(HISTORY())).resolves.toMatchObject({ ok: true });
    // auth.test takes the first 429 and waits a second; the read then takes the rest.
    expect(waits.filter((w) => w >= 1000)).toEqual([1000, 3000, 61_000, 300_000]);
    const limited = slackDocMock(workspace({ rateLimits: Array.from({ length: 8 }, () => ({ retryAfter: 1 })) }));
    const error = await failure(slackClient(options(limited, { rateLimitRetries: 2 })).read(HISTORY()));
    expect(error).toMatchObject({ name: "SlackApiError", status: 429, code: "ratelimited" });
    expect(error.message).toContain("resumes from the checkpoint");
    // ratelimited in an HTTP 200 answer is waited out too.
    let first = true;
    const soft = afterAuth(() => {
      if (first) {
        first = false;
        return answer({ ok: false, error: "ratelimited" });
      }
      return answer({ ok: true, messages: [] });
    });
    await expect(slackClient(options(mock, { fetch: soft })).read(HISTORY())).resolves.toMatchObject({ ok: true });
  });

  it("paces each method under its tier, and history at one a minute for a non-Marketplace app", async () => {
    const waits: number[] = [];
    const internal = slackClient(options(slackDocMock(workspace()), { sleep: async (ms) => void waits.push(ms) }));
    await internal.read(HISTORY());
    await internal.read(HISTORY());
    await internal.read({ method: "conversations.list", types: ["public_channel"] });
    await internal.read({ method: "conversations.list", types: ["public_channel"] });
    await internal.read({ method: "conversations.replies", channel: REPAIRS, ts: slackTs(HOUR, 1) });
    // 45 a minute for history and replies (Tier 3 is 50+), 18 for the list (Tier 2 is 20+), each on its own clock.
    expect(waits.map(Math.round)).toEqual([Math.round(60_000 / 45), Math.round(60_000 / 18)]);
    const slow: number[] = [];
    const unlisted = slackClient(options(slackDocMock(workspace({ distribution: "non_marketplace" })), { distribution: "non_marketplace", sleep: async (ms) => void slow.push(ms) }));
    await unlisted.read(HISTORY());
    await unlisted.read({ method: "conversations.replies", channel: REPAIRS, ts: slackTs(HOUR, 1) });
    await unlisted.read(HISTORY());
    expect(slow).toEqual([60_000]);
    await expect(unlisted.read({ ...HISTORY(), limit: 16 })).rejects.toThrow("from 1 to 15");
  });

  it("is answered by a mock that pages, filters by membership and scope, and refuses what the docs refuse", async () => {
    const mock = slackDocMock(workspace());
    const get = (path: string, token = TOKEN) => mock.fetch(`${SLACK_API_URL}/${path}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json() as Promise<Record<string, unknown>>);
    expect(await get("conversations.list?types=im,bogus")).toMatchObject({ ok: false, error: "invalid_types" });
    expect(await get("conversations.list?limit=1000")).toMatchObject({ ok: false, error: "invalid_limit" });
    expect(await get("conversations.list?cursor=nonsense")).toMatchObject({ ok: false, error: "invalid_cursor" });
    expect(await get("conversations.history?channel=C0TEST0001&limit=0")).toMatchObject({ ok: false, error: "invalid_limit" });
    const listed = (await get("conversations.list")) as { channels: { id: string }[] };
    expect(listed.channels.map((c) => c.id)).toEqual([REPAIRS, GENERAL, ARCHIVED]);
    const pageOne = (await get("conversations.history?channel=C0TEST0001&limit=2")) as { messages: { ts: string }[]; has_more: boolean; response_metadata: { next_cursor: string } };
    expect(pageOne.has_more).toBe(true);
    const pageTwo = (await get(`conversations.history?channel=C0TEST0001&limit=2&cursor=${encodeURIComponent(pageOne.response_metadata.next_cursor)}`)) as { messages: { ts: string }[] };
    expect(Number(pageOne.messages[1]!.ts)).toBeGreaterThan(Number(pageTwo.messages[0]!.ts));
    expect(await get("conversations.history?channel=C0TEST0001", "other")).toMatchObject({ ok: false, error: "invalid_auth" });
    const noPrivate = slackDocMock(workspace({ scopes: ["channels:read", "channels:history"] }));
    const privateGet = (path: string) => noPrivate.fetch(`${SLACK_API_URL}/${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
    expect(await privateGet("conversations.list?types=private_channel")).toMatchObject({ error: "missing_scope" });
    expect(await privateGet(`conversations.history?channel=${CUSTOM}`)).toMatchObject({ error: "missing_scope", needed: "groups:history" });
    const noRead = slackDocMock(workspace({ scopes: ["channels:history"] }));
    expect(await (await noRead.fetch(`${SLACK_API_URL}/conversations.list`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).toMatchObject({ error: "missing_scope" });
    // A write isn't in the docs this mock was built from, so it can't be answered.
    await expect(mock.fetch(`${SLACK_API_URL}/chat.postMessage`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).rejects.toThrow(/not in the vendor's docs/);
  });
});

describe("Slack normalization", () => {
  const repairs = () => workspace().channels[0]!;

  it("keeps who, when, where, the thread and counts, and no text, files or names by default", () => {
    const events = repairs().messages.flatMap((m) => normalize.messageEvents(REPAIRS, m, RECEIVED));
    expect(events.map((e) => e.payload.kind)).toEqual(["message", "bot_message", "message", "message"]);
    // The join notice is skipped; the six-year-old message is the sync's to leave out, by its oldest.
    const text = JSON.stringify(events);
    for (const personal of ["Synthetic", "Test Customer", "@", "555", "ring-photo", "Synthetic ring photo", "files.slack.com", "gem", "rich_text", slackUserId(1), slackUserId(2), slackUserId(4)]) {
      expect(text, personal).not.toContain(personal);
    }
    const [parent, bot, edited] = events;
    const parentTs = slackTs(HOUR, 1);
    expect(parent).toEqual({
      id: `slack_message:${REPAIRS}:${parentTs}:${parent!.idempotencyKey.slice(-16)}`,
      type: "communication.message_logged",
      occurredAt: slackTsToIso(parentTs),
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(new RegExp(`^slack:message:${REPAIRS}:${parentTs.replace(".", "\\.")}:[0-9a-f]{16}$`)),
      payload: {
        channel: "slack",
        conversationId: `slack:channel:${REPAIRS}`,
        messageId: `slack:message:${REPAIRS}:${parentTs}`,
        threadId: `slack:thread:${REPAIRS}:${parentTs}`,
        isReply: false,
        sentAt: slackTsToIso(parentTs),
        author: person(KEY, slackUserId(1)),
        authorKind: "person",
        kind: "message",
        replyCount: 2,
        fileCount: 1,
        reactionCount: 2,
        textWithheld: true,
      },
    });
    expect(bot!.payload).toMatchObject({ author: "slack_bot:B0TEST0002", authorKind: "bot", fileCount: 0, reactionCount: 0 });
    expect(edited!.payload).toMatchObject({ edited: true });
  });

  it("keeps text only for the channels listed, with people, contact details, numbers and link paths taken out", () => {
    const some = slackNormalizer({ correspondentKey: KEY, textChannels: [CUSTOM] });
    expect(some.messageEvents(REPAIRS, repairs().messages[0]!, RECEIVED)[0]!.payload).toMatchObject({ textWithheld: true });
    expect(some.messageEvents(CUSTOM, repairs().messages[0]!, RECEIVED)[0]!.payload).not.toHaveProperty("textWithheld");
    const text = (raw: string) => withText.redact(raw).text;
    expect(text(repairs().messages[0]!.text)).toBe("Synthetic note 1: Test Customer 1 picked up the ring, call [number] or write [email]");
    expect(text(`Thanks <@${slackUserId(1)}> and <@${slackUserId(2)}|Test Customer 2>`)).toBe(`Thanks <@${person(KEY, slackUserId(1))}> and <@${person(KEY, slackUserId(2))}>`);
    expect(text("<mailto:customer1@example.test|customer1@example.test> or <tel:+12125550101|212 555 0101>")).toBe("[email] or [number]");
    expect(text("See <https://vendor.test/orders/TEST-20417?customer=1|the order> and <http://%zz>")).toBe("See [link: vendor.test] and [link]");
    expect(text("<https://[bad|x> <ftp://vendor.test> <#C0TEST0003|custom-orders> <#nope> <!here> <!subteam^S0TEST|@team> <!date^1|x>")).toBe("[link] [link] <#C0TEST0003> [channel] <!here> [mention] [mention]");
    expect(text("<@nope> customer.one+ring@example.test (212) 555-0101 +1 212 555 0101 4111 1111 1111 1111")).toBe("[mention] [email] ([number] [number] [number]");
    // Dates, prices, sizes and short numbers stay readable.
    expect(text("Ready 2026-01-22, size 7, $1,250.00, ticket 4417, 14k")).toBe("Ready 2026-01-22, size 7, $1,250.00, ticket 4417, 14k");
    const [kept] = withText.messageEvents(REPAIRS, repairs().messages[0]!, RECEIVED);
    expect(kept!.payload).toMatchObject({ text: expect.stringContaining("[email]") });
    expect(kept!.payload).not.toHaveProperty("textWithheld");
    // Whether text is kept is part of the version, so turning it on stores each message again with its text.
    expect(kept!.idempotencyKey).not.toBe(normalize.messageEvents(REPAIRS, repairs().messages[0]!, RECEIVED)[0]!.idempotencyKey);
  });

  it("redacts hostile text in linear time and cuts long text", () => {
    const hostile = [
      "<".repeat(100_000),
      "<" + "a".repeat(299) + "|" + "b".repeat(100_000),
      "a".repeat(100_000) + "@",
      "a@" + "b-".repeat(50_000),
      "1 ".repeat(50_000),
      "1(-".repeat(50_000),
      "+1".repeat(50_000),
      "a.".repeat(50_000) + "@x",
      ("x".repeat(63) + ".").repeat(2000),
    ];
    const started = performance.now();
    for (const h of hostile) withText.redact(h);
    expect(performance.now() - started).toBeLessThan(1000);
    // A huge message is cut before any pattern sees it, so it costs no more than a 12,000-character one.
    const huge = performance.now();
    withText.redact("a1.".repeat(2_000_000));
    expect(performance.now() - huge).toBeLessThan(300);
    const long = withText.redact("word ".repeat(SLACK_TEXT_INPUT_MAX));
    expect(long.text.length).toBe(SLACK_TEXT_KEPT_MAX);
    expect(long.truncated).toBe(true);
    // Text past the input cap never reaches a pattern, so nothing after it is kept.
    const late = withText.redact("x".repeat(SLACK_TEXT_INPUT_MAX) + " customer1@example.test");
    expect(late.text).not.toContain("@");
    expect(withText.redact("short").truncated).toBe(false);
    const [event] = withText.messageEvents(REPAIRS, { ts: slackTs(1), user: slackUserId(1), text: "y".repeat(5000) }, RECEIVED);
    expect(event!.payload).toMatchObject({ textTruncated: true });
  });

  it("keys people with this instance's key, so another key or a plain hash can't match them", () => {
    const mine = normalize.person(slackUserId(1));
    expect(mine).toBe(person(KEY, slackUserId(1)));
    expect(slackNormalizer({ correspondentKey: OTHER_KEY }).person(slackUserId(1))).not.toBe(mine);
    expect(mine).not.toContain(createHash("sha256").update(slackUserId(1)).digest("hex").slice(0, 32));
    expect(mine).not.toContain(createHash("sha256").update(`karatos:correspondent:v1:slack:${slackUserId(1)}`).digest("hex").slice(0, 32));
    expect(normalize.person(slackUserId(2))).not.toBe(mine);
    expect(() => slackNormalizer({ correspondentKey: "short" })).toThrow("set CORRESPONDENT_HASH_KEY to at least 32 characters");
    expect(() => slackNormalizer({ correspondentKey: undefined as unknown as string })).toThrow(/CORRESPONDENT_HASH_KEY/);
  });

  it("skips channel notices and messages with no usable timestamp, and versions edits", () => {
    for (const subtype of ["channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "channel_archive", "pinned_item", "message_changed", "message_deleted", "tombstone", 7]) {
      expect(normalize.messageEvents(REPAIRS, { ts: slackTs(1), user: slackUserId(1), subtype }, RECEIVED), String(subtype)).toEqual([]);
    }
    for (const subtype of ["thread_broadcast", "file_share", "me_message"]) expect(normalize.messageEvents(REPAIRS, { ts: slackTs(1), user: slackUserId(1), subtype }, RECEIVED)).toHaveLength(1);
    for (const ts of [undefined, "", "1.2", "now", 1768867200, "1768867200"]) expect(normalize.messageEvents(REPAIRS, { ts, user: slackUserId(1) }, RECEIVED)).toEqual([]);
    expect(normalize.messageEvents("D0TEST0001", { ts: slackTs(1) }, RECEIVED)).toEqual([]);
    expect(normalize.messageEvents(REPAIRS, null as never, RECEIVED)).toEqual([]);
    const key = (edited?: { ts?: unknown }) => normalize.messageEvents(REPAIRS, { ts: slackTs(1), user: slackUserId(1), ...(edited ? { edited } : {}) }, RECEIVED)[0]!.idempotencyKey;
    expect(key()).toBe(key({ ts: "later" }));
    expect(key({ ts: slackTs(0, 1) })).not.toBe(key());
    expect(key({ ts: slackTs(0, 1) })).not.toBe(key({ ts: slackTs(0, 2) }));
    const unknown = normalize.messageEvents(REPAIRS, { ts: slackTs(1), user: "someone", bot_id: "nope", reply_count: -1, reactions: [{ count: "2" }, null, { count: 3 }], files: "x" }, RECEIVED)[0]!;
    expect(unknown.payload).toMatchObject({ authorKind: "unknown", reactionCount: 3, fileCount: 0 });
    expect(unknown.payload).not.toHaveProperty("author");
    expect(unknown.payload).not.toHaveProperty("replyCount");
    const reply = normalize.messageEvents(REPAIRS, { ts: slackTs(1), thread_ts: slackTs(2), user: slackUserId(1) }, RECEIVED)[0]!;
    expect(reply.payload).toMatchObject({ isReply: true, threadId: `slack:thread:${REPAIRS}:${slackTs(2)}` });
  });

  it("lists only channels the bot is in, withholding names that look like an order or phone number", () => {
    const events = withText.channelEvents([...workspace().channels, { id: "bad id", is_member: true }, null, { id: "C0TEST0009", is_member: true }], RECEIVED);
    expect(events.map((e) => [e.payload.conversationId, e.payload.kind, e.payload.name ?? null, e.payload.archived])).toEqual([
      [`slack:channel:${REPAIRS}`, "public", "repairs", false],
      [`slack:channel:${CUSTOM}`, "private", "custom-orders", false],
      [`slack:channel:${ARCHIVED}`, "public", null, true],
      ["slack:channel:C0TEST0009", "public", null, false],
    ]);
    expect(events[0]).toMatchObject({ type: "communication.channel_updated", occurredAt: RECEIVED, payload: { memberCount: 4, textKept: true, createdAt: expect.stringMatching(/^2023-/) } });
    expect(events[2]!.payload).toMatchObject({ nameWithheld: true });
    const renamed = normalize.channelEvents([{ ...workspace().channels[0]!, name: "repairs-desk" }], RECEIVED)[0]!;
    expect(renamed.idempotencyKey).not.toBe(normalize.channelEvents([workspace().channels[0]!], RECEIVED)[0]!.idempotencyKey);
    expect(JSON.stringify(events)).not.toContain("Synthetic");
    expect(normalize.channelEvents("nope", RECEIVED)).toEqual([]);
  });

  it("records a deletion once, and only for a real message", () => {
    expect(normalize.deletedEvent(REPAIRS, slackTs(1), RECEIVED)).toEqual([
      { id: `slack_message:${REPAIRS}:${slackTs(1)}:deleted`, type: "communication.message_deleted", occurredAt: RECEIVED, receivedAt: RECEIVED, idempotencyKey: `slack:message:${REPAIRS}:${slackTs(1)}:deleted`, payload: { channel: "slack", conversationId: `slack:channel:${REPAIRS}`, messageId: `slack:message:${REPAIRS}:${slackTs(1)}` } },
    ]);
    expect(normalize.deletedEvent(REPAIRS, "1.2", RECEIVED)).toEqual([]);
    expect(normalize.deletedEvent("x", slackTs(1), RECEIVED)).toEqual([]);
  });

  it("reads SLACK_TEXT_CHANNELS and converts Slack timestamps", () => {
    expect(slackTextChannels(undefined)).toBe("none");
    expect(slackTextChannels(" none ")).toBe("none");
    expect(slackTextChannels("all")).toBe("all");
    expect(slackTextChannels(`${REPAIRS}, ${CUSTOM},${REPAIRS}`)).toEqual([REPAIRS, CUSTOM]);
    for (const bad of ["repairs", "C0TEST0001;G1", ",", "c0test0001", Array.from({ length: 501 }, (_, i) => `C0${i}AAA`).join(",")]) {
      expect(() => slackTextChannels(bad), bad.slice(0, 20)).toThrow("SLACK_TEXT_CHANNELS must be none, all, or channel ids");
    }
    expect(slackTsToIso("1768867200.123456")).toBe("2026-01-20T00:00:00.123Z");
    expect(slackTsFrom(Date.parse("2026-01-20T00:00:00.123Z"))).toBe("1768867200.123000");
  });

  it("uses synthetic fixtures only", () => {
    expect(() => assertSynthetic(workspace())).not.toThrow();
  });
});

describe("Slack sync", () => {
  it("imports, replays, resumes and retries the mocked workspace", async () => {
    // 3 channels the bot is in; 3 messages, 2 replies and 1 private-channel message. A join notice and a 6-year-old message are left out.
    const result = await checkConnectorSync({ makeConnector: () => connector(slackDocMock(workspace())), expected: { ingested: 9 } });
    expect(result.full.batches).toBe(4);
    expect(parseSlackCursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done", channels: [REPAIRS, CUSTOM, ARCHIVED], index: 3 });
  });

  it("lists channels, reads each one's history five years back and each thread's replies, and sends nothing else", async () => {
    const mock = slackDocMock(workspace());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const fiveYears = slackTsFrom(Date.parse("2021-01-20T00:00:00Z"));
    expect(calls(mock)).toEqual([
      "POST auth.test",
      "GET conversations.list?types=public_channel,private_channel&limit=200",
      `GET conversations.history?channel=${REPAIRS}&oldest=${fiveYears}&limit=200`,
      `GET conversations.replies?channel=${REPAIRS}&ts=${slackTs(HOUR, 1)}&limit=200`,
      `GET conversations.history?channel=${CUSTOM}&oldest=${fiveYears}&limit=200`,
      `GET conversations.history?channel=${ARCHIVED}&oldest=${fiveYears}&limit=200`,
    ]);
    const stored = JSON.stringify(memory.events);
    for (const personal of ["Synthetic", "Test Customer", "@example", "555", "ring-photo", slackUserId(1)]) expect(stored, personal).not.toContain(personal);
    const replies = memory.events.filter((e) => (e.payload as { isReply?: boolean }).isReply);
    expect(replies).toHaveLength(2);
  });

  it("reads public channels only when the app can't read private ones", async () => {
    const mock = slackDocMock(workspace({ scopes: ["channels:read", "channels:history"] }));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(calls(mock)[1]).toBe("GET conversations.list?types=public_channel&limit=200");
    expect(report.ingested).toBe(2 + 5);
  });

  it("pages through channel lists, history and threads until Slack says there's no more", async () => {
    const data = workspace();
    slackMessage.reset();
    const many = Array.from({ length: 7 }, (_, i) => msg({ ts: slackTs((i + 1) * 60, i + 1) }));
    const parent = many[0]!;
    parent.thread_ts = parent.ts;
    parent.reply_count = 5;
    data.channels = [
      channel(REPAIRS, "repairs", { messages: many, replies: { [parent.ts]: Array.from({ length: 5 }, (_, i) => msg({ ts: slackTs(30 - i, 100 + i), thread_ts: parent.ts })) } }),
      ...Array.from({ length: 4 }, (_, i) => channel(`C0LIST000${i}`, `list-${i}`, { is_member: i % 2 === 0 })),
    ];
    const mock = slackDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { pageSize: 2 }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(calls(mock).filter((c) => c.startsWith("GET conversations.list"))).toHaveLength(1);
    expect(calls(mock).filter((c) => c.includes(`history?channel=${REPAIRS}`))).toHaveLength(4);
    expect(calls(mock).filter((c) => c.includes("replies"))).toHaveLength(3);
    expect(memory.events.filter((e) => e.type === "communication.message_logged")).toHaveLength(12);
    expect(report.ingested).toBe(3 + 12);
  });

  it("follows conversations.list's cursor across pages", async () => {
    const data = workspace();
    data.channels = Array.from({ length: 205 }, (_, i) => channel(`C0MANY${String(i).padStart(4, "0")}`, `room-${i}`, { is_member: i === 0 || i === 204 }));
    const mock = slackDocMock(data);
    const batches = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null })) batches.push(b);
    expect(calls(mock).filter((c) => c.startsWith("GET conversations.list"))).toEqual(["GET conversations.list?types=public_channel,private_channel&limit=200", expect.stringMatching(/&cursor=/)]);
    expect(parseSlackCursor(batches[1]!.cursor)).toMatchObject({ channels: ["C0MANY0000", "C0MANY0204"], step: "messages" });
  });

  it("reads at most a thousand channels a pass", async () => {
    const data = workspace();
    data.channels = Array.from({ length: SLACK_MAX_CHANNELS + 3 }, (_, i) => channel(`C0MAX${String(i).padStart(5, "0")}`, `r-${i}`));
    const mock = slackDocMock(data);
    const it = connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null })[Symbol.asyncIterator]();
    let last = (await it.next()).value!;
    while (parseSlackCursor(last.cursor)!.step === "channels") last = (await it.next()).value!;
    expect(parseSlackCursor(last.cursor)!.channels).toHaveLength(SLACK_MAX_CHANNELS);
  });

  it("finishes at once in a workspace where the bot is in no channel", async () => {
    const data = workspace();
    data.channels = data.channels.map((c) => ({ ...c, is_member: false }));
    const mock = slackDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 0, batches: 1 });
    expect(parseSlackCursor(report.cursor)).toMatchObject({ step: "done", channels: [] });
  });

  it("moves on from a channel the bot was removed from mid-pass", async () => {
    const mock = slackDocMock(workspace());
    const removed: typeof globalThis.fetch = async (input, init) => (String(input).includes(`history?channel=${REPAIRS}`) ? answer({ ok: false, error: "not_in_channel" }, 200, scopesHeader) : mock.fetch(input as string, init));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { fetch: removed }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(3 + 1);
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(slackDocMock(workspace()), { textChannels: "all" }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 9, deadLettered: 0 });
    expect(new Set(memory.events.map((e) => e.type))).toEqual(new Set(["communication.channel_updated", "communication.message_logged"]));
  });

  it("leaves a finished import finished", async () => {
    const mock = slackDocMock(workspace());
    const done = parseSlackCursor((await checkConnectorSync({ makeConnector: () => connector(slackDocMock(workspace())), expected: { ingested: 9 } })).full.cursor)!;
    const batches = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })) batches.push(b);
    expect(batches).toEqual([]);
    expect(mock.fetch.calls).toEqual([]);
  });

  const previous = (channels: string[] = [REPAIRS, CUSTOM, ARCHIVED]): SlackCursor => ({
    pass: "incremental",
    step: "done",
    listCursor: null,
    channels,
    index: channels.length,
    pageCursor: null,
    oldest: "0",
    repliesSince: "0",
    known: null,
    importFrom: "0",
    nextFrom: new Date(NOW_MS - HOUR * 1000 * 1.5).toISOString(),
  });

  it("reads each channel from a week before the last pass, and only threads with a reply since", async () => {
    const data = workspace();
    const repairs = data.channels[0]!;
    // A second thread whose last reply came before the previous pass: its replies aren't read again.
    const quiet = msg({ ts: slackTs(3 * DAY, 50), reply_count: 1, latest_reply: slackTs(2 * DAY, 51) });
    quiet.thread_ts = quiet.ts;
    repairs.messages.push(quiet, msg({ ts: slackTs(9 * DAY, 52) }));
    const mock = slackDocMock(data);
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "slack", "incremental", JSON.stringify(previous()));
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const lastPass = NOW_MS - HOUR * 1000 * 1.5;
    const week = slackTsFrom(lastPass - 7 * DAY * 1000);
    const since = slackTsFrom(lastPass - 5 * 60_000);
    expect(calls(mock).slice(2)).toEqual([
      `GET conversations.history?channel=${REPAIRS}&oldest=${week}&limit=200`,
      `GET conversations.replies?channel=${REPAIRS}&ts=${slackTs(HOUR, 1)}&oldest=${since}&limit=200`,
      `GET conversations.history?channel=${CUSTOM}&oldest=${week}&limit=200`,
      `GET conversations.history?channel=${ARCHIVED}&oldest=${week}&limit=200`,
    ]);
    // Channels 3, repairs messages 4 (with the quiet parent), the reply after the overlap, custom 1; the 9-day-old message is outside the week.
    expect(report.ingested).toBe(3 + 4 + 1 + 1);
    expect(parseSlackCursor(report.cursor)).toMatchObject({ pass: "incremental", step: "done", known: [REPAIRS, CUSTOM, ARCHIVED], nextFrom: RECEIVED });
    const again = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
  });

  it("reads a channel the bot joined since the last pass five years back, with every thread", async () => {
    const mock = slackDocMock(workspace());
    const batches = [];
    for await (const b of connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(previous([CUSTOM, ARCHIVED])) })) batches.push(b);
    const fiveYears = slackTsFrom(Date.parse("2021-01-20T00:00:00Z"));
    expect(calls(mock)[2]).toBe(`GET conversations.history?channel=${REPAIRS}&oldest=${fiveYears}&limit=200`);
    expect(calls(mock)[3]).toBe(`GET conversations.replies?channel=${REPAIRS}&ts=${slackTs(HOUR, 1)}&limit=200`);
    expect(batches[1]!.events).toHaveLength(5);
  });

  it("reads back 48 hours on a first incremental pass with no checkpoint", async () => {
    const mock = slackDocMock(workspace());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const since = slackTsFrom(NOW_MS - 48 * HOUR * 1000);
    expect(calls(mock)[2]).toBe(`GET conversations.history?channel=${REPAIRS}&oldest=${since}&limit=200`);
    expect(calls(mock)[3]).toBe(`GET conversations.replies?channel=${REPAIRS}&ts=${slackTs(HOUR, 1)}&oldest=${since}&limit=200`);
    expect(report.ingested).toBe(9);
    expect(parseSlackCursor(report.cursor)).toMatchObject({ known: null });
  });

  it("starts an incremental pass over when the saved checkpoint was the import's", async () => {
    const mock = slackDocMock(workspace());
    const batches = [];
    for await (const b of connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...previous(), pass: "historical" }) })) batches.push(b);
    expect(parseSlackCursor(batches[0]!.cursor)).toMatchObject({ pass: "incremental", known: null });
  });

  it("resumes an interrupted pass at the page it stopped on", async () => {
    const data = workspace();
    data.channels[0]!.messages.push(...Array.from({ length: 4 }, (_, i) => msg({ ts: slackTs(2 * DAY + i, 60 + i) })));
    const mock = slackDocMock(data);
    const first = [];
    for await (const b of connector(mock, { pageSize: 2 }).historicalImport({ organizationId: TEST_ORG, cursor: null })) {
      first.push(b);
      if (first.length === 2) break;
    }
    const stopped = parseSlackCursor(first[1]!.cursor)!;
    expect(stopped).toMatchObject({ step: "messages", index: 0, pageCursor: expect.any(String) });
    const before = mock.fetch.calls.length;
    const rest = [];
    for await (const b of connector(mock, { pageSize: 2 }).historicalImport({ organizationId: TEST_ORG, cursor: first[1]!.cursor })) rest.push(b);
    expect(calls(mock).slice(before)[1]).toContain(`&cursor=${stopped.pageCursor}`);
    expect(parseSlackCursor(rest.at(-1)!.cursor)).toMatchObject({ step: "done" });
  });

  it("stops when Slack keeps rate-limiting, with the checkpoint where it was, and carries on from there", async () => {
    const mock = slackDocMock(workspace());
    const { memory, pipeline } = testPipeline();
    let limited = true;
    let gets = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (String(input).includes("conversations.history") && ++gets >= 2 && limited) return answer({ ok: false, error: "ratelimited" }, 429, { "retry-after": "1" });
      return mock.fetch(input as string, init);
    };
    const stopped = await runSync({ connector: connector(mock, { fetch, rateLimitRetries: 1 }), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: async () => {} }).catch((e: unknown) => e);
    expect(stopped).toMatchObject({ name: "SlackApiError", code: "ratelimited" });
    expect(parseSlackCursor(await memory.getCheckpoint(TEST_ORG, "slack", "historical"))).toMatchObject({ step: "messages", index: 1 });
    limited = false;
    const resumed = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(resumed.batches).toBe(2);
    expect(memory.events).toHaveLength(9);
  });

  it("reads 15 messages a page for a non-Marketplace app", async () => {
    const data = workspace({ distribution: "non_marketplace" });
    data.channels[0]!.messages.push(...Array.from({ length: 20 }, (_, i) => msg({ ts: slackTs(2 * DAY + i, 70 + i) })));
    const mock = slackDocMock(data);
    const waits: number[] = [];
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock, { distribution: "non_marketplace", sleep: async (ms) => void waits.push(ms) }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const history = calls(mock).filter((c) => c.includes(`history?channel=${REPAIRS}`));
    expect(history).toHaveLength(2);
    for (const c of history) expect(c).toContain("&limit=15");
    // Four history reads, each a minute after the last on the fixture's fixed clock.
    expect(waits.filter((w) => w >= 60_000)).toEqual([60_000, 120_000, 180_000]);
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: SlackCursor = { ...previous(), step: "messages", index: 1, pageCursor: "dGVhbTpDMDYx=", known: [REPAIRS] };
    expect(parseSlackCursor(JSON.stringify(good))).toEqual(good);
    expect(parseSlackCursor(null)).toBeNull();
    for (const bad of [
      { ...good, pass: "full" },
      { ...good, step: "threads" },
      { ...good, index: -1 },
      { ...good, index: 4 },
      { ...good, index: 1.5 },
      { ...good, pageCursor: "a&token=x" },
      { ...good, listCursor: 3 },
      { ...good, channels: ["D0TEST0001"] },
      { ...good, channels: "C0TEST0001" },
      { ...good, channels: Array.from({ length: SLACK_MAX_CHANNELS + 1 }, () => REPAIRS), index: 0 },
      { ...good, known: [7] },
      { ...good, oldest: "yesterday" },
      { ...good, repliesSince: 0 },
      { ...good, importFrom: "1.2" },
      { ...good, nextFrom: "2026-13-45T00:00:00Z" },
      { ...good, nextFrom: "2026-02-30T00:00:00Z" },
      { ...good, extra: true },
      (({ known: _, ...rest }) => rest)(good),
      null,
      [],
      "cursor",
    ]) {
      expect(() => parseSlackCursor(JSON.stringify(bad)), JSON.stringify(bad).slice(0, 80)).toThrow("Slack checkpoint is not in the expected shape");
    }
  });

  it("declares its writes and a read-only gate refuses every one, and the client can't send them anyway", async () => {
    const mock = slackDocMock(workspace());
    const c = connector(mock);
    expect(c.writes).toBe(SLACK_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.integration, a.action, a.outcome])).toEqual([
      ["slack", "post_recommendation", "refused"],
      ["slack", "post_alert", "refused"],
    ]);
    await expect(slackClient(options(mock)).read({ method: "chat.postMessage", channel: REPAIRS } as never)).rejects.toThrow("only sends its listed reads");
    expect(mock.fetch.calls).toEqual([]);
  });
});

describe("Slack webhooks", () => {
  const nowS = Math.floor(NOW_MS / 1000);
  const sign = (body: string, ts = nowS, secret = SIGNING) => ({ body, timestamp: String(ts), signature: `v0=${hmacSha256(secret, `v0:${ts}:${body}`)}` });
  const delivery = (event: object, extra: object = {}) =>
    JSON.stringify({ token: "deprecated", team_id: SLACK_MOCK_TEAM, api_app_id: "A0TEST0001", type: "event_callback", event_id: "Ev0TEST0001", event_time: nowS, event, ...extra });
  const posted = { type: "message", channel: REPAIRS, channel_type: "channel", user: slackUserId(1), text: "Synthetic note", ts: slackTs(60, 9), event_ts: slackTs(60, 9) };

  it("accepts a delivery signed with the signing secret over v0:timestamp:body", () => {
    const body = delivery(posted);
    expect(verifySlackWebhook(SIGNING, sign(body), NOW_MS)).toEqual({ ok: true });
    expect(verifySlackWebhook(SIGNING, { ...sign(body), body: Buffer.from(body) }, NOW_MS)).toEqual({ ok: true });
    // Slack's own worked example from the docs page shape: v0= and 64 hex digits.
    const expected = createHmac("sha256", SIGNING).update(`v0:${nowS}:${body}`).digest("hex");
    expect(sign(body).signature).toBe(`v0=${expected}`);
  });

  it("refuses a tampered, re-signed, missing or malformed delivery", () => {
    const body = delivery(posted);
    const good = sign(body);
    expect(verifySlackWebhook(SIGNING, { ...good, body: tamper(body) }, NOW_MS)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySlackWebhook(SIGNING, sign(body, nowS, "another-secret"), NOW_MS)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySlackWebhook(SIGNING, { ...good, timestamp: String(nowS - 1) }, NOW_MS)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySlackWebhook(SIGNING, { ...good, signature: `v0=${"0".repeat(64)}` }, NOW_MS)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySlackWebhook("", good, NOW_MS)).toEqual({ ok: false, reason: "missing" });
    expect(verifySlackWebhook(SIGNING, { ...good, signature: undefined }, NOW_MS)).toEqual({ ok: false, reason: "missing" });
    expect(verifySlackWebhook(SIGNING, { ...good, timestamp: undefined }, NOW_MS)).toEqual({ ok: false, reason: "missing" });
    for (const signature of [good.signature.slice(3), `v1=${good.signature.slice(3)}`, `${good.signature}0`, good.signature.toUpperCase(), `v0=${"g".repeat(64)}`]) {
      expect(verifySlackWebhook(SIGNING, { ...good, signature }, NOW_MS), signature).toEqual({ ok: false, reason: "malformed" });
    }
    for (const timestamp of ["soon", "-1", "1e9", "1".repeat(13)]) expect(verifySlackWebhook(SIGNING, { ...good, timestamp }, NOW_MS)).toEqual({ ok: false, reason: "malformed" });
    expect(verifySlackWebhook(SIGNING, { ...good, signature: ` ${good.signature} ` }, NOW_MS)).toEqual({ ok: true });
  });

  it("refuses a delivery more than five minutes old or ahead, even with a good signature", () => {
    const body = delivery(posted);
    for (const skew of [SLACK_WEBHOOK_TOLERANCE_S + 1, -(SLACK_WEBHOOK_TOLERANCE_S + 1), 3600]) {
      expect(verifySlackWebhook(SIGNING, sign(body, nowS - skew), NOW_MS), String(skew)).toEqual({ ok: false, reason: "stale" });
    }
    expect(verifySlackWebhook(SIGNING, sign(body, nowS - SLACK_WEBHOOK_TOLERANCE_S), NOW_MS)).toEqual({ ok: true });
    expect(verifySlackWebhook(SIGNING, sign(body, nowS + SLACK_WEBHOOK_TOLERANCE_S), NOW_MS)).toEqual({ ok: true });
    expect(verifySlackWebhook(SIGNING, sign(body, Math.floor(Date.now() / 1000)))).toEqual({ ok: true });
  });

  it("answers url_verification with its challenge, and nothing else", () => {
    expect(slackUrlVerification({ token: "deprecated", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P", type: "url_verification" })).toBe("3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P");
    expect(slackUrlVerification({ challenge: "<script>", type: "url_verification" })).toBeNull();
    expect(slackUrlVerification({ challenge: "abc", type: "event_callback" })).toBeNull();
    expect(slackUrlVerification(null)).toBeNull();
    expect(connector(slackDocMock(workspace())).handleWebhook({ type: "url_verification", challenge: "abc" })).toEqual([]);
  });

  it("turns posted, edited and deleted messages into the events the sync makes, and leaves out the rest", () => {
    const c = connector(slackDocMock(workspace()), { teamId: SLACK_MOCK_TEAM });
    const [message] = c.handleWebhook(JSON.parse(delivery(posted)));
    expect(message).toEqual(normalize.messageEvents(REPAIRS, posted, RECEIVED)[0]);
    const edited = c.handleWebhook(JSON.parse(delivery({ type: "message", subtype: "message_changed", channel: REPAIRS, channel_type: "channel", hidden: true, ts: slackTs(0, 10), message: { ...posted, edited: { user: slackUserId(1), ts: slackTs(0, 10) } } })));
    expect(edited[0]!.payload).toMatchObject({ edited: true, messageId: `slack:message:${REPAIRS}:${posted.ts}` });
    expect(edited[0]!.idempotencyKey).not.toBe(message!.idempotencyKey);
    // A reply bumps its parent with a message_changed and no edit: the same version, so a duplicate.
    expect(c.handleWebhook(JSON.parse(delivery({ type: "message", subtype: "message_changed", channel: REPAIRS, channel_type: "channel", message: { ...posted, reply_count: 1 } })))[0]!.idempotencyKey).toBe(message!.idempotencyKey);
    expect(c.handleWebhook(JSON.parse(delivery({ type: "message", subtype: "message_changed", channel: REPAIRS, channel_type: "channel" })))).toEqual([]);
    expect(c.handleWebhook(JSON.parse(delivery({ type: "message", subtype: "message_deleted", channel: CUSTOM, channel_type: "group", deleted_ts: posted.ts, ts: slackTs(0, 11) })))).toEqual(normalize.deletedEvent(CUSTOM, posted.ts, RECEIVED));
    for (const ignored of [
      delivery({ ...posted, channel_type: "im", channel: "D0TEST0001" }),
      delivery({ ...posted, channel_type: "mpim" }),
      delivery({ ...posted, channel: "nope" }),
      delivery({ type: "reaction_added", user: slackUserId(1) }),
      delivery({ ...posted, subtype: "channel_join" }),
      delivery(posted, { team_id: "T0OTHER001" }),
      delivery(posted, { type: "app_rate_limited" }),
      JSON.stringify({ type: "event_callback" }),
    ]) {
      expect(c.handleWebhook(JSON.parse(ignored)), ignored.slice(0, 60)).toEqual([]);
    }
    expect(c.handleWebhook(null)).toEqual([]);
    // Without a team id every workspace's deliveries are read, since one instance holds one workspace.
    expect(slackWebhookEvents(JSON.parse(delivery(posted, { team_id: "T0OTHER001" })), normalize, RECEIVED)).toHaveLength(1);
  });

  it("counts a webhook for a message already synced, and a delivery Slack retries, as duplicates", async () => {
    const mock = slackDocMock(workspace());
    const c = connector(mock);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const synced = workspace().channels[0]!.messages[0]!;
    const body = delivery({ ...synced, channel: REPAIRS, channel_type: "channel" });
    const ingest = async (raw: string) => {
      expect(verifySlackWebhook(SIGNING, sign(raw), NOW_MS)).toEqual({ ok: true });
      const results = [];
      for (const e of c.handleWebhook(JSON.parse(raw))) results.push(await pipeline.ingest({ ...e, organizationId: TEST_ORG, source: "slack" }));
      return results.map((r) => r.duplicate);
    };
    expect(await ingest(body)).toEqual([true]);
    const fresh = delivery(posted);
    expect(await ingest(fresh)).toEqual([false]);
    // Slack retries a delivery it thinks failed, with the same body: stored once.
    expect(await ingest(fresh)).toEqual([true]);
  });
});
