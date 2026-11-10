/**
 * A small client for TaxJar's SmartCalcs API v2: order and refund
 * transactions and the account's nexus regions. TaxJar issues one kind of
 * API token, which can't be limited to reading: the same token creates,
 * changes and deletes transactions. So this client is what keeps KaratOS to
 * reading. It only ever sends the five GETs below, to TaxJar's fixed
 * production or sandbox address, with paths and filters it builds itself
 * from checked values. It has no way to send a POST, PUT or DELETE.
 *
 * TaxJar lists transactions as ids only, by the day they were recorded, and
 * one source (`provider`) at a time; each one is then read on its own.
 * Rate limits (429) and 500, 502, 503 and 504 are waited out a few times
 * before the error goes to runSync, which keeps the checkpoint.
 */

export const TAXJAR_HOSTS = { production: "https://api.taxjar.com/v2", sandbox: "https://api.sandbox.taxjar.com/v2" } as const;
export type TaxjarEnvironment = keyof typeof TAXJAR_HOSTS;
/** The API version asked for, so a newer default can't change what TaxJar answers. */
export const TAXJAR_API_VERSION = "2022-01-24";
/** Where transactions were recorded. TaxJar's own default is api: the ones sent through its API. */
export const TAXJAR_PROVIDER = /^[a-z][a-z0-9_]{0,31}$/;
/** Transaction ids the client will ask for. TaxJar takes any text; longer ids aren't read. */
const MAX_ID_LENGTH = 255;
const MAX_RETRY_AFTER_S = 60;
/** A day as TaxJar's list filters take it. */
const DAY = /^\d{4}\/\d{2}\/\d{2}$/;
const RETRIED = new Set([429, 500, 502, 503, 504]);

export interface TaxjarClientOptions {
  /** Sent to TaxJar only, and never logged or shown. */
  apiToken: string;
  /** Which TaxJar the token is for. Production unless set. */
  environment?: TaxjarEnvironment;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class TaxjarConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxjarConfigError";
  }
}

/** TaxJar answered with an error. `detail` is TaxJar's own explanation, when it gave one that reads. */
export class TaxjarApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "TaxjarApiError";
  }
}

export type TaxjarKind = "orders" | "refunds";

export interface TaxjarListQuery {
  /** First and last day recorded, both included, as YYYY/MM/DD. */
  from: string;
  to: string;
  provider: string;
}

export interface TaxjarClient {
  /** Ids of the order or refund transactions recorded in a span of days by one provider. */
  list(kind: TaxjarKind, query: TaxjarListQuery): Promise<string[]>;
  /** One order or refund transaction, or null when TaxJar no longer has it. */
  show(kind: TaxjarKind, id: string, provider: string): Promise<Record<string, unknown> | null>;
  /** The states and countries the account has nexus in. */
  nexusRegions(): Promise<unknown[]>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** TaxJar's explanation from an error body ({error, detail, status}), when it is short plain text. */
export function taxjarErrorDetail(body: unknown): string | undefined {
  const detail = isObject(body) ? body.detail : undefined;
  return typeof detail === "string" && /^[\p{L}\p{N} .,'"/:_()#-]{1,200}$/u.test(detail) ? detail : undefined;
}

/** True for a transaction id the client will put in a path. */
export const taxjarId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH && id.trim() === id;

export function taxjarClient(options: TaxjarClientOptions): TaxjarClient {
  const token = options.apiToken?.trim() ?? "";
  if (!/^[A-Za-z0-9]{16,128}$/.test(token)) throw new TaxjarConfigError("TAXJAR_API_TOKEN is missing or not in the expected shape");
  const environment = options.environment ?? "production";
  if (environment !== "production" && environment !== "sandbox") throw new TaxjarConfigError("TAXJAR_ENVIRONMENT must be production or sandbox");
  const base = TAXJAR_HOSTS[environment];
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json", "x-api-version": TAXJAR_API_VERSION };

  const checkProvider = (provider: string) => {
    if (!TAXJAR_PROVIDER.test(provider)) throw new TaxjarConfigError("TAXJAR_PROVIDERS must be lowercase source names such as api or shopify");
  };

  /** A GET, and its body when TaxJar answered 200 with a JSON object. Null for a 404 when `missingIsNull`. */
  async function get(path: string, query: Record<string, string>, what: string, missingIsNull = false): Promise<Record<string, unknown> | null> {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url.toString(), { method: "GET", headers });
      if (RETRIED.has(response.status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(1000 * (Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) : 2 ** attempt));
        continue;
      }
      const body: unknown = await response.json().catch(() => undefined);
      const detail = taxjarErrorDetail(body);
      const why = detail ? ` (${detail})` : "";
      if (response.status === 401) throw new TaxjarApiError("TaxJar turned down the API token: check TAXJAR_API_TOKEN, and that TAXJAR_ENVIRONMENT matches where it was made", 401, detail);
      if (response.status === 403) throw new TaxjarApiError(`TaxJar's account isn't allowed to read ${what}${why}`, 403, detail);
      if (response.status === 404 && missingIsNull) return null;
      if (response.status !== 200) throw new TaxjarApiError(`TaxJar answered HTTP ${response.status} for ${what}${why}`, response.status, detail);
      if (!isObject(body)) throw new TaxjarApiError(`TaxJar answered ${what} with a body that isn't a JSON object`, 200);
      return body;
    }
  }

  return {
    async list(kind, query) {
      checkProvider(query.provider);
      if (!DAY.test(query.from) || !DAY.test(query.to)) throw new TaxjarApiError("transactions must be listed between YYYY/MM/DD days", 0);
      const body = (await get(`/transactions/${kind}`, { from_transaction_date: query.from, to_transaction_date: query.to, provider: query.provider }, `${kind} transactions`))!;
      const ids = body[kind];
      if (!Array.isArray(ids)) throw new TaxjarApiError(`TaxJar answered ${kind} transactions without the ${kind} list`, 200);
      return ids.filter(taxjarId);
    },
    async show(kind, id, provider) {
      checkProvider(provider);
      if (!taxjarId(id)) throw new TaxjarApiError("a transaction id must be 1 to 255 characters with no spaces at either end", 0);
      const body = await get(`/transactions/${kind}/${encodeURIComponent(id)}`, { provider }, `a ${kind === "orders" ? "order" : "refund"} transaction`, true);
      if (body === null) return null;
      const record = body[kind === "orders" ? "order" : "refund"];
      if (!isObject(record)) throw new TaxjarApiError(`TaxJar answered a ${kind === "orders" ? "order" : "refund"} transaction without it`, 200);
      return record;
    },
    async nexusRegions() {
      const body = (await get("/nexus/regions", {}, "nexus regions"))!;
      if (!Array.isArray(body.regions)) throw new TaxjarApiError("TaxJar answered nexus regions without the regions list", 200);
      return body.regions;
    },
  };
}
