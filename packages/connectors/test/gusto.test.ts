import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  GUSTO_TEST_COMPANY,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  gustoCompensation,
  gustoDocMock,
  gustoPayroll,
  gustoUuid,
  hmacSha256,
  tamper,
  testPipeline,
  type GustoMock,
  type GustoMockData,
} from "@karatos/connector-testkit";
import {
  EMPLOYEE_PAY_EVENT_TYPE,
  GUSTO_API_URLS,
  GUSTO_API_VERSION,
  GUSTO_WRITES,
  GustoApiError,
  GustoConfigError,
  PAYROLL_EVENT_TYPE,
  gustoCents,
  gustoClient,
  gustoConnector,
  gustoDay,
  gustoPayrollEvents,
  gustoWebhookEvent,
  gustoWriteScopes,
  memoryTokenStore,
  parseGustoCursor,
  verifyGustoWebhook,
  type GustoConnectorOptions,
  type GustoCursor,
  type GustoTokenStore,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = ["test", "x".repeat(40)].join("-");
const CLIENT_SECRET = ["test", "secret", "x".repeat(36)].join("-");
const FIRST_REFRESH = ["RT", "TEST", "0"].join("-");
const REDIRECT = "https://brain.example.test/oauth/gusto";
const NOW = () => new Date("2026-10-20T00:00:00Z");
const RECEIVED = "2026-10-20T00:00:00.000Z";
const BASE = GUSTO_API_URLS.demo;

function company(overrides: Partial<GustoMockData> = {}): GustoMockData {
  gustoPayroll.reset();
  gustoCompensation.reset();
  const [first, second, third] = gustoPayroll.many(3);
  const bonus = gustoPayroll.one({ off_cycle: true, off_cycle_reason: "Bonus", check_date: "2026-03-31", processed_date: "2026-03-27" });
  // An employee left out of the bonus run.
  bonus.employee_compensations[1]!.excluded = true;
  return {
    payrolls: [
      first!,
      second!,
      third!,
      bonus,
      // Not processed yet: Gusto lists it only when asked for unprocessed payrolls.
      gustoPayroll.one({ processed: false, processed_date: null, check_date: "2026-10-30" }),
      // Inside three years, in the first window.
      gustoPayroll.one({ check_date: "2024-03-15", processed_date: "2024-03-13", pay_period: { start_date: "2024-02-26", end_date: "2024-03-10", pay_schedule_uuid: gustoUuid("5c", 1) } }),
      // Over three years old.
      gustoPayroll.one({ check_date: "2023-01-06" }),
      // A check date that isn't a real day: listed by Gusto's string order, dead-lettered here.
      gustoPayroll.one({ check_date: "2026-02-30" }),
    ],
    refreshToken: FIRST_REFRESH,
    ...overrides,
  };
}

const options = (mock: GustoMock, extra: Partial<GustoConnectorOptions> = {}): GustoConnectorOptions => ({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: REDIRECT,
  companyUuid: GUSTO_TEST_COMPANY,
  environment: "demo",
  tokens: memoryTokenStore(FIRST_REFRESH),
  fetch: mock.fetch,
  sleep: async () => {},
  now: NOW,
  ...extra,
});

const connector = (mock: GustoMock, extra: Partial<GustoConnectorOptions> = {}) => gustoConnector(options(mock, extra));
const reads = (mock: GustoMock) => mock.fetch.calls.filter((c) => c.method === "GET").map((c) => decodeURIComponent(c.url.replace(BASE, "")));
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const LIST = `/v1/companies/${GUSTO_TEST_COMPANY}/payrolls`;

/** A fetch that answers the refresh and token_info like Gusto, then hands every payroll read to `answer`. */
function scripted(answer: (url: string) => Response, info: unknown = { scope: "payrolls:read", resource: { type: "Company", uuid: GUSTO_TEST_COMPANY } }) {
  const sent: { url: string; method: string; headers: Headers; body: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    sent.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    if (url.endsWith("/oauth/token")) return json(200, { access_token: `AT-${sent.length}`, expires_in: 7200, refresh_token: `RT-${sent.length}` });
    if (url.endsWith("/v1/token_info")) return json(200, info);
    return answer(url);
  };
  return { fetch, sent };
}

const client = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) =>
  gustoClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, companyUuid: GUSTO_TEST_COMPANY, environment: "demo", tokens: memoryTokenStore(FIRST_REFRESH), fetch, sleep: async () => {}, ...extra });

describe("Gusto client", () => {
  it("checks its settings, naming them but never their values", () => {
    const base = options(gustoDocMock(company()));
    expect(() => gustoClient({ ...base, clientSecret: " " })).toThrow(new GustoConfigError("set GUSTO_CLIENT_ID and GUSTO_CLIENT_SECRET"));
    expect(() => gustoClient({ ...base, clientId: "" })).toThrow("set GUSTO_CLIENT_ID and GUSTO_CLIENT_SECRET");
    expect(() => gustoClient({ ...base, redirectUri: "brain.example.test" })).toThrow("GUSTO_REDIRECT_URI must be the app's registered redirect URI");
    expect(() => gustoClient({ ...base, companyUuid: "Test Jewelers" })).toThrow("GUSTO_COMPANY_UUID must be the company's UUID in Gusto");
    expect(() => gustoClient({ ...base, environment: "staging" as never })).toThrow("GUSTO_ENVIRONMENT must be production or demo");
    expect(() => gustoClient({ ...base, environment: "toString" as never })).toThrow("GUSTO_ENVIRONMENT must be production or demo");
    expect(() => gustoClient({ ...base, companyUuid: ` ${GUSTO_TEST_COMPANY.toUpperCase()} ` })).not.toThrow();
    for (const message of [CLIENT_SECRET, CLIENT_ID]) {
      expect(() => gustoClient({ ...base, redirectUri: "x" })).not.toThrow(message);
    }
  });

  it("reads production unless told the demo environment", async () => {
    const { fetch, sent } = scripted(() => json(200, []));
    await gustoClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, companyUuid: GUSTO_TEST_COMPANY, tokens: memoryTokenStore(FIRST_REFRESH), fetch }).listPayrolls({ startDate: "2026-01-01", endDate: "2026-02-01", page: 1 });
    expect(sent.map((s) => new URL(s.url).origin)).toEqual(["https://api.gusto.com", "https://api.gusto.com", "https://api.gusto.com"]);
  });

  it("refreshes with a JSON body that carries the redirect URI, then gets with a bearer token and the API version", async () => {
    const { fetch, sent } = scripted(() => json(200, []));
    await client(fetch).listPayrolls({ startDate: "2026-01-01", endDate: "2026-02-01", page: 2 });
    expect(sent[0]).toMatchObject({ url: `${BASE}/oauth/token`, method: "POST" });
    expect(sent[0]!.headers.get("content-type")).toBe("application/json");
    expect(sent[0]!.headers.get("authorization")).toBeNull();
    expect(JSON.parse(sent[0]!.body)).toEqual({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, refresh_token: FIRST_REFRESH, grant_type: "refresh_token" });
    for (const s of sent.slice(1)) {
      expect([s.method, s.headers.get("authorization"), s.headers.get("x-gusto-api-version")]).toEqual(["GET", "Bearer AT-1", GUSTO_API_VERSION]);
    }
    expect(Object.fromEntries(new URL(sent[2]!.url).searchParams)).toEqual({
      processing_statuses: "processed",
      date_filter_by: "check_date",
      start_date: "2026-01-01",
      end_date: "2026-02-01",
      include: "totals",
      sort_order: "asc",
      page: "2",
      per: "100",
    });
  });

  it("stores each new refresh token before the new access token is first used, since that use revokes the old one", async () => {
    const mock = gustoDocMock(company());
    const order: string[] = [];
    const tokens: GustoTokenStore = {
      load: async () => mock.refreshToken,
      save: async (token) => {
        order.push(`save ${token} after ${mock.fetch.calls.length} requests`);
      },
    };
    await client(mock.fetch, { tokens }).getPayroll(gustoUuid("p", 1));
    expect(order).toEqual(["save RT-TEST-1 after 1 requests"]);
    expect(reads(mock)).toEqual(["/v1/token_info", `${LIST}/${gustoUuid("p", 1)}`]);
  });

  it("refreshes once for reads that need a token at the same time, and again only near expiry", async () => {
    const mock = gustoDocMock(company());
    let clock = 0;
    const c = client(mock.fetch, { tokens: memoryTokenStore(FIRST_REFRESH), clock: () => clock });
    await Promise.all([c.getPayroll(gustoUuid("p", 1)), c.getPayroll(gustoUuid("p", 2))]);
    expect(mock.refreshes).toBe(1);
    clock = 7200_000 - 5 * 60_000 - 1;
    await c.getPayroll(gustoUuid("p", 1));
    expect(mock.refreshes).toBe(1);
    clock += 1;
    await c.getPayroll(gustoUuid("p", 1));
    expect(mock.refreshes).toBe(2);
  });

  it("asks for a refresh token when there is none, and explains invalid_grant", async () => {
    const mock = gustoDocMock(company());
    expect(await failure(client(mock.fetch, { tokens: memoryTokenStore(" ") }).getPayroll(gustoUuid("p", 1)))).toEqual(new GustoConfigError("set GUSTO_REFRESH_TOKEN"));
    const spent = await failure(client(mock.fetch, { tokens: memoryTokenStore("RT-TEST-old") }).getPayroll(gustoUuid("p", 1)));
    expect(spent).toBeInstanceOf(GustoApiError);
    expect(spent.message).toBe("Gusto turned down the token refresh (HTTP 400, invalid_grant); reconnect Gusto to get a new refresh token");
    const odd = await failure(client(async () => json(500, "oops")).getPayroll(gustoUuid("p", 1)));
    expect(odd.message).toBe("Gusto turned down the token refresh (HTTP 500)");
    const empty = await failure(client(async () => json(200, { access_token: "" })).getPayroll(gustoUuid("p", 1)));
    expect(empty.message).toBe("Gusto turned down the token refresh (HTTP 200)");
  });

  it("fails without using a token it couldn't store", async () => {
    const mock = gustoDocMock(company());
    const tokens: GustoTokenStore = { load: async () => FIRST_REFRESH, save: async () => Promise.reject(new Error("database is down")) };
    expect((await failure(client(mock.fetch, { tokens }).getPayroll(gustoUuid("p", 1)))).message).toBe("database is down");
    expect(reads(mock)).toEqual([]);
  });

  it("stops on a token that can change data, after keeping the token Gusto replaced", async () => {
    const mock = gustoDocMock(company({ scopes: ["payrolls:read", "payrolls:write", "companies:read", "payrolls:run"] }));
    const tokens = memoryTokenStore(FIRST_REFRESH);
    const error = await failure(client(mock.fetch, { tokens }).listPayrolls({ startDate: "2026-01-01", endDate: "2026-02-01", page: 1 }));
    expect(error).toEqual(new GustoConfigError("the Gusto connection can change data (payrolls:write, payrolls:run); give the app only payrolls:read and reconnect"));
    expect(tokens.current).toBe("RT-TEST-1");
    expect(reads(mock)).toEqual(["/v1/token_info"]);
  });

  it("stops on a token for another company, one missing payrolls:read, or one whose scopes it can't read", async () => {
    const listing = (data: Partial<GustoMockData>) => failure(client(gustoDocMock(company(data)).fetch).listPayrolls({ startDate: "2026-01-01", endDate: "2026-02-01", page: 1 }));
    expect((await listing({ tokenCompany: gustoUuid("c", 9) })).message).toBe("the Gusto connection is for a different company than GUSTO_COMPANY_UUID; reconnect the right company");
    expect((await listing({ scopes: ["companies:read"] })).message).toBe("the Gusto connection is missing payrolls:read");
    const info = (body: unknown) => failure(client(scripted(() => json(200, []), body).fetch).listPayrolls({ startDate: "2026-01-01", endDate: "2026-02-01", page: 1 }));
    expect((await info({ resource: { type: "Company", uuid: GUSTO_TEST_COMPANY } })).message).toBe("Gusto didn't say which scopes the connection holds, so the connector won't use it");
    expect((await info({ scope: "payrolls:read", resource: { type: "Employee", uuid: GUSTO_TEST_COMPANY } })).message).toContain("different company");
    expect((await info({ scope: "payrolls:read", resource: { type: "Company" } })).message).toContain("different company");
    expect((await info({ scope: "payrolls:read" })).message).toContain("different company");
    // The company's UUID is matched whatever its case.
    await expect(info({ scope: "payrolls:read", resource: { type: "Company", uuid: GUSTO_TEST_COMPANY.toUpperCase() } })).resolves.toEqual(new Error("did not fail"));
    const down = await failure(client(async (url) => (String(url).endsWith("/oauth/token") ? json(200, { access_token: "AT-1" }) : json(503, {}))).getPayroll(gustoUuid("p", 1)));
    expect(down).toEqual(new GustoApiError("Gusto answered HTTP 503 when asked what the token may do", 503));
    const notJson = await failure(client(async (url) => (String(url).endsWith("/oauth/token") ? json(200, { access_token: "AT-1" }) : new Response("<html>", { status: 200 }))).getPayroll(gustoUuid("p", 1)));
    expect(notJson.message).toBe("Gusto answered HTTP 200 when asked what the token may do");
  });

  it("tells read scopes from those that change or run anything", () => {
    expect(gustoWriteScopes(["payrolls:read", "employees:read", "payrolls:write", "payrolls:run", "public", "payrolls:read:all", "PAYROLLS:READ"])).toEqual(["payrolls:write", "payrolls:run", "public", "payrolls:read:all", "PAYROLLS:READ"]);
    expect(gustoWriteScopes([])).toEqual([]);
  });

  it("refreshes once when an access token is revoked early, then gives up", async () => {
    const mock = gustoDocMock(company());
    const c = client(mock.fetch, { tokens: memoryTokenStore(FIRST_REFRESH) });
    await c.getPayroll(gustoUuid("p", 1));
    mock.revokeAccessTokens();
    await c.getPayroll(gustoUuid("p", 1));
    expect(mock.refreshes).toBe(2);
    const { fetch } = scripted(() => json(401, { message: "Unauthorized" }));
    expect(await failure(client(fetch).getPayroll(gustoUuid("p", 1)))).toEqual(new GustoApiError("Gusto answered HTTP 401: Unauthorized", 401));
  });

  it("waits out rate limits, honouring Retry-After up to a minute, then gives up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    await client(gustoDocMock(company({ rateLimited: 2, retryAfter: 7 })).fetch, { sleep }).listPayrolls({ startDate: "2026-01-01", endDate: "2026-02-01", page: 1 });
    await client(gustoDocMock(company({ rateLimited: 1, retryAfter: 600 })).fetch, { sleep }).listPayrolls({ startDate: "2026-01-01", endDate: "2026-02-01", page: 1 });
    await client(gustoDocMock(company({ rateLimited: 3 })).fetch, { sleep }).listPayrolls({ startDate: "2026-01-01", endDate: "2026-02-01", page: 1 });
    expect(waits).toEqual([7000, 7000, 60_000, 1000, 2000, 4000]);
    const stuck = await failure(client(gustoDocMock(company({ rateLimited: 5 })).fetch, { sleep, rateLimitRetries: 1 }).listPayrolls({ startDate: "2026-01-01", endDate: "2026-02-01", page: 1 }));
    expect(stuck).toEqual(new GustoApiError("Gusto kept rate-limiting the sync", 429));
  });

  it("reports Gusto's errors cut short, with a hint for lost access, and never a token or secret", async () => {
    const long = "x".repeat(500);
    const error = await failure(client(scripted(() => json(422, { errors: [{ message: long }] })).fetch).getPayroll(gustoUuid("p", 1)));
    expect(error.message).toBe(`Gusto answered HTTP 422: ${"x".repeat(200)}`);
    const forbidden = await failure(client(scripted(() => json(403, { message: "Forbidden" })).fetch).getPayroll(gustoUuid("p", 1)));
    expect(forbidden.message).toBe("Gusto answered HTTP 403: Forbidden; check the app still has payrolls:read for this company");
    const bare = await failure(client(scripted(() => json(500, null)).fetch).getPayroll(gustoUuid("p", 1)));
    expect(bare.message).toBe("Gusto answered HTTP 500");
    const described = await failure(client(scripted(() => json(400, { error_description: "bad" })).fetch).getPayroll(gustoUuid("p", 1)));
    expect(described.message).toBe("Gusto answered HTTP 400: bad");
    for (const e of [error, forbidden, bare, described]) {
      for (const secret of [CLIENT_SECRET, FIRST_REFRESH, "AT-1", "RT-1"]) expect(e.message).not.toContain(secret);
    }
  });

  it("checks the dates, page and payroll id it sends, and the shape of what comes back", async () => {
    const c = client(scripted(() => json(200, [])).fetch);
    const list = (startDate: string, endDate: string, page = 1) => failure(c.listPayrolls({ startDate, endDate, page }));
    expect((await list("2026-02-30", "2026-03-01")).message).toBe("payroll dates must be YYYY-MM-DD");
    expect((await list("2026-01-01", "2026/02/01")).message).toBe("payroll dates must be YYYY-MM-DD");
    expect((await list("2026-01-01&page=9", "2026-02-01")).message).toBe("payroll dates must be YYYY-MM-DD");
    expect((await list("2026-02-01", "2026-01-31")).message).toBe("Gusto lists at most a year of payrolls at a time");
    expect((await list("2025-01-01", "2026-01-02")).message).toBe("Gusto lists at most a year of payrolls at a time");
    await expect(c.listPayrolls({ startDate: "2025-01-01", endDate: "2026-01-01", page: 1 })).resolves.toEqual([]);
    for (const page of [0, 1.5, -1]) expect((await list("2026-01-01", "2026-02-01", page)).message).toBe("page must be a whole number from 1");
    for (const id of ["../../oauth/token", "p1", `${gustoUuid("p", 1)}?x=1`]) expect((await failure(c.getPayroll(id))).message).toBe("a payroll id must be a UUID");
    expect((await failure(client(scripted(() => json(200, { payrolls: [] })).fetch).listPayrolls({ startDate: "2026-01-01", endDate: "2026-02-01", page: 1 }))).message).toBe("Gusto's payroll list was not a list");
    expect((await failure(client(scripted(() => json(200, [])).fetch).getPayroll(gustoUuid("p", 1)))).message).toBe("Gusto's payroll was a list");
    expect((await failure(client(scripted(() => new Response("<html>", { status: 200 })).fetch).getPayroll(gustoUuid("p", 1)))).message).toBe("Gusto did not answer with JSON");
  });

  it("lower-cases the payroll id it asks for", async () => {
    const { fetch, sent } = scripted(() => json(200, {}));
    await client(fetch).getPayroll(gustoUuid("p", 1).toUpperCase());
    expect(sent.at(-1)!.url).toBe(`${BASE}${LIST}/${gustoUuid("p", 1)}`);
  });
});

describe("Gusto normalization", () => {
  const detailed = () => {
    gustoPayroll.reset();
    gustoCompensation.reset();
    return gustoPayroll.one();
  };

  it("keeps the payroll's totals and each employee's pay in cents, and nothing personal", () => {
    const payroll = detailed();
    const [run, ...employees] = gustoPayrollEvents(payroll, RECEIVED);
    expect(run).toEqual({
      id: expect.stringMatching(new RegExp(`^gusto_payroll:${gustoUuid("p", 1)}_[0-9a-f]{12}$`)),
      type: PAYROLL_EVENT_TYPE,
      occurredAt: "2026-01-19T00:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(new RegExp(`^gusto:payroll:${gustoUuid("p", 1)}:[0-9a-f]{12}$`)),
      payload: {
        payrollId: `gusto:payroll:${gustoUuid("p", 1)}`,
        checkDate: "2026-01-19",
        processedDate: "2026-01-16",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-14",
        payScheduleId: `gusto:pay_schedule:${gustoUuid("5c", 1)}`,
        kind: "regular",
        grossPayCents: 450_000,
        netPayCents: 355_000,
        employerTaxesCents: 45_000,
        employeeTaxesCents: 70_000,
        benefitsCents: 0,
        reimbursementsCents: 0,
        bonusesCents: 0,
        commissionsCents: 30_000,
        companyDebitCents: 495_000,
        employeeCount: 2,
      },
    });
    expect(employees.map((e) => [e.type, e.occurredAt, e.payload])).toEqual([
      [
        EMPLOYEE_PAY_EVENT_TYPE,
        "2026-01-19T00:00:00.000Z",
        { payrollId: `gusto:payroll:${gustoUuid("p", 1)}`, employeeId: `gusto:employee:${gustoUuid("e", 1)}`, checkDate: "2026-01-19", kind: "regular", grossPayCents: 160_000, netPayCents: 122_500, hours: 82.5, overtimeCents: 5_000, commissionCents: 5_000, bonusCents: 0, tipsCents: 0, paymentMethod: "Direct Deposit" },
      ],
      [
        EMPLOYEE_PAY_EVENT_TYPE,
        "2026-01-19T00:00:00.000Z",
        { payrollId: `gusto:payroll:${gustoUuid("p", 1)}`, employeeId: `gusto:employee:${gustoUuid("e", 2)}`, checkDate: "2026-01-19", kind: "regular", grossPayCents: 170_000, netPayCents: 130_000, hours: 80, overtimeCents: 0, commissionCents: 10_000, bonusCents: 0, tipsCents: 0, paymentMethod: "Check" },
      ],
    ]);
    const kept = JSON.stringify(gustoPayrollEvents(payroll, RECEIVED));
    for (const personal of ["Employee1", "Test", "job", gustoUuid("j", 1), "check_amount", "Vacation"]) expect(kept).not.toContain(personal);
  });

  it("tells off-cycle and external runs from regular ones, and leaves out excluded employees", () => {
    const payroll = detailed();
    payroll.employee_compensations[0]!.excluded = true;
    const [offCycle, ...paid] = gustoPayrollEvents({ ...payroll, off_cycle: true, off_cycle_reason: "Bonus" }, RECEIVED);
    expect(offCycle!.payload).toMatchObject({ kind: "off_cycle", offCycleReason: "Bonus", employeeCount: 1 });
    expect(paid.map((e) => [e.payload.employeeId, e.payload.kind])).toEqual([[`gusto:employee:${gustoUuid("e", 2)}`, "off_cycle"]]);
    expect(gustoPayrollEvents({ ...payroll, external: true, off_cycle: true, off_cycle_reason: "Bonus" }, RECEIVED)[0]!.payload).toMatchObject({ kind: "external" });
    expect(gustoPayrollEvents({ ...payroll, external: true }, RECEIVED)[0]!.payload).not.toHaveProperty("offCycleReason");
    expect(gustoPayrollEvents({ ...payroll, off_cycle_reason: "Bonus" }, RECEIVED)[0]!.payload).not.toHaveProperty("offCycleReason");
  });

  it("adds up bonus, tip and overtime lines by name, and keeps the payment method short", () => {
    const payroll = detailed();
    const c = payroll.employee_compensations[0]!;
    c.fixed_compensations = [
      { name: "Bonus", amount: "100.00", job_uuid: gustoUuid("j", 1) },
      { name: "Paycheck Tips", amount: "25.50", job_uuid: gustoUuid("j", 1) },
      { name: "Cash Tips", amount: "4.50", job_uuid: gustoUuid("j", 1) },
      { name: "Commission", amount: "not a number", job_uuid: gustoUuid("j", 1) },
    ];
    c.hourly_compensations = [
      { name: "Overtime", hours: "1.5", amount: "45.00", compensation_multiplier: 1.5, job_uuid: gustoUuid("j", 1) },
      { name: "Double overtime", hours: "0.25", amount: "10.00", compensation_multiplier: 2, job_uuid: gustoUuid("j", 1) },
      { name: "Regular Hours", hours: "x", amount: "1.00", compensation_multiplier: 1, job_uuid: gustoUuid("j", 1) },
    ];
    c.payment_method = "Direct Deposit".repeat(5) as never;
    expect(gustoPayrollEvents(payroll, RECEIVED)[1]!.payload).toMatchObject({ bonusCents: 10_000, tipsCents: 3_000, commissionCents: 0, overtimeCents: 5_500, hours: 1.75, paymentMethod: "Direct Deposit".repeat(5).slice(0, 30) });
  });

  it("stores a new version when what was kept changes, and the same key when only dropped fields change", () => {
    const payroll = detailed();
    const [first] = gustoPayrollEvents(payroll, RECEIVED);
    const [same] = gustoPayrollEvents({ ...payroll, payroll_deadline: "2026-02-01T00:00:00Z" }, "2026-10-21T00:00:00.000Z");
    const [changed] = gustoPayrollEvents({ ...payroll, totals: { ...payroll.totals, gross_pay: "4600.00" } }, RECEIVED);
    expect(same!.idempotencyKey).toBe(first!.idempotencyKey);
    expect(changed!.idempotencyKey).not.toBe(first!.idempotencyKey);
    expect(changed!.idempotencyKey.split(":").slice(0, 3)).toEqual(first!.idempotencyKey.split(":").slice(0, 3));
  });

  it("gives nothing for a payroll that isn't processed or has no usable id, and dead-letters one with no check date", () => {
    const payroll = detailed();
    expect(gustoPayrollEvents({ ...payroll, processed: false }, RECEIVED)).toEqual([]);
    expect(gustoPayrollEvents({ ...payroll, processed: "true" }, RECEIVED)).toEqual([]);
    expect(gustoPayrollEvents({ ...payroll, uuid: "../x", payroll_uuid: "../x" }, RECEIVED)).toEqual([]);
    expect(gustoPayrollEvents({ ...payroll, payroll_uuid: undefined }, RECEIVED)[0]!.payload.payrollId).toBe(`gusto:payroll:${gustoUuid("p", 1)}`);
    expect(gustoPayrollEvents({ ...payroll, payroll_uuid: gustoUuid("p", 9).toUpperCase() }, RECEIVED)[0]!.payload.payrollId).toBe(`gusto:payroll:${gustoUuid("p", 9)}`);
    for (const bad of [null, "payroll", 5]) expect(gustoPayrollEvents(bad, RECEIVED)).toEqual([]);
    const undated = gustoPayrollEvents({ ...payroll, check_date: "2026-02-30" }, RECEIVED);
    expect(undated.map((e) => e.occurredAt)).toEqual([undefined, undefined, undefined]);
    expect(undated[0]!.payload).not.toHaveProperty("checkDate");
  });

  it("reads what it can of a sparse payroll, keeping amounts it can't read as null", () => {
    const [run, ...rest] = gustoPayrollEvents({ uuid: gustoUuid("p", 7), processed: true, check_date: "2026-05-01", totals: "x", pay_period: null, employee_compensations: [{ employee_uuid: "not-a-uuid" }, null, { employee_uuid: gustoUuid("e", 7) }] }, RECEIVED);
    expect(run!.payload).toEqual({
      payrollId: `gusto:payroll:${gustoUuid("p", 7)}`,
      checkDate: "2026-05-01",
      kind: "regular",
      grossPayCents: null,
      netPayCents: null,
      employerTaxesCents: null,
      employeeTaxesCents: null,
      benefitsCents: null,
      reimbursementsCents: null,
      bonusesCents: null,
      commissionsCents: null,
      companyDebitCents: null,
      employeeCount: 1,
    });
    expect(rest.map((e) => e.payload)).toEqual([
      { payrollId: `gusto:payroll:${gustoUuid("p", 7)}`, employeeId: `gusto:employee:${gustoUuid("e", 7)}`, checkDate: "2026-05-01", kind: "regular", grossPayCents: null, netPayCents: null, hours: 0, overtimeCents: 0, commissionCents: 0, bonusCents: 0, tipsCents: 0 },
    ]);
  });

  it("reads Gusto's decimal strings as cents and its dates as real days only", () => {
    expect(["4500.00", "0.1", "-12.345", " 7 ", "10.005", "0.0049", "-0.00", "999999999999.99", 12.34, -0.1].map(gustoCents)).toEqual([450_000, 10, -1235, 700, 1001, 0, 0, 99_999_999_999_999, 1234, -10]);
    for (const bad of ["", "1e5", "12,00", "$5", "1.", ".5", "1234567890123", Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}]) expect(gustoCents(bad)).toBeNull();
    expect(["2026-01-19", "2026-01-19T10:00:00Z", " 2024-02-29"].map(gustoDay)).toEqual(["2026-01-19", "2026-01-19", "2024-02-29"]);
    for (const bad of ["2026-02-30", "2025-02-29", "19/01/2026", "2026-1-9", "", 20260119, null]) expect(gustoDay(bad)).toBeUndefined();
  });

  it("uses synthetic fixtures only", () => {
    expect(() => assertSynthetic(company())).not.toThrow();
  });
});

describe("Gusto sync", () => {
  it("imports, replays, resumes and retries the mocked company", async () => {
    // Three regular payrolls with 2 employees each, a bonus run paying 1, one payroll from 2024 with 2,
    // and one with an impossible check date (3 events dead-lettered).
    const result = await checkConnectorSync({ makeConnector: () => connector(gustoDocMock(company())), expected: { ingested: 9 + 2 + 3, deadLettered: 3 } });
    expect(result.full.batches).toBe(4);
    expect(parseGustoCursor(result.full.cursor)).toMatchObject({ pass: "historical", done: true });
  });

  it("reads three years back and a month ahead, in windows of under a year, and each processed payroll once", async () => {
    const mock = gustoDocMock(company());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const windows = reads(mock).filter((r) => r.startsWith(`${LIST}?`)).map((r) => {
      const q = new URL(`${BASE}${r}`).searchParams;
      return [q.get("start_date"), q.get("end_date"), q.get("page")];
    });
    expect(windows).toEqual([
      ["2023-10-20", "2024-10-18", "1"],
      ["2024-10-19", "2025-10-18", "1"],
      ["2025-10-19", "2026-10-18", "1"],
      ["2026-10-19", "2026-11-20", "1"],
    ]);
    const details = reads(mock).filter((r) => /payrolls\/[0-9a-f-]{36}$/.test(r)).map((r) => r.split("/").pop());
    expect(details).toEqual([gustoUuid("p", 6), gustoUuid("p", 1), gustoUuid("p", 2), gustoUuid("p", 3), gustoUuid("p", 8), gustoUuid("p", 4)]);
    expect(mock.fetch.calls.filter((c) => c.method !== "GET").map((c) => c.url)).toEqual([`${BASE}/oauth/token`]);
    expect(report).toMatchObject({ ingested: 14, deadLettered: 3, batches: 4 });
  });

  it("pages through 100 payrolls at a time", async () => {
    gustoPayroll.reset();
    gustoCompensation.reset();
    const payrolls = Array.from({ length: 101 }, (_, i) => gustoPayroll.one({ check_date: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, "0")}`, employee_compensations: [] }));
    const mock = gustoDocMock({ payrolls, refreshToken: FIRST_REFRESH });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const pages = reads(mock).filter((r) => r.startsWith(`${LIST}?`)).map((r) => new URL(`${BASE}${r}`).searchParams.get("page"));
    expect(pages).toEqual(["1", "1", "1", "2", "1"]);
    expect(report).toMatchObject({ ingested: 101, batches: 5 });
  });

  it("skips listed payrolls that aren't processed or have no id, without reading them", async () => {
    const listed = [{ uuid: gustoUuid("p", 1), processed: false }, { processed: true }, { payroll_uuid: 5, processed: true }, null];
    const details: string[] = [];
    const c = gustoConnector({ ...options(gustoDocMock(company())), client: { listPayrolls: async () => listed, getPayroll: async (id) => (details.push(id), {}) } });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect([details, report.ingested]).toEqual([[], 0]);
  });

  it("produces payloads the retail departments accept, and finance sees the payrolls", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(gustoDocMock(company())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 14, deadLettered: 3 });
    expect(new Set(memory.events.map((e) => e.type))).toEqual(new Set([PAYROLL_EVENT_TYPE, EMPLOYEE_PAY_EVENT_TYPE]));
    expect(memory.signals.filter((s) => s.kind === "payroll.run")).toHaveLength(5);
    expect(memory.signals.filter((s) => s.kind === "payroll.employee_pay")).toHaveLength(9);
  });

  it("leaves a finished import finished", async () => {
    const mock = gustoDocMock(company());
    const done: GustoCursor = { pass: "historical", windowStart: "2026-10-19", until: "2026-11-20", page: 1, nextFrom: "2026-09-05", done: true };
    const batches: SourceBatch[] = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })) batches.push(b);
    expect([batches, mock.fetch.calls]).toEqual([[], []]);
  });

  it("reads again from 45 days before the last pass, a month ahead, and starts the next pass 45 days back", async () => {
    const mock = gustoDocMock(company());
    const previous: GustoCursor = { pass: "historical", windowStart: "2026-10-19", until: "2026-11-20", page: 1, nextFrom: "2026-01-10", done: true };
    const batches: SourceBatch[] = [];
    for await (const b of connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(previous) })) batches.push(b);
    const listed = reads(mock).filter((r) => r.startsWith(`${LIST}?`)).map((r) => new URL(`${BASE}${r}`).searchParams);
    expect(listed.map((q) => [q.get("start_date"), q.get("end_date")])).toEqual([["2026-01-10", "2026-11-20"]]);
    expect(batches.flatMap((b) => b.events).filter((e) => (e as { type: string }).type === PAYROLL_EVENT_TYPE)).toHaveLength(5);
    expect(parseGustoCursor(batches.at(-1)!.cursor)).toEqual({ pass: "incremental", windowStart: "2026-01-10", until: "2026-11-20", page: 1, nextFrom: "2026-09-05", done: true });
  });

  it("looks back 45 days without a checkpoint, and never starts later than that", async () => {
    const fresh = gustoDocMock(company());
    for await (const _ of connector(fresh).incrementalSync({ organizationId: TEST_ORG, cursor: null })) void _;
    const ahead: GustoCursor = { pass: "incremental", windowStart: "2026-10-01", until: "2026-11-20", page: 1, nextFrom: "2026-10-15", done: true };
    const late = gustoDocMock(company());
    for await (const _ of connector(late).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(ahead) })) void _;
    for (const mock of [fresh, late]) {
      const q = new URL(`${BASE}${reads(mock).find((r) => r.startsWith(`${LIST}?`))!}`).searchParams;
      expect([q.get("start_date"), q.get("end_date")]).toEqual(["2026-09-05", "2026-11-20"]);
    }
  });

  it("resumes an interrupted incremental pass where it stopped", async () => {
    const mock = gustoDocMock(company());
    const stopped: GustoCursor = { pass: "incremental", windowStart: "2026-03-01", until: "2026-11-20", page: 1, nextFrom: "2026-09-05", done: false };
    for await (const _ of connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(stopped) })) void _;
    const q = new URL(`${BASE}${reads(mock).find((r) => r.startsWith(`${LIST}?`))!}`).searchParams;
    expect(q.get("start_date")).toBe("2026-03-01");
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: GustoCursor = { pass: "historical", windowStart: "2026-01-01", until: "2026-11-20", page: 1, nextFrom: "2026-09-05", done: false };
    expect(parseGustoCursor(JSON.stringify(good))).toEqual(good);
    expect(parseGustoCursor(null)).toBeNull();
    for (const bad of [
      { ...good, pass: "full" },
      { ...good, windowStart: "2026-01-01&page=2" },
      { ...good, until: undefined },
      { ...good, nextFrom: "soon" },
      { ...good, page: 0 },
      { ...good, page: 1.5 },
      { ...good, done: "no" },
      null,
    ]) {
      expect(() => parseGustoCursor(JSON.stringify(bad))).toThrow("Gusto checkpoint is not in the expected shape");
    }
  });

  it("declares no writes, so a read-only gate has nothing to let through", async () => {
    const c = connector(gustoDocMock(company()));
    expect(c.writes).toBe(GUSTO_WRITES);
    expect(GUSTO_WRITES).toEqual([]);
    expect(await assertWritesRefused(c)).toEqual([]);
  });
});

describe("Gusto webhooks", () => {
  const TOKEN = ["verify", "x".repeat(32)].join("-");
  const delivery = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      uuid: gustoUuid("ev", 1),
      event_type: "payroll.processed",
      resource_type: "Company",
      resource_uuid: GUSTO_TEST_COMPANY,
      entity_type: "Payroll",
      entity_uuid: gustoUuid("p", 1),
      timestamp: 1_792_000_000,
      ...extra,
    });

  it("accepts a delivery signed in hex or base64, and rejects tampered, unsigned, wrongly keyed or malformed ones", () => {
    const body = delivery();
    const hex = hmacSha256(TOKEN, body, "hex");
    const base64 = hmacSha256(TOKEN, body, "base64");
    expect(verifyGustoWebhook(TOKEN, body, hex)).toEqual({ ok: true });
    expect(verifyGustoWebhook(TOKEN, body, hex.toUpperCase())).toEqual({ ok: true });
    expect(verifyGustoWebhook(TOKEN, Buffer.from(body), ` ${base64} `)).toEqual({ ok: true });
    expect(verifyGustoWebhook(TOKEN, tamper(body), hex)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyGustoWebhook(TOKEN, tamper(body), base64)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyGustoWebhook(`${TOKEN}x`, body, hex)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyGustoWebhook(TOKEN, body, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(verifyGustoWebhook(TOKEN, body, "")).toEqual({ ok: false, reason: "missing" });
    expect(verifyGustoWebhook("", body, hex)).toEqual({ ok: false, reason: "missing" });
    for (const malformed of [`sha256=${hex}`, hex.slice(1), `${hex}0`, base64.slice(0, -1), "A".repeat(43), "z".repeat(64)]) {
      expect(verifyGustoWebhook(TOKEN, body, malformed)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("describes this company's events, flags payroll ones for a sync, and drops anything else", () => {
    expect(gustoWebhookEvent(JSON.parse(delivery()), GUSTO_TEST_COMPANY)).toEqual({
      id: gustoUuid("ev", 1),
      type: "payroll.processed",
      entityType: "Payroll",
      entityId: gustoUuid("p", 1),
      time: new Date(1_792_000_000_000).toISOString(),
      syncPayrolls: true,
    });
    expect(gustoWebhookEvent(JSON.parse(delivery({ event_type: "employee.updated", entity_type: "Employee", uuid: gustoUuid("ev", 2).toUpperCase() })), ` ${GUSTO_TEST_COMPANY.toUpperCase()} `)).toMatchObject({ id: gustoUuid("ev", 2), syncPayrolls: false });
    expect(gustoWebhookEvent(JSON.parse(delivery({ event_type: "payroll.reversed", entity_type: "PayrollReversal" })), GUSTO_TEST_COMPANY)).toMatchObject({ syncPayrolls: true });
    expect(gustoWebhookEvent(JSON.parse(delivery({ timestamp: "soon" })), GUSTO_TEST_COMPANY)!.time).toBeUndefined();
    expect(gustoWebhookEvent(JSON.parse(delivery({ timestamp: -1 })), GUSTO_TEST_COMPANY)!.time).toBeUndefined();
    for (const other of [
      { resource_uuid: gustoUuid("c", 9) },
      { resource_type: "Application" },
      { resource_uuid: 5 },
      { uuid: "evt-1" },
      { event_type: "Payroll Processed" },
      { event_type: "payroll" },
      { entity_type: "Pay roll" },
      { entity_uuid: "../x" },
    ]) {
      expect(gustoWebhookEvent(JSON.parse(delivery(other)), GUSTO_TEST_COMPANY)).toBeNull();
    }
    for (const bad of [null, "payroll", []]) expect(gustoWebhookEvent(bad, GUSTO_TEST_COMPANY)).toBeNull();
  });

  it("treats a replayed delivery as a prompt to sync, which stores nothing twice", async () => {
    const data = company();
    // A payroll the incremental window reaches.
    data.payrolls.push(gustoPayroll.one({ check_date: "2026-10-09" }));
    const mock = gustoDocMock(data);
    const tokens = memoryTokenStore(FIRST_REFRESH);
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(mock, { tokens }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const again = await runSync({ connector: connector(mock, { tokens }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(first.ingested).toBe(3);
    expect([again.ingested, again.duplicates]).toEqual([0, first.ingested]);
  });
});
