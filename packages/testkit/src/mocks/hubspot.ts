import { fixtureBuilder, synthetic, type FixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockResponse, type DocMockModule } from "../doc-mock.js";

/**
 * HubSpot's CRM API (date version 2026-09) as the connector reads it: the
 * private app token info lookup, list reads, CRM search and batch
 * association reads, built from HubSpot's developer docs. Data is synthetic.
 * HubSpot's free developer test accounts replace this mock with the nightly
 * run once a test account and private app are set up.
 */
const DOCS = "https://developers.hubspot.com/docs";
const API = "https://api.hubapi.com";
const VERSION = "2026-09";

export const HUBSPOT_MOCK_OBJECTS = ["companies", "contacts", "deals", "tickets", "calls", "emails", "meetings", "notes", "tasks"] as const;
type MockObject = (typeof HUBSPOT_MOCK_OBJECTS)[number];

/** The read-only scopes a token holds unless a test asks for others. */
export const HUBSPOT_MOCK_READ_SCOPES = ["crm.objects.contacts.read", "crm.objects.companies.read", "crm.objects.deals.read", "crm.objects.tickets.read"];
/** A hub (account) id for the test account. */
export const HUBSPOT_TEST_HUB_ID = 99_000_001;

export interface HubSpotMockRecord {
  id: string;
  /** Every property value is a string, or null, as HubSpot returns them. */
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
  archivedAt?: string;
}

export interface HubSpotMockData {
  records: Partial<Record<MockObject, HubSpotMockRecord[]>>;
  /** Associations by "from:to", then the from record's id: { "deals:contacts": { "3001": ["1001"] } }. */
  associations?: Partial<Record<string, Record<string, string[]>>>;
  /** The private app's access token. */
  accessToken: string;
  /** Scopes the private app holds; read-only unless a test says otherwise. */
  scopes?: string[];
  /** 429s to answer before the next reads, in order. SEARCH is search's own per-second limit, which names no policy. */
  rateLimits?: { policy: "TEN_SECONDLY_ROLLING" | "DAILY" | "SEARCH"; retryAfter?: number }[];
  /** Search's result cap per query; HubSpot's is 10,000. */
  searchCap?: number;
}

/** The property holding each object's last-modified time. */
const modifiedProperty = (object: MockObject) => (object === "contacts" ? "lastmodifieddate" : "hs_lastmodifieddate");

/** Properties HubSpot returns whether or not they were asked for, as the docs list them for search. */
const DEFAULTS: Record<MockObject, string[]> = {
  contacts: ["firstname", "lastname", "email", "lastmodifieddate", "hs_object_id", "createdate"],
  companies: ["name", "domain", "createdate", "hs_lastmodifieddate", "hs_object_id"],
  deals: ["dealname", "amount", "closedate", "pipeline", "dealstage", "createdate", "hs_lastmodifieddate", "hs_object_id"],
  tickets: ["content", "hs_pipeline", "hs_pipeline_stage", "hs_ticket_category", "hs_ticket_priority", "subject", "createdate", "hs_lastmodifieddate", "hs_object_id"],
  calls: ["hs_createdate", "hs_lastmodifieddate", "hs_object_id"],
  emails: ["hs_createdate", "hs_lastmodifieddate", "hs_object_id"],
  meetings: ["hs_createdate", "hs_lastmodifieddate", "hs_object_id"],
  notes: ["hs_createdate", "hs_lastmodifieddate", "hs_object_id"],
  tasks: ["hs_createdate", "hs_lastmodifieddate", "hs_object_id"],
};

/** Luhn's check, which assertSynthetic uses to flag card numbers; a 13-digit millisecond time can pass it by chance. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** A fixture time a second or two off, if needed, so its milliseconds never look like a card number. */
const notCardLike = (iso: string) => {
  let ms = Date.parse(iso);
  while (luhn(String(ms))) ms += 1000;
  return new Date(ms).toISOString();
};

/** A time as the millisecond string HubSpot accepts for timestamps, never card-number shaped. */
export const hubSpotMs = (iso: string) => String(Date.parse(notCardLike(iso)));

const modified = (n: number) => notCardLike(synthetic.isoTime(n * 60 + 30));
const created = (n: number) => notCardLike(synthetic.isoTime(n * 60));

function record(id: string, n: number, object: MockObject, properties: Record<string, string | null>): HubSpotMockRecord {
  const at = modified(n);
  return { id, properties: { hs_object_id: id, [object === "contacts" || object === "companies" || object === "deals" || object === "tickets" ? "createdate" : "hs_createdate"]: created(n), [modifiedProperty(object)]: at, ...properties }, createdAt: created(n), updatedAt: at, archived: false };
}

export const hubSpotCompany = fixtureBuilder<HubSpotMockRecord>((n) => record(String(2000 + n), n, "companies", { name: `Test Company ${n}`, domain: `company${n}.example.test`, phone: synthetic.phone(n), address: `${n} Test Street` }));

export const hubSpotContact = fixtureBuilder<HubSpotMockRecord>((n) =>
  record(String(1000 + n), n, "contacts", {
    firstname: "Test",
    lastname: `Customer ${n}`,
    email: synthetic.email(n),
    phone: synthetic.phone(n),
    mobilephone: synthetic.phone(n + 50),
    address: `${n} Test Street`,
    city: "Testville",
    hs_legal_basis: "Legitimate interest – existing customer",
  }),
);

export const hubSpotDeal = fixtureBuilder<HubSpotMockRecord>((n) =>
  record(String(3000 + n), n, "deals", {
    dealname: `Test engagement ring ${n}`,
    amount: "1250.50",
    deal_currency_code: "USD",
    closedate: "2026-02-14T17:00:00.000Z",
    pipeline: "default",
    dealstage: "appointmentscheduled",
    description: "Synthetic deal description",
  }),
);

export const hubSpotTicket = fixtureBuilder<HubSpotMockRecord>((n) =>
  record(String(4000 + n), n, "tickets", { subject: `Test repair ${n}`, content: "Synthetic ticket body", hs_pipeline: "0", hs_pipeline_stage: "1", hs_ticket_priority: "HIGH" }),
);

/** Each engagement kind's id range and the sensitive fields it carries, so tests can check they are dropped. */
const ENGAGEMENT_FIELDS: Record<"calls" | "emails" | "meetings" | "notes" | "tasks", [number, (n: number) => Record<string, string>]> = {
  calls: [5000, (n) => ({ hs_call_title: `Test call ${n}`, hs_call_body: "Synthetic call notes", hs_call_recording_url: `https://recordings.example.test/${n}`, hs_call_direction: "OUTBOUND", hs_call_status: "COMPLETED" })],
  emails: [6000, (n) => ({ hs_email_subject: `Test email ${n}`, hs_email_text: "Synthetic email body", hs_email_html: "<p>Synthetic</p>", hs_email_direction: "EMAIL", hs_email_status: "SENT" })],
  meetings: [7000, (n) => ({ hs_meeting_title: `Test meeting ${n}`, hs_meeting_body: "Synthetic meeting description", hs_internal_meeting_notes: "Synthetic internal notes", hs_meeting_outcome: "COMPLETED" })],
  notes: [8000, () => ({ hs_note_body: "Synthetic note body" })],
  tasks: [9000, (n) => ({ hs_task_subject: `Test task ${n}`, hs_task_body: "Synthetic task notes", hs_task_status: "NOT_STARTED", hs_task_priority: "HIGH" })],
};

/** Engagement fixtures. Tasks write hs_timestamp as milliseconds and the others as ISO, as the docs allow either. */
export const hubSpotEngagement = Object.fromEntries(
  Object.entries(ENGAGEMENT_FIELDS).map(([kind, [base, fields]]) => [
    kind,
    fixtureBuilder<HubSpotMockRecord>((n) =>
      record(String(base + n), n, kind as MockObject, { hs_timestamp: kind === "tasks" ? hubSpotMs(synthetic.isoTime(n * 60 + 10)) : notCardLike(synthetic.isoTime(n * 60 + 10)), ...fields(n) }),
    ),
  ]),
) as Record<keyof typeof ENGAGEMENT_FIELDS, FixtureBuilder<HubSpotMockRecord>>;

/** A record as archived (deleted) in HubSpot. */
export const hubSpotArchived = (r: HubSpotMockRecord, archivedAt: string): HubSpotMockRecord => ({ ...r, archived: true, archivedAt, updatedAt: archivedAt });

const error = (status: number, category: string, message: string): DocMockResponse => ({
  status,
  body: { status: "error", message, correlationId: "00000000-0000-4000-8000-000000000000", category },
});

const OPERATORS = new Set(["LT", "LTE", "GT", "GTE", "EQ", "NEQ", "BETWEEN", "IN", "NOT_IN", "HAS_PROPERTY", "NOT_HAS_PROPERTY", "CONTAINS_TOKEN", "NOT_CONTAINS_TOKEN"]);
const DATE_PROPERTIES = new Set(["lastmodifieddate", "hs_lastmodifieddate", "createdate", "hs_createdate", "hs_timestamp", "closedate"]);
const msOf = (value: string | null | undefined) => (value === null || value === undefined ? Number.NaN : /^\d+$/.test(value) ? Number(value) : Date.parse(value));
const byIdNumber = (a: HubSpotMockRecord, b: HubSpotMockRecord) => Number(a.id) - Number(b.id);

export interface HubSpotMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Search bodies received, in order, as parsed JSON. */
  readonly searches: { object: string; body: Record<string, unknown> }[];
}

export function hubSpotDocMock(data: HubSpotMockData): HubSpotMock {
  const limits = [...(data.rateLimits ?? [])];
  const cap = data.searchCap ?? 10_000;
  const searches: { object: string; body: Record<string, unknown> }[] = [];
  const authorized = (request: { headers: Headers }) => request.headers.get("authorization") === `Bearer ${data.accessToken}`;
  const unauthorized = () => error(401, "INVALID_AUTHENTICATION", "Authentication credentials not found.");
  const objectOf = (name: string | undefined) => HUBSPOT_MOCK_OBJECTS.find((o) => o === name);
  const limited = (): DocMockResponse | undefined => {
    const limit = limits.shift();
    if (!limit) return undefined;
    const policy = limit.policy === "SEARCH" ? {} : { policyName: limit.policy };
    const message = limit.policy === "DAILY" ? "You have reached your daily limit." : "You have reached your secondly limit.";
    return {
      status: 429,
      body: { status: "error", message, errorType: "RATE_LIMIT", correlationId: "00000000-0000-4000-8000-000000000000", requestId: "00000000-0000-4000-8000-000000000001", ...policy },
      ...(limit.retryAfter ? { headers: { "retry-after": String(limit.retryAfter) } } : {}),
    };
  };
  const shape = (object: MockObject, r: HubSpotMockRecord, asked: string[]) => {
    const keep = new Set([...asked, ...DEFAULTS[object]]);
    return {
      id: r.id,
      properties: Object.fromEntries(Object.entries(r.properties).filter(([k]) => keep.has(k))),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      archived: r.archived === true,
      ...(r.archivedAt ? { archivedAt: r.archivedAt } : {}),
    };
  };

  const api = checkDocMock({
    integration: "hubspot",
    baseUrl: API,
    source: { url: `${DOCS}/api-reference/latest/overview`, title: "HubSpot API reference (2026-09)", retrievedOn: "2026-10-22", version: VERSION },
    auth: "bearer",
    assumptions: [
      "The token info lookup (POST /oauth/v2/private-apps/get/access-token-info, documented for private apps) also answers for service keys, accepts the token as a Bearer header alongside tokenKey, and answers 401 for a tokenKey that isn't the caller's",
      "Calls, emails, meetings, notes and tasks need only crm.objects.contacts.read, as the calls guide says; the other engagement guides list no scopes",
      "Search filter values for datetime properties are millisecond epoch strings, as in the docs' BETWEEN example",
      "Search sorts ties in the sorted property by record id, so paging a tie with after is stable",
      "Search answers 400 once after reaches 10,000 (the docs say paging beyond 10,000 results is a 400)",
      "Search and list reads return the requested properties plus each object's default properties, email included for contacts",
      "List reads take limit up to 100 and answer 400 above that",
      "A list read with archived=true returns only archived records, each with archivedAt, and HubSpot keeps them there for 90 days",
      "Batch association reads answer only for ids that have associations, and return every association of each id in one response (the docs show no per-record paging)",
      "A 10-second limit's 429 carries policyName TEN_SECONDLY_ROLLING, a daily one DAILY, and search's own limit names no policy; none sends Retry-After",
    ],
    routes: [
      {
        method: "POST",
        path: "/oauth/v2/private-apps/get/access-token-info",
        documentedAt: `${DOCS}/apps/legacy-apps/private-apps/overview`,
        respond(request) {
          const body = JSON.parse(request.body || "{}") as { tokenKey?: unknown };
          if (body.tokenKey !== data.accessToken || !authorized(request)) return unauthorized();
          return { status: 200, body: { userId: 77_000_001, hubId: HUBSPOT_TEST_HUB_ID, appId: 88_000_001, scopes: data.scopes ?? HUBSPOT_MOCK_READ_SCOPES } };
        },
      },
      {
        method: "GET",
        path: `/crm/objects/${VERSION}/{object}`,
        documentedAt: `${DOCS}/api-reference/latest/crm/using-object-apis`,
        respond(request, params) {
          if (!authorized(request)) return unauthorized();
          const object = objectOf(params.object);
          if (!object) return error(404, "OBJECT_NOT_FOUND", "Unable to infer object type");
          const busy = limited();
          if (busy) return busy;
          const q = request.url.searchParams;
          const limit = Number(q.get("limit") ?? "10");
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) return error(400, "VALIDATION_ERROR", "limit must be between 1 and 100");
          const archived = q.get("archived") === "true";
          const rows = (data.records[object] ?? []).filter((r) => (r.archived === true) === archived).sort(byIdNumber);
          const offset = Number(q.get("after") ?? "0");
          if (!Number.isInteger(offset) || offset < 0) return error(400, "VALIDATION_ERROR", "after is not a valid paging token");
          const asked = (q.get("properties") ?? "").split(",").filter(Boolean);
          const page = rows.slice(offset, offset + limit).map((r) => shape(object, r, asked));
          const more = offset + limit < rows.length;
          return { status: 200, body: { results: page, ...(more ? { paging: { next: { after: String(offset + limit), link: `${API}${request.url.pathname}?after=${offset + limit}` } } } : {}) } };
        },
      },
      {
        method: "POST",
        path: `/crm/objects/${VERSION}/{object}/search`,
        documentedAt: `${DOCS}/api-reference/latest/crm/search-the-crm`,
        respond(request, params) {
          if (!authorized(request)) return unauthorized();
          const object = objectOf(params.object);
          if (!object) return error(404, "OBJECT_NOT_FOUND", "Unable to infer object type");
          const busy = limited();
          if (busy) return busy;
          const body = JSON.parse(request.body || "{}") as Record<string, unknown>;
          searches.push({ object, body });
          const groups = (body.filterGroups ?? []) as { filters?: { propertyName?: string; operator?: string; value?: string }[] }[];
          const filters = groups.flatMap((g) => g.filters ?? []);
          if (groups.length > 5 || groups.some((g) => (g.filters ?? []).length > 6) || filters.length > 18) return error(400, "VALIDATION_ERROR", "Too many filters");
          if (body.query !== undefined) return error(400, "VALIDATION_ERROR", "This mock doesn't model free-text search");
          for (const f of filters) {
            if (!f.operator || !OPERATORS.has(f.operator)) return error(400, "VALIDATION_ERROR", `Unknown operator ${String(f.operator).slice(0, 20)}`);
            if (!f.propertyName || !DATE_PROPERTIES.has(f.propertyName) || !["LT", "LTE", "GT", "GTE", "EQ"].includes(f.operator)) return error(400, "VALIDATION_ERROR", "This mock only models date range filters");
          }
          const limit = Number(body.limit ?? 10);
          if (!Number.isInteger(limit) || limit < 1 || limit > 200) return error(400, "VALIDATION_ERROR", "limit must be between 1 and 200");
          const after = Number(body.after ?? "0");
          if (!Number.isInteger(after) || after < 0) return error(400, "VALIDATION_ERROR", "after must be an integer");
          if (after >= cap) return error(400, "VALIDATION_ERROR", `Search can't page beyond ${cap} results`);
          const test = (r: HubSpotMockRecord, f: (typeof filters)[number]) => {
            const v = msOf(r.properties[f.propertyName!]);
            const want = Number(f.value);
            return f.operator === "LT" ? v < want : f.operator === "LTE" ? v <= want : f.operator === "GT" ? v > want : f.operator === "GTE" ? v >= want : v === want;
          };
          // Archived records never appear in search; filter groups OR together, filters within one AND.
          let rows = (data.records[object] ?? []).filter((r) => r.archived !== true && (groups.length === 0 || groups.some((g) => (g.filters ?? []).every((f) => test(r, f)))));
          const sort = ((body.sorts ?? []) as { propertyName?: string; direction?: string }[])[0];
          if (sort?.propertyName) {
            const sign = sort.direction === "DESCENDING" ? -1 : 1;
            rows = [...rows].sort((a, b) => sign * (msOf(a.properties[sort.propertyName!]) - msOf(b.properties[sort.propertyName!])) || byIdNumber(a, b));
          } else rows = [...rows].sort(byIdNumber);
          const asked = Array.isArray(body.properties) ? (body.properties as string[]) : [];
          const page = rows.slice(after, after + limit).map((r) => shape(object, r, asked));
          const more = after + limit < rows.length;
          return { status: 200, body: { total: rows.length, results: page, ...(more ? { paging: { next: { after: String(after + limit) } } } : {}) } };
        },
      },
      {
        method: "POST",
        path: `/crm/associations/${VERSION}/{from}/{to}/batch/read`,
        documentedAt: `${DOCS}/api-reference/crm-associations-v4/batch/post-crm-v4-associations-fromObjectType-toObjectType-batch-read`,
        respond(request, params) {
          if (!authorized(request)) return unauthorized();
          const from = objectOf(params.from);
          const to = objectOf(params.to);
          if (!from || !to) return error(404, "OBJECT_NOT_FOUND", "Unable to infer object type");
          const busy = limited();
          if (busy) return busy;
          const inputs = (JSON.parse(request.body || "{}") as { inputs?: { id?: unknown }[] }).inputs;
          if (!Array.isArray(inputs) || inputs.length === 0) return error(400, "VALIDATION_ERROR", "inputs is required");
          if (inputs.length > 100) return error(400, "VALIDATION_ERROR", "Batch read requests may not exceed 100 IDs per request body");
          const table = data.associations?.[`${from}:${to}`] ?? {};
          const results = inputs.flatMap((input) => {
            const ids = table[String(input.id)];
            if (!ids?.length) return [];
            return [{ from: { id: String(input.id) }, to: ids.map((id) => ({ toObjectId: Number(id), associationTypes: [{ category: "HUBSPOT_DEFINED", typeId: 1, label: null }] })) }];
          });
          return { status: 200, body: { status: "COMPLETE", results, startedAt: "2026-01-20T00:00:00.000Z", completedAt: "2026-01-20T00:00:00.100Z" } };
        },
      },
    ],
  });

  return { api, fetch: docMockFetch(api), searches };
}

export default {
  integration: "hubspot",
  covers: "HubSpot's CRM search, archived list, batch association and token info endpoints (date version 2026-09)",
  watchPages: [
    "https://developers.hubspot.com/docs/api-reference/latest/overview",
    "https://developers.hubspot.com/docs/apps/legacy-apps/private-apps/overview",
    "https://developers.hubspot.com/docs/api-reference/latest/crm/using-object-apis",
    "https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm",
    "https://developers.hubspot.com/docs/api-reference/crm-associations-v4/batch/post-crm-v4-associations-fromObjectType-toObjectType-batch-read",
  ],
  docMocks: () => [hubSpotDocMock({ records: {}, accessToken: "" }).api],
} satisfies DocMockModule;
