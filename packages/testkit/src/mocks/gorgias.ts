import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * Gorgias's OAuth token endpoint, List tickets and List messages, built
 * from Gorgias's developer docs. Data is synthetic. Gorgias apps are made
 * in its partner portal, so a client's connection replaces this mock on the
 * first live run.
 *
 * Docs facts the mock relies on:
 * - Each account has its own address, https://{subdomain}.gorgias.com, and
 *   POST /oauth/token with grant_type=refresh_token and the refresh token
 *   answers access_token, expires_in (86400), scope and token_type; the
 *   refresh token doesn't expire (oauth2-authentication tutorial).
 * - Read scopes include tickets:read, customers:read and tags:read
 *   (oauth2-scopes).
 * - GET /api/tickets takes order_by (created_datetime or updated_datetime,
 *   asc or desc; created_datetime:desc by default), cursor and limit (1 to
 *   100, 30 by default) (list-tickets).
 * - GET /api/messages takes cursor, limit (1 to 100), order_by
 *   (created_datetime:asc or :desc) and ticket_id (list-messages).
 * - Lists answer {object, uri, data, meta: {prev_cursor, next_cursor}}
 *   (pagination).
 * - Past the limit Gorgias answers 429 with Retry-After in seconds
 *   (limitations).
 * - Times are written without an offset, such as 2019-07-05T14:42:00.384938
 *   (the-ticket-object).
 */
const DOCS = "https://developers.gorgias.com";
export const GORGIAS_DOC_PAGES = {
  oauth: `${DOCS}/docs/oauth2-authentication-for-creating-apps-with-gorgias`,
  scopes: `${DOCS}/docs/oauth2-scopes`,
  tickets: `${DOCS}/reference/list-tickets`,
  messages: `${DOCS}/reference/list-messages`,
  pagination: `${DOCS}/reference/pagination`,
} as const;

export const GORGIAS_TEST_DOMAIN = "teststore";
export const GORGIAS_TEST_AGENT = 7;

export type GorgiasMockRecord = Record<string, unknown>;

/** Gorgias's way of writing a time: no offset, microseconds. */
export const gorgiasTimeOf = (iso: string) => iso.replace(/\.(\d{3})Z$/, ".$1000");

/** An open email ticket from a customer, created and last changed `n` minutes into 2026. */
export const gorgiasTicket = fixtureBuilder<GorgiasMockRecord>((n) => ({
  id: 100 + n,
  uri: `/api/tickets/${100 + n}/`,
  external_id: null,
  status: "open",
  channel: "email",
  via: "email",
  from_agent: false,
  spam: false,
  customer: { id: 500 + n, email: synthetic.email(n), name: synthetic.name(n), firstname: "Test", lastname: `Customer ${n}` },
  assignee_user: { id: GORGIAS_TEST_AGENT, name: "Test Agent" },
  language: "en",
  subject: `Is my ring ready? (${synthetic.name(n)})`,
  tags: [{ id: 1, name: "repair" }],
  is_unread: true,
  satisfaction_survey: null,
  created_datetime: gorgiasTimeOf(synthetic.isoTime(n)),
  opened_datetime: null,
  last_received_message_datetime: gorgiasTimeOf(synthetic.isoTime(n)),
  last_message_datetime: gorgiasTimeOf(synthetic.isoTime(n)),
  updated_datetime: gorgiasTimeOf(synthetic.isoTime(n)),
  closed_datetime: null,
  snooze_datetime: null,
  trashed_datetime: null,
}));

/** A customer's email on ticket `ticketId`, `n` minutes into 2026. */
export const gorgiasMessage = fixtureBuilder<GorgiasMockRecord>((n) => ({
  id: 9000 + n,
  uri: `/api/tickets/101/messages/${9000 + n}/`,
  ticket_id: 101,
  public: true,
  channel: "email",
  via: "email",
  from_agent: false,
  source: { type: "email", from: { name: synthetic.name(n), address: synthetic.email(n) }, to: [{ name: "Store", address: "help@store.test" }] },
  sender: { id: 500 + n },
  receiver: { id: GORGIAS_TEST_AGENT },
  subject: "Is my ring ready?",
  body_text: `Hello, this is ${synthetic.name(n)}. Is my ring ready?`,
  body_html: `<p>Hello, this is ${synthetic.name(n)}.</p>`,
  attachments: [],
  rule_id: null,
  created_datetime: gorgiasTimeOf(synthetic.isoTime(n)),
  sent_datetime: null,
  failed_datetime: null,
  deleted_datetime: null,
  opened_datetime: null,
}));

export interface GorgiasMockData {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tickets?: GorgiasMockRecord[];
  messages?: GorgiasMockRecord[];
  /** The scopes the token says the app has. Defaults to openid, offline and tickets:read. */
  scope?: string | null;
  /** 429s to answer before the next reads, with this Retry-After. */
  rateLimits?: number;
  retryAfter?: string;
}

export interface GorgiasMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each read: the list and its query. */
  readonly reads: { kind: string; query: Record<string, string> }[];
  readonly signIns: number;
  /** Makes the tokens issued so far stop working, as when they expire early. */
  revokeTokens(): void;
}

const fail = (status: number, message: string): DocMockResponse => ({ status, body: { error: { msg: message } } });
const stamp = (r: GorgiasMockRecord, field: string) => Date.parse(`${String(r[field]).slice(0, 23)}Z`);

export function gorgiasDocMock(data: GorgiasMockData): GorgiasMock {
  const reads: { kind: string; query: Record<string, string> }[] = [];
  let signIns = 0;
  let limits = data.rateLimits ?? 0;
  const tokens = new Set<string>();

  function token(request: DocMockRequest): DocMockResponse {
    const basic = `Basic ${Buffer.from(`${data.clientId}:${data.clientSecret}`).toString("base64")}`;
    if (request.headers.get("authorization") !== basic) return { status: 401, body: { error: "invalid_client" } };
    const form = new URLSearchParams(request.body);
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") || form.get("grant_type") !== "refresh_token") return { status: 400, body: { error: "unsupported_grant_type" } };
    if (form.get("refresh_token") !== data.refreshToken) return { status: 400, body: { error: "invalid_grant" } };
    signIns++;
    const access = `gorgias-token-${signIns}`;
    tokens.add(access);
    const scope = data.scope === undefined ? "openid offline tickets:read" : data.scope;
    return { status: 200, body: { access_token: access, expires_in: 86400, token_type: "Bearer", ...(scope === null ? {} : { scope }) } };
  }

  const list = (kind: "tickets" | "messages", allowed: string[], sorts: string[], select: (q: URLSearchParams) => GorgiasMockRecord[]) => (request: DocMockRequest): DocMockResponse => {
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!bearer || !tokens.has(bearer)) return fail(401, "Unauthorized");
    if (limits > 0) {
      limits--;
      return { ...fail(429, "Too Many Requests"), headers: data.retryAfter === undefined ? {} : { "Retry-After": data.retryAfter } };
    }
    const q = request.url.searchParams;
    for (const name of q.keys()) if (!allowed.includes(name)) return fail(400, `Unknown field ${name}`);
    const order = q.get("order_by") ?? sorts[0]!;
    if (!sorts.includes(order)) return fail(400, "Invalid order_by");
    const limit = Number(q.get("limit") ?? 30);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(400, "Invalid limit");
    const decoded = q.get("cursor") === null ? "offset:0" : Buffer.from(q.get("cursor")!, "base64url").toString("utf8");
    if (!/^offset:\d{1,6}$/.test(decoded)) return fail(400, "Invalid cursor");
    const offset = Number(decoded.slice(7));
    reads.push({ kind, query: Object.fromEntries(q) });
    const [field, way] = order.split(":") as [string, string];
    const rows = select(q).sort((a, b) => (way === "asc" ? 1 : -1) * (stamp(a, field) - stamp(b, field)) || Number(a.id) - Number(b.id));
    const page = rows.slice(offset, offset + limit);
    const cursor = (at: number) => Buffer.from(`offset:${at}`).toString("base64url");
    const meta = { prev_cursor: offset > 0 ? cursor(Math.max(0, offset - limit)) : null, next_cursor: offset + limit < rows.length ? cursor(offset + limit) : null };
    return { status: 200, body: { object: "list", uri: request.url.pathname, data: page, meta } };
  };

  const api = checkDocMock({
    integration: "gorgias",
    baseUrl: `https://${GORGIAS_TEST_DOMAIN}.gorgias.com`,
    source: { url: GORGIAS_DOC_PAGES.pagination, title: "Gorgias developer docs: OAuth2, scopes, pagination, List tickets and List messages", retrievedOn: "2026-11-11" },
    assumptions: [
      "The refresh token grant takes the app's client id and secret as Basic auth, as the code exchange does",
      "The token's scope lists the app's scopes separated by spaces",
      "A new message or a status change moves its ticket's updated_datetime",
      "Times without an offset are UTC",
      "A page cursor stays good while tickets change",
      "satisfaction_survey.score is a whole number from 1 to 5",
    ],
    routes: [
      { method: "POST", path: "/oauth/token", documentedAt: GORGIAS_DOC_PAGES.oauth, respond: token },
      {
        method: "GET",
        path: "/api/tickets",
        documentedAt: GORGIAS_DOC_PAGES.tickets,
        respond: list("tickets", ["order_by", "cursor", "limit", "customer_id", "trashed", "view_id"], ["created_datetime:desc", "created_datetime:asc", "updated_datetime:asc", "updated_datetime:desc"], () => data.tickets ?? []),
      },
      {
        method: "GET",
        path: "/api/messages",
        documentedAt: GORGIAS_DOC_PAGES.messages,
        respond: list("messages", ["cursor", "limit", "order_by", "ticket_id"], ["created_datetime:desc", "created_datetime:asc"], (q) => (data.messages ?? []).filter((m) => q.get("ticket_id") === null || String(m.ticket_id) === q.get("ticket_id"))),
      },
    ],
  });
  return {
    api,
    fetch: docMockFetch(api),
    get reads() {
      return reads;
    },
    get signIns() {
      return signIns;
    },
    revokeTokens: () => tokens.clear(),
  };
}

export default {
  integration: "gorgias",
  covers: "Gorgias's OAuth token, List tickets and List messages",
  watchPages: [GORGIAS_DOC_PAGES.pagination, GORGIAS_DOC_PAGES.oauth, GORGIAS_DOC_PAGES.tickets, GORGIAS_DOC_PAGES.messages],
  docMocks: () => [gorgiasDocMock({ clientId: "", clientSecret: "", refreshToken: "" }).api],
} satisfies DocMockModule;
