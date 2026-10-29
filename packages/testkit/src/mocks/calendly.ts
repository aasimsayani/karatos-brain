import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, type DocMock, type DocMockModule } from "../doc-mock.js";

/**
 * Calendly's API v2 endpoints for the signed-in user, scheduled events and
 * their invitees, built from the API reference. Data is synthetic.
 */
const API = "https://api.calendly.com";
const DOCS = "https://developer.calendly.com/api-docs/calendly-api";

export interface CalendlyScheduledEvent {
  uri: string;
  name: string | null;
  status: "active" | "canceled";
  start_time: string;
  end_time: string;
  event_type: string;
  location: { type: string; location?: string | null; join_url?: string; phone_number?: string };
  invitees_counter: { total: number; active: number; limit: number };
  created_at: string;
  updated_at: string;
  event_memberships: { user: string; user_email?: string; user_name?: string }[];
  event_guests: { email: string; created_at: string; updated_at: string }[];
  meeting_notes_plain?: string | null;
  cancellation?: { canceled_by: string; reason: string | null; canceler_type: "host" | "invitee"; created_at: string };
}

export interface CalendlyInvitee {
  uri: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  name: string;
  status: "active" | "canceled";
  questions_and_answers: { question: string; answer: string; position: number }[];
  timezone: string | null;
  event: string;
  created_at: string;
  updated_at: string;
  tracking: { utm_campaign: string | null; utm_source: string | null; utm_medium: string | null; utm_content: string | null; utm_term: string | null; salesforce_uuid: string | null };
  text_reminder_number: string | null;
  rescheduled: boolean;
  old_invitee: string | null;
  new_invitee: string | null;
  cancel_url: string;
  reschedule_url: string;
  routing_form_submission: string | null;
  payment: { external_id: string; provider: "stripe" | "paypal"; amount: number; currency: string; terms: string | null; successful: boolean } | null;
  no_show: { uri: string; created_at: string } | null;
  reconfirmation: { created_at: string; confirmed_at: string | null } | null;
  scheduling_method: "instant_book" | "api" | null;
  invitee_scheduled_by: string | null;
  cancellation?: { canceled_by: string; reason: string | null; canceler_type: "host" | "invitee"; created_at: string };
}

export const CALENDLY_TEST_USER = `${API}/users/USER-TEST-1`;
export const CALENDLY_TEST_ORGANIZATION = `${API}/organizations/ORG-TEST-1`;

export const calendlyScheduledEvent = fixtureBuilder<CalendlyScheduledEvent>((n) => ({
  uri: `${API}/scheduled_events/EVENT-TEST-${n}`,
  name: n % 2 ? "Bridal consultation" : "Repair drop-off",
  status: "active",
  start_time: synthetic.isoTime(n * 1440 + 600, "2026-10-01T00:00:00Z").replace(".000Z", ".000000Z"),
  end_time: synthetic.isoTime(n * 1440 + 645, "2026-10-01T00:00:00Z").replace(".000Z", ".000000Z"),
  event_type: `${API}/event_types/TYPE-TEST-${n % 2 ? 1 : 2}`,
  location: { type: "physical", location: "1 Test Street, Testville" },
  invitees_counter: { total: 1, active: 1, limit: 1 },
  created_at: synthetic.isoTime(n * 60, "2026-09-01T00:00:00Z").replace(".000Z", ".000000Z"),
  updated_at: synthetic.isoTime(n * 60, "2026-09-01T00:00:00Z").replace(".000Z", ".000000Z"),
  event_memberships: [{ user: CALENDLY_TEST_USER, user_email: "host@example.test", user_name: "Test Host" }],
  event_guests: [],
  meeting_notes_plain: null,
}));

export const calendlyInvitee = fixtureBuilder<CalendlyInvitee>((n) => ({
  uri: `${API}/scheduled_events/EVENT-TEST-${n}/invitees/INVITEE-TEST-${n}`,
  email: synthetic.email(n),
  first_name: "Test",
  last_name: `Customer${n}`,
  name: synthetic.name(n),
  status: "active",
  questions_and_answers: [{ question: "What would you like to talk about?", answer: "Test answer", position: 0 }],
  timezone: "America/New_York",
  event: `${API}/scheduled_events/EVENT-TEST-${n}`,
  created_at: synthetic.isoTime(n * 60, "2026-09-01T00:00:00Z").replace(".000Z", ".000000Z"),
  updated_at: synthetic.isoTime(n * 60, "2026-09-01T00:00:00Z").replace(".000Z", ".000000Z"),
  tracking: { utm_campaign: "test-fall", utm_source: "instagram", utm_medium: "social", utm_content: null, utm_term: null, salesforce_uuid: null },
  text_reminder_number: synthetic.phone(n),
  rescheduled: false,
  old_invitee: null,
  new_invitee: null,
  cancel_url: `https://calendly.example.test/cancellations/INVITEE-TEST-${n}`,
  reschedule_url: `https://calendly.example.test/reschedulings/INVITEE-TEST-${n}`,
  routing_form_submission: null,
  payment: null,
  no_show: null,
  reconfirmation: null,
  scheduling_method: null,
  invitee_scheduled_by: null,
}));

export interface CalendlyMockData {
  events: CalendlyScheduledEvent[];
  /** Invitees by event id (the last segment of the event's URI). */
  invitees: Record<string, CalendlyInvitee[]>;
  /** The token the mock accepts. Any bearer token is accepted when absent. */
  token?: string;
  /** False when the token's owner isn't an owner or admin, so the organization's events answer 403. */
  orgAdmin?: boolean;
  /** Rows per page the mock caps at, to exercise paging. Defaults to 100. */
  pageCap?: number;
  /** How many of the next requests answer 429, each telling the caller to wait `resetSeconds` (default 2). */
  rateLimited?: number;
  resetSeconds?: number;
}

const idOf = (uri: string) => uri.split("/").pop()!;

export function calendlyDocMock(data: CalendlyMockData): DocMock {
  const denied = (request: { headers: Headers }) => {
    if (data.token !== undefined && request.headers.get("authorization") !== `Bearer ${data.token}`) return { status: 401, body: { title: "Unauthenticated", message: "The access token is invalid" } };
    if (data.rateLimited) {
      data.rateLimited--;
      return { status: 429, body: { title: "Too Many Requests", message: "You have exceeded the rate limit." }, headers: { "X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(data.resetSeconds ?? 2) } };
    }
    return null;
  };
  const paged = <T>(rows: T[], url: URL) => {
    const asked = Number(url.searchParams.get("count") ?? 20);
    if (!Number.isInteger(asked) || asked < 1 || asked > 100) return { status: 400, body: { title: "Invalid Argument", message: "count must be between 1 and 100" } };
    const count = Math.min(asked, data.pageCap ?? 100);
    const offset = url.searchParams.has("page_token") ? Number(/^page-(\d+)$/.exec(url.searchParams.get("page_token")!)?.[1] ?? NaN) : 0;
    if (!Number.isInteger(offset)) return { status: 400, body: { title: "Invalid Argument", message: "page_token is not valid" } };
    const next = offset + count < rows.length ? `page-${offset + count}` : null;
    return { status: 200, body: { collection: rows.slice(offset, offset + count), pagination: { count, next_page: next && `${url.origin}${url.pathname}?page_token=${next}`, previous_page: null, next_page_token: next, previous_page_token: null } } };
  };
  return checkDocMock({
    integration: "calendly",
    baseUrl: API,
    source: { url: "https://developer.calendly.com/api-docs", title: "Calendly API reference", retrievedOn: "2026-10-28", version: "v2" },
    auth: "bearer",
    assumptions: [
      "count is capped at 100; the docs give the default of 20 and no maximum",
      "page_token values are opaque strings of letters, digits and _=+/.-",
      "Listing an organization's events as a member who isn't an owner or admin answers 403",
      "min_start_time is inclusive and max_start_time exclusive; the docs say after and before",
      "Times are UTC with microseconds, as in the docs' examples",
      "A 429 carries X-RateLimit-Reset as the seconds until the limit resets",
    ],
    routes: [
      {
        method: "GET",
        path: "/users/me",
        documentedAt: `${DOCS}/users/get-current-user`,
        respond: (request) =>
          denied(request) ?? {
            status: 200,
            body: { resource: { uri: CALENDLY_TEST_USER, name: "Test Host", slug: "test-host", email: "host@example.test", scheduling_url: "https://calendly.example.test/test-host", timezone: "America/New_York", avatar_url: null, created_at: "2026-01-01T00:00:00.000000Z", updated_at: "2026-01-01T00:00:00.000000Z", current_organization: CALENDLY_TEST_ORGANIZATION, resource_type: "User", locale: "en" } },
          },
      },
      {
        method: "GET",
        path: "/scheduled_events",
        documentedAt: `${DOCS}/scheduled-events/list-scheduled-events`,
        respond(request) {
          const no = denied(request);
          if (no) return no;
          const q = request.url.searchParams;
          const org = q.get("organization");
          const user = q.get("user");
          if (!org && !user) return { status: 400, body: { title: "Invalid Argument", message: "one of user, organization or group is required" } };
          if (org && org !== CALENDLY_TEST_ORGANIZATION) return { status: 403, body: { title: "Permission Denied", message: "You do not have permission" } };
          if (org && data.orgAdmin === false) return { status: 403, body: { title: "Permission Denied", message: "You do not have permission to access this resource." } };
          if (user && user !== CALENDLY_TEST_USER) return { status: 403, body: { title: "Permission Denied", message: "You do not have permission" } };
          const min = q.get("min_start_time");
          const max = q.get("max_start_time");
          if ((min && Number.isNaN(Date.parse(min))) || (max && Number.isNaN(Date.parse(max)))) return { status: 400, body: { title: "Invalid Argument", message: "min_start_time and max_start_time must be UTC times" } };
          const at = (e: CalendlyScheduledEvent) => Date.parse(e.start_time);
          const rows = data.events
            .filter((e) => (!min || at(e) >= Date.parse(min)) && (!max || at(e) < Date.parse(max)))
            .filter((e) => !user || e.event_memberships.some((m) => m.user === user))
            .sort((a, b) => (q.get("sort") === "start_time:desc" ? at(b) - at(a) : at(a) - at(b)));
          return paged(rows, request.url);
        },
      },
      {
        method: "GET",
        path: "/scheduled_events/{uuid}/invitees",
        documentedAt: `${DOCS}/scheduled-events/list-event-invitees`,
        respond(request, params) {
          const no = denied(request);
          if (no) return no;
          if (!data.events.some((e) => idOf(e.uri) === params.uuid)) return { status: 404, body: { title: "Resource Not Found", message: "The server could not find the requested resource." } };
          return paged(data.invitees[params.uuid!] ?? [], request.url);
        },
      },
    ],
  });
}

export default {
  integration: "calendly",
  covers: "Calendly's current user, scheduled event and invitee endpoints (API v2)",
  watchPages: [
    "https://developer.calendly.com/api-docs",
    "https://developer.calendly.com/api-docs/calendly-api/users/get-current-user",
    "https://developer.calendly.com/api-docs/calendly-api/scheduled-events/list-scheduled-events",
    "https://developer.calendly.com/api-docs/calendly-api/scheduled-events/list-event-invitees",
  ],
  docMocks: () => [calendlyDocMock({ events: [], invitees: {} })],
} satisfies DocMockModule;
