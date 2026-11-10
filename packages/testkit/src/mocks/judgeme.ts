import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Judge.me's review list (REST API v1), built from Judge.me's help center
 * articles on its API and OAuth. Data is synthetic. Judge.me has no
 * sandbox, so a client's shop replaces this mock on the first live run.
 *
 * Docs facts the mock relies on:
 * - GET https://api.judge.me/api/v1/reviews takes shop_domain and
 *   api_token in the query, and per_page (at most 100), page, product_id,
 *   rating, published, reviewer_id and reviewer_email; it answers
 *   {current_page, per_page, reviews} (judge-me-api).
 * - The private token reads and writes; an OAuth token can be limited to
 *   read_reviews, and is sent as api_token too (setting-up-oauth).
 * - A missing or wrong token or shop is a 401.
 */
const DOCS = {
  api: "https://judge.me/help/en/articles/8409180-judge-me-api",
  oauth: "https://judge.me/help/en/articles/8283047-setting-up-oauth",
} as const;
export const JUDGEME_DOC_PAGES = DOCS;

export type JudgemeMockRecord = Record<string, unknown>;

export interface JudgemeMockData {
  shopDomain: string;
  apiToken: string;
  reviews: JudgemeMockRecord[];
  /** 429s to answer before the next reads. */
  rateLimits?: number;
}

/** A five-star product review, `n` hours into 2026. */
export const judgemeReview = fixtureBuilder<JudgemeMockRecord>((n) => ({
  id: 300_000 + n,
  title: "Beautiful ring",
  body: "The setting is perfect and it arrived early.",
  rating: 5,
  product_external_id: 8_000_000_000 + n,
  reviewer: { id: 900_000 + n, external_id: String(7_000_000 + n), email: synthetic.email(n), name: synthetic.name(n), phone: `+121255502${String(n % 100).padStart(2, "0")}`, accepts_marketing: true, unsubscribed_at: null, tags: "vip" },
  source: "web",
  curated: "ok",
  published: true,
  hidden: false,
  verified: "buyer",
  featured: false,
  created_at: synthetic.isoTime(n * 60),
  updated_at: synthetic.isoTime(n * 60),
  has_published_pictures: false,
  has_published_videos: false,
  pictures: [],
  ip_address: "192.0.2.1",
}));

const PARAMS = ["shop_domain", "api_token", "per_page", "page", "product_id", "rating", "published", "reviewer_id", "reviewer_email"];

export interface JudgemeMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each read's query, the token left out. */
  readonly reads: Record<string, string>[];
}

export function judgemeDocMock(data: JudgemeMockData): JudgemeMock {
  const reads: Record<string, string>[] = [];
  let limits = data.rateLimits ?? 0;
  const api = checkDocMock({
    integration: "judgeme",
    baseUrl: "https://api.judge.me/api/v1",
    source: { url: DOCS.api, title: "Judge.me API: tokens, the review list and OAuth", retrievedOn: "2026-11-10", version: "REST v1" },
    assumptions: [
      "Reviews come back newest first, and a page past the last is an empty list",
      "Hidden and unpublished reviews are listed when published isn't given",
      "Times carry their offset",
    ],
    routes: [
      {
        method: "GET",
        path: "/reviews",
        documentedAt: DOCS.api,
        respond(request): DocMockResponse {
          const q = Object.fromEntries(request.url.searchParams);
          if (q.shop_domain !== data.shopDomain || q.api_token !== data.apiToken) return { status: 401, body: { error: "Invalid shop_domain or api_token" } };
          if (limits > 0) {
            limits--;
            return { status: 429, body: { error: "Too many requests" }, headers: { "retry-after": "1" } };
          }
          for (const name of Object.keys(q)) if (!PARAMS.includes(name)) return { status: 400, body: { error: `Unknown parameter ${name}` } };
          const size = q.per_page === undefined ? 10 : Number(q.per_page);
          const page = q.page === undefined ? 1 : Number(q.page);
          if (!Number.isInteger(size) || size < 1 || size > 100 || !Number.isInteger(page) || page < 1) return { status: 422, body: { error: "Invalid paging" } };
          const { api_token: _, ...shown } = q;
          reads.push(shown);
          const rows = [...data.reviews].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id));
          return { status: 200, body: { current_page: page, per_page: size, reviews: rows.slice((page - 1) * size, page * size) } };
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
  integration: "judgeme",
  covers: "Judge.me's review list (REST v1)",
  watchPages: [DOCS.api],
  docMocks: () => [judgemeDocMock({ shopDomain: "", apiToken: "", reviews: [] }).api],
} satisfies DocMockModule;
