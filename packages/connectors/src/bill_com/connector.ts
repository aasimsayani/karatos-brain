import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { BILL_PAGE_TOKEN, BILL_RESOURCES, BillApiError, billClient, type BillClient, type BillClientOptions } from "./client.js";
import { billEvent } from "./normalize.js";

/**
 * BILL: a store's supplier bills, their approvals, the vendors it pays and
 * the payments it sends, for the finance and buying departments.
 *
 * Each pass reads vendors, then bills, then payments, each changed at or
 * after the pass's start time, oldest change first, a page of 100 at a
 * time. The checkpoint keeps which list and page the pass reached, so a
 * resumed sync goes on from there. The historical import reads six years;
 * later syncs ask from the start of the last pass, less five minutes of
 * overlap, and the overlap comes back as duplicates.
 *
 * Read-only: KaratOS never pays, approves or changes anything in BILL.
 */

/** None: the connector only reads, and its sign-in should leave out payments. */
export const BILL_WRITES: WriteAction[] = [];

/** Each incremental pass starts this long before the previous one did, so a change saved mid-pass is never missed. */
export const BILL_OVERLAP_MS = 5 * 60_000;
/** Pages one list may take in one pass, as a guard against a page token that never ends. */
export const BILL_MAX_PAGES = 10_000;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface BillCursor {
  pass: "historical" | "incremental";
  /** Which list the pass is on: 0 vendors, 1 bills, 2 payments, 3 done. */
  list: number;
  /** BILL's token for the next page of that list, or null for its first page. */
  page: string | null;
  /** Pages of that list read so far this pass. */
  pages: number;
  /** Records changed at or after this time are read. */
  since: string;
  /** Where the next pass starts. */
  nextFrom: string;
}

export interface BillOptions extends Partial<Pick<BillClientOptions, "fetch" | "sleep" | "retries" | "environment">> {
  clientId: string;
  clientSecret: string;
  /** Years of history the first import reads. Defaults to 6, as the IRS can ask about six years back. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. Defaults to 24 hours. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: BillClient;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isTime = (t: unknown) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t)) && new Date(t).toISOString() === t;

export function parseBillCursor(raw: string | null): BillCursor | null {
  if (raw === null) return null;
  let c: BillCursor | null;
  try {
    c = JSON.parse(raw) as BillCursor | null;
  } catch {
    c = null;
  }
  const ok =
    typeof c === "object" &&
    c !== null &&
    (c.pass === "historical" || c.pass === "incremental") &&
    Number.isInteger(c.list) &&
    c.list >= 0 &&
    c.list <= BILL_RESOURCES.length &&
    (c.page === null || (typeof c.page === "string" && BILL_PAGE_TOKEN.test(c.page))) &&
    Number.isInteger(c.pages) &&
    c.pages >= 0 &&
    c.pages <= BILL_MAX_PAGES &&
    isTime(c.since) &&
    isTime(c.nextFrom);
  if (!ok || !c) throw new Error("BILL checkpoint is not in the expected shape");
  const { pass, list, page, pages, since, nextFrom } = c;
  return { pass, list, page, pages, since, nextFrom };
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

export function billComConnector(options: BillOptions): Connector {
  const client = options.client ?? billClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = positive(options.historyYears ?? 6, "historyYears");
  const lookbackHours = positive(options.incrementalLookbackHours ?? 24, "incrementalLookbackHours");

  function start(mode: "historical" | "incremental", saved: BillCursor | null, at: Date): BillCursor {
    let since: string;
    if (mode === "historical") {
      const from = new Date(at);
      from.setUTCFullYear(from.getUTCFullYear() - historyYears);
      since = from.toISOString();
    } else {
      since = saved?.nextFrom ?? new Date(at.getTime() - lookbackHours * 3_600_000).toISOString();
    }
    return { pass: mode, list: 0, page: null, pages: 0, since, nextFrom: new Date(at.getTime() - BILL_OVERLAP_MS).toISOString() };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseBillCursor(context.cursor);
    const at = now();
    const done = BILL_RESOURCES.length;
    if (mode === "historical" && saved?.pass === "historical" && saved.list === done) return;
    let c = saved?.pass === mode && saved.list < done ? saved : start(mode, saved, at);
    const receivedAt = at.toISOString();

    while (c.list < done) {
      const resource = BILL_RESOURCES[c.list]!;
      const page = await client.list(resource, { since: c.since, page: c.page ?? undefined });
      const events = page.results.map((r) => billEvent(resource, r, receivedAt));
      if (page.nextPage !== undefined && page.results.length > 0) {
        if (page.nextPage === c.page || c.pages + 1 >= BILL_MAX_PAGES) throw new BillApiError(`BILL ${resource} kept giving more pages after ${c.pages + 1}`, 200);
        c = { ...c, page: page.nextPage, pages: c.pages + 1 };
      } else {
        c = { ...c, list: c.list + 1, page: null, pages: 0 };
      }
      yield { events, cursor: JSON.stringify(c) };
    }
  }

  return {
    source: "bill_com",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: BILL_WRITES,
  };
}
