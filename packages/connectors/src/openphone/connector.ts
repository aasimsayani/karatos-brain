import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { quoClient, type QuoClient, type QuoClientOptions, type QuoKind } from "./client.js";
import { quoCallEvent, quoMessageEvent, quoTime } from "./normalize.js";

/**
 * Quo (formerly OpenPhone): every call and text on the store's Quo lines,
 * so clienteling, repairs and sales see who called or wrote and how fast
 * the store answered.
 *
 * Quo lists calls and messages newest first by when they were created, with
 * no change-time filter. So a pass reads the calls and then the messages
 * created in a span, page by page with Quo's cursor:
 *
 * - The historical import covers two years by default.
 * - Each later sync covers from where the last pass started, less a day:
 *   a call or text changes after it is created (it is answered, delivered,
 *   ends), and those changes land within the day. An unchanged one is a
 *   duplicate.
 *
 * Each page is one batch and one checkpoint, which keeps the pass's span,
 * the step and Quo's cursor, so a resumed pass goes on from that page. Quo
 * can send webhooks, but the connector polls so it needs no public route.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const QUO_WRITES: WriteAction[] = [
  { integration: "openphone", name: "send_text", description: "Send a text from a Quo line" },
  { integration: "openphone", name: "add_contact_note", description: "Add a note to a Quo contact" },
];

const HOUR_MS = 3_600_000;
/** Each later pass starts this much before the last one did, for calls and texts that changed since. */
export const QUO_OVERLAP_MS = 24 * HOUR_MS;
/** With no checkpoint, the first later sync looks this far back. */
export const QUO_FIRST_LOOKBACK_MS = 48 * HOUR_MS;
const STEPS: readonly QuoKind[] = ["calls", "messages"];

/** Where a Quo pass stands: its span, the step (calls, then messages) and the cursor of the next page. */
export interface QuoPass {
  from: string;
  until: string;
  step: number;
  after: string | null;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `nextFrom` is where the next later sync starts. */
export interface QuoCursor {
  pass: QuoPass | null;
  /** The historical import finished. */
  done: boolean;
  nextFrom: string;
}

export interface QuoOptions extends Partial<Pick<QuoClientOptions, "fetch" | "sleep" | "retries">> {
  apiKey: string;
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** Calls and texts older than this many years are skipped. Defaults to 2. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: QuoClient;
}

const isTime = (v: unknown): v is string => typeof v === "string" && quoTime(v) === v;

export function parseQuoCursor(raw: string | null): QuoCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    c = null;
  }
  const r = typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
  if (r && typeof r.done === "boolean" && isTime(r.nextFrom)) {
    if (r.pass === null) return { pass: null, done: r.done, nextFrom: r.nextFrom };
    // Anything but an object fails the checks below: a string or number has no such fields.
    const p = r.pass as Record<string, unknown> | undefined;
    if (isTime(p?.from) && isTime(p.until) && (p.step === 0 || p.step === 1) && (p.after === null || typeof p.after === "string")) {
      return { pass: { from: p.from, until: p.until, step: p.step, after: p.after }, done: r.done, nextFrom: r.nextFrom };
    }
  }
  throw new Error("Quo checkpoint is not in the expected shape");
}

export function quoConnector(options: QuoOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const client = options.client ?? quoClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 2;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads a pass to its end. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(pass: QuoPass, done: boolean, doneAtEnd: boolean, nextFrom: string, receivedAt: string): AsyncIterable<SourceBatch> {
    let { step, after } = pass;
    while (step < STEPS.length) {
      const kind = STEPS[step]!;
      const page = await client.page(kind, { from: pass.from, until: pass.until, after });
      const ctx = { customerKey, receivedAt };
      const events = page.rows.map((row) => (kind === "calls" ? quoCallEvent(row, ctx) : quoMessageEvent(row, ctx)).event);
      if (page.next !== null) after = page.next;
      else [step, after] = [step + 1, null];
      const cursor: QuoCursor = step < STEPS.length ? { pass: { ...pass, step, after }, done, nextFrom } : { pass: null, done: doneAtEnd, nextFrom };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseQuoCursor(context.cursor);
    if (saved?.done) return;
    if (saved?.pass) return yield* walk(saved.pass, false, true, saved.nextFrom, now().toISOString());
    const at = now();
    const from = new Date(at.getTime());
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    const until = at.toISOString();
    yield* walk({ from: from.toISOString(), until, step: 0, after: null }, false, true, new Date(at.getTime() - QUO_OVERLAP_MS).toISOString(), until);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseQuoCursor(context.cursor);
    const at = now();
    if (saved?.pass) return yield* walk(saved.pass, saved.done, saved.done, saved.nextFrom, at.toISOString());
    const from = saved?.nextFrom ?? new Date(at.getTime() - QUO_FIRST_LOOKBACK_MS).toISOString();
    const until = at.toISOString();
    yield* walk({ from, until, step: 0, after: null }, saved?.done ?? false, saved?.done ?? false, new Date(at.getTime() - QUO_OVERLAP_MS).toISOString(), until);
  }

  return { source: "openphone", historicalImport, incrementalSync, writes: QUO_WRITES };
}
