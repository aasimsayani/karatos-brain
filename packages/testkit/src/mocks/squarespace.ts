import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * A Squarespace site's Commerce APIs (Products v2, Inventory 1.0 and Orders
 * 1.0), built from Squarespace's developer reference. Data is synthetic.
 *
 * Docs facts the mock relies on:
 * - Requests go to api.squarespace.com with `Authorization: Bearer <key>`
 *   and a User-Agent; requests without a User-Agent are rejected.
 * - An API key holds a permission for each API: Orders, Inventory and
 *   Products can each be Read Only. A key without one is answered 403; a
 *   missing or invalid key 401.
 * - GET /v2/commerce/products answers `products` and GET
 *   /1.0/commerce/inventory answers `inventory`, up to 50 a page; GET
 *   /1.0/commerce/orders answers `result`, up to 50 orders by modifiedOn.
 *   Each has `pagination` with hasNextPage, nextPageCursor and nextPageUrl.
 * - `cursor` can't be used with any other parameter. modifiedAfter and
 *   modifiedBefore (ISO 8601 UTC) must be used together.
 * - Past 300 requests a minute Squarespace answers 429 for a minute.
 */
const DOCS = {
  orders: "https://developers.squarespace.com/commerce-apis/retrieve-all-orders",
  inventory: "https://developers.squarespace.com/commerce-apis/inventory",
  products: "https://developers.squarespace.com/commerce-apis/products",
} as const;
export const SQUARESPACE_DOC_PAGES = DOCS;

export type SquarespaceMockRecord = Record<string, unknown>;
const PAGE = 50;
const money = (value: number) => ({ currency: "USD", value });
const at = (n: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + n * 86_400_000).toISOString().replace(".000", "");
const hex = (prefix: string, n: number) => `${prefix}${String(n).padStart(24 - prefix.length, "0")}`;

/** A ring with two sizes, modified `n` days into October 2026. */
export const squarespaceProduct = fixtureBuilder<SquarespaceMockRecord>((n) => ({
  id: hex("a", n),
  type: "PHYSICAL",
  storePageId: hex("b", 1),
  name: "Test 14K solitaire setting",
  description: "<p>Test description</p>",
  url: `https://shop.example.test/store/p/test-ring-${n}`,
  urlSlug: `test-ring-${n}`,
  tags: ["test"],
  isVisible: true,
  createdOn: at(n - 1),
  modifiedOn: at(n),
  variants: [
    { id: hex("c", 2 * n - 1), sku: `SQ-RING-${n}-6`, pricing: { basePrice: money(1250.5), salePrice: money(0), onSale: false }, stock: { quantity: 3, unlimited: false }, attributes: { Size: "6" } },
    { id: hex("c", 2 * n), sku: `SQ-RING-${n}-7`, pricing: { basePrice: money(1250.5), salePrice: money(999.99), onSale: true }, stock: { quantity: 0, unlimited: true }, attributes: { Size: "7" } },
  ],
}));

/** A tracked stock line. */
export const squarespaceStock = fixtureBuilder<SquarespaceMockRecord>((n) => ({
  variantId: hex("c", n),
  sku: `SQ-RING-${n}`,
  descriptor: `Test 14K solitaire setting [Size: ${n}]`,
  isUnlimited: false,
  quantity: n % 4,
}));

/** A paid web order for one ring, modified `n` days into October 2026. */
export const squarespaceOrder = fixtureBuilder<SquarespaceMockRecord>((n) => ({
  id: hex("d", n),
  orderNumber: String(1000 + n),
  createdOn: at(n - 1),
  modifiedOn: at(n),
  channel: "web",
  testmode: false,
  customerId: hex("e", 1),
  customerEmail: "buyer@example.test",
  billingAddress: { firstName: "Test", lastName: "Buyer", address1: "1 Test St", city: "Testville", state: "NY", countryCode: "US", postalCode: "10001", phone: null },
  shippingAddress: { firstName: "Test", lastName: "Buyer", address1: "1 Test St", city: "Testville", state: "NY", countryCode: "US", postalCode: "10001", phone: null },
  fulfillmentStatus: "PENDING",
  lineItems: [{ id: hex("f", n), variantId: hex("c", 1), sku: "SQ-RING-1-6", productId: hex("a", 1), productName: "Test 14K solitaire setting", quantity: 1, unitPricePaid: money(1250.5), variantOptions: [{ optionName: "Size", value: "6" }], customizations: [{ label: "Engraving", value: "Test engraving" }], lineItemType: "PHYSICAL_PRODUCT" }],
  internalNotes: [{ content: "Test internal note" }],
  shippingLines: [],
  discountLines: [],
  formSubmission: [{ label: "Ring size", value: "6" }],
  fulfillments: [],
  subtotal: money(1250.5),
  shippingTotal: money(0),
  discountTotal: money(0),
  taxTotal: money(110.5),
  refundedTotal: money(0),
  grandTotal: money(1361),
  paymentState: "PAID",
  priceTaxInterpretation: "EXCLUSIVE",
}));

export interface SquarespaceMockData {
  apiKey: string;
  products?: SquarespaceMockRecord[];
  inventory?: SquarespaceMockRecord[];
  orders?: SquarespaceMockRecord[];
  /** The APIs the key holds Read Only permission for. Defaults to all three. */
  permissions?: ("Products" | "Inventory" | "Orders")[];
  /** 429s to answer before the next reads. */
  rateLimits?: number;
}

const error = (status: number, type: string, message: string): DocMockResponse => ({ status, body: { type, subtype: null, message, details: null, contextId: "TESTCONTEXT" } });
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DEFAULT_PAYMENT = new Set(["NOT_CHARGED", "AUTHORIZED", "PAID", "REFUNDED"]);

export interface SquarespaceMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each list read: its path and query. */
  readonly reads: { path: string; query: Record<string, string> }[];
}

export function squarespaceDocMock(data: SquarespaceMockData): SquarespaceMock {
  const reads: { path: string; query: Record<string, string> }[] = [];
  let limits = data.rateLimits ?? 0;
  const allowed = new Set(data.permissions ?? ["Products", "Inventory", "Orders"]);
  // A cursor names the list, the window it was made for and where the next page starts.
  const cursorOf = (path: string, offset: number, window: string) => Buffer.from(JSON.stringify([path, offset, window])).toString("base64url");
  const readCursor = (raw: string): [string, number, string] | null => {
    try {
      const v = JSON.parse(Buffer.from(raw, "base64url").toString()) as unknown;
      return Array.isArray(v) && v.length === 3 && typeof v[0] === "string" && Number.isInteger(v[1]) && typeof v[2] === "string" ? (v as [string, number, string]) : null;
    } catch {
      return null;
    }
  };
  const route = (path: string, permission: string, field: string, rows: () => SquarespaceMockRecord[], filtered: boolean, documentedAt: string) => ({
    method: "GET" as const,
    path,
    documentedAt,
    respond(request: { headers: Headers; url: URL }): DocMockResponse {
      if (request.headers.get("authorization") !== `Bearer ${data.apiKey}`) return error(401, "AUTHORIZATION_ERROR", "Unauthorized");
      if (!request.headers.get("user-agent")) return error(400, "INVALID_REQUEST_ERROR", "A User-Agent header is required");
      if (limits > 0) {
        limits--;
        return error(429, "TOO_MANY_REQUESTS", "Rate limit exceeded");
      }
      if (!allowed.has(permission)) return error(403, "AUTHORIZATION_ERROR", "Forbidden");
      const query = Object.fromEntries(request.url.searchParams);
      reads.push({ path, query });
      let offset = 0;
      let window = "";
      if (query.cursor !== undefined) {
        const c = readCursor(query.cursor);
        if (Object.keys(query).length !== 1 || !c || c[0] !== path) return error(400, "INVALID_REQUEST_ERROR", "Invalid cursor");
        [, offset, window] = c;
      } else if (filtered && (query.modifiedAfter !== undefined || query.modifiedBefore !== undefined)) {
        if (!UTC.test(query.modifiedAfter ?? "") || !UTC.test(query.modifiedBefore ?? "")) return error(400, "INVALID_REQUEST_ERROR", "modifiedAfter and modifiedBefore must be used together");
        window = `${query.modifiedAfter}|${query.modifiedBefore}`;
      } else if (Object.keys(query).length > 0) return error(400, "INVALID_REQUEST_ERROR", "Unknown parameter");
      const [after, before] = window ? window.split("|").map((t) => Date.parse(t!)) : [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
      const all = rows().filter((r) => !filtered || (DEFAULT_PAYMENT.has(String(r.paymentState)) && Date.parse(String(r.modifiedOn)) > after! && Date.parse(String(r.modifiedOn)) <= before!));
      const page = all.slice(offset, offset + PAGE);
      const more = offset + PAGE < all.length;
      const next = more ? cursorOf(path, offset + PAGE, window) : null;
      return { status: 200, body: { [field]: page, pagination: { hasNextPage: more, nextPageCursor: next, nextPageUrl: next && `https://api.squarespace.com${path}?cursor=${next}` } } };
    },
  });
  const api = checkDocMock({
    integration: "squarespace",
    baseUrl: "https://api.squarespace.com",
    source: { url: DOCS.orders, title: "Squarespace Commerce APIs: Orders, Inventory and Products", retrievedOn: "2026-11-11", version: "Orders 1.0, Inventory 1.0, Products v2" },
    assumptions: [
      "A cursor keeps the window of the page that gave it, and pages don't shift while nothing changes",
      "modifiedAfter is strictly after and modifiedBefore up to and including",
      "Products and stock list in a stable order",
      "A MonetaryAmount's value may come as a number or a decimal string",
    ],
    routes: [
      route("/v2/commerce/products", "Products", "products", () => data.products ?? [], false, DOCS.products),
      route("/1.0/commerce/inventory", "Inventory", "inventory", () => data.inventory ?? [], false, DOCS.inventory),
      route("/1.0/commerce/orders", "Orders", "result", () => data.orders ?? [], true, DOCS.orders),
    ],
  });
  return { api, fetch: docMockFetch(api), reads };
}

export default {
  integration: "squarespace",
  covers: "A Squarespace site's Commerce APIs: products (v2), inventory and orders, enforcing the key, its Read Only permissions, the User-Agent, cursors and the modified window",
  watchPages: [DOCS.orders, DOCS.products, DOCS.inventory],
  docMocks: () => [squarespaceDocMock({ apiKey: "" }).api],
} satisfies DocMockModule;
