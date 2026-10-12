import { appendFile } from "node:fs/promises";
import { INTEGRATIONS, gitHubIssueTracker, runSandboxChecks, type IssueTracker } from "@karatos/core";
import { SANDBOX_CHECKS } from "./sandbox-checks.js";

// Nightly sandbox run. Each built connector runs against its vendor's
// sandbox; failures become issues in this repository.
//   GITHUB_TOKEN, GITHUB_REPOSITORY  set by GitHub Actions
//   SANDBOX_*                         test-only sandbox credentials
//   --dry-run                         print what would be filed instead of filing it

const dryRun = process.argv.includes("--dry-run");
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!dryRun && (!token || !repo)) {
  console.error("Set GITHUB_TOKEN and GITHUB_REPOSITORY, or pass --dry-run.");
  process.exit(1);
}

const printing: IssueTracker = {
  findOpen: async () => null,
  open: async (title, body) => {
    console.log(`\n[dry run] would open: ${title}\n${body}\n`);
    return 0;
  },
  comment: async () => {},
  close: async () => {},
};
const issues = dryRun ? printing : gitHubIssueTracker({ repo: repo!, token: token!, labels: ["sandbox-run", "integration"] });

const results = await runSandboxChecks({ checks: SANDBOX_CHECKS, env: process.env, issues });

const checked = new Set(SANDBOX_CHECKS.map((c) => c.integration));
const notBuilt = INTEGRATIONS.filter((i) => i.testWith === "sandbox" && i.status !== "deferred" && !checked.has(i.id)).map(
  (i) => i.id,
);
const line = (r: (typeof results)[number]) => {
  if (r.status === "skipped") return `| ${r.integration} | skipped | missing ${r.missing.join(", ")} |`;
  if (r.status === "failed") return `| ${r.integration} | **failed** at ${r.step} | ${r.issue ? `#${r.issue}` : r.issueError ?? ""} |`;
  return `| ${r.integration} | passed | ${r.closed.map((n) => `closed #${n}`).join(", ")}${r.issueError ?? ""} |`;
};
const summary = [
  "## Nightly sandbox run",
  "",
  results.length === 0 ? "No connectors are built yet." : "| Integration | Result | Notes |\n| --- | --- | --- |\n" + results.map(line).join("\n"),
  "",
  `Sandbox-testable, not built yet: ${notBuilt.join(", ") || "none"}.`,
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

// Failures are reported through issues; the job itself fails only so a red run is visible in Actions.
if (results.some((r) => r.status === "failed")) process.exit(1);
