import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainPipeline, InMemoryStore, runSync, VerifyLimitError, WriteGate, type Connector, type StoredEvent, type VerifyPeriod } from "@karatos/core";
import { loadRecordings, replayFetch, type Recording } from "@karatos/connector-testkit";
import { ShopifyApiError, shopifyConnector, stripeConnector } from "@karatos/connectors";
import { combineDepartments, RETAIL_DEPARTMENTS, verifyPeriod, VERIFY_MAX_DAYS, VERIFY_MAX_SYNCED_EVENTS } from "@karatos/retail";
import {
  createBrainApp,
  createVerifier,
  describeVerifyError,
  StaticDocumentationSource,
  SUPPORT_KEY_REFUSAL,
  VERIFIABLE_SYSTEMS,
  VERIFY_MAX_TOLERANCE_CENTS,
  VerifyBusyError,
  type ScheduledConnector,
  type VerifierOptions,
  type VerifyReport,
} from "../src/index.js";

const ORG = "example-jewelers";
const TZ = "America/New_York";
const NOW = new Date("2026-01-20T15:00:00Z");
const newKey = (prefix: string) => `${prefix}${randomBytes(32).toString("hex")}`;
const INSTANCE_KEY = newKey("i");
const SUPPORT_KEY = newKey("s");

const shopifyRecordings = await loadRecordings(fileURLToPath(new URL("../../connectors/test/recordings/shopify-sync.json", import.meta.url)));
const stripeRecordings = await loadRecordings(fileURLToPath(new URL("../../connectors/test/recordings/stripe-sync.json", import.meta.url)));

/** Recorded Shopify pages for the sync's queries and the verify query, by operation and cursor. */
const SHOPIFY_PAGES: Record<string, Recording> = {
  "Orders:": shopifyRecordings[0]!,
  "Orders:eyJsYXN0X2lkIjoxMDAyfQ": shopifyRecordings[1]!,
  "Products:": shopifyRecordings[2]!,
  "Customers:": shopifyRecordings[3]!,
  "VerifyOrders:": shopifyRecordings[0]!,
  "VerifyOrders:eyJsYXN0X2lkIjoxMDAyfQ": shopifyRecordings[1]!,
};
const shopifyFetch: typeof globalThis.fetch = async (_input, init) => {
  const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { after: string | null } };
  if (/^\s*mutation\b/.test(query)) throw new Error("a write was sent");
  const page = SHOPIFY_PAGES[`${query.match(/^query (\w+)/)![1]}:${variables.after ?? ""}`]!;
  return Response.json(page.response.body);
};
const shopify = () => shopifyConnector({ shopDomain: "example-store.myshopify.com", accessToken: "shpat_test_not_a_real_token", fetch: shopifyFetch, now: () => new Date("2026-01-10T00:00:00Z"), sleep: async () => {} });

const STRIPE_KEY = ["rk", "test", "0".repeat(24)].join("_");
const stripePeriod = verifyPeriod("2026-01-03", "2026-01-06", TZ);
const stripeVerifyUrl = (p: VerifyPeriod, after?: string) =>
  `https://api.stripe.com/v1/charges?created[gte]=${Date.parse(p.from) / 1000}&created[lt]=${Date.parse(p.to) / 1000}&limit=100${after ? `&starting_after=${after}` : ""}`;
const stripeFetch = () =>
  replayFetch(
    [
      ...stripeRecordings,
      { request: { method: "GET", url: stripeVerifyUrl(stripePeriod) }, response: stripeRecordings[0]!.response },
      { request: { method: "GET", url: stripeVerifyUrl(stripePeriod, "ch_test_1003") }, response: stripeRecordings[1]!.response },
      // No charge was made on January 2nd.
      { request: { method: "GET", url: stripeVerifyUrl(verifyPeriod("2026-01-02", "2026-01-02", TZ)) }, response: { status: 200, body: { object: "list", has_more: false, data: [] } } },
    ],
    { reuse: true },
  );
const stripe = (fetch = stripeFetch()) => stripeConnector({ secretKey: STRIPE_KEY, fetch, now: () => new Date("2026-01-10T00:00:00Z"), sleep: async () => {} });

/** An instance with every retail department that has synced the recorded Shopify and Stripe data. */
async function synced() {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: new StaticDocumentationSource([]), now: () => NOW });
  for (const connector of [shopify(), stripe()]) await runSync({ connector, mode: "historical", pipeline, memory, organizationId: ORG, sleep: async () => {} });
  return { memory, pipeline };
}

const scheduled = (id: string, make: () => Promise<Connector> | Connector): ScheduledConnector => ({ id, make: async () => make() });
const verifier = (memory: InMemoryStore, extra: Partial<VerifierOptions> = {}) =>
  createVerifier({ memory, organizationId: ORG, connectors: [scheduled("shopify", shopify), scheduled("stripe", () => stripe())], skipped: [], now: () => NOW, ...extra });
const fake = (source: string, extra: Partial<Connector> = {}): Connector => ({
  source,
  historicalImport: async function* () {},
  incrementalSync: async function* () {},
  ...extra,
});
const shopifyDay = verifyPeriod("2026-01-02", "2026-01-02", TZ);
const sys = (report: VerifyReport, id: string) => report.systems.find((s) => s.system === id)!;

describe("the verifier", () => {
  it("matches what Shopify and Stripe report against what synced from their recorded responses", async () => {
    const { memory } = await synced();
    const v = verifier(memory);
    const shop = await v.run(shopifyDay, { system: "shopify" });
    expect(shop.summary).toEqual({ match: 1, mismatch: 0, unavailable: 0 });
    expect(shop.period).toEqual(shopifyDay);
    expect(shop.generatedAt).toBe(NOW.toISOString());
    expect(sys(shop, "shopify")).toMatchObject({ status: "match", period: shopifyDay });
    expect(sys(shop, "shopify").metrics.map((m) => [m.metric, m.status, m.sourceTotal, m.syncedTotal, m.difference])).toEqual([
      ["sale_count", "match", 3, 3, 0],
      ["gross_sales", "match", 393_000, 393_000, 0],
    ]);
    expect(sys(shop, "shopify").basis!.source).toContain("Shopify orders processed in the period");
    expect(sys(shop, "shopify").basis!.synced).toContain("daily brief");
    expect(sys(shop, "shopify")).not.toHaveProperty("uncountedEvents");

    const pay = await v.run(stripePeriod, { system: "stripe" });
    expect(sys(pay, "stripe").metrics.map((m) => [m.metric, m.status, m.sourceTotal, m.syncedTotal])).toEqual([
      ["charge_count", "match", 3, 3],
      ["charge_gross", "match", 268_000, 268_000],
    ]);
  });

  it("names the sales missing from the instance and those it has extra", async () => {
    const { memory } = await synced();
    const lost = memory.events.findIndex((e) => e.type === "sale.completed" && e.payload.saleId === "shopify:order:1003");
    expect(lost).toBeGreaterThanOrEqual(0);
    memory.events.splice(lost, 1);
    const like = memory.events.find((e) => e.type === "sale.completed")!;
    await memory.appendEvent({ ...like, id: "shopify_sale_9999", idempotencyKey: "shopify:sale:9999", payload: { saleId: "shopify:order:9999", totalCents: 1_000 } });
    const report = await verifier(memory).run(shopifyDay, { system: "shopify" });
    const [count, gross] = sys(report, "shopify").metrics;
    expect(count).toMatchObject({ status: "mismatch", sourceTotal: 3, syncedTotal: 3, difference: 0, missing: { count: 1, sample: ["shopify:order:1003"] }, extra: { count: 1, sample: ["shopify:order:9999"] } });
    expect(gross).toMatchObject({ status: "mismatch", difference: 1_000 - 8_000 });
    expect(report.summary).toEqual({ match: 0, mismatch: 1, unavailable: 0 });
  });

  it("says the synced side is a floor when retention cleared some of it", async () => {
    const { memory } = await synced();
    const e = memory.events.find((x) => x.type === "sale.completed")!;
    Object.assign(e, { payload: { cleared: true }, payloadClearedAt: "2026-01-15T00:00:00.000Z" });
    const report = await verifier(memory).run(shopifyDay, { system: "shopify" });
    expect(sys(report, "shopify")).toMatchObject({ status: "mismatch", uncountedEvents: 1 });
  });

  it("checks every system it knows when none is named, saying why each one it can't check is unavailable", async () => {
    const { memory } = await synced();
    const report = await verifier(memory, { skipped: [{ id: "square", reason: "missing CUSTOMER_REF_KEY" }] }).run(shopifyDay);
    expect(report.systems.map((s) => [s.system, s.status])).toEqual([
      ["shopify", "match"],
      ["square", "unavailable"],
      ["stripe", "match"],
      ["klaviyo", "unavailable"],
    ]);
    expect(Object.keys(VERIFIABLE_SYSTEMS)).toEqual(["shopify", "square", "stripe", "klaviyo"]);
    expect(sys(report, "square").reason).toBe("square is turned on but not syncing (missing CUSTOMER_REF_KEY)");
    expect(sys(report, "klaviyo").reason).toBe("klaviyo isn't turned on for this instance");
    expect(sys(report, "klaviyo").metrics).toEqual([expect.objectContaining({ metric: "profile_count", status: "unavailable", sourceTotal: null, reason: "klaviyo isn't turned on for this instance" })]);
    expect(report.summary).toEqual({ match: 2, mismatch: 0, unavailable: 2 });
  });

  it("is unavailable for a system it can't verify, a connector without verify support and one that reports the wrong thing", async () => {
    const memory = new InMemoryStore();
    const v = createVerifier({
      memory,
      organizationId: ORG,
      skipped: [],
      connectors: [scheduled("gia", () => fake("gia")), scheduled("shopify", () => fake("shopify")), scheduled("stripe", () => fake("stripe", { verify: async () => [{ subject: "sales", records: [], basis: "x" }] }))],
    });
    // A name that only an object's own prototype has is not a system either.
    expect(sys(await v.run(shopifyDay, { system: "constructor" }), "constructor")).toMatchObject({ status: "unavailable", metrics: [], reason: "KaratOS can't verify constructor yet" });
    expect(sys(await v.run(shopifyDay, { system: "gia" }), "gia")).toEqual({ system: "gia", status: "unavailable", period: shopifyDay, metrics: [], reason: "KaratOS can't verify gia yet" });
    expect(sys(await v.run(shopifyDay, { system: "shopify" }), "shopify")).toMatchObject({ status: "unavailable", reason: "the shopify connector has no verify support" });
    const wrong = sys(await v.run(shopifyDay, { system: "stripe" }), "stripe");
    expect(wrong.status).toBe("unavailable");
    expect(wrong.metrics.map((m) => m.reason)).toEqual(["the stripe connector didn't report charges", "the stripe connector didn't report charges"]);
    expect(wrong).not.toHaveProperty("basis");
  });

  it("reports a failing source by its error class and status only, never what the vendor said", async () => {
    const memory = new InMemoryStore();
    const leaky = new ShopifyApiError("Shopify answered HTTP 403: Test Customer 1 <customer1@example.test>", 403);
    const v = createVerifier({
      memory,
      organizationId: ORG,
      skipped: [],
      connectors: [
        scheduled("shopify", () => fake("shopify", { verify: () => Promise.reject(leaky) })),
        scheduled("stripe", () => Promise.reject(new TypeError("bad settings for Test Customer 1"))),
        scheduled("square", () => fake("square", { verify: () => Promise.reject(new VerifyLimitError("Square has more than 50000 records in the period; verify a shorter period")) })),
      ],
    });
    const report = await v.run(shopifyDay);
    expect(sys(report, "shopify").reason).toBe("the source system couldn't be read (ShopifyApiError, HTTP 403)");
    expect(sys(report, "stripe").reason).toBe("the source system couldn't be read (TypeError)");
    expect(sys(report, "square").reason).toBe("Square has more than 50000 records in the period; verify a shorter period");
    expect(JSON.stringify(report)).not.toMatch(/Test Customer|example\.test/);
    expect(describeVerifyError("a string")).toBe("the source system couldn't be read");
  });

  it("is unavailable rather than guessing when too many events synced", async () => {
    const memory = new InMemoryStore();
    const one = { source: "shopify", type: "sale.completed" } as StoredEvent;
    vi.spyOn(memory, "eventsBetween").mockResolvedValue(Array.from({ length: VERIFY_MAX_SYNCED_EVENTS + 1 }, () => one));
    const v = createVerifier({ memory, organizationId: ORG, skipped: [], connectors: [scheduled("shopify", () => fake("shopify", { verify: async () => [{ subject: "sales", records: [], basis: "x" }] }))] });
    const report = await v.run(shopifyDay, { system: "shopify" });
    expect(sys(report, "shopify").metrics.map((m) => m.reason)).toEqual([`more than ${VERIFY_MAX_SYNCED_EVENTS} synced events in the period; verify a shorter period`, `more than ${VERIFY_MAX_SYNCED_EVENTS} synced events in the period; verify a shorter period`]);
  });

  it("reads profile events from the period's start through now, and sales and charges in the period only", async () => {
    const memory = new InMemoryStore();
    const spy = vi.spyOn(memory, "eventsBetween");
    const none = async () => [];
    const v = createVerifier({
      memory,
      organizationId: ORG,
      skipped: [],
      now: () => NOW,
      connectors: [
        scheduled("klaviyo", () => fake("klaviyo", { verify: async () => [{ subject: "profiles", records: [{ ref: "klaviyo_profile:a" }], basis: "x" }] })),
        scheduled("square", () => fake("square", { verify: none })),
      ],
    });
    const report = await v.run(shopifyDay);
    expect(spy.mock.calls.map((c) => c.slice(1))).toEqual([[["customer.profile_updated"], shopifyDay.from, "2026-01-20T15:00:01.000Z", VERIFY_MAX_SYNCED_EVENTS + 1]]);
    expect(sys(report, "klaviyo").metrics[0]).toMatchObject({ metric: "profile_count", status: "mismatch", sourceTotal: 1, syncedTotal: 0, missing: { sample: ["klaviyo_profile:a"] } });
    expect(sys(report, "square").metrics.map((m) => m.reason)).toEqual(["the square connector didn't report sales", "the square connector didn't report sales"]);
    // A period ending after now still reads through its end.
    spy.mockClear();
    const late = createVerifier({ memory, organizationId: ORG, skipped: [], now: () => new Date("2026-01-01T00:00:00Z"), connectors: [scheduled("klaviyo", () => fake("klaviyo", { verify: async () => [{ subject: "profiles", records: [], basis: "x" }] }))] });
    await late.run(shopifyDay, { system: "klaviyo" });
    expect(spy.mock.calls[0]![3]).toBe(new Date(Date.parse(shopifyDay.to) + 1000).toISOString());
  });

  it("applies a money tolerance when one is given", async () => {
    const memory = new InMemoryStore();
    const v = createVerifier({ memory, organizationId: ORG, skipped: [], connectors: [scheduled("stripe", () => fake("stripe", { verify: async () => [{ subject: "charges", records: [], basis: "x" }] }))] });
    const report = await v.run(shopifyDay, { system: "stripe", toleranceCents: 5 });
    expect(sys(report, "stripe").metrics[1]).toMatchObject({ metric: "charge_gross", toleranceCents: 5 });
  });

  it("runs one verification at a time and turns a second away while one runs", async () => {
    const memory = new InMemoryStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const v = createVerifier({ memory, organizationId: ORG, skipped: [], connectors: [scheduled("shopify", () => fake("shopify", { verify: async () => (await gate, [{ subject: "sales", records: [], basis: "x" }]) }))] });
    expect(v.running()).toBe(false);
    const first = v.run(shopifyDay, { system: "shopify" });
    expect(v.running()).toBe(true);
    await expect(v.run(shopifyDay, { system: "shopify" })).rejects.toThrow(VerifyBusyError);
    release();
    await first;
    expect(v.running()).toBe(false);
    expect((await v.run(shopifyDay, { system: "shopify" })).summary.match).toBe(1);
    // A run that fails still frees the next one.
    const broken = createVerifier({ memory: { eventsBetween: () => Promise.reject(new Error("store down")) } as unknown as InMemoryStore, organizationId: ORG, skipped: [], connectors: [scheduled("stripe", () => fake("stripe", { verify: async () => [{ subject: "charges", records: [], basis: "x" }] }))] });
    await expect(broken.run(shopifyDay, { system: "stripe" })).rejects.toThrow("store down");
    expect(broken.running()).toBe(false);
  });

  it("never goes near the write gate and sends nothing but reads", async () => {
    const { memory } = await synced();
    const spies = [vi.spyOn(WriteGate.prototype, "run"), vi.spyOn(WriteGate.prototype, "record"), vi.spyOn(WriteGate.prototype, "allows")];
    const methods: string[] = [];
    const watched = stripeFetch();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      methods.push(init?.method ?? "GET");
      return watched(input as string, init);
    };
    const before = memory.events.length;
    await createVerifier({ memory, organizationId: ORG, skipped: [], connectors: [scheduled("shopify", shopify), scheduled("stripe", () => stripe(fetch as never))] }).run(stripePeriod);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(methods).toEqual(["GET", "GET"]);
    // Nothing was stored either.
    expect(memory.events.length).toBe(before);
    for (const spy of spies) spy.mockRestore();
  });

  it("puts no customer names, emails, phone numbers or payloads in the report", async () => {
    const { memory } = await synced();
    const report = await verifier(memory).run(shopifyDay);
    const text = JSON.stringify(report);
    expect(memory.events.some((e) => JSON.stringify(e.payload).includes("Test Customer"))).toBe(true);
    expect(text).not.toMatch(/Test Customer|@|555[- ]?01|payload|lines|customerId|displayName/i);
    // Only the fields the report is made of.
    for (const s of report.systems) {
      for (const key of Object.keys(s)) expect(["system", "status", "period", "metrics", "basis", "uncountedEvents", "reason"]).toContain(key);
      for (const m of s.metrics) {
        for (const key of Object.keys(m)) expect(["metric", "unit", "status", "sourceTotal", "syncedTotal", "difference", "toleranceCents", "missing", "extra", "amountDiffers", "reason"]).toContain(key);
        for (const id of [...m.missing.sample, ...m.extra.sample]) expect(id).toMatch(/^[a-z_]+:[a-z_]+:[A-Za-z0-9_]+$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// POST /v1/verify

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function start(options: { verify?: ReturnType<typeof createVerifier>; timeZone?: string; now?: Date } = {}) {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: new StaticDocumentationSource([]) });
  server = createServer(
    createBrainApp({
      pipeline,
      memory,
      organizationId: ORG,
      apiKey: INSTANCE_KEY,
      supportApiKey: SUPPORT_KEY,
      brief: { timeZone: options.timeZone ?? TZ, now: () => options.now ?? NOW },
      ...(options.verify ? { verify: options.verify } : {}),
    }),
  );
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return async (body: unknown, auth: string | false = INSTANCE_KEY) => {
    const res = await fetch(`${base}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
}

const quiet = (memory = new InMemoryStore()) =>
  createVerifier({ memory, organizationId: ORG, skipped: [], connectors: [scheduled("shopify", () => fake("shopify", { verify: async () => [{ subject: "sales", records: [], basis: "x" }] }))] });

describe("POST /v1/verify", () => {
  it("answers the instance key with the verification, and nobody else", async () => {
    const call = await start({ verify: quiet() });
    const ok = await call({ system: "shopify", from: "2026-01-02", to: "2026-01-02" });
    expect(ok.status).toBe(200);
    const verification = ok.body.verification as VerifyReport;
    expect(verification.period).toEqual(shopifyDay);
    expect(verification.summary).toEqual({ match: 1, mismatch: 0, unavailable: 0 });
    expect(await call({ from: "2026-01-02", to: "2026-01-02" }, SUPPORT_KEY)).toEqual({ status: 403, body: { error: SUPPORT_KEY_REFUSAL } });
    expect((await call({ from: "2026-01-02", to: "2026-01-02" }, false)).status).toBe(401);
    expect((await call({ from: "2026-01-02", to: "2026-01-02" }, newKey("i"))).status).toBe(401);
  });

  it("reads days on the store's own calendar", async () => {
    const call = await start({ verify: quiet(), timeZone: "UTC" });
    const ok = await call({ from: "2026-01-02", to: "2026-01-03" });
    expect((ok.body.verification as VerifyReport).period).toEqual({ startDay: "2026-01-02", endDay: "2026-01-03", timeZone: "UTC", from: "2026-01-02T00:00:00.000Z", to: "2026-01-04T00:00:00.000Z" });
  });

  it("ends today at the store's midnight, not UTC's", async () => {
    // 9 pm on January 20th in New York, already the 21st in UTC.
    const call = await start({ verify: quiet(), now: new Date("2026-01-21T02:00:00Z") });
    expect((await call({ from: "2026-01-21", to: "2026-01-21" })).status).toBe(400);
    expect((await call({ from: "2026-01-20", to: "2026-01-20" })).status).toBe(200);
    expect(VERIFY_MAX_TOLERANCE_CENTS).toBe(100);
  });

  it("answers 503 when verification isn't set up", async () => {
    const call = await start();
    expect(await call({ from: "2026-01-02", to: "2026-01-02" })).toEqual({ status: 503, body: { error: "sync verification isn't set up on this instance" } });
  });

  it("says what is wrong with a request it can't run", async () => {
    const call = await start({ verify: quiet() });
    const bad = async (body: unknown) => {
      const res = await call(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      return res.body.error as string;
    };
    expect(await bad("not json")).toBe("request body must be JSON");
    expect(await bad([])).toContain("the body must be");
    expect(await bad({ to: "2026-01-02" })).toContain("the body must be");
    expect(await bad({ from: "2026-02-30", to: "2026-03-01" })).toContain("the body must be");
    expect(((await call({ from: "2026-02-30", to: "2026-03-01" })).body.details as { message: string }[])[0]!.message).toBe("from must be a day, such as 2026-11-01");
    expect(((await call({ from: "2026-01-01", to: "01/02/2026" })).body.details as { message: string }[])[0]!.message).toBe("to must be a day, such as 2026-11-15");
    expect(await bad({ from: "2026-01-02", to: "2026-01-02", extra: true })).toContain("the body must be");
    expect(await bad({ from: "2026-01-02", to: "2026-01-02", system: "Shopify" })).toContain("the body must be");
    expect(await bad({ from: "2026-01-02", to: "2026-01-02", toleranceCents: VERIFY_MAX_TOLERANCE_CENTS + 1 })).toContain("the body must be");
    expect(await bad({ from: "2026-01-02", to: "2026-01-02", toleranceCents: 1.5 })).toContain("the body must be");
    expect(await bad({ from: "2026-01-03", to: "2026-01-02" })).toBe("from must be on or before to; both days are included");
    // Today in New York is January 20th.
    expect(await bad({ from: "2026-01-20", to: "2026-01-21" })).toBe("to can't be after today in the store's time zone");
    expect(await bad({ from: "2025-10-01", to: "2026-01-01" })).toBe(`a verification covers at most ${VERIFY_MAX_DAYS} days`);
    expect(await bad({ from: "2026-01-02", to: "2026-01-02", system: "not_a_system" })).toBe("not_a_system isn't an integration KaratOS knows");
  });

  it("takes today, a period of exactly the longest length, and a tolerance up to a dollar", async () => {
    const call = await start({ verify: quiet() });
    expect((await call({ from: "2026-01-20", to: "2026-01-20" })).status).toBe(200);
    expect((await call({ from: "2025-10-21", to: "2026-01-20" })).status).toBe(200);
    expect((await call({ from: "2025-10-20", to: "2026-01-20" })).status).toBe(400);
    const tolerant = await call({ from: "2026-01-02", to: "2026-01-02", system: "shopify", toleranceCents: VERIFY_MAX_TOLERANCE_CENTS });
    expect(((tolerant.body.verification as VerifyReport).systems[0]!.metrics[1] as { toleranceCents: number }).toleranceCents).toBe(VERIFY_MAX_TOLERANCE_CENTS);
  });

  it("answers 429 while another verification runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const v = createVerifier({ memory: new InMemoryStore(), organizationId: ORG, skipped: [], connectors: [scheduled("shopify", () => fake("shopify", { verify: async () => (await gate, [{ subject: "sales", records: [], basis: "x" }]) }))] });
    const call = await start({ verify: v });
    const first = call({ from: "2026-01-02", to: "2026-01-02", system: "shopify" });
    await vi.waitFor(() => expect(v.running()).toBe(true));
    expect(await call({ from: "2026-01-02", to: "2026-01-02" })).toEqual({ status: 429, body: { error: "a sync verification is already running; try again once it finishes" } });
    release();
    expect((await first).status).toBe(200);
  });

  it("answers 500 without detail when the run itself fails", async () => {
    const broken = createVerifier({ memory: { eventsBetween: () => Promise.reject(new Error("store down")) } as unknown as InMemoryStore, organizationId: ORG, skipped: [], connectors: [scheduled("stripe", () => fake("stripe", { verify: async () => [{ subject: "charges", records: [], basis: "x" }] }))] });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const call = await start({ verify: broken });
    expect(await call({ from: "2026-01-02", to: "2026-01-02", system: "stripe" })).toEqual({ status: 500, body: { error: "internal error" } });
    error.mockRestore();
  });
});
