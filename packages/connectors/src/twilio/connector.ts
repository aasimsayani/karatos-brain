import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { twilioClient, type TwilioCall, type TwilioClient, type TwilioClientOptions, type TwilioList, type TwilioMessage } from "./client.js";
import { twilioNormalizer, type TwilioEvent } from "./normalize.js";

/**
 * Reads a Twilio account's text messages and calls: who the store talked to
 * (as a keyed reference), when, which way, on which line, and how each one
 * ended. Message bodies are never kept. Each sync reads messages, then
 * calls, newest first from a start day, page by page, and checkpoints after
 * every page. The next sync starts two days before the newest record the
 * last one saw, so a delivery receipt or a call that ended late is picked
 * up; records it reads again come back as duplicates.
 *
 * There are no webhooks. Twilio sends a number's texts and calls to the one
 * URL the store set on the number, which runs its own replies, so pointing
 * that URL at KaratOS would change how the store's line works.
 */

/**
 * Declared so the write gate can turn them down; none is turned on, and the
 * API key it reads with should have no permission to do either.
 */
export const TWILIO_WRITES: WriteAction[] = [
  { integration: "twilio", name: "send_message", description: "Send a text or WhatsApp message from one of the store's numbers" },
  { integration: "twilio", name: "place_call", description: "Place an outbound call from one of the store's numbers" },
];

export const TWILIO_STREAMS: readonly TwilioList[] = ["messages", "calls"];
/** Days the next sync reaches back before the newest record already seen, for late status changes. */
export const TWILIO_OVERLAP_DAYS = 2;

export interface TwilioStreamState {
  /** First day (YYYY-MM-DD, GMT) this run reads. */
  since: string;
  /** The next page of this run, or null before the first page and after the last. */
  next: string | null;
  /** Day of the newest record this run saw, which sets the next run's start. */
  newest: string | null;
  done: boolean;
}

export interface TwilioCursor {
  messages: TwilioStreamState;
  calls: TwilioStreamState;
}

export interface TwilioOptions extends Omit<TwilioClientOptions, "fetch"> {
  /** The instance's TWILIO_CONTACT_KEY, for contact references. */
  contactKey: string;
  fetch?: typeof globalThis.fetch;
  /** Years the historical import reaches back. Twilio keeps what its retention allows. */
  historyYears?: number;
  now?: () => Date;
  client?: TwilioClient;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => day(new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000));

const validState = (s: TwilioStreamState | undefined): boolean =>
  !!s &&
  typeof s.since === "string" &&
  DATE.test(s.since) &&
  (s.next === null || typeof s.next === "string") &&
  (s.newest === null || (typeof s.newest === "string" && DATE.test(s.newest))) &&
  typeof s.done === "boolean";

export function parseTwilioCursor(raw: string | null): TwilioCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as TwilioCursor;
  if (!c || !validState(c.messages) || !validState(c.calls)) throw new Error("Twilio checkpoint is not in the expected shape");
  return c;
}

export function twilioConnector(options: TwilioOptions): Connector {
  const normalizer = twilioNormalizer(options.contactKey);
  const client = options.client ?? twilioClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1 || historyYears > 10) throw new Error("historyYears must be a whole number from 1 to 10");

  /** A fresh run of one stream: two days before the newest record the last run saw, or from the first day. */
  const fresh = (last: TwilioStreamState | undefined, firstSince: string): TwilioStreamState => ({
    since: last?.newest ? addDays(last.newest, -TWILIO_OVERLAP_DAYS) : (last?.since ?? firstSince),
    next: null,
    newest: null,
    done: false,
  });

  async function* run(context: SyncContext, firstSince: string): AsyncIterable<SourceBatch> {
    const saved = parseTwilioCursor(context.cursor);
    // A run left mid-way resumes where it stopped; a finished one (or none) starts a new run.
    const cursor: TwilioCursor =
      saved && !(saved.messages.done && saved.calls.done)
        ? { messages: { ...saved.messages }, calls: { ...saved.calls } }
        : { messages: fresh(saved?.messages, firstSince), calls: fresh(saved?.calls, firstSince) };
    for (const list of TWILIO_STREAMS) {
      const state = cursor[list];
      while (!state.done) {
        const page = state.next ? await client.page(list, state.next) : await client.first(list, state.since);
        const receivedAt = now().toISOString();
        const events: TwilioEvent[] =
          list === "messages"
            ? (page.records as TwilioMessage[]).flatMap((m) => normalizer.message(m, receivedAt))
            : (page.records as TwilioCall[]).flatMap((c) => normalizer.call(c, receivedAt));
        for (const e of events) {
          const d = e.occurredAt?.slice(0, 10);
          if (d && (state.newest === null || d > state.newest)) state.newest = d;
        }
        state.next = page.next;
        state.done = page.next === null;
        yield { events, cursor: JSON.stringify(cursor) };
      }
    }
  }

  const historySince = () => {
    const d = now();
    return day(new Date(Date.UTC(d.getUTCFullYear() - historyYears, d.getUTCMonth(), d.getUTCDate())));
  };

  return {
    source: "twilio",
    historicalImport: (context) => run(context, historySince()),
    incrementalSync: (context) => run(context, addDays(day(now()), -TWILIO_OVERLAP_DAYS)),
    writes: TWILIO_WRITES,
  };
}

