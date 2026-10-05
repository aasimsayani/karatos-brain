import type { DeadLetter, EventEnvelope } from "./events.js";
import type { EntityKind, EntityRef, NormalizedEntity } from "./entities.js";
import type { IdentityLink } from "./identity.js";
import type { Signal } from "./signals.js";
import type { DocumentationState, Feedback, ReasoningRun, Recommendation, ReasoningContext } from "./reasoning.js";

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
  appendDeadLetter(deadLetter: DeadLetter): Promise<void>;
  upsertEntities(entities: NormalizedEntity[]): Promise<void>;
  getEntity(organizationId: string, kind: EntityKind, id: string): Promise<NormalizedEntity | null>;
  /** Throws IdentityCollisionError if the source record already points elsewhere. */
  linkIdentity(link: IdentityLink): Promise<void>;
  resolveIdentity(organizationId: string, source: string, externalId: string): Promise<EntityRef | null>;
  appendSignals(signals: Signal[]): Promise<void>;
  recentSignals(organizationId: string, limit: number): Promise<Signal[]>;
  saveRecommendations(recommendations: Recommendation[]): Promise<void>;
  listRecommendations(organizationId: string, limit: number): Promise<Recommendation[]>;
  getRecommendation(organizationId: string, id: string): Promise<Recommendation | null>;
  recordReasoningRun(run: ReasoningRun): Promise<void>;
  recordFeedback(feedback: Feedback): Promise<void>;
  saveCheckpoint(organizationId: string, source: string, stream: string, cursor: string): Promise<void>;
  getCheckpoint(organizationId: string, source: string, stream: string): Promise<string | null>;
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
