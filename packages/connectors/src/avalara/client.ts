/**
 * A small client for Avalara's AvaTax REST API v2: the connection check,
 * the company lookup and a company's transactions. Requests use HTTP Basic
 * with the account ID and license key, which AvaTax can't limit to reading:
 * a license key can do anything the account can. So the client only ever
 * sends the three GETs below, to AvaTax's fixed sandbox or production
 * address, with filters it builds itself from checked values, and pages by
 * its own filter rather than by the `@nextLink` AvaTax returns.
 */

export const AVALARA_HOSTS = { production: "https://rest.avatax.com", sandbox: "https://sandbox-rest.avatax.com" } as const;
export type AvalaraEnvironment = keyof typeof AVALARA_HOSTS;
/** Rows per page: AvaTax returns at most 1,000. */
export const AVALARA_PAGE_SIZE = 1000;
/** Sent as X-Avalara-Client, which AvaTax asks every caller to set: app; version; client; API version; machine. */
export const AVALARA_CLIENT_HEADER = "KaratOS; 0.1; REST; v2; karatos-brain";
const MAX_RETRY_WAIT_S = 60;

export const AVALARA_ACCOUNT_ID = /^[1-9][0-9]{0,11}$/;
export const AVALARA_LICENSE_KEY = /^[A-Za-z0-9]{16,64}$/;
/** Company codes the client sends. AvaTax allows more, but these need no escaping in a path or a filter. */
export const AVALARA_COMPANY_CODE = /^[A-Za-z0-9_.-]{1,25}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$/;

export interface AvalaraClientOptions {
  accountId: string;
  /** Sent to AvaTax only, and never logged or shown. */
  licenseKey: string;
  /** Which AvaTax the credentials are for. There is no default, so sandbox credentials can't reach a live account by accident. */
  environment: AvalaraEnvironment;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 503 is retried here before the error goes to runSync. */
  retries?: number;
}

export class AvalaraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvalaraConfigError";
  }
}

export class AvalaraApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** AvaTax's error code, such as AuthenticationException, when it gave one that reads. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "AvalaraApiError";
  }
}

export interface AvalaraCompany {
  id: number;
  companyCode: string;
  isActive: boolean;
  isTest: boolean;
}

/** Which transactions to list: by id from a day (the import), or by when they changed (later syncs). */
export type AvalaraTransactionQuery =
  | { fromDay: string; afterId: number }
  | { fromDay: string; modifiedFrom: string; skip: number };

export interface AvalaraClient {
  /** Checks the credentials are accepted and belong to the configured account. */
  ping(): Promise<void>;
  /** The company with this code, or the account's default company when no code is given. */
  company(companyCode?: string): Promise<AvalaraCompany>;
  /** One page of a company's transactions, with their jurisdiction summary and no lines. */
  transactions(companyCode: string, query: AvalaraTransactionQuery): Promise<unknown[]>;
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** AvaTax's error code from an error body, when it is a plain word. */
function errorCode(body: unknown): string | undefined {
  const code = obj(obj(body)?.error)?.code;
  return typeof code === "string" && /^[A-Za-z]{1,80}$/.test(code) ? code : undefined;
}

export function avalaraClient(options: AvalaraClientOptions): AvalaraClient {
  if (!AVALARA_ACCOUNT_ID.test(options.accountId)) throw new AvalaraConfigError("AVALARA_ACCOUNT_ID is missing or not an account number");
  if (!AVALARA_LICENSE_KEY.test(options.licenseKey)) throw new AvalaraConfigError("AVALARA_LICENSE_KEY is missing or not in the expected shape");
  const environment = options.environment;
  if (environment !== "production" && environment !== "sandbox") throw new AvalaraConfigError("AVALARA_ENVIRONMENT must be sandbox or production");
  const base = AVALARA_HOSTS[environment];
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.retries ?? 3;
  const headers = {
    Authorization: `Basic ${Buffer.from(`${options.accountId}:${options.licenseKey}`).toString("base64")}`,
    Accept: "application/json",
    "X-Avalara-Client": AVALARA_CLIENT_HEADER,
  };

  async function get(path: string, query: Record<string, string>, what: string): Promise<Record<string, unknown>> {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { method: "GET", headers });
      if ((response.status === 429 || response.status === 503) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(1000 * (Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_WAIT_S) : 2 ** attempt));
        continue;
      }
      const body = await response.json().catch(() => undefined);
      const code = errorCode(body);
      if (response.status === 401) throw new AvalaraApiError("AvaTax turned down the account ID and license key: check AVALARA_ACCOUNT_ID and AVALARA_LICENSE_KEY, and that AVALARA_ENVIRONMENT matches where the key was made", 401, code);
      if (response.status === 403) throw new AvalaraApiError(`AvaTax's account isn't allowed to read ${what}${code ? ` (${code})` : ""}`, 403, code);
      if (response.status === 404) throw new AvalaraApiError(`AvaTax found no ${what}${code ? ` (${code})` : ""}`, 404, code);
      if (response.status !== 200) throw new AvalaraApiError(`AvaTax answered HTTP ${response.status} for ${what}${code ? ` (${code})` : ""}`, response.status, code);
      const value = obj(body);
      if (!value) throw new AvalaraApiError(`AvaTax answered ${what} with a body that isn't a JSON object`, 200);
      return value;
    }
  }

  async function list(path: string, query: Record<string, string>, what: string): Promise<unknown[]> {
    const body = await get(path, query, what);
    if (!Array.isArray(body.value)) throw new AvalaraApiError(`AvaTax answered ${what} without the value list`, 200);
    return body.value;
  }

  return {
    async ping() {
      const body = await get("/api/v2/utilities/ping", {}, "the connection check");
      // Ping always answers 200; it says whether the credentials were accepted.
      if (body.authenticated !== true) throw new AvalaraApiError("AvaTax turned down the account ID and license key: check AVALARA_ACCOUNT_ID and AVALARA_LICENSE_KEY, and that AVALARA_ENVIRONMENT matches where the key was made", 401);
      if (String(body.authenticatedAccountId) !== options.accountId) throw new AvalaraApiError("AvaTax signed in to a different account than AVALARA_ACCOUNT_ID", 401);
    },
    async company(companyCode) {
      if (companyCode !== undefined && !AVALARA_COMPANY_CODE.test(companyCode)) throw new AvalaraConfigError("AVALARA_COMPANY_CODE is not in the expected shape");
      const filter = companyCode === undefined ? "isDefault eq true" : `companyCode eq '${companyCode}'`;
      const rows = await list("/api/v2/companies", { $filter: filter, $top: "2" }, "companies");
      const matches = rows.map(obj).filter((c): c is Record<string, unknown> => !!c && (companyCode === undefined ? c.isDefault === true : c.companyCode === companyCode));
      if (matches.length !== 1) {
        throw new AvalaraApiError(companyCode === undefined ? "AvaTax has no single default company: set AVALARA_COMPANY_CODE" : `AvaTax has no company with the code in AVALARA_COMPANY_CODE`, 404);
      }
      const c = matches[0]!;
      if (typeof c.id !== "number" || !Number.isSafeInteger(c.id) || typeof c.companyCode !== "string" || !AVALARA_COMPANY_CODE.test(c.companyCode)) {
        throw new AvalaraApiError("AvaTax answered the company without an id and code that read", 200);
      }
      return { id: c.id, companyCode: c.companyCode, isActive: c.isActive === true, isTest: c.isTest === true };
    },
    async transactions(companyCode, query) {
      if (!AVALARA_COMPANY_CODE.test(companyCode)) throw new AvalaraConfigError("AVALARA_COMPANY_CODE is not in the expected shape");
      if (!DAY.test(query.fromDay)) throw new AvalaraApiError("transactions must be listed from a YYYY-MM-DD day", 0);
      let params: Record<string, string>;
      if ("afterId" in query) {
        if (!Number.isSafeInteger(query.afterId) || query.afterId < 0) throw new AvalaraApiError("transactions must be listed after a whole id", 0);
        params = { $filter: `date ge '${query.fromDay}' and id gt ${query.afterId}`, $orderBy: "id ASC" };
      } else {
        if (!ISO.test(query.modifiedFrom)) throw new AvalaraApiError("transactions must be listed from a UTC time", 0);
        if (!Number.isSafeInteger(query.skip) || query.skip < 0) throw new AvalaraApiError("transactions skip must be a whole number", 0);
        params = { $filter: `date ge '${query.fromDay}' and modifiedDate ge '${query.modifiedFrom}'`, $orderBy: "modifiedDate ASC, id ASC", ...(query.skip ? { $skip: String(query.skip) } : {}) };
      }
      return list(`/api/v2/companies/${companyCode}/transactions`, { ...params, $include: "SummaryOnly", $top: String(AVALARA_PAGE_SIZE) }, "transactions");
    },
  };
}
