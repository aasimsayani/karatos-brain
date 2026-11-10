import { randomBytes } from "node:crypto";

/**
 * A small client for FedEx's Track API. It signs in with the project's API
 * key and secret (OAuth client credentials, sent as a form) and reads one
 * tracking number a call from `POST /track/v1/trackingnumbers`, without
 * detailed scans. It sends nothing else: no shipping, pickup or address
 * calls, and no tracking-number subscriptions.
 *
 * FedEx reports a number it doesn't know inside a 200, as an error on the
 * track result (read as not found), a bad or expired token with 401 (signed in again once), too
 * many requests with 429, and a brief outage with 503; those two are retried
 * with backoff before the error goes to runSync.
 */

export const FEDEX_HOSTS = { production: "https://apis.fedex.com", test: "https://apis-sandbox.fedex.com" } as const;
export type FedexEnvironment = keyof typeof FEDEX_HOSTS;

/** Tracking numbers FedEx prints: 12, 15, 20 or 22 digits and the like, or a door tag (DT and 12 digits). */
export const FEDEX_TRACKING_NUMBER = /^(?:\d{12,34}|DT\d{12})$/;
const TOKEN_MARGIN_MS = 5 * 60_000;
const MAX_RETRY_AFTER_S = 60;

export interface FedexClientOptions {
  /** The project's API key, which FedEx calls the client id. */
  clientId: string;
  /** The project's secret key. Sent to FedEx only and never logged or shown. */
  clientSecret: string;
  /** "production" (default) or "test", FedEx's sandbox. */
  environment?: FedexEnvironment | undefined;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Times a 429 or 503 is retried here before the error goes to runSync. */
  retries?: number;
}

export class FedexConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FedexConfigError";
  }
}

/** FedEx answered with an error. `code` is the first code in its errors list, when it gave one. */
export class FedexApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "FedexApiError";
  }
}

/** The track results FedEx gave for one number, or that it has none. */
export type FedexTrackResult = { kind: "found"; results: Record<string, unknown>[] } | { kind: "not_found" };

export interface FedexClient {
  track(trackingNumber: string): Promise<FedexTrackResult>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const CODE = /^[A-Z0-9_.]{1,80}$/;

/** The first error code FedEx gave, when it reads as one. */
function fedexErrorCode(body: unknown): string | undefined {
  const code = (list(isObject(body) ? body.errors : undefined)[0] as Record<string, unknown> | null | undefined)?.code;
  return typeof code === "string" && CODE.test(code) ? code : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function fedexClient(options: FedexClientOptions): FedexClient {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(options.clientId)) throw new FedexConfigError("FEDEX_CLIENT_ID is missing or not in the expected shape");
  if (!/^\S{8,256}$/.test(options.clientSecret)) throw new FedexConfigError("FEDEX_CLIENT_SECRET is missing or not in the expected shape");
  const environment = options.environment ?? "production";
  if (!Object.hasOwn(FEDEX_HOSTS, environment)) throw new FedexConfigError('FEDEX_ENVIRONMENT must be "production" or "test"');
  const host = FEDEX_HOSTS[environment];
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => new Date());
  const retries = options.retries ?? 3;
  const form = new URLSearchParams({ grant_type: "client_credentials", client_id: options.clientId, client_secret: options.clientSecret }).toString();
  let token: { value: string; until: number } | null = null;

  async function send(request: () => Promise<Response>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await request();
      if ((response.status === 429 || response.status === 503) && attempt < retries) {
        const after = response.headers.get("retry-after");
        const seconds = after !== null && /^\d{1,6}$/.test(after) ? Number(after) : 0;
        await sleep(1000 * (seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_S) : 2 ** attempt));
        continue;
      }
      return response;
    }
  }

  async function signIn(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const response = await send(() => fetch(`${host}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form }));
    const body = await readJson(response);
    if (response.status === 401 || response.status === 403) throw new FedexApiError("FedEx turned down the API key and secret: check FEDEX_CLIENT_ID and FEDEX_CLIENT_SECRET, and that the project has the Track API", response.status, fedexErrorCode(body));
    if (response.status !== 200) throw new FedexApiError(`FedEx sign-in answered HTTP ${response.status}`, response.status, fedexErrorCode(body));
    const value = isObject(body) ? body.access_token : undefined;
    if (typeof value !== "string" || !/^\S{16,8192}$/.test(value)) throw new FedexApiError("FedEx sign-in answered without an access token", 200);
    // FedEx gives expires_in as a number of seconds (an hour). Anything else counts as already run out.
    const expires = isObject(body) && (typeof body.expires_in === "number" || typeof body.expires_in === "string") ? Number(body.expires_in) : 0;
    const seconds = Number.isInteger(expires) && expires > 0 && expires < 10_000_000 ? expires : 0;
    token = { value, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return value;
  }

  async function track(trackingNumber: string): Promise<FedexTrackResult> {
    if (!FEDEX_TRACKING_NUMBER.test(trackingNumber)) throw new FedexConfigError("not a FedEx tracking number");
    const request = JSON.stringify({ includeDetailedScans: false, trackingInfo: [{ trackingNumberInfo: { trackingNumber } }] });
    for (let signIns = 0; ; signIns++) {
      const bearer = await signIn();
      const response = await send(() =>
        fetch(`${host}/track/v1/trackingnumbers`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json", "x-customer-transaction-id": randomBytes(16).toString("hex"), "x-locale": "en_US" },
          body: request,
        }),
      );
      const body = await readJson(response);
      if (response.status === 401 && signIns === 0) {
        token = null;
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new FedexApiError("FedEx turned down the token for tracking: check the project has the Track API", response.status, fedexErrorCode(body));
      if (response.status === 404) return { kind: "not_found" };
      if (response.status !== 200) throw new FedexApiError(`FedEx tracking answered HTTP ${response.status}`, response.status, fedexErrorCode(body));
      if (!isObject(body)) throw new FedexApiError("FedEx tracking answered with a body that isn't a JSON object", 200);
      const results = list(isObject(body.output) ? body.output.completeTrackResults : undefined)
        .flatMap((c) => list(isObject(c) ? c.trackResults : undefined))
        .filter(isObject);
      // A result carrying an error, such as TRACKING.TRACKINGNUMBER.NOTFOUND, has nothing to read; the number is tried again next sync.
      const found = results.filter((r) => r.error === undefined);
      return found.length === 0 ? { kind: "not_found" } : { kind: "found", results: found };
    }
  }

  return { track };
}
