import { WHATNOT_USER_AGENT } from "../whatnot/client.js";

/**
 * A small client for the Acuity Scheduling API (v1). Requests sign in with
 * HTTP Basic auth: the account's numeric user id as the username and its API
 * key as the password. The key reaches the whole account and Acuity offers
 * no read-only key or scope, so read-only is enforced here, in code: the
 * client sends GET requests to two lists, with query strings it builds
 * itself, and has no way to send anything else.
 *
 * Errors come back as {status_code, message, error}. Acuity allows 10
 * requests a second and 20 connections at once; a 429 or 5xx is retried
 * with backoff before the error goes to runSync.
 */

export const ACUITY_API_BASE = "https://acuityscheduling.com/api/v1";
/**
 * Appointments asked for per request. The docs give 100 as the default of
 * `max` and no upper bound, so the connector asks for no more than that.
 */
export const ACUITY_MAX = 100;
/** Every request carries the User-Agent the other connectors send. */
export const ACUITY_USER_AGENT = WHATNOT_USER_AGENT;

/** The numeric user id Acuity shows beside the API key. */
const USER_ID = /^[1-9][0-9]{0,11}$/;
/** Acuity documents nothing about the key's form, so any 16 to 128 visible ASCII characters are accepted. */
const API_KEY = /^[!-~]{16,128}$/;
/** Dates for minDate and maxDate, written YYYY-MM-DD. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
const CREDENTIALS = "ACUITY_USER_ID must be the numeric user id and ACUITY_API_KEY the API key shown together under Integrations > API in Acuity, on the Premium or Powerhouse plan";

export interface AcuityClientOptions {
  /** The account's numeric user id. */
  userId: string;
  /** The account's API key. It is never logged or shown. */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class AcuityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcuityConfigError";
  }
}

/** Acuity answered with an error. `code` is Acuity's error code, such as too_many_requests, when it gives one that reads. */
export class AcuityApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AcuityApiError";
  }
}

export interface AcuityAppointmentsRequest {
  /** The first day, YYYY-MM-DD; Acuity returns appointments on this day and after. */
  minDate: string;
  /** The last day, YYYY-MM-DD; Acuity returns appointments on this day and before. */
  maxDate: string;
  /** Only canceled appointments when true, only scheduled ones when false. */
  canceled: boolean;
}

export interface AcuityClient {
  /** At most ACUITY_MAX appointments in the days asked for, earliest first, without intake forms. */
  appointments(request: AcuityAppointmentsRequest): Promise<unknown[]>;
  /** Every appointment type, deleted ones too, for their names. */
  appointmentTypes(): Promise<unknown[]>;
}

/** True for a real calendar day written YYYY-MM-DD. */
export function isAcuityDay(value: unknown): value is string {
  return typeof value === "string" && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** Acuity's error code and message, cut short. Error bodies describe the request, never the key. */
function detail(body: unknown): { code: string | undefined; text: string } {
  const b = (typeof body === "object" && body !== null ? body : {}) as { error?: unknown; message?: unknown };
  const code = typeof b.error === "string" && /^[a-z_]{1,64}$/.test(b.error) ? b.error : undefined;
  const message = typeof b.message === "string" ? b.message.slice(0, 200) : "";
  return { code, text: `${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}` };
}

export function acuityClient(options: AcuityClientOptions): AcuityClient {
  const userId = typeof options.userId === "string" ? options.userId.trim() : "";
  const apiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  if (!USER_ID.test(userId)) throw new AcuityConfigError("set ACUITY_USER_ID to the numeric user id shown with the API key under Integrations > API in Acuity");
  if (!API_KEY.test(apiKey)) throw new AcuityConfigError("set ACUITY_API_KEY to the API key shown under Integrations > API in Acuity");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  const authorization = `Basic ${Buffer.from(`${userId}:${apiKey}`, "utf8").toString("base64")}`;

  async function get(path: string, what: string, query: URLSearchParams): Promise<unknown[]> {
    const url = `${ACUITY_API_BASE}${path}?${query}`;
    for (let attempt = 0; ; attempt++) {
      // GET only, with the credentials in the Authorization header and never in the URL.
      const response = await doFetch(url, { method: "GET", headers: { accept: "application/json", authorization, "user-agent": ACUITY_USER_AGENT } });
      if (RETRIED.has(response.status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isSafeInteger(after) && after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const body: unknown = await response.json().catch(() => null);
      const { code, text } = detail(body);
      if (response.status === 401 || response.status === 403) throw new AcuityConfigError(`Acuity turned down the credentials (HTTP ${response.status})${text}; ${CREDENTIALS}`);
      if (response.status !== 200) throw new AcuityApiError(`Acuity answered HTTP ${response.status} for the ${what}${text}`, response.status, code);
      if (!Array.isArray(body)) throw new AcuityApiError(`Acuity answered the ${what} without a list that reads`, 200);
      return body;
    }
  }

  return {
    appointments: async ({ minDate, maxDate, canceled }) => {
      if (!isAcuityDay(minDate) || !isAcuityDay(maxDate) || maxDate < minDate) throw new AcuityApiError("the appointments must be asked for between two days written YYYY-MM-DD, the first no later than the last", 0);
      const query = new URLSearchParams({ max: String(ACUITY_MAX), minDate, maxDate, canceled: String(canceled === true), direction: "ASC", excludeForms: "true" });
      return get("/appointments", canceled === true ? "canceled appointments" : "appointments", query);
    },
    appointmentTypes: () => get("/appointment-types", "appointment types", new URLSearchParams({ includeDeleted: "true" })),
  };
}
