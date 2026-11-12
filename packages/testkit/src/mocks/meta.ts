import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * The Graph API (v26.0) reads behind Messenger and Instagram DMs, built
 * from Meta's docs, with synthetic data; and WhatsApp Cloud API webhook
 * deliveries, which are pushed, not read, so they are fixtures here rather
 * than routes. Once a Page token is set up, recordings replace this mock.
 *
 * Docs facts the mock relies on:
 * - `GET /{page-id}/conversations?platform=messenger|instagram` lists the
 *   Page's conversations, each with id and updated_time (the time of the
 *   last message), as {data, paging}, with standard Graph cursor paging
 *   (paging.cursors.after, paging.next); time-based paging isn't available.
 *   The reference writes the enum MESSENGER and INSTAGRAM, the guides
 *   lowercase (page/conversations, messenger-platform/conversations,
 *   instagram-platform conversations-api).
 * - `GET /{conversation-id}?fields=messages` lists every message id with
 *   its created_time; only the 20 most recent can be read in detail, and an
 *   older one errors saying the message was deleted (conversation,
 *   messenger-platform/conversations).
 * - A message has id, created_time ("2022-07-12T19:11:07+0000"), from {id,
 *   name and email for a Page, username for Instagram}, to {data: [...]},
 *   message (its text, empty when none), attachments and more (message).
 * - Errors are {error: {message, type, code, error_subcode, fbtrace_id}}:
 *   190 an invalid token, 200 a permission, 100 an invalid parameter, 613
 *   and 80006 too many calls.
 * - WhatsApp deliveries are {object: "whatsapp_business_account", entry:
 *   [{id, changes: [{field: "messages", value}]}]}, the value holding
 *   messaging_product, metadata {display_phone_number, phone_number_id},
 *   contacts, and messages (from, id, timestamp in unix seconds, type,
 *   text.body) or statuses (id, status, timestamp, recipient_id,
 *   conversation, pricing), signed in X-Hub-Signature-256 (whatsapp
 *   webhooks payload-examples and create-webhook-endpoint).
 */
const BASE = "https://graph.facebook.com/v26.0";
export const META_DOC_PAGES = {
  guide: "https://developers.facebook.com/docs/messenger-platform/conversations",
  conversations: "https://developers.facebook.com/docs/graph-api/reference/page/conversations/",
  conversation: "https://developers.facebook.com/docs/graph-api/reference/conversation/",
} as const;
/** Pages cited in the docs and code but not watched by a route: the message node, the Instagram guide and the WhatsApp webhook pages. */
export const META_REFERENCE_PAGES = {
  message: "https://developers.facebook.com/docs/graph-api/reference/message",
  instagram: "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api",
  whatsappPayloads: "https://developers.secure.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples",
  whatsappEndpoint: "https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint",
} as const;

/** The store's Page, its Instagram account and its WhatsApp number's id in fixtures. */
export const META_TEST_PAGE_ID = "1000000001";
export const META_TEST_INSTAGRAM_ID = "1780000001";
export const META_TEST_PHONE_NUMBER_ID = "1060000001";
/** The store's own WhatsApp number: a 555-01xx number, reserved for fiction. */
export const META_TEST_DISPLAY_NUMBER = "12125550199";
/** Conversations listed per page. Graph doesn't document its page size; 25 is assumed. */
export const META_MOCK_PAGE_SIZE = 25;
const READABLE = 20;

export type MetaMockRecord = Record<string, unknown>;

/** A time as Graph writes it, `n` minutes into 2026: "2026-01-01T00:05:00+0000". */
export const metaGraphTime = (n: number) => synthetic.isoTime(n).replace(/\.\d{3}Z$/, "+0000");
/** Unix seconds as WhatsApp writes them, `n` minutes into 2026. */
export const whatsappTimestamp = (n: number) => String(Date.parse(synthetic.isoTime(n)) / 1000);
/** A Page-scoped id for customer `n`. */
export const metaCustomerId = (n: number) => `71000${String(n).padStart(5, "0")}`;
/** An Instagram-scoped id for customer `n`. */
export const instagramCustomerId = (n: number) => `65000${String(n).padStart(5, "0")}`;
/** A customer's WhatsApp number (wa_id), 555-0100 to 555-0198, never the store's. */
export const whatsappCustomerNumber = (n: number) => `1212555${String(100 + (n % 99)).padStart(4, "0")}`;

/** Message `n` from Messenger customer `n` to the Page, `n` minutes into 2026, with text and a name and email the connector must drop. */
export const metaMessage = fixtureBuilder<MetaMockRecord>((n) => ({
  id: `m_test${String(n).padStart(6, "0")}`,
  created_time: metaGraphTime(n),
  from: { id: metaCustomerId(n), name: synthetic.name(n), email: synthetic.email(n) },
  to: { data: [{ id: META_TEST_PAGE_ID, name: "Test Jeweler" }] },
  message: `Is my ring ready yet? This is ${synthetic.name(n)}.`,
  attachments: { data: [] },
  tags: { data: [{ name: "inbox" }, { name: "source:chat" }] },
}));

/** The Page's reply to Messenger customer `n`, `n` minutes into 2026. */
export const metaReply = fixtureBuilder<MetaMockRecord>((n) => ({
  id: `m_reply${String(n).padStart(6, "0")}`,
  created_time: metaGraphTime(n),
  from: { id: META_TEST_PAGE_ID, name: "Test Jeweler" },
  to: { data: [{ id: metaCustomerId(n), name: synthetic.name(n), email: synthetic.email(n) }] },
  message: "Yes, it is ready to pick up.",
}));

/** Message `n` from Instagram customer `n` to the store's account, with a username the connector must drop. */
export const instagramMessage = fixtureBuilder<MetaMockRecord>((n) => ({
  id: `aWdfdGVzdF${String(n).padStart(6, "0")}`,
  created_time: metaGraphTime(n),
  from: { id: instagramCustomerId(n), username: `test.customer.${n}` },
  to: { data: [{ id: META_TEST_INSTAGRAM_ID, username: "test.jeweler" }] },
  message: `Do you have this in rose gold? ${synthetic.name(n)}`,
}));

/** A conversation in the mock: its platform and messages, and its updated time, the newest message's unless given. */
export interface MetaMockConversation {
  platform: "messenger" | "instagram";
  id: string;
  messages: MetaMockRecord[];
  updated_time?: string;
}

/** A customer's text to the store's WhatsApp number, `n` minutes into 2026. */
export const whatsappMessage = fixtureBuilder<MetaMockRecord>((n) => ({
  from: whatsappCustomerNumber(n),
  id: `wamid.test${String(n).padStart(6, "0")}`,
  timestamp: whatsappTimestamp(n),
  type: "text",
  text: { body: `Hello, is the store open today? ${synthetic.name(n)}` },
}));

/** A delivered status for the store's message to customer `n`, `n` minutes into 2026. */
export const whatsappStatus = fixtureBuilder<MetaMockRecord>((n) => ({
  id: `wamid.out${String(n).padStart(6, "0")}`,
  status: "delivered",
  timestamp: whatsappTimestamp(n),
  recipient_id: whatsappCustomerNumber(n),
  conversation: { id: `convtest${String(n).padStart(6, "0")}`, origin: { type: "service" } },
  pricing: { billable: true, pricing_model: "CBP", category: "service" },
}));

/** One WhatsApp webhook delivery for a phone number id, as the payload examples show it. */
export function whatsappDelivery(value: { messages?: MetaMockRecord[]; statuses?: MetaMockRecord[]; phoneNumberId?: string }): MetaMockRecord {
  const messages = value.messages ?? [];
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1020000001",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: META_TEST_DISPLAY_NUMBER, phone_number_id: value.phoneNumberId ?? META_TEST_PHONE_NUMBER_ID },
              ...(messages.length ? { contacts: messages.map((m, i) => ({ profile: { name: synthetic.name(i + 1) }, wa_id: m.from })) } : {}),
              ...(messages.length ? { messages } : {}),
              ...(value.statuses?.length ? { statuses: value.statuses } : {}),
            },
          },
        ],
      },
    ],
  };
}

export interface MetaMockData {
  token: string;
  pageId?: string;
  conversations: MetaMockConversation[];
  /** Graph errors (code 80006) to answer before the next reads. */
  rateLimits?: number;
}

export interface MetaMock {
  mock: DocMock;
  fetch: DocMockFetch;
  /** Each read answered: the node path and its query. */
  readonly reads: { path: string; query: Record<string, string> }[];
}

const graphError = (code: number, message: string, type = "OAuthException", status = 400): DocMockResponse => ({ status, body: { error: { message, type, code, fbtrace_id: "AtestTrace01" } } });
const CONVERSATION_QUERY = new Set(["platform", "fields", "after", "folder", "user_id"]);
const encode = (offset: number) => Buffer.from(`offset:${offset}`).toString("base64url");
const decode = (cursor: string) => {
  const m = /^offset:([1-9][0-9]{0,6})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  return m ? Number(m[1]) : null;
};
const updatedOf = (c: MetaMockConversation) => c.updated_time ?? [...c.messages.map((m) => String(m.created_time))].sort().at(-1) ?? metaGraphTime(0);
const newestFirst = (a: MetaMockRecord, b: MetaMockRecord) => String(b.created_time).localeCompare(String(a.created_time)) || String(b.id).localeCompare(String(a.id));

export function metaDocMock(data: MetaMockData): MetaMock {
  const reads: MetaMock["reads"] = [];
  let limits = data.rateLimits ?? 0;
  const pageId = data.pageId ?? META_TEST_PAGE_ID;

  /** Checks the token and the rate limit; null when the read may go on. */
  function gate(request: DocMockRequest): DocMockResponse | null {
    if (request.headers.get("authorization") !== `Bearer ${data.token}`) return graphError(190, "Invalid OAuth access token - Cannot parse access token");
    if (limits > 0) {
      limits--;
      return graphError(80006, "There have been too many messages requests to this Page.", "OAuthException");
    }
    return null;
  }

  function conversations(request: DocMockRequest, params: Record<string, string>): DocMockResponse {
    const stop = gate(request);
    if (stop) return stop;
    const q = request.url.searchParams;
    const unknown = [...q.keys()].find((k) => !CONVERSATION_QUERY.has(k));
    if (unknown) return graphError(100, `(#100) Unknown parameter: ${unknown}`, "GraphMethodException");
    if (params.page_id !== pageId) return graphError(100, "(#100) Unsupported get request.", "GraphMethodException");
    const platform = (q.get("platform") ?? "messenger").toLowerCase();
    if (platform !== "messenger" && platform !== "instagram") return graphError(100, "(#100) platform must be one of the following values: instagram, messenger", "GraphMethodException");
    const after = q.get("after");
    const offset = after === null ? 0 : decode(after);
    if (offset === null) return graphError(100, "(#100) Invalid cursor", "GraphMethodException");
    reads.push({ path: `/${params.page_id}/conversations`, query: Object.fromEntries(q) });
    const rows = data.conversations
      .filter((c) => c.platform === platform)
      .map((c) => ({ id: c.id, updated_time: updatedOf(c) }))
      .sort((a, b) => b.updated_time.localeCompare(a.updated_time) || b.id.localeCompare(a.id));
    const page = rows.slice(offset, offset + META_MOCK_PAGE_SIZE);
    const more = offset + META_MOCK_PAGE_SIZE < rows.length;
    const cursors = { before: "QVFIUmJ0ZAXN0", after: encode(offset + META_MOCK_PAGE_SIZE) };
    return { status: 200, body: { data: page, paging: { cursors, ...(more ? { next: `${BASE}/${pageId}/conversations?platform=${platform}&after=${cursors.after}` } : {}) } } };
  }

  function node(request: DocMockRequest, params: Record<string, string>): DocMockResponse {
    const stop = gate(request);
    if (stop) return stop;
    const id = params.node_id!;
    const fields = request.url.searchParams.get("fields");
    const conversation = data.conversations.find((c) => c.id === id);
    if (conversation) {
      if (fields !== "messages") return graphError(100, "(#100) Tried accessing nonexisting field", "GraphMethodException");
      reads.push({ path: `/${id}`, query: Object.fromEntries(request.url.searchParams) });
      const list = [...conversation.messages].sort(newestFirst).map((m) => ({ id: m.id, created_time: m.created_time }));
      return { status: 200, body: { messages: { data: list, paging: { cursors: { before: "QVFIUmJ0ZAXN0", after: "QVFIUmJ0ZAXN1" } } }, id } };
    }
    const owner = data.conversations.find((c) => c.messages.some((m) => m.id === id));
    if (!owner || !fields) return graphError(100, "(#100) Unsupported get request.", "GraphMethodException");
    // Only the 20 most recent messages of a conversation can be read.
    const readable = [...owner.messages].sort(newestFirst).slice(0, READABLE);
    const message = readable.find((m) => m.id === id);
    if (!message) return graphError(100, "(#100) This message has been deleted.", "GraphMethodException");
    reads.push({ path: `/${id}`, query: Object.fromEntries(request.url.searchParams) });
    const wanted = new Set(fields.split(","));
    return { status: 200, body: Object.fromEntries(Object.entries(message).filter(([k]) => wanted.has(k))) };
  }

  const mock = checkDocMock({
    integration: "meta",
    baseUrl: BASE,
    source: { url: META_DOC_PAGES.guide, title: "Messenger Platform: Conversations API", retrievedOn: "2026-11-12", version: "v26.0" },
    auth: "bearer",
    assumptions: [
      "The Page access token is taken as a bearer token in the Authorization header; the pages show it as the access_token parameter",
      "Conversations are listed newest first by updated_time, and a cursor stays good while they change",
      "A page of conversations holds 25; the docs don't give the page size or a limit parameter",
      "The platform parameter takes the lowercase values the guides use",
      "A conversation's messages field lists its message ids newest first, all of them on one page",
      "Graph errors come with HTTP 400, an unreadable older message as code 100, and too many calls as code 80006",
      "An Instagram message's from.id is the Instagram account's id when the store sent it",
    ],
    routes: [
      { method: "GET", path: "/{page_id}/conversations", documentedAt: META_DOC_PAGES.conversations, respond: conversations },
      { method: "GET", path: "/{node_id}", documentedAt: META_DOC_PAGES.conversation, respond: node },
    ],
  });
  return {
    mock,
    fetch: docMockFetch(mock),
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "meta",
  covers: "The Graph API's Page conversations, conversation and message reads (v26.0) for Messenger and Instagram DMs, with WhatsApp webhook fixtures",
  watchPages: [META_DOC_PAGES.guide, META_DOC_PAGES.conversations, META_DOC_PAGES.conversation],
  docMocks: () => [metaDocMock({ token: "", conversations: [] }).mock],
} satisfies DocMockModule;
