import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockResponse, type DocMockModule } from "../doc-mock.js";

/**
 * monday.com's GraphQL API (https://api.monday.com/v2), the read queries the
 * connector sends, built from monday.com's developer docs. Data is
 * synthetic. monday.com gives developers a free account, which replaces this
 * mock with recordings once one is set up.
 *
 * The mock reads a request's operation and answers only the named read
 * queries it knows, checked against their documented arguments; a mutation
 * or anything else is refused and counted. Like GraphQL, it returns only the
 * fields a query selects, so a query that leaves a field out never sees it.
 */
const DOCS = "https://developer.monday.com/api-reference";
const API = "https://api.monday.com";

/** Versions monday.com's versioning docs list as usable on 2026-10-22: maintenance, current and release candidate. */
export const MONDAY_MOCK_VERSIONS = ["2026-04", "2026-07", "2026-10"];

export interface MondayMockColumnValue {
  id: string;
  type: string;
  text: string | null;
  [field: string]: unknown;
}

export interface MondayMockItem {
  id: string;
  /** Read by the mock, never by the connector, which doesn't select it. */
  name: string;
  /** The board it's on; a key no query selects, so it never comes back. */
  on_board: string;
  state: "active" | "archived" | "deleted";
  created_at: string;
  updated_at: string;
  creator_id: string | null;
  group: { id: string };
  column_values: MondayMockColumnValue[];
}

export interface MondayMockBoard {
  id: string;
  name: string;
  state: "active" | "archived" | "deleted";
  board_kind: "public" | "private" | "share";
  updated_at: string;
  workspace_id: string | null;
  columns: { id: string; title: string; type: string }[];
  groups: { id: string; title: string; archived: boolean; deleted: boolean }[];
}

export interface MondayMockActivityLog {
  id: string;
  on_board: string;
  event: string;
  entity: "board" | "pulse";
  data: string;
  /** 17-digit Unix time, tenths of a microsecond. */
  created_at: string;
}

export interface MondayMockUpdate {
  id: string;
  item_id: string;
  creator_id: string;
  body: string;
  text_body: string;
  created_at: string;
  updated_at: string;
}

export type MondayMockLimit =
  | { code: "COMPLEXITY_BUDGET_EXHAUSTED" | "maxConcurrencyExceeded" | "IP_RATE_LIMIT_EXCEEDED"; retryInSeconds?: number }
  | { code: "DAILY_LIMIT_EXCEEDED" };

export interface MondayMockData {
  /** The API token the account was connected with. */
  token: string;
  boards: MondayMockBoard[];
  items: MondayMockItem[];
  activityLogs?: MondayMockActivityLog[];
  updates?: MondayMockUpdate[];
  /** The mock's clock, for cursor expiry and the last-updated periods. Read in UTC, as if the token user's time zone were UTC. */
  now: () => Date;
  /** Rate limits to answer before the next reads, in order. */
  rateLimits?: MondayMockLimit[];
}

const notCardLike17 = (digits: string) => {
  // assertSynthetic flags 13 to 19 digits that pass Luhn's check; step by a millisecond until it doesn't.
  let n = BigInt(digits);
  while (luhn(n.toString())) n += 10_000n;
  return n.toString();
};

/** Luhn's check, which assertSynthetic uses to flag card numbers; a 17-digit activity log time can pass it by chance. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** An activity log time from an ISO time, as monday.com writes it: 17 digits. */
export const mondayLogTime17 = (iso: string) => notCardLike17(`${Date.parse(iso)}0000`);

/** Ids shaped like monday.com's: digits, kept under 13 so none looks like a card number. */
export const mondayId = (prefix: number, n: number) => String(prefix * 100_000_000 + n);
export const MONDAY_TEST_BOARD = mondayId(10, 1);
export const MONDAY_TEST_USER = mondayId(30, 1);

const updated = (n: number) => synthetic.isoTime(n * 60 + 30).replace(".000Z", "Z");

export const mondayBoard = fixtureBuilder<MondayMockBoard>((n) => ({
  id: mondayId(10, n),
  name: `Test Repairs ${n}`,
  state: "active",
  board_kind: "public",
  updated_at: updated(n),
  workspace_id: mondayId(20, 1),
  columns: [
    { id: "status", title: "Stage", type: "status" },
    { id: "date4", title: "Promised by", type: "date" },
    { id: "numbers", title: "Estimate", type: "numbers" },
    { id: "check", title: "Deposit taken", type: "checkbox" },
    { id: "dropdown", title: "Metal", type: "dropdown" },
    { id: "timeline", title: "Bench time", type: "timeline" },
    { id: "person", title: "Jeweler", type: "people" },
    { id: "text", title: "Customer", type: "text" },
    { id: "long_text", title: "Notes", type: "long_text" },
    { id: "email", title: "Email", type: "email" },
    { id: "phone", title: "Phone", type: "phone" },
    { id: "location", title: "Address", type: "location" },
    { id: "files", title: "Photos", type: "file" },
    { id: "link", title: "Link", type: "link" },
  ],
  groups: [
    { id: "topics", title: "Received", archived: false, deleted: false },
    { id: "group_ready", title: "Ready for pickup", archived: false, deleted: false },
  ],
}));

/** An item with one column of every kind, the personal ones filled with synthetic values. */
export const mondayItem = fixtureBuilder<MondayMockItem>((n) => ({
  id: mondayId(40, n),
  name: `${synthetic.name(n)} ring resize`,
  on_board: MONDAY_TEST_BOARD,
  state: "active",
  created_at: updated(n - 1),
  updated_at: updated(n),
  creator_id: MONDAY_TEST_USER,
  group: { id: "topics" },
  column_values: [
    { id: "status", type: "status", text: "At the bench", value: '{"index":1}', index: 1, label: "At the bench", is_done: false },
    { id: "date4", type: "date", text: "2026-02-01", value: '{"date":"2026-02-01","time":null}', date: "2026-02-01", time: "" },
    { id: "numbers", type: "numbers", text: "1250.5", value: '"1250.5"', number: 1250.5 },
    { id: "check", type: "checkbox", text: "v", value: '{"checked":true}', checked: true },
    { id: "dropdown", type: "dropdown", text: "14K, Yellow", value: '{"ids":[1,2]}', values: [{ id: "1", label: "14K" }, { id: "2", label: "Yellow" }] },
    // Timeline text is two dates; these days don't make a card-like digit run.
    { id: "timeline", type: "timeline", text: "2026-01-05 - 2026-01-19", value: '{"from":"2026-01-05","to":"2026-01-19"}', from: "2026-01-05T00:00:00+00:00", to: "2026-01-19T00:00:00+00:00" },
    { id: "person", type: "people", text: synthetic.name(90 + n), value: null, persons_and_teams: [{ id: MONDAY_TEST_USER, kind: "person" }, { id: mondayId(31, 1), kind: "team" }] },
    { id: "text", type: "text", text: synthetic.name(n), value: null },
    { id: "long_text", type: "long_text", text: "Synthetic note: resize from 6 to 7", value: null },
    { id: "email", type: "email", text: synthetic.email(n), value: null },
    { id: "phone", type: "phone", text: synthetic.phone(n), value: null },
    { id: "location", type: "location", text: `${n} Test Street, Testville`, value: null },
    { id: "files", type: "file", text: "https://example.test/ring.jpg", value: null },
    { id: "link", type: "link", text: "https://example.test/order", value: null },
  ],
}));

export const mondayUpdate = fixtureBuilder<MondayMockUpdate>((n) => ({
  id: mondayId(50, n),
  item_id: mondayId(40, 1),
  creator_id: MONDAY_TEST_USER,
  body: `<p>Synthetic comment for ${synthetic.name(n)}</p>`,
  text_body: `Synthetic comment for ${synthetic.name(n)}`,
  created_at: updated(n),
  updated_at: updated(n),
}));

/** An activity log entry taking an item off a board, as the delete_pulse and archive_pulse events are assumed to look. */
export const mondayRemoval = (n: number, event: "delete_pulse" | "archive_pulse", itemId: string, at: string, board = MONDAY_TEST_BOARD): MondayMockActivityLog => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  on_board: board,
  event,
  entity: "pulse",
  data: JSON.stringify({ board_id: Number(board), group_id: "topics", pulse_id: Number(itemId), pulse_name: `${synthetic.name(n)} ring` }),
  created_at: mondayLogTime17(at),
});

const ok = (data: unknown): DocMockResponse => ({ status: 200, body: { data, account_id: 1 } });
const graphError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): DocMockResponse => ({
  status,
  body: { errors: [{ message, extensions: { code, ...extra } }], account_id: 1 },
});
const invalid = (message: string) => graphError(200, "InvalidArgumentException", message);

/** The operation, its name and variables' declared types, read from a document. */
function parseOperation(document: string): { kind: string; name: string | undefined; declared: Record<string, string> } {
  const m = /^\s*(query|mutation|subscription)?\s*([A-Za-z_]\w*)?\s*(\(([^)]*)\))?\s*\{/.exec(document);
  const declared: Record<string, string> = {};
  for (const v of (m?.[4] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const d = /^\$(\w+)\s*:\s*(.+)$/.exec(v);
    if (d) declared[d[1]!] = d[2]!.trim();
  }
  // A shorthand `{ ... }` document is a query, as in GraphQL; a second operation anywhere makes it unusable here.
  const kind = m ? (m[1] ?? "query") : "unknown";
  const operations = document.match(/(^|\}|\s)(query|mutation|subscription)\s+[A-Za-z_]\w*\s*[({]/g) ?? [];
  return { kind: operations.length > 1 || /\bmutation\b/.test(document) ? "mutation" : kind, name: m?.[2], declared };
}

/** Only the keys a document selects, as GraphQL answers. Nested objects are kept whole once selected. */
function pick<T extends object>(record: T, document: string): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => new RegExp(`\\b${key}\\b`).test(document))) as Partial<T>;
}

/** Each documented query the mock answers: the variables it takes and their declared types. */
const OPERATIONS: Record<string, { root: string; variables: Record<string, string> }> = {
  Boards: { root: "boards(", variables: { page: "Int!", limit: "Int!" } },
  ItemsFirst: { root: "items_page(", variables: { board: "[ID!]", limit: "Int!", filter: "ItemsQuery" } },
  ItemsFirstText: { root: "items_page(", variables: { board: "[ID!]", limit: "Int!", filter: "ItemsQuery" } },
  ItemsNext: { root: "next_items_page(", variables: { cursor: "String!", limit: "Int!" } },
  ItemsNextText: { root: "next_items_page(", variables: { cursor: "String!", limit: "Int!" } },
  ActivityLogs: { root: "activity_logs(", variables: { board: "[ID!]", from: "ISO8601DateTime!", to: "ISO8601DateTime!", limit: "Int!", page: "Int!" } },
  Updates: { root: "updates(", variables: { from: "String!", to: "String!", limit: "Int!", page: "Int!" } },
};

const PERIODS = ["TODAY", "YESTERDAY", "THIS_WEEK", "LAST_WEEK", "THIS_MONTH", "LAST_MONTH", "PAST_DATETIME"];

/** The [start, end) of a last-updated period in UTC. Weeks start on Sunday, monday.com's default. */
function period(name: string, now: Date): [number, number] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const week = today - now.getUTCDay() * 86_400_000;
  const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const lastMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const end = Number.POSITIVE_INFINITY;
  switch (name) {
    case "TODAY":
      return [today, end];
    case "YESTERDAY":
      return [today - 86_400_000, today];
    case "THIS_WEEK":
      return [week, end];
    case "LAST_WEEK":
      return [week - 7 * 86_400_000, week];
    case "THIS_MONTH":
      return [month, end];
    case "LAST_MONTH":
      return [lastMonth, month];
    default:
      return [Number.NEGATIVE_INFINITY, end];
  }
}

interface CursorState {
  b: string;
  o: number;
  /** The filter the first page was asked with, so later pages match the same items. */
  f: unknown;
  /** When the cursor was first issued, ms. */
  t: number;
}
const encodeCursor = (s: CursorState) => Buffer.from(JSON.stringify(s)).toString("base64url");
const decodeCursor = (c: string): CursorState | null => {
  try {
    const s = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as CursorState;
    return typeof s.b === "string" && Number.isInteger(s.o) && Number.isFinite(s.t) ? s : null;
  } catch {
    return null;
  }
};

const CURSOR_LIFETIME_MS = 60 * 60_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ARG = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

export interface MondayMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Every operation answered or refused, in order, with its variables. */
  readonly operations: { name: string | undefined; kind: string; variables: Record<string, unknown> }[];
  /** API-Version headers received, in order; null when one was left out. */
  readonly versions: (string | null)[];
}

export function mondayDocMock(data: MondayMockData): MondayMock {
  const limits = [...(data.rateLimits ?? [])];
  const operations: MondayMock["operations"] = [];
  const versions: (string | null)[] = [];

  function itemsFor(board: string, filter: unknown): string[] | DocMockResponse {
    let rows = data.items.filter((i) => i.on_board === board && i.state === "active");
    if (filter !== undefined && filter !== null) {
      const rules = (filter as { rules?: unknown }).rules;
      if (!Array.isArray(rules)) return invalid("query_params.rules must be a list");
      for (const rule of rules as Record<string, unknown>[]) {
        if (rule.column_id !== "__last_updated__") return invalid(`the mock filters by __last_updated__ only, not ${String(rule.column_id).slice(0, 40)}`);
        const values = rule.compare_value;
        if (!Array.isArray(values) || !values.every((v) => typeof v === "string" && PERIODS.includes(v))) return invalid("compare_value must name last-updated periods");
        if ((rule.operator ?? "any_of") !== "any_of") return invalid("date periods take any_of");
        if (rule.compare_attribute !== "UPDATED_AT") return invalid("date periods need compare_attribute UPDATED_AT");
        const ranges = values.map((v) => period(v as string, data.now()));
        rows = rows.filter((i) => ranges.some(([from, to]) => Date.parse(i.updated_at) >= from && Date.parse(i.updated_at) < to));
      }
    }
    return rows.map((i) => i.id);
  }

  function itemsPage(state: CursorState, limit: number, document: string): DocMockResponse | { cursor: string | null; items: unknown[] } {
    const matching = itemsFor(state.b, state.f);
    if (!Array.isArray(matching)) return matching;
    const ids = matching.slice(state.o, state.o + limit);
    const more = state.o + limit < matching.length;
    const byId = new Map(data.items.map((i) => [i.id, i]));
    const items = ids.map((id) => byId.get(id)!).map((item) => ({
      ...pick(item, document),
      ...(/column_values/.test(document) ? { column_values: item.column_values.map((c) => pick(c, document)) } : {}),
    }));
    return { cursor: more ? encodeCursor({ ...state, o: state.o + limit }) : null, items };
  }

  const api = checkDocMock({
    integration: "monday",
    baseUrl: API,
    source: { url: `${DOCS}/docs/api-versioning`, title: "monday.com API versioning", retrievedOn: "2026-10-22", version: "2026-07" },
    assumptions: [
      "A personal token is sent as the bare Authorization header value, as the authentication docs' curl example shows; a wrong one gets HTTP 401 with {error_message, status_code}, whose body the docs don't show",
      "COMPLEXITY_BUDGET_EXHAUSTED, maxConcurrencyExceeded and IP_RATE_LIMIT_EXCEEDED come back as HTTP 429 (the error-handling docs' table) with a GraphQL errors body whose extensions carry code and retry_in_seconds (the rate-limit docs say every rate limit error has retry_in_seconds, but show no body)",
      "DAILY_LIMIT_EXCEEDED comes back the same way, as HTTP 429",
      "An expired items_page cursor is refused with extensions.code CursorExpiredError; the docs say cursors expire 60 minutes after the first request but show no error",
      "compare_value can list two last-updated periods at once, as any_of suggests; the docs' examples list one",
      "Items' and updates' created_at and updated_at are ISO 8601 times in UTC; the docs type them as Date without an example",
      "Root updates are filtered by created_at day in UTC, newest first, and paging past the end gives an empty list",
      "boards(state: all, order_by: created_at) pages in a stable order and returns archived and deleted boards with their state",
      "Activity logs for deleted and archived items have event delete_pulse and archive_pulse, entity pulse, and data a JSON string holding pulse_id; the docs list no event names",
      "Activity logs come newest first and page by page and limit; the docs don't give limit's maximum",
      "Variables are accepted with the types the reference lists for each argument ([ID!] for board ids, ItemsQuery, ISO8601DateTime, String for update dates)",
    ],
    routes: [
      {
        method: "POST",
        path: "/v2",
        documentedAt: `${DOCS}/docs/authentication`,
        respond(request) {
          if (request.headers.get("authorization") !== data.token) return { status: 401, body: { error_message: "Not Authenticated", status_code: 401 } };
          const version = request.headers.get("api-version");
          versions.push(version);
          if (version !== null && !MONDAY_MOCK_VERSIONS.includes(version)) return graphError(200, "InvalidVersionException", "The requested API version is invalid");
          let parsed: { query?: unknown; variables?: unknown };
          try {
            parsed = JSON.parse(request.body) as typeof parsed;
          } catch {
            return { status: 400, body: { error_message: "Bad request" } };
          }
          const document = typeof parsed.query === "string" ? parsed.query : "";
          const variables = (parsed.variables && typeof parsed.variables === "object" ? parsed.variables : {}) as Record<string, unknown>;
          const { kind, name, declared } = parseOperation(document);
          operations.push({ name, kind, variables });
          // Read queries only: this mock stands in for reads and refuses every write, whatever its name.
          if (kind !== "query") return graphError(200, "MOCK_READ_ONLY", "This mock answers read queries only");
          const op = name !== undefined && Object.hasOwn(OPERATIONS, name) ? OPERATIONS[name]! : undefined;
          if (!op || !document.includes(op.root)) return graphError(200, "ParseError", "Parse error on an operation this mock doesn't know");
          for (const [v, type] of Object.entries(declared)) if (op.variables[v] !== type) return graphError(200, "ParseError", `Variable $${v} is declared as ${type.slice(0, 30)}`);
          for (const v of Object.keys(variables)) if (!(v in declared)) return graphError(200, "ParseError", `Variable $${v.slice(0, 30)} is not declared`);

          const limit = limits.shift();
          if (limit) {
            const message = limit.code === "DAILY_LIMIT_EXCEEDED" ? "Daily limit exceeded" : "Complexity budget exhausted";
            return { ...graphError(429, limit.code, message, "retryInSeconds" in limit && limit.retryInSeconds ? { retry_in_seconds: limit.retryInSeconds } : {}), headers: { "retry-after": "60" } };
          }

          const page = Number(variables.page ?? 1);
          const size = Number(variables.limit);
          if (!Number.isInteger(size) || size < 1) return invalid("limit must be a positive whole number");
          switch (name) {
            case "Boards": {
              const rows = [...data.boards].slice((page - 1) * size, page * size);
              return ok({ boards: rows.map((b) => pick(b, document)) });
            }
            case "ItemsFirst":
            case "ItemsFirstText": {
              if (size > 500) return invalid("items_page limit is at most 500");
              const ids = variables.board;
              if (!Array.isArray(ids) || ids.length !== 1) return invalid("board ids must be a list");
              const board = data.boards.find((b) => b.id === ids[0]);
              if (!board) return ok({ boards: [] });
              const page = itemsPage({ b: board.id, o: 0, f: variables.filter ?? null, t: data.now().getTime() }, size, document);
              return "status" in page ? page : ok({ boards: [{ items_page: page }] });
            }
            case "ItemsNext":
            case "ItemsNextText": {
              if (size > 500) return invalid("next_items_page limit is at most 500");
              const state = typeof variables.cursor === "string" ? decodeCursor(variables.cursor) : null;
              if (!state) return invalid("The cursor is invalid");
              if (data.now().getTime() - state.t > CURSOR_LIFETIME_MS) {
                return graphError(200, "CursorExpiredError", "The cursor provided for pagination has expired. Please refresh your query and obtain a new cursor to continue fetching items");
              }
              const next = itemsPage(state, size, document);
              return "status" in next ? next : ok({ next_items_page: next });
            }
            case "ActivityLogs": {
              const ids = variables.board;
              const from = String(variables.from);
              const to = String(variables.to);
              if (!Array.isArray(ids) || !ISO.test(from) || !ISO.test(to)) return invalid("activity_logs needs a board and ISO 8601 from and to");
              const ms = (log: MondayMockActivityLog) => Number(log.created_at.slice(0, -4));
              const rows = (data.activityLogs ?? [])
                .filter((l) => l.on_board === ids[0] && ms(l) >= Date.parse(from) && ms(l) <= Date.parse(to))
                .sort((a, b) => ms(b) - ms(a))
                .slice((page - 1) * size, page * size);
              return ok({ boards: [{ activity_logs: rows.map((l) => pick(l, document)) }] });
            }
            case "Updates": {
              if (size > 100) return invalid("updates limit is at most 100");
              const from = String(variables.from);
              const to = String(variables.to);
              if (!DATE_ARG.test(from) || !DATE_ARG.test(to)) return invalid("from_date and to_date must be YYYY-MM-DD or YYYY-MM-DDTHH:mm");
              const start = Date.parse(from.length === 10 ? `${from}T00:00:00Z` : `${from}Z`);
              // A day alone runs to its end.
              const end = to.length === 10 ? Date.parse(`${to}T00:00:00Z`) + 86_400_000 - 1 : Date.parse(`${to}Z`);
              const rows = (data.updates ?? [])
                .filter((u) => Date.parse(u.created_at) >= start && Date.parse(u.created_at) <= end)
                .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
                .slice((page - 1) * size, page * size);
              return ok({ updates: rows.map((u) => pick(u, document)) });
            }
          }
          return graphError(200, "ParseError", "Parse error");
        },
      },
    ],
  });

  return {
    api,
    fetch: docMockFetch(api),
    operations,
    versions,
  };
}

export default {
  integration: "monday",
  covers: "monday.com's GraphQL API: boards, items, activity logs and updates",
  watchPages: [
    "https://developer.monday.com/api-reference/docs/api-versioning",
    "https://developer.monday.com/api-reference/docs/authentication",
  ],
  docMocks: () => [mondayDocMock({ token: "", boards: [], items: [], now: () => new Date(0) }).api],
} satisfies DocMockModule;
