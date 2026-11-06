import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { tiktokClient, type TikTokClient, type TikTokClientOptions } from "./client.js";
import { tiktokAccountEvent, tiktokTime, tiktokVideoEvent, tiktokVideoPage, type TikTokBrainEvent, type TikTokContext } from "./normalize.js";

/**
 * Reads the account's counts, then its public videos, newest first, back to
 * a cutoff: two years on the historical import, and on each incremental
 * pass the videos posted in the last TIKTOK_REVISIT_DAYS, whose views and
 * likes are still moving. The video list has no change time, so a pass
 * re-reads those videos and only one whose counts changed is stored again.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the connection holds read scopes only. */
export const TIKTOK_WRITES: WriteAction[] = [
  { integration: "tiktok", name: "post_video", description: "Post a product video to the store's TikTok account", kind: "append", approval: "each", dailyCap: 5 },
];

/** The historical import reads videos posted in this many days. */
export const TIKTOK_HISTORY_DAYS = 731;
/** Each incremental pass re-reads videos posted in this many days. */
export const TIKTOK_REVISIT_DAYS = 90;

export const TIKTOK_STEPS = ["account", "videos", "done"] as const;
type Step = (typeof TIKTOK_STEPS)[number];

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface TikTokCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** The video list's cursor for the next page, or null for the first. */
  cursor: number | null;
  /** The pass's day, YYYY-MM-DD in UTC, fixed when it starts. */
  today: string;
  /** Videos posted before this day, YYYY-MM-DD in UTC, aren't read. */
  since: string;
}

export interface TikTokConnectorOptions extends TikTokClientOptions {
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: TikTokClient;
}

const DAY_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isDay = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && day(Date.parse(`${value}T00:00:00Z`)) === value;

export function parseTikTokCursor(raw: string | null): TikTokCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as TikTokCursor;
  if (
    !c ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !TIKTOK_STEPS.includes(c.step) ||
    (c.cursor !== null && !(Number.isSafeInteger(c.cursor) && c.cursor > 0)) ||
    // A page cursor belongs to the video list only.
    (c.cursor !== null && c.step !== "videos") ||
    !isDay(c.today) ||
    !isDay(c.since) ||
    c.since > c.today
  ) {
    throw new Error("TikTok checkpoint is not in the expected shape");
  }
  return c;
}

export function tiktokConnector(options: TikTokConnectorOptions): Connector {
  const client = options.client ?? tiktokClient(options);
  const now = options.now ?? (() => new Date());

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseTikTokCursor(context.cursor);
    const fresh = (pass: TikTokCursor["pass"]): TikTokCursor => {
      const ms = now().getTime();
      return { pass, step: "account", cursor: null, today: day(ms), since: day(ms - (pass === "historical" ? TIKTOK_HISTORY_DAYS : TIKTOK_REVISIT_DAYS - 1) * DAY_MS) };
    };
    let cursor: TikTokCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : fresh("historical");
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : fresh("incremental");
    }

    while (cursor.step !== "done") {
      const ctx: TikTokContext = { receivedAt: now().toISOString() };
      let events: TikTokBrainEvent[];
      if (cursor.step === "account") {
        events = [tiktokAccountEvent(await client.userInfo(), cursor.today, ctx)];
        cursor = { ...cursor, step: "videos" };
      } else {
        const page = tiktokVideoPage(await client.videos(cursor.cursor));
        const since = `${cursor.since}T00:00:00.000Z`;
        // Newest first, so once a page reaches past the cutoff every page after it would too.
        const times = page.videos.map((v) => tiktokTime(v.create_time));
        const kept = page.videos.filter((_, i) => times[i] === undefined || times[i]! >= since);
        events = kept.flatMap((v) => tiktokVideoEvent(v, ctx) ?? []);
        const reachedCutoff = times.some((t) => t !== undefined && t < since);
        cursor = page.cursor !== undefined && !reachedCutoff ? { ...cursor, cursor: page.cursor } : { ...cursor, step: "done", cursor: null };
      }
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "tiktok",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: TIKTOK_WRITES,
  };
}
