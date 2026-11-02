import { describe, expect, it } from "vitest";
import { runSync, writePolicy, InMemoryWriteAuditLog, WriteGate, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, testPipeline, yextDocMock, yextLocation, yextReview, type YextMock, type YextMockData } from "@karatos/connector-testkit";
import {
  YEXT_API_VERSION,
  YEXT_EVENTS,
  YEXT_EXCERPT_CHARS,
  YEXT_FIRST_PASS_DAYS,
  YEXT_HISTORY_DAYS,
  YEXT_OVERLAP_DAYS,
  YEXT_WRITES,
  YextApiError,
  YextConfigError,
  YextShapeError,
  parseYextCursor,
  yextClient,
  yextConnector,
  yextDayMs,
  yextLink,
  yextLocationEvent,
  yextLocationParams,
  yextMasked,
  yextPage,
  yextRating,
  yextReviewEvent,
  yextReviewParams,
  yextTime,
  type YextBrainEvent,
  type YextClientOptions,
  type YextConnectorOptions,
  type YextCursor,
} from "../src/index.js";

// A key-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = "k".repeat(32);
const TODAY = "2026-11-02";
const NOW = () => new Date(`${TODAY}T15:00:00.000Z`);
const RECEIVED = `${TODAY}T15:00:00.000Z`;
const CTX = { receivedAt: RECEIVED };
const API = "https://api.yextapis.com/v2/accounts";
const DAY_MS = 86_400_000;
const noSleep = async () => {};
const R = { from: "2026-10-01", until: "2026-11-02" };
const TODAY_MS = Date.parse(`${TODAY}T12:00:00Z`);

/** Three locations and six reviews updated 0, 1, 3, 10, 400 and 800 days ago; the last is past the two years read. */
function account(overrides: Partial<YextMockData> = {}): YextMockData {
  yextLocation.reset();
  yextReview.reset();
  const reviews = [0, 1, 3, 10, 400, 800].map((ago) => yextReview.one({ lastYextUpdateTime: TODAY_MS - ago * DAY_MS }));
  reviews[1]!.comments = [{ id: 1, authorRole: "BUSINESS_OWNER", content: "Thank you!", visibility: "PUBLIC" }];
  return { apiKey: KEY, accountId: "test-account", locations: yextLocation.many(3), reviews, ...overrides };
}

const base = (fetch?: typeof globalThis.fetch): YextClientOptions => ({ apiKey: KEY, sleep: noSleep, ...(fetch ? { fetch } : {}) });
const connector = (mock: YextMock, overrides: Partial<YextConnectorOptions> = {}) => yextConnector({ ...base(mock.fetch), now: NOW, ...overrides });

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const fake = (answer: () => Response) => (async () => answer()) as unknown as typeof fetch;
const ranges = (mock: YextMock) => mock.reads.filter((r) => r.path === "/reviews").map((r) => `${r.query.get("minLastYextUpdateDate")}..${r.query.get("maxLastYextUpdateDate")}`);
const ago = (iso: unknown) => Math.round((TODAY_MS - Date.parse(iso as string)) / DAY_MS);

describe("Yext normalizer", () => {
  it("masks email addresses and phone numbers in what a customer wrote, and cuts it short", () => {
    expect(yextMasked("Ask for Sam: sam.test@example.test or (212) 555-0123, ext +1 212 555 0101.")).toBe("Ask for Sam: [email] or [phone], ext [phone].");
    expect(yextMasked("Size 6.5 ring, 14k, 2 carats, order 12345")).toBe("Size 6.5 ring, 14k, 2 carats, order 12345");
    expect(yextMasked(` a\n\n b ${"x".repeat(600)}`)).toHaveLength(YEXT_EXCERPT_CHARS);
    expect(yextMasked("hi there", 4)).toBe("hi t");
    expect(yextMasked("lovely\n\n   ring")).toBe("lovely ring");
    // A full date has as many digits as a phone number, and masking errs that way.
    expect(yextMasked("ring #12345, 1.5 ct, 2026-11-02")).toBe("ring #12345, 1.5 ct, [phone]");
    expect(yextMasked("me@shop")).toBe("me@shop");
    // Long runs of what the patterns look for take time in step with the text, not its square.
    const started = performance.now();
    for (const filler of ["!".repeat(50_000), "1 ".repeat(50_000), `${"a@".repeat(25_000)}.`, `${"!".repeat(30_000)}@${"!".repeat(30_000)}`]) expect(yextMasked(filler)!.length).toBeLessThanOrEqual(YEXT_EXCERPT_CHARS);
    expect(performance.now() - started).toBeLessThan(500);
    expect([" ", 5, null].map((v) => yextMasked(v))).toEqual([undefined, undefined, undefined]);
  });

  it("reads times, ratings and links, turning down anything else", () => {
    expect(yextTime(1_767_225_600_000)).toBe("2026-01-01T00:00:00.000Z");
    expect(yextTime("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00.000Z");
    expect([0, -1, 1.5, "2026-01-01", "soon", 9e15, "2026-13-45T00:00:00Z", undefined].map(yextTime)).toEqual(Array(8).fill(undefined));
    expect([0, 4.5, 10].map(yextRating)).toEqual([0, 4.5, 10]);
    expect([-1, 11, Number.NaN, "5", null].map(yextRating)).toEqual(Array(5).fill(undefined));
    expect(yextLink("https://www.yelp.example.test/biz/test?hrid=abc#x")).toBe("https://www.yelp.example.test/biz/test");
    expect(yextLink(`https://x.test/${"p".repeat(600)}`)).toHaveLength(500);
    expect(["http://x.test/a", "javascript:alert(1)", "not a url", `https://x.test/${"p".repeat(2048)}`, 5].map(yextLink)).toEqual(Array(5).fill(undefined));
    expect(yextDayMs("2026-11-02")).toBe(Date.parse("2026-11-02T00:00:00Z"));
    expect(["2026-02-30", "2026-1-01", 5].map(yextDayMs).every(Number.isNaN)).toBe(true);
  });

  it("reads a page of locations or reviews and its token, and throws on a page without the list", () => {
    expect(yextPage({ response: { entities: [{ a: 1 }, "x"], pageToken: "t1" } }, "entities")).toEqual({ items: [{ a: 1 }, {}], pageToken: "t1" });
    expect(yextPage({ response: { reviews: [], nextPageToken: "t2", pageToken: "no" } }, "reviews").pageToken).toBe("t2");
    expect(yextPage({ response: { entities: [], nextPageToken: "no" } }, "entities").pageToken).toBeUndefined();
    expect(yextPage({ response: { reviews: [], nextPageToken: "" } }, "reviews").pageToken).toBeUndefined();
    for (const bad of [null, {}, { response: {} }, { response: { reviews: {} } }, { response: { entities: [] } }]) expect(() => yextPage(bad, "reviews"), JSON.stringify(bad)).toThrow(YextShapeError);
  });

  it("turns a location into location.updated with its name, address and time zone", () => {
    yextLocation.reset();
    const e = yextLocationEvent(yextLocation.one(), CTX)!;
    expect(e).toMatchObject({ type: YEXT_EVENTS.location, occurredAt: "2026-01-01T00:01:00.000Z", receivedAt: RECEIVED });
    expect(e.payload).toEqual({ locationId: "yext:location:store-1", name: "Test Jewelers 1", line1: "101 Test Street", city: "New York", region: "NY", postalCode: "10001", countryCode: "US", timezone: "America/New_York", closed: false });
    expect(e.idempotencyKey).toMatch(/^yext:location:store-1:[0-9a-f]{16}$/);
    expect(yextLocationEvent({ meta: { id: "a b" } }, CTX)).toBeNull();
    expect(yextLocationEvent({ meta: { id: "s" }, name: ` ${"n".repeat(300)} ` }, CTX)!.payload.name).toBe("n".repeat(200));
    expect(yextLocationEvent(null as never, CTX)).toBeNull();
    const odd = yextLocationEvent({ meta: { id: 7 }, name: " ", address: { countryCode: "usa" }, timezone: "New York; DROP", closed: "no" }, CTX)!;
    expect(odd.payload).toEqual({ locationId: "yext:location:7" });
    expect(odd.occurredAt).toBe(RECEIVED);
  });

  it("turns a review into review.updated without the reviewer, masking what they wrote", () => {
    yextReview.reset();
    const e = yextReviewEvent(yextReview.one(), CTX)!;
    expect(e).toMatchObject({ type: YEXT_EVENTS.review, occurredAt: "2026-01-01T01:00:00.000Z" });
    expect(e.payload).toEqual({
      reviewId: "yext:review:9001",
      locationId: "yext:location:store-1",
      publisher: "GOOGLEMYBUSINESS",
      rating: 2,
      title: "Test review 1",
      excerpt: "Test review 1: lovely ring. Call me at [phone] or write [email]",
      language: "en",
      status: "LIVE",
      publishedAt: "2026-01-01T01:00:00.000Z",
      updatedAt: "2026-01-01T01:00:00.000Z",
      link: "https://reviews.example.test/review/9001",
      comments: 0,
      ownerReplies: 0,
      awaitingReply: true,
    });
    const text = JSON.stringify(e);
    for (const leak of ["Test Customer", "customer1@", "555", "ref=yext"]) expect(text, leak).not.toContain(leak);
    expect(e.idempotencyKey).toMatch(/^yext:review:9001:[0-9a-f]{16}$/);
  });

  it("counts the store's replies, keys a review by what was kept, and leaves out what it can't trust", () => {
    yextReview.reset();
    const review = yextReview.one();
    const a = yextReviewEvent(review, CTX)!;
    expect(yextReviewEvent({ ...review }, { receivedAt: "2026-11-03T00:00:00.000Z" })!.idempotencyKey).toBe(a.idempotencyKey);
    const replied = yextReviewEvent({ ...review, comments: [{ authorRole: "BUSINESS_OWNER", content: "Thanks" }, { authorRole: "CONSUMER" }, "x"] }, CTX)!;
    expect(replied.payload).toMatchObject({ comments: 3, ownerReplies: 1, awaitingReply: false });
    expect(replied.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(JSON.stringify(replied)).not.toContain("Thanks");
    expect(yextReviewEvent({ ...review, status: "REMOVED" }, CTX)!.payload.awaitingReply).toBe(false);
    // Another customer's comment isn't the store's reply.
    expect(yextReviewEvent({ ...review, comments: [{ authorRole: "CONSUMER" }] }, CTX)!.payload).toMatchObject({ comments: 1, ownerReplies: 0, awaitingReply: true });
    expect(yextReviewEvent({ ...review, title: `Email sam@example.test ${"t".repeat(300)}` }, CTX)!.payload.title).toBe(`Email [email] ${"t".repeat(300)}`.slice(0, 200));
    expect(yextReviewEvent({ id: 5, entityId: "store-2", reviewType: "Recommendation", recommendation: "Not Recommended" }, CTX)!.payload).toMatchObject({ locationId: "yext:location:store-2", reviewType: "Recommendation", recommendation: "Not Recommended" });
    for (const id of [-1, 1.5, "a b", undefined]) expect(yextReviewEvent({ id }, CTX), String(id)).toBeNull();
    const odd = yextReviewEvent({ id: 6, rating: 50, status: "<b>", reviewLanguage: "English", publisherId: "x/y", publisherDate: "soon", comments: "none" }, CTX)!;
    expect(odd.payload).toEqual({ reviewId: "yext:review:6", comments: 0, ownerReplies: 0, awaitingReply: true });
    expect(odd.occurredAt).toBeUndefined();
    expect(yextReviewEvent({ id: 6, lastYextUpdateTime: 1_767_225_600_000 }, CTX)!.occurredAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("builds fixtures that look synthetic", () => {
    assertSynthetic(account());
  });
});

describe("Yext client", () => {
  it("builds queries only from a checked range, the fixed fields and Yext's own token", () => {
    expect(Object.fromEntries(yextLocationParams(null))).toEqual({ v: YEXT_API_VERSION, entityTypes: "location", fields: "meta,name,address,closed,timezone", limit: "50" });
    expect(yextLocationParams("abc=").get("pageToken")).toBe("abc=");
    expect(Object.fromEntries(yextReviewParams(R, null))).toEqual({ v: YEXT_API_VERSION, limit: "100", minLastYextUpdateDate: "2026-10-01", maxLastYextUpdateDate: "2026-11-02" });
    expect(yextReviewParams({ from: TODAY, until: TODAY }, "t.1").get("pageToken")).toBe("t.1");
    for (const bad of [{ ...R, status: "LIVE" }, { ...R, from: "2026-10-1" }, { ...R, until: "2026-02-30" }, { from: "2026-11-02", until: "2026-11-01" }]) expect(() => yextReviewParams(bad as never, null), JSON.stringify(bad)).toThrow(YextConfigError);
    for (const bad of ["", "a&b=c", "x".repeat(2049), 5]) {
      expect(() => yextLocationParams(bad as never), String(bad)).toThrow(YextConfigError);
      expect(() => yextReviewParams(R, bad as never), String(bad)).toThrow(YextConfigError);
    }
    expect(YEXT_API_VERSION).toMatch(/^\d{8}$/);
  });

  it("won't build without a key, or with a bad account or environment", () => {
    for (const apiKey of ["", "short", "has a space in it", "x".repeat(257)]) expect(() => yextClient({ ...base(), apiKey }), apiKey).toThrow("set YEXT_API_KEY");
    expect(() => yextClient({ ...base(), accountId: "../me" })).toThrow("YEXT_ACCOUNT_ID must be the account id Yext shows, or left unset");
    expect(() => yextClient({ ...base(), environment: "constructor" })).toThrow("YEXT_ENVIRONMENT must be production or sandbox");
    expect(() => yextClient({ ...base(), apiKey: ` ${KEY} `, accountId: " ", environment: " " })).not.toThrow();
  });

  it("sends only GETs to its two paths, with the key in a header and never in the URL", async () => {
    const mock = yextDocMock(account());
    const client = yextClient(base(mock.fetch));
    await client.locations(null);
    await client.reviews(R, null);
    expect(mock.fetch.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual([`GET ${API}/me/entities`, `GET ${API}/me/reviews`]);
    expect(mock.fetch.calls.every((c) => !c.url.includes(KEY) && !c.url.includes("api_key"))).toBe(true);
    await yextClient({ ...base(mock.fetch), accountId: "test-account" }).locations(null);
    expect(mock.fetch.calls.at(-1)!.url.split("?")[0]).toBe(`${API}/test-account/entities`);
    let sentTo = "";
    await yextClient({ ...base(fake(() => new Response(JSON.stringify({ response: { entities: [] } }), { status: 200 }))), environment: "sandbox", fetch: (async (url: string) => ((sentTo = url), new Response("{}"))) as never }).locations(null);
    expect(sentTo.split("?")[0]).toBe("https://sbx-api.yextapis.com/v2/accounts/me/entities");
  });

  it("explains a wrong key, an app without access and another account", async () => {
    const reason = (data: Partial<YextMockData>, options: Partial<YextClientOptions> = {}) => yextClient({ ...base(yextDocMock(account(data)).fetch), ...options }).reviews(R, null).catch((e: unknown) => e as YextApiError);
    expect(await reason({ apiKey: "j".repeat(32) })).toMatchObject({ status: 401, code: 2002, message: "Yext answered HTTP 401: Invalid API key.; check YEXT_API_KEY" });
    expect(await reason({ reads: ["entities"] })).toMatchObject({ status: 403, code: 2005, message: "Yext answered HTTP 403: The app does not have permission for this endpoint.; give the Yext app read access to Entities and Reviews" });
    expect(await reason({}, { accountId: "other" })).toMatchObject({ status: 403, code: 2004 });
    const odd = (status: number, body: unknown) => yextClient(base(fake(() => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })))).locations(null).catch((e: unknown) => e as YextApiError);
    expect(await odd(400, { meta: { errors: [{ code: 7, message: "m".repeat(300) }] } })).toMatchObject({ code: 7, message: `Yext answered HTTP 400: ${"m".repeat(200)}` });
    expect(await odd(404, { meta: { errors: [{ code: 1.5, message: 5 }] } })).toMatchObject({ code: undefined, message: "Yext answered HTTP 404" });
    expect(await odd(400, { meta: { errors: "x" } })).toMatchObject({ message: "Yext answered HTTP 400" });
    expect(await odd(400, { meta: { errors: [null] } })).toMatchObject({ message: "Yext answered HTTP 400" });
    expect(await odd(409, "<html>")).toMatchObject({ message: "Yext answered HTTP 409" });
    for (const body of ["<html>", "[]", "null", "5"]) expect(await odd(200, body)).toMatchObject({ status: 200, message: "Yext did not answer with JSON" });
  });

  it("waits out a 429, 500 or 504 a few times, doubling to a cap, then gives up with a clear error", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const mock = yextDocMock(account({ rateLimited: 2 }));
    expect(((await yextClient({ ...base(mock.fetch), sleep }).locations(null)).response as { entities: unknown[] }).entities).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
    for (const status of [429, 500, 504]) {
      waits.length = 0;
      let n = 0;
      const failing = fake(() => (n++, new Response(JSON.stringify({ meta: { errors: [{ code: 9 }] } }), { status })));
      const error = await yextClient({ ...base(failing), sleep, retries: 8 }).locations(null).catch((e: unknown) => e);
      expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 64_000]);
      expect(n).toBe(9);
      expect(error).toMatchObject({ status, code: 9, message: status === 429 ? "Yext kept rate-limiting the sync; its quota refills over the hour, and the next sync resumes from the checkpoint" : `Yext kept answering HTTP ${status}, and the next sync resumes from the checkpoint` });
    }
    let n = 0;
    await yextClient(base(fake(() => (n++, new Response("{}", { status: 429 }))))).locations(null).catch(() => {});
    expect(n).toBe(4);
    n = 0;
    await yextClient(base(fake(() => (n++, new Response("{}", { status: 502 }))))).locations(null).catch(() => {});
    expect(n).toBe(1);
  });

  it("checks a query before any request is sent", async () => {
    const mock = yextDocMock(account());
    await expect(yextClient(base(mock.fetch)).reviews({ from: "2026-11-02", until: "2026-11-01" }, null)).rejects.toThrow(YextConfigError);
    await expect(yextClient(base(mock.fetch)).locations("a b")).rejects.toThrow(YextConfigError);
    expect(mock.fetch.calls).toEqual([]);
  });
});

describe("Yext connector", () => {
  it("passes every runSync scenario: full import, replay, resume and retry", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(yextDocMock(account())), expected: { ingested: 3 + 5 } });
    expect(result.full.batches).toBe(2);
    expect(parseYextCursor(result.full.cursor)).toEqual({ pass: "historical", step: "done", pageToken: null, from: "2024-11-01", until: TODAY });
  });

  it("reads every location, then two years of reviews, newest first", async () => {
    const mock = yextDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(8);
    expect(ranges(mock)).toEqual(["2024-11-01..2026-11-02"]);
    const reviews = memory.events.filter((e) => e.type === YEXT_EVENTS.review);
    expect(reviews.map((e) => ago(e.payload.updatedAt))).toEqual([0, 1, 3, 10, 400]);
    expect(reviews.map((e) => e.payload.awaitingReply)).toEqual([true, false, true, true, true]);
    expect(memory.events.filter((e) => e.type === YEXT_EVENTS.location)).toHaveLength(3);
    expect(memory.events.every((e) => e.source === "yext")).toBe(true);
    expect(YEXT_HISTORY_DAYS).toBe(731);
  });

  it("pages through locations and reviews with Yext's tokens", async () => {
    const mock = yextDocMock(account({ pageCap: 2 }));
    const batches = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(mock.reads.map((r) => `${r.path}:${r.query.has("pageToken")}`)).toEqual(["/entities:false", "/entities:true", "/reviews:false", "/reviews:true", "/reviews:true"]);
    expect(batches.map((b) => b.events.length)).toEqual([2, 1, 2, 2, 1]);
    expect(parseYextCursor(batches[0]!.cursor)).toMatchObject({ step: "locations", pageToken: expect.any(String) });
    expect(parseYextCursor(batches[1]!.cursor)).toMatchObject({ step: "reviews", pageToken: null });
    expect(parseYextCursor(batches[4]!.cursor)).toMatchObject({ step: "done", pageToken: null });
  });

  it("follows on from the last pass two days early, storing an answered review as a new version", async () => {
    const data = account();
    const mock = yextDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    await runSync({ connector: connector(mock, { now: () => new Date("2026-10-31T15:00:00.000Z") }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    mock.reads.length = 0;
    // The store answers the newest review, which Yext marks as updated today.
    data.reviews[0] = { ...data.reviews[0]!, comments: [{ authorRole: "BUSINESS_OWNER", content: "Thanks" }] };
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(ranges(mock)).toEqual(["2026-10-29..2026-11-02"]);
    expect([report.ingested, report.duplicates]).toEqual([1, 3 + 2]);
    expect(YEXT_OVERLAP_DAYS).toBe(2);
  });

  it("reads the last week on an incremental pass with nothing to follow, and never more than two years", async () => {
    const mock = yextDocMock(account());
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(ranges(mock)).toEqual(["2026-10-27..2026-11-02"]);
    expect(YEXT_FIRST_PASS_DAYS).toBe(7);
    mock.reads.length = 0;
    const old: YextCursor = { pass: "incremental", step: "done", pageToken: null, from: "2020-01-01", until: "2020-01-08" };
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(old) }));
    expect(ranges(mock)).toEqual(["2024-11-01..2026-11-02"]);
    mock.reads.length = 0;
    // An unfinished import's checkpoint doesn't carry into an incremental pass.
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...old, pass: "historical", step: "reviews" }) }));
    expect(ranges(mock).at(-1)).toBe("2026-10-27..2026-11-02");
    mock.reads.length = 0;
    // A pass that ended "after" today (a clock moved back) starts no later than today.
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...old, from: "2026-11-01", until: "2026-12-01" }) }));
    expect(ranges(mock)).toEqual(["2026-11-02..2026-11-02"]);
  });

  it("resumes an unfinished pass from its step and token, and keeps a finished import finished", async () => {
    const mock = yextDocMock(account({ pageCap: 2 }));
    const first = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    const mid = parseYextCursor(first[0]!.cursor)!;
    mock.reads.length = 0;
    const rest = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(mid) }));
    expect(mock.reads[0]!.query.get("pageToken")).toBe(mid.pageToken);
    expect(rest.length).toBe(first.length - 1);
    mock.reads.length = 0;
    const done: YextCursor = { pass: "historical", step: "done", pageToken: null, from: "2024-10-01", until: "2026-10-01" };
    expect(await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) }))).toEqual([]);
    expect(mock.reads).toEqual([]);
    // An interrupted import picks up at its step, with the range it started with.
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...done, step: "reviews" }) }));
    expect(mock.reads.every((r) => r.path === "/reviews")).toBe(true);
    expect(ranges(mock)[0]).toBe("2024-10-01..2026-10-01");
  });

  it("dead-letters what the pipeline can't store and stores the rest", async () => {
    const client = { locations: async () => ({ response: { entities: [{ meta: { id: "s1" } }, { meta: {} }] } }), reviews: async () => ({ response: { reviews: [{ id: 1, publisherDate: TODAY_MS }, { id: 2 }, { id: "a b" }] } }) };
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(yextDocMock(account()), { client }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // The location Yext gives no time for is dated when read; the review with no date at all is dead-lettered, and records without an id are skipped.
    expect([report.ingested, report.deadLettered]).toEqual([2, 1]);
    expect((memory.events as unknown as YextBrainEvent[]).map((e) => e.type).sort()).toEqual([YEXT_EVENTS.location, YEXT_EVENTS.review]);
  });

  it("turns down a checkpoint that isn't one of its own", () => {
    expect(parseYextCursor(null)).toBeNull();
    const ok: YextCursor = { pass: "historical", step: "reviews", pageToken: "t1", from: "2024-11-01", until: TODAY };
    expect(parseYextCursor(JSON.stringify(ok))).toEqual(ok);
    expect(parseYextCursor(JSON.stringify({ ...ok, step: "locations" }))!.step).toBe("locations");
    expect(parseYextCursor(JSON.stringify({ ...ok, from: TODAY }))!.from).toBe(TODAY);
    const bad: unknown[] = [null, {}, { ...ok, pass: "full" }, { ...ok, step: "listings" }, { ...ok, pageToken: 5 }, { ...ok, pageToken: undefined }, { ...ok, step: "done" }, { ...ok, from: "2026-02-30" }, { ...ok, until: "soon" }, { ...ok, from: "2026-11-03" }];
    for (const c of bad) expect(() => parseYextCursor(JSON.stringify(c)), JSON.stringify(c)).toThrow("not in the expected shape");
  });

  it("declares replying to a review and changing hours, needing approval, and a read-only gate turns both down", async () => {
    const c = connector(yextDocMock(account()));
    expect(c.source).toBe("yext");
    expect(c.writes).toBe(YEXT_WRITES);
    expect(YEXT_WRITES.map((w) => [w.name, w.kind, w.approval, w.dailyCap])).toEqual([["reply_to_review", "append", "each", 20], ["update_hours", "update", "each", 5]]);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.integration, a.action, a.outcome])).toEqual([["yext", "reply_to_review", "refused"], ["yext", "update_hours", "refused"]]);
  });

  it("lets a write through only where the instance turned it on, by name", async () => {
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: writePolicy(["yext:reply_to_review"]), audit });
    const ran: string[] = [];
    for (const action of YEXT_WRITES) await gate.run(action, "test", async () => void ran.push(action.name)).catch(() => {});
    expect(ran).toEqual(["reply_to_review"]);
    expect(audit.entries.map((a) => a.outcome)).toEqual(["performed", "refused"]);
  });

  it("never asks Yext for anything but its two lists, with the fixed parameters", async () => {
    const mock = yextDocMock(account({ pageCap: 2 }));
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`))).toEqual(new Set([`GET ${API}/me/entities`, `GET ${API}/me/reviews`]));
    for (const r of mock.reads) {
      const keys = [...r.query.keys()].filter((k) => k !== "pageToken").sort();
      expect(keys).toEqual(r.path === "/entities" ? ["entityTypes", "fields", "limit", "v"] : ["limit", "maxLastYextUpdateDate", "minLastYextUpdateDate", "v"]);
    }
  });
});

describe("the Yext mock", () => {
  it("turns down a missing key or version, a bad page size or date, an offset with a token, and a token from another query", async () => {
    const mock = yextDocMock(account({ pageCap: 2 }));
    const token = ((await yextClient(base(mock.fetch)).reviews(R, null)).response as { nextPageToken: string }).nextPageToken;
    const get = (query: string, headers: Record<string, string> = { "api-key": KEY }) => mock.fetch(`${API}/me/reviews?${query}`, { headers }).then((r) => r.status);
    expect(await get("v=20261101")).toBe(200);
    expect(await get(`v=20261101&api_key=${KEY}`, {})).toBe(200);
    expect(await get("v=20261101", {})).toBe(400);
    expect(await get("")).toBe(400);
    expect(await get("v=20261101&limit=101")).toBe(400);
    expect(await get("v=20261101&minLastYextUpdateDate=2026-1-01")).toBe(400);
    expect(await get(`v=20261101&offset=2&pageToken=${token}`)).toBe(400);
    expect(await get(`v=20261101&limit=5&pageToken=${token}`)).toBe(400);
    expect(await get("v=20261101&offset=9901")).toBe(400);
    expect(await mock.fetch(`${API}/me/entities?v=20261101&limit=51`, { headers: { "api-key": KEY } }).then((r) => r.status)).toBe(400);
  });
});
