import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { GOOGLE_ADS_MAX_RANGE_DAYS, googleAdsClient, googleAdsDayMs, type GoogleAdsClient, type GoogleAdsClientOptions } from "./client.js";
import { googleAdsPage, googleAdsPageEvents, type GoogleAdsContext } from "./normalize.js";

/**
 * Reads one Google Ads account's campaign figures by day, a month-long
 * window at a time. The historical import reads two years, up to today;
 * incremental syncs read again from GOOGLE_ADS_REVISIT_DAYS before the last
 * day the previous pass read, since Google keeps attributing conversions to
 * past clicks, and a revised row is stored as a new version.
 */

/**
 * Declared so they can be gated and audited; none runs while writes are off,
 * and the client only reads. Both change what the store spends, so each
 * needs a named person's approval and is capped low.
 */
export const GOOGLE_ADS_WRITES: WriteAction[] = [
  { integration: "google_ads", name: "pause_campaign", description: "Pause a Google Ads campaign that is spending without bringing in sales", kind: "update", approval: "each", dailyCap: 5 },
  { integration: "google_ads", name: "set_campaign_budget", description: "Change a Google Ads campaign's daily budget", kind: "update", approval: "each", dailyCap: 5 },
];

/** Each incremental pass reads again from this many days before the previous pass's last day. */
export const GOOGLE_ADS_REVISIT_DAYS = 14;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface GoogleAdsCursor {
  pass: "historical" | "incremental";
  done: boolean;
  /** The first day of the pass, YYYY-MM-DD. */
  from: string;
  /** The last day of the pass. */
  until: string;
  /** The first day of the window being read. */
  windowStart: string;
  /** Google's token for the next page of the window, or null for its first page. */
  pageToken: string | null;
}

export interface GoogleAdsConnectorOptions extends GoogleAdsClientOptions {
  historyYears?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: GoogleAdsClient;
}

const DAY_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function parseGoogleAdsCursor(raw: string | null): GoogleAdsCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as GoogleAdsCursor;
  if (
    !c ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    typeof c.done !== "boolean" ||
    ![c.from, c.until, c.windowStart].every((d) => !Number.isNaN(googleAdsDayMs(d))) ||
    // The window's start lies within the pass, which also means the pass doesn't end before it starts.
    googleAdsDayMs(c.windowStart) < googleAdsDayMs(c.from) ||
    googleAdsDayMs(c.windowStart) > googleAdsDayMs(c.until) ||
    (c.pageToken !== null && typeof c.pageToken !== "string")
  ) {
    throw new Error("Google Ads checkpoint is not in the expected shape");
  }
  return c;
}

export function googleAdsConnector(options: GoogleAdsConnectorOptions): Connector {
  const client = options.client ?? googleAdsClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 2;
  const today = () => day(now().getTime());

  function start(pass: GoogleAdsCursor["pass"], from: string): GoogleAdsCursor {
    return { pass, done: false, from, until: today(), windowStart: from, pageToken: null };
  }

  function startHistorical(): GoogleAdsCursor {
    const first = new Date(`${today()}T00:00:00Z`);
    first.setUTCFullYear(first.getUTCFullYear() - historyYears);
    return start("historical", day(first.getTime()));
  }

  function startIncremental(previous: GoogleAdsCursor | null): GoogleAdsCursor {
    const last = previous ? googleAdsDayMs(previous.until) : googleAdsDayMs(today());
    return start("incremental", day(Math.min(last - GOOGLE_ADS_REVISIT_DAYS * DAY_MS, googleAdsDayMs(today()))));
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseGoogleAdsCursor(context.cursor);
    let cursor: GoogleAdsCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && !saved.done ? saved : startIncremental(saved);
    }

    while (!cursor.done) {
      const windowEnd = day(Math.min(googleAdsDayMs(cursor.windowStart) + (GOOGLE_ADS_MAX_RANGE_DAYS - 1) * DAY_MS, googleAdsDayMs(cursor.until)));
      const page = googleAdsPage(await client.search({ startDate: cursor.windowStart, endDate: windowEnd, pageToken: cursor.pageToken }));
      const ctx: GoogleAdsContext = { customerId: client.customerId, receivedAt: now().toISOString() };
      const events = googleAdsPageEvents(page, ctx);
      if (page.nextPageToken) {
        cursor = { ...cursor, pageToken: page.nextPageToken };
      } else if (windowEnd < cursor.until) {
        cursor = { ...cursor, windowStart: day(googleAdsDayMs(windowEnd) + DAY_MS), pageToken: null };
      } else {
        cursor = { ...cursor, done: true, windowStart: cursor.from, pageToken: null };
      }
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "google_ads",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: GOOGLE_ADS_WRITES,
  };
}
