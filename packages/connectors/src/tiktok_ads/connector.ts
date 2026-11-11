import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { TIKTOK_ADS_MAX_RANGE_DAYS, tiktokAdsClient, tiktokAdsDayMs, type TikTokAdsClient, type TikTokAdsClientOptions } from "./client.js";
import { tiktokAdsCampaignEvent } from "./normalize.js";

/**
 * Reads one TikTok advertiser's campaign report by day, 30 days at a time.
 * The historical import reads two years, up to today; each later sync reads
 * again from TIKTOK_ADS_REVISIT_DAYS before the last day the previous pass
 * read, since TikTok keeps attributing purchases to past views and clicks
 * for up to 28 days, and a revised row is stored as a new version.
 *
 * Each page is one batch and one checkpoint, which keeps the pass's days,
 * the window being read and its next page, so a resumed pass goes on from
 * there.
 */

/**
 * Declared so they can be gated and audited; none runs while writes are off,
 * and the app holds read scopes only. Both change what the store spends, so
 * each needs a named person's approval and is capped low.
 */
export const TIKTOK_ADS_WRITES: WriteAction[] = [
  { integration: "tiktok_ads", name: "pause_campaign", description: "Pause a TikTok Ads campaign that is spending without bringing in sales", kind: "update", approval: "each", dailyCap: 5 },
  { integration: "tiktok_ads", name: "resume_campaign", description: "Resume a paused TikTok Ads campaign", kind: "update", approval: "each", dailyCap: 5 },
];

/** Each later pass reads again from this many days before the previous pass's last day: TikTok's longest attribution window. */
export const TIKTOK_ADS_REVISIT_DAYS = 28;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface TikTokAdsCursor {
  pass: "historical" | "incremental";
  done: boolean;
  /** The first day of the pass, YYYY-MM-DD. */
  from: string;
  /** The last day of the pass. */
  until: string;
  /** The first day of the window being read. */
  windowStart: string;
  /** The window's next page, from 1. */
  page: number;
}

export interface TikTokAdsOptions extends TikTokAdsClientOptions {
  /** Days older than this many years are skipped. Defaults to 2. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: TikTokAdsClient;
}

const DAY_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function parseTikTokAdsCursor(raw: string | null): TikTokAdsCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    c = null;
  }
  // Anything but an object reads as a checkpoint without the fields asked for.
  const r = (c ?? {}) as Record<string, unknown>;
  const [from, until, windowStart] = [r.from, r.until, r.windowStart].map(tiktokAdsDayMs) as [number, number, number];
  // The window's start lies within the pass, which also means the pass doesn't end before it starts.
  const ok = (r.pass === "historical" || r.pass === "incremental") && typeof r.done === "boolean" && from <= windowStart && windowStart <= until && Number.isSafeInteger(r.page) && (r.page as number) >= 1;
  if (!ok) throw new Error("TikTok Ads checkpoint is not in the expected shape");
  return { pass: r.pass, done: r.done, from: r.from, until: r.until, windowStart: r.windowStart, page: r.page } as TikTokAdsCursor;
}

export function tiktokAdsConnector(options: TikTokAdsOptions): Connector {
  const client = options.client ?? tiktokAdsClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 2;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");
  const today = () => day(now().getTime());

  const start = (pass: TikTokAdsCursor["pass"], from: string): TikTokAdsCursor => ({ pass, done: false, from, until: today(), windowStart: from, page: 1 });

  function startHistorical(): TikTokAdsCursor {
    const first = new Date(`${today()}T00:00:00Z`);
    first.setUTCFullYear(first.getUTCFullYear() - historyYears);
    return start("historical", day(first.getTime()));
  }

  function startIncremental(previous: TikTokAdsCursor | null): TikTokAdsCursor {
    const t = tiktokAdsDayMs(today());
    const last = previous ? tiktokAdsDayMs(previous.until) : t;
    return start("incremental", day(Math.min(last - TIKTOK_ADS_REVISIT_DAYS * DAY_MS, t)));
  }

  async function* pages(mode: TikTokAdsCursor["pass"], context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseTikTokAdsCursor(context.cursor);
    // A finished import stays finished, and an interrupted pass resumes.
    let cursor = mode === "historical" ? (saved?.pass === "historical" ? saved : startHistorical()) : saved?.pass === "incremental" && !saved.done ? saved : startIncremental(saved);
    while (!cursor.done) {
      const windowEnd = day(Math.min(tiktokAdsDayMs(cursor.windowStart) + (TIKTOK_ADS_MAX_RANGE_DAYS - 1) * DAY_MS, tiktokAdsDayMs(cursor.until)));
      const result = await client.report({ start: cursor.windowStart, end: windowEnd, page: cursor.page });
      const receivedAt = now().toISOString();
      const events = result.rows.map((row) => tiktokAdsCampaignEvent(row, { advertiserId: client.advertiserId, receivedAt }));
      if (result.more) cursor = { ...cursor, page: cursor.page + 1 };
      else if (windowEnd < cursor.until) cursor = { ...cursor, windowStart: day(tiktokAdsDayMs(windowEnd) + DAY_MS), page: 1 };
      else cursor = { ...cursor, done: true, windowStart: cursor.from, page: 1 };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "tiktok_ads",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: TIKTOK_ADS_WRITES,
  };
}
