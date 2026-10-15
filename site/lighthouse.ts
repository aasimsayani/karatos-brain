/**
 * Fails when any Lighthouse category on the website scores under the bar
 * (#80 asks for 90+ on mobile). CI runs Lighthouse's default mobile emulation
 * against the built site and passes the JSON report here:
 *   node site/lighthouse.ts lighthouse.json
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

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node site/lighthouse.ts <lighthouse-report.json>");
    process.exit(2);
  }
  const { mobile, scores } = checkReport(JSON.parse(readFileSync(path, "utf8")));
  for (const s of scores) console.log(`${s.ok ? "ok  " : "FAIL"} ${s.id}: ${s.score ?? "not scored"}`);
  if (!mobile) console.error("FAIL the report is not a mobile run");
  if (!mobile || scores.some((s) => !s.ok)) process.exit(1);
}
