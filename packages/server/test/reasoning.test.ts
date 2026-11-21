import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync, type Connector, type Reasoner, type SourceBatch } from "@karatos/core";
import {
  createBriefRunner,
  createReasoningRunner,
  createSyncRunner,
  inMemoryDiagnostics,
  loadInstanceConfig,
  REASON_BRIEF_REUSE_MS,
  REASONING_OFF,
  reasonNow,
  readDailyBrief,
  StaticDocumentationSource,
  supportStatus,
  type ReasoningRunnerOptions,
  type SyncRunOutcome,
} from "../src/index.js";

const ORG = "example-jewelers";
const START = Date.parse("2026-11-20T10:00:00.000Z");
const MINUTE = 60_000;

/** A clock and timers the test moves by hand. */
function clock() {
  let at = START;
  const timers = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  return {
    now: () => new Date(at),
    advance: (ms: number) => void (at += ms),
    timers,
    setTimer: (run: () => void, ms: number) => {
      timers.set(++next, { run, ms });
      return next;
    },
    clearTimer: (timer: unknown) => void timers.delete(timer as number),
    pending: () => [...timers.values()].map((t) => t.ms),
    /** Fires the only pending timer. */
    fire: () => {
      expect(timers.size).toBe(1);
      const [[id, timer]] = [...timers.entries()] as [[number, { run: () => void; ms: number }]];
      timers.delete(id);
      at += timer.ms;
      timer.run();
    },
  };
}

/** A reasoning pass the test finishes by hand, recording how many run at once. */
function controlled() {
  const waiting: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  const stats = { calls: 0, active: 0, maxActive: 0 };
  const reason = () => {
    stats.calls++;
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    return new Promise<{ recommendations: number; measured: number }>((resolve, reject) => {
      waiting.push({
        resolve: () => {
          stats.active--;
          resolve({ recommendations: 3, measured: 1 });
        },
        reject: (error) => {
          stats.active--;
          reject(error);
        },
      });
    });
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { reason, waiting, stats, flush };
}

function runner(extra: Partial<ReasoningRunnerOptions> = {}) {
  const c = clock();
  const lines: string[] = [];
  const counts = { calls: 0 };
  const r = createReasoningRunner({
    reason: async () => {
      counts.calls++;
      return { recommendations: 2, measured: 0 };
    },
    intervalMs: 60 * MINUTE,
    log: (l) => lines.push(l),
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    ...extra,
  });
  return { r, c, lines, counts };
}

const outcome = (ingested: number, error?: string): SyncRunOutcome => ({
  id: "shopify",
  mode: "incremental",
  ...(error ? { error } : { report: { ingested, duplicates: 0, deadLettered: 0, batches: 1, cursor: null } }),
});

describe("reasonNow", () => {
  it("does what POST /v1/reason does: the department rules, then results now due", async () => {
    const memory = new InMemoryStore();
    const reasoner: Reasoner = {
      name: "one",
      reason: ({ organizationId, now }) => [
        { id: "rec_x_1", organizationId, summary: "s", confidence: 0.5, expectedImpact: "e", provenance: { eventIds: [], signalIds: [], documentIds: [] }, degraded: false, createdAt: now },
      ],
    };
    const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [reasoner], documentation: new StaticDocumentationSource(["doc_a"]) });
    const run = await reasonNow(pipeline, memory, ORG, () => new Date(START));
    expect(run.recommendations.map((r) => r.id)).toEqual(["rec_x_1"]);
    expect(run.measured).toBe(0);
    expect((await memory.listRecommendations(ORG, 10)).map((r) => r.id)).toEqual(["rec_x_1"]);
  });
});

describe("createReasoningRunner: triggers", () => {
  it("reasons after a sync round that brought new events, and not after an empty or failed one", async () => {
    const { r, counts, lines } = runner();
    expect(r.afterSync([outcome(0), outcome(0, "Error: vendor down")])).toBeNull();
    expect(r.afterSync([])).toBeNull();
    expect(counts.calls).toBe(0);
    const run = await r.afterSync([outcome(0), outcome(1)]);
    expect(run).toMatchObject({ trigger: "sync", outcome: "succeeded", recommendations: 2, measured: 0, error: null });
    expect(counts.calls).toBe(1);
    expect(lines).toEqual(["reasoning (sync): 2 recommendations, 0 results measured"]);
  });

  it("is told by the sync runner after each round", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [], documentation: new StaticDocumentationSource([]) });
    const event = { id: "evt_1", type: "order.created", occurredAt: "2026-11-01T12:00:00Z", receivedAt: "2026-11-01T12:00:01Z", idempotencyKey: "order-1", payload: { orderId: "1" } };
    // Each round sends the same event, so only the first brings anything new.
    const connector: Connector = {
      source: "shopify",
      async *historicalImport(): AsyncIterable<SourceBatch> {
        yield { events: [event], cursor: "h1" };
      },
      async *incrementalSync(): AsyncIterable<SourceBatch> {
        yield { events: [event], cursor: "i1" };
      },
    };
    const { r, counts } = runner();
    const seen: number[] = [];
    const sync = createSyncRunner({
      connectors: [{ id: "shopify", make: async () => connector }],
      pipeline,
      memory,
      organizationId: ORG,
      intervalMs: MINUTE,
      log: () => {},
      sync: (options) => runSync({ ...options, sleep: async () => {} }),
      afterRound: (outcomes) => {
        seen.push(outcomes.length);
        void r.afterSync(outcomes);
      },
    });
    await sync.runOnce();
    await new Promise((res) => setTimeout(res, 0));
    expect(counts.calls).toBe(1);
    await sync.runOnce();
    await new Promise((res) => setTimeout(res, 0));
    expect(counts.calls).toBe(1);
    expect(seen).toEqual([1, 1]);
  });

  it("falls back to the interval, which restarts whenever any run ends", async () => {
    const { r, c, counts } = runner();
    expect(c.pending()).toEqual([]);
    r.start();
    r.start();
    expect(c.pending()).toEqual([60 * MINUTE]);
    c.fire();
    await new Promise((res) => setTimeout(res, 0));
    expect(counts.calls).toBe(1);
    expect(r.latest()).toMatchObject({ trigger: "interval", outcome: "succeeded", startedAt: "2026-11-20T11:00:00.000Z" });
    expect(c.pending()).toEqual([60 * MINUTE]);
    // A sync-triggered run replaces the waiting interval with a fresh one from its end.
    const before = [...c.timers.keys()];
    c.advance(20 * MINUTE);
    await r.trigger("sync");
    expect(c.pending()).toEqual([60 * MINUTE]);
    expect([...c.timers.keys()]).not.toEqual(before);
    expect(counts.calls).toBe(2);
  });

  it("leaves the interval to a run in progress when started during it", async () => {
    const k = controlled();
    const { r, c } = runner({ reason: k.reason });
    const first = r.trigger("sync");
    r.start();
    expect(c.pending()).toEqual([]);
    k.waiting[0]!.resolve();
    await first;
    expect(c.pending()).toEqual([60 * MINUTE]);
  });

  it("fires no interval run while a run is in progress", async () => {
    const k = controlled();
    const { r, c } = runner({ reason: k.reason });
    r.start();
    const first = r.trigger("sync");
    expect(c.pending()).toEqual([]);
    k.waiting[0]!.resolve();
    await first;
    expect(c.pending()).toEqual([60 * MINUTE]);
  });

  it("rejects an interval that isn't a positive number", () => {
    for (const intervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => runner({ intervalMs }), String(intervalMs)).toThrow(/positive/);
    expect(() => runner({ intervalMs: 1 })).not.toThrow();
  });
});

describe("createReasoningRunner: no overlap", () => {
  it("never runs twice at once: triggers during a run queue one more run, which they all share", async () => {
    const k = controlled();
    const { r } = runner({ reason: k.reason });
    const first = r.trigger("sync");
    const second = r.trigger("sync");
    const third = r.trigger("interval");
    const fourth = r.trigger("brief");
    expect(k.stats.calls).toBe(1);
    k.waiting[0]!.resolve();
    expect(await first).toMatchObject({ trigger: "sync", outcome: "succeeded" });
    await k.flush();
    expect(k.stats.calls).toBe(2);
    // A trigger during the queued run queues the next one.
    const fifth = r.trigger("sync");
    k.waiting[1]!.resolve();
    const [a, b, c] = await Promise.all([second, third, fourth]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toMatchObject({ trigger: "sync" });
    expect(a).not.toBe(await first);
    await k.flush();
    k.waiting[2]!.resolve();
    expect(await fifth).toMatchObject({ trigger: "sync" });
    expect(k.stats).toMatchObject({ calls: 3, maxActive: 1 });
  });

  it("holds under many concurrent triggers", async () => {
    const k = controlled();
    const { r } = runner({ reason: k.reason });
    const all = Array.from({ length: 50 }, (_, i) => r.trigger(i % 2 ? "sync" : "interval"));
    for (let i = 0; i < 2; i++) {
      await k.flush();
      k.waiting[i]!.resolve();
    }
    const runs = await Promise.all(all);
    expect(new Set(runs).size).toBe(2);
    expect(k.stats).toMatchObject({ calls: 2, maxActive: 1 });
  });
});

describe("createReasoningRunner: failures", () => {
  it("logs a failed run with its error's name and counts only, and tries again at the next trigger", async () => {
    let fail = 2;
    const { r, c, lines } = runner({
      reason: async () => {
        if (fail-- > 0) throw new TypeError("customer zephyrine@example.test owes $123.45");
        return { recommendations: 4, measured: 2 };
      },
    });
    r.start();
    c.fire();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.latest()).toEqual({ trigger: "interval", outcome: "failed", startedAt: "2026-11-20T11:00:00.000Z", finishedAt: "2026-11-20T11:00:00.000Z", recommendations: null, measured: null, error: "TypeError" });
    expect(r.supportStatus()).toMatchObject({ consecutiveFailures: 1, lastSucceededAt: null });
    // Retried at the next trigger, which is the interval when nothing else comes.
    expect(c.pending()).toEqual([60 * MINUTE]);
    expect(await r.trigger("sync")).toMatchObject({ outcome: "failed" });
    expect(r.supportStatus().consecutiveFailures).toBe(2);
    expect(r.status()).toEqual({ scheduled: true, last: { outcome: "failed", finishedAt: "2026-11-20T11:00:00.000Z" }, refreshedAt: null });
    c.advance(5 * MINUTE);
    expect(await r.trigger("sync")).toMatchObject({ outcome: "succeeded", recommendations: 4, measured: 2, error: null });
    expect(r.supportStatus()).toMatchObject({ consecutiveFailures: 0, lastSucceededAt: "2026-11-20T11:05:00.000Z" });
    expect(lines).toEqual([
      "reasoning (interval) failed: TypeError, 1 failed in a row; tried again at the next trigger",
      "reasoning (sync) failed: TypeError, 2 failed in a row; tried again at the next trigger",
      "reasoning (sync): 4 recommendations, 2 results measured",
    ]);
    expect(lines.join("\n")).not.toMatch(/example\.test|123/);
  });

  it("keeps the last refresh when a later run fails", async () => {
    let fail = false;
    const { r, c } = runner({
      reason: async () => {
        if (fail) throw new Error("x");
        return { recommendations: 0, measured: 0 };
      },
    });
    await r.trigger("sync");
    fail = true;
    c.advance(MINUTE);
    await r.trigger("sync");
    expect(r.status()).toEqual({ scheduled: true, last: { outcome: "failed", finishedAt: "2026-11-20T10:01:00.000Z" }, refreshedAt: "2026-11-20T10:00:00.000Z" });
  });

  it("names a thrown non-error, or an error with an odd name, plainly", async () => {
    const thrown: unknown[] = ["secret text", Object.assign(new Error("m"), { name: "bad name with spaces" }), Object.assign(new Error("m"), { name: "" })];
    for (const value of thrown) {
      const { r, lines } = runner({ reason: () => Promise.reject(value) });
      expect(await r.trigger("sync")).toMatchObject({ error: "UnknownError" });
      expect(lines[0]).toBe("reasoning (sync) failed: UnknownError, 1 failed in a row; tried again at the next trigger");
    }
    const { r } = runner({ reason: () => Promise.reject(Object.assign(new Error("m"), { name: "PgError.timeout_1" })) });
    expect(await r.trigger("sync")).toMatchObject({ error: "PgError.timeout_1" });
  });
});

describe("createReasoningRunner: stopping", () => {
  it("clears the interval, waits for a run in progress, drops a queued one and ignores later triggers", async () => {
    const k = controlled();
    const { r, c } = runner({ reason: k.reason });
    r.start();
    const first = r.trigger("sync");
    const queued = r.trigger("sync");
    const stopping = r.stop();
    let stopped = false;
    void stopping.then(() => (stopped = true));
    await k.flush();
    expect(stopped).toBe(false);
    k.waiting[0]!.resolve();
    await stopping;
    expect(await first).toMatchObject({ outcome: "succeeded" });
    // The queued trigger is answered with the run that just ended, never run.
    expect(await queued).toBe(await first);
    expect(k.stats.calls).toBe(1);
    expect(c.pending()).toEqual([]);
    expect(await r.trigger("interval")).toBeNull();
    expect(r.afterSync([outcome(5)])).not.toBeNull();
    expect(await r.beforeBrief()).toBe(await first);
    r.start();
    expect(c.pending()).toEqual([]);
    expect(k.stats.calls).toBe(1);
  });

  it("sets no new interval when a run in progress ends after the stop", async () => {
    const k = controlled();
    const { r, c } = runner({ reason: k.reason });
    r.start();
    const first = r.trigger("sync");
    const stopping = r.stop();
    k.waiting[0]!.resolve();
    await stopping;
    expect(await first).toMatchObject({ outcome: "succeeded" });
    expect(c.pending()).toEqual([]);
  });

  it("clears a waiting interval timer", async () => {
    const { r, c, counts } = runner();
    r.start();
    expect(c.pending()).toHaveLength(1);
    await r.stop();
    expect(c.pending()).toEqual([]);
    expect(counts.calls).toBe(0);
  });
});

describe("createReasoningRunner: before the daily brief", () => {
  it("reasons now when there's no recent run, and reuses one that just succeeded", async () => {
    expect(REASON_BRIEF_REUSE_MS).toBe(10 * MINUTE);
    const { r, c, counts } = runner();
    expect(await r.beforeBrief()).toMatchObject({ trigger: "brief", outcome: "succeeded" });
    expect(counts.calls).toBe(1);
    c.advance(REASON_BRIEF_REUSE_MS);
    expect(await r.beforeBrief()).toMatchObject({ trigger: "brief" });
    expect(counts.calls).toBe(1);
    c.advance(1);
    await r.beforeBrief();
    expect(counts.calls).toBe(2);
  });

  it("reasons again after a failed run, however recent", async () => {
    let fail = true;
    const { r, counts } = runner({
      reason: async () => {
        counts.calls++;
        if (fail) throw new Error("x");
        return { recommendations: 0, measured: 0 };
      },
    });
    await r.trigger("sync");
    fail = false;
    expect(await r.beforeBrief()).toMatchObject({ trigger: "brief", outcome: "succeeded" });
    expect(counts.calls).toBe(2);
  });

  it("waits for a run in progress, and for one queued after it, instead of starting another", async () => {
    const k = controlled();
    const { r } = runner({ reason: k.reason });
    const first = r.trigger("sync");
    const brief = r.beforeBrief();
    k.waiting[0]!.resolve();
    expect(await brief).toBe(await first);
    expect(k.stats.calls).toBe(1);

    const running = r.trigger("interval");
    const queued = r.trigger("sync");
    const later = r.beforeBrief();
    k.waiting[1]!.resolve();
    await running;
    await k.flush();
    k.waiting[2]!.resolve();
    expect(await later).toBe(await queued);
    expect(k.stats).toMatchObject({ calls: 3, maxActive: 1 });
  });

  it("runs first in the brief runner, so the brief it builds reads the fresh findings", async () => {
    const order: string[] = [];
    const memory = new InMemoryStore();
    const c = clock();
    c.advance(3 * 3_600_000); // 08:00 in New York
    const r = createReasoningRunner({
      reason: async () => {
        order.push("reason");
        return { recommendations: 0, measured: 0 };
      },
      intervalMs: 60 * MINUTE,
      log: () => {},
      now: c.now,
    });
    const sync = () => ({ scheduled: [], statuses: [], skipped: [], reasoning: r.status() });
    const brief = createBriefRunner({
      store: memory,
      organizationId: ORG,
      timeZone: "America/New_York",
      hour: 7,
      beforeBuild: () => (order.push("before"), r.beforeBrief()),
      build: (date) => (order.push("build"), readDailyBrief({ memory, organizationId: ORG, timeZone: "America/New_York", now: c.now, sync }, date)),
      log: () => {},
      now: c.now,
    });
    const result = await brief.runOnce();
    expect(order).toEqual(["before", "reason", "build"]);
    expect(result.outcome === "built" && result.brief.sync).toMatchObject({ known: true, reasoning: { status: "fresh", refreshedAt: "2026-11-20T13:00:00.000Z" } });
    // Already built: nothing is reasoned again.
    expect((await brief.runOnce()).outcome).toBe("already_built");
    expect(order).toEqual(["before", "reason", "build"]);
  });

  it("builds the brief anyway when its first step throws, and skips it when the brief isn't due", async () => {
    const memory = new InMemoryStore();
    const lines: string[] = [];
    let before = 0;
    const make = (at: string) =>
      createBriefRunner({
        store: memory,
        organizationId: ORG,
        timeZone: "America/New_York",
        hour: 7,
        beforeBuild: async () => {
          before++;
          throw new Error("reasoning unavailable");
        },
        build: (date) => readDailyBrief({ memory, organizationId: ORG, timeZone: "America/New_York", now: () => new Date(at) }, date),
        log: (l) => lines.push(l),
        now: () => new Date(at),
      });
    expect((await make("2026-11-20T11:00:00.000Z").runOnce()).outcome).toBe("not_due");
    expect(before).toBe(0);
    expect((await make("2026-11-20T13:00:00.000Z").runOnce()).outcome).toBe("built");
    expect(before).toBe(1);
    expect(lines[0]).toBe("brief 2026-11-19 went ahead without its first step: Error: reasoning unavailable");
  });
});

describe("scheduled reasoning on the support status", () => {
  const base = {
    instanceName: "Example Jewelers",
    version: "0.1.0",
    startedAt: new Date(START),
    retentionDays: 30,
    departments: ["finance"],
    enabledIntegrations: [],
    now: () => new Date(START),
  };

  it("shows the last run as times, outcome and counts", async () => {
    const memory = new InMemoryStore();
    const { r } = runner();
    const status = () => supportStatus(ORG, { ...base, diagnostics: inMemoryDiagnostics(memory), reasoning: () => r.supportStatus() }, []);
    expect((await status()).reasoning).toEqual({ scheduled: true, intervalMinutes: 60, lastRun: null, lastSucceededAt: null, consecutiveFailures: 0 });
    await r.trigger("sync");
    expect((await status()).reasoning).toEqual({
      scheduled: true,
      intervalMinutes: 60,
      lastRun: { trigger: "sync", outcome: "succeeded", startedAt: "2026-11-20T10:00:00.000Z", finishedAt: "2026-11-20T10:00:00.000Z", recommendations: 2, measured: 0, error: null },
      lastSucceededAt: "2026-11-20T10:00:00.000Z",
      consecutiveFailures: 0,
    });
    // A copy, so a caller can't change the runner's record.
    r.supportStatus().lastRun!.outcome = "failed";
    expect(r.latest()!.outcome).toBe("succeeded");
  });

  it("says so when scheduled reasoning is off, and null when it isn't reported", async () => {
    const memory = new InMemoryStore();
    expect((await supportStatus(ORG, { ...base, diagnostics: inMemoryDiagnostics(memory), reasoning: () => REASONING_OFF.support }, [])).reasoning).toEqual({
      scheduled: false,
      intervalMinutes: null,
      lastRun: null,
      lastSucceededAt: null,
      consecutiveFailures: 0,
    });
    expect((await supportStatus(ORG, { ...base, diagnostics: inMemoryDiagnostics(memory) }, [])).reasoning).toBeNull();
    expect(REASONING_OFF.brief).toEqual({ scheduled: false, last: null, refreshedAt: null });
  });
});

describe("scheduled reasoning settings", () => {
  const valid = {
    INSTANCE_NAME: "Example Jewelers",
    ORGANIZATION_ID: "example-jewelers",
    INSTANCE_API_KEY: "a".repeat(64),
    SUPABASE_DB_URL: "postgresql://user:pass@db.example.test:5432/postgres",
  };

  it("is on, every 60 minutes, by default", () => {
    expect(loadInstanceConfig(valid)).toMatchObject({ REASON_SCHEDULE: true, REASON_INTERVAL_MINUTES: 60 });
    expect(loadInstanceConfig({ ...valid, REASON_SCHEDULE: "", REASON_INTERVAL_MINUTES: "" })).toMatchObject({ REASON_SCHEDULE: true, REASON_INTERVAL_MINUTES: 60 });
  });

  it("turns off with REASON_SCHEDULE=off and takes an interval of 5 to 1440 whole minutes", () => {
    expect(loadInstanceConfig({ ...valid, REASON_SCHEDULE: "off" }).REASON_SCHEDULE).toBe(false);
    expect(loadInstanceConfig({ ...valid, REASON_SCHEDULE: "on" }).REASON_SCHEDULE).toBe(true);
    for (const value of ["false", "OFF", "no", "0"]) expect(() => loadInstanceConfig({ ...valid, REASON_SCHEDULE: value }), value).toThrow(/REASON_SCHEDULE/);
    expect(loadInstanceConfig({ ...valid, REASON_INTERVAL_MINUTES: "5" }).REASON_INTERVAL_MINUTES).toBe(5);
    expect(loadInstanceConfig({ ...valid, REASON_INTERVAL_MINUTES: "1440" }).REASON_INTERVAL_MINUTES).toBe(1440);
    for (const value of ["4", "1441", "30.5", "hourly", "-60"]) expect(() => loadInstanceConfig({ ...valid, REASON_INTERVAL_MINUTES: value }), value).toThrow(/REASON_INTERVAL_MINUTES/);
  });
});
