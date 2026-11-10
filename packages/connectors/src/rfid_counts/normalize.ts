import { createHash } from "node:crypto";
import type { ColumnGetter, ColumnMap } from "../files/columns.js";
import type { CsvRow } from "../files/csv.js";
import type { SourceFile } from "../files/source.js";
import { parseDate, type DateOrder } from "../files/values.js";

/**
 * Turns an RFID or barcode count export into one `inventory.tray_counted`
 * event per tray count. Reader software writes one row per tag: the tray
 * or case, the tag's EPC or barcode, when it was read, who read it and,
 * when the system knows what belongs in the tray, whether the piece was
 * found, missing or in the wrong tray. Rows are grouped into counts by
 * their session id, or by tray when the export has none, within one file.
 * A tag read many times counts once. The key hashes what the count found,
 * so the same export read again, or saved under another name, stores
 * nothing new. A count with a row that can't be read becomes an event with
 * no time and its problems, which the pipeline dead-letters with the rows
 * kept, since a count with a bad row would say the wrong thing.
 */

export const TRAY_COUNT_EVENT_TYPE = "inventory.tray_counted";

/** A count with more tags than this is not a tray, so it is dead-lettered. */
export const MAX_TAGS_PER_COUNT = 5000;

export const TAG_STATUSES = ["found", "missing", "unexpected"] as const;
export type TagStatus = (typeof TAG_STATUSES)[number];

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface TrayCountEvent {
  id: string;
  type: typeof TRAY_COUNT_EVENT_TYPE;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** The export's columns, by the names reader software and the template in docs/integrations/rfid_counts.md use. */
export const COUNT_COLUMNS: ColumnMap = {
  sessionId: ["Session ID", "Session", "Count ID", "Scan Session", "Session No"],
  tray: ["Tray", "Tray ID", "Case", "Case ID", "Showcase", "Location", "Zone"],
  tag: ["Tag", "Tag ID", "EPC", "RFID", "Barcode", "Item Tag", "Tag Number"],
  sku: ["SKU", "Item Number", "Stock Number", "Stock No", "Style"],
  scannedAt: ["Scanned At", "Scan Time", "Read Time", "Timestamp", "Scan Date", "Date"],
  staff: ["Staff", "Counted By", "Scanned By", "Employee", "User"],
  status: ["Status", "Result", "Scan Status"],
};

/** Columns every count export needs. */
export const COUNT_REQUIRED = ["tray", "tag", "scannedAt"];

export interface CountContext {
  file: SourceFile;
  dateOrder: DateOrder;
  /** The store's offset from UTC, for times written without one. */
  utcOffset: string;
  receivedAt: string;
  /** Counts taken before this ISO time are skipped. */
  since: string;
}

export interface TagItem {
  tag: string;
  sku?: string;
}

const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";
const hash16 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const safeId = (key: string) => key.replace(/[^A-Za-z0-9_.:-]/g, "_");

// Missing before found: "not found" contains "found".
const STATUS_RULES: [RegExp, TagStatus][] = [
  [/\b(?:missing|not found|not scanned|not read|unscanned|unread|absent|lost)\b/, "missing"],
  [/\b(?:unexpected|extra|wrong (?:tray|case)|misplaced|not expected|foreign)\b/, "unexpected"],
  [/\b(?:found|present|ok|scanned|read|matched|seen|expected|yes)\b/, "found"],
];

/** "Missing", "Wrong tray", "OK" to a status; blank is found, as a plain read export has no status. Null for anything else. */
export function tagStatus(label: string | undefined): TagStatus | null {
  if (!present(label)) return "found";
  const t = label.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  return STATUS_RULES.find(([pattern]) => pattern.test(t))?.[1] ?? null;
}

/** An EPC in hex, or a printed barcode: letters, digits and a few separators. */
const TAG = /^[A-Za-z0-9][A-Za-z0-9._/#-]{0,63}$/;
const NAME = /^[^\u0000-\u001f\u007f]{1,80}$/;

interface Row {
  row: CsvRow;
  tag: string;
  sku: string | undefined;
  at: string | null;
  staff: string | undefined;
  status: TagStatus | null;
  problems: string[];
}

function readRow(row: CsvRow, get: ColumnGetter, ctx: CountContext): Row {
  const problems: string[] = [];
  const tag = get(row, "tag")?.trim() ?? "";
  if (tag === "") problems.push("no tag");
  else if (!TAG.test(tag)) problems.push(`tag ${JSON.stringify(tag)} is not an EPC or barcode`);
  const statusLabel = get(row, "status");
  const status = tagStatus(statusLabel);
  if (status === null) problems.push(`status ${JSON.stringify(statusLabel!.trim())} is not found, missing or unexpected`);
  const atText = get(row, "scannedAt");
  let at: string | null = null;
  if (present(atText)) {
    at = parseDate(atText, ctx.dateOrder, ctx.utcOffset);
    if (at === null) problems.push(`scan time ${JSON.stringify(atText.trim())} is not a date`);
  } else if (status !== "missing") {
    // A missing piece was never read, so only it may go without a time.
    problems.push("no scan time");
  }
  const staff = get(row, "staff")?.trim() || undefined;
  if (staff !== undefined && !NAME.test(staff)) problems.push("staff member is not a name or id");
  const sku = get(row, "sku")?.trim() || undefined;
  return { row, tag, sku, at, staff, status, problems };
}

/** Unexpected beats found beats missing: a tag read late was there, and one read in the wrong tray is out of place. */
const RANK: Record<TagStatus, number> = { missing: 0, found: 1, unexpected: 2 };

const item = (r: Row): TagItem => (r.sku ? { tag: r.tag, sku: r.sku } : { tag: r.tag });
const byTag = (a: TagItem, b: TagItem) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);

function unreadable(ctx: CountContext, tray: string, rows: CsvRow[], problems: string[]): TrayCountEvent {
  const lines = rows.map((r) => r.line);
  const where = `${ctx.file.name}:${lines.join(",")}`;
  // Keyed by what the rows say, not where they are, so the same export saved under another name stores nothing new.
  const key = `rfid_counts:unreadable:${hash16([tray, rows.map((r) => r.values)])}`;
  return {
    id: safeId(key),
    type: TRAY_COUNT_EVENT_TYPE,
    // A count with a problem has no time, so the pipeline dead-letters it with the rows kept.
    occurredAt: undefined,
    receivedAt: ctx.receivedAt,
    idempotencyKey: key,
    payload: { system: "RFID and barcode scans", tray, problems: problems.slice(0, 50), sourceRows: where },
  };
}

function countEvent(ctx: CountContext, tray: string, sessionId: string | undefined, rows: Row[]): TrayCountEvent | null {
  const problems = rows.flatMap((r) => r.problems.map((p) => `line ${r.row.line}: ${p}`));
  const tags = new Map<string, Row>();
  for (const r of rows) {
    const seen = tags.get(r.tag);
    if (!seen || RANK[r.status!] > RANK[seen.status!]) tags.set(r.tag, r);
  }
  if (tags.size > MAX_TAGS_PER_COUNT) problems.push(`more than ${MAX_TAGS_PER_COUNT} tags in one count`);
  if (problems.length) return unreadable(ctx, tray, rows.map((r) => r.row), problems);
  const times = rows.flatMap((r) => (r.at ? [r.at] : [])).sort();
  // A count where nothing was read has only the file's own time.
  const startedAt = times[0] ?? ctx.file.modifiedAt;
  const countedAt = times.at(-1) ?? ctx.file.modifiedAt;
  if (countedAt < ctx.since) return null;
  const all = [...tags.values()];
  const of = (status: TagStatus) => all.filter((r) => r.status === status).map(item).sort(byTag);
  const say: Record<string, unknown> = {
    system: "RFID and barcode scans",
    tray,
    startedAt,
    countedAt,
    staff: [...new Set(rows.flatMap((r) => (r.staff ? [r.staff] : [])))].sort(),
    found: of("found"),
    missing: of("missing"),
    unexpected: of("unexpected"),
  };
  if (sessionId) say.sessionId = sessionId;
  const key = `rfid_counts:count:${tray}:${countedAt}:${hash16(say)}`;
  return {
    id: safeId(key),
    type: TRAY_COUNT_EVENT_TYPE,
    occurredAt: countedAt,
    receivedAt: ctx.receivedAt,
    idempotencyKey: key,
    payload: { ...say, sourceRows: `${ctx.file.name}:${rows[0]!.row.line}-${rows.at(-1)!.row.line}` },
  };
}

/**
 * The counts in one file, in the order each first appears. A row with no
 * tray can't be placed in a count, so it is dead-lettered on its own.
 */
export function trayCountEvents(rows: CsvRow[], get: ColumnGetter, ctx: CountContext): TrayCountEvent[] {
  const groups = new Map<string, { tray: string; sessionId: string | undefined; rows: Row[] }>();
  const events: TrayCountEvent[] = [];
  for (const row of rows) {
    if (!Object.values(row.values).some(present)) continue;
    const tray = get(row, "tray")?.trim() ?? "";
    if (tray === "") {
      events.push(unreadable(ctx, "", [row], [`line ${row.line}: no tray or case`]));
      continue;
    }
    const sessionId = get(row, "sessionId")?.trim() || undefined;
    const key = JSON.stringify([sessionId ?? null, tray]);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { tray, sessionId, rows: [] }));
    group.rows.push(readRow(row, get, ctx));
  }
  for (const group of groups.values()) {
    const event = countEvent(ctx, group.tray, group.sessionId, group.rows);
    if (event) events.push(event);
  }
  return events;
}
