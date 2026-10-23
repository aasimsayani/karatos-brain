import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  AFFIRM_MOCK_READS,
  TEST_ORG,
  UndocumentedRequestError,
  affirmCursorUuid,
  affirmDispute,
  affirmDocMock,
  affirmEventId,
  affirmSettlement,
  affirmTransaction,
  affirmTransactionEvent,
  affirmTransactionId,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  tamper,
  testPipeline,
  type AffirmMock,
  type AffirmMockData,
  type AffirmMockRecord,
} from "@karatos/connector-testkit";
import {
  AFFIRM_API_HOSTS,
  AFFIRM_OVERLAP_MS,
  AFFIRM_READS,
  AFFIRM_SIGNATURE_HEADERS,
  AFFIRM_WEBHOOK_TOLERANCE_SECONDS,
  AFFIRM_WRITES,
  AffirmApiError,
  AffirmConfigError,
  affirmCents,
  affirmClient,
  affirmConnector,
  affirmDisputeEvents,
  affirmMdy,
  affirmPageParams,
  affirmRefundEvents,
  affirmSettlementEvents,
  affirmTime,
  affirmTransactionEvents,
  parseAffirmCursor,
  verifyAffirmWebhook,
  type AffirmClient,
  type AffirmConnectorOptions,
  type AffirmCursor,
  type AffirmParams,
  type AffirmRead,
} from "../src/index.js";

// Key-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const PUBLIC = ["TESTPUB", "0".repeat(9)].join("");
const PRIVATE = ["TESTPRIV", "0".repeat(24)].join("");
const MERCHANT = "MERCHANT-TEST";
const NOW = () => new Date("2026-01-20T00:00:00Z");
const RECEIVED = "2026-01-20T00:00:00.000Z";
const BASIC = () => `Basic ${Buffer.from(`${PUBLIC}:${PRIVATE}`).toString("base64")}`;

function merchant(overrides: Partial<AffirmMockData> = {}): AffirmMockData {
  for (const b of [affirmTransaction, affirmTransactionEvent, affirmSettlement, affirmDispute]) b.reset();
  const t = affirmTransaction;
  const e = affirmTransactionEvent;
  const captured = t.one();
  const authorized = t.one({ status: "authorized" });
  const voided = t.one({ status: "voided" });
  const partial = t.one({ status: "partially_refunded", amount_refunded: 10_000 });
  const refunded = t.one({ status: "refunded", amount_refunded: 125_050 });
  const disputed = t.one({ status: "disputed" });
  // One record Affirm returned without its creation time: it is dead-lettered, not given a made-up one.
  const timeless = t.one();
  delete timeless.created;
  // An order id that isn't a plain reference is left out.
  const odd = t.one({ order_id: "customer1@example.test" });
  return {
    publicApiKey: PUBLIC,
    privateApiKey: PRIVATE,
    merchantId: MERCHANT,
    transactions: [captured, authorized, voided, partial, refunded, disputed, timeless, odd],
    events: {
      [String(captured.id)]: [e.one({ type: "auth" }), e.one()],
      [String(authorized.id)]: [e.one({ type: "auth" })],
      [String(voided.id)]: [e.one({ type: "auth" }), e.one({ type: "void", fee: 0 })],
      [String(partial.id)]: [e.one(), e.one({ type: "refund", amount: 10_000, fee_refunded: 600 })],
      [String(refunded.id)]: [e.one(), e.one({ type: "refund", amount: 125_050, fee_refunded: 7_503 })],
    },
    settlements: [affirmSettlement.one(), affirmSettlement.one({ removal_state: "failed" })],
    disputes: [affirmDispute.one({ transaction_id: disputed.id })],
    ...overrides,
  };
}

const options = (mock: AffirmMock, extra: Partial<AffirmConnectorOptions> = {}): AffirmConnectorOptions => ({
  publicApiKey: PUBLIC,
  privateApiKey: PRIVATE,
  merchantId: MERCHANT,
  environment: "sandbox",
  fetch: mock.fetch,
  sleep: async () => {},
  now: NOW,
  ...extra,
});

const connector = (mock: AffirmMock, extra: Partial<AffirmConnectorOptions> = {}) => affirmConnector(options(mock, extra));
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
type Sent = { method: string; url: URL; auth: string | null };

/** A fetch that keeps each request's method, URL and Authorization header before the mock answers. */
function recording(mock: AffirmMock) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    sent.push({ method: init?.method ?? "GET", url: new URL(String(input)), auth: new Headers(init?.headers).get("authorization") });
    return mock.fetch(input as string, init);
  };
  const of = (path: string) => sent.filter((s) => s.url.pathname === path).map((s) => Object.fromEntries(s.url.searchParams));
  return { fetch, sent, of };
}

const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

/** A client answering from a function, for paging cases the mock doesn't shape. */
function stubClient(respond: (read: AffirmRead, params: AffirmParams) => Record<string, unknown>): AffirmClient & { sent: [AffirmRead, AffirmParams][] } {
  const sent: [AffirmRead, AffirmParams][] = [];
  return {
    environment: "sandbox",
    sent,
    async get(read, params = {}) {
      sent.push([read, params]);
      return respond(read, params);
    },
  };
}

const cursorAt = (step: AffirmCursor["step"], page: string | null = null, pass: AffirmCursor["pass"] = "incremental"): AffirmCursor => ({
  pass,
  step,
  since: "2026-01-18T00:00:00.000Z",
  until: RECEIVED,
  page,
  nextFrom: "2026-01-19T23:00:00.000Z",
});

async function collect(c: ReturnType<typeof affirmConnector>, cursor: AffirmCursor | null, mode: "historical" | "incremental" = "incremental") {
  const batches = [];
  const run = mode === "historical" ? c.historicalImport : c.incrementalSync;
  for await (const b of run({ organizationId: TEST_ORG, cursor: cursor ? JSON.stringify(cursor) : null })) batches.push(b);
  return batches;
}

describe("Affirm client", () => {
  it("checks its settings, naming them but never their values", () => {
    const base = options(affirmDocMock(merchant()));
    expect(() => affirmClient({ ...base, privateApiKey: " " })).toThrow(new AffirmConfigError("set AFFIRM_PUBLIC_API_KEY and AFFIRM_PRIVATE_API_KEY"));
    expect(() => affirmClient({ ...base, publicApiKey: "" })).toThrow("set AFFIRM_PUBLIC_API_KEY and AFFIRM_PRIVATE_API_KEY");
    expect(() => affirmClient({ ...base, publicApiKey: "test key!" })).toThrow("AFFIRM_PUBLIC_API_KEY must be the public API key");
    expect(() => affirmClient({ ...base, privateApiKey: `${PRIVATE}:x` })).toThrow("AFFIRM_PRIVATE_API_KEY must be the private API key");
    expect(() => affirmClient({ ...base, privateApiKey: "short" })).toThrow(AffirmConfigError);
    for (const merchantId of ["", "a b", "x".repeat(65), "../m"]) expect(() => affirmClient({ ...base, merchantId })).toThrow("AFFIRM_MERCHANT_ID must be the Affirm Merchant ID");
    for (const environment of ["", "live", "test", "Production", "canada"]) {
      expect(() => affirmClient({ ...base, environment })).toThrow("AFFIRM_ENVIRONMENT must be production or sandbox");
    }
    expect(affirmClient({ ...base, publicApiKey: ` ${PUBLIC} `, privateApiKey: ` ${PRIVATE} ` }).environment).toBe("sandbox");
    for (const e of [() => affirmClient({ ...base, privateApiKey: `${PRIVATE}!` }), () => affirmClient({ ...base, publicApiKey: `${PUBLIC}!` })]) {
      expect(() => e()).toThrow(expect.objectContaining({ message: expect.not.stringContaining(PRIVATE) }));
    }
  });

  it("sends only its listed reads, refusing everything that could move money before it leaves", async () => {
    const mock = affirmDocMock(merchant());
    const client = affirmClient(options(mock));
    for (const read of ["capture_transaction", "refund_transaction", "void_transaction", "authorize_transaction", "update_transaction", "close_dispute", "constructor", "__proto__", "toString"]) {
      await expect(client.get(read as never)).rejects.toThrow(new AffirmConfigError("the Affirm connector only sends its listed reads"));
    }
    expect(AFFIRM_READS).toEqual(["list_transactions", "read_transaction", "list_transaction_events", "list_settlement_event_summaries", "list_disputes"]);
    // Every read the client may send is one the docs list.
    expect([...AFFIRM_MOCK_READS]).toEqual(AFFIRM_READS);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("sends only parameters it checked itself", async () => {
    const mock = affirmDocMock(merchant());
    const client = affirmClient(options(mock));
    const days = { after: "2026-01-01", before: "2026-01-20" };
    const refused: [AffirmRead, Record<string, unknown>, string | RegExp][] = [
      ["list_transactions", { transaction_type: "charge", query: "customer1@example.test" }, "list_transactions doesn't take query"],
      ["list_transactions", { transaction_type: "charge", expand: "checkout" }, "doesn't take expand"],
      ["list_transactions", { transaction_type: "charge", merchant_id: "OTHER" }, "doesn't take merchant_id"],
      ["list_transactions", {}, "list_transactions needs transaction_type"],
      ["list_transactions", { transaction_type: "loan" }, "can't take that transaction_type"],
      ["list_transactions", { transaction_type: "charge", limit: 101 }, "can't take that limit"],
      ["list_transactions", { transaction_type: "charge", limit: 0 }, "can't take that limit"],
      ["list_transactions", { transaction_type: "charge", limit: 10.5 }, "can't take that limit"],
      ["list_transactions", { transaction_type: "charge", before: "t001-test" }, "can't take that before"],
      ["list_transactions", { transaction_type: "charge", after_timestamp: -1 }, "can't take that after_timestamp"],
      ["list_transactions", { transaction_type: "charge", before_timestamp: "1700000000" }, "can't take that before_timestamp"],
      ["read_transaction", {}, "read_transaction needs id"],
      ["read_transaction", { id: "events" }, "can't take that id"],
      ["read_transaction", { id: "../T001-TEST" }, "can't take that id"],
      ["read_transaction", { id: "T001-TEST/refund" }, "can't take that id"],
      ["read_transaction", { id: "T001-TEST", expand: "checkout" }, "can't take that expand"],
      ["read_transaction", { id: "T001-TEST", expand: "checkout,events" }, "can't take that expand"],
      ["list_transaction_events", { transaction_type: "charge" }, "needs transaction_event_type"],
      ["list_transaction_events", { transaction_type: "charge", transaction_event_type: "fraud" }, "can't take that transaction_event_type"],
      ["list_transaction_events", { transaction_type: "charge", transaction_event_type: "all", after_date: "2026-01-01" }, "can't take that after_date"],
      ["list_transaction_events", { transaction_type: "charge", transaction_event_type: "all", before_date: "02-30-2026" }, "can't take that before_date"],
      ["list_transaction_events", { transaction_type: "charge", transaction_event_type: "all", before_ari: "x&limit=5" }, "can't take that before_ari"],
      ["list_transaction_events", { transaction_type: "charge", transaction_event_type: "all", after_ari: "ABCD1234" }, "doesn't take after_ari"],
      ["list_settlement_event_summaries", {}, "needs after, before"],
      ["list_settlement_event_summaries", { ...days, after: "01-01-2026" }, "can't take that after"],
      ["list_settlement_event_summaries", { ...days, before: "2026-02-30" }, "can't take that before"],
      ["list_settlement_event_summaries", { ...days, limit: 1001 }, "can't take that limit"],
      ["list_settlement_event_summaries", { ...days, merchant_id: "OTHER" }, "doesn't take merchant_id"],
      ["list_settlement_event_summaries", { ...days, to_cursor_uuid: "not-a-uuid", to_cursor_date: "2026-01-01" }, "can't take that to_cursor_uuid"],
      ["list_settlement_event_summaries", { ...days, to_cursor_uuid: affirmCursorUuid(1), to_cursor_date: "soon" }, "can't take that to_cursor_date"],
      ["list_settlement_event_summaries", { ...days, to_cursor_uuid: affirmCursorUuid(1) }, "needs both to_cursor_uuid and to_cursor_date"],
      ["list_settlement_event_summaries", { ...days, to_cursor_date: "2026-01-01" }, "needs both"],
      ["list_disputes", { limit: 101 }, "can't take that limit"],
      ["list_disputes", { page_number: 0 }, "can't take that page_number"],
      ["list_disputes", { status: "closed_customer_favor" }, "doesn't take status"],
    ];
    for (const [read, params, message] of refused) await expect(client.get(read, params as never), JSON.stringify(params)).rejects.toThrow(message);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("GETs the sandbox host with the key pair in the Authorization header only", async () => {
    const mock = affirmDocMock(merchant());
    const seen: { method: string; url: string; headers: Headers; body: unknown }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      seen.push({ method: init?.method ?? "", url: String(input), headers: new Headers(init?.headers), body: init?.body });
      return mock.fetch(input as string, init);
    };
    const client = affirmClient(options(mock, { fetch }));
    await client.get("list_transactions", { transaction_type: "charge", limit: 100, after_timestamp: 1_700_000_000, before: affirmTransactionId(2) });
    await client.get("read_transaction", { id: affirmTransactionId(1), expand: "events" });
    await client.get("list_settlement_event_summaries", { after: "2026-01-01", before: "2026-01-20", limit: 1000 });
    expect(seen.map((s) => [s.method, s.url])).toEqual([
      ["GET", `https://sandbox.affirm.com/api/v1/transactions?transaction_type=charge&limit=100&after_timestamp=1700000000&before=${affirmTransactionId(2)}`],
      ["GET", `https://sandbox.affirm.com/api/v1/transactions/${affirmTransactionId(1)}?expand=events`],
      ["GET", `https://sandbox.affirm.com/api/v1/settlements/daily?after=2026-01-01&before=2026-01-20&limit=1000&merchant_id=${MERCHANT}`],
    ]);
    for (const s of seen) {
      expect(s.headers.get("authorization")).toBe(BASIC());
      expect([...s.headers.keys()].sort()).toEqual(["accept", "authorization"]);
      expect(s.body).toBeUndefined();
      expect(s.url).not.toContain(PRIVATE);
      expect(s.url).not.toContain(PUBLIC);
    }
  });

  it("keeps the sandbox and production hosts apart", async () => {
    expect(AFFIRM_API_HOSTS).toEqual({ production: "https://api.affirm.com", sandbox: "https://sandbox.affirm.com" });
    const sandbox = affirmDocMock(merchant());
    const live = affirmDocMock(merchant({ environment: "production" }));
    await expect(affirmClient(options(live, { environment: "production" })).get("list_disputes")).resolves.toMatchObject({ disputes: [expect.anything()] });
    await expect(affirmClient(options(sandbox, { environment: "production" })).get("list_disputes")).rejects.toThrow(UndocumentedRequestError);
    await expect(affirmClient(options(live, { environment: "sandbox" })).get("list_disputes")).rejects.toThrow(/sandbox\.affirm\.com.*not in the vendor's docs/);
    expect(live.fetch.calls.map((c) => c.url)).toEqual(["https://api.affirm.com/api/v3/disputes"]);
    expect(affirmClient(options(live, { environment: "production" })).environment).toBe("production");
  });

  it("reports Affirm's errors cut short with a hint, and never the key", async () => {
    const wrong = affirmDocMock(merchant({ privateApiKey: ["TESTPRIV", "1".repeat(24)].join("") }));
    const auth = await failure(affirmClient(options(wrong)).get("list_disputes"));
    expect(auth).toMatchObject({ name: "AffirmApiError", status: 401, code: "api-key-pair-invalid" });
    expect(auth.message).toBe("Affirm answered HTTP 401 to list_disputes (api-key-pair-invalid: Invalid API key pair); check AFFIRM_PUBLIC_API_KEY, AFFIRM_PRIVATE_API_KEY and AFFIRM_ENVIRONMENT");
    const mock = affirmDocMock(merchant());
    const lost = await failure(affirmClient(options(mock, { merchantId: "OTHER-MERCHANT" })).get("list_settlement_event_summaries", { after: "2026-01-01", before: "2026-01-02" }));
    expect(lost.message).toMatch(/HTTP 404 .*merchant-not-found.*; check AFFIRM_MERCHANT_ID$/);
    const long = async () => answer({ code: "x".repeat(100), message: "y".repeat(500) }, 400);
    const cut = await failure(affirmClient(options(mock, { fetch: long })).get("list_disputes"));
    expect([cut.message.length < 320, (cut as AffirmApiError).code]).toEqual([true, "x".repeat(60)]);
    const bare = async () => new Response("Server Error", { status: 500 });
    await expect(affirmClient(options(mock, { fetch: bare })).get("list_disputes")).rejects.toThrow(new AffirmApiError("Affirm answered HTTP 500 to list_disputes", 500));
    const blank = async () => answer({ code: "bad", message: "  " }, 400);
    await expect(affirmClient(options(mock, { fetch: blank })).get("list_disputes")).rejects.toThrow(/^Affirm answered HTTP 400 to list_disputes \(bad\)$/);
    for (const body of ["<html>maintenance</html>", "5", "[]"]) {
      const odd = async () => new Response(body, { status: 200 });
      await expect(affirmClient(options(mock, { fetch: odd })).get("list_disputes")).rejects.toThrow(new AffirmApiError("Affirm did not answer with JSON", 200));
    }
    for (const message of [auth.message, lost.message, cut.message]) for (const secret of [PRIVATE, PUBLIC, BASIC()]) expect(message).not.toContain(secret);
  });

  it("waits out throttling, honouring Retry-After up to a minute, then leaves the error to runSync", async () => {
    const mock = affirmDocMock(merchant());
    const answers = [new Response("", { status: 503, headers: { "retry-after": "7" } }), new Response("", { status: 429 }), new Response("", { status: 429, headers: { "retry-after": "3600" } })];
    const waits: number[] = [];
    const throttled: typeof globalThis.fetch = async (input, init) => answers.shift() ?? mock.fetch(input as string, init);
    await expect(affirmClient(options(mock, { fetch: throttled, sleep: async (ms) => void waits.push(ms) })).get("list_disputes")).resolves.toBeDefined();
    expect(waits).toEqual([7000, 2000, 60_000]);
    let tries = 0;
    const always = async () => {
      tries++;
      return new Response("", { status: 429, headers: { "retry-after": "soon" } });
    };
    waits.length = 0;
    const error = await failure(affirmClient(options(mock, { fetch: always, sleep: async (ms) => void waits.push(ms) })).get("list_disputes"));
    expect([waits, tries, error.message]).toEqual([[1000, 2000, 4000], 4, "Affirm answered HTTP 429 to list_disputes"]);
  });
});

describe("Affirm mock", () => {
  const get = (mock: AffirmMock, path: string, auth = BASIC()) => mock.fetch(`${AFFIRM_API_HOSTS.sandbox}${path}`, { headers: { authorization: auth } }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

  it("answers documented reads only, with the account's key pair", async () => {
    const mock = affirmDocMock(merchant());
    await expect(mock.fetch(`${AFFIRM_API_HOSTS.sandbox}/api/v1/transactions/${affirmTransactionId(1)}/capture`, { method: "POST", headers: { authorization: BASIC() } })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${AFFIRM_API_HOSTS.sandbox}/api/v1/transactions/${affirmTransactionId(1)}/refund`, { method: "POST", headers: { authorization: BASIC() } })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${AFFIRM_API_HOSTS.sandbox}/api/v1/transactions`, { method: "POST", headers: { authorization: BASIC() } })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${AFFIRM_API_HOSTS.sandbox}/api/v1/settlements/events`)).rejects.toThrow(UndocumentedRequestError);
    expect((await get(mock, "/api/v3/disputes", "Basic " + Buffer.from(`${PUBLIC}:nope`).toString("base64"))).body).toMatchObject({ code: "api-key-pair-invalid" });
    expect((await get(mock, "/api/v3/disputes", "")).status).toBe(401);
    expect((await get(mock, "/api/v1/transactions?transaction_type=charge&secret=1")).body).toMatchObject({ code: "invalid_field", field: "secret" });
    await expect(get(mock, "/api/v1/transactions?transaction_type=charge&query=x")).rejects.toThrow("the Affirm mock doesn't model query");
    await expect(get(mock, `/api/v1/transactions/${affirmTransactionId(1)}?expand=checkout`)).rejects.toThrow("doesn't model expand=checkout");
    expect((await get(mock, `/api/v1/transactions/${affirmTransactionId(1)}?expand=other`)).status).toBe(400);
    expect((await get(mock, `/api/v1/transactions/${affirmTransactionId(99)}`)).body).toMatchObject({ code: "transaction-not-found" });
    // A read with a bad key pair is refused before it counts; one with a bad parameter counts.
    expect(mock.reads).toEqual(["list_transactions", "list_transactions", "read_transaction", "read_transaction", "read_transaction"]);
  });

  it("checks required parameters, limits, dates and cursors as the docs describe", async () => {
    const mock = affirmDocMock(merchant());
    expect((await get(mock, "/api/v1/transactions")).status).toBe(400);
    expect((await get(mock, "/api/v1/transactions?transaction_type=charge&limit=500")).status).toBe(400);
    expect((await get(mock, "/api/v1/transactions?transaction_type=charge&after_timestamp=soon")).status).toBe(400);
    expect((await get(mock, "/api/v1/transactions?transaction_type=charge&before=NOPE-NOPE")).status).toBe(400);
    const first = await get(mock, "/api/v1/transactions?transaction_type=charge&limit=3");
    expect([(first.body.transactions as AffirmMockRecord[]).map((t) => t.id), first.body.has_next, first.body.has_prev]).toEqual([[affirmTransactionId(8), affirmTransactionId(6), affirmTransactionId(5)], true, false]);
    const second = await get(mock, `/api/v1/transactions?transaction_type=charge&limit=3&before=${affirmTransactionId(5)}`);
    expect([(second.body.transactions as AffirmMockRecord[]).map((t) => t.id), second.body.has_prev]).toEqual([[affirmTransactionId(4), affirmTransactionId(3), affirmTransactionId(2)], true]);
    expect((await get(mock, "/api/v1/transactions/events?transaction_type=charge")).status).toBe(400);
    expect((await get(mock, "/api/v1/transactions/events?transaction_type=charge&transaction_event_type=all&after_date=2026-01-01")).status).toBe(400);
    expect((await get(mock, "/api/v1/transactions/events?transaction_type=charge&transaction_event_type=all&before_ari=NOPE1234")).status).toBe(400);
    expect((await get(mock, "/api/v1/transactions/events?transaction_type=charge&transaction_event_type=all&limit=0")).status).toBe(400);
    const refunds = await get(mock, "/api/v1/transactions/events?transaction_type=charge&transaction_event_type=refund");
    expect(refunds.body).toMatchObject({ next_page: "", prev_page: "" });
    expect((refunds.body.transactions as { transaction_id: string }[]).map((g) => g.transaction_id)).toEqual([affirmTransactionId(5), affirmTransactionId(4)]);
    const page = await get(mock, "/api/v1/transactions/events?transaction_type=charge&transaction_event_type=all&limit=2");
    expect(decodeURIComponent(String(page.body.next_page))).toBe(`before_ari=${affirmEventId(8)}`);
    const later = await get(mock, `/api/v1/transactions/events?transaction_type=charge&transaction_event_type=all&limit=2&before_ari=${affirmEventId(8)}`);
    expect(decodeURIComponent(String(later.body.prev_page))).toBe(`after_ari=${affirmEventId(7)}`);
    const settlements = (q: string) => get(mock, `/api/v1/settlements/daily?merchant_id=${MERCHANT}${q}`);
    expect((await get(mock, "/api/v1/settlements/daily")).status).toBe(400);
    expect((await settlements("&limit=1001")).status).toBe(400);
    expect((await settlements("&after=01-01-2026")).status).toBe(400);
    expect((await settlements(`&to_cursor_uuid=${affirmCursorUuid(9)}&to_cursor_date=2026-01-01`)).status).toBe(400);
    // The default start is 30 days back.
    expect((await settlements("")).body).toMatchObject({ count: 2, prev_page: "" });
    const one = await settlements("&after=2026-01-01&limit=1");
    expect(decodeURIComponent(String(one.body.next_page))).toBe(`to_cursor_uuid=${affirmCursorUuid(2)}&to_cursor_date=2026-01-03T00:00:00.000Z`);
    const rest = await settlements(`&after=2026-01-01&limit=1&to_cursor_uuid=${affirmCursorUuid(2)}&to_cursor_date=2026-01-03T00:00:00.000Z`);
    expect([(rest.body.data as AffirmMockRecord[]).map((s) => s.deposit_id), rest.body.next_page, decodeURIComponent(String(rest.body.prev_page))]).toEqual([["DEPOSIT-TEST-1"], "", `from_cursor_uuid=${affirmCursorUuid(1)}&from_cursor_date=2026-01-02T00:00:00.000Z`]);
    expect((await get(mock, "/api/v3/disputes?limit=500")).status).toBe(400);
    expect((await get(mock, "/api/v3/disputes?page_number=2")).body).toMatchObject({ disputes: [], page_info: { has_next: false, has_prev: true } });
  });
});

describe("Affirm normalization", () => {
  const sync = async (data = merchant()) => {
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(affirmDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    return { report, events: memory.events };
  };
  const ref = (n: number) => `affirm:transaction:${affirmTransactionId(n)}`;

  it("keeps the money, statuses and links, and nothing personal", async () => {
    const { events } = await sync();
    const text = JSON.stringify(events.map((e) => e.payload));
    for (const personal of ["Test Customer", "@", "555", "Test Street", "Testville", "00000", "6789", "REF-TEST", "CHK", "test-header", "Customer"]) {
      expect(text).not.toContain(personal);
    }
    const keys = new Set(events.flatMap((e) => Object.keys(e.payload)));
    for (const field of ["shipping", "email", "name", "phone_number", "address", "token", "checkout_id", "account_last_four", "reference_id", "metadata"]) expect(keys).not.toContain(field);
    const charge = events.find((e) => e.payload.chargeId === ref(1) && e.type === "payment.charge_updated")!;
    expect(charge).toMatchObject({ occurredAt: "2026-01-01T01:00:00.000Z", idempotencyKey: `affirm:transaction:${affirmTransactionId(1)}:captured:0` });
    expect(charge.payload).toEqual({
      chargeId: ref(1),
      status: "succeeded",
      gatewayStatus: "captured",
      paid: true,
      captured: true,
      voided: false,
      amountCents: 125_050,
      capturedCents: 125_050,
      refundedCents: 0,
      currency: "USD",
      disputed: false,
      method: "financing",
      cardBrand: null,
      orderId: "ORDER-TEST-1",
    });
    const of = (n: number) => events.find((e) => e.payload.chargeId === ref(n) && e.type === "payment.charge_updated")!.payload;
    expect(of(2)).toMatchObject({ status: "pending", paid: false, captured: false, capturedCents: 0 });
    expect(of(3)).toMatchObject({ status: "failed", voided: true, captured: false });
    expect(of(4)).toMatchObject({ status: "succeeded", gatewayStatus: "partially_refunded", refundedCents: 10_000 });
    expect(of(6)).toMatchObject({ disputed: true, captured: true });
    expect(of(8)).not.toHaveProperty("orderId");
    const refunds = events.filter((e) => e.type === "payment.refund_updated");
    expect(refunds.map((e) => e.payload)).toEqual([
      { refundId: `affirm:event:${affirmEventId(9)}`, chargeId: ref(5), amountCents: 125_050, currency: "USD", status: "succeeded", reason: null, feeRefundedCents: 7_503 },
      { refundId: `affirm:event:${affirmEventId(7)}`, chargeId: ref(4), amountCents: 10_000, currency: "USD", status: "succeeded", reason: null, feeRefundedCents: 600 },
    ]);
    expect(events.find((e) => e.type === "payment.dispute_updated")!).toMatchObject({
      idempotencyKey: "affirm:dispute:dispute_test_1:action_required_merchant",
      payload: { disputeId: "affirm:dispute:dispute_test_1", chargeId: ref(6), amountCents: 125_050, currency: "USD", reason: "product_not_received", status: "needs_response", gatewayStatus: "action_required_merchant" },
    });
    const payouts = events.filter((e) => e.type === "payout.updated");
    expect(payouts.map((e) => [e.idempotencyKey, e.occurredAt])).toEqual([
      ["affirm:settlement:DEPOSIT-TEST-2:2026-01-03:failed", "2026-01-03T00:00:00.000Z"],
      ["affirm:settlement:DEPOSIT-TEST-1:2026-01-02:settled", "2026-01-02T00:00:00.000Z"],
    ]);
    expect(payouts[1]!.payload).toEqual({
      payoutId: "affirm:deposit:DEPOSIT-TEST-1",
      amountCents: 107_547,
      currency: "USD",
      status: "paid",
      method: "bank_transfer",
      type: "settlement",
      arrivalDate: null,
      settledOn: "2026-01-02",
      salesCents: 125_050,
      refundCents: -10_000,
      feeCents: 7_503,
    });
    expect(payouts[0]!.payload).toMatchObject({ status: "failed", removalState: "failed" });
  });

  it("keys each transaction by its id, status and amount refunded, so each step is stored once and a replay is a duplicate", () => {
    const t = affirmTransaction.one({ id: "KEYS-TEST" });
    const captured = affirmTransactionEvents(t, RECEIVED)[0]!;
    expect(affirmTransactionEvents({ ...t }, "2026-02-01T00:00:00.000Z")[0]!.idempotencyKey).toBe(captured.idempotencyKey);
    expect(affirmTransactionEvents({ ...t, status: "voided" }, RECEIVED)[0]!.idempotencyKey).not.toBe(captured.idempotencyKey);
    const once = affirmTransactionEvents({ ...t, status: "partially_refunded", amount_refunded: 100 }, RECEIVED)[0]!;
    const twice = affirmTransactionEvents({ ...t, status: "partially_refunded", amount_refunded: 200 }, RECEIVED)[0]!;
    expect(once.idempotencyKey).not.toBe(twice.idempotencyKey);
    expect(affirmTransactionEvents({ ...t, amount: 1 }, RECEIVED)[0]!.idempotencyKey).toBe(captured.idempotencyKey);
    expect(captured.id).toBe("affirm_transaction:KEYS-TEST:captured:0");
    const refund = { id: "REFUND-TEST", type: "refund", amount: 5, created: "2026-01-02T00:00:00Z" };
    expect(affirmRefundEvents("KEYS-TEST", refund, RECEIVED)[0]!.idempotencyKey).toBe("affirm:refund:REFUND-TEST:refund");
    expect(affirmRefundEvents("KEYS-TEST", { ...refund, amount: 6 }, "2026-02-01T00:00:00.000Z")[0]!.idempotencyKey).toBe("affirm:refund:REFUND-TEST:refund");
  });

  it("maps every status Affirm lists, and keeps one it doesn't know as unknown", () => {
    const of = (status: string) => affirmTransactionEvents({ id: "STAT-TEST", created: "2026-01-01T00:00:00Z", status }, RECEIVED)[0]!;
    const statuses = { succeeded: ["captured", "partially_refunded", "refunded", "disputed", "dispute_refunded"], pending: ["authorized"], failed: ["voided"] };
    for (const [outcome, list] of Object.entries(statuses)) for (const s of list) expect([s, of(s).payload.status, of(s).payload.paid]).toEqual([s, outcome, outcome === "succeeded"]);
    expect(of("dispute_refunded").payload).toMatchObject({ disputed: true, captured: true });
    expect(of("on_hold").payload).toMatchObject({ status: "unknown", gatewayStatus: "on_hold", paid: false, captured: false });
    expect(of("Bad Status!").idempotencyKey).toBe("affirm:transaction:STAT-TEST:unknown:0");
    expect(of("constructor").payload).toMatchObject({ status: "unknown" });
    const dispute = (status: string) => affirmDisputeEvents({ id: "d1", status, created: "2026-01-01T00:00:00Z" }, RECEIVED)[0]!.payload;
    expect(["action_required_merchant", "no_merchant_action_needed", "closed_merchant_favor", "closed_customer_favor", "closed_customer_partial_favor", "reopened", "toString"].map((s) => dispute(s).status)).toEqual([
      "needs_response", "under_review", "won", "lost", "lost", "unknown", "unknown",
    ]);
    expect(dispute("closed_merchant_favor")).toMatchObject({ reason: null });
    expect(dispute("closed_merchant_favor")).not.toHaveProperty("chargeId");
    expect(affirmRefundEvents("KEYS-TEST", { id: "VOID-TEST", type: "refund_voided", amount: 5 }, RECEIVED)[0]!.payload).toMatchObject({ status: "canceled" });
    expect(affirmRefundEvents("../x", { id: "VOID-TEST", type: "refund", amount: 5 }, RECEIVED)[0]!.payload).not.toHaveProperty("chargeId");
    for (const type of ["capture", "void", "constructor"]) expect(affirmRefundEvents("KEYS-TEST", { id: "EVENT-TEST", type }, RECEIVED)).toEqual([]);
    expect(affirmRefundEvents("KEYS-TEST", { id: "EVENT-TEST" }, RECEIVED)).toEqual([]);
  });

  it("reads amounts and times in the shapes Affirm writes, and dead-letters anything else", () => {
    expect([affirmCents(125_050), affirmCents("-10000"), affirmCents(" 3 "), affirmCents(10.5), affirmCents("1e5"), affirmCents(Number.NaN), affirmCents(null), affirmCents(2 ** 60)]).toEqual([125_050, -10_000, 3, null, null, null, null, null]);
    expect(affirmTime("2021-06-28T19:05:00Z")).toBe("2021-06-28T19:05:00.000Z");
    expect(affirmTime("2019-01-01T00:00:00.000Z")).toBe("2019-01-01T00:00:00.000Z");
    expect(affirmTime("2026-01-05T08:00:00-07:00")).toBe("2026-01-05T15:00:00.000Z");
    for (const bad of ["2026-13-45T00:00:00Z", "2026-01-05T08:00:00", "soon", "2026-01-05", 5, undefined, ""]) expect(affirmTime(bad)).toBeUndefined();
  });

  it("drops records with no usable id, and keeps amounts it can't read as null", () => {
    for (const id of ["../1", "lower-case", 5, undefined]) expect(affirmTransactionEvents({ id } as never, RECEIVED)).toEqual([]);
    expect(affirmTransactionEvents(null as never, RECEIVED)).toEqual([]);
    expect(affirmRefundEvents("KEYS-TEST", null as never, RECEIVED)).toEqual([]);
    expect(affirmRefundEvents("KEYS-TEST", { id: "x", type: "refund" }, RECEIVED)).toEqual([]);
    expect(affirmDisputeEvents({ id: "a b" }, RECEIVED)).toEqual([]);
    expect(affirmDisputeEvents(null as never, RECEIVED)).toEqual([]);
    expect(affirmSettlementEvents({ deposit_id: "../x" }, RECEIVED)).toEqual([]);
    expect(affirmSettlementEvents(null as never, RECEIVED)).toEqual([]);
    expect(affirmSettlementEvents({ deposit_id: "D1", date: "soon", total_settled: "x" as never, currency: "usd" }, RECEIVED)[0]).toMatchObject({
      occurredAt: undefined,
      idempotencyKey: "affirm:settlement:D1:unknown:settled",
      payload: { amountCents: null, currency: null, settledOn: null, status: "paid" },
    });
    expect(affirmSettlementEvents({ deposit_id: "D1", date: "2026-01-02", removal_state: "Rejected!" }, RECEIVED)[0]!.payload).toMatchObject({ status: "failed", removalState: "unknown" });
    expect(affirmTransactionEvents({ id: "AMNT-TEST", amount: "big" as never, currency: "dollars" }, RECEIVED)[0]!.payload).toMatchObject({ amountCents: null, currency: null });
  });

  it("uses synthetic fixtures only", () => {
    expect(() => assertSynthetic(merchant())).not.toThrow();
    expect(() => assertSynthetic([affirmCursorUuid(1), affirmCursorUuid(999_999)])).not.toThrow();
  });
});

describe("Affirm sync", () => {
  it("imports, replays, resumes and retries the mocked account", async () => {
    // 8 transactions, one dead-lettered; 2 refunds; 1 dispute; 2 settlements.
    const result = await checkConnectorSync({ makeConnector: () => connector(affirmDocMock(merchant())), expected: { ingested: 12, deadLettered: 1 } });
    // One batch per step: transactions, refund events, disputes, settlements.
    expect(result.full.batches).toBe(4);
    expect(parseAffirmCursor(result.full.cursor)).toEqual({ pass: "historical", step: "done", since: "2021-01-20T00:00:00.000Z", until: RECEIVED, page: null, nextFrom: "2026-01-19T23:00:00.000Z" });
  });

  it("reads five years of transactions, refunds, disputes and settlements, with GETs to the sandbox only", async () => {
    const mock = affirmDocMock(merchant());
    const { fetch, sent, of } = recording(mock);
    await runSync({ connector: connector(mock, { fetch }), mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(sent.every((s) => s.method === "GET" && s.url.origin === AFFIRM_API_HOSTS.sandbox && s.auth === BASIC())).toBe(true);
    expect(sent.map((s) => s.url.pathname)).toEqual(["/api/v1/transactions", "/api/v1/transactions/events", "/api/v3/disputes", "/api/v1/settlements/daily"]);
    expect(of("/api/v1/transactions")).toEqual([{ transaction_type: "charge", limit: "100", after_timestamp: String(Date.parse("2021-01-20T00:00:00Z") / 1000), before_timestamp: String(Date.parse(RECEIVED) / 1000) }]);
    expect(of("/api/v1/transactions/events")).toEqual([{ transaction_type: "charge", transaction_event_type: "refund", limit: "100", after_date: "01-20-2021", before_date: "01-21-2026" }]);
    expect(of("/api/v3/disputes")).toEqual([{ limit: "100", page_number: "1" }]);
    expect(of("/api/v1/settlements/daily")).toEqual([{ limit: "1000", after: "2021-01-20", before: "2026-01-20", merchant_id: MERCHANT }]);
  });

  it("pages every list to the end", async () => {
    const data = merchant();
    affirmTransaction.reset();
    affirmTransactionEvent.reset();
    affirmSettlement.reset();
    affirmDispute.reset();
    data.transactions = affirmTransaction.many(250, (n) => ({ created: new Date(Date.parse("2025-06-01T00:00:00Z") + n * 3_600_000).toISOString() }));
    data.events = Object.fromEntries(data.transactions.slice(0, 210).map((t) => [String(t.id), [affirmTransactionEvent.one({ type: "refund", amount: 100, created: String(t.created) })]]));
    data.disputes = affirmDispute.many(150);
    data.settlements = affirmSettlement.many(2500, (n) => ({ date: new Date(Date.parse("2021-06-01T00:00:00Z") + n * 3_600_000).toISOString() }));
    const mock = affirmDocMock(data);
    const { fetch, of } = recording(mock);
    const report = await runSync({ connector: connector(mock, { fetch }), mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    const t = of("/api/v1/transactions");
    expect(t.map((q) => q.before ?? null)).toEqual([null, affirmTransactionId(151), affirmTransactionId(51)]);
    expect(of("/api/v1/transactions/events").map((q) => q.before_ari ?? null)).toEqual([null, affirmEventId(111), affirmEventId(11)]);
    expect(of("/api/v3/disputes").map((q) => q.page_number)).toEqual(["1", "2"]);
    const s = of("/api/v1/settlements/daily");
    expect(s.map((q) => q.to_cursor_uuid ?? null)).toEqual([null, affirmCursorUuid(1501), affirmCursorUuid(501)]);
    expect(s[1]!.to_cursor_date).toBe(new Date(Date.parse("2021-06-01T00:00:00Z") + 1501 * 3_600_000).toISOString());
    expect(report.ingested).toBe(250 + 210 + 150 + 2500);
  });

  it("stops on a next page it can't read or that points back at the same page, rather than loop or skip", async () => {
    const reply = (read: AffirmRead, body: Record<string, unknown>) => stubClient((r) => (r === read ? body : {}));
    const run = (client: AffirmClient, step: AffirmCursor["step"], page: string | null = null) => collect(affirmConnector({ ...options(affirmDocMock(merchant())), client }), cursorAt(step, page));
    await expect(run(reply("list_transaction_events", { transactions: [], next_page: "example.com%2Fnext_page" }), "events")).rejects.toThrow("names no event to continue from");
    await expect(run(reply("list_transaction_events", { transactions: [], next_page: "before_ari=x%26y" }), "events")).rejects.toThrow("names no event to continue from");
    await expect(run(reply("list_transaction_events", { transactions: [], next_page: "before_ari=SAME1234" }), "events", "SAME1234")).rejects.toThrow("next page points back at this one");
    await expect(run(reply("list_settlement_event_summaries", { data: [], next_page: "to_cursor_uuid=x&to_cursor_date=2026-01-01" }), "settlements")).rejects.toThrow("names no cursor to continue from");
    await expect(run(reply("list_transactions", { transactions: [{ id: "SAME1234" }], has_next: true }), "transactions", "SAME1234")).rejects.toThrow("next page points back at this one");
    // has_next with an empty page has nothing to continue from, so the list is done.
    const empty = reply("list_transactions", { transactions: [], has_next: true });
    await run(empty, "transactions");
    expect(empty.sent.filter(([r]) => r === "list_transactions")).toHaveLength(1);
    const noMore = reply("list_disputes", { disputes: [], page_info: { has_next: true } });
    await run(noMore, "disputes");
    expect(noMore.sent.filter(([r]) => r === "list_disputes")).toHaveLength(1);
  });

  it("reads next_page whether Affirm writes it encoded, plain or as a URL", () => {
    expect(affirmPageParams(encodeURIComponent("before_ari=ABCD1234"))?.get("before_ari")).toBe("ABCD1234");
    expect(affirmPageParams("before_ari=ABCD1234&limit=100")?.get("before_ari")).toBe("ABCD1234");
    expect(affirmPageParams("https://api.affirm.com/api/v1/transactions/events?before_ari=ABCD1234")?.get("before_ari")).toBe("ABCD1234");
    expect(affirmPageParams(encodeURIComponent("to_cursor_uuid=u&to_cursor_date=2026-01-01"))?.get("to_cursor_date")).toBe("2026-01-01");
    expect([affirmPageParams(""), affirmPageParams("  "), affirmPageParams(null), affirmPageParams(5)]).toEqual([null, null, null, null]);
    expect([...affirmPageParams("%E0%A4%A")!.keys()]).toEqual([]);
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(affirmDocMock(merchant())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 12, deadLettered: 1 });
    expect(new Set(memory.events.map((e) => e.type))).toEqual(new Set(["payment.charge_updated", "payment.refund_updated", "payment.dispute_updated", "payout.updated"]));
  });

  it("leaves a finished import finished, without a call", async () => {
    const mock = affirmDocMock(merchant());
    expect([await collect(connector(mock), cursorAt("done", null, "historical"), "historical"), mock.fetch.calls]).toEqual([[], []]);
  });

  it("reads from where the last pass started, less an hour, and starts the next pass an hour before this one", async () => {
    const mock = affirmDocMock(merchant());
    const { fetch, of } = recording(mock);
    const previous: AffirmCursor = { pass: "incremental", step: "done", since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T03:30:00.000Z", page: null, nextFrom: "2026-01-02T02:30:00.000Z" };
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "affirm", "incremental", JSON.stringify(previous));
    const report = await runSync({ connector: connector(mock, { fetch }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(of("/api/v1/transactions")[0]!.after_timestamp).toBe(String(Date.parse("2026-01-02T02:30:00Z") / 1000));
    expect(of("/api/v1/transactions/events")[0]).toMatchObject({ transaction_event_type: "all", after_date: "01-02-2026", before_date: "01-21-2026" });
    expect(of("/api/v1/settlements/daily")[0]).toMatchObject({ after: "2026-01-02", before: "2026-01-20" });
    expect(AFFIRM_OVERLAP_MS).toBe(3_600_000);
    expect(parseAffirmCursor(report.cursor)).toEqual({ pass: "incremental", step: "done", since: "2026-01-02T02:30:00.000Z", until: RECEIVED, page: null, nextFrom: "2026-01-19T23:00:00.000Z" });
    // Every fixture transaction and event is from the 1st, so only the dispute (read whole) and both settlements are new;
    // the transaction with no time is listed whatever the range, and dead-lettered.
    expect(report).toMatchObject({ ingested: 3, deadLettered: 1 });
  });

  it("catches a change saved while a pass runs, on the next pass", async () => {
    const data = merchant({ events: {}, disputes: [], settlements: [] });
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(affirmDocMock(data)), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // A transaction created at 23:40, which Affirm lists only after the pass at midnight read the list.
    const late = affirmTransaction.one({ id: "LATE-TEST", created: "2026-01-19T23:40:00Z" });
    const later = () => new Date(NOW().getTime() + 15 * 60_000);
    const next = await runSync({ connector: connector(affirmDocMock({ ...data, transactions: [...data.transactions, late] }), { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(next.ingested).toBe(1);
    expect(memory.events.map((e) => e.payload.chargeId)).toContain("affirm:transaction:LATE-TEST");
  });

  it("looks back 48 hours with no checkpoint, and reads again each older transaction an event changed", async () => {
    // An authorization made weeks ago is captured today: it isn't in the list of new transactions, but its capture event is.
    const old = affirmTransaction.one({ id: "OLDX-TEST", status: "authorized", created: "2025-12-01T00:00:00Z" });
    const capture = affirmTransactionEvent.one({ id: "CAPTURE-TEST", type: "capture", created: "2026-01-19T12:00:00Z" });
    const auth = affirmTransactionEvent.one({ id: "AUTH-TEST", type: "auth", created: "2026-01-19T12:00:00Z" });
    const fresh = affirmTransaction.one({ id: "NEWX-TEST", status: "authorized", created: "2026-01-19T12:00:00Z" });
    const data = merchant({ transactions: [old, fresh], events: { [String(fresh.id)]: [auth] }, disputes: [], settlements: [] });
    const { memory, pipeline } = testPipeline();
    const mock = affirmDocMock(data);
    const { fetch, sent, of } = recording(mock);
    const first = await runSync({ connector: connector(mock, { fetch }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(of("/api/v1/transactions")[0]!.after_timestamp).toBe(String(Date.parse("2026-01-18T00:00:00Z") / 1000));
    // The new authorization's own auth event needs no second read.
    expect(sent.filter((s) => s.url.pathname.startsWith("/api/v1/transactions/") && s.url.pathname !== "/api/v1/transactions/events")).toEqual([]);
    expect(first.ingested).toBe(1);
    const moved = { ...data, transactions: [{ ...old, status: "captured" }, fresh], events: { ...data.events, [String(old.id)]: [capture] } };
    const second = recording(affirmDocMock(moved));
    const report = await runSync({ connector: connector(affirmDocMock(moved), { fetch: second.fetch }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(second.sent.filter((s) => s.url.pathname === "/api/v1/transactions/OLDX-TEST").map((s) => s.url.search)).toEqual([""]);
    expect(report).toMatchObject({ ingested: 1, duplicates: 0 });
    expect(memory.events.at(-1)!.payload).toMatchObject({ chargeId: "affirm:transaction:OLDX-TEST", gatewayStatus: "captured" });
    const third = await runSync({ connector: connector(affirmDocMock(moved)), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(third).toMatchObject({ ingested: 0, duplicates: 1 });
  });

  it("resumes an interrupted pass at the step and page it stopped on", async () => {
    const mock = affirmDocMock(merchant());
    const { fetch, sent, of } = recording(mock);
    const stopped: AffirmCursor = { ...cursorAt("transactions", affirmTransactionId(4), "historical"), since: "2021-01-20T00:00:00.000Z" };
    const batches = await collect(connector(mock, { fetch }), stopped, "historical");
    expect(of("/api/v1/transactions")[0]!.before).toBe(affirmTransactionId(4));
    expect(sent.map((s) => s.url.pathname)).toEqual(["/api/v1/transactions", "/api/v1/transactions/events", "/api/v3/disputes", "/api/v1/settlements/daily"]);
    expect(batches[0]!.events.map((e) => (e as { payload: Record<string, unknown> }).payload.chargeId)).toEqual([3, 2, 1, 7].map((n) => `affirm:transaction:${affirmTransactionId(n)}`));
    const page2 = { ...cursorAt("settlements", `${affirmCursorUuid(2)}|2026-01-03T00:00:00.000Z`, "historical"), since: "2026-01-01T00:00:00.000Z" };
    const rest = recording(affirmDocMock(merchant()));
    await collect(connector(affirmDocMock(merchant()), { fetch: rest.fetch }), page2, "historical");
    expect(rest.of("/api/v1/settlements/daily")).toEqual([{ limit: "1000", after: "2026-01-01", before: "2026-01-20", to_cursor_uuid: affirmCursorUuid(2), to_cursor_date: "2026-01-03T00:00:00.000Z", merchant_id: MERCHANT }]);
    const disputes = stubClient(() => ({ disputes: [], page_info: { has_next: false } }));
    await collect(affirmConnector({ ...options(mock), client: disputes }), cursorAt("disputes", "3"));
    expect(disputes.sent[0]).toEqual(["list_disputes", { limit: 100, page_number: 3 }]);
  });

  it("rejects a checkpoint it didn't write", () => {
    const good = cursorAt("events", "ABCD1234");
    expect(parseAffirmCursor(JSON.stringify(good))).toEqual(good);
    expect(parseAffirmCursor(null)).toBeNull();
    for (const ok of [cursorAt("transactions", "T001-TEST"), cursorAt("disputes", "2"), cursorAt("settlements", `${affirmCursorUuid(1)}|2026-01-03`), cursorAt("done"), cursorAt("transactions")]) {
      expect(parseAffirmCursor(JSON.stringify(ok))).toEqual(ok);
    }
    for (const bad of [
      { ...good, pass: "full" },
      { ...good, step: "refunds" },
      { ...good, since: "2026-01-01" },
      { ...good, until: "2026-13-45T00:00:00Z" },
      { ...good, nextFrom: "Mon, 19 Jan 2026 00:00:00 GMT" },
      { ...good, since: "2026-02-01T00:00:00.000Z" },
      { ...good, page: "abcd&limit=1" },
      { ...good, page: 5 },
      cursorAt("disputes", "0"),
      cursorAt("disputes", "ABCD1234"),
      cursorAt("disputes", "100000"),
      cursorAt("settlements", "ABCD1234"),
      cursorAt("settlements", `${affirmCursorUuid(1)}|soon`),
      cursorAt("transactions", "1"),
      cursorAt("done", "ABCD1234"),
      null,
      5,
    ]) {
      expect(() => parseAffirmCursor(JSON.stringify(bad)), JSON.stringify(bad)?.slice(0, 80)).toThrow("Affirm checkpoint is not in the expected shape");
    }
  });

  it("writes days as Affirm takes them", () => {
    expect(affirmMdy(Date.parse("2021-01-20T23:59:59Z"))).toBe("01-20-2021");
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const c = connector(affirmDocMock(merchant()));
    expect(c.writes).toBe(AFFIRM_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.action, a.outcome])).toEqual([
      ["capture_transaction", "refused"],
      ["refund_transaction", "refused"],
      ["void_transaction", "refused"],
    ]);
  });
});

describe("Affirm webhooks", () => {
  const SECRET = ["test", "signing", "0".repeat(20)].join("-");
  const body = "event=opened&checkout_token=TESTCHECKOUT&order_id=ORDER-TEST-1";
  const T = 1_768_867_200;
  const sign = (secret: string, t: number | string, text: string) => createHmac("sha512", secret).update(`${t}.${text}`, "utf8").digest("hex");
  const header = (t: number, text = body, secret = SECRET) => `t=${t},v0=${sign(secret, t, text)}`;

  it("accepts a correctly signed delivery and rejects tampered, unsigned, wrongly keyed or malformed ones", () => {
    expect(AFFIRM_SIGNATURE_HEADERS).toEqual(["affirm-signature", "x-affirm-signature"]);
    expect(verifyAffirmWebhook(SECRET, body, header(T), T)).toEqual({ ok: true, timestamp: T });
    expect(verifyAffirmWebhook(SECRET, Buffer.from(body), ` t=${T} , v0=${sign(SECRET, T, body).toUpperCase()} `, T + 60)).toEqual({ ok: true, timestamp: T });
    // One of several v0 signatures matching is enough, as during a secret rotation.
    expect(verifyAffirmWebhook(SECRET, body, `t=${T},v0=${"0".repeat(128)},v0=${sign(SECRET, T, body)}`, T)).toEqual({ ok: true, timestamp: T });
    expect(verifyAffirmWebhook(SECRET, tamper(body), header(T), T)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyAffirmWebhook(`${SECRET}0`, body, header(T), T)).toEqual({ ok: false, reason: "mismatch" });
    // The timestamp is signed too: moving it breaks the signature.
    expect(verifyAffirmWebhook(SECRET, body, `t=${T + 1},v0=${sign(SECRET, T, body)}`, T)).toEqual({ ok: false, reason: "mismatch" });
    // Signed without the timestamp, or with SHA-256, is not Affirm's scheme.
    expect(verifyAffirmWebhook(SECRET, body, `t=${T},v0=${createHmac("sha512", SECRET).update(body).digest("hex")}`, T)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyAffirmWebhook(SECRET, body, undefined, T)).toEqual({ ok: false, reason: "missing" });
    expect(verifyAffirmWebhook("", body, header(T), T)).toEqual({ ok: false, reason: "missing" });
    const hex = sign(SECRET, T, body);
    const sha256 = createHmac("sha256", SECRET).update(`${T}.${body}`).digest("hex");
    for (const malformed of [hex, `v0=${hex}`, `t=${T}`, `t=${T},v1=${hex}`, `t=${T},v0=${sha256}`, `t=soon,v0=${hex}`, `t=${T},t=${T},v0=${hex}`, `t=${T},v0=${hex.slice(2)}`, `t=${T},v0=${Buffer.from(hex, "hex").toString("base64")}`, `t=${T},=x,v0=${hex}`]) {
      expect(verifyAffirmWebhook(SECRET, body, malformed, T), malformed.slice(0, 16)).toEqual({ ok: false, reason: "malformed" });
    }
    // A downgrade: a valid signature under any scheme but v0 never counts.
    expect(verifyAffirmWebhook(SECRET, body, `t=${T},v1=${hex},v0=${"0".repeat(128)}`, T)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a replayed delivery once its timestamp is past the tolerance, either way", () => {
    expect(AFFIRM_WEBHOOK_TOLERANCE_SECONDS).toBe(300);
    expect(verifyAffirmWebhook(SECRET, body, header(T), T + 300)).toEqual({ ok: true, timestamp: T });
    expect(verifyAffirmWebhook(SECRET, body, header(T), T + 301)).toEqual({ ok: false, reason: "stale" });
    expect(verifyAffirmWebhook(SECRET, body, header(T), T - 301)).toEqual({ ok: false, reason: "stale" });
    expect(verifyAffirmWebhook(SECRET, body, header(T), T + 3600, 7200)).toEqual({ ok: true, timestamp: T });
    // A forged delivery is a mismatch, not stale, so a bad signature is never mistaken for a late one.
    expect(verifyAffirmWebhook(`${SECRET}0`, body, header(T), T + 3600)).toEqual({ ok: false, reason: "mismatch" });
    const realNow = Math.floor(Date.now() / 1000);
    expect(verifyAffirmWebhook(SECRET, body, header(realNow))).toMatchObject({ ok: true });
  });

  it("treats a replay inside the tolerance as a prompt to sync, which stores nothing twice", async () => {
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(affirmDocMock(merchant())), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const again = await runSync({ connector: connector(affirmDocMock(merchant())), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(first.ingested).toBeGreaterThan(0);
    expect(again.ingested).toBe(0);
  });
});
