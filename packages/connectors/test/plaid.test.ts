import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  plaidAccount,
  plaidDocMock,
  plaidTransaction,
  tamper,
  testPipeline,
  type PlaidMock,
  type PlaidMockChange,
  type PlaidMockData,
} from "@karatos/connector-testkit";
import {
  GENERIC_BANK_PROFILE,
  PLAID_API_VERSION,
  PLAID_DAYS_REQUESTED,
  PLAID_MUTATION_RESTARTS,
  PLAID_READ_ENDPOINTS,
  PLAID_SYNC_PAGE_SIZE,
  PLAID_WEBHOOK_MAX_AGE_SECONDS,
  PLAID_WRITES,
  PlaidApiError,
  PlaidConfigError,
  assertPlaidReadEndpoint,
  parsePlaidCursor,
  plaidAccountEvent,
  plaidAccountKind,
  plaidAccountKinds,
  plaidBalanceCents,
  plaidCents,
  plaidClient,
  plaidConnector,
  plaidRemovedEvent,
  plaidSyncEvents,
  plaidSyncPrompt,
  plaidTransactionEvent,
  plaidWebhookKeys,
  verifyPlaidWebhook,
  type PlaidClient,
  type PlaidConnectorOptions,
  type PlaidCursor,
  type PlaidVerificationKey,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = ["client", "test", "x".repeat(12)].join("-");
const SECRET = ["secret", "test", "x".repeat(16)].join("-");
const TOKEN = ["access", "sandbox", "x".repeat(8)].join("-");
const PRODUCTION_TOKEN = ["access", "production", "x".repeat(8)].join("-");
const ITEM = "item_test_1";
const NOW = () => new Date("2026-01-20T00:00:00Z");
const RECEIVED = "2026-01-20T00:00:00.000Z";
const SANDBOX = "https://sandbox.plaid.com";

const added = (overrides: Parameters<typeof plaidTransaction.one>[0] = {}): PlaidMockChange => ({ kind: "added", transaction: plaidTransaction.one(overrides) });

/**
 * A checking account and a card, with five posted transactions, a cash
 * deposit, a card purchase, a pending charge (skipped), one with no date
 * (dead-lettered), a modification and a removal.
 */
function bank(overrides: Partial<PlaidMockData> = {}): PlaidMockData {
  plaidAccount.reset();
  plaidTransaction.reset();
  const checking = plaidAccount.one();
  const card = plaidAccount.one({ name: "Test Business Card", official_name: "Test Bank Card", type: "credit", subtype: "credit card", balances: { available: 4000, current: 1000, limit: 5000, iso_currency_code: "USD", unofficial_currency_code: null } });
  const changes: PlaidMockChange[] = [
    ...[1, 2, 3, 4, 5].map(() => added()),
    added({ amount: -2500, name: "CASH DEPOSIT BRANCH 12", merchant_name: null }),
    added({ account_id: card.account_id, amount: 89.5, name: "TEST JEWELRY SUPPLY" }),
    added({ pending: true }),
    added({ date: "not a date" }),
  ];
  const first = (changes[0] as { transaction: ReturnType<typeof plaidTransaction.one> }).transaction;
  changes.push({ kind: "modified", transaction: { ...first, merchant_name: "Test Vendor One Renamed" } });
  changes.push({ kind: "removed", transaction_id: "txn_test_2", account_id: checking.account_id });
  return { clientId: CLIENT_ID, secret: SECRET, accessToken: TOKEN, itemId: ITEM, accounts: [checking, card], changes, ...overrides };
}

const options = (mock: PlaidMock, extra: Partial<PlaidConnectorOptions> = {}): PlaidConnectorOptions => ({
  clientId: CLIENT_ID,
  secret: SECRET,
  accessToken: TOKEN,
  environment: "sandbox",
  fetch: mock.fetch,
  sleep: async () => {},
  now: NOW,
  ...extra,
});

const connector = (mock: PlaidMock, extra: Partial<PlaidConnectorOptions> = {}) => plaidConnector(options(mock, extra));

async function collect(batches: AsyncIterable<{ events: unknown[]; cursor: string }>) {
  const all = [];
  for await (const b of batches) all.push(b);
  return all;
}

/** A fetch that records what the client sends and answers with one canned response. */
function recorder(answer: () => Response) {
  const sent: { url: string; method: string; headers: Headers; body: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    sent.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    return answer();
  };
  return { sent, fetch };
}

const plaidError = (status: number, type: string, code: string, message = "test error") =>
  new Response(JSON.stringify({ error_type: type, error_code: code, error_message: message, display_message: null, request_id: "req-test" }), { status });

describe("Plaid client", () => {
  it("checks its settings, naming them but never their values", () => {
    const base = options(plaidDocMock(bank()));
    expect(() => plaidClient({ ...base, secret: " " })).toThrow(new PlaidConfigError("set PLAID_CLIENT_ID and PLAID_SECRET"));
    expect(() => plaidClient({ ...base, clientId: "" })).toThrow("set PLAID_CLIENT_ID and PLAID_SECRET");
    expect(() => plaidClient({ ...base, accessToken: "  " })).toThrow("set PLAID_ACCESS_TOKEN");
    expect(() => plaidClient({ ...base, environment: "development" })).toThrow("PLAID_ENVIRONMENT must be production or sandbox");
    expect(() => plaidClient({ ...base, environment: undefined as unknown as string })).toThrow("PLAID_ENVIRONMENT must be production or sandbox");
    expect(() => plaidClient({ ...base, environment: " sandbox " })).not.toThrow();
    // A token Plaid issued for one environment can't be sent to the other.
    expect(() => plaidClient({ ...base, accessToken: PRODUCTION_TOKEN })).toThrow("PLAID_ACCESS_TOKEN is for Plaid's production environment, not sandbox");
    expect(() => plaidClient({ ...base, environment: "production" })).toThrow("PLAID_ACCESS_TOKEN is for Plaid's sandbox environment, not production");
    expect(() => plaidClient({ ...base, accessToken: ["access", "development", "x".repeat(8)].join("-") })).toThrow("development environment");
    for (const message of ["sandbox", "production"].flatMap((environment) => {
      try {
        plaidClient({ ...base, environment, accessToken: environment === "sandbox" ? PRODUCTION_TOKEN : TOKEN });
        return [];
      } catch (e) {
        return [(e as Error).message];
      }
    })) {
      for (const secret of [TOKEN, PRODUCTION_TOKEN, SECRET, CLIENT_ID]) expect(message).not.toContain(secret);
    }
  });

  it("refuses every endpoint but its read allowlist before a request is sent", async () => {
    const { sent, fetch } = recorder(() => new Response("{}"));
    const client = plaidClient({ ...options(plaidDocMock(bank())), fetch });
    for (const endpoint of ["/transfer/create", "/item/remove", "/processor/token/create", "/accounts/balance/get", "/item/public_token/exchange", "/accounts/get/../../transfer/create", "/ACCOUNTS/GET", "accounts/get", ""]) {
      await expect(client.request(endpoint, { amount: "1.00" })).rejects.toThrow(new PlaidConfigError(`the Plaid connector only calls read endpoints; ${endpoint} is not one`));
      expect(() => assertPlaidReadEndpoint(endpoint)).toThrow(PlaidConfigError);
    }
    expect(sent).toEqual([]);
    expect(PLAID_READ_ENDPOINTS).toEqual(["/accounts/get", "/transactions/sync", "/item/get", "/webhook_verification_key/get"]);
    await client.request("/item/get", {});
    expect(sent.map((s) => s.url)).toEqual([`${SANDBOX}/item/get`]);
  });

  it("posts JSON to the environment's host, with the keys in headers, the pinned version, and the token in the body", async () => {
    const { sent, fetch } = recorder(() => new Response(JSON.stringify({ accounts: [] })));
    await plaidClient({ ...options(plaidDocMock(bank())), fetch }).accounts();
    const [request] = sent;
    expect([request!.method, request!.url]).toEqual(["POST", `${SANDBOX}/accounts/get`]);
    expect(request!.headers.get("plaid-client-id")).toBe(CLIENT_ID);
    expect(request!.headers.get("plaid-secret")).toBe(SECRET);
    expect(request!.headers.get("plaid-version")).toBe(PLAID_API_VERSION);
    expect(PLAID_API_VERSION).toBe("2020-09-14");
    expect(request!.headers.get("content-type")).toBe("application/json");
    // The keys never travel in a body, where a log or an echoed error could carry them.
    expect(JSON.parse(request!.body)).toEqual({ access_token: TOKEN });
    expect(request!.body).not.toContain(SECRET);
    expect(request!.body).not.toContain(CLIENT_ID);
    const production = recorder(() => new Response(JSON.stringify({ accounts: [] })));
    await plaidClient({ ...options(plaidDocMock(bank())), environment: "production", accessToken: PRODUCTION_TOKEN, fetch: production.fetch }).accounts();
    expect(production.sent[0]!.url).toBe("https://production.plaid.com/accounts/get");
    // A token in neither documented shape is sent as it is; Plaid itself refuses it if it's wrong.
    const other = recorder(() => new Response(JSON.stringify({ accounts: [] })));
    await plaidClient({ ...options(plaidDocMock(bank())), accessToken: "opaque-token-test", fetch: other.fetch }).accounts();
    expect(JSON.parse(other.sent[0]!.body)).toEqual({ access_token: "opaque-token-test" });
  });

  it("asks for a full page, two years of history, and continues from the cursor it is given", async () => {
    const { sent, fetch } = recorder(() => new Response(JSON.stringify({ added: [], modified: [], removed: [], next_cursor: "c-test-2", has_more: false })));
    const client = plaidClient({ ...options(plaidDocMock(bank())), fetch });
    await client.transactionsSync(null);
    await client.transactionsSync("");
    await client.transactionsSync("c-test-1");
    expect(sent.map((s) => JSON.parse(s.body))).toEqual([
      { access_token: TOKEN, count: 500, options: { days_requested: 730, include_original_description: false } },
      { access_token: TOKEN, count: 500, options: { days_requested: 730, include_original_description: false } },
      { access_token: TOKEN, cursor: "c-test-1", count: 500, options: { days_requested: 730, include_original_description: false } },
    ]);
    expect([PLAID_SYNC_PAGE_SIZE, PLAID_DAYS_REQUESTED]).toEqual([500, 730]);
    await expect(client.transactionsSync("bad cursor")).rejects.toThrow("the Plaid sync cursor is not in the expected shape");
    await expect(client.transactionsSync("x".repeat(257))).rejects.toThrow(PlaidConfigError);
    expect(sent).toHaveLength(3);
  });

  it("reads the Item and fetches webhook keys without the access token", async () => {
    const mock = plaidDocMock(bank());
    const client = plaidClient(options(mock));
    expect(await client.item()).toEqual({ item_id: ITEM });
    const key = await client.webhookVerificationKey(mock.keyId);
    expect(key).toMatchObject({ kid: mock.keyId, kty: "EC", crv: "P-256", alg: "ES256", expired_at: null });
    const { sent, fetch } = recorder(() => new Response(JSON.stringify({ key: { kid: "kid_test_9" } })));
    await plaidClient({ ...options(mock), fetch }).webhookVerificationKey("kid_test_9");
    expect(JSON.parse(sent[0]!.body)).toEqual({ key_id: "kid_test_9" });
    await expect(client.webhookVerificationKey("../kid")).rejects.toThrow("a webhook key ID must be a short token");
    await expect(client.webhookVerificationKey("")).rejects.toThrow(PlaidConfigError);
  });

  it("backs off on rate limits, by status or by Plaid's error type, and gives up after its retries", async () => {
    const waits: number[] = [];
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      return plaidError(429, "RATE_LIMIT_EXCEEDED", "TRANSACTIONS_SYNC_LIMIT", "rate limit exceeded");
    };
    const error = await plaidClient({ ...options(plaidDocMock(bank())), fetch, sleep: async (ms) => void waits.push(ms) })
      .accounts()
      .catch((e: unknown) => e);
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(calls).toBe(4);
    expect(error).toMatchObject({ name: "PlaidApiError", status: 429, code: "TRANSACTIONS_SYNC_LIMIT", type: "RATE_LIMIT_EXCEEDED", message: "Plaid answered HTTP 429: RATE_LIMIT_EXCEEDED/TRANSACTIONS_SYNC_LIMIT: rate limit exceeded" });

    let typed = 0;
    const byType: typeof globalThis.fetch = async () => (typed++ < 1 ? plaidError(400, "RATE_LIMIT_EXCEEDED", "ACCOUNTS_LIMIT") : new Response(JSON.stringify({ accounts: [] })));
    await expect(plaidClient({ ...options(plaidDocMock(bank())), fetch: byType }).accounts()).resolves.toEqual({ accounts: [] });
    expect(typed).toBe(2);

    const mock = plaidDocMock(bank());
    mock.rateLimit(2);
    const slept: number[] = [];
    await expect(plaidClient({ ...options(mock), sleep: async (ms) => void slept.push(ms) }).accounts()).resolves.toMatchObject({ accounts: [{ account_id: "acct_test_1" }, { account_id: "acct_test_2" }] });
    expect(slept).toEqual([1000, 2000]);
    const once = plaidDocMock(bank());
    once.rateLimit(2);
    await expect(plaidClient({ ...options(once), rateLimitRetries: 1 }).accounts()).rejects.toMatchObject({ status: 429, code: "RATE_LIMIT" });
  });

  it("asks for the bank to be reconnected on ITEM_LOGIN_REQUIRED, without retrying", async () => {
    const mock = plaidDocMock(bank());
    mock.requireLogin();
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls++;
      return mock.fetch(input as string, init);
    };
    const error = (await plaidClient({ ...options(mock), fetch }).transactionsSync(null).catch((e: unknown) => e)) as PlaidApiError;
    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(PlaidApiError);
    expect(error).toMatchObject({ status: 400, code: "ITEM_LOGIN_REQUIRED", type: "ITEM_ERROR" });
    expect(error.message).toMatch(/^Plaid can't reach the bank until it is reconnected: reconnect the bank in Plaid Link \(update mode\) \(ITEM_ERROR\/ITEM_LOGIN_REQUIRED: the login details/);
    const bare = recorder(() => new Response(JSON.stringify({ error_code: "ITEM_LOGIN_REQUIRED" }), { status: 400 }));
    await expect(plaidClient({ ...options(mock), fetch: bare.fetch }).accounts()).rejects.toThrow("reconnect the bank in Plaid Link (update mode) (ITEM_LOGIN_REQUIRED)");
    mock.requireLogin(false);
    await expect(plaidClient(options(mock)).accounts()).resolves.toBeDefined();
  });

  it("reports Plaid's error type, code and message, cut short, and never a credential", async () => {
    const mock = plaidDocMock(bank());
    const wrongSecret = (await plaidClient({ ...options(mock), secret: "wrong-secret-test" }).accounts().catch((e: unknown) => e)) as PlaidApiError;
    expect(wrongSecret).toMatchObject({ status: 400, code: "INVALID_API_KEYS", type: "INVALID_INPUT", message: "Plaid answered HTTP 400: INVALID_INPUT/INVALID_API_KEYS: invalid client_id or secret provided" });
    const wrongToken = (await plaidClient({ ...options(mock), accessToken: ["access", "sandbox", "y".repeat(8)].join("-") }).accounts().catch((e: unknown) => e)) as PlaidApiError;
    expect(wrongToken.code).toBe("INVALID_ACCESS_TOKEN");
    // An error that echoed a credential back, or ran long, is redacted and capped.
    const echoed = recorder(() => plaidError(400, "INVALID_INPUT", "INVALID_FIELD", `bad ${TOKEN} with ${SECRET} for ${CLIENT_ID} ${"x".repeat(500)}`));
    const long = (await plaidClient({ ...options(mock), fetch: echoed.fetch }).accounts().catch((e: unknown) => e)) as PlaidApiError;
    expect(long.message.startsWith("Plaid answered HTTP 400: INVALID_INPUT/INVALID_FIELD: bad [redacted] with [redacted] for [redacted] xxx")).toBe(true);
    expect(long.message.length).toBeLessThanOrEqual("Plaid answered HTTP 400: INVALID_INPUT/INVALID_FIELD: ".length + 200);
    const odd = recorder(() => new Response("<html>gateway</html>", { status: 502 }));
    const gateway = (await plaidClient({ ...options(mock), fetch: odd.fetch }).accounts().catch((e: unknown) => e)) as PlaidApiError;
    expect(gateway).toMatchObject({ status: 502, code: undefined, message: "Plaid answered HTTP 502" });
    const hugeCode = recorder(() => plaidError(400, "T".repeat(100), "C".repeat(100)));
    const capped = (await plaidClient({ ...options(mock), fetch: hugeCode.fetch }).accounts().catch((e: unknown) => e)) as PlaidApiError;
    expect([capped.code!.length, capped.type!.length]).toEqual([60, 60]);
    for (const message of [wrongSecret.message, wrongToken.message, long.message, gateway.message]) {
      for (const secret of [CLIENT_ID, SECRET, TOKEN]) expect(message).not.toContain(secret);
    }
  });

  it("refuses answers that aren't what each endpoint returns", async () => {
    const mock = plaidDocMock(bank());
    const answering = (body: unknown) => plaidClient({ ...options(mock), fetch: recorder(() => new Response(JSON.stringify(body))).fetch });
    await expect(answering({ accounts: "x" }).accounts()).rejects.toThrow("Plaid did not answer with a list of accounts");
    await expect(answering(null).accounts()).rejects.toThrow("Plaid did not answer with a list of accounts");
    const page = { added: [], modified: [], removed: [], next_cursor: "c-test-1", has_more: false };
    for (const bad of [null, { ...page, added: {} }, { ...page, modified: null }, { ...page, removed: "x" }, { ...page, has_more: "no" }, { ...page, next_cursor: 7 }, { ...page, next_cursor: "has space" }, { ...page, has_more: true, next_cursor: "" }]) {
      await expect(answering(bad).transactionsSync(null)).rejects.toThrow("Plaid did not answer with a page of transaction changes");
    }
    await expect(answering({ ...page, next_cursor: "" }).transactionsSync(null)).resolves.toMatchObject({ next_cursor: "" });
    await expect(answering({ item: {} }).item()).rejects.toThrow("Plaid did not answer with an Item");
    await expect(answering({}).item()).rejects.toThrow("Plaid did not answer with an Item");
    await expect(answering({ key: "x" }).webhookVerificationKey("kid_test_1")).rejects.toThrow("Plaid did not answer with a verification key");
    await expect(answering({}).webhookVerificationKey("kid_test_1")).rejects.toThrow("Plaid did not answer with a verification key");
  });
});

describe("Plaid normalization", () => {
  it("turns Plaid's money-out-positive amounts into signed cents, money in positive", () => {
    expect([plaidCents(12.34), plaidCents(-2500), plaidCents(0.125), plaidCents(-0.125), plaidCents(0.1 + 0.2)]).toEqual([-1234, 250_000, -13, 13, -30]);
    expect(Object.is(plaidCents(0), 0)).toBe(true);
    expect(Object.is(plaidCents(-0), 0)).toBe(true);
    expect([plaidCents("5"), plaidCents(Number.NaN), plaidCents(Number.POSITIVE_INFINITY), plaidCents(null)]).toEqual([null, null, null, null]);
    expect([plaidBalanceCents(1100.5), plaidBalanceCents(-3), plaidBalanceCents(null), plaidBalanceCents(undefined), plaidBalanceCents("1")]).toEqual([110_050, -300, null, undefined, null]);
  });

  it("keeps what finance uses, in the bank statements shape, and nothing personal", () => {
    const data = bank();
    const kinds = plaidAccountKinds(data.accounts);
    const events = plaidSyncEvents(
      {
        added: data.changes.flatMap((c) => (c.kind === "added" ? [c.transaction] : [])),
        modified: data.changes.flatMap((c) => (c.kind === "modified" ? [c.transaction] : [])),
        removed: data.changes.flatMap((c) => (c.kind === "removed" ? [c] : [])),
      },
      RECEIVED,
      kinds,
    );
    const accounts = data.accounts.map((a) => plaidAccountEvent(a, RECEIVED)!);
    const text = JSON.stringify([...events, ...accounts].map((e) => e.payload));
    for (const personal of ["Test Customer", "Test Street", "Testville", "REF-TEST", "persist_test", "Test Bank", "in store", "GENERAL_MERCHANDISE_OTHER", "business"]) expect(text).not.toContain(personal);
    expect(events[0]).toEqual({
      id: "plaid_transaction:txn_test_1",
      type: "bank.transaction_imported",
      occurredAt: "2026-01-02T00:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "plaid:transaction:txn_test_1",
      payload: {
        transactionId: "plaid:transaction:txn_test_1",
        accountId: "plaid:account:acct_test_1",
        accountKind: "bank",
        amountCents: -1234,
        description: "TEST VENDOR 1 PURCHASE",
        category: "vendor_payment",
        currency: "USD",
        merchantName: "Test Vendor 1",
        plaidCategory: "GENERAL_MERCHANDISE",
        authorizedDate: "2026-01-01",
      },
    });
    const deposit = events.find((e) => e.payload.description === "CASH DEPOSIT BRANCH 12")!;
    expect(deposit.payload).toMatchObject({ amountCents: 250_000, category: "cash_deposit", accountKind: "bank" });
    expect(deposit.payload).not.toHaveProperty("merchantName");
    const card = events.find((e) => e.payload.description === "TEST JEWELRY SUPPLY")!;
    expect(card.payload).toMatchObject({ accountId: "plaid:account:acct_test_2", accountKind: "credit_card", amountCents: -8950, category: "vendor_payment" });
    // Pending: skipped. No date: kept without one, so the pipeline dead-letters it.
    expect(events.filter((e) => e.type === "bank.transaction_imported")).toHaveLength(8);
    expect(events.find((e) => e.idempotencyKey === "plaid:transaction:txn_test_8")).toBeUndefined();
    expect(events.find((e) => e.idempotencyKey === "plaid:transaction:txn_test_9")!.occurredAt).toBeUndefined();
    expect(accounts[1]!.payload).toEqual({
      accountId: "plaid:account:acct_test_2",
      accountKind: "credit_card",
      name: "Test Business Card",
      mask: "1002",
      type: "credit",
      subtype: "credit card",
      currentBalanceCents: 100_000,
      availableBalanceCents: 400_000,
      limitCents: 500_000,
      currency: "USD",
    });
    expect(accounts[0]!.payload).toMatchObject({ limitCents: null, accountKind: "bank", mask: "1001" });
  });

  it("stores a modification once per change, and a removal once, without counting the money twice", () => {
    plaidTransaction.reset();
    const t = plaidTransaction.one();
    const first = plaidTransactionEvent("modified", t, RECEIVED)!;
    expect(first.type).toBe("bank.transaction_updated");
    expect(first.idempotencyKey).toMatch(/^plaid:transaction:txn_test_1:[0-9a-f]{16}$/);
    expect(plaidTransactionEvent("modified", { ...t }, "2026-02-01T00:00:00.000Z")!.idempotencyKey).toBe(first.idempotencyKey);
    expect(plaidTransactionEvent("modified", { ...t, amount: 99 }, RECEIVED)!.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(plaidTransactionEvent("added", { ...t, amount: 99 }, RECEIVED)!.idempotencyKey).toBe("plaid:transaction:txn_test_1");
    expect(plaidRemovedEvent({ transaction_id: "txn_test_7", account_id: "acct_test_1" }, RECEIVED)).toEqual({
      id: "plaid_transaction:txn_test_7:removed",
      type: "bank.transaction_removed",
      occurredAt: RECEIVED,
      receivedAt: RECEIVED,
      idempotencyKey: "plaid:transaction:txn_test_7:removed",
      payload: { transactionId: "plaid:transaction:txn_test_7", accountId: "plaid:account:acct_test_1" },
    });
    expect(plaidRemovedEvent({ transaction_id: "txn_test_7", account_id: "../x" }, RECEIVED)!.payload).toEqual({ transactionId: "plaid:transaction:txn_test_7" });
  });

  it("drops records it can't key, and keeps what it can't read missing so the pipeline dead-letters them", () => {
    expect(plaidTransactionEvent("added", { amount: 1, date: "2026-01-01" }, RECEIVED)).toBeNull();
    expect(plaidTransactionEvent("added", { transaction_id: "a/../b", amount: 1 }, RECEIVED)).toBeNull();
    expect(plaidTransactionEvent("added", null as never, RECEIVED)).toBeNull();
    expect(plaidTransactionEvent("added", { transaction_id: "t1", pending: true }, RECEIVED)).toBeNull();
    expect(plaidTransactionEvent("added", { transaction_id: "t1", date: "2026-02-30" }, RECEIVED)!.occurredAt).toBeUndefined();
    expect(plaidTransactionEvent("added", { transaction_id: "t1", date: "2026-13-45", authorized_date: "2026-02-29" }, RECEIVED)!.occurredAt).toBeUndefined();
    const bare = plaidTransactionEvent("added", { transaction_id: "t1", account_id: "a/b", date: "2026-01-05", amount: "1" as never, name: "  " }, RECEIVED)!;
    expect(bare.payload).toEqual({ transactionId: "plaid:transaction:t1", accountKind: "bank", amountCents: null, description: "", category: "other" });
    expect(plaidTransactionEvent("added", { transaction_id: "t2", amount: 5, name: null, merchant_name: "  Test   Shop  ", unofficial_currency_code: "BTC", check_number: "1042" }, RECEIVED)!.payload).toMatchObject({
      description: "Test Shop",
      merchantName: "Test Shop",
      currency: "BTC",
      checkNumber: "1042",
    });
    expect(plaidRemovedEvent({ account_id: "acct_test_1" }, RECEIVED)).toBeNull();
    expect(plaidRemovedEvent(null as never, RECEIVED)).toBeNull();
    expect(plaidAccountEvent({ name: "No id" }, RECEIVED)).toBeNull();
    expect(plaidAccountEvent(null as never, RECEIVED)).toBeNull();
    const plain = plaidAccountEvent({ account_id: "acct_test_77", mask: "123456789", balances: { last_updated_datetime: "2026-01-19T08:00:00-05:00" } }, RECEIVED)!;
    expect(plain.payload).toEqual({ accountId: "plaid:account:acct_test_77", accountKind: "bank", name: "Plaid account t_77" });
    expect(plain.occurredAt).toBe("2026-01-19T13:00:00.000Z");
    expect(plaidAccountEvent({ account_id: "acct_test_77", balances: { last_updated_datetime: "soon" } }, RECEIVED)!.occurredAt).toBe(RECEIVED);
    expect(plaidAccountEvent({ account_id: "acct_test_77" }, RECEIVED)!.idempotencyKey).toBe(plaidAccountEvent({ account_id: "acct_test_77" }, "2026-03-01T00:00:00.000Z")!.idempotencyKey);
    expect(plaidAccountEvent({ account_id: "acct_test_77", balances: { current: 1 } }, RECEIVED)!.idempotencyKey).not.toBe(plaidAccountEvent({ account_id: "acct_test_77", balances: { current: 2 } }, RECEIVED)!.idempotencyKey);
    expect([plaidAccountKind("credit"), plaidAccountKind("depository"), plaidAccountKind("loan"), plaidAccountKind(undefined)]).toEqual(["credit_card", "bank", "bank", "bank"]);
    expect(plaidAccountKinds([{ account_id: "a1", type: "credit" }, { name: "no id" }, null as never])).toEqual(new Map([["a1", "credit_card"]]));
  });

  it("uses a bank profile's own categories when given one", () => {
    const profile = { ...GENERIC_BANK_PROFILE, categories: [{ match: "CONSIGNMENT", category: "card_settlement" as const }] };
    expect(plaidTransactionEvent("added", { transaction_id: "t1", amount: -10, name: "TEST GALLERY CONSIGNMENT" }, RECEIVED, new Map(), profile)!.payload.category).toBe("card_settlement");
  });

  it("uses synthetic fixtures only", () => {
    expect(() => assertSynthetic(bank())).not.toThrow();
  });
});

describe("Plaid sync", () => {
  it("imports, replays, resumes and retries the mocked bank", async () => {
    // 2 accounts, 8 added (one pending skipped, one dead-lettered), a modification and a removal.
    const result = await checkConnectorSync({ makeConnector: () => connector(plaidDocMock(bank())), expected: { ingested: 11, deadLettered: 1 } });
    expect(result.full.batches).toBe(2);
    expect(parsePlaidCursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done" });
  });

  it("produces payloads the retail departments accept, with finance seeing each transaction once", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(plaidDocMock(bank())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 11, deadLettered: 1 });
    expect(new Set(memory.events.map((e) => e.type))).toEqual(new Set(["bank.account_updated", "bank.transaction_imported", "bank.transaction_updated", "bank.transaction_removed"]));
    const bankSignals = memory.signals.filter((s) => s.kind === "bank.transaction");
    expect(bankSignals).toHaveLength(7);
    expect(bankSignals.filter((s) => (s.value as { category: string }).category === "cash_deposit").map((s) => (s.value as { amountCents: number }).amountCents)).toEqual([250_000]);
  });

  it("pages through the whole history from no cursor, 500 at a time, and ends where the next pass begins", async () => {
    const data = bank({ changes: [] });
    data.changes = Array.from({ length: 1001 }, () => added());
    const mock = plaidDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 1001 + 2, batches: 4 });
    expect(mock.syncCursors.map((c) => (c === null ? null : Buffer.from(c, "base64url").toString()))).toEqual([null, "log:500", "log:1000"]);
    const end = parsePlaidCursor(report.cursor)!;
    expect(end).toEqual({ pass: "historical", step: "done", start: end.next, next: end.next });
    expect(Buffer.from(end.next!, "base64url").toString()).toBe("log:1001");
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`))).toEqual(new Set(["POST /accounts/get", "POST /transactions/sync"]));
  });

  it("carries on from the saved Plaid cursor, storing only what changed since", async () => {
    const mock = plaidDocMock(bank());
    const { memory, pipeline } = testPipeline();
    const imported = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    plaidTransaction.reset();
    mock.push({ kind: "added", transaction: plaidTransaction.one({ transaction_id: "txn_test_new", amount: 40 }) }, { kind: "removed", transaction_id: "txn_test_3", account_id: "acct_test_1" });
    const historical = () => memory.getCheckpoint(TEST_ORG, "plaid", "historical");
    const first = await runSync({ connector: connector(mock, { historicalCheckpoint: historical }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // Two new changes; the accounts' balances haven't moved, so they are duplicates.
    expect(first).toMatchObject({ ingested: 2, duplicates: 2, batches: 2 });
    expect(mock.syncCursors.at(-1)).toBe(parsePlaidCursor(imported.cursor)!.next);
    const again = await runSync({ connector: connector(mock, { historicalCheckpoint: historical }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(again).toMatchObject({ ingested: 0, duplicates: 2 });
    expect(mock.syncCursors.at(-1)).toBe(parsePlaidCursor(first.cursor)!.next);
  });

  it("starts an incremental pass with nothing to go on from the start of the history", async () => {
    const mock = plaidDocMock(bank());
    const fresh = await runSync({ connector: connector(mock), mode: "incremental", ...testPipeline(), organizationId: TEST_ORG });
    expect(fresh.ingested).toBe(11);
    expect(mock.syncCursors).toEqual([null]);
    // An unfinished import isn't a place to carry on from.
    const unfinished: PlaidCursor = { pass: "historical", step: "transactions", start: null, next: "c-test-1" };
    const other = plaidDocMock(bank());
    await runSync({ connector: connector(other, { historicalCheckpoint: async () => JSON.stringify(unfinished) }), mode: "incremental", ...testPipeline(), organizationId: TEST_ORG });
    expect(other.syncCursors).toEqual([null]);
    const none = plaidDocMock(bank());
    await runSync({ connector: connector(none, { historicalCheckpoint: async () => null }), mode: "incremental", ...testPipeline(), organizationId: TEST_ORG });
    expect(none.syncCursors).toEqual([null]);
  });

  it("leaves a finished import finished", async () => {
    const mock = plaidDocMock(bank());
    const done: PlaidCursor = { pass: "historical", step: "done", start: "c-test-9", next: "c-test-9" };
    expect(await collect(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) }))).toEqual([]);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("resumes an interrupted pass at the page it stopped on, reading the accounts again but not storing them", async () => {
    const data = bank({ changes: [] });
    data.changes = Array.from({ length: 700 }, () => added());
    const mock = plaidDocMock(data);
    const all = await collect(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    const stopped = all[1]!.cursor;
    expect(parsePlaidCursor(stopped)).toMatchObject({ pass: "incremental", step: "transactions", start: null });
    const resumed = await collect(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: stopped }));
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.events).toHaveLength(200);
    expect(mock.syncCursors.at(-1)).toBe(parsePlaidCursor(stopped)!.next);
    expect(mock.fetch.calls.at(-2)!.url).toBe(`${SANDBOX}/accounts/get`);
  });

  it("restarts the pagination loop from the cursor that began it when Plaid's data changes mid-loop", async () => {
    const data = bank({ changes: [] });
    data.changes = Array.from({ length: 1200 }, () => added());
    const mock = plaidDocMock(data);
    const { memory, pipeline } = testPipeline();
    const begin: PlaidCursor = { pass: "incremental", step: "done", start: null, next: Buffer.from("log:100").toString("base64url") };
    await memory.saveCheckpoint(TEST_ORG, "plaid", "incremental", JSON.stringify(begin));
    const c = connector(mock);
    const wrapped = {
      ...c,
      async *incrementalSync(context: Parameters<typeof c.incrementalSync>[0]) {
        let n = 0;
        for await (const batch of c.incrementalSync(context)) {
          // After the first page of changes, Plaid's data shifts under the loop.
          if (n++ === 1) mock.mutateDuringPagination();
          yield batch;
        }
      },
    };
    const report = await runSync({ connector: wrapped, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const asked = mock.syncCursors.map((x) => (x === null ? null : Buffer.from(x, "base64url").toString()));
    expect(asked).toEqual(["log:100", "log:600", "log:100", "log:600", "log:1100"]);
    expect(report).toMatchObject({ ingested: 1100 + 2, duplicates: 500 });
    expect(parsePlaidCursor(report.cursor)).toMatchObject({ step: "done", next: Buffer.from("log:1200").toString("base64url") });
  });

  it("gives up after a few restarts, leaving the error to runSync", async () => {
    const mock = plaidDocMock(bank());
    mock.mutateDuringPagination(PLAID_MUTATION_RESTARTS + 1);
    const batches = connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null })[Symbol.asyncIterator]();
    await batches.next();
    await expect(batches.next()).rejects.toMatchObject({ code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" });
    expect(mock.syncCursors).toEqual([null, null, null, null]);
    const recovers = plaidDocMock(bank());
    recovers.mutateDuringPagination(PLAID_MUTATION_RESTARTS);
    await expect(collect(connector(recovers).historicalImport({ organizationId: TEST_ORG, cursor: null }))).resolves.toHaveLength(2);
    // Any other error is thrown at once.
    const login = plaidDocMock(bank());
    const it2 = connector(login).historicalImport({ organizationId: TEST_ORG, cursor: null })[Symbol.asyncIterator]();
    await it2.next();
    login.requireLogin();
    await expect(it2.next()).rejects.toMatchObject({ code: "ITEM_LOGIN_REQUIRED" });
    expect(login.fetch.calls.filter((c) => c.url.endsWith("/transactions/sync"))).toHaveLength(1);
  });

  it("finishes an import of an Item that isn't ready yet, and reads its history once Plaid has it", async () => {
    const mock = plaidDocMock(bank({ notReady: true }));
    const { memory, pipeline } = testPipeline();
    const imported = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(imported).toMatchObject({ ingested: 2, batches: 2 });
    expect(parsePlaidCursor(imported.cursor)).toEqual({ pass: "historical", step: "done", start: null, next: null });
    mock.setReady();
    const later = await runSync({ connector: connector(mock, { historicalCheckpoint: () => memory.getCheckpoint(TEST_ORG, "plaid", "historical") }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(later.ingested).toBe(9);
    expect(mock.syncCursors).toEqual([null, null]);
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: PlaidCursor = { pass: "incremental", step: "transactions", start: "c-test-1", next: "c-test-2" };
    expect(parsePlaidCursor(JSON.stringify(good))).toEqual(good);
    expect(parsePlaidCursor(JSON.stringify({ ...good, extra: "x" }))).toEqual(good);
    expect(parsePlaidCursor(null)).toBeNull();
    for (const bad of [
      { ...good, pass: "full" },
      { ...good, step: "deletions" },
      { ...good, start: 5 },
      { ...good, next: "has space" },
      { ...good, next: "x".repeat(257) },
      { ...good, start: "" },
      { pass: "incremental", step: "transactions", start: null },
      null,
    ]) {
      expect(() => parsePlaidCursor(JSON.stringify(bad))).toThrow("Plaid checkpoint is not in the expected shape");
    }
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const c = connector(plaidDocMock(bank()));
    expect(c.writes).toBe(PLAID_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.action, a.outcome])).toEqual([
      ["create_transfer", "refused"],
      ["remove_item", "refused"],
      ["create_processor_token", "refused"],
    ]);
  });

  it("can run on an injected client", async () => {
    const client: PlaidClient = {
      request: async () => ({}) as never,
      accounts: async () => ({ accounts: [{ account_id: "acct_test_1", type: "credit" }] }),
      transactionsSync: async () => ({ added: [{ transaction_id: "t1", account_id: "acct_test_1", amount: 5, date: "2026-01-05", name: "TEST" }], modified: [], removed: [], next_cursor: "c-test-1", has_more: false }),
      item: async () => ({ item_id: ITEM }),
      webhookVerificationKey: async () => ({}),
    };
    const batches = await collect(plaidConnector({ ...options(plaidDocMock(bank())), client }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect((batches[1]!.events[0] as { payload: { accountKind: string } }).payload.accountKind).toBe("credit_card");
  });
});

describe("Plaid webhooks", () => {
  const NOW_MS = Date.parse("2026-01-20T00:00:00Z");
  const NOW_S = NOW_MS / 1000;
  const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: ITEM, initial_update_complete: true, historical_update_complete: false, environment: "sandbox" }, null, 2);

  function setup() {
    const mock = plaidDocMock(bank());
    let fetched = 0;
    const client = plaidClient({
      ...options(mock),
      fetch: async (input, init) => {
        fetched++;
        return mock.fetch(input as string, init);
      },
    });
    const keys = plaidWebhookKeys(client);
    const check = (raw: string | Buffer, header: string | undefined, clock = () => NOW_MS) => verifyPlaidWebhook(raw, header, { key: keys, clock });
    return { mock, check, fetched: () => fetched };
  }

  it("accepts a correctly signed, fresh delivery", async () => {
    const { mock, check } = setup();
    const jwt = mock.signWebhook(body, { iat: NOW_S - 10 });
    expect(await check(body, jwt)).toEqual({ ok: true });
    expect(await check(Buffer.from(body), ` ${jwt} `)).toEqual({ ok: true });
    expect(await check(body, mock.signWebhook(body, { iat: NOW_S - PLAID_WEBHOOK_MAX_AGE_SECONDS }))).toEqual({ ok: true });
    expect(PLAID_WEBHOOK_MAX_AGE_SECONDS).toBe(300);
    const upper = mock.signWebhook(body, { iat: NOW_S, bodySha256: (await import("node:crypto")).createHash("sha256").update(body).digest("hex").toUpperCase() });
    expect(await check(body, upper)).toEqual({ ok: true });
  });

  it("rejects a tampered or re-spaced body", async () => {
    const { mock, check } = setup();
    const jwt = mock.signWebhook(body, { iat: NOW_S });
    expect(await check(tamper(body), jwt)).toEqual({ ok: false, reason: "body_mismatch" });
    expect(await check(JSON.stringify(JSON.parse(body)), jwt)).toEqual({ ok: false, reason: "body_mismatch" });
    expect(await check(body, mock.signWebhook(body, { iat: NOW_S, bodySha256: "abc" }))).toEqual({ ok: false, reason: "body_mismatch" });
    expect(await check(body, mock.signWebhook(body, { iat: NOW_S, bodySha256: "0".repeat(64) }))).toEqual({ ok: false, reason: "body_mismatch" });
  });

  it("rejects every algorithm but ES256, none included, before fetching a key", async () => {
    const { mock, check, fetched } = setup();
    for (const alg of ["none", "None", "HS256", "RS256", "ES384", ""]) {
      expect(await check(body, mock.signWebhook(body, { iat: NOW_S, alg })), alg).toEqual({ ok: false, reason: "algorithm" });
    }
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", kid: mock.keyId })).toString("base64url")}.${Buffer.from(JSON.stringify({ iat: NOW_S })).toString("base64url")}.`;
    expect(await check(body, unsigned)).toEqual({ ok: false, reason: "malformed" });
    expect(fetched()).toBe(0);
  });

  it("rejects a delivery more than five minutes old, or dated ahead", async () => {
    const { mock, check } = setup();
    expect(await check(body, mock.signWebhook(body, { iat: NOW_S - PLAID_WEBHOOK_MAX_AGE_SECONDS - 1 }))).toEqual({ ok: false, reason: "stale" });
    expect(await check(body, mock.signWebhook(body, { iat: NOW_S - 86_400 }))).toEqual({ ok: false, reason: "stale" });
    expect(await check(body, mock.signWebhook(body, { iat: NOW_S + PLAID_WEBHOOK_MAX_AGE_SECONDS + 1 }))).toEqual({ ok: false, reason: "stale" });
    expect(await check(body, mock.signWebhook(body, { iat: "soon" as never }))).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects an unknown, retired or wrongly shaped key, and a bad signature", async () => {
    const { mock, check } = setup();
    expect(await check(body, mock.signWebhook(body, { iat: NOW_S, kid: "kid_test_unknown" }))).toEqual({ ok: false, reason: "unknown_key" });
    // Signed by someone else's key under Plaid's key ID.
    const forger = plaidDocMock(bank());
    expect(await check(body, forger.signWebhook(body, { iat: NOW_S }))).toEqual({ ok: false, reason: "signature" });
    const jwt = mock.signWebhook(body, { iat: NOW_S });
    const [h, p, s] = jwt.split(".") as [string, string, string];
    const flipped = Buffer.from(s, "base64url");
    flipped[10] = flipped[10]! ^ 1;
    expect(await check(body, `${h}.${p}.${flipped.toString("base64url")}`)).toEqual({ ok: false, reason: "signature" });
    expect(await check(body, `${h}.${p}.${Buffer.alloc(70).toString("base64url")}`)).toEqual({ ok: false, reason: "signature" });
    // Claims swapped under a valid signature don't verify.
    const fresher = Buffer.from(JSON.stringify({ iat: NOW_S, request_body_sha256: "0".repeat(64) })).toString("base64url");
    expect(await check(body, `${h}.${fresher}.${s}`)).toEqual({ ok: false, reason: "signature" });
    mock.expireKey(NOW_S - 1);
    const retired = setup();
    retired.mock.expireKey(NOW_S);
    expect(await retired.check(body, retired.mock.signWebhook(body, { iat: NOW_S }))).toEqual({ ok: false, reason: "expired_key" });
    const later = setup();
    later.mock.expireKey(NOW_S + 60);
    expect(await later.check(body, later.mock.signWebhook(body, { iat: NOW_S }))).toEqual({ ok: true });
    const good = await plaidClient(options(mock)).webhookVerificationKey(mock.keyId);
    const shaped = (key: Record<string, unknown>) => verifyPlaidWebhook(body, mock.signWebhook(body, { iat: NOW_S }), { key: async () => ({ ...good, expired_at: null, ...key }) as PlaidVerificationKey, clock: () => NOW_MS });
    expect(await shaped({})).toEqual({ ok: true });
    expect(await shaped({ alg: undefined })).toEqual({ ok: true });
    for (const bad of [{ kty: "RSA" }, { crv: "P-384" }, { alg: "RS256" }, { x: undefined }, { y: 5 as never }, { x: "AAAA" }]) expect(await shaped(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: "unknown_key" });
    expect(await verifyPlaidWebhook(body, mock.signWebhook(body, { iat: Math.floor(Date.now() / 1000) }), { key: async () => ({ ...good, expired_at: null }) })).toEqual({ ok: true });
  });

  it("rejects a missing or malformed header", async () => {
    const { mock, check } = setup();
    const [h, p, s] = mock.signWebhook(body, { iat: NOW_S }).split(".") as [string, string, string];
    expect(await check(body, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(await check(body, "")).toEqual({ ok: false, reason: "missing" });
    for (const header of [`${h}.${p}`, `${h}.${p}.${s}.x`, `${h}.${p}.${s}=`, `x.${p}.${s}`, `${Buffer.from("[1]").toString("base64url")}.${p}.${s}`, `${Buffer.from(JSON.stringify({ alg: "ES256", kid: "../k" })).toString("base64url")}.${p}.${s}`, `${Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url")}.${p}.${s}`]) {
      expect(await check(body, header), header).toEqual({ ok: false, reason: expect.stringMatching(/malformed|algorithm/) });
    }
    expect(await check(body, `${h}.${p}.${s}=`)).toEqual({ ok: false, reason: "malformed" });
    expect(await check(body, `${h}.${Buffer.from("not json").toString("base64url")}.${s}`)).toEqual({ ok: false, reason: "signature" });
  });

  it("asks Plaid for each key once, and doesn't mistake an outage for a forgery", async () => {
    const { mock, check, fetched } = setup();
    await check(body, mock.signWebhook(body, { iat: NOW_S }));
    await check(body, mock.signWebhook(body, { iat: NOW_S }));
    expect(fetched()).toBe(1);
    await check(body, mock.signWebhook(body, { iat: NOW_S, kid: "kid_test_unknown" }));
    expect(fetched()).toBe(2);
    let n = 0;
    const retiredKeys = plaidWebhookKeys({ webhookVerificationKey: async () => ({ kid: "k", expired_at: ++n }) });
    await retiredKeys("k");
    await retiredKeys("k");
    expect(n).toBe(2);
    for (const status of [500, 429]) {
      const down = plaidWebhookKeys({ webhookVerificationKey: async () => Promise.reject(new PlaidApiError("Plaid answered", status)) });
      await expect(down("kid_test_1")).rejects.toThrow(PlaidApiError);
    }
    const broken = plaidWebhookKeys({ webhookVerificationKey: async () => Promise.reject(new Error("network down")) });
    await expect(broken("kid_test_1")).rejects.toThrow("network down");
    const gone = plaidWebhookKeys({ webhookVerificationKey: async () => Promise.reject(new PlaidApiError("Plaid answered", 404)) });
    expect(await gone("kid_test_1")).toBeNull();
  });

  it("finds the sync prompt for this Item only", () => {
    expect(plaidSyncPrompt(JSON.parse(body), ITEM)).toEqual({ itemId: ITEM, initialUpdateComplete: true, historicalUpdateComplete: false });
    expect(plaidSyncPrompt({ ...JSON.parse(body), historical_update_complete: true })).toEqual({ itemId: ITEM, initialUpdateComplete: true, historicalUpdateComplete: true });
    expect(plaidSyncPrompt(JSON.parse(body), "item_test_other")).toBeNull();
    expect(plaidSyncPrompt({ ...JSON.parse(body), webhook_code: "DEFAULT_UPDATE" })).toBeNull();
    expect(plaidSyncPrompt({ ...JSON.parse(body), webhook_type: "ITEM" })).toBeNull();
    expect(plaidSyncPrompt({ ...JSON.parse(body), item_id: "../x" })).toBeNull();
    expect(plaidSyncPrompt({ ...JSON.parse(body), item_id: 7 })).toBeNull();
    expect(plaidSyncPrompt(null)).toBeNull();
    expect(plaidSyncPrompt("x")).toBeNull();
  });

  it("treats a replayed delivery as a prompt to sync, which stores nothing twice", async () => {
    const { mock, check } = setup();
    const jwt = mock.signWebhook(body, { iat: NOW_S });
    const { memory, pipeline } = testPipeline();
    const results = [];
    for (let i = 0; i < 2; i++) {
      expect(await check(body, jwt)).toEqual({ ok: true });
      expect(plaidSyncPrompt(JSON.parse(body), ITEM)).not.toBeNull();
      results.push(await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG }));
    }
    expect(results[0]!.ingested).toBe(11);
    expect(results[1]!.ingested).toBe(0);
  });
});
