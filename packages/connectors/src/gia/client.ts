/**
 * A small client for GIA's Report Results API, a GraphQL API. Requests are
 * POSTs to the address GIA gives at signup, with the API key itself in the
 * Authorization header. The client sends only the two read queries below,
 * with variables it checked itself: it can't send a mutation, so the
 * changed-reports queue GIA keeps for the key is read, never cleared.
 *
 * GIA answers a missing or revoked key with 403, too many requests with 429
 * and a Retry-After header, and report problems (not found, not available to
 * this key, at GIA for service, quota used up) as GraphQL errors with an
 * errorType and errorInfo on an HTTP 200. A 429 is retried with backoff
 * before the error goes to runSync.
 */

/** Only GIA's own hosts receive the key. */
const GIA_HOST = /(^|\.)gia\.edu$/;

/** Report numbers as GIA prints them: digits on stone reports, letters and digits on jewelry cards (AN384). */
export const GIA_REPORT_NUMBER = /^[A-Z0-9]{5,12}$/;
/** How many changed reports one page asks for. */
export const GIA_CHANGES_PAGE = 50;
const CURSOR = /^[A-Za-z0-9+/=_.:-]{1,1024}$/;
const MAX_RETRY_AFTER_S = 60;

const PROPORTIONS = "proportions { depth_pct table_pct crown_angle crown_height pavilion_angle pavilion_depth star_length lower_half girdle girdle_condition culet }";
const DIAMOND = `shape_and_cutting_style measurements carat_weight color_grade color_origin clarity_grade cut_grade polish symmetry fluorescence inscriptions report_comments ${PROPORTIONS}`;

/** The report fields the connector reads. Asset links are left out: they expire an hour after the call. */
export const GIA_REPORT_FIELDS = `fragment ReportFields on GradingReport {
  report_number report_date report_date_iso report_type report_type_code info_message is_digital
  results {
    __typename
    ... on DiamondGradingReportResults { ${DIAMOND} country_of_origin diamond_type }
    ... on LabGrownDiamondGradingReportResults { identification ${DIAMOND} }
  }
  assets { asset_type_code asset_type_description }
}`;

/** Every document the client may send. Nothing else is sent. */
export const GIA_QUERIES = {
  report: `query Report($reportNumber: String!) { getReport(report_number: $reportNumber) { ...ReportFields } }\n${GIA_REPORT_FIELDS}`,
  changes: `query Changes($limit: Int, $cursor: String) { getChangedReports(limit: $limit, cursor: $cursor) { results { report { ...ReportFields } } endCursor } }\n${GIA_REPORT_FIELDS}`,
} as const;

export type GiaReport = Record<string, unknown>;

/** What a lookup found. A report at GIA for service is looked up again on a later sync. */
export type GiaLookup =
  | { kind: "found"; report: GiaReport }
  | { kind: "unavailable"; reason: "not_found" | "not_permitted" }
  | { kind: "in_service" };

export interface GiaClientOptions {
  /** The API address GIA gave at signup. It must be https on a gia.edu host. */
  apiUrl: string;
  /** The API key. It is sent to GIA only and never logged or shown. */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class GiaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GiaConfigError";
  }
}

/** GIA answered with an error. `code` is its errorType, or AUTHORIZATION_DENIED for a 403. */
export class GiaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "GiaApiError";
  }
}

/** The plan's lookups are used up. Retrying won't help until more are bought. */
export class GiaQuotaError extends GiaApiError {
  constructor() {
    super("GIA lookup quota reached: buy more lookups or wait for the plan to renew", 200, "QUOTA REACHED");
    this.name = "GiaQuotaError";
  }
}

export interface GiaClient {
  report(reportNumber: string): Promise<GiaLookup>;
  changes(cursor: string | null): Promise<{ reports: GiaReport[]; endCursor: string | null }>;
}

/** Checks the API address: https, a gia.edu host, no credentials or port. */
export function giaApiUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GiaConfigError("GIA_API_URL is not a URL");
  }
  if (url.protocol !== "https:" || !GIA_HOST.test(url.hostname) || url.username || url.password || url.port || url.search || url.hash) {
    throw new GiaConfigError("GIA_API_URL must be an https address on a gia.edu host, with no credentials, port or query");
  }
  return url;
}

interface GraphQlError {
  message?: string;
  errorType?: string;
  errorInfo?: string;
}

const errorsOf = (body: Record<string, unknown>) => (Array.isArray(body.errors) ? (body.errors as GraphQlError[]) : []);
const asList = (value: unknown) => (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]);

export function giaClient(options: GiaClientOptions): GiaClient {
  const url = giaApiUrl(options.apiUrl);
  if (!/^\S{8,256}$/.test(options.apiKey)) throw new GiaConfigError("GIA_API_KEY is missing or not in the expected shape");
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.rateLimitRetries ?? 3;

  async function send(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: options.apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (response.status === 429 && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(1000 * (Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) : 2 ** attempt));
        continue;
      }
      if (response.status === 403) throw new GiaApiError("GIA denied the API key: it is missing, inactive or revoked", 403, "AUTHORIZATION_DENIED");
      if (response.status !== 200) throw new GiaApiError(`GIA answered HTTP ${response.status}`, response.status);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new GiaApiError("GIA answered with a body that isn't JSON", 200);
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new GiaApiError("GIA answered with an unexpected body", 200);
      const result = body as Record<string, unknown>;
      if (errorsOf(result).some((e) => e.errorType === "QUOTA REACHED")) throw new GiaQuotaError();
      return result;
    }
  }

  return {
    async report(reportNumber) {
      if (!GIA_REPORT_NUMBER.test(reportNumber)) throw new GiaConfigError(`not a GIA report number: ${JSON.stringify(reportNumber.slice(0, 20))}`);
      const body = await send(GIA_QUERIES.report, { reportNumber });
      const [error] = errorsOf(body);
      if (error) {
        if (error.errorInfo === "REPORT IN HOUSE") return { kind: "in_service" };
        if (error.errorInfo === "REPORT NOT FOUND") return { kind: "unavailable", reason: "not_found" };
        if (error.errorInfo === "FORBIDDEN") return { kind: "unavailable", reason: "not_permitted" };
        throw new GiaApiError(`GIA could not read report ${reportNumber}: ${error.errorType ?? "error"}`, 200, error.errorType);
      }
      const data = body.data as Record<string, unknown> | undefined;
      const [report] = asList(data?.getReport) as GiaReport[];
      if (!report) return { kind: "unavailable", reason: "not_found" };
      return { kind: "found", report };
    },

    async changes(cursor) {
      if (cursor !== null && !CURSOR.test(cursor)) throw new GiaConfigError("the changed-reports cursor is not in the expected shape");
      const body = await send(GIA_QUERIES.changes, { limit: GIA_CHANGES_PAGE, cursor });
      const [error] = errorsOf(body);
      if (error) throw new GiaApiError(`GIA could not list changed reports: ${error.errorType ?? "error"}`, 200, error.errorType);
      const pages = asList((body.data as Record<string, unknown> | undefined)?.getChangedReports) as { results?: unknown; endCursor?: unknown }[];
      const reports = pages.flatMap((p) => asList(p.results).map((r) => (r as { report?: GiaReport }).report)).filter((r): r is GiaReport => typeof r === "object" && r !== null);
      const last = pages[pages.length - 1]?.endCursor;
      return { reports, endCursor: typeof last === "string" && last !== "" ? last : null };
    },
  };
}
