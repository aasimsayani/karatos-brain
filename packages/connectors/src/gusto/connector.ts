import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { GUSTO_PAGE_SIZE, gustoClient, type GustoClient, type GustoClientOptions } from "./client.js";
import { gustoPayrollEvents, type GustoBrainEvent } from "./normalize.js";

/**
 * Reads a company's processed payrolls by check date. The historical import
 * walks three years back in windows of at most a year, which is as much as
 * Gusto lists at once, a page of 100 payrolls at a time, and reads each
 * payroll's employee compensations. Incremental syncs read again from 45
 * days before the last pass, so a payroll processed late, or changed after
 * processing, is picked up; versions that didn't change are duplicates.
 * Both reach 31 days ahead, since Gusto processes a payroll days before its
 * check date.
 *
 * Reversed payrolls and payrolls cancelled after processing aren't read
 * yet: Gusto lists them with reversal details this connector doesn't ask for.
 */

/** None: payroll stays with a person in Gusto. The connection itself can only read. */
export const GUSTO_WRITES: WriteAction[] = [];

/** How far back each incremental pass reads again before the previous one. */
export const GUSTO_REVISIT_DAYS = 45;
/** How far past today a pass reads, for payrolls processed ahead of their check date. */
export const GUSTO_AHEAD_DAYS = 31;
/** The longest window Gusto lists at once is a year; days are counted inclusive. */
const WINDOW_DAYS = 365;
const DAY_MS = 86_400_000;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface GustoCursor {
  pass: "historical" | "incremental";
  /** First check date of the window being read. */
  windowStart: string;
  /** Last check date the pass reads. */
  until: string;
  /** Gusto's 1-based page within the window. */
  page: number;
  /** The check date the next incremental pass reads from. */
  nextFrom: string;
  done: boolean;
}

export interface GustoConnectorOptions extends GustoClientOptions {
  /** Years of payroll history the first import reads. */
  historyYears?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: GustoClient;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: unknown) => typeof value === "string" && DAY.test(value) && !Number.isNaN(Date.parse(value));
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const minDay = (a: string, b: string) => (a < b ? a : b);

export function parseGustoCursor(raw: string | null): GustoCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as GustoCursor;
  if (
    !c ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    ![c.windowStart, c.until, c.nextFrom].every(isDay) ||
    !Number.isInteger(c.page) ||
    c.page < 1 ||
    typeof c.done !== "boolean"
  ) {
    throw new Error("Gusto checkpoint is not in the expected shape");
  }
  return c;
}

export function gustoConnector(options: GustoConnectorOptions): Connector {
  const client = options.client ?? gustoClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 3;
  const today = () => now().toISOString().slice(0, 10);

  function startHistorical(): GustoCursor {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    return { pass: "historical", windowStart: start.toISOString().slice(0, 10), until: addDays(today(), GUSTO_AHEAD_DAYS), page: 1, nextFrom: addDays(today(), -GUSTO_REVISIT_DAYS), done: false };
  }

  function startIncremental(previous: GustoCursor | null): GustoCursor {
    const from = minDay(previous?.nextFrom ?? addDays(today(), -GUSTO_REVISIT_DAYS), addDays(today(), -GUSTO_REVISIT_DAYS));
    return { pass: "incremental", windowStart: from, until: addDays(today(), GUSTO_AHEAD_DAYS), page: 1, nextFrom: addDays(today(), -GUSTO_REVISIT_DAYS), done: false };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseGustoCursor(context.cursor);
    let cursor: GustoCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && !saved.done ? saved : startIncremental(saved);
    }

    while (!cursor.done) {
      const windowEnd = minDay(addDays(cursor.windowStart, WINDOW_DAYS - 1), cursor.until);
      const listed = await client.listPayrolls({ startDate: cursor.windowStart, endDate: windowEnd, page: cursor.page });
      const receivedAt = now().toISOString();
      const events: GustoBrainEvent[] = [];
      for (const row of listed) {
        const r = (row ?? {}) as { payroll_uuid?: unknown; uuid?: unknown; processed?: unknown };
        const id = typeof r.payroll_uuid === "string" ? r.payroll_uuid : r.uuid;
        // The list carries totals but not who was paid; the payroll itself does.
        if (r.processed !== true || typeof id !== "string") continue;
        events.push(...gustoPayrollEvents(await client.getPayroll(id), receivedAt));
      }
      if (listed.length >= GUSTO_PAGE_SIZE) cursor = { ...cursor, page: cursor.page + 1 };
      else if (windowEnd < cursor.until) cursor = { ...cursor, windowStart: addDays(windowEnd, 1), page: 1 };
      else cursor = { ...cursor, page: 1, done: true };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "gusto",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: GUSTO_WRITES,
  };
}
