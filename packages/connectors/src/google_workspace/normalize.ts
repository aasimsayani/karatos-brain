import { createHash, createHmac } from "node:crypto";
import { GOOGLE_CALENDAR_ID, GOOGLE_DRIVE_ID, GOOGLE_FOLDER_MIME, googleMatches } from "./client.js";

/**
 * Turns Drive file metadata, Sheets ranges and Calendar events into Brain A
 * events: document.file_updated and document.file_removed,
 * document.sheet_range_read, and calendar.appointment_updated and
 * calendar.appointment_cancelled.
 *
 * Kept for a file: its id, name (unless names are turned off), type, parent
 * folder, shared drive, modified time and size. Never fetched: contents,
 * owners, sharing, links and descriptions.
 *
 * Kept for an appointment: its id, status, start and end, when it was made
 * and changed, its type, whether it repeats, and each attendee's response as
 * a correspondent reference: the same keyed HMAC-SHA256 of the address the
 * Gmail connector uses (CORRESPONDENT_HASH_KEY), so the same person lines up
 * across mail and appointments without either keeping the address. Never
 * kept: the title, description, location, meeting links, attachments,
 * attendee names and every raw address. A titled appointment ("Ring sizing,
 * Jane") names a customer as often as not, so titles aren't kept either.
 *
 * Sheets ranges are kept as the owner listed them, because the owner chose
 * them; cells are capped in number and length, and a cell that holds only an
 * email address becomes a correspondent reference.
 */

export interface GoogleWorkspaceBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface GoogleWorkspaceNormalizeOptions {
  /** This instance's key for correspondent references (CORRESPONDENT_HASH_KEY), shared with Gmail. At least 32 characters. */
  correspondentKey: string;
  /** "keep" (default) keeps file and folder names; "drop" keeps ids and types only. */
  fileNames?: "keep" | "drop";
}

/** A file as Drive answers with the connector's fields. */
export interface DriveFile {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  modifiedTime?: unknown;
  parents?: unknown;
  size?: unknown;
  trashed?: unknown;
  driveId?: unknown;
}

export interface CalendarEvent {
  id?: unknown;
  status?: unknown;
  start?: { date?: unknown; dateTime?: unknown; timeZone?: unknown };
  end?: { date?: unknown; dateTime?: unknown; timeZone?: unknown };
  created?: unknown;
  updated?: unknown;
  eventType?: unknown;
  transparency?: unknown;
  recurrence?: unknown;
  recurringEventId?: unknown;
  originalStartTime?: { date?: unknown; dateTime?: unknown; timeZone?: unknown };
  attendeesOmitted?: unknown;
  attendees?: unknown;
  organizer?: { email?: unknown; self?: unknown };
  [field: string]: unknown;
}

/** Attendees kept per appointment; the count stays exact. */
const MAX_ATTENDEES = 50;
/** Cells kept per range, and characters per cell. */
export const SHEET_MAX_CELLS = 20_000;
export const SHEET_MAX_CELL_CHARS = 500;
const NAME_MAX = 200;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ZONE = /^[A-Za-z0-9_+/-]{1,64}$/;
const MIME = /^[A-Za-z0-9.+-]{1,100}\/[A-Za-z0-9.+-]{1,150}$/;
const SIZE = /^\d{1,15}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const STATUSES = new Set(["confirmed", "tentative", "cancelled"]);
const RESPONSES = new Set(["needsAction", "declined", "tentative", "accepted"]);
const EVENT_TYPES = new Set(["default", "birthday", "focusTime", "fromGmail", "outOfOffice", "workingLocation"]);

const shortHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
/** An ISO time Google sent, as UTC, or undefined. Long or odd input never reaches Date. */
const time = (value: unknown) => (googleMatches(ISO, value) && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined);

export const driveRef = (id: string) => `gdrive:file:${id}`;

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): GoogleWorkspaceBrainEvent {
  return { id: `google_workspace_${shortHash(key)}`, type, occurredAt, receivedAt, idempotencyKey: `google_workspace:${key}`, payload };
}

/** What kind of Drive item a MIME type is, for departments that don't care about the exact type. */
export function driveKind(mimeType: string): "folder" | "spreadsheet" | "document" | "presentation" | "pdf" | "image" | "file" {
  if (mimeType === GOOGLE_FOLDER_MIME) return "folder";
  if (mimeType === "application/vnd.google-apps.spreadsheet" || mimeType === "text/csv" || mimeType.includes("spreadsheetml") || mimeType === "application/vnd.ms-excel") return "spreadsheet";
  if (mimeType === "application/vnd.google-apps.document" || mimeType.includes("wordprocessingml") || mimeType === "application/msword") return "document";
  if (mimeType === "application/vnd.google-apps.presentation" || mimeType.includes("presentationml")) return "presentation";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("image/")) return "image";
  return "file";
}

function when(value: { date?: unknown; dateTime?: unknown; timeZone?: unknown } | undefined) {
  if (!value || typeof value !== "object") return undefined;
  const at = time(value.dateTime);
  const day = googleMatches(DAY, value.date) ? value.date : undefined;
  if (!at && !day) return undefined;
  return defined({ dateTime: at, date: at ? undefined : day, timeZone: googleMatches(ZONE, value.timeZone) ? value.timeZone : undefined });
}

export function googleWorkspaceNormalizer(options: GoogleWorkspaceNormalizeOptions) {
  const key = options.correspondentKey?.trim() ?? "";
  if (key.length < 32) throw new Error("set CORRESPONDENT_HASH_KEY to at least 32 characters; npm run secrets:setup generates one");
  const keepNames = (options.fileNames ?? "keep") === "keep";

  /** The keyed reference for one address: the same one Gmail gives it. */
  function correspondent(address: string): string {
    const a = address.trim().toLowerCase();
    return `correspondent:${createHmac("sha256", key).update(`karatos:correspondent:v1:${a}`, "utf8").digest("hex").slice(0, 32)}`;
  }

  /** "primary" stays as it is; a calendar's address becomes a reference. */
  const calendarRef = (calendarId: string) => (calendarId === "primary" ? "primary" : correspondent(calendarId));

  function cell(value: unknown): unknown {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return null;
    const text = value.slice(0, SHEET_MAX_CELL_CHARS);
    const trimmed = text.trim();
    // A cell that is just an address is a person; keep the reference, not the address.
    if (trimmed.length <= 254 && EMAIL.test(trimmed) && trimmed.slice(trimmed.indexOf("@")).includes(".")) return correspondent(trimmed);
    return text;
  }

  return {
    correspondent,
    calendarRef,

    /**
     * The event for one file or folder, or none without a usable id or type.
     * A file with no readable modified time has no occurredAt and is
     * dead-lettered. Keyed by the id and a hash of what's kept, so a rename,
     * a move or an edit is a new version and a replay is a duplicate.
     */
    fileEvents(file: DriveFile, receivedAt: string): GoogleWorkspaceBrainEvent[] {
      if (!file || typeof file !== "object" || !googleMatches(GOOGLE_DRIVE_ID, file.id) || !googleMatches(MIME, file.mimeType)) return [];
      const parents = Array.isArray(file.parents) ? file.parents.filter((p): p is string => googleMatches(GOOGLE_DRIVE_ID, p)) : [];
      const name = keepNames && typeof file.name === "string" && file.name.trim() ? file.name.trim().slice(0, NAME_MAX) : undefined;
      const modifiedAt = time(file.modifiedTime);
      const size = googleMatches(SIZE, file.size) ? Number(file.size) : undefined;
      const payload = defined({
        fileId: driveRef(file.id),
        name,
        nameWithheld: name === undefined && keepNames === false ? true : undefined,
        mimeType: file.mimeType,
        kind: driveKind(file.mimeType),
        parentId: parents[0] && driveRef(parents[0]),
        sharedDriveId: googleMatches(GOOGLE_DRIVE_ID, file.driveId) ? file.driveId : undefined,
        modifiedAt,
        sizeBytes: size,
      });
      return [event(`file:${file.id}:${shortHash(JSON.stringify(payload))}`, "document.file_updated", modifiedAt, receivedAt, payload)];
    },

    /** A file or folder that was trashed, deleted, moved out of the shared folders, or that the connection lost access to. */
    removedEvents(fileId: unknown, reason: "trashed" | "removed" | "moved_out", at: unknown, receivedAt: string): GoogleWorkspaceBrainEvent[] {
      if (!googleMatches(GOOGLE_DRIVE_ID, fileId)) return [];
      const occurredAt = time(at);
      return [event(`file:${fileId}:${reason}:${occurredAt ?? ""}`, "document.file_removed", occurredAt ?? receivedAt, receivedAt, { fileId: driveRef(fileId), reason })];
    },

    /**
     * One event per range read. Sheets gives no time for a range, so each is
     * stamped when read and keyed by a hash of its values: an unchanged range
     * is a duplicate, a changed one a new version.
     */
    rangeEvents(spreadsheetId: string, requested: string, valueRange: unknown, receivedAt: string): GoogleWorkspaceBrainEvent[] {
      const rows = Array.isArray((valueRange as { values?: unknown } | null)?.values) ? ((valueRange as { values: unknown[] }).values) : [];
      let cells = 0;
      let truncated = false;
      const values: unknown[][] = [];
      for (const row of rows) {
        if (cells >= SHEET_MAX_CELLS) {
          truncated = true;
          break;
        }
        const list = Array.isArray(row) ? row : [];
        const room = SHEET_MAX_CELLS - cells;
        if (list.length > room) truncated = true;
        const kept = list.slice(0, room).map(cell);
        cells += kept.length;
        values.push(kept);
      }
      const payload = defined({
        spreadsheetId: driveRef(spreadsheetId),
        range: requested,
        rowCount: values.length,
        cellCount: cells,
        truncated: truncated || undefined,
        values,
      });
      return [event(`sheet:${spreadsheetId}:${requested}:${shortHash(JSON.stringify(values))}`, "document.sheet_range_read", receivedAt, receivedAt, payload)];
    },

    /**
     * The event for one appointment. Cancelled ones may carry only their id
     * (and, for a cancelled instance of a repeating appointment, the series
     * id and original start). Keyed by the id, status and update time.
     */
    appointmentEvents(calendarId: string, item: CalendarEvent, receivedAt: string): GoogleWorkspaceBrainEvent[] {
      if (!item || typeof item !== "object" || !googleMatches(EVENT_ID, item.id) || !googleMatches(GOOGLE_CALENDAR_ID, calendarId)) return [];
      const status = typeof item.status === "string" && STATUSES.has(item.status) ? item.status : "confirmed";
      const updated = time(item.updated);
      const list = Array.isArray(item.attendees) ? (item.attendees as Record<string, unknown>[]) : [];
      const address = (value: unknown) => (typeof value === "string" && value.length <= 300 && EMAIL.test(value.trim()) ? value.trim() : undefined);
      const attendees = list
        .filter((a) => a && address(a.email))
        .map((a) =>
          defined({
            correspondentId: correspondent(address(a.email)!),
            responseStatus: typeof a.responseStatus === "string" && RESPONSES.has(a.responseStatus) ? a.responseStatus : undefined,
            organizer: a.organizer === true || undefined,
            self: a.self === true || undefined,
            resource: a.resource === true || undefined,
            optional: a.optional === true || undefined,
          }),
        );
      const responses: Record<string, number> = {};
      for (const a of attendees) if (typeof a.responseStatus === "string") responses[a.responseStatus] = (responses[a.responseStatus] ?? 0) + 1;
      const organizerAddress = address(item.organizer?.email);
      const organizer = organizerAddress ? correspondent(organizerAddress) : undefined;
      const cancelled = status === "cancelled";
      const payload = defined({
        calendarId: calendarRef(calendarId),
        appointmentId: `gcal:event:${item.id}`,
        status,
        start: when(item.start),
        end: when(item.end),
        createdAt: time(item.created),
        updatedAt: updated,
        eventType: typeof item.eventType === "string" && EVENT_TYPES.has(item.eventType) ? item.eventType : undefined,
        busy: item.transparency === "transparent" ? false : cancelled ? undefined : true,
        repeats: Array.isArray(item.recurrence) && item.recurrence.length > 0 ? true : undefined,
        seriesId: googleMatches(EVENT_ID, item.recurringEventId) ? `gcal:event:${item.recurringEventId}` : undefined,
        originalStart: when(item.originalStartTime),
        organizer,
        attendees: attendees.length ? attendees.slice(0, MAX_ATTENDEES) : undefined,
        attendeeCount: attendees.length || undefined,
        attendeesOmitted: item.attendeesOmitted === true || undefined,
        responses: Object.keys(responses).length ? responses : undefined,
      });
      return [
        event(
          `event:${calendarRef(calendarId)}:${item.id}:${status}:${updated ?? ""}`,
          cancelled ? "calendar.appointment_cancelled" : "calendar.appointment_updated",
          updated ?? (cancelled ? receivedAt : undefined),
          receivedAt,
          payload,
        ),
      ];
    },
  };
}

export type GoogleWorkspaceNormalizer = ReturnType<typeof googleWorkspaceNormalizer>;
