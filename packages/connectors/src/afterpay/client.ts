/**
 * A small client for Afterpay's (Cash App Afterpay's) Merchant API v2.
 * Requests authenticate with HTTP Basic, the Merchant ID as the user and
 * the Secret Key as the password, and the same pair that lists payments can
 * also capture, refund and void them: Afterpay doesn't offer a key limited
 * to reading. So read-only is enforced here, in code: the client sends one
 * request, a GET of List Payments, with a query string it builds itself, and
 * has no way to send anything else.
 *
 * Errors come back as JSON with errorCode, errorId, message and
 * httpStatusCode. Afterpay publishes no rate limit; a 429 or 5xx is retried
 * with backoff before the error goes to runSync.
 */

export const AFTERPAY_API_HOSTS = {
  production: "https://global-api.afterpay.com",
  sandbox: "https://global-api-sandbox.afterpay.com",
} as const;
export type AfterpayEnvironment = keyof typeof AFTERPAY_API_HOSTS;

/** List Payments, the one read the client sends. */
export const AFTERPAY_PAYMENTS_PATH = "/v2/payments";
/** Payments asked for per page: the most List Payments returns. */
export const AFTERPAY_PAGE_SIZE = 250;
/** Afterpay asks every request to carry a User-Agent naming the integration. */
export const AFTERPAY_USER_AGENT = "KaratOS/1.0 (+https://github.com/aasimsayani/karatos-brain)";

const MERCHANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET = /^\S{8,256}$/;
/** An ISO 8601 UTC time as the connector writes one. */
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);

export interface AfterpayClientOptions {
  /** The merchant's Afterpay Merchant ID. */
  merchantId: string;
  /** The merchant's Secret Key. It can move money, so it is never logged or shown. */
  secretKey: string;
  /** No default, so a sandbox setting can't reach a live account by accident and the other way round. */
  environment: AfterpayEnvironment | string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class AfterpayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AfterpayConfigError";
  }
}

/** Afterpay answered with an error. `code` is its errorCode, such as unauthorized, when it gives one. */
export class AfterpayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AfterpayApiError";
  }
}

/** One page of payments created from `from` to `to`, both inclusive, oldest first. */
export interface AfterpayPageRequest {
  from: string;
  to: string;
  offset: number;
}

export interface AfterpayClient {
  readonly environment: AfterpayEnvironment;
  payments(request: AfterpayPageRequest): Promise<Record<string, unknown>>;
}

const isTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;

/** Afterpay's error code and message, cut short. Error bodies describe the request, never the key. */
function detail(body: unknown): { code: string | undefined; text: string } {
  const b = (typeof body === "object" && body !== null ? body : {}) as { errorCode?: unknown; message?: unknown };
  const code = typeof b.errorCode === "string" && /^[a-z_]{1,64}$/.test(b.errorCode) ? b.errorCode : undefined;
  const message = typeof b.message === "string" ? b.message.slice(0, 200) : "";
  return { code, text: `${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}` };
}

export function afterpayClient(options: AfterpayClientOptions): AfterpayClient {
  const merchantId = options.merchantId?.trim() ?? "";
  const secretKey = options.secretKey?.trim() ?? "";
  if (!MERCHANT_ID.test(merchantId)) throw new AfterpayConfigError("AFTERPAY_MERCHANT_ID must be the Merchant ID Afterpay gave");
  if (!SECRET.test(secretKey)) throw new AfterpayConfigError("set AFTERPAY_SECRET_KEY to the Secret Key Afterpay gave");
  const environment = options.environment?.trim();
  if (environment !== "production" && environment !== "sandbox") throw new AfterpayConfigError("AFTERPAY_ENVIRONMENT must be production or sandbox");
  const host = AFTERPAY_API_HOSTS[environment];
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  const authorization = `Basic ${Buffer.from(`${merchantId}:${secretKey}`).toString("base64")}`;

  async function payments({ from, to, offset }: AfterpayPageRequest): Promise<Record<string, unknown>> {
    if (!isTime(from) || !isTime(to) || to < from) throw new AfterpayApiError("payments need a from time on or before a to time", 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AfterpayApiError("a page offset must be a whole number from 0", 0);
    const query = new URLSearchParams({ fromCreatedDate: from, toCreatedDate: to, orderBy: "createdAt", ascending: "true", limit: String(AFTERPAY_PAGE_SIZE), offset: String(offset) });
    const url = `${host}${AFTERPAY_PAYMENTS_PATH}?${query}`;
    for (let attempt = 0; ; attempt++) {
      // GET only, with the key in the Authorization header and never in the URL.
      const response = await doFetch(url, { method: "GET", headers: { accept: "application/json", authorization, "user-agent": AFTERPAY_USER_AGENT } });
      if (RETRIED.has(response.status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isSafeInteger(after) && after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const body: unknown = await response.json().catch(() => null);
      const { code, text } = detail(body);
      if (response.status === 401 || response.status === 403) throw new AfterpayConfigError(`Afterpay turned down the Merchant ID and Secret Key (HTTP ${response.status})${text}; check they are the ${environment} pair`);
      if (response.status !== 200) throw new AfterpayApiError(`Afterpay answered HTTP ${response.status} for the payments${text}`, response.status, code);
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new AfterpayApiError("Afterpay answered the payments without JSON", 200);
      return body as Record<string, unknown>;
    }
  }

  return { environment, payments };
}
