import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  loadRecordings,
  replayFetch,
  tamper,
  testPipeline,
  timestampedSignature,
  type Recording,
} from "@karatos/connector-testkit";
import {
  STRIPE_DEFAULT_API_VERSION,
  STRIPE_EVENT_RETENTION_SECONDS,
  STRIPE_EVENT_TYPES,
  StripeApiError,
  StripeConfigError,
  chargeEvent,
  customerEvent,
  fromUnix,
  parseStripeCursor,
  stripeClient,
  stripeConnector,
  stripeObjectEvents,
  stripePaymentMethod,
  stripeQuery,
  stripeWebhookEvents,
  verifyStripeWebhook,
  type StripeCharge,
  type StripeConnectorOptions,
  type StripeCursor,
  type StripeEvent,
} from "../src/index.js";

const recordings = await loadRecordings(fileURLToPath(new URL("./recordings/stripe-sync.json", import.meta.url)));
/** A key-shaped test value, assembled so no scanner mistakes the source for a leaked key. */
const fakeKey = (kind: "rk" | "sk", mode: "test" | "live") => [kind, mode, "0".repeat(24)].join("_");
const KEY = fakeKey("rk", "test");
const NOW = () => new Date("2026-01-10T00:00:00Z");
const NOW_UNIX = 1_768_003_200;
const FIVE_YEARS_BACK = 1_610_236_800;
const RECEIVED = "2026-01-10T00:00:00.000Z";
const API = "https://api.stripe.com";

const connector = (fetch: typeof globalThis.fetch, extra: Partial<StripeConnectorOptions> = {}) =>
  stripeConnector({ secretKey: KEY, fetch, now: NOW, sleep: async () => {}, ...extra });

/** The data of the recorded page for a path, by position. */
const recorded = <T>(i: number) => (recordings[i]!.response.body as { data: T[] }).data;
const firstCharge = () => structuredClone(recorded<StripeCharge>(0)[1]!);

const list = (data: unknown[], hasMore = false) => ({ object: "list", url: "/v1/x", has_more: hasMore, data });
const rec = (url: string, body: unknown, status = 200): Recording => ({ request: { method: "GET", url }, response: { status, body } });
const query = (path: string, params: Parameters<typeof stripeQuery>[0]) => `${API}${path}?${stripeQuery(params)}`;
const eventsQuery = (gte: number, startingAfter?: string) =>
  query("/v1/events", { limit: 100, created: { gte }, starting_after: startingAfter, types: STRIPE_EVENT_TYPES });
const balanceQuery = (gte: number) => query("/v1/balance_transactions", { limit: 100, created: { gte } });

const stripeEvent = (id: string, type: string, created: number, object: unknown): StripeEvent => ({ id, object: "event", type, created, data: { object: object as { object?: string } } });

describe("Stripe client", () => {
  it("accepts only read-only restricted keys, and checks the API version", () => {
    expect(() => stripeClient({ secretKey: fakeKey("sk", "live") })).toThrow("must be a restricted key (rk_)");
    expect(() => stripeClient({ secretKey: fakeKey("sk", "test") })).toThrow(StripeConfigError);
    expect(() => stripeClient({ secretKey: "rk_test_short" })).toThrow("starting rk_live_ or rk_test_");
    expect(() => stripeClient({ secretKey: "" })).toThrow(StripeConfigError);
    expect(() => stripeClient({ secretKey: KEY, apiVersion: "latest" })).toThrow("STRIPE_API_VERSION must look like 2026-09-30.endive");
    expect(() => stripeClient({ secretKey: ` ${KEY} `, apiVersion: "2026-08-26.dahlia" })).not.toThrow();
  });

  it("sends GET requests only, with the key in a header and the pinned version", async () => {
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), init });
      return new Response(JSON.stringify(list([])), { status: 200 });
    }) as typeof globalThis.fetch;
    await stripeClient({ secretKey: KEY, fetch }).list("/v1/charges", { limit: 100, created: { gte: 5 }, starting_after: "ch_1", types: ["a.b", "c.d"] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.init?.method).toBe("GET");
    expect(sent[0]!.init?.body).toBeUndefined();
    const headers = new Headers(sent[0]!.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("stripe-version")).toBe(STRIPE_DEFAULT_API_VERSION);
    const url = new URL(sent[0]!.url);
    expect(url.pathname).toBe("/v1/charges");
    expect(url.searchParams.get("created[gte]")).toBe("5");
    expect(url.searchParams.getAll("types[]")).toEqual(["a.b", "c.d"]);
    expect(url.searchParams.get("starting_after")).toBe("ch_1");
    expect(url.toString()).not.toContain(KEY);
    await expect(stripeClient({ secretKey: KEY, fetch }).list("/v1/charges/ch_1/refund", {})).rejects.toThrow("not a Stripe list endpoint");
  });

  it("backs off on 429 and gives up after its retries, leaving the error to runSync", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const limited = rec(`${API}/v1/charges?limit=1`, { error: { type: "invalid_request_error", code: "rate_limit", message: "Too many requests" } }, 429);
    const ok = rec(`${API}/v1/charges?limit=1`, list([{ id: "ch_1" }]));
    await expect(stripeClient({ secretKey: KEY, fetch: replayFetch([limited, limited, ok]), sleep }).list("/v1/charges", { limit: 1 })).resolves.toMatchObject({ data: [{ id: "ch_1" }] });
    expect(waits).toEqual([1000, 2000]);
    const stuck = stripeClient({ secretKey: KEY, fetch: replayFetch([limited, limited, limited]), sleep, rateLimitRetries: 2 });
    await expect(stuck.list("/v1/charges", { limit: 1 })).rejects.toMatchObject({ name: "StripeApiError", status: 429, code: "rate_limit" });
    expect(waits.slice(2)).toEqual([1000, 2000]);
  });

  it("reports errors with Stripe's code and never the key", async () => {
    const client = (r: Recording) => stripeClient({ secretKey: KEY, fetch: replayFetch([r]) });
    const denied = rec(`${API}/v1/payouts`, { error: { type: "invalid_request_error", code: "secret_key_required", message: "This key lacks the rak_payout_read permission." } }, 403);
    const error = await client(denied).list("/v1/payouts", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StripeApiError);
    expect(error).toMatchObject({ status: 403, code: "secret_key_required" });
    expect(String((error as Error).message)).toContain("rak_payout_read");
    expect(String((error as Error).message)).not.toContain(KEY);
    await expect(client(rec(`${API}/v1/payouts`, "oops", 500)).list("/v1/payouts", {})).rejects.toMatchObject({ status: 500, message: "Stripe answered HTTP 500" });
    await expect(client(rec(`${API}/v1/payouts`, { object: "charge" })).list("/v1/payouts", {})).rejects.toThrow("did not answer with a list");
  });
});

describe("Stripe normalization", () => {
  it("keeps a charge's money, method and links, and nothing personal", () => {
    const e = chargeEvent(firstCharge(), RECEIVED);
    expect(e).toMatchObject({
      type: "payment.charge_updated",
      occurredAt: "2026-01-05T08:00:00.000Z",
      idempotencyKey: "stripe:charge:ch_test_1003:succeeded:45000:20000:clear",
      payload: {
        chargeId: "stripe:charge:ch_test_1003",
        amountCents: 45000,
        capturedCents: 45000,
        refundedCents: 20000,
        currency: "usd",
        method: "card",
        cardBrand: "visa",
        customerId: "stripe:customer:cus_test_1",
        paymentIntentId: "stripe:payment_intent:pi_test_3",
        balanceTransactionId: "stripe:balance_transaction:txn_test_3",
      },
    });
    expect(JSON.stringify(e)).not.toMatch(/description|metadata|Synthetic test charge/);
  });

  it("stores a charge again only when its money changes", () => {
    const charge = firstCharge();
    const before = chargeEvent(charge, RECEIVED).idempotencyKey;
    expect(chargeEvent({ ...charge }, "2026-02-01T00:00:00.000Z").idempotencyKey).toBe(before);
    expect(chargeEvent({ ...charge, amount_refunded: 45000, refunded: true }, RECEIVED).idempotencyKey).not.toBe(before);
    expect(chargeEvent({ ...charge, disputed: true }, RECEIVED).idempotencyKey).not.toBe(before);
    expect(chargeEvent({ ...charge, status: "failed" }, RECEIVED).idempotencyKey).not.toBe(before);
  });

  it("maps Stripe payment method types to the sales department's methods", () => {
    expect(["card", "card_present", "link", "affirm", "klarna", "us_bank_account", undefined].map(stripePaymentMethod)).toEqual([
      "card", "card", "card", "financing", "financing", "other", "other",
    ]);
  });

  it("dead-letters a record with no usable timestamp instead of inventing one", () => {
    expect([1767500000, 0, -5, 1.5, "1767500000", null].map(fromUnix)).toEqual(["2026-01-04T04:13:20.000Z", undefined, undefined, undefined, undefined, undefined]);
    expect(chargeEvent({ ...firstCharge(), created: 0 }, RECEIVED).occurredAt).toBeUndefined();
  });

  it("names customers without a name, skips deleted ones, and keeps names out of keys", () => {
    expect(customerEvent({ id: "cus_9", object: "customer", name: "  ", created: 1767300000 }, RECEIVED)?.payload).toEqual({
      customerId: "stripe:customer:cus_9",
      name: "Stripe customer cus_9",
      marketingConsent: false,
    });
    expect(customerEvent({ id: "cus_9", object: "customer", name: "A", created: 1, deleted: true }, RECEIVED)).toBeNull();
    const named = customerEvent({ id: "cus_9", object: "customer", name: "Test Customer One", created: 1767300000 }, RECEIVED)!;
    const renamed = customerEvent({ id: "cus_9", object: "customer", name: "Test Customer Two", created: 1767300000 }, RECEIVED)!;
    expect(named.idempotencyKey).not.toBe(renamed.idempotencyKey);
    expect(named.idempotencyKey + named.id).not.toMatch(/Test|Customer/);
  });

  it("gives no events for objects it doesn't read", () => {
    expect(stripeObjectEvents({ object: "invoice" }, RECEIVED)).toEqual([]);
    expect(stripeObjectEvents(undefined, RECEIVED)).toEqual([]);
  });

  it("uses synthetic fixtures only", () => {
    expect(() => assertSynthetic(recordings)).not.toThrow();
  });
});

describe("Stripe sync", () => {
  it("imports, replays, resumes and retries the recorded account", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(replayFetch(recordings, { reuse: true })), expected: { ingested: 11, deadLettered: 1 } });
    expect(result.full.batches).toBe(7);
    expect(result.replay.duplicates).toBe(11);
    expect(parseStripeCursor(result.full.cursor)).toEqual({ pass: "historical", stream: "done", startingAfter: null, since: FIVE_YEARS_BACK, eventsFrom: NOW_UNIX, balanceFrom: NOW_UNIX });
  });

  it("lists each object type five years back, paging with starting_after", async () => {
    const fetch = replayFetch(recordings);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(fetch), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(fetch.unused()).toEqual([]);
    expect(fetch.calls.map((c) => [new URL(c.url).pathname, new URL(c.url).searchParams.get("created[gte]"), new URL(c.url).searchParams.get("starting_after")])).toEqual([
      ["/v1/charges", String(FIVE_YEARS_BACK), null],
      ["/v1/charges", String(FIVE_YEARS_BACK), "ch_test_1003"],
      ["/v1/refunds", String(FIVE_YEARS_BACK), null],
      ["/v1/disputes", String(FIVE_YEARS_BACK), null],
      ["/v1/payouts", String(FIVE_YEARS_BACK), null],
      ["/v1/balance_transactions", String(FIVE_YEARS_BACK), null],
      ["/v1/customers", String(FIVE_YEARS_BACK), null],
    ]);
    expect(fetch.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(replayFetch(recordings)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // Only the charge with no created time is dead-lettered; the clienteling profiles validate.
    expect(report).toMatchObject({ ingested: 11, deadLettered: 1 });
    const types = memory.events.map((e) => e.type).sort();
    expect(types).toEqual([
      "balance.transaction_recorded", "balance.transaction_recorded", "balance.transaction_recorded",
      "customer.profile_updated", "customer.profile_updated",
      "payment.charge_updated", "payment.charge_updated", "payment.charge_updated",
      "payment.dispute_updated", "payment.refund_updated", "payout.updated",
    ]);
  });

  it("leaves a finished import finished", async () => {
    const done: StripeCursor = { pass: "historical", stream: "done", startingAfter: null, since: FIVE_YEARS_BACK, eventsFrom: NOW_UNIX, balanceFrom: NOW_UNIX };
    const batches = [];
    for await (const b of connector(replayFetch([])).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })) batches.push(b);
    expect(batches).toEqual([]);
  });

  it("reads Stripe's events from where the last pass got to, then new balance transactions", async () => {
    const after: StripeCursor = { pass: "incremental", stream: "done", startingAfter: null, since: NOW_UNIX - 9_000, eventsFrom: NOW_UNIX - 7_200, balanceFrom: NOW_UNIX - 3_600 };
    const refunded = { ...firstCharge(), amount_refunded: 45000, refunded: true };
    const fetch = replayFetch([
      rec(eventsQuery(NOW_UNIX - 7_200), list([stripeEvent("evt_2", "charge.refunded", NOW_UNIX - 60, refunded), stripeEvent("evt_1", "invoice.paid", NOW_UNIX - 120, { object: "invoice" })], true)),
      rec(eventsQuery(NOW_UNIX - 7_200, "evt_1"), list([stripeEvent("evt_0", "customer.created", NOW_UNIX - 600, { id: "cus_new", object: "customer", name: null, created: NOW_UNIX - 600 })])),
      rec(balanceQuery(NOW_UNIX - 3_600), list([{ id: "txn_new", object: "balance_transaction", amount: -45000, fee: 0, net: -45000, currency: "usd", created: NOW_UNIX - 50, available_on: NOW_UNIX - 50, type: "refund", reporting_category: "refund", source: "re_new" }])),
    ]);
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "stripe", "incremental", JSON.stringify(after));
    const report = await runSync({ connector: connector(fetch), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(fetch.unused()).toEqual([]);
    expect(report).toMatchObject({ ingested: 3, deadLettered: 0, batches: 3 });
    // The next pass starts at the newest event and balance transaction this one saw.
    expect(parseStripeCursor(report.cursor)).toMatchObject({ pass: "incremental", stream: "done", eventsFrom: NOW_UNIX - 60, balanceFrom: NOW_UNIX - 50 });
    const keys = memory.events.map((e) => e.idempotencyKey);
    expect(keys).toContain("stripe:charge:ch_test_1003:succeeded:45000:45000:clear");
  });

  it("looks back 48 hours with no checkpoint, and never further than Stripe keeps events", async () => {
    const first = replayFetch([rec(eventsQuery(NOW_UNIX - 48 * 3_600), list([])), rec(balanceQuery(NOW_UNIX - 48 * 3_600), list([]))]);
    let { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(first), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(first.unused()).toEqual([]);

    const stale: StripeCursor = { pass: "incremental", stream: "done", startingAfter: null, since: 1, eventsFrom: NOW_UNIX - 90 * 86_400, balanceFrom: NOW_UNIX - 90 * 86_400 };
    const clamped = replayFetch([rec(eventsQuery(NOW_UNIX - STRIPE_EVENT_RETENTION_SECONDS), list([])), rec(balanceQuery(NOW_UNIX - 90 * 86_400), list([]))]);
    ({ memory, pipeline } = testPipeline());
    await memory.saveCheckpoint(TEST_ORG, "stripe", "incremental", JSON.stringify(stale));
    await runSync({ connector: connector(clamped), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(clamped.unused()).toEqual([]);
  });

  it("resumes an interrupted incremental pass at the page it stopped on", async () => {
    const midway: StripeCursor = { pass: "incremental", stream: "events", startingAfter: "evt_9", since: NOW_UNIX - 7_200, eventsFrom: NOW_UNIX - 30, balanceFrom: NOW_UNIX - 3_600 };
    const fetch = replayFetch([rec(eventsQuery(NOW_UNIX - 7_200, "evt_9"), list([])), rec(balanceQuery(NOW_UNIX - 3_600), list([]))]);
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "stripe", "incremental", JSON.stringify(midway));
    const report = await runSync({ connector: connector(fetch), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(fetch.unused()).toEqual([]);
    // The newest event seen before the interruption still moves the next pass forward.
    expect(parseStripeCursor(report.cursor)).toMatchObject({ eventsFrom: NOW_UNIX - 30, stream: "done" });
  });

  it("rejects a checkpoint it didn't write", () => {
    expect(parseStripeCursor(null)).toBeNull();
    expect(() => parseStripeCursor(JSON.stringify({ pass: "historical", stream: "invoices", since: 1, eventsFrom: 1, balanceFrom: 1 }))).toThrow("expected shape");
    expect(() => parseStripeCursor(JSON.stringify({ pass: "historical", stream: "charges", since: "1", eventsFrom: 1, balanceFrom: 1 }))).toThrow("expected shape");
    expect(() => parseStripeCursor(JSON.stringify({ pass: "weekly", stream: "charges", since: 1, eventsFrom: 1, balanceFrom: 1 }))).toThrow("expected shape");
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const audit = await assertWritesRefused(connector(replayFetch([])));
    expect(audit.map((a) => [a.action, a.outcome])).toEqual([
      ["create_payment_link", "refused"],
      ["create_refund", "refused"],
    ]);
  });
});

describe("Stripe webhooks", () => {
  const SECRET = "whsec_test_signing_secret";
  const body = JSON.stringify(stripeEvent("evt_test_1", "charge.refunded", NOW_UNIX, { ...firstCharge(), amount_refunded: 45000, refunded: true }));

  it("accepts a fresh, correctly signed delivery and rejects tampered, unsigned, wrongly keyed or malformed ones", () => {
    const header = timestampedSignature(SECRET, body, NOW_UNIX);
    expect(verifyStripeWebhook(SECRET, body, header, NOW_UNIX + 10)).toEqual({ ok: true });
    expect(verifyStripeWebhook(SECRET, Buffer.from(body), header, NOW_UNIX)).toEqual({ ok: true });
    expect(verifyStripeWebhook(SECRET, tamper(body), header, NOW_UNIX)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyStripeWebhook("whsec_other", body, header, NOW_UNIX)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyStripeWebhook(SECRET, body, undefined, NOW_UNIX)).toEqual({ ok: false, reason: "missing" });
    expect(verifyStripeWebhook("", body, header, NOW_UNIX)).toEqual({ ok: false, reason: "missing" });
    expect(verifyStripeWebhook(SECRET, body, "v1=abc", NOW_UNIX)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyStripeWebhook(SECRET, body, `t=${NOW_UNIX}`, NOW_UNIX)).toEqual({ ok: false, reason: "malformed" });
    // A signature for a different timestamp doesn't verify.
    const moved = header.replace(`t=${NOW_UNIX}`, `t=${NOW_UNIX + 1}`);
    expect(verifyStripeWebhook(SECRET, body, moved, NOW_UNIX)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("accepts any one valid signature when Stripe sends several, as it does while a secret rolls", () => {
    const valid = timestampedSignature(SECRET, body, NOW_UNIX);
    const old = timestampedSignature("whsec_old", body, NOW_UNIX).split(",")[1];
    expect(verifyStripeWebhook(SECRET, body, `${valid},${old}`, NOW_UNIX)).toEqual({ ok: true });
    // The valid one may come second.
    expect(verifyStripeWebhook(SECRET, body, `t=${NOW_UNIX},${old},${valid.split(",")[1]}`, NOW_UNIX)).toEqual({ ok: true });
    expect(verifyStripeWebhook(SECRET, body, `t=${NOW_UNIX},${old}`, NOW_UNIX)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a replayed delivery once its signature is older than five minutes", () => {
    const header = timestampedSignature(SECRET, body, NOW_UNIX);
    expect(verifyStripeWebhook(SECRET, body, header, NOW_UNIX + 300)).toEqual({ ok: true });
    expect(verifyStripeWebhook(SECRET, body, header, NOW_UNIX + 301)).toEqual({ ok: false, reason: "expired" });
    expect(verifyStripeWebhook(SECRET, body, header, NOW_UNIX - 301)).toEqual({ ok: false, reason: "expired" });
  });

  it("stores a delivered change once, however often it is delivered, and the same as the events API would", async () => {
    const event = JSON.parse(body) as StripeEvent;
    const hook = connector(replayFetch([])).handleWebhook!(event);
    expect(hook).toEqual(stripeWebhookEvents(event, RECEIVED));
    const { memory, pipeline } = testPipeline();
    const ingest = async () => {
      for (const raw of hook) await pipeline.ingest({ ...(raw as object), organizationId: TEST_ORG, source: "stripe" } as never).catch(() => undefined);
    };
    await ingest();
    await ingest();
    expect(memory.events.length).toBe(1);
  });

  it("ignores event types it doesn't read and anything that isn't an event", () => {
    expect(stripeWebhookEvents(stripeEvent("evt_x", "invoice.paid", NOW_UNIX, { object: "invoice" }), RECEIVED)).toEqual([]);
    expect(stripeWebhookEvents(stripeEvent("evt_x", "customer.deleted", NOW_UNIX, { id: "cus_1", object: "customer", deleted: true, created: 1 }), RECEIVED)).toEqual([]);
    expect(stripeWebhookEvents({ ...stripeEvent("evt_x", "charge.updated", NOW_UNIX, firstCharge()), object: "charge" as "event" }, RECEIVED)).toEqual([]);
    expect(STRIPE_EVENT_TYPES.length).toBeLessThanOrEqual(20);
  });
});
