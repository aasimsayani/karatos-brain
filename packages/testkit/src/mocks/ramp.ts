import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Ramp's Developer API, built from docs.ramp.com. Data is synthetic. Ramp
 * offers a sandbox on request; until one is set up, this mock stands in,
 * and a sandbox run confirms it.
 *
 * Docs facts the mock relies on:
 * - POST /developer/v1/token with HTTP Basic client_id:client_secret and a
 *   form body of grant_type=client_credentials and a space-separated
 *   scope. The answer carries access_token, token_type Bearer, expires_in
 *   (864000, ten days) and scope; there is no refresh token. Without a
 *   scope the token has none (authorization).
 * - Production is https://api.ramp.com and the sandbox
 *   https://demo-api.ramp.com (sandbox).
 * - GET /developer/v1/transactions with a bearer token and the
 *   transactions:read scope (getting-started).
 * - Lists take page_size (2 to 100, default 20) and start; each answer has
 *   data and page.next, the full link to the next page or null on the last
 *   (pagination).
 * - 429 past the rate limit, with Retry-After (rate-limiting).
 * - Amount objects carry an integer value in minor units and a currency
 *   (monetary-values); transactions add entity_amount and merchant_amount
 *   and an updated_at matched by the updated_after filter (changelog).
 */
const DOCS = {
  authorization: "https://docs.ramp.com/llms-guides/authorization.txt",
  sandbox: "https://docs.ramp.com/llms-guides/sandbox.txt",
  gettingStarted: "https://docs.ramp.com/llms-guides/getting-started.txt",
  pagination: "https://docs.ramp.com/llms-guides/pagination.txt",
  rateLimiting: "https://docs.ramp.com/llms-guides/rate-limiting.txt",
  monetaryValues: "https://docs.ramp.com/llms-guides/monetary-values.txt",
  changelog: "https://docs.ramp.com/llms-guides/changelog.txt",
} as const;
export const RAMP_DOC_PAGES = DOCS;

export type RampMockTransaction = Record<string, unknown>;

export interface RampMockData {
  clientId: string;
  clientSecret: string;
  /** Transactions, each with user_transaction_time and updated_at; the mock filters and pages on them. */
  transactions: RampMockTransaction[];
  /** The scope the token is granted, when it isn't the one asked for. */
  grantScope?: string;
  /** 429s to answer before the next reads. */
  rateLimits?: number;
  /** Base URL: production unless a test says otherwise. */
  baseUrl?: string;
}

const uuid = (n: number, tag: number) => `${String(tag).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A cleared $240.00 purchase at a shipping supplier, made `n` hours into 2026, with a receipt. */
export const rampTransaction = fixtureBuilder<RampMockTransaction>((n) => {
  const at = new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString().replace(".000Z", "+00:00");
  return {
    id: uuid(n, 1),
    amount: 240,
    currency_code: "USD",
    entity_amount: { value: 24_000, currency: "USD", minor_unit_conversion_rate: 100 },
    merchant_amount: { value: 24_000, currency: "USD", minor_unit_conversion_rate: 100 },
    original_transaction_amount: { amount: 24_000, currency_code: "USD" },
    state: "CLEARED",
    user_transaction_time: at,
    settlement_date: at,
    updated_at: at,
    synced_at: null,
    merchant_id: uuid(n, 2),
    merchant_name: "Test Shipping Supplies",
    merchant_descriptor: "TEST SHIPPING",
    merchant_category_code: "4215",
    sk_category_id: 12,
    sk_category_name: "Shipping",
    card_id: uuid(n, 3),
    card_holder: { user_id: uuid(n % 5, 4), first_name: `Test`, last_name: `Cardholder ${n % 5}`, department_name: "Operations", department_id: uuid(1, 5), location_name: "Main Store", location_id: uuid(1, 6) },
    accounting_field_selections: [{ id: uuid(n, 7), name: "Postage and Delivery", type: "GL_ACCOUNT", external_id: "6100", category_info: { id: uuid(1, 8), name: "Category", type: "GL_ACCOUNT", external_id: "Category" } }],
    receipts: [uuid(n, 9)],
    memo: "Overnight shipping for a repair",
    policy_violations: [],
    disputes: [],
    all_requirements_met_and_approved: true,
    original_transaction_id: null,
  };
});

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const error = (status: number, message: string): DocMockResponse => ({ status, body: { error_v2: { error_code: "DEVELOPER_7001", message } } });

export interface RampMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each transaction list request's query. */
  readonly reads: Record<string, string>[];
  /** Each token request's form, the secret left out. */
  readonly tokens: Record<string, string>[];
}

export function rampDocMock(data: RampMockData): RampMock {
  const base = data.baseUrl ?? "https://api.ramp.com";
  const reads: Record<string, string>[] = [];
  const tokens: Record<string, string>[] = [];
  const issued = new Map<string, string>();
  let limits = data.rateLimits ?? 0;
  const limited = (): DocMockResponse | null => {
    if (limits <= 0) return null;
    limits--;
    return { status: 429, body: { error_v2: { error_code: "DEVELOPER_7008", message: "Too many requests" } }, headers: { "retry-after": "1" } };
  };
  const api = checkDocMock({
    integration: "ramp",
    baseUrl: base,
    source: { url: DOCS.authorization, title: "Ramp Developer API", retrievedOn: "2026-11-11", version: "Developer API v1" },
    assumptions: [
      "from_date and to_date match user_transaction_time, both inclusive, and take ISO 8601 times",
      "updated_after matches updated_at strictly after the time given, and takes an ISO 8601 time",
      "order_by_date_asc=true lists the oldest first; start is the ID of the last transaction already read",
      "A token request asking for one scope is granted that scope, named the same way in the answer",
      "A token Ramp no longer takes is answered 401, and one without the scope 403",
    ],
    routes: [
      {
        method: "POST",
        path: "/developer/v1/token",
        documentedAt: DOCS.authorization,
        respond(request) {
          const expected = `Basic ${Buffer.from(`${data.clientId}:${data.clientSecret}`).toString("base64")}`;
          if (request.headers.get("authorization") !== expected) return { status: 401, body: { error: "invalid_client" } };
          if (!/^application\/x-www-form-urlencoded/.test(request.headers.get("content-type") ?? "")) return { status: 400, body: { error: "invalid_request" } };
          const form = Object.fromEntries(new URLSearchParams(request.body));
          if (form.grant_type !== "client_credentials") return { status: 400, body: { error: "unsupported_grant_type" } };
          const hit = limited();
          if (hit) return hit;
          tokens.push(form);
          const scope = data.grantScope ?? form.scope ?? "";
          const token = `mock_${String(tokens.length).padStart(12, "0")}`;
          issued.set(token, scope);
          return { status: 200, body: { access_token: token, token_type: "Bearer", expires_in: 864_000, scope } };
        },
      },
      {
        method: "GET",
        path: "/developer/v1/transactions",
        documentedAt: DOCS.gettingStarted,
        respond(request) {
          const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
          const scope = token === undefined ? undefined : issued.get(token);
          if (scope === undefined) return error(401, "Invalid token");
          if (!scope.split(" ").includes("transactions:read")) return error(403, "Missing scope transactions:read");
          const hit = limited();
          if (hit) return hit;
          const q = Object.fromEntries(request.url.searchParams);
          reads.push(q);
          const size = q.page_size === undefined ? 20 : Number(q.page_size);
          if (!Number.isInteger(size) || size < 2 || size > 100) return error(400, "page_size must be 2 to 100");
          for (const name of ["from_date", "to_date", "updated_after"]) if (q[name] !== undefined && !TIME.test(q[name]!)) return error(400, `${name} is not a time`);
          const at = (t: RampMockTransaction, field: string) => Date.parse(String(t[field]));
          const rows = data.transactions
            .filter((t) => q.from_date === undefined || at(t, "user_transaction_time") >= Date.parse(q.from_date))
            .filter((t) => q.to_date === undefined || at(t, "user_transaction_time") <= Date.parse(q.to_date))
            .filter((t) => q.updated_after === undefined || at(t, "updated_at") > Date.parse(q.updated_after))
            .sort((a, b) => at(a, "user_transaction_time") - at(b, "user_transaction_time") || String(a.id).localeCompare(String(b.id)));
          const from = q.start === undefined ? 0 : rows.findIndex((t) => t.id === q.start) + 1;
          if (from === 0 && q.start !== undefined) return error(400, "start is not a transaction");
          const page = rows.slice(from, from + size);
          const more = from + size < rows.length;
          const next = new URL(request.url);
          next.searchParams.set("start", String(page.at(-1)?.id));
          return { status: 200, body: { data: page, page: { next: more ? next.toString() : null } } };
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
    get tokens() {
      return tokens;
    },
  };
}

export default {
  integration: "ramp",
  covers: "Ramp's token and card transactions endpoints (Developer API v1)",
  watchPages: [DOCS.authorization, DOCS.gettingStarted],
  docMocks: () => [rampDocMock({ clientId: "", clientSecret: "", transactions: [] }).api],
} satisfies DocMockModule;
