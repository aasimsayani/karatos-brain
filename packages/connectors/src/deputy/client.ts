/**
 * A small client for Deputy's Resource API, read-only. Deputy signs a
 * request in with a bearer token: a permanent token made on a Client ID
 * page in the business's Deputy install. A token acts as the person who
 * made it, with their access level; Deputy has no read-only level or token
 * scope, so the client keeps to the reads: it sends only the Resource API's
 * search (`POST /api/v1/resource/<Object>/QUERY`, which Deputy uses for
 * reads too) for the six records the connector uses, to the one install
 * the settings name.
 *
 * Deputy's own error text is never put in an error here, only the HTTP
 * status. A 429 and 500, 502, 503 and 504 are waited out a few times,
 * honoring Retry-After, before the error goes to runSync, which keeps the
 * checkpoint.
 */

/** The records the connector reads, in the order a pass reads them. */
export const DEPUTY_OBJECTS = ["Company", "OperationalUnit", "Employee", "Roster", "Timesheet", "Leave"] as const;
export type DeputyObject = (typeof DEPUTY_OBJECTS)[number];
/** The most records Deputy returns on a page. */
export const DEPUTY_PAGE_SIZE = 500;
const MAX_RETRY_AFTER_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
/** An install's host, such as example.na.deputy.com. */
const INSTALL = /^[a-z0-9][a-z0-9-]{0,62}\.(au|eu|na|uk)\.deputy\.com$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{16,512}$/;
/** A search clause's value: a whole number, or a day or time as the client sends it. */
const VALUE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}\+00:00)?$/;

export interface DeputyClientOptions {
  /** A Deputy permanent token. Sent to Deputy only, and never logged or shown. */
  accessToken: string;
  /** The install's host, as the browser shows it: example.na.deputy.com. */
  install: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class DeputyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeputyConfigError";
  }
}

export class DeputyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DeputyApiError";
  }
}

/** Which records a page lists: all of them, or those whose field is at or after a day or time. */
export interface DeputyQuery {
  object: DeputyObject;
  /** The field and value records must be at or after; none lists them all. */
  since?: { field: "Modified" | "Date" | "DateEnd"; value: string } | undefined;
  /** How many records, in Id order, come before the page. */
  start: number;
}

export interface DeputyPage {
  records: unknown[];
  /** A later page may hold more. */
  more: boolean;
}

export interface DeputyClient {
  readonly baseUrl: string;
  query(q: DeputyQuery): Promise<DeputyPage>;
}

/** The install's host from a setting written as a host or a URL, or null. */
export function deputyInstall(raw: string): string | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/$/, "");
  return INSTALL.test(host) ? host : null;
}

export function deputyClient(options: DeputyClientOptions): DeputyClient {
  const token = options.accessToken?.trim() ?? "";
  if (!TOKEN.test(token)) throw new DeputyConfigError("DEPUTY_ACCESS_TOKEN is missing or not in the expected shape");
  const install = deputyInstall(options.install ?? "");
  if (!install) throw new DeputyConfigError("DEPUTY_INSTALL must be the install's host, like example.na.deputy.com");
  const baseUrl = `https://${install}`;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;

  return {
    baseUrl,
    async query(q) {
      if (!(DEPUTY_OBJECTS as readonly string[]).includes(q.object)) throw new DeputyApiError("the client reads only the records the connector uses", 0);
      if (!Number.isSafeInteger(q.start) || q.start < 0) throw new DeputyApiError("start must be a whole number, 0 or more", 0);
      if (q.since && !VALUE.test(q.since.value)) throw new DeputyApiError("a search must start from a day or a UTC time", 0);
      const body: Record<string, unknown> = { sort: { Id: "asc" }, start: q.start, max: DEPUTY_PAGE_SIZE };
      if (q.since) body.search = { s1: { field: q.since.field, data: q.since.value, type: "ge" } };
      const url = `${baseUrl}/api/v1/resource/${q.object}/QUERY`;
      const init: RequestInit = { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) };
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        response = await doFetch(url, init);
        if (!RETRIED.has(response.status) || attempt >= retries) break;
        const after = Number(response.headers.get("retry-after"));
        await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : 1000 * 2 ** attempt);
      }
      const { status } = response;
      if (status === 401 || status === 403) throw new DeputyConfigError(`Deputy turned down DEPUTY_ACCESS_TOKEN for ${q.object} (HTTP ${status})`);
      if (status !== 200) throw new DeputyApiError(`Deputy answered HTTP ${status} for ${q.object}`, status);
      const records = await response.json().catch(() => undefined);
      if (!Array.isArray(records)) throw new DeputyApiError(`Deputy answered without a list of ${q.object} records`, status);
      return { records, more: records.length >= DEPUTY_PAGE_SIZE };
    },
  };
}
