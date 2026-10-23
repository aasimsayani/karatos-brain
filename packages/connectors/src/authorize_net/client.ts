/**
 * A small client for Authorize.net's JSON API. Every call is a POST of one
 * named request to the same endpoint, and the API Login ID and Transaction
 * Key that read reports can also charge cards, refund and void: Authorize.net
 * can't limit a key to reading. So read-only is enforced here, in code: the
 * client sends only the Transaction Reporting requests below, with only the
 * fields it knows, and throws before sending anything else.
 *
 * The JSON API is a translation of the XML one, so fields go out in the
 * order the XML schema sets. Errors come back as HTTP 200 with resultCode
 * Error, and responses start with a byte order mark, which Authorize.net
 * keeps so as not to break existing integrations.
 *
 * Authorize.net publishes no rate limit. Calls go one at a time, and a 429
 * or 503 is retried with backoff before the error goes to runSync.
 */

export const AUTHORIZE_NET_API_URLS = {
  production: "https://api.authorize.net/xml/v1/request.api",
  sandbox: "https://apitest.authorize.net/xml/v1/request.api",
} as const;
export type AuthorizeNetEnvironment = keyof typeof AUTHORIZE_NET_API_URLS;

/** The largest page the reporting calls return. */
export const AUTHORIZE_NET_PAGE_SIZE = 1000;
/** The longest span one settled batch list may cover. */
export const AUTHORIZE_NET_BATCH_WINDOW_DAYS = 31;

/** Each reporting request the client may send, with its fields in schema order. Nothing else is sent. */
const FIELDS = {
  getMerchantDetailsRequest: [],
  getSettledBatchListRequest: ["includeStatistics", "firstSettlementDate", "lastSettlementDate"],
  getTransactionListRequest: ["batchId", "sorting", "paging"],
  getUnsettledTransactionListRequest: ["sorting", "paging"],
  getTransactionDetailsRequest: ["transId"],
} as const satisfies Record<string, readonly string[]>;

export type AuthorizeNetRequestType = keyof typeof FIELDS;
export const AUTHORIZE_NET_READ_REQUESTS = Object.keys(FIELDS) as AuthorizeNetRequestType[];

export interface AuthorizeNetSorting {
  orderBy: "id" | "submitTimeUTC";
  orderDescending: boolean;
}

export interface AuthorizeNetPaging {
  /** 1 to 1000. */
  limit: number;
  /** The 1-based page number, not a record offset. */
  offset: number;
}

export interface AuthorizeNetRequestFields {
  includeStatistics?: boolean;
  /** ISO times in UTC, at most 31 days apart. */
  firstSettlementDate?: string;
  lastSettlementDate?: string;
  batchId?: string;
  transId?: string;
  sorting?: AuthorizeNetSorting;
  paging?: AuthorizeNetPaging;
}

export interface AuthorizeNetClientOptions {
  /** The merchant's API Login ID. */
  apiLoginId: string;
  /** The merchant's Transaction Key. It can move money, so it is never logged or shown. */
  transactionKey: string;
  /** No default, so a sandbox setting can't reach a merchant's live account by accident and the other way round. */
  environment: AuthorizeNetEnvironment | string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 503 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class AuthorizeNetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizeNetConfigError";
  }
}

/** Authorize.net answered with an error. `code` is its message code, such as E00007, when it gives one. */
export class AuthorizeNetApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "AuthorizeNetApiError";
    this.status = status;
    this.code = code;
  }
}

export interface AuthorizeNetClient {
  readonly environment: AuthorizeNetEnvironment;
  request(type: AuthorizeNetRequestType, fields?: AuthorizeNetRequestFields): Promise<Record<string, unknown>>;
}

const LOGIN_ID = /^[A-Za-z0-9]{1,25}$/;
const TRANSACTION_KEY = /^[A-Za-z0-9]{16}$/;
const ID = /^\d{1,20}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MAX_RETRY_AFTER_S = 60;
const BOM = /^﻿/;

/** Hints for the error codes an owner can fix. */
const HINTS: Record<string, string> = {
  E00007: "; check AUTHORIZE_NET_API_LOGIN_ID, AUTHORIZE_NET_TRANSACTION_KEY and AUTHORIZE_NET_ENVIRONMENT",
  E00011: "; turn on the Transaction Details API in the Merchant Interface (Account > Settings > Security Settings)",
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The fields of one request, checked and written in schema order, with values as the docs' JSON examples write them. */
function body(type: AuthorizeNetRequestType, fields: AuthorizeNetRequestFields): Record<string, unknown> {
  const allowed: readonly string[] = FIELDS[type];
  const extra = Object.keys(fields).filter((k) => !allowed.includes(k) && fields[k as keyof AuthorizeNetRequestFields] !== undefined);
  if (extra.length) throw new AuthorizeNetConfigError(`${type} doesn't take ${extra.join(", ")}`);
  const out: Record<string, unknown> = {};
  for (const name of allowed) {
    const value = fields[name as keyof AuthorizeNetRequestFields];
    if (value === undefined) continue;
    switch (name) {
      case "includeStatistics":
        if (typeof value !== "boolean") throw new AuthorizeNetConfigError("includeStatistics must be true or false");
        out[name] = String(value);
        break;
      case "firstSettlementDate":
      case "lastSettlementDate":
        if (typeof value !== "string" || !UTC.test(value) || Number.isNaN(Date.parse(value))) throw new AuthorizeNetConfigError(`${name} must be an ISO time in UTC to the second`);
        out[name] = value;
        break;
      case "batchId":
      case "transId":
        if (typeof value !== "string" || !ID.test(value)) throw new AuthorizeNetConfigError(`${name} must be Authorize.net's numeric id`);
        out[name] = value;
        break;
      case "sorting": {
        const s = value as AuthorizeNetSorting;
        if ((s.orderBy !== "id" && s.orderBy !== "submitTimeUTC") || typeof s.orderDescending !== "boolean") throw new AuthorizeNetConfigError("sorting must be by id or submitTimeUTC");
        out[name] = { orderBy: s.orderBy, orderDescending: String(s.orderDescending) };
        break;
      }
      case "paging": {
        const p = value as AuthorizeNetPaging;
        const whole = (n: unknown, max: number) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= max;
        if (!whole(p.limit, AUTHORIZE_NET_PAGE_SIZE) || !whole(p.offset, 100_000)) throw new AuthorizeNetConfigError("paging takes a limit from 1 to 1000 and a page from 1");
        out[name] = { limit: String(p.limit), offset: String(p.offset) };
        break;
      }
    }
  }
  if (type === "getSettledBatchListRequest") {
    const first = Date.parse(String(out.firstSettlementDate));
    const last = Date.parse(String(out.lastSettlementDate));
    if (!(last >= first) || last - first > AUTHORIZE_NET_BATCH_WINDOW_DAYS * 86_400_000) {
      throw new AuthorizeNetConfigError("a settled batch list covers a first and last settlement date at most 31 days apart");
    }
  }
  return out;
}

/** The first message Authorize.net sent, cut short. Messages describe the request, never the key. */
function messageOf(body: unknown): { code?: string; text?: string } {
  const message = ((body as { messages?: { message?: unknown } } | null)?.messages?.message ?? []) as unknown;
  const first = (Array.isArray(message) ? message[0] : message) as { code?: unknown; text?: unknown } | undefined;
  return {
    ...(typeof first?.code === "string" ? { code: first.code.slice(0, 10) } : {}),
    ...(typeof first?.text === "string" ? { text: first.text.slice(0, 200) } : {}),
  };
}

export function authorizeNetClient(options: AuthorizeNetClientOptions): AuthorizeNetClient {
  const apiLoginId = options.apiLoginId?.trim() ?? "";
  const transactionKey = options.transactionKey?.trim() ?? "";
  if (!apiLoginId || !transactionKey) throw new AuthorizeNetConfigError("set AUTHORIZE_NET_API_LOGIN_ID and AUTHORIZE_NET_TRANSACTION_KEY");
  if (!LOGIN_ID.test(apiLoginId)) throw new AuthorizeNetConfigError("AUTHORIZE_NET_API_LOGIN_ID must be the API Login ID: up to 25 letters and digits");
  if (!TRANSACTION_KEY.test(transactionKey)) throw new AuthorizeNetConfigError("AUTHORIZE_NET_TRANSACTION_KEY must be the 16-character Transaction Key");
  const environment = options.environment;
  if (environment !== "production" && environment !== "sandbox") throw new AuthorizeNetConfigError("AUTHORIZE_NET_ENVIRONMENT must be production or sandbox");
  const url = AUTHORIZE_NET_API_URLS[environment];
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;

  return {
    environment,
    async request(type, fields = {}) {
      // The allowlist: the same key can create transactions, so nothing outside reporting is ever sent.
      if (!Object.hasOwn(FIELDS, type)) throw new AuthorizeNetConfigError("the Authorize.net connector only sends Transaction Reporting requests");
      // merchantAuthentication comes first, as the schema orders it.
      const payload = JSON.stringify({ [type]: { merchantAuthentication: { name: apiLoginId, transactionKey }, ...body(type, fields) } });
      for (let attempt = 0; ; attempt++) {
        const response = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: payload });
        if ((response.status === 429 || response.status === 503) && attempt < retries) {
          const after = Number(response.headers?.get("retry-after"));
          await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : 1000 * 2 ** attempt);
          continue;
        }
        if (!response.ok) throw new AuthorizeNetApiError(`Authorize.net answered HTTP ${response.status}`, response.status);
        // fetch's text() drops a leading BOM as it decodes UTF-8; other fetch implementations may not.
        const text = (await response.text()).replace(BOM, "");
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new AuthorizeNetApiError("Authorize.net did not answer with JSON", response.status);
        }
        if (!parsed || typeof parsed !== "object") throw new AuthorizeNetApiError("Authorize.net did not answer with JSON", response.status);
        const result = (parsed as { messages?: { resultCode?: unknown } }).messages?.resultCode;
        if (result !== "Ok") {
          const { code, text: message } = messageOf(parsed);
          const hint = code && Object.hasOwn(HINTS, code) ? HINTS[code] : "";
          throw new AuthorizeNetApiError(`Authorize.net refused ${type}${code ? ` (${code}${message ? `: ${message}` : ""})` : ""}${hint}`, response.status, code);
        }
        return parsed as Record<string, unknown>;
      }
    },
  };
}
