import { readFile, writeFile } from "node:fs/promises";
import { INTEGRATIONS } from "../packages/core/src/index.js";
import { MILESTONES, parseMilestones, renderReadme } from "./progress.js";

// npm run progress:write   regenerates the README's progress section and its Connected today table
// npm run progress:check   exits non-zero when the README is out of date

const mode = process.argv[2];
const readme = await readFile("README.md", "utf8");
const next = renderReadme(readme, parseMilestones(JSON.parse(await readFile(MILESTONES, "utf8")), INTEGRATIONS), INTEGRATIONS);
if (mode === "write") {
  await writeFile("README.md", next);
  console.log(next === readme ? "README progress already current" : "README progress updated");
} else if (next !== readme) {
  console.error("README progress is out of date; run npm run progress:write");
  process.exit(1);
} else {
  console.log("README progress ok");
}
