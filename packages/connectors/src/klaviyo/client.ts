/**
 * A small client for Klaviyo's JSON:API (https://a.klaviyo.com/api/...).
 * Read-only by allowlist:
 *
 * - GETs go to a fixed list of read endpoints only, each with its own query
 *   parameters, and every filter, sort, page size and cursor value is checked
 *   before a request is made.
 * - Its only POSTs are the two reporting endpoints, campaign values and flow
 *   values. Klaviyo serves those reports as POSTs because the query is a
 *   JSON body, but they only read aggregates. They are allowed by exact path,
 *   and the body is rebuilt and checked field by field: the report type, a
 *   fixed list of statistics, a timeframe of at most a year, a metric id and
 *   the group-by fields. Any other body is stopped.
 *
 * Klaviyo documents no way to read the scopes a private key holds, and keys
 * made before scopes existed have full access. So, unlike Square or
 * HubSpot, the key can't be checked; the allowlist is the guard. The owner
 * makes a key with read-only scopes, and nothing the connector sends could
 * change anything even with a full-access key.
 *
 * Every request carries the `revision` header pinned to the revision the
 * connector was built against. Klaviyo rate-limits per endpoint (a burst
 * per second and a steady rate per minute; the reports allow 2 a minute and
 * 225 a day) and answers 429 with Retry-After in seconds. The client waits
 * that long, up to a minute, then hands the error to runSync, which retries
 * from the checkpoint.
 */

export const KLAVIYO_API_URL = "https://a.klaviyo.com";
/** The API revision the connector was built and tested against, sent as `revision` on every request. */
export const KLAVIYO_REVISION = "2026-10-15";

/** The read-only scopes the private key should hold. Klaviyo can't be asked which a key holds, so this is guidance for the owner. */
export const KLAVIYO_READ_SCOPES = ["profiles:read", "lists:read", "segments:read", "campaigns:read", "flows:read", "metrics:read"] as const;

/** The only GET endpoints the client reads, with the parameters each may carry. `{id}` is a list or segment id. */
export const KLAVIYO_ROUTES = {
  profiles: { path: "/api/profiles/", params: ["fields[profile]", "additional-fields[profile]", "filter", "sort", "page[size]", "page[cursor]"] },
  lists: { path: "/api/lists/", params: ["fields[list]", "sort", "page[cursor]"] },
  listProfiles: { path: "/api/lists/{id}/relationships/profiles/", params: ["filter", "page[size]", "page[cursor]"] },
  segments: { path: "/api/segments/", params: ["fields[segment]", "sort", "page[cursor]"] },
  segmentProfiles: { path: "/api/segments/{id}/relationships/profiles/", params: ["filter", "page[size]", "page[cursor]"] },
  campaigns: { path: "/api/campaigns/", params: ["fields[campaign]", "filter", "sort", "page[size]", "page[cursor]"] },
  flows: { path: "/api/flows/", params: ["fields[flow]", "filter", "sort", "page[size]", "page[cursor]"] },
  metrics: { path: "/api/metrics/", params: ["fields[metric]", "page[cursor]"] },
} as const satisfies Record<string, { path: string; params: readonly string[] }>;
export type KlaviyoRoute = keyof typeof KLAVIYO_ROUTES;

/** Statistics the connector asks the reports for: counts and revenue only. Rates can be worked out from them. */
export const KLAVIYO_REPORT_STATISTICS = [
  "recipients",
  "delivered",
  "bounced",
  "opens",
  "opens_unique",
  "clicks",
  "clicks_unique",
  "conversions",
  "conversion_uniques",
  "conversion_value",
  "unsubscribes",
] as const;
export type KlaviyoStatistic = (typeof KLAVIYO_REPORT_STATISTICS)[number];

/** The two read-only POSTs: Klaviyo's campaign and flow values reports. */
export const KLAVIYO_REPORTS = {
  campaignValues: {
    path: "/api/campaign-values-reports/",
    type: "campaign-values-report",
    groupBy: ["campaign_id", "campaign_message_id", "campaign_message_name", "send_channel"],
  },
  flowValues: {
    path: "/api/flow-values-reports/",
    type: "flow-values-report",
    groupBy: ["flow_id", "flow_message_id", "send_channel"],
  },
} as const;
export type KlaviyoReport = keyof typeof KLAVIYO_REPORTS;

export interface KlaviyoClientOptions {
  /** A private API key (pk_...) holding read-only scopes. */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** 0 to 1, for backoff jitter when Klaviyo sends no Retry-After; replaced in tests. */
  random?: () => number;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class KlaviyoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KlaviyoConfigError";
  }
}

/** Klaviyo answered with an error. `code` is Klaviyo's error code (throttled, not_authenticated, ...) when it gives one. */
export class KlaviyoApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "KlaviyoApiError";
    this.status = status;
    this.code = code;
  }
}

/** One JSON:API resource as Klaviyo returns it. */
export interface KlaviyoResource {
  type?: unknown;
  id?: unknown;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
}

export interface KlaviyoPage {
  data: KlaviyoResource[];
  /** The next page's cursor, checked against the request it continues; null on the last page. */
  next: string | null;
}

export interface KlaviyoReportQuery {
  /** ISO times; at most a year apart, as Klaviyo allows. */
  start: string;
  end: string;
  conversionMetricId: string;
}

export interface KlaviyoReportRow {
  groupings: Record<string, unknown>;
  statistics: Record<string, unknown>;
}

export interface KlaviyoClient {
  /** One page of an allowlisted GET endpoint. */
  read(route: KlaviyoRoute, params?: Record<string, string | number | undefined>, id?: string): Promise<KlaviyoPage>;
  /** One campaign or flow values report. */
  report(kind: KlaviyoReport, query: KlaviyoReportQuery): Promise<KlaviyoReportRow[]>;
}

/** Klaviyo private keys: pk_ and a run of letters and digits. A six-character public site key is not one. */
const PRIVATE_KEY = /^pk_[A-Za-z0-9]{16,128}$/;
/** List, segment, campaign, flow and metric ids: letters and digits. */
export const KLAVIYO_ID = /^[A-Za-z0-9]{1,64}$/;
/** An opaque page cursor, as it comes back in links.next. Capped before matching. */
const CURSOR = /^[A-Za-z0-9+/=_.:~-]{1,1024}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
/** The only filters the client sends: one greater-than on a time field. */
const FILTER = /^greater-than\((updated|updated_at|joined_group_at),(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z)\)$/;
const FILTER_FIELDS: Partial<Record<KlaviyoRoute, string>> = {
  profiles: "updated",
  listProfiles: "joined_group_at",
  segmentProfiles: "joined_group_at",
  campaigns: "updated_at",
  flows: "updated",
};
const SORTS: Partial<Record<KlaviyoRoute, readonly string[]>> = {
  profiles: ["updated"],
  lists: ["id"],
  segments: ["id"],
  campaigns: ["updated_at"],
  flows: ["updated"],
};
/** Each endpoint's largest page, from the docs. */
export const KLAVIYO_PAGE_SIZES: Partial<Record<KlaviyoRoute, number>> = { profiles: 100, listProfiles: 100, segmentProfiles: 100, campaigns: 100, flows: 50 };
/** Sparse fieldsets the client may ask for: nothing personal beyond the email and phone number it hashes. */
const FIELDS: Record<string, string> = {
  "fields[profile]": "email,phone_number,created,updated,subscriptions",
  "additional-fields[profile]": "subscriptions",
  "fields[list]": "name,opt_in_process,created,updated",
  "fields[segment]": "name,is_active,created,updated",
  "fields[campaign]": "definition.name,definition.archived,created_at,updated_at",
  "fields[flow]": "name,status,archived,trigger_type,created,updated",
  "fields[metric]": "name,integration,created,updated",
};

const MAX_RETRY_AFTER_S = 60;
const BACKOFF_MS = 1000;
const YEAR_MS = 366 * 86_400_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clean = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : undefined);

/** Klaviyo's first error, cut short. Klaviyo's errors describe the request, never the key. */
function errorOf(body: unknown): { message: string; code: string | undefined } {
  const first = (body as { errors?: { code?: unknown; title?: unknown; detail?: unknown }[] } | null)?.errors?.[0];
  const code = clean(first?.code, 40);
  const detail = clean(first?.detail, 200) ?? clean(first?.title, 200);
  return { message: [code, detail].filter(Boolean).join(": "), code };
}

/** Checks one parameter value for a route, so nothing but what the connector means to send leaves the server. */
function checkParam(route: KlaviyoRoute, key: string, value: string): void {
  if (key === "page[cursor]") {
    if (value.length > 1024 || !CURSOR.test(value)) throw new KlaviyoConfigError("the page cursor is not one Klaviyo gave");
  } else if (key === "page[size]") {
    const max = KLAVIYO_PAGE_SIZES[route] ?? 0;
    if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > max) throw new KlaviyoConfigError(`page[size] for ${route} must be 1 to ${max}`);
  } else if (key === "filter") {
    const m = value.length <= 80 ? FILTER.exec(value) : null;
    if (!m || m[1] !== FILTER_FIELDS[route] || Number.isNaN(Date.parse(m[2]!))) throw new KlaviyoConfigError(`the Klaviyo connector only filters ${route} by a time`);
  } else if (key === "sort") {
    if (!(SORTS[route] ?? []).includes(value)) throw new KlaviyoConfigError(`the Klaviyo connector doesn't sort ${route} that way`);
  } else if (FIELDS[key] !== value) {
    throw new KlaviyoConfigError(`the Klaviyo connector only asks for its listed ${key}`);
  }
}

/**
 * The report body the client sends, built from checked values only. Exported
 * so tests can show any other body is stopped.
 */
export function klaviyoReportBody(kind: KlaviyoReport, query: KlaviyoReportQuery): Record<string, unknown> {
  const spec = Object.hasOwn(KLAVIYO_REPORTS, kind) ? KLAVIYO_REPORTS[kind] : undefined;
  if (!spec) throw new KlaviyoConfigError("the Klaviyo connector only reads campaign and flow values reports");
  if (!ISO.test(query.start) || !ISO.test(query.end)) throw new KlaviyoConfigError("a report timeframe needs ISO start and end times");
  const start = Date.parse(query.start);
  const end = Date.parse(query.end);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start || end - start > YEAR_MS) throw new KlaviyoConfigError("a report timeframe must run forwards and span a year at most");
  if (!KLAVIYO_ID.test(query.conversionMetricId)) throw new KlaviyoConfigError("the conversion metric id must be a Klaviyo metric id");
  return {
    data: {
      type: spec.type,
      attributes: {
        statistics: [...KLAVIYO_REPORT_STATISTICS],
        timeframe: { start: query.start, end: query.end },
        conversion_metric_id: query.conversionMetricId,
        group_by: [...spec.groupBy],
      },
    },
  };
}

/** True only for a body the client itself would build for that report: every key, type and value is checked. */
export function isKlaviyoReportBody(kind: KlaviyoReport, body: unknown): boolean {
  const data = (body as { data?: unknown } | null)?.data as { type?: unknown; attributes?: Record<string, unknown> } | undefined;
  const a = data?.attributes;
  if (!body || typeof body !== "object" || Object.keys(body).length !== 1 || !data || !a || Object.keys(data).length !== 2) return false;
  const timeframe = a.timeframe as { start?: unknown; end?: unknown } | undefined;
  if (typeof timeframe?.start !== "string" || typeof timeframe.end !== "string" || typeof a.conversion_metric_id !== "string") return false;
  try {
    const expected = klaviyoReportBody(kind, { start: timeframe.start, end: timeframe.end, conversionMetricId: a.conversion_metric_id });
    return JSON.stringify(expected) === JSON.stringify(body);
  } catch {
    return false;
  }
}

const ROUTE_SEGMENTS = Object.values(KLAVIYO_ROUTES).map((r) => r.path.split("/"));
const REPORT_PATHS = new Map<string, KlaviyoReport>(Object.entries(KLAVIYO_REPORTS).map(([k, v]) => [v.path, k as KlaviyoReport]));

/**
 * The allowlist every request passes before it is sent: a GET with no body
 * to a listed route (with a Klaviyo id where the route takes one), or a POST
 * to one of the two reports with a body the client itself would build.
 * Anything else, any other host, method or path, is stopped.
 */
export function isKlaviyoReadRequest(method: string, url: URL, body: unknown): boolean {
  if (url.origin !== KLAVIYO_API_URL) return false;
  if (method === "GET") {
    if (body !== undefined) return false;
    const got = url.pathname.split("/");
    return ROUTE_SEGMENTS.some((want) => want.length === got.length && want.every((w, i) => (w === "{id}" ? KLAVIYO_ID.test(got[i]!) : w === got[i])));
  }
  const report = method === "POST" && url.search === "" ? REPORT_PATHS.get(url.pathname) : undefined;
  return report !== undefined && isKlaviyoReportBody(report, body);
}

export function klaviyoClient(options: KlaviyoClientOptions): KlaviyoClient {
  const apiKey = options.apiKey?.trim() ?? "";
  if (!apiKey) throw new KlaviyoConfigError("set KLAVIYO_PRIVATE_API_KEY");
  if (!PRIVATE_KEY.test(apiKey)) throw new KlaviyoConfigError("KLAVIYO_PRIVATE_API_KEY must be a private API key (pk_...), not a public site key");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const retries = options.rateLimitRetries ?? 3;
  async function send(method: "GET" | "POST", url: URL, body?: unknown): Promise<unknown> {
    if (!isKlaviyoReadRequest(method, url, body)) throw new KlaviyoConfigError("the Klaviyo connector only sends its listed reads");
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { authorization: `Klaviyo-API-Key ${apiKey}`, revision: KLAVIYO_REVISION, accept: "application/vnd.api+json" };
      if (method === "POST") headers["content-type"] = "application/vnd.api+json";
      const response = await doFetch(url.toString(), { method, headers, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
      if (response.status === 429) {
        const after = Number(response.headers.get("retry-after"));
        // A wait longer than a minute (the reports' daily cap) is left to the next run.
        if (attempt >= retries || after > MAX_RETRY_AFTER_S) {
          throw new KlaviyoApiError("Klaviyo kept rate-limiting the sync; the next run resumes from the checkpoint", 429, "throttled");
        }
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : BACKOFF_MS * 2 ** attempt + Math.floor(random() * BACKOFF_MS));
        continue;
      }
      const parsed: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const { message, code } = errorOf(parsed);
        const hint = response.status === 403 ? `; give the private key read access to ${KLAVIYO_READ_SCOPES.join(", ")}` : response.status === 401 ? "; check KLAVIYO_PRIVATE_API_KEY" : "";
        throw new KlaviyoApiError(`Klaviyo answered HTTP ${response.status}${message ? ` (${message})` : ""}${hint}`, response.status, code);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new KlaviyoApiError("Klaviyo did not answer with a JSON object", response.status);
      return parsed;
    }
  }

  /**
   * The cursor from links.next, once the link is shown to continue this very
   * request: same host, same path, the same parameters, and a cursor shaped
   * like one. A link that isn't stops the sync rather than being followed or
   * quietly ending it.
   */
  function nextCursor(links: unknown, sent: URL): string | null {
    const next = (links as { next?: unknown } | null)?.next;
    if (next === null || next === undefined) return null;
    if (typeof next !== "string" || next.length > 4096) throw new KlaviyoApiError("Klaviyo's next page link is not a link", 200);
    let url: URL;
    try {
      url = new URL(next);
    } catch {
      throw new KlaviyoApiError("Klaviyo's next page link is not a link", 200);
    }
    const trim = (p: string) => p.replace(/\/+$/, "");
    if (url.origin !== sent.origin || trim(url.pathname) !== trim(sent.pathname)) throw new KlaviyoApiError("Klaviyo's next page link points somewhere else", 200);
    const cursor = url.searchParams.get("page[cursor]");
    if (!cursor || cursor.length > 1024 || !CURSOR.test(cursor)) throw new KlaviyoApiError("Klaviyo's next page link has no usable cursor", 200);
    const rest = (u: URL) =>
      [...u.searchParams.entries()]
        .filter(([k]) => k !== "page[cursor]")
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join("&");
    if (rest(url) !== rest(sent)) throw new KlaviyoApiError("Klaviyo's next page link changes the query", 200);
    return cursor;
  }

  return {
    async read(route, params = {}, id) {
      const spec = Object.hasOwn(KLAVIYO_ROUTES, route) ? KLAVIYO_ROUTES[route] : undefined;
      if (!spec) throw new KlaviyoConfigError("the Klaviyo connector only reads its listed endpoints");
      const templated = spec.path.includes("{id}");
      if (templated !== (id !== undefined) || (id !== undefined && !KLAVIYO_ID.test(id))) throw new KlaviyoConfigError(`${route} needs a Klaviyo id`);
      const allowedParams: readonly string[] = spec.params;
      const url = new URL(`${KLAVIYO_API_URL}${spec.path.replace("{id}", id ?? "")}`);
      for (const [key, raw] of Object.entries(params)) {
        if (raw === undefined) continue;
        if (!allowedParams.includes(key)) throw new KlaviyoConfigError(`the Klaviyo connector doesn't send ${key.slice(0, 40)} to ${spec.path}`);
        const value = String(raw);
        checkParam(route, key, value);
        url.searchParams.set(key, value);
      }
      const body = (await send("GET", url)) as { data?: unknown; links?: unknown };
      if (!Array.isArray(body.data)) throw new KlaviyoApiError("Klaviyo did not answer with a list of resources", 200);
      return { data: body.data.filter((r): r is KlaviyoResource => !!r && typeof r === "object"), next: nextCursor(body.links, url) };
    },
    async report(kind, query) {
      const body = klaviyoReportBody(kind, query);
      const spec = KLAVIYO_REPORTS[kind];
      const answer = (await send("POST", new URL(`${KLAVIYO_API_URL}${spec.path}`), body)) as { data?: { attributes?: { results?: unknown } } };
      const results = answer.data?.attributes?.results;
      if (!Array.isArray(results)) throw new KlaviyoApiError("Klaviyo did not answer with report results", 200);
      return results.filter((r): r is KlaviyoReportRow => !!r && typeof r === "object" && typeof r.groupings === "object" && !!r.groupings && typeof r.statistics === "object" && !!r.statistics);
    },
  };
}
