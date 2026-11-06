import type { EntityRef } from "./entities.js";
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
  /** What acting on it is worth, in dollars. Absent when there is no honest way to put a number on it. */
  impact?: Impact;
  provenance: {
    eventIds: string[];
    signalIds: string[];
    documentIds: string[];
  };
  /** True when reasoning ran against stale or mismatched documentation. */
  degraded: boolean;
  createdAt: string;
}

/**
 * What acting on a recommendation is worth to the business. `makes` is
 * profit on new sales (after the cost of the goods, not the sale price),
 * `saves` is a cost cut, and `protects` is money owed or at risk that the
 * action keeps. Every amount is in cents, low <= likely <= high.
 */
export interface Impact {
  kind: "makes" | "saves" | "protects";
  /** The likely amount. */
  cents: number;
  lowCents: number;
  highCents: number;
  /** How the number was worked out, with the figures used, so the owner can check it. */
  basis: string;
  /** How to read what acting on it actually brought back from the store's own data, when that can be read. */
  measure?: ImpactMeasure;
}

/** The days after a recommendation at which its result is measured. */
export const MEASURE_DAYS = [30, 60, 90] as const;

/**
 * Reads a recommendation's result from later signals: the `centsField` of
 * every `signalKind` signal on `subject` observed after the recommendation,
 * times `share` (the part that is the business's gain, such as the margin
 * on a sale). Measured at each of MEASURE_DAYS up to `windowDays`.
 */
export interface ImpactMeasure {
  signalKind: string;
  subject: EntityRef;
  centsField: string;
  share: number;
  windowDays: (typeof MEASURE_DAYS)[number];
  /** What the signals are, plural, for the result's note: "purchases". */
  label: string;
}

export const IMPACT_KINDS: readonly Impact["kind"][] = ["makes", "saves", "protects"];

/** Why an impact can't be stored or shown, or null when it's sound. */
export function impactProblem(impact: Impact): string | null {
  if (!IMPACT_KINDS.includes(impact.kind)) return `unknown impact kind ${String(impact.kind)}`;
  const amounts = [impact.lowCents, impact.cents, impact.highCents];
  if (!amounts.every((n) => Number.isSafeInteger(n) && n >= 0)) return "impact amounts must be whole cents, zero or more";
  if (impact.lowCents > impact.cents || impact.cents > impact.highCents) return "impact amounts must run low, likely, high";
  if (typeof impact.basis !== "string" || !impact.basis.trim()) return "an impact needs a basis";
  return impact.measure === undefined ? null : measureProblem(impact.measure);
}

function measureProblem(m: ImpactMeasure): string | null {
  const text = (v: unknown) => typeof v === "string" && v.trim() !== "";
  if (!text(m.signalKind) || !text(m.centsField) || !text(m.label) || !text(m.subject?.kind) || !text(m.subject?.id)) {
    return "a measure needs a signal kind, subject, field and label";
  }
  if (!(typeof m.share === "number" && m.share > 0 && m.share <= 1)) return "a measure's share must be above 0 and at most 1";
  if (!MEASURE_DAYS.includes(m.windowDays)) return `a measure's window must be one of ${MEASURE_DAYS.join(", ")} days`;
  return null;
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
