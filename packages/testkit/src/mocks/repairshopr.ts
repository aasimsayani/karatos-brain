import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * RepairShopr's REST API, built from its swagger docs and help center.
 * Data is synthetic. RepairShopr offers a free trial; until a trial account
 * is set up, this mock stands in, and a trial run confirms it.
 *
 * Docs facts the mock relies on:
 * - Each account is at https://{subdomain}.repairshopr.com/api/v1 (rest-api),
 *   and its operations take a bearer token (swagger, `bearerAuth`), an API
 *   token whose custom permissions choose what it can read (api-tokens).
 * - GET /tickets takes since_updated_at and page, GET /invoices takes
 *   since_updated_at and page, and GET /estimates takes created_after and
 *   page (swagger). Each needs its List/Search permission.
 * - Tickets and invoices come 25 to a page, estimates 50 (swagger).
 * - A list answers its records under the list's name, with
 *   meta {total_pages, total_entries, per_page, page} (swagger, on /contacts).
 * - Ticket, estimate and invoice fields are as the swagger lists them: a
 *   ticket's number is a number, an invoice's and an estimate's a string,
 *   and their money is strings.
 * - The limit is 180 requests a minute per IP address (swagger).
 */
const DOCS = {
  swagger: "https://api-docs.repairshopr.com/",
  restApi: "https://repair.uservoice.com/knowledgebase/articles/376312-repairshopr-http-rest-api",
  apiTokens: "https://repair.uservoice.com/knowledgebase/articles/1959628-updating-legacy-repairshopr-api-tokens-for-existin",
} as const;
export const REPAIRSHOPR_DOC_PAGES = DOCS;

export type RepairShoprMockRecord = Record<string, unknown>;

export interface RepairShoprMockData {
  token: string;
  tickets?: RepairShoprMockRecord[];
  estimates?: RepairShoprMockRecord[];
  invoices?: RepairShoprMockRecord[];
  /** 429s to answer before the next reads. */
  rateLimits?: number;
  /** Base URL: https://example.repairshopr.com unless a test says otherwise. */
  baseUrl?: string;
}

/** A time `n` hours into 2026, as RepairShopr writes it, at a US Eastern offset. */
const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 3_600_000 - 5 * 3_600_000).toISOString().replace("Z", "-05:00");
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
const customer = { id: 7, firstname: "Test", lastname: "Customer", business_name: null, email: "customer@example.test", phone: "555-0100", address: "1 Test St" };

/** A watch service ticket opened `n` days into 2026, waiting on parts. */
export const repairShoprTicket = fixtureBuilder<RepairShoprMockRecord>((n) => ({
  id: n,
  number: 1000 + n,
  subject: "Test watch service, crown sticks",
  status: "Waiting on Parts",
  problem_type: "Watch service",
  customer_id: 7,
  customer_business_then_name: "Test Customer",
  user_id: 2,
  location_id: 1,
  due_date: `${day(n + 14)}T17:00:00.000-05:00`,
  created_at: at(n * 24),
  updated_at: at(n * 24 + 2),
  comments: [{ id: n, subject: "Note", body: "Customer called about the crown", tech: "Test Tech" }],
  customer,
}));

/** The $480 estimate for ticket `n`, approved. */
export const repairShoprEstimate = fixtureBuilder<RepairShoprMockRecord>((n) => ({
  id: n,
  number: `E${2000 + n}`,
  status: "approved",
  customer_id: 7,
  customer_business_then_name: "Test Customer",
  date: `${day(n)}T00:00:00.000-05:00`,
  subtotal: "450.0",
  tax: "30.0",
  total: "480.0",
  note: "Includes a new crown and tube",
  created_at: at(n * 24 + 1),
  updated_at: at(n * 24 + 3),
}));

/** The $480 invoice for ticket `n`, paid. */
export const repairShoprInvoice = fixtureBuilder<RepairShoprMockRecord>((n) => ({
  id: n,
  number: `${3000 + n}`,
  customer_id: 7,
  customer_business_then_name: "Test Customer",
  ticket_id: n,
  location_id: 1,
  contact_id: null,
  user_id: 2,
  date: `${day(n + 10)}T00:00:00.000-05:00`,
  due_date: `${day(n + 10)}T00:00:00.000-05:00`,
  subtotal: "450.0",
  tax: "30.0",
  total: "480.0",
  hardwarecost: "120.0",
  is_paid: true,
  verified_paid: false,
  tech_marked_paid: true,
  po_number: "PO-1",
  note: "Picked up by the customer",
  pdf_url: "https://example.test/invoice.pdf",
  created_at: at((n + 10) * 24),
  updated_at: at((n + 10) * 24 + 1),
}));

const LISTS = { tickets: { since: "since_updated_at", field: "updated_at", size: 25 }, estimates: { since: "created_after", field: "created_at", size: 50 }, invoices: { since: "since_updated_at", field: "updated_at", size: 25 } } as const;

const error = (status: number, message: string): DocMockResponse => ({ status, body: { message } });

export interface RepairShoprMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each list read: the list and its query. */
  readonly reads: { list: string; query: Record<string, string> }[];
}

export function repairShoprDocMock(data: RepairShoprMockData): RepairShoprMock {
  const base = data.baseUrl ?? "https://example.repairshopr.com";
  const reads: { list: string; query: Record<string, string> }[] = [];
  let limits = data.rateLimits ?? 0;
  const api = checkDocMock({
    integration: "repairshopr",
    baseUrl: base,
    auth: "bearer",
    source: { url: DOCS.swagger, title: "RepairShopr API", retrievedOn: "2026-11-11", version: "API v1" },
    assumptions: [
      "Tickets, estimates and invoices answer under their list's name with meta.total_pages, as /contacts does",
      "since_updated_at and created_after take an ISO time and match at or after it",
      "Pages list a stable order, oldest ID first",
      "A token RepairShopr doesn't take, or one without the permission, is answered 401",
      "Over the limit is answered 429",
    ],
    routes: [
      {
        method: "GET",
        path: "/api/v1/{list}",
        documentedAt: DOCS.swagger,
        respond(request, params) {
          if (request.headers.get("authorization") !== `Bearer ${data.token}`) return error(401, "Unauthorized");
          if (limits > 0) {
            limits--;
            return { status: 429, body: { message: "Rate limit exceeded" }, headers: { "retry-after": "1" } };
          }
          const list = params.list as keyof typeof LISTS;
          const spec = LISTS[list];
          if (!spec) return error(404, "Not found");
          const query = Object.fromEntries(request.url.searchParams);
          reads.push({ list, query });
          const page = query.page === undefined ? 1 : Number(query.page);
          if (!Number.isInteger(page) || page < 1) return error(400, "page must be 1 or more");
          const since = query[spec.since];
          const from = since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since);
          if (Number.isNaN(from)) return error(400, `${spec.since} is not a time`);
          const rows = (data[list] ?? []).filter((rec) => Date.parse(String(rec[spec.field])) >= from).sort((x, y) => Number(x.id) - Number(y.id));
          const totalPages = Math.ceil(rows.length / spec.size);
          return { status: 200, body: { [list]: rows.slice((page - 1) * spec.size, page * spec.size), meta: { total_pages: totalPages, total_entries: rows.length, per_page: spec.size, page } } };
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
  integration: "repairshopr",
  covers: "RepairShopr's ticket, estimate and invoice lists (API v1)",
  watchPages: [DOCS.swagger],
  docMocks: () => [repairShoprDocMock({ token: "" }).api],
} satisfies DocMockModule;
