/**
 * A small client for Yext's Management API (v2), for the store's own Yext
 * account: its locations and the reviews Yext gathers from Google, Yelp,
 * Facebook and the other publishers it watches. Read-only by request: its
 * only requests are two GETs, the location list and the review list, with
 * parameters it builds and checks itself. Yext API keys carry no scopes the
 * client could check, so the app the key belongs to should be given read
 * access to Entities and Reviews and nothing else.
 *
 * The API key goes in an api-key header, never in a URL.
 */

export const YEXT_API_URLS = {
  production: "https://api.yextapis.com/v2",
  sandbox: "https://sbx-api.yextapis.com/v2",
} as const;
export type YextEnvironment = keyof typeof YEXT_API_URLS;

/** The API version date sent with every request. Yext asks for a fixed one. */
export const YEXT_API_VERSION = "20261101";
/** Locations asked for per page; Yext's most. */
export const YEXT_LOCATION_PAGE_SIZE = 50;
/** Reviews asked for per page; Yext's most. */
export const YEXT_REVIEW_PAGE_SIZE = 100;
/** The location fields read. */
export const YEXT_LOCATION_FIELDS = ["meta", "name", "address", "closed", "timezone"] as const;

/** Reviews whose last Yext update falls on these days, both YYYY-MM-DD in UTC and inclusive. */
export interface YextRange {
  from: string;
  until: string;
}

export interface YextClientOptions {
  /** An API key of a Yext app the store owns (YEXT_API_KEY). */
  apiKey: string;
  /** The Yext account id (YEXT_ACCOUNT_ID); "me", the key's own account, when not set. */
  accountId?: string | undefined;
  /** production or sandbox (YEXT_ENVIRONMENT); production when not set. */
  environment?: string | undefined;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate-limited or failed request is retried here before the error goes to runSync. */
  retries?: number;
}

export class YextConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YextConfigError";
  }
}

/** Yext answered with an error. `code` is the first error's code in meta.errors, when it gives one. */
export class YextApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;

  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = "YextApiError";
    this.status = status;
    this.code = code;
  }
}

export interface YextClient {
  /** One page of the account's locations. */
  locations(pageToken: string | null): Promise<Record<string, unknown>>;
  /** One page of reviews last updated in the range. */
  reviews(range: YextRange, pageToken: string | null): Promise<Record<string, unknown>>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A page token as Yext returns it. */
const PAGE_TOKEN = /^[A-Za-z0-9_=+/.-]{1,2048}$/;
const ACCOUNT = /^(me|[A-Za-z0-9_-]{1,64})$/;
/** Printable, no spaces, as it goes in a header. */
const CREDENTIAL = /^[\x21-\x7e]{8,256}$/;
const MAX_WAIT_MS = 64_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A YYYY-MM-DD day as epoch milliseconds, or NaN when it isn't a real day. */
export function yextDayMs(value: unknown): number {
  if (typeof value !== "string" || !DAY.test(value)) return Number.NaN;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : Number.NaN;
}

function token(pageToken: string | null): string | null {
  if (pageToken !== null && !(typeof pageToken === "string" && PAGE_TOKEN.test(pageToken))) throw new YextConfigError("pageToken must be the one Yext returned");
  return pageToken;
}

/** The query string for a page of locations, or a YextConfigError for a token Yext didn't give. */
export function yextLocationParams(pageToken: string | null): URLSearchParams {
  const params = new URLSearchParams({ v: YEXT_API_VERSION, entityTypes: "location", fields: YEXT_LOCATION_FIELDS.join(","), limit: String(YEXT_LOCATION_PAGE_SIZE) });
  if (token(pageToken) !== null) params.set("pageToken", pageToken!);
  return params;
}

/** The query string for a page of reviews, or a YextConfigError before anything is sent. */
export function yextReviewParams(range: YextRange, pageToken: string | null): URLSearchParams {
  const extra = Object.keys(range ?? {}).filter((k) => k !== "from" && k !== "until");
  if (extra.length) throw new YextConfigError(`reviews don't take ${extra.slice(0, 3).join(", ")}`);
  const from = yextDayMs(range.from);
  const until = yextDayMs(range.until);
  if (Number.isNaN(from) || Number.isNaN(until)) throw new YextConfigError("from and until must be days as YYYY-MM-DD");
  if (until < from) throw new YextConfigError("until must not be before from");
  const params = new URLSearchParams({ v: YEXT_API_VERSION, limit: String(YEXT_REVIEW_PAGE_SIZE), minLastYextUpdateDate: range.from, maxLastYextUpdateDate: range.until });
  if (token(pageToken) !== null) params.set("pageToken", pageToken!);
  return params;
}

/** The first error Yext put in meta.errors: its code and message, cut short. Error bodies describe the request, never the key. */
function errorOf(body: unknown): { code?: number; message: string } {
  const meta = body && typeof body === "object" ? (body as { meta?: unknown }).meta : undefined;
  const errors = meta && typeof meta === "object" ? (meta as { errors?: unknown }).errors : undefined;
  const first = (Array.isArray(errors) && errors[0] && typeof errors[0] === "object" ? errors[0] : {}) as { code?: unknown; message?: unknown };
  return { ...(typeof first.code === "number" && Number.isInteger(first.code) ? { code: first.code } : {}), message: typeof first.message === "string" ? first.message.slice(0, 200) : "" };
}

const HINTS: Record<number, string> = {
  401: "; check YEXT_API_KEY",
  403: "; give the Yext app read access to Entities and Reviews",
};

export function yextClient(options: YextClientOptions): YextClient {
  const apiKey = options.apiKey?.trim() ?? "";
  if (!CREDENTIAL.test(apiKey)) throw new YextConfigError("set YEXT_API_KEY");
  const accountId = options.accountId?.trim() || "me";
  if (!ACCOUNT.test(accountId)) throw new YextConfigError("YEXT_ACCOUNT_ID must be the account id Yext shows, or left unset");
  const environment = options.environment?.trim() || "production";
  if (!Object.hasOwn(YEXT_API_URLS, environment)) throw new YextConfigError("YEXT_ENVIRONMENT must be production or sandbox");
  const base = `${YEXT_API_URLS[environment as YextEnvironment]}/accounts/${accountId}`;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 3;

  // GET only, to the two paths the connector reads, with the key in a header and never in the URL.
  async function get(path: "/entities" | "/reviews", params: URLSearchParams): Promise<Record<string, unknown>> {
    const url = `${base}${path}?${params}`;
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, { method: "GET", headers: { accept: "application/json", "api-key": apiKey } });
      const answer: unknown = await response.json().catch(() => null);
      const { code, message } = errorOf(answer);
      // Over the hourly quota or a burst limit, and Yext's own outages, are worth waiting out.
      if (response.status === 429 || response.status === 500 || response.status === 504) {
        if (attempt < retries) {
          await sleep(Math.min(1000 * 2 ** attempt, MAX_WAIT_MS));
          continue;
        }
        const why = response.status === 429 ? "Yext kept rate-limiting the sync; its quota refills over the hour" : `Yext kept answering HTTP ${response.status}`;
        throw new YextApiError(`${why}, and the next sync resumes from the checkpoint`, response.status, code);
      }
      if (!response.ok) throw new YextApiError(`Yext answered HTTP ${response.status}${message ? `: ${message}` : ""}${HINTS[response.status] ?? ""}`, response.status, code);
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new YextApiError("Yext did not answer with JSON", response.status);
      return answer as Record<string, unknown>;
    }
  }

  return {
    locations: async (pageToken) => get("/entities", yextLocationParams(pageToken)),
    reviews: async (range, pageToken) => get("/reviews", yextReviewParams(range, pageToken)),
  };
}
