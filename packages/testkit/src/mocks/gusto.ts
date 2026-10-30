import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Gusto's App Integrations API in its demo environment: the OAuth token
 * refresh, token_info, and a company's payroll list and payroll detail,
 * built from the API reference. Data is synthetic.
 */
const API = "https://api.gusto-demo.com";
const DOCS = "https://docs.gusto.com/app-integrations";
export const GUSTO_MOCK_API_VERSION = "2026-06-15";

export const GUSTO_TEST_COMPANY = "00000000-0000-4000-8000-00000000c0c0";
export const GUSTO_MOCK_READ_SCOPES = ["payrolls:read"] as const;

/** A UUID for fixture record n of a kind, e.g. gustoUuid("e", 3). The kind's letters become hex. */
export const gustoUuid = (kind: string, n: number) => `00000000-0000-4000-8000-${Buffer.from(kind).toString("hex").padStart(4, "0").slice(-4)}${String(n).padStart(8, "0")}`;

export interface GustoEmployeeCompensation {
  employee_uuid: string;
  first_name?: string;
  last_name?: string;
  excluded: boolean;
  gross_pay: string;
  net_pay: string;
  check_amount: string;
  payment_method: "Direct Deposit" | "Check";
  fixed_compensations: { name: string; amount: string; job_uuid: string }[];
  hourly_compensations: { name: string; hours: string; amount: string; compensation_multiplier: number; job_uuid: string }[];
  paid_time_off: { name: string; hours: string }[];
}

export interface GustoPayroll {
  uuid: string;
  payroll_uuid: string;
  company_uuid: string;
  processed: boolean;
  processed_date: string | null;
  check_date: string;
  off_cycle: boolean;
  off_cycle_reason: string | null;
  external: boolean;
  payroll_deadline: string;
  pay_period: { start_date: string; end_date: string; pay_schedule_uuid: string | null };
  totals: Record<string, string>;
  employee_compensations: GustoEmployeeCompensation[];
}

const PAY_SCHEDULE = gustoUuid("5c", 1);
const day = (n: number, start: string) => synthetic.isoTime(n * 1440, `${start}T00:00:00Z`).slice(0, 10);
const money = (cents: number) => (cents / 100).toFixed(2);

export const gustoCompensation = fixtureBuilder<GustoEmployeeCompensation>((n) => ({
  employee_uuid: gustoUuid("e", n),
  first_name: "Test",
  last_name: `Employee${n}`,
  excluded: false,
  gross_pay: money(150_000 + n * 10_000),
  net_pay: money(115_000 + n * 7_500),
  check_amount: money(115_000 + n * 7_500),
  payment_method: n % 2 ? "Direct Deposit" : "Check",
  fixed_compensations: [
    { name: "Commission", amount: money(n * 5_000), job_uuid: gustoUuid("j", n) },
    { name: "Bonus", amount: "0.00", job_uuid: gustoUuid("j", n) },
  ],
  hourly_compensations: [
    { name: "Regular Hours", hours: "80.000", amount: money(140_000 + n * 5_000), compensation_multiplier: 1, job_uuid: gustoUuid("j", n) },
    { name: "Overtime", hours: n % 2 ? "2.500" : "0.000", amount: n % 2 ? money(5_000) : "0.00", compensation_multiplier: 1.5, job_uuid: gustoUuid("j", n) },
  ],
  paid_time_off: [{ name: "Vacation Hours", hours: "0.000" }],
}));

/** A processed regular payroll every two weeks from the start of 2026. */
export const gustoPayroll = fixtureBuilder<GustoPayroll>((n) => {
  const start = day((n - 1) * 14, "2026-01-01");
  return {
    uuid: gustoUuid("p", n),
    payroll_uuid: gustoUuid("p", n),
    company_uuid: GUSTO_TEST_COMPANY,
    processed: true,
    processed_date: day((n - 1) * 14 + 15, "2026-01-01"),
    check_date: day((n - 1) * 14 + 18, "2026-01-01"),
    off_cycle: false,
    off_cycle_reason: null,
    external: false,
    payroll_deadline: `${day((n - 1) * 14 + 15, "2026-01-01")}T23:00:00Z`,
    pay_period: { start_date: start, end_date: day((n - 1) * 14 + 13, "2026-01-01"), pay_schedule_uuid: PAY_SCHEDULE },
    totals: {
      company_debit: "4950.00",
      net_pay_debit: "3550.00",
      tax_debit: "1400.00",
      reimbursement_debit: "0.00",
      gross_pay: "4500.00",
      net_pay: "3550.00",
      employer_taxes: "450.00",
      employee_taxes: "700.00",
      benefits: "0.00",
      reimbursements: "0.00",
      employee_bonuses: "0.00",
      employee_commissions: "300.00",
      check_amount: "3550.00",
    },
    employee_compensations: [gustoCompensation.one(), gustoCompensation.one()],
  };
});

export interface GustoMockData {
  payrolls: GustoPayroll[];
  /** The refresh token the company was connected with. */
  refreshToken: string;
  /** The scopes token_info reports. Defaults to read-only. */
  scopes?: readonly string[];
  /** The company token_info reports. Defaults to the test company. */
  tokenCompany?: string;
  /** How many of the next API requests answer 429, each with Retry-After when `retryAfter` is set. */
  rateLimited?: number;
  retryAfter?: number;
}

export interface GustoMock {
  oauth: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  /** The refresh token Gusto would accept now. */
  readonly refreshToken: string;
  readonly refreshes: number;
  /** Revokes every access token, as when one is cut off before it expires. */
  revokeAccessTokens(): void;
}

const error = (status: number, message: string): DocMockResponse => ({ status, body: { errors: [{ error_key: "base", category: "invalid_request", message }] } });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The list shows a payroll without its employee compensations, and with totals only when asked. */
const listed = (p: GustoPayroll, totals: boolean) => {
  const { employee_compensations: _, totals: t, ...rest } = p;
  return totals ? { ...rest, totals: t } : rest;
};

export function gustoDocMock(data: GustoMockData): GustoMock {
  let refreshToken = data.refreshToken;
  /** Replaced refresh tokens stay good until the new access token is first used, as Gusto documents. */
  let previous: string | null = null;
  let issued = 0;
  let refreshes = 0;
  const access = new Map<string, boolean>();
  const used = (token: string) => {
    if (access.get(token) === false) {
      access.set(token, true);
      previous = null;
    }
  };
  const authorized = (headers: Headers) => {
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!access.has(token)) return null;
    used(token);
    return token;
  };
  const versioned = (headers: Headers) => (headers.get("x-gusto-api-version") === GUSTO_MOCK_API_VERSION ? null : error(406, "Unsupported API version"));

  const oauth = checkDocMock({
    integration: "gusto",
    baseUrl: API,
    source: { url: `${DOCS}/docs/oauth2`, title: "Gusto OAuth 2.0", retrievedOn: "2026-10-30", version: "OAuth 2.0" },
    assumptions: ["The refresh takes a JSON body, as the guide shows, and answers 400 invalid_grant for a refresh token already replaced"],
    routes: [
      {
        method: "POST",
        path: "/oauth/token",
        documentedAt: `${DOCS}/reference/refresh-access-token`,
        respond(request) {
          refreshes++;
          let form: Record<string, unknown> = {};
          try {
            form = JSON.parse(request.body) as Record<string, unknown>;
          } catch {
            return { status: 400, body: { error: "invalid_request" } };
          }
          if (form.grant_type !== "refresh_token" || !form.client_id || !form.client_secret || !form.redirect_uri) return { status: 400, body: { error: "invalid_request" } };
          if (form.refresh_token !== refreshToken && (previous === null || form.refresh_token !== previous)) return { status: 400, body: { error: "invalid_grant" } };
          issued++;
          previous = refreshToken;
          refreshToken = `RT-TEST-${issued}`;
          const token = `AT-TEST-${issued}`;
          access.set(token, false);
          return { status: 200, body: { access_token: token, token_type: "bearer", expires_in: 7200, refresh_token: refreshToken } };
        },
      },
    ],
  });

  const api = checkDocMock({
    integration: "gusto",
    baseUrl: API,
    source: { url: `${DOCS}/reference/get-v1-companies-company_id-payrolls`, title: "Gusto API reference: payrolls", retrievedOn: "2026-10-30", version: GUSTO_MOCK_API_VERSION },
    auth: "bearer",
    assumptions: [
      "token_info answers scope as a space-separated string and resource as { type: Company, uuid }",
      "Scopes that only read end in :read",
      "A missing or unknown X-Gusto-API-Version is answered 406; Gusto may instead fall back to the app's default version",
      "start_date and end_date are inclusive check dates when date_filter_by=check_date, and at most a year apart",
      "sort_order=asc sorts by check date, and a page shorter than per is the last",
      "A 429 may carry Retry-After in seconds",
    ],
    routes: [
      {
        method: "GET",
        path: "/v1/token_info",
        documentedAt: `${DOCS}/reference/get-v1-token-info`,
        respond(request) {
          if (!authorized(request.headers)) return { status: 401, body: { message: "Unauthorized" } };
          return {
            status: 200,
            body: { scope: (data.scopes ?? GUSTO_MOCK_READ_SCOPES).join(" "), resource: { type: "Company", uuid: data.tokenCompany ?? GUSTO_TEST_COMPANY }, resource_owner: { type: "CompanyAdmin", uuid: gustoUuid("ad", 1) } },
          };
        },
      },
      {
        method: "GET",
        path: "/v1/companies/{company_id}/payrolls",
        documentedAt: `${DOCS}/reference/get-v1-companies-company_id-payrolls`,
        respond(request, params) {
          if (!authorized(request.headers)) return { status: 401, body: { message: "Unauthorized" } };
          const version = versioned(request.headers);
          if (version) return version;
          if (data.rateLimited) {
            data.rateLimited--;
            return { status: 429, body: { message: "Too many requests" }, headers: data.retryAfter ? { "retry-after": String(data.retryAfter) } : {} };
          }
          if (params.company_id !== GUSTO_TEST_COMPANY) return error(404, "Company not found");
          const q = request.url.searchParams;
          const start = q.get("start_date") ?? "";
          const end = q.get("end_date") ?? "";
          if (!DAY.test(start) || !DAY.test(end)) return error(422, "start_date and end_date must be dates");
          if (Date.parse(end) - Date.parse(start) > 365 * 86_400_000) return error(422, "start_date and end_date must be no more than one year apart");
          const per = Number(q.get("per") ?? 25);
          const page = Number(q.get("page") ?? 1);
          if (!Number.isInteger(per) || per < 1 || per > 100 || !Number.isInteger(page) || page < 1) return error(422, "page and per must be whole numbers, per at most 100");
          const statuses = (q.get("processing_statuses") ?? "processed").split(",");
          const rows = data.payrolls
            .filter((p) => statuses.includes(p.processed ? "processed" : "unprocessed"))
            .filter((p) => p.check_date >= start && p.check_date <= end)
            .sort((a, b) => (q.get("sort_order") === "desc" ? b.check_date.localeCompare(a.check_date) : a.check_date.localeCompare(b.check_date)));
          const totals = (q.get("include") ?? "").split(",").includes("totals");
          return { status: 200, body: rows.slice((page - 1) * per, page * per).map((p) => listed(p, totals)) };
        },
      },
      {
        method: "GET",
        path: "/v1/companies/{company_id}/payrolls/{payroll_id}",
        documentedAt: `${DOCS}/reference/get-v1-companies-company_id-payrolls-payroll_id`,
        respond(request, params) {
          if (!authorized(request.headers)) return { status: 401, body: { message: "Unauthorized" } };
          const version = versioned(request.headers);
          if (version) return version;
          if (params.company_id !== GUSTO_TEST_COMPANY) return error(404, "Company not found");
          const payroll = data.payrolls.find((p) => p.uuid === params.payroll_id);
          return payroll ? { status: 200, body: payroll } : error(404, "Payroll not found");
        },
      },
    ],
  });

  const oauthFetch = docMockFetch(oauth);
  const apiFetch = docMockFetch(api);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // Both live on one host; the token endpoint is the only path under /oauth.
      const toOauth = url.origin === API && url.pathname.startsWith("/oauth/");
      const response = await (toOauth ? oauthFetch : apiFetch)(input, init);
      calls.push(...(toOauth ? oauthFetch.calls : apiFetch.calls).slice(-1));
      return response;
    },
    { calls },
  );
  return {
    oauth,
    api,
    fetch,
    get refreshToken() {
      return refreshToken;
    },
    get refreshes() {
      return refreshes;
    },
    revokeAccessTokens: () => access.clear(),
  };
}

export default {
  integration: "gusto",
  covers: "Gusto's payroll list and payroll endpoints with its token refresh and token_info",
  watchPages: [
    "https://docs.gusto.com/app-integrations/docs/oauth2",
    "https://docs.gusto.com/app-integrations/reference/refresh-access-token",
    "https://docs.gusto.com/app-integrations/reference/get-v1-companies-company_id-payrolls",
    "https://docs.gusto.com/app-integrations/reference/get-v1-token-info",
    "https://docs.gusto.com/app-integrations/reference/get-v1-companies-company_id-payrolls-payroll_id",
  ],
  docMocks: () => {
    const mock = gustoDocMock({ payrolls: [], refreshToken: "" });
    return [mock.oauth, mock.api];
  },
} satisfies DocMockModule;
