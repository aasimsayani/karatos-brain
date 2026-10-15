import type { EntityRef, IntegrationAccess, SyncReport, WriteAuditEntry, WriteAuditLog } from "@karatos/core";
import type { SqlClient } from "./client.js";

export type ConnectionStatus = "pending" | "connected" | "paused" | "error" | "disconnected";

/** A system an instance has connected. Holds secret names, never secret values. */
export interface IntegrationConnection {
  organizationId: string;
  integrationId: string;
  status: ConnectionStatus;
  access: IntegrationAccess;
  secretNames: string[];
  streams: string[];
  historicalFrom: string | null;
  settings: Record<string, unknown>;
}

export type SyncRunMode = "historical" | "incremental" | "webhook" | "file";

export interface StartSyncRun {
  organizationId: string;
  source: string;
  stream: string;
  mode: SyncRunMode;
  cursorBefore: string | null;
}

export interface SyncRun extends StartSyncRun {
  id: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  cursorAfter: string | null;
  batches: number;
  ingested: number;
  duplicates: number;
  deadLettered: number;
  error: string | null;
}

export interface WebhookDelivery {
  organizationId: string;
  source: string;
  deliveryId: string;
  topic: string;
  payloadSha256: string;
  syncRunId?: string;
}

export type FileMediaType =
  | "text/csv"
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/json"
  | "text/plain";

export interface NewFileImport {
  organizationId: string;
  source: string;
  fileName: string;
  mediaType: FileMediaType;
  sha256: string;
  byteSize: number;
  storagePath: string;
  periodStart?: string;
  periodEnd?: string;
  uploadedBy: string;
}

export type FileImportStatus = "received" | "parsing" | "parsed" | "needs_review" | "failed";

export interface FileImportUpdate {
  status: FileImportStatus;
  rowsTotal?: number;
  syncRunId?: string;
  error?: string;
}

/** A relation between two entities, e.g. an order's customer. */
export interface EntityLink {
  organizationId: string;
  from: EntityRef;
  relation: string;
  to: EntityRef;
  sourceEventIds: string[];
}

interface ConnectionRow {
  organization_id: string;
  integration_id: string;
  status: ConnectionStatus;
  access: IntegrationAccess;
  secret_names: string[];
  streams: string[];
  historical_from: Date | string | null;
  settings: Record<string, unknown>;
}

interface SyncRunRow {
  id: string;
  organization_id: string;
  source: string;
  stream: string;
  mode: SyncRunMode;
  status: SyncRun["status"];
  started_at: Date | string;
  finished_at: Date | string | null;
  cursor_before: string | null;
  cursor_after: string | null;
  batches: number;
  ingested: number;
  duplicates: number;
  dead_lettered: number;
  error: string | null;
}

interface LinkRow {
  organization_id: string;
  from_kind: string;
  from_id: string;
  relation: string;
  to_kind: string;
  to_id: string;
  source_event_ids: string[];
}

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
const day = (value: Date | string | null) => (value === null ? null : iso(value).slice(0, 10));

const toLink = (r: LinkRow): EntityLink => ({
  organizationId: r.organization_id,
  from: { kind: r.from_kind, id: r.from_id },
  relation: r.relation,
  to: { kind: r.to_kind, id: r.to_id },
  sourceEventIds: r.source_event_ids,
});

/**
 * Bookkeeping around ingestion: connected systems, sync runs, webhook
 * deliveries, uploaded files, entity links and the write audit trail.
 * The data itself goes through BrainPipeline into the events table.
 */
export class PostgresIngestionLog implements WriteAuditLog {
  constructor(private readonly db: SqlClient) {}

  async upsertConnection(connection: IntegrationConnection): Promise<void> {
    await this.db.query(
      `insert into integration_connections
         (organization_id, integration_id, status, access, secret_names, streams, historical_from, settings, connected_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, case when $3 = 'connected' then now() end)
       on conflict (organization_id, integration_id) do update set
         status = excluded.status,
         access = excluded.access,
         secret_names = excluded.secret_names,
         streams = excluded.streams,
         historical_from = excluded.historical_from,
         settings = excluded.settings,
         connected_at = coalesce(integration_connections.connected_at, excluded.connected_at),
         updated_at = now()`,
      [
        connection.organizationId,
        connection.integrationId,
        connection.status,
        connection.access,
        connection.secretNames,
        connection.streams,
        connection.historicalFrom,
        JSON.stringify(connection.settings),
      ],
    );
  }

  async listConnections(organizationId: string): Promise<IntegrationConnection[]> {
    const { rows } = await this.db.query<ConnectionRow>(
      "select * from integration_connections where organization_id = $1 order by integration_id",
      [organizationId],
    );
    return rows.map((r) => ({
      organizationId: r.organization_id,
      integrationId: r.integration_id,
      status: r.status,
      access: r.access,
      secretNames: r.secret_names,
      streams: r.streams,
      historicalFrom: day(r.historical_from),
      settings: r.settings,
    }));
  }

  async startSyncRun(run: StartSyncRun): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into sync_runs (organization_id, source, stream, mode, cursor_before)
       values ($1, $2, $3, $4, $5) returning id`,
      [run.organizationId, run.source, run.stream, run.mode, run.cursorBefore],
    );
    return rows[0]!.id;
  }

  /** Closes a run with runSync's report and records the sync on the connection. */
  async finishSyncRun(id: string, report: SyncReport): Promise<void> {
    await this.closeRun(id, "succeeded", report, null);
  }

  /** Closes a run that failed. Counts reflect the batches stored before the failure. */
  async failSyncRun(id: string, error: string, partial?: SyncReport): Promise<void> {
    await this.closeRun(id, "failed", partial ?? null, error);
  }

  async getSyncRun(id: string): Promise<SyncRun | null> {
    const { rows } = await this.db.query<SyncRunRow>("select * from sync_runs where id = $1", [id]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      organizationId: r.organization_id,
      source: r.source,
      stream: r.stream,
      mode: r.mode,
      status: r.status,
      startedAt: iso(r.started_at),
      finishedAt: r.finished_at === null ? null : iso(r.finished_at),
      cursorBefore: r.cursor_before,
      cursorAfter: r.cursor_after,
      batches: r.batches,
      ingested: r.ingested,
      duplicates: r.duplicates,
      deadLettered: r.dead_lettered,
      error: r.error,
    };
  }

  /** Records a webhook delivery. Returns false when the vendor already sent it. */
  async recordWebhookDelivery(delivery: WebhookDelivery): Promise<boolean> {
    const { rows } = await this.db.query(
      `insert into webhook_deliveries (organization_id, source, delivery_id, topic, payload_sha256, sync_run_id)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (organization_id, source, delivery_id) do nothing
       returning delivery_id`,
      [
        delivery.organizationId,
        delivery.source,
        delivery.deliveryId,
        delivery.topic,
        delivery.payloadSha256,
        delivery.syncRunId ?? null,
      ],
    );
    return rows.length > 0;
  }

  /** Records an uploaded file. The same file (by SHA-256) uploaded again returns the first import. */
  async recordFileImport(file: NewFileImport): Promise<{ id: string; duplicate: boolean }> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into file_imports
         (organization_id, source, file_name, media_type, sha256, byte_size, storage_path, period_start, period_end, uploaded_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (organization_id, sha256) do nothing
       returning id`,
      [
        file.organizationId,
        file.source,
        file.fileName,
        file.mediaType,
        file.sha256,
        file.byteSize,
        file.storagePath,
        file.periodStart ?? null,
        file.periodEnd ?? null,
        file.uploadedBy,
      ],
    );
    if (rows[0]) return { id: rows[0].id, duplicate: false };
    const existing = await this.db.query<{ id: string }>(
      "select id from file_imports where organization_id = $1 and sha256 = $2",
      [file.organizationId, file.sha256],
    );
    return { id: existing.rows[0]!.id, duplicate: true };
  }

  async updateFileImport(id: string, update: FileImportUpdate): Promise<void> {
    await this.db.query(
      `update file_imports set
         status = $2,
         rows_total = coalesce($3, rows_total),
         sync_run_id = coalesce($4, sync_run_id),
         error = $5
       where id = $1`,
      [id, update.status, update.rowsTotal ?? null, update.syncRunId ?? null, update.error ?? null],
    );
  }

  async linkEntities(link: EntityLink): Promise<void> {
    await this.db.query(
      `insert into entity_links (organization_id, from_kind, from_id, relation, to_kind, to_id, source_event_ids)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (organization_id, from_kind, from_id, relation, to_kind, to_id) do update set
         source_event_ids = array(select distinct unnest(entity_links.source_event_ids || excluded.source_event_ids)),
         updated_at = now()`,
      [link.organizationId, link.from.kind, link.from.id, link.relation, link.to.kind, link.to.id, link.sourceEventIds],
    );
  }

  /** Links out of an entity, e.g. the customer and items of an order. */
  async linksFrom(organizationId: string, from: EntityRef): Promise<EntityLink[]> {
    const { rows } = await this.db.query<LinkRow>(
      `select * from entity_links where organization_id = $1 and from_kind = $2 and from_id = $3
       order by relation, to_kind, to_id`,
      [organizationId, from.kind, from.id],
    );
    return rows.map(toLink);
  }

  /** Links into an entity, e.g. every order placed by a customer. */
  async linksTo(organizationId: string, to: EntityRef): Promise<EntityLink[]> {
    const { rows } = await this.db.query<LinkRow>(
      `select * from entity_links where organization_id = $1 and to_kind = $2 and to_id = $3
       order by relation, from_kind, from_id`,
      [organizationId, to.kind, to.id],
    );
    return rows.map(toLink);
  }

  async recordWrite(entry: WriteAuditEntry): Promise<void> {
    await this.db.query(
      `insert into write_audit (organization_id, integration, action, requested_by, outcome, error, at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [entry.organizationId, entry.integration, entry.action, entry.requestedBy, entry.outcome, entry.error ?? null, entry.at],
    );
  }

  private async closeRun(
    id: string,
    status: "succeeded" | "failed",
    report: SyncReport | null,
    error: string | null,
  ): Promise<void> {
    const { rows } = await this.db.query<{ organization_id: string; source: string }>(
      `update sync_runs set
         status = $2,
         finished_at = now(),
         cursor_after = $3,
         batches = $4,
         ingested = $5,
         duplicates = $6,
         dead_lettered = $7,
         error = $8
       where id = $1 and status = 'running'
       returning organization_id, source`,
      [
        id,
        status,
        report?.cursor ?? null,
        report?.batches ?? 0,
        report?.ingested ?? 0,
        report?.duplicates ?? 0,
        report?.deadLettered ?? 0,
        error,
      ],
    );
    const run = rows[0];
    if (!run) throw new Error(`sync run ${id} is not running`);
    await this.db.query(
      `update integration_connections set
         last_synced_at = case when $3::text is null then now() else last_synced_at end,
         last_error = $3,
         status = case when $3::text is null then status else 'error' end,
         updated_at = now()
       where organization_id = $1 and integration_id = $2`,
      [run.organization_id, run.source, error],
    );
  }
}
