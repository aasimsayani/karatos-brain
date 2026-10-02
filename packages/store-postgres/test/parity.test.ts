import { describe, expect, it } from "vitest";
import { BrainPipeline, DeadLetteredError, IdentityCollisionError } from "@karatos/core";
import { PostgresMemoryStore } from "../src/index.js";
import { freshDatabase } from "./helpers.js";

const ORG = "fuse-jewelry";

async function setup() {
  const { client } = await freshDatabase();
  await client.query("insert into organizations (id, name) values ($1, $2)", [ORG, "Fuse Jewelry"]);
  const store = new PostgresMemoryStore(client);
  return { client, store };
}

describe("PostgresMemoryStore (Brain A parity)", () => {
  it("stores dead letters, even for unknown organizations", async () => {
    const { client, store } = await setup();
    const pipeline = new BrainPipeline({
      memory: store,
      normalizers: [],
      extractors: [],
      reasoners: [],
      documentation: { current: () => ({ documentIds: [], stale: false }) },
    });
    await expect(pipeline.ingest({ organizationId: ORG, source: "shopify", type: "Bad" })).rejects.toBeInstanceOf(
      DeadLetteredError,
    );
    await expect(pipeline.ingest({ organizationId: "nobody", type: "Bad" })).rejects.toBeInstanceOf(DeadLetteredError);
    const { rows } = await client.query<{ organization_id: string | null; source: string | null; reason: string }>(
      "select organization_id, source, reason from dead_letter_events order by received_at, organization_id nulls last",
    );
    expect(rows).toEqual([
      { organization_id: ORG, source: "shopify", reason: "validation_failed" },
      { organization_id: null, source: null, reason: "validation_failed" },
    ]);
  });

  it("reads entities back and accepts department-defined kinds", async () => {
    const { client, store } = await setup();
    await store.upsertEntities([
      {
        ref: { kind: "repair_ticket", id: "R-100" },
        organizationId: ORG,
        attributes: { status: "received" },
        sourceEventIds: ["e1"],
        updatedAt: "2026-10-01T00:00:00Z",
      },
    ]);
    expect(await store.getEntity(ORG, "repair_ticket", "R-100")).toEqual({
      ref: { kind: "repair_ticket", id: "R-100" },
      organizationId: ORG,
      attributes: { status: "received" },
      sourceEventIds: ["e1"],
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(await store.getEntity(ORG, "repair_ticket", "missing")).toBeNull();
    await expect(
      client.query("insert into entities (organization_id, kind, id, updated_at) values ($1, 'Bad Kind', 'x', now())", [ORG]),
    ).rejects.toThrow(/entities_kind_format/);
  });

  it("links identities idempotently and refuses collisions", async () => {
    const { store } = await setup();
    const link = { organizationId: ORG, source: "shopify", externalId: "c1", entity: { kind: "customer", id: "cust_1" } };
    await store.linkIdentity(link);
    await store.linkIdentity(link);
    expect(await store.resolveIdentity(ORG, "shopify", "c1")).toEqual({ kind: "customer", id: "cust_1" });
    expect(await store.resolveIdentity(ORG, "shopify", "nope")).toBeNull();
    await expect(store.linkIdentity({ ...link, entity: { kind: "customer", id: "cust_2" } })).rejects.toBeInstanceOf(
      IdentityCollisionError,
    );
  });

  it("records reasoning runs and lists recommendations newest first", async () => {
    const { client, store } = await setup();
    const rec = (id: string, createdAt: string) => ({
      id,
      organizationId: ORG,
      summary: id,
      confidence: 0.25,
      expectedImpact: "x",
      provenance: { eventIds: [], signalIds: [], documentIds: [] },
      degraded: false,
      createdAt,
    });
    await store.saveRecommendations([rec("old", "2026-10-01T00:00:00Z"), rec("new", "2026-10-02T00:00:00Z")]);
    await store.recordReasoningRun({
      id: "run_1",
      organizationId: ORG,
      startedAt: "2026-10-02T00:00:00Z",
      finishedAt: "2026-10-02T00:00:01Z",
      reasoners: ["r"],
      documentation: { documentIds: [], stale: true, reason: "none" },
      degraded: true,
      recommendationIds: ["old", "new"],
    });

    expect((await store.listRecommendations(ORG, 10)).map((r) => r.id)).toEqual(["new", "old"]);
    expect(await store.getRecommendation(ORG, "old")).toMatchObject({ confidence: 0.25, createdAt: "2026-10-01T00:00:00.000Z" });
    expect(await store.getRecommendation(ORG, "nope")).toBeNull();
    const { rows } = await client.query<{ degraded: boolean }>("select degraded from reasoning_runs");
    expect(rows).toEqual([{ degraded: true }]);
  });

  it("tracks decisions and outcomes against recommendations", async () => {
    const { client, store } = await setup();
    await store.saveRecommendations([
      {
        id: "rec_1",
        organizationId: ORG,
        summary: "Reorder 14k bands",
        confidence: 0.8,
        expectedImpact: "Avoid stockout",
        provenance: { eventIds: [], signalIds: [], documentIds: [] },
        degraded: false,
        createdAt: "2026-10-01T00:00:00Z",
      },
    ]);
    const { rows } = await client.query<{ id: string }>(
      "insert into decisions (organization_id, recommendation_id, decision, decided_by) values ($1, 'rec_1', 'approved', 'owner') returning id",
      [ORG],
    );
    await client.query("insert into outcomes (organization_id, decision_id, metric, value) values ($1, $2, 'units_sold', 12)", [
      ORG,
      rows[0]!.id,
    ]);
    const audit = await client.query<{ table_name: string }>(
      "select table_name from audit_log where table_name in ('decisions', 'outcomes') order by id",
    );
    expect(audit.rows.map((r) => r.table_name)).toEqual(["decisions", "outcomes"]);
  });

  it("searches memories by text", async () => {
    const { client } = await setup();
    await client.query(
      `insert into memories (organization_id, content) values
         ($1, 'Customer prefers rose gold and lab-grown diamonds'),
         ($1, 'Supplier ships castings on Tuesdays')`,
      [ORG],
    );
    const { rows } = await client.query<{ content: string }>(
      "select content from memories where organization_id = $1 and search @@ plainto_tsquery('english', 'diamond')",
      [ORG],
    );
    expect(rows.map((r) => r.content)).toEqual(["Customer prefers rose gold and lab-grown diamonds"]);
  });
});
