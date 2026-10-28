import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockRequest, type DocMockResponse, type DocMockModule } from "../doc-mock.js";

/**
 * The BigCommerce REST Management API's read paths the connector uses,
 * built from BigCommerce's developer docs (v2 orders and store information,
 * v3 catalog, inventory, customers, order refunds and price lists) and
 * served for one store under `https://api.bigcommerce.com/stores/{hash}`.
 * Data is synthetic, and carries the personal data a real store would, so
 * tests can check none of it is kept. A free BigCommerce sandbox store
 * replaces this mock once one is set up for the nightly run.
 */
const DOCS = "https://docs.bigcommerce.com/developer";
const REF = `${DOCS}/api-reference/rest/admin`;
export const BIGCOMMERCE_TEST_STORE_HASH = "teststore1";
/** The store's numeric ID, as /v2/store and webhooks report it. */
export const BIGCOMMERCE_TEST_STORE_ID = "1000001";
export const BIGCOMMERCE_MOCK_BASE = `https://api.bigcommerce.com/stores/${BIGCOMMERCE_TEST_STORE_HASH}`;
/** The documented per-window quota on Growth and Core plans. */
export const BIGCOMMERCE_MOCK_QUOTA = 150;
const WINDOW_MS = 30_000;
const MAX_LIMIT = 250;

export type BigCommerceMockRecord = Record<string, unknown>;

export interface BigCommerceMockData {
  /** The access token the store's API account holds. */
  token: string;
  /** Store information overrides; `id` is the store hash. */
  store?: BigCommerceMockRecord;
  /** Catalog products, each with its variants nested (served only with include=variants). */
  products?: BigCommerceMockRecord[];
  inventory?: BigCommerceMockRecord[];
  customers?: BigCommerceMockRecord[];
  /** Orders, each with its lines under `lines` and refunds under `refunds`; those two are served from their own paths. */
  orders?: BigCommerceMockRecord[];
  priceLists?: BigCommerceMockRecord[];
  /** Price list records, each with its price_list_id. */
  priceListRecords?: BigCommerceMockRecord[];
  /** 429s to answer before the next reads, in order, with the reset time to send if any. */
  rateLimits?: { resetMs?: number }[];
  /** Requests allowed per window. The mock has no clock, so the window resets on the request after it runs out. */
  quota?: number;
}

const at = (n: number) => synthetic.isoTime(n * 60);
/** v3 writes times as ISO 8601 with an offset. */
const v3Time = (iso: string) => iso.replace(/\.\d{3}Z$/, "+00:00");
/** v2 writes times as RFC 2822, always UTC. */
export const bigCommerceRfc2822 = (iso: string) => new Date(iso).toUTCString().replace("GMT", "+0000");

export const bigCommerceProduct = fixtureBuilder<BigCommerceMockRecord>((n) => ({
  id: 100 + n,
  name: `Test 14K Ring ${n}`,
  type: "physical",
  sku: synthetic.sku(n),
  description: "<p>Synthetic description</p>",
  price: 1250 + n,
  cost_price: 600,
  is_visible: true,
  availability: "available",
  inventory_tracking: "variant",
  inventory_level: n,
  brand_id: 0,
  date_created: v3Time(at(n)),
  date_modified: v3Time(at(n)),
  variants: [{ id: 200 + n, product_id: 100 + n, sku: `${synthetic.sku(n)}-6`, price: null, calculated_price: 1250 + n, sale_price: null, inventory_level: n, option_values: [{ label: "6", option_display_name: "Ring Size" }] }],
}));

export const bigCommerceInventoryItem = fixtureBuilder<BigCommerceMockRecord>((n) => ({
  identity: { sku: `${synthetic.sku(n)}-6`, variant_id: 200 + n, product_id: 100 + n, sku_id: 300 + n },
  locations: [
    {
      location_id: 1,
      location_code: "BC-LOCATION-1",
      location_name: "Test Store Front",
      available_to_sell: n,
      total_inventory_onhand: n,
      qty_backordered: 0,
      location_enabled: true,
      settings: { safety_stock: 0, is_in_stock: true, warning_level: 0, bin_picking_number: "", backorder_limit: null, backorder_message: "" },
    },
  ],
}));

export const bigCommerceCustomer = fixtureBuilder<BigCommerceMockRecord>((n) => ({
  id: n,
  email: synthetic.email(n),
  first_name: "Test",
  last_name: `Customer ${n}`,
  company: "Synthetic Jewelers Co",
  phone: synthetic.phone(n),
  notes: "Synthetic note about ring size",
  registration_ip_address: `192.0.2.${n}`,
  customer_group_id: 1,
  tax_exempt_category: "",
  accepts_product_review_abandoned_cart_emails: true,
  channel_ids: [1],
  origin_channel_id: 1,
  address_count: 1,
  attribute_count: 0,
  authentication: { force_password_reset: false },
  date_created: v3Time(at(n)),
  date_modified: v3Time(at(n + 1)),
}));

export const bigCommerceOrderLine = fixtureBuilder<BigCommerceMockRecord>((n) => ({
  id: 500 + n,
  order_id: 0,
  product_id: 100 + n,
  variant_id: 200 + n,
  sku: `${synthetic.sku(n)}-6`,
  name: `Test 14K Ring ${n}`,
  name_customer: `Test 14K Ring ${n}`,
  quantity: 1,
  base_price: "1250.0000",
  price_inc_tax: "1250.0000",
  total_inc_tax: "1200.0000",
  applied_discounts: [{ id: "coupon", amount: "50.0000", name: "Synthetic coupon", code: "TEST" }],
  quantity_refunded: 0,
  refund_amount: "0.0000",
  product_options: [{ display_name: "Engraving", display_value: "Synthetic engraving" }],
}));

export const bigCommerceOrder = fixtureBuilder<BigCommerceMockRecord>((n) => ({
  id: 1000 + n,
  customer_id: 1,
  date_created: bigCommerceRfc2822(at(n)),
  date_modified: bigCommerceRfc2822(at(n + 2)),
  status_id: 10,
  status: "Completed",
  custom_status: "Completed",
  total_ex_tax: "1200.0000",
  total_inc_tax: "1200.0000",
  refunded_amount: "0.0000",
  currency_code: "USD",
  payment_method: "Credit Card",
  order_source: "www",
  channel_id: 1,
  is_deleted: false,
  ip_address: `192.0.2.${n}`,
  customer_message: "Synthetic gift message",
  staff_notes: "Synthetic staff note",
  billing_address: { first_name: "Test", last_name: `Customer ${n}`, street_1: `${n} Test Street`, city: "Testville", zip: "00000", country: "United States", email: synthetic.email(n), phone: synthetic.phone(n) },
  lines: [{ ...bigCommerceOrderLine.one(), order_id: 1000 + n }],
  refunds: [],
}));

export const bigCommerceRefund = fixtureBuilder<BigCommerceMockRecord>((n) => ({
  id: 700 + n,
  order_id: 1001,
  user_id: 1,
  created: v3Time(at(n + 10)),
  reason: "Synthetic reason: the customer changed their mind",
  total_amount: 50,
  total_tax: 0,
  uses_merchant_override_values: false,
  items: [{ item_type: "PRODUCT", item_id: 501, reason: "Synthetic item reason", quantity: 1, requested_amount: "50.00" }],
  payments: [{ id: 800 + n, provider_id: "testgateway", amount: 50, offline: false, is_declined: false, declined_message: "" }],
}));

export const bigCommercePriceList = fixtureBuilder<BigCommerceMockRecord>((n) => ({
  id: n,
  name: `Wholesale Tier ${n}`,
  active: true,
  date_created: v3Time(at(n)),
  date_modified: v3Time(at(n)),
}));

export const bigCommercePriceRecord = fixtureBuilder<BigCommerceMockRecord>((n) => ({
  price_list_id: 1,
  variant_id: 200 + n,
  product_id: 100 + n,
  sku: `${synthetic.sku(n)}-6`,
  currency: "usd",
  price: 900 + n,
  sale_price: null,
  retail_price: 1250,
  map_price: null,
  calculated_price: 900 + n,
  date_created: v3Time(at(n)),
  date_modified: v3Time(at(n)),
  bulk_pricing_tiers: [{ quantity_min: 5, quantity_max: 9, type: "percent", amount: 5 }],
}));

const problem = (status: number, title: string): DocMockResponse => ({ status, body: { status, title, type: "https://developer.bigcommerce.com/api-docs/getting-started/api-status-codes" } });
const v2Error = (status: number, message: string): DocMockResponse => ({ status, body: [{ status, message }] });
const time = (value: unknown) => (typeof value === "string" ? Date.parse(value) : Number.NaN);

/** page and limit, as the docs give their defaults; null when out of range. */
function paging(q: URLSearchParams): { page: number; limit: number } | null {
  const page = Number(q.get("page") ?? "1");
  const limit = Number(q.get("limit") ?? "50");
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return null;
  return { page, limit };
}

/** A v3 list page with meta.pagination. */
function v3List(rows: BigCommerceMockRecord[], q: URLSearchParams): DocMockResponse {
  const p = paging(q);
  if (!p) return problem(422, "page and limit must be whole numbers, limit at most 250");
  const data = rows.slice((p.page - 1) * p.limit, p.page * p.limit);
  const total_pages = Math.max(1, Math.ceil(rows.length / p.limit));
  return { status: 200, body: { data, meta: { pagination: { total: rows.length, count: data.length, per_page: p.limit, current_page: p.page, total_pages, links: { current: `?page=${p.page}&limit=${p.limit}` } } } } };
}

/** Filters on `date_modified:min`, inclusive as documented. Undefined rows means the value was unreadable. */
function modifiedSince(rows: BigCommerceMockRecord[], value: string | null): BigCommerceMockRecord[] | undefined {
  if (value === null) return rows;
  const from = time(value);
  if (Number.isNaN(from)) return undefined;
  return rows.filter((r) => time(r.date_modified) >= from);
}

/** Sorts by a field, ties broken by ID, as a database would. */
function sortBy(rows: BigCommerceMockRecord[], field: string, descending: boolean): BigCommerceMockRecord[] {
  const key = (r: BigCommerceMockRecord) => (field.startsWith("date_") ? time(r[field]) : Number(r[field]));
  return [...rows].sort((a, b) => (key(a) - key(b) || Number(a.id) - Number(b.id)) * (descending ? -1 : 1));
}

const ORDER_SORTS = ["id", "customer_id", "date_created", "date_modified", "status_id", "channel_id", "external_id"];
const CUSTOMER_SORTS = ["date_created:asc", "date_created:desc", "last_name:asc", "last_name:desc", "date_modified:asc", "date_modified:desc"];
const PRODUCT_SORTS = ["id", "name", "sku", "price", "date_modified", "date_last_imported", "inventory_level", "is_visible", "total_sold", "calculated_price"];

export interface BigCommerceMock {
  api: DocMock;
  fetch: DocMockFetch;
}

export function bigCommerceDocMock(data: BigCommerceMockData): BigCommerceMock {
  const limits = [...(data.rateLimits ?? [])];
  const quota = data.quota ?? BIGCOMMERCE_MOCK_QUOTA;
  let left = quota;

  /** Checks the token and serves the rate limit. Returns the response to send instead, or the headers to add. */
  function gate(request: DocMockRequest): { denied: DocMockResponse } | { headers: Record<string, string> } {
    if (request.headers.get("x-auth-token") !== data.token) return { denied: problem(401, "You are not authorized to access this resource.") };
    const queued = limits.shift();
    if (queued) return { denied: { ...problem(429, "Too many requests"), headers: queued.resetMs === undefined ? {} : { "x-rate-limit-time-reset-ms": String(queued.resetMs) } } };
    // The mock has no clock: a request after the quota ran out is taken to come after the window reset.
    if (left <= 0) left = quota;
    left--;
    return {
      headers: {
        "x-rate-limit-time-window-ms": String(WINDOW_MS),
        "x-rate-limit-time-reset-ms": String(WINDOW_MS - 1),
        "x-rate-limit-requests-quota": String(quota),
        "x-rate-limit-requests-left": String(left),
      },
    };
  }

  /** Wraps a route's answer with the auth check and rate-limit headers. */
  const guarded = (respond: (request: DocMockRequest, params: Record<string, string>) => DocMockResponse) => (request: DocMockRequest, params: Record<string, string>): DocMockResponse => {
    const g = gate(request);
    if ("denied" in g) return g.denied;
    const response = respond(request, params);
    return { ...response, headers: { ...g.headers, ...response.headers } };
  };

  const served = (order: BigCommerceMockRecord) => {
    const { lines: _lines, refunds: _refunds, ...rest } = order;
    return { ...rest, products: { url: `${BIGCOMMERCE_MOCK_BASE}/v2/orders/${String(order.id)}/products`, resource: `/orders/${String(order.id)}/products` } };
  };
  const findOrder = (id: string | undefined) => (data.orders ?? []).find((o) => String(o.id) === id);

  const api = checkDocMock({
    integration: "bigcommerce",
    baseUrl: BIGCOMMERCE_MOCK_BASE,
    source: { url: `${DOCS}/docs/overview/api-fundamentals/api-accounts`, title: "API accounts and OAuth scopes", retrievedOn: "2026-10-22", version: "v2 and v3" },
    assumptions: [
      "v2 lists answer 204 No Content when a page has no records",
      "GET /v2/orders accepts sort=date_modified:asc (the docs collapse the sort values) and limit up to 250",
      "v3 catalog, customers, inventory and price list paths accept limit up to 250",
      "GET /v2/orders lists only orders that are not deleted (archived)",
      "Products with include=variants carry every variant of each product",
      "date_modified:min and min_date_modified are inclusive, to the second",
      "Price list records come back in a stable order (by variant), so paging by number is safe while records change",
      "Price list records carry sku only when include=sku is sent",
      "X-Rate-Limit-Time-Reset-Ms is the time until the window resets (the docs describe it two ways)",
      "No endpoint reports a store-level token's OAuth scopes",
    ],
    routes: [
      {
        method: "GET",
        path: "/v2/store",
        documentedAt: `${REF}/management/store-information/v2/get-store-information`,
        respond: guarded(() => ({ status: 200, body: { id: BIGCOMMERCE_TEST_STORE_HASH, store_id: BIGCOMMERCE_TEST_STORE_ID, name: "Synthetic Test Jewelers", domain: "teststore.example.test", currency: "USD", timezone: { name: "America/Chicago" }, admin_email: "owner@example.test", ...data.store } })),
      },
      {
        method: "GET",
        path: "/v2/orders",
        documentedAt: `${REF}/management/orders/get-orders`,
        respond: guarded((request) => {
          const q = request.url.searchParams;
          const p = paging(q);
          if (!p) return v2Error(400, "page and limit must be whole numbers, limit at most 250");
          let rows = (data.orders ?? []).filter((o) => o.is_deleted !== true);
          const min = q.get("min_date_modified");
          if (min !== null) {
            const from = time(min);
            if (Number.isNaN(from)) return v2Error(400, "The field 'min_date_modified' is invalid.");
            rows = rows.filter((o) => time(o.date_modified) >= from);
          }
          const [field, direction = "asc"] = (q.get("sort") ?? "id:asc").split(":");
          if (!ORDER_SORTS.includes(field ?? "") || (direction !== "asc" && direction !== "desc")) return v2Error(400, "The field 'sort' is invalid.");
          const page = sortBy(rows, field!, direction === "desc").slice((p.page - 1) * p.limit, p.page * p.limit).map(served);
          return page.length ? { status: 200, body: page } : { status: 204, body: undefined };
        }),
      },
      {
        method: "GET",
        path: "/v2/orders/{order_id}/products",
        documentedAt: `${REF}/management/orders/order-products/get-order-products`,
        respond: guarded((request, params) => {
          const order = findOrder(params.order_id);
          if (!order) return v2Error(404, "The requested resource was not found.");
          const p = paging(request.url.searchParams);
          if (!p) return v2Error(400, "page and limit must be whole numbers, limit at most 250");
          const page = ((order.lines as BigCommerceMockRecord[] | undefined) ?? []).slice((p.page - 1) * p.limit, p.page * p.limit);
          return page.length ? { status: 200, body: page } : { status: 204, body: undefined };
        }),
      },
      {
        method: "GET",
        path: "/v3/orders/{order_id}/payment_actions/refunds",
        documentedAt: `${REF}/management/order-operations/payment-actions/get-order-refunds`,
        respond: guarded((_request, params) => {
          const order = findOrder(params.order_id);
          if (!order) return problem(404, "Order not found");
          return { status: 200, body: { data: (order.refunds as BigCommerceMockRecord[] | undefined) ?? [], meta: {} } };
        }),
      },
      {
        method: "GET",
        path: "/v3/catalog/products",
        documentedAt: `${REF}/catalog/products/get-products`,
        respond: guarded((request) => {
          const q = request.url.searchParams;
          const rows = modifiedSince(data.products ?? [], q.get("date_modified:min"));
          if (!rows) return problem(422, "date_modified:min is not a valid date");
          const field = q.get("sort") ?? "id";
          const direction = q.get("direction") ?? "asc";
          if (!PRODUCT_SORTS.includes(field) || (direction !== "asc" && direction !== "desc")) return problem(422, "sort or direction is not valid");
          const variants = (q.get("include") ?? "").split(",").includes("variants");
          return v3List(sortBy(rows, field, direction === "desc").map(({ variants: v, ...p }) => (variants ? { ...p, variants: v ?? [] } : p)), q);
        }),
      },
      {
        method: "GET",
        path: "/v3/inventory/items",
        documentedAt: `${REF}/management/inventory/items/get-inventory-items`,
        respond: guarded((request) => v3List(data.inventory ?? [], request.url.searchParams)),
      },
      {
        method: "GET",
        path: "/v3/customers",
        documentedAt: `${REF}/management/customers/v3/get-customers`,
        respond: guarded((request) => {
          const q = request.url.searchParams;
          const rows = modifiedSince(data.customers ?? [], q.get("date_modified:min"));
          if (!rows) return problem(422, "date_modified:min is not a valid date");
          const sort = q.get("sort");
          if (sort !== null && !CUSTOMER_SORTS.includes(sort)) return problem(422, "sort is not valid");
          const [field, direction] = (sort ?? "date_created:asc").split(":");
          return v3List(sortBy(rows, field!, direction === "desc"), q);
        }),
      },
      {
        method: "GET",
        path: "/v3/pricelists",
        documentedAt: `${REF}/management/price-lists/get-price-lists`,
        respond: guarded((request) => v3List(sortBy(data.priceLists ?? [], "id", false), request.url.searchParams)),
      },
      {
        method: "GET",
        path: "/v3/pricelists/{price_list_id}/records",
        documentedAt: `${REF}/management/price-lists/price-lists-records/get-price-list-records`,
        respond: guarded((request, params) => {
          if (!(data.priceLists ?? []).some((l) => String(l.id) === params.price_list_id)) return problem(404, "Price list not found");
          const q = request.url.searchParams;
          const ofList = (data.priceListRecords ?? []).filter((r) => String(r.price_list_id) === params.price_list_id);
          const rows = modifiedSince(ofList, q.get("date_modified:min"));
          if (!rows) return problem(422, "date_modified:min is not a valid date");
          const sku = (q.get("include") ?? "").split(",").includes("sku");
          const ordered = [...rows].sort((a, b) => Number(a.variant_id) - Number(b.variant_id));
          return v3List(ordered.map(({ sku: s, ...r }) => (sku ? { ...r, sku: s } : r)), q);
        }),
      },
    ],
  });

  return { api, fetch: docMockFetch(api) };
}

export default {
  integration: "bigcommerce",
  covers: "BigCommerce's v2 order and store paths and v3 catalog, inventory, customer, refund and price list paths",
  watchPages: [
    "https://docs.bigcommerce.com/developer/docs/overview/api-fundamentals/api-accounts",
    "https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/store-information/v2/get-store-information",
    "https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/orders/get-orders",
    "https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/orders/order-products/get-order-products",
    "https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/order-operations/payment-actions/get-order-refunds",
    "https://docs.bigcommerce.com/developer/api-reference/rest/admin/catalog/products/get-products",
    "https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/inventory/items/get-inventory-items",
    "https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/customers/v3/get-customers",
    "https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/price-lists/get-price-lists",
    "https://docs.bigcommerce.com/developer/api-reference/rest/admin/management/price-lists/price-lists-records/get-price-list-records",
  ],
  docMocks: () => [bigCommerceDocMock({ token: "" }).api],
} satisfies DocMockModule;
