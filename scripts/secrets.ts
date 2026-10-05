import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import {
  generateSecret,
  isRequired,
  parseManifest,
  planSecrets,
  redact,
  type SecretEntry,
} from "../packages/core/src/secrets.js";
import { loadEnv, upsertEnvFile } from "./env.js";

// npm run secrets:plan  -- [--json] [--purposes core,instance] [--env-file .env.local]
// npm run secrets:setup -- [--generate-only] [--purposes core,instance] [--env-file .env.local]
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean", default: false },
    "generate-only": { type: "boolean", default: false },
    purposes: { type: "string", default: "core,instance,migrations" },
    "env-file": { type: "string", default: ".env.local" },
  },
});

const command = positionals[0] ?? "plan";
const envFile = values["env-file"];
const manifest = parseManifest(JSON.parse(readFileSync("secrets/manifest.json", "utf8")));
const env = loadEnv(envFile);
const options = () => ({
  purposes: values.purposes.split(",").filter(Boolean),
  integrations: (env.ENABLED_INTEGRATIONS ?? "").split(",").filter(Boolean),
});

function printPlan(): boolean {
  const plan = planSecrets(manifest, env, options());
  if (values.json) {
    console.log(JSON.stringify(plan, null, 2));
    return plan.ready;
  }
  const marks = { ok: "✓", missing: "✗", invalid: "!", will_generate: "+", not_needed: "·" } as const;
  for (const item of plan.items) {
    if (item.status === "not_needed") continue;
    console.log(`${marks[item.status]} ${item.name.padEnd(28)} ${item.status.replace("_", " ")}`);
    if (item.status === "missing" || item.status === "invalid") {
      for (const step of item.howToGet) console.log(`    - ${step}`);
    }
  }
  console.log(plan.ready ? "\nReady." : "\nNot ready: run npm run secrets:setup to fill the gaps.");
  return plan.ready;
}

async function ask(question: string, hidden: boolean): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const answer = new Promise<string>((resolve) => rl.question(question, resolve));
  muted = hidden;
  const value = await answer;
  rl.close();
  if (hidden) process.stdout.write("\n");
  return value.trim();
}

async function setup(): Promise<boolean> {
  const updates: Record<string, string> = {};
  const interactive = process.stdin.isTTY && !values["generate-only"];

  for (const entry of manifest.entries as SecretEntry[]) {
    const current = env[entry.name];
    if (!isRequired(entry, options()) || (current !== undefined && current !== "")) continue;

    if (entry.generate) {
      updates[entry.name] = generateSecret(entry, randomBytes);
      console.log(`+ ${entry.name}: generated ${redact(updates[entry.name]!)}`);
      continue;
    }
    if (!interactive) continue;

    console.log(`\n${entry.name}: ${entry.description}`);
    for (const step of entry.howToGet) console.log(`  - ${step}`);
    if (entry.docsUrl) console.log(`  Docs: ${entry.docsUrl}`);
    for (;;) {
      const value = await ask(`  Paste value (or press Enter to skip): `, entry.kind === "secret");
      if (value === "") break;
      if (entry.pattern && !new RegExp(`^(?:${entry.pattern})$`).test(value)) {
        console.log("  That doesn't look right. Check you copied the whole value and try again.");
        continue;
      }
      updates[entry.name] = value;
      console.log(`  ✓ saved ${entry.kind === "secret" ? redact(value) : value}`);
      break;
    }
  }

  if (Object.keys(updates).length) {
    const before = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
    writeFileSync(envFile, upsertEnvFile(before, updates), { mode: 0o600 });
    chmodSync(envFile, 0o600);
    Object.assign(env, updates);
    console.log(`\nWrote ${Object.keys(updates).length} value(s) to ${envFile} (readable only by you).`);
  }
  console.log("");
  return printPlan();
}

const ok = command === "setup" ? await setup() : printPlan();
process.exit(ok ? 0 : 1);
