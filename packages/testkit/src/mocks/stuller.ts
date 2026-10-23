import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, type DocMock, type DocMockModule } from "../doc-mock.js";

/**
 * Stuller's Invoice and metal market rate endpoints, built from the API help
 * pages (API v2, Basic auth with a developer login). Data is synthetic.
 */
const HELP = "https://api.stuller.com/Help/Api";

export interface StullerInvoiceDetail {
  LineNumber: number;
  CustomerLineReference: string;
  ItemNumber: string;
  ItemDescription: string;
  ShipQuantity: number;
  BackOrderedQuantity: number;
  LaborOtherCharges: string;
  TotalWeight: string;
  UnitPrice: number;
  LineTotal: number;
  CustomerNotes: string;
  UnitPriceUnitOfMeasure: string;
}

export interface StullerInvoice {
  OrderNumber: string;
  InvoiceNumber: string;
  PurchaseOrderNumber: string;
  ShipToAccountNumber: string;
  ShipToAddress1: string;
  ShipToAddress2: string;
  ShipToAddress3: string;
  ShipToCity: string;
  ShipToState: string;
  ShipToZip: string;
  ShipToProvince: string;
  ShipToCountry: string;
  Status: string;
  OrderTotal: number;
  InvoiceTotal: number;
  TotalDue: number;
  SalesTax: number;
  PostageAndHandling: number;
  InvoiceDate: string;
  OrderDate: string;
  ShipMethod: string;
  TrackingNumber: string;
  TrackingLink: string;
  GoldMarketRate: number;
  GoldMarketBase: number;
  GoldMarketAdder: string;
  PlatinumMarketRate: number;
  SilverMarketRate: number;
  PlatinumMarketBase: number;
  SilverMarketBase: number;
  PlatinumMarketAdder: string;
  SilverMarketAdder: string;
  InvoiceDetails: StullerInvoiceDetail[];
}

export const stullerInvoiceDetail = fixtureBuilder<StullerInvoiceDetail>((n) => ({
  LineNumber: n,
  CustomerLineReference: `LINE-TEST-${n}`,
  ItemNumber: synthetic.sku(n),
  ItemDescription: `Test 14K yellow solitaire mounting ${n}`,
  ShipQuantity: 1,
  BackOrderedQuantity: 0,
  LaborOtherCharges: "0.00",
  TotalWeight: "2.10 DWT",
  UnitPrice: 250 + n,
  LineTotal: 250 + n,
  CustomerNotes: "",
  UnitPriceUnitOfMeasure: "EA",
}));

export const stullerInvoice = fixtureBuilder<StullerInvoice>((n) => {
  const lines = [stullerInvoiceDetail.one({ LineNumber: 1 }), stullerInvoiceDetail.one({ LineNumber: 2 })];
  const subtotal = lines.reduce((sum, l) => sum + l.LineTotal, 0);
  return {
    OrderNumber: `ORD-TEST-${n}`,
    InvoiceNumber: `INV-TEST-${n}`,
    PurchaseOrderNumber: `PO-TEST-${n}`,
    ShipToAccountNumber: `ACCT-TEST-1`,
    ShipToAddress1: `${n} Test Street`,
    ShipToAddress2: "",
    ShipToAddress3: "",
    ShipToCity: "Testville",
    ShipToState: "NY",
    ShipToZip: "00000",
    ShipToProvince: "",
    ShipToCountry: "US",
    Status: "Shipped",
    OrderTotal: subtotal,
    InvoiceTotal: subtotal + 12,
    TotalDue: subtotal + 12,
    SalesTax: 0,
    PostageAndHandling: 12,
    InvoiceDate: synthetic.isoTime(n * 1440 + 60),
    OrderDate: synthetic.isoTime(n * 1440),
    ShipMethod: "Test Ground",
    TrackingNumber: `TRACK-TEST-${n}`,
    TrackingLink: `https://tracking.example.test/TRACK-TEST-${n}`,
    GoldMarketRate: 2700,
    GoldMarketBase: 2600,
    GoldMarketAdder: "0.00",
    PlatinumMarketRate: 1000,
    SilverMarketRate: 32,
    PlatinumMarketBase: 950,
    SilverMarketBase: 30,
    PlatinumMarketAdder: "0.00",
    SilverMarketAdder: "0.00",
    InvoiceDetails: lines,
  };
});

export interface StullerMockData {
  invoices: StullerInvoice[];
  metalRates: { Type: "Gold" | "Silver" | "Platinum" | "Palladium"; Rate: number }[];
}

export function stullerDocMock(data: StullerMockData): DocMock {
  const wanted = (url: URL, name: string) => url.searchParams.getAll(name).flatMap((v) => v.split(",")).filter(Boolean);
  return checkDocMock({
    integration: "stuller",
    baseUrl: "https://api.stuller.com",
    source: { url: "https://api.stuller.com/help", title: "Stuller API help", retrievedOn: "2026-10-15", version: "v2" },
    auth: "basic",
    assumptions: [
      "GET /api/v2/invoice with no PurchaseOrderNumber or InvoiceNumber returns every invoice; the docs list the filters but not the default",
      "Several values for one filter are sent as repeated query parameters or comma separated",
      "Filters combine with AND",
      "MetalMarket Rate is a price in US dollars per troy ounce; the docs' sample shows 1.0 placeholders and no unit",
    ],
    routes: [
      {
        method: "GET",
        path: "/api/v2/invoice",
        documentedAt: `${HELP}/GET-namespace-v2.Invoice-Rest`,
        respond(request) {
          const pos = wanted(request.url, "PurchaseOrderNumber");
          const numbers = wanted(request.url, "InvoiceNumber");
          const invoices = data.invoices.filter(
            (i) => (!pos.length || pos.includes(i.PurchaseOrderNumber)) && (!numbers.length || numbers.includes(i.InvoiceNumber)),
          );
          return { status: 200, body: { Invoices: invoices } };
        },
      },
      {
        method: "GET",
        path: "/api/v2/products/metalmarketrates",
        documentedAt: `${HELP}/GET-namespace-v2.Products-MetalMarketRates`,
        respond: () => ({ status: 200, body: { MetalMarkets: data.metalRates } }),
      },
    ],
  });
}

export default {
  integration: "stuller",
  covers: "Stuller's invoice and metal market rate endpoints (API v2)",
  watchPages: [
    "https://api.stuller.com/help",
    "https://api.stuller.com/Help/Api/GET-namespace-v2.Invoice-Rest",
    "https://api.stuller.com/Help/Api/GET-namespace-v2.Products-MetalMarketRates",
  ],
  docMocks: () => [stullerDocMock({ invoices: [], metalRates: [] })],
} satisfies DocMockModule;
