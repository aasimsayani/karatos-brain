/**
 * Turns Trello boards, cards and card actions into Brain A events in the
 * same vendor-neutral work-tracking types the monday.com and Asana
 * connectors send: work.board_updated for a board (its lists as groups, its
 * custom fields as columns), work.item_updated for a card, work.item_moved
 * when a card is added to a list or moved between lists, work.item_deleted
 * and work.comment_updated.
 *
 * A card's name and description are never read; they often hold a
 * customer's name. Custom fields are kept only for types that hold no free
 * text: number, date, checkbox and dropdown (its option label). A comment
 * keeps its id, card, author and time, never its words; its action's data
 * also carries the comment and the card's name, and only ids are read from
 * it. Labels keep their names, which are short tags such as "Rush".
 *
 * Each card version is keyed by card id and last activity, and each action
 * by its id, so a replay is a duplicate.
 */

export interface TrelloBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** Custom field types whose values hold no free text, the only ones kept. */
export const TRELLO_SAFE_FIELD_TYPES = ["number", "date", "checkbox", "list"] as const;
const SAFE = new Set<string>(TRELLO_SAFE_FIELD_TYPES);

const ID = /^[0-9a-f]{24}$/;

export const trelloRef = (kind: string, id: string) => `trello:${kind}:${id}`;

type R = Record<string, unknown>;
const str = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const idOf = (value: unknown) => (typeof value === "string" && ID.test(value) ? value : undefined);
const obj = (value: unknown): R | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as R) : undefined);
const list = (value: unknown) => (Array.isArray(value) ? value.map(obj).filter((v): v is R => v !== undefined) : []);
const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined);
const defined = (fields: R) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/** A time Trello wrote, as an ISO time in UTC. Anything unreadable is undefined, so the pipeline dead-letters the record. */
export function trelloTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19) ? undefined : new Date(ms).toISOString();
}

/** When a Trello record was made: its id begins with the Unix time in seconds, as 8 hex digits. */
export function trelloCreatedAt(id: string): string | undefined {
  if (!ID.test(id)) return undefined;
  return new Date(parseInt(id.slice(0, 8), 16) * 1000).toISOString();
}

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: R): TrelloBrainEvent {
  return { id: `trello_${key}`, type, occurredAt, receivedAt, idempotencyKey: `trello:${key}`, payload };
}

const version = (occurredAt: string | undefined) => (occurredAt ? String(Date.parse(occurredAt)) : "0");

/** A board's custom field definitions, by id, for reading card values. */
export type TrelloFieldDefinitions = ReadonlyMap<string, { type: string; options: ReadonlyMap<string, string> }>;

export function trelloFieldDefinitions(fields: unknown): TrelloFieldDefinitions {
  const out = new Map<string, { type: string; options: ReadonlyMap<string, string> }>();
  for (const f of list(fields)) {
    const fieldId = idOf(f.id);
    const type = str(f.type, 20);
    if (!fieldId || !type) continue;
    const options = new Map<string, string>();
    for (const o of list(f.options)) {
      const optionId = idOf(o.id);
      const label = str(obj(o.value)?.text, 100);
      if (optionId && label) options.set(optionId, label);
    }
    out.set(fieldId, { type, options });
  }
  return out;
}

/** The kept custom field values of one card, by field id. */
export function trelloFieldValues(items: unknown, definitions: TrelloFieldDefinitions): Record<string, R> {
  const out: Record<string, R> = {};
  for (const item of list(items)) {
    const fieldId = idOf(item.idCustomField);
    const definition = fieldId ? definitions.get(fieldId) : undefined;
    if (!fieldId || !definition || !SAFE.has(definition.type)) continue;
    const value = obj(item.value);
    switch (definition.type) {
      case "number": {
        const n = typeof value?.number === "string" && /^-?\d+(\.\d+)?$/.test(value.number) ? Number(value.number) : null;
        out[fieldId] = { type: "number", number: n };
        break;
      }
      case "date":
        out[fieldId] = { type: "date", at: trelloTime(value?.date) ?? null };
        break;
      case "checkbox":
        out[fieldId] = { type: "checkbox", checked: value?.checked === "true" };
        break;
      default: {
        const option = idOf(item.idValue);
        out[fieldId] = { type: "dropdown", label: (option && definition.options.get(option)) ?? null, id: option ?? null };
      }
    }
  }
  return out;
}

/** A board, with its lists as groups and its custom fields as columns. */
export function trelloBoardEvents(board: R, lists: R[], fields: unknown, receivedAt: string): TrelloBrainEvent[] {
  const boardId = idOf(board?.id);
  if (!boardId) return [];
  const occurredAt = trelloTime(board.dateLastActivity) ?? trelloCreatedAt(boardId);
  const workspace = idOf(board.idOrganization);
  return [
    event(`board:${boardId}:${version(occurredAt)}`, "work.board_updated", occurredAt, receivedAt, defined({
      boardId: trelloRef("board", boardId),
      name: str(board.name) ?? `Board ${boardId}`,
      state: board.closed === true ? "archived" : "active",
      createdAt: trelloCreatedAt(boardId),
      workspaceId: workspace && trelloRef("workspace", workspace),
      columns: list(fields)
        .filter((f) => idOf(f.id))
        .map((f) => defined({ id: f.id, type: f.type === "list" ? "dropdown" : str(f.type, 20), title: str(f.name, 100) })),
      groups: lists
        .filter((l) => idOf(l.id))
        .map((l) => defined({ id: l.id, title: str(l.name, 100), archived: l.closed === true, position: typeof l.pos === "number" && Number.isFinite(l.pos) ? l.pos : undefined })),
    })),
  ];
}

/** One card version. A card with no usable id is dropped; one whose last activity doesn't read is dead-lettered. */
export function trelloCardEvents(card: R, definitions: TrelloFieldDefinitions, receivedAt: string): TrelloBrainEvent[] {
  const cardId = idOf(card?.id);
  const boardId = idOf(card?.idBoard);
  if (!cardId || !boardId) return [];
  const occurredAt = trelloTime(card.dateLastActivity);
  const due = trelloTime(card.due);
  const badges = obj(card.badges);
  return [
    event(`card:${cardId}:${version(occurredAt)}`, "work.item_updated", occurredAt, receivedAt, defined({
      itemId: trelloRef("card", cardId),
      boardId: trelloRef("board", boardId),
      groupId: idOf(card.idList),
      state: card.closed === true ? "archived" : "active",
      completed: card.dueComplete === true,
      createdAt: trelloCreatedAt(cardId),
      updatedAt: occurredAt,
      startAt: trelloTime(card.start),
      dueOn: due?.slice(0, 10),
      dueAt: due,
      assigneeIds: Array.isArray(card.idMembers) ? card.idMembers.map(idOf).filter((m): m is string => m !== undefined).map((m) => trelloRef("member", m)) : [],
      labels: list(card.labels).map((l) => str(l.name, 50)).filter((l): l is string => l !== undefined),
      checklist: badges && count(badges.checkItems) !== undefined ? { items: count(badges.checkItems), checked: count(badges.checkItemsChecked) ?? 0 } : undefined,
      comments: badges ? count(badges.comments) : undefined,
      columns: trelloFieldValues(card.customFieldItems, definitions),
    })),
  ];
}

/**
 * A card action: a card added to a list or moved between lists, deleted,
 * or commented on. Only ids and the time are read from its data.
 */
export function trelloActionEvents(action: R, boardId: string, receivedAt: string): TrelloBrainEvent[] {
  const actionId = idOf(action?.id);
  const data = obj(action?.data);
  const cardId = idOf(obj(data?.card)?.id);
  if (!actionId || !cardId || !ID.test(boardId)) return [];
  const occurredAt = trelloTime(action.date);
  const by = idOf(action.idMemberCreator);
  const base = { itemId: trelloRef("card", cardId), boardId: trelloRef("board", boardId) };
  switch (action.type) {
    case "commentCard":
      return [
        event(`comment:${actionId}`, "work.comment_updated", occurredAt, receivedAt, defined({ commentId: trelloRef("action", actionId), ...base, creatorId: by && trelloRef("member", by), createdAt: occurredAt, updatedAt: occurredAt })),
      ];
    case "createCard":
    case "copyCard":
    case "moveCardToBoard":
    case "updateCard": {
      const to = idOf(obj(data?.listAfter)?.id) ?? (action.type === "updateCard" ? undefined : idOf(obj(data?.list)?.id));
      if (!to) return [];
      const from = action.type === "updateCard" ? idOf(obj(data?.listBefore)?.id) : undefined;
      return [event(`move:${actionId}`, "work.item_moved", occurredAt, receivedAt, defined({ ...base, fromGroupId: from, toGroupId: to, movedAt: occurredAt, movedBy: by && trelloRef("member", by) }))];
    }
    case "deleteCard":
      return [event(`delete:${actionId}`, "work.item_deleted", occurredAt, receivedAt, { ...base, reason: "deleted" })];
    default:
      return [];
  }
}
