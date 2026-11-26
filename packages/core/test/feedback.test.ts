import { describe, expect, it } from "vitest";
import {
  applyFeedback,
  BrainPipeline,
  DEFAULT_FEEDBACK_POLICY,
  feedbackPolicyProblem,
  InMemoryStore,
  readFeedbackHistory,
  readFeedbackSummary,
  ruleFeedback,
  subjectKey,
  type Feedback,
  type FeedbackPolicy,
  type Reasoner,
  type Recommendation,
  type ValueResult,
} from "../src/index.js";

const ORG = "org_a";
const NOW = "2026-11-26T12:00:00.000Z";
const DAY = 86_400_000;
const ago = (days: number, from = NOW) => new Date(Date.parse(from) - days * DAY).toISOString();

/** A recommendation by dept.rule; `rule: undefined` makes one stored before rules were recorded. */
function rec(id: string, over: Omit<Partial<Recommendation>, "rule"> & { rule?: string | undefined } = {}): Recommendation {
  const { rule, ...rest } = { rule: "dept.rule", ...over };
  return {
    id,
    organizationId: ORG,
    summary: id,
    confidence: 0.8,
    expectedImpact: "",
    provenance: { eventIds: [], signalIds: [], documentIds: [] },
    degraded: false,
    createdAt: NOW,
    ...(rule === undefined ? {} : { rule }),
    ...rest,
  };
}

const priced = (cents: number) => ({ kind: "makes" as const, lowCents: 0, cents, highCents: cents * 2, basis: "test" });

function word(recommendationId: string, outcome: Feedback["outcome"], recordedAt: string, organizationId = ORG): Feedback {
  return { recommendationId, organizationId, outcome, actor: "owner", recordedAt };
}

function result(recommendationId: string, cents: number, recordedAt: string, over: Partial<ValueResult> = {}): ValueResult {
  return { recommendationId, organizationId: ORG, kind: "makes", cents, source: "measured", measuredDays: 30, actor: "karatos", recordedAt, ...over };
}

const none = { recommendations: [] as Recommendation[], feedback: [] as Feedback[], results: [] as ValueResult[] };

function apply(fresh: Recommendation[], history: Partial<typeof none> = {}, policy?: FeedbackPolicy) {
  return applyFeedback({ ...none, ...history, organizationId: ORG, now: NOW, fresh, ...(policy ? { policy } : {}) });
}

/** A rule with `dismissed` dismissals and `accepted` accepts, each on its own subject, raised days ago. */
function decided(rule: string, dismissed: number, accepted: number, overridden = 0) {
  const recommendations: Recommendation[] = [];
  const feedback: Feedback[] = [];
  const add = (outcome: Feedback["outcome"], n: number) => {
    for (let i = 0; i < n; i++) {
      const id = `rec_${rule}_${outcome}${i}_${ago(40).slice(0, 10)}`;
      recommendations.push(rec(id, { rule, createdAt: ago(40) }));
      feedback.push(word(id, outcome, ago(39)));
    }
  };
  add("rejected", dismissed);
  add("accepted", accepted);
  add("overridden", overridden);
  return { recommendations, feedback };
}

describe("subjectKey", () => {
  it("drops the day so one rule and subject keeps its key from run to run", () => {
    expect(subjectKey({ id: "rec_clienteling_lapsed_c1_2026-11-20" })).toBe("rec_clienteling_lapsed_c1");
    expect(subjectKey({ id: "rec_clienteling_lapsed_c1_2026-11-26" })).toBe("rec_clienteling_lapsed_c1");
  });

  it("leaves an id with no day as it is", () => {
    expect(subjectKey({ id: "rec_manual_1" })).toBe("rec_manual_1");
    expect(subjectKey({ id: "rec_x_2026-11-2" })).toBe("rec_x_2026-11-2");
    expect(subjectKey({ id: "rec_x_2026-11-26_extra" })).toBe("rec_x_2026-11-26_extra");
  });
});

describe("applyFeedback with no history", () => {
  it("keeps every recommendation, its confidence and its order, and says there is nothing to go on", () => {
    const fresh = [rec("rec_a_1_2026-11-26", { confidence: 0.3 }), rec("rec_b_1_2026-11-26", { rule: "other" }), rec("rec_c_1_2026-11-26", { rule: undefined })];
    const { recommendations, heldBack } = apply(fresh);
    expect(heldBack).toEqual([]);
    expect(recommendations.map((r) => r.id)).toEqual(fresh.map((r) => r.id));
    expect(recommendations.map((r) => r.confidence)).toEqual([0.3, 0.8, 0.8]);
    for (const r of recommendations) {
      expect(r.ranking).toEqual({ baseConfidence: r.confidence, factor: 1, note: "No decisions on this rule in the last 180 days." });
    }
  });

  it("doesn't change the recommendations it is given", () => {
    const fresh = [rec("rec_a_1_2026-11-26")];
    apply(fresh, decided("dept.rule", 5, 0));
    expect(fresh[0]).toEqual(rec("rec_a_1_2026-11-26"));
  });
});

describe("the cooldown", () => {
  const dismissedId = "rec_clienteling_lapsed_c1_2026-11-20";
  const freshId = "rec_clienteling_lapsed_c1_2026-11-26";

  it("holds back the same rule and subject dismissed within the cooldown", () => {
    const { recommendations, heldBack } = apply([rec(freshId), rec("rec_clienteling_lapsed_c2_2026-11-26")], {
      recommendations: [rec(dismissedId, { createdAt: ago(6) })],
      feedback: [word(dismissedId, "rejected", ago(5))],
    });
    expect(recommendations.map((r) => r.id)).toEqual(["rec_clienteling_lapsed_c2_2026-11-26"]);
    expect(heldBack).toEqual([{ id: freshId, rule: "dept.rule", dismissedAt: ago(5), until: new Date(Date.parse(ago(5)) + 14 * DAY).toISOString() }]);
  });

  it("holds back a rerun on the day of its own dismissal", () => {
    const { recommendations, heldBack } = apply([rec(freshId)], { recommendations: [rec(freshId)], feedback: [word(freshId, "rejected", NOW)] });
    expect(recommendations).toEqual([]);
    expect(heldBack.map((h) => h.id)).toEqual([freshId]);
  });

  it("ends when the cooldown has passed, to the millisecond", () => {
    const history = (at: string) => ({ recommendations: [rec(dismissedId, { createdAt: ago(20) })], feedback: [word(dismissedId, "rejected", at)] });
    expect(apply([rec(freshId)], history(ago(14))).heldBack).toEqual([]);
    expect(apply([rec(freshId)], history(new Date(Date.parse(ago(14)) + 1).toISOString())).heldBack).toHaveLength(1);
  });

  it("follows a configured cooldown, and 0 turns it off", () => {
    const history = { recommendations: [rec(dismissedId, { createdAt: ago(6) })], feedback: [word(dismissedId, "rejected", ago(5))] };
    expect(apply([rec(freshId)], history, { ...DEFAULT_FEEDBACK_POLICY, cooldownDays: 3 }).heldBack).toEqual([]);
    expect(apply([rec(freshId)], history, { ...DEFAULT_FEEDBACK_POLICY, cooldownDays: 6 }).heldBack).toHaveLength(1);
    expect(apply([rec(freshId)], history, { ...DEFAULT_FEEDBACK_POLICY, cooldownDays: 0 }).heldBack).toEqual([]);
  });

  it("ends when a later decision on the same subject accepted or overrode it", () => {
    const later = "rec_clienteling_lapsed_c1_2026-11-22";
    for (const outcome of ["accepted", "overridden"] as const) {
      const { heldBack } = apply([rec(freshId)], {
        recommendations: [rec(dismissedId, { createdAt: ago(6) }), rec(later, { createdAt: ago(4) })],
        feedback: [word(dismissedId, "rejected", ago(5)), word(later, outcome, ago(3))],
      });
      expect(heldBack).toEqual([]);
    }
  });

  it("goes by the latest word on a recommendation, so a dismissal taken back doesn't count", () => {
    const history = { recommendations: [rec(dismissedId, { createdAt: ago(6) })], feedback: [word(dismissedId, "rejected", ago(5)), word(dismissedId, "accepted", ago(4))] };
    expect(apply([rec(freshId)], history).heldBack).toEqual([]);
    // And an accept later turned into a dismissal does.
    const reversed = { ...history, feedback: [word(dismissedId, "accepted", ago(5)), word(dismissedId, "rejected", ago(4))] };
    expect(apply([rec(freshId)], reversed).heldBack).toHaveLength(1);
  });

  it("ignores a recommendation dated after the run started", () => {
    const future = "rec_clienteling_lapsed_c1_2026-11-27";
    const history = { recommendations: [rec(future, { createdAt: new Date(Date.parse(NOW) + DAY).toISOString() })], feedback: [word(future, "rejected", ago(1))] };
    expect(apply([rec(freshId)], history).heldBack).toEqual([]);
  });

  it("ignores a dismissal recorded after the run started", () => {
    const history = { recommendations: [rec(dismissedId, { createdAt: ago(6) })], feedback: [word(dismissedId, "rejected", new Date(Date.parse(NOW) + 1).toISOString())] };
    expect(apply([rec(freshId)], history).heldBack).toEqual([]);
  });

  it("ignores other organizations' recommendations and feedback", () => {
    expect(
      apply([rec(freshId)], { recommendations: [rec(dismissedId, { organizationId: "org_b", createdAt: ago(6) })], feedback: [word(dismissedId, "rejected", ago(5))] }).heldBack,
    ).toEqual([]);
    expect(apply([rec(freshId)], { recommendations: [rec(dismissedId, { createdAt: ago(6) })], feedback: [word(dismissedId, "rejected", ago(5), "org_b")] }).heldBack).toEqual([]);
  });

  it("holds back even recommendations stored before rules were recorded, by subject", () => {
    const { heldBack } = apply([rec(freshId)], { recommendations: [rec(dismissedId, { rule: undefined, createdAt: ago(6) })], feedback: [word(dismissedId, "rejected", ago(5))] });
    expect(heldBack).toHaveLength(1);
  });

  describe("shows it again when it grew materially", () => {
    const history = (dismissed: Partial<Recommendation>) => ({ recommendations: [rec(dismissedId, { createdAt: ago(6), ...dismissed })], feedback: [word(dismissedId, "rejected", ago(5))] });

    it("by a quarter or more of its dollar estimate", () => {
      const grown = apply([rec(freshId, { impact: priced(12_500) })], history({ impact: priced(10_000) }));
      expect(grown.heldBack).toEqual([]);
      expect(grown.recommendations[0]!.ranking!.note).toBe(
        "Shown again though it was dismissed on 2026-11-21: its estimate grew from $100.00 to $125.00. Only 1 of 3 decisions needed on this rule in the last 180 days, so dismissals don't count yet.",
      );
      expect(apply([rec(freshId, { impact: priced(12_499) })], history({ impact: priced(10_000) })).heldBack).toHaveLength(1);
      expect(apply([rec(freshId, { impact: priced(5_000) })], history({ impact: priced(10_000) })).heldBack).toHaveLength(1);
    });

    it("when it now has an estimate and the dismissed one had none", () => {
      const { recommendations } = apply([rec(freshId, { impact: priced(100) })], history({}));
      expect(recommendations[0]!.ranking!.note).toContain("it now carries an estimate of $1.00");
      expect(apply([rec(freshId, { impact: priced(0) })], history({})).heldBack).toHaveLength(1);
      expect(apply([rec(freshId)], history({ impact: priced(100) })).heldBack).toHaveLength(1);
    });

    it("from a zero estimate to any amount", () => {
      expect(apply([rec(freshId, { impact: priced(1) })], history({ impact: priced(0) })).heldBack).toEqual([]);
    });

    it("by 0.1 or more of confidence, against what the rule wrote before feedback", () => {
      const up = apply([rec(freshId, { confidence: 0.7 })], history({ confidence: 0.6 }));
      expect(up.heldBack).toEqual([]);
      expect(up.recommendations[0]!.ranking!.note).toContain("its confidence rose from 0.60 to 0.70");
      expect(apply([rec(freshId, { confidence: 0.69 })], history({ confidence: 0.6 })).heldBack).toHaveLength(1);
      // The dismissed one was shown at 0.48 after feedback, but the rule wrote 0.6.
      expect(apply([rec(freshId, { confidence: 0.65 })], history({ confidence: 0.48, ranking: { baseConfidence: 0.6, factor: 0.8, note: "" } })).heldBack).toHaveLength(1);
    });
  });
});

describe("ranking by rule", () => {
  it("leaves a rule alone below the decisions it needs", () => {
    const { recommendations } = apply([rec("rec_x_1_2026-11-26")], decided("dept.rule", 2, 0));
    expect(recommendations[0]!.confidence).toBe(0.8);
    expect(recommendations[0]!.ranking).toEqual({
      baseConfidence: 0.8,
      factor: 1,
      note: "Only 2 of 3 decisions needed on this rule in the last 180 days, so dismissals don't count yet.",
    });
  });

  it("lowers a rule that is always dismissed to the floor", () => {
    const { recommendations } = apply([rec("rec_x_1_2026-11-26")], decided("dept.rule", 3, 0));
    expect(recommendations[0]!.confidence).toBe(0.48);
    expect(recommendations[0]!.ranking).toEqual({
      baseConfidence: 0.8,
      factor: 0.6,
      note: "3 of 3 decisions on this rule in the last 180 days were dismissals, so it ranks lower.",
    });
  });

  it("lowers in a straight line past half dismissed, and not at half", () => {
    const factor = (d: number, a: number, o = 0) => ruleFeedback({ ...decided("r", d, a, o), results: [], organizationId: ORG, now: NOW }).get("r")!.factor;
    expect(factor(2, 2)).toBe(1);
    expect(factor(3, 1)).toBe(0.8);
    expect(factor(4, 1)).toBe(0.76);
    // An override is a decision but not a dismissal.
    expect(factor(3, 0, 1)).toBe(0.8);
    expect(factor(0, 0, 3)).toBe(1);
  });

  it("says a rule at exactly half dismissed isn't lowered", () => {
    expect(ruleFeedback({ ...decided("r", 2, 2), results: [], organizationId: ORG, now: NOW }).get("r")!.note).toBe("2 of 4 decisions on this rule in the last 180 days were dismissals.");
  });

  it("ignores another organization's feedback and results on a recommendation with the same id", () => {
    const base = decided("dept.rule", 0, 1);
    const id = base.recommendations[0]!.id;
    const rules = ruleFeedback({
      recommendations: base.recommendations,
      feedback: [...base.feedback, word(id, "rejected", ago(5), "org_b")],
      results: [result(id, 900, ago(5), { organizationId: "org_b" })],
      organizationId: ORG,
      now: NOW,
    });
    expect(rules.get("dept.rule")).toMatchObject({ accepted: 1, dismissed: 0, returned: { count: 0, cents: 0, estimatedCents: 0 } });
  });

  it("raises a rule whose accepted recommendations brought money back", () => {
    const base = decided("dept.rule", 0, 2);
    const results = [result(base.recommendations[0]!.id, 5_000, ago(10)), result(base.recommendations[1]!.id, 0, ago(10))];
    const ok = apply([rec("rec_x_1_2026-11-26")], { ...base, results });
    expect(ok.recommendations[0]!.ranking).toEqual({
      baseConfidence: 0.8,
      factor: 1.1,
      note: "Only 2 of 3 decisions needed on this rule in the last 180 days, so dismissals don't count yet. 2 accepted recommendations brought back $50.00, so it ranks higher.",
    });
    expect(ok.recommendations[0]!.confidence).toBe(0.88);
  });

  it("raises it further when they brought back at least what was estimated", () => {
    const base = decided("dept.rule", 1, 2);
    base.recommendations[1]!.impact = priced(10_000);
    const met = apply([rec("rec_x_1_2026-11-26", { confidence: 0.9 })], { ...base, results: [result(base.recommendations[1]!.id, 10_000, ago(10))] });
    expect(met.recommendations[0]!.ranking).toEqual({
      baseConfidence: 0.9,
      factor: 1.2,
      note: "1 of 3 decisions on this rule in the last 180 days were dismissals. 1 accepted recommendation brought back $100.00 against $100.00 estimated, so it ranks well higher.",
    });
    // Never above 1.
    expect(met.recommendations[0]!.confidence).toBe(1);
    const short = apply([rec("rec_x_1_2026-11-26")], { ...base, results: [result(base.recommendations[1]!.id, 9_999, ago(10))] });
    expect(short.recommendations[0]!.ranking!.factor).toBe(1.1);
    expect(short.recommendations[0]!.ranking!.note).toContain("against $100.00 estimated, so it ranks higher.");
  });

  it("goes by the latest result, so a 60-day result replaces the 30-day one", () => {
    const base = decided("dept.rule", 0, 1);
    const id = base.recommendations[0]!.id;
    const rules = ruleFeedback({ ...base, results: [result(id, 0, ago(20)), result(id, 700, ago(5), { measuredDays: 60 })], organizationId: ORG, now: NOW });
    expect(rules.get("dept.rule")!.returned).toEqual({ count: 1, cents: 700, estimatedCents: 0 });
  });

  it("combines a dismissal penalty with a value boost", () => {
    const base = decided("dept.rule", 3, 1);
    const rules = ruleFeedback({ ...base, results: [result(base.recommendations[3]!.id, 100, ago(10))], organizationId: ORG, now: NOW });
    expect(rules.get("dept.rule")!.factor).toBe(0.88);
  });

  it("counts no value from results on recommendations that weren't accepted", () => {
    const base = decided("dept.rule", 1, 0);
    const rules = ruleFeedback({ ...base, results: [result(base.recommendations[0]!.id, 10_000, ago(10))], organizationId: ORG, now: NOW });
    expect(rules.get("dept.rule")).toMatchObject({ returned: { count: 0, cents: 0, estimatedCents: 0 }, factor: 1 });
  });

  it("says when accepted ones brought nothing back yet", () => {
    const base = decided("dept.rule", 0, 1);
    const rules = ruleFeedback({ ...base, results: [result(base.recommendations[0]!.id, 0, ago(10))], organizationId: ORG, now: NOW });
    expect(rules.get("dept.rule")!.note).toBe("Only 1 of 3 decisions needed on this rule in the last 180 days, so dismissals don't count yet. 1 accepted recommendation brought nothing back yet.");
    const two = decided("dept.rule", 0, 2);
    const both = ruleFeedback({ ...two, results: two.recommendations.map((r) => result(r.id, 0, ago(10))), organizationId: ORG, now: NOW });
    expect(both.get("dept.rule")!.note).toContain("2 accepted recommendations brought nothing back yet.");
  });

  it("orders kept recommendations by their rule's factor, and ties keep the rules' order", () => {
    const history = {
      recommendations: [...decided("low", 3, 0).recommendations, ...decided("high", 0, 1).recommendations],
      feedback: [...decided("low", 3, 0).feedback, ...decided("high", 0, 1).feedback],
      results: [result(decided("high", 0, 1).recommendations[0]!.id, 500, ago(10))],
    };
    const fresh = [
      rec("rec_l_1_2026-11-26", { rule: "low" }),
      rec("rec_n_1_2026-11-26", { rule: "none" }),
      rec("rec_h_1_2026-11-26", { rule: "high" }),
      rec("rec_n_2_2026-11-26", { rule: "none" }),
      rec("rec_l_2_2026-11-26", { rule: "low" }),
      rec("rec_h_2_2026-11-26", { rule: "high" }),
    ];
    expect(apply(fresh, history).recommendations.map((r) => r.id)).toEqual([
      "rec_h_1_2026-11-26",
      "rec_h_2_2026-11-26",
      "rec_n_1_2026-11-26",
      "rec_n_2_2026-11-26",
      "rec_l_1_2026-11-26",
      "rec_l_2_2026-11-26",
    ]);
  });

  it("only counts the lookback, recommendations with a rule, and each recommendation once", () => {
    const old = rec("rec_old_2026-01-01", { createdAt: ago(181) });
    const future = rec("rec_future_2026-12-01", { createdAt: new Date(Date.parse(NOW) + 1).toISOString() });
    const unruled = rec("rec_unruled_2026-11-01", { rule: undefined, createdAt: ago(25) });
    const edge = rec("rec_edge_2026-05-30", { createdAt: ago(180) });
    const rules = ruleFeedback({
      recommendations: [old, future, unruled, edge, edge],
      feedback: [word(old.id, "rejected", ago(1)), word(future.id, "rejected", ago(1)), word(unruled.id, "rejected", ago(1)), word(edge.id, "rejected", ago(1))],
      results: [],
      organizationId: ORG,
      now: NOW,
    });
    expect([...rules.values()]).toEqual([
      expect.objectContaining({ rule: "dept.rule", shown: 1, dismissed: 1, accepted: 0, overridden: 0, coolingDown: 1 }),
    ]);
  });

  it("counts subjects cooling down per rule, each once", () => {
    const a1 = rec("rec_a_s1_2026-11-20", { createdAt: ago(6) });
    const a2 = rec("rec_a_s1_2026-11-21", { createdAt: ago(5) });
    const b = rec("rec_a_s2_2026-11-21", { createdAt: ago(5) });
    const rules = ruleFeedback({
      recommendations: [a1, a2, b],
      feedback: [word(a1.id, "rejected", ago(5)), word(a2.id, "rejected", ago(4)), word(b.id, "accepted", ago(4))],
      results: [],
      organizationId: ORG,
      now: NOW,
    });
    expect(rules.get("dept.rule")).toMatchObject({ shown: 3, dismissed: 2, accepted: 1, coolingDown: 1 });
    expect(ruleFeedback({ recommendations: [a1], feedback: [word(a1.id, "rejected", ago(5))], results: [], organizationId: ORG, now: NOW, policy: { ...DEFAULT_FEEDBACK_POLICY, cooldownDays: 0 } }).get("dept.rule")!.coolingDown).toBe(0);
  });

  it("counts an undecided recommendation as shown only, and says no decisions were made", () => {
    const r = rec("rec_a_s1_2026-11-20", { createdAt: ago(6) });
    expect(ruleFeedback({ recommendations: [r], feedback: [], results: [], organizationId: ORG, now: NOW }).get("dept.rule")).toEqual({
      rule: "dept.rule",
      shown: 1,
      accepted: 0,
      dismissed: 0,
      overridden: 0,
      returned: { count: 0, cents: 0, estimatedCents: 0 },
      coolingDown: 0,
      factor: 1,
      note: "No decisions on this rule in the last 180 days.",
    });
  });

  it("goes by the latest word when two are recorded at the same instant", () => {
    const r = rec("rec_a_s1_2026-11-20", { createdAt: ago(6) });
    const rules = ruleFeedback({ recommendations: [r], feedback: [word(r.id, "accepted", ago(1)), word(r.id, "rejected", ago(1))], results: [], organizationId: ORG, now: NOW });
    expect(rules.get("dept.rule")).toMatchObject({ accepted: 0, dismissed: 1 });
  });
});

describe("feedbackPolicyProblem", () => {
  const p = (over: Partial<FeedbackPolicy>) => feedbackPolicyProblem({ ...DEFAULT_FEEDBACK_POLICY, ...over });

  it("accepts the default and the edges", () => {
    expect(p({})).toBeNull();
    expect(p({ cooldownDays: 0 })).toBeNull();
    expect(p({ cooldownDays: 90 })).toBeNull();
    expect(p({ cooldownDays: 30, lookbackDays: 30 })).toBeNull();
    expect(p({ minDecisions: 1, confidenceGrowth: 1 })).toBeNull();
  });

  it("turns down what can't work", () => {
    expect(p({ cooldownDays: -1 })).toMatch(/cooldown/);
    expect(p({ cooldownDays: 91 })).toMatch(/cooldown/);
    expect(p({ cooldownDays: 1.5 })).toMatch(/cooldown/);
    expect(p({ cooldownDays: 30, lookbackDays: 29 })).toMatch(/lookback/);
    expect(p({ lookbackDays: 1.5 })).toMatch(/lookback/);
    expect(p({ minDecisions: 0 })).toMatch(/decision/);
    expect(p({ minDecisions: 1.5 })).toMatch(/decision/);
    expect(p({ growthShare: 0 })).toMatch(/growth share/);
    expect(p({ growthShare: Infinity })).toMatch(/growth share/);
    expect(p({ growthShare: NaN })).toMatch(/growth share/);
    expect(p({ confidenceGrowth: 0 })).toMatch(/confidence growth/);
    expect(p({ confidenceGrowth: 1.01 })).toMatch(/confidence growth/);
  });

  it("is checked by applyFeedback, readFeedbackSummary and the pipeline", async () => {
    expect(() => apply([], {}, { ...DEFAULT_FEEDBACK_POLICY, minDecisions: 0 })).toThrow(RangeError);
    await expect(readFeedbackSummary(new InMemoryStore(), ORG, NOW, { ...DEFAULT_FEEDBACK_POLICY, cooldownDays: 91 })).rejects.toThrow(RangeError);
    expect(() => pipeline(new InMemoryStore(), [], { cooldownDays: -1 })).toThrow(RangeError);
  });
});

function pipeline(memory: InMemoryStore, reasoners: Reasoner[], feedback?: Partial<FeedbackPolicy> | false, now = NOW) {
  return new BrainPipeline({
    memory,
    normalizers: [],
    extractors: [],
    reasoners,
    documentation: { current: () => ({ documentIds: [], stale: false }) },
    ...(feedback !== undefined ? { feedback } : {}),
    now: () => new Date(now),
  });
}

/** A rule that raises one recommendation per subject, for the run's day. */
const rule = (name: string, subjects: string[], over: Partial<Recommendation> = {}): Reasoner => ({
  name,
  reason: ({ organizationId, now }) => subjects.map((s) => rec(`rec_${name}_${s}_${now.slice(0, 10)}`, { organizationId, createdAt: now, rule: "the reasoner's own word", ...over })),
});

describe("the pipeline's feedback loop", () => {
  it("records each recommendation's rule as the reasoner that raised it, and its ranking", async () => {
    const memory = new InMemoryStore();
    const out = await pipeline(memory, [rule("a", ["s1"]), rule("b", ["s1"])]).reason(ORG);
    expect(out.map((r) => [r.id, r.rule, r.ranking?.factor])).toEqual([
      ["rec_a_s1_2026-11-26", "a", 1],
      ["rec_b_s1_2026-11-26", "b", 1],
    ]);
    expect(memory.recommendations).toEqual(out);
  });

  it("drops a ranking a reasoner wrote itself", async () => {
    const out = await pipeline(new InMemoryStore(), [rule("a", ["s1"], { confidence: 0.5, ranking: { baseConfidence: 0.1, factor: 5, note: "trust me" } })], false).reason(ORG);
    expect(out[0]).not.toHaveProperty("ranking");
    expect(out[0]!.confidence).toBe(0.5);
  });

  it("holds back a dismissed subject on the next day's run, neither storing nor returning it, and says so", async () => {
    const memory = new InMemoryStore();
    const reasoners = [rule("a", ["s1", "s2"])];
    const first = await pipeline(memory, reasoners, undefined, ago(1)).reason(ORG);
    await memory.recordFeedback(word(first[0]!.id, "rejected", ago(1)));
    const second = await pipeline(memory, reasoners).reasonWithFeedback(ORG);
    expect(second.recommendations.map((r) => r.id)).toEqual(["rec_a_s2_2026-11-26"]);
    expect(second.heldBack).toEqual([{ id: "rec_a_s1_2026-11-26", rule: "a", dismissedAt: ago(1), until: new Date(Date.parse(ago(1)) + 14 * DAY).toISOString() }]);
    expect(memory.recommendations.map((r) => r.id)).toEqual(["rec_a_s1_2026-11-25", "rec_a_s2_2026-11-25", "rec_a_s2_2026-11-26"]);
    expect(memory.reasoningRuns.at(-1)!.recommendationIds).toEqual(["rec_a_s2_2026-11-26"]);
  });

  it("uses a configured cooldown", async () => {
    const memory = new InMemoryStore();
    const reasoners = [rule("a", ["s1"])];
    const first = await pipeline(memory, reasoners, undefined, ago(3)).reason(ORG);
    await memory.recordFeedback(word(first[0]!.id, "rejected", ago(3)));
    expect((await pipeline(memory, reasoners, { cooldownDays: 2 }).reasonWithFeedback(ORG)).heldBack).toEqual([]);
    expect(pipeline(memory, reasoners, { cooldownDays: 2 }).feedbackPolicy).toEqual({ ...DEFAULT_FEEDBACK_POLICY, cooldownDays: 2 });
  });

  it("with the loop off, shows everything as written apart from its rule", async () => {
    const memory = new InMemoryStore();
    const reasoners = [rule("a", ["s1"])];
    const first = await pipeline(memory, reasoners, false, ago(1)).reason(ORG);
    await memory.recordFeedback(word(first[0]!.id, "rejected", ago(1)));
    const off = pipeline(memory, reasoners, false);
    expect(off.feedbackPolicy).toBeNull();
    const second = await off.reasonWithFeedback(ORG);
    expect(second.heldBack).toEqual([]);
    expect(second.recommendations).toEqual([rec("rec_a_s1_2026-11-26", { rule: "a" })]);
  });

  it("lowers a rule the store keeps dismissing on later runs", async () => {
    const memory = new InMemoryStore();
    const reasoners = [rule("a", ["s1", "s2", "s3"])];
    const first = await pipeline(memory, reasoners, undefined, ago(30)).reason(ORG);
    for (const r of first) await memory.recordFeedback(word(r.id, "rejected", ago(29)));
    const later = await pipeline(memory, reasoners).reason(ORG);
    expect(later.map((r) => [r.confidence, r.ranking!.factor])).toEqual([
      [0.48, 0.6],
      [0.48, 0.6],
      [0.48, 0.6],
    ]);
  });
});

describe("reading from memory", () => {
  it("reads the lookback's recommendations with their feedback and results only", async () => {
    const memory = new InMemoryStore();
    const inside = rec("rec_in_2026-11-01", { createdAt: ago(25) });
    const outside = rec("rec_out_2026-01-01", { createdAt: ago(181) });
    await memory.saveRecommendations([inside, outside]);
    await memory.recordFeedback(word(inside.id, "accepted", ago(24)));
    await memory.recordFeedback(word(outside.id, "accepted", ago(24)));
    await memory.recordValueResult(result(inside.id, 100, ago(1)));
    expect(await readFeedbackHistory(memory, ORG, NOW)).toEqual({ recommendations: [inside], feedback: [word(inside.id, "accepted", ago(24))], results: [result(inside.id, 100, ago(1))] });
    expect(await readFeedbackHistory(memory, "org_b", NOW)).toEqual({ recommendations: [], feedback: [], results: [] });
  });

  it("asks for no feedback or results when the lookback holds no recommendations", async () => {
    const memory = new InMemoryStore();
    const asked: string[] = [];
    const spy = {
      recommendationsBetween: (...a: Parameters<InMemoryStore["recommendationsBetween"]>) => memory.recommendationsBetween(...a),
      listFeedback: async () => (asked.push("feedback"), []),
      listValueResults: async () => (asked.push("results"), []),
    };
    expect(await readFeedbackHistory(spy, ORG, NOW)).toEqual({ recommendations: [], feedback: [], results: [] });
    expect(asked).toEqual([]);
    await memory.saveRecommendations([rec("rec_in_2026-11-01", { createdAt: ago(25) })]);
    await readFeedbackHistory(spy, ORG, NOW);
    expect(asked.sort()).toEqual(["feedback", "results"]);
  });

  it("summarises each rule by name, with the policy and time", async () => {
    const memory = new InMemoryStore();
    await memory.saveRecommendations([rec("rec_z_2026-11-01", { rule: "z", createdAt: ago(25) }), rec("rec_y_2026-11-01", { rule: "y", createdAt: ago(25) })]);
    const summary = await readFeedbackSummary(memory, ORG, NOW, { ...DEFAULT_FEEDBACK_POLICY, cooldownDays: 7 });
    expect(summary).toMatchObject({ organizationId: ORG, asOf: NOW, cooldownDays: 7, lookbackDays: 180 });
    expect(summary.rules.map((r) => r.rule)).toEqual(["y", "z"]);
    expect((await readFeedbackSummary(new InMemoryStore(), ORG, NOW)).rules).toEqual([]);
  });
});
