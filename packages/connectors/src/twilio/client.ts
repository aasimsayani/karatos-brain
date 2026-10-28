/**
 * A small client for Twilio's REST API (2010-04-01). Read-only: it only
 * sends GET requests, to two list endpoints (messages and calls) and the
 * next-page links Twilio gives for them, and only on the account it was
 * made for. It signs in with an API key (SK…), ideally a restricted key
 * holding only the message and call read permissions; the account's Auth
 * Token, which can do anything on the account, is turned down.
 */

export const TWILIO_API_HOST = "https://api.twilio.com";

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
const KEY_SID = /^SK[0-9a-f]{32}$/;
const KEY_SECRET = /^[A-Za-z0-9]{32}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The lists the connector reads, and nothing else. */
export const TWILIO_LISTS = {
  messages: { path: "Messages.json", dateFilter: "DateSent>" },
  calls: { path: "Calls.json", dateFilter: "StartTime>" },
} as const;
export type TwilioList = keyof typeof TWILIO_LISTS;

export const TWILIO_PAGE_SIZE = 1000;

export interface TwilioClientOptions {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  pageSize?: number;
}

export class TwilioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwilioConfigError";
  }
}

/** Twilio answered with an error. `code` is Twilio's error code when it gives one. */
export class TwilioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "TwilioApiError";
  }
}

export interface TwilioMessage {
  sid: string;
  direction: string;
  status: string;
  from: string | null;
  to: string | null;
  num_segments?: string | null;
  num_media?: string | null;
  price?: string | null;
  price_unit?: string | null;
  error_code?: number | null;
  date_sent?: string | null;
  date_created?: string | null;
}

export interface TwilioCall {
  sid: string;
  direction: string;
  status: string;
  from: string | null;
  to: string | null;
  duration?: string | null;
  price?: string | null;
  price_unit?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  date_created?: string | null;
}

export interface TwilioPage<T> {
  records: T[];
  /** The path and query of the next page, checked to be on this account's same list. Null on the last page. */
  next: string | null;
}

export interface TwilioClient {
  /** The first page of a list, newest first, from `since` (YYYY-MM-DD, GMT) on. */
  first<L extends TwilioList>(list: L, since: string): Promise<TwilioPage<L extends "messages" ? TwilioMessage : TwilioCall>>;
  /** A page Twilio linked to as next. */
  page<L extends TwilioList>(list: L, next: string): Promise<TwilioPage<L extends "messages" ? TwilioMessage : TwilioCall>>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function twilioClient(options: TwilioClientOptions): TwilioClient {
  const account = options.accountSid?.trim() ?? "";
  const keySid = options.apiKeySid?.trim() ?? "";
  const secret = options.apiKeySecret?.trim() ?? "";
  if (!ACCOUNT_SID.test(account)) throw new TwilioConfigError("TWILIO_ACCOUNT_SID must be the account SID: AC followed by 32 hex characters");
  if (ACCOUNT_SID.test(keySid)) throw new TwilioConfigError("TWILIO_API_KEY_SID must be an API key (SK…), not the account SID: the account's Auth Token can change anything on the account");
  if (!KEY_SID.test(keySid)) throw new TwilioConfigError("TWILIO_API_KEY_SID must be an API key SID: SK followed by 32 hex characters");
  if (!KEY_SECRET.test(secret)) throw new TwilioConfigError("TWILIO_API_KEY_SECRET must be the 32-character secret shown when the API key was created");
  const pageSize = options.pageSize ?? TWILIO_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > TWILIO_PAGE_SIZE) throw new TwilioConfigError(`pageSize must be 1 to ${TWILIO_PAGE_SIZE}`);
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  const authorization = `Basic ${Buffer.from(`${keySid}:${secret}`).toString("base64")}`;
  const listPath = (list: TwilioList) => `/2010-04-01/Accounts/${account}/${TWILIO_LISTS[list].path}`;

  async function get<T>(list: TwilioList, pathAndQuery: string): Promise<TwilioPage<T>> {
    for (let attempt = 0; ; attempt++) {
      // GET only, with no body: the connector never sends a message, places a call or changes a setting.
      const response = await doFetch(`${TWILIO_API_HOST}${pathAndQuery}`, { method: "GET", headers: { authorization, accept: "application/json" } });
      if (response.status === 429 && attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const body = (await response.json().catch(() => null)) as (Record<string, unknown> & { message?: string; code?: number; next_page_uri?: unknown }) | null;
      if (!response.ok) {
        const message = typeof body?.message === "string" ? `: ${body.message.slice(0, 200)}` : "";
        throw new TwilioApiError(`Twilio answered HTTP ${response.status} to the ${list} list${message}`, response.status, typeof body?.code === "number" ? body.code : undefined);
      }
      const records = body?.[list];
      if (!Array.isArray(records)) throw new TwilioApiError(`Twilio's ${list} list did not answer with ${list}`, response.status);
      const next = typeof body!.next_page_uri === "string" && body!.next_page_uri !== "" ? body!.next_page_uri : null;
      if (next !== null && !next.startsWith(`${listPath(list)}?`)) throw new TwilioApiError(`Twilio's next page for ${list} points outside this account's ${list} list`, response.status);
      return { records: records as T[], next };
    }
  }

  return {
    first(list, since) {
      if (!DAY.test(since)) throw new TwilioConfigError("since must be YYYY-MM-DD");
      // Twilio's range filters are written DateSent>=2026-01-01: the ">" is part of the name, the "=" isn't.
      const qs = `PageSize=${pageSize}&${encodeURIComponent(TWILIO_LISTS[list].dateFilter)}=${since}`;
      return get(list, `${listPath(list)}?${qs}`);
    },
    page(list, next) {
      if (!next.startsWith(`${listPath(list)}?`)) return Promise.reject(new TwilioConfigError(`not a next page of this account's ${list} list`));
      return get(list, next);
    },
  };
}
