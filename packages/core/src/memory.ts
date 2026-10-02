import type { EventEnvelope } from "./events.js";
import type { NormalizedEntity } from "./entities.js";
import type { Signal } from "./signals.js";
import type { Feedback, Recommendation } from "./reasoning.js";
import type { MemoryStore } from "./layers.js";

/** In-process MemoryStore for tests and local experiments. */
export class InMemoryStore implements MemoryStore {
  readonly events: EventEnvelope[] = [];
  readonly entities = new Map<string, NormalizedEntity>();
  readonly signals: Signal[] = [];
  readonly recommendations: Recommendation[] = [];
  readonly feedback: Feedback[] = [];
  private readonly idempotencyKeys = new Set<string>();

  async appendEvent(event: EventEnvelope): Promise<{ inserted: boolean }> {
    const key = `${event.organizationId}:${event.source}:${event.idempotencyKey}`;
    if (this.idempotencyKeys.has(key)) return { inserted: false };
    this.idempotencyKeys.add(key);
    this.events.push(event);
    return { inserted: true };
  }

  async upsertEntities(entities: NormalizedEntity[]): Promise<void> {
    for (const entity of entities) {
      this.entities.set(`${entity.organizationId}:${entity.ref.kind}:${entity.ref.id}`, entity);
    }
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

  async recordFeedback(feedback: Feedback): Promise<void> {
    this.feedback.push(feedback);
  }
}
