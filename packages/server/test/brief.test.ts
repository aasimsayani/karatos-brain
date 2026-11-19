import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, type BriefStore, type SavedBrief } from "@karatos/core";
import { combineDepartments, RETAIL_DEPARTMENTS, type DailyBrief } from "@karatos/retail";
import {
  BRIEF_RETRY_MS,
  BRIEF_WEBHOOK_TIMEOUT_MS,
  createBrainApp,
  createBriefRunner,
  readDailyBrief,
  StaticDocumentationSource,
  webhookDelivery,
  yesterdayIn,
  type BriefRunnerOptions,
} from "../src/index.js";

const ORG = "example-jewelers";
const TZ = "America/New_York";
const newKey = (prefix: string) => `${prefix}${randomBytes(32).toString("hex")}`;
const INSTANCE_KEY = newKey("i");
const SUPPORT_KEY = newKey("s");

function brain(now = "2026-11-19T12:00:00.000Z") {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: new StaticDocumentationSource([]), now: () => new Date(now) });
  let n = 0;
  const sale = (source: string, occurredAt: string, totalCents: number, channel = "store") => {
    n++;
    return pipeline.ingest({
      id: `evt_${source}_${n}`,
      organizationId: ORG,
      source,
      type: "sale.completed",
      occurredAt,
      receivedAt: occurredAt,
      idempotencyKey: `${source}:sale:${n}`,
      payload: { saleId: `S${n}`, channel, totalCents, lines: [{ sku: "R1", quantity: 1, unitPriceCents: totalCents }], payments: [{ method: "card", amountCents: totalCents }] },
    });
  };
  const refund = (source: string, occurredAt: string, refundCents: number) => {
    n++;
    return pipeline.ingest({
      id: `evt_${source}_${n}`,
      organizationId: ORG,
      source,
      type: "sale.returned",
      occurredAt,
      receivedAt: occurredAt,
      idempotencyKey: `${source}:return:${n}`,
      payload: { saleId: "S1", returnId: `R${n}`, lines: [{ sku: "R1", quantity: 1, refundCents }] },
    });
  };
  return { memory, pipeline, sale, refund };
}

const salesOf = (brief: DailyBrief) => {
  if (brief.sales.status === "no_data") throw new Error("expected sales figures");
  return brief.sales;
};

describe("readDailyBrief", () => {
  it("counts only the sales inside the store's day, at the edges of local midnight", async () => {
    const b = brain();
    await b.sale("shopify", "2026-11-18T04:59:59Z", 111); // 23:59:59 on the 17th in New York
    await b.sale("shopify", "2026-11-18T05:00:00Z", 1_000); // midnight starting the 18th
    await b.sale("square", "2026-11-19T04:59:59Z", 2_000); // 23:59:59 on the 18th, already the 19th in UTC
    await b.sale("square", "2026-11-19T05:00:00Z", 222); // midnight starting the 19th
    await b.refund("shopify", "2026-11-18T20:00:00Z", 300);
    await b.sale("square", "2026-11-11T15:00:00Z", 4_000, "online"); // same day last week
    const brief = await readDailyBrief({ memory: b.memory, organizationId: ORG, timeZone: TZ, now: () => new Date("2026-11-19T12:00:00Z") }, "2026-11-18");
    const s = salesOf(brief);
    expect(s.day.totals.saleEvents.eventIds).toEqual(["evt_shopify_2", "evt_square_3"]);
    expect(s.day.totals).toMatchObject({ sales: 2, grossCents: 3_000, refunds: 1, refundCents: 300, netCents: 2_700 });
    expect(s.day.totals.refundEvents).toEqual({ eventIds: ["evt_shopify_5"], systems: ["shopify"] });
    expect(s.lastWeek.totals).toMatchObject({ sales: 1, grossCents: 4_000, saleEvents: { eventIds: ["evt_square_6"], systems: ["square"] } });
    expect(s.change).toMatchObject({ sales: 1, grossCents: -1_000 });
    expect(brief.generatedAt).toBe("2026-11-19T12:00:00.000Z");
    expect(brief.sync).toEqual({ known: false, note: "Sync results aren't available to this brief." });
  });

  it("uses a 25-hour day when the clocks go back and a 23-hour day when they go forward", async () => {
    const b = brain();
    await b.sale("square", "2026-11-01T04:30:00Z", 100); // 00:30 EDT on Nov 1
    await b.sale("square", "2026-11-02T04:30:00Z", 200); // 23:30 EST on Nov 1, the 25th hour
    await b.sale("square", "2026-11-02T05:00:00Z", 999); // midnight Nov 2
    await b.sale("square", "2026-03-08T05:30:00Z", 300); // 00:30 EST on Mar 8
    await b.sale("square", "2026-03-09T03:30:00Z", 400); // 23:30 EDT on Mar 8
    await b.sale("square", "2026-03-09T04:00:00Z", 888); // midnight Mar 9
    const read = (date: string) => readDailyBrief({ memory: b.memory, organizationId: ORG, timeZone: TZ, now: () => new Date("2026-11-19T12:00:00Z") }, date);
    expect(salesOf(await read("2026-11-01")).day.totals.grossCents).toBe(300);
    expect(salesOf(await read("2026-03-08")).day.totals.grossCents).toBe(700);
    // Nov 8 compares with Nov 1, across the change.
    expect(salesOf(await read("2026-11-08")).lastWeek.totals.saleEvents.eventIds).toEqual(["evt_square_1", "evt_square_2"]);
  });

  it("says so plainly for an instance with nothing synced", async () => {
    const b = brain();
    const brief = await readDailyBrief({ memory: b.memory, organizationId: ORG, timeZone: TZ, sync: () => ({ scheduled: [], statuses: [], skipped: [] }) }, "2026-11-18");
    expect(brief.hasData).toBe(false);
    expect(brief.sales.status).toBe("no_data");
    expect(brief.text).toContain("This instance has no synced data yet");
  });

  it("sees sales between the two days, so a quiet day and a quiet week ago aren't called no data", async () => {
    const b = brain();
    await b.sale("square", "2026-11-14T16:00:00Z", 700); // Saturday between last Wednesday and this one
    const brief = await readDailyBrief({ memory: b.memory, organizationId: ORG, timeZone: TZ, now: () => new Date("2026-11-19T12:00:00Z") }, "2026-11-18");
    const s = salesOf(brief);
    expect(s.lastSaleBefore).toEqual({ eventId: "evt_square_1", system: "square", occurredAt: "2026-11-14T16:00:00Z" });
    expect(s.notes[0]).toBe("No sales or refunds dated 2026-11-18 have synced. The latest sale before 2026-11-18 is event evt_square_1 from square at 2026-11-14T16:00:00Z.");
  });

  it("cites the latest earlier sale on a quiet day, from before the comparison day", async () => {
    const b = brain();
    await b.sale("shopify", "2026-11-11T04:00:00Z", 500); // 23:00 on Nov 10, before last week's day
    const s = salesOf(await readDailyBrief({ memory: b.memory, organizationId: ORG, timeZone: TZ, now: () => new Date("2026-11-19T12:00:00Z") }, "2026-11-18"));
    expect(s.lastSaleBefore).toEqual({ eventId: "evt_shopify_1", system: "shopify", occurredAt: "2026-11-11T04:00:00Z" });
    expect(s.day.totals.sales).toBe(0);
  });

  it("reads open recommendations from the fortnight before the morning after the day, with their feedback", async () => {
    const memory = new InMemoryStore();
    const r = (id: string, createdAt: string) => ({ id, organizationId: ORG, summary: id, confidence: 0.5, expectedImpact: "x", provenance: { eventIds: [], signalIds: [], documentIds: [] }, degraded: false, createdAt });
    await memory.saveRecommendations([
      r("rec_a_old_2026-11-05", "2026-11-06T04:59:00.000Z"), // just over 14 days before the morning after
      r("rec_a_in_2026-11-06", "2026-11-06T05:00:00.000Z"),
      r("rec_a_done_2026-11-18", "2026-11-18T14:00:00.000Z"),
      r("rec_a_morning_2026-11-19", "2026-11-19T11:00:00.000Z"),
      r("rec_a_late_2026-11-20", "2026-11-20T06:00:00.000Z"), // after the morning after
    ]);
    await memory.recordFeedback({ recommendationId: "rec_a_done_2026-11-18", organizationId: ORG, outcome: "accepted", actor: "owner", recordedAt: "2026-11-18T15:00:00.000Z" });
    const brief = await readDailyBrief({ memory, organizationId: ORG, timeZone: TZ, now: () => new Date("2026-11-25T12:00:00Z") }, "2026-11-18");
    expect(brief.waiting.map((w) => w.recommendationId).sort()).toEqual(["rec_a_in_2026-11-06", "rec_a_morning_2026-11-19"]);
    // Read before the morning after: the fortnight ends now, so nothing raised later counts and a little more of the start does.
    const early = await readDailyBrief({ memory, organizationId: ORG, timeZone: TZ, now: () => new Date("2026-11-19T10:00:00Z") }, "2026-11-18");
    expect(early.waiting.map((w) => w.recommendationId).sort()).toEqual(["rec_a_in_2026-11-06", "rec_a_old_2026-11-05"]);
  });

  it("marks a day partial when it holds more sale events than one brief reads", async () => {
    const memory = new InMemoryStore();
    const many = Array.from({ length: 10_001 }, (_, i) => ({
      id: `e${String(i).padStart(5, "0")}`,
      organizationId: ORG,
      source: "pos",
      type: "sale.completed",
      occurredAt: "2026-11-18T15:00:00.000Z",
      receivedAt: "2026-11-18T15:00:00.000Z",
      idempotencyKey: `pos:${i}`,
      payload: { totalCents: 1, channel: "store" },
    }));
    for (const e of many) await memory.appendEvent(e);
    const s = salesOf(await readDailyBrief({ memory, organizationId: ORG, timeZone: TZ, now: () => new Date("2026-11-19T12:00:00Z") }, "2026-11-18"));
    expect(s.status).toBe("partial");
    expect(s.day.truncated).toBe(true);
    expect(s.day.totals.sales).toBe(10_000);
    expect(s.lastWeek.truncated).toBe(false);
  });

  it("names yesterday on the store's calendar", () => {
    expect(yesterdayIn(new Date("2026-11-19T04:59:00Z"), TZ)).toBe("2026-11-17");
    expect(yesterdayIn(new Date("2026-11-19T05:00:00Z"), TZ)).toBe("2026-11-18");
  });
});

/** Timers the test fires by hand, with a clock it moves. */
function clock(start: string) {
  let at = Date.parse(start);
  const pending: { run: () => void; ms: number }[] = [];
  let cleared = 0;
  return {
    now: () => new Date(at),
    set: (iso: string) => {
      at = Date.parse(iso);
    },
    pending,
    cleared: () => cleared,
    setTimer: (run: () => void, ms: number) => {
      const t = { run, ms };
      pending.push(t);
      return t;
    },
    clearTimer: () => {
      cleared++;
    },
    /** Moves the clock to when the next timer is due and runs it. */
    async fire() {
      const t = pending.shift()!;
      at += t.ms;
      t.run();
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
      return t.ms;
    },
  };
}

function runnerWith(store: BriefStore, c: ReturnType<typeof clock>, extra: Partial<BriefRunnerOptions> = {}) {
  const lines: string[] = [];
  const built: string[] = [];
  const memory = new InMemoryStore();
  const runner = createBriefRunner({
    store,
    organizationId: ORG,
    timeZone: TZ,
    hour: 7,
    build: async (date) => {
      built.push(date);
      return readDailyBrief({ memory, organizationId: ORG, timeZone: TZ, now: c.now }, date);
    },
    log: (l) => lines.push(l),
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    ...extra,
  });
  return { runner, lines, built };
}

describe("createBriefRunner", () => {
  it("builds yesterday's brief once at 7:00 store time each day, and sleeps until the next 7:00", async () => {
    const store = new InMemoryStore();
    const c = clock("2026-11-19T10:00:00.000Z"); // 05:00 in New York
    const { runner, lines, built } = runnerWith(store, c);
    runner.start();
    runner.start();
    expect(c.pending).toHaveLength(1);
    expect(await c.fire()).toBe(0);
    expect(built).toEqual([]);
    expect(c.pending.map((p) => p.ms)).toEqual([2 * 3_600_000]); // until 07:00 EST
    await c.fire();
    expect(c.now().toISOString()).toBe("2026-11-19T12:00:00.000Z");
    expect(built).toEqual(["2026-11-18"]);
    expect(lines).toEqual(["brief 2026-11-18 built: no synced data to report"]);
    expect((await store.getBrief(ORG, "2026-11-18"))!.generatedAt).toBe("2026-11-19T12:00:00.000Z");
    expect(c.pending.map((p) => p.ms)).toEqual([24 * 3_600_000]);
    // A timer that fires a little early finds nothing due and waits out the rest.
    c.pending[0]!.ms -= 1_000;
    await c.fire();
    expect(built).toEqual(["2026-11-18"]);
    expect(c.pending.map((p) => p.ms)).toEqual([1_000]);
    await c.fire();
    expect(built).toEqual(["2026-11-18", "2026-11-19"]);
    await runner.stop();
    expect(c.cleared()).toBe(1);
    runner.start();
    expect(c.pending).toHaveLength(2);
  });

  it("doesn't build or send a day twice when the instance restarts after the hour", async () => {
    const store = new InMemoryStore();
    const c = clock("2026-11-19T12:30:00.000Z");
    const sent: string[] = [];
    const deliver = async (brief: DailyBrief) => {
      sent.push(brief.date);
    };
    const first = runnerWith(store, c, { deliver });
    expect(await first.runner.runOnce()).toMatchObject({ outcome: "built", date: "2026-11-18", delivered: true });
    await first.runner.stop();
    c.set("2026-11-19T13:00:00.000Z");
    const second = runnerWith(store, c, { deliver });
    second.runner.start();
    await c.fire();
    expect(await second.runner.runOnce()).toEqual({ outcome: "already_built", date: "2026-11-18" });
    expect([...first.built, ...second.built]).toEqual(["2026-11-18"]);
    expect(sent).toEqual(["2026-11-18"]);
    expect(first.lines).toEqual(["brief 2026-11-18 built: no synced data to report", "brief 2026-11-18 sent to the webhook"]);
    expect(second.lines).toEqual([]);
    expect(c.pending.map((p) => p.ms)).toEqual([23 * 3_600_000]);
  });

  it("waits for the hour after a restart before it", async () => {
    const c = clock("2026-11-19T11:59:59.000Z");
    const { runner, built } = runnerWith(new InMemoryStore(), c);
    expect(await runner.runOnce()).toEqual({ outcome: "not_due", date: "2026-11-18" });
    expect(runner.untilNext(c.now())).toBe(1_000);
    expect(built).toEqual([]);
  });

  it("joins a check in progress instead of starting a second", async () => {
    const c = clock("2026-11-19T12:30:00.000Z");
    const { runner, built } = runnerWith(new InMemoryStore(), c);
    const [a, b] = await Promise.all([runner.runOnce(), runner.runOnce()]);
    expect(a).toBe(b);
    expect(built).toEqual(["2026-11-18"]);
  });

  it("lets only one of two racing schedulers keep the day", async () => {
    const store = new InMemoryStore();
    const c = clock("2026-11-19T12:30:00.000Z");
    const one = runnerWith(store, c);
    const two = runnerWith(store, c);
    const results = await Promise.all([one.runner.runOnce(), two.runner.runOnce()]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["already_built", "built"]);
    expect([...one.lines, ...two.lines]).toEqual(["brief 2026-11-18 built: no synced data to report"]);
  });

  it("retries a failed build after BRIEF_RETRY_MS, and saves nothing for the failed try", async () => {
    const store = new InMemoryStore();
    const c = clock("2026-11-19T12:30:00.000Z");
    let fail = true;
    const { runner, lines } = runnerWith(store, c, {
      build: async (date) => {
        if (fail) throw new Error("database unavailable");
        return readDailyBrief({ memory: new InMemoryStore(), organizationId: ORG, timeZone: TZ, now: c.now }, date);
      },
    });
    runner.start();
    await c.fire();
    expect(lines).toEqual(["brief 2026-11-18 failed: Error: database unavailable"]);
    expect(await store.getBrief(ORG, "2026-11-18")).toBeNull();
    expect(c.pending.map((p) => p.ms)).toEqual([BRIEF_RETRY_MS]);
    expect(BRIEF_RETRY_MS).toBe(900_000);
    fail = false;
    await c.fire();
    expect(lines.at(-1)).toBe("brief 2026-11-18 built: no synced data to report");
    expect(c.pending.map((p) => p.ms)).toEqual([24 * 3_600_000 - 30 * 60_000 - BRIEF_RETRY_MS]);
    await runner.stop();
  });

  it("logs a failed delivery without the address and keeps the saved brief", async () => {
    const store = new InMemoryStore();
    const c = clock("2026-11-19T12:30:00.000Z");
    const { runner, lines } = runnerWith(store, c, {
      deliver: async () => {
        throw new Error("the brief webhook answered 500");
      },
    });
    expect(await runner.runOnce()).toMatchObject({ outcome: "built", delivered: false });
    expect(lines).toEqual(["brief 2026-11-18 built: no synced data to report", "brief 2026-11-18 webhook failed: Error: the brief webhook answered 500"]);
    expect(await store.getBrief(ORG, "2026-11-18")).not.toBeNull();
    const none = runnerWith(new InMemoryStore(), c);
    expect(await none.runner.runOnce()).toMatchObject({ outcome: "built", delivered: null });
  });

  it("logs counts, never the brief's business text", async () => {
    const store = new InMemoryStore();
    const c = clock("2026-11-19T12:30:00.000Z");
    const b = brain();
    await b.sale("shopify", "2026-11-18T15:00:00Z", 1_000);
    await b.memory.saveRecommendations([
      { id: "rec_finance_payout_short_p1_2026-11-18", organizationId: ORG, summary: "Payout p1 short", confidence: 0.8, expectedImpact: "x", provenance: { eventIds: [], signalIds: [], documentIds: [] }, degraded: false, createdAt: "2026-11-18T15:00:00.000Z" },
    ]);
    const { runner, lines } = runnerWith(store, c, {
      build: (date) =>
        readDailyBrief({ memory: b.memory, organizationId: ORG, timeZone: TZ, now: c.now, sync: () => ({ scheduled: ["shopify"], statuses: [], skipped: [] }) }, date),
    });
    await runner.runOnce();
    expect(lines).toEqual(["brief 2026-11-18 built: 1 sales, 0 refunds, 1 unusual, 1 sync problems, 0 waiting"]);
    const saved = (await store.getBrief(ORG, "2026-11-18")) as SavedBrief;
    expect((saved.brief as unknown as DailyBrief).text).toContain("Payout p1 short");
  });

  it("logs no-data and partial days in its counts", async () => {
    const c = clock("2026-11-19T12:30:00.000Z");
    const memory = new InMemoryStore();
    await memory.saveRecommendations([{ id: "rec_x_1_2026-11-18", organizationId: ORG, summary: "s", confidence: 0.8, expectedImpact: "x", provenance: { eventIds: [], signalIds: [], documentIds: [] }, degraded: false, createdAt: "2026-11-18T15:00:00.000Z" }]);
    const quiet = runnerWith(new InMemoryStore(), c, { build: (date) => readDailyBrief({ memory, organizationId: ORG, timeZone: TZ, now: c.now }, date) });
    await quiet.runner.runOnce();
    expect(quiet.lines).toEqual(["brief 2026-11-18 built: no sales data, 0 unusual, 0 sync problems, 1 waiting"]);
    await memory.appendEvent({ id: "c1", organizationId: ORG, source: "pos", type: "sale.completed", occurredAt: "2026-11-18T15:00:00.000Z", receivedAt: "2026-11-18T15:00:00.000Z", idempotencyKey: "c1", payload: {} });
    const partial = runnerWith(new InMemoryStore(), c, { build: (date) => readDailyBrief({ memory, organizationId: ORG, timeZone: TZ, now: c.now }, date) });
    await partial.runner.runOnce();
    expect(partial.lines[0]).toBe("brief 2026-11-18 built: 0 sales, 0 refunds (partial), 0 unusual, 0 sync problems, 1 waiting");
  });

  it("schedules by the store's clock across a change: 23 hours to the 7:00 after clocks go forward... and back", async () => {
    const c = clock("2026-10-31T11:00:00.000Z"); // 07:00 EDT, Saturday
    const { runner } = runnerWith(new InMemoryStore(), c);
    expect(runner.untilNext(c.now())).toBe(25 * 3_600_000); // to 07:00 EST on Sunday Nov 1
    expect(runner.untilNext(new Date("2026-03-07T12:00:00.000Z"))).toBe(23 * 3_600_000); // to 07:00 EDT on Sunday Mar 8
    expect(runner.untilNext(new Date("2026-11-19T11:59:00.000Z"))).toBe(60_000);
  });

  it("runs on real timers by default, and stop cancels the pending check", async () => {
    const built: string[] = [];
    const runner = createBriefRunner({ store: new InMemoryStore(), organizationId: ORG, timeZone: TZ, hour: 7, build: async (date) => (built.push(date), {}) as DailyBrief, log: () => {} });
    runner.start();
    await runner.stop();
    await new Promise((r) => setTimeout(r, 5));
    expect(built).toEqual([]);
  });

  it("describes a failure that isn't an Error without guessing", async () => {
    const c = clock("2026-11-19T12:30:00.000Z");
    const { runner, lines } = runnerWith(new InMemoryStore(), c, {
      build: async () => {
        throw "plain string";
      },
    });
    expect(await runner.runOnce()).toEqual({ outcome: "failed", date: "2026-11-18", error: "unknown error" });
    expect(lines).toEqual(["brief 2026-11-18 failed: unknown error"]);
  });

  it("only takes a whole hour of the day", () => {
    const store = new InMemoryStore();
    for (const hour of [-1, 24, 6.5]) expect(() => createBriefRunner({ store, organizationId: ORG, timeZone: TZ, hour, build: async () => ({}) as DailyBrief })).toThrow(/whole hour/);
    expect(() => createBriefRunner({ store, organizationId: ORG, timeZone: TZ, hour: 0, build: async () => ({}) as DailyBrief })).not.toThrow();
    expect(() => createBriefRunner({ store, organizationId: ORG, timeZone: TZ, hour: 23, build: async () => ({}) as DailyBrief })).not.toThrow();
  });
});

describe("webhookDelivery", () => {
  const brief = { date: "2026-11-18" } as DailyBrief;

  it("posts the brief as JSON to an https address, with a timeout and no redirects", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: URL, init: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await webhookDelivery("https://hooks.example.test/brief/abc", fetcher)(brief);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.example.test/brief/abc");
    expect(calls[0]!.init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" }, redirect: "error" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ type: "karatos.daily_brief", brief: { date: "2026-11-18" } });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(BRIEF_WEBHOOK_TIMEOUT_MS).toBe(10_000);
  });

  it("refuses a plain http address and reports a refusal by status only", async () => {
    expect(() => webhookDelivery("http://hooks.example.test/brief")).toThrow("BRIEF_WEBHOOK_URL must be an https URL");
    const fetcher = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const failure = webhookDelivery("https://hooks.example.test/brief/token123", fetcher)(brief);
    await expect(failure).rejects.toThrow("the brief webhook answered 500");
    await expect(failure).rejects.not.toThrow(/token123/);
  });

  it("gives up on a receiver slower than the timeout", async () => {
    const fetcher = ((_url: URL, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(webhookDelivery("https://hooks.example.test/brief", fetcher, 5)(brief)).rejects.toThrow(/timeout|aborted/i);
  });
});

describe("GET /v1/brief", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function start(withBrief = true) {
    const b = brain();
    await b.sale("shopify", "2026-11-18T15:00:00Z", 12_345, "online");
    server = createServer(
      createBrainApp({
        pipeline: b.pipeline,
        memory: b.memory,
        organizationId: ORG,
        apiKey: INSTANCE_KEY,
        supportApiKey: SUPPORT_KEY,
        ...(withBrief
          ? { brief: { timeZone: TZ, now: () => new Date("2026-11-19T03:00:00Z"), sync: () => ({ scheduled: ["shopify"], statuses: [{ id: "shopify", outcome: "succeeded" as const, finishedAt: "2026-11-19T02:00:00.000Z" }], skipped: [] }) } }
          : {}),
      }),
    );
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    return { memory: b.memory, get: (path: string, key: string | null = INSTANCE_KEY) => fetch(base + path, key ? { headers: { authorization: `Bearer ${key}` } } : {}) };
  }

  it("answers the instance key with the brief for the day asked, read-only", async () => {
    const { get, memory } = await start();
    const before = { events: memory.events.length, recs: memory.recommendations.length, runs: memory.reasoningRuns.length };
    const res = await get("/v1/brief?date=2026-11-18");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { brief } = (await res.json()) as { brief: DailyBrief };
    expect(brief.date).toBe("2026-11-18");
    expect(brief.timeZone).toBe(TZ);
    expect(salesOf(brief).day.totals).toMatchObject({ sales: 1, grossCents: 12_345, saleEvents: { eventIds: ["evt_shopify_1"], systems: ["shopify"] } });
    expect(brief.sync).toMatchObject({ known: true, healthy: ["shopify"], problems: [] });
    expect({ events: memory.events.length, recs: memory.recommendations.length, runs: memory.reasoningRuns.length }).toEqual(before);
    expect(memory.briefs.size).toBe(0);
  });

  it("covers yesterday on the store's calendar when no date is given", async () => {
    const { get } = await start();
    // 03:00 UTC on the 19th is still the 18th in New York, so yesterday is the 17th.
    const { brief } = (await (await get("/v1/brief")).json()) as { brief: DailyBrief };
    expect(brief.date).toBe("2026-11-17");
    expect(brief.generatedAt).toBe("2026-11-19T03:00:00.000Z");
  });

  it("allows today so far, and refuses days that aren't real or haven't started in the store", async () => {
    const { get } = await start();
    expect((await get("/v1/brief?date=2026-11-18")).status).toBe(200);
    for (const date of ["2026-11-19", "2026-02-30", "18-11-2026", ""]) {
      const res = await get(`/v1/brief?date=${date}`);
      expect(res.status, date).toBe(400);
    }
    expect(await (await get("/v1/brief?date=2026-11-19")).json()).toEqual({ error: "date can't be after today in the store's time zone" });
    expect(await (await get("/v1/brief?date=nope")).json()).toEqual({ error: "date must be a day, such as 2026-11-18" });
  });

  it("needs the instance key: none or a wrong one is 401, the support key is 403", async () => {
    const { get } = await start();
    expect((await get("/v1/brief?date=2026-11-18", null)).status).toBe(401);
    expect((await get("/v1/brief?date=2026-11-18", newKey("x"))).status).toBe(401);
    const support = await get("/v1/brief?date=2026-11-18", SUPPORT_KEY);
    expect(support.status).toBe(403);
    const body = await support.text();
    expect(body).not.toContain("12345");
    expect(body).not.toContain("evt_shopify_1");
  });

  it("only answers GET", async () => {
    const { get } = await start();
    void get;
    const res = await fetch(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/brief`, { method: "POST", headers: { authorization: `Bearer ${INSTANCE_KEY}` } });
    expect(res.status).toBe(405);
  });

  it("uses the instance's time zone for yesterday and for the day's edges", async () => {
    const b = brain();
    await b.sale("shopify", "2026-11-18T19:00:00Z", 500); // 00:30 on the 19th in Kolkata
    server = createServer(createBrainApp({ pipeline: b.pipeline, memory: b.memory, organizationId: ORG, apiKey: INSTANCE_KEY, brief: { timeZone: "Asia/Kolkata", now: () => new Date("2026-11-19T03:00:00Z") } }));
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const read = async (q: string) => ((await (await fetch(`${base}/v1/brief${q}`, { headers: { authorization: `Bearer ${INSTANCE_KEY}` } })).json()) as { brief: DailyBrief }).brief;
    const yesterday = await read("");
    expect(yesterday.date).toBe("2026-11-18");
    expect(yesterday.timeZone).toBe("Asia/Kolkata");
    expect(salesOf(await read("?date=2026-11-19")).day.totals.sales).toBe(1);
    // In New York that sale is on the 18th; in Kolkata the 18th has none and nothing came before it.
    expect((await read("?date=2026-11-18")).sales.status).toBe("no_data");
  });

  it("defaults to New York days and no sync results without brief options", async () => {
    const { get } = await start(false);
    const { brief } = (await (await get("/v1/brief?date=2026-11-18")).json()) as { brief: DailyBrief };
    expect(brief.timeZone).toBe("America/New_York");
    expect(brief.sync).toEqual({ known: false, note: "Sync results aren't available to this brief." });
  });
});
