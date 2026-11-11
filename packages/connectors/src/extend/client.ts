import { WHATNOT_USER_AGENT } from "../whatnot/client.js";

/**
 * A small client for Extend's merchant API, read-only. A store admin makes
 * an API Integration in the Extend Merchant Portal and gets a client ID and
 * secret, which this client trades at `/auth/oauth/token` for a short-lived
 * access token. The token goes in the `X-Extend-Access-Token` header, not
 * as a bearer token.
 *
 * Extend documents no read-only scope for contracts or orders: the docs say
 * the client ID and secret carry broad privileges. So read-only is enforced
 * here, in code. Apart from the token exchange, the client sends GET
 * requests to two searches, with query strings it builds itself, and has no
 * way to send anything else:
 *
 * - `GET /contracts/search?sellerId=...&typeFilter=pcrs&showAll=true`, the
 *   store's product protection contracts. Extend documents no paging for
 *   it: one answer holds every contract.
 * - `GET /orders/search?storeId=...`, the store's orders, a page at a time.
 *   Extend's answer carries `nextPageCursor`, and this client sends it back
 *   as `cursor`, the name Extend's line item search gives the same cursor.
 *
 * Errors come back as {code, message}. Only the code is kept, never the
 * message. A 429 or 500, 502, 503 or 504 is waited out a few times,
 * honoring Retry-After, before the error goes to runSync.
 */

export const EXTEND_API_URLS = { production: "https://api.helloextend.com", demo: "https://api-demo.helloextend.com" } as const;
export type ExtendEnvironment = keyof typeof EXTEND_API_URLS;
export const EXTEND_TOKEN_PATH = "/auth/oauth/token";
export const EXTEND_CONTRACTS_PATH = "/contracts/search";
export const EXTEND_ORDERS_PATH = "/orders/search";
/** The dated API version the reference pages give, sent in the Accept header. */
export const EXTEND_API_VERSION = "2022-02-01";
export const EXTEND_ACCEPT = `application/json; version=${EXTEND_API_VERSION}`;
/** The contract type for product protection; shipping protection is left out. */
export const EXTEND_CONTRACT_TYPE = "pcrs";
/** The same User-Agent the other connectors send. */
export const EXTEND_USER_AGENT = WHATNOT_USER_AGENT;
/** The client assertion type the authentication page has the token request send. */
export const EXTEND_CLIENT_ASSERTION = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** Extend doesn't say what client IDs and secrets look like, so any 8 to 512 visible ASCII characters are taken. */
const CREDENTIAL = /^[!-~]{8,512}$/;
/** A store ID is a UUID, as the docs' examples are. */
const STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9._~+/=-]{8,8192}$/;
/** Extend's cursors are opaque; the docs' example is base64. */
const CURSOR_MAX = 4096;
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_WAIT_S = 60;
/** A token is renewed this long before Extend says it runs out. */
const TOKEN_MARGIN_MS = 60_000;
const RETRIED = new Set([429, 500, 502, 503, 504]);

export interface ExtendClientOptions {
  /** The API Integration's client ID. Sent to Extend only, and never logged or shown. */
  clientId: string;
  /** The API Integration's client secret. Sent to Extend only, and never logged or shown. */
  clientSecret: string;
  /** The store's ID in Extend: the seller its contracts are searched by and the store its orders are. */
  storeId: string;
  /** Extend's production API, or its demo environment. Defaults to production. */
  environment?: ExtendEnvironment | undefined;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
  now?: () => Date;
}

export class ExtendConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtendConfigError";
  }
}

/** Extend answered with an error. `code` is Extend's error code, when it gives one that reads. */
export class ExtendApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ExtendApiError";
  }
}

/** One page of orders, and Extend's cursor for the next, null after the last. */
export interface ExtendOrderPage {
  orders: unknown[];
  nextCursor: string | null;
}

export interface ExtendClient {
  readonly baseUrl: string;
  /** Every product protection contract of the store. */
  contracts(): Promise<unknown[]>;
  /** A page of the store's orders: the first for null, else the one Extend's cursor points at. */
  orders(cursor: string | null): Promise<ExtendOrderPage>;
}

export const isExtendCursor = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= CURSOR_MAX && /^[!-~]+$/.test(v);

/** Extend's error code, when it gives one that reads. The message is never kept. */
function codeOf(body: unknown): string | undefined {
  const code = (typeof body === "object" && body !== null ? body : {}) as { code?: unknown };
  return typeof code.code === "string" && CODE.test(code.code) ? code.code : undefined;
}

export function extendClient(options: ExtendClientOptions): ExtendClient {
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  const storeId = options.storeId?.trim().toLowerCase() ?? "";
  if (!CREDENTIAL.test(clientId)) throw new ExtendConfigError("set EXTEND_CLIENT_ID to the client ID of an API Integration made in the Extend Merchant Portal");
  if (!CREDENTIAL.test(clientSecret)) throw new ExtendConfigError("set EXTEND_CLIENT_SECRET to the client secret of the same Extend API Integration");
  if (!STORE_ID.test(storeId)) throw new ExtendConfigError("set EXTEND_STORE_ID to the store's ID in Extend, a UUID shown in the Merchant Portal");
  const environment = options.environment ?? "production";
  if (!Object.hasOwn(EXTEND_API_URLS, environment)) throw new ExtendConfigError("EXTEND_ENVIRONMENT must be production or demo");
  const baseUrl = EXTEND_API_URLS[environment];
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  const now = options.now ?? (() => new Date());
  let token: { value: string; until: number } | null = null;

  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, init);
      if (!RETRIED.has(response.status) || attempt >= retries) return response;
      const after = Number(response.headers.get("retry-after"));
      await sleep(Number.isSafeInteger(after) && after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : 1000 * 2 ** attempt);
    }
  }

  async function accessToken(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const response = await send(`${baseUrl}${EXTEND_TOKEN_PATH}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": EXTEND_USER_AGENT },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, client_assertion: EXTEND_CLIENT_ASSERTION }),
    });
    const { status } = response;
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (status === 400 || status === 401 || status === 403) {
      throw new ExtendConfigError(`Extend turned down EXTEND_CLIENT_ID and EXTEND_CLIENT_SECRET (HTTP ${status}); they must be an API Integration's client ID and secret from the ${environment} Merchant Portal`);
    }
    if (status !== 200) throw new ExtendApiError(`Extend answered HTTP ${status} for a token`, status, codeOf(body));
    const value = body?.access_token;
    if (typeof value !== "string" || !TOKEN.test(value)) throw new ExtendApiError("Extend answered without a token", status);
    // A lifetime that is missing or not a whole number of seconds means the token is asked for again next time.
    const seconds = Number.isSafeInteger(body!.expires_in) && (body!.expires_in as number) > 0 ? (body!.expires_in as number) : 0;
    token = { value, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return value;
  }

  async function get(path: string, query: URLSearchParams, what: string): Promise<unknown> {
    const url = `${baseUrl}${path}?${query}`;
    let response: Response | undefined;
    // A token Extend stops taking before it runs out is renewed once.
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = { accept: EXTEND_ACCEPT, "content-type": "application/json", "user-agent": EXTEND_USER_AGENT, "x-extend-access-token": await accessToken() };
      // GET only, with the token in its header and never in the URL.
      response = await send(url, { method: "GET", headers });
      if (response.status !== 401) break;
      token = null;
    }
    const { status } = response!;
    const body: unknown = await response!.json().catch(() => null);
    const code = codeOf(body);
    if (status === 401 || status === 403) {
      throw new ExtendConfigError(`Extend turned down the token for the ${what} (HTTP ${status}${code ? `, ${code}` : ""}); EXTEND_STORE_ID must be the store the API Integration in EXTEND_CLIENT_ID was made for`);
    }
    if (status !== 200) throw new ExtendApiError(`Extend answered HTTP ${status} for the ${what}${code ? ` (${code})` : ""}`, status, code);
    return body;
  }

  return {
    baseUrl,
    async contracts() {
      const body = (await get(EXTEND_CONTRACTS_PATH, new URLSearchParams({ sellerId: storeId, typeFilter: EXTEND_CONTRACT_TYPE, showAll: "true" }), "contracts")) as { contracts?: unknown } | null;
      if (!Array.isArray(body?.contracts)) throw new ExtendApiError("Extend answered the contracts without a list that reads", 200);
      return body.contracts;
    },
    async orders(cursor) {
      if (cursor !== null && !isExtendCursor(cursor)) throw new ExtendApiError(`a cursor for the orders must be 1 to ${CURSOR_MAX} visible characters`, 0);
      const query = new URLSearchParams({ storeId });
      if (cursor !== null) query.set("cursor", cursor);
      const body = (await get(EXTEND_ORDERS_PATH, query, "orders")) as { orders?: unknown; nextPageCursor?: unknown } | null;
      const next = body?.nextPageCursor === undefined || body.nextPageCursor === null || body.nextPageCursor === "" ? null : body.nextPageCursor;
      if (!Array.isArray(body?.orders) || (next !== null && !isExtendCursor(next))) throw new ExtendApiError("Extend answered the orders without a page that reads", 200);
      // A cursor that comes back unchanged would read the same page forever.
      if (next !== null && next === cursor) throw new ExtendApiError("Extend answered the orders with the same cursor again", 200);
      return { orders: body.orders, nextCursor: next };
    },
  };
}
