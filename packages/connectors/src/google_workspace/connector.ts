import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import {
  GOOGLE_CALENDAR_ID,
  GOOGLE_DRIVE_ID,
  GOOGLE_FOLDER_MIME,
  GoogleWorkspaceApiError,
  GoogleWorkspaceConfigError,
  GOOGLE_SHEET_RANGE,
  SHEETS_MAX_RANGES,
  GOOGLE_SPREADSHEET_ID,
  googleWorkspaceClient,
  googleMatches,
  type GoogleSheetRanges,
  type GoogleWorkspaceClient,
  type GoogleWorkspaceClientOptions,
} from "./client.js";
import { googleWorkspaceNormalizer, type CalendarEvent, type DriveFile, type GoogleWorkspaceBrainEvent, type GoogleWorkspaceNormalizeOptions } from "./normalize.js";

/**
 * Reads the Drive folders a business shares with Brain A, the Sheets ranges
 * it lists, and the appointments on the calendars it names.
 *
 * Drive. The first pass takes a change token for My Drive and for each
 * listed shared drive, then walks the shared folder (and each shared drive)
 * folder by folder, 1,000 items a page, keeping every folder and each file
 * changed in the last five years. Drive search has no "anywhere below this
 * folder" query, so the walk keeps the set of folders it has seen. Later
 * passes read Drive's change feed from the saved token and keep changes to
 * items whose parent is one of those folders; a folder moved in from
 * elsewhere is walked for what it brings. A permanent deletion that Drive
 * reports with only an id is kept when the id is a known folder, and
 * otherwise can't be told apart from a file outside the shared folders, so
 * it's left out; trashing, the usual way files go, is always seen.
 *
 * Sheets. Each listed spreadsheet's ranges are read in one batchGet per
 * pass. A range that hasn't changed is a duplicate.
 *
 * Calendar. The first pass lists each calendar's appointments from five
 * years back; later passes read only what changed, with the sync token
 * Calendar gave at the end of the last one. When Calendar answers 410 (the
 * token expired or sharing changed), that calendar is listed again from
 * five years back and unchanged appointments come back as duplicates.
 *
 * Push. Drive and Calendar can notify a web address when something changes
 * (changes.watch, events.watch). Opening a channel is a POST that creates
 * state in the business's Google account, so it is declared below as a
 * write behind the write gate rather than sent by the read-only client;
 * verifying notifications is in webhooks.ts. The scheduled sync reads the
 * same changes without it.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the connection itself can only read. */
export const GOOGLE_WORKSPACE_WRITES: WriteAction[] = [
  { integration: "google_workspace", name: "create_document", description: "Create a Google Doc or Sheet in the shared folder" },
  { integration: "google_workspace", name: "create_calendar_event", description: "Add an appointment to a listed calendar" },
  { integration: "google_workspace", name: "watch_drive_changes", description: "Open a push channel so Drive notifies the instance of changes" },
  { integration: "google_workspace", name: "watch_calendar_events", description: "Open a push channel so Calendar notifies the instance of new or changed appointments" },
];

/** The most folders the connector tracks; a bigger tree needs a narrower shared folder. */
export const GOOGLE_DRIVE_MAX_FOLDERS = 20_000;

type Step = "tokens" | "changes" | "walk" | "sheets" | "calendar" | "done";

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface GoogleWorkspaceCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** The shared folder and shared drives this cursor was made for; a change in settings starts over. */
  roots: string[];
  /** ISO time: files and appointments older than this aren't read on a first listing. */
  since: string;
  /** Drive change tokens: "my" for My Drive and shared-with-me, otherwise a shared drive id. */
  changeTokens: Record<string, string>;
  /** Which change stream is being read during the changes step. */
  stream: number;
  /** Page token for the current files, changes or events listing, or null for its first page. */
  pageToken: string | null;
  /** Every folder known to be inside the shared folders. */
  folders: string[];
  /** Folders still to be listed. */
  queue: string[];
  /** Which spreadsheet or calendar is next in its step. */
  index: number;
  /** Calendar sync tokens by calendar reference (never the calendar's address). */
  calendarTokens: Record<string, string>;
}

export interface GoogleWorkspaceConnectorOptions extends GoogleWorkspaceClientOptions, GoogleWorkspaceNormalizeOptions {
  /** The shared folder (GOOGLE_DRIVE_ROOT_FOLDER_ID). */
  rootFolderId: string;
  /** Whole shared drives to read as well (GOOGLE_DRIVE_SHARED_DRIVE_IDS). */
  sharedDriveIds?: readonly string[];
  /** Years of history a first listing reads. */
  historyYears?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: GoogleWorkspaceClient;
}

const STEPS: readonly Step[] = ["tokens", "changes", "walk", "sheets", "calendar", "done"];
const KEYS = ["calendarTokens", "changeTokens", "folders", "index", "pageToken", "pass", "queue", "roots", "since", "step", "stream"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TOKEN = /^[A-Za-z0-9_.~=+/-]{1,2048}$/;
const CALENDAR_REF = /^(primary|correspondent:[0-9a-f]{32})$/;
const STREAM_KEY = /^(my|[A-Za-z0-9_-]{1,200})$/;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ids = (list: unknown, max: number) => Array.isArray(list) && list.length <= max && list.every((x) => googleMatches(GOOGLE_DRIVE_ID, x));
const within = (some: readonly string[], all: readonly string[]) => {
  const known = new Set(all);
  return some.every((f) => known.has(f));
};
const tokens = (map: unknown, key: RegExp, max: number) =>
  isRecord(map) && Object.keys(map).length <= max && Object.entries(map).every(([k, v]) => googleMatches(key, k) && googleMatches(TOKEN, v));

export function parseGoogleWorkspaceCursor(raw: string | null): GoogleWorkspaceCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as GoogleWorkspaceCursor;
  if (
    !isRecord(c) ||
    Object.keys(c).sort().join() !== KEYS.join() ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    !ids(c.roots, 51) ||
    c.roots.length === 0 ||
    !ids(c.folders, GOOGLE_DRIVE_MAX_FOLDERS) ||
    !ids(c.queue, GOOGLE_DRIVE_MAX_FOLDERS) ||
    !within(c.queue, c.folders) ||
    !within(c.roots, c.folders) ||
    !tokens(c.changeTokens, STREAM_KEY, 51) ||
    !tokens(c.calendarTokens, CALENDAR_REF, 50) ||
    !(c.pageToken === null || googleMatches(TOKEN, c.pageToken)) ||
    !Number.isInteger(c.stream) || c.stream < 0 || c.stream > 51 ||
    !Number.isInteger(c.index) || c.index < 0 || c.index > 50 ||
    (c.step === "changes" && Object.keys(c.changeTokens).length === 0) ||
    (c.step === "walk" && c.queue.length === 0) ||
    !googleMatches(ISO, c.since) ||
    new Date(c.since).toISOString() !== c.since
  ) {
    throw new Error("Google Workspace checkpoint is not in the expected shape");
  }
  return c;
}

/**
 * Reads GOOGLE_SHEETS_RANGES: comma-separated `spreadsheetId/range` entries,
 * such as `1AbC.../Stock!A1:F500,1AbC.../'Price list'!A:C`. Sheet names may
 * hold letters, digits, spaces, _ . and -; a name with a space is quoted.
 */
export function parseSheetRanges(setting: string | undefined): GoogleSheetRanges[] {
  const text = setting?.trim() ?? "";
  if (!text) return [];
  if (text.length > 8192) throw new GoogleWorkspaceConfigError("GOOGLE_SHEETS_RANGES is too long");
  const out: GoogleSheetRanges[] = [];
  for (const entry of text.split(",")) {
    const item = entry.trim();
    const slash = item.indexOf("/");
    const spreadsheetId = slash > 0 ? item.slice(0, slash) : "";
    const range = slash > 0 ? item.slice(slash + 1) : "";
    if (!googleMatches(GOOGLE_SPREADSHEET_ID, spreadsheetId) || !googleMatches(GOOGLE_SHEET_RANGE, range)) {
      throw new GoogleWorkspaceConfigError("each GOOGLE_SHEETS_RANGES entry is spreadsheetId/Sheet!A1:F500, with sheet names of letters, digits, spaces, _ . and -");
    }
    const existing = out.find((s) => s.spreadsheetId === spreadsheetId);
    if (existing) {
      if (!existing.ranges.includes(range)) existing.ranges.push(range);
    } else {
      out.push({ spreadsheetId, ranges: [range] });
    }
  }
  if (out.length > 50 || out.some((s) => s.ranges.length > SHEETS_MAX_RANGES)) throw new GoogleWorkspaceConfigError(`GOOGLE_SHEETS_RANGES lists at most 50 spreadsheets and ${SHEETS_MAX_RANGES} ranges each`);
  return out;
}

/** Reads GOOGLE_CALENDAR_IDS: comma-separated calendar ids, primary when unset, none for no calendars. */
export function parseCalendarIds(setting: string | undefined): string[] {
  const text = setting?.trim() ?? "";
  if (!text) return ["primary"];
  if (text === "none") return [];
  if (text.length > 4096) throw new GoogleWorkspaceConfigError("GOOGLE_CALENDAR_IDS is too long");
  const list = [...new Set(text.split(",").map((s) => s.trim()).filter(Boolean))];
  if (list.length > 50 || !list.every((c) => googleMatches(GOOGLE_CALENDAR_ID, c))) throw new GoogleWorkspaceConfigError("GOOGLE_CALENDAR_IDS must be primary, none, or up to 50 calendar addresses");
  return list;
}

/** Reads a comma-separated list of shared drive ids. */
export function parseSharedDriveIds(setting: string | undefined): string[] {
  const text = setting?.trim() ?? "";
  if (!text) return [];
  if (text.length > 4096) throw new GoogleWorkspaceConfigError("GOOGLE_DRIVE_SHARED_DRIVE_IDS is too long");
  const list = [...new Set(text.split(",").map((s) => s.trim()).filter(Boolean))];
  if (list.length > 50 || !list.every((d) => googleMatches(GOOGLE_DRIVE_ID, d))) throw new GoogleWorkspaceConfigError("GOOGLE_DRIVE_SHARED_DRIVE_IDS must be up to 50 shared drive ids");
  return list;
}

const tokenOf = (value: unknown) => (googleMatches(TOKEN, value) ? value : null);

export function googleWorkspaceConnector(options: GoogleWorkspaceConnectorOptions): Connector {
  if (!googleMatches(GOOGLE_DRIVE_ID, options.rootFolderId?.trim?.())) throw new GoogleWorkspaceConfigError("set GOOGLE_DRIVE_ROOT_FOLDER_ID to the shared folder's id");
  const sharedDrives = [...(options.sharedDriveIds ?? [])];
  if (sharedDrives.length > 50 || !sharedDrives.every((d) => googleMatches(GOOGLE_DRIVE_ID, d))) throw new GoogleWorkspaceConfigError("GOOGLE_DRIVE_SHARED_DRIVE_IDS must be up to 50 shared drive ids");
  const roots = [options.rootFolderId.trim(), ...sharedDrives.filter((d) => d !== options.rootFolderId.trim())];
  const streams = ["my", ...sharedDrives];
  const sheets = options.sheets ?? [];
  const calendars = options.calendarIds ?? [];
  const client = options.client ?? googleWorkspaceClient(options);
  const normalize = googleWorkspaceNormalizer(options);
  const calendarRefs = calendars.map((c) => normalize.calendarRef(c));
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;

  function start(pass: GoogleWorkspaceCursor["pass"], previous: GoogleWorkspaceCursor | null): GoogleWorkspaceCursor {
    const since = new Date(now());
    since.setUTCFullYear(since.getUTCFullYear() - historyYears);
    const calendarTokens = Object.fromEntries(Object.entries(previous?.calendarTokens ?? {}).filter(([ref]) => calendarRefs.includes(ref)));
    const carried = previous && streams.every((s) => previous.changeTokens[s]);
    return {
      pass,
      step: carried ? "changes" : "tokens",
      roots,
      since: since.toISOString(),
      changeTokens: carried ? previous.changeTokens : {},
      stream: 0,
      pageToken: null,
      folders: carried ? previous.folders : [...roots],
      queue: carried ? [] : [...roots],
      index: 0,
      calendarTokens,
    };
  }

  const afterDrive = (c: GoogleWorkspaceCursor): GoogleWorkspaceCursor =>
    c.queue.length ? { ...c, step: "walk", pageToken: null } : { ...c, step: sheets.length ? "sheets" : calendars.length ? "calendar" : "done", pageToken: null, index: 0 };

  /** Adds a folder found inside the shared folders, to be listed. `known` mirrors c.folders for quick lookups. */
  function addFolder(c: GoogleWorkspaceCursor, known: Set<string>, id: string): void {
    if (known.has(id)) return;
    if (c.folders.length >= GOOGLE_DRIVE_MAX_FOLDERS) throw new GoogleWorkspaceConfigError(`the shared folders hold more than ${GOOGLE_DRIVE_MAX_FOLDERS} folders; share a narrower folder`);
    known.add(id);
    c.folders.push(id);
    c.queue.push(id);
  }

  function dropFolder(c: GoogleWorkspaceCursor, known: Set<string>, id: string): void {
    if (roots.includes(id)) return;
    known.delete(id);
    c.folders = c.folders.filter((f) => f !== id);
    c.queue = c.queue.filter((f) => f !== id);
  }

  async function tokensStep(c: GoogleWorkspaceCursor): Promise<GoogleWorkspaceCursor> {
    const changeTokens: Record<string, string> = {};
    for (const stream of streams) {
      const body = await client.read({ method: "drive.changes.getStartPageToken", ...(stream === "my" ? {} : { driveId: stream }) });
      const token = tokenOf(body?.startPageToken);
      if (!token) throw new GoogleWorkspaceApiError(`Drive gave no change token${stream === "my" ? "" : " for a shared drive"}`, 200);
      changeTokens[stream] = token;
    }
    return { ...c, changeTokens, step: "walk", pageToken: null };
  }

  async function walkStep(c: GoogleWorkspaceCursor, receivedAt: string): Promise<{ events: GoogleWorkspaceBrainEvent[]; next: GoogleWorkspaceCursor }> {
    const folder = c.queue[0]!;
    const body = await client.read({ method: "drive.files.list", folderId: folder, ...(c.pageToken ? { pageToken: c.pageToken } : {}) });
    const next: GoogleWorkspaceCursor = { ...c, folders: [...c.folders], queue: [...c.queue] };
    const known = new Set(next.folders);
    const events: GoogleWorkspaceBrainEvent[] = [];
    const cutoff = Date.parse(c.since);
    for (const file of Array.isArray(body?.files) ? (body!.files as DriveFile[]) : []) {
      if (!file || !googleMatches(GOOGLE_DRIVE_ID, file.id)) continue;
      if (file.mimeType === GOOGLE_FOLDER_MIME) {
        addFolder(next, known, file.id);
      } else {
        const at = typeof file.modifiedTime === "string" && file.modifiedTime.length <= 40 ? Date.parse(file.modifiedTime) : Number.NaN;
        // Older than the window: not kept. A file with no readable time is passed on and dead-lettered.
        if (Number.isFinite(at) && at < cutoff) continue;
      }
      events.push(...normalize.fileEvents(file, receivedAt));
    }
    const pageToken = tokenOf(body?.nextPageToken);
    if (pageToken) return { events, next: { ...next, pageToken } };
    next.queue = next.queue.filter((f) => f !== folder);
    return { events, next: afterDrive({ ...next, pageToken: null }) };
  }

  async function changesStep(c: GoogleWorkspaceCursor, receivedAt: string): Promise<{ events: GoogleWorkspaceBrainEvent[]; next: GoogleWorkspaceCursor }> {
    const stream = streams[c.stream]!;
    const body = await client.read({ method: "drive.changes.list", pageToken: c.pageToken ?? c.changeTokens[stream]!, ...(stream === "my" ? {} : { driveId: stream }) });
    const next: GoogleWorkspaceCursor = { ...c, folders: [...c.folders], queue: [...c.queue], changeTokens: { ...c.changeTokens } };
    const folders = new Set(next.folders);
    const events: GoogleWorkspaceBrainEvent[] = [];
    for (const change of Array.isArray(body?.changes) ? (body!.changes as Record<string, unknown>[]) : []) {
      if (!isRecord(change) || change.changeType === "drive") continue;
      const fileId = change.fileId;
      const file = isRecord(change.file) ? (change.file as DriveFile) : undefined;
      const known = googleMatches(GOOGLE_DRIVE_ID, fileId) && folders.has(fileId);
      const parents = Array.isArray(file?.parents) ? file!.parents.filter((p): p is string => googleMatches(GOOGLE_DRIVE_ID, p)) : [];
      const inside = parents.some((p) => folders.has(p)) || (googleMatches(GOOGLE_DRIVE_ID, fileId) && roots.includes(fileId));
      if (change.removed === true || !file) {
        if (known) {
          dropFolder(next, folders, fileId as string);
          events.push(...normalize.removedEvents(fileId, "removed", change.time, receivedAt));
        }
        continue;
      }
      if (!inside) {
        // A known folder whose parent is no longer a shared folder was moved out.
        if (known) {
          dropFolder(next, folders, fileId as string);
          events.push(...normalize.removedEvents(fileId, "moved_out", change.time, receivedAt));
        }
        continue;
      }
      if (file.trashed === true) {
        if (known) dropFolder(next, folders, fileId as string);
        events.push(...normalize.removedEvents(file.id, "trashed", change.time, receivedAt));
        continue;
      }
      if (file.mimeType === GOOGLE_FOLDER_MIME && googleMatches(GOOGLE_DRIVE_ID, file.id)) addFolder(next, folders, file.id);
      events.push(...normalize.fileEvents(file, receivedAt));
    }
    const pageToken = tokenOf(body?.nextPageToken);
    if (pageToken) return { events, next: { ...next, pageToken } };
    const fresh = tokenOf(body?.newStartPageToken);
    if (!fresh) throw new GoogleWorkspaceApiError("Drive ended the change feed without a new token", 200);
    next.changeTokens[stream] = fresh;
    if (c.stream + 1 < streams.length) return { events, next: { ...next, stream: c.stream + 1, pageToken: null } };
    return { events, next: afterDrive({ ...next, stream: 0, pageToken: null }) };
  }

  async function sheetsStep(c: GoogleWorkspaceCursor, receivedAt: string): Promise<{ events: GoogleWorkspaceBrainEvent[]; next: GoogleWorkspaceCursor }> {
    const sheet = sheets[c.index]!;
    const body = await client.read({ method: "sheets.values.batchGet", spreadsheetId: sheet.spreadsheetId, ranges: sheet.ranges });
    const valueRanges = Array.isArray(body?.valueRanges) ? (body!.valueRanges as unknown[]) : [];
    // A spreadsheet that's gone or no longer shared answers 404: nothing to keep this pass.
    const events = body ? sheet.ranges.flatMap((range, i) => normalize.rangeEvents(sheet.spreadsheetId, range, valueRanges[i], receivedAt)) : [];
    if (c.index + 1 < sheets.length) return { events, next: { ...c, index: c.index + 1 } };
    return { events, next: { ...c, step: calendars.length ? "calendar" : "done", index: 0, pageToken: null } };
  }

  async function calendarStep(c: GoogleWorkspaceCursor, receivedAt: string): Promise<{ events: GoogleWorkspaceBrainEvent[]; next: GoogleWorkspaceCursor }> {
    const calendarId = calendars[c.index]!;
    const ref = calendarRefs[c.index]!;
    const syncToken = c.calendarTokens[ref];
    let body: Record<string, unknown> | null;
    try {
      body = await client.read({
        method: "calendar.events.list",
        calendarId,
        ...(syncToken ? { syncToken } : { timeMin: c.since }),
        ...(c.pageToken ? { pageToken: c.pageToken } : {}),
      });
    } catch (error) {
      if (!(error instanceof GoogleWorkspaceApiError) || error.status !== 410 || !syncToken) throw error;
      // The sync token is no good any more: list this calendar again from the start of the window.
      const { [ref]: _expired, ...rest } = c.calendarTokens;
      return { events: [], next: { ...c, calendarTokens: rest, pageToken: null } };
    }
    const events = (Array.isArray(body?.items) ? (body!.items as CalendarEvent[]) : []).flatMap((item) => normalize.appointmentEvents(calendarId, item, receivedAt));
    const pageToken = tokenOf(body?.nextPageToken);
    if (pageToken) return { events, next: { ...c, pageToken } };
    const fresh = tokenOf(body?.nextSyncToken);
    const calendarTokens = { ...c.calendarTokens };
    if (fresh) calendarTokens[ref] = fresh;
    else delete calendarTokens[ref];
    const next = { ...c, calendarTokens, pageToken: null };
    return { events, next: c.index + 1 < calendars.length ? { ...next, index: c.index + 1 } : { ...next, step: "done", index: 0 } };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    let saved = parseGoogleWorkspaceCursor(context.cursor);
    // A cursor made for another shared folder or set of shared drives starts over.
    if (saved && saved.roots.join() !== roots.join()) saved = null;
    let cursor: GoogleWorkspaceCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : start("historical", null);
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : start("incremental", saved);
    }
    // The settings may have changed since the checkpoint: never index past what is listed now.
    if (cursor.step === "sheets" && cursor.index >= sheets.length) cursor = { ...cursor, step: calendars.length ? "calendar" : "done", index: 0, pageToken: null };
    if (cursor.step === "calendar" && cursor.index >= calendars.length) cursor = { ...cursor, step: "done", index: 0, pageToken: null };

    while (cursor.step !== "done") {
      const receivedAt = now().toISOString();
      let events: GoogleWorkspaceBrainEvent[] = [];
      if (cursor.step === "tokens") {
        // Taken before the walk, so nothing that changes during it is missed; saved with the walk's first page.
        cursor = await tokensStep(cursor);
        continue;
      }
      if (cursor.step === "walk") ({ events, next: cursor } = await walkStep(cursor, receivedAt));
      else if (cursor.step === "changes") ({ events, next: cursor } = await changesStep(cursor, receivedAt));
      else if (cursor.step === "sheets") ({ events, next: cursor } = await sheetsStep(cursor, receivedAt));
      else ({ events, next: cursor } = await calendarStep(cursor, receivedAt));
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "google_workspace",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: GOOGLE_WORKSPACE_WRITES,
  };
}
