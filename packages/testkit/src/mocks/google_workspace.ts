import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * Google Drive v3 (files and changes), Sheets v4 (values.batchGet),
 * Calendar v3 (events.list) and Google's OAuth token refresh, built from
 * Google's developer docs. Data is synthetic. A test Google account replaces
 * this mock with recordings once an OAuth client is set up.
 *
 * Facts taken from the docs, read on 2026-10-22:
 * - drive.metadata.readonly: "View metadata for files in your Drive"; it is
 *   a restricted scope, as are drive.readonly ("View and download all your
 *   Drive files") and drive.
 *   https://developers.google.com/workspace/drive/api/guides/api-specific-auth
 * - files.list: GET /drive/v3/files; pageSize at most 1000; q, pageToken,
 *   supportsAllDrives, includeItemsFromAllDrives, corpora, driveId, spaces;
 *   all files are returned, trashed ones included, unless q has
 *   trashed = false; `'ID' in parents` matches direct children only, so
 *   folders are walked one at a time. Searches return only a subset of
 *   fields unless `fields` names them.
 *   https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
 *   https://developers.google.com/workspace/drive/api/guides/search-files
 *   https://developers.google.com/workspace/drive/api/guides/v3versusv2
 * - File: parents holds one folder; size is an int64 string, absent for
 *   folders and shortcuts; driveId only for shared drive items.
 *   https://developers.google.com/workspace/drive/api/reference/rest/v3/files
 * - changes.getStartPageToken: GET /drive/v3/changes/startPageToken, driveId
 *   and supportsAllDrives; the token doesn't expire. changes.list: GET
 *   /drive/v3/changes with pageToken, pageSize at most 1000, driveId,
 *   includeItemsFromAllDrives, includeRemoved, restrictToMyDrive, spaces;
 *   nextPageToken while there is more, newStartPageToken at the end; a
 *   Change has removed, file, fileId, time, driveId, changeType.
 *   Without supportsAllDrives no shared drive items are returned.
 *   https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list
 *   https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/getStartPageToken
 *   https://developers.google.com/workspace/drive/api/reference/rest/v3/changes
 *   https://developers.google.com/workspace/drive/api/guides/enable-shareddrives
 * - spreadsheets.values.batchGet: GET /v4/spreadsheets/{id}/values:batchGet
 *   with ranges repeated, majorDimension, valueRenderOption (default
 *   FORMATTED_VALUE), dateTimeRenderOption; valueRanges come back in the
 *   order asked. Scopes: drive, drive.readonly, drive.file, spreadsheets,
 *   spreadsheets.readonly (not drive.metadata.readonly). 60 reads a minute
 *   per user, 300 per project; 429 when exceeded.
 *   https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchGet
 *   https://developers.google.com/workspace/sheets/api/limits
 * - events.list: GET /calendar/v3/calendars/{calendarId}/events; maxResults
 *   default 250, at most 2500; syncToken can't be combined with timeMin,
 *   timeMax, updatedMin, q, orderBy, iCalUID or extended properties, and
 *   always includes deleted events; nextSyncToken only on the last page; an
 *   expired sync token answers 410 and the client lists again from scratch.
 *   A cancelled event in an incremental list is guaranteed only its id (and
 *   for an instance, recurringEventId and originalStartTime). Scopes include
 *   calendar.events.readonly. 600 requests a minute per user.
 *   https://developers.google.com/workspace/calendar/api/v3/reference/events/list
 *   https://developers.google.com/workspace/calendar/api/guides/sync
 *   https://developers.google.com/workspace/calendar/api/v3/reference/events
 *   https://developers.google.com/workspace/calendar/api/guides/quota
 * - Push: changes.watch and events.watch are POSTs that open a channel
 *   (id up to 64 characters, token up to 256, expiry at most a week for
 *   changes); notifications are empty POSTs with X-Goog-Channel-ID,
 *   X-Goog-Message-Number, X-Goog-Resource-ID, X-Goog-Resource-State,
 *   X-Goog-Resource-URI and, if set, X-Goog-Channel-Token, and no signature.
 *   Not modelled here: the connector doesn't open channels.
 *   https://developers.google.com/workspace/drive/api/guides/push
 *   https://developers.google.com/workspace/calendar/api/guides/push
 * - Token refresh: POST https://oauth2.googleapis.com/token with client_id,
 *   client_secret, grant_type=refresh_token and refresh_token; the response
 *   lists the scopes the access token holds, and users may grant only some
 *   of the scopes asked for, so the app must check.
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 */
const OAUTH = "https://oauth2.googleapis.com";
const DRIVE = "https://www.googleapis.com/drive/v3";
const SHEETS = "https://sheets.googleapis.com/v4";
const CALENDAR = "https://www.googleapis.com/calendar/v3";
const DRIVE_DOCS = "https://developers.google.com/workspace/drive/api/reference/rest/v3";
const CALENDAR_DOCS = "https://developers.google.com/workspace/calendar/api";

const AUTH = "https://www.googleapis.com/auth/";
export const GOOGLE_MOCK_SCOPES = [`${AUTH}drive.metadata.readonly`, `${AUTH}spreadsheets.readonly`, `${AUTH}calendar.events.readonly`];
export const GOOGLE_MOCK_FOLDER = "application/vnd.google-apps.folder";
const DRIVE_SCOPES = ["drive", "drive.readonly", "drive.metadata", "drive.metadata.readonly", "drive.file"].map((s) => AUTH + s);
const SHEETS_SCOPES = ["drive", "drive.readonly", "drive.file", "spreadsheets", "spreadsheets.readonly"].map((s) => AUTH + s);
const CALENDAR_SCOPES = ["calendar", "calendar.readonly", "calendar.events", "calendar.events.readonly"].map((s) => AUTH + s);

export interface GoogleMockFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  parents: string[];
  size?: string | undefined;
  trashed?: boolean;
  driveId?: string;
  /** Fields the connector never asks for, there so tests can check they're dropped. */
  description?: string;
  owners?: { displayName: string; emailAddress: string }[];
  webViewLink?: string;
}

export interface GoogleMockChange {
  /** "my" for My Drive and shared-with-me, otherwise the shared drive's id. */
  stream: string;
  fileId: string;
  removed?: boolean;
  time: string;
  /** The file as it stands after the change; left out for a removal Drive gives only the id for. */
  file?: GoogleMockFile;
}

export interface GoogleMockEvent {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  created: string;
  updated: string;
  eventType?: string;
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string };
  attendees?: { email: string; displayName?: string; responseStatus: string; organizer?: boolean; self?: boolean }[] | undefined;
  organizer?: { email: string; displayName?: string; self?: boolean };
}

export interface GoogleWorkspaceMockData {
  files: GoogleMockFile[];
  /** Spreadsheet id to range to rows. */
  sheets?: Record<string, Record<string, unknown[][]>>;
  /** Calendar id to its events. */
  calendars?: Record<string, GoogleMockEvent[]>;
  refreshToken: string;
  /** Scopes the connection was granted; the three read-only ones unless a test says otherwise. */
  scopes?: string[];
  /** Errors to answer before the next API reads, in order. */
  rateLimits?: { status: 403 | 429; reason?: string; retryAfter?: number }[];
}

/** A fixed day the fixtures are dated from. */
export const GOOGLE_MOCK_NOW = "2026-01-20T00:00:00.000Z";
export const GOOGLE_MOCK_ROOT = "1TestRootFolder_000000000000AA";

/** Drive-shaped ids: a letter prefix and a counter, never 13 digits in a row. */
export const googleDriveId = (prefix: string, n: number) => `1Test${prefix}_${String(n).padStart(6, "0")}_xyzXYZabcABC`;
export const googleEventId = (n: number) => `evt${String(n).padStart(6, "0")}abcdef`;

const daysBefore = (days: number) => new Date(Date.parse(GOOGLE_MOCK_NOW) - days * 86_400_000).toISOString();

export const googleFile = fixtureBuilder<GoogleMockFile>((n) => ({
  id: googleDriveId("File", n),
  name: `Synthetic invoice ${n}.pdf`,
  mimeType: "application/pdf",
  modifiedTime: daysBefore(n),
  parents: [GOOGLE_MOCK_ROOT],
  size: String(10_000 + n),
  description: `Synthetic description ${n} for ${synthetic.name(n)}`,
  owners: [{ displayName: synthetic.name(n), emailAddress: synthetic.email(n) }],
  webViewLink: `https://drive.example.test/file/${n}`,
}));

export const googleEvent = fixtureBuilder<GoogleMockEvent>((n) => ({
  id: googleEventId(n),
  status: "confirmed",
  start: { dateTime: new Date(Date.parse(daysBefore(n)) + 10 * 3_600_000).toISOString(), timeZone: "America/New_York" },
  end: { dateTime: new Date(Date.parse(daysBefore(n)) + 11 * 3_600_000).toISOString(), timeZone: "America/New_York" },
  created: daysBefore(n + 7),
  updated: daysBefore(n + 1),
  eventType: "default",
  summary: `Ring sizing for ${synthetic.name(n)}`,
  description: `Synthetic notes: size 7, call ${synthetic.phone(n)}`,
  location: "Synthetic Store, 1 Test Street",
  hangoutLink: `https://meet.example.test/${n}`,
  attendees: [
    { email: "owner@store.test", displayName: "Test Store", responseStatus: "accepted", organizer: true, self: true },
    { email: synthetic.email(n), displayName: synthetic.name(n), responseStatus: "needsAction" },
  ],
  organizer: { email: "owner@store.test", displayName: "Test Store", self: true },
}));

const apiError = (code: number, message: string, reason: string, status: string): DocMockResponse => ({
  status: code,
  body: { error: { code, message, errors: [{ domain: "global", reason, message }], status } },
});
const badRequest = (message: string) => apiError(400, message, "invalid", "INVALID_ARGUMENT");
const notFound = () => apiError(404, "Requested entity was not found.", "notFound", "NOT_FOUND");
const insufficient = () => apiError(403, "Request had insufficient authentication scopes.", "insufficientPermissions", "PERMISSION_DENIED");

const encode = (text: string) => Buffer.from(text).toString("base64url");
const decode = (token: string | null) => (token === null ? "" : Buffer.from(token, "base64url").toString("utf8"));
const size = (raw: string | null, fallback: number, max: number) => Math.min(Math.max(Number(raw ?? fallback) || fallback, 1), max);
const FOLDER_QUERY = /^'([A-Za-z0-9_-]{1,200})' in parents and trashed = false$/;

export interface GoogleWorkspaceMock {
  oauth: DocMock;
  drive: DocMock;
  sheets: DocMock;
  calendar: DocMock;
  fetch: DocMockFetch;
  readonly refreshes: number;
  /** Records a Drive change and applies it to the files. */
  change(change: GoogleMockChange): void;
  /** Adds or replaces an event, as when it is made, edited or cancelled. */
  putEvent(calendarId: string, event: GoogleMockEvent): void;
  /** Makes every sync token so far answer 410, as when sharing changes. */
  expireSyncTokens(): void;
  revokeAccessTokens(): void;
}

export function googleWorkspaceDocMock(data: GoogleWorkspaceMockData): GoogleWorkspaceMock {
  let issued = 0;
  let refreshes = 0;
  const access = new Set<string>();
  const limits = [...(data.rateLimits ?? [])];
  const scopes = () => data.scopes ?? GOOGLE_MOCK_SCOPES;
  const files = new Map(data.files.map((f) => [f.id, { ...f }]));
  const changes: GoogleMockChange[] = [];
  /** Each event's sequence number: raised whenever it changes. */
  let seq = 0;
  let generation = 0;
  const calendars = new Map(Object.entries(data.calendars ?? {}).map(([id, events]) => [id, events.map((e) => ({ event: e, seq: ++seq }))]));

  const oauth = checkDocMock({
    integration: "google_workspace",
    baseUrl: OAUTH,
    source: { url: "https://developers.google.com/identity/protocols/oauth2/web-server", title: "Using OAuth 2.0 for Web Server Applications", retrievedOn: "2026-10-22", version: "OAuth 2.0" },
    assumptions: [
      "A refresh answers access_token, expires_in, scope and token_type, and no new refresh_token; the refresh section's sample response couldn't be read",
      "Client credentials go in the form body; HTTP Basic and DPoP aren't modelled",
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
          if (!form.get("client_id") || !form.get("client_secret")) return { status: 401, body: { error: "invalid_client" } };
          if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== data.refreshToken) return { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
          const token = `AT-TEST-${++issued}`;
          access.add(token);
          return { status: 200, body: { access_token: token, expires_in: 3599, scope: scopes().join(" "), token_type: "Bearer" } };
        },
      },
    ],
  });

  function guard(request: DocMockRequest, allowed: string[]): DocMockResponse | null {
    if (!access.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) return apiError(401, "Request had invalid authentication credentials.", "authError", "UNAUTHENTICATED");
    if (!scopes().some((s) => allowed.includes(s))) return insufficient();
    const limit = limits.shift();
    if (limit) {
      const reason = limit.reason ?? "rateLimitExceeded";
      const response = apiError(limit.status, "Rate limit exceeded", reason, "RESOURCE_EXHAUSTED");
      return limit.retryAfter ? { ...response, headers: { "retry-after": String(limit.retryAfter) } } : response;
    }
    return null;
  }

  /** Drive hides shared drive items unless the request says it supports them. */
  const visible = (f: GoogleMockFile, q: URLSearchParams) => !f.driveId || (q.get("supportsAllDrives") === "true" && q.get("includeItemsFromAllDrives") === "true");
  const position = (stream: string) => changes.filter((c) => c.stream === stream).length;

  const drive = checkDocMock({
    integration: "google_workspace",
    baseUrl: DRIVE,
    source: { url: `${DRIVE_DOCS}/files/list`, title: "Google Drive API v3 reference", retrievedOn: "2026-10-22", version: "v3" },
    auth: "bearer",
    assumptions: [
      "Only the folder query `'ID' in parents and trashed = false` is modelled; any other q answers 400",
      "files.list lists a folder's children by name; the docs give no default order",
      "Items at the top of a shared drive list the shared drive's id as their parent, so the drive is walked like a folder",
      "Partial responses (`fields`) aren't modelled: the mock returns whole resources, so the connector's dropping of owners, links and descriptions is what's tested",
      "Page tokens stay valid between runs, so an interrupted listing resumes from a saved one",
      "A change for a file the user can no longer see has removed true and no file",
      "Without driveId, changes.list with includeItemsFromAllDrives returns My Drive changes only here; the docs say it may also include shared drive items the user has accessed, which the connector would see as duplicates",
    ],
    routes: [
      {
        method: "GET",
        path: "/files",
        documentedAt: `${DRIVE_DOCS}/files/list`,
        respond(request) {
          const denied = guard(request, DRIVE_SCOPES);
          if (denied) return denied;
          const q = request.url.searchParams;
          const match = FOLDER_QUERY.exec(q.get("q") ?? "");
          if (!match) return badRequest("Only the folder query is modelled");
          const offset = q.has("pageToken") ? Number(/^files:(\d+)$/.exec(decode(q.get("pageToken")))?.[1] ?? Number.NaN) : 0;
          if (Number.isNaN(offset)) return badRequest("Invalid pageToken");
          const rows = [...files.values()].filter((f) => f.parents.includes(match[1]!) && !f.trashed && visible(f, q)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          const n = size(q.get("pageSize"), 100, 1000);
          return { status: 200, body: { kind: "drive#fileList", incompleteSearch: false, files: rows.slice(offset, offset + n), ...(offset + n < rows.length ? { nextPageToken: encode(`files:${offset + n}`) } : {}) } };
        },
      },
      {
        method: "GET",
        path: "/changes/startPageToken",
        documentedAt: `${DRIVE_DOCS}/changes/getStartPageToken`,
        respond(request) {
          const denied = guard(request, DRIVE_SCOPES);
          if (denied) return denied;
          const stream = request.url.searchParams.get("driveId") ?? "my";
          return { status: 200, body: { kind: "drive#startPageToken", startPageToken: encode(`changes:${stream}:${position(stream)}`) } };
        },
      },
      {
        method: "GET",
        path: "/changes",
        documentedAt: `${DRIVE_DOCS}/changes/list`,
        respond(request) {
          const denied = guard(request, DRIVE_SCOPES);
          if (denied) return denied;
          const q = request.url.searchParams;
          if (!q.has("pageToken")) return badRequest("Required parameter: pageToken");
          const stream = q.get("driveId") ?? "my";
          const m = /^changes:([A-Za-z0-9_-]+):(\d+)$/.exec(decode(q.get("pageToken")));
          if (!m || m[1] !== stream) return badRequest("Invalid pageToken");
          const all = changes.filter((c) => c.stream === stream);
          const offset = Number(m[2]);
          const n = size(q.get("pageSize"), 100, 1000);
          const page = all.slice(offset, offset + n).map((c) => ({
            kind: "drive#change",
            changeType: "file",
            fileId: c.fileId,
            removed: c.removed ?? false,
            time: c.time,
            ...(c.file && visible(c.file, q) ? { file: c.file } : {}),
          }));
          const end = offset + n >= all.length;
          return { status: 200, body: { kind: "drive#changeList", changes: page, ...(end ? { newStartPageToken: encode(`changes:${stream}:${all.length}`) } : { nextPageToken: encode(`changes:${stream}:${offset + n}`) }) } };
        },
      },
    ],
  });

  const sheets = checkDocMock({
    integration: "google_workspace",
    baseUrl: SHEETS,
    source: { url: "https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchGet", title: "Google Sheets API v4 reference", retrievedOn: "2026-10-22", version: "v4" },
    auth: "bearer",
    assumptions: [
      "A range is matched exactly as configured; Sheets' own normalising of the range it echoes back (quoting, filling in the last row) isn't modelled",
      "A spreadsheet the user can't open answers 404",
      "A range the sheet doesn't have answers 400 Unable to parse range",
    ],
    routes: [
      {
        method: "GET",
        path: "/spreadsheets/{spreadsheetId}/values:batchGet",
        documentedAt: "https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchGet",
        respond(request, params) {
          const denied = guard(request, SHEETS_SCOPES);
          if (denied) return denied;
          const sheet = data.sheets?.[params.spreadsheetId!];
          if (!sheet) return notFound();
          const ranges = request.url.searchParams.getAll("ranges");
          if (!ranges.length) return badRequest("ranges is required");
          if (ranges.some((r) => !Object.hasOwn(sheet, r))) return badRequest("Unable to parse range");
          return { status: 200, body: { spreadsheetId: params.spreadsheetId, valueRanges: ranges.map((r) => ({ range: r, majorDimension: "ROWS", ...(sheet[r]!.length ? { values: sheet[r] } : {}) })) } };
        },
      },
    ],
  });

  const calendar = checkDocMock({
    integration: "google_workspace",
    baseUrl: CALENDAR,
    source: { url: `${CALENDAR_DOCS}/v3/reference/events/list`, title: "Google Calendar API v3 reference", retrievedOn: "2026-10-22", version: "v3" },
    auth: "bearer",
    assumptions: [
      "timeMin keeps events that end after it, the way the docs describe the bound",
      "An expired sync token answers 410 with reason fullSyncRequired",
      "A sync token is valid for the same calendar only and covers every change after it was issued, whatever window the full sync had",
      "A cancelled event in an incremental list carries only id, status and, for an instance, recurringEventId and originalStartTime",
      "Partial responses (`fields`) aren't modelled: the mock returns whole events, so the connector's dropping of titles, descriptions, links and names is what's tested",
    ],
    routes: [
      {
        method: "GET",
        path: "/calendars/{calendarId}/events",
        documentedAt: `${CALENDAR_DOCS}/v3/reference/events/list`,
        respond(request, params) {
          const denied = guard(request, CALENDAR_SCOPES);
          if (denied) return denied;
          const entries = calendars.get(params.calendarId!);
          if (!entries) return notFound();
          const q = request.url.searchParams;
          const syncToken = q.get("syncToken");
          if (syncToken !== null && ["timeMin", "timeMax", "updatedMin", "q", "orderBy", "iCalUID"].some((k) => q.has(k))) return badRequest("Sync token cannot be combined with these filters");
          let rows: Record<string, unknown>[];
          let since = 0;
          if (syncToken !== null) {
            const m = /^sync:([^:]{1,200}):(\d{1,15}):(\d{1,6})$/.exec(decode(syncToken));
            if (!m || m[1] !== params.calendarId) return badRequest("Invalid sync token");
            since = Number(m[2]);
            if (Number(m[3]) !== generation) return { status: 410, body: { error: { code: 410, message: "Sync token is no longer valid, a full sync is required.", errors: [{ domain: "calendar", reason: "fullSyncRequired" }] } } };
            rows = entries
              .filter((e) => e.seq > since)
              .map(({ event }) =>
                event.status === "cancelled"
                  ? { id: event.id, status: "cancelled", ...(event.recurringEventId ? { recurringEventId: event.recurringEventId, originalStartTime: event.originalStartTime } : {}) }
                  : ({ ...event } as Record<string, unknown>),
              );
          } else {
            const timeMin = q.get("timeMin");
            const floor = timeMin ? Date.parse(timeMin) : Number.NEGATIVE_INFINITY;
            if (Number.isNaN(floor)) return badRequest("Invalid timeMin");
            rows = entries
              .filter(({ event }) => event.status !== "cancelled" && Date.parse(event.end.dateTime ?? `${event.end.date}T00:00:00Z`) > floor)
              .map(({ event }) => ({ ...event }) as Record<string, unknown>);
          }
          const offset = q.has("pageToken") ? Number(/^page:(\d+)$/.exec(decode(q.get("pageToken")))?.[1] ?? Number.NaN) : 0;
          if (Number.isNaN(offset)) return badRequest("Invalid pageToken");
          const n = size(q.get("maxResults"), 250, 2500);
          const end = offset + n >= rows.length;
          return {
            status: 200,
            body: {
              kind: "calendar#events",
              summary: "Synthetic calendar",
              timeZone: "America/New_York",
              items: rows.slice(offset, offset + n),
              ...(end ? { nextSyncToken: encode(`sync:${params.calendarId}:${seq}:${generation}`) } : { nextPageToken: encode(`page:${offset + n}`) }),
            },
          };
        },
      },
    ],
  });

  const mocks = [
    { base: OAUTH, fetch: docMockFetch(oauth) },
    { base: DRIVE, fetch: docMockFetch(drive) },
    { base: SHEETS, fetch: docMockFetch(sheets) },
    { base: CALENDAR, fetch: docMockFetch(calendar) },
  ];
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // Routed by exact origin and path, so a look-alike host goes to the Drive mock and is refused there.
      const target = mocks.find((m) => url.origin === new URL(m.base).origin && url.pathname.startsWith(new URL(m.base).pathname)) ?? mocks[1]!;
      const response = await target.fetch(input, init);
      calls.push(...target.fetch.calls.slice(-1));
      return response;
    },
    { calls },
  );

  return {
    oauth,
    drive,
    sheets,
    calendar,
    fetch,
    get refreshes() {
      return refreshes;
    },
    change(change) {
      changes.push(change);
      if (change.file) files.set(change.fileId, { ...change.file });
      else if (change.removed) files.delete(change.fileId);
    },
    putEvent(calendarId, event) {
      const entries = calendars.get(calendarId) ?? [];
      const rest = entries.filter((e) => e.event.id !== event.id);
      calendars.set(calendarId, [...rest, { event, seq: ++seq }]);
    },
    expireSyncTokens: () => {
      generation++;
    },
    revokeAccessTokens: () => access.clear(),
  };
}
