import { IMPACT_KINDS, type Feedback, type Impact, type Recommendation } from "./reasoning.js";
import type { MemoryStore } from "./layers.js";

/**
 * The value ledger: what KaratOS raised, what people approved, and what
 * acting on it actually brought back. A recommendation's `impact` is the
 * estimate; a ValueResult is the money that came of it, recorded after the
 * fact. The report puts the two side by side, so an owner can see what
 * KaratOS put back against what it costs.
 */

/** What acting on a recommendation brought back. */
export interface ValueResult {
  recommendationId: string;
  organizationId: string;
  kind: Impact["kind"];
  /** Whole cents, zero or more. Zero records that it was done and brought nothing back. */
  cents: number;
  /** `measured` was worked out from the store's own data; `reported` is what a person entered. */
  source: "measured" | "reported";
  note?: string;
  actor: string;
  recordedAt: string;
}

export const VALUE_SOURCES: readonly ValueResult["source"][] = ["measured", "reported"];

/** Why a result can't be recorded, or null when it's sound. */
export function valueResultProblem(result: ValueResult): string | null {
  if (!IMPACT_KINDS.includes(result.kind)) return `unknown impact kind ${String(result.kind)}`;
  if (!Number.isSafeInteger(result.cents) || result.cents < 0) return "a result must be whole cents, zero or more";
  if (!VALUE_SOURCES.includes(result.source)) return `unknown result source ${String(result.source)}`;
  if (typeof result.actor !== "string" || !result.actor.trim()) return "a result needs the person or process that recorded it";
  if (Number.isNaN(Date.parse(result.recordedAt))) return "a result needs the time it was recorded";
  return null;
}

/** Cents by kind, and their sum. */
export interface ValueTotals {
  makes: number;
  saves: number;
  protects: number;
  total: number;
}

export interface ValueReport {
  organizationId: string;
  /** The period's first instant, inclusive, as ISO 8601. */
  from: string;
  /** The instant after the period, exclusive. */
  to: string;
  /** Recommendations raised in the period; `priced` of them carry an impact, whose likely amounts make up `likely`. */
  shown: { count: number; priced: number; likely: ValueTotals };
  /** Approved as of the period's end, by the latest word on each. */
  approved: { count: number; likely: ValueTotals };
  dismissed: { count: number };
  /** A person chose to do something else. */
  overridden: { count: number };
  /** Recommendations with a result recorded by the period's end, by the latest result on each. */
  returned: { count: number; cents: ValueTotals };
  /** Approved with no result recorded yet: what is still to come back. */
  awaiting: { count: number; likely: ValueTotals };
}

const zero = (): ValueTotals => ({ makes: 0, saves: 0, protects: 0, total: 0 });

function add(totals: ValueTotals, kind: Impact["kind"], cents: number) {
  totals[kind] += cents;
  totals.total += cents;
}

/** The latest of each recommendation's records up to `to`, by their own time. */
function latest<T extends { recommendationId: string; recordedAt: string }>(records: T[], to: number): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of records) {
    const at = Date.parse(r.recordedAt);
    if (!(at < to)) continue;
    const current = out.get(r.recommendationId);
    if (!current || at >= Date.parse(current.recordedAt)) out.set(r.recommendationId, r);
  }
  return out;
}

/**
 * The ledger for the recommendations raised in [from, to). Each one is
 * followed through to the period's end: the latest feedback says whether it
 * was approved, and the latest result says what came back, so a result
 * measured again at 60 or 90 days replaces the earlier one rather than
 * adding to it. Records for other organizations or other recommendations
 * are ignored, as is anything recorded after the period.
 */
export function valueReport(input: {
  organizationId: string;
  from: string;
  to: string;
  recommendations: Recommendation[];
  feedback: Feedback[];
  results: ValueResult[];
}): ValueReport {
  const from = Date.parse(input.from);
  const to = Date.parse(input.to);
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) throw new RangeError("a value report needs a period whose start is before its end");

  const shown = input.recommendations.filter((r) => {
    const at = Date.parse(r.createdAt);
    return r.organizationId === input.organizationId && at >= from && at < to;
  });
  // Records for other recommendations are never looked up, so only the organization needs checking.
  const mine = <T extends { organizationId: string }>(records: T[]) => records.filter((r) => r.organizationId === input.organizationId);
  const words = latest(mine(input.feedback), to);
  const results = latest(
    mine(input.results).filter((r) => !valueResultProblem(r)),
    to,
  );

  const report: ValueReport = {
    organizationId: input.organizationId,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    shown: { count: shown.length, priced: 0, likely: zero() },
    approved: { count: 0, likely: zero() },
    dismissed: { count: 0 },
    overridden: { count: 0 },
    returned: { count: 0, cents: zero() },
    awaiting: { count: 0, likely: zero() },
  };
  for (const r of shown) {
    if (r.impact) {
      report.shown.priced++;
      add(report.shown.likely, r.impact.kind, r.impact.cents);
    }
    const outcome = words.get(r.id)?.outcome;
    const result = results.get(r.id);
    if (outcome === "accepted") {
      report.approved.count++;
      if (r.impact) add(report.approved.likely, r.impact.kind, r.impact.cents);
      if (!result) {
        report.awaiting.count++;
        if (r.impact) add(report.awaiting.likely, r.impact.kind, r.impact.cents);
      }
    } else if (outcome === "rejected") report.dismissed.count++;
    else if (outcome === "overridden") report.overridden.count++;
    // A result counts whatever the feedback said: an owner may act without pressing Accept.
    if (result) {
      report.returned.count++;
      add(report.returned.cents, result.kind, result.cents);
    }
  }
  return report;
}

/** The calendar month holding `at`, in UTC, as a [from, to) period. */
export function monthOf(at: string): { from: string; to: string } {
  // An invalid date throws a RangeError from toISOString.
  const d = new Date(at);
  return {
    from: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(),
    to: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(),
  };
}

/** Reads what the ledger needs for one period from memory and builds its report. */
export async function readValueReport(
  memory: Pick<MemoryStore, "recommendationsBetween" | "listFeedback" | "listValueResults">,
  organizationId: string,
  period: { from: string; to: string },
): Promise<ValueReport> {
  const recommendations = await memory.recommendationsBetween(organizationId, period.from, period.to);
  const ids = recommendations.map((r) => r.id);
  const [feedback, results] = ids.length
    ? await Promise.all([memory.listFeedback(organizationId, ids), memory.listValueResults(organizationId, ids)])
    : [[], []];
  return valueReport({ organizationId, ...period, recommendations, feedback, results });
}
