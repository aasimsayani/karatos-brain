import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { JM_SHIPPING_IDS_PER_REQUEST, isJmShippingDay, jmShippingClient, type JmShippingClient, type JmShippingClientOptions } from "./client.js";
import { jmClaimEvent, jmReconciledEvent, jmShipmentEvent, jmShippingGid, jmShippingUnlisted, jmTrackingEvent, type JmShipmentFacts, type JmShippingEvent } from "./normalize.js";

/**
 * JM Shipping Solution: the insured parcels a store ships through Jewelers
 * Mutual, with their tracking, insurance claims and reconciled carrier
 * charges, for sales and finance.
 *
 * JM lists a store's shipments only by a date range, as GUIDs, and reads
 * them in comma-delimited batches; claims are read one shipment at a time.
 * So each sync walks the range a week at a time, oldest first. For each
 * week it lists the shipments, reads their details and latest tracking 20
 * at a time, reads the claim of each one that was bought and not voided,
 * then lists the shipments JM reconciled that week. Each week is one batch,
 * and the checkpoint keeps the next week's first day, so a sync that stops
 * resumes with the same week.
 *
 * - The historical import walks the last five years, up to today, and stops
 *   for good once done.
 * - Each later sync walks the last 60 days again, since tracking, claims
 *   and reconciliation keep changing after a parcel ships. What didn't
 *   change comes back as duplicates. A claim filed on a parcel older than
 *   that isn't seen until the next historical import.
 *
 * A week's range runs from its first day to the next week's first day, so
 * days JM counts as inclusive overlap by one day, and a shipment read twice
 * is a duplicate.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send one. */
export const JM_SHIPPING_WRITES: WriteAction[] = [
  { integration: "jm_shipping_solution", name: "purchase_shipment", description: "Buy an insured shipping label through JM Shipping Solution", kind: "append", approval: "each", dailyCap: 5 },
  { integration: "jm_shipping_solution", name: "cancel_shipment", description: "Cancel a JM Shipping Solution shipment", kind: "update", approval: "each", dailyCap: 5 },
  { integration: "jm_shipping_solution", name: "submit_claim", description: "File an insurance claim on a JM Shipping Solution shipment", kind: "append", approval: "each", dailyCap: 5 },
  { integration: "jm_shipping_solution", name: "dispute_charge", description: "Dispute a JM Shipping Solution reconciliation charge", kind: "append", approval: "each", dailyCap: 5 },
];

const DAY_MS = 86_400_000;
/** The historical import reads shipments from this many years back. */
export const JM_SHIPPING_HISTORY_YEARS = 5;
/** Later syncs read shipments from this many days back again. */
export const JM_SHIPPING_REVISIT_DAYS = 60;
/** Days one batch covers. */
export const JM_SHIPPING_WINDOW_DAYS = 7;

/** Serialized as the runSync checkpoint. */
export interface JmShippingCursor {
  /** The pass finished: the historical import never runs again, and the next sync starts a fresh pass. */
  done: boolean;
  /** The first day of the next week to read, while the pass isn't done. */
  next: string | null;
  /** The day the pass reads up to, the day after the one it began. */
  end: string | null;
}

export interface JmShippingOptions extends JmShippingClientOptions {
  now?: () => Date;
  /** Replaced in tests. */
  client?: JmShippingClient;
}

const MESSAGE = "JM Shipping Solution checkpoint is not in the expected shape";

export function parseJmShippingCursor(raw: string | null): JmShippingCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new Error(MESSAGE);
  }
  if (typeof c !== "object" || c === null || Array.isArray(c)) throw new Error(MESSAGE);
  const r = c as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "done,end,next") throw new Error(MESSAGE);
  const doneOk = r.done === true && r.next === null && r.end === null;
  const openOk = r.done === false && isJmShippingDay(r.next) && isJmShippingDay(r.end) && r.next < r.end;
  if (!doneOk && !openOk) throw new Error(MESSAGE);
  return { done: r.done as boolean, next: r.next as string | null, end: r.end as string | null };
}

const FINISHED: JmShippingCursor = { done: true, next: null, end: null };
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const plus = (d: string, days: number) => day(Date.parse(`${d}T00:00:00Z`) + days * DAY_MS);

export function jmShippingConnector(options: JmShippingOptions): Connector {
  const client = options.client ?? jmShippingClient(options);
  const now = options.now ?? (() => new Date());

  /** The events for one batch of shipment GUIDs: details, tracking, then each claim. */
  async function shipmentEvents(gids: string[], receivedAt: string): Promise<JmShippingEvent[]> {
    const events: JmShippingEvent[] = [];
    const facts = new Map<string, JmShipmentFacts>();
    for (const raw of await client.shipments(gids)) {
      const read = jmShipmentEvent(raw, receivedAt);
      events.push(read.event);
      if (read.facts) facts.set(read.facts.gid, read.facts);
    }
    for (const raw of await client.tracking(gids)) {
      const read = jmTrackingEvent(raw, facts, receivedAt);
      if (read) events.push(read.event);
    }
    for (const shipment of facts.values()) {
      if (!shipment.claimable) continue;
      const answer = await client.claim(shipment.gid);
      const read = answer === null ? null : jmClaimEvent(answer, shipment, receivedAt);
      if (read) events.push(read.event);
    }
    return events;
  }

  async function* pass(start: JmShippingCursor): AsyncIterable<SourceBatch> {
    let state = start;
    while (!state.done) {
      const from = state.next!;
      const end = state.end!;
      const to = plus(from, JM_SHIPPING_WINDOW_DAYS) < end ? plus(from, JM_SHIPPING_WINDOW_DAYS) : end;
      const receivedAt = now().toISOString();
      const events: JmShippingEvent[] = [];
      const gids: string[] = [];
      for (const raw of await client.shipmentGids(from, to)) {
        const gid = jmShippingGid(raw);
        if (!gid) events.push(jmShippingUnlisted(raw, receivedAt).event);
        else if (!gids.includes(gid)) gids.push(gid);
      }
      for (let i = 0; i < gids.length; i += JM_SHIPPING_IDS_PER_REQUEST) events.push(...(await shipmentEvents(gids.slice(i, i + JM_SHIPPING_IDS_PER_REQUEST), receivedAt)));
      for (const raw of await client.reconciled(from, to)) events.push(jmReconciledEvent(raw, receivedAt).event);
      state = to >= end ? FINISHED : { done: false, next: to, end };
      yield { events, cursor: JSON.stringify(state) };
    }
  }

  /** A fresh pass from a day back to tomorrow, so today is read in full. */
  const fresh = (from: string): JmShippingCursor => ({ done: false, next: from, end: plus(day(now().getTime()), 1) });

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseJmShippingCursor(context.cursor);
    const at = now();
    const start = day(Date.UTC(at.getUTCFullYear() - JM_SHIPPING_HISTORY_YEARS, at.getUTCMonth(), at.getUTCDate()));
    // A finished import has nothing left to read, so it yields nothing.
    yield* pass(saved ?? fresh(start));
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseJmShippingCursor(context.cursor);
    yield* pass(saved && !saved.done ? saved : fresh(day(now().getTime() - JM_SHIPPING_REVISIT_DAYS * DAY_MS)));
  }

  return { source: "jm_shipping_solution", historicalImport, incrementalSync, writes: JM_SHIPPING_WRITES };
}
