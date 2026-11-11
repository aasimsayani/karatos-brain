import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse, type DocRoute } from "../doc-mock.js";

/**
 * ShipStation's API v2 shipment and label lists, built from ShipStation's
 * developer docs. Data is synthetic. API access depends on the account's
 * plan, so a client's account replaces this mock on the first live run.
 *
 * Docs facts the mock relies on:
 * - Every call goes to https://api.shipstation.com/v2 with the account's
 *   key in an `API-Key` header, and the key has the account's full access
 *   (authentication).
 * - GET /v2/shipments takes shipment_status, created_at_start and _end,
 *   modified_at_start and _end, page, page_size, sort_dir (asc, desc) and
 *   sort_by (modified_at, created_at), among others, and answers
 *   {shipments, total, page, pages, links}; a page past the last is empty
 *   (list-shipments).
 * - GET /v2/labels takes label_status, created_at_start and _end, page,
 *   page_size, sort_dir and sort_by (modified_at, created_at, voided_at),
 *   among others, and answers {labels, total, page, pages, links}
 *   (list-labels).
 * - Up to 200 requests a minute, then 429 with Retry-After (rate-limits).
 */
const DOCS = "https://docs.shipstation.com";
export const SHIPSTATION_DOC_PAGES = {
  shipments: `${DOCS}/apis/openapi/shipments/list_shipments.md`,
  labels: `${DOCS}/openapi/labels/list_labels.md`,
  auth: `${DOCS}/authentication`,
  limits: `${DOCS}/rate-limits`,
} as const;

export type ShipStationMockRecord = Record<string, unknown>;

const address = (n: number) => ({
  name: synthetic.name(n),
  phone: "+12125550100",
  email: synthetic.email(n),
  company_name: null,
  address_line1: `${100 + n} Test Street`,
  address_line2: null,
  address_line3: null,
  city_locality: "Testville",
  state_province: "NY",
  postal_code: "10001",
  country_code: "US",
  address_residential_indicator: "yes",
  instructions: null,
  geolocation: [],
});

/** A shipment of one ring insured for $2,400 against $2,500 paid, made and last changed `n` minutes into 2026. */
export const shipStationShipment = fixtureBuilder<ShipStationMockRecord>((n) => ({
  shipment_id: `se-${7000 + n}`,
  carrier_id: "se-123",
  service_code: "ups_next_day_air",
  external_order_id: `#${1000 + n}`,
  shipment_number: `S-${1000 + n}`,
  store_id: "se-55",
  order_source_code: "shopify",
  items: [{ name: "Solitaire ring", sku: "RING-14K-01", quantity: 1, unit_price: 2500, order_source_code: "shopify" }],
  notes_from_buyer: "Please leave with the doorman",
  notes_for_gift: "Happy anniversary",
  internal_notes: "Check the prong",
  is_gift: true,
  amount_paid: { currency: "usd", amount: 2500 },
  shipping_paid: { currency: "usd", amount: 0 },
  tax_paid: { currency: "usd", amount: 200 },
  ship_date: synthetic.isoTime(n + 60),
  created_at: synthetic.isoTime(n),
  modified_at: synthetic.isoTime(n),
  shipment_status: "label_purchased",
  ship_to: address(n),
  ship_from: address(0),
  return_to: address(0),
  is_return: false,
  confirmation: "adult_signature",
  insurance_provider: "shipsurance",
  tags: [{ name: "High value" }],
  packages: [{ package_code: "package", weight: { value: 4, unit: "ounce" }, insured_value: { currency: "usd", amount: 2400 } }],
  total_weight: { value: 4, unit: "ounce" },
  batch_ids: [],
  sales_order_ids: [],
}));

/** A delivered UPS label for shipment `n`, made `n` minutes into 2026. */
export const shipStationLabel = fixtureBuilder<ShipStationMockRecord>((n) => ({
  label_id: `se-${9000 + n}`,
  status: "completed",
  shipment_id: `se-${7000 + n}`,
  external_order_id: `#${1000 + n}`,
  ship_date: synthetic.isoTime(n + 60),
  created_at: synthetic.isoTime(n),
  shipment_cost: { currency: "usd", amount: 48.5 },
  insurance_cost: { currency: "usd", amount: 21 },
  tracking_number: `1ZTEST${String(100000 + n)}`,
  is_return_label: false,
  is_international: false,
  carrier_id: "se-123",
  carrier_code: "ups",
  service_code: "ups_next_day_air",
  voided: false,
  voided_at: null,
  confirmation: "adult_signature",
  tracking_status: "delivered",
  trackable: true,
  label_download: { href: "https://labels.example.test/label.pdf" },
  packages: [{ package_code: "package", weight: { value: 4, unit: "ounce" }, insured_value: { currency: "usd", amount: 2400 }, tracking_number: `1ZTEST${String(100000 + n)}` }],
  tracking_url: "https://track.example.test",
  ship_to: address(n),
}));

export interface ShipStationMockData {
  apiKey: string;
  shipments?: ShipStationMockRecord[];
  labels?: ShipStationMockRecord[];
  /** 429s to answer before the next reads. */
  rateLimits?: number;
}

const PARAMS: Record<string, { params: string[]; sorts: string[]; created: string; modified?: string }> = {
  shipments: {
    params: ["shipment_status", "batch_id", "tag", "created_at_start", "created_at_end", "modified_at_start", "modified_at_end", "page", "page_size", "sales_order_id", "sort_dir", "shipment_number", "ship_to_name", "item_keyword", "payment_date_start", "payment_date_end", "store_id", "external_shipment_id", "sort_by"],
    sorts: ["modified_at", "created_at"],
    created: "created_at",
    modified: "modified_at",
  },
  labels: {
    params: ["label_status", "service_code", "carrier_id", "tracking_number", "batch_id", "rate_id", "shipment_id", "external_shipment_id", "warehouse_id", "created_at_start", "created_at_end", "refund_status", "page", "page_size", "sort_dir", "sort_by"],
    sorts: ["modified_at", "created_at", "voided_at"],
    created: "created_at",
  },
};

export interface ShipStationMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each read: its list and query. */
  readonly reads: { list: string; query: Record<string, string> }[];
}

export function shipStationDocMock(data: ShipStationMockData): ShipStationMock {
  const reads: { list: string; query: Record<string, string> }[] = [];
  let limits = data.rateLimits ?? 0;
  const route = (list: "shipments" | "labels", rows: () => ShipStationMockRecord[], documentedAt: string): DocRoute => ({
    method: "GET",
    path: `/${list}`,
    documentedAt,
    respond(request): DocMockResponse {
      if (request.headers.get("api-key") !== data.apiKey) return { status: 401, body: { request_id: "test", errors: [{ error_source: "ShipStation", error_type: "security", error_code: "unauthorized", message: "The API key is invalid" }] } };
      if (limits > 0) {
        limits--;
        return { status: 429, body: { request_id: "test", errors: [{ error_source: "ShipStation", error_type: "system", error_code: "rate_limit_exceeded", message: "Too many requests" }] }, headers: { "retry-after": "1" } };
      }
      const spec = PARAMS[list]!;
      const q = Object.fromEntries(request.url.searchParams);
      const invalid = (message: string): DocMockResponse => ({ status: 400, body: { request_id: "test", errors: [{ error_source: "ShipStation", error_type: "validation", error_code: "invalid_field_value", message }] } });
      for (const name of Object.keys(q)) if (!spec.params.includes(name)) return invalid(`Unknown parameter ${name}`);
      const size = q.page_size === undefined ? 25 : Number(q.page_size);
      const page = q.page === undefined ? 1 : Number(q.page);
      if (!Number.isInteger(size) || size < 1 || size > 500 || !Number.isInteger(page) || page < 1) return invalid("Invalid paging");
      if (q.sort_by !== undefined && !spec.sorts.includes(q.sort_by)) return invalid("Invalid sort_by");
      if (q.sort_dir !== undefined && q.sort_dir !== "asc" && q.sort_dir !== "desc") return invalid("Invalid sort_dir");
      for (const name of ["created_at_start", "modified_at_start"]) if (q[name] !== undefined && Number.isNaN(Date.parse(q[name]!))) return invalid(`Invalid ${name}`);
      reads.push({ list, query: q });
      const field = q.sort_by ?? "created_at";
      let found = rows();
      if (q.created_at_start) found = found.filter((r) => String(r[spec.created]) >= q.created_at_start!);
      if (q.modified_at_start && spec.modified) found = found.filter((r) => String(r[spec.modified!]) >= q.modified_at_start!);
      const dir = q.sort_dir === "asc" ? 1 : -1;
      found = [...found].sort((a, b) => dir * String(a[field]).localeCompare(String(b[field])));
      const pages = Math.max(1, Math.ceil(found.length / size));
      return { status: 200, body: { [list]: found.slice((page - 1) * size, page * size), total: found.length, page, pages, links: { first: { href: "first" }, last: { href: "last" } } } };
    },
  });
  const api = checkDocMock({
    integration: "shipstation",
    baseUrl: "https://api.shipstation.com/v2",
    source: { url: SHIPSTATION_DOC_PAGES.shipments, title: "ShipStation API v2: list shipments and list labels", retrievedOn: "2026-11-11", version: "2.0.0" },
    assumptions: [
      "page_size goes up to at least 100",
      "A label's tracking_status moves without the label being made again, and labels have no modified time filter",
      "Amounts are in the currency's units, such as dollars",
      "The API key is 20 to 128 characters from letters, digits and _+/=-",
    ],
    routes: [route("shipments", () => data.shipments ?? [], SHIPSTATION_DOC_PAGES.shipments), route("labels", () => data.labels ?? [], SHIPSTATION_DOC_PAGES.labels)],
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
  integration: "shipstation",
  covers: "ShipStation's API v2 shipment and label lists",
  watchPages: [SHIPSTATION_DOC_PAGES.shipments, SHIPSTATION_DOC_PAGES.labels],
  docMocks: () => [shipStationDocMock({ apiKey: "" }).api],
} satisfies DocMockModule;
