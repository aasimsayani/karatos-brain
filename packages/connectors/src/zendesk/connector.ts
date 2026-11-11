import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { ZENDESK_CURSOR, zendeskClient, type ZendeskClient, type ZendeskClientOptions, type ZendeskExport } from "./client.js";
import { zendeskTicketEvent, zendeskUserEvent } from "./normalize.js";

/**
 * Zendesk: the store's helpdesk tickets and the customers who opened them,
 * so clienteling, sales and repairs see what customers asked and how fast
 * the store answered.
 *
 * Zendesk's incremental exports list every ticket and every user that
 * changed since a time, oldest change first, and end with a cursor that
 * picks up from there next time. So:
 *
 * - The historical import starts both exports five years back and reads
 *   them to their end, tickets first.
 * - Each later sync goes on from the cursors the last one ended with, so
 *   it reads only what changed. With no checkpoint it starts two days
 *   back. An unchanged record read again is a duplicate.
 *
 * Each page is one batch and one checkpoint, which keeps both cursors, so
 * a resumed sync goes on from that page.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const ZENDESK_WRITES: WriteAction[] = [
  { integration: "zendesk", name: "add_internal_note", description: "Add an internal note to a Zendesk ticket", kind: "append", approval: "each", dailyCap: 20 },
  { integration: "zendesk", name: "add_tag", description: "Tag a Zendesk ticket", kind: "update", approval: "each", dailyCap: 20 },
];

/** With no checkpoint, the first later sync looks this far back. */
export const ZENDESK_FIRST_LOOKBACK_S = 48 * 3600;
const EXPORTS: readonly ZendeskExport[] = ["tickets", "users"];

/** Serialized as the runSync checkpoint: where each export goes on from, or null to start it afresh. */
export interface ZendeskCursor {
  /** The historical import finished. */
  done: boolean;
  tickets: string | null;
  users: string | null;
}

export interface ZendeskOptions extends Partial<Pick<ZendeskClientOptions, "fetch" | "sleep" | "retries">>, Pick<ZendeskClientOptions, "subdomain" | "clientId" | "clientSecret" | "tokens"> {
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** How many years back the historical import starts. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: ZendeskClient;
}

const position = (v: unknown) => v === null || (typeof v === "string" && ZENDESK_CURSOR.test(v));

export function parseZendeskCursor(raw: string | null): ZendeskCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    // Not JSON: fails the check below.
  }
  const r = (c ?? {}) as Record<string, unknown>;
  if (typeof r.done === "boolean" && position(r.tickets) && position(r.users)) return { done: r.done, tickets: r.tickets as string | null, users: r.users as string | null };
  throw new Error("Zendesk checkpoint is not in the expected shape");
}

export function zendeskConnector(options: ZendeskOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const client = options.client ?? zendeskClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads each export to its end, from where `state` says, or from `start` for one with no cursor yet. */
  async function* read(state: ZendeskCursor, start: number, doneAtEnd: boolean): AsyncIterable<SourceBatch> {
    const at = { ...state };
    for (const kind of EXPORTS) {
      for (;;) {
        const from = at[kind];
        const page = await client.page(kind, from === null ? { start } : { cursor: from });
        const ctx = { customerKey, receivedAt: now().toISOString() };
        const events = page.rows.flatMap((row) => {
          const r = kind === "tickets" ? zendeskTicketEvent(row, ctx) : zendeskUserEvent(row, ctx);
          return r ? [r.event] : [];
        });
        // A last page with no cursor leaves the export where it was.
        at[kind] = page.cursor ?? from;
        const last = page.end && kind === EXPORTS[EXPORTS.length - 1];
        yield { events, cursor: JSON.stringify({ ...at, done: last ? doneAtEnd : at.done }) };
        if (page.end) break;
      }
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseZendeskCursor(context.cursor);
    if (saved?.done) return;
    const floor = now();
    floor.setUTCFullYear(floor.getUTCFullYear() - historyYears);
    yield* read(saved ?? { done: false, tickets: null, users: null }, Math.floor(floor.getTime() / 1000), true);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseZendeskCursor(context.cursor);
    const state = saved ?? { done: false, tickets: null, users: null };
    yield* read(state, Math.floor(now().getTime() / 1000) - ZENDESK_FIRST_LOOKBACK_S, state.done);
  }

  return { source: "zendesk", historicalImport, incrementalSync, writes: ZENDESK_WRITES };
}
