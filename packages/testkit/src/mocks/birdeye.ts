import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Birdeye's Get Reviews, built from Birdeye's API docs (read as Markdown
 * from docs.birdeye.com). Data is synthetic. Birdeye has no sandbox, so a
 * client's key replaces this mock on the first live run.
 *
 * Docs facts the mock relies on:
 * - POST https://api.birdeye.com/resources/v1/review/businessId/{businessId}
 *   takes sindex and count in the query and a JSON body with, among
 *   others, fromDate, updateFromDate (MM/dd/yyyy) and statuses (published,
 *   parked or all; published when left out), and answers a list of reviews
 *   (get-reviews).
 * - The key goes in the x-api-key header (authentication).
 * - sindex plus count may not pass 100,000 (pagination).
 * - Errors are {code, message}: 1161 for a bad key, 1011 for an unknown
 *   business, 1186 and 1227 for a bad date, 89 for the rate limit (get-reviews).
 * - reviewDate and responseDate read like "Jan 20, 2014" (get-reviews).
 */
const DOCS = "https://docs.birdeye.com/api";
export const BIRDEYE_DOC_PAGES = {
  reviews: `${DOCS}/reviews/get-reviews.md`,
  pagination: `${DOCS}/pagination.md`,
} as const;

export const BIRDEYE_TEST_BUSINESS = "100000001";

export type BirdeyeMockReview = Record<string, unknown>;

export interface BirdeyeMockData {
  apiKey: string;
  businessId?: string;
  reviews: BirdeyeMockReview[];
  /** 429s to answer before the next reads. */
  rateLimits?: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A day as Birdeye's examples write it, such as "Jan 20, 2014". */
export const birdeyeMockDate = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

export const birdeyeReview = fixtureBuilder<BirdeyeMockReview>((n) => ({
  reviewId: 500_000 + n,
  rating: (n % 5) + 1,
  title: null,
  comments: `Lovely engagement ring, test review ${n}. Call me on 212 555 0100 or write to ${synthetic.email(n)}.`,
  reviewer: { firstName: "Test", lastName: `Customer ${n}`, nickName: `tester${n}`, thumbnailUrl: "https://example.com/avatar.png" },
  sourceType: n % 2 ? "Google" : "Facebook",
  reviewURL: `https://example.com/reviews/${n}?ref=test`,
  reviewDate: birdeyeMockDate(synthetic.isoTime(n * 1440)),
  response: n % 2 ? "Thank you, Test Customer!" : null,
  responseDate: n % 2 ? birdeyeMockDate(synthetic.isoTime(n * 1440 + 1440)) : null,
  customerId: 900_000 + n,
  extraParams: { anniversary: "2020-06-01" },
  assitedByUser: [{ firstName: "Test", lastName: "Staff", emailId: "staff@example.test", phoneNum: "+1 212 555 0101" }],
  reviewOperationalStatus: "CREATED",
}));

const error = (status: number, code: number, message: string): DocMockResponse => ({ status, body: { code, message } });
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const dayMs = (day: string) => {
  const m = DAY.exec(day)!;
  return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
};
const reviewMs = (r: BirdeyeMockReview) => Date.parse(`${r.reviewDate} UTC`);

export interface BirdeyeMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each read: its offset, count and body. */
  readonly reads: { sindex: number; count: number; body: Record<string, unknown> }[];
}

export function birdeyeDocMock(data: BirdeyeMockData): BirdeyeMock {
  const business = data.businessId ?? BIRDEYE_TEST_BUSINESS;
  const reads: { sindex: number; count: number; body: Record<string, unknown> }[] = [];
  let limits = data.rateLimits ?? 0;
  const api = checkDocMock({
    integration: "birdeye",
    baseUrl: "https://api.birdeye.com/resources/v1",
    source: { url: BIRDEYE_DOC_PAGES.pagination, title: "Birdeye API pagination and Get Reviews", retrievedOn: "2026-11-10", version: "v1" },
    assumptions: [
      "Reviews come oldest first, and a page shorter than count is the last",
      "updateFromDate matches every review changed on or after that day, including new ones",
      "A 429 carries no Retry-After header",
    ],
    routes: [
      {
        method: "POST",
        path: "/review/businessId/{businessId}",
        documentedAt: BIRDEYE_DOC_PAGES.reviews,
        respond(request, params) {
          const key = request.headers.get("x-api-key");
          if (!key) return error(400, 1167, "API key is missing");
          if (key !== data.apiKey) return error(401, 1161, "Invalid API key");
          if (params.businessId !== business) return error(404, 1011, "Business id is invalid");
          if (limits > 0) {
            limits--;
            return error(429, 89, "Rate limit exceeded");
          }
          const sindex = Number(request.url.searchParams.get("sindex"));
          const count = Number(request.url.searchParams.get("count"));
          if (!Number.isInteger(sindex) || sindex < 0) return error(400, 1163, "Invalid start index value");
          if (!Number.isInteger(count) || count < 1) return error(401, 1164, "Invalid result count value");
          if (sindex + count > 100_000) return error(400, 1163, "Invalid start index value");
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(request.body || "{}") as Record<string, unknown>;
          } catch {
            return error(400, 1000, "Invalid body");
          }
          for (const [field, code] of [["fromDate", 1186], ["updateFromDate", 1227]] as const) {
            if (body[field] !== undefined && !DAY.test(String(body[field]))) return error(400, code, `Invalid ${field}. Allowed format is "MM/dd/yyyy".`);
          }
          reads.push({ sindex, count, body });
          let rows = [...data.reviews];
          // The mock has no edit times, so a review counts as changed on the day it was posted.
          const from = (body.fromDate ?? body.updateFromDate) as string | undefined;
          if (from) rows = rows.filter((r) => reviewMs(r) >= dayMs(from));
          const statuses = Array.isArray(body.statuses) ? body.statuses : ["published"];
          if (!statuses.includes("all")) rows = rows.filter((r) => statuses.includes(r.parked ? "parked" : "published"));
          rows.sort((a, b) => reviewMs(a) - reviewMs(b) || Number(a.reviewId) - Number(b.reviewId));
          return { status: 200, body: rows.slice(sindex, sindex + count) };
        },
      },
    ],
  });
  const fetch = docMockFetch(api);
  return {
    api,
    fetch,
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "birdeye",
  covers: "Birdeye's Get Reviews",
  watchPages: [BIRDEYE_DOC_PAGES.pagination, BIRDEYE_DOC_PAGES.reviews],
  docMocks: () => [birdeyeDocMock({ apiKey: "", reviews: [] }).api],
} satisfies DocMockModule;
