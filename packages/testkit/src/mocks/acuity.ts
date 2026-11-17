import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * The Acuity Scheduling API (v1) lists a read-only connector uses, built
 * from Acuity's developer docs. Data is synthetic. Acuity has no sandbox and
 * API access needs a paid plan; once an account's credentials are set up,
 * recordings replace this mock.
 *
 * Docs facts the mock relies on:
 * - Base URL https://acuityscheduling.com/api/v1, with HTTP Basic auth: the
 *   numeric user id as the username and the API key as the password; a
 *   failed sign-in answers 401 (quick-start).
 * - `GET /appointments` takes max (100 by default, no maximum given),
 *   minDate and maxDate ("this date and after", "this date and before"),
 *   calendarID, appointmentTypeID, canceled (false by default: canceled
 *   ones only when true), showall (canceled and scheduled together),
 *   direction (ASC or DESC, DESC by default) and excludeForms, among
 *   others. It has no offset, page or cursor, and answers a JSON array
 *   (get-appointments).
 * - An appointment has id, firstName, lastName, phone, email, date, time,
 *   endTime, dateCreated ("June 17, 2013"), datetime
 *   ("2013-07-02T10:15:00-0700"), price and amountPaid ("10.00"), paid
 *   ("yes" or "no"), type, appointmentTypeID, duration ("60"), calendar,
 *   calendarID, forms with their values, notes, labels and more; a canceled
 *   one has noShow.
 * - `GET /appointment-types` takes includeDeleted (false by default); a type
 *   has id, name, duration, price and more (appointment-types).
 * - Errors are {status_code, message, error}: 400 bad_request, 401
 *   unauthorized, 429 too_many_requests "Rate limit reached. Limit 10req/s
 *   and 20 concurrent connections." (api-errors).
 */
const BASE = "https://acuityscheduling.com/api/v1";
const REF = "https://developers.acuityscheduling.com/reference";
export const ACUITY_DOC_PAGES = {
  appointments: `${REF}/get-appointments`,
  appointmentTypes: `${REF}/appointment-types`,
} as const;
const APPOINTMENT_QUERY = new Set(["max", "minDate", "maxDate", "calendarID", "appointmentTypeID", "canceled", "showall", "direction", "excludeForms"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type AcuityMockRecord = Record<string, unknown>;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** A day written as Acuity writes dates for people: "October 2, 2026". */
const shown = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const local = (n: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

/** Appointment `n`: at 10:00 New York time, `n` days after 2026-10-01, 45 minutes, paid, with a client, notes, an intake form and a calendar named after staff, all of which the connector must drop. */
export const acuityAppointment = fixtureBuilder<AcuityMockRecord>((n) => ({
  id: 54320 + n,
  firstName: "Test",
  lastName: `Customer${n}`,
  phone: synthetic.phone(n),
  email: synthetic.email(n),
  date: shown(local(n)),
  time: "10:00am",
  endTime: "10:45am",
  dateCreated: shown(local(n - 7)),
  datetime: `${local(n)}T10:00:00-0400`,
  price: "45.00",
  paid: "yes",
  amountPaid: "45.00",
  type: n % 2 ? "Bridal consultation" : "Repair drop-off",
  appointmentTypeID: n % 2 ? 1 : 2,
  addonIDs: [],
  classID: null,
  duration: "45",
  calendar: "Test Staff 1",
  calendarID: 27238,
  canClientCancel: true,
  canClientReschedule: true,
  location: "1 Test Street, Testville",
  certificate: null,
  confirmationPage: `https://acuityscheduling.com/schedule.php?owner=1&id[]=test${n}&action=appt`,
  formsText: "Is this your first visit?: yes",
  notes: "A test note the connector must drop",
  timezone: "America/New_York",
  forms: [{ id: 1, name: "Test intake form", values: [{ value: "yes", name: "Is this your first visit?", fieldID: 1, id: 21500 + n }] }],
  labels: [{ id: 3, name: "Completed", color: "pink" }],
}));

/** Appointment type `n`: odd ones bridal consultations, even ones repair drop-offs. */
export const acuityAppointmentType = fixtureBuilder<AcuityMockRecord>((n) => ({
  id: n,
  active: true,
  name: n % 2 ? "Bridal consultation" : "Repair drop-off",
  description: "A test appointment type",
  duration: 45,
  price: "45.00",
  category: "",
  color: "#AAAAAA",
  private: false,
  type: "service",
  classSize: null,
  paddingAfter: 0,
  paddingBefore: 0,
  calendarIDs: [27238],
}));

export interface AcuityMockData {
  userId: string;
  apiKey: string;
  /** Scheduled appointments. */
  appointments?: AcuityMockRecord[];
  /** Canceled appointments. */
  canceled?: AcuityMockRecord[];
  types?: AcuityMockRecord[];
  /** Deleted appointment types, listed only with includeDeleted=true. */
  deletedTypes?: AcuityMockRecord[];
  /** 429s to answer before the next calls. */
  rateLimits?: number;
}

export interface AcuityMock {
  mock: DocMock;
  fetch: DocMockFetch;
  /** Each appointment list answered: its days, which list, and how many it asked for and got. */
  readonly reads: { minDate: string | null; maxDate: string | null; canceled: boolean; max: number; returned: number }[];
}

const error = (status: number, code: string, message: string, headers?: Record<string, string>): DocMockResponse => ({ status, body: { status_code: status, message, error: code }, ...(headers ? { headers } : {}) });
const bad = (message: string) => error(400, "bad_request", message);
const boolean = (value: string | null, fallback: boolean): boolean | null => (value === null ? fallback : value === "true" ? true : value === "false" ? false : null);
const localDay = (a: AcuityMockRecord) => String(a.datetime).slice(0, 10);

export function acuityDocMock(data: AcuityMockData): AcuityMock {
  const reads: AcuityMock["reads"] = [];
  let limits = data.rateLimits ?? 0;
  const expected = `Basic ${Buffer.from(`${data.userId}:${data.apiKey}`).toString("base64")}`;

  /** Checks the credentials and the rate limit, then answers. */
  const guarded = (answer: (request: DocMockRequest) => DocMockResponse) => (request: DocMockRequest): DocMockResponse => {
    if (request.headers.get("authorization") !== expected) return error(401, "unauthorized", "Unauthorized");
    if (limits > 0) {
      limits--;
      return error(429, "too_many_requests", "Rate limit reached. Limit 10req/s and 20 concurrent connections.", { "retry-after": "1" });
    }
    return answer(request);
  };

  const appointments = guarded((request) => {
    const q = request.url.searchParams;
    const unknown = [...q.keys()].find((k) => !APPOINTMENT_QUERY.has(k));
    if (unknown) return bad(`Unknown parameter "${unknown}".`);
    const max = q.get("max") === null ? 100 : Number(q.get("max"));
    if (!Number.isInteger(max) || max < 1) return bad('"max" must be a positive integer.');
    const minDate = q.get("minDate");
    const maxDate = q.get("maxDate");
    if ((minDate !== null && !DAY.test(minDate)) || (maxDate !== null && !DAY.test(maxDate))) return bad("Dates must be written YYYY-MM-DD.");
    const canceled = boolean(q.get("canceled"), false);
    const showall = boolean(q.get("showall"), false);
    const excludeForms = boolean(q.get("excludeForms"), false);
    if (canceled === null || showall === null || excludeForms === null) return bad("Boolean parameters must be true or false.");
    const direction = q.get("direction") ?? "DESC";
    if (direction !== "ASC" && direction !== "DESC") return bad('"direction" must be ASC or DESC.');
    const calendarID = q.get("calendarID");
    const typeID = q.get("appointmentTypeID");
    const pool = showall ? [...(data.appointments ?? []), ...(data.canceled ?? [])] : canceled ? (data.canceled ?? []) : (data.appointments ?? []);
    const found = pool
      .filter((a) => (minDate === null || localDay(a) >= minDate) && (maxDate === null || localDay(a) <= maxDate))
      .filter((a) => (calendarID === null || String(a.calendarID) === calendarID) && (typeID === null || String(a.appointmentTypeID) === typeID))
      .sort((a, b) => Date.parse(String(a.datetime)) - Date.parse(String(b.datetime)) || Number(a.id) - Number(b.id));
    if (direction === "DESC") found.reverse();
    const page = found.slice(0, max).map((a) => (excludeForms ? Object.fromEntries(Object.entries(a).filter(([k]) => k !== "forms" && k !== "formsText")) : a));
    reads.push({ minDate, maxDate, canceled, max, returned: page.length });
    return { status: 200, body: page };
  });

  const appointmentTypes = guarded((request) => {
    const q = request.url.searchParams;
    if ([...q.keys()].some((k) => k !== "includeDeleted")) return bad("Unknown parameter.");
    const includeDeleted = boolean(q.get("includeDeleted"), false);
    if (includeDeleted === null) return bad("Boolean parameters must be true or false.");
    return { status: 200, body: [...(data.types ?? []), ...(includeDeleted ? (data.deletedTypes ?? []) : [])] };
  });

  const mock = checkDocMock({
    integration: "acuity",
    baseUrl: BASE,
    source: { url: ACUITY_DOC_PAGES.appointments, title: "Acuity Scheduling API reference: Get appointments", retrievedOn: "2026-11-11", version: "v1" },
    auth: "basic",
    assumptions: [
      "minDate and maxDate are written YYYY-MM-DD and compared with the day of the appointment's own datetime; the docs type them only as dates",
      "max has no upper bound the mock enforces; the connector asks for no more than the documented default of 100",
      "An answer with direction=ASC is ordered by start time, earliest first",
      "A parameter the mock doesn't implement, or a value that doesn't read, is answered 400 bad_request",
      "A 429 carries Retry-After; the docs give only the message",
    ],
    routes: [
      { method: "GET", path: "/appointments", documentedAt: ACUITY_DOC_PAGES.appointments, respond: appointments },
      { method: "GET", path: "/appointment-types", documentedAt: ACUITY_DOC_PAGES.appointmentTypes, respond: appointmentTypes },
    ],
  });
  return {
    mock,
    fetch: docMockFetch(mock),
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "acuity",
  covers: "The Acuity Scheduling API's appointment and appointment type lists (v1), with Basic auth, date windows, max and the canceled list",
  watchPages: [ACUITY_DOC_PAGES.appointments, ACUITY_DOC_PAGES.appointmentTypes],
  docMocks: () => [acuityDocMock({ userId: "", apiKey: "" }).mock],
} satisfies DocMockModule;
