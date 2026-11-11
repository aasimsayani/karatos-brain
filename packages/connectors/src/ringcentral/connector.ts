import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { quoTime } from "../openphone/normalize.js";
import { ringCentralClient, type RingCentralClient, type RingCentralClientOptions, type RingCentralKind } from "./client.js";
import { ringCentralCallEvent, ringCentralMessageEvent } from "./normalize.js";

/**
 * RingCentral: every call, text and voicemail on one RingCentral extension
 * (the store's line), so clienteling, repairs and sales see who called or
 * wrote and how fast the store answered.
 *
 * RingCentral lists an extension's calls and messages in a time span, page
 * by page. Its sync APIs (call-log-sync and message-sync) can't read more
 * than 250 call records at a time, so they can't import history. So a pass
 * reads the calls and then the texts and voicemail in a span:
 *
 * - The historical import covers two years by default.
 * - Each later sync covers from where the last pass started, less a day:
 *   a text is read or a voicemail deleted after it arrives, and a call
 *   ends after it starts, and those changes land within the day. An
 *   unchanged one is a duplicate.
 *
 * Each page is one batch and one checkpoint, which keeps the pass's span,
 * the step and the page, so a resumed pass goes on from that page. The
 * connector polls, so it needs no public route for webhooks.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const RINGCENTRAL_WRITES: WriteAction[] = [
  { integration: "ringcentral", name: "send_text", description: "Send a text from the store's RingCentral line" },
  { integration: "ringcentral", name: "ring_out", description: "Ring the store's line and a customer to connect a call" },
];

const HOUR_MS = 3_600_000;
/** Each later pass starts this much before the last one did, for calls and messages that changed since. */
export const RINGCENTRAL_OVERLAP_MS = 24 * HOUR_MS;
/** With no checkpoint, the first later sync looks this far back. */
export const RINGCENTRAL_FIRST_LOOKBACK_MS = 48 * HOUR_MS;
const STEPS: readonly RingCentralKind[] = ["calls", "messages"];

/** Where a pass stands: its span, the step (calls, then messages) and the next page. */
export interface RingCentralPass {
  from: string;
  until: string;
  step: number;
  page: number;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `nextFrom` is where the next later sync starts. */
export interface RingCentralCursor {
  pass: RingCentralPass | null;
  /** The historical import finished. */
  done: boolean;
  nextFrom: string;
}

export interface RingCentralOptions extends Partial<Pick<RingCentralClientOptions, "fetch" | "sleep" | "retries">> {
  clientId: string;
  clientSecret: string;
  jwt: string;
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** Calls and messages older than this many years are skipped. Defaults to 2. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: RingCentralClient;
}

/** A time as the client sends it: UTC with milliseconds. */
const isTime = (v: unknown): v is string => typeof v === "string" && quoTime(v) === v;

export function parseRingCentralCursor(raw: string | null): RingCentralCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    // Not JSON: fails the checks below.
  }
  const r = (c ?? {}) as Record<string, unknown>;
  if (typeof r.done === "boolean" && isTime(r.nextFrom)) {
    if (r.pass === null) return { pass: null, done: r.done, nextFrom: r.nextFrom };
    // Anything but an object fails the checks below: a string or number has no such fields.
    const p = r.pass as Record<string, unknown> | undefined;
    if (isTime(p?.from) && isTime(p.until) && (p.step === 0 || p.step === 1) && Number.isSafeInteger(p.page) && (p.page as number) >= 1) {
      return { pass: { from: p.from, until: p.until, step: p.step, page: p.page as number }, done: r.done, nextFrom: r.nextFrom };
    }
  }
  throw new Error("RingCentral checkpoint is not in the expected shape");
}

export function ringCentralConnector(options: RingCentralOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const client = options.client ?? ringCentralClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 2;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads a pass to its end. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(pass: RingCentralPass, done: boolean, doneAtEnd: boolean, nextFrom: string, receivedAt: string): AsyncIterable<SourceBatch> {
    let { step, page } = pass;
    while (step < STEPS.length) {
      const kind = STEPS[step]!;
      const got = await client.page(kind, { from: pass.from, until: pass.until, page });
      const ctx = { customerKey, receivedAt };
      const events = got.rows.map((row) => (kind === "calls" ? ringCentralCallEvent(row, ctx) : ringCentralMessageEvent(row, ctx)).event);
      if (got.next !== null) page = got.next;
      else [step, page] = [step + 1, 1];
      const cursor: RingCentralCursor = step < STEPS.length ? { pass: { ...pass, step, page }, done, nextFrom } : { pass: null, done: doneAtEnd, nextFrom };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseRingCentralCursor(context.cursor);
    if (saved?.done) return;
    if (saved?.pass) return yield* walk(saved.pass, false, true, saved.nextFrom, now().toISOString());
    const at = now();
    const from = new Date(at.getTime());
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    const until = at.toISOString();
    yield* walk({ from: from.toISOString(), until, step: 0, page: 1 }, false, true, new Date(at.getTime() - RINGCENTRAL_OVERLAP_MS).toISOString(), until);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseRingCentralCursor(context.cursor);
    const at = now();
    if (saved?.pass) return yield* walk(saved.pass, saved.done, saved.done, saved.nextFrom, at.toISOString());
    const from = saved?.nextFrom ?? new Date(at.getTime() - RINGCENTRAL_FIRST_LOOKBACK_MS).toISOString();
    const until = at.toISOString();
    yield* walk({ from, until, step: 0, page: 1 }, saved?.done ?? false, saved?.done ?? false, new Date(at.getTime() - RINGCENTRAL_OVERLAP_MS).toISOString(), until);
  }

  return { source: "ringcentral", historicalImport, incrementalSync, writes: RINGCENTRAL_WRITES };
}
