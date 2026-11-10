/**
 * A small client for Zoom's REST API v2, signed in with a Server-to-Server
 * OAuth app the account's admin makes. Zoom lets that app hold granular
 * scopes, so it can be made read-only, and this client checks it is: each
 * access token Zoom issues lists its scopes, and a token with any scope
 * that isn't a read, or without the two report scopes the connector needs,
 * is not used.
 *
 * It sends only the token request and two GETs, to Zoom's fixed addresses:
 * the account's meeting history for a span of days, and one meeting's
 * participant report. It ignores the `api_url` a token answer names.
 *
 * Zoom answers its rate limits with 429; that and 500, 502, 503 and 504 are
 * waited out a few times, honoring Retry-After, before the error goes to
 * runSync, which keeps the checkpoint.
 */

export const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";
export const ZOOM_API_URL = "https://api.zoom.us/v2";
/** The granular scopes to give the app. Each one only reads. */
export const ZOOM_READ_SCOPES = ["report:read:list_history_meetings:admin", "report:read:list_meeting_participants:admin"] as const;
/** Zoom's classic scope that covers both, for apps made before granular scopes. */
const CLASSIC_REPORT_SCOPE = "report:read:admin";
/** A scope that only reads, granular (report:read:list_users:admin) or classic (report:read:admin). */
const READ_SCOPE = /^[a-z_]+:read(:[a-z_]+)?(:(admin|master))?$/;
/** Rows asked for at a time: Zoom's largest page. */
export const ZOOM_PAGE_SIZE = 300;
const MAX_RETRY_AFTER_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
/** Tokens are renewed this long before Zoom says they lapse. */
const TOKEN_MARGIN_MS = 5 * 60_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Zoom's page tokens; they last 15 minutes. */
export const ZOOM_PAGE_TOKEN = /^[A-Za-z0-9_.=+/-]{1,512}$/;

export interface ZoomClientOptions {
  accountId: string;
  clientId: string;
  /** Sent to Zoom only, and never logged or shown. */
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Replaced in tests, for token lifetimes. */
  clock?: () => number;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class ZoomConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZoomConfigError";
  }
}

/** Zoom answered with an error. `code` is Zoom's own error code, when it gave one. */
export class ZoomApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "ZoomApiError";
  }
}

export interface ZoomPage {
  rows: unknown[];
  /** The token for the next page, or null when this was the last. */
  next: string | null;
}

export interface ZoomClient {
  /** One page of the account's meetings that started in a span of days (YYYY-MM-DD, at most a month). */
  meetings(query: { from: string; to: string; next: string | null }): Promise<ZoomPage>;
  /** One page of a past meeting's participant report, or null when Zoom has none for it. */
  participants(meetingUuid: string, next: string | null): Promise<ZoomPage | null>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Zoom's error code from its {code, message} body. */
export function zoomErrorCode(body: unknown): number | undefined {
  const code = isObject(body) ? body.code : undefined;
  return Number.isSafeInteger(code) && (code as number) > 0 ? (code as number) : undefined;
}

/** The scopes in a token answer that don't only read, or null when it doesn't list scopes. */
export function zoomWriteScopes(scope: unknown): string[] | null {
  if (typeof scope !== "string" || scope.trim() === "") return null;
  return scope.trim().split(/\s+/).filter((s) => !READ_SCOPE.test(s));
}

/** A meeting UUID as a path segment: Zoom asks for it encoded twice when it starts with / or holds //. */
export function zoomUuidPath(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(once) : once;
}

export function zoomClient(options: ZoomClientOptions): ZoomClient {
  const accountId = options.accountId?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(accountId)) throw new ZoomConfigError("ZOOM_ACCOUNT_ID is missing or not in the expected shape");
  const clientId = options.clientId?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) throw new ZoomConfigError("ZOOM_CLIENT_ID is missing or not in the expected shape");
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(clientSecret)) throw new ZoomConfigError("ZOOM_CLIENT_SECRET is missing or not in the expected shape");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock ?? Date.now;
  const retries = options.retries ?? 3;
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  let access: { token: string; until: number } | null = null;

  /** Sends a request, waiting out rate limits and server errors. */
  async function send(request: () => Promise<Response>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await request();
      if (!RETRIED.has(response.status) || attempt >= retries) return response;
      const after = Number(response.headers.get("retry-after"));
      await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : 1000 * 2 ** attempt);
    }
  }

  async function token(): Promise<string> {
    if (access && access.until > clock()) return access.token;
    const response = await send(() =>
      doFetch(ZOOM_TOKEN_URL, {
        method: "POST",
        headers: { Authorization: basic, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "account_credentials", account_id: accountId }).toString(),
      }),
    );
    const body: unknown = await response.json().catch(() => undefined);
    if (response.status === 400 || response.status === 401) throw new ZoomConfigError(`Zoom turned down the app's credentials (HTTP ${response.status}): check ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET, and that the app is activated`);
    if (response.status !== 200 || !isObject(body) || typeof body.access_token !== "string" || !/^\S{16,4096}$/.test(body.access_token)) {
      throw new ZoomApiError(`Zoom answered the token request with HTTP ${response.status} and no token`, response.status, zoomErrorCode(body));
    }
    // A token that could change anything is not used.
    const writes = zoomWriteScopes(body.scope);
    if (writes === null) throw new ZoomConfigError("Zoom's token answer did not list its scopes; the connector won't read without knowing it can only read");
    if (writes.length) throw new ZoomConfigError(`the Zoom app can change data (${writes.slice(0, 5).join(", ")}); give it only ${ZOOM_READ_SCOPES.join(" ")}`);
    const scopes = (body.scope as string).trim().split(/\s+/);
    const missing = scopes.includes(CLASSIC_REPORT_SCOPE) ? [] : ZOOM_READ_SCOPES.filter((s) => !scopes.includes(s));
    if (missing.length) throw new ZoomConfigError(`the Zoom app is missing ${missing.join(" ")}`);
    const seconds = Number.isSafeInteger(body.expires_in) && (body.expires_in as number) > 0 ? (body.expires_in as number) : 600;
    access = { token: body.access_token, until: clock() + seconds * 1000 - TOKEN_MARGIN_MS };
    return access.token;
  }

  async function get(path: string, query: Record<string, string>, what: string, missingIsNull = false): Promise<Record<string, unknown> | null> {
    const url = new URL(`${ZOOM_API_URL}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const bearer = await token();
    const response = await send(() => doFetch(url.toString(), { method: "GET", headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" } }));
    const body: unknown = await response.json().catch(() => undefined);
    const code = zoomErrorCode(body);
    const why = code ? ` (code ${code})` : "";
    if (response.status === 401) {
      // A token Zoom no longer takes is dropped, so the next read asks for a new one.
      access = null;
      throw new ZoomApiError(`Zoom turned down the token for ${what}${why}`, 401, code);
    }
    if (response.status === 403) throw new ZoomApiError(`Zoom's account isn't allowed to read ${what}${why}: reports need a Pro plan or higher`, 403, code);
    if (response.status === 404 && missingIsNull) return null;
    if (response.status !== 200) throw new ZoomApiError(`Zoom answered HTTP ${response.status} for ${what}${why}`, response.status, code);
    if (!isObject(body)) throw new ZoomApiError(`Zoom answered ${what} with a body that isn't a JSON object`, 200);
    return body;
  }

  function page(body: Record<string, unknown>, list: string, what: string): ZoomPage {
    const rows = body[list];
    if (!Array.isArray(rows)) throw new ZoomApiError(`Zoom answered ${what} without the ${list} list`, 200);
    const token = body.next_page_token;
    // Zoom sends an empty token on the last page.
    if (token === undefined || token === null || token === "") return { rows, next: null };
    if (typeof token !== "string" || !ZOOM_PAGE_TOKEN.test(token)) throw new ZoomApiError(`Zoom answered ${what} with a page token that doesn't read`, 200);
    return { rows, next: token };
  }

  const pageQuery = (next: string | null): Record<string, string> => {
    if (next !== null && !ZOOM_PAGE_TOKEN.test(next)) throw new ZoomApiError("a Zoom page token is not in the expected shape", 0);
    return { page_size: String(ZOOM_PAGE_SIZE), ...(next !== null ? { next_page_token: next } : {}) };
  };

  return {
    async meetings({ from, to, next }) {
      if (!DAY.test(from) || !DAY.test(to)) throw new ZoomApiError("meetings must be listed between YYYY-MM-DD days", 0);
      const body = (await get("/report/history_meetings", { from, to, date_type: "start_time", meeting_type: "meeting", ...pageQuery(next) }, "the meeting history"))!;
      return page(body, "history_meetings", "the meeting history");
    },
    async participants(meetingUuid, next) {
      if (typeof meetingUuid !== "string" || meetingUuid.length < 1 || meetingUuid.length > 64) throw new ZoomApiError("a meeting UUID must be 1 to 64 characters", 0);
      const body = await get(`/report/meetings/${zoomUuidPath(meetingUuid)}/participants`, pageQuery(next), "a meeting's participants", true);
      return body === null ? null : page(body, "participants", "a meeting's participants");
    },
  };
}
