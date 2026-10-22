import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockResponse } from "../doc-mock.js";

/**
 * The Slack Web API reads a bot token can make on channels it was invited
 * to, built from Slack's developer docs (docs.slack.dev). Data is synthetic.
 * A free developer sandbox workspace replaces this mock once one is set up.
 *
 * Facts taken from the docs, read on 2026-10-22:
 * - conversations.history: GET https://slack.com/api/conversations.history,
 *   token in the Authorization header; channel required; cursor, limit
 *   (default 100, maximum 999, "fewer than the requested number of items may
 *   be returned"), oldest (default 0), latest, inclusive. Bot scopes
 *   channels:history, groups:history (and im/mpim, not used). Tier 3, 50+ a
 *   minute.
 *   https://docs.slack.dev/reference/methods/conversations.history
 * - conversations.replies: GET; channel and ts required (the parent or a
 *   reply); cursor, limit (default 1000, no more than 200 recommended),
 *   oldest, latest, inclusive. Tier 3. Errors include thread_not_found,
 *   channel_not_found, invalid_cursor, ratelimited (with Retry-After),
 *   missing_scope, not_authed, invalid_auth, token_revoked. has_more and
 *   response_metadata.next_cursor page it.
 *   https://docs.slack.dev/reference/methods/conversations.replies
 * - conversations.list: GET; types from public_channel, private_channel,
 *   mpim, im (default public_channel); exclude_archived; limit under 1000,
 *   default 100, no more than 200 recommended; cursor. Bot scopes
 *   channels:read, groups:read. Tier 2, 20+ a minute. Channels carry id,
 *   name, is_channel, is_private, is_member, is_archived, created,
 *   num_members, topic and purpose.
 *   https://docs.slack.dev/reference/methods/conversations.list
 * - auth.test: POST; answers ok, url, team, user, team_id, user_id, and
 *   bot_id for a bot token. Special rate limit, hundreds a minute.
 *   https://docs.slack.dev/reference/methods/auth.test
 * - Since 29 May 2025, a commercially distributed app not in the Slack
 *   Marketplace gets Tier 1 (1 a minute) for conversations.history and
 *   conversations.replies, with limit's maximum and default cut to 15, on
 *   every new installation. Internal apps a business builds for itself keep
 *   Tier 3 and 1,000 objects. Marketplace apps aren't affected.
 *   https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps
 *   https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity
 * - Request signing: X-Slack-Signature is "v0=" and the hex HMAC-SHA256 of
 *   "v0:" + X-Slack-Request-Timestamp + ":" + raw body, keyed with the
 *   signing secret; refuse a timestamp more than five minutes from local
 *   time; compare with an hmac compare function.
 *   https://docs.slack.dev/authentication/verifying-requests-from-slack
 * - url_verification carries token (deprecated), challenge and type; answer
 *   200 with the challenge as text/plain, form or JSON.
 *   https://docs.slack.dev/reference/events/url_verification
 * - x-oauth-scopes "lists the scopes your token has authorized" (legacy
 *   OAuth scopes page, with a files.list example).
 *   https://docs.slack.dev/legacy/legacy-authentication/legacy-oauth-scopes
 */
const DOCS = "https://docs.slack.dev/reference/methods";
const API = "https://slack.com/api";

export const SLACK_MOCK_TEAM = "T0TEST0001";
export const SLACK_MOCK_BOT_USER = "U0TESTBOT1";
export const SLACK_MOCK_BOT = "B0TESTBOT1";
/** The scopes a correctly installed app holds. */
export const SLACK_MOCK_READ_SCOPES = ["channels:read", "channels:history", "groups:read", "groups:history"];

/** Seconds since the epoch at the fixture clock: 2026-01-20T00:00:00Z. */
export const SLACK_MOCK_NOW = "2026-01-20T00:00:00Z";

/** A Slack timestamp `seconds` before the fixture clock, with `n` as the microseconds so each is unique. */
export function slackTs(secondsBefore: number, n = 0): string {
  return `${Math.floor(Date.parse(SLACK_MOCK_NOW) / 1000) - secondsBefore}.${String(n).padStart(6, "0")}`;
}

/** A synthetic Slack user id, U0TEST and a number. */
export const slackUserId = (n: number) => `U0TEST${String(n).padStart(4, "0")}`;

export interface SlackMockMessage {
  type: "message";
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  reply_users?: string[];
  files?: { id: string; name: string; title: string; url_private: string }[];
  reactions?: { name: string; count: number; users: string[] }[];
  edited?: { user: string; ts: string };
  blocks?: unknown[];
}

export interface SlackMockChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
  is_archived: boolean;
  created: number;
  num_members: number;
  /** Top-level messages and thread broadcasts, any order. */
  messages: SlackMockMessage[];
  /** Replies by parent ts, any order. */
  replies?: Record<string, SlackMockMessage[]>;
}

export interface SlackMockData {
  channels: SlackMockChannel[];
  /** The bot token the app was installed with. */
  token: string;
  /** Scopes the installation holds; the four read scopes unless a test says otherwise. */
  scopes?: string[];
  /** Leaves the x-oauth-scopes header off every answer. */
  hideScopes?: boolean;
  /** non_marketplace holds history and replies to Slack's 15-message pages. */
  distribution?: "internal" | "non_marketplace";
  /** 429s to answer before the next reads, in order. */
  rateLimits?: { retryAfter?: number }[];
  /** Answers auth.test without bot_id, as for a user token. */
  userToken?: boolean;
}

export const slackMessage = fixtureBuilder<SlackMockMessage>((n) => ({
  type: "message",
  ts: slackTs(n * 3600, n),
  user: slackUserId(n),
  text: `Synthetic note ${n}: ${synthetic.name(n)} picked up the ring, call ${synthetic.phone(n)} or write ${synthetic.email(n)}`,
  blocks: [{ type: "rich_text", elements: [{ type: "text", text: `Synthetic note ${n}` }] }],
}));

const ok = (body: Record<string, unknown>): DocMockResponse => ({ status: 200, body: { ok: true, ...body } });
const fail = (error: string, extra: Record<string, unknown> = {}): DocMockResponse => ({ status: 200, body: { ok: false, error, ...extra } });

const offsetCursor = (offset: number) => Buffer.from(`offset:${offset}`).toString("base64");
const cursorOffset = (cursor: string | null) => {
  if (cursor === null || cursor === "") return 0;
  const m = /^offset:(\d+)$/.exec(Buffer.from(cursor, "base64").toString("utf8"));
  return m ? Number(m[1]) : Number.NaN;
};
const num = (ts: string) => Number(ts);

export interface SlackMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Revokes the token, as when the app is uninstalled. */
  revoke(): void;
}

export function slackDocMock(data: SlackMockData): SlackMock {
  let revoked = false;
  const limits = [...(data.rateLimits ?? [])];
  const scopes = () => data.scopes ?? SLACK_MOCK_READ_SCOPES;
  const has = (scope: string) => scopes().includes(scope);
  const nonMarketplace = data.distribution === "non_marketplace";

  function guard(request: { headers: Headers }): DocMockResponse | null {
    if (revoked) return fail("token_revoked");
    if (request.headers.get("authorization") !== `Bearer ${data.token}`) return fail("invalid_auth");
    const limit = limits.shift();
    if (limit) return { status: 429, body: { ok: false, error: "ratelimited" }, headers: limit.retryAfter ? { "retry-after": String(limit.retryAfter) } : {} };
    return null;
  }

  const withScopes = (response: DocMockResponse): DocMockResponse => (data.hideScopes ? response : { ...response, headers: { ...response.headers, "x-oauth-scopes": scopes().join(","), "x-accepted-oauth-scopes": "" } });

  /** One page of rows by Slack's opaque cursor, with has_more and next_cursor as the docs describe. */
  function page<T>(rows: T[], q: URLSearchParams, fallback: number, max: number): { rows: T[]; more: boolean; next: string } | DocMockResponse {
    const offset = cursorOffset(q.get("cursor"));
    if (Number.isNaN(offset)) return fail("invalid_cursor");
    const raw = q.get("limit");
    const asked = raw === null ? fallback : Number(raw);
    if (!Number.isInteger(asked) || asked < 1) return fail("invalid_limit");
    const n = Math.min(asked, max);
    const slice = rows.slice(offset, offset + n);
    const more = offset + n < rows.length;
    return { rows: slice, more, next: more ? offsetCursor(offset + n) : "" };
  }

  const channelFor = (id: string | null) => data.channels.find((c) => c.id === id);
  function readable(q: URLSearchParams): SlackMockChannel | DocMockResponse {
    const channel = channelFor(q.get("channel"));
    if (!channel || (channel.is_private && !channel.is_member)) return fail("channel_not_found");
    if (!has(channel.is_private ? "groups:history" : "channels:history")) return fail("missing_scope", { needed: channel.is_private ? "groups:history" : "channels:history", provided: scopes().join(",") });
    if (!channel.is_member) return fail("not_in_channel");
    return channel;
  }

  const api = checkDocMock({
    integration: "slack",
    baseUrl: API,
    source: { url: `${DOCS}/conversations.history`, title: "Slack Web API methods: conversations.history", retrievedOn: "2026-10-22", version: "Web API (Slack does not version it)" },
    auth: "bearer",
    assumptions: [
      "Every answer, auth.test included, carries x-oauth-scopes with the token's scopes separated by commas; the current docs describe the header only on the legacy scopes page",
      "conversations.history lists newest first and leaves thread replies out, except thread broadcasts; the method page doesn't say",
      "conversations.replies answers the parent first, then the replies oldest first, and still includes the parent when oldest is after it",
      "conversations.list with public_channel lists every public channel, with is_member false where the bot isn't in it, and private channels only where it is",
      "conversations.history answers not_in_channel for a public channel the bot isn't in, and channel_not_found for a private one",
      "A thread parent in the history carries reply_count and latest_reply",
      "Errors come back with HTTP 200 and ok false, except ratelimited, which is HTTP 429 with Retry-After in seconds",
      "Cursors stay valid between runs, so an interrupted listing can resume from a saved one",
      "Without groups:read, asking conversations.list for private_channel answers missing_scope",
    ],
    routes: [
      {
        method: "POST",
        path: "/auth.test",
        documentedAt: `${DOCS}/auth.test`,
        respond(request) {
          const denied = guard(request);
          if (denied) return denied;
          return withScopes(ok({ url: "https://synthetic-store.slack.test/", team: "Synthetic Store", user: "karatos", team_id: SLACK_MOCK_TEAM, user_id: SLACK_MOCK_BOT_USER, ...(data.userToken ? {} : { bot_id: SLACK_MOCK_BOT }) }));
        },
      },
      {
        method: "GET",
        path: "/conversations.list",
        documentedAt: `${DOCS}/conversations.list`,
        respond(request) {
          const denied = guard(request);
          if (denied) return denied;
          const q = request.url.searchParams;
          const types = (q.get("types") ?? "public_channel").split(",");
          if (!types.every((t) => ["public_channel", "private_channel", "mpim", "im"].includes(t))) return withScopes(fail("invalid_types"));
          if (types.includes("private_channel") && !has("groups:read")) return withScopes(fail("missing_scope", { needed: "groups:read" }));
          if (!has("channels:read")) return withScopes(fail("missing_scope", { needed: "channels:read" }));
          if (Number(q.get("limit") ?? 100) >= 1000) return withScopes(fail("invalid_limit"));
          const rows = data.channels.filter((c) => (c.is_private ? types.includes("private_channel") && c.is_member : types.includes("public_channel")));
          const p = page(rows, q, 100, 999);
          if ("status" in p) return withScopes(p);
          return withScopes(ok({
            channels: p.rows.map(({ messages: _m, replies: _r, ...c }) => ({ ...c, is_channel: !c.is_private, is_group: c.is_private, is_im: false, is_mpim: false, creator: slackUserId(1), topic: { value: "Synthetic topic", creator: slackUserId(1), last_set: 0 }, purpose: { value: "Synthetic purpose", creator: slackUserId(1), last_set: 0 } })),
            response_metadata: { next_cursor: p.next },
          }));
        },
      },
      {
        method: "GET",
        path: "/conversations.history",
        documentedAt: `${DOCS}/conversations.history`,
        respond(request) {
          const denied = guard(request);
          if (denied) return denied;
          const q = request.url.searchParams;
          const channel = readable(q);
          if ("status" in channel) return withScopes(channel);
          const oldest = num(q.get("oldest") ?? "0");
          const latest = q.has("latest") ? num(q.get("latest")!) : Number.POSITIVE_INFINITY;
          const rows = channel.messages.filter((m) => num(m.ts) > oldest && num(m.ts) < latest).sort((a, b) => num(b.ts) - num(a.ts));
          const p = page(rows, q, nonMarketplace ? 15 : 100, nonMarketplace ? 15 : 999);
          if ("status" in p) return withScopes(p);
          return withScopes(ok({ messages: p.rows, has_more: p.more, pin_count: 0, response_metadata: { next_cursor: p.next } }));
        },
      },
      {
        method: "GET",
        path: "/conversations.replies",
        documentedAt: `${DOCS}/conversations.replies`,
        respond(request) {
          const denied = guard(request);
          if (denied) return denied;
          const q = request.url.searchParams;
          const channel = readable(q);
          if ("status" in channel) return withScopes(channel);
          const parent = channel.messages.find((m) => m.ts === q.get("ts"));
          if (!parent) return withScopes(fail("thread_not_found"));
          const oldest = num(q.get("oldest") ?? "0");
          const replies = (channel.replies?.[parent.ts] ?? []).filter((m) => num(m.ts) > oldest).sort((a, b) => num(a.ts) - num(b.ts));
          const p = page([parent, ...replies], q, nonMarketplace ? 15 : 1000, nonMarketplace ? 15 : 1000);
          if ("status" in p) return withScopes(p);
          return withScopes(ok({ messages: p.rows, has_more: p.more, response_metadata: { next_cursor: p.next } }));
        },
      },
    ],
  });

  return {
    api,
    fetch: docMockFetch(api),
    revoke: () => {
      revoked = true;
    },
  };
}
