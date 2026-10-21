/**
 * A small client for the QuickBooks Online Accounting API. Read-only: the
 * only requests it sends to the company are GETs of the query and change
 * data capture endpoints, and a query must be a SELECT. Its one POST is the
 * OAuth token refresh, which goes to Intuit's sign-in service, never to the
 * company.
 *
 * Intuit offers no read-only accounting scope, so read-only is enforced
 * here, in code, rather than by the token.
 *
 * Access tokens last an hour and are refreshed with the refresh token.
 * Intuit rotates the refresh token about once a day, and only the newest one
 * is sure to keep working, so every refresh token Intuit returns is handed to
 * the token store before it is used.
 */

/** The minor version the connector was built against. Intuit retired 1 to 74 in August 2025. */
export const QUICKBOOKS_MINOR_VERSION = 75;
export const QUICKBOOKS_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QUICKBOOKS_API_URLS = {
  production: "https://quickbooks.api.intuit.com",
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
} as const;
export type QuickBooksEnvironment = keyof typeof QUICKBOOKS_API_URLS;

/** Intuit's cap on MAXRESULTS. */
export const QUICKBOOKS_PAGE_SIZE = 1000;

/** Where the newest refresh token lives. The instance keeps it encrypted in its database. */
export interface QuickBooksTokenStore {
  load(): Promise<string>;
  save(refreshToken: string): Promise<void>;
}

/** Keeps the refresh token in memory only: for tests and one-off runs. A restart goes back to the first token. */
export function memoryTokenStore(refreshToken: string): QuickBooksTokenStore & { readonly current: string } {
  let current = refreshToken;
  return {
    get current() {
      return current;
    },
    load: async () => current,
    save: async (token) => {
      current = token;
    },
  };
}

export interface QuickBooksClientOptions {
  clientId: string;
  clientSecret: string;
  /** The company's realm ID, shown as the Company ID in QuickBooks. */
  realmId: string;
  environment: QuickBooksEnvironment | string;
  tokens: QuickBooksTokenStore;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Milliseconds since the epoch; replaced in tests to expire access tokens. */
  clock?: () => number;
}

export class QuickBooksConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuickBooksConfigError";
  }
}

/** QuickBooks or Intuit's sign-in service answered with an error. `code` is Intuit's error code when it gives one. */
export class QuickBooksApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "QuickBooksApiError";
    this.status = status;
    this.code = code;
  }
}

/** One page of a query: the entities under their own name, as Intuit returns them. */
export interface QuickBooksQueryResponse {
  QueryResponse: Record<string, unknown> & { startPosition?: number; maxResults?: number };
  time?: string;
}

export interface QuickBooksCdcResponse {
  CDCResponse: { QueryResponse: Record<string, unknown>[] }[];
  time?: string;
}

export interface QuickBooksClient {
  query(statement: string): Promise<QuickBooksQueryResponse>;
  /** Change data capture: entities changed (deleted ones included) since a time no more than 30 days back. */
  cdc(entities: readonly string[], changedSince: string): Promise<QuickBooksCdcResponse>;
}

const REALM = /^\d{1,20}$/;
const ENTITY = /^[A-Z][A-Za-z]+$/;
/** The only statements the client sends: SELECT * FROM an entity, an optional WHERE, ORDERBY, and paging. */
const SELECT = /^SELECT \* FROM [A-Z][A-Za-z]+( WHERE [^;]+?)?( ORDERBY [A-Za-z.]+( ASC| DESC)?)? STARTPOSITION \d+ MAXRESULTS \d+$/;
const ACCESS_RENEW_EARLY_MS = 5 * 60_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Fault {
  Fault?: { Error?: { Message?: string; Detail?: string; code?: string }[]; type?: string };
}

/** Intuit's message and code, cut short. Fault messages describe the request, never the token. */
function faultOf(body: unknown): { message: string; code: string | undefined } {
  const error = (body as Fault | null)?.Fault?.Error?.[0];
  const message = [error?.Message, error?.Detail].filter((m): m is string => typeof m === "string" && m !== "").join(": ");
  return { message: message.slice(0, 200), code: typeof error?.code === "string" ? error.code.slice(0, 20) : undefined };
}

export function quickBooksClient(options: QuickBooksClientOptions): QuickBooksClient {
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!clientId || !clientSecret) throw new QuickBooksConfigError("set QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET");
  const realmId = options.realmId?.trim() ?? "";
  if (!REALM.test(realmId)) throw new QuickBooksConfigError("QUICKBOOKS_REALM_ID must be the company's numeric Company ID");
  const environment = options.environment?.trim();
  if (environment !== "production" && environment !== "sandbox") throw new QuickBooksConfigError("QUICKBOOKS_ENVIRONMENT must be production or sandbox");
  const base = `${QUICKBOOKS_API_URLS[environment]}/v3/company/${realmId}`;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  const clock = options.clock ?? (() => Date.now());
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    const refreshToken = (await options.tokens.load()).trim();
    if (!refreshToken) throw new QuickBooksConfigError("set QUICKBOOKS_REFRESH_TOKEN");
    const response = await doFetch(QUICKBOOKS_TOKEN_URL, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown };
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
      // invalid_grant means the refresh token expired or was revoked: the company needs reconnecting.
      const code = typeof body.error === "string" ? body.error.slice(0, 40) : undefined;
      const hint = code === "invalid_grant" ? "; reconnect QuickBooks to get a new refresh token" : "";
      throw new QuickBooksApiError(`Intuit refused the token refresh (HTTP ${response.status}${code ? `, ${code}` : ""})${hint}`, response.status, code);
    }
    // Saved before it is used: if saving fails, the old token still works and nothing is lost.
    if (typeof body.refresh_token === "string" && body.refresh_token) await options.tokens.save(body.refresh_token);
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    access = { token: body.access_token, expiresAt: clock() + seconds * 1000 };
    return access.token;
  }

  async function accessToken(): Promise<string> {
    if (access && access.expiresAt - ACCESS_RENEW_EARLY_MS > clock()) return access.token;
    // One refresh at a time: a second would spend a refresh token the first already rotated.
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function get<T>(path: string, params: Record<string, string>): Promise<T> {
    const query = new URLSearchParams({ ...params, minorversion: String(QUICKBOOKS_MINOR_VERSION) });
    const url = `${base}${path}?${query.toString()}`;
    let renewed = false;
    for (let attempt = 0; ; ) {
      // GET only: the connector never creates, updates or deletes anything in QuickBooks.
      const response = await doFetch(url, { method: "GET", headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" } });
      if (response.status === 401 && !renewed) {
        // An access token can be revoked before it expires; refresh once.
        renewed = true;
        access = null;
        continue;
      }
      if (response.status === 429 && attempt < retries) {
        await sleep(1000 * 2 ** attempt++);
        continue;
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const { message, code } = faultOf(body);
        throw new QuickBooksApiError(`QuickBooks answered HTTP ${response.status}${message ? `: ${message}` : ""}`, response.status, code);
      }
      // Some faults come back with HTTP 200.
      if ((body as Fault | null)?.Fault) {
        const { message, code } = faultOf(body);
        throw new QuickBooksApiError(`QuickBooks answered with a fault${message ? `: ${message}` : ""}`, response.status, code);
      }
      return body as T;
    }
  }

  return {
    async query(statement) {
      if (!SELECT.test(statement)) throw new QuickBooksConfigError("the QuickBooks connector only sends SELECT queries");
      const body = await get<QuickBooksQueryResponse>("/query", { query: statement });
      if (!body || typeof body.QueryResponse !== "object" || body.QueryResponse === null) throw new QuickBooksApiError("QuickBooks did not answer with a QueryResponse", 200);
      return body;
    },
    async cdc(entities, changedSince) {
      if (entities.length === 0 || !entities.every((e) => ENTITY.test(e))) throw new QuickBooksConfigError("cdc needs entity names");
      if (Number.isNaN(Date.parse(changedSince))) throw new QuickBooksConfigError("cdc needs a changedSince time");
      const body = await get<QuickBooksCdcResponse>("/cdc", { entities: entities.join(","), changedSince });
      if (!body || !Array.isArray(body.CDCResponse)) throw new QuickBooksApiError("QuickBooks did not answer with a CDCResponse", 200);
      return body;
    },
  };
}
