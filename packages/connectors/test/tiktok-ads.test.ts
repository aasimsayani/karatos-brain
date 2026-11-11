import { describe, expect, it } from "vitest";
import { InMemoryWriteAuditLog, WriteGate, runSync, writePolicy, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, testPipeline, tiktokAdsDocMock, tiktokAdsRow, type TikTokAdsMock, type TikTokAdsMockData } from "@karatos/connector-testkit";
import {
  TIKTOK_ADS_DIMENSIONS,
  TIKTOK_ADS_EVENTS,
  TIKTOK_ADS_HOSTS,
  TIKTOK_ADS_MAX_RANGE_DAYS,
  TIKTOK_ADS_METRICS,
  TIKTOK_ADS_PAGE_SIZE,
  TIKTOK_ADS_RATE_LIMIT_CODES,
  TIKTOK_ADS_RETRY_CODES,
  TIKTOK_ADS_REVISIT_DAYS,
  TIKTOK_ADS_TOKEN_CODES,
  TIKTOK_ADS_WRITES,
  TikTokAdsApiError,
  TikTokAdsConfigError,
  parseTikTokAdsCursor,
  tiktokAdsCampaignEvent,
  tiktokAdsCents,
  tiktokAdsClient,
  tiktokAdsConnector,
  tiktokAdsCount,
  tiktokAdsDay,
  tiktokAdsDayMs,
  tiktokAdsLabel,
  tiktokAdsReportParams,
  type TikTokAdsClient,
  type TikTokAdsClientOptions,
  type TikTokAdsCursor,
  type TikTokAdsEvent,
  type TikTokAdsOptions,
} from "../src/index.js";

// A token-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = ["tok", "a".repeat(37)].join("");
const ADVERTISER = "7000000000000000001";
const NOW = () => new Date("2026-10-20T12:00:00Z");
const RECEIVED = "2026-10-20T12:00:00.000Z";
const CTX = { advertiserId: ADVERTISER, receivedAt: RECEIVED };
const PROD = "https://business-api.tiktok.com/open_api/v1.3";
const REPORT = `${PROD}/report/integrated/get/`;
const noSleep = async () => {};
const Q = { start: "2026-10-01", end: "2026-10-02", page: 1 };
const DAY_MS = 86_400_000;

function account(overrides: Partial<TikTokAdsMockData> = {}): TikTokAdsMockData {
  tiktokAdsRow.reset();
  // Two campaigns on 2026-10-01, 2026-10-02 and 2026-10-03, and one row on the first day of the two years.
  const rows = [...tiktokAdsRow.many(6), tiktokAdsRow.one({ date: "2024-10-20" })];
  return { advertiserId: ADVERTISER, accessToken: TOKEN, rows, ...overrides };
}

const base = (fetch?: typeof globalThis.fetch): TikTokAdsClientOptions => ({ accessToken: TOKEN, advertiserId: ADVERTISER, sleep: noSleep, ...(fetch ? { fetch } : {}) });
const connector = (mock: TikTokAdsMock, overrides: Partial<TikTokAdsOptions> = {}) => tiktokAdsConnector({ ...base(mock.fetch), now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as TikTokAdsEvent[];
async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}
const ranges = (mock: TikTokAdsMock) => mock.reads.map((q) => `${q.start_date}..${q.end_date}#${q.page}`);

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
const answer = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
const page = (list: unknown[], totalPage: unknown = 1) => answer({ code: 0, message: "OK", data: { list, page_info: { page: 1, page_size: 1000, total_number: list.length, total_page: totalPage } } });
const coded = (code: number) => answer({ code, message: "secret detail", data: {} });
const client = (fetch: typeof globalThis.fetch, extra: Partial<TikTokAdsClientOptions> = {}) => {
  const slept: number[] = [];
  return { c: tiktokAdsClient({ ...base(fetch), sleep: async (ms) => void slept.push(ms), ...extra }), slept };
};

const row = (dims: Record<string, unknown> = {}, metrics: Record<string, unknown> = {}) => ({
  dimensions: { campaign_id: "1780000000000000001", stat_time_day: "2026-10-01 00:00:00", ...dims },
  metrics: { campaign_name: "Test bridal spark ads", objective_type: "PRODUCT_SALES", spend: "123.45", impressions: "1000", reach: "800", clicks: "20", complete_payment: "2", total_complete_payment_rate: "1890.50", ...metrics },
});

describe("TikTok Ads normalizer", () => {
  it("reads days, counts and money, turning down anything else", () => {
    expect(tiktokAdsDay("2026-10-01 00:00:00")).toBe("2026-10-01");
    expect(tiktokAdsDay("2026-10-01")).toBe("2026-10-01");
    for (const bad of ["2026-02-30 00:00:00", "2026-10-01 01:00:00", "2026-10-01T00:00:00", "x2026-10-01", "2026-10-01 00:00:00x", "2026-1-01", "", null, 5]) expect(tiktokAdsDay(bad), String(bad)).toBeUndefined();
    expect(tiktokAdsCount("1000")).toBe(1000);
    expect(tiktokAdsCount("0")).toBe(0);
    expect(tiktokAdsCount(42)).toBe(42);
    expect(tiktokAdsCount("9".repeat(15))).toBe(999_999_999_999_999);
    for (const bad of ["9".repeat(16), "1.5", "-1", " 1", "1 ", "", 1.5, -1, Number.MAX_SAFE_INTEGER + 1, null, "x"]) expect(tiktokAdsCount(bad), String(bad)).toBeUndefined();
    expect(tiktokAdsCents("123.45")).toBe(12345);
    expect(tiktokAdsCents("0.005")).toBe(1);
    expect(tiktokAdsCents("0.004999")).toBe(0);
    expect(tiktokAdsCents("12")).toBe(1200);
    expect(tiktokAdsCents("1.5")).toBe(150);
    expect(tiktokAdsCents(`1.${"9".repeat(20)}`)).toBe(200);
    expect(tiktokAdsCents("9".repeat(13))).toBe(999_999_999_999_900);
    expect(tiktokAdsCents(12.34)).toBe(1234);
    expect(tiktokAdsCents(0)).toBe(0);
    expect(tiktokAdsCents(1e13)).toBe(1e15);
    for (const bad of ["9".repeat(14), `1.${"0".repeat(21)}`, "-1", "1.", ".5", "1,5", " 1", "", -0.01, 1e13 + 1, Number.NaN, Number.POSITIVE_INFINITY, null, "x"]) expect(tiktokAdsCents(bad), String(bad)).toBeUndefined();
  });

  it("keeps campaign names short, with no @", () => {
    expect(tiktokAdsLabel("  Bridal  ")).toBe("Bridal");
    expect(tiktokAdsLabel("x".repeat(250))).toBe("x".repeat(200));
    for (const bad of ["a@b.test", "   ", "", 5, null]) expect(tiktokAdsLabel(bad), String(bad)).toBeUndefined();
  });

  it("turns a row into ads.campaign_reported with the day, campaign and figures in cents", () => {
    const e = tiktokAdsCampaignEvent(row(), CTX);
    expect(TIKTOK_ADS_EVENTS).toEqual({ campaign: "ads.campaign_reported" });
    expect(e.type).toBe("ads.campaign_reported");
    expect(e.occurredAt).toBe("2026-10-01T00:00:00.000Z");
    expect(e.receivedAt).toBe(RECEIVED);
    expect(e.payload).toStrictEqual({
      accountId: `tiktok_ads:account:${ADVERTISER}`,
      day: "2026-10-01",
      campaignId: "tiktok_ads:campaign:1780000000000000001",
      campaignName: "Test bridal spark ads",
      objective: "PRODUCT_SALES",
      impressions: 1000,
      reach: 800,
      clicks: 20,
      costCents: 12345,
      conversions: 2,
      conversionValueCents: 189050,
    });
    expect(e.idempotencyKey).toMatch(new RegExp(`^tiktok_ads:campaign:${ADVERTISER}:2026-10-01:1780000000000000001:[0-9a-f]{16}$`));
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
  });

  it("drops what it can't trust, keeping the rest", () => {
    const e = tiktokAdsCampaignEvent(row({}, { campaign_name: "x@y.test", objective_type: "sales", spend: "-1", impressions: "1.5", reach: null, clicks: "", complete_payment: "x", total_complete_payment_rate: "1,5" }), CTX);
    expect(e.payload).toStrictEqual({ accountId: `tiktok_ads:account:${ADVERTISER}`, day: "2026-10-01", campaignId: "tiktok_ads:campaign:1780000000000000001" });
    expect(tiktokAdsCampaignEvent(row({}, { objective_type: `A${"B".repeat(39)}` }), CTX).payload.objective).toBe(`A${"B".repeat(39)}`);
    for (const o of [`A${"B".repeat(40)}`, "_A", "A-B", "xA", "Ax"]) expect(tiktokAdsCampaignEvent(row({}, { objective_type: o }), CTX).payload.objective, o).toBeUndefined();
    expect(tiktokAdsCampaignEvent({ dimensions: row().dimensions }, CTX).payload).toStrictEqual({ accountId: `tiktok_ads:account:${ADVERTISER}`, day: "2026-10-01", campaignId: "tiktok_ads:campaign:1780000000000000001" });
    expect(tiktokAdsCampaignEvent({ dimensions: row().dimensions, metrics: [] }, CTX).payload.costCents).toBeUndefined();
  });

  it("keys a row by day and campaign, and its numbers by digest", () => {
    const a = tiktokAdsCampaignEvent(row(), CTX);
    expect(tiktokAdsCampaignEvent(row(), { ...CTX, receivedAt: "2027-01-01T00:00:00.000Z" }).idempotencyKey).toBe(a.idempotencyKey);
    expect(tiktokAdsCampaignEvent(row({}, { cpc: "9" }), CTX).idempotencyKey).toBe(a.idempotencyKey);
    const revised = tiktokAdsCampaignEvent(row({}, { complete_payment: "3" }), CTX);
    expect(revised.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(revised.idempotencyKey.split(":").slice(0, 5)).toEqual(a.idempotencyKey.split(":").slice(0, 5));
    expect(tiktokAdsCampaignEvent(row(), { ...CTX, advertiserId: "2" }).idempotencyKey).not.toBe(a.idempotencyKey);
  });

  it("dead-letters a row without a campaign ID or a day that reads, listing why", () => {
    const e = tiktokAdsCampaignEvent(row({ campaign_id: "abc", stat_time_day: "soon" }), CTX);
    expect(e.occurredAt).toBeUndefined();
    expect(e.payload).toStrictEqual({ accountId: `tiktok_ads:account:${ADVERTISER}`, problems: ["row has no campaign ID that reads", "row has no day that reads"] });
    expect(e.idempotencyKey).toMatch(new RegExp(`^tiktok_ads:unreadable_campaign:${ADVERTISER}:[0-9a-f]{16}$`));
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    expect(tiktokAdsCampaignEvent(row({ campaign_id: "abd", stat_time_day: "soon" }), CTX).idempotencyKey).not.toBe(e.idempotencyKey);
    const d = tiktokAdsCampaignEvent(row({ stat_time_day: "soon" }), CTX);
    expect(d.payload.problems).toEqual(["row has no day that reads"]);
    const c = tiktokAdsCampaignEvent(row({ campaign_id: 178 }), CTX);
    expect(c.payload.problems).toEqual(["row has no campaign ID that reads"]);
    expect(c.occurredAt).toBe("2026-10-01T00:00:00.000Z");
    expect(tiktokAdsCampaignEvent(row({ campaign_id: "1".repeat(25) }), CTX).payload.problems).toBeUndefined();
    for (const id of ["1".repeat(26), "", "x1", "1x"]) expect(tiktokAdsCampaignEvent(row({ campaign_id: id }), CTX).payload.problems, id).toEqual(["row has no campaign ID that reads"]);
    for (const raw of [null, "x", [], { dimensions: [] }]) expect(tiktokAdsCampaignEvent(raw, CTX).payload.problems, JSON.stringify(raw)).toHaveLength(2);
  });

  it("builds fixtures that look synthetic", () => {
    assertSynthetic(account());
  });
});

describe("TikTok Ads client", () => {
  it("builds the report query only from the fixed report, a checked range and a page", () => {
    const p = tiktokAdsReportParams(ADVERTISER, { start: "2026-10-01", end: "2026-10-30", page: 2 });
    expect(Object.fromEntries(p)).toEqual({
      advertiser_id: ADVERTISER,
      service_type: "AUCTION",
      report_type: "BASIC",
      data_level: "AUCTION_CAMPAIGN",
      dimensions: '["campaign_id","stat_time_day"]',
      metrics: '["campaign_name","objective_type","spend","impressions","reach","clicks","complete_payment","total_complete_payment_rate"]',
      start_date: "2026-10-01",
      end_date: "2026-10-30",
      query_lifetime: "false",
      page: "2",
      page_size: "1000",
    });
    expect([TIKTOK_ADS_DIMENSIONS, TIKTOK_ADS_MAX_RANGE_DAYS, TIKTOK_ADS_PAGE_SIZE, TIKTOK_ADS_METRICS.length]).toEqual([["campaign_id", "stat_time_day"], 30, 1000, 8]);
    expect(Object.fromEntries(tiktokAdsReportParams(ADVERTISER, { start: "2026-10-01", end: "2026-10-01", page: 1 })).end_date).toBe("2026-10-01");
    const bad = (q: unknown) => () => tiktokAdsReportParams(ADVERTISER, q as never);
    expect(bad({ ...Q, metrics: "x", b: 1, c: 2, d: 3 })).toThrow(new TikTokAdsConfigError("the report doesn't take metrics, b, c"));
    for (const q of [{ ...Q, start: "2026-10-1" }, { ...Q, end: "2026-02-30" }, { ...Q, start: null }]) expect(bad(q), JSON.stringify(q)).toThrow(new TikTokAdsConfigError("start and end must be days as YYYY-MM-DD"));
    for (const q of [{ ...Q, start: "2026-10-03" }, { start: "2026-10-01", end: "2026-10-31", page: 1 }]) expect(bad(q), JSON.stringify(q)).toThrow(new TikTokAdsConfigError("a report covers 1 to 30 days"));
    for (const p2 of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) expect(bad({ ...Q, page: p2 }), String(p2)).toThrow(new TikTokAdsConfigError("page must be a whole number, 1 or more"));
    expect(tiktokAdsDayMs("2026-10-01")).toBe(Date.parse("2026-10-01T00:00:00Z"));
    for (const d of ["2026-02-30", "x2026-10-01", "2026-10-01x", 5]) expect(tiktokAdsDayMs(d), String(d)).toBeNaN();
  });

  it("checks its settings before sending anything", () => {
    const { fetch, sent } = scripted(page([]));
    const make = (o: Partial<TikTokAdsClientOptions>) => () => tiktokAdsClient({ ...base(fetch), ...o });
    for (const accessToken of ["", "x".repeat(19), "x".repeat(513), `${"x".repeat(20)} y`, `${"x".repeat(20)}/`, `${"x".repeat(20)}+`, undefined as never]) expect(make({ accessToken }), String(accessToken)).toThrow(new TikTokAdsConfigError("TIKTOK_ADS_ACCESS_TOKEN is missing or not in the expected shape"));
    for (const advertiserId of ["", "x", "1".repeat(21), "12a", " ", "-1", undefined as never]) expect(make({ advertiserId }), String(advertiserId)).toThrow(new TikTokAdsConfigError("TIKTOK_ADS_ADVERTISER_ID must be the advertiser's numeric ID"));
    for (const environment of ["staging", "prod", "sandbox-ads"]) expect(make({ environment }), environment).toThrow(new TikTokAdsConfigError("TIKTOK_ADS_ENVIRONMENT must be production or sandbox"));
    expect(make({ accessToken: "Az09_.-".repeat(3), advertiserId: "1" })).not.toThrow();
    expect(make({ accessToken: "x".repeat(512), advertiserId: "1".repeat(20) })).not.toThrow();
    expect(sent).toHaveLength(0);
    expect(tiktokAdsClient(base()).baseUrl).toBe(PROD);
    expect(tiktokAdsClient({ ...base(), environment: " Sandbox " }).baseUrl).toBe("https://sandbox-ads.tiktok.com/open_api/v1.3");
    expect(tiktokAdsClient({ ...base(), environment: "  " }).baseUrl).toBe(PROD);
    expect(tiktokAdsClient({ ...base(), environment: "PRODUCTION" }).baseUrl).toBe(PROD);
    expect(tiktokAdsClient({ ...base(), accessToken: ` ${TOKEN}\n`, advertiserId: ` ${ADVERTISER} ` }).advertiserId).toBe(ADVERTISER);
    expect(TIKTOK_ADS_HOSTS).toEqual({ production: PROD, sandbox: "https://sandbox-ads.tiktok.com/open_api/v1.3" });
  });

  it("sends only a GET of the report, with the token, trimmed, in its header and never in the URL", async () => {
    const { fetch, sent } = scripted(page([row()], 3));
    const { c } = client(fetch, { accessToken: `\t${TOKEN} ` });
    expect(await c.report({ start: "2026-10-01", end: "2026-10-02", page: 2 })).toEqual({ rows: [row()], more: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.url).toBe(`${REPORT}?${tiktokAdsReportParams(ADVERTISER, { start: "2026-10-01", end: "2026-10-02", page: 2 })}`);
    expect(sent[0]!.headers).toEqual({ "access-token": TOKEN, accept: "application/json" });
    expect(sent[0]!.url).not.toContain(TOKEN);
  });

  it("says more follow only while TikTok counts more pages", async () => {
    const more = async (total: unknown, p = 1) => (await client(scripted(page([], total)).fetch).c.report({ ...Q, page: p })).more;
    expect(await more(2)).toBe(true);
    expect(await more(3, 2)).toBe(true);
    for (const [total, p] of [[1, 1], [2, 2], [0, 1], ["5", 1], [1.5, 1], [null, 1], [undefined, 1]] as const) expect(await more(total, p), `${total}/${p}`).toBe(false);
    expect((await client(scripted(answer({ code: 0, data: { list: [] } })).fetch).c.report(Q)).more).toBe(false);
  });

  it("waits out rate limits and passing faults a few times, doubling, then gives up with only TikTok's code", async () => {
    for (const code of [...TIKTOK_ADS_RATE_LIMIT_CODES, ...TIKTOK_ADS_RETRY_CODES]) {
      const s = scripted(coded(code), page([row()]));
      const r = client(s.fetch);
      expect((await r.c.report(Q)).rows, String(code)).toHaveLength(1);
      expect(r.slept).toEqual([1000]);
    }
    expect([...TIKTOK_ADS_RATE_LIMIT_CODES]).toEqual([40016, 40100, 40133]);
    expect([...TIKTOK_ADS_RETRY_CODES]).toEqual([50000, 51001, 51002, 51004, 51041, 51043, 60001]);
    for (const status of [429, 500, 502, 503, 504]) {
      const s = scripted(() => new Response("busy", { status }), page([]));
      expect((await client(s.fetch).c.report(Q)).rows, String(status)).toEqual([]);
    }
    const limited = scripted(coded(40100));
    const l = client(limited.fetch);
    const err = (await l.c.report(Q).catch((e: Error) => e)) as TikTokAdsApiError;
    expect(err).toBeInstanceOf(TikTokAdsApiError);
    expect(err.name).toBe("TikTokAdsApiError");
    expect(err.message).toBe("TikTok kept rate-limiting the sync (code 40100); the next sync resumes from the checkpoint");
    expect([err.status, err.code]).toEqual([200, 40100]);
    expect(limited.sent).toHaveLength(4);
    expect(l.slept).toEqual([1000, 2000, 4000]);
    const busy = (await client(scripted(() => new Response("busy", { status: 503 })).fetch).c.report(Q).catch((e: Error) => e)) as TikTokAdsApiError;
    expect(busy.message).toBe("TikTok kept failing (HTTP 503); the next sync resumes from the checkpoint");
    expect([busy.status, busy.code]).toEqual([503, undefined]);
    expect(((await client(scripted(() => new Response("{}", { status: 429 })).fetch).c.report(Q).catch((e: Error) => e)) as Error).message).toBe("TikTok kept rate-limiting the sync (HTTP 429); the next sync resumes from the checkpoint");
    expect(((await client(scripted(coded(51001)).fetch).c.report(Q).catch((e: Error) => e)) as Error).message).toBe("TikTok kept failing (code 51001); the next sync resumes from the checkpoint");
    const long = client(scripted(coded(40100)).fetch, { retries: 8 });
    await long.c.report(Q).catch(() => undefined);
    expect(long.slept).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 64_000]);
    const once = scripted(coded(40100));
    await client(once.fetch, { retries: 0 }).c.report(Q).catch(() => undefined);
    expect(once.sent).toHaveLength(1);
  });

  it("says when TikTok turns the token down, never repeating TikTok's words", async () => {
    expect([...TIKTOK_ADS_TOKEN_CODES]).toEqual([40001, 40102, 40104, 40105]);
    for (const code of TIKTOK_ADS_TOKEN_CODES) {
      const s = scripted(coded(code));
      const err = await client(s.fetch).c.report(Q).catch((e: Error) => e);
      expect(err).toBeInstanceOf(TikTokAdsConfigError);
      expect((err as Error).name).toBe("TikTokAdsConfigError");
      expect((err as Error).message).toBe(`TikTok turned down TIKTOK_ADS_ACCESS_TOKEN for advertiser ${ADVERTISER} (code ${code}); authorize the app again with its read scopes`);
      expect(s.sent).toHaveLength(1);
    }
    const http = (await client(scripted(answer({ code: 40105 }, 401)).fetch).c.report(Q).catch((e: Error) => e)) as Error;
    expect(http).toBeInstanceOf(TikTokAdsConfigError);
  });

  it("says when TikTok answers with another error or without rows", async () => {
    const e1 = (await client(scripted(coded(40002)).fetch).c.report(Q).catch((e: Error) => e)) as TikTokAdsApiError;
    expect([e1.message, e1.status, e1.code]).toEqual(["TikTok answered code 40002 for the report", 200, 40002]);
    expect(e1.message).not.toContain("secret");
    const e2 = (await client(scripted(answer({ code: 0, data: { list: [] } }, 404)).fetch).c.report(Q).catch((e: Error) => e)) as TikTokAdsApiError;
    expect([e2.message, e2.status, e2.code]).toEqual(["TikTok answered HTTP 404 for the report", 404, 0]);
    const e3 = (await client(scripted(() => new Response("nope", { status: 403 })).fetch).c.report(Q).catch((e: Error) => e)) as TikTokAdsApiError;
    expect([e3.message, e3.code]).toEqual(["TikTok answered HTTP 403 for the report", undefined]);
    await expect(client(scripted(answer({ code: 0, data: { list: [] } }, 201)).fetch).c.report(Q)).rejects.toThrow("TikTok answered HTTP 201 for the report");
    for (const body of [null, {}, { code: "0" }, { code: 1.5 }, [], "x"]) {
      const e = (await client(scripted(answer(body)).fetch).c.report(Q).catch((x: Error) => x)) as TikTokAdsApiError;
      expect(e.message, JSON.stringify(body)).toBe("TikTok answered the report without a code");
    }
    expect(((await client(scripted(() => new Response("not json")).fetch).c.report(Q).catch((x: Error) => x)) as Error).message).toBe("TikTok answered the report without a code");
    for (const body of [{ code: 0 }, { code: 0, data: null }, { code: 0, data: { list: {} } }, { code: 0, data: [] }]) {
      const e = (await client(scripted(answer(body)).fetch).c.report(Q).catch((x: Error) => x)) as TikTokAdsApiError;
      expect([e.message, e.status, e.code], JSON.stringify(body)).toEqual(["TikTok answered the report without a list of rows", 200, 0]);
    }
  });

  it("checks a query before any request is sent", async () => {
    const { fetch, sent } = scripted(page([]));
    await expect(client(fetch).c.report({ ...Q, end: "2026-12-01" })).rejects.toThrow(TikTokAdsConfigError);
    expect(sent).toHaveLength(0);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const s = scripted(coded(40100), page([]));
    globalThis.fetch = s.fetch;
    try {
      const started = Date.now();
      await tiktokAdsClient({ accessToken: TOKEN, advertiserId: ADVERTISER }).report(Q);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    } finally {
      globalThis.fetch = real;
    }
    expect(s.sent).toHaveLength(2);
  });
});

describe("TikTok Ads checkpoint", () => {
  it("reads a checkpoint it wrote, and turns down anything else", () => {
    expect(parseTikTokAdsCursor(null)).toBeNull();
    const c: TikTokAdsCursor = { pass: "historical", done: false, from: "2024-10-20", until: "2026-10-20", windowStart: "2025-01-01", page: 3 };
    expect(parseTikTokAdsCursor(JSON.stringify({ ...c, extra: 1 }))).toStrictEqual(c);
    expect(parseTikTokAdsCursor(JSON.stringify({ ...c, pass: "incremental", done: true, windowStart: c.from }))).toMatchObject({ pass: "incremental", done: true });
    expect(parseTikTokAdsCursor(JSON.stringify({ ...c, windowStart: c.until, from: c.until }))).toMatchObject({ windowStart: c.until });
    const bad = ["", "x", "null", "[]", "5", ...[{ pass: "other" }, { pass: undefined }, { done: "false" }, { done: undefined }, { from: "2024-10-2" }, { until: "soon" }, { windowStart: "2024-02-30" }, { windowStart: "2024-10-19" }, { windowStart: "2026-10-21" }, { from: "2026-10-21", windowStart: "2026-10-21" }, { page: 0 }, { page: 1.5 }, { page: "3" }, { page: undefined }].map((o) => JSON.stringify({ ...c, ...o }))];
    for (const raw of bad) expect(() => parseTikTokAdsCursor(raw), raw).toThrow("TikTok Ads checkpoint is not in the expected shape");
  });
});

describe("TikTok Ads connector", () => {
  it("passes every runSync scenario: full import, replay, resume and retry", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(tiktokAdsDocMock(account())), expected: { ingested: 7 } });
    // 731 days in 30-day windows.
    expect(result.full.batches).toBe(25);
    expect(parseTikTokAdsCursor(result.full.cursor)).toStrictEqual({ pass: "historical", done: true, from: "2024-10-20", until: "2026-10-20", windowStart: "2024-10-20", page: 1 });
  });

  it("reads two years in 30-day windows, up to today, with no gap or overlap", async () => {
    const mock = tiktokAdsDocMock(account());
    await drain(connector(mock).historicalImport({ cursor: null } as never));
    const read = mock.reads.map((q) => [q.start_date!, q.end_date!]);
    expect(read[0]![0]).toBe("2024-10-20");
    expect(read.at(-1)![1]).toBe("2026-10-20");
    for (const [s, e] of read) expect((tiktokAdsDayMs(e) - tiktokAdsDayMs(s)) / DAY_MS + 1).toBeLessThanOrEqual(30);
    expect((tiktokAdsDayMs(read[0]![1]) - tiktokAdsDayMs(read[0]![0])) / DAY_MS + 1).toBe(30);
    for (let i = 1; i < read.length; i++) expect(tiktokAdsDayMs(read[i]![0]) - tiktokAdsDayMs(read[i - 1]![1])).toBe(DAY_MS);
    // As far back as told.
    const deep = tiktokAdsDocMock(account());
    await drain(connector(deep, { historyYears: 3 }).historicalImport({ cursor: null } as never));
    expect(deep.reads[0]!.start_date).toBe("2023-10-20");
    expect(() => connector(deep, { historyYears: 0 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(deep, { historyYears: 1.5 })).toThrow("historyYears must be a positive whole number");
  });

  it("makes each page one batch, keeping the window and next page, and resumes there", async () => {
    const asked: string[] = [];
    const fake: TikTokAdsClient = { advertiserId: ADVERTISER, baseUrl: PROD, report: async (q) => (asked.push(`${q.start}..${q.end}#${q.page}`), { rows: [row()], more: q.page < 2 }) };
    const make = (o: Partial<TikTokAdsOptions> = {}) => tiktokAdsConnector({ ...base(), client: fake, now: () => new Date("2026-10-20T12:00:00Z"), historyYears: 1, ...o });
    const all = await drain(make({ now: () => new Date("2026-02-10T00:00:00Z") }).historicalImport({ cursor: null } as never));
    expect(asked.slice(0, 4)).toEqual(["2025-02-10..2025-03-11#1", "2025-02-10..2025-03-11#2", "2025-03-12..2025-04-10#1", "2025-03-12..2025-04-10#2"]);
    expect(parseTikTokAdsCursor(all[0]!.cursor ?? null)).toStrictEqual({ pass: "historical", done: false, from: "2025-02-10", until: "2026-02-10", windowStart: "2025-02-10", page: 2 });
    expect(parseTikTokAdsCursor(all[1]!.cursor ?? null)).toMatchObject({ windowStart: "2025-03-12", page: 1 });
    expect(eventsOf(all).every((e) => e.receivedAt === "2026-02-10T00:00:00.000Z")).toBe(true);
    asked.length = 0;
    const mid: TikTokAdsCursor = { pass: "historical", done: false, from: "2025-01-01", until: "2025-02-05", windowStart: "2025-01-31", page: 2 };
    const rest = await drain(make().historicalImport({ cursor: JSON.stringify(mid) } as never));
    expect(asked).toEqual(["2025-01-31..2025-02-05#2"]);
    expect(rest.map((b) => parseTikTokAdsCursor(b.cursor ?? null))).toStrictEqual([{ ...mid, done: true, windowStart: "2025-01-01", page: 1 }]);
    // A finished import stays finished.
    asked.length = 0;
    expect(await drain(make().historicalImport({ cursor: JSON.stringify({ ...mid, done: true }) } as never))).toEqual([]);
    // An incremental checkpoint doesn't stand in for the import.
    await drain(make({ now: () => new Date("2025-01-10T00:00:00Z") }).historicalImport({ cursor: JSON.stringify({ ...mid, pass: "incremental" }) } as never));
    expect(asked[0]).toBe("2024-01-10..2024-02-08#1");
  });

  it("reads again from four weeks before the last day it read, storing revised rows as new versions", async () => {
    expect(TIKTOK_ADS_REVISIT_DAYS).toBe(28);
    const data = account();
    const mock = tiktokAdsDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    data.rows![0]!.metrics.complete_payment = "5";
    data.rows!.push(tiktokAdsRow.one({ date: "2026-10-19" }));
    const before = mock.reads.length;
    const later = () => new Date("2026-10-22T12:00:00Z");
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // Each mode keeps its own checkpoint, so the first later sync starts 28 days before today.
    expect(ranges(mock).slice(before)).toEqual(["2026-09-24..2026-10-22#1"]);
    expect(sync.ingested).toBe(2);
    expect(parseTikTokAdsCursor(sync.cursor)).toStrictEqual({ pass: "incremental", done: true, from: "2026-09-24", until: "2026-10-22", windowStart: "2026-09-24", page: 1 });
    const again = await runSync({ connector: connector(mock, { now: () => new Date("2026-11-30T12:00:00Z") }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(ranges(mock).slice(before + 1)).toEqual(["2026-09-24..2026-10-23#1", "2026-10-24..2026-11-22#1", "2026-11-23..2026-11-30#1"]);
    expect(again.duplicates).toBe(7);
    expect(again.ingested).toBe(0);
  });

  it("starts a later sync from a historical checkpoint four weeks before its last day, never after today", async () => {
    const asked: string[] = [];
    const fake: TikTokAdsClient = { advertiserId: ADVERTISER, baseUrl: PROD, report: async (q) => (asked.push(`${q.start}..${q.end}`), { rows: [], more: false }) };
    const make = () => tiktokAdsConnector({ ...base(), client: fake, now: NOW });
    const hist: TikTokAdsCursor = { pass: "historical", done: true, from: "2024-10-20", until: "2026-10-10", windowStart: "2024-10-20", page: 1 };
    await drain(make().incrementalSync({ cursor: JSON.stringify(hist) } as never));
    expect(asked).toEqual(["2026-09-12..2026-10-11", "2026-10-12..2026-10-20"]);
    asked.length = 0;
    // A checkpoint from a clock ahead of this one still starts no later than today.
    await drain(make().incrementalSync({ cursor: JSON.stringify({ ...hist, until: "2026-12-31" }) } as never));
    expect(asked).toEqual(["2026-10-20..2026-10-20"]);
    asked.length = 0;
    // An interrupted later pass resumes; a finished one starts again.
    const mid: TikTokAdsCursor = { pass: "incremental", done: false, from: "2026-09-01", until: "2026-10-15", windowStart: "2026-10-01", page: 1 };
    await drain(make().incrementalSync({ cursor: JSON.stringify(mid) } as never));
    expect(asked).toEqual(["2026-10-01..2026-10-15"]);
    asked.length = 0;
    await drain(make().incrementalSync({ cursor: JSON.stringify({ ...mid, done: true }) } as never));
    expect(asked).toEqual(["2026-09-17..2026-10-16", "2026-10-17..2026-10-20"]);
  });

  it("dead-letters a row that doesn't read and stores the rest", async () => {
    let calls = 0;
    const fake: TikTokAdsClient = { advertiserId: ADVERTISER, baseUrl: PROD, report: async () => ({ rows: calls++ ? [] : [row(), row({ stat_time_day: "soon" }), row({ campaign_id: "1780000000000000002" })], more: false }) };
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: tiktokAdsConnector({ ...base(), client: fake, now: () => new Date("2026-10-01T00:00:00Z") }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.deadLettered).toBe(1);
    expect(report.ingested).toBe(2);
  });

  it("waits out a rate limit inside a sync, and stops with a clear error when the token lacks a scope", async () => {
    const mock = tiktokAdsDocMock(account({ rateLimits: 2 }));
    const slept: number[] = [];
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { sleep: async (ms) => void slept.push(ms) }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(7);
    expect(slept).toEqual([1000, 2000]);
    await expect(drain(connector(tiktokAdsDocMock(account({ noReportingScope: true }))).historicalImport({ cursor: null } as never))).rejects.toThrow("(code 40001)");
    await expect(drain(connector(tiktokAdsDocMock(account({ accessToken: ["oth", "b".repeat(37)].join("") }))).historicalImport({ cursor: null } as never))).rejects.toThrow("(code 40105)");
    await expect(drain(connector(tiktokAdsDocMock(account({ advertiserId: "2" }))).historicalImport({ cursor: null } as never))).rejects.toThrow("TikTok answered code 40002 for the report");
  });

  it("pages through a window the mock splits", async () => {
    tiktokAdsRow.reset();
    const rows = Array.from({ length: 2005 }, () => tiktokAdsRow.one({ date: "2026-10-05" }));
    const mock = tiktokAdsDocMock({ advertiserId: ADVERTISER, accessToken: TOKEN, rows });
    const batches = await drain(connector(mock, { now: () => new Date("2026-10-10T00:00:00Z"), historyYears: 1 }).incrementalSync({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([1000, 1000, 5]);
    expect(ranges(mock)).toEqual(["2026-09-12..2026-10-10#1", "2026-09-12..2026-10-10#2", "2026-09-12..2026-10-10#3"]);
  });

  it("reads up to today when no clock is given", async () => {
    const mock = tiktokAdsDocMock(account());
    await drain(tiktokAdsConnector(base(mock.fetch)).incrementalSync({ cursor: null } as never));
    expect(mock.reads.at(-1)!.end_date).toBe(new Date().toISOString().slice(0, 10));
  });

  it("declares pausing and resuming a campaign, each needing approval, and a read-only gate turns both down", async () => {
    const c = connector(tiktokAdsDocMock(account()));
    expect(c.source).toBe("tiktok_ads");
    expect(c.writes).toBe(TIKTOK_ADS_WRITES);
    expect(TIKTOK_ADS_WRITES.map((w) => [w.integration, w.name, w.kind, w.approval, w.dailyCap])).toEqual([
      ["tiktok_ads", "pause_campaign", "update", "each", 5],
      ["tiktok_ads", "resume_campaign", "update", "each", 5],
    ]);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.integration, a.action, a.outcome])).toEqual([
      ["tiktok_ads", "pause_campaign", "refused"],
      ["tiktok_ads", "resume_campaign", "refused"],
    ]);
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: writePolicy(["tiktok_ads:pause_campaign"]), audit: new InMemoryWriteAuditLog() });
    const ran: string[] = [];
    for (const action of TIKTOK_ADS_WRITES) await gate.run(action, "test", async () => void ran.push(action.name)).catch(() => {});
    expect(ran).toEqual(["pause_campaign"]);
  });

  it("never asks TikTok for anything but the fixed report", async () => {
    const mock = tiktokAdsDocMock(account());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`))).toEqual(new Set([`GET ${REPORT}`]));
  });
});

describe("TikTok Ads doc mock", () => {
  it("checks the token, the advertiser, the report, the range and paging", async () => {
    const mock = tiktokAdsDocMock(account());
    const good = Object.fromEntries(tiktokAdsReportParams(ADVERTISER, { start: "2026-10-01", end: "2026-10-30", page: 1 }));
    const get = async (q: Record<string, string>, token = TOKEN) => (await (await mock.fetch(`${REPORT}?${new URLSearchParams(q)}`, { headers: { "access-token": token } })).json()) as { code: number; data: { list: unknown[]; page_info: Record<string, number> } };
    expect((await get(good, "nope")).code).toBe(40105);
    expect((await get(good)).data.list).toHaveLength(6);
    expect((await get(good)).data.page_info).toEqual({ page: 1, page_size: 1000, total_number: 6, total_page: 1 });
    for (const change of [{ advertiser_id: "2" }, { report_type: "AUDIENCE" }, { service_type: "RESERVATION" }, { data_level: "AUCTION_AD" }, { dimensions: '["ad_id","stat_time_day"]' }, { dimensions: "x" }, { metrics: '["spend","bogus"]' }, { metrics: "[]" }, { metrics: "x" }, { end_date: "2026-10-31" }, { start_date: "soon" }, { end_date: "2026-09-30" }, { page: "0" }, { page_size: "1001" }]) expect((await get({ ...good, ...change })).code, JSON.stringify(change)).toBe(40002);
    const small = await get({ ...good, page_size: "4", page: "2" });
    expect(small.data.list).toHaveLength(2);
    expect(small.data.page_info).toEqual({ page: 2, page_size: 4, total_number: 6, total_page: 2 });
    const { page: _p, page_size: _s, ...defaults } = good;
    expect((await get(defaults)).data.page_info).toMatchObject({ page: 1, page_size: 10 });
    const one = (await get({ ...good, metrics: '["spend","cpc"]' })).data.list[0];
    expect(one).toEqual({ dimensions: { campaign_id: "1780000000000000001", stat_time_day: "2026-10-01 00:00:00" }, metrics: { spend: "9.25", cpc: "0.31" } });
    tiktokAdsRow.reset();
    const sparse = tiktokAdsDocMock({ advertiserId: ADVERTISER, accessToken: TOKEN, rows: [{ ...tiktokAdsRow.one(), metrics: {} }] });
    const r = (await (await sparse.fetch(`${REPORT}?${new URLSearchParams({ ...good, metrics: '["spend"]' })}`, { headers: { "access-token": TOKEN } })).json()) as { data: { list: { metrics: unknown }[] } };
    expect(r.data.list[0]!.metrics).toEqual({ spend: "0" });
    const empty = tiktokAdsDocMock({ advertiserId: ADVERTISER, accessToken: TOKEN });
    expect(((await (await empty.fetch(`${REPORT}?${new URLSearchParams(good)}`, { headers: { "access-token": TOKEN } })).json()) as { data: { page_info: unknown } }).data.page_info).toEqual({ page: 1, page_size: 1000, total_number: 0, total_page: 0 });
    await expect(mock.fetch(`${PROD}/campaign/status/update/`, { method: "POST" })).rejects.toThrow("not in the vendor's docs");
  });
});
