import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Microsoft's client credentials sign-in and Microsoft Graph's mail and
 * calendar deltas (v1.0) for one Exchange Online mailbox, built from the
 * Microsoft identity platform, Graph and Exchange reference pages. Data is
 * synthetic.
 *
 * Docs facts the mock relies on:
 * - `GET /users/{id}/mailFolders/{id}/messages/delta` takes `$select`,
 *   `$top` and `$filter=receivedDateTime ge|gt {time}` on its first request,
 *   and nothing else; later requests carry only the `$skiptoken` of an
 *   `@odata.nextLink` or the `$deltatoken` of the `@odata.deltaLink` that
 *   ends a round. The links write the folder as `mailFolders('{id}')`.
 * - `GET /users/{id}/calendarView/delta` takes `startDateTime` and
 *   `endDateTime` on its first request, which the tokens then carry. It
 *   doesn't support `$select`, so every event comes whole.
 * - A deleted item comes as its id with `@removed: { reason: "deleted" }`;
 *   a message moved out of the folder too, and a calendar event changed
 *   outside the window too.
 * - `Prefer: odata.maxpagesize={x}` sets the page size; `Prefer:
 *   IdType="ImmutableId"` asks for ids that don't change when an item moves.
 * - Mail.ReadBasic leaves out body, bodyPreview, uniqueBody, attachments,
 *   extensions and extended properties.
 * - RBAC for Applications scopes an app to some mailboxes; any other
 *   answers 403.
 */
const LOGIN = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
const MESSAGE_DELTA = "https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0";
const EVENT_DELTA = "https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0";
const CLIENT_CREDENTIALS = "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow";

export type OutlookMockRecord = Record<string, unknown>;
export type OutlookMockFolder = "inbox" | "sentitems";
const at = (n: number) => new Date(Date.parse("2026-10-01T09:00:00Z") + n * 86_400_000).toISOString().replace(".000", "");
const id = (prefix: string, n: number) => `AAMkAD${prefix}${String(n).padStart(20, "0")}AAA=`;
const person = (address: string, name: string) => ({ emailAddress: { name, address } });
const utc = (iso: string) => ({ dateTime: iso.replace("Z", ".0000000"), timeZone: "UTC" });

/** A customer's message about a ring, received `n` days into October 2026. */
export const outlookMessage = fixtureBuilder<OutlookMockRecord>((n) => ({
  id: id("msg", n),
  conversationId: id("cnv", n),
  internetMessageId: `<test-${n}@mail.test>`,
  createdDateTime: at(n),
  lastModifiedDateTime: at(n),
  receivedDateTime: at(n),
  sentDateTime: at(n),
  subject: `Test ring resize for order ${1000 + n}`,
  bodyPreview: "Test preview of a ring size 6",
  body: { contentType: "html", content: "<p>Test body: ring size 6</p>" },
  importance: "normal",
  isRead: false,
  isDraft: false,
  hasAttachments: n % 2 === 0,
  categories: ["Test customer"],
  from: person(`customer${n}@example.test`, `Test Customer ${n}`),
  sender: person(`customer${n}@example.test`, `Test Customer ${n}`),
  toRecipients: [person("sales@store.test", "Test Store")],
  ccRecipients: [],
  bccRecipients: [],
  replyTo: [],
  webLink: `https://outlook.office365.com/owa/?ItemID=${n}`,
}));

/** A one-hour fitting appointment `n` days into October 2026. */
export const outlookEvent = fixtureBuilder<OutlookMockRecord>((n) => ({
  id: id("evt", n),
  createdDateTime: at(n - 1),
  lastModifiedDateTime: at(n),
  iCalUId: `TEST${n}`,
  subject: `Test fitting for customer ${n}`,
  bodyPreview: "Test notes: bring the ring",
  body: { contentType: "html", content: "<p>Test notes: bring the ring</p>" },
  location: { displayName: "Test Store, 1 Test St" },
  start: utc(at(n)),
  end: utc(new Date(Date.parse(at(n)) + 3_600_000).toISOString().replace(".000", "")),
  isAllDay: false,
  isCancelled: false,
  isOnlineMeeting: false,
  onlineMeeting: null,
  showAs: "busy",
  type: "singleInstance",
  seriesMasterId: null,
  categories: ["Test customer"],
  organizer: person("sales@store.test", "Test Store"),
  attendees: [{ type: "required", status: { response: "accepted", time: at(n - 1) }, emailAddress: { name: `Test Customer ${n}`, address: `customer${n}@example.test` } }],
}));

export interface OutlookMockData {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The one mailbox the app's role assignments are scoped to. */
  mailbox: string;
  /** The application permissions the app was given in Entra, as the token's roles claim lists them; null leaves the claim out. */
  roles?: string[] | null;
  messages?: Partial<Record<OutlookMockFolder, OutlookMockRecord[]>>;
  events?: OutlookMockRecord[];
  /** Items per page the mock caps at, to exercise paging. */
  pageCap?: number;
  /** How many of the next requests answer 429, with Retry-After `retryAfter` (default 1). */
  rateLimited?: number;
  retryAfter?: string;
  /** The roles Exchange gave the app for the mailbox. Defaults to both. */
  grants?: ("mail" | "calendar")[];
}

export interface OutlookMock {
  login: DocMock;
  graph: DocMock;
  fetch: DocMockFetch;
  /** Adds or changes a message in a folder. */
  putMessage(folder: OutlookMockFolder, message: OutlookMockRecord): void;
  /** Deletes a message from a folder, or moves it out. */
  removeMessage(folder: OutlookMockFolder, id: string): void;
  putEvent(event: OutlookMockRecord): void;
  removeEvent(id: string): void;
  /** Makes every skip and delta token handed out so far answer 410 Gone. */
  expireTokens(): void;
  /** Makes every access token handed out so far stop working. */
  revokeTokens(): void;
  readonly signIns: number;
  /** Every Prefer header Graph was sent. */
  readonly prefers: string[];
}

type Lane = OutlookMockFolder | "calendar";
type Change = { lane: Lane; id: string; item: OutlookMockRecord | null };
/** A token read back: its lane, generation, the log position it lists or follows from, where a round ends, the offset, whether it is a listing, and the first request's options. */
type Token = { kind?: string; lane: Lane; g: number; at: number; end: number | null; offset: number; listing: boolean; select: string | null; since: string | null; start: string | null; stop: string | null };
const BASIC_HIDDEN = new Set(["body", "bodyPreview", "uniqueBody", "attachments", "extensions", "singleValueExtendedProperties", "multiValueExtendedProperties"]);
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$/;
const graphError = (status: number, code: string, message: string, headers?: Record<string, string>): DocMockResponse => ({ status, body: { error: { code, message, innerError: { date: "2026-11-11T12:00:00", "request-id": "00000000-0000-4000-8000-000000000000" } } }, ...(headers ? { headers } : {}) });
const loginError = (status: number, error: string, code: number): DocMockResponse => ({ status, body: { error, error_description: `AADSTS${code}: synthetic.`, error_codes: [code], timestamp: "2026-11-11 12:00:00Z", trace_id: "00000000-0000-4000-8000-000000000000", correlation_id: "00000000-0000-4000-8000-000000000000" } });
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const removed = (lane: Lane, itemId: string) => ({ "@odata.type": lane === "calendar" ? "#microsoft.graph.event" : "#microsoft.graph.message", id: itemId, "@removed": { reason: "deleted" } });
const startOf = (e: OutlookMockRecord, key: "start" | "end") => Date.parse(`${(e[key] as { dateTime: string }).dateTime.slice(0, 19)}Z`);

export function outlookDocMock(data: OutlookMockData): OutlookMock {
  const tokens = new Set<string>();
  const log: Change[] = [];
  const prefers: string[] = [];
  let signIns = 0;
  let generation = 0;
  let limits = data.rateLimited ?? 0;
  const grants = new Set(data.grants ?? ["mail", "calendar"]);
  for (const folder of ["inbox", "sentitems"] as const) for (const m of data.messages?.[folder] ?? []) log.push({ lane: folder, id: String(m.id), item: m });
  for (const e of data.events ?? []) log.push({ lane: "calendar", id: String(e.id), item: e });

  /** The lane's items as they stood at a log position. */
  const snapshot = (lane: Lane, upTo: number) => {
    const state = new Map<string, OutlookMockRecord>();
    for (const c of log.slice(0, upTo)) {
      if (c.lane !== lane) continue;
      state.delete(c.id);
      if (c.item) state.set(c.id, c.item);
    }
    return [...state.values()];
  };
  /** What changed in a lane in (from, to], each item once in its latest state. */
  const changes = (lane: Lane, from: number, to: number) => {
    const last = new Map<string, Change>();
    for (const c of log.slice(from, to)) {
      if (c.lane !== lane) continue;
      last.delete(c.id);
      last.set(c.id, c);
    }
    return [...last.values()];
  };
  const inWindow = (t: Token, e: OutlookMockRecord) => startOf(e, "start") < Date.parse(t.stop!) && startOf(e, "end") > Date.parse(t.start!);
  const shown = (t: Token, item: OutlookMockRecord) => {
    if (t.lane === "calendar") return item;
    const fields = Object.entries(item).filter(([k]) => !BASIC_HIDDEN.has(k) && (t.select === null || k === "id" || t.select.split(",").includes(k)));
    return Object.fromEntries(fields);
  };
  const keep = (t: Token, item: OutlookMockRecord) => (t.lane === "calendar" ? inWindow(t, item) : t.since === null || Date.parse(String(item.receivedDateTime)) >= Date.parse(t.since));
  const link = (t: Token, key: "$skiptoken" | "$deltatoken") => {
    const marked = { ...t, kind: key };
    const path = t.lane === "calendar" ? `/users/${encodeURIComponent(data.mailbox)}/calendarView/delta` : `/users/${encodeURIComponent(data.mailbox)}/mailFolders('${t.lane}')/messages/delta`;
    return `${GRAPH}${path}?${key}=${b64url(marked)}`;
  };
  const decode = (raw: string): Token | null => {
    try {
      const t = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Token;
      return typeof t.g === "number" && typeof t.at === "number" && typeof t.offset === "number" && typeof t.listing === "boolean" ? t : null;
    } catch {
      return null;
    }
  };
  function page(t: Token, size: number): DocMockResponse {
    const end = t.end ?? log.length;
    const all = t.listing
      ? snapshot(t.lane, t.at).filter((i) => keep(t, i)).map((i) => shown(t, i))
      : changes(t.lane, t.at, end).map((c) => (c.item && keep(t, c.item) ? shown(t, c.item) : removed(t.lane, c.id)));
    const rows = all.slice(t.offset, t.offset + size);
    const offset = t.offset + rows.length;
    const more = offset < all.length;
    const nextLink = more ? { "@odata.nextLink": link({ ...t, end: t.listing ? t.end : end, offset }, "$skiptoken") } : { "@odata.deltaLink": link({ ...t, at: t.listing ? t.at : end, end: null, offset: 0, listing: false }, "$deltatoken") };
    return { status: 200, body: { "@odata.context": `${GRAPH}/$metadata#Collection(${t.lane === "calendar" ? "event" : "message"})`, value: rows, ...nextLink } };
  }

  const login = checkDocMock({
    integration: "microsoft_outlook",
    baseUrl: LOGIN,
    source: { url: CLIENT_CREDENTIALS, title: "Microsoft identity platform and the OAuth 2.0 client credentials flow", retrievedOn: "2026-11-11", version: "v2.0" },
    assumptions: [
      "A client credentials token for https://graph.microsoft.com/.default is a JWT whose roles claim lists the application permissions an admin consented to in Entra, and leaves the claim out when there are none; Exchange's RBAC for Applications roles aren't listed in it",
      "A wrong or expired client secret answers 401 invalid_client with error code 7000215, an unknown app 400 unauthorized_client with 700016, and an unknown tenant 400 invalid_request with 90002",
    ],
    routes: [
      {
        method: "POST",
        path: "/{tenant}/oauth2/v2.0/token",
        documentedAt: CLIENT_CREDENTIALS,
        respond(request, params) {
          const form = new URLSearchParams(request.body);
          if (params.tenant !== data.tenantId) return loginError(400, "invalid_request", 90002);
          if (form.get("grant_type") !== "client_credentials") return loginError(400, "unsupported_grant_type", 70003);
          if (form.get("client_id") !== data.clientId) return loginError(400, "unauthorized_client", 700016);
          if (form.get("client_secret") !== data.clientSecret) return loginError(401, "invalid_client", 7000215);
          if (form.get("scope") !== "https://graph.microsoft.com/.default") return loginError(400, "invalid_scope", 1002012);
          signIns++;
          const claims = { aud: "https://graph.microsoft.com", iss: `https://sts.windows.net/${data.tenantId}/`, appid: data.clientId, tid: data.tenantId, n: signIns, ...(data.roles ? { roles: data.roles } : {}) };
          const token = `${b64url({ typ: "JWT", alg: "RS256" })}.${b64url(claims)}.${"s".repeat(43)}`;
          tokens.add(token);
          return { status: 200, body: { token_type: "Bearer", expires_in: 3599, ext_expires_in: 3599, access_token: token } };
        },
      },
    ],
  });

  /** Checks the token, throttling and scope, then answers a first request or one with a token. */
  function answer(request: { headers: Headers; url: URL }, user: string, lane: Lane, first: (q: URLSearchParams) => Token | DocMockResponse): DocMockResponse {
    if (!tokens.has(request.headers.get("authorization")!.slice("Bearer ".length))) return graphError(401, "InvalidAuthenticationToken", "Access token has expired or is not yet valid.");
    if (limits > 0) {
      limits--;
      return graphError(429, "ApplicationThrottled", "Application is over its MailboxConcurrency limit.", { "Retry-After": data.retryAfter ?? "1" });
    }
    const prefer = request.headers.get("prefer") ?? "";
    prefers.push(prefer);
    if (user.toLowerCase() !== data.mailbox.toLowerCase() || !grants.has(lane === "calendar" ? "calendar" : "mail")) return graphError(403, "ErrorAccessDenied", "Access is denied. Check credentials and try again.");
    const max = /odata\.maxpagesize=(\d{1,4})/.exec(prefer);
    const size = Math.min(max ? Number(max[1]) : 1000, data.pageCap ?? 1000);
    const q = request.url.searchParams;
    const keys = [...q.keys()];
    const raw = q.get("$skiptoken") ?? q.get("$deltatoken");
    if (raw !== null) {
      if (keys.length !== 1) return graphError(400, "ErrorInvalidUrlQuery", "The query parameter isn't supported with a state token.");
      const t = decode(raw);
      if (!t || t.lane !== lane || t.kind !== keys[0]) return graphError(400, "ErrorInvalidUrlQuery", "The state token is invalid.");
      if (t.g !== generation) return graphError(410, "SyncStateNotFound", "The sync state is no longer valid.");
      return page(t, size);
    }
    const t = first(q);
    return "status" in t ? t : page(t, size);
  }

  const graph = checkDocMock({
    integration: "microsoft_outlook",
    baseUrl: GRAPH,
    source: { url: MESSAGE_DELTA, title: "message: delta", retrievedOn: "2026-11-11", version: "v1.0" },
    auth: "bearer",
    assumptions: [
      "A message delta with $filter on receivedDateTime lists only messages received from then, and its later rounds keep the filter",
      "A message's id stays the same between rounds when Prefer: IdType=\"ImmutableId\" is sent",
      "An expired skip or delta token answers 410 Gone with code SyncStateNotFound",
      "A mailbox outside the app's RBAC scope, or a role it wasn't assigned, answers 403 ErrorAccessDenied; a 429 carries Retry-After as whole seconds",
      "With no Prefer: outlook.timezone, an event's start and end come in UTC with seven fraction digits and no Z",
    ],
    routes: [
      {
        method: "GET",
        path: "/users/{user}/mailFolders/{folder}/messages/delta",
        documentedAt: MESSAGE_DELTA,
        respond(request, params) {
          const folder = params.folder!.toLowerCase();
          if (folder !== "inbox" && folder !== "sentitems") return graphError(404, "ErrorItemNotFound", "The specified object was not found in the store.");
          return answer(request, params.user!, folder, (q) => {
            if ([...q.keys()].some((k) => !["$select", "$filter", "$top"].includes(k))) return graphError(400, "ErrorInvalidUrlQuery", "The query parameter isn't supported.");
            const filter = q.get("$filter");
            const since = filter === null ? null : (/^receivedDateTime (?:ge|gt) (\S+)$/.exec(filter)?.[1] ?? "");
            if (since !== null && !UTC_TIME.test(since)) return graphError(400, "ErrorInvalidUrlQueryFilter", "The filter isn't supported on delta.");
            return { lane: folder, g: generation, at: log.length, end: null, offset: 0, listing: true, select: q.get("$select"), since, start: null, stop: null };
          });
        },
      },
      {
        method: "GET",
        path: "/users/{user}/calendarView/delta",
        documentedAt: EVENT_DELTA,
        respond(request, params) {
          return answer(request, params.user!, "calendar", (q) => {
            if ([...q.keys()].some((k) => !["startDateTime", "endDateTime"].includes(k))) return graphError(400, "ErrorInvalidUrlQuery", "The query parameter isn't supported.");
            const start = q.get("startDateTime") ?? "";
            const stop = q.get("endDateTime") ?? "";
            if (!UTC_TIME.test(start) || !UTC_TIME.test(stop)) return graphError(400, "ErrorInvalidParameter", "This request requires a time window specified by the query string parameters StartDateTime and EndDateTime.");
            return { lane: "calendar", g: generation, at: log.length, end: null, offset: 0, listing: true, select: null, since: null, start, stop };
          });
        },
      },
    ],
  });

  const loginFetch = docMockFetch(login);
  const graphFetch = docMockFetch(graph);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      // Routed by exact origin, so a look-alike host goes to the Graph mock and is refused there.
      const toLogin = new URL(input instanceof Request ? input.url : String(input)).origin === LOGIN;
      const response = await (toLogin ? loginFetch : graphFetch)(input, init);
      calls.push(...(toLogin ? loginFetch.calls : graphFetch.calls).slice(-1));
      return response;
    },
    { calls },
  );

  return {
    login,
    graph,
    fetch,
    putMessage: (folder, message) => void log.push({ lane: folder, id: String(message.id), item: message }),
    removeMessage: (folder, itemId) => void log.push({ lane: folder, id: itemId, item: null }),
    putEvent: (event) => void log.push({ lane: "calendar", id: String(event.id), item: event }),
    removeEvent: (itemId) => void log.push({ lane: "calendar", id: itemId, item: null }),
    expireTokens: () => void generation++,
    revokeTokens: () => tokens.clear(),
    get signIns() {
      return signIns;
    },
    prefers,
  };
}

export default {
  integration: "microsoft_outlook",
  covers: "Microsoft's client credentials sign-in and Microsoft Graph's message and calendar view deltas (v1.0) for one mailbox, enforcing Mail.ReadBasic's hidden fields, the RBAC scope, state tokens and the calendar window",
  watchPages: [CLIENT_CREDENTIALS, MESSAGE_DELTA, EVENT_DELTA],
  docMocks: () => {
    const mock = outlookDocMock({ tenantId: "", clientId: "", clientSecret: "", mailbox: "" });
    return [mock.login, mock.graph];
  },
} satisfies DocMockModule;
