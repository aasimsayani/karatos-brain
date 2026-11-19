import type { Feedback, Impact, Recommendation, StoredEvent } from "@karatos/core";
import { dollars } from "./department.js";

/**
 * The daily brief: a short morning summary of one store day, worked out only
 * from what the instance has synced. Every number names the events (and the
 * systems they came from) it was counted from, and an instance with nothing
 * synced says so instead of showing zeros as if they were facts.
 *
 * This module is pure: the server reads the events, recommendations,
 * feedback and sync results, and `buildDailyBrief` turns them into the brief.
 */

/** The event types the sales figures count. */
export const BRIEF_SALE_TYPES = ["sale.completed", "sale.returned"] as const;

/** The store's time zone when an instance doesn't set one. */
export const DEFAULT_BRIEF_TIME_ZONE = "America/New_York";

/** How many days back an open recommendation still counts as waiting. */
export const BRIEF_OPEN_LOOKBACK_DAYS = 14;

/** How many waiting recommendations the brief lists; the rest are counted. */
export const BRIEF_WAITING_SHOWN = 10;

/** A connector whose last finished run is older than this is called stale. */
export const BRIEF_STALE_SYNC_HOURS = 24;

/** Most sale events read for one day. Past it the day's figures are marked partial, never guessed. */
export const BRIEF_MAX_EVENTS_PER_DAY = 10_000;

/** Event ids written out in the plain-text brief for one figure; the JSON always carries all of them. */
const TEXT_IDS_SHOWN = 3;

/**
 * Department rules whose open findings the brief calls out as unusual. A
 * recommendation id is `rec_<department>_<key>_<day>`, so each rule is known
 * by the prefix of the ids it raises.
 */
export const BRIEF_UNUSUAL_RULES: readonly { rule: string; idPrefix: string }[] = [
  { rule: "finance.payout-match", idPrefix: "rec_finance_payout_" },
  { rule: "inventory.stock-agreement", idPrefix: "rec_inventory_stock_" },
  { rule: "clienteling.awaiting-reply", idPrefix: "rec_clienteling_awaiting_reply_" },
  { rule: "sales.high-return-rate", idPrefix: "rec_sales_returns_" },
];

// ---------------------------------------------------------------------------
// Days and time zones

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True when the name is an IANA time zone this runtime knows, such as America/New_York. */
export function isTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** True for a real calendar day written YYYY-MM-DD. */
export function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** The calendar day `days` after (or before, when negative) a YYYY-MM-DD day. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The wall clock in a time zone at an instant: "YYYY-MM-DDTHH:MM:SS". */
export function wallClock(instant: number, timeZone: string): string {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** The store's calendar day at an instant. */
export function localDay(instant: number, timeZone: string): string {
  return wallClock(instant, timeZone).slice(0, 10);
}

/** How far the zone's wall clock is ahead of UTC at an instant, in ms. */
function offsetAt(instant: number, timeZone: string): number {
  const wall = wallClock(instant, timeZone);
  return Date.parse(`${wall}Z`) - Math.floor(instant / 1000) * 1000;
}

/**
 * The first instant at which the store's wall clock reads `hour`:00 on `day`
 * or later. On a day the clocks go back it is the first of the two; on a day
 * they go forward past that hour it is the moment the clocks jump.
 */
export function zonedInstant(day: string, hour: number, timeZone: string): number {
  const target = `${day}T${String(hour).padStart(2, "0")}:00:00`;
  const naive = Date.parse(`${target}Z`);
  const candidates = [offsetAt(naive - 86_400_000, timeZone), offsetAt(naive + 86_400_000, timeZone)].map((offset) => naive - offset);
  const reached = candidates.filter((c) => wallClock(c, timeZone) >= target).sort((a, b) => a - b);
  return reached[0] ?? Math.max(...candidates);
}

/** A store day as the instants [from, to) it covers. 23 or 25 hours long on the days the clocks change. */
export function dayBounds(day: string, timeZone: string): { from: string; to: string } {
  return { from: new Date(zonedInstant(day, 0, timeZone)).toISOString(), to: new Date(zonedInstant(addDays(day, 1), 0, timeZone)).toISOString() };
}

// ---------------------------------------------------------------------------
// Input and output

/** One connector's last finished sync, as the server's sync runner reports it. */
export interface BriefSyncStatus {
  id: string;
  outcome: "succeeded" | "failed";
  finishedAt: string;
  error?: string;
}

export interface BriefSyncInput {
  /** Connector ids the instance syncs on a schedule. */
  scheduled: readonly string[];
  /** Each scheduled connector's last finished run since the instance started. */
  statuses: readonly BriefSyncStatus[];
  /** Connectors turned on but not syncing, with why. */
  skipped: readonly { id: string; reason: string }[];
}

export interface BriefEvents {
  /** Sale events that occurred on the day, oldest first. */
  events: readonly StoredEvent[];
  /** True when there were more events than were read. */
  truncated: boolean;
}

export interface DailyBriefInput {
  organizationId: string;
  /** The store day the brief covers, YYYY-MM-DD in `timeZone`. */
  date: string;
  timeZone: string;
  /** When the brief is built, ISO 8601. */
  generatedAt: string;
  day: BriefEvents;
  /** The same weekday a week earlier. */
  lastWeek: BriefEvents;
  /** The latest sale event before the comparison day, so a quiet day can be told from an instance with no sales at all. */
  lastSaleBefore: StoredEvent | null;
  /** Recommendations raised in the lookback window, any order. */
  recommendations: readonly Recommendation[];
  /** Every piece of feedback recorded on those recommendations. */
  feedback: readonly Feedback[];
  /** Sync results; absent when the caller doesn't know them. */
  sync?: BriefSyncInput;
}

/** Where a figure came from: the events it was counted from and the systems that sent them. */
export interface Citation {
  eventIds: string[];
  systems: string[];
}

export interface SalesFigures {
  sales: number;
  grossCents: number;
  refunds: number;
  refundCents: number;
  /** Gross less refunds. */
  netCents: number;
  /** The sale.completed events behind `sales` and `grossCents`. */
  saleEvents: Citation;
  /** The sale.returned events behind `refunds` and `refundCents`. */
  refundEvents: Citation;
}

export interface SalesBreakdown extends SalesFigures {
  /** The channel (store, online, phone, event) or the system id. */
  key: string;
}

export interface SalesDay {
  date: string;
  from: string;
  to: string;
  totals: SalesFigures;
  byChannel: SalesBreakdown[];
  bySystem: SalesBreakdown[];
  /** Events that occurred that day but could not be counted, such as ones whose payload retention has cleared. */
  uncounted: Citation;
  /** True when the day had more events than were read, so the figures are a floor. */
  truncated: boolean;
}

export type SalesSection =
  | { status: "no_data"; note: string }
  | {
      status: "ok" | "partial";
      day: SalesDay;
      lastWeek: SalesDay;
      /** Day less last week, for each figure; cites both days' events. */
      change: { sales: number; grossCents: number; refunds: number; refundCents: number; netCents: number };
      /** The latest sale before the comparison day, cited when a day had none. */
      lastSaleBefore?: { eventId: string; system: string; occurredAt: string };
      notes: string[];
    };

export interface BriefFinding {
  recommendationId: string;
  /** The department rule that raised it, when it is one the brief knows. */
  rule?: string;
  summary: string;
  confidence: number;
  impact?: Impact;
  createdAt: string;
  /** The recommendation's provenance: the events and signals it was reasoned from. */
  eventIds: string[];
  signalIds: string[];
  degraded: boolean;
}

export interface SyncProblem {
  system: string;
  problem: "failed" | "stale" | "not_run" | "not_syncing";
  detail: string;
  at?: string;
}

export type SyncSection = { known: false; note: string } | { known: true; checkedAt: string; problems: SyncProblem[]; healthy: string[] };

export interface DailyBrief {
  organizationId: string;
  date: string;
  timeZone: string;
  generatedAt: string;
  /** False when the instance has nothing synced to report on. */
  hasData: boolean;
  sales: SalesSection;
  /** Open findings of the rules in BRIEF_UNUSUAL_RULES, highest impact first. */
  unusual: BriefFinding[];
  sync: SyncSection;
  /** Other open recommendations, highest impact first, at most BRIEF_WAITING_SHOWN. */
  waiting: BriefFinding[];
  /** Open recommendations beyond those listed. */
  moreWaiting: number;
  /** The brief as plain text, for a log line or a webhook. */
  text: string;
}

// ---------------------------------------------------------------------------
// Sales

const intCents = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** What one sale event adds, or null when it can't be read. */
function readSale(event: StoredEvent): { channel: string; sale: boolean; cents: number } | null {
  if (event.payloadClearedAt !== null) return null;
  const p = event.payload;
  if (event.type === "sale.completed") {
    const cents = intCents(p.totalCents);
    return cents === null ? null : { channel: typeof p.channel === "string" && p.channel ? p.channel : "unknown", sale: true, cents };
  }
  if (!Array.isArray(p.lines)) return null;
  let cents = 0;
  for (const line of p.lines as unknown[]) {
    const c = intCents(typeof line === "object" && line !== null ? (line as Record<string, unknown>).refundCents : undefined);
    if (c === null) return null;
    cents += c;
  }
  // A return names no channel of its own; it is listed under "returns".
  return { channel: "returns", sale: false, cents };
}

interface Tally {
  sales: number;
  grossCents: number;
  refunds: number;
  refundCents: number;
  saleIds: string[];
  saleSystems: Set<string>;
  refundIds: string[];
  refundSystems: Set<string>;
}

const emptyTally = (): Tally => ({ sales: 0, grossCents: 0, refunds: 0, refundCents: 0, saleIds: [], saleSystems: new Set(), refundIds: [], refundSystems: new Set() });

function add(t: Tally, event: StoredEvent, read: { sale: boolean; cents: number }): void {
  if (read.sale) {
    t.sales++;
    t.grossCents += read.cents;
    t.saleIds.push(event.id);
    t.saleSystems.add(event.source);
  } else {
    t.refunds++;
    t.refundCents += read.cents;
    t.refundIds.push(event.id);
    t.refundSystems.add(event.source);
  }
}

const sorted = (s: Set<string>) => [...s].sort();

function figures(t: Tally): SalesFigures {
  return {
    sales: t.sales,
    grossCents: t.grossCents,
    refunds: t.refunds,
    refundCents: t.refundCents,
    netCents: t.grossCents - t.refundCents,
    saleEvents: { eventIds: t.saleIds, systems: sorted(t.saleSystems) },
    refundEvents: { eventIds: t.refundIds, systems: sorted(t.refundSystems) },
  };
}

function breakdown(map: Map<string, Tally>): SalesBreakdown[] {
  return [...map.entries()]
    .map(([key, t]) => ({ key, ...figures(t) }))
    .sort((a, b) => b.grossCents - a.grossCents || b.refundCents - a.refundCents || (a.key < b.key ? -1 : 1));
}

export function salesDay(date: string, timeZone: string, input: BriefEvents): SalesDay {
  const total = emptyTally();
  const byChannel = new Map<string, Tally>();
  const bySystem = new Map<string, Tally>();
  const uncountedIds: string[] = [];
  const uncountedSystems = new Set<string>();
  for (const event of input.events) {
    if (!(BRIEF_SALE_TYPES as readonly string[]).includes(event.type)) continue;
    const read = readSale(event);
    if (!read) {
      uncountedIds.push(event.id);
      uncountedSystems.add(event.source);
      continue;
    }
    add(total, event, read);
    for (const [map, key] of [
      [byChannel, read.channel],
      [bySystem, event.source],
    ] as const) {
      const t = map.get(key) ?? emptyTally();
      add(t, event, read);
      map.set(key, t);
    }
  }
  return {
    date,
    ...dayBounds(date, timeZone),
    totals: figures(total),
    byChannel: breakdown(byChannel),
    bySystem: breakdown(bySystem),
    uncounted: { eventIds: uncountedIds, systems: sorted(uncountedSystems) },
    truncated: input.truncated,
  };
}

function salesSection(input: DailyBriefInput): SalesSection {
  const day = salesDay(input.date, input.timeZone, input.day);
  const lastWeek = salesDay(addDays(input.date, -7), input.timeZone, input.lastWeek);
  const seen = (d: SalesDay) => d.totals.sales + d.totals.refunds + d.uncounted.eventIds.length > 0;
  if (!seen(day) && !seen(lastWeek) && !input.lastSaleBefore) {
    return {
      status: "no_data",
      note: "No sales have synced into this instance yet, so there are no sales figures to report. Connect a point of sale or online store to see them here.",
    };
  }
  const notes: string[] = [];
  for (const d of [day, lastWeek]) {
    if (d.uncounted.eventIds.length) {
      notes.push(
        `${d.uncounted.eventIds.length} sale ${d.uncounted.eventIds.length === 1 ? "event" : "events"} on ${d.date} could not be counted (raw data cleared or unreadable), so that day's figures are a floor: ${cite(d.uncounted)}.`,
      );
    }
    if (d.truncated) notes.push(`${d.date} had more than ${BRIEF_MAX_EVENTS_PER_DAY} sale events; only the first ${BRIEF_MAX_EVENTS_PER_DAY} were counted.`);
  }
  const last = input.lastSaleBefore;
  const lastSaleBefore = last && (!seen(day) || !seen(lastWeek)) ? { eventId: last.id, system: last.source, occurredAt: last.occurredAt } : undefined;
  for (const d of [day, lastWeek]) {
    if (!seen(d)) notes.push(`No sales or refunds dated ${d.date} have synced.${lastSaleBefore ? ` The latest sale before ${lastWeek.date} is event ${lastSaleBefore.eventId} from ${lastSaleBefore.system} at ${lastSaleBefore.occurredAt}.` : ""}`);
  }
  const partial = notes.length > 0 && [day, lastWeek].some((d) => d.truncated || d.uncounted.eventIds.length > 0);
  const t = day.totals;
  const w = lastWeek.totals;
  return {
    status: partial ? "partial" : "ok",
    day,
    lastWeek,
    change: { sales: t.sales - w.sales, grossCents: t.grossCents - w.grossCents, refunds: t.refunds - w.refunds, refundCents: t.refundCents - w.refundCents, netCents: t.netCents - w.netCents },
    ...(lastSaleBefore ? { lastSaleBefore } : {}),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Recommendations

/** A recommendation's id without its day, so the same finding raised on several days is listed once. */
export function findingKey(id: string): string {
  return id.replace(/_\d{4}-\d{2}-\d{2}$/, "");
}

export function ruleOf(id: string): string | undefined {
  return BRIEF_UNUSUAL_RULES.find((r) => id.startsWith(r.idPrefix))?.rule;
}

/** Highest dollar impact first; those without one after, by confidence, then newest. */
export function byImpact(a: BriefFinding, b: BriefFinding): number {
  return (
    (b.impact?.cents ?? -1) - (a.impact?.cents ?? -1) ||
    b.confidence - a.confidence ||
    Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
    (a.recommendationId < b.recommendationId ? -1 : a.recommendationId > b.recommendationId ? 1 : 0)
  );
}

/** The latest raising of each finding that nobody has answered yet. */
function openFindings(recommendations: readonly Recommendation[], feedback: readonly Feedback[]): BriefFinding[] {
  const answered = new Set(feedback.map((f) => f.recommendationId));
  const latest = new Map<string, Recommendation>();
  for (const r of recommendations) {
    const key = findingKey(r.id);
    const current = latest.get(key);
    if (!current || Date.parse(r.createdAt) > Date.parse(current.createdAt) || (r.createdAt === current.createdAt && r.id > current.id)) latest.set(key, r);
  }
  return [...latest.values()]
    .filter((r) => !answered.has(r.id))
    .map((r) => {
      const rule = ruleOf(r.id);
      return {
        recommendationId: r.id,
        ...(rule ? { rule } : {}),
        summary: r.summary,
        confidence: r.confidence,
        ...(r.impact ? { impact: r.impact } : {}),
        createdAt: r.createdAt,
        eventIds: [...r.provenance.eventIds],
        signalIds: [...r.provenance.signalIds],
        degraded: r.degraded,
      };
    })
    .sort(byImpact);
}

// ---------------------------------------------------------------------------
// Sync

function syncSection(sync: BriefSyncInput | undefined, generatedAt: string): SyncSection {
  if (!sync) return { known: false, note: "Sync results aren't available to this brief." };
  const now = Date.parse(generatedAt);
  const problems: SyncProblem[] = [];
  const healthy: string[] = [];
  for (const id of [...new Set(sync.scheduled)]) {
    const status = sync.statuses.find((s) => s.id === id);
    if (!status) {
      problems.push({ system: id, problem: "not_run", detail: "has not finished a sync since the instance started" });
    } else if (status.outcome === "failed") {
      problems.push({ system: id, problem: "failed", detail: `last sync failed${status.error ? `: ${status.error}` : ""}`, at: status.finishedAt });
    } else if (now - Date.parse(status.finishedAt) > BRIEF_STALE_SYNC_HOURS * 3_600_000) {
      const hours = Math.floor((now - Date.parse(status.finishedAt)) / 3_600_000);
      problems.push({ system: id, problem: "stale", detail: `last synced ${hours} hours ago`, at: status.finishedAt });
    } else {
      healthy.push(id);
    }
  }
  for (const s of sync.skipped) problems.push({ system: s.id, problem: "not_syncing", detail: `turned on but not syncing: ${s.reason}` });
  return { known: true, checkedAt: generatedAt, problems, healthy: healthy.sort() };
}

// ---------------------------------------------------------------------------
// Text

function ids(eventIds: readonly string[]): string {
  const more = eventIds.length - TEXT_IDS_SHOWN;
  return `${eventIds.length === 1 ? "event" : "events"} ${eventIds.slice(0, TEXT_IDS_SHOWN).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

function cite(c: Citation): string {
  return `[${ids(c.eventIds)}; ${c.systems.join(", ")}]`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const signedDollars = (cents: number) => (cents > 0 ? `+${dollars(cents)}` : cents < 0 ? `-${dollars(-cents)}` : dollars(0));

function figuresText(f: SalesFigures): string {
  const sales = f.sales ? `${plural(f.sales, "sale")}, ${dollars(f.grossCents)} gross ${cite(f.saleEvents)}` : "no sales";
  const refunds = f.refunds ? `${plural(f.refunds, "refund")} of ${dollars(f.refundCents)} ${cite(f.refundEvents)}` : "no refunds";
  return `${sales}; ${refunds}`;
}

function findingText(f: BriefFinding): string {
  const worth = f.impact ? ` (${f.impact.kind} about ${dollars(f.impact.cents)})` : "";
  const from = f.eventIds.length ? ` [${ids(f.eventIds)}]` : "";
  return `- ${f.summary}${worth}${f.rule ? ` <${f.rule}>` : ""}${from} {${f.recommendationId}}`;
}

function render(brief: Omit<DailyBrief, "text">): string {
  const lines = [`Daily brief for ${brief.date} (${brief.timeZone})`];
  const sync = brief.sync.known ? brief.sync.problems : [];
  const syncLine = (p: SyncProblem) => `- ${p.system} ${p.detail}${p.at ? ` (${p.at})` : ""}.`;
  if (!brief.hasData) {
    lines.push("", "This instance has no synced data yet: no sales, no open recommendations and no successful sync. There is nothing to report, so no figures are shown.");
    if (sync.length) lines.push("", "Sync", ...sync.map(syncLine));
    return lines.join("\n");
  }
  lines.push("", "Sales");
  const s = brief.sales;
  if (s.status === "no_data") lines.push(s.note);
  else {
    lines.push(`${s.day.date}: ${figuresText(s.day.totals)}.`);
    lines.push(`${s.lastWeek.date}, same day last week: ${figuresText(s.lastWeek.totals)}.`);
    lines.push(`Change: ${signed(s.change.sales)} sales, ${signedDollars(s.change.grossCents)} gross, ${signed(s.change.refunds)} refunds, ${signedDollars(s.change.netCents)} net.`);
    for (const [label, rows] of [
      ["By channel", s.day.byChannel],
      ["By system", s.day.bySystem],
    ] as const) {
      if (rows.length) lines.push(`${label}: ${rows.map((r) => `${r.key} ${plural(r.sales, "sale")} ${dollars(r.grossCents)}${r.refunds ? `, ${plural(r.refunds, "refund")} ${dollars(r.refundCents)}` : ""}`).join("; ")}.`);
    }
    lines.push(...s.notes);
  }
  lines.push("", "Unusual");
  if (!brief.unusual.length && !sync.length) lines.push(brief.sync.known ? "Nothing unusual." : `Nothing unusual from the department rules. ${brief.sync.note}`);
  lines.push(...brief.unusual.map(findingText));
  lines.push(...sync.map(syncLine));
  lines.push("", "Waiting on you");
  if (!brief.waiting.length) lines.push("No open recommendations.");
  lines.push(...brief.waiting.map(findingText));
  if (brief.moreWaiting) lines.push(`and ${brief.moreWaiting} more.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

/** Builds the brief for one store day. Pure: the same input always gives the same brief. */
export function buildDailyBrief(input: DailyBriefInput): DailyBrief {
  if (!isDay(input.date)) throw new RangeError("date must be a day written YYYY-MM-DD");
  if (!isTimeZone(input.timeZone)) throw new RangeError("timeZone must be an IANA time zone, such as America/New_York");
  const sales = salesSection(input);
  const open = openFindings(input.recommendations, input.feedback);
  const unusual = open.filter((f) => f.rule !== undefined);
  const others = open.filter((f) => f.rule === undefined);
  const sync = syncSection(input.sync, input.generatedAt);
  // A failed, skipped or not-yet-run connector has brought nothing in; a healthy or merely stale one has.
  const synced = sync.known && (sync.healthy.length > 0 || sync.problems.some((p) => p.problem === "stale"));
  const hasData = sales.status !== "no_data" || open.length > 0 || synced;
  const brief = {
    organizationId: input.organizationId,
    date: input.date,
    timeZone: input.timeZone,
    generatedAt: input.generatedAt,
    hasData,
    sales,
    unusual,
    sync,
    waiting: others.slice(0, BRIEF_WAITING_SHOWN),
    moreWaiting: Math.max(0, others.length - BRIEF_WAITING_SHOWN),
  };
  return { ...brief, text: render(brief) };
}
