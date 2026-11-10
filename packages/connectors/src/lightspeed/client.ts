import type { QuickBooksTokenStore } from "../quickbooks/client.js";

/**
 * A small client for the Lightspeed Retail (X-Series) API. Read-only twice
 * over: the store is connected with read scopes only, which the client
 * checks on every token Lightspeed hands back, and the only calls it makes
 * to the store are the reads listed here. Its POSTs are the OAuth token
 * refresh and Lightspeed's inventory list, which is a search sent as a POST
 * and needs only inventory:read.
 *
 * Every refresh returns a new refresh token and revokes the old access
 * token, so the new refresh token is handed to the token store before
 * anything else, and only one refresh runs at a time.
 *
 * Lightspeed allows 300 calls per register plus 50 every five minutes and
 * answers 429 with a Retry-After header (seconds or an HTTP date). Calls go
 * one at a time; a 429 or a 502, 503 or 504 is waited out a few times
 * before the error goes to runSync, which keeps the checkpoint.
 */

/** The dated API version the connector reads. */
export const LIGHTSPEED_API_VERSION = "2026-10";

/** The scopes to connect with. Each one only reads. */
export const LIGHTSPEED_READ_SCOPES = ["products:read", "inventory:read", "customers:read", "sales:read"] as const;

/** The version-paged lists the client may read, and nothing else. */
export const LIGHTSPEED_COLLECTIONS = ["products", "customers", "sales"] as const;
export type LightspeedCollection = (typeof LIGHTSPEED_COLLECTIONS)[number];

/** Inventory records asked for at a time (Lightspeed allows 1 to 5000). */
export const LIGHTSPEED_INVENTORY_PAGE = 1000;

/** A store's domain prefix: the part before .retail.lightspeed.app. */
export const LIGHTSPEED_DOMAIN_PREFIX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Lightspeed's object IDs. */
export const LIGHTSPEED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A scope that only reads, such as sales:read or products:read:costs. */
const READ_SCOPE = /^[a-z_]+:read(:[a-z_]+)?$/;
/** Refreshed this long before the access token runs out. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** How long an access token is kept when Lightspeed's expires_in can't be read. */
const FALLBACK_TOKEN_S = 600;
const MAX_RETRY_AFTER_S = 60;

export type LightspeedTokenStore = QuickBooksTokenStore;

export interface LightspeedClientOptions {
  /** The store's domain prefix, as in https://<prefix>.retail.lightspeed.app. */
  domainPrefix: string;
  clientId: string;
  /** Sent to Lightspeed only and never logged or shown. */
  clientSecret: string;
  tokens: LightspeedTokenStore;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
  /** Milliseconds since the epoch; replaced in tests. */
  clock?: () => number;
}

export class LightspeedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LightspeedConfigError";
  }
}

/** Lightspeed answered with an error. */
export class LightspeedApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LightspeedApiError";
  }
}

export type LightspeedRecord = Record<string, unknown>;

export interface LightspeedPage {
  data: LightspeedRecord[];
  /** The highest version in the page, which the next page starts after; null once the list is read to its end. */
  max: number | null;
}

export interface LightspeedClient {
  /** Records with a version above `after`, lowest version first. */
  list(collection: LightspeedCollection, after: number): Promise<LightspeedPage>;
  /** Up to LIGHTSPEED_INVENTORY_PAGE inventory records with a version above `after`, lowest first. */
  inventory(after: number): Promise<LightspeedRecord[]>;
  /** One product, or null when Lightspeed has no product with that ID. */
  product(id: string): Promise<LightspeedRecord | null>;
}

const isObject = (value: unknown): value is LightspeedRecord => typeof value === "object" && value !== null && !Array.isArray(value);
/** A version number: a whole number from 0, within what JSON keeps exactly. */
export const isLightspeedVersion = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** The scopes beyond reading in a token response's space-separated scope. */
export const lightspeedWriteScopes = (scope: string) => scope.split(" ").filter((s) => s && !READ_SCOPE.test(s));

/** Seconds to wait from a Retry-After header, in seconds or as an HTTP date; null when it can't be read. */
export function lightspeedRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  if (/^\d{1,6}$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function lightspeedClient(options: LightspeedClientOptions): LightspeedClient {
  const prefix = options.domainPrefix?.trim().toLowerCase() ?? "";
  if (!LIGHTSPEED_DOMAIN_PREFIX.test(prefix)) throw new LightspeedConfigError("LIGHTSPEED_DOMAIN_PREFIX must be the store's prefix, the part before .retail.lightspeed.app");
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!/^\S{8,256}$/.test(clientId) || !/^\S{8,512}$/.test(clientSecret)) throw new LightspeedConfigError("set LIGHTSPEED_CLIENT_ID and LIGHTSPEED_CLIENT_SECRET");
  const host = `https://${prefix}.retail.lightspeed.app`;
  const api = `${host}/api/${LIGHTSPEED_API_VERSION}`;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  const clock = options.clock ?? (() => Date.now());
  let access: { token: string; until: number } | null = null;
  let refreshing: Promise<string> | null = null;

  /** Sends a request, waiting out rate limits and brief outages. */
  async function send(request: () => Promise<Response>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await request();
      const busy = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
      if (!busy || attempt >= retries) return response;
      const after = lightspeedRetryAfter(response.headers.get("retry-after"), clock());
      await sleep(1000 * (after !== null && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) : 2 ** attempt));
    }
  }

  async function refresh(): Promise<string> {
    const refreshToken = (await options.tokens.load()).trim();
    if (!refreshToken) throw new LightspeedConfigError("set LIGHTSPEED_REFRESH_TOKEN");
    const response = await send(() =>
      doFetch(`${host}/api/1.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
      }),
    );
    const raw = await readJson(response);
    const body: LightspeedRecord = isObject(raw) ? raw : {};
    const token = body.access_token;
    if (!response.ok || typeof token !== "string" || !/^\S{16,8192}$/.test(token)) {
      const code = typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : undefined;
      throw new LightspeedApiError(`Lightspeed turned down the token refresh (HTTP ${response.status}${code ? `, ${code}` : ""}); reconnect the store to get a new refresh token`, response.status);
    }
    // Saved before anything else: Lightspeed has already replaced the old token, so losing this one would cut the connection.
    if (typeof body.refresh_token === "string" && body.refresh_token.trim()) await options.tokens.save(body.refresh_token.trim());
    if (typeof body.domain_prefix === "string" && body.domain_prefix.toLowerCase() !== prefix) {
      throw new LightspeedConfigError("the Lightspeed connection belongs to a different store than LIGHTSPEED_DOMAIN_PREFIX");
    }
    // Lightspeed lists the scopes actually granted. A connection that could change anything is not used.
    if (typeof body.scope !== "string" || !body.scope.trim()) throw new LightspeedConfigError("Lightspeed did not say which scopes the connection has; reconnect it with only " + LIGHTSPEED_READ_SCOPES.join(" "));
    const extra = lightspeedWriteScopes(body.scope);
    if (extra.length) throw new LightspeedConfigError(`the Lightspeed connection can change data (${extra.slice(0, 5).join(", ")}); reconnect it with only ${LIGHTSPEED_READ_SCOPES.join(" ")}`);
    const expires = body.expires_in;
    const seconds = Number.isInteger(expires) && (expires as number) > 0 && (expires as number) < 10_000_000 ? (expires as number) : FALLBACK_TOKEN_S;
    access = { token, until: clock() + seconds * 1000 - TOKEN_MARGIN_MS };
    return token;
  }

  async function accessToken(): Promise<string> {
    if (access && access.until > clock()) return access.token;
    // One refresh at a time: a second would spend a refresh token the first already replaced.
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** A read: refreshed once on 401, and an error for anything but 200 (and 404 where asked). */
  async function read(what: string, url: string, init: { method: "GET" | "POST"; body?: string }, missingOk = false): Promise<unknown> {
    for (let renewed = false; ; renewed = true) {
      const bearer = await accessToken();
      const headers: Record<string, string> = { authorization: `Bearer ${bearer}`, accept: "application/json" };
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const response = await send(() => doFetch(url, { method: init.method, headers, ...(init.body !== undefined ? { body: init.body } : {}) }));
      if (response.status === 401 && !renewed) {
        // An access token can be revoked before it runs out; refresh once.
        access = null;
        continue;
      }
      if (response.status === 404 && missingOk) return null;
      if (response.status === 429) throw new LightspeedApiError(`Lightspeed kept rate-limiting the ${what} reads; the next sync picks up from the checkpoint`, 429);
      if (response.status === 401 || response.status === 403) throw new LightspeedApiError(`Lightspeed turned down the ${what} read (HTTP ${response.status}): check the connection has ${LIGHTSPEED_READ_SCOPES.join(" ")}`, response.status);
      if (response.status !== 200) throw new LightspeedApiError(`Lightspeed ${what} answered HTTP ${response.status}`, response.status);
      const body = await readJson(response);
      if (body === undefined) throw new LightspeedApiError(`Lightspeed ${what} did not answer with JSON`, 200);
      return body;
    }
  }

  const checkAfter = (after: number) => {
    if (!isLightspeedVersion(after)) throw new LightspeedConfigError("after must be a version number");
  };

  return {
    async list(collection, after) {
      if (!LIGHTSPEED_COLLECTIONS.includes(collection)) throw new LightspeedConfigError("not a Lightspeed list this connector reads");
      checkAfter(after);
      // GET only: the connector never creates, changes or deletes anything in Lightspeed.
      const body = await read(collection, `${api}/${collection}?after=${after}`, { method: "GET" });
      if (!isObject(body) || !Array.isArray(body.data)) throw new LightspeedApiError(`Lightspeed ${collection} answered without a data list`, 200);
      const data = body.data.filter(isObject);
      const max = isObject(body.version) ? body.version.max : undefined;
      if (data.length === 0) return { data, max: null };
      // Each page has to move forward, or the list would be read forever.
      if (!isLightspeedVersion(max) || max <= after) throw new LightspeedApiError(`Lightspeed ${collection} answered a page without a newer version`, 200);
      return { data, max };
    },

    async inventory(after) {
      checkAfter(after);
      // Lightspeed's inventory list is a search sent as a POST; it reads only and needs only inventory:read.
      const body = await read("inventory", `${api}/inventory`, { method: "POST", body: JSON.stringify({ after, size: LIGHTSPEED_INVENTORY_PAGE, sort_direction: "asc" }) });
      if (!Array.isArray(body)) throw new LightspeedApiError("Lightspeed inventory answered without a list", 200);
      return body.filter(isObject);
    },

    async product(id) {
      if (!LIGHTSPEED_ID.test(id)) throw new LightspeedConfigError("not a Lightspeed product ID");
      const body = await read("product", `${api}/products/${id}`, { method: "GET" }, true);
      return isObject(body) && isObject(body.data) ? body.data : null;
    },
  };
}
