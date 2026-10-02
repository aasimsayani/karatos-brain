import type { EventEnvelope } from "./events.js";
import type { NormalizedEntity } from "./entities.js";
import type { Signal } from "./signals.js";
import type { DocumentationState, Feedback, Recommendation, ReasoningContext } from "./reasoning.js";

/** Layer 2. Turns one event into zero or more canonical entities. */
export interface Normalizer {
  readonly name: string;
  supports(event: EventEnvelope): boolean;
  normalize(event: EventEnvelope): NormalizedEntity[] | Promise<NormalizedEntity[]>;
}

/** Layer 3. Derives signals from freshly normalized entities. */
export interface SignalExtractor {
  readonly name: string;
  extract(entities: NormalizedEntity[], event: EventEnvelope): Signal[] | Promise<Signal[]>;
}

/** Layer 4. Durable memory and state. */
export interface MemoryStore {
  appendEvent(event: EventEnvelope): Promise<{ inserted: boolean }>;
  upsertEntities(entities: NormalizedEntity[]): Promise<void>;
  appendSignals(signals: Signal[]): Promise<void>;
  recentSignals(organizationId: string, limit: number): Promise<Signal[]>;
  saveRecommendations(recommendations: Recommendation[]): Promise<void>;
  recordFeedback(feedback: Feedback): Promise<void>;
}

/** Layer 5. */
export interface Reasoner {
  readonly name: string;
  reason(context: ReasoningContext): Recommendation[] | Promise<Recommendation[]>;
}

/** Layer 7. */
export interface DocumentationSource {
  current(): DocumentationState | Promise<DocumentationState>;
}
