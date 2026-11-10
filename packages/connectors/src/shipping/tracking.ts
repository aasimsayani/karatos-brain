import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";

/**
 * Shared by the carrier connectors (UPS, and FedEx and USPS next): a
 * package's tracking, read for each tracking number on the business's list
 * until it is delivered or returned, as `shipment.tracked` events.
 *
 * Kept for a package: its tracking number, carrier, a status every carrier
 * maps to, the carrier's own status code and text, its latest scan time,
 * the delivery estimate, when it was delivered, the service, whether a
 * signature or premium handling was asked for, and the destination's state
 * and country. Names, street addresses, postal codes, signatures, photos and
 * who signed are never kept.
 */

export type ShipmentStatus = "label_created" | "picked_up" | "in_transit" | "out_for_delivery" | "delivered" | "exception" | "returned" | "unknown";

/** One package's tracking, as a carrier client reads it. */
export interface PackageTracking {
  trackingNumber: string;
  status: ShipmentStatus;
  /** The carrier's own status code, such as UPS's `D`. */
  carrierStatus?: string | undefined;
  /** The carrier's status text, cut to 200 characters. */
  description?: string | undefined;
  /** The latest scan, as an ISO time. */
  lastEventAt?: string | undefined;
  /** The scheduled or rescheduled delivery day, as YYYY-MM-DD. */
  estimatedDelivery?: string | undefined;
  /** The day it was delivered, as YYYY-MM-DD. */
  deliveredAt?: string | undefined;
  service?: string | undefined;
  signatureRequired?: boolean | undefined;
  /** The carrier's premium handling level for high-value parcels, such as UPS Premier Gold. */
  premium?: string | undefined;
  destinationState?: string | undefined;
  destinationCountry?: string | undefined;
}

/** What a carrier answers for one tracking number. */
export type TrackingLookup = { kind: "found"; packages: PackageTracking[] } | { kind: "not_found" };

export interface CarrierClient {
  track(trackingNumber: string): Promise<TrackingLookup>;
}

export interface ShipmentEvent {
  id: string;
  type: "shipment.tracked";
  occurredAt: string;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** Where a tracking sync stands. Serialized as the runSync checkpoint. */
export interface TrackingCursor {
  /** Numbers delivered or returned: never read again. */
  final: string[];
  /** When each number was first read, so one that never moves is dropped after `maxAgeDays`. */
  firstSeen: Record<string, string>;
  /** Numbers already read in a sync that stopped partway, so a resumed sync skips them. Empty once a sync finishes. */
  read: string[];
}

export const FINAL_STATUSES: readonly ShipmentStatus[] = ["delivered", "returned"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isTime = (t: unknown): t is string => typeof t === "string" && ISO.test(t) && new Date(t).toISOString() === t;
/** Numbers one list may hold. */
export const MAX_TRACKING_NUMBERS = 5000;

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/**
 * The tracking numbers in a list: one or more a line, split by spaces,
 * commas or semicolons, with lines starting `#` left out. Each is uppercased
 * and kept only when it matches the carrier's pattern; repeats are dropped.
 */
export function parseTrackingNumbers(text: string, pattern: RegExp): string[] {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    for (const token of line.split(/[\s,;]+/)) {
      const n = token.toUpperCase();
      if (pattern.test(n)) out.add(n);
    }
  }
  if (out.size > MAX_TRACKING_NUMBERS) throw new Error(`the tracking list has more than ${MAX_TRACKING_NUMBERS} numbers; remove delivered ones`);
  return [...out];
}

/** The tracking numbers in a file, such as the one `UPS_TRACKING_NUMBERS_FILE` names. */
export function trackingNumbersFromFile(path: string, pattern: RegExp, read: (path: string) => Promise<string> = (p) => readFile(p, "utf8")): () => Promise<string[]> {
  return async () => parseTrackingNumbers(await read(path), pattern);
}

export function parseTrackingCursor(raw: string | null, pattern: RegExp, carrier: string): TrackingCursor | null {
  if (raw === null) return null;
  let c: TrackingCursor | null;
  try {
    c = JSON.parse(raw) as TrackingCursor | null;
  } catch {
    c = null;
  }
  const ok =
    typeof c === "object" &&
    c !== null &&
    Array.isArray(c.final) &&
    c.final.every((n) => typeof n === "string" && pattern.test(n)) &&
    typeof c.firstSeen === "object" &&
    c.firstSeen !== null &&
    !Array.isArray(c.firstSeen) &&
    Object.entries(c.firstSeen).every(([n, t]) => pattern.test(n) && isTime(t)) &&
    Array.isArray(c.read) &&
    c.read.every((n) => typeof n === "string" && pattern.test(n));
  if (!ok || !c) throw new Error(`${carrier} checkpoint is not in the expected shape`);
  return { final: c.final, firstSeen: c.firstSeen, read: c.read };
}

/** The event for one package's tracking, keyed by its number and what was read, so a status read again is a duplicate. */
export function shipmentEvent(carrier: string, p: PackageTracking, receivedAt: string): ShipmentEvent {
  const payload = defined({
    shipmentId: `${carrier}:package:${p.trackingNumber}`,
    carrier,
    trackingNumber: p.trackingNumber,
    status: p.status,
    carrierStatus: p.carrierStatus,
    description: p.description,
    lastEventAt: p.lastEventAt,
    estimatedDelivery: p.estimatedDelivery,
    deliveredAt: p.deliveredAt,
    service: p.service,
    signatureRequired: p.signatureRequired,
    premium: p.premium,
    destinationState: p.destinationState,
    destinationCountry: p.destinationCountry,
  });
  const key = `${p.trackingNumber}:${sha(JSON.stringify(payload)).slice(0, 16)}`;
  return { id: `${carrier}_${sha(key).slice(0, 32)}`, type: "shipment.tracked", occurredAt: p.lastEventAt ?? receivedAt, receivedAt, idempotencyKey: `${carrier}:${key}`, payload };
}

export interface TrackingConnectorOptions {
  carrier: string;
  client: CarrierClient;
  pattern: RegExp;
  /** The tracking numbers to read. */
  trackingNumbers: () => Promise<string[]>;
  /** The most numbers one sync reads. */
  maxPerSync: number;
  /** Numbers per batch; each batch is one checkpoint. */
  batchSize: number;
  /** A number still not delivered or returned this long after it was first read is dropped. */
  maxAgeDays: number;
  writes: WriteAction[];
  now: () => Date;
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

/**
 * A tracking connector. Each sync reads every number on the list that isn't
 * delivered or returned yet, oldest first, up to `maxPerSync`, a batch per
 * checkpoint. The historical import and the incremental sync do the same,
 * since a carrier keeps no feed of changes; a status that hasn't changed
 * comes back as a duplicate.
 */
export function trackingConnector(o: TrackingConnectorOptions): Connector {
  const maxPerSync = positive(o.maxPerSync, "maxPerSync");
  const batchSize = positive(o.batchSize, "batchSize");
  const maxAgeDays = positive(o.maxAgeDays, "maxAgeDays");

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseTrackingCursor(context.cursor, o.pattern, o.carrier) ?? { final: [], firstSeen: {}, read: [] };
    const listed = await o.trackingNumbers();
    const onList = new Set(listed);
    const final = new Set(saved.final.filter((n) => onList.has(n)));
    // Numbers taken off the list are forgotten.
    const firstSeen = new Map(Object.entries(saved.firstSeen).filter(([n]) => onList.has(n)));
    const at = o.now();
    const cutoff = at.getTime() - maxAgeDays * 86_400_000;
    for (const n of listed) if (!firstSeen.has(n)) firstSeen.set(n, at.toISOString());
    const read = new Set(saved.read.filter((n) => onList.has(n)));
    const cursor = () => JSON.stringify({ final: [...final].sort(), firstSeen: Object.fromEntries([...firstSeen].sort(([a], [b]) => (a < b ? -1 : 1))), read: [...read].sort() } satisfies TrackingCursor);

    const todo = listed
      .filter((n) => !final.has(n) && !read.has(n) && Date.parse(firstSeen.get(n)!) >= cutoff)
      .sort((a, b) => firstSeen.get(a)!.localeCompare(firstSeen.get(b)!))
      .slice(0, maxPerSync);
    if (todo.length === 0) {
      read.clear();
      yield { events: [], cursor: cursor() };
      return;
    }
    for (let i = 0; i < todo.length; i += batchSize) {
      const events: ShipmentEvent[] = [];
      for (const number of todo.slice(i, i + batchSize)) {
        const lookup = await o.client.track(number);
        if (lookup.kind === "not_found") continue;
        for (const p of lookup.packages) events.push(shipmentEvent(o.carrier, p, at.toISOString()));
        if (lookup.packages.length > 0 && lookup.packages.every((p) => FINAL_STATUSES.includes(p.status))) final.add(number);
        read.add(number);
      }
      // The last batch finishes the sync, so the next one reads every number again.
      if (i + batchSize >= todo.length) read.clear();
      yield { events, cursor: cursor() };
    }
  }

  return {
    source: o.carrier,
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: o.writes,
  };
}
