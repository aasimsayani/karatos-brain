import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  TEST_ORG,
  UndocumentedRequestError,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  klaviyoCampaign,
  klaviyoDocMock,
  klaviyoFlow,
  klaviyoList,
  klaviyoMetric,
  klaviyoProfile,
  klaviyoSegment,
  tamper,
  testPipeline,
  type KlaviyoMock,
  type KlaviyoMockData,
} from "@karatos/connector-testkit";
import { createHmac } from "node:crypto";
import {
  CONTACT_REF_PREFIX,
  KLAVIYO_API_URL,
  KLAVIYO_CONSENT_TOPICS,
  KLAVIYO_EVENTS,
  KLAVIYO_REPORT_STATISTICS,
  KLAVIYO_REVISION,
  KLAVIYO_WRITES,
  KlaviyoApiError,
  KlaviyoConfigError,
  KlaviyoCustomerKeyError,
  KlaviyoReplayGuard,
  isKlaviyoReadRequest,
  isKlaviyoReportBody,
  klaviyoCampaignEvent,
  klaviyoChannel,
  klaviyoClient,
  klaviyoConnector,
  klaviyoConsent,
  klaviyoContactRef,
  klaviyoContactRefs,
  klaviyoFlowEvent,
  klaviyoGroupEvent,
  klaviyoMembershipEvent,
  klaviyoNormalizeEmail,
  klaviyoNormalizePhone,
  klaviyoProfileEvent,
  klaviyoProfileRef,
  klaviyoReportBody,
  klaviyoReportEvents,
  klaviyoReportWindows,
  klaviyoTime,
  klaviyoWebhookEventIds,
  klaviyoWebhookEvents,
  klaviyoWebhookTime,
  parseKlaviyoCursor,
  verifyKlaviyoWebhook,
  type KlaviyoConnectorOptions,
  type KlaviyoCursor,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const API_KEY = ["pk", "testkey".repeat(4)].join("_");
const CUSTOMER_KEY = "k".repeat(16) + "0123456789abcdef0123456789abcdef";
const OTHER_KEY = "z".repeat(48);
const WEBHOOK_SECRET = ["whk", "test", "0".repeat(24)].join("-");
const NOW = () => new Date("2026-01-20T00:00:00Z");
const RECEIVED = "2026-01-20T00:00:00.000Z";
const ctx = (key = CUSTOMER_KEY) => ({ customerKey: key, receivedAt: RECEIVED });
const noSleep = async () => {};

/** Computed with custom forms' formCustomerRefs (origin/custom-forms, customer.ts) for this key, "  Customer1@Example.TEST " and "+12125550101". */
const FORMS_VECTOR = ["form_customer:90f942d93187683e22d3b01b5d637c4f", "form_customer:ad870a9453c3f4217953d743ac88a2e3"];

function account(overrides: Partial<KlaviyoMockData> = {}): KlaviyoMockData {
  for (const b of [klaviyoProfile, klaviyoList, klaviyoSegment, klaviyoCampaign, klaviyoFlow, klaviyoMetric]) b.reset();
  const profiles = klaviyoProfile.many(3);
  // A profile with no contact details at all: it keeps its profile reference.
  profiles[2] = { ...profiles[2]!, email: null, phone_number: null };
  // One Klaviyo returned without its update time: dead-lettered, not given a made-up one.
  const undated = { ...klaviyoProfile.one(), updated: "" };
  const [p1, p2, p3] = profiles.map((p) => p.id);
  const lists = [klaviyoList.one({ members: [{ profileId: p1!, joinedAt: "2025-03-01T00:00:00+00:00" }, { profileId: p2!, joinedAt: "2026-01-19T12:00:00+00:00" }] }), klaviyoList.one({ members: [{ profileId: p3!, joinedAt: "2024-01-01T00:00:00+00:00" }] })];
  const segments = [klaviyoSegment.one({ members: [{ profileId: p1!, joinedAt: "2025-05-01T00:00:00+00:00" }] })];
  const metrics = [klaviyoMetric.one({ name: "Opened Email" }), klaviyoMetric.one({ name: "Placed Order", integration: { name: "Shopify", category: "eCommerce" } })];
  return {
    apiKey: API_KEY,
    profiles: [...profiles, undated],
    lists,
    segments,
    campaigns: klaviyoCampaign.many(2),
    flows: klaviyoFlow.many(1),
    metrics,
    campaignValues: [
      { at: "2025-06-01T00:00:00+00:00", groupings: { campaign_id: "TC0001", campaign_message_id: "TCM001", campaign_message_name: "Summer sale email", send_channel: "email" }, statistics: { recipients: 100, delivered: 98, opens: 60, opens_unique: 40, clicks: 12, clicks_unique: 9, conversions: 3, conversion_uniques: 3, conversion_value: 1250.5, unsubscribes: 1, bounced: 2 } },
      { at: "2026-01-10T00:00:00+00:00", groupings: { campaign_id: "TC0002", campaign_message_id: "TCM002", campaign_message_name: "Draft text", send_channel: "sms" }, statistics: {} },
    ],
    flowValues: [{ at: "2024-02-01T00:00:00+00:00", groupings: { flow_id: "TF0001", flow_message_id: "TFM001", send_channel: "email" }, statistics: { recipients: 40, opens: 20, conversions: 2, conversion_value: 300 } }],
    ...overrides,
  };
}

const options = (mock: KlaviyoMock, extra: Partial<KlaviyoConnectorOptions> = {}): KlaviyoConnectorOptions => ({
  apiKey: API_KEY,
  customerKey: CUSTOMER_KEY,
  fetch: mock.fetch,
  sleep: noSleep,
  now: NOW,
  ...extra,
});
const connector = (mock: KlaviyoMock, extra: Partial<KlaviyoConnectorOptions> = {}) => klaviyoConnector(options(mock, extra));

async function drain(c: ReturnType<typeof klaviyoConnector>, mode: "historical" | "incremental", cursor: string | null = null) {
  const batches = [];
  for await (const b of mode === "historical" ? c.historicalImport({ organizationId: TEST_ORG, cursor }) : c.incrementalSync({ organizationId: TEST_ORG, cursor })) batches.push(b);
  return batches;
}

/** A fetch that records what was sent, headers included, then answers from the mock. */
function recording(mock: KlaviyoMock) {
  const sent: { method: string; url: string; headers: Record<string, string>; body: string }[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    sent.push({ method: init?.method ?? "GET", url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? "") });
    return mock.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("Klaviyo client", () => {
  it("checks its key, naming the setting but never the value", () => {
    expect(() => klaviyoClient({ apiKey: "" })).toThrow(/set KLAVIYO_PRIVATE_API_KEY/);
    const site = ["Ab", "C123"].join("");
    expect(() => klaviyoClient({ apiKey: site })).toThrow(KlaviyoConfigError);
    try {
      klaviyoClient({ apiKey: `${API_KEY}!` });
    } catch (error) {
      expect(String(error)).not.toContain(API_KEY);
    }
  });

  it("allows only listed GETs and the two reports with a body it built, whatever the method, host or path", () => {
    const url = (path: string) => new URL(`${KLAVIYO_API_URL}${path}`);
    const body = klaviyoReportBody("campaignValues", { start: "2025-01-01T00:00:00Z", end: "2025-12-31T23:59:59Z", conversionMetricId: "TM0002" });
    expect(isKlaviyoReadRequest("GET", url("/api/profiles/"), undefined)).toBe(true);
    expect(isKlaviyoReadRequest("GET", url("/api/lists/TL0001/relationships/profiles/"), undefined)).toBe(true);
    expect(isKlaviyoReadRequest("POST", url("/api/campaign-values-reports/"), body)).toBe(true);
    // Writes: adding profiles to a list, subscribing, creating events (which trigger flows), deleting.
    expect(isKlaviyoReadRequest("POST", url("/api/lists/TL0001/relationships/profiles/"), { data: [{ type: "profile", id: "x" }] })).toBe(false);
    expect(isKlaviyoReadRequest("DELETE", url("/api/lists/TL0001/relationships/profiles/"), undefined)).toBe(false);
    expect(isKlaviyoReadRequest("POST", url("/api/events/"), {})).toBe(false);
    expect(isKlaviyoReadRequest("POST", url("/api/profile-subscription-bulk-create-jobs/"), {})).toBe(false);
    expect(isKlaviyoReadRequest("PATCH", url("/api/profiles/"), undefined)).toBe(false);
    expect(isKlaviyoReadRequest("PUT", url("/api/profiles/"), undefined)).toBe(false);
    // Reads that aren't listed, a bad id, a body on a GET, another host, the right report path with the wrong body.
    expect(isKlaviyoReadRequest("GET", url("/api/events/"), undefined)).toBe(false);
    expect(isKlaviyoReadRequest("GET", url("/api/lists/../profiles/relationships/profiles/"), undefined)).toBe(false);
    expect(isKlaviyoReadRequest("GET", url("/api/lists/a!b/relationships/profiles/"), undefined)).toBe(false);
    expect(isKlaviyoReadRequest("GET", url("/api/profiles/"), {})).toBe(false);
    expect(isKlaviyoReadRequest("GET", new URL("https://a.klaviyo.example/api/profiles/"), undefined)).toBe(false);
    expect(isKlaviyoReadRequest("POST", url("/api/flow-values-reports/"), body)).toBe(false);
    expect(isKlaviyoReadRequest("POST", url("/api/campaign-values-reports/?page_cursor=x"), body)).toBe(false);
    expect(isKlaviyoReadRequest("POST", url("/api/campaign-values-reports/"), { ...body, extra: 1 })).toBe(false);
  });

  it("builds report bodies from checked values only, and recognizes no other body", () => {
    const q = { start: "2025-01-01T00:00:00Z", end: "2025-12-31T23:59:59Z", conversionMetricId: "TM0002" };
    const body = klaviyoReportBody("flowValues", q);
    expect(body).toEqual({
      data: { type: "flow-values-report", attributes: { statistics: [...KLAVIYO_REPORT_STATISTICS], timeframe: { start: q.start, end: q.end }, conversion_metric_id: "TM0002", group_by: ["flow_id", "flow_message_id", "send_channel"] } },
    });
    expect(isKlaviyoReportBody("flowValues", body)).toBe(true);
    const attrs = (body.data as { attributes: Record<string, unknown> }).attributes;
    const variant = (change: Record<string, unknown>) => ({ data: { type: "flow-values-report", attributes: { ...attrs, ...change } } });
    expect(isKlaviyoReportBody("flowValues", variant({ statistics: ["recipients", "average_order_value"] }))).toBe(false);
    expect(isKlaviyoReportBody("flowValues", variant({ filter: 'equals(flow_id,"x")' }))).toBe(false);
    expect(isKlaviyoReportBody("flowValues", variant({ group_by: ["flow_id"] }))).toBe(false);
    expect(isKlaviyoReportBody("flowValues", variant({ timeframe: { start: "2020-01-01T00:00:00Z", end: "2025-01-01T00:00:00Z" } }))).toBe(false);
    expect(isKlaviyoReportBody("flowValues", { data: { ...(body.data as object), id: "x" } })).toBe(false);
    expect(isKlaviyoReportBody("flowValues", null)).toBe(false);
    expect(isKlaviyoReportBody("flowValues", { data: { type: "flow-values-report", attributes: { ...attrs, conversion_metric_id: 5 } } })).toBe(false);
    expect(() => klaviyoReportBody("flowValues", { ...q, end: q.start })).toThrow(KlaviyoConfigError);
    expect(() => klaviyoReportBody("flowValues", { ...q, start: "2024-01-01T00:00:00Z" })).toThrow(/a year at most/);
    expect(() => klaviyoReportBody("flowValues", { ...q, start: "2025-01-01" })).toThrow(/ISO/);
    expect(() => klaviyoReportBody("flowValues", { ...q, conversionMetricId: "a,b" })).toThrow(/metric id/);
    expect(() => klaviyoReportBody("nope" as "flowValues", q)).toThrow(/only reads campaign and flow/);
  });

  it("stops unlisted parameters, filters, sorts, sizes, fields, ids and cursors before any request is made", async () => {
    let calls = 0;
    const client = klaviyoClient({ apiKey: API_KEY, fetch: (async () => (calls++, json(200, { data: [] }))) as typeof fetch });
    await expect(client.read("profiles", { include: "conversations" })).rejects.toThrow(/doesn't send include/);
    await expect(client.read("profiles", { filter: "equals(email,'customer1@example.test')" })).rejects.toThrow(/only filters profiles by a time/);
    await expect(client.read("profiles", { filter: "greater-than(created,2026-01-01T00:00:00Z)" })).rejects.toThrow(KlaviyoConfigError);
    await expect(client.read("profiles", { filter: "greater-than(updated,2026-13-45T00:00:00Z)" })).rejects.toThrow(KlaviyoConfigError);
    await expect(client.read("profiles", { sort: "email" })).rejects.toThrow(/sort/);
    await expect(client.read("profiles", { "page[size]": 101 })).rejects.toThrow(/1 to 100/);
    await expect(client.read("flows", { "page[size]": 0 })).rejects.toThrow(/1 to 50/);
    await expect(client.read("profiles", { "fields[profile]": "email,first_name,last_name,location,properties" })).rejects.toThrow(/listed fields\[profile\]/);
    await expect(client.read("profiles", { "page[cursor]": "a b" })).rejects.toThrow(/cursor/);
    await expect(client.read("profiles", { "page[cursor]": "a".repeat(1025) })).rejects.toThrow(/cursor/);
    await expect(client.read("listProfiles", {})).rejects.toThrow(/needs a Klaviyo id/);
    await expect(client.read("listProfiles", {}, "../x")).rejects.toThrow(/needs a Klaviyo id/);
    await expect(client.read("profiles", {}, "TL0001")).rejects.toThrow(/needs a Klaviyo id/);
    await expect(client.read("events" as "profiles")).rejects.toThrow(/only reads its listed endpoints/);
    expect(calls).toBe(0);
  });

  it("sends the private key and the pinned revision, and follows only next links that continue the same request", async () => {
    const answers: Response[] = [];
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const client = klaviyoClient({
      apiKey: API_KEY,
      fetch: (async (url: string, init?: RequestInit) => {
        sent.push({ url, headers: init?.headers as Record<string, string> });
        return answers.shift()!;
      }) as typeof fetch,
    });
    const base = `${KLAVIYO_API_URL}/api/flows/?page%5Bsize%5D=50`;
    answers.push(json(200, { data: [{ type: "flow", id: "TF0001" }, null], links: { next: `${base}&page%5Bcursor%5D=abc123` } }));
    expect(await client.read("flows", { "page[size]": 50 })).toEqual({ data: [{ type: "flow", id: "TF0001" }], next: "abc123" });
    expect(sent[0]!.headers).toMatchObject({ authorization: `Klaviyo-API-Key ${API_KEY}`, revision: KLAVIYO_REVISION, accept: "application/vnd.api+json" });
    expect(KLAVIYO_REVISION).toBe("2026-10-15");
    answers.push(json(200, { data: [], links: { next: null } }));
    expect((await client.read("flows", { "page[size]": 50 })).next).toBeNull();
    const bad = [
      `https://evil.example.test/api/flows/?page%5Bsize%5D=50&page%5Bcursor%5D=abc`,
      `${KLAVIYO_API_URL}/api/profiles/?page%5Bsize%5D=50&page%5Bcursor%5D=abc`,
      `${base}&filter=x&page%5Bcursor%5D=abc`,
      `${KLAVIYO_API_URL}/api/flows/?page%5Bcursor%5D=abc`,
      `${base}&page%5Bcursor%5D=a%20b`,
      `${base}`,
      "not a link",
      42,
      `${base}&page%5Bcursor%5D=${"a".repeat(5000)}`,
    ];
    for (const next of bad) {
      answers.push(json(200, { data: [], links: { next } }));
      await expect(client.read("flows", { "page[size]": 50 }), String(next).slice(0, 80)).rejects.toThrow(KlaviyoApiError);
    }
    answers.push(json(200, { data: "nope" }));
    await expect(client.read("flows")).rejects.toThrow(/list of resources/);
    answers.push(new Response("[]", { status: 200 }));
    await expect(client.read("flows")).rejects.toThrow(/JSON object/);
  });

  it("waits out a 429 for Retry-After seconds up to a minute, backs off with jitter without one, then leaves it to runSync", async () => {
    const waits: number[] = [];
    let answers: Response[] = [];
    const client = klaviyoClient({ apiKey: API_KEY, rateLimitRetries: 2, random: () => 0.5, sleep: async (ms) => void waits.push(ms), fetch: (async () => answers.shift()!) as typeof fetch });
    answers = [json(429, {}, { "retry-after": "7" }), json(429, {}), json(200, { data: [] })];
    await expect(client.read("profiles")).resolves.toEqual({ data: [], next: null });
    expect(waits).toEqual([7000, 2500]);
    answers = [json(429, {}), json(429, {}), json(429, {})];
    await expect(client.read("profiles")).rejects.toMatchObject({ status: 429, code: "throttled" });
    waits.length = 0;
    // The reports' daily cap: hours to wait, so the next run picks it up instead.
    answers = [json(429, {}, { "retry-after": "3600" })];
    await expect(client.read("profiles")).rejects.toMatchObject({ status: 429 });
    expect(waits).toEqual([]);
  });

  it("reports Klaviyo's errors cut short, with a hint for a missing scope or a bad key, and never the key", async () => {
    let answer: Response = json(403, {});
    const client = klaviyoClient({ apiKey: API_KEY, fetch: (async () => answer) as typeof fetch });
    answer = json(403, { errors: [{ code: "permission_denied", detail: "x".repeat(500) }] });
    const error = (await client.read("profiles").catch((e: unknown) => e)) as KlaviyoApiError;
    expect(error).toMatchObject({ status: 403, code: "permission_denied" });
    expect(String(error.message)).toMatch(/profiles:read, lists:read/);
    expect(String(error.message).length).toBeLessThan(400);
    expect(String(error.message)).not.toContain(API_KEY);
    answer = json(401, { errors: [{ code: "not_authenticated", title: "Not authenticated" }] });
    await expect(client.read("profiles")).rejects.toThrow(/Not authenticated\); check KLAVIYO_PRIVATE_API_KEY/);
    answer = new Response("oops", { status: 500 });
    await expect(client.read("profiles")).rejects.toThrow(/HTTP 500$/);
    answer = json(200, { data: { attributes: {} } });
    await expect(client.report("campaignValues", { start: "2025-01-01T00:00:00Z", end: "2025-02-01T00:00:00Z", conversionMetricId: "TM0002" })).rejects.toThrow(/report results/);
  });
});

describe("Klaviyo customer references", () => {
  it("makes the same contact references custom forms makes, so a profile lines up with a form submitter", () => {
    expect(klaviyoContactRefs(CUSTOMER_KEY, { email: "  Customer1@Example.TEST ", phone: "+12125550101" })).toEqual(FORMS_VECTOR);
    expect(klaviyoContactRef(CUSTOMER_KEY, "email", "customer1@example.test")).toBe(FORMS_VECTOR[0]);
    expect(FORMS_VECTOR[0]!.startsWith(CONTACT_REF_PREFIX)).toBe(true);
  });

  it("keys every reference with CUSTOMER_REF_KEY, so they link up but can't be recomputed without it", () => {
    const id = "01JTESTPROFILE000000000001";
    expect(klaviyoProfileRef(CUSTOMER_KEY, id)).toBe(klaviyoProfileRef(CUSTOMER_KEY, id));
    expect(klaviyoProfileRef(CUSTOMER_KEY, id)).not.toBe(klaviyoProfileRef(OTHER_KEY, id));
    expect(klaviyoProfileRef(CUSTOMER_KEY, id)).toMatch(/^klaviyo:profile:[0-9a-f]{32}$/);
    expect(klaviyoProfileRef(CUSTOMER_KEY, id)).not.toContain(id);
    const plain = createHmac("sha256", "").update(`klaviyo:profile:v1:${id}`).digest("hex").slice(0, 32);
    expect(klaviyoProfileRef(CUSTOMER_KEY, id)).not.toContain(plain);
    expect(klaviyoContactRefs(OTHER_KEY, { email: "customer1@example.test" })).not.toEqual([FORMS_VECTOR[0]]);
    expect(() => klaviyoProfileRef("short", id)).toThrow(KlaviyoCustomerKeyError);
    expect(() => klaviyoConnector({ apiKey: API_KEY, customerKey: "" })).toThrow(/CUSTOMER_REF_KEY/);
    expect(klaviyoProfileRef(CUSTOMER_KEY, "has space")).toBeUndefined();
    expect(klaviyoProfileRef(CUSTOMER_KEY, 5)).toBeUndefined();
    expect(klaviyoProfileRef(CUSTOMER_KEY, "a".repeat(65))).toBeUndefined();
  });

  it("normalizes contact details the way custom forms does, and refuses what isn't one", () => {
    expect(klaviyoNormalizeEmail(" A@B.TEST ")).toBe("a@b.test");
    expect(klaviyoNormalizeEmail("no-at-sign")).toBeUndefined();
    expect(klaviyoNormalizeEmail(`${"a".repeat(65)}@b.test`)).toBeUndefined();
    expect(klaviyoNormalizeEmail(`a@${"b".repeat(400)}.test`)).toBeUndefined();
    expect(klaviyoNormalizeEmail(7)).toBeUndefined();
    expect(klaviyoNormalizePhone("+1 (212) 555-0101")).toBe("12125550101");
    expect(klaviyoNormalizePhone("12345")).toBeUndefined();
    expect(klaviyoNormalizePhone("1".repeat(16))).toBeUndefined();
    expect(klaviyoNormalizePhone("1".repeat(70))).toBeUndefined();
    expect(klaviyoNormalizePhone(null)).toBeUndefined();
    expect(klaviyoContactRefs(CUSTOMER_KEY, {})).toEqual([]);
  });
});

describe("Klaviyo normalization", () => {
  const profile = () => {
    klaviyoProfile.reset();
    const { id, subscriptions, ...attributes } = klaviyoProfile.one({ email: "  Customer1@Example.TEST ", phone_number: "+12125550101" });
    return { type: "profile", id, attributes: { ...attributes, subscriptions } };
  };

  it("keeps nothing personal from a profile: no email, phone, name, location, organization or custom properties", () => {
    const p = profile();
    const e = klaviyoProfileEvent(p, ctx())!;
    const text = JSON.stringify(e);
    for (const leak of ["customer1@example", "Customer1@Example", "2125550101", "Test", "Customer 1", "Testville", "Test Street", "ring_size", "Synthetic custom property", "Test Organization", p.id]) {
      expect(text, leak).not.toContain(leak);
    }
    expect(Object.keys(e.payload).sort()).toEqual(["contactRefs", "createdAt", "customerId", "emailConsent", "marketingConsent", "name", "profileRef", "smsConsent", "updatedAt"]);
  });

  it("names a profile by its email's contact reference, the same customer custom forms names, with consent as Klaviyo states it", () => {
    const e = klaviyoProfileEvent(profile(), ctx())!;
    expect(e).toMatchObject({
      type: "customer.profile_updated",
      occurredAt: "2026-01-02T07:00:00.000Z",
      idempotencyKey: expect.stringMatching(/^klaviyo:profile:[0-9a-f]{32}:2026-01-02T07:00:00.000Z$/),
      payload: { customerId: FORMS_VECTOR[0], contactRefs: FORMS_VECTOR, marketingConsent: true, emailConsent: "subscribed", smsConsent: "never_subscribed", createdAt: "2026-01-01T01:00:00.000Z" },
    });
    expect(e.payload.name).toMatch(/^Klaviyo profile [0-9a-f]{8}$/);
    const bare = klaviyoProfileEvent({ type: "profile", id: "01JTESTPROFILE000000000009", attributes: { updated: "2026-01-02T00:00:00+00:00", subscriptions: { email: { marketing: { consent: "UNSUBSCRIBED" } } } } }, ctx())!;
    expect(bare.payload).toMatchObject({ customerId: bare.payload.profileRef, contactRefs: [], marketingConsent: false, emailConsent: "unsubscribed", smsConsent: "unknown" });
    expect(klaviyoProfileEvent({ type: "profile", id: "bad id" }, ctx())).toBeNull();
    expect(klaviyoProfileEvent({ type: "profile", id: "01JTEST", attributes: {} }, ctx())!.occurredAt).toBeUndefined();
  });

  it("keeps list and segment memberships as a group and a profile reference only", () => {
    const e = klaviyoMembershipEvent("segment", "TS0001", { type: "profile", id: "01JTESTPROFILE000000000001" }, ctx())!;
    expect(e).toMatchObject({ type: KLAVIYO_EVENTS.membership, occurredAt: RECEIVED, payload: { groupId: "klaviyo:segment:TS0001", groupKind: "segment", profileRef: klaviyoProfileRef(CUSTOMER_KEY, "01JTESTPROFILE000000000001") } });
    expect(e.idempotencyKey).toMatch(/^klaviyo:segment_member:TS0001:[0-9a-f]{32}$/);
    expect(klaviyoMembershipEvent("list", "TL0001", { type: "list", id: "x" }, ctx())).toBeNull();
    expect(klaviyoMembershipEvent("list", "bad id", { type: "profile", id: "x" }, ctx())).toBeNull();
  });

  it("keeps a list's, segment's, campaign's and flow's name, state and times, and never a segment's conditions", () => {
    expect(klaviyoGroupEvent("list", { id: "TL0001", attributes: { name: " VIP ", opt_in_process: "double_opt_in", created: "2025-01-01T00:00:00+00:00", updated: "2025-02-01T00:00:00+00:00" } }, ctx())!.payload).toEqual({
      listId: "klaviyo:list:TL0001",
      name: "VIP",
      optIn: "double",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-02-01T00:00:00.000Z",
    });
    expect(klaviyoGroupEvent("list", { id: "TL0002", attributes: { opt_in_process: "single_opt_in" } }, ctx())!.payload).toEqual({ listId: "klaviyo:list:TL0002", name: "Klaviyo list TL0002", optIn: "single" });
    klaviyoSegment.reset();
    const { id, members: _, ...attributes } = klaviyoSegment.one({ is_active: false });
    const segment = klaviyoGroupEvent("segment", { id, attributes }, ctx())!;
    expect(segment.payload).toMatchObject({ segmentId: "klaviyo:segment:TS0001", name: "Test segment 1", active: false });
    expect(JSON.stringify(segment)).not.toContain("example.test");
    expect(klaviyoGroupEvent("segment", { id: "!" }, ctx())).toBeNull();
    const campaign = klaviyoCampaignEvent({ id: "TC0001", attributes: { definition: { name: "Spring", archived: true, description: "secret plan" }, created_at: "2025-01-01T00:00:00+00:00", updated_at: "2025-01-02T00:00:00+00:00" } }, ctx())!;
    expect(campaign.payload).toEqual({ campaignId: "klaviyo:campaign:TC0001", name: "Spring", archived: true, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-02T00:00:00.000Z" });
    expect(klaviyoCampaignEvent({ id: "TC0002", attributes: {} }, ctx())!.payload).toEqual({ campaignId: "klaviyo:campaign:TC0002", name: "Klaviyo campaign TC0002", archived: false });
    expect(klaviyoCampaignEvent({ id: 5 }, ctx())).toBeNull();
    expect(klaviyoFlowEvent({ id: "TF0001", attributes: { name: "Welcome", status: "live", archived: false, trigger_type: "Added to List", updated: "2025-01-02T00:00:00+00:00" } }, ctx())!.payload).toEqual({
      flowId: "klaviyo:flow:TF0001",
      name: "Welcome",
      status: "live",
      archived: false,
      triggerType: "Added to List",
      updatedAt: "2025-01-02T00:00:00.000Z",
    });
    expect(klaviyoFlowEvent({ id: "TF0002" }, ctx())!.payload.name).toBe("Klaviyo flow TF0002");
    expect(klaviyoFlowEvent({}, ctx())).toBeNull();
  });

  it("keeps report figures in aggregate per message, channel and year, stored again only when a figure changes", () => {
    const window = { year: 2025, start: "2025-01-01T00:00:00Z", end: "2025-12-31T23:59:59Z" };
    const row = { groupings: { campaign_id: "TC0001", campaign_message_id: "TCM001", campaign_message_name: "Summer", send_channel: "email" }, statistics: { recipients: 100, opens_unique: 40, conversion_value: 12.345, clicks: -1, opens: "7" } };
    const [metrics, sent] = klaviyoReportEvents("campaign", row, window, ctx());
    expect(metrics).toMatchObject({ type: KLAVIYO_EVENTS.campaignMetrics, occurredAt: window.end, payload: { campaignId: "klaviyo:campaign:TC0001", messageId: "klaviyo:campaign_message:TCM001", channel: "email", year: 2025, from: window.start, through: window.end, recipients: 100, uniqueOpens: 40, revenueCents: 1235 } });
    expect(metrics!.payload).not.toHaveProperty("clicks");
    expect(metrics!.payload).not.toHaveProperty("opens");
    expect(sent).toMatchObject({ type: "campaign.sent", idempotencyKey: "klaviyo:campaign_sent:TC0001:TCM001:email", payload: { campaignId: "klaviyo:campaign:TC0001", name: "Summer", channel: "email", costCents: 0 } });
    expect(klaviyoReportEvents("campaign", row, window, ctx())[0]!.idempotencyKey).toBe(metrics!.idempotencyKey);
    const changed = klaviyoReportEvents("campaign", { ...row, statistics: { ...row.statistics, recipients: 101 } }, window, ctx());
    expect(changed[0]!.idempotencyKey).not.toBe(metrics!.idempotencyKey);
    expect(changed[1]!.idempotencyKey).toBe(sent!.idempotencyKey);
    expect(klaviyoReportEvents("campaign", { ...row, statistics: {} }, window, ctx())).toHaveLength(1);
    const push = klaviyoReportEvents("campaign", { ...row, groupings: { ...row.groupings, send_channel: "push-notification", campaign_message_name: "" } }, window, ctx());
    expect(push[0]!.payload.channel).toBe("push");
    expect(push[1]!.payload).toMatchObject({ channel: "other", name: "Klaviyo campaign TC0001" });
    const flow = klaviyoReportEvents("flow", { groupings: { flow_id: "TF0001", flow_message_id: "TFM001", send_channel: "sms" }, statistics: { recipients: 5 } }, window, ctx());
    expect(flow).toHaveLength(1);
    expect(flow[0]).toMatchObject({ type: KLAVIYO_EVENTS.flowMetrics, payload: { flowId: "klaviyo:flow:TF0001", messageId: "klaviyo:flow_message:TFM001", channel: "sms", recipients: 5 } });
    expect(klaviyoReportEvents("flow", { groupings: { flow_id: "TF0001" }, statistics: {} }, window, ctx())).toEqual([]);
  });

  it("reads Klaviyo's times, consent and channels into fixed values", () => {
    expect(klaviyoTime("2026-01-01T00:00:00+00:00")).toBe("2026-01-01T00:00:00.000Z");
    expect(klaviyoTime("nope")).toBeUndefined();
    expect(klaviyoTime(5)).toBeUndefined();
    expect(klaviyoTime("2".repeat(41))).toBeUndefined();
    expect(["SUBSCRIBED", "unsubscribed", "NEVER_SUBSCRIBED", "MAYBE", 3].map(klaviyoConsent)).toEqual(["subscribed", "unsubscribed", "never_subscribed", "unknown", "unknown"]);
    expect(["email", "sms", "push-notification", "whatsapp", "fax", null].map(klaviyoChannel)).toEqual(["email", "sms", "push", "whatsapp", "other", "other"]);
  });

  it("uses synthetic fixtures only", () => {
    expect(() => assertSynthetic(account())).not.toThrow();
  });

  it("runs its patterns in linear time on hostile input", async () => {
    const hostile = "a".repeat(200_000);
    const started = performance.now();
    klaviyoNormalizeEmail(`${"a@".repeat(100_000)}`);
    klaviyoNormalizeEmail(`${"a".repeat(64)}@${"a.".repeat(150)}`);
    klaviyoNormalizePhone(`${"1-".repeat(100_000)}`);
    klaviyoProfileRef(CUSTOMER_KEY, hostile);
    klaviyoTime(`${"9".repeat(100_000)}T`);
    klaviyoConsent(hostile);
    klaviyoChannel(hostile);
    klaviyoReportEvents("campaign", { groupings: { campaign_id: hostile, campaign_message_id: hostile }, statistics: {} }, { year: 2025, start: "", end: "" }, ctx());
    verifyKlaviyoWebhook(WEBHOOK_SECRET, "{}", { signature: `${"a".repeat(99)}`, timestamp: `${"1".repeat(63)}`, webhookId: "w" });
    verifyKlaviyoWebhook(WEBHOOK_SECRET, "{}", { signature: "a".repeat(64), timestamp: `${"Thu, ".repeat(12)}`, webhookId: `${"a".repeat(64)}` });
    klaviyoWebhookEvents({ data: [{ external_id: hostile, topic: hostile }] }, ctx());
    klaviyoWebhookEventIds({ data: [{ external_id: `${"a".repeat(100_000)}!` }] });
    expect(() => parseKlaviyoCursor(JSON.stringify({ pass: "historical", step: "profiles", page: `${"a".repeat(100_000)} ` }))).toThrow();
    expect(() => parseKlaviyoCursor(JSON.stringify({ pass: "historical", step: "profiles", page: `${"a".repeat(1023)} `, group: null, window: 0, metric: null, since: RECEIVED, through: RECEIVED, nextFrom: RECEIVED }))).toThrow();
    const client = klaviyoClient({ apiKey: API_KEY, fetch: (async () => json(200, { data: [] })) as typeof fetch });
    await expect(client.read("profiles", { filter: `greater-than(updated,${"2".repeat(100_000)})` })).rejects.toThrow();
    await expect(client.read("profiles", { "page[cursor]": `${"a".repeat(100_000)}!` })).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("Klaviyo sync", () => {
  it("imports, replays, resumes and retries the mocked account", async () => {
    // 3 profiles (+1 dead-lettered for its missing update time); 2 lists and 3 members; 1 segment and 1 member;
    // 2 campaigns; 1 flow; campaign figures (2025: metrics and campaign.sent; 2026: metrics); flow figures (2024).
    const result = await checkConnectorSync({ makeConnector: () => connector(klaviyoDocMock(account())), expected: { ingested: 17, deadLettered: 1 } });
    expect(result.full.batches).toBe(23);
    expect(parseKlaviyoCursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done", metric: "TM0002", page: null, group: null });
  });

  it("reads every stream, asks only for what it keeps, and reads five calendar years of figures one year per report", async () => {
    const mock = klaviyoDocMock(account());
    const { fetch, sent } = recording(mock);
    await drain(connector(mock, { fetch }), "historical");
    const paths = sent.map((s) => `${s.method} ${new URL(s.url).pathname}`);
    expect([...new Set(paths)]).toEqual([
      "GET /api/profiles/",
      "GET /api/lists/",
      "GET /api/lists/TL0001/relationships/profiles/",
      "GET /api/lists/TL0002/relationships/profiles/",
      "GET /api/segments/",
      "GET /api/segments/TS0001/relationships/profiles/",
      "GET /api/campaigns/",
      "GET /api/flows/",
      "GET /api/metrics/",
      "POST /api/campaign-values-reports/",
      "POST /api/flow-values-reports/",
    ]);
    const profiles = new URL(sent[0]!.url).searchParams;
    expect(profiles.get("fields[profile]")).toBe("email,phone_number,created,updated,subscriptions");
    expect(profiles.get("filter")).toBeNull();
    expect(new URL(sent[2]!.url).searchParams.get("filter")).toBeNull();
    for (const s of sent) expect(s.headers.revision).toBe(KLAVIYO_REVISION);
    expect(mock.reports.filter((r) => r.kind === "campaign").map((r) => (r.body.data as { attributes: { timeframe: unknown } }).attributes.timeframe)).toEqual([
      { start: "2021-01-20T00:00:00Z", end: "2021-12-31T23:59:59Z" },
      { start: "2022-01-01T00:00:00Z", end: "2022-12-31T23:59:59Z" },
      { start: "2023-01-01T00:00:00Z", end: "2023-12-31T23:59:59Z" },
      { start: "2024-01-01T00:00:00Z", end: "2024-12-31T23:59:59Z" },
      { start: "2025-01-01T00:00:00Z", end: "2025-12-31T23:59:59Z" },
      { start: "2026-01-01T00:00:00Z", end: "2026-01-20T00:00:00Z" },
    ]);
    expect(mock.reports.filter((r) => r.kind === "flow")).toHaveLength(6);
  });

  it("pages every listing through to its last page, members included", async () => {
    klaviyoProfile.reset();
    const profiles = klaviyoProfile.many(250);
    const members = profiles.slice(0, 150).map((p) => ({ profileId: p.id, joinedAt: "2025-01-01T00:00:00+00:00" }));
    const lists = Array.from({ length: 12 }, (_, i) => ({ ...klaviyoList.one(), id: `TL${String(i + 1).padStart(4, "0")}`, members: i === 11 ? members : [] }));
    const metrics = [...Array.from({ length: 4 }, () => klaviyoMetric.one()), klaviyoMetric.one({ name: "Placed Order" })];
    const mock = klaviyoDocMock(account({ profiles, lists, segments: [], campaigns: [], flows: [], metrics, campaignValues: [], flowValues: [], metricsPageSize: 2 }));
    const { fetch, sent } = recording(mock);
    const batches = await drain(connector(mock, { fetch }), "historical");
    const events = batches.flatMap((b) => b.events) as { type: string }[];
    expect(events.filter((e) => e.type === "customer.profile_updated")).toHaveLength(250);
    expect(events.filter((e) => e.type === KLAVIYO_EVENTS.list)).toHaveLength(12);
    expect(events.filter((e) => e.type === KLAVIYO_EVENTS.membership)).toHaveLength(150);
    expect(sent.filter((s) => new URL(s.url).pathname === "/api/profiles/")).toHaveLength(3);
    expect(sent.filter((s) => new URL(s.url).pathname === "/api/lists/")).toHaveLength(2);
    expect(sent.filter((s) => new URL(s.url).pathname === "/api/lists/TL0012/relationships/profiles/")).toHaveLength(2);
    expect(sent.filter((s) => new URL(s.url).pathname === "/api/metrics/")).toHaveLength(3);
    expect(parseKlaviyoCursor(batches.at(-1)!.cursor)!.metric).toBe(metrics[4]!.id);
  });

  it("uses a named conversion metric without looking one up, and reads no reports when none can be found", async () => {
    const named = klaviyoDocMock(account());
    const a = recording(named);
    await drain(connector(named, { fetch: a.fetch, conversionMetricId: "TM0001" }), "historical");
    expect(a.sent.some((s) => s.url.includes("/api/metrics/"))).toBe(false);
    expect((named.reports[0]!.body.data as { attributes: { conversion_metric_id: string } }).attributes.conversion_metric_id).toBe("TM0001");
    const none = klaviyoDocMock(account({ metrics: [klaviyoMetric.one({ name: "Opened Email" })] }));
    const batches = await drain(connector(none), "historical");
    expect(none.reports).toEqual([]);
    expect(parseKlaviyoCursor(batches.at(-1)!.cursor)).toMatchObject({ step: "done", metric: null });
    expect(() => connector(none, { conversionMetricId: "not an id" })).toThrow(/KLAVIYO_CONVERSION_METRIC_ID/);
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(klaviyoDocMock(account())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 17, deadLettered: 1 });
    const types = memory.events.map((e) => e.type);
    expect(types.filter((t) => t === "customer.profile_updated")).toHaveLength(3);
    expect(types.filter((t) => t === "campaign.sent")).toHaveLength(1);
    expect(JSON.stringify(memory.events)).not.toMatch(/example\.test|2125550|Testville|Customer \d/);
  });

  it("leaves a finished import finished", async () => {
    const done: KlaviyoCursor = { pass: "historical", step: "done", page: null, group: null, window: 0, metric: "TM0002", since: "2021-01-20T00:00:00.000Z", through: RECEIVED, nextFrom: RECEIVED };
    const mock = klaviyoDocMock(account());
    expect(await drain(connector(mock), "historical", JSON.stringify(done))).toEqual([]);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("reads changes since the last pass started, members who joined since, and the figures for the last 30 days' years", async () => {
    const mock = klaviyoDocMock(account());
    const { fetch, sent } = recording(mock);
    const previous: KlaviyoCursor = { pass: "historical", step: "done", page: null, group: null, window: 0, metric: "TM0002", since: "2021-01-20T00:00:00.000Z", through: "2026-01-19T00:00:00.000Z", nextFrom: "2026-01-19T00:00:00.000Z" };
    const batches = await drain(connector(mock, { fetch }), "incremental", JSON.stringify(previous));
    const filters = sent.map((s) => [new URL(s.url).pathname, new URL(s.url).searchParams.get("filter")]);
    expect(filters).toContainEqual(["/api/profiles/", "greater-than(updated,2026-01-19T00:00:00.000Z)"]);
    expect(filters).toContainEqual(["/api/lists/TL0001/relationships/profiles/", "greater-than(joined_group_at,2026-01-19T00:00:00.000Z)"]);
    expect(filters).toContainEqual(["/api/campaigns/", "greater-than(updated_at,2026-01-19T00:00:00.000Z)"]);
    expect(filters).toContainEqual(["/api/flows/", "greater-than(updated,2026-01-19T00:00:00.000Z)"]);
    expect(filters).toContainEqual(["/api/lists/", null]);
    expect(sent.some((s) => s.url.includes("/api/metrics/"))).toBe(false);
    const events = batches.flatMap((b) => b.events) as { type: string }[];
    // Only the member who joined after the last pass.
    expect(events.filter((e) => e.type === KLAVIYO_EVENTS.membership)).toHaveLength(1);
    expect(mock.reports.map((r) => (r.body.data as { attributes: { timeframe: unknown } }).attributes.timeframe)).toEqual([
      { start: "2025-12-21T00:00:00Z", end: "2025-12-31T23:59:59Z" },
      { start: "2026-01-01T00:00:00Z", end: "2026-01-20T00:00:00Z" },
      { start: "2025-12-21T00:00:00Z", end: "2025-12-31T23:59:59Z" },
      { start: "2026-01-01T00:00:00Z", end: "2026-01-20T00:00:00Z" },
    ]);
    expect(parseKlaviyoCursor(batches.at(-1)!.cursor)).toMatchObject({ pass: "incremental", step: "done", since: "2026-01-19T00:00:00.000Z", nextFrom: "2026-01-19T23:55:00.000Z" });
  });

  it("looks back 48 hours on a first incremental sync, and resumes an interrupted pass where it stopped", async () => {
    const mock = klaviyoDocMock(account());
    const { fetch, sent } = recording(mock);
    const first = connector(mock, { fetch }).incrementalSync({ organizationId: TEST_ORG, cursor: null })[Symbol.asyncIterator]();
    const batch = (await first.next()).value as { cursor: string };
    expect(new URL(sent[0]!.url).searchParams.get("filter")).toBe("greater-than(updated,2026-01-18T00:00:00.000Z)");
    expect(parseKlaviyoCursor(batch.cursor)).toMatchObject({ pass: "incremental", step: "lists" });
    sent.length = 0;
    await drain(connector(mock, { fetch }), "incremental", batch.cursor);
    expect(new URL(sent[0]!.url).pathname).toBe("/api/lists/");
  });

  it("stops when Klaviyo keeps rate-limiting, keeps the checkpoint where it was, and carries on from there", async () => {
    const data = account({ rateLimits: [{}, {}, {}, {}] });
    const mock = klaviyoDocMock(data);
    const { memory, pipeline } = testPipeline();
    const run = () => runSync({ connector: connector(mock, { rateLimitRetries: 1 }), mode: "historical", pipeline, memory, organizationId: TEST_ORG, attempts: 2, sleep: noSleep });
    await expect(run()).rejects.toMatchObject({ status: 429 });
    expect(await memory.getCheckpoint(TEST_ORG, "klaviyo", "historical")).toBeNull();
    const report = await run();
    expect(report).toMatchObject({ ingested: 17, deadLettered: 1 });
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: KlaviyoCursor = { pass: "historical", step: "lists", page: null, group: { ids: ["TL0001"], index: 0, member: null, after: null }, window: 0, metric: null, since: RECEIVED, through: RECEIVED, nextFrom: RECEIVED };
    expect(parseKlaviyoCursor(JSON.stringify(good))).toEqual(good);
    expect(parseKlaviyoCursor(null)).toBeNull();
    const bad: Partial<Record<keyof KlaviyoCursor, unknown>>[] = [
      { pass: "nightly" },
      { step: "events" },
      { page: "a b" },
      { group: { ids: ["../x"], index: 0, member: null, after: null } },
      { group: { ids: ["TL0001"], index: 2, member: null, after: null } },
      { group: { ids: ["TL0001"], index: 0, member: "a b", after: null } },
      { group: { ids: "TL0001", index: 0, member: null, after: null } },
      { step: "profiles" },
      { window: -1 },
      { window: 1.5 },
      { metric: "a,b" },
      { since: "yesterday" },
      { nextFrom: "2026-02-30T00:00:00Z" },
    ];
    for (const change of bad) expect(() => parseKlaviyoCursor(JSON.stringify({ ...good, ...change })), JSON.stringify(change)).toThrow(/expected shape/);
    expect(() => parseKlaviyoCursor("null")).toThrow();
    expect(() => parseKlaviyoCursor("x".repeat(20_001))).toThrow(/expected shape/);
  });

  it("splits a span into calendar years, none longer than Klaviyo allows", () => {
    expect(klaviyoReportWindows("2025-06-01T00:00:00.000Z", "2026-01-20T00:00:00.000Z")).toEqual([
      { year: 2025, start: "2025-06-01T00:00:00Z", end: "2025-12-31T23:59:59Z" },
      { year: 2026, start: "2026-01-01T00:00:00Z", end: "2026-01-20T00:00:00Z" },
    ]);
    expect(klaviyoReportWindows("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toEqual([]);
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const c = connector(klaviyoDocMock(account()));
    expect(c.writes!.map((w) => w.name)).toEqual(["add_profiles_to_list", "trigger_flow"]);
    expect(KLAVIYO_WRITES).toBe(c.writes);
    const audit = await assertWritesRefused(c);
    expect(audit.map((e) => [e.integration, e.action, e.outcome])).toEqual([
      ["klaviyo", "add_profiles_to_list", "refused"],
      ["klaviyo", "trigger_flow", "refused"],
    ]);
  });
});

describe("Klaviyo webhooks", () => {
  const T = "Tue, 20 Jan 2026 00:00:00 GMT";
  const NOW_MS = Date.parse("2026-01-20T00:01:00Z");
  const delivery = (items: unknown[], webhookId = "WH0001") => JSON.stringify({ data: items, meta: { klaviyo_webhook_id: webhookId, timestamp: "2026-01-20T00:00:00+00:00", klaviyo_account_id: "TESTACCT", version: "2023-06-03" } });
  const item = (externalId: string, topic: string, profileId = "01JTESTPROFILE000000000001") => ({
    external_id: externalId,
    topic,
    payload: { data: { type: "event", id: externalId, attributes: { datetime: "2026-01-19T23:59:00+00:00", event_properties: { email: "customer1@example.test" } }, relationships: { profile: { data: { type: "profile", id: profileId } }, metric: { data: { type: "metric", id: "TM0009" } } } } },
  });
  const sign = (body: string, timestamp = T, secret = WEBHOOK_SECRET) => createHmac("sha256", secret).update(body).update(timestamp).digest("hex");
  const headers = (body: string, extra: Partial<{ signature: string; timestamp: string; webhookId: string }> = {}) => ({ signature: sign(body, extra.timestamp ?? T), timestamp: T, webhookId: "WH0001", ...extra });

  it("accepts a delivery signed over the raw body and timestamp, and rejects everything else", () => {
    const body = delivery([item("EV0001", "event:klaviyo.subscribed_to_email_marketing")]);
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, headers(body), NOW_MS)).toEqual({ ok: true });
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, Buffer.from(body), headers(body), NOW_MS)).toEqual({ ok: true });
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, { ...headers(body), signature: headers(body).signature.toUpperCase() }, NOW_MS)).toEqual({ ok: true });
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, tamper(body), headers(body), NOW_MS)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyKlaviyoWebhook("another-secret", body, headers(body), NOW_MS)).toEqual({ ok: false, reason: "mismatch" });
    // The signature covers the timestamp: changing it fails even within the window.
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, { ...headers(body), timestamp: "Tue, 20 Jan 2026 00:00:30 GMT" }, NOW_MS)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, { ...headers(body), signature: createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex") }, NOW_MS)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyKlaviyoWebhook("", body, headers(body), NOW_MS)).toEqual({ ok: false, reason: "missing" });
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, { ...headers(body), signature: undefined }, NOW_MS)).toEqual({ ok: false, reason: "missing" });
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, { ...headers(body), timestamp: undefined }, NOW_MS)).toEqual({ ok: false, reason: "missing" });
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, { ...headers(body), webhookId: undefined }, NOW_MS)).toEqual({ ok: false, reason: "missing" });
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, { ...headers(body), signature: "zz" }, NOW_MS)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, { ...headers(body), signature: "a".repeat(101) }, NOW_MS)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, { ...headers(body), webhookId: "a b" }, NOW_MS)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, headers(body, { timestamp: "not a time" }), NOW_MS)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a delivery whose timestamp is more than five minutes off, so a captured one can't be replayed later", () => {
    const body = delivery([item("EV0001", "event:klaviyo.subscribed_to_email_marketing")]);
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, headers(body), Date.parse("2026-01-20T00:05:00Z"))).toEqual({ ok: true });
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, headers(body), Date.parse("2026-01-20T00:05:01Z"))).toEqual({ ok: false, reason: "stale" });
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, headers(body), Date.parse("2026-01-19T23:54:59Z"))).toEqual({ ok: false, reason: "stale" });
    const iso = "2026-01-20T00:00:00Z";
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, headers(body, { timestamp: iso }), NOW_MS)).toEqual({ ok: true });
    expect(klaviyoWebhookTime("1768867200")).toBe(Date.parse("2026-01-20T00:00:00Z"));
    expect(klaviyoWebhookTime(T)).toBe(Date.parse("2026-01-20T00:00:00Z"));
  });

  it("refuses a body that names another webhook than the header, as Klaviyo advises", () => {
    const body = delivery([item("EV0001", "event:klaviyo.subscribed_to_email_marketing")], "WH0002");
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, body, headers(body), NOW_MS)).toEqual({ ok: false, reason: "wrong_webhook" });
    const notJson = "not json";
    expect(verifyKlaviyoWebhook(WEBHOOK_SECRET, notJson, headers(notJson), NOW_MS)).toEqual({ ok: false, reason: "malformed" });
  });

  it("turns consent changes into events under the sync's profile reference, and drops per-person activity", () => {
    const body = JSON.parse(
      delivery([
        item("EV0001", "event:klaviyo.subscribed_to_email_marketing"),
        item("EV0002", "event:klaviyo.unsubscribed_from_sms_marketing"),
        item("EV0003", "event:klaviyo.opened_email"),
        item("EV0004", "event:klaviyo.manually_suppressed_from_email_marketing", "bad id"),
        { ...item("EV0005", "event:klaviyo.subscribed_to_sms_marketing"), payload: { data: { relationships: { profile: { data: { id: "01JTESTPROFILE000000000002" } } } } } },
        { topic: "event:klaviyo.subscribed_to_sms_marketing" },
      ]),
    );
    const events = klaviyoWebhookEvents(body, ctx());
    expect(events.map((e) => [e.idempotencyKey, e.payload.channel, e.payload.consent])).toEqual([
      ["klaviyo:consent:EV0001", "email", "subscribed"],
      ["klaviyo:consent:EV0002", "sms", "unsubscribed"],
    ]);
    expect(events[0]).toMatchObject({ type: KLAVIYO_EVENTS.consent, occurredAt: "2026-01-19T23:59:00.000Z", payload: { profileRef: klaviyoProfileRef(CUSTOMER_KEY, "01JTESTPROFILE000000000001") } });
    expect(JSON.stringify(events)).not.toContain("example.test");
    expect(Object.keys(KLAVIYO_CONSENT_TOPICS)).toHaveLength(6);
    expect(klaviyoWebhookEvents(null, ctx())).toEqual([]);
    expect(klaviyoWebhookEventIds(body)).toEqual(["EV0001", "EV0002", "EV0003", "EV0004", "EV0005"]);
    expect(klaviyoWebhookEventIds({})).toEqual([]);
    const c = connector(klaviyoDocMock(account()));
    expect(c.handleWebhook(body)).toHaveLength(2);
  });

  it("handles each event once within Klaviyo's retry window, and forgets the oldest when full", () => {
    let clock = 0;
    const guard = new KlaviyoReplayGuard({ clock: () => clock, maxEntries: 2 });
    const body = JSON.parse(delivery([item("EV0001", "event:klaviyo.subscribed_to_email_marketing")]));
    expect(klaviyoWebhookEvents(body, ctx(), (id) => guard.firstDelivery(id))).toHaveLength(1);
    expect(klaviyoWebhookEvents(body, ctx(), (id) => guard.firstDelivery(id))).toHaveLength(0);
    clock = 49 * 3_600_000;
    expect(guard.firstDelivery("EV0001")).toBe(false);
    clock = 51 * 3_600_000;
    expect(guard.firstDelivery("EV0001")).toBe(true);
    expect(guard.firstDelivery("EV0002")).toBe(true);
    expect(guard.firstDelivery("EV0003")).toBe(true);
    expect(guard.firstDelivery("EV0001")).toBe(true);
    expect(new KlaviyoReplayGuard().firstDelivery("x")).toBe(true);
  });

  it("stores a replayed delivery as a duplicate", async () => {
    const { pipeline } = testPipeline();
    const body = JSON.parse(delivery([item("EV0001", "event:klaviyo.subscribed_to_email_marketing")]));
    const c = connector(klaviyoDocMock(account()));
    const ingest = (e: object) => pipeline.ingest({ ...e, organizationId: TEST_ORG, source: "klaviyo" });
    expect((await ingest(c.handleWebhook(body)[0]!)).duplicate).toBe(false);
    expect((await ingest(c.handleWebhook(body)[0]!)).duplicate).toBe(true);
  });
});

describe("Klaviyo doc mock", () => {
  it("answers like Klaviyo to requests the connector should never send", async () => {
    const mock = klaviyoDocMock(account());
    const auth = { authorization: `Klaviyo-API-Key ${API_KEY}`, revision: KLAVIYO_REVISION };
    await expect(mock.fetch(`${KLAVIYO_API_URL}/api/lists/TL0001/relationships/profiles/`, { method: "POST", headers: auth, body: "{}" })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${KLAVIYO_API_URL}/api/events/`, { method: "POST", headers: auth, body: "{}" })).rejects.toThrow(UndocumentedRequestError);
    expect((await mock.fetch(`${KLAVIYO_API_URL}/api/profiles/`)).status).toBe(401);
    expect((await mock.fetch(`${KLAVIYO_API_URL}/api/profiles/`, { headers: { authorization: auth.authorization } })).status).toBe(400);
    expect((await mock.fetch(`${KLAVIYO_API_URL}/api/profiles/`, { headers: { ...auth, revision: "2027-01-15" } })).status).toBe(400);
    expect((await mock.fetch(`${KLAVIYO_API_URL}/api/profiles/?include=conversations`, { headers: auth })).status).toBe(400);
    expect((await mock.fetch(`${KLAVIYO_API_URL}/api/lists/?page%5Bsize%5D=11`, { headers: auth })).status).toBe(400);
    expect((await mock.fetch(`${KLAVIYO_API_URL}/api/profiles/?filter=equals(email,x)`, { headers: auth })).status).toBe(400);
    expect((await mock.fetch(`${KLAVIYO_API_URL}/api/profiles/?sort=email`, { headers: auth })).status).toBe(400);
    expect((await mock.fetch(`${KLAVIYO_API_URL}/api/profiles/?page%5Bcursor%5D=bogus`, { headers: auth })).status).toBe(400);
    expect((await mock.fetch(`${KLAVIYO_API_URL}/api/lists/NOPE/relationships/profiles/`, { headers: auth })).status).toBe(404);
    // Names, location and properties come back when asked for, which is why the connector never asks.
    const full = (await (await mock.fetch(`${KLAVIYO_API_URL}/api/profiles/`, { headers: auth })).json()) as { data: { attributes: Record<string, unknown> }[] };
    expect(full.data[0]!.attributes).toHaveProperty("first_name");
    expect(full.data[0]!.attributes).not.toHaveProperty("subscriptions");
    const report = (body: unknown) => mock.fetch(`${KLAVIYO_API_URL}/api/campaign-values-reports/`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    const good = klaviyoReportBody("campaignValues", { start: "2025-01-01T00:00:00Z", end: "2025-12-31T23:59:59Z", conversionMetricId: "TM0002" }) as { data: { attributes: Record<string, unknown> } };
    expect((await report(good)).status).toBe(200);
    const bad = (attributes: Record<string, unknown>) => ({ data: { type: "campaign-values-report", attributes: { ...good.data.attributes, ...attributes } } });
    for (const b of [bad({ statistics: ["nope"] }), bad({ timeframe: { start: "2020-01-01T00:00:00Z", end: "2025-01-01T00:00:00Z" } }), bad({ conversion_metric_id: "TM9999" }), bad({ group_by: ["send_channel"] }), bad({ filter: "x" }), { data: { type: "flow-values-report" } }]) {
      expect((await report(b)).status).toBe(400);
    }
    expect((await mock.fetch(`${KLAVIYO_API_URL}/api/campaign-values-reports/`, { method: "POST", headers: auth, body: "{" })).status).toBe(400);
    expect((await mock.fetch(`${KLAVIYO_API_URL}/api/campaign-values-reports/?page_cursor=x`, { method: "POST", headers: auth, body: JSON.stringify(good) })).status).toBe(400);
    const defaults = (await (await report({ data: { type: "campaign-values-report", attributes: { ...good.data.attributes, group_by: undefined } } })).json()) as { data: { attributes: { results: { groupings: object }[] } } };
    expect(Object.keys(defaults.data.attributes.results[0]!.groupings).sort()).toEqual(["campaign_id", "campaign_message_id", "send_channel"]);
  });

  it("pages lists ten at a time, metrics 200 at a time, and sorts the way it's asked", async () => {
    klaviyoList.reset();
    klaviyoMetric.reset();
    const mock = klaviyoDocMock(account({ lists: klaviyoList.many(11), metrics: klaviyoMetric.many(201) }));
    const auth = { authorization: `Klaviyo-API-Key ${API_KEY}`, revision: KLAVIYO_REVISION };
    const lists = (await (await mock.fetch(`${KLAVIYO_API_URL}/api/lists/?sort=-name`, { headers: auth })).json()) as { data: { id: string }[]; links: { next: string } };
    expect(lists.data).toHaveLength(10);
    expect(lists.data[0]!.id).toBe("TL0009");
    const next = (await (await mock.fetch(lists.links.next, { headers: auth })).json()) as { data: unknown[]; links: { prev: string | null } };
    expect(next.data).toHaveLength(1);
    expect(next.links.prev).not.toBeNull();
    const metrics = (await (await mock.fetch(`${KLAVIYO_API_URL}/api/metrics/`, { headers: auth })).json()) as { data: unknown[] };
    expect(metrics.data).toHaveLength(200);
    const flows = (await (await mock.fetch(`${KLAVIYO_API_URL}/api/flows/?filter=less-than(updated,2026-01-02T00:00:00Z)&sort=-updated`, { headers: auth })).json()) as { data: unknown[] };
    expect(flows.data).toHaveLength(1);
    const campaigns = (await (await mock.fetch(`${KLAVIYO_API_URL}/api/campaigns/?fields%5Bcampaign%5D=definition.name`, { headers: auth })).json()) as { data: { attributes: unknown }[] };
    expect(campaigns.data[0]!.attributes).toEqual({ definition: { name: "Test campaign 1" } });
    const members = (await (await mock.fetch(`${KLAVIYO_API_URL}/api/lists/TL0001/relationships/profiles/?filter=less-or-equal(joined_group_at,2030-01-01T00:00:00Z)`, { headers: auth })).json()) as { data: unknown[] };
    expect(members.data).toEqual([]);
  });

  it("is built from Klaviyo's docs, names its revision and lists its assumptions", () => {
    const { api } = klaviyoDocMock({ apiKey: "" });
    expect(api.source.version).toBe(KLAVIYO_REVISION);
    expect(api.routes.filter((r) => r.method === "POST").map((r) => r.path)).toEqual(["/api/campaign-values-reports/", "/api/flow-values-reports/"]);
    expect(api.assumptions.length).toBeGreaterThan(5);
  });
});
