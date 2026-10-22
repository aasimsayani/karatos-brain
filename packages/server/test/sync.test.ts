import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync, type Connector, type SourceBatch, type SyncContext } from "@karatos/core";
import { createSyncRunner, HISTORICAL_COMPLETE, scheduledConnectors, StaticDocumentationSource, SYNCABLE_INTEGRATIONS, type ScheduledConnector } from "../src/index.js";

const ORG = "test-jeweler";
// Assembled at runtime so no key-shaped string sits in the repository.
const fakeKey = (kind: "rk" | "sk", mode: "test" | "live") => [kind, mode, "0".repeat(24)].join("_");

const event = (n: number) => ({
  id: `evt_${n}`,
  type: "order.created",
  occurredAt: "2026-10-01T12:00:00Z",
  receivedAt: "2026-10-01T12:00:01Z",
  idempotencyKey: `order-${n}`,
  payload: { orderId: String(n) },
});

/** A connector that records which mode ran and from which cursor. */
function fakeConnector(source: string, calls: string[], options: { failHistorical?: number } = {}): Connector {
  let historicalFailures = options.failHistorical ?? 0;
  return {
    source,
    async *historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
      calls.push(`${source}:historical:${context.cursor}`);
      if (historicalFailures-- > 0) throw new Error("vendor timed out");
      yield { events: [event(1), event(2)], cursor: "h1" };
    },
    async *incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
      calls.push(`${source}:incremental:${context.cursor}`);
      yield { events: [event(3)], cursor: "i1" };
    },
  };
}

function setup(connectors: ScheduledConnector[]) {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [], documentation: new StaticDocumentationSource([]) });
  const logs: string[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const cleared: unknown[] = [];
  const runner = createSyncRunner({
    connectors,
    pipeline,
    memory,
    organizationId: ORG,
    intervalMs: 60_000,
    log: (line) => logs.push(line),
    now: () => new Date("2026-10-20T00:00:00Z"),
    sync: (options) => runSync({ ...options, sleep: async () => {} }),
    setTimer: (run, ms) => timers.push({ run, ms }) - 1,
    clearTimer: (timer) => cleared.push(timer),
  });
  return { memory, logs, timers, cleared, runner };
}

const scheduled = (connector: Connector): ScheduledConnector => ({ id: connector.source, make: async () => connector });

describe("scheduledConnectors", () => {
  it("schedules enabled, built connectors that have their settings", () => {
    const { connectors, skipped } = scheduledConnectors(["shopify", "stripe"], {
      SHOPIFY_SHOP_DOMAIN: "demo.myshopify.com",
      SHOPIFY_ADMIN_ACCESS_TOKEN: "token-value",
      STRIPE_SECRET_KEY: fakeKey("rk", "test"),
    });
    expect(connectors.map((c) => c.id)).toEqual(["shopify", "stripe"]);
    expect(skipped).toEqual([]);
  });

  it("accepts either Shopify sign-in and lists both client settings when neither is set", () => {
    const client = scheduledConnectors(["shopify"], { SHOPIFY_SHOP_DOMAIN: "demo.myshopify.com", SHOPIFY_CLIENT_ID: "id", SHOPIFY_CLIENT_SECRET: "secret" });
    expect(client.connectors.map((c) => c.id)).toEqual(["shopify"]);
    const half = scheduledConnectors(["shopify"], { SHOPIFY_CLIENT_ID: "id-value" });
    expect(half.skipped).toEqual([{ id: "shopify", reason: "missing SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET" }]);
  });

  it("skips integrations with no connector yet and those missing settings, naming settings but never values", () => {
    const secret = fakeKey("rk", "live");
    const { connectors, skipped } = scheduledConnectors(["anthropic", "stripe", "inventory_pos", "bank_statements", "stripe"], {
      STRIPE_SECRET_KEY: "   ",
      POS_MAPPING_PROFILE: secret,
    });
    expect(connectors).toEqual([]);
    expect(skipped).toEqual([
      { id: "anthropic", reason: "no connector to sync yet" },
      { id: "stripe", reason: "missing STRIPE_SECRET_KEY" },
      { id: "inventory_pos", reason: "missing POS_IMPORT_DIR" },
      { id: "bank_statements", reason: "missing BANK_STATEMENTS_IMPORT_DIR" },
    ]);
    expect(scheduledConnectors(["chase"], { CHASE_IMPORT_MODE: "manual_pdf" }).skipped).toEqual([{ id: "chase", reason: "missing CHASE_MANUAL_IMPORT_DIR" }]);
    expect(scheduledConnectors(["chase"], { CHASE_MANUAL_IMPORT_DIR: "/data/chase" }).skipped).toEqual([{ id: "chase", reason: "missing CHASE_IMPORT_MODE" }]);
    expect(JSON.stringify(skipped)).not.toContain(secret);
    expect(scheduledConnectors(["quickbooks"], { QUICKBOOKS_CLIENT_ID: "id", QUICKBOOKS_REFRESH_TOKEN: secret }).skipped).toEqual([
      { id: "quickbooks", reason: "missing QUICKBOOKS_CLIENT_SECRET, QUICKBOOKS_REALM_ID, QUICKBOOKS_ENVIRONMENT" },
    ]);
    expect(scheduledConnectors(["slack"], { SLACK_BOT_TOKEN: secret }).skipped).toEqual([{ id: "slack", reason: "missing CORRESPONDENT_HASH_KEY" }]);
    expect(scheduledConnectors(["xero"], { XERO_CLIENT_SECRET: secret, XERO_REFRESH_TOKEN: secret }).skipped).toEqual([{ id: "xero", reason: "missing XERO_CLIENT_ID, XERO_TENANT_ID" }]);
  });

  it("syncs nothing unless an integration is turned on, even when its settings are present", () => {
    expect(scheduledConnectors([], { STRIPE_SECRET_KEY: fakeKey("rk", "test"), POS_IMPORT_DIR: "/data/pos" })).toEqual({ connectors: [], skipped: [] });
  });

  it("does not treat inherited object keys as integrations", () => {
    expect(scheduledConnectors(["constructor", "toString"], {}).skipped.map((s) => s.reason)).toEqual(["no connector to sync yet", "no connector to sync yet"]);
  });

  it("builds each built connector from the instance's settings", async () => {
    const pos = await mkdtemp(join(tmpdir(), "sync-pos-"));
    const bank = await mkdtemp(join(tmpdir(), "sync-bank-"));
    const chase = await mkdtemp(join(tmpdir(), "sync-chase-"));
    const env = {
      SHOPIFY_SHOP_DOMAIN: "demo.myshopify.com",
      SHOPIFY_CLIENT_ID: "id",
      SHOPIFY_CLIENT_SECRET: "secret",
      SHOPIFY_API_VERSION: "2026-07",
      STRIPE_SECRET_KEY: fakeKey("rk", "test"),
      STRIPE_API_VERSION: "2026-09-30.clover",
      POS_IMPORT_DIR: pos,
      BANK_STATEMENTS_IMPORT_DIR: bank,
      CHASE_IMPORT_MODE: "manual_csv_and_pdf",
      CHASE_MANUAL_IMPORT_DIR: chase,
      QUICKBOOKS_CLIENT_ID: "client-id",
      QUICKBOOKS_CLIENT_SECRET: "client-secret-value",
      QUICKBOOKS_REALM_ID: "9341450000",
      QUICKBOOKS_REFRESH_TOKEN: "refresh-value",
      QUICKBOOKS_ENVIRONMENT: "sandbox",
      SLACK_BOT_TOKEN: ["xoxb", "0".repeat(12), "TESTtokenTESTtoken"].join("-"),
      CORRESPONDENT_HASH_KEY: "0".repeat(64),
      SLACK_TEXT_CHANNELS: "C0TEST0001",
      SLACK_APP_DISTRIBUTION: "non_marketplace",
      XERO_CLIENT_ID: "client-id",
      XERO_CLIENT_SECRET: "client-secret-value",
      XERO_TENANT_ID: "00000000-0000-4000-8000-00000000a0a0",
      XERO_REFRESH_TOKEN: "refresh-value",
    };
    const { connectors } = scheduledConnectors(SYNCABLE_INTEGRATIONS, env);
    const built = await Promise.all(connectors.map((c) => c.make()));
    expect(built.map((c) => c.source).sort()).toEqual(["bank_statements", "chase", "inventory_pos", "quickbooks", "shopify", "slack", "stripe", "xero"]);
    // Text and distribution have defaults, and anything but their listed values stops the connector being built.
    const { SLACK_TEXT_CHANNELS: _text, SLACK_APP_DISTRIBUTION: _dist, ...slackDefaults } = env;
    expect((await scheduledConnectors(["slack"], slackDefaults).connectors[0]!.make()).source).toBe("slack");
    await expect(scheduledConnectors(["slack"], { ...env, SLACK_TEXT_CHANNELS: "repairs" }).connectors[0]!.make()).rejects.toThrow("SLACK_TEXT_CHANNELS must be");
    await expect(scheduledConnectors(["slack"], { ...env, SLACK_APP_DISTRIBUTION: "public" }).connectors[0]!.make()).rejects.toThrow("SLACK_APP_DISTRIBUTION must be");
    const token = await scheduledConnectors(["shopify"], { SHOPIFY_SHOP_DOMAIN: "demo.myshopify.com", SHOPIFY_ADMIN_ACCESS_TOKEN: "t" }).connectors[0]!.make();
    expect(token.source).toBe("shopify");
    for (const connector of built) expect(connector).not.toHaveProperty("write");
  });
});

describe("createSyncRunner", () => {
  it("imports history once, then syncs incrementally from its own checkpoint", async () => {
    const calls: string[] = [];
    const { runner, memory, logs } = setup([scheduled(fakeConnector("shopify", calls))]);
    const first = await runner.runOnce();
    expect(first).toEqual([{ id: "shopify", mode: "historical", report: { ingested: 2, duplicates: 0, deadLettered: 0, batches: 1, cursor: "h1" } }]);
    expect(await memory.getCheckpoint(ORG, "shopify", HISTORICAL_COMPLETE)).toBe("2026-10-20T00:00:00.000Z");
    await runner.runOnce();
    await runner.runOnce();
    expect(calls).toEqual(["shopify:historical:null", "shopify:incremental:null", "shopify:incremental:i1"]);
    expect(memory.events.map((e) => e.organizationId)).toEqual([ORG, ORG, ORG]);
    expect(logs[0]).toBe("sync shopify historical: 2 new, 0 duplicates, 0 dead-lettered in 1 batches");
    expect(logs[2]).toBe("sync shopify incremental: 0 new, 1 duplicates, 0 dead-lettered in 1 batches");
  });

  it("keeps importing history after a failed round, resuming rather than switching to incremental", async () => {
    const calls: string[] = [];
    const { runner, memory } = setup([scheduled(fakeConnector("stripe", calls, { failHistorical: 3 }))]);
    const [failed] = await runner.runOnce();
    expect(failed).toEqual({ id: "stripe", mode: "historical", error: "Error: vendor timed out" });
    expect(await memory.getCheckpoint(ORG, "stripe", HISTORICAL_COMPLETE)).toBeNull();
    const [next] = await runner.runOnce();
    expect(next?.mode).toBe("historical");
    expect(next?.report?.ingested).toBe(2);
  });

  it("runs every connector even when one fails to build or sync", async () => {
    const calls: string[] = [];
    const broken: ScheduledConnector = {
      id: "inventory_pos",
      make: async () => {
        throw new Error("POS_MAPPING_PROFILE: could not read a JSON profile (Error)");
      },
    };
    const { runner, logs } = setup([broken, scheduled(fakeConnector("shopify", calls, { failHistorical: 9 })), scheduled(fakeConnector("stripe", calls))]);
    const outcomes = await runner.runOnce();
    expect(outcomes.map((o) => [o.id, o.error ?? "ok"])).toEqual([
      ["inventory_pos", "Error: POS_MAPPING_PROFILE: could not read a JSON profile (Error)"],
      ["shopify", "Error: vendor timed out"],
      ["stripe", "ok"],
    ]);
    expect(logs[0]).toBe("sync inventory_pos historical failed: Error: POS_MAPPING_PROFILE: could not read a JSON profile (Error)");
  });

  it("never logs a credential when a connector refuses its key", async () => {
    const key = fakeKey("sk", "live");
    const { connectors } = scheduledConnectors(["stripe"], { STRIPE_SECRET_KEY: key });
    const { runner, logs } = setup(connectors);
    const [outcome] = await runner.runOnce();
    expect(outcome?.error).toMatch(/restricted key/);
    expect(logs.join("\n")).not.toContain(key);
    expect(JSON.stringify(outcome)).not.toContain(key);
  });

  it("shortens long errors and names non-errors generically", async () => {
    const long: ScheduledConnector = { id: "a", make: async () => Promise.reject(new Error("x".repeat(1000))) };
    const odd: ScheduledConnector = { id: "b", make: async () => Promise.reject("raw string with details") };
    const { runner, logs } = setup([long, odd]);
    const [first, second] = await runner.runOnce();
    expect(first?.error).toHaveLength(301);
    expect(second?.error).toBe("unknown error");
    expect(logs.join("\n")).not.toContain("raw string with details");
  });

  it("joins a round already in progress instead of starting a second one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let builds = 0;
    const slow: ScheduledConnector = {
      id: "slow",
      make: async () => {
        builds++;
        await gate;
        return fakeConnector("slow", []);
      },
    };
    const { runner } = setup([slow]);
    const a = runner.runOnce();
    const b = runner.runOnce();
    expect(b).toBe(a);
    release();
    await a;
    await runner.runOnce();
    expect(builds).toBe(2);
  });

  it("starts right away, waits the interval after each round, and stops cleanly", async () => {
    const calls: string[] = [];
    const { runner, timers, cleared } = setup([scheduled(fakeConnector("shopify", calls))]);
    runner.start();
    runner.start();
    expect(timers.map((t) => t.ms)).toEqual([0]);
    timers[0]!.run();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["shopify:historical:null"]);
    expect(timers.map((t) => t.ms)).toEqual([0, 60_000]);
    await runner.stop();
    expect(cleared).toEqual([1]);
    timers[1]!.run();
    await runner.stop();
    expect(timers).toHaveLength(2);
  });

  it("does nothing on start when no connector is scheduled", async () => {
    const { runner, timers } = setup([]);
    runner.start();
    expect(timers).toEqual([]);
    expect(await runner.runOnce()).toEqual([]);
    await runner.stop();
  });

  it("waits for a round in progress when stopped", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: ScheduledConnector = { id: "slow", make: async () => (await gate, fakeConnector("slow", [])) };
    const { runner } = setup([slow]);
    let finished = false;
    void runner.runOnce().then(() => (finished = true));
    const stopping = runner.stop();
    release();
    await stopping;
    expect(finished).toBe(true);
  });

  it("uses real timers by default", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [], documentation: new StaticDocumentationSource([]) });
    const calls: string[] = [];
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      const runner = createSyncRunner({ connectors: [scheduled(fakeConnector("stripe", calls))], pipeline, memory, organizationId: ORG, intervalMs: 60_000 });
      runner.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await runner.stop();
    } finally {
      console.log = original;
    }
    expect(calls).toEqual(["stripe:historical:null"]);
    expect(lines).toEqual(["sync stripe historical: 2 new, 0 duplicates, 0 dead-lettered in 1 batches"]);
  });
});
