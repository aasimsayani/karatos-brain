import type { DeadLetter, EventEnvelope } from "./events.js";
import type { EntityKind, EntityRef, NormalizedEntity } from "./entities.js";
import { IdentityCollisionError, type IdentityLink } from "./identity.js";
import type { Signal } from "./signals.js";
import type { Feedback, ReasoningRun, Recommendation } from "./reasoning.js";
import type { MemoryStore } from "./layers.js";

/** In-process MemoryStore for tests and local experiments. */
export class InMemoryStore implements MemoryStore {
  readonly events: EventEnvelope[] = [];
  readonly deadLetters: DeadLetter[] = [];
  readonly entities = new Map<string, NormalizedEntity>();
  readonly identities = new Map<string, EntityRef>();
  readonly signals: Signal[] = [];
  readonly recommendations: Recommendation[] = [];
  readonly reasoningRuns: ReasoningRun[] = [];
  readonly feedback: Feedback[] = [];
  readonly checkpoints = new Map<string, string>();
  private readonly idempotencyKeys = new Set<string>();

  async appendEvent(event: EventEnvelope): Promise<{ inserted: boolean }> {
    const key = `${event.organizationId}:${event.source}:${event.idempotencyKey}`;
    if (this.idempotencyKeys.has(key)) return { inserted: false };
    this.idempotencyKeys.add(key);
    this.events.push(event);
    return { inserted: true };
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

  async recentSignals(organizationId: string, limit: number): Promise<Signal[]> {
    return this.signals.filter((s) => s.organizationId === organizationId).slice(-limit);
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

  async saveCheckpoint(organizationId: string, source: string, stream: string, cursor: string): Promise<void> {
    this.checkpoints.set(`${organizationId}:${source}:${stream}`, cursor);
  }

  async getCheckpoint(organizationId: string, source: string, stream: string): Promise<string | null> {
    return this.checkpoints.get(`${organizationId}:${source}:${stream}`) ?? null;
  }
}
