import type { BrainPipeline, Connector, MemoryStore, SyncReport } from "@karatos/core";
import { runSync } from "@karatos/core";
import { FACTORIES } from "./connectors/index.js";
import type { ConnectorStore, Env } from "./connector-factory.js";

export type { ConnectorFactory, ConnectorStore } from "./connector-factory.js";

/**
 * Runs each connector an instance has turned on, on a schedule. A connector
 * runs its historical import until that finishes once, then incremental
 * syncs. Runs never overlap, one connector failing never stops the others,
 * and every connector stays read-only: nothing here performs a write.
 */

/** A connector the runner can build fresh for every run, so new folders, profiles and rotated keys are picked up. */
export interface ScheduledConnector {
  id: string;
  make: () => Promise<Connector>;
}

export interface SkippedIntegration {
  id: string;
  reason: string;
}

/** Records that a connector's historical import ran to the end; afterwards it syncs incrementally. */
export const HISTORICAL_COMPLETE = "historical_complete";

/**
 * Integration ids the runner knows how to sync: one for each factory in
 * `packages/server/src/connectors/`, listed there by `npm run registry:write`.
 */
export const SYNCABLE_INTEGRATIONS = Object.keys(FACTORIES);

/**
 * The connectors to schedule: those listed in ENABLED_INTEGRATIONS that have
 * a connector and the settings it needs. Everything else is reported with a
 * reason, naming missing settings but never their values.
 */
export function scheduledConnectors(enabled: readonly string[], env: Env, store?: ConnectorStore): { connectors: ScheduledConnector[]; skipped: SkippedIntegration[] } {
  const connectors: ScheduledConnector[] = [];
  const skipped: SkippedIntegration[] = [];
  for (const id of new Set(enabled)) {
    const factory = Object.hasOwn(FACTORIES, id) ? FACTORIES[id] : undefined;
    if (!factory) {
      skipped.push({ id, reason: "no connector to sync yet" });
      continue;
    }
    const missing = factory.needs(env);
    if (missing.length) skipped.push({ id, reason: `missing ${missing.join(", ")}` });
    else connectors.push({ id, make: () => factory.make(env, store) });
  }
  return { connectors, skipped };
}

export interface SyncRunOutcome {
  id: string;
  mode: "historical" | "incremental";
  report?: SyncReport;
  /** The error's name and message only; connector errors never carry credentials. */
  error?: string;
}

export interface SyncRunnerOptions {
  connectors: readonly ScheduledConnector[];
  pipeline: BrainPipeline;
  memory: MemoryStore;
  organizationId: string;
  /** Pause between the end of one round and the start of the next. */
  intervalMs: number;
  log?: (line: string) => void;
  now?: () => Date;
  /** Replaced in tests. */
  sync?: typeof runSync;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

const describeError = (error: unknown) => {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};

export function createSyncRunner(options: SyncRunnerOptions) {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const sync = options.sync ?? runSync;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let timer: unknown;
  let running: Promise<SyncRunOutcome[]> | null = null;
  let stopped = true;

  async function runOne(scheduled: ScheduledConnector): Promise<SyncRunOutcome> {
    const { memory, organizationId } = options;
    let mode: SyncRunOutcome["mode"] = "historical";
    try {
      const connector = await scheduled.make();
      const done = await memory.getCheckpoint(organizationId, connector.source, HISTORICAL_COMPLETE);
      mode = done ? "incremental" : "historical";
      const report = await sync({ connector, mode, pipeline: options.pipeline, memory, organizationId });
      if (mode === "historical") await memory.saveCheckpoint(organizationId, connector.source, HISTORICAL_COMPLETE, now().toISOString());
      log(`sync ${scheduled.id} ${mode}: ${report.ingested} new, ${report.duplicates} duplicates, ${report.deadLettered} dead-lettered in ${report.batches} batches`);
      return { id: scheduled.id, mode, report };
    } catch (error) {
      const message = describeError(error);
      log(`sync ${scheduled.id} ${mode} failed: ${message}`);
      return { id: scheduled.id, mode, error: message };
    }
  }

  /** One round over every connector, one at a time. A round already in progress is joined, never doubled. */
  function runOnce(): Promise<SyncRunOutcome[]> {
    running ??= (async () => {
      const outcomes: SyncRunOutcome[] = [];
      for (const scheduled of options.connectors) outcomes.push(await runOne(scheduled));
      return outcomes;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function schedule(ms: number): void {
    if (stopped) return;
    timer = setTimer(() => {
      void runOnce().then(() => schedule(options.intervalMs));
    }, ms);
  }

  return {
    runOnce,
    /** Starts the first round right away, then one every interval after the previous round ends. */
    start(): void {
      if (!stopped || options.connectors.length === 0) return;
      stopped = false;
      schedule(0);
    },
    /** Stops scheduling and waits for a round in progress to finish. */
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      await running;
    },
  };
}
