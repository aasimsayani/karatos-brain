import { describe, expect, it } from "vitest";
import { InMemoryWriteAuditLog, READ_ONLY, WriteGate, WritesDisabledError, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  DOC_MOCK_MODULES,
  META_DOC_PAGES,
  META_MOCK_PAGE_SIZE,
  META_REFERENCE_PAGES,
  META_TEST_DISPLAY_NUMBER,
  META_TEST_INSTAGRAM_ID,
  META_TEST_PAGE_ID,
  META_TEST_PHONE_NUMBER_ID,
  TEST_ORG,
  UndocumentedRequestError,
  assertSynthetic,
  checkConnectorSync,
  hmacSha256,
  instagramCustomerId,
  instagramMessage,
  metaCustomerId,
  metaDocMock,
  metaGraphTime,
  metaMessage,
  metaReply,
  tamper,
  testPipeline,
  whatsappCustomerNumber,
  whatsappDelivery,
  whatsappMessage,
  whatsappStatus,
  whatsappTimestamp,
  type MetaMock,
  type MetaMockConversation,
  type MetaMockData,
  type MetaMockRecord,
} from "@karatos/connector-testkit";
import {
  CustomerRefKeyError,
  META_CUSTOMER_PREFIX,
  META_MESSAGE_EVENT,
  META_MESSAGE_FIELDS,
  META_MESSAGING_FIRST_LOOKBACK_MS,
  META_MESSAGING_GRAPH_URL,
  META_MESSAGING_MAX_REQUESTS,
  META_MESSAGING_OVERLAP_MS,
  META_MESSAGING_PERMISSIONS,
  META_MESSAGING_PLATFORMS,
  META_MESSAGING_READABLE_MESSAGES,
  META_MESSAGING_RETRY_CODES,
  META_MESSAGING_USER_AGENT,
  META_SIGNATURE_HEADER,
  META_WEBHOOK_FUTURE_SKEW_MS,
  META_WEBHOOK_MAX_UPDATES,
  META_WEBHOOK_RETRY_WINDOW_MS,
  META_WRITES,
  MetaMessagingApiError,
  MetaMessagingConfigError,
  MetaWebhookDeduper,
  WHATNOT_USER_AGENT,
  WHATSAPP_STATUSES,
  formCustomerRefs,
  isMetaCursor,
  metaConnector,
  metaConversationProblem,
  metaGraphError,
  metaMessageEvent,
  metaMessageProblem,
  metaMessagingClient,
  metaRefs,
  metaTime,
  metaWebhookChallenge,
  parseMetaChannels,
  parseMetaCursor,
  verifyMetaWebhook,
  whatsappMessageEvent,
  whatsappStatusEvent,
  whatsappTime,
  whatsappWebhookEvents,
  type MetaCursor,
  type MetaEvent,
  type MetaMessagingClient,
  type MetaOptions,
  type MetaPass,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = ["EAA", "test", "x".repeat(30)].join("");
const APP_SECRET = ["ab", "cd"].join("").repeat(8);
const VERIFY = ["verify", "token", "x".repeat(10)].join("_");
const CUSTOMER_KEY = "c".repeat(40);
const BEARER = `Bearer ${TOKEN}`;
const HEADERS = { accept: "application/json", authorization: BEARER, "user-agent": META_MESSAGING_USER_AGENT };
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;
/** A day and a half into 2026, so fixtures made minutes into the year are inside the first later sync's two days. */
const RECEIVED = "2026-01-02T12:00:00.000Z";
const NOW = () => new Date(RECEIVED);
const HOUR_MS = 3_600_000;
const noSleep = async () => {};
const refs = metaRefs(CUSTOMER_KEY);
const at = (iso: string, hours: number) => new Date(Date.parse(iso) + hours * HOUR_MS).toISOString();
/** `n` hours before RECEIVED, as Graph writes a time. */
const hoursAgo = (n: number) => at(RECEIVED, -n).replace(/\.\d{3}Z$/, "+0000");

const reset = () => {
  for (const b of [metaMessage, metaReply, instagramMessage, whatsappMessage, whatsappStatus]) b.reset();
};

/** Two Messenger conversations (a question with its reply, and a question) and an Instagram one: four messages. */
function account(overrides: Partial<MetaMockData> = {}): MetaMockData {
  reset();
  return {
    token: TOKEN,
    conversations: [
      { platform: "messenger", id: "t_test1", messages: [metaMessage.one(), metaReply.one({ created_time: metaGraphTime(2) })] },
      { platform: "messenger", id: "t_test2", messages: [metaMessage.one({ created_time: metaGraphTime(5) })] },
      { platform: "instagram", id: "aWdfY29udjE", messages: [instagramMessage.one({ created_time: metaGraphTime(3) })] },
    ],
    ...overrides,
  };
}

const OPTIONS = { pageId: META_TEST_PAGE_ID, pageAccessToken: TOKEN, instagramAccountId: META_TEST_INSTAGRAM_ID, appSecret: APP_SECRET, verifyToken: VERIFY, whatsappPhoneNumberId: META_TEST_PHONE_NUMBER_ID, customerKey: CUSTOMER_KEY };
const connector = (mock: MetaMock, overrides: Partial<MetaOptions> = {}) => metaConnector({ ...OPTIONS, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as MetaEvent[];
async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}
const reads = (mock: MetaMock) => mock.reads.map((r) => `${r.path}${r.query.platform ? ` ${r.query.platform}` : ""}${r.query.after ? " next" : ""}`);
const cursorAt = (batches: SourceBatch[], i: number) => parseMetaCursor(batches.at(i)!.cursor);

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}
function scripted(...responses: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method, headers: { ...(init?.headers as Record<string, string>) } });
    return responses[Math.min(sent.length - 1, responses.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const graphError = (status: number, code: number, extra: Record<string, unknown> = {}) => json(status, { error: { message: "something", type: "OAuthException", code, fbtrace_id: "Atest", ...extra } });
const EMPTY = json(200, { data: [], paging: { cursors: { before: "b", after: "a" } } });
const client = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) => {
  const slept: number[] = [];
  const c = metaMessagingClient({ pageId: META_TEST_PAGE_ID, pageAccessToken: TOKEN, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const CONVERSATIONS = `${META_MESSAGING_GRAPH_URL}/${META_TEST_PAGE_ID}/conversations`;

describe("Meta messaging client", () => {
  it("checks the Page id and token before sending anything", () => {
    const { fetch, sent } = scripted(EMPTY);
    for (const pageId of ["", "  ", "0123", "12a", "1".repeat(26), undefined as unknown as string]) {
      expect(() => metaMessagingClient({ pageId, pageAccessToken: TOKEN, fetch }), String(pageId)).toThrow(new MetaMessagingConfigError("set META_PAGE_ID to the Facebook Page's numeric id"));
    }
    for (const pageAccessToken of ["", "x".repeat(19), "x".repeat(1025), `${TOKEN} more`, `Bearer ${TOKEN}`, `${TOKEN}|x`, undefined as unknown as string]) {
      expect(() => metaMessagingClient({ pageId: META_TEST_PAGE_ID, pageAccessToken, fetch }), String(pageAccessToken).slice(0, 8)).toThrow(new MetaMessagingConfigError("set META_PAGE_ACCESS_TOKEN to a Page access token for the Page in META_PAGE_ID"));
    }
    for (const pageAccessToken of ["x".repeat(20), "x".repeat(1024), ` ${TOKEN} `, "a-b_c.d".padEnd(20, "0")]) expect(() => metaMessagingClient({ pageId: ` ${"9".repeat(25)} `, pageAccessToken, fetch })).not.toThrow();
    expect(sent).toHaveLength(0);
    expect(new MetaMessagingConfigError("x").name).toBe("MetaMessagingConfigError");
    expect(new MetaMessagingApiError("x", 500, 2)).toMatchObject({ name: "MetaMessagingApiError", status: 500, code: 2 });
    expect(META_MESSAGING_USER_AGENT).toBe(WHATNOT_USER_AGENT);
    expect(META_MESSAGING_GRAPH_URL).toBe("https://graph.facebook.com/v26.0");
  });

  it("sends only GETs of the three reads, with the bearer token and a User-Agent, and queries it builds", async () => {
    const { fetch, sent } = scripted(EMPTY, EMPTY, json(200, { messages: { data: [] }, id: "t_1" }), json(200, { id: "m_1" }));
    const { c } = client(fetch);
    expect(await c.conversations("messenger", null)).toEqual({ rows: [], after: null });
    await c.conversations("instagram", "a+b/c=&x");
    expect(await c.conversationMessages("t_a/b=+")).toEqual([]);
    expect(await c.message("m_1")).toEqual({ id: "m_1" });
    expect(sent).toEqual([
      { url: `${CONVERSATIONS}?platform=messenger&fields=id%2Cupdated_time`, method: "GET", headers: HEADERS },
      { url: `${CONVERSATIONS}?platform=instagram&fields=id%2Cupdated_time&after=a%2Bb%2Fc%3D%26x`, method: "GET", headers: HEADERS },
      { url: `${META_MESSAGING_GRAPH_URL}/t_a%2Fb%3D%2B?fields=messages`, method: "GET", headers: HEADERS },
      { url: `${META_MESSAGING_GRAPH_URL}/m_1?fields=id%2Ccreated_time%2Cfrom%2Cto%2Cmessage%2Cattachments%2Cis_unsupported`, method: "GET", headers: HEADERS },
    ]);
    expect(META_MESSAGE_FIELDS).toBe("id,created_time,from,to,message,attachments,is_unsupported");
    expect(sent.some((s) => s.url.includes(TOKEN))).toBe(false);
  });

  it("checks platforms, cursors and ids before sending", async () => {
    const { fetch, sent } = scripted(EMPTY);
    const { c } = client(fetch);
    await expect(c.conversations("whatsapp" as never, null)).rejects.toThrow("conversations are listed for messenger or instagram");
    for (const after of ["", "a b", "c".repeat(2049), "é"]) await expect(c.conversations("messenger", after), after.slice(0, 4)).rejects.toThrow("a conversations cursor must be 1 to 2048 visible characters");
    for (const id of ["", "_t", "../x", "t 1", "t".repeat(513)]) {
      await expect(c.conversationMessages(id), id.slice(0, 4)).rejects.toThrow("a conversation id must be one Meta gave");
      await expect(c.message(id), id.slice(0, 4)).rejects.toThrow(MetaMessagingApiError);
    }
    expect(sent).toHaveLength(0);
    await c.conversations("messenger", "c".repeat(2048));
    await c.message("m".repeat(512));
    expect(sent).toHaveLength(2);
    expect(isMetaCursor("!~")).toBe(true);
    expect(isMetaCursor(5)).toBe(false);
  });

  it("follows Graph's cursor only while paging.next says there is another page", async () => {
    const cursors = { before: "b", after: "next1" };
    const { fetch } = scripted(
      json(200, { data: [{ id: "t_1" }] }),
      json(200, { data: [], paging: { cursors, next: null } }),
      json(200, { data: [{ id: "t_2" }], paging: { cursors, next: "https://graph.facebook.com/x" } }),
      json(200, { data: [], paging: { next: "https://graph.facebook.com/x" } }),
      json(200, { data: [], paging: { cursors: { after: "" }, next: "x" } }),
      json(200, { data: [], paging: { cursors, next: 5 } }),
      json(200, { data: [], paging: { cursors, next: "x" } }),
      json(200, { data: {} }),
      json(200, ["not", "an", "object"]),
      () => new Response("not json", { status: 200 }),
    );
    const { c } = client(fetch);
    expect(await c.conversations("messenger", null)).toEqual({ rows: [{ id: "t_1" }], after: null });
    expect(await c.conversations("messenger", null)).toEqual({ rows: [], after: null });
    expect(await c.conversations("messenger", null)).toEqual({ rows: [{ id: "t_2" }], after: "next1" });
    const noCursor = "Meta answered the messenger conversations with a next page but no cursor that reads";
    await expect(c.conversations("messenger", null)).rejects.toThrow(noCursor);
    await expect(c.conversations("messenger", null)).rejects.toThrow(noCursor);
    await expect(c.conversations("messenger", null)).rejects.toThrow(noCursor);
    await expect(c.conversations("instagram", "next1")).rejects.toThrow("Meta answered the instagram conversations with the same cursor again");
    await expect(c.conversations("messenger", null)).rejects.toThrow("Meta answered the messenger conversations without the data list");
    await expect(c.conversations("messenger", null)).rejects.toThrow("Meta answered the messenger conversations with a body that isn't a JSON object");
    await expect(c.conversations("messenger", null)).rejects.toMatchObject({ status: 200 });
  });

  it("reads a conversation's message list, empty when it has none", async () => {
    const list = [{ id: "m_1", created_time: "2026-01-01T00:00:00+0000" }];
    const { fetch } = scripted(json(200, { messages: { data: list }, id: "t_1" }), json(200, { id: "t_1" }), json(200, { messages: { data: {} } }), json(200, { messages: "x" }), json(200, { messages: null }));
    const { c } = client(fetch);
    expect(await c.conversationMessages("t_1")).toEqual(list);
    expect(await c.conversationMessages("t_1")).toEqual([]);
    for (let i = 0; i < 3; i++) await expect(c.conversationMessages("t_1")).rejects.toThrow("Meta answered a conversation's messages without the data list");
  });

  it("retries 429 and 5xx, and Graph's too-many-calls codes, honoring Retry-After up to a minute", async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const { fetch, sent } = scripted(json(status, {}, { "retry-after": "2" }), EMPTY);
      const { c, slept } = client(fetch);
      await c.conversations("messenger", null);
      expect([sent.length, slept], String(status)).toEqual([2, [2000]]);
    }
    for (const code of META_MESSAGING_RETRY_CODES) {
      const { fetch, sent } = scripted(graphError(400, code), EMPTY);
      const { c, slept } = client(fetch);
      await c.conversations("messenger", null);
      expect([sent.length, slept], String(code)).toEqual([2, [1000]]);
    }
    expect(META_MESSAGING_RETRY_CODES).toEqual([613, 80006]);
    const capped = scripted(json(429, {}, { "retry-after": "120" }), json(429, {}, { "retry-after": "60" }), json(429, {}, { "retry-after": "1" }), EMPTY);
    const a = client(capped.fetch);
    await a.c.conversations("messenger", null);
    expect(a.slept).toEqual([60_000, 60_000, 1000]);
    for (const header of ["0", "-3", "1.5", "soon"]) {
      const { fetch } = scripted(json(503, {}, { "retry-after": header }), EMPTY);
      const { c, slept } = client(fetch);
      await c.conversations("messenger", null);
      expect(slept, header).toEqual([1000]);
    }
  });

  it("gives up after three retries, or as many as asked, and doesn't retry other errors", async () => {
    const limited = scripted(graphError(400, 80006));
    const a = client(limited.fetch);
    await expect(a.c.conversations("messenger", null)).rejects.toMatchObject({ name: "MetaMessagingApiError", status: 400, code: 80006, message: "Meta answered HTTP 400 for the messenger conversations (code 80006)" });
    expect([limited.sent.length, a.slept]).toEqual([4, [1000, 2000, 4000]]);
    const once = scripted(json(500, {}));
    const b = client(once.fetch, { retries: 0 });
    await expect(b.c.conversations("messenger", null)).rejects.toThrow("Meta answered HTTP 500 for the messenger conversations");
    expect(once.sent).toHaveLength(1);
    const bad = scripted(graphError(400, 100, { error_subcode: 33 }));
    const d = client(bad.fetch);
    await expect(d.c.message("m_1")).rejects.toMatchObject({ status: 400, code: 100, message: "Meta answered HTTP 400 for a message (code 100, subcode 33)" });
    expect([bad.sent.length, d.slept]).toEqual([1, []]);
    // Graph answers a read with 200; any other status, even a 2xx, is an error.
    const other = scripted(json(201, { data: [] }));
    await expect(client(other.fetch).c.conversations("messenger", null)).rejects.toThrow(new MetaMessagingApiError("Meta answered HTTP 201 for the messenger conversations", 201));
    const plain = scripted(json(404, { nope: true }));
    await expect(client(plain.fetch).c.conversationMessages("t_1")).rejects.toThrow(new MetaMessagingApiError("Meta answered HTTP 404 for a conversation's messages", 404));
  });

  it("turns 401, 403 and code 190 into a config error naming the token, and code 200 into one naming the permissions", async () => {
    const token = "Meta turned down the Page access token";
    const tail = "; META_PAGE_ACCESS_TOKEN must be a current Page access token for the Page in META_PAGE_ID";
    for (const [answer, said] of [
      [json(401, {}), "(HTTP 401)"],
      [json(403, {}), "(HTTP 403)"],
      [graphError(400, 190, { error_subcode: 463 }), "(HTTP 400) (code 190, subcode 463)"],
    ] as const) {
      const { fetch, sent } = scripted(answer);
      const error = await client(fetch).c.conversations("messenger", null).then(() => new Error("no error"), (e: unknown) => e as Error);
      expect(error).toBeInstanceOf(MetaMessagingConfigError);
      expect(error.message).toBe(`${token} ${said}${tail}`);
      expect(error.message).not.toContain(TOKEN);
      expect(sent).toHaveLength(1);
    }
    const { fetch } = scripted(graphError(400, 200));
    const error = await client(fetch).c.conversations("instagram", null).then(() => new Error("no error"), (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(MetaMessagingConfigError);
    expect(error.message).toBe(
      "Meta says META_PAGE_ACCESS_TOKEN lacks a permission to read the instagram conversations (HTTP 400) (code 200): messenger needs pages_manage_metadata, pages_read_engagement, pages_messaging; instagram needs instagram_basic, instagram_manage_messages, pages_manage_metadata",
    );
    expect(META_MESSAGING_PERMISSIONS.messenger).toEqual(["pages_manage_metadata", "pages_read_engagement", "pages_messaging"]);
  });

  it("reads Graph's error code and subcode only when they are whole numbers", () => {
    expect(metaGraphError({ error: { code: 190, error_subcode: 460 } })).toEqual({ code: 190, subcode: 460 });
    expect(metaGraphError({ error: { code: 0 } })).toEqual({ code: 0, subcode: undefined });
    for (const body of [null, "x", [], {}, { error: "x" }, { error: { code: "190" } }, { error: { code: -1 } }, { error: { code: 1.5 } }, { error: { code: 2 ** 60 } }]) {
      expect(metaGraphError(body).code, JSON.stringify(body)).toBeUndefined();
    }
  });
});

describe("Meta message events", () => {
  const ctx = (channel: "messenger" | "instagram" = "messenger") => ({
    channel,
    businessId: channel === "messenger" ? META_TEST_PAGE_ID : META_TEST_INSTAGRAM_ID,
    refs,
    conversationRef: refs.node(channel, "conversation", "t_test1"),
    receivedAt: RECEIVED,
  });
  const message = (over: MetaMockRecord = {}) => {
    reset();
    return { ...metaMessage.one(), ...over };
  };
  const reply = (over: MetaMockRecord = {}) => {
    reset();
    return { ...metaReply.one(), ...over };
  };
  const problems = (raw: unknown, channel: "messenger" | "instagram" = "messenger") => {
    const read = metaMessageEvent(raw, ctx(channel));
    return read.ok ? [] : (read.event.payload.problems as string[]);
  };

  it("reads Graph's times as UTC, and nothing else", () => {
    expect(metaTime("2022-07-12T19:11:07+0000")).toBe("2022-07-12T19:11:07.000Z");
    expect(metaTime("2026-01-01T05:30:00+05:30")).toBe("2026-01-01T00:00:00.000Z");
    expect(metaTime("2026-01-01T00:00:00-0100")).toBe("2026-01-01T01:00:00.000Z");
    expect(metaTime("2026-01-01T00:00:00.123Z")).toBe("2026-01-01T00:00:00.123Z");
    expect(metaTime("1970-01-01T00:00:00Z")).toBe("1970-01-01T00:00:00.000Z");
    for (const bad of ["1969-12-31T23:59:59Z", "2026-02-30T00:00:00+0000", "2026-01-01T25:00:00+0000", "2026-01-01 00:00:00+0000", "2026-01-01T00:00:00", "2026-01-01T00:00:00+000", "2026-01-01T00:00+0000", "2026-01-01T00:00:00.1234Z", "x2026-01-01T00:00:00Z", 1_700_000_000, null]) {
      expect(metaTime(bad), String(bad)).toBeUndefined();
    }
  });

  it("reads WhatsApp's unix seconds", () => {
    expect(whatsappTime("1700000000")).toBe("2023-11-14T22:13:20.000Z");
    expect(whatsappTime("1")).toBe("1970-01-01T00:00:01.000Z");
    expect(whatsappTime("9".repeat(12))).toBe(new Date(999_999_999_999_000).toISOString());
    for (const bad of ["0", "01", "1".repeat(13), "1.5", " 1", 1_700_000_000, undefined]) expect(whatsappTime(bad), String(bad)).toBeUndefined();
  });

  it("keeps ids only as keyed digests, and numbers as the shared customer references", () => {
    const node = refs.node("messenger", "message", "m_1");
    expect(node).toMatch(/^meta:messenger:message:[0-9a-f]{32}$/);
    expect(refs.node("messenger", "message", "m_1")).toBe(node);
    expect(new Set([node, refs.node("instagram", "message", "m_1"), refs.node("messenger", "conversation", "m_1"), refs.node("messenger", "message", "m_2"), metaRefs("d".repeat(40)).node("messenger", "message", "m_1")]).size).toBe(5);
    // The channel and kind are inside the digest, not only in the prefix.
    const digest = (ref: string) => ref.split(":").at(-1);
    expect(new Set([node, refs.node("instagram", "message", "m_1"), refs.node("messenger", "conversation", "m_1")].map(digest)).size).toBe(3);
    expect(digest(refs.person("instagram", "7100000001"))).not.toBe(digest(refs.person("messenger", "7100000001")));
    const person = refs.person("messenger", "7100000001");
    expect(person).toMatch(new RegExp(`^${META_CUSTOMER_PREFIX}[0-9a-f]{32}$`));
    expect(META_CUSTOMER_PREFIX).toBe("meta_customer:");
    expect(refs.person("instagram", "7100000001")).not.toBe(person);
    expect(refs.phone("12125550101")).toEqual(formCustomerRefs(CUSTOMER_KEY, { phone: "12125550101" }));
    expect(refs.phone("1234567")).toHaveLength(1);
    expect(refs.phone("1".repeat(15))).toHaveLength(1);
    for (const bad of ["+12125550101", "123456", "1".repeat(16), "01212555010", 12125550101, undefined]) expect(refs.phone(bad), String(bad)).toEqual([]);
    expect(() => metaRefs("short")).toThrow(CustomerRefKeyError);
  });

  it("makes a customer's Messenger message an inbound event, keeping no words or names", () => {
    const read = metaMessageEvent(message({ attachments: { data: [{ id: "a1" }, { id: "a2" }] } }), ctx());
    expect(read.ok).toBe(true);
    const messageId = refs.node("messenger", "message", "m_test000001");
    expect(read.event).toMatchObject({ type: META_MESSAGE_EVENT, occurredAt: "2026-01-01T00:01:00.000Z", receivedAt: RECEIVED });
    expect(read.event.payload).toEqual({
      system: "Messenger",
      channel: "messenger",
      messageId,
      conversationId: refs.node("messenger", "conversation", "t_test1"),
      customerRefs: [refs.person("messenger", metaCustomerId(1))],
      storeAccountId: META_TEST_PAGE_ID,
      direction: "inbound",
      status: "received",
      attachmentCount: 2,
      textLength: "Is my ring ready yet? This is Test Customer 1.".length,
      unsupported: false,
      sentAt: "2026-01-01T00:01:00.000Z",
    });
    expect(read.event.idempotencyKey).toMatch(new RegExp(`^${messageId}:[0-9a-f]{12}$`));
    expect(read.event.id).toBe(read.event.idempotencyKey.replace(/:/g, "_"));
    expect(JSON.stringify(read.event)).not.toMatch(/ring ready|Test Customer|example\.test|m_test|t_test|7100000001/);
    expect(metaMessageEvent(message({ attachments: { data: [{ id: "a1" }, { id: "a2" }] } }), ctx()).event.idempotencyKey).toBe(read.event.idempotencyKey);
    expect(metaMessageEvent(message(), ctx()).event.idempotencyKey).not.toBe(read.event.idempotencyKey);
  });

  it("makes the Page's reply an outbound event for whoever it went to", () => {
    const read = metaMessageEvent(reply(), ctx());
    expect(read.event.payload).toMatchObject({ direction: "outbound", status: "sent", customerRefs: [refs.person("messenger", metaCustomerId(1))], attachmentCount: 0, textLength: 28 });
    const many = { data: [{ id: META_TEST_PAGE_ID }, { id: "b2" }, { id: "a1" }, { id: "a1" }, { id: "x y" }, "z", ...Array.from({ length: 12 }, (_, i) => ({ id: `c${i}` }))] };
    const refsOf = (to: unknown) => metaMessageEvent(reply({ to }), ctx()).event.payload.customerRefs as string[];
    const kept = refsOf(many);
    // Ten at most, the Page and anything that isn't an id left out, without repeats, sorted.
    expect(kept).toEqual([...new Set(["b2", "a1", "a1", ...Array.from({ length: 7 }, (_, i) => `c${i}`)].map((id) => refs.person("messenger", id)))].sort());
    expect(problems(reply({ to: { data: [{ id: META_TEST_PAGE_ID }] } }))).toEqual(["outgoing message has no recipient that reads"]);
    expect(problems(reply({ to: undefined }))).toEqual(["outgoing message has no recipient that reads"]);
    expect(problems(reply({ to: { data: "x" } }))).toEqual(["outgoing message has no recipient that reads"]);
  });

  it("tells the store's Instagram messages by its account id", () => {
    reset();
    const inbound = metaMessageEvent(instagramMessage.one(), ctx("instagram"));
    expect(inbound.event.payload).toMatchObject({ system: "Instagram", channel: "instagram", direction: "inbound", storeAccountId: META_TEST_INSTAGRAM_ID, customerRefs: [refs.person("instagram", instagramCustomerId(1))] });
    expect(JSON.stringify(inbound.event.payload)).not.toMatch(/test\.customer|rose gold/);
    const outbound = metaMessageEvent({ ...instagramMessage.one(), from: { id: META_TEST_INSTAGRAM_ID }, to: { data: [{ id: instagramCustomerId(9) }] } }, ctx("instagram"));
    expect(outbound.event.payload).toMatchObject({ direction: "outbound", customerRefs: [refs.person("instagram", instagramCustomerId(9))] });
    // The Page id is not the Instagram account, so from Instagram's side a message from it is a customer's.
    expect(metaMessageEvent({ ...instagramMessage.one(), from: { id: META_TEST_PAGE_ID } }, ctx("instagram")).event.payload).toMatchObject({ direction: "inbound" });
  });

  it("counts attachments and text, and marks unsupported messages", () => {
    const of = (over: MetaMockRecord) => metaMessageEvent(message(over), ctx()).event.payload;
    expect(of({ attachments: [{}, {}, {}] }).attachmentCount).toBe(3);
    expect(of({ attachments: undefined }).attachmentCount).toBe(0);
    expect(of({ attachments: { data: "x" } }).attachmentCount).toBe(0);
    expect(of({ message: "" }).textLength).toBe(0);
    expect(of({ message: undefined }).textLength).toBe(0);
    expect(of({ message: 42 }).textLength).toBe(0);
    expect(of({ is_unsupported: true }).unsupported).toBe(true);
    expect(of({ is_unsupported: "true" }).unsupported).toBe(false);
  });

  it("dead-letters a message without an id, time or sender that reads", () => {
    expect(problems("x")).toEqual(["message is not an object", "message has no id that reads", "message has no time that reads", "message has no sender that reads"]);
    expect(problems(message({ id: 5 }))).toEqual(["message has no id that reads"]);
    expect(problems(message({ id: "_m" }))).toEqual(["message has no id that reads"]);
    expect(problems(message({ id: "m".repeat(512) }))).toEqual([]);
    expect(problems(message({ created_time: "2026-01-01" }))).toEqual(["message has no time that reads"]);
    expect(problems(message({ from: { name: "x" } }))).toEqual(["message has no sender that reads"]);
    expect(problems(message({ from: { id: "a".repeat(129) } }))).toEqual(["message has no sender that reads"]);
    expect(problems(message({ from: { id: "a".repeat(128) } }))).toEqual([]);
    expect(problems(message({ from: "7100000001" }))).toEqual(["message has no sender that reads"]);
    const dead = metaMessageEvent(message({ created_time: null }), ctx()).event;
    expect(dead).toMatchObject({ type: META_MESSAGE_EVENT, occurredAt: undefined, idempotencyKey: expect.stringMatching(/^meta:messenger:unreadable_message:[0-9a-f]{12}$/) });
    expect(dead.payload).toEqual({ system: "Messenger", channel: "messenger", messageId: refs.node("messenger", "message", "m_test000001"), problems: ["message has no time that reads"] });
    expect(metaMessageEvent(null, ctx("instagram")).event.payload).toMatchObject({ system: "Instagram", messageId: null });
  });

  it("dead-letters a conversation or message it can't follow", () => {
    expect(metaConversationProblem({ id: "t_1" }, "messenger", RECEIVED)).toEqual({
      id: expect.stringMatching(/^meta_messenger_unreadable_conversation_[0-9a-f]{12}$/),
      type: META_MESSAGE_EVENT,
      occurredAt: undefined,
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^meta:messenger:unreadable_conversation:[0-9a-f]{12}$/),
      payload: { system: "Messenger", channel: "messenger", conversationId: null, problems: ["conversation has no updated time that reads"] },
    });
    expect(metaConversationProblem(7, "instagram", RECEIVED).payload.problems).toEqual(["conversation is not an object", "conversation has no id that reads", "conversation has no updated time that reads"]);
    expect(metaConversationProblem({ id: "_t", updated_time: metaGraphTime(1) }, "messenger", RECEIVED).payload.problems).toEqual(["conversation has no id that reads"]);
    const ref = refs.node("messenger", "message", "m_1");
    expect(metaMessageProblem("messenger", ref, "gone", RECEIVED)).toMatchObject({ occurredAt: undefined, idempotencyKey: expect.stringMatching(/^meta:messenger:unreadable_message:[0-9a-f]{12}$/), payload: { system: "Messenger", channel: "messenger", messageId: ref, problems: ["gone"] } });
    expect(metaMessageProblem("messenger", ref, "a", RECEIVED).idempotencyKey).toBe(metaMessageProblem("messenger", ref, "b", RECEIVED).idempotencyKey);
  });
});

describe("WhatsApp events", () => {
  const ctx = { phoneNumberId: META_TEST_PHONE_NUMBER_ID, refs, receivedAt: RECEIVED };
  const wa = (over: MetaMockRecord = {}) => {
    reset();
    return { ...whatsappMessage.one(), ...over };
  };
  const status = (over: MetaMockRecord = {}) => {
    reset();
    return { ...whatsappStatus.one(), ...over };
  };

  it("makes a customer's message an inbound event with the shared customer reference, and no words", () => {
    const read = whatsappMessageEvent(wa(), ctx);
    expect(read.ok).toBe(true);
    expect(read.event.payload).toEqual({
      system: "WhatsApp",
      channel: "whatsapp",
      messageId: refs.node("whatsapp", "message", "wamid.test000001"),
      customerRefs: formCustomerRefs(CUSTOMER_KEY, { phone: whatsappCustomerNumber(1) }),
      storeAccountId: META_TEST_PHONE_NUMBER_ID,
      direction: "inbound",
      status: "received",
      messageType: "text",
      textLength: "Hello, is the store open today? Test Customer 1".length,
      sentAt: "2026-01-01T00:01:00.000Z",
    });
    expect(read.event.occurredAt).toBe("2026-01-01T00:01:00.000Z");
    expect(JSON.stringify(read.event)).not.toMatch(/Hello|Test Customer|wamid|12125550101/);
    expect(whatsappMessageEvent(wa({ type: "image", text: undefined }), ctx).event.payload).toMatchObject({ messageType: "image", textLength: 0 });
    expect(whatsappMessageEvent(wa({ from: "+1 212" }), ctx).event.payload.customerRefs).toEqual([]);
  });

  it("dead-letters a message without an id, timestamp or type that reads", () => {
    const problems = (raw: unknown) => whatsappMessageEvent(raw, ctx).event.payload.problems;
    expect(problems([])).toEqual(["message is not an object", "message has no id that reads", "message has no timestamp that reads", "message has no type that reads"]);
    expect(problems(wa({ id: "" }))).toEqual(["message has no id that reads"]);
    expect(problems(wa({ id: "w".repeat(257) }))).toEqual(["message has no id that reads"]);
    expect(problems(wa({ id: "w".repeat(256) }))).toBeUndefined();
    expect(problems(wa({ timestamp: 1_700_000_000 }))).toEqual(["message has no timestamp that reads"]);
    expect(problems(wa({ type: "Text" }))).toEqual(["message has no type that reads"]);
    expect(problems(wa({ type: "t".repeat(33) }))).toEqual(["message has no type that reads"]);
    expect(whatsappMessageEvent(wa({ type: null }), ctx).event).toMatchObject({ occurredAt: undefined, idempotencyKey: expect.stringMatching(/^meta:whatsapp:unreadable_message:[0-9a-f]{12}$/) });
  });

  it("makes each status of the store's own message an outbound event, a new one per status", () => {
    const read = whatsappStatusEvent(status(), ctx);
    expect(read.event.payload).toEqual({
      system: "WhatsApp",
      channel: "whatsapp",
      messageId: refs.node("whatsapp", "message", "wamid.out000001"),
      conversationId: refs.node("whatsapp", "conversation", "convtest000001"),
      customerRefs: formCustomerRefs(CUSTOMER_KEY, { phone: whatsappCustomerNumber(1) }),
      storeAccountId: META_TEST_PHONE_NUMBER_ID,
      direction: "outbound",
      status: "delivered",
      statusAt: "2026-01-01T00:01:00.000Z",
    });
    expect(JSON.stringify(read.event)).not.toMatch(/pricing|CBP|service|convtest/);
    const keys = [...WHATSAPP_STATUSES].map((s) => whatsappStatusEvent(status({ status: s }), ctx).event.idempotencyKey);
    expect(new Set(keys).size).toBe(4);
    expect([...WHATSAPP_STATUSES]).toEqual(["sent", "delivered", "read", "failed"]);
    // A failed status has no contacts and may have no conversation.
    expect(whatsappStatusEvent(status({ status: "failed", conversation: undefined }), ctx).event.payload).not.toHaveProperty("conversationId");
    expect(whatsappStatusEvent(status({ conversation: { id: "" } }), ctx).event.payload).not.toHaveProperty("conversationId");
  });

  it("dead-letters a status without a message id, timestamp or known status", () => {
    const problems = (raw: unknown) => whatsappStatusEvent(raw, ctx).event.payload.problems;
    expect(problems("x")).toEqual(["status is not an object", "status has no message id that reads", "status has no timestamp that reads", "status is not sent, delivered, read or failed"]);
    expect(problems(status({ id: null }))).toEqual(["status has no message id that reads"]);
    expect(problems(status({ timestamp: "0" }))).toEqual(["status has no timestamp that reads"]);
    expect(problems(status({ status: "deleted" }))).toEqual(["status is not sent, delivered, read or failed"]);
  });
});

describe("Meta webhooks", () => {
  const BODY = JSON.stringify(whatsappDelivery({ messages: [whatsappMessage.one()] }));
  const sign = (body: string | Buffer, secret = APP_SECRET) => `sha256=${hmacSha256(secret, body.toString())}`;

  it("checks X-Hub-Signature-256 against the raw body in constant time", () => {
    expect(META_SIGNATURE_HEADER).toBe("x-hub-signature-256");
    expect(verifyMetaWebhook(APP_SECRET, BODY, sign(BODY))).toEqual({ ok: true });
    expect(verifyMetaWebhook(APP_SECRET, Buffer.from(BODY), ` ${sign(BODY)} `)).toEqual({ ok: true });
    expect(verifyMetaWebhook(` ${APP_SECRET} `, BODY, sign(BODY))).toEqual({ ok: true });
    expect(verifyMetaWebhook(APP_SECRET, tamper(BODY), sign(BODY))).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyMetaWebhook(APP_SECRET, BODY, sign(BODY, "ef".repeat(16)))).toEqual({ ok: false, reason: "mismatch" });
    for (const header of [undefined, null, "", "  "]) expect(verifyMetaWebhook(APP_SECRET, BODY, header), String(header)).toEqual({ ok: false, reason: "missing" });
    expect(verifyMetaWebhook("", BODY, sign(BODY))).toEqual({ ok: false, reason: "missing" });
    expect(verifyMetaWebhook(" ", BODY, sign(BODY))).toEqual({ ok: false, reason: "missing" });
    const hex = hmacSha256(APP_SECRET, BODY);
    for (const header of [`sha1=${hex}`, hex, `sha256=${hex.toUpperCase()}`, `sha256=${hex.slice(1)}`, `sha256=${hex}0`, `sha256= ${hex}`, `sha256=${hex},sha256=${hex}`, `sha256=${"g".repeat(64)}`]) {
      expect(verifyMetaWebhook(APP_SECRET, BODY, header), header.slice(0, 12)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("answers Meta's verification GET with the challenge only for the right verify token", () => {
    const query = (over: Record<string, string> = {}) => new URLSearchParams({ "hub.mode": "subscribe", "hub.challenge": "1158201444", "hub.verify_token": VERIFY, ...over });
    expect(metaWebhookChallenge(VERIFY, query())).toBe("1158201444");
    expect(metaWebhookChallenge(` ${VERIFY} `, query())).toBe("1158201444");
    expect(metaWebhookChallenge(VERIFY, { "hub.mode": "subscribe", "hub.challenge": "abc_.-Z", "hub.verify_token": VERIFY })).toBe("abc_.-Z");
    expect(metaWebhookChallenge(VERIFY, query({ "hub.challenge": "c".repeat(256) }))).toBe("c".repeat(256));
    for (const q of [
      query({ "hub.mode": "unsubscribe" }),
      query({ "hub.verify_token": `${VERIFY}x` }),
      query({ "hub.verify_token": "" }),
      query({ "hub.challenge": "" }),
      query({ "hub.challenge": "c".repeat(257) }),
      query({ "hub.challenge": "<script>" }),
      new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": VERIFY }),
      new URLSearchParams({ "hub.mode": "subscribe", "hub.challenge": "1" }),
      new URLSearchParams(`hub.mode=subscribe&hub.challenge=1&hub.verify_token=${VERIFY}&hub.verify_token=${VERIFY}`),
      { "hub.mode": "subscribe", "hub.challenge": "1", "hub.verify_token": [VERIFY] },
      Object.assign(Object.create({ "hub.verify_token": VERIFY }) as Record<string, string>, { "hub.mode": "subscribe", "hub.challenge": "1" }),
    ]) {
      expect(metaWebhookChallenge(VERIFY, q)).toBeNull();
    }
    expect(metaWebhookChallenge("", query({ "hub.verify_token": "" }))).toBeNull();
    expect(metaWebhookChallenge(undefined as unknown as string, query())).toBeNull();
  });

  describe("WhatsApp deliveries", () => {
    const NOW_MS = Date.parse("2026-01-01T00:00:00Z");
    const options = { phoneNumberId: META_TEST_PHONE_NUMBER_ID, refs, receivedAt: RECEIVED, now: NOW_MS };

    it("takes each message and status for the store's number", () => {
      reset();
      const body = whatsappDelivery({ messages: [whatsappMessage.one(), whatsappMessage.one()], statuses: [whatsappStatus.one()] });
      const events = whatsappWebhookEvents(body, options);
      expect(events.map((e) => [e.payload.direction, e.payload.status])).toEqual([["inbound", "received"], ["inbound", "received"], ["outbound", "delivered"]]);
      assertSynthetic(body);
      assertSynthetic(events.map((e) => e.payload));
      expect(JSON.stringify(events)).not.toMatch(/Test Customer|1212555|display_phone|12125550199/);
      expect(META_TEST_DISPLAY_NUMBER).toBe("12125550199");
    });

    it("leaves out deliveries for another number, object, field or product, and anything not shaped like one", () => {
      reset();
      const good = whatsappDelivery({ messages: [whatsappMessage.one()] }) as { entry: { changes: { field: string; value: Record<string, unknown> }[] }[] };
      const value = good.entry[0]!.changes[0]!.value;
      const variant = (patch: (v: Record<string, unknown>) => Record<string, unknown>) => ({ ...good, entry: [{ id: "1", changes: [{ field: "messages", value: patch({ ...value }) }] }] });
      expect(whatsappWebhookEvents(good, options)).toHaveLength(1);
      for (const body of [
        null,
        "x",
        [],
        { ...good, object: "page" },
        { ...good, object: "instagram" },
        { ...good, entry: {} },
        { ...good, entry: [null, { id: "1" }, { changes: {} }, { changes: [null, { field: "statuses", value }, { field: "messages", value: "x" }] }] },
        whatsappDelivery({ messages: [whatsappMessage.one()], phoneNumberId: "1060000002" }),
        variant((v) => ({ ...v, messaging_product: "sms" })),
        variant((v) => ({ ...v, metadata: undefined })),
        variant((v) => ({ ...v, metadata: { phone_number_id: Number(META_TEST_PHONE_NUMBER_ID) } })),
        variant((v) => ({ ...v, messages: "x", statuses: {} })),
      ]) {
        expect(whatsappWebhookEvents(body, options), JSON.stringify(body)?.slice(0, 60)).toEqual([]);
      }
    });

    it("takes at most 1000 updates from one delivery", () => {
      reset();
      const body = whatsappDelivery({ messages: whatsappMessage.many(META_WEBHOOK_MAX_UPDATES + 1, (n) => ({ timestamp: whatsappTimestamp(-n) })) });
      expect(whatsappWebhookEvents(body, options)).toHaveLength(META_WEBHOOK_MAX_UPDATES);
      expect(META_WEBHOOK_MAX_UPDATES).toBe(1000);
    });

    it("leaves out changes stamped before Meta's 7 days of retries or more than 5 minutes ahead, and dead-letters ones that don't read", () => {
      const stamp = (ms: number) => String(Math.floor(ms / 1000));
      const at = (ms: number) => whatsappWebhookEvents(whatsappDelivery({ statuses: [{ ...whatsappStatus.one(), timestamp: stamp(ms) }] }), options).length;
      expect(META_WEBHOOK_RETRY_WINDOW_MS).toBe(7 * 86_400_000);
      expect(META_WEBHOOK_FUTURE_SKEW_MS).toBe(300_000);
      expect(at(NOW_MS - META_WEBHOOK_RETRY_WINDOW_MS)).toBe(1);
      expect(at(NOW_MS - META_WEBHOOK_RETRY_WINDOW_MS - 1000)).toBe(0);
      expect(at(NOW_MS + META_WEBHOOK_FUTURE_SKEW_MS)).toBe(1);
      expect(at(NOW_MS + META_WEBHOOK_FUTURE_SKEW_MS + 1000)).toBe(0);
      const dead = whatsappWebhookEvents(whatsappDelivery({ messages: [{ id: "wamid.x" }] }), options);
      expect(dead).toMatchObject([{ occurredAt: undefined, payload: { problems: ["message has no timestamp that reads", "message has no type that reads"] } }]);
    });

    it("remembers the events already taken, so a delivery sent again is a duplicate", () => {
      reset();
      const events = whatsappWebhookEvents(whatsappDelivery({ messages: whatsappMessage.many(3) }), options);
      const deduper = new MetaWebhookDeduper(2);
      expect(deduper.fresh([events[0]!, events[0]!, events[1]!])).toEqual([events[0], events[1]]);
      expect(deduper.fresh(events)).toEqual([events[2]]);
      // Bounded: the oldest is forgotten first.
      expect(deduper.fresh([events[0]!, events[2]!])).toEqual([events[0]]);
      expect(new MetaWebhookDeduper().fresh(events)).toHaveLength(3);
    });
  });

  it("verifies, answers and takes deliveries through the connector, deduplicating replays", async () => {
    reset();
    const c = connector(metaDocMock(account()), { now: () => new Date("2026-01-01T01:00:00Z") });
    const raw = JSON.stringify(whatsappDelivery({ messages: [whatsappMessage.one()], statuses: [whatsappStatus.one()] }));
    expect(c.verifyWebhook(raw, sign(raw))).toEqual({ ok: true });
    expect(c.verifyWebhook(raw, sign(raw, "ef".repeat(16)))).toEqual({ ok: false, reason: "mismatch" });
    expect(c.webhookChallenge({ "hub.mode": "subscribe", "hub.challenge": "42", "hub.verify_token": VERIFY })).toBe("42");
    expect(c.webhookChallenge({ "hub.mode": "subscribe", "hub.challenge": "42", "hub.verify_token": "other" })).toBeNull();
    const first = c.handleWebhook(JSON.parse(raw));
    expect(first).toHaveLength(2);
    expect(first.every((e) => e.receivedAt === "2026-01-01T01:00:00.000Z")).toBe(true);
    expect(c.handleWebhook(JSON.parse(raw))).toEqual([]);
    // Messenger and Instagram deliveries are prompts to sync, not data.
    expect(c.handleWebhook({ object: "page", entry: [{ id: META_TEST_PAGE_ID, messaging: [{ message: { text: "hi" } }] }] })).toEqual([]);
    // The same delivery to another instance's number gives nothing.
    expect(connector(metaDocMock(account()), { whatsappPhoneNumberId: "1060000002", now: () => new Date("2026-01-01T01:00:00Z") }).handleWebhook(JSON.parse(raw))).toEqual([]);
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    for (const event of first) await pipeline.ingest({ ...event, organizationId: TEST_ORG, source: c.source });
    expect(memory.events).toHaveLength(2);
  });
});

describe("Meta connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(metaDocMock(account())), payloadSchemas: SCHEMAS, expected: { ingested: 4 } });
    expect(result.full.deadLettered).toBe(0);
    expect(parseMetaCursor(result.full.cursor)).toEqual({ done: true, pass: null, nextSince: at(RECEIVED, -1) });
  });

  it("imports every conversation, Messenger then Instagram, reading each message, and stops for good", async () => {
    const mock = metaDocMock(account());
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 4, deadLettered: 0, duplicates: 0 });
    expect(reads(mock)).toEqual([
      `/${META_TEST_PAGE_ID}/conversations messenger`,
      "/t_test2",
      "/m_test000002",
      "/t_test1",
      "/m_reply000001",
      "/m_test000001",
      `/${META_TEST_PAGE_ID}/conversations instagram`,
      "/aWdfY29udjE",
      "/aWdfdGVzdF000001",
    ]);
    expect(mock.reads[0]!.query).toEqual({ platform: "messenger", fields: "id,updated_time" });
    expect(mock.reads[1]!.query).toEqual({ fields: "messages" });
    expect(mock.reads[2]!.query).toEqual({ fields: META_MESSAGE_FIELDS });
    expect(memory.events.map((e) => `${e.payload.channel} ${e.payload.direction}`).sort()).toEqual(["instagram inbound", "messenger inbound", "messenger inbound", "messenger outbound"]);
    assertSynthetic(memory.events.map((e) => e.payload));
    expect(JSON.stringify(memory.events)).not.toMatch(/ring ready|rose gold|Test Customer|example\.test|test\.customer|t_test|m_test|7100000/);
    expect(parseMetaCursor(report.cursor)).toEqual({ done: true, pass: null, nextSince: at(RECEIVED, -1) });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect([again.ingested, mock.reads.length]).toEqual([0, 9]);
  });

  it("checkpoints each conversation with Graph's cursor, pages on, and resumes from a saved checkpoint", async () => {
    reset();
    const conversations: MetaMockConversation[] = Array.from({ length: META_MOCK_PAGE_SIZE + 2 }, (_, i) => ({ platform: "messenger", id: `t_p${i + 1}`, messages: [metaMessage.one({ id: `m_p${i + 1}`, created_time: metaGraphTime(i + 1) })] }));
    const mock = metaDocMock({ token: TOKEN, conversations });
    const batches = await drain(connector(mock, { channels: ["messenger"] }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(eventsOf(batches)).toHaveLength(META_MOCK_PAGE_SIZE + 2);
    // A batch per conversation, one when the page moves on, and one at the end of the channel.
    expect(batches.map((b) => b.events.length)).toEqual([...Array(META_MOCK_PAGE_SIZE).fill(1), 0, 1, 1, 0]);
    const pass = { channel: "messenger", since: "2021-01-02T12:00:00.000Z", started: RECEIVED } as const;
    const second = Buffer.from(`offset:${META_MOCK_PAGE_SIZE}`).toString("base64url");
    expect(cursorAt(batches, 0)).toEqual({ done: false, pass: { ...pass, after: null, skip: 1 }, nextSince: null });
    expect(cursorAt(batches, META_MOCK_PAGE_SIZE)).toEqual({ done: false, pass: { ...pass, after: second, skip: 0 }, nextSince: null });
    expect(cursorAt(batches, META_MOCK_PAGE_SIZE + 1)).toEqual({ done: false, pass: { ...pass, after: second, skip: 1 }, nextSince: null });
    expect(cursorAt(batches, -1)).toEqual({ done: true, pass: null, nextSince: at(RECEIVED, -1) });
    expect(reads(mock).filter((r) => r.includes("conversations"))).toEqual([`/${META_TEST_PAGE_ID}/conversations messenger`, `/${META_TEST_PAGE_ID}/conversations messenger next`]);
    // Resumed part way through the first page, on a later clock, it skips what was done and keeps the pass's window.
    const resumed = metaDocMock({ token: TOKEN, conversations });
    const rest = await drain(connector(resumed, { channels: ["messenger"], now: () => new Date(at(RECEIVED, 5)) }).historicalImport({ organizationId: TEST_ORG, cursor: batches[2]!.cursor }));
    expect(eventsOf(rest)).toHaveLength(META_MOCK_PAGE_SIZE - 1);
    expect(resumed.reads[1]!.path).toBe(`/t_p${META_MOCK_PAGE_SIZE - 1}`);
    expect(cursorAt(rest, -1)).toEqual({ done: true, pass: null, nextSince: at(RECEIVED, -1) });
    // Resumed at the end of a page, it reads that page again and moves on.
    const atEnd = metaDocMock({ token: TOKEN, conversations });
    const tail = await drain(connector(atEnd, { channels: ["messenger"] }).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ done: false, pass: { ...pass, after: second, skip: 5 }, nextSince: null } satisfies MetaCursor) }));
    expect([eventsOf(tail).length, atEnd.reads.length]).toEqual([0, 1]);
  });

  it("reads only each conversation's 20 most recent messages, and only those in the window", async () => {
    reset();
    const messages = metaMessage.many(25, (n) => ({ created_time: metaGraphTime(n * 10) }));
    const mock = metaDocMock({ token: TOKEN, conversations: [{ platform: "messenger", id: "t_long", messages }] });
    const batches = await drain(connector(mock, { channels: ["messenger"] }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(eventsOf(batches)).toHaveLength(META_MESSAGING_READABLE_MESSAGES);
    expect(META_MESSAGING_READABLE_MESSAGES).toBe(20);
    expect(mock.reads.slice(2).map((r) => r.path)).toEqual(Array.from({ length: 20 }, (_, i) => `/m_test${String(25 - i).padStart(6, "0")}`));
    // A later sync two days back leaves out a message made before then, in a conversation updated since.
    const old = metaDocMock({ token: TOKEN, conversations: [{ platform: "messenger", id: "t_mixed", messages: [metaMessage.one({ created_time: hoursAgo(49) }), metaMessage.one({ created_time: hoursAgo(47) })] }] });
    const later = await drain(connector(old, { channels: ["messenger"] }).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(eventsOf(later)).toHaveLength(1);
    expect(old.reads.map((r) => r.path)).toEqual([`/${META_TEST_PAGE_ID}/conversations`, "/t_mixed", "/m_test000027"]);
    // The first later sync looks back exactly 48 hours: a conversation and message from 47.5 hours ago are read, and so is one from exactly 48.
    for (const hours of [47.5, 48]) {
      reset();
      const edge = metaDocMock({ token: TOKEN, conversations: [{ platform: "messenger", id: "t_edge", messages: [metaMessage.one({ created_time: hoursAgo(hours) })] }] });
      const out = await drain(connector(edge, { channels: ["messenger"] }).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
      expect(eventsOf(out), String(hours)).toHaveLength(1);
    }
  });

  it("sends at most the request cap in one sync, then goes on from its checkpoint", async () => {
    expect(META_MESSAGING_MAX_REQUESTS).toBe(2100);
    const mock = metaDocMock(account());
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const sync = () => runSync({ connector: connector(mock, { maxRequests: 22 }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const counts: number[] = [];
    for (let run = 0, before = 0; run < 6; run++) {
      await sync();
      counts.push(mock.reads.length - before);
      before = mock.reads.length;
    }
    // Each run reads a page and one conversation at most: 22 requests can't cover a second, nor a page with one after it.
    expect(counts).toEqual([3, 4, 3, 0, 0, 0]);
    expect(memory.events).toHaveLength(4);
    expect(counts.every((n) => n <= 22)).toBe(true);
    // With the Messenger page empty, one request is used: the Instagram page isn't read, as a conversation couldn't follow it.
    reset();
    const igOnly = metaDocMock({ token: TOKEN, conversations: [{ platform: "instagram", id: "aWdfY29udjE", messages: [instagramMessage.one()] }] });
    const short = await drain(connector(igOnly, { maxRequests: 22 }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect([reads(igOnly), cursorAt(short, -1)!.pass]).toEqual([[`/${META_TEST_PAGE_ID}/conversations messenger`], { channel: "instagram", after: null, skip: 0, since: "2021-01-02T12:00:00.000Z", started: RECEIVED }]);
    const wide = metaDocMock(account());
    await drain(connector(wide, { maxRequests: 45 }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(wide.reads).toHaveLength(9);
    // Stopped by the cap part way through a page, the run ends where the last batch left off.
    const tight = metaDocMock(account());
    const out = await drain(connector(tight, { maxRequests: 23, channels: ["messenger"] }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(cursorAt(out, -1)).toMatchObject({ done: false, pass: { skip: 1 } });
    for (const maxRequests of [21, 0, 22.5, Number.NaN]) expect(() => connector(mock, { maxRequests })).toThrow("maxRequests must be a whole number of at least 22");
  });

  it("starts later syncs two days back, then from where the last pass began, less an hour, stopping at the first older conversation", async () => {
    reset();
    const data: MetaMockData = {
      token: TOKEN,
      conversations: [
        { platform: "messenger", id: "t_new", messages: [metaMessage.one({ created_time: hoursAgo(1) })] },
        { platform: "messenger", id: "t_old", messages: [metaMessage.one({ created_time: hoursAgo(49) })] },
        ...Array.from({ length: META_MOCK_PAGE_SIZE }, (_, i): MetaMockConversation => ({ platform: "messenger", id: `t_older${i}`, messages: [metaMessage.one({ created_time: hoursAgo(100 + i) })] })),
        { platform: "instagram", id: "aWdfbmV3", messages: [instagramMessage.one({ created_time: hoursAgo(2) })] },
      ],
    };
    const mock = metaDocMock(data);
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(first.ingested).toBe(2);
    // Newest first, so it stops at the first conversation older than the window and never reads the next page.
    expect(reads(mock)).toEqual([`/${META_TEST_PAGE_ID}/conversations messenger`, "/t_new", "/m_test000001", `/${META_TEST_PAGE_ID}/conversations instagram`, "/aWdfbmV3", "/aWdfdGVzdF000001"]);
    expect(META_MESSAGING_FIRST_LOOKBACK_MS).toBe(48 * HOUR_MS);
    expect(META_MESSAGING_OVERLAP_MS).toBe(HOUR_MS);
    expect(parseMetaCursor(first.cursor)).toEqual({ done: false, pass: null, nextSince: at(RECEIVED, -1) });
    // Six hours on, a new reply: the pass reads from an hour before the last began.
    data.conversations[0]!.messages.push(metaReply.one({ created_time: at(RECEIVED, 5).replace(/\.\d{3}Z$/, "+0000") }));
    const before = mock.reads.length;
    const second = await runSync({ connector: connector(mock, { now: () => new Date(at(RECEIVED, 6)) }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // The message from exactly an hour before the last pass began is read again, a duplicate.
    expect([second.ingested, second.duplicates]).toEqual([1, 1]);
    expect(reads(mock).slice(before)).toEqual([`/${META_TEST_PAGE_ID}/conversations messenger`, "/t_new", "/m_reply000001", "/m_test000001", `/${META_TEST_PAGE_ID}/conversations instagram`]);
    expect(parseMetaCursor(second.cursor)).toEqual({ done: false, pass: null, nextSince: at(RECEIVED, 5) });
  });

  it("resumes a later sync part way, keeping its window", async () => {
    const mock = metaDocMock(account());
    const pass: MetaPass = { channel: "instagram", after: null, skip: 0, since: "2025-12-31T00:00:00.000Z", started: at(RECEIVED, -2) };
    const nextSince = "2025-12-30T00:00:00.000Z";
    const batches = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ done: false, pass, nextSince } satisfies MetaCursor) }));
    expect(reads(mock)).toEqual([`/${META_TEST_PAGE_ID}/conversations instagram`, "/aWdfY29udjE", "/aWdfdGVzdF000001"]);
    expect(cursorAt(batches, 0)).toEqual({ done: false, pass: { ...pass, skip: 1 }, nextSince });
    expect(cursorAt(batches, -1)).toEqual({ done: false, pass: null, nextSince: at(RECEIVED, -3) });
    // A finished import's checkpoint, given to a later sync, starts a pass from its nextSince.
    const fromDone = metaDocMock(account());
    const out = await drain(connector(fromDone, { channels: ["messenger"] }).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ done: true, pass: null, nextSince: "2026-01-01T00:04:00.000Z" }) }));
    expect(eventsOf(out)).toHaveLength(1);
    expect(cursorAt(out, -1)).toEqual({ done: false, pass: null, nextSince: at(RECEIVED, -1) });
  });

  it("reads only the channels that are on, and skips one turned off since the checkpoint", async () => {
    const messenger = metaDocMock(account());
    expect(eventsOf(await drain(connector(messenger, { channels: ["messenger"] }).historicalImport({ organizationId: TEST_ORG, cursor: null })))).toHaveLength(3);
    expect(reads(messenger).some((r) => r.includes("instagram"))).toBe(false);
    const instagram = metaDocMock(account());
    const ig = connector(instagram, { channels: ["instagram"], instagramAccountId: META_TEST_INSTAGRAM_ID });
    expect(eventsOf(await drain(ig.historicalImport({ organizationId: TEST_ORG, cursor: null })))).toHaveLength(1);
    const pass = (channel: "messenger" | "instagram"): MetaCursor => ({ done: false, pass: { channel, after: "c1", skip: 3, since: "2021-01-02T12:00:00.000Z", started: RECEIVED }, nextSince: null });
    // Saved in Messenger, now off: Instagram starts from its first page.
    const moved = metaDocMock(account());
    await drain(connector(moved, { channels: ["instagram"] }).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(pass("messenger")) }));
    expect(moved.reads[0]!.query).toEqual({ platform: "instagram", fields: "id,updated_time" });
    // Saved in Instagram, now off: nothing is left, and the import is done.
    const none = metaDocMock(account());
    const out = await drain(connector(none, { channels: ["messenger"] }).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(pass("instagram")) }));
    expect([none.reads.length, out.length, cursorAt(out, -1)]).toEqual([0, 1, { done: true, pass: null, nextSince: at(RECEIVED, -1) }]);
    // In a sync, the store's Instagram replies are told by the Instagram account id, not the Page's.
    reset();
    const igReply = metaDocMock({ token: TOKEN, conversations: [{ platform: "instagram", id: "aWdfY29udjI", messages: [instagramMessage.one({ from: { id: META_TEST_INSTAGRAM_ID }, to: { data: [{ id: instagramCustomerId(4) }] } })] }] });
    const sent = eventsOf(await drain(connector(igReply, { channels: ["instagram"] }).historicalImport({ organizationId: TEST_ORG, cursor: null })));
    expect(sent.map((e) => [e.payload.direction, e.payload.customerRefs])).toEqual([["outbound", [refs.person("instagram", instagramCustomerId(4))]]]);
    // Without Instagram, no account id is needed.
    expect(() => connector(messenger, { channels: ["messenger"], instagramAccountId: "" })).not.toThrow();
  });

  it("dead-letters a conversation or message it can't read, and carries on", async () => {
    reset();
    const conversations: MetaMockConversation[] = [
      { platform: "messenger", id: "t_ok", messages: [metaMessage.one()] },
      { platform: "messenger", id: "_bad", messages: [] },
    ];
    const base = metaDocMock({ token: TOKEN, conversations });
    // A conversation list with an id that doesn't read, a listed message without a time, and one Graph won't read.
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/m_test000001?")) return new Response(JSON.stringify({ error: { message: "deleted", type: "GraphMethodException", code: 100 } }), { status: 400 });
      if (url.includes("/t_ok?")) return new Response(JSON.stringify({ messages: { data: [{ id: "m_test000001", created_time: metaGraphTime(1) }, { id: "m_x" }] } }), { status: 200 });
      return base.fetch(input, init);
    }) as typeof globalThis.fetch;
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: metaConnector({ ...OPTIONS, channels: ["messenger"], fetch, sleep: noSleep, now: NOW }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 0, deadLettered: 3 });
    // Any other error stops the sync, and the checkpoint keeps its place.
    const failing = (async (input: string | URL | Request, init?: RequestInit) => (String(input).includes("/m_test000001?") ? new Response(JSON.stringify({ error: { code: 2 } }), { status: 400 }) : base.fetch(input, init))) as typeof globalThis.fetch;
    await expect(drain(metaConnector({ ...OPTIONS, channels: ["messenger"], fetch: failing, sleep: noSleep, now: NOW }).historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toMatchObject({ status: 400, code: 2 });
  });

  it("waits out Graph's rate limit inside a sync, and stops on a turned-down token", async () => {
    const slept: number[] = [];
    await drain(connector(metaDocMock(account({ rateLimits: 2 })), { sleep: async (ms) => void slept.push(ms) }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(slept).toEqual([1000, 2000]);
    await expect(drain(connector(metaDocMock(account({ token: "z".repeat(40) }))).historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toBeInstanceOf(MetaMessagingConfigError);
  });

  it("checks its settings before reading anything", () => {
    const mock = metaDocMock(account());
    const fails = (over: Partial<MetaOptions>, message: string | RegExp) => expect(() => connector(mock, over)).toThrow(message);
    fails({ customerKey: "short" }, "CUSTOMER_REF_KEY");
    fails({ channels: [] }, "META_CHANNELS must turn on messenger, instagram or both");
    fails({ channels: ["whatsapp" as never] }, "META_CHANNELS must turn on messenger, instagram or both");
    for (const instagramAccountId of [undefined, "", "0", "abc", "1".repeat(26)]) {
      fails({ instagramAccountId: instagramAccountId as string }, "set META_INSTAGRAM_ACCOUNT_ID to the numeric id of the Instagram account linked to the Page, or leave instagram out of META_CHANNELS");
    }
    for (const appSecret of ["", "AB".repeat(16), "a".repeat(31), "a".repeat(33), undefined as unknown as string]) fails({ appSecret }, "set META_APP_SECRET to the Meta app's secret, 32 hex characters");
    for (const verifyToken of ["", "v".repeat(15), "v".repeat(257), "a b".padEnd(20, "c"), undefined as unknown as string]) fails({ verifyToken }, "set WHATSAPP_VERIFY_TOKEN to 16 to 256 letters, digits, dashes or underscores");
    for (const whatsappPhoneNumberId of ["", "+12125550199", "0", undefined as unknown as string]) fails({ whatsappPhoneNumberId }, "set WHATSAPP_PHONE_NUMBER_ID to the WhatsApp phone number's numeric id, not the number");
    for (const historyYears of [0, -1, 1.5]) fails({ historyYears }, "historyYears must be a positive whole number");
    fails({ pageId: "x" }, "META_PAGE_ID");
    fails({ pageAccessToken: "x" }, "META_PAGE_ACCESS_TOKEN");
    for (const ok of [{ appSecret: ` ${APP_SECRET} ` }, { verifyToken: "v".repeat(16) }, { verifyToken: "v".repeat(256) }, { whatsappPhoneNumberId: ` ${META_TEST_PHONE_NUMBER_ID} ` }, { pageId: "x", client: {} as MetaMessagingClient }]) {
      expect(() => connector(mock, ok), JSON.stringify(ok).slice(0, 30)).not.toThrow();
    }
    expect(connector(mock).source).toBe("meta");
  });

  it("reads back as many years as told, and up to now when no clock is given", async () => {
    const mock = metaDocMock(account());
    const out = await drain(connector(mock, { historyYears: 1, channels: ["messenger"] }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(cursorAt(out, 0)!.pass!.since).toBe("2025-01-02T12:00:00.000Z");
    const conversations: string[] = [];
    const client: MetaMessagingClient = { conversations: async (p) => (conversations.push(p), { rows: [], after: null }), conversationMessages: async () => [], message: async () => ({}) };
    const t0 = Date.now();
    const batches = await drain(metaConnector({ ...OPTIONS, client }).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(conversations).toEqual(["messenger", "instagram"]);
    expect(Date.parse(cursorAt(batches, -1)!.nextSince!)).toBeGreaterThanOrEqual(t0 - HOUR_MS);
    expect(META_MESSAGING_PLATFORMS).toEqual(["messenger", "instagram"]);
  });

  it("declares its writes and turns them down while writes are off", async () => {
    const c = connector(metaDocMock(account()));
    expect(c.writes).toBe(META_WRITES);
    expect(META_WRITES).toEqual([
      { integration: "meta", name: "send_reply", description: "Reply to a customer in a Messenger, Instagram or WhatsApp conversation", kind: "append", approval: "each", dailyCap: 10 },
      { integration: "meta", name: "mark_read", description: "Mark a Messenger, Instagram or WhatsApp conversation as read", kind: "update", approval: "each", dailyCap: 25 },
    ]);
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: READ_ONLY, audit });
    let performed = false;
    for (const action of c.writes ?? []) {
      await expect(gate.run(action, "meta-test", async () => void (performed = true))).rejects.toBeInstanceOf(WritesDisabledError);
    }
    expect(performed).toBe(false);
    expect(audit.entries).toMatchObject([{ action: "send_reply", integration: "meta" }, { action: "mark_read", integration: "meta" }]);
    expect(audit.entries.map((e) => e.outcome)).not.toContain("performed");
  });

  it("reads META_CHANNELS", () => {
    expect(parseMetaChannels(undefined)).toEqual(["messenger", "instagram"]);
    expect(parseMetaChannels(" ")).toEqual(["messenger", "instagram"]);
    expect(parseMetaChannels("instagram")).toEqual(["instagram"]);
    expect(parseMetaChannels("instagram, messenger,instagram")).toEqual(["messenger", "instagram"]);
    for (const bad of ["whatsapp", "messenger,", "Messenger", "messenger;instagram"]) expect(() => parseMetaChannels(bad), bad).toThrow(new MetaMessagingConfigError("META_CHANNELS must be messenger, instagram or both, separated by a comma"));
  });

  it("turns down a checkpoint that isn't its own", () => {
    const pass: MetaPass = { channel: "messenger", after: null, skip: 0, since: "2021-01-02T12:00:00.000Z", started: RECEIVED };
    const good: MetaCursor[] = [
      { done: false, pass, nextSince: null },
      { done: false, pass: { ...pass, channel: "instagram", after: "c".repeat(2048), skip: 7 }, nextSince: "2026-01-01T00:00:00.000Z" },
      { done: true, pass: null, nextSince: "2026-01-01T00:00:00.000Z" },
      { done: false, pass: null, nextSince: null },
    ];
    expect(parseMetaCursor(null)).toBeNull();
    for (const c of good) expect(parseMetaCursor(JSON.stringify(c))).toEqual(c);
    const bad: unknown[] = [
      "{",
      "null",
      "[]",
      "5",
      {},
      { done: false, pass: null },
      { done: false, pass: null, nextSince: null, extra: 1 },
      { done: "no", pass: null, nextSince: null },
      { done: false, pass: null, nextSince: "2026-01-01" },
      { done: true, pass, nextSince: null },
      { done: false, pass: "x", nextSince: null },
      { done: false, pass: [], nextSince: null },
      { done: false, pass: { ...pass, extra: 1 }, nextSince: null },
      { done: false, pass: { ...pass, channel: "whatsapp" }, nextSince: null },
      { done: false, pass: { ...pass, after: "" }, nextSince: null },
      { done: false, pass: { ...pass, after: "c".repeat(2049) }, nextSince: null },
      { done: false, pass: { ...pass, skip: -1 }, nextSince: null },
      { done: false, pass: { ...pass, skip: 1.5 }, nextSince: null },
      { done: false, pass: { ...pass, skip: "1" }, nextSince: null },
      { done: false, pass: { ...pass, since: "2021-01-02T12:00:00Z" }, nextSince: null },
      { done: false, pass: { ...pass, started: null }, nextSince: null },
      // Other connectors' checkpoints.
      { pass: null, done: true, nextFrom: RECEIVED },
      { done: false, step: "orders", page: null },
    ];
    for (const raw of bad) expect(() => parseMetaCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("Meta checkpoint is not in the expected shape");
  });
});

describe("Meta doc mock", () => {
  const get = (mock: MetaMock, path: string, headers: Record<string, string> = { authorization: BEARER }) => mock.fetch(`${META_MESSAGING_GRAPH_URL}${path}`, { headers });
  const body = async (response: Response) => (await response.json()) as { data?: { id: string }[]; paging?: { cursors?: { after?: string }; next?: string }; error?: { code: number }; messages?: { data: { id: string }[] } } & Record<string, unknown>;

  it("uses only synthetic data, and says where it came from", () => {
    const data = account();
    assertSynthetic(data.conversations);
    const { mock } = metaDocMock(data);
    expect(mock.source).toEqual({ url: META_DOC_PAGES.guide, title: "Messenger Platform: Conversations API", retrievedOn: "2026-11-12", version: "v26.0" });
    expect(mock.routes.map((r) => `${r.method} ${r.path} ${r.documentedAt}`)).toEqual([`GET /{page_id}/conversations ${META_DOC_PAGES.conversations}`, `GET /{node_id} ${META_DOC_PAGES.conversation}`]);
    const module = DOC_MOCK_MODULES.find((m) => m.integration === "meta")!;
    expect(module.watchPages).toEqual(Object.values(META_DOC_PAGES));
    expect([...Object.values(META_DOC_PAGES), ...Object.values(META_REFERENCE_PAGES)].every((u) => /^https:\/\/developers\.(secure\.)?facebook\.com\//.test(u))).toBe(true);
    assertSynthetic(whatsappDelivery({ messages: whatsappMessage.many(3), statuses: whatsappStatus.many(3) }));
  });

  it("checks the token, the Page and the query, and answers Graph's errors", async () => {
    const mock = metaDocMock(account({ rateLimits: 1 }));
    const limited = await get(mock, `/${META_TEST_PAGE_ID}/conversations`);
    expect([limited.status, (await body(limited)).error?.code]).toEqual([400, 80006]);
    const wrong = await get(mock, `/${META_TEST_PAGE_ID}/conversations`, { authorization: "Bearer other" });
    expect([wrong.status, (await body(wrong)).error?.code]).toEqual([400, 190]);
    expect((await get(mock, `/${META_TEST_PAGE_ID}/conversations`, {})).status).toBe(401);
    for (const path of [`/${META_TEST_PAGE_ID}/conversations?limit=10`, `/1000000002/conversations`, `/${META_TEST_PAGE_ID}/conversations?platform=whatsapp`, `/${META_TEST_PAGE_ID}/conversations?after=junk`, "/t_test1", "/t_test1?fields=participants", "/t_nope?fields=messages", "/m_test000001"]) {
      const r = await get(mock, path);
      expect([r.status, (await body(r)).error?.code], path).toEqual([400, 100]);
    }
    expect((await body(await get(mock, `/${META_TEST_PAGE_ID}/conversations?platform=INSTAGRAM`))).data!.map((c) => c.id)).toEqual(["aWdfY29udjE"]);
    expect((await body(await get(mock, `/${META_TEST_PAGE_ID}/conversations`))).data!.map((c) => c.id)).toEqual(["t_test2", "t_test1"]);
  });

  it("lists conversations newest first, 25 a page, and lets only a conversation's 20 latest messages be read", async () => {
    reset();
    const messages = metaMessage.many(21);
    const conversations: MetaMockConversation[] = [{ platform: "messenger", id: "t_big", messages }, ...Array.from({ length: META_MOCK_PAGE_SIZE }, (_, i): MetaMockConversation => ({ platform: "messenger", id: `t_${i}`, messages: [], updated_time: metaGraphTime(100 + i) }))];
    const mock = metaDocMock({ token: TOKEN, conversations });
    const first = await body(await get(mock, `/${META_TEST_PAGE_ID}/conversations?platform=messenger`));
    expect(first.data).toHaveLength(META_MOCK_PAGE_SIZE);
    expect(first.data![0]).toEqual({ id: `t_${META_MOCK_PAGE_SIZE - 1}`, updated_time: metaGraphTime(100 + META_MOCK_PAGE_SIZE - 1) });
    const next = await body(await get(mock, `/${META_TEST_PAGE_ID}/conversations?platform=messenger&after=${first.paging!.cursors!.after}`));
    expect([next.data!.map((c) => c.id), next.paging!.next]).toEqual([["t_big"], undefined]);
    // Exactly a page's worth of conversations has no next page.
    const full = metaDocMock({ token: TOKEN, conversations: conversations.slice(1) });
    expect((await body(await get(full, `/${META_TEST_PAGE_ID}/conversations`))).paging!.next).toBeUndefined();
    const list = await body(await get(mock, "/t_big?fields=messages"));
    expect(list.messages!.data.map((m) => m.id).slice(0, 2)).toEqual(["m_test000021", "m_test000020"]);
    const read = await body(await get(mock, "/m_test000002?fields=id,message"));
    expect(read).toEqual({ id: "m_test000002", message: messages[1]!.message });
    const deleted = await get(mock, "/m_test000001?fields=id");
    expect([deleted.status, (await body(deleted)).error?.code]).toEqual([400, 100]);
  });

  it("throws on a look-alike host and anything the docs don't list", async () => {
    const mock = metaDocMock(account());
    await expect(mock.fetch("https://graph.facebook.com.example.test/v26.0/me", {})).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${META_MESSAGING_GRAPH_URL}/me/messages`, { method: "POST", body: "{}", headers: { authorization: BEARER } })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${META_MESSAGING_GRAPH_URL}/${META_TEST_PHONE_NUMBER_ID}/messages`, { headers: { authorization: BEARER } })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch("https://graph.facebook.com/v25.0/t_test1", { headers: { authorization: BEARER } })).rejects.toThrow(UndocumentedRequestError);
    expect(mock.fetch.calls).toEqual([]);
  });
});
