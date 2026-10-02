import type { EventEnvelope, Feedback, MemoryStore, NormalizedEntity, Recommendation, Signal } from "@karatos/core";
import type { SqlClient } from "./client.js";

interface SignalRow {
  id: string;
  organization_id: string;
  kind: string;
  subject_kind: Signal["subject"]["kind"];
  subject_id: string;
  value: Signal["value"];
  confidence: string | number;
  derived_from_event_ids: string[];
  observed_at: Date | string;
}

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

/** MemoryStore backed by the Brain A Postgres schema (supabase/migrations). */
export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly db: SqlClient) {}

  async appendEvent(event: EventEnvelope): Promise<{ inserted: boolean }> {
    const { rows } = await this.db.query(
      `insert into events (id, organization_id, source, type, occurred_at, received_at, idempotency_key, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (organization_id, source, idempotency_key) do nothing
       returning id`,
      [
        event.id,
        event.organizationId,
        event.source,
        event.type,
        event.occurredAt,
        event.receivedAt,
        event.idempotencyKey,
        JSON.stringify(event.payload),
      ],
    );
    return { inserted: rows.length > 0 };
  }

  async upsertEntities(entities: NormalizedEntity[]): Promise<void> {
    for (const entity of entities) {
      await this.db.query(
        `insert into entities (organization_id, kind, id, attributes, source_event_ids, updated_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (organization_id, kind, id) do update set
           attributes = excluded.attributes,
           source_event_ids = array(select distinct unnest(entities.source_event_ids || excluded.source_event_ids)),
           updated_at = excluded.updated_at
         where excluded.updated_at >= entities.updated_at`,
        [
          entity.organizationId,
          entity.ref.kind,
          entity.ref.id,
          JSON.stringify(entity.attributes),
          entity.sourceEventIds,
          entity.updatedAt,
        ],
      );
    }
  }

  async appendSignals(signals: Signal[]): Promise<void> {
    for (const s of signals) {
      await this.db.query(
        `insert into signals (id, organization_id, kind, subject_kind, subject_id, value, confidence, derived_from_event_ids, observed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (id) do nothing`,
        [
          s.id,
          s.organizationId,
          s.kind,
          s.subject.kind,
          s.subject.id,
          JSON.stringify(s.value),
          s.confidence,
          s.derivedFromEventIds,
          s.observedAt,
        ],
      );
    }
  }

  async recentSignals(organizationId: string, limit: number): Promise<Signal[]> {
    const { rows } = await this.db.query<SignalRow>(
      `select * from (
         select * from signals where organization_id = $1 order by seq desc limit $2
       ) recent order by seq asc`,
      [organizationId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      kind: r.kind,
      subject: { kind: r.subject_kind, id: r.subject_id },
      value: r.value,
      confidence: Number(r.confidence),
      derivedFromEventIds: r.derived_from_event_ids,
      observedAt: iso(r.observed_at),
    }));
  }

  async saveRecommendations(recommendations: Recommendation[]): Promise<void> {
    for (const r of recommendations) {
      await this.db.query(
        `insert into recommendations (id, organization_id, summary, confidence, expected_impact, provenance, degraded, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (id) do nothing`,
        [r.id, r.organizationId, r.summary, r.confidence, r.expectedImpact, JSON.stringify(r.provenance), r.degraded, r.createdAt],
      );
    }
  }

  async recordFeedback(feedback: Feedback): Promise<void> {
    await this.db.query(
      `insert into feedback (recommendation_id, organization_id, outcome, note, actor, recorded_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [feedback.recommendationId, feedback.organizationId, feedback.outcome, feedback.note ?? null, feedback.actor, feedback.recordedAt],
    );
  }

  async saveCheckpoint(organizationId: string, source: string, stream: string, cursor: string): Promise<void> {
    await this.db.query(
      `insert into sync_checkpoints (organization_id, source, stream, cursor, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (organization_id, source, stream) do update set cursor = excluded.cursor, updated_at = now()`,
      [organizationId, source, stream, cursor],
    );
  }

  async getCheckpoint(organizationId: string, source: string, stream: string): Promise<string | null> {
    const { rows } = await this.db.query<{ cursor: string | null }>(
      "select cursor from sync_checkpoints where organization_id = $1 and source = $2 and stream = $3",
      [organizationId, source, stream],
    );
    return rows[0]?.cursor ?? null;
  }
}
