import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { XERO_PAGE_SIZE, xeroClient, type XeroClient, type XeroClientOptions, type XeroEndpoint } from "./client.js";
import { xeroPageEvents, type XeroBrainEvent } from "./normalize.js";

/**
 * Reads the chart of accounts, contacts, invoices and bills, credit notes,
 * payments, bank transactions and manual journals. The historical import
 * reads each endpoint back to its start date, a page of 1000 at a time.
 * Incremental syncs ask for what changed since the last pass started
 * (If-Modified-Since). Xero keeps deleted and voided transactions with that
 * status and updates their UpdatedDateUTC, so the same reads also bring
 * deletions; there is no separate deletions step.
 *
 * Xero doesn't touch UpdatedDateUTC for a few edits (a contact becoming a
 * supplier, some due-date changes), so those wait until the record next
 * changes in a way Xero does stamp.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the connection itself can only read. */
export const XERO_WRITES: WriteAction[] = [
  { integration: "xero", name: "create_invoice", description: "Create a sales invoice for a contact" },
  { integration: "xero", name: "create_bill", description: "Record a supplier bill" },
  { integration: "xero", name: "create_manual_journal", description: "Post a manual journal" },
];

/** Endpoints in the order the import reads them; Accounts and Contacts first so later records point at known ones. */
export const XERO_SYNC_ORDER: readonly XeroEndpoint[] = ["Accounts", "Contacts", "Invoices", "CreditNotes", "Payments", "BankTransactions", "ManualJournals"];
/** Endpoints that answer everything in one response. */
const UNPAGED: readonly XeroEndpoint[] = ["Accounts"];
/** Endpoints with no transaction date, read whole by the historical import. */
const UNDATED: readonly XeroEndpoint[] = ["Accounts", "Contacts"];
/** Each incremental pass starts this long before the previous one did, so a change saved mid-pass is never missed. */
export const XERO_OVERLAP_MS = 5 * 60_000;

type Step = XeroEndpoint | "done";

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface XeroCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** Xero's 1-based page for the current endpoint. */
  page: number;
  /** ISO time: a historical pass reads transactions dated on or after this day; an incremental one, changes from this time. */
  since: string;
  /** ISO time the next incremental pass reads changes from. */
  nextFrom: string;
}

export interface XeroConnectorOptions extends XeroClientOptions {
  /** Years of history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: XeroClient;
}

const STEPS: Step[] = [...XERO_SYNC_ORDER, "done"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export function parseXeroCursor(raw: string | null): XeroCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as XeroCursor;
  if (
    !c ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    !Number.isInteger(c.page) ||
    c.page < 1 ||
    ![c.since, c.nextFrom].every((t) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t)))
  ) {
    throw new Error("Xero checkpoint is not in the expected shape");
  }
  return c;
}

/** Xero's date filter for transactions on or after a day. */
export const xeroDateFilter = (iso: string) => `Date>=DateTime(${Number(iso.slice(0, 4))},${Number(iso.slice(5, 7))},${Number(iso.slice(8, 10))})`;

/** The records in one response, under the endpoint's own name. */
const recordsOf = (body: Record<string, unknown>, endpoint: XeroEndpoint) => (Array.isArray(body[endpoint]) ? (body[endpoint] as unknown[]) : []);

export function xeroConnector(options: XeroConnectorOptions): Connector {
  const client = options.client ?? xeroClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 6;
  const lookbackHours = options.incrementalLookbackHours ?? 48;

  function startHistorical(): XeroCursor {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    // The first incremental pass picks up anything changed while the import ran.
    return { pass: "historical", step: XERO_SYNC_ORDER[0]!, page: 1, since: start.toISOString(), nextFrom: now().toISOString() };
  }

  function startIncremental(previous: XeroCursor | null): XeroCursor {
    const since = previous?.nextFrom ?? new Date(now().getTime() - lookbackHours * 3_600_000).toISOString();
    const nextFrom = new Date(now().getTime() - XERO_OVERLAP_MS).toISOString();
    return { pass: "incremental", step: XERO_SYNC_ORDER[0]!, page: 1, since, nextFrom };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseXeroCursor(context.cursor);
    let cursor: XeroCursor;
    if (mode === "historical") {
      // A finished import stays finished (its step is done); an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved);
    }

    while (cursor.step !== "done") {
      const endpoint = cursor.step;
      const paged = !UNPAGED.includes(endpoint);
      const body = await client.get(endpoint, {
        ...(paged ? { page: cursor.page, order: "UpdatedDateUTC ASC" } : {}),
        ...(cursor.pass === "incremental" ? { modifiedSince: cursor.since } : UNDATED.includes(endpoint) ? {} : { where: xeroDateFilter(cursor.since) }),
        // Archived accounts and contacts still carry history.
        ...(endpoint === "Contacts" ? { includeArchived: true } : {}),
      });
      const records = recordsOf(body, endpoint);
      const events: XeroBrainEvent[] = xeroPageEvents(endpoint, records, now().toISOString());
      // A full page may have more behind it; a short or empty one is the last.
      const more = paged && records.length >= XERO_PAGE_SIZE;
      cursor = more ? { ...cursor, page: cursor.page + 1 } : { ...cursor, step: STEPS[STEPS.indexOf(endpoint) + 1]!, page: 1 };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "xero",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: XERO_WRITES,
  };
}
