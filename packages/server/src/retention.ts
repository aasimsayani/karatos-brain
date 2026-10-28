import type { PurgeResult, RawDataRetention } from "@karatos/core";

/**
 * Clears raw vendor data past RAW_RETENTION_DAYS once a day. The first purge
 * runs when the instance starts. Purges never overlap, a failed purge is
 * logged and retried at the next interval, and each purge records itself in
 * the store so the owner can see it ran.
 */

export const RETENTION_INTERVAL_MS = 24 * 60 * 60_000;

export interface RetentionRunnerOptions {
  store: RawDataRetention;
  organizationId: string;
  retentionDays: number;
  /** Defaults to once a day. */
  intervalMs?: number;
  log?: (line: string) => void;
  now?: () => Date;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export function createRetentionRunner(options: RetentionRunnerOptions) {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? RETENTION_INTERVAL_MS;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let timer: unknown;
  let running: Promise<PurgeResult | null> | null = null;
  let stopped = true;

  /** One purge. A purge already in progress is joined, never doubled. Resolves null when it failed. */
  function runOnce(): Promise<PurgeResult | null> {
    running ??= options.store
      .purgeRawData(options.organizationId, now(), options.retentionDays)
      .then(
        (result) => {
          log(
            `retention: cleared raw data older than ${result.retentionDays} days from ${result.events} events, ${result.deadLetters} dead letters and ${result.fileImports} file imports`,
          );
          return result;
        },
        (error: unknown) => {
          log(`retention failed: ${error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown error"}`);
          return null;
        },
      )
      .finally(() => {
        running = null;
      });
    return running;
  }

  function schedule(ms: number): void {
    if (stopped) return;
    timer = setTimer(() => {
      void runOnce().then(() => schedule(intervalMs));
    }, ms);
  }

  return {
    runOnce,
    start(): void {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      await running;
    },
  };
}
