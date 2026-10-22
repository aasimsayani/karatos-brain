import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { READ_ONLY, runSync, writePolicy } from "@karatos/core";
import {
  TEST_ORG,
  TYPEFORM_MOCK_FIELDS,
  TYPEFORM_TEST_FORM,
  TYPEFORM_TEST_FORM_2,
  UndocumentedRequestError,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  synthetic,
  tamper,
  testPipeline,
  typeformDocMock,
  typeformResponse,
  typeformToken,
  type TypeformMockData,
  type TypeformMockResponse,
} from "@karatos/connector-testkit";
import {
  CUSTOMER_REF_PREFIX,
  CUSTOM_FORMS_OVERLAP_MS,
  CUSTOM_FORMS_WRITES,
  CustomerRefKeyError,
  FORM_SIGNATURE_HEADER,
  FORM_SUBMISSION_EVENT,
  FORM_TIMESTAMP_HEADER,
  FormProfileError,
  GENERIC_FORM_PROFILE,
  TYPEFORM_HOSTS,
  TYPEFORM_MIN_INTERVAL_MS,
  TYPEFORM_PAGE_SIZE,
  TypeformApiError,
  TypeformConfigError,
  checkCustomerRefKey,
  checkTypeformRegion,
  customFormsConnector,
  formCustomerRef,
  formCustomerRefs,
  formSubmissionEvent,
  formWebhookEvents,
  normalizeEmail,
  normalizePhone,
  parseCustomFormsCursor,
  parseFormProfile,
  parseTypeformFormIds,
  resolveFormProfile,
  signFormWebhook,
  typeformAnswer,
  typeformClient,
  typeformFieldTitles,
  typeformHost,
  typeformWebhookEvents,
  verifyFormWebhook,
  verifyTypeformWebhook,
  type CustomFormsConnectorOptions,
  type CustomFormsCursor,
  type FormProfileInput,
} from "../src/index.js";

// Test-only values, assembled at runtime so no scanner mistakes them for real secrets.
const KEY = ["forms", "test", "0".repeat(32)].join("-");
const OTHER_KEY = ["forms", "test", "1".repeat(32)].join("-");
const TOKEN = ["tfp", "test", "a".repeat(24)].join("_");
const NOW = new Date("2026-10-22T12:00:00Z");
const RECEIVED = NOW.toISOString();
const noSleep = async () => {};

const fields = TYPEFORM_MOCK_FIELDS;
const form = (title: string, responses: TypeformMockResponse[]) => ({ title, fields, responses });

function account(overrides: Partial<TypeformMockData> = {}): TypeformMockData {
  typeformResponse.reset();
  return {
    accessToken: TOKEN,
    forms: { [TYPEFORM_TEST_FORM]: form("Repair request", typeformResponse.many(3)) },
    ...overrides,
  };
}

function connector(mock: ReturnType<typeof typeformDocMock>, overrides: Partial<CustomFormsConnectorOptions> = {}) {
  return customFormsConnector({
    forms: [TYPEFORM_TEST_FORM],
    customerKey: KEY,
    now: () => NOW,
    typeform: { accessToken: TOKEN, fetch: mock.fetch, sleep: noSleep },
    ...overrides,
  });
}

async function collect(batches: AsyncIterable<{ events: unknown[]; cursor: string }>) {
  const out: { events: Record<string, unknown>[]; cursor: CustomFormsCursor }[] = [];
  for await (const b of batches) out.push({ events: b.events as Record<string, unknown>[], cursor: JSON.parse(b.cursor) as CustomFormsCursor });
  return out;
}

const emailRef = (n: number, key = KEY) => formCustomerRef(key, "email", synthetic.email(n));
const phoneRef = (n: number, key = KEY) => formCustomerRef(key, "phone", synthetic.phone(n).replace(/\D/g, ""));

describe("custom forms profiles", () => {
  it("ship a generic profile that reads the documented question names", () => {
    expect(GENERIC_FORM_PROFILE.id).toBe("generic");
    expect(GENERIC_FORM_PROFILE.fields.metal).toContain("metal");
    expect(GENERIC_FORM_PROFILE.values.metal.map((v) => v.value)).toContain("white_gold");
  });

  it("validate a profile and name the field that's wrong", () => {
    const base: FormProfileInput = { id: "client_forms", name: "Client forms", fields: { metal: "Metal" } };
    expect(parseFormProfile(base).values.metal).toEqual([]);
    const fails = (input: unknown) => {
      try {
        parseFormProfile(input);
      } catch (error) {
        expect(error).toBeInstanceOf(FormProfileError);
        return (error as Error).message;
      }
      throw new Error("expected the profile to be refused");
    };
    expect(fails({ ...base, id: "Client Forms" })).toContain("id:");
    expect(fails({ ...base, fields: { metal: 3 } })).toContain("fields.metal");
    expect(fails({ ...base, fields: { notes: "Notes" } })).toContain("fields");
    expect(fails({ ...base, forms: { abc: "sale" } })).toContain("forms.abc");
    expect(fails({ ...base, kinds: [{ match: "repair", kind: "ticket" }] })).toContain("kinds.0.kind");
    expect(fails({ ...base, kinds: [{ match: "(", kind: "repair_intake" }] })).toBe("form mapping profile: kinds.0.match is not a valid pattern");
    expect(fails({ ...base, values: { metal: [{ match: "[", value: "gold" }] } })).toBe("form mapping profile: values.metal.0.match is not a valid pattern");
    expect(fails({ ...base, values: { metal: [{ match: "gold", value: "Gold!" }] } })).toContain("values.metal.0.value");
    expect(fails({ ...base, values: { colour: [] } })).toContain("values");
    expect(fails(null)).toContain("profile:");
  });

  it("resolve generic, or read a profile JSON from the client's instance repo", async () => {
    expect(await resolveFormProfile(undefined)).toBe(GENERIC_FORM_PROFILE);
    expect(await resolveFormProfile(" generic ")).toBe(GENERIC_FORM_PROFILE);
    const json = JSON.stringify({ id: "client_forms", name: "Client forms", fields: {} });
    expect((await resolveFormProfile("/profiles/forms.json", async () => json)).id).toBe("client_forms");
    await expect(resolveFormProfile("/profiles/forms.json", async () => "{ not json")).rejects.toThrow("FORMS_MAPPING_PROFILE: could not read a JSON profile (SyntaxError)");
    await expect(resolveFormProfile("/profiles/forms.json", async () => JSON.stringify({ id: "x" }))).rejects.toThrow(FormProfileError);
    await expect(resolveFormProfile("/no/such/profile.json")).rejects.toThrow("could not read");
  });
});

describe("customer references", () => {
  it("link the same person across submissions without keeping the contact detail", () => {
    const ref = formCustomerRef(KEY, "email", "customer1@example.test");
    expect(ref).toMatch(new RegExp(`^${CUSTOMER_REF_PREFIX}[0-9a-f]{32}$`));
    expect(formCustomerRefs(KEY, { email: "  Customer1@Example.TEST " })).toEqual([ref]);
    expect(ref).not.toContain("customer1");
    expect(formCustomerRefs(KEY, { phone: "+1 (212) 555-0101" })).toEqual(formCustomerRefs(KEY, { phone: "12125550101" }));
  });

  it("are keyed with the instance's own key, so a plain hash or another instance's key can't match them", () => {
    const email = "customer1@example.test";
    const ref = formCustomerRef(KEY, "email", email).slice(CUSTOMER_REF_PREFIX.length);
    expect(formCustomerRef(OTHER_KEY, "email", email)).not.toBe(formCustomerRef(KEY, "email", email));
    for (const plain of [email, `email:${email}`]) expect(createHash("sha256").update(plain).digest("hex").slice(0, 32)).not.toBe(ref);
    expect(createHmac("sha256", KEY).update(`email:${email}`).digest("hex").slice(0, 32)).toBe(ref);
  });

  it("keep email and phone references apart and skip what isn't one", () => {
    expect(formCustomerRef(KEY, "email", "5550101")).not.toBe(formCustomerRef(KEY, "phone", "5550101"));
    expect(formCustomerRefs(KEY, { email: "not an email", phone: "12" })).toEqual([]);
    expect(normalizeEmail(42)).toBeUndefined();
    expect(normalizePhone({})).toBeUndefined();
    expect(normalizePhone(2125550101)).toBe("2125550101");
    expect(normalizePhone("1".repeat(16))).toBeUndefined();
  });

  it("refuse a key too short to be a secret", () => {
    expect(() => checkCustomerRefKey("short")).toThrow(CustomerRefKeyError);
    expect(() => checkCustomerRefKey(undefined)).toThrow("CUSTOMER_REF_KEY");
    expect(() => formCustomerRef("", "email", "customer1@example.test")).toThrow(CustomerRefKeyError);
    expect(checkCustomerRefKey(` ${KEY} `)).toBe(KEY);
  });
});

describe("custom forms normalization", () => {
  const titles = typeformFieldTitles({ fields });

  it("keeps only the profile's safe fields from a Typeform response", () => {
    typeformResponse.reset();
    const response = typeformResponse.one();
    const event = formSubmissionEvent(
      { provider: "typeform", formId: TYPEFORM_TEST_FORM, responseId: response.response_id, submittedAt: response.submitted_at, formTitle: "Service request", answers: response.answers.flatMap((a) => typeformAnswer(a, titles)) },
      GENERIC_FORM_PROFILE,
      KEY,
      RECEIVED,
    )!;
    expect(event).toEqual({
      id: `custom_forms_typeform:${TYPEFORM_TEST_FORM}:${typeformToken(1)}`,
      type: FORM_SUBMISSION_EVENT,
      occurredAt: "2026-09-30T15:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `custom_forms:typeform:${TYPEFORM_TEST_FORM}:${typeformToken(1)}`,
      payload: {
        submissionId: `typeform:${TYPEFORM_TEST_FORM}:${typeformToken(1)}`,
        provider: "typeform",
        formId: TYPEFORM_TEST_FORM,
        kind: "repair_intake",
        submittedAt: "2026-09-30T15:00:00.000Z",
        customerRef: emailRef(1),
        contactRefs: [emailRef(1), phoneRef(1)],
        requestedDate: "2026-11-03",
        requestedTime: "Afternoon",
        itemType: "ring",
        stone: "sapphire",
        budgetAmount: 750,
        preferredContact: "text",
        attachmentCount: 1,
        // The metal was typed as "other" and the store typed in: neither matches a profile value, so neither is kept.
        unmappedFields: ["metal", "storeLocation"],
        profile: "generic",
      },
    });
  });

  it("never keeps names, contact details, typed descriptions, file links or hidden fields", () => {
    typeformResponse.reset();
    const response = typeformResponse.one();
    const event = formSubmissionEvent(
      { provider: "typeform", formId: TYPEFORM_TEST_FORM, responseId: response.token, submittedAt: response.submitted_at, answers: response.answers.flatMap((a) => typeformAnswer(a, titles)) },
      GENERIC_FORM_PROFILE,
      KEY,
      RECEIVED,
    )!;
    const text = JSON.stringify(event).toLowerCase();
    for (const kept of [synthetic.email(1), "example.test", "212", "0101", synthetic.name(1).toLowerCase(), "prong", "street", "grandmother", "downtown", "ring-test.jpg", "files", "http", "utm", "mozilla", "score"]) {
      expect(text, kept).not.toContain(kept.toLowerCase());
    }
  });

  it("keeps a typed answer only when it matches a profile value, and a form's own choice as its label", () => {
    const profile = parseFormProfile({
      id: "client_forms",
      name: "Client forms",
      fields: { metal: "metal", storeLocation: "store", itemType: "item" },
      values: { storeLocation: [{ match: "downtown", value: "downtown" }], metal: [{ match: "\\b14k\\b", value: "gold_14k" }] },
    });
    const answers = [
      { names: ["store"], kind: "text" as const, values: ["Test Store Downtown"] },
      { names: ["metal"], kind: "text" as const, values: ["14k, it was my mother's, call me"] },
      { names: ["item"], kind: "choice" as const, values: [`  ${"Very long label ".repeat(10)}`] },
    ];
    const payload = formSubmissionEvent({ provider: "webhook", formId: "visit", responseId: "sub1", submittedAt: RECEIVED, answers }, profile, KEY, RECEIVED)!.payload;
    expect(payload).toMatchObject({ storeLocation: "downtown", metal: "gold_14k", kind: "other" });
    expect(payload.itemType).toHaveLength(80);
    const typed = formSubmissionEvent({ provider: "webhook", formId: "visit", responseId: "sub2", submittedAt: RECEIVED, answers: [{ names: ["item"], kind: "text", values: ["my late father's watch"] }] }, profile, KEY, RECEIVED)!.payload;
    expect(typed.itemType).toBeUndefined();
    expect(typed.unmappedFields).toEqual(["itemType"]);
  });

  it("reads dates, clock times, budgets and contact channels, and drops what isn't one", () => {
    const one = (name: string, kind: "text" | "choice" | "number" | "date", value: string | number) =>
      formSubmissionEvent(
        { provider: "webhook", formId: "visit", responseId: "s1", submittedAt: RECEIVED, answers: [{ names: [name], kind, values: typeof value === "string" ? [value] : [], ...(typeof value === "number" ? { number: value } : {}) }] },
        GENERIC_FORM_PROFILE,
        KEY,
        RECEIVED,
      )!.payload;
    expect(one("preferred date", "text", "2026-11-03")).toMatchObject({ requestedDate: "2026-11-03" });
    expect(one("preferred date", "text", "2026-02-30")).toMatchObject({ unmappedFields: ["requestedDate"] });
    expect(one("preferred date", "text", "next tuesday")).not.toHaveProperty("requestedDate");
    expect(one("preferred time", "text", "2:30 pm")).toMatchObject({ requestedTime: "14:30" });
    expect(one("preferred time", "text", "14:05")).toMatchObject({ requestedTime: "14:05" });
    expect(one("preferred time", "text", "12am")).toMatchObject({ requestedTime: "00:00" });
    expect(one("preferred time", "text", "12 p.m.")).toMatchObject({ requestedTime: "12:00" });
    for (const bad of ["13pm", "2", "25:00", "after lunch with my sister"]) expect(one("preferred time", "text", bad), bad).not.toHaveProperty("requestedTime");
    expect(one("preferred time", "text", "  2:30   PM  ")).toMatchObject({ requestedTime: "14:30" });
    // Hostile answers are cut and collapsed before any pattern sees them, so they can't make matching slow.
    const started = performance.now();
    for (const hostile of ["1" + " ".repeat(100_000) + "x", "a".repeat(100_000), " \t".repeat(50_000) + "!"]) one("preferred time", "text", hostile);
    expect(performance.now() - started).toBeLessThan(500);
    expect(one("budget", "number", 2499.6)).toMatchObject({ budgetAmount: 2500 });
    expect(one("budget", "number", -5)).toMatchObject({ unmappedFields: ["budget"] });
    expect(one("budget", "choice", "$1,000 - $2,000")).toMatchObject({ budgetRange: "$1,000 - $2,000" });
    expect(one("budget", "text", "whatever my husband says")).not.toHaveProperty("budgetRange");
    expect(one("contact method", "text", "Please call me after 5")).toMatchObject({ preferredContact: "phone" });
    expect(one("contact method", "text", "email")).toMatchObject({ preferredContact: "email" });
    expect(one("contact method", "choice", "Video call")).toMatchObject({ preferredContact: "video" });
    expect(one("contact method", "choice", "In person")).toMatchObject({ preferredContact: "in_person" });
    expect(one("contact method", "text", "carrier pigeon")).toMatchObject({ unmappedFields: ["contactChannel"] });
    expect(one("metal", "choice", "Platinum")).toMatchObject({ metal: "platinum" });
  });

  it("tells the kind of request by the stated kind, the form, the kind question, then the title", () => {
    const profile = parseFormProfile({ ...GENERIC_FORM_PROFILE, forms: { visitform: "appointment_request" } });
    const kind = (submission: Partial<Parameters<typeof formSubmissionEvent>[0]>) =>
      formSubmissionEvent({ provider: "webhook", formId: "anyform", responseId: "s1", submittedAt: RECEIVED, answers: [], ...submission }, profile, KEY, RECEIVED)!.payload.kind;
    expect(kind({ kind: "custom_order_request", formId: "visitform" })).toBe("custom_order_request");
    expect(kind({ formId: "visitform" })).toBe("appointment_request");
    expect(kind({ answers: [{ names: ["Request type"], kind: "choice", values: ["Design something custom"] }] })).toBe("custom_order_request");
    expect(kind({ formTitle: "Book an appointment" })).toBe("appointment_request");
    expect(kind({ formTitle: "Contact us" })).toBe("other");
    // Words outside the kind question don't decide it.
    expect(kind({ answers: [{ names: ["notes"], kind: "text", values: ["please repair it"] }] })).toBe("other");
  });

  it("gives no event without a form and response id, and leaves an unreadable time for the pipeline to dead-letter", () => {
    const base = { provider: "webhook" as const, formId: "visit", responseId: "s1", submittedAt: "yesterday", answers: [] };
    expect(formSubmissionEvent({ ...base, formId: "../x" }, GENERIC_FORM_PROFILE, KEY, RECEIVED)).toBeNull();
    expect(formSubmissionEvent({ ...base, responseId: "" }, GENERIC_FORM_PROFILE, KEY, RECEIVED)).toBeNull();
    expect(formSubmissionEvent(base, GENERIC_FORM_PROFILE, KEY, RECEIVED)!.occurredAt).toBeUndefined();
  });
});

describe("Typeform answers", () => {
  it("carry choice labels as the form's words and 'other' text as the customer's", () => {
    const titles = new Map([["f1", "Metal"]]);
    expect(typeformAnswer({ field: { id: "f1", ref: "metal" }, type: "choice", choice: { label: "Platinum" } }, titles)).toEqual([{ names: ["f1", "metal", "Metal"], kind: "choice", values: ["Platinum"] }]);
    expect(typeformAnswer({ field: { id: "f1" }, type: "choice", choice: { other: "my own words" } }, titles)).toEqual([{ names: ["f1", "Metal"], kind: "text", values: ["my own words"] }]);
    expect(typeformAnswer({ field: { id: "f1" }, type: "choices", choices: { labels: ["A", "", "B"], other: "typed" } }, titles)).toEqual([
      { names: ["f1", "Metal"], kind: "choice", values: ["A", "B"] },
      { names: ["f1", "Metal"], kind: "text", values: ["typed"] },
    ]);
    expect(typeformAnswer({ field: { id: "f1" }, type: "choices", choices: {} }, titles)).toEqual([]);
    expect(typeformAnswer({ field: { id: "f2" }, type: "boolean", boolean: true }, titles)).toEqual([{ names: ["f2"], kind: "boolean", values: [] }]);
    expect(typeformAnswer({ field: { id: "f2" }, type: "file_url", file_url: "https://files.example.test/x.jpg" }, titles)).toEqual([{ names: ["f2"], kind: "file", values: [] }]);
    for (const type of ["url", "payment", "signature", "multi_format"]) expect(typeformAnswer({ field: { id: "f2" }, type, url: "https://x.example.test" }, titles)).toEqual([]);
    for (const type of ["text", "email", "phone_number", "date", "number"]) expect(typeformAnswer({ field: { id: "f2" }, type }, titles)).toEqual([]);
    expect(typeformAnswer(null, titles)).toEqual([]);
  });

  it("read question titles from groups too", () => {
    const titles = typeformFieldTitles({ fields: [{ id: "g1", title: "About the piece", type: "group", properties: { fields: [{ id: "f9", title: "Metal" }, null] } }, "junk"] });
    expect([...titles]).toEqual([["g1", "About the piece"], ["f9", "Metal"]]);
    expect(typeformFieldTitles(null).size).toBe(0);
  });
});

describe("Typeform client", () => {
  it("only GETs a form or its responses, with checked parameters", async () => {
    const mock = typeformDocMock(account());
    const client = typeformClient({ accessToken: TOKEN, fetch: mock.fetch, sleep: noSleep });
    expect((await client.get("form", TYPEFORM_TEST_FORM)).title).toBe("Repair request");
    const page = await client.get("responses", TYPEFORM_TEST_FORM, { since: 0, until: 2_000_000_000 });
    expect((page.items as unknown[]).length).toBe(3);
    expect(mock.fetch.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(new URL(mock.fetch.calls[1]!.url).searchParams.toString()).toBe(`page_size=${TYPEFORM_PAGE_SIZE}&since=0&until=2000000000`);
    const get = client.get as (read: string, formId: string, query?: unknown) => Promise<unknown>;
    await expect(get("webhooks", TYPEFORM_TEST_FORM)).rejects.toThrow("only reads forms and their responses");
    await expect(get("form", "../workspaces")).rejects.toThrow("form id");
    await expect(get("form", TYPEFORM_TEST_FORM, { since: 0, until: 1 })).rejects.toThrow("without parameters");
    await expect(get("responses", TYPEFORM_TEST_FORM)).rejects.toThrow("Unix seconds");
    await expect(get("responses", TYPEFORM_TEST_FORM, { since: 5, until: 4 })).rejects.toThrow("Unix seconds");
    await expect(get("responses", TYPEFORM_TEST_FORM, { since: 1.5, until: 4 })).rejects.toThrow("Unix seconds");
    await expect(get("responses", TYPEFORM_TEST_FORM, { since: 0, until: 4, before: "a&page_size=1" })).rejects.toThrow("response token");
    expect(mock.fetch.calls).toHaveLength(2);
  });

  it("would be refused by the docs mock if it ever sent anything but a GET", async () => {
    const mock = typeformDocMock(account());
    await expect(mock.fetch(`https://api.typeform.com/forms/${TYPEFORM_TEST_FORM}`, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`https://api.typeform.com/forms/${TYPEFORM_TEST_FORM}/webhooks/tag`, { method: "PUT" })).rejects.toThrow(UndocumentedRequestError);
  });

  it("checks its settings", () => {
    expect(() => typeformClient({ accessToken: " " })).toThrow("set TYPEFORM_ACCESS_TOKEN");
    expect(() => typeformClient({ accessToken: "two words" })).toThrow("spaces");
    expect(() => typeformClient({ accessToken: TOKEN, host: "api.typeform.example" })).toThrow(TypeformConfigError);
    expect(typeformHost(undefined)).toBe("api.typeform.com");
    expect(typeformHost(" API.TYPEFORM.EU ")).toBe("api.typeform.eu");
    expect(TYPEFORM_HOSTS).toEqual(["api.typeform.com", "api.eu.typeform.com", "api.typeform.eu"]);
  });

  it("sends at most two requests a second", async () => {
    let now = 1_000_000;
    const waits: number[] = [];
    const mock = typeformDocMock(account());
    const client = typeformClient({
      accessToken: TOKEN,
      fetch: mock.fetch,
      clock: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    await client.get("form", TYPEFORM_TEST_FORM);
    now += 100;
    await client.get("form", TYPEFORM_TEST_FORM);
    now += 900;
    await client.get("form", TYPEFORM_TEST_FORM);
    expect(waits).toEqual([TYPEFORM_MIN_INTERVAL_MS - 100]);
  });

  it("waits out a 429 and gives up after three", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const mock = typeformDocMock(account({ rateLimits: [{ retryAfter: 2 }, {}, { retryAfter: 600 }] }));
    const client = typeformClient({ accessToken: TOKEN, fetch: mock.fetch, sleep, clock: () => 0 });
    expect(((await client.get("responses", TYPEFORM_TEST_FORM, { since: 0, until: 2_000_000_000 })).items as unknown[]).length).toBe(3);
    expect(waits.filter((ms) => ms !== TYPEFORM_MIN_INTERVAL_MS)).toEqual([2000, 2000, 60_000]);
    const limited = typeformDocMock(account({ rateLimits: [{}, {}, {}, {}] }));
    const err = await typeformClient({ accessToken: TOKEN, fetch: limited.fetch, sleep, rateLimitRetries: 3 })
      .get("responses", TYPEFORM_TEST_FORM, { since: 0, until: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeformApiError);
    expect(err).toMatchObject({ status: 429 });
  });

  it("explains errors without echoing the token", async () => {
    const mock = typeformDocMock(account({ accessToken: "another-token" }));
    const client = typeformClient({ accessToken: TOKEN, fetch: mock.fetch, sleep: noSleep });
    const unauthorized = await client.get("form", TYPEFORM_TEST_FORM).catch((e: unknown) => e as TypeformApiError);
    expect(unauthorized).toMatchObject({ status: 401, code: "AUTHENTICATION_FAILED" });
    expect(unauthorized.message).toContain("forms:read and responses:read");
    expect(unauthorized.message).not.toContain(TOKEN);
    const ok = typeformClient({ accessToken: TOKEN, fetch: typeformDocMock(account()).fetch, sleep: noSleep });
    await expect(ok.get("form", "Missing1")).rejects.toThrow("check the form id");
    const html = typeformClient({ accessToken: TOKEN, sleep: noSleep, fetch: async () => new Response("<html>", { status: 200 }) });
    await expect(html.get("form", TYPEFORM_TEST_FORM)).rejects.toThrow("did not answer with JSON");
    const bad = typeformClient({ accessToken: TOKEN, sleep: noSleep, fetch: async () => new Response("oops", { status: 500 }) });
    await expect(bad.get("form", TYPEFORM_TEST_FORM)).rejects.toThrow("Typeform answered HTTP 500");
  });

  it("names the right host when the account's responses live in another region", () => {
    expect(() => checkTypeformRegion({ _links: { responses: "https://api.eu.typeform.com/forms/x/responses" } }, "api.typeform.com")).toThrow("set TYPEFORM_API_HOST to api.eu.typeform.com");
    expect(() => checkTypeformRegion({ _links: { responses: "https://api.typeform.example/forms/x/responses" } }, "api.typeform.com")).toThrow("doesn't know");
    expect(() => checkTypeformRegion({ _links: { responses: "https://api.typeform.eu/forms/x/responses" } }, "api.typeform.eu")).not.toThrow();
    expect(() => checkTypeformRegion({ _links: { responses: "not a url" } }, "api.typeform.com")).not.toThrow();
    expect(() => checkTypeformRegion({}, "api.typeform.com")).not.toThrow();
  });
});

describe("custom forms connector", () => {
  it("survives a full import, a replay, a crash and a retry, paging every form to the end", async () => {
    typeformResponse.reset();
    const first = typeformResponse.many(TYPEFORM_PAGE_SIZE + 5);
    const second = typeformResponse.many(3);
    const data: TypeformMockData = { accessToken: TOKEN, forms: { [TYPEFORM_TEST_FORM]: form("Repair request", first), [TYPEFORM_TEST_FORM_2]: form("Book an appointment", second) } };
    const mock = typeformDocMock(data);
    const result = await checkConnectorSync({
      makeConnector: () => connector(mock, { forms: [TYPEFORM_TEST_FORM, TYPEFORM_TEST_FORM_2] }),
      expected: { ingested: TYPEFORM_PAGE_SIZE + 8 },
    });
    expect(result.full.batches).toBe(3);
    expect(JSON.parse(result.full.cursor!)).toMatchObject({ pass: "historical", form: null, before: null });
    const pages = mock.fetch.calls.filter((c) => c.url.includes("/responses")).slice(0, 3).map((c) => new URL(c.url).searchParams.get("before"));
    expect(pages).toEqual([null, typeformToken(TYPEFORM_PAGE_SIZE), null]);
    expect(mock.fetch.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("imports five years and no further, and only the forms it is given", async () => {
    typeformResponse.reset();
    const old = typeformResponse.one({ submitted_at: "2021-10-21T00:00:00Z" });
    const recent = typeformResponse.one({ submitted_at: "2021-10-23T00:00:00Z" });
    const mock = typeformDocMock({ accessToken: TOKEN, forms: { [TYPEFORM_TEST_FORM]: form("Repairs", [old, recent]), [TYPEFORM_TEST_FORM_2]: form("Other", typeformResponse.many(2)) } });
    const batches = await collect(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(batches.flatMap((b) => b.events).map((e) => (e.payload as { submissionId: string }).submissionId)).toEqual([`typeform:${TYPEFORM_TEST_FORM}:${recent.token}`]);
    const query = new URL(mock.fetch.calls[1]!.url).searchParams;
    expect([query.get("since"), query.get("until")]).toEqual([String(Date.parse("2021-10-22T12:00:00Z") / 1000), String(NOW.getTime() / 1000)]);
    expect(batches.at(-1)!.cursor).toEqual({ pass: "historical", form: null, before: null, since: "2021-10-22T12:00:00.000Z", until: RECEIVED, nextFrom: RECEIVED });
    // A finished import stays finished.
    expect(await collect(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(batches.at(-1)!.cursor) }))).toEqual([]);
  });

  it("syncs from where the last pass started, less five minutes, so a late response isn't missed", async () => {
    typeformResponse.reset();
    const data = account({ forms: { [TYPEFORM_TEST_FORM]: form("Repairs", []) } });
    const mock = typeformDocMock(data);
    const first = await collect(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(first.at(-1)!.cursor).toEqual({
      pass: "incremental",
      form: null,
      before: null,
      since: new Date(NOW.getTime() - 48 * 3_600_000).toISOString(),
      until: RECEIVED,
      nextFrom: new Date(NOW.getTime() - CUSTOM_FORMS_OVERLAP_MS).toISOString(),
    });
    // Submitted two minutes before the first pass ended, but only visible to the API afterwards.
    data.forms[TYPEFORM_TEST_FORM]!.responses.push(typeformResponse.one({ submitted_at: "2026-10-22T11:58:00Z" }));
    const later = new Date(NOW.getTime() + 3_600_000);
    const second = await collect(connector(mock, { now: () => later }).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(first.at(-1)!.cursor) }));
    expect(second.flatMap((b) => b.events)).toHaveLength(1);
    const since = new URL(mock.fetch.calls.at(-1)!.url).searchParams.get("since");
    expect(Number(since)).toBe((NOW.getTime() - CUSTOM_FORMS_OVERLAP_MS) / 1000);
  });

  it("stops rather than loop when Typeform answers the same page again", async () => {
    typeformResponse.reset();
    const full = { items: typeformResponse.many(TYPEFORM_PAGE_SIZE) };
    let calls = 0;
    const client = {
      host: "api.typeform.com" as const,
      get: (async (read: string) => {
        // Bounded, so a missing guard fails here instead of hanging the test run.
        if (++calls > 10) throw new Error("kept reading the same page");
        return read === "form" ? { title: "Repairs", fields } : full;
      }) as never,
    };
    const c = connector(typeformDocMock(account()), { client });
    await expect(collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow("same page of responses twice");
  });

  it("never reads backwards when the clock was set back", async () => {
    const mock = typeformDocMock(account());
    const ahead: CustomFormsCursor = { pass: "incremental", form: null, before: null, since: RECEIVED, until: RECEIVED, nextFrom: "2026-10-23T00:00:00.000Z" };
    const batches = await collect(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(ahead) }));
    expect(batches[0]!.cursor.since).toBe(RECEIVED);
  });

  it("resumes a page in progress, and starts over when its form is no longer read", async () => {
    const mock = typeformDocMock(account());
    const resume: CustomFormsCursor = { pass: "historical", form: TYPEFORM_TEST_FORM, before: typeformToken(1), since: "2021-10-22T12:00:00.000Z", until: RECEIVED, nextFrom: RECEIVED };
    const batches = await collect(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(resume) }));
    expect(batches[0]!.events).toHaveLength(2);
    const gone = await collect(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...resume, form: "RemovedForm" }) }));
    expect(gone[0]!.events).toHaveLength(3);
    const goneIncremental = await collect(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...resume, pass: "incremental", form: "RemovedForm" }) }));
    expect(goneIncremental[0]!.cursor.since).toBe(RECEIVED);
  });

  it("refuses a checkpoint that isn't its own", () => {
    const good: CustomFormsCursor = { pass: "historical", form: TYPEFORM_TEST_FORM, before: null, since: "2021-10-22T12:00:00.000Z", until: RECEIVED, nextFrom: RECEIVED };
    expect(parseCustomFormsCursor(JSON.stringify(good))).toEqual(good);
    expect(parseCustomFormsCursor(null)).toBeNull();
    for (const bad of [
      null,
      "text",
      { ...good, pass: "full" },
      { ...good, form: "../x" },
      { ...good, form: 3 },
      { ...good, before: "a b" },
      { ...good, before: 7 },
      { ...good, since: "2021-10-22" },
      { ...good, until: "2026-13-40T00:00:00Z" },
      { ...good, nextFrom: undefined },
      { ...good, since: RECEIVED, until: "2021-10-22T12:00:00.000Z" },
    ]) {
      expect(() => parseCustomFormsCursor(JSON.stringify(bad)), JSON.stringify(bad)).toThrow("Custom forms checkpoint is not in the expected shape");
    }
  });

  it("stops with the host to set when the account is on another region", async () => {
    const mock = typeformDocMock(account({ responsesHost: "api.eu.typeform.com" }));
    await expect(collect(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow("set TYPEFORM_API_HOST to api.eu.typeform.com");
    const eu = connector(mock, { typeform: { accessToken: TOKEN, host: "api.eu.typeform.com", fetch: mock.fetch, sleep: noSleep } });
    expect((await collect(eu.historicalImport({ organizationId: TEST_ORG, cursor: null })))[0]!.events).toHaveLength(3);
    expect(mock.fetch.calls.at(-1)!.url.startsWith("https://api.eu.typeform.com/forms/")).toBe(true);
  });

  it("stores what it reads through the pipeline", async () => {
    const mock = typeformDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: noSleep });
    expect(report).toMatchObject({ ingested: 3, deadLettered: 0 });
  });

  it("checks its settings", () => {
    const mock = typeformDocMock(account());
    expect(() => connector(mock, { forms: [] })).toThrow("set TYPEFORM_FORM_IDS");
    expect(() => connector(mock, { forms: ["a-b"] })).toThrow("letters and digits");
    expect(() => connector(mock, { customerKey: "short" })).toThrow(CustomerRefKeyError);
    expect(parseTypeformFormIds(" a1, b2 ,a1,")).toEqual(["a1", "b2"]);
    expect(() => parseTypeformFormIds(undefined)).toThrow("set TYPEFORM_FORM_IDS");
  });

  it("declares no writes, so a read-only gate, or any policy, has nothing to allow", async () => {
    const c = connector(typeformDocMock(account()));
    expect(c.writes).toBe(CUSTOM_FORMS_WRITES);
    expect(c.writes).toEqual([]);
    expect(await assertWritesRefused(c)).toEqual([]);
    const everything = writePolicy(["custom_forms:*"]);
    expect((c.writes ?? []).filter((w) => everything.allows(w) || READ_ONLY.allows(w))).toEqual([]);
  });

  it("turns a Typeform webhook into the same event the sync stores", async () => {
    typeformResponse.reset();
    const response = typeformResponse.one();
    const mock = typeformDocMock({ accessToken: TOKEN, forms: { [TYPEFORM_TEST_FORM]: form("Repair request", [response]) } });
    const c = connector(mock);
    const synced = (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null })))[0]!.events[0]!;
    const { response_id: _id, ...rest } = response;
    const delivery = { event_id: "evtTEST1", event_type: "form_response", form_response: { form_id: TYPEFORM_TEST_FORM, ...rest, definition: { id: TYPEFORM_TEST_FORM, title: "Repair request", fields } } };
    const [hooked] = c.handleWebhook!(delivery) as Record<string, unknown>[];
    expect(hooked).toEqual(synced);
    expect(c.handleWebhook!({ ...delivery, form_response: { ...delivery.form_response, form_id: "OtherForm" } })).toEqual([]);
    expect(c.handleWebhook!({ ...delivery, event_type: "form_partial_response" })).toEqual([]);
    expect(c.handleWebhook!({ event_type: "form_response" })).toEqual([]);
    expect(c.handleWebhook!(null)).toEqual([]);
    expect(typeformWebhookEvents({ ...delivery, form_response: { ...delivery.form_response, token: "" } }, [TYPEFORM_TEST_FORM], { profile: GENERIC_FORM_PROFILE, customerKey: KEY, receivedAt: RECEIVED })).toEqual([]);
  });

  it("keeps its fixtures synthetic", () => {
    typeformResponse.reset();
    expect(() => assertSynthetic(typeformResponse.many(50))).not.toThrow();
  });
});

describe("Typeform webhook signatures", () => {
  const SECRET = ["typeform", "hook", "0".repeat(32)].join("-");
  const body = JSON.stringify({ event_id: "evtTEST1", event_type: "form_response", form_response: { form_id: TYPEFORM_TEST_FORM } });
  const sign = (b: string, secret = SECRET) => createHmac("sha256", secret).update(b).digest("base64");

  it("accepts sha256= and the base64 HMAC of the raw body", () => {
    expect(verifyTypeformWebhook(SECRET, body, `sha256=${sign(body)}`)).toEqual({ ok: true });
    expect(verifyTypeformWebhook(SECRET, Buffer.from(body), ` sha256=${sign(body)} `)).toEqual({ ok: true });
  });

  it("rejects a changed body, the wrong secret, and anything not in Typeform's format", () => {
    expect(verifyTypeformWebhook(SECRET, tamper(body), `sha256=${sign(body)}`)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyTypeformWebhook(SECRET, body, `sha256=${sign(body, `${SECRET}x`)}`)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyTypeformWebhook(SECRET, body, sign(body))).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTypeformWebhook(SECRET, body, `sha1=${sign(body)}`)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTypeformWebhook(SECRET, body, `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTypeformWebhook(SECRET, body, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(verifyTypeformWebhook("", body, `sha256=${sign(body)}`)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("signed form submissions", () => {
  const SECRET = ["webhook", "test", "0".repeat(32)].join("-");
  const NOW_S = NOW.getTime() / 1000;
  const submission = { id: "sub_1", form: "repair-intake", submittedAt: RECEIVED, fields: { "item type": "Ring", metal: "White gold", email: synthetic.email(7), phone: synthetic.phone(7), notes: `Call ${synthetic.phone(7)}, I'm at 12 Test Street`, photo: "https://files.example.test/ring.jpg" } };
  const body = JSON.stringify(submission);
  const headers = (b = body, at = NOW_S) => {
    const h = signFormWebhook(SECRET, b, at);
    return { timestamp: h[FORM_TIMESTAMP_HEADER]!, signature: h[FORM_SIGNATURE_HEADER]! };
  };

  it("accept HMAC-SHA256 of the timestamp, a full stop and the raw body, within five minutes either way", () => {
    const h = headers();
    expect(h.signature).toBe(`v1=${createHmac("sha256", SECRET).update(`${NOW_S}.${body}`).digest("hex")}`);
    expect(verifyFormWebhook(SECRET, body, h, NOW_S)).toEqual({ ok: true });
    expect(verifyFormWebhook(SECRET, Buffer.from(body), h, NOW_S + 299)).toEqual({ ok: true });
    expect(verifyFormWebhook(SECRET, body, h, NOW_S - 299)).toEqual({ ok: true });
  });

  it("refuse a replay older than five minutes, or a timestamp too far ahead", () => {
    const h = headers();
    expect(verifyFormWebhook(SECRET, body, h, NOW_S + 301)).toEqual({ ok: false, reason: "expired" });
    expect(verifyFormWebhook(SECRET, body, h, NOW_S - 301)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuse a timestamp changed after signing, a changed body and the wrong secret", () => {
    const h = headers();
    expect(verifyFormWebhook(SECRET, body, { ...h, timestamp: String(NOW_S + 60) }, NOW_S + 60)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyFormWebhook(SECRET, tamper(body), h, NOW_S)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyFormWebhook(`${SECRET}x`, body, h, NOW_S)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuse missing and malformed headers", () => {
    const h = headers();
    expect(verifyFormWebhook(SECRET, body, { ...h, timestamp: undefined }, NOW_S)).toEqual({ ok: false, reason: "missing" });
    expect(verifyFormWebhook(SECRET, body, { ...h, signature: undefined }, NOW_S)).toEqual({ ok: false, reason: "missing" });
    expect(verifyFormWebhook("", body, h, NOW_S)).toEqual({ ok: false, reason: "missing" });
    expect(verifyFormWebhook(SECRET, body, { ...h, timestamp: "soon" }, NOW_S)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyFormWebhook(SECRET, body, { ...h, signature: h.signature.slice(3) }, NOW_S)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyFormWebhook(SECRET, body, { ...h, signature: `v0=${h.signature.slice(3)}` }, NOW_S)).toEqual({ ok: false, reason: "malformed" });
  });

  it("become one event with only the profile's values, keyed by form and submission id", () => {
    const options = { profile: GENERIC_FORM_PROFILE, customerKey: KEY, receivedAt: RECEIVED };
    const [event] = formWebhookEvents(JSON.parse(body), options);
    expect(event).toMatchObject({ idempotencyKey: "custom_forms:webhook:repair-intake:sub_1", occurredAt: RECEIVED });
    expect(event!.payload).toEqual({
      submissionId: "webhook:repair-intake:sub_1",
      provider: "webhook",
      formId: "repair-intake",
      kind: "repair_intake",
      submittedAt: RECEIVED,
      customerRef: emailRef(7),
      contactRefs: [emailRef(7), phoneRef(7)],
      itemType: "ring",
      metal: "white_gold",
      attachmentCount: 0,
      profile: "generic",
    });
    expect(JSON.stringify(event).toLowerCase()).not.toMatch(/example\.test|555|street|ring\.jpg|call/);
    expect(formWebhookEvents({ ...submission, kind: "appointment_request", fields: { budget: 1200, wants: ["a", 3], ok: true, nested: { a: 1 } } }, options)[0]!.payload).toMatchObject({ kind: "appointment_request", budgetAmount: 1200 });
    expect(formWebhookEvents({ ...submission, kind: "sale", fields: { budget: ["$500 or so"] } }, options)[0]!.payload).toMatchObject({ kind: "repair_intake", unmappedFields: ["budget"] });
    for (const bad of [null, [], { ...submission, id: 1 }, { ...submission, fields: [] }, { ...submission, fields: null }, { ...submission, form: undefined }]) expect(formWebhookEvents(bad, options)).toEqual([]);
    expect(formWebhookEvents({ ...submission, submittedAt: 5 }, options)[0]!.occurredAt).toBeUndefined();
    expect(formWebhookEvents({ ...submission, form: "f1", title: "Book a visit", fields: {} }, options)[0]!.payload.kind).toBe("appointment_request");
  });
});

describe("Typeform docs mock", () => {
  const get = (mock: ReturnType<typeof typeformDocMock>, path: string, host = "api.typeform.com") =>
    mock.fetch(`https://${host}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

  it("refuses what the docs say it refuses", async () => {
    const mock = typeformDocMock(account());
    const base = `/forms/${TYPEFORM_TEST_FORM}/responses`;
    expect((await get(mock, `${base}?sort=submitted_at,asc&page_size=2`)).body.items).toHaveLength(2);
    expect((await get(mock, `${base}?page_size=1001`)).status).toBe(400);
    expect((await get(mock, `${base}?page_size=0`)).status).toBe(400);
    expect((await get(mock, `${base}?cursor=1`)).status).toBe(400);
    expect((await get(mock, `${base}?since=yesterday`)).status).toBe(400);
    expect((await get(mock, `${base}?before=unknownToken`)).status).toBe(400);
    expect((await get(mock, `/forms/Missing1/responses`)).status).toBe(404);
    expect((await mock.fetch(`https://api.typeform.com${base}`)).status).toBe(401);
    await expect(get(mock, base, "api.typeform.eu")).rejects.toThrow("keeps responses on api.typeform.com");
    const page = await get(mock, `${base}?page_size=25`);
    expect(page.body).toMatchObject({ total_items: 3, page_count: 1 });
  });

  it("answers from the EU hosts when the account lives there, and rate-limits without Retry-After when asked", async () => {
    const mock = typeformDocMock(account({ responsesHost: "api.typeform.eu", rateLimits: [{}] }));
    expect((await get(mock, `/forms/${TYPEFORM_TEST_FORM}/responses`, "api.typeform.eu")).status).toBe(429);
    expect((await get(mock, `/forms/${TYPEFORM_TEST_FORM}`, "api.typeform.eu")).body._links).toMatchObject({ responses: `https://api.typeform.eu/forms/${TYPEFORM_TEST_FORM}/responses` });
    expect((await get(mock, `/forms/Missing1`)).status).toBe(404);
    expect(mock.fetch.calls.at(-1)!.url).toBe("https://api.typeform.com/forms/Missing1");
  });
});
