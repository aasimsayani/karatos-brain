import { describe, expect, it } from "vitest";
import {
  BrainPipeline,
  InMemoryStore,
  type EventEnvelope,
  type Normalizer,
  type Reasoner,
  type SignalExtractor,
} from "../src/index.js";

const ORG = "fuse-jewelry";

function orderEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_1",
    organizationId: ORG,
    source: "shopify",
    type: "order.created",
    occurredAt: "2026-10-01T12:00:00Z",
    receivedAt: "2026-10-01T12:00:01Z",
    idempotencyKey: "shopify-order-1001",
    payload: { orderId: "1001", totalCents: 125_000, sku: "RING-14K-01" },
    ...overrides,
  };
}

const orderNormalizer: Normalizer = {
  name: "shopify-orders",
  supports: (e) => e.source === "shopify" && e.type === "order.created",
  normalize: (e) => [
    {
      ref: { kind: "order", id: String(e.payload.orderId) },
      organizationId: e.organizationId,
      attributes: { totalCents: e.payload.totalCents, sku: e.payload.sku },
      sourceEventIds: [e.id],
      updatedAt: e.occurredAt,
    },
  ],
};

const largeOrderExtractor: SignalExtractor = {
  name: "large-order",
  extract: (entities, e) =>
    entities
      .filter((en) => en.ref.kind === "order" && Number(en.attributes.totalCents) >= 100_000)
      .map((en) => ({
        id: `sig_${en.ref.id}`,
        organizationId: en.organizationId,
        kind: "order.large",
        subject: en.ref,
        value: Number(en.attributes.totalCents),
        confidence: 1,
        derivedFromEventIds: [e.id],
        observedAt: e.occurredAt,
      })),
};

const followUpReasoner: Reasoner = {
  name: "follow-up",
  reason: ({ organizationId, signals }) =>
    signals
      .filter((s) => s.kind === "order.large")
      .map((s) => ({
        id: `rec_${s.id}`,
        organizationId,
        summary: `Send a personal thank-you for order ${s.subject.id}`,
        confidence: 0.8,
        expectedImpact: "Higher repeat purchase rate from high-value customers",
        provenance: { eventIds: s.derivedFromEventIds, signalIds: [s.id], documentIds: [] },
        degraded: false,
        createdAt: "2026-10-01T12:00:02Z",
      })),
};

function build(stale = false) {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({
    memory,
    normalizers: [orderNormalizer],
    extractors: [largeOrderExtractor],
    reasoners: [followUpReasoner],
    documentation: { current: () => ({ documentIds: ["doc_architecture"], stale }) },
  });
  return { memory, pipeline };
}

describe("BrainPipeline", () => {
  it("runs an event through every layer to a recommendation", async () => {
    const { memory, pipeline } = build();
    const result = await pipeline.ingest(orderEvent());
    expect(result.duplicate).toBe(false);
    expect(result.entities).toHaveLength(1);
    expect(result.signals.map((s) => s.kind)).toEqual(["order.large"]);

    const recs = await pipeline.reason(ORG);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.degraded).toBe(false);
    expect(recs[0]?.provenance).toEqual({
      eventIds: ["evt_1"],
      signalIds: ["sig_1001"],
      documentIds: ["doc_architecture"],
    });
    expect(memory.recommendations).toHaveLength(1);
  });

  it("ignores a replayed event with the same idempotency key", async () => {
    const { memory, pipeline } = build();
    await pipeline.ingest(orderEvent());
    const replay = await pipeline.ingest(orderEvent({ id: "evt_2" }));
    expect(replay.duplicate).toBe(true);
    expect(memory.events).toHaveLength(1);
    expect(memory.signals).toHaveLength(1);
  });

  it("rejects malformed events before they reach memory", async () => {
    const { memory, pipeline } = build();
    await expect(pipeline.ingest({ ...orderEvent(), type: "OrderCreated" })).rejects.toThrow();
    expect(memory.events).toHaveLength(0);
  });

  it("marks recommendations degraded when documentation is stale", async () => {
    const { pipeline } = build(true);
    await pipeline.ingest(orderEvent());
    const recs = await pipeline.reason(ORG);
    expect(recs[0]?.degraded).toBe(true);
  });
});
