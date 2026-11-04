import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  mailchimpCampaign,
  mailchimpDocMock,
  mailchimpList,
  mailchimpMember,
  mailchimpReportFor,
  testPipeline,
  type MailchimpMock,
  type MailchimpMockData,
} from "@karatos/connector-testkit";
import {
  MAILCHIMP_EVENTS,
  MAILCHIMP_FIELDS,
  MAILCHIMP_WRITES,
  MailchimpApiError,
  MailchimpConfigError,
  formCustomerRef,
  mailchimpCampaignEvent,
  mailchimpClient,
  mailchimpConnector,
  mailchimpListEvent,
  mailchimpMemberEvents,
  mailchimpReportEvents,
  mailchimpStatus,
  mailchimpTime,
  mailchimpWebhookEvent,
  parseMailchimpCursor,
  verifyMailchimpWebhook,
  type MailchimpConnectorOptions,
  type MailchimpCursor,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const API_KEY = `${"a".repeat(32)}-us21`;
const CUSTOMER_KEY = "k".repeat(64);
const NOW = () => new Date("2026-10-20T00:00:00Z");
const RECEIVED = "2026-10-20T00:00:00.000Z";
const BASE = "https://us21.api.mailchimp.com/3.0";
const CTX = { customerKey: CUSTOMER_KEY, receivedAt: RECEIVED };
const LIST_1 = "a1b2c3d1e";
const LIST_2 = "a1b2c3d2e";

function account(overrides: Partial<MailchimpMockData> = {}): MailchimpMockData {
  for (const b of [mailchimpList, mailchimpMember, mailchimpCampaign]) b.reset();
  const lists = mailchimpList.many(2);
  const members = mailchimpMember.many(3);
  members[2]!.status = "unsubscribed";
  // No email address to link by: left out.
  const unlinked = mailchimpMember.one({ email_address: "not an address" });
  // No change time: the profile is dead-lettered rather than given a made-up one.
  const timeless = mailchimpMember.one({ last_changed: "" });
  const other = mailchimpMember.one({ list_id: LIST_2 });
  return {
    lists,
    members: { [LIST_1]: [...members, unlinked, timeless], [LIST_2]: [other] },
    campaigns: [
      ...mailchimpCampaign.many(2),
      // Sent before the five years the import reads.
      mailchimpCampaign.one({ send_time: "2020-05-01T10:00:00+00:00", create_time: "2020-04-30T10:00:00+00:00" }),
      // A draft: never listed, as the connector asks for sent campaigns.
      mailchimpCampaign.one({ status: "save" }),
      // Sent to nobody: its report gives no campaign.sent.
      mailchimpCampaign.one({ emails_sent: 0 }),
    ],
    apiKey: API_KEY,
    ...overrides,
  };
}

const options = (mock: MailchimpMock, extra: Partial<MailchimpConnectorOptions> = {}): MailchimpConnectorOptions => ({
  apiKey: API_KEY,
  customerKey: CUSTOMER_KEY,
  fetch: mock.fetch,
  sleep: async () => {},
  now: NOW,
  ...extra,
});

const connector = (mock: MailchimpMock, extra: Partial<MailchimpConnectorOptions> = {}) => mailchimpConnector(options(mock, extra));
const reads = (mock: MailchimpMock) => mock.fetch.calls.map((c) => decodeURIComponent(c.url.replace(BASE, "")));
const params = (read: string) => Object.fromEntries(new URL(`${BASE}${read}`).searchParams);
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const answering = (status: number, body: unknown, headers: Record<string, string> = {}): typeof globalThis.fetch => async () => new Response(JSON.stringify(body), { status, headers });
const emailRef = (n: number) => formCustomerRef(CUSTOMER_KEY, "email", `customer${n}@example.test`);

describe("Mailchimp client", () => {
  it("checks its key, naming the setting but never its value", () => {
    expect(() => mailchimpClient({ apiKey: " " })).toThrow(new MailchimpConfigError("set MAILCHIMP_API_KEY"));
    for (const bad of ["a".repeat(32), `${"a".repeat(32)}-us21.evil.test`, `${"a".repeat(32)}-us21/x`, `${"g".repeat(32)}-us21`, `${"a".repeat(32)}-`]) {
      const error = (() => {
        try {
          mailchimpClient({ apiKey: bad });
          return null;
        } catch (e) {
          return e as Error;
        }
      })();
      expect(error?.message).toBe("MAILCHIMP_API_KEY must be a Mailchimp API key, ending in its data center such as -us21");
      expect(error?.message).not.toContain(bad);
    }
    expect(mailchimpClient({ apiKey: ` ${API_KEY} ` }).baseUrl).toBe(BASE);
    expect(mailchimpClient({ apiKey: `${"a".repeat(32)}-gb1` }).baseUrl).toBe("https://gb1.api.mailchimp.com/3.0");
  });

  it("sends GETs with Basic auth, the fields it wants and parameters it built itself", async () => {
    const mock = mailchimpDocMock(account());
    const client = mailchimpClient(options(mock));
    await client.get("ping");
    await client.get("lists", { offset: 0 });
    await client.get("members", { listId: LIST_1, offset: 1000, sinceLastChanged: "2026-10-01T00:00:00.000Z" });
    await client.get("campaigns", { offset: 0, sinceSendTime: "2021-10-20T00:00:00Z" });
    await client.get("report", { campaignId: "c0ffee10" });
    const [ping, lists, members, campaigns, report] = reads(mock);
    expect(ping).toBe("/ping");
    expect(params(lists!)).toEqual({ fields: MAILCHIMP_FIELDS.lists.join(","), count: "1000", offset: "0" });
    expect(params(members!)).toEqual({ count: "1000", offset: "1000", since_last_changed: "2026-10-01T00:00:00.000Z", fields: MAILCHIMP_FIELDS.members.join(","), sort_field: "last_changed", sort_dir: "ASC" });
    expect(params(campaigns!)).toEqual({ count: "1000", offset: "0", since_send_time: "2021-10-20T00:00:00Z", fields: MAILCHIMP_FIELDS.campaigns.join(","), status: "sent", sort_field: "send_time", sort_dir: "ASC" });
    expect(report!.split("?")[0]).toBe("/reports/c0ffee10");
    expect(params(report!)).toEqual({ fields: MAILCHIMP_FIELDS.report.join(",") });
    expect(mock.fetch.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("never asks for names, phone numbers, addresses or merge fields", () => {
    const leaves = Object.values(MAILCHIMP_FIELDS).flat().map((path) => path.split(".").pop());
    for (const personal of ["merge_fields", "full_name", "location", "tags", "contact", "subject_line", "unique_email_id", "contact_id", "last_note", "ip_signup", "from_name", "reply_to"]) {
      expect(leaves).not.toContain(personal);
    }
    // A member's id is the MD5 of its email address.
    expect(MAILCHIMP_FIELDS.members).not.toContain("members.id");
  });

  it("sends only its listed reads, and only the parameters each takes, with ids and times it checked", async () => {
    const mock = mailchimpDocMock(account());
    const client = mailchimpClient(options(mock));
    const tried = async (read: string, query: Record<string, unknown> = {}) => (await failure(client.get(read as never, query as never))).message;
    expect(await tried("batches")).toBe("the Mailchimp connector only sends its listed reads");
    expect(await tried("toString")).toBe("the Mailchimp connector only sends its listed reads");
    expect(await tried("ping", { offset: 0 })).toBe("ping doesn't take offset");
    expect(await tried("lists", { listId: LIST_1 })).toBe("lists doesn't take listId");
    expect(await tried("campaigns", { sinceLastChanged: "2026-10-01T00:00:00Z" })).toBe("campaigns doesn't take sinceLastChanged");
    expect(await tried("members", { offset: 0 })).toBe("members needs a list id of letters and digits");
    expect(await tried("members", { listId: "../campaigns", offset: 0 })).toBe("members needs a list id of letters and digits");
    expect(await tried("report", { campaignId: "c1?fields=x" })).toBe("report needs a campaign id of letters and digits");
    expect(await tried("lists", { offset: -1 })).toBe("offset must be a whole number from 0");
    expect(await tried("lists", { offset: 1.5 })).toBe("offset must be a whole number from 0");
    expect(await tried("members", { listId: LIST_1, offset: 0, sinceLastChanged: "yesterday" })).toBe("since_last_changed must be an ISO time in UTC");
    expect(await tried("campaigns", { offset: 0, sinceSendTime: "2026-13-40T00:00:00Z" })).toBe("since_send_time must be an ISO time in UTC");
    expect(await tried("campaigns", { offset: 0, sinceSendTime: "2026-10-01T00:00:00+02:00" })).toBe("since_send_time must be an ISO time in UTC");
    expect(mock.fetch.calls).toEqual([]);
  });

  it("waits out a rate limit, honouring Retry-After up to a minute, then reports it", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    await mailchimpClient(options(mailchimpDocMock(account({ rateLimited: 2 })), { sleep })).get("ping");
    let calls = 0;
    const later: typeof globalThis.fetch = async () => (++calls === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "600" } }) : new Response('{"health_status":"ok"}', { status: 200 }));
    await mailchimpClient({ apiKey: API_KEY, fetch: later, sleep }).get("ping");
    expect(waits).toEqual([1000, 2000, 60_000]);
    const stuck = await failure(mailchimpClient(options(mailchimpDocMock(account({ rateLimited: 9 })), { sleep, rateLimitRetries: 1 })).get("ping"));
    expect(stuck).toEqual(new MailchimpApiError("Mailchimp answered HTTP 429 to ping: Too Many Requests: You have exceeded the limit of 10 simultaneous connections.; Mailchimp kept rate-limiting the sync", 429));
  });

  it("reports Mailchimp's problems cut short, with a hint for a bad key, and never the key", async () => {
    const wrong = await failure(mailchimpClient(options(mailchimpDocMock(account({ apiKey: `${"c".repeat(32)}-us21` })))).get("ping"));
    expect(wrong.message).toBe("Mailchimp answered HTTP 401 to ping: API Key Invalid: Your API key may be invalid, or you've attempted to access the wrong datacenter.; check MAILCHIMP_API_KEY is current");
    const long = await failure(mailchimpClient({ apiKey: API_KEY, fetch: answering(400, { title: "Invalid Resource", detail: "x".repeat(500) }) }).get("ping"));
    expect(long.message).toBe(`Mailchimp answered HTTP 400 to ping: ${`Invalid Resource: ${"x".repeat(500)}`.slice(0, 200)}`);
    expect((await failure(mailchimpClient({ apiKey: API_KEY, fetch: answering(500, null) }).get("ping"))).message).toBe("Mailchimp answered HTTP 500 to ping");
    expect((await failure(mailchimpClient({ apiKey: API_KEY, fetch: answering(200, [1]) }).get("ping"))).message).toBe("Mailchimp did not answer with JSON");
    expect((await failure(mailchimpClient({ apiKey: API_KEY, fetch: async () => new Response("<html>", { status: 200 }) }).get("ping"))).message).toBe("Mailchimp did not answer with JSON");
    for (const e of [wrong, long]) expect(e.message).not.toContain(API_KEY);
  });
});

describe("Mailchimp normalization", () => {
  it("keeps an audience's name, opt-in and counts, keyed by them", () => {
    mailchimpList.reset();
    const [single, double] = mailchimpList.many(2);
    const event = mailchimpListEvent(single, CTX)!;
    expect(event).toEqual({
      id: expect.stringMatching(new RegExp(`^mailchimp_list:${LIST_1}:[0-9a-f]{16}$`)),
      type: MAILCHIMP_EVENTS.list,
      occurredAt: RECEIVED,
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(new RegExp(`^mailchimp:list:${LIST_1}:[0-9a-f]{16}$`)),
      payload: { listId: `mailchimp:list:${LIST_1}`, name: "Store customers", optIn: "single", memberCount: 3, unsubscribeCount: 1, cleanedCount: 0, createdAt: "2021-03-02T00:00:00.000Z" },
    });
    expect(mailchimpListEvent(double, CTX)!.payload.optIn).toBe("double");
    expect(mailchimpListEvent({ ...single, stats: { ...single!.stats, member_count: 4 } }, { ...CTX, receivedAt: "2026-10-21T00:00:00.000Z" })!.idempotencyKey).not.toBe(event.idempotencyKey);
    expect(mailchimpListEvent(single, { ...CTX, receivedAt: "2026-10-21T00:00:00.000Z" })!.idempotencyKey).toBe(event.idempotencyKey);
    expect(JSON.stringify(event)).not.toContain("Test Street");
    expect(mailchimpListEvent({ id: "L1" }, CTX)!.payload).toEqual({ listId: "mailchimp:list:L1", name: "Mailchimp audience L1" });
    for (const bad of [null, {}, { id: "../x" }, { id: 5 }]) expect(mailchimpListEvent(bad, CTX)).toBeNull();
  });

  it("makes a member the keyed reference custom forms makes for its address, and keeps nothing personal", () => {
    mailchimpMember.reset();
    const member = mailchimpMember.one({ email_address: "  Customer1@Example.TEST " });
    const [profile, membership] = mailchimpMemberEvents(member, LIST_1, CTX);
    const ref = emailRef(1);
    const hash = ref.slice(ref.lastIndexOf(":") + 1);
    expect(profile).toEqual({
      id: `mailchimp_member:${LIST_1}:${hash}:2026-09-01T01:00:00.000Z`,
      type: MAILCHIMP_EVENTS.profile,
      occurredAt: "2026-09-01T01:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `mailchimp:member:${LIST_1}:${hash}:2026-09-01T01:00:00.000Z`,
      payload: {
        customerId: ref,
        name: `Mailchimp contact ${hash.slice(0, 8)}`,
        marketingConsent: true,
        contactRefs: [ref],
        emailStatus: "subscribed",
        listId: `mailchimp:list:${LIST_1}`,
        memberRating: 3,
        optedInAt: "2024-05-01T01:00:00.000Z",
        updatedAt: "2026-09-01T01:00:00.000Z",
      },
    });
    expect(membership).toMatchObject({ type: MAILCHIMP_EVENTS.membership, occurredAt: RECEIVED, idempotencyKey: `mailchimp:list_member:${LIST_1}:${hash}`, payload: { groupId: `mailchimp:list:${LIST_1}`, groupKind: "list", profileRef: ref } });
    const kept = JSON.stringify([profile, membership]);
    for (const personal of ["customer1", "Customer1", "Test Customer", "212 555", "Bridal", "05/14", member.id, member.unique_email_id]) expect(kept).not.toContain(personal);
  });

  it("gives consent only to subscribed members, and reads every status Mailchimp has", () => {
    mailchimpMember.reset();
    const member = mailchimpMember.one();
    for (const status of ["unsubscribed", "cleaned", "pending", "transactional", "archived"] as const) {
      expect(mailchimpMemberEvents({ ...member, status }, LIST_1, CTX)[0]!.payload).toMatchObject({ marketingConsent: false, emailStatus: status });
    }
    expect(mailchimpStatus("SUBSCRIBED")).toBe("unknown");
    expect(mailchimpMemberEvents({ ...member, status: "vip" }, LIST_1, CTX)[0]!.payload).toMatchObject({ marketingConsent: false, emailStatus: "unknown" });
  });

  it("stores a member again when it changes, and leaves out ratings and times it can't read", () => {
    mailchimpMember.reset();
    const member = mailchimpMember.one();
    const [first] = mailchimpMemberEvents(member, LIST_1, CTX);
    const [later] = mailchimpMemberEvents({ ...member, last_changed: "2026-10-01T00:00:00+00:00" }, LIST_1, CTX);
    const [elsewhere] = mailchimpMemberEvents(member, LIST_2, CTX);
    expect(new Set([first!.idempotencyKey, later!.idempotencyKey, elsewhere!.idempotencyKey]).size).toBe(3);
    for (const rating of [6, -1, 2.5, "3"]) expect(mailchimpMemberEvents({ ...member, member_rating: rating }, LIST_1, CTX)[0]!.payload).not.toHaveProperty("memberRating");
    expect(mailchimpMemberEvents({ ...member, member_rating: 0 }, LIST_1, CTX)[0]!.payload.memberRating).toBe(0);
    const timeless = mailchimpMemberEvents({ ...member, last_changed: undefined, timestamp_opt: "soon" }, LIST_1, CTX)[0]!;
    expect([timeless.occurredAt, timeless.idempotencyKey.endsWith(":unknown")]).toEqual([undefined, true]);
    expect(timeless.payload).not.toHaveProperty("optedInAt");
  });

  it("gives nothing for a member with no address or an audience id it can't use", () => {
    mailchimpMember.reset();
    const member = mailchimpMember.one();
    for (const email of ["", "not an address", 5, undefined]) expect(mailchimpMemberEvents({ ...member, email_address: email }, LIST_1, CTX)).toEqual([]);
    expect(mailchimpMemberEvents(member, "../x", CTX)).toEqual([]);
    for (const bad of [null, "member", []]) expect(mailchimpMemberEvents(bad, LIST_1, CTX)).toEqual([]);
    expect(() => mailchimpMemberEvents(member, LIST_1, { ...CTX, customerKey: "short" })).toThrow("CUSTOMER_REF_KEY must be at least 32 characters");
  });

  it("keeps a campaign's internal title, kind, audience and send time, but not its subject line", () => {
    mailchimpCampaign.reset();
    const campaign = mailchimpCampaign.one();
    expect(mailchimpCampaignEvent(campaign, CTX)).toEqual({
      id: "mailchimp_campaign:c0ffee10:2026-06-02T01:00:00.000Z",
      type: MAILCHIMP_EVENTS.campaign,
      occurredAt: "2026-06-02T01:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "mailchimp:campaign:c0ffee10:2026-06-02T01:00:00.000Z",
      payload: { campaignId: "mailchimp:campaign:c0ffee10", name: "Holiday gift guide", kind: "regular", status: "sent", listId: `mailchimp:list:${LIST_1}`, createdAt: "2026-06-02T00:00:00.000Z", sentAt: "2026-06-02T01:00:00.000Z" },
    });
    expect(JSON.stringify(mailchimpCampaignEvent(campaign, CTX))).not.toContain("Test subject");
    expect(mailchimpCampaignEvent({ id: "c9" }, CTX)).toMatchObject({ occurredAt: undefined, payload: { campaignId: "mailchimp:campaign:c9", name: "Mailchimp campaign c9" } });
    for (const bad of [null, {}, { id: "c 1" }]) expect(mailchimpCampaignEvent(bad, CTX)).toBeNull();
  });

  it("turns a report into figures in cents and a campaign.sent once emails went out", () => {
    mailchimpCampaign.reset();
    const campaign = mailchimpCampaign.one();
    const [metrics, sent] = mailchimpReportEvents(mailchimpReportFor(campaign), CTX);
    expect(metrics).toMatchObject({
      type: MAILCHIMP_EVENTS.campaignMetrics,
      occurredAt: "2026-06-02T01:00:00.000Z",
      idempotencyKey: expect.stringMatching(/^mailchimp:campaign_values:c0ffee10:[0-9a-f]{16}$/),
      payload: { campaignId: "mailchimp:campaign:c0ffee10", channel: "email", from: "2026-06-02T01:00:00.000Z", through: RECEIVED, recipients: 3, bounced: 1, opens: 4, uniqueOpens: 2, clicks: 1, uniqueClicks: 1, conversions: 1, revenueCents: 125_050, currency: "USD", unsubscribes: 1, abuseReports: 0 },
    });
    expect(sent).toEqual({
      id: "mailchimp_campaign_sent:c0ffee10",
      type: MAILCHIMP_EVENTS.campaignSent,
      occurredAt: "2026-06-02T01:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "mailchimp:campaign_sent:c0ffee10",
      payload: { campaignId: "mailchimp:campaign:c0ffee10", name: "Holiday gift guide", channel: "email", costCents: 0 },
    });
    const grown = mailchimpReportEvents(mailchimpReportFor(campaign, 2), { ...CTX, receivedAt: "2026-10-21T00:00:00.000Z" });
    expect(grown[0]!.idempotencyKey).not.toBe(metrics!.idempotencyKey);
    expect(grown[1]!.idempotencyKey).toBe(sent!.idempotencyKey);
    expect(mailchimpReportEvents(mailchimpReportFor(campaign), { ...CTX, receivedAt: "2026-10-21T00:00:00.000Z" })[0]!.idempotencyKey).toBe(metrics!.idempotencyKey);
    expect(JSON.stringify([metrics, sent])).not.toContain("Test subject");
  });

  it("leaves out figures it can't read, and gives no campaign.sent for a report that reached no one", () => {
    const sparse = mailchimpReportEvents({ id: "c9", emails_sent: 0, bounces: { hard_bounce: 2 }, opens: "x", ecommerce: { total_revenue: -5, currency_code: "usd" } }, CTX);
    expect(sparse).toHaveLength(1);
    expect(sparse[0]!.payload).toEqual({ campaignId: "mailchimp:campaign:c9", channel: "email", through: RECEIVED, recipients: 0, bounced: 2 });
    expect(sparse[0]!.occurredAt).toBeUndefined();
    expect(mailchimpReportEvents({ id: "c9", bounces: { soft_bounce: 1.4 } }, CTX)[0]!.payload).toMatchObject({ bounced: 1 });
    expect(mailchimpReportEvents({ id: "c9", emails_sent: Number.NaN }, CTX)).toHaveLength(1);
    for (const bad of [null, {}, { id: "c/1" }]) expect(mailchimpReportEvents(bad, CTX)).toEqual([]);
  });

  it("reads Mailchimp's times as UTC and turns down anything else", () => {
    expect(mailchimpTime("2026-10-01T12:00:00+00:00")).toBe("2026-10-01T12:00:00.000Z");
    expect(mailchimpTime("2026-10-01T12:00:00-04:00")).toBe("2026-10-01T16:00:00.000Z");
    for (const bad of ["", "soon", "2026-10-01", "1767225600", 5, null, `2026-10-01T12:00:00${"0".repeat(40)}`, "2026-13-01T12:00:00Z"]) expect(mailchimpTime(bad)).toBeUndefined();
  });

  it("uses synthetic fixtures only", () => {
    expect(() => assertSynthetic(account())).not.toThrow();
  });
});

describe("Mailchimp sync", () => {
  it("imports, replays, resumes and retries the mocked account", async () => {
    // 2 audiences; 3 linked members of the first (2 events each), one timeless (its profile dead-lettered) and one of the second;
    // 3 sent campaigns in five years, each with its report, 2 of them reaching anyone.
    const result = await checkConnectorSync({ makeConnector: () => connector(mailchimpDocMock(account())), expected: { ingested: 19, deadLettered: 1 } });
    expect(result.full.batches).toBe(4);
    expect(parseMailchimpCursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done", lists: [LIST_1, LIST_2] });
  });

  it("reads every audience and member, and campaigns from five years back with their reports", async () => {
    const mock = mailchimpDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(reads(mock).map((r) => r.split("?")[0])).toEqual([
      "/lists",
      `/lists/${LIST_1}/members`,
      `/lists/${LIST_2}/members`,
      "/campaigns",
      "/reports/c0ffee10",
      "/reports/c0ffee20",
      "/reports/c0ffee50",
    ]);
    const members = reads(mock).filter((r) => r.includes("/members"));
    expect(members.map((r) => params(r).since_last_changed)).toEqual([undefined, undefined]);
    expect(params(reads(mock)[3]!).since_send_time).toBe("2021-10-20T00:00:00.000Z");
    expect(report).toMatchObject({ ingested: 19, deadLettered: 1, batches: 4 });
  });

  it("pages through 1000 at a time", async () => {
    const data = account();
    mailchimpMember.reset();
    data.members[LIST_1] = mailchimpMember.many(1001);
    const mock = mailchimpDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(reads(mock).filter((r) => r.includes(`/lists/${LIST_1}/members`)).map((r) => params(r).offset)).toEqual(["0", "1000"]);
    expect(report.batches).toBe(5);
    expect(report.ingested).toBe(2 + 1001 * 2 + 2 + 8);
  });

  it("goes straight to campaigns when the account has no audiences", async () => {
    const mock = mailchimpDocMock(account({ lists: [], members: {} }));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(reads(mock).map((r) => r.split("?")[0]).slice(0, 2)).toEqual(["/lists", "/campaigns"]);
    expect(report.ingested).toBe(8);
  });

  it("produces payloads the retail departments accept, and marketing sees the campaigns", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(mailchimpDocMock(account())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 19, deadLettered: 1 });
    expect(memory.signals.filter((s) => s.kind === "campaign.sent").map((s) => s.subject.id)).toEqual(["mailchimp:campaign:c0ffee10", "mailchimp:campaign:c0ffee20"]);
    expect([...memory.entities.values()].filter((e) => e.ref.kind === "customer").map((e) => e.ref.id).sort()).toEqual([emailRef(1), emailRef(2), emailRef(3), emailRef(6)].sort());
  });

  it("leaves a finished import finished", async () => {
    const mock = mailchimpDocMock(account());
    const done: MailchimpCursor = { pass: "historical", step: "done", lists: [LIST_1], listIndex: 0, offset: 0, since: "2021-10-20T00:00:00.000Z", nextFrom: RECEIVED };
    const batches: SourceBatch[] = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })) batches.push(b);
    expect([batches, mock.fetch.calls]).toEqual([[], []]);
  });

  it("reads members changed since the last pass started and campaigns sent from 30 days before it", async () => {
    const mock = mailchimpDocMock(account());
    const previous: MailchimpCursor = { pass: "historical", step: "done", lists: [LIST_1, LIST_2], listIndex: 0, offset: 0, since: "2021-10-20T00:00:00.000Z", nextFrom: "2026-09-01T01:30:00.000Z" };
    const batches: SourceBatch[] = [];
    for await (const b of connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(previous) })) batches.push(b);
    const members = reads(mock).filter((r) => r.includes("/members"));
    expect(members.map((r) => params(r).since_last_changed)).toEqual(["2026-09-01T01:30:00.000Z", "2026-09-01T01:30:00.000Z"]);
    expect(params(reads(mock).find((r) => r.startsWith("/campaigns"))!).since_send_time).toBe("2026-08-02T01:30:00.000Z");
    // Members 2 and 3 changed after the last pass started, and member 6 (in the second audience) too.
    const profiles = batches.flatMap((b) => b.events as { type: string; payload: { customerId: string } }[]).filter((e) => e.type === MAILCHIMP_EVENTS.profile);
    expect(profiles.map((e) => e.payload.customerId)).toEqual([emailRef(2), emailRef(3), emailRef(6)]);
    expect(parseMailchimpCursor(batches.at(-1)!.cursor)).toMatchObject({ pass: "incremental", step: "done", since: "2026-09-01T01:30:00.000Z", nextFrom: "2026-10-19T23:55:00.000Z" });
  });

  it("looks back 48 hours without a checkpoint, and resumes an interrupted pass where it stopped", async () => {
    const fresh = mailchimpDocMock(account());
    for await (const _ of connector(fresh).incrementalSync({ organizationId: TEST_ORG, cursor: null })) void _;
    expect(params(reads(fresh).find((r) => r.includes("/members"))!).since_last_changed).toBe("2026-10-18T00:00:00.000Z");
    const stopped: MailchimpCursor = { pass: "incremental", step: "members", lists: [LIST_1, LIST_2], listIndex: 1, offset: 0, since: "2026-10-01T00:00:00.000Z", nextFrom: RECEIVED };
    const resumed = mailchimpDocMock(account());
    for await (const _ of connector(resumed).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(stopped) })) void _;
    expect(reads(resumed).map((r) => r.split("?")[0])[0]).toBe(`/lists/${LIST_2}/members`);
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: MailchimpCursor = { pass: "incremental", step: "members", lists: [LIST_1], listIndex: 0, offset: 1000, since: RECEIVED, nextFrom: RECEIVED };
    expect(parseMailchimpCursor(JSON.stringify(good))).toEqual(good);
    expect(parseMailchimpCursor(null)).toBeNull();
    for (const bad of [
      { ...good, pass: "full" },
      { ...good, step: "reports" },
      { ...good, lists: "a1" },
      { ...good, lists: ["../x"] },
      { ...good, listIndex: -1 },
      { ...good, offset: 1.5 },
      { ...good, since: "soon" },
      { ...good, nextFrom: undefined },
      null,
    ]) {
      expect(() => parseMailchimpCursor(JSON.stringify(bad))).toThrow("Mailchimp checkpoint is not in the expected shape");
    }
    const lost: MailchimpCursor = { ...good, listIndex: 3 };
    const batches = connector(mailchimpDocMock(account())).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(lost) });
    return expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Mailchimp checkpoint is not in the expected shape");
  });

  it("needs a customer reference key", () => {
    expect(() => connector(mailchimpDocMock(account()), { customerKey: "" })).toThrow("CUSTOMER_REF_KEY must be at least 32 characters");
  });

  it("declares its write and a read-only gate turns it down", async () => {
    const c = connector(mailchimpDocMock(account()));
    expect(c.writes).toBe(MAILCHIMP_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((e) => [e.action, e.outcome])).toEqual([["add_audience_member", "refused"]]);
  });
});

describe("Mailchimp webhooks", () => {
  const SECRET = "s".repeat(40);
  const delivery = (extra: Record<string, string> = {}) =>
    new URLSearchParams({ type: "subscribe", fired_at: "2026-10-19 21:35:57", "data[list_id]": LIST_1, "data[email]": "customer1@example.test", "data[merges][FNAME]": "Test", ...extra }).toString();

  it("accepts a delivery whose URL carries the secret, and rejects a wrong, missing or short one", () => {
    expect(verifyMailchimpWebhook(SECRET, `https://brain.example.test/webhooks/mailchimp?key=${SECRET}`)).toEqual({ ok: true });
    expect(verifyMailchimpWebhook(SECRET, new URL(`https://brain.example.test/webhooks/mailchimp?key=${SECRET}`))).toEqual({ ok: true });
    expect(verifyMailchimpWebhook(SECRET, `/webhooks/mailchimp?key=${SECRET}`)).toEqual({ ok: true });
    expect(verifyMailchimpWebhook(SECRET, `/webhooks/mailchimp?key=${SECRET}x`)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyMailchimpWebhook(SECRET, `/webhooks/mailchimp?key=${"t".repeat(SECRET.length)}`)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyMailchimpWebhook(SECRET, `/webhooks/mailchimp?key=${SECRET.slice(1)}`)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyMailchimpWebhook(SECRET, "/webhooks/mailchimp")).toEqual({ ok: false, reason: "missing" });
    expect(verifyMailchimpWebhook(SECRET, "/webhooks/mailchimp?key=")).toEqual({ ok: false, reason: "missing" });
    expect(verifyMailchimpWebhook("", `/webhooks/mailchimp?key=`)).toEqual({ ok: false, reason: "missing" });
    expect(verifyMailchimpWebhook("short", "/webhooks/mailchimp?key=short")).toEqual({ ok: false, reason: "missing" });
    expect(verifyMailchimpWebhook(SECRET, "http://[bad")).toEqual({ ok: false, reason: "missing" });
  });

  it("reads a delivery's type, audience and time, and nothing about the member", () => {
    const event = mailchimpWebhookEvent(delivery());
    expect(event).toEqual({ type: "subscribe", listId: LIST_1, time: "2026-10-19T21:35:57.000Z" });
    expect(JSON.stringify(event)).not.toContain("customer1");
    for (const type of ["unsubscribe", "profile", "upemail", "cleaned", "campaign"]) expect(mailchimpWebhookEvent(delivery({ type }))!.type).toBe(type);
    expect(mailchimpWebhookEvent(delivery(), [LIST_1, LIST_2])).not.toBeNull();
    expect(mailchimpWebhookEvent(delivery(), [LIST_2])).toBeNull();
    expect(mailchimpWebhookEvent(delivery({ fired_at: "yesterday" }))!.time).toBeUndefined();
    for (const bad of [delivery({ type: "delete" }), delivery({ "data[list_id]": "../x" }), "", "x".repeat(70_000), 5 as never]) expect(mailchimpWebhookEvent(bad)).toBeNull();
  });
});
