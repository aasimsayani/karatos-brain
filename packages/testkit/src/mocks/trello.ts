import { checkDocMock, type DocMock, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Trello's REST API (1) endpoints for a token's permissions, the member's
 * boards, and a board's lists, custom fields, cards and actions, built from
 * the API reference. Data is synthetic. Like Trello, the mock returns only
 * the id and the fields `fields` names, except an action's data, which it
 * returns whole (comment text and card name included), as Trello does.
 */
const API = "https://api.trello.com/1";
const DOCS = "https://developer.atlassian.com/cloud/trello/rest";

export type TrelloMockRecord = Record<string, unknown> & { id: string };

export interface TrelloMockData {
  boards: TrelloMockRecord[];
  /** By board id. */
  lists?: Record<string, TrelloMockRecord[]>;
  customFields?: Record<string, TrelloMockRecord[]>;
  /** Cards carry idBoard, name and desc as well as the fields read. */
  cards: TrelloMockRecord[];
  /** By board id; each has type, date and data. */
  actions?: Record<string, TrelloMockRecord[]>;
  /** The key and token the mock accepts. Any are accepted when absent. */
  key?: string;
  token?: string;
  /** True when the token was authorized with write as well as read. */
  writeToken?: boolean;
  /** Records per page the mock caps cards and actions at, to exercise paging. Defaults to 1000. */
  pageCap?: number;
  /** How many of the next requests answer 429. */
  rateLimited?: number;
}

const pick = (record: Record<string, unknown>, fields: string | null, extra: string[] = []) => {
  if (fields === null || fields === "all") return { ...record };
  const out: Record<string, unknown> = { id: record.id };
  for (const f of [...fields.split(","), ...extra]) if (f && f in record) out[f] = record[f];
  return out;
};

export function trelloDocMock(data: TrelloMockData): DocMock {
  const denied = (request: { headers: Headers }): DocMockResponse | null => {
    const auth = request.headers.get("authorization") ?? "";
    const m = /^OAuth oauth_consumer_key="([^"]*)", oauth_token="([^"]*)"$/.exec(auth);
    if (!m || (data.key !== undefined && m[1] !== data.key) || (data.token !== undefined && m[2] !== data.token)) return { status: 401, text: "invalid token", headers: { "content-type": "text/plain" } };
    if (data.rateLimited) {
      data.rateLimited--;
      return { status: 429, body: { error: "API_TOKEN_LIMIT_EXCEEDED", message: "Rate limit exceeded" } };
    }
    return null;
  };
  const board = (id: string | undefined) => data.boards.find((b) => b.id === id);
  const missing: DocMockResponse = { status: 404, text: "The requested resource was not found.", headers: { "content-type": "text/plain" } };
  /** Newest first, older than `before` (an id or a date), at most `limit`. */
  const paged = (rows: TrelloMockRecord[], url: URL, time: (r: TrelloMockRecord) => number) => {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), data.pageCap ?? 1000);
    const before = url.searchParams.get("before");
    const since = url.searchParams.get("since");
    const at = (v: string) => (/^[0-9a-f]{24}$/.test(v) ? parseInt(v.slice(0, 8), 16) * 1000 : Date.parse(v));
    return rows
      .filter((r) => (before === null || (/^[0-9a-f]{24}$/.test(before) ? r.id < before : time(r) < at(before))) && (since === null || time(r) >= at(since)))
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  };
  return checkDocMock({
    integration: "trello",
    baseUrl: API,
    source: { url: `${DOCS}/`, title: "Trello REST API reference", retrievedOn: "2026-11-04", version: "1" },
    assumptions: [
      "GET /tokens/{token} with fields=permissions lists what the token may do, with write false for a scope=read token",
      "A board's cards accept filter=all, fields, customFieldItems, limit and before together",
      "Cards and actions paged with before come newest first, so the oldest id on a page is the next before",
      "A 429 carries no Retry-After; waiting for the next 10-second window is enough",
      "A deleted or unreachable board answers 404",
    ],
    routes: [
      {
        method: "GET",
        path: "/tokens/{token}",
        documentedAt: `${DOCS}/api-group-tokens/`,
        respond: (request, params) =>
          denied(request) ??
          (data.token !== undefined && params.token !== data.token
            ? missing
            : {
                status: 200,
                body: pick(
                  {
                    id: "5f0000000000000000000a01",
                    identifier: "KaratOS",
                    permissions: [
                      { idModel: "*", modelType: "Board", read: true, write: data.writeToken === true },
                      { idModel: "*", modelType: "Organization", read: true, write: data.writeToken === true },
                    ],
                  },
                  request.url.searchParams.get("fields"),
                ),
              }),
      },
      {
        method: "GET",
        path: "/members/me/boards",
        documentedAt: `${DOCS}/api-group-members/`,
        respond: (request) => denied(request) ?? { status: 200, body: data.boards.map((b) => pick(b, request.url.searchParams.get("fields"))) },
      },
      {
        method: "GET",
        path: "/boards/{id}/lists",
        documentedAt: `${DOCS}/api-group-boards/`,
        respond: (request, params) => denied(request) ?? (board(params.id) ? { status: 200, body: (data.lists?.[params.id!] ?? []).map((l) => pick(l, request.url.searchParams.get("fields"))) } : missing),
      },
      {
        method: "GET",
        path: "/boards/{id}/customFields",
        documentedAt: `${DOCS}/api-group-boards/`,
        respond: (request, params) => denied(request) ?? (board(params.id) ? { status: 200, body: data.customFields?.[params.id!] ?? [] } : missing),
      },
      {
        method: "GET",
        path: "/boards/{id}/cards",
        documentedAt: `${DOCS}/api-group-boards/`,
        respond(request, params) {
          const no = denied(request);
          if (no) return no;
          if (!board(params.id)) return missing;
          const q = request.url.searchParams;
          const filter = q.get("filter") ?? "visible";
          const rows = data.cards.filter((c) => c.idBoard === params.id && (filter === "all" || c.closed !== true));
          const extra = q.get("customFieldItems") === "true" ? ["customFieldItems"] : [];
          return { status: 200, body: paged(rows, request.url, (r) => parseInt(r.id.slice(0, 8), 16) * 1000).map((c) => pick(c, q.get("fields"), extra)) };
        },
      },
      {
        method: "GET",
        path: "/boards/{id}/actions",
        documentedAt: `${DOCS}/api-group-boards/`,
        respond(request, params) {
          const no = denied(request);
          if (no) return no;
          if (!board(params.id)) return missing;
          const q = request.url.searchParams;
          const filter = (q.get("filter") ?? "all").split(",");
          const rows = (data.actions?.[params.id!] ?? []).filter((a) => filter.includes("all") || filter.includes(String(a.type)) || filter.some((f) => f.startsWith(`${String(a.type)}:`)));
          return { status: 200, body: paged(rows, request.url, (r) => Date.parse(String(r.date))).map((a) => pick(a, q.get("fields"))) };
        },
      },
    ],
  });
}

export default {
  integration: "trello",
  covers: "Trello's token, member board, list, custom field, card and action endpoints (REST API 1)",
  watchPages: [`${DOCS}/`, `${DOCS}/api-group-tokens/`, `${DOCS}/api-group-members/`, `${DOCS}/api-group-boards/`],
  docMocks: () => [trelloDocMock({ boards: [], cards: [] })],
} satisfies DocMockModule;
