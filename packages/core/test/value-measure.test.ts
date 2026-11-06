import { describe, expect, it } from "vitest";
import {
  dueMeasurements,
  impactProblem,
  InMemoryStore,
  measureValue,
  valueResultProblem,
  type Feedback,
  type Impact,
  type ImpactMeasure,
  type Recommendation,
  type Signal,
  type ValueResult,
} from "../src/index.js";

const ORG = "org_a";
const DAY = 86_400_000;
const CREATED = "2026-06-01T12:00:00.000Z";
const after = (days: number, extraMs = 0) => new Date(Date.parse(CREATED) + days * DAY + extraMs).toISOString();

const measure: ImpactMeasure = {
  signalKind: "sale.customer_purchase",
  subject: { kind: "customer", id: "c1" },
  centsField: "totalCents",
  share: 0.45,
  windowDays: 90,
  label: "purchases",
};
const impact = (over: Partial<ImpactMeasure> = {}): Impact => ({ kind: "makes", lowCents: 100, cents: 200, highCents: 300, basis: "test", measure: { ...measure, ...over } });

const rec = (id: string, i: Impact | null = impact(), createdAt = CREATED, organizationId = ORG): Recommendation => ({
  id,
  organizationId,
  summary: id,
  confidence: 0.5,
  expectedImpact: "",
  ...(i ? { impact: i } : {}),
  provenance: { eventIds: [], signalIds: [], documentIds: [] },
  degraded: false,
  createdAt,
});

const accepted = (recommendationId: string, recordedAt = after(1), outcome: Feedback["outcome"] = "accepted"): Feedback => ({
  recommendationId,
  organizationId: ORG,
  outcome,
  actor: "owner",
  recordedAt,
});

let n = 0;
const purchase = (observedAt: string, totalCents: unknown, over: Partial<Signal> = {}): Signal => ({
  id: `sig_${n++}`,
  organizationId: ORG,
  kind: "sale.customer_purchase",
  subject: { kind: "customer", id: "c1" },
  value: { totalCents },
  confidence: 1,
  derivedFromEventIds: [],
  observedAt,
  ...over,
});

const due = (input: { recommendations?: Recommendation[]; feedback?: Feedback[]; results?: ValueResult[]; signals?: Signal[]; now: string }) =>
  dueMeasurements({ organizationId: ORG, recommendations: [rec("a")], feedback: [accepted("a")], results: [], signals: [], ...input });

describe("impact measures", () => {
  it("accepts a sound measure, and names what's wrong with one that isn't", () => {
    expect(impactProblem(impact())).toBeNull();
    expect(impactProblem(impact({ share: 1, windowDays: 30 }))).toBeNull();
    for (const over of [{ signalKind: " " }, { centsField: "" }, { label: "" }, { subject: { kind: "customer", id: "" } }, { subject: undefined as never }]) {
      expect(impactProblem(impact(over))).toBe("a measure needs a signal kind, subject, field and label");
    }
    for (const share of [0, -0.1, 1.01, Number.NaN]) expect(impactProblem(impact({ share }))).toBe("a measure's share must be above 0 and at most 1");
    expect(impactProblem(impact({ share: "0.5" as never }))).toBe("a measure's share must be above 0 and at most 1");
    expect(impactProblem(impact({ windowDays: 45 as never }))).toBe("a measure's window must be one of 30, 60, 90 days");
  });

  it("allows a checkpoint only on a measured result", () => {
    const base: ValueResult = { recommendationId: "a", organizationId: ORG, kind: "makes", cents: 0, source: "measured", actor: "karatos", recordedAt: CREATED };
    expect(valueResultProblem({ ...base, measuredDays: 60 })).toBeNull();
    expect(valueResultProblem({ ...base, source: "reported", measuredDays: 30 })).toBe("only a measured result has a checkpoint, of 30, 60, 90 days");
    expect(valueResultProblem({ ...base, measuredDays: 45 as never })).toBe("only a measured result has a checkpoint, of 30, 60, 90 days");
  });
});

describe("dueMeasurements", () => {
  it("measures the margin on what came in, at each checkpoint that has passed", () => {
    const signals = [purchase(after(10), 100_000), purchase(after(45), 50_001)];
    const results = due({ signals, now: after(60) });
    expect(results).toEqual([
      { recommendationId: "a", organizationId: ORG, kind: "makes", cents: 45_000, source: "measured", measuredDays: 30, note: "purchases within 30 days: 1", actor: "karatos", recordedAt: after(60) },
      { recommendationId: "a", organizationId: ORG, kind: "makes", cents: 67_500, source: "measured", measuredDays: 60, note: "purchases within 60 days: 2", actor: "karatos", recordedAt: after(60) },
    ]);
  });

  it("waits until a checkpoint has fully passed, and stops at the measure's window", () => {
    expect(due({ now: after(30, -1) })).toEqual([]);
    expect(due({ now: after(30) }).map((r) => r.measuredDays)).toEqual([30]);
    expect(due({ now: after(400) }).map((r) => r.measuredDays)).toEqual([30, 60, 90]);
    expect(due({ recommendations: [rec("a", impact({ windowDays: 60 }))], now: after(400) }).map((r) => r.measuredDays)).toEqual([30, 60]);
    expect(due({ recommendations: [rec("a", impact({ windowDays: 30 }))], now: after(400) }).map((r) => r.measuredDays)).toEqual([30]);
  });

  it("counts what came in after the recommendation, up to and including the checkpoint", () => {
    const signals = [purchase(CREATED, 1), purchase(after(0, 1), 10), purchase(after(30), 100), purchase(after(30, 1), 1_000)];
    const [thirty] = due({ recommendations: [rec("a", impact({ share: 1 }))], signals, now: after(30) });
    expect(thirty).toMatchObject({ cents: 110, note: "purchases within 30 days: 2" });
  });

  it("counts only the measure's kind of signal, on its subject, in its organization, with whole cents", () => {
    const signals = [
      purchase(after(1), 100),
      purchase(after(1), 1_000, { kind: "sale.line" }),
      purchase(after(1), 1_000, { subject: { kind: "customer", id: "c2" } }),
      purchase(after(1), 1_000, { subject: { kind: "contact", id: "c1" } }),
      purchase(after(1), 1_000, { organizationId: "org_b" }),
      purchase(after(1), "1000"),
      purchase(after(1), 10.5),
      purchase(after(1), -50),
      purchase(after(1), 2 ** 53),
      purchase(after(1), undefined, { value: 7 }),
      purchase(after(1), undefined, { value: null as never }),
    ];
    const [thirty] = due({ recommendations: [rec("a", impact({ share: 1 }))], signals, now: after(30) });
    expect(thirty).toMatchObject({ cents: 100, note: "purchases within 30 days: 7" });
  });

  it("rounds the share to whole cents", () => {
    expect(due({ signals: [purchase(after(1), 3)], now: after(30) })[0]!.cents).toBe(1);
    expect(due({ signals: [purchase(after(1), 2)], now: after(30) })[0]!.cents).toBe(1);
    expect(due({ signals: [purchase(after(1), 1)], now: after(30) })[0]!.cents).toBe(0);
  });

  it("measures only recommendations approved as of now, by the latest word", () => {
    expect(due({ feedback: [], now: after(30) })).toEqual([]);
    expect(due({ feedback: [accepted("a", after(1), "rejected")], now: after(30) })).toEqual([]);
    expect(due({ feedback: [accepted("a", after(1)), accepted("a", after(2), "overridden")], now: after(30) })).toEqual([]);
    expect(due({ feedback: [accepted("a", after(1), "rejected"), accepted("a", after(2))], now: after(30) })).toHaveLength(1);
    // An Accept recorded after now hasn't happened yet.
    expect(due({ feedback: [accepted("a", after(31))], now: after(30) })).toEqual([]);
    expect(due({ feedback: [accepted("a", after(30))], now: after(30) })).toHaveLength(1);
    expect(due({ feedback: [{ ...accepted("a"), organizationId: "org_b" }], now: after(30) })).toEqual([]);
  });

  it("skips checkpoints already measured, and recommendations with no measure or of another organization", () => {
    const done: ValueResult = { recommendationId: "a", organizationId: ORG, kind: "makes", cents: 5, source: "measured", measuredDays: 30, actor: "karatos", recordedAt: after(30) };
    expect(due({ results: [done], now: after(60) }).map((r) => r.measuredDays)).toEqual([60]);
    // A reported result, or another organization's, doesn't stand in for a measurement.
    expect(due({ results: [{ ...done, source: "reported", measuredDays: undefined as never }], now: after(30) })).toHaveLength(1);
    expect(due({ results: [{ ...done, organizationId: "org_b" }], now: after(30) })).toHaveLength(1);
    const plain: Impact = { kind: "makes", lowCents: 1, cents: 1, highCents: 1, basis: "b" };
    expect(due({ recommendations: [rec("a", plain)], now: after(30) })).toEqual([]);
    expect(due({ recommendations: [rec("a", null)], now: after(30) })).toEqual([]);
    expect(due({ recommendations: [rec("a", impact(), CREATED, "org_b")], now: after(30) })).toEqual([]);
  });

  it("measures a recommendation listed twice once", () => {
    expect(due({ recommendations: [rec("a"), rec("a")], now: after(30) })).toHaveLength(1);
  });

  it("keeps the estimate's kind", () => {
    const protects: Impact = { ...impact({ share: 1 }), kind: "protects" };
    expect(due({ recommendations: [rec("a", protects)], signals: [purchase(after(1), 500)], now: after(30) })[0]).toMatchObject({ kind: "protects", cents: 500 });
  });
});

describe("measureValue", () => {
  async function setup() {
    const memory = new InMemoryStore();
    await memory.saveRecommendations([
      rec("a"),
      rec("old", impact(), after(-92)),
      // 90.5 days old at the run at 30 days: inside the 91-day look back, not a 90-day one.
      rec("edge", impact(), after(-60.5)),
      rec("plain", { kind: "makes", lowCents: 1, cents: 1, highCents: 1, basis: "b" }),
      rec("other", impact({ signalKind: "custom.payment", subject: { kind: "custom_order", id: "o1" }, centsField: "amountCents", share: 1, windowDays: 30, label: "payments" })),
    ]);
    for (const id of ["a", "old", "edge", "plain", "other"]) await memory.recordFeedback(accepted(id, id === "old" ? after(-91) : after(1)));
    await memory.appendSignals([
      purchase(after(5), 10_000),
      purchase(after(5), 999, { kind: "custom.payment", subject: { kind: "custom_order", id: "o1" }, value: { amountCents: 999 } }),
    ]);
    return memory;
  }

  it("records what's due on the last 91 days of recommendations, once", async () => {
    const memory = await setup();
    const first = await measureValue(memory, ORG, after(30));
    expect(first.map((r) => [r.recommendationId, r.measuredDays, r.cents])).toEqual([
      ["edge", 30, 0],
      ["edge", 60, 0],
      ["edge", 90, 4_500],
      ["a", 30, 4_500],
      ["other", 30, 999],
    ]);
    expect(memory.valueResults).toEqual(first);
    expect(await measureValue(memory, ORG, after(30))).toEqual([]);
    expect((await measureValue(memory, ORG, after(60))).map((r) => [r.recommendationId, r.measuredDays])).toEqual([["a", 60]]);
  });

  it("reads only the signal kinds its measures name, up to a limit", async () => {
    const memory = await setup();
    const asked: unknown[][] = [];
    const recentSignals = memory.recentSignals.bind(memory);
    memory.recentSignals = async (...args) => (asked.push(args), recentSignals(...args));
    await measureValue(memory, ORG, after(30), { signalLimit: 5 });
    await measureValue(memory, ORG, after(30));
    expect(asked).toEqual([
      [ORG, 5, ["sale.customer_purchase", "custom.payment"]],
      [ORG, 10_000, ["sale.customer_purchase", "custom.payment"]],
    ]);
  });

  it("reads nothing more when no recent recommendation has a measure", async () => {
    const memory = new InMemoryStore();
    await memory.saveRecommendations([rec("plain", null)]);
    let reads = 0;
    memory.listFeedback = async () => (reads++, []);
    expect(await measureValue(memory, ORG, after(30))).toEqual([]);
    expect(reads).toBe(0);
  });

  it("won't record the same checkpoint twice in memory", async () => {
    const memory = new InMemoryStore();
    const r: ValueResult = { recommendationId: "a", organizationId: ORG, kind: "makes", cents: 1, source: "measured", measuredDays: 30, actor: "karatos", recordedAt: after(30) };
    await memory.recordValueResult(r);
    await memory.recordValueResult({ ...r, measuredDays: 60 });
    await memory.recordValueResult({ ...r, organizationId: "org_b" });
    await memory.recordValueResult({ ...r, recommendationId: "b" });
    await memory.recordValueResult({ ...r, source: "reported", measuredDays: undefined as never });
    await memory.recordValueResult({ ...r, source: "reported", measuredDays: undefined as never });
    await expect(memory.recordValueResult(r)).rejects.toThrow("a already has a result measured at 30 days");
    expect(memory.valueResults).toHaveLength(6);
  });
});
