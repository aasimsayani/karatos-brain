/**
 * A small client for Klarna's Settlements API, read-only. Klarna signs a
 * request in with HTTP Basic: either an API key from the Klarna portal
 * (`klarna_live_api_…` or `klarna_test_api_…`), or an API username and
 * password. A credential belongs to one merchant ID, one region and either
 * the live API or the playground. Klarna doesn't document a way to limit a
 * credential to settlements, so the client keeps to the settlements reads:
 * it sends only GET requests, to the payouts list and the transactions
 * list, on the one host the region and environment name. A live key is
 * turned down for the playground and a test key for production, so a key
 * can't be sent to the wrong host.
 *
 * Pages are walked by offset, worked out here, never by following a link
 * Klarna sends. Klarna's own error text is never put in an error here,
 * only the HTTP status. A 429 and 500, 502, 503 and 504 are waited out a
 * few times, honoring Retry-After, before the error goes to runSync, which
 * keeps the checkpoint.
 */

export const KLARNA_API_URLS = {
  production: { eu: "https://api.klarna.com", na: "https://api-na.klarna.com", oc: "https://api-oc.klarna.com" },
  playground: { eu: "https://api.playground.klarna.com", na: "https://api-na.playground.klarna.com", oc: "https://api-oc.playground.klarna.com" },
} as const;
export type KlarnaEnvironment = keyof typeof KLARNA_API_URLS;
export type KlarnaRegion = keyof (typeof KLARNA_API_URLS)["production"];
export const KLARNA_PAYOUTS_PATH = "/settlements/v1/payouts";
export const KLARNA_TRANSACTIONS_PATH = "/settlements/v1/transactions";
/** The most payouts asked for on a page; each payout's transactions are read before the next. */
export const KLARNA_PAYOUT_PAGE_SIZE = 100;
/** The most transactions Klarna returns on a page. */
export const KLARNA_TRANSACTION_PAGE_SIZE = 500;
const MAX_RETRY_AFTER_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
const API_KEY = /^klarna_(live|test)_api_[A-Za-z0-9_-]{8,200}$/;
const USERNAME = /^[A-Za-z0-9_-]{4,100}$/;
const PASSWORD = /^[\x21-\x7e]{8,200}$/;
const REFERENCE = /^[A-Za-z0-9_-]{1,100}$/;
/** An ISO 8601 UTC time, as this client sends dates. */
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface KlarnaClientOptions {
  /** An API key from the Klarna portal. Sent to Klarna only, and never logged or shown. */
  apiKey?: string | undefined;
  /** An API username, with its password, in place of a key. */
  username?: string | undefined;
  /** Sent to Klarna only, and never logged or shown. */
  password?: string | undefined;
  /** Where the merchant's Klarna account is: eu, na (North America) or oc (Oceania). Defaults to na. */
  region?: KlarnaRegion | undefined;
  /** The live API, or Klarna's playground. Defaults to production. */
  environment?: KlarnaEnvironment | undefined;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class KlarnaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KlarnaConfigError";
  }
}

export class KlarnaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "KlarnaApiError";
  }
}

/** Payouts made from one time to another. */
export interface KlarnaPayoutQuery {
  start: string;
  end: string;
  offset: number;
}

export interface KlarnaPage {
  items: unknown[];
  /** A later page may hold more. */
  more: boolean;
}

export interface KlarnaClient {
  readonly baseUrl: string;
  payouts(query: KlarnaPayoutQuery): Promise<KlarnaPage>;
  /** A page of one payout's transactions, by its payment reference. */
  transactions(paymentReference: string, offset: number): Promise<KlarnaPage>;
}

const isOffset = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** The Authorization header for the settings given, checked against the environment. */
export function klarnaAuthorization(options: Pick<KlarnaClientOptions, "apiKey" | "username" | "password">, environment: KlarnaEnvironment): string {
  const apiKey = options.apiKey?.trim() ?? "";
  const username = options.username?.trim() ?? "";
  const password = options.password?.trim() ?? "";
  if (apiKey !== "") {
    if (username !== "" || password !== "") throw new KlarnaConfigError("Set KLARNA_API_KEY or KLARNA_USERNAME and KLARNA_PASSWORD, not both");
    const m = API_KEY.exec(apiKey);
    if (!m) throw new KlarnaConfigError("KLARNA_API_KEY is not in the expected shape");
    if ((m[1] === "live") !== (environment === "production")) throw new KlarnaConfigError(`KLARNA_API_KEY is a ${m[1]} key, so it can't be used with the ${environment} API`);
    return `Basic ${apiKey}`;
  }
  if (!USERNAME.test(username)) throw new KlarnaConfigError("KLARNA_API_KEY, or KLARNA_USERNAME and KLARNA_PASSWORD, is missing or not in the expected shape");
  if (!PASSWORD.test(password)) throw new KlarnaConfigError("KLARNA_PASSWORD is missing or not in the expected shape");
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export function klarnaClient(options: KlarnaClientOptions): KlarnaClient {
  const environment = options.environment ?? "production";
  if (!Object.hasOwn(KLARNA_API_URLS, environment)) throw new KlarnaConfigError("KLARNA_ENVIRONMENT must be production or playground");
  const region = options.region ?? "na";
  if (!Object.hasOwn(KLARNA_API_URLS[environment], region)) throw new KlarnaConfigError("KLARNA_REGION must be eu, na or oc");
  const baseUrl = KLARNA_API_URLS[environment][region];
  const authorization = klarnaAuthorization(options, environment);
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;

  async function list(path: string, params: URLSearchParams, key: string, size: number, offset: number): Promise<KlarnaPage> {
    params.set("size", String(size));
    params.set("offset", String(offset));
    const url = `${baseUrl}${path}?${params}`;
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await doFetch(url, { method: "GET", headers: { authorization, accept: "application/json" } });
      if (!RETRIED.has(response.status) || attempt >= retries) break;
      const after = Number(response.headers.get("retry-after"));
      await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : 1000 * 2 ** attempt);
    }
    const { status } = response;
    if (status === 401 || status === 403) throw new KlarnaConfigError(`Klarna turned down the credential for ${key} (HTTP ${status})`);
    if (status !== 200) throw new KlarnaApiError(`Klarna answered HTTP ${status} for ${key}`, status);
    const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | null | undefined;
    const items = body?.[key];
    if (!Array.isArray(items)) throw new KlarnaApiError(`Klarna answered without its ${key}`, status);
    const total = (body!.pagination as Record<string, unknown> | null | undefined)?.total;
    // Without a total, a full page means more may follow.
    const more = items.length > 0 && (isOffset(total) ? offset + items.length < total : items.length >= size);
    return { items, more };
  }

  return {
    baseUrl,
    async payouts(query) {
      if (!UTC_TIME.test(query.start) || !UTC_TIME.test(query.end) || query.start > query.end) throw new KlarnaApiError("a payout list must run from one ISO UTC time to a later one", 0);
      if (!isOffset(query.offset)) throw new KlarnaApiError("an offset must be a whole number, 0 or more", 0);
      return list(KLARNA_PAYOUTS_PATH, new URLSearchParams({ start_date: query.start, end_date: query.end }), "payouts", KLARNA_PAYOUT_PAGE_SIZE, query.offset);
    },
    async transactions(paymentReference, offset) {
      if (!REFERENCE.test(paymentReference)) throw new KlarnaApiError("a payment reference must be letters, digits, - and _", 0);
      if (!isOffset(offset)) throw new KlarnaApiError("an offset must be a whole number, 0 or more", 0);
      return list(KLARNA_TRANSACTIONS_PATH, new URLSearchParams({ payment_reference: paymentReference }), "transactions", KLARNA_TRANSACTION_PAGE_SIZE, offset);
    },
  };
}
