import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { GA4_MAX_RANGE_DAYS, ga4DayMs, googleAnalyticsClient, type GoogleAnalyticsClient, type GoogleAnalyticsClientOptions } from "./client.js";
import { ga4Page, ga4PageEvents, type Ga4Context } from "./normalize.js";

/**
 * Reads the traffic and product reports of one GA4 property, a month-long
 * window at a time. The historical import reads two years, up to today;
 * incremental syncs read again from GA4_REVISIT_DAYS before the last day the
 * previous pass read, since GA4 keeps adding late hits to recent days, and a
 * revised row is stored as a new version.
 */

/** Analytics is read-only: there is nothing to write, now or later. */
export const GA4_WRITES: WriteAction[] = [];

/** Each incremental pass reads again from this many days before the previous pass's last day. */
export const GA4_REVISIT_DAYS = 3;

type Step = "traffic" | "products" | "done";

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface Ga4Cursor {
  pass: "historical" | "incremental";
  step: Step;
  /** The first day of the pass, YYYY-MM-DD. */
  from: string;
  /** The last day of the pass. */
  until: string;
  /** The first day of the window being read. */
  windowStart: string;
  offset: number;
}

export interface GoogleAnalyticsConnectorOptions extends GoogleAnalyticsClientOptions {
  historyYears?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: GoogleAnalyticsClient;
}

const STEPS: Step[] = ["traffic", "products", "done"];
const DAY_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function parseGa4Cursor(raw: string | null): Ga4Cursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as Ga4Cursor;
  if (
    !c ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    ![c.from, c.until, c.windowStart].every((d) => !Number.isNaN(ga4DayMs(d))) ||
    // The window's start lies within the pass, which also means the pass doesn't end before it starts.
    ga4DayMs(c.windowStart) < ga4DayMs(c.from) ||
    ga4DayMs(c.windowStart) > ga4DayMs(c.until) ||
    !Number.isInteger(c.offset) ||
    c.offset < 0
  ) {
    throw new Error("Google Analytics checkpoint is not in the expected shape");
  }
  return c;
}

export function googleAnalyticsConnector(options: GoogleAnalyticsConnectorOptions): Connector {
  const client = options.client ?? googleAnalyticsClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 2;
  const today = () => day(now().getTime());

  function start(pass: Ga4Cursor["pass"], from: string): Ga4Cursor {
    return { pass, step: "traffic", from, until: today(), windowStart: from, offset: 0 };
  }

  function startHistorical(): Ga4Cursor {
    const first = new Date(`${today()}T00:00:00Z`);
    first.setUTCFullYear(first.getUTCFullYear() - historyYears);
    return start("historical", day(first.getTime()));
  }

  function startIncremental(previous: Ga4Cursor | null): Ga4Cursor {
    const last = previous ? ga4DayMs(previous.until) : ga4DayMs(today());
    return start("incremental", day(Math.min(last - GA4_REVISIT_DAYS * DAY_MS, ga4DayMs(today()))));
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseGa4Cursor(context.cursor);
    let cursor: Ga4Cursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved);
    }

    while (cursor.step !== "done") {
      const report = cursor.step;
      const windowEnd = day(Math.min(ga4DayMs(cursor.windowStart) + (GA4_MAX_RANGE_DAYS - 1) * DAY_MS, ga4DayMs(cursor.until)));
      const page = ga4Page(report, await client.runReport({ report, startDate: cursor.windowStart, endDate: windowEnd, offset: cursor.offset }));
      const ctx: Ga4Context = { propertyId: client.propertyId, receivedAt: now().toISOString() };
      const events = ga4PageEvents(report, page, ctx);
      const read = cursor.offset + page.rows.length;
      // GA4 says how many rows the report has; a page may hold fewer than asked for.
      if (page.rows.length > 0 && read < page.rowCount) {
        cursor = { ...cursor, offset: read };
      } else if (windowEnd < cursor.until) {
        cursor = { ...cursor, windowStart: day(ga4DayMs(windowEnd) + DAY_MS), offset: 0 };
      } else {
        cursor = { ...cursor, step: STEPS[STEPS.indexOf(report) + 1]!, windowStart: cursor.from, offset: 0 };
      }
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "google_analytics",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: GA4_WRITES,
  };
}
