import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { AFFIRM_ID, AFFIRM_PAGE_SIZES, AffirmApiError, affirmClient, type AffirmClient, type AffirmClientOptions } from "./client.js";
import {
  affirmDisputeEvents,
  affirmId,
  affirmIsRefund,
  affirmRefundEvents,
  affirmSettlementEvents,
  affirmTransactionEvents,
  type AffirmBrainEvent,
  type AffirmDispute,
  type AffirmSettlementSummary,
  type AffirmTransaction,
  type AffirmTransactionEvent,
} from "./normalize.js";

/**
 * Reads financed orders (Affirm's transactions), refunds, disputes and each
 * day's settlement. The historical import lists transactions created over
 * the last five years, newest first, 100 at a time, with each one's current
 * status, then the refund events over the same span, every dispute, and the
 * daily settlement summaries 1000 at a time.
 *
 * Incremental syncs list the transactions created since the previous pass
 * started, less an overlap, then every transaction event since then. A
 * capture, void, expiry or refund changes an older transaction's status, so
 * each transaction such an event names is read again. Disputes are read
 * whole on every pass: a merchant has few, and a dispute's status moves
 * without a date to filter on. Settlement summaries are read from the day
 * the pass starts.
 */

/** Declared so they can be gated and audited; none runs while writes are off. The keys themselves can't be limited to reading. */
export const AFFIRM_WRITES: WriteAction[] = [
  { integration: "affirm", name: "capture_transaction", description: "Capture an authorized Affirm transaction, so the merchant is paid" },
  { integration: "affirm", name: "refund_transaction", description: "Refund all or part of a captured Affirm transaction" },
  { integration: "affirm", name: "void_transaction", description: "Void an authorized Affirm transaction that hasn't been captured" },
];

/** Each incremental pass starts this long before the previous one did, so a change saved mid-pass is never missed. */
export const AFFIRM_OVERLAP_MS = 60 * 60_000;

type Step = "transactions" | "events" | "disputes" | "settlements" | "done";
const STEPS: Step[] = ["transactions", "events", "disputes", "settlements", "done"];

/** Event types that change a transaction already listed; incremental passes read it again for its new status. */
const REREAD = new Set(["capture", "split_capture", "void", "partial_void", "auth_expired", "expire_authorization", "refund", "refund_voided", "charge_off"]);

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface AffirmCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** ISO time the pass reads from. */
  since: string;
  /** ISO time the pass reads up to: when it started. */
  until: string;
  /**
   * Where the current step's next page starts, or null for its first page:
   * the last transaction id, the event id next_page names, a dispute page
   * number, or a settlement cursor as uuid|date.
   */
  page: string | null;
  /** ISO time the next incremental pass reads from. */
  nextFrom: string;
}

export interface AffirmConnectorOptions extends AffirmClientOptions {
  /** Years of history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: AffirmClient;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const isTime = (t: unknown) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t));
const SETTLEMENT_PAGE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\|(\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z)?)$/;

/** Whether a page marker fits the step it was saved for. */
function pageFits(step: Step, page: unknown): boolean {
  if (page === null) return true;
  if (typeof page !== "string") return false;
  switch (step) {
    case "transactions":
    case "events":
      return AFFIRM_ID.test(page);
    case "disputes":
      return /^[1-9]\d{0,4}$/.test(page);
    case "settlements":
      return SETTLEMENT_PAGE.test(page);
    default:
      return false;
  }
}

export function parseAffirmCursor(raw: string | null): AffirmCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as AffirmCursor;
  if (
    !c ||
    typeof c !== "object" ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    ![c.since, c.until, c.nextFrom].every(isTime) ||
    Date.parse(c.since) > Date.parse(c.until) ||
    !pageFits(c.step, c.page)
  ) {
    throw new Error("Affirm checkpoint is not in the expected shape");
  }
  return c;
}

/** A day as Affirm's transaction lists take it: MM-DD-YYYY, in UTC. */
export const affirmMdy = (ms: number) => {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(5, 7)}-${iso.slice(8, 10)}-${iso.slice(0, 4)}`;
};
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/**
 * The parameters a next_page or prev_page string carries. Affirm writes them
 * URL-encoded, possibly as a whole URL; empty means there is no such page.
 */
export function affirmPageParams(value: unknown): URLSearchParams | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let text = value.trim();
  if (/%[0-9A-Fa-f]{2}/.test(text) && !/[=&]/.test(text)) {
    try {
      text = decodeURIComponent(text);
    } catch {
      return new URLSearchParams();
    }
  }
  const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : text;
  return new URLSearchParams(query);
}

const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object") : []);

export function affirmConnector(options: AffirmConnectorOptions): Connector {
  const client = options.client ?? affirmClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;

  function startHistorical(): AffirmCursor {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    const t = now().getTime();
    // The first incremental pass picks up anything that changed while the import ran.
    return { pass: "historical", step: "transactions", since: start.toISOString(), until: new Date(t).toISOString(), page: null, nextFrom: new Date(t - AFFIRM_OVERLAP_MS).toISOString() };
  }

  function startIncremental(previous: AffirmCursor | null): AffirmCursor {
    const t = now().getTime();
    const since = Math.min(Date.parse(previous?.nextFrom ?? new Date(t - lookbackHours * 3_600_000).toISOString()), t);
    return { pass: "incremental", step: "transactions", since: new Date(since).toISOString(), until: new Date(t).toISOString(), page: null, nextFrom: new Date(t - AFFIRM_OVERLAP_MS).toISOString() };
  }

  /** On to the next step, at its first page. */
  const next = (c: AffirmCursor): AffirmCursor => ({ ...c, step: STEPS[STEPS.indexOf(c.step) + 1]!, page: null });

  /** A page marker that must move on, or the list would be read forever. */
  function onward(c: AffirmCursor, page: string | null, what: string): AffirmCursor {
    if (page === null) return next(c);
    if (page === c.page) throw new AffirmApiError(`Affirm's ${what} next page points back at this one`, 200);
    return { ...c, page };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseAffirmCursor(context.cursor);
    let cursor: AffirmCursor;
    if (mode === "historical") {
      // A finished import stays finished (its step is done); an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved);
    }

    while (cursor.step !== "done") {
      const receivedAt = now().toISOString();
      let events: AffirmBrainEvent[];
      if (cursor.step === "transactions") {
        const body = await client.get("list_transactions", {
          transaction_type: "charge",
          limit: AFFIRM_PAGE_SIZES.transactions,
          after_timestamp: seconds(cursor.since),
          before_timestamp: seconds(cursor.until),
          ...(cursor.page ? { before: cursor.page } : {}),
        });
        const records = list(body.transactions) as AffirmTransaction[];
        events = records.flatMap((t) => affirmTransactionEvents(t, receivedAt));
        // Newest first: the next page is the transactions before the last one listed.
        const last = affirmId(records.at(-1)?.id);
        cursor = onward(cursor, body.has_next === true && last ? last : null, "transaction list");
      } else if (cursor.step === "events") {
        const body = await client.get("list_transaction_events", {
          transaction_type: "charge",
          // The historical pass lists transactions with their current status, so it only needs the refunds.
          transaction_event_type: cursor.pass === "historical" ? "refund" : "all",
          limit: AFFIRM_PAGE_SIZES.events,
          after_date: affirmMdy(Date.parse(cursor.since)),
          // A day past the end, in case before_date is exclusive.
          before_date: affirmMdy(Date.parse(cursor.until) + 86_400_000),
          ...(cursor.page ? { before_ari: cursor.page } : {}),
        });
        events = [];
        const changed = new Set<string>();
        for (const group of list(body.transactions)) {
          const transactionId = affirmId(group.transaction_id);
          for (const e of list(group.transaction_events) as AffirmTransactionEvent[]) {
            if (affirmIsRefund(e.type)) events.push(...affirmRefundEvents(transactionId, e, receivedAt));
            if (cursor.pass === "incremental" && transactionId && typeof e.type === "string" && REREAD.has(e.type)) changed.add(transactionId);
          }
        }
        for (const id of changed) {
          const t = await client.get("read_transaction", { id });
          events.push(...affirmTransactionEvents(t as AffirmTransaction, receivedAt));
        }
        const more = affirmPageParams(body.next_page);
        const ari = more?.get("before_ari") ?? null;
        if (more && !(ari && AFFIRM_ID.test(ari))) throw new AffirmApiError("Affirm's transaction events next_page names no event to continue from", 200);
        cursor = onward(cursor, ari, "transaction events");
      } else if (cursor.step === "disputes") {
        const page = Number(cursor.page ?? 1);
        const body = await client.get("list_disputes", { limit: AFFIRM_PAGE_SIZES.disputes, page_number: page });
        const records = list(body.disputes) as AffirmDispute[];
        events = records.flatMap((d) => affirmDisputeEvents(d, receivedAt));
        const more = (body.page_info as { has_next?: unknown } | undefined)?.has_next === true && records.length > 0;
        cursor = onward(cursor, more ? String(page + 1) : null, "dispute list");
      } else {
        const [uuid, date] = cursor.page ? cursor.page.split("|") : [];
        const body = await client.get("list_settlement_event_summaries", {
          limit: AFFIRM_PAGE_SIZES.settlements,
          after: ymd(Date.parse(cursor.since)),
          before: ymd(Date.parse(cursor.until)),
          ...(uuid && date ? { to_cursor_uuid: uuid, to_cursor_date: date } : {}),
        });
        events = (list(body.data) as AffirmSettlementSummary[]).flatMap((s) => affirmSettlementEvents(s, receivedAt));
        const more = affirmPageParams(body.next_page);
        const marker = more ? `${(more.get("to_cursor_uuid") ?? "").toLowerCase()}|${more.get("to_cursor_date") ?? ""}` : null;
        if (marker !== null && !SETTLEMENT_PAGE.test(marker)) throw new AffirmApiError("Affirm's settlement next_page names no cursor to continue from", 200);
        cursor = onward(cursor, marker, "settlement summaries");
      }
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "affirm",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: AFFIRM_WRITES,
  };
}
