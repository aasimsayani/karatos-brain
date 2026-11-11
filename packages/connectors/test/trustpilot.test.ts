import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import {
  TEST_ORG,
  TRUSTPILOT_DOC_PAGES,
  TRUSTPILOT_TEST_UNIT,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  testPipeline,
  trustpilotDocMock,
  trustpilotId,
  trustpilotReview,
  trustpilotUnit,
  type TrustpilotMock,
  type TrustpilotMockData,
} from "@karatos/connector-testkit";
import {
  TRUSTPILOT_API_URL,
  TRUSTPILOT_FOLLOW_UP_RATING,
  TRUSTPILOT_MAX_PAGE,
  TRUSTPILOT_PAGE_SIZE,
  TRUSTPILOT_RECHECK_DAYS,
  TRUSTPILOT_REVIEW_EVENT,
  TRUSTPILOT_SCORE_EVENT,
  TRUSTPILOT_WRITES,
  TrustpilotApiError,
  TrustpilotConfigError,
  parseTrustpilotCursor,
  trustpilotClient,
  trustpilotConnector,
  trustpilotReviewEvent,
  trustpilotScoreEvent,
  type TrustpilotClient,
  type TrustpilotEvent,
  type TrustpilotOptions,
} from "../src/index.js";

// A key-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const API_KEY = ["Tp", "Test", "0".repeat(24)].join("");
const UNIT = TRUSTPILOT_TEST_UNIT;
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const BASE = `https://api.trustpilot.com/v1/business-units/${UNIT}`;
const HOUR_MS = 3_600_000;
const FIVE_YEARS = "2021-11-11T15:00:00.000Z";
const noSleep = async () => {};

/** `ago` hours before NOW. */
const before = (ago: number) => new Date(NOW().getTime() - ago * HOUR_MS).toISOString();

/** Reviews posted 1, 300 (past the 30 days a later sync reads again) and 5,000 hours ago, and six years ago, past the five read. */
function store(overrides: Partial<TrustpilotMockData> = {}): TrustpilotMockData {
  trustpilotReview.reset();
  const reviews = [1, 300, 5000, 52_600].map((ago) => trustpilotReview.one({ createdAt: before(ago) }));
  return { apiKey: API_KEY, reviews, ...overrides };
}

const connector = (mock: TrustpilotMock, overrides: Partial<TrustpilotOptions> = {}) => trustpilotConnector({ apiKey: API_KEY, businessUnitId: UNIT, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as TrustpilotEvent[];

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

/** A fetch that answers in turn and records what was sent. */
function scripted(...answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) } });
    return answers[Math.min(sent.length - 1, answers.length - 1)]!();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const text = (status: number, body: string) => () => new Response(body, { status });
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof trustpilotClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = trustpilotClient({ apiKey: API_KEY, businessUnitId: UNIT, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const ctx = { businessUnitId: UNIT, receivedAt: RECEIVED };

describe("Trustpilot client", () => {
  it("checks its key and business unit before sending anything", () => {
    const { fetch, sent } = scripted(json(200, { reviews: [] }));
    for (const apiKey of ["", "a".repeat(19), "a".repeat(65), `${"a".repeat(20)}-`, `${"a".repeat(20)} x`, `${"a".repeat(20)}_`]) {
      expect(() => trustpilotClient({ apiKey, businessUnitId: UNIT, fetch }), apiKey).toThrow("TRUSTPILOT_API_KEY is missing or not in the expected shape: the API key of a Trustpilot application, not its secret");
    }
    for (const businessUnitId of ["", "5f0c0ffee", `${UNIT}0`, UNIT.slice(1), `${UNIT.slice(0, 23)}g`, `/${UNIT.slice(1)}`]) {
      expect(() => trustpilotClient({ apiKey: API_KEY, businessUnitId, fetch }), businessUnitId).toThrow("TRUSTPILOT_BUSINESS_UNIT_ID is missing or not a business unit id");
    }
    expect(() => trustpilotClient({ apiKey: ` ${"a".repeat(20)} `, businessUnitId: ` ${UNIT.toUpperCase()} `, fetch })).not.toThrow();
    expect(() => trustpilotClient({ apiKey: "aZ9".repeat(21) + "a", businessUnitId: UNIT, fetch })).not.toThrow();
    expect(() => trustpilotClient({} as never)).toThrow(TrustpilotConfigError);
    expect(() => trustpilotClient({ apiKey: API_KEY } as never)).toThrow(TrustpilotConfigError);
    expect(sent).toHaveLength(0);
  });

  it("reads the business unit, then a page of reviews newest first, with the key in the apikey header", async () => {
    const { fetch, sent } = scripted(json(200, trustpilotUnit()), json(200, { links: [], reviews: [{ id: 1 }] }));
    const { c } = client(fetch, { apiKey: ` ${API_KEY} `, businessUnitId: UNIT.toUpperCase() });
    expect(await c.businessUnit()).toEqual(trustpilotUnit());
    expect(await c.reviews(3)).toEqual([{ id: 1 }]);
    expect(sent).toEqual([
      { url: BASE, method: "GET", headers: { apikey: API_KEY, accept: "application/json" } },
      { url: `${BASE}/reviews?orderBy=createdat.desc&perPage=100&page=3`, method: "GET", headers: { apikey: API_KEY, accept: "application/json" } },
    ]);
    expect(TRUSTPILOT_API_URL).toBe("https://api.trustpilot.com/v1");
    expect(TRUSTPILOT_PAGE_SIZE).toBe(100);
  });

  it("asks only for pages 1 to the most a pass reads", async () => {
    const { fetch, sent } = scripted(json(200, { reviews: [] }));
    const { c } = client(fetch);
    for (const page of [0, -1, 1.5, TRUSTPILOT_MAX_PAGE + 1, Number.NaN]) await expect(c.reviews(page)).rejects.toMatchObject({ message: `a reviews page must be 1 to ${TRUSTPILOT_MAX_PAGE}`, status: 0 });
    expect(sent).toHaveLength(0);
    expect(await c.reviews(TRUSTPILOT_MAX_PAGE)).toEqual([]);
    expect(TRUSTPILOT_MAX_PAGE).toBe(1000);
  });

  it("says when an answer isn't an object or has no review list", async () => {
    for (const body of [null, [], "x", 5]) {
      const { c } = client(scripted(json(200, body)).fetch);
      await expect(c.businessUnit()).rejects.toMatchObject({ message: "Trustpilot answered the business unit without an object", status: 200 });
    }
    const { c: notJson } = client(scripted(text(200, "<html>")).fetch);
    await expect(notJson.reviews(1)).rejects.toThrow("Trustpilot answered the reviews without an object");
    for (const body of [{}, { reviews: {} }, { reviews: null }]) {
      const { c } = client(scripted(json(200, body)).fetch);
      await expect(c.reviews(1)).rejects.toMatchObject({ message: "Trustpilot answered the reviews without the reviews list", status: 200 });
    }
  });

  it("explains a turned-down key or a wrong business unit, and reports other errors", async () => {
    for (const status of [401, 403]) {
      const { c } = client(scripted(json(status, {})).fetch);
      const err = await c.reviews(1).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TrustpilotConfigError);
      expect((err as Error).message).toBe(`Trustpilot turned down TRUSTPILOT_API_KEY (HTTP ${status}): check it, and that the store still has the API module`);
      expect((err as Error).message).not.toContain(API_KEY);
    }
    const { c: missing } = client(scripted(json(404, {})).fetch);
    await expect(missing.businessUnit()).rejects.toThrow(new TrustpilotConfigError("Trustpilot has no business unit with TRUSTPILOT_BUSINESS_UNIT_ID"));
    for (const status of [400, 418, 501]) {
      const { c } = client(scripted(json(status, {})).fetch);
      const err = await c.businessUnit().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TrustpilotApiError);
      expect(err).toMatchObject({ message: `Trustpilot answered HTTP ${status} for the business unit`, status, name: "TrustpilotApiError" });
    }
    expect(new TrustpilotConfigError("x").name).toBe("TrustpilotConfigError");
  });

  it("waits out rate limits as Retry-After says, up to a minute, or backs off", async () => {
    const { fetch, sent } = scripted(json(429, {}, { "Retry-After": "7" }), json(429, {}, { "Retry-After": "900" }), json(429, {}, { "Retry-After": "soon" }), json(200, { reviews: [] }));
    const { c, slept } = client(fetch);
    expect(await c.reviews(1)).toEqual([]);
    expect(slept).toEqual([7000, 60_000, 4000]);
    expect(sent).toHaveLength(4);
  });

  it("retries 500, 502, 503 and 504 too, backing off 1, 2 and 4 seconds, then gives up", async () => {
    for (const status of [500, 502, 503, 504]) {
      const { fetch, sent } = scripted(json(status, {}));
      const { c, slept } = client(fetch);
      await expect(c.reviews(1)).rejects.toMatchObject({ status });
      expect(sent).toHaveLength(4);
      expect(slept).toEqual([1000, 2000, 4000]);
    }
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const once = scripted(json(400, {}));
    await expect(client(once.fetch).c.reviews(1)).rejects.toMatchObject({ status: 400 });
    expect(once.sent).toHaveLength(1);
    const twice = scripted(json(429, {}));
    const { c, slept } = client(twice.fetch, { retries: 1 });
    await expect(c.reviews(1)).rejects.toMatchObject({ status: 429 });
    expect(twice.sent).toHaveLength(2);
    expect(slept).toEqual([1000]);
    const zero = scripted(json(429, {}, { "Retry-After": "0" }), json(200, { reviews: [] }));
    const { c: z, slept: zs } = client(zero.fetch);
    expect(await z.reviews(1)).toEqual([]);
    expect(zs).toEqual([1000]);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(json(429, {}, { "Retry-After": "0.001" }), json(200, { reviews: [] }));
    globalThis.fetch = fetch;
    try {
      expect(await trustpilotClient({ apiKey: API_KEY, businessUnitId: UNIT }).reviews(1)).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(2);
  });

  it("only ever sends GETs to the business unit and its reviews", async () => {
    const mock = trustpilotDocMock(store());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.map((r) => r.path)).toEqual([`/v1/business-units/${UNIT}`, `/v1/business-units/${UNIT}/reviews`]);
    expect(mock.api.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /business-units/{unit}", "GET /business-units/{unit}/reviews"]);
  });
});

describe("Trustpilot events", () => {
  const review = (extra: Record<string, unknown> = {}) => {
    trustpilotReview.reset();
    return trustpilotReview.one({ createdAt: before(3), ...extra });
  };

  it("logs a review as Yext's and Judge.me's are, with no name, location or reply text", () => {
    const raw = review({ title: "Mail me at someone@example.test", text: "Call +1 212 555 0100 about it.", updatedAt: before(2), location: { id: trustpilotId("10", 1), name: "Main St" }, numberOfLikes: 3 });
    const { ok, event } = trustpilotReviewEvent(raw, ctx);
    expect(ok).toBe(true);
    const id = trustpilotId("6a", 1);
    expect(event).toEqual({
      id: event.idempotencyKey.replace(/:/g, "_"),
      type: TRUSTPILOT_REVIEW_EVENT,
      occurredAt: before(3),
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(new RegExp(`^trustpilot:review:${id}:[0-9a-f]{12}$`)),
      payload: {
        system: "Trustpilot",
        reviewId: `trustpilot:review:${id}`,
        publisher: "Trustpilot",
        kind: "site",
        locationId: `trustpilot:business_unit:${UNIT}`,
        storeLocationId: trustpilotId("10", 1),
        rating: 5,
        needsFollowUp: false,
        title: "Mail me at [email]",
        excerpt: "Call [phone] about it.",
        language: "en",
        status: "active",
        verified: true,
        countsTowardsTrustScore: true,
        likes: 3,
        reviewerRef: `trustpilot:consumer:${trustpilotId("c0", 1)}`,
        ownerReplies: 1,
        awaitingReply: false,
        repliedAt: "2026-01-01T01:30:00.000Z",
        replyEditedAt: undefined,
        experiencedAt: "2025-12-31T01:00:00.000Z",
        publishedAt: before(3),
        editedAt: before(2),
      },
    });
    const kept = JSON.stringify(event);
    for (const word of ["Customer", "Test City", "Thank you", "someone", "555", "Main St"]) expect(kept).not.toContain(word);
    expect(event.type).toBe("review.updated");
  });

  it("marks low ratings for follow-up and unanswered reviews as waiting on a reply", () => {
    expect(TRUSTPILOT_FOLLOW_UP_RATING).toBe(2);
    expect([1, 2, 3, 4, 5].map((stars) => trustpilotReviewEvent(review({ stars }), ctx).event.payload.needsFollowUp)).toEqual([true, true, false, false, false]);
    for (const companyReply of [null, undefined, {}, { createdAt: "x" }, "Thanks"]) {
      expect(trustpilotReviewEvent(review({ companyReply }), ctx).event.payload).toMatchObject({ ownerReplies: 0, awaitingReply: true, repliedAt: undefined, replyEditedAt: undefined });
    }
    expect(trustpilotReviewEvent(review({ companyReply: { createdAt: before(2), updatedAt: before(1) } }), ctx).event.payload).toMatchObject({ ownerReplies: 1, awaitingReply: false, repliedAt: before(2), replyEditedAt: before(1) });
    // An edit time with no reply time is no reply.
    expect(trustpilotReviewEvent(review({ companyReply: { updatedAt: before(1) } }), ctx).event.payload).toMatchObject({ awaitingReply: true, replyEditedAt: undefined });
  });

  it("leaves out what doesn't read", () => {
    const p = trustpilotReviewEvent(
      review({ title: 5, text: null, language: "en us", status: "x".repeat(21), isVerified: "true", countsTowardsTrustScore: "yes", numberOfLikes: -1, consumer: { id: "abc" }, location: { id: 7 }, experiencedAt: "soon", updatedAt: "x" }),
      ctx,
    ).event.payload;
    expect(p).toMatchObject({ title: undefined, excerpt: undefined, language: undefined, status: undefined, verified: false, countsTowardsTrustScore: undefined, likes: undefined, reviewerRef: undefined, storeLocationId: undefined, experiencedAt: undefined, editedAt: undefined });
    expect(trustpilotReviewEvent(review({ consumer: null, location: [], countsTowardsTrustScore: false, numberOfLikes: 1.5, language: "pt-BR", status: "x".repeat(20) }), ctx).event.payload).toMatchObject({ reviewerRef: undefined, storeLocationId: undefined, countsTowardsTrustScore: false, likes: undefined, language: "pt-BR", status: "x".repeat(20) });
    expect(trustpilotReviewEvent(review({ numberOfLikes: 0, language: "1en" }), ctx).event.payload).toMatchObject({ likes: 0, language: undefined });
    expect(trustpilotReviewEvent(review({ title: "x".repeat(300), text: "y".repeat(600) }), ctx).event.payload).toMatchObject({ title: "x".repeat(200), excerpt: "y".repeat(500) });
  });

  it("is a duplicate when read again unchanged, and a new event when it changes", () => {
    const a = trustpilotReviewEvent(review(), ctx).event;
    expect(trustpilotReviewEvent(review(), { ...ctx, receivedAt: before(0.5) }).event.idempotencyKey).toBe(a.idempotencyKey);
    expect(trustpilotReviewEvent(review({ companyReply: null }), ctx).event.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(trustpilotReviewEvent(review({ stars: 4 }), ctx).event.idempotencyKey).not.toBe(a.idempotencyKey);
  });

  it("dead-letters a review it can't read, saying why", () => {
    const bad = trustpilotReviewEvent({ id: "nope", stars: 6 }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.event).toEqual({
      id: bad.event.idempotencyKey.replace(/:/g, "_"),
      type: TRUSTPILOT_REVIEW_EVENT,
      occurredAt: undefined,
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^trustpilot:unreadable_review:[0-9a-f]{12}$/),
      payload: { system: "Trustpilot", reviewId: null, problems: ["review has no id that reads", "review has no rating from 1 to 5", "review has no time that reads"] },
    });
    for (const raw of [null, [review()], "x"]) expect(trustpilotReviewEvent(raw, ctx).event.payload.problems).toEqual(["review is not an object", "review has no id that reads", "review has no rating from 1 to 5", "review has no time that reads"]);
    expect(trustpilotReviewEvent(null, ctx).event.idempotencyKey).not.toBe(trustpilotReviewEvent("x", ctx).event.idempotencyKey);
    for (const stars of [0, 1.5, "5", undefined]) expect(trustpilotReviewEvent(review({ stars }), ctx).event.payload.problems).toEqual(["review has no rating from 1 to 5"]);
    for (const id of [trustpilotId("6a", 1).toUpperCase(), `${trustpilotId("6a", 1)}0`, 5]) expect(trustpilotReviewEvent(review({ id }), ctx).event.payload).toEqual({ system: "Trustpilot", reviewId: null, problems: ["review has no id that reads"] });
    expect(trustpilotReviewEvent(review({ createdAt: "2026-02-30T00:00:00Z" }), ctx).event.payload).toMatchObject({ reviewId: trustpilotId("6a", 1), problems: ["review has no time that reads"] });
  });

  it("logs the trust score and its counts, a duplicate until it moves", () => {
    const { ok, event } = trustpilotScoreEvent(trustpilotUnit(), ctx);
    expect(ok).toBe(true);
    expect(event).toEqual({
      id: event.idempotencyKey.replace(/:/g, "_"),
      type: TRUSTPILOT_SCORE_EVENT,
      occurredAt: RECEIVED,
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(new RegExp(`^trustpilot:score:${UNIT}:[0-9a-f]{12}$`)),
      payload: { system: "Trustpilot", publisher: "Trustpilot", locationId: `trustpilot:business_unit:${UNIT}`, trustScore: 4.6, stars: 4.5, reviews: 120, reviewsInScore: 110, byRating: { 1: 4, 2: 2, 3: 6, 4: 20, 5: 88 } },
    });
    expect(TRUSTPILOT_SCORE_EVENT).toBe("review.score_updated");
    expect(trustpilotScoreEvent(trustpilotUnit(), { ...ctx, receivedAt: before(1) }).event.idempotencyKey).toBe(event.idempotencyKey);
    expect(trustpilotScoreEvent(trustpilotUnit({ score: { trustScore: 4.7, stars: 4.5 } }), ctx).event.idempotencyKey).not.toBe(event.idempotencyKey);
    const odd = trustpilotScoreEvent(trustpilotUnit({ score: { trustScore: 0, stars: 6 }, numberOfReviews: { total: 0, usedForTrustScoreCalculation: -1, oneStar: 1.5 } }), ctx);
    expect(odd.event.payload).toMatchObject({ trustScore: 0, stars: undefined, reviews: 0, reviewsInScore: undefined, byRating: { 1: undefined, 2: undefined, 3: undefined, 4: undefined, 5: undefined } });
    expect(trustpilotScoreEvent(trustpilotUnit({ score: { trustScore: 5, stars: -0.1 } }), ctx).event.payload).toMatchObject({ trustScore: 5, stars: undefined });
  });

  it("dead-letters a business unit it can't read, or one that isn't the store's", () => {
    const bad = trustpilotScoreEvent(trustpilotUnit({ id: trustpilotId("ff", 1), score: { trustScore: 5.1 }, numberOfReviews: { total: "120" } }), ctx);
    expect(bad).toEqual({
      ok: false,
      event: {
        id: bad.event.idempotencyKey.replace(/:/g, "_"),
        type: TRUSTPILOT_SCORE_EVENT,
        occurredAt: undefined,
        receivedAt: RECEIVED,
        idempotencyKey: expect.stringMatching(/^trustpilot:unreadable_score:[0-9a-f]{12}$/),
        payload: { system: "Trustpilot", problems: ["business unit is not the store's", "business unit has no trust score from 0 to 5", "business unit has no review count that reads"] },
      },
    });
    for (const raw of [null, [trustpilotUnit()], "x"]) expect(trustpilotScoreEvent(raw, ctx).event.payload.problems).toEqual(["business unit is not an object", "business unit is not the store's", "business unit has no trust score from 0 to 5", "business unit has no review count that reads"]);
    expect(trustpilotScoreEvent(null, ctx).event.idempotencyKey).not.toBe(trustpilotScoreEvent("x", ctx).event.idempotencyKey);
    expect(trustpilotScoreEvent(trustpilotUnit({ score: { trustScore: "4.6" } }), ctx).event.payload.problems).toEqual(["business unit has no trust score from 0 to 5"]);
  });
});

describe("Trustpilot checkpoint", () => {
  const cursor = (c: unknown) => JSON.stringify(c);

  it("round-trips and turns down any other shape", () => {
    const good = [{ pass: null, done: false }, { pass: null, done: true }, { pass: { since: before(5), page: 1 }, done: true }, { pass: { since: FIVE_YEARS, page: TRUSTPILOT_MAX_PAGE }, done: false }];
    for (const c of good) expect(parseTrustpilotCursor(cursor(c))).toEqual(c);
    expect(parseTrustpilotCursor(null)).toBeNull();
    const pass = { since: before(5), page: 2 };
    const bad = [
      "",
      "x",
      "null",
      "[]",
      "5",
      cursor({ pass: null }),
      cursor({ pass: null, done: "yes" }),
      cursor({ done: true }),
      cursor({ done: true, pass: "x" }),
      cursor({ done: true, pass: 5 }),
      cursor({ done: true, pass: { ...pass, since: "2026-11-01T00:00:00Z" } }),
      cursor({ done: true, pass: { ...pass, since: "yesterday" } }),
      cursor({ done: true, pass: { ...pass, since: undefined } }),
      cursor({ done: true, pass: { ...pass, page: 0 } }),
      cursor({ done: true, pass: { ...pass, page: 1.5 } }),
      cursor({ done: true, pass: { ...pass, page: "2" } }),
      cursor({ done: true, pass: { ...pass, page: TRUSTPILOT_MAX_PAGE + 1 } }),
    ];
    for (const raw of bad) expect(() => parseTrustpilotCursor(raw), raw).toThrow("Trustpilot checkpoint is not in the expected shape");
    expect(parseTrustpilotCursor(cursor({ done: true, pass: { ...pass, extra: 1 }, more: 2 }))).toEqual({ done: true, pass });
  });
});

describe("Trustpilot connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(trustpilotDocMock(store())), expected: { ingested: 4 } });
    expect(result.full.ingested).toBe(4);
  });

  it("imports five years of reviews and the trust score, then stops for good", async () => {
    const mock = trustpilotDocMock(store());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(4);
    expect(mock.reads).toEqual([
      { path: `/v1/business-units/${UNIT}`, query: {} },
      { path: `/v1/business-units/${UNIT}/reviews`, query: { orderBy: "createdat.desc", perPage: "100", page: "1" } },
    ]);
    expect(memory.events.map((e) => e.type)).toEqual([TRUSTPILOT_SCORE_EVENT, ...Array(3).fill(TRUSTPILOT_REVIEW_EVENT)]);
    expect(memory.events.slice(1).map((e) => e.occurredAt)).toEqual([before(1), before(300), before(5000)]);
    expect(parseTrustpilotCursor(report.cursor)).toEqual({ pass: null, done: true });
    assertSynthetic(memory.events);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(2);
  });

  it("reads 100 a page, keeping the page in the checkpoint, and resumes there", async () => {
    trustpilotReview.reset();
    const reviews = Array.from({ length: 230 }, (_, i) => trustpilotReview.one({ createdAt: before(1 + i) }));
    const mock = trustpilotDocMock(store({ reviews }));
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([101, 100, 30]);
    expect(batches.map((b) => parseTrustpilotCursor(b.cursor as string))).toEqual([
      { pass: { since: FIVE_YEARS, page: 2 }, done: false },
      { pass: { since: FIVE_YEARS, page: 3 }, done: false },
      { pass: null, done: true },
    ]);
    const resumed = trustpilotDocMock(store({ reviews }));
    const rest = await drain(connector(resumed).historicalImport({ cursor: batches[0]!.cursor } as never));
    expect(resumed.reads.map((r) => r.query.page)).toEqual(["2", "3"]);
    expect(rest.map((b) => b.events.length)).toEqual([100, 30]);
  });

  it("stops at the first page that reaches back past the pass's start", async () => {
    trustpilotReview.reset();
    // 150 within the last 30 days, then older ones on the second page.
    const reviews = Array.from({ length: 350 }, (_, i) => trustpilotReview.one({ createdAt: before(1 + i * 4) }));
    const mock = trustpilotDocMock(store({ reviews }));
    const batches = await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(mock.reads.filter((r) => r.path.endsWith("/reviews")).map((r) => r.query.page)).toEqual(["1", "2"]);
    const since = before(TRUSTPILOT_RECHECK_DAYS * 24);
    expect(eventsOf(batches).filter((e) => e.type === TRUSTPILOT_REVIEW_EVENT).every((e) => (e.occurredAt as string) >= since)).toBe(true);
    expect(eventsOf(batches).filter((e) => e.type === TRUSTPILOT_REVIEW_EVENT)).toHaveLength(180);
    expect(parseTrustpilotCursor(batches.at(-1)!.cursor as string)).toEqual({ pass: null, done: false });
    // A full page that ends exactly at the start goes on to the next one.
    trustpilotReview.reset();
    const edge = Array.from({ length: 100 }, (_, i) => trustpilotReview.one({ createdAt: before(TRUSTPILOT_RECHECK_DAYS * 24 - 99 + i) }));
    const edgeMock = trustpilotDocMock(store({ reviews: edge }));
    await drain(connector(edgeMock).incrementalSync({ cursor: null } as never));
    expect(edgeMock.reads.filter((r) => r.path.endsWith("/reviews")).map((r) => r.query.page)).toEqual(["1", "2"]);
  });

  it("reads the last 30 days again on each later sync, so only a change is new", async () => {
    const data = store();
    const mock = trustpilotDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const quiet = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(quiet).toMatchObject({ ingested: 0, deadLettered: 0 });
    data.reviews[0]!.companyReply = null;
    const changed = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(changed.ingested).toBe(1);
    expect(TRUSTPILOT_RECHECK_DAYS).toBe(30);
  });

  it("keeps a finished import finished on every page of a later sync, and resumes one part way", async () => {
    const asked: number[] = [];
    const full = Array.from({ length: TRUSTPILOT_PAGE_SIZE }, () => ({ createdAt: before(1) }));
    const fake: TrustpilotClient = { businessUnit: async () => trustpilotUnit(), reviews: async (page) => (asked.push(page), page < 3 ? full : []) };
    const done = await drain(connector(trustpilotDocMock(store()), { client: fake }).incrementalSync({ cursor: JSON.stringify({ pass: null, done: true }) } as never));
    expect(done.map((b) => parseTrustpilotCursor(b.cursor as string)!.done)).toEqual([true, true, true]);
    asked.length = 0;
    const resumed = await drain(connector(trustpilotDocMock(store()), { client: fake }).incrementalSync({ cursor: JSON.stringify({ pass: { since: before(5), page: 2 }, done: true }) } as never));
    expect(asked).toEqual([2, 3]);
    // The trust score is read with a pass's first page only.
    expect(eventsOf(resumed).some((e) => e.type === TRUSTPILOT_SCORE_EVENT)).toBe(false);
    expect(resumed.map((b) => parseTrustpilotCursor(b.cursor as string))).toEqual([{ pass: { since: before(5), page: 3 }, done: true }, { pass: null, done: true }]);
    // An import resumed part way finishes as done.
    const imported = await drain(connector(trustpilotDocMock(store()), { client: fake }).historicalImport({ cursor: JSON.stringify({ pass: { since: before(5), page: 2 }, done: false }) } as never));
    expect(imported.map((b) => parseTrustpilotCursor(b.cursor as string)!.done)).toEqual([false, true]);
  });

  it("stops at the last page a pass may ask for", async () => {
    const asked: number[] = [];
    const full = Array.from({ length: TRUSTPILOT_PAGE_SIZE }, () => ({ createdAt: before(1) }));
    const fake: TrustpilotClient = { businessUnit: async () => trustpilotUnit(), reviews: async (page) => (asked.push(page), full) };
    const batches = await drain(connector(trustpilotDocMock(store()), { client: fake }).incrementalSync({ cursor: JSON.stringify({ pass: { since: before(5), page: TRUSTPILOT_MAX_PAGE - 1 }, done: false }) } as never));
    expect(asked).toEqual([TRUSTPILOT_MAX_PAGE - 1, TRUSTPILOT_MAX_PAGE]);
    expect(parseTrustpilotCursor(batches.at(-1)!.cursor as string)).toEqual({ pass: null, done: false });
  });

  it("keeps a review it can't read to dead-letter, and ignores a last row with no time", async () => {
    const asked: number[] = [];
    const page1 = [...Array.from({ length: TRUSTPILOT_PAGE_SIZE - 1 }, () => trustpilotReview.one({ createdAt: before(1) })), { id: "bad" }];
    const fake: TrustpilotClient = { businessUnit: async () => trustpilotUnit(), reviews: async (page) => (asked.push(page), page === 1 ? page1 : []) };
    const batches = await drain(connector(trustpilotDocMock(store()), { client: fake }).incrementalSync({ cursor: null } as never));
    expect(asked).toEqual([1, 2]);
    expect(eventsOf(batches).filter((e) => e.idempotencyKey.startsWith("trustpilot:unreadable_review:"))).toHaveLength(1);
    expect(eventsOf(batches).every((e) => e.receivedAt === RECEIVED)).toBe(true);
    const data = store();
    data.reviews.push({ id: "bad", createdAt: before(2) });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(trustpilotDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 4, deadLettered: 1 });
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = trustpilotDocMock(store({ rateLimits: 2 }));
    const slept: number[] = [];
    const batches = await drain(connector(mock, { sleep: async (ms) => void slept.push(ms) }).historicalImport({ cursor: null } as never));
    expect(eventsOf(batches)).toHaveLength(4);
    expect(slept).toEqual([1000, 1000]);
  });

  it("stops on a key that's turned down or a business unit that isn't there", async () => {
    await expect(drain(connector(trustpilotDocMock(store({ apiKey: "9".repeat(24) }))).historicalImport({ cursor: null } as never))).rejects.toThrow("Trustpilot turned down TRUSTPILOT_API_KEY (HTTP 401)");
    const elsewhere = trustpilotDocMock(store({ unit: trustpilotUnit({ id: trustpilotId("ab", 1) }) }));
    await expect(drain(connector(elsewhere).historicalImport({ cursor: null } as never))).rejects.toThrow("Trustpilot has no business unit with TRUSTPILOT_BUSINESS_UNIT_ID");
  });

  it("checks its settings", () => {
    const mock = trustpilotDocMock(store());
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { apiKey: "nope" })).toThrow(TrustpilotConfigError);
    const fake: TrustpilotClient = { businessUnit: async () => ({}), reviews: async () => [] };
    expect(() => connector(mock, { apiKey: "nope", client: fake })).not.toThrow();
    expect(() => connector(mock, { businessUnitId: "nope", client: fake })).toThrow("TRUSTPILOT_BUSINESS_UNIT_ID is missing or not a business unit id");
    expect(() => connector(mock, { businessUnitId: ` ${UNIT.toUpperCase()} `, client: fake })).not.toThrow();
  });

  it("reads back as far as told, and up to now when no clock is given", async () => {
    const seen: string[] = [];
    const fake: TrustpilotClient = { businessUnit: async () => trustpilotUnit(), reviews: async () => [{ createdAt: before(0) }] };
    const capture = async (batches: AsyncIterable<SourceBatch>) => {
      for (const b of await drain(batches)) seen.push(JSON.stringify(b.events.map((e) => (e as TrustpilotEvent).occurredAt)));
    };
    const one = trustpilotConnector({ apiKey: API_KEY, businessUnitId: UNIT, client: { ...fake, reviews: async () => [trustpilotReview.one({ createdAt: "2025-11-11T15:00:00.000Z" }), trustpilotReview.one({ createdAt: "2025-11-11T14:59:59.999Z" })] }, now: NOW, historyYears: 1 });
    const kept = eventsOf(await drain(one.historicalImport({ cursor: null } as never))).filter((e) => e.type === TRUSTPILOT_REVIEW_EVENT);
    expect(kept.map((e) => e.occurredAt)).toEqual(["2025-11-11T15:00:00.000Z"]);
    await capture(trustpilotConnector({ apiKey: API_KEY, businessUnitId: UNIT, client: fake }).incrementalSync({ cursor: null } as never));
    const live = trustpilotConnector({ apiKey: API_KEY, businessUnitId: UNIT, client: { ...fake, reviews: async () => [{ id: trustpilotId("6a", 1), stars: 5, createdAt: new Date(Date.now() - 29 * 86_400_000).toISOString() }, { id: trustpilotId("6a", 2), stars: 5, createdAt: new Date(Date.now() - 31 * 86_400_000).toISOString() }] } });
    const recent = eventsOf(await drain(live.incrementalSync({ cursor: null } as never))).filter((e) => e.type === TRUSTPILOT_REVIEW_EVENT);
    expect(recent).toHaveLength(1);
    expect(Math.abs(Date.parse(recent[0]!.receivedAt) - Date.now())).toBeLessThan(5000);
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(TRUSTPILOT_WRITES).toEqual([
      { integration: "trustpilot", name: "reply_to_review", description: "Post the store's public reply to a Trustpilot review", kind: "append", approval: "each", dailyCap: 20 },
      { integration: "trustpilot", name: "send_review_invitation", description: "Invite a customer to review the store on Trustpilot", kind: "append", approval: "each", dailyCap: 50 },
    ]);
    const c = connector(trustpilotDocMock(store()));
    expect(c.writes).toBe(TRUSTPILOT_WRITES);
    expect(c.source).toBe("trustpilot");
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "reply_to_review", integration: "trustpilot", outcome: "refused" },
      { action: "send_review_invitation", integration: "trustpilot", outcome: "refused" },
    ]);
  });
});

describe("Trustpilot doc mock", () => {
  const get = (mock: TrustpilotMock, path: string, key = API_KEY) => mock.fetch(`${BASE}${path}`, { headers: { apikey: key } });

  it("wants the key and the store's business unit, and checks the parameters and page size", async () => {
    const mock = trustpilotDocMock(store());
    expect((await get(mock, "", "nope")).status).toBe(401);
    expect((await mock.fetch(`${BASE}/reviews`)).status).toBe(401);
    expect((await mock.fetch(`https://api.trustpilot.com/v1/business-units/${trustpilotId("ab", 1)}/reviews`, { headers: { apikey: API_KEY } })).status).toBe(404);
    expect((await mock.fetch(`https://api.trustpilot.com/v1/business-units/${trustpilotId("ab", 1)}`, { headers: { apikey: API_KEY } })).status).toBe(404);
    for (const q of ["?startDateTime=x", "?perPage=101", "?perPage=0", "?page=0", "?page=x", "?orderBy=updatedat.desc"]) expect((await get(mock, `/reviews${q}`)).status, q).toBe(400);
    const first = (await (await get(mock, "/reviews?perPage=2")).json()) as { links: unknown[]; reviews: Record<string, unknown>[] };
    expect(first.reviews.map((r) => r.createdAt)).toEqual([before(1), before(300)]);
    expect(first.links).toEqual([]);
    const oldest = (await (await get(mock, "/reviews?orderBy=createdat.asc&perPage=1&page=1")).json()) as typeof first;
    expect(oldest.reviews.map((r) => r.createdAt)).toEqual([before(52_600)]);
    expect(((await (await get(mock, "/reviews")).json()) as typeof first).reviews).toHaveLength(4);
    expect(((await (await get(mock, "/reviews?page=2")).json()) as typeof first).reviews).toEqual([]);
    expect(await (await get(mock, "")).json()).toEqual(trustpilotUnit());
    expect(mock.reads.at(-1)).toEqual({ path: `/v1/business-units/${UNIT}`, query: {} });
  });

  it("answers 429 with Retry-After", async () => {
    const mock = trustpilotDocMock(store({ rateLimits: 1 }));
    const r = await get(mock, "");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("1");
    expect((await get(mock, "")).status).toBe(200);
    expect(TRUSTPILOT_DOC_PAGES.reviews).toMatch(/^https:\/\/developers\.trustpilot\.com\//);
  });
});
