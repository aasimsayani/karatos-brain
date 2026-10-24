import { readFile } from "node:fs/promises";
import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { GIA_REPORT_NUMBER, giaClient, type GiaClient, type GiaClientOptions } from "./client.js";
import { parseReportNumbers, reportEvent, unavailableEvent, type GiaEvent } from "./normalize.js";

/**
 * GIA report results for the certificate numbers the business holds. Each
 * sync looks up the numbers on its list that it hasn't looked up yet, a
 * batch at a time, then reads GIA's changed-reports feed, which keeps every
 * report this key has looked up current at no charge. A number is looked up
 * once: a lookup can cost money on a pay-as-you-go plan, so a sync stops at
 * maxLookups and the rest wait for the next one. A report at GIA for service
 * is looked up again later. There is nothing to write back.
 */

/** None: report results are GIA's to change. */
export const GIA_WRITES: WriteAction[] = [];

/** Where a GIA sync stands. Serialized as the runSync checkpoint. */
export interface GiaCursor {
  /** Report numbers already looked up, found or not. */
  looked: string[];
  /** Where the changed-reports feed was last read to. */
  changes: string | null;
}

export interface GiaOptions extends Partial<Pick<GiaClientOptions, "fetch" | "sleep" | "rateLimitRetries">> {
  apiUrl: string;
  apiKey: string;
  /** The report numbers to look up, such as the certificates on the business's stones. */
  reportNumbers: () => Promise<string[]>;
  /** The most lookups one sync makes. Defaults to 100. */
  maxLookups?: number;
  /** Lookups per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: GiaClient;
}

export function parseGiaCursor(raw: string | null): GiaCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as GiaCursor;
  if (!c || !Array.isArray(c.looked) || !c.looked.every((n) => typeof n === "string" && GIA_REPORT_NUMBER.test(n)) || (c.changes !== null && typeof c.changes !== "string")) {
    throw new Error("GIA checkpoint is not in the expected shape");
  }
  return c;
}

/** The report numbers in the file GIA_REPORT_NUMBERS_FILE names. */
export function giaReportNumbersFromFile(path: string, read: (path: string) => Promise<string> = (p) => readFile(p, "utf8")): () => Promise<string[]> {
  return async () => parseReportNumbers(await read(path), GIA_REPORT_NUMBER);
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

export function giaConnector(options: GiaOptions): Connector {
  const client = options.client ?? giaClient(options);
  const now = options.now ?? (() => new Date());
  const maxLookups = positive(options.maxLookups ?? 100, "maxLookups");
  const batchSize = positive(options.batchSize ?? 25, "batchSize");

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseGiaCursor(context.cursor) ?? { looked: [], changes: null };
    const looked = new Set(saved.looked);
    let changes = saved.changes;
    const cursor = () => JSON.stringify({ looked: [...looked].sort(), changes } satisfies GiaCursor);

    const todo = (await options.reportNumbers()).filter((n) => !looked.has(n)).slice(0, maxLookups);
    for (let i = 0; i < todo.length; i += batchSize) {
      const events: GiaEvent[] = [];
      for (const number of todo.slice(i, i + batchSize)) {
        const lookup = await client.report(number);
        const receivedAt = now().toISOString();
        if (lookup.kind === "in_service") continue;
        events.push(lookup.kind === "found" ? reportEvent(lookup.report, receivedAt) : unavailableEvent(number, lookup.reason, receivedAt));
        looked.add(number);
      }
      yield { events, cursor: cursor() };
    }

    for (;;) {
      const page = await client.changes(changes);
      const receivedAt = now().toISOString();
      const moved = page.endCursor !== null && page.endCursor !== changes;
      if (page.endCursor !== null) changes = page.endCursor;
      if (page.reports.length) yield { events: page.reports.map((r) => reportEvent(r, receivedAt)), cursor: cursor() };
      if (!moved || page.reports.length === 0) break;
    }
  }

  return {
    source: "gia",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: GIA_WRITES,
  };
}
