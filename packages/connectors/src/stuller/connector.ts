import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { stullerClient, type StullerClient, type StullerClientOptions } from "./client.js";
import { invoiceEvent, metalRatesEvent, STULLER_INVOICE_NUMBER, type StullerEvent } from "./normalize.js";

/**
 * Stuller, the jewelry supplier: the invoices on the business's account,
 * with their lines, totals, status and tracking, and Stuller's current
 * metal market rates. Stuller's invoice endpoint has no date filter, so
 * each sync reads every invoice and records the ones that are new or
 * changed since the last sync, oldest first; invoices older than the
 * history window are skipped. It never places an order.
 */

/** Declared so they can be gated and audited; none runs while writes are off. */
export const STULLER_WRITES: WriteAction[] = [{ integration: "stuller", name: "submit_order", description: "Submit an order to Stuller" }];

/** Where a Stuller sync stands: each invoice read, by number, with a hash of what was read. Serialized as the runSync checkpoint. */
export interface StullerCursor {
  invoices: Record<string, string>;
}

export interface StullerOptions extends Partial<Pick<StullerClientOptions, "fetch" | "sleep" | "rateLimitRetries">> {
  username: string;
  password: string;
  /** Invoices dated earlier than this many years ago are skipped. Defaults to 5. */
  historyYears?: number;
  /** Also read Stuller's metal market rates. On by default. */
  metalRates?: boolean;
  /** Events per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: StullerClient;
}

export function parseStullerCursor(raw: string | null): StullerCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as StullerCursor;
  const invoices = (c as { invoices?: unknown } | null)?.invoices;
  const ok = typeof invoices === "object" && invoices !== null && !Array.isArray(invoices) && Object.entries(invoices).every(([n, h]) => STULLER_INVOICE_NUMBER.test(n) && typeof h === "string" && /^[0-9a-f]{12}$/.test(h));
  if (!ok) throw new Error("Stuller checkpoint is not in the expected shape");
  return c;
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

export function stullerConnector(options: StullerOptions): Connector {
  const client = options.client ?? stullerClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = positive(options.historyYears ?? 5, "historyYears");
  const batchSize = positive(options.batchSize ?? 200, "batchSize");

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const seen: Record<string, string> = { ...parseStullerCursor(context.cursor)?.invoices };
    const receivedAt = now().toISOString();
    const since = new Date(now());
    since.setUTCFullYear(since.getUTCFullYear() - historyYears);

    const reads = (await client.invoices())
      .map((raw) => invoiceEvent(raw, receivedAt))
      .filter((r) => !r.ok || r.event.occurredAt! >= since.toISOString())
      // Oldest first, so a resumed sync continues in order; dead-lettered ones go first.
      .sort((a, b) => (a.event.occurredAt ?? "").localeCompare(b.event.occurredAt ?? "") || a.event.idempotencyKey.localeCompare(b.event.idempotencyKey));

    let events: StullerEvent[] = [];
    const cursor = () => JSON.stringify({ invoices: { ...seen } } satisfies StullerCursor);
    for (const read of reads) {
      if (!read.ok) events.push(read.event);
      else if (seen[read.invoiceNumber] !== read.hash) {
        events.push(read.event);
        seen[read.invoiceNumber] = read.hash;
      }
      if (events.length >= batchSize) {
        yield { events, cursor: cursor() };
        events = [];
      }
    }
    if (options.metalRates ?? true) {
      const rates = metalRatesEvent(await client.metalRates(), receivedAt);
      if (rates) events.push(rates);
    }
    if (events.length) yield { events, cursor: cursor() };
  }

  return {
    source: "stuller",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: STULLER_WRITES,
  };
}
