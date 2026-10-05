import { describe, expect, it } from "vitest";
import { DeadLetteredError, InMemoryStore } from "@karatos/core";
import { createInstancePipeline, StaticDocumentationSource } from "../src/index.js";

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
