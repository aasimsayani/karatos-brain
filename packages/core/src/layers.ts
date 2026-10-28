import type { DeadLetter, EventEnvelope } from "./events.js";
import type { StoredEvent } from "./retention.js";
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
  /** An event with its source reference. Its payload may have been cleared by retention; the row never goes away. */
  getEvent(organizationId: string, id: string): Promise<StoredEvent | null>;
  appendDeadLetter(deadLetter: DeadLetter): Promise<void>;
  upsertEntities(entities: NormalizedEntity[]): Promise<void>;
  getEntity(organizationId: string, kind: EntityKind, id: string): Promise<NormalizedEntity | null>;
  /** Throws IdentityCollisionError if the source record already points elsewhere. */
  linkIdentity(link: IdentityLink): Promise<void>;
  resolveIdentity(organizationId: string, source: string, externalId: string): Promise<EntityRef | null>;
  appendSignals(signals: Signal[]): Promise<void>;
  /** The latest signals, oldest first. With kinds, only signals of those kinds count toward the limit. */
  recentSignals(organizationId: string, limit: number, kinds?: readonly string[]): Promise<Signal[]>;
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
