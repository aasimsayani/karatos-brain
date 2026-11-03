import { createHash } from "node:crypto";
import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * Amazon's Selling Partner API in one marketplace, and the Login with
 * Amazon (LWA) token refresh that comes before it, built from Amazon's
 * docs. Data is synthetic.
 *
 * - LWA: POST https://api.amazon.com/auth/o2/token, a form with
 *   grant_type=refresh_token, refresh_token, client_id and client_secret;
 *   answers { access_token, token_type: "bearer", expires_in, refresh_token }.
 * - Every SP-API request carries the access token in x-amz-access-token
 *   and a user-agent. Errors are { errors: [{ code, message, details }] }.
 * - Orders v2026-01-01 searchOrders: GET /orders/2026-01-01/orders with
 *   exactly one of createdAfter or lastUpdatedAfter, its matching Before
 *   at least two minutes before the request, marketplaceIds,
 *   maxResultsPerPage (1 to 100), paginationToken and includedData;
 *   answers { orders, pagination: { nextToken }, lastUpdatedBefore }.
 * - Finances v2024-06-19 listTransactions: GET
 *   /finances/2024-06-19/transactions with postedAfter, postedBefore
 *   (later, and more than two minutes before the request), marketplaceId
 *   and nextToken; a range wider than 180 days answers no transactions.
 *   Answers { payload: { transactions, nextToken } }.
 * - FBA Inventory v1 getInventorySummaries: GET /fba/inventory/v1/summaries
 *   with granularityType=Marketplace, granularityId, one marketplaceIds,
 *   details and nextToken, which lasts 30 seconds; answers
 *   { payload: { granularity, inventorySummaries }, pagination: { nextToken } }.
 */
const LWA = "https://api.amazon.com/auth/o2";
const API = "https://sellingpartnerapi-na.amazon.com";
const DOCS = "https://developer-docs.amazon/sp-api";
const CONNECT_DOC = `${DOCS}/docs/connecting-to-the-selling-partner-api`;
const ORDERS_DOC = `${DOCS}/reference/searchorders`;
const TRANSACTIONS_DOC = `${DOCS}/reference/listtransactions`;
const INVENTORY_DOC = `${DOCS}/reference/getinventorysummaries`;
const SOURCE = { url: CONNECT_DOC, title: "Connect to the Selling Partner API", retrievedOn: "2026-11-03", version: "Orders v2026-01-01, Finances v2024-06-19, FBA Inventory v1" };
const DAY_MS = 86_400_000;
const TWO_MINUTES = 120_000;
export const AMAZON_MOCK_MARKETPLACE = "ATVPDKIKX0DER";

export type AmazonMockOrder = Record<string, unknown> & { orderId: string; lastUpdatedTime: string };
export type AmazonMockTransaction = Record<string, unknown> & { postedDate: string };
export type AmazonMockStock = Record<string, unknown> & { sellerSku: string };

const at = (n: number, unit: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + n * unit).toISOString();

/** Order n: two units of a test SKU, updated n hours after the start of 2026, with a buyer and address the client should never ask for. */
export const amazonOrder = fixtureBuilder<AmazonMockOrder>((n) => ({
  orderId: `111-TEST000-${String(n).padStart(7, "0")}`,
  createdTime: at(n, 3_600_000),
  lastUpdatedTime: at(n, 3_600_000),
  salesChannel: { channelName: "AMAZON", marketplaceId: AMAZON_MOCK_MARKETPLACE, marketplaceName: "Amazon.com" },
  programs: [],
  buyer: { buyerName: synthetic.name(n), buyerEmail: synthetic.email(n) },
  recipient: { deliveryAddress: { name: synthetic.name(n), addressLine1: `${100 + n} Test Street`, city: "Testville", stateOrRegion: "NY", postalCode: "10001", countryCode: "US", phone: synthetic.phone(n) } },
  fulfillment: { fulfillmentStatus: "SHIPPED", fulfilledBy: n % 2 ? "AMAZON" : "MERCHANT", fulfillmentServiceLevel: "STANDARD" },
  proceeds: { grandTotal: { amount: `${(n * 2 * 49.99).toFixed(2)}`, currencyCode: "USD" }, breakdowns: [{ type: "ITEM", subtotal: { amount: `${(n * 2 * 49.99).toFixed(2)}`, currencyCode: "USD" } }] },
  orderItems: [
    {
      orderItemId: `${10_000 + n}`,
      quantityOrdered: 2 * n,
      product: { asin: `B0TEST${String(n).padStart(4, "0")}`, title: `Test pendant ${n}`, sellerSku: synthetic.sku(n), condition: { conditionType: "NEW" }, price: { unitPrice: { amount: "49.99", currencyCode: "USD" } } },
    },
  ],
}));

/** Transaction n: a shipment of order n, posted n hours after the start of 2026. */
export const amazonTransaction = fixtureBuilder<AmazonMockTransaction>((n) => ({
  transactionId: `txn-${1_000 + n}`,
  transactionType: "Shipment",
  transactionStatus: "RELEASED",
  description: "Order Payment",
  postedDate: at(n, 3_600_000),
  totalAmount: { currencyAmount: 84.98, currencyCode: "USD" },
  marketplaceDetails: { marketplaceId: AMAZON_MOCK_MARKETPLACE, marketplaceName: "Amazon.com" },
  relatedIdentifiers: [
    { relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: `111-TEST000-${String(n).padStart(7, "0")}` },
    { relatedIdentifierName: "FINANCIAL_EVENT_GROUP_ID", relatedIdentifierValue: `group-${n}` },
  ],
  breakdowns: [
    { breakdownType: "Sales", breakdownAmount: { currencyAmount: 99.98, currencyCode: "USD" }, breakdowns: [] },
    { breakdownType: "Expenses", breakdownAmount: { currencyAmount: -15, currencyCode: "USD" }, breakdowns: [{ breakdownType: "AmazonFees", breakdownAmount: { currencyAmount: -15, currencyCode: "USD" } }] },
  ],
}));

/** SKU n in Amazon's warehouses: 10 + n units ready to ship. */
export const amazonStock = fixtureBuilder<AmazonMockStock>((n) => ({
  asin: `B0TEST${String(n).padStart(4, "0")}`,
  fnSku: `X00TEST${String(n).padStart(3, "0")}`,
  sellerSku: synthetic.sku(n),
  condition: "NewItem",
  lastUpdatedTime: at(n, 60_000),
  productName: `Test pendant ${n}`,
  totalQuantity: 14 + n,
  inventoryDetails: {
    fulfillableQuantity: 10 + n,
    inboundWorkingQuantity: 1,
    inboundShippedQuantity: 1,
    inboundReceivingQuantity: 0,
    reservedQuantity: { totalReservedQuantity: 1, pendingCustomerOrderQuantity: 1, pendingTransshipmentQuantity: 0, fcProcessingQuantity: 0 },
    unfulfillableQuantity: { totalUnfulfillableQuantity: 1, customerDamagedQuantity: 1 },
  },
  stores: [],
}));

export type AmazonRole = "orders" | "finance" | "inventory";

export interface AmazonMockData {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  orders: AmazonMockOrder[];
  transactions: AmazonMockTransaction[];
  stock: AmazonMockStock[];
  /** The marketplace the seller sells in. */
  marketplaceId?: string;
  /** The roles the app was authorized with. Defaults to all three. */
  roles?: AmazonRole[];
  /** Records per page the mock caps at, to exercise paging. */
  pageCap?: number;
  /** How many of the next SP-API calls answer 429. */
  throttled?: number;
  /** The clock, in epoch milliseconds. */
  now: () => number;
}

export interface AmazonMock {
  lwa: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  /** The path and query of every SP-API read, in order. */
  readonly reads: { path: string; query: URLSearchParams }[];
  /** How many access tokens LWA has handed out. */
  readonly refreshes: number;
  /** Makes every access token handed out so far expire. */
  expireAccessTokens(): void;
}

const fail = (status: number, code: string, message: string): DocMockResponse => ({ status, body: { errors: [{ code, message, details: "" }] } });
const pageToken = (key: string, offset: number, issued: number) => Buffer.from(`${createHash("sha256").update(key).digest("hex").slice(0, 8)}:${offset}:${issued}`).toString("base64url");
const isTime = (v: string | null) => v !== null && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const queryKey = (q: URLSearchParams, token: string) => [...q.entries()].filter(([k]) => k !== token).join("&");

export function amazonDocMock(data: AmazonMockData): AmazonMock {
  const reads: { path: string; query: URLSearchParams }[] = [];
  const access = new Map<string, number>();
  let refreshes = 0;
  const marketplace = data.marketplaceId ?? AMAZON_MOCK_MARKETPLACE;

  const lwa = checkDocMock({
    integration: "amazon",
    baseUrl: LWA,
    source: SOURCE,
    assumptions: ["A refresh token LWA doesn't know answers 400 invalid_grant, and a wrong client 401 invalid_client"],
    routes: [
      {
        method: "POST",
        path: "/token",
        documentedAt: CONNECT_DOC,
        respond(request) {
          if (!(request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) return { status: 400, body: { error: "invalid_request", error_description: "Content-Type must be application/x-www-form-urlencoded" } };
          const form = new URLSearchParams(request.body);
          if (form.get("grant_type") !== "refresh_token") return { status: 400, body: { error: "unsupported_grant_type", error_description: "grant_type" } };
          if (form.get("client_id") !== data.clientId || form.get("client_secret") !== data.clientSecret) return { status: 401, body: { error: "invalid_client", error_description: "Client authentication failed" } };
          if (form.get("refresh_token") !== data.refreshToken) return { status: 400, body: { error: "invalid_grant", error_description: "The request has an invalid grant parameter : refresh_token" } };
          refreshes++;
          const token = `Atza|${createHash("sha256").update(`access:${refreshes}`).digest("hex")}`;
          access.set(token, data.now() + 3_600_000);
          return { status: 200, body: { access_token: token, token_type: "bearer", expires_in: 3600, refresh_token: data.refreshToken } };
        },
      },
    ],
  });

  /** Checks shared by every SP-API call: the user-agent, the access token, the app's role and throttling. */
  function denied(request: DocMockRequest, role: AmazonRole): DocMockResponse | null {
    if (!request.headers.get("user-agent")) return fail(400, "InvalidInput", "A user-agent header is required.");
    const token = request.headers.get("x-amz-access-token") ?? "";
    const expiresAt = access.get(token);
    if (expiresAt === undefined) return fail(403, "Unauthorized", "The access token you provided is revoked, malformed or invalid.");
    if (expiresAt <= data.now()) return fail(403, "Unauthorized", "The access token you provided has expired.");
    if (!(data.roles ?? ["orders", "finance", "inventory"]).includes(role)) return fail(403, "Unauthorized", "Access to requested resource is denied.");
    if (data.throttled) {
      data.throttled--;
      return { status: 429, body: { errors: [{ code: "QuotaExceeded", message: "You exceeded your quota for the requested resource." }] }, headers: { "x-amzn-RateLimit-Limit": "0.0056" } };
    }
    return null;
  }

  /** The offset a page token stands for in this query, or an error answer. */
  function offsetOf(q: URLSearchParams, name: string, lifeMs?: number): number | DocMockResponse {
    const t = q.get(name);
    if (t === null) return 0;
    const parts = Buffer.from(t, "base64url").toString().split(":");
    if (parts.length !== 3 || t !== pageToken(queryKey(q, name), Number(parts[1]), Number(parts[2]))) return fail(400, "InvalidInput", `Invalid ${name}.`);
    if (lifeMs !== undefined && data.now() - Number(parts[2]) > lifeMs) return fail(400, "InvalidInput", `The ${name} has expired.`);
    return Number(parts[1]);
  }

  function page<T>(all: T[], q: URLSearchParams, name: string, size: number, offset: number): { items: T[]; next?: string } {
    const take = Math.min(size, data.pageCap ?? size);
    const items = all.slice(offset, offset + take);
    return { items, ...(offset + take < all.length ? { next: pageToken(queryKey(q, name), offset + take, data.now()) } : {}) };
  }

  const api = checkDocMock({
    integration: "amazon",
    baseUrl: API,
    source: SOURCE,
    assumptions: [
      "An expired access token answers 403 Unauthorized with a message saying it has expired",
      "An app without the role an operation needs answers 403 Unauthorized",
      "A page token is good only for the query it came from",
      "Orders come in the order Amazon last updated them, oldest first",
      "Transactions within a range come oldest first",
      "Array parameters are comma-separated",
    ],
    routes: [
      {
        method: "GET",
        path: "/orders/2026-01-01/orders",
        documentedAt: ORDERS_DOC,
        respond(request) {
          const no = denied(request, "orders");
          if (no) return no;
          const q = request.url.searchParams;
          reads.push({ path: "/orders", query: q });
          const created = q.has("createdAfter") || q.has("createdBefore");
          const updated = q.has("lastUpdatedAfter") || q.has("lastUpdatedBefore");
          if (created === updated || (created && !q.has("createdAfter")) || (updated && !q.has("lastUpdatedAfter"))) return fail(400, "InvalidInput", "Exactly one of createdAfter or lastUpdatedAfter is required.");
          const afterName = created ? "createdAfter" : "lastUpdatedAfter";
          const beforeName = created ? "createdBefore" : "lastUpdatedBefore";
          const after = q.get(afterName);
          const beforeRaw = q.get(beforeName);
          if (!isTime(after) || (beforeRaw !== null && !isTime(beforeRaw))) return fail(400, "InvalidInput", "Dates must be ISO 8601.");
          const before = beforeRaw === null ? data.now() - TWO_MINUTES : Date.parse(beforeRaw);
          if (before < Date.parse(after!) || before > data.now() - TWO_MINUTES) return fail(400, "InvalidInput", `${beforeName} must be on or after ${afterName} and at least two minutes before the request.`);
          const ids = (q.get("marketplaceIds") ?? "").split(",").filter(Boolean);
          if (!ids.length || ids.length > 50) return fail(400, "InvalidInput", "marketplaceIds is required.");
          if (!ids.includes(marketplace)) return fail(400, "InvalidInput", "The seller does not sell in that marketplace.");
          const size = Number(q.get("maxResultsPerPage") ?? 100);
          if (!Number.isInteger(size) || size < 1 || size > 100) return fail(400, "InvalidInput", "maxResultsPerPage must be 1 to 100.");
          const included = (q.get("includedData") ?? "").split(",").filter(Boolean);
          const allowed = ["BUYER", "RECIPIENT", "PROCEEDS", "EXPENSE", "PROMOTION", "CANCELLATION", "FULFILLMENT", "PACKAGES", "TAX", "PAYMENT", "FULFILLMENT_ORDERS"];
          if (included.some((d) => !allowed.includes(d))) return fail(400, "InvalidInput", "Unknown includedData value.");
          const offset = offsetOf(q, "paginationToken", DAY_MS);
          if (typeof offset !== "number") return offset;
          const field = created ? "createdTime" : "lastUpdatedTime";
          const all = data.orders
            .filter((o) => Date.parse(String(o[field])) >= Date.parse(after!) && Date.parse(String(o[field])) <= before)
            .sort((a, b) => Date.parse(String(a[field])) - Date.parse(String(b[field])));
          const optional = { BUYER: "buyer", RECIPIENT: "recipient", PROCEEDS: "proceeds", FULFILLMENT: "fulfillment", PACKAGES: "packages", TAX: "tax", PAYMENT: "payment" } as Record<string, string>;
          const strip = (o: AmazonMockOrder) => Object.fromEntries(Object.entries(o).filter(([k]) => !Object.entries(optional).some(([d, f]) => f === k && !included.includes(d))));
          const { items, next } = page(all, q, "paginationToken", size, offset);
          return { status: 200, body: { orders: items.map(strip), ...(next ? { pagination: { nextToken: next } } : {}), [created ? "createdBefore" : "lastUpdatedBefore"]: new Date(before).toISOString() } };
        },
      },
      {
        method: "GET",
        path: "/finances/2024-06-19/transactions",
        documentedAt: TRANSACTIONS_DOC,
        respond(request) {
          const no = denied(request, "finance");
          if (no) return no;
          const q = request.url.searchParams;
          reads.push({ path: "/transactions", query: q });
          const after = q.get("postedAfter");
          const beforeRaw = q.get("postedBefore");
          if (!isTime(after) || (beforeRaw !== null && !isTime(beforeRaw))) return fail(400, "InvalidInput", "postedAfter is required, and dates must be ISO 8601.");
          const before = beforeRaw === null ? data.now() - TWO_MINUTES : Date.parse(beforeRaw);
          if (before <= Date.parse(after!) || before > data.now() - TWO_MINUTES) return fail(400, "InvalidInput", "postedBefore must be after postedAfter and more than two minutes before the request.");
          if (q.has("marketplaceId") && q.get("marketplaceId") !== marketplace) return fail(400, "InvalidInput", "The seller does not sell in that marketplace.");
          const offset = offsetOf(q, "nextToken");
          if (typeof offset !== "number") return offset;
          // Wider than 180 days, Amazon answers with no transactions.
          const all =
            before - Date.parse(after!) > 180 * DAY_MS
              ? []
              : data.transactions.filter((t) => Date.parse(t.postedDate) >= Date.parse(after!) && Date.parse(t.postedDate) < before).sort((a, b) => Date.parse(a.postedDate) - Date.parse(b.postedDate));
          const { items, next } = page(all, q, "nextToken", 100, offset);
          return { status: 200, body: { payload: { transactions: items, ...(next ? { nextToken: next } : {}) } } };
        },
      },
      {
        method: "GET",
        path: "/fba/inventory/v1/summaries",
        documentedAt: INVENTORY_DOC,
        respond(request) {
          const no = denied(request, "inventory");
          if (no) return no;
          const q = request.url.searchParams;
          reads.push({ path: "/inventory", query: q });
          if (q.get("granularityType") !== "Marketplace") return fail(400, "InvalidInput", "granularityType must be Marketplace.");
          if (!q.get("granularityId") || !q.get("marketplaceIds") || q.get("marketplaceIds")!.split(",").length > 1) return fail(400, "InvalidInput", "granularityId and one marketplaceIds are required.");
          if (q.get("granularityId") !== marketplace || q.get("marketplaceIds") !== marketplace) return fail(400, "InvalidInput", "The seller does not sell in that marketplace.");
          const offset = offsetOf(q, "nextToken", 30_000);
          if (typeof offset !== "number") return offset;
          const details = q.get("details") === "true";
          const { items, next } = page(
            data.stock.map((s) => (details ? s : Object.fromEntries(Object.entries(s).filter(([k]) => k !== "inventoryDetails")))),
            q,
            "nextToken",
            50,
            offset,
          );
          return { status: 200, body: { payload: { granularity: { granularityType: "Marketplace", granularityId: marketplace }, inventorySummaries: items }, ...(next ? { pagination: { nextToken: next } } : {}) } };
        },
      },
    ],
  });

  const lwaFetch = docMockFetch(lwa);
  const apiFetch = docMockFetch(api);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const target = url.origin === new URL(LWA).origin ? lwaFetch : apiFetch;
      const response = await target(input, init);
      calls.push(...target.calls.slice(-1));
      return response;
    },
    { calls },
  );

  return {
    lwa,
    api,
    fetch,
    reads,
    get refreshes() {
      return refreshes;
    },
    expireAccessTokens: () => {
      for (const token of access.keys()) access.set(token, 0);
    },
  };
}

export default {
  integration: "amazon",
  covers: "Amazon's Selling Partner API orders search (v2026-01-01), finance transactions (v2024-06-19) and FBA inventory summaries, with the Login with Amazon token refresh, enforcing the access token header, the app's roles, date ranges, page sizes and page tokens tied to their query",
  watchPages: [CONNECT_DOC, ORDERS_DOC, TRANSACTIONS_DOC, INVENTORY_DOC],
  docMocks: () => {
    const mock = amazonDocMock({ clientId: "", clientSecret: "", refreshToken: "", orders: [], transactions: [], stock: [], now: () => 0 });
    return [mock.lwa, mock.api];
  },
} satisfies DocMockModule;
