import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * The Whatnot Seller API (REST v2) list endpoints a read-only connector
 * uses, built from Whatnot's developer docs. Data is synthetic. Whatnot's
 * REST API has no sandbox; once a seller's token is set up, recordings
 * replace this mock.
 *
 * Docs facts the mock relies on:
 * - Base URL https://api.whatnot.com/seller-api/rest/v2, with
 *   `Authorization: Bearer <token>`; personal access tokens start
 *   wn_pat_tk_ and OAuth app tokens wn_access_tk_ (getting-started/introduction,
 *   getting-started/authentication).
 * - `GET /orders`, `GET /orders/{order_id}/items`, `GET /products` and
 *   `GET /products/{product_id}/variants` each take only limit (1 to 50,
 *   10 by default), cursor (at most 2048 characters) and reverse (true by
 *   default: newest first), and answer {data, next_cursor}, next_cursor null
 *   after the last page. An order id matches ^[1-9][0-9]{0,18}$ (api-reference
 *   tag pages for orders and products).
 * - The order endpoints need read:orders. An Order has id, status (pending,
 *   pending_fulfillment, completed, cancelled, failed), transaction_type,
 *   created_at, updated_at, cancelled_at, show_id, buyer, amounts and url;
 *   Money is {amount: "49.77", currency} in major units (api-reference/models).
 * - An OrderItem has id, order_id, product_id, variant_id, quantity,
 *   unit_price, purchased_item {sku, title, description} and more; a
 *   ProductVariant has id, product_id, sku, price and inventory
 *   {available_quantity}.
 * - Errors are problem details {type, title, status, detail}; 401 is
 *   unauthenticated, 403 missing-scope with required_scopes, 429
 *   rate-limited with Retry-After; a bad query parameter answers 422 as
 *   {detail: [{loc, msg, type}]} (errors, getting-started/rate-limits).
 */
const BASE = "https://api.whatnot.com/seller-api/rest/v2";
const REF = "https://developers.whatnot.com/api-reference/tag";
export const WHATNOT_DOC_PAGES = {
  orders: `${REF}/orders/get/orders`,
  orderItems: `${REF}/orders/get/orders/order_id/items`,
  products: `${REF}/products/get/products`,
  variants: `${REF}/products/get/products/product_id/variants`,
} as const;
const QUERY = new Set(["limit", "cursor", "reverse"]);
const ORDER_ID = /^[1-9][0-9]{0,18}$/;

export type WhatnotMockRecord = Record<string, unknown>;

const money = (amount: string) => ({ amount, currency: "USD" });

/** Order `n`: created `n` hours into 2026, completed, with one item (see whatnotOrderItem) and a buyer the connector must drop; odd orders sold in a live show. */
export const whatnotOrder = fixtureBuilder<WhatnotMockRecord>((n) => ({
  id: String(123400 + n),
  status: "completed",
  transaction_type: "auction",
  created_at: synthetic.isoTime(n * 60),
  updated_at: synthetic.isoTime(n * 60 + 30),
  cancelled_at: null,
  show_id: n % 2 === 1 ? `show-${n}` : null,
  buyer: { id: String(6700 + n), username: `buyer${n}`, display_name: synthetic.name(n) },
  amounts: {
    subtotal: money(String(40 + n)),
    shipping: money("5.99"),
    tax: money("3.78"),
    total: money(((4977 + n * 100) / 100).toFixed(2)),
    applied_discount: null,
  },
  url: `https://www.whatnot.com/dashboard/orders/test-${n}`,
}));

/** Line item `n`, for order `n`: one of the product `n` variant, at the order's subtotal. */
export const whatnotOrderItem = fixtureBuilder<WhatnotMockRecord>((n) => ({
  id: String(987600 + n),
  order_id: String(123400 + n),
  price_includes_tax: false,
  product_external_id: `ext-product-${n}`,
  product_id: String(12300 + n),
  purchased_item: { description: "A test description the connector must drop", sku: synthetic.sku(n), title: `Test ring ${n}` },
  quantity: 1,
  shipment_id: String(55500 + n),
  unit_price: money(String(40 + n)),
  variant_external_id: `ext-variant-${n}`,
  variant_id: `variant-${n}`,
}));

/** Product `n`, created `n` days into 2026. */
export const whatnotProduct = fixtureBuilder<WhatnotMockRecord>((n) => ({
  id: String(12300 + n),
  title: `Test ring ${n}`,
  description: "A test description the connector must drop",
  category: { id: "42", name: "Jewelry" },
  external_id: `ext-product-${n}`,
  media: [{ alt: "front", id: String(500 + n), url: `https://cdn.whatnot.com/i/test-${n}.jpg` }],
  options: [],
  attributes: [],
  created_at: synthetic.isoTime(n * 1440),
  updated_at: synthetic.isoTime(n * 1440 + 60),
  url: `https://www.whatnot.com/product/test-${n}`,
}));

/** Variant `n`, of product `n`, with `n` available. */
export const whatnotVariant = fixtureBuilder<WhatnotMockRecord>((n) => ({
  id: `variant-${n}`,
  product_id: String(12300 + n),
  sku: synthetic.sku(n),
  external_id: `ext-variant-${n}`,
  selected_options: [],
  price: money(`${40 + n}.50`),
  country_of_origin: "US",
  inventory: { available_quantity: n },
  media: [],
}));

export interface WhatnotMockData {
  token: string;
  /** The token's scopes. Defaults to read:orders and read:inventory. */
  scopes?: string[];
  orders?: WhatnotMockRecord[];
  items?: WhatnotMockRecord[];
  products?: WhatnotMockRecord[];
  variants?: WhatnotMockRecord[];
  /** 429s to answer before the next calls. */
  rateLimits?: number;
}

export interface WhatnotMock {
  mock: DocMock;
  fetch: DocMockFetch;
  /** Each list call answered with a page: its path, limit, direction and cursor. */
  readonly reads: { path: string; limit: number; reverse: boolean; cursor: string | null }[];
}

const problem = (status: number, type: string, title: string, detail: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): DocMockResponse => ({
  status,
  body: { type, title, status, detail, ...extra },
  headers: { "content-type": "application/problem+json", ...headers },
});
const invalid = (name: string, msg: string): DocMockResponse => ({ status: 422, body: { detail: [{ loc: ["query", name], msg, type: "value_error" }] } });
const encode = (path: string, offset: number) => Buffer.from(`${path}|${offset}`).toString("base64url");
function decode(path: string, cursor: string): number | null {
  const [p, n] = Buffer.from(cursor, "base64url").toString().split("|");
  return p === path && /^[1-9][0-9]{0,8}$/.test(n ?? "") ? Number(n) : null;
}
const byCreated = (a: WhatnotMockRecord, b: WhatnotMockRecord) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id));

export function whatnotDocMock(data: WhatnotMockData): WhatnotMock {
  const reads: WhatnotMock["reads"] = [];
  let limits = data.rateLimits ?? 0;
  const scopes = new Set(data.scopes ?? ["read:orders", "read:inventory"]);

  /** A list route: checks the token, its scope and the query, then pages `rows(params)`, null for a parent that isn't there. */
  function list(scope: string, rows: (params: Record<string, string>) => WhatnotMockRecord[] | DocMockResponse) {
    return (request: DocMockRequest, params: Record<string, string>): DocMockResponse => {
      if (request.headers.get("authorization") !== `Bearer ${data.token}`) return problem(401, "unauthenticated", "Unauthenticated", "A valid seller API token is required.");
      if (limits > 0) {
        limits--;
        return problem(429, "rate-limited", "Rate limited", "Rate limit exceeded", {}, { "retry-after": "1" });
      }
      if (!scopes.has(scope) && !scopes.has(scope.replace("read:", "write:"))) return problem(403, "missing-scope", "Missing scope", `This request requires ${scope}.`, { required_scopes: [scope] });
      const q = request.url.searchParams;
      const unknown = [...q.keys()].find((k) => !QUERY.has(k));
      if (unknown) return invalid(unknown, "Extra inputs are not permitted");
      const limit = q.get("limit") === null ? 10 : Number(q.get("limit"));
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return invalid("limit", "Input should be between 1 and 50");
      const reverse = q.get("reverse") ?? "true";
      if (reverse !== "true" && reverse !== "false") return invalid("reverse", "Input should be a valid boolean");
      const path = request.url.pathname.slice(new URL(BASE).pathname.length);
      const cursor = q.get("cursor");
      const offset = cursor === null ? 0 : cursor.length <= 2048 ? decode(path, cursor) : null;
      if (offset === null) return invalid("cursor", "Invalid cursor");
      const found = rows(params);
      if (!Array.isArray(found)) return found;
      reads.push({ path, limit, reverse: reverse === "true", cursor });
      const ordered = reverse === "true" ? [...found].reverse() : found;
      const next = offset + limit < ordered.length ? encode(path, offset + limit) : null;
      return { status: 200, body: { data: ordered.slice(offset, offset + limit), next_cursor: next } };
    };
  }

  const orders = () => [...(data.orders ?? [])].sort(byCreated);
  const products = () => [...(data.products ?? [])].sort(byCreated);
  const mock = checkDocMock({
    integration: "whatnot",
    baseUrl: BASE,
    source: { url: WHATNOT_DOC_PAGES.orders, title: "Whatnot Seller API reference: List orders", retrievedOn: "2026-11-11", version: "v2.0.0" },
    auth: "bearer",
    assumptions: [
      "Orders and products are listed in the order they were created, ties by id; the docs don't name the sort key",
      "A cursor is only good for the list and direction it came from",
      "The product and variant lists need read:inventory; their pages state no scope",
      "An order's items and a product's variants are listed in a stable order",
    ],
    routes: [
      { method: "GET", path: "/orders", documentedAt: WHATNOT_DOC_PAGES.orders, respond: list("read:orders", orders) },
      {
        method: "GET",
        path: "/orders/{order_id}/items",
        documentedAt: WHATNOT_DOC_PAGES.orderItems,
        respond: list("read:orders", ({ order_id }) => {
          if (!ORDER_ID.test(order_id ?? "")) return invalid("order_id", "String should match pattern '^[1-9][0-9]{0,18}$'");
          if (!(data.orders ?? []).some((o) => o.id === order_id)) return problem(404, "order-not-found", "Order not found", "Order not found.");
          return (data.items ?? []).filter((i) => i.order_id === order_id);
        }),
      },
      { method: "GET", path: "/products", documentedAt: WHATNOT_DOC_PAGES.products, respond: list("read:inventory", products) },
      {
        method: "GET",
        path: "/products/{product_id}/variants",
        documentedAt: WHATNOT_DOC_PAGES.variants,
        respond: list("read:inventory", ({ product_id }) => {
          if (!(data.products ?? []).some((p) => p.id === product_id)) return problem(404, "product-not-found", "Product not found", "Product not found.");
          return (data.variants ?? []).filter((v) => v.product_id === product_id);
        }),
      },
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
  integration: "whatnot",
  covers: "The Whatnot Seller API's order, order item, product and variant lists (REST v2), with bearer tokens, scopes, cursors and direction",
  watchPages: [WHATNOT_DOC_PAGES.orders, WHATNOT_DOC_PAGES.orderItems, WHATNOT_DOC_PAGES.products, WHATNOT_DOC_PAGES.variants],
  docMocks: () => [whatnotDocMock({ token: "" }).mock],
} satisfies DocMockModule;
