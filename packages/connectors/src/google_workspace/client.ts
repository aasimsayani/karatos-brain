import type { QuickBooksTokenStore } from "../quickbooks/client.js";

/**
 * A small client for the Google Drive, Sheets and Calendar APIs. Read-only
 * three ways over: the connection is made with read-only scopes only
 * (drive.metadata.readonly, spreadsheets.readonly, calendar.events.readonly),
 * and the client checks that on every new access token; the only requests it
 * sends to Google's APIs are GETs from a fixed list, each with parameters it
 * builds itself; and Sheets and Calendar reads are limited to the
 * spreadsheets and calendars the owner listed in the settings. Its one POST
 * is the OAuth token refresh to Google's token endpoint.
 *
 * Drive is read with drive.metadata.readonly, which can't download file
 * contents: names, types, times, parents and sizes only. Every Drive and
 * Calendar request asks for a fixed `fields` list, so descriptions,
 * attendee names, meeting links and file owners aren't sent in the first
 * place.
 *
 * It shares the instance's Google OAuth client (GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET) with the Gmail connector and handles tokens the same
 * way, but holds its own refresh token: Gmail's connection must hold nothing
 * but gmail.metadata, and this one nothing but the read-only scopes above.
 *
 * Google doesn't rotate refresh tokens; if it ever returns a new one, it's
 * saved like QuickBooks'.
 */

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_DRIVE_API_URL = "https://www.googleapis.com/drive/v3";
export const GOOGLE_SHEETS_API_URL = "https://sheets.googleapis.com/v4";
export const GOOGLE_CALENDAR_API_URL = "https://www.googleapis.com/calendar/v3";

const AUTH = "https://www.googleapis.com/auth/";
/** File metadata only: no contents, no changes. A restricted scope. */
export const DRIVE_METADATA_READONLY_SCOPE = `${AUTH}drive.metadata.readonly`;
/** Reads spreadsheet values; the client only asks for the ranges the owner listed. */
export const SHEETS_READONLY_SCOPE = `${AUTH}spreadsheets.readonly`;
/** Reads events; not calendar settings, sharing or the calendar list. */
export const CALENDAR_EVENTS_READONLY_SCOPE = `${AUTH}calendar.events.readonly`;
/** Every data scope the connection may hold. Anything else stops the sync. */
export const GOOGLE_WORKSPACE_SCOPES = [DRIVE_METADATA_READONLY_SCOPE, SHEETS_READONLY_SCOPE, CALENDAR_EVENTS_READONLY_SCOPE] as const;
/** Scopes that only say who signed in. Google may add them to a token; they reach no data. */
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email", `${AUTH}userinfo.email`] as const;

export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";

/** The file fields Drive is asked for: never owners, permissions, links, descriptions or checksums. */
export const DRIVE_FILE_FIELDS = "id,name,mimeType,modifiedTime,parents,size,trashed,driveId";
const FILES_FIELDS = `nextPageToken,incompleteSearch,files(${DRIVE_FILE_FIELDS})`;
const CHANGES_FIELDS = `nextPageToken,newStartPageToken,changes(changeType,removed,fileId,time,driveId,file(${DRIVE_FILE_FIELDS}))`;
/** The event fields Calendar is asked for: never summary, description, location, links, attachments or names. */
export const CALENDAR_EVENT_FIELDS =
  "id,status,start,end,created,updated,eventType,transparency,recurrence,recurringEventId,originalStartTime,attendeesOmitted,attendees(email,responseStatus,organizer,self,resource,optional),organizer(email,self)";
const EVENTS_FIELDS = `nextPageToken,nextSyncToken,items(${CALENDAR_EVENT_FIELDS})`;

/** Drive's and Calendar's largest pages. */
export const DRIVE_PAGE_SIZE = 1000;
export const CALENDAR_PAGE_SIZE = 2500;
/** Ranges read from one spreadsheet in one batchGet. */
export const SHEETS_MAX_RANGES = 20;

/** The reads the client may send, and nothing else. */
export type GoogleWorkspaceRead =
  | { method: "drive.changes.getStartPageToken"; driveId?: string }
  | { method: "drive.changes.list"; pageToken: string; driveId?: string }
  | { method: "drive.files.list"; folderId: string; pageToken?: string }
  | { method: "sheets.values.batchGet"; spreadsheetId: string; ranges: readonly string[] }
  | { method: "calendar.events.list"; calendarId: string; pageToken?: string; syncToken?: string; timeMin?: string };
export type GoogleWorkspaceMethod = GoogleWorkspaceRead["method"];

export type GoogleWorkspaceTokenStore = QuickBooksTokenStore;

/** One spreadsheet and the ranges of it the owner listed. */
export interface GoogleSheetRanges {
  spreadsheetId: string;
  ranges: string[];
}

export interface GoogleWorkspaceClientOptions {
  clientId: string;
  clientSecret: string;
  tokens: GoogleWorkspaceTokenStore;
  /** The only spreadsheets and ranges values may be read from (GOOGLE_SHEETS_RANGES). */
  sheets?: readonly GoogleSheetRanges[];
  /** The only calendars events may be read from (GOOGLE_CALENDAR_IDS). */
  calendarIds?: readonly string[];
  fetch?: typeof globalThis.fetch;
  /** Waits for pacing and before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate-limited request is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Milliseconds since the epoch; replaced in tests. */
  clock?: () => number;
}

export class GoogleWorkspaceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleWorkspaceConfigError";
  }
}

/** Google answered with an error. `reason` is Google's reason code, when it gives one. */
export class GoogleWorkspaceApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.name = "GoogleWorkspaceApiError";
    this.status = status;
    this.reason = reason;
  }
}

export interface GoogleWorkspaceClient {
  /** One GET from the allowlist. Null when Google answers 404. A 410 (an expired sync token) throws with status 410. */
  read(request: GoogleWorkspaceRead): Promise<Record<string, unknown> | null>;
}

export const GOOGLE_DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;
export const GOOGLE_SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;
/** primary, or a calendar's address (a person's, a group's or a resource's). */
export const GOOGLE_CALENDAR_ID = /^(primary|[A-Za-z0-9._%+-]{1,128}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8})$/;
/** A sheet name in quotes (letters, digits, spaces, _ . -) or bare (no spaces), then a cell or column range. */
export const GOOGLE_SHEET_RANGE = /^(?:'[A-Za-z0-9 _.-]{1,100}'|[A-Za-z0-9_.-]{1,100})!(?:[A-Z]{1,3}[0-9]{0,7}|[0-9]{1,7})(?::(?:[A-Z]{1,3}[0-9]{0,7}|[0-9]{1,7}))?$/;
const PAGE_TOKEN = /^[A-Za-z0-9_.~=+/-]{1,2048}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
/** Longest setting or token the client looks at with a pattern; anything longer is refused unread. */
export const GOOGLE_INPUT_MAX = 4096;

const ACCESS_RENEW_EARLY_MS = 2 * 60_000;
const MAX_RETRY_AFTER_S = 64;
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const DAILY_REASONS = new Set(["dailyLimitExceeded", "quotaExceeded"]);

/**
 * Milliseconds between calls to each API, under each one's per-user budget:
 * Sheets allows 60 reads a minute per user (paced to 50), Calendar 600
 * requests (paced to 500), Drive 325,000 quota units at 100 a list (paced
 * well under).
 */
export const GOOGLE_PACE_MS = { drive: 25, sheets: 1200, calendar: 120 } as const;

/** The keys each read may carry. Anything else, such as q or fields, is refused. */
const ALLOWED_KEYS: Record<GoogleWorkspaceMethod, readonly string[]> = {
  "drive.changes.getStartPageToken": ["method", "driveId"],
  "drive.changes.list": ["method", "pageToken", "driveId"],
  "drive.files.list": ["method", "folderId", "pageToken"],
  "sheets.values.batchGet": ["method", "spreadsheetId", "ranges"],
  "calendar.events.list": ["method", "calendarId", "pageToken", "syncToken", "timeMin"],
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True when a string is short enough to test and googleMatches. Long input is never handed to a pattern. */
export const googleMatches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && value.length <= GOOGLE_INPUT_MAX && pattern.test(value);

function token(name: string, value: unknown, query: URLSearchParams): void {
  if (value === undefined) return;
  if (!googleMatches(PAGE_TOKEN, value)) throw new GoogleWorkspaceConfigError(`${name} must be the token Google returned`);
  query.set(name, value);
}

function driveScope(query: URLSearchParams, driveId: unknown): void {
  query.set("supportsAllDrives", "true");
  if (driveId === undefined) return;
  if (!googleMatches(GOOGLE_DRIVE_ID, driveId)) throw new GoogleWorkspaceConfigError("a shared drive id is letters, digits, - and _");
  query.set("driveId", driveId);
}

export interface GoogleReadAllowlist {
  sheets: readonly GoogleSheetRanges[];
  calendarIds: readonly string[];
}

/**
 * The URL for one allowed read, or a GoogleWorkspaceConfigError before
 * anything is sent. This is the allowlist: five GETs, each with the fields,
 * page sizes and flags fixed here, no search except the one folder query
 * built from a checked id, and Sheets and Calendar only for what the owner
 * listed.
 */
export function googleWorkspaceReadUrl(request: GoogleWorkspaceRead, allow: GoogleReadAllowlist): string {
  const method = (request as { method?: unknown })?.method;
  if (typeof method !== "string" || !Object.hasOwn(ALLOWED_KEYS, method)) throw new GoogleWorkspaceConfigError("the Google Workspace connector only sends its listed reads");
  const extra = Object.keys(request).filter((k) => !ALLOWED_KEYS[method as GoogleWorkspaceMethod].includes(k));
  if (extra.length) throw new GoogleWorkspaceConfigError(`${method} doesn't take ${extra.slice(0, 3).join(", ")}`);
  const r = request as Record<string, unknown>;
  const query = new URLSearchParams();
  let url: string;
  switch (method as GoogleWorkspaceMethod) {
    case "drive.changes.getStartPageToken":
      driveScope(query, r.driveId);
      url = `${GOOGLE_DRIVE_API_URL}/changes/startPageToken`;
      break;
    case "drive.changes.list":
      if (r.pageToken === undefined) throw new GoogleWorkspaceConfigError("changes are read from a page token");
      token("pageToken", r.pageToken, query);
      driveScope(query, r.driveId);
      query.set("includeItemsFromAllDrives", "true");
      query.set("includeRemoved", "true");
      query.set("spaces", "drive");
      query.set("pageSize", String(DRIVE_PAGE_SIZE));
      query.set("fields", CHANGES_FIELDS);
      url = `${GOOGLE_DRIVE_API_URL}/changes`;
      break;
    case "drive.files.list":
      // The id is checked to letters, digits, - and _, so it can't break out of the quotes.
      if (!googleMatches(GOOGLE_DRIVE_ID, r.folderId)) throw new GoogleWorkspaceConfigError("a folder id is letters, digits, - and _");
      query.set("q", `'${r.folderId}' in parents and trashed = false`);
      query.set("supportsAllDrives", "true");
      query.set("includeItemsFromAllDrives", "true");
      query.set("spaces", "drive");
      query.set("pageSize", String(DRIVE_PAGE_SIZE));
      query.set("fields", FILES_FIELDS);
      token("pageToken", r.pageToken, query);
      url = `${GOOGLE_DRIVE_API_URL}/files`;
      break;
    case "sheets.values.batchGet": {
      const listed = allow.sheets.find((s) => s.spreadsheetId === r.spreadsheetId);
      if (!listed) throw new GoogleWorkspaceConfigError("values are read only from spreadsheets listed in GOOGLE_SHEETS_RANGES");
      if (!Array.isArray(r.ranges) || !r.ranges.length || r.ranges.length > SHEETS_MAX_RANGES || !r.ranges.every((x) => listed.ranges.includes(x as string))) {
        throw new GoogleWorkspaceConfigError("only the ranges listed in GOOGLE_SHEETS_RANGES are read");
      }
      for (const range of r.ranges as string[]) query.append("ranges", range);
      query.set("majorDimension", "ROWS");
      query.set("valueRenderOption", "UNFORMATTED_VALUE");
      query.set("dateTimeRenderOption", "FORMATTED_STRING");
      url = `${GOOGLE_SHEETS_API_URL}/spreadsheets/${listed.spreadsheetId}/values:batchGet`;
      break;
    }
    case "calendar.events.list": {
      if (typeof r.calendarId !== "string" || !allow.calendarIds.includes(r.calendarId)) throw new GoogleWorkspaceConfigError("events are read only from calendars listed in GOOGLE_CALENDAR_IDS");
      if (r.syncToken !== undefined && r.timeMin !== undefined) throw new GoogleWorkspaceConfigError("Calendar won't take a sync token with timeMin");
      token("syncToken", r.syncToken, query);
      if (r.timeMin !== undefined) {
        if (!googleMatches(RFC3339_UTC, r.timeMin) || Number.isNaN(Date.parse(r.timeMin))) throw new GoogleWorkspaceConfigError("timeMin must be a UTC time");
        query.set("timeMin", r.timeMin);
      }
      token("pageToken", r.pageToken, query);
      query.set("maxResults", String(CALENDAR_PAGE_SIZE));
      query.set("singleEvents", "false");
      query.set("fields", EVENTS_FIELDS);
      url = `${GOOGLE_CALENDAR_API_URL}/calendars/${encodeURIComponent(r.calendarId)}/events`;
      break;
    }
  }
  return `${url}?${query.toString()}`;
}

/**
 * What's wrong with the scopes a token was granted, or null when they're
 * read-only ones this connector uses. drive.metadata.readonly is always
 * needed; spreadsheets.readonly when ranges are listed and
 * calendar.events.readonly when calendars are. Anything else (drive.readonly,
 * which can download files; drive, drive.file, spreadsheets, calendar,
 * calendar.events, calendar.readonly; any Gmail scope) is a problem, as is a
 * token that doesn't say what it holds.
 */
export function googleWorkspaceScopeProblem(scope: unknown, needs: { sheets: boolean; calendar: boolean }): string | null {
  if (typeof scope !== "string" || !scope.trim()) return "Google didn't say which scopes the token holds";
  const scopes = scope.slice(0, GOOGLE_INPUT_MAX).split(" ").filter(Boolean);
  const known = [...GOOGLE_WORKSPACE_SCOPES, ...GOOGLE_IDENTITY_SCOPES] as readonly string[];
  const extra = scopes.filter((s) => !known.includes(s));
  if (extra.length) return `the Google Workspace connection holds more than read-only access (${extra.slice(0, 5).join(", ")})`;
  const required = [DRIVE_METADATA_READONLY_SCOPE, ...(needs.sheets ? [SHEETS_READONLY_SCOPE] : []), ...(needs.calendar ? [CALENDAR_EVENTS_READONLY_SCOPE] : [])];
  const missing = required.filter((s) => !scopes.includes(s));
  if (missing.length) return `the Google Workspace connection doesn't hold ${missing.join(", ")}`;
  return null;
}

/** Google's error reason and message, cut short. Error bodies describe the request, never the token. */
function errorOf(body: unknown): { reason?: string; message: string } {
  const e = ((body ?? {}) as { error?: unknown }).error;
  if (typeof e === "string") return { reason: e.slice(0, 40), message: "" };
  const o = (e ?? {}) as { message?: unknown; errors?: { reason?: unknown }[] };
  const reason = Array.isArray(o.errors) ? o.errors.map((x) => x?.reason).find((x): x is string => typeof x === "string") : undefined;
  return { ...(reason ? { reason: reason.slice(0, 40) } : {}), message: typeof o.message === "string" ? o.message.slice(0, 200) : "" };
}

const apiOf = (method: GoogleWorkspaceMethod): keyof typeof GOOGLE_PACE_MS => method.slice(0, method.indexOf(".")) as keyof typeof GOOGLE_PACE_MS;

export function googleWorkspaceClient(options: GoogleWorkspaceClientOptions): GoogleWorkspaceClient {
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!clientId || !clientSecret) throw new GoogleWorkspaceConfigError("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  const allow: GoogleReadAllowlist = { sheets: options.sheets ?? [], calendarIds: options.calendarIds ?? [] };
  for (const s of allow.sheets) {
    if (!googleMatches(GOOGLE_SPREADSHEET_ID, s.spreadsheetId) || !s.ranges.length || s.ranges.length > SHEETS_MAX_RANGES || !s.ranges.every((x) => googleMatches(GOOGLE_SHEET_RANGE, x))) {
      throw new GoogleWorkspaceConfigError("GOOGLE_SHEETS_RANGES holds a spreadsheet id or range the connector won't read");
    }
  }
  if (!allow.calendarIds.every((c) => googleMatches(GOOGLE_CALENDAR_ID, c))) throw new GoogleWorkspaceConfigError("GOOGLE_CALENDAR_IDS must be primary or calendar addresses");
  const needs = { sheets: allow.sheets.length > 0, calendar: allow.calendarIds.length > 0 };
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 5;
  const clock = options.clock ?? (() => Date.now());
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;
  const nextSlot: Record<keyof typeof GOOGLE_PACE_MS, number> = { drive: 0, sheets: 0, calendar: 0 };

  async function refresh(): Promise<string> {
    const refreshToken = (await options.tokens.load()).trim();
    if (!refreshToken) throw new GoogleWorkspaceConfigError("set GOOGLE_WORKSPACE_REFRESH_TOKEN");
    const response = await doFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown };
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
      const code = typeof body.error === "string" ? body.error.slice(0, 40) : undefined;
      const hint = code === "invalid_grant" ? "; reconnect Google Workspace to get a new refresh token (tokens from a consent screen in Testing last 7 days)" : "";
      throw new GoogleWorkspaceApiError(`Google refused the token refresh (HTTP ${response.status}${code ? `, ${code}` : ""})${hint}`, response.status, code);
    }
    if (typeof body.refresh_token === "string" && body.refresh_token) await options.tokens.save(body.refresh_token);
    const problem = googleWorkspaceScopeProblem(body.scope, needs);
    if (problem) throw new GoogleWorkspaceConfigError(`${problem}; reconnect it with only ${GOOGLE_WORKSPACE_SCOPES.join(", ")}`);
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    access = { token: body.access_token, expiresAt: clock() + seconds * 1000 };
    return access.token;
  }

  async function accessToken(): Promise<string> {
    if (access && access.expiresAt - ACCESS_RENEW_EARLY_MS > clock()) return access.token;
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function pace(api: keyof typeof GOOGLE_PACE_MS): Promise<void> {
    const now = clock();
    if (nextSlot[api] > now) await sleep(nextSlot[api] - now);
    nextSlot[api] = Math.max(nextSlot[api], now) + GOOGLE_PACE_MS[api];
  }

  return {
    async read(request) {
      const url = googleWorkspaceReadUrl(request, allow);
      const api = apiOf(request.method);
      let renewed = false;
      for (let attempt = 0; ; ) {
        await pace(api);
        // GET only, with the token in the Authorization header and never in the URL.
        const response = await doFetch(url, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${await accessToken()}` } });
        if (response.status === 401 && !renewed) {
          renewed = true;
          access = null;
          continue;
        }
        if (response.status === 404) return null;
        const body: unknown = await response.json().catch(() => null);
        const { reason, message } = errorOf(body);
        if (response.status === 410) throw new GoogleWorkspaceApiError("Google no longer accepts that sync token", 410, reason);
        if (response.status === 403 && reason && DAILY_REASONS.has(reason)) {
          throw new GoogleWorkspaceApiError("Google's daily limit for this project is used up; the next sync resumes from the checkpoint", 403, reason);
        }
        if (response.status === 429 || (response.status === 403 && reason && RATE_REASONS.has(reason))) {
          if (attempt < retries) {
            const after = Number(response.headers.get("retry-after"));
            await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : Math.min(1000 * 2 ** attempt, MAX_RETRY_AFTER_S * 1000));
            attempt++;
            continue;
          }
          throw new GoogleWorkspaceApiError(`Google kept rate-limiting the sync${reason ? ` (${reason})` : ""}`, response.status, reason);
        }
        if (!response.ok) {
          const hint = response.status === 403 && reason === "domainPolicy" ? "; the Workspace admin has turned off access for apps" : "";
          throw new GoogleWorkspaceApiError(`Google answered HTTP ${response.status}${message ? `: ${message}` : ""}${hint}`, response.status, reason);
        }
        if (!body || typeof body !== "object") throw new GoogleWorkspaceApiError("Google did not answer with JSON", response.status);
        return body as Record<string, unknown>;
      }
    },
  };
}
