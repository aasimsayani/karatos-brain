import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * Microsoft's client credentials sign-in and Business Central's API v2.0
 * lists of items, vendors, sales invoices and purchase invoices in one
 * company, as an e-Jewelry tenant serves them. Built from Business
 * Central's API reference and Microsoft's identity platform docs. Data is
 * synthetic. A jeweler's tenant replaces this mock on the first live run.
 *
 * Docs facts the mock relies on:
 * - A service-to-service token comes from
 *   `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`
 *   with grant_type client_credentials, the client id and secret, and scope
 *   `https://api.businesscentral.dynamics.com/.default`.
 * - Lists live at `/v2.0/{tenant}/{environment}/api/v2.0/companies({id})/{entitySet}`
 *   and take `$filter`, such as `lastModifiedDateTime ge 2026-01-01T00:00:00Z`.
 * - Business Central pages a list itself and adds `@odata.nextLink` while
 *   more rows remain.
 * - `Data-Access-Intent: ReadOnly` on a GET lets it read from a replica.
 * - Too many calls answer 429; 6,000 calls in five minutes are allowed.
 * - Items have a type of Inventory, Service or Non-Inventory and a boolean
 *   blocked; vendors have blocked as blank, Payment or All.
 */
const LOGIN = "https://login.microsoftonline.com";
const API = "https://api.businesscentral.dynamics.com";
const REF = "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro";
export const EJEWELRY_DOC_PAGES = {
  endpoints: `${REF}/api-reference/v2.0/endpoints-apis-for-dynamics`,
  s2s: `${REF}/administration/automation-apis-using-s2s-authentication`,
  filtering: `${REF}/developer/devenv-connect-apps-filtering`,
  limits: `${REF}/api-reference/v2.0/dynamics-rate-limits`,
  intent: `${REF}/developer/properties/devenv-dataaccessintent-property`,
  item: `${REF}/api-reference/v2.0/resources/dynamics_item`,
  vendor: `${REF}/api-reference/v2.0/resources/dynamics_vendor`,
  salesInvoice: `${REF}/api-reference/v2.0/resources/dynamics_salesinvoice`,
  purchaseInvoice: `${REF}/api-reference/v2.0/resources/dynamics_purchaseinvoice`,
} as const;

export type EJewelryMockRecord = Record<string, unknown>;
type MockList = "items" | "vendors" | "salesInvoices" | "purchaseInvoices";
const SCOPE = `${API}/.default`;

/** A synthetic GUID for row `n` of a kind (`k` 1 to 9). */
export const eJewelryGuid = (k: number, n: number) => `0000000${k}-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const EJEWELRY_TEST_TENANT = eJewelryGuid(9, 1);
export const EJEWELRY_TEST_COMPANY = eJewelryGuid(9, 2);
export const EJEWELRY_TEST_CLIENT = eJewelryGuid(9, 3);
export const EJEWELRY_TEST_ENVIRONMENT = "production";
/** A time Business Central writes: `n` minutes into 2026, to the millisecond. */
export const eJewelryTime = (n: number) => synthetic.isoTime(n);

/** An inventory item changed `n` minutes into 2026. */
export const eJewelryItem = fixtureBuilder<EJewelryMockRecord>((n) => ({
  "@odata.etag": `W/"test-${n}"`,
  id: eJewelryGuid(1, n),
  number: synthetic.sku(n),
  displayName: `Test Ring ${n}`,
  displayName2: "",
  type: "Inventory",
  itemCategoryCode: "RINGS",
  blocked: false,
  gtin: "",
  inventory: 4,
  unitPrice: 1250.5,
  priceIncludesTax: false,
  unitCost: 610.25,
  baseUnitOfMeasureCode: "PCS",
  lastModifiedDateTime: eJewelryTime(n),
}));

/** A vendor changed `n` minutes into 2026, owed 1,200.00. */
export const eJewelryVendor = fixtureBuilder<EJewelryMockRecord>((n) => ({
  "@odata.etag": `W/"test-${n}"`,
  id: eJewelryGuid(2, n),
  number: `V${1000 + n}`,
  displayName: `Test Casting Co ${n}`,
  addressLine1: `${n} Test Street`,
  city: "Testville",
  phoneNumber: "555-0100",
  email: synthetic.email(n),
  currencyCode: "",
  blocked: " ",
  balance: 1200,
  lastModifiedDateTime: eJewelryTime(n),
}));

/** An open sales invoice for 2,400.50 with 400.50 still owed, changed `n` minutes into 2026. */
export const eJewelrySalesInvoice = fixtureBuilder<EJewelryMockRecord>((n) => ({
  "@odata.etag": `W/"test-${n}"`,
  id: eJewelryGuid(3, n),
  number: `S-INV${1000 + n}`,
  invoiceDate: "2026-01-05",
  postingDate: "2026-01-05",
  dueDate: "2026-02-04",
  customerId: eJewelryGuid(5, n),
  customerNumber: `C${1000 + n}`,
  customerName: synthetic.name(n),
  billToName: synthetic.name(n),
  sellToAddressLine1: `${n} Test Street`,
  phoneNumber: "555-0100",
  email: synthetic.email(n),
  currencyCode: "USD",
  totalAmountExcludingTax: 2200.5,
  totalTaxAmount: 200,
  totalAmountIncludingTax: 2400.5,
  remainingAmount: 400.5,
  status: "Open",
  lastModifiedDateTime: eJewelryTime(n),
}));

/** An open purchase invoice for 900.00, changed `n` minutes into 2026. */
export const eJewelryPurchaseInvoice = fixtureBuilder<EJewelryMockRecord>((n) => ({
  "@odata.etag": `W/"test-${n}"`,
  id: eJewelryGuid(4, n),
  number: `P-INV${1000 + n}`,
  invoiceDate: "2026-01-06",
  postingDate: "2026-01-06",
  dueDate: "2026-02-05",
  vendorInvoiceNumber: `TC-${500 + n}`,
  vendorId: eJewelryGuid(2, n),
  vendorNumber: `V${1000 + n}`,
  vendorName: `Test Casting Co ${n}`,
  currencyCode: "USD",
  totalAmountExcludingTax: 900,
  totalTaxAmount: 0,
  totalAmountIncludingTax: 900,
  status: "Open",
  lastModifiedDateTime: eJewelryTime(n),
}));

export interface EJewelryMockData {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  environment?: string;
  companyId?: string;
  items?: EJewelryMockRecord[];
  vendors?: EJewelryMockRecord[];
  salesInvoices?: EJewelryMockRecord[];
  purchaseInvoices?: EJewelryMockRecord[];
  /** Rows on a page before Business Central adds a next link. */
  pageSize?: number;
  /** Lists the app's permission sets don't cover: they answer 403. */
  forbidden?: MockList[];
  /** 429s to answer before the next list calls. */
  rateLimits?: number;
  retryAfter?: string;
}

export interface EJewelryMock {
  login: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  /** Each list call: the list, its filter's start, the skip token, and its Data-Access-Intent. */
  readonly reads: { list: string; since: string | null; skip: number; intent: string | null }[];
  /** Makes every token handed out so far stop working. */
  revokeTokens(): void;
  readonly signIns: number;
}

const apiError = (status: number, code: string, message: string, headers?: Record<string, string>): DocMockResponse => ({ status, body: { error: { code, message } }, ...(headers ? { headers } : {}) });
const loginError = (status: number, error: string, code: number): DocMockResponse => ({ status, body: { error, error_description: `AADSTS${code}: synthetic.`, error_codes: [code] } });
const FILTER = /^lastModifiedDateTime ge (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,7})?Z)$/;

export function eJewelryDocMock(data: EJewelryMockData): EJewelryMock {
  const tokens = new Set<string>();
  const reads: EJewelryMock["reads"] = [];
  let signIns = 0;
  let limits = data.rateLimits ?? 0;
  const environment = data.environment ?? EJEWELRY_TEST_ENVIRONMENT;
  const company = data.companyId ?? EJEWELRY_TEST_COMPANY;
  const pageSize = data.pageSize ?? 20_000;
  const lists = new Map<string, EJewelryMockRecord[]>([
    ["items", data.items ?? []],
    ["vendors", data.vendors ?? []],
    ["salesInvoices", data.salesInvoices ?? []],
    ["purchaseInvoices", data.purchaseInvoices ?? []],
  ]);

  const login = checkDocMock({
    integration: "bci_e_jewelry",
    baseUrl: LOGIN,
    source: { url: EJEWELRY_DOC_PAGES.s2s, title: "Business Central service-to-service authentication with the OAuth 2.0 client credentials flow", retrievedOn: "2026-11-11", version: "v2.0" },
    assumptions: ["A wrong client secret answers 401 invalid_client, an unknown app 400 unauthorized_client, and an unknown tenant 400 invalid_request, as for Microsoft Graph"],
    routes: [
      {
        method: "POST",
        path: "/{tenant}/oauth2/v2.0/token",
        documentedAt: EJEWELRY_DOC_PAGES.s2s,
        respond(request, params) {
          const form = new URLSearchParams(request.body);
          if (params.tenant !== data.tenantId) return loginError(400, "invalid_request", 90002);
          if (form.get("grant_type") !== "client_credentials") return loginError(400, "unsupported_grant_type", 70003);
          if (form.get("client_id") !== data.clientId) return loginError(400, "unauthorized_client", 700016);
          if (form.get("client_secret") !== data.clientSecret) return loginError(401, "invalid_client", 7000215);
          if (form.get("scope") !== SCOPE) return loginError(400, "invalid_scope", 1002012);
          const token = `bc-test-token-${++signIns}`;
          tokens.add(token);
          return { status: 200, body: { token_type: "Bearer", expires_in: 3599, ext_expires_in: 3599, access_token: token } };
        },
      },
    ],
  });

  function list(request: DocMockRequest, params: Record<string, string>, name: MockList): DocMockResponse {
    if (!tokens.has((request.headers.get("authorization") ?? "").slice("Bearer ".length))) return apiError(401, "Authentication_InvalidCredentials", "The server has rejected the client credentials.");
    if (limits > 0) {
      limits--;
      return apiError(429, "Application_TooManyRequests", "Too many requests reached.", data.retryAfter === undefined ? undefined : { "Retry-After": data.retryAfter });
    }
    if (params.tenant !== data.tenantId || params.environment !== environment || params.company?.toLowerCase() !== `companies(${company})`) return apiError(404, "BadRequest_NotFound", "The requested company was not found.");
    if (data.forbidden?.includes(name)) return apiError(403, "Authorization_InsufficientPermissions", `You do not have the following permissions on TableData ${name}: Read.`);
    const q = request.url.searchParams;
    if ([...q.keys()].some((k) => k !== "$filter" && k !== "$skiptoken")) return apiError(400, "BadRequest", "The query parameter is not supported.");
    const filter = q.get("$filter");
    const since = filter === null ? null : (FILTER.exec(filter)?.[1] ?? "bad");
    if (since === "bad") return apiError(400, "BadRequest", "The filter is not supported by this mock.");
    const skipRaw = q.get("$skiptoken");
    const skip = skipRaw === null ? 0 : Number(skipRaw);
    if (!Number.isSafeInteger(skip) || skip < 0) return apiError(400, "BadRequest", "The skip token is invalid.");
    reads.push({ list: name, since, skip, intent: request.headers.get("data-access-intent") });
    const rows = lists.get(name)!.filter((r) => since === null || Date.parse(String(r.lastModifiedDateTime)) >= Date.parse(since));
    const value = rows.slice(skip, skip + pageSize);
    const more = skip + value.length < rows.length;
    const link = `${API}${request.url.pathname}?${new URLSearchParams([...(filter === null ? [] : [["$filter", filter]]), ["$skiptoken", String(skip + value.length)]])}`;
    return { status: 200, body: { "@odata.context": `${API}${request.url.pathname}/$metadata`, value, ...(more ? { "@odata.nextLink": link } : {}) } };
  }

  const companyPath = "/v2.0/{tenant}/{environment}/api/v2.0/{company}";
  const api = checkDocMock({
    integration: "bci_e_jewelry",
    baseUrl: API,
    source: { url: EJEWELRY_DOC_PAGES.endpoints, title: "Business Central API (v2.0): endpoints, filtering and rate limits", retrievedOn: "2026-11-11", version: "v2.0" },
    auth: "bearer",
    assumptions: [
      "e-Jewelry keeps its jewelers' items, vendors and invoices in Business Central's standard tables, so the standard API v2.0 lists read them",
      "A next link keeps the list's filter and adds a skip token",
      "An app without a permission set covering a list answers 403, and an unknown environment or company 404",
      "lastModifiedDateTime comes back in UTC with a Z",
    ],
    routes: (["items", "vendors", "salesInvoices", "purchaseInvoices"] as const).map((name) => ({
      method: "GET" as const,
      path: `${companyPath}/${name}`,
      documentedAt: EJEWELRY_DOC_PAGES[name === "items" ? "item" : name === "vendors" ? "vendor" : name === "salesInvoices" ? "salesInvoice" : "purchaseInvoice"],
      respond: (request: DocMockRequest, params: Record<string, string>) => list(request, params, name),
    })),
  });

  const loginFetch = docMockFetch(login);
  const apiFetch = docMockFetch(api);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      // Each mock refuses any other host, so a look-alike is refused either way.
      const toLogin = String(input).startsWith(`${LOGIN}/`);
      const response = await (toLogin ? loginFetch : apiFetch)(input, init);
      calls.push(...(toLogin ? loginFetch.calls : apiFetch.calls).slice(-1));
      return response;
    },
    { calls },
  );

  return {
    login,
    api,
    fetch,
    get reads() {
      return reads;
    },
    revokeTokens: () => tokens.clear(),
    get signIns() {
      return signIns;
    },
  };
}

export default {
  integration: "bci_e_jewelry",
  covers: "Microsoft's client credentials sign-in and Business Central's API v2.0 lists of items, vendors, sales invoices and purchase invoices, with filters and next links",
  watchPages: [EJEWELRY_DOC_PAGES.s2s, EJEWELRY_DOC_PAGES.endpoints, EJEWELRY_DOC_PAGES.item, EJEWELRY_DOC_PAGES.vendor, EJEWELRY_DOC_PAGES.salesInvoice, EJEWELRY_DOC_PAGES.purchaseInvoice],
  docMocks: () => {
    const mock = eJewelryDocMock({ tenantId: "", clientId: "", clientSecret: "" });
    return [mock.login, mock.api];
  },
} satisfies DocMockModule;
