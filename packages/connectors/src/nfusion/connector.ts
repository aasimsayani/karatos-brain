import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { METALS } from "../metals_api/connector.js";
import { nfusionClient, type NfusionClient, type NfusionClientOptions } from "./client.js";
import { nfusionHistoryEvents, nfusionSummaryEvents } from "./normalize.js";

/**
 * nFusion Solutions: spot prices for gold, silver, platinum and palladium,
 * in US dollars per troy ounce, as the metals department's
 * metal.price_updated events, the same as Metals-API gives.
 *
 * - The historical import reads five years of daily closes (or fewer, when
 *   asked), ending yesterday, all four metals in each request, 90 days a
 *   request. The checkpoint fixes the first and last day when the import
 *   starts and counts the requests already read, so a resumed import asks
 *   for exactly the same stretches.
 * - Each incremental sync reads the daily closes from the last day it kept
 *   (the last 7 days the first time) through today, then the latest spot
 *   summary. Today's close is kept once its day is over, so a sync the next
 *   day picks it up.
 *
 * nFusion only publishes prices, so there is nothing to write back.
 */

/** None: nFusion's API has nothing to write to. */
export const NFUSION_WRITES: WriteAction[] = [];

/** The most days of daily closes the historical import reads: five years. */
export const NFUSION_MAX_HISTORY_DAYS = 1825;
/**
 * Days of history one request asks for. nFusion states no limit for daily
 * history ("going back years"); 90 days of four metals keeps each answer
 * small, and five years costs 21 requests.
 */
export const NFUSION_WINDOW_DAYS = 90;
/** Days of closes the first incremental sync reads, ending today. */
export const NFUSION_RECENT_DAYS = 7;

export interface NfusionOptions extends NfusionClientOptions {
  /** Days of daily closes the historical import reads, ending yesterday: 1 to 1825, five years when not given. */
  historyDays?: number;
  now?: () => Date;
  /** For tests: a client already made. */
  client?: NfusionClient;
}

/** The historical import's checkpoint: its first and last day, fixed at the start, and the requests already read. */
export interface NfusionHistoryCursor {
  since: string;
  through: string;
  next: number;
}

/** The incremental sync's checkpoint: the last day a close was kept, where the next sync starts again. */
export interface NfusionRecentCursor {
  day: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const isDay = (v: unknown): v is string => typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && isoDay(new Date(`${v}T00:00:00Z`)) === v;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

function parse(raw: string, keys: string, message: string): Record<string, unknown> {
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new Error(message);
  }
  if (typeof c !== "object" || c === null || Array.isArray(c) || Object.keys(c).sort().join(",") !== keys) throw new Error(message);
  return c as Record<string, unknown>;
}

const HISTORY_MESSAGE = "nFusion history checkpoint is not in the expected shape";
const RECENT_MESSAGE = "nFusion incremental checkpoint is not in the expected shape";

export function parseNfusionHistoryCursor(raw: string | null): NfusionHistoryCursor | null {
  if (raw === null) return null;
  const c = parse(raw, "next,since,through", HISTORY_MESSAGE);
  if (!isDay(c.since) || !isDay(c.through) || c.since > c.through || daysBetween(c.since, c.through) >= NFUSION_MAX_HISTORY_DAYS) throw new Error(HISTORY_MESSAGE);
  if (!Number.isSafeInteger(c.next) || (c.next as number) < 0 || (c.next as number) > nfusionWindows(c.since, c.through).length) throw new Error(HISTORY_MESSAGE);
  return { since: c.since, through: c.through, next: c.next as number };
}

export function parseNfusionRecentCursor(raw: string | null): NfusionRecentCursor | null {
  if (raw === null) return null;
  const c = parse(raw, "day", RECENT_MESSAGE);
  if (!isDay(c.day)) throw new Error(RECENT_MESSAGE);
  return { day: c.day };
}

/** The stretches of days, `NFUSION_WINDOW_DAYS` at most, from `since` to `through`, both kept. */
export function nfusionWindows(since: string, through: string): { from: string; through: string }[] {
  const out: { from: string; through: string }[] = [];
  for (let from = since; from <= through; from = addDays(from, NFUSION_WINDOW_DAYS)) {
    const last = addDays(from, NFUSION_WINDOW_DAYS - 1);
    out.push({ from, through: last < through ? last : through });
  }
  return out;
}

export function nfusionConnector(options: NfusionOptions): Connector {
  const client = options.client ?? nfusionClient(options);
  const now = options.now ?? (() => new Date());
  const historyDays = options.historyDays ?? NFUSION_MAX_HISTORY_DAYS;
  if (!Number.isInteger(historyDays) || historyDays < 1 || historyDays > NFUSION_MAX_HISTORY_DAYS) throw new Error(`historyDays must be a whole number from 1 to ${NFUSION_MAX_HISTORY_DAYS}`);

  /**
   * One stretch of daily closes. The day after the stretch is asked for as
   * `end`, since nFusion doesn't say whether `end` is kept, and only days in
   * the stretch are kept.
   */
  async function read(from: string, through: string) {
    const elements = await client.spotHistory(METALS, from, addDays(through, 1));
    return nfusionHistoryEvents(elements, from, through, now(), now().toISOString());
  }

  async function* history(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseNfusionHistoryCursor(context.cursor);
    const through = saved?.through ?? addDays(isoDay(now()), -1);
    const since = saved?.since ?? addDays(through, -(historyDays - 1));
    const stretches = nfusionWindows(since, through);
    for (let i = saved?.next ?? 0; i < stretches.length; i++) {
      const { events } = await read(stretches[i]!.from, stretches[i]!.through);
      const cursor: NfusionHistoryCursor = { since, through, next: i + 1 };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  async function* recent(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseNfusionRecentCursor(context.cursor);
    const today = isoDay(now());
    const from = saved?.day ?? addDays(today, -(NFUSION_RECENT_DAYS - 1));
    let day = from;
    for (const stretch of nfusionWindows(from, today)) {
      const { events, lastDay } = await read(stretch.from, stretch.through);
      if (lastDay !== null && lastDay > day) day = lastDay;
      const cursor: NfusionRecentCursor = { day };
      yield { events, cursor: JSON.stringify(cursor) };
    }
    const elements = await client.spotSummary(METALS);
    const cursor: NfusionRecentCursor = { day };
    yield { events: nfusionSummaryEvents(elements, now().toISOString()), cursor: JSON.stringify(cursor) };
  }

  return {
    source: "nfusion",
    historicalImport: (context) => history(context),
    incrementalSync: (context) => recent(context),
    writes: NFUSION_WRITES,
  };
}
