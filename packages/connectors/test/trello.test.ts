import { describe, expect, it } from "vitest";
import { runSync } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, docMockFetch, testPipeline, trelloDocMock, type TrelloMockData, type TrelloMockRecord } from "@karatos/connector-testkit";
import {
  TRELLO_ACTION_FILTER,
  TRELLO_API,
  TRELLO_FIELDS,
  TRELLO_OVERLAP_MS,
  TRELLO_PAGE_SIZE,
  TRELLO_SAFE_FIELD_TYPES,
  TRELLO_WRITES,
  TrelloApiError,
  TrelloConfigError,
  TrelloWriteTokenError,
  parseTrelloCursor,
  trelloActionEvents,
  trelloBoardEvents,
  trelloCardEvents,
  trelloClient,
  trelloConnector,
  trelloCreatedAt,
  trelloFieldDefinitions,
  trelloFieldValues,
  trelloRef,
  trelloTime,
  type TrelloCursor,
  type TrelloOptions,
} from "../src/index.js";

const KEY = "a".repeat(32);
const TOKEN = "x".repeat(64);
const AUTH = `OAuth oauth_consumer_key="${KEY}", oauth_token="${TOKEN}"`;
const NOW = new Date("2026-11-04T12:00:00.000Z");
const RECEIVED = NOW.toISOString();
const noSleep = async () => {};

/** A Trello id made at `iso`, with `n` to tell ids apart: 8 hex digits of Unix seconds, then 16 more. */
const tid = (iso: string, n: number) => Math.floor(Date.parse(iso) / 1000).toString(16).padStart(8, "0") + n.toString(16).padStart(16, "f");

const B1 = tid("2024-01-01T00:00:00Z", 1);
const B2 = tid("2024-02-01T00:00:00Z", 2);
const L1 = tid("2024-01-01T00:00:00Z", 11);
const L2 = tid("2024-01-01T00:00:00Z", 12);
const F_STAGE = tid("2024-01-01T00:00:00Z", 21);
const F_QUOTE = tid("2024-01-01T00:00:00Z", 22);
const F_PHONE = tid("2024-01-01T00:00:00Z", 23);
const O_RUSH = tid("2024-01-01T00:00:00Z", 31);
const M1 = tid("2023-01-01T00:00:00Z", 41);

function card(n: number, board: string, created: string, lastActivity: string, extra: Partial<TrelloMockRecord> = {}): TrelloMockRecord {
  return {
    id: tid(created, 100 + n),
    idBoard: board,
    idList: L1,
    name: `Test Customer ${n} ring resize`,
    desc: `Call customer${n}@example.test or +1 212 555 01${String(n).padStart(2, "0")}`,
    closed: false,
    due: "2026-11-10T17:00:00.000Z",
    dueComplete: false,
    start: null,
    dateLastActivity: lastActivity,
    idMembers: [M1],
    labels: [{ id: O_RUSH, name: "Rush", color: "red" }],
    badges: { checkItems: 3, checkItemsChecked: 1, comments: 1 },
    customFieldItems: [
      { id: tid(created, 200 + n), idCustomField: F_STAGE, idValue: O_RUSH, idModel: tid(created, 100 + n), modelType: "card" },
      { id: tid(created, 300 + n), idCustomField: F_QUOTE, value: { number: "250" }, idModel: tid(created, 100 + n), modelType: "card" },
      { id: tid(created, 400 + n), idCustomField: F_PHONE, value: { text: "+1 212 555 0101" }, idModel: tid(created, 100 + n), modelType: "card" },
    ],
    ...extra,
  };
}

const CARDS = {
  recent: card(1, B1, "2026-10-01T00:00:00Z", "2026-11-01T10:00:00.000Z"),
  closed: card(2, B1, "2026-09-01T00:00:00Z", "2026-10-01T10:00:00.000Z", { closed: true }),
  old: card(3, B1, "2020-01-01T00:00:00Z", "2020-06-01T10:00:00.000Z"),
  other: card(4, B2, "2026-08-01T00:00:00Z", "2026-09-01T10:00:00.000Z", { idList: L2 }),
  unreadable: card(5, B2, "2026-07-01T00:00:00Z", "yesterday"),
};

function action(n: number, type: string, date: string, data: Record<string, unknown>): TrelloMockRecord {
  return { id: tid(date, 500 + n), type, date, idMemberCreator: M1, data, memberCreator: { fullName: "Test Member", username: "testmember" } };
}

const ACTIONS = {
  created: action(1, "createCard", "2026-10-01T00:00:00.000Z", { card: { id: CARDS.recent.id, name: "Test Customer 1 ring resize" }, list: { id: L1, name: "At the bench" }, board: { id: B1, name: "Repairs" } }),
  moved: action(2, "updateCard", "2026-11-01T10:00:00.000Z", { card: { id: CARDS.recent.id, name: "Test Customer 1 ring resize", idList: L2 }, listBefore: { id: L1, name: "At the bench" }, listAfter: { id: L2, name: "Ready for pickup" }, old: { idList: L1 } }),
  comment: action(3, "commentCard", "2026-11-01T11:00:00.000Z", { text: "Customer called about the ring", card: { id: CARDS.recent.id, name: "Test Customer 1 ring resize" }, list: { id: L2, name: "Ready for pickup" } }),
  deleted: action(4, "deleteCard", "2026-10-15T00:00:00.000Z", { card: { id: tid("2026-09-01T00:00:00Z", 199) }, list: { id: L1 } }),
};

/**
 * Against NOW (2026-11-04 noon): the history window starts 2021-11-04. Two
 * boards; the 2020 card is outside the window and the one whose last
 * activity doesn't read is dead-lettered.
 */
function account(extra: Partial<TrelloMockData> = {}): TrelloMockData {
  return {
    key: KEY,
    token: TOKEN,
    boards: [
      { id: B1, name: "Repairs", desc: "Board notes that are never read", closed: false, dateLastActivity: "2026-11-01T11:00:00.000Z", idOrganization: tid("2023-06-01T00:00:00Z", 51) },
      { id: B2, name: "Custom orders", closed: true, dateLastActivity: "2026-09-01T10:00:00.000Z", idOrganization: null },
    ],
    lists: {
      [B1]: [
        { id: L1, name: "At the bench", closed: false, pos: 1024 },
        { id: L2, name: "Ready for pickup", closed: false, pos: 2048 },
      ],
    },
    customFields: {
      [B1]: [
        { id: F_STAGE, idModel: B1, modelType: "board", name: "Stage", type: "list", options: [{ id: O_RUSH, idCustomField: F_STAGE, value: { text: "Rush" }, color: "red", pos: 1 }] },
        { id: F_QUOTE, idModel: B1, modelType: "board", name: "Quote", type: "number" },
        { id: F_PHONE, idModel: B1, modelType: "board", name: "Customer phone", type: "text" },
      ],
    },
    cards: Object.values(CARDS),
    actions: { [B1]: Object.values(ACTIONS) },
    ...extra,
  };
}

function connector(data: TrelloMockData, options: Partial<TrelloOptions> = {}) {
  const fetch = docMockFetch(trelloDocMock(data));
  const c = trelloConnector({ key: KEY, token: TOKEN, now: () => NOW, fetch, sleep: noSleep, ...options });
  return { c, fetch };
}

/** A fetch that answers each request from a list, recording what was sent. */
function scripted(responses: Response[]) {
  const sent: { url: URL; init: RequestInit | undefined }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    sent.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const READ_ONLY = { id: tid("2026-01-01T00:00:00Z", 1), permissions: [{ idModel: "*", modelType: "Board", read: true, write: false }] };
const paths = (fetch: { calls: { url: string }[] }) => fetch.calls.map((call) => new URL(call.url).pathname.replace("/1", ""));

async function batches(iterable: AsyncIterable<{ events: unknown[]; cursor: string | null }>) {
  const out: { events: { type: string; payload: Record<string, unknown> }[]; cursor: string | null }[] = [];
  for await (const b of iterable) out.push(b as (typeof out)[number]);
  return out;
}

describe("trelloTime and trelloCreatedAt", () => {
  it("reads Trello's UTC times and nothing else", () => {
    expect(trelloTime("2026-11-01T10:00:00.000Z")).toBe("2026-11-01T10:00:00.000Z");
    expect(trelloTime("2026-11-01T10:00:00Z")).toBe("2026-11-01T10:00:00.000Z");
    for (const bad of ["2026-11-01", "2026-11-01T10:00:00", "2026-11-01T10:00:00+01:00", "2026-11-01T10:00:00+00:00", "2026-02-30T10:00:00.000Z", " 2026-11-01T10:00:00Z", "yesterday", 1, null]) expect(trelloTime(bad), String(bad)).toBeUndefined();
  });

  it("reads when a record was made from its id", () => {
    expect(trelloCreatedAt(tid("2026-10-01T00:00:00Z", 1))).toBe("2026-10-01T00:00:00.000Z");
    expect(trelloCreatedAt("not-an-id")).toBeUndefined();
    expect(trelloCreatedAt("A".repeat(24))).toBeUndefined();
    expect(trelloRef("card", "1")).toBe("trello:card:1");
  });
});

describe("Trello custom fields", () => {
  const defs = trelloFieldDefinitions(account().customFields![B1]);

  it("reads a board's field definitions and dropdown options", () => {
    expect([...defs.keys()]).toEqual([F_STAGE, F_QUOTE, F_PHONE]);
    expect(defs.get(F_STAGE)!.options.get(O_RUSH)).toBe("Rush");
    const odd = trelloFieldDefinitions([{ id: "bad", type: "number" }, { id: F_QUOTE }, null, { id: F_STAGE, type: "list", options: [{ id: "x", value: { text: "Bad" } }, { id: O_RUSH, value: {} }] }]);
    expect([...odd.keys()]).toEqual([F_STAGE]);
    expect(odd.get(F_STAGE)!.options.size).toBe(0);
    expect(trelloFieldDefinitions("nope").size).toBe(0);
  });

  it("keeps number, date, checkbox and dropdown values, and nothing that holds text", () => {
    expect(TRELLO_SAFE_FIELD_TYPES).toEqual(["number", "date", "checkbox", "list"]);
    const F_DATE = tid("2024-01-01T00:00:00Z", 24);
    const F_CHECK = tid("2024-01-01T00:00:00Z", 25);
    const all = new Map([...defs, [F_DATE, { type: "date", options: new Map() }], [F_CHECK, { type: "checkbox", options: new Map() }]]);
    expect(
      trelloFieldValues(
        [
          { idCustomField: F_STAGE, idValue: O_RUSH },
          { idCustomField: F_QUOTE, value: { number: "12.5" } },
          { idCustomField: F_PHONE, value: { text: "Test Customer" } },
          { idCustomField: F_DATE, value: { date: "2026-11-10T17:00:00.000Z" } },
          { idCustomField: F_CHECK, value: { checked: "true" } },
          { idCustomField: tid("2024-01-01T00:00:00Z", 99), value: { number: "1" } },
          { idCustomField: "bad", value: { number: "1" } },
        ],
        all,
      ),
    ).toEqual({
      [F_STAGE]: { type: "dropdown", label: "Rush", id: O_RUSH },
      [F_QUOTE]: { type: "number", number: 12.5 },
      [F_DATE]: { type: "date", at: "2026-11-10T17:00:00.000Z" },
      [F_CHECK]: { type: "checkbox", checked: true },
    });
    expect(
      trelloFieldValues(
        [
          { idCustomField: F_STAGE, idValue: tid("2024-01-01T00:00:00Z", 98) },
          { idCustomField: F_QUOTE, value: { number: "1e9" } },
          { idCustomField: F_DATE, value: { date: "soon" } },
          { idCustomField: F_CHECK, value: { checked: "false" } },
        ],
        all,
      ),
    ).toEqual({
      [F_STAGE]: { type: "dropdown", label: null, id: tid("2024-01-01T00:00:00Z", 98) },
      [F_QUOTE]: { type: "number", number: null },
      [F_DATE]: { type: "date", at: null },
      [F_CHECK]: { type: "checkbox", checked: false },
    });
    expect(trelloFieldValues([{ idCustomField: F_STAGE, idValue: "bad" }, { idCustomField: F_QUOTE, value: { number: 7 } }], all)).toEqual({ [F_STAGE]: { type: "dropdown", label: null, id: null }, [F_QUOTE]: { type: "number", number: null } });
    expect(trelloFieldValues("nope", all)).toEqual({});
  });
});

describe("the Trello normalizer", () => {
  it("makes a board, with its lists as groups and its custom fields as columns", () => {
    const data = account();
    const [e] = trelloBoardEvents(data.boards[0]!, data.lists![B1]!, data.customFields![B1], RECEIVED);
    expect(e).toEqual({
      id: `trello_board:${B1}:${Date.parse("2026-11-01T11:00:00.000Z")}`,
      type: "work.board_updated",
      occurredAt: "2026-11-01T11:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `trello:board:${B1}:${Date.parse("2026-11-01T11:00:00.000Z")}`,
      payload: {
        boardId: `trello:board:${B1}`,
        name: "Repairs",
        state: "active",
        createdAt: "2024-01-01T00:00:00.000Z",
        workspaceId: `trello:workspace:${tid("2023-06-01T00:00:00Z", 51)}`,
        columns: [
          { id: F_STAGE, type: "dropdown", title: "Stage" },
          { id: F_QUOTE, type: "number", title: "Quote" },
          { id: F_PHONE, type: "text", title: "Customer phone" },
        ],
        groups: [
          { id: L1, title: "At the bench", archived: false, position: 1024 },
          { id: L2, title: "Ready for pickup", archived: false, position: 2048 },
        ],
      },
    });
    expect(JSON.stringify(e)).not.toContain("never read");
    const [closed] = trelloBoardEvents({ id: B2, closed: true, name: "x".repeat(250), dateLastActivity: "bad" }, [{ id: "bad" }, { id: L1, closed: "yes", pos: "1" }], [{ id: "bad" }], RECEIVED);
    expect(closed).toMatchObject({ occurredAt: "2024-02-01T00:00:00.000Z", payload: { state: "archived", name: "x".repeat(200), columns: [] } });
    expect(closed!.payload.groups).toEqual([{ id: L1, archived: false }]);
    expect(closed!.payload).not.toHaveProperty("workspaceId");
    expect(trelloBoardEvents({ id: B2, closed: "yes" }, [], [], RECEIVED)[0]!.payload).toMatchObject({ name: `Board ${B2}`, state: "active" });
    expect(trelloBoardEvents({ id: "../x" }, [], [], RECEIVED)).toEqual([]);
  });

  it("makes a card an item, and never keeps its name, description or text fields", () => {
    const defs = trelloFieldDefinitions(account().customFields![B1]);
    const [e] = trelloCardEvents(CARDS.recent, defs, RECEIVED);
    expect(e).toEqual({
      id: `trello_card:${CARDS.recent.id}:${Date.parse("2026-11-01T10:00:00.000Z")}`,
      type: "work.item_updated",
      occurredAt: "2026-11-01T10:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `trello:card:${CARDS.recent.id}:${Date.parse("2026-11-01T10:00:00.000Z")}`,
      payload: {
        itemId: `trello:card:${CARDS.recent.id}`,
        boardId: `trello:board:${B1}`,
        groupId: L1,
        state: "active",
        completed: false,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
        dueOn: "2026-11-10",
        dueAt: "2026-11-10T17:00:00.000Z",
        assigneeIds: [`trello:member:${M1}`],
        labels: ["Rush"],
        checklist: { items: 3, checked: 1 },
        comments: 1,
        columns: { [F_STAGE]: { type: "dropdown", label: "Rush", id: O_RUSH }, [F_QUOTE]: { type: "number", number: 250 } },
      },
    });
    expect(JSON.stringify(e)).not.toMatch(/Test Customer|example\.test|ring resize|555/);
  });

  it("marks archived and done cards, and leaves out what doesn't read", () => {
    const e = trelloCardEvents({ id: CARDS.closed.id, idBoard: B1, closed: true, dueComplete: true, start: "2026-09-01T00:00:00.000Z", dateLastActivity: "2026-10-01T10:00:00.000Z", idList: "bad", idMembers: "x", labels: [{ name: " " }, { name: "x".repeat(80) }], badges: { checkItems: -1, comments: 1.5 } }, new Map(), RECEIVED)[0]!;
    expect(e.payload).toMatchObject({ state: "archived", completed: true, startAt: "2026-09-01T00:00:00.000Z", assigneeIds: [], labels: ["x".repeat(50)], columns: {} });
    for (const key of ["groupId", "dueOn", "dueAt", "checklist", "comments"]) expect(e.payload, key).not.toHaveProperty(key);
    const odd = trelloCardEvents({ id: CARDS.closed.id, idBoard: B1, closed: "yes", dueComplete: "yes", badges: { checkItems: 2 } }, new Map(), RECEIVED)[0]!;
    expect(odd.payload).toMatchObject({ state: "active", completed: false, checklist: { items: 2, checked: 0 } });
    expect(odd).toMatchObject({ occurredAt: undefined, idempotencyKey: `trello:card:${CARDS.closed.id}:0` });
    expect(trelloCardEvents({ id: CARDS.closed.id }, new Map(), RECEIVED)).toEqual([]);
    expect(trelloCardEvents({ idBoard: B1 }, new Map(), RECEIVED)).toEqual([]);
  });

  it("records a card added to a list or moved between lists, from the action's ids only", () => {
    const [moved] = trelloActionEvents(ACTIONS.moved, B1, RECEIVED);
    expect(moved).toEqual({
      id: `trello_move:${ACTIONS.moved.id}`,
      type: "work.item_moved",
      occurredAt: "2026-11-01T10:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `trello:move:${ACTIONS.moved.id}`,
      payload: { itemId: `trello:card:${CARDS.recent.id}`, boardId: `trello:board:${B1}`, fromGroupId: L1, toGroupId: L2, movedAt: "2026-11-01T10:00:00.000Z", movedBy: `trello:member:${M1}` },
    });
    const [created] = trelloActionEvents(ACTIONS.created, B1, RECEIVED);
    expect(created!.payload).toEqual({ itemId: `trello:card:${CARDS.recent.id}`, boardId: `trello:board:${B1}`, toGroupId: L1, movedAt: "2026-10-01T00:00:00.000Z", movedBy: `trello:member:${M1}` });
    for (const type of ["copyCard", "moveCardToBoard"]) expect(trelloActionEvents({ ...ACTIONS.created, type }, B1, RECEIVED)[0]!.payload.toGroupId, type).toBe(L1);
    // An update that isn't a move, such as a rename, records nothing; a list in its data isn't read as one.
    expect(trelloActionEvents({ ...ACTIONS.moved, data: { card: { id: CARDS.recent.id }, list: { id: L1 }, old: { name: "x" } } }, B1, RECEIVED)).toEqual([]);
    expect(trelloActionEvents({ ...ACTIONS.created, data: { card: { id: CARDS.recent.id } } }, B1, RECEIVED)).toEqual([]);
    const anonymous = trelloActionEvents({ ...ACTIONS.moved, idMemberCreator: null, date: "soon" }, B1, RECEIVED)[0]!;
    expect(anonymous.occurredAt).toBeUndefined();
    expect(anonymous.payload).not.toHaveProperty("movedBy");
  });

  it("keeps who commented and when, never what they wrote", () => {
    const [e] = trelloActionEvents(ACTIONS.comment, B1, RECEIVED);
    expect(e).toEqual({
      id: `trello_comment:${ACTIONS.comment.id}`,
      type: "work.comment_updated",
      occurredAt: "2026-11-01T11:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `trello:comment:${ACTIONS.comment.id}`,
      payload: { commentId: `trello:action:${ACTIONS.comment.id}`, itemId: `trello:card:${CARDS.recent.id}`, boardId: `trello:board:${B1}`, creatorId: `trello:member:${M1}`, createdAt: "2026-11-01T11:00:00.000Z", updatedAt: "2026-11-01T11:00:00.000Z" },
    });
    expect(JSON.stringify(e)).not.toMatch(/called|Customer|ring|pickup/);
  });

  it("records a deleted card, and drops other actions or ones without ids", () => {
    expect(trelloActionEvents(ACTIONS.deleted, B1, RECEIVED)[0]).toMatchObject({ type: "work.item_deleted", idempotencyKey: `trello:delete:${ACTIONS.deleted.id}`, payload: { itemId: `trello:card:${tid("2026-09-01T00:00:00Z", 199)}`, reason: "deleted" } });
    expect(trelloActionEvents({ ...ACTIONS.comment, type: "addMemberToCard" }, B1, RECEIVED)).toEqual([]);
    expect(trelloActionEvents({ ...ACTIONS.comment, id: "bad" }, B1, RECEIVED)).toEqual([]);
    expect(trelloActionEvents({ ...ACTIONS.comment, data: { card: { id: "bad" } } }, B1, RECEIVED)).toEqual([]);
    expect(trelloActionEvents({ ...ACTIONS.comment, data: "x" }, B1, RECEIVED)).toEqual([]);
    expect(trelloActionEvents(ACTIONS.comment, "bad", RECEIVED)).toEqual([]);
    expect(trelloActionEvents(null as unknown as Record<string, unknown>, B1, RECEIVED)).toEqual([]);
  });
});

describe("the Trello client", () => {
  it("checks the key and token before sending anything", () => {
    for (const key of ["", "a".repeat(31), "A".repeat(32), "g".repeat(32)]) expect(() => trelloClient({ key, token: TOKEN }), key).toThrow(/TRELLO_API_KEY/);
    for (const token of ["", "x".repeat(63), "x".repeat(129), `${"x".repeat(63)}-`]) expect(() => trelloClient({ key: KEY, token }), token).toThrow(TrelloConfigError);
    expect(() => trelloClient({ key: KEY, token: "x".repeat(128) })).not.toThrow();
  });

  it("names every field it reads, and none is a name, description or text", () => {
    const all = Object.values(TRELLO_FIELDS).flat();
    expect(all.filter((f) => /^(desc|text|name)$/.test(f))).toEqual(["name", "name", "name"]);
    expect(TRELLO_FIELDS.cards).not.toContain("name");
    expect(TRELLO_FIELDS.cards).not.toContain("desc");
    expect(TRELLO_ACTION_FILTER.split(",")).toEqual(["createCard", "copyCard", "moveCardToBoard", "updateCard:idList", "deleteCard", "commentCard"]);
  });

  it("sends only GETs to Trello's own address, with the key and token in the header", async () => {
    const { fetch, sent } = scripted([json(200, READ_ONLY), json(200, []), json(200, []), json(200, []), json(200, []), json(200, [])]);
    const client = trelloClient({ key: KEY, token: TOKEN, fetch });
    expect(await client.canWrite()).toBe(false);
    await client.boards();
    await client.lists(B1);
    await client.customFields(B1);
    await client.cards(B1);
    await client.actions(B1, "2026-11-01T00:00:00.000Z");
    expect(sent.map((s) => s.url.origin + s.url.pathname)).toEqual([`${TRELLO_API}/tokens/${TOKEN}`, `${TRELLO_API}/members/me/boards`, `${TRELLO_API}/boards/${B1}/lists`, `${TRELLO_API}/boards/${B1}/customFields`, `${TRELLO_API}/boards/${B1}/cards`, `${TRELLO_API}/boards/${B1}/actions`]);
    for (const s of sent) {
      expect(s.init).toMatchObject({ method: "GET", headers: { Authorization: AUTH, Accept: "application/json" } });
      expect(s.url.search).not.toContain(KEY);
      expect([...s.url.searchParams.keys()]).not.toContain("token");
    }
    expect(Object.fromEntries(sent[1]!.url.searchParams)).toEqual({ filter: "all", fields: "name,closed,dateLastActivity,idOrganization", lists: "none" });
    expect(Object.fromEntries(sent[2]!.url.searchParams)).toEqual({ filter: "all", fields: "name,closed,pos" });
    expect(Object.fromEntries(sent[4]!.url.searchParams)).toEqual({ filter: "all", fields: TRELLO_FIELDS.cards.join(","), customFieldItems: "true", limit: String(TRELLO_PAGE_SIZE) });
    expect(Object.fromEntries(sent[5]!.url.searchParams)).toEqual({ filter: TRELLO_ACTION_FILTER, fields: "type,date,idMemberCreator,data", memberCreator: "false", member: "false", since: "2026-11-01T00:00:00.000Z", limit: "1000" });
  });

  it("pages cards and actions back by id", async () => {
    const { fetch, sent } = scripted([json(200, []), json(200, [])]);
    const client = trelloClient({ key: KEY, token: TOKEN, fetch });
    await client.cards(B1, CARDS.recent.id);
    await client.actions(B1, "2026-11-01T00:00:00.000Z", ACTIONS.comment.id);
    expect(sent.map((s) => s.url.searchParams.get("before"))).toEqual([CARDS.recent.id, ACTIONS.comment.id]);
  });

  it("turns down ids and times that aren't Trello's before sending them", async () => {
    const { fetch, sent } = scripted([]);
    const client = trelloClient({ key: KEY, token: TOKEN, fetch });
    await expect(client.lists("../members/me")).rejects.toThrow(/board id/);
    await expect(client.customFields(`${B1.slice(1)}g`)).rejects.toThrow(/board id/);
    await expect(client.cards(`${B1}?x=1`)).rejects.toThrow(/board id/);
    await expect(client.cards(B1, "bad")).rejects.toThrow(/card id/);
    await expect(client.actions(B1, "2026-11-01")).rejects.toThrow(/since/);
    await expect(client.actions(B1, "2026-11-01T00:00:00.000Z", "bad")).rejects.toThrow(/action id/);
    expect(sent).toEqual([]);
  });

  it("reads a token that can write anything as one that can write", async () => {
    const cases: [unknown, boolean][] = [
      [READ_ONLY, false],
      [{ permissions: [] }, false],
      [{ permissions: [{ read: true, write: false }, { read: true, write: true }] }, true],
      [{ permissions: [{ read: true }] }, true],
      [{ permissions: [null] }, true],
    ];
    for (const [body, writes] of cases) {
      const { fetch } = scripted([json(200, body)]);
      expect(await trelloClient({ key: KEY, token: TOKEN, fetch }).canWrite(), JSON.stringify(body)).toBe(writes);
    }
    for (const body of [{}, { permissions: "all" }, null, []]) {
      const { fetch } = scripted([json(200, body)]);
      await expect(trelloClient({ key: KEY, token: TOKEN, fetch }).canWrite(), JSON.stringify(body)).rejects.toThrow(/without a list of them/);
    }
  });

  it("turns down a reply that isn't a list", async () => {
    for (const [response, error] of [
      [json(200, { cards: [] }), /without a list/],
      [new Response("not json", { status: 200 }), /isn't JSON/],
    ] as const) {
      const { fetch } = scripted([response]);
      await expect(trelloClient({ key: KEY, token: TOKEN, fetch }).boards()).rejects.toThrow(error);
    }
    const { fetch } = scripted([json(200, [{ id: B1 }, "junk", null, [1]])]);
    expect(await trelloClient({ key: KEY, token: TOKEN, fetch }).boards()).toEqual([{ id: B1 }, {}, {}, {}]);
  });

  it("says what to fix for each refusal, without the key or token", async () => {
    for (const [status, message] of [
      [401, /turned down the key and token: check TRELLO_API_KEY and TRELLO_TOKEN/],
      [403, /isn't allowed to read boards/],
      [404, /couldn't find boards/],
      [500, /HTTP 500 for boards/],
    ] as const) {
      const { fetch } = scripted([new Response("no", { status })]);
      const error = await trelloClient({ key: KEY, token: TOKEN, fetch }).boards().catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(TrelloApiError);
      expect((error as TrelloApiError).status).toBe(status);
      expect((error as Error).message).not.toContain(TOKEN);
      expect((error as Error).message).not.toContain(KEY);
      expect((error as Error).message).toMatch(message);
    }
  });

  it("waits for the next 10-second window on a 429, three times, then gives up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const limited = () => json(429, { error: "API_TOKEN_LIMIT_EXCEEDED", message: "Rate limit exceeded" });
    const ok = scripted([limited(), limited(), json(200, [])]);
    await trelloClient({ key: KEY, token: TOKEN, fetch: ok.fetch, sleep }).boards();
    expect(waits).toEqual([10_000, 10_000]);
    waits.length = 0;
    const failing = scripted([limited(), limited(), limited(), limited()]);
    await expect(trelloClient({ key: KEY, token: TOKEN, fetch: failing.fetch, sleep }).boards()).rejects.toMatchObject({ status: 429 });
    expect(waits).toEqual([10_000, 10_000, 10_000]);
    const none = scripted([limited()]);
    await expect(trelloClient({ key: KEY, token: TOKEN, fetch: none.fetch, sleep, rateLimitRetries: 0 }).boards()).rejects.toMatchObject({ status: 429 });
  });
});

describe("parseTrelloCursor", () => {
  const good: TrelloCursor = { pass: "incremental", boards: [B1, B2], step: "cards", before: CARDS.recent.id, since: "2026-11-03T12:00:00.000Z", nextFrom: "2026-11-04T11:55:00.000Z" };

  it("reads back a checkpoint it wrote and nothing else", () => {
    expect(parseTrelloCursor(null)).toBeNull();
    expect(parseTrelloCursor(JSON.stringify(good))).toEqual(good);
    expect(parseTrelloCursor(JSON.stringify({ ...good, extra: 1 }))).toEqual(good);
    const done = { ...good, boards: [], step: "board", before: null };
    expect(parseTrelloCursor(JSON.stringify(done))).toEqual(done);
    for (const step of ["board", "actions"]) expect(parseTrelloCursor(JSON.stringify({ ...good, step, before: step === "board" ? null : good.before }))!.step).toBe(step);
    const bad: unknown[] = [
      "not json",
      "null",
      { ...good, pass: "full" },
      { ...good, boards: "x" },
      { ...good, boards: ["bad"] },
      { ...good, boards: Array.from({ length: 1001 }, () => B1) },
      { ...good, step: "lists" },
      { ...good, before: "bad" },
      { ...good, before: 5 },
      { ...good, step: "board" },
      { ...done, step: "cards" },
      { ...done, before: CARDS.recent.id, step: "cards" },
      { ...good, since: "2026-11-03" },
      { ...good, since: "2026-02-30T12:00:00.000Z" },
      { ...good, nextFrom: null },
    ];
    for (const raw of bad) expect(() => parseTrelloCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("Trello checkpoint is not in the expected shape");
  });
});

describe("the Trello connector", () => {
  it("imports, replays, resumes and retries the mocked account", async () => {
    // Two boards, three cards in the window, four actions, and one card dead-lettered.
    const result = await checkConnectorSync({ makeConnector: () => connector(account()).c, expected: { ingested: 9, deadLettered: 1 } });
    expect(result.full).toMatchObject({ ingested: 9, deadLettered: 1 });
    expect(result.resume).not.toBeNull();
  });

  it("checks the token first, then reads every board, its cards and its card actions", async () => {
    const { c, fetch } = connector(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 9, deadLettered: 1 });
    expect(paths(fetch)).toEqual([
      `/tokens/${TOKEN}`,
      "/members/me/boards",
      `/boards/${B1}/lists`,
      `/boards/${B1}/customFields`,
      `/boards/${B1}/cards`,
      `/boards/${B1}/actions`,
      `/boards/${B2}/lists`,
      `/boards/${B2}/customFields`,
      `/boards/${B2}/cards`,
      `/boards/${B2}/actions`,
    ]);
    expect(new URL(fetch.calls[5]!.url).searchParams.get("since")).toBe("2021-11-04T12:00:00.000Z");
    const types = memory.events.map((e) => `${e.type} ${String(e.payload.itemId ?? e.payload.boardId)}`).sort();
    expect(types).toEqual(
      [
        `work.board_updated trello:board:${B1}`,
        `work.board_updated trello:board:${B2}`,
        `work.comment_updated trello:card:${CARDS.recent.id}`,
        `work.item_deleted trello:card:${tid("2026-09-01T00:00:00Z", 199)}`,
        `work.item_moved trello:card:${CARDS.recent.id}`,
        `work.item_moved trello:card:${CARDS.recent.id}`,
        `work.item_updated trello:card:${CARDS.closed.id}`,
        `work.item_updated trello:card:${CARDS.other.id}`,
        `work.item_updated trello:card:${CARDS.recent.id}`,
      ].sort(),
    );
    expect(memory.events.find((e) => e.payload.itemId === `trello:card:${CARDS.closed.id}`)!.payload.state).toBe("archived");
    expect(memory.deadLetters).toHaveLength(1);
    assertSynthetic(memory.events);
    // Card names and descriptions are never asked for; action data carries a comment and names, which never reach an event.
    expect(JSON.stringify(memory.events)).not.toMatch(/Test Customer|example\.test|ring resize|555|called|never read|Test Member/);
  });

  it("stops before reading anything when the token can write", async () => {
    const { c, fetch } = connector(account({ writeToken: true }));
    const error = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TrelloWriteTokenError);
    expect((error as Error).message).toBe("TRELLO_TOKEN can write to Trello. Authorize a new token with scope=read only, and revoke this one");
    expect(paths(fetch)).toEqual([`/tokens/${TOKEN}`]);
    const again = connector(account({ writeToken: true }));
    await expect(batches(again.c.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).rejects.toBeInstanceOf(TrelloWriteTokenError);
  });

  it("honors a shorter history window", async () => {
    const { c, fetch } = connector(account(), { historyYears: 1 });
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(new URL(fetch.calls.find((call) => call.url.includes("/actions"))!.url).searchParams.get("since")).toBe("2025-11-04T12:00:00.000Z");
    expect(memory.events.some((e) => e.payload.itemId === `trello:card:${CARDS.old.id}`)).toBe(false);
    expect(() => trelloConnector({ key: KEY, token: TOKEN, historyYears: 0 })).toThrow(/historyYears/);
    expect(() => trelloConnector({ key: KEY, token: TOKEN, incrementalLookbackHours: 1.5 })).toThrow(/incrementalLookbackHours/);
  });

  it("keeps a card active exactly at the start of the window", async () => {
    const edge = card(6, B1, "2021-01-01T00:00:00Z", "2021-11-04T12:00:00.000Z");
    const early = card(7, B1, "2021-01-01T00:00:00Z", "2021-11-04T11:59:59.999Z");
    const { c } = connector(account({ cards: [edge, early], actions: {} }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(out.flatMap((b) => b.events).filter((e) => e.type === "work.item_updated").map((e) => e.payload.itemId)).toEqual([`trello:card:${edge.id}`]);
  });

  it("pages cards and actions back by the oldest id on each full page", async () => {
    const many = Array.from({ length: 5 }, (_, i) => card(10 + i, B1, `2026-0${i + 1}-01T00:00:00Z`, "2026-11-01T10:00:00.000Z"));
    const acts = Array.from({ length: 3 }, (_, i) => action(10 + i, "commentCard", `2026-10-0${i + 1}T00:00:00.000Z`, { card: { id: many[0]!.id } }));
    const { c, fetch } = connector(account({ cards: many, actions: { [B1]: acts }, pageCap: 2 }), {});
    // A page shorter than 1,000 is the last, even when the server sent fewer than it had.
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(fetch.calls.filter((call) => call.url.includes(`${B1}/cards`))).toHaveLength(1);
    expect(out.flatMap((b) => b.events).filter((e) => e.type === "work.item_updated")).toHaveLength(2);

    const full = Array.from({ length: TRELLO_PAGE_SIZE + 1 }, (_, i) => card(1000 + i, B1, new Date(Date.parse("2025-01-01T00:00:00Z") + i * 60_000).toISOString(), "2026-11-01T10:00:00.000Z"));
    const fullActs = Array.from({ length: TRELLO_PAGE_SIZE + 1 }, (_, i) => action(2000 + i, "commentCard", new Date(Date.parse("2026-01-01T00:00:00Z") + i * 60_000).toISOString(), { card: { id: full[0]!.id } }));
    const big = connector(account({ cards: full, actions: { [B1]: fullActs } }));
    const bigOut = await batches(big.c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const cardCalls = big.fetch.calls.filter((call) => call.url.includes(`${B1}/cards`)).map((call) => new URL(call.url).searchParams.get("before"));
    expect(cardCalls).toEqual([null, full[1]!.id]);
    const actionCalls = big.fetch.calls.filter((call) => call.url.includes(`${B1}/actions`)).map((call) => new URL(call.url).searchParams.get("before"));
    expect(actionCalls).toEqual([null, fullActs[1]!.id]);
    const events = bigOut.flatMap((b) => b.events);
    expect(events.filter((e) => e.type === "work.item_updated")).toHaveLength(TRELLO_PAGE_SIZE + 1);
    expect(events.filter((e) => e.type === "work.comment_updated")).toHaveLength(TRELLO_PAGE_SIZE + 1);
  });

  it("stops paging when a full page doesn't move back", async () => {
    const same = Array.from({ length: TRELLO_PAGE_SIZE }, () => ({ ...CARDS.recent }));
    const responses = [json(200, READ_ONLY), json(200, [{ id: B1 }]), json(200, []), json(200, []), json(200, same), json(200, same), json(200, [])];
    const { fetch, sent } = scripted(responses);
    const c = trelloConnector({ key: KEY, token: TOKEN, now: () => NOW, fetch, sleep: noSleep });
    await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(sent.map((s) => s.url.searchParams.get("before"))).toEqual([null, null, null, null, null, CARDS.recent.id, null]);
    expect(sent.at(-1)!.url.pathname).toBe(`/1/boards/${B1}/actions`);
  });

  it("checkpoints each step with the board and page it got to", async () => {
    const { c } = connector(account());
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const cursors = out.map((b) => parseTrelloCursor(b.cursor)!);
    expect(cursors.map((k) => [k.boards.length, k.step, k.before])).toEqual([
      [2, "cards", null],
      [2, "actions", null],
      [1, "board", null],
      [1, "cards", null],
      [1, "actions", null],
      [0, "board", null],
    ]);
    expect(out.map((b) => b.events.length)).toEqual([1, 2, 4, 1, 2, 0]);
    expect(cursors.every((k) => k.pass === "historical" && k.since === "2021-11-04T12:00:00.000Z" && k.nextFrom === "2026-11-04T11:55:00.000Z")).toBe(true);
  });

  it("resumes an interrupted import where its checkpoint says, and a finished one reads nothing", async () => {
    const saved: TrelloCursor = { pass: "historical", boards: [B2], step: "cards", before: null, since: "2021-11-04T12:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" };
    const { c, fetch } = connector(account());
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(paths(fetch)).toEqual([`/tokens/${TOKEN}`, "/members/me/boards", `/boards/${B2}/cards`, `/boards/${B2}/customFields`, `/boards/${B2}/actions`]);
    expect(out.flatMap((b) => b.events).map((e) => e.payload.itemId)).toEqual([`trello:card:${CARDS.other.id}`, `trello:card:${CARDS.unreadable.id}`]);
    expect(parseTrelloCursor(out.at(-1)!.cursor)).toMatchObject({ boards: [], since: "2021-11-04T12:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" });

    const again = connector(account());
    expect(await batches(again.c.historicalImport({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }))).toEqual([]);
    expect(paths(again.fetch)).toEqual([`/tokens/${TOKEN}`]);
  });

  it("starts a new import when the checkpoint is an incremental one", async () => {
    const saved: TrelloCursor = { pass: "incremental", boards: [], step: "board", before: null, since: "2026-11-03T12:00:00.000Z", nextFrom: "2026-11-04T00:00:00.000Z" };
    const { c, fetch } = connector(account());
    await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(new URL(fetch.calls.find((call) => call.url.includes("/actions"))!.url).searchParams.get("since")).toBe("2021-11-04T12:00:00.000Z");
  });

  it("skips a board that was deleted or that the member lost access to", async () => {
    const saved: TrelloCursor = { pass: "historical", boards: [tid("2025-01-01T00:00:00Z", 9), B2], step: "board", before: null, since: "2021-11-04T12:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" };
    const { c, fetch } = connector(account());
    await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(paths(fetch).filter((p) => p.includes(tid("2025-01-01T00:00:00Z", 9)))).toEqual([]);
    for (const step of ["cards", "actions"] as const) {
      const gone: TrelloCursor = { ...saved, step };
      const run = connector(account());
      const out = await batches(run.c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(gone) }));
      expect(paths(run.fetch).filter((p) => p.includes(tid("2025-01-01T00:00:00Z", 9))), step).toHaveLength(1);
      expect(parseTrelloCursor(out[0]!.cursor)!.boards, step).toEqual([B2]);
    }
  });

  it("reads a board whose lists or custom fields can't be found as having none", async () => {
    const data = account();
    const { fetch: mockFetch } = connector(data);
    const gone = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith("/lists") || url.pathname.endsWith("/customFields")) return new Response("not found", { status: 404 });
      return mockFetch(url, init);
    }) as typeof globalThis.fetch;
    const c = trelloConnector({ key: KEY, token: TOKEN, now: () => NOW, fetch: gone, sleep: noSleep });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const board = out.flatMap((b) => b.events).find((e) => e.type === "work.board_updated")!;
    expect(board.payload).toMatchObject({ groups: [], columns: [] });
    expect(out.flatMap((b) => b.events).find((e) => e.payload.itemId === `trello:card:${CARDS.recent.id}` && e.type === "work.item_updated")!.payload.columns).toEqual({});
  });

  it("asks only for what changed since the last pass began, less five minutes", async () => {
    expect(TRELLO_OVERLAP_MS).toBe(300_000);
    const { memory, pipeline } = testPipeline();
    const first = connector(account(), { now: () => new Date("2026-11-01T12:00:00.000Z") });
    await runSync({ connector: first.c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(new URL(first.fetch.calls.find((call) => call.url.includes("/actions"))!.url).searchParams.get("since")).toBe("2026-10-31T12:00:00.000Z");

    const next = connector(account(), { now: () => new Date("2026-11-02T12:00:00.000Z") });
    const report = await runSync({ connector: next.c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(new URL(next.fetch.calls.find((call) => call.url.includes("/actions"))!.url).searchParams.get("since")).toBe("2026-11-01T11:55:00.000Z");
    // Nothing new since: the boards and the cards still active since then come back as duplicates.
    expect(report).toMatchObject({ ingested: 0 });
    expect(JSON.parse((await memory.getCheckpoint(TEST_ORG, "trello", "incremental"))!)).toMatchObject({ pass: "incremental", boards: [], since: "2026-11-01T11:55:00.000Z", nextFrom: "2026-11-02T11:55:00.000Z" });
  });

  it("looks back 24 hours, or as long as it is told, when there is no checkpoint", async () => {
    const short = connector(account(), { incrementalLookbackHours: 2 });
    await batches(short.c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(new URL(short.fetch.calls.find((call) => call.url.includes("/actions"))!.url).searchParams.get("since")).toBe("2026-11-04T10:00:00.000Z");
  });

  it("resumes an interrupted incremental pass, and starts the next after a finished one", async () => {
    const saved: TrelloCursor = { pass: "incremental", boards: [B1], step: "actions", before: null, since: "2026-10-31T00:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" };
    const { c, fetch } = connector(account());
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(paths(fetch).slice(2)).toEqual([`/boards/${B1}/actions`]);
    expect(out.flatMap((b) => b.events).map((e) => e.type)).toEqual(["work.comment_updated", "work.item_moved"]);
    const done: TrelloCursor = { ...saved, boards: [], step: "board" };
    const next = connector(account());
    await batches(next.c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(done) }));
    expect(new URL(next.fetch.calls.find((call) => call.url.includes("/actions"))!.url).searchParams.get("since")).toBe("2026-11-01T00:00:00.000Z");
  });

  it("reads at most 1,000 boards in a pass", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ id: tid("2025-01-01T00:00:00Z", 1000 + i), name: `Board ${i}`, closed: false, dateLastActivity: "2026-11-01T00:00:00.000Z" }));
    const { c } = connector(account({ boards: many, cards: [] }));
    const first = await c.historicalImport({ organizationId: TEST_ORG, cursor: null })[Symbol.asyncIterator]().next();
    expect(parseTrelloCursor((first.value as { cursor: string }).cursor)!.boards).toHaveLength(1000);
  });

  it("finishes cleanly when the member can see no boards", async () => {
    const { c } = connector(account({ boards: [], cards: [] }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(out).toHaveLength(1);
    expect(parseTrelloCursor(out[0]!.cursor)).toMatchObject({ boards: [], pass: "historical" });
  });

  it("skips boards with no usable id", async () => {
    const responses = [json(200, READ_ONLY), json(200, [{ id: "bad" }, {}, { id: B1, name: "Repairs" }]), json(200, []), json(200, []), json(200, []), json(200, [])];
    const { fetch, sent } = scripted(responses);
    const c = trelloConnector({ key: KEY, token: TOKEN, now: () => NOW, fetch, sleep: noSleep });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(sent.map((s) => s.url.pathname)).toEqual([`/1/tokens/${TOKEN}`, "/1/members/me/boards", `/1/boards/${B1}/lists`, `/1/boards/${B1}/customFields`, `/1/boards/${B1}/cards`, `/1/boards/${B1}/actions`]);
    expect(parseTrelloCursor(out[0]!.cursor)!.boards).toEqual([B1]);
  });

  it("stops on any other error, leaving runSync to retry from the checkpoint", async () => {
    const { c } = connector(account({ token: "y".repeat(64) }));
    await expect(runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG, attempts: 1 })).rejects.toThrow(/turned down the key and token/);
    const blocked = scripted([json(200, READ_ONLY), json(200, [{ id: B1 }]), json(200, []), json(200, []), new Response("no", { status: 403 })]);
    const b = trelloConnector({ key: KEY, token: TOKEN, now: () => NOW, fetch: blocked.fetch, sleep: noSleep });
    await expect(batches(b.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toMatchObject({ status: 403 });
  });

  it("waits out Trello's rate limit and carries on", async () => {
    const waits: number[] = [];
    const { c } = connector(account({ rateLimited: 2 }), { sleep: async (ms) => void waits.push(ms) });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(waits).toEqual([10_000, 10_000]);
    expect(report.ingested).toBe(9);
  });

  it("declares creating and moving a card, and turns both down while writes are off", async () => {
    const { c } = connector(account());
    expect(c.writes).toBe(TRELLO_WRITES);
    expect(TRELLO_WRITES.map((w) => w.name)).toEqual(["create_card", "move_card"]);
    expect(TRELLO_WRITES.every((w) => w.integration === "trello")).toBe(true);
    const audit = await assertWritesRefused(c);
    expect(audit.map((entry) => entry.action)).toEqual(["create_card", "move_card"]);
    expect(audit.every((entry) => entry.outcome === "refused")).toBe(true);
    expect("handleWebhook" in c).toBe(false);
    expect(c.source).toBe("trello");
  });
});
