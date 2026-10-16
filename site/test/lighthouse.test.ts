import { describe, expect, it } from "vitest";
import { CATEGORIES, checkReport, checkReports } from "../lighthouse.js";

const report = (scores: Record<string, number | null>, formFactor = "mobile") => ({
  configSettings: { formFactor },
  categories: Object.fromEntries(Object.entries(scores).map(([id, score]) => [id, { score }])),
});

describe("checkReport", () => {
  it("passes a mobile run scoring 90 or more in every category", () => {
    const result = checkReport(report({ performance: 0.97, accessibility: 1, "best-practices": 0.9, seo: 1 }));
    expect(result.mobile).toBe(true);
    expect(result.scores).toEqual([
      { id: "performance", score: 97, ok: true },
      { id: "accessibility", score: 100, ok: true },
      { id: "best-practices", score: 90, ok: true },
      { id: "seo", score: 100, ok: true },
    ]);
  });

  it("fails a category under the bar, and rounds like Lighthouse does", () => {
    const { scores } = checkReport(report({ performance: 0.894, accessibility: 0.895, "best-practices": 1, seo: 1 }));
    expect(scores.slice(0, 2)).toEqual([
      { id: "performance", score: 89, ok: false },
      { id: "accessibility", score: 90, ok: true },
    ]);
  });

  it("fails missing or unscored categories instead of skipping them", () => {
    const { scores } = checkReport(report({ performance: null, accessibility: 1 }));
    expect(scores.filter((s) => !s.ok).map((s) => s.id)).toEqual(["performance", "best-practices", "seo"]);
    expect(checkReport(null).scores.every((s) => !s.ok && s.score === null)).toBe(true);
    expect(CATEGORIES).toHaveLength(4);
  });

  it("notices a desktop run", () => {
    expect(checkReport(report({ performance: 1 }, "desktop")).mobile).toBe(false);
    expect(checkReport({}).mobile).toBe(false);
  });

  it("takes a custom bar", () => {
    expect(checkReport(report({ performance: 0.8, accessibility: 0.8, "best-practices": 0.8, seo: 0.8 }), 80).scores.every((s) => s.ok)).toBe(true);
  });
});

describe("checkReports", () => {
  const all = (performance: number | null) => report({ performance, accessibility: 1, "best-practices": 0.96, seo: 1 });

  it("judges each category on its median, so one noisy run doesn't fail the site", () => {
    const { mobile, scores } = checkReports([all(1), all(0.87), all(0.99)]);
    expect(mobile).toBe(true);
    expect(scores[0]).toEqual({ id: "performance", score: 99, ok: true });
    expect(checkReports([all(0.87), all(0.88), all(1)]).scores[0]).toEqual({ id: "performance", score: 88, ok: false });
    expect(checkReports([all(0.89), all(0.92)]).scores[0]).toEqual({ id: "performance", score: 91, ok: true });
  });

  it("fails a category any run couldn't score, a desktop run, and no runs at all", () => {
    expect(checkReports([all(1), all(null), all(1)]).scores[0]).toEqual({ id: "performance", score: null, ok: false });
    expect(checkReports([all(1), report({ performance: 1, accessibility: 1, "best-practices": 1, seo: 1 }, "desktop")]).mobile).toBe(false);
    const none = checkReports([]);
    expect(none.mobile).toBe(false);
    expect(none.scores.every((s) => !s.ok)).toBe(true);
  });
});
