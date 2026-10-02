import { readFileSync, existsSync } from "node:fs";
import { checkConfig } from "../packages/core/src/config.js";

// Loads .env.local if present, then reports readiness without printing any values.
const env: Record<string, string | undefined> = { ...process.env };
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match?.[1]) env[match[1]] = match[2]?.replace(/^["']|["']$/g, "");
  }
}

const report = checkConfig(env);
console.log(report.ok ? "Config: OK" : "Config: NOT READY");
for (const error of report.errors) console.log(`  - ${error}`);
console.log("Integrations:");
for (const [name, state] of Object.entries(report.integrations)) console.log(`  ${name}: ${state}`);
process.exit(report.ok ? 0 : 1);
