/**
 * A small client for Affirm's Merchant APIs. Requests authenticate with HTTP
 * Basic, the merchant's public API key as the user and private API key as
 * the password, and the same key pair that reads transactions can also
 * capture, refund and void them: Affirm can't limit a key to reading. So
 * read-only is enforced here, in code: the client sends GETs of the five
 * reads below only, with only the query parameters it checked itself, and
 * throws before sending anything else.
 *
 * Errors come back as JSON with status_code, type, code and message.
 * Affirm publishes no rate limit. Calls go one at a time, and a 429 or 503
 * is retried with backoff before the error goes to runSync.
 *
 * Only Affirm's US hosts are read. Canadian merchants are on Affirm's global
 * hosts, which also need a country-code header; that isn't supported yet.
 */

export const AFFIRM_API_HOSTS = {
  production: "https://api.affirm.com",
  sandbox: "https://sandbox.affirm.com",
} as const;
export type AffirmEnvironment = keyof typeof AFFIRM_API_HOSTS;

/** Each read the client may send, by the docs' operation name. Nothing else is sent. */
export const AFFIRM_READ_PATHS = {
  list_transactions: "/api/v1/transactions",
  read_transaction: "/api/v1/transactions/{id}",
  list_transaction_events: "/api/v1/transactions/events",
  list_settlement_event_summaries: "/api/v1/settlements/daily",
  list_disputes: "/api/v3/disputes",
} as const;
export type AffirmRead = keyof typeof AFFIRM_READ_PATHS;
export const AFFIRM_READS = Object.keys(AFFIRM_READ_PATHS) as AffirmRead[];

/** The page sizes the connector asks for: the settlement lists' largest, and 100 elsewhere. */
export const AFFIRM_PAGE_SIZES = { transactions: 100, events: 100, settlements: 1000, disputes: 100 } as const;

export interface AffirmParams {
  /** read_transaction: the transaction's id, written into the path. */
  id?: string;
  transaction_type?: "charge";
  transaction_event_type?: "authorize" | "capture" | "refund" | "void" | "all";
  limit?: number;
  /**
   * list_transactions: the id of the last transaction read; the page holds
   * older ones. list_settlement_event_summaries: the last day, YYYY-MM-DD.
   */
  before?: string;
  /** list_transactions: Unix seconds. */
  after_timestamp?: number;
  before_timestamp?: number;
  /** list_transaction_events: days as MM-DD-YYYY. */
  after_date?: string;
  before_date?: string;
  /** list_transaction_events: the event id next_page names. */
  before_ari?: string;
  /** read_transaction: "events" only. */
  expand?: "events";
  /** list_settlement_event_summaries: the first day, YYYY-MM-DD, inclusive. */
  after?: string;
  /** list_settlement_event_summaries: the cursor next_page names, both halves together. */
  to_cursor_uuid?: string;
  to_cursor_date?: string;
  /** list_disputes: 1-based. */
  page_number?: number;
}

export interface AffirmClientOptions {
  /** The merchant's public API key. */
  publicApiKey: string;
  /** The merchant's private API key. It can move money, so it is never logged or shown. */
  privateApiKey: string;
  /** The Affirm Merchant ID, which the settlement reads require. */
  merchantId: string;
  /** No default, so a sandbox setting can't reach a merchant's live account by accident and the other way round. */
  environment: AffirmEnvironment | string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 503 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class AffirmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AffirmConfigError";
  }
}

/** Affirm answered with an error. `code` is its error code, such as public-api-key-invalid, when it gives one. */
export class AffirmApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "AffirmApiError";
    this.status = status;
    this.code = code;
  }
}

export interface AffirmClient {
  readonly environment: AffirmEnvironment;
  get(read: AffirmRead, params?: AffirmParams): Promise<Record<string, unknown>>;
}

const KEY = /^[A-Za-z0-9]{8,64}$/;
const MERCHANT = /^[A-Za-z0-9_-]{1,64}$/;
/** Transaction and event ids as the docs show them: V55Z-229C, WDJN3ETDMKGIZJIY. Upper case, so "events" is never an id. */
export const AFFIRM_ID = /^[A-Z0-9][A-Z0-9-]{3,39}$/;
const MDY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])-\d{4}$/;
const YMD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CURSOR_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RETRY_AFTER_S = 60;

const whole = (n: unknown, min: number, max: number) => Number.isInteger(n) && (n as number) >= min && (n as number) <= max;
const realDay = (ymd: string) => !Number.isNaN(Date.parse(`${ymd}T00:00:00Z`)) && new Date(`${ymd}T00:00:00Z`).toISOString().slice(0, 10) === ymd;

/** Checks for each parameter a read takes. Each returns the value as it goes in the query, or null when it is refused. */
type Check = (value: unknown) => string | null;
const oneOf =
  (...values: string[]): Check =>
  (v) =>
    typeof v === "string" && values.includes(v) ? v : null;
const count =
  (max: number): Check =>
  (v) =>
    whole(v, 1, max) ? String(v) : null;
const id: Check = (v) => (typeof v === "string" && AFFIRM_ID.test(v) ? v : null);
const unix: Check = (v) => (whole(v, 0, 99_999_999_999) ? String(v) : null);
const mdy: Check = (v) => (typeof v === "string" && MDY.test(v) && realDay(`${v.slice(6)}-${v.slice(0, 5)}`) ? v : null);
const ymd: Check = (v) => (typeof v === "string" && YMD.test(v) && realDay(v) ? v : null);

const PARAMS: Record<AffirmRead, Record<string, Check>> = {
  list_transactions: { transaction_type: oneOf("charge"), limit: count(AFFIRM_PAGE_SIZES.transactions), before: id, after_timestamp: unix, before_timestamp: unix },
  read_transaction: { id, expand: oneOf("events") },
  list_transaction_events: {
    transaction_type: oneOf("charge"),
    transaction_event_type: oneOf("authorize", "capture", "refund", "void", "all"),
    limit: count(AFFIRM_PAGE_SIZES.events),
    after_date: mdy,
    before_date: mdy,
    before_ari: id,
  },
  list_settlement_event_summaries: {
    limit: count(AFFIRM_PAGE_SIZES.settlements),
    after: ymd,
    before: ymd,
    to_cursor_uuid: (v) => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null),
    to_cursor_date: (v) => (typeof v === "string" && CURSOR_DATE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null),
  },
  list_disputes: { limit: count(AFFIRM_PAGE_SIZES.disputes), page_number: count(100_000) },
};

/** Parameters a read can't be sent without. */
const REQUIRED: Record<AffirmRead, string[]> = {
  list_transactions: ["transaction_type"],
  read_transaction: ["id"],
  list_transaction_events: ["transaction_type", "transaction_event_type"],
  list_settlement_event_summaries: ["after", "before"],
  list_disputes: [],
};

/** Hints for the errors an owner can fix. */
const HINTS: Record<number, string> = {
  401: "; check AFFIRM_PUBLIC_API_KEY, AFFIRM_PRIVATE_API_KEY and AFFIRM_ENVIRONMENT",
  404: "; check AFFIRM_MERCHANT_ID",
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The URL for one read, every parameter checked. The path id goes in the path, never the query. */
function urlFor(host: string, read: AffirmRead, params: AffirmParams, merchantId: string): string {
  const allowed = PARAMS[read];
  const given = Object.entries(params).filter(([, v]) => v !== undefined);
  const extra = given.filter(([k]) => !Object.hasOwn(allowed, k)).map(([k]) => k);
  if (extra.length) throw new AffirmConfigError(`${read} doesn't take ${extra.join(", ")}`);
  const missing = REQUIRED[read].filter((k) => !given.some(([g]) => g === k));
  if (missing.length) throw new AffirmConfigError(`${read} needs ${missing.join(", ")}`);
  const query = new URLSearchParams();
  let path: string = AFFIRM_READ_PATHS[read];
  for (const [name, value] of given) {
    const checked = allowed[name]!(value);
    if (checked === null) throw new AffirmConfigError(`${read} can't take that ${name}`);
    if (name === "id") path = path.replace("{id}", checked);
    else query.set(name, checked);
  }
  if ((params.to_cursor_uuid === undefined) !== (params.to_cursor_date === undefined)) {
    throw new AffirmConfigError("a settlement cursor needs both to_cursor_uuid and to_cursor_date");
  }
  // The settlement reads are by merchant; the id comes from the settings, never a caller.
  if (read === "list_settlement_event_summaries") query.set("merchant_id", merchantId);
  const qs = query.toString();
  return `${host}${path}${qs ? `?${qs}` : ""}`;
}

/** Affirm's code and message for an error, cut short. Error bodies describe the request, never the key. */
function errorOf(body: unknown): { code?: string; message?: string } {
  const b = (body ?? {}) as { code?: unknown; message?: unknown };
  return {
    ...(typeof b.code === "string" ? { code: b.code.slice(0, 60) } : {}),
    ...(typeof b.message === "string" && b.message.trim() ? { message: b.message.slice(0, 200) } : {}),
  };
}

export function affirmClient(options: AffirmClientOptions): AffirmClient {
  const publicKey = options.publicApiKey?.trim() ?? "";
  const privateKey = options.privateApiKey?.trim() ?? "";
  if (!publicKey || !privateKey) throw new AffirmConfigError("set AFFIRM_PUBLIC_API_KEY and AFFIRM_PRIVATE_API_KEY");
  if (!KEY.test(publicKey)) throw new AffirmConfigError("AFFIRM_PUBLIC_API_KEY must be the public API key: letters and digits");
  if (!KEY.test(privateKey)) throw new AffirmConfigError("AFFIRM_PRIVATE_API_KEY must be the private API key: letters and digits");
  const merchantId = options.merchantId?.trim() ?? "";
  if (!MERCHANT.test(merchantId)) throw new AffirmConfigError("AFFIRM_MERCHANT_ID must be the Affirm Merchant ID");
  const environment = options.environment;
  if (environment !== "production" && environment !== "sandbox") throw new AffirmConfigError("AFFIRM_ENVIRONMENT must be production or sandbox");
  const host = AFFIRM_API_HOSTS[environment];
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  const authorization = `Basic ${Buffer.from(`${publicKey}:${privateKey}`).toString("base64")}`;

  return {
    environment,
    async get(read, params = {}) {
      // The allowlist: the same keys can capture, refund and void, so nothing but these reads is ever sent.
      if (!Object.hasOwn(AFFIRM_READ_PATHS, read)) throw new AffirmConfigError("the Affirm connector only sends its listed reads");
      const url = urlFor(host, read, params, merchantId);
      for (let attempt = 0; ; attempt++) {
        // GET only: the connector never authorizes, captures, refunds, voids or updates anything.
        const response = await doFetch(url, { method: "GET", headers: { authorization, accept: "application/json" } });
        if ((response.status === 429 || response.status === 503) && attempt < retries) {
          const after = Number(response.headers?.get("retry-after"));
          await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : 1000 * 2 ** attempt);
          continue;
        }
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const { code, message } = errorOf(body);
          const hint = Object.hasOwn(HINTS, response.status) ? HINTS[response.status] : "";
          throw new AffirmApiError(`Affirm answered HTTP ${response.status} to ${read}${code ? ` (${code}${message ? `: ${message}` : ""})` : ""}${hint}`, response.status, code);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new AffirmApiError("Affirm did not answer with JSON", response.status);
        return body as Record<string, unknown>;
      }
    },
  };
}
