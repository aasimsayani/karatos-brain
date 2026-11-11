/**
 * A small client for Ramp's Developer API, read-only. Ramp signs an app in
 * with OAuth client credentials: a client ID and secret from the Ramp
 * developer settings are swapped for a bearer token that lasts ten days,
 * with no refresh token, and the token can do only what the scopes asked
 * for allow. This client asks for transactions:read and nothing else, and
 * turns a token down if Ramp grants any scope beyond that.
 *
 * The client sends only GET requests to the transactions list, and follows
 * Ramp's `page.next` links only while they point back at that same list on
 * the same host, so the token never goes anywhere else. Ramp's own error
 * text is never put in an error here, only the HTTP status. A 429 and 500,
 * 502, 503 and 504 are waited out a few times, honoring Retry-After, before
 * the error goes to runSync, which keeps the checkpoint.
 */

export const RAMP_API_URLS = { production: "https://api.ramp.com", sandbox: "https://demo-api.ramp.com" } as const;
export type RampEnvironment = keyof typeof RAMP_API_URLS;
export const RAMP_TOKEN_PATH = "/developer/v1/token";
export const RAMP_TRANSACTIONS_PATH = "/developer/v1/transactions";
/** The only scope this client asks for. */
export const RAMP_SCOPE = "transactions:read";
/** The most transactions Ramp returns on a page. */
export const RAMP_PAGE_SIZE = 100;
const MAX_RETRY_AFTER_S = 60;
/** A token is renewed this long before Ramp says it runs out. */
const TOKEN_MARGIN_MS = 300_000;
const RETRIED = new Set([429, 500, 502, 503, 504]);
const CREDENTIAL = /^[A-Za-z0-9_.~-]{8,200}$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{8,4096}$/;
/** An ISO 8601 UTC time, as this client sends dates. */
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export interface RampClientOptions {
  /** Sent to Ramp only, and never logged or shown. */
  clientId: string;
  /** Sent to Ramp only, and never logged or shown. */
  clientSecret: string;
  /** Ramp's production API, or its sandbox. Defaults to production. */
  environment?: RampEnvironment | undefined;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
  now?: () => Date;
}

export class RampConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RampConfigError";
  }
}

export class RampApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RampApiError";
  }
}

/** Which transactions a first page lists: those made from a time to another, or those changed since a time. */
export type RampQuery = { fromDate: string; toDate: string } | { updatedAfter: string };

export interface RampPage {
  transactions: unknown[];
  /** The next page's link, checked, or null on the last page. */
  next: string | null;
}

export interface RampClient {
  readonly baseUrl: string;
  /** The first page for a query, oldest first. */
  transactions(query: RampQuery): Promise<RampPage>;
  /** A page from a `next` link, which must point back at the transactions list. */
  page(next: string): Promise<RampPage>;
}

/** The link as a URL when it is Ramp's transactions list on `baseUrl`, or null. */
export function rampListUrl(link: unknown, baseUrl: string): URL | null {
  let url: URL;
  try {
    // Anything but a string reads as text that isn't a link.
    url = new URL(String(link));
  } catch {
    return null;
  }
  return url.origin === baseUrl && url.pathname === RAMP_TRANSACTIONS_PATH && url.username === "" && url.password === "" && url.hash === "" ? url : null;
}

export function rampClient(options: RampClientOptions): RampClient {
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!CREDENTIAL.test(clientId)) throw new RampConfigError("RAMP_CLIENT_ID is missing or not in the expected shape");
  if (!CREDENTIAL.test(clientSecret)) throw new RampConfigError("RAMP_CLIENT_SECRET is missing or not in the expected shape");
  const environment = options.environment ?? "production";
  if (!Object.hasOwn(RAMP_API_URLS, environment)) throw new RampConfigError("RAMP_ENVIRONMENT must be production or sandbox");
  const baseUrl = RAMP_API_URLS[environment];
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  const now = options.now ?? (() => new Date());
  let token: { value: string; until: number } | null = null;

  async function send(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await doFetch(url, init);
      if (!RETRIED.has(response.status) || attempt >= retries) return response;
      const after = Number(response.headers.get("retry-after"));
      await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : 1000 * 2 ** attempt);
    }
  }

  async function accessToken(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await send(`${baseUrl}${RAMP_TOKEN_PATH}`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: RAMP_SCOPE }).toString(),
    });
    const { status } = response;
    if (status === 400 || status === 401 || status === 403) throw new RampConfigError(`Ramp turned down RAMP_CLIENT_ID and RAMP_CLIENT_SECRET (HTTP ${status})`);
    if (status !== 200) throw new RampApiError(`Ramp answered HTTP ${status} for a token`, status);
    const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | null | undefined;
    const value = body?.access_token;
    if (typeof value !== "string" || !TOKEN.test(value)) throw new RampApiError("Ramp answered without a token", status);
    // A token with any scope beyond transactions:read could do more than read, so it isn't used.
    const scopes = typeof body!.scope === "string" ? body!.scope.split(" ").filter(Boolean) : [];
    if (scopes.length !== 1 || scopes[0] !== RAMP_SCOPE) throw new RampConfigError(`Ramp granted the app scopes other than ${RAMP_SCOPE}, so its token isn't used`);
    // A lifetime that is missing or not a number means the token is asked for again next time.
    const seconds = typeof body!.expires_in === "number" ? body!.expires_in : 0;
    token = { value, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return value;
  }

  async function list(url: URL): Promise<RampPage> {
    let response: Response | undefined;
    // A token Ramp stops taking before it runs out is renewed once.
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await send(url.toString(), { method: "GET", headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" } });
      if (response.status !== 401) break;
      token = null;
    }
    const { status } = response!;
    if (status === 401 || status === 403) throw new RampConfigError(`Ramp turned down the app's token for ${RAMP_SCOPE} (HTTP ${status})`);
    if (status !== 200) throw new RampApiError(`Ramp answered HTTP ${status} for transactions`, status);
    const body = (await response!.json().catch(() => undefined)) as Record<string, unknown> | null | undefined;
    if (!Array.isArray(body?.data)) throw new RampApiError("Ramp answered without its transactions", status);
    const link = (body!.page as Record<string, unknown> | null | undefined)?.next;
    if (link === null || link === undefined || link === "") return { transactions: body!.data, next: null };
    const next = rampListUrl(link, baseUrl);
    if (!next) throw new RampApiError("Ramp's next page link doesn't point at the transactions list", status);
    return { transactions: body!.data, next: next.toString() };
  }

  return {
    baseUrl,
    async transactions(query) {
      const params = new URLSearchParams({ page_size: String(RAMP_PAGE_SIZE) });
      if ("updatedAfter" in query) {
        if (!UTC_TIME.test(query.updatedAfter)) throw new RampApiError("updated_after must be an ISO UTC time", 0);
        params.set("updated_after", query.updatedAfter);
      } else {
        if (!UTC_TIME.test(query.fromDate) || !UTC_TIME.test(query.toDate) || query.fromDate > query.toDate) throw new RampApiError("a transaction list must run from one ISO UTC time to a later one", 0);
        params.set("from_date", query.fromDate);
        params.set("to_date", query.toDate);
        params.set("order_by_date_asc", "true");
      }
      return list(new URL(`${baseUrl}${RAMP_TRANSACTIONS_PATH}?${params}`));
    },
    async page(next) {
      const url = rampListUrl(next, baseUrl);
      if (!url) throw new RampApiError("a next page link must point at Ramp's transactions list", 0);
      return list(url);
    },
  };
}
