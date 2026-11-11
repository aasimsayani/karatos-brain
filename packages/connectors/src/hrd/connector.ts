import { readFile } from "node:fs/promises";
import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { parseReportNumbers } from "../gia/normalize.js";
import { HRD_REPORT_NUMBER, HRD_VALIDITY_BATCH, hrdClient, type HrdClient, type HrdClientOptions } from "./client.js";
import { hrdReportEvent, hrdUnavailableEvent, type HrdEvent } from "./normalize.js";

/**
 * HRD Antwerp reports for the report numbers the business holds, so stones
 * and jewels with HRD reports are matched to them like GIA stones.
 *
 * Each sync looks up the numbers on its list that it hasn't looked up yet,
 * a batch at a time, up to maxLookups: HRD allows 1000 lookups a day and
 * 100 requests in 15 minutes, so the rest wait for the next sync. Then, once
 * in each night's window when HRD answers it (19:00 to 04:00 UTC), it asks
 * which of the reports it found are still valid, 1000 to a request. A report
 * whose valid-from date moved has been reissued and is looked up again on
 * the next sync; one HRD no longer lists is flagged once. There is nothing
 * to write back.
 */

/** None: report results are HRD's to change. */
export const HRD_WRITES: WriteAction[] = [];

/** Where an HRD sync stands. Serialized as the runSync checkpoint. */
export interface HrdCursor {
  /** Report numbers already looked up, found or not. */
  looked: string[];
  /** Reports found, by number, with the valid-from date HRD last gave ("" before the first check). */
  found: Record<string, string>;
  /** Found reports to look up again, since HRD reissued them. */
  refetch: string[];
  /** The night (the UTC day it starts on) of the last finished validity check. */
  checked: string | null;
}

export interface HrdOptions extends Partial<Pick<HrdClientOptions, "fetch" | "sleep" | "retries">> {
  apiToken: string;
  /** The report numbers to look up, such as the certificates on the business's stones and jewels. */
  reportNumbers: () => Promise<string[]>;
  /** The most lookups one sync makes. Defaults to 50. */
  maxLookups?: number;
  /** Lookups per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: HrdClient;
}

const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isNumber = (v: unknown): v is string => typeof v === "string" && HRD_REPORT_NUMBER.test(v);

export function parseHrdCursor(raw: string | null): HrdCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    c = null;
  }
  const r = (typeof c === "object" && c !== null && !Array.isArray(c) ? c : {}) as Record<string, unknown>;
  const found = (typeof r.found === "object" && !Array.isArray(r.found) ? r.found : null) as Record<string, unknown> | null;
  if (
    Array.isArray(r.looked) &&
    r.looked.every(isNumber) &&
    found &&
    Object.entries(found).every(([n, d]) => isNumber(n) && (d === "" || isDay(d))) &&
    Array.isArray(r.refetch) &&
    r.refetch.every(isNumber) &&
    (r.checked === null || isDay(r.checked))
  ) {
    return { looked: r.looked, found: found as Record<string, string>, refetch: r.refetch, checked: r.checked };
  }
  throw new Error("HRD checkpoint is not in the expected shape");
}

/** The report numbers in the file HRD_REPORT_NUMBERS_FILE names. */
export function hrdReportNumbersFromFile(path: string, read: (path: string) => Promise<string> = (p) => readFile(p, "utf8")): () => Promise<string[]> {
  return async () => parseReportNumbers(await read(path), HRD_REPORT_NUMBER);
}

/** The night a time falls in, by the UTC day it starts on, or null outside 19:00 to 04:00 UTC. */
export function hrdValidityNight(at: Date): string | null {
  const hour = at.getUTCHours();
  if (hour >= 19) return at.toISOString().slice(0, 10);
  if (hour < 4) return new Date(at.getTime() - 86_400_000).toISOString().slice(0, 10);
  return null;
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

export function hrdConnector(options: HrdOptions): Connector {
  const client = options.client ?? hrdClient(options);
  const now = options.now ?? (() => new Date());
  const maxLookups = positive(options.maxLookups ?? 50, "maxLookups");
  const batchSize = positive(options.batchSize ?? 25, "batchSize");

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseHrdCursor(context.cursor) ?? { looked: [], found: {}, refetch: [], checked: null };
    const looked = new Set(saved.looked);
    const found = new Map(Object.entries(saved.found));
    const refetch = new Set(saved.refetch);
    let checked = saved.checked;
    const cursor = () =>
      JSON.stringify({ looked: [...looked].sort(), found: Object.fromEntries([...found].sort(([a], [b]) => (a < b ? -1 : 1))), refetch: [...refetch].sort(), checked } satisfies HrdCursor);

    const list = new Set(await options.reportNumbers());
    // Numbers taken off the list are left alone: neither looked up again nor checked.
    const todo = [...[...refetch].filter((n) => list.has(n)), ...[...list].filter((n) => !looked.has(n))].slice(0, maxLookups);
    for (let i = 0; i < todo.length; i += batchSize) {
      const events: HrdEvent[] = [];
      for (const number of todo.slice(i, i + batchSize)) {
        const lookup = await client.report(number);
        const receivedAt = now().toISOString();
        if (lookup.kind === "found") {
          events.push(hrdReportEvent(lookup.report, receivedAt));
          if (!found.has(number)) found.set(number, "");
        } else {
          events.push(hrdUnavailableEvent(number, "not_found", receivedAt));
          found.delete(number);
        }
        looked.add(number);
        refetch.delete(number);
      }
      yield { events, cursor: cursor() };
    }

    const night = hrdValidityNight(now());
    const toCheck = [...found.keys()].filter((n) => list.has(n)).sort();
    if (night === null || night === checked) return;
    for (let i = 0; i < toCheck.length; i += HRD_VALIDITY_BATCH) {
      const numbers = toCheck.slice(i, i + HRD_VALIDITY_BATCH);
      const valid = await client.validities(numbers);
      // HRD's clock says the window has closed: the check waits for the next night.
      if (valid === null) return;
      const receivedAt = now().toISOString();
      const events: HrdEvent[] = [];
      for (const number of numbers) {
        const validity = valid.get(number);
        if (!validity) {
          events.push(hrdUnavailableEvent(number, "no_longer_valid", receivedAt));
          continue;
        }
        const before = found.get(number);
        if (before !== "" && before !== validity.validFrom) refetch.add(number);
        found.set(number, validity.validFrom);
      }
      if (i + HRD_VALIDITY_BATCH >= toCheck.length) checked = night;
      yield { events, cursor: cursor() };
    }
  }

  return {
    source: "hrd",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: HRD_WRITES,
  };
}
