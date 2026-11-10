import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Etsy's Open API v3: the OAuth token refresh, the token-scopes check, the
 * current user, and the shop's receipt and listing lists, built from
 * Etsy's developer docs and its published OpenAPI spec (3.0.0). Data is
 * synthetic. Etsy has no sandbox; a developer's own shop replaces this
 * mock on the first live run.
 *
 * Docs facts the mock relies on:
 * - The refresh is POST https://api.etsy.com/v3/public/oauth/token with the
 *   form grant_type refresh_token, client_id (the keystring) and
 *   refresh_token, and answers access_token, token_type, expires_in (3600)
 *   and refresh_token (authentication).
 * - Every v3 request carries x-api-key as keystring:shared_secret
 *   (authentication, request standards).
 * - POST /v3/application/scopes with the form token answers the scopes of
 *   that token (tokenScopes).
 * - GET /v3/application/users/me answers user_id and shop_id (getMe).
 * - GET /v3/application/shops/{shop_id}/receipts takes min_created,
 *   min_last_modified (epoch seconds from 946684800), sort_on (created,
 *   updated, receipt_id), sort_order, limit (1 to 100) and offset, needs
 *   transactions_r, and answers {count, results} (getShopReceipts).
 * - GET /v3/application/shops/{shop_id}/listings takes state, limit (1 to
 *   100), offset and includes (Inventory among them), needs listings_r, and
 *   answers {count, results} (getListingsByShop).
 * - A 429 carries Retry-After in seconds (rate limits).
 */
const DOCS = "https://developers.etsy.com/documentation";
export const ETSY_DOC_PAGES = {
  authentication: `${DOCS}/essentials/authentication`,
  rateLimits: `${DOCS}/essentials/rate-limits`,
  reference: `${DOCS}/reference`,
} as const;

export const ETSY_TEST_SHOP = "50000001";
export const ETSY_TEST_USER = "70000001";
export const ETSY_MOCK_READ_SCOPES = ["transactions_r", "listings_r"];

export type EtsyMockRecord = Record<string, unknown>;

export interface EtsyMockData {
  keystring: string;
  sharedSecret: string;
  /** The refresh token the shop was connected with. */
  refreshToken: string;
  /** The shop the connection belongs to. */
  shopId?: string;
  receipts: EtsyMockRecord[];
  listings: EtsyMockRecord[];
  /** The scopes the token-scopes call reports, or a raw body to answer. */
  scopes?: string[] | { raw: unknown; status?: number };
  /** Whether the refresh hands back a new refresh token. Etsy's docs don't say; yes here. */
  rotate?: boolean;
  /** 429s to answer before the next shop reads (receipts and listings), each with its Retry-After header. */
  rateLimits?: (string | null)[];
}

const BASE = 1_767_225_600; // 2026-01-01T00:00:00Z
const money = (amount: number, divisor = 100) => ({ amount, divisor, currency_code: "USD" });

export const etsyListing = fixtureBuilder<EtsyMockRecord>((n) => ({
  listing_id: 900_000 + n,
  user_id: Number(ETSY_TEST_USER),
  shop_id: Number(ETSY_TEST_SHOP),
  title: `Test 14k stacking ring ${n}`,
  description: "Handmade test ring. Questions? Write to seller@example.test",
  state: "active",
  created_timestamp: BASE + n * 60,
  updated_timestamp: BASE + n * 60,
  quantity: 3,
  url: `https://www.etsy.com/listing/${900_000 + n}/test`,
  tags: ["test", "ring"],
  materials: ["14k gold"],
  inventory: {
    products: [
      { product_id: 800_000 + n, sku: synthetic.sku(n), is_deleted: false, offerings: [{ offering_id: 700_000 + n, quantity: 3, is_enabled: true, is_deleted: false, price: money(45_000) }], property_values: [] },
    ],
  },
}));

export const etsyReceipt = fixtureBuilder<EtsyMockRecord>((n) => ({
  receipt_id: 600_000 + n,
  receipt_type: 0,
  seller_user_id: Number(ETSY_TEST_USER),
  seller_email: "seller@example.test",
  buyer_user_id: 400_000 + n,
  buyer_email: synthetic.email(n),
  name: synthetic.name(n),
  first_line: `${n} Test Street`,
  city: "Testville",
  state: "NY",
  zip: "10001",
  country_iso: "US",
  formatted_address: `${synthetic.name(n)}\n${n} Test Street\nTestville, NY 10001`,
  status: "paid",
  payment_method: "cc",
  payment_email: synthetic.email(n),
  message_from_buyer: `Please engrave it, call ${synthetic.phone(n)}`,
  message_from_seller: null,
  is_paid: true,
  is_shipped: false,
  created_timestamp: BASE + n * 3600,
  updated_timestamp: BASE + n * 3600,
  is_gift: false,
  gift_message: "",
  grandtotal: money(48_600),
  subtotal: money(45_000),
  total_price: money(45_000),
  total_shipping_cost: money(0),
  total_tax_cost: money(3_600),
  discount_amt: money(0),
  shipments: [],
  refunds: [],
  transactions: [
    {
      transaction_id: 500_000 + n,
      title: `Test 14k stacking ring ${n}`,
      seller_user_id: Number(ETSY_TEST_USER),
      buyer_user_id: 400_000 + n,
      quantity: 1,
      receipt_id: 600_000 + n,
      listing_id: 900_000 + n,
      product_id: 800_000 + n,
      sku: synthetic.sku(n),
      price: money(45_000),
      shipping_cost: money(0),
      variations: [{ formatted_name: "Personalization", formatted_value: "For Test Customer" }],
      buyer_coupon: 0,
      shop_coupon: 0,
    },
  ],
}));

const error = (status: number, message: string, headers?: Record<string, string>): DocMockResponse => ({ status, body: { error: message }, ...(headers ? { headers } : {}) });
const LIMIT = /^([1-9]\d?|100)$/;
const WHOLE = /^\d{1,9}$/;

export interface EtsyMock {
  token: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  /** The refresh token the mock now accepts. */
  readonly refreshToken: string;
  readonly accessTokens: string[];
  /** Each shop read, by list, with its query. */
  readonly reads: { list: "receipts" | "listings"; query: Record<string, string> }[];
  revokeTokens(): void;
}

export function etsyDocMock(data: EtsyMockData): EtsyMock {
  let refreshToken = data.refreshToken;
  const accessTokens: string[] = [];
  const revoked = new Set<string>();
  const reads: { list: "receipts" | "listings"; query: Record<string, string> }[] = [];
  const limits = [...(data.rateLimits ?? [])];
  const shop = data.shopId ?? ETSY_TEST_SHOP;
  const apiKey = `${data.keystring}:${data.sharedSecret}`;

  const token = checkDocMock({
    integration: "etsy",
    baseUrl: "https://api.etsy.com/v3/public/oauth",
    source: { url: ETSY_DOC_PAGES.authentication, title: "Etsy Open API v3 authentication", retrievedOn: "2026-11-10", version: "3.0.0" },
    assumptions: ["A used or unknown refresh token is 400 with error invalid_grant", "An unknown client_id is 401 with error invalid_client"],
    routes: [
      {
        method: "POST",
        path: "/token",
        documentedAt: ETSY_DOC_PAGES.authentication,
        respond(request) {
          if (!/^application\/x-www-form-urlencoded/.test(request.headers.get("content-type") ?? "")) return error(400, "invalid_request");
          const form = new URLSearchParams(request.body);
          if (form.get("client_id") !== data.keystring) return error(401, "invalid_client");
          if (form.get("grant_type") !== "refresh_token") return error(400, "unsupported_grant_type");
          if (form.get("refresh_token") !== refreshToken) return error(400, "invalid_grant");
          const n = accessTokens.length + 1;
          // Etsy's access tokens start with the user id.
          const access = `${ETSY_TEST_USER}.testaccess${String(n).padStart(14, "0")}`;
          accessTokens.push(access);
          if (data.rotate !== false) refreshToken = `${ETSY_TEST_USER}.testrefresh${String(n).padStart(13, "0")}`;
          return { status: 200, body: { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken } };
        },
      },
    ],
  });

  const keyed = (headers: Headers) => headers.get("x-api-key") === apiKey;

  /** Checks the key, the bearer token and the shop, and answers a pending 429; null when the read can go ahead. */
  function gate(headers: Headers, shopId?: string): DocMockResponse | null {
    if (!keyed(headers)) return error(401, "Invalid API key");
    const bearer = /^Bearer (\S+)$/.exec(headers.get("authorization") ?? "")?.[1];
    if (!bearer || !accessTokens.includes(bearer) || revoked.has(bearer)) return error(401, "invalid_token");
    if (shopId === undefined) return null;
    if (shopId !== shop) return error(403, "You do not have permission to view this shop");
    if (limits.length) {
      const after = limits.shift();
      return error(429, "Too Many Requests", after === null || after === undefined ? undefined : { "retry-after": after });
    }
    return null;
  }

  const query = (url: URL) => Object.fromEntries(url.searchParams.entries());
  const page = (rows: EtsyMockRecord[], q: Record<string, string>): DocMockResponse => {
    const limit = q.limit ?? "25";
    const offset = q.offset ?? "0";
    if (!LIMIT.test(limit)) return error(400, "limit must be 1 to 100");
    if (!WHOLE.test(offset)) return error(400, "offset must be a whole number");
    return { status: 200, body: { count: rows.length, results: rows.slice(Number(offset), Number(offset) + Number(limit)) } };
  };

  const api = checkDocMock({
    integration: "etsy",
    baseUrl: "https://api.etsy.com/v3/application",
    source: { url: ETSY_DOC_PAGES.reference, title: "Etsy Open API v3 reference", retrievedOn: "2026-11-10", version: "3.0.0" },
    assumptions: [
      "The token-scopes call answers {scopes: [...]}",
      "Receipts sorted by created or updated ascending keep receipts sharing a second in one order between pages",
      "min_last_modified and min_created match receipts at that second too",
      "A transaction's price is per item, and shop_coupon its share of the shop's discount in the shop currency",
      "A shop the token can't read is 403",
    ],
    routes: [
      {
        method: "POST",
        path: "/scopes",
        documentedAt: ETSY_DOC_PAGES.reference,
        respond(request) {
          if (!keyed(request.headers)) return error(401, "Invalid API key");
          const tokenValue = new URLSearchParams(request.body).get("token");
          if (!tokenValue || !accessTokens.includes(tokenValue)) return error(400, "invalid token");
          const s = data.scopes ?? ETSY_MOCK_READ_SCOPES;
          return Array.isArray(s) ? { status: 200, body: { scopes: s } } : { status: s.status ?? 200, body: s.raw };
        },
      },
      {
        method: "GET",
        path: "/users/me",
        documentedAt: ETSY_DOC_PAGES.reference,
        respond(request) {
          const blocked = gate(request.headers);
          return blocked ?? { status: 200, body: { user_id: Number(ETSY_TEST_USER), shop_id: Number(shop) } };
        },
      },
      {
        method: "GET",
        path: "/shops/{shopId}/receipts",
        documentedAt: ETSY_DOC_PAGES.reference,
        respond(request, params) {
          const blocked = gate(request.headers, params.shopId);
          if (blocked) return blocked;
          const q = query(request.url);
          for (const f of ["min_created", "min_last_modified"]) if (q[f] !== undefined && (!/^\d{9,10}$/.test(q[f]!) || Number(q[f]) < 946_684_800)) return error(400, `${f} must be epoch seconds from 946684800`);
          const sortOn = q.sort_on ?? "created";
          if (!["created", "updated", "receipt_id"].includes(sortOn)) return error(400, "invalid sort_on");
          reads.push({ list: "receipts", query: q });
          const created = (r: EtsyMockRecord) => Number(r.created_timestamp);
          const updated = (r: EtsyMockRecord) => Number(r.updated_timestamp);
          let rows = [...data.receipts];
          if (q.min_created) rows = rows.filter((r) => created(r) >= Number(q.min_created));
          if (q.min_last_modified) rows = rows.filter((r) => updated(r) >= Number(q.min_last_modified));
          const key = sortOn === "updated" ? updated : sortOn === "created" ? created : (r: EtsyMockRecord) => Number(r.receipt_id);
          rows.sort((a, b) => key(a) - key(b) || Number(a.receipt_id) - Number(b.receipt_id));
          const order = q.sort_order ?? "desc";
          if (!["asc", "ascending", "up", "desc", "descending", "down"].includes(order)) return error(400, "invalid sort_order");
          if (order === "desc" || order === "descending" || order === "down") rows.reverse();
          return page(rows, q);
        },
      },
      {
        method: "GET",
        path: "/shops/{shopId}/listings",
        documentedAt: ETSY_DOC_PAGES.reference,
        respond(request, params) {
          const blocked = gate(request.headers, params.shopId);
          if (blocked) return blocked;
          const q = query(request.url);
          const state = q.state ?? "active";
          if (!["active", "inactive", "sold_out", "draft", "expired"].includes(state)) return error(400, "invalid state");
          reads.push({ list: "listings", query: q });
          const withInventory = (q.includes ?? "").split(",").includes("Inventory");
          const rows = data.listings.filter((l) => (l.state ?? "active") === state).map((l) => (withInventory ? l : { ...l, inventory: undefined }));
          return page(rows, q);
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
      const toToken = url.pathname.startsWith("/v3/public/oauth/");
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
  integration: "etsy",
  covers: "Etsy Open API v3 token refresh, token scopes, and the shop's receipt and listing reads",
  watchPages: [ETSY_DOC_PAGES.authentication, ETSY_DOC_PAGES.reference],
  docMocks: () => {
    const mock = etsyDocMock({ keystring: "", sharedSecret: "", refreshToken: "", receipts: [], listings: [] });
    return [mock.token, mock.api];
  },
} satisfies DocMockModule;
