import {
  BrainPipeline,
  InMemoryStore,
  runSync,
  type Connector,
  type MemoryStore,
  type Normalizer,
  type SourceBatch,
  type SyncContext,
  type SyncReport,
} from "@karatos/core";

export const TEST_ORG = "demo-store";

const noSleep = async () => {};

/** A fresh in-memory store and pipeline for one test. */
export function testPipeline(normalizers: Normalizer[] = []): { memory: InMemoryStore; pipeline: BrainPipeline } {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({
    memory,
    normalizers,
    extractors: [],
    reasoners: [],
    documentation: { current: () => ({ documentIds: [], stale: false }) },
  });
  return { memory, pipeline };
}

export class SourceOutageError extends Error {
  constructor(readonly batchIndex: number) {
    super(`injected source failure before batch ${batchIndex}`);
    this.name = "SourceOutageError";
  }
}

export interface FailurePlan {
  /** Fail just before yielding this batch (0-based, counted per run). */
  beforeBatch: number;
  /** How many times to fail before letting it through. */
  times: number;
}

/** Wraps a connector so its source fails on schedule, like a vendor outage mid-import. */
export function withFailures(connector: Connector, plan: FailurePlan): Connector {
  let remaining = plan.times;
  const wrap = (pages: (context: SyncContext) => AsyncIterable<SourceBatch>) =>
    async function* (context: SyncContext): AsyncIterable<SourceBatch> {
      let index = 0;
      for await (const batch of pages(context)) {
        if (index === plan.beforeBatch && remaining > 0) {
          remaining--;
          throw new SourceOutageError(index);
        }
        index++;
        yield batch;
      }
    };
  return {
    ...connector,
    historicalImport: wrap((c) => connector.historicalImport(c)),
    incrementalSync: wrap((c) => connector.incrementalSync(c)),
  };
}

export interface SyncCheckOptions {
  /** Builds a fresh connector; called once per scenario. */
  makeConnector: () => Connector;
  mode?: "historical" | "incremental";
  normalizers?: Normalizer[];
  expected: { ingested: number; deadLettered?: number };
}

export interface SyncCheckResult {
  full: SyncReport;
  replay: SyncReport;
  resume: SyncReport | null;
  retry: SyncReport;
}

export class SyncCheckError extends Error {
  constructor(readonly failures: string[]) {
    super(`connector sync check failed:\n- ${failures.join("\n- ")}`);
    this.name = "SyncCheckError";
  }
}

/**
 * Runs a connector through every runSync scenario a connector must survive:
 * a full import, a replay of the same data (all duplicates), a crash after
 * the first batch followed by a resume from the checkpoint, and a transient
 * source failure that a retry recovers from. Throws SyncCheckError listing
 * every scenario that went wrong.
 */
export async function checkConnectorSync(options: SyncCheckOptions): Promise<SyncCheckResult> {
  const mode = options.mode ?? "historical";
  const expectedDead = options.expected.deadLettered ?? 0;
  const failures: string[] = [];
  const sync = (connector: Connector, memory: MemoryStore, pipeline: BrainPipeline, attempts = 3) =>
    runSync({ connector, mode, pipeline, memory, organizationId: TEST_ORG, attempts, sleep: noSleep });

  // 1. Full import.
  const a = testPipeline(options.normalizers);
  const full = await sync(options.makeConnector(), a.memory, a.pipeline);
  if (full.ingested !== options.expected.ingested) {
    failures.push(`full import ingested ${full.ingested}, expected ${options.expected.ingested}`);
  }
  if (full.deadLettered !== expectedDead) {
    failures.push(`full import dead-lettered ${full.deadLettered}, expected ${expectedDead}`);
  }
  if (full.duplicates !== 0) failures.push(`full import saw ${full.duplicates} duplicates in fresh data`);

  // 2. Replay from scratch into the same store: nothing new may be stored.
  const fromScratch = Object.create(a.memory, {
    getCheckpoint: { value: async () => null },
  }) as MemoryStore;
  const replay = await sync(options.makeConnector(), fromScratch, a.pipeline);
  if (replay.ingested !== 0) failures.push(`replay stored ${replay.ingested} events again; idempotency keys aren't stable`);
  if (replay.duplicates !== full.ingested) {
    failures.push(`replay counted ${replay.duplicates} duplicates, expected ${full.ingested}`);
  }

  // 3. Crash after the first batch, then resume from the checkpoint.
  let resume: SyncReport | null = null;
  if (full.batches >= 2) {
    const b = testPipeline(options.normalizers);
    const crashing = withFailures(options.makeConnector(), { beforeBatch: 1, times: 1 });
    const crashed = await sync(crashing, b.memory, b.pipeline, 1).then(
      () => false,
      (error: unknown) => {
        if (error instanceof SourceOutageError) return true;
        throw error;
      },
    );
    if (!crashed) failures.push("resume: the injected crash after the first batch did not stop the sync");
    resume = await sync(options.makeConnector(), b.memory, b.pipeline);
    if (resume.duplicates !== 0) {
      failures.push(`resume re-read ${resume.duplicates} events; the connector ignores the checkpoint cursor`);
    }
    if (resume.ingested >= full.ingested && full.ingested > 0) {
      failures.push("resume started over instead of continuing after the first batch");
    }
    if (resume.cursor !== full.cursor) failures.push(`resume ended at cursor ${resume.cursor}, expected ${full.cursor}`);
  }

  // 4. A transient source failure is retried without losing or doubling data.
  const c = testPipeline(options.normalizers);
  const retry = await sync(withFailures(options.makeConnector(), { beforeBatch: 0, times: 1 }), c.memory, c.pipeline);
  if (retry.ingested !== full.ingested || retry.duplicates !== 0) {
    failures.push(`retry ingested ${retry.ingested} with ${retry.duplicates} duplicates, expected ${full.ingested} and 0`);
  }

  if (failures.length > 0) throw new SyncCheckError(failures);
  return { full, replay, resume, retry };
}
