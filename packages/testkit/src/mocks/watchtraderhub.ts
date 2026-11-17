import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * The WatchTraderHub Custom Integration API (v1) endpoints a read-only
 * connector uses, built from WatchTraderHub's API docs. Data is synthetic.
 * WatchTraderHub has no sandbox (test mode reads the live inventory); once a
 * dealer's key is set up, recordings replace this mock.
 *
 * Docs facts the mock relies on:
 * - Base URL https://www.watchtraderhub.com/api/v1, with
 *   `Authorization: Bearer wth_<32 base62>`; 401 malformed_authorization
 *   or invalid_api_key, and 403 integration_disabled
 *   or subscription_required (quickstart, authentication, errors).
 * - `GET /me` answers the integration: object "integration", user_id,
 *   is_enabled, is_test_mode, api_version (2026-05-07), subscribed_events and
 *   webhook (quickstart).
 * - `GET /listings`, `GET /parts` and `GET /orders` take limit (50 by
 *   default, at most 250), after (the previous next_cursor) and
 *   updated_after (rows whose updated_at is later), ordered by
 *   (updated_at DESC, id DESC), and answer {object: "list", data, has_more,
 *   next_cursor}, next_cursor null after the last page. A cursor that wasn't
 *   given answers 400 invalid_cursor (pagination).
 * - Errors are {error: {type, code, message, doc_url, request_id}}; 429
 *   too_many_requests comes with Retry-After (errors, rate-limits).
 * - A listing has id, status (active shown), quantity, price {amount,
 *   currency, amount_formatted} with 1200000 for "$12,000.00", watch {brand,
 *   model, reference, stock_number, ...}, photos, created_at and updated_at;
 *   a part has part {name, manufacturer, stock_number, ...} and a sold-out
 *   part reads sold_out; an order has status (pending, matched, dismissed),
 *   currency, total_amount, buyer {name, email, phone, address...},
 *   line_items, ordered_at and created_at (quickstart, events, and the
 *   Postman collection the overview links).
 */
const BASE = "https://www.watchtraderhub.com/api/v1";
const DOCS = "https://www.watchtraderhub.com/docs/api";
export const WATCHTRADERHUB_DOC_PAGES = {
  quickstart: `${DOCS}/quickstart`,
  pagination: `${DOCS}/pagination`,
} as const;
const QUERY = new Set(["limit", "after", "updated_after"]);
const KEY = /^Bearer\s+(wth_[A-Za-z0-9]{32})$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export type WatchTraderHubMockRecord = Record<string, unknown>;

const pad = (n: number, width: number) => String(n).padStart(width, "0");
/** A UUID-shaped id whose digits never run long enough to look like a card number. */
const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-a000-a${pad(n, 11)}`;
const price = (amount: number) => ({ amount, currency: "USD", amount_formatted: `$${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}` });

/** Listing `n`: an active watch, one in stock, changed `n` hours into 2026. */
export const watchTraderHubListing = fixtureBuilder<WatchTraderHubMockRecord>((n) => ({
  id: uuid("24f0ebb1", n),
  external_id: `ext-listing-${n}`,
  object: "listing",
  title: `Test watch ${n}`,
  description: "A test description the connector must drop",
  description_paragraphs: ["A test description the connector must drop"],
  status: "active",
  quantity: 1,
  business_unit: { id: "bu-1", name: "Test business unit" },
  store_location: { id: "loc-1", name: "Test showroom" },
  location: { city: "Testville", country: "US", region: "NY" },
  price: price(1_000_000 + n * 100),
  promotion: null,
  photos: [{ url: `https://cdn.watchtraderhub.example/test-${n}.jpg`, thumbnail_url: null, width: 800, height: 800, order: 0 }],
  labels: { condition: "Very good" },
  watch: { brand: "Testbrand", model: `Model ${n}`, reference: `REF-${n}`, stock_number: synthetic.sku(n), caliber: "T-1", year: 2020, condition: "very_good" },
  created_at: synthetic.isoTime(n * 60 - 30),
  updated_at: synthetic.isoTime(n * 60),
}));

/** Part `n`: an active spare part with `n` in stock, changed `n` hours into 2026. */
export const watchTraderHubPart = fixtureBuilder<WatchTraderHubMockRecord>((n) => ({
  id: uuid("7a11c0de", n),
  external_id: `ext-part-${n}`,
  object: "part",
  status: "active",
  quantity: n,
  description: "A test description the connector must drop",
  description_paragraphs: [],
  business_unit: { id: "bu-1", name: "Test business unit" },
  store_location: { id: "loc-1", name: "Test showroom" },
  location: { city: "Testville", country: "US", region: "NY" },
  price: price(5_000 + n * 100),
  promotion: null,
  photos: [],
  labels: { condition: "New", type: "Crown" },
  part: { name: `Test crown ${n}`, type: "crown", manufacturer: "Testmaker", compatible_brand: "Testbrand", compatible_models: [`Model ${n}`], condition: "new", is_genuine: true, stock_number: `PART-TEST-${pad(n, 4)}` },
  created_at: synthetic.isoTime(n * 60 - 30),
  updated_at: synthetic.isoTime(n * 60),
}));

/** Order `n`: matched, one line, placed `n` hours into 2026, with a buyer the connector must drop. */
export const watchTraderHubOrder = fixtureBuilder<WatchTraderHubMockRecord>((n) => ({
  id: uuid("d7df4fbe", n),
  external_id: `shop-${n}`,
  channel_order_id: `SITE-${1000 + n}`,
  object: "order",
  status: "matched",
  currency: "USD",
  total_amount: 1_000_000 + n * 100,
  shipping_amount: 2_500,
  discount_amount: 0,
  tax_amount: 0,
  business_unit: { id: "bu-1", name: "Test business unit" },
  store_location: { id: "loc-1", name: "Test showroom" },
  buyer: { name: synthetic.name(n), email: synthetic.email(n), phone: synthetic.phone(n), address_line1: `${n} Test Street`, address_line2: null, city: "Testville", region: "NY", postal_code: "00000", country: "US" },
  line_items: [{ external_id: `line-${n}`, sku: `REF-${n}`, quantity: 1, unit_amount: 997_500 + n * 100, discount_amount: 0, line_total_amount: 997_500 + n * 100, status: "matched", sale_ids: [] }],
  ordered_at: synthetic.isoTime(n * 60 - 5),
  created_at: synthetic.isoTime(n * 60),
}));

export interface WatchTraderHubMockData {
  /** The one API key the mock accepts. */
  key: string;
  listings?: WatchTraderHubMockRecord[];
  parts?: WatchTraderHubMockRecord[];
  orders?: WatchTraderHubMockRecord[];
  /** The dealer paused the integration: lists answer 403 integration_disabled, and /me says is_enabled false. */
  disabled?: boolean;
  /** The dealer's plan lapsed: every call answers 403 subscription_required. */
  unsubscribed?: boolean;
  /** 429s to answer before the next calls. */
  rateLimits?: number;
}

export interface WatchTraderHubMock {
  mock: DocMock;
  fetch: DocMockFetch;
  /** Each list call answered with a page: its path, limit, cursor and updated_after. */
  readonly reads: { path: string; limit: number; after: string | null; updatedAfter: string | null }[];
}

const failure = (status: number, type: string, code: string, message: string, headers?: Record<string, string>): DocMockResponse => ({
  status,
  body: { error: { type, code, message, doc_url: `${DOCS}/errors#${code}`, request_id: "req_test" } },
  ...(headers ? { headers } : {}),
});
const invalid = (param: string, message: string): DocMockResponse => ({
  status: 400,
  body: { error: { type: "validation_error", code: "invalid_request", message, doc_url: `${DOCS}/errors#invalid_request`, request_id: "req_test", param } },
});
const badCursor = () => failure(400, "validation_error", "invalid_cursor", "The cursor is not one this API gave.");

/** When a row last changed: updated_at, or created_at for an order, which shows no updated_at. */
const changed = (r: WatchTraderHubMockRecord) => String(r.updated_at ?? r.created_at);
/** Newest change first, ties by id descending, as the pagination page says. */
const newestFirst = (a: WatchTraderHubMockRecord, b: WatchTraderHubMockRecord) => changed(b).localeCompare(changed(a)) || String(b.id).localeCompare(String(a.id));
const encode = (path: string, row: WatchTraderHubMockRecord) => Buffer.from(JSON.stringify({ path, id: row.id, updated_at: changed(row) })).toString("base64url");
function decode(path: string, cursor: string): { id: string; updated_at: string } | null {
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString()) as Record<string, unknown>;
    return c.path === path && typeof c.id === "string" && typeof c.updated_at === "string" ? { id: c.id, updated_at: c.updated_at } : null;
  } catch {
    return null;
  }
}

export function watchTraderHubDocMock(data: WatchTraderHubMockData): WatchTraderHubMock {
  const reads: WatchTraderHubMock["reads"] = [];
  let limits = data.rateLimits ?? 0;

  /** Checks the key as the authentication page says, then the rate limit and the plan. */
  function gate(request: DocMockRequest): DocMockResponse | null {
    // A request with no bearer header at all never gets here: the doc mock answers it 401 first.
    const match = KEY.exec(request.headers.get("authorization") ?? "");
    if (!match) return failure(401, "authentication_error", "malformed_authorization", "The Authorization header must be Bearer and an API key.");
    if (match[1] !== data.key) return failure(401, "authentication_error", "invalid_api_key", "The API key matches no active integration.");
    if (limits > 0) {
      limits--;
      return failure(429, "rate_limit_error", "too_many_requests", "Rate limit exceeded.", { "retry-after": "1", "x-ratelimit-remaining": "0" });
    }
    if (data.unsubscribed) return failure(403, "permission_error", "subscription_required", "The dealer's plan does not include the custom integration.");
    return null;
  }

  function list(rows: () => WatchTraderHubMockRecord[]) {
    return (request: DocMockRequest): DocMockResponse => {
      const stop = gate(request);
      if (stop) return stop;
      if (data.disabled) return failure(403, "permission_error", "integration_disabled", "The dealer has paused this integration.");
      const q = request.url.searchParams;
      const unknown = [...q.keys()].find((k) => !QUERY.has(k));
      if (unknown) return invalid(unknown, `${unknown} is not a parameter of this endpoint.`);
      const limit = q.get("limit") === null ? 50 : Number(q.get("limit"));
      if (!Number.isInteger(limit) || limit < 1 || limit > 250) return invalid("limit", "limit must be between 1 and 250.");
      const since = q.get("updated_after");
      if (since !== null && (!ISO.test(since) || Number.isNaN(Date.parse(since)))) return invalid("updated_after", "updated_after must be an ISO 8601 time.");
      const path = request.url.pathname.slice(new URL(BASE).pathname.length);
      const after = q.get("after");
      const from = after === null ? null : decode(path, after);
      if (after !== null && from === null) return badCursor();
      reads.push({ path, limit, after, updatedAfter: since });
      let ordered = rows()
        .filter((r) => since === null || Date.parse(changed(r)) > Date.parse(since))
        .sort(newestFirst);
      if (from) ordered = ordered.filter((r) => newestFirst(r, { id: from.id, updated_at: from.updated_at }) > 0);
      const page = ordered.slice(0, limit);
      const hasMore = ordered.length > limit;
      return { status: 200, body: { object: "list", data: page, has_more: hasMore, next_cursor: hasMore ? encode(path, page.at(-1)!) : null } };
    };
  }

  const mock = checkDocMock({
    integration: "watchtraderhub",
    baseUrl: BASE,
    source: { url: WATCHTRADERHUB_DOC_PAGES.quickstart, title: "WatchTraderHub API: Quickstart", retrievedOn: "2026-11-11", version: "2026-05-07" },
    auth: "bearer",
    assumptions: [
      "Listings and parts have only the statuses active and sold (listings) or active and sold_out (parts); the docs list no enum",
      "Amounts are integers in minor units: the quickstart shows 1200000 as $12,000.00, but no page says so",
      "Orders are filtered and ordered by a change time they don't show; the mock uses created_at",
      "A cursor is only good for the list it came from",
      "GET /me still answers while the integration is disabled, with is_enabled false",
      "A sold listing has none on hand, whatever its quantity says",
    ],
    routes: [
      {
        method: "GET",
        path: "/me",
        documentedAt: WATCHTRADERHUB_DOC_PAGES.quickstart,
        respond: (request) =>
          gate(request) ?? {
            status: 200,
            body: {
              object: "integration",
              user_id: "user-test-1",
              is_enabled: !data.disabled,
              is_test_mode: true,
              api_version: "2026-05-07",
              subscribed_events: ["*"],
              webhook: { url: "https://dealer.example.test/webhooks/wth", last_success_at: null, last_failure_at: null, consecutive_failures: 0 },
            },
          },
      },
      { method: "GET", path: "/listings", documentedAt: WATCHTRADERHUB_DOC_PAGES.pagination, respond: list(() => data.listings ?? []) },
      { method: "GET", path: "/parts", documentedAt: WATCHTRADERHUB_DOC_PAGES.pagination, respond: list(() => data.parts ?? []) },
      { method: "GET", path: "/orders", documentedAt: WATCHTRADERHUB_DOC_PAGES.pagination, respond: list(() => data.orders ?? []) },
    ],
  });
  return {
    mock,
    fetch: docMockFetch(mock),
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "watchtraderhub",
  covers: "WatchTraderHub's Custom Integration API (v1): the integration, listing, part and order reads, with bearer keys, cursors and updated_after",
  watchPages: [WATCHTRADERHUB_DOC_PAGES.quickstart, WATCHTRADERHUB_DOC_PAGES.pagination],
  docMocks: () => [watchTraderHubDocMock({ key: "" }).mock],
} satisfies DocMockModule;
