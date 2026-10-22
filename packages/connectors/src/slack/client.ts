/**
 * A small client for the Slack Web API, for a bot token only. Read-only
 * twice over: the app is installed with read scopes only, and the client
 * checks the scopes Slack reports for the token (the x-oauth-scopes header)
 * before its first read and on every answer after; and the only requests it
 * sends are four methods from a fixed list, each with arguments it checks.
 * Anything else, chat.postMessage included, is refused before a request is
 * made.
 *
 * Pacing. Slack limits each method per workspace per app. conversations.list
 * is Tier 2 (20+ a minute), conversations.history and conversations.replies
 * are Tier 3 (50+ a minute) for an internal app built by the business itself.
 * Since 29 May 2025, a commercially distributed app that isn't in the Slack
 * Marketplace gets Tier 1 for those two (1 a minute) and pages of at most 15
 * messages on every new installation. The client paces each method under its
 * limit, picked by `distribution`, and waits out a 429 for its Retry-After.
 */

export const SLACK_API_URL = "https://slack.com/api";

/** Every scope the connector may hold. Public channels are required; private channels are optional, as a pair. */
export const SLACK_READ_SCOPES = ["channels:read", "channels:history", "groups:read", "groups:history"] as const;
export const SLACK_REQUIRED_SCOPES = ["channels:read", "channels:history"] as const;
export const SLACK_PRIVATE_SCOPES = ["groups:read", "groups:history"] as const;

/**
 * How the app is distributed, which decides its history limits. `internal`:
 * an app the business made in its own workspace (the setup this repo
 * documents). `non_marketplace`: an app installed from outside the workspace
 * that isn't in the Slack Marketplace, held to 1 history read a minute.
 */
export type SlackDistribution = "internal" | "non_marketplace";

/** Requests a minute the client allows itself, under Slack's tier for each method, and the history page size. */
export const SLACK_PACING: Record<SlackDistribution, { listPerMinute: number; historyPerMinute: number; historyPage: number }> = {
  // Tier 2 is 20+ and Tier 3 is 50+ a minute; stay a little under to leave room for the owner's other apps.
  internal: { listPerMinute: 18, historyPerMinute: 45, historyPage: 200 },
  // Tier 1 for history and replies, and Slack caps their pages at 15.
  non_marketplace: { listPerMinute: 18, historyPerMinute: 1, historyPage: 15 },
};

/** The largest conversations.list page the docs recommend. */
export const SLACK_LIST_PAGE = 200;

export type SlackChannelType = "public_channel" | "private_channel";

/** The reads the client may send, and nothing else. */
export type SlackRead =
  | { method: "conversations.list"; types: readonly SlackChannelType[]; cursor?: string; limit?: number }
  | { method: "conversations.history"; channel: string; oldest: string; cursor?: string; limit?: number }
  | { method: "conversations.replies"; channel: string; ts: string; oldest?: string; cursor?: string; limit?: number };
export type SlackMethod = SlackRead["method"];

export interface SlackIdentity {
  teamId: string;
  botUserId: string;
  /** The scopes Slack reported for the token: always the read scopes above, nothing else. */
  scopes: readonly string[];
  /** Whether the app may read private channels it was invited to. */
  privateChannels: boolean;
}

export interface SlackClientOptions {
  /** The app's bot token (xoxb-). */
  token: string;
  distribution?: SlackDistribution;
  fetch?: typeof globalThis.fetch;
  /** Waits for pacing and before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate-limited request is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Milliseconds since the epoch; replaced in tests. */
  clock?: () => number;
}

export class SlackConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackConfigError";
  }
}

/** Slack answered with an error. `code` is Slack's error string, when it gives one. */
export class SlackApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "SlackApiError";
    this.status = status;
    this.code = code;
  }
}

export interface SlackClient {
  /** auth.test, once: who the bot is, in which workspace, with which scopes. Stops if the scopes are wrong. */
  identity(): Promise<SlackIdentity>;
  /** One read from the allowlist. Null when the channel or thread can't be read: not invited, gone or not found. */
  read(request: SlackRead): Promise<Record<string, unknown> | null>;
}

const TOKEN = /^xoxb-[A-Za-z0-9-]{10,250}$/;
export const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{2,20}$/;
export const SLACK_TS = /^\d{9,10}\.\d{6}$/;
const CURSOR = /^[A-Za-z0-9+/=_-]{1,512}$/;
const CODE = /^[a-z_]{1,60}$/;
const MAX_RETRY_AFTER_S = 300;
/** Errors that mean this channel or thread can't be read by the bot, so the sync moves on. */
const UNREADABLE = new Set(["channel_not_found", "not_in_channel", "thread_not_found"]);
const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "no_permission"]);

const ALLOWED_KEYS: Record<SlackMethod, readonly string[]> = {
  "conversations.list": ["method", "types", "cursor", "limit"],
  "conversations.history": ["method", "channel", "oldest", "cursor", "limit"],
  "conversations.replies": ["method", "channel", "ts", "oldest", "cursor", "limit"],
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The value of SLACK_APP_DISTRIBUTION: internal unless set. */
export function slackDistribution(value: string | undefined): SlackDistribution {
  const v = value?.trim() ?? "";
  if (v === "" || v === "internal") return "internal";
  if (v === "non_marketplace") return "non_marketplace";
  throw new SlackConfigError("SLACK_APP_DISTRIBUTION must be internal or non_marketplace");
}

function limit(value: unknown, max: number, query: URLSearchParams): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new SlackConfigError(`limit must be a whole number from 1 to ${max}`);
  query.set("limit", String(value));
}

function cursor(value: unknown, query: URLSearchParams): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !CURSOR.test(value)) throw new SlackConfigError("cursor must be the next_cursor Slack returned");
  query.set("cursor", value);
}

function channel(value: unknown, query: URLSearchParams): void {
  if (typeof value !== "string" || !SLACK_CHANNEL_ID.test(value)) throw new SlackConfigError("a channel id is C or G and capital letters and digits");
  query.set("channel", value);
}

function ts(name: string, value: unknown, query: URLSearchParams): void {
  if (typeof value !== "string" || !(SLACK_TS.test(value) || value === "0")) throw new SlackConfigError(`${name} must be a Slack timestamp`);
  query.set(name, value);
}

/**
 * The URL for one allowed read, or a SlackConfigError before anything is
 * sent. This is the allowlist: three GETs with checked arguments, and
 * auth.test, which `identity()` sends on its own.
 */
export function slackReadUrl(request: SlackRead, historyPage: number = SLACK_PACING.internal.historyPage): string {
  const method = (request as { method?: unknown } | null)?.method;
  if (typeof method !== "string" || !Object.hasOwn(ALLOWED_KEYS, method)) throw new SlackConfigError("the Slack connector only sends its listed reads");
  const extra = Object.keys(request).filter((k) => !ALLOWED_KEYS[method as SlackMethod].includes(k));
  if (extra.length) throw new SlackConfigError(`${method} doesn't take ${extra.slice(0, 3).join(", ")}`);
  const r = request as Record<string, unknown>;
  const query = new URLSearchParams();
  switch (method as SlackMethod) {
    case "conversations.list": {
      const types = r.types;
      const allowed: readonly unknown[] = ["public_channel", "private_channel"];
      if (!Array.isArray(types) || !types.length || types.length > 2 || new Set(types).size !== types.length || !types.every((t) => allowed.includes(t))) {
        throw new SlackConfigError("types must be public_channel, private_channel or both");
      }
      query.set("types", types.join(","));
      limit(r.limit, SLACK_LIST_PAGE, query);
      cursor(r.cursor, query);
      break;
    }
    case "conversations.history":
      channel(r.channel, query);
      ts("oldest", r.oldest, query);
      limit(r.limit, historyPage, query);
      cursor(r.cursor, query);
      break;
    case "conversations.replies":
      channel(r.channel, query);
      ts("ts", r.ts, query);
      if (r.oldest !== undefined) ts("oldest", r.oldest, query);
      limit(r.limit, historyPage, query);
      cursor(r.cursor, query);
      break;
  }
  return `${SLACK_API_URL}/${method}?${query.toString()}`;
}

/**
 * What's wrong with the scopes Slack reports for the token, or null when
 * they're read scopes only: channels:read and channels:history, optionally
 * with groups:read and groups:history together. Anything else (chat:write,
 * files:read, users:read, im:history ...) is a problem, as is a token that
 * doesn't say what it holds.
 */
export function slackScopeProblem(header: unknown): string | null {
  if (typeof header !== "string" || !header.trim()) return "Slack didn't say which scopes the token holds";
  const scopes = header.slice(0, 4096).split(",").map((s) => s.trim()).filter(Boolean);
  const extra = scopes.filter((s) => !(SLACK_READ_SCOPES as readonly string[]).includes(s));
  if (extra.length) return `the Slack app holds more than read access (${extra.slice(0, 5).join(", ")})`;
  const missing = SLACK_REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
  if (missing.length) return `the Slack app doesn't hold ${missing.join(" and ")}`;
  const privateHeld = SLACK_PRIVATE_SCOPES.filter((s) => scopes.includes(s));
  if (privateHeld.length === 1) return "groups:read and groups:history go together: add both to read private channels, or neither";
  return null;
}

const errorCode = (body: unknown): string | undefined => {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === "string" ? (CODE.test(e) ? e : "unknown_error") : undefined;
};

export function slackClient(options: SlackClientOptions): SlackClient {
  const token = options.token?.trim() ?? "";
  if (!token) throw new SlackConfigError("set SLACK_BOT_TOKEN");
  if (/^xox[a-z]-/.test(token) && !token.startsWith("xoxb-")) {
    throw new SlackConfigError("SLACK_BOT_TOKEN must be the app's bot token (xoxb-); other Slack tokens act as a person or the whole app");
  }
  if (!TOKEN.test(token)) throw new SlackConfigError("SLACK_BOT_TOKEN isn't a Slack bot token (xoxb-)");
  const pacing = SLACK_PACING[options.distribution ?? "internal"];
  if (!pacing) throw new SlackConfigError("distribution must be internal or non_marketplace");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 5;
  const clock = options.clock ?? (() => Date.now());
  const interval: Record<SlackMethod, number> = {
    "conversations.list": 60_000 / pacing.listPerMinute,
    "conversations.history": 60_000 / pacing.historyPerMinute,
    "conversations.replies": 60_000 / pacing.historyPerMinute,
  };
  const nextSlot: Record<SlackMethod, number> = { "conversations.list": 0, "conversations.history": 0, "conversations.replies": 0 };
  let identity: Promise<SlackIdentity> | null = null;

  /** Spaces calls to one method out, so a long import stays under Slack's tier for it. */
  async function pace(method: SlackMethod): Promise<void> {
    const now = clock();
    if (nextSlot[method] > now) await sleep(nextSlot[method] - now);
    nextSlot[method] = Math.max(nextSlot[method], now) + interval[method];
  }

  /** Every answer says which scopes the token holds; one that holds more stops the sync there. */
  function checkScopes(response: Response, required: boolean): void {
    const header = response.headers.get("x-oauth-scopes");
    if (header === null && !required) return;
    const problem = slackScopeProblem(header);
    if (problem) throw new SlackConfigError(`${problem}; reinstall it with only ${SLACK_READ_SCOPES.join(", ")}`);
  }

  async function send(url: string, init: RequestInit, method: SlackMethod | "auth.test"): Promise<{ response: Response; body: Record<string, unknown> }> {
    for (let attempt = 0; ; ) {
      if (method !== "auth.test") await pace(method);
      const response = await doFetch(url, init);
      const body: unknown = await response.json().catch(() => null);
      const code = errorCode(body);
      if (response.status === 429 || code === "ratelimited") {
        if (attempt < retries) {
          const after = Number(response.headers.get("retry-after"));
          await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : 1000 * 2 ** attempt);
          attempt++;
          continue;
        }
        throw new SlackApiError(`Slack kept rate-limiting ${method}; the next sync resumes from the checkpoint`, response.status, "ratelimited");
      }
      if (!response.ok) throw new SlackApiError(`Slack answered HTTP ${response.status}${code ? `: ${code}` : ""}`, response.status, code);
      if (!body || typeof body !== "object") throw new SlackApiError("Slack did not answer with JSON", response.status);
      return { response, body: body as Record<string, unknown> };
    }
  }

  function failure(body: Record<string, unknown>, status: number, method: string): Error {
    const code = errorCode(body) ?? "unknown_error";
    if (AUTH_ERRORS.has(code)) return new SlackApiError(`Slack refused the bot token (${code}); reinstall the app and set a new SLACK_BOT_TOKEN`, status, code);
    if (code === "missing_scope") {
      const needed = typeof body.needed === "string" && /^[a-z:.,_]{1,100}$/.test(body.needed) ? ` (needs ${body.needed})` : "";
      return new SlackConfigError(`the Slack app is missing a scope ${method} needs${needed}`);
    }
    return new SlackApiError(`Slack answered ${code} to ${method}`, status, code);
  }

  async function authTest(): Promise<SlackIdentity> {
    const { response, body } = await send(
      `${SLACK_API_URL}/auth.test`,
      // auth.test is documented as a POST; it reads who the token belongs to and changes nothing.
      { method: "POST", headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" }, body: "" },
      "auth.test",
    );
    if (body.ok !== true) throw failure(body, response.status, "auth.test");
    checkScopes(response, true);
    if (typeof body.bot_id !== "string" || !body.bot_id) throw new SlackConfigError("SLACK_BOT_TOKEN isn't a bot token: auth.test names no bot");
    const teamId = typeof body.team_id === "string" && /^[TE][A-Z0-9]{2,20}$/.test(body.team_id) ? body.team_id : null;
    const botUserId = typeof body.user_id === "string" && /^[UW][A-Z0-9]{2,20}$/.test(body.user_id) ? body.user_id : null;
    if (!teamId || !botUserId) throw new SlackApiError("auth.test didn't name the workspace and bot user", response.status);
    const scopes = response.headers.get("x-oauth-scopes")!.split(",").map((s) => s.trim()).filter(Boolean);
    return { teamId, botUserId, scopes, privateChannels: SLACK_PRIVATE_SCOPES.every((s) => scopes.includes(s)) };
  }

  function getIdentity(): Promise<SlackIdentity> {
    // One auth.test per client; a failed one is tried again on the next read.
    identity ??= authTest().catch((error: unknown) => {
      identity = null;
      throw error;
    });
    return identity;
  }

  return {
    identity: getIdentity,
    async read(request) {
      const url = slackReadUrl(request, pacing.historyPage);
      await getIdentity();
      // GET only, with the token in the Authorization header and never in the URL.
      const { response, body } = await send(url, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${token}` } }, request.method);
      checkScopes(response, false);
      if (body.ok !== true) {
        const code = errorCode(body);
        if (code && UNREADABLE.has(code)) return null;
        throw failure(body, response.status, request.method);
      }
      return body;
    },
  };
}
