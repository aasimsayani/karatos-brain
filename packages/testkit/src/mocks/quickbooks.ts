import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockResponse } from "../doc-mock.js";

/**
 * QuickBooks Online's Accounting API query and change data capture
 * endpoints, and Intuit's OAuth token refresh, built from Intuit's developer
 * docs (minor version 75). Data is synthetic. The free Intuit developer
 * sandbox replaces this mock with recordings once an account is set up.
 */
const DOCS = "https://developer.intuit.com/app/developer/qbo/docs";
const SANDBOX = "https://sandbox-quickbooks.api.intuit.com";
const OAUTH = "https://oauth.platform.intuit.com";

/** A realm ID shaped like Intuit's, too short to be mistaken for a card number. */
export const QUICKBOOKS_TEST_REALM = "9341450000";
export const QUICKBOOKS_MOCK_ENTITIES = ["Account", "Customer", "Vendor", "Invoice", "Bill", "Payment", "JournalEntry"] as const;
type Entity = (typeof QUICKBOOKS_MOCK_ENTITIES)[number];
const NAME_LISTS = new Set<Entity>(["Account", "Customer", "Vendor"]);

export interface QuickBooksMockRecord {
  Id: string;
  SyncToken: string;
  MetaData: { CreateTime: string; LastUpdatedTime: string };
  Active?: boolean;
  TxnDate?: string;
  [field: string]: unknown;
}

export interface QuickBooksMockData {
  entities: Partial<Record<Entity, QuickBooksMockRecord[]>>;
  /** Deleted transactions, which only change data capture reports. */
  deleted?: { entity: Entity; Id: string; LastUpdatedTime: string }[];
  /** The refresh token the company was connected with. */
  refreshToken: string;
  /** "Now" for change data capture's 30-day limit. */
  now: () => Date;
}

const meta = (n: number) => ({ CreateTime: synthetic.isoTime(n * 60), LastUpdatedTime: synthetic.isoTime(n * 60 + 30) });

export const qbAccount = fixtureBuilder<QuickBooksMockRecord>((n) => ({
  Id: String(n),
  SyncToken: "0",
  MetaData: meta(n),
  Name: `Test Account ${n}`,
  AcctNum: `10${n}`,
  Classification: "Asset",
  AccountType: "Bank",
  AccountSubType: "Checking",
  CurrentBalance: 1000 + n,
  CurrencyRef: { value: "USD", name: "United States Dollar" },
  Active: true,
}));

export const qbCustomer = fixtureBuilder<QuickBooksMockRecord>((n) => ({
  Id: String(n),
  SyncToken: "0",
  MetaData: meta(n),
  DisplayName: synthetic.name(n),
  PrimaryEmailAddr: { Address: synthetic.email(n) },
  PrimaryPhone: { FreeFormNumber: synthetic.phone(n) },
  BillAddr: { Line1: `${n} Test Street`, City: "Testville", PostalCode: "00000" },
  Balance: 0,
  Active: true,
}));

export const qbVendor = fixtureBuilder<QuickBooksMockRecord>((n) => ({
  Id: String(50 + n),
  SyncToken: "0",
  MetaData: meta(n),
  DisplayName: `Test Supplier ${n}`,
  PrimaryEmailAddr: { Address: `ap${n}@supplier.test` },
  TaxIdentifier: "XXXXX0000",
  Balance: 250 + n,
  CurrencyRef: { value: "USD" },
  Active: true,
}));

export const qbInvoice = fixtureBuilder<QuickBooksMockRecord>((n) => ({
  Id: String(100 + n),
  SyncToken: "0",
  MetaData: meta(n),
  DocNumber: `INV-TEST-${n}`,
  TxnDate: synthetic.isoTime(n * 1440).slice(0, 10),
  DueDate: synthetic.isoTime(n * 1440 + 30 * 1440).slice(0, 10),
  CustomerRef: { value: "1", name: synthetic.name(1) },
  BillEmail: { Address: synthetic.email(1) },
  TotalAmt: 1250.5,
  Balance: 1250.5,
  CurrencyRef: { value: "USD" },
  CustomerMemo: { value: "Synthetic memo" },
  Line: [
    { Id: "1", LineNum: 1, Amount: 1250.5, DetailType: "SalesItemLineDetail", Description: "Test 14K ring", SalesItemLineDetail: { ItemRef: { value: "7", name: "Test 14K ring" }, Qty: 1, UnitPrice: 1250.5 } },
    { Amount: 1250.5, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} },
  ],
}));

export const qbBill = fixtureBuilder<QuickBooksMockRecord>((n) => ({
  Id: String(200 + n),
  SyncToken: "0",
  MetaData: meta(n),
  DocNumber: `BILL-TEST-${n}`,
  TxnDate: synthetic.isoTime(n * 1440).slice(0, 10),
  DueDate: synthetic.isoTime(n * 1440 + 30 * 1440).slice(0, 10),
  VendorRef: { value: "51", name: "Test Supplier 1" },
  TotalAmt: 640,
  Balance: 640,
  CurrencyRef: { value: "USD" },
  Line: [{ Id: "1", Amount: 640, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "3", name: "Test Account 3" } } }],
}));

export const qbPayment = fixtureBuilder<QuickBooksMockRecord>((n) => ({
  Id: String(300 + n),
  SyncToken: "0",
  MetaData: meta(n),
  TxnDate: synthetic.isoTime(n * 1440).slice(0, 10),
  CustomerRef: { value: "1", name: synthetic.name(1) },
  TotalAmt: 500,
  UnappliedAmt: 0,
  CurrencyRef: { value: "USD" },
  Line: [{ Amount: 500, LinkedTxn: [{ TxnId: "101", TxnType: "Invoice" }] }],
}));

export const qbJournalEntry = fixtureBuilder<QuickBooksMockRecord>((n) => ({
  Id: String(400 + n),
  SyncToken: "0",
  MetaData: meta(n),
  DocNumber: `JE-TEST-${n}`,
  TxnDate: synthetic.isoTime(n * 1440).slice(0, 10),
  Adjustment: false,
  CurrencyRef: { value: "USD" },
  PrivateNote: "Synthetic note",
  Line: [
    { Id: "0", Amount: 75, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "3", name: "Test Account 3" } } },
    { Id: "1", Amount: 75, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "1", name: "Test Account 1" } } },
  ],
}));

const fault = (status: number, message: string, code: string, type = "ValidationFault"): DocMockResponse => ({
  status,
  body: { Fault: { Error: [{ Message: message, Detail: message, code }], type }, time: "2026-01-01T00:00:00.000-08:00" },
});

const QUERY = /^SELECT \* FROM ([A-Za-z]+)(?: WHERE (.+?))?(?: ORDERBY ([A-Za-z.]+))? STARTPOSITION (\d+) MAXRESULTS (\d+)$/i;

function where(clause: string | undefined): ((r: QuickBooksMockRecord, entity: Entity) => boolean) | string {
  const tests: ((r: QuickBooksMockRecord) => boolean)[] = [];
  let activeOnly = true;
  for (const part of clause ? clause.split(" AND ") : []) {
    let m: RegExpExecArray | null;
    if (/^Active IN \(true, ?false\)$/i.test(part)) activeOnly = false;
    else if ((m = /^TxnDate >= '(\d{4}-\d{2}-\d{2})'$/.exec(part))) {
      const day = m[1]!;
      tests.push((r) => (r.TxnDate ?? "") >= day);
    } else if ((m = /^MetaData\.LastUpdatedTime >= '(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})'$/.exec(part))) {
      const from = Date.parse(m[1]!);
      tests.push((r) => Date.parse(r.MetaData.LastUpdatedTime) >= from);
    } else return `QueryParserError: unsupported condition ${part.slice(0, 60)}`;
  }
  // Name lists answer with active entries only unless the query asks for both.
  return (r, entity) => (!activeOnly || !NAME_LISTS.has(entity) || r.Active !== false) && tests.every((t) => t(r));
}

export interface QuickBooksMock {
  oauth: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  /** The refresh token Intuit would accept now; each refresh replaces it. */
  readonly refreshToken: string;
  /** Refresh requests answered, failed ones included. */
  readonly refreshes: number;
  /** Revokes every access token, as when a token is cut off before it expires. */
  revokeAccessTokens(): void;
}

export function quickBooksDocMock(data: QuickBooksMockData): QuickBooksMock {
  let refreshToken = data.refreshToken;
  let issued = 0;
  let refreshes = 0;
  const access = new Set<string>();
  const authorized = (header: string | null) => access.has(header?.replace(/^Bearer /, "") ?? "");
  const unauthorized: DocMockResponse = { status: 401, body: { fault: { error: [{ message: "message=AuthenticationFailed; errorCode=003200; statusCode=401", code: "3200" }], type: "AUTHENTICATION" } } };
  const minor = (url: URL) => Number(url.searchParams.get("minorversion") ?? "0") >= 75;

  const oauth = checkDocMock({
    integration: "quickbooks",
    baseUrl: OAUTH,
    source: { url: `${DOCS}/develop/authentication-and-authorization/oauth-2.0`, title: "Intuit OAuth 2.0", retrievedOn: "2026-10-21", version: "OAuth 2.0" },
    auth: "basic",
    assumptions: ["A refresh token Intuit has rotated away is refused at once with invalid_grant; Intuit only says to always keep the newest"],
    routes: [
      {
        method: "POST",
        path: "/oauth2/v1/tokens/bearer",
        documentedAt: `${DOCS}/develop/authentication-and-authorization/oauth-2.0`,
        respond(request) {
          refreshes++;
          const form = new URLSearchParams(request.body);
          if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== refreshToken) return { status: 400, body: { error: "invalid_grant" } };
          issued++;
          refreshToken = `RT-TEST-${issued}`;
          const token = `AT-TEST-${issued}`;
          access.add(token);
          return { status: 200, body: { token_type: "bearer", access_token: token, expires_in: 3600, refresh_token: refreshToken, x_refresh_token_expires_in: 8_726_400 } };
        },
      },
    ],
  });

  const api = checkDocMock({
    integration: "quickbooks",
    baseUrl: SANDBOX,
    source: { url: `${DOCS}/api/accounting/all-entities/account`, title: "QuickBooks Online Accounting API", retrievedOn: "2026-10-21", version: "minorversion 75" },
    auth: "bearer",
    assumptions: [
      "ORDERBY Id gives a stable order for STARTPOSITION paging while the import runs",
      "MetaData.LastUpdatedTime filters take a time with an explicit +00:00 offset",
      "Active IN (true, false) works on Account, Customer and Vendor queries and returns inactive entries too",
      "Change data capture reports deleted entities with status Deleted and only their Id and MetaData",
      "A minorversion under 75 is refused; the docs say only that versions 1 to 74 were retired",
    ],
    routes: [
      {
        method: "GET",
        path: "/v3/company/{realmId}/query",
        documentedAt: `${DOCS}/learn/explore-the-quickbooks-online-api/data-queries`,
        respond(request, params) {
          if (!authorized(request.headers.get("authorization"))) return unauthorized;
          if (params.realmId !== QUICKBOOKS_TEST_REALM) return fault(403, "ApplicationAuthorizationFailed", "003100", "AuthorizationFault");
          if (!minor(request.url)) return fault(400, "Unsupported minor version", "2010");
          const m = QUERY.exec(request.url.searchParams.get("query") ?? "");
          if (!m) return fault(400, "QueryParserError: Encountered an error while parsing the query", "4000");
          const entity = QUICKBOOKS_MOCK_ENTITIES.find((e) => e.toLowerCase() === m[1]!.toLowerCase());
          if (!entity) return fault(400, `QueryValidationError: Invalid entity ${m[1]!.slice(0, 40)}`, "4001");
          const test = where(m[2]);
          if (typeof test === "string") return fault(400, test, "4000");
          const max = Number(m[5]);
          if (max > 1000) return fault(400, "QueryValidationError: MAXRESULTS cannot exceed 1000", "4001");
          const order = m[3] ?? "Id";
          const key = (r: QuickBooksMockRecord) => (order === "MetaData.LastUpdatedTime" ? r.MetaData.LastUpdatedTime : r.Id.padStart(12, "0"));
          const rows = (data.entities[entity] ?? []).filter((r) => test(r, entity)).sort((a, b) => key(a).localeCompare(key(b)));
          const start = Number(m[4]);
          const page = rows.slice(start - 1, start - 1 + max);
          return { status: 200, body: { QueryResponse: page.length ? { [entity]: page, startPosition: start, maxResults: page.length } : {}, time: data.now().toISOString() } };
        },
      },
      {
        method: "GET",
        path: "/v3/company/{realmId}/cdc",
        documentedAt: `${DOCS}/api/accounting/all-entities/changedatacapture`,
        respond(request, params) {
          if (!authorized(request.headers.get("authorization"))) return unauthorized;
          if (params.realmId !== QUICKBOOKS_TEST_REALM) return fault(403, "ApplicationAuthorizationFailed", "003100", "AuthorizationFault");
          if (!minor(request.url)) return fault(400, "Unsupported minor version", "2010");
          const since = Date.parse(request.url.searchParams.get("changedSince") ?? "");
          if (Number.isNaN(since)) return fault(400, "changedSince is required", "2020");
          if (since < data.now().getTime() - 30 * 86_400_000) return fault(400, "changedSince cannot be more than 30 days ago", "2030");
          const wanted = (request.url.searchParams.get("entities") ?? "").split(",");
          const groups = QUICKBOOKS_MOCK_ENTITIES.filter((e) => wanted.includes(e)).map((entity) => {
            const changed = (data.entities[entity] ?? []).filter((r) => Date.parse(r.MetaData.LastUpdatedTime) >= since);
            const gone = (data.deleted ?? [])
              .filter((d) => d.entity === entity && Date.parse(d.LastUpdatedTime) >= since)
              .map((d) => ({ Id: d.Id, status: "Deleted", MetaData: { LastUpdatedTime: d.LastUpdatedTime } }));
            return { [entity]: [...changed, ...gone], startPosition: 1, maxResults: changed.length + gone.length };
          });
          return { status: 200, body: { CDCResponse: [{ QueryResponse: groups }], time: data.now().toISOString() } };
        },
      },
    ],
  });

  const oauthFetch = docMockFetch(oauth);
  const apiFetch = docMockFetch(api);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      // Routed by exact origin, so a look-alike host such as oauth.platform.intuit.com.example.test goes to the API mock and is refused there.
      const toOauth = new URL(input instanceof Request ? input.url : String(input)).origin === OAUTH;
      const response = await (toOauth ? oauthFetch : apiFetch)(input, init);
      calls.push(...(toOauth ? oauthFetch.calls : apiFetch.calls).slice(-1));
      return response;
    },
    { calls },
  );
  return {
    oauth,
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
