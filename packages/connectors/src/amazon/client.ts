/**
 * A small client for Amazon's Selling Partner API (SP-API), for the store's
 * own seller account in one marketplace: its orders (Orders API
 * v2026-01-01), the transactions Amazon posts against them, such as sales,
 * fees and refunds (Finances API v2024-06-19), and its stock in Amazon's
 * warehouses (FBA Inventory API v1). Read-only by request: its only SP-API
 * requests are three GETs with parameters it builds and checks itself, and
 * its only other request is the Login with Amazon token refresh.
 *
 * Login with Amazon (LWA) trades the seller's refresh token for an access
 * token that lasts an hour. The refresh token doesn't change, so nothing is
 * stored; the access token is kept in memory, sent only in the
 * x-amz-access-token header, and renewed once when Amazon answers that it
 * has expired. SP-API calls no longer need AWS request signing.
 */

export const AMAZON_LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
export const AMAZON_API_URLS = {
  production: { na: "https://sellingpartnerapi-na.amazon.com", eu: "https://sellingpartnerapi-eu.amazon.com", fe: "https://sellingpartnerapi-fe.amazon.com" },
  sandbox: { na: "https://sandbox.sellingpartnerapi-na.amazon.com", eu: "https://sandbox.sellingpartnerapi-eu.amazon.com", fe: "https://sandbox.sellingpartnerapi-fe.amazon.com" },
} as const;
export type AmazonEnvironment = keyof typeof AMAZON_API_URLS;
export type AmazonRegion = keyof (typeof AMAZON_API_URLS)["production"];

/** Amazon.com, the US marketplace, read when AMAZON_SP_MARKETPLACE_ID isn't set. */
export const AMAZON_US_MARKETPLACE = "ATVPDKIKX0DER";
export const AMAZON_ORDERS_PATH = "/orders/2026-01-01/orders";
export const AMAZON_TRANSACTIONS_PATH = "/finances/2024-06-19/transactions";
export const AMAZON_INVENTORY_PATH = "/fba/inventory/v1/summaries";
/** Orders asked for per page; Amazon's most. */
export const AMAZON_ORDER_PAGE_SIZE = 100;
/** What each order comes with: its totals and its fulfillment status. Never the buyer or the address. */
export const AMAZON_ORDER_DATA = ["PROCEEDS", "FULFILLMENT"] as const;
/** Amazon answers no transactions for a range wider than 180 days, so ranges are kept to this. */
export const AMAZON_TRANSACTION_RANGE_DAYS = 179;
/** Amazon turns away a range that ends less than two minutes before the request. */
export const AMAZON_SETTLE_MS = 5 * 60_000;
const USER_AGENT = "KaratOS/1.0 (Language=TypeScript)";

/** A range of time, both ISO times in UTC; `after` is included and `before` is not. */
export interface AmazonRange {
  after: string;
  before: string;
}

export interface AmazonClientOptions {
  /** The LWA client id of the store's SP-API app (AMAZON_SP_CLIENT_ID). */
  clientId: string;
  /** The same app's LWA client secret (AMAZON_SP_CLIENT_SECRET). */
  clientSecret: string;
  /** The refresh token from the seller authorizing the app (AMAZON_SP_REFRESH_TOKEN). */
  refreshToken: string;
  /** The marketplace to read (AMAZON_SP_MARKETPLACE_ID); Amazon.com when not set. */
  marketplaceId?: string | undefined;
  /** na, eu or fe (AMAZON_SP_REGION), the region of the marketplace; na when not set. */
  region?: string | undefined;
  /** production or sandbox (AMAZON_SP_ENVIRONMENT); production when not set. */
  environment?: string | undefined;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a throttled or failed request is retried here before the error goes to runSync. */
  retries?: number;
  now?: () => number;
}

export class AmazonConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmazonConfigError";
  }
}

/** Amazon answered with an error. `code` is the first error's code, when it gives one. */
export class AmazonApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "AmazonApiError";
    this.status = status;
    this.code = code;
  }
}

export interface AmazonClient {
  readonly marketplaceId: string;
  /** One page of the orders last updated in the range. */
  orders(range: AmazonRange, token: string | null): Promise<Record<string, unknown>>;
  /** One page of the transactions posted in the range, at most 180 days wide. */
  transactions(range: AmazonRange, token: string | null): Promise<Record<string, unknown>>;
  /** One page of the marketplace's stock in Amazon's warehouses. */
  inventory(token: string | null): Promise<Record<string, unknown>>;
}

const DAY_MS = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
/** A next token as Amazon returns them. */
const TOKEN = /^[A-Za-z0-9_=+/.:-]{1,4096}$/;
const MARKETPLACE = /^[A-Z0-9]{8,20}$/;
const CLIENT_ID = /^amzn1\.application-oa2-client\.[a-z0-9]{16,64}$/;
/** Printable, no spaces, as it goes in a form. */
const CREDENTIAL = /^[\x21-\x7e]{16,2048}$/;
const MAX_WAIT_MS = 64_000;
const RENEW_EARLY_MS = 60_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An ISO time in UTC as epoch milliseconds, or NaN when it isn't one, or isn't a real time. */
export function amazonTimeMs(value: unknown): number {
  if (typeof value !== "string" || !ISO.test(value)) return Number.NaN;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19) ? ms : Number.NaN;
}

function token(value: string | null): string | null {
  if (value !== null && !(typeof value === "string" && TOKEN.test(value))) throw new AmazonConfigError("the page token must be the one Amazon returned");
  return value;
}

function range(r: AmazonRange, maxDays?: number): AmazonRange {
  const extra = Object.keys(r ?? {}).filter((k) => k !== "after" && k !== "before");
  if (extra.length) throw new AmazonConfigError(`a range doesn't take ${extra.slice(0, 3).join(", ")}`);
  const after = amazonTimeMs(r.after);
  const before = amazonTimeMs(r.before);
  if (Number.isNaN(after) || Number.isNaN(before)) throw new AmazonConfigError("after and before must be ISO times in UTC");
  if (before <= after) throw new AmazonConfigError("before must be later than after");
  if (maxDays !== undefined && before - after > maxDays * DAY_MS) throw new AmazonConfigError(`a range can't be wider than ${maxDays} days`);
  return r;
}

/** The query string for a page of orders, or an AmazonConfigError before anything is sent. */
export function amazonOrderParams(marketplaceId: string, r: AmazonRange, pageToken: string | null): URLSearchParams {
  const { after, before } = range(r);
  const params = new URLSearchParams({ marketplaceIds: marketplaceId, lastUpdatedAfter: after, lastUpdatedBefore: before, maxResultsPerPage: String(AMAZON_ORDER_PAGE_SIZE), includedData: AMAZON_ORDER_DATA.join(",") });
  if (token(pageToken) !== null) params.set("paginationToken", pageToken!);
  return params;
}

/** The query string for a page of transactions, or an AmazonConfigError before anything is sent. */
export function amazonTransactionParams(marketplaceId: string, r: AmazonRange, nextToken: string | null): URLSearchParams {
  const { after, before } = range(r, AMAZON_TRANSACTION_RANGE_DAYS);
  const params = new URLSearchParams({ postedAfter: after, postedBefore: before, marketplaceId });
  if (token(nextToken) !== null) params.set("nextToken", nextToken!);
  return params;
}

/** The query string for a page of stock, or an AmazonConfigError for a token Amazon didn't give. */
export function amazonInventoryParams(marketplaceId: string, nextToken: string | null): URLSearchParams {
  const params = new URLSearchParams({ details: "true", granularityType: "Marketplace", granularityId: marketplaceId, marketplaceIds: marketplaceId });
  if (token(nextToken) !== null) params.set("nextToken", nextToken!);
  return params;
}

/** The first error Amazon gave: its code and message, cut short. Error bodies describe the request, never the credentials. */
function errorOf(body: unknown): { code?: string; message: string } {
  const b = (body && typeof body === "object" ? body : {}) as { errors?: unknown; error?: unknown; error_description?: unknown };
  const first = (Array.isArray(b.errors) && b.errors[0] && typeof b.errors[0] === "object" ? b.errors[0] : {}) as { code?: unknown; message?: unknown };
  const code = typeof first.code === "string" ? first.code : typeof b.error === "string" ? b.error : undefined;
  const message = typeof first.message === "string" ? first.message : typeof b.error_description === "string" ? b.error_description : "";
  return { ...(code && /^[A-Za-z_]{1,64}$/.test(code) ? { code } : {}), message: message.slice(0, 200) };
}

const HINTS: Record<number, string> = {
  403: "; give the SP-API app the Finance and Accounting, and Amazon Fulfillment, roles, and re-authorize it",
  404: "; check AMAZON_SP_REGION matches the marketplace",
};

export function amazonClient(options: AmazonClientOptions): AmazonClient {
  const clientId = options.clientId?.trim() ?? "";
  if (!CLIENT_ID.test(clientId)) throw new AmazonConfigError("AMAZON_SP_CLIENT_ID must be the app's LWA client id, starting amzn1.application-oa2-client.");
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!CREDENTIAL.test(clientSecret)) throw new AmazonConfigError("set AMAZON_SP_CLIENT_SECRET");
  const refreshToken = options.refreshToken?.trim() ?? "";
  if (!CREDENTIAL.test(refreshToken)) throw new AmazonConfigError("set AMAZON_SP_REFRESH_TOKEN");
  const marketplaceId = options.marketplaceId?.trim() || AMAZON_US_MARKETPLACE;
  if (!MARKETPLACE.test(marketplaceId)) throw new AmazonConfigError("AMAZON_SP_MARKETPLACE_ID must be a marketplace id, such as ATVPDKIKX0DER");
  const region = options.region?.trim() || "na";
  if (!Object.hasOwn(AMAZON_API_URLS.production, region)) throw new AmazonConfigError("AMAZON_SP_REGION must be na, eu or fe");
  const environment = options.environment?.trim() || "production";
  if (!Object.hasOwn(AMAZON_API_URLS, environment)) throw new AmazonConfigError("AMAZON_SP_ENVIRONMENT must be production or sandbox");
  const base = AMAZON_API_URLS[environment as AmazonEnvironment][region as AmazonRegion];
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 3;
  const now = options.now ?? Date.now;
  let access: { token: string; expiresAt: number } | null = null;

  async function renew(): Promise<string> {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
    const response = await doFetch(AMAZON_LWA_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", accept: "application/json" }, body });
    const answer: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const { code } = errorOf(answer);
      // LWA's error descriptions can repeat the request, so only the code is kept.
      const hint = code === "invalid_grant" ? "; the seller may have removed the app's authorization, so authorize it again and update AMAZON_SP_REFRESH_TOKEN" : code === "invalid_client" ? "; check AMAZON_SP_CLIENT_ID and AMAZON_SP_CLIENT_SECRET" : "";
      throw new AmazonApiError(`Login with Amazon turned down the refresh (HTTP ${response.status}${code ? ` ${code}` : ""})${hint}`, response.status, code);
    }
    const t = (answer && typeof answer === "object" ? answer : {}) as { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
    if (typeof t.access_token !== "string" || !CREDENTIAL.test(t.access_token) || (typeof t.token_type === "string" && t.token_type.toLowerCase() !== "bearer")) {
      throw new AmazonApiError("Login with Amazon did not answer with an access token", response.status);
    }
    const seconds = typeof t.expires_in === "number" && Number.isFinite(t.expires_in) && t.expires_in > 0 ? t.expires_in : 3600;
    access = { token: t.access_token, expiresAt: now() + seconds * 1000 };
    return access.token;
  }

  async function accessToken(): Promise<string> {
    return access && access.expiresAt - RENEW_EARLY_MS > now() ? access.token : renew();
  }

  // GET only, to the three paths the connector reads, with the access token in a header and never in the URL.
  async function get(path: typeof AMAZON_ORDERS_PATH | typeof AMAZON_TRANSACTIONS_PATH | typeof AMAZON_INVENTORY_PATH, params: URLSearchParams): Promise<Record<string, unknown>> {
    const url = `${base}${path}?${params}`;
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, { method: "GET", headers: { accept: "application/json", "user-agent": USER_AGENT, "x-amz-access-token": await accessToken() } });
      const answer: unknown = await response.json().catch(() => null);
      const { code, message } = errorOf(answer);
      // An access token Amazon no longer takes is renewed once; a second refusal is a missing role.
      if ((response.status === 401 || (response.status === 403 && code === "Unauthorized" && /expired|invalid/i.test(message))) && !renewed) {
        renewed = true;
        access = null;
        continue;
      }
      // Throttling and Amazon's own outages are worth waiting out.
      if (response.status === 429 || response.status === 500 || response.status === 503) {
        if (attempt < retries) {
          await sleep(Math.min(1000 * 2 ** attempt, MAX_WAIT_MS));
          continue;
        }
        const why = response.status === 429 ? "Amazon kept throttling the sync; its request quota refills over a few minutes" : `Amazon kept answering HTTP ${response.status}`;
        throw new AmazonApiError(`${why}, and the next sync resumes from the checkpoint`, response.status, code);
      }
      if (!response.ok) throw new AmazonApiError(`Amazon answered HTTP ${response.status}${message ? `: ${message}` : ""}${HINTS[response.status] ?? ""}`, response.status, code);
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new AmazonApiError("Amazon did not answer with JSON", response.status);
      return answer as Record<string, unknown>;
    }
  }

  return {
    marketplaceId,
    orders: async (r, pageToken) => get(AMAZON_ORDERS_PATH, amazonOrderParams(marketplaceId, r, pageToken)),
    transactions: async (r, nextToken) => get(AMAZON_TRANSACTIONS_PATH, amazonTransactionParams(marketplaceId, r, nextToken)),
    inventory: async (nextToken) => get(AMAZON_INVENTORY_PATH, amazonInventoryParams(marketplaceId, nextToken)),
  };
}
