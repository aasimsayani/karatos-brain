import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse, type DocRoute } from "../doc-mock.js";

/**
 * Cin7 Core's API v2 lists of products, customers, suppliers, sales,
 * purchases and stock, built from Cin7 Core's help center articles on its
 * API. Data is synthetic. Cin7 Core needs a paid account (or a trial), so a
 * client's account replaces this mock on the first live run.
 *
 * Docs facts the mock relies on:
 * - Every call sends the account id in `api-auth-accountid` and an API
 *   application's key in `api-auth-applicationkey`; an account can have
 *   several applications (connecting).
 * - A wrong id or key is 403 "Method authentication failed", and past 60
 *   calls a minute Cin7 Core answers 503 (status codes).
 * - Lists page by number, 100 a page unless asked, 1 to 1000, and every
 *   answer carries the Total that match, as in {"Products": [...],
 *   "Total": 41} (pagination).
 * - Products, customers and suppliers take Page, Limit, Name,
 *   ModifiedSince (UTC) and IncludeDeprecated, and only active records
 *   come back without it; products also take Sku (products, customers,
 *   suppliers).
 * - SaleList and PurchaseList take Page, Limit, Search, UpdatedSince and
 *   status filters (sale list, purchase list).
 * - ProductAvailability takes Page, Limit, ID, Name, Sku, Location, Batch
 *   and Category, and gives a row for each product at each location, bin
 *   and batch (product availability).
 */
const HELP = "https://help.core.cin7.com/hc/en-us/articles";
export const CIN7_DOC_PAGES = {
  connecting: `${HELP}/9982480315407-Connecting-to-the-Cin7-Core-API`,
  products: `${HELP}/9034494038671-Products`,
  customers: `${HELP}/9034481116943-Customers`,
  suppliers: `${HELP}/9034604214159-Suppliers`,
  sales: `${HELP}/9034555593871-SaleList`,
  purchases: `${HELP}/9034547620751-PurchaseList`,
  stock: `${HELP}/9034523140879-ProductAvailability`,
  pagination: `${HELP}/9034488472207-Pagination`,
  statusCodes: `${HELP}/9034464091023-API-Status-Codes`,
} as const;

export type Cin7MockRecord = Record<string, unknown>;

/** A GUID for record `n` of a kind, with letters among the digits so no run of them looks like a card number. */
export const cin7Guid = (tag: string, n: number) => `${tag}${"0".repeat(7)}-0000-4000-8000-eeee${String(n).padStart(8, "0")}`;
/** `n` minutes into 2026, as Cin7 Core writes a UTC time: without the Z. */
export const cin7MockTime = (n: number) => synthetic.isoTime(n).slice(0, 19);

/** A gold ring product, last modified `n` minutes into 2026. */
export const cin7Product = fixtureBuilder<Cin7MockRecord>((n) => ({
  ID: cin7Guid("a", n),
  SKU: `RING-14K-${String(n).padStart(3, "0")}`,
  Name: `Test solitaire ring ${n}`,
  Category: "Rings",
  Brand: "Test Brand",
  Type: "Stock",
  CostingMethod: "FIFO",
  UOM: "Item",
  Barcode: `TEST${n}`,
  Status: "Active",
  PriceTier1: 1250.5,
  AverageCost: 410.25,
  Description: "<p>Test ring</p>",
  LastModifiedOn: cin7MockTime(n),
}));

const contacts = (n: number) => [{ Name: synthetic.name(n), Phone: synthetic.phone(n), MobilePhone: synthetic.phone(n + 1), Email: synthetic.email(n), Default: true }];
const addresses = (n: number) => [{ Line1: `${100 + n} Test Street`, City: "Testville", State: "NY", Postcode: "10001", Country: "US", Type: "Billing" }];

/** A wholesale customer, last modified `n` minutes into 2026. */
export const cin7Customer = fixtureBuilder<Cin7MockRecord>((n) => ({
  ID: cin7Guid("b", n),
  Name: `Test Boutique ${n}`,
  Currency: "USD",
  PaymentTerm: "30 days",
  TaxRule: "Tax Exempt",
  Status: "Active",
  Comments: "Prefers rose gold",
  Addresses: addresses(n),
  Contacts: contacts(n),
  LastModifiedOn: cin7MockTime(n),
}));

/** A casting supplier, last modified `n` minutes into 2026. */
export const cin7Supplier = fixtureBuilder<Cin7MockRecord>((n) => ({
  ID: cin7Guid("c", n),
  Name: `Test Casting ${n}`,
  Currency: "USD",
  PaymentTerm: "15 days",
  TaxRule: "Tax on Purchases",
  Status: "Active",
  Addresses: addresses(n),
  Contacts: contacts(n),
  LastModifiedOn: cin7MockTime(n),
}));

/** An invoiced sale of $2,500 with $1,000 paid, to customer `n`, updated `n` minutes into 2026. */
export const cin7Sale = fixtureBuilder<Cin7MockRecord>((n) => ({
  SaleID: cin7Guid("d", n),
  OrderNumber: `SO-${String(n).padStart(5, "0")}`,
  Status: "INVOICED",
  OrderDate: "2026-01-01T00:00:00",
  InvoiceDate: "2026-01-02T00:00:00",
  InvoiceDueDate: "2026-02-01T00:00:00",
  Customer: `Test Boutique ${n}`,
  CustomerID: cin7Guid("b", n),
  InvoiceNumber: `INV-${String(n).padStart(5, "0")}`,
  CustomerReference: "PO 7",
  InvoiceAmount: 2500,
  PaidAmount: 1000,
  BaseCurrency: "USD",
  CustomerCurrency: "USD",
  Updated: cin7MockTime(n),
}));

/** An ordered purchase of $900 from supplier `n`, updated `n` minutes into 2026. */
export const cin7Purchase = fixtureBuilder<Cin7MockRecord>((n) => ({
  ID: cin7Guid("e", n),
  BlindReceipt: false,
  OrderNumber: `PO-${String(n).padStart(5, "0")}`,
  Status: "ORDERED",
  OrderDate: "2026-01-03T00:00:00",
  InvoiceDate: null,
  Supplier: `Test Casting ${n}`,
  SupplierID: cin7Guid("c", n),
  InvoiceNumber: null,
  InvoiceAmount: 900,
  PaidAmount: 0,
  InvoiceDueDate: null,
  RequiredBy: "2026-01-20T00:00:00",
  BaseCurrency: "USD",
  SupplierCurrency: "USD",
  LastUpdatedDate: cin7MockTime(n),
}));

/** Product `n`'s stock at the main store: 3 on hand, 1 allocated. */
export const cin7Stock = fixtureBuilder<Cin7MockRecord>((n) => ({
  ID: cin7Guid("a", n),
  SKU: `RING-14K-${String(n).padStart(3, "0")}`,
  Name: `Test solitaire ring ${n}`,
  Barcode: `TEST${n}`,
  Location: "Main Store",
  Bin: null,
  Batch: null,
  ExpiryDate: null,
  OnHand: 3,
  Allocated: 1,
  Available: 2,
  OnOrder: 0,
  StockOnHand: 1230.75,
}));

export type Cin7MockList = "products" | "customers" | "suppliers" | "sales" | "purchases" | "stock";

export interface Cin7MockData {
  accountId: string;
  applicationKey: string;
  products?: Cin7MockRecord[];
  customers?: Cin7MockRecord[];
  suppliers?: Cin7MockRecord[];
  sales?: Cin7MockRecord[];
  purchases?: Cin7MockRecord[];
  stock?: Cin7MockRecord[];
  /** 503s (over 60 calls a minute) to answer before the next reads. */
  rateLimits?: number;
}

/** Each list's path, the key its rows come under, the parameters it takes, and its change field and filter. */
const SPECS: { list: Cin7MockList; path: string; rows: string; params: string[]; changed?: string; filter?: string; deprecated?: boolean }[] = [
  { list: "products", path: "/product", rows: "Products", params: ["ID", "Page", "Limit", "Name", "Sku", "ModifiedSince", "IncludeDeprecated", "IncludeBOM", "IncludeSuppliers", "IncludeMovements", "IncludeAttachments", "IncludeReorderLevels", "IncludeCustomPrices"], changed: "LastModifiedOn", filter: "ModifiedSince", deprecated: true },
  { list: "customers", path: "/customer", rows: "CustomerList", params: ["Page", "Limit", "ID", "Name", "ModifiedSince", "IncludeDeprecated", "IncludeProductPrices", "ContactFilter"], changed: "LastModifiedOn", filter: "ModifiedSince", deprecated: true },
  { list: "suppliers", path: "/supplier", rows: "SupplierList", params: ["Page", "Limit", "ID", "Name", "ModifiedSince", "IncludeDeprecated"], changed: "LastModifiedOn", filter: "ModifiedSince", deprecated: true },
  { list: "sales", path: "/saleList", rows: "SaleList", params: ["Page", "Limit", "Search", "CreatedSince", "UpdatedSince", "ShipBy", "QuoteStatus", "OrderStatus", "CombinedPickStatus", "CombinedPackStatus", "CombinedShippingStatus", "CombinedInvoiceStatus", "CreditNoteStatus", "ExternalID", "Status", "ReadyForShipping", "OrderLocationID"], changed: "Updated", filter: "UpdatedSince" },
  { list: "purchases", path: "/purchaseList", rows: "PurchaseList", params: ["Page", "Limit", "Search", "RequiredBy", "UpdatedSince", "OrderStatus", "RestockReceivedStatus", "InvoiceStatus", "CreditNoteStatus", "UnstockStatus", "Status", "DropShipTaskID"], changed: "LastUpdatedDate", filter: "UpdatedSince" },
  { list: "stock", path: "/ref/productavailability", rows: "ProductAvailabilityList", params: ["Page", "Limit", "ID", "Name", "Sku", "Location", "Batch", "Category"] },
];

/** A time as Cin7 Core writes it, read as UTC. */
const utc = (v: unknown) => (typeof v === "string" ? Date.parse(/Z$/.test(v) ? v : `${v}Z`) : Number.NaN);

export interface Cin7Mock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each read: its list and query. */
  readonly reads: { list: Cin7MockList; query: Record<string, string> }[];
}

export function cin7DocMock(data: Cin7MockData): Cin7Mock {
  const reads: { list: Cin7MockList; query: Record<string, string> }[] = [];
  let limits = data.rateLimits ?? 0;
  const error = (status: number, message: string): DocMockResponse => ({ status, body: [{ ErrorCode: status, Exception: message }] });
  const route = (spec: (typeof SPECS)[number]): DocRoute => ({
    method: "GET",
    path: spec.path,
    documentedAt: CIN7_DOC_PAGES[spec.list],
    respond(request): DocMockResponse {
      if (request.headers.get("api-auth-accountid") !== data.accountId || request.headers.get("api-auth-applicationkey") !== data.applicationKey) return error(403, "Method authentication failed");
      if (limits > 0) {
        limits--;
        return error(503, "You reached 60 calls per minute API limit");
      }
      const q = Object.fromEntries(request.url.searchParams);
      for (const name of Object.keys(q)) if (!spec.params.includes(name)) return error(400, `Unknown parameter ${name}`);
      const limit = q.Limit === undefined ? 100 : Number(q.Limit);
      const page = q.Page === undefined ? 1 : Number(q.Page);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(page) || page < 1) return error(400, "Page and Limit must be whole numbers, and Limit 1 to 1000");
      const since = spec.filter === undefined ? undefined : q[spec.filter];
      if (since !== undefined && Number.isNaN(utc(since))) return error(400, `${spec.filter} must be a date`);
      reads.push({ list: spec.list, query: q });
      let found = data[spec.list] ?? [];
      if (since !== undefined) found = found.filter((r) => utc(r[spec.changed!]) >= utc(since));
      if (spec.deprecated && q.IncludeDeprecated !== "true") found = found.filter((r) => r.Status !== "Deprecated");
      return { status: 200, body: { Total: found.length, Page: page, [spec.rows]: found.slice((page - 1) * limit, page * limit) } };
    },
  });
  const api = checkDocMock({
    integration: "cin7",
    baseUrl: "https://inventory.dearsystems.com/ExternalApi/v2",
    source: { url: CIN7_DOC_PAGES.connecting, title: "Cin7 Core API: connecting, and the product, customer, supplier, sale, purchase and availability lists", retrievedOn: "2026-11-11", version: "2" },
    assumptions: [
      "Customers, suppliers, sales, purchases and stock come under CustomerList, SupplierList, SaleList, PurchaseList and ProductAvailabilityList, as products come under Products",
      "Sale list rows carry their id as SaleID and the customer's as CustomerID; purchase list rows carry ID and SupplierID",
      "Times are UTC, written with or without a Z, and dates as midnight times",
      "Account ids and application keys are GUIDs",
      "Amounts are numbers in the currency's units, such as dollars",
      "A 401 means the same as the documented 403",
    ],
    routes: SPECS.map(route),
  });
  return {
    api,
    fetch: docMockFetch(api),
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "cin7",
  covers: "Cin7 Core's API v2 product, customer, supplier, sale, purchase and stock lists",
  watchPages: [CIN7_DOC_PAGES.connecting, CIN7_DOC_PAGES.products, CIN7_DOC_PAGES.customers, CIN7_DOC_PAGES.suppliers, CIN7_DOC_PAGES.sales, CIN7_DOC_PAGES.purchases, CIN7_DOC_PAGES.stock],
  docMocks: () => [cin7DocMock({ accountId: "", applicationKey: "" }).api],
} satisfies DocMockModule;
