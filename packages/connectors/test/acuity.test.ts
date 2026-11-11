import { describe, expect, it } from "vitest";
import { InMemoryWriteAuditLog, READ_ONLY, WriteGate, WritesDisabledError, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  ACUITY_DOC_PAGES,
  DOC_MOCK_MODULES,
  TEST_ORG,
  UndocumentedRequestError,
  acuityAppointment,
  acuityAppointmentType,
  acuityDocMock,
  assertSynthetic,
  checkConnectorSync,
  testPipeline,
  type AcuityMock,
  type AcuityMockData,
  type AcuityMockRecord,
} from "@karatos/connector-testkit";
import {
  ACUITY_AHEAD_DAYS,
  ACUITY_API_BASE,
  ACUITY_FULL_DAY_TYPE,
  ACUITY_MAX,
  ACUITY_REVISIT_DAYS,
  ACUITY_USER_AGENT,
  ACUITY_WRITES,
  AcuityApiError,
  AcuityConfigError,
  CALENDLY_EVENT_TYPES,
  WHATNOT_USER_AGENT,
  acuityAppointmentEvent,
  acuityCents,
  acuityClient,
  acuityConnector,
  acuityDay,
  acuityFullDayEvent,
  acuityId,
  acuityMinutes,
  acuityNames,
  acuityTime,
  formCustomerRefs,
  isAcuityDay,
  parseAcuityCursor,
  splitAcuityWindow,
  type AcuityClient,
  type AcuityCursor,
  type AcuityEvent,
  type AcuityLookups,
  type AcuityOptions,
  type AcuityWindow,
} from "../src/index.js";

// Key-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const USER = "1234567";
const API_KEY = ["acuity", "test", "x".repeat(20)].join("-");
const BASIC = `Basic ${Buffer.from(`${USER}:${API_KEY}`).toString("base64")}`;
const REF_KEY = "k".repeat(64);
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;
const HEADERS = { accept: "application/json", authorization: BASIC, "user-agent": ACUITY_USER_AGENT };
const noSleep = async () => {};

const reset = () => {
  for (const b of [acuityAppointment, acuityAppointmentType]) b.reset();
};
/** Three scheduled appointments on October 2 to 4, 2026, one canceled on October 5, and two types. */
function account(overrides: Partial<AcuityMockData> = {}): AcuityMockData {
  reset();
  const appointments = acuityAppointment.many(3);
  const canceled = [acuityAppointment.one({ id: 60001 })];
  return { userId: USER, apiKey: API_KEY, appointments, canceled, types: acuityAppointmentType.many(2), ...overrides };
}
/** Appointment 1 (54321, at 2026-10-02 10:00 New York time) with overrides. */
const appointment = (over: AcuityMockRecord = {}) => {
  reset();
  return { ...acuityAppointment.one(), ...over };
};
/** An appointment with an explicit id, at 10:00 New York time on a day. */
const on = (id: number, day: string, over: AcuityMockRecord = {}) => appointment({ id, datetime: `${day}T10:00:00-0400`, ...over });
const LOOKUPS: AcuityLookups = { types: new Map([["1", "Bridal consultation"], ["2", "Repair drop-off"]]) };
const NO_LOOKUPS: AcuityLookups = { types: new Map() };

const connector = (mock: AcuityMock, overrides: Partial<AcuityOptions> = {}) => acuityConnector({ userId: USER, apiKey: API_KEY, customerKey: REF_KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as AcuityEvent[];
async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}
const reads = (mock: AcuityMock) => mock.reads.map((r) => `${r.minDate}..${r.maxDate} ${r.canceled ? "canceled" : "scheduled"}`);
const windows = (mock: AcuityMock) => [...new Set(mock.reads.map((r) => `${r.minDate}..${r.maxDate}`))];

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}
function scripted(responses: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method, headers: { ...(init?.headers as Record<string, string>) } });
    return responses[Math.min(sent.length - 1, responses.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const empty = json(200, []);
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof acuityClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = acuityClient({ userId: USER, apiKey: API_KEY, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const OCT = { minDate: "2026-10-01", maxDate: "2026-10-31", canceled: false };

describe("Acuity client", () => {
  it("checks its settings before sending anything", () => {
    const userMessage = "set ACUITY_USER_ID to the numeric user id shown with the API key under Integrations > API in Acuity";
    const keyMessage = "set ACUITY_API_KEY to the API key shown under Integrations > API in Acuity";
    for (const userId of ["", "0", "0123", "abc", "12a", "1".repeat(13), "12 34", "-1", undefined as unknown as string, 123 as unknown as string]) {
      expect(() => acuityClient({ userId, apiKey: API_KEY }), String(userId)).toThrow(new AcuityConfigError(userMessage));
    }
    for (const apiKey of ["", "x".repeat(15), "x".repeat(129), `${"x".repeat(10)} ${"x".repeat(10)}`, `${"x".repeat(16)}é`, undefined as unknown as string]) {
      expect(() => acuityClient({ userId: USER, apiKey }), String(apiKey).slice(0, 5)).toThrow(new AcuityConfigError(keyMessage));
    }
    for (const [userId, apiKey] of [[USER, API_KEY], ["1", "x".repeat(16)], ["9".repeat(12), "~".repeat(128)], [` ${USER}\n`, `  ${API_KEY} `], [USER, "a:b!c#d$e%f&g'h(i)"]] as const) {
      expect(() => acuityClient({ userId, apiKey }), userId).not.toThrow();
    }
    expect(new AcuityConfigError("x").name).toBe("AcuityConfigError");
    expect(new AcuityApiError("x", 500, "internal_server_error")).toMatchObject({ name: "AcuityApiError", status: 500, code: "internal_server_error" });
  });

  it("sends only GETs of the two lists, with Basic auth, a User-Agent and the query it builds", async () => {
    const { fetch, sent } = scripted([empty]);
    const { c } = client(fetch);
    await c.appointments(OCT);
    await c.appointments({ minDate: "2026-10-05", maxDate: "2026-10-05", canceled: true });
    await c.appointmentTypes();
    await client(fetch, { userId: ` ${USER} `, apiKey: `\t${API_KEY}\n` }).c.appointmentTypes();
    expect(sent).toEqual([
      { url: `${ACUITY_API_BASE}/appointments?max=100&minDate=2026-10-01&maxDate=2026-10-31&canceled=false&direction=ASC&excludeForms=true`, method: "GET", headers: HEADERS },
      { url: `${ACUITY_API_BASE}/appointments?max=100&minDate=2026-10-05&maxDate=2026-10-05&canceled=true&direction=ASC&excludeForms=true`, method: "GET", headers: HEADERS },
      { url: `${ACUITY_API_BASE}/appointment-types?includeDeleted=true`, method: "GET", headers: HEADERS },
      { url: `${ACUITY_API_BASE}/appointment-types?includeDeleted=true`, method: "GET", headers: HEADERS },
    ]);
    expect(Buffer.from(BASIC.slice(6), "base64").toString()).toBe(`${USER}:${API_KEY}`);
    expect(ACUITY_API_BASE).toBe("https://acuityscheduling.com/api/v1");
    expect(ACUITY_MAX).toBe(100);
    expect(ACUITY_USER_AGENT).toBe(WHATNOT_USER_AGENT);
    expect(Object.keys(c).sort()).toEqual(["appointmentTypes", "appointments"]);
  });

  it("asks for the canceled list only when canceled is exactly true", async () => {
    const { fetch, sent } = scripted([empty]);
    await client(fetch).c.appointments({ ...OCT, canceled: "yes" as unknown as boolean });
    expect(sent[0]!.url).toContain("canceled=false");
  });

  it("turns down days that don't read, or the wrong way round, before sending anything", async () => {
    const { fetch, sent } = scripted([empty]);
    const { c } = client(fetch);
    const message = new AcuityApiError("the appointments must be asked for between two days written YYYY-MM-DD, the first no later than the last", 0);
    for (const [minDate, maxDate] of [["2026-02-30", "2026-03-01"], ["2026-10-01", "2026-13-01"], ["2026-1-01", "2026-10-31"], ["2026-10-01T00:00:00Z", "2026-10-31"], ["", "2026-10-31"], ["2026-10-02", "2026-10-01"], ["2026-10-01", 5 as unknown as string]]) {
      await expect(c.appointments({ minDate: minDate!, maxDate: maxDate!, canceled: false }), `${minDate} ${maxDate}`).rejects.toThrow(message);
    }
    expect(sent).toHaveLength(0);
    await c.appointments({ minDate: "2028-02-29", maxDate: "2028-02-29", canceled: false });
    expect(sent).toHaveLength(1);
  });

  it("reads only real days written YYYY-MM-DD", () => {
    for (const d of ["2026-10-01", "2028-02-29", "1999-12-31"]) expect(isAcuityDay(d), d).toBe(true);
    for (const d of ["2026-02-29", "2026-04-31", "2026-00-10", "2026-10-00", "2026-10-1", "20261001", "2026-10-01 ", "x", 20261001, null]) expect(isAcuityDay(d), String(d)).toBe(false);
  });

  it("explains credentials Acuity turns down, and other answers", async () => {
    const at = async (response: () => Response) => client(scripted([response]).fetch, { retries: 0 }).c.appointments(OCT);
    const settings = "ACUITY_USER_ID must be the numeric user id and ACUITY_API_KEY the API key shown together under Integrations > API in Acuity, on the Premium or Powerhouse plan";
    await expect(at(json(401, { status_code: 401, message: "Unauthorized", error: "unauthorized" }))).rejects.toThrow(new AcuityConfigError(`Acuity turned down the credentials (HTTP 401) (unauthorized): Unauthorized; ${settings}`));
    await expect(at(json(403, { status_code: 403, error: "forbidden" }))).rejects.toThrow(new AcuityConfigError(`Acuity turned down the credentials (HTTP 403) (forbidden); ${settings}`));
    await expect(at(() => new Response("nope", { status: 401 }))).rejects.toThrow(new AcuityConfigError(`Acuity turned down the credentials (HTTP 401); ${settings}`));
    await expect(at(json(404, { status_code: 404, error: "not_found", message: "m".repeat(250) }))).rejects.toThrow(new AcuityApiError(`Acuity answered HTTP 404 for the appointments (not_found): ${"m".repeat(200)}`, 404, "not_found"));
    await expect(at(json(400, { error: "Bad Request", message: "Invalid date" }))).rejects.toMatchObject({ message: "Acuity answered HTTP 400 for the appointments: Invalid date", code: undefined, status: 400 });
    await expect(at(json(400, { error: "e".repeat(65) }))).rejects.toMatchObject({ code: undefined });
    await expect(at(json(400, { error: "e".repeat(64) }))).rejects.toMatchObject({ code: "e".repeat(64) });
    await expect(at(json(422, { error: "invalid_time", message: 5 }))).rejects.toThrow(/^Acuity answered HTTP 422 for the appointments \(invalid_time\)$/);
    await expect(at(json(500, null))).rejects.toThrow(/^Acuity answered HTTP 500 for the appointments$/);
    await expect(at(json(202, []))).rejects.toMatchObject({ status: 202 });
    for (const body of [null, {}, 5, "[]", { appointments: [] }]) {
      await expect(at(json(200, body)), JSON.stringify(body)).rejects.toThrow(new AcuityApiError("Acuity answered the appointments without a list that reads", 200));
    }
    await expect(at(() => new Response("[", { status: 200 }))).rejects.toThrow("without a list that reads");
    expect(await at(json(200, [{ id: 1 }]))).toEqual([{ id: 1 }]);
    const what = async (call: (c: AcuityClient) => Promise<unknown>) => call(client(scripted([json(500, {})]).fetch, { retries: 0 }).c).then(() => "", (e: Error) => e.message);
    expect(await what((c) => c.appointments({ ...OCT, canceled: true }))).toBe("Acuity answered HTTP 500 for the canceled appointments");
    expect(await what((c) => c.appointmentTypes())).toBe("Acuity answered HTTP 500 for the appointment types");
  });

  it("waits out a 429 or 5xx as Retry-After says, up to a minute, else 1, 2 and 4 seconds", async () => {
    const waits = async (headers: Record<string, string>, status = 429) => {
      const { fetch, sent } = scripted([json(status, { error: "too_many_requests" }, headers), empty]);
      const { c, slept } = client(fetch);
      await c.appointments(OCT);
      expect(sent).toHaveLength(2);
      return slept;
    };
    expect(await waits({ "retry-after": "1" })).toEqual([1000]);
    expect(await waits({ "retry-after": "60" })).toEqual([60_000]);
    expect(await waits({ "retry-after": "61" })).toEqual([60_000]);
    for (const value of ["0", "-1", "1.5", "soon"]) expect(await waits({ "retry-after": value }), value).toEqual([1000]);
    expect(await waits({})).toEqual([1000]);
    for (const status of [500, 502, 503, 504]) expect(await waits({ "retry-after": "3" }, status), String(status)).toEqual([3000]);
    const { fetch, sent } = scripted([json(429, { status_code: 429, error: "too_many_requests", message: "Rate limit reached. Limit 10req/s and 20 concurrent connections." })]);
    const { c, slept } = client(fetch);
    await expect(c.appointments(OCT)).rejects.toMatchObject({ status: 429, code: "too_many_requests" });
    expect([sent.length, slept]).toEqual([4, [1000, 2000, 4000]]);
    const once = scripted([json(501, {})]);
    await expect(client(once.fetch).c.appointments(OCT)).rejects.toMatchObject({ status: 501 });
    expect(once.sent).toHaveLength(1);
    const one = scripted([json(503, {})]);
    await expect(client(one.fetch, { retries: 1 }).c.appointments(OCT)).rejects.toMatchObject({ status: 503 });
    expect(one.sent).toHaveLength(2);
    for (const status of [401, 403]) {
      const denied = scripted([json(status, {})]);
      await expect(client(denied.fetch).c.appointments(OCT)).rejects.toBeInstanceOf(AcuityConfigError);
      expect(denied.sent).toHaveLength(1);
    }
  });

  it("works with the default sleep and fetch", async () => {
    const original = globalThis.fetch;
    const { fetch, sent } = scripted([json(429, {}, { "retry-after": "0" }), empty]);
    globalThis.fetch = fetch;
    try {
      const started = Date.now();
      await acuityClient({ userId: USER, apiKey: API_KEY }).appointmentTypes();
      expect(Date.now() - started).toBeGreaterThanOrEqual(990);
      expect(sent).toHaveLength(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("Acuity events", () => {
  it("reads ids, times, money, minutes and days as Acuity writes them", () => {
    expect([acuityId(1), acuityId(54321), acuityId(Number.MAX_SAFE_INTEGER), acuityId("12"), acuityId("1".repeat(16))]).toEqual(["1", "54321", String(Number.MAX_SAFE_INTEGER), "12", "1".repeat(16)]);
    for (const v of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, "0", "012", "", "1".repeat(17), "1a", null, undefined, {}]) expect(acuityId(v), String(v)).toBeUndefined();

    expect(acuityTime("2013-07-02T10:15:00-0700")).toBe("2013-07-02T17:15:00.000Z");
    expect(acuityTime("2013-07-02T10:15:00-07:00")).toBe("2013-07-02T17:15:00.000Z");
    expect(acuityTime("2013-07-02T10:15:00+0530")).toBe("2013-07-02T04:45:00.000Z");
    expect(acuityTime("2013-07-02T10:15:00Z")).toBe("2013-07-02T10:15:00.000Z");
    expect(acuityTime("2028-02-29T23:59:59+1400")).toBe("2028-02-29T09:59:59.000Z");
    expect(acuityTime("2026-12-31T00:00:00-1159")).toBe("2026-12-31T11:59:00.000Z");
    for (const v of ["2026-02-29T10:00:00-0500", "2026-13-01T10:00:00-0500", "2026-10-01T24:00:00-0500", "2026-10-01T10:60:00-0500", "2026-10-01T10:00:60-0500", "2026-10-01T10:00:00+1500", "2026-10-01T10:00:00+0060", "2026-10-01T10:00:00", "2026-10-01T10:00:00.000Z", "2026-10-01 10:00:00-0500", "2026-10-01T10:00-0500", "July 2, 2013", 1_700_000_000, null]) {
      expect(acuityTime(v), String(v)).toBeUndefined();
    }

    expect([acuityCents("10.00"), acuityCents("0"), acuityCents("0.5"), acuityCents("45.1"), acuityCents("45.05"), acuityCents("999999999.99"), acuityCents("7")]).toEqual([1000, 0, 50, 4510, 4505, 99_999_999_999, 700]);
    for (const v of ["1000000000", "01.00", "1.234", "-1", "1.", ".5", "1,000.00", "", " 1", 10, null]) expect(acuityCents(v), String(v)).toBeUndefined();

    expect([acuityMinutes("60"), acuityMinutes(60), acuityMinutes("1"), acuityMinutes("99999"), acuityMinutes(99999)]).toEqual([60, 60, 1, 99999, 99999]);
    for (const v of ["0", 0, "100000", 100000, "1.5", 1.5, "060", "-5", -5, "", null]) expect(acuityMinutes(v), String(v)).toBeUndefined();

    expect([acuityDay("June 17, 2013"), acuityDay("june 7, 2013"), acuityDay(" DECEMBER 31, 1999 "), acuityDay("February 29, 2028"), acuityDay("January 1, 2026")]).toEqual(["2013-06-17", "2013-06-07", "1999-12-31", "2028-02-29", "2026-01-01"]);
    for (const v of ["February 29, 2026", "June 31, 2026", "June 0, 2026", "Juno 17, 2013", "June 17 2013", "17 June, 2013", "June 17, 13", "2013-06-17", "", 5, null]) expect(acuityDay(v), String(v)).toBeUndefined();
  });

  it("reads names by id from appointment types", () => {
    const names = acuityNames([{ id: 1, name: " Bridal consultation " }, { id: "2", name: "n".repeat(200) }, { id: 3 }, { id: 4, name: "  " }, { name: "No id" }, { id: 0, name: "Zero" }, null, 5, [1], { id: 1, name: "Bridal, again" }]);
    expect([...names]).toEqual([
      ["1", "Bridal, again"],
      ["2", "n".repeat(160)],
    ]);
    expect(acuityNames([]).size).toBe(0);
  });

  it("reads a scheduled appointment as booked, without the client, notes or forms", () => {
    const raw = appointment();
    const { ok, event } = acuityAppointmentEvent(raw, false, LOOKUPS, REF_KEY, RECEIVED);
    expect(ok).toBe(true);
    expect(event).toMatchObject({ type: CALENDLY_EVENT_TYPES.booked, occurredAt: "2026-10-02T14:00:00.000Z", receivedAt: RECEIVED });
    expect(event.payload).toEqual({
      system: "Acuity Scheduling",
      appointmentId: "54321",
      appointmentTypeId: "1",
      title: "Bridal consultation",
      kind: "bridal",
      status: "booked",
      canceled: false,
      startAt: "2026-10-02T14:00:00.000Z",
      endAt: "2026-10-02T14:45:00.000Z",
      durationMinutes: 45,
      hostRefs: ["acuity:calendar:27238"],
      customerRefs: formCustomerRefs(REF_KEY, { email: "customer1@example.test", phone: "+1 212 555 0101" }),
      bookedOn: "2026-09-25",
      priceCents: 4500,
      amountPaidCents: 4500,
      paid: true,
    });
    expect((event.payload.customerRefs as string[]).length).toBe(2);
    expect(event.idempotencyKey).toMatch(/^acuity:appointment:54321:[0-9a-f]{12}$/);
    expect(event.id).toBe(event.idempotencyKey.replace(/:/g, "_"));
    const kept = JSON.stringify(event);
    for (const dropped of ["Test", "Customer1", "customer1", "555", "note", "intake", "first visit", "Testville", "Completed", "schedule.php", "America/New_York"]) expect(kept, dropped).not.toContain(dropped);
    assertSynthetic(event.payload);
  });

  it("maps canceled and no-show appointments to Calendly's types", () => {
    const type = (raw: AcuityMockRecord, canceled: boolean) => {
      const { event } = acuityAppointmentEvent(raw, canceled, LOOKUPS, REF_KEY, RECEIVED);
      return [event.type, event.payload.status, event.payload.canceled];
    };
    expect(type(appointment(), true)).toEqual(["appointment.canceled", "canceled", true]);
    expect(type(appointment({ noShow: false }), true)).toEqual(["appointment.canceled", "canceled", true]);
    expect(type(appointment({ noShow: true }), true)).toEqual(["appointment.no_show", "no_show", true]);
    expect(type(appointment({ noShow: true }), false)).toEqual(["appointment.no_show", "no_show", false]);
    expect(type(appointment({ noShow: "true" }), true)).toEqual(["appointment.canceled", "canceled", true]);
    expect(CALENDLY_EVENT_TYPES).toEqual({ booked: "appointment.booked", canceled: "appointment.canceled", noShow: "appointment.no_show" });
  });

  it("names the type from the lookups, else from the appointment, never with the client's name, and the calendar only by id", () => {
    const payload = (raw: AcuityMockRecord, lookups = LOOKUPS) => acuityAppointmentEvent(raw, false, lookups, REF_KEY, RECEIVED).event.payload;
    expect(payload(appointment(), NO_LOOKUPS)).toMatchObject({ title: "Bridal consultation", hostRefs: ["acuity:calendar:27238"] });
    expect(payload(appointment({ appointmentTypeID: 2, type: "Old name" }))).toMatchObject({ appointmentTypeId: "2", title: "Repair drop-off", kind: "repair" });
    expect(payload(appointment({ appointmentTypeID: 9, type: "Watch service" }))).toMatchObject({ appointmentTypeId: "9", title: "Watch service", kind: "repair" });
    const bare = payload(appointment({ appointmentTypeID: null, type: null, calendarID: null, calendar: " " }));
    expect(bare).toMatchObject({ kind: "other", hostRefs: [] });
    for (const key of ["appointmentTypeId", "title"]) expect(bare, key).not.toHaveProperty(key);
    const staffed = payload(appointment({ calendarID: 99, calendar: "Test Staff 9" }));
    expect(staffed.hostRefs).toEqual(["acuity:calendar:99"]);
    expect(JSON.stringify(staffed)).not.toMatch(/Staff|calendarName/);
    expect(Object.keys(payload(appointment())).sort()).toEqual(["amountPaidCents", "appointmentId", "appointmentTypeId", "bookedOn", "canceled", "customerRefs", "durationMinutes", "endAt", "hostRefs", "kind", "paid", "priceCents", "startAt", "status", "system", "title"]);
    expect(payload(appointment({ appointmentTypeID: 9, type: `Engagement ${"t".repeat(200)}` })).title).toBe(`Engagement ${"t".repeat(200)}`.slice(0, 80));
    // A type named after the client is dropped, though its kind is still read from it.
    expect(payload(appointment({ appointmentTypeID: 9, type: "Customer1 ring sizing" }))).toMatchObject({ kind: "repair" });
    expect(payload(appointment({ appointmentTypeID: 9, type: "Customer1 ring sizing" }))).not.toHaveProperty("title");
    expect(payload(appointment({ appointmentTypeID: 9, type: "Fitting for customer1@example.test" }))).not.toHaveProperty("title");
    expect(payload(appointment({ appointmentTypeID: 9, type: "Bridal consultation", lastName: "Bridal" }))).not.toHaveProperty("title");
  });

  it("keeps money and the day it was booked only when they read", () => {
    const payload = (over: AcuityMockRecord) => acuityAppointmentEvent(appointment(over), false, LOOKUPS, REF_KEY, RECEIVED).event.payload;
    expect(payload({ price: "10.50", amountPaid: "0.00", paid: "no" })).toMatchObject({ priceCents: 1050, amountPaidCents: 0, paid: false });
    const none = payload({ price: 10, amountPaid: undefined, paid: "partly", dateCreated: "yesterday" });
    for (const key of ["priceCents", "amountPaidCents", "paid", "bookedOn"]) expect(none, key).not.toHaveProperty(key);
    expect(payload({ email: "not an email", phone: "12" }).customerRefs).toEqual([]);
    expect(payload({ email: " Customer1@Example.TEST ", phone: null }).customerRefs).toEqual(formCustomerRefs(REF_KEY, { email: "customer1@example.test" }));
  });

  it("keys an appointment by what is kept, so only a change is new", () => {
    const key = (over: AcuityMockRecord, canceled = false) => acuityAppointmentEvent(appointment(over), canceled, LOOKUPS, REF_KEY, RECEIVED).event.idempotencyKey;
    const same = key({});
    expect(key({ notes: "Changed note", firstName: "Other", forms: [] })).toBe(same);
    expect(acuityAppointmentEvent(appointment(), false, LOOKUPS, REF_KEY, "2027-01-01T00:00:00.000Z").event.idempotencyKey).toBe(same);
    for (const over of [{ paid: "no" }, { datetime: "2026-10-02T11:00:00-0400" }, { duration: "60" }, { calendarID: 1 }, { amountPaid: "10.00" }, { email: "customer2@example.test" }]) expect(key(over), JSON.stringify(over)).not.toBe(same);
    expect(key({}, true)).not.toBe(same);
  });

  it("dead-letters an appointment that doesn't read, listing what was wrong and nothing personal", () => {
    const dead = (raw: unknown) => acuityAppointmentEvent(raw, false, LOOKUPS, REF_KEY, RECEIVED);
    for (const raw of [null, 5, "x", [appointment()]]) {
      const { ok, event } = dead(raw);
      expect([ok, event.occurredAt, event.payload]).toEqual([false, undefined, { system: "Acuity Scheduling", appointmentId: null, problems: ["appointment is not an object", "appointment has no id that reads", "appointment has no start time that reads", "appointment has no duration that reads"] }]);
      expect(event.idempotencyKey).toMatch(/^acuity:unreadable_appointment:[0-9a-f]{12}$/);
      expect(event.id).toBe(event.idempotencyKey.replace(/:/g, "_"));
    }
    expect(dead(appointment({ id: "x" })).event.payload).toEqual({ system: "Acuity Scheduling", appointmentId: null, problems: ["appointment has no id that reads"] });
    expect(dead(appointment({ datetime: "October 2, 2026" })).event.payload).toEqual({ system: "Acuity Scheduling", appointmentId: "54321", problems: ["appointment has no start time that reads"] });
    expect(dead(appointment({ duration: "0" })).event.payload).toEqual({ system: "Acuity Scheduling", appointmentId: "54321", problems: ["appointment has no duration that reads"] });
    expect(dead(appointment({ duration: "0" })).event.idempotencyKey).not.toBe(dead(appointment({ duration: "-1" })).event.idempotencyKey);
    expect(dead(appointment({ duration: "0" })).event.idempotencyKey).toBe(dead(appointment({ duration: "0" })).event.idempotencyKey);
    expect(dead(appointment({ duration: 1 })).ok).toBe(true);
  });

  it("marks a day that filled a request, to be dead-lettered", () => {
    expect(acuityFullDayEvent("2026-10-05", false, RECEIVED)).toEqual({
      id: "acuity_full_day_2026-10-05_scheduled",
      type: ACUITY_FULL_DAY_TYPE,
      occurredAt: undefined,
      receivedAt: RECEIVED,
      idempotencyKey: "acuity:full_day:2026-10-05:scheduled",
      payload: { system: "Acuity Scheduling", day: "2026-10-05", canceled: false, read: 100, problems: ["Acuity returned 100 scheduled appointments for 2026-10-05, the most one request asks for, so any more that day were not read"] },
    });
    expect(acuityFullDayEvent("2026-10-05", true, RECEIVED)).toMatchObject({ idempotencyKey: "acuity:full_day:2026-10-05:canceled", payload: { canceled: true, problems: [expect.stringContaining("100 canceled appointments")] } });
    expect(ACUITY_FULL_DAY_TYPE).toBe("appointment.day_full");
  });
});

describe("Acuity windows and checkpoints", () => {
  it("splits a window in half, the earlier half first", () => {
    const split = (w: AcuityWindow) => splitAcuityWindow(w);
    expect(split(["2026-10-01", "2026-10-31"])).toEqual([["2026-10-01", "2026-10-15"], ["2026-10-16", "2026-10-31"]]);
    expect(split(["2026-10-01", "2026-10-30"])).toEqual([["2026-10-01", "2026-10-15"], ["2026-10-16", "2026-10-30"]]);
    expect(split(["2026-10-01", "2026-10-03"])).toEqual([["2026-10-01", "2026-10-01"], ["2026-10-02", "2026-10-03"]]);
    expect(split(["2026-10-30", "2026-10-31"])).toEqual([["2026-10-30", "2026-10-30"], ["2026-10-31", "2026-10-31"]]);
    expect(split(["2028-02-01", "2028-02-29"])).toEqual([["2028-02-01", "2028-02-14"], ["2028-02-15", "2028-02-29"]]);
  });

  it("turns down a checkpoint that isn't its own", () => {
    const good: AcuityCursor[] = [
      { done: true, pending: [], end: null },
      { done: false, pending: [["2026-10-01", "2026-10-31"]], end: "2026-10-31" },
      { done: false, pending: [["2026-10-05", "2026-10-05"]], end: "2027-02-09" },
      { done: false, pending: [["2026-10-01", "2026-10-08"], ["2026-10-09", "2026-10-16"], ["2026-10-17", "2026-10-31"]], end: "2027-02-09" },
      { done: false, pending: Array.from({ length: 31 }, (_, i): AcuityWindow => [`2026-10-${String(i + 1).padStart(2, "0")}`, `2026-10-${String(i + 1).padStart(2, "0")}`]), end: "2026-10-31" },
      { done: false, pending: [["2026-10-31", "2026-10-31"], ["2026-11-01", "2026-11-30"]], end: "2026-12-31" },
    ];
    expect(parseAcuityCursor(null)).toBeNull();
    for (const c of good) expect(parseAcuityCursor(JSON.stringify(c))).toEqual(c);
    const days = (n: number) => Array.from({ length: n }, (_, i): AcuityWindow => { const d = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10); return [d, d]; });
    expect(parseAcuityCursor(JSON.stringify({ done: false, pending: days(32), end: "2026-11-30" }))!.pending).toHaveLength(32);
    const bad: unknown[] = [
      "{",
      "null",
      "[]",
      "5",
      '"x"',
      {},
      { done: false, pending: [["2026-10-01", "2026-10-31"]] },
      { done: false, pending: [["2026-10-01", "2026-10-31"]], end: "2026-10-31", extra: 1 },
      { done: "false", pending: [["2026-10-01", "2026-10-31"]], end: "2026-10-31" },
      { done: false, pending: "2026-10-01", end: "2026-10-31" },
      { done: false, pending: [], end: "2026-10-31" },
      { done: false, pending: [["2026-10-01", "2026-10-31"]], end: null },
      { done: false, pending: [["2026-10-01", "2026-10-31"]], end: "2026-10-30" },
      { done: false, pending: [["2026-10-01", "2026-10-31"]], end: "2026-1-31" },
      { done: false, pending: [["2026-10-02", "2026-10-01"]], end: "2026-10-31" },
      { done: false, pending: [["2026-10-01", "2026-11-01"]], end: "2026-12-31" },
      { done: false, pending: [["2026-10-01", "2026-10-32"]], end: "2026-12-31" },
      { done: false, pending: [["2026-10-01"]], end: "2026-10-31" },
      { done: false, pending: [["2026-10-01", "2026-10-02", "2026-10-03"]], end: "2026-10-31" },
      { done: false, pending: [{ from: "2026-10-01", to: "2026-10-02" }], end: "2026-10-31" },
      { done: false, pending: [["2026-10-01", "2026-10-08"], ["2026-10-10", "2026-10-16"]], end: "2026-10-31" },
      { done: false, pending: [["2026-10-01", "2026-10-08"], ["2026-10-08", "2026-10-16"]], end: "2026-10-31" },
      { done: false, pending: days(33), end: "2026-11-30" },
      { done: true, pending: [["2026-10-01", "2026-10-31"]], end: null },
      { done: true, pending: [], end: "2026-10-31" },
      { done: false, pending: [], end: null },
      // Another connector's checkpoints.
      { done: false, step: "orders", page: null },
      { through: null, readAtThrough: [], recent: {} },
    ];
    for (const raw of bad) expect(() => parseAcuityCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("Acuity checkpoint is not in the expected shape");
  });
});

describe("Acuity connector", () => {
  it("passes the shared sync checks", async () => {
    // One appointment in the first window, three scheduled in October 2026 and one canceled one.
    const data = () => {
      const d = account();
      return { ...d, appointments: [on(40001, "2024-11-15"), ...d.appointments!] };
    };
    const result = await checkConnectorSync({ makeConnector: () => connector(acuityDocMock(data())), payloadSchemas: SCHEMAS, expected: { ingested: 5 } });
    expect(result.resume!.ingested).toBe(4);
    expect(result.full.batches).toBe(28);
    expect(parseAcuityCursor(result.full.cursor)).toEqual({ done: true, pending: [], end: null });
  });

  it("imports two years back to 90 days ahead, month by month, oldest first, and stops for good", async () => {
    const mock = acuityDocMock(account());
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 4, deadLettered: 0, batches: 28 });
    expect(ACUITY_AHEAD_DAYS).toBe(90);
    const w = windows(mock);
    expect(w).toHaveLength(28);
    expect(w.slice(0, 3)).toEqual(["2024-11-11..2024-11-30", "2024-12-01..2024-12-31", "2025-01-01..2025-01-31"]);
    expect(w.slice(-2)).toEqual(["2027-01-01..2027-01-31", "2027-02-01..2027-02-09"]);
    expect(w).toContain("2025-02-01..2025-02-28");
    expect(reads(mock).slice(0, 2)).toEqual(["2024-11-11..2024-11-30 scheduled", "2024-11-11..2024-11-30 canceled"]);
    expect(mock.reads.every((r) => r.max === 100)).toBe(true);
    expect(mock.fetch.calls.map((c) => new URL(c.url).pathname).filter((p) => p !== "/api/v1/appointments")).toEqual(["/api/v1/appointment-types"]);
    expect(new URL(mock.fetch.calls[0]!.url).pathname).toBe("/api/v1/appointment-types");
    expect(mock.fetch.calls).toHaveLength(1 + 56);
    expect(memory.events.map((e) => [e.type, e.payload.appointmentId, e.payload.hostRefs])).toEqual([
      ["appointment.booked", "54321", ["acuity:calendar:27238"]],
      ["appointment.booked", "54322", ["acuity:calendar:27238"]],
      ["appointment.booked", "54323", ["acuity:calendar:27238"]],
      ["appointment.canceled", "60001", ["acuity:calendar:27238"]],
    ]);
    assertSynthetic(memory.events.map((e) => e.payload));
    expect(JSON.stringify(memory.events.map((e) => e.payload))).not.toMatch(/Test Customer|Test Staff|calendarName|example\.test|note|intake|555/);
    expect(parseAcuityCursor(report.cursor)).toEqual({ done: true, pending: [], end: null });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect([again.ingested, again.batches, mock.fetch.calls.length]).toEqual([0, 0, 57]);
  });

  it("goes back as many years as it is told", async () => {
    const mock = acuityDocMock(account());
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(windows(mock)[0]).toBe("2025-11-11..2025-11-30");
    for (const historyYears of [0, -1, 1.5, Number.NaN]) expect(() => connector(mock, { historyYears }), String(historyYears)).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY must be at least");
  });

  it("checkpoints the windows still to read, and resumes the import from them", async () => {
    const data = account();
    const all = await drain(connector(acuityDocMock(data)).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const cursors = all.map((b) => parseAcuityCursor(b.cursor)!);
    expect(cursors[0]).toEqual({ done: false, pending: [["2024-12-01", "2024-12-31"]], end: "2027-02-09" });
    expect(cursors[22]).toEqual({ done: false, pending: [["2026-10-01", "2026-10-31"]], end: "2027-02-09" });
    expect(cursors.at(-2)).toEqual({ done: false, pending: [["2027-02-01", "2027-02-09"]], end: "2027-02-09" });
    expect(cursors.at(-1)).toEqual({ done: true, pending: [], end: null });
    const mock = acuityDocMock(data);
    const resumed = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: all[22]!.cursor }));
    expect(windows(mock)).toEqual(["2026-10-01..2026-10-31", "2026-11-01..2026-11-30", "2026-12-01..2026-12-31", "2027-01-01..2027-01-31", "2027-02-01..2027-02-09"]);
    expect(eventsOf(resumed)).toHaveLength(4);
    const done = acuityDocMock(data);
    expect(await drain(connector(done).historicalImport({ organizationId: TEST_ORG, cursor: all.at(-1)!.cursor }))).toEqual([]);
    expect(done.fetch.calls).toEqual([]);
    // A resumed import reads the windows it saved, in order, even part way through a split.
    const split = acuityDocMock(data);
    const saved: AcuityCursor = { done: false, pending: [["2026-10-03", "2026-10-04"], ["2026-10-05", "2026-10-31"]], end: "2026-11-02" };
    const out = await drain(connector(split).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(windows(split)).toEqual(["2026-10-03..2026-10-04", "2026-10-05..2026-10-31", "2026-11-01..2026-11-02"]);
    expect(out.map((b) => parseAcuityCursor(b.cursor))).toEqual([
      { done: false, pending: [["2026-10-05", "2026-10-31"]], end: "2026-11-02" },
      { done: false, pending: [["2026-11-01", "2026-11-02"]], end: "2026-11-02" },
      { done: true, pending: [], end: null },
    ]);
    expect(eventsOf(out).map((e) => e.payload.appointmentId)).toEqual(["54322", "54323", "60001"]);
  });

  it("halves a window that fills a request, down to a day, and dead-letters a day that still does", async () => {
    // 100 scheduled appointments on October 5 and one on October 20.
    const busy = Array.from({ length: ACUITY_MAX }, (_, i) => on(70000 + i, "2026-10-05"));
    const mock = acuityDocMock({ userId: USER, apiKey: API_KEY, appointments: [...busy, on(80000, "2026-10-20")], canceled: [on(80001, "2026-10-05")] });
    const saved: AcuityCursor = { done: false, pending: [["2026-10-01", "2026-10-31"]], end: "2026-10-31" };
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    await memory.saveCheckpoint(TEST_ORG, "acuity", "incremental", JSON.stringify(saved));
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(reads(mock)).toEqual([
      "2026-10-01..2026-10-31 scheduled",
      "2026-10-01..2026-10-15 scheduled",
      "2026-10-01..2026-10-07 scheduled",
      "2026-10-01..2026-10-03 scheduled",
      "2026-10-01..2026-10-03 canceled",
      "2026-10-04..2026-10-07 scheduled",
      "2026-10-04..2026-10-05 scheduled",
      "2026-10-04..2026-10-04 scheduled",
      "2026-10-04..2026-10-04 canceled",
      "2026-10-05..2026-10-05 scheduled",
      "2026-10-05..2026-10-05 canceled",
      "2026-10-06..2026-10-07 scheduled",
      "2026-10-06..2026-10-07 canceled",
      "2026-10-08..2026-10-15 scheduled",
      "2026-10-08..2026-10-15 canceled",
      "2026-10-16..2026-10-31 scheduled",
      "2026-10-16..2026-10-31 canceled",
    ]);
    expect(report).toMatchObject({ ingested: 102, deadLettered: 1, batches: 6 });
    expect(memory.deadLetters.map((d) => (d.raw as AcuityEvent).idempotencyKey)).toEqual(["acuity:full_day:2026-10-05:scheduled"]);
  });

  it("halves on a full canceled list too, and reads on when a window holds one fewer than a request", async () => {
    const canceled = Array.from({ length: ACUITY_MAX }, (_, i) => on(70000 + i, i < 50 ? "2026-10-02" : "2026-10-29"));
    const mock = acuityDocMock({ userId: USER, apiKey: API_KEY, appointments: [], canceled });
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ done: false, pending: [["2026-10-01", "2026-10-31"]], end: "2026-10-31" }) }));
    expect(reads(mock)).toEqual(["2026-10-01..2026-10-31 scheduled", "2026-10-01..2026-10-31 canceled", "2026-10-01..2026-10-15 scheduled", "2026-10-01..2026-10-15 canceled", "2026-10-16..2026-10-31 scheduled", "2026-10-16..2026-10-31 canceled"]);
    const fewer = acuityDocMock({ userId: USER, apiKey: API_KEY, appointments: canceled.slice(1), canceled: canceled.slice(1) });
    const out = await drain(connector(fewer).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ done: false, pending: [["2026-10-01", "2026-10-31"]], end: "2026-10-31" }) }));
    expect(windows(fewer)).toEqual(["2026-10-01..2026-10-31"]);
    expect(eventsOf(out)).toHaveLength(2 * (ACUITY_MAX - 1));
    // An answer with more than asked for is treated as full too.
    const rows = (n: number) => Array.from({ length: n }, (_, i) => on(90000 + i, "2026-10-09"));
    const asked: string[] = [];
    const fake: AcuityClient = {
      appointments: async ({ minDate, maxDate, canceled: c }) => (asked.push(`${minDate}..${maxDate} ${c}`), minDate === maxDate ? [] : rows(minDate === "2026-10-01" && maxDate === "2026-10-02" ? ACUITY_MAX + 1 : 0)),
      appointmentTypes: async () => [],
    };
    await drain(acuityConnector({ userId: USER, apiKey: API_KEY, customerKey: REF_KEY, client: fake, now: NOW }).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ done: false, pending: [["2026-10-01", "2026-10-02"]], end: "2026-10-02" }) }));
    expect(asked).toEqual(["2026-10-01..2026-10-02 false", "2026-10-01..2026-10-01 false", "2026-10-01..2026-10-01 true", "2026-10-02..2026-10-02 false", "2026-10-02..2026-10-02 true"]);
  });

  it("reads from 60 days back to 90 days ahead on each later sync, so only a change is new", async () => {
    reset();
    const days = ["2026-09-11", "2026-09-12", "2026-11-11", "2027-02-09", "2027-02-10"];
    const appointments = days.map((d, i) => on(50000 + i, d));
    const data = (): AcuityMockData => ({ userId: USER, apiKey: API_KEY, appointments, canceled: [] });
    const mock = acuityDocMock(data());
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(ACUITY_REVISIT_DAYS).toBe(60);
    expect(windows(mock)).toEqual(["2026-09-12..2026-09-30", "2026-10-01..2026-10-31", "2026-11-01..2026-11-30", "2026-12-01..2026-12-31", "2027-01-01..2027-01-31", "2027-02-01..2027-02-09"]);
    expect(report).toMatchObject({ ingested: 3, deadLettered: 0, batches: 6 });
    expect(memory.events.map((e) => e.payload.appointmentId)).toEqual(["50001", "50002", "50003"]);
    expect(parseAcuityCursor(report.cursor)).toEqual({ done: true, pending: [], end: null });
    const again = await runSync({ connector: connector(acuityDocMock(data())), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect([again.ingested, again.duplicates]).toEqual([0, 3]);
    appointments[2]!.paid = "no";
    const changed = await runSync({ connector: connector(acuityDocMock({ ...data(), appointments: [appointments[1]!, appointments[2]!], canceled: [appointments[3]!] })), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect([changed.ingested, changed.duplicates]).toEqual([2, 1]);
    expect(memory.events.slice(-2).map((e) => [e.type, e.payload.appointmentId, e.payload.paid])).toEqual([
      ["appointment.booked", "50002", false],
      ["appointment.canceled", "50003", true],
    ]);
  });

  it("resumes a later sync at its saved window, and starts a fresh pass after a finished one", async () => {
    const data = account();
    const saved: AcuityCursor = { done: false, pending: [["2026-10-03", "2026-10-31"]], end: "2026-11-30" };
    const mock = acuityDocMock(data);
    const out = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(windows(mock)).toEqual(["2026-10-03..2026-10-31", "2026-11-01..2026-11-30"]);
    expect(eventsOf(out).map((e) => e.payload.appointmentId)).toEqual(["54322", "54323", "60001"]);
    const fresh = acuityDocMock(data);
    await drain(connector(fresh).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ done: true, pending: [], end: null }) }));
    expect(windows(fresh)[0]).toBe("2026-09-12..2026-09-30");
    expect(windows(fresh)).toHaveLength(6);
    await expect(drain(connector(fresh).incrementalSync({ organizationId: TEST_ORG, cursor: "{}" }))).rejects.toThrow("Acuity checkpoint is not in the expected shape");
    await expect(drain(connector(fresh).historicalImport({ organizationId: TEST_ORG, cursor: "[]" }))).rejects.toThrow("Acuity checkpoint is not in the expected shape");
  });

  it("names types from the lookups each pass, and keeps what doesn't read as dead letters", async () => {
    const data = account({ types: [], deletedTypes: [{ id: 1, name: "Engagement ring consult" }] });
    data.appointments![1] = { ...data.appointments![1]!, duration: "soon" };
    const mock = acuityDocMock(data);
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 3, deadLettered: 1 });
    expect(memory.events.map((e) => [e.payload.title, e.payload.hostRefs])).toEqual([
      ["Engagement ring consult", ["acuity:calendar:27238"]],
      ["Engagement ring consult", ["acuity:calendar:27238"]],
      ["Repair drop-off", ["acuity:calendar:27238"]],
    ]);
    expect(memory.deadLetters.map((d) => (d.raw as AcuityEvent).payload)).toEqual([{ system: "Acuity Scheduling", appointmentId: "54322", problems: ["appointment has no duration that reads"] }]);
  });

  it("stops on credentials Acuity turns down, naming the settings and never the key", async () => {
    const wrong = acuityDocMock({ ...account(), apiKey: ["acuity", "test", "y".repeat(20)].join("-") });
    const { memory, pipeline } = testPipeline();
    const error = await runSync({ connector: connector(wrong), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: noSleep }).then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(AcuityConfigError);
    expect(error!.message).toBe("Acuity turned down the credentials (HTTP 401) (unauthorized): Unauthorized; ACUITY_USER_ID must be the numeric user id and ACUITY_API_KEY the API key shown together under Integrations > API in Acuity, on the Premium or Powerhouse plan");
    expect(error!.message).not.toContain(API_KEY);
    expect(await memory.getCheckpoint(TEST_ORG, "acuity", "historical")).toBeNull();
    expect(wrong.reads).toHaveLength(0);
  });

  it("waits out Acuity's rate limit and carries on", async () => {
    const slept: number[] = [];
    const mock = acuityDocMock(account({ rateLimits: 2 }));
    const events = eventsOf(await drain(connector(mock, { sleep: async (ms) => void slept.push(ms) }).historicalImport({ organizationId: TEST_ORG, cursor: null })));
    expect([events.length, slept]).toEqual([4, [1000, 1000]]);
  });

  it("uses the real clock by default, and declares its write, turned down", async () => {
    const before = Date.now();
    const at = new Date(before).toISOString().slice(0, 10);
    const today = acuityDocMock({ userId: USER, apiKey: API_KEY, appointments: [on(1, at)] });
    const out = await drain(acuityConnector({ userId: USER, apiKey: API_KEY, customerKey: REF_KEY, fetch: today.fetch, sleep: noSleep }).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(Date.parse(eventsOf(out)[0]!.receivedAt)).toBeGreaterThanOrEqual(before);
    const c = connector(acuityDocMock(account()));
    expect(c.source).toBe("acuity");
    expect(c.writes).toBe(ACUITY_WRITES);
    expect(ACUITY_WRITES).toEqual([{ integration: "acuity", name: "cancel_appointment", description: "Cancel an Acuity Scheduling appointment", kind: "update", approval: "each", dailyCap: 5 }]);
    expect(c).not.toHaveProperty("handleWebhook");
    // A read-only gate turns the write down and audits it, and it never runs.
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: READ_ONLY, audit });
    let performed = false;
    for (const action of c.writes ?? []) {
      await expect(gate.run(action, "acuity-test", async () => void (performed = true))).rejects.toBeInstanceOf(WritesDisabledError);
    }
    expect(performed).toBe(false);
    expect(audit.entries).toMatchObject([{ action: "cancel_appointment", integration: "acuity" }]);
    expect(audit.entries.map((e) => e.outcome)).not.toContain("performed");
  });
});

describe("Acuity doc mock", () => {
  const get = (mock: AcuityMock, path = "/appointments", query = "", headers: Record<string, string> = { authorization: BASIC }) => mock.fetch(`${ACUITY_API_BASE}${path}${query}`, { headers });
  const ids = async (response: Response) => ((await response.json()) as { id: number }[]).map((a) => a.id);

  it("uses only synthetic data, and says where it came from", () => {
    const data = account();
    assertSynthetic([data.appointments, data.canceled, data.types]);
    const { mock } = acuityDocMock(data);
    expect(mock.source).toEqual({ url: ACUITY_DOC_PAGES.appointments, title: "Acuity Scheduling API reference: Get appointments", retrievedOn: "2026-11-11", version: "v1" });
    expect(mock.auth).toBe("basic");
    expect(mock.routes.map((r) => `${r.method} ${r.path} ${r.documentedAt}`)).toEqual([`GET /appointments ${ACUITY_DOC_PAGES.appointments}`, `GET /appointment-types ${ACUITY_DOC_PAGES.appointmentTypes}`]);
    const module = DOC_MOCK_MODULES.find((m) => m.integration === "acuity")!;
    expect(module.watchPages).toEqual(Object.values(ACUITY_DOC_PAGES));
    expect(module.docMocks().map((m) => m.integration)).toEqual(["acuity"]);
    expect(Object.values(ACUITY_DOC_PAGES).every((u) => u.startsWith("https://developers.acuityscheduling.com/reference/"))).toBe(true);
    expect(acuityAppointment.one()).toMatchObject({ datetime: expect.stringMatching(/T10:00:00-0400$/) });
  });

  it("checks the credentials, as the docs' 401 says", async () => {
    const mock = acuityDocMock(account());
    const wrong = await get(mock, "/appointments", "", { authorization: `Basic ${Buffer.from(`${USER}:other`).toString("base64")}` });
    expect([wrong.status, await wrong.json()]).toEqual([401, { status_code: 401, message: "Unauthorized", error: "unauthorized" }]);
    expect((await get(mock, "/appointment-types", "", {})).status).toBe(401);
    expect((await get(mock, "/appointment-types", "", { authorization: `Bearer ${API_KEY}` })).status).toBe(401);
    expect((await get(mock)).status).toBe(200);
  });

  it("lists appointments by day, newest first by default, at most max, and the canceled list apart", async () => {
    reset();
    const appointments = acuityAppointment.many(5);
    const mock = acuityDocMock({ userId: USER, apiKey: API_KEY, appointments, canceled: [on(60001, "2026-10-03")] });
    expect(await ids(await get(mock))).toEqual([54325, 54324, 54323, 54322, 54321]);
    expect(await ids(await get(mock, "/appointments", "?direction=ASC&minDate=2026-10-03&maxDate=2026-10-05"))).toEqual([54322, 54323, 54324]);
    expect(await ids(await get(mock, "/appointments", "?max=2&direction=ASC"))).toEqual([54321, 54322]);
    expect(await ids(await get(mock, "/appointments", "?canceled=true"))).toEqual([60001]);
    expect(await ids(await get(mock, "/appointments", "?showall=true&minDate=2026-10-03&maxDate=2026-10-03"))).toEqual([60001, 54322].sort((a, b) => b - a));
    expect(await ids(await get(mock, "/appointments", "?appointmentTypeID=2&calendarID=27238"))).toEqual([54324, 54322]);
    expect(await ids(await get(mock, "/appointments", "?calendarID=1"))).toEqual([]);
    const full = (await (await get(mock, "/appointments", "?max=1")).json()) as AcuityMockRecord[];
    expect(full[0]).toHaveProperty("forms");
    const trimmed = (await (await get(mock, "/appointments", "?max=1&excludeForms=true")).json()) as AcuityMockRecord[];
    expect(trimmed[0]).not.toHaveProperty("forms");
    expect(trimmed[0]).not.toHaveProperty("formsText");
    expect(trimmed[0]).toHaveProperty("notes");
    expect(mock.reads.at(-1)).toEqual({ minDate: null, maxDate: null, canceled: false, max: 1, returned: 1 });
  });

  it("lists appointment types, deleted ones only when asked", async () => {
    reset();
    const mock = acuityDocMock({ userId: USER, apiKey: API_KEY, types: acuityAppointmentType.many(2), deletedTypes: [{ id: 9, name: "Old" }] });
    expect(await ids(await get(mock, "/appointment-types"))).toEqual([1, 2]);
    expect(await ids(await get(mock, "/appointment-types", "?includeDeleted=false"))).toEqual([1, 2]);
    expect(await ids(await get(mock, "/appointment-types", "?includeDeleted=true"))).toEqual([1, 2, 9]);
    expect(await (await get(acuityDocMock({ userId: USER, apiKey: API_KEY }), "/appointment-types")).json()).toEqual([]);
    for (const q of ["", "?canceled=true", "?showall=true"]) expect(await (await get(acuityDocMock({ userId: USER, apiKey: API_KEY }), "/appointments", q)).json(), q).toEqual([]);
  });

  it("answers 400 and 429 as the docs say", async () => {
    const mock = acuityDocMock(account({ rateLimits: 1 }));
    const limited = await get(mock);
    expect([limited.status, limited.headers.get("retry-after"), await limited.json()]).toEqual([429, "1", { status_code: 429, message: "Rate limit reached. Limit 10req/s and 20 concurrent connections.", error: "too_many_requests" }]);
    for (const q of ["?max=0", "?max=1.5", "?max=x", "?minDate=2026-10", "?maxDate=October", "?canceled=yes", "?showall=1", "?excludeForms=no", "?direction=up", "?offset=100", "?page=2", "?email=customer1@example.test"]) {
      const r = await get(mock, "/appointments", q);
      expect(r.status, q).toBe(400);
      expect(((await r.json()) as { error: string }).error, q).toBe("bad_request");
    }
    expect((await get(mock, "/appointment-types", "?includeDeleted=maybe")).status).toBe(400);
    expect((await get(mock, "/appointment-types", "?max=1")).status).toBe(400);
  });

  it("throws on a look-alike host and anything the docs don't list", async () => {
    const mock = acuityDocMock(account());
    await expect(mock.fetch("https://acuityscheduling.com.example.test/api/v1/appointments", {})).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${ACUITY_API_BASE}/appointments`, { method: "POST", body: "{}", headers: { authorization: BASIC } })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${ACUITY_API_BASE}/appointments/54321/cancel`, { method: "PUT", body: "{}", headers: { authorization: BASIC } })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${ACUITY_API_BASE}/clients`, { headers: { authorization: BASIC } })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${ACUITY_API_BASE}/calendars`, { headers: { authorization: BASIC } })).rejects.toThrow(UndocumentedRequestError);
    expect(mock.fetch.calls).toEqual([]);
  });
});
