import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, type PurgeResult, type RawDataRetention } from "@karatos/core";
import { createRetentionRunner, RETENTION_INTERVAL_MS, StaticDocumentationSource } from "../src/index.js";

const ORG = "test-jeweler";
const NOW = new Date("2026-10-22T00:00:00.000Z");

function timers() {
  const pending: { run: () => void; ms: number }[] = [];
  let cleared = 0;
  return {
    pending,
    cleared: () => cleared,
    setTimer: (run: () => void, ms: number) => {
      const t = { run, ms };
      pending.push(t);
      return t;
    },
    clearTimer: () => {
      cleared++;
    },
    async fire() {
      const t = pending.shift()!;
      t.run();
      await new Promise((r) => setTimeout(r, 0));
      return t.ms;
    },
  };
}

describe("createRetentionRunner", () => {
  it("purges at start, then once a day, with the instance's window, and logs the counts", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [], documentation: new StaticDocumentationSource([]) });
    await pipeline.ingest({
      id: "e1",
      organizationId: ORG,
      source: "shopify",
      type: "order.created",
      occurredAt: "2026-09-01T00:00:00Z",
      receivedAt: "2026-09-01T00:00:00Z",
      idempotencyKey: "shopify:order:1",
      payload: { orderId: "shopify:order:1" },
    });
    const lines: string[] = [];
    const t = timers();
    const runner = createRetentionRunner({ store: memory, organizationId: ORG, retentionDays: 30, log: (l) => lines.push(l), now: () => NOW, ...t });
    runner.start();
    runner.start();
    expect(t.pending).toHaveLength(1);
    expect(await t.fire()).toBe(0);
    expect(lines).toEqual(["retention: cleared raw data older than 30 days from 1 events, 0 dead letters and 0 file imports"]);
    expect(t.pending.map((p) => p.ms)).toEqual([RETENTION_INTERVAL_MS]);
    expect(RETENTION_INTERVAL_MS).toBe(86_400_000);
    await t.fire();
    expect(memory.retentionRuns.map((r) => r.events)).toEqual([1, 0]);
    await runner.stop();
    expect(t.cleared()).toBe(1);
    expect(t.pending).toHaveLength(1);
  });

  it("joins a purge in progress and survives a failing one", async () => {
    let calls = 0;
    let release!: () => void;
    const store: RawDataRetention = {
      purgeRawData: (organizationId, now, retentionDays) => {
        calls++;
        expect([organizationId, retentionDays]).toEqual([ORG, 7]);
        if (calls === 1) return new Promise<PurgeResult>((_, reject) => (release = () => reject(new Error("database went away"))));
        return Promise.resolve({ organizationId, ranAt: now.toISOString(), cutoff: now.toISOString(), retentionDays: 7, events: 0, deadLetters: 0, fileImports: 0 });
      },
    };
    const lines: string[] = [];
    const runner = createRetentionRunner({ store, organizationId: ORG, retentionDays: 7, intervalMs: 5, log: (l) => lines.push(l) });
    const first = runner.runOnce();
    const joined = runner.runOnce();
    expect(calls).toBe(1);
    release();
    expect(await first).toBeNull();
    expect(await joined).toBeNull();
    expect(lines).toEqual(["retention failed: Error: database went away"]);
    expect((await runner.runOnce())?.retentionDays).toBe(7);
    await runner.stop();
  });

  it("uses real timers by default and stops cleanly", async () => {
    const store: RawDataRetention = {
      purgeRawData: async (organizationId, now, retentionDays = 30) => ({ organizationId, ranAt: now.toISOString(), cutoff: now.toISOString(), retentionDays, events: 0, deadLetters: 0, fileImports: 0 }),
    };
    const lines: string[] = [];
    const runner = createRetentionRunner({ store, organizationId: ORG, retentionDays: 30, log: (l) => lines.push(l) });
    runner.start();
    await new Promise((r) => setTimeout(r, 20));
    await runner.stop();
    expect(lines).toHaveLength(1);
  });
});
