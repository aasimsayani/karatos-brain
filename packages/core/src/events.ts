import { z } from "zod";

/**
 * Layer 1, Event Ingestion. Every piece of source data enters Brain A as an
 * immutable, auditable event before anything transforms it.
 */
export const EventEnvelopeSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  /** System the event came from, e.g. "shopify", "stripe", "manual". */
  source: z.string().min(1),
  /** Dotted event type, e.g. "order.created". */
  type: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, "type must be dotted lowercase, e.g. order.created"),
  occurredAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  /** Stable key so replays and retries never create duplicate events. */
  idempotencyKey: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export function parseEvent(input: unknown): EventEnvelope {
  return EventEnvelopeSchema.parse(input);
}

/**
 * An input that failed validation. It is kept, not dropped, so a person can
 * fix the connector or the data and replay it.
 */
export interface DeadLetter {
  id: string;
  organizationId?: string;
  source?: string;
  reason: string;
  issues: { path: string; message: string }[];
  raw: unknown;
  receivedAt: string;
}
