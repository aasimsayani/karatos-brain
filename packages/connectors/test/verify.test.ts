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
  SHOPIFY_VERIFY_REFUND_LINES,
  SHOPIFY_VERIFY_REFUNDS_PAGE_SIZE,
  SHOPIFY_VERIFY_REFUNDS_PER_ORDER,
  SHOPIFY_VERIFY_REFUNDS_QUERY,
  orderEvents,
  refundableIn,
  squareOrderEvents,
  stripeRefundCounts,
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

/** Answers the verify queries a page at a time, sales from `pages` and refunds from `refundPages`, keeping each request's query and variables. */
function shopifyPages(pages: unknown[][], refundPages: unknown[][] = [[]]) {
  const sent: { query: string; variables: Record<string, unknown>; method: string }[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: { after: string | null } & Record<string, unknown> };
    sent.push({ query: body.query, variables: body.variables, method: String(init?.method) });
    const answer = body.query.startsWith("query VerifyRefunds") ? refundPages : pages;
    const index = body.variables.after === null ? 0 : Number(body.variables.after.slice(1));
    const more = index + 1 < answer.length;
    return Response.json({ data: { orders: { pageInfo: { hasNextPage: more, endCursor: more ? `p${index + 1}` : null }, nodes: answer[index] } } });
  };
  return { fetch, sent };
}

interface RefundLine {
  quantity: number;
  subtotalSet: { shopMoney: { amount: string } } | null;
}
const line = (amount: string, quantity = 1): RefundLine => ({ quantity, subtotalSet: { shopMoney: { amount } } });
const refund = (n: number, createdAt: string, lines: RefundLine[], more = false) => ({ id: `gid://shopify/Refund/${n}`, createdAt, refundLineItems: { pageInfo: { hasNextPage: more }, nodes: lines } });
const refunded = (n: number, refunds: unknown[] | null) => ({ id: `gid://shopify/Order/${n}`, refunds });
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
    const [sales, refunds] = await shopify(fetch).verify!(NY_JAN(2, 2));
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
    // 1001's refund was made on January 5th, not on its sale day.
    expect(refunds).toEqual({ subject: "refunds", records: [], basis: expect.stringContaining("Shopify refunds created in the period") });
    expect(sent).toHaveLength(4);
    expect(sent.map((s) => s.variables.after)).toEqual([null, "eyJsYXN0X2lkIjoxMDAyfQ", null, "eyJsYXN0X2lkIjoxMDAyfQ"]);
    for (const s of sent.slice(0, 2)) {
      expect(s.method).toBe("POST");
      expect(s.query).toBe(SHOPIFY_VERIFY_QUERY);
      expect(s.query).toMatch(/^query VerifyOrders/);
      expect(s.query).not.toMatch(/mutation|customer|email|phone|lineItems/i);
      expect(s.variables).toMatchObject({ first: SHOPIFY_VERIFY_PAGE_SIZE, query: "processed_at:>='2026-01-02T05:00:00.000Z' processed_at:<'2026-01-03T05:00:00.000Z'" });
    }
    for (const s of sent.slice(2)) {
      expect(s.method).toBe("POST");
      expect(s.query).toBe(SHOPIFY_VERIFY_REFUNDS_QUERY);
      expect(s.query).toMatch(/^query VerifyRefunds/);
      expect(s.query).not.toMatch(/mutation|customer|email|phone|address|note|lineItem \{|sku/i);
      expect(s.variables).toMatchObject({ first: SHOPIFY_VERIFY_REFUNDS_PAGE_SIZE, query: "updated_at:>='2026-01-02T05:00:00.000Z' created_at:<'2026-01-03T05:00:00.000Z'" });
    }
  });

  it("counts a recorded refund on the day it was made, as the sync records it", async () => {
    const byCursor: Record<string, Recording> = { "": shopifyRecordings[0]!, eyJsYXN0X2lkIjoxMDAyfQ: shopifyRecordings[1]! };
    const fetch: typeof globalThis.fetch = async (_input, init) => Response.json(byCursor[(JSON.parse(String(init?.body)) as { variables: { after: string | null } }).variables.after ?? ""]!.response.body);
    const [sales, refunds] = await shopify(fetch).verify!(NY_JAN(5, 5));
    expect(sales!.records).toEqual([]);
    expect(refunds!.records).toEqual([{ ref: "shopify:refund:3001", cents: 15_000 }]);
    // The same id and amount the sync's sale.returned event carries.
    const nodes = [shopifyRecordings[0]!, shopifyRecordings[1]!].flatMap((r) => (r.response.body as { data: { orders: { nodes: Parameters<typeof orderEvents>[0][] } } }).data.orders.nodes);
    const returned = nodes.flatMap((n) => orderEvents(n, "2026-01-10T00:00:00Z")).filter((e) => e.type === "sale.returned");
    expect(returned.map((e) => [e.payload.returnId, (e.payload.lines as { refundCents: number }[]).reduce((s, l) => s + l.refundCents, 0), e.occurredAt])).toEqual([["shopify:refund:3001", 15_000, "2026-01-05T10:00:00Z"]]);
  });

  it("counts each refund of an order on its own day, partial and multiple ones alike, across pages", async () => {
    const { fetch, sent } = shopifyPages(
      [[]],
      [
        [
          // Two partial refunds of one order on the same day, and a third the next day.
          refunded(1, [refund(11, "2026-01-02T15:00:00Z", [line("25.00"), line("5.50", 2)]), refund(12, "2026-01-02T18:00:00Z", [line("10.00")]), refund(13, "2026-01-03T15:00:00Z", [line("1.00")])]),
          // Shipping-only and restock-free refunds have no returned lines: on neither side.
          refunded(2, [refund(21, "2026-01-02T15:00:00Z", []), refund(22, "2026-01-02T15:00:00Z", [line("9.00", 0)])]),
          refunded(3, null),
          refunded(4, []),
        ],
        [
          // At the period's exact edges, and a line whose amount can't be read counts as nothing, as the sync counts it.
          refunded(5, [
            refund(51, "2026-01-02T05:00:00Z", [line("1.00")]),
            refund(52, "2026-01-03T04:59:59Z", [line("2.00"), { quantity: 1, subtotalSet: null }]),
            refund(53, "2026-01-03T05:00:00Z", [line("3.00")]),
            refund(54, "2026-01-02T04:59:59Z", [line("4.00")]),
          ]),
          { id: "gid://shopify/Order/6", refunds: [{ id: "gid://shopify/Refund/61", createdAt: "2026-01-02T12:00:00Z", refundLineItems: null }] },
        ],
      ],
    );
    const [, refunds] = await shopify(fetch).verify!(NY_JAN(2, 2));
    expect(refunds).toMatchObject({ subject: "refunds" });
    expect(refunds).not.toHaveProperty("unavailable");
    expect(refunds!.records).toEqual([
      { ref: "shopify:refund:11", cents: 3_050 },
      { ref: "shopify:refund:12", cents: 1_000 },
      { ref: "shopify:refund:51", cents: 100 },
      { ref: "shopify:refund:52", cents: 200 },
    ]);
    expect(sent.filter((s) => s.query === SHOPIFY_VERIFY_REFUNDS_QUERY).map((s) => s.variables.after)).toEqual([null, "p1"]);
    expect(refundableIn({ from: "a", to: "b" })).toBe("updated_at:>='a' created_at:<'b'");
  });

  it("says refunds are unavailable when an order has more refunds or lines than one read returns", async () => {
    expect([SHOPIFY_VERIFY_REFUNDS_PER_ORDER, SHOPIFY_VERIFY_REFUND_LINES, SHOPIFY_VERIFY_REFUNDS_PAGE_SIZE]).toEqual([10, 50, 10]);
    expect(SHOPIFY_VERIFY_REFUNDS_QUERY).toContain("refunds(first: 11)");
    // Paged by update, as the sync pages orders to find their refunds.
    expect(SHOPIFY_VERIFY_REFUNDS_QUERY).toContain("orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT)");
    expect(SHOPIFY_VERIFY_REFUNDS_QUERY).toContain("refundLineItems(first: 50) { pageInfo { hasNextPage }");
    const day = "2026-01-02T15:00:00Z";
    const ten = Array.from({ length: 10 }, (_, i) => refund(100 + i, day, [line("1.00")]));
    const { fetch: exact } = shopifyPages([[]], [[refunded(1, ten)]]);
    expect((await shopify(exact).verify!(NY_JAN(2, 2)))[1]!.records).toHaveLength(10);
    const { fetch: many, sent } = shopifyPages([[]], [[refunded(1, [...ten, refund(200, day, [line("1.00")])])], [refunded(2, [refund(300, day, [line("1.00")])])]]);
    const [sales, refunds] = await shopify(many).verify!(NY_JAN(2, 2));
    expect(sales!.records).toEqual([]);
    expect(refunds).toEqual({
      subject: "refunds",
      records: [],
      basis: expect.any(String),
      unavailable: "shopify:order:1 has more than 10 refunds or a refund with more than 50 line items, more than the connector reads; check its refunds in Shopify",
    });
    // It stops at the first such order.
    expect(sent.filter((s) => s.query === SHOPIFY_VERIFY_REFUNDS_QUERY)).toHaveLength(1);
    const { fetch: long } = shopifyPages([[]], [[refunded(7, [refund(1, day, [line("1.00")]), refund(2, day, [line("1.00")], true)])]]);
    expect((await shopify(long).verify!(NY_JAN(2, 2)))[1]!.unavailable).toContain("shopify:order:7 has more than 10 refunds");
  });

  it("stops past the limit on orders read or refunds counted, and turns down a refunds response without nodes", async () => {
    const day = "2026-01-02T15:00:00Z";
    const orders = Array.from({ length: VERIFY_MAX_SOURCE_RECORDS + 1 }, (_, i) => refunded(i, []));
    const { fetch: scanned } = shopifyPages([[]], [orders]);
    await expect(shopify(scanned).verify!(NY_JAN(2, 2))).rejects.toThrow(`Shopify has more than ${VERIFY_MAX_SOURCE_RECORDS} orders updated since the period began; verify a shorter or more recent period`);
    const { fetch: atLimit } = shopifyPages([[]], [orders.slice(1)]);
    expect((await shopify(atLimit).verify!(NY_JAN(2, 2)))[1]!.records).toEqual([]);
    const tens = Array.from({ length: 5_001 }, (_, i) =>
      refunded(
        i,
        Array.from({ length: 10 }, (_, j) => refund(i * 10 + j, day, [line("1.00")])),
      ),
    );
    const { fetch: counted } = shopifyPages([[]], [tens]);
    await expect(shopify(counted).verify!(NY_JAN(2, 2))).rejects.toThrow(`Shopify has more than ${VERIFY_MAX_SOURCE_RECORDS} records in the period; verify a shorter period`);
    const nodeless: typeof globalThis.fetch = async (_input, init) =>
      String(init?.body).includes("VerifyRefunds") ? Response.json({ data: {} }) : Response.json({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
    await expect(shopify(nodeless).verify!(NY_JAN(2, 2))).rejects.toThrow("Shopify orders response has no nodes");
    const nullNodes: typeof globalThis.fetch = async (_input, init) =>
      Response.json({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: String(init?.body).includes("VerifyRefunds") ? null : [] } } });
    await expect(shopify(nullNodes).verify!(NY_JAN(2, 2))).rejects.toThrow("Shopify orders response has no nodes");
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
const stripeUrl = (period: VerifyPeriod, after?: string, list = "charges") =>
  `https://api.stripe.com/v1/${list}?created[gte]=${Date.parse(period.from) / 1000}&created[lt]=${Date.parse(period.to) / 1000}&limit=100${after ? `&starting_after=${after}` : ""}`;
const stripe = (fetch: typeof globalThis.fetch) => stripeConnector({ secretKey: STRIPE_KEY, fetch, now: NOW, sleep: async () => {} });

describe("Stripe verify", () => {
  it("pages the recorded charges with GETs and counts those that succeeded, at the amount captured before refunds", async () => {
    const period = NY_JAN(3, 6);
    const recs: Recording[] = [
      { request: { method: "GET", url: stripeUrl(period) }, response: stripeRecordings[0]!.response },
      { request: { method: "GET", url: stripeUrl(period, "ch_test_1003") }, response: stripeRecordings[1]!.response },
      { request: { method: "GET", url: stripeUrl(period, undefined, "refunds") }, response: stripeRecordings[2]!.response },
    ];
    const fetch = replayFetch(recs);
    const [charges, refunds] = await stripe(fetch).verify!(period);
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
    // ch_test_1003's partial refund, made on January 5th.
    expect(refunds).toEqual({ subject: "payment_refunds", records: [{ ref: "stripe:refund:re_test_1", cents: 20_000 }], basis: "Stripe refunds created in the period that succeeded, at their amount" });
    expect(fetch.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET"]);
    expect(fetch.unused()).toEqual([]);
  });

  it("puts each charge on its store day, not its UTC day", async () => {
    // ch_test_1001 was made at 04:13 UTC on January 4th, 11:13 pm on January 3rd in New York.
    const period = NY_JAN(4, 4);
    const fetch = replayFetch([
      {
        request: { method: "GET", url: stripeUrl(period) },
        response: { status: 200, body: { object: "list", has_more: false, data: [{ id: "ch_test_1001", object: "charge", created: 1_767_500_000, status: "succeeded", amount_captured: 125_000 }] } },
      },
      {
        request: { method: "GET", url: stripeUrl(period, undefined, "refunds") },
        response: { status: 200, body: { object: "list", has_more: false, data: [{ id: "re_test_9", object: "refund", created: 1_767_500_000, status: "succeeded", amount: 100 }] } },
      },
    ]);
    const [charges, refunds] = await stripe(fetch).verify!(period);
    expect(charges!.records).toEqual([]);
    expect(refunds!.records).toEqual([]);
  });

  it("counts each refund that succeeded on the day it was made, partial and repeated refunds of one charge alike, across pages", async () => {
    const period = NY_JAN(5, 5);
    const at = Date.parse("2026-01-05T12:00:00Z") / 1000;
    const re = (id: string, over: Record<string, unknown> = {}) => ({ id, object: "refund", amount: 1_000, charge: "ch_test_1001", currency: "usd", created: at, status: "succeeded", reason: null, ...over });
    const fetch = replayFetch([
      { request: { method: "GET", url: stripeUrl(period) }, response: { status: 200, body: { object: "list", has_more: false, data: [] } } },
      {
        request: { method: "GET", url: stripeUrl(period, undefined, "refunds") },
        response: { status: 200, body: { object: "list", has_more: true, data: [re("re_a"), re("re_b", { amount: 2_500 }), re("re_c", { status: "pending" }), re("re_d", { status: "failed" }), re("re_e", { status: "canceled" })] } },
      },
      {
        request: { method: "GET", url: stripeUrl(period, "re_e", "refunds") },
        response: { status: 200, body: { object: "list", has_more: false, data: [re("re_f", { amount: 0 }), re("re_g", { created: Date.parse(period.to) / 1000 }), re("re_h", { created: Date.parse(period.from) / 1000, charge: null })] } },
      },
    ]);
    const [, refunds] = await stripe(fetch).verify!(period);
    expect(refunds!.records).toEqual([
      { ref: "stripe:refund:re_a", cents: 1_000 },
      { ref: "stripe:refund:re_b", cents: 2_500 },
      { ref: "stripe:refund:re_h", cents: 1_000 },
    ]);
    expect(fetch.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET"]);
    expect(fetch.unused()).toEqual([]);
  });

  it("counts only refunds that succeeded with an amount", () => {
    expect(stripeRefundCounts("succeeded", 1)).toBe(true);
    expect(stripeRefundCounts("succeeded", 0)).toBe(false);
    expect(stripeRefundCounts("succeeded", 1.5)).toBe(false);
    expect(stripeRefundCounts("succeeded", "100")).toBe(false);
    expect(stripeRefundCounts("pending", 100)).toBe(false);
    expect(stripeRefundCounts("requires_action", 100)).toBe(false);
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
    const urls: string[] = [];
    const endless: typeof globalThis.fetch = async (input) => {
      urls.push(new URL(String(input)).pathname);
      return Response.json({ object: "list", has_more: true, data: urls.length === 1 ? charges : [] });
    };
    expect((await stripe(endless).verify!(period))[0]!.records).toHaveLength(100);
    expect(urls).toEqual(["/v1/charges", "/v1/charges", "/v1/refunds"]);
    const flood: typeof globalThis.fetch = async () => Response.json({ object: "list", has_more: true, data: Array.from({ length: VERIFY_MAX_SOURCE_RECORDS + 1 }, (_, i) => ({ ...charges[0], id: `ch_${i}` })) });
    await expect(stripe(flood).verify!(period)).rejects.toThrow(VerifyLimitError);
    const refunds = Array.from({ length: VERIFY_MAX_SOURCE_RECORDS + 1 }, (_, i) => ({ id: `re_${i}`, object: "refund", created: at, status: "succeeded", amount: 100 }));
    const refundFlood: typeof globalThis.fetch = async (input) => Response.json({ object: "list", has_more: false, data: String(input).includes("/v1/refunds") ? refunds : [] });
    await expect(stripe(refundFlood).verify!(period)).rejects.toThrow("Stripe has more than");
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
    const [sales, refunds] = await square(mock).verify!(NY_JAN(2, 2));
    expect(sales).toMatchObject({
      subject: "sales",
      records: [
        { ref: `square:order:${orders[0]!.id}`, cents: 120_000 },
        { ref: `square:order:${orders[1]!.id}`, cents: 60_000 },
      ],
    });
    expect(refunds).toEqual({ subject: "refunds", records: [], basis: expect.stringContaining("returns in Square orders closed in the period") });
    const reads = mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(reads).toEqual(["POST /oauth2/token/status", "GET /v2/locations", "POST /v2/orders/search", "POST /v2/orders/search"]);
  });

  it("counts each return in an order closed in the period, on its own day and not the sale's, as the sync records it", async () => {
    squareOrder.reset();
    const ret = (uid: unknown, lines: Record<string, unknown>[], source?: string) => ({ uid, ...(source ? { source_order_id: source } : {}), return_line_items: lines });
    const rl = (cents: unknown, catalog = squareTestId("VAR", 1)) => ({ uid: "rl", quantity: "1", catalog_object_id: catalog, total_money: { amount: cents, currency: "USD" } });
    const sold = squareOrder.one({ closed_at: "2025-12-20T15:00:00Z" });
    const orders = [
      sold,
      // A return order of its own: nothing sold, two returns of the December sale (a partial one and the rest), one of them with two lines.
      squareOrder.one({ closed_at: "2026-01-02T15:00:00Z", line_items: [], tenders: [], total_money: money(0), returns: [ret("ret-1", [rl(5_000), rl(2_500)], String(sold.id)), ret("ret-2", [rl(1_000)], String(sold.id))] }),
      // An exchange: a sale and an unlinked return in one order, at the period's exact start.
      squareOrder.one({ closed_at: "2026-01-02T05:00:00Z", total_money: money(30_000), returns: [ret("ret-3", [rl(9_000)])] }),
      // Not counted: no lines, an id that can't be keyed, an unreadable amount (counted as nothing), a canceled order, the next day.
      squareOrder.one({ closed_at: "2026-01-02T16:00:00Z", line_items: [], tenders: [], total_money: money(0), returns: [ret("ret-4", []), ret("bad id", [rl(1)]), ret("ret-5", [rl("12.00")])] }),
      squareOrder.one({ state: "CANCELED", closed_at: "2026-01-02T16:00:00Z", returns: [ret("ret-6", [rl(700)])] }),
      squareOrder.one({ closed_at: "2026-01-03T05:00:00Z", line_items: [], tenders: [], total_money: money(0), returns: [ret("ret-7", [rl(800)])] }),
    ];
    const mock = squareSeller(1, orders);
    const [sales, refunds] = await square(mock).verify!(NY_JAN(2, 2));
    expect(sales!.records.map((r) => r.ref)).toEqual([`square:order:${orders[2]!.id}`]);
    const expected = [
      { ref: `square:return:${orders[2]!.id}:ret-3`, cents: 9_000 },
      { ref: `square:return:${orders[1]!.id}:ret-1`, cents: 7_500 },
      { ref: `square:return:${orders[1]!.id}:ret-2`, cents: 1_000 },
      { ref: `square:return:${orders[3]!.id}:ret-5`, cents: 0 },
    ];
    expect(refunds!.records).toEqual(expected);
    // The ids and amounts the sync's sale.returned events carry for the orders it counts (ret-5's line can't be read, so the brief can't count it).
    const ctx = { receivedAt: "2026-01-10T00:00:00Z", sku: (v: string) => v, customerRef: () => undefined };
    const returned = orders.flatMap((o) => squareOrderEvents(o, ctx)).filter((e) => e.type === "sale.returned" && inVerifyPeriod(e.occurredAt, NY_JAN(2, 2)));
    expect(returned.map((e) => ({ ref: e.payload.returnId, cents: (e.payload.lines as { refundCents: number | null }[]).reduce((sum, l) => sum + (l.refundCents ?? 0), 0) }))).toEqual(expect.arrayContaining(expected));
    expect(returned).toHaveLength(expected.length);
    expect(mock.fetch.calls.map((c) => c.method)).toEqual(["POST", "GET", "POST"]);
  });

  it("follows Square's cursor through every page", async () => {
    squareOrder.reset();
    const orders = squareOrder.many(1_200, (n) => ({ closed_at: "2026-01-02T12:00:00Z", returns: [{ uid: `ret-${n}`, return_line_items: [{ total_money: money(n) }] }] }));
    const mock = squareSeller(1, orders);
    const [sales, refunds] = await square(mock).verify!(NY_JAN(2, 2));
    expect(sales!.records).toHaveLength(1_200);
    expect(refunds!.records).toHaveLength(1_200);
    expect(new Set(refunds!.records.map((r) => r.ref)).size).toBe(1_200);
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
    const returns = { ...sold, total_money: money(0), returns: Array.from({ length: VERIFY_MAX_SOURCE_RECORDS + 1 }, (_, i) => ({ uid: `r${i}`, return_line_items: [{ total_money: money(1) }] })) };
    await expect(squareConnector({ customerKey: SQUARE_KEY, accessToken: SQUARE_TOKEN, client: answer([returns]) }).verify!(NY_JAN(2, 2))).rejects.toThrow("Square has more than");
    const fewer = { ...returns, returns: returns.returns.slice(1) };
    const [sales, refunds] = await squareConnector({ customerKey: SQUARE_KEY, accessToken: SQUARE_TOKEN, client: answer([fewer]) }).verify!(NY_JAN(2, 2));
    expect([sales!.records.length, refunds!.records.length]).toEqual([0, VERIFY_MAX_SOURCE_RECORDS]);
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
