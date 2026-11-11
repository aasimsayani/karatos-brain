import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * RingCentral's JWT sign-in, an extension's call log and its message store
 * (REST API v1.0), built from RingCentral's developer guide. Data is
 * synthetic. RingCentral's developer sandbox needs an account, so a
 * client's credential replaces this mock on the first live run.
 *
 * Docs facts the mock relies on:
 * - POST https://platform.ringcentral.com/restapi/oauth/token, with the
 *   app's client id and secret as Basic auth, takes grant_type
 *   urn:ietf:params:oauth:grant-type:jwt-bearer and the JWT as assertion,
 *   and answers access_token, token_type, expires_in, refresh_token, scope
 *   and owner_id (jwt-flow).
 * - Read-only permissions are ReadAccounts, ReadCallLog, ReadCallRecording,
 *   ReadContacts, ReadMessages and ReadPresence; the others can send,
 *   call or change things (permissions).
 * - GET /restapi/v1.0/account/~/extension/~/call-log is scoped to the
 *   signed-in user, takes dateFrom, dateTo, view (Simple by default),
 *   type and direction, and lists records with id, sessionId, startTime,
 *   duration, type, direction, action, result, from and to (call-log/api).
 * - GET /restapi/v1.0/account/~/extension/~/message-store takes dateFrom,
 *   dateTo, messageType (more than once), perPage and page, and answers
 *   records with paging {page, totalPages, perPage, ...} and navigation
 *   links; a record has id, type, creationTime, lastModifiedTime,
 *   direction, from, to, subject, readStatus, availability, messageStatus,
 *   conversationId, attachments (vmDuration for a voicemail) and
 *   vmTranscriptionStatus (working-with-message-store).
 */
const GUIDE = "https://developers.ringcentral.com/guide";
export const RINGCENTRAL_DOC_PAGES = {
  permissions: `${GUIDE}/basics/permissions`,
  jwt: `${GUIDE}/authentication/jwt-flow`,
  callLog: `${GUIDE}/voice/call-log/api`,
  messages: `${GUIDE}/messaging/message-store/working-with-message-store`,
} as const;

/** The store's own number in fixtures: a 555-01xx number, reserved for fiction. */
export const RINGCENTRAL_TEST_NUMBER = "+12125550199";
/** A customer number, 555-0100 to 555-0198, never the store's. */
export const ringCentralCustomerNumber = (n: number) => `+1212555${String(100 + (n % 99)).padStart(4, "0")}`;

export type RingCentralMockRecord = Record<string, unknown>;

/** An answered incoming call from a customer, `n` minutes into 2026. */
export const ringCentralCall = fixtureBuilder<RingCentralMockRecord>((n) => ({
  uri: `https://platform.ringcentral.com/restapi/v1.0/account/1/extension/1/call-log/CLtest${n}`,
  id: `CLtest${n}`,
  sessionId: String(500 + n),
  telephonySessionId: `s-test-${n}`,
  startTime: synthetic.isoTime(n),
  duration: 240,
  type: "Voice",
  direction: "Inbound",
  action: "Phone Call",
  result: "Accepted",
  from: { phoneNumber: ringCentralCustomerNumber(n), name: synthetic.name(n), location: "New York, NY" },
  to: { phoneNumber: RINGCENTRAL_TEST_NUMBER, name: "Store" },
}));

/** An incoming text from a customer, `n` minutes into 2026. */
export const ringCentralText = fixtureBuilder<RingCentralMockRecord>((n) => ({
  uri: `https://platform.ringcentral.com/restapi/v1.0/account/1/extension/1/message-store/${1000 + n}`,
  id: 1000 + n,
  type: "SMS",
  direction: "Inbound",
  from: { phoneNumber: ringCentralCustomerNumber(n), name: synthetic.name(n) },
  to: [{ phoneNumber: RINGCENTRAL_TEST_NUMBER }],
  subject: `Is my ring ready yet? This is ${synthetic.name(n)}.`,
  creationTime: synthetic.isoTime(n),
  lastModifiedTime: synthetic.isoTime(n),
  readStatus: "Unread",
  availability: "Alive",
  messageStatus: "Received",
  priority: "Normal",
  conversationId: 2000 + n,
  attachments: [{ id: 3000 + n, type: "Text", contentType: "text/plain" }],
}));

/** A voicemail from a customer, `n` minutes into 2026. */
export const ringCentralVoicemail = fixtureBuilder<RingCentralMockRecord>((n) => ({
  uri: `https://platform.ringcentral.com/restapi/v1.0/account/1/extension/1/message-store/${4000 + n}`,
  id: 4000 + n,
  type: "VoiceMail",
  direction: "Inbound",
  from: { phoneNumber: ringCentralCustomerNumber(n), name: synthetic.name(n) },
  to: [{ phoneNumber: RINGCENTRAL_TEST_NUMBER }],
  subject: `Voice Message from ${synthetic.name(n)}`,
  creationTime: synthetic.isoTime(n),
  lastModifiedTime: synthetic.isoTime(n),
  readStatus: "Unread",
  availability: "Alive",
  messageStatus: "Received",
  priority: "Normal",
  attachments: [{ id: 5000 + n, type: "AudioRecording", contentType: "audio/mpeg", vmDuration: 32 }],
  vmTranscriptionStatus: "Completed",
}));

export interface RingCentralMockData {
  clientId: string;
  clientSecret: string;
  jwt: string;
  calls?: RingCentralMockRecord[];
  messages?: RingCentralMockRecord[];
  /** The permissions the token says the app has. Defaults to ReadCallLog and ReadMessages. */
  scope?: string | null;
  /** 429s to answer before the next reads, with this Retry-After. */
  rateLimits?: number;
  retryAfter?: string;
  /** Answer 403 to these lists, as for an app without the permission. */
  forbidden?: ("calls" | "messages")[];
  /** Leave the next-page link or the page count out of list answers. */
  omit?: "nextPage" | "paging";
}

export interface RingCentralMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each read: the list and its query, with repeated parameters joined by commas. */
  readonly reads: { kind: string; query: Record<string, string> }[];
  readonly signIns: number;
  /** Makes the tokens issued so far stop working, as when they expire early. */
  revokeTokens(): void;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const fail = (status: number, errorCode: string, message: string): DocMockResponse => ({ status, body: { errorCode, message, errors: [{ errorCode, message }] } });

export function ringCentralDocMock(data: RingCentralMockData): RingCentralMock {
  const reads: { kind: string; query: Record<string, string> }[] = [];
  let signIns = 0;
  let limits = data.rateLimits ?? 0;
  const tokens = new Set<string>();

  function token(request: DocMockRequest): DocMockResponse {
    const basic = `Basic ${Buffer.from(`${data.clientId}:${data.clientSecret}`).toString("base64")}`;
    if (request.headers.get("authorization") !== basic) return { status: 401, body: { error: "invalid_client", errors: [{ errorCode: "OAU-123", message: "Invalid client" }], error_description: "Invalid client" } };
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return { status: 415, body: { error: "unsupported_media_type" } };
    const form = new URLSearchParams(request.body);
    if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return { status: 400, body: { error: "unsupported_grant_type", errors: [{ errorCode: "OAU-250", message: "Unsupported grant type" }] } };
    if (form.get("assertion") !== data.jwt) return { status: 400, body: { error: "invalid_grant", errors: [{ errorCode: "OAU-251", message: "Invalid assertion" }] } };
    signIns++;
    const access = `rc-token-${signIns}`;
    tokens.add(access);
    const scope = data.scope === undefined ? "ReadCallLog ReadMessages" : data.scope;
    return { status: 200, body: { access_token: access, token_type: "bearer", expires_in: 3600, refresh_token: `rc-refresh-${signIns}`, refresh_token_expires_in: 604800, ...(scope === null ? {} : { scope }), owner_id: "100" } };
  }

  const list = (kind: "calls" | "messages", path: string, documentedAt: string, allowed: string[], timeOf: string) => ({
    method: "GET" as const,
    path,
    documentedAt,
    respond(request: DocMockRequest): DocMockResponse {
      const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!bearer || !tokens.has(bearer)) return fail(401, "TokenInvalid", "Access token is invalid");
      if (limits > 0) {
        limits--;
        return { ...fail(429, "CMN-301", "Request rate exceeded"), headers: data.retryAfter === undefined ? {} : { "Retry-After": data.retryAfter } };
      }
      if (data.forbidden?.includes(kind)) return fail(403, "CMN-408", "In order to call this API endpoint, application needs to have the permission");
      const params = request.url.searchParams;
      for (const name of params.keys()) if (!allowed.includes(name)) return fail(400, "CMN-101", `Parameter [${name}] value is invalid`);
      const from = params.get("dateFrom");
      const until = params.get("dateTo");
      if ((from !== null && !ISO.test(from)) || (until !== null && !ISO.test(until))) return fail(400, "CMN-101", "Parameter [dateFrom] value is invalid");
      const perPage = Number(params.get("perPage") ?? 100);
      const page = Number(params.get("page") ?? 1);
      if (!Number.isInteger(perPage) || perPage < 1 || perPage > 1000 || !Number.isInteger(page) || page < 1) return fail(400, "CMN-101", "Parameter [perPage] value is invalid");
      const types = params.getAll("messageType");
      reads.push({ kind, query: Object.fromEntries([...new Set(params.keys())].map((k) => [k, params.getAll(k).join(",")])) });
      const at = (r: RingCentralMockRecord) => Date.parse(String(r[timeOf]));
      const rows = ((kind === "calls" ? data.calls : data.messages) ?? [])
        .filter((r) => types.length === 0 || types.includes(String(r.type)))
        .filter((r) => (from === null || at(r) >= Date.parse(from)) && (until === null || at(r) <= Date.parse(until)))
        .sort((a, b) => at(b) - at(a));
      const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
      const records = rows.slice((page - 1) * perPage, page * perPage);
      const link = (p: number) => ({ uri: `${request.url.origin}${request.url.pathname}?page=${p}&perPage=${perPage}` });
      const navigation = { firstPage: link(1), ...(page < totalPages && data.omit !== "nextPage" ? { nextPage: link(page + 1) } : {}), ...(page > 1 ? { previousPage: link(page - 1) } : {}), lastPage: link(totalPages) };
      const paging = { page, totalPages, perPage, totalElements: rows.length, pageStart: (page - 1) * perPage, pageEnd: (page - 1) * perPage + records.length - 1 };
      return { status: 200, body: { uri: request.url.toString(), records, navigation, ...(data.omit === "paging" ? {} : { paging }) } };
    },
  });

  const api = checkDocMock({
    integration: "ringcentral",
    baseUrl: "https://platform.ringcentral.com",
    source: { url: RINGCENTRAL_DOC_PAGES.permissions, title: "RingCentral developer guide: permissions, JWT flow, call log and message store", retrievedOn: "2026-11-11", version: "v1.0" },
    assumptions: [
      "The token's scope lists its permissions separated by spaces",
      "The call log pages with perPage and page and answers paging and navigation like the message store",
      "A list's navigation has a nextPage link on every page but the last",
      "An incoming call nobody picked up has a result of Missed, Voicemail, Rejected, Busy, No Answer, Hang Up, Abandoned or Declined",
      "A call or message's changes (ended, read, deleted) come within a day of it starting",
    ],
    routes: [
      { method: "POST", path: "/restapi/oauth/token", documentedAt: RINGCENTRAL_DOC_PAGES.jwt, respond: token },
      list("calls", "/restapi/v1.0/account/~/extension/~/call-log", RINGCENTRAL_DOC_PAGES.callLog, ["dateFrom", "dateTo", "view", "type", "direction", "perPage", "page"], "startTime"),
      list("messages", "/restapi/v1.0/account/~/extension/~/message-store", RINGCENTRAL_DOC_PAGES.messages, ["dateFrom", "dateTo", "messageType", "perPage", "page", "availability", "readStatus"], "creationTime"),
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
  integration: "ringcentral",
  covers: "RingCentral's JWT sign-in, an extension's call log and its message store (REST API v1.0)",
  watchPages: [RINGCENTRAL_DOC_PAGES.permissions, RINGCENTRAL_DOC_PAGES.jwt, RINGCENTRAL_DOC_PAGES.callLog, RINGCENTRAL_DOC_PAGES.messages],
  docMocks: () => [ringCentralDocMock({ clientId: "", clientSecret: "", jwt: "" }).api],
} satisfies DocMockModule;
