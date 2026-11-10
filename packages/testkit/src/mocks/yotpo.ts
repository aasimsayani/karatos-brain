import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Yotpo's access token request, Retrieve all reviews (Reviews API v1) and
 * Fetch all recently updated customers (Loyalty API v2), built from
 * docs.yotpo.com. Data is synthetic. Yotpo has no sandbox ("every call
 * affects a real Loyalty program"), so a client's store replaces this mock
 * on the first live run.
 *
 * Docs facts the mock relies on:
 * - POST https://api.yotpo.com/core/v3/stores/{store_id}/access_tokens
 *   with {secret} answers {access_token}; reads send it as X-Yotpo-Token,
 *   and a lapsed or wrong one is a 401 (yotpo-authentication).
 * - GET /v1/apps/{store_id}/reviews takes since_updated_at (YYYY-MM-DD),
 *   count (at most 100, default 10), page and deleted, and answers
 *   {reviews}; data lags an hour (retrieve-all-reviews).
 * - Errors on api.yotpo.com are {status: {message, code, error_type}};
 *   past 5 requests a second a store gets 429 with Retry-After in seconds
 *   (rate-limiting).
 * - GET https://loyalty.yotpo.com/api/v2/customers/recent, with X-GUID and
 *   X-API-KEY, answers the members updated in the last seven days, most
 *   recent first, per_page at most 500, paged by metadata.next_page_info
 *   passed back as page_info; a bad cursor is a 400 (loyalty-authentication,
 *   fetch-all-recently-updated-customers).
 */
const DOCS = {
  limits: "https://docs.yotpo.com/docs/rate-limiting",
  token: "https://docs.yotpo.com/reference/yotpo-authentication",
  reviews: "https://docs.yotpo.com/reference/retrieve-all-reviews",
  loyalty: "https://docs.yotpo.com/reference/loyalty-authentication",
  recent: "https://docs.yotpo.com/reference/fetch-all-recently-updated-customers",
} as const;
export const YOTPO_DOC_PAGES = DOCS;

export type YotpoMockRecord = Record<string, unknown>;

export interface YotpoMockData {
  storeId: string;
  apiSecret: string;
  loyaltyGuid?: string | undefined;
  loyaltyApiKey?: string | undefined;
  reviews: YotpoMockRecord[];
  /** Loyalty members, each with an `updated_at` the mock filters on and leaves out of answers. */
  members?: YotpoMockRecord[];
  /** The mock's clock, for the seven-day window. */
  now?: string;
  /** 429s to answer before the next reads. */
  rateLimits?: number;
}

/** A five-star product review, `n` hours into 2026. */
export const yotpoReview = fixtureBuilder<YotpoMockRecord>((n) => ({
  id: 100_000 + n,
  title: "Beautiful ring",
  content: "The setting is perfect and it arrived early. Couldn&#x27;t be happier!",
  score: 5,
  votes_up: 1,
  votes_down: 0,
  created_at: synthetic.isoTime(n * 60),
  updated_at: synthetic.isoTime(n * 60),
  sentiment: 0.93,
  sku: `RING-${String(n).padStart(4, "0")}`,
  name: synthetic.name(n),
  email: synthetic.email(n),
  reviewer_type: "verified_buyer",
  deleted: false,
  user_reference: null,
  is_incentivized: false,
  incentive_type: null,
  archived: false,
  escalated: false,
}));

/** A Loyalty member with points, updated `n` hours into 2026. */
export const yotpoMember = fixtureBuilder<YotpoMockRecord>((n) => ({
  yotpo_customer_id: 5_000_000 + n,
  email: synthetic.email(n),
  first_name: "Test",
  last_name: `Customer ${n}`,
  phone_number: `+121255501${String(n % 100).padStart(2, "0")}`,
  third_party_id: String(7_000_000 + n),
  has_store_account: true,
  opt_in: true,
  total_spend_cents: 125_000,
  total_purchases: 2,
  last_purchase_at: synthetic.isoTime(n * 60 - 600),
  last_seen_at: synthetic.isoTime(n * 60),
  perks_redeemed: 1,
  points_balance: 450,
  points_earned: 1250,
  points_expire_at: null,
  vip_tier_name: "Gold",
  vip_tier_entry_date: synthetic.isoTime(n * 60 - 6000),
  vip_tier_expiration: null,
  birthday_month: 6,
  birth_day: 14,
  updated_at: synthetic.isoTime(n * 60),
}));

const error = (status: number, code: number, message: string, errorType: string): DocMockResponse => ({ status, body: { status: { message, code, error_type: errorType } } });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface YotpoMock {
  api: DocMock;
  loyalty: DocMock;
  fetch: DocMockFetch;
  /** Makes every token handed out so far stop working. */
  revokeTokens(): void;
  readonly signIns: number;
  /** Each read: the list and its query. */
  readonly reads: { list: "reviews" | "loyalty"; query: Record<string, string> }[];
}

export function yotpoDocMock(data: YotpoMockData): YotpoMock {
  const tokens = new Set<string>();
  const reads: { list: "reviews" | "loyalty"; query: Record<string, string> }[] = [];
  let limits = data.rateLimits ?? 0;
  let signIns = 0;
  const limited = (): DocMockResponse | null => {
    if (limits <= 0) return null;
    limits--;
    return { ...error(429, 429, "Too Many Requests", "rate_limit"), headers: { "retry-after": "1" } };
  };

  const api = checkDocMock({
    integration: "yotpo",
    baseUrl: "https://api.yotpo.com",
    source: { url: DOCS.limits, title: "Yotpo API: authentication, Retrieve all reviews and rate limits", retrievedOn: "2026-11-10", version: "Reviews v1, Core v3" },
    assumptions: [
      "Reviews come back oldest update first, so a page number keeps its place while new reviews arrive",
      "A page past the last is an empty reviews list",
      "since_updated_at is read as a UTC day",
      "An access token lasts at least as long as one sync",
    ],
    routes: [
      {
        method: "POST",
        path: "/core/v3/stores/{storeId}/access_tokens",
        documentedAt: DOCS.token,
        respond(request, params) {
          let body: unknown;
          try {
            body = JSON.parse(request.body);
          } catch {
            body = undefined;
          }
          if (params.storeId !== data.storeId) return error(404, 404, "Store not found", "not_found");
          if (typeof body !== "object" || body === null || (body as Record<string, unknown>).secret !== data.apiSecret) return error(401, 401, "Invalid secret", "authorization");
          signIns++;
          const token = `yotpotok${signIns}${"x".repeat(24)}`;
          tokens.add(token);
          return { status: 200, body: { access_token: token } };
        },
      },
      {
        method: "GET",
        path: "/v1/apps/{storeId}/reviews",
        documentedAt: DOCS.reviews,
        respond(request, params) {
          if (params.storeId !== data.storeId) return error(404, 404, "Store not found", "not_found");
          if (!tokens.has(request.headers.get("x-yotpo-token") ?? "")) return error(401, 401, "Missing or invalid access token", "authorization");
          const stop = limited();
          if (stop) return stop;
          const q = Object.fromEntries(request.url.searchParams);
          for (const name of Object.keys(q)) if (!["since_id", "since_date", "since_updated_at", "count", "page", "deleted", "user_reference", "id"].includes(name)) return { status: 400, text: "" };
          if (q.since_updated_at !== undefined && !DAY.test(q.since_updated_at)) return { status: 400, text: "" };
          const count = q.count === undefined ? 10 : Number(q.count);
          const page = q.page === undefined ? 1 : Number(q.page);
          if (!Number.isInteger(count) || count < 1 || count > 100 || !Number.isInteger(page) || page < 1) return { status: 400, text: "" };
          reads.push({ list: "reviews", query: q });
          const rows = data.reviews
            .filter((r) => q.deleted === "true" || r.deleted !== true)
            .filter((r) => q.since_updated_at === undefined || String(r.updated_at).slice(0, 10) >= q.since_updated_at)
            .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)) || Number(a.id) - Number(b.id));
          // `deleted` is only in an answer that asked for it.
          const shown = rows.slice((page - 1) * count, page * count).map((r) => (q.deleted === "true" ? r : Object.fromEntries(Object.entries(r).filter(([k]) => k !== "deleted"))));
          return { status: 200, body: { reviews: shown } };
        },
      },
    ],
  });

  const loyalty = checkDocMock({
    integration: "yotpo",
    baseUrl: "https://loyalty.yotpo.com/api/v2",
    source: { url: DOCS.loyalty, title: "Yotpo Loyalty API: authentication and recently updated customers", retrievedOn: "2026-11-10", version: "v2" },
    assumptions: ["A page_info cursor stays good for the rest of a sync"],
    routes: [
      {
        method: "GET",
        path: "/customers/recent",
        documentedAt: DOCS.recent,
        respond(request) {
          if (!data.loyaltyGuid || request.headers.get("x-guid") !== data.loyaltyGuid || request.headers.get("x-api-key") !== data.loyaltyApiKey) return { status: 401, body: { error: "Unauthorized" } };
          const stop = limited();
          if (stop) return stop;
          const q = Object.fromEntries(request.url.searchParams);
          for (const name of Object.keys(q)) if (!["per_page", "page_info"].includes(name)) return { status: 400, body: { error: `Unknown parameter ${name}` } };
          const size = q.per_page === undefined ? 100 : Number(q.per_page);
          if (!Number.isInteger(size) || size < 1 || size > 500) return { status: 400, body: { error: "Invalid per_page" } };
          const decoded = q.page_info === undefined ? "offset:0" : Buffer.from(q.page_info, "base64url").toString("utf8");
          if (!/^offset:\d{1,6}$/.test(decoded)) return { status: 400, body: { error: "Invalid page_info" } };
          const offset = Number(decoded.slice(7));
          reads.push({ list: "loyalty", query: q });
          const since = Date.parse(data.now ?? "2026-11-10T15:00:00Z") - 7 * 86_400_000;
          const rows = (data.members ?? []).filter((m) => Date.parse(String(m.updated_at)) >= since).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
          const page = rows.slice(offset, offset + size).map(({ updated_at: _, ...m }) => m);
          const next = offset + size < rows.length ? Buffer.from(`offset:${offset + size}`).toString("base64url") : null;
          return { status: 200, body: { metadata: { next_page_info: next }, customers: page } };
        },
      },
    ],
  });

  const apiFetch = docMockFetch(api);
  const loyaltyFetch = docMockFetch(loyalty);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      // Routed by exact origin, so a look-alike host goes to the API mock and is turned down there.
      const toLoyalty = new URL(input instanceof Request ? input.url : String(input)).origin === "https://loyalty.yotpo.com";
      const response = await (toLoyalty ? loyaltyFetch : apiFetch)(input, init);
      calls.push(...(toLoyalty ? loyaltyFetch.calls : apiFetch.calls).slice(-1));
      return response;
    },
    { calls },
  );

  return {
    api,
    loyalty,
    fetch,
    revokeTokens: () => tokens.clear(),
    get signIns() {
      return signIns;
    },
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "yotpo",
  covers: "Yotpo's access token, Retrieve all reviews (Reviews v1) and recently updated Loyalty customers (Loyalty v2)",
  watchPages: [DOCS.limits, DOCS.token, DOCS.reviews, DOCS.loyalty, DOCS.recent],
  docMocks: () => {
    const mock = yotpoDocMock({ storeId: "", apiSecret: "", reviews: [] });
    return [mock.api, mock.loyalty];
  },
} satisfies DocMockModule;
