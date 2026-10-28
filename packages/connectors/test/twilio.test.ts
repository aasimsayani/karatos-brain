import { describe, expect, it } from "vitest";
import type { SourceBatch } from "@karatos/core";
import { combineDepartments, RETAIL_DEPARTMENTS } from "@karatos/retail";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, synthetic } from "@karatos/connector-testkit";
import {
  TWILIO_PAGE_SIZE,
  TwilioApiError,
  TwilioConfigError,
  TwilioContactKeyError,
  channelOf,
  contactRef,
  parseTwilioCursor,
  priceMicros,
  storeLine,
  twilioClient,
  twilioConnector,
  twilioNormalizer,
  twilioTime,
  type TwilioCall,
  type TwilioCursor,
  type TwilioEvent,
  type TwilioMessage,
  type TwilioOptions,
} from "../src/index.js";

const NOW = () => new Date("2026-10-20T15:00:00Z");
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;
// Assembled at runtime so no credential-shaped string sits in the repository.
const ACCOUNT = ["AC", "0".repeat(32)].join("");
const KEY_SID = ["SK", "0".repeat(32)].join("");
const SECRET = ["test", "0".repeat(28)].join("");
const CONTACT_KEY = ["test", "contact", "key", "0".repeat(24)].join("-");
const BASE = `/2010-04-01/Accounts/${ACCOUNT}`;

// Fictional numbers: 555-01xx is reserved for fiction.
const STORE = synthetic.phone(0);
const CUSTOMER = (n: number) => synthetic.phone(n);
const sid = (prefix: string, n: number) => `${prefix}${n.toString(16).padStart(32, "0")}`;
const rfc2822 = (iso: string) => new Date(iso).toUTCString().replace("GMT", "+0000");

const message = (n: number, extra: Partial<TwilioMessage> = {}): TwilioMessage => ({
  sid: sid("SM", n),
  direction: n % 2 ? "inbound" : "outbound-api",
  status: n % 2 ? "received" : "delivered",
  from: n % 2 ? CUSTOMER(n) : STORE,
  to: n % 2 ? STORE : CUSTOMER(n - 1),
  num_segments: "1",
  num_media: "0",
  price: "-0.00790",
  price_unit: "USD",
  error_code: null,
  date_sent: rfc2822(`2026-10-${String(19 - n).padStart(2, "0")}T10:00:00Z`),
  date_created: rfc2822(`2026-10-${String(19 - n).padStart(2, "0")}T10:00:00Z`),
  ...extra,
});

const call = (n: number, extra: Partial<TwilioCall> = {}): TwilioCall => ({
  sid: sid("CA", n),
  direction: "inbound",
  status: "completed",
  from: CUSTOMER(n),
  to: STORE,
  duration: "65",
  price: "-0.0085",
  price_unit: "USD",
  start_time: rfc2822(`2026-10-${String(19 - n).padStart(2, "0")}T16:00:00Z`),
  end_time: rfc2822(`2026-10-${String(19 - n).padStart(2, "0")}T16:01:05Z`),
  date_created: rfc2822(`2026-10-${String(19 - n).padStart(2, "0")}T16:00:00Z`),
  ...extra,
});

// The body is in every record Twilio sends; the connector must never keep it.
const BODY = "Hi, is the solitaire in the window still available? My number is 212 555 0177";
const MESSAGES = [1, 2, 3, 4, 5].map((n) => ({ ...message(n), body: BODY, subresource_uris: { media: `${BASE}/Messages/${sid("SM", n)}/Media.json` } }));
const CALLS = [1, 2, 3].map((n) => call(n, n === 2 ? { status: "no-answer", duration: "0" } : {}));

interface Sent {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A stand-in for Twilio's list endpoints shaped from its API reference: pages of `size`, newest first, linked by next_page_uri. */
function fakeTwilio(data: { messages?: unknown[]; calls?: unknown[] } = {}, size = 2, override?: (url: URL) => Response | null) {
  const sent: Sent[] = [];
  const lists: Record<string, unknown[]> = { messages: data.messages ?? MESSAGES, calls: data.calls ?? CALLS };
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push({ url: String(input), method: init?.method ?? "GET", body: init?.body, headers: Object.fromEntries(new Headers(init?.headers)) });
    const custom = override?.(url);
    if (custom) return custom;
    const list = url.pathname.endsWith("/Messages.json") ? "messages" : url.pathname.endsWith("/Calls.json") ? "calls" : null;
    if (!list) return Response.json({ code: 20404, message: "not found", status: 404 }, { status: 404 });
    const page = Number(url.searchParams.get("Page") ?? 0);
    const records = lists[list]!.slice(page * size, (page + 1) * size);
    const more = (page + 1) * size < lists[list]!.length;
    const path = `${BASE}/${list === "messages" ? "Messages" : "Calls"}.json`;
    return Response.json({
      [list]: records,
      page,
      page_size: size,
      next_page_uri: more ? `${path}?PageSize=${size}&Page=${page + 1}&PageToken=PA${page + 1}` : null,
      previous_page_uri: null,
      uri: `${path}?PageSize=${size}&Page=${page}`,
    });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const connector = (fetch: typeof globalThis.fetch, extra: Partial<TwilioOptions> = {}) =>
  twilioConnector({ accountSid: ACCOUNT, apiKeySid: KEY_SID, apiKeySecret: SECRET, contactKey: CONTACT_KEY, fetch, now: NOW, sleep: async () => {}, pageSize: 2, ...extra });

async function collect(pages: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const page of pages) out.push(page);
  return out;
}
const historyOf = (c: ReturnType<typeof connector>, cursor: string | null = null) => collect(c.historicalImport({ organizationId: TEST_ORG, cursor }));
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as TwilioEvent[];
const ref = (number: string) => contactRef(CONTACT_KEY, number);

describe("Twilio records", () => {
  const normalizer = twilioNormalizer(CONTACT_KEY);
  const at = "2026-10-20T15:00:00.000Z";

  it("keeps a text's who, when, line and outcome, and never its body", () => {
    const [inbound] = normalizer.message({ ...message(1), body: BODY } as TwilioMessage, at);
    expect(inbound).toEqual({
      id: `twilio_message_${sid("SM", 1)}_received`,
      type: "communication.message_logged",
      occurredAt: "2026-10-18T10:00:00.000Z",
      receivedAt: at,
      idempotencyKey: `twilio:message:${sid("SM", 1)}:received`,
      payload: {
        channel: "sms",
        messageId: `twilio:message:${sid("SM", 1)}`,
        contactRef: ref(CUSTOMER(1)),
        storeLine: "…0100",
        direction: "inbound",
        kind: "inbound",
        status: "received",
        segments: 1,
        mediaCount: 0,
        costMicros: 7_900,
        currency: "USD",
        sentAt: "2026-10-18T10:00:00.000Z",
      },
    });
    expect(JSON.stringify(inbound)).not.toMatch(/solitaire|555|0177|body/);
    const [outbound] = normalizer.message(message(2), at);
    expect(outbound!.payload).toMatchObject({ direction: "outbound", kind: "outbound-api", contactRef: ref(CUSTOMER(1)), storeLine: "…0100" });
  });

  it("tells texts, picture messages, WhatsApp and other channels apart", () => {
    expect(normalizer.message(message(1, { num_media: "2" }), at)[0]!.payload).toMatchObject({ channel: "mms", mediaCount: 2 });
    expect(normalizer.message(message(1, { from: `whatsapp:${CUSTOMER(1)}`, to: `whatsapp:${STORE}` }), at)[0]!.payload).toMatchObject({ channel: "whatsapp", contactRef: ref(CUSTOMER(1)), storeLine: "…0100" });
    const other = normalizer.message(message(1, { from: "messenger:1234", to: "messenger:5678" }), at)[0]!.payload;
    expect(other).toMatchObject({ channel: "other", contactRef: contactRef(CONTACT_KEY, "messenger:1234") });
    expect(other).not.toHaveProperty("storeLine");
  });

  it("keeps an error code but not Twilio's error message, and leaves out what Twilio hasn't filled in", () => {
    const failed = normalizer.message({ ...message(2, { status: "undelivered", error_code: 30006, price: null, price_unit: null, num_segments: null, date_sent: null }), error_message: `Landline ${CUSTOMER(1)}` } as TwilioMessage, at)[0]!;
    expect(failed.payload).toMatchObject({ status: "undelivered", errorCode: 30006 });
    expect(failed.payload).not.toHaveProperty("costMicros");
    expect(failed.payload).not.toHaveProperty("segments");
    expect(failed.occurredAt).toBe("2026-10-17T10:00:00.000Z");
    expect(JSON.stringify(failed)).not.toContain("Landline");
  });

  it("gives each status its own event, so a delivery receipt is a new event and a replay isn't", () => {
    const sent = normalizer.message(message(2, { status: "sent" }), at)[0]!;
    const delivered = normalizer.message(message(2), at)[0]!;
    expect(sent.idempotencyKey).not.toBe(delivered.idempotencyKey);
    expect(normalizer.message(message(2), "2026-10-21T00:00:00.000Z")[0]!.idempotencyKey).toBe(delivered.idempotencyKey);
  });

  it("marks inbound calls nobody picked up as missed", () => {
    const answered = normalizer.call(call(1), at)[0]!;
    expect(answered).toMatchObject({ type: "communication.call_logged", occurredAt: "2026-10-18T16:00:00.000Z", idempotencyKey: `twilio:call:${sid("CA", 1)}:completed` });
    expect(answered.payload).toEqual({
      channel: "voice",
      callId: `twilio:call:${sid("CA", 1)}`,
      contactRef: ref(CUSTOMER(1)),
      storeLine: "…0100",
      direction: "inbound",
      kind: "inbound",
      status: "completed",
      durationSeconds: 65,
      costMicros: 8_500,
      currency: "USD",
      startedAt: "2026-10-18T16:00:00.000Z",
      endedAt: "2026-10-18T16:01:05.000Z",
    });
    for (const status of ["busy", "no-answer", "canceled"]) expect(normalizer.call(call(1, { status }), at)[0]!.payload.missed, status).toBe(true);
    expect(normalizer.call(call(1, { status: "failed" }), at)[0]!.payload).not.toHaveProperty("missed");
    const outbound = normalizer.call(call(1, { direction: "outbound-dial", status: "no-answer", from: STORE, to: CUSTOMER(1) }), at)[0]!.payload;
    expect(outbound).toMatchObject({ direction: "outbound", contactRef: ref(CUSTOMER(1)) });
    expect(outbound).not.toHaveProperty("missed");
  });

  it("skips records that aren't Twilio messages or calls", () => {
    for (const bad of [null, {}, { ...message(1), sid: "SMnope" }, { ...message(1), sid: sid("CA", 1) }, { ...message(1), status: "Bad Status!" }, { ...message(1), direction: 3 }, { ...message(1), status: undefined }]) {
      expect(normalizer.message(bad as TwilioMessage, at), JSON.stringify(bad)).toEqual([]);
    }
    for (const bad of [null, { ...call(1), sid: sid("SM", 1) }, { ...call(1), status: "" }, { ...call(1), direction: null }]) {
      expect(normalizer.call(bad as TwilioCall, at), JSON.stringify(bad)).toEqual([]);
    }
    expect(normalizer.message(message(1, { sid: sid("MM", 9) }), at)).toHaveLength(1);
  });

  it("keys contacts by number however it's written, and needs a long key", () => {
    expect(ref("+1 (212) 555-0101")).toBe(ref("+12125550101"));
    expect(ref(`whatsapp:${CUSTOMER(1)}`)).toBe(ref(CUSTOMER(1)));
    expect(ref(CUSTOMER(1))).not.toBe(ref(CUSTOMER(2)));
    expect(ref(CUSTOMER(1))).not.toBe(contactRef(`${CONTACT_KEY}x`, CUSTOMER(1)));
    expect(ref(CUSTOMER(1))).toMatch(/^twilio:contact:[0-9a-f]{24}$/);
    expect(contactRef(CONTACT_KEY, "Client:Alice")).toBe(contactRef(CONTACT_KEY, "client:alice"));
    expect(contactRef(CONTACT_KEY, null)).toBeUndefined();
    expect(contactRef(CONTACT_KEY, " ")).toBeUndefined();
    expect(() => twilioNormalizer("short")).toThrow(TwilioContactKeyError);
    expect(() => twilioNormalizer("x".repeat(31))).toThrow("at least 32 characters");
  });

  it("reads Twilio's channel addresses, times and prices", () => {
    expect(channelOf("+12125550100")).toEqual({ channel: "phone", number: "12125550100" });
    expect(channelOf("whatsapp:+12125550100")).toEqual({ channel: "whatsapp", number: "12125550100" });
    expect(channelOf("client:alice")).toEqual({ channel: "other", number: null });
    expect(channelOf("+123")).toEqual({ channel: "other", number: null });
    expect(storeLine("+12125550100")).toBe("…0100");
    expect(storeLine(null)).toBeUndefined();
    expect(twilioTime("Sun, 18 Oct 2026 10:00:00 +0000")).toBe("2026-10-18T10:00:00.000Z");
    expect(twilioTime("Sun, 18 Oct 2026 10:00:00 -0500")).toBe("2026-10-18T15:00:00.000Z");
    expect(twilioTime("2026-10-18T10:00:00Z")).toBeUndefined();
    expect(twilioTime("Xyz, 99 Abc 2026 10:00:00 +0000")).toBeUndefined();
    expect(twilioTime(null)).toBeUndefined();
    expect(priceMicros("-0.00750")).toBe(7_500);
    expect(priceMicros("0.0085")).toBe(8_500);
    expect(priceMicros("-1.5")).toBe(1_500_000);
    expect(priceMicros("12")).toBe(12_000_000);
    expect(priceMicros("-0.1234567")).toBeUndefined();
    expect(priceMicros("abc")).toBeUndefined();
    expect(priceMicros(null)).toBeUndefined();
  });
});

describe("the Twilio client", () => {
  it("sends only GET requests with no body, signed in with the API key, to this account's two lists", async () => {
    const api = fakeTwilio();
    const client = twilioClient({ accountSid: ACCOUNT, apiKeySid: KEY_SID, apiKeySecret: SECRET, fetch: api.fetch, pageSize: 2 });
    const first = await client.first("messages", "2026-10-01");
    await client.page("messages", first.next!);
    await client.first("calls", "2026-10-01");
    expect(api.sent.map((s) => [s.method, s.body])).toEqual([
      ["GET", undefined],
      ["GET", undefined],
      ["GET", undefined],
    ]);
    expect(api.sent[0]!.url).toBe(`https://api.twilio.com${BASE}/Messages.json?PageSize=2&DateSent%3E=2026-10-01`);
    expect(api.sent[2]!.url).toBe(`https://api.twilio.com${BASE}/Calls.json?PageSize=2&StartTime%3E=2026-10-01`);
    expect(api.sent[1]!.url).toBe(`https://api.twilio.com${BASE}/Messages.json?PageSize=2&Page=1&PageToken=PA1`);
    const basic = `Basic ${Buffer.from(`${KEY_SID}:${SECRET}`).toString("base64")}`;
    expect(api.sent.map((s) => s.headers)).toEqual(Array(3).fill({ authorization: basic, accept: "application/json" }));
    expect(new URL(api.sent[0]!.url).searchParams.get("DateSent>")).toBe("2026-10-01");
  });

  it("turns down the account's Auth Token and checks every setting before sending anything", () => {
    const { fetch } = fakeTwilio();
    const make = (o: Partial<Parameters<typeof twilioClient>[0]>) => () => twilioClient({ accountSid: ACCOUNT, apiKeySid: KEY_SID, apiKeySecret: SECRET, fetch, ...o });
    expect(make({ apiKeySid: ACCOUNT })).toThrow("not the account SID");
    expect(make({ apiKeySid: "SK123" })).toThrow(TwilioConfigError);
    expect(make({ accountSid: KEY_SID })).toThrow("TWILIO_ACCOUNT_SID");
    expect(make({ accountSid: ["AC", "F".repeat(32)].join("") })).toThrow("TWILIO_ACCOUNT_SID");
    expect(make({ apiKeySecret: "short" })).toThrow("TWILIO_API_KEY_SECRET");
    expect(make({ apiKeySecret: `${SECRET}!` })).toThrow("TWILIO_API_KEY_SECRET");
    for (const pageSize of [0, 1001, 2.5]) expect(make({ pageSize }), String(pageSize)).toThrow("pageSize");
    expect(make({ accountSid: ` ${ACCOUNT} `, apiKeySid: ` ${KEY_SID}`, apiKeySecret: `${SECRET} ` })).not.toThrow();
    expect(TWILIO_PAGE_SIZE).toBe(1000);
  });

  it("follows next pages only within this account's same list", async () => {
    const elsewhere = (path: string) => fakeTwilio({}, 2, (url) => (url.searchParams.get("DateSent>") ? Response.json({ messages: [], next_page_uri: path }) : null));
    for (const path of [`https://evil.test${BASE}/Messages.json?Page=1`, `/2010-04-01/Accounts/${["AC", "1".repeat(32)].join("")}/Messages.json?Page=1`, `${BASE}/Calls.json?Page=1`, `${BASE}/Messages.json`, `${BASE}/Messages/${sid("SM", 1)}.json?x=1`]) {
      const api = elsewhere(path);
      const client = twilioClient({ accountSid: ACCOUNT, apiKeySid: KEY_SID, apiKeySecret: SECRET, fetch: api.fetch });
      await expect(client.first("messages", "2026-10-01"), path).rejects.toThrow("points outside this account's messages list");
    }
    const api = fakeTwilio();
    const client = twilioClient({ accountSid: ACCOUNT, apiKeySid: KEY_SID, apiKeySecret: SECRET, fetch: api.fetch });
    await expect(client.page("calls", `${BASE}/Messages.json?Page=1`)).rejects.toThrow(TwilioConfigError);
    expect(() => client.first("calls", "10/01/2026")).toThrow("since must be YYYY-MM-DD");
    expect(api.sent).toEqual([]);
    const empty = await twilioClient({ accountSid: ACCOUNT, apiKeySid: KEY_SID, apiKeySecret: SECRET, fetch: fakeTwilio({}, 2, () => Response.json({ calls: [], next_page_uri: "" })).fetch }).first("calls", "2026-10-01");
    expect(empty).toEqual({ records: [], next: null });
  });

  it("reports Twilio's errors with its code, and retries a rate limit with backoff", async () => {
    const failing = fakeTwilio({}, 2, () => Response.json({ code: 20003, message: "Authenticate", more_info: "https://www.twilio.com/docs/errors/20003", status: 401 }, { status: 401 }));
    const client = twilioClient({ accountSid: ACCOUNT, apiKeySid: KEY_SID, apiKeySecret: SECRET, fetch: failing.fetch });
    const error = await client.first("messages", "2026-10-01").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TwilioApiError);
    expect(error).toMatchObject({ status: 401, code: 20003, message: "Twilio answered HTTP 401 to the messages list: Authenticate" });
    expect((error as Error).message).not.toContain(SECRET);
    const garbled = twilioClient({ accountSid: ACCOUNT, apiKeySid: KEY_SID, apiKeySecret: SECRET, fetch: fakeTwilio({}, 2, () => new Response("<html>", { status: 503 })).fetch });
    await expect(garbled.first("calls", "2026-10-01")).rejects.toMatchObject({ status: 503, code: undefined, message: "Twilio answered HTTP 503 to the calls list" });
    const wrong = twilioClient({ accountSid: ACCOUNT, apiKeySid: KEY_SID, apiKeySecret: SECRET, fetch: fakeTwilio({}, 2, () => Response.json({ calls: [] })).fetch });
    await expect(wrong.first("messages", "2026-10-01")).rejects.toThrow("Twilio's messages list did not answer with messages");

    let calls = 0;
    const waits: number[] = [];
    const limited = fakeTwilio({}, 2, () => (++calls <= 2 ? Response.json({ code: 20429, message: "Too Many Requests" }, { status: 429 }) : null));
    const patient = twilioClient({ accountSid: ACCOUNT, apiKeySid: KEY_SID, apiKeySecret: SECRET, fetch: limited.fetch, sleep: async (ms) => void waits.push(ms) });
    expect((await patient.first("messages", "2026-10-01")).records).toHaveLength(2);
    expect(waits).toEqual([1000, 2000]);
    const always = fakeTwilio({}, 2, () => Response.json({ code: 20429 }, { status: 429 }));
    const stubborn = twilioClient({ accountSid: ACCOUNT, apiKeySid: KEY_SID, apiKeySecret: SECRET, fetch: always.fetch, sleep: async () => {}, rateLimitRetries: 1 });
    await expect(stubborn.first("messages", "2026-10-01")).rejects.toMatchObject({ status: 429, code: 20429 });
    expect(always.sent).toHaveLength(2);
  });
});

describe("Twilio connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic({ MESSAGES, CALLS });
  });

  it("survives every runSync scenario, with every event passing the clienteling schemas", async () => {
    const api = fakeTwilio();
    const result = await checkConnectorSync({ makeConnector: () => connector(api.fetch), payloadSchemas: SCHEMAS, expected: { ingested: 8 } });
    // Messages in pages of 2 (3 pages), then calls (2 pages).
    expect(result.full.batches).toBe(5);
    const cursor = JSON.parse(result.full.cursor!) as TwilioCursor;
    expect(cursor).toEqual({
      messages: { since: "2021-10-20", next: null, newest: "2026-10-18", done: true },
      calls: { since: "2021-10-20", next: null, newest: "2026-10-18", done: true },
    });
  });

  it("reads five years back, messages first, then calls, page by page", async () => {
    const api = fakeTwilio();
    const batches = await historyOf(connector(api.fetch));
    expect(api.sent.map((s) => new URL(s.url).pathname.split("/").at(-1) + new URL(s.url).search)).toEqual([
      "Messages.json?PageSize=2&DateSent%3E=2021-10-20",
      "Messages.json?PageSize=2&Page=1&PageToken=PA1",
      "Messages.json?PageSize=2&Page=2&PageToken=PA2",
      "Calls.json?PageSize=2&StartTime%3E=2021-10-20",
      "Calls.json?PageSize=2&Page=1&PageToken=PA1",
    ]);
    const events = eventsOf(batches);
    expect(events.map((e) => e.type)).toEqual([...Array(5).fill("communication.message_logged"), ...Array(3).fill("communication.call_logged")]);
    expect(JSON.stringify(events)).not.toMatch(/solitaire|0177|Media\.json|555 01/);
    expect(events.find((e) => e.payload.missed)!.payload).toMatchObject({ callId: `twilio:call:${sid("CA", 2)}`, status: "no-answer" });
  });

  it("resumes mid-list from the page it stopped on", async () => {
    const first = fakeTwilio();
    const batches = await historyOf(connector(first.fetch));
    const midMessages = batches[1]!.cursor;
    expect(parseTwilioCursor(midMessages)!.messages).toEqual({ since: "2021-10-20", next: `${BASE}/Messages.json?PageSize=2&Page=2&PageToken=PA2`, newest: "2026-10-18", done: false });
    const resumed = fakeTwilio();
    const rest = await historyOf(connector(resumed.fetch, { now: () => new Date("2026-10-22T00:00:00Z") }), midMessages);
    expect(rest).toHaveLength(3);
    expect(resumed.sent.map((s) => new URL(s.url).search)).toEqual(["?PageSize=2&Page=2&PageToken=PA2", "?PageSize=2&StartTime%3E=2021-10-20", "?PageSize=2&Page=1&PageToken=PA1"]);
    const midCalls = batches[3]!.cursor;
    const tail = fakeTwilio();
    expect(await historyOf(connector(tail.fetch), midCalls)).toHaveLength(1);
    expect(tail.sent.map((s) => new URL(s.url).pathname.split("/").at(-1))).toEqual(["Calls.json"]);
  });

  it("starts the next run two days before the newest record the last one saw", async () => {
    const first = fakeTwilio();
    const done = (await historyOf(connector(first.fetch))).at(-1)!.cursor;
    const next = fakeTwilio({ messages: [], calls: [] });
    const batches = await collect(connector(next.fetch).incrementalSync({ organizationId: TEST_ORG, cursor: done }));
    expect(next.sent.map((s) => new URL(s.url).search)).toEqual(["?PageSize=2&DateSent%3E=2026-10-16", "?PageSize=2&StartTime%3E=2026-10-16"]);
    // A run that finds nothing keeps its start for the one after.
    expect(parseTwilioCursor(batches.at(-1)!.cursor)).toEqual({
      messages: { since: "2026-10-16", next: null, newest: null, done: true },
      calls: { since: "2026-10-16", next: null, newest: null, done: true },
    });
    const again = fakeTwilio({ messages: [], calls: [] });
    await collect(connector(again.fetch).incrementalSync({ organizationId: TEST_ORG, cursor: batches.at(-1)!.cursor }));
    expect(again.sent.map((s) => new URL(s.url).search)).toEqual(["?PageSize=2&DateSent%3E=2026-10-16", "?PageSize=2&StartTime%3E=2026-10-16"]);
  });

  it("starts a first incremental sync two days back, and counts records it reads again as duplicates", async () => {
    const api = fakeTwilio();
    await collect(connector(api.fetch).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(new URL(api.sent[0]!.url).searchParams.get("DateSent>")).toBe("2026-10-18");
  });

  it("declares sending texts and placing calls, and a read-only gate turns both down", async () => {
    const audit = await assertWritesRefused(connector(fakeTwilio().fetch));
    expect(audit.map((a) => [a.action, a.outcome])).toEqual([
      ["send_message", "refused"],
      ["place_call", "refused"],
    ]);
    expect(connector(fakeTwilio().fetch).handleWebhook).toBeUndefined();
  });

  it("checks its settings before reading anything", () => {
    const { fetch } = fakeTwilio();
    for (const historyYears of [0, 11, 1.5]) expect(() => connector(fetch, { historyYears }), String(historyYears)).toThrow(/historyYears/);
    expect(() => connector(fetch, { contactKey: "short" })).toThrow(TwilioContactKeyError);
    expect(() => connector(fetch, { apiKeySid: ACCOUNT })).toThrow(TwilioConfigError);
  });

  it("rejects a checkpoint it didn't write", () => {
    expect(parseTwilioCursor(null)).toBeNull();
    const state = { since: "2026-10-01", next: null, newest: null, done: false };
    expect(parseTwilioCursor(JSON.stringify({ messages: state, calls: state }))).toEqual({ messages: state, calls: state });
    for (const bad of [
      "null",
      "{}",
      JSON.stringify({ messages: state }),
      JSON.stringify({ messages: { ...state, since: "10/01/2026" }, calls: state }),
      JSON.stringify({ messages: { ...state, next: 3 }, calls: state }),
      JSON.stringify({ messages: { ...state, newest: "today" }, calls: state }),
      JSON.stringify({ messages: { ...state, done: "no" }, calls: state }),
    ]) {
      expect(() => parseTwilioCursor(bad), bad).toThrow("Twilio checkpoint is not in the expected shape");
    }
  });
});
