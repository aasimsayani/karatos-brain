import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { META_ADS_MAX_RANGE_DAYS, metaAdsClient, metaAdsDayMs, type MetaAdsClient, type MetaAdsClientOptions } from "./client.js";
import { metaAdsPage, metaAdsPageEvents, type MetaAdsContext } from "./normalize.js";

/**
 * Reads one Meta ad account's campaign insights by day, a month-long window
 * at a time. The historical import reads two years, up to today, as far
 * back as Meta keeps daily insights (37 months); incremental syncs read again
 * from META_ADS_REVISIT_DAYS before the last day the previous pass read,
 * since Meta keeps attributing purchases to past views and clicks, and a
 * revised row is stored as a new version.
 */

/**
 * Declared so they can be gated and audited; none runs while writes are off,
 * and the token holds ads_read only. Both change what the store spends, so
 * each needs a named person's approval and is capped low.
 */
export const META_ADS_WRITES: WriteAction[] = [
  { integration: "meta_ads", name: "pause_campaign", description: "Pause a Meta Ads campaign that is spending without bringing in sales", kind: "update", approval: "each", dailyCap: 5 },
  { integration: "meta_ads", name: "set_campaign_budget", description: "Change a Meta Ads campaign's daily budget", kind: "update", approval: "each", dailyCap: 5 },
];

/** Each incremental pass reads again from this many days before the previous pass's last day. */
export const META_ADS_REVISIT_DAYS = 14;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface MetaAdsCursor {
  pass: "historical" | "incremental";
  done: boolean;
  /** The first day of the pass, YYYY-MM-DD. */
  from: string;
  /** The last day of the pass. */
  until: string;
  /** The first day of the window being read. */
  windowStart: string;
  /** Meta's cursor for the next page of the window, or null for its first page. */
  after: string | null;
}

export interface MetaAdsConnectorOptions extends MetaAdsClientOptions {
  historyYears?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: MetaAdsClient;
}

const DAY_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function parseMetaAdsCursor(raw: string | null): MetaAdsCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as MetaAdsCursor;
  if (
    !c ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    typeof c.done !== "boolean" ||
    ![c.from, c.until, c.windowStart].every((d) => !Number.isNaN(metaAdsDayMs(d))) ||
    // The window's start lies within the pass, which also means the pass doesn't end before it starts.
    metaAdsDayMs(c.windowStart) < metaAdsDayMs(c.from) ||
    metaAdsDayMs(c.windowStart) > metaAdsDayMs(c.until) ||
    (c.after !== null && typeof c.after !== "string")
  ) {
    throw new Error("Meta Ads checkpoint is not in the expected shape");
  }
  return c;
}

export function metaAdsConnector(options: MetaAdsConnectorOptions): Connector {
  const client = options.client ?? metaAdsClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 2;
  const today = () => day(now().getTime());

  function start(pass: MetaAdsCursor["pass"], from: string): MetaAdsCursor {
    return { pass, done: false, from, until: today(), windowStart: from, after: null };
  }

  function startHistorical(): MetaAdsCursor {
    const first = new Date(`${today()}T00:00:00Z`);
    first.setUTCFullYear(first.getUTCFullYear() - historyYears);
    return start("historical", day(first.getTime()));
  }

  function startIncremental(previous: MetaAdsCursor | null): MetaAdsCursor {
    const last = previous ? metaAdsDayMs(previous.until) : metaAdsDayMs(today());
    return start("incremental", day(Math.min(last - META_ADS_REVISIT_DAYS * DAY_MS, metaAdsDayMs(today()))));
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseMetaAdsCursor(context.cursor);
    let cursor: MetaAdsCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && !saved.done ? saved : startIncremental(saved);
    }

    while (!cursor.done) {
      const windowEnd = day(Math.min(metaAdsDayMs(cursor.windowStart) + (META_ADS_MAX_RANGE_DAYS - 1) * DAY_MS, metaAdsDayMs(cursor.until)));
      const page = metaAdsPage(await client.insights({ since: cursor.windowStart, until: windowEnd, after: cursor.after }));
      const ctx: MetaAdsContext = { accountId: client.accountId, receivedAt: now().toISOString() };
      const events = metaAdsPageEvents(page, ctx);
      if (page.after) {
        cursor = { ...cursor, after: page.after };
      } else if (windowEnd < cursor.until) {
        cursor = { ...cursor, windowStart: day(metaAdsDayMs(windowEnd) + DAY_MS), after: null };
      } else {
        cursor = { ...cursor, done: true, windowStart: cursor.from, after: null };
      }
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "meta_ads",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: META_ADS_WRITES,
  };
}
