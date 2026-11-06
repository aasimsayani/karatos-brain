import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * eBay's Fulfillment API (Sell APIs, v1) getOrders and its OAuth refresh,
 * built from eBay's developer docs. Data is synthetic: each order holds the
 * buyer's details, as eBay's do, so a test can show none of them is kept.
 *
 * - getOrders: GET /sell/fulfillment/v1/order with `filter`
 *   (creationdate:[from..until] or lastmodifieddate:[from..until]), `limit`
 *   (up to 200) and `offset`; answers `orders`, left out when none match,
 *   with `total`, `limit`, `offset` and `next` while orders remain. Needs
 *   sell.fulfillment.readonly or sell.fulfillment.
 *   https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/methods/getOrders
 * - Adding a shipment: POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment
 *   needs sell.fulfillment. The mock counts each call, so a test can show
 *   the connector never sends one.
 *   https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/shipping_fulfillment/methods/createShippingFulfillment
 * - Refresh: POST /identity/v1/oauth2/token with Basic client credentials,
 *   grant_type=refresh_token and `scope`, which may name only scopes the
 *   seller agreed to; the access token holds just those. The answer has no
 *   scope field and no new refresh token.
 *   https://developer.ebay.com/api-docs/static/oauth-refresh-token-request.html
 */
const HOST = "https://api.ebay.com";
const FULFILLMENT = `${HOST}/sell/fulfillment/v1`;
const OAUTH = `${HOST}/identity/v1/oauth2`;
const SCOPE = "https://api.ebay.com/oauth/api_scope";

export const EBAY_MOCK_SCOPES = { read: `${SCOPE}/sell.fulfillment.readonly`, write: `${SCOPE}/sell.fulfillment` } as const;

/** An order as eBay writes it, trimmed to the fields the mock knows. */
export type EbayMockOrder = Record<string, unknown> & { orderId: string; creationDate: string; lastModifiedDate: string };

const money = (cents: number, currency = "USD") => ({ value: (cents / 100).toFixed(2), currency });

/** Order n, created n hours after 2026-10-01 and changed a day later: one paid line, its buyer's details included. */
export const ebayOrder = fixtureBuilder<EbayMockOrder>((n) => {
  const created = Date.parse("2026-10-01T00:00:00.000Z") + n * 3_600_000;
  const cents = 25_000 + n * 100;
  return {
    orderId: `0${n % 10}-${String(10_000 + n)}-${String(20_000 + n)}`,
    legacyOrderId: `11000${n}-22000${n}`,
    creationDate: new Date(created).toISOString(),
    lastModifiedDate: new Date(created + 86_400_000).toISOString(),
    orderFulfillmentStatus: "FULFILLED",
    orderPaymentStatus: "PAID",
    sellerId: "test_seller",
    buyer: { username: `test_buyer_${n}`, taxAddress: { stateOrProvince: "NY", postalCode: "10001", countryCode: "US" }, buyerRegistrationAddress: { fullName: `Test Buyer ${n}`, email: `buyer${n}@example.test`, primaryPhone: { phoneNumber: "555-0100" } } },
    buyerCheckoutNotes: "Test note: please gift wrap",
    cancelStatus: { cancelState: "NONE_REQUESTED", cancelRequests: [] },
    pricingSummary: { priceSubtotal: money(cents), deliveryCost: money(0), total: money(cents) },
    paymentSummary: { payments: [{ paymentMethod: "EBAY", paymentStatus: "PAID", amount: money(cents) }], refunds: [], totalDueSeller: money(cents - 3_300) },
    totalMarketplaceFee: money(3_300),
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: `Test Buyer ${n}`, contactAddress: { addressLine1: "1 Test Street", city: "Testville", postalCode: "10001", countryCode: "US" }, primaryPhone: { phoneNumber: "555-0100" }, email: `buyer${n}@example.test` } } }],
    lineItems: [{ lineItemId: String(9_000_000_000 + n), legacyItemId: String(100_000_000_000 + n), sku: `TEST-RING-${n}`, title: `Test estate ring ${n}`, quantity: 1, lineItemCost: money(cents), discountedLineItemCost: money(cents), total: money(cents), refunds: [], lineItemFulfillmentStatus: "FULFILLED" }],
  };
});

export interface EbayMockData {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  orders: EbayMockOrder[];
  /** Scopes the seller agreed to. Defaults to the read scope. */
  grantedScopes?: string[];
  /** How many of the next getOrders calls answer 429. */
  rateLimited?: number;
}

export interface EbayMock {
  oauth: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  /** The form of every refresh, in order. */
  readonly refreshes: URLSearchParams[];
  /** The query of every getOrders call, in order. */
  readonly reads: URLSearchParams[];
  /** How many shipping fulfillments were sent. */
  readonly writes: number;
  revokeAccessTokens(): void;
}

const ebayError = (status: number, errorId: number, message: string): DocMockResponse => ({ status, body: { errors: [{ errorId, domain: "API_FULFILLMENT", category: "REQUEST", message }] } });
const FILTER = /^(creationdate|lastmodifieddate):\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)?\.\.(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)?\]$/;

export function ebayDocMock(data: EbayMockData): EbayMock {
  const refreshes: URLSearchParams[] = [];
  const reads: URLSearchParams[] = [];
  let writes = 0;
  let issued = 0;
  const access = new Map<string, string[]>();
  const granted = () => data.grantedScopes ?? [EBAY_MOCK_SCOPES.read];

  const oauth = checkDocMock({
    integration: "ebay",
    baseUrl: OAUTH,
    source: { url: "https://developer.ebay.com/api-docs/static/oauth-refresh-token-request.html", title: "Refreshing a User access token", retrievedOn: "2026-10-30", version: "OAuth 2.0" },
    auth: "basic",
    assumptions: [
      "A refresh may name only scopes the seller agreed to, and the access token holds just those",
      "A refresh answers access_token, expires_in (7200) and token_type, with no scope and no new refresh token",
      "An expired or revoked refresh token answers 400 invalid_grant",
    ],
    routes: [
      {
        method: "POST",
        path: "/token",
        documentedAt: "https://developer.ebay.com/api-docs/static/oauth-refresh-token-request.html",
        respond(request) {
          const form = new URLSearchParams(request.body);
          refreshes.push(form);
          if (request.headers.get("authorization") !== `Basic ${Buffer.from(`${data.clientId}:${data.clientSecret}`).toString("base64")}`) return { status: 401, body: { error: "invalid_client", error_description: "client authentication failed" } };
          if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== data.refreshToken) return { status: 400, body: { error: "invalid_grant", error_description: "the provided authorization refresh token is invalid or was issued to another client" } };
          const asked = (form.get("scope") ?? "").split(" ").filter(Boolean);
          if (!asked.length || !asked.every((s) => granted().includes(s))) return { status: 400, body: { error: "invalid_scope", error_description: "The requested scope is invalid, unknown, malformed, or exceeds the scope granted to the client" } };
          const token = `v^1.1#i^1#TEST-${++issued}`;
          access.set(token, asked);
          return { status: 200, body: { access_token: token, expires_in: 7200, token_type: "User Access Token" } };
        },
      },
    ],
  });

  /** The scopes the request's token holds, or an error answer. */
  function scopesOf(request: { headers: Headers }): string[] | DocMockResponse {
    const scopes = access.get(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    return scopes ?? ebayError(401, 1001, "Invalid access token");
  }

  const api = checkDocMock({
    integration: "ebay",
    baseUrl: FULFILLMENT,
    source: { url: "https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/methods/getOrders", title: "getOrders", retrievedOn: "2026-10-30", version: "v1" },
    auth: "bearer",
    assumptions: [
      "Amounts are objects of a decimal string value and a currency code",
      "lineItemCost is the unit price times the quantity, before discounts",
      "orders is left out when none match, and total still counts them",
      "Orders older than two years can't be read",
      "Running out of calls answers HTTP 429",
    ],
    routes: [
      {
        method: "GET",
        path: "/order",
        documentedAt: "https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/methods/getOrders",
        respond(request) {
          const scopes = scopesOf(request);
          if (!Array.isArray(scopes)) return scopes;
          if (!scopes.some((s) => s === EBAY_MOCK_SCOPES.read || s === EBAY_MOCK_SCOPES.write)) return ebayError(403, 1100, "Access denied: Insufficient permissions to fulfill the request.");
          if (data.rateLimited) {
            data.rateLimited--;
            return ebayError(429, 2001, "Too many requests. The request limit has been reached for the resource.");
          }
          const q = new URL(request.url).searchParams;
          reads.push(q);
          const limit = Number(q.get("limit") ?? 50);
          const offset = Number(q.get("offset") ?? 0);
          if (!Number.isInteger(limit) || limit < 1 || limit > 200) return ebayError(400, 32800, "Invalid limit. Supported ranges 1 - 200.");
          if (!Number.isInteger(offset) || offset < 0) return ebayError(400, 32700, "Invalid offset.");
          const m = FILTER.exec(q.get("filter") ?? "");
          if (q.has("filter") && !m) return ebayError(400, 30850, "Invalid filter.");
          const key = m?.[1] === "lastmodifieddate" ? "lastModifiedDate" : "creationDate";
          const from = m?.[2] ?? "";
          const until = m?.[3] ?? "9999";
          if (until < from) return ebayError(400, 30850, "Invalid filter.");
          const matched = data.orders.filter((o) => o[key] >= from && o[key] <= until).sort((a, b) => (a.creationDate < b.creationDate ? -1 : a.creationDate > b.creationDate ? 1 : 0));
          const page = matched.slice(offset, offset + limit);
          const self = `${FULFILLMENT}/order?${q}`;
          return {
            status: 200,
            body: {
              href: self,
              total: matched.length,
              limit,
              offset,
              ...(page.length ? { orders: page } : {}),
              ...(offset + limit < matched.length ? { next: `${FULFILLMENT}/order?filter=${encodeURIComponent(q.get("filter") ?? "")}&limit=${limit}&offset=${offset + limit}` } : {}),
            },
          };
        },
      },
      {
        method: "POST",
        path: "/order/{orderId}/shipping_fulfillment",
        documentedAt: "https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/shipping_fulfillment/methods/createShippingFulfillment",
        respond(request) {
          writes++;
          const scopes = scopesOf(request);
          if (!Array.isArray(scopes)) return scopes;
          if (!scopes.some((s) => s === EBAY_MOCK_SCOPES.write)) return ebayError(403, 1100, "Access denied: Insufficient permissions to fulfill the request.");
          return { status: 201 };
        },
      },
    ],
  });

  const mocks = [
    { base: OAUTH, fetch: docMockFetch(oauth) },
    { base: FULFILLMENT, fetch: docMockFetch(api) },
  ];
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // Routed by exact origin and path, so a look-alike host goes to the Fulfillment mock and is turned down there.
      const target = mocks.find((m) => url.origin === new URL(m.base).origin && url.pathname.startsWith(new URL(m.base).pathname)) ?? mocks[1]!;
      const response = await target.fetch(input, init);
      calls.push(...target.fetch.calls.slice(-1));
      return response;
    },
    { calls },
  );

  return {
    oauth,
    api,
    fetch,
    refreshes,
    reads,
    get writes() {
      return writes;
    },
    revokeAccessTokens: () => access.clear(),
  };
}

export default {
  integration: "ebay",
  covers: "eBay's Fulfillment API getOrders and createShippingFulfillment (Sell APIs, v1) with its OAuth refresh, enforcing the client credentials, the scopes the seller agreed to, the order filter, limit and offset",
  watchPages: [
    "https://developer.ebay.com/api-docs/static/oauth-refresh-token-request.html",
    "https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/methods/getOrders",
    "https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/shipping_fulfillment/methods/createShippingFulfillment",
  ],
  docMocks: () => {
    const mock = ebayDocMock({ clientId: "", clientSecret: "", refreshToken: "", orders: [] });
    return [mock.oauth, mock.api];
  },
} satisfies DocMockModule;
