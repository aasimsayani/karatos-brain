import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERIFY_MAX_SOURCE_RECORDS, VerifyLimitError, inVerifyPeriod, type VerifyPeriod } from "@karatos/core";
import {
  klaviyoDocMock,
  klaviyoProfile,
  loadRecordings,
  replayFetch,
  squareDocMock,
  squareLocation,
  squareOrder,
  squareTestId,
  SQUARE_MOCK_READ_SCOPES,
  synthetic,
  type Recording,
} from "@karatos/connector-testkit";
import {
  KLAVIYO_PAGE_SIZES,
  KlaviyoConfigError,
  klaviyoClient,
  type KlaviyoClient,
  type SquareClient,
  SHOPIFY_VERIFY_PAGE_SIZE,
  SHOPIFY_VERIFY_QUERY,
  klaviyoConnector,
  klaviyoProfileRef,
  processedIn,
  shopifyConnector,
  squareConnector,
  stripeChargeCounts,
  stripeConnector,
} from "../src/index.js";

const shopifyRecordings = await loadRecordings(fileURLToPath(new URL("./recordings/shopify-sync.json", import.meta.url)));
const stripeRecordings = await loadRecordings(fileURLToPath(new URL("./recordings/stripe-sync.json", import.meta.url)));

const NOW = () => new Date("2026-01-20T00:00:00Z");
/** Store days in New York: local midnight is 05:00 UTC in January. */
const NY_JAN = (first: number, last: number): VerifyPeriod => ({ from: `2026-01-${String(first).padStart(2, "0")}T05:00:00.000Z`, to: `2026-01-${String(last + 1).padStart(2, "0")}T05:00:00.000Z` });

describe("the verify period", () => {
  it("includes its first instant and excludes its last", () => {
    const p = { from: "2026-01-02T05:00:00.000Z", to: "2026-01-03T05:00:00.000Z" };
    expect(inVerifyPeriod("2026-01-02T05:00:00Z", p)).toBe(true);
    expect(inVerifyPeriod("2026-01-03T04:59:59.999Z", p)).toBe(true);
    expect(inVerifyPeriod("2026-01-03T05:00:00Z", p)).toBe(false);
    expect(inVerifyPeriod("2026-01-02T04:59:59Z", p)).toBe(false);
    expect(inVerifyPeriod("not a time", p)).toBe(false);
    expect(inVerifyPeriod(null, p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shopify

interface Order {
  id: string;
  createdAt: string;
  processedAt: string | null;
  displayFinancialStatus: string | null;
  totalPriceSet: { shopMoney: { amount: string } } | null;
}
const order = (n: number, over: Partial<Order> = {}): Order => ({
  id: `gid://shopify/Order/${n}`,
  createdAt: "2026-01-02T15:00:00Z",
  processedAt: "2026-01-02T15:00:05Z",
  displayFinancialStatus: "PAID",
  totalPriceSet: { shopMoney: { amount: "100.00" } },
  ...over,
});

/** Answers the verify query a page at a time, keeping each request's query and variables. */
function shopifyPages(pages: unknown[][]) {
  const sent: { query: string; variables: Record<string, unknown>; method: string }[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: { after: string | null } & Record<string, unknown> };
    sent.push({ query: body.query, variables: body.variables, method: String(init?.method) });
    const index = body.variables.after === null ? 0 : Number(body.variables.after.slice(1));
    const more = index + 1 < pages.length;
    return Response.json({ data: { orders: { pageInfo: { hasNextPage: more, endCursor: more ? `p${index + 1}` : null }, nodes: pages[index] } } });
  };
  return { fetch, sent };
}
const shopify = (fetch: typeof globalThis.fetch) => shopifyConnector({ shopDomain: "example-store.myshopify.com", accessToken: "shpat_test_not_a_real_token", fetch, now: NOW, sleep: async () => {} });

describe("Shopify verify", () => {
  it("pages the recorded orders and counts the paid ones at their original total", async () => {
    // The recorded pages, answered by the cursor each one hands out, as Shopify pages them.
    const byCursor: Record<string, Recording> = { "": shopifyRecordings[0]!, eyJsYXN0X2lkIjoxMDAyfQ: shopifyRecordings[1]! };
    const sent: { query: string; variables: Record<string, unknown>; method: string }[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: { after: string | null } & Record<string, unknown> };
      sent.push({ query: body.query, variables: body.variables, method: String(init?.method) });
      return Response.json(byCursor[body.variables.after ?? ""]!.response.body);
    };
    const [sales] = await shopify(fetch).verify!(NY_JAN(2, 2));
    // 1001 partly refunded, 1003 and 1004 paid; 1002 is still pending, so it was never a sale.
    expect(sales).toMatchObject({
      subject: "sales",
      records: [
        { ref: "shopify:order:1001", cents: 145_000 },
        { ref: "shopify:order:1003", cents: 8_000 },
        { ref: "shopify:order:1004", cents: 240_000 },
      ],
    });
    expect(sales!.basis).toContain("original total");
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.variables.after)).toEqual([null, "eyJsYXN0X2lkIjoxMDAyfQ"]);
    for (const s of sent) {
      expect(s.method).toBe("POST");
      expect(s.query).toBe(SHOPIFY_VERIFY_QUERY);
      expect(s.query).toMatch(/^query VerifyOrders/);
      expect(s.query).not.toMatch(/mutation|customer|email|phone|lineItems/i);
      expect(s.variables).toMatchObject({ first: SHOPIFY_VERIFY_PAGE_SIZE, query: "processed_at:>='2026-01-02T05:00:00.000Z' processed_at:<'2026-01-03T05:00:00.000Z'" });
    }
  });

  it("counts refunded orders on their sale day and leaves out voided, unpaid and zero orders", async () => {
    const { fetch } = shopifyPages([
      [
        order(1, { displayFinancialStatus: "REFUNDED" }),
        order(2, { displayFinancialStatus: "PARTIALLY_PAID", totalPriceSet: { shopMoney: { amount: "12.34" } } }),
        order(3, { displayFinancialStatus: "VOIDED" }),
        order(4, { displayFinancialStatus: "AUTHORIZED" }),
        order(5, { totalPriceSet: { shopMoney: { amount: "0.00" } } }),
        order(6, { totalPriceSet: null }),
        order(7, { displayFinancialStatus: null }),
        order(8, { displayFinancialStatus: "PARTIALLY_REFUNDED", totalPriceSet: { shopMoney: { amount: "0.01" } } }),
      ],
    ]);
    const [sales] = await shopify(fetch).verify!(NY_JAN(2, 2));
    expect(sales!.records).toEqual([
      { ref: "shopify:order:1", cents: 10_000 },
      { ref: "shopify:order:2", cents: 1_234 },
      { ref: "shopify:order:8", cents: 1 },
    ]);
  });

  it("puts each order on its store day, by processed time or else creation time, at the period's exact edges", async () => {
    const { fetch } = shopifyPages([
      [
        order(1, { processedAt: "2026-01-02T05:00:00Z" }),
        order(2, { processedAt: "2026-01-03T04:59:59Z" }),
        order(3, { processedAt: "2026-01-03T05:00:00Z" }),
        order(4, { processedAt: "2026-01-02T04:59:59Z" }),
        order(5, { processedAt: null, createdAt: "2026-01-02T12:00:00Z" }),
        order(6, { processedAt: null, createdAt: "2026-01-01T12:00:00Z" }),
      ],
    ]);
    const [sales] = await shopify(fetch).verify!(NY_JAN(2, 2));
    expect(sales!.records.map((r) => r.ref)).toEqual(["shopify:order:1", "shopify:order:2", "shopify:order:5"]);
    expect(processedIn({ from: "a", to: "b" })).toBe("processed_at:>='a' processed_at:<'b'");
  });

  it("stops at an empty page cursor, turns down a response without nodes and stops past the record limit", async () => {
    const lone: typeof globalThis.fetch = async () => Response.json({ data: { orders: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [order(1)] } } });
    expect((await shopify(lone).verify!(NY_JAN(2, 2)))[0]!.records).toHaveLength(1);
    expect(SHOPIFY_VERIFY_PAGE_SIZE).toBe(250);
    const nodeless: typeof globalThis.fetch = async () => Response.json({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: null } } });
    await expect(shopify(nodeless).verify!(NY_JAN(2, 2))).rejects.toThrow("Shopify orders response has no nodes");
    const empty: typeof globalThis.fetch = async () => Response.json({ data: {} });
    await expect(shopify(empty).verify!(NY_JAN(2, 2))).rejects.toThrow("Shopify orders response has no nodes");
    const big = Array.from({ length: VERIFY_MAX_SOURCE_RECORDS + 1 }, (_, i) => order(i + 1));
    const { fetch, sent } = shopifyPages([big, [order(0)]]);
    const error = await shopify(fetch).verify!(NY_JAN(2, 2)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VerifyLimitError);
    expect((error as Error).message).toBe(`Shopify has more than ${VERIFY_MAX_SOURCE_RECORDS} records in the period; verify a shorter period`);
    expect(sent).toHaveLength(1);
    const { fetch: exact } = shopifyPages([big.slice(1)]);
    expect((await shopify(exact).verify!(NY_JAN(2, 2)))[0]!.records).toHaveLength(VERIFY_MAX_SOURCE_RECORDS);
  });
});

// ---------------------------------------------------------------------------
// Stripe

const STRIPE_KEY = ["rk", "test", "0".repeat(24)].join("_");
const stripeUrl = (period: VerifyPeriod, after?: string) =>
  `https://api.stripe.com/v1/charges?created[gte]=${Date.parse(period.from) / 1000}&created[lt]=${Date.parse(period.to) / 1000}&limit=100${after ? `&starting_after=${after}` : ""}`;
const stripe = (fetch: typeof globalThis.fetch) => stripeConnector({ secretKey: STRIPE_KEY, fetch, now: NOW, sleep: async () => {} });

describe("Stripe verify", () => {
  it("pages the recorded charges with GETs and counts those that succeeded, at the amount captured before refunds", async () => {
    const period = NY_JAN(3, 6);
    const recs: Recording[] = [
      { request: { method: "GET", url: stripeUrl(period) }, response: stripeRecordings[0]!.response },
      { request: { method: "GET", url: stripeUrl(period, "ch_test_1003") }, response: stripeRecordings[1]!.response },
    ];
    const fetch = replayFetch(recs);
    const [charges] = await stripe(fetch).verify!(period);
    // ch_test_1003 was partly refunded and still counts its whole capture; ch_test_1002 failed.
    expect(charges).toMatchObject({
      subject: "charges",
      records: [
        { ref: "stripe:charge:ch_test_1004", cents: 98_000 },
        { ref: "stripe:charge:ch_test_1003", cents: 45_000 },
        { ref: "stripe:charge:ch_test_1001", cents: 125_000 },
      ],
    });
    expect(charges!.basis).toContain("before refunds");
    expect(fetch.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(fetch.unused()).toEqual([]);
  });

  it("puts each charge on its store day, not its UTC day", async () => {
    // ch_test_1001 was made at 04:13 UTC on January 4th, 11:13 pm on January 3rd in New York.
    const period = NY_JAN(4, 4);
    const fetch = replayFetch([
      { request: { method: "GET", url: stripeUrl(period) }, response: { status: 200, body: { object: "list", has_more: false, data: [{ id: "ch_test_1001", object: "charge", created: 1_767_500_000, status: "succeeded", amount_captured: 125_000 }] } } },
    ]);
    expect((await stripe(fetch).verify!(period))[0]!.records).toEqual([]);
  });

  it("counts only succeeded charges with something captured", () => {
    expect(stripeChargeCounts("succeeded", 1)).toBe(true);
    expect(stripeChargeCounts("succeeded", 0)).toBe(false);
    expect(stripeChargeCounts("succeeded", 1.5)).toBe(false);
    expect(stripeChargeCounts("succeeded", "100")).toBe(false);
    expect(stripeChargeCounts("pending", 100)).toBe(false);
    expect(stripeChargeCounts("failed", 100)).toBe(false);
  });

  it("stops on a last page with nothing in it and past the record limit", async () => {
    const period = NY_JAN(2, 2);
    const at = Date.parse("2026-01-02T12:00:00Z") / 1000;
    const charges = Array.from({ length: 100 }, (_, i) => ({ id: `ch_${i}`, object: "charge", created: at, status: "succeeded", amount_captured: 100 }));
    let calls = 0;
    const endless: typeof globalThis.fetch = async () => {
      calls++;
      return Response.json({ object: "list", has_more: true, data: calls === 1 ? charges : [] });
    };
    expect((await stripe(endless).verify!(period))[0]!.records).toHaveLength(100);
    expect(calls).toBe(2);
    const flood: typeof globalThis.fetch = async () => Response.json({ object: "list", has_more: true, data: Array.from({ length: VERIFY_MAX_SOURCE_RECORDS + 1 }, (_, i) => ({ ...charges[0], id: `ch_${i}` })) });
    await expect(stripe(flood).verify!(period)).rejects.toThrow(VerifyLimitError);
  });
});

// ---------------------------------------------------------------------------
// Square

const SQUARE_KEY = ["customer", "ref", "key", "0".repeat(40)].join("-");
const SQUARE_TOKEN = ["read", "only", "token", "0".repeat(26)].join("-");
const money = (amount: number) => ({ amount, currency: "USD" });

function squareSeller(locations: number, orders: Record<string, unknown>[]) {
  squareLocation.reset();
  return squareDocMock({ locations: squareLocation.many(locations), orders, tokens: { [SQUARE_TOKEN]: SQUARE_MOCK_READ_SCOPES }, now: NOW });
}
const square = (mock: ReturnType<typeof squareDocMock>) =>
  squareConnector({ environment: "sandbox", accessToken: SQUARE_TOKEN, customerKey: SQUARE_KEY, fetch: mock.fetch, sleep: async () => {}, now: NOW });

describe("Square verify", () => {
  it("searches every location ten at a time and counts completed orders closed in the period", async () => {
    squareOrder.reset();
    const orders = [
      squareOrder.one({ location_id: squareTestId("LOC", 1), closed_at: "2026-01-02T05:00:00Z" }),
      squareOrder.one({ location_id: squareTestId("LOC", 12), total_money: money(60_000), closed_at: "2026-01-03T04:59:59Z" }),
      // Closed exactly at the period's end, which Square's own filter takes in: the next day's.
      squareOrder.one({ location_id: squareTestId("LOC", 1), closed_at: "2026-01-03T05:00:00Z" }),
      squareOrder.one({ location_id: squareTestId("LOC", 1), state: "CANCELED", closed_at: "2026-01-02T12:00:00Z" }),
      squareOrder.one({ location_id: squareTestId("LOC", 1), state: "OPEN", closed_at: undefined }),
      squareOrder.one({ location_id: squareTestId("LOC", 1), total_money: money(0), closed_at: "2026-01-02T12:00:00Z" }),
    ];
    const mock = squareSeller(12, orders);
    const [sales] = await square(mock).verify!(NY_JAN(2, 2));
    expect(sales).toMatchObject({ subject: "sales", records: [{ ref: `square:order:${orders[0]!.id}`, cents: 120_000 }, { ref: `square:order:${orders[1]!.id}`, cents: 60_000 }] });
    const reads = mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(reads).toEqual(["POST /oauth2/token/status", "GET /v2/locations", "POST /v2/orders/search", "POST /v2/orders/search"]);
  });

  it("follows Square's cursor through every page", async () => {
    squareOrder.reset();
    const orders = squareOrder.many(1_200, () => ({ closed_at: "2026-01-02T12:00:00Z" }));
    const mock = squareSeller(1, orders);
    const [sales] = await square(mock).verify!(NY_JAN(2, 2));
    expect(sales!.records).toHaveLength(1_200);
    expect(new Set(sales!.records.map((r) => r.ref)).size).toBe(1_200);
    expect(mock.fetch.calls.filter((c) => c.url.endsWith("/v2/orders/search"))).toHaveLength(3);
  });

  it("asks Square for completed orders only, still skips any other it answers with, and stops past the record limit", async () => {
    const bodies: Record<string, unknown>[] = [];
    const answer = (orders: Record<string, unknown>[]): SquareClient => ({
      baseUrl: "https://connect.squareupsandbox.com",
      merchantId: () => undefined,
      read: async (route, params) => {
        if (route === "locations") return { locations: [{ id: "L1" }] };
        bodies.push(params ?? {});
        return { orders };
      },
    });
    const sold = { id: "O1", state: "COMPLETED", total_money: money(100), closed_at: "2026-01-02T12:00:00Z" };
    const one = squareConnector({ customerKey: SQUARE_KEY, accessToken: SQUARE_TOKEN, client: answer([sold, { ...sold, id: "O2", state: "CANCELED" }, { ...sold, id: undefined }]) });
    expect((await one.verify!(NY_JAN(2, 2)))[0]!.records).toEqual([{ ref: "square:order:O1", cents: 100 }]);
    expect((bodies[0]!.query as { filter: { state_filter: unknown } }).filter.state_filter).toEqual({ states: ["COMPLETED"] });
    const flood = Array.from({ length: VERIFY_MAX_SOURCE_RECORDS + 1 }, (_, i) => ({ ...sold, id: `O${i}` }));
    await expect(squareConnector({ customerKey: SQUARE_KEY, accessToken: SQUARE_TOKEN, client: answer(flood) }).verify!(NY_JAN(2, 2))).rejects.toThrow(VerifyLimitError);
  });

  it("has nothing to count for a seller with no locations", async () => {
    const mock = squareSeller(0, []);
    expect((await square(mock).verify!(NY_JAN(2, 2)))[0]!.records).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Klaviyo

const KLAVIYO_KEY = ["pk", "testkey".repeat(4)].join("_");
const CUSTOMER_KEY = "k".repeat(16) + "0123456789abcdef0123456789abcdef";

describe("Klaviyo verify", () => {
  it("counts profiles created in the period by keyed reference, asking for their times only", async () => {
    klaviyoProfile.reset();
    const profiles = [
      klaviyoProfile.one({ created: "2026-01-02T05:00:00+00:00", updated: "2026-01-02T05:00:00+00:00" }),
      klaviyoProfile.one({ created: "2026-01-03T04:59:59+00:00", updated: "2026-01-15T00:00:00+00:00" }),
      // Created before the period but updated in it: read, not counted.
      klaviyoProfile.one({ created: "2025-12-01T00:00:00+00:00", updated: "2026-01-02T12:00:00+00:00" }),
      klaviyoProfile.one({ created: "2026-01-03T05:00:00+00:00", updated: "2026-01-03T05:00:00+00:00" }),
      // Updated before the period began, so Klaviyo leaves it out.
      klaviyoProfile.one({ created: "2025-01-01T00:00:00+00:00", updated: "2025-06-01T00:00:00+00:00" }),
    ];
    const mock = klaviyoDocMock({ apiKey: KLAVIYO_KEY, profiles });
    const sent: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      sent.push(`${init?.method ?? "GET"} ${String(input)}`);
      return mock.fetch(input as string, init);
    };
    const connector = klaviyoConnector({ apiKey: KLAVIYO_KEY, customerKey: CUSTOMER_KEY, fetch, sleep: async () => {}, now: NOW });
    const [result] = await connector.verify!(NY_JAN(2, 2));
    expect(result).toEqual({ subject: "profiles", records: [{ ref: klaviyoProfileRef(CUSTOMER_KEY, profiles[0]!.id) }, { ref: klaviyoProfileRef(CUSTOMER_KEY, profiles[1]!.id) }], basis: "Klaviyo profiles created in the period" });
    expect(sent).toHaveLength(1);
    const url = new URL(sent[0]!.slice(4));
    expect(sent[0]!.startsWith("GET ")).toBe(true);
    expect(url.pathname).toBe("/api/profiles/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ "fields[profile]": "created,updated", filter: "greater-than(updated,2026-01-02T04:59:59.000Z)", sort: "updated", "page[size]": String(KLAVIYO_PAGE_SIZES.profiles) });
    // No Klaviyo id, email address or phone number leaves the connector.
    const text = JSON.stringify(result);
    for (const p of profiles) for (const v of [p.id, p.email, p.phone_number]) expect(text).not.toContain(String(v));
  });

  it("pages through every profile and counts each once", async () => {
    klaviyoProfile.reset();
    const profiles = klaviyoProfile.many(250, () => ({ created: "2026-01-02T12:00:00+00:00", updated: "2026-01-02T12:30:00+00:00" }));
    const twice = { ...profiles[0]!, updated: "2026-01-02T13:00:00+00:00" };
    const mock = klaviyoDocMock({ apiKey: KLAVIYO_KEY, profiles: [...profiles, twice] });
    const connector = klaviyoConnector({ apiKey: KLAVIYO_KEY, customerKey: CUSTOMER_KEY, fetch: mock.fetch, sleep: async () => {}, now: NOW });
    const [result] = await connector.verify!(NY_JAN(2, 2));
    expect(result!.records).toHaveLength(250);
    expect(mock.fetch.calls).toHaveLength(3);
    expect(synthetic.email(1)).toMatch(/@example\.test$/);
  });

  it("stops past the record limit", async () => {
    const data = Array.from({ length: VERIFY_MAX_SOURCE_RECORDS + 1 }, (_, i) => ({ id: `P${i}`, attributes: { created: "2026-01-02T12:00:00Z" } }));
    const client: KlaviyoClient = { read: async () => ({ data, next: null }), report: async () => [] };
    await expect(klaviyoConnector({ apiKey: KLAVIYO_KEY, customerKey: CUSTOMER_KEY, client }).verify!(NY_JAN(2, 2))).rejects.toThrow(VerifyLimitError);
  });

  it("lets the client ask for profiles' times alone, and for nothing else beyond the sync's fields", async () => {
    const mock = klaviyoDocMock({ apiKey: KLAVIYO_KEY, profiles: [] });
    const client = klaviyoClient({ apiKey: KLAVIYO_KEY, fetch: mock.fetch, sleep: async () => {} });
    await expect(client.read("profiles", { "fields[profile]": "created,updated" })).resolves.toEqual({ data: [], next: null });
    for (const fields of ["first_name", "created,updated,email", "created", "email,phone_number,created,updated,subscriptions,first_name"]) {
      await expect(client.read("profiles", { "fields[profile]": fields }), fields).rejects.toThrow(KlaviyoConfigError);
    }
    await expect(client.read("lists", { "fields[list]": "created,updated" })).rejects.toThrow(KlaviyoConfigError);
    expect(mock.fetch.calls).toHaveLength(1);
  });

  it("skips a profile whose id can't be keyed", async () => {
    klaviyoProfile.reset();
    const mock = klaviyoDocMock({ apiKey: KLAVIYO_KEY, profiles: [klaviyoProfile.one({ id: "not/an/id", created: "2026-01-02T12:00:00+00:00", updated: "2026-01-02T12:00:00+00:00" })] });
    const connector = klaviyoConnector({ apiKey: KLAVIYO_KEY, customerKey: CUSTOMER_KEY, fetch: mock.fetch, sleep: async () => {}, now: NOW });
    expect((await connector.verify!(NY_JAN(2, 2)))[0]!.records).toEqual([]);
  });
});
