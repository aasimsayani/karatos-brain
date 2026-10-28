import { createHash } from "node:crypto";
import type { EventEnvelope } from "./events.js";

/**
 * Slim copy. Brain A keeps the cleaned-up facts (entities, links), the
 * signals and recommendations built on them, and a reference back to each
 * source record. Raw vendor data (event payloads, dead-lettered input,
 * uploaded file contents) is cleared once it is older than the retention
 * window. The client's own systems stay the source of truth: anything that
 * needs the raw detail later re-reads it there through the source reference.
 */

/** How long raw vendor data is kept, in days, unless an instance sets RAW_RETENTION_DAYS. */
export const DEFAULT_RAW_RETENTION_DAYS = 30;
export const MIN_RAW_RETENTION_DAYS = 1;
export const MAX_RAW_RETENTION_DAYS = 365;

const DAY_MS = 86_400_000;

/** Where a record lives in the client's own system, so a person can open the original. */
export interface SourceReference {
  /** The source system's id, e.g. "shopify". Same as the event's source. */
  system: string;
  /** The vendor's own id for the record. */
  recordId: string;
  /** A link to the record in the vendor's app, when the connector knows one. */
  url?: string;
}

/** What a cleared payload is replaced with. The row, its ids, key, hash and source reference stay. */
export interface ClearedPayload {
  [key: string]: unknown;
  cleared: true;
  at: string;
  reason: "retention";
}

/** An event as stored, with what survives retention. */
export interface StoredEvent extends EventEnvelope {
  sourceRef: SourceReference;
  /** SHA-256 of the payload as first stored, kept after the payload is cleared. */
  payloadSha256: string;
  /** When the payload was cleared, or null while it is still held. */
  payloadClearedAt: string | null;
}

/** What one purge did. Every purge is recorded so the owner can see it ran. */
export interface PurgeResult {
  organizationId: string;
  ranAt: string;
  /** Raw data received before this time was cleared. */
  cutoff: string;
  retentionDays: number;
  events: number;
  deadLetters: number;
  fileImports: number;
}

/** A store that can clear raw vendor data past the retention window. */
export interface RawDataRetention {
  /**
   * Clears raw vendor data for one organization that is older than the
   * window. Idempotent: rows already cleared are left alone and not counted.
   * Never deletes a row and never touches entities, signals, recommendations,
   * decisions, outcomes, memories, links, sync runs or audit rows.
   */
  purgeRawData(organizationId: string, now: Date, retentionDays?: number): Promise<PurgeResult>;
}

/** Throws unless days is a whole number from 1 to 365. */
export function assertRetentionDays(days: number): number {
  if (!Number.isInteger(days) || days < MIN_RAW_RETENTION_DAYS || days > MAX_RAW_RETENTION_DAYS) {
    throw new RangeError(`raw retention must be a whole number of days from ${MIN_RAW_RETENTION_DAYS} to ${MAX_RAW_RETENTION_DAYS}`);
  }
  return days;
}

/** Raw data received strictly before this moment is past the window. Exactly `days` old is still kept. */
export function rawRetentionCutoff(now: Date, days: number = DEFAULT_RAW_RETENTION_DAYS): Date {
  return new Date(now.getTime() - assertRetentionDays(days) * DAY_MS);
}

export function isRawExpired(receivedAt: string, now: Date, days: number = DEFAULT_RAW_RETENTION_DAYS): boolean {
  return Date.parse(receivedAt) < rawRetentionCutoff(now, days).getTime();
}

export function clearedPayload(at: Date): ClearedPayload {
  return { cleared: true, at: at.toISOString(), reason: "retention" };
}

export function isClearedPayload(value: unknown): value is ClearedPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.cleared === true && v.reason === "retention" && typeof v.at === "string";
}

/** Key order doesn't change the hash. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value ?? null))).digest("hex");
}

/**
 * The source record behind an event: what the connector declared, else the
 * first payload id in the source's own namespace (e.g. "shopify:order:123"),
 * else the idempotency key, which every event has.
 */
export function sourceReferenceFor(event: EventEnvelope): SourceReference {
  const system = event.source;
  if (event.sourceRecord) {
    return { system, recordId: event.sourceRecord.id, ...(event.sourceRecord.url ? { url: event.sourceRecord.url } : {}) };
  }
  const prefix = `${system}:`;
  const named = Object.values(event.payload).find((v): v is string => typeof v === "string" && v.startsWith(prefix) && v.length > prefix.length);
  return { system, recordId: named ?? event.idempotencyKey };
}
