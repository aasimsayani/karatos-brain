import { describe, expect, it } from "vitest";
import { BrainPipeline, type EventEnvelope, type Reasoner, type SignalExtractor } from "@karatos/core";
import { PostgresMemoryStore } from "../src/index.js";
import { freshDatabase } from "./helpers.js";

const ORG = "fuse-jewelry";

const event: EventEnvelope = {
  id: "evt_1",
  organizationId: ORG,
  source: "shopify",
  type: "order.created",
  occurredAt: "2026-10-01T12:00:00Z",
  receivedAt: "2026-10-01T12:00:01Z",
  idempotencyKey: "shopify-order-1001",
  payload: { orderId: "1001", totalCents: 125_000 },
};

const extractor: SignalExtractor = {
  name: "order-total",
  extract: (entities, e) =>
    entities.map((en) => ({
      id: `sig_${en.ref.id}`,
      organizationId: en.organizationId,
      kind: "order.total",
      subject: en.ref,
      value: Number(en.attributes.totalCents),
      confidence: 1,
      derivedFromEventIds: [e.id],
      observedAt: e.occurredAt,
    })),
};

const reasoner: Reasoner = {
  name: "thank-you",
  reason: ({ organizationId, signals }) =>
    signals.map((s) => ({
      id: `rec_${s.id}`,
      organizationId,
      summary: `Thank the customer for order ${s.subject.id}`,
      confidence: 0.7,
      expectedImpact: "Repeat purchases",
      provenance: { eventIds: s.derivedFromEventIds, signalIds: [s.id], documentIds: [] },
      degraded: false,
      createdAt: "2026-10-01T12:00:02Z",
    })),
};

async function setup() {
  const { client } = await freshDatabase();
  await client.query("insert into organizations (id, name) values ($1, $2)", [ORG, "Fuse Jewelry"]);
  const store = new PostgresMemoryStore(client);
  const pipeline = new BrainPipeline({
    memory: store,
    normalizers: [
      {
        name: "orders",
        supports: (e) => e.type === "order.created",
        normalize: (e) => [
          {
            ref: { kind: "order", id: String(e.payload.orderId) },
            organizationId: e.organizationId,
            attributes: { totalCents: e.payload.totalCents },
            sourceEventIds: [e.id],
            updatedAt: e.occurredAt,
          },
        ],
      },
    ],
    extractors: [extractor],
    reasoners: [reasoner],
    documentation: { current: () => ({ documentIds: ["doc_arch"], stale: false }) },
  });
  return { client, store, pipeline };
}

describe("PostgresMemoryStore", () => {
  it("runs the full pipeline against Postgres", async () => {
    const { client, pipeline } = await setup();
    await pipeline.ingest(event);
    const recs = await pipeline.reason(ORG);

    expect(recs).toHaveLength(1);
    const { rows } = await client.query<{ provenance: unknown; degraded: boolean }>(
      "select provenance, degraded from recommendations",
    );
    expect(rows[0]).toEqual({
      provenance: { eventIds: ["evt_1"], signalIds: ["sig_1001"], documentIds: ["doc_arch"] },
      degraded: false,
    });
  });

  it("deduplicates replayed events by idempotency key", async () => {
    const { client, pipeline } = await setup();
    await pipeline.ingest(event);
    const replay = await pipeline.ingest({ ...event, id: "evt_2" });
    expect(replay.duplicate).toBe(true);
    const { rows } = await client.query<{ n: number }>("select count(*)::int as n from events");
    expect(rows[0]?.n).toBe(1);
  });

  it("round-trips signals in insertion order", async () => {
    const { store, pipeline } = await setup();
    await pipeline.ingest(event);
    // "0999" sorts before "1001" by id, so this proves ordering is by insertion, not id.
    await pipeline.ingest({ ...event, id: "evt_3", idempotencyKey: "k3", payload: { orderId: "0999", totalCents: 5_000 } });
    const signals = await store.recentSignals(ORG, 10);
    expect(signals.map((s) => s.subject.id)).toEqual(["1001", "0999"]);
    expect((await store.recentSignals(ORG, 1)).map((s) => s.subject.id)).toEqual(["0999"]);
    expect(signals[0]).toMatchObject({ confidence: 1, value: 125_000, observedAt: "2026-10-01T12:00:00.000Z" });
  });

  it("does not let an older entity version overwrite a newer one", async () => {
    const { client, store } = await setup();
    const base = { ref: { kind: "order" as const, id: "1" }, organizationId: ORG };
    await store.upsertEntities([{ ...base, attributes: { v: 2 }, sourceEventIds: ["b"], updatedAt: "2026-10-02T00:00:00Z" }]);
    await store.upsertEntities([{ ...base, attributes: { v: 1 }, sourceEventIds: ["a"], updatedAt: "2026-10-01T00:00:00Z" }]);
    const { rows } = await client.query<{ attributes: { v: number } }>("select attributes from entities");
    expect(rows[0]?.attributes.v).toBe(2);
  });

  it("records feedback and writes the audit log", async () => {
    const { client, store, pipeline } = await setup();
    await pipeline.ingest(event);
    const [rec] = await pipeline.reason(ORG);
    await store.recordFeedback({
      recommendationId: rec!.id,
      organizationId: ORG,
      outcome: "overridden",
      note: "Already called them",
      actor: "peenaz",
      recordedAt: "2026-10-01T13:00:00Z",
    });
    const { rows } = await client.query<{ table_name: string }>("select table_name from audit_log order by id");
    expect(rows.map((r) => r.table_name)).toEqual(["entities", "recommendations", "feedback"]);
  });

  it("saves and resumes sync checkpoints", async () => {
    const { store } = await setup();
    expect(await store.getCheckpoint(ORG, "shopify", "orders")).toBeNull();
    await store.saveCheckpoint(ORG, "shopify", "orders", "cursor-1");
    await store.saveCheckpoint(ORG, "shopify", "orders", "cursor-2");
    expect(await store.getCheckpoint(ORG, "shopify", "orders")).toBe("cursor-2");
  });
});
