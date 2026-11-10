import type { QuickBooksTokenStore } from "../quickbooks/client.js";

/**
 * A small client for Etsy's Open API v3. Read-only twice over: the shop is
 * connected with read scopes only, which the client checks with Etsy's own
 * token-scopes call after every refresh, and the only calls it makes to the
 * shop are the two GET lists here (receipts and listings). Its POSTs are the
 * OAuth token refresh and that scope check.
 *
 * Every v3 request carries the app's key and shared secret in x-api-key
 * (keystring:secret) and, for shop data, a bearer token that lasts an hour.
 * The refresh token lasts 90 days; whatever Etsy hands back is saved before
 * anything else, and only one refresh runs at a time. The first refresh
 * also checks the connection belongs to ETSY_SHOP_ID.
 *
 * Etsy limits calls per second and per rolling day and answers 429 with a
 * Retry-After estimate in seconds; that and 500, 502, 503 and 504 are waited
 * out a few times before the error goes to runSync, which keeps the
 * checkpoint.
 */

export const ETSY_API_URL = "https://api.etsy.com/v3/application";
export const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";

/** The scopes to connect with. Each one only reads. */
export const ETSY_READ_SCOPES = ["transactions_r", "listings_r"] as const;

/** Records asked for at a time (Etsy allows 1 to 100). */
export const ETSY_PAGE_SIZE = 100;

/** The listing states the connector reads, every one a shop can have. */
export const ETSY_LISTING_STATES = ["active", "sold_out", "inactive", "expired", "draft"] as const;
export type EtsyListingState = (typeof ETSY_LISTING_STATES)[number];

/** Etsy's earliest allowed time filter (2000-01-01), in epoch seconds. */
export const ETSY_EPOCH_MIN = 946_684_800;

/** Etsy's numeric ids. */
export const ETSY_ID = /^[1-9]\d{0,17}$/;
/** A scope that only reads, such as listings_r. */
const READ_SCOPE = /^[a-z]+_r$/;
/** Refreshed this long before the access token runs out. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** How long an access token is kept when Etsy's expires_in can't be read. */
const FALLBACK_TOKEN_S = 600;
const MAX_RETRY_AFTER_S = 60;

export type EtsyTokenStore = QuickBooksTokenStore;

export interface EtsyClientOptions {
  /** The app's keystring, from Etsy's Your Apps page; it is also the OAuth client id. */
  keystring: string;
  /** The app's shared secret. Sent to Etsy only and never logged or shown. */
  sharedSecret: string;
  /** The shop the connection must belong to. */
  shopId: string;
  tokens: EtsyTokenStore;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
  /** Milliseconds since the epoch; replaced in tests. */
  clock?: () => number;
}

export class EtsyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtsyConfigError";
  }
}

/** Etsy answered with an error. */
export class EtsyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EtsyApiError";
  }
}

export type EtsyRecord = Record<string, unknown>;

export interface EtsyReceiptQuery {
  /** created for the first import (min_created), updated for later syncs (min_last_modified). */
  by: "created" | "updated";
  /** Epoch seconds: receipts created or changed at or after this. */
  since: number;
  offset: number;
}

export interface EtsyClient {
  /** A page of the shop's receipts, oldest first by the chosen time. */
  receipts(query: EtsyReceiptQuery): Promise<EtsyRecord[]>;
  /** A page of the shop's listings in one state, with their inventory. */
  listings(state: EtsyListingState, offset: number): Promise<EtsyRecord[]>;
}

const isObject = (value: unknown): value is EtsyRecord => typeof value === "object" && value !== null && !Array.isArray(value);

/** The scopes in a token-scopes answer that aren't read scopes, or null when it isn't a list of scopes. */
export function etsyExtraScopes(body: unknown): string[] | null {
  const scopes = isObject(body) ? body.scopes : undefined;
  if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string")) return null;
  return (scopes as string[]).filter((s) => !READ_SCOPE.test(s));
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

const offsetOk = (offset: number) => Number.isSafeInteger(offset) && offset >= 0;

export function etsyClient(options: EtsyClientOptions): EtsyClient {
  const keystring = options.keystring?.trim() ?? "";
  const secret = options.sharedSecret?.trim() ?? "";
  if (!/^[A-Za-z0-9]{8,64}$/.test(keystring) || !/^[A-Za-z0-9]{6,128}$/.test(secret)) throw new EtsyConfigError("set ETSY_KEYSTRING and ETSY_SHARED_SECRET to the app's keystring and shared secret");
  const shopId = options.shopId?.trim() ?? "";
  if (!ETSY_ID.test(shopId)) throw new EtsyConfigError("ETSY_SHOP_ID must be the shop's numeric id");
  const apiKey = `${keystring}:${secret}`;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  const clock = options.clock ?? (() => Date.now());
  let access: { token: string; until: number } | null = null;
  let refreshing: Promise<string> | null = null;
  let shopChecked = false;

  /** Sends a request, waiting out rate limits and brief outages. */
  async function send(request: () => Promise<Response>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await request();
      const busy = response.status === 429 || (response.status >= 500 && response.status !== 501 && response.status <= 504);
      if (!busy || attempt >= retries) return response;
      const after = response.headers.get("retry-after");
      const seconds = after !== null && /^\d{1,6}$/.test(after.trim()) ? Number(after.trim()) : 0;
      await sleep(1000 * (seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_S) : 2 ** attempt));
    }
  }

  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

  async function refresh(): Promise<string> {
    const refreshToken = (await options.tokens.load()).trim();
    if (!refreshToken) throw new EtsyConfigError("set ETSY_REFRESH_TOKEN");
    const response = await send(() =>
      doFetch(ETSY_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form({ grant_type: "refresh_token", client_id: keystring, refresh_token: refreshToken }),
      }),
    );
    const raw = await readJson(response);
    const body: EtsyRecord = isObject(raw) ? raw : {};
    const token = body.access_token;
    if (response.status !== 200 || typeof token !== "string" || !/^\S{16,8192}$/.test(token)) {
      const code = typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : undefined;
      throw new EtsyApiError(`Etsy turned down the token refresh (HTTP ${response.status}${code ? `, ${code}` : ""}); reconnect the shop to get a new refresh token`, response.status);
    }
    // Saved before anything else, so a refresh token Etsy replaced is never lost.
    if (typeof body.refresh_token === "string" && body.refresh_token.trim()) await options.tokens.save(body.refresh_token.trim());

    // Etsy's token answer doesn't list scopes, so the client asks. A connection that could change anything is not used.
    const scopes = await send(() =>
      doFetch(`${ETSY_API_URL}/scopes`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form({ token }),
      }),
    );
    const granted = scopes.status === 200 ? await readJson(scopes) : undefined;
    const extra = etsyExtraScopes(granted);
    if (extra === null) throw new EtsyConfigError(`Etsy did not say which scopes the connection has (HTTP ${scopes.status}); the connector won't read without knowing it can only read`);
    if (extra.length) throw new EtsyConfigError(`the Etsy connection can change data (${extra.slice(0, 5).join(", ")}); reconnect it with only ${ETSY_READ_SCOPES.join(" ")}`);
    const missing = ETSY_READ_SCOPES.filter((s) => !(granted as { scopes: string[] }).scopes.includes(s));
    if (missing.length) throw new EtsyConfigError(`the Etsy connection is missing ${missing.join(" ")}; reconnect it with ${ETSY_READ_SCOPES.join(" ")}`);

    const expires = body.expires_in;
    const seconds = Number.isInteger(expires) && (expires as number) > 0 && (expires as number) < 10_000_000 ? (expires as number) : FALLBACK_TOKEN_S;
    access = { token, until: clock() + seconds * 1000 - TOKEN_MARGIN_MS };

    if (!shopChecked) {
      const me = await read("account", `${ETSY_API_URL}/users/me`, token);
      if (!isObject(me) || String(me.shop_id) !== shopId) {
        access = null;
        throw new EtsyConfigError("the Etsy connection belongs to a different shop than ETSY_SHOP_ID");
      }
      shopChecked = true;
    }
    return token;
  }

  async function accessToken(): Promise<string> {
    if (access && access.until > clock()) return access.token;
    // One refresh at a time: a second would spend a refresh token the first may have replaced.
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** A GET: refreshed once on 401, and an error for anything but 200. */
  async function read(what: string, url: string, bearer?: string): Promise<unknown> {
    for (let renewed = false; ; renewed = true) {
      const token = bearer ?? (await accessToken());
      const response = await send(() => doFetch(url, { method: "GET", headers: { "x-api-key": apiKey, authorization: `Bearer ${token}`, accept: "application/json" } }));
      if (response.status === 401 && !renewed && bearer === undefined) {
        // An access token can be revoked before it runs out; refresh once.
        access = null;
        continue;
      }
      if (response.status === 429) throw new EtsyApiError(`Etsy kept rate-limiting the ${what} reads; the next sync picks up from the checkpoint`, 429);
      if (response.status === 401 || response.status === 403) throw new EtsyApiError(`Etsy turned down the ${what} read (HTTP ${response.status}): check the connection has ${ETSY_READ_SCOPES.join(" ")}`, response.status);
      if (response.status !== 200) throw new EtsyApiError(`Etsy ${what} answered HTTP ${response.status}`, response.status);
      const body = await readJson(response);
      if (body === undefined) throw new EtsyApiError(`Etsy ${what} did not answer with JSON`, 200);
      return body;
    }
  }

  /** The results of a paged list; a body without them throws, so a sync never skips records unseen. */
  async function page(what: string, url: string): Promise<EtsyRecord[]> {
    const body = await read(what, url);
    if (!isObject(body) || !Array.isArray(body.results)) throw new EtsyApiError(`Etsy ${what} answered without a results list`, 200);
    return body.results.filter(isObject);
  }

  const shop = `${ETSY_API_URL}/shops/${shopId}`;

  return {
    async receipts(query) {
      if (query.by !== "created" && query.by !== "updated") throw new EtsyConfigError("receipts are read by created or updated time");
      if (!Number.isSafeInteger(query.since) || query.since < ETSY_EPOCH_MIN) throw new EtsyConfigError("since must be epoch seconds from 2000");
      if (!offsetOk(query.offset)) throw new EtsyConfigError("offset must be a whole number from 0");
      const filter = query.by === "created" ? "min_created" : "min_last_modified";
      // GET only: the connector never creates, changes or deletes anything on Etsy.
      return page("receipts", `${shop}/receipts?${filter}=${query.since}&sort_on=${query.by}&sort_order=asc&limit=${ETSY_PAGE_SIZE}&offset=${query.offset}`);
    },

    async listings(state, offset) {
      if (!ETSY_LISTING_STATES.includes(state)) throw new EtsyConfigError("not a listing state this connector reads");
      if (!offsetOk(offset)) throw new EtsyConfigError("offset must be a whole number from 0");
      return page("listings", `${shop}/listings?state=${state}&includes=Inventory&limit=${ETSY_PAGE_SIZE}&offset=${offset}`);
    },
  };
}
