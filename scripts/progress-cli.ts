import { readFile, writeFile } from "node:fs/promises";
import { INTEGRATIONS } from "../packages/core/src/index.js";
import { MILESTONES, parseMilestones, renderProgress, replaceProgress } from "./progress.js";

// npm run progress:write   regenerates the README's progress section
// npm run progress:check   exits non-zero when the README is out of date

const mode = process.argv[2];
const readme = await readFile("README.md", "utf8");
const block = renderProgress(parseMilestones(JSON.parse(await readFile(MILESTONES, "utf8")), INTEGRATIONS), INTEGRATIONS);
const next = replaceProgress(readme, block);
if (mode === "write") {
  await writeFile("README.md", next);
  console.log(next === readme ? "README progress already current" : "README progress updated");
} else if (next !== readme) {
  console.error("README progress is out of date; run npm run progress:write");
  process.exit(1);
} else {
  console.log("README progress ok");
}
