import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { stripeClient, type StripeClient, type StripeClientOptions } from "./client.js";
import { stripeObjectEvents, type StripeBrainEvent } from "./normalize.js";
import { stripeWebhookEvents, STRIPE_EVENT_TYPES, type StripeEvent } from "./webhooks.js";

/**
 * Reads charges, refunds, disputes, payouts, balance transactions and
 * customers. The historical import lists each object type back to its start
 * date. Incremental syncs read Stripe's events, which carry each changed
 * object, plus new balance transactions, which have no events. Stripe keeps
 * events for 30 days, so an instance that hasn't synced in 30 days needs a
 * new historical import to catch up.
 */

export const STRIPE_STREAMS = ["charges", "refunds", "disputes", "payouts", "balance_transactions", "customers"] as const;
export type StripeStream = (typeof STRIPE_STREAMS)[number];
type Stream = StripeStream | "events";

/** Declared so they can be gated and audited; none runs while writes are off, and the key is read-only. */
export const STRIPE_WRITES: WriteAction[] = [
  { integration: "stripe", name: "create_payment_link", description: "Create a payment link for a customer to pay" },
  { integration: "stripe", name: "create_refund", description: "Refund all or part of a charge" },
];

const PAGE_SIZE = 100;
/** Stripe keeps events for 30 days; start a little inside that. */
export const STRIPE_EVENT_RETENTION_SECONDS = 30 * 86_400 - 3_600;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface StripeCursor {
  pass: "historical" | "incremental";
  /** The stream being read, or "done" once the pass finished. */
  stream: Stream | "done";
  /** Stripe's `starting_after`: the last object id read in this stream. */
  startingAfter: string | null;
  /** Unix seconds: the current stream reads objects created at or after this. */
  since: number;
  /** Unix seconds the next incremental pass reads events from. Set to the start time on a historical pass. */
  eventsFrom: number;
  /** Unix seconds the next incremental pass reads balance transactions from. */
  balanceFrom: number;
}

export interface StripeConnectorOptions extends StripeClientOptions {
  /** Years of history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: StripeClient;
}

const PATHS: Record<Stream, string> = {
  charges: "/v1/charges",
  refunds: "/v1/refunds",
  disputes: "/v1/disputes",
  payouts: "/v1/payouts",
  balance_transactions: "/v1/balance_transactions",
  customers: "/v1/customers",
  events: "/v1/events",
};

const HISTORICAL: Stream[] = [...STRIPE_STREAMS];
const INCREMENTAL: Stream[] = ["events", "balance_transactions"];

export function parseStripeCursor(raw: string | null): StripeCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as StripeCursor;
  const streams: string[] = [...HISTORICAL, "events", "done"];
  if (
    !c ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !streams.includes(c.stream) ||
    ![c.since, c.eventsFrom, c.balanceFrom].every((n) => Number.isInteger(n) && n >= 0)
  ) {
    throw new Error("Stripe checkpoint is not in the expected shape");
  }
  return c;
}

export function stripeConnector(options: StripeConnectorOptions): Connector {
  const client = options.client ?? stripeClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;
  const unixNow = () => Math.floor(now().getTime() / 1000);

  function startHistorical(): StripeCursor {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    const t = unixNow();
    // Incremental syncs keep their own checkpoint; the first one looks back
    // incrementalLookbackHours, so set it above an import's run time.
    return { pass: "historical", stream: HISTORICAL[0]!, startingAfter: null, since: Math.floor(start.getTime() / 1000), eventsFrom: t, balanceFrom: t };
  }

  function startIncremental(previous: StripeCursor | null): StripeCursor {
    const fallback = unixNow() - lookbackHours * 3_600;
    const oldestEvent = unixNow() - STRIPE_EVENT_RETENTION_SECONDS;
    const eventsFrom = Math.max(previous?.eventsFrom ?? fallback, oldestEvent);
    const balanceFrom = previous?.balanceFrom ?? fallback;
    return { pass: "incremental", stream: "events", startingAfter: null, since: eventsFrom, eventsFrom, balanceFrom };
  }

  function params(cursor: StripeCursor) {
    return {
      limit: PAGE_SIZE,
      created: { gte: cursor.since },
      starting_after: cursor.startingAfter ?? undefined,
      ...(cursor.stream === "events" ? { types: STRIPE_EVENT_TYPES } : {}),
    };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseStripeCursor(context.cursor);
    let cursor: StripeCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      if (saved?.pass === "historical" && saved.stream === "done") return;
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.stream !== "done" ? saved : startIncremental(saved);
    }
    const order = cursor.pass === "historical" ? HISTORICAL : INCREMENTAL;

    while (cursor.stream !== "done") {
      const stream = cursor.stream;
      const page = await client.list<{ id: string; created: number }>(PATHS[stream], params(cursor));
      const receivedAt = now().toISOString();
      const events: StripeBrainEvent[] =
        stream === "events"
          ? page.data.flatMap((e) => stripeWebhookEvents(e as unknown as StripeEvent, receivedAt))
          : page.data.flatMap((o) => stripeObjectEvents(o as { object?: string }, receivedAt));

      const next: StripeCursor = { ...cursor };
      // An incremental pass moves its own start forward to the newest record it saw.
      if (cursor.pass === "incremental") {
        const newest = Math.max(0, ...page.data.map((o) => (Number.isInteger(o.created) ? o.created : 0)));
        if (stream === "events") next.eventsFrom = Math.max(next.eventsFrom, newest);
        else next.balanceFrom = Math.max(next.balanceFrom, newest);
      }
      const last = page.data.at(-1);
      if (page.has_more && last) {
        next.startingAfter = last.id;
      } else {
        const following = order[order.indexOf(stream) + 1];
        next.stream = following ?? "done";
        next.startingAfter = null;
        // Each incremental stream starts from its own saved point.
        if (following && cursor.pass === "incremental") next.since = following === "events" ? next.eventsFrom : next.balanceFrom;
      }
      cursor = next;
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "stripe",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    handleWebhook: (body) => stripeWebhookEvents(body as StripeEvent, now().toISOString()),
    writes: STRIPE_WRITES,
  };
}
