// Fails if tracked files look like they contain live credentials.
// This repo is public: secrets belong in .env.local, never in git.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findSecrets } from "./secrets-patterns.mjs";

// Files whose job is to describe secret shapes.
const EXEMPT = new Set(["package-lock.json", "scripts/secrets-patterns.mjs", "scripts/secrets.test.ts"]);

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const findings = files
  .filter((file) => !EXEMPT.has(file))
  .flatMap((file) => findSecrets(readFileSync(file, "utf8")).map((label) => `${file}: looks like a ${label}`));

if (findings.length) {
  console.error("Possible secrets found:\n" + findings.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`No secrets found in ${files.length} tracked files.`);
