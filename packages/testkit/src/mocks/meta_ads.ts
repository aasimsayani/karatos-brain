import { createHash } from "node:crypto";
import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Meta's Marketing API (Graph API v26.0) ad account insights and the
 * token's permissions, built from Meta's developer docs. Data is synthetic:
 * rows hold every field the mock knows, and insights answers with the ones
 * asked for.
 *
 * - Insights: GET /v26.0/act_{id}/insights with level, fields, time_range
 *   ({"since","until"}), time_increment and limit; answers `data`, one
 *   object per campaign and day with date_start and date_stop, and `paging`
 *   with cursors, plus `next` while rows remain. Counts are strings; actions
 *   and action_values are lists of { action_type, value }. Needs ads_read.
 *   https://developers.facebook.com/docs/marketing-api/insights
 * - Permissions: GET /v26.0/me/permissions answers each permission the token
 *   was granted or declined.
 *   https://developers.facebook.com/docs/graph-api/reference/user/permissions/
 */
const GRAPH = "https://graph.facebook.com/v26.0";

/** A day of one campaign's insights, with every field the mock knows. */
export interface MetaAdsMockRow {
  date: string;
  campaignId: string;
  campaignName: string;
  objective: string;
  spend: string;
  impressions: string;
  reach: string;
  clicks: string;
  purchases: string;
  purchaseValue: string;
}

const CAMPAIGNS = [
  ["120200000000000001", "Test bridal reels", "OUTCOME_SALES"],
  ["120200000000000002", "Test anniversary retargeting", "OUTCOME_SALES"],
] as const;

/** Day n after 2026-10-01, alternating two campaigns. */
export const metaAdsRow = fixtureBuilder<MetaAdsMockRow>((n) => {
  const [campaignId, campaignName, objective] = CAMPAIGNS[(n - 1) % CAMPAIGNS.length]!;
  return {
    date: new Date(Date.parse("2026-10-01T00:00:00Z") + Math.floor((n - 1) / CAMPAIGNS.length) * 86_400_000).toISOString().slice(0, 10),
    campaignId,
    campaignName,
    objective,
    spend: `${12 * n}.34`,
    impressions: String(1000 * n),
    reach: String(800 * n),
    clicks: String(20 * n),
    purchases: n % 2 ? "1" : "0",
    purchaseValue: n % 2 ? "1890.50" : "0",
  };
});

export interface MetaAdsMockData {
  /** The one ad account the token can read, digits. */
  accountId: string;
  accessToken: string;
  rows: MetaAdsMockRow[];
  /** Permissions the token was granted. Defaults to ads_read and public_profile. */
  permissions?: string[];
  currency?: string;
  /** Rows per page the mock caps at, below the limit asked for, to exercise paging. */
  pageCap?: number;
  /** How many of the next insights calls answer with Graph error 17 (user request limit). */
  rateLimited?: number;
}

export interface MetaAdsMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** The query of every insights call, in order. */
  readonly reads: URLSearchParams[];
  /** How many times the permissions were read. */
  readonly permissionReads: number;
}

const FIELDS: Record<string, (r: MetaAdsMockRow, d: MetaAdsMockData) => unknown> = {
  campaign_id: (r) => r.campaignId,
  campaign_name: (r) => r.campaignName,
  objective: (r) => r.objective,
  account_currency: (_, d) => d.currency ?? "USD",
  spend: (r) => r.spend,
  impressions: (r) => r.impressions,
  reach: (r) => r.reach,
  clicks: (r) => r.clicks,
  // Meta lists only the actions that happened.
  actions: (r) => (r.purchases === "0" ? undefined : [{ action_type: "link_click", value: r.clicks }, { action_type: "purchase", value: r.purchases }]),
  action_values: (r) => (r.purchases === "0" ? undefined : [{ action_type: "purchase", value: r.purchaseValue }]),
  date_start: (r) => r.date,
  date_stop: (r) => r.date,
};

const graphError = (status: number, code: number, message: string, type = "OAuthException"): DocMockResponse => ({ status, body: { error: { message, type, code, fbtrace_id: "ATestTrace" } } });
const cursorOf = (key: string, offset: number) => Buffer.from(`${createHash("sha256").update(key).digest("hex").slice(0, 8)}:${offset}`).toString("base64url");

export function metaAdsDocMock(data: MetaAdsMockData): MetaAdsMock {
  const reads: URLSearchParams[] = [];
  let permissionReads = 0;
  const authed = (headers: Headers) => headers.get("authorization") === `Bearer ${data.accessToken}`;
  const permissions = () => data.permissions ?? ["ads_read", "public_profile"];

  const api = checkDocMock({
    integration: "meta_ads",
    baseUrl: GRAPH,
    source: { url: "https://developers.facebook.com/docs/marketing-api/insights", title: "Insights API", retrievedOn: "2026-10-30", version: "v26.0" },
    auth: "bearer",
    assumptions: [
      "The access token can go in an Authorization: Bearer header",
      "spend and action values are decimal strings in the ad account's currency",
      "A last page carries cursors but no next link",
      "An after cursor is good only for the read it came from",
      "Throttling answers HTTP 400 with Graph error code 17, 80000 or 80004",
    ],
    routes: [
      {
        method: "GET",
        path: "/me/permissions",
        documentedAt: "https://developers.facebook.com/docs/graph-api/reference/user/permissions/",
        respond(request) {
          permissionReads++;
          if (!authed(request.headers)) return graphError(400, 190, "Invalid OAuth access token.");
          return { status: 200, body: { data: [...permissions().map((permission) => ({ permission, status: "granted" })), { permission: "email", status: "declined" }] } };
        },
      },
      {
        method: "GET",
        path: "/{account}/insights",
        documentedAt: "https://developers.facebook.com/docs/marketing-api/insights",
        respond(request, params) {
          if (!authed(request.headers)) return graphError(400, 190, "Invalid OAuth access token.");
          if (!permissions().includes("ads_read") && !permissions().includes("ads_management")) return graphError(403, 200, "Requires ads_read permission.", "OAuthException");
          if (params.account !== `act_${data.accountId}`) return graphError(400, 100, "Unsupported get request. Object does not exist or cannot be loaded due to missing permissions.", "GraphMethodException");
          if (data.rateLimited) {
            data.rateLimited--;
            return graphError(400, 17, "User request limit reached");
          }
          const q = new URL(request.url).searchParams;
          reads.push(q);
          const fields = (q.get("fields") ?? "").split(",").filter(Boolean);
          if (q.get("level") !== "campaign" || q.get("time_increment") !== "1" || !fields.length || !fields.every((f) => Object.hasOwn(FIELDS, f))) {
            return graphError(400, 100, "Invalid parameter", "OAuthException");
          }
          let range: { since?: unknown; until?: unknown } = {};
          try {
            range = JSON.parse(q.get("time_range") ?? "{}") as typeof range;
          } catch {
            return graphError(400, 100, "Invalid parameter: time_range");
          }
          const since = typeof range.since === "string" ? range.since : "";
          const until = typeof range.until === "string" ? range.until : "";
          if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until) || until < since) return graphError(400, 100, "Invalid parameter: time_range");
          const limit = Number(q.get("limit") ?? 25);
          const key = [...q.entries()].filter(([k]) => k !== "after").join("&");
          let offset = 0;
          const after = q.get("after");
          if (after !== null) {
            const parts = Buffer.from(after, "base64url").toString().split(":");
            if (parts.length !== 2 || after !== cursorOf(key, Number(parts[1]))) return graphError(400, 100, "Invalid cursor");
            offset = Number(parts[1]);
          }
          const rows = data.rows.filter((r) => r.date >= since && r.date <= until).sort((a, b) => (a.date === b.date ? (a.campaignId < b.campaignId ? -1 : 1) : a.date < b.date ? -1 : 1));
          const size = Math.min(limit, data.pageCap ?? limit);
          const page = rows.slice(offset, offset + size);
          const out = page.map((r) => Object.fromEntries(fields.map((f) => [f, FIELDS[f]!(r, data)]).filter(([, v]) => v !== undefined)));
          const more = offset + size < rows.length;
          return {
            status: 200,
            body: {
              data: out,
              ...(page.length
                ? {
                    paging: {
                      cursors: { before: cursorOf(key, offset), after: cursorOf(key, offset + size) },
                      ...(more ? { next: `${GRAPH}/${params.account}/insights?${q}&after=${cursorOf(key, offset + size)}` } : {}),
                    },
                  }
                : {}),
            },
          };
        },
      },
    ],
  });

  return {
    api,
    fetch: docMockFetch(api),
    reads,
    get permissionReads() {
      return permissionReads;
    },
  };
}

export default {
  integration: "meta_ads",
  covers: "Meta's Marketing API ad account insights and `/me/permissions` (Graph API v26.0), enforcing the token, ads_read, the ad account, campaign level by day, the fields and cursors tied to their read",
  watchPages: ["https://developers.facebook.com/docs/marketing-api/insights", "https://developers.facebook.com/docs/graph-api/reference/user/permissions/"],
  docMocks: () => [metaAdsDocMock({ accountId: "1", accessToken: "", rows: [] }).api],
} satisfies DocMockModule;
