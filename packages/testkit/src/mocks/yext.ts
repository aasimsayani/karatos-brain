import { createHash } from "node:crypto";
import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Yext's Management API (v2): the location list and the review list, built
 * from Yext's docs. Data is synthetic.
 *
 * - Every request carries the API key as an `api-key` header (or an
 *   `api_key` query parameter) and a `v` version date as YYYYMMDD.
 *   Answers are { meta: { uuid, errors }, response }.
 * - Entities: List: GET /accounts/{accountId}/entities with `entityTypes`,
 *   `fields`, `limit` (up to 50) and `pageToken`; answers response.entities,
 *   response.count and response.pageToken for the next page.
 * - Reviews: List: GET /accounts/{accountId}/reviews with `limit` (up to
 *   100), `pageToken` (not with `offset`) and the inclusive UTC days
 *   `minLastYextUpdateDate` and `maxLastYextUpdateDate`; answers
 *   response.reviews, response.count and response.nextPageToken.
 * - Over the quota, 429 with an empty response.
 */
const API = "https://api.yextapis.com/v2";
const POLICIES = "https://docs.yext.com/docs/managementapis/introduction/overview-policies-and-conventions";
const ENTITIES_DOC = "https://docs.yext.com/docs/managementapis/content/entities";
const REVIEWS_DOC = "https://docs.yext.com/docs/managementapis/reviews/reviewmanagement";
const SOURCE = { url: POLICIES, title: "Yext Management API: policies and conventions", retrievedOn: "2026-11-02", version: "v2" };
const DAY_MS = 86_400_000;

/** A location as Yext writes it. */
export type YextMockLocation = Record<string, unknown> & { meta: { id: string } };
/** A review as Yext writes it. */
export type YextMockReview = Record<string, unknown> & { id: number; lastYextUpdateTime: number };

/** Location n of the store, a test address in New York. */
export const yextLocation = fixtureBuilder<YextMockLocation>((n) => ({
  meta: { accountId: "test-account", id: `store-${n}`, uid: `uid${n}`, entityType: "location", countryCode: "US", timestamp: Date.parse("2026-01-01T00:00:00Z") + n * 60_000, labels: [] },
  name: `Test Jewelers ${n}`,
  address: { line1: `${100 + n} Test Street`, city: "New York", region: "NY", postalCode: "10001", countryCode: "US" },
  closed: false,
  timezone: "America/New_York",
  mainPhone: synthetic.phone(n),
  hours: { monday: { openIntervals: [{ start: "10:00", end: "18:00" }] } },
}));

/** Review n of location store-1, updated n hours after the start of 2026. */
export const yextReview = fixtureBuilder<YextMockReview>((n) => ({
  id: 9_000 + n,
  locationId: "store-1",
  accountId: "test-account",
  publisherId: n % 2 ? "GOOGLEMYBUSINESS" : "YELP",
  rating: 1 + (n % 5),
  title: `Test review ${n}`,
  content: `Test review ${n}: lovely ring. Call me at ${synthetic.phone(n)} or write ${synthetic.email(n)}.`,
  authorName: synthetic.name(n),
  authorEmail: synthetic.email(n),
  url: `https://reviews.example.test/review/${9_000 + n}?ref=yext`,
  publisherDate: Date.parse("2026-01-01T00:00:00Z") + n * 3_600_000,
  lastYextUpdateTime: Date.parse("2026-01-01T00:00:00Z") + n * 3_600_000,
  status: "LIVE",
  flagStatus: "NOT_FLAGGED",
  reviewLanguage: "en",
  comments: [],
}));

export interface YextMockData {
  apiKey: string;
  /** The account the key belongs to, reached as "me" too. */
  accountId: string;
  locations: YextMockLocation[];
  reviews: YextMockReview[];
  /** The endpoints the key's app may read. Defaults to both. */
  reads?: ("entities" | "reviews")[];
  /** Records per page the mock caps at, below the limit asked for, to exercise paging. */
  pageCap?: number;
  /** How many of the next calls answer 429. */
  rateLimited?: number;
}

export interface YextMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** The path and query of every read, in order. */
  readonly reads: { path: string; query: URLSearchParams }[];
}

const fail = (status: number, code: number, message: string): DocMockResponse => ({ status, body: { meta: { uuid: "test-uuid", errors: [{ code, type: "FATAL_ERROR", message }] }, response: {} } });
const ok = (response: unknown): DocMockResponse => ({ status: 200, body: { meta: { uuid: "test-uuid", errors: [] }, response } });
const tokenOf = (key: string, offset: number) => Buffer.from(`${createHash("sha256").update(key).digest("hex").slice(0, 8)}:${offset}`).toString("base64url");
const isDay = (d: string | null) => d !== null && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

export function yextDocMock(data: YextMockData): YextMock {
  const reads: { path: string; query: URLSearchParams }[] = [];

  /** Checks shared by every call: the key, the version, the account, the app's access and the quota. */
  function denied(request: { headers: Headers; url: URL }, account: string, list: "entities" | "reviews"): DocMockResponse | null {
    const key = request.headers.get("api-key") ?? request.url.searchParams.get("api_key");
    if (!key) return fail(400, 2001, "Missing API key.");
    if (key !== data.apiKey) return fail(401, 2002, "Invalid API key.");
    if (!/^\d{8}$/.test(request.url.searchParams.get("v") ?? "")) return fail(400, 2003, "Invalid or missing v parameter.");
    if (account !== "me" && account !== data.accountId) return fail(403, 2004, "Not authorized to access this account.");
    if (!(data.reads ?? ["entities", "reviews"]).includes(list)) return fail(403, 2005, "The app does not have permission for this endpoint.");
    if (data.rateLimited) {
      data.rateLimited--;
      return { status: 429, body: { meta: { uuid: "test-uuid", errors: [] }, response: {} }, headers: { "rate-limit-limit": "5000", "rate-limit-remaining": "0", "rate-limit-reset": "1800" } };
    }
    return null;
  }

  /** The offset a page token stands for in this list, or an error answer. */
  function offsetOf(q: URLSearchParams, key: string): number | DocMockResponse {
    const token = q.get("pageToken");
    if (token === null) return Number(q.get("offset") ?? 0);
    if (q.has("offset")) return fail(400, 2010, "offset cannot be used with pageToken.");
    const parts = Buffer.from(token, "base64url").toString().split(":");
    if (parts.length !== 2 || token !== tokenOf(key, Number(parts[1]))) return fail(400, 2011, "Invalid pageToken.");
    return Number(parts[1]);
  }

  const api = checkDocMock({
    integration: "yext",
    baseUrl: API,
    source: SOURCE,
    assumptions: [
      "A wrong API key answers 401 and a missing one 400, each with an error in meta.errors",
      "An app without access to an endpoint answers 403",
      "A page token is good only for the query it came from",
      "lastYextUpdateTime and publisherDate are epoch milliseconds",
      "A review's location is in locationId",
    ],
    routes: [
      {
        method: "GET",
        path: "/accounts/{accountId}/entities",
        documentedAt: ENTITIES_DOC,
        respond(request, params) {
          const no = denied(request, params.accountId!, "entities");
          if (no) return no;
          const q = request.url.searchParams;
          reads.push({ path: "/entities", query: q });
          const limit = Number(q.get("limit") ?? 10);
          if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail(400, 2020, "limit must be 1 to 50.");
          const key = [...q.entries()].filter(([k]) => k !== "pageToken").join("&");
          const offset = offsetOf(q, key);
          if (typeof offset !== "number") return offset;
          const types = (q.get("entityTypes") ?? "").split(",").filter(Boolean);
          const fields = (q.get("fields") ?? "").split(",").filter(Boolean);
          const all = data.locations.filter(() => !types.length || types.includes("location"));
          const take = Math.min(limit, data.pageCap ?? limit);
          const page = all.slice(offset, offset + take).map((e) => (fields.length ? Object.fromEntries(Object.entries(e).filter(([k]) => fields.includes(k))) : e));
          return ok({ count: all.length, entities: page, ...(offset + take < all.length ? { pageToken: tokenOf(key, offset + take) } : {}) });
        },
      },
      {
        method: "GET",
        path: "/accounts/{accountId}/reviews",
        documentedAt: REVIEWS_DOC,
        respond(request, params) {
          const no = denied(request, params.accountId!, "reviews");
          if (no) return no;
          const q = request.url.searchParams;
          reads.push({ path: "/reviews", query: q });
          const limit = Number(q.get("limit") ?? 10);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(400, 2030, "limit must be 1 to 100.");
          const min = q.get("minLastYextUpdateDate");
          const max = q.get("maxLastYextUpdateDate");
          if ((min !== null && !isDay(min)) || (max !== null && !isDay(max))) return fail(400, 2031, "Dates must be YYYY-MM-DD.");
          const key = [...q.entries()].filter(([k]) => k !== "pageToken").join("&");
          const offset = offsetOf(q, key);
          if (typeof offset !== "number") return offset;
          if (offset > 9900) return fail(400, 2032, "offset cannot be more than 9900.");
          const from = min ? Date.parse(`${min}T00:00:00Z`) : -Infinity;
          const until = max ? Date.parse(`${max}T00:00:00Z`) + DAY_MS : Infinity;
          const all = data.reviews.filter((r) => r.lastYextUpdateTime >= from && r.lastYextUpdateTime < until).sort((a, b) => b.lastYextUpdateTime - a.lastYextUpdateTime);
          const take = Math.min(limit, data.pageCap ?? limit);
          const page = all.slice(offset, offset + take);
          const rated = all.filter((r) => typeof r.rating === "number");
          return ok({ count: all.length, averageRating: rated.length ? rated.reduce((s, r) => s + (r.rating as number), 0) / rated.length : 0, reviews: page, ...(offset + take < all.length ? { nextPageToken: tokenOf(key, offset + take) } : {}) });
        },
      },
    ],
  });

  return { api, fetch: docMockFetch(api), reads };
}

export default {
  integration: "yext",
  covers: "Yext's Management API v2 location and review lists, enforcing the API key header, the version date, the account, the app's access, page sizes, update-date ranges and page tokens tied to their query",
  watchPages: [POLICIES, ENTITIES_DOC, REVIEWS_DOC],
  docMocks: () => [yextDocMock({ apiKey: "", accountId: "", locations: [], reviews: [] }).api],
} satisfies DocMockModule;
