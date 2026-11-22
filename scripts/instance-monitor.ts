/**
 * Instance health monitor. An operator runs it against their client
 * instances with each instance's support key only, so it sees what
 * GET /healthz and GET /v1/support/status show (versions, timings, counts)
 * and never business data. It decides whether anything needs attention:
 *
 *   - the instance doesn't answer, or answers /healthz or the status with anything but 200
 *   - an enabled connector's last run failed, its last successful sync is older than
 *     the threshold, or it is enabled but not syncing for want of settings
 *   - dead letters above the threshold, or more than at the last check
 *   - no migrations applied, or some expected migration missing
 *   - scheduled reasoning failing several runs in a row, or with no success for too long
 *
 * Keys are never in the config: it names the environment variable that holds
 * each instance's key. The report never shows a key, a URL's path or query,
 * or any field of a response beyond the ones these rules read.
 */
import { createHash } from "node:crypto";
import type { IssueTracker } from "../packages/core/src/issue-tracker.js";

export interface Thresholds {
  /** A connector whose last successful sync is older than this needs attention. */
  syncStaleHours: number;
  /** More dead letters than this needs attention. */
  deadLetters: number;
  /** Whether any rise in dead letters since the last check needs attention. Needs the state file. */
  deadLetterGrowth: boolean;
  /** Scheduled reasoning failing this many runs in a row needs attention. */
  reasoningFailures: number;
  /** Scheduled reasoning with no success for this long needs attention. Null: three intervals, at least an hour. */
  reasoningStaleHours: number | null;
}

export const DEFAULT_THRESHOLDS: Thresholds = { syncStaleHours: 24, deadLetters: 100, deadLetterGrowth: true, reasoningFailures: 3, reasoningStaleHours: null };
export const DEFAULT_TIMEOUT_MS = 10_000;
export const RETRY_DELAY_MS = 1_000;
/** The most of a response the monitor reads; a status is a few kilobytes. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** The longest connector error the report repeats. The instance has already scrubbed it. */
export const MAX_ERROR_CHARS = 200;
/** The label every monitor issue carries, and the one searched for open issues. */
export const ISSUE_LABEL = "instance-monitor";

export interface InstanceConfig {
  name: string;
  baseUrl: string;
  /** Name of the environment variable holding this instance's support key. */
  supportKeyEnv: string;
  thresholds: Thresholds;
}

export interface MonitorConfig {
  instances: InstanceConfig[];
  timeoutMs: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const INSTANCE_KEYS = new Set(["name", "baseUrl", "supportKeyEnv", "thresholds"]);
const TOP_KEYS = new Set(["instances", "thresholds", "timeoutMs"]);
const THRESHOLD_KEYS = new Set(Object.keys(DEFAULT_THRESHOLDS));
/** Fields someone might use to put a key in the file. The file only ever names the variable. */
const KEY_FIELDS = /key|token|secret|password|auth/i;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkKeys(where: string, value: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    // Never echo the value: an unknown field may be someone's key pasted in by mistake.
    if (KEY_FIELDS.test(key)) throw new ConfigError(`${where}: "${NAME.test(key) ? key : "a field"}" isn't allowed; keys never go in the config, only supportKeyEnv naming the variable that holds one`);
    throw new ConfigError(`${where}: unknown field "${NAME.test(key) ? key : "?"}"`);
  }
}

function parseThresholds(where: string, raw: unknown, base: Thresholds): Thresholds {
  if (raw === undefined) return base;
  if (!isObject(raw)) throw new ConfigError(`${where}: thresholds must be an object`);
  checkKeys(`${where}.thresholds`, raw, THRESHOLD_KEYS);
  const out = { ...base };
  const positive = (field: "syncStaleHours" | "deadLetters" | "reasoningFailures", whole: boolean, min: number) => {
    const v = raw[field];
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || (whole && !Number.isInteger(v))) {
      throw new ConfigError(`${where}.thresholds.${field} must be ${whole ? "a whole number" : "a number"} of at least ${min}`);
    }
    out[field] = v;
  };
  positive("syncStaleHours", false, 1);
  positive("deadLetters", true, 0);
  positive("reasoningFailures", true, 1);
  if (raw.deadLetterGrowth !== undefined) {
    if (typeof raw.deadLetterGrowth !== "boolean") throw new ConfigError(`${where}.thresholds.deadLetterGrowth must be true or false`);
    out.deadLetterGrowth = raw.deadLetterGrowth;
  }
  if (raw.reasoningStaleHours !== undefined) {
    const v = raw.reasoningStaleHours;
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 1)) throw new ConfigError(`${where}.thresholds.reasoningStaleHours must be null or a number of at least 1`);
    out.reasoningStaleHours = v;
  }
  return out;
}

function parseBaseUrl(where: string, raw: unknown): string {
  if (typeof raw !== "string") throw new ConfigError(`${where}.baseUrl must be a string`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${where}.baseUrl isn't a valid URL`);
  }
  // None of these is echoed: a URL can carry a secret.
  if (url.username || url.password) throw new ConfigError(`${where}.baseUrl must not carry a user name or password`);
  if (url.search || url.hash) throw new ConfigError(`${where}.baseUrl must not carry a query string or fragment`);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new ConfigError(`${where}.baseUrl must use https (http only for localhost), so the key never travels in the clear`);
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

/** Validates a parsed config file. Messages name fields, never their values. */
export function parseConfig(raw: unknown): MonitorConfig {
  if (!isObject(raw)) throw new ConfigError("the config must be a JSON object with an instances list");
  checkKeys("config", raw, TOP_KEYS);
  const thresholds = parseThresholds("config", raw.thresholds, DEFAULT_THRESHOLDS);
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== "number" || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 100 || raw.timeoutMs > 120_000) {
      throw new ConfigError("config.timeoutMs must be a whole number of milliseconds from 100 to 120000");
    }
    timeoutMs = raw.timeoutMs;
  }
  if (!Array.isArray(raw.instances) || raw.instances.length === 0) throw new ConfigError("config.instances must list at least one instance");
  const seen = new Set<string>();
  const instances = raw.instances.map((entry, i): InstanceConfig => {
    const where = `config.instances[${i}]`;
    if (!isObject(entry)) throw new ConfigError(`${where} must be an object`);
    checkKeys(where, entry, INSTANCE_KEYS);
    if (typeof entry.name !== "string" || !NAME.test(entry.name)) throw new ConfigError(`${where}.name must be 1 to 64 letters, digits, dots, dashes or underscores`);
    if (seen.has(entry.name.toLowerCase())) throw new ConfigError(`${where}.name "${entry.name}" is listed twice`);
    seen.add(entry.name.toLowerCase());
    if (typeof entry.supportKeyEnv !== "string" || !ENV_NAME.test(entry.supportKeyEnv)) {
      throw new ConfigError(`${where}.supportKeyEnv must name an environment variable (capitals, digits and underscores), not hold the key`);
    }
    return { name: entry.name, baseUrl: parseBaseUrl(where, entry.baseUrl), supportKeyEnv: entry.supportKeyEnv, thresholds: parseThresholds(where, entry.thresholds, thresholds) };
  });
  return { instances, timeoutMs };
}

/**
 * Reads `NAME=key` lines, one per instance, as a workflow passes them in one
 * secret. Blank lines and lines starting with # are skipped.
 */
export function parseSupportKeys(text: string | undefined): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [i, line] of (text ?? "").split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    const name = eq > 0 ? trimmed.slice(0, eq).trim() : "";
    if (!ENV_NAME.test(name)) throw new ConfigError(`support keys line ${i + 1} must read NAME=key`);
    const value = trimmed.slice(eq + 1).trim();
    if (value) keys[name] = value;
  }
  return keys;
}

export type ProblemCode =
  | "key_missing"
  | "unreachable"
  | "healthz_status"
  | "status_http"
  | "status_unreadable"
  | "connector_failed"
  | "connector_stale"
  | "connector_not_syncing"
  | "dead_letters_high"
  | "dead_letters_growing"
  | "migrations_none"
  | "migrations_missing"
  | "reasoning_failing"
  | "reasoning_stale";

export interface Problem {
  code: ProblemCode;
  /** The connector, or null when the problem is the instance's. */
  subject: string | null;
  message: string;
}

/** What to do about each kind of problem, for the report and the issue. */
export const ADVICE: Record<ProblemCode, string> = {
  key_missing: "Set the variable named by supportKeyEnv to the instance's SUPPORT_API_KEY.",
  unreachable: "Check the host: is the service running, and is its domain and certificate in order?",
  healthz_status: "The instance answers but isn't healthy; check the host's logs and recent deploys.",
  status_http: "401 means the support key doesn't match SUPPORT_API_KEY; 503 means the support status isn't set up; otherwise check the host's logs.",
  status_unreadable: "The status isn't the shape this monitor reads; run a monitor from the same release as the instance.",
  connector_failed: "Read the error, then check the vendor's credentials and status page; the next run retries from its checkpoint.",
  connector_stale: "Check that sync is running (SYNC_INTERVAL_MINUTES) and that the vendor is answering.",
  connector_not_syncing: "Add the missing settings to the host's secret store, or take the connector out of ENABLED_INTEGRATIONS.",
  dead_letters_high: "Look at dead letters by source and reason; a connector or webhook is sending input the instance can't take.",
  dead_letters_growing: "New input is being turned away; check the sources named for a vendor change or a bad webhook.",
  migrations_none: "Run npm run db:migrate against the instance's database, or redeploy so it migrates on start.",
  migrations_missing: "The instance runs an older release than this monitor expects; deploy the current image so it migrates.",
  reasoning_failing: "Check the host's logs for the error class named; reasoning retries at the next interval.",
  reasoning_stale: "Check REASON_SCHEDULE and REASON_INTERVAL_MINUTES, and the host's logs for reasoning runs.",
};

/** What the monitor keeps between checks: counts and times only. */
export interface InstanceState {
  checkedAt: string;
  deadLetters: number | null;
  /** Each connector's latest successful sync this monitor has seen, so it survives an instance restart. */
  connectors: Record<string, { lastSucceededAt: string }>;
}

export interface MonitorState {
  version: 1;
  instances: Record<string, InstanceState>;
}

export const emptyState = (): MonitorState => ({ version: 1, instances: {} });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Reads a state file, dropping anything it doesn't recognize rather than failing the check. */
export function parseState(raw: unknown): MonitorState {
  const state = emptyState();
  if (!isObject(raw) || raw.version !== 1 || !isObject(raw.instances)) return state;
  for (const [name, entry] of Object.entries(raw.instances)) {
    if (!NAME.test(name) || !isObject(entry) || typeof entry.checkedAt !== "string" || !ISO.test(entry.checkedAt)) continue;
    const connectors: InstanceState["connectors"] = {};
    if (isObject(entry.connectors)) {
      for (const [id, c] of Object.entries(entry.connectors)) {
        if (LABEL.test(id) && isObject(c) && typeof c.lastSucceededAt === "string" && ISO.test(c.lastSucceededAt)) connectors[id] = { lastSucceededAt: c.lastSucceededAt };
      }
    }
    const dl = entry.deadLetters;
    state.instances[name] = { checkedAt: entry.checkedAt, deadLetters: typeof dl === "number" && Number.isInteger(dl) && dl >= 0 ? dl : null, connectors };
  }
  return state;
}

/** Ids and names shown as they are; anything else shows as "other". */
const LABEL = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const label = (v: unknown): string => (typeof v === "string" && LABEL.test(v) ? v : "other");

interface LastRun {
  outcome: "succeeded" | "failed";
  finishedAt: string;
  error: string | null;
}

/** The fields of GET /v1/support/status the rules read. Nothing else is kept. */
export interface StatusFacts {
  version: string;
  startedAt: string;
  uptimeSeconds: number;
  migrations: string[];
  integrations: { id: string; syncing: boolean; notSyncingReason: string | null; lastSync: LastRun | null }[];
  reasoning: { scheduled: boolean; intervalMinutes: number | null; lastSucceededAt: string | null; consecutiveFailures: number; lastRun: LastRun | null } | null;
  deadLetters: { total: number; bySource: Record<string, number> };
}

const time = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** Text from the instance fit to repeat: control characters, backticks and @ mentions taken out, capped. */
export function cleanText(v: unknown, max: number = MAX_ERROR_CHARS): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = v.replace(/[\u0000-\u001f\u007f`]+/g, " ").replace(/@/g, "(at)").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function lastRun(v: unknown): LastRun | null | undefined {
  if (v === null) return null;
  if (!isObject(v) || (v.outcome !== "succeeded" && v.outcome !== "failed")) return undefined;
  const finishedAt = time(v.finishedAt);
  if (!finishedAt) return undefined;
  return { outcome: v.outcome, finishedAt, error: cleanText(v.error) };
}

/** Picks the fields the rules read out of a status answer, or null when it isn't a status. */
export function readStatus(body: unknown): StatusFacts | null {
  if (!isObject(body) || !isObject(body.instance) || !isObject(body.migrations) || !Array.isArray(body.integrations) || !isObject(body.deadLetters)) return null;
  const startedAt = time(body.instance.startedAt);
  const uptimeSeconds = count(body.instance.uptimeSeconds);
  const applied = body.migrations.applied;
  const total = count(body.deadLetters.total);
  if (!startedAt || uptimeSeconds === null || !Array.isArray(applied) || total === null) return null;
  const integrations: StatusFacts["integrations"] = [];
  for (const i of body.integrations) {
    if (!isObject(i) || typeof i.syncing !== "boolean") return null;
    const run = lastRun(i.lastSync);
    if (run === undefined) return null;
    integrations.push({ id: label(i.id), syncing: i.syncing, notSyncingReason: cleanText(i.notSyncingReason), lastSync: run });
  }
  let reasoning: StatusFacts["reasoning"] = null;
  // An instance from before scheduled reasoning has no reasoning field; that is not a problem.
  if (body.reasoning !== undefined && body.reasoning !== null) {
    const r = body.reasoning;
    if (!isObject(r) || typeof r.scheduled !== "boolean") return null;
    const run = lastRun(r.lastRun);
    const failures = count(r.consecutiveFailures);
    if (run === undefined || failures === null) return null;
    const interval = typeof r.intervalMinutes === "number" && r.intervalMinutes > 0 ? r.intervalMinutes : null;
    reasoning = { scheduled: r.scheduled, intervalMinutes: interval, lastSucceededAt: time(r.lastSucceededAt), consecutiveFailures: failures, lastRun: run };
  }
  const bySource: Record<string, number> = {};
  if (isObject(body.deadLetters.bySource)) {
    for (const [source, n] of Object.entries(body.deadLetters.bySource)) {
      const c = count(n);
      if (c !== null) bySource[label(source)] = (bySource[label(source)] ?? 0) + c;
    }
  }
  const version = typeof body.instance.version === "string" && /^[\w.+-]{1,40}$/.test(body.instance.version) ? body.instance.version : "unknown";
  return {
    version,
    startedAt,
    uptimeSeconds,
    migrations: applied.filter((m): m is string => typeof m === "string"),
    integrations,
    reasoning,
    deadLetters: { total, bySource },
  };
}

const HOUR_MS = 3_600_000;

/** "3h", "2d", "45m": how long ago, roughly. */
export function ago(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(0, Math.round(ms / 60_000))}m`;
  if (ms < 48 * HOUR_MS) return `${Math.round(ms / HOUR_MS)}h`;
  return `${Math.round(ms / (24 * HOUR_MS))}d`;
}

export interface Evaluation {
  problems: Problem[];
  state: InstanceState;
}

/** Applies every rule to one status. `previous` is the last check's state, when there is one. */
export function evaluate(status: StatusFacts, thresholds: Thresholds, now: Date, previous: InstanceState | undefined, expectedMigrations: readonly string[] = []): Evaluation {
  const problems: Problem[] = [];
  const at = now.getTime();
  const staleMs = thresholds.syncStaleHours * HOUR_MS;
  const connectors: InstanceState["connectors"] = {};

  for (const c of status.integrations) {
    if (!c.syncing) {
      // A connector with nothing to sync (webhook-only, or not built yet) is fine; one missing settings is not.
      if (c.notSyncingReason?.startsWith("missing ")) problems.push({ code: "connector_not_syncing", subject: c.id, message: `${c.id} is enabled but not syncing: ${c.notSyncingReason}` });
      continue;
    }
    const seen = previous?.connectors[c.id]?.lastSucceededAt;
    const now_ = c.lastSync?.outcome === "succeeded" ? c.lastSync.finishedAt : undefined;
    const lastSucceededAt = [seen, now_].filter((t): t is string => t !== undefined).sort().at(-1);
    if (lastSucceededAt) connectors[c.id] = { lastSucceededAt };
    if (c.lastSync?.outcome === "failed") {
      const when = ago(at - Date.parse(c.lastSync.finishedAt));
      problems.push({ code: "connector_failed", subject: c.id, message: `${c.id}: last sync failed ${when} ago${c.lastSync.error ? `: ${c.lastSync.error}` : ""}` });
    }
    if (lastSucceededAt) {
      const age = at - Date.parse(lastSucceededAt);
      if (age > staleMs) problems.push({ code: "connector_stale", subject: c.id, message: `${c.id}: last successful sync ${ago(age)} ago (limit ${thresholds.syncStaleHours}h)` });
    } else if (status.uptimeSeconds * 1000 > staleMs) {
      problems.push({ code: "connector_stale", subject: c.id, message: `${c.id}: no successful sync in the ${ago(status.uptimeSeconds * 1000)} since the instance started (limit ${thresholds.syncStaleHours}h)` });
    }
  }

  const dl = status.deadLetters;
  const top = Object.entries(dl.bySource)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([s, n]) => `${s} ${n}`)
    .join(", ");
  if (dl.total > thresholds.deadLetters) problems.push({ code: "dead_letters_high", subject: null, message: `${dl.total} dead letters (limit ${thresholds.deadLetters})${top ? `; most from ${top}` : ""}` });
  if (thresholds.deadLetterGrowth && previous?.deadLetters != null && dl.total > previous.deadLetters) {
    problems.push({ code: "dead_letters_growing", subject: null, message: `dead letters rose by ${dl.total - previous.deadLetters} to ${dl.total} since the check at ${previous.checkedAt}` });
  }

  if (status.migrations.length === 0) problems.push({ code: "migrations_none", subject: null, message: "no database migrations are applied" });
  else {
    const applied = new Set(status.migrations);
    const missing = expectedMigrations.filter((m) => !applied.has(m));
    if (missing.length) problems.push({ code: "migrations_missing", subject: null, message: `${missing.length} migration${missing.length === 1 ? "" : "s"} not applied: ${missing.slice(0, 5).map((m) => cleanText(m, 80)).join(", ")}${missing.length > 5 ? ", …" : ""}` });
  }

  const r = status.reasoning;
  if (r?.scheduled) {
    if (r.consecutiveFailures >= thresholds.reasoningFailures) {
      const err = r.lastRun?.outcome === "failed" && r.lastRun.error ? ` (${r.lastRun.error})` : "";
      problems.push({ code: "reasoning_failing", subject: null, message: `scheduled reasoning failed ${r.consecutiveFailures} runs in a row${err}` });
    }
    const limitMs = thresholds.reasoningStaleHours !== null ? thresholds.reasoningStaleHours * HOUR_MS : Math.max(HOUR_MS, 3 * (r.intervalMinutes ?? 60) * 60_000);
    const since = r.lastSucceededAt ?? status.startedAt;
    const age = at - Date.parse(since);
    if (age > limitMs) {
      problems.push({
        code: "reasoning_stale",
        subject: null,
        message: r.lastSucceededAt ? `scheduled reasoning last succeeded ${ago(age)} ago (limit ${ago(limitMs)})` : `scheduled reasoning hasn't succeeded in the ${ago(age)} since the instance started (limit ${ago(limitMs)})`,
      });
    }
  }

  return { problems, state: { checkedAt: now.toISOString(), deadLetters: dl.total, connectors } };
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpAnswer {
  status: number;
  /** Parsed JSON, or undefined when the body wasn't JSON or was too large. */
  body: unknown;
}

export class NetworkError extends Error {
  override name = "NetworkError";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What went wrong with a request, in words that never include the URL or the key. */
function describe(error: unknown, timeoutMs: number, aborted: boolean): string {
  if (aborted) return `no answer within ${timeoutMs}ms`;
  const code = isObject(error) && isObject(error.cause) && typeof error.cause.code === "string" && /^[A-Z_]{2,40}$/.test(error.cause.code) ? error.cause.code : null;
  return code ? `network error (${code})` : "network error";
}

async function once(fetch: Fetch, url: string, headers: Record<string, string>, timeoutMs: number): Promise<HttpAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // A redirect could carry the key to another host, so none is followed.
    const response = await fetch(url, { method: "GET", headers, redirect: "manual", signal: controller.signal });
    const text = response.status === 200 ? await response.text() : "";
    let body: unknown;
    if (text && text.length <= MAX_RESPONSE_BYTES) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    return { status: response.status, body };
  } catch (error) {
    throw new NetworkError(describe(error, timeoutMs, controller.signal.aborted));
  } finally {
    clearTimeout(timer);
  }
}

/** One GET with a timeout, retried once after a network error or timeout. HTTP answers are never retried. */
export async function get(fetch: Fetch, url: string, headers: Record<string, string>, timeoutMs: number, retryDelayMs: number = RETRY_DELAY_MS): Promise<HttpAnswer> {
  try {
    return await once(fetch, url, headers, timeoutMs);
  } catch {
    // once() turns every failure into a NetworkError.
    await sleep(retryDelayMs);
    return once(fetch, url, headers, timeoutMs);
  }
}

export interface InstanceSummary {
  version: string;
  uptimeSeconds: number;
  connectorsSyncing: number;
  deadLetters: number;
  migrations: number;
  reasoning: "off" | "ok" | "failing" | "not reported";
}

export interface InstanceResult {
  name: string;
  /** Scheme and host only: never a path or query. */
  origin: string;
  healthy: boolean;
  checkedAt: string;
  problems: Problem[];
  /** Null when the status couldn't be read. */
  summary: InstanceSummary | null;
}

export interface CheckOptions {
  fetch: Fetch;
  now: () => Date;
  timeoutMs: number;
  retryDelayMs?: number;
  previous?: InstanceState | undefined;
  expectedMigrations?: readonly string[];
}

/** Checks one instance. Never throws; anything that goes wrong is a problem in the result. */
export async function checkInstance(instance: InstanceConfig, key: string | undefined, options: CheckOptions): Promise<{ result: InstanceResult; state: InstanceState | undefined }> {
  const origin = new URL(instance.baseUrl).origin;
  const done = (problems: Problem[], summary: InstanceSummary | null, state: InstanceState | undefined) => ({
    result: { name: instance.name, origin, healthy: problems.length === 0, checkedAt: options.now().toISOString(), problems, summary },
    state,
  });
  if (!key) return done([{ code: "key_missing", subject: null, message: `${instance.supportKeyEnv} isn't set, so the status can't be read` }], null, options.previous);
  const delay = options.retryDelayMs ?? RETRY_DELAY_MS;

  let health: HttpAnswer;
  try {
    // /healthz needs no key, so none is sent.
    health = await get(options.fetch, new URL("healthz", instance.baseUrl).href, { accept: "application/json" }, options.timeoutMs, delay);
  } catch (error) {
    return done([{ code: "unreachable", subject: null, message: `GET /healthz: ${error instanceof NetworkError ? error.message : "network error"}, after one retry` }], null, options.previous);
  }
  if (health.status !== 200) return done([{ code: "healthz_status", subject: null, message: `GET /healthz answered ${health.status}` }], null, options.previous);

  let answer: HttpAnswer;
  try {
    answer = await get(options.fetch, new URL("v1/support/status?days=1", instance.baseUrl).href, { accept: "application/json", authorization: `Bearer ${key}` }, options.timeoutMs, delay);
  } catch (error) {
    return done([{ code: "unreachable", subject: null, message: `GET /v1/support/status: ${error instanceof NetworkError ? error.message : "network error"}, after one retry` }], null, options.previous);
  }
  if (answer.status !== 200) {
    const why = answer.status === 401 ? " (the support key was turned down)" : answer.status === 503 ? " (support status isn't set up)" : "";
    return done([{ code: "status_http", subject: null, message: `GET /v1/support/status answered ${answer.status}${why}` }], null, options.previous);
  }
  const status = readStatus(answer.body);
  if (!status) return done([{ code: "status_unreadable", subject: null, message: "GET /v1/support/status answered with something that isn't a support status" }], null, options.previous);

  const { problems, state } = evaluate(status, instance.thresholds, options.now(), options.previous, options.expectedMigrations);
  const r = status.reasoning;
  const summary: InstanceSummary = {
    version: status.version,
    uptimeSeconds: status.uptimeSeconds,
    connectorsSyncing: status.integrations.filter((c) => c.syncing).length,
    deadLetters: status.deadLetters.total,
    migrations: status.migrations.length,
    reasoning: !r ? "not reported" : !r.scheduled ? "off" : problems.some((p) => p.code.startsWith("reasoning_")) ? "failing" : "ok",
  };
  return done(problems, summary, state);
}

export interface MonitorRun {
  checkedAt: string;
  healthy: boolean;
  instances: InstanceResult[];
}

export interface RunOptions {
  env: Record<string, string | undefined>;
  /** Keys from a NAME=key list, used when the variable itself isn't set. */
  supportKeys?: Record<string, string>;
  fetch: Fetch;
  now?: () => Date;
  state?: MonitorState;
  retryDelayMs?: number;
  expectedMigrations?: readonly string[];
}

/** Checks every instance in turn and returns the run and the state for next time. */
export async function runMonitor(config: MonitorConfig, options: RunOptions): Promise<{ run: MonitorRun; state: MonitorState; keys: string[] }> {
  const now = options.now ?? (() => new Date());
  const state: MonitorState = { version: 1, instances: { ...(options.state?.instances ?? {}) } };
  const results: InstanceResult[] = [];
  const keys: string[] = [];
  for (const instance of config.instances) {
    const key = options.env[instance.supportKeyEnv] || options.supportKeys?.[instance.supportKeyEnv] || undefined;
    if (key) keys.push(key);
    const checked = await checkInstance(instance, key, {
      fetch: options.fetch,
      now,
      timeoutMs: config.timeoutMs,
      previous: state.instances[instance.name],
      ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
      ...(options.expectedMigrations ? { expectedMigrations: options.expectedMigrations } : {}),
    });
    results.push(checked.result);
    if (checked.state) state.instances[instance.name] = checked.state;
  }
  return { run: { checkedAt: now().toISOString(), healthy: results.every((r) => r.healthy), instances: results }, state, keys };
}

/** Replaces every given secret in the text. The report never includes a key; this makes sure. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(s).join("[redacted]");
  return out;
}

/** The short human-readable report. */
export function renderReport(run: MonitorRun): string {
  const wrong = run.instances.filter((i) => !i.healthy).length;
  const lines = [`Instance monitor, ${run.checkedAt}: ${wrong === 0 ? `all ${run.instances.length} healthy` : `${wrong} of ${run.instances.length} need${wrong === 1 ? "s" : ""} attention`}`, ""];
  for (const i of run.instances) {
    if (i.healthy && i.summary) {
      const s = i.summary;
      lines.push(`ok    ${i.name} (${i.origin}): v${s.version}, up ${ago(s.uptimeSeconds * 1000)}, ${s.connectorsSyncing} syncing, ${s.deadLetters} dead letters, reasoning ${s.reasoning}`);
      continue;
    }
    lines.push(`FAIL  ${i.name} (${i.origin})`);
    for (const p of i.problems) lines.push(`      - ${p.message}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The marker that ties an issue to its instance. The closing quote keeps "acme" from matching "acme-2". */
export const issueMarker = (name: string) => `<!-- instance-monitor instance="${name}" -->`;
export const issueTitle = (name: string) => `Instance monitor: ${name} needs attention`;

/** Stable across runs while the same things are wrong, whatever the times in the messages. */
export function fingerprint(problems: readonly Problem[]): string {
  const keys = [...new Set(problems.map((p) => `${p.code}:${p.subject ?? ""}`))].sort();
  return createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 16);
}

const fingerprintLine = (fp: string) => `<!-- instance-monitor fingerprint="${fp}" -->`;

function problemList(problems: readonly Problem[]): string {
  const advice = [...new Set(problems.map((p) => p.code))].map((c) => `- **${c}**: ${ADVICE[c]}`);
  return [...problems.map((p) => `- \`${p.code}\` ${p.message}`), "", "What to do:", ...advice].join("\n");
}

export function issueBody(result: InstanceResult): string {
  return [
    issueMarker(result.name),
    fingerprintLine(fingerprint(result.problems)),
    `**${result.name}** needs attention, as of ${result.checkedAt}:`,
    "",
    problemList(result.problems),
    "",
    "The instance monitor keeps this one issue up to date, commenting when what's wrong changes, and closes it when the instance is healthy again.",
  ].join("\n");
}

export type IssueAction = { name: string; action: "opened" | "commented" | "unchanged" | "closed" | "none"; issue: number | null };

/**
 * Keeps one issue per instance: opens it when something is wrong, comments
 * and refreshes the body when what's wrong changes (and only then), and
 * closes it once the instance is healthy again.
 */
export async function syncIssues(run: MonitorRun, tracker: IssueTracker): Promise<IssueAction[]> {
  const actions: IssueAction[] = [];
  for (const result of run.instances) {
    const open = await tracker.findOpen(issueMarker(result.name));
    if (result.healthy) {
      if (open) {
        await tracker.close(open.number, `${result.name} is healthy again as of ${result.checkedAt}. Closing; a new problem opens a new issue.`);
        actions.push({ name: result.name, action: "closed", issue: open.number });
      } else actions.push({ name: result.name, action: "none", issue: null });
      continue;
    }
    if (!open) {
      actions.push({ name: result.name, action: "opened", issue: await tracker.open(issueTitle(result.name), issueBody(result)) });
      continue;
    }
    if (open.body.includes(fingerprintLine(fingerprint(result.problems)))) {
      actions.push({ name: result.name, action: "unchanged", issue: open.number });
      continue;
    }
    await tracker.comment(open.number, `What's wrong changed, as of ${result.checkedAt}:\n\n${problemList(result.problems)}`);
    await tracker.update(open.number, issueBody(result));
    actions.push({ name: result.name, action: "commented", issue: open.number });
  }
  return actions;
}
