import type { Feedback, Recommendation, StoredEvent } from "@karatos/core";
import { dollars } from "./department.js";
import {
  addDays,
  BRIEF_OPEN_LOOKBACK_DAYS,
  BRIEF_SALE_TYPES,
  cite,
  dayBounds,
  isDay,
  isTimeZone,
  localDay,
  openFindings,
  salesDay,
  syncSection,
  type BriefFinding,
  type BriefSyncInput,
  type Citation,
  type SalesDay,
  type SalesFigures,
  type SyncSection,
} from "./brief.js";

/**
 * Asking an instance a question in plain words, such as "what sold this
 * week?" or "which payouts are late?", and getting an answer worked out only
 * from what the instance has synced.
 *
 * The question is matched to one of a few things the instance knows how to
 * answer (ASK_QUESTIONS) by its words, with no model involved, and any period
 * it names ("yesterday", "last 7 days", "2026-11-01 to 2026-11-15") is read on
 * the store's calendar. Every number in the answer names the events, and the
 * systems that sent them, it was counted from. A question it can't match gets
 * "I can't answer that yet" and the list of what it can answer; one about
 * data the instance doesn't have gets "nothing has synced for that yet",
 * never zeros.
 *
 * This module is pure: `routeQuestion` says what a question needs, the
 * server reads it, and `answerQuestion` turns it into the answer.
 */

export type AskIntent = "sales" | "payouts" | "stock" | "awaiting_reply" | "open_recommendations" | "sync_health";

/** The longest question taken, in characters. */
export const ASK_MAX_QUESTION_CHARS = 500;

/** The longest period one sales answer covers, in store days. */
export const ASK_MAX_PERIOD_DAYS = 366;

/** Most sale events read for one answer. Past it the figures are marked partial, never guessed. */
export const ASK_MAX_EVENTS = 20_000;

/** How many findings an answer lists; the rest are counted. */
export const ASK_FINDINGS_SHOWN = 10;

/** What the instance can answer, with a question that asks it. Listed when a question isn't understood. */
export const ASK_QUESTIONS: readonly { intent: AskIntent; example: string; answers: string }[] = [
  { intent: "sales", example: "What sold this week?", answers: "sales, refunds and net for a period, by channel and by system" },
  { intent: "payouts", example: "Which payouts are late?", answers: "payouts that are late, short, missing, failed or still pending" },
  { intent: "stock", example: "What's low on stock?", answers: "items to reorder and items whose stock counts disagree between systems" },
  { intent: "awaiting_reply", example: "Who is waiting on a reply?", answers: "customers who wrote or called and haven't heard back" },
  { intent: "open_recommendations", example: "What's waiting on me?", answers: "open recommendations, highest dollar impact first" },
  { intent: "sync_health", example: "Is everything syncing?", answers: "connectors that failed, went stale, haven't run or aren't syncing" },
];

/**
 * The event types each answer is read from. The server reads the latest one
 * of these, so an answer of "none open" can say what it is based on, and an
 * instance that has none of them is told nothing has synced for it.
 */
export const ASK_EVENT_TYPES: Readonly<Record<AskIntent, readonly string[]>> = {
  sales: BRIEF_SALE_TYPES,
  payouts: ["payout.updated", "balance.transaction_recorded", "payment.charge_updated", "payment.refund_updated"],
  stock: ["inventory.counted", "inventory.received", "inventory.adjusted", "product.updated"],
  awaiting_reply: ["communication.message_logged", "communication.call_logged"],
  open_recommendations: [],
  sync_health: [],
};

/**
 * The recommendations each finding answer lists, by the prefix of their ids
 * (`rec_<department>_<key>_<day>`) and what kind of finding each is.
 */
export const ASK_FINDING_KINDS: Readonly<Partial<Record<AskIntent, readonly { idPrefix: string; kind: string }[]>>> = {
  payouts: [
    { idPrefix: "rec_finance_payout_late_", kind: "late" },
    { idPrefix: "rec_finance_payout_missing_", kind: "missing" },
    { idPrefix: "rec_finance_payout_short_", kind: "short" },
    { idPrefix: "rec_finance_payout_pending_", kind: "pending" },
    { idPrefix: "rec_finance_payout_failed_", kind: "failed" },
    { idPrefix: "rec_finance_payout_unrecorded_", kind: "unrecorded" },
  ],
  stock: [
    { idPrefix: "rec_inventory_reorder_", kind: "low" },
    { idPrefix: "rec_inventory_stock_", kind: "disagree" },
  ],
  awaiting_reply: [
    { idPrefix: "rec_clienteling_awaiting_reply_", kind: "awaiting_reply" },
    { idPrefix: "rec_clienteling_missed_calls_", kind: "missed_calls" },
  ],
};

// ---------------------------------------------------------------------------
// Understanding the question

/** A period on the store's calendar: whole store days from `fromDay` through `toDay`, as the instants [from, to). */
export interface AskPeriod {
  /** How the answer names it, such as "this week (2026-11-16 to 2026-11-20)". */
  label: string;
  fromDay: string;
  toDay: string;
  from: string;
  to: string;
  days: number;
  /** True when the question named no period and the default (today so far) was used. */
  defaulted: boolean;
}

export type AskRoute =
  | { kind: "intent"; intent: AskIntent; period?: AskPeriod }
  | { kind: "unsupported" }
  | { kind: "unclear_period"; problem: string };

export interface AskClock {
  now: Date;
  timeZone: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH = `(${MONTHS.map((m) => `${m.slice(0, 3)}(?:${m.slice(3)})?`).join("|")}|sept)\\.?`;
const monthIndex = (name: string) => (name.startsWith("sept") ? 8 : MONTHS.findIndex((m) => m.startsWith(name.slice(0, 3))));
const pad = (n: number) => String(n).padStart(2, "0");
const ISO = "(\\d{4}-\\d{2}-\\d{2})";

/** Words that pick each answer, tried in this order, so "sales and payouts" is about payouts. */
const INTENT_WORDS: readonly [AskIntent, RegExp][] = [
  ["sync_health", /\b(sync|syncs|syncing|synced|connectors?|integrations?)\b/],
  ["payouts", /\b(pay ?outs?|settlements?|deposits?|paid out)\b/],
  [
    "awaiting_reply",
    /\b(repl(y|ies|ied)|respon(d|se|ses|ded)|unanswered|call(ed)? ?back|text(ed)? back|get back to|got back to|missed calls?|heard back)\b|\bwaiting (on|for) (a |an |our |my )?(answer|reply|response|call)/,
  ],
  ["stock", /\b(stock|stocks|inventory|on hand|reorder|re-order|restock|running (low|out)|sold out|out of)\b/],
  ["open_recommendations", /\b(recommendations?|recs|to-?dos?|tasks?|findings?|action items?|open items?|needs? (my |our )?attention|should (i|we) do|waiting on (me|us))\b/],
  ["sales", /\b(sold|sell|sells|selling|sales?|revenue|takings|gross|net|refunds?|refunded|returns?|returned|orders?|made|make|earn(ed|ings)?|turnover|bring in|brought in)\b/],
];

function intentOf(text: string): AskIntent | null {
  return INTENT_WORDS.find(([, words]) => words.test(text))?.[0] ?? null;
}

/** Monday on or before a day. Weeks start on Monday. */
function mondayOf(day: string): string {
  const weekday = new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

const lastDayOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);

type Span = { fromDay: string; toDay: string; label: string } | { problem: string };

/** A day written as a month name and day ("november 18", "18 nov", "nov 18, 2026"), or null. */
function namedDay(text: string, today: string): string | null | { problem: string } {
  const m = new RegExp(`\\b${MONTH} (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?\\b`).exec(text) ?? new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH}(?:,? (\\d{4}))?\\b`).exec(text);
  if (!m) return null;
  const monthFirst = Number.isNaN(Number(m[1]));
  const month = monthIndex(monthFirst ? m[1]! : m[2]!);
  const date = Number(monthFirst ? m[2] : m[1]);
  const year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
  let day = `${year}-${pad(month + 1)}-${pad(date)}`;
  if (!isDay(day)) return { problem: `${m[0]} isn't a day on the calendar` };
  // With no year, a day still to come this year means last year's.
  if (!m[3] && day > today) day = `${year - 1}${day.slice(4)}`;
  return day;
}

function span(text: string, today: string): Span | null {
  const range = new RegExp(`\\b(?:from |between )?${ISO} (?:to|until|till|through|thru|and|-) ${ISO}\\b`).exec(text);
  if (range) return { fromDay: range[1]!, toDay: range[2]!, label: `${range[1]} to ${range[2]}` };
  const since = new RegExp(`\\bsince ${ISO}\\b`).exec(text);
  if (since) return { fromDay: since[1]!, toDay: today, label: `since ${since[1]}` };
  const one = new RegExp(`\\b${ISO}\\b`).exec(text);
  if (one) return { fromDay: one[1]!, toDay: one[1]!, label: one[1]! };
  if (/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(text)) return { problem: "write dates as 2026-11-18 or November 18, since 11/12 could be either month first or day first" };

  const named = namedDay(text, today);
  if (named !== null) return typeof named === "string" ? { fromDay: named, toDay: named, label: named } : named;

  if (/\btoday\b|\bso far today\b/.test(text)) return { fromDay: today, toDay: today, label: "today" };
  if (/\byesterday\b/.test(text)) {
    const d = addDays(today, -1);
    return { fromDay: d, toDay: d, label: "yesterday" };
  }
  const lastN = /\b(?:last|past|previous) (\d{1,4}) days?\b/.exec(text);
  if (lastN) {
    const n = Number(lastN[1]);
    if (n < 1) return { problem: "a period needs at least one day" };
    return { fromDay: addDays(today, -(n - 1)), toDay: today, label: `the last ${n} ${n === 1 ? "day" : "days"}` };
  }
  if (/\b(this week|week so far|week to date)\b/.test(text)) return { fromDay: mondayOf(today), toDay: today, label: "this week" };
  if (/\b(last|previous) week\b/.test(text)) {
    const monday = addDays(mondayOf(today), -7);
    return { fromDay: monday, toDay: addDays(monday, 6), label: "last week" };
  }
  if (/\bpast week\b/.test(text)) return { fromDay: addDays(today, -6), toDay: today, label: "the last 7 days" };
  const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1];
  if (/\b(this month|month so far|month to date)\b/.test(text)) return { fromDay: `${today.slice(0, 7)}-01`, toDay: today, label: "this month" };
  if (/\b(last|previous|past) month\b/.test(text)) {
    const [y, m] = month === 0 ? [year - 1, 11] : [year, month - 1];
    return { fromDay: `${y}-${pad(m + 1)}-01`, toDay: lastDayOfMonth(y, m), label: "last month" };
  }
  if (/\b(this year|year so far|year to date|ytd)\b/.test(text)) return { fromDay: `${year}-01-01`, toDay: today, label: "this year" };
  const inMonth = new RegExp(`\\b(?:in|during|for|of) ${MONTH}(?: (\\d{4}))?\\b`).exec(text);
  if (inMonth) {
    const m = monthIndex(inMonth[1]!);
    let y = inMonth[2] ? Number(inMonth[2]) : year;
    // With no year, a month still to come this year means last year's.
    if (!inMonth[2] && m > month) y -= 1;
    const name = MONTHS[m]!;
    return { fromDay: `${y}-${pad(m + 1)}-01`, toDay: lastDayOfMonth(y, m), label: `${name[0]!.toUpperCase()}${name.slice(1)} ${y}` };
  }
  return null;
}

/** Whole store days between two days, both counted. */
const daysIn = (fromDay: string, toDay: string) => Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000) + 1;

/** A period in the store's time zone, or why the one asked for can't be read. */
export function periodOf(text: string, clock: AskClock): AskPeriod | { problem: string } | null {
  const today = localDay(clock.now.getTime(), clock.timeZone);
  const s = span(text, today);
  if (s === null) return null;
  if ("problem" in s) return s;
  for (const d of [s.fromDay, s.toDay]) if (!isDay(d)) return { problem: `${d} isn't a day on the calendar` };
  if (s.fromDay > today) return { problem: `${s.fromDay} hasn't come yet in the store's time zone (today is ${today})` };
  if (s.fromDay > s.toDay) return { problem: `${s.fromDay} is after ${s.toDay}; put the earlier day first` };
  // A period running past today is read up to today.
  const toDay = s.toDay > today ? today : s.toDay;
  const days = daysIn(s.fromDay, toDay);
  if (days > ASK_MAX_PERIOD_DAYS) return { problem: `a period can be at most ${ASK_MAX_PERIOD_DAYS} days` };
  const shown = s.fromDay === toDay ? s.fromDay : `${s.fromDay} to ${toDay}`;
  return {
    label: s.label === shown ? shown : `${s.label} (${shown})`,
    fromDay: s.fromDay,
    toDay,
    from: dayBounds(s.fromDay, clock.timeZone).from,
    to: dayBounds(toDay, clock.timeZone).to,
    days,
    defaulted: false,
  };
}

/** Lowercased, with curly quotes straightened and punctuation other than dates' turned into spaces. */
export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\-/,. ]+/g, " ")
    .replace(/[.,](?!\d)|(?<!\d)[.,]|'s\b|'/g, (m) => (m === "'s" ? " is" : " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Works out what a question asks for. Pure; matches words only. */
export function routeQuestion(question: string, clock: AskClock): AskRoute {
  if (!isTimeZone(clock.timeZone)) throw new RangeError("timeZone must be an IANA time zone, such as America/New_York");
  const text = normalizeQuestion(question.slice(0, ASK_MAX_QUESTION_CHARS));
  const intent = intentOf(text);
  if (!intent) return { kind: "unsupported" };
  const period = periodOf(text, clock);
  if (period && "problem" in period) return { kind: "unclear_period", problem: period.problem };
  if (period) return { kind: "intent", intent, period };
  if (intent !== "sales") return { kind: "intent", intent };
  // Sales with no period named: today so far.
  const today = localDay(clock.now.getTime(), clock.timeZone);
  const bounds = dayBounds(today, clock.timeZone);
  return { kind: "intent", intent, period: { label: `today (${today})`, fromDay: today, toDay: today, ...bounds, days: 1, defaulted: true } };
}

// ---------------------------------------------------------------------------
// Answering it

export interface AskData {
  organizationId: string;
  timeZone: string;
  /** When the answer is worked out, ISO 8601. */
  generatedAt: string;
  /** For sales: the sale events in the period, oldest first. */
  sales?: { events: readonly StoredEvent[]; truncated: boolean };
  /** The latest sale before the period starts, so a quiet period can be told from one before anything synced. */
  lastSaleBefore?: StoredEvent | null;
  /** The latest event of the intent's ASK_EVENT_TYPES up to now, or null when none has synced. */
  latestSynced?: StoredEvent | null;
  /** Recommendations raised in the last BRIEF_OPEN_LOOKBACK_DAYS, any order. */
  recommendations?: readonly Recommendation[];
  /** Every piece of feedback recorded on those recommendations. */
  feedback?: readonly Feedback[];
  /** The system (event source) of each event the findings cite, as far as the server could look them up. */
  eventSources?: Readonly<Record<string, string>>;
  /** Sync results, for sync_health; absent when the caller doesn't know them. */
  sync?: BriefSyncInput;
}

/** One number in an answer, with the events and systems it was counted from. */
export interface AskFact {
  label: string;
  value: number;
  unit: "count" | "cents";
  citation: Citation;
}

export interface AskFinding extends BriefFinding {
  /** What kind of finding it is within the answer, such as late or short for payouts. */
  kind?: string;
  /** The systems that sent the events it cites. */
  systems: string[];
}

export type AskStatus = "answered" | "no_data" | "unsupported" | "unclear_period";

export interface AskAnswer {
  question: string;
  intent: AskIntent | null;
  status: AskStatus;
  timeZone: string;
  generatedAt: string;
  period?: AskPeriod;
  /** The answer in words. Each number is followed by its citation in brackets. */
  text: string;
  /** Every number the answer states, each cited. */
  facts: AskFact[];
  findings: AskFinding[];
  /** Findings beyond those listed. */
  moreFindings: number;
  sales?: SalesDay;
  sync?: SyncSection;
  notes: string[];
  /** When the question wasn't understood: what can be asked. */
  canAnswer?: typeof ASK_QUESTIONS;
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const sortedUnique = (values: Iterable<string>) => [...new Set(values)].sort();

function union(...citations: Citation[]): Citation {
  return { eventIds: [...new Set(citations.flatMap((c) => c.eventIds))], systems: sortedUnique(citations.flatMap((c) => c.systems)) };
}

/** A citation that names both events and the systems they came from. */
const has = (c: Citation) => c.eventIds.length > 0 && c.systems.length > 0;

/** A citation in brackets; events whose system couldn't be looked up still have their ids shown. */
const citeAny = (c: Citation) => (c.systems.length ? cite(c) : cite({ eventIds: c.eventIds, systems: ["system unknown"] }));

function base(question: string, data: AskData, intent: AskIntent | null, status: AskStatus): Omit<AskAnswer, "text"> {
  return { question, intent, status, timeZone: data.timeZone, generatedAt: data.generatedAt, facts: [], findings: [], moreFindings: 0, notes: [] };
}

/** "event X from Y at T": the record an empty answer rests on. */
const record = (e: StoredEvent) => `event ${e.id} from ${e.source} at ${e.occurredAt}`;

function unsupported(question: string, data: AskData): AskAnswer {
  const list = ASK_QUESTIONS.map((q) => `- "${q.example}" (${q.answers})`);
  return {
    ...base(question, data, null, "unsupported"),
    canAnswer: ASK_QUESTIONS,
    text: ["I can't answer that yet. I can answer questions like these, about any period for sales (today, yesterday, this week, last week, the last 7 days, this month, last month, or dates such as 2026-11-01 to 2026-11-15):", ...list].join("\n"),
  };
}

// Sales ---------------------------------------------------------------------

function salesFacts(prefix: string, f: SalesFigures): AskFact[] {
  const facts: AskFact[] = [];
  const add = (label: string, value: number, unit: AskFact["unit"], citation: Citation) => {
    if (has(citation)) facts.push({ label: `${prefix}${label}`, value, unit, citation });
  };
  add("sales", f.sales, "count", f.saleEvents);
  add("gross", f.grossCents, "cents", f.saleEvents);
  add("refunds", f.refunds, "count", f.refundEvents);
  add("refunded", f.refundCents, "cents", f.refundEvents);
  add("net", f.netCents, "cents", union(f.saleEvents, f.refundEvents));
  return facts;
}

function figuresText(f: SalesFigures): string {
  const sales = f.sales ? `${plural(f.sales, "sale")}, ${dollars(f.grossCents)} gross ${cite(f.saleEvents)}` : "no sales";
  const refunds = f.refunds ? `${plural(f.refunds, "refund")} of ${dollars(f.refundCents)} ${cite(f.refundEvents)}` : "no refunds";
  const net = f.sales && f.refunds ? `; ${dollars(f.netCents)} net ${cite(union(f.saleEvents, f.refundEvents))}` : "";
  return `${sales}; ${refunds}${net}`;
}

function answerSales(question: string, period: AskPeriod, data: AskData): AskAnswer {
  const input = data.sales ?? { events: [], truncated: false };
  const day = { ...salesDay(period.fromDay, data.timeZone, input), from: period.from, to: period.to, date: period.fromDay };
  const seen = day.totals.sales + day.totals.refunds + day.uncounted.eventIds.length > 0;
  const before = data.lastSaleBefore ?? null;
  const latest = data.latestSynced ?? null;
  const answer = { ...base(question, data, "sales", "answered"), period };
  if (period.defaulted) answer.notes.push("No period was named, so this covers today so far.");
  if (!seen) {
    if (!before && !latest) {
      return { ...answer, status: "no_data", text: "Nothing has synced for that yet: no sales or refunds have come into this instance, so there are no sales figures to give. Connect a point of sale or online store to see them here." };
    }
    if (!before) {
      return { ...answer, status: "no_data", text: `Nothing has synced for ${period.label} yet: the sales this instance has all come after it (the latest is ${record(latest!)}).`, notes: [...answer.notes] };
    }
    return { ...answer, sales: day, text: `No sales or refunds dated ${period.label} have synced. Sales were syncing before it: the latest earlier sale is ${record(before)}.` };
  }
  const facts = salesFacts("", day.totals);
  const lines = [`${capital(period.label)}: ${figuresText(day.totals)}.`];
  for (const [label, rows] of [
    ["By channel", day.byChannel],
    ["By system", day.bySystem],
  ] as const) {
    if (!rows.length) continue;
    const kind = label === "By channel" ? "channel" : "system";
    lines.push(`${label}: ${rows.map((r) => `${r.key}: ${figuresText(r)}`).join(" | ")}.`);
    for (const r of rows) facts.push(...salesFacts(`${kind} ${r.key}: `, r));
  }
  if (day.uncounted.eventIds.length) {
    answer.notes.push(`${plural(day.uncounted.eventIds.length, "sale event")} in the period could not be counted (raw data cleared or unreadable), so the figures are a floor: ${cite(day.uncounted)}.`);
  }
  if (day.truncated) answer.notes.push(`The period had more than ${ASK_MAX_EVENTS} sale events; only the first ${ASK_MAX_EVENTS} were counted, so the figures are a floor.`);
  return { ...answer, sales: day, facts, text: [...lines, ...answer.notes].join("\n") };
}

const capital = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;

// Findings ------------------------------------------------------------------

const FINDING_WORDS: Readonly<Partial<Record<AskIntent, { what: string; none: string; nothingSynced: string }>>> = {
  payouts: {
    what: "payout",
    none: "No payouts are open as late, short, missing, failed or stuck pending.",
    nothingSynced: "Nothing has synced for that yet: no payouts, settlements or charges have come into this instance from a payment processor.",
  },
  stock: {
    what: "stock",
    none: "Nothing is open as low on stock, and no stock counts are open as disagreeing between systems.",
    nothingSynced: "Nothing has synced for that yet: no stock counts, receipts or listings have come into this instance.",
  },
  awaiting_reply: {
    what: "waiting-customer",
    none: "Nobody is open as waiting on a reply or a call back.",
    nothingSynced: "Nothing has synced for that yet: no messages or calls have come into this instance.",
  },
};

const KIND_HEADINGS: Readonly<Record<string, string>> = {
  late: "Paid out late",
  missing: "Never paid out",
  short: "Paid short",
  pending: "Still pending",
  failed: "Failed or canceled",
  unrecorded: "No record of the payout",
  low: "Low on stock",
  disagree: "Counts that disagree",
  awaiting_reply: "Waiting on a reply",
  missed_calls: "Missed calls not returned",
};

function withSystems(f: BriefFinding, sources: Readonly<Record<string, string>>, kind?: string): AskFinding {
  const systems = sortedUnique(f.eventIds.flatMap((id) => (sources[id] ? [sources[id]] : [])));
  return { ...f, ...(kind ? { kind } : {}), systems };
}

const findingCitation = (f: AskFinding): Citation => ({ eventIds: f.eventIds, systems: f.systems });

function findingLine(f: AskFinding): string {
  const worth = f.impact ? ` (${f.impact.kind} about ${dollars(f.impact.cents)})` : "";
  const from = f.eventIds.length ? ` ${citeAny(findingCitation(f))}` : "";
  return `- ${f.summary}${worth}${from} {${f.recommendationId}}`;
}

function findingFacts(list: AskFinding[], label: string): AskFact[] {
  const facts: AskFact[] = [];
  const all = union(...list.map(findingCitation));
  if (has(all)) facts.push({ label, value: list.length, unit: "count", citation: all });
  for (const f of list) {
    if (f.impact && has(findingCitation(f))) facts.push({ label: `${f.recommendationId}: ${f.impact.kind}`, value: f.impact.cents, unit: "cents", citation: findingCitation(f) });
  }
  return facts;
}

/** The open findings a finding answer lists, highest impact first, each with its kind. */
export function openFindingsFor(intent: AskIntent, recommendations: readonly Recommendation[], feedback: readonly Feedback[]): { finding: BriefFinding; kind?: string }[] {
  const open = openFindings(recommendations, feedback);
  const kinds = ASK_FINDING_KINDS[intent];
  if (!kinds) return open.map((finding) => ({ finding }));
  return open.flatMap((finding) => {
    const k = kinds.find((x) => finding.recommendationId.startsWith(x.idPrefix));
    return k ? [{ finding, kind: k.kind }] : [];
  });
}

function answerFindings(question: string, intent: AskIntent, data: AskData, period: AskPeriod | undefined): AskAnswer {
  const answer = base(question, data, intent, "answered");
  const recommendations = data.recommendations ?? [];
  const sources = data.eventSources ?? {};
  const kinds = ASK_FINDING_KINDS[intent];
  const words = FINDING_WORDS[intent];
  const found = openFindingsFor(intent, recommendations, data.feedback ?? []).map(({ finding, kind }) => withSystems(finding, sources, kind));
  if (period) answer.notes.push(`Findings are what is open now, as of the latest reasoning run; the period asked about (${period.label}) doesn't narrow them.`);

  if (!found.length) {
    if (!words) {
      if (!recommendations.length) return { ...answer, status: "no_data", text: `Nothing has been raised for that yet: no recommendations in the last ${BRIEF_OPEN_LOOKBACK_DAYS} days.` };
      return { ...answer, text: `Nothing is waiting on you: every recommendation raised in the last ${BRIEF_OPEN_LOOKBACK_DAYS} days has been answered.` };
    }
    const latest = data.latestSynced ?? null;
    if (!latest) return { ...answer, status: "no_data", text: words.nothingSynced };
    return { ...answer, text: `${words.none} This is as of the latest reasoning run over what has synced; the latest record it could use is ${record(latest)}.` };
  }

  const shown = found.slice(0, ASK_FINDINGS_SHOWN);
  const more = found.length - shown.length;
  const all = union(...found.map(findingCitation));
  const what = words ? `${words.what} ${found.length === 1 ? "finding" : "findings"}` : found.length === 1 ? "recommendation" : "recommendations";
  const lines = [`${found.length} ${what} ${found.length === 1 ? "is" : "are"} open${all.eventIds.length ? ` ${citeAny(all)}` : ""}${words ? "" : ", highest dollar impact first"}:`];
  if (kinds && new Set(shown.map((f) => f.kind)).size > 1) {
    for (const k of kinds) {
      const group = shown.filter((f) => f.kind === k.kind);
      if (group.length) lines.push(`${KIND_HEADINGS[k.kind] ?? k.kind}:`, ...group.map(findingLine));
    }
  } else lines.push(...shown.map(findingLine));
  if (more > 0) lines.push(`and ${more} more.`);
  const unknown = shown.filter((f) => f.eventIds.some((id) => !sources[id])).length;
  if (unknown) answer.notes.push(`For ${plural(unknown, "finding")} the system behind some of its events couldn't be looked up; the event ids are still listed.`);
  return { ...answer, findings: shown, moreFindings: more, facts: findingFacts(found, words ? `${words.what} findings open` : "open recommendations"), text: [...lines, ...answer.notes].join("\n") };
}

// Sync ----------------------------------------------------------------------

function answerSync(question: string, data: AskData, period: AskPeriod | undefined): AskAnswer {
  const answer = base(question, data, "sync_health", "answered");
  if (period) answer.notes.push(`Sync health is as it stands now; the period asked about (${period.label}) doesn't change it.`);
  const sync = syncSection(data.sync, data.generatedAt);
  if (!sync.known) return { ...answer, status: "no_data", sync, text: "Sync results aren't available to this instance's answers, so I can't say how syncing is going." };
  if (!sync.problems.length && !sync.healthy.length) return { ...answer, status: "no_data", sync, text: "Nothing has synced for that yet: no connectors are set up to sync on this instance." };
  const lines = sync.problems.length
    ? ["These connectors have a problem:", ...sync.problems.map((p) => `- ${p.system} ${p.detail}${p.at ? ` (${p.at})` : ""}.`)]
    : ["Every scheduled connector's last sync succeeded within the last day."];
  if (sync.problems.length && sync.healthy.length) lines.push(`Syncing normally: ${sync.healthy.join(", ")}.`);
  return { ...answer, sync, text: [...lines, ...answer.notes].join("\n") };
}

// ---------------------------------------------------------------------------

/** Answers a routed question from the data the server read for it. Pure: the same input always gives the same answer. */
export function answerQuestion(question: string, route: AskRoute, data: AskData): AskAnswer {
  if (!isTimeZone(data.timeZone)) throw new RangeError("timeZone must be an IANA time zone, such as America/New_York");
  if (route.kind === "unsupported") return unsupported(question, data);
  if (route.kind === "unclear_period") {
    return { ...base(question, data, null, "unclear_period"), text: `I couldn't read the period in that question: ${route.problem}. Try "today", "yesterday", "this week", "last week", "last 7 days", "this month", "last month", or dates such as 2026-11-01 to 2026-11-15.` };
  }
  const { intent, period } = route;
  if (intent === "sales") return answerSales(question, period!, data);
  if (intent === "sync_health") return answerSync(question, data, period);
  const answer = answerFindings(question, intent, data, period);
  return period ? { ...answer, period } : answer;
}
