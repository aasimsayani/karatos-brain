import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { BIRDEYE_TEST_BUSINESS, TEST_ORG, assertSynthetic, assertWritesRefused, birdeyeDocMock, birdeyeMockDate, birdeyeReview, checkConnectorSync, testPipeline, type BirdeyeMock, type BirdeyeMockData } from "@karatos/connector-testkit";
import {
  BIRDEYE_API_URL,
  BIRDEYE_MAX_WINDOW,
  BIRDEYE_OVERLAP_MS,
  BIRDEYE_PAGE_SIZE,
  BIRDEYE_WRITES,
  BirdeyeApiError,
  BirdeyeConfigError,
  birdeyeClient,
  birdeyeConnector,
  birdeyeDay,
  birdeyeErrorCode,
  birdeyeRating,
  birdeyeReviewEvent,
  birdeyeTime,
  parseBirdeyeCursor,
  type BirdeyeClient,
  type BirdeyeCursor,
  type BirdeyeOptions,
  type BirdeyeReviewQuery,
} from "../src/index.js";

// A key-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["bk", "test", "0".repeat(24)].join("_");
const NOW = () => new Date("2026-11-10T15:00:00.000Z");
const RECEIVED = "2026-11-10T15:00:00.000Z";
const CTX = { receivedAt: RECEIVED, businessId: BIRDEYE_TEST_BUSINESS };
const DAY_MS = 86_400_000;
const noSleep = async () => {};
const URL0 = `${BIRDEYE_API_URL}/review/businessId/${BIRDEYE_TEST_BUSINESS}?sindex=0&count=100`;

/** A review posted `ago` days before NOW. */
const posted = (ago: number, extra: Record<string, unknown> = {}) => birdeyeReview.one({ reviewDate: birdeyeMockDate(new Date(NOW().getTime() - ago * DAY_MS).toISOString()), ...extra });

/** Reviews posted 0, 1, 3, 10, 400 and 2000 days ago; the last is past the five years read. */
function business(overrides: Partial<BirdeyeMockData> = {}): BirdeyeMockData {
  birdeyeReview.reset();
  return { apiKey: KEY, reviews: [0, 1, 3, 10, 400, 2000].map((ago) => posted(ago)), ...overrides };
}

const connector = (mock: BirdeyeMock, overrides: Partial<BirdeyeOptions> = {}) =>
  birdeyeConnector({ apiKey: KEY, businessId: BIRDEYE_TEST_BUSINESS, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });

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
    sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body)) });
    const answer = answers[Math.min(sent.length - 1, answers.length - 1)]!;
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof birdeyeClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = birdeyeClient({ apiKey: KEY, businessId: BIRDEYE_TEST_BUSINESS, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const Q: BirdeyeReviewQuery = { fromDate: "11/10/2021", sindex: 0 };

describe("Birdeye client", () => {
  it("checks the key and business before sending anything", () => {
    const { fetch, sent } = scripted(json(200, []));
    for (const apiKey of ["", " ", "short", "a".repeat(15), `${"a".repeat(10)} ${"b".repeat(10)}`, "a".repeat(513), undefined as never]) {
      expect(() => birdeyeClient({ apiKey, businessId: "1", fetch }), String(apiKey)).toThrow(new BirdeyeConfigError("BIRDEYE_API_KEY is missing or not in the expected shape"));
    }
    for (const businessId of ["", "0", "01", "abc", "1.5", "-1", "1".repeat(19), undefined as never]) {
      expect(() => birdeyeClient({ apiKey: KEY, businessId, fetch }), String(businessId)).toThrow(new BirdeyeConfigError("BIRDEYE_BUSINESS_ID must be the business's numeric id"));
    }
    expect(() => birdeyeClient({ apiKey: "a".repeat(16), businessId: "1".repeat(18), fetch })).not.toThrow();
    expect(() => birdeyeClient({ apiKey: "a".repeat(512), businessId: "9", fetch })).not.toThrow();
    expect(sent).toEqual([]);
  });

  it("sends only Get Reviews, with the key in its header and a body it builds", async () => {
    const { fetch, sent } = scripted(json(200, [{ reviewId: 1 }, "x", null, [1], { reviewId: 2 }]));
    const { c } = client(fetch, { apiKey: ` ${KEY} `, businessId: ` ${BIRDEYE_TEST_BUSINESS} ` });
    expect(await c.reviews(Q)).toEqual([{ reviewId: 1 }, { reviewId: 2 }]);
    expect(await c.reviews({ updateFromDate: "01/31/2026", sindex: 200 })).toEqual([{ reviewId: 1 }, { reviewId: 2 }]);
    expect(sent).toEqual([
      { url: URL0, method: "POST", headers: { "x-api-key": KEY, accept: "application/json", "content-type": "application/json" }, body: { fromDate: "11/10/2021", statuses: ["all"] } },
      { url: URL0.replace("sindex=0", "sindex=200"), method: "POST", headers: { "x-api-key": KEY, accept: "application/json", "content-type": "application/json" }, body: { updateFromDate: "01/31/2026", statuses: ["all"] } },
    ]);
  });

  it("turns down a query it shouldn't send", async () => {
    const { fetch, sent } = scripted(json(200, []));
    const { c } = client(fetch);
    for (const sindex of [-1, 1.5, Number.NaN, 2 ** 53]) await expect(c.reviews({ ...Q, sindex }), String(sindex)).rejects.toThrow(new BirdeyeConfigError("sindex must be a whole number from 0"));
    await expect(c.reviews({ sindex: 0 })).rejects.toThrow(new BirdeyeConfigError("give one of fromDate or updateFromDate"));
    await expect(c.reviews({ fromDate: "11/10/2021", updateFromDate: "11/10/2021", sindex: 0 })).rejects.toThrow(new BirdeyeConfigError("give one of fromDate or updateFromDate"));
    for (const day of ["2021-11-10", "13/01/2021", "00/10/2021", "11/32/2021", "11/00/2021", "1/10/2021", "11/10/21", "x11/10/2021", "11/10/2021x", ""]) {
      await expect(c.reviews({ fromDate: day, sindex: 0 }), day).rejects.toThrow(new BirdeyeConfigError("dates must be MM/dd/yyyy"));
      await expect(c.reviews({ updateFromDate: day, sindex: 0 }), day).rejects.toThrow(new BirdeyeConfigError("dates must be MM/dd/yyyy"));
    }
    const past = BIRDEYE_MAX_WINDOW - BIRDEYE_PAGE_SIZE + 1;
    await expect(c.reviews({ ...Q, sindex: past })).rejects.toMatchObject({ name: "BirdeyeApiError", status: 400, message: "Birdeye won't page past 100000 reviews in one read" });
    expect(sent).toEqual([]);
    await c.reviews({ ...Q, sindex: past - 1 });
    for (const day of ["12/31/2021", "02/29/2024", "10/30/2021", "09/19/2021"]) await c.reviews({ fromDate: day, sindex: 0 });
    expect(sent).toHaveLength(5);
  });

  it("waits out a rate limit and a busy gateway, backing off or honoring Retry-After up to a minute", async () => {
    const { fetch, sent } = scripted(json(429, { code: 89, message: "Rate limit exceeded" }), json(502, {}), json(503, {}, { "retry-after": " 7 " }), json(200, [{ reviewId: 1 }]));
    const { c, slept } = client(fetch);
    expect(await c.reviews(Q)).toEqual([{ reviewId: 1 }]);
    expect(sent).toHaveLength(4);
    expect(slept).toEqual([1000, 2000, 7000]);

    const capped = client(scripted(json(504, {}, { "retry-after": "3600" }), json(429, {}, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }), json(429, {}, { "retry-after": "0" }), json(200, [])).fetch);
    expect(await capped.c.reviews(Q)).toEqual([]);
    expect(capped.slept).toEqual([60_000, 2000, 4000]);
    const long = client(scripted(json(429, {}, { "retry-after": "1234567" }), json(200, [])).fetch);
    await long.c.reviews(Q);
    expect(long.slept).toEqual([1000]);
  });

  it("gives up after its retries, keeping Birdeye's code, and doesn't retry other errors", async () => {
    const limited = scripted(json(429, { code: 89, message: "Rate limit exceeded" }));
    await expect(client(limited.fetch).c.reviews(Q)).rejects.toMatchObject({ name: "BirdeyeApiError", status: 429, code: 89, message: "Birdeye kept rate-limiting the review reads; the next sync picks up from the checkpoint" });
    expect(limited.sent).toHaveLength(4);
    const once = scripted(json(503, {}));
    await expect(client(once.fetch, { retries: 0 }).c.reviews(Q)).rejects.toMatchObject({ status: 503, message: "Birdeye reviews answered HTTP 503" });
    expect(once.sent).toHaveLength(1);
    const twice = scripted(json(504, {}));
    await expect(client(twice.fetch, { retries: 1 }).c.reviews(Q)).rejects.toMatchObject({ status: 504 });
    expect(twice.sent).toHaveLength(2);

    for (const [status, body, expected] of [
      [401, { code: 1161, message: "Invalid API key" }, { status: 401, code: 1161, message: "Birdeye turned down the API key: check BIRDEYE_API_KEY" }],
      [404, { code: 1011, message: "Business id is invalid" }, { status: 404, code: 1011, message: "Birdeye doesn't know that business: check BIRDEYE_BUSINESS_ID" }],
      [400, { code: 1186, message: "Invalid fromDate" }, { status: 400, code: 1186, message: "Birdeye reviews answered HTTP 400 (code 1186)" }],
      [400, { code: 0 }, { status: 400, code: 0, message: "Birdeye reviews answered HTTP 400 (code 0)" }],
      [500, "oops", { status: 500, code: undefined, message: "Birdeye reviews answered HTTP 500" }],
      [201, [], { status: 201, message: "Birdeye reviews answered HTTP 201" }],
      [200, { reviews: [] }, { status: 200, message: "Birdeye reviews answered without a list" }],
    ] as const) {
      const one = scripted(json(status, body));
      const error = await client(one.fetch).c.reviews(Q).catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(BirdeyeApiError);
      expect(error, String(status)).toMatchObject(expected);
      expect(one.sent, String(status)).toHaveLength(1);
    }
    const notJson = scripted(() => new Response("<html>", { status: 200 }));
    await expect(client(notJson.fetch).c.reviews(Q)).rejects.toThrow("Birdeye reviews answered without a list");
  });

  it("sleeps for real when no sleep is given", async () => {
    const { fetch } = scripted(json(429, {}, { "retry-after": "1" }), json(200, []));
    const started = Date.now();
    await birdeyeClient({ apiKey: KEY, businessId: "1", fetch }).reviews(Q);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("reads Birdeye's error code only when it is a whole number", () => {
    expect(birdeyeErrorCode({ code: 89 })).toBe(89);
    expect(birdeyeErrorCode({ code: 0 })).toBe(0);
    expect([{ code: -1 }, { code: 1.5 }, { code: "89" }, { code: 2 ** 53 }, [89], null, "89", {}].map(birdeyeErrorCode)).toEqual(Array(8).fill(undefined));
  });
});

describe("Birdeye normalizer", () => {
  it("reads the dates Birdeye writes, turning down days that don't exist", () => {
    expect(birdeyeTime("Jan 20, 2014")).toBe("2014-01-20T00:00:00.000Z");
    expect(birdeyeTime(" sept. 3, 2020 ")).toBe("2020-09-03T00:00:00.000Z");
    expect(birdeyeTime("December 31, 2025")).toBe("2025-12-31T00:00:00.000Z");
    expect(birdeyeTime("02/29/2024")).toBe("2024-02-29T00:00:00.000Z");
    expect(birdeyeTime("2026-11-10T15:00:00Z")).toBe("2026-11-10T15:00:00.000Z");
    expect(birdeyeTime("2026-11-10T23:59:59.5-05:00")).toBe("2026-11-11T04:59:59.500Z");
    expect(birdeyeTime("2026-01-01T00:00:00+14:00")).toBe("2025-12-31T10:00:00.000Z");
    expect(birdeyeTime(`Jan 1, 2026${" ".repeat(29)}`)).toBe("2026-01-01T00:00:00.000Z");
    expect(birdeyeTime("Jan 1, 1970")).toBe("1970-01-01T00:00:00.000Z");
    const bad = [
      "Feb 30, 2026", "Foo 1, 2026", "Ja 1, 2026", "Jan 32, 2026", "Jan 0, 2026", "Jan 1 2026", "Jan 1, 26", "Dec 31, 1969", "Jan 1, 0014",
      "02/30/2026", "13/01/2026", "00/01/2026", "1/1/2026", "01/01/26",
      "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-11-10T24:00:00Z", "2026-11-10T12:60:00Z", "2026-11-10T12:00:60Z", "2026-11-10T12:00:00+15:00", "2026-11-10T12:00:00+05:60",
      "2026-11-10T12:00:00", "2026-11-10", "Jan20, 2026", "Jan  1, 2026", "Jan 1, 20261", "1 Jan 1, 2026", "Apr 31, 2026", "2026-11-10T12:00:00.1234Z", "1969-12-31T23:00:00Z",
      `Jan 1, 2026${" ".repeat(30)}`, "", 5, null, undefined,
    ];
    expect(bad.map(birdeyeTime)).toEqual(Array(bad.length).fill(undefined));
    expect(birdeyeDay("2021-11-10T15:00:00.000Z")).toBe("11/10/2021");
  });

  it("keeps ratings from 0 to 5", () => {
    expect([0, 1, 4.5, 5].map(birdeyeRating)).toEqual([0, 1, 4.5, 5]);
    expect([-0.5, 5.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null].map(birdeyeRating)).toEqual(Array(6).fill(undefined));
  });

  it("turns a review into review.updated without the reviewer, masking what they wrote", () => {
    birdeyeReview.reset();
    const review = birdeyeReview.one();
    const e = birdeyeReviewEvent(review, CTX)!;
    expect(e).toMatchObject({ type: "review.updated", occurredAt: "2026-01-02T00:00:00.000Z", receivedAt: RECEIVED });
    expect(e.payload).toEqual({
      reviewId: "birdeye:review:500001",
      locationId: `birdeye:business:${BIRDEYE_TEST_BUSINESS}`,
      publisher: "Google",
      rating: 2,
      excerpt: "Lovely engagement ring, test review 1. Call me on [phone] or write to [email]",
      edited: false,
      publishedAt: "2026-01-02T00:00:00.000Z",
      repliedAt: "2026-01-03T00:00:00.000Z",
      link: "https://example.com/reviews/1",
      comments: 1,
      ownerReplies: 1,
      awaitingReply: false,
    });
    expect(Object.keys(e.payload)).not.toContain("title");
    expect(e.idempotencyKey).toMatch(/^birdeye:review:500001:[0-9a-f]{16}$/);
    expect(e.id).toBe(`birdeye_review_500001_${e.idempotencyKey.slice(-16)}`);
    const kept = JSON.stringify(e);
    for (const gone of ["Customer 1", "tester1", "avatar", "900001", "anniversary", "Staff", "staff@example.test", "212 555 0101", "Thank you", "customer1@example.test", "ref=test"]) expect(kept, gone).not.toContain(gone);
  });

  it("notes a review awaiting a reply, and whether it was edited", () => {
    const e = birdeyeReviewEvent({ reviewId: "42", rating: 0, response: "  ", responseDate: "Jan 3, 2026", reviewDate: "Jan 2, 2026", reviewOperationalStatus: " updated ", reviewUrl: "https://example.com/r/42?x=1", title: "Hi from me@example.test" }, CTX)!;
    expect(e.payload).toEqual({
      reviewId: "birdeye:review:42",
      locationId: `birdeye:business:${BIRDEYE_TEST_BUSINESS}`,
      rating: 0,
      title: "Hi from [email]",
      edited: true,
      publishedAt: "2026-01-02T00:00:00.000Z",
      link: "https://example.com/r/42",
      comments: 0,
      ownerReplies: 0,
      awaitingReply: true,
    });
    expect(birdeyeReviewEvent({ reviewId: 1, response: "Thanks", responseDate: "soon" }, CTX)!.payload).toMatchObject({ comments: 1, awaitingReply: false });
    expect(birdeyeReviewEvent({ reviewId: 1, response: "Thanks", responseDate: "soon" }, CTX)!.payload.repliedAt).toBeUndefined();
    expect(birdeyeReviewEvent({ reviewId: 1, reviewURL: "https://a.example.com/1", reviewUrl: "https://b.example.com/1" }, CTX)!.payload.link).toBe("https://a.example.com/1");
    for (const status of ["DELETED", "created!", "x".repeat(21), 5]) expect(birdeyeReviewEvent({ reviewId: 1, reviewOperationalStatus: status }, CTX)!.payload.edited, String(status)).toBeUndefined();
    expect(birdeyeReviewEvent({ reviewId: 1, reviewOperationalStatus: "Created" }, CTX)!.payload.edited).toBe(false);
    expect(birdeyeReviewEvent({ reviewId: 1, reviewOperationalStatus: "x".repeat(20) }, CTX)!.payload.edited).toBeUndefined();
    for (const rating of [6, -1, "5", Number.NaN]) expect(birdeyeReviewEvent({ reviewId: 1, rating }, CTX)!.payload.rating, String(rating)).toBeUndefined();
  });

  it("keeps a site name only when it reads like one", () => {
    const publisher = (sourceType: unknown) => birdeyeReviewEvent({ reviewId: 1, sourceType }, CTX)!.payload.publisher;
    expect(["Google", " Our Website ", "Trip_Advisor-2.0", "x".repeat(40)].map(publisher)).toEqual(["Google", "Our Website", "Trip_Advisor-2.0", "x".repeat(40)]);
    expect(["x".repeat(41), "<script>", "Yelp!", " ", 5].map(publisher)).toEqual(Array(5).fill(undefined));
  });

  it("drops a review with no usable id, and dates one with no readable date as unknown", () => {
    for (const reviewId of [0, -1, 1.5, 2 ** 53, "0", "01", "abc", "1".repeat(19), " 1", null, undefined]) expect(birdeyeReviewEvent({ reviewId }, CTX), String(reviewId)).toBeNull();
    expect(birdeyeReviewEvent(null as never, CTX)).toBeNull();
    expect(birdeyeReviewEvent({ reviewId: "1".repeat(18) }, CTX)!.payload.reviewId).toBe(`birdeye:review:${"1".repeat(18)}`);
    expect(birdeyeReviewEvent({ reviewId: 2 ** 53 - 1 }, CTX)!.payload.reviewId).toBe(`birdeye:review:${2 ** 53 - 1}`);
    expect(birdeyeReviewEvent({ reviewId: 7, reviewDate: "someday" }, CTX)!.occurredAt).toBeUndefined();
  });

  it("keys a review by what was kept, so only a change makes a new version", () => {
    const key = (r: Record<string, unknown>) => birdeyeReviewEvent({ reviewId: 9, rating: 4, comments: "Nice", ...r }, CTX)!.idempotencyKey;
    expect(key({})).toBe(key({ reviewer: { firstName: "Someone" }, customerId: 5 }));
    expect(key({})).toBe(birdeyeReviewEvent({ reviewId: 9, rating: 4, comments: "Nice" }, { ...CTX, receivedAt: "2027-01-01T00:00:00.000Z" })!.idempotencyKey);
    expect(new Set([key({}), key({ rating: 5 }), key({ response: "Thanks" }), key({ comments: "Nicer" }), key({ reviewOperationalStatus: "UPDATED" })]).size).toBe(5);
    expect(birdeyeReviewEvent({ reviewId: 9 }, { ...CTX, businessId: "2" })!.idempotencyKey).not.toBe(birdeyeReviewEvent({ reviewId: 9 }, CTX)!.idempotencyKey);
  });
});

describe("Birdeye cursor", () => {
  const good: BirdeyeCursor = { pass: "incremental", sindex: 100, since: "2026-11-08T15:00:00.000Z", nextFrom: "2026-11-09T15:00:00.000Z" };
  it("reads a checkpoint it wrote and nothing else", () => {
    expect(parseBirdeyeCursor(null)).toBeNull();
    expect(parseBirdeyeCursor(JSON.stringify({ ...good, extra: 1 }))).toEqual(good);
    expect(parseBirdeyeCursor(JSON.stringify({ ...good, pass: "historical", sindex: -1 }))).toEqual({ ...good, pass: "historical", sindex: -1 });
    expect(parseBirdeyeCursor(JSON.stringify({ ...good, sindex: BIRDEYE_MAX_WINDOW - 1 }))!.sindex).toBe(BIRDEYE_MAX_WINDOW - 1);
    const bad = [
      "{", "null", "5", "[]", JSON.stringify({ ...good, pass: "full" }), JSON.stringify({ ...good, sindex: -2 }), JSON.stringify({ ...good, sindex: BIRDEYE_MAX_WINDOW }),
      JSON.stringify({ ...good, sindex: 1.5 }), JSON.stringify({ ...good, sindex: "0" }), JSON.stringify({ ...good, since: "2026-11-08T15:00:00Z" }), JSON.stringify({ ...good, since: "2026-02-30T15:00:00.000Z" }),
      JSON.stringify({ ...good, nextFrom: undefined }), JSON.stringify({ ...good, since: Date.parse(good.since) }), JSON.stringify({ ...good, nextFrom: null }), JSON.stringify({ ...good, since: [good.since] }), JSON.stringify({ ...good, nextFrom: "x2026-11-09T15:00:00.000Z" }), JSON.stringify({ ...good, since: "2026-11-08T15:00:00.000Zx" }),
    ];
    for (const raw of bad) expect(() => parseBirdeyeCursor(raw), raw).toThrow("Birdeye checkpoint is not in the expected shape");
  });
});

describe("Birdeye connector", () => {
  it("passes the shared sync check", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(birdeyeDocMock(business())), expected: { ingested: 5 } });
    expect(result.full.batches).toBe(1);
    expect(parseBirdeyeCursor(result.full.cursor)).toEqual({ pass: "historical", sindex: -1, since: "2021-11-10T15:00:00.000Z", nextFrom: "2026-11-09T15:00:00.000Z" });
  });

  it("imports five years of reviews, published and parked, then stops for good", async () => {
    const data = business();
    data.reviews.push(posted(5, { parked: true }));
    const mock = birdeyeDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(6);
    expect(mock.reads).toEqual([{ sindex: 0, count: 100, body: { fromDate: "11/10/2021", statuses: ["all"] } }]);
    expect(memory.events.map((e) => e.occurredAt).sort()).toEqual(["2025-10-06", "2026-10-31", "2026-11-05", "2026-11-07", "2026-11-09", "2026-11-10"].map((d) => `${d}T00:00:00.000Z`));
    assertSynthetic(memory.events);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(1);
  });

  it("reads 100 at a time until a short page, keeping the offset in the checkpoint", async () => {
    birdeyeReview.reset();
    const mock = birdeyeDocMock({ apiKey: KEY, reviews: Array.from({ length: 250 }, (_, i) => posted(i % 30)) });
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(mock.reads.map((r) => r.sindex)).toEqual([0, 100, 200]);
    expect(batches.map((b) => b.events.length)).toEqual([100, 100, 50]);
    expect(batches.map((b) => parseBirdeyeCursor(b.cursor)!.sindex)).toEqual([100, 200, -1]);

    birdeyeReview.reset();
    const exact = birdeyeDocMock({ apiKey: KEY, reviews: Array.from({ length: 100 }, () => posted(1)) });
    const two = await drain(connector(exact).historicalImport({ cursor: null } as never));
    expect(two.map((b) => b.events.length)).toEqual([100, 0]);
  });

  it("resumes an interrupted pass from its page and date", async () => {
    birdeyeReview.reset();
    const mock = birdeyeDocMock({ apiKey: KEY, reviews: Array.from({ length: 150 }, () => posted(1)) });
    const cursor = JSON.stringify({ pass: "historical", sindex: 100, since: "2026-01-01T00:00:00.000Z", nextFrom: "2026-01-02T00:00:00.000Z" });
    const batches = await drain(connector(mock).historicalImport({ cursor } as never));
    expect(mock.reads).toEqual([{ sindex: 100, count: 100, body: { fromDate: "01/01/2026", statuses: ["all"] } }]);
    expect(batches).toHaveLength(1);
    expect(parseBirdeyeCursor(batches[0]!.cursor)).toEqual({ pass: "historical", sindex: -1, since: "2026-01-01T00:00:00.000Z", nextFrom: "2026-01-02T00:00:00.000Z" });

    const inc = birdeyeDocMock({ apiKey: KEY, reviews: [] });
    await drain(connector(inc).incrementalSync({ cursor: JSON.stringify({ pass: "incremental", sindex: 300, since: "2026-11-01T00:00:00.000Z", nextFrom: "2026-11-02T00:00:00.000Z" }) } as never));
    expect(inc.reads).toEqual([{ sindex: 300, count: 100, body: { updateFromDate: "11/01/2026", statuses: ["all"] } }]);
  });

  it("syncs what changed since the last pass started, less a day", async () => {
    const mock = birdeyeDocMock(business());
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // With no checkpoint of its own, it looks back two days.
    expect(mock.reads.map((r) => r.body)).toEqual([{ updateFromDate: "11/08/2026", statuses: ["all"] }]);
    expect(first.ingested).toBe(2);
    const later = () => new Date(NOW().getTime() + 3 * DAY_MS);
    await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads[1]!.body).toEqual({ updateFromDate: "11/09/2026", statuses: ["all"] });
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads[2]!.body).toEqual({ updateFromDate: "11/12/2026", statuses: ["all"] });
    expect(BIRDEYE_OVERLAP_MS).toBe(DAY_MS);
  });

  it("starts syncing from where the import began, less a day", async () => {
    const mock = birdeyeDocMock(business());
    const cursor = JSON.stringify({ pass: "historical", sindex: -1, since: "2021-11-01T00:00:00.000Z", nextFrom: "2026-11-01T09:00:00.000Z" });
    const [batch] = await drain(connector(mock).incrementalSync({ cursor } as never));
    expect(mock.reads[0]!.body).toEqual({ updateFromDate: "11/01/2026", statuses: ["all"] });
    expect(parseBirdeyeCursor(batch!.cursor)).toEqual({ pass: "incremental", sindex: -1, since: "2026-11-01T09:00:00.000Z", nextFrom: "2026-11-09T15:00:00.000Z" });
    // An import that was interrupted is not finished, so an incremental sync still reads from where it began.
    const interrupted = birdeyeDocMock(business());
    await drain(connector(interrupted).incrementalSync({ cursor: cursor.replace('"sindex":-1', '"sindex":100') } as never));
    expect(interrupted.reads[0]).toEqual({ sindex: 0, count: 100, body: { updateFromDate: "11/01/2026", statuses: ["all"] } });
    // A finished incremental pass doesn't stop a new import.
    const fresh = birdeyeDocMock(business());
    await drain(connector(fresh).historicalImport({ cursor: JSON.stringify({ pass: "incremental", sindex: -1, since: "2026-11-01T00:00:00.000Z", nextFrom: "2026-11-02T00:00:00.000Z" }) } as never));
    expect(fresh.reads[0]!.body).toEqual({ fromDate: "11/10/2021", statuses: ["all"] });
  });

  it("takes the history and lookback it is given", async () => {
    const mock = birdeyeDocMock(business());
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ cursor: null } as never));
    await drain(connector(mock, { incrementalLookbackHours: 24 * 10 }).incrementalSync({ cursor: null } as never));
    expect(mock.reads.map((r) => r.body)).toEqual([
      { fromDate: "11/10/2025", statuses: ["all"] },
      { updateFromDate: "10/31/2026", statuses: ["all"] },
    ]);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => connector(mock, { historyYears: bad }), String(bad)).toThrow("historyYears must be a positive whole number");
      expect(() => connector(mock, { incrementalLookbackHours: bad }), String(bad)).toThrow("incrementalLookbackHours must be a positive whole number");
    }
  });

  it("uses an injected client and names the business on each review", async () => {
    const asked: BirdeyeReviewQuery[] = [];
    const fake: BirdeyeClient = { reviews: async (q) => (asked.push(q), [{ reviewId: 3, reviewDate: "Nov 9, 2026" }, { reviewId: "bad" }]) };
    const [batch] = await drain(birdeyeConnector({ apiKey: "", businessId: " 77 ", client: fake, now: NOW }).historicalImport({ cursor: null } as never));
    expect(asked).toEqual([{ fromDate: "11/10/2021", sindex: 0 }]);
    expect(batch!.events).toHaveLength(1);
    expect(batch!.events[0]).toMatchObject({ receivedAt: RECEIVED });
    expect((batch!.events[0] as { payload: unknown }).payload).toMatchObject({ locationId: "birdeye:business:77", reviewId: "birdeye:review:3" });
  });

  it("waits out a rate limit and stops at a bad key or business, keeping the checkpoint", async () => {
    const limited = birdeyeDocMock({ ...business(), rateLimits: 2 });
    expect((await drain(connector(limited).historicalImport({ cursor: null } as never)))[0]!.events).toHaveLength(5);
    await expect(drain(connector(birdeyeDocMock({ ...business(), rateLimits: 9 })).historicalImport({ cursor: null } as never))).rejects.toMatchObject({ status: 429, code: 89 });
    await expect(drain(connector(birdeyeDocMock({ ...business(), apiKey: "x".repeat(32) })).historicalImport({ cursor: null } as never))).rejects.toMatchObject({ status: 401, code: 1161 });
    await expect(drain(connector(birdeyeDocMock({ ...business(), businessId: "5" })).historicalImport({ cursor: null } as never))).rejects.toMatchObject({ status: 404, code: 1011 });
  });

  it("declares replying as a write and turns it down while writes are off", async () => {
    expect(BIRDEYE_WRITES.map((w) => [w.integration, w.name])).toEqual([["birdeye", "reply_to_review"]]);
    const c = connector(birdeyeDocMock(business()));
    expect(c.source).toBe("birdeye");
    expect(c.writes).toBe(BIRDEYE_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([{ action: "reply_to_review", integration: "birdeye", outcome: "refused" }]);
  });
});
