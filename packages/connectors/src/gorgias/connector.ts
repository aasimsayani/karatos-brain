import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { GORGIAS_CURSOR, gorgiasClient, type GorgiasClient, type GorgiasClientOptions } from "./client.js";
import { gorgiasMessageEvent, gorgiasTicketEvent, gorgiasTime } from "./normalize.js";

/**
 * Gorgias: the store's helpdesk tickets from email, chat and social, and
 * every message on them, so clienteling, sales and repairs see what online
 * customers asked and how fast the store answered.
 *
 * Gorgias lists tickets by when they last changed, newest first, with a
 * page cursor and no time filter. So a pass reads tickets newest first and
 * stops at the first one that last changed before its floor, reading each
 * ticket's messages as it goes:
 *
 * - The historical import's floor is five years back.
 * - Each later sync's floor is the newest change the last pass saw, less
 *   five minutes. A new message or a status change moves its ticket to the
 *   front, so the sync reads only what changed. An unchanged ticket or
 *   message is a duplicate.
 *
 * Each page of tickets is one batch and one checkpoint, which keeps the
 * floor, the newest change seen and Gorgias's cursor, so a resumed pass
 * goes on from that page.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const GORGIAS_WRITES: WriteAction[] = [
  { integration: "gorgias", name: "add_internal_note", description: "Add an internal note to a Gorgias ticket", kind: "append", approval: "each", dailyCap: 20 },
  { integration: "gorgias", name: "add_tag", description: "Tag a Gorgias ticket", kind: "update", approval: "each", dailyCap: 20 },
];

const MINUTE_MS = 60_000;
/** Each later pass reads back this far past the newest change it last saw. */
export const GORGIAS_OVERLAP_MS = 5 * MINUTE_MS;
/** With no checkpoint, the first later sync looks this far back. */
export const GORGIAS_FIRST_LOOKBACK_MS = 48 * 60 * MINUTE_MS;
/** Pages of one ticket's messages read before giving up: 5,000 messages. */
const MAX_MESSAGE_PAGES = 50;

/** Where a pass stands: what it stops at, the newest change it has seen, and the cursor of the next page. */
export interface GorgiasPass {
  floor: string;
  top: string | null;
  cursor: string | null;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `mark` is the newest change the last pass saw. */
export interface GorgiasCursor {
  pass: GorgiasPass | null;
  /** The historical import finished. */
  done: boolean;
  mark: string | null;
}

export interface GorgiasOptions extends Partial<Pick<GorgiasClientOptions, "fetch" | "sleep" | "retries">> {
  domain: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** Tickets that last changed more than this many years ago are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: GorgiasClient;
}

const isTime = (v: unknown): v is string => typeof v === "string" && gorgiasTime(v) === v;

export function parseGorgiasCursor(raw: string | null): GorgiasCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    // Not JSON: fails the checks below.
  }
  const r = (c ?? {}) as Record<string, unknown>;
  if (typeof r.done === "boolean" && (r.mark === null || isTime(r.mark))) {
    if (r.pass === null) return { pass: null, done: r.done, mark: r.mark };
    // Anything but an object fails the checks below: a string or number has no such fields.
    const p = r.pass as Record<string, unknown> | undefined;
    if (isTime(p?.floor) && (p.top === null || isTime(p.top)) && (p.cursor === null || (typeof p.cursor === "string" && GORGIAS_CURSOR.test(p.cursor)))) {
      return { pass: { floor: p.floor, top: p.top, cursor: p.cursor }, done: r.done, mark: r.mark };
    }
  }
  throw new Error("Gorgias checkpoint is not in the expected shape");
}

export function gorgiasConnector(options: GorgiasOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const client = options.client ?? gorgiasClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  async function messagesOf(ticketId: number): Promise<unknown[]> {
    const rows: unknown[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < MAX_MESSAGE_PAGES; n++) {
      const page = await client.messages(ticketId, cursor);
      rows.push(...page.rows);
      if (!page.next) return rows;
      cursor = page.next;
    }
    throw new Error(`Gorgias listed more than ${MAX_MESSAGE_PAGES} pages of messages on one ticket`);
  }

  /** Reads a pass to its end. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(start: GorgiasPass, done: boolean, doneAtEnd: boolean, mark: string | null): AsyncIterable<SourceBatch> {
    const pass = { ...start };
    for (;;) {
      const receivedAt = now().toISOString();
      const ctx = { customerKey, receivedAt };
      const page = await client.tickets(pass.cursor);
      const events = [];
      let reached = false;
      for (const row of page.rows) {
        const read = gorgiasTicketEvent(row, ctx);
        // An unreadable ticket has no time, and undefined is never before the floor.
        if (read.event.occurredAt! < pass.floor) {
          reached = true;
          break;
        }
        events.push(read.event);
        if (!read.ok) continue;
        const changed = read.event.occurredAt!;
        if (pass.top === null || changed > pass.top) pass.top = changed;
        for (const message of await messagesOf((row as { id: number }).id)) events.push(gorgiasMessageEvent(message, ctx).event);
      }
      const last = reached || page.next === null;
      pass.cursor = page.next;
      const cursor: GorgiasCursor = last ? { pass: null, done: doneAtEnd, mark: pass.top ?? mark } : { pass: { ...pass }, done, mark };
      yield { events, cursor: JSON.stringify(cursor) };
      if (last) return;
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseGorgiasCursor(context.cursor);
    if (saved?.done) return;
    if (saved?.pass) return yield* walk(saved.pass, false, true, saved.mark);
    const floor = now();
    floor.setUTCFullYear(floor.getUTCFullYear() - historyYears);
    yield* walk({ floor: floor.toISOString(), top: null, cursor: null }, false, true, null);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseGorgiasCursor(context.cursor);
    const done = saved?.done ?? false;
    if (saved?.pass) return yield* walk(saved.pass, done, done, saved.mark);
    const from = saved?.mark ? Date.parse(saved.mark) - GORGIAS_OVERLAP_MS : now().getTime() - GORGIAS_FIRST_LOOKBACK_MS;
    yield* walk({ floor: new Date(from).toISOString(), top: null, cursor: null }, done, done, saved?.mark ?? null);
  }

  return { source: "gorgias", historicalImport, incrementalSync, writes: GORGIAS_WRITES };
}
