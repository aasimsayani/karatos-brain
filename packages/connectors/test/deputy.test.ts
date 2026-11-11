import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import {
  TEST_ORG,
  assertWritesRefused,
  checkConnectorSync,
  deputyArea,
  deputyCompany,
  deputyDocMock,
  deputyEmployee,
  deputyLeave,
  deputyRoster,
  deputyTimesheet,
  testPipeline,
  type DeputyMock,
  type DeputyMockData,
  type DeputyMockRecord,
} from "@karatos/connector-testkit";
import {
  DEPUTY_EVENTS,
  DEPUTY_OBJECTS,
  DEPUTY_OVERLAP_MS,
  DEPUTY_PAGE_SIZE,
  DEPUTY_WRITES,
  DeputyApiError,
  DeputyConfigError,
  deputyCents,
  deputyClient,
  deputyConnector,
  deputyDay,
  deputyEvent,
  deputyInstall,
  deputyRef,
  deputyTime,
  deputyUnix,
  parseDeputyCursor,
  type DeputyClient,
  type DeputyEvent,
  type DeputyOptions,
  type DeputyQuery,
} from "../src/index.js";

// A token-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = ["dp", "0".repeat(32)].join("_");
const INSTALL = "example.na.deputy.com";
const API = `https://${INSTALL}`;
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const DAY_MS = 86_400_000;
const noSleep = async () => {};

/** Day `n` of 2026 as Deputy writes a Date, at a US Central offset. */
const dayOf = (iso: string) => `${iso.slice(0, 10)}T00:00:00-06:00`;
/** An ISO time `ago` days before NOW, as Deputy writes Modified. */
const ago = (days: number) => new Date(NOW().getTime() - days * DAY_MS).toISOString().replace(".000Z", "+00:00");

/** One location, two areas, three team members, and a shift, timesheet and leave 10 days, 400 days and four years ago. */
function install(overrides: Partial<DeputyMockData> = {}): DeputyMockData {
  for (const b of [deputyCompany, deputyArea, deputyEmployee, deputyRoster, deputyTimesheet, deputyLeave]) b.reset();
  const dated = (b: typeof deputyRoster, d: number) => b.one({ Date: dayOf(ago(d)), Modified: ago(d - 1) });
  return {
    token: TOKEN,
    records: {
      Company: [deputyCompany.one({ Modified: ago(300) })],
      OperationalUnit: deputyArea.many(2, () => ({ Modified: ago(300) })),
      Employee: deputyEmployee.many(3, () => ({ Modified: ago(200) })),
      Roster: [10, 400, 1460].map((d) => dated(deputyRoster, d)),
      Timesheet: [10, 400, 1460].map((d) => dated(deputyTimesheet, d)),
      Leave: [10, 400, 1460].map((d) => deputyLeave.one({ DateStart: ago(d + 1).slice(0, 10), DateEnd: ago(d).slice(0, 10), Modified: ago(d + 5) })),
    },
    ...overrides,
  };
}

const connector = (mock: DeputyMock, overrides: Partial<DeputyOptions> = {}) => deputyConnector({ accessToken: TOKEN, install: INSTALL, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as DeputyEvent[];

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers in turn and records what was sent. */
function scripted(...answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body });
    return answers[Math.min(sent.length - 1, answers.length - 1)]!();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const text = (status: number, body: string) => () => new Response(body, { status });
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof deputyClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = deputyClient({ accessToken: TOKEN, install: INSTALL, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const ALL: DeputyQuery = { object: "Employee", start: 0 };

describe("Deputy client", () => {
  it("checks its token and install before sending anything", () => {
    const { fetch, sent } = scripted(json(200, []));
    const make = (o: Partial<Parameters<typeof deputyClient>[0]>) => () => deputyClient({ accessToken: TOKEN, install: INSTALL, fetch, ...o });
    for (const accessToken of ["", "   ", "x".repeat(15), "has a space in it ok", "x".repeat(513), "token!with!marks!", undefined as never]) expect(make({ accessToken }), String(accessToken)).toThrow(new DeputyConfigError("DEPUTY_ACCESS_TOKEN is missing or not in the expected shape"));
    expect(make({ accessToken: "x".repeat(16) })).not.toThrow();
    expect(make({ accessToken: `${"Az09._~+/=-".repeat(46)}x` })).not.toThrow();
    expect(make({ accessToken: ` ${TOKEN} ` })).not.toThrow();
    for (const install of ["", "example.deputy.com", "example.us.deputy.com", "example.na.deputy.com.example", "a.example.na.deputy.com", "-x.na.deputy.com", "ex_ample.na.deputy.com", `${"a".repeat(64)}.na.deputy.com`, "http://example.na.deputy.com", "example.na.deputy.com/path", undefined as never])
      expect(make({ install }), String(install)).toThrow(new DeputyConfigError("DEPUTY_INSTALL must be the install's host, like example.na.deputy.com"));
    expect(make({ install: `${"a".repeat(63)}.uk.deputy.com` })).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("reads an install written as a host or a URL", () => {
    expect(deputyInstall(" https://Example-1.AU.deputy.com/ ")).toBe("example-1.au.deputy.com");
    for (const geo of ["au", "eu", "na", "uk"]) expect(deputyInstall(`x.${geo}.deputy.com`), geo).toBe(`x.${geo}.deputy.com`);
    expect(deputyInstall("https://x.na.deputy.com//")).toBeNull();
    expect(deputyInstall("xhttps://x.na.deputy.com")).toBeNull();
    expect(deputyClient({ accessToken: TOKEN, install: "https://Example.EU.deputy.com/" }).baseUrl).toBe("https://example.eu.deputy.com");
  });

  it("searches one record type in Id order, 500 to a page, with the token", async () => {
    const { fetch, sent } = scripted(json(200, [{ Id: 1 }]));
    const { c } = client(fetch);
    expect(c.baseUrl).toBe(API);
    expect(await c.query({ object: "Timesheet", since: { field: "Date", value: "2023-11-11" }, start: 1000 })).toEqual({ records: [{ Id: 1 }], more: false });
    expect(sent[0]!.url).toBe(`${API}/api/v1/resource/Timesheet/QUERY`);
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.headers).toEqual({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json" });
    expect(JSON.parse(String(sent[0]!.body))).toEqual({ sort: { Id: "asc" }, start: 1000, max: 500, search: { s1: { field: "Date", data: "2023-11-11", type: "ge" } } });
    await c.query(ALL);
    expect(JSON.parse(String(sent[1]!.body))).toEqual({ sort: { Id: "asc" }, start: 0, max: 500 });
    await c.query({ object: "Leave", since: { field: "Modified", value: "2026-11-11T14:00:00+00:00" }, start: 0 });
    expect(JSON.parse(String(sent[2]!.body)).search).toEqual({ s1: { field: "Modified", data: "2026-11-11T14:00:00+00:00", type: "ge" } });
    expect(DEPUTY_OBJECTS).toEqual(["Company", "OperationalUnit", "Employee", "Roster", "Timesheet", "Leave"]);
    expect(DEPUTY_PAGE_SIZE).toBe(500);
  });

  it("says more may follow only after a full page", async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ Id: i + 1 }));
    expect((await client(scripted(json(200, rows(500))).fetch).c.query(ALL)).more).toBe(true);
    expect((await client(scripted(json(200, rows(499))).fetch).c.query(ALL)).more).toBe(false);
    expect((await client(scripted(json(200, [])).fetch).c.query(ALL)).more).toBe(false);
  });

  it("checks what it is asked for before sending", async () => {
    const { fetch, sent } = scripted(json(200, []));
    const { c } = client(fetch);
    for (const object of ["Memo", "Webhook", "Roster/1", "toString"]) await expect(c.query({ object: object as never, start: 0 }), object).rejects.toThrow(new DeputyApiError("the client reads only the records the connector uses", 0));
    for (const start of [-1, 1.5, Number.NaN]) await expect(c.query({ ...ALL, start }), String(start)).rejects.toThrow("start must be a whole number, 0 or more");
    for (const value of ["2026-11-11T14:00:00Z", "2026-11-11T14:00:00-06:00", "2026-11-11 ", " 2026-11-11", "2026-11-11T14:00:00+00:00x", "x2026-11-11", "yesterday"]) await expect(c.query({ ...ALL, since: { field: "Modified", value } }), value).rejects.toThrow("a search must start from a day or a UTC time");
    expect(sent).toHaveLength(0);
  });

  it("says when Deputy turns down the token, never repeating Deputy's words", async () => {
    for (const status of [401, 403]) {
      const err = await client(scripted(json(status, { error: { message: "secret detail" } })).fetch).c.query(ALL).catch((e: Error) => e);
      expect(err).toBeInstanceOf(DeputyConfigError);
      expect((err as Error).message).toBe(`Deputy turned down DEPUTY_ACCESS_TOKEN for Employee (HTTP ${status})`);
    }
    const err = (await client(scripted(json(400, { error: { message: "secret detail" } })).fetch).c.query(ALL).catch((e: Error) => e)) as DeputyApiError;
    expect(err).toBeInstanceOf(DeputyApiError);
    expect(err.message).toBe("Deputy answered HTTP 400 for Employee");
    expect(err.status).toBe(400);
    expect(err.name).toBe("DeputyApiError");
    expect(new DeputyConfigError("x").name).toBe("DeputyConfigError");
    await expect(client(scripted(json(201, [])).fetch).c.query(ALL)).rejects.toThrow("Deputy answered HTTP 201 for Employee");
  });

  it("says when an answer isn't a list of records", async () => {
    for (const answer of [text(200, "not json"), json(200, null), json(200, {}), json(200, { data: [] }), json(200, "x")]) {
      const err = (await client(scripted(answer).fetch).c.query(ALL).catch((e: Error) => e)) as DeputyApiError;
      expect(err.message).toBe("Deputy answered without a list of Employee records");
      expect(err.status).toBe(200);
    }
  });

  it("waits out rate limits and server errors, honoring Retry-After up to a minute, then gives up", async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const { fetch, sent } = scripted(json(status, {}, { "retry-after": "2" }), json(200, [{ Id: 1 }]));
      const { c, slept } = client(fetch);
      expect((await c.query(ALL)).records).toHaveLength(1);
      expect(sent).toHaveLength(2);
      expect(slept, String(status)).toEqual([2000]);
    }
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "600" }), json(429, {}), json(429, {}, { "retry-after": "0" }), json(429, {}, { "retry-after": "soon" }));
    const { c, slept } = client(fetch);
    await expect(c.query(ALL)).rejects.toThrow("Deputy answered HTTP 429 for Employee");
    expect(sent).toHaveLength(4);
    expect(slept).toEqual([60_000, 2000, 4000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    for (const status of [400, 404, 501]) {
      const { fetch, sent } = scripted(json(status, {}), json(200, []));
      await expect(client(fetch).c.query(ALL)).rejects.toThrow(`HTTP ${status}`);
      expect(sent).toHaveLength(1);
    }
    const { fetch, sent } = scripted(json(503, {}));
    await expect(client(fetch, { retries: 1 }).c.query(ALL)).rejects.toThrow("HTTP 503");
    expect(sent).toHaveLength(2);
    const once = scripted(json(503, {}));
    await expect(client(once.fetch, { retries: 0 }).c.query(ALL)).rejects.toThrow("HTTP 503");
    expect(once.sent).toHaveLength(1);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "0.01" }), json(200, []));
    globalThis.fetch = fetch;
    try {
      const started = Date.now();
      await deputyClient({ accessToken: TOKEN, install: INSTALL }).query(ALL);
      expect(Date.now() - started).toBeGreaterThanOrEqual(5);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(2);
  });
});

describe("Deputy reading helpers", () => {
  it("reads Deputy's times and days as UTC", () => {
    expect(deputyTime("2026-03-01T07:52:26-06:00")).toBe("2026-03-01T13:52:26.000Z");
    expect(deputyTime("2026-03-01T07:52:26.123456+10:00")).toBe("2026-02-28T21:52:26.123Z");
    expect(deputyTime("2026-03-01T07:52:26Z")).toBe("2026-03-01T07:52:26.000Z");
    expect(deputyTime("2026-03-01")).toBe("2026-03-01T00:00:00.000Z");
    expect(deputyTime("2028-02-29T23:59:59")).toBe("2028-02-29T23:59:59.000Z");
    expect(deputyTime("2026-03-01T00:00:00.5Z")).toBe("2026-03-01T00:00:00.500Z");
    for (const bad of [undefined, null, 20260301, "", "2026-02-30", "2026-02-29T00:00:00Z", "2026-13-01", "2026-03-01T24:00:00Z", "2026-03-01T23:60:00Z", "2026-03-01T07:52Z", "2026-03-01T07:52:26.1234567Z", "x2026-03-01", "2026-03-01x", "2026-03-01 07:52:26", "2026-03-01T07:52:26+0200"]) expect(deputyTime(bad), String(bad)).toBeUndefined();
  });

  it("reads a time with no zone as UTC wherever the server is", () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/Chicago";
    try {
      expect(deputyTime("2026-03-01T07:52:26")).toBe("2026-03-01T07:52:26.000Z");
      expect(deputyTime("2026-03-01")).toBe("2026-03-01T00:00:00.000Z");
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it("reads a day as the location wrote it, whatever its zone", () => {
    expect(deputyDay("2026-03-01T00:00:00-06:00")).toBe("2026-03-01");
    expect(deputyDay("2026-03-01T00:00:00+10:00")).toBe("2026-03-01");
    expect(deputyDay("2026-03-01")).toBe("2026-03-01");
    for (const bad of [null, 1, "2026-02-30", "March 1"]) expect(deputyDay(bad), String(bad)).toBeNull();
  });

  it("reads Unix seconds from 2000 to 2100", () => {
    expect(deputyUnix(1_772_000_000)).toBe("2026-02-25T06:13:20.000Z");
    expect(deputyUnix(946_684_800)).toBe("2000-01-01T00:00:00.000Z");
    expect(deputyUnix(4_102_444_800)).toBe("2100-01-01T00:00:00.000Z");
    for (const bad of [946_684_799, 4_102_444_801, 1_772_000_000.5, 1_772_000_000_000, "1772000000", null, 0]) expect(deputyUnix(bad), String(bad)).toBeNull();
  });

  it("reads dollars as cents", () => {
    expect(deputyCents(165.25)).toBe(16_525);
    expect(deputyCents("165.25")).toBe(16_525);
    expect(deputyCents(" 0.005 ")).toBe(1);
    expect(deputyCents(-0.005)).toBe(-1);
    expect(deputyCents("-12.5")).toBe(-1_250);
    expect(deputyCents(160)).toBe(16_000);
    expect(deputyCents("999999999999.999999")).toBe(100_000_000_000_000);
    for (const bad of [null, undefined, "", "12.", ".5", "1e3", 1e21, Number.NaN, Number.POSITIVE_INFINITY, "1,000", "$5", "1.1234567", "1234567890123", true]) expect(deputyCents(bad), String(bad)).toBeNull();
  });

  it("makes references", () => {
    expect(deputyRef("timesheet", 7)).toBe("deputy:timesheet:7");
  });
});

describe("Deputy events", () => {
  const ctx = { receivedAt: RECEIVED };
  const one = (b: { reset(): void; one(o?: DeputyMockRecord): DeputyMockRecord }, o: DeputyMockRecord = {}) => {
    b.reset();
    return b.one(o);
  };

  it("names an event type for each record", () => {
    expect(DEPUTY_EVENTS).toEqual({
      Company: "labor.location_updated",
      OperationalUnit: "labor.area_updated",
      Employee: "labor.employee_updated",
      Roster: "labor.shift_updated",
      Timesheet: "labor.timesheet_updated",
      Leave: "labor.leave_updated",
    });
  });

  it("keeps a timesheet's hours, cost and approvals, and not the team member's comment", () => {
    const e = deputyEvent("Timesheet", one(deputyTimesheet), ctx);
    expect(e.type).toBe("labor.timesheet_updated");
    expect(e.occurredAt).toBe("2026-01-03T00:00:00.000Z");
    expect(e.receivedAt).toBe(RECEIVED);
    expect(e.payload).toEqual({
      system: "Deputy",
      timesheetId: "deputy:timesheet:1",
      employeeId: "deputy:employee:1",
      areaId: "deputy:area:1",
      shiftId: "deputy:shift:1",
      date: "2026-01-02",
      startedAt: "2026-01-02T15:00:00.000Z",
      endedAt: "2026-01-02T23:00:00.000Z",
      hours: 7.75,
      costCents: 16_525,
      timeApproved: true,
      payApproved: true,
      inProgress: false,
      discarded: false,
      leaveId: null,
      exported: false,
      paid: false,
      flagged: false,
      modifiedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(e.idempotencyKey).toMatch(/^deputy:timesheet:1:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    expect(JSON.stringify(e)).not.toContain("Stayed late");
  });

  it("reads a timesheet in progress, for leave, flagged, with Deputy's other spelling", () => {
    const p = deputyEvent("Timesheet", one(deputyTimesheet, { IsInProgress: undefined, isInProgress: true, EndTime: null, IsLeave: true, LeaveId: 4, ValidationFlag: 8, Roster: 0, Cost: null, TotalTime: "x" }), ctx).payload;
    expect(p).toMatchObject({ inProgress: true, endedAt: null, leaveId: "deputy:leave:4", flagged: true, shiftId: null, costCents: null, hours: null });
    const q = deputyEvent("Timesheet", one(deputyTimesheet, { IsInProgress: "no", ValidationFlag: "8", TimeApproved: 1, PayStaged: true, Exported: true, Discarded: true }), ctx).payload;
    expect(q).toMatchObject({ inProgress: null, flagged: null, timeApproved: null, paid: true, exported: true, discarded: true });
  });

  it("keeps a shift's plan, and not its comment or warning", () => {
    const e = deputyEvent("Roster", one(deputyRoster, { Warning: "Missing ring sizing training" }), ctx);
    expect(e.type).toBe("labor.shift_updated");
    expect(e.payload).toEqual({
      system: "Deputy",
      shiftId: "deputy:shift:1",
      employeeId: "deputy:employee:1",
      areaId: "deputy:area:1",
      date: "2026-01-02",
      startsAt: "2026-01-02T15:00:00.000Z",
      endsAt: "2026-01-02T23:00:00.000Z",
      hours: 7.5,
      costCents: 16_000,
      published: true,
      open: false,
      confirmation: "confirmed",
      timesheetId: "deputy:timesheet:1",
      modifiedAt: "2026-01-01T00:00:00.000Z",
    });
    const all = JSON.stringify(e);
    for (const hidden of ["bridal", "sizing"]) expect(all, hidden).not.toContain(hidden);
    // An open shift has no team member yet.
    expect(deputyEvent("Roster", one(deputyRoster, { Employee: 0, Open: true }), ctx).payload).toMatchObject({ employeeId: null, open: true });
    for (const [status, word] of [[0, "not_required"], [1, "required"], [2, "confirmed"], [3, "declined"], [9, "unknown"], [-1, "unknown"], [1.5, null], ["2", null]] as const)
      expect(deputyEvent("Roster", one(deputyRoster, { ConfirmStatus: status }), ctx).payload.confirmation, String(status)).toBe(word);
  });

  it("keeps a team member as their ID, never their name or personal details", () => {
    const e = deputyEvent("Employee", one(deputyEmployee), ctx);
    expect(e.type).toBe("labor.employee_updated");
    expect(e.payload).toEqual({ system: "Deputy", employeeId: "deputy:employee:1", locationId: "deputy:location:1", active: true, startDate: "2024-03-01", endDate: null, accessLevel: 50, modifiedAt: "2026-01-01T01:00:00.000Z" });
    const all = JSON.stringify(e);
    for (const hidden of ["Test", "Member", "1990"]) expect(all, hidden).not.toContain(hidden);
    expect(deputyEvent("Employee", one(deputyEmployee, { Active: false, TerminationDate: "2026-06-30", Role: 0 }), ctx).payload).toMatchObject({ active: false, endDate: "2026-06-30", accessLevel: null });
  });

  it("keeps leave's days, hours and status, and not its comments", () => {
    const e = deputyEvent("Leave", one(deputyLeave), ctx);
    expect(e.type).toBe("labor.leave_updated");
    expect(e.payload).toEqual({ system: "Deputy", leaveId: "deputy:leave:1", employeeId: "deputy:employee:1", locationId: "deputy:location:1", leaveRuleId: "deputy:leave_rule:3", startDate: "2026-01-02", endDate: "2026-01-03", days: 2, hours: 15, status: "approved", modifiedAt: "2025-12-24T16:00:00.000Z" });
    const all = JSON.stringify(e);
    for (const hidden of ["Family", "Enjoy"]) expect(all, hidden).not.toContain(hidden);
    const statuses = ["awaiting_approval", "approved", "declined", "cancelled", "date_approved", "pay_approved"];
    for (const [i, word] of statuses.entries()) expect(deputyEvent("Leave", one(deputyLeave, { Status: i }), ctx).payload.status).toBe(word);
    expect(deputyEvent("Leave", one(deputyLeave, { Status: 6 }), ctx).payload.status).toBe("unknown");
    expect(deputyEvent("Leave", one(deputyLeave, { Status: "1" }), ctx).payload.status).toBeNull();
    expect(deputyEvent("Leave", one(deputyLeave, { Days: "0.5", TotalHours: -1 }), ctx).payload).toMatchObject({ days: 0.5, hours: null });
  });

  it("keeps a location and an area", () => {
    const loc = deputyEvent("Company", one(deputyCompany, { ParentCompany: 3, CompanyName: ` ${"S".repeat(120)} `, Code: "C".repeat(50) }), ctx);
    expect(loc.type).toBe("labor.location_updated");
    expect(loc.payload).toEqual({ system: "Deputy", locationId: "deputy:location:1", name: "S".repeat(100), code: "C".repeat(40), active: true, parentLocationId: "deputy:location:3", isWorkplace: true, modifiedAt: "2026-01-01T01:00:00.000Z" });
    const area = deputyEvent("OperationalUnit", one(deputyArea, { Parent: 2, PayrollExportName: "P".repeat(50) }), ctx);
    expect(area.type).toBe("labor.area_updated");
    expect(area.payload).toEqual({ system: "Deputy", areaId: "deputy:area:1", name: "Sales floor", locationId: "deputy:location:1", parentAreaId: "deputy:area:2", active: true, payrollCode: "P".repeat(40), modifiedAt: "2026-01-01T01:00:00.000Z" });
    expect(deputyEvent("OperationalUnit", one(deputyArea, { OperationalUnitName: "  ", Company: "1", Active: "yes" }), ctx).payload).toMatchObject({ name: null, locationId: null, active: null });
  });

  it("reads hours with three decimals at most, and none below zero or absurdly large", () => {
    const hours = (TotalTime: unknown) => deputyEvent("Timesheet", one(deputyTimesheet, { TotalTime }), ctx).payload.hours;
    expect(hours(7.33333)).toBe(7.333);
    expect(hours(" 8.5 ")).toBe(8.5);
    expect(hours(0)).toBe(0);
    expect(hours(999_999.9)).toBe(999_999.9);
    for (const bad of [-0.1, 1e6, "", "8h", null, Number.NaN, Number.POSITIVE_INFINITY]) expect(hours(bad), String(bad)).toBeNull();
  });

  it("dates a record by when it changed, or when it was made", () => {
    expect(deputyEvent("Employee", one(deputyEmployee, { Modified: null }), ctx).occurredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(deputyEvent("Employee", one(deputyEmployee, { Modified: "soon" }), ctx).payload.modifiedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("keys each version by what was kept, so an unchanged one is a duplicate", () => {
    const a = deputyEvent("Timesheet", one(deputyTimesheet), ctx);
    expect(deputyEvent("Timesheet", one(deputyTimesheet), { receivedAt: "2027-01-01T00:00:00.000Z" }).idempotencyKey).toBe(a.idempotencyKey);
    expect(deputyEvent("Timesheet", one(deputyTimesheet, { PayRuleApproved: false }), ctx).idempotencyKey).not.toBe(a.idempotencyKey);
    expect(deputyEvent("Timesheet", one(deputyTimesheet, { EmployeeComment: "other" }), ctx).idempotencyKey).toBe(a.idempotencyKey);
    // The same Id in another record type is another record.
    expect(deputyEvent("Roster", one(deputyRoster), ctx).idempotencyKey).toMatch(/^deputy:shift:1:/);
  });

  it("dead-letters a record that doesn't read, listing why", () => {
    const e = deputyEvent("Timesheet", { Id: 0, Modified: "soon" }, ctx);
    expect(e.occurredAt).toBeUndefined();
    expect(e.type).toBe("labor.timesheet_updated");
    expect(e.payload).toEqual({ system: "Deputy", timesheetId: null, problems: ["timesheet has no ID that reads", "timesheet has no time that reads"] });
    expect(e.idempotencyKey).toMatch(/^deputy:unreadable_timesheet:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    expect(deputyEvent("Leave", { Id: 4 }, ctx).payload).toEqual({ system: "Deputy", leaveId: "deputy:leave:4", problems: ["leave has no time that reads"] });
    for (const Id of [-1, 1.5, "4", Number.MAX_SAFE_INTEGER + 2]) expect(deputyEvent("Company", { Id, Modified: "2026-01-01" }, ctx).payload.problems, String(Id)).toEqual(["location has no ID that reads"]);
    for (const raw of [null, "x", []]) expect(deputyEvent("Employee", raw, ctx).payload.problems, JSON.stringify(raw)).toHaveLength(2);
  });
});

describe("Deputy checkpoint", () => {
  const F = "2023-11-11T00:00:00.000Z";
  const T = "2026-11-11T14:00:00.000Z";
  it("reads a checkpoint it wrote, and turns down anything else", () => {
    expect(parseDeputyCursor(null)).toBeNull();
    for (const object of DEPUTY_OBJECTS) expect(parseDeputyCursor(JSON.stringify({ pass: { object, start: 5 }, done: false, from: F, nextFrom: T }))).toEqual({ pass: { object, start: 5 }, done: false, from: F, nextFrom: T });
    expect(parseDeputyCursor(JSON.stringify({ pass: null, done: true, from: F, nextFrom: T, extra: 1 }))).toEqual({ pass: null, done: true, from: F, nextFrom: T });
    expect(parseDeputyCursor(JSON.stringify({ pass: { object: "Leave", start: 0 }, done: true, from: F, nextFrom: T }))!.pass).toEqual({ object: "Leave", start: 0 });
    for (const bad of [
      "not json",
      "null",
      "[]",
      "3",
      JSON.stringify({ pass: null, done: "yes", from: F, nextFrom: T }),
      JSON.stringify({ pass: null, from: F, nextFrom: T }),
      JSON.stringify({ pass: null, done: true, from: "2023-11-11", nextFrom: T }),
      JSON.stringify({ pass: null, done: true, nextFrom: T }),
      JSON.stringify({ pass: null, done: true, from: F, nextFrom: "2026-11-11T14:00:00Z" }),
      JSON.stringify({ pass: null, done: true, from: F }),
      JSON.stringify({ done: true, from: F, nextFrom: T }),
      JSON.stringify({ pass: "Roster", done: true, from: F, nextFrom: T }),
      JSON.stringify({ pass: [], done: true, from: F, nextFrom: T }),
      JSON.stringify({ pass: { object: "Memo", start: 0 }, done: true, from: F, nextFrom: T }),
      JSON.stringify({ pass: { object: "Roster", start: -1 }, done: true, from: F, nextFrom: T }),
      JSON.stringify({ pass: { object: "Roster", start: 1.5 }, done: true, from: F, nextFrom: T }),
      JSON.stringify({ pass: { object: "Roster", start: "5" }, done: true, from: F, nextFrom: T }),
      JSON.stringify({ pass: { object: "Roster" }, done: true, from: F, nextFrom: T }),
    ])
      expect(() => parseDeputyCursor(bad), bad).toThrow("Deputy checkpoint is not in the expected shape");
  });
});

describe("Deputy connector", () => {
  it("passes the shared connector checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(deputyDocMock(install())), expected: { ingested: 12 } });
    expect(result.full.ingested).toBe(12);
  });

  it("imports the people and places whole, and three years of shifts, timesheets and leave, then stops for good", async () => {
    const mock = deputyDocMock(install());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(12);
    expect(mock.reads).toEqual([
      { object: "Company", body: { sort: { Id: "asc" }, start: 0, max: 500 } },
      { object: "OperationalUnit", body: { sort: { Id: "asc" }, start: 0, max: 500 } },
      { object: "Employee", body: { sort: { Id: "asc" }, start: 0, max: 500 } },
      { object: "Roster", body: { sort: { Id: "asc" }, start: 0, max: 500, search: { s1: { field: "Date", data: "2023-11-11", type: "ge" } } } },
      { object: "Timesheet", body: { sort: { Id: "asc" }, start: 0, max: 500, search: { s1: { field: "Date", data: "2023-11-11", type: "ge" } } } },
      { object: "Leave", body: { sort: { Id: "asc" }, start: 0, max: 500, search: { s1: { field: "DateEnd", data: "2023-11-11", type: "ge" } } } },
    ]);
    expect(parseDeputyCursor(report.cursor)).toEqual({ pass: null, done: true, from: "2023-11-11T00:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested + again.duplicates).toBe(0);
    expect(mock.reads).toHaveLength(6);
  });

  it("makes each page a batch, keeping the record type and how far it has read, and resumes there", async () => {
    deputyTimesheet.reset();
    const data = install();
    data.records.Timesheet = deputyTimesheet.many(DEPUTY_PAGE_SIZE + 3, () => ({ Date: dayOf(ago(5)), Modified: ago(4) }));
    const batches = await drain(connector(deputyDocMock(data)).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([1, 2, 3, 2, 500, 3, 2]);
    const cursors = batches.map((b) => parseDeputyCursor(b.cursor ?? null)!);
    expect(cursors.map((c) => c.pass)).toEqual([
      { object: "OperationalUnit", start: 0 },
      { object: "Employee", start: 0 },
      { object: "Roster", start: 0 },
      { object: "Timesheet", start: 0 },
      { object: "Timesheet", start: 500 },
      { object: "Leave", start: 0 },
      null,
    ]);
    expect(cursors.map((c) => c.done)).toEqual([false, false, false, false, false, false, true]);
    // Resumed a day later, the pass goes on from its page, reading from the same first day and keeping where the next later sync starts.
    const resumed = deputyDocMock(data);
    const rest = await drain(connector(resumed, { now: () => new Date(NOW().getTime() + DAY_MS) }).historicalImport({ cursor: batches[4]!.cursor ?? null } as never));
    expect(rest.map((b) => b.events.length)).toEqual([3, 2]);
    expect(resumed.reads.map((r) => [r.object, r.body.start, (r.body.search as Record<string, Record<string, unknown>>).s1!.data])).toEqual([
      ["Timesheet", 500, "2023-11-11"],
      ["Leave", 0, "2023-11-11"],
    ]);
    expect(parseDeputyCursor(rest.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, from: cursors[0]!.from, nextFrom: cursors[0]!.nextFrom });
    expect(eventsOf(rest).map((e) => e.receivedAt)).toContain("2026-11-12T15:00:00.000Z");
    expect(new Set(eventsOf(batches).map((e) => e.idempotencyKey)).size).toBe(513);
  });

  it("reads what changed since an hour before the last pass on each later sync", async () => {
    const data = install();
    const mock = deputyDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // Each mode keeps its own checkpoint, so the first later sync looks back an hour.
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.slice(6).map((r) => [r.object, r.body.search])).toEqual(DEPUTY_OBJECTS.map((o) => [o, { s1: { field: "Modified", data: "2026-11-11T14:00:00+00:00", type: "ge" } }]));
    expect(first.ingested).toBe(0);
    expect(parseDeputyCursor(first.cursor)).toEqual({ pass: null, done: false, from: "2026-11-11T14:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" });
    expect(DEPUTY_OVERLAP_MS).toBe(3_600_000);
    // A manager approves the pay on last week's timesheet.
    data.records.Timesheet![0]!.PayRuleApproved = false;
    data.records.Timesheet![0]!.Modified = ago(-0.5);
    const later = () => new Date(NOW().getTime() + DAY_MS);
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.at(-1)!.body.search).toEqual({ s1: { field: "Modified", data: "2026-11-11T14:00:00+00:00", type: "ge" } });
    expect(sync.ingested).toBe(1);
    expect(parseDeputyCursor(sync.cursor)).toEqual({ pass: null, done: false, from: "2026-11-11T14:00:00.000Z", nextFrom: "2026-11-12T14:00:00.000Z" });
    // A later sync resumed mid-pass reads from the same time, keeping what it knew of the import.
    const mid = JSON.stringify({ pass: { object: "Timesheet", start: 0 }, done: true, from: "2026-11-01T00:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" });
    const resumed = deputyDocMock(data);
    const rest = await drain(connector(resumed).incrementalSync({ cursor: mid } as never));
    expect(resumed.reads.map((r) => [r.object, (r.body.search as Record<string, Record<string, unknown>>).s1!.data])).toEqual([
      ["Timesheet", "2026-11-01T00:00:00+00:00"],
      ["Leave", "2026-11-01T00:00:00+00:00"],
    ]);
    expect(rest.map((b) => parseDeputyCursor(b.cursor ?? null))).toEqual([
      { pass: { object: "Leave", start: 0 }, done: true, from: "2026-11-01T00:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" },
      { pass: null, done: true, from: "2026-11-01T00:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" },
    ]);
    const midImport = JSON.stringify({ pass: { object: "Leave", start: 0 }, done: false, from: "2026-11-01T00:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" });
    const ended = await drain(connector(deputyDocMock(data)).incrementalSync({ cursor: midImport } as never));
    expect(parseDeputyCursor(ended.at(-1)!.cursor ?? null)!.done).toBe(false);
    // A later sync after the import ended keeps saying so.
    const doneCursor = JSON.stringify({ pass: null, done: true, from: "2026-01-01T00:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" });
    const after = await drain(connector(deputyDocMock(data)).incrementalSync({ cursor: doneCursor } as never));
    expect(parseDeputyCursor(after.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, from: "2026-11-01T00:00:00.000Z", nextFrom: "2026-11-11T14:00:00.000Z" });
    // Last week's shift and the timesheet just approved.
    expect(eventsOf(after)).toHaveLength(2);
  });

  it("dead-letters a record that doesn't read and keeps going", async () => {
    const data = install();
    data.records.Roster![0]!.Id = "seven";
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(deputyDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(11);
    expect(report.deadLettered).toBe(1);
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = deputyDocMock(install({ rateLimits: 2 }));
    const slept: number[] = [];
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { sleep: async (ms) => void slept.push(ms) }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(12);
    expect(slept).toEqual([1000, 1000]);
  });

  it("says when Deputy turns the token down, reading nothing", async () => {
    const mock = deputyDocMock(install({ token: `${TOKEN}1` }));
    await expect(drain(connector(mock).historicalImport({ cursor: null } as never))).rejects.toThrow("Deputy turned down DEPUTY_ACCESS_TOKEN for Company (HTTP 401)");
    expect(mock.reads).toHaveLength(0);
  });

  it("checks its options", async () => {
    const mock = deputyDocMock(install());
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears }), String(historyYears)).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { install: "example.deputy.com" })).toThrow("DEPUTY_INSTALL");
    expect(() => connector(mock, { install: "x", client: {} as DeputyClient })).not.toThrow();
    expect(connector(mock).source).toBe("deputy");
    const au = deputyDocMock(install({ baseUrl: "https://example.au.deputy.com" }));
    expect(eventsOf(await drain(connector(au, { install: "https://example.au.deputy.com/" }).historicalImport({ cursor: null } as never)))).toHaveLength(12);
  });

  it("reads back as far as told, and up to now when no clock is given", async () => {
    const mock = deputyDocMock(install());
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect((mock.reads[3]!.body.search as Record<string, Record<string, unknown>>).s1!.data).toBe("2025-11-11");
    const queries: DeputyQuery[] = [];
    const fake: DeputyClient = { baseUrl: API, query: async (q) => (queries.push(q), { records: [], more: false }) };
    const before = Date.now();
    const batches = await drain(deputyConnector({ accessToken: TOKEN, install: INSTALL, client: fake }).incrementalSync({ cursor: null } as never));
    const after = Date.now();
    const s = Date.parse(queries[0]!.since!.value);
    // The search time is to the second.
    expect(s).toBeGreaterThanOrEqual(before - DEPUTY_OVERLAP_MS - 1000);
    expect(s).toBeLessThanOrEqual(after - DEPUTY_OVERLAP_MS);
    const next = Date.parse(parseDeputyCursor(batches.at(-1)!.cursor ?? null)!.nextFrom);
    expect(next).toBeGreaterThanOrEqual(before - DEPUTY_OVERLAP_MS);
    expect(next).toBeLessThanOrEqual(after - DEPUTY_OVERLAP_MS);
  });

  it("only ever sends the search for the six records it reads, to the one install", async () => {
    const mock = deputyDocMock(install());
    await drain(connector(mock).historicalImport({ cursor: null } as never));
    await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).origin}${new URL(c.url).pathname}`))).toEqual(new Set(DEPUTY_OBJECTS.map((o) => `POST ${API}/api/v1/resource/${o}/QUERY`)));
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(DEPUTY_WRITES.map((w) => w.name)).toEqual(["publish_roster", "approve_timesheet"]);
    const c = connector(deputyDocMock(install()));
    expect(c.writes).toBe(DEPUTY_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "publish_roster", integration: "deputy", outcome: "refused" },
      { action: "approve_timesheet", integration: "deputy", outcome: "refused" },
    ]);
  });
});

describe("Deputy doc mock", () => {
  it("checks the token, the search, the sort and the paging", async () => {
    const mock = deputyDocMock(install());
    const query = (object: string, body: unknown, auth = `Bearer ${TOKEN}`) => mock.fetch(`${API}/api/v1/resource/${object}/QUERY`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    expect((await query("Employee", {}, "Bearer nope")).status).toBe(401);
    expect((await query("Memo", {})).status).toBe(404);
    for (const body of ["{", { start: -1 }, { max: 0 }, { start: "x" }, { search: { s1: { field: "Id", data: 1, type: "like" } } }, { search: { s1: { data: 1, type: "eq" } } }]) expect((await query("Employee", body)).status, JSON.stringify(body)).toBe(400);
    const all = (await (await query("Employee", "")).json()) as DeputyMockRecord[];
    expect(all.map((r) => r.Id)).toEqual([1, 2, 3]);
    const desc = (await (await query("Employee", { sort: { Id: "desc" }, start: 1, max: 1 })).json()) as DeputyMockRecord[];
    expect(desc.map((r) => r.Id)).toEqual([2]);
    const search = async (field: string, type: string, data: unknown) => ((await (await query("Employee", { search: { s1: { field, data, type } } })).json()) as DeputyMockRecord[]).map((r) => r.Id);
    expect(await search("Id", "eq", 2)).toEqual([2]);
    expect(await search("Id", "ne", 2)).toEqual([1, 3]);
    expect(await search("Id", "gt", 2)).toEqual([3]);
    expect(await search("Id", "ge", 2)).toEqual([2, 3]);
    expect(await search("Id", "lt", 2)).toEqual([1]);
    expect(await search("Id", "le", 2)).toEqual([1, 2]);
    const leave = (await (await query("Leave", { search: { s1: { field: "DateEnd", data: ago(400).slice(0, 10), type: "ge" } } })).json()) as DeputyMockRecord[];
    expect(leave).toHaveLength(2);
    const many = deputyDocMock({ token: TOKEN, records: { Employee: Array.from({ length: 600 }, (_, i) => ({ Id: i + 1 })) } });
    const capped = (await (await many.fetch(`${API}/api/v1/resource/Employee/QUERY`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ max: 1000 }) })).json()) as unknown[];
    expect(capped).toHaveLength(500);
    const none = (await (await many.fetch(`${API}/api/v1/resource/Roster/QUERY`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" })).json()) as unknown[];
    expect(none).toEqual([]);
  });
});
