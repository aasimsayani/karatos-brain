import { execFileSync } from "node:child_process";
import { mergeOrder, mergePlan, renderPlan, retargets, rollUp, type OpenPr } from "./pr-queue.js";

// npm run prs:plan                         prints the order to merge the open PRs in, and what each waits on
// node --import tsx scripts/pr-queue-cli.ts order      PR numbers in sync order, one per line (used by sync-open-prs.sh)
// node --import tsx scripts/pr-queue-cli.ts retarget   moves PRs stacked on a merged branch onto that branch's base

const gh = (path: string, ...args: string[]) => JSON.parse(execFileSync("gh", ["api", path, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
// owner/name from GITHUB_REPOSITORY (CI and sync-open-prs.sh set it), else from the origin remote.
const repo =
  process.env.GITHUB_REPOSITORY ??
  execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" })
    .trim()
    .replace(/^.*github\.com[:/]/, "")
    .replace(/\.git$/, "");

type Pull = { number: number; title: string; draft: boolean; head: { ref: string; sha: string }; base: { ref: string }; merged_at: string | null };

function openPrs(withDetail: boolean): OpenPr[] {
  const pulls = gh(`repos/${repo}/pulls?state=open&per_page=100`) as Pull[];
  return pulls.map((p) => {
    if (!withDetail) return { number: p.number, title: p.title, head: p.head.ref, base: p.base.ref, draft: p.draft, files: [], checks: "none", mergeable: null };
    // Compared the way a merge sees it, from the merge base: a PR's own file list can lag after its base changes.
    const files = ((gh(`repos/${repo}/compare/${encodeURIComponent(p.base.ref)}...${encodeURIComponent(p.head.ref)}`) as { files?: { filename: string }[] }).files ?? []).map((f) => f.filename);
    const runs = (gh(`repos/${repo}/commits/${p.head.sha}/check-runs?per_page=100`) as { check_runs: { status: string; conclusion: string | null }[] }).check_runs.filter(
      (r) => r.conclusion !== "skipped",
    );
    const mergeable = (gh(`repos/${repo}/pulls/${p.number}`) as { mergeable: boolean | null }).mergeable;
    return { number: p.number, title: p.title, head: p.head.ref, base: p.base.ref, draft: p.draft, files, checks: rollUp(runs), mergeable };
  });
}

const mode = process.argv[2] ?? "plan";
if (mode === "order") {
  for (const pr of mergeOrder(openPrs(false))) console.log(pr.number);
} else if (mode === "retarget") {
  const open = openPrs(false);
  const merged = new Map<string, string>();
  for (const base of new Set(open.map((p) => p.base))) {
    const closed = gh(`repos/${repo}/pulls?state=closed&head=${repo.split("/")[0]}:${base}&per_page=10`) as Pull[];
    const landed = closed.find((p) => p.merged_at);
    if (landed) merged.set(base, landed.base.ref);
  }
  for (const r of retargets(open, merged)) {
    execFileSync("gh", ["api", "-X", "PATCH", `repos/${repo}/pulls/${r.number}`, "-f", `base=${r.to}`], { stdio: "ignore" });
    console.log(`#${r.number} moved from ${r.from} (merged) to ${r.to}`);
  }
} else {
  process.stdout.write(renderPlan(mergePlan(openPrs(true))));
}
