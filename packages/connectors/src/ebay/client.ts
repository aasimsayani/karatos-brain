/**
 * A small client for eBay's Fulfillment API (Sell APIs, v1), for one
 * seller's orders. Read-only two ways over: every access token it uses is
 * minted from the seller's refresh token for the sell.fulfillment.readonly
 * scope alone, so eBay itself turns down anything that would change an
 * order or a listing; and the only API request it sends is getOrders, with
 * a filter, page size and offset it builds and checks itself.
 *
 * Orders carry the buyer's username, name, email address and shipping
 * address. None of it is kept: the normalizer reads the order's money,
 * status and lines only.
 *
 * The app's client id and secret go in a Basic header to eBay's token
 * endpoint, and the access token in a Bearer header, never in a URL.
 */

export const EBAY_API_URLS = { production: "https://api.ebay.com", sandbox: "https://api.sandbox.ebay.com" } as const;
export type EbayEnvironment = keyof typeof EBAY_API_URLS;
/** Reads orders; can't change them. */
export const EBAY_FULFILLMENT_READ_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly";

/** Longest span one read covers, so an offset stays small and a resumed sync repeats little. */
export const EBAY_MAX_RANGE_DAYS = 31;
/** Orders asked for per page; eBay's most. */
export const EBAY_PAGE_SIZE = 200;
/** How far back getOrders reaches. */
export const EBAY_HISTORY_YEARS = 2;

/** The two order times getOrders filters on. */
export type EbayOrderField = "creationdate" | "lastmodifieddate";

export interface EbayOrderQuery {
  field: EbayOrderField;
  /** ISO time, the start of the range, inclusive. */
  from: string;
  /** ISO time, the end of the range. */
  until: string;
  /** Orders to skip within the range. */
  offset: number;
}

/** Holds the seller's refresh token. eBay never returns a new one on refresh, so it is only read. */
export interface EbayClientOptions {
  /** The app's client id, its App ID (EBAY_CLIENT_ID). */
  clientId: string;
  /** The app's client secret, its Cert ID (EBAY_CLIENT_SECRET). */
  clientSecret: string;
  /** The seller's refresh token (EBAY_REFRESH_TOKEN). It lasts 18 months. */
  refreshToken: string;
  /** production unless set to sandbox (EBAY_ENVIRONMENT). */
  environment?: string | undefined;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate-limited request is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Milliseconds since the epoch; replaced in tests. */
  clock?: () => number;
}

export class EbayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EbayConfigError";
  }
}

/** eBay answered with an error. `code` is its errorId, or the OAuth error, when it gives one. */
export class EbayApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "EbayApiError";
    this.status = status;
    this.code = code;
  }
}

export interface EbayClient {
  readonly environment: EbayEnvironment;
  /** One page of orders. */
  orders(query: EbayOrderQuery): Promise<Record<string, unknown>>;
}

/** Printable, no spaces, as each goes in a header or a form field. */
const CREDENTIAL = /^[\x21-\x7e]{8,4096}$/;
const DAY_MS = 86_400_000;
const MAX_OFFSET = 1_000_000;
const ACCESS_RENEW_EARLY_MS = 2 * 60_000;
const MAX_WAIT_S = 64;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An ISO time as epoch milliseconds, or NaN when it isn't one the connector wrote. */
export function ebayTimeMs(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const ms = Date.parse(value);
  // Written back exactly as given: UTC, to the millisecond, and a real day and time.
  return !Number.isNaN(ms) && new Date(ms).toISOString() === value ? ms : Number.NaN;
}

/** Which eBay the settings name, or undefined when they name neither. */
export function ebayEnvironment(value: unknown): EbayEnvironment | undefined {
  const t = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!t) return "production";
  return t === "production" || t === "sandbox" ? t : undefined;
}

/**
 * The query string for one page of orders, or an EbayConfigError before
 * anything is sent. This is the allowlist: one of the two time filters over
 * a checked range of at most EBAY_MAX_RANGE_DAYS, the fixed page size and a
 * whole offset.
 */
export function ebayOrdersParams(query: EbayOrderQuery): URLSearchParams {
  const extra = Object.keys(query ?? {}).filter((k) => !["field", "from", "until", "offset"].includes(k));
  if (extra.length) throw new EbayConfigError(`getOrders doesn't take ${extra.slice(0, 3).join(", ")}`);
  if (query.field !== "creationdate" && query.field !== "lastmodifieddate") throw new EbayConfigError("field must be creationdate or lastmodifieddate");
  const start = ebayTimeMs(query.from);
  const end = ebayTimeMs(query.until);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new EbayConfigError("from and until must be ISO times in UTC, to the millisecond");
  if (end <= start || end - start > EBAY_MAX_RANGE_DAYS * DAY_MS) throw new EbayConfigError(`a read covers up to ${EBAY_MAX_RANGE_DAYS} days`);
  if (!Number.isSafeInteger(query.offset) || query.offset < 0 || query.offset > MAX_OFFSET) throw new EbayConfigError("offset must be a whole number of orders");
  return new URLSearchParams({ filter: `${query.field}:[${query.from}..${query.until}]`, limit: String(EBAY_PAGE_SIZE), offset: String(query.offset) });
}

/** eBay's first error id and message, cut short. Error bodies describe the request, never the token. */
function errorOf(body: unknown): { code?: string; message: string } {
  const list = ((body ?? {}) as { errors?: unknown }).errors;
  const first = (Array.isArray(list) ? list[0] : undefined) as { errorId?: unknown; message?: unknown } | undefined;
  const code = typeof first?.errorId === "number" && Number.isInteger(first.errorId) ? String(first.errorId) : undefined;
  return { ...(code ? { code } : {}), message: typeof first?.message === "string" ? first.message.slice(0, 200) : "" };
}

export function ebayClient(options: EbayClientOptions): EbayClient {
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!CREDENTIAL.test(clientId) || !CREDENTIAL.test(clientSecret)) throw new EbayConfigError("set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET");
  const refreshToken = options.refreshToken?.trim() ?? "";
  if (!CREDENTIAL.test(refreshToken)) throw new EbayConfigError("set EBAY_REFRESH_TOKEN");
  const environment = ebayEnvironment(options.environment);
  if (!environment) throw new EbayConfigError("EBAY_ENVIRONMENT must be production or sandbox");
  const base = EBAY_API_URLS[environment];
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  const clock = options.clock ?? (() => Date.now());
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    const response = await doFetch(`${base}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: `Basic ${basic}` },
      // Asking for the read scope alone caps the access token at it, whatever else the seller agreed to.
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, scope: EBAY_FULFILLMENT_READ_SCOPE }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
      const code = typeof body.error === "string" ? body.error.slice(0, 40) : undefined;
      const hint =
        code === "invalid_grant"
          ? "; the refresh token expired or was revoked, so connect the eBay account again"
          : code === "invalid_scope"
            ? `; connect the eBay account again, agreeing to ${EBAY_FULFILLMENT_READ_SCOPE}`
            : code === "invalid_client"
              ? `; check EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are the ${environment} keys`
              : "";
      throw new EbayApiError(`eBay turned down the token refresh (HTTP ${response.status}${code ? `, ${code}` : ""})${hint}`, response.status, code);
    }
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 7200;
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

  return {
    environment,
    async orders(query) {
      const url = `${base}/sell/fulfillment/v1/order?${ebayOrdersParams(query)}`;
      let renewed = false;
      for (let attempt = 0; ; ) {
        // getOrders only, with the token in a header and never in the URL.
        const response = await doFetch(url, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${await accessToken()}` } });
        if (response.status === 401 && !renewed) {
          renewed = true;
          access = null;
          continue;
        }
        const answer: unknown = await response.json().catch(() => null);
        const { code, message } = errorOf(answer);
        if (response.status === 429) {
          if (attempt < retries) {
            const after = Number(response.headers.get("retry-after"));
            await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : Math.min(1000 * 2 ** attempt, MAX_WAIT_S * 1000));
            attempt++;
            continue;
          }
          throw new EbayApiError("eBay kept rate-limiting the sync; its daily call limit resets each day, and the next sync resumes from the checkpoint", 429, code);
        }
        if (!response.ok) {
          const hint = response.status === 403 ? `; the eBay account must agree to ${EBAY_FULFILLMENT_READ_SCOPE} when it connects` : "";
          throw new EbayApiError(`eBay answered HTTP ${response.status}${message ? `: ${message}` : ""}${hint}`, response.status, code);
        }
        if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new EbayApiError("eBay did not answer with JSON", response.status);
        return answer as Record<string, unknown>;
      }
    },
  };
}
