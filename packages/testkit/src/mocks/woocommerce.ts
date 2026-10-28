import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockRequest, type DocMockResponse, type DocMockModule } from "../doc-mock.js";

/**
 * A WooCommerce store's REST API (v3) read endpoints, built from the
 * WooCommerce REST API docs. It checks Basic auth and the key's permission
 * as WooCommerce does, pages with `page` and `per_page` (at most 100) and
 * sends `X-WP-Total` and `X-WP-TotalPages`. The store's clock runs five
 * hours behind GMT, so local and `_gmt` times differ as on a real store.
 * Data is synthetic, and carries the personal data a real store would, so
 * tests can check none of it is kept. A WooCommerce test store replaces
 * this mock once one is set up.
 */
const DEV = "https://developer.woocommerce.com/docs/apis/rest-api/v3";
export const WOOCOMMERCE_MOCK_STORE = "https://woo-sandbox.example.test";
/** The mock store's time zone, as minutes from GMT. */
export const WOOCOMMERCE_MOCK_UTC_OFFSET_MINUTES = -300;

export type WooMockRecord = Record<string, unknown>;
export type WooKeyPermission = "read" | "write" | "read_write";

export interface WooCommerceMockData {
  /** REST API keys the store accepts, by consumer key. */
  keys?: Record<string, { secret: string; permissions: WooKeyPermission }>;
  orders?: WooMockRecord[];
  products?: WooMockRecord[];
  /** Variations by parent product ID. */
  variations?: Record<number, WooMockRecord[]>;
  customers?: WooMockRecord[];
  /** Refunds; each one's parent_id is its order. */
  refunds?: WooMockRecord[];
  /** 429s to answer before the next reads, in order, with the Retry-After to send if any. */
  rateLimits?: { retryAfter?: number }[];
  /** Answers with a redirect to this address instead, as a store behind a misconfigured proxy does. */
  redirectTo?: string;
  /** Leaves out X-WP-TotalPages, as some caching proxies do. */
  dropTotalHeaders?: boolean;
}

/** A GMT time and the mock store's local time for it, as WooCommerce writes them (no zone suffix). */
export function wooTimes(isoGmt: string): { gmt: string; local: string } {
  const ms = Date.parse(isoGmt);
  return { gmt: new Date(ms).toISOString().slice(0, 19), local: new Date(ms + WOOCOMMERCE_MOCK_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 19) };
}

/** Both forms of a time field, e.g. date_modified and date_modified_gmt. */
export function wooDates(field: string, isoGmt: string): WooMockRecord {
  const t = wooTimes(isoGmt);
  return { [field]: t.local, [`${field}_gmt`]: t.gmt };
}

const at = (minutes: number) => synthetic.isoTime(minutes);
const address = (n: number) => ({
  first_name: "Test",
  last_name: `Customer ${n}`,
  company: "",
  address_1: `${n} Test Street`,
  address_2: "",
  city: "Testville",
  state: "NY",
  postcode: "00000",
  country: "US",
  email: synthetic.email(n),
  phone: synthetic.phone(n),
});

export const wooOrder = fixtureBuilder<WooMockRecord>((n) => ({
  id: 1000 + n,
  parent_id: 0,
  number: String(1000 + n),
  order_key: `wc_order_test${n}`,
  created_via: "checkout",
  version: "10.2.0",
  status: "completed",
  currency: "USD",
  ...wooDates("date_created", at(n * 10)),
  ...wooDates("date_modified", at(n * 10 + 5)),
  ...wooDates("date_paid", at(n * 10 + 1)),
  ...wooDates("date_completed", at(n * 10 + 4)),
  discount_total: "50.00",
  shipping_total: "0.00",
  total_tax: "0.00",
  total: "1200.00",
  prices_include_tax: false,
  customer_id: 1,
  customer_ip_address: "192.0.2.10",
  customer_user_agent: "Mozilla/5.0 (synthetic test browser)",
  customer_note: "Synthetic note: please size to 6",
  billing: address(n),
  shipping: { ...address(n), email: undefined },
  payment_method: "stripe",
  payment_method_title: "Credit card",
  transaction_id: `txn-test-${n}`,
  cart_hash: `cart-test-${n}`,
  meta_data: [{ id: n, key: "_synthetic_meta", value: "Synthetic gift message" }],
  line_items: [
    {
      id: 5000 + n,
      name: `Test 14K Ring ${n}`,
      product_id: 100 + n,
      variation_id: 0,
      quantity: 1,
      tax_class: "",
      subtotal: "1250.00",
      subtotal_tax: "0.00",
      total: "1200.00",
      total_tax: "0.00",
      sku: synthetic.sku(n),
      price: 1200,
      meta_data: [{ id: n, key: "Engraving", value: "Synthetic engraving" }],
    },
  ],
  refunds: [],
}));

export const wooProduct = fixtureBuilder<WooMockRecord>((n) => ({
  id: 100 + n,
  name: `Test 14K Ring ${n}`,
  slug: `test-14k-ring-${n}`,
  type: "simple",
  status: "publish",
  description: "Synthetic description",
  sku: synthetic.sku(n),
  price: "1250.00",
  regular_price: "1250.00",
  sale_price: "",
  ...wooDates("date_created", at(n)),
  ...wooDates("date_modified", at(n + 1)),
  manage_stock: true,
  stock_quantity: n,
  stock_status: "instock",
  variations: [],
  categories: [{ id: 1, name: "Rings", slug: "rings" }],
  tags: [{ id: 1, name: "Bridal", slug: "bridal" }],
  meta_data: [],
}));

export const wooVariation = fixtureBuilder<WooMockRecord>((n) => ({
  id: 200 + n,
  sku: `${synthetic.sku(n)}-V`,
  status: "publish",
  price: "980.00",
  regular_price: "980.00",
  sale_price: "",
  ...wooDates("date_created", at(n)),
  ...wooDates("date_modified", at(n + 2)),
  manage_stock: true,
  stock_quantity: 2,
  stock_status: "instock",
  attributes: [{ id: 0, name: "Size", option: "6" }],
  meta_data: [],
}));

export const wooCustomer = fixtureBuilder<WooMockRecord>((n) => ({
  id: n,
  ...wooDates("date_created", at(n * 3)),
  ...wooDates("date_modified", at(n * 3 + 1)),
  email: synthetic.email(n),
  first_name: "Test",
  last_name: `Customer ${n}`,
  role: "customer",
  username: `testcustomer${n}`,
  billing: address(n),
  shipping: address(n),
  is_paying_customer: true,
  avatar_url: "https://avatar.example.test/synthetic.png",
  meta_data: [{ id: n, key: "ring_size", value: "6" }],
}));

export const wooRefund = fixtureBuilder<WooMockRecord>((n) => ({
  id: 9000 + n,
  parent_id: 1000 + n,
  ...wooDates("date_created", at(n * 10 + 7)),
  amount: "50.00",
  reason: "Synthetic reason: the customer changed their mind",
  refunded_by: 1,
  refunded_payment: true,
  meta_data: [],
  line_items: [
    {
      id: 6000 + n,
      name: `Test 14K Ring ${n}`,
      product_id: 100 + n,
      variation_id: 0,
      quantity: -1,
      tax_class: "",
      subtotal: "-50.00",
      subtotal_tax: "0.00",
      total: "-50.00",
      total_tax: "0.00",
      sku: synthetic.sku(n),
      price: -50,
      meta_data: [{ id: n, key: "_refunded_item_id", value: String(5000 + n) }],
    },
  ],
}));

const error = (status: number, code: string, message: string): DocMockResponse => ({ status, body: { code, message, data: { status } } });
const badParam = (name: string) => error(400, "rest_invalid_param", `Invalid parameter(s): ${name}`);
const ms = (t: unknown) => (typeof t === "string" ? Date.parse(`${t.slice(0, 19)}Z`) : Number.NaN);
const ISO_PARAM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

export interface WooCommerceMock {
  api: DocMock;
  fetch: DocMockFetch;
}

export function wooCommerceDocMock(data: WooCommerceMockData): WooCommerceMock {
  const limits = [...(data.rateLimits ?? [])];

  /** Basic auth and the key's permission, then queued rate limits. Undefined means go on. */
  function gate(request: DocMockRequest): DocMockResponse | undefined {
    const header = /^Basic ([A-Za-z0-9+/]+=*)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const [key, secret] = header ? Buffer.from(header, "base64").toString("utf8").split(":") : [];
    const found = key ? data.keys?.[key] : undefined;
    if (!found) return error(401, "woocommerce_rest_authentication_error", "Consumer key is invalid.");
    if (found.secret !== secret) return error(401, "woocommerce_rest_authentication_error", "Consumer secret is invalid.");
    // Checked on rest_pre_dispatch, by method, as WooCommerce does.
    if (found.permissions !== "read" && found.permissions !== "read_write") return error(401, "woocommerce_rest_authentication_error", "The API key provided does not have read permissions.");
    const limit = limits.shift();
    if (limit) return { status: 429, body: { code: "too_many_requests", message: "Too many requests" }, headers: limit.retryAfter ? { "retry-after": String(limit.retryAfter) } : {} };
    if (data.redirectTo) return { status: 301, body: null, headers: { location: data.redirectTo } };
    return undefined;
  }

  /** Sorting, then `page` and `per_page`, with the WordPress total headers. */
  function list(request: DocMockRequest, rows: WooMockRecord[], orderbys: Record<string, (r: WooMockRecord) => number | string>, defaults: { orderby: string; order: "asc" | "desc"; posts?: boolean }): DocMockResponse {
    const q = request.url.searchParams;
    const perPage = q.has("per_page") ? Number(q.get("per_page")) : 10;
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) return badParam("per_page");
    const page = q.has("page") ? Number(q.get("page")) : 1;
    if (!Number.isInteger(page) || page < 1) return badParam("page");
    const order = q.get("order") ?? defaults.order;
    if (order !== "asc" && order !== "desc") return badParam("order");
    const orderby = q.get("orderby") ?? defaults.orderby;
    const key = Object.hasOwn(orderbys, orderby) ? orderbys[orderby] : undefined;
    if (!key) return badParam("orderby");
    const sorted = [...rows].sort((a, b) => {
      const x = key(a);
      const y = key(b);
      const c = x < y ? -1 : x > y ? 1 : Number(a.id) - Number(b.id);
      return order === "asc" ? c : -c;
    });
    const totalPages = Math.ceil(sorted.length / perPage);
    if (defaults.posts !== false && page > Math.max(totalPages, 1)) return error(400, "rest_post_invalid_page_number", "The page number requested is larger than the number of pages available.");
    const headers: Record<string, string> = data.dropTotalHeaders ? {} : { "x-wp-total": String(sorted.length), "x-wp-totalpages": String(totalPages) };
    return { status: 200, body: sorted.slice((page - 1) * perPage, page * perPage), headers };
  }

  /** `after` / `modified_after` filters: exclusive, on local time unless dates_are_gmt. */
  function since(request: DocMockRequest, rows: WooMockRecord[], param: string, field: string, gmtAllowed: boolean): WooMockRecord[] | DocMockResponse {
    const q = request.url.searchParams;
    if (!q.has(param)) return rows;
    const value = q.get(param)!;
    if (!ISO_PARAM.test(value)) return badParam(param);
    const gmt = gmtAllowed && q.get("dates_are_gmt") === "true";
    const from = ms(value);
    return rows.filter((r) => ms(r[gmt ? `${field}_gmt` : field]) > from);
  }

  const status = (request: DocMockRequest, rows: WooMockRecord[], allowed: string[]) => {
    const s = request.url.searchParams.get("status") ?? "any";
    if (s !== "any" && !allowed.includes(s)) return badParam("status");
    // "any" leaves out the trash, as WordPress does.
    return s === "any" ? rows.filter((r) => r.status !== "trash") : rows.filter((r) => r.status === s);
  };
  const isResponse = (v: unknown): v is DocMockResponse => !Array.isArray(v);
  const byTime = (field: string) => (r: WooMockRecord) => ms(r[field]);

  const api = checkDocMock({
    integration: "woocommerce",
    baseUrl: `${WOOCOMMERCE_MOCK_STORE}/wp-json/wc/v3`,
    source: { url: "https://woocommerce.github.io/woocommerce-rest-api-docs/", title: "WooCommerce REST API documentation", retrievedOn: "2026-10-22", version: "v3" },
    auth: "basic",
    assumptions: [
      "modified_after and after are exclusive, and compare to the second",
      "orderby=modified sorts on the same date the modified_after filter uses, and ties fall back to ID order",
      "The store-wide refunds list (GET /refunds) exists on the store's WooCommerce version; older ones answer 404 rest_no_route",
      "The refunds list's after filter uses the store's local creation time; dates_are_gmt isn't documented there, so the mock ignores it",
      "per_page above 100 is refused with rest_invalid_param, as WordPress caps collections at 100",
      "A page past the last answers 400 rest_post_invalid_page_number for orders, products, variations and refunds, as WordPress posts do, and an empty list for customers, as WordPress users do",
      "X-WP-TotalPages is sent on every list, orders, refunds and variations included",
      "Customers with role=all include every registered user who placed an order",
      "A variation's own stock change may not move its product's date_modified",
      "status=any leaves out trashed orders and products",
    ],
    routes: [
      {
        method: "GET",
        path: "/orders",
        documentedAt: `${DEV}/orders/`,
        respond(request) {
          const denied = gate(request);
          if (denied) return denied;
          const rows = status(request, data.orders ?? [], ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "trash"]);
          if (isResponse(rows)) return rows;
          const filtered = since(request, rows, "modified_after", "date_modified", true);
          if (isResponse(filtered)) return filtered;
          return list(request, filtered, { date: byTime("date_created_gmt"), modified: byTime("date_modified_gmt"), id: (r) => Number(r.id) }, { orderby: "date", order: "desc" });
        },
      },
      {
        method: "GET",
        path: "/products",
        documentedAt: `${DEV}/products/`,
        respond(request) {
          const denied = gate(request);
          if (denied) return denied;
          const rows = status(request, data.products ?? [], ["draft", "pending", "private", "publish"]);
          if (isResponse(rows)) return rows;
          const filtered = since(request, rows, "modified_after", "date_modified", true);
          if (isResponse(filtered)) return filtered;
          return list(request, filtered, { date: byTime("date_created_gmt"), modified: byTime("date_modified_gmt"), id: (r) => Number(r.id), title: (r) => String(r.name) }, { orderby: "date", order: "desc" });
        },
      },
      {
        method: "GET",
        path: "/products/{id}/variations",
        documentedAt: `${DEV}/product-variations/`,
        respond(request, params) {
          const denied = gate(request);
          if (denied) return denied;
          const product = (data.products ?? []).find((p) => String(p.id) === params.id);
          if (!product) return error(404, "woocommerce_rest_product_invalid_id", "Invalid ID.");
          return list(request, data.variations?.[Number(params.id)] ?? [], { date: byTime("date_created_gmt"), modified: byTime("date_modified_gmt"), id: (r) => Number(r.id) }, { orderby: "date", order: "desc" });
        },
      },
      {
        method: "GET",
        path: "/customers",
        documentedAt: `${DEV}/customers/`,
        respond(request) {
          const denied = gate(request);
          if (denied) return denied;
          const role = request.url.searchParams.get("role") ?? "customer";
          const rows = (data.customers ?? []).filter((c) => role === "all" || c.role === role);
          return list(request, rows, { id: (r) => Number(r.id), name: (r) => `${r.first_name} ${r.last_name}`, registered_date: byTime("date_created_gmt") }, { orderby: "name", order: "asc", posts: false });
        },
      },
      {
        method: "GET",
        path: "/refunds",
        documentedAt: `${DEV}/refunds/`,
        respond(request) {
          const denied = gate(request);
          if (denied) return denied;
          const filtered = since(request, data.refunds ?? [], "after", "date_created", false);
          if (isResponse(filtered)) return filtered;
          return list(request, filtered, { date: byTime("date_created"), id: (r) => Number(r.id) }, { orderby: "date", order: "desc" });
        },
      },
    ],
  });

  return { api, fetch: docMockFetch(api) };
}

export default {
  integration: "woocommerce",
  covers: "A WooCommerce store's REST API v3 read endpoints with its key permissions and page headers",
  watchPages: [
    "https://woocommerce.github.io/woocommerce-rest-api-docs/",
    "https://developer.woocommerce.com/docs/apis/rest-api/v3/orders/",
    "https://developer.woocommerce.com/docs/apis/rest-api/v3/products/",
    "https://developer.woocommerce.com/docs/apis/rest-api/v3/product-variations/",
    "https://developer.woocommerce.com/docs/apis/rest-api/v3/customers/",
    "https://developer.woocommerce.com/docs/apis/rest-api/v3/refunds/",
  ],
  docMocks: () => [wooCommerceDocMock({}).api],
} satisfies DocMockModule;
