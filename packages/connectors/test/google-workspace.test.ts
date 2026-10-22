import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  GOOGLE_MOCK_FOLDER,
  GOOGLE_MOCK_NOW,
  GOOGLE_MOCK_ROOT,
  GOOGLE_MOCK_SCOPES,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  googleDriveId,
  googleEvent,
  googleEventId,
  googleFile,
  googleWorkspaceDocMock,
  testPipeline,
  type GoogleMockEvent,
  type GoogleMockFile,
  type GoogleWorkspaceMock,
  type GoogleWorkspaceMockData,
} from "@karatos/connector-testkit";
import {
  CALENDAR_EVENTS_READONLY_SCOPE,
  DRIVE_METADATA_READONLY_SCOPE,
  GOOGLE_DRIVE_MAX_FOLDERS,
  GOOGLE_PACE_MS,
  GOOGLE_TOKEN_URL,
  GOOGLE_WORKSPACE_WRITES,
  GoogleWorkspaceApiError,
  GoogleWorkspaceConfigError,
  SHEETS_READONLY_SCOPE,
  SHEET_MAX_CELLS,
  driveKind,
  googlePushVerifier,
  googleWorkspaceClient,
  googleWorkspaceConnector,
  googleWorkspaceNormalizer,
  googleWorkspaceReadUrl,
  googleWorkspaceScopeProblem,
  memoryTokenStore,
  parseCalendarIds,
  parseGoogleWorkspaceCursor,
  parseSharedDriveIds,
  parseSheetRanges,
  sameChannelToken,
  type GoogleWorkspaceConnectorOptions,
  type GoogleWorkspaceCursor,
  type GoogleWorkspaceRead,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = ["000000000000", "test.apps.googleusercontent.com"].join("-");
const CLIENT_SECRET = ["GOCSPX", "test", "0".repeat(20)].join("-");
const REFRESH = ["1", "", "TEST-refresh"].join("/");
const KEY = ["test", "correspondent", "key", "0".repeat(24)].join("-");
const OTHER_KEY = ["test", "correspondent", "key", "1".repeat(24)].join("-");
const CHANNEL_TOKEN = ["test", "channel", "token", "a".repeat(30)].join("-");
const NOW = () => new Date(GOOGLE_MOCK_NOW);
const RECEIVED = GOOGLE_MOCK_NOW;
const DAY = 86_400_000;
const YEAR = 365.25 * DAY;
const before = (ms: number) => new Date(Date.parse(GOOGLE_MOCK_NOW) - ms).toISOString();

const SHEET = "1TestSpreadsheet_000001_abcdefABCDEF";
const SUB = googleDriveId("Folder", 1);
const DEEP = googleDriveId("Folder", 2);
const SHARED = "0ATestSharedDrive_000001";
const RANGES = ["Stock!A1:C3", "'Price list'!A:B"];
const hmac = (key: string, address: string) => `correspondent:${createHmac("sha256", key).update(`karatos:correspondent:v1:${address}`).digest("hex").slice(0, 32)}`;
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const tokenAnswer = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const normalize = googleWorkspaceNormalizer({ correspondentKey: KEY });

const folder = (id: string, parent: string, overrides: Partial<GoogleMockFile> = {}): GoogleMockFile => ({
  id,
  name: `Synthetic folder ${id.slice(-4)}`,
  mimeType: GOOGLE_MOCK_FOLDER,
  modifiedTime: before(30 * DAY),
  parents: [parent],
  ...overrides,
});

function workspace(overrides: Partial<GoogleWorkspaceMockData> = {}): GoogleWorkspaceMockData {
  googleFile.reset();
  googleEvent.reset();
  return {
    files: [
      // 1 and 2 at the top of the shared folder; 3 in a subfolder; 4 two folders down.
      googleFile.one(),
      googleFile.one({ name: "Synthetic price list", mimeType: "application/vnd.google-apps.spreadsheet", size: undefined }),
      googleFile.one({ parents: [SUB] }),
      googleFile.one({ parents: [DEEP] }),
      // 5: older than five years: not kept.
      googleFile.one({ modifiedTime: before(6 * YEAR) }),
      // 6: trashed: Drive doesn't list it.
      googleFile.one({ trashed: true }),
      // 7: outside the shared folder.
      googleFile.one({ parents: [googleDriveId("Elsewhere", 1)] }),
      // 8: no readable time: dead-lettered, not given a made-up one.
      googleFile.one({ modifiedTime: "not a time" }),
      folder(SUB, GOOGLE_MOCK_ROOT),
      folder(DEEP, SUB),
    ],
    sheets: { [SHEET]: { [RANGES[0]!]: [["SKU", "Qty", "Contact"], ["SKU-TEST-0001", 4, "buyer@vendor-casting.test"], ["SKU-TEST-0002", 0, true]], [RANGES[1]!]: [["Item", "Price"], ["Synthetic band", 450]] } },
    calendars: {
      primary: [
        googleEvent.one(),
        googleEvent.one({ recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"], eventType: "focusTime", attendees: undefined }),
        // Ended more than five years ago: not listed.
        googleEvent.one({ start: { dateTime: before(6 * YEAR) }, end: { dateTime: before(6 * YEAR - 3_600_000) } }),
      ],
    },
    refreshToken: REFRESH,
    ...overrides,
  };
}

const options = (mock: GoogleWorkspaceMock, extra: Partial<GoogleWorkspaceConnectorOptions> = {}): GoogleWorkspaceConnectorOptions => ({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  tokens: memoryTokenStore(REFRESH),
  correspondentKey: KEY,
  rootFolderId: GOOGLE_MOCK_ROOT,
  sheets: [{ spreadsheetId: SHEET, ranges: RANGES }],
  calendarIds: ["primary"],
  fetch: mock.fetch,
  sleep: async () => {},
  now: NOW,
  clock: () => Date.parse(GOOGLE_MOCK_NOW),
  ...extra,
});
const connector = (mock: GoogleWorkspaceMock, extra: Partial<GoogleWorkspaceConnectorOptions> = {}) => googleWorkspaceConnector(options(mock, extra));
const allow = { sheets: [{ spreadsheetId: SHEET, ranges: RANGES }], calendarIds: ["primary"] };
const urls = (mock: GoogleWorkspaceMock) => mock.fetch.calls.map((c) => `${c.method} ${decodeURIComponent(c.url.replace(/\+/g, " "))}`);

async function run(mock: GoogleWorkspaceMock, mode: "historical" | "incremental", memory = testPipeline(), extra: Partial<GoogleWorkspaceConnectorOptions> = {}) {
  const report = await runSync({ connector: connector(mock, extra), mode, pipeline: memory.pipeline, memory: memory.memory, organizationId: TEST_ORG, sleep: async () => {} });
  return { report, ...memory };
}

describe("Google Workspace client", () => {
  it("checks its settings, naming them but never their values", () => {
    const base = options(googleWorkspaceDocMock(workspace()));
    expect(() => googleWorkspaceClient({ ...base, clientSecret: " " })).toThrow(new GoogleWorkspaceConfigError("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET"));
    expect(() => googleWorkspaceClient({ ...base, sheets: [{ spreadsheetId: "short", ranges: RANGES }] })).toThrow("GOOGLE_SHEETS_RANGES");
    expect(() => googleWorkspaceClient({ ...base, sheets: [{ spreadsheetId: SHEET, ranges: [] }] })).toThrow("GOOGLE_SHEETS_RANGES");
    expect(() => googleWorkspaceClient({ ...base, sheets: [{ spreadsheetId: SHEET, ranges: ["Stock!A1:C3&x=1"] }] })).toThrow("GOOGLE_SHEETS_RANGES");
    expect(() => googleWorkspaceClient({ ...base, calendarIds: ["owner at store"] })).toThrow("GOOGLE_CALENDAR_IDS");
    expect(() => googleWorkspaceClient({ ...base, calendarIds: ["owner@store.test", "primary", "abc123@group.calendar.google.com"] })).not.toThrow();
  });

  it("allows only its five GETs, with the fields and flags it fixes and no search of its own", () => {
    const refused: unknown[] = [
      { method: "drive.files.get", fileId: "x" },
      { method: "drive.files.export", fileId: "x" },
      { method: "drive.files.create" },
      { method: "drive.changes.watch" },
      { method: "calendar.events.insert", calendarId: "primary" },
      { method: "calendar.events.watch", calendarId: "primary" },
      { method: "sheets.values.update", spreadsheetId: SHEET },
      { method: "sheets.spreadsheets.get", spreadsheetId: SHEET },
      { method: "drive.files.list", folderId: GOOGLE_MOCK_ROOT, q: "fullText contains 'x'" },
      { method: "drive.files.list", folderId: GOOGLE_MOCK_ROOT, fields: "*" },
      { method: "drive.files.list", folderId: "x' or name contains 'y" },
      { method: "drive.files.list", folderId: GOOGLE_MOCK_ROOT, pageToken: "abc&q=x" },
      { method: "drive.changes.list" },
      { method: "drive.changes.list", pageToken: "1", driveId: "../x" },
      { method: "drive.changes.list", pageToken: "1", restrictToMyDrive: true },
      { method: "drive.changes.getStartPageToken", driveId: "a b" },
      { method: "sheets.values.batchGet", spreadsheetId: "1TestSpreadsheet_000002_abcdefABCDEF", ranges: RANGES },
      { method: "sheets.values.batchGet", spreadsheetId: SHEET, ranges: ["Other!A1:B2"] },
      { method: "sheets.values.batchGet", spreadsheetId: SHEET, ranges: [] },
      { method: "sheets.values.batchGet", spreadsheetId: SHEET, ranges: RANGES, valueRenderOption: "FORMULA" },
      { method: "calendar.events.list", calendarId: "someone@store.test" },
      { method: "calendar.events.list", calendarId: "primary", q: "ring" },
      { method: "calendar.events.list", calendarId: "primary", syncToken: "abc", timeMin: "2026-01-01T00:00:00Z" },
      { method: "calendar.events.list", calendarId: "primary", timeMin: "2026-01-01" },
      { method: "calendar.events.list", calendarId: "primary", timeMin: "2026-13-45T99:00:00Z" },
      { method: "calendar.events.list", calendarId: "primary", showDeleted: true },
      { method: "calendar.events.list", calendarId: "primary", pageToken: "x".repeat(5000) },
      null,
      {},
    ];
    for (const request of refused) expect(() => googleWorkspaceReadUrl(request as GoogleWorkspaceRead, allow), JSON.stringify(request)).toThrow(GoogleWorkspaceConfigError);

    const files = new URL(googleWorkspaceReadUrl({ method: "drive.files.list", folderId: GOOGLE_MOCK_ROOT }, allow));
    expect(files.origin + files.pathname).toBe("https://www.googleapis.com/drive/v3/files");
    expect(files.searchParams.get("q")).toBe(`'${GOOGLE_MOCK_ROOT}' in parents and trashed = false`);
    expect(files.searchParams.get("fields")).toBe("nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,parents,size,trashed,driveId)");
    expect([files.searchParams.get("pageSize"), files.searchParams.get("supportsAllDrives"), files.searchParams.get("includeItemsFromAllDrives")]).toEqual(["1000", "true", "true"]);
    const changes = new URL(googleWorkspaceReadUrl({ method: "drive.changes.list", pageToken: "42", driveId: SHARED }, allow));
    expect(Object.fromEntries(changes.searchParams)).toMatchObject({ pageToken: "42", driveId: SHARED, includeRemoved: "true", supportsAllDrives: "true", pageSize: "1000" });
    expect(changes.searchParams.get("fields")).toContain("file(id,name,mimeType,modifiedTime,parents,size,trashed,driveId)");
    const sheets = new URL(googleWorkspaceReadUrl({ method: "sheets.values.batchGet", spreadsheetId: SHEET, ranges: RANGES }, allow));
    expect(sheets.pathname).toBe(`/v4/spreadsheets/${SHEET}/values:batchGet`);
    expect(sheets.searchParams.getAll("ranges")).toEqual(RANGES);
    const events = new URL(googleWorkspaceReadUrl({ method: "calendar.events.list", calendarId: "owner@store.test", timeMin: "2021-01-20T00:00:00.000Z" }, { ...allow, calendarIds: ["owner@store.test"] }));
    expect(events.pathname).toBe("/calendar/v3/calendars/owner%40store.test/events");
    expect(events.searchParams.get("fields")).not.toMatch(/summary|description|location|hangoutLink|conferenceData|displayName|attachments/);
    expect([events.searchParams.get("maxResults"), events.searchParams.get("singleEvents")]).toEqual(["2500", "false"]);
  });

  it("gets with a bearer token, never in the URL, after refreshing with the client's keys at Google's token endpoint", async () => {
    const sent: { url: string; method: string; auth: string | null; body: string }[] = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
      return sent.length === 1 ? tokenAnswer({ access_token: "AT-1", expires_in: 3599, scope: GOOGLE_MOCK_SCOPES.join(" ") }) : tokenAnswer({ startPageToken: "7" });
    }) as typeof globalThis.fetch;
    const client = googleWorkspaceClient({ ...options(googleWorkspaceDocMock(workspace())), fetch });
    expect(await client.read({ method: "drive.changes.getStartPageToken" })).toEqual({ startPageToken: "7" });
    expect(sent.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([`POST ${GOOGLE_TOKEN_URL}`, "GET https://www.googleapis.com/drive/v3/changes/startPageToken"]);
    const form = new URLSearchParams(sent[0]!.body);
    expect([form.get("client_id"), form.get("client_secret"), form.get("grant_type"), form.get("refresh_token")]).toEqual([CLIENT_ID, CLIENT_SECRET, "refresh_token", REFRESH]);
    expect(sent[1]!.auth).toBe("Bearer AT-1");
    expect(sent[1]!.url).not.toContain("AT-1");
  });

  it("won't use a connection holding anything beyond its read-only scopes and sign-in scopes", async () => {
    for (const wider of ["drive.readonly", "drive", "drive.file", "drive.metadata", "spreadsheets", "calendar", "calendar.readonly", "calendar.events", "gmail.metadata"]) {
      const mock = googleWorkspaceDocMock(workspace({ scopes: [...GOOGLE_MOCK_SCOPES, `https://www.googleapis.com/auth/${wider}`] }));
      const error = await failure(googleWorkspaceClient(options(mock)).read({ method: "drive.changes.getStartPageToken" }));
      expect(error, wider).toBeInstanceOf(GoogleWorkspaceConfigError);
      expect(error.message).toContain("more than read-only access");
      expect(mock.fetch.calls.filter((c) => c.method === "GET")).toEqual([]);
    }
    const signIn = googleWorkspaceDocMock(workspace({ scopes: [...GOOGLE_MOCK_SCOPES, "openid", "email"] }));
    await expect(googleWorkspaceClient(options(signIn)).read({ method: "drive.changes.getStartPageToken" })).resolves.toHaveProperty("startPageToken");
  });

  it("needs each scope only for what it reads, and refuses a token that doesn't say what it holds", async () => {
    const needs = { sheets: true, calendar: true };
    expect(googleWorkspaceScopeProblem(GOOGLE_MOCK_SCOPES.join(" "), needs)).toBeNull();
    expect(googleWorkspaceScopeProblem(DRIVE_METADATA_READONLY_SCOPE, { sheets: false, calendar: false })).toBeNull();
    expect(googleWorkspaceScopeProblem(`${DRIVE_METADATA_READONLY_SCOPE} ${SHEETS_READONLY_SCOPE}`, needs)).toContain(CALENDAR_EVENTS_READONLY_SCOPE);
    expect(googleWorkspaceScopeProblem(`${DRIVE_METADATA_READONLY_SCOPE} ${CALENDAR_EVENTS_READONLY_SCOPE}`, needs)).toContain(SHEETS_READONLY_SCOPE);
    expect(googleWorkspaceScopeProblem(`${SHEETS_READONLY_SCOPE} ${CALENDAR_EVENTS_READONLY_SCOPE}`, needs)).toContain(DRIVE_METADATA_READONLY_SCOPE);
    expect(googleWorkspaceScopeProblem("", needs)).toContain("didn't say");
    expect(googleWorkspaceScopeProblem(undefined, needs)).toContain("didn't say");
    const noScope = (async () => tokenAnswer({ access_token: "AT-1", expires_in: 3599 })) as typeof globalThis.fetch;
    await expect(googleWorkspaceClient({ ...options(googleWorkspaceDocMock(workspace())), fetch: noScope }).read({ method: "drive.changes.getStartPageToken" })).rejects.toThrow("didn't say");
    const partial = googleWorkspaceDocMock(workspace({ scopes: [DRIVE_METADATA_READONLY_SCOPE] }));
    await expect(googleWorkspaceClient(options(partial)).read({ method: "drive.changes.getStartPageToken" })).rejects.toThrow("doesn't hold");
    await expect(googleWorkspaceClient({ ...options(partial), sheets: [], calendarIds: [] }).read({ method: "drive.changes.getStartPageToken" })).resolves.toBeTruthy();
  });

  it("keeps using the same refresh token, saves one if Google ever sends a new one, and explains an expired one", async () => {
    const tokens = memoryTokenStore(REFRESH);
    const rotating = (async () => tokenAnswer({ access_token: "AT-1", expires_in: 3599, scope: GOOGLE_MOCK_SCOPES.join(" "), refresh_token: "1//TEST-new" })) as typeof globalThis.fetch;
    await failure(googleWorkspaceClient({ ...options(googleWorkspaceDocMock(workspace())), tokens, fetch: rotating }).read({ method: "drive.changes.getStartPageToken" }));
    expect(tokens.current).toBe("1//TEST-new");
    const expired = googleWorkspaceDocMock(workspace({ refreshToken: "other" }));
    const error = await failure(googleWorkspaceClient(options(expired)).read({ method: "drive.changes.getStartPageToken" }));
    expect(error).toBeInstanceOf(GoogleWorkspaceApiError);
    expect(error.message).toContain("invalid_grant");
    expect(error.message).toContain("reconnect Google Workspace");
    expect(error.message).not.toContain(REFRESH);
    await expect(googleWorkspaceClient({ ...options(expired), tokens: memoryTokenStore(" ") }).read({ method: "drive.changes.getStartPageToken" })).rejects.toThrow("set GOOGLE_WORKSPACE_REFRESH_TOKEN");
  });

  it("refreshes once for reads at the same time, renews before expiry, and refreshes once when revoked early", async () => {
    const mock = googleWorkspaceDocMock(workspace());
    let clock = Date.parse(GOOGLE_MOCK_NOW);
    const client = googleWorkspaceClient({ ...options(mock), clock: () => clock });
    await Promise.all([client.read({ method: "drive.changes.getStartPageToken" }), client.read({ method: "drive.changes.getStartPageToken" })]);
    expect(mock.refreshes).toBe(1);
    clock += 3599_000 - 60_000;
    await client.read({ method: "drive.changes.getStartPageToken" });
    expect(mock.refreshes).toBe(2);
    mock.revokeAccessTokens();
    await client.read({ method: "drive.changes.getStartPageToken" });
    expect(mock.refreshes).toBe(3);
    const always401 = (async (url: string | URL) =>
      String(url) === GOOGLE_TOKEN_URL ? tokenAnswer({ access_token: "AT", expires_in: 3599, scope: GOOGLE_MOCK_SCOPES.join(" ") }) : tokenAnswer({ error: { code: 401, message: "no" } }, 401)) as typeof globalThis.fetch;
    await expect(googleWorkspaceClient({ ...options(mock), fetch: always401 }).read({ method: "drive.changes.getStartPageToken" })).rejects.toThrow("HTTP 401");
  });

  it("waits out 429s and rate-limit 403s, honouring Retry-After up to 64 seconds, and stops at once on the daily limit", async () => {
    const waits: number[] = [];
    const mock = googleWorkspaceDocMock(workspace({ rateLimits: [{ status: 429, retryAfter: 3 }, { status: 403, reason: "userRateLimitExceeded" }, { status: 429, retryAfter: 900 }] }));
    await googleWorkspaceClient({ ...options(mock), sleep: async (ms) => void waits.push(ms) }).read({ method: "drive.changes.getStartPageToken" });
    expect(waits.filter((w) => w >= 1000)).toEqual([3000, 2000, 64_000]);
    const stubborn = googleWorkspaceDocMock(workspace({ rateLimits: Array.from({ length: 3 }, () => ({ status: 429 as const })) }));
    await expect(googleWorkspaceClient({ ...options(stubborn), rateLimitRetries: 2 }).read({ method: "drive.changes.getStartPageToken" })).rejects.toThrow("kept rate-limiting");
    const daily = googleWorkspaceDocMock(workspace({ rateLimits: [{ status: 403, reason: "dailyLimitExceeded" }] }));
    const error = await failure(googleWorkspaceClient(options(daily)).read({ method: "drive.changes.getStartPageToken" }));
    expect(error.message).toContain("daily limit");
    expect(daily.fetch.calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("paces each API under its own per-user budget, Sheets slowest", async () => {
    const waits: number[] = [];
    const mock = googleWorkspaceDocMock(workspace());
    const client = googleWorkspaceClient({ ...options(mock), sleep: async (ms) => void waits.push(ms) });
    await client.read({ method: "sheets.values.batchGet", spreadsheetId: SHEET, ranges: RANGES });
    await client.read({ method: "sheets.values.batchGet", spreadsheetId: SHEET, ranges: RANGES });
    await client.read({ method: "calendar.events.list", calendarId: "primary", timeMin: "2021-01-20T00:00:00.000Z" });
    await client.read({ method: "calendar.events.list", calendarId: "primary", timeMin: "2021-01-20T00:00:00.000Z" });
    expect(waits).toEqual([GOOGLE_PACE_MS.sheets, GOOGLE_PACE_MS.calendar]);
  });

  it("answers null for a 404, throws 410 for an expired sync token, and reports other errors cut short", async () => {
    const mock = googleWorkspaceDocMock(workspace());
    const client = googleWorkspaceClient({ ...options(mock), sheets: [{ spreadsheetId: "1TestSpreadsheet_000009_abcdefABCDEF", ranges: RANGES }], calendarIds: ["missing@store.test"] });
    expect(await client.read({ method: "sheets.values.batchGet", spreadsheetId: "1TestSpreadsheet_000009_abcdefABCDEF", ranges: RANGES })).toBeNull();
    const answer = (status: number, body: unknown) => (async (url: string | URL) => (String(url) === GOOGLE_TOKEN_URL ? tokenAnswer({ access_token: "AT", expires_in: 3599, scope: GOOGLE_MOCK_SCOPES.join(" ") }) : new Response(typeof body === "string" ? body : JSON.stringify(body), { status }))) as typeof globalThis.fetch;
    const gone = await failure(googleWorkspaceClient({ ...options(mock), fetch: answer(410, { error: { code: 410, errors: [{ reason: "fullSyncRequired" }] } }) }).read({ method: "calendar.events.list", calendarId: "primary", syncToken: "abc" }));
    expect(gone).toMatchObject({ status: 410, reason: "fullSyncRequired" });
    const policy = await failure(googleWorkspaceClient({ ...options(mock), fetch: answer(403, { error: { message: "x".repeat(500), errors: [{ reason: "domainPolicy" }] } }) }).read({ method: "drive.changes.getStartPageToken" }));
    expect(policy.message).toContain("turned off access for apps");
    expect(policy.message.length).toBeLessThan(300);
    await expect(googleWorkspaceClient({ ...options(mock), fetch: answer(200, "not json") }).read({ method: "drive.changes.getStartPageToken" })).rejects.toThrow("did not answer with JSON");
  });

  it("is answered by a mock that holds each API to the scopes and parameters Google documents", async () => {
    const mock = googleWorkspaceDocMock(workspace({ scopes: [DRIVE_METADATA_READONLY_SCOPE] }));
    const client = googleWorkspaceClient({ ...options(mock), sheets: [], calendarIds: [] });
    await client.read({ method: "drive.changes.getStartPageToken" });
    // drive.metadata.readonly can't read Sheets values, and the mock says so as Google does.
    const raw = await mock.fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values:batchGet?ranges=Stock!A1:C3`, { headers: { authorization: "Bearer AT-TEST-1" } });
    expect(raw.status).toBe(403);
    const query = await mock.fetch("https://www.googleapis.com/drive/v3/files?q=name%20contains%20'x'", { headers: { authorization: "Bearer AT-TEST-1" } });
    expect(query.status).toBe(400);
    await expect(mock.fetch("https://www.googleapis.com/drive/v3/files/abc", {})).rejects.toThrow("not in the vendor's docs");
    await expect(mock.fetch("https://www.googleapis.com/drive/v3/changes/watch", { method: "POST" })).rejects.toThrow("not in the vendor's docs");
    await expect(mock.fetch("https://oauth2.googleapis.com.example.test/token", { method: "POST" })).rejects.toThrow("not in the vendor's docs");
  });
});

describe("Google Workspace settings", () => {
  it("reads the ranges, calendars and shared drives the owner lists, and nothing else", () => {
    expect(parseSheetRanges(undefined)).toEqual([]);
    expect(parseSheetRanges(` ${SHEET}/Stock!A1:C3, ${SHEET}/'Price list'!A:B,${SHEET}/Stock!A1:C3`)).toEqual([{ spreadsheetId: SHEET, ranges: RANGES }]);
    for (const bad of ["Stock!A1:C3", `${SHEET}/`, `${SHEET}/Stock`, `${SHEET}/Price list!A:B`, `${SHEET}/'Bad'name'!A1`, `short/Stock!A1`]) expect(() => parseSheetRanges(bad), bad).toThrow("GOOGLE_SHEETS_RANGES");
    expect(() => parseSheetRanges("x".repeat(9000))).toThrow("too long");
    expect(() => parseSheetRanges(Array.from({ length: 21 }, (_, i) => `${SHEET}/S${i}!A1`).join(","))).toThrow("at most");
    expect(parseCalendarIds(undefined)).toEqual(["primary"]);
    expect(parseCalendarIds("none")).toEqual([]);
    expect(parseCalendarIds("primary, bookings@store.test,primary")).toEqual(["primary", "bookings@store.test"]);
    expect(() => parseCalendarIds("bookings at store")).toThrow("GOOGLE_CALENDAR_IDS");
    expect(() => parseCalendarIds("a".repeat(5000))).toThrow("too long");
    expect(parseSharedDriveIds(` ${SHARED} ,${SHARED}`)).toEqual([SHARED]);
    expect(parseSharedDriveIds("")).toEqual([]);
    expect(() => parseSharedDriveIds("a/b")).toThrow("GOOGLE_DRIVE_SHARED_DRIVE_IDS");
    expect(() => parseSharedDriveIds("a".repeat(5000))).toThrow("too long");
    expect(() => connector(googleWorkspaceDocMock(workspace()), { rootFolderId: "x'y" })).toThrow("GOOGLE_DRIVE_ROOT_FOLDER_ID");
    expect(() => connector(googleWorkspaceDocMock(workspace()), { sharedDriveIds: ["a b"] })).toThrow("GOOGLE_DRIVE_SHARED_DRIVE_IDS");
  });

  it("checks hostile settings and headers in linear time", () => {
    const started = performance.now();
    for (const hostile of [`${SHEET}/'${"a ".repeat(50_000)}`, `${SHEET}/${"A".repeat(100_000)}!`, `${"1".repeat(60_000)}/x`, `${"a.".repeat(40_000)}@x`]) {
      expect(() => parseSheetRanges(hostile)).toThrow();
      expect(() => parseCalendarIds(hostile)).toThrow();
    }
    expect(() => googleWorkspaceReadUrl({ method: "calendar.events.list", calendarId: "primary", pageToken: "a".repeat(100_000) + "!" }, allow)).toThrow();
    expect(googleWorkspaceScopeProblem(`${"x ".repeat(200_000)}`, { sheets: false, calendar: false })).toContain("more than");
    expect(normalize.fileEvents({ id: "a".repeat(100_000), mimeType: "a/b" }, RECEIVED)).toEqual([]);
    expect(normalize.fileEvents({ id: "abc", mimeType: `${"a".repeat(60_000)}/${"b".repeat(60_000)}` }, RECEIVED)).toEqual([]);
    expect(normalize.appointmentEvents("primary", { id: "abc", attendees: [{ email: `${"a".repeat(50_000)}@${"b".repeat(50_000)}` }], updated: `2026-01-01T00:00:00${"0".repeat(100_000)}Z` }, RECEIVED)[0]!.payload.attendees).toBeUndefined();
    const verifier = googlePushVerifier({ channelToken: CHANNEL_TOKEN, channels: [] });
    expect(verifier.verify({ "x-goog-channel-token": "a".repeat(100_000), "x-goog-channel-id": "-".repeat(100_000), "x-goog-resource-state": "a".repeat(100_000), "x-goog-message-number": "9".repeat(100_000), "x-goog-resource-id": "b".repeat(100_000) })).toEqual({ ok: false, reason: "malformed" });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("Google Workspace normalization", () => {
  it("keeps a file's id, name, type, folder, size and time, and drops owners, links and descriptions", () => {
    googleFile.reset();
    const [event] = normalize.fileEvents({ ...googleFile.one(), driveId: SHARED }, RECEIVED);
    expect(event).toMatchObject({ type: "document.file_updated", occurredAt: before(DAY), receivedAt: RECEIVED });
    expect(event!.payload).toEqual({
      fileId: `gdrive:file:${googleDriveId("File", 1)}`,
      name: "Synthetic invoice 1.pdf",
      mimeType: "application/pdf",
      kind: "pdf",
      parentId: `gdrive:file:${GOOGLE_MOCK_ROOT}`,
      sharedDriveId: SHARED,
      modifiedAt: before(DAY),
      sizeBytes: 10_001,
    });
    expect(JSON.stringify(event)).not.toMatch(/example\.test|Test Customer|description|webViewLink/);
  });

  it("keeps ids only when names are turned off, and stores a new version on a rename, move or edit", () => {
    googleFile.reset();
    const file = googleFile.one();
    const dropped = googleWorkspaceNormalizer({ correspondentKey: KEY, fileNames: "drop" }).fileEvents(file, RECEIVED)[0]!;
    expect(dropped.payload).toMatchObject({ nameWithheld: true });
    expect(dropped.payload).not.toHaveProperty("name");
    const key = (f: GoogleMockFile) => normalize.fileEvents(f, RECEIVED)[0]!.idempotencyKey;
    expect(new Set([key(file), key({ ...file, name: "Renamed.pdf" }), key({ ...file, parents: [SUB] }), key({ ...file, modifiedTime: before(0) })]).size).toBe(4);
    expect(key(file)).toBe(normalize.fileEvents(file, "2030-01-01T00:00:00.000Z")[0]!.idempotencyKey);
    expect(normalize.fileEvents({ ...file, name: "x".repeat(500) }, RECEIVED)[0]!.payload.name).toHaveLength(200);
  });

  it("skips items without a usable id or type, and leaves an unreadable time to be dead-lettered", () => {
    expect(normalize.fileEvents({ id: "a/b", mimeType: "application/pdf" }, RECEIVED)).toEqual([]);
    expect(normalize.fileEvents({ id: "abc", mimeType: "pdf" }, RECEIVED)).toEqual([]);
    expect(normalize.fileEvents(null as never, RECEIVED)).toEqual([]);
    expect(normalize.fileEvents({ id: "abc", mimeType: "application/pdf", modifiedTime: "yesterday", size: "1".repeat(20) }, RECEIVED)[0]).toMatchObject({ occurredAt: undefined, payload: { kind: "pdf" } });
    expect(normalize.removedEvents("a b", "trashed", undefined, RECEIVED)).toEqual([]);
    const [removed] = normalize.removedEvents("abc", "trashed", "2026-01-19T00:00:00.000Z", RECEIVED);
    expect(removed).toMatchObject({ type: "document.file_removed", occurredAt: "2026-01-19T00:00:00.000Z", payload: { fileId: "gdrive:file:abc", reason: "trashed" } });
    expect(normalize.removedEvents("abc", "removed", undefined, RECEIVED)[0]!.occurredAt).toBe(RECEIVED);
  });

  it("names each kind of Drive item", () => {
    expect(["application/vnd.google-apps.folder", "application/vnd.google-apps.spreadsheet", "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.google-apps.document", "application/msword", "application/vnd.google-apps.presentation", "application/pdf", "image/png", "application/zip"].map(driveKind)).toEqual(
      ["folder", "spreadsheet", "spreadsheet", "spreadsheet", "document", "document", "presentation", "pdf", "image", "file"],
    );
  });

  it("keeps an appointment's times, status and attendee responses, and drops its title, notes, place, link and addresses", () => {
    googleEvent.reset();
    const [event] = normalize.appointmentEvents("primary", googleEvent.one() as never, RECEIVED);
    expect(event).toMatchObject({ type: "calendar.appointment_updated", occurredAt: before(2 * DAY) });
    expect(event!.payload).toEqual({
      calendarId: "primary",
      appointmentId: `gcal:event:${googleEventId(1)}`,
      status: "confirmed",
      start: { dateTime: new Date(Date.parse(before(DAY)) + 10 * 3_600_000).toISOString(), timeZone: "America/New_York" },
      end: { dateTime: new Date(Date.parse(before(DAY)) + 11 * 3_600_000).toISOString(), timeZone: "America/New_York" },
      createdAt: before(8 * DAY),
      updatedAt: before(2 * DAY),
      eventType: "default",
      busy: true,
      organizer: hmac(KEY, "owner@store.test"),
      attendees: [
        { correspondentId: hmac(KEY, "owner@store.test"), responseStatus: "accepted", organizer: true, self: true },
        { correspondentId: hmac(KEY, "customer1@example.test"), responseStatus: "needsAction" },
      ],
      attendeeCount: 2,
      responses: { accepted: 1, needsAction: 1 },
    });
    expect(JSON.stringify(event)).not.toMatch(/@|Ring sizing|Synthetic notes|Test Street|meet\.example|Test Customer|555/);
  });

  it("keys attendees with this instance's key, the same reference Gmail gives the address", () => {
    const attendee = (key: string) => (googleWorkspaceNormalizer({ correspondentKey: key }).appointmentEvents("primary", { id: "abc", updated: RECEIVED, attendees: [{ email: " Customer1@Example.TEST " }] }, RECEIVED)[0]!.payload.attendees as { correspondentId: string }[])[0]!.correspondentId;
    // Gmail's reference: HMAC-SHA256 of karatos:correspondent:v1:<address>, lower-cased.
    expect(attendee(KEY)).toBe(hmac(KEY, "customer1@example.test"));
    expect(attendee(OTHER_KEY)).not.toBe(attendee(KEY));
    expect(() => googleWorkspaceNormalizer({ correspondentKey: "short" })).toThrow("CORRESPONDENT_HASH_KEY");
    const [mine] = normalize.appointmentEvents("bookings@store.test", { id: "abc", updated: RECEIVED }, RECEIVED);
    expect(mine!.payload.calendarId).toBe(hmac(KEY, "bookings@store.test"));
    expect(mine!.idempotencyKey).not.toContain("bookings");
  });

  it("records a cancellation with only an id, and a new version on each change", () => {
    const [cancelled] = normalize.appointmentEvents("primary", { id: "abc", status: "cancelled" }, RECEIVED);
    expect(cancelled).toMatchObject({ type: "calendar.appointment_cancelled", occurredAt: RECEIVED, payload: { appointmentId: "gcal:event:abc", status: "cancelled" } });
    expect(cancelled!.payload).not.toHaveProperty("busy");
    const instance = normalize.appointmentEvents("primary", { id: "abc_20260101T100000Z", status: "cancelled", recurringEventId: "abc", originalStartTime: { dateTime: "2026-01-01T10:00:00Z" } }, RECEIVED)[0]!;
    expect(instance.payload).toMatchObject({ seriesId: "gcal:event:abc", originalStart: { dateTime: "2026-01-01T10:00:00.000Z" } });
    const at = (updated: string, status = "confirmed") => normalize.appointmentEvents("primary", { id: "abc", updated, status }, RECEIVED)[0]!.idempotencyKey;
    expect(new Set([at("2026-01-01T00:00:00Z"), at("2026-01-02T00:00:00Z"), at("2026-01-02T00:00:00Z", "tentative")]).size).toBe(3);
    // No update time on a live appointment: no made-up time, so it's dead-lettered.
    expect(normalize.appointmentEvents("primary", { id: "abc" }, RECEIVED)[0]!.occurredAt).toBeUndefined();
    expect(normalize.appointmentEvents("primary", { id: "a b" }, RECEIVED)).toEqual([]);
    expect(normalize.appointmentEvents("not a calendar", { id: "abc" }, RECEIVED)).toEqual([]);
    const allDay = normalize.appointmentEvents("primary", { id: "abc", updated: RECEIVED, start: { date: "2026-02-01" }, end: { date: "2026-02-02" }, transparency: "transparent", status: "odd", eventType: "other" }, RECEIVED)[0]!;
    expect(allDay.payload).toMatchObject({ start: { date: "2026-02-01" }, busy: false, status: "confirmed" });
    expect(allDay.payload).not.toHaveProperty("eventType");
  });

  it("counts every attendee but keeps at most 50", () => {
    const attendees = Array.from({ length: 80 }, (_, i) => ({ email: `guest${i}@example.test`, responseStatus: "accepted" }));
    const payload = normalize.appointmentEvents("primary", { id: "abc", updated: RECEIVED, attendees, attendeesOmitted: true }, RECEIVED)[0]!.payload;
    expect(payload).toMatchObject({ attendeeCount: 80, attendeesOmitted: true, responses: { accepted: 80 } });
    expect(payload.attendees).toHaveLength(50);
  });

  it("keeps a listed range's cells, capped, with an address cell turned into a reference", () => {
    const [event] = normalize.rangeEvents(SHEET, RANGES[0]!, { values: [["SKU", 1.5, true, null, " buyer@vendor-casting.test ", "x".repeat(600), Number.NaN]] }, RECEIVED);
    expect(event).toMatchObject({ type: "document.sheet_range_read", occurredAt: RECEIVED, payload: { spreadsheetId: `gdrive:file:${SHEET}`, range: RANGES[0], rowCount: 1, cellCount: 7 } });
    const row = (event!.payload.values as unknown[][])[0]!;
    expect(row.slice(0, 5)).toEqual(["SKU", 1.5, true, null, hmac(KEY, "buyer@vendor-casting.test")]);
    expect((row[5] as string).length).toBe(500);
    expect(row[6]).toBeNull();
    const big = normalize.rangeEvents(SHEET, RANGES[0]!, { values: Array.from({ length: 300 }, () => Array.from({ length: 100 }, () => 1)) }, RECEIVED)[0]!;
    expect(big.payload).toMatchObject({ cellCount: SHEET_MAX_CELLS, truncated: true });
    const key = (values: unknown[][]) => normalize.rangeEvents(SHEET, RANGES[0]!, { values }, "2030-01-01T00:00:00.000Z")[0]!.idempotencyKey;
    expect(key([[1]])).toBe(normalize.rangeEvents(SHEET, RANGES[0]!, { values: [[1]] }, RECEIVED)[0]!.idempotencyKey);
    expect(key([[1]])).not.toBe(key([[2]]));
    expect(normalize.rangeEvents(SHEET, RANGES[0]!, undefined, RECEIVED)[0]!.payload).toMatchObject({ rowCount: 0, values: [] });
  });

  it("uses synthetic fixtures only", () => {
    const data = workspace();
    assertSynthetic(data);
  });
});

describe("Google Workspace sync", () => {
  it("imports, replays, resumes and retries the mocked workspace", async () => {
    await checkConnectorSync({ makeConnector: () => connector(googleWorkspaceDocMock(workspace())), expected: { ingested: 10, deadLettered: 1 } });
  });

  it("walks the shared folder for metadata, reads only the listed ranges and calendars, and never downloads or writes", async () => {
    const mock = googleWorkspaceDocMock(workspace());
    const { report, memory } = await run(mock, "historical");
    expect(report).toMatchObject({ ingested: 10, deadLettered: 1 });
    expect(mock.fetch.calls.every((c) => c.method === "GET" || c.url === GOOGLE_TOKEN_URL)).toBe(true);
    expect(urls(mock).filter((u) => u.startsWith("GET")).map((u) => u.split("?")[0])).toEqual([
      "GET https://www.googleapis.com/drive/v3/changes/startPageToken",
      "GET https://www.googleapis.com/drive/v3/files",
      "GET https://www.googleapis.com/drive/v3/files",
      "GET https://www.googleapis.com/drive/v3/files",
      `GET https://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values:batchGet`,
      "GET https://www.googleapis.com/calendar/v3/calendars/primary/events",
    ]);
    const types = memory.events.map((e) => e.type);
    expect(types.filter((t) => t === "document.file_updated")).toHaveLength(6);
    expect(types.filter((t) => t === "document.sheet_range_read")).toHaveLength(2);
    expect(types.filter((t) => t === "calendar.appointment_updated")).toHaveLength(2);
    const names = memory.events.map((e) => e.payload.name).filter(Boolean);
    expect(names).not.toContain("Synthetic invoice 5.pdf");
    expect(names).not.toContain("Synthetic invoice 6.pdf");
    expect(names).not.toContain("Synthetic invoice 7.pdf");
    expect(urls(mock).find((u) => u.includes("calendar"))).toContain("timeMin=2021-01-20T00:00:00.000Z");
    expect(JSON.stringify(memory.events)).not.toMatch(/example\.test|store\.test|Ring sizing|Test Customer/);
  });

  it("pages through big folders, walks shared drives like folders, and keeps their items", async () => {
    googleFile.reset();
    const data = workspace();
    const many = googleFile.many(1500, () => ({ parents: [GOOGLE_MOCK_ROOT] }));
    const shared = { ...googleFile.one({ parents: [SHARED], driveId: SHARED }), id: googleDriveId("Shared", 1) };
    const mock = googleWorkspaceDocMock({ ...data, files: [...data.files, ...many, shared] });
    const { memory } = await run(mock, "historical", testPipeline(), { sharedDriveIds: [SHARED], sheets: [], calendarIds: [] });
    expect(memory.events.filter((e) => e.type === "document.file_updated")).toHaveLength(6 + 1500 + 1);
    expect(memory.events.find((e) => e.payload.fileId === `gdrive:file:${shared.id}`)!.payload.sharedDriveId).toBe(SHARED);
    const gets = urls(mock).filter((u) => u.startsWith("GET"));
    expect(gets.filter((u) => u.includes("startPageToken"))).toHaveLength(2);
    expect(gets.filter((u) => u.includes(`'${GOOGLE_MOCK_ROOT}' in parents`))).toHaveLength(2);
    expect(gets.find((u) => u.includes("startPageToken") && u.includes(`driveId=${SHARED}`))).toBeDefined();
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(googleWorkspaceDocMock(workspace())), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: async () => {} });
    expect(report).toMatchObject({ ingested: 10, deadLettered: 1 });
  });

  it("leaves a finished import finished", async () => {
    const mock = googleWorkspaceDocMock(workspace());
    const store = testPipeline();
    await run(mock, "historical", store);
    const calls = mock.fetch.calls.length;
    expect((await run(mock, "historical", store)).report).toMatchObject({ ingested: 0, batches: 0 });
    expect(mock.fetch.calls.length).toBe(calls);
  });

  it("starts incremental syncs like the import, then reads only Drive's changes, the ranges and Calendar's changes", async () => {
    const mock = googleWorkspaceDocMock(workspace());
    const store = testPipeline();
    expect((await run(mock, "incremental", store)).report).toMatchObject({ ingested: 10 });
    const before2 = mock.fetch.calls.length;
    expect((await run(mock, "incremental", store)).report).toMatchObject({ ingested: 0, duplicates: 2, deadLettered: 0 });
    const second = urls(mock).slice(before2).filter((u) => u.startsWith("GET"));
    expect(second.map((u) => u.split("?")[0])).toEqual([
      "GET https://www.googleapis.com/drive/v3/changes",
      `GET https://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values:batchGet`,
      "GET https://www.googleapis.com/calendar/v3/calendars/primary/events",
    ]);
    expect(second[2]).toContain("syncToken=");
    expect(second[2]).not.toContain("timeMin");
  });

  it("keeps Drive changes inside the shared folders: edits, new folders and what they bring, trash, removals and moves out", async () => {
    const data = workspace();
    const mock = googleWorkspaceDocMock(data);
    const store = testPipeline();
    await run(mock, "incremental", store, { sheets: [], calendarIds: [] });
    const t = "2026-01-20T01:00:00.000Z";
    const moved = googleDriveId("Moved", 1);
    const outsideFolder = googleDriveId("Elsewhere", 1);
    const broughtIn = { ...googleFile.one({ parents: [moved], name: "Brought in.pdf", modifiedTime: t }) };
    // The moved-in folder's contents exist before it moves; the walk finds them.
    mock.change({ stream: "my", fileId: broughtIn.id, time: t, file: broughtIn });
    mock.change({ stream: "my", fileId: data.files[0]!.id, time: t, file: { ...data.files[0]!, name: "Renamed invoice.pdf", modifiedTime: t } });
    mock.change({ stream: "my", fileId: moved, time: t, file: folder(moved, SUB, { modifiedTime: t }) });
    mock.change({ stream: "my", fileId: data.files[1]!.id, time: t, file: { ...data.files[1]!, trashed: true, modifiedTime: t } });
    mock.change({ stream: "my", fileId: DEEP, time: t, file: folder(DEEP, outsideFolder, { modifiedTime: t }) });
    mock.change({ stream: "my", fileId: SUB, time: t, removed: true });
    mock.change({ stream: "my", fileId: data.files[6]!.id, time: t, file: { ...data.files[6]!, modifiedTime: t } });
    mock.change({ stream: "my", fileId: googleDriveId("Unknown", 1), time: t, removed: true });
    const before3 = store.memory.events.length;
    const { report } = await run(mock, "incremental", store, { sheets: [], calendarIds: [] });
    const fresh = store.memory.events.slice(before3);
    expect(fresh.map((e) => [e.type, e.payload.reason ?? e.payload.name])).toEqual([
      ["document.file_updated", "Renamed invoice.pdf"],
      ["document.file_updated", "Synthetic folder " + moved.slice(-4)],
      ["document.file_removed", "trashed"],
      ["document.file_removed", "moved_out"],
      ["document.file_removed", "removed"],
      ["document.file_updated", "Brought in.pdf"],
    ]);
    expect(report.deadLettered).toBe(0);
    const cursor = parseGoogleWorkspaceCursor(report.cursor)!;
    expect(cursor.folders).toEqual([GOOGLE_MOCK_ROOT, moved]);
    expect(cursor.step).toBe("done");
  });

  it("reads each shared drive's own change feed", async () => {
    const mock = googleWorkspaceDocMock(workspace());
    const store = testPipeline();
    const extra = { sharedDriveIds: [SHARED], sheets: [], calendarIds: [] };
    await run(mock, "incremental", store, extra);
    const file = googleFile.one({ parents: [SHARED], driveId: SHARED, modifiedTime: "2026-01-20T01:00:00.000Z" });
    mock.change({ stream: SHARED, fileId: file.id, time: file.modifiedTime, file });
    const { report } = await run(mock, "incremental", store, extra);
    expect(report.ingested).toBe(1);
    expect(urls(mock).filter((u) => u.includes("/changes?")).at(-1)).toContain(`driveId=${SHARED}`);
  });

  it("pages Drive's change feed 1,000 at a time before taking the new token", async () => {
    const mock = googleWorkspaceDocMock(workspace());
    const store = testPipeline();
    await run(mock, "incremental", store, { sheets: [], calendarIds: [] });
    for (let i = 0; i < 1500; i++) {
      const file = googleFile.one({ modifiedTime: "2026-01-20T01:00:00.000Z" });
      mock.change({ stream: "my", fileId: file.id, time: file.modifiedTime, file });
    }
    const { report } = await run(mock, "incremental", store, { sheets: [], calendarIds: [] });
    expect(report).toMatchObject({ ingested: 1500, batches: 2 });
    expect((await run(mock, "incremental", store, { sheets: [], calendarIds: [] })).report.ingested).toBe(0);
  });

  it("reads appointment changes with the sync token, and lists again from five years back when Calendar answers 410", async () => {
    const mock = googleWorkspaceDocMock(workspace());
    const store = testPipeline();
    const extra = { sheets: [] };
    await run(mock, "incremental", store, extra);
    googleEvent.reset();
    const moved = googleEvent.one({ updated: "2026-01-20T02:00:00.000Z", start: { dateTime: "2026-02-01T15:00:00.000Z" } });
    mock.putEvent("primary", moved);
    mock.putEvent("primary", { ...googleEvent.one(), status: "cancelled", updated: "2026-01-20T03:00:00.000Z" } as GoogleMockEvent);
    const before4 = store.memory.events.length;
    expect((await run(mock, "incremental", store, extra)).report).toMatchObject({ ingested: 2 });
    expect(store.memory.events.slice(before4).map((e) => e.type)).toEqual(["calendar.appointment_updated", "calendar.appointment_cancelled"]);
    mock.expireSyncTokens();
    const calls = mock.fetch.calls.length;
    expect((await run(mock, "incremental", store, extra)).report).toMatchObject({ ingested: 0, duplicates: 1 });
    const calendarCalls = urls(mock).slice(calls).filter((u) => u.includes("/events"));
    expect(calendarCalls).toHaveLength(2);
    expect(calendarCalls[0]).toContain("syncToken=");
    expect(calendarCalls[1]).toContain("timeMin=");
    expect((await run(mock, "incremental", store, extra)).report).toMatchObject({ ingested: 0, duplicates: 0 });
  });

  it("pages through a busy calendar 2,500 appointments at a time before taking the sync token", async () => {
    googleEvent.reset();
    const events = googleEvent.many(2600, () => ({ start: { dateTime: "2026-01-10T15:00:00.000Z" }, end: { dateTime: "2026-01-10T16:00:00.000Z" }, updated: "2026-01-09T00:00:00.000Z" }));
    const mock = googleWorkspaceDocMock(workspace({ calendars: { primary: events } }));
    const store = testPipeline();
    const { report } = await run(mock, "incremental", store, { sheets: [] });
    expect(store.memory.events.filter((e) => e.type === "calendar.appointment_updated")).toHaveLength(2600);
    expect(urls(mock).filter((u) => u.includes("/events"))).toHaveLength(2);
    expect(parseGoogleWorkspaceCursor(report.cursor)!.calendarTokens.primary).toBeDefined();
  });

  it("stores a range again only when its values change, and skips a spreadsheet that's gone", async () => {
    const data = workspace();
    const mock = googleWorkspaceDocMock(data);
    const store = testPipeline();
    const extra = { calendarIds: [] };
    await run(mock, "incremental", store, extra);
    data.sheets![SHEET]![RANGES[0]!]![1]![1] = 3;
    expect((await run(mock, "incremental", store, extra)).report).toMatchObject({ ingested: 1, duplicates: 1 });
    delete data.sheets![SHEET];
    expect((await run(mock, "incremental", store, extra)).report).toMatchObject({ ingested: 0, duplicates: 0 });
  });

  it("starts over when the shared folder or shared drives change, and stops past the folder limit", async () => {
    const mock = googleWorkspaceDocMock(workspace());
    const store = testPipeline();
    await run(mock, "incremental", store, { sheets: [], calendarIds: [] });
    const calls = mock.fetch.calls.length;
    await run(mock, "incremental", store, { sheets: [], calendarIds: [], rootFolderId: SUB });
    expect(urls(mock).slice(calls).some((u) => u.includes("startPageToken"))).toBe(true);
    const crowded = googleWorkspaceDocMock(workspace({ files: Array.from({ length: GOOGLE_DRIVE_MAX_FOLDERS }, (_, i) => folder(googleDriveId("Many", i), GOOGLE_MOCK_ROOT)) }));
    await expect(run(crowded, "historical", testPipeline(), { sheets: [], calendarIds: [] })).rejects.toThrow("share a narrower folder");
  });

  it("carries on past settings that shrank since the checkpoint", async () => {
    const mock = googleWorkspaceDocMock(workspace());
    const store = testPipeline();
    await run(mock, "incremental", store);
    const saved = parseGoogleWorkspaceCursor(await store.memory.getCheckpoint(TEST_ORG, "google_workspace", "incremental"))!;
    const midSheets: GoogleWorkspaceCursor = { ...saved, step: "sheets", index: 0 };
    const midCalendar: GoogleWorkspaceCursor = { ...saved, step: "calendar", index: 3 };
    for (const cursor of [midSheets, midCalendar]) {
      const batches = connector(mock, { sheets: [], calendarIds: [] }).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(cursor) });
      const seen: unknown[] = [];
      for await (const batch of batches) seen.push(batch);
      expect(seen).toEqual([]);
    }
  });

  it("stops at Google's daily limit with the checkpoint where it was, and carries on from there", async () => {
    const limited = googleWorkspaceDocMock(workspace());
    const store = testPipeline();
    // The third read (the subfolder listing) hits the daily limit.
    let reads = 0;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== GOOGLE_TOKEN_URL && ++reads === 3) return tokenAnswer({ error: { code: 403, errors: [{ reason: "dailyLimitExceeded" }] } }, 403);
      return limited.fetch(input, init);
    }) as typeof globalThis.fetch;
    const error = await failure(runSync({ connector: connector(limited, { fetch }), mode: "historical", pipeline: store.pipeline, memory: store.memory, organizationId: TEST_ORG, attempts: 1, sleep: async () => {} }));
    expect(error.message).toContain("daily limit");
    const saved = parseGoogleWorkspaceCursor(await store.memory.getCheckpoint(TEST_ORG, "google_workspace", "historical"))!;
    expect(saved.step).toBe("walk");
    expect(saved.queue[0]).toBe(SUB);
    expect((await run(limited, "historical", store)).report).toMatchObject({ ingested: 7, duplicates: 0 });
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: GoogleWorkspaceCursor = {
      pass: "incremental",
      step: "done",
      roots: [GOOGLE_MOCK_ROOT],
      since: "2021-01-20T00:00:00.000Z",
      changeTokens: { my: "42" },
      stream: 0,
      pageToken: null,
      folders: [GOOGLE_MOCK_ROOT, SUB],
      queue: [],
      index: 0,
      calendarTokens: { primary: "abc" },
    };
    expect(parseGoogleWorkspaceCursor(JSON.stringify(good))).toEqual(good);
    expect(parseGoogleWorkspaceCursor(null)).toBeNull();
    const bad: unknown[] = [
      null,
      [],
      { ...good, extra: 1 },
      { ...good, pass: "other" },
      { ...good, step: "other" },
      { ...good, roots: [] },
      { ...good, roots: ["a b"] },
      { ...good, folders: [SUB] },
      { ...good, queue: [DEEP] },
      { ...good, step: "walk", queue: [] },
      { ...good, step: "changes", changeTokens: {} },
      { ...good, changeTokens: { my: "a&b" } },
      { ...good, changeTokens: { "a b": "1" } },
      { ...good, calendarTokens: { "owner@store.test": "abc" } },
      { ...good, pageToken: "a b" },
      { ...good, stream: -1 },
      { ...good, stream: 1.5 },
      { ...good, index: 51 },
      { ...good, since: "2021-01-20" },
      { ...good, since: "2021-02-30T00:00:00.000Z" },
      { ...good, folders: [GOOGLE_MOCK_ROOT, ...Array.from({ length: GOOGLE_DRIVE_MAX_FOLDERS }, (_, i) => `f${i}`)] },
    ];
    for (const cursor of bad) expect(() => parseGoogleWorkspaceCursor(JSON.stringify(cursor)), JSON.stringify(cursor).slice(0, 80)).toThrow("not in the expected shape");
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const entries = await assertWritesRefused(connector(googleWorkspaceDocMock(workspace())));
    expect(entries.map((e) => [e.action, e.outcome])).toEqual(GOOGLE_WORKSPACE_WRITES.map((w) => [w.name, "refused"]));
    expect(GOOGLE_WORKSPACE_WRITES.map((w) => w.name)).toEqual(["create_document", "create_calendar_event", "watch_drive_changes", "watch_calendar_events"]);
    expect(connector(googleWorkspaceDocMock(workspace()))).not.toHaveProperty("write");
  });
});

describe("Google Workspace push notifications", () => {
  const channels = [
    { id: "chan-drive-1", kind: "drive" as const, resourceId: "res_drive_1", expiration: Date.parse(GOOGLE_MOCK_NOW) + DAY },
    { id: "chan-cal-1", kind: "calendar" as const, resourceId: "res_cal_1" },
  ];
  const headers = (overrides: Record<string, string | undefined> = {}) => ({
    "X-Goog-Channel-ID": "chan-drive-1",
    "X-Goog-Channel-Token": CHANNEL_TOKEN,
    "X-Goog-Resource-ID": "res_drive_1",
    "X-Goog-Resource-State": "change",
    "X-Goog-Message-Number": "2",
    "X-Goog-Resource-URI": "https://www.googleapis.com/drive/v3/changes",
    ...overrides,
  });
  const verifier = () => googlePushVerifier({ channelToken: CHANNEL_TOKEN, channels, clock: () => Date.parse(GOOGLE_MOCK_NOW) });

  it("accepts a delivery with this instance's token on a channel it opened, as a prompt to sync", () => {
    const v = verifier();
    expect(v.verify(headers({ "X-Goog-Resource-State": "sync", "X-Goog-Message-Number": "1" }))).toMatchObject({ ok: true, sync: true });
    expect(v.verify(new Headers(headers()))).toEqual({ ok: true, channelId: "chan-drive-1", kind: "drive", state: "change", messageNumber: "2", sync: false });
    expect(v.verify(headers({ "X-Goog-Channel-ID": "chan-cal-1", "X-Goog-Resource-ID": "res_cal_1", "X-Goog-Resource-State": "exists" }))).toMatchObject({ ok: true, kind: "calendar" });
  });

  it("refuses a wrong, missing or malformed token, an unknown or expired channel, and a state that kind doesn't send", () => {
    const v = verifier();
    expect(v.verify(headers({ "X-Goog-Channel-Token": `${CHANNEL_TOKEN}x` }))).toEqual({ ok: false, reason: "mismatch" });
    expect(v.verify(headers({ "X-Goog-Channel-Token": CHANNEL_TOKEN.slice(0, -1) + "b" }))).toEqual({ ok: false, reason: "mismatch" });
    expect(v.verify(headers({ "X-Goog-Channel-Token": undefined }))).toEqual({ ok: false, reason: "missing" });
    expect(v.verify(headers({ "X-Goog-Resource-ID": undefined }))).toEqual({ ok: false, reason: "missing" });
    expect(v.verify(headers({ "X-Goog-Channel-Token": "has space" }))).toEqual({ ok: false, reason: "malformed" });
    // Longer than Google allows a channel token (256): malformed before any comparison.
    expect(v.verify(headers({ "X-Goog-Channel-Token": CHANNEL_TOKEN + "x".repeat(300) }))).toEqual({ ok: false, reason: "malformed" });
    expect(v.verify(headers({ "X-Goog-Message-Number": "-1" }))).toEqual({ ok: false, reason: "malformed" });
    expect(v.verify(headers({ "X-Goog-Channel-ID": "chan-other" }))).toEqual({ ok: false, reason: "unknown_channel" });
    expect(v.verify(headers({ "X-Goog-Resource-ID": "res_other" }))).toEqual({ ok: false, reason: "unknown_channel" });
    expect(v.verify(headers({ "X-Goog-Resource-State": "exists" }))).toEqual({ ok: false, reason: "unexpected_state" });
    const later = googlePushVerifier({ channelToken: CHANNEL_TOKEN, channels, clock: () => Date.parse(GOOGLE_MOCK_NOW) + 2 * DAY });
    expect(later.verify(headers())).toEqual({ ok: false, reason: "expired" });
    expect(googlePushVerifier({ channelToken: CHANNEL_TOKEN, channels: [] }).verify(headers())).toEqual({ ok: false, reason: "unknown_channel" });
    expect(() => googlePushVerifier({ channelToken: "short", channels })).toThrow("GOOGLE_PUSH_CHANNEL_TOKEN");
    expect(v.verify({ "x-goog-channel-token": [CHANNEL_TOKEN] as never })).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a replayed or older message number, also after a restart", () => {
    const v = verifier();
    expect(v.verify(headers({ "X-Goog-Message-Number": "5" })).ok).toBe(true);
    expect(v.verify(headers({ "X-Goog-Message-Number": "5" }))).toEqual({ ok: false, reason: "replayed" });
    expect(v.verify(headers({ "X-Goog-Message-Number": "3" }))).toEqual({ ok: false, reason: "replayed" });
    expect(v.verify(headers({ "X-Goog-Message-Number": "90071992547409930" })).ok).toBe(true);
    expect(v.verify(headers({ "X-Goog-Message-Number": "90071992547409929" }))).toEqual({ ok: false, reason: "replayed" });
    const restarted = googlePushVerifier({ channelToken: CHANNEL_TOKEN, channels, lastSeen: v.lastSeen(), clock: () => Date.parse(GOOGLE_MOCK_NOW) });
    expect(restarted.verify(headers({ "X-Goog-Message-Number": "6" }))).toEqual({ ok: false, reason: "replayed" });
    // Compared as numbers, not text: 9 comes before 10.
    const fresh = () => googlePushVerifier({ channelToken: CHANNEL_TOKEN, channels, clock: () => Date.parse(GOOGLE_MOCK_NOW) });
    const ten = fresh();
    expect(ten.verify(headers({ "X-Goog-Message-Number": "10" })).ok).toBe(true);
    expect(ten.verify(headers({ "X-Goog-Message-Number": "9" }))).toEqual({ ok: false, reason: "replayed" });
    const nine = fresh();
    expect(nine.verify(headers({ "X-Goog-Message-Number": "9" })).ok).toBe(true);
    expect(nine.verify(headers({ "X-Goog-Message-Number": "10" })).ok).toBe(true);
    // Each channel counts on its own.
    expect(restarted.verify(headers({ "X-Goog-Channel-ID": "chan-cal-1", "X-Goog-Resource-ID": "res_cal_1", "X-Goog-Resource-State": "exists", "X-Goog-Message-Number": "1" })).ok).toBe(true);
  });

  it("compares tokens through fixed-length digests", () => {
    expect(sameChannelToken(CHANNEL_TOKEN, CHANNEL_TOKEN)).toBe(true);
    expect(sameChannelToken(CHANNEL_TOKEN, CHANNEL_TOKEN.toUpperCase())).toBe(false);
    expect(sameChannelToken(CHANNEL_TOKEN, "")).toBe(false);
  });
});
