import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockResponse, type DocMockModule } from "../doc-mock.js";

/**
 * The Gmail API's read endpoints and Google's OAuth token refresh, built from
 * Google's developer docs (Gmail API v1). Data is synthetic. A test Google
 * account replaces this mock with recordings once an OAuth client is set up.
 *
 * Facts taken from the docs, read on 2026-10-22:
 * - gmail.metadata is a restricted scope: "Read metadata (labels, headers)
 *   without message bodies". Restricted scopes need Google's verification,
 *   and a security assessment when the data is stored on servers.
 *   https://developers.google.com/workspace/gmail/api/auth/scopes
 * - messages.list: GET /gmail/v1/users/{userId}/messages, maxResults default
 *   100 and at most 500, pageToken, labelIds, includeSpamTrash; each message
 *   holds only id and threadId; q "cannot be used when accessing the api
 *   using the gmail.metadata scope".
 *   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
 * - messages.get: format and metadataHeaders ("When given and format is
 *   METADATA, only include headers specified"); full and raw "cannot be used"
 *   with gmail.metadata; metadata "Returns only email message ID, labels, and
 *   email headers". internalDate is epoch milliseconds as a string and
 *   "determines ordering in the inbox".
 *   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
 *   https://developers.google.com/workspace/gmail/api/reference/rest/v1/Format
 *   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
 * - labels.list returns id, name, messageListVisibility, labelListVisibility
 *   and type (system or user) only.
 *   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list
 * - history.list: startHistoryId required, maxResults default 100 and at most
 *   500, historyTypes messageAdded, messageDeleted, labelAdded, labelRemoved;
 *   messages in records typically hold only id and threadId; the response's
 *   historyId is the mailbox's current one; an invalid or out-of-date
 *   startHistoryId "typically returns an HTTP 404", after which the client
 *   should do a full sync. History is "typically available for at least one
 *   week and often longer" but may be "significantly shorter".
 *   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
 *   https://developers.google.com/workspace/gmail/api/guides/sync
 * - Quota: 6,000 units a minute per user per project, 1,200,000 per project;
 *   messages.get 20, messages.list 5, history.list 2, labels.list 1.
 *   https://developers.google.com/workspace/gmail/api/reference/quota
 * - Errors: { error: { code, message, errors: [{ domain, reason, message }] } };
 *   403 rateLimitExceeded, userRateLimitExceeded, dailyLimitExceeded,
 *   domainPolicy; 429 for per-user and concurrent limits; back off from 1s.
 *   https://developers.google.com/workspace/gmail/api/guides/handle-errors
 * - Token refresh: POST https://oauth2.googleapis.com/token with client_id,
 *   client_secret, grant_type=refresh_token and refresh_token; the response's
 *   scope lists the scopes granted. Refresh tokens stop working when revoked,
 *   after six months unused, on a password change for Gmail scopes, and after
 *   7 days for an External app in Testing; 100 live tokens per account per
 *   client, the oldest dropped silently.
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 *   https://developers.google.com/identity/protocols/oauth2
 * - Push needs users.watch with a Cloud Pub/Sub topic, renewed at least every
 *   7 days. Not modelled.
 *   https://developers.google.com/workspace/gmail/api/guides/push
 */
const DOCS = "https://developers.google.com/workspace/gmail/api";
const REST = `${DOCS}/reference/rest/v1`;
const API = "https://gmail.googleapis.com";
const OAUTH = "https://oauth2.googleapis.com";

export const GMAIL_MOCK_METADATA_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";

export interface GmailMockHeader {
  name: string;
  value: string;
}

export interface GmailMockMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  /** Epoch milliseconds, as a string. */
  internalDate: string;
  historyId: string;
  snippet: string;
  sizeEstimate: number;
  headers: GmailMockHeader[];
}

export interface GmailMockLabel {
  id: string;
  name: string;
  type: "system" | "user";
}

type Ref = { message: { id: string; threadId: string; labelIds?: string[] } };
export interface GmailMockHistory {
  id: string;
  messagesAdded?: Ref[];
  messagesDeleted?: Ref[];
  labelsAdded?: (Ref & { labelIds: string[] })[];
  labelsRemoved?: (Ref & { labelIds: string[] })[];
}

export interface GmailMockData {
  messages: GmailMockMessage[];
  labels: GmailMockLabel[];
  history?: GmailMockHistory[];
  /** Start ids below this answer 404, as when Gmail no longer keeps that much history. */
  historyFloor?: string;
  /** The mailbox's current history id. */
  historyId?: string;
  /** The refresh token the mailbox was connected with. */
  refreshToken: string;
  /** Scopes the connection was granted; gmail.metadata alone unless a test says otherwise. */
  scopes?: string[];
  /** Errors to answer before the next API reads, in order. */
  rateLimits?: { status: 403 | 429; reason?: string; retryAfter?: number }[];
}

/** Luhn's check, which assertSynthetic uses to flag card numbers; a 13-digit millisecond time can pass it by chance. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** Milliseconds for an ISO time, a millisecond or two later if needed so they never look like a card number. */
export function gmailInternalDate(iso: string): string {
  let ms = Date.parse(iso);
  while (luhn(String(ms))) ms += 1;
  return String(ms);
}

/** A 16-hex-digit id shaped like Gmail's. */
export const gmailId = (prefix: string, n: number) => `${prefix}${n.toString(16).padStart(16 - prefix.length, "0")}`;

/** Newest first: message 1 arrived an hour before the fixture clock, message 2 an hour before that, and so on. */
export const GMAIL_MOCK_NOW = "2026-01-20T00:00:00Z";

export const gmailMessage = fixtureBuilder<GmailMockMessage>((n) => ({
  id: gmailId("18d", n),
  threadId: gmailId("18d", n),
  labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
  internalDate: gmailInternalDate(new Date(Date.parse(GMAIL_MOCK_NOW) - n * 3_600_000).toISOString()),
  historyId: String(9000 + n),
  snippet: `Synthetic snippet ${n}: the ring is ready`,
  sizeEstimate: 4000 + n,
  headers: [
    { name: "From", value: `"${synthetic.name(n)}" <${synthetic.email(n)}>` },
    { name: "To", value: "Test Store <owner@store.test>" },
    { name: "Subject", value: `Synthetic subject ${n}: ring size 7, order TEST-${n}` },
    { name: "Date", value: "Mon, 19 Jan 2026 10:00:00 +0000" },
    { name: "Message-ID", value: `<synthetic-${n}@example.test>` },
  ],
}));

export const GMAIL_MOCK_LABELS: GmailMockLabel[] = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "DRAFT", name: "DRAFT", type: "system" },
  { id: "SPAM", name: "SPAM", type: "system" },
  { id: "CATEGORY_PERSONAL", name: "CATEGORY_PERSONAL", type: "system" },
  { id: "Label_1", name: "Bridal", type: "user" },
  { id: "Label_2", name: "Vendors", type: "user" },
];

const apiError = (code: number, message: string, reason: string, status: string): DocMockResponse => ({
  status: code,
  body: { error: { code, message, errors: [{ domain: "global", reason, message }], status } },
});
const notFound = () => apiError(404, "Requested entity was not found.", "notFound", "NOT_FOUND");
const badRequest = (message: string) => apiError(400, message, "invalidArgument", "INVALID_ARGUMENT");

const offsetToken = (offset: number) => Buffer.from(`offset:${offset}`).toString("base64url");
const tokenOffset = (token: string | null) => {
  if (token === null) return 0;
  const m = /^offset:(\d+)$/.exec(Buffer.from(token, "base64url").toString("utf8"));
  return m ? Number(m[1]) : Number.NaN;
};
const size = (raw: string | null, fallback: number) => Math.min(Math.max(Number(raw ?? fallback) || fallback, 1), 500);

export interface GmailMock {
  oauth: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  /** Refresh requests answered, failed ones included. */
  readonly refreshes: number;
  /** Revokes every access token, as when one is cut off before it expires. */
  revokeAccessTokens(): void;
  /** Ends the refresh token, as Google does seven days after a Testing-mode consent. */
  expireRefreshToken(): void;
}

export function gmailDocMock(data: GmailMockData): GmailMock {
  let issued = 0;
  let refreshes = 0;
  let refreshValid = true;
  const access = new Set<string>();
  const limits = [...(data.rateLimits ?? [])];
  const scopes = () => data.scopes ?? [GMAIL_MOCK_METADATA_SCOPE];
  const metadataOnly = () => !scopes().some((s) => ["https://mail.google.com/", "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.readonly"].includes(s));

  const oauth = checkDocMock({
    integration: "gmail",
    baseUrl: OAUTH,
    source: { url: "https://developers.google.com/identity/protocols/oauth2/web-server", title: "Using OAuth 2.0 for Web Server Applications", retrievedOn: "2026-10-22", version: "OAuth 2.0" },
    assumptions: [
      "A refresh answers access_token, expires_in, scope and token_type, and no new refresh_token: Google doesn't rotate refresh tokens. The docs page's sample refresh response couldn't be read, so this and the scope field on a refresh are unconfirmed",
      "Client credentials go in the form body; HTTP Basic isn't modelled",
      "An expired or revoked refresh token answers 400 invalid_grant",
    ],
    routes: [
      {
        method: "POST",
        path: "/token",
        documentedAt: "https://developers.google.com/identity/protocols/oauth2",
        respond(request) {
          refreshes++;
          const form = new URLSearchParams(request.body);
          if (!form.get("client_id") || !form.get("client_secret")) return { status: 401, body: { error: "invalid_client", error_description: "Unauthorized" } };
          if (form.get("grant_type") !== "refresh_token" || !refreshValid || form.get("refresh_token") !== data.refreshToken) {
            return { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
          }
          issued++;
          const token = `AT-TEST-${issued}`;
          access.add(token);
          return { status: 200, body: { access_token: token, expires_in: 3599, scope: scopes().join(" "), token_type: "Bearer" } };
        },
      },
    ],
  });

  function guard(request: { headers: Headers; url: URL }): DocMockResponse | null {
    if (!access.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) return apiError(401, "Request had invalid authentication credentials.", "authError", "UNAUTHENTICATED");
    if (request.url.searchParams.has("access_token")) return badRequest("access_token in the query is not modelled");
    const limit = limits.shift();
    if (limit) {
      const reason = limit.reason ?? "rateLimitExceeded";
      const response = apiError(limit.status, limit.status === 429 ? "Too many concurrent requests for user" : reason, reason, "RESOURCE_EXHAUSTED");
      return limit.retryAfter ? { ...response, headers: { "retry-after": String(limit.retryAfter) } } : response;
    }
    return null;
  }

  const sorted = () => [...data.messages].sort((a, b) => Number(b.internalDate) - Number(a.internalDate) || (a.id < b.id ? 1 : -1));

  const api = checkDocMock({
    integration: "gmail",
    baseUrl: `${API}/gmail/v1`,
    source: { url: `${REST}/users.messages/list`, title: "Gmail API reference", retrievedOn: "2026-10-22", version: "v1" },
    auth: "bearer",
    assumptions: [
      "messages.list returns messages newest first by internalDate; the docs don't state the order, only that internalDate determines ordering in the inbox and that the first message listed is the most recent",
      "messages.list includes drafts (DRAFT label) and leaves out SPAM and TRASH unless includeSpamTrash is set",
      "q with only gmail.metadata answers 403; the docs say it can't be used, not which error comes back",
      "format=full or raw with only gmail.metadata answers 403",
      "format=metadata still returns snippet, historyId, internalDate and sizeEstimate alongside the headers",
      "metadataHeaders match header names without regard to case",
      "Page tokens stay valid between runs, so an interrupted listing can resume from a saved one",
      "messages.get answers 404 for a message deleted after it was listed",
      "A 429 or 403 rate-limit answer may carry Retry-After in seconds",
    ],
    routes: [
      {
        method: "GET",
        path: "/users/{userId}/messages",
        documentedAt: `${REST}/users.messages/list`,
        respond(request) {
          const denied = guard(request);
          if (denied) return denied;
          const q = request.url.searchParams;
          if (q.has("q") && metadataOnly()) return apiError(403, "Metadata scope does not support 'q' parameter", "forbidden", "PERMISSION_DENIED");
          const offset = tokenOffset(q.get("pageToken"));
          if (Number.isNaN(offset)) return badRequest("Invalid pageToken");
          const spam = q.get("includeSpamTrash") === "true";
          const rows = sorted().filter((m) => spam || !m.labelIds.some((l) => l === "SPAM" || l === "TRASH"));
          const n = size(q.get("maxResults"), 100);
          const page = rows.slice(offset, offset + n);
          return {
            status: 200,
            body: {
              ...(page.length ? { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })) } : {}),
              ...(offset + n < rows.length ? { nextPageToken: offsetToken(offset + n) } : {}),
              resultSizeEstimate: rows.length,
            },
          };
        },
      },
      {
        method: "GET",
        path: "/users/{userId}/messages/{id}",
        documentedAt: `${REST}/users.messages/get`,
        respond(request, params) {
          const denied = guard(request);
          if (denied) return denied;
          const message = data.messages.find((m) => m.id === params.id);
          if (!message) return notFound();
          const format = (request.url.searchParams.get("format") ?? "full").toLowerCase();
          if (!["minimal", "full", "raw", "metadata"].includes(format)) return badRequest(`Invalid value at 'format'`);
          if ((format === "full" || format === "raw") && metadataOnly()) return apiError(403, `Metadata scope doesn't allow format ${format.toUpperCase()}`, "forbidden", "PERMISSION_DENIED");
          const wanted = request.url.searchParams.getAll("metadataHeaders").map((h) => h.toLowerCase());
          const headers = wanted.length ? message.headers.filter((h) => wanted.includes(h.name.toLowerCase())) : message.headers;
          const base = { id: message.id, threadId: message.threadId, labelIds: message.labelIds, snippet: message.snippet, historyId: message.historyId, internalDate: message.internalDate, sizeEstimate: message.sizeEstimate };
          if (format === "minimal") return { status: 200, body: { id: message.id, threadId: message.threadId, labelIds: message.labelIds, historyId: message.historyId, internalDate: message.internalDate, sizeEstimate: message.sizeEstimate } };
          if (format === "metadata") return { status: 200, body: { ...base, payload: { mimeType: "multipart/alternative", headers } } };
          return { status: 200, body: { ...base, payload: { mimeType: "text/plain", headers: message.headers, body: { size: 20, data: Buffer.from("Synthetic body").toString("base64url") } } } };
        },
      },
      {
        method: "GET",
        path: "/users/{userId}/labels",
        documentedAt: `${REST}/users.labels/list`,
        respond(request) {
          const denied = guard(request);
          if (denied) return denied;
          return { status: 200, body: { labels: data.labels.map((l) => ({ ...l, messageListVisibility: "show", labelListVisibility: "labelShow" })) } };
        },
      },
      {
        method: "GET",
        path: "/users/{userId}/history",
        documentedAt: `${REST}/users.history/list`,
        respond(request) {
          const denied = guard(request);
          if (denied) return denied;
          const q = request.url.searchParams;
          const start = q.get("startHistoryId");
          if (start === null || !/^\d+$/.test(start)) return badRequest("Invalid startHistoryId");
          if (data.historyFloor && BigInt(start) < BigInt(data.historyFloor)) return notFound();
          const types = new Set(q.getAll("historyTypes"));
          const kinds = { messageAdded: "messagesAdded", messageDeleted: "messagesDeleted", labelAdded: "labelsAdded", labelRemoved: "labelsRemoved" } as const;
          const records = (data.history ?? [])
            .filter((h) => BigInt(h.id) > BigInt(start))
            .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
            .map((h) => {
              const out: Record<string, unknown> = { id: h.id };
              for (const [type, field] of Object.entries(kinds)) if ((!types.size || types.has(type)) && h[field]?.length) out[field] = h[field];
              out.messages = [...(h.messagesAdded ?? []), ...(h.messagesDeleted ?? []), ...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])].map((r) => ({ id: r.message.id, threadId: r.message.threadId }));
              return out;
            })
            .filter((h) => Object.keys(h).length > 2);
          const offset = tokenOffset(q.get("pageToken"));
          if (Number.isNaN(offset)) return badRequest("Invalid pageToken");
          const n = size(q.get("maxResults"), 100);
          const page = records.slice(offset, offset + n);
          return {
            status: 200,
            body: {
              ...(page.length ? { history: page } : {}),
              ...(offset + n < records.length ? { nextPageToken: offsetToken(offset + n) } : {}),
              historyId: data.historyId ?? "10000",
            },
          };
        },
      },
    ],
  });

  const oauthFetch = docMockFetch(oauth);
  const apiFetch = docMockFetch(api);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      // Routed by exact origin, so a look-alike host goes to the API mock and is refused there.
      const toOauth = new URL(input instanceof Request ? input.url : String(input)).origin === OAUTH;
      const response = await (toOauth ? oauthFetch : apiFetch)(input, init);
      calls.push(...(toOauth ? oauthFetch.calls : apiFetch.calls).slice(-1));
      return response;
    },
    { calls },
  );
  return {
    oauth,
    api,
    fetch,
    get refreshes() {
      return refreshes;
    },
    revokeAccessTokens: () => access.clear(),
    expireRefreshToken: () => {
      refreshValid = false;
    },
  };
}

export default {
  integration: "gmail",
  covers: "Gmail's message, label and history reads with Google's token refresh (API v1)",
  watchPages: [
    "https://developers.google.com/identity/protocols/oauth2/web-server",
    "https://developers.google.com/identity/protocols/oauth2",
    "https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list",
    "https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get",
    "https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list",
    "https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list",
  ],
  docMocks: () => [gmailDocMock({ messages: [], labels: [], refreshToken: "" }).oauth, gmailDocMock({ messages: [], labels: [], refreshToken: "" }).api],
} satisfies DocMockModule;
