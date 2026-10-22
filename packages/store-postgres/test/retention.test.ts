import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  BrainPipeline,
  DeadLetteredError,
  sha256Json,
  type EventEnvelope,
  type Normalizer,
  type Reasoner,
  type SignalExtractor,
} from "@karatos/core";
import { loadMigrations, migrate, PostgresIngestionLog, PostgresMemoryStore, type SqlClient } from "../src/index.js";
import { freshDatabase, MIGRATIONS_DIR, pgliteClient } from "./helpers.js";

const ORG = "test-jeweler";
const OTHER = "other-jeweler";
const NOW = new Date("2026-10-22T00:00:00.000Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const SHA = (c: string) => c.repeat(64);

const order = (n: string, receivedAt: string, organizationId = ORG): EventEnvelope => ({
  id: `evt_${n}`,
  organizationId,
  source: "shopify",
  type: "order.created",
  occurredAt: receivedAt,
  receivedAt,
  idempotencyKey: `shopify:order:${n}:v1`,
  payload: { orderId: `shopify:order:${n}`, totalCents: 125_00, note: "raw vendor detail" },
});

const normalizer: Normalizer = {
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
};

const extractor: SignalExtractor = {
  name: "sales",
  extract: (entities, e) =>
    entities.map((entity) => ({
      id: `sig_${e.id}`,
      organizationId: e.organizationId,
      kind: "sale",
      subject: entity.ref,
      value: Number(entity.attributes.totalCents),
      confidence: 1,
      derivedFromEventIds: [e.id],
      observedAt: e.occurredAt,
    })),
};

const reasoner: Reasoner = {
  name: "restock",
  reason: ({ organizationId, signals, now }) => [
    {
      id: `rec_${organizationId}`,
      organizationId,
      summary: "Restock the best seller",
      confidence: 0.8,
      expectedImpact: "more sales",
      provenance: { eventIds: signals.flatMap((s) => s.derivedFromEventIds), signalIds: signals.map((s) => s.id), documentIds: [] },
      degraded: false,
      createdAt: now,
    },
  ],
};

async function scenario() {
  const { client } = await freshDatabase();
  await client.query("insert into organizations (id, name) values ($1, 'Test'), ($2, 'Other')", [ORG, OTHER]);
  const store = new PostgresMemoryStore(client);
  const log = new PostgresIngestionLog(client);
  let clock = NOW;
  const pipeline = new BrainPipeline({
    memory: store,
    normalizers: [normalizer],
    extractors: [extractor],
    reasoners: [reasoner],
    documentation: { current: () => ({ documentIds: [], stale: false }) },
    now: () => clock,
  });
  const old = order("1", ago(30 * DAY + 1));
  const boundary = order("2", ago(30 * DAY));
  const fresh = order("3", ago(DAY));
  const otherOrg = order("4", ago(90 * DAY), OTHER);
  for (const e of [old, boundary, fresh, otherOrg]) await pipeline.ingest(e);
  await pipeline.reason(ORG);
  await log.linkEntities({
    organizationId: ORG,
    from: { kind: "order", id: "shopify:order:1" },
    relation: "placed_by",
    to: { kind: "customer", id: "c1" },
    sourceEventIds: [old.id],
  });
  await log.recordWrite({ organizationId: ORG, integration: "shopify", action: "adjust_inventory", requestedBy: "owner", outcome: "failed", error: "vendor timed out", at: ago(40 * DAY) });
  const run = await log.startSyncRun({ organizationId: ORG, source: "shopify", stream: "orders", mode: "historical", cursorBefore: null });
  await log.finishSyncRun(run, { ingested: 3, duplicates: 0, deadLettered: 0, batches: 1, cursor: "c1" });
  await store.linkIdentity({ organizationId: ORG, source: "shopify", externalId: "1", entity: { kind: "order", id: "shopify:order:1" } });
  await client.query(
    `insert into memories (organization_id, content, source_refs) values ($1, 'Busy before holidays', '[{"system":"shopify","recordId":"shopify:order:1"}]');
     insert into decisions (id, organization_id, recommendation_id, decision, decided_by) values ('00000000-0000-4000-8000-000000000001', $1, $2, 'accepted', 'owner');
     insert into outcomes (organization_id, decision_id, metric, value) values ($1, '00000000-0000-4000-8000-000000000001', 'sales', 3);`.replace(/\$1/g, `'${ORG}'`).replace(/\$2/g, `'rec_${ORG}'`),
  );
  const setClock = (d: Date) => (clock = d);
  return { client, store, log, pipeline, setClock, old, boundary, fresh, otherOrg };
}

const KEPT_TABLES = [
  "entities",
  "signals",
  "recommendations",
  "decisions",
  "outcomes",
  "memories",
  "entity_links",
  "identities",
  "sync_runs",
  "audit_log",
  "write_audit",
  "reasoning_runs",
  "webhook_deliveries",
  "integration_connections",
];

async function kept(client: SqlClient) {
  const out: Record<string, unknown[]> = {};
  for (const t of KEPT_TABLES) {
    out[t] = (await client.query(`select to_jsonb(t) - 'search' as row from ${t} t order by to_jsonb(t)::text`)).rows;
  }
  return out;
}

describe("retention migration", () => {
  it("turns on row-level security for retention_runs and keeps tenants apart", async () => {
    const { client } = await freshDatabase();
    await client.query("insert into organizations (id, name) values ($1, 'Test'), ($2, 'Other')", [ORG, OTHER]);
    const { rows } = await client.query<{ relrowsecurity: boolean; policies: number }>(
      `select relrowsecurity, (select count(*)::int from pg_policies where tablename = 'retention_runs') as policies
       from pg_class where relname = 'retention_runs'`,
    );
    expect(rows).toEqual([{ relrowsecurity: true, policies: 1 }]);
    await new PostgresMemoryStore(client).purgeRawData(ORG, NOW);
    await new PostgresMemoryStore(client).purgeRawData(OTHER, NOW);
    await client.query(`
      create role retention_user;
      grant select, insert on all tables in schema public to retention_user;
      set role retention_user;
      select set_config('request.jwt.claims', '{"organization_id": "${ORG}"}', false);
    `);
    const seen = await client.query<{ organization_id: string }>("select organization_id from retention_runs");
    expect(seen.rows).toEqual([{ organization_id: ORG }]);
    await expect(
      client.query(
        `insert into retention_runs (organization_id, ran_at, cutoff, retention_days) values ('${OTHER}', now(), now() - interval '30 days', 30)`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("keeps retention runs append-only and within the allowed window", async () => {
    const { client } = await freshDatabase();
    await client.query("insert into organizations (id, name) values ($1, 'Test')", [ORG]);
    await new PostgresMemoryStore(client).purgeRawData(ORG, NOW);
    await expect(client.query("update retention_runs set events_cleared = 5")).rejects.toThrow(/append-only/);
    await expect(client.query("delete from retention_runs")).rejects.toThrow(/append-only/);
    await expect(
      client.query(`insert into retention_runs (organization_id, ran_at, cutoff, retention_days) values ('${ORG}', now(), now() - interval '1 day', 366)`),
    ).rejects.toThrow(/retention_days/);
  });

  it("gives events stored before it a source reference and hash", async () => {
    const client = pgliteClient(new PGlite());
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    const last = migrations.findIndex((m) => m.name.includes("raw_retention"));
    expect(last).toBeGreaterThan(0);
    await migrate(client, migrations.slice(0, last));
    await client.query(`
      insert into organizations (id, name) values ('${ORG}', 'Test');
      insert into events (id, organization_id, source, type, occurred_at, received_at, idempotency_key, payload)
        values ('e_old', '${ORG}', 'stripe', 'payment.charge_updated', now(), now(), 'stripe:charge:ch_1:paid', '{"chargeId": "stripe:charge:ch_1"}');
      insert into dead_letter_events (id, organization_id, source, reason, raw, received_at)
        values ('dl_old', '${ORG}', 'stripe', 'validation_failed', '{"idempotencyKey": "stripe:charge:ch_2"}', now()),
               ('dl_text', '${ORG}', 'stripe', 'validation_failed', '"not an object"', now());
    `);
    await migrate(client, migrations);
    const { rows } = await client.query<{ source_record_id: string; payload_sha256: string }>("select source_record_id, payload_sha256 from events");
    expect(rows[0]?.source_record_id).toBe("stripe:charge:ch_1:paid");
    expect(rows[0]?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    const dl = await client.query<{ id: string; source_record_id: string | null; raw_sha256: string }>(
      "select id, source_record_id, raw_sha256 from dead_letter_events order by id",
    );
    expect(dl.rows.map((r) => [r.id, r.source_record_id])).toEqual([
      ["dl_old", "stripe:charge:ch_2"],
      ["dl_text", null],
    ]);
    expect(dl.rows.every((r) => /^[0-9a-f]{64}$/.test(r.raw_sha256))).toBe(true);
  });

  it("fills the source reference for raw inserts, and allows only one retention clear per event", async () => {
    const { client } = await freshDatabase();
    await client.query(`
      insert into organizations (id, name) values ('${ORG}', 'Test');
      insert into events (id, organization_id, source, type, occurred_at, received_at, idempotency_key)
        values ('e1', '${ORG}', 'manual', 'order.created', now(), now(), 'k1');
    `);
    const row = await client.query<{ source_record_id: string; payload_sha256: string }>("select source_record_id, payload_sha256 from events");
    expect(row.rows[0]?.source_record_id).toBe("k1");
    expect(row.rows[0]?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    const tombstone = `jsonb_build_object('cleared', true, 'at', '2026-10-22T00:00:00.000Z', 'reason', 'retention')`;
    // Anything but the tombstone, or a tombstone that also changes another column, is rejected.
    await expect(client.query("update events set payload = '{}', payload_cleared_at = now()")).rejects.toThrow(/append-only/);
    await expect(client.query(`update events set payload = ${tombstone}`)).rejects.toThrow(/append-only/);
    await expect(client.query(`update events set payload = ${tombstone}, payload_cleared_at = now(), idempotency_key = 'k2'`)).rejects.toThrow(/append-only/);
    await expect(client.query(`update events set payload = ${tombstone}, payload_cleared_at = now(), source_record_id = 'x'`)).rejects.toThrow(/append-only/);
    await expect(client.query(`update events set payload = ${tombstone}, payload_cleared_at = now(), payload_sha256 = '${SHA("0")}'`)).rejects.toThrow(/append-only/);
    await client.query(`update events set payload = ${tombstone}, payload_cleared_at = now()`);
    await expect(client.query(`update events set payload = ${tombstone}, payload_cleared_at = now()`)).rejects.toThrow(/append-only/);
    await expect(client.query("delete from events")).rejects.toThrow(/append-only/);
    await expect(
      client.query(
        `insert into events (id, organization_id, source, type, occurred_at, received_at, idempotency_key, source_url)
         values ('e2', '${ORG}', 'manual', 'order.created', now(), now(), 'k2', 'javascript:alert(1)')`,
      ),
    ).rejects.toThrow(/source_url/);
  });
});

describe("PostgresMemoryStore.purgeRawData", () => {
  it("clears payloads older than the window and keeps the one exactly 30 days old", async () => {
    const { store, old, boundary, fresh } = await scenario();
    const result = await store.purgeRawData(ORG, NOW);
    expect(result).toEqual({
      organizationId: ORG,
      ranAt: NOW.toISOString(),
      cutoff: ago(30 * DAY),
      retentionDays: 30,
      events: 1,
      deadLetters: 0,
      fileImports: 0,
    });
    const cleared = await store.getEvent(ORG, old.id);
    expect(cleared).toEqual({
      ...old,
      payload: { cleared: true, at: NOW.toISOString(), reason: "retention" },
      sourceRef: { system: "shopify", recordId: "shopify:order:1" },
      payloadSha256: sha256Json(old.payload),
      payloadClearedAt: NOW.toISOString(),
    });
    expect(await store.getEvent(ORG, boundary.id)).toMatchObject({ payload: boundary.payload, payloadClearedAt: null });
    expect(await store.getEvent(ORG, fresh.id)).toMatchObject({ payload: fresh.payload, payloadClearedAt: null });
  });

  it("honours a shorter window and rejects one out of range", async () => {
    const { store } = await scenario();
    expect((await store.purgeRawData(ORG, NOW, 1)).events).toBe(2);
    await expect(store.purgeRawData(ORG, NOW, 0)).rejects.toThrow(RangeError);
  });

  it("never deletes a row and leaves facts, signals, links, runs and audit rows untouched", async () => {
    const { client, store } = await scenario();
    const before = await kept(client);
    expect(before.entities).toHaveLength(4);
    expect(before.signals).toHaveLength(4);
    expect(before.entity_links).toHaveLength(1);
    expect(before.memories).toHaveLength(1);
    await store.purgeRawData(ORG, NOW);
    expect(await kept(client)).toEqual(before);
    const { rows } = await client.query<{ n: number }>("select count(*)::int as n from events");
    expect(rows[0]?.n).toBe(4);
  });

  it("still treats a replay of a cleared event as a duplicate", async () => {
    const { store, pipeline, old, setClock } = await scenario();
    await store.purgeRawData(ORG, NOW);
    setClock(new Date(NOW.getTime() + DAY));
    const replay = await pipeline.ingest({ ...old, id: "evt_replayed", receivedAt: NOW.toISOString() });
    expect(replay.duplicate).toBe(true);
    expect(await store.getEvent(ORG, "evt_replayed")).toBeNull();
    expect((await store.getEvent(ORG, old.id))?.idempotencyKey).toBe(old.idempotencyKey);
  });

  it("keeps signal and recommendation provenance resolvable to the source record", async () => {
    const { store, old } = await scenario();
    await store.purgeRawData(ORG, NOW);
    const signals = await store.recentSignals(ORG, 10);
    const recommendation = (await store.getRecommendation(ORG, `rec_${ORG}`))!;
    expect(recommendation.provenance.eventIds).toContain(old.id);
    for (const id of [...signals.flatMap((s) => s.derivedFromEventIds), ...recommendation.provenance.eventIds]) {
      const stored = await store.getEvent(ORG, id);
      expect(stored?.sourceRef.system).toBe("shopify");
      expect(stored?.sourceRef.recordId).toMatch(/^shopify:order:\d$/);
    }
    expect(await store.getEntity(ORG, "order", "shopify:order:1")).toMatchObject({ attributes: { totalCents: 125_00 }, sourceEventIds: [old.id] });
  });

  it("keeps a declared vendor link after clearing", async () => {
    const { store, pipeline } = await scenario();
    const linked = { ...order("7", ago(60 * DAY)), sourceRecord: { id: "7", url: "https://admin.example.test/orders/7" } };
    await pipeline.ingest(linked);
    await store.purgeRawData(ORG, NOW);
    expect((await store.getEvent(ORG, linked.id))?.sourceRef).toEqual({ system: "shopify", recordId: "7", url: "https://admin.example.test/orders/7" });
  });

  it("is idempotent", async () => {
    const { client, store } = await scenario();
    await store.purgeRawData(ORG, NOW);
    const events = (await client.query("select * from events order by id")).rows;
    expect(await store.purgeRawData(ORG, NOW)).toMatchObject({ events: 0, deadLetters: 0, fileImports: 0 });
    expect((await client.query("select * from events order by id")).rows).toEqual(events);
  });

  it("only touches the organization it is asked to", async () => {
    const { client, store, log, otherOrg } = await scenario();
    for (const org of [ORG, OTHER]) {
      await log.recordFileImport({
        organizationId: org,
        source: "bank_statements",
        fileName: "statement.csv",
        mediaType: "text/csv",
        sha256: org === ORG ? SHA("a") : SHA("b"),
        byteSize: 10,
        storagePath: `imports/${org}/statement.csv`,
        uploadedBy: "owner",
      });
      await client.query(
        `insert into dead_letter_events (id, organization_id, source, reason, raw, received_at) values ($1, $2, 'shopify', 'validation_failed', '{"x": 1}', $3)`,
        [`dl_${org}`, org, ago(40 * DAY)],
      );
    }
    await client.query("update file_imports set uploaded_at = $1", [ago(40 * DAY)]);
    expect(await store.purgeRawData(ORG, NOW)).toMatchObject({ events: 1, deadLetters: 1, fileImports: 1 });
    expect((await store.getEvent(OTHER, otherOrg.id))?.payload).toEqual(otherOrg.payload);
    const files = await client.query<{ organization_id: string; cleared: boolean }>(
      "select organization_id, contents_cleared_at is not null as cleared from file_imports order by organization_id",
    );
    expect(files.rows).toEqual([
      { organization_id: OTHER, cleared: false },
      { organization_id: ORG, cleared: true },
    ]);
    const dls = await client.query<{ id: string; raw: unknown }>("select id, raw from dead_letter_events order by id");
    expect(dls.rows).toEqual([
      { id: `dl_${OTHER}`, raw: { x: 1 } },
      { id: `dl_${ORG}`, raw: { cleared: true, at: NOW.toISOString(), reason: "retention" } },
    ]);
    const clearedAt = (await client.query("select id, contents_cleared_at from file_imports order by id")).rows;
    // Running again a day later clears nothing new and keeps the first clearing times.
    expect(await store.purgeRawData(ORG, new Date(NOW.getTime() + 1))).toMatchObject({ deadLetters: 0, fileImports: 0 });
    expect((await client.query("select id, contents_cleared_at from file_imports order by id")).rows).toEqual(clearedAt);
  });

  it("clears dead-lettered input past the window and keeps its hash, reason and record id", async () => {
    const { client } = await freshDatabase();
    await client.query("insert into organizations (id, name) values ($1, 'Test')", [ORG]);
    const store = new PostgresMemoryStore(client);
    let at = ago(31 * DAY);
    const pipeline = new BrainPipeline({
      memory: store,
      normalizers: [],
      extractors: [],
      reasoners: [],
      documentation: { current: () => ({ documentIds: [], stale: false }) },
      now: () => new Date(at),
    });
    const bad = { organizationId: ORG, source: "shopify", type: "Bad", idempotencyKey: "shopify:order:9:v1", detail: "raw" };
    await expect(pipeline.ingest(bad)).rejects.toBeInstanceOf(DeadLetteredError);
    await expect(pipeline.ingest({ type: "Bad", detail: "no organization" })).rejects.toBeInstanceOf(DeadLetteredError);
    at = ago(30 * DAY);
    await expect(pipeline.ingest({ ...bad, idempotencyKey: "shopify:order:10:v1" })).rejects.toBeInstanceOf(DeadLetteredError);
    await expect(pipeline.ingest("just text")).rejects.toBeInstanceOf(DeadLetteredError);
    expect((await store.purgeRawData(ORG, NOW)).deadLetters).toBe(2);
    const { rows } = await client.query<{ source_record_id: string | null; raw_sha256: string; reason: string; cleared: boolean; issues: unknown[] }>(
      "select source_record_id, raw_sha256, reason, raw_cleared_at is not null as cleared, issues from dead_letter_events order by received_at, source_record_id nulls first",
    );
    expect(rows.map((r) => [r.source_record_id, r.cleared])).toEqual([
      [null, true],
      ["shopify:order:9:v1", true],
      [null, false],
      ["shopify:order:10:v1", false],
    ]);
    expect(rows[1]?.raw_sha256).toBe(sha256Json(bad));
    expect(rows.every((r) => r.reason === "validation_failed" && r.issues.length > 0)).toBe(true);
    expect((await store.purgeRawData(ORG, NOW)).deadLetters).toBe(0);
  });

  it("records every run so the owner can see it ran", async () => {
    const { client, store } = await scenario();
    await store.purgeRawData(ORG, NOW);
    await store.purgeRawData(ORG, NOW, 7);
    const { rows } = await client.query(
      "select organization_id, ran_at, cutoff, retention_days, events_cleared, dead_letters_cleared, file_imports_cleared from retention_runs order by retention_days desc",
    );
    expect(rows).toEqual([
      { organization_id: ORG, ran_at: NOW, cutoff: new Date(ago(30 * DAY)), retention_days: 30, events_cleared: 1, dead_letters_cleared: 0, file_imports_cleared: 0 },
      { organization_id: ORG, ran_at: NOW, cutoff: new Date(ago(7 * DAY)), retention_days: 7, events_cleared: 1, dead_letters_cleared: 0, file_imports_cleared: 0 },
    ]);
  });

  it("returns null for events it doesn't hold", async () => {
    const { store } = await scenario();
    expect(await store.getEvent(ORG, "missing")).toBeNull();
    expect(await store.getEvent(OTHER, "evt_1")).toBeNull();
  });
});
