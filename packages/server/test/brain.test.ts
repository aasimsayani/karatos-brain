import { afterEach, describe, expect, it, vi } from "vitest";
import { DeadLetteredError, InMemoryStore } from "@karatos/core";
import { storeHours } from "@karatos/retail";
import { createInstancePipeline, StaticDocumentationSource, type InstancePipelineOptions } from "../src/index.js";

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
