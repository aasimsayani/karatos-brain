import { describe, expect, it } from "vitest";
import { WriteGate, WritesDisabledError, READ_ONLY } from "@karatos/core";
import { PostgresIngestionLog, type NewFileImport } from "../src/index.js";
import { freshDatabase } from "./helpers.js";

const ORG = "demo-store";
const SHA = "a".repeat(64);

async function setup() {
  const { client } = await freshDatabase();
  await client.query("insert into organizations (id, name) values ($1, 'Demo Store'), ('other-store', 'Other')", [ORG]);
  return { client, log: new PostgresIngestionLog(client) };
}

const shopify = {
  organizationId: ORG,
  integrationId: "shopify",
  status: "connected" as const,
  access: "public_api" as const,
  secretNames: ["SHOPIFY_ADMIN_TOKEN"],
  streams: ["orders", "customers"],
  historicalFrom: "2023-01-01",
  settings: { shop: "demo" },
};

const statement: NewFileImport = {
  organizationId: ORG,
  source: "bank_statements",
  fileName: "september.pdf",
  mediaType: "application/pdf",
  sha256: SHA,
  byteSize: 2048,
  storagePath: "imports/demo-store/september.pdf",
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  uploadedBy: "owner",
};

describe("ingestion schema", () => {
  it("turns on row-level security for every new table and the migration ledger", async () => {
    const { client } = await setup();
    const { rows } = await client.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relname in ('integration_connections', 'sync_runs', 'webhook_deliveries', 'file_imports',
                         'entity_links', 'write_audit', 'schema_migrations')
       order by relname`,
    );
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it("keeps each tenant's ingestion records apart", async () => {
    const { client, log } = await setup();
    await log.upsertConnection(shopify);
    await log.upsertConnection({ ...shopify, organizationId: "other-store" });
    await client.query(`
      create role ingest_user;
      grant select, insert on all tables in schema public to ingest_user;
      set role ingest_user;
      select set_config('request.jwt.claims', '{"organization_id": "demo-store"}', false);
    `);
    const { rows } = await client.query<{ organization_id: string }>("select organization_id from integration_connections");
    expect(rows).toEqual([{ organization_id: ORG }]);
    await expect(
      client.query("insert into sync_runs (organization_id, source, stream, mode) values ('other-store', 's', 'x', 'file')"),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("PostgresIngestionLog", () => {
  it("stores connections by secret name and keeps the first connected time", async () => {
    const { client, log } = await setup();
    await log.upsertConnection(shopify);
    const first = await client.query<{ connected_at: Date }>("select connected_at from integration_connections");
    await log.upsertConnection({ ...shopify, status: "paused", streams: ["orders"] });
    expect(await log.listConnections(ORG)).toEqual([{ ...shopify, status: "paused", streams: ["orders"] }]);
    const second = await client.query<{ connected_at: Date }>("select connected_at from integration_connections");
    expect(second.rows[0]!.connected_at).toEqual(first.rows[0]!.connected_at);
    await log.upsertConnection({ ...shopify, integrationId: "bank_statements", status: "pending", access: "file", secretNames: [], historicalFrom: null });
    expect((await log.listConnections(ORG)).map((c) => [c.integrationId, c.historicalFrom])).toEqual([
      ["bank_statements", null],
      ["shopify", "2023-01-01"],
    ]);
    const audited = await client.query("select 1 from audit_log where table_name = 'integration_connections'");
    expect(audited.rows.length).toBeGreaterThan(0);
  });

  it("refuses anything that looks like a secret value instead of a secret name", async () => {
    const { log } = await setup();
    await expect(log.upsertConnection({ ...shopify, secretNames: ["shpat_0123456789abcdef"] })).rejects.toThrow(
      /integration_connections/,
    );
    await expect(log.upsertConnection({ ...shopify, integrationId: "Shopify Plus" })).rejects.toThrow(
      /integration_connections/,
    );
  });

  it("records a sync run from start to finish and stamps the connection", async () => {
    const { client, log } = await setup();
    await log.upsertConnection(shopify);
    const id = await log.startSyncRun({ organizationId: ORG, source: "shopify", stream: "orders", mode: "incremental", cursorBefore: "c1" });
    expect(await log.getSyncRun(id)).toMatchObject({ status: "running", finishedAt: null, cursorBefore: "c1" });
    await log.finishSyncRun(id, { ingested: 40, duplicates: 2, deadLettered: 1, batches: 3, cursor: "c4" });
    const run = await log.getSyncRun(id);
    expect(run).toMatchObject({
      organizationId: ORG,
      source: "shopify",
      stream: "orders",
      mode: "incremental",
      status: "succeeded",
      cursorAfter: "c4",
      batches: 3,
      ingested: 40,
      duplicates: 2,
      deadLettered: 1,
      error: null,
    });
    expect(run!.finishedAt).not.toBeNull();
    const { rows } = await client.query<{ last_synced_at: Date | null; status: string }>(
      "select last_synced_at, status from integration_connections",
    );
    expect(rows[0]!.last_synced_at).not.toBeNull();
    expect(rows[0]!.status).toBe("connected");
    await expect(log.finishSyncRun(id, { ingested: 0, duplicates: 0, deadLettered: 0, batches: 0, cursor: null })).rejects.toThrow(
      /not running/,
    );
  });

  it("records a failed run and marks the connection as erroring", async () => {
    const { client, log } = await setup();
    await log.upsertConnection(shopify);
    const id = await log.startSyncRun({ organizationId: ORG, source: "shopify", stream: "orders", mode: "historical", cursorBefore: null });
    await log.failSyncRun(id, "401 from vendor");
    expect(await log.getSyncRun(id)).toMatchObject({ status: "failed", error: "401 from vendor", ingested: 0, cursorAfter: null });
    const partial = await log.startSyncRun({ organizationId: ORG, source: "shopify", stream: "orders", mode: "historical", cursorBefore: null });
    await log.failSyncRun(partial, "timeout", { ingested: 10, duplicates: 0, deadLettered: 0, batches: 1, cursor: "c1" });
    expect(await log.getSyncRun(partial)).toMatchObject({ ingested: 10, cursorAfter: "c1" });
    const { rows } = await client.query<{ status: string; last_error: string }>("select status, last_error from integration_connections");
    expect(rows[0]).toEqual({ status: "error", last_error: "timeout" });
    expect(await log.getSyncRun("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("processes each webhook delivery once", async () => {
    const { log } = await setup();
    const delivery = { organizationId: ORG, source: "shopify", deliveryId: "d-1", topic: "orders/create", payloadSha256: SHA };
    expect(await log.recordWebhookDelivery(delivery)).toBe(true);
    expect(await log.recordWebhookDelivery(delivery)).toBe(false);
    await expect(log.recordWebhookDelivery({ ...delivery, deliveryId: "d-2", payloadSha256: "nope" })).rejects.toThrow(
      /webhook_deliveries/,
    );
  });

  it("treats the same statement uploaded twice as one import", async () => {
    const { client, log } = await setup();
    const first = await log.recordFileImport(statement);
    expect(first.duplicate).toBe(false);
    expect(await log.recordFileImport({ ...statement, fileName: "september (1).pdf" })).toEqual({ id: first.id, duplicate: true });
    const { periodStart: _start, periodEnd: _end, ...undated } = statement;
    const csv = await log.recordFileImport({ ...undated, mediaType: "text/csv", sha256: "b".repeat(64) });
    expect(csv.duplicate).toBe(false);

    const runId = await log.startSyncRun({ organizationId: ORG, source: "bank_statements", stream: "statements", mode: "file", cursorBefore: null });
    await log.updateFileImport(first.id, { status: "parsed", rowsTotal: 87, syncRunId: runId });
    await log.updateFileImport(first.id, { status: "needs_review", error: "two pages unreadable" });
    const { rows } = await client.query("select status, rows_total, sync_run_id, error from file_imports where id = $1", [first.id]);
    expect(rows[0]).toEqual({ status: "needs_review", rows_total: 87, sync_run_id: runId, error: "two pages unreadable" });
  });

  it("rejects statements with impossible periods or unknown file types", async () => {
    const { log } = await setup();
    await expect(log.recordFileImport({ ...statement, periodEnd: "2026-08-01" })).rejects.toThrow(/file_imports/);
    await expect(
      log.recordFileImport({ ...statement, sha256: "c".repeat(64), mediaType: "image/png" as NewFileImport["mediaType"] }),
    ).rejects.toThrow(/file_imports/);
  });

  it("links entities both ways and merges the events behind each link", async () => {
    const { log } = await setup();
    const order = { kind: "order", id: "O-1" };
    const customer = { kind: "customer", id: "C-1" };
    await log.linkEntities({ organizationId: ORG, from: order, relation: "placed_by", to: customer, sourceEventIds: ["e1"] });
    await log.linkEntities({ organizationId: ORG, from: order, relation: "placed_by", to: customer, sourceEventIds: ["e1", "e2"] });
    await log.linkEntities({ organizationId: ORG, from: { kind: "repair_ticket", id: "R-9" }, relation: "for_customer", to: customer, sourceEventIds: ["e3"] });
    const from = await log.linksFrom(ORG, order);
    expect(from).toHaveLength(1);
    expect([...from[0]!.sourceEventIds].sort()).toEqual(["e1", "e2"]);
    expect((await log.linksTo(ORG, customer)).map((l) => `${l.from.kind}:${l.relation}`)).toEqual([
      "repair_ticket:for_customer",
      "order:placed_by",
    ]);
    await expect(
      log.linkEntities({ organizationId: ORG, from: order, relation: "Placed By", to: customer, sourceEventIds: [] }),
    ).rejects.toThrow(/entity_links/);
  });

  it("is a WriteGate audit log, and its trail can't be edited", async () => {
    const { client, log } = await setup();
    const gate = new WriteGate({ organizationId: ORG, policy: READ_ONLY, audit: log, now: () => new Date("2026-10-09T12:00:00Z") });
    const action = { integration: "shopify", name: "tag_customer", description: "Add a tag to a customer" };
    await expect(gate.run(action, "recommendation:r1", async () => "done")).rejects.toBeInstanceOf(WritesDisabledError);
    await log.recordWrite({ organizationId: ORG, integration: "shopify", action: "tag_customer", requestedBy: "owner", outcome: "failed", at: "2026-10-09T12:01:00Z", error: "429" });
    const { rows } = await client.query("select integration, action, requested_by, outcome, error from write_audit order by id");
    expect(rows).toEqual([
      { integration: "shopify", action: "tag_customer", requested_by: "recommendation:r1", outcome: "refused", error: null },
      { integration: "shopify", action: "tag_customer", requested_by: "owner", outcome: "failed", error: "429" },
    ]);
    await expect(client.query("delete from write_audit")).rejects.toThrow(/append-only/);
  });
});
