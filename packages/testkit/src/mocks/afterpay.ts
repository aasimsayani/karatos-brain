import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * Afterpay's (Cash App Afterpay's) List Payments, built from its developer
 * docs. Data is synthetic. Sandbox credentials come from an Afterpay account
 * manager; once a pair is set up, recordings replace this mock.
 *
 * Docs facts the mock relies on:
 * - Production https://global-api.afterpay.com and sandbox
 *   https://global-api-sandbox.afterpay.com (reference/introduction).
 * - HTTP Basic auth, the Merchant ID as the user and the Secret Key as the
 *   password; a bad pair answers 401 unauthorized (introduction/authentication,
 *   introduction/errors).
 * - `GET /v2/payments` takes fromCreatedDate and toCreatedDate (inclusive,
 *   ISO 8601), tokens, ids, merchantReferences, statuses, orderBy
 *   (createdAt by default, id, amount, merchantReference, email), ascending
 *   (false by default), limit (1 to 250, 20 by default), offset (0 or more)
 *   and includeNextLink, and needs a User-Agent. It answers totalResults,
 *   offset, limit and results, plus nextPageUrl when asked (payments/list-payments).
 * - A payment has id, token, status (APPROVED or DECLINED), created,
 *   originalAmount, openToCaptureAmount, paymentState (AUTH_APPROVED,
 *   AUTH_DECLINED, PARTIALLY_CAPTURED, CAPTURED, CAPTURE_DECLINED, VOIDED,
 *   EXPIRED, REVERSED), merchantReference, refunds, orderDetails and events
 *   (data-models/payment-object).
 * - Money is {amount: "29.99", currency} (data-models/money-object); a
 *   refund has requestId, amount, merchantReference, refundId, refundedAt
 *   and refundMerchantReference (data-models/refund-object).
 * - Errors are {errorCode, errorId, message, httpStatusCode} (introduction/errors).
 */
const PRODUCTION = "https://global-api.afterpay.com";
const SANDBOX = "https://global-api-sandbox.afterpay.com";
const REF = "https://developers.cash.app/afterpay/api-reference/reference";
export const AFTERPAY_DOC_PAGES = {
  introduction: `${REF}/introduction`,
  authentication: `${REF}/introduction/authentication`,
  errors: `${REF}/introduction/errors`,
  listPayments: `${REF}/payments/list-payments`,
  payment: `${REF}/data-models/payment-object`,
  money: `${REF}/data-models/money-object`,
  refund: `${REF}/data-models/refund-object`,
} as const;
const ORDER_BY = new Set(["createdAt", "id", "amount", "merchantReference", "email"]);
const QUERY = new Set(["fromCreatedDate", "toCreatedDate", "tokens", "ids", "merchantReferences", "statuses", "orderBy", "ascending", "limit", "offset", "includeNextLink"]);

export type AfterpayMockRecord = Record<string, unknown>;

/** Payment `n`: $n00.00, created `n` hours into 2026, captured, with the shopper's details the connector must drop. */
export const afterpayPayment = fixtureBuilder<AfterpayMockRecord>((n) => ({
  id: String(100100 + n),
  token: `tok_${n}`,
  status: "APPROVED",
  created: synthetic.isoTime(n * 60),
  originalAmount: { amount: `${n}00.00`, currency: "USD" },
  openToCaptureAmount: { amount: "0.00", currency: "USD" },
  paymentState: "CAPTURED",
  merchantReference: `ORDER-${n}`,
  refunds: [],
  orderDetails: { consumer: { givenNames: synthetic.name(n), surname: "Tester", email: synthetic.email(n), phoneNumber: "555-0100" }, items: [{ name: "Test ring", sku: `SKU-${n}` }] },
  events: [{ id: `ev-${n}`, created: synthetic.isoTime(n * 60), type: "CAPTURED", amount: { amount: `${n}00.00`, currency: "USD" } }],
}));

export interface AfterpayMockData {
  merchantId: string;
  secretKey: string;
  /** Which host the pair is for. Defaults to sandbox. */
  environment?: "production" | "sandbox";
  payments?: AfterpayMockRecord[];
  /** 429s to answer before the next calls. */
  rateLimits?: number;
}

export interface AfterpayMock {
  production: DocMock;
  sandbox: DocMock;
  fetch: DocMockFetch;
  /** Each List Payments call: its window and offset. */
  readonly reads: { from: string; to: string; offset: number; limit: number }[];
}

const apiError = (status: number, errorCode: string, message: string, headers?: Record<string, string>): DocMockResponse => ({ status, body: { errorCode, errorId: `err-${status}`, message, httpStatusCode: status }, ...(headers ? { headers } : {}) });
const isoTime = (v: string | null) => (v !== null && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : null);

export function afterpayDocMock(data: AfterpayMockData): AfterpayMock {
  const reads: AfterpayMock["reads"] = [];
  let limits = data.rateLimits ?? 0;
  const expected = `Basic ${Buffer.from(`${data.merchantId}:${data.secretKey}`).toString("base64")}`;

  function list(environment: "production" | "sandbox") {
    return (request: DocMockRequest): DocMockResponse => {
      if (request.headers.get("authorization") !== expected || (data.environment ?? "sandbox") !== environment) return apiError(401, "unauthorized", "Credentials are required to access this resource.");
      if (!request.headers.get("user-agent")) return apiError(400, "invalid_request", "A User-Agent header is required.");
      if (limits > 0) {
        limits--;
        return apiError(429, "too_many_requests", "Too many requests.", { "retry-after": "1" });
      }
      const q = request.url.searchParams;
      if ([...q.keys()].some((k) => !QUERY.has(k))) return apiError(422, "invalid_object", "Unknown query parameter.");
      const limit = q.get("limit") === null ? 20 : Number(q.get("limit"));
      const offset = q.get("offset") === null ? 0 : Number(q.get("offset"));
      const orderBy = q.get("orderBy") ?? "createdAt";
      const ascending = q.get("ascending") ?? "false";
      const from = q.get("fromCreatedDate") === null ? Number.NEGATIVE_INFINITY : isoTime(q.get("fromCreatedDate"));
      const to = q.get("toCreatedDate") === null ? Number.POSITIVE_INFINITY : isoTime(q.get("toCreatedDate"));
      if (!Number.isInteger(limit) || limit < 1 || limit > 250 || !Number.isInteger(offset) || offset < 0 || !ORDER_BY.has(orderBy) || !["true", "false"].includes(ascending) || from === null || to === null) {
        return apiError(422, "invalid_object", "A query parameter is not valid.");
      }
      reads.push({ from: q.get("fromCreatedDate") ?? "", to: q.get("toCreatedDate") ?? "", offset, limit });
      const all = (data.payments ?? [])
        .filter((p) => Date.parse(String(p.created)) >= from && Date.parse(String(p.created)) <= to)
        .sort((a, b) => String(a.created).localeCompare(String(b.created)) * (ascending === "true" ? 1 : -1));
      return { status: 200, body: { totalResults: all.length, offset, limit, results: all.slice(offset, offset + limit) } };
    };
  }

  const mock = (environment: "production" | "sandbox") =>
    checkDocMock({
      integration: "afterpay",
      baseUrl: environment === "production" ? PRODUCTION : SANDBOX,
      source: { url: AFTERPAY_DOC_PAGES.listPayments, title: "Cash App Afterpay API reference: List Payments", retrievedOn: "2026-11-11", version: "v2" },
      auth: "basic",
      assumptions: ["Ordering by createdAt is stable for payments created at the same moment", "Afterpay publishes no rate limit; a 429 carries Retry-After"],
      routes: [{ method: "GET", path: "/v2/payments", documentedAt: AFTERPAY_DOC_PAGES.listPayments, respond: list(environment) }],
    });
  const production = mock("production");
  const sandbox = mock("sandbox");
  const fetches = [docMockFetch(production), docMockFetch(sandbox)];
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      // An unknown host goes to the production mock, which refuses it.
      const f = fetches[url.startsWith(`${SANDBOX}/`) ? 1 : 0]!;
      const response = await f(input, init);
      calls.push(...f.calls.slice(-1));
      return response;
    },
    { calls },
  );
  return {
    production,
    sandbox,
    fetch,
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "afterpay",
  covers: "Afterpay's List Payments on its production and sandbox hosts, with Basic auth, created-date windows, ordering, limit and offset",
  watchPages: [AFTERPAY_DOC_PAGES.listPayments],
  docMocks: () => {
    const mock = afterpayDocMock({ merchantId: "", secretKey: "" });
    return [mock.production, mock.sandbox];
  },
} satisfies DocMockModule;
