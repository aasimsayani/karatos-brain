import { describe, expect, it, vi } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, synthetic, testPipeline, yotpoDocMock, yotpoMember, yotpoReview, type YotpoMock, type YotpoMockData } from "@karatos/connector-testkit";
import {
  YOTPO_API_URL,
  YOTPO_LOYALTY_EVENT,
  YOTPO_LOYALTY_PAGE,
  YOTPO_LOYALTY_URL,
  YOTPO_MAX_PAGE,
  YOTPO_OVERLAP_DAYS,
  YOTPO_REVIEW_EVENT,
  YOTPO_REVIEW_PAGE,
  YOTPO_WRITES,
  YotpoApiError,
  YotpoConfigError,
  formCustomerRefs,
  parseYotpoCursor,
  yotpoClient,
  yotpoConnector,
  yotpoErrorCode,
  yotpoId,
  yotpoLoyaltyEvent,
  yotpoReviewEvent,
  yotpoText,
  type YotpoClient,
  type YotpoCursor,
  type YotpoEvent,
  type YotpoOptions,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const STORE = ["store", "Test", "0".repeat(10)].join("");
const SECRET = ["secret", "Test", "0".repeat(24)].join("");
const GUID = ["guid", "test", "0".repeat(10)].join("_");
const LOYALTY_KEY = ["lk", "test", "0".repeat(20)].join("_");
const CUSTOMER_KEY = "c".repeat(40);
const NOW = () => new Date("2026-11-10T15:00:00.000Z");
const RECEIVED = "2026-11-10T15:00:00.000Z";
const DAY_MS = 86_400_000;
const noSleep = async () => {};
const ctx = { customerKey: CUSTOMER_KEY, receivedAt: RECEIVED };

/** `ago` days before NOW. */
const daysAgo = (ago: number) => new Date(NOW().getTime() - ago * DAY_MS).toISOString();

/** Reviews updated 1, 30 and 1,000 days ago and six years ago, and members updated 1 and 10 days ago. */
function store(overrides: Partial<YotpoMockData> = {}): YotpoMockData {
  yotpoReview.reset();
  yotpoMember.reset();
  return {
    storeId: STORE,
    apiSecret: SECRET,
    loyaltyGuid: GUID,
    loyaltyApiKey: LOYALTY_KEY,
    reviews: [1, 30, 1000, 2200].map((ago) => yotpoReview.one({ created_at: daysAgo(ago), updated_at: daysAgo(ago) })),
    members: [1, 10].map((ago) => yotpoMember.one({ updated_at: daysAgo(ago) })),
    ...overrides,
  };
}

const connector = (mock: YotpoMock, overrides: Partial<YotpoOptions> = {}) =>
  yotpoConnector({ storeId: STORE, apiSecret: SECRET, loyaltyGuid: GUID, loyaltyApiKey: LOYALTY_KEY, customerKey: CUSTOMER_KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });

const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as YotpoEvent[];

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers in turn and records what was sent. */
function scripted(...answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body });
    return answers[Math.min(sent.length - 1, answers.length - 1)]!();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const text = (status: number, body: string) => () => new Response(body, { status });
const TOKEN = `tok${"t".repeat(30)}`;
const tokenAnswer = () => json(200, { access_token: TOKEN });
const NONE = { reviews: [] };
const LOYAL = { metadata: { next_page_info: null }, customers: [] };
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof yotpoClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = yotpoClient({ storeId: STORE, apiSecret: SECRET, loyaltyGuid: GUID, loyaltyApiKey: LOYALTY_KEY, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};

describe("Yotpo client", () => {
  it("checks its credentials before sending anything", () => {
    const { fetch, sent } = scripted(tokenAnswer());
    const make = (o: Partial<Parameters<typeof yotpoClient>[0]>) => () => yotpoClient({ storeId: STORE, apiSecret: SECRET, fetch, ...o });
    for (const storeId of ["", "a".repeat(9), "a".repeat(65), "has_under1", undefined]) expect(make({ storeId: storeId as string }), String(storeId)).toThrow("YOTPO_STORE_ID is missing or not in the expected shape");
    for (const apiSecret of ["", "a".repeat(19), "a".repeat(129), `${SECRET}-`, undefined]) expect(make({ apiSecret: apiSecret as string }), String(apiSecret)).toThrow("YOTPO_API_SECRET is missing or not in the expected shape");
    expect(make({ loyaltyGuid: GUID })).toThrow("YOTPO_LOYALTY_GUID and YOTPO_LOYALTY_API_KEY go together: give both or neither");
    expect(make({ loyaltyApiKey: LOYALTY_KEY, loyaltyGuid: "  " })).toThrow("go together");
    for (const loyaltyGuid of ["a".repeat(9), "a".repeat(65), "bad guid!!", "has a space 00"]) expect(make({ loyaltyGuid, loyaltyApiKey: LOYALTY_KEY }), loyaltyGuid).toThrow("YOTPO_LOYALTY_GUID is not in the expected shape");
    for (const loyaltyApiKey of ["a".repeat(15), "a".repeat(129), "bad key!!!!!!!!!!"]) expect(make({ loyaltyGuid: GUID, loyaltyApiKey }), loyaltyApiKey).toThrow("YOTPO_LOYALTY_API_KEY is not in the expected shape");
    expect(make({ storeId: "" })).toThrow(YotpoConfigError);
    for (const ok of [{ storeId: "a".repeat(10) }, { storeId: "a".repeat(64) }, { apiSecret: "a".repeat(20) }, { apiSecret: "a".repeat(128) }, { loyaltyGuid: "a".repeat(10), loyaltyApiKey: "a".repeat(16) }, { loyaltyGuid: "a".repeat(64), loyaltyApiKey: "a".repeat(128) }]) expect(make(ok)).not.toThrow();
    expect(make({}) ().loyalty).toBe(false);
    expect(make({ loyaltyGuid: ` ${GUID} `, loyaltyApiKey: ` ${LOYALTY_KEY}` })().loyalty).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("asks for a token with the secret, then lists reviews with it", async () => {
    const { fetch, sent } = scripted(tokenAnswer(), json(200, { reviews: [{ id: 1 }] }), json(200, NONE));
    const { c } = client(fetch, { storeId: ` ${STORE} `, apiSecret: `${SECRET} ` });
    expect(await c.reviews("2026-11-01", 3)).toEqual([{ id: 1 }]);
    await c.reviews("2026-11-01", 4);
    expect(sent[0]).toEqual({ url: `${YOTPO_API_URL}/core/v3/stores/${STORE}/access_tokens`, method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ secret: SECRET }) });
    expect(sent[1]).toEqual({ url: `${YOTPO_API_URL}/v1/apps/${STORE}/reviews?since_updated_at=2026-11-01&count=100&page=3&deleted=true`, method: "GET", headers: { "X-Yotpo-Token": TOKEN, accept: "application/json" }, body: undefined });
    expect(sent).toHaveLength(3);
    expect(YOTPO_API_URL).toBe("https://api.yotpo.com");
    expect(YOTPO_REVIEW_PAGE).toBe(100);
  });

  it("lists Loyalty members with the GUID and key, paging by Yotpo's cursor", async () => {
    const { fetch, sent } = scripted(json(200, { metadata: { next_page_info: "abc_-=" }, customers: [{ yotpo_customer_id: 1 }] }), json(200, { metadata: { next_page_info: "" }, customers: [] }), json(200, { customers: [] }), json(200, { metadata: [], customers: [] }));
    const { c } = client(fetch);
    expect(await c.loyaltyCustomers(null)).toEqual({ rows: [{ yotpo_customer_id: 1 }], next: "abc_-=" });
    expect(await c.loyaltyCustomers("abc_-=")).toEqual({ rows: [], next: null });
    expect(await c.loyaltyCustomers(null)).toEqual({ rows: [], next: null });
    expect(await c.loyaltyCustomers(null)).toEqual({ rows: [], next: null });
    expect(sent[0]).toEqual({ url: `${YOTPO_LOYALTY_URL}/customers/recent?per_page=500`, method: "GET", headers: { "X-GUID": GUID, "X-API-KEY": LOYALTY_KEY, accept: "application/json" }, body: undefined });
    expect(sent[1]!.url).toBe(`${YOTPO_LOYALTY_URL}/customers/recent?per_page=500&page_info=abc_-%3D`);
    expect(YOTPO_LOYALTY_URL).toBe("https://loyalty.yotpo.com/api/v2");
    expect(YOTPO_LOYALTY_PAGE).toBe(500);
  });

  it("won't read Loyalty without its credentials", async () => {
    const { fetch, sent } = scripted(json(200, LOYAL));
    await expect(client(fetch, { loyaltyGuid: undefined, loyaltyApiKey: undefined }).c.loyaltyCustomers(null)).rejects.toThrow("Yotpo Loyalty isn't set up: give YOTPO_LOYALTY_GUID and YOTPO_LOYALTY_API_KEY");
    expect(sent).toHaveLength(0);
  });

  it("checks days, pages and cursors before sending", async () => {
    const { fetch, sent } = scripted(tokenAnswer(), json(200, NONE), json(200, LOYAL));
    const { c } = client(fetch);
    for (const day of ["2026-11-1", "x2026-11-01", "2026-11-01x", "2026-11-01T00:00:00Z"]) await expect(c.reviews(day, 1)).rejects.toThrow("reviews must be listed since a YYYY-MM-DD day");
    for (const page of [0, -1, 1.5, YOTPO_MAX_PAGE + 1, Number.NaN]) await expect(c.reviews("2026-11-01", page)).rejects.toThrow(`a reviews page must be 1 to ${YOTPO_MAX_PAGE}`);
    for (const info of ["", "a b", "a".repeat(513), "tok!"]) await expect(c.loyaltyCustomers(info)).rejects.toThrow("a Loyalty page cursor is not in the expected shape");
    expect(sent).toHaveLength(0);
    await c.reviews("2026-11-01", YOTPO_MAX_PAGE);
    await c.loyaltyCustomers("a".repeat(512));
    expect(sent).toHaveLength(3);
    expect(YOTPO_MAX_PAGE).toBe(10_000);
  });

  it("says when a list is missing or a cursor doesn't read", async () => {
    const { fetch } = scripted(tokenAnswer(), json(200, {}), json(200, { reviews: {} }), json(200, { metadata: {} }), json(200, { customers: {} }), json(200, { metadata: { next_page_info: "a b" }, customers: [] }), json(200, { metadata: { next_page_info: 5 }, customers: [] }));
    const { c } = client(fetch);
    await expect(c.reviews("2026-11-01", 1)).rejects.toThrow("Yotpo answered the reviews without the reviews list");
    await expect(c.reviews("2026-11-01", 1)).rejects.toThrow("Yotpo answered the reviews without the reviews list");
    await expect(c.loyaltyCustomers(null)).rejects.toThrow("Yotpo answered the Loyalty customers without the customers list");
    await expect(c.loyaltyCustomers(null)).rejects.toThrow("Yotpo answered the Loyalty customers without the customers list");
    await expect(c.loyaltyCustomers(null)).rejects.toMatchObject({ status: 200, message: "Yotpo answered the Loyalty customers with a page cursor that doesn't read" });
    await expect(c.loyaltyCustomers(null)).rejects.toThrow(YotpoApiError);
  });

  it("says when Yotpo turns down the store's credentials, or answers without a token", async () => {
    for (const status of [401, 403, 404]) {
      await expect(client(scripted(json(status, {})).fetch).c.reviews("2026-11-01", 1)).rejects.toThrow(`Yotpo turned down the store's credentials (HTTP ${status}): check YOTPO_STORE_ID and YOTPO_API_SECRET`);
    }
    await expect(client(scripted(json(401, {})).fetch).c.reviews("2026-11-01", 1)).rejects.toThrow(YotpoConfigError);
    for (const answer of [json(400, { status: { code: 400 } }), json(200, {}), json(200, ["x"]), text(200, "<html>"), json(200, { access_token: "short" }), json(200, { access_token: "a".repeat(15) }), json(200, { access_token: `${"a".repeat(16)}!` }), json(400, { access_token: "a".repeat(20) }), json(200, { access_token: "has a space in it ok" }), json(200, { access_token: 12345678901234567 }), json(200, { access_token: "a".repeat(4097) })]) {
      await expect(client(scripted(answer).fetch).c.reviews("2026-11-01", 1)).rejects.toThrow(/^Yotpo answered the token request with HTTP (400|200) and no token$/);
    }
    await expect(client(scripted(json(400, { status: { code: 4 } })).fetch).c.reviews("2026-11-01", 1)).rejects.toMatchObject({ status: 400, code: 4 });
    for (const ok of ["a".repeat(16), "a".repeat(4096), "a.b-c_d0123456789"]) {
      await expect(client(scripted(json(200, { access_token: ok }), json(200, NONE)).fetch).c.reviews("2026-11-01", 1), ok).resolves.toEqual([]);
    }
  });

  it("keeps the token, and drops one Yotpo turns down so the next read asks again", async () => {
    const { fetch, sent } = scripted(tokenAnswer(), json(200, NONE), json(401, { status: { message: "Missing or invalid access token", code: 401, error_type: "authorization" } }), tokenAnswer(), json(200, NONE));
    const { c } = client(fetch);
    await c.reviews("2026-11-01", 1);
    await expect(c.reviews("2026-11-01", 1)).rejects.toMatchObject({ status: 401, code: 401, message: "Yotpo turned down the access token for the reviews (code 401)" });
    await c.reviews("2026-11-01", 1);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
  });

  it("explains other errors, with Yotpo's code when it gives one", async () => {
    const { fetch } = scripted(json(401, { error: "Unauthorized" }), json(400, { status: { code: 7 } }), json(500, { code: 9 }), json(422, {}));
    const { c } = client(fetch, { retries: 0 });
    await expect(c.loyaltyCustomers(null)).rejects.toMatchObject({ status: 401, message: "Yotpo turned down the Loyalty GUID and API key for the Loyalty customers" });
    await expect(c.loyaltyCustomers(null)).rejects.toMatchObject({ status: 400, code: 7, message: "Yotpo answered HTTP 400 for the Loyalty customers (code 7)" });
    await expect(c.loyaltyCustomers(null)).rejects.toMatchObject({ status: 500, code: 9, message: "Yotpo answered HTTP 500 for the Loyalty customers (code 9)" });
    await expect(c.loyaltyCustomers(null)).rejects.toMatchObject({ status: 422, code: undefined, message: "Yotpo answered HTTP 422 for the Loyalty customers" });
    expect(yotpoErrorCode({ status: { code: 401 } })).toBe(401);
    expect(yotpoErrorCode({ code: 5 })).toBe(5);
    for (const none of [{ status: { code: 0 } }, { code: "1" }, ["x"], null, { status: "bad" }, { code: 2 ** 53 }, { code: -3 }]) expect(yotpoErrorCode(none), JSON.stringify(none)).toBeUndefined();
  });

  it("says when a 200 isn't a JSON object", async () => {
    const { fetch } = scripted(text(200, "<html>"), json(200, ["a"]), json(200, null));
    const { c } = client(fetch);
    for (let i = 0; i < 3; i++) await expect(c.loyaltyCustomers(null)).rejects.toMatchObject({ status: 200, message: "Yotpo answered the Loyalty customers with a body that isn't a JSON object" });
  });

  it("waits out rate limits and server errors, honoring Retry-After up to a minute, then gives up", async () => {
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "1" }), tokenAnswer(), json(500, {}), json(502, {}, { "retry-after": "600" }), json(200, NONE));
    const { c, slept } = client(fetch);
    expect(await c.reviews("2026-11-01", 1)).toEqual([]);
    expect(sent.map((s) => s.method)).toEqual(["POST", "POST", "GET", "GET", "GET"]);
    expect(slept).toEqual([1000, 1000, 60_000]);
    const more = scripted(json(503, {}, { "retry-after": "soon" }), json(504, {}, { "retry-after": "0" }), json(503, {}, { "retry-after": "-3" }), json(504, {}));
    const again = client(more.fetch);
    await expect(again.c.loyaltyCustomers(null)).rejects.toMatchObject({ status: 504 });
    expect(more.sent).toHaveLength(4);
    expect(again.slept).toEqual([1000, 2000, 4000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const { fetch, sent } = scripted(json(400, {}));
    await expect(client(fetch).c.loyaltyCustomers(null)).rejects.toMatchObject({ status: 400 });
    expect(sent).toHaveLength(1);
    const again = scripted(json(429, {}));
    await expect(client(again.fetch, { retries: 1 }).c.loyaltyCustomers(null)).rejects.toMatchObject({ status: 429 });
    expect(again.sent).toHaveLength(2);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "0.001" }), json(200, LOYAL));
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await yotpoClient({ storeId: STORE, apiSecret: SECRET, loyaltyGuid: GUID, loyaltyApiKey: LOYALTY_KEY }).loyaltyCustomers(null)).toEqual({ rows: [], next: null });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(2);
  });

  it("only ever asks for a token and reads reviews and Loyalty members", async () => {
    const mock = yotpoDocMock(store());
    await runSync({ connector: connector(mock), mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).origin}${new URL(c.url).pathname}`))).toEqual(
      new Set([`POST https://api.yotpo.com/core/v3/stores/${STORE}/access_tokens`, `GET https://api.yotpo.com/v1/apps/${STORE}/reviews`, "GET https://loyalty.yotpo.com/api/v2/customers/recent"]),
    );
  });
});

describe("Yotpo reading helpers", () => {
  it("reads Yotpo's ids", () => {
    expect(yotpoId(5)).toBe("5");
    expect(yotpoId("123")).toBe("123");
    expect(yotpoId("1".repeat(18))).toBe("1".repeat(18));
    for (const bad of [0, -1, 1.5, 2 ** 53, "0", "012", "1".repeat(19), "12a", "", null]) expect(yotpoId(bad), String(bad)).toBeUndefined();
  });

  it("reads HTML entities back", () => {
    expect(yotpoText("Couldn&#x27;t &amp; won&#39;t &lt;3 &quot;so&quot; &apos;good&apos;&nbsp;!")).toBe("Couldn't & won't <3 \"so\" 'good' !");
    expect(yotpoText("&#X41;&AMP;&gt;")).toBe("A&>");
    expect(yotpoText("&bogus; &unknown;")).toBe("&bogus; &unknown;");
    expect(yotpoText("&unknown; &#0; &#x110000; &#1114111;")).toBe(`&unknown; &#0; &#x110000; ${String.fromCodePoint(0x10ffff)}`);
    expect(yotpoText("&#x1F48E; ring")).toBe("💎 ring");
    expect(yotpoText(5)).toBeUndefined();
  });
});

describe("Yotpo events", () => {
  const review = () => {
    yotpoReview.reset();
    return yotpoReview.one({ created_at: "2026-11-09T15:00:00.000Z", updated_at: "2026-11-09T16:00:00.000Z" });
  };
  const member = () => {
    yotpoMember.reset();
    return yotpoMember.one();
  };

  it("logs a review as Yext and Birdeye do, with the reviewer as a customer reference and no name", () => {
    const r = review();
    const { ok, event } = yotpoReviewEvent(r, ctx);
    expect(ok).toBe(true);
    expect(event).toMatchObject({ type: YOTPO_REVIEW_EVENT, occurredAt: "2026-11-09T15:00:00.000Z", receivedAt: RECEIVED });
    expect(event.payload).toEqual({
      system: "Yotpo",
      reviewId: "yotpo:review:100001",
      publisher: "Yotpo",
      kind: "product",
      productSku: "RING-0001",
      rating: 5,
      title: "Beautiful ring",
      excerpt: "The setting is perfect and it arrived early. Couldn't be happier!",
      sentiment: 0.93,
      verifiedBuyer: true,
      incentivized: false,
      incentiveType: undefined,
      votesUp: 1,
      votesDown: 0,
      published: true,
      escalated: false,
      customerRefs: formCustomerRefs(CUSTOMER_KEY, { email: synthetic.email(1) }),
      publishedAt: "2026-11-09T15:00:00.000Z",
      editedAt: "2026-11-09T16:00:00.000Z",
    });
    const all = JSON.stringify(event);
    for (const kept of [synthetic.email(1), synthetic.name(1)]) expect(all).not.toContain(kept);
    expect(YOTPO_REVIEW_EVENT).toBe("review.updated");
    expect(event.idempotencyKey).toMatch(/^yotpo:review:100001:[0-9a-f]{12}$/);
    expect(event.id).toBe(event.idempotencyKey.replace(/:/g, "_"));
    assertSynthetic(r);
  });

  it("masks contact details, tells site reviews apart, and reads incentives and status", () => {
    const r = review();
    const payload = yotpoReviewEvent(
      { ...r, sku: "yotpo_site_reviews", title: "Call me 212-555-0123", content: `Email me at ${synthetic.email(2)} please`, reviewer_type: "verified_reviewer", is_incentivized: true, incentive_type: "coupon", archived: true, escalated: true, sentiment: 1 },
      ctx,
    ).event.payload;
    expect(payload).toMatchObject({ kind: "site", productSku: undefined, verifiedBuyer: false, incentivized: true, incentiveType: "coupon", published: false, escalated: true, sentiment: 1 });
    expect(yotpoReviewEvent({ ...r, escalated: "yes" }, ctx).event.payload.escalated).toBe(false);
    expect(payload.title).toBe("Call me [phone]");
    expect(payload.excerpt).toBe("Email me at [email] please");
    expect(yotpoReviewEvent({ ...r, deleted: true }, ctx).event.payload.published).toBe(false);
    expect(yotpoReviewEvent({ ...r, is_incentivized: "yes", incentive_type: "cash", sentiment: 1.2, votes_up: -1, votes_down: 1.5, sku: "bad\nsku", email: "nope", updated_at: "later" }, ctx).event.payload).toMatchObject({
      incentivized: false,
      incentiveType: undefined,
      sentiment: undefined,
      votesUp: undefined,
      votesDown: undefined,
      productSku: undefined,
      customerRefs: [],
      editedAt: undefined,
    });
    expect(yotpoReviewEvent({ ...r, sentiment: 0, sku: "a".repeat(60) }, ctx).event.payload).toMatchObject({ sentiment: 0, productSku: "a".repeat(60) });
    expect(yotpoReviewEvent({ ...r, sku: "a".repeat(61) }, ctx).event.payload.productSku).toBeUndefined();
    expect(yotpoReviewEvent({ ...r, sku: " Ring 14k/18k #2 & band+ " }, ctx).event.payload.productSku).toBe("Ring 14k/18k #2 & band+");
    expect(yotpoReviewEvent({ ...r, title: "x".repeat(300) }, ctx).event.payload.title).toBe("x".repeat(200));
  });

  it("logs a Loyalty member's points and tier, with references for both contact details and no name or birthday", () => {
    const m = member();
    const { ok, event } = yotpoLoyaltyEvent(m, ctx);
    expect(ok).toBe(true);
    expect(event).toMatchObject({ type: YOTPO_LOYALTY_EVENT, occurredAt: RECEIVED, receivedAt: RECEIVED });
    expect(event.payload).toEqual({
      system: "Yotpo",
      loyaltyCustomerId: "yotpo:loyalty_customer:5000001",
      customerRefs: formCustomerRefs(CUSTOMER_KEY, { email: synthetic.email(1), phone: m.phone_number }).sort(),
      pointsBalance: 450,
      pointsEarned: 1250,
      pointsExpireAt: undefined,
      perksRedeemed: 1,
      vipTier: "Gold",
      vipTierSince: synthetic.isoTime(60 - 6000),
      vipTierUntil: undefined,
      totalSpendCents: 125_000,
      totalPurchases: 2,
      lastPurchaseAt: synthetic.isoTime(60 - 600),
      lastSeenAt: synthetic.isoTime(60),
      optedIn: true,
      hasStoreAccount: true,
    });
    expect(event.payload.customerRefs).toHaveLength(2);
    const all = JSON.stringify(event);
    for (const kept of [synthetic.email(1), "Customer 1", String(m.phone_number), "7000001", "birth"]) expect(all).not.toContain(kept);
    expect(YOTPO_LOYALTY_EVENT).toBe("loyalty.customer_updated");
    expect(event.idempotencyKey).toMatch(/^yotpo:loyalty_customer:5000001:[0-9a-f]{12}$/);
    assertSynthetic(m);
  });

  it("drops what doesn't read on a member, and keeps one reference when both details are the same person", () => {
    const m = member();
    expect(yotpoLoyaltyEvent({ ...m, points_balance: -1, points_earned: "5", perks_redeemed: 1.5, vip_tier_name: "<b>VIP</b>", total_spend_cents: null, opt_in: "true", has_store_account: 1, points_expire_at: "2027-01-01T00:00:00Z", email: undefined, phone_number: "12" }, ctx).event.payload).toMatchObject({
      pointsBalance: undefined,
      pointsEarned: undefined,
      perksRedeemed: undefined,
      vipTier: undefined,
      totalSpendCents: undefined,
      optedIn: false,
      hasStoreAccount: false,
      pointsExpireAt: "2027-01-01T00:00:00.000Z",
      customerRefs: [],
    });
    expect(yotpoLoyaltyEvent({ ...m, vip_tier_name: "x".repeat(41) }, ctx).event.payload.vipTier).toBeUndefined();
    expect(yotpoLoyaltyEvent({ ...m, vip_tier_name: "x".repeat(40), points_balance: 0 }, ctx).event.payload).toMatchObject({ vipTier: "x".repeat(40), pointsBalance: 0 });
    const refs = yotpoLoyaltyEvent({ ...m, phone_number: undefined, email: synthetic.email(3) }, ctx).event.payload.customerRefs as string[];
    expect(refs).toEqual(formCustomerRefs(CUSTOMER_KEY, { email: synthetic.email(3) }));
    const both = yotpoLoyaltyEvent({ ...m, email: "b@example.test", phone_number: "+12125550111" }, ctx).event.payload.customerRefs as string[];
    expect(both).toEqual([...both].sort());
  });

  it("is a duplicate when read again unchanged, and a new event when it changes", () => {
    const r = review();
    const m = member();
    expect(yotpoReviewEvent(structuredClone(r), { ...ctx, receivedAt: "2026-11-11T00:00:00.000Z" }).event.idempotencyKey).toBe(yotpoReviewEvent(r, ctx).event.idempotencyKey);
    expect(yotpoReviewEvent({ ...r, score: 4 }, ctx).event.idempotencyKey).not.toBe(yotpoReviewEvent(r, ctx).event.idempotencyKey);
    expect(yotpoLoyaltyEvent(structuredClone(m), { ...ctx, receivedAt: "2026-11-11T00:00:00.000Z" }).event.idempotencyKey).toBe(yotpoLoyaltyEvent(m, ctx).event.idempotencyKey);
    expect(yotpoLoyaltyEvent({ ...m, points_balance: 500 }, ctx).event.idempotencyKey).not.toBe(yotpoLoyaltyEvent(m, ctx).event.idempotencyKey);
  });

  it("dead-letters a review or member it can't read, saying why", () => {
    const r = review();
    const notObject = yotpoReviewEvent("review", ctx);
    expect(notObject.ok).toBe(false);
    expect(notObject.event).toMatchObject({ type: YOTPO_REVIEW_EVENT, occurredAt: undefined, payload: { system: "Yotpo", reviewId: null } });
    expect(notObject.event.payload.problems).toEqual(["review is not an object", "review has no id that reads", "review has no rating from 1 to 5", "review has no time that reads"]);
    expect(notObject.event.idempotencyKey).toMatch(/^yotpo:unreadable_review:[0-9a-f]{12}$/);
    for (const score of [0, 6, 4.5, "5", null]) expect(yotpoReviewEvent({ ...r, score }, ctx).event.payload.problems, String(score)).toEqual(["review has no rating from 1 to 5"]);
    for (const score of [1, 5]) expect(yotpoReviewEvent({ ...r, score }, ctx).ok).toBe(true);
    expect(yotpoReviewEvent({ ...r, created_at: "yesterday" }, ctx).event.payload).toEqual({ system: "Yotpo", reviewId: "100001", problems: ["review has no time that reads"] });
    const noMember = yotpoLoyaltyEvent([], ctx);
    expect(noMember.ok).toBe(false);
    expect(noMember.event).toMatchObject({ type: YOTPO_LOYALTY_EVENT, occurredAt: undefined, payload: { system: "Yotpo", loyaltyCustomerId: null, problems: ["customer is not an object", "customer has no id that reads"] } });
    expect(noMember.event.idempotencyKey).toMatch(/^yotpo:unreadable_loyalty_customer:[0-9a-f]{12}$/);
    expect(yotpoLoyaltyEvent({ ...member(), yotpo_customer_id: "x" }, ctx).event.payload.problems).toEqual(["customer has no id that reads"]);
    // Two unreadable reviews apart only in what isn't kept still get their own keys.
    expect(yotpoReviewEvent({ ...r, id: null, name: "A" }, ctx).event.idempotencyKey).not.toBe(yotpoReviewEvent({ ...r, id: null, name: "B" }, ctx).event.idempotencyKey);
  });
});

describe("Yotpo checkpoint", () => {
  const pass = { since: "2021-11-10", step: 0 as const, page: 3, pageInfo: null };
  const nextFrom = "2026-11-08";

  it("round-trips and turns down any other shape", () => {
    const c: YotpoCursor = { pass, done: false, nextFrom };
    expect(parseYotpoCursor(JSON.stringify(c))).toEqual(c);
    expect(parseYotpoCursor(JSON.stringify({ pass: { ...pass, step: 1, pageInfo: "abc", extra: 1 }, done: true, nextFrom }))).toEqual({ pass: { ...pass, step: 1, pageInfo: "abc" }, done: true, nextFrom });
    expect(parseYotpoCursor(JSON.stringify({ pass: null, done: true, nextFrom }))).toEqual({ pass: null, done: true, nextFrom });
    expect(parseYotpoCursor(null)).toBeNull();
    for (const bad of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ pass: null, done: true }),
      JSON.stringify({ pass: null, done: "yes", nextFrom }),
      JSON.stringify({ pass: null, done: true, nextFrom: "2026-02-30" }),
      JSON.stringify({ pass: null, done: true, nextFrom: "x2026-11-08" }),
      JSON.stringify({ done: true, nextFrom }),
      JSON.stringify({ pass: "x", done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, since: "2021-1-10" }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, step: 2 }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, step: "0" }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, page: 0 }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, page: 1.5 }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, pageInfo: 3 }, done: false, nextFrom }),
    ]) {
      expect(() => parseYotpoCursor(bad), bad).toThrow("Yotpo checkpoint is not in the expected shape");
    }
  });
});

describe("Yotpo connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(yotpoDocMock(store())), expected: { ingested: 4 } });
    expect(result.full.ingested).toBe(4);
  });

  it("imports five years of reviews, then the members Loyalty lists, then stops for good", async () => {
    const mock = yotpoDocMock(store());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(4);
    expect(mock.reads).toEqual([
      { list: "reviews", query: { since_updated_at: "2021-11-10", count: "100", page: "1", deleted: "true" } },
      { list: "loyalty", query: { per_page: "500" } },
    ]);
    expect(parseYotpoCursor(report.cursor)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08" });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested + again.duplicates).toBe(0);
  });

  it("reads 100 reviews a page, keeping the page in the checkpoint, and resumes there", async () => {
    yotpoReview.reset();
    const data = store({ reviews: yotpoReview.many(YOTPO_REVIEW_PAGE + 1, () => ({ updated_at: daysAgo(1), created_at: daysAgo(1) })) });
    const batches = await drain(connector(yotpoDocMock(data)).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([100, 1, 1]);
    expect(batches.map((b) => parseYotpoCursor(b.cursor ?? null))).toEqual([
      { pass: { since: "2021-11-10", step: 0, page: 2, pageInfo: null }, done: false, nextFrom: "2026-11-08" },
      { pass: { since: "2021-11-10", step: 1, page: 1, pageInfo: null }, done: false, nextFrom: "2026-11-08" },
      { pass: null, done: true, nextFrom: "2026-11-08" },
    ]);
    const resumed = yotpoDocMock(data);
    const rest = await drain(connector(resumed).historicalImport({ cursor: batches[0]!.cursor ?? null } as never));
    expect(eventsOf(rest)).toHaveLength(2);
    expect(resumed.reads[0]!.query.page).toBe("2");
  });

  it("reads every Loyalty page by its cursor, keeping it in the checkpoint", async () => {
    yotpoMember.reset();
    const data = store({ members: yotpoMember.many(YOTPO_LOYALTY_PAGE + 1, () => ({ updated_at: daysAgo(1) })) });
    const batches = await drain(connector(yotpoDocMock(data)).incrementalSync({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([1, 500, 1]);
    expect(parseYotpoCursor(batches[1]!.cursor ?? null)).toEqual({ pass: { since: "2026-11-08", step: 1, page: 1, pageInfo: Buffer.from("offset:500").toString("base64url") }, done: false, nextFrom: "2026-11-08" });
    const resumed = yotpoDocMock(data);
    const rest = await drain(connector(resumed).incrementalSync({ cursor: batches[1]!.cursor ?? null } as never));
    expect(resumed.reads).toEqual([{ list: "loyalty", query: { per_page: "500", page_info: Buffer.from("offset:500").toString("base64url") } }]);
    expect(eventsOf(rest)).toHaveLength(1);
  });

  it("stops paging reviews at the last page Yotpo lets a pass ask for", async () => {
    const pages: number[] = [];
    const full = Array.from({ length: YOTPO_REVIEW_PAGE }, () => ({}));
    const client: YotpoClient = { loyalty: false, reviews: async (_s, p) => (pages.push(p), full), loyaltyCustomers: async () => ({ rows: [], next: null }) };
    const cursor = JSON.stringify({ pass: { since: "2026-11-01", step: 0, page: YOTPO_MAX_PAGE - 1, pageInfo: null }, done: true, nextFrom: "2026-11-01" } satisfies YotpoCursor);
    const batches = await drain(yotpoConnector({ storeId: STORE, apiSecret: SECRET, customerKey: CUSTOMER_KEY, client, now: NOW }).incrementalSync({ cursor } as never));
    expect(pages).toEqual([YOTPO_MAX_PAGE - 1, YOTPO_MAX_PAGE]);
    expect(parseYotpoCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-01" });
  });

  it("reads reviews only when Loyalty isn't set up", async () => {
    const mock = yotpoDocMock(store());
    const batches = await drain(connector(mock, { loyaltyGuid: undefined, loyaltyApiKey: undefined }).incrementalSync({ cursor: null } as never));
    expect(mock.reads.map((r) => r.list)).toEqual(["reviews"]);
    expect(batches).toHaveLength(1);
    expect(parseYotpoCursor(batches[0]!.cursor ?? null)).toEqual({ pass: null, done: false, nextFrom: "2026-11-08" });
  });

  it("starts later syncs two days back, then from where each pass began, less two days", async () => {
    const data = store();
    const mock = yotpoDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    data.reviews[0]!.score = 2;
    const later = () => new Date(NOW().getTime() + 3 * DAY_MS);
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // Each mode keeps its own checkpoint, so the first later sync looks back two days.
    expect(mock.reads[2]!.query.since_updated_at).toBe("2026-11-11");
    expect(sync.ingested).toBe(0);
    expect(parseYotpoCursor(sync.cursor)).toEqual({ pass: null, done: false, nextFrom: "2026-11-11" });
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline: testPipeline().pipeline, memory: testPipeline().memory, organizationId: TEST_ORG });
    expect(first.ingested).toBe(2);
    expect(YOTPO_OVERLAP_DAYS).toBe(2);
    const followOn = mock.reads.length;
    await drain(connector(mock).incrementalSync({ cursor: JSON.stringify({ pass: null, done: true, nextFrom: "2026-10-01" }) } as never));
    expect(mock.reads[followOn]!.query.since_updated_at).toBe("2026-10-01");
    // The next pass starts two days before this one, not where this one started.
    const batches = await drain(connector(mock).incrementalSync({ cursor: JSON.stringify({ pass: null, done: true, nextFrom: "2026-10-01" }) } as never));
    expect(parseYotpoCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08" });
  });

  it("resumes a later sync part way, keeping what it says of the import", async () => {
    const mock = yotpoDocMock(store());
    const cursor = JSON.stringify({ pass: { since: "2026-11-01", step: 1, page: 1, pageInfo: null }, done: true, nextFrom: "2026-10-30" } satisfies YotpoCursor);
    const batches = await drain(connector(mock).incrementalSync({ cursor } as never));
    expect(mock.reads).toEqual([{ list: "loyalty", query: { per_page: "500" } }]);
    expect(parseYotpoCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-10-30" });
    const imported = await drain(connector(yotpoDocMock(store())).historicalImport({ cursor: JSON.stringify({ pass: { since: "2026-11-01", step: 0, page: 1, pageInfo: null }, done: false, nextFrom: "2026-10-30" }) } as never));
    expect(imported.map((b) => parseYotpoCursor(b.cursor ?? null)!.done)).toEqual([false, true]);
  });

  it("keeps saying the import is done through a later sync's pages", async () => {
    const mock = yotpoDocMock(store());
    const batches = await drain(connector(mock).incrementalSync({ cursor: JSON.stringify({ pass: null, done: true, nextFrom: "2026-11-01" }) } as never));
    expect(batches.map((b) => parseYotpoCursor(b.cursor ?? null)!.done)).toEqual([true, true]);
  });

  it("dead-letters what it can't read and carries on", async () => {
    const data = store();
    data.reviews.push(yotpoReview.one({ score: 9, updated_at: daysAgo(1) }));
    const mock = yotpoDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(2);
    expect(report.deadLettered).toBe(1);
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = yotpoDocMock(store({ rateLimits: 2 }));
    const slept: number[] = [];
    await drain(connector(mock, { sleep: async (ms) => void slept.push(ms) }).incrementalSync({ cursor: null } as never));
    expect(slept).toEqual([1000, 1000]);
  });

  it("stops on turned-down credentials or a revoked token", async () => {
    await expect(drain(connector(yotpoDocMock(store({ apiSecret: "z".repeat(32) }))).incrementalSync({ cursor: null } as never))).rejects.toThrow(YotpoConfigError);
    await expect(drain(connector(yotpoDocMock(store({ storeId: "otherStore00" }))).incrementalSync({ cursor: null } as never))).rejects.toThrow("Yotpo turned down the store's credentials (HTTP 404)");
    await expect(drain(connector(yotpoDocMock(store({ loyaltyApiKey: "z".repeat(20) }))).incrementalSync({ cursor: null } as never))).rejects.toMatchObject({ status: 401 });
    const mock = yotpoDocMock(store());
    const c = connector(mock);
    await drain(c.incrementalSync({ cursor: null } as never));
    mock.revokeTokens();
    await expect(drain(c.incrementalSync({ cursor: null } as never))).rejects.toMatchObject({ status: 401 });
    await drain(c.incrementalSync({ cursor: null } as never));
    expect(mock.signIns).toBe(2);
  });

  it("checks its settings", () => {
    const mock = yotpoDocMock(store());
    expect(() => connector(mock, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY");
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { apiSecret: "x" })).toThrow("YOTPO_API_SECRET");
    expect(() => connector(mock, { apiSecret: "x", client: { loyalty: false } as YotpoClient })).not.toThrow();
    expect(connector(mock).source).toBe("yotpo");
  });

  it("reads back as far as told, and up to today when no clock is given", async () => {
    const mock = yotpoDocMock(store());
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(mock.reads[0]!.query.since_updated_at).toBe("2025-11-10");
    const since: string[] = [];
    const client: YotpoClient = { loyalty: false, reviews: async (s) => (since.push(s), []), loyaltyCustomers: async () => ({ rows: [], next: null }) };
    await drain(yotpoConnector({ storeId: STORE, apiSecret: SECRET, customerKey: CUSTOMER_KEY, client }).incrementalSync({ cursor: null } as never));
    expect(since).toEqual([new Date(Date.now() - 2 * DAY_MS).toISOString().slice(0, 10)]);
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(YOTPO_WRITES.map((w) => w.name)).toEqual(["reply_to_review", "adjust_points"]);
    const c = connector(yotpoDocMock(store()));
    expect(c.writes).toBe(YOTPO_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "reply_to_review", integration: "yotpo", outcome: "refused" },
      { action: "adjust_points", integration: "yotpo", outcome: "refused" },
    ]);
  });
});

describe("Yotpo doc mock", () => {
  it("checks the secret, the token, the Loyalty key and the filters", async () => {
    const mock = yotpoDocMock(store());
    const sign = (secret: unknown, storeId = STORE) => mock.fetch(`https://api.yotpo.com/core/v3/stores/${storeId}/access_tokens`, { method: "POST", body: typeof secret === "string" ? JSON.stringify({ secret }) : String(secret) });
    expect((await sign("wrong")).status).toBe(401);
    expect((await sign("{bad", STORE)).status).toBe(401);
    expect((await mock.fetch(`https://api.yotpo.com/core/v3/stores/${STORE}/access_tokens`, { method: "POST", body: "not json" })).status).toBe(401);
    expect((await sign(SECRET, "other")).status).toBe(404);
    const token = ((await (await sign(SECRET)).json()) as { access_token: string }).access_token;
    const get = (q: string, t = token, storeId = STORE) => mock.fetch(`https://api.yotpo.com/v1/apps/${storeId}/reviews${q}`, { headers: { "x-yotpo-token": t } });
    expect((await get("", "nope")).status).toBe(401);
    expect((await get("", token, "other")).status).toBe(404);
    for (const q of ["?since_updated_at=2026-1-1", "?count=101", "?page=0", "?sort=desc"]) expect((await get(q)).status, q).toBe(400);
    const page = (await (await get("?count=2&page=2")).json()) as { reviews: Record<string, unknown>[] };
    expect(page.reviews).toHaveLength(2);
    expect(page.reviews[0]).not.toHaveProperty("deleted");
    const recent = (h: Record<string, string>, q = "") => mock.fetch(`https://loyalty.yotpo.com/api/v2/customers/recent${q}`, { headers: h });
    expect((await recent({ "x-guid": GUID, "x-api-key": "wrong" })).status).toBe(401);
    expect((await recent({ "x-guid": GUID, "x-api-key": LOYALTY_KEY }, "?per_page=501")).status).toBe(400);
    expect((await recent({ "x-guid": GUID, "x-api-key": LOYALTY_KEY }, "?page_info=!!")).status).toBe(400);
    expect((await recent({ "x-guid": GUID, "x-api-key": LOYALTY_KEY }, "?since=1")).status).toBe(400);
    const members = (await (await recent({ "x-guid": GUID, "x-api-key": LOYALTY_KEY })).json()) as { customers: Record<string, unknown>[] };
    expect(members.customers).toHaveLength(1);
    expect(members.customers[0]).not.toHaveProperty("updated_at");
    const none = yotpoDocMock(store({ loyaltyGuid: undefined, loyaltyApiKey: undefined }));
    expect((await none.fetch("https://loyalty.yotpo.com/api/v2/customers/recent", { headers: { "x-guid": "", "x-api-key": "" } })).status).toBe(401);
  });
});
