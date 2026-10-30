import { describe, expect, it } from "vitest";
import { InMemoryWriteAuditLog, WriteGate, runSync, writePolicy, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, metaAdsDocMock, metaAdsRow, testPipeline, type MetaAdsMock, type MetaAdsMockData } from "@karatos/connector-testkit";
import {
  META_ADS_EVENTS,
  META_ADS_FIELDS,
  META_ADS_MAX_RANGE_DAYS,
  META_ADS_PAGE_SIZE,
  META_ADS_REVISIT_DAYS,
  META_ADS_WRITES,
  MetaAdsApiError,
  MetaAdsConfigError,
  MetaAdsShapeError,
  metaAdsAccountId,
  metaAdsAction,
  metaAdsCampaignEvent,
  metaAdsCents,
  metaAdsClient,
  metaAdsConnector,
  metaAdsCount,
  metaAdsDay,
  metaAdsDayMs,
  metaAdsInsightsParams,
  metaAdsLabel,
  metaAdsPage,
  metaAdsPageEvents,
  metaAdsPermissionProblem,
  parseMetaAdsCursor,
  type MetaAdsClientOptions,
  type MetaAdsConnectorOptions,
  type MetaAdsCursor,
} from "../src/index.js";

// A token-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = `EAA${"t".repeat(60)}`;
const ACCOUNT = "1234567890";
const NOW = () => new Date("2026-10-20T12:00:00Z");
const RECEIVED = "2026-10-20T12:00:00.000Z";
const CTX = { accountId: ACCOUNT, receivedAt: RECEIVED };
const GRAPH = "https://graph.facebook.com/v26.0";
const INSIGHTS = `${GRAPH}/act_${ACCOUNT}/insights`;
const noSleep = async () => {};
const Q = { since: "2026-10-01", until: "2026-10-02", after: null };

function account(overrides: Partial<MetaAdsMockData> = {}): MetaAdsMockData {
  metaAdsRow.reset();
  // Two campaigns on 2026-10-01, 2026-10-02 and 2026-10-03, and one row on the first day of the two years.
  const rows = [...metaAdsRow.many(6), metaAdsRow.one({ date: "2024-10-20" })];
  return { accountId: ACCOUNT, accessToken: TOKEN, rows, ...overrides };
}

const base = (fetch?: typeof globalThis.fetch): MetaAdsClientOptions => ({ accessToken: TOKEN, accountId: ACCOUNT, sleep: noSleep, ...(fetch ? { fetch } : {}) });

function connector(mock: MetaAdsMock, overrides: Partial<MetaAdsConnectorOptions> = {}) {
  return metaAdsConnector({ ...base(mock.fetch), now: NOW, ...overrides });
}

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const ranges = (mock: MetaAdsMock) =>
  mock.reads.map((q) => {
    const r = JSON.parse(q.get("time_range")!) as { since: string; until: string };
    return `${r.since}..${r.until}`;
  });
const GRANTED = { data: [{ permission: "ads_read", status: "granted" }] };
/** A fetch that answers the permissions read with `perms`, then every insights read with `api`. */
const fake = (api: () => Response, perms: unknown = GRANTED) =>
  (async (input: string | URL | Request) => (String(input).includes("/me/permissions") ? new Response(JSON.stringify(perms), { status: 200 }) : api())) as typeof fetch;

const row = (overrides: Record<string, unknown> = {}) => ({
  campaign_id: "120200000000000001",
  campaign_name: "Test bridal reels",
  objective: "OUTCOME_SALES",
  account_currency: "USD",
  spend: "123.45",
  impressions: "1000",
  reach: "800",
  clicks: "20",
  actions: [
    { action_type: "link_click", value: "20" },
    { action_type: "purchase", value: "2" },
  ],
  action_values: [{ action_type: "purchase", value: "1890.50" }],
  date_start: "2026-10-01",
  date_stop: "2026-10-01",
  ...overrides,
});

describe("Meta Ads normalizer", () => {
  it("reads days, counts and money, turning down anything else", () => {
    expect(metaAdsDay("2026-10-01")).toBe("2026-10-01");
    for (const bad of ["2023-02-29", "20261001", "", undefined]) expect(metaAdsDay(bad)).toBeUndefined();
    expect(metaAdsCount("0")).toBe(0);
    expect(metaAdsCount("12345")).toBe(12345);
    for (const bad of ["-1", "1.5", "", 3, "9".repeat(16)]) expect(metaAdsCount(bad)).toBeUndefined();
    expect(metaAdsCents("123.45")).toBe(12345);
    expect(metaAdsCents("0.1")).toBe(10);
    expect(metaAdsCents("19.995")).toBe(2000);
    expect(metaAdsCents("19.9949")).toBe(1999);
    expect(metaAdsCents("42")).toBe(4200);
    expect(metaAdsCents(2352.45)).toBe(235245);
    expect(metaAdsCents(0)).toBe(0);
    expect(metaAdsCents(1e13)).toBe(1e15);
    for (const bad of ["-1.00", "1e3", "1.", "", "1".repeat(14), -1, Number.NaN, 1e13 + 1, null]) expect(metaAdsCents(bad), String(bad)).toBeUndefined();
  });

  it("finds an action's value by type, and keeps campaign names short with no @", () => {
    expect(metaAdsAction(row().actions, "purchase")).toBe("2");
    expect(metaAdsAction(row().actions, "lead")).toBeUndefined();
    expect(metaAdsAction("purchase", "purchase")).toBeUndefined();
    expect(metaAdsAction([null, { action_type: "purchase", value: "3" }], "purchase")).toBe("3");
    expect(metaAdsLabel("  Test reels  ")).toBe("Test reels");
    expect(metaAdsLabel("x".repeat(300))).toHaveLength(200);
    expect(metaAdsLabel("x".repeat(300), 10)).toHaveLength(10);
    for (const bad of ["for customer1@example.test", " ", 5]) expect(metaAdsLabel(bad)).toBeUndefined();
  });

  it("reads a page's rows and its next cursor only when Meta says there is more", () => {
    expect(metaAdsPage({ data: [row(), 5], paging: { cursors: { after: "QUZ" }, next: "https://graph.facebook.com/next" } })).toEqual({ rows: [row(), {}], after: "QUZ" });
    expect(metaAdsPage({ data: [row()], paging: { cursors: { after: "QUZ" } } }).after).toBeUndefined();
    expect(metaAdsPage({ data: [], paging: { cursors: { after: "" }, next: "x" } }).after).toBeUndefined();
    expect(metaAdsPage({ data: [], paging: { cursors: { after: 5 }, next: "x" } }).after).toBeUndefined();
    expect(metaAdsPage({ data: [] })).toEqual({ rows: [], after: undefined });
    expect(() => metaAdsPage({})).toThrow(MetaAdsShapeError);
    expect(() => metaAdsPage(null)).toThrow("without a data list");
  });

  it("turns a row into ads.campaign_reported with the day, campaign and figures in cents", () => {
    const e = metaAdsCampaignEvent(row(), CTX);
    expect(e.type).toBe(META_ADS_EVENTS.campaign);
    expect(e.occurredAt).toBe("2026-10-01T00:00:00.000Z");
    expect(e.receivedAt).toBe(RECEIVED);
    expect(e.idempotencyKey).toMatch(/^meta:campaign:1234567890:2026-10-01:120200000000000001:[0-9a-f]{16}$/);
    expect(e.id).toBe(`meta_${e.idempotencyKey.slice(5)}`);
    expect(e.payload).toEqual({
      accountId: "meta_ads:account:1234567890",
      day: "2026-10-01",
      campaignId: "meta_ads:campaign:120200000000000001",
      campaignName: "Test bridal reels",
      objective: "OUTCOME_SALES",
      impressions: 1000,
      reach: 800,
      clicks: 20,
      costCents: 12345,
      conversions: 2,
      conversionValueCents: 189050,
      currency: "USD",
    });
  });

  it("counts no purchases when none are listed, and drops what it can't trust", () => {
    const quiet = metaAdsCampaignEvent(row({ actions: undefined, action_values: undefined }), CTX);
    expect(quiet.payload).toMatchObject({ conversions: 0, conversionValueCents: 0 });
    const odd = metaAdsCampaignEvent(row({ campaign_name: "for customer1@example.test", objective: "sales", account_currency: "usd", campaign_id: 5 }), CTX);
    for (const field of ["campaignName", "objective", "currency"]) expect(odd.payload, field).not.toHaveProperty(field);
    expect(odd.payload.campaignId).toBe("meta_ads:campaign:unknown");
    expect(JSON.stringify(odd)).not.toContain("@");
    expect(metaAdsCampaignEvent(row({ objective: `A${"B".repeat(39)}` }), CTX).payload.objective).toHaveLength(40);
    expect(metaAdsCampaignEvent(row({ objective: `A${"B".repeat(40)}` }), CTX).payload).not.toHaveProperty("objective");
    expect(metaAdsCampaignEvent(row({ campaign_id: "1".repeat(26) }), CTX).payload.campaignId).toBe("meta_ads:campaign:unknown");
  });

  it("keys a row by day and campaign, and its numbers by digest", () => {
    const a = metaAdsCampaignEvent(row(), CTX);
    expect(metaAdsCampaignEvent(row(), { ...CTX, receivedAt: "2026-10-21T00:00:00.000Z" }).idempotencyKey).toBe(a.idempotencyKey);
    const revised = metaAdsCampaignEvent(row({ actions: [{ action_type: "purchase", value: "3" }] }), CTX);
    expect(revised.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(revised.idempotencyKey.split(":").slice(0, 5)).toEqual(a.idempotencyKey.split(":").slice(0, 5));
    expect(metaAdsCampaignEvent(row({ campaign_id: "222" }), CTX).idempotencyKey).toContain(":222:");
  });

  it("leaves a row with an unreadable day without an occurredAt, so it is dead-lettered", () => {
    const e = metaAdsCampaignEvent(row({ date_start: "yesterday" }), CTX);
    expect(e.occurredAt).toBeUndefined();
    expect(e.idempotencyKey).toContain(":unknown:");
    expect(e.payload).not.toHaveProperty("day");
    expect(metaAdsPageEvents({ rows: [row(), row()], after: undefined }, CTX)).toHaveLength(2);
  });

  it("builds fixtures that look synthetic", () => {
    assertSynthetic(account());
  });
});

describe("Meta Ads client", () => {
  it("builds the insights query only from the fixed report, a checked range and Meta's cursor", () => {
    const params = metaAdsInsightsParams({ since: "2026-10-01", until: "2026-10-31", after: null });
    expect(Object.fromEntries(params)).toEqual({
      level: "campaign",
      fields: META_ADS_FIELDS.join(","),
      time_range: '{"since":"2026-10-01","until":"2026-10-31"}',
      time_increment: "1",
      limit: String(META_ADS_PAGE_SIZE),
    });
    expect(metaAdsInsightsParams({ ...Q, after: "QVFIUm-x_2=" }).get("after")).toBe("QVFIUm-x_2=");
    const bad: [unknown, string][] = [
      [{ ...Q, filtering: "[]" }, "doesn't take filtering"],
      [{ ...Q, since: "2026-02-30" }, "YYYY-MM-DD"],
      [{ ...Q, until: "today" }, "YYYY-MM-DD"],
      [{ ...Q, since: "2026-10-03" }, `1 to ${META_ADS_MAX_RANGE_DAYS} days`],
      [{ ...Q, until: "2026-11-01" }, `1 to ${META_ADS_MAX_RANGE_DAYS} days`],
      [{ ...Q, after: "a&b" }, "cursor Meta returned"],
      [{ ...Q, after: "" }, "cursor Meta returned"],
      [{ ...Q, after: "x".repeat(1025) }, "cursor Meta returned"],
      [{ ...Q, after: 5 }, "cursor Meta returned"],
    ];
    for (const [query, message] of bad) expect(() => metaAdsInsightsParams(query as never), message).toThrow(message);
    expect(() => metaAdsInsightsParams({ ...Q, until: "2026-10-31" })).not.toThrow();
    expect(metaAdsDayMs("2026-10-01")).toBe(Date.parse("2026-10-01T00:00:00Z"));
    for (const bad of ["2026-02-30", 5]) expect(metaAdsDayMs(bad)).toBeNaN();
  });

  it("accepts a token holding ads_read and public_profile, and nothing that can change anything", () => {
    const perms = (...granted: string[]) => ({ data: [...granted.map((permission) => ({ permission, status: "granted" })), { permission: "ads_management", status: "declined" }] });
    expect(metaAdsPermissionProblem(perms("ads_read"))).toBeNull();
    expect(metaAdsPermissionProblem(perms("ads_read", "public_profile"))).toBeNull();
    expect(metaAdsPermissionProblem(perms("ads_read", "ads_management"))).toBe("the Meta Ads token holds more than read-only access (ads_management)");
    expect(metaAdsPermissionProblem(perms("ads_read", "business_management"))).toContain("more than read-only");
    expect(metaAdsPermissionProblem(perms("public_profile"))).toBe("the Meta Ads token doesn't hold ads_read");
    expect(metaAdsPermissionProblem({ data: [null, { permission: 5, status: "granted" }, { permission: "ads_read", status: "granted" }] })).toBeNull();
    for (const body of [{}, null, { data: "ads_read" }]) expect(metaAdsPermissionProblem(body)).toContain("didn't say");
  });

  it("reads ad account ids with or without act_, and won't build without its settings", () => {
    expect(metaAdsAccountId(" act_1234567890 ")).toBe(ACCOUNT);
    expect(metaAdsAccountId(ACCOUNT)).toBe(ACCOUNT);
    for (const id of ["act_", "act_12a", "12-34", "", "1".repeat(21), `act_${"1".repeat(21)}`, 5]) expect(metaAdsAccountId(id), String(id)).toBeUndefined();
    for (const token of ["", "short", "has space in it here ok", "t".repeat(1025)]) expect(() => metaAdsClient({ ...base(), accessToken: token }), token).toThrow("set META_ADS_ACCESS_TOKEN");
    expect(() => metaAdsClient({ ...base(), accountId: "act_x" })).toThrow("META_ADS_ACCOUNT_ID must be the ad account's numeric id");
    expect(metaAdsClient({ ...base(), accountId: "act_1234567890", accessToken: ` ${TOKEN} ` }).accountId).toBe(ACCOUNT);
  });

  it("checks the token's permissions once, then sends only GETs for insights with the token in the header", async () => {
    const seen: { url: string; method: string; headers: [string, string][] }[] = [];
    const mock = metaAdsDocMock(account());
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method ?? "GET", headers: [...new Headers(init?.headers).entries()] });
      return mock.fetch(input, init);
    }) as typeof fetch;
    const client = metaAdsClient(base(spy));
    await client.insights(Q);
    await client.insights({ ...Q, until: "2026-10-01" });
    expect(mock.permissionReads).toBe(1);
    expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([`GET ${GRAPH}/me/permissions`, `GET ${INSIGHTS}`, `GET ${INSIGHTS}`]);
    for (const s of seen) {
      expect(s.url).not.toContain(TOKEN);
      expect(s.headers.sort()).toEqual([
        ["accept", "application/json"],
        ["authorization", `Bearer ${TOKEN}`],
      ]);
    }
  });

  it("stops before reading anything when the token can change the account", async () => {
    const mock = metaAdsDocMock(account({ permissions: ["ads_read", "ads_management"] }));
    const client = metaAdsClient(base(mock.fetch));
    await expect(client.insights(Q)).rejects.toThrow("holds more than read-only access (ads_management); make a system user token with only ads_read");
    expect(mock.reads).toEqual([]);
    // A failed check is tried again, not remembered.
    await expect(client.insights(Q)).rejects.toThrow(MetaAdsConfigError);
    expect(mock.permissionReads).toBe(2);
  });

  it("checks once for reads sent together", async () => {
    const mock = metaAdsDocMock(account());
    const client = metaAdsClient(base(mock.fetch));
    await Promise.all([client.insights(Q), client.insights(Q)]);
    expect(mock.permissionReads).toBe(1);
  });

  it("explains an expired token and a missing ad account assignment", async () => {
    const expired = (await metaAdsClient({ ...base(metaAdsDocMock(account({ accessToken: `EAA${"o".repeat(60)}` })).fetch) })
      .insights(Q)
      .catch((e: unknown) => e)) as MetaAdsApiError;
    expect(expired).toBeInstanceOf(MetaAdsApiError);
    expect([expired.status, expired.code]).toEqual([400, 190]);
    expect(expired.message).toBe("Meta answered HTTP 400: Invalid OAuth access token.; the token expired or was revoked, so make a new system user token");
    expect(expired.message).not.toContain(TOKEN);
    for (const code of [200, 10]) {
      const denied = (await metaAdsClient(base(fake(() => new Response(JSON.stringify({ error: { message: "Permission denied", code } }), { status: 403 }))))
        .insights(Q)
        .catch((e: unknown) => e)) as MetaAdsApiError;
      expect(denied.message).toBe(`Meta answered HTTP 403: Permission denied; the system user needs the ad account act_${ACCOUNT} assigned to it`);
    }
    const missing = (await metaAdsClient(base(metaAdsDocMock(account({ accountId: "999" })).fetch))
      .insights(Q)
      .catch((e: unknown) => e)) as MetaAdsApiError;
    expect([missing.code, missing.message]).toEqual([100, "Meta answered HTTP 400: Unsupported get request. Object does not exist or cannot be loaded due to missing permissions."]);
  });

  it("waits out Meta's throttling codes a few times, doubling up to a cap, then gives up with a clear error", async () => {
    const mock = metaAdsDocMock(account({ rateLimited: 2 }));
    const waits: number[] = [];
    expect(metaAdsPage(await metaAdsClient({ ...base(mock.fetch), sleep: async (ms) => void waits.push(ms) }).insights(Q)).rows).toHaveLength(4);
    expect(waits).toEqual([1000, 2000]);
    for (const [status, code] of [
      [400, 80000],
      [400, 80004],
      [400, 613],
      [400, 4],
      [400, 32],
      [429, undefined],
    ] as const) {
      let sent = 0;
      const doubling: number[] = [];
      const limited = fake(() => (sent++, new Response(JSON.stringify({ error: { message: "slow down", ...(code ? { code } : {}) } }), { status })));
      const error = (await metaAdsClient({ ...base(limited), sleep: async (ms) => void doubling.push(ms), rateLimitRetries: 8 })
        .insights(Q)
        .catch((e: unknown) => e)) as MetaAdsApiError;
      expect(error.message, String(code)).toContain("kept rate-limiting the sync");
      expect([error.status, error.code]).toEqual([status, code]);
      expect(doubling).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 64_000]);
      expect(sent).toBe(9);
    }
  });

  it("turns down an answer that isn't a JSON object, and cuts a long error short", async () => {
    await expect(metaAdsClient(base(fake(() => new Response("<html>", { status: 200 })))).insights(Q)).rejects.toThrow("Meta did not answer with JSON");
    await expect(metaAdsClient(base(fake(() => new Response("[]", { status: 200 })))).insights(Q)).rejects.toThrow("Meta did not answer with JSON");
    const long = (await metaAdsClient(base(fake(() => new Response(JSON.stringify({ error: { message: "m".repeat(300), code: 1.5 } }), { status: 500 }))))
      .insights(Q)
      .catch((x: unknown) => x)) as MetaAdsApiError;
    expect([long.message, long.code]).toEqual([`Meta answered HTTP 500: ${"m".repeat(200)}`, undefined]);
    const bare = (await metaAdsClient(base(fake(() => new Response(JSON.stringify({ error: "x" }), { status: 502 }))))
      .insights(Q)
      .catch((x: unknown) => x)) as MetaAdsApiError;
    expect(bare.message).toBe("Meta answered HTTP 502");
    await expect(metaAdsClient(base(fake(() => new Response("{}", { status: 200 }), { data: [] }))).insights(Q)).rejects.toThrow("doesn't hold ads_read");
  });

  it("checks a query before any request is sent", async () => {
    const mock = metaAdsDocMock(account());
    await expect(metaAdsClient(base(mock.fetch)).insights({ ...Q, since: "today" })).rejects.toThrow(MetaAdsConfigError);
    expect(mock.fetch.calls).toEqual([]);
  });
});

describe("Meta Ads connector", () => {
  it("passes every runSync scenario: full import, replay, resume and retry", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(metaAdsDocMock(account())), expected: { ingested: 7 } });
    expect(result.full.batches).toBe(24);
    expect(parseMetaAdsCursor(result.full.cursor)).toMatchObject({ pass: "historical", done: true, from: "2024-10-20", until: "2026-10-20" });
  });

  it("reads two years in 31-day windows, up to today, with no gap or overlap", async () => {
    const mock = metaAdsDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(7);
    const read = ranges(mock);
    expect(read).toHaveLength(24);
    expect(read[0]).toBe("2024-10-20..2024-11-19");
    expect(read[23]).toMatch(/^2026-\d{2}-\d{2}\.\.2026-10-20$/);
    for (let i = 1; i < read.length; i++) expect(metaAdsDayMs(read[i]!.split("..")[0]) - metaAdsDayMs(read[i - 1]!.split("..")[1])).toBe(86_400_000);
    expect(memory.events.every((e) => e.source === "meta_ads" && e.type === META_ADS_EVENTS.campaign)).toBe(true);
  });

  it("pages through a window with Meta's cursor, never following the link Meta sends", async () => {
    const mock = metaAdsDocMock(account({ pageCap: 4 }));
    const early = { now: () => new Date("2026-10-04T12:00:00Z") };
    const batches = await drain(connector(mock, early).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(mock.reads.map((q) => q.get("after") === null)).toEqual([true, false]);
    expect(Object.fromEntries([...mock.reads[1]!].filter(([k]) => k !== "after"))).toEqual(Object.fromEntries(mock.reads[0]!));
    expect(batches.flatMap((b) => b.events)).toHaveLength(6);
  });

  it("reads again from two weeks before the last day it read, storing revised rows as new versions", async () => {
    const data = account();
    const mock = metaAdsDocMock(data);
    const { memory, pipeline } = testPipeline();
    let now = new Date("2026-10-04T12:00:00Z");
    const c = connector(mock, { now: () => now });
    await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(ranges(mock)).toEqual(["2026-09-20..2026-10-04"]);
    mock.reads.length = 0;
    // A purchase is attributed late to one row; nothing else changes.
    data.rows[1]!.purchases = "1";
    data.rows[1]!.purchaseValue = "500.00";
    now = new Date("2026-10-06T12:00:00Z");
    const report = await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(ranges(mock)).toEqual(["2026-09-20..2026-10-06"]);
    expect([report.ingested, report.duplicates]).toEqual([1, 5]);
    expect(META_ADS_REVISIT_DAYS).toBe(14);
  });

  it("starts an incremental sync with no checkpoint two weeks back, and never after today", async () => {
    const mock = metaAdsDocMock(account());
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(ranges(mock)).toEqual(["2026-10-06..2026-10-20"]);
    mock.reads.length = 0;
    const ahead: MetaAdsCursor = { pass: "incremental", done: true, from: "2026-11-01", until: "2026-12-31", windowStart: "2026-11-01", after: null };
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(ahead) }));
    expect(ranges(mock)).toEqual(["2026-10-20..2026-10-20"]);
  });

  it("resumes an unfinished pass from its checkpoint and page, and keeps a finished import finished", async () => {
    const mock = metaAdsDocMock(account({ pageCap: 4 }));
    const early = { now: () => new Date("2026-10-04T12:00:00Z") };
    const first = await drain(connector(mock, early).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    const mid = parseMetaAdsCursor(first[0]!.cursor)!;
    expect(mid.after).toEqual(expect.any(String));
    mock.reads.length = 0;
    const rest = await drain(connector(mock, early).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(mid) }));
    expect(mock.reads.map((q) => q.get("after"))).toEqual([mid.after]);
    expect(rest.flatMap((b) => b.events)).toHaveLength(2);
    mock.reads.length = 0;
    const done: MetaAdsCursor = { pass: "historical", done: true, from: "2024-10-20", until: "2026-10-20", windowStart: "2024-10-20", after: null };
    expect(await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) }))).toEqual([]);
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...done, done: false, windowStart: "2026-10-01" }) }));
    expect(ranges(mock)).toEqual(["2026-10-01..2026-10-20", "2026-10-01..2026-10-20"]);
    mock.reads.length = 0;
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...done, until: "2026-10-15" }) }));
    expect(ranges(mock)[0]).toBe("2026-10-01..2026-10-20");
  });

  it("dead-letters a row with an unreadable day and stores the rest", async () => {
    const client = { accountId: ACCOUNT, insights: async () => ({ data: [row({ date_start: "nope" }), row()] }) };
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(metaAdsDocMock(account()), { client }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect([report.ingested, report.deadLettered]).toEqual([1, 1]);
  });

  it("turns down a checkpoint that isn't one of its own", () => {
    expect(parseMetaAdsCursor(null)).toBeNull();
    const ok: MetaAdsCursor = { pass: "historical", done: false, from: "2024-10-20", until: "2026-10-20", windowStart: "2025-01-01", after: null };
    expect(parseMetaAdsCursor(JSON.stringify(ok))).toEqual(ok);
    expect(parseMetaAdsCursor(JSON.stringify({ ...ok, after: "abc" }))!.after).toBe("abc");
    const bad: unknown[] = [
      null,
      { ...ok, pass: "full" },
      { ...ok, done: "no" },
      { ...ok, from: "2024-13-01" },
      { ...ok, windowStart: "2024-10-19" },
      { ...ok, windowStart: "2026-10-21" },
      { ...ok, after: 5 },
      { ...ok, after: undefined },
    ];
    for (const c of bad) expect(() => parseMetaAdsCursor(JSON.stringify(c)), JSON.stringify(c)).toThrow("not in the expected shape");
  });

  it("declares pausing a campaign and changing a budget, each needing approval, and a read-only gate turns both down", async () => {
    const c = connector(metaAdsDocMock(account()));
    expect(c.source).toBe("meta_ads");
    expect(c.writes).toBe(META_ADS_WRITES);
    expect(META_ADS_WRITES.map((w) => [w.name, w.kind, w.approval, w.dailyCap])).toEqual([
      ["pause_campaign", "update", "each", 5],
      ["set_campaign_budget", "update", "each", 5],
    ]);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.integration, a.action, a.outcome])).toEqual([
      ["meta_ads", "pause_campaign", "refused"],
      ["meta_ads", "set_campaign_budget", "refused"],
    ]);
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: writePolicy(["meta_ads:pause_campaign"]), audit: new InMemoryWriteAuditLog() });
    const ran: string[] = [];
    for (const action of META_ADS_WRITES) await gate.run(action, "test", async () => void ran.push(action.name)).catch(() => {});
    expect(ran).toEqual(["pause_campaign"]);
  });

  it("never asks Meta for anything but the fixed report", async () => {
    const mock = metaAdsDocMock(account({ pageCap: 4 }));
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    for (const q of mock.reads) expect([...q.keys()].filter((k) => k !== "after")).toEqual(["level", "fields", "time_range", "time_increment", "limit"]);
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`))).toEqual(new Set([`GET ${GRAPH}/me/permissions`, `GET ${INSIGHTS}`]));
  });
});

describe("the Meta Ads mock", () => {
  it("turns down fields it doesn't know, a cursor from another read and a bad time range", async () => {
    const mock = metaAdsDocMock(account({ pageCap: 2 }));
    const get = (q: string) => mock.fetch(`${INSIGHTS}?${q}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const ok = metaAdsInsightsParams(Q);
    const first = (await (await get(String(ok))).json()) as { paging: { cursors: { after: string } } };
    expect((await get(`${ok}&after=${first.paging.cursors.after}`)).status).toBe(200);
    const other = metaAdsInsightsParams({ ...Q, until: "2026-10-01" });
    expect((await get(`${other}&after=${first.paging.cursors.after}`)).status).toBe(400);
    expect((await get(String(ok).replace("campaign_id", "user_email"))).status).toBe(400);
    expect((await get(String(ok).replace("level=campaign", "level=ad"))).status).toBe(400);
    expect((await get(`level=campaign&time_increment=1&fields=spend&time_range=nope`)).status).toBe(400);
    expect((await get(`level=campaign&time_increment=1&fields=spend&time_range=${encodeURIComponent('{"since":"2026-10-02","until":"2026-10-01"}')}`)).status).toBe(400);
    const none = metaAdsDocMock(account({ permissions: ["public_profile"] }));
    expect((await none.fetch(`${INSIGHTS}?${ok}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(403);
  });
});
