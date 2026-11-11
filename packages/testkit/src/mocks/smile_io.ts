import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * Smile.io's List VIP tiers, List customers and List points transactions,
 * built from Smile's developer docs. Data is synthetic. Merchant API keys
 * need Smile's Plus or Enterprise plan, so a client's key replaces this
 * mock on the first live run.
 *
 * Docs facts the mock relies on:
 * - Every request goes to https://api.smile.io/v1 with
 *   `Authorization: Bearer <key>`; merchant keys start with api_
 *   (authentication).
 * - Merchant keys are made with the scopes an integration needs
 *   (merchant-credentials); List customers needs customer:read, List
 *   points transactions points_transaction:read and List VIP tiers
 *   vip_tier:read (each endpoint's page).
 * - GET /customers takes email, state, updated_at_min, limit (1 to 250, 50
 *   by default), cursor and include=vip_status, sorted by id descending,
 *   and answers {customers, metadata: {next_cursor, previous_cursor}}
 *   (list-customers).
 * - GET /points_transactions takes customer_id, updated_at_min, limit and
 *   cursor, sorted by id descending (list-points-transactions).
 * - GET /vip_tiers takes include and isn't paged, sorted by milestone
 *   (list-vip-tiers).
 * - Errors answer {error: {message, request_id}}; 403 means no access to
 *   the endpoint (errors). Each key gets 10 requests a second and then 429
 *   (rate-limits).
 */
const DOCS = "https://dev.smile.io";
export const SMILE_DOC_PAGES = {
  customers: `${DOCS}/api/resources/customers/list-customers.md`,
  points: `${DOCS}/api/resources/points-transactions/list-points-transactions.md`,
  tiers: `${DOCS}/api/resources/vip-tiers/list-vip-tiers.md`,
  auth: `${DOCS}/api/authentication.md`,
} as const;

export type SmileMockRecord = Record<string, unknown>;

/** A Gold member with 120 points, made and last changed `n` minutes into 2026. */
export const smileCustomer = fixtureBuilder<SmileMockRecord>((n) => ({
  id: 700 + n,
  first_name: "Test",
  last_name: `Customer ${n}`,
  email: synthetic.email(n),
  state: "member",
  date_of_birth: "1004-06-15",
  points_balance: 120,
  referral_url: `https://loyalty.example.test/r/${700 + n}`,
  vip_tier_id: 2,
  vip_status: { vip_tier_id: 2, vip_tier_expires_at: null, progress_value: 340.5, current_vip_period_end: null, delta_to_retain_vip_tier: null, next_vip_tier_id: 3, delta_to_next_vip_tier: 159.5 },
  created_at: synthetic.isoTime(n),
  updated_at: synthetic.isoTime(n),
}));

/** 50 points earned by customer 701, `n` minutes into 2026. */
export const smilePointsTransaction = fixtureBuilder<SmileMockRecord>((n) => ({
  id: 9000 + n,
  customer_id: 701,
  points_change: 50,
  description: `Placed an order (${synthetic.name(n)})`,
  internal_note: null,
  created_at: synthetic.isoTime(n),
  updated_at: synthetic.isoTime(n),
}));

/** The program's three tiers. */
export const SMILE_TEST_TIERS: SmileMockRecord[] = [
  { id: 1, name: "Silver", image_url: "https://loyalty.example.test/silver.png", milestone: 0 },
  { id: 2, name: "Gold", image_url: "https://loyalty.example.test/gold.png", milestone: 250 },
  { id: 3, name: "Rose Gold", image_url: "https://loyalty.example.test/rose.png", milestone: 500 },
];

export interface SmileMockData {
  apiKey: string;
  /** The key's scopes. Defaults to the three read scopes. */
  scopes?: string[];
  customers?: SmileMockRecord[];
  pointsTransactions?: SmileMockRecord[];
  tiers?: SmileMockRecord[];
  /** 429s to answer before the next reads, with this Retry-After. */
  rateLimits?: number;
  retryAfter?: string;
}

export interface SmileMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each read: the list and its query. */
  readonly reads: { kind: string; query: Record<string, string> }[];
}

const fail = (status: number, message: string): DocMockResponse => ({ status, body: { error: { message, request_id: "00000000-0000-4000-8000-000000000000" } } });

export function smileDocMock(data: SmileMockData): SmileMock {
  const reads: { kind: string; query: Record<string, string> }[] = [];
  const scopes = data.scopes ?? ["customer:read", "points_transaction:read", "vip_tier:read"];
  let limits = data.rateLimits ?? 0;

  function guard(request: DocMockRequest, scope: string): DocMockResponse | null {
    if (request.headers.get("authorization") !== `Bearer ${data.apiKey}`) return fail(401, "The required authentication credentials are missing or incorrect.");
    if (!scopes.includes(scope) && !scopes.includes(scope.replace(":read", ":write"))) return fail(403, "The server is refusing to respond to the request.");
    if (limits > 0) {
      limits--;
      return { ...fail(429, "Too Many Requests"), headers: data.retryAfter === undefined ? {} : { "Retry-After": data.retryAfter } };
    }
    return null;
  }

  const list = (kind: "customers" | "points_transactions", scope: string, allowed: string[], rowsOf: () => SmileMockRecord[]) => (request: DocMockRequest): DocMockResponse => {
    const stop = guard(request, scope);
    if (stop) return stop;
    const q = request.url.searchParams;
    for (const name of q.keys()) if (!allowed.includes(name)) return fail(400, `Unknown parameter ${name}`);
    const limit = Number(q.get("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 250) return fail(400, "limit must be from 1 to 250");
    const since = q.get("updated_at_min");
    if (since !== null && Number.isNaN(Date.parse(since))) return fail(400, "updated_at_min must be a time");
    if (q.has("include") && q.get("include") !== "vip_status") return fail(400, "Unknown include");
    const decoded = q.get("cursor") === null ? "offset:0" : Buffer.from(q.get("cursor")!, "base64url").toString("utf8");
    if (!/^offset:\d{1,6}$/.test(decoded)) return fail(400, "Invalid cursor");
    const offset = Number(decoded.slice(7));
    reads.push({ kind, query: Object.fromEntries(q) });
    const rows = rowsOf()
      .filter((r) => since === null || Date.parse(String(r.updated_at)) >= Date.parse(since))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .map((r) => (kind === "customers" && !q.has("include") ? (({ vip_status: _, ...rest }) => rest)(r) : r));
    const page = rows.slice(offset, offset + limit);
    const cursor = (at: number) => Buffer.from(`offset:${at}`).toString("base64url");
    return { status: 200, body: { [kind]: page, metadata: { previous_cursor: offset > 0 ? cursor(Math.max(0, offset - limit)) : null, next_cursor: offset + limit < rows.length ? cursor(offset + limit) : null } } };
  };

  const api = checkDocMock({
    integration: "smile_io",
    baseUrl: "https://api.smile.io",
    source: { url: SMILE_DOC_PAGES.customers, title: "Smile.io developer docs: authentication, List customers, List points transactions and List VIP tiers", retrievedOn: "2026-11-11", version: "REST API v1" },
    assumptions: [
      "A merchant key made with only read scopes is turned down with 403 for anything that writes",
      "updated_at_min keeps its filter on every page when it is sent with a cursor",
      "A change to a customer's points or tier moves their updated_at",
      "A page cursor stays good while records change",
      "Times are ISO 8601 with Z or an offset",
    ],
    routes: [
      {
        method: "GET",
        path: "/v1/vip_tiers",
        documentedAt: SMILE_DOC_PAGES.tiers,
        respond: (request) => guard(request, "vip_tier:read") ?? { status: 200, body: { vip_tiers: data.tiers ?? SMILE_TEST_TIERS } },
      },
      { method: "GET", path: "/v1/customers", documentedAt: SMILE_DOC_PAGES.customers, respond: list("customers", "customer:read", ["email", "state", "updated_at_min", "limit", "cursor", "include"], () => data.customers ?? []) },
      { method: "GET", path: "/v1/points_transactions", documentedAt: SMILE_DOC_PAGES.points, respond: list("points_transactions", "points_transaction:read", ["customer_id", "updated_at_min", "limit", "cursor"], () => data.pointsTransactions ?? []) },
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
  integration: "smile_io",
  covers: "Smile.io's List VIP tiers, List customers and List points transactions",
  watchPages: [SMILE_DOC_PAGES.customers, SMILE_DOC_PAGES.tiers, SMILE_DOC_PAGES.points],
  docMocks: () => [smileDocMock({ apiKey: "" }).api],
} satisfies DocMockModule;
