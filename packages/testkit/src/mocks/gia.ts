import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * GIA's Report Results API, built from GIA's developer docs: getReport and
 * getChangedReports, the two reads a connector needs. Data is synthetic;
 * report numbers are taken from GIA's published sandbox list, so they name
 * test reports, never a real stone. GIA's free plan includes a sandbox key
 * that replaces this mock with the real sandbox once it is set up.
 *
 * Docs facts the mock relies on:
 * - Requests are POSTs of a GraphQL query to the address given at signup,
 *   with the API key itself in the Authorization header and Content-Type
 *   application/json (gialaboratory.github.io/report-results/quickstart, .../docs).
 * - getReport(report_number: String!) and getChangedReports(limit: Int,
 *   cursor: String) both answer lists: [GradingReport] and
 *   [ChangedReportResults]!, the latter with results ([ChangedReportResult]!,
 *   each a report) and endCursor (.../reference/query.doc.html,
 *   .../changedreportresults.doc.html, .../changedreportresult.doc.html).
 * - GradingReport has report_number, report_date, report_date_iso,
 *   report_type, report_type_code, results (a union told apart by
 *   __typename), links, quota, info_message, is_digital and assets of
 *   asset_type_code, asset_type_description and link (.../gradingreport.doc.html,
 *   .../reportasset.doc.html).
 * - DiamondGradingReportResults and LabGrownDiamondGradingReportResults carry
 *   shape_and_cutting_style, measurements, carat_weight, color_grade,
 *   clarity_grade, cut_grade, polish, symmetry, fluorescence, inscriptions,
 *   report_comments and proportions; natural reports add country_of_origin
 *   and diamond_type, lab-grown ones identification (.../diamondgradingreportresults.doc.html,
 *   .../labgrowndiamondgradingreportresults.doc.html, .../diamondproportions.doc.html).
 * - A missing or revoked key is 403 with {"message": "Authorization denied."};
 *   too many requests is 429 with Retry-After. Report problems are GraphQL
 *   errors on a 200: errorType REPORT UNAVAILABLE with errorInfo REPORT NOT
 *   FOUND or REPORT IN HOUSE, REPORT NOT FOUND with FORBIDDEN for a report a
 *   sandbox key can't see, and QUOTA REACHED with PLAN QUOTA MET (.../docs).
 * - Asset links last 60 minutes (.../docs).
 */
const DOCS = "https://gialaboratory.github.io/report-results";
const BASE = "https://api.reportresults.gia.edu";

export type GiaMockReport = Record<string, unknown>;

export interface GiaMockData {
  apiKey: string;
  /** Reports the key may read, by number. */
  reports: Record<string, GiaMockReport>;
  /** Report numbers that answer an error instead. */
  problems?: Record<string, "not_found" | "forbidden" | "in_house">;
  /** Pages the changed-reports feed answers in turn, by the cursor that asks for each: "" for the first. */
  changes?: Record<string, { reports: GiaMockReport[]; endCursor: string | null }>;
  /** Lookups left; at 0 every getReport answers QUOTA REACHED. Unlimited when absent. */
  quota?: number;
  /** The next this many requests answer 429. */
  throttle?: number;
}

/** GIA sandbox report numbers (gialaboratory.github.io/report-results/sandbox-reports). */
export const GIA_SANDBOX_NUMBERS = { naturalGrading: "2141438169", dossier: "2141438171", labGrown: "5202397873", pearl: "2141438189", jewelryCard: "AN384" } as const;

export const giaDiamondReport = fixtureBuilder<GiaMockReport>((n) => ({
  report_number: `214143816${n % 10}`,
  report_date: "March 13, 2025",
  report_date_iso: "2025-03-13",
  report_type: "Diamond Grading Report",
  report_type_code: "DER",
  info_message: null,
  is_digital: false,
  results: {
    __typename: "DiamondGradingReportResults",
    shape_and_cutting_style: "Round Brilliant",
    measurements: "6.42 - 6.45 x 3.98 mm",
    carat_weight: "1.01 carat",
    color_grade: "G",
    color_origin: null,
    clarity_grade: "VS1",
    cut_grade: "Excellent",
    polish: "Excellent",
    symmetry: "Very Good",
    fluorescence: "None",
    inscriptions: `GIA 214143816${n % 10}`,
    report_comments: "Synthetic test report.",
    country_of_origin: null,
    diamond_type: null,
    proportions: { depth_pct: "61.8", table_pct: "57", crown_angle: "34.5", crown_height: "15.0", pavilion_angle: "40.8", pavilion_depth: "43.0", star_length: "50", lower_half: "75", girdle: "Medium to Slightly Thick", girdle_condition: "Faceted", culet: "None" },
  },
  assets: [
    { asset_type_code: "PDF", asset_type_description: "Report PDF", link: `https://example.test/gia/${n}.pdf` },
    { asset_type_code: "PROPORTIONS_DIAGRAM", asset_type_description: "Proportions Diagram", link: `https://example.test/gia/${n}-proportions.png` },
  ],
}));

const gqlError = (errorType: string, errorInfo: string, message: string): DocMockResponse => ({ status: 200, body: { data: null, errors: [{ path: ["getReport"], errorType, errorInfo, message }] } });

export interface GiaMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Every operation answered, in order: getReport:<number> or getChangedReports:<cursor>. */
  readonly operations: string[];
}

export function giaDocMock(data: GiaMockData): GiaMock {
  const operations: string[] = [];
  let quota = data.quota ?? Number.POSITIVE_INFINITY;
  let throttle = data.throttle ?? 0;

  const api = checkDocMock({
    integration: "gia",
    baseUrl: BASE,
    source: { url: `${DOCS}/docs`, title: "GIA Report Results API documentation", retrievedOn: "2026-10-24", version: "changelog of 2026-08-11" },
    assumptions: [
      "The address GIA gives at signup is https://api.reportresults.gia.edu, answering at /",
      "getChangedReports with the last endCursor answers only reports changed since; endCursor is null when the feed holds nothing newer",
      "Report problems come back with errorType and errorInfo on each GraphQL error, as AppSync formats them",
      "report_date_iso is a YYYY-MM-DD date",
    ],
    routes: [
      {
        method: "POST",
        path: "/",
        documentedAt: `${DOCS}/quickstart`,
        respond(request) {
          if (throttle > 0) {
            throttle--;
            return { status: 429, body: { message: "Too Many Requests" }, headers: { "retry-after": "2" } };
          }
          if (request.headers.get("authorization") !== data.apiKey) return { status: 403, body: { message: "Authorization denied." } };
          if (!/^application\/json/.test(request.headers.get("content-type") ?? "")) return { status: 400, body: { errorType: "MalformedHttpRequestException", message: "Invalid JSON payload in POST request." } };
          let body: { query?: unknown; variables?: Record<string, unknown> };
          try {
            body = JSON.parse(request.body) as typeof body;
          } catch {
            return { status: 400, body: { errorType: "MalformedHttpRequestException", message: "Invalid JSON payload in POST request." } };
          }
          const query = typeof body.query === "string" ? body.query : "";
          if (/^\s*mutation\b/.test(query)) throw new Error("the GIA mock received a mutation; the connector only reads");
          if (/getReport\s*\(/.test(query)) {
            const number = String(body.variables?.reportNumber ?? "");
            operations.push(`getReport:${number}`);
            if (quota <= 0) return gqlError("QUOTA REACHED", "PLAN QUOTA MET", "QuotaUsageLimit");
            const problem = data.problems?.[number];
            if (problem === "in_house") return gqlError("REPORT UNAVAILABLE", "REPORT IN HOUSE", "The item with this report number is undergoing service by GIA.");
            if (problem === "forbidden") return gqlError("REPORT NOT FOUND", "FORBIDDEN", "This API key does not have permission to access this report.");
            const report = data.reports[number];
            if (problem === "not_found" || !report) return gqlError("REPORT UNAVAILABLE", "REPORT NOT FOUND", "This report does not exist or is not available through Report Check.");
            quota--;
            return { status: 200, body: { data: { getReport: [{ ...report, quota: { remaining: Number.isFinite(quota) ? quota : 1000 } }] } } };
          }
          if (/getChangedReports\s*\(/.test(query)) {
            const cursor = typeof body.variables?.cursor === "string" ? body.variables.cursor : "";
            operations.push(`getChangedReports:${cursor}`);
            const page = data.changes?.[cursor] ?? { reports: [], endCursor: null };
            return { status: 200, body: { data: { getChangedReports: [{ results: page.reports.map((report) => ({ report })), endCursor: page.endCursor }] } } };
          }
          throw new Error("the GIA mock doesn't model this query");
        },
      },
    ],
  });

  return {
    api,
    fetch: docMockFetch(api),
    get operations() {
      return operations;
    },
  };
}

export default {
  integration: "gia",
  covers: "GIA's Report Results API: getReport and getChangedReports",
  watchPages: [`${DOCS}/docs`, `${DOCS}/quickstart`],
  docMocks: () => [giaDocMock({ apiKey: "", reports: {} }).api],
} satisfies DocMockModule;
