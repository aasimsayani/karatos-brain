import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, type MemoryStore, type Reasoner, type ReasoningRun as StoredReasoningRun } from "@karatos/core";
import { loadMigrations, migrate, PostgresMemoryStore, type SqlClient } from "@karatos/store-postgres";
import {
  createBrainApp,
  createReasoningRunner,
  inMemoryDiagnostics,
  readLastRun,
  reasonNow,
  StaticDocumentationSource,
  type BrainAppOptions,
  type ReasoningRun,
  type ReasoningRunnerOptions,
} from "../src/index.js";

const ORG = "example-jewelers";
const KEY = "k".repeat(40);

const reasoner: Reasoner = {
  name: "one",
  reason: ({ organizationId }) => [
    {
      id: "rec_manual_1",
      organizationId,
      summary: "Check the payout",
      confidence: 0.5,
      expectedImpact: "Cash",
      provenance: { eventIds: [], signalIds: [], documentIds: [] },
      degraded: false,
      createdAt: "2026-11-20T10:00:00.000Z",
    },
  ],
};

/** What POST /v1/reason answered before manual runs were recorded. */
const EXPECTED_BODY = {
  recommendations: [
    {
      id: "rec_manual_1",
      organizationId: ORG,
      summary: "Check the payout",
      confidence: 0.5,
      expectedImpact: "Cash",
      provenance: { eventIds: [], signalIds: [], documentIds: ["doc_a"] },
      degraded: false,
      createdAt: "2026-11-20T10:00:00.000Z",
      // Since the feedback loop: the rule that raised it, and why it ranks as it does.
      rule: "one",
      ranking: { baseConfidence: 0.5, factor: 1, note: "No decisions on this rule in the last 180 days." },
    },
  ],
  measured: 0,
  heldBack: [],
};

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function start(extra: (pipeline: BrainPipeline, memory: InMemoryStore) => Partial<BrainAppOptions> = () => ({}), reasoners: Reasoner[] = [reasoner]) {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners, documentation: new StaticDocumentationSource(["doc_a"]) });
  server = createServer(createBrainApp({ pipeline, memory, organizationId: ORG, apiKey: KEY, ...extra(pipeline, memory) }));
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const post = (path: string) => fetch(base + path, { method: "POST", body: "{}", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` } });
  const get = (path: string) => fetch(base + path, { headers: { authorization: `Bearer ${KEY}` } });
  return { memory, pipeline, post, get };
}

describe("POST /v1/reason: the response", () => {
  it("answers 200 with the run's recommendations and results measured", async () => {
    const { post } = await start();
    const res = await post("/v1/reason");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual(EXPECTED_BODY);
  });
});

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
    setTimer: (run: () => void, ms: number) => {
      timers.set(++next, { run, ms });
      return next;
    },
    clearTimer: (timer: unknown) => void timers.delete(timer as number),
    pending: () => [...timers.values()].map((t) => t.ms),
  };
}

/** Passes the test finishes by hand, scheduled and manual alike, recording how many run at once and in what order. */
function passes() {
  const waiting: { label: string; resolve: () => void; reject: (error: unknown) => void }[] = [];
  const stats = { calls: 0, active: 0, maxActive: 0 };
  const order: string[] = [];
  const pass = <T>(label: string, value: T) => () => {
    stats.calls++;
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    order.push(label);
    return new Promise<T>((resolve, reject) => {
      waiting.push({
        label,
        resolve: () => {
          stats.active--;
          resolve(value);
        },
        reject: (error) => {
          stats.active--;
          reject(error);
        },
      });
    });
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  /** Finishes the only pass in progress. */
  const finish = (label: string) => {
    const open = waiting.filter((w) => w.label !== "done");
    expect(stats.active).toBe(1);
    const w = open.at(-1)!;
    expect(w.label).toBe(label);
    w.label = "done";
    w.resolve();
  };
  return { pass, waiting, stats, order, flush, finish };
}

function runner(extra: Partial<ReasoningRunnerOptions> = {}) {
  const c = clock();
  const lines: string[] = [];
  const r = createReasoningRunner({
    reason: async () => ({ recommendations: 2, measured: 0 }),
    intervalMs: 60 * MINUTE,
    log: (l) => lines.push(l),
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    ...extra,
  });
  return { r, c, lines };
}

const manualValue = (n: number, measured = 1) => ({ recommendations: Array.from({ length: n }, (_, i) => ({ id: `rec_m_${i}` })), measured });

describe("manual runs: recorded like scheduled ones", () => {
  it("records a manual run with trigger manual and answers with the pass's own value", async () => {
    const { r, c, lines } = runner();
    const value = manualValue(3);
    c.advance(5 * MINUTE);
    expect(await r.manual(async () => value)).toBe(value);
    const run: ReasoningRun = { trigger: "manual", outcome: "succeeded", startedAt: "2026-11-20T10:05:00.000Z", finishedAt: "2026-11-20T10:05:00.000Z", recommendations: 3, measured: 1, error: null };
    expect(r.latest()).toEqual(run);
    expect(r.supportStatus()).toEqual({ scheduled: true, intervalMinutes: 60, lastRun: run, lastSucceededAt: "2026-11-20T10:05:00.000Z", consecutiveFailures: 0 });
    expect(r.status()).toEqual({ scheduled: true, last: { outcome: "succeeded", finishedAt: "2026-11-20T10:05:00.000Z" }, refreshedAt: "2026-11-20T10:05:00.000Z" });
    expect(lines).toEqual(["reasoning (manual): 3 recommendations, 1 results measured"]);
  });

  it("records a failed manual run, counts it as a failure in a row, and throws the pass's own error", async () => {
    const { r, lines } = runner();
    await r.manual(async () => manualValue(1));
    const error = new TypeError("customer zephyrine@example.test owes $123.45");
    await expect(r.manual(() => Promise.reject(error))).rejects.toBe(error);
    expect(r.supportStatus()).toMatchObject({
      lastRun: { trigger: "manual", outcome: "failed", recommendations: null, measured: null, error: "TypeError" },
      lastSucceededAt: "2026-11-20T10:00:00.000Z",
      consecutiveFailures: 1,
    });
    await expect(r.trigger("sync")).resolves.toMatchObject({ outcome: "succeeded" });
    expect(r.supportStatus().consecutiveFailures).toBe(0);
    expect(lines[1]).toBe("reasoning (manual) failed: TypeError, 1 failed in a row; tried again at the next trigger");
    expect(lines.join("\n")).not.toMatch(/example\.test|123/);
  });

  it("restarts the interval from the end of a manual run", async () => {
    const { r, c } = runner();
    r.start();
    expect(c.pending()).toEqual([60 * MINUTE]);
    await r.manual(async () => manualValue(0));
    expect(c.pending()).toEqual([60 * MINUTE]);
  });

  it("lets the daily brief reuse a manual run that just succeeded", async () => {
    let scheduled = 0;
    const { r } = runner({ reason: async () => (scheduled++, { recommendations: 0, measured: 0 }) });
    await r.manual(async () => manualValue(1));
    expect(await r.beforeBrief()).toMatchObject({ trigger: "manual" });
    expect(scheduled).toBe(0);
  });
});

describe("manual runs: never beside another run", () => {
  it("waits for a scheduled run in progress, then runs its own pass and answers with its own result", async () => {
    const k = passes();
    const { r } = runner({ reason: k.pass("scheduled", { recommendations: 7, measured: 0 }) });
    const scheduled = r.trigger("sync");
    const mine = manualValue(2);
    const manual = r.manual(k.pass("manual", mine));
    await k.flush();
    // The manual pass hasn't started while the scheduled one runs.
    expect(k.order).toEqual(["scheduled"]);
    k.finish("scheduled");
    expect(await scheduled).toMatchObject({ trigger: "sync", recommendations: 7 });
    await k.flush();
    expect(k.order).toEqual(["scheduled", "manual"]);
    k.finish("manual");
    expect(await manual).toBe(mine);
    expect(r.latest()).toMatchObject({ trigger: "manual", recommendations: 2, measured: 1 });
    expect(k.stats).toMatchObject({ calls: 2, maxActive: 1 });
  });

  it("goes before a queued scheduled run, which still runs after it", async () => {
    const k = passes();
    const { r } = runner({ reason: k.pass("scheduled", { recommendations: 1, measured: 0 }) });
    const first = r.trigger("sync");
    const queued = r.trigger("interval");
    const manual = r.manual(k.pass("manual", manualValue(4)));
    k.finish("scheduled");
    await first;
    await k.flush();
    k.finish("manual");
    expect((await manual).recommendations).toHaveLength(4);
    await k.flush();
    expect(k.order).toEqual(["scheduled", "manual", "scheduled"]);
    k.finish("scheduled");
    expect(await queued).toMatchObject({ trigger: "interval" });
    expect(k.stats).toMatchObject({ calls: 3, maxActive: 1 });
  });

  it("queues scheduled triggers behind a manual run in progress, and the brief waits for it", async () => {
    const k = passes();
    const { r, c } = runner({ reason: k.pass("scheduled", { recommendations: 1, measured: 0 }) });
    r.start();
    const manual = r.manual(k.pass("manual", manualValue(1)));
    // No interval run fires during it.
    expect(c.pending()).toEqual([]);
    const sync = r.trigger("sync");
    const brief = r.beforeBrief();
    await k.flush();
    expect(k.order).toEqual(["manual"]);
    k.finish("manual");
    await manual;
    await k.flush();
    k.finish("scheduled");
    expect(await sync).toMatchObject({ trigger: "sync" });
    expect(await brief).toBe(await sync);
    expect(k.stats).toMatchObject({ calls: 2, maxActive: 1 });
  });

  it("runs two manual calls one after the other, first come first served, each with its own result", async () => {
    const k = passes();
    const { r } = runner({ reason: k.pass("scheduled", { recommendations: 1, measured: 0 }) });
    const running = r.trigger("sync");
    const a = r.manual(k.pass("a", manualValue(1)));
    const b = r.manual(k.pass("b", manualValue(2)));
    k.finish("scheduled");
    await running;
    await k.flush();
    k.finish("a");
    await k.flush();
    k.finish("b");
    expect((await a).recommendations).toHaveLength(1);
    expect((await b).recommendations).toHaveLength(2);
    expect(k.order).toEqual(["scheduled", "a", "b"]);
    expect(k.stats.maxActive).toBe(1);
  });

  it("passes a waiting manual run's failure to its caller and carries on", async () => {
    const k = passes();
    const { r } = runner({ reason: k.pass("scheduled", { recommendations: 1, measured: 0 }) });
    const running = r.trigger("sync");
    const failing = r.manual(k.pass("manual", manualValue(1)));
    const caught = failing.catch((e: unknown) => e);
    k.finish("scheduled");
    await running;
    await k.flush();
    const error = new RangeError("x");
    k.waiting.at(-1)!.reject(error);
    expect(await caught).toBe(error);
    expect(r.latest()).toMatchObject({ trigger: "manual", outcome: "failed", error: "RangeError" });
  });

  it("still answers a manual call made after stop, setting no interval", async () => {
    const { r, c } = runner();
    r.start();
    await r.stop();
    expect((await r.manual(async () => manualValue(1))).measured).toBe(1);
    expect(r.latest()).toMatchObject({ trigger: "manual" });
    expect(c.pending()).toEqual([]);
  });

  it("drops a queued scheduled run after stop even when a manual run went first", async () => {
    const k = passes();
    const { r } = runner({ reason: k.pass("scheduled", { recommendations: 1, measured: 0 }) });
    const first = r.trigger("sync");
    const queued = r.trigger("sync");
    const manual = r.manual(k.pass("manual", manualValue(1)));
    const stopping = r.stop();
    k.finish("scheduled");
    await stopping;
    await k.flush();
    k.finish("manual");
    await manual;
    await k.flush();
    // The queued trigger is answered with the manual run that ended last, never run.
    expect(await queued).toMatchObject({ trigger: "manual" });
    expect(await first).toMatchObject({ trigger: "sync" });
    expect(k.order).toEqual(["scheduled", "manual"]);
  });
});

describe("manual runs with scheduled reasoning off", () => {
  it("records manual runs, sets no interval and says scheduled reasoning is off", async () => {
    const { r, c } = runner({ scheduled: false });
    r.start();
    expect(c.pending()).toEqual([]);
    expect(r.supportStatus()).toEqual({ scheduled: false, intervalMinutes: null, lastRun: null, lastSucceededAt: null, consecutiveFailures: 0 });
    await r.manual(async () => manualValue(2));
    expect(c.pending()).toEqual([]);
    expect(r.supportStatus()).toMatchObject({ scheduled: false, intervalMinutes: null, lastRun: { trigger: "manual", recommendations: 2 }, lastSucceededAt: "2026-11-20T10:00:00.000Z" });
    expect(r.status()).toEqual({ scheduled: false, last: { outcome: "succeeded", finishedAt: "2026-11-20T10:00:00.000Z" }, refreshedAt: "2026-11-20T10:00:00.000Z" });
  });
});

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));

function pgliteClient(db: PGlite): SqlClient {
  return {
    async query<T>(text: string, params?: unknown[]) {
      if (params === undefined || params.length === 0) {
        const results = await db.exec(text);
        return { rows: (results.at(-1)?.rows ?? []) as T[] };
      }
      return { rows: (await db.query<T>(text, params)).rows };
    },
  };
}

async function postgresStore(): Promise<PostgresMemoryStore> {
  const client = pgliteClient(new PGlite());
  await migrate(client, await loadMigrations(MIGRATIONS_DIR));
  await client.query("insert into organizations (id, name) values ($1, $2), ($3, $4)", [ORG, "Example Jewelers", "other-org", "Other"]);
  return new PostgresMemoryStore(client);
}

const storedRun = (id: string, finishedAt: string, recommendationIds: string[], organizationId = ORG): StoredReasoningRun => ({
  id,
  organizationId,
  startedAt: new Date(Date.parse(finishedAt) - 2_000).toISOString(),
  finishedAt,
  reasoners: ["one"],
  documentation: { documentIds: ["doc_a"], stale: false },
  degraded: true,
  recommendationIds,
});

describe.each([
  ["memory", async (): Promise<MemoryStore> => new InMemoryStore()],
  ["PGlite", postgresStore],
])("after a restart (%s store)", (_name, makeStore) => {
  it("reads nothing from an empty table, so reasoning reads not_run", async () => {
    const memory = await makeStore();
    expect(await memory.latestReasoningRun(ORG)).toBeNull();
    const lastRun = await readLastRun(memory, ORG);
    expect(lastRun).toBeNull();
    const { r } = runner({ lastRun });
    expect(r.supportStatus()).toEqual({ scheduled: true, intervalMinutes: 60, lastRun: null, lastSucceededAt: null, consecutiveFailures: 0 });
    expect(r.status()).toEqual({ scheduled: true, last: null, refreshedAt: null });
  });

  it.each([
    ["the higher id first", ["run_c", "run_a"]],
    ["the higher id last", ["run_a", "run_c"]],
  ])("reads the latest run of this organization: latest finish, then highest id (%s)", async (_order, tied) => {
    const memory = await makeStore();
    await memory.recordReasoningRun(storedRun("run_b", "2026-11-19T09:00:00.000Z", ["r1"]));
    for (const id of tied) await memory.recordReasoningRun(storedRun(id, "2026-11-19T11:00:00.000Z", id === "run_c" ? ["r1", "r2", "r3"] : ["r1"]));
    await memory.recordReasoningRun(storedRun("run_z", "2026-11-19T12:00:00.000Z", ["r9"], "other-org"));
    await memory.recordReasoningRun(storedRun("run_y", "2026-11-19T10:00:00.000Z", []));
    expect(await memory.latestReasoningRun(ORG)).toEqual(storedRun("run_c", "2026-11-19T11:00:00.000Z", ["r1", "r2", "r3"]));
    expect(await memory.latestReasoningRun("nobody")).toBeNull();
    // A copy: changing what was read doesn't change what is stored.
    const read = (await memory.latestReasoningRun(ORG))!;
    read.recommendationIds.push("r_extra");
    read.finishedAt = "2030-01-01T00:00:00.000Z";
    expect(await memory.latestReasoningRun(ORG)).toEqual(storedRun("run_c", "2026-11-19T11:00:00.000Z", ["r1", "r2", "r3"]));
    const lastRun = await readLastRun(memory, ORG);
    expect(lastRun).toEqual({ trigger: null, outcome: "succeeded", startedAt: "2026-11-19T10:59:58.000Z", finishedAt: "2026-11-19T11:00:00.000Z", recommendations: 3, measured: null, error: null });
  });

  it("starts the runner from the last run a pipeline recorded, until a new one finishes", async () => {
    const memory = await makeStore();
    const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [reasoner], documentation: new StaticDocumentationSource(["doc_a"]), now: () => new Date("2026-11-19T22:00:00.000Z") });
    await reasonNow(pipeline, memory, ORG);
    // A restart: a new runner over the same database.
    const lastRun = await readLastRun(memory, ORG);
    const { r } = runner({ lastRun });
    expect(r.supportStatus()).toEqual({
      scheduled: true,
      intervalMinutes: 60,
      lastRun: { trigger: null, outcome: "succeeded", startedAt: "2026-11-19T22:00:00.000Z", finishedAt: "2026-11-19T22:00:00.000Z", recommendations: 1, measured: null, error: null },
      lastSucceededAt: "2026-11-19T22:00:00.000Z",
      consecutiveFailures: 0,
    });
    expect(r.status()).toEqual({ scheduled: true, last: { outcome: "succeeded", finishedAt: "2026-11-19T22:00:00.000Z" }, refreshedAt: "2026-11-19T22:00:00.000Z" });
    // A copy, so changing the runner's record doesn't change the one passed in.
    r.supportStatus().lastRun!.outcome = "failed";
    expect(lastRun!.outcome).toBe("succeeded");
    expect(r.latest()!.outcome).toBe("succeeded");
    r.latest()!.recommendations = 99;
    expect(lastRun!.recommendations).toBe(1);
    await r.trigger("interval");
    expect(r.latest()).toMatchObject({ trigger: "interval", finishedAt: "2026-11-20T10:00:00.000Z" });
  });
});

describe("readLastRun", () => {
  it("counts a run that can't be read as none, logging the error's class name only", async () => {
    const memory = new InMemoryStore();
    memory.latestReasoningRun = () => Promise.reject(new TypeError("connection to db.example.test timed out"));
    const lines: string[] = [];
    expect(await readLastRun(memory, ORG, (l) => lines.push(l))).toBeNull();
    expect(lines).toEqual(["reasoning: the last run couldn't be read (TypeError), so none is reported until the next one"]);
  });

  it("starts a failed-state runner from nothing: a restored run is always one that succeeded", () => {
    const { r } = runner({ lastRun: { trigger: "sync", outcome: "failed", startedAt: "2026-11-19T09:00:00.000Z", finishedAt: "2026-11-19T09:00:01.000Z", recommendations: null, measured: null, error: "TypeError" } });
    expect(r.supportStatus()).toMatchObject({ lastRun: { outcome: "failed" }, lastSucceededAt: null, consecutiveFailures: 0 });
    expect(r.status()).toEqual({ scheduled: true, last: { outcome: "failed", finishedAt: "2026-11-19T09:00:01.000Z" }, refreshedAt: null });
  });
});

describe("POST /v1/reason through the runner", () => {
  /** An instance wired as main.ts wires it: POST /v1/reason runs through the runner, which the brief, ask and support status read. */
  function wired(scheduled = true) {
    let r!: ReturnType<typeof createReasoningRunner>;
    const lines: string[] = [];
    return {
      runner: () => r,
      lines,
      options: (pipeline: BrainPipeline, memory: InMemoryStore): Partial<BrainAppOptions> => {
        r = createReasoningRunner({
          reason: async () => {
            const run = await reasonNow(pipeline, memory, ORG);
            return { recommendations: run.recommendations.length, measured: run.measured };
          },
          intervalMs: 60 * MINUTE,
          scheduled,
          log: (l) => lines.push(l),
        });
        return {
          reason: (pass) => r.manual(pass),
          brief: { timeZone: "America/New_York", sync: () => ({ scheduled: ["shopify"], statuses: [{ id: "shopify", outcome: "succeeded", finishedAt: new Date().toISOString() }], skipped: [], reasoning: r.status() }) },
          support: {
            instanceName: "Example Jewelers",
            version: "0.1.0",
            startedAt: new Date(),
            retentionDays: 30,
            departments: [],
            enabledIntegrations: [],
            reasoning: () => r.supportStatus(),
            diagnostics: inMemoryDiagnostics(memory),
          },
        };
      },
    };
  }

  it("answers exactly as before", async () => {
    const w = wired();
    const { post } = await start(w.options);
    const res = await post("/v1/reason");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual(EXPECTED_BODY);
  });

  it("still answers 500 without the error's text when the pass fails, and records the failure", async () => {
    const failing: Reasoner = {
      name: "broken",
      reason: () => {
        throw new Error("database password is hunter2");
      },
    };
    const w = wired();
    const { post } = await start(w.options, [failing]);
    const original = console.error;
    console.error = () => {};
    try {
      const res = await post("/v1/reason");
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("hunter2");
    } finally {
      console.error = original;
    }
    expect(w.runner().latest()).toMatchObject({ trigger: "manual", outcome: "failed", error: "Error" });
    expect(w.lines.join("\n")).not.toContain("hunter2");
  });

  it("shows on support status, in the brief and in answers", async () => {
    const w = wired();
    const { post, get } = await start(w.options);
    expect(((await (await get("/v1/support/status")).json()) as { reasoning: unknown }).reasoning).toMatchObject({ lastRun: null });
    await post("/v1/reason");
    const finishedAt = w.runner().latest()!.finishedAt;
    const status = (await (await get("/v1/support/status")).json()) as { reasoning: unknown };
    expect(status.reasoning).toEqual({
      scheduled: true,
      intervalMinutes: 60,
      lastRun: { trigger: "manual", outcome: "succeeded", startedAt: expect.any(String), finishedAt, recommendations: 1, measured: 0, error: null },
      lastSucceededAt: finishedAt,
      consecutiveFailures: 0,
    });
    const { brief } = (await (await get("/v1/brief")).json()) as { brief: { text: string; sync: { reasoning: unknown } } };
    expect(brief.sync.reasoning).toEqual({ status: "fresh", refreshedAt: finishedAt, detail: `Findings were last refreshed at ${finishedAt}.` });
    expect(brief.text.endsWith(`Findings were last refreshed at ${finishedAt}.`)).toBe(true);
    const { answer } = (await (await get(`/v1/ask?q=${encodeURIComponent("is everything syncing?")}`)).json()) as { answer: { text: string } };
    expect(answer.text.endsWith(`Findings were last refreshed at ${finishedAt}.`)).toBe(true);
  });

  it("says when a manual call last succeeded when scheduled reasoning is off", async () => {
    const w = wired(false);
    const { post, get } = await start(w.options);
    await post("/v1/reason");
    const finishedAt = w.runner().latest()!.finishedAt;
    const { brief } = (await (await get("/v1/brief")).json()) as { brief: { text: string } };
    expect(brief.text.endsWith(`Scheduled reasoning is off on this instance, so findings are only as fresh as the last POST /v1/reason call; reasoning last succeeded at ${finishedAt}.`)).toBe(true);
    const status = (await (await get("/v1/support/status")).json()) as { reasoning: unknown };
    expect(status.reasoning).toMatchObject({ scheduled: false, intervalMinutes: null, lastRun: { trigger: "manual" } });
  });
});
