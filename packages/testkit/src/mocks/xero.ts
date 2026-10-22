import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockResponse } from "../doc-mock.js";

/**
 * The Xero Accounting API's read endpoints and Xero's OAuth token refresh,
 * built from Xero's developer docs. Data is synthetic. Xero's free Demo
 * Company replaces this mock with recordings once an app is set up.
 */
const DOCS = "https://developer.xero.com/documentation";
const API = "https://api.xero.com";
const IDENTITY = "https://identity.xero.com";

/** A tenant ID shaped like Xero's. */
export const XERO_TEST_TENANT = "00000000-0000-4000-8000-00000000a0a0";
export const XERO_MOCK_ENDPOINTS = ["Accounts", "Contacts", "Invoices", "CreditNotes", "Payments", "BankTransactions", "ManualJournals"] as const;
type Endpoint = (typeof XERO_MOCK_ENDPOINTS)[number];
const PAGED = new Set<Endpoint>(["Contacts", "Invoices", "CreditNotes", "Payments", "BankTransactions", "ManualJournals"]);

/** The read-only scopes a connection gets unless a test asks for others. */
export const XERO_MOCK_READ_SCOPES = [
  "offline_access",
  "accounting.settings.read",
  "accounting.contacts.read",
  "accounting.invoices.read",
  "accounting.payments.read",
  "accounting.banktransactions.read",
  "accounting.manualjournals.read",
];

export interface XeroMockRecord {
  UpdatedDateUTC: string;
  /** Transactions carry a date; accounts and contacts don't. */
  Date?: string;
  [field: string]: unknown;
}

export interface XeroMockData {
  records: Partial<Record<Endpoint, XeroMockRecord[]>>;
  /** The refresh token the organisation was connected with. */
  refreshToken: string;
  /** Scopes the connection was granted; read-only unless a test says otherwise. */
  scopes?: string[];
  /** 429s to answer before the next API reads, in order: the X-Rate-Limit-Problem and Retry-After Xero sends. */
  rateLimits?: { problem: "minute" | "day" | "concurrent"; retryAfter?: number }[];
}

/** A /Date(ms+0000)/ value, as Xero's JSON writes times. */
export const xeroMsDate = (iso: string) => `/Date(${Date.parse(iso)}+0000)/`;
const msOf = (value: unknown) => Number(/^\/Date\((-?\d+)/.exec(String(value))?.[1] ?? Number.NaN);

/** Luhn's check, which assertSynthetic uses to flag card numbers; a 13-digit millisecond time can pass it by chance. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** A fixture time a second or two off, if needed, so its milliseconds never look like a card number. */
const notCardLike = (iso: string) => {
  let ms = Date.parse(iso);
  while (luhn(String(ms))) ms += 1000;
  return new Date(ms).toISOString();
};

const guid = (prefix: string, n: number) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, "0")}`;
export const xeroGuid = guid;
const updated = (n: number) => xeroMsDate(notCardLike(synthetic.isoTime(n * 60 + 30)));
const dated = (n: number) => xeroMsDate(notCardLike(synthetic.isoTime(n * 1440).slice(0, 10) + "T00:00:00Z"));
const due = (n: number) => xeroMsDate(notCardLike(synthetic.isoTime(n * 1440 + 30 * 1440).slice(0, 10) + "T00:00:00Z"));

export const xeroAccount = fixtureBuilder<XeroMockRecord>((n) => ({
  AccountID: guid("a", n),
  Code: `${100 + n}`,
  Name: `Test Account ${n}`,
  Type: "BANK",
  Class: "ASSET",
  Status: "ACTIVE",
  CurrencyCode: "USD",
  UpdatedDateUTC: updated(n),
}));

export const xeroContact = fixtureBuilder<XeroMockRecord>((n) => ({
  ContactID: guid("c", n),
  ContactStatus: "ACTIVE",
  Name: synthetic.name(n),
  EmailAddress: synthetic.email(n),
  Phones: [{ PhoneType: "DEFAULT", PhoneNumber: synthetic.phone(n) }],
  Addresses: [{ AddressType: "STREET", AddressLine1: `${n} Test Street`, City: "Testville" }],
  TaxNumber: "00-0000000",
  IsCustomer: true,
  IsSupplier: false,
  UpdatedDateUTC: updated(n),
}));

export const xeroInvoice = fixtureBuilder<XeroMockRecord>((n) => ({
  InvoiceID: guid("1", n),
  Type: "ACCREC",
  InvoiceNumber: `INV-TEST-${n}`,
  Reference: "Synthetic reference",
  Contact: { ContactID: guid("c", 1), Name: synthetic.name(1), EmailAddress: synthetic.email(1) },
  Date: dated(n),
  DueDate: due(n),
  Status: "AUTHORISED",
  LineAmountTypes: "Exclusive",
  LineItems: [{ LineItemID: guid("11", n), Description: "Test 14K ring", ItemCode: "RING-TEST-14K", Quantity: 1, UnitAmount: 1250.5, LineAmount: 1250.5, AccountCode: "200" }],
  SubTotal: 1250.5,
  TotalTax: 0,
  Total: 1250.5,
  AmountDue: 1250.5,
  AmountPaid: 0,
  CurrencyCode: "USD",
  UpdatedDateUTC: updated(n),
}));

export const xeroBill = fixtureBuilder<XeroMockRecord>((n) => ({
  InvoiceID: guid("2", n),
  Type: "ACCPAY",
  InvoiceNumber: `BILL-TEST-${n}`,
  Contact: { ContactID: guid("c", 50 + n), Name: `Test Supplier ${n}` },
  Date: dated(n),
  DueDate: due(n),
  Status: "AUTHORISED",
  LineItems: [{ Description: "Test casting", Quantity: 1, UnitAmount: 640, LineAmount: 640, AccountCode: "310" }],
  Total: 640,
  AmountDue: 640,
  CurrencyCode: "USD",
  UpdatedDateUTC: updated(n),
}));

export const xeroCreditNote = fixtureBuilder<XeroMockRecord>((n) => ({
  CreditNoteID: guid("3", n),
  Type: "ACCRECCREDIT",
  CreditNoteNumber: `CN-TEST-${n}`,
  Contact: { ContactID: guid("c", 1), Name: synthetic.name(1) },
  Date: dated(n),
  Status: "AUTHORISED",
  Total: 100,
  RemainingCredit: 100,
  CurrencyCode: "USD",
  UpdatedDateUTC: updated(n),
}));

export const xeroPayment = fixtureBuilder<XeroMockRecord>((n) => ({
  PaymentID: guid("4", n),
  Date: dated(n),
  Amount: 500,
  Reference: "Synthetic payment reference",
  IsReconciled: false,
  Status: "AUTHORISED",
  PaymentType: "ACCRECPAYMENT",
  Account: { AccountID: guid("a", 1), Code: "101" },
  Invoice: { InvoiceID: guid("1", 1), Type: "ACCREC", CurrencyCode: "USD", Contact: { ContactID: guid("c", 1), Name: synthetic.name(1) } },
  UpdatedDateUTC: updated(n),
}));

export const xeroBankTransaction = fixtureBuilder<XeroMockRecord>((n) => ({
  BankTransactionID: guid("5", n),
  Type: "SPEND",
  Contact: { ContactID: guid("c", 51), Name: "Test Supplier 1" },
  BankAccount: { AccountID: guid("a", 1), Code: "101", Name: "Test Account 1" },
  Date: dated(n),
  Reference: "Synthetic bank reference",
  IsReconciled: true,
  Status: "AUTHORISED",
  Total: 75,
  CurrencyCode: "USD",
  LineItems: [{ Description: "Test refining fee", LineAmount: 75, AccountCode: "429" }],
  UpdatedDateUTC: updated(n),
}));

export const xeroManualJournal = fixtureBuilder<XeroMockRecord>((n) => ({
  ManualJournalID: guid("6", n),
  Date: dated(n),
  Status: "POSTED",
  Narration: "Synthetic narration",
  JournalLines: [
    { LineAmount: 75, AccountCode: "429", Description: "Synthetic line" },
    { LineAmount: -75, AccountCode: "101", Description: "Synthetic line" },
  ],
  UpdatedDateUTC: updated(n),
}));

/** An unsigned JWT-shaped access token carrying its scopes, as Xero's are JWTs with a scope claim. */
function accessToken(n: number, scopes: readonly string[]): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part({ nbf: 0, exp: 1800, scope: scopes, jti: `AT-TEST-${n}` })}.c2lnbmF0dXJl`;
}

const error = (status: number, title: string, detail: string): DocMockResponse => ({ status, body: { Title: title, Status: status, Detail: detail } });
const validation = (message: string): DocMockResponse => ({ status: 400, body: { ErrorNumber: 10, Type: "ValidationException", Message: message } });

const WHERE = /^Date>=DateTime\((\d{4}),(\d{1,2}),(\d{1,2})\)$/;

export interface XeroMock {
  identity: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  /** The refresh token Xero would accept now; each refresh retires it. */
  readonly refreshToken: string;
  /** Refresh requests answered, failed ones included. */
  readonly refreshes: number;
  /** Revokes every access token, as when a token is cut off before it expires. */
  revokeAccessTokens(): void;
}

export function xeroDocMock(data: XeroMockData): XeroMock {
  let refreshToken = data.refreshToken;
  let issued = 0;
  let refreshes = 0;
  const access = new Set<string>();
  const limits = [...(data.rateLimits ?? [])];

  const identity = checkDocMock({
    integration: "xero",
    baseUrl: IDENTITY,
    source: { url: `${DOCS}/guides/oauth2/auth-flow`, title: "Xero OAuth 2.0 auth flow", retrievedOn: "2026-10-21", version: "OAuth 2.0" },
    auth: "basic",
    assumptions: ["A refresh token is refused with invalid_grant as soon as it has been used once; Xero's 30-minute retry grace isn't modelled"],
    routes: [
      {
        method: "POST",
        path: "/connect/token",
        documentedAt: `${DOCS}/guides/oauth2/auth-flow`,
        respond(request) {
          refreshes++;
          const form = new URLSearchParams(request.body);
          if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== refreshToken) return { status: 400, body: { error: "invalid_grant" } };
          issued++;
          refreshToken = `RT-TEST-${issued}`;
          const token = accessToken(issued, data.scopes ?? XERO_MOCK_READ_SCOPES);
          access.add(token);
          return { status: 200, body: { access_token: token, expires_in: 1800, token_type: "Bearer", refresh_token: refreshToken, scope: (data.scopes ?? XERO_MOCK_READ_SCOPES).join(" ") } };
        },
      },
    ],
  });

  const api = checkDocMock({
    integration: "xero",
    baseUrl: API,
    source: { url: `${DOCS}/api/accounting/overview`, title: "Xero Accounting API", retrievedOn: "2026-10-21", version: "api.xro/2.0" },
    auth: "bearer",
    assumptions: [
      "order=UpdatedDateUTC ASC is accepted by every paged endpoint and gives a stable order while paging",
      "If-Modified-Since returns records whose UpdatedDateUTC is at or after the given second",
      "Deleted and voided transactions keep coming back with Status DELETED or VOIDED, with UpdatedDateUTC moved to the change",
      "Payments, BankTransactions and ManualJournals page with page and pageSize like Invoices",
      "A 429 for the daily limit carries X-Rate-Limit-Problem: day",
    ],
    routes: [
      {
        method: "GET",
        path: "/api.xro/2.0/{endpoint}",
        documentedAt: `${DOCS}/api/accounting/requests-and-responses`,
        respond(request, params) {
          if (!access.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) return error(401, "Unauthorized", "AuthenticationUnsuccessful");
          if (request.headers.get("xero-tenant-id") !== XERO_TEST_TENANT) return error(403, "Forbidden", "AuthorizationUnsuccessful");
          const limit = limits.shift();
          if (limit) {
            return { status: 429, body: { Title: "Too Many Requests" }, headers: { "x-rate-limit-problem": limit.problem, ...(limit.retryAfter ? { "retry-after": String(limit.retryAfter) } : {}) } };
          }
          const endpoint = XERO_MOCK_ENDPOINTS.find((e) => e === params.endpoint);
          if (!endpoint) return { status: 404, body: { Title: "Not Found" } };
          const q = request.url.searchParams;
          let rows = [...(data.records[endpoint] ?? [])];
          if (endpoint === "Contacts" && q.get("includeArchived") !== "true") rows = rows.filter((r) => r.ContactStatus !== "ARCHIVED");
          const where = q.get("where");
          if (where !== null) {
            const m = WHERE.exec(where);
            if (!m) return validation(`Unable to parse the where clause ${where.slice(0, 40)}`);
            const from = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
            rows = rows.filter((r) => msOf(r.Date) >= from);
          }
          const since = request.headers.get("if-modified-since");
          if (since !== null) {
            const from = Date.parse(/Z$/.test(since) ? since : `${since}Z`);
            if (Number.isNaN(from)) return validation("If-Modified-Since is not a valid date");
            rows = rows.filter((r) => msOf(r.UpdatedDateUTC) >= from);
          }
          if (q.get("order") !== null) rows.sort((a, b) => msOf(a.UpdatedDateUTC) - msOf(b.UpdatedDateUTC));
          const page = q.get("page");
          let pagination: Record<string, number> | undefined;
          if (page !== null && PAGED.has(endpoint)) {
            const size = Math.min(Math.max(Number(q.get("pageSize") ?? "100"), 1), 1000);
            const n = Math.max(Number(page), 1);
            pagination = { page: n, pageSize: size, pageCount: Math.ceil(rows.length / size), itemCount: rows.length };
            rows = rows.slice((n - 1) * size, n * size);
          }
          return { status: 200, body: { Id: "00000000-0000-4000-8000-000000000000", Status: "OK", ProviderName: "KaratOS test", ...(pagination ? { pagination } : {}), [endpoint]: rows } };
        },
      },
    ],
  });

  const identityFetch = docMockFetch(identity);
  const apiFetch = docMockFetch(api);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      // Routed by exact origin, so a look-alike host goes to the API mock and is refused there.
      const toIdentity = new URL(input instanceof Request ? input.url : String(input)).origin === IDENTITY;
      const response = await (toIdentity ? identityFetch : apiFetch)(input, init);
      calls.push(...(toIdentity ? identityFetch.calls : apiFetch.calls).slice(-1));
      return response;
    },
    { calls },
  );
  return {
    identity,
    api,
    fetch,
    get refreshToken() {
      return refreshToken;
    },
    get refreshes() {
      return refreshes;
    },
    revokeAccessTokens: () => access.clear(),
  };
}
