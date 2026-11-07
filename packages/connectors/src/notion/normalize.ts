import { createHash } from "node:crypto";
import { NOTION_MAX_PROPERTIES, notionId } from "./client.js";

/**
 * Turns Notion data sources and their pages into Brain A events in the same
 * vendor-neutral work-tracking types the monday.com, Asana, Trello and
 * Airtable connectors send, so a database of repairs, custom orders or
 * buying reads the same whichever tool it came from: work.board_updated for
 * a data source (its properties as columns) and work.item_updated for a
 * page in it.
 *
 * Only properties whose values hold no free text are read: numbers,
 * checkboxes, dates, selects and statuses (their option labels), relations
 * and people (as ids), unique ids, and the created and edited times. A
 * page's title, text, email, phone, URL, files, formulas, rollups and
 * places never are; those are where customers' names and notes are
 * written. A page's own address holds its title, so it isn't kept either.
 *
 * Notion keeps edit times to the minute, so each version is keyed by its id
 * and a hash of what was read: every change is stored once and a replay is
 * a duplicate.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface NotionBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** Property types whose values hold no free text, the only ones read. */
export const NOTION_SAFE_PROPERTY_TYPES = ["number", "checkbox", "date", "select", "multi_select", "status", "created_time", "last_edited_time", "relation", "people", "unique_id"] as const;
const SAFE = new Set<string>(NOTION_SAFE_PROPERTY_TYPES);

export interface NotionProperty {
  /** The property's id as Notion writes it, URL-encoded. */
  id: string;
  name: string;
  type: string;
}

/** A data source as the connector keeps it. */
export interface NotionSource {
  id: string;
  name: string;
  databaseId: string | undefined;
  inTrash: boolean;
  createdAt: string | undefined;
  updatedAt: string | undefined;
  properties: NotionProperty[];
}

export const notionRef = (kind: string, id: string) => `notion:${kind}:${id}`;

const str = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown) => (Array.isArray(value) ? value.filter(isObject) : []);

/** A time Notion wrote, as an ISO time in UTC. Anything unreadable is undefined. */
export function notionTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A calendar day Notion wrote, as YYYY-MM-DD. */
export function notionDay(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(value) ? value : undefined;
}

/** A date property's start or end: a calendar day when no time was set, otherwise a UTC time. */
const dayOrTime = (value: unknown) => notionDay(value) ?? notionTime(value) ?? null;

/** The plain text of a data source's title, which names the table, such as Repairs. */
function plain(value: unknown): string | undefined {
  return str(list(value).map((t) => (typeof t.plain_text === "string" ? t.plain_text : "")).join(""));
}

/** A data source from Notion's reply, or undefined when its id doesn't read. Properties with no usable id are left out. */
export function notionSource(raw: unknown): NotionSource | undefined {
  const id = isObject(raw) ? notionId(raw.id) : undefined;
  if (!id || !isObject(raw)) return undefined;
  const parent = isObject(raw.parent) ? raw.parent : {};
  const properties = (isObject(raw.properties) ? Object.values(raw.properties) : [])
    .filter((p): p is Record<string, unknown> => isObject(p) && typeof p.id === "string" && p.id.length > 0 && p.id.length <= 200)
    .map((p) => ({ id: p.id as string, name: str(p.name, 100) ?? (p.id as string), type: str(p.type, 40) ?? "unknown" }));
  return {
    id,
    name: plain(raw.title) ?? `Data source ${id}`,
    databaseId: parent.type === "database_id" ? notionId(parent.database_id) : undefined,
    inTrash: raw.in_trash === true,
    createdAt: notionTime(raw.created_time),
    updatedAt: notionTime(raw.last_edited_time),
    properties,
  };
}

/** The properties of a data source the connector reads: those of a type that holds no free text, up to NOTION_MAX_PROPERTIES. */
export function notionSafeProperties(source: NotionSource): NotionProperty[] {
  return source.properties.filter((p) => SAFE.has(p.type)).slice(0, NOTION_MAX_PROPERTIES);
}

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): NotionBrainEvent {
  // Keys hold only checked ids and hex hashes, so they are safe in an id as they are.
  return { id: `notion_${key}`, type, occurredAt, receivedAt, idempotencyKey: `notion:${key}`, payload };
}

/** A data source, with every property's definition as a column and whether it is read, so departments can map them. */
export function notionSourceEvents(source: NotionSource, receivedAt: string): NotionBrainEvent[] {
  const read = new Set(notionSafeProperties(source).map((p) => p.id));
  const payload = defined({
    boardId: notionRef("data_source", source.id),
    databaseId: source.databaseId && notionRef("database", source.databaseId),
    name: source.name,
    state: source.inTrash ? "deleted" : "active",
    createdAt: source.createdAt,
    columns: source.properties.map((p) => ({ id: p.id, type: p.type, title: p.name, read: read.has(p.id) })),
  });
  return [event(`data_source:${source.id}:${digest(payload)}`, "work.board_updated", source.updatedAt, receivedAt, payload)];
}

const option = (value: unknown) => (isObject(value) ? { label: str(value.name, 100) ?? null, id: str(value.id, 100) ?? null } : { label: null, id: null });

/** A read property's value in a shape that holds no free text. */
function value(type: string, raw: Record<string, unknown>): Record<string, unknown> {
  const v = raw[type];
  switch (type) {
    case "number":
      return { type, number: typeof v === "number" && Number.isFinite(v) ? v : null };
    case "checkbox":
      return { type, checked: v === true };
    case "date":
      return isObject(v) ? { type, start: dayOrTime(v.start), end: dayOrTime(v.end) } : { type, start: null, end: null };
    case "select":
    case "status":
      return { type, ...option(v) };
    case "multi_select": {
      const options = list(v).map(option);
      return { type, labels: options.map((o) => o.label).filter((l) => l !== null), ids: options.map((o) => o.id).filter((i) => i !== null) };
    }
    case "created_time":
    case "last_edited_time":
      return { type, at: notionTime(v) ?? null };
    case "relation":
      return { type, pages: list(v).map((r) => notionId(r.id)).filter((r): r is string => r !== undefined).map((r) => notionRef("page", r)), more: raw.has_more === true };
    case "people":
      return { type, people: list(v).map((p) => notionId(p.id)).filter((p): p is string => p !== undefined).map((p) => notionRef("user", p)) };
    default: {
      // unique_id: the number Notion gives each page, and the prefix the table's owner chose, such as REP.
      const u = isObject(v) ? v : {};
      return { type, number: typeof u.number === "number" && Number.isInteger(u.number) ? u.number : null, prefix: str(u.prefix, 20) ?? null };
    }
  }
}

/** The read property values of one page, by property id. A property missing from the page is left out. */
export function notionPropertyValues(source: NotionSource, properties: unknown): Record<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const p of isObject(properties) ? Object.values(properties) : []) if (isObject(p) && typeof p.id === "string") byId.set(p.id, p);
  const out: Record<string, Record<string, unknown>> = {};
  for (const p of notionSafeProperties(source)) {
    const raw = byId.get(p.id);
    // A property whose type changed since the schema was read is left out until the next read.
    if (raw && raw.type === p.type) out[p.id] = value(p.type, raw);
  }
  return out;
}

/** One page version. A page with no usable id is dropped; one whose edit time doesn't read is dead-lettered. */
export function notionPageEvents(page: Record<string, unknown>, source: NotionSource, receivedAt: string): NotionBrainEvent[] {
  const pageId = isObject(page) ? notionId(page.id) : undefined;
  if (!pageId) return [];
  const updatedAt = notionTime(page.last_edited_time);
  const payload = defined({
    itemId: notionRef("page", pageId),
    boardId: notionRef("data_source", source.id),
    state: page.in_trash === true ? "deleted" : "active",
    createdAt: notionTime(page.created_time),
    updatedAt,
    columns: notionPropertyValues(source, page.properties),
  });
  return [event(`page:${pageId}:${digest(payload)}`, "work.item_updated", updatedAt, receivedAt, payload)];
}
