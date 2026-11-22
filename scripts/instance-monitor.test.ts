import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, gitHubIssueTracker, type IntegrationStatus, type IssueTracker, type TrackedIssue } from "@karatos/core";
import { createBrainApp, inMemoryDiagnostics, StaticDocumentationSource, supportStatus, type SupportReasoningStatus, type SupportStatusOptions, type SyncStatus } from "@karatos/server";
import {
  ADVICE,
  ago,
  checkInstance,
  cleanText,
  ConfigError,
  DEFAULT_THRESHOLDS,
  evaluate,
  fingerprint,
  get,
  issueBody,
  issueMarker,
  issueTitle,
  parseConfig,
  parseState,
  parseSupportKeys,
  readStatus,
  redact,
  renderReport,
  runMonitor,
  syncIssues,
  type Fetch,
  type InstanceConfig,
  type InstanceResult,
  type InstanceState,
  type MonitorRun,
  type Problem,
  type StatusFacts,
  type Thresholds,
} from "./instance-monitor.js";

// Built at runtime so no key-shaped literal sits in the repository.
const newKey = (prefix: string) => `${prefix}${randomBytes(24).toString("hex")}`;
const NOW = new Date("2026-11-22T12:00:00.000Z");
const HOUR = 3_600_000;
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();
const MIGRATIONS = ["0001_core.sql", "0002_ingestion.sql"];

const run = (id: string, outcome: "succeeded" | "failed", finishedHoursAgo: number, error?: string): SyncStatus => ({
  id,
  mode: "incremental",
  outcome,
  startedAt: hoursAgo(finishedHoursAgo + 0.01),
  finishedAt: hoursAgo(finishedHoursAgo),
  ...(outcome === "succeeded" ? { report: { ingested: 3, duplicates: 0, deadLettered: 0, batches: 1 } as SyncStatus["report"] & object } : {}),
  ...(error !== undefined ? { error } : {}),
});

const goodReasoning = (): SupportReasoningStatus => ({
  scheduled: true,
  intervalMinutes: 60,
  lastRun: { trigger: "interval", outcome: "succeeded", startedAt: hoursAgo(0.5), finishedAt: hoursAgo(0.49), recommendations: 2, measured: 0, error: null },
  lastSucceededAt: hoursAgo(0.49),
  consecutiveFailures: 0,
});

interface Fixture {
  enabled?: string[];
  skipped?: { id: string; reason: string }[];
  runs?: SyncStatus[];
  reasoning?: SupportReasoningStatus | null;
  deadLetters?: { source?: string; reason: string }[];
  migrations?: string[];
  startedHoursAgo?: number;
}

/** A status built by the instance's own code, so a change to its shape breaks these tests. */
async function statusBody(f: Fixture = {}): Promise<unknown> {
  const store = new InMemoryStore();
  for (const d of f.deadLetters ?? []) store.deadLetters.push({ id: `dl_${store.deadLetters.length}`, reason: d.reason, ...(d.source ? { source: d.source } : {}), receivedAt: NOW.toISOString(), input: {} } as never);
  const options: SupportStatusOptions = {
    instanceName: "Example Jewelers",
    version: "0.1.0",
    startedAt: new Date(NOW.getTime() - (f.startedHoursAgo ?? 72) * HOUR),
    retentionDays: 30,
    departments: ["sales"],
    enabledIntegrations: f.enabled ?? ["stripe", "shopify"],
    skipped: f.skipped ?? [],
    syncStatus: () => f.runs ?? [run("stripe", "succeeded", 1), run("shopify", "succeeded", 2)],
    ...(f.reasoning === null ? {} : { reasoning: () => f.reasoning ?? goodReasoning() }),
    diagnostics: inMemoryDiagnostics(store, f.migrations ?? MIGRATIONS),
    now: () => NOW,
  };
  return JSON.parse(JSON.stringify(await supportStatus("org_example", options, [], 1)));
}

async function facts(f: Fixture = {}): Promise<StatusFacts> {
  const s = readStatus(await statusBody(f));
  expect(s).not.toBeNull();
  return s!;
}

const t = (over: Partial<Thresholds> = {}): Thresholds => ({ ...DEFAULT_THRESHOLDS, ...over });
const codes = (problems: Problem[]) => problems.map((p) => `${p.code}:${p.subject ?? ""}`);

describe("config", () => {
  const instance = { name: "acme", baseUrl: "https://acme.example.test", supportKeyEnv: "ACME_SUPPORT_KEY" };

  it("fills in defaults and lets an instance override the shared thresholds", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ syncStaleHours: 24, deadLetters: 100, deadLetterGrowth: true, reasoningFailures: 3, reasoningStaleHours: null });
    const config = parseConfig({ thresholds: { syncStaleHours: 12 }, instances: [instance, { ...instance, name: "beta", baseUrl: "https://beta.example.test/brain", thresholds: { deadLetters: 5 } }] });
    expect(config.timeoutMs).toBe(10_000);
    expect(config.instances[0]).toEqual({ ...instance, baseUrl: "https://acme.example.test/", thresholds: { ...DEFAULT_THRESHOLDS, syncStaleHours: 12 } });
    expect(config.instances[1]!.baseUrl).toBe("https://beta.example.test/brain/");
    expect(config.instances[1]!.thresholds).toEqual({ ...DEFAULT_THRESHOLDS, syncStaleHours: 12, deadLetters: 5 });
    expect(parseConfig({ instances: [{ ...instance, thresholds: { deadLetterGrowth: false, reasoningStaleHours: 6, reasoningFailures: 1, deadLetters: 0 } }], timeoutMs: 100 }).instances[0]!.thresholds).toEqual({
      syncStaleHours: 24,
      deadLetters: 0,
      deadLetterGrowth: false,
      reasoningFailures: 1,
      reasoningStaleHours: 6,
    });
    expect(parseConfig({ instances: [{ ...instance, baseUrl: "http://localhost:8080" }] }).instances[0]!.baseUrl).toBe("http://localhost:8080/");
    expect(parseConfig({ instances: [{ ...instance, baseUrl: "http://127.0.0.1:8080" }] }).instances[0]!.baseUrl).toBe("http://127.0.0.1:8080/");
    expect(parseConfig({ instances: [{ ...instance, baseUrl: "http://[::1]:8080" }] }).instances[0]!.baseUrl).toBe("http://[::1]:8080/");
    expect(parseConfig({ instances: [instance], timeoutMs: 120_000 }).timeoutMs).toBe(120_000);
    expect(parseConfig({ instances: [{ ...instance, thresholds: { reasoningStaleHours: null, syncStaleHours: 1 } }] }).instances[0]!.thresholds.syncStaleHours).toBe(1);
  });

  it.each([
    [null, "a JSON object"],
    [[], "a JSON object"],
    [{}, "at least one instance"],
    [{ instances: [] }, "at least one instance"],
    [{ instances: ["acme"] }, "instances[0] must be an object"],
    [{ instances: [{ ...instance, name: "has space" }] }, "name must be"],
    [{ instances: [{ ...instance, name: 7 }] }, "name must be"],
    [{ instances: [instance, { ...instance, name: "ACME" }] }, "listed twice"],
    [{ instances: [{ ...instance, supportKeyEnv: "lower" }] }, "supportKeyEnv must name"],
    [{ instances: [{ ...instance, supportKeyEnv: undefined }] }, "supportKeyEnv must name"],
    [{ instances: [{ ...instance, baseUrl: 5 }] }, "baseUrl must be a string"],
    [{ instances: [{ ...instance, baseUrl: "not a url" }] }, "isn't a valid URL"],
    [{ instances: [{ ...instance, baseUrl: "http://acme.example.test" }] }, "must use https"],
    [{ instances: [{ ...instance, baseUrl: "ftp://acme.example.test" }] }, "must use https"],
    [{ instances: [{ ...instance, extra: 1 }] }, 'unknown field "extra"'],
    [{ instances: [instance], other: 1 }, 'config: unknown field "other"'],
    [{ instances: [instance], thresholds: [] }, "thresholds must be an object"],
    [{ instances: [instance], thresholds: { syncStaleHours: 0.5 } }, "syncStaleHours must be a number of at least 1"],
    [{ instances: [instance], thresholds: { syncStaleHours: "24" } }, "syncStaleHours must be"],
    [{ instances: [instance], thresholds: { syncStaleHours: Number.POSITIVE_INFINITY } }, "syncStaleHours must be"],
    [{ instances: [instance], thresholds: { deadLetters: -1 } }, "deadLetters must be a whole number of at least 0"],
    [{ instances: [instance], thresholds: { deadLetters: 1.5 } }, "deadLetters must be a whole number"],
    [{ instances: [instance], thresholds: { reasoningFailures: 0 } }, "reasoningFailures must be a whole number of at least 1"],
    [{ instances: [instance], thresholds: { deadLetterGrowth: "yes" } }, "deadLetterGrowth must be true or false"],
    [{ instances: [instance], thresholds: { reasoningStaleHours: 0 } }, "reasoningStaleHours must be null or a number"],
    [{ instances: [instance], thresholds: { reasoningStaleHours: "6" } }, "reasoningStaleHours must be null or a number"],
    [{ instances: [instance], thresholds: { reasoningStaleHours: Number.POSITIVE_INFINITY } }, "reasoningStaleHours must be null or a number"],
    [{ instances: [{ ...instance, baseUrl: "ftp://localhost" }] }, "must use https"],
    [{ instances: [instance], thresholds: { typo: 1 } }, 'thresholds: unknown field "typo"'],
    [{ instances: [instance], timeoutMs: 99 }, "timeoutMs must be"],
    [{ instances: [instance], timeoutMs: 120_001 }, "timeoutMs must be"],
    [{ instances: [instance], timeoutMs: 1000.5 }, "timeoutMs must be"],
  ])("turns down %j", (raw, message) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    expect(() => parseConfig(raw)).toThrow(message);
  });

  it("turns down a key put in the file, a URL carrying credentials or a query, without echoing them", () => {
    const secret = newKey("k");
    const attempts: [unknown, string][] = [
      [{ instances: [{ ...instance, supportKey: secret }] }, '"supportKey" isn\'t allowed; keys never go in the config'],
      [{ instances: [{ ...instance, apiToken: secret }] }, '"apiToken" isn\'t allowed'],
      [{ instances: [{ ...instance, ["bad key!"]: secret }] }, '"a field" isn\'t allowed'],
      [{ instances: [{ ...instance, ["what?"]: secret }] }, 'unknown field "?"'],
      [{ instances: [{ ...instance, baseUrl: `https://user:${secret}@acme.example.test` }] }, "must not carry a user name or password"],
      [{ instances: [{ ...instance, baseUrl: `https://${secret}@acme.example.test` }] }, "must not carry a user name or password"],
      [{ instances: [{ ...instance, baseUrl: `https://:${secret}@acme.example.test` }] }, "must not carry a user name or password"],
      [{ instances: [{ ...instance, baseUrl: `https://acme.example.test/?key=${secret}` }] }, "must not carry a query string"],
      [{ instances: [{ ...instance, baseUrl: `https://acme.example.test/#${secret}` }] }, "or fragment"],
      [{ instances: [{ ...instance, supportKeyEnv: secret }] }, "not hold the key"],
    ];
    for (const [raw, message] of attempts) {
      let thrown: unknown;
      try {
        parseConfig(raw);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as Error).message).toContain(message);
      expect((thrown as Error).message).not.toContain(secret);
    }
  });

  it("reads NAME=key lines, skipping blanks and comments, and never echoes a bad line", () => {
    const a = newKey("a");
    const b = `${newKey("b")}=tail`;
    expect(parseSupportKeys(`# keys\n\nACME_SUPPORT_KEY=${a}\r\n  BETA_KEY = ${b}  \nEMPTY_KEY=\n`)).toEqual({ ACME_SUPPORT_KEY: a, BETA_KEY: b });
    expect(parseSupportKeys(undefined)).toEqual({});
    for (const bad of [a, `lower=${a}`, `=${a}`]) {
      expect(() => parseSupportKeys(`OK=1\n${bad}`)).toThrow("support keys line 2 must read NAME=key");
      try {
        parseSupportKeys(bad);
      } catch (error) {
        expect((error as Error).message).not.toContain(a);
      }
    }
  });

  it("reads a state file, dropping whatever it doesn't recognize", () => {
    expect(parseState(null)).toEqual({ version: 1, instances: {} });
    expect(parseState({ version: 2, instances: { acme: { checkedAt: hoursAgo(1), deadLetters: 4, connectors: {} } } })).toEqual({ version: 1, instances: {} });
    expect(parseState({ version: 1, instances: [] })).toEqual({ version: 1, instances: {} });
    const state = parseState({
      version: 1,
      instances: {
        acme: { checkedAt: hoursAgo(1), deadLetters: 4, connectors: { stripe: { lastSucceededAt: hoursAgo(2) }, "Bad Id": { lastSucceededAt: hoursAgo(2) }, shopify: { lastSucceededAt: "yesterday" }, square: null } },
        beta: { checkedAt: hoursAgo(1), deadLetters: -3, connectors: [] },
        gamma: { checkedAt: hoursAgo(1), deadLetters: 2.5 },
        "bad name": { checkedAt: hoursAgo(1), deadLetters: 1, connectors: {} },
        delta: { checkedAt: "soon", deadLetters: 1, connectors: {} },
        eps: { deadLetters: 1, connectors: {} },
        zeta: "x",
      },
    });
    expect(state).toEqual({
      version: 1,
      instances: {
        acme: { checkedAt: hoursAgo(1), deadLetters: 4, connectors: { stripe: { lastSucceededAt: hoursAgo(2) } } },
        beta: { checkedAt: hoursAgo(1), deadLetters: null, connectors: {} },
        gamma: { checkedAt: hoursAgo(1), deadLetters: null, connectors: {} },
      },
    });
  });
});

describe("reading the status", () => {
  it("keeps only the fields the rules read", async () => {
    const s = await facts({ deadLetters: [{ source: "shopify", reason: "invalid" }, { source: "Free Text!", reason: "invalid" }, { reason: "invalid" }] });
    expect(s).toEqual({
      version: "0.1.0",
      startedAt: hoursAgo(72),
      uptimeSeconds: 72 * 3600,
      migrations: MIGRATIONS,
      integrations: [
        { id: "stripe", syncing: true, notSyncingReason: null, lastSync: { outcome: "succeeded", finishedAt: hoursAgo(1), error: null } },
        { id: "shopify", syncing: true, notSyncingReason: null, lastSync: { outcome: "succeeded", finishedAt: hoursAgo(2), error: null } },
      ],
      reasoning: { scheduled: true, intervalMinutes: 60, lastSucceededAt: hoursAgo(0.49), consecutiveFailures: 0, lastRun: { outcome: "succeeded", finishedAt: hoursAgo(0.49), error: null } },
      deadLetters: { total: 3, bySource: { shopify: 1, other: 1, unknown: 1 } },
    });
    expect(JSON.stringify(s)).not.toContain("Example Jewelers");
    expect(JSON.stringify(s)).not.toContain("org_example");
  });

  it("reports an instance from before scheduled reasoning, or with it off", async () => {
    expect((await facts({ reasoning: null })).reasoning).toBeNull();
    const body = (await statusBody()) as Record<string, unknown>;
    delete body.reasoning;
    expect(readStatus(body)!.reasoning).toBeNull();
    expect((await facts({ reasoning: { scheduled: false, intervalMinutes: null, lastRun: null, lastSucceededAt: null, consecutiveFailures: 0 } })).reasoning).toEqual({
      scheduled: false,
      intervalMinutes: null,
      lastSucceededAt: null,
      consecutiveFailures: 0,
      lastRun: null,
    });
  });

  it("shows an odd version or id as a placeholder, and cleans error text", async () => {
    const body = (await statusBody({ runs: [run("stripe", "failed", 1, "boom")] })) as { instance: { version: string }; integrations: { id: string; lastSync: { error: string } }[] };
    body.instance.version = "<script>";
    body.integrations[0]!.id = "Stripe Live";
    body.integrations[0]!.lastSync.error = "bad `code`\n ping @maintainers " + "x".repeat(300);
    const s = readStatus(body)!;
    expect(s.version).toBe("unknown");
    expect(s.integrations[0]!.id).toBe("other");
    expect(s.integrations[0]!.lastSync!.error).toMatch(/^bad code ping \(at\)maintainers x+…$/);
    expect(s.integrations[0]!.lastSync!.error!.length).toBe(201);
    expect(cleanText(5)).toBeNull();
    expect(cleanText("abc", 3)).toBe("abc");
    expect(cleanText("abcd", 3)).toBe("abc…");
  });

  it.each<[string, (b: Record<string, any>) => void]>([
    ["not an object", (b) => Object.keys(b).forEach((k) => delete b[k])],
    ["no instance", (b) => delete b.instance],
    ["no migrations", (b) => delete b.migrations],
    ["integrations not a list", (b) => (b.integrations = {})],
    ["no dead letters", (b) => delete b.deadLetters],
    ["a bad start time", (b) => (b.instance.startedAt = "soon")],
    ["a bad uptime", (b) => (b.instance.uptimeSeconds = -1)],
    ["applied not a list", (b) => (b.migrations.applied = "all")],
    ["a bad dead-letter total", (b) => (b.deadLetters.total = "3")],
    ["an integration that isn't an object", (b) => (b.integrations[0] = "stripe")],
    ["an integration without syncing", (b) => delete b.integrations[0].syncing],
    ["a last sync with a bad outcome", (b) => (b.integrations[0].lastSync.outcome = "ok")],
    ["a last sync with no finish time", (b) => delete b.integrations[0].lastSync.finishedAt],
    ["reasoning that isn't an object", (b) => (b.reasoning = "on")],
    ["reasoning without scheduled", (b) => delete b.reasoning.scheduled],
    ["reasoning with a bad last run", (b) => (b.reasoning.lastRun = { outcome: "failed" })],
    ["reasoning with a bad failure count", (b) => (b.reasoning.consecutiveFailures = 1.5)],
  ])("turns down a status with %s", async (_, change) => {
    const body = (await statusBody()) as Record<string, any>;
    change(body);
    expect(readStatus(body)).toBeNull();
  });

  it("turns down what isn't a status at all", () => {
    for (const body of [null, undefined, "ok", [], { status: "ok" }]) expect(readStatus(body)).toBeNull();
  });

  it("skips dead-letter counts that aren't counts, and a reasoning interval that isn't one", async () => {
    const body = (await statusBody()) as Record<string, any>;
    body.deadLetters.bySource = { shopify: 2, stripe: "x", square: -1, acuity: 0 };
    body.reasoning.intervalMinutes = 0;
    const s = readStatus(body)!;
    expect(s.deadLetters.bySource).toEqual({ shopify: 2, acuity: 0 });
    expect(s.reasoning!.intervalMinutes).toBeNull();
    body.deadLetters.bySource = null;
    expect(readStatus(body)!.deadLetters.bySource).toEqual({});
  });

  it("says how long ago in minutes, hours or days", () => {
    expect(ago(-5)).toBe("0m");
    expect(ago(-HOUR)).toBe("0m");
    expect(ago(59 * 60_000)).toBe("59m");
    expect(ago(HOUR)).toBe("1h");
    expect(ago(47 * HOUR)).toBe("47h");
    expect(ago(48 * HOUR)).toBe("2d");
  });
});

describe("rules", () => {
  it("finds nothing wrong with a healthy instance", async () => {
    const { problems, state } = evaluate(await facts(), t(), NOW, undefined, MIGRATIONS);
    expect(problems).toEqual([]);
    expect(state).toEqual({ checkedAt: NOW.toISOString(), deadLetters: 0, connectors: { stripe: { lastSucceededAt: hoursAgo(1) }, shopify: { lastSucceededAt: hoursAgo(2) } } });
  });

  it("flags a connector whose last run failed, with its scrubbed error", async () => {
    const { problems, state } = evaluate(await facts({ startedHoursAgo: 10, runs: [run("stripe", "failed", 3, "vendor answered 500"), run("shopify", "succeeded", 1)] }), t(), NOW, undefined);
    expect(problems).toEqual([{ code: "connector_failed", subject: "stripe", message: "stripe: last sync failed 3h ago: vendor answered 500" }]);
    expect(state.connectors).toEqual({ shopify: { lastSucceededAt: hoursAgo(1) } });
    const silent = evaluate(await facts({ startedHoursAgo: 10, runs: [run("stripe", "failed", 3), run("shopify", "succeeded", 1)] }), t(), NOW, undefined);
    expect(silent.problems[0]!.message).toBe("stripe: last sync failed 3h ago");
  });

  it("flags a connector whose last successful sync is older than the threshold, and not one just inside it", async () => {
    const s = await facts({ runs: [run("stripe", "succeeded", 25), run("shopify", "succeeded", 23.9)] });
    expect(evaluate(s, t(), NOW, undefined).problems).toEqual([{ code: "connector_stale", subject: "stripe", message: "stripe: last successful sync 25h ago (limit 24h)" }]);
    expect(evaluate(s, t({ syncStaleHours: 26 }), NOW, undefined).problems).toEqual([]);
    expect(codes(evaluate(s, t({ syncStaleHours: 2 }), NOW, undefined).problems)).toEqual(["connector_stale:stripe", "connector_stale:shopify"]);
  });

  it("flags a connector with no success since a start longer ago than the threshold, but not on a fresh start", async () => {
    const old = await facts({ runs: [], startedHoursAgo: 30 });
    expect(evaluate(old, t(), NOW, undefined).problems).toEqual([
      { code: "connector_stale", subject: "stripe", message: "stripe: no successful sync in the 30h since the instance started (limit 24h)" },
      { code: "connector_stale", subject: "shopify", message: "shopify: no successful sync in the 30h since the instance started (limit 24h)" },
    ]);
    expect(evaluate(await facts({ runs: [], startedHoursAgo: 2 }), t(), NOW, undefined).problems).toEqual([]);
    expect(evaluate(await facts({ runs: [], startedHoursAgo: 24 }), t(), NOW, undefined).problems).toEqual([]);
  });

  it("remembers a connector's last success across an instance restart", async () => {
    const previous: InstanceState = { checkedAt: hoursAgo(1), deadLetters: 0, connectors: { stripe: { lastSucceededAt: hoursAgo(30) }, shopify: { lastSucceededAt: hoursAgo(5) } } };
    // Restarted an hour ago; stripe has failed since and shopify has succeeded since.
    const s = await facts({ startedHoursAgo: 1, runs: [run("stripe", "failed", 0.5, "timeout"), run("shopify", "succeeded", 0.5)] });
    const { problems, state } = evaluate(s, t(), NOW, previous);
    expect(codes(problems)).toEqual(["connector_failed:stripe", "connector_stale:stripe"]);
    expect(problems[1]!.message).toBe("stripe: last successful sync 30h ago (limit 24h)");
    // The newer success wins.
    expect(state.connectors).toEqual({ stripe: { lastSucceededAt: hoursAgo(30) }, shopify: { lastSucceededAt: hoursAgo(0.5) } });
  });

  it("flags a connector enabled but missing settings, and not one with nothing to sync", async () => {
    const s = await facts({
      enabled: ["stripe", "shopify", "gia"],
      skipped: [
        { id: "shopify", reason: "missing SHOPIFY_SHOP_DOMAIN" },
        { id: "gia", reason: "no connector to sync yet" },
      ],
      runs: [run("stripe", "succeeded", 1)],
    });
    expect(evaluate(s, t(), NOW, undefined).problems).toEqual([{ code: "connector_not_syncing", subject: "shopify", message: "shopify is enabled but not syncing: missing SHOPIFY_SHOP_DOMAIN" }]);
  });

  it("flags dead letters above the threshold, naming the top sources, and not at it", async () => {
    const letters = [...Array(3)].map(() => ({ source: "shopify", reason: "invalid" })).concat([{ source: "stripe", reason: "invalid" }, { source: "square", reason: "x" }, { source: "acuity", reason: "x" }]);
    const s = await facts({ deadLetters: letters });
    expect(evaluate(s, t({ deadLetters: 5 }), NOW, undefined).problems).toEqual([{ code: "dead_letters_high", subject: null, message: "6 dead letters (limit 5); most from shopify 3, acuity 1, square 1" }]);
    expect(evaluate(s, t({ deadLetters: 6 }), NOW, undefined).problems).toEqual([]);
    const body = (await statusBody()) as Record<string, any>;
    body.deadLetters.total = 7;
    expect(evaluate(readStatus(body)!, t({ deadLetters: 5 }), NOW, undefined).problems[0]!.message).toBe("7 dead letters (limit 5)");
  });

  it("flags dead letters growing since the last check, when there is one and growth is watched", async () => {
    const s = await facts({ deadLetters: [{ source: "shopify", reason: "x" }, { source: "shopify", reason: "x" }] });
    const previous = (n: number | null): InstanceState => ({ checkedAt: hoursAgo(1), deadLetters: n, connectors: {} });
    expect(evaluate(s, t(), NOW, previous(1)).problems).toEqual([{ code: "dead_letters_growing", subject: null, message: `dead letters rose by 1 to 2 since the check at ${hoursAgo(1)}` }]);
    expect(evaluate(s, t(), NOW, previous(2)).problems).toEqual([]);
    expect(evaluate(s, t(), NOW, previous(5)).problems).toEqual([]);
    expect(evaluate(s, t(), NOW, previous(0)).problems).toHaveLength(1);
    expect(evaluate(s, t(), NOW, previous(null)).problems).toEqual([]);
    expect(evaluate(s, t(), NOW, undefined).problems).toEqual([]);
    expect(evaluate(s, t({ deadLetterGrowth: false }), NOW, previous(1)).problems).toEqual([]);
  });

  it("flags an instance with no migrations, or missing expected ones", async () => {
    expect(evaluate(await facts({ migrations: [] }), t(), NOW, undefined, MIGRATIONS).problems).toEqual([{ code: "migrations_none", subject: null, message: "no database migrations are applied" }]);
    const s = await facts({ migrations: ["0001_core.sql"] });
    expect(evaluate(s, t(), NOW, undefined, MIGRATIONS).problems).toEqual([{ code: "migrations_missing", subject: null, message: "1 migration not applied: 0002_ingestion.sql" }]);
    expect(evaluate(s, t(), NOW, undefined).problems).toEqual([]);
    const many = ["0001_core.sql", ...[...Array(7)].map((_, i) => `000${i + 2}_m.sql`)];
    expect(evaluate(s, t(), NOW, undefined, many).problems[0]!.message).toBe("7 migrations not applied: 0002_m.sql, 0003_m.sql, 0004_m.sql, 0005_m.sql, 0006_m.sql, …");
    expect(evaluate(s, t(), NOW, undefined, many.slice(0, 6)).problems[0]!.message).toBe("5 migrations not applied: 0002_m.sql, 0003_m.sql, 0004_m.sql, 0005_m.sql, 0006_m.sql");
    // Migrations the instance has that this monitor doesn't know are fine: the instance is newer.
    expect(evaluate(await facts({ migrations: [...MIGRATIONS, "0003_new.sql"] }), t(), NOW, undefined, MIGRATIONS).problems).toEqual([]);
  });

  const reasoning = (over: Partial<SupportReasoningStatus>): SupportReasoningStatus => ({ ...goodReasoning(), ...over });
  const failedRun = { trigger: "interval" as const, outcome: "failed" as const, startedAt: hoursAgo(0.2), finishedAt: hoursAgo(0.19), recommendations: null, measured: null, error: "TypeError" };

  it("flags scheduled reasoning failing the threshold's runs in a row, and not one fewer", async () => {
    const three = await facts({ reasoning: reasoning({ consecutiveFailures: 3, lastRun: failedRun }) });
    expect(evaluate(three, t(), NOW, undefined).problems).toEqual([{ code: "reasoning_failing", subject: null, message: "scheduled reasoning failed 3 runs in a row (TypeError)" }]);
    expect(evaluate(await facts({ reasoning: reasoning({ consecutiveFailures: 2, lastRun: failedRun }) }), t(), NOW, undefined).problems).toEqual([]);
    expect(evaluate(three, t({ reasoningFailures: 4 }), NOW, undefined).problems).toEqual([]);
    const noError = await facts({ reasoning: reasoning({ consecutiveFailures: 3, lastRun: { ...failedRun, error: null } }) });
    expect(evaluate(noError, t(), NOW, undefined).problems[0]!.message).toBe("scheduled reasoning failed 3 runs in a row");
    const succeededLast = await facts({ reasoning: reasoning({ consecutiveFailures: 3, lastRun: { ...goodReasoning().lastRun!, error: "Leftover" } }) });
    expect(evaluate(succeededLast, t(), NOW, undefined).problems[0]!.message).toBe("scheduled reasoning failed 3 runs in a row");
  });

  it("flags scheduled reasoning with no success for three intervals, at least an hour, or the set limit", async () => {
    const at = (h: number, interval = 60) => facts({ reasoning: reasoning({ lastSucceededAt: hoursAgo(h), intervalMinutes: interval }) });
    expect(evaluate(await at(3.1), t(), NOW, undefined).problems).toEqual([{ code: "reasoning_stale", subject: null, message: "scheduled reasoning last succeeded 3h ago (limit 3h)" }]);
    expect(evaluate(await at(2.9), t(), NOW, undefined).problems).toEqual([]);
    // A 5-minute interval still allows an hour.
    expect(evaluate(await at(0.9, 5), t(), NOW, undefined).problems).toEqual([]);
    expect(codes(evaluate(await at(1.1, 5), t(), NOW, undefined).problems)).toEqual(["reasoning_stale:"]);
    expect(evaluate(await at(2.9), t({ reasoningStaleHours: 2 }), NOW, undefined).problems).toHaveLength(1);
    expect(evaluate(await at(3.1), t({ reasoningStaleHours: 4 }), NOW, undefined).problems).toEqual([]);
    // No interval reported: an hour's interval is assumed.
    const body = (await statusBody({ reasoning: reasoning({ lastSucceededAt: hoursAgo(3.1) }) })) as Record<string, any>;
    body.reasoning.intervalMinutes = null;
    expect(codes(evaluate(readStatus(body)!, t(), NOW, undefined).problems)).toEqual(["reasoning_stale:"]);
    body.reasoning.lastSucceededAt = hoursAgo(2.9);
    expect(evaluate(readStatus(body)!, t(), NOW, undefined).problems).toEqual([]);
  });

  it("counts reasoning's staleness from the start when it hasn't succeeded yet, and ignores it when off", async () => {
    const never = { lastSucceededAt: null, lastRun: null };
    expect(evaluate(await facts({ startedHoursAgo: 4, reasoning: reasoning(never) }), t(), NOW, undefined).problems).toEqual([
      { code: "reasoning_stale", subject: null, message: "scheduled reasoning hasn't succeeded in the 4h since the instance started (limit 3h)" },
    ]);
    expect(evaluate(await facts({ startedHoursAgo: 2, reasoning: reasoning(never) }), t(), NOW, undefined).problems).toEqual([]);
    const off = { scheduled: false, intervalMinutes: null, lastRun: null, lastSucceededAt: null, consecutiveFailures: 9 };
    expect(evaluate(await facts({ reasoning: off }), t(), NOW, undefined).problems).toEqual([]);
    expect(evaluate(await facts({ reasoning: null }), t(), NOW, undefined).problems).toEqual([]);
  });

  it("has advice for every problem", () => {
    for (const advice of Object.values(ADVICE)) expect(advice.length).toBeGreaterThan(20);
  });
});

/** A fetch that answers each URL path from a table; a function entry can throw or wait. */
function fakeFetch(routes: Record<string, (init: RequestInit) => Response | Promise<Response>>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname.replace(/^\/brain/, "");
    const route = routes[path];
    if (!route) return new Response("not found", { status: 404 });
    return route(init);
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const networkError = () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
};

const acme: InstanceConfig = { name: "acme", baseUrl: "https://acme.example.test/brain/", supportKeyEnv: "ACME_SUPPORT_KEY", thresholds: DEFAULT_THRESHOLDS };

describe("checking an instance", () => {
  const options = (fetch: Fetch, over: Partial<Parameters<typeof checkInstance>[2]> = {}) => ({ fetch, now: () => NOW, timeoutMs: 50, retryDelayMs: 0, ...over });

  it("reads /healthz without the key and the status with it, and reports a healthy instance", async () => {
    const key = newKey("s");
    const body = await statusBody();
    const { fetch, calls } = fakeFetch({ "/healthz": () => json({ status: "ok" }), "/v1/support/status": () => json(body) });
    const { result, state } = await checkInstance(acme, key, options(fetch));
    expect(result).toEqual({
      name: "acme",
      origin: "https://acme.example.test",
      healthy: true,
      checkedAt: NOW.toISOString(),
      problems: [],
      summary: { version: "0.1.0", uptimeSeconds: 72 * 3600, connectorsSyncing: 2, deadLetters: 0, migrations: 2, reasoning: "ok" },
    });
    expect(state?.deadLetters).toBe(0);
    expect(calls.map((c) => c.url)).toEqual(["https://acme.example.test/brain/healthz", "https://acme.example.test/brain/v1/support/status?days=1"]);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`);
    for (const c of calls) {
      expect(c.init.redirect).toBe("manual");
      expect(c.init.method).toBe("GET");
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("counts only syncing connectors, and says reasoning is ok when only something else is wrong", async () => {
    const body = await statusBody({ enabled: ["stripe", "shopify", "gia"], skipped: [{ id: "gia", reason: "no connector to sync yet" }], deadLetters: [{ reason: "x" }, { reason: "x" }] });
    const instance = { ...acme, thresholds: { ...DEFAULT_THRESHOLDS, deadLetters: 1 } };
    const { result } = await checkInstance(instance, "k", options(fakeFetch({ "/healthz": () => json({}), "/v1/support/status": () => json(body) }).fetch));
    expect(codes(result.problems)).toEqual(["dead_letters_high:"]);
    expect(result.summary).toMatchObject({ connectorsSyncing: 2, reasoning: "ok", deadLetters: 2 });
  });

  it("summarizes reasoning as off, failing or not reported", async () => {
    const off = await statusBody({ reasoning: { scheduled: false, intervalMinutes: null, lastRun: null, lastSucceededAt: null, consecutiveFailures: 0 } });
    const failing = await statusBody({ reasoning: { ...goodReasoning(), consecutiveFailures: 5 } });
    const none = await statusBody({ reasoning: null });
    const summaryOf = async (body: unknown) => (await checkInstance(acme, "k", options(fakeFetch({ "/healthz": () => json({}), "/v1/support/status": () => json(body) }).fetch))).result.summary!.reasoning;
    expect(await summaryOf(off)).toBe("off");
    expect(await summaryOf(failing)).toBe("failing");
    expect(await summaryOf(none)).toBe("not reported");
  });

  it("reports a missing key without calling the instance", async () => {
    const { fetch, calls } = fakeFetch({});
    const previous: InstanceState = { checkedAt: hoursAgo(1), deadLetters: 3, connectors: {} };
    const { result, state } = await checkInstance(acme, undefined, options(fetch, { previous }));
    expect(result.problems).toEqual([{ code: "key_missing", subject: null, message: "ACME_SUPPORT_KEY isn't set, so the status can't be read" }]);
    expect(result.healthy).toBe(false);
    expect(result.summary).toBeNull();
    expect(state).toBe(previous);
    expect(calls).toEqual([]);
  });

  it("calls an instance unreachable after one retry, keeping the last state", async () => {
    const { fetch, calls } = fakeFetch({ "/healthz": networkError });
    const previous: InstanceState = { checkedAt: hoursAgo(1), deadLetters: 3, connectors: {} };
    const { result, state } = await checkInstance(acme, "k", options(fetch, { previous }));
    expect(result.problems).toEqual([{ code: "unreachable", subject: null, message: "GET /healthz: network error (ECONNRESET), after one retry" }]);
    expect(calls).toHaveLength(2);
    expect(state).toBe(previous);
  });

  it("retries once and goes on when the second try answers", async () => {
    let n = 0;
    const body = await statusBody();
    const { fetch, calls } = fakeFetch({ "/healthz": () => (n++ === 0 ? networkError() : json({ status: "ok" })), "/v1/support/status": () => json(body) });
    expect((await checkInstance(acme, "k", options(fetch))).result.healthy).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("retries the status request too, and reports it unreachable after the retry", async () => {
    const { fetch, calls } = fakeFetch({ "/healthz": () => json({}), "/v1/support/status": () => networkError() });
    expect((await checkInstance(acme, "k", options(fetch))).result.problems).toEqual([{ code: "unreachable", subject: null, message: "GET /v1/support/status: network error (ECONNRESET), after one retry" }]);
    expect(calls).toHaveLength(3);
  });

  it("times out a request that doesn't answer, then retries it", async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const { fetch, calls } = fakeFetch({ "/healthz": hang });
    const started = Date.now();
    const { result } = await checkInstance(acme, "k", options(fetch, { timeoutMs: 30 }));
    expect(result.problems).toEqual([{ code: "unreachable", subject: null, message: "GET /healthz: no answer within 30ms, after one retry" }]);
    expect(calls).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("waits before the retry", async () => {
    const { fetch } = fakeFetch({ "/healthz": networkError });
    const started = Date.now();
    await checkInstance(acme, "k", options(fetch, { retryDelayMs: 60 }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it("never retries an HTTP answer, and reports /healthz's status", async () => {
    for (const status of [500, 302, 404]) {
      const { fetch, calls } = fakeFetch({ "/healthz": () => new Response("down", { status }) });
      const { result } = await checkInstance(acme, "k", options(fetch));
      expect(result.problems).toEqual([{ code: "healthz_status", subject: null, message: `GET /healthz answered ${status}` }]);
      expect(calls).toHaveLength(1);
    }
  });

  it("never reads the body of an answer that isn't 200, and calls a redirect what it is", async () => {
    const broken = () => new ReadableStream({ pull: (c) => c.error(new Error("body cut off")) });
    const { fetch, calls } = fakeFetch({ "/healthz": () => json({}), "/v1/support/status": () => new Response(broken(), { status: 503 }) });
    expect((await checkInstance(acme, "k", options(fetch))).result.problems).toEqual([{ code: "status_http", subject: null, message: "GET /v1/support/status answered 503 (support status isn't set up)" }]);
    expect(calls).toHaveLength(2);
    const moved = fakeFetch({ "/healthz": () => json({}), "/v1/support/status": () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.test/" } }) });
    expect((await checkInstance(acme, "k", options(moved.fetch))).result.problems).toEqual([{ code: "status_http", subject: null, message: "GET /v1/support/status answered 302" }]);
  });

  it("reads JSON up to the size cap and no further", async () => {
    const cap = 2 * 1024 * 1024;
    const sized = (n: number) => `{"a":"${"x".repeat(n - 8)}"}`;
    expect(sized(cap)).toHaveLength(cap);
    expect((await get(async () => new Response(sized(cap)), "https://acme.example.test/healthz", {}, 1000, 0)).body).toEqual({ a: "x".repeat(cap - 8) });
    expect(await get(async () => new Response(sized(cap + 1)), "https://acme.example.test/healthz", {}, 1000, 0)).toEqual({ status: 200, body: undefined });
  });

  it.each([
    [401, "GET /v1/support/status answered 401 (the support key was turned down)"],
    [503, "GET /v1/support/status answered 503 (support status isn't set up)"],
    [403, "GET /v1/support/status answered 403"],
    [500, "GET /v1/support/status answered 500"],
  ])("reports a status answer of %i without its body", async (status, message) => {
    const secretBody = newKey("body");
    const { fetch } = fakeFetch({ "/healthz": () => json({}), "/v1/support/status": () => json({ error: secretBody }, status) });
    const { result } = await checkInstance(acme, "k", options(fetch));
    expect(result.problems).toEqual([{ code: "status_http", subject: null, message }]);
    expect(JSON.stringify(result)).not.toContain(secretBody);
  });

  it("reports a status that isn't JSON, is too large or isn't a status", async () => {
    for (const make of [() => new Response("<html>"), () => new Response(`"${"x".repeat(2 * 1024 * 1024 + 1)}"`), () => json({ status: "ok" }), () => new Response("")]) {
      const { fetch } = fakeFetch({ "/healthz": () => json({}), "/v1/support/status": make });
      expect((await checkInstance(acme, "k", options(fetch))).result.problems).toEqual([
        { code: "status_unreadable", subject: null, message: "GET /v1/support/status answered with something that isn't a support status" },
      ]);
    }
  });

  it("says network error without a code it can't trust, and rethrows what isn't a network error", async () => {
    const odd: Fetch = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "has spaces in it" } });
    };
    await expect(get(odd, "https://acme.example.test/healthz", {}, 50, 0)).rejects.toThrow(/^network error$/);
    const plain: Fetch = async () => {
      throw "nope";
    };
    await expect(get(plain, "https://acme.example.test/healthz", {}, 50, 0)).rejects.toThrow(/^network error$/);
    const answered = await get(async () => json({ a: 1 }), "https://acme.example.test/healthz", {}, 50, 0);
    expect(answered).toEqual({ status: 200, body: { a: 1 } });
  });
});

describe("a run over every instance", () => {
  it("takes each key from its variable or the NAME=key list, carries state forward and keeps it for one that can't be reached", async () => {
    const a = newKey("a");
    const b = newKey("b");
    const body = await statusBody({ deadLetters: [{ source: "shopify", reason: "x" }] });
    const seen: string[] = [];
    const fetch: Fetch = async (url, init) => {
      const auth = (init.headers as Record<string, string>).authorization;
      if (auth) seen.push(auth);
      if (url.startsWith("https://beta.example.test")) networkError();
      return url.includes("healthz") ? json({}) : json(body);
    };
    const config = parseConfig({
      instances: [
        { name: "acme", baseUrl: "https://acme.example.test", supportKeyEnv: "ACME_KEY" },
        { name: "beta", baseUrl: "https://beta.example.test", supportKeyEnv: "BETA_KEY" },
        { name: "gamma", baseUrl: "https://gamma.example.test", supportKeyEnv: "GAMMA_KEY" },
      ],
    });
    const before = { version: 1 as const, instances: { acme: { checkedAt: hoursAgo(1), deadLetters: 0, connectors: {} }, beta: { checkedAt: hoursAgo(1), deadLetters: 9, connectors: {} } } };
    const { run: result, state, keys } = await runMonitor(config, { env: { ACME_KEY: a, BETA_KEY: "" }, supportKeys: { ACME_KEY: "ignored", BETA_KEY: b }, fetch, now: () => NOW, state: before, retryDelayMs: 0 });
    expect(seen).toEqual([`Bearer ${a}`]);
    expect(keys).toEqual([a, b]);
    expect(result.healthy).toBe(false);
    expect(result.checkedAt).toBe(NOW.toISOString());
    expect(result.instances.map((i) => [i.name, codes(i.problems)])).toEqual([
      ["acme", ["dead_letters_growing:"]],
      ["beta", ["unreachable:"]],
      ["gamma", ["key_missing:"]],
    ]);
    expect(state.instances.acme!.deadLetters).toBe(1);
    expect(state.instances.beta).toEqual(before.instances.beta);
    expect(state.instances.gamma).toBeUndefined();
    expect(before.instances.acme.deadLetters).toBe(0);
  });

  it("passes expected migrations through, and runs without state", async () => {
    const body = await statusBody();
    const fetch: Fetch = async (url) => (url.includes("healthz") ? json({}) : json(body));
    const config = parseConfig({ instances: [{ name: "acme", baseUrl: "https://acme.example.test", supportKeyEnv: "ACME_KEY" }] });
    const missing = await runMonitor(config, { env: { ACME_KEY: "k" }, fetch, now: () => NOW, expectedMigrations: [...MIGRATIONS, "0003_x.sql"] });
    expect(codes(missing.run.instances[0]!.problems)).toEqual(["migrations_missing:"]);
    const fine = await runMonitor(config, { env: { ACME_KEY: "k" }, fetch, now: () => NOW });
    expect(fine.run.healthy).toBe(true);
    expect(fine.state.instances.acme!.checkedAt).toBe(NOW.toISOString());
  });
});

const result = (name: string, problems: Problem[]): InstanceResult => ({
  name,
  origin: `https://${name}.example.test`,
  healthy: problems.length === 0,
  checkedAt: NOW.toISOString(),
  problems,
  summary: problems.length ? null : { version: "0.1.0", uptimeSeconds: 7200, connectorsSyncing: 2, deadLetters: 0, migrations: 10, reasoning: "ok" },
});
const failed: Problem = { code: "connector_failed", subject: "stripe", message: "stripe: last sync failed 3h ago" };
const high: Problem = { code: "dead_letters_high", subject: null, message: "140 dead letters (limit 100)" };
const runOf = (...instances: InstanceResult[]): MonitorRun => ({ checkedAt: NOW.toISOString(), healthy: instances.every((i) => i.healthy), instances });

describe("the report", () => {
  it("is short: one line for a healthy instance, its problems for one that isn't", () => {
    expect(renderReport(runOf(result("acme", []), result("beta", [failed, high])))).toBe(
      [
        `Instance monitor, ${NOW.toISOString()}: 1 of 2 needs attention`,
        "",
        "ok    acme (https://acme.example.test): v0.1.0, up 2h, 2 syncing, 0 dead letters, reasoning ok",
        "FAIL  beta (https://beta.example.test)",
        "      - stripe: last sync failed 3h ago",
        "      - 140 dead letters (limit 100)",
        "",
      ].join("\n"),
    );
    expect(renderReport(runOf(result("acme", []))).split("\n")[0]).toBe(`Instance monitor, ${NOW.toISOString()}: all 1 healthy`);
    expect(renderReport(runOf(result("acme", [high]), result("beta", [failed]))).split("\n")[0]).toBe(`Instance monitor, ${NOW.toISOString()}: 2 of 2 need attention`);
  });

  it("redacts every key wherever it appears, longest first, and leaves short strings alone", () => {
    const a = newKey("a");
    expect(redact(`x ${a} y ${a}`, [a])).toBe("x [redacted] y [redacted]");
    expect(redact(`${a}tail`, [a.slice(0, 10), a])).toBe("[redacted]tail");
    expect(redact("abc ab", ["abc"])).toBe("abc ab");
    expect(redact("abcd", ["abcd"])).toBe("[redacted]");
  });
});

/** An issue tracker in memory, recording every call. */
function memoryTracker(seed: { number: number; title: string; body: string }[] = []) {
  const issues = seed.map((i) => ({ ...i, open: true, comments: [] as string[] }));
  const log: string[] = [];
  const tracker: IssueTracker = {
    async findOpen(marker): Promise<TrackedIssue | null> {
      const found = issues.find((i) => i.open && i.body.includes(marker));
      return found ? { number: found.number, body: found.body } : null;
    },
    async open(title, body) {
      const number = 100 + issues.length;
      issues.push({ number, title, body, open: true, comments: [] });
      log.push(`open #${number}`);
      return number;
    },
    async comment(n, body) {
      issues.find((i) => i.number === n)!.comments.push(body);
      log.push(`comment #${n}`);
    },
    async update(n, body) {
      issues.find((i) => i.number === n)!.body = body;
      log.push(`update #${n}`);
    },
    async close(n, comment) {
      const issue = issues.find((i) => i.number === n)!;
      issue.comments.push(comment);
      issue.open = false;
      log.push(`close #${n}`);
    },
  };
  return { tracker, issues, log };
}

describe("issues", () => {
  it("opens one issue per instance that needs attention, with a fixed title, the problems and what to do", async () => {
    const { tracker, issues, log } = memoryTracker();
    expect(await syncIssues(runOf(result("acme", [failed, high]), result("beta", [])), tracker)).toEqual([
      { name: "acme", action: "opened", issue: 100 },
      { name: "beta", action: "none", issue: null },
    ]);
    expect(log).toEqual(["open #100"]);
    expect(issues[0]!.title).toBe("Instance monitor: acme needs attention");
    expect(issueTitle("acme")).toBe(issues[0]!.title);
    expect(issues[0]!.body).toContain(issueMarker("acme"));
    expect(issues[0]!.body).toContain("- `connector_failed` stripe: last sync failed 3h ago");
    expect(issues[0]!.body).toContain(`- **dead_letters_high**: ${ADVICE.dead_letters_high}`);
    expect(issues[0]!.body).not.toContain("example.test");
  });

  it("leaves the issue alone while the same things are wrong, even as the times in the messages move", async () => {
    const { tracker, log } = memoryTracker([{ number: 7, title: issueTitle("acme"), body: issueBody(result("acme", [failed])) }]);
    const later = { ...failed, message: "stripe: last sync failed 5h ago" };
    expect(await syncIssues(runOf(result("acme", [later])), tracker)).toEqual([{ name: "acme", action: "unchanged", issue: 7 }]);
    expect(log).toEqual([]);
  });

  it("comments and refreshes the body when what's wrong changes, instead of opening another", async () => {
    const { tracker, issues, log } = memoryTracker([{ number: 7, title: issueTitle("acme"), body: issueBody(result("acme", [failed])) }]);
    expect(await syncIssues(runOf(result("acme", [failed, high])), tracker)).toEqual([{ name: "acme", action: "commented", issue: 7 }]);
    expect(log).toEqual(["comment #7", "update #7"]);
    expect(issues[0]!.comments[0]).toContain("What's wrong changed");
    expect(issues[0]!.comments[0]).toContain("140 dead letters");
    expect(issues[0]!.body).toBe(issueBody(result("acme", [failed, high])));
    // And the next identical run leaves it.
    expect((await syncIssues(runOf(result("acme", [failed, high])), tracker))[0]!.action).toBe("unchanged");
  });

  it("closes the issue when the instance is healthy again, and opens a new one if it breaks later", async () => {
    const { tracker, issues, log } = memoryTracker([{ number: 7, title: issueTitle("acme"), body: issueBody(result("acme", [failed])) }]);
    expect(await syncIssues(runOf(result("acme", [])), tracker)).toEqual([{ name: "acme", action: "closed", issue: 7 }]);
    expect(issues[0]!.comments[0]).toContain("acme is healthy again");
    expect((await syncIssues(runOf(result("acme", [failed])), tracker))[0]).toEqual({ name: "acme", action: "opened", issue: 101 });
    expect(log).toEqual(["close #7", "open #101"]);
  });

  it("never mistakes one instance's issue for another whose name starts the same", async () => {
    const { tracker, log } = memoryTracker([{ number: 7, title: issueTitle("acme-2"), body: issueBody(result("acme-2", [failed])) }]);
    expect(await syncIssues(runOf(result("acme", [failed])), tracker)).toEqual([{ name: "acme", action: "opened", issue: 101 }]);
    expect(await syncIssues(runOf(result("acme", [])), memoryTracker([{ number: 7, title: "", body: issueBody(result("acme-2", [failed])) }]).tracker)).toEqual([
      { name: "acme", action: "none", issue: null },
    ]);
    expect(log).toEqual(["open #101"]);
  });

  it("fingerprints by what is wrong, not when or in what order", () => {
    expect(fingerprint([failed, high])).toBe(fingerprint([high, { ...failed, message: "other" }]));
    expect(fingerprint([failed])).not.toBe(fingerprint([{ ...failed, subject: "shopify" }]));
    expect(fingerprint([failed])).not.toBe(fingerprint([{ ...failed, code: "connector_stale" }]));
    expect(fingerprint([failed])).toMatch(/^[0-9a-f]{16}$/);
  });

  it("talks to GitHub with the token only in the authorization header, under the monitor's label", async () => {
    const token = newKey("t");
    const calls: { url: string; method: string; body: unknown; auth: string }[] = [];
    let open: { number: number; body: string }[] = [];
    const fetch = (async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init.method ?? "GET", body, auth: (init.headers as Record<string, string>).authorization! });
      if (url.includes("/issues?state=open")) return json(open);
      if (url.endsWith("/issues")) return json({ number: 12 });
      return json({});
    }) as typeof globalThis.fetch;
    const tracker = gitHubIssueTracker({ repo: "example/ops", token, labels: ["instance-monitor"], fetch });
    await syncIssues(runOf(result("acme", [failed])), tracker);
    open = [{ number: 12, body: issueBody(result("acme", [failed])) }];
    await syncIssues(runOf(result("acme", [failed, high])), tracker);
    await syncIssues(runOf(result("acme", [])), tracker);
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.github.com/repos/example/ops", "")}`)).toEqual([
      "GET /issues?state=open&labels=instance-monitor&per_page=100&page=1",
      "POST /issues",
      "GET /issues?state=open&labels=instance-monitor&per_page=100&page=1",
      "POST /issues/12/comments",
      "PATCH /issues/12",
      "GET /issues?state=open&labels=instance-monitor&per_page=100&page=1",
      "POST /issues/12/comments",
      "PATCH /issues/12",
    ]);
    expect(calls[1]!.body).toMatchObject({ title: "Instance monitor: acme needs attention", labels: ["instance-monitor"] });
    expect(calls.at(-1)!.body).toEqual({ state: "closed", state_reason: "completed" });
    for (const c of calls) {
      expect(c.auth).toBe(`Bearer ${token}`);
      expect(c.url).not.toContain(token);
      expect(JSON.stringify(c.body ?? "")).not.toContain(token);
    }
  });
});

describe("the command", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers = [];
  });

  async function serve(listener: RequestListener): Promise<string> {
    const server = createServer(listener);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function cli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("MONITOR_") && !k.startsWith("GITHUB_")));
      execFile(process.execPath, ["--import", "tsx", "scripts/instance-monitor-cli.ts", ...args], { cwd: root, env: { ...clean, ...env } }, (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
      );
    });
  }

  /** A real instance app, as main.ts builds it, with a support key. */
  async function instance(supportKey: string, syncStatus: SyncStatus[]) {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [], documentation: new StaticDocumentationSource(["doc_arch"]) });
    const support: SupportStatusOptions = {
      instanceName: "Example Jewelers",
      version: "0.1.0",
      startedAt: new Date(Date.now() - 2 * HOUR),
      retentionDays: 30,
      departments: ["sales"],
      enabledIntegrations: ["stripe"],
      syncStatus: () => syncStatus,
      reasoning: () => ({ scheduled: true, intervalMinutes: 60, lastRun: null, lastSucceededAt: new Date().toISOString(), consecutiveFailures: 0 }),
      diagnostics: inMemoryDiagnostics(memory, MIGRATIONS),
    };
    return serve(createBrainApp({ pipeline, memory, organizationId: "org_example", apiKey: newKey("i"), supportApiKey: supportKey, integrations: [] as IntegrationStatus[], support }));
  }

  it("checks a real instance: exit 0 when healthy, 1 when not, writing the JSON, the state and the job outputs", async () => {
    const key = newKey("s");
    const now = new Date().toISOString();
    const healthy = await instance(key, [{ id: "stripe", mode: "incremental", outcome: "succeeded", startedAt: now, finishedAt: now }]);
    const broken = await instance(key, [{ id: "stripe", mode: "incremental", outcome: "failed", startedAt: now, finishedAt: now, error: `vendor said no to ${key}` }]);
    const dir = await mkdtemp(join(tmpdir(), "monitor-"));
    const config = join(dir, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        timeoutMs: 2000,
        instances: [
          { name: "acme", baseUrl: healthy, supportKeyEnv: "ACME_KEY" },
          { name: "beta", baseUrl: broken, supportKeyEnv: "BETA_KEY" },
        ],
      }),
    );
    const outputs = { GITHUB_STEP_SUMMARY: join(dir, "summary.md"), GITHUB_OUTPUT: join(dir, "out.txt") };
    const ok = await cli(["--config", config, "--state", join(dir, "state", "s.json"), "--json-file", join(dir, "r", "report.json")], { ACME_KEY: key, BETA_KEY: key, ...outputs });
    expect(ok.stdout).toContain("FAIL  beta");
    expect(ok.stdout).toContain("ok    acme");
    expect(ok.stdout).toContain("stripe: last sync failed");
    expect(ok.code).toBe(1);
    const report = JSON.parse(await readFile(join(dir, "r", "report.json"), "utf8")) as MonitorRun;
    expect(report.healthy).toBe(false);
    expect(report.instances.map((i) => i.healthy)).toEqual([true, false]);
    expect(JSON.parse(await readFile(join(dir, "state", "s.json"), "utf8")).instances.acme.deadLetters).toBe(0);
    expect(await readFile(outputs.GITHUB_OUTPUT, "utf8")).toBe("healthy=false\n");
    expect(await readFile(outputs.GITHUB_STEP_SUMMARY, "utf8")).toContain("FAIL  beta");
    for (const text of [ok.stdout, ok.stderr, JSON.stringify(report), await readFile(outputs.GITHUB_STEP_SUMMARY, "utf8")]) expect(text).not.toContain(key);

    const inline = JSON.stringify({ instances: [{ name: "acme", baseUrl: healthy, supportKeyEnv: "ACME_KEY" }] });
    const fine = await cli(["--json"], { MONITOR_CONFIG: inline, MONITOR_SUPPORT_KEYS: `ACME_KEY=${key}` });
    expect(fine.code).toBe(0);
    expect((JSON.parse(fine.stdout) as MonitorRun).healthy).toBe(true);
    expect(fine.stdout).not.toContain(key);
  }, 60_000);

  it("never prints a key, even one an instance echoes back in every field it can", async () => {
    const key = newKey("s");
    const base = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/healthz") return res.end(JSON.stringify({ status: "ok" }));
      const at = new Date().toISOString();
      res.end(
        JSON.stringify({
          instance: { name: key, organizationId: key, version: key, startedAt: at, uptimeSeconds: 100 * 3600 },
          migrations: { count: 1, applied: [key] },
          integrations: [{ id: key, configured: true, missingSettings: [], syncing: true, notSyncingReason: null, lastSync: { mode: "incremental", outcome: "failed", startedAt: at, finishedAt: at, error: `${key} ${req.headers.authorization}` } }],
          reasoning: { scheduled: true, intervalMinutes: 60, lastRun: { outcome: "failed", finishedAt: at, error: key }, lastSucceededAt: null, consecutiveFailures: 9 },
          deadLetters: { total: 500, bySource: { [key]: 500 }, byReason: {} },
          events: { days: 1, since: at, total: 0, byDay: [] },
        }),
      );
    });
    const dir = await mkdtemp(join(tmpdir(), "monitor-"));
    const res = await cli(["--json-file", join(dir, "r.json"), "--migrations", join(root, "supabase/migrations")], {
      MONITOR_CONFIG: JSON.stringify({ instances: [{ name: "acme", baseUrl: base, supportKeyEnv: "ACME_KEY" }] }),
      ACME_KEY: key,
      GITHUB_STEP_SUMMARY: join(dir, "s.md"),
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("[redacted]");
    expect(res.stdout).toContain("migrations not applied");
    for (const text of [res.stdout, res.stderr, await readFile(join(dir, "r.json"), "utf8"), await readFile(join(dir, "s.md"), "utf8")]) {
      expect(text).not.toContain(key);
    }
  }, 60_000);

  it("exits 2 on a config it can't use, without echoing it", async () => {
    const key = newKey("s");
    const bad = await cli([], { MONITOR_CONFIG: JSON.stringify({ instances: [{ name: "acme", baseUrl: "https://acme.example.test", supportKeyEnv: "ACME_KEY", supportKey: key }] }) });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("keys never go in the config");
    expect(bad.stderr + bad.stdout).not.toContain(key);
    expect((await cli([], {})).stderr).toContain("give --config <file>, MONITOR_CONFIG_FILE or MONITOR_CONFIG");
    expect((await cli([], { MONITOR_CONFIG: `{${key}` })).stderr).toBe("instance monitor: the config isn't valid JSON\n");
    expect((await cli(["--config", "/nonexistent/monitor.json"], {})).stderr).toBe("instance monitor: the config file can't be read\n");
    const lines = await cli([], { MONITOR_CONFIG: JSON.stringify({ instances: [{ name: "acme", baseUrl: "https://acme.example.test", supportKeyEnv: "ACME_KEY" }] }), MONITOR_SUPPORT_KEYS: key });
    expect(lines.code).toBe(2);
    expect(lines.stderr).not.toContain(key);
    const issues = await cli(["--issues"], { MONITOR_CONFIG: JSON.stringify({ instances: [{ name: "acme", baseUrl: "https://acme.example.test", supportKeyEnv: "ACME_KEY" }] }) });
    expect(issues.code).toBe(2);
    expect(issues.stderr).toContain("--issues needs GITHUB_TOKEN and GITHUB_REPOSITORY");
  }, 60_000);

  it("compares with the state file from the last run", async () => {
    const body = JSON.stringify(await statusBody({ runs: [], reasoning: null, startedHoursAgo: 1, deadLetters: [{ source: "shopify", reason: "x" }] }));
    const base = await serve((req, res) => res.end(req.url === "/healthz" ? "{}" : body));
    const dir = await mkdtemp(join(tmpdir(), "monitor-"));
    const statePath = join(dir, "state.json");
    const env = { MONITOR_CONFIG: JSON.stringify({ instances: [{ name: "acme", baseUrl: base, supportKeyEnv: "ACME_KEY" }] }), ACME_KEY: "k1234" };
    await writeFile(statePath, JSON.stringify({ version: 1, instances: { acme: { checkedAt: hoursAgo(1), deadLetters: 1, connectors: {} } } }));
    expect((await cli(["--state", statePath], env)).code).toBe(0);
    await writeFile(statePath, JSON.stringify({ version: 1, instances: { acme: { checkedAt: hoursAgo(1), deadLetters: 0, connectors: {} } } }));
    const grew = await cli(["--state", statePath], env);
    expect(grew.code).toBe(1);
    expect(grew.stdout).toContain("dead letters rose by 1 to 1");
  }, 60_000);

  it("takes a new baseline from a state file it can't read", async () => {
    const base = await serve((_, res) => res.end("{}"));
    const dir = await mkdtemp(join(tmpdir(), "monitor-"));
    await writeFile(join(dir, "state.json"), "not json");
    const res = await cli(["--state", join(dir, "state.json")], { MONITOR_CONFIG: JSON.stringify({ instances: [{ name: "acme", baseUrl: base, supportKeyEnv: "ACME_KEY" }] }), ACME_KEY: "k1234" });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("isn't a support status");
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8"))).toEqual({ version: 1, instances: {} });
  }, 60_000);
});

describe("the reusable workflow", () => {
  const text = (() => {
    const path = fileURLToPath(new URL("../.github/workflows/instance-monitor.yml", import.meta.url));
    return import("node:fs").then((fs) => fs.readFileSync(path, "utf8"));
  })();

  it("is called by another repo or run by hand, never on a schedule here", async () => {
    const w = await text;
    expect(w).toMatch(/^on:\n {2}workflow_call:/m);
    expect(w).toMatch(/^ {2}workflow_dispatch:/m);
    expect(w).not.toMatch(/^\s*-?\s*(schedule|cron):/m);
    expect(w).not.toMatch(/^ {2}(push|pull_request|workflow_run):/m);
  });

  it("asks for read access and issues: write only, and takes the keys as a secret", async () => {
    const w = await text;
    expect([...w.matchAll(/^(\s*)permissions:\n((?:\1 {2}\S.*\n)+)/gm)].map((m) => m[2]!.trim().split(/\n\s*/))).toEqual([["contents: read"], ["contents: read", "issues: write"]]);
    expect(w).toMatch(/secrets:\n\s+SUPPORT_KEYS:\n(\s+.*\n)*?\s+required: true/);
    expect(w).toContain("MONITOR_SUPPORT_KEYS: ${{ secrets.SUPPORT_KEYS }}");
    expect(w).toContain("GITHUB_TOKEN: ${{ github.token }}");
    expect(w).not.toMatch(/secrets\.(?!SUPPORT_KEYS\b)/);
  });

  it("names no instance and puts no input in a shell", async () => {
    const w = await text;
    for (const url of w.match(/https?:\/\/\S+/g) ?? []) expect(url).toMatch(/^https:\/\/github\.com\//);
    expect(w).not.toMatch(/example\.test|railway\.app|fly\.dev|run\.app/);
    const runs = [...w.matchAll(/^\s*(?:-\s*)?run:\s*(.*(?:\n(?!\s*-\s|\s*\w+:).*)*)/gm)].map((m) => m[1]!);
    expect(runs.length).toBeGreaterThan(2);
    for (const r of runs) expect(r).not.toContain("${{");
  });

  it("runs the monitor with state kept across runs, saved whatever the check found", async () => {
    const w = await text;
    expect(w).toContain("npm run -s monitor -- --state .instance-monitor/state.json");
    expect(w).toMatch(/- if: always\(\)\n\s+uses: actions\/cache\/save@/);
    expect(w).toContain("::add-mask::");
  });
});
