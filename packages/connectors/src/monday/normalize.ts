/**
 * Turns monday.com boards, items, updates and activity logs into Brain A
 * events in vendor-neutral work-tracking types, so a board of custom orders,
 * repairs or production jobs reads the same whichever tool it came from:
 * work.board_updated, work.item_updated, work.item_deleted and
 * work.comment_updated. Departments map a board's columns onto their own
 * stages and dates.
 *
 * Column values are where personal data hides, so only column types that
 * hold no free text are kept: status, date, numbers, checkbox, dropdown
 * labels, timeline and people (as user ids, never names). Text, long text,
 * email, phone, location, files, links and every other type are dropped
 * unless the owner allowed that one column on that board, and then only its
 * display text is kept. Item names are never read; they often hold a
 * customer's name. An update (a comment) keeps its id, item, creator and
 * times, never its words.
 *
 * Each item version is keyed by item id and updated_at, so every change is
 * stored once and a replay is a duplicate.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface MondayBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface MondayColumnValue {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  [field: string]: unknown;
}

export interface MondayItem {
  id?: unknown;
  state?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  creator_id?: unknown;
  group?: { id?: unknown } | null;
  column_values?: unknown;
}

export interface MondayBoard {
  id?: unknown;
  name?: unknown;
  state?: unknown;
  board_kind?: unknown;
  updated_at?: unknown;
  workspace_id?: unknown;
  columns?: unknown;
  groups?: unknown;
}

export interface MondayUpdate {
  id?: unknown;
  item_id?: unknown;
  creator_id?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

export interface MondayActivityLog {
  id?: unknown;
  event?: unknown;
  entity?: unknown;
  data?: unknown;
  created_at?: unknown;
}

/** Column types whose values hold no free text, kept by default. */
export const MONDAY_SAFE_COLUMN_TYPES = ["status", "date", "numbers", "checkbox", "dropdown", "timeline", "people"] as const;
const SAFE = new Set<string>(MONDAY_SAFE_COLUMN_TYPES);

/** Columns the owner allowed to keep although their type isn't safe, by board id. */
export type MondayAllowedColumns = ReadonlyMap<string, ReadonlySet<string>>;

/** Activity log events that take an item off a board, and what each means. */
export const MONDAY_REMOVAL_EVENTS: Record<string, "deleted" | "archived"> = { delete_pulse: "deleted", archive_pulse: "archived" };

const ID = /^\d{1,20}$/;
const COLUMN_ID = /^[A-Za-z0-9_]{1,64}$/;
const SEVENTEEN_DIGITS = /^\d{17}$/;

export const mondayRef = (name: string, id: string) => `monday:${name}:${id}`;

const str = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
/** monday.com sends ids as strings; a few raw values carry them as numbers. */
const id = (value: unknown) => {
  const s = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === "string" ? value.trim() : "";
  return ID.test(s) ? s : undefined;
};
const bool = (value: unknown) => (typeof value === "boolean" ? value : undefined);

/** A time monday.com wrote, as an ISO time in UTC. Anything unreadable is undefined, so the pipeline dead-letters the record. */
export function mondayTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value.trim())) return undefined;
  const v = value.trim();
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** An activity log's created_at, 17-digit Unix time in tenths of a microsecond, as an ISO time. */
export function mondayLogTime(value: unknown): string | undefined {
  const s = typeof value === "number" ? String(value) : value;
  if (typeof s !== "string" || !SEVENTEEN_DIGITS.test(s)) return undefined;
  // Too long for a double to hold exactly; the last four digits are below a millisecond.
  return new Date(Number(s.slice(0, -4))).toISOString();
}

/** The calendar day of a date or ISO time, as YYYY-MM-DD. */
const day = (value: unknown) => {
  const s = str(value, 40);
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return undefined;
  return Number.isNaN(Date.parse(`${s.slice(0, 10)}T00:00:00Z`)) ? undefined : s.slice(0, 10);
};

/** Optional fields are left out rather than sent as undefined. */
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const list = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]).filter((v) => v && typeof v === "object") : []);

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): MondayBrainEvent {
  return { id: `monday_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `monday:${key}`, payload };
}

/** A safe column's value, in a shape that holds no free text. */
function safeValue(type: string, c: MondayColumnValue): Record<string, unknown> {
  switch (type) {
    case "status":
      return defined({ type, label: str(c.label, 100) ?? null, index: Number.isInteger(c.index) ? c.index : null, done: bool(c.is_done) });
    case "date":
      return { type, date: day(c.date) ?? null };
    case "numbers":
      return { type, number: typeof c.number === "number" && Number.isFinite(c.number) ? c.number : null };
    case "checkbox":
      return { type, checked: c.checked === true };
    case "dropdown": {
      const values = list(c.values);
      return { type, labels: values.map((v) => str(v.label, 100)).filter((l): l is string => l !== undefined), ids: values.map((v) => id(v.id)).filter((v): v is string => v !== undefined) };
    }
    case "timeline":
      return { type, from: day(c.from) ?? null, to: day(c.to) ?? null };
    case "people": {
      const entities = list(c.persons_and_teams);
      const of = (kind: string) => entities.filter((e) => e.kind === kind).map((e) => id(e.id)).filter((v): v is string => v !== undefined).map((v) => mondayRef(kind === "team" ? "team" : "user", v));
      return { type, people: of("person"), teams: of("team") };
    }
    default:
      // Reached only for a column the owner allowed: its display text, cut short.
      return { type, text: str(c.text, 500) ?? null };
  }
}

/** The kept column values of one item, by column id. */
export function mondayColumnValues(values: unknown, boardId: string, allowed: MondayAllowedColumns = new Map()): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const c of list(values) as MondayColumnValue[]) {
    const columnId = typeof c.id === "string" && COLUMN_ID.test(c.id) ? c.id : undefined;
    const type = str(c.type, 40);
    if (!columnId || !type) continue;
    if (SAFE.has(type)) out[columnId] = safeValue(type, c);
    else if (allowed.get(boardId)?.has(columnId)) out[columnId] = { type, text: str(c.text, 500) ?? null };
  }
  return out;
}

/** A board, with its columns and groups so departments can map them. A board whose time is unreadable is dead-lettered. */
export function mondayBoardEvents(board: MondayBoard, receivedAt: string): MondayBrainEvent[] {
  const boardId = id(board?.id);
  if (!boardId) return [];
  const occurredAt = mondayTime(board.updated_at);
  const version = occurredAt ? String(Date.parse(occurredAt)) : "0";
  const workspace = id(board.workspace_id);
  return [
    event(`board:${boardId}:${version}`, "work.board_updated", occurredAt, receivedAt, {
      boardId: mondayRef("board", boardId),
      name: str(board.name) ?? `Board ${boardId}`,
      state: str(board.state, 20) ?? "active",
      kind: str(board.board_kind, 20),
      ...(workspace ? { workspaceId: mondayRef("workspace", workspace) } : {}),
      columns: list(board.columns)
        .filter((c) => typeof c.id === "string" && COLUMN_ID.test(c.id))
        .map((c) => defined({ id: c.id, type: str(c.type, 40), title: str(c.title, 100) })),
      groups: list(board.groups)
        .filter((g) => typeof g.id === "string" && COLUMN_ID.test(g.id))
        .map((g) => defined({ id: g.id, title: str(g.title, 100), archived: bool(g.archived), deleted: bool(g.deleted) })),
    }),
  ];
}

/** One item version. An item with no usable id is dropped; one with no updated_at is dead-lettered with the raw record kept. */
export function mondayItemEvents(item: MondayItem, boardId: string, receivedAt: string, allowed?: MondayAllowedColumns): MondayBrainEvent[] {
  const itemId = id(item?.id);
  if (!itemId || !ID.test(boardId)) return [];
  const occurredAt = mondayTime(item.updated_at);
  const version = occurredAt ? String(Date.parse(occurredAt)) : "0";
  const group = typeof item.group?.id === "string" && COLUMN_ID.test(item.group.id) ? item.group.id : undefined;
  const creator = id(item.creator_id);
  return [
    event(`item:${itemId}:${version}`, "work.item_updated", occurredAt, receivedAt, defined({
      itemId: mondayRef("item", itemId),
      boardId: mondayRef("board", boardId),
      groupId: group,
      state: str(item.state, 20) ?? "active",
      createdAt: mondayTime(item.created_at),
      updatedAt: occurredAt,
      creatorId: creator && mondayRef("user", creator),
      columns: mondayColumnValues(item.column_values, boardId, allowed),
    })),
  ];
}

/** An update (comment): who wrote it on which item and when, never what it says. */
export function mondayUpdateEvents(update: MondayUpdate, receivedAt: string): MondayBrainEvent[] {
  const updateId = id(update?.id);
  if (!updateId) return [];
  const occurredAt = mondayTime(update.updated_at) ?? mondayTime(update.created_at);
  const version = occurredAt ? String(Date.parse(occurredAt)) : "0";
  const item = id(update.item_id);
  const creator = id(update.creator_id);
  return [
    event(`update:${updateId}:${version}`, "work.comment_updated", occurredAt, receivedAt, defined({
      commentId: mondayRef("update", updateId),
      itemId: item && mondayRef("item", item),
      creatorId: creator && mondayRef("user", creator),
      createdAt: mondayTime(update.created_at),
      updatedAt: occurredAt,
    })),
  ];
}

/**
 * An item deleted or archived, from a board's activity log. The log's data
 * is read for the item id only; the item's name in it is never kept.
 */
export function mondayActivityEvents(log: MondayActivityLog, boardId: string, receivedAt: string): MondayBrainEvent[] {
  const reason = typeof log?.event === "string" && Object.hasOwn(MONDAY_REMOVAL_EVENTS, log.event) ? MONDAY_REMOVAL_EVENTS[log.event] : undefined;
  if (!reason || !ID.test(boardId)) return [];
  let data: Record<string, unknown> = {};
  try {
    data = typeof log.data === "string" ? (JSON.parse(log.data) as Record<string, unknown>) ?? {} : {};
  } catch {
    return [];
  }
  const itemId = id(data.pulse_id);
  if (!itemId) return [];
  const occurredAt = mondayLogTime(log.created_at);
  const logId = str(log.id, 80)?.replace(/[^A-Za-z0-9-]/g, "") || (occurredAt ? String(Date.parse(occurredAt)) : "0");
  return [
    event(`item:${itemId}:${reason}:${logId}`, "work.item_deleted", occurredAt, receivedAt, { itemId: mondayRef("item", itemId), boardId: mondayRef("board", boardId), reason }),
  ];
}
