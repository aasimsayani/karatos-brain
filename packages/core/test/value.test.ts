import { describe, expect, it } from "vitest";
import {
  InMemoryStore,
  monthOf,
  readValueReport,
  valueReport,
  valueResultProblem,
  type Feedback,
  type Impact,
  type Recommendation,
  type ValueResult,
} from "../src/index.js";

const ORG = "org_a";
const FROM = "2026-10-01T00:00:00.000Z";
const TO = "2026-11-01T00:00:00.000Z";

const impact = (kind: Impact["kind"], cents: number): Impact => ({ kind, cents, lowCents: 0, highCents: cents * 2, basis: "test" });

const rec = (id: string, createdAt: string, i?: Impact, organizationId = ORG): Recommendation => ({
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

const word = (recommendationId: string, outcome: Feedback["outcome"], recordedAt: string, organizationId = ORG): Feedback => ({
  recommendationId,
  organizationId,
  outcome,
  actor: "owner",
  recordedAt,
});

const result = (recommendationId: string, cents: number, recordedAt: string, over: Partial<ValueResult> = {}): ValueResult => ({
  recommendationId,
  organizationId: ORG,
  kind: "makes",
  cents,
  source: "reported",
  actor: "owner",
  recordedAt,
  ...over,
});

const report = (recommendations: Recommendation[], feedback: Feedback[] = [], results: ValueResult[] = []) =>
  valueReport({ organizationId: ORG, from: FROM, to: TO, recommendations, feedback, results });

const totals = (makes: number, saves: number, protects: number) => ({ makes, saves, protects, total: makes + saves + protects });

describe("valueReport", () => {
  it("adds up what was shown, approved, dismissed, overridden, returned and still to come, by kind", () => {
    const r = report(
      [
        rec("a", "2026-10-02T00:00:00Z", impact("makes", 10_000)),
        rec("b", "2026-10-03T00:00:00Z", impact("saves", 2_000)),
        rec("c", "2026-10-04T00:00:00Z", impact("protects", 50_000)),
        rec("d", "2026-10-05T00:00:00Z", impact("makes", 7_000)),
        rec("e", "2026-10-06T00:00:00Z", impact("makes", 1_000)),
        rec("f", "2026-10-07T00:00:00Z"),
      ],
      [
        word("a", "accepted", "2026-10-02T01:00:00Z"),
        word("b", "accepted", "2026-10-03T01:00:00Z"),
        word("c", "accepted", "2026-10-04T01:00:00Z"),
        word("d", "rejected", "2026-10-05T01:00:00Z"),
        word("e", "overridden", "2026-10-06T01:00:00Z"),
        word("f", "accepted", "2026-10-07T01:00:00Z"),
      ],
      [result("a", 12_500, "2026-10-20T00:00:00Z"), result("c", 40_000, "2026-10-21T00:00:00Z", { kind: "protects" })],
    );
    expect(r).toEqual({
      organizationId: ORG,
      from: FROM,
      to: TO,
      shown: { count: 6, priced: 5, likely: totals(18_000, 2_000, 50_000) },
      approved: { count: 4, likely: totals(10_000, 2_000, 50_000) },
      dismissed: { count: 1 },
      overridden: { count: 1 },
      returned: { count: 2, cents: totals(12_500, 0, 40_000) },
      awaiting: { count: 2, likely: totals(0, 2_000, 0) },
    });
  });

  it("counts only recommendations raised in the period, from its first instant up to but not including its end", () => {
    const r = report([
      rec("before", "2026-09-30T23:59:59.999Z", impact("makes", 1)),
      rec("first", FROM, impact("makes", 10)),
      rec("last", "2026-10-31T23:59:59.999Z", impact("makes", 100)),
      rec("after", TO, impact("makes", 1_000)),
      rec("other", "2026-10-02T00:00:00Z", impact("makes", 10_000), "org_b"),
    ]);
    expect(r.shown).toEqual({ count: 2, priced: 2, likely: totals(110, 0, 0) });
  });

  it("follows the latest word on each recommendation up to the period's end", () => {
    const r = report(
      [rec("a", "2026-10-02T00:00:00Z", impact("makes", 100)), rec("b", "2026-10-02T00:00:00Z", impact("makes", 200))],
      [
        word("a", "accepted", "2026-10-03T00:00:00Z"),
        word("a", "rejected", "2026-10-04T00:00:00Z"),
        // Listed out of order: the time decides, not the order.
        word("b", "accepted", "2026-10-05T00:00:00Z"),
        word("b", "rejected", "2026-10-04T00:00:00Z"),
        // After the period: not yet said.
        word("a", "accepted", TO),
      ],
    );
    expect(r.approved).toEqual({ count: 1, likely: totals(200, 0, 0) });
    expect(r.dismissed).toEqual({ count: 1 });
  });

  it("lets a later word recorded at the same instant win", () => {
    const r = report([rec("a", "2026-10-02T00:00:00Z")], [word("a", "rejected", "2026-10-03T00:00:00Z"), word("a", "accepted", "2026-10-03T00:00:00Z")]);
    expect(r.approved.count).toBe(1);
    expect(r.dismissed.count).toBe(0);
  });

  it("uses the latest result on each, so measuring again replaces rather than adds", () => {
    const r = report(
      [rec("a", "2026-10-02T00:00:00Z", impact("makes", 100))],
      [word("a", "accepted", "2026-10-02T00:00:00Z")],
      [result("a", 300, "2026-10-10T00:00:00Z"), result("a", 900, "2026-10-30T00:00:00Z"), result("a", 5_000, TO)],
    );
    expect(r.returned).toEqual({ count: 1, cents: totals(900, 0, 0) });
    expect(r.awaiting.count).toBe(0);
  });

  it("counts a result under its own kind, which may differ from the estimate's", () => {
    const r = report([rec("a", "2026-10-02T00:00:00Z", impact("makes", 100))], [], [result("a", 300, "2026-10-10T00:00:00Z", { kind: "protects", source: "measured" })]);
    expect(r.returned.cents).toEqual(totals(0, 0, 300));
  });

  it("counts a result with no Accept, and a result of zero as done", () => {
    const r = report(
      [rec("a", "2026-10-02T00:00:00Z", impact("saves", 100)), rec("b", "2026-10-02T00:00:00Z", impact("makes", 100))],
      [word("b", "accepted", "2026-10-03T00:00:00Z")],
      [result("a", 400, "2026-10-10T00:00:00Z", { kind: "saves" }), result("b", 0, "2026-10-11T00:00:00Z")],
    );
    expect(r.returned).toEqual({ count: 2, cents: totals(0, 400, 0) });
    expect(r.awaiting.count).toBe(0);
  });

  it("ignores feedback and results for other organizations, other recommendations, or that don't add up", () => {
    const r = report(
      [rec("a", "2026-10-02T00:00:00Z", impact("makes", 100))],
      [word("a", "accepted", "2026-10-03T00:00:00Z", "org_b"), word("zz", "accepted", "2026-10-03T00:00:00Z")],
      [
        result("a", 50, "2026-10-04T00:00:00Z", { organizationId: "org_b" }),
        result("zz", 50, "2026-10-04T00:00:00Z"),
        result("a", -5, "2026-10-04T00:00:00Z"),
      ],
    );
    expect(r.approved.count).toBe(0);
    expect(r.returned.count).toBe(0);
  });

  it("says so when the period doesn't run forward", () => {
    for (const [from, to] of [[TO, FROM], [FROM, FROM], ["soon", TO], [FROM, "later"]]) {
      expect(() => valueReport({ organizationId: ORG, from: from!, to: to!, recommendations: [], feedback: [], results: [] })).toThrow(RangeError);
    }
  });

  it("normalizes the period to ISO instants", () => {
    const r = valueReport({ organizationId: ORG, from: "2026-10-01", to: "2026-11-01", recommendations: [], feedback: [], results: [] });
    expect([r.from, r.to]).toEqual([FROM, TO]);
  });
});

describe("valueResultProblem", () => {
  const good = result("a", 0, "2026-10-04T00:00:00Z");

  it("accepts sound results of every kind and source", () => {
    for (const kind of ["makes", "saves", "protects"] as const) expect(valueResultProblem({ ...good, kind })).toBeNull();
    expect(valueResultProblem({ ...good, source: "measured", cents: Number.MAX_SAFE_INTEGER })).toBeNull();
  });

  it("names what's wrong", () => {
    expect(valueResultProblem({ ...good, kind: "earns" as Impact["kind"] })).toBe("unknown impact kind earns");
    for (const cents of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(valueResultProblem({ ...good, cents })).toBe("a result must be whole cents, zero or more");
    }
    expect(valueResultProblem({ ...good, source: "guessed" as ValueResult["source"] })).toBe("unknown result source guessed");
    expect(valueResultProblem({ ...good, actor: " " })).toBe("a result needs the person or process that recorded it");
    expect(valueResultProblem({ ...good, actor: undefined as unknown as string })).toBe("a result needs the person or process that recorded it");
    expect(valueResultProblem({ ...good, recordedAt: "whenever" })).toBe("a result needs the time it was recorded");
  });
});

describe("monthOf", () => {
  it("gives the calendar month in UTC, across a year end", () => {
    expect(monthOf("2026-10-30T19:00:00Z")).toEqual({ from: FROM, to: TO });
    expect(monthOf("2026-12-31T23:59:59.999Z")).toEqual({ from: "2026-12-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" });
    expect(monthOf("2026-10-01T00:00:00Z").from).toBe(FROM);
    expect(() => monthOf("not a date")).toThrow(RangeError);
  });
});

describe("the ledger in memory", () => {
  it("reads a period's recommendations, feedback and results into a report", async () => {
    const memory = new InMemoryStore();
    await memory.saveRecommendations([
      rec("late", "2026-10-20T00:00:00Z", impact("makes", 500)),
      rec("early", "2026-10-02T00:00:00Z", impact("saves", 300)),
      rec("sept", "2026-09-20T00:00:00Z", impact("makes", 900)),
      rec("nov", TO, impact("makes", 900)),
      rec("other", "2026-10-02T00:00:00Z", impact("makes", 900), "org_b"),
    ]);
    expect((await memory.recommendationsBetween(ORG, FROM, TO)).map((r) => r.id)).toEqual(["early", "late"]);
    await memory.recordFeedback(word("early", "accepted", "2026-10-03T00:00:00Z"));
    await memory.recordFeedback(word("sept", "accepted", "2026-10-03T00:00:00Z"));
    await memory.recordValueResult(result("early", 450, "2026-10-25T00:00:00Z", { kind: "saves" }));
    await memory.recordValueResult(result("sept", 999, "2026-10-25T00:00:00Z"));
    expect((await memory.listFeedback(ORG, ["early"])).map((f) => f.recommendationId)).toEqual(["early"]);
    expect(await memory.listFeedback("org_b", ["early"])).toEqual([]);
    expect((await memory.listValueResults(ORG, ["early", "late"])).map((r) => r.cents)).toEqual([450]);
    expect(await memory.listValueResults("org_b", ["early"])).toEqual([]);

    const r = await readValueReport(memory, ORG, { from: FROM, to: TO });
    expect(r.shown).toEqual({ count: 2, priced: 2, likely: totals(500, 300, 0) });
    expect(r.approved.count).toBe(1);
    expect(r.returned).toEqual({ count: 1, cents: totals(0, 450, 0) });
  });

  it("reports an empty period without reading feedback or results", async () => {
    const memory = new InMemoryStore();
    let reads = 0;
    const counting = {
      recommendationsBetween: memory.recommendationsBetween.bind(memory),
      listFeedback: async () => (reads++, []),
      listValueResults: async () => (reads++, []),
    };
    expect((await readValueReport(counting, ORG, { from: FROM, to: TO })).shown.count).toBe(0);
    expect(reads).toBe(0);
  });

  it("won't record a result that doesn't add up", async () => {
    const memory = new InMemoryStore();
    await expect(memory.recordValueResult(result("a", -1, "2026-10-25T00:00:00Z"))).rejects.toThrow("a result must be whole cents, zero or more");
    expect(memory.valueResults).toEqual([]);
  });
});
