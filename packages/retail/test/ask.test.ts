import { describe, expect, it } from "vitest";
import { sha256Json, type Feedback, type Recommendation, type StoredEvent } from "@karatos/core";
import {
  answerQuestion,
  ASK_EVENT_TYPES,
  ASK_FINDINGS_SHOWN,
  ASK_MAX_EVENTS,
  ASK_MAX_PERIOD_DAYS,
  ASK_MAX_QUESTION_CHARS,
  ASK_QUESTIONS,
  normalizeQuestion,
  openFindingsFor,
  periodOf,
  routeQuestion,
  type AskAnswer,
  type AskData,
  type AskPeriod,
  type AskRoute,
} from "../src/index.js";

const ORG = "example-jewelers";
const TZ = "America/New_York";
// Friday 2026-11-20, 10:00 in New York.
const NOW = new Date("2026-11-20T15:00:00.000Z");
const clock = { now: NOW, timeZone: TZ };

function stored(id: string, source: string, type: string, occurredAt: string, payload: Record<string, unknown>, cleared = false): StoredEvent {
  return {
    id,
    organizationId: ORG,
    source,
    type,
    occurredAt,
    receivedAt: occurredAt,
    idempotencyKey: `${source}:${id}`,
    payload: cleared ? { cleared: true, at: NOW.toISOString(), reason: "retention" } : payload,
    sourceRef: { system: source, recordId: id },
    payloadSha256: sha256Json(payload),
    payloadClearedAt: cleared ? NOW.toISOString() : null,
  };
}

const sale = (id: string, source: string, at: string, totalCents: number, channel = "store") =>
  stored(id, source, "sale.completed", at, { saleId: id, channel, totalCents, lines: [{ sku: "R1", quantity: 1, unitPriceCents: totalCents }], payments: [{ method: "card", amountCents: totalCents }] });
const refund = (id: string, source: string, at: string, refundCents: number) => stored(id, source, "sale.returned", at, { saleId: "s", returnId: id, lines: [{ sku: "R1", quantity: 1, refundCents }] });

function rec(id: string, eventIds: string[], extra: Partial<Recommendation> = {}): Recommendation {
  return {
    id,
    organizationId: ORG,
    summary: `summary of ${id}`,
    confidence: 0.7,
    expectedImpact: "x",
    provenance: { eventIds, signalIds: [`sig_${id}`], documentIds: [] },
    degraded: false,
    createdAt: "2026-11-20T14:00:00.000Z",
    ...extra,
  };
}

const impact = (cents: number) => ({ kind: "protects" as const, cents, lowCents: cents, highCents: cents, basis: "b" });

const data = (extra: Partial<AskData> = {}): AskData => ({ organizationId: ORG, timeZone: TZ, generatedAt: NOW.toISOString(), ...extra });

const ask = (question: string, extra: Partial<AskData> = {}, at = clock) => answerQuestion(question, routeQuestion(question, at), data({ timeZone: at.timeZone, generatedAt: at.now.toISOString(), ...extra }));

function intent(question: string, at = clock): string | null {
  const r = routeQuestion(question, at);
  return r.kind === "intent" ? r.intent : r.kind;
}

function period(question: string, at = clock): AskPeriod {
  const r = routeQuestion(question, at);
  if (r.kind !== "intent" || !r.period) throw new Error(`no period in ${question}: ${JSON.stringify(r)}`);
  return r.period;
}

function problem(question: string, at = clock): string {
  const r = routeQuestion(question, at);
  if (r.kind !== "unclear_period") throw new Error(`expected an unclear period for ${question}: ${JSON.stringify(r)}`);
  return r.problem;
}

/** Every number an answer states names at least one event and one system, each one an event and system it was given. */
function expectCited(answer: AskAnswer, events: readonly StoredEvent[]) {
  const sources = new Map(events.map((e) => [e.id, e.source]));
  expect(answer.facts.length).toBeGreaterThan(0);
  for (const f of answer.facts) {
    expect(f.citation.eventIds.length, f.label).toBeGreaterThan(0);
    expect(f.citation.systems.length, f.label).toBeGreaterThan(0);
    for (const id of f.citation.eventIds) expect(sources.has(id), `${f.label} cites ${id}`).toBe(true);
    expect(f.citation.systems, f.label).toEqual([...new Set(f.citation.eventIds.map((id) => sources.get(id)!))].sort());
  }
}

describe("routeQuestion: what is asked", () => {
  it("routes each listed example to its own answer", () => {
    for (const q of ASK_QUESTIONS) expect(intent(q.example), q.example).toBe(q.intent);
    expect(new Set(ASK_QUESTIONS.map((q) => q.intent)).size).toBe(ASK_QUESTIONS.length);
  });

  it("recognizes the ways people ask", () => {
    const cases: [string, string][] = [
      ["What sold this week?", "sales"],
      ["How much did we make yesterday?", "sales"],
      ["Revenue last month", "sales"],
      ["any refunds today?", "sales"],
      ["Which payouts are late?", "payouts"],
      ["Did Stripe's deposit come in?", "payouts"],
      ["how are sales and payouts?", "payouts"],
      ["Who is waiting on a reply?", "awaiting_reply"],
      ["Anyone we haven't called back?", "awaiting_reply"],
      ["missed calls", "awaiting_reply"],
      ["Which customers are waiting for an answer?", "awaiting_reply"],
      ["What's low on stock?", "stock"],
      ["What do I need to reorder?", "stock"],
      ["Do the inventory counts agree?", "stock"],
      ["What's waiting on me?", "open_recommendations"],
      ["Show open recommendations", "open_recommendations"],
      ["What needs my attention?", "open_recommendations"],
      ["Is everything syncing?", "sync_health"],
      ["Which connectors failed?", "sync_health"],
    ];
    for (const [q, want] of cases) expect(intent(q), q).toBe(want);
  });

  it("doesn't guess at questions it has no answer for", () => {
    for (const q of ["What's the weather?", "Who are my best customers?", "hello", "", "   ", "?!", "how many employees do we have"]) expect(intent(q), q).toBe("unsupported");
  });

  it("reads only the first ASK_MAX_QUESTION_CHARS characters", () => {
    expect(intent(`${"x ".repeat(ASK_MAX_QUESTION_CHARS)}sales`)).toBe("unsupported");
    expect(intent(`sales ${"x ".repeat(ASK_MAX_QUESTION_CHARS)}`)).toBe("sales");
  });

  it("normalizes case, quotes, possessives and punctuation but keeps dates whole", () => {
    expect(normalizeQuestion("What’s LOW on   stock?!")).toBe("what is low on stock");
    expect(normalizeQuestion("Sales on Nov 18, 2026.")).toBe("sales on nov 18 2026");
    expect(normalizeQuestion("from 2026-11-01 to 2026-11-15")).toBe("from 2026-11-01 to 2026-11-15");
    expect(normalizeQuestion("re-order 11/12 $1,200.50")).toBe("re-order 11/12 1,200.50");
    expect(normalizeQuestion("the store's sales")).toBe("the store is sales");
  });

  it("throws on an unknown time zone", () => {
    expect(() => routeQuestion("sales", { now: NOW, timeZone: "Mars/Olympus" })).toThrow(RangeError);
    expect(() => answerQuestion("sales", { kind: "unsupported" }, data({ timeZone: "Nowhere" }))).toThrow(RangeError);
  });
});

describe("routeQuestion: periods on the store's calendar", () => {
  it("reads named periods, weeks starting Monday", () => {
    const cases: [string, string, string, string][] = [
      ["sales today", "2026-11-20", "2026-11-20", "today (2026-11-20)"],
      ["sales so far today", "2026-11-20", "2026-11-20", "today (2026-11-20)"],
      ["sales yesterday", "2026-11-19", "2026-11-19", "yesterday (2026-11-19)"],
      ["what sold this week", "2026-11-16", "2026-11-20", "this week (2026-11-16 to 2026-11-20)"],
      ["sales week to date", "2026-11-16", "2026-11-20", "this week (2026-11-16 to 2026-11-20)"],
      ["sales last week", "2026-11-09", "2026-11-15", "last week (2026-11-09 to 2026-11-15)"],
      ["sales previous week", "2026-11-09", "2026-11-15", "last week (2026-11-09 to 2026-11-15)"],
      ["sales the past week", "2026-11-14", "2026-11-20", "the last 7 days (2026-11-14 to 2026-11-20)"],
      ["sales last 7 days", "2026-11-14", "2026-11-20", "the last 7 days (2026-11-14 to 2026-11-20)"],
      ["sales past 1 day", "2026-11-20", "2026-11-20", "the last 1 day (2026-11-20)"],
      ["sales previous 30 days", "2026-10-22", "2026-11-20", "the last 30 days (2026-10-22 to 2026-11-20)"],
      ["sales this month", "2026-11-01", "2026-11-20", "this month (2026-11-01 to 2026-11-20)"],
      ["sales month to date", "2026-11-01", "2026-11-20", "this month (2026-11-01 to 2026-11-20)"],
      ["sales last month", "2026-10-01", "2026-10-31", "last month (2026-10-01 to 2026-10-31)"],
      ["sales this year", "2026-01-01", "2026-11-20", "this year (2026-01-01 to 2026-11-20)"],
      ["sales ytd", "2026-01-01", "2026-11-20", "this year (2026-01-01 to 2026-11-20)"],
      ["sales in october", "2026-10-01", "2026-10-31", "October 2026 (2026-10-01 to 2026-10-31)"],
      ["sales in feb", "2026-02-01", "2026-02-28", "February 2026 (2026-02-01 to 2026-02-28)"],
      ["sales during sept", "2026-09-01", "2026-09-30", "September 2026 (2026-09-01 to 2026-09-30)"],
      ["sales in december", "2025-12-01", "2025-12-31", "December 2025 (2025-12-01 to 2025-12-31)"],
      ["sales for february 2024", "2024-02-01", "2024-02-29", "February 2024 (2024-02-01 to 2024-02-29)"],
    ];
    for (const [q, fromDay, toDay, label] of cases) expect(period(q), q).toMatchObject({ fromDay, toDay, label, defaulted: false });
  });

  it("reads explicit days and ranges, both days counted", () => {
    const cases: [string, string, string, number][] = [
      ["sales on 2026-11-18", "2026-11-18", "2026-11-18", 1],
      ["sales from 2026-11-01 to 2026-11-15", "2026-11-01", "2026-11-15", 15],
      ["sales between 2026-11-01 and 2026-11-03", "2026-11-01", "2026-11-03", 3],
      ["sales 2026-11-01 through 2026-11-02", "2026-11-01", "2026-11-02", 2],
      ["sales 2026-11-01 - 2026-11-02", "2026-11-01", "2026-11-02", 2],
      ["sales since 2026-11-10", "2026-11-10", "2026-11-20", 11],
      ["sales on Nov 18, 2026", "2026-11-18", "2026-11-18", 1],
      ["sales november 18th", "2026-11-18", "2026-11-18", 1],
      ["sales on the 3rd of march", "2026-03-03", "2026-03-03", 1],
      ["sales 18 nov 2025", "2025-11-18", "2025-11-18", 1],
      // A day with no year still to come this year is last year's.
      ["sales december 25", "2025-12-25", "2025-12-25", 1],
      ["sales on 2026-11-20", "2026-11-20", "2026-11-20", 1],
    ];
    for (const [q, fromDay, toDay, days] of cases) expect(period(q), q).toMatchObject({ fromDay, toDay, days });
    expect(period("sales from 2026-11-01 to 2026-11-15").label).toBe("2026-11-01 to 2026-11-15");
    expect(period("sales since 2026-11-10").label).toBe("since 2026-11-10 (2026-11-10 to 2026-11-20)");
  });

  it("reads a period running past today up to today", () => {
    expect(period("sales from 2026-11-15 to 2026-12-31")).toMatchObject({ fromDay: "2026-11-15", toDay: "2026-11-20", days: 6, label: "2026-11-15 to 2026-12-31 (2026-11-15 to 2026-11-20)" });
  });

  it("says what is wrong with a period it can't read, rather than guessing", () => {
    expect(problem("sales 2026-02-30")).toBe("2026-02-30 isn't a day on the calendar");
    expect(problem("sales from 2026-11-10 to 2026-02-31")).toBe("2026-02-31 isn't a day on the calendar");
    expect(problem("sales february 30")).toBe("february 30 isn't a day on the calendar");
    expect(problem("sales from 2026-11-15 to 2026-11-01")).toBe("2026-11-15 is after 2026-11-01; put the earlier day first");
    expect(problem("sales 2026-11-21")).toBe("2026-11-21 hasn't come yet in the store's time zone (today is 2026-11-20)");
    expect(problem("sales since 2026-12-01")).toBe("2026-12-01 hasn't come yet in the store's time zone (today is 2026-11-20)");
    expect(problem("sales 11/12")).toMatch(/^write dates as 2026-11-18 or November 18/);
    expect(problem("sales 11/12/2026")).toMatch(/^write dates as/);
    expect(problem("sales last 0 days")).toBe("a period needs at least one day");
    expect(problem(`sales last ${ASK_MAX_PERIOD_DAYS + 1} days`)).toBe(`a period can be at most ${ASK_MAX_PERIOD_DAYS} days`);
    expect(period(`sales last ${ASK_MAX_PERIOD_DAYS} days`).days).toBe(ASK_MAX_PERIOD_DAYS);
    expect(problem("sales from 2024-01-01 to 2026-11-01")).toBe(`a period can be at most ${ASK_MAX_PERIOD_DAYS} days`);
  });

  it("covers today so far when a sales question names no period, and says so", () => {
    expect(period("what sold?")).toMatchObject({ fromDay: "2026-11-20", toDay: "2026-11-20", defaulted: true, label: "today (2026-11-20)" });
    expect(routeQuestion("which payouts are late?", clock)).toEqual({ kind: "intent", intent: "payouts" });
    expect(periodOf("nothing here", clock)).toBeNull();
  });

  it("turns days into the store's own midnights, in any time zone", () => {
    // 03:00 UTC on the 19th: still the 18th in New York, already the 19th in Kolkata, the 19th afternoon in Auckland.
    const at = new Date("2026-11-19T03:00:00.000Z");
    expect(period("sales today", { now: at, timeZone: "America/New_York" })).toMatchObject({ fromDay: "2026-11-18", from: "2026-11-18T05:00:00.000Z", to: "2026-11-19T05:00:00.000Z" });
    expect(period("sales today", { now: at, timeZone: "Asia/Kolkata" })).toMatchObject({ fromDay: "2026-11-19", from: "2026-11-18T18:30:00.000Z", to: "2026-11-19T18:30:00.000Z" });
    expect(period("sales yesterday", { now: at, timeZone: "Pacific/Auckland" })).toMatchObject({ fromDay: "2026-11-18", from: "2026-11-17T11:00:00.000Z", to: "2026-11-18T11:00:00.000Z" });
    expect(period("sales yesterday", { now: at, timeZone: "UTC" })).toMatchObject({ fromDay: "2026-11-18", from: "2026-11-18T00:00:00.000Z", to: "2026-11-19T00:00:00.000Z" });
    // A date in the future in New York can be today in Kolkata.
    expect(problem("sales 2026-11-19", { now: at, timeZone: "America/New_York" })).toMatch(/hasn't come yet/);
    expect(period("sales 2026-11-19", { now: at, timeZone: "Asia/Kolkata" }).fromDay).toBe("2026-11-19");
  });

  it("keeps whole store days across the clock changes", () => {
    // New York falls back on Sunday 2026-11-01: the week before is 7 days and an hour.
    const fall = period("sales last week", { now: new Date("2026-11-04T15:00:00.000Z"), timeZone: TZ });
    expect(fall).toMatchObject({ fromDay: "2026-10-26", toDay: "2026-11-01", from: "2026-10-26T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z", days: 7 });
    expect(Date.parse(fall.to) - Date.parse(fall.from)).toBe((7 * 24 + 1) * 3_600_000);
    // And springs forward on Sunday 2026-03-08: that day is 23 hours.
    const spring = period("sales yesterday", { now: new Date("2026-03-09T15:00:00.000Z"), timeZone: TZ });
    expect(spring).toMatchObject({ fromDay: "2026-03-08", from: "2026-03-08T05:00:00.000Z", to: "2026-03-09T04:00:00.000Z" });
    // Sydney springs forward on Sunday 2026-10-04, in the other hemisphere.
    const sydney = period("sales on 2026-10-04", { now: new Date("2026-10-10T00:00:00.000Z"), timeZone: "Australia/Sydney" });
    expect(Date.parse(sydney.to) - Date.parse(sydney.from)).toBe(23 * 3_600_000);
    // Just after midnight local on the day after the change, "yesterday" is the long day.
    const justAfter = period("sales yesterday", { now: new Date("2026-11-02T05:30:00.000Z"), timeZone: TZ });
    expect(justAfter).toMatchObject({ fromDay: "2026-11-01", from: "2026-11-01T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z" });
  });

  it("starts weeks on Monday whatever day it is asked, and months on the 1st across the new year", () => {
    expect(period("sales this week", { now: new Date("2026-11-16T15:00:00.000Z"), timeZone: TZ })).toMatchObject({ fromDay: "2026-11-16", toDay: "2026-11-16" });
    expect(period("sales this week", { now: new Date("2026-11-22T15:00:00.000Z"), timeZone: TZ })).toMatchObject({ fromDay: "2026-11-16", toDay: "2026-11-22" });
    expect(period("sales last week", { now: new Date("2026-11-22T15:00:00.000Z"), timeZone: TZ })).toMatchObject({ fromDay: "2026-11-09", toDay: "2026-11-15" });
    const january = { now: new Date("2027-01-05T15:00:00.000Z"), timeZone: TZ };
    expect(period("sales last month", january)).toMatchObject({ fromDay: "2026-12-01", toDay: "2026-12-31" });
    expect(period("sales in december", january)).toMatchObject({ fromDay: "2026-12-01", toDay: "2026-12-31" });
    expect(period("sales in january", january)).toMatchObject({ fromDay: "2027-01-01", toDay: "2027-01-05" });
  });
});

describe("answerQuestion: sales", () => {
  const week = [
    sale("e1", "shopify", "2026-11-16T15:00:00.000Z", 10_000, "online"),
    sale("e2", "square", "2026-11-17T16:00:00.000Z", 25_000, "store"),
    sale("e3", "shopify", "2026-11-19T18:00:00.000Z", 5_000, "online"),
    refund("e4", "square", "2026-11-19T19:00:00.000Z", 2_500),
  ];

  it("sums sales, refunds and net by channel and system, every number citing its events and systems", () => {
    const a = ask("What sold this week?", { sales: { events: week, truncated: false }, lastSaleBefore: null, latestSynced: week[3]! });
    expect(a).toMatchObject({ intent: "sales", status: "answered", period: { fromDay: "2026-11-16", toDay: "2026-11-20" } });
    expect(a.sales!.totals).toMatchObject({ sales: 3, grossCents: 40_000, refunds: 1, refundCents: 2_500, netCents: 37_500 });
    expect(a.sales!.from).toBe("2026-11-16T05:00:00.000Z");
    expect(a.sales!.to).toBe("2026-11-21T05:00:00.000Z");
    expect(a.sales!.byChannel.map((r) => [r.key, r.grossCents, r.refundCents])).toEqual([
      ["store", 25_000, 0],
      ["online", 15_000, 0],
      ["returns", 0, 2_500],
    ]);
    expect(a.sales!.bySystem.map((r) => [r.key, r.sales, r.refunds])).toEqual([
      ["square", 1, 1],
      ["shopify", 2, 0],
    ]);
    expectCited(a, week);
    const fact = (label: string) => a.facts.find((f) => f.label === label);
    expect(fact("sales")).toEqual({ label: "sales", value: 3, unit: "count", citation: { eventIds: ["e1", "e2", "e3"], systems: ["shopify", "square"] } });
    expect(fact("gross")).toMatchObject({ value: 40_000, unit: "cents" });
    expect(fact("refunds")).toEqual({ label: "refunds", value: 1, unit: "count", citation: { eventIds: ["e4"], systems: ["square"] } });
    expect(fact("net")).toEqual({ label: "net", value: 37_500, unit: "cents", citation: { eventIds: ["e1", "e2", "e3", "e4"], systems: ["shopify", "square"] } });
    expect(fact("channel online: gross")).toEqual({ label: "channel online: gross", value: 15_000, unit: "cents", citation: { eventIds: ["e1", "e3"], systems: ["shopify"] } });
    expect(fact("system square: refunded")).toEqual({ label: "system square: refunded", value: 2_500, unit: "cents", citation: { eventIds: ["e4"], systems: ["square"] } });
    // A zero is never stated as a cited fact.
    expect(fact("channel online: refunds")).toBeUndefined();
    expect(a.text).toContain("This week (2026-11-16 to 2026-11-20): 3 sales, $400.00 gross [events e1, e2, e3; shopify, square]; 1 refund of $25.00 [event e4; square]; $375.00 net [events e1, e2, e3 and 1 more; shopify, square].");
    expect(a.text).toContain("By channel: store: 1 sale, $250.00 gross [event e2; square]; no refunds | online: 2 sales, $150.00 gross [events e1, e3; shopify]; no refunds | returns: no sales; 1 refund of $25.00 [event e4; square].");
    expect(a.text).toContain("By system: square:");
    expect(a.notes).toEqual([]);
  });

  it("says when no period was named", () => {
    const today = [sale("t1", "shopify", "2026-11-20T14:00:00.000Z", 1_000)];
    const a = ask("what sold?", { sales: { events: today, truncated: false }, lastSaleBefore: week[0]!, latestSynced: today[0]! });
    expect(a.period!.defaulted).toBe(true);
    expect(a.notes).toEqual(["No period was named, so this covers today so far."]);
    expect(a.text).toContain("Today (2026-11-20): 1 sale, $10.00 gross [event t1; shopify]; no refunds.");
    expect(a.text).toContain("No period was named");
    expectCited(a, today);
  });

  it("marks figures a floor when events couldn't be read or there were too many", () => {
    const events = [sale("c1", "square", "2026-11-17T16:00:00.000Z", 1_000), { ...sale("c2", "clover", "2026-11-17T17:00:00.000Z", 9_000), payloadClearedAt: NOW.toISOString(), payload: {} }];
    const a = ask("sales this week", { sales: { events, truncated: true }, latestSynced: events[1]! });
    expect(a.sales!.totals.sales).toBe(1);
    expect(a.sales!.uncounted).toEqual({ eventIds: ["c2"], systems: ["clover"] });
    expect(a.notes).toEqual([
      "1 sale event in the period could not be counted (raw data cleared or unreadable), so the figures are a floor: [event c2; clover].",
      `The period had more than ${ASK_MAX_EVENTS} sale events; only the first ${ASK_MAX_EVENTS} were counted, so the figures are a floor.`,
    ]);
    expect(a.text).toContain("could not be counted");
    expect(a.facts.flatMap((f) => f.citation.eventIds)).not.toContain("c2");
  });

  it("tells a quiet period from one before anything synced, citing the record that shows sales were syncing", () => {
    const earlier = sale("old", "shopify", "2026-11-02T15:00:00.000Z", 1_000);
    const quiet = ask("sales yesterday", { sales: { events: [], truncated: false }, lastSaleBefore: earlier, latestSynced: earlier });
    expect(quiet).toMatchObject({ status: "answered", facts: [] });
    expect(quiet.text).toBe("No sales or refunds dated yesterday (2026-11-19) have synced. Sales were syncing before it: the latest earlier sale is event old from shopify at 2026-11-02T15:00:00.000Z.");

    const later = sale("new", "square", "2026-11-19T15:00:00.000Z", 1_000);
    const before = ask("sales last month", { sales: { events: [], truncated: false }, lastSaleBefore: null, latestSynced: later });
    expect(before).toMatchObject({ status: "no_data", facts: [] });
    expect(before.text).toBe("Nothing has synced for last month (2026-10-01 to 2026-10-31) yet: the sales this instance has all come after it (the latest is event new from square at 2026-11-19T15:00:00.000Z).");
  });

  it("says nothing has synced, with no zeros, on an empty instance", () => {
    for (const extra of [{}, { sales: { events: [], truncated: false }, lastSaleBefore: null, latestSynced: null }]) {
      const a = ask("What sold this week?", extra);
      expect(a.status).toBe("no_data");
      expect(a.facts).toEqual([]);
      expect(a.sales).toBeUndefined();
      expect(a.text).toMatch(/^Nothing has synced for that yet/);
      expect(a.text).not.toMatch(/\$0|\b0 sales/);
    }
  });
});

describe("answerQuestion: findings", () => {
  const events = [
    stored("p1", "stripe", "payout.updated", "2026-11-10T12:00:00.000Z", {}),
    stored("p2", "klarna", "payout.updated", "2026-11-11T12:00:00.000Z", {}),
    stored("p3", "klarna", "balance.transaction_recorded", "2026-11-11T12:00:00.000Z", {}),
    stored("s1", "katana", "inventory.counted", "2026-11-19T12:00:00.000Z", {}),
    stored("s2", "cin7", "inventory.counted", "2026-11-19T12:00:00.000Z", {}),
    stored("s3", "square", "inventory.received", "2026-11-01T12:00:00.000Z", {}),
    stored("m1", "twilio", "communication.message_logged", "2026-11-18T15:00:00.000Z", {}),
    stored("m2", "quo", "communication.call_logged", "2026-11-18T16:00:00.000Z", {}),
  ];
  const eventSources = Object.fromEntries(events.map((e) => [e.id, e.source]));
  const recommendations = [
    rec("rec_finance_payout_pending_stripe:payout:po_1_2026-11-20", ["p1"], { summary: "Stripe payout po_1 of $200.00 is pending." }),
    rec("rec_finance_payout_short_klarna:payout:K1_2026-11-20", ["p2", "p3"], { impact: impact(4_500), summary: "Klarna payout K1 paid $45.00 short." }),
    rec("rec_finance_payout_late_klarna_USD_2026-11-20", ["p3"], { impact: impact(1_000), summary: "1 Klarna sale is late." }),
    rec("rec_inventory_stock_mismatch_r1_2026-11-20", ["s1", "s2"], { summary: "Stock counts for R-1 disagree." }),
    rec("rec_inventory_reorder_R2_2026-11-20", ["s3"], { impact: impact(30_000), summary: "Reorder R2." }),
    rec("rec_clienteling_awaiting_reply_others_2026-11-20", ["m1"], { summary: "1 customer has waited." }),
    rec("rec_clienteling_missed_calls_2026-11-20", ["m2"], { summary: "1 caller wasn't called back." }),
    rec("rec_sales_returns_x_2026-11-20", ["m1"], { impact: impact(99_000), summary: "Returns are high." }),
  ];
  const full = (extra: Partial<AskData> = {}): Partial<AskData> => ({ recommendations, feedback: [], eventSources, latestSynced: events[0]!, ...extra });

  it("lists late, short and pending payouts by kind, each citing its events and systems", () => {
    const a = ask("Which payouts are late?", full());
    expect(a).toMatchObject({ intent: "payouts", status: "answered", moreFindings: 0 });
    expect(a.findings.map((f) => [f.kind, f.systems])).toEqual([
      ["short", ["klarna"]],
      ["late", ["klarna"]],
      ["pending", ["stripe"]],
    ]);
    expectCited(a, events);
    expect(a.facts[0]).toEqual({ label: "payout findings open", value: 3, unit: "count", citation: { eventIds: ["p2", "p3", "p1"], systems: ["klarna", "stripe"] } });
    expect(a.facts.slice(1).map((f) => [f.label, f.value])).toEqual([
      ["rec_finance_payout_short_klarna:payout:K1_2026-11-20: protects", 4_500],
      ["rec_finance_payout_late_klarna_USD_2026-11-20: protects", 1_000],
    ]);
    expect(a.text.split("\n")).toEqual([
      "3 payout findings are open [events p2, p3, p1; klarna, stripe]:",
      "Paid out late:",
      "- 1 Klarna sale is late. (protects about $10.00) [event p3; klarna] {rec_finance_payout_late_klarna_USD_2026-11-20}",
      "Paid short:",
      "- Klarna payout K1 paid $45.00 short. (protects about $45.00) [events p2, p3; klarna] {rec_finance_payout_short_klarna:payout:K1_2026-11-20}",
      "Still pending:",
      "- Stripe payout po_1 of $200.00 is pending. [event p1; stripe] {rec_finance_payout_pending_stripe:payout:po_1_2026-11-20}",
    ]);
  });

  it("lists low stock and counts that disagree", () => {
    const a = ask("What's low on stock?", full());
    expect(a.findings.map((f) => [f.kind, f.recommendationId, f.systems])).toEqual([
      ["low", "rec_inventory_reorder_R2_2026-11-20", ["square"]],
      ["disagree", "rec_inventory_stock_mismatch_r1_2026-11-20", ["cin7", "katana"]],
    ]);
    expectCited(a, events);
    expect(a.text).toContain("Low on stock:\n- Reorder R2.");
    expect(a.text).toContain("Counts that disagree:\n- Stock counts for R-1 disagree. [events s1, s2; cin7, katana]");
  });

  it("lists customers waiting on a reply and missed calls", () => {
    const a = ask("Who is waiting on a reply?", full());
    expect(a.findings.map((f) => [f.kind, f.systems])).toEqual([
      ["awaiting_reply", ["twilio"]],
      ["missed_calls", ["quo"]],
    ]);
    expectCited(a, events);
    expect(a.text).toMatch(/^2 waiting-customer findings are open \[events m1, m2; quo, twilio\]:/);
  });

  it("doesn't group a list of one kind under a heading", () => {
    const a = ask("Who is waiting on a reply?", full({ recommendations: [recommendations[5]!] }));
    expect(a.text.split("\n")).toEqual(["1 waiting-customer finding is open [event m1; twilio]:", "- 1 customer has waited. [event m1; twilio] {rec_clienteling_awaiting_reply_others_2026-11-20}"]);
  });

  it("lists every open recommendation, highest impact first, up to the cap", () => {
    const a = ask("What's waiting on me?", full());
    expect(a.findings.map((f) => f.recommendationId)[0]).toBe("rec_sales_returns_x_2026-11-20");
    expect(a.findings).toHaveLength(recommendations.length);
    expect(a.findings.every((f) => f.kind === undefined)).toBe(true);
    expect(a.text).toMatch(/^8 recommendations are open \[.*\], highest dollar impact first:/);
    expectCited(a, events);

    const many = Array.from({ length: ASK_FINDINGS_SHOWN + 3 }, (_, i) => rec(`rec_repairs_r${i}_2026-11-20`, ["m1"], { impact: impact(100 * (i + 1)) }));
    const capped = ask("what's waiting on me", full({ recommendations: many }));
    expect(capped.findings).toHaveLength(ASK_FINDINGS_SHOWN);
    expect(capped.moreFindings).toBe(3);
    expect(capped.findings[0]!.recommendationId).toBe(`rec_repairs_r${ASK_FINDINGS_SHOWN + 2}_2026-11-20`);
    expect(capped.text).toContain("and 3 more.");
    expect(capped.facts[0]).toMatchObject({ label: "open recommendations", value: ASK_FINDINGS_SHOWN + 3 });
    // Dollar figures are cited only for the findings listed.
    expect(capped.facts).toHaveLength(1 + ASK_FINDINGS_SHOWN + 3);
  });

  it("leaves out answered findings and lists a finding raised on several days once, by its latest raising", () => {
    const older = rec("rec_finance_payout_pending_stripe:payout:po_1_2026-11-19", ["p1"], { createdAt: "2026-11-19T14:00:00.000Z" });
    const feedback: Feedback[] = [{ recommendationId: recommendations[1]!.id, organizationId: ORG, outcome: "accepted", actor: "owner", recordedAt: NOW.toISOString() }];
    const a = ask("which payouts are late", full({ recommendations: [older, ...recommendations], feedback }));
    expect(a.findings.map((f) => f.recommendationId)).toEqual(["rec_finance_payout_late_klarna_USD_2026-11-20", "rec_finance_payout_pending_stripe:payout:po_1_2026-11-20"]);
    expect(openFindingsFor("payouts", [older], [])).toEqual([expect.objectContaining({ kind: "pending" })]);
  });

  it("says when a finding's systems couldn't all be looked up, still listing its events", () => {
    const a = ask("which payouts are late", full({ eventSources: { p1: "stripe" } }));
    expect(a.findings.find((f) => f.kind === "short")!.systems).toEqual([]);
    expect(a.notes).toEqual(["For 2 findings the system behind some of its events couldn't be looked up; the event ids are still listed."]);
    // A figure whose events' systems are unknown isn't stated as a cited fact.
    expect(a.facts.map((f) => f.label)).toEqual(["payout findings open"]);
    expect(a.facts[0]!.citation.systems).toEqual(["stripe"]);
    expect(a.text).toContain("[events p2, p3; system unknown]");
  });

  it("says a finding question isn't narrowed by a period", () => {
    const a = ask("which payouts were late last week?", full());
    expect(a.period).toMatchObject({ fromDay: "2026-11-09" });
    expect(a.notes).toEqual(["Findings are what is open now, as of the latest reasoning run; the period asked about (last week (2026-11-09 to 2026-11-15)) doesn't narrow them."]);
  });

  it("answers none open from the record it rests on, and nothing synced when there is none", () => {
    for (const [q, none, empty] of [
      ["which payouts are late?", "No payouts are open as late, short, missing, failed or stuck pending.", "Nothing has synced for that yet: no payouts, settlements or charges have come into this instance from a payment processor."],
      ["what's low on stock?", "Nothing is open as low on stock, and no stock counts are open as disagreeing between systems.", "Nothing has synced for that yet: no stock counts, receipts or listings have come into this instance."],
      ["who is waiting on a reply?", "Nobody is open as waiting on a reply or a call back.", "Nothing has synced for that yet: no messages or calls have come into this instance."],
    ] as const) {
      const synced = ask(q, { recommendations: [recommendations[7]!], feedback: [], latestSynced: events[3]! });
      expect(synced, q).toMatchObject({ status: "answered", findings: [], facts: [] });
      expect(synced.text, q).toBe(`${none} This is as of the latest reasoning run over what has synced; the latest record it could use is event s1 from katana at 2026-11-19T12:00:00.000Z.`);
      const nothing = ask(q, {});
      expect(nothing, q).toMatchObject({ status: "no_data", findings: [], facts: [], text: empty });
    }
  });

  it("tells no recommendations from all of them answered", () => {
    expect(ask("what's waiting on me", {})).toMatchObject({ status: "no_data", text: "Nothing has been raised for that yet: no recommendations in the last 14 days." });
    const feedback: Feedback[] = recommendations.map((r) => ({ recommendationId: r.id, organizationId: ORG, outcome: "rejected", actor: "owner", recordedAt: NOW.toISOString() }));
    expect(ask("what's waiting on me", { recommendations, feedback })).toMatchObject({ status: "answered", facts: [], text: "Nothing is waiting on you: every recommendation raised in the last 14 days has been answered." });
  });

  it("names the event types each finding answer rests on", () => {
    expect(ASK_EVENT_TYPES.payouts).toContain("payout.updated");
    expect(ASK_EVENT_TYPES.stock).toContain("inventory.counted");
    expect(ASK_EVENT_TYPES.awaiting_reply).toEqual(["communication.message_logged", "communication.call_logged"]);
    expect(ASK_EVENT_TYPES.sales).toEqual(["sale.completed", "sale.returned"]);
  });
});

describe("answerQuestion: sync health", () => {
  const ok = (id: string, finishedAt = "2026-11-20T14:00:00.000Z") => ({ id, outcome: "succeeded" as const, finishedAt });

  it("lists connectors with a problem and those syncing normally", () => {
    const a = ask("Is everything syncing?", {
      sync: { scheduled: ["shopify", "stripe", "square", "katana"], statuses: [ok("shopify"), { id: "stripe", outcome: "failed", finishedAt: "2026-11-20T13:00:00.000Z", error: "401" }, ok("square", "2026-11-18T10:00:00.000Z")], skipped: [{ id: "gmail", reason: "missing GMAIL_TOKEN" }] },
    });
    expect(a.status).toBe("answered");
    expect(a.text.split("\n")).toEqual([
      "These connectors have a problem:",
      "- stripe last sync failed: 401 (2026-11-20T13:00:00.000Z).",
      "- square last synced 53 hours ago (2026-11-18T10:00:00.000Z).",
      "- katana has not finished a sync since the instance started.",
      "- gmail turned on but not syncing: missing GMAIL_TOKEN.",
      "Syncing normally: shopify.",
    ]);
    expect(a.sync).toMatchObject({ known: true, healthy: ["shopify"] });
  });

  it("says when every connector is fine, when none is set up and when it can't tell", () => {
    expect(ask("sync health", { sync: { scheduled: ["shopify"], statuses: [ok("shopify")], skipped: [] } }).text).toBe("Every scheduled connector's last sync succeeded within the last day.");
    expect(ask("sync health", { sync: { scheduled: [], statuses: [], skipped: [] } })).toMatchObject({ status: "no_data", text: "Nothing has synced for that yet: no connectors are set up to sync on this instance." });
    expect(ask("sync health", {})).toMatchObject({ status: "no_data", text: "Sync results aren't available to this instance's answers, so I can't say how syncing is going." });
    expect(ask("did anything sync yesterday?", { sync: { scheduled: ["shopify"], statuses: [ok("shopify")], skipped: [] } }).notes).toEqual([
      "Sync health is as it stands now; the period asked about (yesterday (2026-11-19)) doesn't change it.",
    ]);
  });
});

describe("answerQuestion: questions it can't answer", () => {
  it("says it can't answer yet and lists what it can", () => {
    const a = ask("What's the weather like?", { recommendations: [rec("rec_x_y_2026-11-20", ["e"])] });
    expect(a).toMatchObject({ intent: null, status: "unsupported", facts: [], findings: [], canAnswer: ASK_QUESTIONS });
    expect(a.text).toMatch(/^I can't answer that yet\. I can answer questions like these/);
    for (const q of ASK_QUESTIONS) expect(a.text).toContain(`"${q.example}"`);
  });

  it("says what was wrong with a period, with nothing answered", () => {
    const a = ask("sales on 2026-02-30");
    expect(a).toMatchObject({ intent: null, status: "unclear_period", facts: [] });
    expect(a.text).toBe(
      'I couldn\'t read the period in that question: 2026-02-30 isn\'t a day on the calendar. Try "today", "yesterday", "this week", "last week", "last 7 days", "this month", "last month", or dates such as 2026-11-01 to 2026-11-15.',
    );
  });

  it("answers only from the route it is given", () => {
    const route: AskRoute = { kind: "intent", intent: "stock" };
    expect(answerQuestion("anything", route, data()).intent).toBe("stock");
  });
});
