import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Trustpilot's public Business Units API (v1), built from Trustpilot's
 * developer docs. Data is synthetic. API access needs Trustpilot's API
 * module, so a client's business unit replaces this mock on the first live
 * run.
 *
 * Docs facts the mock relies on:
 * - Public endpoints take the application's API key in an `apikey` header
 *   (business-units-api-overview).
 * - GET /v1/business-units/{businessUnitId} answers the business unit with
 *   score {trustScore, stars} and numberOfReviews {total,
 *   usedForTrustScoreCalculation, oneStar ... fiveStars}
 *   (business-units-api-public).
 * - GET /v1/business-units/{businessUnitId}/reviews takes stars, language,
 *   page, perPage, orderBy (createdat.asc, createdat.desc, stars.asc,
 *   stars.desc), responded and includeReportedReviews, and answers
 *   {links, reviews}; a page past the last is an empty list
 *   (business-units-api).
 * - Times are ISO 8601 in UTC (schema-data-cache).
 */
const DOCS = "https://developers.trustpilot.com";
export const TRUSTPILOT_DOC_PAGES = {
  reviews: `${DOCS}/business-units-api`,
  unit: "https://documentation-apidocumentation.trustpilot.com/business-units-api-(public)/",
  key: `${DOCS}/business-units-api-overview`,
  times: `${DOCS}/schema-data-cache/`,
} as const;

export type TrustpilotMockRecord = Record<string, unknown>;

/** The test store's business unit id. */
export const TRUSTPILOT_TEST_UNIT = "5f0c0ffee0a0b0c0d0e0f0a1";
/** A Trustpilot-shaped id: 24 hexadecimal characters ending in `n` in hex, padded with e so it has no long run of digits. */
export const trustpilotId = (prefix: string, n: number) => (prefix + n.toString(16).padStart(24 - prefix.length, "e")).slice(0, 24);

/** A five-star review with the store's reply, posted `n` hours into 2026. */
export const trustpilotReview = fixtureBuilder<TrustpilotMockRecord>((n) => ({
  id: trustpilotId("6a", n),
  stars: 5,
  title: "Lovely ring",
  text: "The setting is perfect and it arrived early.",
  language: "en",
  status: "active",
  isVerified: true,
  numberOfLikes: 0,
  reviewVerificationLevel: "verified",
  createdAt: synthetic.isoTime(n * 60),
  updatedAt: null,
  experiencedAt: synthetic.isoTime(n * 60 - 1440),
  countsTowardsTrustScore: true,
  countsTowardsLocationTrustScore: null,
  links: [],
  companyReply: { text: "Thank you!", createdAt: synthetic.isoTime(n * 60 + 30), updatedAt: null },
  consumer: { id: trustpilotId("c0", n), displayName: synthetic.name(n), displayLocation: "Test City", numberOfReviews: 3, links: [] },
  businessUnit: { id: TRUSTPILOT_TEST_UNIT, identifyingName: "store.example.test", displayName: "Test Store", links: [] },
  location: null,
  reportData: null,
  complianceLabels: [],
  invitation: { businessUnitId: TRUSTPILOT_TEST_UNIT },
  businessUnitHistory: [],
}));

/** The test store's business unit with a 4.6 trust score. */
export const trustpilotUnit = (over: TrustpilotMockRecord = {}): TrustpilotMockRecord => ({
  id: TRUSTPILOT_TEST_UNIT,
  displayName: "Test Store",
  name: { identifying: "store.example.test", referring: ["store.example.test"] },
  websiteUrl: "https://store.example.test",
  country: "US",
  status: "active",
  badFit: false,
  links: [],
  score: { trustScore: 4.6, stars: 4.5 },
  numberOfReviews: { total: 120, usedForTrustScoreCalculation: 110, oneStar: 4, twoStars: 2, threeStars: 6, fourStars: 20, fiveStars: 88 },
  ...over,
});

export interface TrustpilotMockData {
  apiKey: string;
  unit?: TrustpilotMockRecord;
  reviews: TrustpilotMockRecord[];
  /** 429s to answer before the next reads. */
  rateLimits?: number;
}

const REVIEW_PARAMS = ["stars", "language", "page", "perPage", "orderBy", "responded", "includeReportedReviews"];
const ORDERS = ["createdat.asc", "createdat.desc", "stars.asc", "stars.desc"];

export interface TrustpilotMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each read: its path and query. */
  readonly reads: { path: string; query: Record<string, string> }[];
}

export function trustpilotDocMock(data: TrustpilotMockData): TrustpilotMock {
  const reads: { path: string; query: Record<string, string> }[] = [];
  let limits = data.rateLimits ?? 0;
  const unit = data.unit ?? trustpilotUnit();
  const gate = (request: { url: URL; headers: Headers }): DocMockResponse | null => {
    if (request.headers.get("apikey") !== data.apiKey) return { status: 401, body: { message: "Unauthorized" } };
    if (limits > 0) {
      limits--;
      return { status: 429, body: { message: "Too many requests" }, headers: { "retry-after": "1" } };
    }
    reads.push({ path: request.url.pathname, query: Object.fromEntries(request.url.searchParams) });
    return null;
  };
  const api = checkDocMock({
    integration: "trustpilot",
    baseUrl: "https://api.trustpilot.com/v1",
    source: { url: TRUSTPILOT_DOC_PAGES.reviews, title: "Trustpilot Business Units API: the business unit and its reviews", retrievedOn: "2026-11-11", version: "v1" },
    assumptions: [
      "perPage goes up to 100",
      "A review's createdAt doesn't change when it is edited, and companyReply is null until the store replies",
      "The API key is 20 to 64 letters and digits",
    ],
    routes: [
      {
        method: "GET",
        path: "/business-units/{unit}",
        documentedAt: TRUSTPILOT_DOC_PAGES.unit,
        respond(request, params): DocMockResponse {
          const refused = gate(request);
          if (refused) return refused;
          if (params.unit !== unit.id) return { status: 404, body: { message: "Not found" } };
          return { status: 200, body: unit };
        },
      },
      {
        method: "GET",
        path: "/business-units/{unit}/reviews",
        documentedAt: TRUSTPILOT_DOC_PAGES.reviews,
        respond(request, params): DocMockResponse {
          const refused = gate(request);
          if (refused) return refused;
          if (params.unit !== unit.id) return { status: 404, body: { message: "Not found" } };
          const q = Object.fromEntries(request.url.searchParams);
          for (const name of Object.keys(q)) if (!REVIEW_PARAMS.includes(name)) return { status: 400, body: { message: `Unknown parameter ${name}` } };
          const size = q.perPage === undefined ? 20 : Number(q.perPage);
          const page = q.page === undefined ? 1 : Number(q.page);
          if (!Number.isInteger(size) || size < 1 || size > 100 || !Number.isInteger(page) || page < 1) return { status: 400, body: { message: "Invalid paging" } };
          if (q.orderBy !== undefined && !ORDERS.includes(q.orderBy)) return { status: 400, body: { message: "Invalid orderBy" } };
          const newest = q.orderBy !== "createdat.asc";
          const rows = [...data.reviews].sort((a, b) => (newest ? -1 : 1) * String(a.createdAt).localeCompare(String(b.createdAt)));
          return { status: 200, body: { links: [], reviews: rows.slice((page - 1) * size, page * size) } };
        },
      },
    ],
  });
  return {
    api,
    fetch: docMockFetch(api),
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "trustpilot",
  covers: "Trustpilot's public business unit and service reviews (v1)",
  watchPages: [TRUSTPILOT_DOC_PAGES.reviews, TRUSTPILOT_DOC_PAGES.unit],
  docMocks: () => [trustpilotDocMock({ apiKey: "", reviews: [] }).api],
} satisfies DocMockModule;
