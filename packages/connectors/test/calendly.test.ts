import { describe, expect, it } from "vitest";
import { runSync } from "@karatos/core";
import {
  CALENDLY_TEST_ORGANIZATION,
  CALENDLY_TEST_USER,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  calendlyDocMock,
  calendlyInvitee,
  calendlyScheduledEvent,
  checkConnectorSync,
  docMockFetch,
  testPipeline,
  type CalendlyInvitee,
  type CalendlyMockData,
  type CalendlyScheduledEvent,
} from "@karatos/connector-testkit";
import {
  CALENDLY_API,
  CALENDLY_EVENT_TYPES,
  CALENDLY_NO_SHOW_DAYS,
  CALENDLY_PAGE_SIZE,
  CALENDLY_RECENT_DAYS,
  CALENDLY_WRITES,
  CalendlyApiError,
  CalendlyConfigError,
  appointmentEvent,
  appointmentKind,
  calendlyClient,
  calendlyConnector,
  calendlyId,
  calendlyTime,
  formCustomerRefs,
  parseCalendlyCursor,
  type CalendlyCursor,
  type CalendlyOptions,
} from "../src/index.js";

const TOKEN = ["calendly", "x".repeat(40)].join(".");
const KEY = "x".repeat(64);
const NOW = new Date("2026-10-28T12:00:00Z");
const RECEIVED = NOW.toISOString();
const noSleep = async () => {};

const at = (iso: string) => iso.replace(/(\.\d+)?Z$/, ".000000Z");
const eventUri = (id: string) => `${CALENDLY_API}/scheduled_events/${id}`;

function event(id: string, start: string, extra: Partial<CalendlyScheduledEvent> = {}): CalendlyScheduledEvent {
  return calendlyScheduledEvent.one({
    uri: eventUri(id),
    start_time: at(start),
    end_time: at(new Date(Date.parse(start) + 45 * 60_000).toISOString()),
    name: "Bridal consultation",
    event_type: `${CALENDLY_API}/event_types/TYPE-TEST-1`,
    created_at: "2024-01-01T00:00:00.000000Z",
    updated_at: "2024-01-01T00:00:00.000000Z",
    ...extra,
  });
}

function invitee(eventId: string, id: string, n: number, extra: Partial<CalendlyInvitee> = {}): CalendlyInvitee {
  return calendlyInvitee.one({
    uri: `${eventUri(eventId)}/invitees/${id}`,
    event: eventUri(eventId),
    email: `customer${n}@example.test`,
    name: `Test Customer${n}`,
    first_name: "Test",
    last_name: `Customer${n}`,
    text_reminder_number: `+1 212 555 01${String(n).padStart(2, "0")}`,
    created_at: at(`2024-0${1 + (n % 9)}-0${1 + (n % 9)}T12:00:00Z`),
    updated_at: at(`2024-0${1 + (n % 9)}-0${1 + (n % 9)}T12:00:00Z`),
    ...extra,
  });
}

/**
 * Against NOW (2026-10-28 noon): the history window starts 2024-10-28, the
 * recent span 2026-09-28 and the no-show span 2026-10-14.
 */
function account(extra: Partial<CalendlyMockData> = {}): CalendlyMockData {
  return {
    token: TOKEN,
    events: [
      event("EV-OLD", "2023-01-10T15:00:00Z"),
      event("EV-1", "2025-06-01T15:00:00Z"),
      event("EV-2", "2026-09-01T15:00:00Z"),
      event("EV-3", "2026-10-20T15:00:00Z"),
      event("EV-4", "2026-10-05T15:00:00Z"),
      event("EV-5", "2026-11-15T15:00:00Z"),
      event("EV-GROUP", "2026-12-01T15:00:00Z", { name: "Trunk show visit", invitees_counter: { total: 2, active: 2, limit: 10 } }),
      event("EV-BAD", "2026-11-20T15:00:00Z"),
    ],
    invitees: {
      "EV-OLD": [invitee("EV-OLD", "INV-OLD", 9)],
      "EV-1": [invitee("EV-1", "INV-1", 1)],
      "EV-2": [invitee("EV-2", "INV-2", 2)],
      "EV-3": [invitee("EV-3", "INV-3", 3)],
      "EV-4": [invitee("EV-4", "INV-4", 4)],
      "EV-5": [invitee("EV-5", "INV-5", 5)],
      "EV-GROUP": [invitee("EV-GROUP", "INV-G1", 6), invitee("EV-GROUP", "INV-G2", 7)],
      "EV-BAD": [invitee("EV-BAD", "INV-BAD", 8, { created_at: "yesterday" })],
    },
    ...extra,
  };
}

function connector(data: CalendlyMockData, options: Partial<CalendlyOptions> = {}) {
  const fetch = docMockFetch(calendlyDocMock(data));
  const c = calendlyConnector({ token: TOKEN, customerKey: KEY, now: () => NOW, batchSize: 2, fetch, sleep: noSleep, ...options });
  return { c, fetch };
}

/** A fetch that answers each request from a list, recording what was sent. */
function scripted(responses: (Response | ((url: URL) => Response))[]) {
  const sent: { url: URL; init: RequestInit | undefined }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    sent.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return typeof next === "function" ? next(url) : next;
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ME = { resource: { uri: CALENDLY_TEST_USER, current_organization: CALENDLY_TEST_ORGANIZATION } };
const PAGE = (collection: unknown[], next: string | null = null) => ({ collection, pagination: { next_page_token: next, next_page: next && `${CALENDLY_API}/x?page_token=${next}` } });

describe("the Calendly client", () => {
  it("stops on a token that isn't in the shape Calendly issues, without echoing it", () => {
    for (const token of ["", "short", "x".repeat(30) + " space", "x".repeat(30) + "\n"]) {
      let error: unknown;
      try {
        calendlyClient({ token });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(CalendlyConfigError);
      expect((error as Error).message).toBe("CALENDLY_ACCESS_TOKEN is missing or not in the expected shape");
    }
  });

  it("reads the signed-in user with the bearer token", async () => {
    const { fetch, sent } = scripted([json(200, ME)]);
    expect(await calendlyClient({ token: TOKEN, fetch }).me()).toEqual({ userUri: CALENDLY_TEST_USER, organizationUri: CALENDLY_TEST_ORGANIZATION });
    expect(sent.map((s) => s.url.toString())).toEqual([`${CALENDLY_API}/users/me`]);
    expect(sent[0]!.init?.method).toBe("GET");
    expect(new Headers(sent[0]!.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("stops when the signed-in user has no user or organization that reads", async () => {
    for (const resource of [{}, { uri: CALENDLY_TEST_USER }, { uri: "https://elsewhere.example.test/users/A", current_organization: CALENDLY_TEST_ORGANIZATION }, { uri: CALENDLY_TEST_USER, current_organization: `${CALENDLY_API}/organizations/../x` }]) {
      const { fetch } = scripted([json(200, { resource })]);
      await expect(calendlyClient({ token: TOKEN, fetch }).me()).rejects.toThrow("without a user and organization that read");
    }
  });

  it("asks for scheduled events by start time, earliest first, 100 a page", async () => {
    const { fetch, sent } = scripted([json(200, PAGE([{ uri: "x" }], "tok_2")), json(200, PAGE([]))]);
    const client = calendlyClient({ token: TOKEN, fetch });
    const window = { minStart: "2026-01-01T00:00:00.000Z", maxStart: "2027-01-01T00:00:00.000Z" };
    expect(await client.scheduledEvents({ organization: CALENDLY_TEST_ORGANIZATION }, window)).toEqual({ collection: [{ uri: "x" }], nextPageToken: "tok_2" });
    await client.scheduledEvents({ user: CALENDLY_TEST_USER }, window, "tok_2");
    const [first, second] = sent.map((s) => s.url);
    expect(first!.pathname).toBe("/scheduled_events");
    expect(Object.fromEntries(first!.searchParams)).toEqual({ organization: CALENDLY_TEST_ORGANIZATION, min_start_time: window.minStart, max_start_time: window.maxStart, sort: "start_time:asc", count: String(CALENDLY_PAGE_SIZE) });
    expect(Object.fromEntries(second!.searchParams)).toEqual({ user: CALENDLY_TEST_USER, min_start_time: window.minStart, max_start_time: window.maxStart, sort: "start_time:asc", count: "100", page_token: "tok_2" });
  });

  it("asks for an event's invitees oldest booking first", async () => {
    const { fetch, sent } = scripted([json(200, PAGE([]))]);
    await calendlyClient({ token: TOKEN, fetch }).invitees("EV-1");
    expect(sent[0]!.url.pathname).toBe("/scheduled_events/EV-1/invitees");
    expect(Object.fromEntries(sent[0]!.url.searchParams)).toEqual({ sort: "created_at:asc", count: "100" });
  });

  it("sends nothing for an id, scope, window or page token that doesn't read", async () => {
    const { fetch, sent } = scripted([]);
    const client = calendlyClient({ token: TOKEN, fetch });
    const window = { minStart: "2026-01-01T00:00:00Z", maxStart: "2027-01-01T00:00:00Z" };
    await expect(client.invitees("../users/me")).rejects.toThrow("event id is not a Calendly id");
    await expect(client.invitees("EV-1?x=1")).rejects.toThrow("event id is not a Calendly id");
    await expect(client.scheduledEvents({ organization: CALENDLY_TEST_USER }, window)).rejects.toThrow("not a user or organization URI");
    await expect(client.scheduledEvents({ user: CALENDLY_TEST_ORGANIZATION }, window)).rejects.toThrow("not a user or organization URI");
    await expect(client.scheduledEvents({ organization: "https://elsewhere.example.test/organizations/A" }, window)).rejects.toThrow("not a user or organization URI");
    await expect(client.scheduledEvents({ user: CALENDLY_TEST_USER }, { ...window, minStart: "2026-01-01" })).rejects.toThrow("must be UTC times");
    await expect(client.scheduledEvents({ user: CALENDLY_TEST_USER }, { ...window, maxStart: "2027-01-01T00:00:00+01:00" })).rejects.toThrow("must be UTC times");
    await expect(client.invitees("EV-1", "tok&organization=x")).rejects.toThrow("page token for invitees that isn't in the expected shape");
    expect(sent).toEqual([]);
  });

  it("follows the page token, never the next page link, so a reply can't send the token elsewhere", async () => {
    const { fetch, sent } = scripted([
      json(200, { collection: [], pagination: { next_page_token: "tok_2", next_page: "https://elsewhere.example.test/steal?page_token=tok_2" } }),
      json(200, PAGE([])),
    ]);
    const client = calendlyClient({ token: TOKEN, fetch });
    const page = await client.invitees("EV-1");
    await client.invitees("EV-1", page.nextPageToken);
    expect(sent.map((s) => s.url.origin)).toEqual([CALENDLY_API, CALENDLY_API]);
  });

  it("stops on a page token from Calendly that isn't in the expected shape", async () => {
    for (const next of ["a b", "x".repeat(513), 7, "tok&count=1"]) {
      const { fetch } = scripted([json(200, { collection: [], pagination: { next_page_token: next } })]);
      await expect(calendlyClient({ token: TOKEN, fetch }).invitees("EV-1")).rejects.toThrow("isn't in the expected shape");
    }
  });

  it("explains a turned-down token without showing it", async () => {
    const { fetch } = scripted([json(401, { title: "Unauthenticated", message: `token ${TOKEN} is invalid` })]);
    const error = await calendlyClient({ token: TOKEN, fetch }).me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CalendlyApiError);
    expect(error).toMatchObject({ status: 401, message: "Calendly turned down the token: check CALENDLY_ACCESS_TOKEN, which may have been revoked" });
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });

  it("names the missing scopes on a 403, and only ones that look like scopes", async () => {
    const window = { minStart: "2026-01-01T00:00:00Z", maxStart: "2027-01-01T00:00:00Z" };
    const scope = { organization: CALENDLY_TEST_ORGANIZATION };
    const a = scripted([json(403, { title: "Permission Denied", required_scopes: ["scheduled_events:read"] })]);
    await expect(calendlyClient({ token: TOKEN, fetch: a.fetch }).scheduledEvents(scope, window)).rejects.toMatchObject({ status: 403, message: "Calendly's token is missing the scheduled_events:read scope to read scheduled events" });
    const b = scripted([json(403, { required_scopes: ["<script>", 3, "x".repeat(80) + ":read"] })]);
    await expect(calendlyClient({ token: TOKEN, fetch: b.fetch }).scheduledEvents(scope, window)).rejects.toMatchObject({ message: "Calendly's token isn't allowed to read scheduled events" });
    const c = scripted([new Response("Forbidden", { status: 403 })]);
    await expect(calendlyClient({ token: TOKEN, fetch: c.fetch }).invitees("EV-1")).rejects.toMatchObject({ message: "Calendly's token isn't allowed to read invitees" });
  });

  it("waits out a 429 for the seconds X-RateLimit-Reset gives, up to a minute", async () => {
    const waits: number[] = [];
    const limited = (reset?: string) => json(429, { title: "Too Many Requests" }, reset ? { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": reset } : {});
    const { fetch, sent } = scripted([limited("7"), limited("900"), limited(), json(200, ME)]);
    await calendlyClient({ token: TOKEN, fetch, sleep: async (ms) => void waits.push(ms) }).me();
    expect(waits).toEqual([7_000, 60_000, 4_000]);
    expect(sent).toHaveLength(4);
  });

  it("leaves a 429 to runSync after three waits", async () => {
    const limited = () => json(429, {}, { "X-RateLimit-Reset": "1" });
    const { fetch, sent } = scripted([limited(), limited(), limited(), limited()]);
    await expect(calendlyClient({ token: TOKEN, fetch, sleep: noSleep }).me()).rejects.toMatchObject({ status: 429, message: "Calendly answered HTTP 429 for the signed-in user" });
    expect(sent).toHaveLength(4);
    const once = scripted([limited(), limited()]);
    await expect(calendlyClient({ token: TOKEN, fetch: once.fetch, sleep: noSleep, rateLimitRetries: 1 }).me()).rejects.toMatchObject({ status: 429 });
  });

  it("stops on other errors and on bodies that don't read", async () => {
    const cases: [Response, string][] = [
      [json(500, {}), "Calendly answered HTTP 500 for invitees"],
      [new Response("not json", { status: 200 }), "a body that isn't a JSON object"],
      [json(200, [1, 2]), "a body that isn't a JSON object"],
      [json(200, { collection: "nope" }), "without the collection list"],
    ];
    for (const [response, message] of cases) {
      const { fetch } = scripted([response]);
      await expect(calendlyClient({ token: TOKEN, fetch }).invitees("EV-1")).rejects.toThrow(message);
    }
  });
});

describe("reading Calendly values", () => {
  it("takes the id from a Calendly URI only", () => {
    expect(calendlyId(`${CALENDLY_API}/scheduled_events/EV-1`)).toBe("EV-1");
    expect(calendlyId(`${CALENDLY_API}/scheduled_events/EV-1/invitees/INV-1`)).toBe("INV-1");
    expect(calendlyId(`${CALENDLY_API}/users/USER-1`)).toBe("USER-1");
    for (const bad of [undefined, 7, "", "EV-1", "https://elsewhere.example.test/users/A", `${CALENDLY_API}/users/A/`, `${CALENDLY_API}/users/A?b=c`, `${CALENDLY_API}/users/${"x".repeat(65)}`, `${CALENDLY_API}/a/b/c/d/e`]) {
      expect(calendlyId(bad)).toBeUndefined();
    }
  });

  it("reads UTC times with up to microseconds on real days", () => {
    expect(calendlyTime("2026-10-20T15:00:00.000000Z")).toBe("2026-10-20T15:00:00.000Z");
    expect(calendlyTime("2026-10-20T15:00:00Z")).toBe("2026-10-20T15:00:00.000Z");
    for (const bad of ["2026-02-30T15:00:00Z", "2026-10-20T15:00:00+02:00", "2026-10-20", "2026-10-20T25:00:00Z", "yesterday", 1_700_000_000, null]) {
      expect(calendlyTime(bad)).toBeNull();
    }
  });

  it("reads the kind of appointment from its title", () => {
    const kinds: [string | undefined, string][] = [
      ["Bridal consultation", "bridal"],
      ["Engagement ring design", "bridal"],
      ["Custom design meeting", "custom_design"],
      ["CAD review", "custom_design"],
      ["Ring resizing", "repair"],
      ["Repair drop-off", "repair"],
      ["Watch service", "repair"],
      ["Insurance appraisal", "appraisal"],
      ["Order pickup", "pickup"],
      ["30 minute consultation", "consultation"],
      ["Showroom visit", "consultation"],
      ["Trunk show", "other"],
      [undefined, "other"],
    ];
    for (const [title, kind] of kinds) expect(appointmentKind(title), title).toBe(kind);
  });
});

describe("Calendly appointments", () => {
  const ev = () => event("EV-1", "2026-10-20T15:00:00Z", { location: { type: "physical", location: "1 Test Street, Testville" }, meeting_notes_plain: "Wants a sapphire, budget noted" });
  const inv = (extra: Partial<CalendlyInvitee> = {}) =>
    invitee("EV-1", "INV-1", 1, {
      questions_and_answers: [
        { question: "What would you like to talk about?", answer: "My partner's ring size is 6", position: 0 },
        { question: "Anything else?", answer: " ", position: 1 },
      ],
      ...extra,
    });

  it("turns a booking into an appointment event with no personal details", () => {
    const read = appointmentEvent(ev(), inv(), KEY, RECEIVED);
    expect(read.ok).toBe(true);
    const { event: e } = read;
    expect(e.type).toBe(CALENDLY_EVENT_TYPES.booked);
    expect(e.occurredAt).toBe(calendlyTime(inv().created_at));
    expect(e.receivedAt).toBe(RECEIVED);
    expect(e.idempotencyKey).toMatch(/^calendly:invitee:INV-1:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace("calendly:", "calendly_").replace(/:/g, "_"));
    expect(e.payload).toEqual({
      system: "Calendly",
      appointmentId: "INV-1",
      calendlyEventId: "EV-1",
      eventTypeId: "TYPE-TEST-1",
      title: ev().name,
      kind: appointmentKind(ev().name!),
      status: "booked",
      startAt: "2026-10-20T15:00:00.000Z",
      endAt: "2026-10-20T15:45:00.000Z",
      durationMinutes: 45,
      location: "in_person",
      hostRefs: ["calendly:user:USER-TEST-1"],
      customerRefs: formCustomerRefs(KEY, { email: "customer1@example.test", phone: "+1 212 555 0101" }),
      guestCount: 0,
      answeredQuestions: 1,
      bookedAt: calendlyTime(inv().created_at),
      bookedByStaffRef: undefined,
      rescheduled: false,
      replacesAppointmentId: undefined,
      replacedByAppointmentId: undefined,
      canceledAt: undefined,
      canceledBy: undefined,
      noShowAt: undefined,
      reconfirmed: undefined,
      payment: undefined,
      source: { source: "instagram", medium: "social", campaign: "test-fall" },
    });
    const stored = JSON.stringify(e);
    for (const secret of ["customer1@example.test", "Customer1", "555 0101", "ring size", "sapphire", "Test Street", "cancellations", "reschedulings", "host@example.test", "Test Host", "America/New_York"]) {
      expect(stored, secret).not.toContain(secret);
    }
    assertSynthetic(e);
  });

  it("links a booking to the same customer as a form submission from that address", () => {
    const a = appointmentEvent(ev(), inv({ email: " Customer1@Example.TEST " }), KEY, RECEIVED).event;
    expect(a.payload.customerRefs).toEqual(formCustomerRefs(KEY, { email: "customer1@example.test", phone: "+1 212 555 0101" }));
    const noContact = appointmentEvent(ev(), inv({ email: "not an email", text_reminder_number: null }), KEY, RECEIVED).event;
    expect(noContact.payload.customerRefs).toEqual([]);
    const other = appointmentEvent(ev(), inv(), "y".repeat(64), RECEIVED).event;
    expect(other.payload.customerRefs).not.toEqual(a.payload.customerRefs);
  });

  it("drops a title that carries the invitee's name or email", () => {
    for (const name of ["Meeting with Test Customer1", "customer1 / ring", "CUSTOMER1@example.test pickup", "Call: Customer1"]) {
      const e = appointmentEvent(event("EV-1", "2026-10-20T15:00:00Z", { name }), inv(), KEY, RECEIVED).event;
      expect(e.payload.title, name).toBeUndefined();
      expect(JSON.stringify(e)).not.toMatch(/customer1/i);
    }
    // Short names are matched as whole words, so they are caught without dropping titles that only contain the letters.
    const short = inv({ name: "Al Li", first_name: "Al", last_name: "Li", email: "al.li@example.test" });
    for (const name of ["Fitting for Al Li", "Li: ring sizing", "al-li pickup"]) {
      expect(appointmentEvent(event("EV-1", "2026-10-20T15:00:00Z", { name }), short, KEY, RECEIVED).event.payload.title, name).toBeUndefined();
    }
    expect(appointmentEvent(event("EV-1", "2026-10-20T15:00:00Z", { name: "Bridal consultation" }), short, KEY, RECEIVED).event.payload.title).toBe("Bridal consultation");
    // The kind is still read from the title it didn't keep.
    expect(appointmentEvent(event("EV-1", "2026-10-20T15:00:00Z", { name: "Customer1 bridal" }), inv(), KEY, RECEIVED).event.payload.kind).toBe("bridal");
    const long = "Bridal consultation ".repeat(10);
    expect(appointmentEvent(event("EV-1", "2026-10-20T15:00:00Z", { name: long }), inv(), KEY, RECEIVED).event.payload.title).toBe(long.trim().slice(0, 80));
  });

  it("keeps only the kind of place", () => {
    const kinds: [string, string][] = [
      ["physical", "in_person"],
      ["outbound_call", "phone"],
      ["inbound_call", "phone"],
      ["zoom", "video"],
      ["google_conference", "video"],
      ["microsoft_teams_conference", "video"],
      ["custom", "custom"],
      ["ask_invitee", "ask_invitee"],
      ["carrier_pigeon", "unknown"],
    ];
    for (const [type, kind] of kinds) {
      const e = appointmentEvent(event("EV-1", "2026-10-20T15:00:00Z", { location: { type, location: "+1 212 555 0199", join_url: "https://zoom.example.test/j/1" } }), inv(), KEY, RECEIVED).event;
      expect(e.payload.location, type).toBe(kind);
      expect(JSON.stringify(e)).not.toMatch(/0199|zoom\.example/);
    }
    expect(appointmentEvent(event("EV-1", "2026-10-20T15:00:00Z", { location: undefined as never }), inv(), KEY, RECEIVED).event.payload.location).toBe("unknown");
  });

  it("records a cancellation, when it happened and who cancelled, without the reason", () => {
    const cancellation = { canceled_by: "Test Customer1", reason: "Found a ring elsewhere", canceler_type: "invitee" as const, created_at: "2026-10-18T09:30:00.000000Z" };
    const e = appointmentEvent(ev(), inv({ status: "canceled", cancellation }), KEY, RECEIVED).event;
    expect(e.type).toBe(CALENDLY_EVENT_TYPES.canceled);
    expect(e.occurredAt).toBe("2026-10-18T09:30:00.000Z");
    expect(e.payload).toMatchObject({ status: "canceled", canceledAt: "2026-10-18T09:30:00.000Z", canceledBy: "invitee" });
    expect(JSON.stringify(e)).not.toMatch(/elsewhere|Customer1/);
    // A host cancelling a group event is on the event, not the invitee.
    const host = appointmentEvent(event("EV-1", "2026-10-20T15:00:00Z", { status: "canceled", cancellation: { ...cancellation, canceler_type: "host" } }), inv({ status: "canceled" }), KEY, RECEIVED).event;
    expect(host.payload).toMatchObject({ canceledBy: "host", canceledAt: "2026-10-18T09:30:00.000Z" });
    // Without a time, the cancellation happened no later than the booking says.
    const untimed = appointmentEvent(ev(), inv({ status: "canceled" }), KEY, RECEIVED).event;
    expect(untimed.occurredAt).toBe(calendlyTime(inv().created_at));
    expect(untimed.payload.canceledBy).toBeUndefined();
  });

  it("records a no-show when it was marked", () => {
    const e = appointmentEvent(ev(), inv({ no_show: { uri: `${CALENDLY_API}/invitee_no_shows/NS-1`, created_at: "2026-10-20T16:00:00.000000Z" } }), KEY, RECEIVED).event;
    expect(e.type).toBe(CALENDLY_EVENT_TYPES.noShow);
    expect(e.occurredAt).toBe("2026-10-20T16:00:00.000Z");
    expect(e.payload).toMatchObject({ status: "no_show", noShowAt: "2026-10-20T16:00:00.000Z" });
  });

  it("links a reschedule both ways and notes staff bookings, payments and reconfirmations", () => {
    const e = appointmentEvent(
      event("EV-1", "2026-10-20T15:00:00Z", { event_guests: [{ email: "guest@example.test", created_at: "x", updated_at: "x" }] }),
      inv({
        rescheduled: true,
        old_invitee: `${CALENDLY_API}/scheduled_events/EV-0/invitees/INV-0`,
        new_invitee: `${CALENDLY_API}/scheduled_events/EV-2/invitees/INV-2`,
        invitee_scheduled_by: `${CALENDLY_API}/users/USER-TEST-2`,
        payment: { external_id: "ch_test", provider: "stripe", amount: 49.99, currency: "USD", terms: "Deposit, credited at purchase", successful: true },
        reconfirmation: { created_at: "2026-10-19T15:00:00.000000Z", confirmed_at: "2026-10-19T16:00:00.000000Z" },
      }),
      KEY,
      RECEIVED,
    ).event;
    expect(e.payload).toMatchObject({
      rescheduled: true,
      replacesAppointmentId: "INV-0",
      replacedByAppointmentId: "INV-2",
      bookedByStaffRef: "calendly:user:USER-TEST-2",
      guestCount: 1,
      payment: { provider: "stripe", amountCents: 4999, currency: "USD", successful: true },
      reconfirmed: true,
    });
    expect(JSON.stringify(e)).not.toMatch(/guest@|ch_test|Deposit/);
    for (const [amount, amountCents] of [[0.29, 29], [19.99, 1999], [1.005, 101], [250, 25000]] as const) {
      const paid = appointmentEvent(ev(), inv({ payment: { external_id: "x", provider: "paypal", amount, currency: "USD", terms: null, successful: true } }), KEY, RECEIVED).event;
      expect(paid.payload.payment, String(amount)).toMatchObject({ provider: "paypal", amountCents });
    }
    const odd = appointmentEvent(ev(), inv({ payment: { external_id: "x", provider: "venmo" as never, amount: -5, currency: "US Dollars", terms: null, successful: false }, reconfirmation: { created_at: "x", confirmed_at: null } }), KEY, RECEIVED).event;
    expect(odd.payload).toMatchObject({ payment: { provider: "other", amountCents: null, currency: "US ", successful: false }, reconfirmed: false });
  });

  it("keeps UTM values short and leaves out the ones not set", () => {
    const tracking = { utm_source: "x".repeat(200), utm_medium: null, utm_campaign: " ", utm_content: "ad-7", utm_term: "rings", salesforce_uuid: null };
    expect(appointmentEvent(ev(), inv({ tracking }), KEY, RECEIVED).event.payload.source).toEqual({ source: "x".repeat(80) });
    expect(appointmentEvent(ev(), inv({ tracking: { ...tracking, utm_source: null } }), KEY, RECEIVED).event.payload.source).toBeUndefined();
  });

  it("is a duplicate when read again unchanged and a new event when it changes", () => {
    const a = appointmentEvent(ev(), inv(), KEY, RECEIVED).event;
    const b = appointmentEvent(ev(), inv(), KEY, "2026-10-29T00:00:00.000Z").event;
    expect(b.idempotencyKey).toBe(a.idempotencyKey);
    const canceled = appointmentEvent(ev(), inv({ status: "canceled" }), KEY, RECEIVED).event;
    expect(canceled.idempotencyKey).not.toBe(a.idempotencyKey);
    // Changes to what isn't kept, such as an answer, don't make a new event.
    expect(appointmentEvent(ev(), inv({ questions_and_answers: [{ question: "Q", answer: "Different", position: 0 }] }), KEY, RECEIVED).event.idempotencyKey).toBe(a.idempotencyKey);
  });

  it("dead-letters what doesn't read, listing why and keeping nothing personal", () => {
    const cases: [unknown, unknown, string][] = [
      [ev(), null, "invitee is not an object"],
      ["nope", inv(), "event is not an object"],
      [ev(), inv({ uri: "https://elsewhere.example.test/x" }), "invitee has no id that reads"],
      [{ ...ev(), uri: 7 }, inv(), "event has no id that reads"],
      [{ ...ev(), start_time: "soon" }, inv(), "event has no start time that reads"],
      [{ ...ev(), end_time: undefined }, inv(), "event has no end time that reads"],
      [{ ...ev(), end_time: "2026-10-20T14:00:00.000000Z" }, inv(), "event ends before it starts"],
      [ev(), inv({ created_at: "2026-13-01T00:00:00Z" }), "invitee has no booking time that reads"],
      [ev(), inv({ status: "pending" as never }), "invitee status is not active or canceled"],
    ];
    for (const [rawEvent, rawInvitee, problem] of cases) {
      const read = appointmentEvent(rawEvent, rawInvitee, KEY, RECEIVED);
      expect(read.ok, problem).toBe(false);
      expect(read.event.occurredAt).toBeUndefined();
      expect(read.event.idempotencyKey).toMatch(/^calendly:unreadable_invitee:[0-9a-f]{12}$/);
      expect(read.event.payload.problems).toContain(problem);
      expect(Object.keys(read.event.payload).sort()).toEqual(["appointmentId", "calendlyEventId", "problems", "system"]);
      expect(JSON.stringify(read.event)).not.toMatch(/customer1|555 0101|ring size/i);
    }
  });
});

describe("the Calendly connector", () => {
  it("imports, replays, resumes and retries the mocked account", async () => {
    // Seven appointments in the window; the one from 2023 is outside it and the unreadable one is dead-lettered.
    const result = await checkConnectorSync({ makeConnector: () => connector(account()).c, expected: { ingested: 7, deadLettered: 1 } });
    expect(result.full).toMatchObject({ ingested: 7, deadLettered: 1 });
    expect(result.resume).not.toBeNull();
  });

  it("reads two years back to a year ahead, earliest first, with every invitee of a group event", async () => {
    const { c, fetch } = connector(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 7, deadLettered: 1 });
    const list = new URL(fetch.calls.find((call) => call.url.includes("/scheduled_events?"))!.url);
    expect(list.searchParams.get("organization")).toBe(CALENDLY_TEST_ORGANIZATION);
    expect(list.searchParams.get("min_start_time")).toBe("2024-10-28T12:00:00.000Z");
    expect(list.searchParams.get("max_start_time")).toBe("2027-10-29T12:00:00.000Z");
    const read = fetch.calls.filter((call) => call.url.includes("/invitees")).map((call) => new URL(call.url).pathname.split("/")[2]);
    expect(read).toEqual(["EV-1", "EV-2", "EV-4", "EV-3", "EV-5", "EV-BAD", "EV-GROUP"]);
    const stored = memory.events.map((e) => e.payload.appointmentId).sort();
    expect(stored).toEqual(["INV-1", "INV-2", "INV-3", "INV-4", "INV-5", "INV-G1", "INV-G2"]);
    expect(memory.deadLetters).toHaveLength(1);
    assertSynthetic(memory.events);
    expect(JSON.stringify(memory.events)).not.toMatch(/@example\.test|Customer\d/);
  });

  it("honors a shorter history window", async () => {
    const { c, fetch } = connector(account(), { historyYears: 1 });
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(new URL(fetch.calls[1]!.url).searchParams.get("min_start_time")).toBe("2025-10-28T12:00:00.000Z");
    expect(memory.events.map((e) => e.payload.appointmentId)).not.toContain("INV-1");
  });

  it("reads the token owner's own events when they can't read the organization's", async () => {
    const { c, fetch } = connector(account({ orgAdmin: false }));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(7);
    const lists = fetch.calls.filter((call) => call.url.includes("/scheduled_events?")).map((call) => new URL(call.url).searchParams);
    expect(lists[0]!.get("organization")).toBe(CALENDLY_TEST_ORGANIZATION);
    expect(lists.slice(1).every((q) => q.get("user") === CALENDLY_TEST_USER && !q.has("organization"))).toBe(true);
  });

  it("doesn't fall back to the owner's events when a later page is turned down", async () => {
    const responses = [json(200, ME), json(200, PAGE([], "tok_2")), json(403, {})];
    const { fetch, sent } = scripted(responses);
    const { c } = connector(account(), { fetch });
    await expect(runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG, attempts: 1 })).rejects.toMatchObject({ status: 403 });
    expect(sent.map((s) => s.url.searchParams.get("user"))).toEqual([null, null, null]);
  });

  it("pages through events and invitees by token", async () => {
    const data = account({ pageCap: 1, invitees: { ...account().invitees, "EV-GROUP": [invitee("EV-GROUP", "INV-G1", 6), invitee("EV-GROUP", "INV-G2", 7), invitee("EV-GROUP", "INV-G3", 10)] } });
    const { c, fetch } = connector(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(8);
    expect(fetch.calls.filter((call) => call.url.includes("/scheduled_events?"))).toHaveLength(7);
    expect(fetch.calls.filter((call) => call.url.includes("EV-GROUP/invitees"))).toHaveLength(3);
  });

  it("resumes a historical import just before where it got to", async () => {
    const { c, fetch } = connector(account());
    const cursor: CalendlyCursor = { through: "2026-10-05T15:00:00.000Z", readAtThrough: ["EV-4"], recent: {} };
    const batches = [];
    for await (const batch of c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(cursor) })) batches.push(batch);
    expect(new URL(fetch.calls[1]!.url).searchParams.get("min_start_time")).toBe("2026-10-05T14:59:59.999Z");
    const ids = batches.flatMap((b) => b.events.map((e) => (e as { payload: { appointmentId: string } }).payload.appointmentId));
    // EV-4, at the checkpoint's start time, was already read.
    expect(ids).toEqual(["INV-3", "INV-5", "INV-BAD", "INV-G1", "INV-G2"]);
    expect(JSON.parse(batches.at(-1)!.cursor!)).toMatchObject({ through: null });
  });

  it("resumes between events that start at the same time without reading either twice", async () => {
    const data = account({ events: [event("EV-A", "2026-11-01T15:00:00Z"), event("EV-B", "2026-11-01T15:00:00Z"), event("EV-C", "2026-11-02T15:00:00Z")], invitees: { "EV-A": [invitee("EV-A", "INV-A", 1)], "EV-B": [invitee("EV-B", "INV-B", 2)], "EV-C": [invitee("EV-C", "INV-C", 3)] } });
    const { c } = connector(data, { batchSize: 1 });
    const first = await c.historicalImport({ organizationId: TEST_ORG, cursor: null })[Symbol.asyncIterator]().next();
    const cursor = JSON.parse((first.value as { cursor: string }).cursor) as CalendlyCursor;
    expect(cursor).toMatchObject({ through: "2026-11-01T15:00:00.000Z", readAtThrough: ["EV-A"] });
    const rest = [];
    for await (const batch of connector(data, { batchSize: 1 }).c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(cursor) })) rest.push(...batch.events);
    expect(rest.map((e) => (e as { payload: { appointmentId: string } }).payload.appointmentId)).toEqual(["INV-B", "INV-C"]);
  });

  it("starts over from the history window when a checkpoint is older than it", async () => {
    const { c, fetch } = connector(account());
    const batches = c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ through: "2020-01-01T00:00:00.000Z", readAtThrough: [], recent: {} }) });
    for await (const _ of batches) void _;
    expect(new URL(fetch.calls[1]!.url).searchParams.get("min_start_time")).toBe("2024-10-28T12:00:00.000Z");
  });

  it("leaves a finished import finished", async () => {
    const { c, fetch } = connector(account());
    const batches = [];
    for await (const batch of c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ through: null, readAtThrough: [], recent: {} }) })) batches.push(batch);
    expect(batches).toEqual([]);
    expect(fetch.calls).toEqual([]);
  });

  it("checkpoints each batch with where it got to, and keeps only recent events at the end", async () => {
    const { c } = connector(account());
    const cursors: CalendlyCursor[] = [];
    for await (const batch of c.historicalImport({ organizationId: TEST_ORG, cursor: null })) cursors.push(JSON.parse(batch.cursor!));
    expect(cursors.map((cur) => cur.through)).toEqual(["2026-09-01T15:00:00.000Z", "2026-10-20T15:00:00.000Z", "2026-11-20T15:00:00.000Z", "2026-12-01T15:00:00.000Z", null]);
    expect(Object.keys(cursors.at(-1)!.recent).sort()).toEqual(["EV-3", "EV-4", "EV-5", "EV-BAD", "EV-GROUP"]);
    for (const cur of cursors) expect(() => parseCalendlyCursor(JSON.stringify(cur))).not.toThrow();
  });

  it("reads the recent span on each later sync and only re-reads invitees that may have changed", async () => {
    const data = account();
    const { memory, pipeline } = testPipeline();
    const first = connector(data);
    const one = await runSync({ connector: first.c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(one).toMatchObject({ ingested: 5, deadLettered: 1 });
    expect(new URL(first.fetch.calls[1]!.url).searchParams.get("min_start_time")).toBe(new Date(NOW.getTime() - CALENDLY_RECENT_DAYS * 86_400_000).toISOString());

    // Nothing changed: only the event in the no-show span has its invitees read again.
    const quiet = connector(data);
    const two = await runSync({ connector: quiet.c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(two).toMatchObject({ ingested: 0, duplicates: 1 });
    expect(quiet.fetch.calls.filter((call) => call.url.includes("/invitees")).map((call) => new URL(call.url).pathname)).toEqual(["/scheduled_events/EV-3/invitees"]);

    // EV-3 is marked a no-show; EV-4 (outside the no-show span) is cancelled, which changes the event.
    data.invitees["EV-3"]![0]!.no_show = { uri: `${CALENDLY_API}/invitee_no_shows/NS-1`, created_at: "2026-10-20T16:00:00.000000Z" };
    data.events.find((e) => e.uri.endsWith("EV-4"))!.status = "canceled";
    Object.assign(data.invitees["EV-4"]![0]!, { status: "canceled", cancellation: { canceled_by: "Test Customer4", reason: "Sick", canceler_type: "invitee", created_at: "2026-10-04T10:00:00.000000Z" } });
    const changed = connector(data);
    const three = await runSync({ connector: changed.c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(three.ingested).toBe(2);
    const latest = memory.events.slice(-2).map((e) => [e.type, e.payload.appointmentId]);
    expect(latest).toEqual(expect.arrayContaining([[CALENDLY_EVENT_TYPES.noShow, "INV-3"], [CALENDLY_EVENT_TYPES.canceled, "INV-4"]]));
    expect(changed.fetch.calls.filter((call) => call.url.includes("/invitees")).map((call) => new URL(call.url).pathname).sort()).toEqual(["/scheduled_events/EV-3/invitees", "/scheduled_events/EV-4/invitees"]);
  });

  it("re-reads an event's invitees on the day it falls into the no-show span", async () => {
    const data = account();
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(data).c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const later = new Date(Date.parse("2026-11-15T16:00:00Z"));
    expect(later.getTime() - Date.parse("2026-11-15T15:00:00Z")).toBeLessThan(CALENDLY_NO_SHOW_DAYS * 86_400_000);
    const next = connector(data, { now: () => later });
    await runSync({ connector: next.c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(next.fetch.calls.filter((call) => call.url.includes("/invitees")).map((call) => new URL(call.url).pathname)).toEqual(["/scheduled_events/EV-5/invitees"]);
  });

  it("dead-letters an event with no invitees, or no id, once", async () => {
    const data = account({ events: [event("EV-EMPTY", "2026-11-01T15:00:00Z"), { ...event("EV-X", "2026-11-02T15:00:00Z"), uri: "https://elsewhere.example.test/x" }], invitees: {} });
    const { c, fetch } = connector(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 0, deadLettered: 2 });
    expect(fetch.calls.filter((call) => call.url.includes("/invitees"))).toHaveLength(1);
  });

  it("retries a rate-limited sync from its checkpoint", async () => {
    const data = account({ rateLimited: 3 });
    const { c } = connector(data, { rateLimitRetries: 1 });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: noSleep });
    expect(report).toMatchObject({ ingested: 7, deadLettered: 1 });
  });

  it("stops the sync with a message saying what to fix when the token is turned down", async () => {
    const { c } = connector(account({ token: ["calendly", "y".repeat(40)].join(".") }));
    const error = await runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG, attempts: 1 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401 });
    expect(String(error)).not.toContain(TOKEN);
  });

  it("only sends the three documented reads", async () => {
    const { c, fetch } = connector(account());
    await runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    await runSync({ connector: c, mode: "incremental", ...testPipeline(), organizationId: TEST_ORG });
    expect(new Set(fetch.calls.map((call) => call.method))).toEqual(new Set(["GET"]));
    for (const call of fetch.calls) expect(new URL(call.url).pathname).toMatch(/^\/(users\/me|scheduled_events|scheduled_events\/[A-Za-z0-9-]+\/invitees)$/);
  });

  it("declares its writes and a read-only gate stops every one", async () => {
    const { c } = connector(account());
    expect(c.writes).toBe(CALENDLY_WRITES);
    expect(CALENDLY_WRITES.map((w) => w.name)).toEqual(["book_appointment", "cancel_appointment", "mark_no_show"]);
    const audit = await assertWritesRefused(c);
    expect(audit.map((entry) => entry.action)).toEqual(["book_appointment", "cancel_appointment", "mark_no_show"]);
    expect(audit.every((entry) => entry.outcome === "refused")).toBe(true);
    expect("handleWebhook" in c).toBe(false);
  });

  it("checks its settings before reading anything", () => {
    expect(() => calendlyConnector({ token: TOKEN, customerKey: "short" })).toThrow("CUSTOMER_REF_KEY must be at least");
    expect(() => calendlyConnector({ token: "bad", customerKey: KEY })).toThrow(CalendlyConfigError);
    for (const n of [0, -1, 1.5, Number.NaN]) {
      expect(() => calendlyConnector({ token: TOKEN, customerKey: KEY, historyYears: n })).toThrow("historyYears must be a positive whole number");
      expect(() => calendlyConnector({ token: TOKEN, customerKey: KEY, batchSize: n })).toThrow("batchSize must be a positive whole number");
    }
  });

  it("reads a checkpoint only in the shape it writes", () => {
    expect(parseCalendlyCursor(null)).toBeNull();
    expect(parseCalendlyCursor(JSON.stringify({ through: null, readAtThrough: [], recent: { "EV-1": "0123456789ab" } }))).toEqual({ through: null, readAtThrough: [], recent: { "EV-1": "0123456789ab" } });
    const bad = [
      "not json",
      "null",
      "[]",
      JSON.stringify({ through: "2026-10-05", readAtThrough: [], recent: {} }),
      JSON.stringify({ through: null, readAtThrough: [] }),
      JSON.stringify({ through: null, recent: {} }),
      JSON.stringify({ through: null, readAtThrough: ["../x"], recent: {} }),
      JSON.stringify({ through: null, readAtThrough: "EV-1", recent: {} }),
      JSON.stringify({ through: null, readAtThrough: [], recent: [] }),
      JSON.stringify({ through: null, readAtThrough: [], recent: { "../x": "0123456789ab" } }),
      JSON.stringify({ through: null, readAtThrough: [], recent: { "EV-1": "short" } }),
      JSON.stringify({ through: null, readAtThrough: [], recent: { "EV-1": 7 } }),
    ];
    for (const raw of bad) expect(() => parseCalendlyCursor(raw), raw).toThrow("Calendly checkpoint is not in the expected shape");
  });
});

describe("the Calendly mock", () => {
  it("answers as the docs describe", async () => {
    const fetch = docMockFetch(calendlyDocMock(account()));
    const headers = { authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`${CALENDLY_API}/users/me`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${CALENDLY_API}/scheduled_events`, { headers })).status).toBe(400);
    expect((await fetch(`${CALENDLY_API}/scheduled_events?count=101&user=${CALENDLY_TEST_USER}`, { headers })).status).toBe(400);
    expect((await fetch(`${CALENDLY_API}/scheduled_events?organization=${CALENDLY_API}/organizations/OTHER`, { headers })).status).toBe(403);
    expect((await fetch(`${CALENDLY_API}/scheduled_events/NOPE/invitees`, { headers })).status).toBe(404);
    expect((await fetch(`${CALENDLY_API}/scheduled_events/EV-1/invitees?page_token=bogus`, { headers })).status).toBe(400);
    const desc = (await (await fetch(`${CALENDLY_API}/scheduled_events?user=${CALENDLY_TEST_USER}&sort=start_time:desc`, { headers })).json()) as { collection: { start_time: string }[] };
    expect(desc.collection[0]!.start_time).toBe("2026-12-01T15:00:00.000000Z");
    await expect(fetch(`${CALENDLY_API}/scheduled_events/EV-1/invitees/INV-1/no_show`, { method: "POST", headers })).rejects.toThrow("is not in the vendor's docs");
  });
});
