import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockResponse, type DocMockModule } from "../doc-mock.js";

/**
 * Typeform's Create API (a form's definition) and Responses API, built from
 * Typeform's developer docs. Data is synthetic. Typeform has free accounts,
 * so recordings from a test account replace this mock once one is set up.
 */
const DOCS = "https://www.typeform.com/developers";

export const TYPEFORM_TEST_FORM = "TestForm1";
export const TYPEFORM_TEST_FORM_2 = "TestForm2";

export interface TypeformMockField {
  id: string;
  ref: string;
  title: string;
  type: string;
}

export interface TypeformMockResponse {
  response_id: string;
  token: string;
  landed_at: string;
  submitted_at: string;
  metadata?: Record<string, unknown>;
  hidden?: Record<string, unknown>;
  calculated?: Record<string, unknown>;
  variables?: unknown[];
  answers: Record<string, unknown>[];
}

export interface TypeformMockForm {
  title: string;
  fields: TypeformMockField[];
  responses: TypeformMockResponse[];
}

export interface TypeformMockData {
  forms: Record<string, TypeformMockForm>;
  /** The personal access token the mock accepts. */
  accessToken: string;
  /** The host the account keeps responses on, which the form's _links.responses names. api.typeform.com unless a test says otherwise. */
  responsesHost?: string;
  /** 429s to answer before the next reads, each with an optional Retry-After. */
  rateLimits?: { retryAfter?: number }[];
}

/** The questions the mock's forms ask, by the names the generic profile reads. */
export const TYPEFORM_MOCK_FIELDS: TypeformMockField[] = [
  { id: "fldName01", ref: "name", title: "Your name", type: "short_text" },
  { id: "fldEmail1", ref: "email", title: "Email address", type: "email" },
  { id: "fldPhone1", ref: "phone", title: "Phone number", type: "phone_number" },
  { id: "fldKind01", ref: "request_type", title: "How can we help?", type: "multiple_choice" },
  { id: "fldItem01", ref: "item_type", title: "Item type", type: "dropdown" },
  { id: "fldMetal1", ref: "metal", title: "Metal", type: "multiple_choice" },
  { id: "fldStone1", ref: "stone", title: "Center stone", type: "short_text" },
  { id: "fldDate01", ref: "preferred_date", title: "Preferred date", type: "date" },
  { id: "fldTime01", ref: "preferred_time", title: "Preferred time", type: "multiple_choice" },
  { id: "fldBudget", ref: "budget", title: "Budget", type: "number" },
  { id: "fldChan01", ref: "contact", title: "Preferred contact method", type: "multiple_choice" },
  { id: "fldStore1", ref: "store", title: "Store", type: "dropdown" },
  { id: "fldDesc01", ref: "description", title: "Tell us about the piece", type: "long_text" },
  { id: "fldPhoto1", ref: "photo", title: "Upload a photo", type: "file_upload" },
];

const field = (id: string) => {
  const f = TYPEFORM_MOCK_FIELDS.find((x) => x.id === id)!;
  return { id: f.id, type: f.type, ref: f.ref };
};

/** A response token: letters around the number, so no long run of digits looks like a card number. */
export const typeformToken = (n: number) => `tok${String(n).padStart(6, "0")}test${"x".repeat(8)}`;

/** A day-apart submission time, counting back from the fixture start. */
const submitted = (n: number) => synthetic.isoTime(-n * 1440, "2026-10-01T15:00:00Z").replace(/\.000Z$/, "Z");

export const typeformResponse = fixtureBuilder<TypeformMockResponse>((n) => ({
  response_id: typeformToken(n),
  token: typeformToken(n),
  landed_at: submitted(n),
  submitted_at: submitted(n),
  metadata: { user_agent: "Mozilla/5.0 (test)", platform: "other", referer: "https://forms.example.test/to/TestForm1", network_id: "netTEST", browser: "default" },
  hidden: { email: synthetic.email(n), utm_source: "test" },
  calculated: { score: 0 },
  answers: [
    { field: field("fldName01"), type: "text", text: synthetic.name(n) },
    { field: field("fldEmail1"), type: "email", email: synthetic.email(n) },
    { field: field("fldPhone1"), type: "phone_number", phone_number: synthetic.phone(n).replace(/ /g, "") },
    { field: field("fldKind01"), type: "choice", choice: { id: "chRepair", label: "Repair or resizing", ref: "repair" } },
    { field: field("fldItem01"), type: "text", text: "Ring" },
    { field: field("fldMetal1"), type: "choice", choice: { id: "chOther", other: `My grandmother's ring, call ${synthetic.phone(n)}` } },
    { field: field("fldStone1"), type: "text", text: "Sapphire" },
    { field: field("fldDate01"), type: "date", date: "2026-11-03" },
    { field: field("fldTime01"), type: "choice", choice: { id: "chAfter", label: "Afternoon", ref: "afternoon" } },
    { field: field("fldBudget"), type: "number", number: 750 },
    { field: field("fldChan01"), type: "choice", choice: { id: "chText", label: "Text message", ref: "text" } },
    { field: field("fldStore1"), type: "text", text: "Test Store Downtown" },
    { field: field("fldDesc01"), type: "text", text: `Prong is loose. Reach me at ${synthetic.email(n)} or 12 Test Street.` },
    { field: field("fldPhoto1"), type: "file_url", file_url: `https://api.typeform.com/forms/TestForm1/responses/${typeformToken(n)}/fields/fldPhoto1/files/ring-test.jpg` },
  ],
}));

const error = (status: number, code: string, description: string): DocMockResponse => ({ status, body: { code, description } });

const HOSTS = ["api.typeform.com", "api.eu.typeform.com", "api.typeform.eu"];
const seconds = (value: string | null) => (value !== null && /^\d{1,12}$/.test(value) ? Number(value) : Number.NaN);

export interface TypeformMock {
  api: DocMock;
  fetch: DocMockFetch;
}

export function typeformDocMock(data: TypeformMockData): TypeformMock {
  const limits = [...(data.rateLimits ?? [])];
  const responsesHost = data.responsesHost ?? "api.typeform.com";
  const authorized = (headers: Headers) => headers.get("authorization") === `Bearer ${data.accessToken}` && data.accessToken !== "";

  const api = checkDocMock({
    integration: "custom_forms",
    baseUrl: "https://api.typeform.com",
    source: { url: `${DOCS}/get-started/`, title: "Typeform APIs: get started", retrievedOn: "2026-10-22", version: "Create and Responses APIs (unversioned)" },
    auth: "bearer",
    assumptions: [
      "Without sort, responses come newest submitted_at first and before pages back to older ones",
      "before and after take a response's token, and combine with since and until",
      "since and until accept Unix seconds and compare inclusively with submitted_at",
      "A page_size above 1000 is refused with 400 rather than capped",
      "response_id equals token for completed responses",
      "A 429 may carry Retry-After in seconds",
      "A form's _links.responses names the host its responses live on, as the EU data center guide says; the Retrieve form reference shows only _links.display",
    ],
    routes: [
      {
        method: "GET",
        path: "/forms/{form_id}",
        documentedAt: `${DOCS}/create/reference/retrieve-form/`,
        respond(request, params) {
          if (!authorized(request.headers)) return error(401, "AUTHENTICATION_FAILED", "Authentication credentials not found on the Request Headers");
          const form = Object.hasOwn(data.forms, params.form_id!) ? data.forms[params.form_id!] : undefined;
          if (!form) return error(404, "FORM_NOT_FOUND", "Non existing form with uid");
          return {
            status: 200,
            body: {
              id: params.form_id,
              title: form.title,
              type: "form",
              fields: form.fields,
              _links: { display: `https://forms.example.test/to/${params.form_id}`, responses: `https://${responsesHost}/forms/${params.form_id}/responses` },
            },
          };
        },
      },
      {
        method: "GET",
        path: "/forms/{form_id}/responses",
        documentedAt: `${DOCS}/responses/reference/retrieve-responses/`,
        respond(request, params) {
          if (!authorized(request.headers)) return error(401, "AUTHENTICATION_FAILED", "Authentication credentials not found on the Request Headers");
          const limit = limits.shift();
          if (limit) return { status: 429, body: { code: "TOO_MANY_REQUESTS", description: "Too many requests" }, headers: limit.retryAfter ? { "retry-after": String(limit.retryAfter) } : {} };
          const form = Object.hasOwn(data.forms, params.form_id!) ? data.forms[params.form_id!] : undefined;
          if (!form) return error(404, "FORM_NOT_FOUND", "Non existing form with uid");
          const q = request.url.searchParams;
          const known = new Set(["page_size", "since", "until", "after", "before", "included_response_ids", "excluded_response_ids", "response_type", "completed", "sort", "query", "fields", "answered_fields"]);
          const unknown = [...q.keys()].find((k) => !known.has(k));
          if (unknown) return error(400, "VALIDATION_ERROR", `unknown parameter ${unknown.slice(0, 30)}`);
          const size = q.has("page_size") ? Number(q.get("page_size")) : 25;
          if (!Number.isInteger(size) || size < 1 || size > 1000) return error(400, "VALIDATION_ERROR", "page_size must be between 1 and 1000");
          let rows = [...form.responses].sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at));
          for (const [name, keep] of [
            ["since", (r: TypeformMockResponse, t: number) => Date.parse(r.submitted_at) >= t * 1000],
            ["until", (r: TypeformMockResponse, t: number) => Date.parse(r.submitted_at) <= t * 1000],
          ] as const) {
            if (!q.has(name)) continue;
            const t = seconds(q.get(name));
            if (Number.isNaN(t)) return error(400, "VALIDATION_ERROR", `${name} must be a time`);
            rows = rows.filter((r) => keep(r, t));
          }
          const before = q.get("before");
          if (before !== null) {
            const at = rows.findIndex((r) => r.token === before);
            if (at < 0) return error(400, "VALIDATION_ERROR", "before is not a response token");
            rows = rows.slice(at + 1);
          }
          const total = rows.length;
          return { status: 200, body: { total_items: total, page_count: Math.ceil(total / size), items: rows.slice(0, size) } };
        },
      },
    ],
  });

  const apiFetch = docMockFetch(api);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // The EU hosts answer like the US one; the mock's routes hang off api.typeform.com.
      if (HOSTS.includes(url.hostname) && url.hostname !== "api.typeform.com") {
        if (url.hostname !== responsesHost) throw new Error(`the mock account keeps responses on ${responsesHost}, not ${url.hostname}`);
        url.hostname = "api.typeform.com";
      }
      const response = await apiFetch(url, init);
      calls.push(...apiFetch.calls.slice(-1).map((c) => ({ ...c, url: input instanceof Request ? input.url : String(input) })));
      return response;
    },
    { calls },
  );
  return { api, fetch };
}

export default {
  integration: "custom_forms",
  covers: "Typeform's Create API (a form's definition) and Responses API",
  watchPages: [
    "https://www.typeform.com/developers/get-started/",
    "https://www.typeform.com/developers/create/reference/retrieve-form/",
    "https://www.typeform.com/developers/responses/reference/retrieve-responses/",
  ],
  docMocks: () => [typeformDocMock({ forms: {}, accessToken: "" }).api],
} satisfies DocMockModule;
