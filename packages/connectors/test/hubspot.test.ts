import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  HUBSPOT_MOCK_READ_SCOPES,
  HUBSPOT_TEST_HUB_ID,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  hmacSha256,
  hubSpotArchived,
  hubSpotCompany,
  hubSpotContact,
  hubSpotDeal,
  hubSpotDocMock,
  hubSpotEngagement,
  hubSpotMs,
  hubSpotTicket,
  tamper,
  testPipeline,
  type HubSpotMock,
  type HubSpotMockData,
  type HubSpotMockRecord,
} from "@karatos/connector-testkit";
import {
  HUBSPOT_ALLOWED_REQUESTS,
  HUBSPOT_API_URL,
  HUBSPOT_OBJECTS,
  HUBSPOT_OVERLAP_MS,
  HUBSPOT_PROPERTIES,
  HUBSPOT_READ_SCOPES,
  HUBSPOT_TOKEN_INFO_PATH,
  HUBSPOT_WRITES,
  HubSpotApiError,
  HubSpotConfigError,
  checkHubSpotSearchBody,
  hubSpotCents,
  hubSpotClient,
  hubSpotConnector,
  hubSpotDeletionEvents,
  hubSpotEvents,
  hubSpotPageEvents,
  hubSpotRequestKind,
  hubSpotSearchBody,
  hubSpotTime,
  hubSpotWebhookChanges,
  hubSpotWriteScopes,
  parseHubSpotCursor,
  verifyHubSpotWebhook,
  type HubSpotConnectorOptions,
  type HubSpotCursor,
  type HubSpotSearchBody,
} from "../src/index.js";

// A token-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = ["pat", "na1", ["00000000", "0000", "4000", "8000", "000000000000"].join("-")].join("-");
const NOW = () => new Date("2026-01-20T00:00:00Z");
const RECEIVED = "2026-01-20T00:00:00.000Z";
const SINCE = "2021-01-20T00:00:00.000Z";
const V = "2026-09";

function account(overrides: Partial<HubSpotMockData> = {}): HubSpotMockData {
  for (const b of [hubSpotCompany, hubSpotContact, hubSpotDeal, hubSpotTicket, ...Object.values(hubSpotEngagement)]) b.reset();
  const contacts = hubSpotContact.many(3);
  return {
    records: {
      companies: hubSpotCompany.many(2),
      contacts: [...contacts, hubSpotArchived(hubSpotContact.one(), "2026-01-19T12:00:00.000Z")],
      deals: hubSpotDeal.many(2),
      tickets: hubSpotTicket.many(1),
      calls: hubSpotEngagement.calls.many(1),
      emails: hubSpotEngagement.emails.many(1),
      meetings: hubSpotEngagement.meetings.many(1),
      notes: hubSpotEngagement.notes.many(1),
      tasks: hubSpotEngagement.tasks.many(1),
    },
    associations: {
      "deals:contacts": { "3001": ["1001"] },
      "deals:companies": { "3001": ["2001"] },
      "tickets:contacts": { "4001": ["1002"] },
      "calls:contacts": { "5001": ["1001"] },
      "calls:deals": { "5001": ["3001"] },
      "notes:contacts": { "8001": ["1001", "1002"] },
    },
    accessToken: TOKEN,
    ...overrides,
  };
}

const options = (mock: HubSpotMock, extra: Partial<HubSpotConnectorOptions> = {}): HubSpotConnectorOptions => ({
  accessToken: TOKEN,
  fetch: mock.fetch,
  sleep: async () => {},
  now: NOW,
  ...extra,
});

const connector = (mock: HubSpotMock, extra: Partial<HubSpotConnectorOptions> = {}) => hubSpotConnector(options(mock, extra));
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const path = (url: string) => decodeURIComponent(url.replace(HUBSPOT_API_URL, ""));
const reads = (mock: HubSpotMock) => mock.fetch.calls.map((c) => `${c.method} ${path(c.url).split("?")[0]}`);
const filterValues = (body: Record<string, unknown>) => (body as unknown as HubSpotSearchBody).filterGroups[0]!.filters.map((f) => Number(f.value));
const iso = (ms: number) => new Date(ms).toISOString();
/** n contacts, changed at the times `at` gives. */
const contactsAt = (count: number, at: (i: number) => string) => {
  hubSpotContact.reset();
  return hubSpotContact.many(count).map((c, i) => ({ ...c, properties: { ...c.properties, lastmodifieddate: at(i) }, updatedAt: at(i) }));
};
const only = (records: HubSpotMockData["records"]): HubSpotMockData => ({ ...account(), records, associations: {} });
const sync = (mock: HubSpotMock, mode: "historical" | "incremental" = "historical", extra: Partial<HubSpotConnectorOptions> = {}) => {
  const { memory, pipeline } = testPipeline();
  return runSync({ connector: connector(mock, extra), mode, pipeline, memory, organizationId: TEST_ORG, sleep: async () => {} }).then((report) => ({ report, memory }));
};

/** A fetch that records each request's method, URL, headers and body before the mock answers it. */
function recording(mock: HubSpotMock) {
  const sent: { method: string; url: string; headers: Headers; body: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input as string, init);
    sent.push({ method: request.method, url: request.url, headers: request.headers, body: await request.clone().text() });
    return mock.fetch(request);
  };
  return { sent, fetch };
}

describe("HubSpot client", () => {
  it("checks its token's shape, naming the setting but never its value", () => {
    const mock = hubSpotDocMock(account());
    expect(() => hubSpotClient({ ...options(mock), accessToken: " " })).toThrow(new HubSpotConfigError("set HUBSPOT_ACCESS_TOKEN"));
    const error = (() => {
      try {
        hubSpotClient({ ...options(mock), accessToken: "not-a-token" });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toBe("HUBSPOT_ACCESS_TOKEN must be a private app or service key access token (pat-…)");
    expect(() => hubSpotClient({ ...options(mock), accessToken: ` ${TOKEN} ` })).not.toThrow();
  });

  it("allows only its listed reads: token info, archived lists, searches and batch association reads on api.hubapi.com", () => {
    const at = (p: string) => `${HUBSPOT_API_URL}${p}`;
    expect(hubSpotRequestKind("POST", at(HUBSPOT_TOKEN_INFO_PATH))).toBe("token_info");
    expect(hubSpotRequestKind("GET", at(`/crm/objects/${V}/contacts?archived=true&limit=100&properties=firstname&after=abc`))).toBe("list");
    expect(hubSpotRequestKind("POST", at(`/crm/objects/${V}/tasks/search`))).toBe("search");
    expect(hubSpotRequestKind("POST", at(`/crm/associations/${V}/calls/deals/batch/read`))).toBe("associations");
    for (const [method, url] of [
      // Writes: create, update, archive, merge, batch writes and association writes.
      ["POST", at(`/crm/objects/${V}/contacts`)],
      ["PATCH", at(`/crm/objects/${V}/contacts/1001`)],
      ["DELETE", at(`/crm/objects/${V}/contacts/1001`)],
      ["PUT", at(`/crm/objects/${V}/contacts/1001`)],
      ["POST", at(`/crm/objects/${V}/contacts/batch/update`)],
      ["POST", at(`/crm/objects/${V}/contacts/batch/archive`)],
      ["POST", at(`/crm/objects/${V}/contacts/batch/upsert`)],
      ["POST", at(`/crm/objects/${V}/contacts/merge`)],
      ["POST", at(`/crm/objects/${V}/contacts/gdpr-delete`)],
      ["POST", at(`/crm/associations/${V}/deals/contacts/batch/create`)],
      ["POST", at(`/crm/associations/${V}/deals/contacts/batch/archive`)],
      ["PUT", at(`/crm/objects/${V}/deals/3001/associations/contacts/1001`)],
      // Reads it doesn't make, other versions, other objects and other hosts.
      ["GET", at(`/crm/objects/${V}/contacts`)],
      ["GET", at(`/crm/objects/${V}/contacts?archived=false`)],
      ["GET", at(`/crm/objects/${V}/contacts?archived=true&archived=true`)],
      ["GET", at(`/crm/objects/${V}/contacts?archived=true&propertiesWithHistory=email`)],
      ["GET", at(`/crm/objects/${V}/contacts/1001?archived=true`)],
      ["GET", at(`/crm/objects/${V}/contacts/search?archived=true`)],
      ["POST", at(`/crm/objects/${V}/contacts/search?hapikey=x`)],
      ["POST", at(`/crm/objects/2026-03/contacts/search`)],
      ["POST", at(`/crm/v3/objects/contacts/search`)],
      ["POST", at(`/crm/objects/${V}/users/search`)],
      ["POST", at(`/crm/objects/${V}/contacts/search/extra`)],
      ["POST", at(`/crm/associations/${V}/deals/tickets/batch/read`)],
      ["GET", at(HUBSPOT_TOKEN_INFO_PATH)],
      ["POST", `${HUBSPOT_TOKEN_INFO_PATH}`],
      ["POST", `http://api.hubapi.com/crm/objects/${V}/contacts/search`],
      ["POST", `https://api.hubapi.com.example.test/crm/objects/${V}/contacts/search`],
      ["POST", `https://user:pass@api.hubapi.com/crm/objects/${V}/contacts/search`],
      ["POST", at(`/crm/objects/${V}/contacts/search#x`)],
      ["POST", "not a url"],
    ] as const) {
      expect([method, url, hubSpotRequestKind(method, url)]).toEqual([method, url, null]);
    }
    expect(HUBSPOT_ALLOWED_REQUESTS.map((r) => `${r.method} ${r.kind}`)).toEqual(["POST token_info", "GET list", "POST search", "POST associations"]);
  });

  it("throws before sending anything a caller slips past its types", async () => {
    const mock = hubSpotDocMock(account());
    const client = hubSpotClient(options(mock));
    const body = hubSpotSearchBody("contacts", { from: SINCE, until: RECEIVED });
    for (const object of ["contacts/batch", "contacts/merge", "users", "contacts/../deals", "contacts?archived=true"]) {
      await expect(client.search(object as never, body)).rejects.toThrow(new HubSpotConfigError("the HubSpot connector only sends its listed reads"));
    }
    for (const object of ["contacts/1001", "contacts/batch/read", "owners", "contacts?archived=false&x=1"]) {
      await expect(client.listArchived(object as never)).rejects.toThrow("the HubSpot connector only sends its listed reads");
    }
    await expect(client.listArchived("contacts", { after: "a&archived=false" })).rejects.toThrow("after must be HubSpot's paging token");
    await expect(client.associations("deals", "tickets" as never, ["1"])).rejects.toThrow("doesn't read deals to tickets associations");
    await expect(client.associations("contacts", "companies", ["1"])).rejects.toThrow("doesn't read contacts to companies associations");
    await expect(client.associations("users" as never, "contacts", ["1"])).rejects.toThrow(HubSpotConfigError);
    for (const ids of [[], ["1; DROP"], ["x"], Array.from({ length: 101 }, (_, i) => String(i + 1))]) {
      await expect(client.associations("deals", "contacts", ids)).rejects.toThrow("an association read takes 1 to 100 record ids");
    }
    // Nothing above reached HubSpot, not even the token lookup.
    expect(mock.fetch.calls).toEqual([]);
  });

  it("searches only by last-modified range, oldest first, for its own properties, within the 10,000-result cap", async () => {
    const good = hubSpotSearchBody("deals", { from: SINCE, until: RECEIVED });
    expect(good).toEqual({
      filterGroups: [
        {
          filters: [
            { propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(Date.parse(SINCE)) },
            { propertyName: "hs_lastmodifieddate", operator: "LT", value: String(Date.parse(RECEIVED)) },
          ],
        },
      ],
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
      properties: [...HUBSPOT_PROPERTIES.deals],
      limit: 200,
    });
    expect(checkHubSpotSearchBody("deals", good)).toBe(good);
    expect(hubSpotSearchBody("contacts", { from: SINCE, until: RECEIVED, after: "200" }).filterGroups[0]!.filters[0]!.propertyName).toBe("lastmodifieddate");
    const f = good.filterGroups[0]!.filters;
    const bad: unknown[] = [
      null,
      [],
      { ...good, query: "a" },
      { ...good, extra: 1 },
      { ...good, filterGroups: [] },
      { ...good, filterGroups: [good.filterGroups[0], good.filterGroups[0]] },
      { ...good, filterGroups: [{ filters: f, extra: 1 }] },
      { ...good, filterGroups: [{ filters: [...f, { propertyName: "email", operator: "EQ", value: "a" }] }] },
      { ...good, filterGroups: [{ filters: [f[0]] }] },
      { ...good, filterGroups: [{ filters: [f[1], f[0]] }] },
      { ...good, filterGroups: [{ filters: [{ ...f[0], propertyName: "lastmodifieddate" }, f[1]] }] },
      { ...good, filterGroups: [{ filters: [{ ...f[0], operator: "GT" }, f[1]] }] },
      { ...good, filterGroups: [{ filters: [f[0], { ...f[1], operator: "LTE" }] }] },
      { ...good, filterGroups: [{ filters: [{ ...f[0], value: "2021-01-20" }, f[1]] }] },
      { ...good, filterGroups: [{ filters: [f[0], { ...f[1], value: 5 }] }] },
      { ...good, filterGroups: [{ filters: [{ ...f[0], extra: 1 }, f[1]] }] },
      { ...good, filterGroups: [{ filters: [{ ...f[0], value: f[1]!.value }, f[1]] }] },
      { ...good, sorts: [] },
      { ...good, sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }] },
      { ...good, sorts: [{ propertyName: "amount", direction: "ASCENDING" }] },
      { ...good, sorts: [good.sorts[0], good.sorts[0]] },
      { ...good, sorts: [{ ...good.sorts[0], extra: 1 }] },
      { ...good, properties: [] },
      { ...good, properties: [...good.properties, "description"] },
      { ...good, properties: ["hs_lastmodifieddate", 5] },
      { ...good, properties: "dealname" },
      { ...good, limit: 0 },
      { ...good, limit: 201 },
      { ...good, limit: 1.5 },
      { ...good, after: 200 },
      { ...good, after: "-1" },
      { ...good, after: "10000" },
      { ...good, after: "9900" },
    ];
    for (const body of bad) expect(() => checkHubSpotSearchBody("deals", body)).toThrow(/^the HubSpot connector only searches by last-modified time/);
    for (const property of ["email", "phone", "address", "mobilephone"]) {
      expect(() => checkHubSpotSearchBody("contacts", { ...hubSpotSearchBody("contacts", { from: SINCE, until: RECEIVED }), properties: ["firstname", property] })).toThrow(HubSpotConfigError);
    }
    expect(() => checkHubSpotSearchBody("contacts", { ...good, properties: ["firstname"] })).toThrow("(LT on lastmodifieddate)".replace("LT", "GTE"));
    expect(() => checkHubSpotSearchBody("deals", { ...good, after: "9800" })).not.toThrow();
    // The client refuses an unchecked body before it sends anything.
    const mock = hubSpotDocMock(account());
    const client = hubSpotClient(options(mock));
    for (const body of bad.slice(2)) await expect(client.search("deals", body as HubSpotSearchBody)).rejects.toThrow(HubSpotConfigError);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("asks only for properties free of personal details, and never for bodies, notes or recordings", () => {
    const all = Object.values(HUBSPOT_PROPERTIES).flat();
    for (const p of all) expect(p).not.toMatch(/email|phone|address|street|city|zip|body|note|recording|description|content|subject|title|text|html/);
    expect(Object.keys(HUBSPOT_PROPERTIES)).toEqual([...HUBSPOT_OBJECTS]);
  });

  it("sends the token in the Authorization header only, and to the token lookup as its documented tokenKey", async () => {
    const mock = hubSpotDocMock(account());
    const { sent, fetch } = recording(mock);
    await sync(mock, "historical", { fetch });
    expect(sent.length).toBeGreaterThan(20);
    for (const s of sent) {
      expect(s.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(s.url).not.toContain(TOKEN);
      expect(s.url.startsWith(`${HUBSPOT_API_URL}/`)).toBe(true);
      for (const [name, value] of s.headers) if (name !== "authorization") expect(value).not.toContain(TOKEN);
      if (path(s.url) === HUBSPOT_TOKEN_INFO_PATH) expect(JSON.parse(s.body)).toEqual({ tokenKey: TOKEN });
      else expect(s.body).not.toContain(TOKEN);
    }
    // The token is looked up once per client, before any read.
    expect(sent.filter((s) => path(s.url) === HUBSPOT_TOKEN_INFO_PATH)).toHaveLength(1);
    expect(path(sent[0]!.url)).toBe(HUBSPOT_TOKEN_INFO_PATH);
    expect(new Set(sent.map((s) => `${s.method} ${hubSpotRequestKind(s.method, s.url)}`))).toEqual(new Set(["POST token_info", "POST search", "GET list", "POST associations"]));
  });

  it("refuses a token holding any scope beyond reading, before reading anything", async () => {
    for (const extra of ["crm.objects.contacts.write", "crm.objects.deals.write", "tickets", "e-commerce", "crm.objects.contacts.sensitive.write", "automation", "crm.import", "crm.objects.contacts.read.write"]) {
      const mock = hubSpotDocMock(account({ scopes: [...HUBSPOT_MOCK_READ_SCOPES, extra] }));
      const error = await failure(hubSpotClient(options(mock)).search("contacts", hubSpotSearchBody("contacts", { from: SINCE, until: RECEIVED })));
      expect(error).toBeInstanceOf(HubSpotConfigError);
      expect(error.message).toBe(`the HubSpot token can change data (${extra}); give the private app only ${HUBSPOT_READ_SCOPES.join(" ")}`);
      expect(reads(mock)).toEqual([`POST ${HUBSPOT_TOKEN_INFO_PATH}`]);
    }
    // Every kind of read waits for the check, whichever comes first.
    for (const read of [(c: ReturnType<typeof hubSpotClient>) => c.listArchived("contacts"), (c: ReturnType<typeof hubSpotClient>) => c.associations("deals", "contacts", ["3001"])]) {
      const mock = hubSpotDocMock(account({ scopes: [...HUBSPOT_MOCK_READ_SCOPES, "crm.objects.contacts.write"] }));
      await expect(read(hubSpotClient(options(mock)))).rejects.toThrow("the HubSpot token can change data (crm.objects.contacts.write)");
      expect(reads(mock)).toEqual([`POST ${HUBSPOT_TOKEN_INFO_PATH}`]);
    }
    const missing = hubSpotDocMock(account({ scopes: ["crm.objects.contacts.read", "crm.objects.deals.read"] }));
    await expect(hubSpotClient(options(missing)).tokenInfo()).rejects.toThrow("the HubSpot token is missing crm.objects.companies.read, crm.objects.tickets.read");
    expect(await hubSpotClient(options(hubSpotDocMock(account()))).tokenInfo()).toEqual({ hubId: HUBSPOT_TEST_HUB_ID, scopes: HUBSPOT_MOCK_READ_SCOPES });
    const extraRead = hubSpotDocMock(account({ scopes: [...HUBSPOT_MOCK_READ_SCOPES, "sales-email-read", "oauth", "crm.schemas.deals.read"] }));
    await expect(hubSpotClient(options(extraRead)).tokenInfo()).resolves.toMatchObject({ hubId: HUBSPOT_TEST_HUB_ID });
  });

  it("refuses a token whose scopes it can't read, and looks again after a failed lookup", async () => {
    let answer: unknown = { hubId: "x", scopes: "crm.objects.contacts.read" };
    let lookups = 0;
    const fetch: typeof globalThis.fetch = async () => {
      lookups++;
      return new Response(JSON.stringify(answer), { status: 200 });
    };
    const client = hubSpotClient({ accessToken: TOKEN, fetch, sleep: async () => {} });
    await expect(client.tokenInfo()).rejects.toThrow("HubSpot didn't say which scopes the token holds");
    answer = { scopes: [...HUBSPOT_MOCK_READ_SCOPES, 5] };
    await expect(client.tokenInfo()).rejects.toThrow("the HubSpot token can change data (unreadable scopes)");
    answer = { scopes: HUBSPOT_MOCK_READ_SCOPES };
    await expect(client.tokenInfo()).resolves.toEqual({ hubId: undefined, scopes: HUBSPOT_MOCK_READ_SCOPES });
    await client.tokenInfo();
    expect(lookups).toBe(3);
  });

  it("tells read scopes from write ones", () => {
    expect(hubSpotWriteScopes([...HUBSPOT_READ_SCOPES, "sales-email-read", "oauth", "crm.objects.owners.read", "crm.schemas.contacts.read", "crm.lists.read"])).toEqual([]);
    expect(hubSpotWriteScopes(["tickets", "crm.objects.contacts.write", "content", "forms", "crm.objects.read.write", "crm.objects.deals.readx", "read", ".read", "crm..read", "CRM.OBJECTS.CONTACTS.READ", "oauth.write"])).toEqual([
      "tickets",
      "crm.objects.contacts.write",
      "content",
      "forms",
      "crm.objects.read.write",
      "crm.objects.deals.readx",
      "read",
      ".read",
      "crm..read",
      "CRM.OBJECTS.CONTACTS.READ",
      "oauth.write",
    ]);
    expect(HUBSPOT_MOCK_READ_SCOPES).toEqual([...HUBSPOT_READ_SCOPES]);
  });

  it("waits out HubSpot's 10-second and search limits and 5xx errors, and stops at the daily limit", async () => {
    const body = hubSpotSearchBody("contacts", { from: SINCE, until: RECEIVED });
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const limited = hubSpotDocMock(account({ rateLimits: [{ policy: "TEN_SECONDLY_ROLLING" }, { policy: "SEARCH" }, { policy: "TEN_SECONDLY_ROLLING", retryAfter: 60 }] }));
    const client = hubSpotClient({ ...options(limited), sleep, clock: () => 0 });
    await client.tokenInfo();
    await expect(client.search("contacts", body)).resolves.toMatchObject({ total: 3 });
    // Backoff 1s, 2s, then Retry-After capped at 10s; searches are also spaced 200 ms apart.
    expect(waits.filter((w) => w !== 200)).toEqual([1000, 2000, 10_000]);
    expect(waits.filter((w) => w === 200).length).toBeGreaterThanOrEqual(3);

    const daily = hubSpotDocMock(account({ rateLimits: [{ policy: "DAILY" }] }));
    const stopped = await failure(hubSpotClient(options(daily)).search("contacts", body));
    expect(stopped).toMatchObject({ name: "HubSpotApiError", status: 429, policy: "DAILY" });
    expect(stopped.message).toBe("HubSpot's daily API limit for this account is used up; the next sync resumes from the checkpoint");
    expect(reads(daily).filter((r) => r.endsWith("/search"))).toHaveLength(1);

    const always = hubSpotDocMock(account({ rateLimits: Array.from({ length: 5 }, () => ({ policy: "TEN_SECONDLY_ROLLING" as const })) }));
    await expect(hubSpotClient({ ...options(always), rateLimitRetries: 2 }).listArchived("contacts")).rejects.toThrow("HubSpot kept answering HTTP 429 (TEN_SECONDLY_ROLLING)");

    let calls = 0;
    const flaky: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input as string, init);
      if (path(request.url) !== HUBSPOT_TOKEN_INFO_PATH && ++calls === 1) return new Response("<html>bad gateway</html>", { status: 502 });
      return limited.fetch(request);
    };
    await expect(hubSpotClient(options(limited, { fetch: flaky })).listArchived("contacts")).resolves.toMatchObject({ results: [expect.anything()] });
    const down: typeof globalThis.fetch = async () => new Response("", { status: 503 });
    await expect(hubSpotClient(options(limited, { fetch: down })).tokenInfo()).rejects.toThrow("HubSpot kept answering HTTP 503");
  });

  it("spaces searches 200 ms apart, as search allows five a second", async () => {
    const mock = hubSpotDocMock(account());
    const waits: number[] = [];
    let t = 1_000_000;
    const client = hubSpotClient({ ...options(mock), clock: () => t, sleep: async (ms) => void waits.push(ms) });
    const body = hubSpotSearchBody("contacts", { from: SINCE, until: RECEIVED });
    await client.search("contacts", body);
    await client.search("contacts", body);
    t += 50;
    await client.search("contacts", body);
    t += 1000;
    await client.search("contacts", body);
    expect(waits).toEqual([200, 150]);
  });

  it("explains errors an owner can fix, without echoing the token", async () => {
    const wrong = hubSpotDocMock(account({ accessToken: TOKEN.replace(/0$/, "1") }));
    const error = await failure(hubSpotClient(options(wrong)).tokenInfo());
    expect(error).toBeInstanceOf(HubSpotApiError);
    expect(error.message).toBe(
      "HubSpot answered HTTP 401 to a token_info read (INVALID_AUTHENTICATION: Authentication credentials not found.); check HUBSPOT_ACCESS_TOKEN, which may have been rotated or revoked",
    );
    expect(error.message).not.toContain(TOKEN);
    const answer = (status: number, body: unknown): typeof globalThis.fetch => async (input, init) =>
      path(new Request(input as string, init).url) === HUBSPOT_TOKEN_INFO_PATH ? new Response(JSON.stringify({ scopes: HUBSPOT_MOCK_READ_SCOPES })) : new Response(JSON.stringify(body), { status });
    const client = (status: number, body: unknown) => hubSpotClient({ accessToken: TOKEN, fetch: answer(status, body), sleep: async () => {} });
    await expect(client(403, { message: "This app hasn't been granted all required scopes" }).listArchived("deals")).rejects.toThrow(
      `HubSpot answered HTTP 403 to a list read: This app hasn't been granted all required scopes; the token needs ${HUBSPOT_READ_SCOPES.join(", ")}`,
    );
    await expect(client(400, {}).listArchived("deals")).rejects.toThrow(/^HubSpot answered HTTP 400 to a list read$/);
    await expect(client(200, [1]).listArchived("deals")).rejects.toThrow("HubSpot did not answer with JSON");
  });
});

describe("HubSpot normalization", () => {
  const raw = account();
  const links = { contacts: { "3001": ["1001", "1001", "x"], "5001": ["1001"] }, companies: { "3001": ["2001"] }, deals: { "5001": ["3001"] } };
  const events = (object: (typeof HUBSPOT_OBJECTS)[number], r: HubSpotMockRecord) => hubSpotEvents(object, r, links, RECEIVED);

  it("makes contacts clienteling profiles with a display name only and marketing consent off", () => {
    const contact = raw.records.contacts![0]!;
    expect(events("contacts", contact)).toEqual([
      {
        id: `hubspot_contact:1001:${Date.parse(contact.updatedAt)}`,
        type: "customer.profile_updated",
        occurredAt: contact.properties.lastmodifieddate,
        receivedAt: RECEIVED,
        idempotencyKey: `hubspot:contact:1001:${Date.parse(contact.updatedAt)}`,
        payload: { customerId: "hubspot:contact:1001", name: "Test Customer 1", marketingConsent: false },
      },
    ]);
    const unnamed = { ...contact, properties: { ...contact.properties, firstname: " ", lastname: null } };
    expect(events("contacts", unnamed)[0]!.payload.name).toBe("HubSpot contact 1001");
    expect(events("contacts", { ...contact, properties: { ...contact.properties, firstname: null } })[0]!.payload.name).toBe("Customer 1");
  });

  it("keeps deals' stage, pipeline, amount in cents, close date and links, and tickets' status, priority and pipeline", () => {
    expect(events("deals", raw.records.deals![0]!)[0]).toMatchObject({
      type: "crm.deal_updated",
      payload: {
        dealId: "hubspot:deal:3001",
        name: "Test engagement ring 1",
        pipeline: "default",
        stage: "appointmentscheduled",
        amountCents: 125050,
        currency: "USD",
        closeDate: "2026-02-14",
        contactIds: ["hubspot:contact:1001"],
        companyIds: ["hubspot:company:2001"],
      },
    });
    expect(Object.keys(events("deals", raw.records.deals![0]!)[0]!.payload).sort()).toEqual(["amountCents", "closeDate", "companyIds", "contactIds", "currency", "dealId", "name", "pipeline", "stage"]);
    const bare = { ...raw.records.deals![1]!, properties: { hs_lastmodifieddate: raw.records.deals![1]!.updatedAt, amount: "about 5" } };
    expect(events("deals", bare)[0]!.payload).toEqual({ dealId: "hubspot:deal:3002", name: "HubSpot deal 3002", amountCents: null, contactIds: [], companyIds: [] });
    expect(events("tickets", raw.records.tickets![0]!)[0]).toMatchObject({
      type: "crm.ticket_updated",
      payload: { ticketId: "hubspot:ticket:4001", pipeline: "0", status: "1", priority: "high", contactIds: [], companyIds: [] },
    });
    expect(Object.keys(events("tickets", raw.records.tickets![0]!)[0]!.payload).sort()).toEqual(["companyIds", "contactIds", "pipeline", "priority", "status", "ticketId"]);
    expect(events("companies", raw.records.companies![0]!)[0]).toMatchObject({ type: "crm.company_updated", payload: { companyId: "hubspot:company:2001", name: "Test Company 1" } });
    expect(Object.keys(events("companies", raw.records.companies![0]!)[0]!.payload)).toEqual(["companyId", "name"]);
  });

  it("keeps an engagement's kind, time and links, never what was said", () => {
    const call = raw.records.calls![0]!;
    expect(events("calls", call)[0]).toEqual({
      id: `hubspot_call:5001:${Date.parse(call.updatedAt)}`,
      type: "crm.engagement_logged",
      occurredAt: call.updatedAt,
      receivedAt: RECEIVED,
      idempotencyKey: `hubspot:call:5001:${Date.parse(call.updatedAt)}`,
      payload: { engagementId: "hubspot:call:5001", kind: "call", at: call.properties.hs_timestamp, contactIds: ["hubspot:contact:1001"], dealIds: ["hubspot:deal:3001"] },
    });
    const task = raw.records.tasks![0]!;
    expect(events("tasks", task)[0]!.payload).toEqual({ engagementId: "hubspot:task:9001", kind: "task", at: new Date(Number(task.properties.hs_timestamp)).toISOString(), contactIds: [], dealIds: [] });
    for (const object of ["emails", "meetings", "notes"] as const) {
      expect(Object.keys(events(object, raw.records[object]![0]!)[0]!.payload).sort()).toEqual(["at", "contactIds", "dealIds", "engagementId", "kind"]);
    }
  });

  it("drops every email, phone, address, note, body and recording HubSpot sends, whatever was asked for", () => {
    const all = HUBSPOT_OBJECTS.flatMap((object) => hubSpotPageEvents(object, raw.records[object], links, RECEIVED));
    expect(all).toHaveLength(HUBSPOT_OBJECTS.reduce((n, o) => n + raw.records[o]!.length, 0));
    const text = JSON.stringify(all);
    for (const leak of ["@", "555", "Street", "Testville", "Synthetic", "recordings", "Legitimate", "<p>", "Test repair", "Test call", "Test email", "Test meeting", "Test task", "example.test"]) {
      expect([leak, text.includes(leak)]).toEqual([leak, false]);
    }
  });

  it("keys each version by object, id and last-modified time, and a deletion by when it was archived", () => {
    const contact = raw.records.contacts![0]!;
    const later = { ...contact, properties: { ...contact.properties, lastmodifieddate: "2026-01-19T00:00:00.000Z" } };
    expect(events("contacts", contact)[0]!.idempotencyKey).toBe(events("contacts", { ...contact, properties: { ...contact.properties, firstname: "Renamed" } })[0]!.idempotencyKey);
    expect(events("contacts", later)[0]!.idempotencyKey).toBe(`hubspot:contact:1001:${Date.parse("2026-01-19T00:00:00.000Z")}`);
    // The same id in two objects is two records.
    expect(events("deals", { ...raw.records.deals![0]!, id: "1001" })[0]!.idempotencyKey).toMatch(/^hubspot:deal:1001:/);
    const archived = hubSpotArchived(contact, "2026-01-19T12:00:00.000Z");
    expect(hubSpotDeletionEvents("contacts", [archived, { id: "../1" }, null, { id: 2001, updatedAt: "2026-01-18T00:00:00Z" }, { id: "2002" }], RECEIVED)).toEqual([
      {
        id: `hubspot_contact:1001:deleted:${Date.parse("2026-01-19T12:00:00.000Z")}`,
        type: "crm.record_deleted",
        occurredAt: "2026-01-19T12:00:00.000Z",
        receivedAt: RECEIVED,
        idempotencyKey: `hubspot:contact:1001:deleted:${Date.parse("2026-01-19T12:00:00.000Z")}`,
        payload: { recordId: "hubspot:contact:1001", entity: "contact" },
      },
      expect.objectContaining({ idempotencyKey: `hubspot:contact:2001:deleted:${Date.parse("2026-01-18T00:00:00Z")}`, occurredAt: "2026-01-18T00:00:00.000Z" }),
      expect.objectContaining({ idempotencyKey: "hubspot:contact:2002:deleted:0", occurredAt: undefined }),
    ]);
    expect(hubSpotDeletionEvents("contacts", "nope", RECEIVED)).toEqual([]);
  });

  it("drops records with no usable id, and leaves a record with no readable time to be dead-lettered", () => {
    const contact = raw.records.contacts![0]!;
    expect(events("contacts", { ...contact, id: "abc" } as HubSpotMockRecord)).toEqual([]);
    expect(hubSpotEvents("contacts", null as never, {}, RECEIVED)).toEqual([]);
    expect(hubSpotEvents("contacts", { id: 1001, properties: { firstname: "A" } }, {}, RECEIVED)).toEqual([
      expect.objectContaining({ occurredAt: undefined, idempotencyKey: "hubspot:contact:1001:0" }),
    ]);
    expect(hubSpotEvents("contacts", { id: "1001", updatedAt: "2026-01-02T00:00:00Z" }, {}, RECEIVED)[0]).toMatchObject({ occurredAt: "2026-01-02T00:00:00.000Z", payload: { name: "HubSpot contact 1001" } });
    expect(hubSpotPageEvents("contacts", { results: [] }, {}, RECEIVED)).toEqual([]);
  });

  it("reads HubSpot's ISO and millisecond times, and amounts as whole cents", () => {
    expect(hubSpotTime("2026-01-02T03:04:05.678Z")).toBe("2026-01-02T03:04:05.678Z");
    expect(hubSpotTime("2026-01-02T03:04:05+02:00")).toBe("2026-01-02T01:04:05.000Z");
    expect(hubSpotTime("1767225600000")).toBe("2026-01-01T00:00:00.000Z");
    expect(hubSpotTime(1767225600000)).toBe("2026-01-01T00:00:00.000Z");
    for (const bad of ["", "2026-01-02", "yesterday", "2026-01-02T03:04:05", null, undefined, Number.NaN, {}]) expect(hubSpotTime(bad)).toBeUndefined();
    expect([hubSpotCents("1250.50"), hubSpotCents("1250.505"), hubSpotCents(" 99 "), hubSpotCents(12.3), hubSpotCents("-5.25")]).toEqual([125050, 125051, 9900, 1230, -525]);
    for (const bad of ["", "1,250.00", "$5", "1e3", null, Number.POSITIVE_INFINITY, "5."]) expect(hubSpotCents(bad)).toBeNull();
  });

  it("caps linked ids so one busy record can't make an event huge", () => {
    const many = Array.from({ length: 150 }, (_, i) => String(i + 1));
    expect((hubSpotEvents("deals", raw.records.deals![0]!, { contacts: { "3001": many } }, RECEIVED)[0]!.payload.contactIds as string[]).length).toBe(100);
  });

  it("uses synthetic fixtures only", () => {
    const { records, associations } = account();
    expect(() => assertSynthetic({ records, associations })).not.toThrow();
    expect(hubSpotMs("2026-01-01T00:00:00Z")).toMatch(/^\d{13}$/);
  });
});

describe("HubSpot sync", () => {
  it("imports, replays, resumes and retries the mocked account", async () => {
    // 2 companies, 3 contacts, 2 deals, a ticket, 5 engagements and the archived contact as a deletion.
    const result = await checkConnectorSync({ makeConnector: () => connector(hubSpotDocMock(account())), expected: { ingested: 14 } });
    // Two steps per object: changes, then archived records.
    expect(result.full.batches).toBe(18);
    expect(parseHubSpotCursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done", since: SINCE, until: RECEIVED });
  });

  it("reads each object's changes five years back, oldest first, then its archived records, with associations", async () => {
    const mock = hubSpotDocMock(account());
    const { sent, fetch } = recording(mock);
    const { report } = await sync(mock, "historical", { fetch });
    expect(report).toMatchObject({ ingested: 14, deadLettered: 0, duplicates: 0 });
    const steps = HUBSPOT_OBJECTS.flatMap((o) => [
      `POST /crm/objects/${V}/${o}/search`,
      ...({ deals: ["contacts", "companies"], tickets: ["contacts", "companies"] }[o as "deals"] ?? (["companies", "contacts"].includes(o) ? [] : ["contacts", "deals"])).map((to) => `POST /crm/associations/${V}/${o}/${to}/batch/read`),
      `GET /crm/objects/${V}/${o}`,
    ]);
    expect(reads(mock)).toEqual([`POST ${HUBSPOT_TOKEN_INFO_PATH}`, ...steps]);
    for (const s of mock.searches) expect(filterValues(s.body)).toEqual([Date.parse(SINCE), Date.parse(RECEIVED)]);
    const archived = sent.filter((s) => s.method === "GET").map((s) => new URL(s.url).searchParams);
    expect(archived.map((q) => [q.get("archived"), q.get("limit")])).toEqual(HUBSPOT_OBJECTS.map(() => ["true", "100"]));
    expect(archived[1]!.get("properties")).toBe("firstname,lastname,lastmodifieddate");
    const assoc = sent.filter((s) => s.url.includes("/batch/read")).map((s) => JSON.parse(s.body));
    expect(assoc[0]).toEqual({ inputs: [{ id: "3001" }, { id: "3002" }] });
  });

  it("pages by moving each new query to the last time read, never re-reading or skipping a record", async () => {
    // 450 contacts a minute apart: three queries, none with an offset.
    const mock = hubSpotDocMock(only({ contacts: contactsAt(450, (i) => iso(Date.parse("2025-06-01T00:00:00Z") + i * 60_000)) }));
    const { report, memory } = await sync(mock);
    expect(report).toMatchObject({ ingested: 450, duplicates: 0 });
    expect(new Set(memory.events.map((e) => e.idempotencyKey)).size).toBe(450);
    const contacts = mock.searches.filter((s) => s.object === "contacts");
    expect(contacts.map((s) => [filterValues(s.body)[0], s.body.after])).toEqual([
      [Date.parse(SINCE), undefined],
      [Date.parse("2025-06-01T00:00:00Z") + 199 * 60_000, undefined],
      [Date.parse("2025-06-01T00:00:00Z") + 398 * 60_000, undefined],
    ]);
  });

  it("skips what it already read at a page's last time, even when that time spans the page boundary", async () => {
    // Records 195 to 205 share one time, across the first page's end.
    const base = Date.parse("2025-06-01T00:00:00Z");
    const mock = hubSpotDocMock(only({ contacts: contactsAt(260, (i) => iso(base + Math.min(Math.max(i, 195), 205) * 1000 + (i > 205 ? i : 0))) }));
    const { report, memory } = await sync(mock);
    expect(report).toMatchObject({ ingested: 260, duplicates: 0 });
    expect(new Set(memory.events.map((e) => e.payload.customerId)).size).toBe(260);
  });

  it("pages a page-long tie with HubSpot's offset, then moves on", async () => {
    const tie = "2025-06-01T00:00:00.000Z";
    const mock = hubSpotDocMock(only({ contacts: [...contactsAt(450, () => tie), ...contactsAt(2, (i) => iso(Date.parse(tie) + 1000 + i)).map((c, i) => ({ ...c, id: String(9500 + i) }))] }));
    const { report } = await sync(mock);
    expect(report).toMatchObject({ ingested: 452, duplicates: 0 });
    expect(mock.searches.filter((s) => s.object === "contacts").map((s) => [s.body.after, filterValues(s.body)[0]])).toEqual([
      [undefined, Date.parse(SINCE)],
      // The first page was all the tie: a new query from it skips those 200, then pages on with the offset.
      [undefined, Date.parse(tie)],
      ["200", Date.parse(tie)],
      ["400", Date.parse(tie)],
    ]);
  });

  it("reads more than search's 10,000-result cap without paging any query past it", async () => {
    const base = Date.parse("2024-01-01T00:00:00Z");
    const mock = hubSpotDocMock(only({ contacts: contactsAt(10_250, (i) => iso(base + i * 1000)) }));
    const { report } = await sync(mock);
    expect(report).toMatchObject({ ingested: 10_250, duplicates: 0, deadLettered: 0 });
    expect(mock.searches.every((s) => s.body.after === undefined)).toBe(true);
  }, 60_000);

  it("stops with a clear error rather than page past the cap when more than 10,000 records share one millisecond", async () => {
    const mock = hubSpotDocMock(only({ contacts: contactsAt(1_000, () => "2025-06-01T00:00:00.000Z") }));
    const tight = hubSpotDocMock({ ...only({ contacts: contactsAt(1_000, () => "2025-06-01T00:00:00.000Z") }), searchCap: 600 });
    await expect(sync(mock)).resolves.toMatchObject({ report: { ingested: 1_000 } });
    // A mock with a lower cap shows the real cap is the one HubSpot enforces: the client stops before HubSpot would refuse.
    const error = await failure(sync(tight));
    expect(error).toBeInstanceOf(HubSpotApiError);
    expect(error.message).toContain("Search can't page beyond 600 results");
    const cursor: HubSpotCursor = { pass: "historical", step: "contacts", phase: "changes", from: SINCE, seen: [], after: "9900", until: RECEIVED, since: SINCE, nextFrom: RECEIVED };
    const batches = connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(cursor) })[Symbol.asyncIterator]();
    await expect(batches.next()).rejects.toThrow("an offset within the first 10000 results");
  });

  it("reads archived records as deletions, paging the list, and only those archived since the pass's start", async () => {
    const data = only({
      deals: [
        ...hubSpotDeal.many(150).map((d, i) => hubSpotArchived(d, iso(Date.parse("2026-01-19T00:00:00Z") + i * 1000))),
        hubSpotArchived(hubSpotDeal.one(), "2026-01-10T00:00:00.000Z"),
      ],
    });
    const mock = hubSpotDocMock(data);
    const previous: HubSpotCursor = { pass: "incremental", step: "done", phase: "archived", from: "2026-01-18T00:00:00.000Z", seen: [], after: null, until: "2026-01-18T00:10:00.000Z", since: "2026-01-18T00:00:00.000Z", nextFrom: "2026-01-18T00:00:00.000Z" };
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "hubspot", "incremental", JSON.stringify(previous));
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 150 });
    expect(new Set(memory.events.map((e) => e.type))).toEqual(new Set(["crm.record_deleted"]));
    expect(reads(mock).filter((r) => r === `GET /crm/objects/${V}/deals`)).toHaveLength(2);
    expect(mock.fetch.calls.filter((c) => c.url.includes("/deals?")).map((c) => new URL(c.url).searchParams.get("after"))).toEqual([null, "100"]);
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(hubSpotDocMock(account())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 14, deadLettered: 0 });
    const types = memory.events.map((e) => e.type);
    expect(types.filter((t) => t === "customer.profile_updated")).toHaveLength(3);
    expect(new Set(types)).toEqual(new Set(["crm.company_updated", "customer.profile_updated", "crm.record_deleted", "crm.deal_updated", "crm.ticket_updated", "crm.engagement_logged"]));
    expect(memory.events.every((e) => e.source === "hubspot")).toBe(true);
  });

  it("leaves a finished import finished", async () => {
    const done: HubSpotCursor = { pass: "historical", step: "done", phase: "changes", from: SINCE, seen: [], after: null, until: RECEIVED, since: SINCE, nextFrom: "2026-01-19T23:50:00.000Z" };
    const mock = hubSpotDocMock(account());
    const batches = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })) batches.push(b);
    expect(batches).toEqual([]);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("reads changes since the previous pass started less the overlap, and looks back 48 hours without a checkpoint", async () => {
    const data = account();
    data.records.deals![1] = { ...data.records.deals![1]!, properties: { ...data.records.deals![1]!.properties, hs_lastmodifieddate: "2026-01-19T10:00:00.000Z" } };
    const mock = hubSpotDocMock(data);
    const previous: HubSpotCursor = { pass: "incremental", step: "done", phase: "archived", from: "2026-01-18T00:00:00.000Z", seen: [], after: null, until: "2026-01-19T00:10:00.000Z", since: "2026-01-18T00:00:00.000Z", nextFrom: "2026-01-19T00:00:00.000Z" };
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "hubspot", "incremental", JSON.stringify(previous));
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 2, duplicates: 0, batches: 18 });
    expect(memory.events.map((e) => e.type).sort()).toEqual(["crm.deal_updated", "crm.record_deleted"]);
    for (const s of mock.searches) expect(filterValues(s.body)).toEqual([Date.parse("2026-01-19T00:00:00.000Z"), Date.parse(RECEIVED)]);
    expect(parseHubSpotCursor(report.cursor)).toEqual({ pass: "incremental", step: "done", phase: "changes", from: "2026-01-19T00:00:00.000Z", seen: [], after: null, until: RECEIVED, since: "2026-01-19T00:00:00.000Z", nextFrom: "2026-01-19T23:50:00.000Z" });
    expect(HUBSPOT_OVERLAP_MS).toBe(10 * 60_000);

    const fresh = hubSpotDocMock(account());
    await sync(fresh, "incremental");
    expect(new Set(fresh.searches.map((s) => filterValues(s.body)[0]))).toEqual(new Set([Date.parse("2026-01-18T00:00:00.000Z")]));
  });

  it("catches a change saved just before a pass started that search only showed afterwards", async () => {
    const data = only({ contacts: [] });
    const mock = hubSpotDocMock(data);
    const { memory, pipeline } = testPipeline();
    const run = (now: string) => runSync({ connector: connector(mock, { now: () => new Date(now) }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    await run("2026-01-20T00:00:00Z");
    // Saved four minutes before the first pass started, but only indexed for search after it ran.
    hubSpotContact.reset();
    data.records.contacts!.push({ ...hubSpotContact.one(), properties: { firstname: "Late", lastname: "Index", lastmodifieddate: "2026-01-19T23:56:00.000Z" }, updatedAt: "2026-01-19T23:56:00.000Z" });
    const second = await run("2026-01-20T01:00:00Z");
    expect(second.ingested).toBe(1);
  });

  it("resumes an interrupted pass at the query and object it stopped on", async () => {
    const mock = hubSpotDocMock(account());
    const stopped: HubSpotCursor = { pass: "incremental", step: "tasks", phase: "changes", from: "2026-01-01T00:00:00.000Z", seen: ["9001"], after: null, until: RECEIVED, since: "2025-12-01T00:00:00.000Z", nextFrom: "2026-01-19T23:00:00.000Z" };
    const batches = [];
    for await (const b of connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(stopped) })) batches.push(b);
    expect(reads(mock)).toEqual([
      `POST ${HUBSPOT_TOKEN_INFO_PATH}`,
      `POST /crm/objects/${V}/tasks/search`,
      `POST /crm/associations/${V}/tasks/contacts/batch/read`,
      `POST /crm/associations/${V}/tasks/deals/batch/read`,
      `GET /crm/objects/${V}/tasks`,
    ]);
    // The task read before the interruption, at exactly `from`, isn't read again; here it was changed later, so it is.
    expect(batches.map((b) => b.events.length)).toEqual([1, 0]);
    expect(parseHubSpotCursor(batches.at(-1)!.cursor)).toMatchObject({ step: "done", nextFrom: "2026-01-19T23:00:00.000Z" });
    const atFrom = account();
    const task = atFrom.records.tasks![0]!;
    const resumed = { ...stopped, from: task.updatedAt };
    const again = hubSpotDocMock(atFrom);
    const first = await connector(again).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(resumed) })[Symbol.asyncIterator]().next();
    expect((first.value as { events: unknown[] }).events).toEqual([]);
  });

  it("stops at HubSpot's daily limit with the checkpoint where it was, and carries on from there", async () => {
    const mock = hubSpotDocMock(account());
    const { memory, pipeline } = testPipeline();
    let calls = 0;
    let limited = true;
    const daily = () => new Response(JSON.stringify({ status: "error", errorType: "RATE_LIMIT", policyName: "DAILY", message: "You have reached your daily limit." }), { status: 429 });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input as string, init);
      if (path(request.url).endsWith("/search") && ++calls >= 3 && limited) return daily();
      return mock.fetch(request);
    };
    const stopped = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: async () => {} }).catch((e: unknown) => e);
    expect(stopped).toMatchObject({ name: "HubSpotApiError", policy: "DAILY" });
    expect(parseHubSpotCursor(await memory.getCheckpoint(TEST_ORG, "hubspot", "historical"))).toMatchObject({ step: "deals", phase: "changes" });
    limited = false;
    const resumed = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // Deals onwards: 2 deals, a ticket and 5 engagements.
    expect(resumed).toMatchObject({ duplicates: 0, ingested: 8 });
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: HubSpotCursor = { pass: "incremental", step: "deals", phase: "changes", from: "2026-01-19T00:00:00.000Z", seen: ["3001"], after: "200", until: RECEIVED, since: "2026-01-18T00:00:00.000Z", nextFrom: "2026-01-19T23:50:00.000Z" };
    expect(parseHubSpotCursor(JSON.stringify(good))).toEqual(good);
    expect(parseHubSpotCursor(JSON.stringify({ ...good, phase: "archived", after: "NTI1Cg==" }))).toMatchObject({ after: "NTI1Cg==" });
    expect(parseHubSpotCursor(null)).toBeNull();
    for (const bad of [
      { ...good, pass: "full" },
      { ...good, step: "users" },
      { ...good, phase: "both" },
      { ...good, from: "2026-01-19" },
      { ...good, until: "2026-13-45T00:00:00.000Z" },
      { ...good, since: "2026-01-18T00:00:00Z" },
      { ...good, nextFrom: 5 },
      { ...good, from: "2026-01-17T00:00:00.000Z" },
      { ...good, from: "2026-01-21T00:00:00.000Z" },
      { ...good, seen: "3001" },
      { ...good, seen: ["3001; x"] },
      { ...good, seen: [3001] },
      { ...good, seen: Array.from({ length: 201 }, (_, i) => String(i)) },
      { ...good, after: "NTI1Cg==" },
      { ...good, after: 200 },
      { ...good, after: "" },
      { ...good, phase: "archived", after: "a&b" },
      { ...good, extra: 1 },
      (({ seen, ...rest }) => rest)(good),
      null,
      [],
    ]) {
      expect(() => parseHubSpotCursor(JSON.stringify(bad))).toThrow("HubSpot checkpoint is not in the expected shape");
    }
  });

  it("reads associations 100 ids at a time", async () => {
    hubSpotDeal.reset();
    const deals = hubSpotDeal.many(150);
    const mock = hubSpotDocMock({ ...only({ deals }), associations: { "deals:contacts": { "3150": ["1001"] } } });
    const { sent, fetch } = recording(mock);
    const { memory } = await sync(mock, "historical", { fetch });
    const inputs = sent.filter((s) => s.url.includes("/deals/contacts/batch/read")).map((s) => (JSON.parse(s.body) as { inputs: unknown[] }).inputs.length);
    expect(inputs).toEqual([100, 50]);
    expect(memory.events.find((e) => e.payload.dealId === "hubspot:deal:3150")!.payload.contactIds).toEqual(["hubspot:contact:1001"]);
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const c = connector(hubSpotDocMock(account()));
    expect(c.writes).toBe(HUBSPOT_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.action, a.outcome])).toEqual([
      ["update_contact", "refused"],
      ["update_deal", "refused"],
      ["log_activity", "refused"],
    ]);
  });
});

describe("HubSpot webhooks", () => {
  const SECRET = ["client", "secret", "0".repeat(32)].join("-");
  const URI = "https://instance.example.test/webhooks/hubspot";
  const AT = Date.parse("2026-01-20T00:00:00Z");
  const body = JSON.stringify([
    { eventId: 1, subscriptionId: 11, portalId: HUBSPOT_TEST_HUB_ID, appId: 1, occurredAt: AT - 1000, subscriptionType: "contact.propertyChange", attemptNumber: 0, objectId: 1001, propertyName: "email", propertyValue: "customer1@example.test", changeSource: "CRM" },
    { eventId: 2, portalId: HUBSPOT_TEST_HUB_ID, occurredAt: AT, subscriptionType: "deal.creation", objectId: 3001 },
    { eventId: 3, portalId: HUBSPOT_TEST_HUB_ID, eventType: "ticket.deletion", objectId: 4001 },
    { eventId: 4, portalId: 12345, subscriptionType: "contact.creation", objectId: 1002 },
    { eventId: 5, portalId: HUBSPOT_TEST_HUB_ID, subscriptionType: "contact.unknownChange", objectId: 1003 },
    { eventId: 6, portalId: HUBSPOT_TEST_HUB_ID, subscriptionType: "product.creation", objectId: 1004 },
    { eventId: 7, portalId: HUBSPOT_TEST_HUB_ID, subscriptionType: "company.merge", objectId: "2001" },
    { eventId: 8, portalId: HUBSPOT_TEST_HUB_ID, subscriptionType: "company.restore", objectId: 2002 },
  ]);
  const sign = (method: string, uri: string, raw: string, timestamp: string, secret = SECRET) => hmacSha256(secret, `${method}${uri}${raw}${timestamp}`, "base64");
  const request = (overrides: Partial<Parameters<typeof verifyHubSpotWebhook>[1]> = {}) => {
    const timestamp = String(AT);
    return { method: "POST", uri: URI, body, timestamp, signature: sign("POST", URI, body, timestamp), ...overrides };
  };

  it("accepts a correctly signed, current delivery and rejects tampered, wrongly keyed, unsigned or malformed ones", () => {
    expect(verifyHubSpotWebhook(SECRET, request(), AT)).toEqual({ ok: true });
    expect(verifyHubSpotWebhook(SECRET, { ...request(), body: Buffer.from(body), signature: ` ${request().signature} ` }, AT + 60_000)).toEqual({ ok: true });
    expect(verifyHubSpotWebhook(SECRET, request({ body: tamper(body) }), AT)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyHubSpotWebhook(`${SECRET}x`, request(), AT)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyHubSpotWebhook(SECRET, request({ method: "GET" }), AT)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyHubSpotWebhook(SECRET, request({ uri: `${URI}?x=1` }), AT)).toEqual({ ok: false, reason: "mismatch" });
    // The timestamp is signed too: moving it within the window breaks the signature.
    expect(verifyHubSpotWebhook(SECRET, request({ timestamp: String(AT + 1) }), AT)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyHubSpotWebhook(SECRET, request({ signature: undefined }), AT)).toEqual({ ok: false, reason: "missing" });
    expect(verifyHubSpotWebhook(SECRET, request({ timestamp: undefined }), AT)).toEqual({ ok: false, reason: "missing" });
    expect(verifyHubSpotWebhook("", request(), AT)).toEqual({ ok: false, reason: "missing" });
    expect(verifyHubSpotWebhook(SECRET, request({ signature: hmacSha256(SECRET, `POST${URI}${body}${AT}`, "hex") }), AT)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyHubSpotWebhook(SECRET, request({ signature: "A".repeat(43) }), AT)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyHubSpotWebhook(SECRET, request({ timestamp: "2026-01-20T00:00:00Z" }), AT)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a replayed delivery more than five minutes old, or from the future, even with a good signature", () => {
    expect(verifyHubSpotWebhook(SECRET, request(), AT + 5 * 60_000)).toEqual({ ok: true });
    expect(verifyHubSpotWebhook(SECRET, request(), AT + 5 * 60_000 + 1)).toEqual({ ok: false, reason: "stale" });
    expect(verifyHubSpotWebhook(SECRET, request(), AT - 5 * 60_000 - 1)).toEqual({ ok: false, reason: "stale" });
    expect(verifyHubSpotWebhook(SECRET, request(), AT + 24 * 3_600_000)).toEqual({ ok: false, reason: "stale" });
  });

  it("signs the URI with the characters HubSpot decodes decoded, and nothing else", () => {
    const encoded = "https://instance.example.test/webhooks/hubspot%3Fa%3Ab%2Cc%40d%2a%20e";
    const decoded = "https://instance.example.test/webhooks/hubspot?a:b,c@d*%20e";
    const timestamp = String(AT);
    expect(verifyHubSpotWebhook(SECRET, { method: "post", uri: encoded, body, timestamp, signature: sign("POST", decoded, body, timestamp) }, AT)).toEqual({ ok: true });
    expect(verifyHubSpotWebhook(SECRET, { method: "POST", uri: encoded, body, timestamp, signature: sign("POST", encoded, body, timestamp) }, AT)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("lists this account's contact, company, deal and ticket changes, without property values", () => {
    expect(hubSpotWebhookChanges(JSON.parse(body), HUBSPOT_TEST_HUB_ID)).toEqual([
      { object: "contacts", id: "1001", change: "propertyChange", time: new Date(AT - 1000).toISOString() },
      { object: "deals", id: "3001", change: "creation", time: new Date(AT).toISOString() },
      { object: "tickets", id: "4001", change: "deletion", time: undefined },
      { object: "companies", id: "2002", change: "restore", time: undefined },
    ]);
    expect(hubSpotWebhookChanges({}, HUBSPOT_TEST_HUB_ID)).toEqual([]);
    expect(hubSpotWebhookChanges([null, { portalId: HUBSPOT_TEST_HUB_ID }, { portalId: HUBSPOT_TEST_HUB_ID, subscriptionType: "contact.creation", objectId: -1 }], HUBSPOT_TEST_HUB_ID)).toEqual([]);
  });

  it("treats a delivery as a prompt to sync, so a replay stores nothing twice", async () => {
    const mock = hubSpotDocMock(account());
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const fromScratch = Object.create(memory, { getCheckpoint: { value: async () => null } }) as typeof memory;
    const again = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory: fromScratch, organizationId: TEST_ORG });
    expect(first.ingested).toBeGreaterThan(0);
    expect([again.ingested, again.duplicates]).toEqual([0, first.ingested]);
  });
});
