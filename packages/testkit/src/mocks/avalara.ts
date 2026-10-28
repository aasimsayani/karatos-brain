import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, type DocMock, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * AvaTax REST API v2: the connection check, the company list and a
 * company's transactions, built from Avalara's API reference (as published
 * in the AvaTax SDK reference for API 26.10.0). Data is synthetic. AvaTax
 * gives developers a free sandbox account, which replaces this mock with
 * recordings once one is set up.
 *
 * The mock reads `$filter` the way the reference describes for the clauses
 * the connector sends (comparisons joined by `and`) and answers 400 to any
 * other, so a connector can't depend on filter syntax nobody has seen.
 */
const DOCS = "https://developer.avalara.com/api-reference/avatax/rest/v2";
const API = "https://sandbox-rest.avatax.com";

export interface AvalaraMockSummary {
  country: string;
  region: string;
  jurisType: "Country" | "State" | "County" | "City" | "Special";
  jurisCode: string;
  jurisName: string;
  taxAuthorityType: number;
  stateAssignedNo: string;
  taxType: string;
  taxSubType: string;
  taxName: string;
  rateType: string;
  taxable: number;
  rate: number;
  tax: number;
  taxCalculated: number;
  nonTaxable: number;
  exemption: number;
}

export interface AvalaraMockTransaction {
  id: number;
  code: string;
  companyId: number;
  date: string;
  taxDate: string;
  status: string;
  type: string;
  currencyCode: string;
  customerCode: string;
  customerUsageType?: string | null;
  entityUseCode?: string | null;
  exemptNo: string | null;
  reconciled: boolean;
  locationCode: string | null;
  purchaseOrderNo: string | null;
  salespersonCode: string | null;
  taxOverrideType: string;
  totalAmount: number;
  totalExempt: number;
  totalDiscount: number;
  totalTax: number;
  totalTaxable: number;
  totalTaxCalculated: number;
  adjustmentReason: string;
  adjustmentDescription: string | null;
  locked: boolean;
  region: string;
  country: string;
  version: number;
  description: string | null;
  email: string | null;
  businessIdentificationNo: string | null;
  customerSupplierName: string | null;
  modifiedDate: string;
  modifiedUserId: number;
  lines: unknown[];
  addresses: unknown[];
  summary: AvalaraMockSummary[];
}

export interface AvalaraMockCompany {
  id: number;
  accountId: number;
  companyCode: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  isTest: boolean;
  taxpayerIdNumber: string;
}

export const AVALARA_TEST_ACCOUNT = "2000000001";
export const AVALARA_TEST_COMPANY = "TESTSTORE";

export const avalaraCompany = fixtureBuilder<AvalaraMockCompany>((n) => ({
  id: 3000 + n,
  accountId: Number(AVALARA_TEST_ACCOUNT),
  companyCode: n === 1 ? AVALARA_TEST_COMPANY : `TESTSTORE${n}`,
  name: `Test Jewelers ${n}`,
  isDefault: n === 1,
  isActive: true,
  isTest: true,
  taxpayerIdNumber: "00-0000000",
}));

const summaryRow = (jurisType: AvalaraMockSummary["jurisType"], name: string, rate: number, taxable: number): AvalaraMockSummary => ({
  country: "US",
  region: "NY",
  jurisType,
  jurisCode: jurisType === "State" ? "36" : jurisType === "County" ? "061" : "51000",
  jurisName: name,
  taxAuthorityType: 45,
  stateAssignedNo: jurisType === "State" ? "" : "NE 8081",
  taxType: "Sales",
  taxSubType: "S",
  taxName: `NY ${jurisType.toUpperCase()} TAX`,
  rateType: "General",
  taxable,
  rate,
  tax: Math.round(taxable * rate * 100) / 100,
  taxCalculated: Math.round(taxable * rate * 100) / 100,
  nonTaxable: 0,
  exemption: 0,
});

/** A committed sale in New York City with personal fields filled with synthetic values, which the connector must drop. */
export const avalaraTransaction = fixtureBuilder<AvalaraMockTransaction>((n) => {
  const taxable = 1000 + n * 10;
  const summary = [summaryRow("State", "NEW YORK", 0.04, taxable), summaryRow("City", "NEW YORK CITY", 0.045, taxable), summaryRow("Special", "METROPOLITAN COMMUTER TRANSPORTATION DISTRICT", 0.00375, taxable)];
  const tax = Math.round(summary.reduce((s, r) => s + r.tax, 0) * 100) / 100;
  return {
    id: 500_000_000 + n,
    code: `TEST-ORDER-${1000 + n}`,
    companyId: 3001,
    date: synthetic.isoTime(n * 1440, "2026-06-01T00:00:00Z").slice(0, 10),
    taxDate: synthetic.isoTime(n * 1440, "2026-06-01T00:00:00Z").slice(0, 10),
    status: "Committed",
    type: "SalesInvoice",
    currencyCode: "USD",
    customerCode: `CUST-TEST-${n}`,
    customerUsageType: null,
    entityUseCode: null,
    exemptNo: null,
    reconciled: false,
    locationCode: "STORE-1",
    purchaseOrderNo: `PO-TEST-${n}`,
    salespersonCode: "TEST-REP",
    taxOverrideType: "None",
    totalAmount: taxable,
    totalExempt: 0,
    totalDiscount: 0,
    totalTax: tax,
    totalTaxable: taxable,
    totalTaxCalculated: tax,
    adjustmentReason: "NotAdjusted",
    adjustmentDescription: null,
    locked: false,
    region: "NY",
    country: "US",
    version: 1,
    description: `Engagement ring for ${synthetic.name(n)}`,
    email: synthetic.email(n),
    businessIdentificationNo: null,
    customerSupplierName: synthetic.name(n),
    modifiedDate: synthetic.isoTime(n * 1440 + 30, "2026-06-01T00:00:00Z").replace(".000Z", ".1234567Z"),
    modifiedUserId: 9001,
    lines: [{ lineNumber: "1", itemCode: "RING-TEST", description: "Test ring", lineAmount: taxable }],
    addresses: [{ boundaryLevel: "Address", line1: "1 Test Street", city: "New York", region: "NY", postalCode: "10001", country: "US" }],
    summary,
  };
});

export interface AvalaraMockData {
  accountId?: string;
  licenseKey: string;
  companies: AvalaraMockCompany[];
  /** Transactions by company code. */
  transactions: Record<string, AvalaraMockTransaction[]>;
  /** The mock's clock, for the 30-day default when no date filter is sent. */
  now?: () => Date;
  /** How many of the next requests answer 429, each with Retry-After of `retryAfterSeconds` (default 2). */
  rateLimited?: number;
  retryAfterSeconds?: number;
}

type Clause = { field: string; op: "eq" | "ne" | "gt" | "ge" | "lt" | "le"; value: string | number | boolean };
const CLAUSE = /^([A-Za-z]+) (eq|ne|gt|ge|lt|le) ('[^']*'|-?\d+|true|false)$/;

/** Reads a filter of comparisons joined by `and`, or null when it isn't one. */
function parseFilter(filter: string): Clause[] | null {
  const clauses: Clause[] = [];
  for (const part of filter.split(" and ")) {
    const m = CLAUSE.exec(part.trim());
    if (!m) return null;
    const raw = m[3]!;
    const value = raw.startsWith("'") ? raw.slice(1, -1) : raw === "true" ? true : raw === "false" ? false : Number(raw);
    clauses.push({ field: m[1]!, op: m[2] as Clause["op"], value });
  }
  return clauses;
}

const compare = (a: unknown, op: Clause["op"], b: Clause["value"]) => {
  const x = typeof b === "string" && typeof a === "string" && /^\d{4}-/.test(b) ? Date.parse(a.endsWith("Z") || a.length === 10 ? a : `${a}Z`) : a;
  const y = typeof b === "string" && /^\d{4}-/.test(b) ? Date.parse(b) : b;
  if (op === "eq") return x === y;
  if (op === "ne") return x !== y;
  if (typeof x !== typeof y) return false;
  const [p, q] = [x as number | string, y as number | string];
  return op === "gt" ? p > q : op === "ge" ? p >= q : op === "lt" ? p < q : p <= q;
};

const error = (status: number, code: string, message: string): DocMockResponse => ({ status, body: { error: { code, message, target: "Unknown", details: [{ code, number: status, message, severity: "Error" }] } } });
const INCLUDES = new Set(["Lines", "Details", "Summary", "Addresses", "SummaryOnly", "LinesOnly"]);

export function avalaraDocMock(data: AvalaraMockData): DocMock {
  const accountId = data.accountId ?? AVALARA_TEST_ACCOUNT;
  const credentials = (request: { headers: Headers }) => {
    const auth = request.headers.get("authorization") ?? "";
    return auth === `Basic ${Buffer.from(`${accountId}:${data.licenseKey}`).toString("base64")}`;
  };
  const gate = (request: { headers: Headers }): DocMockResponse | null => {
    if (!credentials(request)) return error(401, "AuthenticationException", "Authentication failed.");
    if (data.rateLimited) {
      data.rateLimited--;
      return { ...error(429, "TooManyRequests", "Too many requests."), headers: { "Retry-After": String(data.retryAfterSeconds ?? 2) } };
    }
    return null;
  };
  const listQuery = (url: URL) => {
    const top = Number(url.searchParams.get("$top") ?? 1000);
    const skip = Number(url.searchParams.get("$skip") ?? 0);
    if (!Number.isInteger(top) || top < 0 || !Number.isInteger(skip) || skip < 0) return { problem: error(400, "InvalidParameterValue", "$top and $skip must be whole numbers") };
    const raw = url.searchParams.get("$filter");
    const filter = raw === null ? [] : parseFilter(raw);
    if (!filter) return { problem: error(400, "FilterSyntax", "The filter could not be read.") };
    return { top: Math.min(top || 1000, 1000), skip, filter };
  };
  return checkDocMock({
    integration: "avalara",
    baseUrl: API,
    source: { url: `${DOCS}/`, title: "AvaTax REST API v2 reference", retrievedOn: "2026-10-28", version: "26.10.0" },
    auth: "basic",
    assumptions: [
      "$filter accepts comparisons joined by and, with quoted days and UTC times, and filters id and modifiedDate as well as date",
      "$orderBy accepts modifiedDate ASC, id ASC, and the order holds across pages",
      "$include=SummaryOnly returns the summary without lines, details or addresses",
      "A $top over 1,000 is capped at 1,000",
      "Enums such as status and type come back as their names, and modifiedDate is UTC with up to seven decimals",
      "A 429 carries Retry-After in seconds",
      "Ping answers 200 with authenticated false for credentials it turns down",
    ],
    routes: [
      {
        method: "GET",
        path: "/api/v2/utilities/ping",
        documentedAt: `${DOCS}/methods/Utilities/Ping/`,
        respond: (request) =>
          credentials(request)
            ? { status: 200, body: { version: "26.10.0", authenticated: true, authenticationType: "AccountIdLicenseKey", authenticatedUserName: accountId, authenticatedUserId: 0, authenticatedAccountId: Number(accountId), authenticatedCompanyId: 0, crmid: "0" } }
            : { status: 200, body: { version: "26.10.0", authenticated: false } },
      },
      {
        method: "GET",
        path: "/api/v2/companies",
        documentedAt: `${DOCS}/methods/Companies/QueryCompanies/`,
        respond(request) {
          const no = gate(request);
          if (no) return no;
          const q = listQuery(request.url);
          if ("problem" in q) return q.problem!;
          const rows = data.companies.filter((c) => q.filter.every((f) => compare((c as unknown as Record<string, unknown>)[f.field], f.op, f.value)));
          return { status: 200, body: { "@recordsetCount": rows.length, value: rows.slice(q.skip, q.skip + q.top) } };
        },
      },
      {
        method: "GET",
        path: "/api/v2/companies/{companyCode}/transactions",
        documentedAt: `${DOCS}/methods/Transactions/ListTransactionsByCompany/`,
        respond(request, params) {
          const no = gate(request);
          if (no) return no;
          if (!data.companies.some((c) => c.companyCode === params.companyCode)) return error(404, "EntityNotFoundError", "Company not found.");
          const q = listQuery(request.url);
          if ("problem" in q) return q.problem!;
          const includes = (request.url.searchParams.get("$include") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
          if (includes.some((i) => !INCLUDES.has(i))) return error(400, "InvalidParameterValue", "$include has a value that isn't documented");
          const filter = q.filter.some((f) => f.field === "date") ? q.filter : [...q.filter, { field: "date", op: "ge" as const, value: new Date((data.now?.() ?? new Date()).getTime() - 30 * 86_400_000).toISOString().slice(0, 10) }];
          const order = request.url.searchParams.get("$orderBy") ?? "id ASC";
          const keys = order.split(",").map((s) => s.trim().split(" ")) as [string, string?][];
          if (keys.some(([field, dir]) => !["id", "modifiedDate", "date"].includes(field) || (dir !== undefined && !/^(ASC|DESC)$/i.test(dir)))) return error(400, "InvalidParameterValue", "$orderBy can't be read");
          const value = (t: AvalaraMockTransaction, field: string) => (field === "id" ? t.id : Date.parse(field === "date" ? t.date : t.modifiedDate));
          const rows = (data.transactions[params.companyCode!] ?? [])
            .filter((t) => filter.every((f) => compare((t as unknown as Record<string, unknown>)[f.field], f.op, f.value)))
            .sort((a, b) => {
              for (const [field, dir] of keys) {
                const d = value(a, field) - value(b, field);
                if (d) return /^DESC$/i.test(dir ?? "") ? -d : d;
              }
              return 0;
            })
            .slice(q.skip, q.skip + q.top)
            .map((t) => (includes.includes("SummaryOnly") ? { ...t, lines: undefined, addresses: undefined } : includes.length ? t : { ...t, lines: undefined, addresses: undefined, summary: undefined }));
          return { status: 200, body: { "@recordsetCount": rows.length, value: rows, "@nextLink": `${API}${request.url.pathname}?$skip=${q.skip + q.top}` } };
        },
      },
    ],
  });
}

export default {
  integration: "avalara",
  covers: "AvaTax's connection check, company and transaction endpoints (REST API v2)",
  watchPages: [
    `${DOCS}/`,
    `${DOCS}/methods/Utilities/Ping/`,
    `${DOCS}/methods/Companies/QueryCompanies/`,
    `${DOCS}/methods/Transactions/ListTransactionsByCompany/`,
  ],
  docMocks: () => [avalaraDocMock({ licenseKey: "x".repeat(16), companies: [], transactions: {} })],
} satisfies DocMockModule;
