import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * TaxJar's transaction and nexus reads, built from TaxJar's API reference
 * and its official SDKs' documented examples (taxjar on npm and PyPI).
 * Data is synthetic. TaxJar gives API tokens to paid accounts only, so a
 * client's token replaces this mock on the first live run.
 *
 * Docs facts the mock relies on:
 * - GET /v2/transactions/orders and /v2/transactions/refunds take
 *   transaction_date, or from_transaction_date and to_transaction_date
 *   (YYYY/MM/DD), and provider, which defaults to api; they answer
 *   {orders: [ids]} or {refunds: [ids]} (reference, list order and refund
 *   transactions; SDK examples).
 * - GET /v2/transactions/orders/{id} and /refunds/{id} take provider and
 *   answer {order: {...}} or {refund: {...}}, with transaction_date like
 *   "2015-05-14T00:00:00Z", amounts in dollars and line_items (reference).
 * - GET /v2/nexus/regions answers {regions: [{country_code, country,
 *   region_code, region}]} (reference).
 * - Requests carry Authorization: Bearer {token}, and x-api-version picks
 *   the API version (reference, authentication and versioning).
 * - The sales tax reporting guide says provider is api unless named, and
 *   names others such as amazon, ebay, etsy and walmart.
 */
export const TAXJAR_DOC_PAGES = {
  reference: "https://developers.taxjar.com/api/reference/",
  reporting: "https://developers.taxjar.com/integrations/sales-tax-reporting/",
} as const;

export type TaxjarMockTransaction = Record<string, unknown>;

export interface TaxjarMockData {
  apiToken: string;
  orders: TaxjarMockTransaction[];
  refunds?: TaxjarMockTransaction[];
  regions?: Record<string, unknown>[];
  /** Ids listed but gone when read, as if deleted in between. */
  vanished?: string[];
  /** 429s to answer before the next reads. */
  rateLimits?: number;
}

/** A sale recorded `n` days into 2026, through the API. */
const sale = (n: number): TaxjarMockTransaction => ({
  transaction_id: `T-${1000 + n}`,
  user_id: 11836,
  transaction_date: `${synthetic.isoTime(n * 1440).slice(0, 10)}T00:00:00Z`,
  transaction_reference_id: null,
  provider: "api",
  customer_id: `cust-${n}`,
  exemption_type: n % 3 === 0 ? "wholesale" : null,
  from_country: "US",
  from_zip: "10036",
  from_state: "NY",
  from_city: "NEW YORK",
  from_street: "1 Test Plaza",
  to_country: "US",
  to_zip: "90002",
  to_state: "CA",
  to_city: "LOS ANGELES",
  to_street: `${n} Test Lane`,
  amount: 1200 + n,
  shipping: 15,
  sales_tax: "95.25",
  line_items: [
    { id: "1", quantity: 1, product_identifier: `RING-${n}`, description: `Test ring for ${synthetic.name(n)}`, product_tax_code: null, unit_price: 1185 + n, discount: 0, sales_tax: 95.25 },
  ],
});
export const taxjarOrder = fixtureBuilder<TaxjarMockTransaction>(sale);

/** A refund of the sale with the same number. */
export const taxjarRefund = fixtureBuilder<TaxjarMockTransaction>((n) => ({
  ...sale(n),
  transaction_id: `T-${1000 + n}-refund`,
  transaction_reference_id: `T-${1000 + n}`,
  transaction_date: `${synthetic.isoTime(n * 1440 + 1440).slice(0, 10)}T00:00:00Z`,
  amount: -(1200 + n),
  shipping: -15,
  sales_tax: -95.25,
  line_items: [{ id: "1", quantity: 1, product_identifier: `RING-${n}`, unit_price: -(1185 + n), discount: 0, sales_tax: -95.25 }],
}));

const error = (status: number, err: string, detail: string): DocMockResponse => ({ status, body: { error: err, detail, status } });
const DAY = /^(\d{4})\/(\d{2})\/(\d{2})$/;
const day = (v: string) => v.replace(/\//g, "-");
const recorded = (t: TaxjarMockTransaction) => String(t.transaction_date).slice(0, 10);
const providerOf = (t: TaxjarMockTransaction) => String(t.provider ?? "api");

export interface TaxjarMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each list read: kind, days and provider. */
  readonly lists: { kind: string; from: string; to: string; provider: string }[];
  /** Each transaction read: kind, id and provider. */
  readonly shows: { kind: string; id: string; provider: string }[];
}

export function taxjarDocMock(data: TaxjarMockData): TaxjarMock {
  const lists: { kind: string; from: string; to: string; provider: string }[] = [];
  const shows: { kind: string; id: string; provider: string }[] = [];
  let limits = data.rateLimits ?? 0;
  const tables: Record<string, TaxjarMockTransaction[]> = { orders: data.orders, refunds: data.refunds ?? [] };

  /** The checks every read makes first; an answer when one turns the request down. */
  function gate(headers: Headers): DocMockResponse | null {
    if (headers.get("authorization") !== `Bearer ${data.apiToken}`) return error(401, "Unauthorized", "Not authorized for route");
    if (limits > 0) {
      limits--;
      return error(429, "Too Many Requests", "You have exceeded the rate limit");
    }
    return null;
  }

  const listRoute = (kind: "orders" | "refunds") => ({
    method: "GET" as const,
    path: `/transactions/${kind}`,
    documentedAt: TAXJAR_DOC_PAGES.reference,
    respond(request: { url: URL; headers: Headers }): DocMockResponse {
      const turned = gate(request.headers);
      if (turned) return turned;
      const q = request.url.searchParams;
      const from = q.get("from_transaction_date") ?? "";
      const to = q.get("to_transaction_date") ?? "";
      if (!DAY.test(from) || !DAY.test(to)) return error(400, "Bad Request", "from_transaction_date and to_transaction_date must be dates");
      const provider = q.get("provider") ?? "api";
      lists.push({ kind, from, to, provider });
      const ids = tables[kind]!.filter((t) => providerOf(t) === provider && recorded(t) >= day(from) && recorded(t) <= day(to)).map((t) => String(t.transaction_id));
      return { status: 200, body: { [kind]: ids } };
    },
  });

  const showRoute = (kind: "orders" | "refunds") => ({
    method: "GET" as const,
    path: `/transactions/${kind}/{id}`,
    documentedAt: TAXJAR_DOC_PAGES.reference,
    respond(request: { url: URL; headers: Headers }, params: Record<string, string>): DocMockResponse {
      const turned = gate(request.headers);
      if (turned) return turned;
      const provider = request.url.searchParams.get("provider") ?? "api";
      shows.push({ kind, id: params.id!, provider });
      const found = tables[kind]!.find((t) => t.transaction_id === params.id && providerOf(t) === provider);
      if (!found || data.vanished?.includes(params.id!)) return error(404, "Not Found", "Resource can't be found");
      return { status: 200, body: { [kind === "orders" ? "order" : "refund"]: found } };
    },
  });

  const api = checkDocMock({
    integration: "taxjar",
    baseUrl: "https://api.taxjar.com/v2",
    auth: "bearer",
    source: { url: TAXJAR_DOC_PAGES.reporting, title: "TaxJar API reference and sales tax reporting guide", retrievedOn: "2026-11-10", version: "v2 (2022-01-24)" },
    assumptions: [
      "from_transaction_date and to_transaction_date both include the day named",
      "An error body is {error, detail, status}, and a 429 carries no Retry-After header",
      "A transaction recorded through a platform integration is listed under that platform's provider name",
    ],
    routes: [
      listRoute("orders"),
      showRoute("orders"),
      listRoute("refunds"),
      showRoute("refunds"),
      {
        method: "GET",
        path: "/nexus/regions",
        documentedAt: TAXJAR_DOC_PAGES.reference,
        respond(request) {
          const turned = gate(request.headers);
          if (turned) return turned;
          return { status: 200, body: { regions: data.regions ?? [] } };
        },
      },
    ],
  });
  const fetch = docMockFetch(api);
  return {
    api,
    fetch,
    get lists() {
      return lists;
    },
    get shows() {
      return shows;
    },
  };
}

export default {
  integration: "taxjar",
  covers: "TaxJar's transaction and nexus reads",
  watchPages: [TAXJAR_DOC_PAGES.reporting, TAXJAR_DOC_PAGES.reference],
  docMocks: () => [taxjarDocMock({ apiToken: "", orders: [] }).api],
} satisfies DocMockModule;
