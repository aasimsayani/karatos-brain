import { describe, expect, it } from "vitest";
import { sha256Json, type Feedback, type Recommendation, type StoredEvent } from "@karatos/core";
import {
  addDays,
  BRIEF_MAX_EVENTS_PER_DAY,
  BRIEF_STALE_SYNC_HOURS,
  BRIEF_UNUSUAL_RULES,
  BRIEF_WAITING_SHOWN,
  buildDailyBrief,
  byImpact,
  dayBounds,
  findingKey,
  isDay,
  isTimeZone,
  localDay,
  reasoningNote,
  ruleOf,
  salesDay,
  wallClock,
  zonedInstant,
  type BriefFinding,
  type DailyBriefInput,
} from "../src/index.js";

const ORG = "example-jewelers";
const TZ = "America/New_York";
const DATE = "2026-11-18";
const GENERATED = "2026-11-19T12:00:00.000Z";

function stored(id: string, source: string, type: string, occurredAt: string, payload: Record<string, unknown>, cleared = false): StoredEvent {
  return {
    id,
    organizationId: ORG,
    source,
    type,
    occurredAt,
    receivedAt: occurredAt,
    idempotencyKey: `${source}:${id}`,
    payload: cleared ? { cleared: true, at: GENERATED, reason: "retention" } : payload,
    sourceRef: { system: source, recordId: id },
    payloadSha256: sha256Json(payload),
    payloadClearedAt: cleared ? GENERATED : null,
  };
}

const sale = (id: string, source: string, at: string, totalCents: number, channel = "store") =>
  stored(id, source, "sale.completed", at, { saleId: id, channel, totalCents, lines: [{ sku: "R1", quantity: 1, unitPriceCents: totalCents }], payments: [{ method: "card", amountCents: totalCents }] });
const refund = (id: string, source: string, at: string, ...refunds: number[]) =>
  stored(id, source, "sale.returned", at, { saleId: "s", returnId: id, lines: refunds.map((refundCents) => ({ sku: "R1", quantity: 1, refundCents })) });

function rec(id: string, extra: Partial<Recommendation> = {}): Recommendation {
  return {
    id,
    organizationId: ORG,
    summary: `summary of ${id}`,
    confidence: 0.7,
    expectedImpact: "x",
    provenance: { eventIds: [`evt_for_${id}`], signalIds: [`sig_for_${id}`], documentIds: [] },
    degraded: false,
    createdAt: "2026-11-18T14:00:00.000Z",
    ...extra,
  };
}

const impact = (cents: number) => ({ kind: "protects" as const, cents, lowCents: cents, highCents: cents, basis: "b" });

function input(overrides: Partial<DailyBriefInput> = {}): DailyBriefInput {
  return {
    organizationId: ORG,
    date: DATE,
    timeZone: TZ,
    generatedAt: GENERATED,
    day: { events: [], truncated: false },
    lastWeek: { events: [], truncated: false },
    lastSaleBefore: null,
    recommendations: [],
    feedback: [],
    ...overrides,
  };
}

describe("store days and time zones", () => {
  it("runs a store day from local midnight to local midnight", () => {
    expect(dayBounds("2026-11-18", TZ)).toEqual({ from: "2026-11-18T05:00:00.000Z", to: "2026-11-19T05:00:00.000Z" });
    expect(dayBounds("2026-07-04", TZ)).toEqual({ from: "2026-07-04T04:00:00.000Z", to: "2026-07-05T04:00:00.000Z" });
    expect(dayBounds("2026-11-18", "UTC")).toEqual({ from: "2026-11-18T00:00:00.000Z", to: "2026-11-19T00:00:00.000Z" });
    expect(dayBounds("2026-11-18", "Asia/Kolkata")).toEqual({ from: "2026-11-17T18:30:00.000Z", to: "2026-11-18T18:30:00.000Z" });
  });

  it("makes the day the clocks go forward 23 hours and the day they go back 25", () => {
    const spring = dayBounds("2026-03-08", TZ);
    expect(spring).toEqual({ from: "2026-03-08T05:00:00.000Z", to: "2026-03-09T04:00:00.000Z" });
    expect(Date.parse(spring.to) - Date.parse(spring.from)).toBe(23 * 3_600_000);
    const fall = dayBounds("2026-11-01", TZ);
    expect(fall).toEqual({ from: "2026-11-01T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z" });
    expect(Date.parse(fall.to) - Date.parse(fall.from)).toBe(25 * 3_600_000);
  });

  it("finds a local hour across clock changes: the first of a repeated hour, the jump for a skipped one", () => {
    expect(new Date(zonedInstant("2026-11-01", 1, TZ)).toISOString()).toBe("2026-11-01T05:00:00.000Z");
    expect(new Date(zonedInstant("2026-03-08", 2, TZ)).toISOString()).toBe("2026-03-08T07:00:00.000Z");
    expect(new Date(zonedInstant("2026-03-08", 7, TZ)).toISOString()).toBe("2026-03-08T11:00:00.000Z");
    expect(new Date(zonedInstant("2026-03-07", 7, TZ)).toISOString()).toBe("2026-03-07T12:00:00.000Z");
    expect(new Date(zonedInstant("2026-11-01", 7, TZ)).toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(new Date(zonedInstant("2026-10-31", 7, TZ)).toISOString()).toBe("2026-10-31T11:00:00.000Z");
  });

  it("gets clock changes right east of UTC too, where the change falls before the naive hour", () => {
    const berlin = "Europe/Berlin";
    // Clocks jump from 02:00 to 03:00 CET at 01:00 UTC on Mar 29, 2026: 02:00 doesn't exist, the jump is the answer.
    expect(new Date(zonedInstant("2026-03-29", 2, berlin)).toISOString()).toBe("2026-03-29T01:00:00.000Z");
    expect(new Date(zonedInstant("2026-03-29", 7, berlin)).toISOString()).toBe("2026-03-29T05:00:00.000Z");
    // Clocks go back from 03:00 to 02:00 at 01:00 UTC on Oct 25: 02:00 comes twice, the first is the answer.
    expect(new Date(zonedInstant("2026-10-25", 2, berlin)).toISOString()).toBe("2026-10-25T00:00:00.000Z");
    expect(dayBounds("2026-10-25", berlin)).toEqual({ from: "2026-10-24T22:00:00.000Z", to: "2026-10-25T23:00:00.000Z" });
    expect(dayBounds("2026-03-29", berlin)).toEqual({ from: "2026-03-28T23:00:00.000Z", to: "2026-03-29T22:00:00.000Z" });
  });

  it("reads the store's wall clock and day", () => {
    expect(wallClock(Date.parse("2026-11-19T04:30:00Z"), TZ)).toBe("2026-11-18T23:30:00");
    expect(wallClock(Date.parse("2026-11-19T00:00:00Z"), "UTC")).toBe("2026-11-19T00:00:00");
    expect(localDay(Date.parse("2026-11-19T04:59:59Z"), TZ)).toBe("2026-11-18");
    expect(localDay(Date.parse("2026-11-19T05:00:00Z"), TZ)).toBe("2026-11-19");
  });

  it("checks days and zones", () => {
    expect(isDay("2026-11-18")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-11-18T00:00")).toBe(false);
    expect(isDay("yesterday")).toBe(false);
    expect(isTimeZone(TZ)).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone(" ")).toBe(false);
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("buildDailyBrief: sales", () => {
  const day = [
    sale("e1", "shopify", "2026-11-18T15:00:00Z", 120_000, "online"),
    sale("e2", "square", "2026-11-18T18:00:00Z", 45_000, "store"),
    sale("e3", "square", "2026-11-19T04:30:00Z", 5_000, "store"),
    refund("e4", "shopify", "2026-11-18T20:00:00Z", 10_000, 2_500),
  ];
  const lastWeek = [sale("w1", "square", "2026-11-11T16:00:00Z", 30_000, "store"), refund("w2", "square", "2026-11-11T17:00:00Z", 1_000)];

  it("counts sales, gross and refunds by channel and system, against the same day last week, citing every event", () => {
    const brief = buildDailyBrief(input({ day: { events: day, truncated: false }, lastWeek: { events: lastWeek, truncated: false } }));
    expect(brief.hasData).toBe(true);
    const s = brief.sales;
    if (s.status === "no_data") throw new Error("expected sales");
    expect(s.status).toBe("ok");
    expect(s.day.date).toBe(DATE);
    expect(s.day.from).toBe("2026-11-18T05:00:00.000Z");
    expect(s.lastWeek.date).toBe("2026-11-11");
    expect(s.day.totals).toEqual({
      sales: 3,
      grossCents: 170_000,
      refunds: 1,
      refundCents: 12_500,
      netCents: 157_500,
      saleEvents: { eventIds: ["e1", "e2", "e3"], systems: ["shopify", "square"] },
      refundEvents: { eventIds: ["e4"], systems: ["shopify"] },
    });
    expect(s.lastWeek.totals).toMatchObject({ sales: 1, grossCents: 30_000, refunds: 1, refundCents: 1_000, saleEvents: { eventIds: ["w1"], systems: ["square"] }, refundEvents: { eventIds: ["w2"], systems: ["square"] } });
    expect(s.change).toEqual({ sales: 2, grossCents: 140_000, refunds: 0, refundCents: 11_500, netCents: 128_500 });
    expect(s.day.byChannel.map((r) => [r.key, r.sales, r.grossCents, r.refunds, r.refundCents, r.saleEvents.eventIds, r.refundEvents.eventIds])).toEqual([
      ["online", 1, 120_000, 0, 0, ["e1"], []],
      ["store", 2, 50_000, 0, 0, ["e2", "e3"], []],
      ["returns", 0, 0, 1, 12_500, [], ["e4"]],
    ]);
    expect(s.day.bySystem.map((r) => [r.key, r.sales, r.grossCents, r.refunds, r.refundCents, r.saleEvents.systems, r.refundEvents.systems])).toEqual([
      ["shopify", 1, 120_000, 1, 12_500, ["shopify"], ["shopify"]],
      ["square", 2, 50_000, 0, 0, ["square"], []],
    ]);
    expect(s.notes).toEqual([]);
    expect(s.lastSaleBefore).toBeUndefined();
    expect(brief.text).toContain("2026-11-18: 3 sales, $1,700.00 gross [events e1, e2, e3; shopify, square]; 1 refund of $125.00 [event e4; shopify].");
    expect(brief.text).toContain("2026-11-11, same day last week: 1 sale, $300.00 gross [event w1; square]; 1 refund of $10.00 [event w2; square].");
    expect(brief.text).toContain("Change: +2 sales, +$1,400.00 gross, 0 refunds, +$1,285.00 net.");
    expect(brief.text).toContain("By channel: online 1 sale $1,200.00; store 2 sales $500.00; returns 0 sales $0.00, 1 refund $125.00.");
    expect(brief.text).toContain("By system: shopify 1 sale $1,200.00, 1 refund $125.00; square 2 sales $500.00.");
  });

  it("shows a fall as a negative change and abbreviates long citations in the text only", () => {
    const many = Array.from({ length: 5 }, (_, i) => sale(`w${i}`, "square", "2026-11-11T16:00:00Z", 10_000));
    const brief = buildDailyBrief(input({ day: { events: [sale("e1", "square", "2026-11-18T16:00:00Z", 1_000)], truncated: false }, lastWeek: { events: many, truncated: false } }));
    expect(brief.text).toContain("Change: -4 sales, -$490.00 gross, 0 refunds, -$490.00 net.");
    expect(brief.text).toContain("[events w0, w1, w2 and 2 more; square]");
    if (brief.sales.status === "no_data") throw new Error("expected sales");
    expect(brief.sales.lastWeek.totals.saleEvents.eventIds).toHaveLength(5);
  });

  it("treats a sale without a channel as unknown and ignores events that aren't sales", () => {
    const noChannel = stored("e9", "pos", "sale.completed", "2026-11-18T16:00:00Z", { totalCents: 700 });
    const other = stored("e10", "pos", "inventory.counted", "2026-11-18T16:00:00Z", { sku: "R1", onHand: 2 });
    const d = salesDay(DATE, TZ, { events: [noChannel, other], truncated: false });
    expect(d.byChannel.map((r) => r.key)).toEqual(["unknown"]);
    expect(d.totals.sales).toBe(1);
    expect(d.uncounted.eventIds).toEqual([]);
  });

  it("says plainly when no sales have ever synced, instead of showing zeros", () => {
    const brief = buildDailyBrief(input({ sync: { scheduled: [], statuses: [], skipped: [] } }));
    expect(brief.hasData).toBe(false);
    expect(brief.sales).toEqual({ status: "no_data", note: expect.stringContaining("No sales have synced into this instance yet") });
    expect(brief.unusual).toEqual([]);
    expect(brief.waiting).toEqual([]);
    expect(brief.text).toBe(
      "Daily brief for 2026-11-18 (America/New_York)\n\nThis instance has no synced data yet: no sales, no open recommendations and no successful sync. There is nothing to report, so no figures are shown.",
    );
    expect(brief.text).not.toMatch(/\$0|0 sales/);
  });

  it("still names why nothing synced on an empty instance", () => {
    const brief = buildDailyBrief(
      input({ sync: { scheduled: ["shopify"], statuses: [{ id: "shopify", outcome: "failed", finishedAt: "2026-11-19T11:00:00.000Z", error: "HttpError: 401" }], skipped: [{ id: "square", reason: "missing SQUARE_ACCESS_TOKEN" }] } }),
    );
    expect(brief.hasData).toBe(false);
    expect(brief.text).toContain("\n\nSync\n- shopify last sync failed: HttpError: 401 (2026-11-19T11:00:00.000Z).\n- square turned on but not syncing: missing SQUARE_ACCESS_TOKEN.");
  });

  it("calls a quiet day a quiet day when sales have synced before, citing the latest earlier sale", () => {
    const before = sale("old1", "shopify", "2026-11-02T15:00:00Z", 9_000);
    const brief = buildDailyBrief(input({ lastSaleBefore: before }));
    expect(brief.hasData).toBe(true);
    const s = brief.sales;
    if (s.status === "no_data") throw new Error("expected sales");
    expect(s.day.totals.sales).toBe(0);
    expect(s.lastSaleBefore).toEqual({ eventId: "old1", system: "shopify", occurredAt: "2026-11-02T15:00:00Z" });
    expect(s.notes).toEqual([
      "No sales or refunds dated 2026-11-18 have synced. The latest sale before 2026-11-18 is event old1 from shopify at 2026-11-02T15:00:00Z.",
      "No sales or refunds dated 2026-11-11 have synced. The latest sale before 2026-11-18 is event old1 from shopify at 2026-11-02T15:00:00Z.",
    ]);
    expect(brief.text).toContain("2026-11-18: no sales; no refunds.");
  });

  it("notes a quiet day without an earlier sale to cite when only the other day had sales", () => {
    const brief = buildDailyBrief(input({ lastWeek: { events: [sale("w1", "square", "2026-11-11T16:00:00Z", 100)], truncated: false } }));
    if (brief.sales.status === "no_data") throw new Error("expected sales");
    expect(brief.sales.status).toBe("ok");
    expect(brief.sales.notes).toEqual(["No sales or refunds dated 2026-11-18 have synced."]);
  });

  it("marks figures partial when retention cleared some events or the day was too busy to read whole", () => {
    const cleared = stored("c1", "shopify", "sale.completed", "2026-11-11T16:00:00Z", { totalCents: 1 }, true);
    const unreadable = refund("c2", "square", "2026-11-11T16:30:00Z");
    (unreadable.payload.lines as unknown[]).push({ sku: "R1", quantity: 1 });
    const brief = buildDailyBrief(
      input({ day: { events: [sale("e1", "square", "2026-11-18T16:00:00Z", 100)], truncated: true }, lastWeek: { events: [cleared, unreadable], truncated: false } }),
    );
    const s = brief.sales;
    if (s.status === "no_data") throw new Error("expected sales");
    expect(s.status).toBe("partial");
    expect(s.lastWeek.uncounted).toEqual({ eventIds: ["c1", "c2"], systems: ["shopify", "square"] });
    expect(s.lastWeek.totals.sales).toBe(0);
    expect(s.notes).toEqual([
      `2026-11-18 had more than ${BRIEF_MAX_EVENTS_PER_DAY} sale events; only the first ${BRIEF_MAX_EVENTS_PER_DAY} were counted.`,
      "2 sale events on 2026-11-11 could not be counted (raw data cleared or unreadable), so that day's figures are a floor: [events c1, c2; shopify, square].",
    ]);
    expect(s.day.truncated).toBe(true);
  });

  it("never counts an event marked cleared, even if its payload still reads, nor amounts that aren't whole cents", () => {
    const marked = { ...sale("m1", "shopify", "2026-11-18T16:00:00Z", 5_000), payloadClearedAt: GENERATED };
    const negative = sale("m2", "shopify", "2026-11-18T16:00:00Z", -100);
    const fraction = sale("m3", "shopify", "2026-11-18T16:00:00Z", 10.5);
    const text = stored("m4", "shopify", "sale.completed", "2026-11-18T16:00:00Z", { totalCents: "100" });
    const badRefund = refund("m5", "square", "2026-11-18T16:00:00Z", 100, -5);
    const good = sale("m6", "square", "2026-11-18T16:00:00Z", 700);
    const d = salesDay(DATE, TZ, { events: [marked, negative, fraction, text, badRefund, good], truncated: false });
    expect(d.uncounted).toEqual({ eventIds: ["m1", "m2", "m3", "m4", "m5"], systems: ["shopify", "square"] });
    expect(d.totals).toMatchObject({ sales: 1, grossCents: 700, refunds: 0, refundCents: 0 });
  });

  it("cites the latest earlier sale when only last week was quiet", () => {
    const before = sale("old1", "shopify", "2026-11-17T15:00:00Z", 9_000);
    const brief = buildDailyBrief(input({ day: { events: [sale("e1", "square", "2026-11-18T16:00:00Z", 100)], truncated: false }, lastSaleBefore: before }));
    if (brief.sales.status === "no_data") throw new Error("expected sales");
    expect(brief.sales.lastSaleBefore).toEqual({ eventId: "old1", system: "shopify", occurredAt: "2026-11-17T15:00:00Z" });
    expect(brief.sales.notes).toEqual(["No sales or refunds dated 2026-11-11 have synced. The latest sale before 2026-11-18 is event old1 from shopify at 2026-11-17T15:00:00Z."]);
    const both = buildDailyBrief(input({ day: { events: [sale("e1", "square", "2026-11-18T16:00:00Z", 100)], truncated: false }, lastWeek: { events: [sale("w1", "square", "2026-11-11T16:00:00Z", 100)], truncated: false }, lastSaleBefore: before }));
    if (both.sales.status === "no_data") throw new Error("expected sales");
    expect(both.sales.lastSaleBefore).toBeUndefined();
  });

  it("counts a day of only uncountable events as seen, not as no data", () => {
    const cleared = stored("c1", "shopify", "sale.returned", "2026-11-18T16:00:00Z", {}, true);
    const brief = buildDailyBrief(input({ day: { events: [cleared], truncated: false } }));
    expect(brief.sales.status).toBe("partial");
    if (brief.sales.status === "no_data") throw new Error("expected sales");
    expect(brief.sales.notes[0]).toBe("1 sale event on 2026-11-18 could not be counted (raw data cleared or unreadable), so that day's figures are a floor: [event c1; shopify].");
  });

  it("rejects days and zones that aren't real", () => {
    expect(() => buildDailyBrief(input({ date: "2026-13-01" }))).toThrow(/YYYY-MM-DD/);
    expect(() => buildDailyBrief(input({ timeZone: "Nowhere/Land" }))).toThrow(/IANA/);
  });
});

describe("buildDailyBrief: unusual and waiting", () => {
  it("calls out open findings of the payout, stock and reply rules, highest impact first, with their provenance", () => {
    const recommendations = [
      rec("rec_finance_payout_short_po_1_2026-11-18", { impact: impact(50_000) }),
      rec("rec_inventory_stock_mismatch_r1_2026-11-18", { impact: impact(90_000), degraded: true }),
      rec("rec_clienteling_awaiting_reply_c1_2026-11-18"),
      rec("rec_sales_returns_R1_2026-11-18", { impact: impact(1_000) }),
      rec("rec_repairs_follow_up_t1_2026-11-18", { impact: impact(20_000) }),
    ];
    const brief = buildDailyBrief(input({ recommendations }));
    expect(brief.hasData).toBe(true);
    expect(brief.unusual.map((f) => [f.recommendationId, f.rule])).toEqual([
      ["rec_inventory_stock_mismatch_r1_2026-11-18", "inventory.stock-agreement"],
      ["rec_finance_payout_short_po_1_2026-11-18", "finance.payout-match"],
      ["rec_sales_returns_R1_2026-11-18", "sales.high-return-rate"],
      ["rec_clienteling_awaiting_reply_c1_2026-11-18", "clienteling.awaiting-reply"],
    ]);
    expect(brief.unusual[0]).toEqual({
      recommendationId: "rec_inventory_stock_mismatch_r1_2026-11-18",
      rule: "inventory.stock-agreement",
      summary: "summary of rec_inventory_stock_mismatch_r1_2026-11-18",
      confidence: 0.7,
      impact: impact(90_000),
      createdAt: "2026-11-18T14:00:00.000Z",
      eventIds: ["evt_for_rec_inventory_stock_mismatch_r1_2026-11-18"],
      signalIds: ["sig_for_rec_inventory_stock_mismatch_r1_2026-11-18"],
      degraded: true,
    });
    expect(brief.waiting.map((f) => f.recommendationId)).toEqual(["rec_repairs_follow_up_t1_2026-11-18"]);
    expect(brief.waiting[0]!.rule).toBeUndefined();
    expect(brief.text).toContain(
      "- summary of rec_inventory_stock_mismatch_r1_2026-11-18 (protects about $900.00) <inventory.stock-agreement> [event evt_for_rec_inventory_stock_mismatch_r1_2026-11-18] {rec_inventory_stock_mismatch_r1_2026-11-18}",
    );
    expect(brief.text).toContain("- summary of rec_clienteling_awaiting_reply_c1_2026-11-18 <clienteling.awaiting-reply> [event evt_for_rec_clienteling_awaiting_reply_c1_2026-11-18]");
  });

  it("drops findings someone answered, and lists a finding raised on several days once, by its latest raising", () => {
    const recommendations = [
      rec("rec_repairs_follow_up_t1_2026-11-16", { createdAt: "2026-11-16T14:00:00.000Z" }),
      rec("rec_repairs_follow_up_t1_2026-11-18", { createdAt: "2026-11-18T14:00:00.000Z" }),
      rec("rec_finance_cash_gap_2026-11-17", { createdAt: "2026-11-17T14:00:00.000Z" }),
      rec("rec_finance_cash_gap_2026-11-18", { createdAt: "2026-11-18T14:00:00.000Z" }),
      rec("rec_marketing_x_2026-11-18", { createdAt: "2026-11-18T14:00:00.000Z", provenance: { eventIds: [], signalIds: [], documentIds: [] } }),
    ];
    const feedback: Feedback[] = [{ recommendationId: "rec_finance_cash_gap_2026-11-18", organizationId: ORG, outcome: "rejected", actor: "owner", recordedAt: GENERATED }];
    const brief = buildDailyBrief(input({ recommendations: [...recommendations].reverse(), feedback }));
    expect(brief.waiting.map((f) => f.recommendationId)).toEqual(["rec_marketing_x_2026-11-18", "rec_repairs_follow_up_t1_2026-11-18"]);
    expect(brief.text).toContain("- summary of rec_marketing_x_2026-11-18 {rec_marketing_x_2026-11-18}");
  });

  it("keeps the later id when one finding is raised twice at the same moment", () => {
    const at = "2026-11-18T14:00:00.000Z";
    const brief = buildDailyBrief(input({ recommendations: [rec("rec_a_k_2026-11-19", { createdAt: at }), rec("rec_a_k_2026-11-18", { createdAt: at })] }));
    expect(brief.waiting.map((f) => f.recommendationId)).toEqual(["rec_a_k_2026-11-19"]);
    const flipped = buildDailyBrief(input({ recommendations: [rec("rec_a_k_2026-11-18", { createdAt: at }), rec("rec_a_k_2026-11-19", { createdAt: at })] }));
    expect(flipped.waiting.map((f) => f.recommendationId)).toEqual(["rec_a_k_2026-11-19"]);
  });

  it("lists at most BRIEF_WAITING_SHOWN waiting and counts the rest", () => {
    const recommendations = Array.from({ length: BRIEF_WAITING_SHOWN + 3 }, (_, i) => rec(`rec_repairs_t${String(i).padStart(2, "0")}_2026-11-18`, { impact: impact((i + 1) * 100) }));
    const brief = buildDailyBrief(input({ recommendations }));
    expect(brief.waiting).toHaveLength(BRIEF_WAITING_SHOWN);
    expect(brief.waiting[0]!.impact!.cents).toBe((BRIEF_WAITING_SHOWN + 3) * 100);
    expect(brief.moreWaiting).toBe(3);
    expect(brief.text).toContain("and 3 more.");
  });

  it("orders by impact, then confidence, then newest, then id", () => {
    const f = (id: string, extra: Partial<BriefFinding>): BriefFinding => ({ recommendationId: id, summary: "", confidence: 0.5, createdAt: "2026-11-18T00:00:00.000Z", eventIds: [], signalIds: [], degraded: false, ...extra });
    const list = [
      f("d", {}),
      f("c", {}),
      f("b", { confidence: 0.9 }),
      f("e", { createdAt: "2026-11-18T01:00:00.000Z" }),
      f("a", { impact: impact(0) }),
      f("z", { impact: impact(5) }),
    ];
    expect([...list].sort(byImpact).map((x) => x.recommendationId)).toEqual(["z", "a", "b", "e", "c", "d"]);
  });

  it("knows each rule by the ids it raises", () => {
    expect(BRIEF_UNUSUAL_RULES.map((r) => r.rule)).toEqual(["finance.payout-match", "inventory.stock-agreement", "clienteling.awaiting-reply", "sales.high-return-rate"]);
    expect(ruleOf("rec_finance_payout_missing_stripe_2026-11-18")).toBe("finance.payout-match");
    expect(ruleOf("rec_finance_cash_gap_2026-11-18")).toBeUndefined();
    expect(findingKey("rec_finance_payout_missing_stripe_2026-11-18")).toBe("rec_finance_payout_missing_stripe");
    expect(findingKey("rec_custom")).toBe("rec_custom");
  });
});

describe("buildDailyBrief: sync", () => {
  const at = (hoursBefore: number) => new Date(Date.parse(GENERATED) - hoursBefore * 3_600_000).toISOString();

  it("names failed, stale, not-yet-run and skipped connectors, and the healthy ones", () => {
    const brief = buildDailyBrief(
      input({
        sync: {
          scheduled: ["stripe", "shopify", "square", "lightspeed", "stripe"],
          statuses: [
            { id: "shopify", outcome: "failed", finishedAt: at(1), error: "HttpError: 503" },
            { id: "square", outcome: "succeeded", finishedAt: at(BRIEF_STALE_SYNC_HOURS + 2) },
            { id: "stripe", outcome: "succeeded", finishedAt: at(BRIEF_STALE_SYNC_HOURS) },
          ],
          skipped: [{ id: "clover", reason: "missing CLOVER_API_TOKEN" }],
        },
      }),
    );
    expect(brief.sync).toEqual({
      known: true,
      checkedAt: GENERATED,
      healthy: ["stripe"],
      problems: [
        { system: "shopify", problem: "failed", detail: "last sync failed: HttpError: 503", at: at(1) },
        { system: "square", problem: "stale", detail: `last synced ${BRIEF_STALE_SYNC_HOURS + 2} hours ago`, at: at(BRIEF_STALE_SYNC_HOURS + 2) },
        { system: "lightspeed", problem: "not_run", detail: "has not finished a sync since the instance started" },
        { system: "clover", problem: "not_syncing", detail: "turned on but not syncing: missing CLOVER_API_TOKEN" },
      ],
    });
    expect(brief.hasData).toBe(true);
    expect(brief.text).toContain("Unusual\n- shopify last sync failed: HttpError: 503 (2026-11-19T11:00:00.000Z).\n- square last synced 26 hours ago");
    expect(brief.text).toContain("- lightspeed has not finished a sync since the instance started.");
  });

  it("counts a merely stale connector as having synced, and a failure without a message plainly", () => {
    const stale = buildDailyBrief(input({ sync: { scheduled: ["square"], statuses: [{ id: "square", outcome: "succeeded", finishedAt: at(48) }], skipped: [] } }));
    expect(stale.hasData).toBe(true);
    expect(stale.text).toContain("No sales have synced into this instance yet");
    const failed = buildDailyBrief(input({ sync: { scheduled: ["square"], statuses: [{ id: "square", outcome: "failed", finishedAt: at(1) }], skipped: [] } }));
    expect(failed.hasData).toBe(false);
    expect(failed.sync.known && failed.sync.problems[0]!.detail).toBe("last sync failed");
  });

  it("says when it doesn't know how syncing went, and when nothing is unusual", () => {
    const withRec = buildDailyBrief(input({ recommendations: [rec("rec_repairs_t1_2026-11-18")] }));
    expect(withRec.sync).toEqual({ known: false, note: "Sync results aren't available to this brief." });
    expect(withRec.text).toContain("Unusual\nNothing unusual from the department rules. Sync results aren't available to this brief.");
    const healthy = buildDailyBrief(input({ recommendations: [rec("rec_repairs_t1_2026-11-18")], sync: { scheduled: ["square"], statuses: [{ id: "square", outcome: "succeeded", finishedAt: at(1) }], skipped: [] } }));
    expect(healthy.text).toContain("Unusual\nNothing unusual.\n");
    const none = buildDailyBrief(input({ sync: { scheduled: ["square"], statuses: [{ id: "square", outcome: "succeeded", finishedAt: at(1) }], skipped: [] } }));
    expect(none.text).toContain("Waiting on you\nNo open recommendations.");
  });
});

describe("buildDailyBrief: when findings were last refreshed", () => {
  const at = (hoursBefore: number) => new Date(Date.parse(GENERATED) - hoursBefore * 3_600_000).toISOString();
  const sync = (reasoning: NonNullable<DailyBriefInput["sync"]>["reasoning"]) =>
    input({ recommendations: [rec("rec_repairs_t1_2026-11-18")], sync: { scheduled: ["square"], statuses: [{ id: "square", outcome: "succeeded", finishedAt: at(1) }], skipped: [], ...(reasoning ? { reasoning } : {}) } });

  it("says when the last scheduled run refreshed the findings, last in the brief", () => {
    const brief = buildDailyBrief(sync({ scheduled: true, last: { outcome: "succeeded", finishedAt: at(2) }, refreshedAt: at(2) }));
    expect(brief.sync).toMatchObject({ known: true, reasoning: { status: "fresh", refreshedAt: at(2), detail: `Findings were last refreshed at ${at(2)}.` } });
    expect(brief.text.endsWith(`\n\nFindings were last refreshed at ${at(2)}.`)).toBe(true);
    // Sync health is unchanged by it.
    expect(brief.text).toContain("Unusual\nNothing unusual.\n");
  });

  it("rounds a stale refresh down to whole hours, and takes a successful last run as the latest refresh", () => {
    const old = at(BRIEF_STALE_SYNC_HOURS + 3.5);
    expect(reasoningNote({ scheduled: true, last: { outcome: "succeeded", finishedAt: old }, refreshedAt: null }, GENERATED)).toEqual({
      status: "stale",
      refreshedAt: old,
      detail: `Findings were last refreshed ${BRIEF_STALE_SYNC_HOURS + 3} hours ago (${old}), so they may be out of date.`,
    });
    expect(reasoningNote({ scheduled: true, last: { outcome: "succeeded", finishedAt: at(1) }, refreshedAt: at(5) }, GENERATED)).toMatchObject({ status: "fresh", refreshedAt: at(1) });
  });

  it("calls findings refreshed more than a day ago stale, and exactly a day ago fresh", () => {
    const stale = reasoningNote({ scheduled: true, last: { outcome: "succeeded", finishedAt: at(BRIEF_STALE_SYNC_HOURS + 3) }, refreshedAt: at(BRIEF_STALE_SYNC_HOURS + 3) }, GENERATED);
    expect(stale).toEqual({
      status: "stale",
      refreshedAt: at(BRIEF_STALE_SYNC_HOURS + 3),
      detail: `Findings were last refreshed ${BRIEF_STALE_SYNC_HOURS + 3} hours ago (${at(BRIEF_STALE_SYNC_HOURS + 3)}), so they may be out of date.`,
    });
    expect(reasoningNote({ scheduled: true, last: { outcome: "succeeded", finishedAt: at(BRIEF_STALE_SYNC_HOURS) }, refreshedAt: at(BRIEF_STALE_SYNC_HOURS) }, GENERATED).status).toBe("fresh");
  });

  it("names a failed last run, with the last refresh or none", () => {
    expect(reasoningNote({ scheduled: true, last: { outcome: "failed", finishedAt: at(1) }, refreshedAt: at(3) }, GENERATED)).toEqual({
      status: "failed",
      refreshedAt: at(3),
      detail: `The last reasoning run failed (${at(1)}); findings were last refreshed at ${at(3)}.`,
    });
    expect(reasoningNote({ scheduled: true, last: { outcome: "failed", finishedAt: at(1) }, refreshedAt: null }, GENERATED)).toEqual({
      status: "failed",
      refreshedAt: null,
      detail: `The last reasoning run failed (${at(1)}); no reasoning run has succeeded since the instance started, so findings may be out of date.`,
    });
  });

  it("says when reasoning hasn't run yet, and when scheduled reasoning is off", () => {
    expect(reasoningNote({ scheduled: true, last: null, refreshedAt: null }, GENERATED)).toEqual({
      status: "not_run",
      refreshedAt: null,
      detail: "Reasoning hasn't finished a run since the instance started, so findings may be out of date.",
    });
    const off = buildDailyBrief(sync({ scheduled: false, last: null, refreshedAt: null }));
    expect(off.sync).toMatchObject({ reasoning: { status: "off", refreshedAt: null } });
    expect(off.text).toContain("\n\nScheduled reasoning is off on this instance, so findings are only as fresh as the last POST /v1/reason call.");
  });

  it("leaves it out when the server doesn't report reasoning, and on an instance with nothing to report", () => {
    const unknown = buildDailyBrief(sync(undefined));
    expect(unknown.sync.known && "reasoning" in unknown.sync).toBe(false);
    expect(unknown.text).not.toContain("Findings were");
    const empty = buildDailyBrief(input({ sync: { scheduled: [], statuses: [], skipped: [], reasoning: { scheduled: true, last: null, refreshedAt: null } } }));
    expect(empty.hasData).toBe(false);
    expect(empty.text).not.toContain("Reasoning hasn't");
  });
});
