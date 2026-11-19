import type { BriefStore, MemoryStore, StoredEvent } from "@karatos/core";
import {
  addDays,
  BRIEF_MAX_EVENTS_PER_DAY,
  BRIEF_OPEN_LOOKBACK_DAYS,
  BRIEF_SALE_TYPES,
  buildDailyBrief,
  dayBounds,
  localDay,
  wallClock,
  zonedInstant,
  type BriefEvents,
  type BriefSyncInput,
  type DailyBrief,
} from "@karatos/retail";

/**
 * The daily brief on a running instance: reading what one day's brief needs
 * from the store, and building yesterday's brief once each morning at the
 * store's local hour. See docs/daily-brief.md.
 */

export const DEFAULT_BRIEF_HOUR = 7;

/** After a failed build, the next try. */
export const BRIEF_RETRY_MS = 15 * 60_000;

/** How long a webhook delivery may take before it is given up. */
export const BRIEF_WEBHOOK_TIMEOUT_MS = 10_000;

export interface BriefSources {
  memory: MemoryStore;
  organizationId: string;
  timeZone: string;
  /** What the sync runner knows now. Absent: the brief says sync results aren't available. */
  sync?: () => BriefSyncInput;
  now?: () => Date;
}

async function readDay(memory: MemoryStore, organizationId: string, bounds: { from: string; to: string }): Promise<BriefEvents> {
  const events: StoredEvent[] = await memory.eventsBetween(organizationId, BRIEF_SALE_TYPES, bounds.from, bounds.to, BRIEF_MAX_EVENTS_PER_DAY + 1);
  return { events: events.slice(0, BRIEF_MAX_EVENTS_PER_DAY), truncated: events.length > BRIEF_MAX_EVENTS_PER_DAY };
}

/** The store day before the one `now` falls on. */
export function yesterdayIn(now: Date, timeZone: string): string {
  return addDays(localDay(now.getTime(), timeZone), -1);
}

/**
 * Reads everything a day's brief needs and builds it. Recommendations count
 * if they were raised in the BRIEF_OPEN_LOOKBACK_DAYS before the morning after
 * the day (or before now, for a day that has just ended or is under way).
 */
export async function readDailyBrief(sources: BriefSources, date: string): Promise<DailyBrief> {
  const { memory, organizationId, timeZone } = sources;
  const now = (sources.now ?? (() => new Date()))();
  const day = dayBounds(date, timeZone);
  const lastWeek = dayBounds(addDays(date, -7), timeZone);
  const until = Math.min(now.getTime(), Date.parse(day.to) + 86_400_000);
  const since = until - BRIEF_OPEN_LOOKBACK_DAYS * 86_400_000;
  const recommendations = await memory.recommendationsBetween(organizationId, new Date(since).toISOString(), new Date(until).toISOString());
  const [dayEvents, lastWeekEvents, lastSaleBefore, feedback] = await Promise.all([
    readDay(memory, organizationId, day),
    readDay(memory, organizationId, lastWeek),
    memory.latestEventBefore(organizationId, BRIEF_SALE_TYPES, day.from),
    memory.listFeedback(organizationId, recommendations.map((r) => r.id)),
  ]);
  return buildDailyBrief({
    organizationId,
    date,
    timeZone,
    generatedAt: now.toISOString(),
    day: dayEvents,
    lastWeek: lastWeekEvents,
    lastSaleBefore,
    recommendations,
    feedback,
    ...(sources.sync ? { sync: sources.sync() } : {}),
  });
}

/**
 * Sends a brief to an operator's webhook: one JSON POST, https only, with a
 * timeout. Never retried, so a slow or failing receiver can't hold up the
 * instance. Errors name the status, never the URL, which may carry a token.
 */
export function webhookDelivery(url: string, fetcher: typeof fetch = fetch, timeoutMs = BRIEF_WEBHOOK_TIMEOUT_MS): (brief: DailyBrief) => Promise<void> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("BRIEF_WEBHOOK_URL must be an https URL");
  return async (brief) => {
    const response = await fetcher(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "karatos.daily_brief", brief }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`the brief webhook answered ${response.status}`);
  };
}

export interface BriefRunnerOptions {
  store: BriefStore;
  organizationId: string;
  timeZone: string;
  /** The store's local hour, 0 to 23, from which yesterday's brief is built. */
  hour: number;
  build: (date: string) => Promise<DailyBrief>;
  /** Where a newly built brief is sent, when an operator set one up. */
  deliver?: (brief: DailyBrief) => Promise<void>;
  log?: (line: string) => void;
  now?: () => Date;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** What one check did. */
export type BriefRunResult =
  | { outcome: "not_due"; date: string }
  | { outcome: "already_built"; date: string }
  | { outcome: "built"; date: string; brief: DailyBrief; delivered: boolean | null }
  | { outcome: "failed"; date: string; error: string };

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : "unknown error").slice(0, 300);

function counts(brief: DailyBrief): string {
  if (!brief.hasData) return "no synced data to report";
  const s = brief.sales;
  const sales = s.status === "no_data" ? "no sales data" : `${s.day.totals.sales} sales, ${s.day.totals.refunds} refunds${s.status === "partial" ? " (partial)" : ""}`;
  const sync = brief.sync.known ? brief.sync.problems.length : 0;
  return `${sales}, ${brief.unusual.length} unusual, ${sync} sync problems, ${brief.waiting.length + brief.moreWaiting} waiting`;
}

/**
 * Builds yesterday's brief once a day, at the configured local hour. Each
 * check looks at the store's own clock: once the hour has come and the day
 * before has no saved brief, it builds, saves and (if set up) delivers it.
 * The saved brief is what stops a second build, so a restart after the hour
 * never builds or sends the same day twice, and a restart before it waits.
 * A day missed while the instance was down is not built late.
 */
export function createBriefRunner(options: BriefRunnerOptions) {
  if (!Number.isInteger(options.hour) || options.hour < 0 || options.hour > 23) throw new RangeError("the brief hour must be a whole hour from 0 to 23");
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const { timeZone, hour, organizationId } = options;
  let timer: unknown;
  let running: Promise<BriefRunResult> | null = null;
  let stopped = true;

  async function check(): Promise<BriefRunResult> {
    const at = now();
    const date = yesterdayIn(at, timeZone);
    if (Number(wallClock(at.getTime(), timeZone).slice(11, 13)) < hour) return { outcome: "not_due", date };
    try {
      if (await options.store.getBrief(organizationId, date)) return { outcome: "already_built", date };
      const brief = await options.build(date);
      const saved = await options.store.saveBrief({ organizationId, date, generatedAt: brief.generatedAt, brief: brief as unknown as Record<string, unknown> });
      if (!saved) return { outcome: "already_built", date };
      log(`brief ${date} built: ${counts(brief)}`);
      let delivered: boolean | null = null;
      if (options.deliver) {
        try {
          await options.deliver(brief);
          delivered = true;
          log(`brief ${date} sent to the webhook`);
        } catch (error) {
          delivered = false;
          log(`brief ${date} webhook failed: ${describe(error)}`);
        }
      }
      return { outcome: "built", date, brief, delivered };
    } catch (error) {
      const message = describe(error);
      log(`brief ${date} failed: ${message}`);
      return { outcome: "failed", date, error: message };
    }
  }

  /** One check. A check in progress is joined, never doubled. */
  function runOnce(): Promise<BriefRunResult> {
    running ??= check().finally(() => {
      running = null;
    });
    return running;
  }

  /** Milliseconds from `at` to the next time the hour comes round on the store's clock. */
  function untilNext(at: Date): number {
    const today = localDay(at.getTime(), timeZone);
    const todays = zonedInstant(today, hour, timeZone);
    const next = todays > at.getTime() ? todays : zonedInstant(addDays(today, 1), hour, timeZone);
    return next - at.getTime();
  }

  function schedule(ms: number): void {
    if (stopped) return;
    timer = setTimer(() => {
      void runOnce().then((result) => schedule(result.outcome === "failed" ? BRIEF_RETRY_MS : untilNext(now())));
    }, ms);
  }

  return {
    runOnce,
    untilNext,
    /** Checks right away, so a brief due while the instance was restarting is built now, then at the hour each day. */
    start(): void {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    /** Stops scheduling and waits for a check in progress to finish. */
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      await running;
    },
  };
}
