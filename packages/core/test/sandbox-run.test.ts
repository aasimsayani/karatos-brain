import { describe, expect, it } from "vitest";
import {
  limitBatches,
  runSandboxChecks,
  sandboxMarker,
  type Connector,
  type IssueTracker,
  type SandboxCheck,
  type SourceBatch,
} from "../src/index.js";

const NOW = () => new Date("2026-10-12T03:00:00Z");
const noSleep = async () => {};

function event(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `sbx_${n}`,
    type: "order.created",
    occurredAt: "2026-01-01T00:00:00Z",
    receivedAt: "2026-01-01T00:00:00Z",
    idempotencyKey: `sbx-${n}`,
    payload: { n },
    ...overrides,
  };
}

class Tracker implements IssueTracker {
  readonly issues: { number: number; title: string; body: string; comments: string[]; open: boolean }[] = [];
  async findOpen(marker: string) {
    const issue = this.issues.find((i) => i.open && i.body.includes(marker));
    return issue ? { number: issue.number, body: issue.body } : null;
  }
  async open(title: string, body: string) {
    this.issues.push({ number: this.issues.length + 1, title, body, comments: [], open: true });
    return this.issues.length;
  }
  async comment(number: number, body: string) {
    this.issues[number - 1]!.comments.push(body);
  }
  async close(number: number, body: string) {
    await this.comment(number, body);
    this.issues[number - 1]!.open = false;
  }
}

interface SandboxBehavior {
  pages?: SourceBatch[];
  incrementalPages?: SourceBatch[];
  failIncremental?: boolean;
  webhookEvents?: unknown[];
}

function sandboxConnector(behavior: SandboxBehavior): Connector {
  const pages = behavior.pages ?? [
    { events: [event(1), event(2)], cursor: "c1" },
    { events: [event(3)], cursor: "c2" },
  ];
  return {
    source: "demo_shop",
    historicalImport: async function* () {
      yield* pages;
    },
    incrementalSync: async function* () {
      if (behavior.failIncremental) throw new Error("401 Unauthorized: sandbox token expired");
      yield* behavior.incrementalPages ?? [{ events: [event(4)], cursor: "c3" }];
    },
    handleWebhook: () => behavior.webhookEvents ?? [event(5)],
  };
}

function check(behavior: SandboxBehavior = {}, extra: Partial<SandboxCheck> = {}): SandboxCheck {
  return {
    integration: "demo_shop",
    name: "Demo Shop",
    credentials: ["DEMO_SANDBOX_TOKEN"],
    connector: (credentials) => {
      expect(credentials).toEqual({ DEMO_SANDBOX_TOKEN: "test-token" });
      return sandboxConnector(behavior);
    },
    webhook: async () => ({ topic: "orders/create" }),
    minimumEvents: 3,
    ...extra,
  };
}

/** A check with some optional fields removed. */
function without(c: SandboxCheck, ...keys: ("webhook" | "minimumEvents")[]): SandboxCheck {
  const copy = { ...c };
  for (const key of keys) delete copy[key];
  return copy;
}

const ENV = { DEMO_SANDBOX_TOKEN: "test-token" };
const run = (checks: SandboxCheck[], issues = new Tracker(), env: Record<string, string | undefined> = ENV) =>
  runSandboxChecks({ checks, env, issues, now: NOW, sleep: noSleep });

describe("runSandboxChecks", () => {
  it("runs historical, incremental and webhook steps and passes a healthy connector", async () => {
    const issues = new Tracker();
    const [result] = await run([check()], issues);
    expect(result).toEqual({
      integration: "demo_shop",
      status: "passed",
      closed: [],
      steps: [
        { step: "historical", report: { ingested: 3, duplicates: 0, deadLettered: 0, batches: 2, cursor: "c2" } },
        { step: "incremental", report: { ingested: 1, duplicates: 0, deadLettered: 0, batches: 1, cursor: "c3" } },
        { step: "webhook", webhookEvents: 1 },
      ],
    });
    expect(issues.issues).toEqual([]);
  });

  it("skips and lists connectors without sandbox credentials instead of failing them", async () => {
    const results = await run([check({}, { credentials: ["DEMO_SANDBOX_TOKEN", "DEMO_SANDBOX_SECRET"] })], new Tracker(), {
      DEMO_SANDBOX_TOKEN: "test-token",
      DEMO_SANDBOX_SECRET: "",
    });
    expect(results).toEqual([{ integration: "demo_shop", status: "skipped", missing: ["DEMO_SANDBOX_SECRET"] }]);
  });

  it("opens one issue naming the connector and the step, and doesn't repeat it", async () => {
    const issues = new Tracker();
    const failing = check({ failIncremental: true });
    const [first] = await run([failing], issues);
    expect(first).toEqual({
      integration: "demo_shop",
      status: "failed",
      step: "incremental",
      error: "401 Unauthorized: sandbox token expired",
      issue: 1,
    });
    await run([failing], issues);
    expect(issues.issues).toHaveLength(1);
    expect(issues.issues[0]!.title).toBe("Sandbox run failed: Demo Shop, incremental step");
    expect(issues.issues[0]!.body).toContain(sandboxMarker("demo_shop", "incremental"));
    expect(issues.issues[0]!.body).toContain("401 Unauthorized: sandbox token expired");
  });

  it("closes the failure issue once the connector passes again", async () => {
    const issues = new Tracker();
    await run([check({ failIncremental: true })], issues);
    const [result] = await run([check()], issues);
    expect(result).toMatchObject({ status: "passed", closed: [1] });
    expect(issues.issues[0]!.open).toBe(false);
    expect(issues.issues[0]!.comments[0]).toMatch(/^Passing again in the sandbox run on 2026-10-12T03:00:00.000Z/);
    await run([check({ failIncremental: true })], issues);
    expect(issues.issues).toHaveLength(2);
  });

  it("fails the historical step when records stop validating or go missing", async () => {
    const invalid = await run([check({ pages: [{ events: [event(1), { ...event(2), type: "Bad Type" }, event(3)], cursor: "c1" }] })]);
    expect(invalid[0]).toMatchObject({ status: "failed", step: "historical", error: expect.stringMatching(/1 records failed validation/) });
    const short = await run([check({ pages: [{ events: [event(1)], cursor: "c1" }] })]);
    expect(short[0]).toMatchObject({ status: "failed", step: "historical", error: "imported 1 records, expected at least 3 from the seeded sandbox" });
  });

  it("fails the incremental step on dead letters too", async () => {
    const [result] = await run([check({ incrementalPages: [{ events: [{ nope: true }], cursor: "c3" }] })]);
    expect(result).toMatchObject({ status: "failed", step: "incremental" });
  });

  it("fails the webhook step when the delivery is empty, invalid or can't be fetched", async () => {
    expect((await run([check({ webhookEvents: [] })]))[0]).toMatchObject({ step: "webhook", error: "the test delivery produced no events" });
    expect((await run([check({ webhookEvents: [{ bad: 1 }] })]))[0]).toMatchObject({
      step: "webhook",
      error: "the test delivery failed validation",
    });
    const unreachable = check({}, { webhook: async () => Promise.reject(new Error("sandbox didn't send the test delivery")) });
    expect((await run([unreachable]))[0]).toMatchObject({ step: "webhook", error: "sandbox didn't send the test delivery" });
    const noHandler = check({}, {
      connector: () => {
        const { handleWebhook: _, ...rest } = sandboxConnector({});
        return rest;
      },
    });
    expect((await run([noHandler]))[0]).toMatchObject({ step: "webhook", error: expect.stringMatching(/can't handle one/) });
  });

  it("skips the webhook step for vendors that can't send one", async () => {
    const [result] = await run([without(check(), "webhook", "minimumEvents")]);
    expect(result).toMatchObject({ status: "passed" });
    expect(result?.status === "passed" && result.steps.map((s) => s.step)).toEqual(["historical", "incremental"]);
  });

  it("reports a connector that can't be built, and keeps going with the others", async () => {
    const broken = check({}, { integration: "broken", name: "Broken", connector: () => { throw new Error("missing region"); } });
    const results = await run([broken, check()]);
    expect(results.map((r) => r.status)).toEqual(["failed", "passed"]);
    expect(results[0]).toMatchObject({ step: "historical", error: "could not build the connector: missing region" });
  });

  it("keeps the connector's result when the issue tracker is down", async () => {
    const down = Object.assign(new Tracker(), {
      findOpen: async () => {
        throw new Error("GitHub GET /issues answered 502");
      },
    });
    const [failed] = await run([check({ failIncremental: true })], down);
    expect(failed).toEqual({
      integration: "demo_shop",
      status: "failed",
      step: "incremental",
      error: "401 Unauthorized: sandbox token expired",
      issueError: "GitHub GET /issues answered 502",
    });
    const [passed] = await run([check()], down);
    expect(passed).toMatchObject({ status: "passed", closed: [], issueError: "GitHub GET /issues answered 502" });
  });

  it("uses the real clock and sleep when none are given", async () => {
    const results = await runSandboxChecks({ checks: [without(check(), "webhook")], env: ENV, issues: new Tracker() });
    expect(results[0]!.status).toBe("passed");
  });
});

describe("limitBatches", () => {
  it("stops each sync after the limit", async () => {
    const connector = limitBatches(sandboxConnector({}), 1);
    const batches: SourceBatch[] = [];
    for await (const batch of connector.historicalImport({ organizationId: "o", cursor: null })) batches.push(batch);
    expect(batches.map((b) => b.cursor)).toEqual(["c1"]);
    const none: SourceBatch[] = [];
    for await (const batch of limitBatches(sandboxConnector({}), 0).incrementalSync({ organizationId: "o", cursor: null })) none.push(batch);
    expect(none).toEqual([]);
  });
});
