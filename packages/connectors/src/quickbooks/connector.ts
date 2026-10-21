import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { QUICKBOOKS_PAGE_SIZE, quickBooksClient, type QuickBooksClient, type QuickBooksClientOptions } from "./client.js";
import { QUICKBOOKS_ENTITIES, QUICKBOOKS_NAME_LISTS, quickBooksEvents, type QuickBooksBrainEvent, type QuickBooksEntity, type QuickBooksRecord } from "./normalize.js";

/**
 * Reads the chart of accounts, customers, vendors, invoices, bills, payments
 * and journal entries. The historical import queries each entity back to its
 * start date, a page of 1000 at a time. Incremental syncs query what changed
 * since the last pass started, then ask change data capture for deletions,
 * which queries don't return. Change data capture looks back 30 days at
 * most, so an instance that hasn't synced in 30 days misses deletions from
 * before then; changes are still read.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client only reads. */
export const QUICKBOOKS_WRITES: WriteAction[] = [
  { integration: "quickbooks", name: "create_invoice", description: "Create an invoice for a customer" },
  { integration: "quickbooks", name: "create_bill", description: "Record a vendor bill" },
  { integration: "quickbooks", name: "create_journal_entry", description: "Post a journal entry" },
];

/** Change data capture's furthest look-back. */
export const QUICKBOOKS_CDC_DAYS = 30;
/** Each incremental pass starts this long before the previous one did, so a change saved mid-pass is never missed. */
export const QUICKBOOKS_OVERLAP_MS = 5 * 60_000;

type Step = QuickBooksEntity | "deletions" | "done";

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface QuickBooksCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** QuickBooks' STARTPOSITION for the next page of the current entity, from 1. */
  position: number;
  /** ISO time: a historical pass reads transactions dated on or after this day; an incremental one, changes from this time. */
  since: string;
  /** ISO time the next incremental pass reads changes from. */
  nextFrom: string;
}

export interface QuickBooksConnectorOptions extends QuickBooksClientOptions {
  /** Years of history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: QuickBooksClient;
}

const STEPS: Step[] = [...QUICKBOOKS_ENTITIES, "deletions", "done"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export function parseQuickBooksCursor(raw: string | null): QuickBooksCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as QuickBooksCursor;
  if (
    !c ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    (c.pass === "historical" && c.step === "deletions") ||
    !Number.isInteger(c.position) ||
    c.position < 1 ||
    ![c.since, c.nextFrom].every((t) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t)))
  ) {
    throw new Error("QuickBooks checkpoint is not in the expected shape");
  }
  return c;
}

/** A time as QuickBooks' query language takes it: seconds, with an explicit UTC offset. */
const qbTime = (iso: string) => `${iso.slice(0, 19)}+00:00`;

/** The SELECT for one page. Values are times and dates the connector made, never text from outside. */
export function quickBooksStatement(entity: QuickBooksEntity, cursor: QuickBooksCursor): string {
  const filters: string[] = [];
  // Name lists hide inactive entries unless asked; inactive accounts and vendors still carry history.
  if (QUICKBOOKS_NAME_LISTS.includes(entity)) filters.push("Active IN (true, false)");
  let order = "Id";
  if (cursor.pass === "incremental") {
    filters.push(`MetaData.LastUpdatedTime >= '${qbTime(cursor.since)}'`);
    order = "MetaData.LastUpdatedTime";
  } else if (!QUICKBOOKS_NAME_LISTS.includes(entity)) {
    filters.push(`TxnDate >= '${cursor.since.slice(0, 10)}'`);
  }
  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  return `SELECT * FROM ${entity}${where} ORDERBY ${order} STARTPOSITION ${cursor.position} MAXRESULTS ${QUICKBOOKS_PAGE_SIZE}`;
}

export function quickBooksConnector(options: QuickBooksConnectorOptions): Connector {
  const client = options.client ?? quickBooksClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 6;
  const lookbackHours = options.incrementalLookbackHours ?? 48;

  function startHistorical(): QuickBooksCursor {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    // The first incremental pass picks up anything changed while the import ran.
    return { pass: "historical", step: QUICKBOOKS_ENTITIES[0], position: 1, since: start.toISOString(), nextFrom: now().toISOString() };
  }

  function startIncremental(previous: QuickBooksCursor | null): QuickBooksCursor {
    const since = previous?.nextFrom ?? new Date(now().getTime() - lookbackHours * 3_600_000).toISOString();
    const nextFrom = new Date(now().getTime() - QUICKBOOKS_OVERLAP_MS).toISOString();
    return { pass: "incremental", step: QUICKBOOKS_ENTITIES[0], position: 1, since, nextFrom };
  }

  /** Deletions since the pass's start, as far back as change data capture reaches. */
  async function deletions(cursor: QuickBooksCursor, receivedAt: string): Promise<QuickBooksBrainEvent[]> {
    const oldest = now().getTime() - QUICKBOOKS_CDC_DAYS * 86_400_000 + 3_600_000;
    const from = new Date(Math.max(Date.parse(cursor.since), oldest)).toISOString();
    const body = await client.cdc(QUICKBOOKS_ENTITIES, qbTime(from));
    return body.CDCResponse.flatMap((r) => (Array.isArray(r?.QueryResponse) ? r.QueryResponse : [])).flatMap((group) =>
      QUICKBOOKS_ENTITIES.flatMap((entity) => {
        const records = (group as Record<string, unknown>)?.[entity];
        const deleted = Array.isArray(records) ? (records as QuickBooksRecord[]).filter((r) => r?.status === "Deleted") : [];
        return quickBooksEvents(entity, deleted, receivedAt);
      }),
    );
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseQuickBooksCursor(context.cursor);
    let cursor: QuickBooksCursor;
    if (mode === "historical") {
      // A finished import stays finished (its step is done); an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved);
    }
    const order: Step[] = cursor.pass === "historical" ? [...QUICKBOOKS_ENTITIES, "done"] : STEPS;

    while (cursor.step !== "done") {
      const step = cursor.step;
      const receivedAt = now().toISOString();
      let events: QuickBooksBrainEvent[];
      let more = false;
      if (step === "deletions") {
        events = await deletions(cursor, receivedAt);
      } else {
        const page = await client.query(quickBooksStatement(step, cursor));
        const records = page.QueryResponse[step];
        events = quickBooksEvents(step, records, receivedAt);
        // A full page may have more behind it; a short or empty one is the last.
        more = Array.isArray(records) && records.length >= QUICKBOOKS_PAGE_SIZE;
      }
      const next: QuickBooksCursor = more
        ? { ...cursor, position: cursor.position + QUICKBOOKS_PAGE_SIZE }
        : { ...cursor, step: order[order.indexOf(step) + 1] ?? "done", position: 1 };
      cursor = next;
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "quickbooks",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: QUICKBOOKS_WRITES,
  };
}
