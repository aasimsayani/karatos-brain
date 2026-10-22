/**
 * A small client for Plaid's API. Read-only: every Plaid endpoint is a POST,
 * so the method says nothing about what a call does, and the client instead
 * keeps an allowlist of the read endpoints it may call. Anything else, such
 * as /transfer/create, /item/remove or /processor/token/create, is refused
 * before a request is built.
 *
 * The client ID and secret go in the PLAID-CLIENT-ID and PLAID-SECRET
 * headers rather than the JSON body, which Plaid accepts either way. That
 * keeps them out of every request body, so a body logged while debugging, or
 * echoed back in an error, can never carry them. The access token has no
 * header form and goes in the body.
 *
 * The Item's access token is long-lived and doesn't rotate: it is set once,
 * when the business links its bank through Plaid Link, and is replaced only
 * when the bank is linked again.
 */

/** The API version the connector was built against, sent on every request so a dashboard default can't change it. */
export const PLAID_API_VERSION = "2020-09-14";
export const PLAID_API_URLS = {
  production: "https://production.plaid.com",
  sandbox: "https://sandbox.plaid.com",
} as const;
export type PlaidEnvironment = keyof typeof PLAID_API_URLS;

/** The only endpoints the client calls. Each one reads; none moves money or changes the Item. */
export const PLAID_READ_ENDPOINTS = ["/accounts/get", "/transactions/sync", "/item/get", "/webhook_verification_key/get"] as const;
export type PlaidReadEndpoint = (typeof PLAID_READ_ENDPOINTS)[number];

/** Plaid's cap on `count` for /transactions/sync. */
export const PLAID_SYNC_PAGE_SIZE = 500;
/** Plaid's most history, 24 months. It applies only on the first sync of an Item whose transactions haven't started yet. */
export const PLAID_DAYS_REQUESTED = 730;

export interface PlaidClientOptions {
  clientId: string;
  secret: string;
  /** The Item's access token, from exchanging the public token Plaid Link returns. */
  accessToken: string;
  environment: PlaidEnvironment | string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate-limited request is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class PlaidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaidConfigError";
  }
}

/** Plaid answered with an error. `code` and `type` are Plaid's error_code and error_type. */
export class PlaidApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly type: string | undefined;

  constructor(message: string, status: number, code?: string, type?: string) {
    super(message);
    this.name = "PlaidApiError";
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

/** One transaction as Plaid returns it. Only the fields the connector reads are named. */
export interface PlaidTransaction {
  transaction_id?: string;
  account_id?: string;
  amount?: number;
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
  date?: string;
  authorized_date?: string | null;
  pending?: boolean;
  name?: string | null;
  merchant_name?: string | null;
  check_number?: string | null;
  personal_finance_category?: { primary?: string; detailed?: string } | null;
  [field: string]: unknown;
}

export interface PlaidRemovedTransaction {
  transaction_id?: string;
  account_id?: string;
}

export interface PlaidAccount {
  account_id?: string;
  name?: string | null;
  mask?: string | null;
  type?: string;
  subtype?: string | null;
  balances?: {
    available?: number | null;
    current?: number | null;
    limit?: number | null;
    iso_currency_code?: string | null;
    unofficial_currency_code?: string | null;
    last_updated_datetime?: string | null;
  };
  [field: string]: unknown;
}

export interface PlaidAccountsResponse {
  accounts: PlaidAccount[];
  item?: { item_id?: string; institution_id?: string | null };
}

export interface PlaidSyncResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: PlaidRemovedTransaction[];
  next_cursor: string;
  has_more: boolean;
  transactions_update_status?: string;
}

/** A webhook verification key, as a JWK. */
export interface PlaidVerificationKey {
  alg?: string;
  crv?: string;
  kid?: string;
  kty?: string;
  use?: string;
  x?: string;
  y?: string;
  created_at?: number;
  /** When Plaid retired the key, in Unix seconds, or null while it is current. */
  expired_at?: number | null;
}

export interface PlaidClient {
  /** Any call, for the read endpoints only: anything else is refused before a request is built. */
  request<T>(endpoint: string, params: Record<string, unknown>): Promise<T>;
  accounts(): Promise<PlaidAccountsResponse>;
  /** One page of changes after `cursor`; null or empty reads from the start of the Item's history. */
  transactionsSync(cursor: string | null): Promise<PlaidSyncResponse>;
  item(): Promise<{ item_id: string }>;
  webhookVerificationKey(keyId: string): Promise<PlaidVerificationKey>;
}

/** Plaid documents cursors as strings of at most 256 characters; the connector also refuses whitespace and control characters. */
export const PLAID_CURSOR = /^[\x21-\x7e]{1,256}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Plaid's access tokens name their environment, like access-sandbox-…; one naming the other environment is refused. */
const TOKEN_ENVIRONMENT = /^access-(sandbox|development|production)-/;
const MAX_MESSAGE = 200;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface PlaidErrorBody {
  error_type?: unknown;
  error_code?: unknown;
  error_message?: unknown;
}

const isRateLimit = (status: number, body: PlaidErrorBody | null) => status === 429 || body?.error_type === "RATE_LIMIT_EXCEEDED";

/** Throws unless `endpoint` is one of the read endpoints. Checked before anything is sent. */
export function assertPlaidReadEndpoint(endpoint: string): asserts endpoint is PlaidReadEndpoint {
  if (!(PLAID_READ_ENDPOINTS as readonly string[]).includes(endpoint)) {
    throw new PlaidConfigError(`the Plaid connector only calls read endpoints; ${endpoint.slice(0, 60)} is not one`);
  }
}

export function plaidClient(options: PlaidClientOptions): PlaidClient {
  const clientId = options.clientId?.trim() ?? "";
  const secret = options.secret?.trim() ?? "";
  if (!clientId || !secret) throw new PlaidConfigError("set PLAID_CLIENT_ID and PLAID_SECRET");
  const accessToken = options.accessToken?.trim() ?? "";
  if (!accessToken) throw new PlaidConfigError("set PLAID_ACCESS_TOKEN");
  const environment = options.environment?.trim();
  if (environment !== "production" && environment !== "sandbox") throw new PlaidConfigError("PLAID_ENVIRONMENT must be production or sandbox");
  const named = TOKEN_ENVIRONMENT.exec(accessToken)?.[1];
  if (named && named !== environment) throw new PlaidConfigError(`PLAID_ACCESS_TOKEN is for Plaid's ${named} environment, not ${environment}`);
  const base = PLAID_API_URLS[environment];
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;

  /** Plaid's message, cut short, with any credential that somehow appears in it taken out. */
  function describe(body: PlaidErrorBody | null): { text: string; code: string | undefined; type: string | undefined } {
    const code = typeof body?.error_code === "string" ? body.error_code.slice(0, 60) : undefined;
    const type = typeof body?.error_type === "string" ? body.error_type.slice(0, 60) : undefined;
    let message = typeof body?.error_message === "string" ? body.error_message : "";
    for (const value of [accessToken, secret, clientId]) message = message.split(value).join("[redacted]");
    const text = [[type, code].filter(Boolean).join("/"), message.slice(0, MAX_MESSAGE)].filter(Boolean).join(": ");
    return { text, code, type };
  }

  async function call<T>(endpoint: string, params: Record<string, unknown>, withToken = true): Promise<T> {
    // The allowlist comes first, so a write endpoint is refused before a request exists.
    assertPlaidReadEndpoint(endpoint);
    const body = JSON.stringify(withToken ? { access_token: accessToken, ...params } : params);
    for (let attempt = 0; ; ) {
      const response = await doFetch(`${base}${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "PLAID-CLIENT-ID": clientId, "PLAID-SECRET": secret, "Plaid-Version": PLAID_API_VERSION },
        body,
      });
      const parsed: unknown = await response.json().catch(() => null);
      const error = (parsed !== null && typeof parsed === "object" ? parsed : null) as PlaidErrorBody | null;
      if (response.ok && !error?.error_code) return parsed as T;
      if (isRateLimit(response.status, error) && attempt < retries) {
        await sleep(1000 * 2 ** attempt++);
        continue;
      }
      const { text, code, type } = describe(error);
      if (code === "ITEM_LOGIN_REQUIRED") {
        // Retrying can't help: the bank wants the business to sign in again.
        throw new PlaidApiError(`Plaid can't reach the bank until it is reconnected: reconnect the bank in Plaid Link (update mode)${text ? ` (${text})` : ""}`, response.status, code, type);
      }
      throw new PlaidApiError(`Plaid answered HTTP ${response.status}${text ? `: ${text}` : ""}`, response.status, code, type);
    }
  }

  return {
    request: (endpoint, params) => call(endpoint, params),
    async accounts() {
      const body = await call<PlaidAccountsResponse>("/accounts/get", {});
      if (!body || !Array.isArray(body.accounts)) throw new PlaidApiError("Plaid did not answer with a list of accounts", 200);
      return body;
    },
    async transactionsSync(cursor) {
      if (cursor !== null && cursor !== "" && !PLAID_CURSOR.test(cursor)) throw new PlaidConfigError("the Plaid sync cursor is not in the expected shape");
      const body = await call<PlaidSyncResponse>("/transactions/sync", {
        ...(cursor ? { cursor } : {}),
        count: PLAID_SYNC_PAGE_SIZE,
        options: { days_requested: PLAID_DAYS_REQUESTED, include_original_description: false },
      });
      if (
        !body ||
        !Array.isArray(body.added) ||
        !Array.isArray(body.modified) ||
        !Array.isArray(body.removed) ||
        typeof body.has_more !== "boolean" ||
        typeof body.next_cursor !== "string" ||
        (body.next_cursor !== "" && !PLAID_CURSOR.test(body.next_cursor)) ||
        // A page that says there is more must say where it is.
        (body.has_more && body.next_cursor === "")
      ) {
        throw new PlaidApiError("Plaid did not answer with a page of transaction changes", 200);
      }
      return body;
    },
    async item() {
      const body = await call<{ item?: { item_id?: unknown } }>("/item/get", {});
      const id = body?.item?.item_id;
      if (typeof id !== "string" || !id) throw new PlaidApiError("Plaid did not answer with an Item", 200);
      return { item_id: id };
    },
    async webhookVerificationKey(keyId) {
      if (!KEY_ID.test(keyId)) throw new PlaidConfigError("a webhook key ID must be a short token");
      // The key is the app's, not the Item's, so no access token is sent.
      const body = await call<{ key?: PlaidVerificationKey }>("/webhook_verification_key/get", { key_id: keyId }, false);
      if (!body?.key || typeof body.key !== "object") throw new PlaidApiError("Plaid did not answer with a verification key", 200);
      return body.key;
    },
  };
}
