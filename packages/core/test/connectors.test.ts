import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync, type Connector, type SourceBatch } from "../src/index.js";

const ORG = "fuse-jewelry";

function rawEvent(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `evt_${n}`,
    type: "order.created",
    occurredAt: "2026-10-01T12:00:00Z",
    receivedAt: "2026-10-01T12:00:01Z",
    idempotencyKey: `order-${n}`,
    payload: { n },
    ...overrides,
  };
}

function fakeConnector(pages: SourceBatch[], failures: Record<number, number> = {}): Connector & { seenCursors: (string | null)[] } {
  const seenCursors: (string | null)[] = [];
  async function* pagesFrom(cursor: string | null) {
    seenCursors.push(cursor);
    const start = cursor === null ? 0 : pages.findIndex((p) => p.cursor === cursor) + 1;
    for (let i = start; i < pages.length; i++) {
      while ((failures[i] ?? 0) > 0) {
        failures[i]!--;
        throw new Error(`page ${i} temporarily unavailable`);
      }
      yield pages[i]!;
    }
  }
  return {
    source: "fake",
    seenCursors,
    historicalImport: (ctx) => pagesFrom(ctx.cursor),
    incrementalSync: (ctx) => pagesFrom(ctx.cursor),
  };
}

function setup() {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({
    memory,
    normalizers: [],
    extractors: [],
    reasoners: [],
    documentation: { current: () => ({ documentIds: [], stale: false }) },
  });
  return { memory, pipeline };
}

const noSleep = async () => {};

describe("runSync", () => {
  it("imports every batch, stamps the source and organization, and checkpoints", async () => {
    const { memory, pipeline } = setup();
    const connector = fakeConnector([
      { events: [rawEvent(1), rawEvent(2)], cursor: "page-1" },
      { events: [rawEvent(3)], cursor: "page-2" },
    ]);
    const report = await runSync({ connector, mode: "historical", pipeline, memory, organizationId: ORG, sleep: noSleep });

    expect(report).toEqual({ ingested: 3, duplicates: 0, deadLettered: 0, batches: 2, cursor: "page-2" });
    expect(memory.events.every((e) => e.organizationId === ORG && e.source === "fake")).toBe(true);
    expect(await memory.getCheckpoint(ORG, "fake", "historical")).toBe("page-2");
  });

  it("resumes from the last checkpoint", async () => {
    const { memory, pipeline } = setup();
    const pages = [
      { events: [rawEvent(1)], cursor: "page-1" },
      { events: [rawEvent(2)], cursor: "page-2" },
    ];
    await memory.saveCheckpoint(ORG, "fake", "incremental", "page-1");
    const connector = fakeConnector(pages);
    const report = await runSync({ connector, mode: "incremental", pipeline, memory, organizationId: ORG, sleep: noSleep });
    expect(connector.seenCursors).toEqual(["page-1"]);
    expect(report.ingested).toBe(1);
  });

  it("dead-letters invalid records without stopping the sync", async () => {
    const { memory, pipeline } = setup();
    const connector = fakeConnector([{ events: [rawEvent(1), rawEvent(2, { type: "Bad" }), "not even an object"], cursor: "p1" }]);
    const report = await runSync({ connector, mode: "historical", pipeline, memory, organizationId: ORG, sleep: noSleep });
    expect(report).toMatchObject({ ingested: 1, deadLettered: 2 });
    expect(memory.deadLetters.map((d) => d.organizationId)).toEqual([ORG, undefined]);
  });

  it("counts replays as duplicates", async () => {
    const { memory, pipeline } = setup();
    const connector = fakeConnector([{ events: [rawEvent(1), rawEvent(1)], cursor: "p1" }]);
    const report = await runSync({ connector, mode: "historical", pipeline, memory, organizationId: ORG, sleep: noSleep });
    expect(report).toMatchObject({ ingested: 1, duplicates: 1 });
  });

  it("retries a failing batch with backoff", async () => {
    const { memory, pipeline } = setup();
    const waits: number[] = [];
    const connector = fakeConnector([{ events: [rawEvent(1)], cursor: "p1" }], { 0: 2 });
    const report = await runSync({
      connector,
      mode: "historical",
      pipeline,
      memory,
      organizationId: ORG,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(report.ingested).toBe(1);
    expect(waits).toEqual([250, 500]);
  });

  it("gives up after the last attempt and keeps the previous checkpoint", async () => {
    const { memory, pipeline } = setup();
    const connector = fakeConnector(
      [
        { events: [rawEvent(1)], cursor: "p1" },
        { events: [rawEvent(2)], cursor: "p2" },
      ],
      { 1: 5 },
    );
    await expect(
      runSync({ connector, mode: "historical", pipeline, memory, organizationId: ORG, attempts: 2, sleep: noSleep }),
    ).rejects.toThrow(/temporarily unavailable/);
    expect(await memory.getCheckpoint(ORG, "fake", "historical")).toBe("p1");
  });

  it("does not retry when Brain A itself fails", async () => {
    const { memory, pipeline } = setup();
    memory.appendEvent = async () => {
      throw new Error("database down");
    };
    const waits: number[] = [];
    const connector = fakeConnector([{ events: [rawEvent(1)], cursor: "p1" }]);
    await expect(
      runSync({ connector, mode: "historical", pipeline, memory, organizationId: ORG, sleep: async (ms) => void waits.push(ms) }),
    ).rejects.toThrow("database down");
    expect(waits).toEqual([]);
  });
});
