import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Lightspeed Retail (X-Series): the OAuth token refresh and the product,
 * inventory, customer and sale lists, built from Lightspeed's developer
 * docs. Data is synthetic. A Lightspeed trial store replaces this mock once
 * a developer app is connected to one.
 *
 * Docs facts the mock relies on:
 * - The refresh is POST https://<prefix>.retail.lightspeed.app/api/1.0/token
 *   with the form refresh_token, client_id, client_secret and grant_type
 *   refresh_token. It answers access_token, token_type, expires,
 *   expires_in, refresh_token, domain_prefix and scope (the scopes granted),
 *   and always gives a new refresh token (authorization).
 * - GET /api/2026-10/products, /customers and /sales take after (a
 *   version), before and page_size, and answer {data, version: {min, max}},
 *   lowest version first; the next page starts after version.max, until an
 *   empty list comes back (pagination, listproducts, listcustomers,
 *   listsales).
 * - POST /api/2026-10/inventory takes a JSON body with after, size (up to
 *   5000) and sort_direction, and answers a bare list of records with
 *   product_id, outlet_id, current_inventory_level, version and deleted_at
 *   (listinventoryrecords).
 * - GET /api/2026-10/products/{id} answers {data: product} (getproductbyid).
 * - A 429 carries Retry-After, in seconds or as an HTTP date (rate limits).
 */
const DOCS = "https://x-series-api.lightspeedhq.com";
export const LIGHTSPEED_DOC_PAGES = {
  token: `${DOCS}/docs/authorization`,
  pagination: `${DOCS}/docs/pagination`,
  products: `${DOCS}/reference/listproducts`,
  product: `${DOCS}/reference/getproductbyid`,
  inventory: `${DOCS}/reference/listinventoryrecords`,
  customers: `${DOCS}/reference/listcustomers`,
  sales: `${DOCS}/reference/listsales`,
} as const;
export const LIGHTSPEED_TEST_PREFIX = "teststore";
const HOST = `https://${LIGHTSPEED_TEST_PREFIX}.retail.lightspeed.app`;

export const LIGHTSPEED_MOCK_READ_SCOPES = "products:read inventory:read customers:read sales:read";

export type LightspeedMockRecord = Record<string, unknown> & { version?: number };

export interface LightspeedMockData {
  clientId: string;
  clientSecret: string;
  /** The refresh token the store was connected with. */
  refreshToken: string;
  products: LightspeedMockRecord[];
  inventory: LightspeedMockRecord[];
  customers: LightspeedMockRecord[];
  sales: LightspeedMockRecord[];
  /** The scope the token response reports. Read scopes unless a test says otherwise. */
  scope?: string;
  /** Records a list page answers. Lightspeed doesn't document its default; 50 here. */
  pageSize?: number;
  /** 429s to answer before the next API reads, each with its Retry-After header. */
  rateLimits?: (string | null)[];
}

/** A Lightspeed-shaped ID: lower-case hex in UUID groups. */
export const lightspeedTestId = (kind: string, n: number) => `00000000-0000-4000-8000-${kind}${String(n).padStart(12 - kind.length, "0")}`;
/** Sales carry their version under _metadata; the mock keeps one on the record too, for sorting. */
const versionOf = (r: LightspeedMockRecord) => (typeof r.version === "number" ? r.version : Number((r._metadata as { version?: unknown } | undefined)?.version));
const at = (n: number) => synthetic.isoTime(n * 60).replace(".000Z", "+00:00");

export const lightspeedProduct = fixtureBuilder<LightspeedMockRecord>((n) => ({
  id: lightspeedTestId("a", n),
  sku: synthetic.sku(n),
  variant_name: `Test 14k ring ${n}`,
  family_id: lightspeedTestId("f", n),
  active: { in_store: true, ecwid: false },
  prices: { price_excluding_tax: "1250.50", price_including_tax: "1359.92", tax: "109.42", loyalty_amount: "0" },
  suppliers: [{ id: lightspeedTestId("e", 1), code: `SUP-${n}`, price: "640.00" }],
  version: 1000 + n,
  created_at: at(n),
  updated_at: at(n),
  deleted_at: null,
}));

export const lightspeedInventory = fixtureBuilder<LightspeedMockRecord>((n) => ({
  id: lightspeedTestId("b", n),
  product_id: lightspeedTestId("a", n),
  outlet_id: lightspeedTestId("0", 1),
  current_inventory_level: 3,
  average_cost: null,
  reorder_point: 1,
  reorder_amount: 2,
  version: 2000 + n,
  deleted_at: null,
}));

export const lightspeedCustomer = fixtureBuilder<LightspeedMockRecord>((n) => ({
  id: lightspeedTestId("c", n),
  customer_code: `TEST-${n}`,
  first_name: "Test",
  last_name: `Customer ${n}`,
  name: synthetic.name(n),
  email: synthetic.email(n),
  phone: synthetic.phone(n),
  mobile: synthetic.phone(n + 1),
  date_of_birth: "1990-01-01",
  physical_address_1: `${n} Test Street`,
  physical_city: "Testville",
  note: "Prefers rose gold",
  do_not_email: false,
  enable_promotional_sms: false,
  balance: 0,
  year_to_date: 1250.5,
  version: 3000 + n,
  created_at: at(n),
  updated_at: at(n),
  deleted_at: null,
}));

export const lightspeedSale = fixtureBuilder<LightspeedMockRecord>((n) => ({
  id: lightspeedTestId("d", n),
  _metadata: { version: 4000 + n },
  version: 4000 + n,
  invoice_number: `TEST-${n}`,
  receipt_number: `R-TEST-${n}`,
  state: "closed",
  date: at(n),
  created_at: at(n),
  updated_at: at(n),
  deleted_at: null,
  customer_id: lightspeedTestId("c", 1),
  note: "Engraving: test",
  source: { outlet_id: lightspeedTestId("0", 1), register_id: lightspeedTestId("9", 1), type: "USER", author: { id: lightspeedTestId("8", 1), name: "Test Staff" } },
  line_items: [
    {
      id: lightspeedTestId("1", n),
      product: { id: lightspeedTestId("a", 1), sku: synthetic.sku(1), name: "Test 14k ring 1" },
      quantity: 1,
      pricing: { price: 1150.5, discount: 100, discount_total: 100, total: 1150.5, cost: 640, cost_total: 640 },
      salesperson_id: lightspeedTestId("8", 1),
      gift_card_number: null,
    },
  ],
  payments: [{ id: lightspeedTestId("2", n), amount: 1250.6, date: at(n), type: { id: "1", name: "Credit Card", label: "Credit Card" } }],
  totals: { price: 1150.5, price_incl_tax: 1250.6, tax: 100.1, loyalty: 0, surcharge: 0 },
  return: null,
}));

const error = (status: number, message: string, headers?: Record<string, string>): DocMockResponse => ({ status, body: { error: message }, ...(headers ? { headers } : {}) });

export interface LightspeedMock {
  token: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  /** The refresh token the mock now accepts. */
  readonly refreshToken: string;
  readonly accessTokens: string[];
  /** Each list read: the list and the version it asked after. */
  readonly reads: { list: string; after: number }[];
  revokeTokens(): void;
}

export function lightspeedDocMock(data: LightspeedMockData): LightspeedMock {
  let refreshToken = data.refreshToken;
  const accessTokens: string[] = [];
  const revoked = new Set<string>();
  const reads: { list: string; after: number }[] = [];
  const limits = [...(data.rateLimits ?? [])];
  const size = data.pageSize ?? 50;

  const token = checkDocMock({
    integration: "lightspeed",
    baseUrl: `${HOST}/api/1.0`,
    source: { url: LIGHTSPEED_DOC_PAGES.token, title: "Lightspeed Retail (X-Series) authorization", retrievedOn: "2026-11-10", version: "1.0" },
    assumptions: ["A used or unknown refresh token is 400 with error invalid_grant", "A bad client id or secret is 401 with error invalid_client"],
    routes: [
      {
        method: "POST",
        path: "/token",
        documentedAt: LIGHTSPEED_DOC_PAGES.token,
        respond(request) {
          if (!/^application\/x-www-form-urlencoded/.test(request.headers.get("content-type") ?? "")) return error(400, "invalid_request");
          const form = new URLSearchParams(request.body);
          if (form.get("client_id") !== data.clientId || form.get("client_secret") !== data.clientSecret) return error(401, "invalid_client");
          if (form.get("grant_type") !== "refresh_token") return error(400, "unsupported_grant_type");
          if (form.get("refresh_token") !== refreshToken) return error(400, "invalid_grant");
          const n = accessTokens.length + 1;
          const access = `testaccess${String(n).padStart(14, "0")}`;
          accessTokens.push(access);
          // Every refresh gives a new refresh token; the old one stops working.
          refreshToken = `testrefresh${String(n).padStart(13, "0")}`;
          return {
            status: 200,
            body: { access_token: access, token_type: "Bearer", expires: 1_800_000_000, expires_in: 604_800, refresh_token: refreshToken, domain_prefix: LIGHTSPEED_TEST_PREFIX, scope: data.scope ?? LIGHTSPEED_MOCK_READ_SCOPES },
          };
        },
      },
    ],
  });

  /** Checks the bearer token and answers a pending 429; null when the read can go ahead. */
  function gate(headers: Headers): DocMockResponse | null {
    const bearer = /^Bearer (\S+)$/.exec(headers.get("authorization") ?? "")?.[1];
    if (!bearer || !accessTokens.includes(bearer) || revoked.has(bearer)) return error(401, "unauthorized");
    if (limits.length) {
      const after = limits.shift();
      return error(429, "Too Many Requests", after === null || after === undefined ? undefined : { "retry-after": after });
    }
    return null;
  }

  const newer = (rows: LightspeedMockRecord[], after: number) => rows.filter((r) => versionOf(r) > after).sort((a, b) => versionOf(a) - versionOf(b));

  const listRoute = (list: "products" | "customers" | "sales") => ({
    method: "GET" as const,
    path: `/${list}`,
    documentedAt: LIGHTSPEED_DOC_PAGES[list],
    respond(request: { url: URL; headers: Headers }): DocMockResponse {
      const blocked = gate(request.headers);
      if (blocked) return blocked;
      const raw = request.url.searchParams.get("after") ?? "0";
      if (!/^\d{1,15}$/.test(raw)) return error(400, "after must be a version number");
      const after = Number(raw);
      reads.push({ list, after });
      const page = newer(data[list], after).slice(0, size);
      const versions = page.map(versionOf);
      return { status: 200, body: { data: page, version: { min: versions.length ? versions[0] : null, max: versions.length ? versions[versions.length - 1] : null } } };
    },
  });

  const api = checkDocMock({
    integration: "lightspeed",
    baseUrl: `${HOST}/api/2026-10`,
    source: { url: LIGHTSPEED_DOC_PAGES.pagination, title: "Lightspeed Retail (X-Series) API 2026-10", retrievedOn: "2026-11-10", version: "2026-10" },
    auth: "bearer",
    assumptions: [
      "A revoked or unknown access token is 401",
      "A page holds at most 50 records when no page_size is sent",
      "Customers deleted in Lightspeed are left out unless deleted=true is sent",
      "A product that doesn't exist is 404",
      "Sale line pricing.price is the unit price after its discount, and pricing.discount the unit discount, both before tax",
    ],
    routes: [
      listRoute("products"),
      listRoute("customers"),
      listRoute("sales"),
      {
        method: "GET",
        path: "/products/{id}",
        documentedAt: LIGHTSPEED_DOC_PAGES.product,
        respond(request, params) {
          const blocked = gate(request.headers);
          if (blocked) return blocked;
          reads.push({ list: `product:${params.id}`, after: 0 });
          const product = data.products.find((p) => p.id === params.id);
          return product ? { status: 200, body: { data: product } } : error(404, "Not Found");
        },
      },
      {
        method: "POST",
        path: "/inventory",
        documentedAt: LIGHTSPEED_DOC_PAGES.inventory,
        respond(request) {
          const blocked = gate(request.headers);
          if (blocked) return blocked;
          let body: { after?: unknown; size?: unknown; sort_direction?: unknown };
          try {
            body = JSON.parse(request.body) as typeof body;
          } catch {
            return error(400, "body must be JSON");
          }
          const after = body.after ?? 0;
          const want = body.size ?? 1000;
          if (!Number.isSafeInteger(after) || (after as number) < 0) return error(400, "after must be a version number");
          if (!Number.isInteger(want) || (want as number) < 1 || (want as number) > 5000) return error(400, "size must be 1 to 5000");
          if (body.sort_direction !== "asc") return error(400, "the mock only answers sort_direction asc");
          reads.push({ list: "inventory", after: after as number });
          return { status: 200, body: newer(data.inventory, after as number).slice(0, want as number) };
        },
      },
    ],
  });

  const tokenFetch = docMockFetch(token);
  const apiFetch = docMockFetch(api);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const toToken = url.origin === HOST && url.pathname.startsWith("/api/1.0/");
      const response = await (toToken ? tokenFetch : apiFetch)(input, init);
      calls.push(...(toToken ? tokenFetch.calls : apiFetch.calls).slice(-1));
      return response;
    },
    { calls },
  );
  return {
    token,
    api,
    fetch,
    get refreshToken() {
      return refreshToken;
    },
    get accessTokens() {
      return accessTokens;
    },
    get reads() {
      return reads;
    },
    revokeTokens: () => accessTokens.forEach((t) => revoked.add(t)),
  };
}

export default {
  integration: "lightspeed",
  covers: "Lightspeed Retail (X-Series) token refresh and product, inventory, customer and sale reads",
  watchPages: [LIGHTSPEED_DOC_PAGES.token, LIGHTSPEED_DOC_PAGES.pagination, LIGHTSPEED_DOC_PAGES.products, LIGHTSPEED_DOC_PAGES.customers, LIGHTSPEED_DOC_PAGES.sales, LIGHTSPEED_DOC_PAGES.product, LIGHTSPEED_DOC_PAGES.inventory],
  docMocks: () => {
    const mock = lightspeedDocMock({ clientId: "", clientSecret: "", refreshToken: "", products: [], inventory: [], customers: [], sales: [] });
    return [mock.token, mock.api];
  },
} satisfies DocMockModule;
