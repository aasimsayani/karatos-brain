import { readFileSync } from "node:fs";
import { gitHubIssueTracker, type IssueTracker } from "@karatos/core";
import { checkSiteFreshness } from "../site/freshness.js";

// Checks the live website against the page main builds; a gap becomes an issue.
//   SITE_URL                         the live site
//   GITHUB_TOKEN, GITHUB_REPOSITORY  set by GitHub Actions
//   --built <file>                   main's page (default site/dist/index.html)
//   --dry-run                        print what would be filed instead of filing it

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const builtAt = args.indexOf("--built");
const builtPath = builtAt >= 0 ? args[builtAt + 1] : "site/dist/index.html";
const url = process.env.SITE_URL;
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!url || !/^https?:\/\//.test(url) || !builtPath || (!dryRun && (!token || !repo))) {
  console.error("Set SITE_URL, and GITHUB_TOKEN and GITHUB_REPOSITORY or pass --dry-run.");
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
const issues = dryRun ? printing : gitHubIssueTracker({ repo: repo!, token: token!, labels: ["site-freshness", "website"] });

const result = await checkSiteFreshness({ url, builtHtml: readFileSync(builtPath, "utf8"), issues });
if (result.status === "fresh") {
  console.log(`The live site matches main.${result.closed ? ` Closed #${result.closed}.` : ""}`);
} else {
  for (const p of result.problems) console.log(`::error title=Website::${p}`);
  if (!dryRun) console.log(`Filed in #${result.issue}.`);
  process.exitCode = 1;
}
