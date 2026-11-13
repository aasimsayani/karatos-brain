import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Aurora Payments' API, which Aurora runs under its new name, Flute, built
 * from developer.flute.com. Data is synthetic. Flute offers a free sandbox;
 * until a sandbox account is set up, this mock stands in, and a sandbox run
 * confirms it.
 *
 * Docs facts the mock relies on:
 * - A token comes from POST /oauth2/token on oauth.api.flute.com
 *   (sandbox.oauth.api.flute.com for the sandbox), form-encoded, with the
 *   API key's client ID and secret as HTTP Basic, grant_type
 *   client_credentials and scope offline_access. It answers access_token,
 *   refresh_token, token_type Bearer and expires_in 900 (authentication).
 * - The API is at api.flute.com (sandbox.api.flute.com) and takes the token
 *   as a bearer JWT (api-reference).
 * - GET /pay-api/v1/settlements/batches takes page (from 0), pageSize,
 *   orderBy, asc, dateFrom and dateTo (ISO 8601), batchIds,
 *   paymentProcessorIds and statusId (1 open, 2 settled), and answers
 *   items and total. A batch has id, paymentProcessorId and Name,
 *   externalBatchId, batchDateTime, transactionCount, netAmount,
 *   refundsAmount and salesAmount in dollars, statusId and statusName
 *   (settlement-batches).
 * - GET /pay-api/v1/transactions takes page, pageSize, orderBy, asc,
 *   createMethodId, createdById, batchId and noBatch, and answers items and
 *   total. A transaction has id, date, base, total and surcharge amounts,
 *   currencyCode, the customer's name, company, email, phone and masked
 *   card, status, typeId (1 authorization, 2 sale, 3 capture, 4 void,
 *   5 refund, 6 verify), paymentMethodTypeId (1 card, 2 ACH), batchId,
 *   source and an amount breakdown (transactions).
 * - A key without the permission for an endpoint is answered 403
 *   (api-permissions).
 */
const DOCS = {
  authentication: "https://developer.flute.com/api-reference/authentication",
  batches: "https://developer.flute.com/api-reference/settlement-batches/flute-v1-get-pay-api-settlements-batches",
  transactions: "https://developer.flute.com/api-reference/transactions/flute-v1-get-pay-api-transactions",
  permissions: "https://developer.flute.com/docs/getting-started/api-permissions",
} as const;
export const AURORA_DOC_PAGES = DOCS;

export type AuroraMockRecord = Record<string, unknown>;

export interface AuroraMockData {
  clientId: string;
  clientSecret: string;
  batches: AuroraMockRecord[];
  transactions: AuroraMockRecord[];
  /** 429s to answer before the next reads. */
  rateLimits?: number;
  /** Lists the key may not read, answered 403. */
  forbidden?: ("batches" | "transactions")[];
  /** The tokens handed out are turned down this many times first, as if they ran out early. */
  expireTokens?: number;
  /** The sandbox hosts, not production. */
  sandbox?: boolean;
}

const uuid = (kind: number, n: number) => `${String(kind).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString();

/** A settled card batch `n` days into 2026: $1,299.75 in sales, $50 refunded. */
export const auroraBatch = fixtureBuilder<AuroraMockRecord>((n) => ({
  id: uuid(1, n),
  paymentProcessorId: uuid(9, 1),
  paymentProcessorName: "Test Processor",
  externalBatchId: String(4_821_000 + n).padStart(10, "0"),
  batchDateTime: at(n * 24 + 20),
  transactionCount: 2,
  netAmount: 1249.75,
  refundsAmount: 50,
  salesAmount: 1299.75,
  statusId: 2,
  statusName: "Settled",
}));

/** A $1,299.75 card sale in batch 1, with tax and a tip, from a test customer. */
export const auroraTransaction = fixtureBuilder<AuroraMockRecord>((n) => ({
  id: uuid(2, n),
  paymentProcessorId: uuid(9, 1),
  date: at(n),
  baseAmount: 1200,
  totalAmount: 1299.75,
  surchargeAmount: 0,
  surchargePercentage: 0,
  currencyId: 1,
  currencyCode: "USD",
  merchant: "Test Jeweler",
  merchantId: uuid(8, 1),
  operationMode: "PayNow",
  paymentMethodType: "Card",
  paymentMethodTypeId: 1,
  paymentMethodName: "Front counter card",
  customerName: "Test Customer",
  customerCompany: "Test Company",
  customerPan: "************4242",
  cardTokenType: 1,
  customerEmail: "customer@example.test",
  customerPhone: "+15550100000",
  status: "Captured",
  statusId: 2,
  typeId: 2,
  type: "Sale",
  batchId: uuid(1, 1),
  source: { typeId: 1, type: "Terminal", id: uuid(7, 1), name: "Counter terminal" },
  availableOperations: [{ typeId: 5, type: "Refund", availableAmount: 1299.75 }],
  amount: { baseAmount: 1200, percentageOffAmount: 0, percentageOffRate: 0, cashDiscountAmount: 0, cashDiscountRate: 0, surchargeAmount: 0, surchargeRate: 0, tipAmount: 0, tipRate: 0, taxAmount: 99.75, taxRate: 8.3125, totalAmount: 1299.75 },
}));

const error = (status: number, details: string): DocMockResponse => ({ status, body: { details, statusCode: status, source: "pay-api", exceptionType: "Error", correlationId: uuid(0, status), entityId: null, errorCode: status } });

export interface AuroraMock {
  oauth: DocMock;
  api: DocMock;
  /** Answers the sign-in and the API alike. */
  fetch: DocMockFetch;
  /** Each list read: its path and query. */
  readonly reads: { path: string; query: Record<string, string> }[];
  /** Tokens handed out. */
  readonly signIns: number;
}

export function auroraDocMock(data: AuroraMockData): AuroraMock {
  const hosts = data.sandbox ? { oauth: "https://sandbox.oauth.api.flute.com", api: "https://sandbox.api.flute.com" } : { oauth: "https://oauth.api.flute.com", api: "https://api.flute.com" };
  const reads: { path: string; query: Record<string, string> }[] = [];
  const live = new Set<string>();
  let limits = data.rateLimits ?? 0;
  let expire = data.expireTokens ?? 0;
  let signIns = 0;
  const oauth = checkDocMock({
    integration: "aurora_payments",
    baseUrl: hosts.oauth,
    auth: "basic",
    source: { url: DOCS.authentication, title: "Flute API authentication", retrievedOn: "2026-11-11", version: "v1" },
    assumptions: ["A wrong client ID or secret is answered 401", "expires_in is in seconds"],
    routes: [
      {
        method: "POST",
        path: "/oauth2/token",
        documentedAt: DOCS.authentication,
        respond(request) {
          const expected = `Basic ${Buffer.from(`${data.clientId}:${data.clientSecret}`).toString("base64")}`;
          if (request.headers.get("authorization") !== expected) return { status: 401, body: { error: "invalid_client" } };
          const form = new URLSearchParams(request.body);
          if (form.get("grant_type") !== "client_credentials" || !request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return { status: 400, body: { error: "unsupported_grant_type" } };
          signIns++;
          const token = `eyJ${"0".repeat(20)}.${signIns}`;
          live.add(token);
          return { status: 200, body: { access_token: token, refresh_token: `r${signIns}${"0".repeat(20)}`, token_type: "Bearer", expires_in: 900 } };
        },
      },
    ],
  });
  /** Pages of a list, after the token, the rate limit and the permission are checked. */
  function page(request: { headers: Headers; url: URL }, list: "batches" | "transactions", rows: AuroraMockRecord[]): DocMockResponse {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    if (!live.has(bearer)) return error(401, "Unauthorized");
    if (expire > 0) {
      expire--;
      live.delete(bearer);
      return error(401, "Token expired");
    }
    if (limits > 0) {
      limits--;
      return { status: 429, body: { details: "Too many requests" }, headers: { "retry-after": "1" } };
    }
    if (data.forbidden?.includes(list)) return error(403, "Forbidden");
    const query = Object.fromEntries(request.url.searchParams);
    reads.push({ path: request.url.pathname, query });
    const p = query.page === undefined ? 0 : Number(query.page);
    const size = query.pageSize === undefined ? 25 : Number(query.pageSize);
    if (!Number.isInteger(p) || p < 0 || !Number.isInteger(size) || size < 1) return error(400, "Bad page");
    const field = list === "batches" ? "batchDateTime" : "date";
    const sorted = [...rows].sort((x, y) => String(x[field]).localeCompare(String(y[field])) * (query.asc === "true" ? 1 : -1));
    return { status: 200, body: { items: sorted.slice(p * size, (p + 1) * size), total: rows.length } };
  }
  const api = checkDocMock({
    integration: "aurora_payments",
    baseUrl: hosts.api,
    auth: "bearer",
    source: { url: DOCS.batches, title: "Flute API reference", retrievedOn: "2026-11-11", version: "v1" },
    assumptions: [
      "dateFrom and dateTo match batchDateTime, both inclusive",
      "orderBy batchDateTime or date with asc true lists oldest first, in a stable order",
      "batchId on the transactions list matches a settlement batch's id, for card batches as well as ACH",
      "pageSize can be 50",
    ],
    routes: [
      {
        method: "GET",
        path: "/pay-api/v1/settlements/batches",
        documentedAt: DOCS.batches,
        respond(request) {
          const q = request.url.searchParams;
          const from = q.get("dateFrom") === null ? Number.NEGATIVE_INFINITY : Date.parse(q.get("dateFrom")!);
          const to = q.get("dateTo") === null ? Number.POSITIVE_INFINITY : Date.parse(q.get("dateTo")!);
          if (Number.isNaN(from) || Number.isNaN(to)) return error(400, "dateFrom and dateTo must be ISO 8601");
          return page(request, "batches", data.batches.filter((b) => Date.parse(String(b.batchDateTime)) >= from && Date.parse(String(b.batchDateTime)) <= to));
        },
      },
      {
        method: "GET",
        path: "/pay-api/v1/transactions",
        documentedAt: DOCS.transactions,
        respond(request) {
          const batchId = request.url.searchParams.get("batchId");
          return page(request, "transactions", batchId === null ? data.transactions : data.transactions.filter((t) => t.batchId === batchId));
        },
      },
    ],
  });
  const oauthFetch = docMockFetch(oauth);
  const apiFetch = docMockFetch(api);
  const route = (input: string | URL | Request, init?: RequestInit) => (new URL(input instanceof Request ? input.url : input).origin === hosts.oauth ? oauthFetch(input, init) : apiFetch(input, init));
  const fetch = Object.defineProperty(route, "calls", { get: () => [...oauthFetch.calls, ...apiFetch.calls] }) as DocMockFetch;
  return {
    oauth,
    api,
    fetch,
    get reads() {
      return reads;
    },
    get signIns() {
      return signIns;
    },
  };
}

export default {
  integration: "aurora_payments",
  covers: "Flute's (Aurora Payments') token, settlement batches and transactions (API v1)",
  watchPages: [DOCS.authentication, DOCS.batches, DOCS.transactions],
  docMocks: () => {
    const mock = auroraDocMock({ clientId: "", clientSecret: "", batches: [], transactions: [] });
    return [mock.oauth, mock.api];
  },
} satisfies DocMockModule;
