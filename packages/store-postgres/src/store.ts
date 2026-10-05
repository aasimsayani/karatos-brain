import {
  IdentityCollisionError,
  type DeadLetter,
  type EntityKind,
  type EntityRef,
  type EventEnvelope,
  type Feedback,
  type IdentityLink,
  type MemoryStore,
  type NormalizedEntity,
  type ReasoningRun,
  type Recommendation,
  type Signal,
} from "@karatos/core";
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

interface EntityRow {
  organization_id: string;
  kind: string;
  id: string;
  attributes: Record<string, unknown>;
  source_event_ids: string[];
  updated_at: Date | string;
}

interface RecommendationRow {
  id: string;
  organization_id: string;
  summary: string;
  confidence: string | number;
  expected_impact: string;
  provenance: Recommendation["provenance"];
  degraded: boolean;
  created_at: Date | string;
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

  async appendDeadLetter(deadLetter: DeadLetter): Promise<void> {
    await this.db.query(
      `insert into dead_letter_events (id, organization_id, source, reason, issues, raw, received_at)
       values ($1, (select id from organizations where id = $2), $3, $4, $5, $6, $7)`,
      [
        deadLetter.id,
        deadLetter.organizationId ?? null,
        deadLetter.source ?? null,
        deadLetter.reason,
        JSON.stringify(deadLetter.issues),
        JSON.stringify(deadLetter.raw ?? null),
        deadLetter.receivedAt,
      ],
    );
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

  async getEntity(organizationId: string, kind: EntityKind, id: string): Promise<NormalizedEntity | null> {
    const { rows } = await this.db.query<EntityRow>(
      "select * from entities where organization_id = $1 and kind = $2 and id = $3",
      [organizationId, kind, id],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ref: { kind: row.kind, id: row.id },
      organizationId: row.organization_id,
      attributes: row.attributes,
      sourceEventIds: row.source_event_ids,
      updatedAt: iso(row.updated_at),
    };
  }

  async linkIdentity(link: IdentityLink): Promise<void> {
    await this.db.query(
      `insert into identities (organization_id, source, external_id, entity_kind, entity_id)
       values ($1, $2, $3, $4, $5)
       on conflict (organization_id, source, external_id) do nothing`,
      [link.organizationId, link.source, link.externalId, link.entity.kind, link.entity.id],
    );
    const existing = await this.resolveIdentity(link.organizationId, link.source, link.externalId);
    if (existing && (existing.kind !== link.entity.kind || existing.id !== link.entity.id)) {
      throw new IdentityCollisionError(link, existing);
    }
  }

  async resolveIdentity(organizationId: string, source: string, externalId: string): Promise<EntityRef | null> {
    const { rows } = await this.db.query<{ entity_kind: string; entity_id: string }>(
      "select entity_kind, entity_id from identities where organization_id = $1 and source = $2 and external_id = $3",
      [organizationId, source, externalId],
    );
    const row = rows[0];
    return row ? { kind: row.entity_kind, id: row.entity_id } : null;
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

  async listRecommendations(organizationId: string, limit: number): Promise<Recommendation[]> {
    const { rows } = await this.db.query<RecommendationRow>(
      "select * from recommendations where organization_id = $1 order by created_at desc, id desc limit $2",
      [organizationId, limit],
    );
    return rows.map(toRecommendation);
  }

  async getRecommendation(organizationId: string, id: string): Promise<Recommendation | null> {
    const { rows } = await this.db.query<RecommendationRow>(
      "select * from recommendations where organization_id = $1 and id = $2",
      [organizationId, id],
    );
    return rows[0] ? toRecommendation(rows[0]) : null;
  }

  async recordReasoningRun(run: ReasoningRun): Promise<void> {
    await this.db.query(
      `insert into reasoning_runs (id, organization_id, started_at, finished_at, reasoners, documentation, degraded, recommendation_ids)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        run.id,
        run.organizationId,
        run.startedAt,
        run.finishedAt,
        run.reasoners,
        JSON.stringify(run.documentation),
        run.degraded,
        run.recommendationIds,
      ],
    );
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

function toRecommendation(row: RecommendationRow): Recommendation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    summary: row.summary,
    confidence: Number(row.confidence),
    expectedImpact: row.expected_impact,
    provenance: row.provenance,
    degraded: row.degraded,
    createdAt: iso(row.created_at),
  };
}
