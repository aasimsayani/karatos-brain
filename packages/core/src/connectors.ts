import type { MemoryStore } from "./layers.js";
import { DeadLetteredError, type BrainPipeline } from "./pipeline.js";

/** A page of raw source records plus the cursor to resume after it. */
export interface SourceBatch {
  events: unknown[];
  cursor: string;
}

export interface SyncContext {
  organizationId: string;
  /** Where the last successful batch left off, or null on first run. */
  cursor: string | null;
}

/**
 * Every connector supports historical import and incremental sync, and may
 * accept webhooks. Connectors only fetch and shape data; runSync handles
 * checkpoints, retries and dead letters so each connector stays small.
 */
export interface Connector {
  readonly source: string;
  historicalImport(context: SyncContext): AsyncIterable<SourceBatch>;
  incrementalSync(context: SyncContext): AsyncIterable<SourceBatch>;
  /** Turns one webhook delivery into raw events. Verify signatures before calling. */
  handleWebhook?(body: unknown): unknown[];
}

export interface RunSyncOptions {
  connector: Connector;
  mode: "historical" | "incremental";
  pipeline: BrainPipeline;
  memory: MemoryStore;
  organizationId: string;
  /** Number of attempts per batch before giving up. */
  attempts?: number;
  /** Waits between attempts; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncReport {
  ingested: number;
  duplicates: number;
  deadLettered: number;
  batches: number;
  cursor: string | null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Pulls batches from a connector into the pipeline. The checkpoint advances
 * only after a whole batch is stored, so a crash resumes from the last good
 * batch. Invalid records are dead-lettered and never stop the sync.
 */
export async function runSync(options: RunSyncOptions): Promise<SyncReport> {
  const { connector, memory, organizationId } = options;
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  const stream = options.mode;
  const report: SyncReport = {
    ingested: 0,
    duplicates: 0,
    deadLettered: 0,
    batches: 0,
    cursor: await memory.getCheckpoint(organizationId, connector.source, stream),
  };

  // A failed fetch ends an async generator, so a retry restarts the connector
  // from the last saved checkpoint rather than calling next() again.
  let failures = 0;
  for (;;) {
    const context: SyncContext = { organizationId, cursor: report.cursor };
    const batches =
      options.mode === "historical" ? connector.historicalImport(context) : connector.incrementalSync(context);
    try {
      for await (const batch of batches) {
        await ingestBatch(batch, options, report);
        await memory
          .saveCheckpoint(organizationId, connector.source, stream, batch.cursor)
          .catch((error: unknown) => Promise.reject(new PipelineError(error)));
        report.cursor = batch.cursor;
        report.batches++;
        failures = 0;
      }
      return report;
    } catch (error) {
      // Our own pipeline or store failing would fail again: surface it.
      if (error instanceof PipelineError) throw error.cause;
      // Anything else came from the source system and is worth retrying.
      failures++;
      if (failures >= attempts) throw error;
      await sleep(250 * 2 ** (failures - 1));
    }
  }
}

async function ingestBatch(batch: SourceBatch, options: RunSyncOptions, report: SyncReport): Promise<void> {
  for (const raw of batch.events) {
    const event =
      typeof raw === "object" && raw !== null
        ? { ...(raw as object), organizationId: options.organizationId, source: options.connector.source }
        : raw;
    try {
      const result = await options.pipeline.ingest(event);
      if (result.duplicate) report.duplicates++;
      else report.ingested++;
    } catch (error) {
      if (!(error instanceof DeadLetteredError)) throw new PipelineError(error);
      report.deadLettered++;
    }
  }
}

/** Errors from our own pipeline or store are not retried: they would fail again. */
class PipelineError extends Error {
  constructor(override readonly cause: unknown) {
    super("pipeline failed");
  }
}

