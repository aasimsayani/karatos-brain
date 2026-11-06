import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { TRELLO_ID, TRELLO_PAGE_SIZE, TrelloApiError, trelloClient, type TrelloClient, type TrelloClientOptions, type TrelloRecord } from "./client.js";
import { trelloActionEvents, trelloBoardEvents, trelloCardEvents, trelloFieldDefinitions, trelloTime, type TrelloBrainEvent, type TrelloFieldDefinitions } from "./normalize.js";

/**
 * Trello: the boards a store tracks repairs, custom orders and buying on.
 * Each pass first checks the token can't write, then reads every board the
 * token's member can see, closed ones too: its lists and custom fields,
 * its cards, and its card actions (cards added to a list or moved between
 * lists, deleted, or commented on) since the pass's start time.
 *
 * Trello can't list cards by when they changed, so each pass reads every
 * card on a board, 1,000 a page, and keeps those active since the pass's
 * start time; a card read again unchanged is a duplicate. The historical
 * import starts five years back; later syncs start where the last pass
 * began, less five minutes. The moves are what show how long a card has
 * sat in one list.
 */

/** Declared so they can be gated and audited; none runs while writes are off. */
export const TRELLO_WRITES: WriteAction[] = [
  { integration: "trello", name: "create_card", description: "Create a card on a list, such as a new repair or custom order" },
  { integration: "trello", name: "move_card", description: "Move a card to another list, such as from at the bench to ready for pickup" },
];

/** Each incremental pass starts this long before the previous one did, so a change saved mid-pass is never missed. */
export const TRELLO_OVERLAP_MS = 5 * 60_000;
const MAX_BOARDS = 1000;

type Step = "board" | "cards" | "actions";
const STEPS: Step[] = ["board", "cards", "actions"];

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface TrelloCursor {
  pass: "historical" | "incremental";
  /** Boards still to read, the current one first. Empty once the pass is done. */
  boards: string[];
  step: Step;
  /** The id to page back from in the current step, or null to start it. */
  before: string | null;
  /** ISO times: a pass keeps cards and actions from `since`, and the next pass starts at `nextFrom`. */
  since: string;
  nextFrom: string;
}

export interface TrelloOptions extends Partial<Pick<TrelloClientOptions, "fetch" | "sleep" | "rateLimitRetries">> {
  key: string;
  token: string;
  /** Years of history the first import reads. Defaults to 5. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. Defaults to 24 hours. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: TrelloClient;
}

export class TrelloWriteTokenError extends Error {
  constructor() {
    super("TRELLO_TOKEN can write to Trello. Authorize a new token with scope=read only, and revoke this one");
    this.name = "TrelloWriteTokenError";
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isTime = (t: unknown) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t)) && new Date(t).toISOString() === t;

export function parseTrelloCursor(raw: string | null): TrelloCursor | null {
  if (raw === null) return null;
  let c: TrelloCursor | null;
  try {
    c = JSON.parse(raw) as TrelloCursor | null;
  } catch {
    c = null;
  }
  const ok =
    typeof c === "object" &&
    c !== null &&
    (c.pass === "historical" || c.pass === "incremental") &&
    Array.isArray(c.boards) &&
    c.boards.length <= MAX_BOARDS &&
    c.boards.every((b) => typeof b === "string" && TRELLO_ID.test(b)) &&
    STEPS.includes(c.step) &&
    (c.before === null || (typeof c.before === "string" && TRELLO_ID.test(c.before))) &&
    (c.before === null || c.step !== "board") &&
    (c.boards.length > 0 || (c.step === "board" && c.before === null)) &&
    isTime(c.since) &&
    isTime(c.nextFrom);
  if (!ok || !c) throw new Error("Trello checkpoint is not in the expected shape");
  const { pass, boards, step, before, since, nextFrom } = c;
  return { pass, boards, step, before, since, nextFrom };
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

/** The oldest id on a page: Trello ids begin with their creation time, so they sort by it. */
const oldest = (records: TrelloRecord[]) => records.map((r) => r.id).filter((i): i is string => typeof i === "string" && TRELLO_ID.test(i)).sort()[0];

export function trelloConnector(options: TrelloOptions): Connector {
  const client = options.client ?? trelloClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = positive(options.historyYears ?? 5, "historyYears");
  const lookbackHours = positive(options.incrementalLookbackHours ?? 24, "incrementalLookbackHours");

  /** A board deleted part way through a pass answers 404; it has nothing left to read. */
  async function unlessGone<T>(read: () => Promise<T>, gone: T): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof TrelloApiError && error.status === 404) return gone;
      throw error;
    }
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseTrelloCursor(context.cursor);
    const at = now();
    const receivedAt = at.toISOString();
    if (await client.canWrite()) throw new TrelloWriteTokenError();

    let c: TrelloCursor;
    const resume = mode === "historical" ? saved?.pass === "historical" : saved?.pass === "incremental" && saved.boards.length > 0;
    // A finished import stays finished.
    if (resume && saved && saved.boards.length === 0) return;
    const all = await client.boards();
    const boards = new Map(all.filter((b) => typeof b.id === "string" && TRELLO_ID.test(b.id)).slice(0, MAX_BOARDS).map((b) => [b.id as string, b]));
    if (resume && saved) {
      c = saved;
    } else {
      let since: string;
      if (mode === "historical") {
        const from = new Date(at);
        from.setUTCFullYear(from.getUTCFullYear() - historyYears);
        since = from.toISOString();
      } else {
        since = saved?.nextFrom ?? new Date(at.getTime() - lookbackHours * 3_600_000).toISOString();
      }
      c = { pass: mode, boards: [...boards.keys()], step: "board", before: null, since, nextFrom: new Date(at.getTime() - TRELLO_OVERLAP_MS).toISOString() };
    }
    const since = Date.parse(c.since);
    const definitions = new Map<string, TrelloFieldDefinitions>();
    const fieldsOf = async (board: string) => {
      if (!definitions.has(board)) definitions.set(board, trelloFieldDefinitions(await unlessGone(() => client.customFields(board), [])));
      return definitions.get(board)!;
    };
    const next = (): TrelloCursor => ({ ...c, boards: c.boards.slice(1), step: "board", before: null });

    let yielded = false;
    while (c.boards.length > 0) {
      const board = c.boards[0]!;
      let events: TrelloBrainEvent[] = [];
      if (c.step === "board") {
        // A board no longer listed was deleted or the member lost access to it since the pass began.
        const record = boards.get(board);
        if (!record) {
          c = next();
        } else {
          const lists = await unlessGone(() => client.lists(board), []);
          const fields = await unlessGone(() => client.customFields(board), []);
          definitions.set(board, trelloFieldDefinitions(fields));
          events = trelloBoardEvents(record, lists, fields, receivedAt);
          c = { ...c, step: "cards", before: null };
        }
      } else if (c.step === "cards") {
        const cards = await unlessGone(() => client.cards(board, c.before), null);
        if (cards === null) {
          c = next();
        } else {
          const defs = await fieldsOf(board);
          // Kept when active since the pass's start; one whose time doesn't read is kept so it's dead-lettered.
          const recent = cards.filter((card) => {
            const t = trelloTime(card.dateLastActivity);
            return t === undefined || Date.parse(t) >= since;
          });
          events = recent.flatMap((card) => trelloCardEvents(card, defs, receivedAt));
          const before = cards.length >= TRELLO_PAGE_SIZE ? oldest(cards) : undefined;
          c = before && before !== c.before ? { ...c, before } : { ...c, step: "actions", before: null };
        }
      } else {
        const actions = await unlessGone(() => client.actions(board, c.since, c.before), null);
        if (actions === null) {
          c = next();
        } else {
          events = actions.flatMap((a) => trelloActionEvents(a, board, receivedAt));
          const before = actions.length >= TRELLO_PAGE_SIZE ? oldest(actions) : undefined;
          c = before && before !== c.before ? { ...c, before } : next();
        }
      }
      yield { events, cursor: JSON.stringify(c) };
      yielded = true;
    }
    // A pass with no boards still records where the next one starts.
    if (!yielded) yield { events: [], cursor: JSON.stringify(c) };
  }

  return {
    source: "trello",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: TRELLO_WRITES,
  };
}
