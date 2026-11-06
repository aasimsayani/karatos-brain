/**
 * A small client for Airtable's Web API (v0): the token's own scopes, the
 * bases it can see, each base's tables and fields, and a table's records.
 * It only ever sends these four GETs, to Airtable's fixed address, with
 * parameters it builds itself, and follows pages by their offset.
 *
 * Every records request names the fields it wants by id. Airtable returns
 * every field when none are named, so a request with no fields is never
 * sent, and any field that comes back without being asked for is dropped.
 */

export const AIRTABLE_API = "https://api.airtable.com/v0";
/** Airtable's largest page of records. */
export const AIRTABLE_PAGE_SIZE = 100;
/** Airtable asks a client that went over the rate limit to wait 30 seconds. */
export const AIRTABLE_RATE_LIMIT_WAIT_MS = 30_000;
/** The most fields one records request names, so the address stays well under Airtable's 16,000 characters. */
export const AIRTABLE_MAX_FIELDS = 200;

/** Airtable's ids: three letters for the kind, then 14 letters and digits. */
export const AIRTABLE_ID = {
  base: /^app[A-Za-z0-9]{14}$/,
  table: /^tbl[A-Za-z0-9]{14}$/,
  field: /^fld[A-Za-z0-9]{14}$/,
  record: /^rec[A-Za-z0-9]{14}$/,
  user: /^usr[A-Za-z0-9]{14}$/,
} as const;
const OFFSET = /^[A-Za-z0-9/]{1,256}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A scope that lets a token change something in Airtable. */
export const AIRTABLE_WRITE_SCOPE = /:(write|manage)$/;

export interface AirtableClientOptions {
  /** A personal access token or an OAuth access token. Sent to Airtable only, and never logged or shown. */
  token: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class AirtableConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirtableConfigError";
  }
}

export class AirtableApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AirtableApiError";
  }
}

/** A saved records offset Airtable no longer accepts; the table is read again from its start. */
export class AirtableOffsetExpiredError extends AirtableApiError {
  constructor() {
    super("Airtable no longer accepts the saved page offset for a table's records", 422);
    this.name = "AirtableOffsetExpiredError";
  }
}

export interface AirtablePage {
  data: Record<string, unknown>[];
  /** The offset for the next page, or null on the last page. */
  next: string | null;
}

export interface AirtableClient {
  /** The scopes an OAuth token was granted. A personal access token's scopes aren't reported, so this is null for one. */
  scopes(): Promise<string[] | null>;
  /** One page of the bases the token can see. */
  bases(offset?: string | null): Promise<AirtablePage>;
  /** A base's tables, each with its fields. */
  tables(base: string): Promise<Record<string, unknown>[]>;
  /** One page of a table's records, with only the named fields, those changed after `changedAfter` when given. */
  records(base: string, table: string, fields: readonly string[], changedAfter: string | null, offset?: string | null): Promise<AirtablePage>;
}

const id = (kind: keyof typeof AIRTABLE_ID, value: string) => {
  if (!AIRTABLE_ID[kind].test(value)) throw new AirtableApiError(`${kind} id is not an Airtable id`, 0);
  return value;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The error type Airtable names in a reply, such as LIST_RECORDS_ITERATOR_NOT_AVAILABLE. */
function errorType(body: unknown): string | undefined {
  const error = isObject(body) ? body.error : undefined;
  if (typeof error === "string") return error;
  return isObject(error) && typeof error.type === "string" ? error.type : undefined;
}

/** The filter that keeps records made or changed after a time. The time is checked first, so nothing else gets into the formula. */
export function airtableChangedAfter(time: string): string {
  if (!ISO.test(time) || Number.isNaN(Date.parse(time)) || new Date(time).toISOString() !== time) throw new AirtableApiError("the changed-after time must be a UTC time", 0);
  return `OR(IS_AFTER(LAST_MODIFIED_TIME(),'${time}'),IS_AFTER(CREATED_TIME(),'${time}'))`;
}

export function airtableClient(options: AirtableClientOptions): AirtableClient {
  if (!/^[A-Za-z0-9._-]{20,4096}$/.test(options.token)) throw new AirtableConfigError("AIRTABLE_ACCESS_TOKEN is missing or not in the expected shape");
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.rateLimitRetries ?? 3;
  const headers = { Authorization: `Bearer ${options.token}`, Accept: "application/json" };

  async function get(path: string, query: [string, string][], what: string, offsetSent: boolean): Promise<Record<string, unknown>> {
    const url = new URL(`${AIRTABLE_API}${path}`);
    for (const [k, v] of query) url.searchParams.append(k, v);
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { method: "GET", headers });
      if (response.status === 429 && attempt < retries) {
        await sleep(AIRTABLE_RATE_LIMIT_WAIT_MS);
        continue;
      }
      const body: unknown = await response.json().catch(() => undefined);
      if (response.status === 401) throw new AirtableApiError("Airtable turned down the token: check AIRTABLE_ACCESS_TOKEN, which may have been revoked or expired", 401);
      if (response.status === 403) throw new AirtableApiError(`Airtable's token isn't allowed to read ${what}: it needs the data.records:read and schema.bases:read scopes and access to the base`, 403);
      if (response.status === 404) throw new AirtableApiError(`Airtable couldn't find ${what}`, 404);
      if (response.status === 422 && offsetSent && errorType(body) === "LIST_RECORDS_ITERATOR_NOT_AVAILABLE") throw new AirtableOffsetExpiredError();
      if (response.status !== 200) throw new AirtableApiError(`Airtable answered HTTP ${response.status} for ${what}`, response.status);
      if (!isObject(body)) throw new AirtableApiError(`Airtable answered ${what} with a body that isn't a JSON object`, 200);
      return body;
    }
  }

  function page(body: Record<string, unknown>, key: string, what: string): AirtablePage {
    if (!Array.isArray(body[key])) throw new AirtableApiError(`Airtable answered ${what} without the ${key} list`, 200);
    const next = body.offset;
    if (next != null && (typeof next !== "string" || !OFFSET.test(next))) throw new AirtableApiError(`Airtable sent a page offset for ${what} that isn't in the expected shape`, 200);
    return { data: (body[key] as unknown[]).map((r) => (isObject(r) ? r : {})), next: (next as string | null | undefined) ?? null };
  }

  const checkOffset = (offset: string | null | undefined, what: string) => {
    if (offset != null && !OFFSET.test(offset)) throw new AirtableApiError(`the page offset for ${what} isn't in the expected shape`, 0);
  };

  return {
    async scopes() {
      const body = await get("/meta/whoami", [], "the token's user", false);
      if (body.scopes === undefined) return null;
      if (!Array.isArray(body.scopes) || !body.scopes.every((s) => typeof s === "string")) throw new AirtableApiError("Airtable answered the token's user with scopes that aren't a list of names", 200);
      return body.scopes as string[];
    },
    async bases(offset) {
      checkOffset(offset, "bases");
      return page(await get("/meta/bases", offset ? [["offset", offset]] : [], "bases", false), "bases", "bases");
    },
    async tables(base) {
      const body = await get(`/meta/bases/${id("base", base)}/tables`, [], "a base's tables", false);
      return page(body, "tables", "a base's tables").data;
    },
    async records(base, table, fields, changedAfter, offset) {
      id("base", base);
      id("table", table);
      checkOffset(offset, "a table's records");
      if (fields.length === 0) throw new AirtableApiError("a records request must name its fields, or Airtable returns every field", 0);
      if (fields.length > AIRTABLE_MAX_FIELDS) throw new AirtableApiError(`a records request names at most ${AIRTABLE_MAX_FIELDS} fields`, 0);
      for (const f of fields) id("field", f);
      const query: [string, string][] = [
        ["pageSize", String(AIRTABLE_PAGE_SIZE)],
        ["returnFieldsByFieldId", "true"],
        ...fields.map((f): [string, string] => ["fields[]", f]),
        ...(changedAfter !== null ? [["filterByFormula", airtableChangedAfter(changedAfter)] as [string, string]] : []),
        ...(offset ? [["offset", offset] as [string, string]] : []),
      ];
      const result = page(await get(`/${base}/${table}`, query, "a table's records", Boolean(offset)), "records", "a table's records");
      // Keep only the fields asked for, whatever came back.
      const asked = new Set(fields);
      const data = result.data.map((r) => {
        const kept = isObject(r.fields) ? Object.fromEntries(Object.entries(r.fields).filter(([k]) => asked.has(k))) : {};
        return { id: r.id, createdTime: r.createdTime, fields: kept };
      });
      return { data, next: result.next };
    },
  };
}
