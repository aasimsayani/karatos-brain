import type { Signal } from "./signals.js";

/**
 * Layer 5, Brain A Reasoning. Every recommendation carries its confidence,
 * expected impact and provenance so a human can audit and override it.
 */
export interface Recommendation {
  id: string;
  organizationId: string;
  summary: string;
  /** 0 to 1. */
  confidence: number;
  expectedImpact: string;
  provenance: {
    eventIds: string[];
    signalIds: string[];
    documentIds: string[];
  };
  /** True when reasoning ran against stale or mismatched documentation. */
  degraded: boolean;
  createdAt: string;
}

export interface ReasoningContext {
  organizationId: string;
  signals: Signal[];
  documentation: DocumentationState;
  /** When this reasoning run started, as ISO 8601. Use it for anything time-based. */
  now: string;
}

/**
 * Layer 7, Documentation System. Brain A reasons against current docs and
 * must say so when they are out of date.
 */
export interface DocumentationState {
  /** Ids of the source-of-truth documents consulted. */
  documentIds: string[];
  stale: boolean;
  reason?: string;
}

/**
 * Layer 6, Feedback + Learning. Human overrides are first-class signals.
 */
export interface Feedback {
  recommendationId: string;
  organizationId: string;
  outcome: "accepted" | "rejected" | "overridden";
  note?: string;
  actor: string;
  recordedAt: string;
}

/** One call to BrainPipeline.reason, kept for audit and learning. */
export interface ReasoningRun {
  id: string;
  organizationId: string;
  startedAt: string;
  finishedAt: string;
  reasoners: string[];
  documentation: DocumentationState;
  degraded: boolean;
  recommendationIds: string[];
}
