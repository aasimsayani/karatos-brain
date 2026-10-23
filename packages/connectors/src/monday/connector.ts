import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import {
  MONDAY_ID,
  MONDAY_PAGE_SIZES,
  MONDAY_UPDATED_WINDOWS,
  MondayConfigError,
  MondayCursorExpiredError,
  mondayClient,
  mondayUpdatedFilter,
  type MondayClient,
  type MondayClientOptions,
  type MondayUpdatedWindow,
} from "./client.js";
import {
  mondayActivityEvents,
  mondayBoardEvents,
  mondayItemEvents,
  mondayTime,
  mondayUpdateEvents,
  type MondayActivityLog,
  type MondayAllowedColumns,
  type MondayBoard,
  type MondayBrainEvent,
  type MondayItem,
  type MondayUpdate,
} from "./normalize.js";

/**
 * Reads every board the token can see (archived and deleted ones too, as
 * board events), the items on each board with their column values, item
 * updates (comments) and, on incremental passes, each board's activity log
 * for items deleted or archived.
 *
 * The historical import reads every item on every board that isn't deleted
 * and keeps those updated in the last five years, 500 a page, then every
 * update created in that time. items_page returns active items only, so
 * items archived or deleted before the import aren't read.
 *
 * monday.com can't filter items by an exact time, only by periods such as
 * today and yesterday in the token user's time zone. Incremental syncs ask
 * for the smallest pair of periods that surely covers everything since the
 * last pass started (less five minutes of overlap), then keep only items
 * updated since then. After more than four weeks without a sync, a pass
 * reads each board whole.
 *
 * items_page cursors last 60 minutes. A pass resumed later than that, or
 * told its cursor expired, reads that board again from the start; items
 * already stored are duplicates.
 */

/** Declared so they can be gated and audited; none runs while writes are off. */
export const MONDAY_WRITES: WriteAction[] = [
  { integration: "monday", name: "create_item", description: "Create an item on a board, such as a new repair or custom order" },
  { integration: "monday", name: "update_item", description: "Change an item's column values, such as its status" },
];

/** Each incremental pass starts this long before the previous one did, so a change saved mid-pass is never missed. */
export const MONDAY_OVERLAP_MS = 5 * 60_000;
/** A saved items cursor older than this is not used; monday.com expires them 60 minutes after the first request. */
export const MONDAY_CURSOR_MAX_AGE_MS = 55 * 60_000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/**
 * How far back each pair of periods surely reaches, whatever the user's time
 * zone or first day of the week: the start of yesterday is at least a day
 * ago, the start of last week a week and the start of last month 28 days,
 * less an hour for a clock change and an hour for clocks that disagree.
 */
const WINDOW_REACH_MS = [DAY - 2 * HOUR, 7 * DAY - 2 * HOUR, 28 * DAY - 2 * HOUR];

/** The narrowest last-updated window covering everything after `since`, or null to read boards whole. */
export function mondayWindowFor(since: string, until: string): MondayUpdatedWindow | null {
  const age = Date.parse(until) - Date.parse(since);
  const at = WINDOW_REACH_MS.findIndex((reach) => age <= reach);
  return at === -1 ? null : MONDAY_UPDATED_WINDOWS[at]!;
}

type Step = "boards" | "items" | "activity" | "updates" | "done";
const STEPS: Step[] = ["boards", "items", "activity", "updates", "done"];

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface MondayCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** monday.com's 1-based page of boards being worked through. */
  boardsPage: number;
  /** Boards from that page still to read, the current one first. */
  boards: string[];
  /** Whether that page of boards was the last. */
  lastBoardsPage: boolean;
  /** The items cursor for the current board, and when it was first issued. */
  items: string | null;
  itemsAt: string | null;
  /** 1-based page of the activity log or of updates. */
  page: number;
  /** ISO times: a pass keeps items and updates changed from `since`, reads logs up to `until`, and the next pass starts at `nextFrom`. */
  since: string;
  until: string;
  nextFrom: string;
  /** The last-updated filter this pass sends, fixed when it starts; null reads boards whole. */
  window: MondayUpdatedWindow | null;
}

export interface MondayConnectorOptions extends MondayClientOptions {
  /** Columns of other types to keep, by board id, as the owner allowed them. */
  allowedColumns?: MondayAllowedColumns;
  /** Years of history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: MondayClient;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const CURSOR = /^[A-Za-z0-9+/=_-]{1,4096}$/;
const isTime = (t: unknown) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t));
const isPage = (n: unknown) => Number.isInteger(n) && (n as number) >= 1;

export function parseMondayCursor(raw: string | null): MondayCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as MondayCursor;
  if (
    !c ||
    typeof c !== "object" ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    !isPage(c.boardsPage) ||
    !isPage(c.page) ||
    !Array.isArray(c.boards) ||
    c.boards.length > MONDAY_PAGE_SIZES.boards ||
    !c.boards.every((b) => typeof b === "string" && MONDAY_ID.test(b)) ||
    ((c.step === "items" || c.step === "activity") && c.boards.length === 0) ||
    typeof c.lastBoardsPage !== "boolean" ||
    !(c.items === null || (typeof c.items === "string" && CURSOR.test(c.items))) ||
    !(c.itemsAt === null || isTime(c.itemsAt)) ||
    (c.items === null) !== (c.itemsAt === null) ||
    ![c.since, c.until, c.nextFrom].every(isTime) ||
    !(c.window === null || MONDAY_UPDATED_WINDOWS.some((w) => JSON.stringify(w) === JSON.stringify(c.window)))
  ) {
    throw new Error("monday.com checkpoint is not in the expected shape");
  }
  return c;
}

/** Columns to keep from MONDAY_ALLOWED_COLUMNS: comma-separated board:column pairs, such as 1234567890:text. */
export function parseMondayAllowedColumns(raw: string | undefined): Map<string, Set<string>> {
  const allowed = new Map<string, Set<string>>();
  for (const entry of (raw ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    const m = /^(\d{1,20}):([A-Za-z0-9_]{1,64})$/.exec(entry);
    if (!m) throw new MondayConfigError("MONDAY_ALLOWED_COLUMNS must be board:column pairs, such as 1234567890:text");
    allowed.set(m[1]!, (allowed.get(m[1]!) ?? new Set()).add(m[2]!));
  }
  return allowed;
}

/** The OAuth scopes from MONDAY_OAUTH_SCOPES, as monday.com writes them (space or comma separated); undefined for a personal token. */
export function parseMondayScopes(raw: string | undefined): string[] | undefined {
  const scopes = (raw ?? "").split(/[\s,]+/).filter(Boolean);
  return scopes.length ? scopes : undefined;
}

const recordsOf = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]).filter((v) => v && typeof v === "object") : []);
/** The first board of a boards(ids:) answer. */
const boardOf = (data: Record<string, unknown>) => recordsOf(data.boards)[0] ?? {};
/** An item or update is kept when it changed in this pass's range; one with no readable time is kept, to be dead-lettered. */
const inRange = (value: unknown, since: string) => {
  const t = mondayTime(value);
  return t === undefined || t >= since;
};
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function mondayConnector(options: MondayConnectorOptions): Connector {
  const client = options.client ?? mondayClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;
  const allowed = options.allowedColumns ?? new Map<string, Set<string>>();

  const fresh = { step: "boards" as const, boardsPage: 1, boards: [], lastBoardsPage: false, items: null, itemsAt: null, page: 1 };

  function startHistorical(): MondayCursor {
    const until = now().toISOString();
    const start = new Date(until);
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    // Boards are read whole: the window filter can't reach back years.
    return { pass: "historical", ...fresh, since: start.toISOString(), until, nextFrom: new Date(Date.parse(until) - MONDAY_OVERLAP_MS).toISOString(), window: null };
  }

  function startIncremental(previous: MondayCursor | null): MondayCursor {
    const until = now().toISOString();
    const since = previous?.nextFrom ?? new Date(Date.parse(until) - lookbackHours * HOUR).toISOString();
    return { pass: "incremental", ...fresh, since, until, nextFrom: new Date(Date.parse(until) - MONDAY_OVERLAP_MS).toISOString(), window: mondayWindowFor(since, until) };
  }

  /** The cursor after the current board: the next on the page, the next page, or updates. */
  function afterBoard(c: MondayCursor): MondayCursor {
    const boards = c.boards.slice(1);
    const base = { ...c, boards, items: null, itemsAt: null, page: 1 };
    if (boards.length) return { ...base, step: "items" };
    return c.lastBoardsPage ? { ...base, step: "updates" } : { ...base, step: "boards", boardsPage: c.boardsPage + 1 };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseMondayCursor(context.cursor);
    let cursor: MondayCursor;
    if (mode === "historical") {
      // A finished import stays finished (its step is done); an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved);
    }
    // Restarted boards, so a board whose cursor keeps expiring stops the sync instead of looping.
    const restarted = new Set<string>();

    while (cursor.step !== "done") {
      const receivedAt = now().toISOString();
      let events: MondayBrainEvent[] = [];
      switch (cursor.step) {
        case "boards": {
          const data = await client.query("Boards", { page: cursor.boardsPage, limit: MONDAY_PAGE_SIZES.boards });
          const boards = recordsOf(data.boards) as MondayBoard[];
          events = boards.flatMap((b) => mondayBoardEvents(b, receivedAt));
          // A deleted board's items are gone; its board event says so.
          const ids = boards.filter((b) => b.state !== "deleted").map((b) => b.id).filter((id): id is string => typeof id === "string" && MONDAY_ID.test(id));
          const last = boards.length < MONDAY_PAGE_SIZES.boards;
          const base = { ...cursor, boards: ids, lastBoardsPage: last, items: null, itemsAt: null, page: 1 };
          cursor = ids.length ? { ...base, step: "items" } : last ? { ...base, step: "updates" } : { ...base, boardsPage: cursor.boardsPage + 1 };
          break;
        }
        case "items": {
          const board = cursor.boards[0]!;
          // A cursor saved more than 55 minutes ago has expired or is about to; read the board again.
          let c = cursor.items !== null && now().getTime() - Date.parse(cursor.itemsAt!) > MONDAY_CURSOR_MAX_AGE_MS ? { ...cursor, items: null, itemsAt: null } : cursor;
          const text = allowed.has(board);
          let page: Record<string, unknown>;
          try {
            page = c.items === null
              ? (boardOf(await client.query(text ? "ItemsFirstText" : "ItemsFirst", { board: [board], limit: MONDAY_PAGE_SIZES.items, ...(c.window ? { filter: mondayUpdatedFilter(c.window) } : {}) })).items_page ?? {}) as Record<string, unknown>
              : ((await client.query(text ? "ItemsNextText" : "ItemsNext", { cursor: c.items, limit: MONDAY_PAGE_SIZES.items })).next_items_page ?? {}) as Record<string, unknown>;
          } catch (error) {
            if (!(error instanceof MondayCursorExpiredError) || restarted.has(board)) throw error;
            restarted.add(board);
            cursor = { ...c, items: null, itemsAt: null };
            continue;
          }
          const items = (recordsOf(page.items) as MondayItem[]).filter((i) => inRange(i.updated_at, c.since));
          events = items.flatMap((i) => mondayItemEvents(i, board, receivedAt, allowed));
          const nextCursor = typeof page.cursor === "string" && page.cursor ? page.cursor : null;
          if (nextCursor) c = { ...c, items: nextCursor, itemsAt: c.itemsAt ?? receivedAt };
          else c = c.pass === "incremental" ? { ...c, step: "activity", items: null, itemsAt: null, page: 1 } : afterBoard(c);
          cursor = c;
          break;
        }
        case "activity": {
          const board = cursor.boards[0]!;
          const data = await client.query("ActivityLogs", { board: [board], from: cursor.since, to: cursor.until, limit: MONDAY_PAGE_SIZES.activity, page: cursor.page });
          const logs = recordsOf(boardOf(data).activity_logs) as MondayActivityLog[];
          events = logs.flatMap((l) => mondayActivityEvents(l, board, receivedAt));
          cursor = logs.length >= MONDAY_PAGE_SIZES.activity ? { ...cursor, page: cursor.page + 1 } : afterBoard(cursor);
          break;
        }
        case "updates": {
          // Days, a day wider each side: monday.com doesn't say which time zone it reads these in. Repeats are duplicates.
          const data = await client.query("Updates", {
            from: dayOf(Date.parse(cursor.since) - DAY),
            to: dayOf(Date.parse(cursor.until) + DAY),
            limit: MONDAY_PAGE_SIZES.updates,
            page: cursor.page,
          });
          const updates = recordsOf(data.updates) as MondayUpdate[];
          events = updates.filter((u) => inRange(u.updated_at ?? u.created_at, cursor.since)).flatMap((u) => mondayUpdateEvents(u, receivedAt));
          cursor = updates.length >= MONDAY_PAGE_SIZES.updates ? { ...cursor, page: cursor.page + 1 } : { ...cursor, step: "done", page: 1 };
          break;
        }
      }
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "monday",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: MONDAY_WRITES,
  };
}
