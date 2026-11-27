import { afterEach, describe, expect, it, vi } from "vitest";
import { DeadLetteredError, InMemoryStore } from "@karatos/core";
import { storeHours } from "@karatos/retail";
import { createInstancePipeline, INSTANCE_DEPARTMENTS, instanceDepartments, StaticDocumentationSource, type InstancePipelineOptions } from "../src/index.js";

const ORG = "fuse-jewelry";

function pipeline(departments: string[]) {
  const memory = new InMemoryStore();
  return {
    memory,
    pipeline: createInstancePipeline({ memory, documentation: new StaticDocumentationSource(["doc_arch"]), departments }),
  };
}

const saleEvent = (payload: unknown) => ({
  id: "evt_sale",
  organizationId: ORG,
  source: "pos",
  type: "sale.completed",
  occurredAt: "2026-10-01T12:00:00Z",
  receivedAt: "2026-10-01T12:00:01Z",
  idempotencyKey: "sale-1",
  payload,
});

const validSale = {
  saleId: "S1",
  customerId: "c1",
  channel: "store",
  lines: [{ sku: "RING-1", quantity: 1, unitPriceCents: 120_000 }],
  totalCents: 120_000,
  payments: [{ method: "card", amountCents: 120_000 }],
};

describe("createInstancePipeline", () => {
  it("runs the retail departments on incoming events", async () => {
    const { pipeline: brain } = pipeline([]);
    const result = await brain.ingest(saleEvent(validSale));
    expect(result.entities.map((e) => e.ref.kind)).toContain("order");
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it("dead-letters events whose payload a department rejects", async () => {
    const { pipeline: brain, memory } = pipeline(["sales"]);
    await expect(brain.ingest(saleEvent({ saleId: "S1" }))).rejects.toBeInstanceOf(DeadLetteredError);
    expect(memory.deadLetters).toHaveLength(1);
  });

  it("leaves event types of disabled departments alone", async () => {
    const { pipeline: brain } = pipeline(["repairs"]);
    const result = await brain.ingest(saleEvent({ anything: true }));
    expect(result.signals).toEqual([]);
  });

  it("runs the bench department beside retail's, with the instance's own bench settings", async () => {
    expect(INSTANCE_DEPARTMENTS.map((d) => d.id).slice(-3)).toEqual(["compliance", "bench", "production"]);
    expect(instanceDepartments([]).map((d) => d.id)).toEqual(INSTANCE_DEPARTMENTS.map((d) => d.id));
    expect(instanceDepartments(["bench", "repairs"]).map((d) => d.id)).toEqual(["repairs", "bench"]);
    const stage = (jobId: string) => ({
      id: `evt_${jobId}`,
      organizationId: ORG,
      source: "inventory_pos",
      type: "bench_job.stage_recorded",
      occurredAt: "2026-09-28T12:00:00Z",
      receivedAt: "2026-09-28T12:00:00Z",
      idempotencyKey: jobId,
      payload: { jobId, stage: "setting", metalInGrams: 10, metalOutGrams: 9.75 },
    });
    const run = async (options: Partial<InstancePipelineOptions>) => {
      const memory = new InMemoryStore();
      const brain = createInstancePipeline({ memory, documentation: new StaticDocumentationSource([]), departments: ["bench"], ...options });
      vi.useFakeTimers({ now: new Date("2026-10-02T15:00:00Z"), toFake: ["Date"] });
      try {
        await brain.ingest(stage("J-1"));
        return (await brain.reason(ORG)).map((r) => r.id.replace(/_2026-10-02$/, "")).sort();
      } finally {
        vi.useRealTimers();
      }
    };
    expect(await run({})).toEqual([]);
    expect(await run({ bench: { stageLimitDays: { setting: 3 }, metalLossShare: 0.02 } })).toEqual(["rec_bench_metal_loss_J-1", "rec_bench_stuck_J-1"]);
    await expect(createInstancePipeline({ memory: new InMemoryStore(), documentation: new StaticDocumentationSource([]), departments: ["bench"] }).ingest(stage("")))
      .rejects.toBeInstanceOf(DeadLetteredError);
  });

  it("runs production planning with the instance's rates and hours, on the store's own working days", async () => {
    const stage = (jobId: string, n: number, payload: Record<string, unknown>, occurredAt: string) => ({
      id: `evt_${jobId}_${n}`,
      organizationId: ORG,
      source: "inventory_pos",
      type: "bench_job.stage_recorded",
      occurredAt,
      receivedAt: occurredAt,
      idempotencyKey: `${jobId}_${n}`,
      payload: { jobId, ...payload },
    });
    const run = async (options: Partial<InstancePipelineOptions>) => {
      const memory = new InMemoryStore();
      const brain = createInstancePipeline({ memory, documentation: new StaticDocumentationSource([]), departments: ["bench", "production"], ...options });
      vi.useFakeTimers({ now: new Date("2026-10-02T15:00:00Z"), toFake: ["Date"] });
      try {
        // Three finished jobs set in 8 hours each, and one open job in setting with Ana.
        for (const id of ["H-1", "H-2", "H-3"]) {
          await brain.ingest(stage(id, 1, { stage: "setting", jeweler: "Ana", laborMinutes: 480 }, "2026-09-20T12:00:00Z"));
          await brain.ingest(stage(id, 2, { stage: "ready" }, "2026-09-21T12:00:00Z"));
        }
        await brain.ingest(stage("J-1", 1, { stage: "setting", jeweler: "Ana" }, "2026-10-01T12:00:00Z"));
        return (await brain.reason(ORG)).map((r) => r.id.replace(/_2026-10-02$/, "")).sort();
      } finally {
        vi.useRealTimers();
      }
    };
    // 8 hours against Ana's 6 hours a day on 6 working days: room.
    expect(await run({})).toEqual([]);
    // One working day in the week at an hour a day: over.
    const oneDay = storeHours("America/New_York", "fri 10:00-18:00", "");
    expect(await run({ storeHours: oneDay, production: { dailyHours: { all: 1 } } })).toEqual(["rec_production_capacity_shop"]);
    expect(await run({ production: { dailyHours: { all: 1 } } })).toEqual(["rec_production_capacity_shop"]);
    expect(await run({ storeHours: oneDay })).toEqual(["rec_production_capacity_shop"]);
  });

  it("refuses unknown departments", () => {
    expect(() => pipeline(["manufacturing"])).toThrow("unknown departments: manufacturing");
  });
});

describe("the store's hours", () => {
  // Wednesday 2026-11-18: 16:00 in New York and 13:00 in Los Angeles. The rule runs four Los Angeles hours later.
  const SENT = "2026-11-18T21:00:00.000Z";
  const NOW = "2026-11-19T01:00:00.000Z";

  afterEach(() => vi.useRealTimers());

  async function awaiting(settings: Partial<InstancePipelineOptions>) {
    const memory = new InMemoryStore();
    const brain = createInstancePipeline({ memory, documentation: new StaticDocumentationSource([]), departments: [], ...settings });
    await brain.ingest({
      id: "evt_quo",
      organizationId: ORG,
      source: "quo",
      type: "communication.message_logged",
      occurredAt: SENT,
      receivedAt: SENT,
      idempotencyKey: "quo-1",
      payload: { system: "Quo", channel: "sms", messageId: "quo:message:1", direction: "inbound", customerRefs: ["form_customer:hoursphone"] },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const recommendations = await brain.reason(ORG);
    vi.useRealTimers();
    return recommendations.filter((r) => r.id.startsWith("rec_clienteling_awaiting_reply_")).map((r) => r.id);
  }

  it("counts the instance's hours and threshold in the awaiting-reply rule", async () => {
    // Two hours of New York's default 10 to 6: short of four.
    expect(await awaiting({})).toEqual([]);
    const la = storeHours("America/Los_Angeles", "mon-fri 10:00-18:00; sat 10:00-17:00; sun closed");
    expect(await awaiting({ storeHours: la })).toEqual(["rec_clienteling_awaiting_reply_others_2026-11-19"]);
    expect(await awaiting({ storeHours: la, awaitingReplyHours: 5 })).toEqual([]);
    expect(await awaiting({ awaitingReplyHours: 2 })).toEqual(["rec_clienteling_awaiting_reply_others_2026-11-19"]);
    // Wednesday is a closed date: no open hours at all.
    expect(await awaiting({ storeHours: storeHours("America/Los_Angeles", "mon-fri 10:00-18:00", "2026-11-18"), awaitingReplyHours: 1 })).toEqual([]);
  });
});
