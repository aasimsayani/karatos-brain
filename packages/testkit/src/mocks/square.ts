import { createHash } from "node:crypto";
import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockRequest, type DocMockResponse, type DocMockModule } from "../doc-mock.js";

/**
 * The Square API's read endpoints and OAuth token endpoints, built from
 * Square's developer docs (API version 2026-09-16) and served on the
 * sandbox host. Data is synthetic, and carries the personal data a real
 * account would, so tests can check none of it is kept. A Square sandbox
 * seller account replaces this mock once a developer account is set up.
 */
const DOCS = "https://developer.squareup.com";
const REF = `${DOCS}/reference/square`;
export const SQUARE_MOCK_HOST = "https://connect.squareupsandbox.com";

/** Every scope a full-access token holds, as the mock reports one; enough to include the write scopes. */
export const SQUARE_MOCK_ALL_SCOPES = [
  "MERCHANT_PROFILE_READ",
  "MERCHANT_PROFILE_WRITE",
  "ITEMS_READ",
  "ITEMS_WRITE",
  "INVENTORY_READ",
  "INVENTORY_WRITE",
  "CUSTOMERS_READ",
  "CUSTOMERS_WRITE",
  "ORDERS_READ",
  "ORDERS_WRITE",
  "PAYMENTS_READ",
  "PAYMENTS_WRITE",
];
export const SQUARE_MOCK_READ_SCOPES = ["MERCHANT_PROFILE_READ", "ITEMS_READ", "INVENTORY_READ", "CUSTOMERS_READ", "ORDERS_READ", "PAYMENTS_READ"];
export const SQUARE_TEST_MERCHANT = "SQTESTMERCHANT1";
export const SQUARE_TEST_APPLICATION = "sandbox-test-application-1";

export type SquareMockRecord = Record<string, unknown>;

export interface SquareMockData {
  locations: SquareMockRecord[];
  /** Catalog ITEM objects, each with its variations nested as Square returns them. */
  items?: SquareMockRecord[];
  /** Deleted ITEM_VARIATION objects no item lists any more; only batch-retrieve with include_deleted_objects finds them. */
  deletedVariations?: SquareMockRecord[];
  counts?: SquareMockRecord[];
  customers?: SquareMockRecord[];
  orders?: SquareMockRecord[];
  payments?: SquareMockRecord[];
  refunds?: SquareMockRecord[];
  /** An OAuth authorization: the app's secret, the seller's refresh token and the scopes the seller granted. */
  oauth?: { applicationSecret: string; refreshToken: string; granted: string[] };
  /** Bearer tokens the mock accepts as they are, with their scopes: a personal access token has every scope. */
  tokens?: Record<string, string[]>;
  /** 429s to answer before the next reads, in order, with the Retry-After to send if any. */
  rateLimits?: { retryAfter?: number }[];
  /** "Now", for the documented defaults that depend on it (payments and refunds look back one year). */
  now?: () => Date;
}

const id = (prefix: string, n: number) => `SQTEST${prefix}${String(n).padStart(4, "0")}`;
export const squareTestId = id;
const at = (n: number) => synthetic.isoTime(n * 60);
const money = (amount: number) => ({ amount, currency: "USD" });

export const squareLocation = fixtureBuilder<SquareMockRecord>((n) => ({
  id: id("LOC", n),
  name: `Test Store ${n}`,
  status: "ACTIVE",
  merchant_id: SQUARE_TEST_MERCHANT,
  currency: "USD",
  timezone: "America/New_York",
  type: "PHYSICAL",
  address: { address_line_1: `${n} Test Street`, locality: "Testville", postal_code: "00000", country: "US" },
  phone_number: synthetic.phone(n),
  business_email: `store${n}@example.test`,
}));

export const squareItem = fixtureBuilder<SquareMockRecord>((n) => ({
  type: "ITEM",
  id: id("ITEM", n),
  updated_at: at(n),
  version: 1000 + n,
  is_deleted: false,
  present_at_all_locations: true,
  item_data: {
    name: `Test 14K Ring ${n}`,
    description: "Synthetic description",
    product_type: "REGULAR",
    variations: [
      {
        type: "ITEM_VARIATION",
        id: id("VAR", n),
        updated_at: at(n),
        version: 1000 + n,
        is_deleted: false,
        item_variation_data: { item_id: id("ITEM", n), name: "Size 6", sku: synthetic.sku(n), pricing_type: "FIXED_PRICING", price_money: money(125_000 + n), track_inventory: true },
      },
    ],
  },
}));

export const squareCount = fixtureBuilder<SquareMockRecord>((n) => ({
  catalog_object_id: id("VAR", n),
  catalog_object_type: "ITEM_VARIATION",
  state: "IN_STOCK",
  location_id: id("LOC", 1),
  quantity: String(n),
  calculated_at: at(n),
}));

export const squareCustomer = fixtureBuilder<SquareMockRecord>((n) => ({
  id: id("CUST", n),
  created_at: at(n),
  updated_at: at(n + 1),
  given_name: "Test",
  family_name: `Customer ${n}`,
  email_address: synthetic.email(n),
  phone_number: synthetic.phone(n),
  address: { address_line_1: `${n} Test Street`, locality: "Testville", postal_code: "00000" },
  note: "Synthetic note about ring size",
  reference_id: `REF-TEST-${n}`,
  birthday: "1990-01-01",
  preferences: { email_unsubscribed: false },
  creation_source: "THIRD_PARTY",
  version: n,
}));

export const squareOrder = fixtureBuilder<SquareMockRecord>((n) => ({
  id: id("ORDER", n),
  location_id: id("LOC", 1),
  source: { name: "Square Point of Sale" },
  customer_id: id("CUST", 1),
  ticket_name: `Test Customer ${n} ring`,
  reference_id: `RECEIPT-TEST-${n}`,
  line_items: [
    {
      uid: `uid-${n}`,
      name: `Test 14K Ring ${n}`,
      note: "Synthetic engraving note",
      quantity: "1",
      catalog_object_id: id("VAR", n),
      variation_name: "Size 6",
      base_price_money: money(125_000),
      total_discount_money: money(5_000),
      total_money: money(120_000),
    },
  ],
  tenders: [
    {
      id: id("PAY", n),
      type: "CARD",
      amount_money: money(120_000),
      customer_id: id("CUST", 1),
      card_details: { status: "CAPTURED", card: { card_brand: "VISA", last_4: "0000", exp_month: 1, exp_year: 2030 } },
      payment_id: id("PAY", n),
    },
  ],
  total_money: money(120_000),
  state: "COMPLETED",
  version: 4,
  created_at: at(n),
  updated_at: at(n + 2),
  closed_at: at(n + 1),
}));

export const squarePayment = fixtureBuilder<SquareMockRecord>((n) => ({
  id: id("PAY", n),
  created_at: at(n),
  updated_at: at(n + 1),
  amount_money: money(120_000),
  total_money: money(120_000),
  approved_money: money(120_000),
  status: "COMPLETED",
  source_type: "CARD",
  card_details: {
    status: "CAPTURED",
    card: { card_brand: "VISA", last_4: "0000", exp_month: 1, exp_year: 2030, fingerprint: "sq-1-synthetic-fingerprint", card_type: "CREDIT", bin: "000000" },
    entry_method: "KEYED",
  },
  location_id: id("LOC", 1),
  order_id: id("ORDER", n),
  customer_id: id("CUST", 1),
  buyer_email_address: synthetic.email(n),
  billing_address: { address_line_1: `${n} Test Street`, postal_code: "00000" },
  shipping_address: { address_line_1: `${n} Test Street`, postal_code: "00000" },
  note: "Synthetic payment note",
  receipt_number: `R${n}`,
  receipt_url: `https://squareupsandbox.com/receipt/preview/${id("PAY", n)}`,
  version_token: `vt-test-${n}`,
}));

export const squareRefund = fixtureBuilder<SquareMockRecord>((n) => ({
  id: id("REFUND", n),
  status: "COMPLETED",
  location_id: id("LOC", 1),
  amount_money: money(5_000),
  payment_id: id("PAY", n),
  order_id: id("RETURN", n),
  reason: "Synthetic reason: the customer changed their mind",
  created_at: at(n + 10),
  updated_at: at(n + 11),
}));

const errorBody = (status: number, category: string, code: string, detail: string): DocMockResponse => ({ status, body: { errors: [{ category, code, detail }] } });
const invalid = (detail: string, code = "INVALID_VALUE") => errorBody(400, "INVALID_REQUEST_ERROR", code, detail);

/** A cursor tied to the query it pages, as Square requires the same query with each cursor. */
const signature = (query: unknown) => createHash("sha256").update(JSON.stringify(query)).digest("hex").slice(0, 12);
const encodeCursor = (offset: number, query: unknown) => Buffer.from(`${offset}:${signature(query)}`).toString("base64url");
function decodeCursor(cursor: unknown, query: unknown): number | null {
  if (cursor === undefined || cursor === null) return 0;
  const [offset, sig] = Buffer.from(String(cursor), "base64url").toString("utf8").split(":");
  return sig === signature(query) && /^\d+$/.test(offset ?? "") ? Number(offset) : null;
}

/** One page of rows, or an error when the cursor belongs to another query. */
function paged(rows: SquareMockRecord[], cursor: unknown, query: unknown, size: number, field: string): DocMockResponse {
  const offset = decodeCursor(cursor, query);
  if (offset === null) return invalid("The cursor does not match the query it was issued for", "INVALID_CURSOR");
  const page = rows.slice(offset, offset + size);
  const next = offset + size < rows.length ? encodeCursor(offset + size, query) : undefined;
  return { status: 200, body: { [field]: page, ...(next ? { cursor: next } : {}) } };
}

const time = (value: unknown) => (typeof value === "string" ? Date.parse(value) : Number.NaN);
const parseBody = (request: DocMockRequest): Record<string, unknown> | null => {
  try {
    const body = JSON.parse(request.body || "{}") as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export interface SquareMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Token refreshes and status checks answered. */
  readonly refreshes: number;
  readonly statusChecks: number;
  /** Revokes every access token the mock issued, as when one is cut off early. */
  revokeAccessTokens(): void;
}

export function squareDocMock(data: SquareMockData): SquareMock {
  const now = data.now ?? (() => new Date("2026-01-20T00:00:00Z"));
  const issued = new Map<string, string[]>();
  let refreshes = 0;
  let statusChecks = 0;
  let count = 0;
  const limits = [...(data.rateLimits ?? [])];

  /** The token's scopes, or null when the mock doesn't know the token. */
  const scopesOf = (request: DocMockRequest): string[] | null => {
    const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return null;
    return issued.get(token) ?? data.tokens?.[token] ?? null;
  };

  /** Checks the version header, token and permission, and serves queued rate limits. Undefined means go on. */
  function gate(request: DocMockRequest, permission: string): DocMockResponse | undefined {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(request.headers.get("square-version") ?? "")) return invalid("Square-Version must be a YYYY-MM-DD version", "INVALID_SQUARE_VERSION_FORMAT");
    const scopes = scopesOf(request);
    if (!scopes) return errorBody(401, "AUTHENTICATION_ERROR", "UNAUTHORIZED", "This request could not be authorized.");
    const limit = limits.shift();
    if (limit) return { status: 429, body: { errors: [{ category: "RATE_LIMIT_ERROR", code: "RATE_LIMITED", detail: "Too many requests" }] }, headers: limit.retryAfter ? { "retry-after": String(limit.retryAfter) } : {} };
    if (!scopes.includes(permission)) return errorBody(403, "AUTHENTICATION_ERROR", "INSUFFICIENT_SCOPES", `The merchant has not given your application sufficient permissions to do that. ${permission} is required.`);
    return undefined;
  }

  const variations = () =>
    (data.items ?? []).flatMap((item) =>
      (((item.item_data as SquareMockRecord | undefined)?.variations as SquareMockRecord[] | undefined) ?? []).map((v) => ({ ...v, is_deleted: item.is_deleted === true || v.is_deleted === true })),
    );
  const firstLocation = () => String(data.locations[0]?.id ?? "");

  const api = checkDocMock({
    integration: "square",
    baseUrl: SQUARE_MOCK_HOST,
    source: { url: `${DOCS}/docs/build-basics/versioning-overview`, title: "Square API versioning", retrievedOn: "2026-10-22", version: "2026-09-16" },
    assumptions: [
      "A personal access token's status check lists every scope, write scopes included (the docs call it full access but don't show its status)",
      "The token status check works on the sandbox host as on production",
      "The Square-Version header is required here; the real API falls back to the application's default version",
      "Search Catalog Objects with begin_time returns deleted objects too when include_deleted_objects is true",
      "Payments and refunds with sort_order ASC come oldest first by created_at; a cursor keeps working while the query is resent unchanged",
      "Inventory counts at quantity zero are still returned with state IN_STOCK",
      "Locations are returned in one response with no cursor",
      "Payments for an inactive location are still listed when its location_id is passed",
    ],
    routes: [
      {
        method: "POST",
        path: "/oauth2/token",
        documentedAt: `${REF}/oauth-api/obtain-token`,
        respond(request) {
          refreshes++;
          const body = parseBody(request) ?? {};
          const oauth = data.oauth;
          if (!oauth || body.grant_type !== "refresh_token" || body.client_id !== SQUARE_TEST_APPLICATION || body.client_secret !== oauth.applicationSecret) {
            return errorBody(401, "AUTHENTICATION_ERROR", "UNAUTHORIZED", "Not Authorized");
          }
          if (body.refresh_token !== oauth.refreshToken) return errorBody(401, "AUTHENTICATION_ERROR", "UNAUTHORIZED", "Invalid refresh token");
          // The documented intersection of the requested scopes and those the seller granted.
          const requested = Array.isArray(body.scopes) ? (body.scopes as string[]) : oauth.granted;
          const scopes = oauth.granted.filter((s) => requested.includes(s));
          const token = `sq-mock-access-${++count}`;
          issued.set(token, scopes);
          const expires = new Date(now().getTime() + 30 * 86_400_000).toISOString();
          return { status: 200, body: { access_token: token, token_type: "bearer", expires_at: expires, merchant_id: SQUARE_TEST_MERCHANT, refresh_token: oauth.refreshToken, short_lived: false } };
        },
      },
      {
        method: "POST",
        path: "/oauth2/token/status",
        documentedAt: `${REF}/oauth-api/retrieve-token-status`,
        respond(request) {
          statusChecks++;
          const scopes = scopesOf(request);
          if (!scopes) return errorBody(401, "AUTHENTICATION_ERROR", "UNAUTHORIZED", "The access token is expired or invalid.");
          return { status: 200, body: { scopes, expires_at: "", client_id: SQUARE_TEST_APPLICATION, merchant_id: SQUARE_TEST_MERCHANT } };
        },
      },
      {
        method: "GET",
        path: "/v2/locations",
        documentedAt: `${REF}/locations-api/list-locations`,
        respond(request) {
          return gate(request, "MERCHANT_PROFILE_READ") ?? { status: 200, body: { locations: [...data.locations].sort((a, b) => String(a.name).localeCompare(String(b.name))) } };
        },
      },
      {
        method: "POST",
        path: "/v2/catalog/search",
        documentedAt: `${REF}/catalog-api/search-catalog-objects`,
        respond(request) {
          const denied = gate(request, "ITEMS_READ");
          if (denied) return denied;
          const body = parseBody(request);
          if (!body) return invalid("Request body is not JSON", "BAD_REQUEST");
          const types = body.object_types as unknown;
          if (!Array.isArray(types) || !types.includes("ITEM")) return { status: 200, body: {} };
          let rows = (data.items ?? []).filter((o) => body.include_deleted_objects === true || o.is_deleted !== true);
          if (body.begin_time !== undefined) {
            const from = time(body.begin_time);
            if (Number.isNaN(from)) return invalid("begin_time must be RFC 3339");
            // Exclusive, as documented.
            rows = rows.filter((o) => time(o.updated_at) > from);
          }
          const limit = typeof body.limit === "number" && body.limit > 0 && body.limit <= 1000 ? body.limit : 100;
          const { cursor, ...query } = body;
          return paged(rows, cursor, query, limit, "objects");
        },
      },
      {
        method: "POST",
        path: "/v2/catalog/batch-retrieve",
        documentedAt: `${REF}/catalog-api/batch-retrieve-catalog-objects`,
        respond(request) {
          const denied = gate(request, "ITEMS_READ");
          if (denied) return denied;
          const body = parseBody(request);
          const ids = body?.object_ids;
          if (!Array.isArray(ids) || ids.length < 1 || ids.length > 1000) return invalid("object_ids must hold 1 to 1000 IDs");
          const deleted: SquareMockRecord[] = (data.deletedVariations ?? []).map((v) => ({ ...v, is_deleted: true }));
          const all: SquareMockRecord[] = [...(data.items ?? []), ...variations(), ...deleted].filter((o) => body!.include_deleted_objects === true || o.is_deleted !== true);
          return { status: 200, body: { objects: all.filter((o) => ids.includes(o.id)) } };
        },
      },
      {
        method: "POST",
        path: "/v2/inventory/counts/batch-retrieve",
        documentedAt: `${REF}/inventory-api/batch-retrieve-inventory-counts`,
        respond(request) {
          const denied = gate(request, "INVENTORY_READ");
          if (denied) return denied;
          const body = parseBody(request);
          if (!body) return invalid("Request body is not JSON", "BAD_REQUEST");
          if (body.limit !== undefined && (typeof body.limit !== "number" || body.limit < 1 || body.limit > 1000)) return invalid("limit must be 1 to 1000");
          let rows = [...(data.counts ?? [])];
          if (Array.isArray(body.states)) rows = rows.filter((c) => (body.states as unknown[]).includes(c.state));
          if (body.updated_after !== undefined) {
            const from = time(body.updated_after);
            if (Number.isNaN(from)) return invalid("updated_after must be RFC 3339");
            rows = rows.filter((c) => time(c.calculated_at) > from);
          }
          // Newest first, as documented.
          rows.sort((a, b) => time(b.calculated_at) - time(a.calculated_at));
          const { cursor, ...query } = body;
          return paged(rows, cursor, query, (body.limit as number | undefined) ?? 1000, "counts");
        },
      },
      {
        method: "POST",
        path: "/v2/customers/search",
        documentedAt: `${REF}/customers-api/search-customers`,
        respond(request) {
          const denied = gate(request, "CUSTOMERS_READ");
          if (denied) return denied;
          const body = parseBody(request);
          if (!body) return invalid("Request body is not JSON", "BAD_REQUEST");
          const limit = body.limit ?? 100;
          if (typeof limit !== "number" || limit < 1) return invalid("limit must be at least 1", "VALUE_TOO_LOW");
          if (limit > 100) return invalid("limit must be at most 100", "VALUE_TOO_HIGH");
          const query = (body.query ?? {}) as { filter?: { updated_at?: { start_at?: unknown; end_at?: unknown } }; sort?: { field?: unknown; order?: unknown } };
          let rows = [...(data.customers ?? [])];
          const updated = query.filter?.updated_at;
          if (updated) {
            // Both bounds are required, as documented.
            const from = time(updated.start_at);
            const to = time(updated.end_at);
            if (Number.isNaN(from) || Number.isNaN(to)) return invalid("updated_at needs start_at and end_at");
            rows = rows.filter((c) => time(c.updated_at) >= from && time(c.updated_at) <= to);
          }
          if (query.sort?.field === "CREATED_AT") rows.sort((a, b) => (time(a.created_at) - time(b.created_at)) * (query.sort?.order === "DESC" ? -1 : 1));
          const { cursor, ...rest } = body;
          return paged(rows, cursor, rest, limit, "customers");
        },
      },
      {
        method: "POST",
        path: "/v2/orders/search",
        documentedAt: `${REF}/orders-api/search-orders`,
        respond(request) {
          const denied = gate(request, "ORDERS_READ");
          if (denied) return denied;
          const body = parseBody(request);
          if (!body) return invalid("Request body is not JSON", "BAD_REQUEST");
          const locations = body.location_ids;
          if (!Array.isArray(locations) || locations.length < 1 || locations.length > 10) return invalid("location_ids must hold 1 to 10 location IDs");
          const limit = body.limit ?? 500;
          if (typeof limit !== "number" || limit < 1 || limit > 1000) return invalid("limit must be 1 to 1000");
          const query = (body.query ?? {}) as { filter?: { date_time_filter?: Record<string, { start_at?: unknown; end_at?: unknown }>; state_filter?: { states?: unknown[] } }; sort?: { sort_field?: unknown; sort_order?: unknown } };
          const filters = Object.entries(query.filter?.date_time_filter ?? {});
          const sortField = String(query.sort?.sort_field ?? "CREATED_AT");
          if (filters.length > 1) return invalid("Only one date_time_filter field can be used");
          if (filters.length === 1 && filters[0]![0].toUpperCase() !== sortField) return invalid("sort_field must match the timestamp field that the DateTimeFilter uses");
          if (sortField === "CLOSED_AT" && !query.filter?.state_filter) return invalid("A CLOSED_AT sort needs a state_filter");
          let rows = (data.orders ?? []).filter((o) => locations.includes(o.location_id));
          const states = query.filter?.state_filter?.states;
          if (Array.isArray(states)) rows = rows.filter((o) => states.includes(o.state));
          const field = sortField.toLowerCase();
          if (filters.length === 1) {
            const [, range] = filters[0]!;
            const from = range.start_at === undefined ? -Infinity : time(range.start_at);
            const to = range.end_at === undefined ? Infinity : time(range.end_at);
            rows = rows.filter((o) => time(o[field]) >= from && time(o[field]) <= to);
          }
          rows.sort((a, b) => (time(a[field]) - time(b[field])) * (query.sort?.sort_order === "ASC" ? 1 : -1));
          const { cursor, ...rest } = body;
          return paged(rows, cursor, rest, limit, "orders");
        },
      },
      {
        method: "GET",
        path: "/v2/payments",
        documentedAt: `${REF}/payments-api/list-payments`,
        respond(request) {
          return gate(request, "PAYMENTS_READ") ?? listByTime(request, data.payments ?? [], "payments", request.url.searchParams.get("location_id") ?? firstLocation());
        },
      },
      {
        method: "GET",
        path: "/v2/refunds",
        documentedAt: `${REF}/payments-api/list-payment-refunds`,
        respond(request) {
          return gate(request, "PAYMENTS_READ") ?? listByTime(request, data.refunds ?? [], "refunds", request.url.searchParams.get("location_id"));
        },
      },
    ],
  });

  /** List Payments and List Payment Refunds: created_at from begin_time (a year back by default), updated_at optionally, newest first by default. */
  function listByTime(request: DocMockRequest, all: SquareMockRecord[], field: string, location: string | null): DocMockResponse {
    const q = request.url.searchParams;
    const limit = Math.min(Number(q.get("limit") ?? "100") || 100, 100);
    const begin = q.has("begin_time") ? time(q.get("begin_time")) : now().getTime() - 365 * 86_400_000;
    if (Number.isNaN(begin)) return invalid("begin_time must be RFC 3339");
    let rows = all.filter((r) => time(r.created_at) >= begin && (location === null || r.location_id === location));
    if (q.has("updated_at_begin_time")) {
      const from = time(q.get("updated_at_begin_time"));
      if (Number.isNaN(from)) return invalid("updated_at_begin_time must be RFC 3339");
      rows = rows.filter((r) => time(r.updated_at) >= from);
    }
    rows.sort((a, b) => (time(a.created_at) - time(b.created_at)) * (q.get("sort_order") === "ASC" ? 1 : -1));
    const query = Object.fromEntries([...q.entries()].filter(([k]) => k !== "cursor").sort());
    return paged(rows, q.get("cursor") ?? undefined, query, limit, field);
  }

  const fetch = docMockFetch(api);
  return {
    api,
    fetch,
    get refreshes() {
      return refreshes;
    },
    get statusChecks() {
      return statusChecks;
    },
    revokeAccessTokens: () => issued.clear(),
  };
}

export default {
  integration: "square",
  covers: "Square's read endpoints with its OAuth refresh and token status check (API version 2026-09-16)",
  watchPages: [
    "https://developer.squareup.com/docs/build-basics/versioning-overview",
    "https://developer.squareup.com/reference/square/oauth-api/obtain-token",
    "https://developer.squareup.com/reference/square/oauth-api/retrieve-token-status",
    "https://developer.squareup.com/reference/square/locations-api/list-locations",
    "https://developer.squareup.com/reference/square/catalog-api/search-catalog-objects",
    "https://developer.squareup.com/reference/square/catalog-api/batch-retrieve-catalog-objects",
    "https://developer.squareup.com/reference/square/inventory-api/batch-retrieve-inventory-counts",
    "https://developer.squareup.com/reference/square/customers-api/search-customers",
    "https://developer.squareup.com/reference/square/orders-api/search-orders",
    "https://developer.squareup.com/reference/square/payments-api/list-payments",
    "https://developer.squareup.com/reference/square/payments-api/list-payment-refunds",
  ],
  docMocks: () => [squareDocMock({ locations: [] }).api],
} satisfies DocMockModule;
