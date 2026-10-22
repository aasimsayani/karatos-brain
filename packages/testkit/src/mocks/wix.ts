import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * The Wix REST API endpoints the Wix connector reads, and the app token
 * request, built from Wix's API reference: OAuth client credentials, Get App
 * Instance, Get Catalog Version, eCommerce Search Orders, Catalog V3 Query
 * Products, Query Variants and Query Inventory Items, Catalog V1 Query
 * Products, and Contacts V5 Query Contacts. It checks the app token and each
 * endpoint's permission, caps page sizes as documented, pages with cursors
 * (a cursor request carries no filter or sort), and keeps the documented
 * defaults, such as Search Orders leaving out PENDING and REJECTED orders.
 * Data is synthetic, and carries the personal data a real site would, so
 * tests can check none of it is kept. A Wix test site replaces this mock
 * once one is set up.
 */
const DOCS = "https://dev.wix.com/docs/api-reference";
export const WIX_MOCK_API = "https://www.wixapis.com";

export type WixMockRecord = Record<string, unknown>;

/** The permissions a read-only KaratOS app holds, as Wix lists them on the app instance. */
export const WIX_READ_ONLY_PERMISSIONS = [
  "SCOPE.DC.MANAGE-YOUR-APP",
  "SCOPE.DC-STORES.READ-ORDERS",
  "SCOPE.STORES.CATALOG_READ_LIMITED",
  "SCOPE.STORES.PRODUCT_READ",
  "SCOPE.STORES.PRODUCT_READ_ADMIN",
  "SCOPE.STORES.INVENTORY_ITEM_READ",
  "SCOPE.DC-STORES.READ-PRODUCTS",
  "SCOPE.DC-CONTACTS.READ-CONTACTS",
];

export interface WixMockApp {
  secret: string;
  /** The app's instance on this site. */
  instanceId: string;
  /** What the site owner granted the app. */
  permissions: string[];
}

export interface WixMockData {
  /** Installed apps, by app ID. */
  apps?: Record<string, WixMockApp>;
  catalogVersion?: "V1_CATALOG" | "V3_CATALOG" | "STORES_NOT_INSTALLED";
  orders?: WixMockRecord[];
  productsV3?: WixMockRecord[];
  variantsV3?: WixMockRecord[];
  inventoryItems?: WixMockRecord[];
  productsV1?: WixMockRecord[];
  contacts?: WixMockRecord[];
  /** 429s to answer before the next requests, in order, with the Retry-After to send if any. */
  rateLimits?: { retryAfter?: number }[];
  /** Answers with a redirect to this address instead. */
  redirectTo?: string;
  /** Refuses every cursor with 400, as Wix may once a cursor is too old. */
  rejectCursors?: boolean;
}

/** A GUID for synthetic records: letters in every group, so no run of digits looks like a card number. */
export const wixTestId = (kind: string, n: number) => `${kind}${String(n).padStart(4, "0")}-${kind}-4abc-8def-abcdef${String(n).padStart(6, "0")}`;
const at = (minutes: number) => synthetic.isoTime(minutes);
const money = (amount: string) => ({ amount, formattedAmount: `$${amount}` });
const address = (n: number) => ({
  country: "US",
  subdivision: "US-NY",
  city: "Testville",
  postalCode: "00000",
  addressLine: `${n} Test Street`,
  streetAddress: { number: String(n), name: "Test Street" },
});

export const WIX_STORES_APP_ID = "215238eb-22a5-4c36-9e7b-e7c08025e04e";

export const wixOrder = fixtureBuilder<WixMockRecord>((n) => ({
  id: wixTestId("aaaa", n),
  number: String(10_000 + n),
  createdDate: at(n * 10),
  updatedDate: at(n * 10 + 5),
  status: "APPROVED",
  paymentStatus: "PAID",
  fulfillmentStatus: "NOT_FULFILLED",
  archived: false,
  currency: "USD",
  channelInfo: { type: "WEB" },
  buyerInfo: { contactId: wixTestId("eeee", 1), email: synthetic.email(n) },
  billingInfo: { address: address(n), contactDetails: { firstName: "Test", lastName: `Customer ${n}`, phone: synthetic.phone(n), company: "Test Co" } },
  recipientInfo: { address: address(n), contactDetails: { firstName: "Test", lastName: `Recipient ${n}`, phone: synthetic.phone(n) } },
  shippingInfo: { title: "Standard", logistics: { instructions: "Synthetic instructions: leave at the door" } },
  buyerNote: "Synthetic note: please size to 6",
  priceSummary: { subtotal: money("1250.00"), shipping: money("0.00"), tax: money("0.00"), discount: money("50.00"), total: money("1200.00") },
  balanceSummary: { balance: money("0.00"), paid: money("1200.00"), refunded: money("0.00") },
  activities: [{ id: wixTestId("abcd", n), authorEmail: synthetic.email(n + 50), type: "ORDER_PLACED", createdDate: at(n * 10) }],
  customFields: [{ title: "Engraving", value: "Synthetic engraving" }],
  lineItems: [
    {
      id: wixTestId("abab", n),
      productName: { original: `Test 14K Ring ${n}` },
      catalogReference: { catalogItemId: wixTestId("bbbb", n), appId: WIX_STORES_APP_ID, options: { variantId: wixTestId("cccc", n) } },
      quantity: 1,
      price: money("1250.00"),
      priceBeforeDiscounts: money("1250.00"),
      totalDiscount: money("50.00"),
      totalPriceBeforeTax: money("1200.00"),
      totalPriceAfterTax: money("1200.00"),
      physicalProperties: { sku: synthetic.sku(n), shippable: true },
      refundQuantity: 0,
      descriptionLines: [{ name: { original: "Size" }, plainText: { original: "6" } }],
    },
  ],
}));

export const wixProductV3 = fixtureBuilder<WixMockRecord>((n) => ({
  id: wixTestId("bbbb", n),
  revision: "1",
  createdDate: at(n),
  updatedDate: at(n + 1),
  name: `Test 14K Ring ${n}`,
  slug: `test-14k-ring-${n}`,
  visible: true,
  visibleInPos: true,
  productType: "PHYSICAL",
  brand: { id: wixTestId("baba", 1), name: "Test Brand" },
  plainDescription: "Synthetic description",
}));

export const wixVariantV3 = fixtureBuilder<WixMockRecord>((n) => ({
  variantId: wixTestId("cccc", n),
  visible: true,
  sku: `${synthetic.sku(n)}-V`,
  price: { actualPrice: { amount: "980.00" }, compareAtPrice: { amount: "1250.00" } },
  optionChoices: [{ optionChoiceNames: { optionName: "Size", choiceName: "6" } }],
  inventoryStatus: { inStock: true, preorderEnabled: false },
  productData: { productId: wixTestId("bbbb", n), name: `Test 14K Ring ${n}`, productType: "PHYSICAL", visible: true },
}));

export const wixInventoryItem = fixtureBuilder<WixMockRecord>((n) => ({
  id: wixTestId("dddd", n),
  revision: "1",
  createdDate: at(n),
  updatedDate: at(n + 2),
  variantId: wixTestId("cccc", n),
  productId: wixTestId("bbbb", n),
  locationId: wixTestId("ffff", 1),
  trackQuantity: true,
  quantity: n,
  availabilityStatus: "IN_STOCK",
  product: { name: `Test 14K Ring ${n}`, variantName: "Size 6", variantSku: `${synthetic.sku(n)}-V`, variantVisible: true },
}));

export const wixProductV1 = fixtureBuilder<WixMockRecord>((n) => ({
  id: wixTestId("bbbb", n),
  name: `Test 14K Ring ${n}`,
  slug: `test-14k-ring-${n}`,
  visible: true,
  productType: "physical",
  description: "Synthetic description",
  sku: synthetic.sku(n),
  stock: { trackInventory: true, quantity: n, inventoryStatus: "IN_STOCK" },
  priceData: { currency: "USD", price: 1250, discountedPrice: 1250 },
  manageVariants: false,
  brand: "Test Brand",
  ribbon: "New",
  lastUpdated: at(n + 1),
  createdDate: at(n),
  variants: [{ id: wixTestId("cccc", n), choices: {}, variant: { priceData: { currency: "USD", price: 1250 }, sku: synthetic.sku(n), visible: true }, stock: { trackQuantity: true, quantity: n, inStock: true } }],
}));

export const wixContact = fixtureBuilder<WixMockRecord>((n) => ({
  id: wixTestId("eeee", n),
  revision: "1",
  createdDate: at(n * 3),
  updatedDate: at(n * 3 + 1),
  name: { first: "Test", last: `Customer ${n}` },
  email: { email: synthetic.email(n), subscriptionStatus: { status: n % 2 ? "SUBSCRIBED" : "NOT_SET" }, deliverabilityStatus: "VALID" },
  phone: { phone: synthetic.phone(n), e164: synthetic.phone(n).replace(/ /g, ""), subscriptionStatus: { status: "NOT_SET" } },
  addresses: [{ tag: "SHIPPING", address: address(n) }],
  extendedFields: { namespaces: { _user_fields: { ring_size: "6" } } },
}));

const error = (status: number, message: string, code?: string): DocMockResponse => ({ status, body: { message, details: code ? { applicationError: { code, description: message } } : {} } });
const ms = (t: unknown) => (typeof t === "string" ? Date.parse(t) : Number.NaN);
const get = (record: WixMockRecord, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as WixMockRecord)[k] : undefined), record);

export interface WixMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Tokens issued so far, for tests that expire them. */
  readonly tokens: Map<string, string>;
}

interface QuerySpec {
  /** Filterable fields and how they compare: as times, or as strings. */
  filters: Record<string, "time" | "string">;
  /** Sortable fields, with the orders each allows. */
  sorts: Record<string, readonly ("ASC" | "DESC")[]>;
  defaultSort: { fieldName: string; order: "ASC" | "DESC" };
  defaultLimit: number;
  maxLimit: number;
  /** The response's list key and paging key, and whether the paging carries hasNext. */
  key: string;
  paging: "metadata" | "pagingMetadata";
  hasNext: boolean;
}

const OPS = new Set(["$eq", "$ne", "$in", "$gt", "$gte", "$lt", "$lte"]);

function matches(record: WixMockRecord, filter: Record<string, unknown>, spec: QuerySpec): boolean | string {
  for (const [field, cond] of Object.entries(filter)) {
    const kind = Object.hasOwn(spec.filters, field) ? spec.filters[field] : undefined;
    if (!kind) return `Field '${field}' is not declared as filterable`;
    const value = get(record, field);
    const conds = cond !== null && typeof cond === "object" && !Array.isArray(cond) ? (cond as Record<string, unknown>) : { $eq: cond };
    for (const [op, want] of Object.entries(conds)) {
      if (!OPS.has(op)) return `Operator ${op} is not supported`;
      const cmp = (a: unknown, b: unknown) => (kind === "time" ? ms(a) - ms(b) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
      if (kind === "time" && (typeof want !== "string" || Number.isNaN(ms(want)))) return `Invalid date for ${field}`;
      const ok =
        op === "$eq" ? cmp(value, want) === 0 :
        op === "$ne" ? cmp(value, want) !== 0 :
        op === "$in" ? Array.isArray(want) && want.some((w) => cmp(value, w) === 0) :
        op === "$gt" ? cmp(value, want) > 0 :
        op === "$gte" ? cmp(value, want) >= 0 :
        op === "$lt" ? cmp(value, want) < 0 :
        cmp(value, want) <= 0;
      if (!ok) return false;
    }
  }
  return true;
}

export function wixDocMock(data: WixMockData): WixMock {
  const limits = [...(data.rateLimits ?? [])];
  const tokens = new Map<string, string>();
  let issued = 0;

  /** The calling app, by its token (sent bare in Authorization, as Wix documents), then queued rate limits. */
  function gate(request: DocMockRequest, permission: string): { app: WixMockApp } | DocMockResponse {
    const appId = tokens.get(request.headers.get("authorization") ?? "");
    const app = appId ? data.apps?.[appId] : undefined;
    if (!app) return error(401, "UNAUTHENTICATED: invalid or expired token", "UNAUTHENTICATED");
    if (!app.permissions.includes(permission)) return error(403, "PERMISSION_DENIED: missing permission", "PERMISSION_DENIED");
    const limit = limits.shift();
    if (limit) return { status: 429, body: { message: "Too many requests" }, headers: limit.retryAfter ? { "retry-after": String(limit.retryAfter) } : {} };
    if (data.redirectTo) return { status: 302, body: null, headers: { location: data.redirectTo } };
    return { app };
  }
  const isResponse = (v: unknown): v is DocMockResponse => !!v && typeof v === "object" && "status" in v;
  const version = data.catalogVersion ?? "V3_CATALOG";
  const needCatalog = (want: "V1_CATALOG" | "V3_CATALOG") => (version === want ? undefined : error(428, `This site's catalog is ${version}; the endpoint is for ${want}`, "CATALOG_VERSION_MISMATCH"));

  /** A cursor-paged query: filter, sort and a keyset cursor over the sort fields and ID, so a record that changes moves later, never out. */
  function query(request: DocMockRequest, rows: WixMockRecord[], wrapper: "query" | "search", spec: QuerySpec, base: (r: WixMockRecord[], filter: Record<string, unknown>) => WixMockRecord[] = (r) => r): DocMockResponse {
    let body: WixMockRecord;
    try {
      body = JSON.parse(request.body || "{}") as WixMockRecord;
    } catch {
      return error(400, "Malformed JSON");
    }
    const q = (body[wrapper] ?? {}) as { filter?: Record<string, unknown>; sort?: { fieldName: string; order?: string }[]; cursorPaging?: { limit?: number; cursor?: string } };
    const paging = q.cursorPaging ?? {};
    const limit = paging.limit ?? spec.defaultLimit;
    if (!Number.isInteger(limit) || limit < 0 || limit > spec.maxLimit) return error(400, `cursorPaging.limit must be between 0 and ${spec.maxLimit}`, "INVALID_ARGUMENT");
    let filter = q.filter ?? {};
    let sort = q.sort ?? [spec.defaultSort];
    let last: unknown[] | null = null;
    if (paging.cursor !== undefined) {
      // Following requests use the cursor token and not filter or sort.
      if (q.filter !== undefined || q.sort !== undefined) return error(400, "A cursor request can't carry filter or sort", "INVALID_ARGUMENT");
      if (data.rejectCursors || typeof paging.cursor !== "string" || paging.cursor.length > 16_000) return error(400, "Invalid cursor", "INVALID_CURSOR");
      try {
        const decoded = JSON.parse(Buffer.from(paging.cursor, "base64url").toString("utf8")) as { f: Record<string, unknown>; s: typeof sort; l: unknown[] };
        filter = decoded.f;
        sort = decoded.s;
        last = decoded.l;
      } catch {
        return error(400, "Invalid cursor", "INVALID_CURSOR");
      }
    }
    if (!Array.isArray(sort) || sort.length > 5) return error(400, "Invalid sort", "INVALID_ARGUMENT");
    for (const s of sort) {
      const allowed = Object.hasOwn(spec.sorts, s.fieldName) ? spec.sorts[s.fieldName] : undefined;
      const order = (s.order ?? "ASC") as "ASC" | "DESC";
      if (!allowed || !allowed.includes(order)) return error(400, `Field '${s.fieldName}' can't be sorted ${order}`, "INVALID_ARGUMENT");
    }
    const filtered: WixMockRecord[] = [];
    for (const r of base(rows, filter)) {
      const m = matches(r, filter, spec);
      if (typeof m === "string") return error(400, m, "INVALID_ARGUMENT");
      if (m) filtered.push(r);
    }
    const keyOf = (r: WixMockRecord) => [...sort.map((s) => get(r, s.fieldName)), String(r.id ?? r.variantId)];
    const compare = (a: unknown[], b: unknown[]) => {
      for (let i = 0; i < a.length; i++) {
        const desc = i < sort.length && sort[i]!.order === "DESC";
        const x = a[i];
        const y = b[i];
        const c = typeof x === "string" && typeof y === "string" && !Number.isNaN(ms(x)) && !Number.isNaN(ms(y)) && i < sort.length ? ms(x) - ms(y) : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
        if (c !== 0) return desc ? -c : c;
      }
      return 0;
    };
    const sorted = filtered.sort((a, b) => compare(keyOf(a), keyOf(b)));
    const rest = last ? sorted.filter((r) => compare(keyOf(r), last!) > 0) : sorted;
    const page = rest.slice(0, limit);
    const more = rest.length > page.length && page.length > 0;
    const next = more ? Buffer.from(JSON.stringify({ f: filter, s: sort, l: keyOf(page[page.length - 1]!) }), "utf8").toString("base64url") : undefined;
    const meta: WixMockRecord = { count: page.length, cursors: next ? { next } : {} };
    if (spec.hasNext) meta.hasNext = more;
    return { status: 200, body: { [spec.key]: page, [spec.paging]: meta } };
  }

  const time = "time" as const;
  const str = "string" as const;
  const both = ["ASC", "DESC"] as const;

  const api = checkDocMock({
    integration: "wix",
    baseUrl: WIX_MOCK_API,
    source: { url: `${DOCS}/business-solutions/e-commerce/orders/orders/search-orders`, title: "Wix REST API reference", retrievedOn: "2026-10-22", version: "eCommerce Orders v1, Catalog V3 and V1, Contacts V5" },
    assumptions: [
      "Get App Instance lists instance.permissions as scope IDs such as SCOPE.DC-STORES.READ-ORDERS",
      "Every app holds SCOPE.DC.MANAGE-YOUR-APP, which Get App Instance needs",
      "The client credentials token is sent bare in Authorization (no Bearer) and lasts 14,400 seconds (expires_in)",
      "Search Orders with status $in APPROVED, CANCELED, PENDING and REJECTED returns PENDING and REJECTED orders too",
      "Cursors page by the sort fields and ID (keyset), so a record updated mid-paging moves later and is read again, never skipped",
      "A cursor request carrying filter or sort is refused with 400, and an expired cursor answers 400",
      "Query Products (V3) filters updatedDate with $gte and sorts it ASC; non-visible products come back with SCOPE.STORES.PRODUCT_READ_ADMIN",
      "Query Variants filters productData.productId with $in on up to 100 product IDs",
      "Query Inventory Items' pagingMetadata has no hasNext; the last page has no cursors.next",
      "Catalog V1 Query Products (POST /stores/v1/products/query) takes filter and sort as JSON strings, filters lastUpdated with $gte, and leaves out hidden products",
      "On a V1 site the V3 endpoints answer an error, and on a V3 site the V1 endpoint does, as the catalogs aren't compatible",
      "Contacts V5 Query Contacts filters updatedDate with $gte and sorts it ASC only",
      "Errors carry details.applicationError.code",
      "429 may carry Retry-After in seconds",
    ],
    routes: [
      {
        method: "POST",
        path: "/oauth2/token",
        documentedAt: "https://dev.wix.com/docs/build-apps/develop-your-app/access/authentication/authenticate-using-oauth",
        respond(request) {
          let body: WixMockRecord;
          try {
            body = JSON.parse(request.body || "{}") as WixMockRecord;
          } catch {
            return { status: 400, body: { error: "invalid_request" } };
          }
          if (body.grant_type !== "client_credentials") return { status: 400, body: { error: "unsupported_grant_type" } };
          const app = typeof body.client_id === "string" ? data.apps?.[body.client_id] : undefined;
          if (!app || body.client_secret !== app.secret) return { status: 401, body: { error: "invalid_client" } };
          if (body.instance_id !== app.instanceId) return { status: 400, body: { error: "invalid_request" } };
          issued++;
          const token = ["OauthNG.JWS", "mock", String(issued), "x".repeat(16)].join(".");
          tokens.set(token, String(body.client_id));
          return { status: 200, body: { access_token: token, token_type: "Bearer", expires_in: 14_400 } };
        },
      },
      {
        method: "GET",
        path: "/apps/v1/instance",
        documentedAt: `${DOCS}/app-management/app-instance/get-app-instance`,
        respond(request) {
          const g = gate(request, "SCOPE.DC.MANAGE-YOUR-APP");
          if (isResponse(g)) return g;
          return { status: 200, body: { instance: { instanceId: g.app.instanceId, appName: "KaratOS", isFree: true, permissions: g.app.permissions }, site: { siteId: wixTestId("fafa", 1), siteDisplayName: "Test Jeweler", locale: "en" } } };
        },
      },
      {
        method: "GET",
        path: "/stores/v3/provision/version",
        documentedAt: `${DOCS}/business-solutions/stores/catalog-versioning/get-catalog-version`,
        respond(request) {
          const g = gate(request, "SCOPE.STORES.CATALOG_READ_LIMITED");
          if (isResponse(g)) return g;
          return { status: 200, body: { catalogVersion: version } };
        },
      },
      {
        method: "POST",
        path: "/ecom/v1/orders/search",
        documentedAt: `${DOCS}/business-solutions/e-commerce/orders/orders/search-orders`,
        respond(request) {
          const g = gate(request, "SCOPE.DC-STORES.READ-ORDERS");
          if (isResponse(g)) return g;
          return query(
            request,
            data.orders ?? [],
            "search",
            {
              filters: { status: str, paymentStatus: str, updatedDate: time, createdDate: time, id: str },
              sorts: { updatedDate: both, createdDate: both, number: both },
              defaultSort: { fieldName: "createdDate", order: "DESC" },
              defaultLimit: 100,
              maxLimit: 100,
              key: "orders",
              paging: "metadata",
              hasNext: true,
            },
            // INITIALIZED never comes back; PENDING and REJECTED only when the filter names a status.
            (rows, filter) => rows.filter((o) => o.status !== "INITIALIZED" && (filter.status !== undefined || (o.status !== "PENDING" && o.status !== "REJECTED"))),
          );
        },
      },
      {
        method: "POST",
        path: "/stores/v3/products/query",
        documentedAt: `${DOCS}/business-solutions/stores/catalog-v3/products-v3/query-products`,
        respond(request) {
          const g = gate(request, "SCOPE.STORES.PRODUCT_READ");
          if (isResponse(g)) return g;
          const wrong = needCatalog("V3_CATALOG");
          if (wrong) return wrong;
          const admin = g.app.permissions.includes("SCOPE.STORES.PRODUCT_READ_ADMIN");
          return query(
            request,
            (data.productsV3 ?? []).filter((p) => admin || p.visible !== false),
            "query",
            { filters: { id: str, updatedDate: time, createdDate: time, visible: str }, sorts: { updatedDate: both, createdDate: both, slug: both }, defaultSort: { fieldName: "createdDate", order: "DESC" }, defaultLimit: 100, maxLimit: 100, key: "products", paging: "pagingMetadata", hasNext: true },
          );
        },
      },
      {
        method: "POST",
        path: "/stores/v3/products/query-variants",
        documentedAt: `${DOCS}/business-solutions/stores/catalog-v3/read-only-variants-v3/query-variants`,
        respond(request) {
          const g = gate(request, "SCOPE.STORES.PRODUCT_READ");
          if (isResponse(g)) return g;
          const wrong = needCatalog("V3_CATALOG");
          if (wrong) return wrong;
          return query(
            request,
            (data.variantsV3 ?? []).map((v) => ({ ...v, id: `${get(v, "productData.productId")}:${v.variantId}` })),
            "query",
            { filters: { variantId: str, "productData.productId": str }, sorts: { variantId: both, "productData.productId": both }, defaultSort: { fieldName: "productData.productId", order: "ASC" }, defaultLimit: 100, maxLimit: 1000, key: "variants", paging: "pagingMetadata", hasNext: true },
          );
        },
      },
      {
        method: "POST",
        path: "/stores/v3/inventory-items/query",
        documentedAt: `${DOCS}/business-solutions/stores/catalog-v3/inventory-items-v3/query-inventory-items`,
        respond(request) {
          const g = gate(request, "SCOPE.STORES.INVENTORY_ITEM_READ");
          if (isResponse(g)) return g;
          const wrong = needCatalog("V3_CATALOG");
          if (wrong) return wrong;
          return query(
            request,
            data.inventoryItems ?? [],
            "query",
            { filters: { id: str, variantId: str, productId: str, updatedDate: time, createdDate: time }, sorts: { updatedDate: both, createdDate: both, variantId: both }, defaultSort: { fieldName: "createdDate", order: "ASC" }, defaultLimit: 100, maxLimit: 1000, key: "inventoryItems", paging: "pagingMetadata", hasNext: false },
          );
        },
      },
      {
        method: "POST",
        path: "/stores/v1/products/query",
        documentedAt: `${DOCS}/business-solutions/stores/catalog-v1/catalog/query-products`,
        respond(request) {
          const g = gate(request, "SCOPE.DC-STORES.READ-PRODUCTS");
          if (isResponse(g)) return g;
          const wrong = needCatalog("V1_CATALOG");
          if (wrong) return wrong;
          let body: { includeVariants?: boolean; query?: { filter?: string; sort?: string; paging?: { limit?: number; offset?: number } } };
          let filter: Record<string, unknown>;
          let sort: Record<string, string>[];
          try {
            body = JSON.parse(request.body || "{}") as typeof body;
            filter = JSON.parse(body.query?.filter ?? "{}") as Record<string, unknown>;
            sort = JSON.parse(body.query?.sort ?? "[]") as Record<string, string>[];
          } catch {
            return error(400, "filter and sort must be JSON strings", "INVALID_ARGUMENT");
          }
          const limit = body.query?.paging?.limit ?? 100;
          const offset = body.query?.paging?.offset ?? 0;
          if (!Number.isInteger(limit) || limit < 0 || limit > 100 || !Number.isInteger(offset) || offset < 0) return error(400, "paging.limit must be between 0 and 100", "INVALID_ARGUMENT");
          const spec: QuerySpec = { filters: { lastUpdated: time, createdDate: time, id: str }, sorts: {}, defaultSort: { fieldName: "lastUpdated", order: "ASC" }, defaultLimit: 100, maxLimit: 100, key: "products", paging: "metadata", hasNext: false };
          // Hidden products are left out unless includeHiddenProducts, which needs a manage permission.
          const rows: WixMockRecord[] = [];
          for (const p of (data.productsV1 ?? []).filter((r) => r.visible !== false)) {
            const m = matches(p, filter, spec);
            if (typeof m === "string") return error(400, m, "INVALID_ARGUMENT");
            if (m) rows.push(p);
          }
          for (const s of sort) {
            const [field, order] = Object.entries(s)[0] ?? [];
            if (field !== "lastUpdated" && field !== "createdDate" && field !== "numericId") return error(400, `Sorting on ${field} isn't allowed`, "INVALID_ARGUMENT");
            rows.sort((a, b) => (ms(a[field]) - ms(b[field])) * (order === "desc" ? -1 : 1) || String(a.id).localeCompare(String(b.id)));
          }
          const page = rows.slice(offset, offset + limit).map((p) => (body.includeVariants ? p : { ...p, variants: undefined }));
          return { status: 200, body: { products: page, metadata: { items: limit, offset }, totalResults: rows.length } };
        },
      },
      {
        method: "POST",
        path: "/contacts/v5/contacts/query",
        documentedAt: `${DOCS}/crm/members-contacts/contacts/contacts-v5/query-contacts`,
        respond(request) {
          const g = gate(request, "SCOPE.DC-CONTACTS.READ-CONTACTS");
          if (isResponse(g)) return g;
          return query(
            request,
            data.contacts ?? [],
            "query",
            { filters: { id: str, createdDate: time, updatedDate: time }, sorts: { createdDate: ["ASC"], updatedDate: ["ASC"] }, defaultSort: { fieldName: "createdDate", order: "ASC" }, defaultLimit: 50, maxLimit: 100, key: "contacts", paging: "pagingMetadata", hasNext: true },
          );
        },
      },
    ],
  });

  const base = docMockFetch(api);
  return { api, fetch: base, tokens };
}
