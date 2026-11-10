import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertWritesRefused, checkConnectorSync, judgemeDocMock, judgemeReview, synthetic, testPipeline, type JudgemeMock, type JudgemeMockData } from "@karatos/connector-testkit";
import {
  JUDGEME_API_URL,
  JUDGEME_FOLLOW_UP_RATING,
  JUDGEME_MAX_PAGE,
  JUDGEME_OVERLAP_DAYS,
  JUDGEME_REVIEW_EVENT,
  JUDGEME_REVIEW_PAGE,
  JUDGEME_WRITES,
  JudgemeApiError,
  JudgemeConfigError,
  formCustomerRefs,
  judgemeClient,
  judgemeConnector,
  judgemeId,
  judgemeReviewEvent,
  parseJudgemeCursor,
  type JudgemeClient,
  type JudgemeCursor,
  type JudgemeEvent,
  type JudgemeOptions,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const SHOP = ["test-shop", "myshopify", "com"].join(".");
const TOKEN = ["jm", "test", "0".repeat(20)].join("_");
const CUSTOMER_KEY = "c".repeat(40);
const NOW = () => new Date("2026-11-10T15:00:00.000Z");
const RECEIVED = "2026-11-10T15:00:00.000Z";
const DAY_MS = 86_400_000;
const noSleep = async () => {};
const ctx = { customerKey: CUSTOMER_KEY, receivedAt: RECEIVED };

/** `ago` days before NOW. */
const daysAgo = (ago: number) => new Date(NOW().getTime() - ago * DAY_MS).toISOString();

/** Reviews posted 1, 30 and 1,000 days ago and six years ago. */
function shop(overrides: Partial<JudgemeMockData> = {}): JudgemeMockData {
  judgemeReview.reset();
  return {
    shopDomain: SHOP,
    apiToken: TOKEN,
    reviews: [1, 30, 1000, 2200].map((ago) => judgemeReview.one({ created_at: daysAgo(ago), updated_at: daysAgo(ago) })),
    ...overrides,
  };
}

const connector = (mock: JudgemeMock, overrides: Partial<JudgemeOptions> = {}) => judgemeConnector({ shopDomain: SHOP, apiToken: TOKEN, customerKey: CUSTOMER_KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });

const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as JudgemeEvent[];

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
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof judgemeClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = judgemeClient({ shopDomain: SHOP, apiToken: TOKEN, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const url = (page: number) => `${JUDGEME_API_URL}/reviews?shop_domain=${SHOP}&api_token=${TOKEN}&per_page=100&page=${page}`;

describe("Judge.me client", () => {
  it("checks its settings before sending anything", () => {
    const { fetch, sent } = scripted(json(200, { reviews: [] }));
    const make = (o: Partial<Parameters<typeof judgemeClient>[0]>) => () => judgemeClient({ shopDomain: SHOP, apiToken: TOKEN, fetch, ...o });
    for (const shopDomain of ["", "shop", "-shop.myshopify.com", "shop.-x.com", "a.b.c.d.e.f", "shop.myshopify.com/x", "shop .com", `${"a".repeat(64)}.com`, `x.${"a".repeat(64)}`, "shop_x.com", "_shop.com", "https://shop.com", undefined]) {
      expect(make({ shopDomain: shopDomain as string }), String(shopDomain)).toThrow("JUDGEME_SHOP_DOMAIN is missing or not a domain such as example.myshopify.com");
    }
    for (const apiToken of ["", "a".repeat(15), "a".repeat(129), `${TOKEN}!`, `${TOKEN} x`, undefined]) expect(make({ apiToken: apiToken as string }), String(apiToken)).toThrow("JUDGEME_API_TOKEN is missing or not in the expected shape");
    expect(make({ apiToken: "" })).toThrow(JudgemeConfigError);
    for (const ok of [{ shopDomain: "a.co" }, { shopDomain: `${"a".repeat(63)}.com` }, { shopDomain: "a-b.c-d.e.f.gh" }, { shopDomain: " Shop-1.MyShopify.com " }, { apiToken: "a".repeat(16) }, { apiToken: "a".repeat(128) }, { apiToken: ` ${TOKEN} ` }]) expect(make(ok)).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("lists a page of reviews with the shop and token in the query, as Judge.me documents", async () => {
    const { fetch, sent } = scripted(json(200, { current_page: 3, per_page: 100, reviews: [{ id: 1 }] }), json(200, { reviews: [] }));
    const { c } = client(fetch, { shopDomain: ` ${SHOP.toUpperCase()} `, apiToken: ` ${TOKEN}` });
    expect(await c.reviews(3)).toEqual([{ id: 1 }]);
    expect(await c.reviews(JUDGEME_MAX_PAGE)).toEqual([]);
    expect(sent[0]).toEqual({ url: url(3), method: "GET", headers: { accept: "application/json" }, body: undefined });
    expect(sent[1]!.url).toBe(url(JUDGEME_MAX_PAGE));
    expect(JUDGEME_API_URL).toBe("https://api.judge.me/api/v1");
    expect(JUDGEME_REVIEW_PAGE).toBe(100);
    expect(JUDGEME_MAX_PAGE).toBe(5000);
  });

  it("checks pages before sending", async () => {
    const { fetch, sent } = scripted(json(200, { reviews: [] }));
    const { c } = client(fetch);
    for (const page of [0, -1, 1.5, JUDGEME_MAX_PAGE + 1, Number.NaN]) await expect(c.reviews(page), String(page)).rejects.toThrow(`a reviews page must be 1 to ${JUDGEME_MAX_PAGE}`);
    await expect(c.reviews(0)).rejects.toBeInstanceOf(JudgemeApiError);
    expect(sent).toHaveLength(0);
  });

  it("says when the list is missing, or Judge.me answers another page", async () => {
    for (const answer of [json(200, {}), json(200, []), json(200, { reviews: {} }), json(200, null), text(200, "<html>")]) {
      await expect(client(scripted(answer).fetch).c.reviews(1)).rejects.toThrow("Judge.me answered the reviews without the reviews list");
    }
    await expect(client(scripted(json(200, { current_page: 1, reviews: [] })).fetch).c.reviews(2)).rejects.toThrow("Judge.me answered page 1 when asked for page 2");
    await expect(client(scripted(json(200, { current_page: "x".repeat(40), reviews: [] })).fetch).c.reviews(2)).rejects.toThrow(`Judge.me answered page ${"x".repeat(12)} when asked for page 2`);
    await expect(client(scripted(json(200, { current_page: null, reviews: [] })).fetch).c.reviews(2)).rejects.toThrow("answered page null");
    expect(await client(scripted(json(200, { current_page: "2", reviews: [] })).fetch).c.reviews(2)).toEqual([]);
  });

  it("says when Judge.me turns down the token, without the token or the address", async () => {
    for (const status of [401, 403]) {
      const error = await client(scripted(json(status, { error: "no" })).fetch).c.reviews(1).catch((e: Error) => e);
      expect(error).toBeInstanceOf(JudgemeConfigError);
      expect((error as Error).message).toBe(`Judge.me turned down the token (HTTP ${status}): check JUDGEME_API_TOKEN and JUDGEME_SHOP_DOMAIN`);
    }
    for (const status of [400, 404, 422, 501]) {
      const error = await client(scripted(json(status, { error: TOKEN })).fetch).c.reviews(1).catch((e: Error) => e);
      expect(error).toMatchObject({ name: "JudgemeApiError", status, message: `Judge.me answered HTTP ${status} for the reviews` });
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });

  it("waits out rate limits and server errors, honoring Retry-After up to a minute, then gives up", async () => {
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "5" }), json(500, {}), json(502, {}, { "retry-after": "600" }), json(503, {}), json(200, { reviews: [] }));
    const { c, slept } = client(fetch, { retries: 4 });
    expect(await c.reviews(1)).toEqual([]);
    expect(slept).toEqual([5000, 2000, 60_000, 8000]);
    expect(sent).toHaveLength(5);
    const gave = client(scripted(json(504, {}), json(504, {}), json(504, {}), json(504, {})).fetch);
    await expect(gave.c.reviews(1)).rejects.toMatchObject({ status: 504 });
    expect(gave.slept).toEqual([1000, 2000, 4000]);
    const zero = client(scripted(json(429, {}, { "retry-after": "0" }), json(200, { reviews: [] })).fetch);
    await zero.c.reviews(1);
    expect(zero.slept).toEqual([1000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const once = scripted(json(400, {}));
    await expect(client(once.fetch).c.reviews(1)).rejects.toMatchObject({ status: 400 });
    expect(once.sent).toHaveLength(1);
    const none = scripted(json(500, {}), json(200, { reviews: [] }));
    await expect(client(none.fetch, { retries: 0 }).c.reviews(1)).rejects.toMatchObject({ status: 500 });
    expect(none.sent).toHaveLength(1);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(json(503, {}, { "retry-after": "0.001" }), json(200, { reviews: [] }));
    globalThis.fetch = fetch;
    try {
      expect(await judgemeClient({ shopDomain: SHOP, apiToken: TOKEN }).reviews(1)).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(2);
  });

  it("only ever sends GETs of the review list", async () => {
    const mock = judgemeDocMock(shop());
    await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(mock.fetch.calls.map((c) => [c.method, new URL(c.url).origin + new URL(c.url).pathname])).toEqual([["GET", `${JUDGEME_API_URL}/reviews`]]);
  });
});

describe("Judge.me reading helpers", () => {
  it("reads Judge.me's ids", () => {
    for (const [v, id] of [[1, "1"], [12345, "12345"], ["987", "987"], ["1".repeat(20), "1".repeat(20)]] as const) expect(judgemeId(v)).toBe(id);
    for (const v of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0", "012", "1".repeat(21), "1a", " 1", "", null, undefined, {}]) expect(judgemeId(v), String(v)).toBeUndefined();
  });
});

describe("Judge.me events", () => {
  const review = () => {
    judgemeReview.reset();
    return judgemeReview.one();
  };

  it("logs a review as Yext and Yotpo do, with the reviewer as a customer reference and no name", () => {
    const r = review();
    const { ok, event } = judgemeReviewEvent(r, ctx);
    expect(ok).toBe(true);
    expect(event).toMatchObject({ type: JUDGEME_REVIEW_EVENT, occurredAt: "2026-01-01T01:00:00.000Z", receivedAt: RECEIVED });
    expect(event.payload).toEqual({
      system: "Judge.me",
      reviewId: "judgeme:review:300001",
      publisher: "Judge.me",
      kind: "product",
      productId: "8000000001",
      rating: 5,
      needsFollowUp: false,
      title: "Beautiful ring",
      excerpt: "The setting is perfect and it arrived early.",
      source: "web",
      curated: "ok",
      verification: "buyer",
      verifiedBuyer: true,
      published: true,
      hidden: false,
      photos: 0,
      reviewerRef: "judgeme:reviewer:900001",
      customerRefs: [...formCustomerRefs(CUSTOMER_KEY, { email: synthetic.email(1), phone: "+12125550201" })].sort(),
      publishedAt: "2026-01-01T01:00:00.000Z",
      editedAt: "2026-01-01T01:00:00.000Z",
    });
    expect(event.payload.customerRefs).toHaveLength(2);
    const flat = JSON.stringify(event);
    for (const kept of [synthetic.email(1), synthetic.name(1), "+12125550201", "192.0.2.1", "vip", "7000001"]) expect(flat).not.toContain(kept);
    expect(JUDGEME_REVIEW_EVENT).toBe("review.updated");
  });

  it("marks low ratings for follow-up, masks contact details, and reads status", () => {
    const r = review();
    expect(JUDGEME_FOLLOW_UP_RATING).toBe(2);
    expect([1, 2, 3, 4, 5].map((rating) => judgemeReviewEvent({ ...r, rating }, ctx).event.payload.needsFollowUp)).toEqual([true, true, false, false, false]);
    const payload = judgemeReviewEvent(
      {
        ...r,
        product_external_id: null,
        title: `Call me 212-555-0123 ${"x".repeat(300)}`,
        body: `Email me at ${synthetic.email(2)} please`,
        verified: "email",
        published: true,
        hidden: true,
        source: "Import!",
        curated: "a".repeat(31),
        pictures: [{ urls: { original: "https://example.test/a.jpg" }, hidden: false }, { urls: {}, hidden: true }, { urls: {} }, "x", null],
        reviewer: { id: "x", email: synthetic.email(1), phone: synthetic.email(1) },
      },
      ctx,
    ).event.payload;
    expect(payload).toMatchObject({ kind: "site", productId: undefined, verification: "email", verifiedBuyer: false, published: false, hidden: true, source: undefined, curated: undefined, photos: 2, reviewerRef: undefined });
    expect(payload.title).toMatch(/^Call me \[phone\] x+/);
    expect(String(payload.title).length).toBeLessThanOrEqual(201);
    expect(payload.excerpt).toBe("Email me at [email] please");
    expect(payload.customerRefs).toEqual(formCustomerRefs(CUSTOMER_KEY, { email: synthetic.email(1) }));
    expect(JSON.stringify(payload)).not.toContain("example.test");
    expect(judgemeReviewEvent({ ...r, published: "yes", hidden: "no", verified: "Buyer", product_external_id: "8000000001" }, ctx).event.payload).toMatchObject({ published: false, hidden: false, verification: undefined, verifiedBuyer: false, kind: "product", productId: "8000000001" });
    expect(judgemeReviewEvent({ ...r, reviewer: "x", pictures: "x", title: 5, body: null, updated_at: "later" }, ctx).event.payload).toMatchObject({ customerRefs: [], reviewerRef: undefined, photos: 0, title: undefined, excerpt: undefined, editedAt: undefined });
    for (const reviewer of [undefined, null]) expect(judgemeReviewEvent({ ...r, reviewer }, ctx).event.payload).toMatchObject({ customerRefs: [], reviewerRef: undefined });
    for (const source of ["a", "web_widget", "email-request", "a".repeat(30)]) expect(judgemeReviewEvent({ ...r, source }, ctx).event.payload.source).toBe(source);
    for (const source of ["", "1web", "Web", "we b", 5]) expect(judgemeReviewEvent({ ...r, source }, ctx).event.payload.source).toBeUndefined();
  });

  it("is a duplicate when read again unchanged, and a new event when it changes", () => {
    const r = review();
    const a = judgemeReviewEvent(r, ctx).event;
    expect(judgemeReviewEvent(structuredClone(r), { ...ctx, receivedAt: "2026-11-11T00:00:00.000Z" }).event.idempotencyKey).toBe(a.idempotencyKey);
    expect(judgemeReviewEvent({ ...r, hidden: true }, ctx).event.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(a.idempotencyKey.slice(0, -13)).toBe("judgeme:review:300001");
    expect(a.idempotencyKey.slice(-13)).toMatch(/^:[0-9a-f]{12}$/);
    expect(a.id).toBe(a.idempotencyKey.replace(/:/g, "_"));
    // What isn't kept doesn't change the event.
    expect(judgemeReviewEvent({ ...r, ip_address: "192.0.2.9", featured: true }, ctx).event.idempotencyKey).toBe(a.idempotencyKey);
  });

  it("dead-letters a review it can't read, saying why", () => {
    const r = review();
    const notObject = judgemeReviewEvent("review", ctx);
    expect(notObject.ok).toBe(false);
    expect(notObject.event).toMatchObject({ type: JUDGEME_REVIEW_EVENT, occurredAt: undefined, receivedAt: RECEIVED, payload: { system: "Judge.me", reviewId: null } });
    expect(notObject.event.payload.problems).toEqual(["review has no id that reads", "review has no rating from 1 to 5", "review has no time that reads"]);
    expect(notObject.event.idempotencyKey).toMatch(/^judgeme:unreadable_review:[0-9a-f]{12}$/);
    expect(notObject.event.id).toBe(notObject.event.idempotencyKey.replace(/:/g, "_"));
    for (const rating of [0, 6, 4.5, "5", null]) expect(judgemeReviewEvent({ ...r, rating }, ctx).event.payload.problems, String(rating)).toEqual(["review has no rating from 1 to 5"]);
    for (const rating of [1, 5]) expect(judgemeReviewEvent({ ...r, rating }, ctx).ok).toBe(true);
    expect(judgemeReviewEvent({ ...r, created_at: "yesterday" }, ctx).event.payload).toEqual({ system: "Judge.me", reviewId: "300001", problems: ["review has no time that reads"] });
    // Two unreadable reviews apart only in what isn't kept still get their own keys.
    expect(judgemeReviewEvent({ ...r, id: null, ip_address: "a" }, ctx).event.idempotencyKey).not.toBe(judgemeReviewEvent({ ...r, id: null, ip_address: "b" }, ctx).event.idempotencyKey);
  });
});

describe("Judge.me checkpoint", () => {
  const pass = { since: "2021-11-10", page: 3 };
  const nextFrom = "2026-11-08";

  it("round-trips and turns down any other shape", () => {
    const c: JudgemeCursor = { pass, done: false, nextFrom };
    expect(parseJudgemeCursor(JSON.stringify(c))).toEqual(c);
    expect(parseJudgemeCursor(JSON.stringify({ pass: { ...pass, page: 1, extra: 1 }, done: true, nextFrom }))).toEqual({ pass: { ...pass, page: 1 }, done: true, nextFrom });
    expect(parseJudgemeCursor(JSON.stringify({ pass: null, done: true, nextFrom }))).toEqual({ pass: null, done: true, nextFrom });
    expect(parseJudgemeCursor(null)).toBeNull();
    for (const bad of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ pass: null, done: true }),
      JSON.stringify({ pass: null, done: "yes", nextFrom }),
      JSON.stringify({ pass: null, done: true, nextFrom: "2026-02-30" }),
      JSON.stringify({ pass: null, done: true, nextFrom: "x2026-11-08" }),
      JSON.stringify({ pass: null, done: true, nextFrom: "2026-11-08x" }),
      JSON.stringify({ done: true, nextFrom }),
      JSON.stringify({ pass: "x", done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, since: "2021-1-10" }, done: false, nextFrom }),
      JSON.stringify({ pass: { page: 1 }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, page: 0 }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, page: 1.5 }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, page: "2" }, done: false, nextFrom }),
    ]) {
      expect(() => parseJudgemeCursor(bad), bad).toThrow("Judge.me checkpoint is not in the expected shape");
    }
  });
});

describe("Judge.me connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(judgemeDocMock(shop())), expected: { ingested: 3 } });
    expect(result.full.ingested).toBe(3);
  });

  it("imports five years of reviews, then stops for good", async () => {
    const mock = judgemeDocMock(shop());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(3);
    expect(mock.reads).toEqual([{ shop_domain: SHOP, per_page: "100", page: "1" }]);
    expect(parseJudgemeCursor(report.cursor)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08" });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested + again.duplicates).toBe(0);
    expect(mock.reads).toHaveLength(1);
  });

  it("keeps a review changed since the pass's day, even when it was posted before", async () => {
    const data = shop();
    data.reviews[3]!.updated_at = daysAgo(1);
    data.reviews.push(judgemeReview.one({ created_at: `${new Date(NOW().getTime() - 5 * 365.25 * DAY_MS).toISOString().slice(0, 10)}T00:00:00.000Z`, updated_at: undefined }));
    data.reviews.push(judgemeReview.one({ created_at: "2021-11-09T23:59:59.999Z", updated_at: undefined }));
    const events = eventsOf(await drain(connector(judgemeDocMock(data)).historicalImport({ cursor: null } as never)));
    expect(events.map((e) => e.payload.reviewId)).toEqual(["judgeme:review:300001", "judgeme:review:300002", "judgeme:review:300003", "judgeme:review:300005", "judgeme:review:300004"]);
  });

  it("reads 100 reviews a page, keeping the page in the checkpoint, and resumes there", async () => {
    judgemeReview.reset();
    const data = shop({ reviews: judgemeReview.many(JUDGEME_REVIEW_PAGE * 2 + 1, () => ({ updated_at: daysAgo(1), created_at: daysAgo(1) })) });
    const batches = await drain(connector(judgemeDocMock(data)).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([100, 100, 1]);
    expect(batches.map((b) => parseJudgemeCursor(b.cursor ?? null))).toEqual([
      { pass: { since: "2021-11-10", page: 2 }, done: false, nextFrom: "2026-11-08" },
      { pass: { since: "2021-11-10", page: 3 }, done: false, nextFrom: "2026-11-08" },
      { pass: null, done: true, nextFrom: "2026-11-08" },
    ]);
    const resumed = judgemeDocMock(data);
    const rest = await drain(connector(resumed).historicalImport({ cursor: batches[0]!.cursor ?? null } as never));
    expect(eventsOf(rest)).toHaveLength(101);
    expect(resumed.reads.map((r) => r.page)).toEqual(["2", "3"]);
  });

  it("stops at the last page a pass may ask for, even when it is full", async () => {
    const pages: number[] = [];
    const full = Array.from({ length: JUDGEME_REVIEW_PAGE }, () => ({}));
    const fake: JudgemeClient = { reviews: async (page) => (pages.push(page), full) };
    const batches = await drain(connector(judgemeDocMock(shop()), { client: fake }).historicalImport({ cursor: JSON.stringify({ pass: { since: "2021-11-10", page: JUDGEME_MAX_PAGE - 1 }, done: false, nextFrom: "2026-11-08" }) } as never));
    expect(pages).toEqual([JUDGEME_MAX_PAGE - 1, JUDGEME_MAX_PAGE]);
    expect(parseJudgemeCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08" });
    // Each unreadable row is kept, to be dead-lettered.
    expect(batches[0]!.events).toHaveLength(JUDGEME_REVIEW_PAGE);
  });

  it("starts later syncs two days back, then from where each pass began, less two days", async () => {
    const data = shop();
    const mock = judgemeDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    data.reviews[1]!.rating = 1;
    data.reviews[1]!.updated_at = daysAgo(-2);
    const later = () => new Date(NOW().getTime() + 3 * DAY_MS);
    // Each mode keeps its own checkpoint, so the first later sync keeps the last two days.
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(sync.ingested).toBe(1);
    expect(parseJudgemeCursor(sync.cursor)).toEqual({ pass: null, done: false, nextFrom: "2026-11-11" });
    expect(JUDGEME_OVERLAP_DAYS).toBe(2);
    const fresh = testPipeline();
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline: fresh.pipeline, memory: fresh.memory, organizationId: TEST_ORG });
    expect(first.ingested).toBe(2);
    const batches = await drain(connector(mock).incrementalSync({ cursor: JSON.stringify({ pass: null, done: true, nextFrom: "2026-10-01" }) } as never));
    expect(eventsOf(batches)).toHaveLength(2);
    // The next pass starts two days before this one, not where this one started.
    expect(parseJudgemeCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08" });
  });

  it("resumes a later sync part way, keeping what it says of the import", async () => {
    judgemeReview.reset();
    const data = shop({ reviews: judgemeReview.many(JUDGEME_REVIEW_PAGE + 1, () => ({ updated_at: daysAgo(1), created_at: daysAgo(1) })) });
    for (const done of [true, false]) {
      const mock = judgemeDocMock(data);
      const batches = await drain(connector(mock).incrementalSync({ cursor: JSON.stringify({ pass: { since: "2026-11-01", page: 2 }, done, nextFrom: "2026-11-05" }) } as never));
      expect(mock.reads.map((r) => r.page)).toEqual(["2"]);
      expect(batches.map((b) => parseJudgemeCursor(b.cursor ?? null))).toEqual([{ pass: null, done, nextFrom: "2026-11-05" }]);
    }
    const batches = await drain(connector(judgemeDocMock(data)).incrementalSync({ cursor: JSON.stringify({ pass: null, done: true, nextFrom: "2026-11-05" }) } as never));
    expect(batches.map((b) => parseJudgemeCursor(b.cursor ?? null))).toEqual([
      { pass: { since: "2026-11-05", page: 2 }, done: true, nextFrom: "2026-11-08" },
      { pass: null, done: true, nextFrom: "2026-11-08" },
    ]);
  });

  it("dead-letters what it can't read and carries on", async () => {
    const data = shop();
    data.reviews.push(judgemeReview.one({ rating: 9, created_at: daysAgo(4000), updated_at: daysAgo(4000) }));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(judgemeDocMock(data)), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(1);
    expect(report.deadLettered).toBe(1);
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = judgemeDocMock(shop({ rateLimits: 2 }));
    const slept: number[] = [];
    await drain(connector(mock, { sleep: async (ms) => void slept.push(ms) }).incrementalSync({ cursor: null } as never));
    expect(slept).toEqual([1000, 1000]);
  });

  it("stops on a turned-down token or shop", async () => {
    await expect(drain(connector(judgemeDocMock(shop({ apiToken: "z".repeat(20) }))).incrementalSync({ cursor: null } as never))).rejects.toThrow(JudgemeConfigError);
    await expect(drain(connector(judgemeDocMock(shop({ shopDomain: "other.myshopify.com" }))).incrementalSync({ cursor: null } as never))).rejects.toThrow("Judge.me turned down the token (HTTP 401)");
  });

  it("checks its settings", () => {
    const mock = judgemeDocMock(shop());
    expect(() => connector(mock, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY");
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { apiToken: "x" })).toThrow("JUDGEME_API_TOKEN");
    expect(() => connector(mock, { apiToken: "x", client: {} as JudgemeClient })).not.toThrow();
    expect(connector(mock).source).toBe("judgeme");
  });

  it("reads back as far as told, and up to today when no clock is given", async () => {
    const data = shop();
    const one = await drain(connector(judgemeDocMock(data), { historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(parseJudgemeCursor(one[0]!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08" });
    expect(eventsOf(one)).toHaveLength(2);
    const since: string[] = [];
    const fake: JudgemeClient = { reviews: async () => [] };
    const batches = await drain(judgemeConnector({ shopDomain: SHOP, apiToken: TOKEN, customerKey: CUSTOMER_KEY, client: fake }).incrementalSync({ cursor: null } as never));
    since.push(parseJudgemeCursor(batches[0]!.cursor ?? null)!.nextFrom);
    expect(since).toEqual([new Date(Date.now() - 2 * DAY_MS).toISOString().slice(0, 10)]);
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(JUDGEME_WRITES.map((w) => w.name)).toEqual(["reply_to_review", "set_review_visibility"]);
    const c = connector(judgemeDocMock(shop()));
    expect(c.writes).toBe(JUDGEME_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "reply_to_review", integration: "judgeme", outcome: "refused" },
      { action: "set_review_visibility", integration: "judgeme", outcome: "refused" },
    ]);
  });
});

describe("Judge.me doc mock", () => {
  it("checks the shop, the token and the paging", async () => {
    const mock = judgemeDocMock(shop());
    const get = (q: string) => mock.fetch(`https://api.judge.me/api/v1/reviews?${q}`);
    const auth = `shop_domain=${SHOP}&api_token=${TOKEN}`;
    expect((await get(`shop_domain=${SHOP}&api_token=wrong`)).status).toBe(401);
    expect((await get(`shop_domain=other.com&api_token=${TOKEN}`)).status).toBe(401);
    for (const q of ["per_page=101", "per_page=0", "page=0", "page=1.5"]) expect((await get(`${auth}&${q}`)).status, q).toBe(422);
    expect((await get(`${auth}&since=2026-01-01`)).status).toBe(400);
    const page = (await (await get(`${auth}&per_page=2&page=2`)).json()) as { current_page: number; per_page: number; reviews: Record<string, unknown>[] };
    expect(page).toMatchObject({ current_page: 2, per_page: 2 });
    expect(page.reviews.map((r) => r.id)).toEqual([300003, 300004]);
    const first = (await (await get(auth)).json()) as { reviews: unknown[]; per_page: number };
    expect(first.per_page).toBe(10);
    expect(mock.reads.at(-1)).toEqual({ shop_domain: SHOP });
  });
});
