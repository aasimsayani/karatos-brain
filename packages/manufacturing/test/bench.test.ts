import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, type Recommendation, type Signal } from "@karatos/core";
import { combineDepartments, RETAIL_DEPARTMENTS, selectDepartments, type DepartmentModule } from "@karatos/retail";
import {
  bench,
  BENCH_STAGE_LIMIT_DAYS,
  benchDepartment,
  benchJobs,
  BenchSettingsError,
  MANUFACTURING_DEPARTMENTS,
  manufacturingDepartments,
  parseStageLimits,
  reworkTallies,
  typicalTimes,
} from "../src/index.js";

const ORG = "test-org";
const NOW = "2026-10-02T15:00:00.000Z";
let counter = 0;

/** A workshop with the retail departments and bench jobs, and helpers to feed it. */
function shop(departments: DepartmentModule[] = [...RETAIL_DEPARTMENTS, bench]) {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({
    memory,
    ...combineDepartments(departments),
    reasoningWindow: 5_000,
    documentation: { current: () => ({ documentIds: [], stale: false }) },
    now: () => new Date(NOW),
  });
  const send = (type: string, payload: Record<string, unknown>, occurredAt = "2026-09-01T12:00:00Z") => {
    counter++;
    return pipeline.ingest({ id: `evt_${counter}`, organizationId: ORG, source: "test", type, occurredAt, receivedAt: occurredAt, idempotencyKey: `k_${counter}`, payload });
  };
  return {
    memory,
    send,
    open: (jobId: string, fields: Record<string, unknown> = {}, at = "2026-09-01T12:00:00Z") => send("bench_job.opened", { jobId, ...fields }, at),
    stage: (jobId: string, stage: string, at: string, extra: Record<string, unknown> = {}) => send("bench_job.stage_recorded", { jobId, stage, ...extra }, at),
    signals: () => memory.recentSignals(ORG, 5_000),
    /** The bench department's recommendations whose key starts with one of `prefixes`, with the key each id carries. */
    async recs(...prefixes: string[]): Promise<(Recommendation & { key: string })[]> {
      const all = await pipeline.reason(ORG);
      return all
        .filter((r) => r.id.startsWith("rec_bench_"))
        .map((r) => ({ ...r, key: r.id.slice("rec_bench_".length, -"_2026-10-02".length) }))
        .filter((r) => prefixes.length === 0 || prefixes.some((p) => r.key.startsWith(p)));
    },
  };
}
type Shop = ReturnType<typeof shop>;

const keys = (recs: { key: string }[]) => recs.map((r) => r.key).sort();
const only = (recs: (Recommendation & { key: string })[], key: string) => {
  const found = recs.filter((r) => r.key === key);
  expect(found, key).toHaveLength(1);
  return found[0]!;
};

/** Finished jobs that went design, casting, ready: casting to ready takes `days` each. */
async function history(s: Shop, days: number[]) {
  for (const [i, d] of days.entries()) {
    const cast = Date.parse("2026-08-01T12:00:00Z") + i * 86_400_000;
    await s.stage(`H-${i + 1}`, "design", new Date(cast - 2 * 86_400_000).toISOString());
    await s.stage(`H-${i + 1}`, "casting", new Date(cast).toISOString(), { jeweler: "Ana" });
    await s.stage(`H-${i + 1}`, "ready", new Date(cast + d * 86_400_000).toISOString());
  }
}

describe("the bench department", () => {
  it("is the first manufacturing department and can be picked by id beside retail's", () => {
    expect(MANUFACTURING_DEPARTMENTS.map((d) => d.id)).toEqual(["bench"]);
    expect(manufacturingDepartments()).toBe(MANUFACTURING_DEPARTMENTS);
    expect(manufacturingDepartments({ bench: {} })[0]!.id).toBe("bench");
    const all = [...RETAIL_DEPARTMENTS, ...MANUFACTURING_DEPARTMENTS];
    expect(selectDepartments(["bench", "repairs"], {}, all).map((d) => d.id)).toEqual(["repairs", "bench"]);
    expect(selectDepartments([], {}, all)).toBe(all);
    expect(() => selectDepartments(["bench"])).toThrow(/unknown departments: bench/);
    expect(() => combineDepartments(all)).not.toThrow();
    expect(bench.reasoners.map((r) => r.name)).toEqual(["bench.stuck", "bench.promised-date", "bench.rework", "bench.metal-loss"]);
    expect(Object.keys(bench.events)).toEqual(["bench_job.opened", "bench_job.stage_recorded"]);
  });

  it("stores a job as an entity and each stage as a signal", async () => {
    const s = shop();
    const opened = await s.open("J-1", { description: "Halo ring", promisedBy: "2026-10-20", metal: "gold", karat: 14 });
    expect(opened.entities).toEqual([
      expect.objectContaining({ ref: { kind: "bench_job", id: "J-1" }, attributes: { jobId: "J-1", description: "Halo ring", promisedBy: "2026-10-20", metal: "gold", karat: 14 } }),
    ]);
    expect(opened.signals.map((x) => [x.kind, x.subject])).toEqual([["bench.job", { kind: "bench_job", id: "J-1" }]]);
    const staged = await s.stage("J-1", "casting", "2026-09-30T12:00:00Z", { jeweler: "Ana", metalInGrams: 10, metalOutGrams: 9.8 });
    expect(staged.entities).toEqual([]);
    expect(staged.signals).toEqual([
      expect.objectContaining({ kind: "bench.stage", subject: { kind: "bench_job", id: "J-1" }, observedAt: "2026-09-30T12:00:00Z", value: { jobId: "J-1", stage: "casting", jeweler: "Ana", metalInGrams: 10, metalOutGrams: 9.8 } }),
    ]);
    const qc = await s.stage("J-1", "qc", "2026-10-01T12:00:00Z", { qcResult: "fail", failedStage: "setting" });
    expect(qc.signals[0]!.value).toEqual({ jobId: "J-1", stage: "qc", qcResult: "fail", failedStage: "setting" });
  });

  it("dead-letters a stage record or job it can't trust, saying why", async () => {
    const s = shop();
    const bad = async (type: string, payload: Record<string, unknown>) => expect(s.send(type, payload)).rejects.toThrow(/dead-lettered/);
    await bad("bench_job.stage_recorded", { jobId: "J-1", stage: "casting", qcResult: "pass" });
    await bad("bench_job.stage_recorded", { jobId: "J-1", stage: "qc", qcResult: "pass", failedStage: "setting" });
    await bad("bench_job.stage_recorded", { jobId: "J-1", stage: "qc", failedStage: "setting" });
    await bad("bench_job.stage_recorded", { jobId: "J-1", stage: "polishing" });
    await bad("bench_job.stage_recorded", { jobId: "J-1", stage: "qc", qcResult: "fail", failedStage: "qc" });
    await bad("bench_job.stage_recorded", { jobId: "J-1", stage: "casting", metalOutGrams: 0 });
    await bad("bench_job.stage_recorded", { jobId: "J-1", stage: "casting", metalInGrams: -1 });
    await bad("bench_job.stage_recorded", { jobId: "", stage: "casting" });
    await bad("bench_job.opened", { jobId: "J-1", promisedBy: "next week" });
    await bad("bench_job.opened", { jobId: "J-1", metal: "brass" });
    await bad("bench_job.opened", { jobId: "J-1", karat: 25 });
    expect(s.memory.deadLetters.slice(0, 3).map((d) => d.issues.map((i) => `${i.path}: ${i.message}`))).toEqual([
      ["payload.qcResult: only a qc stage has a result"],
      ["payload.failedStage: only a failed qc names the stage the work goes back to"],
      ["payload.failedStage: only a failed qc names the stage the work goes back to"],
    ]);
  });
});

describe("bench.stuck", () => {
  it("raises a job in one stage past its limit, naming who has it", async () => {
    const s = shop();
    await s.open("J-1", { description: "Halo ring" });
    await s.stage("J-1", "design", "2026-09-20T12:00:00Z", { jeweler: "Cy" });
    await s.stage("J-1", "casting", "2026-09-26T12:00:00Z", { jeweler: "Ana" });
    const rec = only(await s.recs(), "stuck_J-1");
    expect(rec.summary).toBe("Bench job J-1 (Halo ring) has been in casting for 6 days with Ana, past the 4-day limit. Find out what's holding it up.");
    expect(rec.confidence).toBe(0.75);
    expect(rec.impact).toBeUndefined();
    // The job and the stage it is in, not the stages before.
    expect(rec.provenance.signalIds).toHaveLength(2);
    expect(rec.provenance.signalIds.some((id) => id.startsWith("sig_bench.job_"))).toBe(true);
  });

  it("waits until a job is past the limit, not at it", async () => {
    const s = shop();
    await s.stage("AT", "casting", "2026-09-28T15:00:00Z");
    await s.stage("PAST", "casting", "2026-09-27T15:00:00Z");
    await s.stage("QC", "qc", "2026-09-30T14:00:00Z");
    await s.stage("QC-PAST", "qc", "2026-09-29T15:00:00Z");
    expect(keys(await s.recs())).toEqual(["stuck_PAST", "stuck_QC-PAST"]);
  });

  it("counts from the first of the job's records in a row in the same stage, with whoever had it last", async () => {
    const s = shop();
    await s.stage("J-1", "setting", "2026-09-20T12:00:00Z", { jeweler: "Ben" });
    await s.stage("J-1", "qc", "2026-09-24T12:00:00Z", { qcResult: "fail" });
    await s.stage("J-1", "setting", "2026-09-25T12:00:00Z", { jeweler: "Ana" });
    await s.stage("J-1", "setting", "2026-09-30T12:00:00Z", { jeweler: "Ben" });
    const rec = only(await s.recs(), "stuck_J-1");
    expect(rec.summary).toBe("Bench job J-1 has been in stone setting for 7 days with Ben, past the 4-day limit. Find out what's holding it up.");
    expect(rec.provenance.signalIds).toHaveLength(2);
  });

  it("names each stage in the owner's words and uses each stage's own limit", async () => {
    const s = shop();
    await s.stage("D", "design", "2026-09-24T12:00:00Z");
    await s.stage("D-OK", "design", "2026-09-25T15:00:00Z");
    await s.stage("F", "finishing", "2026-09-28T12:00:00Z");
    await s.stage("F-OK", "finishing", "2026-09-29T15:00:00Z");
    await s.stage("H", "on_hold", "2026-09-17T12:00:00Z");
    await s.stage("H-OK", "on_hold", "2026-09-18T15:00:00Z");
    const recs = await s.recs();
    expect(keys(recs)).toEqual(["stuck_D", "stuck_F", "stuck_H"]);
    expect(only(recs, "stuck_D").summary).toContain("has been in design and CAD for 8 days, past the 7-day limit");
    expect(only(recs, "stuck_F").summary).toContain("has been in finishing and polish for 4 days, past the 3-day limit");
    expect(only(recs, "stuck_H").summary).toContain("has been on hold for 15 days, past the 14-day limit");
  });

  it("leaves finished, cancelled and picked-up work alone", async () => {
    const s = shop();
    await s.stage("READY", "casting", "2026-09-01T12:00:00Z");
    await s.stage("READY", "ready", "2026-09-10T12:00:00Z");
    await s.stage("GONE", "casting", "2026-09-01T12:00:00Z");
    await s.stage("GONE", "cancelled", "2026-09-10T12:00:00Z");
    await s.send("repair.received", { ticketId: "R-1", customerId: "c1", itemDescription: "Test ring", work: "Retip", promisedBy: "2026-12-01", estimateCents: 9_000 }, "2026-09-01T12:00:00Z");
    await s.send("repair.status_changed", { ticketId: "R-1", status: "ready" }, "2026-09-12T12:00:00Z");
    await s.open("REPAIRED", { repairTicketId: "R-1" });
    await s.stage("REPAIRED", "setting", "2026-09-05T12:00:00Z");
    await s.send("repair.received", { ticketId: "R-2", customerId: "c1", itemDescription: "Test ring", work: "Retip", promisedBy: "2026-12-01", estimateCents: 9_000 }, "2026-09-01T12:00:00Z");
    await s.send("repair.status_changed", { ticketId: "R-2", status: "at_bench" }, "2026-09-12T12:00:00Z");
    await s.open("AT-BENCH", { repairTicketId: "R-2" });
    await s.stage("AT-BENCH", "setting", "2026-09-05T12:00:00Z");
    await s.send("custom_order.created", { orderId: "CO-1", customerId: "c1", description: "Test pendant", quotedCents: 100_000, dueBy: "2026-12-01" }, "2026-09-01T12:00:00Z");
    await s.send("custom_order.stage_changed", { orderId: "CO-1", stage: "delivered" }, "2026-09-20T12:00:00Z");
    await s.open("DELIVERED", { customOrderId: "CO-1" });
    await s.stage("DELIVERED", "finishing", "2026-09-05T12:00:00Z");
    await s.open("NO-STAGES");
    // Checked and ready at the same moment, recorded in either order: quality control comes before ready.
    await s.stage("SAME-1", "qc", "2026-09-20T12:00:00Z", { qcResult: "pass" });
    await s.stage("SAME-1", "ready", "2026-09-20T12:00:00Z");
    await s.stage("SAME-2", "ready", "2026-09-20T12:00:00Z");
    await s.stage("SAME-2", "qc", "2026-09-20T12:00:00Z", { qcResult: "pass" });
    const recs = await s.recs();
    expect(keys(recs)).toEqual(["stuck_AT-BENCH"]);
    expect(only(recs, "stuck_AT-BENCH").summary).toMatch(/^Bench job AT-BENCH \(Test ring\) has been in stone setting/);
  });

  it("uses the instance's own limits", async () => {
    const tuned = benchDepartment({ stageLimitDays: { casting: 10 } });
    const s = shop([...RETAIL_DEPARTMENTS, tuned]);
    await s.stage("C", "casting", "2026-09-26T12:00:00Z");
    await s.stage("S", "setting", "2026-09-26T12:00:00Z");
    await s.stage("C-LONG", "casting", "2026-09-20T12:00:00Z");
    const recs = await s.recs();
    expect(keys(recs)).toEqual(["stuck_C-LONG", "stuck_S"]);
    expect(only(recs, "stuck_C-LONG").summary).toContain("for 12 days, past the 10-day limit");
  });

  it("follows a custom order's own stages when no bench job names it, until custom orders raises it itself", async () => {
    const s = shop();
    const order = (orderId: string) => ({ orderId, customerId: "c1", description: `Test ring ${orderId}`, quotedCents: 200_000, dueBy: "2026-12-01" });
    await s.send("custom_order.created", order("CO-1"), "2026-09-20T12:00:00Z");
    await s.send("custom_order.stage_changed", { orderId: "CO-1", stage: "casting" }, "2026-09-26T12:00:00Z");
    await s.send("custom_order.created", order("CO-13"), "2026-09-01T12:00:00Z");
    await s.send("custom_order.stage_changed", { orderId: "CO-13", stage: "setting" }, "2026-09-19T12:00:00Z");
    await s.send("custom_order.created", order("CO-14"), "2026-09-01T12:00:00Z");
    await s.send("custom_order.stage_changed", { orderId: "CO-14", stage: "setting" }, "2026-09-18T12:00:00Z");
    // Design then CAD is one stage, counted from design.
    await s.send("custom_order.created", order("CO-CAD"), "2026-09-23T12:00:00Z");
    await s.send("custom_order.stage_changed", { orderId: "CO-CAD", stage: "cad" }, "2026-09-24T12:00:00Z");
    // Waiting on the customer's approval is a hold.
    await s.send("custom_order.created", order("CO-APPROVAL"), "2026-09-22T12:00:00Z");
    await s.send("custom_order.stage_changed", { orderId: "CO-APPROVAL", stage: "approval" }, "2026-09-23T12:00:00Z");
    await s.send("custom_order.created", order("CO-DONE"), "2026-09-26T12:00:00Z");
    await s.send("custom_order.stage_changed", { orderId: "CO-DONE", stage: "ready" }, "2026-09-28T12:00:00Z");
    await s.send("custom_order.created", order("CO-DELIVERED"), "2026-09-20T12:00:00Z");
    await s.send("custom_order.stage_changed", { orderId: "CO-DELIVERED", stage: "delivered" }, "2026-09-25T12:00:00Z");
    // Named by a bench job: the job's own records count, not the order's.
    await s.send("custom_order.created", order("CO-NAMED"), "2026-09-01T12:00:00Z");
    await s.send("custom_order.stage_changed", { orderId: "CO-NAMED", stage: "casting" }, "2026-09-20T12:00:00Z");
    await s.open("J-NAMED", { customOrderId: "CO-NAMED" });
    await s.stage("J-NAMED", "casting", "2026-10-01T12:00:00Z");
    const recs = await s.recs();
    expect(keys(recs)).toEqual(["stuck_custom_order_CO-1", "stuck_custom_order_CO-13", "stuck_custom_order_CO-CAD"]);
    expect(only(recs, "stuck_custom_order_CO-1").summary).toBe("Custom order CO-1 (Test ring CO-1) has been in casting for 6 days, past the 4-day limit. Find out what's holding it up.");
    expect(only(recs, "stuck_custom_order_CO-CAD").summary).toContain("in design and CAD for 9 days");
    // Custom orders raises CO-14 itself, at 14 days in one stage.
    expect((await s.recs()).some((r) => r.summary.includes("CO-14"))).toBe(false);
  });
});

describe("bench.promised-date", () => {
  it("raises a job the store's own history says will miss its promised date", async () => {
    const s = shop();
    await history(s, [6, 8, 10]);
    await s.open("J-1", { description: "Halo ring", promisedBy: "2026-10-05" });
    await s.stage("J-1", "casting", "2026-09-30T12:00:00Z", { jeweler: "Ben" });
    const rec = only(await s.recs("at_risk", "late"), "at_risk_J-1");
    expect(rec.summary).toBe(
      "Bench job J-1 (Halo ring) is promised for 2026-10-05 and is in casting. Jobs here take a median of 8 days from casting to ready (3 finished jobs), so it is likely ready about 2026-10-08, 3 days late. Tell the customer now or move it up the queue.",
    );
    expect(rec.confidence).toBe(0.7);
    expect(rec.impact).toBeUndefined();
  });

  it("leaves a job that will make it, and says nothing without enough history", async () => {
    const s = shop();
    await history(s, [6, 8, 10]);
    await s.open("ON-TIME", { promisedBy: "2026-10-08" });
    await s.stage("ON-TIME", "casting", "2026-09-30T12:00:00Z");
    // No finished job has a record of setting.
    await s.open("NO-HISTORY", { promisedBy: "2026-10-03" });
    await s.stage("NO-HISTORY", "setting", "2026-10-02T12:00:00Z");
    // No promised date anywhere.
    await s.stage("NO-PROMISE", "casting", "2026-10-01T12:00:00Z");
    expect(keys(await s.recs("at_risk", "late"))).toEqual([]);

    const thin = shop();
    await history(thin, [6, 8]);
    await thin.open("J-1", { promisedBy: "2026-10-03" });
    await thin.stage("J-1", "casting", "2026-10-01T12:00:00Z");
    expect(keys(await thin.recs("at_risk", "late"))).toEqual([]);
  });

  it("takes the median of an even number of jobs as the middle two's average, and counts from the job's first time in its stage", async () => {
    const s = shop();
    await history(s, [6, 8, 10, 12]);
    await s.open("J-1", { promisedBy: "2026-10-06" });
    await s.stage("J-1", "casting", "2026-09-29T12:00:00Z");
    await s.stage("J-1", "qc", "2026-09-30T12:00:00Z", { qcResult: "fail", failedStage: "casting" });
    await s.stage("J-1", "casting", "2026-10-01T12:00:00Z");
    const rec = only(await s.recs("at_risk", "late"), "at_risk_J-1");
    expect(rec.summary).toContain("a median of 9 days from casting to ready (4 finished jobs), so it is likely ready about 2026-10-08, 2 days late");
  });

  it("projects from now once a job has already taken longer than usual", async () => {
    const s = shop();
    await history(s, [2, 2, 3]);
    await s.open("TODAY", { promisedBy: "2026-10-02" });
    await s.stage("TODAY", "casting", "2026-09-29T12:00:00Z");
    expect(keys(await s.recs("at_risk", "late"))).toEqual([]);
  });

  it("raises work past its promised date that no other department follows", async () => {
    const s = shop();
    await s.open("J-2", { description: "Signet", promisedBy: "2026-09-30" });
    await s.stage("J-2", "finishing", "2026-10-01T12:00:00Z", { jeweler: "Cy" });
    const rec = only(await s.recs("at_risk", "late"), "late_J-2");
    expect(rec.summary).toBe("Bench job J-2 (Signet) is 2 days past its promised date of 2026-09-30 and still in finishing and polish. Call the customer with a new date today.");
    expect(rec.confidence).toBe(0.9);
    // Promised today is not late yet, and a job on hold has no projection.
    const t = shop();
    await t.open("DUE-TODAY", { promisedBy: "2026-10-02" });
    await t.stage("DUE-TODAY", "finishing", "2026-10-01T12:00:00Z");
    await t.open("HELD", { promisedBy: "2026-09-01" });
    await t.stage("HELD", "on_hold", "2026-10-01T12:00:00Z");
    expect(keys(await t.recs("at_risk", "late"))).toEqual([]);
  });

  it("uses a repair's or custom order's promise, and leaves them to their own department once past it", async () => {
    const s = shop();
    await history(s, [6, 8, 10]);
    const ticket = (ticketId: string, promisedBy: string) => ({ ticketId, customerId: "c1", itemDescription: `Test chain ${ticketId}`, work: "Solder", promisedBy, estimateCents: 5_000 });
    await s.send("repair.received", ticket("R-1", "2026-10-04"), "2026-09-20T12:00:00Z");
    await s.open("J-R1", { repairTicketId: "R-1" });
    await s.stage("J-R1", "casting", "2026-09-30T12:00:00Z");
    await s.send("repair.received", ticket("R-2", "2026-09-30"), "2026-09-20T12:00:00Z");
    await s.open("J-R2", { repairTicketId: "R-2" });
    await s.stage("J-R2", "casting", "2026-10-01T12:00:00Z");
    await s.send("custom_order.created", { orderId: "CO-1", customerId: "c1", description: "Test band", quotedCents: 90_000, dueBy: "2026-10-05" }, "2026-09-20T12:00:00Z");
    await s.open("J-CO1", { customOrderId: "CO-1" });
    await s.stage("J-CO1", "casting", "2026-10-01T12:00:00Z");
    // Past due: custom orders raises its own order, with or without a bench job.
    await s.send("custom_order.created", { orderId: "CO-LATE", customerId: "c1", description: "Test band", quotedCents: 90_000, dueBy: "2026-09-25" }, "2026-09-10T12:00:00Z");
    await s.open("J-CO-LATE", { customOrderId: "CO-LATE" });
    await s.stage("J-CO-LATE", "casting", "2026-10-01T12:00:00Z");
    await s.send("custom_order.created", { orderId: "CO-ALONE", customerId: "c1", description: "Test band", quotedCents: 90_000, dueBy: "2026-09-25" }, "2026-09-10T12:00:00Z");
    await s.send("custom_order.stage_changed", { orderId: "CO-ALONE", stage: "finishing" }, "2026-10-01T12:00:00Z");
    // Closed once its repair is ready, whatever its own records last said.
    await s.send("repair.received", ticket("R-3", "2026-10-03"), "2026-09-20T12:00:00Z");
    await s.send("repair.status_changed", { ticketId: "R-3", status: "ready" }, "2026-10-02T09:00:00Z");
    await s.open("J-R3", { repairTicketId: "R-3" });
    await s.stage("J-R3", "casting", "2026-09-30T12:00:00Z");
    // The job's own promise wins over the ticket's.
    await s.open("J-OWN", { repairTicketId: "R-1", promisedBy: "2026-10-20" });
    await s.stage("J-OWN", "casting", "2026-10-01T12:00:00Z");
    const recs = await s.recs("at_risk", "late");
    expect(keys(recs)).toEqual(["at_risk_J-CO1", "at_risk_J-R1"]);
    expect(only(recs, "at_risk_J-R1").summary).toMatch(/^Bench job J-R1 \(Test chain R-1\) is promised for 2026-10-04 /);
    expect(only(recs, "at_risk_J-CO1").summary).toMatch(/^Bench job J-CO1 \(Test band\) is promised for 2026-10-05 .* about 2026-10-09, 4 days late/);
    expect(only(recs, "at_risk_J-R1").provenance.signalIds.some((id) => id.startsWith("sig_repair.ticket_"))).toBe(true);
  });

  it("leaves a custom order due within a week and short of finishing to custom orders, and raises the rest", async () => {
    const s = shop();
    await history(s, [9, 10, 11]);
    await s.stage("H-1", "finishing", "2026-08-03T12:00:00Z");
    await s.stage("H-2", "finishing", "2026-08-04T12:00:00Z");
    await s.stage("H-3", "finishing", "2026-08-05T12:00:00Z");
    const order = async (orderId: string, dueBy: string, stage: string) => {
      await s.send("custom_order.created", { orderId, customerId: "c1", description: "Test ring", quotedCents: 90_000, dueBy }, "2026-09-20T12:00:00Z");
      await s.send("custom_order.stage_changed", { orderId, stage }, "2026-10-01T12:00:00Z");
    };
    await order("SOON-CAST", "2026-10-09", "casting");
    await order("LATER-CAST", "2026-10-10", "casting");
    await order("SOON-FINISH", "2026-10-03", "finishing");
    expect(keys(await s.recs("at_risk", "late"))).toEqual(["at_risk_custom_order_LATER-CAST", "at_risk_custom_order_SOON-FINISH"]);
  });

  it("learns typical times only from jobs that reached ready, from their first time in each stage to their first ready", async () => {
    const sig = (kind: string, subject: string, value: Record<string, unknown>, at: string): Signal => ({
      id: `sig_${kind}_${subject}_${at}`,
      organizationId: ORG,
      kind,
      subject: { kind: "x", id: subject },
      value,
      confidence: 1,
      derivedFromEventIds: [`e_${subject}_${at}`],
      observedAt: at,
    });
    const day = (d: number) => `2026-09-${String(d).padStart(2, "0")}T00:00:00.000Z`;
    const signals: Signal[] = [];
    for (const j of ["A", "B", "C"]) {
      signals.push(
        sig("bench.stage", j, { stage: "setting" }, day(1)),
        sig("bench.stage", j, { stage: "qc" }, day(3)),
        sig("bench.stage", j, { stage: "setting" }, day(4)),
        sig("bench.stage", j, { stage: "ready" }, day(6)),
        sig("bench.stage", j, { stage: "ready" }, day(9)),
      );
    }
    // Back in work after ready: not finished, so not learned from.
    signals.push(sig("bench.stage", "D", { stage: "setting" }, day(1)), sig("bench.stage", "D", { stage: "ready" }, day(20)), sig("bench.stage", "D", { stage: "finishing" }, day(21)));
    const typical = typicalTimes(benchJobs(signals));
    expect([...typical.entries()]).toEqual([
      ["setting", { days: 5, jobs: 3 }],
      ["qc", { days: 3, jobs: 3 }],
    ]);
  });
});

describe("bench.rework", () => {
  /** A job worked at casting by Ana, setting by Ben and finishing by Cy, then checked. */
  async function piece(s: Shop, jobId: string, day: number, qc: "pass" | "fail-setting" | "fail-inferred") {
    const at = (h: number) => new Date(Date.parse(`2026-09-${String(day).padStart(2, "0")}T00:00:00Z`) + h * 3_600_000).toISOString();
    await s.stage(jobId, "casting", at(1), { jeweler: "Ana" });
    await s.stage(jobId, "setting", at(2), { jeweler: "Ben" });
    await s.stage(jobId, "finishing", at(3), { jeweler: "Cy" });
    if (qc === "pass") {
      await s.stage(jobId, "qc", at(4), { qcResult: "pass" });
    } else {
      await s.stage(jobId, "qc", at(4), qc === "fail-setting" ? { qcResult: "fail", failedStage: "setting" } : {});
      await s.stage(jobId, "setting", at(5), { jeweler: "Dee" });
      await s.stage(jobId, "qc", at(6), { qcResult: "pass" });
    }
    await s.stage(jobId, "ready", at(7));
  }

  it("raises a stage and a jeweler whose work keeps coming back from quality control", async () => {
    const s = shop();
    await piece(s, "P-1", 1, "fail-setting");
    await piece(s, "P-2", 2, "fail-inferred");
    await piece(s, "P-3", 3, "pass");
    await piece(s, "P-4", 4, "pass");
    await piece(s, "P-5", 5, "pass");
    const recs = await s.recs("rework");
    expect(keys(recs)).toEqual(["rework_jeweler_ben", "rework_stage_setting"]);
    const stage = only(recs, "rework_stage_setting");
    expect(stage.summary).toBe(
      "Quality control sent back 2 of 7 pieces checked after stone setting (28.6%) in the last 90 days, 2 of them Ben's. Look at what is failing before more work goes back.",
    );
    expect(stage.confidence).toBe(0.7);
    expect(stage.impact).toBeUndefined();
    // The two failed checks and the setting work they sent back.
    expect(stage.provenance.signalIds).toHaveLength(4);
    const ben = only(recs, "rework_jeweler_ben");
    expect(ben.summary).toBe("2 of 5 stages Ben worked failed quality control (40%) in the last 90 days, most at stone setting (2). Go through the failures together.");
    expect(ben.confidence).toBe(0.65);
  });

  it("needs five checks, two failures and a fifth of checks failing", async () => {
    const one = shop();
    await piece(one, "P-1", 1, "fail-setting");
    for (const [i, d] of [2, 3, 4, 5, 6].entries()) await piece(one, `P-${i + 2}`, d, "pass");
    expect(keys(await one.recs("rework"))).toEqual([]);

    // One failure in five checks is a fifth, but one isn't a pattern.
    const single = shop();
    for (let i = 0; i < 5; i++) {
      await single.stage(`S-${i}`, "finishing", "2026-09-10T01:00:00Z", { jeweler: "Eve" });
      await single.stage(`S-${i}`, "qc", "2026-09-10T02:00:00Z", { qcResult: i === 0 ? "fail" : "pass" });
    }
    expect(keys(await single.recs("rework"))).toEqual([]);

    // Two failures in four checks of Dee's: too few checks.
    const few = shop();
    for (const j of ["A", "B", "C", "D"]) {
      await few.stage(j, "finishing", "2026-09-10T01:00:00Z", { jeweler: "Dee" });
      await few.stage(j, "qc", "2026-09-10T02:00:00Z", { qcResult: j < "C" ? "fail" : "pass" });
    }
    expect(keys(await few.recs("rework"))).toEqual([]);

    // Two of ten: exactly a fifth is raised; two of eleven isn't.
    const fifth = shop();
    for (let i = 0; i < 10; i++) {
      await fifth.stage(`F-${i}`, "finishing", "2026-09-10T01:00:00Z", { jeweler: "Eve" });
      await fifth.stage(`F-${i}`, "qc", "2026-09-10T02:00:00Z", { qcResult: i < 2 ? "fail" : "pass" });
    }
    expect(keys(await fifth.recs("rework"))).toEqual(["rework_jeweler_eve", "rework_stage_finishing"]);
    await fifth.stage("F-10", "finishing", "2026-09-10T01:00:00Z", { jeweler: "Eve" });
    await fifth.stage("F-10", "qc", "2026-09-10T02:00:00Z", { qcResult: "pass" });
    expect(keys(await fifth.recs("rework"))).toEqual([]);
  });

  it("counts a failure against the stage the check names, the stage the job goes back to, or the last one worked", async () => {
    const s = shop();
    const day = (h: number) => `2026-09-10T${String(h).padStart(2, "0")}:00:00Z`;
    // Named: casting, though the job goes on to finishing next.
    await s.stage("NAMED", "casting", day(1), { jeweler: "Ana" });
    await s.stage("NAMED", "setting", day(2), { jeweler: "Ben" });
    await s.stage("NAMED", "qc", day(3), { qcResult: "fail", failedStage: "casting" });
    await s.stage("NAMED", "finishing", day(4), { jeweler: "Cy" });
    // Nothing named or after: the last stage worked.
    await s.stage("LAST", "setting", day(1), { jeweler: "Ben" });
    await s.stage("LAST", "finishing", day(2), { jeweler: "Cy" });
    await s.stage("LAST", "qc", day(3), { qcResult: "fail" });
    // Named, but checked at an earlier pass: the jeweler who last worked it before the check.
    await s.stage("EARLIER", "casting", day(1), { jeweler: "Zed" });
    await s.stage("EARLIER", "qc", day(2), { qcResult: "pass" });
    await s.stage("EARLIER", "casting", day(3), { jeweler: "Ana" });
    await s.stage("EARLIER", "qc", day(4), { qcResult: "pass" });
    await s.stage("EARLIER", "setting", day(5), { jeweler: "Ben" });
    await s.stage("EARLIER", "qc", day(6), { qcResult: "fail", failedStage: "casting" });
    // Each check counts only the work since the last one, and a hold is not work.
    await s.stage("HELD", "finishing", day(1), { jeweler: "Cy" });
    await s.stage("HELD", "qc", day(2), { qcResult: "pass" });
    await s.stage("HELD", "on_hold", day(3));
    await s.stage("HELD", "qc", day(4), { qcResult: "fail" });
    // A check with no result followed by a hold is not a failure.
    await s.stage("HOLD-NEXT", "on_hold", day(0));
    await s.stage("HOLD-NEXT", "design", day(1), { jeweler: "Ann" });
    await s.stage("HOLD-NEXT", "qc", day(2));
    await s.stage("HOLD-NEXT", "on_hold", day(3));
    // A check with no result and nothing after it isn't counted yet; one followed by ready passed.
    await s.stage("PENDING", "design", day(1), { jeweler: "Ann" });
    await s.stage("PENDING", "qc", day(2));
    await s.stage("PASSED", "design", day(1), { jeweler: "Ann" });
    await s.stage("PASSED", "qc", day(2));
    await s.stage("PASSED", "ready", day(3));
    // A failed check whose work no record shows counts nothing against anyone.
    await s.stage("EMPTY", "qc", day(2), { qcResult: "fail" });
    const { stages, jewelers } = reworkTallies(benchJobs(await s.signals()), NOW);
    const counts = (m: typeof stages) => Object.fromEntries([...m.entries()].map(([k, t]) => [k, `${t.failed}/${t.checked}`]));
    expect(counts(stages)).toEqual({ casting: "2/4", setting: "0/3", finishing: "1/2", design: "0/2" });
    expect(counts(jewelers)).toEqual({ Ana: "2/3", Ben: "0/3", Cy: "1/2", Ann: "0/2", Zed: "0/1" });
    expect(Object.fromEntries(jewelers.get("Ana")!.by)).toEqual({ casting: 2 });
    expect(Object.fromEntries(stages.get("casting")!.by)).toEqual({ Ana: 2 });
  });

  it("cites each failed check and piece of work once, even when one piece of work is blamed twice", async () => {
    const s = shop();
    const at = (h: number) => `2026-09-10T${String(h).padStart(2, "0")}:00:00Z`;
    await s.stage("TWICE", "casting", at(1), { jeweler: "Ana" });
    await s.stage("TWICE", "qc", at(2), { qcResult: "pass" });
    await s.stage("TWICE", "setting", at(3), { jeweler: "Ben" });
    await s.stage("TWICE", "qc", at(4), { qcResult: "fail", failedStage: "casting" });
    await s.stage("TWICE", "setting", at(5), { jeweler: "Ben" });
    await s.stage("TWICE", "qc", at(6), { qcResult: "fail", failedStage: "casting" });
    for (const j of ["A", "B"]) {
      await s.stage(j, "casting", at(1), { jeweler: "Ana" });
      await s.stage(j, "qc", at(2), { qcResult: "pass" });
    }
    const recs = await s.recs("rework");
    expect(keys(recs)).toEqual(["rework_jeweler_ana", "rework_stage_casting"]);
    for (const rec of recs) expect(rec.provenance.signalIds, rec.key).toHaveLength(3);
  });

  it("counts only checks in the last 90 days, and work with no jeweler only toward its stage", async () => {
    const s = shop();
    for (let i = 0; i < 5; i++) {
      await s.stage(`OLD-${i}`, "setting", "2026-07-03T13:00:00Z", { jeweler: "Ben" });
      await s.stage(`OLD-${i}`, "qc", "2026-07-03T14:00:00Z", { qcResult: "fail" });
      await s.stage(`NEW-${i}`, "setting", "2026-07-04T15:00:00Z");
      await s.stage(`NEW-${i}`, "qc", "2026-07-04T15:00:00Z", { qcResult: i < 2 ? "fail" : "pass" });
    }
    const { stages, jewelers } = reworkTallies(benchJobs(await s.signals()), NOW);
    expect(stages.get("setting")).toMatchObject({ checked: 5, failed: 2 });
    expect(stages.get("setting")!.by.size).toBe(0);
    expect(jewelers.size).toBe(0);
    const rec = only(await s.recs("rework"), "rework_stage_setting");
    expect(rec.summary).toBe("Quality control sent back 2 of 5 pieces checked after stone setting (40%) in the last 90 days. Look at what is failing before more work goes back.");
  });

  it("names the jeweler's stage with the most failures, and keys a jeweler by a plain form of their name", async () => {
    const s = shop();
    for (let i = 0; i < 6; i++) {
      const stage = i < 3 ? "casting" : "finishing";
      await s.stage(`J-${i}`, stage, "2026-09-10T01:00:00Z", { jeweler: "Mary Ann O'Neil Jr." });
      await s.stage(`J-${i}`, "qc", "2026-09-10T02:00:00Z", { qcResult: i === 0 || i >= 3 ? "fail" : "pass" });
    }
    const recs = await s.recs("rework");
    const rec = only(recs, "rework_jeweler_mary-ann-o-neil-jr");
    expect(rec.summary).toContain("4 of 6 stages Mary Ann O'Neil Jr. worked failed quality control (66.7%)");
    expect(rec.summary).toContain("most at finishing and polish (3)");
    // Each stage alone has too few checks to say anything.
    expect(keys(recs)).toEqual(["rework_jeweler_mary-ann-o-neil-jr"]);
  });
});

describe("bench.metal-loss", () => {
  const spot = (s: Shop, metal: string, cents: number, at = "2026-10-01T12:00:00Z") => s.send("metal.price_updated", { metal, spotPerTroyOunceCents: cents }, at);
  async function weighed(s: Shop, jobId: string, opened: Record<string, unknown>, stages: [string, number, number, string?][], from = "2026-09-25") {
    await s.open(jobId, opened);
    for (const [i, [stage, metalInGrams, metalOutGrams, jeweler]] of stages.entries()) {
      await s.stage(jobId, stage, `${from}T${String(10 + i).padStart(2, "0")}:00:00Z`, { metalInGrams, metalOutGrams, ...(jeweler ? { jeweler } : {}) });
    }
  }
  const halo = [
    ["casting", 10, 9.5, "Ana"],
    ["setting", 6, 5.98, "Ben"],
    ["finishing", 5.98, 5.8, "Cy"],
  ] as [string, number, number, string?][];

  it("raises a job that lost more metal than the tolerance, valued at spot", async () => {
    const s = shop();
    await spot(s, "gold", 240_000);
    await weighed(s, "J-1", { description: "Halo ring", metal: "gold", karat: 14 }, halo);
    const rec = only(await s.recs("metal_loss"), "metal_loss_J-1");
    expect(rec.summary).toBe(
      "Bench job J-1 (Halo ring) lost 0.70 g of metal (7% of the 10.00 g issued), past the 3% tolerance; most in casting (0.50 g, Ana). Weigh the sweeps and filings before scrap goes to the refiner.",
    );
    expect(rec.confidence).toBe(0.8);
    // 0.40 g of 14K gold above the 0.30 g allowed: 0.40 x 14/24 / 31.1035 x $2,400.
    expect(rec.impact).toEqual({
      kind: "protects",
      cents: 1_800,
      lowCents: 1_800,
      highCents: 1_800,
      basis: "0.40 g lost above the 3% tolerance on 10.00 g issued, as 14K gold at $2,400.00 an ounce spot.",
    });
    expect(rec.provenance.signalIds.some((id) => id.startsWith("sig_metal.price_"))).toBe(true);
    expect(rec.provenance.signalIds).toHaveLength(5);
  });

  it("leaves a loss at the tolerance alone and counts a gain against the loss", async () => {
    const s = shop();
    await weighed(s, "AT", { metal: "gold", karat: 18 }, [["casting", 10, 9.7]]);
    await weighed(s, "GAIN", {}, [
      ["casting", 10, 9.5],
      ["setting", 6, 6.3],
    ]);
    await weighed(s, "JUST-OVER", {}, [["casting", 10, 9.699]]);
    expect(keys(await s.recs("metal_loss"))).toEqual(["metal_loss_JUST-OVER"]);
  });

  it("uses the instance's own tolerance", async () => {
    const s = shop([...RETAIL_DEPARTMENTS, benchDepartment({ metalLossShare: 0.1 })]);
    await weighed(s, "J-1", {}, halo);
    await weighed(s, "J-2", {}, [["casting", 10, 8.5, "Ana"]]);
    const recs = await s.recs("metal_loss");
    expect(keys(recs)).toEqual(["metal_loss_J-2"]);
    expect(only(recs, "metal_loss_J-2").summary).toBe(
      "Bench job J-2 lost 1.50 g of metal (15% of the 10.00 g issued), past the 10% tolerance; most in casting (1.50 g, Ana). Weigh the sweeps and filings before scrap goes to the refiner.",
    );
  });

  it("gives no dollar figure without a known alloy or a recent spot price of that metal", async () => {
    const s = shop();
    // 31 days old: too old.
    await spot(s, "gold", 240_000, "2026-09-01T12:00:00Z");
    await spot(s, "platinum", 100_000);
    await weighed(s, "NO-METAL", {}, halo);
    await weighed(s, "OLD-SPOT", { metal: "gold", karat: 14 }, halo);
    const fresh = shop();
    await spot(fresh, "gold", 240_000);
    await weighed(fresh, "NO-KARAT", { metal: "gold" }, halo);
    const recs = [...(await s.recs("metal_loss")), ...(await fresh.recs("metal_loss"))];
    expect(keys(recs)).toEqual(["metal_loss_NO-KARAT", "metal_loss_NO-METAL", "metal_loss_OLD-SPOT"]);
    for (const rec of recs) {
      expect(rec.impact, rec.key).toBeUndefined();
      expect(rec.provenance.signalIds.some((id) => id.startsWith("sig_metal.price_")), rec.key).toBe(false);
    }
  });

  it("values silver and platinum by their own purity at the latest spot within 30 days", async () => {
    const s = shop();
    await spot(s, "silver", 3_000, "2026-09-02T15:00:00Z");
    await spot(s, "silver", 3_110, "2026-09-20T12:00:00Z");
    await spot(s, "platinum", 99_000, "2026-09-02T15:00:00Z");
    await weighed(s, "AG", { metal: "silver" }, [["casting", 100, 90]]);
    await weighed(s, "PT", { metal: "platinum" }, [["casting", 100, 90]]);
    const recs = await s.recs("metal_loss");
    // 7 g above the 3 g allowed: 7 x 0.925 / 31.1035 x $31.10.
    expect(only(recs, "metal_loss_AG").impact).toMatchObject({ cents: 647, basis: "7.00 g lost above the 3% tolerance on 100.00 g issued, as silver at $31.10 an ounce spot." });
    // Platinum at 95%: 7 x 0.95 / 31.1035 x $990.
    expect(only(recs, "metal_loss_PT").impact).toMatchObject({ cents: 21_166 });
  });

  it("only weighs records with both weights, and leaves jobs last weighed over 30 days ago", async () => {
    const s = shop();
    await s.open("HALF");
    await s.stage("HALF", "casting", "2026-09-25T10:00:00Z", { metalInGrams: 10 });
    await s.stage("HALF", "setting", "2026-09-26T10:00:00Z", { metalOutGrams: 5 });
    await weighed(s, "OLD", {}, [["casting", 10, 8]], "2026-09-01");
    await weighed(s, "RECENT", {}, [["casting", 10, 8]], "2026-09-02");
    expect(keys(await s.recs("metal_loss"))).toEqual(["metal_loss_RECENT"]);
  });

  it("names the stage that lost the most, without a jeweler when none was recorded", async () => {
    const s = shop();
    await weighed(s, "J-1", {}, [
      ["casting", 10, 9.9],
      ["finishing", 9.9, 9.2],
    ]);
    expect(only(await s.recs("metal_loss"), "metal_loss_J-1").summary).toContain("most in finishing and polish (0.70 g).");
  });
});

describe("BENCH_STAGE_LIMIT_DAYS", () => {
  it("reads one number for every stage, stages of their own, or both", () => {
    expect(parseStageLimits("")).toEqual({});
    expect(parseStageLimits(" , ")).toEqual({});
    expect(parseStageLimits("5")).toEqual({ design: 5, casting: 5, setting: 5, finishing: 5, qc: 5, on_hold: 5 });
    expect(parseStageLimits("casting=5, setting = 3")).toEqual({ casting: 5, setting: 3 });
    expect(parseStageLimits("qc=1, 5")).toEqual({ design: 5, casting: 5, setting: 5, finishing: 5, qc: 1, on_hold: 5 });
    expect(parseStageLimits("1,on_hold=365")).toMatchObject({ design: 1, on_hold: 365 });
    expect(parseStageLimits("casting=2, casting=3")).toEqual({ casting: 3 });
    expect(BENCH_STAGE_LIMIT_DAYS).toEqual({ design: 7, casting: 4, setting: 4, finishing: 3, qc: 2, on_hold: 14 });
  });

  it("names the part it can't read", () => {
    expect(() => parseStageLimits("polish=3")).toThrow(new BenchSettingsError(`"polish" in "polish=3" isn't a stage; use design, casting, setting, finishing, qc, on_hold`));
    expect(() => parseStageLimits("ready=3")).toThrow(/isn't a stage/);
    for (const bad of ["0", "366", "1.5", "five", "casting=0", "casting=", "-1", "1000"]) expect(() => parseStageLimits(bad), bad).toThrow(/needs whole days from 1 to 365/);
    expect(() => parseStageLimits("casting=0")).toThrow(`"casting=0" needs whole days from 1 to 365`);
    expect(new BenchSettingsError("x").name).toBe("BenchSettingsError");
  });
});
