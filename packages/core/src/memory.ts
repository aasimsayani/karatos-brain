import type { DeadLetter, EventEnvelope } from "./events.js";
import type { EntityKind, EntityRef, NormalizedEntity } from "./entities.js";
import { IdentityCollisionError, type IdentityLink } from "./identity.js";
import type { Signal } from "./signals.js";
import type { Feedback, ReasoningRun, Recommendation } from "./reasoning.js";
import { valueResultProblem, type ValueResult } from "./value.js";
import type { MemoryStore } from "./layers.js";
import {
  clearedPayload,
  isRawExpired,
  rawRetentionCutoff,
  sha256Json,
  sourceReferenceFor,
  DEFAULT_RAW_RETENTION_DAYS,
  type PurgeResult,
  type RawDataRetention,
  type SourceReference,
  type StoredEvent,
} from "./retention.js";

interface EventMeta {
  sourceRef: SourceReference;
  payloadSha256: string;
  payloadClearedAt: string | null;
}

/** In-process MemoryStore for tests and local experiments. */
export class InMemoryStore implements MemoryStore, RawDataRetention {
  readonly events: EventEnvelope[] = [];
  readonly deadLetters: DeadLetter[] = [];
  readonly entities = new Map<string, NormalizedEntity>();
  readonly identities = new Map<string, EntityRef>();
  readonly signals: Signal[] = [];
  readonly recommendations: Recommendation[] = [];
  readonly reasoningRuns: ReasoningRun[] = [];
  readonly feedback: Feedback[] = [];
  readonly valueResults: ValueResult[] = [];
  readonly checkpoints = new Map<string, string>();
  /** Every purgeRawData run, so the owner can see retention ran. */
  readonly retentionRuns: PurgeResult[] = [];
  private readonly idempotencyKeys = new Set<string>();
  private readonly eventMeta = new Map<string, EventMeta>();
  private readonly clearedDeadLetters = new Set<string>();

  async appendEvent(event: EventEnvelope): Promise<{ inserted: boolean }> {
    const key = `${event.organizationId}:${event.source}:${event.idempotencyKey}`;
    if (this.idempotencyKeys.has(key)) return { inserted: false };
    this.idempotencyKeys.add(key);
    this.events.push(event);
    this.eventMeta.set(`${event.organizationId}:${event.id}`, {
      sourceRef: sourceReferenceFor(event),
      payloadSha256: sha256Json(event.payload),
      payloadClearedAt: null,
    });
    return { inserted: true };
  }

  async getEvent(organizationId: string, id: string): Promise<StoredEvent | null> {
    const event = this.events.find((e) => e.organizationId === organizationId && e.id === id);
    const meta = this.eventMeta.get(`${organizationId}:${id}`);
    return event && meta ? { ...event, ...meta } : null;
  }

  async purgeRawData(organizationId: string, now: Date, retentionDays = DEFAULT_RAW_RETENTION_DAYS): Promise<PurgeResult> {
    const cutoff = rawRetentionCutoff(now, retentionDays);
    const tombstone = clearedPayload(now);
    let events = 0;
    this.events.forEach((event, index) => {
      const meta = this.eventMeta.get(`${event.organizationId}:${event.id}`);
      if (event.organizationId !== organizationId || !meta || meta.payloadClearedAt !== null) return;
      if (!isRawExpired(event.receivedAt, now, retentionDays)) return;
      this.events[index] = { ...event, payload: { ...tombstone } };
      meta.payloadClearedAt = tombstone.at;
      events++;
    });
    let deadLetters = 0;
    this.deadLetters.forEach((dl, index) => {
      if (dl.organizationId !== undefined && dl.organizationId !== organizationId) return;
      if (this.clearedDeadLetters.has(dl.id) || !isRawExpired(dl.receivedAt, now, retentionDays)) return;
      this.deadLetters[index] = { ...dl, raw: { ...tombstone } };
      this.clearedDeadLetters.add(dl.id);
      deadLetters++;
    });
    const result: PurgeResult = {
      organizationId,
      ranAt: now.toISOString(),
      cutoff: cutoff.toISOString(),
      retentionDays,
      events,
      deadLetters,
      fileImports: 0,
    };
    this.retentionRuns.push(result);
    return result;
  }

  async appendDeadLetter(deadLetter: DeadLetter): Promise<void> {
    this.deadLetters.push(deadLetter);
  }

  async upsertEntities(entities: NormalizedEntity[]): Promise<void> {
    for (const entity of entities) {
      const key = `${entity.organizationId}:${entity.ref.kind}:${entity.ref.id}`;
      const existing = this.entities.get(key);
      if (existing && existing.updatedAt > entity.updatedAt) continue;
      const sourceEventIds = [...new Set([...(existing?.sourceEventIds ?? []), ...entity.sourceEventIds])];
      this.entities.set(key, { ...entity, sourceEventIds });
    }
  }

  async getEntity(organizationId: string, kind: EntityKind, id: string): Promise<NormalizedEntity | null> {
    return this.entities.get(`${organizationId}:${kind}:${id}`) ?? null;
  }

  async linkIdentity(link: IdentityLink): Promise<void> {
    const key = `${link.organizationId}:${link.source}:${link.externalId}`;
    const existing = this.identities.get(key);
    if (existing && (existing.kind !== link.entity.kind || existing.id !== link.entity.id)) {
      throw new IdentityCollisionError(link, existing);
    }
    this.identities.set(key, link.entity);
  }

  async resolveIdentity(organizationId: string, source: string, externalId: string): Promise<EntityRef | null> {
    return this.identities.get(`${organizationId}:${source}:${externalId}`) ?? null;
  }

  async appendSignals(signals: Signal[]): Promise<void> {
    this.signals.push(...signals);
  }

  async recentSignals(organizationId: string, limit: number, kinds?: readonly string[]): Promise<Signal[]> {
    return this.signals.filter((s) => s.organizationId === organizationId && (!kinds || kinds.includes(s.kind))).slice(-limit);
  }

  async saveRecommendations(recommendations: Recommendation[]): Promise<void> {
    this.recommendations.push(...recommendations);
  }

  async listRecommendations(organizationId: string, limit: number): Promise<Recommendation[]> {
    return this.recommendations.filter((r) => r.organizationId === organizationId).slice(-limit).reverse();
  }

  async getRecommendation(organizationId: string, id: string): Promise<Recommendation | null> {
    return this.recommendations.find((r) => r.organizationId === organizationId && r.id === id) ?? null;
  }

  async recordReasoningRun(run: ReasoningRun): Promise<void> {
    this.reasoningRuns.push(run);
  }

  async recordFeedback(feedback: Feedback): Promise<void> {
    this.feedback.push(feedback);
  }

  async recommendationsBetween(organizationId: string, from: string, to: string): Promise<Recommendation[]> {
    const [start, end] = [Date.parse(from), Date.parse(to)];
    return this.recommendations
      .filter((r) => r.organizationId === organizationId && Date.parse(r.createdAt) >= start && Date.parse(r.createdAt) < end)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async listFeedback(organizationId: string, recommendationIds: readonly string[]): Promise<Feedback[]> {
    return this.feedback.filter((f) => f.organizationId === organizationId && recommendationIds.includes(f.recommendationId));
  }

  async recordValueResult(result: ValueResult): Promise<void> {
    const problem = valueResultProblem(result);
    if (problem) throw new RangeError(problem);
    // As in Postgres: one measured result per recommendation and checkpoint.
    if (
      result.measuredDays !== undefined &&
      this.valueResults.some((r) => r.organizationId === result.organizationId && r.recommendationId === result.recommendationId && r.measuredDays === result.measuredDays)
    ) {
      throw new RangeError(`${result.recommendationId} already has a result measured at ${result.measuredDays} days`);
    }
    this.valueResults.push(result);
  }

  async listValueResults(organizationId: string, recommendationIds: readonly string[]): Promise<ValueResult[]> {
    return this.valueResults.filter((r) => r.organizationId === organizationId && recommendationIds.includes(r.recommendationId));
  }

  async saveCheckpoint(organizationId: string, source: string, stream: string, cursor: string): Promise<void> {
    this.checkpoints.set(`${organizationId}:${source}:${stream}`, cursor);
  }

  async getCheckpoint(organizationId: string, source: string, stream: string): Promise<string | null> {
    return this.checkpoints.get(`${organizationId}:${source}:${stream}`) ?? null;
  }
}
