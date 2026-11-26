import { measureValue, type BrainPipeline, type HeldBack, type MemoryStore, type ReasoningRun as StoredReasoningRun, type Recommendation } from "@karatos/core";
import type { BriefReasoningInput } from "@karatos/retail";
import type { SyncRunOutcome } from "./sync.js";

/**
 * Scheduled reasoning: running the department rules (payout matching, stock
 * agreement, customers awaiting a reply and the rest) on their own, so the
 * findings the daily brief and the ask endpoint read stay fresh without
 * anyone calling POST /v1/reason. Runs never overlap, POST /v1/reason calls
 * included, and a failed run is logged with counts only and tried again at
 * the next trigger.
 */

export const DEFAULT_REASON_INTERVAL_MINUTES = 60;

/** A brief built this soon after a successful run uses that run's findings instead of reasoning again. */
export const REASON_BRIEF_REUSE_MS = 10 * 60_000;

/** What one reasoning pass returns. heldBack lists what the feedback loop's cooldown kept back; absent counts as none. */
export interface ReasonPass {
  recommendations: Recommendation[];
  measured: number;
  heldBack?: HeldBack[];
}

/**
 * One reasoning pass, as POST /v1/reason does it: the department rules over
 * recent signals, shaped by feedback on earlier recommendations, then the
 * results now due on approved recommendations.
 */
export async function reasonNow(
  pipeline: BrainPipeline,
  memory: MemoryStore,
  organizationId: string,
  now: () => Date = () => new Date(),
): Promise<Required<ReasonPass>> {
  const { recommendations, heldBack } = await pipeline.reasonWithFeedback(organizationId);
  // Each run also records the results now due on approved recommendations.
  const measured = await measureValue(memory, organizationId, now().toISOString());
  return { recommendations, measured: measured.length, heldBack };
}

/** What the runner starts on its own: after a sync round that brought new events, on the interval, or before the daily brief. */
export type ScheduledReasoningTrigger = "sync" | "interval" | "brief";

/** What started a run: a scheduled trigger, or a POST /v1/reason call ("manual"). */
export type ReasoningTrigger = ScheduledReasoningTrigger | "manual";

/** One finished run, as counts and times. Never recommendations or their text. */
export interface ReasoningRun {
  /** Null for a run read back from the database after a restart, which doesn't store what started it. */
  trigger: ReasoningTrigger | null;
  outcome: "succeeded" | "failed";
  startedAt: string;
  finishedAt: string;
  /** Recommendations the run raised; null when it failed. */
  recommendations: number | null;
  /** Value results it recorded; null when it failed, or when it was read back from the database, which doesn't store them. */
  measured: number | null;
  /** The error's class name only, never its message, which could quote business data. Null when it succeeded. */
  error: string | null;
}

/** The runner's state for GET /v1/support/status: times, outcome and counts only. */
export interface SupportReasoningStatus {
  scheduled: boolean;
  /** REASON_INTERVAL_MINUTES; null when scheduled reasoning is off. */
  intervalMinutes: number | null;
  /** The last finished run, scheduled or manual; after a restart, the last one in the database. Null when there is none. */
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

/**
 * The last run in the database, for the runner to start from after a restart,
 * or null when there is none. Only a rules pass that finished is stored, so it
 * reads as succeeded; what started it and what it measured aren't stored, so
 * those are null. A failed read is logged with the error's class name and
 * counts as no run.
 */
export async function readLastRun(memory: MemoryStore, organizationId: string, log: (line: string) => void = (line) => console.log(line)): Promise<ReasoningRun | null> {
  let stored: StoredReasoningRun | null;
  try {
    stored = await memory.latestReasoningRun(organizationId);
  } catch (error) {
    log(`reasoning: the last run couldn't be read (${errorName(error)}), so none is reported until the next one`);
    return null;
  }
  if (!stored) return null;
  return {
    trigger: null,
    outcome: "succeeded",
    startedAt: stored.startedAt,
    finishedAt: stored.finishedAt,
    recommendations: stored.recommendationIds.length,
    measured: null,
    error: null,
  };
}

export interface ReasoningRunnerOptions {
  /** One pass, returning its counts. In an instance, reasonNow over its pipeline. */
  reason: () => Promise<{ recommendations: number; measured: number }>;
  /** The longest gap between the end of one run and the start of the next. */
  intervalMs: number;
  /** False when REASON_SCHEDULE is off: start() does nothing and only manual runs happen, still recorded. Default true. */
  scheduled?: boolean;
  /** The run to report until one finishes here: the last one in the database, from readLastRun. */
  lastRun?: ReasoningRun | null;
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
 * POST /v1/reason runs through manual(), in the same line, so it never
 * overlaps a scheduled run either and is reported the same way.
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
  const scheduled = options.scheduled ?? true;
  let running: Promise<ReasoningRun> | null = null;
  let queued: { trigger: ScheduledReasoningTrigger; promise: Promise<ReasoningRun | null>; resolve: (run: ReasoningRun | null | Promise<ReasoningRun>) => void } | null = null;
  /** Manual runs waiting for the run in progress, first come first served. Each goes before a queued scheduled run. */
  const manualQueue: (() => void)[] = [];
  let last: ReasoningRun | null = options.lastRun ? { ...options.lastRun } : null;
  let lastSucceededAt: string | null = last?.outcome === "succeeded" ? last.finishedAt : null;
  let failures = 0;

  type Counts = { recommendations: number; measured: number };
  type Attempt<T> = { run: ReasoningRun; ok: true; value: T } | { run: ReasoningRun; ok: false; error: unknown };

  async function attempt<T>(trigger: ReasoningTrigger, pass: () => Promise<T>, count: (value: T) => Counts): Promise<Attempt<T>> {
    const startedAt = now().toISOString();
    try {
      const value = await pass();
      const counts = count(value);
      failures = 0;
      const finishedAt = now().toISOString();
      lastSucceededAt = finishedAt;
      log(`reasoning (${trigger}): ${counts.recommendations} recommendations, ${counts.measured} results measured`);
      return { ok: true, value, run: { trigger, outcome: "succeeded", startedAt, finishedAt, recommendations: counts.recommendations, measured: counts.measured, error: null } };
    } catch (error) {
      failures++;
      const name = errorName(error);
      log(`reasoning (${trigger}) failed: ${name}, ${failures} failed in a row; tried again at the next trigger`);
      return { ok: false, error, run: { trigger, outcome: "failed", startedAt, finishedAt: now().toISOString(), recommendations: null, measured: null, error: name } };
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

  /** Runs one pass as the only run in progress. Every caller has checked that none is. */
  function exclusive<T>(reason: ReasoningTrigger, pass: () => Promise<T>, count: (value: T) => Counts): Promise<Attempt<T>> {
    // The interval restarts when this run ends; no interval run fires during it.
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    const done = attempt(reason, pass, count).then((result) => {
      last = result.run;
      running = null;
      // A waiting manual run goes next; a queued scheduled run waits for it.
      const manual = manualQueue.shift();
      if (manual) {
        manual();
        return result;
      }
      const next = queued;
      queued = null;
      if (next) next.resolve(closed ? last : begin(next.trigger));
      else schedule(options.intervalMs);
      return result;
    });
    running = done.then((result) => result.run);
    return done;
  }

  function begin(reason: ScheduledReasoningTrigger): Promise<ReasoningRun> {
    return exclusive(reason, options.reason, (counts) => counts).then((result) => result.run);
  }

  /** Starts a run, or, while one is in progress, queues one after it. Resolves with the run that covers this trigger; null once stopped. */
  function trigger(reason: ScheduledReasoningTrigger): Promise<ReasoningRun | null> {
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
    /**
     * A POST /v1/reason call: runs this request's own pass, recorded with
     * trigger "manual", and answers with that pass's own result, or throws its
     * error. While another run is in progress it waits for that run to end
     * rather than joining it, since a run that started earlier may not have
     * seen what the caller just sent; it then goes before a queued scheduled
     * run. It runs even after stop(), so a request in flight at shutdown is
     * still answered.
     */
    manual<T extends { recommendations: readonly unknown[]; measured: number }>(pass: () => Promise<T>): Promise<T> {
      const go = () =>
        exclusive("manual", pass, (value) => ({ recommendations: value.recommendations.length, measured: value.measured })).then((result) => {
          if (!result.ok) throw result.error;
          return result.value;
        });
      if (!running) return go();
      return new Promise<T>((resolve, reject) => manualQueue.push(() => void go().then(resolve, reject)));
    },
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
    /** The last finished run, scheduled or manual, or the one read from the database at startup. */
    latest: (): ReasoningRun | null => last,
    /** What the brief and the ask endpoint say about how fresh the findings are. */
    status(): BriefReasoningInput {
      return { scheduled, last: last ? { outcome: last.outcome, finishedAt: last.finishedAt } : null, refreshedAt: lastSucceededAt };
    },
    supportStatus(): SupportReasoningStatus {
      return { scheduled, intervalMinutes: scheduled ? options.intervalMs / 60_000 : null, lastRun: last ? { ...last } : null, lastSucceededAt, consecutiveFailures: failures };
    },
    /** Starts the interval, unless scheduled reasoning is off. The first run comes after the first sync round that brings events, the daily brief, or one interval, whichever is first. */
    start(): void {
      if (!scheduled || !stopped || closed) return;
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
