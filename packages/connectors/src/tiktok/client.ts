import type { QuickBooksTokenStore } from "../quickbooks/client.js";

/**
 * A small client for TikTok's Display API (v2), for the store's own TikTok
 * account: its profile counts and its public videos with their views,
 * likes, comments and shares. Read-only two ways over: the connection holds
 * the read scopes user.info.basic, user.info.stats and video.list and
 * nothing else, which the client checks on every token refresh before
 * reading anything; and the only requests it sends are the profile read and
 * the video list, with fields and a page cursor it builds and checks itself.
 *
 * Videos are the store's own posts and the counts are totals, so nothing
 * here names a customer. Video descriptions aren't asked for.
 *
 * The app's client key and secret go in the form body to the token
 * endpoint, as TikTok's docs say, and the access token in a Bearer header,
 * never in a URL.
 */

export const TIKTOK_API_URL = "https://open.tiktokapis.com/v2";
/** The scopes the connection may hold: every one reads, none writes. */
export const TIKTOK_READ_SCOPES = ["user.info.basic", "user.info.stats", "video.list"] as const;
/** The profile fields read: the account's id and name, and its counts. */
export const TIKTOK_USER_FIELDS = ["open_id", "display_name", "follower_count", "following_count", "likes_count", "video_count"] as const;
/** The video fields read. No description, embed code or cover image. */
export const TIKTOK_VIDEO_FIELDS = ["id", "create_time", "title", "duration", "share_url", "view_count", "like_count", "comment_count", "share_count"] as const;
/** Videos asked for per page; TikTok's most. */
export const TIKTOK_PAGE_SIZE = 20;

export type TikTokTokenStore = QuickBooksTokenStore;

export interface TikTokClientOptions {
  /** The app's client key (TIKTOK_CLIENT_KEY). */
  clientKey: string;
  /** The app's client secret (TIKTOK_CLIENT_SECRET). */
  clientSecret: string;
  /** Holds the refresh token, which TikTok may replace on a refresh. */
  tokens: TikTokTokenStore;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate-limited request is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Milliseconds since the epoch; replaced in tests. */
  clock?: () => number;
}

export class TikTokConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TikTokConfigError";
  }
}

/** TikTok answered with an error. `code` is its error code, such as scope_not_authorized, when it gives one. */
export class TikTokApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "TikTokApiError";
    this.status = status;
    this.code = code;
  }
}

export interface TikTokClient {
  /** The connected account's profile and counts. */
  userInfo(): Promise<Record<string, unknown>>;
  /** One page of the account's public videos, newest first, posted before `cursor` (epoch milliseconds) when given. */
  videos(cursor: number | null): Promise<Record<string, unknown>>;
}

/** Printable, no spaces, as each goes in a form body. */
const CREDENTIAL = /^[\x21-\x7e]{1,512}$/;
const ACCESS_RENEW_EARLY_MS = 2 * 60_000;
const MAX_WAIT_S = 64;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The JSON body for a page of videos, or a TikTokConfigError for a cursor that isn't a time. */
export function tiktokVideoListBody(cursor: number | null): { max_count: number; cursor?: number } {
  if (cursor === null) return { max_count: TIKTOK_PAGE_SIZE };
  if (!Number.isSafeInteger(cursor) || cursor <= 0) throw new TikTokConfigError("cursor must be the time TikTok returned, in epoch milliseconds");
  return { max_count: TIKTOK_PAGE_SIZE, cursor };
}

/**
 * What's wrong with the scopes a token holds, or null when it holds every
 * read scope and nothing more. TikTok lists them separated by commas. Any
 * other scope is a problem, a write scope above all, as is a token that
 * doesn't say what it holds.
 */
export function tiktokScopeProblem(scope: unknown): string | null {
  if (typeof scope !== "string" || !scope.trim()) return "TikTok didn't say which scopes the token holds";
  const scopes = scope.split(/[\s,]+/).filter(Boolean);
  const known = TIKTOK_READ_SCOPES as readonly string[];
  const extra = scopes.filter((s) => !known.includes(s));
  if (extra.length) return `the TikTok connection holds more than read access (${extra.slice(0, 5).join(", ").slice(0, 200)})`;
  const lacking = known.filter((s) => !scopes.includes(s));
  if (lacking.length) return `the TikTok connection doesn't hold ${lacking.join(", ")}`;
  return null;
}

const short = (value: unknown) => (typeof value === "string" ? value.slice(0, 200) : "");
const codeOf = (value: unknown) => (typeof value === "string" && /^[a-z_]{1,60}$/.test(value) ? value : undefined);

/** The error TikTok's API put in its answer: its code (absent or "ok" on success) and message. */
function apiErrorOf(body: unknown): { code?: string; message: string } {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const o = (error && typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown };
  const code = codeOf(o.code);
  return { ...(code ? { code } : {}), message: short(o.message) };
}

const HINTS: Record<string, string> = {
  scope_not_authorized: "; connect the TikTok account again and allow every permission the app asks for",
  scope_permission_missed: "; connect the TikTok account again and allow every permission the app asks for",
  access_token_invalid: "; connect the TikTok account again",
};

export function tiktokClient(options: TikTokClientOptions): TikTokClient {
  const clientKey = options.clientKey?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!CREDENTIAL.test(clientKey) || !CREDENTIAL.test(clientSecret)) throw new TikTokConfigError("set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  const clock = options.clock ?? (() => Date.now());
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    const refreshToken = (await options.tokens.load()).trim();
    if (!refreshToken) throw new TikTokConfigError("set TIKTOK_REFRESH_TOKEN");
    const response = await doFetch(`${TIKTOK_API_URL}/oauth/token/`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown; error_description?: unknown };
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
      // The token endpoint answers error and error_description, which describe the request, never the token.
      const code = codeOf(body.error);
      const message = short(body.error_description) || (code ?? "");
      const hint = code === "invalid_client" ? "; check TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET" : code === "invalid_grant" ? "; the refresh token expired or was revoked, so connect the TikTok account again" : "";
      throw new TikTokApiError(`TikTok turned down the token refresh (HTTP ${response.status}${message ? `: ${message}` : ""})${hint}`, response.status, code);
    }
    // TikTok may answer a new refresh token; once it does, the old one stops working.
    if (typeof body.refresh_token === "string" && body.refresh_token && body.refresh_token !== refreshToken) await options.tokens.save(body.refresh_token);
    const problem = tiktokScopeProblem(body.scope);
    if (problem) throw new TikTokConfigError(`${problem}; connect it again with only ${TIKTOK_READ_SCOPES.join(", ")}`);
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    access = { token: body.access_token, expiresAt: clock() + seconds * 1000 };
    return access.token;
  }

  async function accessToken(): Promise<string> {
    if (access && access.expiresAt - ACCESS_RENEW_EARLY_MS > clock()) return access.token;
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  // Only the profile read and the video list, with the token in a header and never in the URL.
  async function call(path: "/user/info/" | "/video/list/", fields: readonly string[], body?: object): Promise<Record<string, unknown>> {
    const url = `${TIKTOK_API_URL}${path}?${new URLSearchParams({ fields: fields.join(",") })}`;
    let renewed = false;
    for (let attempt = 0; ; ) {
      const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${await accessToken()}` };
      if (body) headers["content-type"] = "application/json";
      const response = await doFetch(url, body ? { method: "POST", headers, body: JSON.stringify(body) } : { method: "GET", headers });
      const answer: unknown = await response.json().catch(() => null);
      const { code, message } = apiErrorOf(answer);
      if (response.status === 401 && code !== "scope_not_authorized" && !renewed) {
        renewed = true;
        access = null;
        continue;
      }
      if (response.status === 429) {
        if (attempt < retries) {
          const after = Number(response.headers.get("retry-after"));
          await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : Math.min(1000 * 2 ** attempt, MAX_WAIT_S * 1000));
          attempt++;
          continue;
        }
        throw new TikTokApiError("TikTok kept rate-limiting the sync; the next sync resumes from the checkpoint", 429, code);
      }
      if (!response.ok || (code !== undefined && code !== "ok")) {
        throw new TikTokApiError(`TikTok answered HTTP ${response.status}${message ? `: ${message}` : code ? `: ${code}` : ""}${(code && HINTS[code]) ?? ""}`, response.status, code);
      }
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new TikTokApiError("TikTok did not answer with JSON", response.status);
      return answer as Record<string, unknown>;
    }
  }

  return {
    userInfo: async () => call("/user/info/", TIKTOK_USER_FIELDS),
    videos: async (cursor) => call("/video/list/", TIKTOK_VIDEO_FIELDS, tiktokVideoListBody(cursor)),
  };
}
