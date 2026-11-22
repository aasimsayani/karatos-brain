import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gitHubIssueTracker } from "../packages/core/src/issue-tracker.js";
import { ConfigError, ISSUE_LABEL, emptyState, parseConfig, parseState, parseSupportKeys, redact, renderReport, runMonitor, syncIssues, type MonitorState } from "./instance-monitor.js";

// npm run monitor -- [options]   checks each instance's /healthz and support status with its support key
//
//   --config <file>        the instances (or MONITOR_CONFIG_FILE, or the JSON itself in MONITOR_CONFIG)
//   --state <file>         counts and times kept between runs, for dead-letter growth (or MONITOR_STATE_FILE)
//   --json                 print the JSON result instead of the report
//   --json-file <file>     also write the JSON result to a file
//   --migrations <dir>     expect every .sql migration in this directory to be applied (or MONITOR_MIGRATIONS_DIR)
//   --issues               keep one GitHub issue per instance (or MONITOR_ISSUES=true); needs GITHUB_TOKEN and GITHUB_REPOSITORY
//
// Each instance's key comes from the variable its supportKeyEnv names, or from
// MONITOR_SUPPORT_KEYS (NAME=key lines). Exit 0: all healthy. 1: something needs
// attention. 2: the monitor itself couldn't run (bad config, GitHub API failure).

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const env = process.env;
let keys: string[] = [];
const say = (text: string) => process.stdout.write(redact(text, keys));

async function main(): Promise<number> {
  const file = option("--config") ?? env.MONITOR_CONFIG_FILE;
  const inline = env.MONITOR_CONFIG?.trim();
  if (!file && !inline) throw new ConfigError("give --config <file>, MONITOR_CONFIG_FILE or MONITOR_CONFIG");
  let raw: unknown;
  try {
    raw = JSON.parse(file ? await readFile(file, "utf8") : inline!);
  } catch (error) {
    throw new ConfigError(error instanceof SyntaxError ? "the config isn't valid JSON" : "the config file can't be read");
  }
  const config = parseConfig(raw);
  const supportKeys = parseSupportKeys(env.MONITOR_SUPPORT_KEYS);

  const statePath = option("--state") ?? env.MONITOR_STATE_FILE;
  let state: MonitorState = emptyState();
  if (statePath) {
    try {
      state = parseState(JSON.parse(await readFile(statePath, "utf8")));
    } catch {
      // No state yet, or unreadable: this run takes a new baseline.
    }
  }
  const migrationsDir = option("--migrations") || env.MONITOR_MIGRATIONS_DIR || undefined;
  const expectedMigrations = migrationsDir ? (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort() : undefined;

  const result = await runMonitor(config, { env, supportKeys, fetch: globalThis.fetch, state, ...(expectedMigrations ? { expectedMigrations } : {}) });
  keys = result.keys;
  const report = renderReport(result.run);
  const json = `${JSON.stringify(result.run, null, 2)}\n`;
  say(flag("--json") ? json : report);

  const jsonFile = option("--json-file");
  if (jsonFile) {
    await mkdir(dirname(jsonFile), { recursive: true });
    await writeFile(jsonFile, redact(json, keys));
  }
  if (statePath) {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(result.state, null, 2)}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, redact(`\`\`\`\n${report}\`\`\`\n`, keys));
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `healthy=${result.run.healthy}\n`);

  if (flag("--issues") || env.MONITOR_ISSUES === "true") {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) throw new ConfigError("--issues needs GITHUB_TOKEN and GITHUB_REPOSITORY");
    const tracker = gitHubIssueTracker({ repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, labels: [ISSUE_LABEL] });
    for (const a of await syncIssues(result.run, tracker)) {
      if (a.action !== "none") say(`issue for ${a.name}: ${a.action}${a.issue ? ` (#${a.issue})` : ""}\n`);
    }
  }
  return result.run.healthy ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  // Only messages this monitor wrote: never a raw error, which could quote a URL or a response.
  const message = error instanceof ConfigError ? error.message : error instanceof Error && /^GitHub /.test(error.message) ? error.message : "the monitor failed unexpectedly";
  process.stderr.write(redact(`instance monitor: ${message}\n`, keys));
  process.exitCode = 2;
}
