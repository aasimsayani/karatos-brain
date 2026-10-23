/**
 * A small client for the Square API. Read-only twice over:
 *
 * - It sends requests to a fixed list of read endpoints only, each with its
 *   own method, path and parameters; anything else is stopped before a
 *   request is made. Its other two calls go to Square's OAuth service: the
 *   token status check and, with an OAuth connection, the token refresh.
 * - Before its first read, and after every refresh, it asks Square which
 *   scopes the access token holds (`POST /oauth2/token/status`) and stops
 *   unless they are exactly the read scopes it needs. A personal access token
 *   has full access to the account, so it is stopped too.
 *
 * With an OAuth connection (the code flow), every refresh asks only for the
 * read scopes, so the new token is limited to them even if the seller once
 * granted more. Square returns the same refresh token each time, and access
 * tokens last 30 days.
 *
 * Square rate-limits per application and answers 429 RATE_LIMITED. The
 * client waits with exponential backoff and a little jitter, then hands the
 * error to runSync, which retries the batch from its checkpoint.
 */

/** The Square API version the connector was built and tested against, sent as Square-Version on every request. */
export const SQUARE_API_VERSION = "2026-09-16";

export const SQUARE_HOSTS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;
export type SquareEnvironment = keyof typeof SQUARE_HOSTS;

/** The scopes the connector needs, all read-only. A token holding any other scope is stopped. */
export const SQUARE_READ_SCOPES = ["MERCHANT_PROFILE_READ", "ITEMS_READ", "INVENTORY_READ", "CUSTOMERS_READ", "ORDERS_READ", "PAYMENTS_READ"] as const;

/** The only endpoints the client reads, with the parameters each may carry. */
export const SQUARE_ROUTES = {
  locations: { method: "GET", path: "/v2/locations", params: [] },
  catalogSearch: { method: "POST", path: "/v2/catalog/search", params: ["cursor", "object_types", "include_deleted_objects", "begin_time", "limit"] },
  catalogBatch: { method: "POST", path: "/v2/catalog/batch-retrieve", params: ["object_ids", "include_deleted_objects"] },
  inventoryCounts: { method: "POST", path: "/v2/inventory/counts/batch-retrieve", params: ["cursor", "states", "updated_after", "limit"] },
  customersSearch: { method: "POST", path: "/v2/customers/search", params: ["cursor", "limit", "query"] },
  ordersSearch: { method: "POST", path: "/v2/orders/search", params: ["location_ids", "cursor", "query", "limit", "return_entries"] },
  payments: { method: "GET", path: "/v2/payments", params: ["location_id", "begin_time", "updated_at_begin_time", "sort_order", "cursor", "limit"] },
  refunds: { method: "GET", path: "/v2/refunds", params: ["begin_time", "updated_at_begin_time", "sort_order", "cursor", "limit"] },
} as const satisfies Record<string, { method: "GET" | "POST"; path: string; params: readonly string[] }>;
export type SquareRoute = keyof typeof SQUARE_ROUTES;

export interface SquareClientOptions {
  /** production or sandbox; production when empty. */
  environment?: SquareEnvironment | string;
  /** A bearer token: an OAuth access token holding the read scopes only. */
  accessToken?: string;
  /** An OAuth connection, refreshed with the read scopes only: the application's ID and secret, and the seller's refresh token. */
  applicationId?: string;
  applicationSecret?: string;
  refreshToken?: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** 0 to 1, for backoff jitter; replaced in tests. */
  random?: () => number;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Milliseconds since the epoch; replaced in tests to expire access tokens. */
  clock?: () => number;
}

export class SquareConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SquareConfigError";
  }
}

/** Square answered with an error. `code` is Square's error code (RATE_LIMITED, UNAUTHORIZED, ...) when it gives one. */
export class SquareApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "SquareApiError";
    this.status = status;
    this.code = code;
  }
}

export interface SquareTokenStatus {
  scopes: string[];
  merchantId: string | undefined;
  expiresAt: string | undefined;
}

export interface SquareClient {
  readonly baseUrl: string;
  /** Reads one allowlisted endpoint. GET parameters go in the query, POST ones in the JSON body. */
  read(route: SquareRoute, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The merchant the token belongs to, once the first read has checked the token. */
  merchantId(): string | undefined;
}

const MAX_RETRY_AFTER_S = 60;
const ACCESS_RENEW_EARLY_MS = 24 * 3_600_000;
const BACKOFF_MS = 1000;
/** Square's scope names: upper-case words joined by underscores. */
const SCOPE = /^[A-Z][A-Z_]{0,59}$/;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clean = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : undefined);

/** Square's first error, cut short. Square's errors describe the request, never the token. */
function errorOf(body: unknown): { message: string; code: string | undefined } {
  const b = body as { errors?: { code?: unknown; detail?: unknown }[]; type?: unknown; message?: unknown } | null;
  // Square's older OAuth errors carry type and message instead of an errors list.
  const first = Array.isArray(b?.errors) ? b.errors[0] : { code: b?.type, detail: b?.message };
  const code = clean(first?.code, 40);
  const detail = clean(first?.detail, 200);
  return { message: [code, detail].filter(Boolean).join(": "), code };
}

/**
 * Scopes beyond the read scopes the connector needs, and needed ones the
 * token lacks. A token reporting no scopes at all is treated as full access.
 */
export function squareScopeProblems(scopes: readonly string[]): { extra: string[]; missing: string[] } {
  const named = scopes.map((s) => (s.length <= 60 && SCOPE.test(s) ? s : "an unreadable scope"));
  const extra = named.length === 0 ? ["full access (no scopes listed)"] : named.filter((s) => !(SQUARE_READ_SCOPES as readonly string[]).includes(s));
  const missing = SQUARE_READ_SCOPES.filter((s) => !named.includes(s));
  return { extra: [...new Set(extra)], missing };
}

export function squareClient(options: SquareClientOptions): SquareClient {
  const environment = options.environment?.trim() || "production";
  if (environment !== "production" && environment !== "sandbox") throw new SquareConfigError("SQUARE_ENVIRONMENT must be production or sandbox");
  const baseUrl = SQUARE_HOSTS[environment];
  const applicationId = options.applicationId?.trim() ?? "";
  const applicationSecret = options.applicationSecret?.trim() ?? "";
  const refreshToken = options.refreshToken?.trim() ?? "";
  const oauthParts = [applicationId, applicationSecret, refreshToken].filter(Boolean).length;
  if (oauthParts > 0 && oauthParts < 3) throw new SquareConfigError("set all of SQUARE_APPLICATION_ID, SQUARE_APPLICATION_SECRET and SQUARE_REFRESH_TOKEN");
  const oauth = oauthParts === 3;
  const staticToken = options.accessToken?.trim() ?? "";
  if (!oauth && !staticToken) throw new SquareConfigError("set SQUARE_APPLICATION_ID, SQUARE_APPLICATION_SECRET and SQUARE_REFRESH_TOKEN, or SQUARE_ACCESS_TOKEN");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const retries = options.rateLimitRetries ?? 3;
  const clock = options.clock ?? (() => Date.now());
  let access: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;
  let merchant: string | undefined;

  /** One call with Square's backoff on 429. `auth` is the bearer token, when the call takes one. */
  async function send(method: "GET" | "POST", url: string, auth: string | undefined, body: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { "square-version": SQUARE_API_VERSION, accept: "application/json" };
      if (auth) headers.authorization = `Bearer ${auth}`;
      if (method === "POST") headers["content-type"] = "application/json";
      const response = await doFetch(url, { method, headers, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}) });
      if (response.status !== 429) return response;
      if (attempt >= retries) throw new SquareApiError("Square kept rate-limiting the sync; the next run resumes from the checkpoint", 429, "RATE_LIMITED");
      const after = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : BACKOFF_MS * 2 ** attempt + Math.floor(random() * BACKOFF_MS);
      await sleep(wait);
    }
  }

  async function failure(response: Response, what: string): Promise<SquareApiError> {
    const { message, code } = errorOf(await response.json().catch(() => null));
    return new SquareApiError(`${what} answered HTTP ${response.status}${message ? ` (${message})` : ""}`, response.status, code);
  }

  /** Asks Square what the token may do, and stops unless it is exactly the read scopes. */
  async function checkScopes(token: string): Promise<void> {
    const response = await send("POST", `${baseUrl}/oauth2/token/status`, token, {});
    if (!response.ok) throw await failure(response, "Square's token status check");
    const body = (await response.json().catch(() => ({}))) as { scopes?: unknown; merchant_id?: unknown };
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : [];
    const { extra, missing } = squareScopeProblems(scopes);
    if (extra.length) {
      throw new SquareConfigError(`the Square token can do more than read (${extra.slice(0, 5).join(", ")}); connect with only ${SQUARE_READ_SCOPES.join(" ")}`);
    }
    if (missing.length) throw new SquareConfigError(`the Square token is missing ${missing.join(", ")}; connect with ${SQUARE_READ_SCOPES.join(" ")}`);
    const id = clean(body.merchant_id, 191);
    merchant = id && /^[A-Za-z0-9_-]{1,191}$/.test(id) ? id : undefined;
  }

  async function refresh(): Promise<string> {
    const response = await send("POST", `${baseUrl}/oauth2/token`, undefined, {
      client_id: applicationId,
      client_secret: applicationSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      // The new token holds only these, whatever the seller granted.
      scopes: SQUARE_READ_SCOPES,
    });
    if (!response.ok) {
      const error = await failure(response, "Square's token refresh");
      throw new SquareApiError(`${error.message}; reconnect Square if the refresh token was revoked`, error.status, error.code);
    }
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; expires_at?: unknown };
    if (typeof body.access_token !== "string" || !body.access_token) throw new SquareApiError("Square's token refresh answered without an access token", response.status);
    await checkScopes(body.access_token);
    const expires = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
    access = { token: body.access_token, expiresAt: Number.isNaN(expires) ? clock() + 30 * 86_400_000 : expires };
    return access.token;
  }

  async function accessToken(): Promise<string> {
    if (access && (!oauth || access.expiresAt - ACCESS_RENEW_EARLY_MS > clock())) return access.token;
    // One refresh or check at a time, shared by reads that start together.
    pending ??= (async () => {
      if (oauth) return refresh();
      await checkScopes(staticToken);
      access = { token: staticToken, expiresAt: Number.POSITIVE_INFINITY };
      return staticToken;
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  return {
    baseUrl,
    merchantId: () => merchant,
    async read(route, params = {}) {
      const spec = Object.hasOwn(SQUARE_ROUTES, route) ? SQUARE_ROUTES[route] : undefined;
      if (!spec) throw new SquareConfigError("the Square connector only reads its listed endpoints");
      const allowed: readonly string[] = spec.params;
      const unknown = Object.keys(params).filter((k) => !allowed.includes(k));
      if (unknown.length) throw new SquareConfigError(`the Square connector doesn't send ${unknown.slice(0, 3).join(", ")} to ${spec.path}`);
      let url = `${baseUrl}${spec.path}`;
      if (spec.method === "GET") {
        const query = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
          if (v === undefined) continue;
          if (typeof v !== "string" && typeof v !== "number") throw new SquareConfigError(`${k} must be a plain value`);
          query.set(k, String(v));
        }
        const qs = query.toString();
        if (qs) url += `?${qs}`;
      }
      let renewed = false;
      for (;;) {
        const response = await send(spec.method, url, await accessToken(), spec.method === "POST" ? params : undefined);
        if (response.status === 401 && oauth && !renewed) {
          // An access token can be revoked before it expires; refresh once.
          renewed = true;
          access = null;
          continue;
        }
        if (!response.ok) {
          const error = await failure(response, "Square");
          const hint = error.code === "INSUFFICIENT_SCOPES" ? `; connect with ${SQUARE_READ_SCOPES.join(" ")}` : "";
          throw new SquareApiError(`${error.message}${hint}`, error.status, error.code);
        }
        const body: unknown = await response.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new SquareApiError("Square did not answer with a JSON object", response.status);
        return body as Record<string, unknown>;
      }
    },
  };
}
