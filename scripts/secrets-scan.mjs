// Fails if tracked files look like they contain live credentials.
// This repo is public: secrets belong in .env.local, never in git.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const patterns = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /sk-(proj-)?[A-Za-z0-9]{32,}/],
  ["Stripe live key", /(sk|rk)_live_[A-Za-z0-9]{16,}/],
  ["Shopify token", /shp(at|ca|pa|ss)_[A-Fa-f0-9]{32}/],
  ["Slack token", /xox[abpors]-[A-Za-z0-9-]{10,}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{36,}/],
  ["HubSpot key", /pat-(na|eu)\d-[a-f0-9-]{36}/],
  ["JWT (e.g. Supabase key)", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const findings = [];
for (const file of files) {
  if (file === "package-lock.json" || file === "scripts/secrets-scan.mjs") continue;
  const text = readFileSync(file, "utf8");
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) findings.push(`${file}: looks like a ${label}`);
  }
}
if (findings.length) {
  console.error("Possible secrets found:\n" + findings.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`No secrets found in ${files.length} tracked files.`);
