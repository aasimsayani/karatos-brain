import { measureValue, type BrainPipeline, type MemoryStore, type Recommendation } from "@karatos/core";
import type { BriefReasoningInput } from "@karatos/retail";
import type { SyncRunOutcome } from "./sync.js";

/**
 * Scheduled reasoning: running the department rules (payout matching, stock
 * agreement, customers awaiting a reply and the rest) on their own, so the
 * findings the daily brief and the ask endpoint read stay fresh without
 * anyone calling POST /v1/reason. Runs never overlap, and a failed run is
 * logged with counts only and tried again at the next trigger.
 */

export const DEFAULT_REASON_INTERVAL_MINUTES = 60;

/** A brief built this soon after a successful run uses that run's findings instead of reasoning again. */
export const REASON_BRIEF_REUSE_MS = 10 * 60_000;

/**
 * One reasoning pass, as POST /v1/reason does it: the department rules over
 * recent signals, then the results now due on approved recommendations.
 */
export async function reasonNow(
  pipeline: BrainPipeline,
  memory: MemoryStore,
  organizationId: string,
  now: () => Date = () => new Date(),
): Promise<{ recommendations: Recommendation[]; measured: number }> {
  const recommendations = await pipeline.reason(organizationId);
  // Each run also records the results now due on approved recommendations.
  const measured = await measureValue(memory, organizationId, now().toISOString());
  return { recommendations, measured: measured.length };
}

/** What started a run: a sync round that brought new events, the interval, or the daily brief. */
export type ReasoningTrigger = "sync" | "interval" | "brief";

/** One finished run, as counts and times. Never recommendations or their text. */
export interface ReasoningRun {
  trigger: ReasoningTrigger;
  outcome: "succeeded" | "failed";
  startedAt: string;
  finishedAt: string;
  /** Recommendations the run raised; null when it failed. */
  recommendations: number | null;
  /** Value results it recorded; null when it failed. */
  measured: number | null;
  /** The error's class name only, never its message, which could quote business data. Null when it succeeded. */
  error: string | null;
}

/** The runner's state for GET /v1/support/status: times, outcome and counts only. */
export interface SupportReasoningStatus {
  scheduled: boolean;
  /** REASON_INTERVAL_MINUTES; null when scheduled reasoning is off. */
  intervalMinutes: number | null;
  /** Null until a scheduled run has finished since the instance started. */
  lastRun: ReasoningRun | null;
  lastSucceededAt: string | null;
  /** Failed runs since the last one that succeeded. */
  consecutiveFailures: number;
}

/** What scheduled reasoning reports when REASON_SCHEDULE is off. */
export const REASONING_OFF: { brief: BriefReasoningInput; support: SupportReasoningStatus } = {
  brief: { scheduled: false, last: null, refreshedAt: null },
  support: { scheduled: false, intervalMinutes: null, lastRun: null, lastSucceededAt: null, consecutiveFailures: 0 },
};

export interface ReasoningRunnerOptions {
  /** One pass, returning its counts. In an instance, reasonNow over its pipeline. */
  reason: () => Promise<{ recommendations: number; measured: number }>;
  /** The longest gap between the end of one run and the start of the next. */
  intervalMs: number;
  briefReuseMs?: number;
  log?: (line: string) => void;
  now?: () => Date;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

/** An error's class name, fit for a log line or the support status. */
function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return ERROR_NAME.test(name) ? name : "UnknownError";
}

/**
 * Runs reasoning after each sync round that brought new events, and at least
 * every interval otherwise; the interval counts from the end of the last run,
 * whatever started it. A trigger while a run is in progress queues one more
 * run after it, and every further trigger joins that queued run, so two runs
 * never go at once and a burst of triggers costs one extra run at most.
 */
export function createReasoningRunner(options: ReasoningRunnerOptions) {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) throw new RangeError("the reasoning interval must be a positive number of milliseconds");
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const reuseMs = options.briefReuseMs ?? REASON_BRIEF_REUSE_MS;
  let timer: unknown;
  let stopped = true;
  let closed = false;
  let running: Promise<ReasoningRun> | null = null;
  let queued: { trigger: ReasoningTrigger; promise: Promise<ReasoningRun | null>; resolve: (run: ReasoningRun | null | Promise<ReasoningRun>) => void } | null = null;
  let last: ReasoningRun | null = null;
  let lastSucceededAt: string | null = null;
  let failures = 0;

  async function attempt(trigger: ReasoningTrigger): Promise<ReasoningRun> {
    const startedAt = now().toISOString();
    try {
      const counts = await options.reason();
      failures = 0;
      const finishedAt = now().toISOString();
      lastSucceededAt = finishedAt;
      log(`reasoning (${trigger}): ${counts.recommendations} recommendations, ${counts.measured} results measured`);
      return { trigger, outcome: "succeeded", startedAt, finishedAt, recommendations: counts.recommendations, measured: counts.measured, error: null };
    } catch (error) {
      failures++;
      const name = errorName(error);
      log(`reasoning (${trigger}) failed: ${name}, ${failures} failed in a row; tried again at the next trigger`);
      return { trigger, outcome: "failed", startedAt, finishedAt: now().toISOString(), recommendations: null, measured: null, error: name };
    }
  }

  /** Sets the interval timer. Every caller has just cleared it, or it was never set. */
  function schedule(ms: number): void {
    if (stopped) return;
    timer = setTimer(() => {
      timer = undefined;
      void trigger("interval");
    }, ms);
  }

  function begin(reason: ReasoningTrigger): Promise<ReasoningRun> {
    // The interval restarts when this run ends; no interval run fires during it.
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    const run = attempt(reason).then((result) => {
      last = result;
      running = null;
      const next = queued;
      queued = null;
      if (next) next.resolve(closed ? last : begin(next.trigger));
      else schedule(options.intervalMs);
      return result;
    });
    running = run;
    return run;
  }

  /** Starts a run, or, while one is in progress, queues one after it. Resolves with the run that covers this trigger; null once stopped. */
  function trigger(reason: ReasoningTrigger): Promise<ReasoningRun | null> {
    if (closed) return Promise.resolve(null);
    if (!running) return begin(reason);
    if (!queued) {
      let resolve!: (run: ReasoningRun | null | Promise<ReasoningRun>) => void;
      const promise = new Promise<ReasoningRun | null>((r) => (resolve = r));
      queued = { trigger: reason, promise, resolve };
    }
    return queued.promise;
  }

  return {
    trigger,
    /** After a sync round: reasons when any connector brought new events, and otherwise leaves it to the interval. */
    afterSync(outcomes: readonly SyncRunOutcome[]): Promise<ReasoningRun | null> | null {
      return outcomes.some((o) => (o.report?.ingested ?? 0) > 0) ? trigger("sync") : null;
    },
    /**
     * Before the daily brief is built: waits for a run in progress (and one
     * queued after it), reuses a run that succeeded within the reuse window,
     * and otherwise reasons now. A failure doesn't stop the brief, which says
     * when the findings were last refreshed.
     */
    async beforeBrief(): Promise<ReasoningRun | null> {
      if (running) return queued ? queued.promise : running;
      if (last?.outcome === "succeeded" && now().getTime() - Date.parse(last.finishedAt) <= reuseMs) return last;
      return trigger("brief");
    },
    /** The last finished run since the instance started. */
    latest: (): ReasoningRun | null => last,
    /** What the brief and the ask endpoint say about how fresh the findings are. */
    status(): BriefReasoningInput {
      return { scheduled: true, last: last ? { outcome: last.outcome, finishedAt: last.finishedAt } : null, refreshedAt: lastSucceededAt };
    },
    supportStatus(): SupportReasoningStatus {
      return { scheduled: true, intervalMinutes: options.intervalMs / 60_000, lastRun: last ? { ...last } : null, lastSucceededAt, consecutiveFailures: failures };
    },
    /** Starts the interval. The first run comes after the first sync round that brings events, the daily brief, or one interval, whichever is first. */
    start(): void {
      if (!stopped || closed) return;
      stopped = false;
      // A run in progress sets the interval when it ends.
      if (!running) schedule(options.intervalMs);
    },
    /** Stops the interval, drops a queued run and waits for a run in progress to finish. */
    async stop(): Promise<void> {
      stopped = true;
      closed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      await running;
    },
  };
}
