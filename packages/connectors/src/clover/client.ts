import type { QuickBooksTokenStore } from "../quickbooks/client.js";

/**
 * A small client for the Clover REST API (v3) for one merchant. Read-only:
 * the only requests it sends to the merchant are GETs of a fixed list of
 * paths under /v3/merchants/{mId}, checked before anything is sent. Its one
 * POST is the OAuth token refresh, which goes to /oauth/v2/refresh on the
 * same regional host.
 *
 * Clover sets permissions on the app (Read merchant, Read orders and so on)
 * and the merchant approves them on install, but documents no way to read
 * back which permissions a token holds. So read-only rests on this client:
 * it can't send anything but its listed GETs, whatever the token allows.
 *
 * It signs in one of two ways:
 * - a merchant API token, made in the merchant's dashboard for one merchant;
 * - Clover's v2 OAuth expiring tokens: the app ID and a refresh token. Every
 *   refresh returns a new refresh token and retires the old one at once, so
 *   each new one is handed to the token store before it is used.
 *
 * Clover allows 16 requests a second and 5 at once per token. Requests go
 * one at a time; a 429 waits Clover's retry-after (at most a minute) or one
 * second doubling, then the error goes to runSync, which resumes from the
 * checkpoint.
 */

/** Clover's API hosts, one per region, and the sandbox. Nothing else is ever called. */
export const CLOVER_HOSTS = {
  north_america: "https://api.clover.com",
  europe: "https://api.eu.clover.com",
  latin_america: "https://api.la.clover.com",
  sandbox: "https://apisandbox.dev.clover.com",
} as const;
export type CloverRegion = keyof typeof CLOVER_HOSTS;

/** Clover's hard limit on `limit`. */
export const CLOVER_PAGE_SIZE = 1000;

/** What the client may read under /v3/merchants/{mId}. "merchant" is the merchant itself. */
export const CLOVER_RESOURCES = ["merchant", "items", "item_stocks", "customers", "orders", "payments", "refunds"] as const;
export type CloverResource = (typeof CLOVER_RESOURCES)[number];

/** Expansions the client may ask for, per resource; anything else is refused. */
export const CLOVER_EXPANDS: Record<CloverResource, readonly string[]> = {
  merchant: [],
  items: [],
  item_stocks: [],
  // Customers are expanded for their ids only; names and contact details are dropped in normalize.
  customers: [],
  orders: ["lineItems", "lineItems.discounts", "payments", "refunds", "customers"],
  payments: ["tender", "cardTransaction", "refunds"],
  refunds: ["payment"],
};

/** Same shape as QuickBooks': the newest refresh token, kept encrypted by the instance. */
export type CloverTokenStore = QuickBooksTokenStore;

export type CloverAuth =
  | { apiToken: string }
  /** The app ID is Clover's OAuth client_id. */
  | { appId: string; tokens: CloverTokenStore };

export interface CloverClientOptions {
  /** The merchant's 13-character Clover ID. */
  merchantId: string;
  region: CloverRegion | string;
  auth: CloverAuth;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Milliseconds since the epoch; replaced in tests to expire access tokens. */
  clock?: () => number;
}

export class CloverConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloverConfigError";
  }
}

/** Clover answered with an error. */
export class CloverApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "CloverApiError";
    this.status = status;
  }
}

export interface CloverListOptions {
  /** Each a time filter the connector built itself, e.g. modifiedTime>=1767225600000. */
  filters?: string[];
  expand?: string[];
  orderBy?: "modifiedTime ASC" | "createdTime ASC";
  /** From 1 to 1000; 1000 when left out. */
  limit?: number;
  offset?: number;
}

/** One page of a collection, as Clover answers it. */
export interface CloverList {
  elements: Record<string, unknown>[];
}

export interface CloverClient {
  readonly baseUrl: string;
  /** The merchant record, read to check the token reaches this merchant. */
  merchant(): Promise<Record<string, unknown>>;
  list(resource: Exclude<CloverResource, "merchant">, options?: CloverListOptions): Promise<CloverList>;
  /** One item by ID, for the SKU of a sold item the sync hasn't seen. Null when Clover no longer has it. */
  item(itemId: string): Promise<Record<string, unknown> | null>;
}

/** Clover IDs: 13 characters of digits and capital letters. */
export const CLOVER_ID = /^[0-9A-Z]{13}$/;
/** The only filters the client sends: a time bound in epoch milliseconds. */
const FILTER = /^(modifiedTime|createdTime)(>=|<)\d{1,15}$/;
const ORDER_BY = new Set(["modifiedTime ASC", "createdTime ASC"]);
const ACCESS_RENEW_EARLY_MS = 2 * 60_000;
const MAX_RETRY_AFTER_S = 60;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True only for the exact read paths the connector uses. Anything else is never sent. */
export function isAllowedCloverRead(baseUrl: string, merchantId: string, url: URL): boolean {
  if (`${url.protocol}//${url.host}` !== baseUrl || url.username || url.password || url.hash) return false;
  const root = `/v3/merchants/${merchantId}`;
  if (url.pathname === root) return true;
  const rest = url.pathname.startsWith(`${root}/`) ? url.pathname.slice(root.length + 1) : null;
  if (rest === null) return false;
  if (rest.startsWith("items/")) return CLOVER_ID.test(rest.slice("items/".length));
  return (CLOVER_RESOURCES as readonly string[]).includes(rest) && rest !== "merchant";
}

/** Clover's message for an error, cut short. Error bodies describe the request, never the token. */
function messageOf(body: unknown): string {
  const b = (body ?? {}) as { message?: unknown; error?: unknown };
  const message = [b.message, typeof b.error === "object" && b.error ? (b.error as { message?: unknown }).message : b.error].find(
    (m): m is string => typeof m === "string" && m.trim() !== "",
  );
  return (message ?? "").slice(0, 200);
}

export function cloverClient(options: CloverClientOptions): CloverClient {
  const merchantId = options.merchantId?.trim() ?? "";
  if (!CLOVER_ID.test(merchantId)) throw new CloverConfigError("CLOVER_MERCHANT_ID must be the merchant's 13-character Clover ID");
  const region = options.region?.trim();
  if (!region || !Object.hasOwn(CLOVER_HOSTS, region)) {
    throw new CloverConfigError(`CLOVER_REGION must be one of ${Object.keys(CLOVER_HOSTS).join(", ")}`);
  }
  const baseUrl = CLOVER_HOSTS[region as CloverRegion];
  const auth = options.auth;
  const apiToken = "apiToken" in auth ? auth.apiToken?.trim() ?? "" : undefined;
  const appId = "appId" in auth ? auth.appId?.trim() ?? "" : undefined;
  if (apiToken === undefined && !appId) throw new CloverConfigError("set CLOVER_APP_ID with CLOVER_REFRESH_TOKEN, or CLOVER_API_TOKEN");
  if (apiToken !== undefined && !apiToken) throw new CloverConfigError("set CLOVER_API_TOKEN, or CLOVER_APP_ID with CLOVER_REFRESH_TOKEN");
  if (appId !== undefined && !CLOVER_ID.test(appId)) throw new CloverConfigError("CLOVER_APP_ID must be the app's 13-character Clover ID");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 5;
  const clock = options.clock ?? (() => Date.now());
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    const tokens = (auth as { tokens: CloverTokenStore }).tokens;
    const refreshToken = (await tokens.load()).trim();
    if (!refreshToken) throw new CloverConfigError("set CLOVER_REFRESH_TOKEN");
    const response = await doFetch(`${baseUrl}/oauth/v2/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: appId, refresh_token: refreshToken }),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; access_token_expiration?: unknown; refresh_token?: unknown };
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
      const hint = response.status === 401 ? "; reconnect the merchant to get a new refresh token" : "";
      throw new CloverApiError(`Clover refused the token refresh (HTTP ${response.status})${hint}`, response.status);
    }
    // Saved before anything else: Clover has already retired the old token, so losing this one would cut the connection.
    if (typeof body.refresh_token === "string" && body.refresh_token) await tokens.save(body.refresh_token);
    // Clover gives the expiry as Unix seconds and says not to assume a lifetime; without one, renew within the hour.
    const exp = typeof body.access_token_expiration === "number" && body.access_token_expiration > 0 ? body.access_token_expiration * 1000 : clock() + 3_600_000;
    access = { token: body.access_token, expiresAt: exp };
    return access.token;
  }

  async function accessToken(): Promise<string> {
    if (apiToken !== undefined) return apiToken;
    if (access && access.expiresAt - ACCESS_RENEW_EARLY_MS > clock()) return access.token;
    // One refresh at a time: a second would spend a refresh token the first already retired.
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function get(url: URL, allow404 = false): Promise<Record<string, unknown> | null> {
    // Checked here, right before sending, so no caller can reach another path, host or method.
    if (!isAllowedCloverRead(baseUrl, merchantId, url)) throw new CloverConfigError("the Clover connector only reads its listed merchant paths");
    let renewed = false;
    for (let attempt = 0; ; ) {
      // GET only: the connector never creates, updates or deletes anything in Clover.
      const response = await doFetch(url.toString(), { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${await accessToken()}` } });
      if (response.status === 401 && appId !== undefined && !renewed) {
        // An access token can be revoked before it expires; refresh once.
        renewed = true;
        access = null;
        continue;
      }
      if (response.status === 429) {
        if (attempt < retries) {
          const after = Number(response.headers.get("retry-after"));
          // Clover asks for at least a second's pause, longer each time.
          await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : 1000 * 2 ** attempt);
          attempt++;
          continue;
        }
        throw new CloverApiError("Clover kept rate-limiting the sync; the next run resumes from the checkpoint", 429);
      }
      if (response.status === 404 && allow404) return null;
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = messageOf(body);
        const hint =
          response.status === 401 || response.status === 403
            ? "; check that the app (or API token) has the Read merchant, orders, payments, inventory and customers permissions for this merchant"
            : "";
        throw new CloverApiError(`Clover answered HTTP ${response.status}${message ? `: ${message}` : ""}${hint}`, response.status);
      }
      if (!body || typeof body !== "object") throw new CloverApiError("Clover did not answer with JSON", response.status);
      return body as Record<string, unknown>;
    }
  }

  const root = `${baseUrl}/v3/merchants/${merchantId}`;

  return {
    baseUrl,
    async merchant() {
      return (await get(new URL(root)))!;
    },
    async list(resource, opts = {}) {
      if (!(CLOVER_RESOURCES as readonly string[]).includes(resource) || resource === ("merchant" as string)) {
        throw new CloverConfigError("the Clover connector only reads its listed merchant paths");
      }
      const url = new URL(`${root}/${resource}`);
      for (const filter of opts.filters ?? []) {
        if (typeof filter !== "string" || filter.length > 40 || !FILTER.test(filter)) throw new CloverConfigError("the Clover connector only filters by time");
        url.searchParams.append("filter", filter);
      }
      const expand = opts.expand ?? [];
      if (!expand.every((e) => CLOVER_EXPANDS[resource].includes(e))) throw new CloverConfigError(`the Clover connector doesn't expand that on ${resource}`);
      if (expand.length) url.searchParams.set("expand", expand.join(","));
      if (opts.orderBy !== undefined) {
        if (!ORDER_BY.has(opts.orderBy)) throw new CloverConfigError("the Clover connector only orders by modifiedTime or createdTime");
        url.searchParams.set("orderBy", opts.orderBy);
      }
      const limit = opts.limit ?? CLOVER_PAGE_SIZE;
      if (!Number.isInteger(limit) || limit < 1 || limit > CLOVER_PAGE_SIZE) throw new CloverConfigError(`limit must be a whole number from 1 to ${CLOVER_PAGE_SIZE}`);
      url.searchParams.set("limit", String(limit));
      const offset = opts.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0) throw new CloverConfigError("offset must be a whole number from 0");
      url.searchParams.set("offset", String(offset));
      const body = (await get(url))!;
      if (!Array.isArray(body.elements)) throw new CloverApiError(`Clover's ${resource} answer has no elements`, 200);
      return { elements: body.elements.filter((e): e is Record<string, unknown> => !!e && typeof e === "object") };
    },
    async item(itemId) {
      if (typeof itemId !== "string" || !CLOVER_ID.test(itemId)) throw new CloverConfigError("item IDs are 13-character Clover IDs");
      return get(new URL(`${root}/items/${itemId}`), true);
    },
  };
}
