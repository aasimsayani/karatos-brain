import type {
  EntityRef,
  EventEnvelope,
  Impact,
  ImpactMeasure,
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
  impact?: Impact | undefined;
  basedOn: Signal[];
  now: string;
}): Recommendation {
  return {
    id: `rec_${input.department}_${input.key}_${input.now.slice(0, 10)}`,
    organizationId: input.organizationId,
    summary: input.summary,
    confidence: input.confidence,
    expectedImpact: input.expectedImpact,
    ...(input.impact ? { impact: input.impact } : {}),
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

/** A planning figure as a low, likely and high value. */
export interface Assumption {
  low: number;
  likely: number;
  high: number;
}

/**
 * The figures behind every dollar estimate, used only where the store's own
 * data doesn't say. The likely values match the defaults of the payback
 * estimate on the website, so the two tell the same story. A store's own
 * figures will replace these as KaratOS learns how each business works.
 */
export const ASSUMPTIONS = {
  /** Gross margin on a retail sale. */
  margin: { low: 0.35, likely: 0.45, high: 0.55 },
  /** An average retail order, in cents. */
  averageOrderCents: { low: 80_000, likely: 150_000, high: 250_000 },
  /** Share of lapsed customers who buy again after a personal invitation. */
  winBackRate: { low: 0.05, likely: 0.1, high: 0.15 },
  /** Share of occasion reminders that turn into a sale. */
  occasionRate: { low: 0.05, likely: 0.1, high: 0.2 },
  /** Share of returned missed calls that turn into a sale. */
  callCloseRate: { low: 0.1, likely: 0.15, high: 0.25 },
  /** What a year of holding stock costs, as a share of its cost: insurance, capital and case space. */
  carryingRate: { low: 0.15, likely: 0.2, high: 0.25 },
  /** What handling one return costs: shipping, repacking, card fees and staff time, in cents. */
  returnCostCents: { low: 2_000, likely: 4_000, high: 7_500 },
  /** Share of a past-due balance that follow-up brings in. */
  collectRate: { low: 0.5, likely: 0.8, high: 0.95 },
  /** An insurance appraisal update fee, in cents. */
  appraisalFeeCents: { low: 5_000, likely: 10_000, high: 15_000 },
  /** Share of customers who take an offered appraisal update. */
  appraisalTakeUp: { low: 0.2, likely: 0.3, high: 0.5 },
  /** A dealer's margin selling a watch to another dealer. */
  tradeMargin: { low: 0.03, likely: 0.05, high: 0.1 },
  /** What a refiner should pay on fine metal, as a share of spot. */
  targetPayable: { low: 0.95, likely: 0.97, high: 0.99 },
} satisfies Record<string, Assumption>;

export type AssumptionName = keyof typeof ASSUMPTIONS;

/**
 * A dollar estimate worked out three times: with every assumption at its
 * low, likely and high value. The three results are sorted, so a figure
 * that shrinks as an assumption grows still gives a sound range. Undefined
 * when even the high case is under a dollar, as there is nothing to show.
 */
export function estimate(
  kind: Impact["kind"],
  basis: string,
  amount: (a: (name: AssumptionName) => number) => number,
): Impact | undefined {
  const points = (["low", "likely", "high"] as const).map((point) => Math.max(0, Math.round(amount((name) => ASSUMPTIONS[name][point]))));
  if (points.some((n) => !Number.isSafeInteger(n))) return undefined;
  const likely = points[1]!;
  const [lowCents, highCents] = [Math.min(...points), Math.max(...points)];
  if (highCents < 100) return undefined;
  return { kind, cents: likely, lowCents, highCents, basis };
}

/** An estimate that also says how to measure what acting on it brought back. */
export function measured(impact: Impact | undefined, measure: ImpactMeasure): Impact | undefined {
  return impact && { ...impact, measure };
}

/** A whole percentage, for a basis: 0.45 is "45%". */
export const pct = (share: number) => `${Math.round(share * 1000) / 10}%`;
