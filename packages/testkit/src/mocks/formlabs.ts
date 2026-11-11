import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * The Formlabs Web API (Dashboard Developer API), built from its published
 * OpenAPI reference. Data is synthetic. The API needs a Formlabs account
 * with a printer registered to Dashboard; until one is set up, this mock
 * stands in, and a live run confirms it.
 *
 * Docs facts the mock relies on:
 * - A token comes from POST /developer/v1/o/token/ on api.formlabs.com,
 *   form-encoded with grant_type client_credentials, client_id and
 *   client_secret. It answers access_token, token_type, expires_in and
 *   scope; bad credentials are 400 invalid_grant or 401 invalid_client.
 *   A token lasts a day.
 * - Every other endpoint takes the token as a bearer token.
 * - GET /developer/v1/prints/ takes date, date__gt and date__lt (ISO 8601),
 *   page, per_page, printer, status, material and name, and answers count,
 *   next, previous and results. A run has guid, name, printer, status,
 *   created_at, print_started_at, print_finished_at, layer_count,
 *   volume_ml, material, material_name, layer_thickness_mm, durations,
 *   print_run_success, user, note, group, parts and photo links.
 * - Over 1,500 requests an hour per user is answered 429 with Retry-After.
 */
const DOCS = {
  reference: "https://formlabs-dashboard-api-resources.s3.amazonaws.com/formlabs-web-api-latest.html",
} as const;
export const FORMLABS_DOC_PAGES = DOCS;

export type FormlabsMockRecord = Record<string, unknown>;

export interface FormlabsMockData {
  clientId: string;
  clientSecret: string;
  prints?: FormlabsMockRecord[];
  /** 429s to answer before the next reads. */
  rateLimits?: number;
  /** The tokens handed out are turned down this many times first, as if revoked. */
  expireTokens?: number;
}

const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (n: number, h = 0) => new Date(Date.UTC(2026, 9, 1) + n * 86_400_000 + h * 3_600_000).toISOString().replace(".000Z", "Z");

/** A castable wax ring print made `n` days into October 2026, finished. */
export const formlabsPrint = fixtureBuilder<FormlabsMockRecord>((n) => ({
  guid: guid(n),
  name: "Test Customer engagement ring",
  printer: "Form4-TestPrinter",
  status: "FINISHED",
  using_open_mode: false,
  print_started_at: at(n, 1),
  print_finished_at: at(n, 4),
  layer_count: 420,
  volume_ml: 3.2,
  material: "FLCWAX01",
  material_name: "Castable Wax 40",
  layer_thickness_mm: 0.025,
  currently_printing_layer: 420,
  estimated_duration_ms: 10_800_000,
  elapsed_duration_ms: 10_750_000,
  estimated_time_remaining_ms: 0,
  created_at: at(n),
  print_run_success: { print_run: guid(n), print_run_success: "SUCCESS", created_at: at(n, 5) },
  note: { print_run: guid(n), note: "Customer wants it by Friday", updated_at: at(n, 5) },
  print_thumbnail: { thumbnail: "https://example.test/thumb.png" },
  post_print_photo_url: "https://example.test/photo.jpg",
  user: { id: 7, username: "tech", first_name: "Test", last_name: "Tech", email: "tech@example.test" },
  user_custom_label: "",
  group: { id: guid(900), name: "Wax room" },
  message: null,
  parts: [{ id: n, guid: guid(500 + n), display_name: "Customer ring", name: "ring.stl", volume_ml: 3.2 }],
}));

const error = (status: number, body: Record<string, string>): DocMockResponse => ({ status, body });

export interface FormlabsMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each list read: its query. */
  readonly reads: Record<string, string>[];
  /** Tokens handed out. */
  readonly signIns: number;
}

export function formlabsDocMock(data: FormlabsMockData): FormlabsMock {
  const reads: Record<string, string>[] = [];
  let limits = data.rateLimits ?? 0;
  let expire = data.expireTokens ?? 0;
  let signIns = 0;
  const live = new Set<string>();
  const api = checkDocMock({
    integration: "formlabs",
    baseUrl: "https://api.formlabs.com",
    source: { url: DOCS.reference, title: "Formlabs Web API", retrievedOn: "2026-11-11", version: "0.8.1" },
    assumptions: [
      "date__gt and date__lt match created_at, exclusively",
      "Print runs list newest first, a stable order between two fixed times",
      "per_page up to 100 is honored",
      "A revoked or expired token is answered 401",
    ],
    routes: [
      {
        method: "POST",
        path: "/developer/v1/o/token/",
        documentedAt: DOCS.reference,
        respond(request) {
          const form = new URLSearchParams(request.body);
          if (request.headers.get("content-type") !== "application/x-www-form-urlencoded" || form.get("grant_type") !== "client_credentials") return error(400, { error: "unsupported_grant_type" });
          if (form.get("client_id") !== data.clientId) return error(401, { error: "invalid_client" });
          if (form.get("client_secret") !== data.clientSecret) return error(400, { error: "invalid_grant", error_description: "Invalid credentials given." });
          signIns++;
          const token = `tok${"0".repeat(20)}${signIns}`;
          live.add(token);
          return { status: 200, body: { access_token: token, token_type: "Bearer", expires_in: 86_400, scope: "developer-api" } };
        },
      },
      {
        method: "GET",
        path: "/developer/v1/prints/",
        documentedAt: DOCS.reference,
        respond(request) {
          const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
          if (!token || !live.has(token)) return error(401, { detail: "Authentication credentials were not provided." });
          if (expire > 0) {
            expire--;
            live.delete(token);
            return error(401, { detail: "Invalid token." });
          }
          if (limits > 0) {
            limits--;
            return { status: 429, body: { detail: "Request was throttled." }, headers: { "retry-after": "1" } };
          }
          const query = Object.fromEntries(request.url.searchParams);
          reads.push(query);
          const page = query.page === undefined ? 1 : Number(query.page);
          const size = query.per_page === undefined ? 20 : Number(query.per_page);
          if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 100) return error(404, { detail: "Invalid page." });
          const gt = query.date__gt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(query.date__gt);
          const lt = query.date__lt === undefined ? Number.POSITIVE_INFINITY : Date.parse(query.date__lt);
          if (Number.isNaN(gt) || Number.isNaN(lt)) return error(400, { detail: "Enter a valid date/time." });
          const rows = (data.prints ?? []).filter((p) => Date.parse(String(p.created_at)) > gt && Date.parse(String(p.created_at)) < lt).sort((x, y) => Date.parse(String(y.created_at)) - Date.parse(String(x.created_at)));
          const link = (p: number) => `https://api.formlabs.com/developer/v1/prints/?page=${p}`;
          return { status: 200, body: { count: rows.length, next: page * size < rows.length ? link(page + 1) : null, previous: page > 1 ? link(page - 1) : null, results: rows.slice((page - 1) * size, page * size) } };
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
    get signIns() {
      return signIns;
    },
  };
}

export default {
  integration: "formlabs",
  covers: "Formlabs' token endpoint and print runs list (Web API 0.8.1)",
  watchPages: [DOCS.reference],
  docMocks: () => [formlabsDocMock({ clientId: "", clientSecret: "" }).api],
} satisfies DocMockModule;
