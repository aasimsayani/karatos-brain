import { describe, expect, it, vi } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import {
  GBP_DOC_PAGES,
  GBP_MANAGE_SCOPE,
  GBP_TEST_ACCOUNT,
  TEST_ORG,
  UndocumentedRequestError,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  gbpDocMock,
  gbpLocation,
  gbpReview,
  testPipeline,
  type GbpMock,
  type GbpMockData,
} from "@karatos/connector-testkit";
import {
  BUSINESS_MANAGE_SCOPE,
  GBP_EVENTS,
  GBP_FIRST_METRICS_DAYS,
  GBP_FIRST_REVIEW_LOOKBACK_MS,
  GBP_LOCATION_FIELDS,
  GBP_METRICS,
  GBP_REVIEW_OVERLAP_MS,
  GBP_REVISIT_DAYS,
  GBP_WINDOW_DAYS,
  GBP_WRITES,
  GbpApiError,
  GbpConfigError,
  gbpClient,
  gbpConnector,
  gbpDayMs,
  gbpLocationEvent,
  gbpMetricsEvents,
  gbpReviewEvent,
  gbpReviewLocation,
  gbpScopeProblem,
  memoryTokenStore,
  parseGbpCursor,
  type GbpClient,
  type GbpCursor,
  type GbpEvent,
  type GbpOptions,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = ["test-client", "apps.googleusercontent.com"].join(".");
const CLIENT_SECRET = ["sec", "x".repeat(20)].join("-");
const REFRESH = ["1/", "r".repeat(30)].join("");
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const INFO = `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${GBP_TEST_ACCOUNT}/locations`;
const REVIEWS = (loc: string) => `https://mybusiness.googleapis.com/v4/accounts/${GBP_TEST_ACCOUNT}/locations/${loc}/reviews`;
const PERF = (loc: string) => `https://businessprofileperformance.googleapis.com/v1/locations/${loc}:fetchMultiDailyMetricsTimeSeries`;
const AUTH = "https://www.googleapis.com/auth/";
const noSleep = async () => {};
const ctx = { receivedAt: RECEIVED };
const hours = (n: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + n * 3_600_000).toISOString();

const base = () => ({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), accountId: GBP_TEST_ACCOUNT });

/** Two locations; location 1001 has three reviews, 1002 one; a few metrics on the last day read. */
function account(overrides: Partial<GbpMockData> = {}): GbpMockData {
  gbpLocation.reset();
  gbpReview.reset();
  return {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    refreshToken: REFRESH,
    locations: gbpLocation.many(2),
    reviews: {
      "1001": gbpReview.many(3),
      "1002": [gbpReview.one({ name: `accounts/${GBP_TEST_ACCOUNT}/locations/1002/reviews/rev-9`, reviewId: "rev-9" })],
    },
    metrics: { "1001": { CALL_CLICKS: { "2026-11-10": 3 }, WEBSITE_CLICKS: { "2026-11-10": 12 } } },
    ...overrides,
  };
}

const connector = (mock: GbpMock, overrides: Partial<GbpOptions> = {}) => gbpConnector({ ...base(), fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as GbpEvent[];
async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}
function scripted(responses: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string | undefined });
    return responses[Math.min(sent.length - 1, responses.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const token = (extra: Record<string, unknown> = {}) => json(200, { access_token: "at-1", expires_in: 3599, scope: GBP_MANAGE_SCOPE, token_type: "Bearer", ...extra });
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof gbpClient>[0]> = {}) => {
  const slept: number[] = [];
  const clock = { t: 1_000_000 };
  const c = gbpClient({ ...base(), fetch, sleep: async (ms) => void slept.push(ms), clock: () => clock.t, ...extra });
  return { c, slept, clock };
};

describe("Google Business Profile client", () => {
  it("checks its settings before sending anything", () => {
    expect(() => gbpClient({ ...base(), clientId: " " })).toThrow(new GbpConfigError("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET"));
    expect(() => gbpClient({ ...base(), clientSecret: "" })).toThrow("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
    expect(() => gbpClient({ ...base(), clientSecret: "  " })).toThrow("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
    expect(() => gbpClient({ ...base(), clientId: undefined as unknown as string })).toThrow("GOOGLE_CLIENT_ID");
    expect(() => gbpClient({ ...base(), clientSecret: undefined as unknown as string })).toThrow("GOOGLE_CLIENT_SECRET");
    for (const accountId of ["", "accounts/123", "12a", "1".repeat(31), undefined as unknown as string]) expect(() => gbpClient({ ...base(), accountId }), String(accountId)).toThrow(new GbpConfigError("GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID must be the account's numeric id"));
    expect(gbpClient({ ...base(), accountId: ` ${"1".repeat(30)} ` }).accountId).toBe("1".repeat(30));
    expect(new GbpConfigError("x").name).toBe("GbpConfigError");
    expect(new GbpApiError("x", 500)).toMatchObject({ name: "GbpApiError", status: 500 });
  });

  it("refreshes the token with the shared client, then sends only GETs to the three paths", async () => {
    const { fetch, sent } = scripted([token(), json(200, { locations: [] })]);
    const { c } = client(fetch);
    await c.locations(null);
    await c.locations("off-100");
    await c.reviews("1001", null);
    await c.reviews("1001", "tok_1-2.3~4=5+6/7");
    await c.metrics("1001", "2026-01-01", "2026-01-31");
    expect(sent[0]).toEqual({ url: TOKEN_URL, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "refresh_token", refresh_token: REFRESH }).toString() });
    const get = { accept: "application/json", authorization: "Bearer at-1" };
    expect(sent.slice(1)).toEqual([
      { url: `${INFO}?readMask=name%2Ctitle%2CstoreCode&pageSize=100`, method: "GET", headers: get, body: undefined },
      { url: `${INFO}?readMask=name%2Ctitle%2CstoreCode&pageSize=100&pageToken=off-100`, method: "GET", headers: get, body: undefined },
      { url: `${REVIEWS("1001")}?pageSize=50&orderBy=updateTime+desc`, method: "GET", headers: get, body: undefined },
      { url: `${REVIEWS("1001")}?pageSize=50&orderBy=updateTime+desc&pageToken=tok_1-2.3%7E4%3D5%2B6%2F7`, method: "GET", headers: get, body: undefined },
      {
        url: `${PERF("1001")}?${GBP_METRICS.map((m) => `dailyMetrics=${m}`).join("&")}&dailyRange.start_date.year=2026&dailyRange.start_date.month=1&dailyRange.start_date.day=1&dailyRange.end_date.year=2026&dailyRange.end_date.month=1&dailyRange.end_date.day=31`,
        method: "GET",
        headers: get,
        body: undefined,
      },
    ]);
    expect(GBP_LOCATION_FIELDS).toBe("name,title,storeCode");
    expect(BUSINESS_MANAGE_SCOPE).toBe(`${AUTH}business.manage`);
    expect(GBP_METRICS).toHaveLength(9);
  });

  it("refuses an id, token or range it wasn't made for, before sending anything", async () => {
    const { fetch, sent } = scripted([token()]);
    const { c } = client(fetch);
    for (const id of ["", "12a", "locations/1", "1".repeat(31)]) {
      await expect(c.reviews(id, null), id).rejects.toThrow(new GbpApiError("a location id must be digits", 0));
      await expect(c.metrics(id, "2026-01-01", "2026-01-01"), id).rejects.toThrow("a location id must be digits");
    }
    for (const page of ["", "a b", "a&b=c", "x".repeat(2049)]) await expect(c.locations(page), page).rejects.toThrow(new GbpApiError("a page token must be one Google gave", 0));
    await expect(c.reviews("1001", "a?b")).rejects.toThrow("a page token");
    for (const [from, to] of [["2026-02-30", "2026-03-01"], ["2026-01-02", "2026-01-01"], ["2026-1-1", "2026-01-02"], ["2026-01-01", "x"]]) {
      await expect(c.metrics("1001", from!, to!), `${from} ${to}`).rejects.toThrow(new GbpApiError("metrics need a from day on or before a to day", 0));
    }
    expect(sent).toHaveLength(0);
    await c.locations("x".repeat(2048)).catch(() => undefined);
    expect(sent).toHaveLength(2);
  });

  it("checks the scopes each new token holds", async () => {
    expect(gbpScopeProblem(GBP_MANAGE_SCOPE)).toBeNull();
    expect(gbpScopeProblem(`openid ${GBP_MANAGE_SCOPE} email ${AUTH}userinfo.email`)).toBeNull();
    expect(gbpScopeProblem(`openid  ${GBP_MANAGE_SCOPE} `)).toBeNull();
    expect(gbpScopeProblem(`${GBP_MANAGE_SCOPE} ${AUTH}plus.business.manage`)).toBe(`the Google Business Profile connection holds more than it needs (${AUTH}plus.business.manage)`);
    expect(gbpScopeProblem("openid")).toBe(`the Google Business Profile connection doesn't hold ${GBP_MANAGE_SCOPE}`);
    for (const scope of [undefined, "", "  ", 5]) expect(gbpScopeProblem(scope)).toBe("Google didn't say which scopes the token holds");
    expect(gbpScopeProblem(`${GBP_MANAGE_SCOPE} ${"x ".repeat(3000)}`)).toMatch(/more than it needs \(x, x, x, x, x\)$/);
    const wide = scripted([token({ scope: `${GBP_MANAGE_SCOPE} ${AUTH}drive` })]);
    await expect(client(wide.fetch).c.locations(null)).rejects.toThrow(new GbpConfigError(`the Google Business Profile connection holds more than it needs (${AUTH}drive); reconnect it with only ${GBP_MANAGE_SCOPE}`));
    expect(wide.sent).toHaveLength(1);
  });

  it("explains a refresh Google turns down, and keeps a refresh token Google sends back", async () => {
    const refresh = async (response: () => Response) => client(scripted([response]).fetch).c.locations(null);
    await expect(refresh(json(400, { error: "invalid_grant" }))).rejects.toThrow(new GbpApiError("Google turned down the token refresh (HTTP 400, invalid_grant); reconnect Google Business Profile to get a new refresh token", 400));
    await expect(refresh(json(401, { error: "invalid_client" }))).rejects.toThrow("Google turned down the token refresh (HTTP 401, invalid_client)");
    await expect(refresh(json(500, { error: 5 }))).rejects.toThrow(/^Google turned down the token refresh \(HTTP 500\)$/);
    await expect(refresh(() => new Response("{", { status: 200 }))).rejects.toThrow("(HTTP 200)");
    for (const value of [5, "", "a b", "t".repeat(4097)]) await expect(refresh(token({ access_token: value })), String(value)).rejects.toThrow("(HTTP 200)");
    await expect(refresh(json(201, { access_token: "at", scope: GBP_MANAGE_SCOPE }))).rejects.toThrow(new GbpApiError("Google turned down the token refresh (HTTP 201)", 201));
    await expect(refresh(json(400, { error: "e".repeat(50) }))).rejects.toThrow(`(HTTP 400, ${"e".repeat(40)})`);
    const tokens = memoryTokenStore(REFRESH);
    await client(scripted([token({ refresh_token: "1/new" }), json(200, {})]).fetch, { tokens }).c.locations(null);
    expect(tokens.current).toBe("1/new");
    const kept = memoryTokenStore(REFRESH);
    await client(scripted([token({ refresh_token: "" }), json(200, {})]).fetch, { tokens: kept }).c.locations(null);
    expect(kept.current).toBe(REFRESH);
    await expect(client(scripted([token()]).fetch, { tokens: memoryTokenStore("  ") }).c.locations(null)).rejects.toThrow(new GbpConfigError("set GOOGLE_BUSINESS_PROFILE_REFRESH_TOKEN"));
  });

  it("keeps a token until two minutes before it lapses, an hour when Google doesn't say", async () => {
    const run = async (expires: unknown, wait: number) => {
      const { fetch, sent } = scripted([token({ expires_in: expires }), json(200, {}), json(200, {}), token({ access_token: "at-2" }), json(200, {})]);
      const { c, clock } = client(fetch);
      await c.locations(null);
      clock.t += wait - 1;
      await c.locations(null);
      clock.t += 1;
      await c.locations(null);
      return sent.map((s) => (s.url === TOKEN_URL ? "T" : s.headers.authorization));
    };
    expect(await run(600, 480_000)).toEqual(["T", "Bearer at-1", "Bearer at-1", "T", "Bearer at-2"]);
    for (const expires of [undefined, 0, -5, 1.5, "600"]) expect(await run(expires, 3_480_000), String(expires)).toEqual(["T", "Bearer at-1", "Bearer at-1", "T", "Bearer at-2"]);
  });

  it("times tokens by the real clock by default", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-11T15:00:00.000Z"));
      const { fetch, sent } = scripted([token({ expires_in: 600 }), json(200, {}), json(200, {}), token(), json(200, {})]);
      const c = gbpClient({ ...base(), fetch, sleep: noSleep });
      await c.locations(null);
      vi.setSystemTime(new Date("2026-11-11T15:07:59.999Z"));
      await c.locations(null);
      vi.setSystemTime(new Date("2026-11-11T15:08:00.000Z"));
      await c.locations(null);
      expect(sent.map((s) => s.url === TOKEN_URL)).toEqual([true, false, false, true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes once when a call is turned down, and stops on a second", async () => {
    const twice = scripted([token(), json(401, {}), token({ access_token: "at-2" }), json(200, { ok: 1 })]);
    expect(await client(twice.fetch).c.locations(null)).toEqual({ ok: 1 });
    expect(twice.sent.map((s) => s.headers.authorization)).toEqual([undefined, "Bearer at-1", undefined, "Bearer at-2"]);
    const always = scripted([token(), json(401, { error: { message: "Request had invalid authentication credentials." } }), token(), json(401, {})]);
    await expect(client(always.fetch).c.locations(null)).rejects.toThrow(new GbpApiError("Google answered HTTP 401 for the locations", 401));
    expect(always.sent).toHaveLength(4);
  });

  it("explains an account or location it may not read, and other answers", async () => {
    const at = async (response: () => Response) => client(scripted([token(), response]).fetch, { retries: 0 }).c.reviews("1001", null);
    await expect(at(json(403, { error: { message: "The caller does not have permission" } }))).rejects.toThrow(
      new GbpConfigError("Google turned down the reviews: The caller does not have permission; the project needs Business Profile API access and the connected account must manage the locations"),
    );
    await expect(at(json(403, {}))).rejects.toThrow(/^Google turned down the reviews; the project/);
    await expect(at(json(404, { error: { message: "m".repeat(250) } }))).rejects.toThrow(new GbpApiError(`Google answered HTTP 404 for the reviews: ${"m".repeat(200)}`, 404));
    await expect(at(json(201, {}))).rejects.toMatchObject({ status: 201 });
    await expect(at(json(200, null))).rejects.toThrow(new GbpApiError("Google answered the reviews without JSON", 200));
    await expect(at(json(200, []))).rejects.toThrow("without JSON");
    await expect(at(json(200, 5))).rejects.toThrow("without JSON");
    await expect(at(() => new Response("{", { status: 200 }))).rejects.toThrow("without JSON");
    await expect(client(scripted([token(), json(500, { error: { message: 5 } })]).fetch, { retries: 0 }).c.metrics("1001", "2026-01-01", "2026-01-01")).rejects.toThrow(/^Google answered HTTP 500 for the metrics$/);
  });

  it("waits out a 429 or 5xx as Retry-After says, up to a minute, else 1, 2 and 4 seconds", async () => {
    const waits = async (headers: Record<string, string>, status = 429) => {
      const { fetch, sent } = scripted([token(), json(status, {}, headers), json(200, {})]);
      const { c, slept } = client(fetch);
      await c.locations(null);
      expect(sent).toHaveLength(3);
      return slept;
    };
    expect(await waits({ "retry-after": "2" })).toEqual([2000]);
    expect(await waits({ "retry-after": "60" })).toEqual([60_000]);
    expect(await waits({ "retry-after": "61" })).toEqual([60_000]);
    for (const value of ["0", "-1", "1.5", "soon"]) expect(await waits({ "retry-after": value }), value).toEqual([1000]);
    for (const status of [500, 502, 503, 504]) expect(await waits({ "retry-after": "3" }, status), String(status)).toEqual([3000]);
    const { fetch, sent } = scripted([token(), json(503, {})]);
    const { c, slept } = client(fetch);
    await expect(c.locations(null)).rejects.toMatchObject({ status: 503 });
    expect(sent).toHaveLength(5);
    expect(slept).toEqual([1000, 2000, 4000]);
    const once = scripted([token(), json(501, {})]);
    await expect(client(once.fetch).c.locations(null)).rejects.toMatchObject({ status: 501 });
    expect(once.sent).toHaveLength(2);
    const one = scripted([token(), json(429, {})]);
    await expect(client(one.fetch, { retries: 1 }).c.locations(null)).rejects.toMatchObject({ status: 429 });
    expect(one.sent).toHaveLength(3);
  });

  it("works with the default sleep and fetch", async () => {
    const original = globalThis.fetch;
    const { fetch, sent } = scripted([token(), json(429, {}, { "retry-after": "0" }), json(200, {})]);
    globalThis.fetch = fetch;
    try {
      const started = Date.now();
      await gbpClient({ ...base() }).locations(null);
      expect(Date.now() - started).toBeGreaterThanOrEqual(990);
      expect(sent).toHaveLength(3);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reads days as YYYY-MM-DD only", () => {
    expect(gbpDayMs("2026-03-01")).toBe(Date.parse("2026-03-01T00:00:00Z"));
    for (const bad of ["2026-02-29", "2026-3-1", "20260301", 5, null, "2026-03-01T00:00:00Z"]) expect(gbpDayMs(bad), String(bad)).toBeNaN();
  });
});

describe("Google Business Profile events", () => {
  it("reads a location by its name and store code only", () => {
    gbpLocation.reset();
    const { ok, event } = gbpLocationEvent({ ...gbpLocation.one(), storefrontAddress: { addressLines: ["1 Test St"] } }, ctx);
    expect(ok).toBe(true);
    expect(event).toMatchObject({ type: GBP_EVENTS.location, occurredAt: RECEIVED, receivedAt: RECEIVED });
    expect(event.payload).toEqual({ system: "Google Business Profile", locationId: "gbp:location:1001", name: "Test Jewelers 1", storeCode: "STORE-1" });
    expect(event.idempotencyKey).toMatch(/^gbp:location:1001:[0-9a-f]{12}$/);
    expect(event.id).toBe(event.idempotencyKey.replace(/:/g, "_"));
    const p = (change: Record<string, unknown>) => gbpLocationEvent({ name: "locations/5", ...change }, ctx).event.payload;
    for (const title of ["<b>x</b>", "a > b", "", "t".repeat(201), 5]) expect(p({ title }).name, String(title)).toBeUndefined();
    expect(p({ title: "  Halo  " }).name).toBe("Halo");
    expect(p({ title: "t".repeat(200) }).name).toBe("t".repeat(200));
    for (const storeCode of ["a b", "", "s".repeat(65), 5]) expect(p({ storeCode }).storeCode, String(storeCode)).toBeUndefined();
    expect(p({ storeCode: "A_1.b-2" }).storeCode).toBe("A_1.b-2");
    for (const raw of [null, [], { name: "locations/x" }, { name: "accounts/1/locations/2" }, { name: "locations/1 " }]) {
      const dead = gbpLocationEvent(raw, ctx);
      expect(dead.ok, JSON.stringify(raw)).toBe(false);
      expect(dead.event.occurredAt).toBeUndefined();
      expect(dead.event.idempotencyKey).toMatch(/^gbp:unreadable_location:[0-9a-f]{12}$/);
    }
    expect(gbpLocationEvent([], ctx).event.payload.problems).toEqual(["location is not an object", "location has no name that reads"]);
    expect(gbpLocationEvent(undefined, ctx).event.idempotencyKey).toMatch(/^gbp:unreadable_location:[0-9a-f]{12}$/);
    expect(gbpLocationEvent(null, ctx).event.payload).toEqual({ system: "Google Business Profile", kind: "location", problems: ["location is not an object", "location has no name that reads"] });
  });

  it("reads a review without the reviewer's name or photo, masking contact details", () => {
    gbpReview.reset();
    const review = gbpReview.one();
    const { ok, event } = gbpReviewEvent(review, { ...ctx, locationId: "1001" });
    expect(ok).toBe(true);
    expect(event.payload).toEqual({
      system: "Google Business Profile",
      reviewId: "gbp:review:rev-1",
      publisher: "Google",
      kind: "listing",
      locationId: "gbp:location:1001",
      rating: 1,
      needsFollowUp: true,
      excerpt: "Test review 1, call me at [phone]",
      anonymous: false,
      ownerReplies: 0,
      awaitingReply: true,
      repliedAt: undefined,
      replyState: undefined,
      publishedAt: hours(1),
      editedAt: hours(1),
    });
    expect(event).toMatchObject({ type: "review.updated", occurredAt: hours(1) });
    expect(JSON.stringify(event)).not.toMatch(/Test Customer|photo|555-010/);
    const p = (change: Record<string, unknown>) => gbpReviewEvent({ ...review, ...change }, { ...ctx, locationId: "1001" }).event.payload;
    expect(["TWO", "THREE", "FOUR", "FIVE"].map((starRating) => [p({ starRating }).rating, p({ starRating }).needsFollowUp])).toEqual([
      [2, true],
      [3, false],
      [4, false],
      [5, false],
    ]);
    expect(p({ reviewer: { isAnonymous: true } }).anonymous).toBe(true);
    expect(p({ reviewer: { isAnonymous: "true" } }).anonymous).toBe(false);
    expect(p({ reviewReply: { comment: "Thank you so much", updateTime: hours(5), reviewReplyState: "APPROVED" } })).toMatchObject({ ownerReplies: 1, awaitingReply: false, repliedAt: hours(5), replyState: "approved" });
    expect(JSON.stringify(p({ reviewReply: { comment: "Thank you so much", updateTime: hours(5) } }))).not.toContain("Thank you");
    expect(p({ reviewReply: { reviewReplyState: "PENDING" } })).toMatchObject({ ownerReplies: 0, replyState: undefined });
    for (const state of ["pending", "A B", "S".repeat(41), 5]) expect(p({ reviewReply: { updateTime: hours(5), reviewReplyState: state } }).replyState, String(state)).toBeUndefined();
    expect(p({ comment: 5 }).excerpt).toBeUndefined();
    expect(p({ updateTime: "x" }).editedAt).toBeUndefined();
    expect(p({ createTime: "2026-01-01T05:00:00.123456789Z" }).publishedAt).toBe("2026-01-01T05:00:00.123Z");
  });

  it("dead-letters a review that doesn't read, or isn't of the location read", () => {
    gbpReview.reset();
    const review = gbpReview.one();
    const problems = (raw: unknown, locationId = "1001") => {
      const { ok, event } = gbpReviewEvent(raw, { ...ctx, locationId });
      expect(event.occurredAt === undefined).toBe(!ok);
      return ok ? [] : (event.payload.problems as string[]);
    };
    expect(problems(null)).toEqual(["review is not an object", "review has no id that reads", "review is not of the location read", "review has no rating from one to five", "review has no time that reads"]);
    expect(problems(review, "1002")).toEqual(["review is not of the location read"]);
    expect(problems({ ...review, reviewId: "a b" })).toEqual(["review has no id that reads"]);
    expect(problems({ ...review, reviewId: "r".repeat(201) })).toEqual(["review has no id that reads"]);
    expect(problems({ ...review, reviewId: "r".repeat(200) })).toEqual([]);
    expect(problems({ ...review, starRating: "STAR_RATING_UNSPECIFIED" })).toEqual(["review has no rating from one to five"]);
    expect(problems({ ...review, createTime: "2026-02-30T00:00:00Z" })).toEqual(["review has no time that reads"]);
    const dead = gbpReviewEvent({ ...review, starRating: 5 }, { ...ctx, locationId: "1001" });
    expect(dead.event.idempotencyKey).toMatch(/^gbp:unreadable_review:[0-9a-f]{12}$/);
    expect(dead.event.payload).toEqual({ system: "Google Business Profile", kind: "review", problems: ["review has no rating from one to five"] });
    expect(gbpReviewLocation(review)).toBe("1001");
    for (const name of [`x${review.name}`, `${review.name}/x`, "accounts/1/locations/2/reviews/a b", 5]) expect(gbpReviewLocation({ name }), String(name)).toBeUndefined();
    expect(gbpReviewEvent({ ...review, reviewId: "x" }, { ...ctx, locationId: "1001" }).event.idempotencyKey).not.toBe(gbpReviewEvent(review, { ...ctx, locationId: "1001" }).event.idempotencyKey);
  });

  it("keys each review until what was kept changes", () => {
    gbpReview.reset();
    const review = gbpReview.one();
    const key = (r: unknown, receivedAt = RECEIVED) => gbpReviewEvent(r, { receivedAt, locationId: "1001" }).event.idempotencyKey;
    expect(key({ ...review, reviewer: { displayName: "Someone Else" } }, "2026-12-01T00:00:00.000Z")).toBe(key(review));
    expect(key({ ...review, starRating: "FIVE" })).not.toBe(key(review));
  });

  it("makes one event a day for a window, zero where Google leaves a value out", () => {
    const series = (m: string, values: [string, string | undefined][], extra: Record<string, unknown> = {}) => ({
      dailyMetric: m,
      ...extra,
      timeSeries: { datedValues: values.map(([d, v]) => ({ date: { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)), day: Number(d.slice(8)) }, ...(v === undefined ? {} : { value: v }) })) },
    });
    const raw = {
      multiDailyMetricTimeSeries: [
        {
          dailyMetricTimeSeries: [
            series("CALL_CLICKS", [
              ["2026-01-30", "3"],
              ["2026-01-31", undefined],
            ]),
            series("WEBSITE_CLICKS", [["2026-01-31", "12"]]),
            series("BUSINESS_FOOD_ORDERS", [["2026-01-31", "99"]]),
            series("CALL_CLICKS", [["2026-01-31", "50"]], { dailySubEntityType: { timeOfDay: {} } }),
          ],
        },
        { other: 1 },
        5,
      ],
    };
    const reads = gbpMetricsEvents(raw, { ...ctx, locationId: "1001", from: "2026-01-30", to: "2026-02-01" });
    expect(reads.map((r) => r.ok)).toEqual([true, true, true]);
    const zero = { desktopMapsViews: 0, desktopSearchViews: 0, mobileMapsViews: 0, mobileSearchViews: 0, directionRequests: 0, calls: 0, websiteClicks: 0, messages: 0, bookings: 0 };
    expect(reads.map((r) => r.event.payload)).toEqual([
      { system: "Google Business Profile", locationId: "gbp:location:1001", day: "2026-01-30", ...zero, calls: 3 },
      { system: "Google Business Profile", locationId: "gbp:location:1001", day: "2026-01-31", ...zero, websiteClicks: 12 },
      { system: "Google Business Profile", locationId: "gbp:location:1001", day: "2026-02-01", ...zero },
    ]);
    expect(reads[0]!.event).toMatchObject({ type: "analytics.local_listing_reported", occurredAt: "2026-01-30T00:00:00.000Z", receivedAt: RECEIVED, idempotencyKey: expect.stringMatching(/^gbp:metrics:1001:2026-01-30:[0-9a-f]{12}$/) });
    expect(reads[2]!.event.idempotencyKey).toMatch(/^gbp:metrics:1001:2026-02-01:/);
  });

  it("lists metric values that don't read, and dead-letters an answer without series", () => {
    const point = (date: unknown, value: unknown) => ({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ date, value }, ...(date === 0 ? [{ date: { year: 2026, month: 1, day: 1 }, value: "-1" }] : [])] } }] }] });
    const one = (raw: unknown) => gbpMetricsEvents(raw, { ...ctx, locationId: "1001", from: "2026-01-01", to: "2026-01-01" });
    for (const [date, value] of [
      [{ year: 2026, month: 1, day: 1 }, "x"],
      [{ year: 2026, month: 1, day: 1 }, 3],
      [{ year: 2026, month: 1, day: 1 }, "01"],
      [{ year: 2026, month: 1, day: 1 }, "1".repeat(16)],
      [{ year: 2026, month: 1, day: 2 }, "1"],
      [{ year: 2026, month: 2, day: 30 }, "1"],
      [{ year: 2026, month: 1 }, "1"],
      [{ year: "2026", month: 1, day: 1 }, "1"],
      [{ year: 2026, month: 1, day: "1" }, "1"],
      [0, "1"],
    ] as [unknown, unknown][]) {
      const [r] = one(point(date, value));
      expect(r!.event.payload, JSON.stringify([date, value])).toMatchObject({ calls: 0, unread: ["calls"] });
    }
    expect(one(point({ year: 2026, month: 1, day: 1 }, "999999999999999"))[0]!.event.payload).toMatchObject({ calls: 999_999_999_999_999 });
    expect(one(point({ year: 2026, month: 1, day: 1 }, "0"))[0]!.event.payload.unread).toBeUndefined();
    for (const raw of [null, {}, { multiDailyMetricTimeSeries: {} }]) {
      const reads = one(raw);
      expect(reads).toHaveLength(1);
      expect(reads[0]!.ok).toBe(false);
      expect(reads[0]!.event).toMatchObject({ occurredAt: undefined, payload: { system: "Google Business Profile", kind: "metrics", problems: ["metrics have no series list"] }, idempotencyKey: expect.stringMatching(/^gbp:unreadable_metrics:/) });
    }
    expect(one({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: 5 }, { dailyMetricTimeSeries: [{ dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: 5 } }] }] })[0]!.event.payload.calls).toBe(0);
  });
});

describe("Google Business Profile connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(gbpDocMock(account())), expected: { ingested: 2 + 4 + 730 * 2 } });
    expect(result.full.ingested).toBe(1466);
  });

  it("imports the locations, two years of reviews, then metrics a month at a time, and stops for good", async () => {
    const mock = gbpDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 1466, deadLettered: 0 });
    const windows = mock.reads.filter((r) => r.what === "metrics");
    expect(windows).toHaveLength(48);
    expect(windows.slice(0, 2).map((r) => r.range)).toEqual(["2024-11-11..2024-12-11", "2024-12-12..2025-01-11"]);
    expect(windows[23]).toEqual({ what: "metrics", location: "1001", page: null, range: "2026-10-25..2026-11-10" });
    expect(windows[24]!.location).toBe("1002");
    expect(mock.reads.slice(0, 3).map((r) => [r.what, r.location])).toEqual([
      ["locations", null],
      ["reviews", "1001"],
      ["reviews", "1002"],
    ]);
    const types = memory.events.map((e) => e.type);
    expect(types.slice(0, 6)).toEqual(["location.updated", "location.updated", "review.updated", "review.updated", "review.updated", "review.updated"]);
    expect(memory.events.find((e) => e.type === "analytics.local_listing_reported" && (e.payload as { day: string }).day === "2026-11-10")?.payload).toMatchObject({ calls: 3, websiteClicks: 12 });
      // Keys end in a hex digest, which can read like a phone number; what was read lives in the payloads.
    assertSynthetic(memory.events.map((e) => e.payload));
    expect(JSON.parse(report.cursor!)).toEqual({
      done: true,
      marks: [
        ["1001", hours(3)],
        ["1002", hours(4)],
      ],
      through: "2026-11-10",
      pass: null,
    });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(51);
    expect(GBP_WINDOW_DAYS).toBe(31);
  });

  it("reads every page of locations and reviews, stopping at the first review older than the start", async () => {
    gbpReview.reset();
    const old = (n: number) => gbpReview.one({ updateTime: "2024-01-01T00:00:00.000Z", createTime: "2024-01-01T00:00:00.000Z", reviewId: `old-${n}`, name: `accounts/${GBP_TEST_ACCOUNT}/locations/1001/reviews/old-${n}` });
    const reviews = [...gbpReview.many(3), old(1), old(2)];
    const mock = gbpDocMock(account({ pageCap: 1, reviews: { "1001": reviews }, locations: [{ name: "locations/1001" }] }));
    gbpLocation.reset();
    const batches = await drain(connector(mock, { historyYears: 1 }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(batches[0]!.events).toHaveLength(1);
    expect(eventsOf([batches[1]!]).map((e) => e.payload.reviewId)).toEqual(["gbp:review:rev-3", "gbp:review:rev-2", "gbp:review:rev-1"]);
    expect(mock.reads.filter((r) => r.what === "reviews").map((r) => r.page)).toEqual([null, "off-1", "off-2", "off-3"]);
    // One more page of locations: three pages of one.
    const many = gbpDocMock(account({ pageCap: 1, locations: [{ name: "locations/1001" }, { name: "locations/1002" }, { name: "locations/1003" }], reviews: {} }));
    const first = (await drain(connector(many, { historyYears: 1 }).historicalImport({ organizationId: TEST_ORG, cursor: null })))[0]!;
    expect(first.events).toHaveLength(3);
    expect((JSON.parse(first.cursor) as GbpCursor).pass!.locations).toEqual(["1001", "1002", "1003"]);
  });

  it("keeps a location's newest review change, and reads from it less a day next time", async () => {
    const mock = gbpDocMock(account());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const saved = await memory.getCheckpoint(TEST_ORG, "google_business_profile", "historical");
    gbpReview.reset();
    const edited = { ...gbpReview.one(), updateTime: hours(100), comment: "Edited" };
    const fresh = gbpDocMock(account({ reviews: { "1001": [edited, ...gbpReview.many(2), gbpReview.one({ updateTime: hours(-22) })], "1002": [] }, metrics: {} }));
    const batches = await drain(connector(fresh).incrementalSync({ organizationId: TEST_ORG, cursor: saved }));
    const reviews = eventsOf(batches).filter((e) => e.type === "review.updated");
    // The edit, then reviews 3 and 2, changed within a day of the mark; review 4 is older than the mark less a day.
    expect(reviews.map((e) => e.payload.reviewId)).toEqual(["gbp:review:rev-1", "gbp:review:rev-3", "gbp:review:rev-2"]);
    expect(GBP_REVIEW_OVERLAP_MS).toBe(86_400_000);
    const end = JSON.parse(batches.at(-1)!.cursor) as GbpCursor;
    expect(end.marks).toEqual([
      ["1001", hours(100)],
      ["1002", hours(4)],
    ]);
    expect(fresh.reads.filter((r) => r.what === "metrics").map((r) => r.range)).toEqual(["2026-11-04..2026-11-10", "2026-11-04..2026-11-10"]);
    expect(end).toMatchObject({ done: true, through: "2026-11-10", pass: null });
    expect(GBP_REVISIT_DAYS).toBe(7);
  });

  it("reads reviews changed within a day of the mark again, as duplicates", async () => {
    gbpReview.reset();
    const reviews = [gbpReview.one({ updateTime: hours(10) }), gbpReview.one({ updateTime: hours(-15) })];
    const state: GbpCursor = { done: true, marks: [["1001", hours(10)]], through: "2026-11-10", pass: null };
    const mock = gbpDocMock(account({ locations: [{ name: "locations/1001" }], reviews: { "1001": reviews } }));
    const batches = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(state) }));
    expect(eventsOf(batches).filter((e) => e.type === "review.updated").map((e) => e.payload.editedAt)).toEqual([hours(10)]);
    const edge = gbpDocMock(account({ locations: [{ name: "locations/1001" }], reviews: { "1001": [gbpReview.one({ name: `accounts/${GBP_TEST_ACCOUNT}/locations/1001/reviews/e`, reviewId: "e", updateTime: hours(-14) })] } }));
    const out = await drain(connector(edge).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(state) }));
    expect(eventsOf(out).filter((e) => e.type === "review.updated").map((e) => e.payload.editedAt)).toEqual([hours(-14)]);
  });

  it("keeps a review that doesn't read, and a review dated by when it was written when it has no edit time", async () => {
    gbpReview.reset();
    const noEdit = { ...gbpReview.one({ createTime: hours(50) }), updateTime: undefined };
    const broken = { ...gbpReview.one(), starRating: "NONE" };
    const mock = gbpDocMock(account({ locations: [{ name: "locations/1001" }], reviews: { "1001": [noEdit, broken] } }));
    const batches = await drain(connector(mock, { historyYears: 1 }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(eventsOf([batches[1]!]).map((e) => e.idempotencyKey.split(":")[1])).toEqual(["review", "unreadable_review"]);
    expect((JSON.parse(batches[1]!.cursor) as GbpCursor).marks).toEqual([["1001", hours(50)]]);
  });

  it("looks back three days for reviews and ten for metrics on a first later sync, and leaves the import to do", async () => {
    gbpReview.reset();
    const reviews = [gbpReview.one({ updateTime: "2026-11-09T00:00:00.000Z" }), gbpReview.one({ updateTime: "2026-11-08T14:59:59.999Z" })];
    const mock = gbpDocMock(account({ locations: [{ name: "locations/1001" }], reviews: { "1001": reviews } }));
    const batches = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(eventsOf(batches).filter((e) => e.type === "review.updated")).toHaveLength(1);
    expect(mock.reads.filter((r) => r.what === "metrics").map((r) => r.range)).toEqual(["2026-11-01..2026-11-10"]);
    expect(JSON.parse(batches.at(-1)!.cursor)).toMatchObject({ done: false, through: "2026-11-10", pass: null });
    expect([GBP_FIRST_REVIEW_LOOKBACK_MS, GBP_FIRST_METRICS_DAYS]).toEqual([259_200_000, 10]);
  });

  it("reads no metrics twice in a day, and keeps where they got to", async () => {
    const state: GbpCursor = { done: true, marks: [], through: "2026-11-10", pass: null };
    const later = () => new Date("2026-11-11T23:00:00.000Z");
    const mock = gbpDocMock(account({ reviews: {} }));
    const batches = await drain(connector(mock, { now: later }).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(state) }));
    expect(mock.reads.filter((r) => r.what === "metrics").map((r) => r.range)).toEqual(["2026-11-04..2026-11-10", "2026-11-04..2026-11-10"]);
    expect(JSON.parse(batches.at(-1)!.cursor).through).toBe("2026-11-10");
    // A pass whose days are all ahead of it reads no metrics and keeps the last day read.
    const none: GbpCursor = { done: true, marks: [], through: "2026-11-08", pass: { stage: "metrics", locations: ["1001"], index: 0, floor: RECEIVED, from: "2026-11-12", to: "2026-11-10", window: "2026-11-12" } };
    const quiet = gbpDocMock(account());
    const end = await drain(connector(quiet).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(none) }));
    expect(quiet.reads).toHaveLength(0);
    expect(JSON.parse(end.at(-1)!.cursor)).toEqual({ done: true, marks: [], through: "2026-11-08", pass: null });
  });

  it("reads a window's last day on its own when the days don't divide into whole windows", async () => {
    const at = (from: string, to: string): GbpCursor => ({ done: true, marks: [], through: null, pass: { stage: "metrics", locations: ["1001"], index: 0, floor: RECEIVED, from, to, window: from } });
    const one = gbpDocMock(account());
    await drain(connector(one).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(at("2026-11-10", "2026-11-10")) }));
    expect(one.reads.map((r) => r.range)).toEqual(["2026-11-10..2026-11-10"]);
    const split = gbpDocMock(account());
    await drain(connector(split).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(at("2026-10-09", "2026-11-09")) }));
    expect(split.reads.map((r) => r.range)).toEqual(["2026-10-09..2026-11-08", "2026-11-09..2026-11-09"]);
  });

  it("reads each location once, and skips one whose name doesn't read", async () => {
    const mock = gbpDocMock(account({ locations: [{ name: "locations/1001" }, { name: "locations/1001", title: "Again" }, { title: "No name" }], reviews: {} }));
    const first = (await drain(connector(mock, { historyYears: 1 }).historicalImport({ organizationId: TEST_ORG, cursor: null })))[0]!;
    expect(first.events.map((e) => e.idempotencyKey.split(":")[1])).toEqual(["location", "location", "unreadable_location"]);
    expect((JSON.parse(first.cursor) as GbpCursor).pass!.locations).toEqual(["1001"]);
  });

  it("resumes from a checkpoint in the middle of a location's metrics", async () => {
    const mock = gbpDocMock(account());
    const all = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const middle = all[4]!.cursor;
    expect((JSON.parse(middle) as GbpCursor).pass).toMatchObject({ stage: "metrics", index: 0, window: "2025-01-12" });
    const resumed = gbpDocMock(account());
    const rest = await drain(connector(resumed).historicalImport({ organizationId: TEST_ORG, cursor: middle }));
    expect(resumed.reads[0]).toEqual({ what: "metrics", location: "1001", page: null, range: "2025-01-12..2025-02-11" });
    expect(rest).toHaveLength(all.length - 5);
  });

  it("stops on a location the account doesn't manage, keeping the checkpoint", async () => {
    const mock = gbpDocMock(account({ forbidden: ["1002"] }));
    const { memory, pipeline } = testPipeline();
    await expect(runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: noSleep })).rejects.toThrow(GbpConfigError);
    const saved = JSON.parse((await memory.getCheckpoint(TEST_ORG, "google_business_profile", "historical"))!) as GbpCursor;
    expect(saved.pass).toMatchObject({ stage: "reviews", index: 1 });
  });

  it("checks its history, uses the real clock by default, and declares its write, refused", async () => {
    const mock = gbpDocMock(account());
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears }), String(historyYears)).toThrow("historyYears must be a positive whole number");
    const ranges: string[] = [];
    const fake: GbpClient = {
      accountId: GBP_TEST_ACCOUNT,
      locations: async () => ({ locations: [{ name: "locations/1" }], nextPageToken: "" }),
      reviews: async () => ({ reviews: 5 }),
      metrics: async (_l, from, to) => (ranges.push(`${from}..${to}`), { multiDailyMetricTimeSeries: [] }),
    };
    await drain(gbpConnector({ ...base(), client: fake, historyYears: 1 }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const today = new Date().toISOString().slice(0, 10);
    const yearBack = new Date();
    yearBack.setUTCFullYear(yearBack.getUTCFullYear() - 1);
    expect(ranges[0]!.slice(0, 10)).toBe(yearBack.toISOString().slice(0, 10));
    expect(ranges.at(-1)!.slice(12)).toBe(new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10));
    const c = connector(mock);
    expect(c.source).toBe("google_business_profile");
    expect(c.writes).toBe(GBP_WRITES);
    expect(GBP_WRITES).toEqual([{ integration: "google_business_profile", name: "reply_to_review", description: "Reply to a Google review", kind: "append", approval: "each", dailyCap: 20 }]);
    expect(await assertWritesRefused(c)).toMatchObject([{ action: "reply_to_review", integration: "google_business_profile", outcome: "refused" }]);
  });

  it("refuses a checkpoint that isn't its own", () => {
    const pass = { stage: "metrics", locations: ["1001", "1002"], index: 2, floor: RECEIVED, from: "2026-01-01", to: "2026-01-31", window: "2026-01-01" };
    const good = { done: false, marks: [["1001", RECEIVED]], through: null, pass };
    expect(parseGbpCursor(null)).toBeNull();
    expect(parseGbpCursor(JSON.stringify(good))).toEqual(good);
    expect(parseGbpCursor(JSON.stringify({ ...good, through: "2026-01-31", pass: null }))).toEqual({ ...good, through: "2026-01-31", pass: null });
    for (const stage of ["locations", "reviews"]) expect(parseGbpCursor(JSON.stringify({ ...good, pass: { ...pass, stage, index: 1 } }))!.pass!.stage).toBe(stage);
    const bad: unknown[] = [
      "{",
      "null",
      { ...good, done: 1 },
      { ...good, marks: null },
      { ...good, marks: [["1001"]] },
      { ...good, marks: [[1001, RECEIVED]] },
      { ...good, marks: [["x", RECEIVED]] },
      { ...good, marks: [["1001", "2026-01-01"]] },
      { ...good, marks: [["1001", RECEIVED, 1]] },
      { ...good, marks: [5] },
      { ...good, through: "2026-02-30" },
      { ...good, through: undefined },
      { ...good, pass: undefined },
      { ...good, pass: { ...pass, stage: "done" } },
      { ...good, pass: { ...pass, locations: "1001" } },
      { ...good, pass: { ...pass, locations: ["x"] } },
      { ...good, pass: { ...pass, locations: [1001, "1002"] } },
      { ...good, pass: { ...pass, index: 3 } },
      { ...good, pass: { ...pass, stage: "reviews", index: 2 } },
      { ...good, pass: { ...pass, index: -1 } },
      { ...good, pass: { ...pass, index: 0.5 } },
      { ...good, pass: { ...pass, floor: "2026-01-01" } },
      { ...good, pass: { ...pass, from: "x" } },
      { ...good, pass: { ...pass, to: "x" } },
      { ...good, pass: { ...pass, window: "x" } },
    ];
    for (const raw of bad) expect(() => parseGbpCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("Google Business Profile checkpoint is not in the expected shape");
  });
});

describe("Google Business Profile doc mock", () => {
  const signIn = async (mock: GbpMock) => {
    const r = await mock.fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "refresh_token", refresh_token: REFRESH }).toString() });
    return ((await r.json()) as { access_token: string }).access_token;
  };
  const get = (mock: GbpMock, url: string, auth = "Bearer AT-GBP-1") => mock.fetch(url, { headers: { authorization: auth } });

  it("checks the refresh's client, grant and token, and hands out the scopes it was given", async () => {
    const mock = gbpDocMock(account({ scopes: ["openid", GBP_MANAGE_SCOPE] }));
    const post = (form: Record<string, string>) => mock.fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams(form).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    const form = { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "refresh_token", refresh_token: REFRESH };
    expect((await post({ ...form, client_id: "x" })).status).toBe(401);
    expect((await post({ ...form, client_secret: "x" })).status).toBe(401);
    expect((await post({ ...form, grant_type: "password" })).status).toBe(400);
    expect((await post({ ...form, refresh_token: "x" })).status).toBe(400);
    expect(await (await post(form)).json()).toEqual({ access_token: "AT-GBP-1", expires_in: 3599, scope: `openid ${GBP_MANAGE_SCOPE}`, token_type: "Bearer" });
    expect(mock.refreshes).toBe(5);
  });

  it("wants its token, the account, a read mask, and page sizes Google allows", async () => {
    const mock = gbpDocMock(account({ pageCap: 1 }));
    await signIn(mock);
    const status = async (url: string, auth?: string) => (await get(mock, url, auth)).status;
    expect(await status(`${INFO}?readMask=name`, "Bearer other")).toBe(401);
    expect(await status(`https://mybusinessbusinessinformation.googleapis.com/v1/accounts/999/locations?readMask=name`)).toBe(403);
    for (const q of ["", "?readMask=", "?readMask=name&pageSize=0", "?readMask=name&pageSize=101", "?readMask=name&pageSize=x", "?readMask=name&foo=1", "?readMask=name&pageToken=bad"]) expect(await status(`${INFO}${q}`), q).toBe(400);
    expect(await status(`${INFO}?readMask=name&pageSize=100&filter=x&orderBy=title`)).toBe(200);
    const page = (await (await get(mock, `${INFO}?readMask=name,title`)).json()) as { locations: unknown[]; nextPageToken?: string };
    expect(page).toEqual({ locations: [{ name: "locations/1001", title: "Test Jewelers 1" }], nextPageToken: "off-1" });
    const last = (await (await get(mock, `${INFO}?readMask=name&pageToken=off-1`)).json()) as typeof page;
    expect(last).toEqual({ locations: [{ name: "locations/1002" }] });
    mock.revokeTokens();
    expect(await status(`${INFO}?readMask=name`)).toBe(401);
  });

  it("pages reviews newest change first, or by rating, within Google's limits", async () => {
    const mock = gbpDocMock(account({ pageCap: 2, forbidden: ["1002"] }));
    await signIn(mock);
    const status = async (url: string) => (await get(mock, url)).status;
    expect(await status(`https://mybusiness.googleapis.com/v4/accounts/999/locations/1001/reviews`)).toBe(403);
    expect(await status(REVIEWS("1002"))).toBe(403);
    for (const q of ["?pageSize=51", "?pageSize=0", "?orderBy=createTime", "?x=1", "?pageToken=bad"]) expect(await status(`${REVIEWS("1001")}${q}`), q).toBe(400);
    const body = (await (await get(mock, REVIEWS("1001"))).json()) as { reviews: { reviewId: string }[]; totalReviewCount: number; averageRating: number; nextPageToken?: string };
    expect(body.reviews.map((r) => r.reviewId)).toEqual(["rev-3", "rev-2"]);
    expect(body).toMatchObject({ totalReviewCount: 3, averageRating: 2, nextPageToken: "off-2" });
    const byRating = (await (await get(mock, `${REVIEWS("1001")}?orderBy=rating`)).json()) as typeof body;
    expect(byRating.reviews.map((r) => r.reviewId)).toEqual(["rev-1", "rev-2"]);
    const empty = (await (await get(mock, REVIEWS("1003"))).json()) as typeof body;
    expect(empty).toEqual({ reviews: [], totalReviewCount: 0 });
  });

  it("answers daily metrics for the days and names asked, leaving zeros out", async () => {
    const mock = gbpDocMock(account());
    await signIn(mock);
    const range = "dailyRange.start_date.year=2026&dailyRange.start_date.month=11&dailyRange.start_date.day=9&dailyRange.end_date.year=2026&dailyRange.end_date.month=11&dailyRange.end_date.day=10";
    const body = (await (await get(mock, `${PERF("1001")}?dailyMetrics=CALL_CLICKS&${range}`)).json()) as { multiDailyMetricTimeSeries: { dailyMetricTimeSeries: unknown[] }[] };
    expect(body.multiDailyMetricTimeSeries[0]!.dailyMetricTimeSeries).toEqual([
      {
        dailyMetric: "CALL_CLICKS",
        timeSeries: {
          datedValues: [
            { date: { year: 2026, month: 11, day: 9 } },
            { date: { year: 2026, month: 11, day: 10 }, value: "3" },
          ],
        },
      },
    ]);
    const status = async (url: string) => (await get(mock, url)).status;
    for (const q of [`dailyMetrics=NOPE&${range}`, range, "dailyMetrics=CALL_CLICKS", `dailyMetrics=CALL_CLICKS&${range.replace("day=9", "day=x")}`, `dailyMetrics=CALL_CLICKS&${range.replace("month=11&dailyRange.start_date.day=9", "month=2&dailyRange.start_date.day=30")}`, `dailyMetrics=CALL_CLICKS&${range.replace("end_date.day=10", "end_date.day=8")}`, `dailyMetrics=CALL_CLICKS&${range}&x=1`]) {
      expect(await status(`${PERF("1001")}?${q}`), q).toBe(400);
    }
    expect(await status(`https://businessprofileperformance.googleapis.com/v1/locations/1001:getDailyMetricsTimeSeries?${range}`)).toBe(404);
    expect(await status(`${PERF("1002")}?dailyMetrics=CALL_CLICKS&${range}`)).toBe(200);
    const forbidden = gbpDocMock(account({ forbidden: ["1002"] }));
    await signIn(forbidden);
    expect((await get(forbidden, `${PERF("1002")}?dailyMetrics=CALL_CLICKS&${range}`)).status).toBe(403);
    expect(mock.reads.at(-1)).toEqual({ what: "metrics", location: "1002", page: null, range: "2026-11-09..2026-11-10" });
  });

  it("answers 429 with Retry-After, refuses a look-alike host and a request the docs don't list, and keeps its calls", async () => {
    const mock = gbpDocMock(account({ rateLimits: 1 }));
    await signIn(mock);
    const limited = await get(mock, `${INFO}?readMask=name`);
    expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "1"]);
    await expect(mock.fetch("https://mybusiness.googleapis.com.example.test/v4/x", {})).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${REVIEWS("1001")}/rev-1/reply`, { method: "PUT", body: "{}" })).rejects.toThrow(UndocumentedRequestError);
    expect(mock.fetch.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
  });

  it("is built from Google's docs pages", () => {
    const { information, reviewsApi, performance } = gbpDocMock(account());
    expect([information, reviewsApi, performance].map((m) => m.routes.map((r) => r.documentedAt))).toEqual([[GBP_DOC_PAGES.locations], [GBP_DOC_PAGES.reviews], [GBP_DOC_PAGES.metrics]]);
  });
});
