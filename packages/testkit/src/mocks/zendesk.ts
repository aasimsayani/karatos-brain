import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * Zendesk's OAuth token endpoint and its cursor-based incremental ticket and
 * user exports, built from Zendesk's developer docs. Data is synthetic.
 * Zendesk trials are a vendor account, so a client's connection replaces
 * this mock on the first live run.
 *
 * Docs facts the mock relies on:
 * - POST https://{subdomain}.zendesk.com/oauth/tokens takes JSON with
 *   grant_type=refresh_token, the refresh token, client_id, client_secret
 *   and an optional space-separated scope and refresh_token_expires_in (up
 *   to 7,776,000 seconds), and answers access_token, expires_in,
 *   refresh_token, refresh_token_expires_in, scope and token_type; it
 *   invalidates the previous access and refresh tokens (grant_type_tokens,
 *   refresh-token).
 * - GET /api/v2/incremental/tickets/cursor and /users/cursor take
 *   start_time (at least a minute back) on the first request and cursor
 *   after it, with per_page up to 1,000, and answer the records under
 *   tickets or users with after_cursor, before_cursor and end_of_stream
 *   (incremental_exports).
 * - Past 10 requests a minute Zendesk answers 429 with Retry-After
 *   (incremental_exports).
 */
const DOCS = "https://developer.zendesk.com";
export const ZENDESK_DOC_PAGES = {
  exports: `${DOCS}/api-reference/ticketing/ticket-management/incremental_exports/`,
  tokens: `${DOCS}/api-reference/ticketing/oauth/grant_type_tokens/`,
  refresh: `${DOCS}/documentation/api-basics/authentication/refresh-token`,
} as const;

export const ZENDESK_TEST_SUBDOMAIN = "teststore";
export const ZENDESK_TEST_AGENT = 7;

export type ZendeskMockRecord = Record<string, unknown>;

/** A customer's open email ticket, created and last changed `n` minutes into 2026. */
export const zendeskTicket = fixtureBuilder<ZendeskMockRecord>((n) => ({
  id: 100 + n,
  url: `https://${ZENDESK_TEST_SUBDOMAIN}.zendesk.com/api/v2/tickets/${100 + n}.json`,
  external_id: null,
  type: "question",
  subject: `Is my ring ready? (${synthetic.name(n)})`,
  description: `Hello, this is ${synthetic.name(n)}. Is my ring ready?`,
  priority: "normal",
  status: "open",
  requester_id: 500 + n,
  submitter_id: 500 + n,
  assignee_id: ZENDESK_TEST_AGENT,
  organization_id: null,
  group_id: 30,
  brand_id: 1,
  tags: ["repair"],
  via: { channel: "email", source: { from: { address: synthetic.email(n) } } },
  satisfaction_rating: { score: "unoffered" },
  custom_fields: [{ id: 1, value: synthetic.name(n) }],
  is_public: true,
  due_at: null,
  created_at: synthetic.isoTime(n).replace(/\.\d{3}Z$/, "Z"),
  updated_at: synthetic.isoTime(n).replace(/\.\d{3}Z$/, "Z"),
  generated_timestamp: Math.floor(Date.parse(synthetic.isoTime(n)) / 1000),
}));

/** A customer (an end user), made and last changed `n` minutes into 2026. */
export const zendeskUser = fixtureBuilder<ZendeskMockRecord>((n) => ({
  id: 500 + n,
  url: `https://${ZENDESK_TEST_SUBDOMAIN}.zendesk.com/api/v2/users/${500 + n}.json`,
  name: synthetic.name(n),
  email: synthetic.email(n),
  phone: null,
  role: "end-user",
  organization_id: null,
  tags: [],
  notes: "",
  details: "",
  verified: true,
  suspended: false,
  active: true,
  created_at: synthetic.isoTime(n).replace(/\.\d{3}Z$/, "Z"),
  updated_at: synthetic.isoTime(n).replace(/\.\d{3}Z$/, "Z"),
}));

export interface ZendeskMockData {
  clientId: string;
  clientSecret: string;
  /** The refresh token that works now; each refresh replaces it. */
  refreshToken: string;
  tickets?: ZendeskMockRecord[];
  users?: ZendeskMockRecord[];
  /** The scope the token answer lists. Defaults to the scopes asked for; null leaves it out. */
  scope?: string | null;
  /** 429s to answer before the next reads, with this Retry-After. */
  rateLimits?: number;
  retryAfter?: string;
  /** The access token's lifetime. Defaults to 1,800 seconds. */
  expiresIn?: number;
  now?: () => Date;
}

export interface ZendeskMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each export read: which one and its query. */
  readonly reads: { kind: string; query: Record<string, string> }[];
  readonly refreshes: number;
  /** The refresh token that works now. */
  readonly refreshToken: string;
  /** Each refresh's request body, as parsed. */
  readonly refreshBodies: Record<string, unknown>[];
  /** Makes the access tokens issued so far stop working, as when they expire early. */
  revokeTokens(): void;
}

const fail = (status: number, error: string, description: string): DocMockResponse => ({ status, body: { error, description } });
const stamp = (r: ZendeskMockRecord) => Date.parse(String(r.updated_at));

export function zendeskDocMock(data: ZendeskMockData): ZendeskMock {
  const reads: { kind: string; query: Record<string, string> }[] = [];
  const refreshBodies: Record<string, unknown>[] = [];
  const now = data.now ?? (() => new Date());
  let refreshes = 0;
  let current = data.refreshToken;
  let limits = data.rateLimits ?? 0;
  const tokens = new Set<string>();

  function token(request: DocMockRequest): DocMockResponse {
    if (!request.headers.get("content-type")?.startsWith("application/json")) return fail(400, "invalid_request", "The parameters must be formatted as JSON");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(request.body) as Record<string, unknown>;
    } catch {
      return fail(400, "invalid_request", "The body is not JSON");
    }
    refreshBodies.push(body);
    if (body.client_id !== data.clientId || body.client_secret !== data.clientSecret) return fail(401, "invalid_client", "Client authentication failed");
    if (body.grant_type !== "refresh_token") return fail(400, "unsupported_grant_type", "The grant type is not supported");
    if (body.refresh_token !== current) return fail(400, "invalid_grant", "The refresh token is invalid, expired or already used");
    const lifetime = body.refresh_token_expires_in ?? 2_592_000;
    if (typeof lifetime !== "number" || lifetime < 604_800 || lifetime > 7_776_000) return fail(400, "invalid_request", "refresh_token_expires_in is out of range");
    refreshes++;
    // The previous access and refresh tokens stop working.
    tokens.clear();
    const access = `zd-access-${refreshes}`;
    tokens.add(access);
    current = `zd-refresh-${refreshes}`;
    const scope = data.scope === undefined ? (typeof body.scope === "string" ? body.scope : "read") : data.scope;
    return {
      status: 201,
      body: { access_token: access, token_type: "bearer", expires_in: data.expiresIn ?? 1800, refresh_token: current, refresh_token_expires_in: lifetime, ...(scope === null ? {} : { scope }) },
    };
  }

  const exportOf = (kind: "tickets" | "users", rowsOf: () => ZendeskMockRecord[]) => (request: DocMockRequest): DocMockResponse => {
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!bearer || !tokens.has(bearer)) return fail(401, "invalid_token", "The access token provided is expired, revoked, malformed or invalid");
    if (limits > 0) {
      limits--;
      return { ...fail(429, "TooManyRequests", "Rate limit exceeded"), headers: data.retryAfter === undefined ? {} : { "Retry-After": data.retryAfter } };
    }
    const q = request.url.searchParams;
    for (const name of q.keys()) if (!["start_time", "cursor", "per_page", "exclude_deleted", "include"].includes(name)) return fail(400, "InvalidParameter", `Unknown parameter ${name}`);
    const perPage = Number(q.get("per_page") ?? 1000);
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 1000) return fail(400, "InvalidPaginationParameter", "per_page must be 1 to 1000");
    // A position is the last record's change time and id: what comes after it is newer.
    let after: [number, number];
    if (q.has("cursor") === q.has("start_time")) return fail(400, "InvalidParameter", "Give start_time on the first request and cursor after it");
    if (q.has("start_time")) {
      const start = Number(q.get("start_time"));
      if (!/^\d+$/.test(q.get("start_time")!) || start * 1000 > now().getTime() - 60_000) return fail(400, "InvalidValue", "start_time must be at least one minute in the past");
      after = [start * 1000 - 1, Number.MAX_SAFE_INTEGER];
    } else {
      const m = /^pos:(\d+):(\d+)$/.exec(Buffer.from(q.get("cursor")!, "base64url").toString("utf8"));
      if (!m) return fail(400, "InvalidCursor", "The cursor is invalid");
      after = [Number(m[1]), Number(m[2])];
    }
    reads.push({ kind, query: Object.fromEntries(q) });
    const rows = rowsOf()
      .filter((r) => stamp(r) > after[0] || (stamp(r) === after[0] && Number(r.id) > after[1]))
      .sort((a, b) => stamp(a) - stamp(b) || Number(a.id) - Number(b.id));
    const page = rows.slice(0, perPage);
    const last = page[page.length - 1];
    const position = last ? [stamp(last), Number(last.id)] : after;
    const cursor = Buffer.from(`pos:${position[0]}:${position[1]}`).toString("base64url");
    return { status: 200, body: { [kind]: page, after_url: null, after_cursor: cursor, before_url: null, before_cursor: null, end_of_stream: rows.length <= perPage } };
  };

  const api = checkDocMock({
    integration: "zendesk",
    baseUrl: `https://${ZENDESK_TEST_SUBDOMAIN}.zendesk.com`,
    source: { url: ZENDESK_DOC_PAGES.exports, title: "Zendesk developer docs: incremental exports, OAuth tokens for grant types and refresh tokens", retrievedOn: "2026-11-11", version: "Support API v2" },
    assumptions: [
      "A token made with tickets:read and users:read can read the cursor-based ticket and user exports",
      "A refresh that asks for scopes inside the original grant narrows the new token to them",
      "The token answer's scope lists the token's scopes separated by spaces",
      "Each export lists records oldest change first, and the last page's after_cursor picks up later changes",
      "Times are ISO 8601 in UTC with a Z",
      "satisfaction_rating.score is one of offered, unoffered, good and bad",
    ],
    routes: [
      { method: "POST", path: "/oauth/tokens", documentedAt: ZENDESK_DOC_PAGES.tokens, respond: token },
      { method: "GET", path: "/api/v2/incremental/tickets/cursor", documentedAt: ZENDESK_DOC_PAGES.exports, respond: exportOf("tickets", () => data.tickets ?? []) },
      { method: "GET", path: "/api/v2/incremental/users/cursor", documentedAt: ZENDESK_DOC_PAGES.exports, respond: exportOf("users", () => data.users ?? []) },
    ],
  });
  return {
    api,
    fetch: docMockFetch(api),
    get reads() {
      return reads;
    },
    get refreshes() {
      return refreshes;
    },
    get refreshToken() {
      return current;
    },
    get refreshBodies() {
      return refreshBodies;
    },
    revokeTokens: () => tokens.clear(),
  };
}

export default {
  integration: "zendesk",
  covers: "Zendesk's OAuth token refresh and its cursor-based ticket and user exports",
  watchPages: [ZENDESK_DOC_PAGES.exports, ZENDESK_DOC_PAGES.tokens],
  docMocks: () => [zendeskDocMock({ clientId: "", clientSecret: "", refreshToken: "" }).api],
} satisfies DocMockModule;
