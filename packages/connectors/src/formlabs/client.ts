/**
 * A small client for the Formlabs Web API (the Dashboard Developer API),
 * read-only. A request is signed in with a token from POST
 * /developer/v1/o/token/, made from a client ID and secret created on the
 * Dashboard's Developer page with the client credentials grant. A token
 * lasts a day.
 *
 * A token can't be limited to reading: the same one can create and change
 * printer groups. So the client keeps to the reads itself: it sends one
 * POST, for a token, and otherwise only GET requests to the print runs
 * list, all on api.formlabs.com.
 *
 * Formlabs' own error text is never put in an error here, only the HTTP
 * status. Formlabs allows 1,500 requests an hour per user; a 429 is waited
 * out for as long as Retry-After says, up to a minute, and a 500, 502, 503
 * or 504 a few seconds, a few times, before the error goes to runSync,
 * which keeps the checkpoint.
 */

export const FORMLABS_API = "https://api.formlabs.com";
/** Records asked for on a page. */
export const FORMLABS_PAGE_SIZE = 100;
const MAX_RETRY_AFTER_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
/** Signed in again this long before the token runs out. */
const TOKEN_MARGIN_MS = 60_000;
const CLIENT_ID = /^[A-Za-z0-9._~-]{8,256}$/;
const CLIENT_SECRET = /^[\x21-\x7e]{16,512}$/;
const ACCESS_TOKEN = /^[A-Za-z0-9._~+/=-]{16,8192}$/;
/** A UTC time as toISOString writes it. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface FormlabsClientOptions {
  /** The Developer API client ID. */
  clientId: string;
  /** Its client secret. Sent to Formlabs' token endpoint only, and never logged or shown. */
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock a token's lifetime is counted on; replaced in tests. */
  now?: () => Date;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class FormlabsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormlabsConfigError";
  }
}

export class FormlabsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FormlabsApiError";
  }
}

export interface FormlabsPage {
  records: unknown[];
  /** A later page may hold more. */
  more: boolean;
}

export interface FormlabsClient {
  readonly baseUrl: string;
  /** One page of the print runs made after `from` and before `to`; pages count from 1. */
  prints(range: { from: string; to: string }, page: number): Promise<FormlabsPage>;
}

export function formlabsClient(options: FormlabsClientOptions): FormlabsClient {
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!CLIENT_ID.test(clientId)) throw new FormlabsConfigError("FORMLABS_CLIENT_ID is missing or not in the expected shape");
  if (!CLIENT_SECRET.test(clientSecret)) throw new FormlabsConfigError("FORMLABS_CLIENT_SECRET is missing or not in the expected shape");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const retries = options.retries ?? 3;
  let token: { value: string; until: number } | null = null;

  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, init);
      if (!RETRIED.has(response.status) || attempt >= retries) return response;
      const after = Number(response.headers.get("retry-after"));
      await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : 1000 * 2 ** attempt);
    }
  }

  async function signIn(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const response = await send(`${FORMLABS_API}/developer/v1/o/token/`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString(),
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) throw new FormlabsConfigError(`Formlabs turned down FORMLABS_CLIENT_ID and FORMLABS_CLIENT_SECRET (HTTP ${response.status}); check the credentials on the Dashboard's Developer page`);
    if (response.status !== 200) throw new FormlabsApiError(`Formlabs sign-in answered HTTP ${response.status}`, response.status);
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const value = body?.access_token;
    if (typeof value !== "string" || !ACCESS_TOKEN.test(value)) throw new FormlabsApiError("Formlabs sign-in answered without an access token", 200);
    // expires_in is seconds; anything else, or more than two days, counts as already run out.
    const expires = body!.expires_in;
    const seconds = typeof expires === "number" && expires <= 172_800 ? expires : 0;
    token = { value, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return value;
  }

  return {
    baseUrl: FORMLABS_API,
    async prints(range, page) {
      if (!TIME.test(range.from) || !TIME.test(range.to) || range.from > range.to) throw new FormlabsApiError("print runs are listed between two UTC times", 0);
      if (!Number.isSafeInteger(page) || page < 1) throw new FormlabsApiError("page must be a whole number, 1 or more", 0);
      const url = `${FORMLABS_API}/developer/v1/prints/?${new URLSearchParams({ date__gt: range.from, date__lt: range.to, page: String(page), per_page: String(FORMLABS_PAGE_SIZE) })}`;
      for (let signIns = 0; ; signIns++) {
        const bearer = await signIn();
        const response = await send(url, { method: "GET", headers: { authorization: `Bearer ${bearer}`, accept: "application/json" } });
        // A token can be revoked early; sign in again once.
        if (response.status === 401 && signIns === 0) {
          token = null;
          continue;
        }
        const { status } = response;
        if (status === 401 || status === 403) throw new FormlabsConfigError(`Formlabs turned down the token for print runs (HTTP ${status}); check the credentials on the Dashboard's Developer page`);
        if (status !== 200) throw new FormlabsApiError(`Formlabs answered HTTP ${status} for print runs`, status);
        const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        const results = body?.results;
        if (!Array.isArray(results)) throw new FormlabsApiError("Formlabs answered without a list of print runs", status);
        const next = body!.next;
        return { records: results, more: typeof next === "string" && next !== "" };
      }
    },
  };
}
