/**
 * Works out the order open PRs should be synced and merged in, so a merge
 * never lands a conflict on the PRs behind it.
 *
 * - Stacked PRs come after the PR they're stacked on, so syncing brings the
 *   base up to date before the PRs built on it.
 * - Within a tier, PRs that are ready (green, mergeable, not a draft) go
 *   first, then the ones more PRs are stacked on, then the ones that share
 *   the fewest hand-written files with other open PRs, then the oldest.
 * - Files the tooling rebuilds itself (the registry's generated lists, the
 *   README progress block, changelog fragments) never count as a conflict.
 * - When a PR merges into a branch that is not deleted, GitHub leaves the
 *   PRs stacked on it pointing at the old branch; `retargets` names the base
 *   each of them should move to.
 */

/** Files `npm run registry:write` rebuilds from each connector's own files (scripts/registry.ts, OUTPUTS). */
export const GENERATED_FILES = [
  "packages/connectors/src/index.ts",
  "packages/core/src/catalog/index.ts",
  "packages/server/src/connectors/index.ts",
  "packages/testkit/src/mocks/index.ts",
  "scripts/sandbox-checks/index.ts",
  "secrets/manifest.json",
  "docs/integrations.md",
  ".github/workflows/sandbox-run.yml",
] as const;

export type Checks = "green" | "red" | "running" | "none";

export interface OpenPr {
  number: number;
  title: string;
  head: string;
  base: string;
  draft: boolean;
  /** Paths the PR changes against its base. */
  files: string[];
  checks: Checks;
  /** GitHub's answer: false means a conflict with the base, null means not worked out yet. */
  mergeable: boolean | null;
}

export interface PlanStep {
  pr: OpenPr;
  /** The open PR this one is stacked on, if any. */
  after: number | null;
  /** Open PRs stacked on this one, directly or further up. */
  unblocks: number[];
  /** Hand-written files this PR shares with other open PRs, and which ones. */
  shared: { file: string; with: number[] }[];
  ready: boolean;
  /** What has to happen before it can merge, in plain words. Empty when ready. */
  blockers: string[];
}

/** True for files the tooling settles itself on every sync, so two PRs touching them never block each other. */
export function settledByTooling(file: string): boolean {
  return (GENERATED_FILES as readonly string[]).includes(file) || file === "README.md" || file === "CHANGELOG.md" || file.startsWith("changelog.d/");
}

/** Hand-written files changed by two or more open PRs, with the PRs that change each. */
export function overlaps(prs: OpenPr[]): Map<string, number[]> {
  const byFile = new Map<string, number[]>();
  for (const pr of prs) for (const f of pr.files) if (!settledByTooling(f)) byFile.set(f, [...(byFile.get(f) ?? []), pr.number]);
  return new Map([...byFile].filter(([, n]) => n.length > 1));
}

/** Every open PR stacked on PR `n`, however far up; a loop in the stack stops at a PR already counted. */
export function stackedOn(prs: OpenPr[], n: number): number[] {
  const found = new Set<number>();
  const queue = [n];
  while (queue.length) {
    const next = queue.shift()!;
    const head = prs.find((p) => p.number === next)!.head;
    for (const p of prs) {
      if (p.base !== head || p.number === n || found.has(p.number)) continue;
      found.add(p.number);
      queue.push(p.number);
    }
  }
  return [...found].sort((a, b) => a - b);
}

export const isReady = (pr: OpenPr) => !pr.draft && pr.checks === "green" && pr.mergeable === true;

/**
 * The order to sync and merge in. A PR whose base is the head of another open
 * PR comes after it; stacks that loop (which GitHub allows) are broken at the
 * lowest-numbered PR.
 */
export function mergeOrder(prs: OpenPr[]): OpenPr[] {
  const byHead = new Map(prs.map((p) => [p.head, p]));
  const shared = overlaps(prs);
  const sharedCount = (p: OpenPr) => p.files.filter((f) => shared.has(f)).length;
  const unblocks = new Map(prs.map((p) => [p.number, stackedOn(prs, p.number).length]));
  const rank = (a: OpenPr, b: OpenPr) =>
    Number(isReady(b)) - Number(isReady(a)) || unblocks.get(b.number)! - unblocks.get(a.number)! || sharedCount(a) - sharedCount(b) || a.number - b.number;
  const parent = (p: OpenPr) => (p.base !== p.head ? byHead.get(p.base) : undefined);
  const done = new Set<number>();
  const out: OpenPr[] = [];
  let left = [...prs];
  while (left.length) {
    let tier = left.filter((p) => {
      const up = parent(p);
      return !up || done.has(up.number);
    });
    if (!tier.length) tier = [left.reduce((a, b) => (a.number < b.number ? a : b))];
    tier.sort(rank);
    for (const p of tier) {
      out.push(p);
      done.add(p.number);
    }
    left = left.filter((p) => !done.has(p.number));
  }
  return out;
}

export function mergePlan(prs: OpenPr[]): PlanStep[] {
  const byHead = new Map(prs.map((p) => [p.head, p]));
  const shared = overlaps(prs);
  const seen = new Set<number>();
  return mergeOrder(prs).map((pr) => {
    const up = byHead.get(pr.base);
    const after = up && up.number !== pr.number ? up.number : null;
    const blockers: string[] = [];
    if (after !== null && !seen.has(after)) blockers.push(`merge #${after} first`);
    else if (after !== null) blockers.push(`after #${after} merges`);
    if (pr.draft) blockers.push("still a draft");
    if (pr.checks === "red") blockers.push("CI is red");
    if (pr.checks === "running") blockers.push("CI is running");
    if (pr.mergeable === false) blockers.push(`conflicts with ${pr.base}`);
    seen.add(pr.number);
    return {
      pr,
      after,
      unblocks: stackedOn(prs, pr.number),
      shared: pr.files.filter((f) => shared.has(f)).map((file) => ({ file, with: shared.get(file)!.filter((n) => n !== pr.number) })),
      ready: isReady(pr) && after === null,
      blockers,
    };
  });
}

export function renderPlan(steps: PlanStep[]): string {
  const lines = ["Merge in this order. Run scripts/sync-open-prs.sh after each merge.", ""];
  steps.forEach((s, i) => {
    const state = s.ready ? "ready" : s.blockers.join(", ");
    let line = `${i + 1}. #${s.pr.number} ${s.pr.title} (${state})`;
    if (s.unblocks.length) line += `; unblocks ${s.unblocks.map((n) => `#${n}`).join(", ")}`;
    lines.push(line);
    // The three most shared files, so a PR touching dozens doesn't bury the plan.
    const top = [...s.shared].sort((a, b) => b.with.length - a.with.length || a.file.localeCompare(b.file));
    for (const o of top.slice(0, 3)) lines.push(`   shares ${o.file} with ${o.with.map((n) => `#${n}`).join(", ")}`);
    if (top.length > 3) lines.push(`   and ${top.length - 3} more shared files`);
  });
  return lines.join("\n") + "\n";
}

/**
 * PRs still pointing at a branch whose PR has merged, and the base they should
 * move to: the merged PR's own base, followed up the stack.
 */
export function retargets(open: OpenPr[], merged: Map<string, string>): { number: number; from: string; to: string }[] {
  return open.flatMap((pr) => {
    if (!merged.has(pr.base)) return [];
    let to = pr.base;
    const seen = new Set<string>();
    while (merged.has(to) && !seen.has(to)) {
      seen.add(to);
      to = merged.get(to)!;
    }
    return to === pr.base ? [] : [{ number: pr.number, from: pr.base, to }];
  });
}

/** One check suite's conclusions rolled up: any failure is red, anything unfinished is running. */
export function rollUp(runs: { status: string; conclusion: string | null }[]): Checks {
  if (!runs.length) return "none";
  if (runs.some((r) => ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(r.conclusion ?? ""))) return "red";
  if (runs.some((r) => r.status !== "completed")) return "running";
  return "green";
}
