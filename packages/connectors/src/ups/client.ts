import { randomBytes } from "node:crypto";

/**
 * A small client for UPS's Tracking API. It signs in with the app's client
 * id and secret (OAuth client credentials, Basic auth on the token call) and
 * reads one tracking number a call from `GET /api/track/v1/details/{number}`,
 * asking for no signature image, proof of delivery or milestones. It sends
 * nothing else: no shipping, pickup or address calls.
 *
 * UPS answers a tracking number it doesn't know with 404, a bad or expired
 * token with 401 (signed in again once), too many requests with 429, and a
 * brief outage with 503; those two are retried with backoff before the
 * error goes to runSync.
 */

export const UPS_HOSTS = { production: "https://onlinetools.ups.com", test: "https://wwwcie.ups.com" } as const;
export type UpsEnvironment = keyof typeof UPS_HOSTS;

/** Tracking numbers UPS takes: 7 to 34 letters and digits, such as 1Z... package numbers and Mail Innovations numbers. */
export const UPS_TRACKING_NUMBER = /^[A-Z0-9]{7,34}$/;
/** Signed in again this long before the token runs out. */
const TOKEN_MARGIN_MS = 5 * 60_000;
const MAX_RETRY_AFTER_S = 60;

export interface UpsClientOptions {
  clientId: string;
  /** Sent to UPS only and never logged or shown. */
  clientSecret: string;
  /** "production" (default) or "test", UPS's Customer Integration Environment. */
  environment?: UpsEnvironment | undefined;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Times a 429 or 503 is retried here before the error goes to runSync. */
  retries?: number;
}

export class UpsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpsConfigError";
  }
}

/** UPS answered with an error. `code` is the first code in its errors list, when it gave one. */
export class UpsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "UpsApiError";
  }
}

export type UpsTrackResult = { kind: "found"; body: Record<string, unknown> } | { kind: "not_found" };

export interface UpsClient {
  track(trackingNumber: string): Promise<UpsTrackResult>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The first error code UPS gave, when it is a short code. */
function upsErrorCode(body: unknown): string | undefined {
  const errors = isObject(body) && isObject(body.response) && Array.isArray(body.response.errors) ? body.response.errors : [];
  const code = (errors[0] as Record<string, unknown> | null | undefined)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,20}$/.test(code) ? code : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function upsClient(options: UpsClientOptions): UpsClient {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(options.clientId)) throw new UpsConfigError("UPS_CLIENT_ID is missing or not in the expected shape");
  if (!/^\S{8,256}$/.test(options.clientSecret)) throw new UpsConfigError("UPS_CLIENT_SECRET is missing or not in the expected shape");
  const environment = options.environment ?? "production";
  if (!Object.hasOwn(UPS_HOSTS, environment)) throw new UpsConfigError('UPS_ENVIRONMENT must be "production" or "test"');
  const host = UPS_HOSTS[environment];
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => new Date());
  const retries = options.retries ?? 3;
  const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`, "utf8").toString("base64");
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
    const response = await send(() =>
      fetch(`${host}/security/v1/oauth/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: "grant_type=client_credentials",
      }),
    );
    const body = await readJson(response);
    if (response.status === 401 || response.status === 403) throw new UpsApiError("UPS turned down the client id and secret: check UPS_CLIENT_ID and UPS_CLIENT_SECRET, and that the app has the Tracking product", response.status, upsErrorCode(body));
    if (response.status !== 200) throw new UpsApiError(`UPS sign-in answered HTTP ${response.status}`, response.status, upsErrorCode(body));
    const value = isObject(body) ? body.access_token : undefined;
    if (typeof value !== "string" || !/^\S{16,4096}$/.test(value)) throw new UpsApiError("UPS sign-in answered without an access token", 200);
    // UPS writes expires_in as a string of seconds. Anything else, or more than about four months, counts as already run out.
    const expires = isObject(body) && (typeof body.expires_in === "string" || typeof body.expires_in === "number") ? Number(body.expires_in) : 0;
    const seconds = Number.isInteger(expires) && expires > 0 && expires < 10_000_000 ? expires : 0;
    token = { value, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return value;
  }

  async function track(trackingNumber: string): Promise<UpsTrackResult> {
    if (!UPS_TRACKING_NUMBER.test(trackingNumber)) throw new UpsConfigError("not a UPS tracking number");
    const url = `${host}/api/track/v1/details/${trackingNumber}?locale=en_US&returnSignature=false&returnMilestones=false&returnPOD=false`;
    for (let signIns = 0; ; signIns++) {
      const bearer = await signIn();
      const response = await send(() =>
        fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json", transId: randomBytes(16).toString("hex"), transactionSrc: "karatos" },
        }),
      );
      const body = await readJson(response);
      if (response.status === 401 && signIns === 0) {
        token = null;
        continue;
      }
      if (response.status === 404) return { kind: "not_found" };
      if (response.status === 401 || response.status === 403) throw new UpsApiError("UPS turned down the token for tracking: check the app has the Tracking product", response.status, upsErrorCode(body));
      if (response.status !== 200) throw new UpsApiError(`UPS tracking answered HTTP ${response.status}`, response.status, upsErrorCode(body));
      if (!isObject(body)) throw new UpsApiError("UPS tracking answered with a body that isn't a JSON object", 200);
      return { kind: "found", body };
    }
  }

  return { track };
}
