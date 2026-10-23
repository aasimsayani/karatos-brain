import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { AUTHORIZE_NET_BATCH_WINDOW_DAYS, AUTHORIZE_NET_PAGE_SIZE, AuthorizeNetApiError, authorizeNetClient, type AuthorizeNetClient, type AuthorizeNetClientOptions } from "./client.js";
import {
  authorizeNetBatchEvents,
  authorizeNetId,
  authorizeNetList,
  authorizeNetNeedsLink,
  authorizeNetTransactionEvents,
  type AuthorizeNetBrainEvent,
  type AuthorizeNetTransaction,
} from "./normalize.js";

/**
 * Reads settlement batches and the transactions in them, then the
 * transactions not settled yet. The historical import walks the settled
 * batch list from its start date in 31-day windows, the most one list may
 * cover, and lists each batch's transactions 1000 at a time. Incremental
 * syncs walk the windows from where the previous pass started, less an
 * overlap, and read every unsettled transaction again, so a capture, void
 * or settlement is seen as the transaction's status moves.
 *
 * Refunds, chargebacks and returned eChecks are transactions of their own.
 * For those, and only those, the transaction's details are read for the
 * transaction they refer to; nothing else from the details is kept.
 */

/** Declared so they can be gated and audited; none runs while writes are off. The key itself can't be limited to reading. */
export const AUTHORIZE_NET_WRITES: WriteAction[] = [
  { integration: "authorize_net", name: "refund_transaction", description: "Refund all or part of a settled transaction" },
  { integration: "authorize_net", name: "void_transaction", description: "Void a transaction that hasn't settled" },
];

/** Each incremental pass starts this long before the previous one did, so a batch that settles mid-pass is never missed. */
export const AUTHORIZE_NET_OVERLAP_MS = 60 * 60_000;
const WINDOW_MS = AUTHORIZE_NET_BATCH_WINDOW_DAYS * 86_400_000;

type Step = "batches" | "transactions" | "unsettled" | "done";
const STEPS: Step[] = ["batches", "transactions", "unsettled", "done"];

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface AuthorizeNetCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** ISO time the current settlement window starts at; it ends 31 days later or at `until`. */
  windowStart: string;
  /** ISO time the pass reads settled batches up to: when it started. */
  until: string;
  /** Batches of the current window still to read, in the order listed; the first is being read. */
  batches: string[];
  /** 1-based page of the current batch's, or the unsettled, transactions. */
  page: number;
  /** ISO time the next incremental pass reads settled batches from. */
  nextFrom: string;
}

export interface AuthorizeNetConnectorOptions extends AuthorizeNetClientOptions {
  /** Years of history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: AuthorizeNetClient;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const isTime = (t: unknown) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t));
/** A window holds a few batches a day, one per payment type; far more means the checkpoint wasn't written here. */
const MAX_BATCHES = 1000;

export function parseAuthorizeNetCursor(raw: string | null): AuthorizeNetCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as AuthorizeNetCursor;
  if (
    !c ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    !Number.isInteger(c.page) ||
    c.page < 1 ||
    c.page > 100_000 ||
    ![c.windowStart, c.until, c.nextFrom].every(isTime) ||
    Date.parse(c.windowStart) > Date.parse(c.until) ||
    !Array.isArray(c.batches) ||
    c.batches.length > MAX_BATCHES ||
    !c.batches.every((b) => authorizeNetId(b) === b) ||
    (c.step === "transactions") !== c.batches.length > 0
  ) {
    throw new Error("Authorize.net checkpoint is not in the expected shape");
  }
  return c;
}

/** An ISO time as Authorize.net takes it: UTC, to the second. */
export const authorizeNetDate = (iso: string) => `${new Date(iso).toISOString().slice(0, 19)}Z`;

/** The end of the window a cursor is in. */
const windowEnd = (c: AuthorizeNetCursor) => new Date(Math.min(Date.parse(c.windowStart) + WINDOW_MS, Date.parse(c.until))).toISOString();

/** On to the next window, or to the unsettled transactions after the last one. */
function nextWindow(c: AuthorizeNetCursor): AuthorizeNetCursor {
  const end = windowEnd(c);
  return Date.parse(end) >= Date.parse(c.until) ? { ...c, step: "unsettled", batches: [], page: 1 } : { ...c, step: "batches", windowStart: end, batches: [], page: 1 };
}

/** Whether a page of a transaction list has more behind it: by the total when given, else by a full page. */
function morePages(body: Record<string, unknown>, page: number, read: number): boolean {
  const total = Number(body.totalNumInSet);
  return Number.isInteger(total) && total >= 0 ? page * AUTHORIZE_NET_PAGE_SIZE < total : read >= AUTHORIZE_NET_PAGE_SIZE;
}

export function authorizeNetConnector(options: AuthorizeNetConnectorOptions): Connector {
  const client = options.client ?? authorizeNetClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;

  function startHistorical(): AuthorizeNetCursor {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    const t = now().getTime();
    // The first incremental pass picks up anything that settled while the import ran.
    return { pass: "historical", step: "batches", windowStart: start.toISOString(), until: new Date(t).toISOString(), batches: [], page: 1, nextFrom: new Date(t - AUTHORIZE_NET_OVERLAP_MS).toISOString() };
  }

  function startIncremental(previous: AuthorizeNetCursor | null): AuthorizeNetCursor {
    const t = now().getTime();
    const since = Math.min(Date.parse(previous?.nextFrom ?? new Date(t - lookbackHours * 3_600_000).toISOString()), t);
    return { pass: "incremental", step: "batches", windowStart: new Date(since).toISOString(), until: new Date(t).toISOString(), batches: [], page: 1, nextFrom: new Date(t - AUTHORIZE_NET_OVERLAP_MS).toISOString() };
  }

  /** The account's currency, from its merchant details: transactions don't carry one. */
  async function currencyOf(): Promise<string> {
    const body = await client.request("getMerchantDetailsRequest");
    const currencies = Array.isArray(body.currencies) ? body.currencies : ((body.currencies as { currency?: unknown } | undefined)?.currency ?? []);
    const currency = (Array.isArray(currencies) ? currencies : [currencies]).find((c): c is string => typeof c === "string" && /^[A-Z]{3}$/.test(c));
    if (!currency) throw new AuthorizeNetApiError("Authorize.net's merchant details name no currency", 200);
    return currency;
  }

  /** A page of transactions as events, with the transaction each refund or chargeback refers to. */
  async function transactionEvents(records: Record<string, unknown>[], currency: string, batchId?: string): Promise<AuthorizeNetBrainEvent[]> {
    const receivedAt = now().toISOString();
    const events: AuthorizeNetBrainEvent[] = [];
    for (const t of records as AuthorizeNetTransaction[]) {
      let refTransId: string | undefined;
      const id = authorizeNetId(t.transId);
      if (id && authorizeNetNeedsLink(t.transactionStatus)) {
        const details = await client.request("getTransactionDetailsRequest", { transId: id });
        refTransId = authorizeNetId((details.transaction as { refTransId?: unknown } | undefined)?.refTransId);
      }
      events.push(...authorizeNetTransactionEvents(t, { currency, ...(batchId ? { batchId } : {}), ...(refTransId ? { refTransId } : {}) }, receivedAt));
    }
    return events;
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseAuthorizeNetCursor(context.cursor);
    let cursor: AuthorizeNetCursor;
    if (mode === "historical") {
      // A finished import stays finished (its step is done); an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved);
    }
    if (cursor.step === "done") return;
    const currency = await currencyOf();
    const sorting = { orderBy: "id", orderDescending: false } as const;

    while (cursor.step !== "done") {
      let events: AuthorizeNetBrainEvent[];
      if (cursor.step === "batches") {
        const body = await client.request("getSettledBatchListRequest", {
          includeStatistics: true,
          firstSettlementDate: authorizeNetDate(cursor.windowStart),
          lastSettlementDate: authorizeNetDate(windowEnd(cursor)),
        });
        const batches = authorizeNetList(body.batchList, "batch");
        events = batches.flatMap((b) => authorizeNetBatchEvents(b, currency, now().toISOString()));
        const ids = [...new Set(batches.map((b) => authorizeNetId(b.batchId)).filter((id): id is string => !!id))].slice(0, MAX_BATCHES);
        cursor = ids.length ? { ...cursor, step: "transactions", batches: ids, page: 1 } : nextWindow(cursor);
      } else if (cursor.step === "transactions") {
        const batchId = cursor.batches[0]!;
        const body = await client.request("getTransactionListRequest", { batchId, sorting, paging: { limit: AUTHORIZE_NET_PAGE_SIZE, offset: cursor.page } });
        const records = authorizeNetList(body.transactions, "transaction");
        events = await transactionEvents(records, currency, batchId);
        const rest = cursor.batches.slice(1);
        cursor = morePages(body, cursor.page, records.length)
          ? { ...cursor, page: cursor.page + 1 }
          : rest.length
            ? { ...cursor, batches: rest, page: 1 }
            : nextWindow(cursor);
      } else {
        const body = await client.request("getUnsettledTransactionListRequest", { sorting, paging: { limit: AUTHORIZE_NET_PAGE_SIZE, offset: cursor.page } });
        const records = authorizeNetList(body.transactions, "transaction");
        events = await transactionEvents(records, currency);
        cursor = morePages(body, cursor.page, records.length) ? { ...cursor, page: cursor.page + 1 } : { ...cursor, step: "done", page: 1 };
      }
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "authorize_net",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: AUTHORIZE_NET_WRITES,
  };
}
