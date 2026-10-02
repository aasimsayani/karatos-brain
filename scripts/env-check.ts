import { checkConfig } from "../packages/core/src/config.js";
import { loadEnv } from "./env.js";

// Reports readiness without printing any values.
const report = checkConfig(loadEnv());
console.log(report.ok ? "Config: OK" : "Config: NOT READY");
for (const error of report.errors) console.log(`  - ${error}`);
console.log("Integrations:");
for (const [name, state] of Object.entries(report.integrations)) console.log(`  ${name}: ${state}`);
process.exit(report.ok ? 0 : 1);
