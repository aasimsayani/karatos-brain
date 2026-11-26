import type { Feedback, Recommendation } from "./reasoning.js";
import type { ValueResult } from "./value.js";
import type { MemoryStore } from "./layers.js";

/**
 * Layer 6 feeding back into Layer 5: what a store did with past
 * recommendations changes what the brain recommends next. Two things change,
 * both worked out from what memory already holds (recommendations, their
 * feedback and the value ledger), so they survive a restart and need no
 * state of their own:
 *
 * - A subject dismissed recently is held back for a cooldown, unless its
 *   dollar estimate or its confidence grew enough to be news.
 * - Each rule's recommendations are ranked by how the store has treated
 *   that rule: mostly dismissed lowers its confidence, accepted ones that
 *   brought back measured value raise it.
 *
 * Every recommendation carries a short note saying why it ranks as it does.
 */

export interface FeedbackPolicy {
  /** Days a dismissed subject is held back. 0 turns the cooldown off. */
  cooldownDays: number;
  /** How far back the history reaches, in days: long enough for a 90-day measured result. */
  lookbackDays: number;
  /** Decisions a rule needs before dismissals lower its confidence. */
  minDecisions: number;
  /** How much a dollar estimate must grow, as a share of the dismissed one, to be shown again during the cooldown. */
  growthShare: number;
  /** How much confidence (the rule's severity) must grow, in points of 0 to 1, to be shown again during the cooldown. */
  confidenceGrowth: number;
}

export const DEFAULT_FEEDBACK_POLICY: FeedbackPolicy = {
  cooldownDays: 14,
  lookbackDays: 180,
  minDecisions: 3,
  growthShare: 0.25,
  confidenceGrowth: 0.1,
};

/** The longest cooldown allowed: it must fit inside the history the cooldown reads. */
export const MAX_FEEDBACK_COOLDOWN_DAYS = 90;

/** Confidence never drops below this share of what the rule wrote, however often it is dismissed. */
export const MIN_FEEDBACK_FACTOR = 0.6;

/** Why a policy can't be used, or null when it's sound. */
export function feedbackPolicyProblem(p: FeedbackPolicy): string | null {
  const whole = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!whole(p.cooldownDays) || p.cooldownDays > MAX_FEEDBACK_COOLDOWN_DAYS) return `the cooldown must be whole days, 0 to ${MAX_FEEDBACK_COOLDOWN_DAYS}`;
  if (!whole(p.lookbackDays) || p.lookbackDays < p.cooldownDays) return "the lookback must be whole days, at least the cooldown";
  if (!whole(p.minDecisions) || p.minDecisions < 1) return "a rule needs at least 1 decision before dismissals count";
  if (!(p.growthShare > 0) || !Number.isFinite(p.growthShare)) return "the growth share must be above 0";
  if (!(p.confidenceGrowth > 0 && p.confidenceGrowth <= 1)) return "the confidence growth must be above 0 and at most 1";
  return null;
}

/** How the store has treated one rule's recommendations over the lookback. */
export interface RuleFeedback {
  rule: string;
  /** Recommendations the rule raised in the lookback. */
  shown: number;
  /** By the latest word on each. */
  accepted: number;
  dismissed: number;
  overridden: number;
  /** Accepted recommendations with a result recorded, by the latest result on each. */
  returned: { count: number; cents: number; estimatedCents: number };
  /** Subjects of this rule held back now, for a dismissal inside the cooldown. */
  coolingDown: number;
  /** What its recommendations' confidence is multiplied by. */
  factor: number;
  note: string;
}

export interface FeedbackSummary {
  organizationId: string;
  asOf: string;
  cooldownDays: number;
  lookbackDays: number;
  /** One entry per rule with any history, by rule name. */
  rules: RuleFeedback[];
}

/** A recommendation held back by the cooldown. */
export interface HeldBack {
  id: string;
  rule: string | null;
  /** When the same rule and subject was last dismissed. */
  dismissedAt: string;
  /** When the cooldown ends. */
  until: string;
}

export interface FeedbackHistory {
  recommendations: Recommendation[];
  feedback: Feedback[];
  results: ValueResult[];
}

const DAY_MS = 86_400_000;
const DATE_SUFFIX = /_\d{4}-\d{2}-\d{2}$/;

/**
 * A recommendation's rule and subject, which stays the same from one day's
 * run to the next: its id without the trailing day. Rules write ids as
 * rec_<department>_<subject>_<day>, so two ids share a key exactly when the
 * same rule raised the same subject.
 */
export function subjectKey(recommendation: Pick<Recommendation, "id">): string {
  return recommendation.id.replace(DATE_SUFFIX, "");
}

/** The latest of each recommendation's records, by its own time, at or before `at`; ties go to the later record. */
function latestBy<T extends { recommendationId: string; recordedAt: string }>(records: readonly T[], at: number): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of records) {
    const t = Date.parse(r.recordedAt);
    if (!(t <= at)) continue;
    const current = out.get(r.recommendationId);
    if (!current || t >= Date.parse(current.recordedAt)) out.set(r.recommendationId, r);
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** One copy of each recommendation, the first a store handed back, for this organization. */
function distinct(recommendations: readonly Recommendation[], organizationId: string): Recommendation[] {
  const seen = new Set<string>();
  return recommendations.filter((r) => r.organizationId === organizationId && !seen.has(r.id) && (seen.add(r.id), true));
}

/** A dismissal inside the cooldown that still stands for one rule and subject. */
interface Cooling {
  dismissed: Recommendation;
  at: number;
}

/**
 * For each rule and subject whose latest decision, across all its
 * recommendations, is a dismissal recorded within the cooldown, that
 * dismissal. A later accept or override on the same subject ends it.
 */
function coolingSubjects(recs: readonly Recommendation[], words: Map<string, Feedback>, now: number, cooldownDays: number): Map<string, Cooling> {
  const latest = new Map<string, { rec: Recommendation; word: Feedback; at: number }>();
  for (const rec of recs) {
    const word = words.get(rec.id);
    if (!word) continue;
    const key = subjectKey(rec);
    const at = Date.parse(word.recordedAt);
    const current = latest.get(key);
    if (!current || at >= current.at) latest.set(key, { rec, word, at });
  }
  // A cooldown of 0 matches nothing: every word read is at or before now.
  const out = new Map<string, Cooling>();
  for (const [key, { rec, word, at }] of latest) {
    if (word.outcome === "rejected" && now - at < cooldownDays * DAY_MS) out.set(key, { dismissed: rec, at });
  }
  return out;
}

/** How the store has treated each rule, from its history. Rules with no history are left out. */
export function ruleFeedback(input: FeedbackHistory & { organizationId: string; now: string; policy?: FeedbackPolicy }): Map<string, RuleFeedback> {
  const policy = input.policy ?? DEFAULT_FEEDBACK_POLICY;
  const now = Date.parse(input.now);
  const since = now - policy.lookbackDays * DAY_MS;
  const mine = <T extends { organizationId: string }>(records: readonly T[]) => records.filter((r) => r.organizationId === input.organizationId);
  // Recommendations raised before the rule was recorded on them can't be told apart by rule, so they don't count.
  const recs = distinct(input.recommendations, input.organizationId).filter((r) => {
    const at = Date.parse(r.createdAt);
    return r.rule !== undefined && at >= since && at <= now;
  });
  const words = latestBy(mine(input.feedback), now);
  const results = latestBy(mine(input.results), now);
  const cooling = coolingSubjects(recs, words, now, policy.cooldownDays);

  const out = new Map<string, RuleFeedback>();
  for (const rec of recs) {
    const rule = rec.rule!;
    let entry = out.get(rule);
    if (!entry) {
      entry = { rule, shown: 0, accepted: 0, dismissed: 0, overridden: 0, returned: { count: 0, cents: 0, estimatedCents: 0 }, coolingDown: 0, factor: 1, note: "" };
      out.set(rule, entry);
    }
    entry.shown++;
    const outcome = words.get(rec.id)?.outcome;
    if (outcome === "accepted") {
      entry.accepted++;
      const result = results.get(rec.id);
      if (result) {
        entry.returned.count++;
        entry.returned.cents += result.cents;
        entry.returned.estimatedCents += rec.impact?.cents ?? 0;
      }
    } else if (outcome === "rejected") entry.dismissed++;
    else if (outcome === "overridden") entry.overridden++;
  }
  for (const { dismissed } of cooling.values()) {
    const entry = dismissed.rule === undefined ? undefined : out.get(dismissed.rule);
    if (entry) entry.coolingDown++;
  }
  for (const entry of out.values()) Object.assign(entry, rank(entry, policy));
  return out;
}

/**
 * The factor and note for one rule. Dismissals count once the rule has
 * `minDecisions` decisions: past half dismissed, confidence falls in a
 * straight line to MIN_FEEDBACK_FACTOR when every one was dismissed.
 * Accepted recommendations that brought money back raise it by a tenth, or
 * by a fifth when they brought back at least what was estimated.
 */
function rank(entry: RuleFeedback, policy: FeedbackPolicy): { factor: number; note: string } {
  const decided = entry.accepted + entry.dismissed + entry.overridden;
  const days = `in the last ${policy.lookbackDays} days`;
  const parts: string[] = [];
  let factor = 1;
  if (decided === 0) parts.push(`No decisions on this rule ${days}.`);
  else if (decided < policy.minDecisions) parts.push(`Only ${decided} of ${policy.minDecisions} decisions needed on this rule ${days}, so dismissals don't count yet.`);
  else {
    const share = entry.dismissed / decided;
    if (share > 0.5) {
      factor *= 1 - ((1 - MIN_FEEDBACK_FACTOR) * (share - 0.5)) / 0.5;
      parts.push(`${entry.dismissed} of ${decided} decisions on this rule ${days} were dismissals, so it ranks lower.`);
    } else parts.push(`${entry.dismissed} of ${decided} decisions on this rule ${days} were dismissals.`);
  }
  const { cents, estimatedCents, count } = entry.returned;
  if (cents > 0) {
    const met = estimatedCents > 0 && cents >= estimatedCents;
    factor *= met ? 1.2 : 1.1;
    const against = estimatedCents > 0 ? ` against ${usd(estimatedCents)} estimated` : "";
    parts.push(`${count === 1 ? "1 accepted recommendation" : `${count} accepted recommendations`} brought back ${usd(cents)}${against}, so it ranks ${met ? "well " : ""}higher.`);
  } else if (count > 0) parts.push(`${count === 1 ? "1 accepted recommendation" : `${count} accepted recommendations`} brought nothing back yet.`);
  return { factor: round2(factor), note: parts.join(" ") };
}

/** Whether a recommendation grew enough since its dismissal to be shown during the cooldown, and how. */
function grewBy(next: Recommendation, dismissed: Recommendation, policy: FeedbackPolicy): string | null {
  const before = dismissed.impact?.cents;
  const after = next.impact?.cents;
  if (after !== undefined && after > 0 && (before === undefined || after >= before * (1 + policy.growthShare))) {
    return before === undefined ? `it now carries an estimate of ${usd(after)}` : `its estimate grew from ${usd(before)} to ${usd(after)}`;
  }
  const was = dismissed.ranking?.baseConfidence ?? dismissed.confidence;
  // Rounded so 0.7 - 0.6 counts as the 0.1 it reads as.
  if (round2(next.confidence - was) >= policy.confidenceGrowth) return `its confidence rose from ${was.toFixed(2)} to ${next.confidence.toFixed(2)}`;
  return null;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Applies the history to a run's fresh recommendations: holds back those
 * cooling down, sets each kept one's confidence from its rule's factor with
 * a note saying why, records its rule, and orders them by that factor,
 * highest first. Ties, including every recommendation when there is no
 * history, keep the order the rules gave them.
 */
export function applyFeedback(input: FeedbackHistory & { organizationId: string; now: string; fresh: Recommendation[]; policy?: FeedbackPolicy }): {
  recommendations: Recommendation[];
  heldBack: HeldBack[];
} {
  const policy = input.policy ?? DEFAULT_FEEDBACK_POLICY;
  const problem = feedbackPolicyProblem(policy);
  if (problem) throw new RangeError(problem);
  const now = Date.parse(input.now);
  const rules = ruleFeedback({ ...input, policy });
  const recs = distinct(input.recommendations, input.organizationId).filter((r) => Date.parse(r.createdAt) <= now);
  const words = latestBy(
    input.feedback.filter((f) => f.organizationId === input.organizationId),
    now,
  );
  const cooling = coolingSubjects(recs, words, now, policy.cooldownDays);

  const kept: { rec: Recommendation; factor: number }[] = [];
  const heldBack: HeldBack[] = [];
  for (const rec of input.fresh) {
    const cool = cooling.get(subjectKey(rec));
    let lead = "";
    if (cool) {
      const grew = grewBy(rec, cool.dismissed, policy);
      if (!grew) {
        heldBack.push({ id: rec.id, rule: rec.rule ?? null, dismissedAt: new Date(cool.at).toISOString(), until: new Date(cool.at + policy.cooldownDays * DAY_MS).toISOString() });
        continue;
      }
      lead = `Shown again though it was dismissed on ${day(cool.at)}: ${grew}. `;
    }
    const rule = rec.rule === undefined ? undefined : rules.get(rec.rule);
    const factor = rule?.factor ?? 1;
    const note = lead + (rule?.note ?? `No decisions on this rule in the last ${policy.lookbackDays} days.`);
    const confidence = Math.min(1, Math.max(0, round2(rec.confidence * factor)));
    kept.push({ rec: { ...rec, confidence, ranking: { baseConfidence: rec.confidence, factor, note } }, factor });
  }
  // Array.prototype.sort is stable, so equal factors keep the rules' order.
  kept.sort((a, b) => b.factor - a.factor);
  return { recommendations: kept.map((k) => k.rec), heldBack };
}

/** Reads the history feedback needs from memory: the lookback's recommendations, their feedback and results. */
export async function readFeedbackHistory(
  memory: Pick<MemoryStore, "recommendationsBetween" | "listFeedback" | "listValueResults">,
  organizationId: string,
  now: string,
  policy: FeedbackPolicy = DEFAULT_FEEDBACK_POLICY,
): Promise<FeedbackHistory> {
  const at = Date.parse(now);
  const recommendations = await memory.recommendationsBetween(organizationId, new Date(at - policy.lookbackDays * DAY_MS).toISOString(), new Date(at + 1).toISOString());
  if (recommendations.length === 0) return { recommendations, feedback: [], results: [] };
  const ids = [...new Set(recommendations.map((r) => r.id))];
  const [feedback, results] = await Promise.all([memory.listFeedback(organizationId, ids), memory.listValueResults(organizationId, ids)]);
  return { recommendations, feedback, results };
}

/** The per-rule summary as of `now`, from memory. */
export async function readFeedbackSummary(
  memory: Pick<MemoryStore, "recommendationsBetween" | "listFeedback" | "listValueResults">,
  organizationId: string,
  now: string,
  policy: FeedbackPolicy = DEFAULT_FEEDBACK_POLICY,
): Promise<FeedbackSummary> {
  const problem = feedbackPolicyProblem(policy);
  if (problem) throw new RangeError(problem);
  const history = await readFeedbackHistory(memory, organizationId, now, policy);
  const rules = [...ruleFeedback({ ...history, organizationId, now, policy }).values()].sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  return { organizationId, asOf: new Date(Date.parse(now)).toISOString(), cooldownDays: policy.cooldownDays, lookbackDays: policy.lookbackDays, rules };
}
