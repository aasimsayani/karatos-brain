import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { CLOVER_PAGE_SIZE, cloverClient, type CloverClient, type CloverClientOptions, type CloverListOptions } from "./client.js";
import { cloverId, cloverNormalizer, itemSku, type CloverBrainEvent } from "./normalize.js";

/**
 * Reads one Clover merchant: items, item stocks, customers, orders (with
 * their lines, payments and refunds), payments and refunds.
 *
 * Every run first reads the merchant itself, so a token for another
 * merchant stops before anything is imported. Then:
 * - items: all of them on the historical import, then those modified since
 *   the last pass (`filter=modifiedTime>=`), oldest change first;
 * - item stocks and customers: all of them every pass, since Clover gives
 *   neither a modified-time filter; unchanged ones come back as duplicates;
 * - orders and payments: by modifiedTime, refunds by createdTime (they have
 *   no modifiedTime), in windows of at most 89 days, because Clover returns
 *   at most 90 days of these per request and quietly trims a longer range.
 *
 * Each page is 1000 records, Clover's limit, oldest first. The next page
 * starts from the last record's time rather than a growing offset, so a
 * record changed mid-pass (which leaves the window) can't shift the pages and
 * make one be missed. The checkpoint records the step, the window and the
 * position, so a sync stopped by a rate limit or an outage resumes at the
 * page it stopped on.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client only sends GETs. */
export const CLOVER_WRITES: WriteAction[] = [
  { integration: "clover", name: "adjust_stock", description: "Set an item's stock count" },
  { integration: "clover", name: "update_item", description: "Change an item's name, price or SKU" },
];

export const CLOVER_STEPS = ["items", "item_stocks", "customers", "orders", "payments", "refunds", "done"] as const;
type Step = (typeof CLOVER_STEPS)[number];
const WINDOWED = new Set<Step>(["orders", "payments", "refunds"]);

/** Clover's 90-day cap per request on orders, payments and refunds, less a day so a window is never trimmed. */
export const CLOVER_WINDOW_MS = 89 * 86_400_000;
/** Each incremental pass starts this long before the previous one did, so a change saved mid-pass is never missed. */
export const CLOVER_OVERLAP_MS = 5 * 60_000;

/** Where a sync stands. Serialized as the runSync checkpoint. Times are epoch milliseconds, as Clover writes them. */
export interface CloverCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** Lower bound of this pass: changes (or, for refunds, creations) from this time. */
  since: number;
  /** Upper bound of this pass, fixed when it started; later changes belong to the next pass. */
  until: number;
  /** Where the next incremental pass starts. */
  nextFrom: number;
  /** The current window of a time-keyed step: records with times from `from`, before `to`. */
  from: number;
  to: number;
  /**
   * Records to skip: for a time-keyed step, those already read at exactly
   * `from`; for item stocks and customers, those already read.
   */
  offset: number;
}

export interface CloverConnectorOptions extends CloverClientOptions {
  /** This instance's CUSTOMER_REF_KEY: customers are kept as keyed references only. */
  customerKey: string;
  /** Years of history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: CloverClient;
}

const isTime = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 1e14;

export function parseCloverCursor(raw: string | null): CloverCursor | null {
  if (raw === null) return null;
  let c: CloverCursor;
  try {
    c = JSON.parse(raw) as CloverCursor;
  } catch {
    throw new Error("Clover checkpoint is not in the expected shape");
  }
  if (
    !c ||
    typeof c !== "object" ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !(CLOVER_STEPS as readonly string[]).includes(c.step) ||
    !Number.isInteger(c.offset) ||
    c.offset < 0 ||
    ![c.since, c.until, c.nextFrom, c.from, c.to].every(isTime) ||
    c.since > c.until ||
    c.from > c.to ||
    c.to > c.until
  ) {
    throw new Error("Clover checkpoint is not in the expected shape");
  }
  return c;
}

/** The time each time-keyed step pages by. Refunds have no modifiedTime. */
const TIME_FIELD: Partial<Record<Step, "modifiedTime" | "createdTime">> = { items: "modifiedTime", orders: "modifiedTime", payments: "modifiedTime", refunds: "createdTime" };
const EXPAND: Partial<Record<Step, string[]>> = {
  orders: ["lineItems", "lineItems.discounts", "payments", "refunds", "customers"],
  payments: ["tender", "cardTransaction", "refunds"],
  refunds: ["payment"],
};

/** The request for the current page of a step. Filters are built from the cursor's own times, never from outside text. */
export function cloverPageRequest(cursor: CloverCursor): CloverListOptions {
  const field = TIME_FIELD[cursor.step];
  const page = { limit: CLOVER_PAGE_SIZE, offset: cursor.offset };
  if (!field) return page;
  return { ...page, orderBy: `${field} ASC`, filters: [`${field}>=${cursor.from}`, `${field}<${cursor.to}`], ...(EXPAND[cursor.step] ? { expand: EXPAND[cursor.step] } : {}) };
}

/** The window a step starts with: items in one span (all of them on the import), the rest 89 days at a time. */
function firstWindow(cursor: Pick<CloverCursor, "pass" | "since" | "until">, step: Step): { from: number; to: number } {
  if (step === "items") return { from: cursor.pass === "historical" ? 0 : cursor.since, to: cursor.until };
  if (WINDOWED.has(step)) return { from: cursor.since, to: Math.min(cursor.since + CLOVER_WINDOW_MS, cursor.until) };
  return { from: cursor.since, to: cursor.since };
}

/**
 * Where to read next after a page. A full page moves `from` up to the last
 * record's time and skips the records already read at that time, so records
 * changed mid-pass, which leave the window, can't shift a later page and
 * make it miss one. A short page ends the window, then the step.
 */
export function nextCloverCursor(cursor: CloverCursor, elements: readonly Record<string, unknown>[]): CloverCursor {
  const field = TIME_FIELD[cursor.step];
  if (elements.length >= CLOVER_PAGE_SIZE) {
    const last = field ? elements[elements.length - 1]![field] : undefined;
    if (!field || !isTime(last) || last < cursor.from || last >= cursor.to) return { ...cursor, offset: cursor.offset + elements.length };
    const atLast = elements.filter((e) => e[field] === last).length;
    return last === cursor.from ? { ...cursor, offset: cursor.offset + elements.length } : { ...cursor, from: last, offset: atLast };
  }
  if (WINDOWED.has(cursor.step) && cursor.to < cursor.until) {
    return { ...cursor, from: cursor.to, to: Math.min(cursor.to + CLOVER_WINDOW_MS, cursor.until), offset: 0 };
  }
  const step = CLOVER_STEPS[CLOVER_STEPS.indexOf(cursor.step) + 1]!;
  return { ...cursor, step, offset: 0, ...firstWindow(cursor, step) };
}

export function cloverConnector(options: CloverConnectorOptions): Connector {
  const client = options.client ?? cloverClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;
  const normalize = cloverNormalizer({ merchantId: options.merchantId.trim(), customerKey: options.customerKey });
  // SKUs of items read in this run, so sold lines carry the same SKU as the item. Unknown ones are fetched once.
  const skus = new Map<string, string | null>();

  function startHistorical(): CloverCursor {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    const until = now().getTime();
    // The first incremental pass picks up anything changed while the import ran.
    return { pass: "historical", step: "items", since: start.getTime(), until, nextFrom: until - CLOVER_OVERLAP_MS, ...firstWindow({ pass: "historical", since: start.getTime(), until }, "items"), offset: 0 };
  }

  function startIncremental(previous: CloverCursor | null): CloverCursor {
    const until = now().getTime();
    const since = Math.min(previous?.nextFrom ?? until - lookbackHours * 3_600_000, until);
    return { pass: "incremental", step: "items", since, until, nextFrom: until - CLOVER_OVERLAP_MS, ...firstWindow({ pass: "incremental", since, until }, "items"), offset: 0 };
  }

  async function skuOf(ids: Iterable<string>): Promise<void> {
    for (const id of ids) {
      if (skus.has(id)) continue;
      const item = await client.item(id);
      skus.set(id, item ? (itemSku(item) ?? null) : null);
    }
  }
  const lookup = (id: string) => skus.get(id) ?? undefined;

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseCloverCursor(context.cursor);
    let cursor: CloverCursor;
    if (mode === "historical") {
      // A finished import stays finished (its step is done); an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved);
    }

    if (cursor.step === "done") return;
    // Every run first reads the merchant, so a token for another merchant stops before anything is imported.
    // Only the ID is looked at: the merchant's name and address aren't kept.
    const merchant = await client.merchant();
    if (cloverId(merchant.id) !== options.merchantId.trim()) throw new Error("the Clover token answered for a different merchant than CLOVER_MERCHANT_ID");

    while (cursor.step !== "done") {
      const step = cursor.step;
      const receivedAt = now().toISOString();
      let events: CloverBrainEvent[];
      const elements = (await client.list(step, cloverPageRequest(cursor))).elements;
      if (step === "items") {
        for (const item of elements) {
          const id = cloverId(item.id);
          if (id) skus.set(id, itemSku(item) ?? null);
        }
        events = elements.flatMap((r) => normalize.itemEvents(r, receivedAt));
      } else if (step === "item_stocks" || step === "orders") {
        const ids = new Set<string>();
        for (const r of elements) {
          const lines = step === "orders" ? ((r.lineItems as { elements?: unknown[] } | undefined)?.elements ?? []) : [r];
          for (const l of lines) {
            const id = cloverId((l as { item?: { id?: unknown } } | null)?.item?.id);
            if (id) ids.add(id);
          }
        }
        await skuOf(ids);
        events = elements.flatMap((r) => (step === "orders" ? normalize.orderEvents(r, receivedAt, lookup) : normalize.stockEvents(r, receivedAt, lookup)));
      } else if (step === "customers") {
        events = elements.flatMap((r) => normalize.customerEvents(r, receivedAt));
      } else if (step === "payments") {
        events = elements.flatMap((r) => normalize.paymentEvents(r, receivedAt));
      } else {
        events = elements.flatMap((r) => normalize.refundEvents(r, receivedAt));
      }
      cursor = nextCloverCursor(cursor, elements);
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "clover",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: CLOVER_WRITES,
  };
}
