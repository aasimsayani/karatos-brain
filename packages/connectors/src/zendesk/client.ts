import type { QuickBooksTokenStore } from "../quickbooks/client.js";

/**
 * A small client for Zendesk's incremental exports: one helpdesk account's
 * tickets and its users, as they change. It signs in as an OAuth client the
 * account's admin made, with the refresh token from the admin authorizing
 * it for only tickets:read and users:read, and sends only these requests to
 * the account's own address, `https://{subdomain}.zendesk.com`:
 *
 * - `POST /oauth/tokens`, with the refresh token grant and those two scopes;
 * - `GET /api/v2/incremental/tickets/cursor`;
 * - `GET /api/v2/incremental/users/cursor`.
 *
 * Zendesk hands out a new refresh token with each access token and the old
 * one stops working, so the newest is saved before it is used. Each refresh
 * asks for the longest refresh token Zendesk allows, 90 days, so a sync at
 * least that often keeps the connection alive. The refresh
 * asks for the two read scopes, which can only narrow the token, and if the
 * answer lists scopes the client stops when any isn't a read one. Every
 * request is built here from checked values and Zendesk's export cursor,
 * never from a link in an answer.
 */

export type ZendeskTokenStore = QuickBooksTokenStore;

/** The scopes the client asks for. */
export const ZENDESK_SCOPES = ["tickets:read", "users:read"] as const;
/** The scopes a token may carry: ones that only read. */
export const ZENDESK_READ_SCOPES = ["read", "tickets:read", "users:read", "organizations:read", "satisfaction_ratings:read"] as const;
/** Records asked for at a time: the export's largest page. */
export const ZENDESK_PAGE_SIZE = 1000;
const TOKEN_MARGIN_MS = 60_000;
/** The longest a refresh token may last: 90 days, in seconds. */
export const ZENDESK_REFRESH_LIFETIME_S = 90 * 86_400;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 503, 504]);
const TOKEN = /^[\x21-\x7e]{1,4096}$/;
/** Zendesk's export cursor, as it writes them. */
export const ZENDESK_CURSOR = /^[A-Za-z0-9_.~=+/-]{1,2048}$/;

export type ZendeskExport = "tickets" | "users";

export interface ZendeskClientOptions {
  /** The account's subdomain (ZENDESK_SUBDOMAIN): `store` for store.zendesk.com. */
  subdomain: string;
  /** The OAuth client's unique identifier (ZENDESK_CLIENT_ID). */
  clientId: string;
  /** The OAuth client's secret (ZENDESK_CLIENT_SECRET). Sent to Zendesk only. */
  clientSecret: string;
  /** Where the newest refresh token lives; seeded from ZENDESK_REFRESH_TOKEN. */
  tokens: ZendeskTokenStore;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429, 503 or 504 is retried here before the error goes to runSync. */
  retries?: number;
  now?: () => Date;
}

export class ZendeskConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZendeskConfigError";
  }
}

/** Zendesk answered with an error. */
export class ZendeskApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ZendeskApiError";
  }
}

export interface ZendeskPage {
  rows: unknown[];
  /** The cursor to go on from: the next page, or, at the end, where the next sync starts. Null when Zendesk gave none. */
  cursor: string | null;
  /** No more changes for now. */
  end: boolean;
}

export interface ZendeskClient {
  /**
   * One page of an export: from `start` (whole seconds since the epoch) on the first request,
   * or from a cursor an earlier page gave.
   */
  page(kind: ZendeskExport, from: { start: number } | { cursor: string }): Promise<ZendeskPage>;
}

export function zendeskClient(options: ZendeskClientOptions): ZendeskClient {
  const subdomain = options.subdomain?.trim().toLowerCase() ?? "";
  const clientId = options.clientId?.trim() ?? "";
  const secret = options.clientSecret?.trim() ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) throw new ZendeskConfigError("ZENDESK_SUBDOMAIN must be the account's subdomain, such as store for store.zendesk.com");
  if (!/^[A-Za-z0-9_-]{2,128}$/.test(clientId)) throw new ZendeskConfigError("ZENDESK_CLIENT_ID is missing or not in the expected shape");
  if (!/^[\x21-\x7e]{16,256}$/.test(secret)) throw new ZendeskConfigError("ZENDESK_CLIENT_SECRET is missing or not in the expected shape");
  const base = `https://${subdomain}.zendesk.com`;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = options.retries ?? 3;
  const now = options.now ?? (() => new Date());
  let access: { value: string; until: number } | null = null;
  let refreshing: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    const refreshToken = (await options.tokens.load()).trim();
    if (!TOKEN.test(refreshToken)) throw new ZendeskConfigError("ZENDESK_REFRESH_TOKEN is missing or not in the expected shape");
    const body = JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: secret, scope: ZENDESK_SCOPES.join(" "), refresh_token_expires_in: ZENDESK_REFRESH_LIFETIME_S });
    const response = await doFetch(`${base}/oauth/tokens`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body });
    const reply: unknown = await response.json().catch(() => undefined);
    if (response.status === 400 || response.status === 401) throw new ZendeskConfigError("Zendesk turned down the sign-in: check ZENDESK_CLIENT_ID and ZENDESK_CLIENT_SECRET, and authorize the client again if the refresh token expired, was revoked or was already used");
    // Zendesk's docs show 201 for a new token.
    if (response.status !== 200 && response.status !== 201) throw new ZendeskApiError(`Zendesk answered HTTP ${response.status} to the sign-in`, response.status);
    const r = (reply ?? {}) as Record<string, unknown>;
    if (typeof r.access_token !== "string" || !TOKEN.test(r.access_token)) throw new ZendeskApiError("Zendesk's sign-in had no access token in the expected shape", 200);
    // A token that can do more than read is never used.
    if (r.scope !== undefined) {
      const scopes = typeof r.scope === "string" ? r.scope.split(" ").filter(Boolean) : ["(unreadable)"];
      const extra = scopes.filter((s) => !(ZENDESK_READ_SCOPES as readonly string[]).includes(s));
      if (extra.length > 0) throw new ZendeskConfigError(`the token has ${extra.slice(0, 5).join(", ")}; KaratOS only reads, so make a token with tickets:read and users:read only`);
    }
    // Saved before it is used: Zendesk has already retired the old one.
    if (typeof r.refresh_token === "string" && TOKEN.test(r.refresh_token)) await options.tokens.save(r.refresh_token);
    const seconds = typeof r.expires_in === "number" ? r.expires_in : 0;
    access = { value: r.access_token, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return access.value;
  }

  function signIn(): Promise<string> {
    if (access && now().getTime() < access.until) return Promise.resolve(access.value);
    // One refresh at a time: a second would spend a refresh token the first already rotated.
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function page(kind: ZendeskExport, from: { start: number } | { cursor: string }): Promise<ZendeskPage> {
    const url = new URL(`/api/v2/incremental/${kind}/cursor`, base);
    if ("cursor" in from) {
      if (!ZENDESK_CURSOR.test(from.cursor)) throw new ZendeskApiError("Zendesk's export cursor isn't in the expected shape", 0);
      url.searchParams.set("cursor", from.cursor);
    } else {
      // Zendesk wants a start at least a minute back.
      const latest = Math.floor(now().getTime() / 1000) - 60;
      if (!Number.isSafeInteger(from.start) || from.start < 0) throw new ZendeskApiError("an export's start must be whole seconds since 1970", 0);
      url.searchParams.set("start_time", String(Math.min(from.start, latest)));
    }
    url.searchParams.set("per_page", String(ZENDESK_PAGE_SIZE));
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url.toString(), { method: "GET", headers: { Authorization: `Bearer ${await signIn()}`, Accept: "application/json" } });
      const { status } = response;
      if (status === 401 && !renewed) {
        renewed = true;
        access = null;
        attempt--;
        continue;
      }
      if (RETRIED.has(status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(after > 0 ? 1000 * Math.min(after, MAX_WAIT_S) : 1000 * 2 ** attempt);
        continue;
      }
      if (status === 401) throw new ZendeskApiError("Zendesk turned down the token twice", 401);
      if (status === 403) throw new ZendeskConfigError(`the token can't read the ${kind} export: exports need a token an admin made, with tickets:read and users:read`);
      if (status === 404) throw new ZendeskConfigError("Zendesk has no account at ZENDESK_SUBDOMAIN");
      if (status !== 200) throw new ZendeskApiError(`Zendesk answered HTTP ${status} for the ${kind} export`, status);
      const body: unknown = await response.json().catch(() => undefined);
      const b = (body ?? {}) as Record<string, unknown>;
      const rows = b[kind];
      if (!Array.isArray(rows) || typeof b.end_of_stream !== "boolean") throw new ZendeskApiError(`Zendesk answered the ${kind} export without a list and end_of_stream`, 200);
      const next = b.after_cursor;
      // Only the last page may have no cursor: one in the middle must say where the rest is.
      if (next === null && b.end_of_stream) return { rows, cursor: null, end: true };
      if (typeof next !== "string" || !ZENDESK_CURSOR.test(next)) throw new ZendeskApiError(`Zendesk's ${kind} export had no after_cursor in the expected shape`, 200);
      return { rows, cursor: next, end: b.end_of_stream };
    }
  }

  return { page };
}
