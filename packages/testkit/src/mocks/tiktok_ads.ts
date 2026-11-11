import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * TikTok's API for Business (Marketing API v1.3) synchronous report, built
 * from its published reference and the official SDK's parameter list. Data
 * is synthetic: rows hold every metric the mock knows, and the report
 * answers with the ones asked for.
 *
 * Docs facts the mock relies on:
 * - Requests go to business-api.tiktok.com/open_api/v1.3 (or
 *   sandbox-ads.tiktok.com for a sandbox advertiser) with the advertiser's
 *   access token in the Access-Token header.
 * - GET /report/integrated/get/ takes advertiser_id, service_type,
 *   report_type, data_level, dimensions and metrics (JSON lists),
 *   start_date and end_date (YYYY-MM-DD, at most 30 days apart when the
 *   dimensions hold stat_time_day), query_lifetime, page and page_size (up
 *   to 1000).
 * - It answers HTTP 200 with code, message, request_id and data: list, one
 *   object per campaign and day with dimensions (stat_time_day written
 *   "YYYY-MM-DD 00:00:00") and metrics (numbers as strings), and
 *   page_info with page, page_size, total_number and total_page.
 * - A rate limit is code 40100, a token without a scope 40001, and an
 *   invalid token 40105, all with HTTP 200.
 */
const DOCS = {
  report: "https://business-api.tiktok.com/portal/docs?id=1740302848100353",
  auth: "https://business-api.tiktok.com/portal/docs?id=1738373164380162",
} as const;
export const TIKTOK_ADS_DOC_PAGES = DOCS;

/** A day of one campaign's report, with every metric the mock knows. */
export interface TikTokAdsMockRow {
  date: string;
  campaignId: string;
  metrics: Record<string, string>;
}

const CAMPAIGNS = [
  ["1780000000000000001", "Test bridal spark ads", "PRODUCT_SALES"],
  ["1780000000000000002", "Test holiday traffic", "TRAFFIC"],
] as const;

/** Day n after 2026-10-01, alternating two campaigns. */
export const tiktokAdsRow = fixtureBuilder<TikTokAdsMockRow>((n) => {
  const [campaignId, name, objective] = CAMPAIGNS[(n - 1) % CAMPAIGNS.length]!;
  return {
    date: new Date(Date.parse("2026-10-01T00:00:00Z") + Math.floor((n - 1) / CAMPAIGNS.length) * 86_400_000).toISOString().slice(0, 10),
    campaignId,
    metrics: {
      campaign_name: name,
      objective_type: objective,
      spend: `${9 * n}.25`,
      impressions: String(2000 * n),
      reach: String(1500 * n),
      clicks: String(30 * n),
      complete_payment: n % 2 ? "1" : "0",
      total_complete_payment_rate: n % 2 ? "1250.00" : "0.00",
      cpc: "0.31",
      ctr: "1.50",
    },
  };
});

export interface TikTokAdsMockData {
  /** The one advertiser the token can read, digits. */
  advertiserId: string;
  accessToken: string;
  rows?: TikTokAdsMockRow[];
  /** Rate limits to answer before the next reads. */
  rateLimits?: number;
  /** The token lacks the Reporting scope. */
  noReportingScope?: boolean;
}

const KNOWN_METRICS = new Set(["campaign_name", "objective_type", "spend", "impressions", "reach", "clicks", "complete_payment", "total_complete_payment_rate", "cpc", "ctr"]);
const DAY_MS = 86_400_000;
const ok = (data: unknown): DocMockResponse => ({ status: 200, body: { code: 0, message: "OK", request_id: "req-test", data } });
const fail = (code: number, message: string): DocMockResponse => ({ status: 200, body: { code, message, request_id: "req-test", data: {} } });
const list = (raw: string | undefined): unknown => {
  try {
    return JSON.parse(raw ?? "");
  } catch {
    return null;
  }
};
const dayMs = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Number.NaN);

export interface TikTokAdsMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each report read: its query. */
  readonly reads: Record<string, string>[];
}

export function tiktokAdsDocMock(data: TikTokAdsMockData): TikTokAdsMock {
  const reads: Record<string, string>[] = [];
  let limits = data.rateLimits ?? 0;
  const api = checkDocMock({
    integration: "tiktok_ads",
    baseUrl: "https://business-api.tiktok.com",
    source: { url: DOCS.report, title: "TikTok API for Business: Report Integrated Get", retrievedOn: "2026-11-11", version: "v1.3" },
    assumptions: [
      "Rows list in a stable order between two fixed days, so pages don't shift",
      "complete_payment counts purchases and total_complete_payment_rate is their value",
      "An invalid or revoked token is code 40105",
    ],
    routes: [
      {
        method: "GET",
        path: "/open_api/v1.3/report/integrated/get/",
        documentedAt: DOCS.report,
        respond(request) {
          if (request.headers.get("access-token") !== data.accessToken) return fail(40105, "The access token is invalid or has been revoked.");
          if (data.noReportingScope) return fail(40001, "No permission to operate.");
          if (limits > 0) {
            limits--;
            return fail(40100, "Requests made too frequently.");
          }
          const q = Object.fromEntries(request.url.searchParams);
          reads.push(q);
          if (q.advertiser_id !== data.advertiserId) return fail(40002, "Advertiser not authorized.");
          if (q.report_type !== "BASIC" || q.service_type !== "AUCTION" || q.data_level !== "AUCTION_CAMPAIGN") return fail(40002, "Invalid report settings.");
          if (JSON.stringify(list(q.dimensions)) !== JSON.stringify(["campaign_id", "stat_time_day"])) return fail(40002, "Invalid dimensions.");
          const metrics = list(q.metrics);
          if (!Array.isArray(metrics) || metrics.length === 0 || !metrics.every((m) => KNOWN_METRICS.has(m as string))) return fail(40002, "Invalid metrics.");
          const start = dayMs(q.start_date);
          const end = dayMs(q.end_date);
          if (Number.isNaN(start) || Number.isNaN(end) || end < start || (end - start) / DAY_MS + 1 > 30) return fail(40002, "Invalid date range.");
          const page = q.page === undefined ? 1 : Number(q.page);
          const size = q.page_size === undefined ? 10 : Number(q.page_size);
          if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 1000) return fail(40002, "Invalid paging.");
          const rows = (data.rows ?? []).filter((r) => dayMs(r.date) >= start && dayMs(r.date) <= end);
          const totalPage = Math.ceil(rows.length / size);
          return ok({
            list: rows.slice((page - 1) * size, page * size).map((r) => ({
              dimensions: { campaign_id: r.campaignId, stat_time_day: `${r.date} 00:00:00` },
              metrics: Object.fromEntries((metrics as string[]).map((m) => [m, r.metrics[m] ?? "0"])),
            })),
            page_info: { page, page_size: size, total_number: rows.length, total_page: totalPage },
          });
        },
      },
    ],
  });
  return { api, fetch: docMockFetch(api), reads };
}

export default {
  integration: "tiktok_ads",
  covers: "TikTok's API for Business synchronous report (Marketing API v1.3), enforcing the token, the advertiser, campaign level by day, the metrics, the 30-day range and paging",
  watchPages: [DOCS.report],
  docMocks: () => [tiktokAdsDocMock({ advertiserId: "1", accessToken: "" }).api],
} satisfies DocMockModule;
