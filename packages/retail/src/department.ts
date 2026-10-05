import type {
  EntityRef,
  EventEnvelope,
  NormalizedEntity,
  Normalizer,
  Reasoner,
  Recommendation,
  Signal,
  SignalExtractor,
} from "@karatos/core";
import type { ZodType } from "zod";

/**
 * One department of a jewelry business. A department declares the events it
 * understands (with payload schemas), turns them into entities and signals,
 * and reasons over signals, including signals other departments produce.
 */
export interface DepartmentModule {
  id: string;
  name: string;
  /** What this department is for, in the owner's words. */
  purpose: string;
  /** Payload schema for each event type this department owns. */
  events: Record<string, ZodType>;
  normalizers: Normalizer[];
  extractors: SignalExtractor[];
  reasoners: Reasoner[];
}

const DAY_MS = 86_400_000;

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS);
}

/**
 * Whole calendar days from a date (YYYY-MM-DD) to the day of \`nowIso\`.
 * Positive when the date is in the past: a repair promised yesterday is 1 day late.
 */
export function calendarDaysSince(date: string, nowIso: string): number {
  return daysBetween(`${date}T00:00:00Z`, `${nowIso.slice(0, 10)}T00:00:00Z`);
}

/** Builds a normalizer that maps one event type to one entity. */
export function entityFrom<P>(
  name: string,
  eventType: string,
  toEntity: (payload: P, event: EventEnvelope) => { ref: EntityRef; attributes: Record<string, unknown> } | null,
): Normalizer {
  return {
    name,
    supports: (event) => event.type === eventType,
    normalize: (event) => {
      const mapped = toEntity(event.payload as P, event);
      if (!mapped) return [];
      return [
        {
          ref: mapped.ref,
          organizationId: event.organizationId,
          attributes: mapped.attributes,
          sourceEventIds: [event.id],
          updatedAt: event.occurredAt,
        } satisfies NormalizedEntity,
      ];
    },
  };
}

/** Builds a signal derived from one event, with a stable id so replays never duplicate it. */
export function signalFrom(
  event: EventEnvelope,
  kind: string,
  subject: EntityRef,
  value: Signal["value"],
  options: { confidence?: number; part?: number } = {},
): Signal {
  const part = options.part === undefined ? "" : `_${options.part}`;
  return {
    id: `sig_${kind}_${subject.kind}_${subject.id}_${event.id}${part}`,
    organizationId: event.organizationId,
    kind,
    subject,
    value,
    confidence: options.confidence ?? 1,
    derivedFromEventIds: [event.id],
    observedAt: event.occurredAt,
  };
}

/** Builds an extractor that emits signals for the events it cares about. */
export function extractor(name: string, extract: (event: EventEnvelope) => Signal[]): SignalExtractor {
  return { name, extract: (_entities, event) => extract(event) };
}

/** The most recent signal of each subject, for the given kinds. */
export function latestBySubject(signals: Signal[], kinds: string[]): Map<string, Signal> {
  const latest = new Map<string, Signal>();
  for (const signal of signals) {
    if (!kinds.includes(signal.kind)) continue;
    const key = `${signal.subject.kind}:${signal.subject.id}`;
    const current = latest.get(key);
    if (!current || signal.observedAt >= current.observedAt) latest.set(key, signal);
  }
  return latest;
}

/** A signal's structured value. */
export function value<T extends Record<string, unknown>>(signal: Signal): T {
  return (typeof signal.value === "object" ? signal.value : {}) as T;
}

/** Builds a recommendation whose provenance points at the signals behind it. */
export function recommend(input: {
  department: string;
  key: string;
  organizationId: string;
  summary: string;
  confidence: number;
  expectedImpact: string;
  basedOn: Signal[];
  now: string;
}): Recommendation {
  return {
    id: `rec_${input.department}_${input.key}_${input.now.slice(0, 10)}`,
    organizationId: input.organizationId,
    summary: input.summary,
    confidence: input.confidence,
    expectedImpact: input.expectedImpact,
    provenance: {
      eventIds: [...new Set(input.basedOn.flatMap((s) => s.derivedFromEventIds))],
      signalIds: input.basedOn.map((s) => s.id),
      documentIds: [],
    },
    degraded: false,
    createdAt: input.now,
  };
}

export const dollars = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
