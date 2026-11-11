/**
 * A small client for RepairShopr's REST API, read-only. RepairShopr signs a
 * request in with an API token made under Admin > API Tokens, sent as a
 * bearer token. A token can be given custom permissions, so the one made
 * for KaratOS needs only "Tickets - List/Search", "Estimates - List/Search"
 * and "Invoices - List/Search". The client keeps to the reads anyway: it
 * sends only GET requests to those three lists, on the one account the
 * settings name.
 *
 * RepairShopr's own error text is never put in an error here, only the HTTP
 * status. RepairShopr allows 180 requests a minute; a 429 is waited out for
 * as long as Retry-After says, or a minute, and a 500, 502, 503 or 504 a few
 * seconds, a few times, before the error goes to runSync, which keeps the
 * checkpoint.
 */

/** The lists the connector reads, in the order a pass reads them. */
export const REPAIRSHOPR_LISTS = ["tickets", "estimates", "invoices"] as const;
export type RepairShoprList = (typeof REPAIRSHOPR_LISTS)[number];
const MAX_RETRY_AFTER_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
/** An account's subdomain, as in example.repairshopr.com. */
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{16,512}$/;
/** A UTC time as toISOString writes it. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface RepairShoprClientOptions {
  /** A RepairShopr API token. Sent to RepairShopr only, and never logged or shown. */
  apiToken: string;
  /** The account's subdomain, as a name, a host or a URL: example, example.repairshopr.com. */
  subdomain: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class RepairShoprConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairShoprConfigError";
  }
}

export class RepairShoprApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RepairShoprApiError";
  }
}

/** Which records a page lists: tickets and invoices changed, or estimates made, at or after a time. */
export interface RepairShoprQuery {
  list: RepairShoprList;
  /** A UTC time as toISOString writes it. */
  since: string;
  /** Pages are counted from 1. */
  page: number;
}

export interface RepairShoprPage {
  records: unknown[];
  /** A later page may hold more. */
  more: boolean;
}

export interface RepairShoprClient {
  readonly baseUrl: string;
  list(q: RepairShoprQuery): Promise<RepairShoprPage>;
}

/** The parameter each list is searched by: tickets and invoices by when they changed, estimates by when they were made. */
const SINCE: Record<RepairShoprList, string> = { tickets: "since_updated_at", estimates: "created_after", invoices: "since_updated_at" };

/** The account's subdomain from a setting written as a name, a host or a URL, or null. */
export function repairShoprSubdomain(raw: string): string | null {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.repairshopr\.com$/, "");
  return SUBDOMAIN.test(name) ? name : null;
}

export function repairShoprClient(options: RepairShoprClientOptions): RepairShoprClient {
  const token = options.apiToken?.trim() ?? "";
  if (!TOKEN.test(token)) throw new RepairShoprConfigError("REPAIRSHOPR_API_TOKEN is missing or not in the expected shape");
  const subdomain = repairShoprSubdomain(options.subdomain ?? "");
  if (!subdomain) throw new RepairShoprConfigError("REPAIRSHOPR_SUBDOMAIN must be the account's subdomain, like example in example.repairshopr.com");
  const baseUrl = `https://${subdomain}.repairshopr.com/api/v1`;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;

  return {
    baseUrl,
    async list(q) {
      if (!(REPAIRSHOPR_LISTS as readonly string[]).includes(q.list)) throw new RepairShoprApiError("the client reads only the lists the connector uses", 0);
      if (!Number.isSafeInteger(q.page) || q.page < 1) throw new RepairShoprApiError("page must be a whole number, 1 or more", 0);
      if (!TIME.test(q.since)) throw new RepairShoprApiError("a list must start from a UTC time", 0);
      const url = `${baseUrl}/${q.list}?${new URLSearchParams({ [SINCE[q.list]]: q.since, page: String(q.page) })}`;
      const init: RequestInit = { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } };
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        response = await doFetch(url, init);
        if (!RETRIED.has(response.status) || attempt >= retries) break;
        const after = Number(response.headers.get("retry-after"));
        // The limit is by the minute, so a 429 without Retry-After waits one out.
        await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : response.status === 429 ? 60_000 : 1000 * 2 ** attempt);
      }
      const { status } = response;
      if (status === 401 || status === 403) throw new RepairShoprConfigError(`RepairShopr turned down REPAIRSHOPR_API_TOKEN for ${q.list} (HTTP ${status}); check the token has the List/Search permission for it`);
      if (status !== 200) throw new RepairShoprApiError(`RepairShopr answered HTTP ${status} for ${q.list}`, status);
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const records = body?.[q.list] ?? body?.data;
      if (!Array.isArray(records)) throw new RepairShoprApiError(`RepairShopr answered without a list of ${q.list}`, status);
      const meta = (body!.meta ?? {}) as Record<string, unknown>;
      // With a page count, that says when to stop; without one, an empty page does.
      const more = Number.isSafeInteger(meta.total_pages) ? q.page < (meta.total_pages as number) : records.length > 0;
      return { records, more };
    },
  };
}
