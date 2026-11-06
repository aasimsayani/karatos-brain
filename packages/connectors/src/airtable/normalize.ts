import { createHash } from "node:crypto";
import { AIRTABLE_ID, AIRTABLE_MAX_FIELDS } from "./client.js";

/**
 * Turns Airtable tables and records into Brain A events in the same
 * vendor-neutral work-tracking types the monday.com, Asana and Trello
 * connectors send, so a base of memo logs, repair intake or custom orders
 * reads the same whichever tool it came from: work.board_updated for a
 * table (its fields as columns) and work.item_updated for a record.
 *
 * Only fields whose values hold no free text are read: numbers, money,
 * percents, ratings, durations, checkboxes, dates and times, single and
 * multiple selects (their option labels), links to other records, and the
 * counts and timestamps Airtable keeps. Text, email, phone, links, files,
 * collaborators, formulas, rollups, lookups and AI text never are; those
 * are where customers' names and messages are written.
 *
 * Airtable doesn't say when a record last changed unless the table has a
 * last-modified-time field, so each version is keyed by its id and a hash
 * of what was read: every change is stored once and a replay is a duplicate.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface AirtableBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** Field types whose values hold no free text, the only ones read. */
export const AIRTABLE_SAFE_FIELD_TYPES = [
  "number",
  "currency",
  "percent",
  "rating",
  "duration",
  "autoNumber",
  "count",
  "checkbox",
  "date",
  "dateTime",
  "createdTime",
  "lastModifiedTime",
  "singleSelect",
  "multipleSelects",
  "multipleRecordLinks",
] as const;
const SAFE = new Set<string>(AIRTABLE_SAFE_FIELD_TYPES);
const NUMBERS = new Set(["number", "currency", "percent", "rating", "duration", "autoNumber", "count"]);
const TIMES = new Set(["dateTime", "createdTime", "lastModifiedTime"]);

export interface AirtableField {
  id: string;
  name: string;
  type: string;
}

/** A table as the connector keeps it: its ids, its name and its fields' definitions. */
export interface AirtableTable {
  id: string;
  base: string;
  name: string;
  fields: AirtableField[];
}

export const airtableRef = (kind: string, id: string) => `airtable:${kind}:${id}`;

const str = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A time Airtable wrote, as an ISO time in UTC. Anything unreadable is undefined. */
export function airtableTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A calendar day Airtable wrote, as YYYY-MM-DD. */
export function airtableDay(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(value) ? value : undefined;
}

/** A base's table from the schema reply, or undefined when its id doesn't read. Fields with no usable id are left out. */
export function airtableTable(raw: unknown, base: string): AirtableTable | undefined {
  if (!isObject(raw) || typeof raw.id !== "string" || !AIRTABLE_ID.table.test(raw.id) || !AIRTABLE_ID.base.test(base)) return undefined;
  const fields = (Array.isArray(raw.fields) ? raw.fields : [])
    .filter((f): f is Record<string, unknown> => isObject(f) && typeof f.id === "string" && AIRTABLE_ID.field.test(f.id))
    .map((f) => ({ id: f.id as string, name: str(f.name, 100) ?? (f.id as string), type: str(f.type, 40) ?? "unknown" }));
  return { id: raw.id, base, name: str(raw.name) ?? `Table ${raw.id}`, fields };
}

/** The fields of a table the connector reads: those of a type that holds no free text, up to AIRTABLE_MAX_FIELDS. */
export function airtableSafeFields(table: AirtableTable): AirtableField[] {
  return table.fields.filter((f) => SAFE.has(f.type)).slice(0, AIRTABLE_MAX_FIELDS);
}

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): AirtableBrainEvent {
  return { id: `airtable_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `airtable:${key}`, payload };
}

/** A table, with every field's definition as a column and whether it is read, so departments can map them. */
export function airtableTableEvents(table: AirtableTable, baseName: string | undefined, receivedAt: string): AirtableBrainEvent[] {
  const read = new Set(airtableSafeFields(table).map((f) => f.id));
  const payload = defined({
    boardId: airtableRef("table", table.id),
    baseId: airtableRef("base", table.base),
    baseName: str(baseName),
    name: table.name,
    state: "active",
    columns: table.fields.map((f) => ({ id: f.id, type: f.type, title: f.name, read: read.has(f.id) })),
  });
  // Airtable gives a table no modified time, so the version is what it looks like and the time is when it was seen.
  return [event(`table:${table.id}:${digest(payload)}`, "work.board_updated", receivedAt, receivedAt, payload)];
}

/** A safe field's value in a shape that holds no free text. An empty field is null, or false for a checkbox. */
function value(field: AirtableField, raw: unknown): unknown {
  if (NUMBERS.has(field.type)) return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  if (field.type === "checkbox") return raw === true;
  if (field.type === "date") return airtableDay(raw) ?? null;
  if (TIMES.has(field.type)) return airtableTime(raw) ?? null;
  if (field.type === "singleSelect") return str(raw, 100) ?? null;
  if (field.type === "multipleSelects") return Array.isArray(raw) ? raw.map((o) => str(o, 100)).filter((o): o is string => o !== undefined) : [];
  // multipleRecordLinks: record ids, or objects carrying one.
  return (Array.isArray(raw) ? raw : [])
    .map((r) => (isObject(r) ? r.id : r))
    .filter((r): r is string => typeof r === "string" && AIRTABLE_ID.record.test(r))
    .map((r) => airtableRef("record", r));
}

/** The read field values of one record, by field id. */
export function airtableFieldValues(table: AirtableTable, fields: unknown): Record<string, Record<string, unknown>> {
  const raw = isObject(fields) ? fields : {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const f of airtableSafeFields(table)) out[f.id] = { type: f.type, value: value(f, raw[f.id]) };
  return out;
}

/** One record version. A record with no usable id is dropped; one whose time doesn't read is dead-lettered. */
export function airtableRecordEvents(record: Record<string, unknown>, table: AirtableTable, receivedAt: string): AirtableBrainEvent[] {
  const recordId = typeof record?.id === "string" && AIRTABLE_ID.record.test(record.id) ? record.id : undefined;
  if (!recordId) return [];
  const columns = airtableFieldValues(table, record.fields);
  const createdAt = airtableTime(record.createdTime);
  // The latest last-modified-time field, when the table has one, is when the record last changed.
  const modified = Object.values(columns)
    .filter((c) => c.type === "lastModifiedTime" && typeof c.value === "string")
    .map((c) => c.value as string)
    .sort()
    .at(-1);
  const updatedAt = createdAt === undefined ? undefined : (modified ?? createdAt);
  const payload = defined({
    itemId: airtableRef("record", recordId),
    boardId: airtableRef("table", table.id),
    baseId: airtableRef("base", table.base),
    state: "active",
    createdAt,
    updatedAt,
    columns,
  });
  return [event(`record:${recordId}:${digest(payload)}`, "work.item_updated", updatedAt, receivedAt, payload)];
}
