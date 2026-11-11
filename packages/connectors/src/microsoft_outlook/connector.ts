import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { createHash } from "node:crypto";
import { OUTLOOK_FOLDERS, OUTLOOK_STATE_TOKEN, OutlookResyncError, outlookClient, outlookMailbox, type OutlookClient, type OutlookClientOptions, type OutlookPage, type OutlookState } from "./client.js";
import { MicrosoftConfigError } from "../microsoft_onedrive/client.js";
import { outlookNormalizer, type OutlookEvent } from "./normalize.js";

/**
 * Microsoft 365 Outlook: one mailbox's Inbox, Sent Items and calendar, for
 * clienteling (who the store writes to and meets), buying (which vendors
 * write) and the appointment book.
 *
 * Each of the three is a Graph delta. The historical import reads each from
 * the start: messages received in the last five years, and calendar events
 * from five years back to a year ahead. Graph ends each listing with a
 * delta token, which becomes its change feed, so each later sync asks only
 * for what changed since, deletions included. Every page is one batch whose
 * checkpoint keeps Graph's token for each of the three, so a resumed sync
 * asks again from the page it was on. If Graph answers 410 Gone, that one
 * is listed again. When the calendar's window is within six months of its
 * end, the calendar is listed again with a window a year ahead.
 */

/** Declared so they can be gated and audited; they never run while writes are off, and the app can only read. */
export const OUTLOOK_WRITES: WriteAction[] = [
  { integration: "microsoft_outlook", name: "draft_reply", description: "Save a reply to a customer's message as a draft in the mailbox", kind: "draft", approval: "each", dailyCap: 20 },
  { integration: "microsoft_outlook", name: "book_appointment", description: "Put an appointment on the mailbox's calendar", kind: "append", approval: "each", dailyCap: 20 },
];

export const OUTLOOK_LANES = [...OUTLOOK_FOLDERS, "calendar"] as const;
export type OutlookLane = (typeof OUTLOOK_LANES)[number];
const DAY_MS = 86_400_000;
/** The calendar is read this far ahead. */
export const OUTLOOK_AHEAD_MS = 365 * DAY_MS;
/** Once its window ends sooner than this, the calendar is listed again. */
export const OUTLOOK_RENEW_MS = 182 * DAY_MS;
/** Resyncs one sync takes before it stops and leaves the rest to the next. */
const MAX_RESYNCS = 3;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface OutlookCursor {
  pass: "historical" | "incremental";
  /** A digest of the mailbox this was made for; a change in settings starts over. */
  mailbox: string;
  /** The lane being read: 0 the Inbox, 1 Sent Items, 2 the calendar. */
  lane: number;
  /** Graph's state for each lane, or null before its first page. */
  states: Record<OutlookLane, OutlookState | null>;
  /** True once every lane has had a delta link. */
  done: boolean;
  /** Messages received before this aren't read; the calendar window starts here. */
  since: string;
  /** Where the calendar window ends. */
  until: string;
}

export interface OutlookOptions extends Partial<Pick<OutlookClientOptions, "fetch" | "sleep" | "retries">> {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailbox: string;
  /** The instance's CORRESPONDENT_HASH_KEY. */
  correspondentKey: string;
  /** Years of history the import reads. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: OutlookClient;
}

const isTime = (t: unknown): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t)) && new Date(Date.parse(t)).toISOString() === t;
const isState = (s: unknown) => s === null || (typeof s === "object" && ["skip", "delta"].includes((s as OutlookState).kind) && typeof (s as OutlookState).token === "string" && OUTLOOK_STATE_TOKEN.test((s as OutlookState).token));
export const outlookMailboxLabel = (mailbox: string) => `mailbox:${createHash("sha256").update(mailbox).digest("hex").slice(0, 16)}`;

export function parseOutlookCursor(raw: string | null): OutlookCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    // Unreadable JSON leaves c undefined, which the checks below turn down.
  }
  const r = (c ?? {}) as Record<string, unknown>;
  const s = (r.states ?? {}) as Record<string, unknown>;
  const ok =
    (r.pass === "historical" || r.pass === "incremental") &&
    typeof r.mailbox === "string" &&
    /^mailbox:[0-9a-f]{16}$/.test(r.mailbox) &&
    Number.isInteger(r.lane) &&
    (r.lane as number) >= 0 &&
    (r.lane as number) < OUTLOOK_LANES.length &&
    OUTLOOK_LANES.every((l) => isState(s[l])) &&
    typeof r.done === "boolean" &&
    isTime(r.since) &&
    isTime(r.until) &&
    r.since < r.until;
  if (!ok) throw new Error("Outlook checkpoint is not in the expected shape");
  const states = Object.fromEntries(OUTLOOK_LANES.map((l) => [l, s[l] === null ? null : { kind: (s[l] as OutlookState).kind, token: (s[l] as OutlookState).token }])) as Record<OutlookLane, OutlookState | null>;
  return { pass: r.pass as OutlookCursor["pass"], mailbox: r.mailbox as string, lane: r.lane as number, states, done: r.done as boolean, since: r.since as string, until: r.until as string };
}

export function outlookConnector(options: OutlookOptions): Connector {
  const mailbox = outlookMailbox(options.mailbox);
  if (!mailbox) throw new MicrosoftConfigError("MICROSOFT_OUTLOOK_MAILBOX is missing or not a mailbox address or object id");
  const normalizer = outlookNormalizer(options.correspondentKey);
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");
  const client = options.client ?? outlookClient(options);
  const now = options.now ?? (() => new Date());
  const label = outlookMailboxLabel(mailbox);

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseOutlookCursor(context.cursor);
    const at = now();
    const ours = saved?.mailbox === label ? saved : null;
    if (mode === "historical" && ours?.pass === "historical" && ours.done) return;
    const start = new Date(at);
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    const until = new Date(at.getTime() + OUTLOOK_AHEAD_MS).toISOString();
    const fresh: OutlookCursor = { pass: mode, mailbox: label, lane: 0, states: { inbox: null, sentitems: null, calendar: null }, done: false, since: start.toISOString(), until };
    let c: OutlookCursor;
    if (mode === "historical") c = ours?.pass === "historical" ? ours : fresh;
    // An incremental sync goes on from any checkpoint for this mailbox: the rest of a listing, or its changes.
    else c = ours ? { ...ours, pass: "incremental" } : fresh;
    // A calendar window running out is listed again, a year ahead, once the calendar's lane comes round.
    if (c.lane === 0 && c.states.calendar?.kind === "delta" && Date.parse(c.until) - at.getTime() < OUTLOOK_RENEW_MS) c = { ...c, states: { ...c.states, calendar: null }, until };
    const receivedAt = at.toISOString();
    let resyncs = 0;
    while (true) {
      const lane = OUTLOOK_LANES[c.lane]!;
      let page: OutlookPage;
      try {
        page = lane === "calendar" ? await client.events(c.states.calendar, c.since, c.until) : await client.messages(lane, c.states[lane], c.since);
      } catch (error) {
        if (!(error instanceof OutlookResyncError) || ++resyncs > MAX_RESYNCS) throw error;
        c = { ...c, states: { ...c.states, [lane]: null } };
        continue;
      }
      const events: OutlookEvent[] = page.items.flatMap((item) => (lane === "calendar" ? [normalizer.appointment(item, receivedAt)] : normalizer.message(lane, item, receivedAt)));
      const ended = page.next.kind === "delta";
      const last = ended && c.lane === OUTLOOK_LANES.length - 1;
      c = { ...c, states: { ...c.states, [lane]: page.next }, lane: ended ? (c.lane + 1) % OUTLOOK_LANES.length : c.lane, done: last };
      yield { events, cursor: JSON.stringify(c) };
      if (last) return;
    }
  }

  return {
    source: "microsoft_outlook",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: OUTLOOK_WRITES,
  };
}
