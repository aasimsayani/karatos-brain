import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Katana's REST API (v1), built from developer.katanamrp.com. Data is
 * synthetic. Katana has a free trial; until a trial account is set up, this
 * mock stands in, and a run against it confirms it.
 *
 * Docs facts the mock relies on:
 * - Requests carry Authorization: Bearer <API key>; keys are made in
 *   Settings > API (authentication).
 * - GET /v1/manufacturing_orders lists orders, most recent first, and
 *   takes status, include_deleted, created_at_min/max, updated_at_min/max
 *   (ISO 8601), limit and page; soft-deleted orders are left out unless
 *   include_deleted is true (manufacturing orders).
 * - GET /v1/inventory lists stock by variant and location, with quantities
 *   as decimal strings, and extend=variant adds the variant (inventory).
 * - Lists answer {"data": [...]}, take limit (default 50, at most 250;
 *   more is cut to 250) and page (from 1), and put total_records,
 *   total_pages, offset, page, first_page and last_page in an X-Pagination
 *   header (pagination).
 * - 60 requests a minute; a 429 carries Retry-After in seconds (rate limiting).
 */
const DOCS = {
  authentication: "https://developer.katanamrp.com/reference/api-authentication",
  manufacturingOrders: "https://developer.katanamrp.com/reference/getallmanufacturingorders",
  inventory: "https://developer.katanamrp.com/reference/list-current-inventory",
  pagination: "https://developer.katanamrp.com/reference/api-pagination",
  rateLimiting: "https://developer.katanamrp.com/reference/api-rate-limiting",
} as const;
export const KATANA_DOC_PAGES = DOCS;

export type KatanaMockRecord = Record<string, unknown>;

export interface KatanaMockData {
  apiKey: string;
  manufacturingOrders: KatanaMockRecord[];
  inventory: KatanaMockRecord[];
  /** 429s to answer before the next reads. */
  rateLimits?: number;
}

const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString();

/** A ring in progress, `n` hours into 2026, with its materials in stock. */
export const katanaManufacturingOrder = fixtureBuilder<KatanaMockRecord>((n) => ({
  id: 21_400 + n,
  status: "IN_PROGRESS",
  order_no: `MO-${n}`,
  variant_id: 100 + (n % 7),
  planned_quantity: 2,
  actual_quantity: null,
  batch_transactions: [],
  location_id: 1,
  order_created_date: at(n),
  done_date: null,
  production_deadline_date: at(n + 240),
  additional_info: "Engrave for the customer",
  is_linked_to_sales_order: true,
  sales_order_id: 9000 + n,
  sales_order_row_id: 19_000 + n,
  sales_order_delivery_deadline: at(n + 336),
  ingredient_availability: "IN_STOCK",
  total_cost: 412.5,
  total_planned_time: 7200,
  total_actual_time: 3600,
  material_cost: 0,
  subassemblies_cost: 0,
  operations_cost: 0,
  custom_fields: [{ field_name: "Ring size", field_value: "7" }],
  serial_numbers: [{ id: n, serial_number: `SN${n}` }],
  traceability: [],
  created_at: at(n),
  updated_at: at(n),
  deleted_at: null,
}));

/** Stock of a 14K gold casting grain at the main location. */
export const katanaInventory = fixtureBuilder<KatanaMockRecord>((n) => ({
  variant_id: 500 + n,
  location_id: 1,
  reorder_point: "5.00000",
  average_cost: "10.0000000000",
  value_in_stock: "70.0000000000",
  quantity_in_stock: "7.00000",
  quantity_committed: "2.00000",
  quantity_expected: "0.00000",
  quantity_missing_or_excess: "-1.00000",
  quantity_potential: "0.00000",
  variant: { id: 500 + n, sku: `GR-14K-${n}`, product_or_material_name: "14K yellow casting grain", type: "material", sales_price: null, created_at: at(0), updated_at: at(0) },
}));

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const error = (status: number, message: string): DocMockResponse => ({ status, body: { statusCode: status, name: "Error", message } });

export interface KatanaMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each list request, as its path and query. */
  readonly reads: { path: string; query: Record<string, string> }[];
}

export function katanaDocMock(data: KatanaMockData): KatanaMock {
  const reads: { path: string; query: Record<string, string> }[] = [];
  let limits = data.rateLimits ?? 0;

  /** Checks the key and the paging, then answers one page of `rows`. */
  function page(path: string, request: { url: URL; headers: Headers }, rows: KatanaMockRecord[]): DocMockResponse {
    if (request.headers.get("authorization") !== `Bearer ${data.apiKey}`) return error(401, "Unauthorized");
    if (limits > 0) {
      limits--;
      return { status: 429, body: { statusCode: 429, name: "TooManyRequests", message: "Too many requests" }, headers: { "retry-after": "1" } };
    }
    const query = Object.fromEntries(request.url.searchParams);
    reads.push({ path, query });
    const limit = Math.min(query.limit === undefined ? 50 : Number(query.limit), 250);
    const number = query.page === undefined ? 1 : Number(query.page);
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(number) || number < 1) return error(422, "Invalid paging");
    const total = Math.ceil(rows.length / limit);
    const pagination = { total_records: String(rows.length), total_pages: String(total), offset: String((number - 1) * limit), page: String(number), first_page: String(number === 1), last_page: String(number >= total) };
    return { status: 200, body: { data: rows.slice((number - 1) * limit, number * limit) }, headers: { "x-pagination": JSON.stringify(pagination) } };
  }

  const api = checkDocMock({
    integration: "katana",
    baseUrl: "https://api.katanamrp.com/v1",
    source: { url: DOCS.authentication, title: "Katana API", retrievedOn: "2026-11-11", version: "v1" },
    auth: "bearer",
    assumptions: [
      "created_at_min and updated_at_min are inclusive and match created_at and updated_at",
      "A deleted order listed with include_deleted has deleted_at set and updated_at at the deletion",
      "Inventory has one row per variant and location, read whole on each request",
      "A key Katana doesn't take is answered 401",
    ],
    routes: [
      {
        method: "GET",
        path: "/manufacturing_orders",
        documentedAt: DOCS.manufacturingOrders,
        respond(request) {
          const q = request.url.searchParams;
          for (const name of ["created_at_min", "updated_at_min"]) if (q.has(name) && !TIME.test(q.get(name)!)) return error(422, `${name} is not a date`);
          const since = (field: string, name: string) => (r: KatanaMockRecord) => !q.has(name) || Date.parse(String(r[field])) >= Date.parse(q.get(name)!);
          const rows = data.manufacturingOrders
            .filter((r) => q.get("include_deleted") === "true" || r.deleted_at === null || r.deleted_at === undefined)
            .filter(since("created_at", "created_at_min"))
            .filter(since("updated_at", "updated_at_min"))
            .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)) || Number(b.id) - Number(a.id));
          return page("/manufacturing_orders", request, rows);
        },
      },
      {
        method: "GET",
        path: "/inventory",
        documentedAt: DOCS.inventory,
        respond(request) {
          const extend = request.url.searchParams.getAll("extend").flatMap((e) => e.split(","));
          const rows = data.inventory.map((r) => (extend.includes("variant") ? r : (({ variant: _, ...rest }) => rest)(r)));
          return page("/inventory", request, rows);
        },
      },
    ],
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
  integration: "katana",
  covers: "Katana's manufacturing orders and inventory lists (API v1)",
  watchPages: [DOCS.authentication, DOCS.manufacturingOrders, DOCS.inventory],
  docMocks: () => [katanaDocMock({ apiKey: "", manufacturingOrders: [], inventory: [] }).api],
} satisfies DocMockModule;
