import { describe, expect, it } from "vitest";
import { runSync, writePolicy, InMemoryWriteAuditLog, WriteGate, type SourceBatch } from "@karatos/core";
import { TIKTOK_MOCK_READ_SCOPES, TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, testPipeline, tiktokDocMock, tiktokVideo, type TikTokMock, type TikTokMockData } from "@karatos/connector-testkit";
import {
  TIKTOK_EVENTS,
  TIKTOK_HISTORY_DAYS,
  TIKTOK_PAGE_SIZE,
  TIKTOK_READ_SCOPES,
  TIKTOK_REVISIT_DAYS,
  TIKTOK_USER_FIELDS,
  TIKTOK_VIDEO_FIELDS,
  TIKTOK_WRITES,
  TikTokApiError,
  TikTokConfigError,
  TikTokShapeError,
  memoryTokenStore,
  parseTikTokCursor,
  tiktokAccountEvent,
  tiktokClient,
  tiktokConnector,
  tiktokCount,
  tiktokLabel,
  tiktokLink,
  tiktokScopeProblem,
  tiktokTime,
  tiktokVideoEvent,
  tiktokVideoListBody,
  tiktokVideoPage,
  type TikTokBrainEvent,
  type TikTokClientOptions,
  type TikTokConnectorOptions,
  type TikTokCursor,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_KEY = `aw${"k".repeat(14)}`;
const CLIENT_SECRET = "s".repeat(32);
const REFRESH = `rft.${"r".repeat(60)}`;
const TODAY = "2026-11-01";
const NOW = () => new Date(`${TODAY}T14:00:00.000Z`);
const RECEIVED = `${TODAY}T14:00:00.000Z`;
const CTX = { receivedAt: RECEIVED };
const API = "https://open.tiktokapis.com/v2";
const DAY_S = 86_400;
const TODAY_S = Date.parse(`${TODAY}T12:00:00Z`) / 1000;
const noSleep = async () => {};
const SCOPES = TIKTOK_MOCK_READ_SCOPES.join(",");

/**
 * The store's account: six videos posted 0, 20, 40, 60, 80 and 100 days
 * ago, and one posted 800 days ago, past the two years the import reads.
 */
function account(overrides: Partial<TikTokMockData> = {}): TikTokMockData {
  tiktokVideo.reset();
  const videos = [0, 20, 40, 60, 80, 100, 800].map((ago) => tiktokVideo.one({ create_time: TODAY_S - ago * DAY_S }));
  const user = { open_id: "test-open-id", union_id: "test-union-id", display_name: "Test Store", bio_description: "Test bio", username: "test_store", follower_count: 1200, following_count: 30, likes_count: 45_000, video_count: 7 };
  return { clientKey: CLIENT_KEY, clientSecret: CLIENT_SECRET, refreshToken: REFRESH, user, videos, ...overrides };
}

const base = (fetch?: typeof globalThis.fetch, refresh = REFRESH): TikTokClientOptions => ({ clientKey: CLIENT_KEY, clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(refresh), sleep: noSleep, ...(fetch ? { fetch } : {}) });

/** Each mock account's refresh token store, shared by every connector built for it, as the instance's database is. */
const stores = new WeakMap<TikTokMock, ReturnType<typeof memoryTokenStore>>();

function connector(mock: TikTokMock, overrides: Partial<TikTokConnectorOptions> = {}) {
  if (!stores.has(mock)) stores.set(mock, memoryTokenStore(REFRESH));
  return tiktokConnector({ ...base(mock.fetch), tokens: stores.get(mock)!, now: NOW, ...overrides });
}

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const ok = (data: unknown) => ({ data, error: { code: "ok", message: "", log_id: "x" } });
/** A fetch that refreshes with the given scope, then answers every API call with `api`. */
const fake = (api: () => Response, scope = SCOPES) =>
  (async (input: string | URL | Request) => (String(input).includes("/oauth/") ? new Response(JSON.stringify({ access_token: "AT", expires_in: 86_400, scope }), { status: 200 }) : api())) as typeof fetch;
const endpoints = (mock: TikTokMock) => mock.fetch.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`);
const agoDays = (ms: number) => Math.round((Date.parse(`${TODAY}T12:00:00Z`) - ms) / 86_400_000);

describe("TikTok normalizer", () => {
  it("reads counts, titles, times and links, turning down anything else", () => {
    expect([0, 12, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 2].map(tiktokCount)).toEqual([0, 12, undefined, undefined, undefined, undefined]);
    expect(tiktokLabel(`  ${"x".repeat(120)} `)).toBe("x".repeat(100));
    expect([" ", "Shop with @test_store", 5].map((v) => tiktokLabel(v))).toEqual([undefined, undefined, undefined]);
    expect(tiktokTime(1_767_268_800)).toBe("2026-01-01T12:00:00.000Z");
    expect([0, -1, 1.5, "1767268800", 9e15, undefined].map(tiktokTime)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(tiktokLink("https://www.tiktok.com/@test_store/video/7?is_from_webapp=1#x")).toBe("https://www.tiktok.com/@test_store/video/7");
    expect(tiktokLink("https://tiktok.com/v/7")).toBe("https://tiktok.com/v/7");
    expect(tiktokLink(`https://www.tiktok.com/${"p".repeat(400)}`)).toHaveLength(300);
    const bad = ["http://www.tiktok.com/v/7", "https://tiktok.com.example.test/v", "https://nottiktok.com/v", "javascript:alert(1)", "not a url", `https://www.tiktok.com/${"p".repeat(2048)}`, null];
    expect(bad.map(tiktokLink)).toEqual(bad.map(() => undefined));
  });

  it("reads a page of videos and its cursor, and throws on a page that isn't one", () => {
    expect(tiktokVideoPage(ok({ videos: [{ id: "1" }, "x"], cursor: 1_700_000_000_000, has_more: true }))).toEqual({ videos: [{ id: "1" }, {}], cursor: 1_700_000_000_000 });
    expect(tiktokVideoPage(ok({ videos: [], cursor: 0, has_more: false })).cursor).toBeUndefined();
    expect(tiktokVideoPage(ok({ videos: [], cursor: 5, has_more: "yes" })).cursor).toBeUndefined();
    const bad = [null, [], {}, ok({}), ok({ videos: {} }), ok({ videos: [], has_more: true }), ok({ videos: [], has_more: true, cursor: 0 }), ok({ videos: [], has_more: true, cursor: 1.5 }), ok({ videos: [], has_more: true, cursor: "5" })];
    for (const b of bad) expect(() => tiktokVideoPage(b), JSON.stringify(b)).toThrow(TikTokShapeError);
  });

  it("turns a video into social.video_updated with its title, link, length and counts, and no description", () => {
    tiktokVideo.reset();
    const e = tiktokVideoEvent(tiktokVideo.one(), CTX)!;
    expect(e).toMatchObject({ type: TIKTOK_EVENTS.video, occurredAt: "2026-01-02T12:00:00.000Z", receivedAt: RECEIVED });
    expect(e.payload).toEqual({
      videoId: "tiktok:video:700000000001",
      postedAt: "2026-01-02T12:00:00.000Z",
      title: "Test oval halo ring 1",
      link: "https://www.tiktok.com/@test_store/video/700000000001",
      durationSeconds: 16,
      views: 1000,
      likes: 40,
      comments: 3,
      shares: 2,
    });
    const text = JSON.stringify(e);
    for (const leak of ["Test description", "is_from_webapp", "tiktokcdn", "player"]) expect(text, leak).not.toContain(leak);
    expect(e.idempotencyKey).toMatch(/^tiktok:video:700000000001:[0-9a-f]{16}$/);
    expect(e.id).toMatch(/^tiktok_video:700000000001:[0-9a-f]{16}$/);
  });

  it("keys a video by its counts, so moved counts are a new version and unchanged ones the same", () => {
    tiktokVideo.reset();
    const video = tiktokVideo.one();
    const a = tiktokVideoEvent(video, CTX)!;
    expect(tiktokVideoEvent({ ...video }, { receivedAt: "2026-11-02T00:00:00.000Z" })!.idempotencyKey).toBe(a.idempotencyKey);
    expect(tiktokVideoEvent({ ...video, view_count: 1001 }, CTX)!.idempotencyKey).not.toBe(a.idempotencyKey);
  });

  it("skips a video without an id and leaves out what it can't trust", () => {
    for (const id of ["abc", "1".repeat(26), 7, undefined]) expect(tiktokVideoEvent({ id }, CTX), String(id)).toBeNull();
    expect(tiktokVideoEvent(null as never, CTX)).toBeNull();
    const e = tiktokVideoEvent({ id: "7", create_time: "soon", title: "a@b", share_url: "https://evil.example.test/v", duration: -1, view_count: 1.5, like_count: "3" }, CTX)!;
    expect(e.occurredAt).toBeUndefined();
    expect(e.payload).toEqual({ videoId: "tiktok:video:7" });
  });

  it("turns the profile into social.account_reported for the day, and throws without a user", () => {
    const e = tiktokAccountEvent(ok({ user: { open_id: "o", display_name: "Test Store", follower_count: 1200, following_count: 30, likes_count: 45_000, video_count: 7 } }), "2026-11-01", CTX);
    expect(e).toMatchObject({ type: TIKTOK_EVENTS.account, occurredAt: "2026-11-01T00:00:00.000Z", payload: { day: "2026-11-01", name: "Test Store", followers: 1200, following: 30, likes: 45_000, videos: 7 } });
    expect(Object.keys(e.payload)).not.toContain("open_id");
    expect(e.idempotencyKey).toMatch(/^tiktok:account:2026-11-01:[0-9a-f]{16}$/);
    expect(tiktokAccountEvent(ok({ user: { display_name: "@me", follower_count: -1 } }), "2026-11-01", CTX).payload).toEqual({ day: "2026-11-01" });
    for (const bad of [null, {}, ok({}), ok({ user: [] }), ok({ user: "x" }), ok(null)]) expect(() => tiktokAccountEvent(bad, "2026-11-01", CTX), JSON.stringify(bad)).toThrow(TikTokShapeError);
  });

  it("builds fixtures that look synthetic", () => {
    assertSynthetic(account());
  });
});

describe("TikTok client", () => {
  it("builds a video list body only from TikTok's own cursor", () => {
    expect(tiktokVideoListBody(null)).toEqual({ max_count: 20 });
    expect(tiktokVideoListBody(1_700_000_000_000)).toEqual({ max_count: 20, cursor: 1_700_000_000_000 });
    for (const bad of [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 2, "5", Number.NaN]) expect(() => tiktokVideoListBody(bad as never), String(bad)).toThrow(TikTokConfigError);
    expect(TIKTOK_PAGE_SIZE).toBe(20);
    expect(TIKTOK_VIDEO_FIELDS).not.toContain("video_description");
    expect(TIKTOK_USER_FIELDS).toEqual(["open_id", "display_name", "follower_count", "following_count", "likes_count", "video_count"]);
  });

  it("accepts the three read scopes and nothing more or less", () => {
    expect(tiktokScopeProblem("user.info.basic,user.info.stats,video.list")).toBeNull();
    expect(tiktokScopeProblem("video.list user.info.stats, user.info.basic")).toBeNull();
    expect(tiktokScopeProblem("user.info.basic,user.info.stats,video.list,video.publish")).toBe("the TikTok connection holds more than read access (video.publish)");
    expect(tiktokScopeProblem("user.info.basic,user.info.stats,video.list,user.info.profile")).toBe("the TikTok connection holds more than read access (user.info.profile)");
    expect(tiktokScopeProblem("user.info.basic,video.list")).toBe("the TikTok connection doesn't hold user.info.stats");
    expect(tiktokScopeProblem(`${"x".repeat(2048)},video.list`)).toMatch(/^the TikTok connection holds more than read access \(x{200}\)$/);
    for (const none of [undefined, "", "  ", 5]) expect(tiktokScopeProblem(none)).toBe("TikTok didn't say which scopes the token holds");
    expect(TIKTOK_READ_SCOPES).toEqual(["user.info.basic", "user.info.stats", "video.list"]);
  });

  it("won't build without the app's client key and secret", () => {
    expect(() => tiktokClient({ ...base(), clientKey: "" })).toThrow("set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET");
    expect(() => tiktokClient({ ...base(), clientSecret: "has space" })).toThrow("set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET");
    expect(() => tiktokClient({ ...base(), clientSecret: "x".repeat(513) })).toThrow("set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET");
    expect(() => tiktokClient({ ...base(), clientKey: ` ${CLIENT_KEY} ` })).not.toThrow();
  });

  it("refreshes once with the app's keys in the form, saves the new refresh token, and keeps the access token out of URLs", async () => {
    const mock = tiktokDocMock(account());
    const tokens = memoryTokenStore(REFRESH);
    const client = tiktokClient({ ...base(mock.fetch), tokens });
    expect(((await client.userInfo()).data as { user: object }).user).toEqual({ open_id: "test-open-id", display_name: "Test Store", follower_count: 1200, following_count: 30, likes_count: 45_000, video_count: 7 });
    await client.videos(null);
    expect(mock.refreshes).toBe(1);
    expect(tokens.current).toBe("rft.TEST1");
    expect(endpoints(mock)).toEqual([`POST ${API}/oauth/token/`, `GET ${API}/user/info/`, `POST ${API}/video/list/`]);
    expect(mock.fetch.calls.every((c) => !c.url.includes("act.") && !c.url.includes(REFRESH) && !c.url.includes(CLIENT_SECRET))).toBe(true);
    expect(mock.listed).toEqual([{ max_count: 20 }]);
  });

  it("keeps the refresh token when TikTok answers the same one", async () => {
    let saved = 0;
    const tokens = { load: async () => REFRESH, save: async () => void saved++ };
    const same = (async (input: string | URL | Request) =>
      String(input).includes("/oauth/") ? new Response(JSON.stringify({ access_token: "AT", refresh_token: REFRESH, scope: SCOPES }), { status: 200 }) : new Response(JSON.stringify(ok({ user: {} })), { status: 200 })) as typeof fetch;
    await tiktokClient({ ...base(same), tokens }).userInfo();
    expect(saved).toBe(0);
    const mock = tiktokDocMock(account({ rotate: false }));
    const kept = memoryTokenStore(REFRESH);
    await tiktokClient({ ...base(mock.fetch), tokens: kept }).userInfo();
    expect(kept.current).toBe(REFRESH);
  });

  it("renews the access token once on a 401 with the saved refresh token, and gives up on a second", async () => {
    const mock = tiktokDocMock(account());
    const tokens = memoryTokenStore(REFRESH);
    const client = tiktokClient({ ...base(mock.fetch), tokens });
    await client.userInfo();
    mock.revokeAccessTokens();
    await client.videos(null);
    expect(mock.refreshes).toBe(2);
    expect(tokens.current).toBe("rft.TEST2");
    let calls = 0;
    const always401 = fake(() => (calls++, new Response(JSON.stringify({ error: { code: "access_token_invalid", message: "The access token is invalid." } }), { status: 401 })));
    const error = await tiktokClient(base(always401)).userInfo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TikTokApiError);
    expect(error).toMatchObject({ status: 401, code: "access_token_invalid", message: "TikTok answered HTTP 401: The access token is invalid.; connect the TikTok account again" });
    expect(calls).toBe(2);
  });

  it("doesn't renew on a scope TikTok says the user never allowed, and says how to fix it", async () => {
    const mock = tiktokDocMock(account());
    const client = tiktokClient(base(mock.fetch));
    await client.userInfo();
    let calls = 0;
    const scoped = fake(() => (calls++, new Response(JSON.stringify({ error: { code: "scope_not_authorized", message: "Not authorized." } }), { status: 401 })));
    expect(await tiktokClient(base(scoped)).videos(null).catch((e: unknown) => e)).toMatchObject({ code: "scope_not_authorized", message: "TikTok answered HTTP 401: Not authorized.; connect the TikTok account again and allow every permission the app asks for" });
    expect(calls).toBe(1);
    const missed = fake(() => new Response(JSON.stringify({ error: { code: "scope_permission_missed", message: "" } }), { status: 400 }));
    expect(await tiktokClient(base(missed)).userInfo().catch((e: unknown) => e)).toMatchObject({ status: 400, message: "TikTok answered HTTP 400: scope_permission_missed; connect the TikTok account again and allow every permission the app asks for" });
  });

  it("stops when the token holds more than the read scopes, before reading anything, keeping the new refresh token", async () => {
    const mock = tiktokDocMock(account({ scopes: [...TIKTOK_MOCK_READ_SCOPES, "video.publish"] }));
    const tokens = memoryTokenStore(REFRESH);
    await expect(tiktokClient({ ...base(mock.fetch), tokens }).userInfo()).rejects.toThrow("the TikTok connection holds more than read access (video.publish); connect it again with only user.info.basic, user.info.stats, video.list");
    expect(endpoints(mock)).toEqual([`POST ${API}/oauth/token/`]);
    expect(tokens.current).toBe("rft.TEST1");
  });

  it("explains a replaced refresh token, wrong app keys, a missing token and a failed refresh", async () => {
    const reason = (data: Partial<TikTokMockData>, refresh = REFRESH) => tiktokClient(base(tiktokDocMock(account(data)).fetch, refresh)).userInfo().catch((e: unknown) => e as TikTokApiError);
    expect(await reason({}, `${REFRESH}x`)).toMatchObject({ status: 400, code: "invalid_grant", message: "TikTok turned down the token refresh (HTTP 400: Refresh token is invalid or expired.); the refresh token expired or was revoked, so connect the TikTok account again" });
    expect(await reason({ clientSecret: "t".repeat(32) })).toMatchObject({ status: 401, code: "invalid_client", message: "TikTok turned down the token refresh (HTTP 401: Client key or secret is incorrect.); check TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET" });
    expect(await reason({}, " ")).toMatchObject({ message: "set TIKTOK_REFRESH_TOKEN" });
    const odd = (body: unknown, status = 200) => tiktokClient(base((async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch)).userInfo().catch((e: unknown) => e as TikTokApiError);
    expect(await odd({ error: "server_error", error_description: "m".repeat(300) }, 503)).toMatchObject({ code: "server_error", message: `TikTok turned down the token refresh (HTTP 503: ${"m".repeat(200)})` });
    expect(await odd({ error: "invalid_request" }, 400)).toMatchObject({ message: "TikTok turned down the token refresh (HTTP 400: invalid_request)" });
    expect(await odd({ access_token: "" })).toMatchObject({ code: undefined, message: "TikTok turned down the token refresh (HTTP 200)" });
    expect(await odd({ error: "Not A Code" }, 500)).toMatchObject({ code: undefined, message: "TikTok turned down the token refresh (HTTP 500)" });
    expect(await odd("<html>", 502)).toMatchObject({ message: "TikTok turned down the token refresh (HTTP 502)" });
    expect(await odd({ access_token: "AT", scope: SCOPES, refresh_token: "" }).then((e) => (e instanceof Error ? e.message : "read"))).not.toContain("token refresh");
  });

  it("uses the access token for its lifetime, less two minutes, then refreshes", async () => {
    let now = 0;
    let refreshes = 0;
    let lifetime: unknown = 600;
    const counting = (async (input: string | URL | Request) => {
      if (String(input).includes("/oauth/")) return (refreshes++, new Response(JSON.stringify({ access_token: `AT${refreshes}`, expires_in: lifetime, scope: SCOPES }), { status: 200 }));
      return new Response(JSON.stringify(ok({ user: {} })), { status: 200 });
    }) as typeof fetch;
    const client = tiktokClient({ ...base(counting), clock: () => now });
    await client.userInfo();
    now = 479_000;
    await client.userInfo();
    expect(refreshes).toBe(1);
    now = 480_000;
    lifetime = "soon";
    await client.userInfo();
    expect(refreshes).toBe(2);
    // Without a usable lifetime, an hour, less two minutes.
    now += 3_479_000;
    await client.userInfo();
    expect(refreshes).toBe(2);
    now += 1000;
    lifetime = -5;
    await client.userInfo();
    expect(refreshes).toBe(3);
    await client.userInfo();
    expect(refreshes).toBe(3);
  });

  it("refreshes once for reads sent together", async () => {
    const mock = tiktokDocMock(account());
    const client = tiktokClient(base(mock.fetch));
    await Promise.all([client.userInfo(), client.videos(null)]);
    expect(mock.refreshes).toBe(1);
  });

  it("waits out a 429 a few times, honoring Retry-After up to a cap, then gives up with a clear error", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const mock = tiktokDocMock(account({ rateLimited: 2 }));
    expect(((await tiktokClient({ ...base(mock.fetch), sleep }).videos(null)).data as { videos: unknown[] }).videos).toHaveLength(7);
    expect(waits).toEqual([1000, 2000]);
    waits.length = 0;
    const after = ["5", "500", "0", "soon"];
    let i = 0;
    const limited = fake(() => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } }), { status: 429, headers: { "retry-after": after[i++] ?? "1" } }));
    const error = await tiktokClient({ ...base(limited), sleep, rateLimitRetries: 4 }).userInfo().catch((e: unknown) => e);
    expect(waits).toEqual([5000, 64_000, 4000, 8000]);
    expect(error).toMatchObject({ status: 429, code: "rate_limit_exceeded", message: "TikTok kept rate-limiting the sync; the next sync resumes from the checkpoint" });
    waits.length = 0;
    let n = 0;
    const doubling = fake(() => (n++, new Response("{}", { status: 429 })));
    await tiktokClient({ ...base(doubling), sleep, rateLimitRetries: 8 }).userInfo().catch(() => {});
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 64_000]);
    expect(n).toBe(9);
    n = 0;
    await tiktokClient(base(doubling)).userInfo().catch(() => {});
    expect(n).toBe(4);
  });

  it("treats an error code in a 200 answer as an error, and turns down an answer that isn't a JSON object", async () => {
    const status = (code: number, body: unknown) => tiktokClient(base(fake(() => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: code })))).videos(null).catch((e: unknown) => e as TikTokApiError);
    expect(await status(200, { data: {}, error: { code: "internal_error", message: "m".repeat(300) } })).toMatchObject({ status: 200, code: "internal_error", message: `TikTok answered HTTP 200: ${"m".repeat(200)}` });
    expect(await status(500, "<html>")).toMatchObject({ code: undefined, message: "TikTok answered HTTP 500" });
    expect(await status(400, { error: { code: "Bad Code", message: 5 } })).toMatchObject({ code: undefined, message: "TikTok answered HTTP 400" });
    for (const body of ["<html>", "[]", "null", "5"]) expect(await status(200, body)).toMatchObject({ status: 200, message: "TikTok did not answer with JSON" });
    expect(await status(200, { data: { videos: [] } })).toEqual({ data: { videos: [] } });
  });

  it("checks a cursor before any request is sent", async () => {
    const mock = tiktokDocMock(account());
    await expect(tiktokClient(base(mock.fetch)).videos(-1)).rejects.toThrow(TikTokConfigError);
    expect(mock.fetch.calls).toEqual([]);
  });
});

describe("TikTok connector", () => {
  it("passes every runSync scenario: full import, replay, resume and retry", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(tiktokDocMock(account())), expected: { ingested: 1 + 6 } });
    expect(result.full.batches).toBe(2);
    expect(parseTikTokCursor(result.full.cursor)).toEqual({ pass: "historical", step: "done", cursor: null, today: TODAY, since: "2024-10-31" });
  });

  it("reads the account's counts, then every video posted in the last two years", async () => {
    const mock = tiktokDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(7);
    const videos = memory.events.filter((e) => e.type === TIKTOK_EVENTS.video);
    expect(videos.map((e) => agoDays(Date.parse(e.payload.postedAt as string)))).toEqual([0, 20, 40, 60, 80, 100]);
    expect(memory.events.filter((e) => e.type === TIKTOK_EVENTS.account).map((e) => e.payload)).toEqual([{ day: TODAY, name: "Test Store", followers: 1200, following: 30, likes: 45_000, videos: 7 }]);
    expect(memory.events.every((e) => e.source === "tiktok")).toBe(true);
    expect(TIKTOK_HISTORY_DAYS).toBe(731);
  });

  it("pages through the videos with TikTok's cursor, stopping at the page that reaches past the cutoff", async () => {
    const mock = tiktokDocMock(account({ pageCap: 2 }));
    const batches = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(mock.listed.map((b) => b.cursor === undefined)).toEqual([true, false, false, false]);
    expect(batches.map((b) => b.events.length)).toEqual([1, 2, 2, 2, 0]);
    expect(parseTikTokCursor(batches[1]!.cursor)).toMatchObject({ step: "videos", cursor: (TODAY_S - 20 * DAY_S) * 1000 });
    expect(parseTikTokCursor(batches.at(-1)!.cursor)).toMatchObject({ step: "done", cursor: null });
  });

  it("keeps a video TikTok gives no time for, and doesn't stop on it", async () => {
    const videos = [{ id: "1" }, { id: "2", create_time: TODAY_S }];
    const client = { userInfo: async () => ok({ user: {} }), videos: async (c: number | null) => ok(c === null ? { videos, cursor: 5, has_more: true } : { videos: [{ id: "3", create_time: TODAY_S - 900 * DAY_S }], cursor: 0, has_more: false }) };
    const batches = await drain(connector(tiktokDocMock(account()), { client }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(batches.map((b) => (b.events as TikTokBrainEvent[]).map((e) => e.payload.videoId))).toEqual([[undefined], ["tiktok:video:1", "tiktok:video:2"], []]);
  });

  it("re-reads the videos of the last 90 days on each sync, storing one whose counts moved as a new version", async () => {
    const data = account({ pageCap: 2 });
    const mock = tiktokDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    mock.listed.length = 0;
    // The newest video gains views and the account a follower; nothing else changes.
    data.videos[0] = { ...data.videos[0]!, view_count: 5000 };
    data.user.follower_count = 1201;
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.listed).toHaveLength(3);
    expect([report.ingested, report.duplicates]).toEqual([2, 4]);
    expect(TIKTOK_REVISIT_DAYS).toBe(90);
  });

  it("resumes an unfinished pass from its step and cursor, and keeps a finished import finished", async () => {
    const mock = tiktokDocMock(account({ pageCap: 2 }));
    const first = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(parseTikTokCursor(first[0]!.cursor)).toEqual({ pass: "incremental", step: "videos", cursor: null, today: TODAY, since: "2026-08-04" });
    const mid = parseTikTokCursor(first[1]!.cursor)!;
    mock.listed.length = 0;
    const rest = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(mid) }));
    expect(mock.listed[0]!.cursor).toBe(mid.cursor);
    expect(rest).toHaveLength(2);
    mock.listed.length = 0;
    const done: TikTokCursor = { pass: "historical", step: "done", cursor: null, today: "2026-10-01", since: "2024-09-30" };
    const calls = mock.fetch.calls.length;
    expect(await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) }))).toEqual([]);
    expect(mock.fetch.calls).toHaveLength(calls);
    // An interrupted import picks up at its step, with the cutoff it started with.
    const resumed = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...done, step: "videos", since: "2026-09-01" }) }));
    expect(resumed.flatMap((b) => b.events)).toHaveLength(4);
    mock.listed.length = 0;
    // An incremental sync after a finished pass starts a new one today, from the account.
    const again = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...done, pass: "incremental" }) }));
    expect((again[0]!.events[0] as TikTokBrainEvent).type).toBe(TIKTOK_EVENTS.account);
    expect(parseTikTokCursor(again.at(-1)!.cursor)).toMatchObject({ today: TODAY, since: "2026-08-04" });
  });

  it("dead-letters what the pipeline can't store and stores the rest", async () => {
    const client = { userInfo: async () => ok({ user: {} }), videos: async () => ok({ videos: [{ id: "1", create_time: TODAY_S }, { id: "nope" }], cursor: 0, has_more: false }) };
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(tiktokDocMock(account()), { client }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(2);
    expect(memory.events.map((e) => e.type).sort()).toEqual([TIKTOK_EVENTS.account, TIKTOK_EVENTS.video]);
  });

  it("turns down a checkpoint that isn't one of its own", () => {
    expect(parseTikTokCursor(null)).toBeNull();
    const ok: TikTokCursor = { pass: "historical", step: "videos", cursor: 1_700_000_000_000, today: TODAY, since: "2024-10-31" };
    expect(parseTikTokCursor(JSON.stringify(ok))).toEqual(ok);
    expect(parseTikTokCursor(JSON.stringify({ ...ok, step: "account", cursor: null }))!.step).toBe("account");
    expect(parseTikTokCursor(JSON.stringify({ ...ok, since: TODAY }))!.since).toBe(TODAY);
    const bad: unknown[] = [null, {}, { ...ok, pass: "full" }, { ...ok, step: "posts", cursor: null }, { ...ok, cursor: "5" }, { ...ok, cursor: 0 }, { ...ok, cursor: 1.5 }, { ...ok, cursor: undefined }, { ...ok, step: "account" }, { ...ok, step: "done" }, { ...ok, today: "2026-13-01" }, { ...ok, today: "2026-02-30" }, { ...ok, today: undefined }, { ...ok, since: "soon" }, { ...ok, since: "2026-02-30" }, { ...ok, since: "2026-11-02" }];
    for (const c of bad) expect(() => parseTikTokCursor(JSON.stringify(c)), JSON.stringify(c)).toThrow("not in the expected shape");
  });

  it("declares posting a video, needing approval, and a read-only gate turns it down", async () => {
    const c = connector(tiktokDocMock(account()));
    expect(c.source).toBe("tiktok");
    expect(c.writes).toBe(TIKTOK_WRITES);
    expect(TIKTOK_WRITES.map((w) => [w.name, w.kind, w.approval, w.dailyCap])).toEqual([["post_video", "append", "each", 5]]);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.integration, a.action, a.outcome])).toEqual([["tiktok", "post_video", "refused"]]);
  });

  it("lets a write through only where the instance turned it on, by name", async () => {
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: writePolicy(["tiktok:post_video"]), audit });
    const ran: string[] = [];
    for (const action of TIKTOK_WRITES) await gate.run(action, "test", async () => void ran.push(action.name));
    expect(ran).toEqual(["post_video"]);
    expect(audit.entries.map((a) => a.outcome)).toEqual(["performed"]);
  });

  it("never asks TikTok for anything but the profile and the video list, with the fixed fields", async () => {
    const mock = tiktokDocMock(account({ pageCap: 2 }));
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(new Set(endpoints(mock))).toEqual(new Set([`POST ${API}/oauth/token/`, `GET ${API}/user/info/`, `POST ${API}/video/list/`]));
    for (const c of mock.fetch.calls.filter((c) => !c.url.includes("/oauth/"))) {
      const q = new URL(c.url).searchParams;
      expect([...q.keys()]).toEqual(["fields"]);
      expect(q.get("fields")).toBe((c.url.includes("/user/") ? TIKTOK_USER_FIELDS : TIKTOK_VIDEO_FIELDS).join(","));
    }
    expect(mock.listed.every((b) => Object.keys(b).every((k) => k === "max_count" || k === "cursor"))).toBe(true);
  });
});

describe("the TikTok mock", () => {
  it("turns down unknown fields, fields past the token's scopes, a bad page size or cursor, and a form or JSON sent wrong", async () => {
    const mock = tiktokDocMock(account({ scopes: ["user.info.basic", "video.list"] }));
    await tiktokClient(base(mock.fetch, REFRESH)).userInfo().catch(() => {});
    // The refresh above was turned down by the scope check, but the mock issued act.TEST1.
    const auth = { authorization: "Bearer act.TEST1" };
    const info = (fields: string) => mock.fetch(`${API}/user/info/?fields=${fields}`, { headers: auth }).then(async (r) => [r.status, ((await r.json()) as { error: { code: string } }).error.code]);
    expect(await info("open_id")).toEqual([200, "ok"]);
    expect(await info("open_id,follower_count")).toEqual([400, "scope_permission_missed"]);
    expect(await info("password")).toEqual([400, "invalid_params"]);
    expect(await info("")).toEqual([400, "invalid_params"]);
    const list = (body: string, type = "application/json", fields = "id") => mock.fetch(`${API}/video/list/?fields=${fields}`, { method: "POST", headers: { ...auth, "content-type": type }, body }).then((r) => r.status);
    expect(await list('{"max_count":20}')).toBe(200);
    expect(await list("{}")).toBe(200);
    expect(await list('{"max_count":21}')).toBe(400);
    expect(await list('{"max_count":0}')).toBe(400);
    expect(await list('{"cursor":-1}')).toBe(400);
    expect(await list("{")).toBe(400);
    expect(await list("{}", "text/plain")).toBe(400);
    expect(await list("{}", "application/json", "id,password")).toBe(400);
    const form = await mock.fetch(`${API}/oauth/token/`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(form.status).toBe(400);
    const scoped = tiktokDocMock(account({ scopes: ["user.info.basic"] }));
    await tiktokClient(base(scoped.fetch)).userInfo().catch(() => {});
    expect(await scoped.fetch(`${API}/video/list/?fields=id`, { method: "POST", headers: { authorization: "Bearer act.TEST1", "content-type": "application/json" }, body: "{}" }).then((r) => r.status)).toBe(401);
  });
});
