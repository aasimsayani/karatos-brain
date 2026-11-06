/**
 * A small client for Trello's REST API (1): the token's own permissions,
 * the boards its member can see, and each board's lists, custom fields,
 * cards and actions. It only ever sends these six GETs, to Trello's fixed
 * address, with the key and token in the Authorization header rather than
 * the URL, and checks every id before it goes into a path.
 *
 * Before reading anything it asks Trello what the token may do, and stops
 * if the token can write: a token authorized with scope=read is all this
 * needs.
 *
 * It names every field it wants, and never asks for a card's name or
 * description, a list's or board's description, or a comment's text. A
 * comment action still carries its text and the card's name in its data;
 * the normalizer keeps only ids and times from it.
 */

export const TRELLO_API = "https://api.trello.com/1";
/** Trello's largest page of cards or actions. */
export const TRELLO_PAGE_SIZE = 1000;
/** Trello's ids are 24 hex characters. */
export const TRELLO_ID = /^[0-9a-f]{24}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Trello's window is 10 seconds; a throttled request waits for the next one. */
const WINDOW_MS = 10_000;

/** The fields read for each kind of record. Nothing here holds free text a person typed about a customer. */
export const TRELLO_FIELDS = {
  token: ["permissions"],
  boards: ["name", "closed", "dateLastActivity", "idOrganization"],
  lists: ["name", "closed", "pos"],
  customFields: ["name", "type", "options"],
  cards: ["idBoard", "idList", "closed", "due", "dueComplete", "start", "dateLastActivity", "idMembers", "labels", "badges"],
  actions: ["type", "date", "idMemberCreator", "data"],
} as const;

/** The card moves, creations and comments read from a board's actions. */
export const TRELLO_ACTION_FILTER = "createCard,copyCard,moveCardToBoard,updateCard:idList,deleteCard,commentCard";

export interface TrelloClientOptions {
  /** The Power-Up's API key. Not a secret on its own, but kept with the token. */
  key: string;
  /** A token the client's member authorized with scope=read. Sent to Trello only, and never logged or shown. */
  token: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class TrelloConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrelloConfigError";
  }
}

export class TrelloApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TrelloApiError";
  }
}

export type TrelloRecord = Record<string, unknown>;

export interface TrelloClient {
  /** Whether the token may write to anything. */
  canWrite(): Promise<boolean>;
  /** Every board the token's member can see, closed ones too. */
  boards(): Promise<TrelloRecord[]>;
  lists(board: string): Promise<TrelloRecord[]>;
  customFields(board: string): Promise<TrelloRecord[]>;
  /** Up to 1,000 of a board's cards, closed ones too, created before `before` (a card id) when given. */
  cards(board: string, before?: string | null): Promise<TrelloRecord[]>;
  /** Up to 1,000 of a board's card actions since `since`, newest first, older than `before` (an action id) when given. */
  actions(board: string, since: string, before?: string | null): Promise<TrelloRecord[]>;
}

const id = (value: string, what: string) => {
  if (!TRELLO_ID.test(value)) throw new TrelloApiError(`${what} id is not a Trello id`, 0);
  return value;
};

export function trelloClient(options: TrelloClientOptions): TrelloClient {
  if (!/^[0-9a-f]{32}$/.test(options.key)) throw new TrelloConfigError("TRELLO_API_KEY is missing or not in the expected shape");
  if (!/^[A-Za-z0-9]{64,128}$/.test(options.token)) throw new TrelloConfigError("TRELLO_TOKEN is missing or not in the expected shape");
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.rateLimitRetries ?? 3;
  const headers = { Authorization: `OAuth oauth_consumer_key="${options.key}", oauth_token="${options.token}"`, Accept: "application/json" };

  async function get(path: string, query: Record<string, string>, what: string): Promise<unknown> {
    const url = new URL(`${TRELLO_API}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { method: "GET", headers });
      if (response.status === 429 && attempt < retries) {
        await sleep(WINDOW_MS);
        continue;
      }
      const body = await response.json().catch(() => undefined);
      if (response.status === 401) throw new TrelloApiError("Trello turned down the key and token: check TRELLO_API_KEY and TRELLO_TOKEN, which may have expired or been revoked", 401);
      if (response.status === 403) throw new TrelloApiError(`Trello's token isn't allowed to read ${what}`, 403);
      if (response.status === 404) throw new TrelloApiError(`Trello couldn't find ${what}`, 404);
      if (response.status !== 200) throw new TrelloApiError(`Trello answered HTTP ${response.status} for ${what}`, response.status);
      if (body === undefined) throw new TrelloApiError(`Trello answered ${what} with a body that isn't JSON`, 200);
      return body;
    }
  }

  async function list(path: string, query: Record<string, string>, what: string): Promise<TrelloRecord[]> {
    const body = await get(path, query, what);
    if (!Array.isArray(body)) throw new TrelloApiError(`Trello answered ${what} without a list`, 200);
    return body.map((r) => (typeof r === "object" && r !== null && !Array.isArray(r) ? (r as TrelloRecord) : {}));
  }

  return {
    async canWrite() {
      const body = (await get(`/tokens/${options.token}`, { fields: TRELLO_FIELDS.token.join(",") }, "the token's permissions")) as { permissions?: unknown } | null;
      if (!body || typeof body !== "object" || !Array.isArray(body.permissions)) throw new TrelloApiError("Trello answered the token's permissions without a list of them", 200);
      return body.permissions.some((p) => (p as { write?: unknown } | null)?.write !== false);
    },
    boards: async () => list("/members/me/boards", { filter: "all", fields: TRELLO_FIELDS.boards.join(","), lists: "none" }, "boards"),
    lists: async (board) => list(`/boards/${id(board, "board")}/lists`, { filter: "all", fields: TRELLO_FIELDS.lists.join(",") }, "a board's lists"),
    customFields: async (board) => list(`/boards/${id(board, "board")}/customFields`, {}, "a board's custom fields"),
    async cards(board, before) {
      if (before != null) id(before, "card");
      return list(
        `/boards/${id(board, "board")}/cards`,
        { filter: "all", fields: TRELLO_FIELDS.cards.join(","), customFieldItems: "true", limit: String(TRELLO_PAGE_SIZE), ...(before ? { before } : {}) },
        "a board's cards",
      );
    },
    async actions(board, since, before) {
      if (!ISO.test(since)) throw new TrelloApiError("since must be a UTC time", 0);
      if (before != null) id(before, "action");
      return list(
        `/boards/${id(board, "board")}/actions`,
        { filter: TRELLO_ACTION_FILTER, fields: TRELLO_FIELDS.actions.join(","), memberCreator: "false", member: "false", since, limit: String(TRELLO_PAGE_SIZE), ...(before ? { before } : {}) },
        "a board's actions",
      );
    },
  };
}
