import { BrainPipeline, InMemoryStore, type Recommendation } from "@karatos/core";
import { describe, expect, it } from "vitest";
import {
  AWAITING_REPLY_RULE,
  awaitingReplyReasoner,
  businessHoursBetween,
  combineDepartments,
  configureDepartments,
  DEFAULT_STORE_HOURS,
  describeStoreHours,
  formatStoreHours,
  parseClosedDates,
  parseStoreHours,
  RETAIL_DEPARTMENTS,
  selectDepartments,
  STORE_HOURS,
  StoreHoursError,
  storeHours,
  type RetailSettings,
} from "../src/index.js";

/** A store's own hours: STORE_HOURS, STORE_CLOSED_DATES and the awaiting-reply rule that counts them. */

const NY = "America/New_York";
const day = (open: string, close: string) => {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  return { open: m(open), close: m(close) };
};
const TEN_TO_SIX = [day("10:00", "18:00")];

describe("STORE_HOURS", () => {
  it("reads the default as Monday to Saturday, 10:00 to 18:00", () => {
    expect(DEFAULT_STORE_HOURS).toBe("mon-sat 10:00-18:00; sun closed");
    expect(parseStoreHours(DEFAULT_STORE_HOURS)).toEqual([[], TEN_TO_SIX, TEN_TO_SIX, TEN_TO_SIX, TEN_TO_SIX, TEN_TO_SIX, TEN_TO_SIX]);
    expect(STORE_HOURS).toEqual({ timeZone: NY, week: parseStoreHours(DEFAULT_STORE_HOURS), closedDates: [] });
  });

  it("reads day ranges, lists of days, closed days and days left out", () => {
    const sat = [day("10:00", "17:00")];
    expect(parseStoreHours("mon-fri 10:00-18:00; sat 10:00-17:00; sun closed")).toEqual([[], TEN_TO_SIX, TEN_TO_SIX, TEN_TO_SIX, TEN_TO_SIX, TEN_TO_SIX, sat]);
    // Days no entry names are closed.
    expect(parseStoreHours("mon, wed, fri-sat 10:00-18:00")).toEqual([[], TEN_TO_SIX, [], TEN_TO_SIX, [], TEN_TO_SIX, TEN_TO_SIX]);
    expect(parseStoreHours("fri-sun 12:00-16:00")[0]).toEqual([day("12:00", "16:00")]);
    expect(parseStoreHours("mon-mon 10:00-18:00")).toEqual([[], TEN_TO_SIX, [], [], [], [], []]);
    expect(parseStoreHours("sun 10:00-18:00")).toEqual([TEN_TO_SIX, [], [], [], [], [], []]);
  });

  it("reads more than one range on a day, in any order, touching but not overlapping", () => {
    const split = [day("10:00", "13:00"), day("14:00", "19:00")];
    expect(parseStoreHours("tue-sat 10:00-13:00, 14:00-19:00")).toEqual([[], [], split, split, split, split, split]);
    expect(parseStoreHours("mon 14:00-19:00,10:00-13:00")[1]).toEqual(split);
    expect(parseStoreHours("mon 10:00-13:00, 13:00-18:00")[1]).toEqual([day("10:00", "13:00"), day("13:00", "18:00")]);
  });

  it("takes midnight at either end, the quarter hours and single-digit hours", () => {
    expect(parseStoreHours("sat 00:00-24:00")[6]).toEqual([{ open: 0, close: 1440 }]);
    expect(parseStoreHours("sat 9:15-17:45")[6]).toEqual([{ open: 555, close: 1065 }]);
    expect(parseStoreHours("sat 09:30-23:45")[6]).toEqual([{ open: 570, close: 1425 }]);
  });

  it("ignores case, extra spaces and empty entries, and takes full day names", () => {
    expect(parseStoreHours("  MON - Fri   10:00 - 18:00 ;; Saturday 10:00-17:00 ;  SUN  Closed ; ")).toEqual(parseStoreHours("mon-fri 10:00-18:00; sat 10:00-17:00; sun closed"));
    expect(parseStoreHours("monday-saturday 10:00-18:00")).toEqual(parseStoreHours(DEFAULT_STORE_HOURS));
    expect(parseStoreHours("mon\t10:00-18:00")[1]).toEqual(TEN_TO_SIX);
  });

  it.each([
    ["", /give days and hours, e\.g\. mon-sat 10:00-18:00; sun closed/],
    [" ; ;", /give days and hours/],
    ["tues 10:00-18:00", /^"tues" in "tues 10:00-18:00" isn't a day; use mon, tue, wed, thu, fri, sat or sun$/],
    ["mon-fry 10:00-18:00", /"fry" in "mon-fry 10:00-18:00" isn't a day/],
    ["mon/tue 10:00-18:00", /"mon\/tue" in "mon\/tue 10:00-18:00" isn't a day or a range of days, such as mon-fri/],
    ["mon, 10:00-18:00", /"" in "mon, 10:00-18:00" isn't a day or a range of days/],
    ["sat-mon 10:00-18:00", /"sat-mon" in "sat-mon 10:00-18:00" runs backwards; days run from mon to sun, so split it, e\.g\. sat-sun, mon/],
    ["mon-fri", /"mon-fri" has no hours; give days then hours/],
    ["mon-fri 10:00-18:00; sat", /"sat" has no hours/],
    ["10:00-18:00", /"10:00-18:00" has no days/],
    ["closed", /"closed" has no days/],
    ["mon 10:00", /"10:00" in "mon 10:00" isn't a range of hours; use 24-hour times such as 10:00-18:00, or closed/],
    ["mon 10am-6pm", /"10am-6pm" in "mon 10am-6pm" isn't a range of hours/],
    ["mon 10:00-18:00 daily", /"10:00-18:00 daily" in "mon 10:00-18:00 daily" isn't a range of hours/],
    ["mon 10:00-18:00,", /"" in "mon 10:00-18:00," isn't a range of hours/],
    ["mon 25:00-26:00", /"25:00" in "mon 25:00-26:00" isn't a time; use 24-hour times from 00:00 to 24:00/],
    ["mon 10:00-18:60", /"18:60" in "mon 10:00-18:60" isn't a time/],
    ["mon 10:00-24:15", /"24:15" in "mon 10:00-24:15" isn't a time/],
    ["mon 10:10-18:00", /"10:10" in "mon 10:10-18:00" isn't on the quarter hour; use :00, :15, :30 or :45/],
    ["mon 10:00-17:59", /"17:59" in "mon 10:00-17:59" isn't on the quarter hour/],
    ["mon 24:00-24:00", /"24:00-24:00" in "mon 24:00-24:00" opens at 24:00; use 00:00/],
    ["fri 22:00-02:00", /"22:00-02:00" in "fri 22:00-02:00" runs past midnight; split it at midnight, e\.g\. fri 22:00-24:00; sat 00:00-02:00/],
    ["mon 10:00-10:00", /"10:00-10:00" in "mon 10:00-10:00" opens and closes at the same time/],
    ["mon 10:00-14:00, 13:00-18:00", /the hours in "mon 10:00-14:00, 13:00-18:00" overlap; give each time once/],
    ["mon 10:00-18:00, 12:00-13:00", /overlap/],
    ["mon-fri 10:00-18:00; fri 10:00-14:00", /^fri is given more than once$/],
    ["mon closed 10:00-18:00", /"mon closed" in "mon closed 10:00-18:00" isn't a day or a range of days/],
    ["sun closedish; mon 10:00-18:00", /"sun closedish" has no hours/],
    ["tues    10:00-18:00", /^"tues" in "tues 10:00-18:00" isn't a day/],
    ["mon\t10:00-13:00,\t12:00-18:00", /^the hours in "mon 10:00-13:00, 12:00-18:00" overlap/],
    ["mon, mon 10:00-18:00", /^mon is given more than once$/],
    ["sun closed", /the store is never open; give at least one day's hours/],
    ["mon-sun closed", /never open/],
  ])("rejects %j, naming what is wrong", (text, message) => {
    expect(() => parseStoreHours(text)).toThrow(StoreHoursError);
    expect(() => parseStoreHours(text)).toThrow(message);
  });

  it("writes a week back in the same form, Monday first, with matching days run together", () => {
    expect(formatStoreHours(STORE_HOURS.week)).toBe("mon-sat 10:00-18:00; sun closed");
    for (const text of ["mon-fri 10:00-18:00; sat 10:00-17:00; sun closed", "mon-sun 00:00-24:00", "mon closed; tue-sat 09:15-13:00, 14:00-19:45; sun closed"]) {
      expect(formatStoreHours(parseStoreHours(text))).toBe(text);
    }
    expect(formatStoreHours(parseStoreHours("SAT 10:00-17:00; Mon, Wed 10:00-18:00"))).toBe("mon 10:00-18:00; tue closed; wed 10:00-18:00; thu-fri closed; sat 10:00-17:00; sun closed");
    expect(formatStoreHours(parseStoreHours("sun 10:00-12:00"))).toBe("mon-sat closed; sun 10:00-12:00");
  });

  it("describes the hours by day for the support status", () => {
    expect(describeStoreHours(storeHours("America/Chicago", "mon-fri 10:00-13:00, 14:00-18:00; sat 10:00-17:00", "2026-12-25,2026-11-26"))).toEqual({
      timeZone: "America/Chicago",
      hours: "mon-fri 10:00-13:00, 14:00-18:00; sat 10:00-17:00; sun closed",
      week: {
        mon: ["10:00-13:00", "14:00-18:00"],
        tue: ["10:00-13:00", "14:00-18:00"],
        wed: ["10:00-13:00", "14:00-18:00"],
        thu: ["10:00-13:00", "14:00-18:00"],
        fri: ["10:00-13:00", "14:00-18:00"],
        sat: ["10:00-17:00"],
        sun: [],
      },
      closedDates: ["2026-11-26", "2026-12-25"],
    });
    expect(Object.keys(describeStoreHours(STORE_HOURS).week)).toEqual(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
  });
});

describe("STORE_CLOSED_DATES", () => {
  it("reads real dates, sorted, once each", () => {
    expect(parseClosedDates("")).toEqual([]);
    expect(parseClosedDates(" , ")).toEqual([]);
    expect(parseClosedDates("2026-12-25, 2026-11-26 ,2026-12-25,2028-02-29")).toEqual(["2026-11-26", "2026-12-25", "2028-02-29"]);
  });

  it.each(["2026-02-30", "2027-02-29", "2026-13-01", "2026-00-10", "2026-1-1", "12/25/2026", "2026-12-25T00:00", "Christmas"])("rejects %j", (text) => {
    expect(() => parseClosedDates(`2026-11-26, ${text}`)).toThrow(StoreHoursError);
    expect(() => parseClosedDates(text)).toThrow(`"${text}" isn't a date; use YYYY-MM-DD, e.g. 2026-12-25`);
  });

  it("builds the hours from all three settings, defaulting the week", () => {
    expect(storeHours(NY)).toEqual(STORE_HOURS);
    expect(storeHours("Europe/London", "sat 10:00-16:00", "2026-12-26")).toEqual({ timeZone: "Europe/London", week: [[], [], [], [], [], [], [day("10:00", "16:00")]], closedDates: ["2026-12-26"] });
    expect(() => storeHours(NY, "mon 9-5")).toThrow(/"9-5" in "mon 9-5"/);
    expect(() => storeHours(NY, DEFAULT_STORE_HOURS, "tomorrow")).toThrow(/"tomorrow" isn't a date/);
  });
});

describe("open hours between two times", () => {
  it("counts a store's own week, with shorter Saturdays and closed days", () => {
    const hours = storeHours(NY, "mon-fri 10:00-18:00; sat 10:00-17:00; sun closed");
    // Saturday 2026-11-21, 10:00 to 18:00 New York (15:00 to 23:00 UTC): open until 17:00.
    expect(businessHoursBetween("2026-11-21T15:00:00.000Z", "2026-11-21T23:00:00.000Z", hours)).toBe(7);
    expect(businessHoursBetween("2026-11-21T15:00:00.000Z", "2026-11-21T23:00:00.000Z")).toBe(8);
    // Saturday 16:00 to Monday 11:00: an hour on Saturday, none on Sunday, an hour on Monday.
    expect(businessHoursBetween("2026-11-21T21:00:00.000Z", "2026-11-23T16:00:00.000Z", hours)).toBe(2);
    // Open Tuesday to Saturday: Saturday 17:00 to Tuesday 11:00 skips Sunday and Monday.
    const tueSat = storeHours(NY, "tue-sat 10:00-18:00");
    expect(businessHoursBetween("2026-11-21T22:00:00.000Z", "2026-11-24T16:00:00.000Z", tueSat)).toBe(2);
    expect(businessHoursBetween("2026-11-23T15:00:00.000Z", "2026-11-23T23:00:00.000Z", tueSat)).toBe(0);
  });

  it("counts only the open ranges of a split day", () => {
    const lunch = storeHours(NY, "mon-sat 10:00-13:00, 14:00-18:00");
    // Wednesday 2026-11-18, 10:00 to 18:00 New York.
    expect(businessHoursBetween("2026-11-18T15:00:00.000Z", "2026-11-18T23:00:00.000Z", lunch)).toBe(7);
    // 13:00 to 14:00 is lunch.
    expect(businessHoursBetween("2026-11-18T18:00:00.000Z", "2026-11-18T19:00:00.000Z", lunch)).toBe(0);
    // 12:30 to 14:30: half an hour each side of lunch.
    expect(businessHoursBetween("2026-11-18T17:30:00.000Z", "2026-11-18T19:30:00.000Z", lunch)).toBe(1);
  });

  it("counts a closed date as shut all day, on the store's own calendar", () => {
    const thanksgiving = storeHours(NY, DEFAULT_STORE_HOURS, "2026-11-26");
    // Wednesday 2026-11-25 17:00 to Friday 11:00 New York: an hour each side of the holiday.
    expect(businessHoursBetween("2026-11-25T22:00:00.000Z", "2026-11-27T16:00:00.000Z", thanksgiving)).toBe(2);
    expect(businessHoursBetween("2026-11-25T22:00:00.000Z", "2026-11-27T16:00:00.000Z")).toBe(10);
    expect(businessHoursBetween("2026-11-26T15:00:00.000Z", "2026-11-26T23:00:00.000Z", thanksgiving)).toBe(0);
    // Several dates, and one on a day the week already closes.
    const season = storeHours(NY, DEFAULT_STORE_HOURS, "2026-11-29,2026-11-26,2026-11-27");
    expect(businessHoursBetween("2026-11-25T22:00:00.000Z", "2026-11-28T16:00:00.000Z", season)).toBe(2);
    // Los Angeles is eight hours behind: 17:00 on the 26th there is 01:00 UTC on the 27th, still the holiday.
    const la = storeHours("America/Los_Angeles", "mon-sun 10:00-18:00", "2026-11-26");
    expect(businessHoursBetween("2026-11-27T01:00:00.000Z", "2026-11-27T02:00:00.000Z", la)).toBe(0);
    expect(businessHoursBetween("2026-11-27T01:00:00.000Z", "2026-11-27T02:00:00.000Z", storeHours("America/Los_Angeles", "mon-sun 10:00-18:00", "2026-11-27"))).toBe(1);
    // 10:00 on the 27th in Los Angeles is 18:00 UTC: the 27th is open.
    expect(businessHoursBetween("2026-11-27T18:00:00.000Z", "2026-11-27T19:00:00.000Z", la)).toBe(1);
  });

  it("keeps the store's hours on its clock across both clock changes", () => {
    const always = storeHours(NY, "mon-sun 00:00-24:00");
    // Sunday 2026-03-08 is 23 hours long in New York, and Sunday 2026-11-01 is 25.
    expect(businessHoursBetween("2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", always)).toBe(23);
    expect(businessHoursBetween("2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", always)).toBe(25);
    // 10:00 is 15:00 UTC before the spring change and 14:00 UTC after it.
    const week = storeHours(NY, "mon-fri 10:00-18:00");
    expect(businessHoursBetween("2026-03-06T14:00:00.000Z", "2026-03-06T15:00:00.000Z", week)).toBe(0);
    expect(businessHoursBetween("2026-03-09T14:00:00.000Z", "2026-03-09T15:00:00.000Z", week)).toBe(1);
    // Friday 17:00 EST to Monday 11:00 EDT: an hour each side of the weekend the clocks change.
    expect(businessHoursBetween("2026-03-06T22:00:00.000Z", "2026-03-09T15:00:00.000Z", week)).toBe(2);
    // Hours that start at 02:00 on the spring Sunday: that hour is skipped, so the store opens at 03:00 EDT.
    expect(businessHoursBetween("2026-03-08T05:00:00.000Z", "2026-03-08T09:00:00.000Z", storeHours(NY, "sun 02:00-04:00"))).toBe(1);
  });

  it("takes a zone outside the US, with its own clock change", () => {
    // London leaves summer time on Sunday 2026-10-25: 09:00 is 08:00 UTC before it and 09:00 UTC after.
    const london = storeHours("Europe/London", "mon-sat 09:00-17:30");
    expect(businessHoursBetween("2026-10-24T08:00:00.000Z", "2026-10-24T16:30:00.000Z", london)).toBe(8.5);
    expect(businessHoursBetween("2026-10-26T08:00:00.000Z", "2026-10-26T09:00:00.000Z", london)).toBe(0);
    expect(businessHoursBetween("2026-10-26T09:00:00.000Z", "2026-10-26T17:30:00.000Z", london)).toBe(8.5);
    // Sydney, a day ahead of UTC: Monday 2026-11-23 10:00 there is Sunday 23:00 UTC.
    const sydney = storeHours("Australia/Sydney", "mon 10:00-11:00");
    expect(businessHoursBetween("2026-11-22T23:00:00.000Z", "2026-11-23T00:00:00.000Z", sydney)).toBe(1);
    expect(businessHoursBetween("2026-11-23T23:00:00.000Z", "2026-11-24T00:00:00.000Z", sydney)).toBe(0);
  });
});

describe("the awaiting-reply rule with the store's hours", () => {
  const ORG = "hours-test";
  const PHONE = "form_customer:hoursphone";

  /** The rule as an instance's settings build it, run over one unanswered text sent at `sentAt`. */
  async function waiting(settings: RetailSettings, sentAt: string, now: string): Promise<Recommendation[]> {
    const memory = new InMemoryStore();
    const departments = selectDepartments([], settings);
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(departments), documentation: { current: () => ({ documentIds: [], stale: false }) }, now: () => new Date(now) });
    await pipeline.ingest({
      id: "evt_quo_1",
      organizationId: ORG,
      source: "quo",
      type: "communication.message_logged",
      occurredAt: sentAt,
      receivedAt: sentAt,
      idempotencyKey: "quo:1",
      payload: { system: "Quo", channel: "sms", messageId: "quo:message:1", direction: "inbound", customerRefs: [PHONE] },
    });
    const rule = combineDepartments(departments).reasoners.find((r) => r.name === AWAITING_REPLY_RULE)!;
    return rule.reason({ organizationId: ORG, signals: await memory.recentSignals(ORG, 100), documentation: { documentIds: [], stale: false }, now });
  }

  // Wednesday 2026-11-18, 16:00 in New York and 13:00 in Los Angeles; the rule runs at 17:00 in Los Angeles.
  const SENT = "2026-11-18T21:00:00.000Z";
  const NOW = "2026-11-19T01:00:00.000Z";
  const LA = storeHours("America/Los_Angeles", "mon-fri 10:00-18:00; sat 10:00-17:00; sun closed");

  it("leaves the default hours as they were when nothing is set", async () => {
    // Two hours in New York's default 10 to 6, short of four.
    expect(await waiting({}, SENT, NOW)).toEqual([]);
    expect(selectDepartments([])).toBe(RETAIL_DEPARTMENTS);
    expect(configureDepartments(RETAIL_DEPARTMENTS)).toBe(RETAIL_DEPARTMENTS);
    // The default rule raises from four hours in New York.
    expect(await waiting({}, "2026-11-18T19:00:00.000Z", "2026-11-18T23:00:00.000Z")).toHaveLength(1);
    expect(await waiting({}, "2026-11-18T19:15:00.000Z", "2026-11-18T23:00:00.000Z")).toEqual([]);
  });

  it("counts the configured hours and threshold", async () => {
    // Four hours on the Los Angeles clock.
    const [rec] = await waiting({ storeHours: LA }, SENT, NOW);
    expect(rec!.summary).toBe(
      "1 customer has waited 4 or more business hours for a reply, with no answer on any channel: 1 on Quo. The longest has waited 4 business hours. Answer them from each inbox, oldest first.",
    );
    expect(await waiting({ storeHours: LA, awaitingReplyHours: 5 }, SENT, NOW)).toEqual([]);
    const [early] = await waiting({ storeHours: LA, awaitingReplyHours: 3 }, SENT, NOW);
    expect(early!.summary).toContain("waited 3 or more business hours");
    expect(early!.summary).toContain("The longest has waited 4 business hours.");
    // The threshold alone, on the default hours: two hours in New York.
    expect(await waiting({ awaitingReplyHours: 2 }, SENT, NOW)).toHaveLength(1);
    expect(await waiting({ awaitingReplyHours: 3 }, SENT, NOW)).toEqual([]);
  });

  it("skips closed dates", async () => {
    // Wednesday 15:00 to Friday 11:00 in Los Angeles, over Thanksgiving: 4 open hours with the holiday, 12 without.
    const sent = "2026-11-25T23:00:00.000Z";
    const now = "2026-11-27T19:00:00.000Z";
    const holiday = storeHours("America/Los_Angeles", "mon-fri 10:00-18:00; sat 10:00-17:00; sun closed", "2026-11-26");
    expect(await waiting({ storeHours: LA, awaitingReplyHours: 5 }, sent, now)).toHaveLength(1);
    expect(await waiting({ storeHours: holiday, awaitingReplyHours: 5 }, sent, now)).toEqual([]);
    expect((await waiting({ storeHours: holiday }, sent, now))[0]!.summary).toContain("The longest has waited 4 business hours.");
  });

  it("replaces only the awaiting-reply rule, in the departments that have it", () => {
    const configured = selectDepartments([], { storeHours: LA });
    expect(configured.map((d) => d.id)).toEqual(RETAIL_DEPARTMENTS.map((d) => d.id));
    RETAIL_DEPARTMENTS.forEach((d, i) => {
      const has = d.reasoners.some((r) => r.name === AWAITING_REPLY_RULE);
      expect(configured[i] === d, d.id).toBe(!has);
      expect(configured[i]!.reasoners.map((r) => r.name)).toEqual(d.reasoners.map((r) => r.name));
      configured[i]!.reasoners.forEach((r, j) => expect(r === d.reasoners[j], r.name).toBe(r.name !== AWAITING_REPLY_RULE));
    });
    expect(RETAIL_DEPARTMENTS.filter((d) => d.reasoners.some((r) => r.name === AWAITING_REPLY_RULE)).map((d) => d.id)).toEqual(["clienteling"]);
    expect(selectDepartments(["sales", "clienteling"], { awaitingReplyHours: 6 }).map((d) => d.id)).toEqual(["sales", "clienteling"]);
    expect(() => selectDepartments(["manufacturing"], { storeHours: LA })).toThrow(/unknown departments: manufacturing/);
  });

  it("rejects a threshold of no time", () => {
    expect(() => awaitingReplyReasoner(STORE_HOURS, 0)).toThrow(/more than 0 hours/);
    expect(() => awaitingReplyReasoner(STORE_HOURS, Number.NaN)).toThrow(/more than 0 hours/);
    expect(awaitingReplyReasoner(STORE_HOURS, 0.25).name).toBe(AWAITING_REPLY_RULE);
  });
});
