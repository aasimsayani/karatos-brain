import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  gitHubIssueTracker,
  runVendorDocsWatch,
  vendorDocsTargets,
  type IssueTracker,
  type DocsSnapshot,
  type SnapshotStore,
} from "@karatos/core";

// Daily vendor docs watch. Snapshots live in a directory the CI job caches
// between runs; changes become issues in this repository.
//   GITHUB_TOKEN, GITHUB_REPOSITORY  set by GitHub Actions
//   DOCS_WATCH_DIR                    snapshot directory (default .docs-watch)
//   --dry-run                         print what would be filed instead of filing it

const dryRun = process.argv.includes("--dry-run");
const dir = process.env.DOCS_WATCH_DIR ?? ".docs-watch";

const store: SnapshotStore = {
  async get(integration) {
    try {
      return JSON.parse(await readFile(join(dir, `${integration}.json`), "utf8")) as DocsSnapshot;
    } catch {
      return null;
    }
  },
  async put(snapshot) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${snapshot.integration}.json`), JSON.stringify(snapshot));
  },
};

function dryRunTracker(): IssueTracker {
  let next = 1;
  return {
    findOpen: async () => null,
    open: async (title, body) => {
      console.log(`\n[dry run] would open: ${title}\n${body}\n`);
      return next++;
    },
    comment: async (issue, body) => console.log(`\n[dry run] would comment on #${issue}:\n${body}\n`),
  };
}

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!dryRun && (!token || !repo)) {
  console.error("Set GITHUB_TOKEN and GITHUB_REPOSITORY, or pass --dry-run.");
  process.exit(1);
}
const issues = dryRun ? dryRunTracker() : gitHubIssueTracker({ repo: repo!, token: token!, labels: ["vendor-docs", "integration"] });

const { targets, unwatched } = vendorDocsTargets();
const outcomes = await runVendorDocsWatch({ targets, fetch, store, issues });

const rows = outcomes.map((o) => `| ${o.integration} | ${o.status} | ${o.issue ? `#${o.issue}` : ""} | ${o.detail ?? ""} |`);
const summary = [
  `## Vendor docs watch`,
  "",
  `${targets.length} changelogs checked. No public changelog for: ${unwatched.join(", ") || "none"}.`,
  "",
  "| Integration | Result | Issue | Detail |",
  "| --- | --- | --- | --- |",
  ...rows,
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

// Unreachable pages are listed, not failed: one vendor's outage shouldn't hide the rest.
const errors = outcomes.filter((o) => o.status === "error");
if (errors.length === targets.length && targets.length > 0) {
  console.error("Every changelog failed to load; check the runner's network.");
  process.exit(1);
}
