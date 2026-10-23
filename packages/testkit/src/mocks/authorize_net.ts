import { fixtureBuilder, synthetic } from "../fixtures.js";
import { UndocumentedRequestError, checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockResponse, type DocMockModule } from "../doc-mock.js";

/**
 * Authorize.net's Transaction Reporting requests on its JSON API, built from
 * Authorize.net's developer docs. Data is synthetic. A free sandbox account
 * replaces this mock with recordings once one is set up.
 *
 * Docs facts the mock relies on:
 * - One endpoint per environment, POST only: https://api.authorize.net/xml/v1/request.api
 *   and https://apitest.authorize.net/xml/v1/request.api, with the request
 *   named by its one top-level key (developer.authorize.net/api/reference/index.html).
 * - The JSON API is a translation of the XML one, so "XML requires strict
 *   ordering" of elements, and requests must follow the reference's order (same page).
 * - Credentials are merchantAuthentication.name, the API Login ID, and
 *   merchantAuthentication.transactionKey, at most 16 characters (same page).
 * - Responses carry messages.resultCode Ok or Error and message codes
 *   starting I or E (same page).
 * - Reporting offers the settled batch list, the transaction list for a
 *   batch, the unsettled transaction list, transaction details and merchant
 *   details (developer.authorize.net/api/reference/features/transaction-reporting.html).
 * - Transaction statuses include refundSettledSuccessfully,
 *   refundPendingSettlement, voided, chargeback, chargebackReversal and
 *   returnedItem, and summaries carry transId, submitTimeUTC,
 *   transactionStatus, firstName, lastName, accountType, accountNumber,
 *   settleAmount, marketType, product, hasReturnedItems and profile
 *   (api.authorize.net/xml/v1/schema/AnetApiSchema.xsd).
 * - A masked card number is 8 characters, XXXX1111 (same schema).
 * - JSON responses start with a UTF-8 byte order mark, kept so as not to
 *   break existing integrations (Authorize.net staff on the developer
 *   community forum, "JSON API Response ERROR").
 */
const DOCS = "https://developer.authorize.net/api/reference";
const HOSTS = { production: "https://api.authorize.net", sandbox: "https://apitest.authorize.net" } as const;
const PATH = "/xml/v1/request.api";

/** Each request the mock answers, with its fields in schema order. */
const REQUESTS = {
  getMerchantDetailsRequest: [],
  getSettledBatchListRequest: ["includeStatistics", "firstSettlementDate", "lastSettlementDate"],
  getTransactionListRequest: ["batchId", "sorting", "paging"],
  getUnsettledTransactionListRequest: ["status", "sorting", "paging"],
  getTransactionDetailsRequest: ["transId"],
} as const satisfies Record<string, readonly string[]>;
type RequestType = keyof typeof REQUESTS;
export const AUTHORIZE_NET_MOCK_REQUESTS = Object.keys(REQUESTS) as RequestType[];

export type AuthorizeNetMockRecord = Record<string, unknown>;

export interface AuthorizeNetMockData {
  apiLoginId: string;
  transactionKey: string;
  /** The host the mock answers; sandbox unless a test says otherwise. */
  environment?: "sandbox" | "production";
  /** The account's currency, as merchant details give it. */
  currency?: string;
  /** Settled batches, with their transactions under transactions[batchId]. */
  batches: AuthorizeNetMockRecord[];
  transactions?: Record<string, AuthorizeNetMockRecord[]>;
  unsettled?: AuthorizeNetMockRecord[];
  /** Full transaction details by transId. */
  details?: Record<string, AuthorizeNetMockRecord>;
}

const iso = (n: number) => `${synthetic.isoTime(n).slice(0, 19)}Z`;
const local = (n: number) => synthetic.isoTime(n - 300).slice(0, 19);

/** A transaction id shaped like Authorize.net's, 11 digits, too short to look like a card number. */
export const authorizeNetTransId = (n: number) => String(60_000_000_000 + n);
export const authorizeNetBatchId = (n: number) => String(9_000_000 + n);

export const authorizeNetBatch = fixtureBuilder<AuthorizeNetMockRecord>((n) => ({
  batchId: authorizeNetBatchId(n),
  settlementTimeUTC: iso(n * 1440 + 180),
  settlementTimeLocal: local(n * 1440 + 180),
  settlementState: "settledSuccessfully",
  paymentMethod: "creditCard",
  marketType: "eCommerce",
  product: "Card Not Present",
  statistics: [
    { accountType: "Visa", chargeAmount: 1250.5, chargeCount: 2, refundAmount: 100, refundCount: 1, voidCount: 1, declineCount: 0, errorCount: 0 },
    { accountType: "MasterCard", chargeAmount: 49.5, chargeCount: 1, refundAmount: 0, refundCount: 0, voidCount: 0, declineCount: 1, errorCount: 0, chargebackAmount: 25, chargebackCount: 1 },
  ],
}));

export const authorizeNetTransaction = fixtureBuilder<AuthorizeNetMockRecord>((n) => {
  const [first, ...rest] = synthetic.name(n).split(" ");
  return {
    transId: authorizeNetTransId(n),
    submitTimeUTC: iso(n * 60),
    submitTimeLocal: local(n * 60),
    transactionStatus: "settledSuccessfully",
    invoiceNumber: `INV-TEST-${n}`,
    firstName: first,
    lastName: rest.join(" "),
    accountType: "Visa",
    accountNumber: "XXXX1111",
    settleAmount: 625.25,
    marketType: "eCommerce",
    product: "Card Not Present",
    hasReturnedItems: false,
    profile: { customerProfileId: String(500_000 + n), customerPaymentProfileId: String(700_000 + n) },
  };
});

/** Full details for a transaction, with the personal data they hold, which a connector must not keep. */
export function authorizeNetDetails(summary: AuthorizeNetMockRecord, extra: AuthorizeNetMockRecord = {}): AuthorizeNetMockRecord {
  const n = Number(String(summary.transId).slice(-4));
  return {
    transId: summary.transId,
    submitTimeUTC: summary.submitTimeUTC,
    transactionType: "authCaptureTransaction",
    transactionStatus: summary.transactionStatus,
    responseCode: 1,
    responseReasonCode: 1,
    responseReasonDescription: "Approval",
    authCode: "000000",
    AVSResponse: "Y",
    order: { invoiceNumber: summary.invoiceNumber, description: "Synthetic order description" },
    authAmount: summary.settleAmount,
    settleAmount: summary.settleAmount,
    payment: { creditCard: { cardNumber: "XXXX1111", expirationDate: "XXXX", cardType: summary.accountType } },
    customer: { type: "individual", id: `CUST-TEST-${n}`, email: synthetic.email(n) },
    billTo: { firstName: summary.firstName, lastName: summary.lastName, address: `${n} Test Street`, city: "Testville", state: "NY", zip: "00000", country: "US", phoneNumber: synthetic.phone(n) },
    // 192.0.2.0/24 is reserved for documentation.
    customerIP: `192.0.2.${n % 250}`,
    recurringBilling: false,
    product: summary.product,
    marketType: summary.marketType,
    ...extra,
  };
}

const MESSAGES = {
  ok: { resultCode: "Ok", message: [{ code: "I00001", text: "Successful." }] },
  none: { resultCode: "Ok", message: [{ code: "I00004", text: "No records found." }] },
};
const error = (code: string, text: string): DocMockResponse => ({ status: 200, body: { messages: { resultCode: "Error", message: [{ code, text }] } } });
const ok = (fields: Record<string, unknown>, empty = false): DocMockResponse => ({ status: 200, body: { ...fields, messages: empty ? MESSAGES.none : MESSAGES.ok } });

const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;
const utc = (value: string) => Date.parse(/Z$/.test(value) ? value : `${value}Z`);

/** Sorts and pages a transaction list the way the request asks. */
function page(rows: AuthorizeNetMockRecord[], sorting: unknown, paging: unknown): { rows: AuthorizeNetMockRecord[]; problem?: string } {
  const s = (sorting ?? {}) as { orderBy?: unknown; orderDescending?: unknown };
  const p = (paging ?? {}) as { limit?: unknown; offset?: unknown };
  let out = [...rows];
  if (sorting !== undefined) {
    if (s.orderBy !== "id" && s.orderBy !== "submitTimeUTC") return { rows: [], problem: "orderBy" };
    out.sort((a, b) => (s.orderBy === "id" ? Number(a.transId) - Number(b.transId) : utc(String(a.submitTimeUTC)) - utc(String(b.submitTimeUTC))));
    if (String(s.orderDescending) === "true") out.reverse();
  }
  const limit = Number(p.limit ?? 1000);
  const offset = Number(p.offset ?? 1);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 1 || offset > 100_000) return { rows: [], problem: "paging" };
  out = out.slice((offset - 1) * limit, offset * limit);
  return { rows: out };
}

export interface AuthorizeNetMock {
  api: DocMock;
  /** Answers the mock's host only, each body with the byte order mark Authorize.net sends. */
  fetch: DocMockFetch;
  /** Every request type sent, in order, without its credentials. */
  readonly requests: string[];
}

export function authorizeNetDocMock(data: AuthorizeNetMockData): AuthorizeNetMock {
  const host = HOSTS[data.environment ?? "sandbox"];
  const requests: string[] = [];

  function answer(type: RequestType, fields: Record<string, unknown>): DocMockResponse {
    switch (type) {
      case "getMerchantDetailsRequest":
        return ok({ isTestMode: false, merchantName: "Test Merchant", gatewayId: "000000", paymentMethods: ["Visa", "MasterCard", "eCheck"], currencies: [data.currency ?? "USD"] });
      case "getSettledBatchListRequest": {
        const first = String(fields.firstSettlementDate ?? "");
        const last = String(fields.lastSettlementDate ?? "");
        if (!DATE.test(first) || !DATE.test(last)) return error("E00003", "The 'AnetApi/xml/v1/schema/AnetApiSchema.xsd:firstSettlementDate' element is invalid.");
        const from = utc(first);
        const to = utc(last);
        if (to < from || to - from > 31 * 86_400_000) return error("E00003", "The date range cannot exceed 31 days.");
        const stats = fields.includeStatistics === "true";
        const batchList = data.batches
          .filter((b) => utc(String(b.settlementTimeUTC)) >= from && utc(String(b.settlementTimeUTC)) <= to)
          .sort((a, b) => utc(String(a.settlementTimeUTC)) - utc(String(b.settlementTimeUTC)))
          .map((b) => (stats ? b : Object.fromEntries(Object.entries(b).filter(([k]) => k !== "statistics"))));
        return batchList.length ? ok({ batchList }) : ok({}, true);
      }
      case "getTransactionListRequest":
      case "getUnsettledTransactionListRequest": {
        if (type === "getTransactionListRequest" && !/^\d+$/.test(String(fields.batchId ?? ""))) return error("E00003", "The 'batchId' element is invalid.");
        const all = type === "getUnsettledTransactionListRequest" ? (data.unsettled ?? []) : (data.transactions?.[String(fields.batchId)] ?? []);
        const { rows, problem } = page(all, fields.sorting, fields.paging);
        if (problem) return error("E00003", `The '${problem}' element is invalid.`);
        return rows.length ? ok({ transactions: rows, totalNumInSet: all.length }) : ok({ totalNumInSet: all.length }, true);
      }
      case "getTransactionDetailsRequest": {
        const details = data.details?.[String(fields.transId)];
        return details ? ok({ transaction: details }) : error("E00040", "The record cannot be found.");
      }
    }
  }

  const api = checkDocMock({
    integration: "authorize_net",
    baseUrl: host,
    source: { url: `${DOCS}/index.html`, title: "Authorize.net API Reference", retrievedOn: "2026-10-21", version: "xml/v1" },
    // Credentials travel in the body (merchantAuthentication), not a header.
    assumptions: [
      "The JSON API answers errors with HTTP 200 and resultCode Error, as the XML API does",
      "Lists come back as JSON arrays (batchList, transactions, statistics, currencies), not wrapped in their XML element names",
      "Amounts come back as JSON numbers",
      "firstSettlementDate and lastSettlementDate are compared to the second, inclusive, and a range over 31 days is refused with E00003",
      "paging.offset is the page number, and totalNumInSet counts the whole list",
      "Each settled batch's statistics give chargeAmount and refundAmount per card type",
      "Chargebacks and returned items are transactions of their own whose details name the original in refTransId, as refunds do",
      "getUnsettledTransactionList with no status lists every unsettled transaction, held ones included, and pages like getTransactionList",
      "Authorize.net publishes no rate limit; throttling, if any, is a 429 or 503",
    ],
    routes: [
      {
        method: "POST",
        path: PATH,
        documentedAt: `${DOCS}/features/transaction-reporting.html`,
        respond(request) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(request.body.replace(/^﻿/, ""));
          } catch {
            return error("E00003", "An error occurred while parsing the JSON request.");
          }
          const keys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
          const type = keys[0] ?? "";
          // Any other request is documented elsewhere in the reference and is no business of a read-only connector.
          if (keys.length !== 1 || !Object.hasOwn(REQUESTS, type)) throw new UndocumentedRequestError("POST", `${request.url.toString()} (${type.slice(0, 60) || "no request"})`);
          requests.push(type);
          const inner = (parsed as Record<string, Record<string, unknown>>)[type] ?? {};
          const [firstKey, ...rest] = Object.keys(inner);
          const auth = inner.merchantAuthentication as { name?: unknown; transactionKey?: unknown } | undefined;
          if (firstKey !== "merchantAuthentication" || auth?.name !== data.apiLoginId || auth?.transactionKey !== data.transactionKey) {
            return error("E00007", "User authentication failed due to invalid authentication values.");
          }
          // XML requires strict ordering, so a field out of the schema's order is refused like an unknown one.
          const order: readonly string[] = REQUESTS[type as RequestType];
          const fields = rest.filter((k) => k !== "refId");
          if (fields.some((k, i) => !order.includes(k) || (i > 0 && order.indexOf(k) < order.indexOf(fields[i - 1]!)))) {
            return error("E00003", `The element '${type}' has invalid child element '${fields.find((k) => !order.includes(k)) ?? fields.at(-1)}'.`);
          }
          return answer(type as RequestType, inner);
        },
      },
    ],
  });

  const inner = docMockFetch(api);
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const response = await inner(input, init);
      // Authorize.net starts each JSON body with a UTF-8 byte order mark.
      return new Response(`﻿${await response.text()}`, { status: response.status, headers: response.headers });
    },
    { calls: inner.calls },
  );
  return {
    api,
    fetch,
    get requests() {
      return requests;
    },
  };
}

export default {
  integration: "authorize_net",
  covers: "Authorize.net's Transaction Reporting requests on its JSON API",
  watchPages: [
    "https://developer.authorize.net/api/reference/index.html",
    "https://developer.authorize.net/api/reference/features/transaction-reporting.html",
  ],
  docMocks: () => [authorizeNetDocMock({ apiLoginId: "", transactionKey: "", batches: [] }).api],
} satisfies DocMockModule;
