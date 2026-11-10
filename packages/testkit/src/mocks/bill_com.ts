import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * BILL's OAuth client credentials token and its v3 vendor, bill and
 * payment lists, built from BILL's developer docs (read as Markdown from
 * developer.bill.com). Data is synthetic. BILL's sandbox
 * (gateway.stage.bill.com) replaces this mock once a sandbox developer
 * app is set up.
 *
 * Docs facts the mock relies on:
 * - The token is POST /authx/token with the form grant_type
 *   client_credentials, client_id and client_secret, answering
 *   access_token, expires_in (3600) and token_type Bearer; 400 and 401
 *   answer a message (oauth-client-credentials, createaccesstoken).
 * - v3 calls send Authorization: Bearer and no devKey or sessionId
 *   (oauth-client-credentials).
 * - GET /v3/vendors, /v3/bills and /v3/payments take max (1 to 100),
 *   sort (field:order), filters (field:op:value) and page (a nextPage or
 *   prevPage value), and answer results, nextPage, prevPage and count
 *   (listvendors, listbills, listpayments). updatedTime takes gt, gte, lt
 *   and lte and sorts asc or desc (filterable-fields, sortable-fields).
 * - Errors are a list of {timestamp, code, severity, category, message};
 *   BDC_1144 is the hourly limit of 20,000 and BDC_1322 the limit of 3
 *   requests at once (api-rate-limits).
 */
const DOCS = "https://developer.bill.com";
export const BILL_DOC_PAGES = {
  token: `${DOCS}/docs/oauth-client-credentials.md`,
  vendors: `${DOCS}/reference/listvendors.md`,
  bills: `${DOCS}/reference/listbills.md`,
  payments: `${DOCS}/reference/listpayments.md`,
  limits: `${DOCS}/docs/api-rate-limits.md`,
} as const;
const AUTH = "https://auth.bill.com";
const API = "https://gateway.prod.bill.com/connect";

export type BillMockRecord = Record<string, unknown>;

export interface BillMockData {
  clientId: string;
  clientSecret: string;
  vendors: BillMockRecord[];
  bills: BillMockRecord[];
  payments: BillMockRecord[];
  /** Seconds the token lasts. Defaults to 3600. */
  expiresIn?: number;
  /** Answers this many list calls with BDC_1322, too many requests at once. */
  busy?: number;
  /** Answers every list call with BDC_1144 once set. */
  hourlyLimitReached?: boolean;
}

export const billVendor = fixtureBuilder<BillMockRecord>((n) => ({
  id: `0090TEST${String(n).padStart(8, "0")}`,
  archived: false,
  name: `Test Supplier ${n}`,
  shortName: `TS${n}`,
  accountNumber: `TEST-ACCT-${n}`,
  accountType: "BUSINESS",
  email: `supplier${n}@example.com`,
  phone: "555-0100",
  address: { line1: `${n} Example Street`, city: "Testville", zipOrPostalCode: "00000", country: "US" },
  paymentInformation: { payeeName: `Test Supplier ${n}`, payByType: "ACH", bankAccount: { nameOnAccount: `Test Supplier ${n}`, accountNumber: "000123456789", routingNumber: "000000000", type: "CHECKING" } },
  additionalInfo: { taxId: "00-0000000", taxIdType: "EIN", track1099: false },
  billCurrency: "USD",
  createdTime: "2026-01-05T15:00:00.000+00:00",
  updatedTime: `2026-01-05T15:${String(n % 60).padStart(2, "0")}:00.000+00:00`,
}));

export const billBill = fixtureBuilder<BillMockRecord>((n) => ({
  id: `00n0TEST${String(n).padStart(8, "0")}`,
  archived: false,
  recordStatus: "ACTIVE",
  vendorId: "0090TEST00000001",
  vendorName: "Test Supplier 1",
  currency: "USD",
  amount: 1250.5,
  fundingAmount: 1250.5,
  paidAmount: 250,
  dueAmount: 1000.5,
  scheduledAmount: 0,
  creditAmount: 0,
  description: "Memo goods, see attached",
  dueDate: "2026-02-15",
  invoice: { invoiceNumber: `TEST-INV-${n}`, invoiceDate: "2026-01-15" },
  billLineItems: [{ id: `bli0TEST${n}`, amount: 1250.5, description: "14k chain" }],
  paymentStatus: "UNPAID",
  approvalStatus: "APPROVED",
  createdBy: "0060TEST00000001",
  createdTime: "2026-01-15T16:00:00.000+00:00",
  updatedTime: `2026-01-15T16:${String(n % 60).padStart(2, "0")}:00.000+00:00`,
}));

export const billPayment = fixtureBuilder<BillMockRecord>((n) => ({
  id: `stp0TEST${String(n).padStart(8, "0")}`,
  vendorId: "0090TEST00000001",
  vendorName: "Test Supplier 1",
  remittanceEmail: "supplier1@example.com",
  billId: "00n0TEST00000001",
  billPayments: [{ id: `blp0TEST${n}`, billId: "00n0TEST00000001", amount: 1250.5 }],
  description: "Invoice TEST-INV-1",
  amount: 1250.5,
  fundingAmount: 1250.5,
  processDate: "2026-02-10",
  status: "PAID",
  disbursementType: "ACH",
  onlinePayment: true,
  confirmationNumber: "TEST-CONF-1",
  fundingAccount: { type: "BANK_ACCOUNT", id: "bac0TEST00000001" },
  disbursementInfo: { checkDisbursement: { checkNumber: 1001 }, vcardDisbursement: { last4CardNumber: "9876" } },
  createdBy: "0060TEST00000001",
  createdTime: "2026-02-09T16:00:00.000+00:00",
  updatedTime: `2026-02-10T09:${String(n % 60).padStart(2, "0")}:00.000+00:00`,
}));

const error = (status: number, code: string, message: string): DocMockResponse => ({
  status,
  body: [{ timestamp: "2026-11-10T00:00:00.000+00:00", code, severity: "ERROR", category: "DOWNSTREAM", message }],
});

const FILTER = /^updatedTime:(gt|gte|lt|lte):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

export interface BillMock {
  auth: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  readonly tokens: string[];
  readonly lists: { resource: string; query: Record<string, string> }[];
  revokeTokens(): void;
}

export function billDocMock(data: BillMockData): BillMock {
  const tokens: string[] = [];
  const revoked = new Set<string>();
  const lists: { resource: string; query: Record<string, string> }[] = [];
  let busy = data.busy ?? 0;

  const auth = checkDocMock({
    integration: "bill_com",
    baseUrl: AUTH,
    source: { url: BILL_DOC_PAGES.token, title: "BILL OAuth client credentials", retrievedOn: "2026-11-10", version: "v3" },
    assumptions: ["A bad client id or secret is 401 with a message"],
    routes: [
      {
        method: "POST",
        path: "/authx/token",
        documentedAt: BILL_DOC_PAGES.token,
        respond(request) {
          if (!/^application\/x-www-form-urlencoded/.test(request.headers.get("content-type") ?? "")) return { status: 400, body: { message: "Invalid content type" } };
          const form = new URLSearchParams(request.body);
          if (form.get("grant_type") !== "client_credentials") return { status: 400, body: { message: "Invalid grant_type" } };
          if (form.get("client_id") !== data.clientId || form.get("client_secret") !== data.clientSecret) return { status: 401, body: { message: "Invalid client" } };
          const token = `testtoken${String(tokens.length + 1).padStart(12, "0")}`;
          tokens.push(token);
          return { status: 200, body: { access_token: token, expires_in: data.expiresIn ?? 3600, token_type: "Bearer" } };
        },
      },
    ],
  });

  const listRoute = (resource: "vendors" | "bills" | "payments") => ({
    method: "GET" as const,
    path: `/v3/${resource}`,
    documentedAt: BILL_DOC_PAGES[resource],
    respond(request: { url: URL; headers: Headers }): DocMockResponse {
      const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!bearer || !tokens.includes(bearer) || revoked.has(bearer)) return error(401, "BDC_1109", "Invalid or expired token");
      if (request.headers.has("devKey") || request.headers.has("sessionId")) return error(400, "BDC_1000", "Send the bearer token only");
      if (data.hourlyLimitReached) return error(400, "BDC_1144", "Max number of allowed requests per hour reached: 20000.");
      if (busy > 0) {
        busy--;
        return error(400, "BDC_1322", "Max number of concurrent requests per organization reached.");
      }
      const query = Object.fromEntries(request.url.searchParams);
      lists.push({ resource, query });
      const max = Number(query.max ?? 20);
      if (!Number.isInteger(max) || max < 1 || max > 100) return error(400, "BDC_1001", "max must be 1 to 100");
      if (query.sort !== undefined && query.sort !== "updatedTime:asc" && query.sort !== "updatedTime:desc") return error(400, "BDC_1001", "Unsupported sort");
      const filter = query.filters === undefined ? null : FILTER.exec(query.filters);
      if (query.filters !== undefined && !filter) return error(400, "BDC_1001", "Unsupported filter");
      const time = (r: BillMockRecord) => Date.parse(String(r.updatedTime));
      let rows = [...data[resource]];
      if (filter) {
        const at = Date.parse(filter[2]!);
        const keep = { gt: (t: number) => t > at, gte: (t: number) => t >= at, lt: (t: number) => t < at, lte: (t: number) => t <= at }[filter[1] as "gt" | "gte" | "lt" | "lte"];
        rows = rows.filter((r) => keep(time(r)));
      }
      if (query.sort) rows.sort((a, b) => (query.sort === "updatedTime:asc" ? time(a) - time(b) : time(b) - time(a)));
      // BILL's page tokens are opaque; the mock's say where the page starts.
      const from = query.page === undefined ? 0 : Number(/^p(\d{1,7})$/.exec(query.page)?.[1] ?? Number.NaN);
      if (!Number.isInteger(from)) return error(400, "BDC_1001", "Invalid page");
      const results = rows.slice(from, from + max);
      const end = from + results.length;
      return {
        status: 200,
        body: { count: rows.length, ...(end < rows.length ? { nextPage: `p${end}` } : {}), ...(from > 0 ? { prevPage: `p${Math.max(0, from - max)}` } : {}), results },
      };
    },
  });

  const api = checkDocMock({
    integration: "bill_com",
    baseUrl: API,
    source: { url: BILL_DOC_PAGES.bills, title: "BILL v3 list bills, vendors and payments", retrievedOn: "2026-11-10", version: "v3" },
    auth: "bearer",
    assumptions: [
      "A bad or expired token is 401 with an error list",
      "Rate limit errors come back as HTTP 400 with code BDC_1144 or BDC_1322, and no Retry-After header",
      "An updatedTime filter value is written as an ISO time in UTC with milliseconds, such as updatedTime:gte:2026-01-01T00:00:00.000Z",
      "A page token is sent alongside the same max, sort and filters as the first page",
      "The last page has no nextPage",
    ],
    routes: [listRoute("vendors"), listRoute("bills"), listRoute("payments")],
  });

  const authFetch = docMockFetch(auth);
  const apiFetch = docMockFetch(api);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      // Routed by exact origin, so a look-alike host goes to the API mock and is refused there.
      const toAuth = new URL(input instanceof Request ? input.url : String(input)).origin === AUTH;
      const response = await (toAuth ? authFetch : apiFetch)(input, init);
      calls.push(...(toAuth ? authFetch.calls : apiFetch.calls).slice(-1));
      return response;
    },
    { calls },
  );
  return {
    auth,
    api,
    fetch,
    get tokens() {
      return tokens;
    },
    get lists() {
      return lists;
    },
    revokeTokens: () => tokens.forEach((t) => revoked.add(t)),
  };
}

export default {
  integration: "bill_com",
  covers: "BILL's OAuth client credentials token and v3 vendor, bill and payment lists",
  watchPages: [BILL_DOC_PAGES.token, BILL_DOC_PAGES.bills, BILL_DOC_PAGES.vendors, BILL_DOC_PAGES.payments],
  docMocks: () => {
    const mock = billDocMock({ clientId: "", clientSecret: "", vendors: [], bills: [], payments: [] });
    return [mock.auth, mock.api];
  },
} satisfies DocMockModule;
