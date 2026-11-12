import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * The Extend merchant API endpoints a read-only connector uses, built from
 * Extend's API reference. Data is synthetic. Extend has a demo environment,
 * but its credentials come from a demo Merchant Portal account; once one is
 * set up, recordings replace this mock.
 *
 * Docs facts the mock relies on:
 * - Production is https://api.helloextend.com and demo
 *   https://api-demo.helloextend.com (getting-started-with-extends-api).
 * - `POST /auth/oauth/token` takes JSON {grant_type: "client_credentials",
 *   client_id, client_secret, client_assertion:
 *   "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"}; the token
 *   goes in `X-Extend-Access-Token` (reference/authentication).
 * - Requests send Content-Type, X-Extend-Access-Token and an Accept such as
 *   `application/json; version=2022-02-01`.
 * - `GET /contracts/search` takes sellerId (required), typeFilter (pcrs,
 *   shipping_protection, category), status, showAll and others, and
 *   answers {contracts} with no paging. Contract times are 13-digit epoch
 *   milliseconds; errors are {code, message} with 400, 403 or 404
 *   (reference/contractssearch).
 * - `GET /orders/search` takes one search parameter, such as storeId, and
 *   answers {nextPageCursor, limit, orders}, each order with lineItems as
 *   ids and integer totals; its time example is 10 digits
 *   (reference/orderssearch).
 */
export const EXTEND_DOC_PAGES = {
  contracts: "https://docs.extend.com/reference/contractssearch.md",
  authentication: "https://docs.extend.com/reference/authentication.md",
  orders: "https://docs.extend.com/reference/orderssearch.md",
} as const;
export const EXTEND_MOCK_BASES = { production: "https://api.helloextend.com", demo: "https://api-demo.helloextend.com" } as const;
const ASSERTION = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const VERSION = /^application\/json; ?version=\d{4}-\d{2}-\d{2}$/;
const CONTRACT_QUERY = new Set(["typeFilter", "contractId", "customerEmail", "customerPhone", "merchantCustomerId", "productSerialNumber", "productTransactionId", "sellerId", "status", "transactionId", "showAll"]);
const ORDER_SEARCH = new Set(["storeId", "transactionId", "customerPhone", "customerEmail", "giftRecipientEmail", "merchantCustomerId"]);
const TYPES = new Set(["pcrs", "shipping_protection", "category"]);
/** The page size the docs' limit example gives. */
export const EXTEND_MOCK_PAGE_SIZE = 500;

export type ExtendMockRecord = Record<string, unknown>;

const pad = (n: number, width: number) => String(n).padStart(width, "0");
/** A UUID-shaped id whose last group holds letters, so no long digit run appears. */
export const extendUuid = (prefix: string, n: number) => `${prefix.padEnd(8, "0").slice(0, 8)}-a000-4000-a000-aaaaaaaa${pad(n, 4)}`;
/** The store the fixtures belong to. */
export const EXTEND_MOCK_STORE = extendUuid("5e11e0", 1);
const ms = (minutes: number) => Date.parse(synthetic.isoTime(minutes));

/** Contract `n`: a live product protection plan sold `n` hours into 2026 with order `n`, for a customer the connector must drop. */
export const extendContract = fixtureBuilder<ExtendMockRecord>((n) => ({
  id: extendUuid("c0", n),
  accountId: extendUuid("acc", 1),
  adminSyncStatus: "synced",
  status: "live",
  type: "pcrs",
  isTest: false,
  sellerId: EXTEND_MOCK_STORE,
  sellerName: "Test Jeweler",
  transactionId: `TEST-ORDER-${n}`,
  orderId: extendUuid("0d", n),
  merchantCustomerId: `cust-${n}`,
  purchaseCurrency: "USD",
  purchasePrice: 4900 + n,
  listPrice: 5900,
  purchaseDate: ms(n * 60),
  createdAt: ms(n * 60),
  updatedAt: ms(n * 60 + 30),
  customer: {
    name: synthetic.name(n),
    email: synthetic.email(n),
    phone: synthetic.phone(n),
    type: "consumer",
    billingAddress: { address1: `${n} Test Street`, city: "Testville", countryCode: "US", postalCode: "00000" },
  },
  product: {
    referenceId: synthetic.sku(n),
    name: `Test ring ${n}`,
    purchasePrice: 120000 + n,
    listPrice: 125000,
    serialNumber: `TEST-SERIAL-${n}`,
    purchaseDate: ms(n * 60),
    fulfillmentDate: ms(n * 60 + 1440),
    manufacturerWarrantyLengthParts: 12,
    manufacturerWarrantyLengthLabor: 12,
  },
  plan: { id: "10001-jewelry-adh-replace-3y", category: "service_contract", termsId: "TEST-TERMS", termsVersion: "2", version: 2 },
  planDetails: { term_length: 36, service_type: "repair", coverage_includes: "adh" },
  coverage: { starts: ms(n * 60), ends: ms(n * 60 + 3 * 525_600), status: "covered_by_adh_and_base_protection_by_extend" },
  contractTermsLink: `https://customers.extend.test/plans/${n}`,
}));

/** Order `n`: open, made `n` hours into 2026, with one line item and a customer the connector must drop. Its times are 10-digit seconds, as the docs' example. */
export const extendOrder = fixtureBuilder<ExtendMockRecord>((n) => ({
  id: extendUuid("0d", n),
  currency: "USD",
  status: "open",
  storeId: EXTEND_MOCK_STORE,
  storeName: "Test Jeweler",
  transactionId: `TEST-ORDER-${n}`,
  merchantCustomerId: `cust-${n}`,
  poNumber: `PO-TEST-${n}`,
  isTest: false,
  lineItems: [extendUuid("11", n)],
  productCostTotal: 120000 + n,
  shippingCostTotal: 0,
  shippingTaxCostTotal: 0,
  taxCostTotal: 9600,
  discountAmountTotal: 0,
  total: 129600 + n,
  createdAt: ms(n * 60) / 1000,
  updatedAt: ms(n * 60 + 30) / 1000,
  customer: { name: synthetic.name(n), email: synthetic.email(n), phone: synthetic.phone(n) },
  gift: { recipient: { email: `gift${n}@example.test`, name: "Test Recipient" } },
}));

export interface ExtendMockData {
  clientId: string;
  clientSecret: string;
  /** The store the API Integration was made for. Defaults to EXTEND_MOCK_STORE. */
  storeId?: string;
  /** Production or demo. Defaults to production. */
  baseUrl?: string;
  contracts?: ExtendMockRecord[];
  orders?: ExtendMockRecord[];
  /** Orders a page. Defaults to 500. */
  pageSize?: number;
  /** Seconds a token lasts, as expires_in, or null to leave it out. Defaults to 3600. */
  expiresIn?: number | null;
  /** 429s to answer before the next calls. */
  rateLimits?: number;
}

export interface ExtendMock {
  mock: DocMock;
  fetch: DocMockFetch;
  /** Each token request answered with a token. */
  readonly tokens: Record<string, unknown>[];
  /** Each search answered with results: its path and query. */
  readonly reads: { path: string; query: Record<string, string> }[];
}

const error = (status: number, code: string, message: string, headers?: Record<string, string>): DocMockResponse => ({ status, body: { code, message }, ...(headers ? { headers } : {}) });
const encode = (offset: number, order: ExtendMockRecord | undefined) => Buffer.from(JSON.stringify({ createdAt: order?.createdAt, itemId: order?.id, offset })).toString("base64");
function decode(cursor: string): number | null {
  try {
    const offset = (JSON.parse(Buffer.from(cursor, "base64").toString()) as { offset?: unknown }).offset;
    return Number.isSafeInteger(offset) && (offset as number) > 0 ? (offset as number) : null;
  } catch {
    return null;
  }
}

export function extendDocMock(data: ExtendMockData): ExtendMock {
  const base = data.baseUrl ?? EXTEND_MOCK_BASES.production;
  const store = data.storeId ?? EXTEND_MOCK_STORE;
  const size = data.pageSize ?? EXTEND_MOCK_PAGE_SIZE;
  const tokens: Record<string, unknown>[] = [];
  const reads: ExtendMock["reads"] = [];
  const issued = new Set<string>();
  let limits = data.rateLimits ?? 0;
  const limited = (): DocMockResponse | null => {
    if (limits <= 0) return null;
    limits--;
    return error(429, "too_many_requests", "Too many requests", { "retry-after": "1" });
  };
  /** Checks the token and headers a search needs, or the error to answer. */
  const checked = (request: DocMockRequest): DocMockResponse | null => {
    if (!issued.has(request.headers.get("x-extend-access-token") ?? "")) return error(401, "unauthorized", "Unauthorized");
    if (!VERSION.test(request.headers.get("accept") ?? "")) return error(400, "invalid_version", "Accept must name an API version");
    return limited();
  };

  const mock = checkDocMock({
    integration: "extend",
    baseUrl: base,
    source: { url: EXTEND_DOC_PAGES.contracts, title: "Extend API reference: Search Contracts", retrievedOn: "2026-11-11", version: "2022-02-01" },
    assumptions: [
      "The token answer is {access_token, token_type, expires_in}; the docs show no token response",
      "A token Extend no longer takes is answered 401, and bad client credentials 401 {code, message}",
      "Searching contracts or orders of a store the API Integration wasn't made for answers 403",
      "The contract search answers every matching contract at once; the docs give it no paging",
      "The order search takes nextPageCursor back as cursor, the name the line item search gives it",
      "Orders are listed oldest first by createdAt, and their times are epoch seconds as the docs' example",
      "Money is in the currency's smallest unit, as the line item and service order pages say",
    ],
    routes: [
      {
        method: "POST",
        path: "/auth/oauth/token",
        documentedAt: EXTEND_DOC_PAGES.authentication,
        respond(request) {
          if (!/^application\/json/.test(request.headers.get("content-type") ?? "")) return error(400, "invalid_request", "Content-Type must be application/json");
          let form: Record<string, unknown>;
          try {
            form = JSON.parse(request.body) as Record<string, unknown>;
          } catch {
            return error(400, "invalid_request", "Body must be JSON");
          }
          if (form.grant_type !== "client_credentials" || form.client_assertion !== ASSERTION) return error(400, "invalid_request", "Unsupported grant");
          if (form.client_id !== data.clientId || form.client_secret !== data.clientSecret) return error(401, "invalid_client", "Invalid client credentials");
          const hit = limited();
          if (hit) return hit;
          tokens.push({ grant_type: form.grant_type, client_assertion: form.client_assertion });
          const token = `mock.token.${pad(tokens.length, 8)}`;
          issued.add(token);
          const expiresIn = data.expiresIn === undefined ? 3600 : data.expiresIn;
          return { status: 200, body: { access_token: token, token_type: "Bearer", ...(expiresIn === null ? {} : { expires_in: expiresIn }) } };
        },
      },
      {
        method: "GET",
        path: "/contracts/search",
        documentedAt: EXTEND_DOC_PAGES.contracts,
        respond(request) {
          const stop = checked(request);
          if (stop) return stop;
          const q = Object.fromEntries(request.url.searchParams);
          const unknown = Object.keys(q).find((k) => !CONTRACT_QUERY.has(k));
          if (unknown) return error(400, "invalid_parameter", `Unknown parameter ${unknown}`);
          if (!q.sellerId) return error(400, "missing_parameter", "sellerId is required");
          if (q.sellerId !== store) return error(403, "forbidden", "Forbidden");
          const types = (q.typeFilter ?? "pcrs").split(",");
          if (!types.every((t) => TYPES.has(t))) return error(400, "invalid_parameter", "Invalid typeFilter");
          if (q.showAll !== undefined && q.showAll !== "true" && q.showAll !== "false") return error(400, "invalid_parameter", "Invalid showAll");
          reads.push({ path: "/contracts/search", query: q });
          const contracts = (data.contracts ?? []).filter((c) => types.includes(String(c.type)) && (q.status === undefined || c.status === q.status));
          return { status: 200, body: { contracts } };
        },
      },
      {
        method: "GET",
        path: "/orders/search",
        documentedAt: EXTEND_DOC_PAGES.orders,
        respond(request) {
          const stop = checked(request);
          if (stop) return stop;
          const q = Object.fromEntries(request.url.searchParams);
          const keys = Object.keys(q).filter((k) => k !== "cursor");
          const unknown = keys.find((k) => !ORDER_SEARCH.has(k));
          if (unknown) return error(400, "invalid_parameter", `Unknown parameter ${unknown}`);
          if (keys.length !== 1) return error(400, "invalid_parameter", "Send one search parameter per request");
          if (q.storeId === undefined) return error(400, "invalid_parameter", "This mock answers only a search by storeId");
          if (q.storeId !== store) return error(403, "forbidden", "Forbidden");
          const offset = q.cursor === undefined ? 0 : decode(q.cursor);
          if (offset === null) return error(400, "invalid_cursor", "Invalid cursor");
          reads.push({ path: "/orders/search", query: q });
          const orders = [...(data.orders ?? [])].sort((a, b) => Number(a.createdAt) - Number(b.createdAt) || String(a.id).localeCompare(String(b.id)));
          const page = orders.slice(offset, offset + size);
          const more = offset + size < orders.length;
          return { status: 200, body: { limit: size, orders: page, ...(more ? { nextPageCursor: encode(offset + size, page.at(-1)) } : {}) } };
        },
      },
    ],
  });
  return {
    mock,
    fetch: docMockFetch(mock),
    get tokens() {
      return tokens;
    },
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "extend",
  covers: "Extend's token, contract search and order search endpoints (API version 2022-02-01), with the X-Extend-Access-Token header",
  watchPages: [EXTEND_DOC_PAGES.contracts, EXTEND_DOC_PAGES.authentication, EXTEND_DOC_PAGES.orders],
  docMocks: () => [extendDocMock({ clientId: "", clientSecret: "" }).mock],
} satisfies DocMockModule;
