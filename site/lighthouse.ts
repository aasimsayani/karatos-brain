/**
 * Fails when any Lighthouse category on the website scores under the bar
 * (#80 asks for 90+ on mobile). CI runs Lighthouse's default mobile emulation
 * against the built site three times and passes the JSON reports here:
 *   node site/lighthouse.ts lighthouse-1.json lighthouse-2.json lighthouse-3.json
 * Each category is judged on its median, because a shared CI runner's load
 * can swing one performance run by ten points or more.
 * Plain erasable TypeScript, so Node runs it without a build step.
 */
import { readFileSync } from "node:fs";

export const MIN_SCORE = 90;
export const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;

export interface CategoryScore {
  id: string;
  /** 0 to 100, or null when Lighthouse couldn't score it. */
  score: number | null;
  ok: boolean;
}

interface Report {
  configSettings?: { formFactor?: string };
  categories?: Record<string, { score?: number | null } | undefined>;
}

/** Scores every required category; a missing or unscored category fails rather than passing silently. */
export function checkReport(report: unknown, min = MIN_SCORE): { mobile: boolean; scores: CategoryScore[] } {
  const r = (report && typeof report === "object" ? report : {}) as Report;
  const scores = CATEGORIES.map((id) => {
    const raw = r.categories?.[id]?.score;
    const score = typeof raw === "number" ? Math.round(raw * 100) : null;
    return { id, score, ok: score !== null && score >= min };
  });
  return { mobile: r.configSettings?.formFactor === "mobile", scores };
}

/** Judges each category on its median score across runs. A category unscored in any run fails. */
export function checkReports(reports: readonly unknown[], min = MIN_SCORE): { mobile: boolean; scores: CategoryScore[] } {
  const checked = reports.map((r) => checkReport(r, min));
  const scores = CATEGORIES.map((id, i) => {
    const runs = checked.map((c) => c.scores[i]!.score);
    if (!runs.length || runs.some((s) => s === null)) return { id, score: null, ok: false };
    const sorted = (runs as number[]).slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const score = sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
    return { id, score, ok: score >= min };
  });
  return { mobile: checked.length > 0 && checked.every((c) => c.mobile), scores };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const paths = process.argv.slice(2);
  if (!paths.length) {
    console.error("usage: node site/lighthouse.ts <lighthouse-report.json>...");
    process.exit(2);
  }
  const { mobile, scores } = checkReports(paths.map((path) => JSON.parse(readFileSync(path, "utf8"))));
  for (const s of scores) console.log(`${s.ok ? "ok  " : "FAIL"} ${s.id}: ${s.score ?? "not scored"}${paths.length > 1 ? ` (median of ${paths.length} runs)` : ""}`);
  if (!mobile) console.error("FAIL the report is not a mobile run");
  if (!mobile || scores.some((s) => !s.ok)) process.exit(1);
}
