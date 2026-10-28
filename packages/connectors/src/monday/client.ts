/**
 * A small client for monday.com's GraphQL API. Read-only in code: it sends
 * only the query documents listed below, built here, with variables it
 * checked itself, and throws before sending anything else. Callers name a
 * query; they never pass GraphQL text.
 *
 * A personal API token carries every permission its user has in the
 * monday.com UI and can't be limited, so for a personal token the allowlist
 * is the only thing keeping the connector read-only. A monday app's OAuth
 * token is limited to the scopes it was granted (boards:read and
 * updates:read are all this connector needs). The token itself doesn't say
 * which; when the granted scopes are given (MONDAY_OAUTH_SCOPES), the client
 * refuses to run with any scope beyond reading.
 *
 * monday.com meters reads by complexity points per minute (10M shared for a
 * personal token, 5M for an app token, 1M on free and trial accounts), by
 * calls per minute and per day (1,000 a day on the free plan), and by
 * requests at once. Calls go one at a time; a minute, complexity or
 * concurrency limit is waited out for the retry_in_seconds monday.com
 * sends, and the daily limit stops the sync so it resumes from its
 * checkpoint the next day.
 */

export const MONDAY_API_URL = "https://api.monday.com/v2";

/**
 * Pinned on purpose: without the API-Version header monday.com answers with
 * whatever version is current that day. 2026-07 is the current version in
 * monday.com's versioning docs, read on 2026-10-22, and the one its
 * activity log docs require.
 */
export const MONDAY_API_VERSION = "2026-07";

/** Page sizes: the largest items_page and updates allow, and boards' default. */
export const MONDAY_PAGE_SIZES = { boards: 25, items: 500, activity: 500, updates: 100 } as const;

/** Scopes that only read. me:read and account:read identify the account; nothing here writes. */
export const MONDAY_READ_SCOPES = ["boards:read", "updates:read"] as const;
const SAFE_SCOPE = /^[a-z_]+:read$/;

// Column values are read through typed fragments, so a column of any other type comes back as its id and type only.
const COLUMN_VALUES = `column_values {
      id type
      ... on StatusValue { index label is_done }
      ... on DateValue { date }
      ... on NumbersValue { number }
      ... on CheckboxValue { checked }
      ... on DropdownValue { values { id label } }
      ... on TimelineValue { from to }
      ... on PeopleValue { persons_and_teams { id kind } }
    }`;
// The same, plus each value's display text, for boards where the owner allowed a column such as a text one.
const COLUMN_VALUES_WITH_TEXT = COLUMN_VALUES.replace("id type", "id type text");
// No item name: it often holds a customer's name.
const ITEM = (columns: string) => `id state created_at updated_at creator_id group { id }
    ${columns}`;

/** Every document the client may send, by name. Each is a named read query; none takes GraphQL from a caller. */
export const MONDAY_QUERIES = {
  Boards: `query Boards($page: Int!, $limit: Int!) {
  boards(page: $page, limit: $limit, state: all, order_by: created_at) {
    id name state board_kind updated_at workspace_id
    columns { id title type }
    groups { id title archived deleted }
  }
}`,
  ItemsFirst: `query ItemsFirst($board: [ID!], $limit: Int!, $filter: ItemsQuery) {
  boards(ids: $board) {
    items_page(limit: $limit, query_params: $filter) {
      cursor
      items { ${ITEM(COLUMN_VALUES)} }
    }
  }
}`,
  ItemsFirstText: `query ItemsFirstText($board: [ID!], $limit: Int!, $filter: ItemsQuery) {
  boards(ids: $board) {
    items_page(limit: $limit, query_params: $filter) {
      cursor
      items { ${ITEM(COLUMN_VALUES_WITH_TEXT)} }
    }
  }
}`,
  ItemsNext: `query ItemsNext($cursor: String!, $limit: Int!) {
  next_items_page(cursor: $cursor, limit: $limit) {
    cursor
    items { ${ITEM(COLUMN_VALUES)} }
  }
}`,
  ItemsNextText: `query ItemsNextText($cursor: String!, $limit: Int!) {
  next_items_page(cursor: $cursor, limit: $limit) {
    cursor
    items { ${ITEM(COLUMN_VALUES_WITH_TEXT)} }
  }
}`,
  ActivityLogs: `query ActivityLogs($board: [ID!], $from: ISO8601DateTime!, $to: ISO8601DateTime!, $limit: Int!, $page: Int!) {
  boards(ids: $board) {
    activity_logs(from: $from, to: $to, limit: $limit, page: $page) { id event entity data created_at }
  }
}`,
  // No body or text_body: an update's words stay in monday.com.
  Updates: `query Updates($from: String!, $to: String!, $limit: Int!, $page: Int!) {
  updates(from_date: $from, to_date: $to, limit: $limit, page: $page) { id item_id creator_id created_at updated_at }
}`,
} as const;
export type MondayQueryName = keyof typeof MONDAY_QUERIES;
export const MONDAY_QUERY_NAMES = Object.keys(MONDAY_QUERIES) as MondayQueryName[];

/**
 * The only items_page filters the connector sends: items whose last update
 * falls in one of these pairs of periods. monday.com reads them in the
 * token user's time zone, so the connector filters by exact time itself
 * afterwards and only uses a pair that surely reaches back far enough.
 */
export const MONDAY_UPDATED_WINDOWS = [
  ["TODAY", "YESTERDAY"],
  ["THIS_WEEK", "LAST_WEEK"],
  ["THIS_MONTH", "LAST_MONTH"],
] as const;
export type MondayUpdatedWindow = (typeof MONDAY_UPDATED_WINDOWS)[number];

/** The items_page filter for one window, the shape monday.com's last updated docs show. */
export const mondayUpdatedFilter = (window: MondayUpdatedWindow) => ({
  rules: [{ column_id: "__last_updated__", compare_value: [...window], operator: "any_of", compare_attribute: "UPDATED_AT" }],
});

export interface MondayClientOptions {
  /** A personal API token or a monday app's OAuth token. It goes in the Authorization header, nowhere else. */
  token: string;
  /** For an OAuth token, the scopes it was granted. The client refuses one that could change data. */
  scopes?: readonly string[];
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate limit is waited out here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class MondayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MondayConfigError";
  }
}

/** monday.com answered with an error. `code` is its error code, such as COMPLEXITY_BUDGET_EXHAUSTED, when it gives one. */
export class MondayApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "MondayApiError";
    this.status = status;
    this.code = code;
  }
}

/** An items_page cursor ran out (they last 60 minutes); the board has to be read again from the start. */
export class MondayCursorExpiredError extends MondayApiError {
  constructor(code?: string) {
    super("monday.com's items cursor expired; the board is read again from the start", 200, code);
    this.name = "MondayCursorExpiredError";
  }
}

export interface MondayClient {
  query(name: MondayQueryName, variables: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Board and other numeric ids, as strings the way GraphQL's ID sends them. */
export const MONDAY_ID = /^\d{1,20}$/;
/** Opaque items_page cursors are base64-like text. */
const CURSOR = /^[A-Za-z0-9+/=_-]{1,4096}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A named read query and nothing else: no anonymous shorthand, no second operation. */
const READ_ONLY = /^query [A-Z][A-Za-z]*\(/;
const RATE_LIMITED = new Set(["COMPLEXITY_BUDGET_EXHAUSTED", "RATE_LIMIT_EXCEEDED", "Rate Limit Exceeded", "maxConcurrencyExceeded", "IP_RATE_LIMIT_EXCEEDED", "ComplexityException"]);
const MAX_RETRY_AFTER_S = 60;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True for a document the client may send: one named query, with no mutation or subscription anywhere in it. */
export function mondayReadOnlyDocument(document: string): boolean {
  return READ_ONLY.test(document) && !/\b(mutation|subscription)\b/i.test(document) && (document.match(/\bquery\b/g) ?? []).length === 1;
}

/** Scopes beyond reading. Empty means the token can only read. */
export const mondayWriteScopes = (scopes: readonly string[]) => scopes.filter((s) => !SAFE_SCOPE.test(s));

/** Checks for each variable a query takes. Each returns the value as sent, or undefined when it is refused. */
type Check = (value: unknown) => unknown;
const whole =
  (max: number): Check =>
  (v) =>
    Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max ? v : undefined;
const time: Check = (v) => (typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);
const day: Check = (v) => (typeof v === "string" && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : undefined);
/** One board at a time, as monday.com's items_page examples do. */
const board: Check = (v) => (Array.isArray(v) && v.length === 1 && typeof v[0] === "string" && MONDAY_ID.test(v[0]) ? [v[0]] : undefined);
const cursor: Check = (v) => (typeof v === "string" && CURSOR.test(v) ? v : undefined);
/** Absent, or exactly one of the connector's own last-updated filters. */
const itemsQuery: Check = (v) => {
  if (v === null) return null;
  const given = JSON.stringify(v);
  return MONDAY_UPDATED_WINDOWS.some((w) => JSON.stringify(mondayUpdatedFilter(w)) === given) ? v : undefined;
};

const items = { board, limit: whole(MONDAY_PAGE_SIZES.items), filter: itemsQuery };
const next = { cursor, limit: whole(MONDAY_PAGE_SIZES.items) };
const VARIABLES: Record<MondayQueryName, Record<string, Check>> = {
  Boards: { page: whole(100_000), limit: whole(MONDAY_PAGE_SIZES.boards) },
  ItemsFirst: items,
  ItemsFirstText: items,
  ItemsNext: next,
  ItemsNextText: next,
  ActivityLogs: { board, from: time, to: time, limit: whole(MONDAY_PAGE_SIZES.activity), page: whole(100_000) },
  Updates: { from: day, to: day, limit: whole(MONDAY_PAGE_SIZES.updates), page: whole(100_000) },
};
/** Variables a query may leave out. */
const OPTIONAL: Partial<Record<MondayQueryName, string[]>> = { ItemsFirst: ["filter"], ItemsFirstText: ["filter"] };

/** The variables for one query, every one checked. Anything unknown, missing or out of shape throws. */
function checkedVariables(name: MondayQueryName, variables: Record<string, unknown>): Record<string, unknown> {
  const allowed = VARIABLES[name];
  const extra = Object.keys(variables).filter((k) => !Object.hasOwn(allowed, k));
  if (extra.length) throw new MondayConfigError(`${name} doesn't take ${extra.join(", ")}`);
  const out: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(allowed)) {
    if (variables[key] === undefined) {
      if (OPTIONAL[name]?.includes(key)) continue;
      throw new MondayConfigError(`${name} needs ${key}`);
    }
    const value = check(variables[key]);
    if (value === undefined) throw new MondayConfigError(`${name} can't take that ${key}`);
    out[key] = value;
  }
  return out;
}

interface GraphQLError {
  message?: unknown;
  extensions?: { code?: unknown; retry_in_seconds?: unknown };
}

interface GraphQLBody {
  data?: unknown;
  errors?: GraphQLError[];
  /** monday.com's older error shape. */
  error_code?: unknown;
  error_message?: unknown;
  retry_in_seconds?: unknown;
}

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);

/** The code, message and wait monday.com gave for an error. Error bodies describe the request, never the token. */
function errorOf(body: GraphQLBody | null): { code?: string; message?: string; retryIn?: number } {
  const first = Array.isArray(body?.errors) ? body!.errors[0] : undefined;
  const code = text(first?.extensions?.code, 60) ?? text(body?.error_code, 60);
  const message = text(first?.message, 200) ?? text(body?.error_message, 200);
  const retry = Number(first?.extensions?.retry_in_seconds ?? body?.retry_in_seconds);
  return { ...(code ? { code } : {}), ...(message ? { message } : {}), ...(Number.isFinite(retry) && retry > 0 ? { retryIn: retry } : {}) };
}

const HINTS: Record<number, string> = {
  401: "; check MONDAY_API_TOKEN",
  403: "; the token's user can't use the API or see this data",
};

export function mondayClient(options: MondayClientOptions): MondayClient {
  const token = options.token?.trim() ?? "";
  if (!token) throw new MondayConfigError("set MONDAY_API_TOKEN");
  if (/\s/.test(token)) throw new MondayConfigError("MONDAY_API_TOKEN must be the token alone, with no spaces or Bearer prefix");
  if (options.scopes) {
    const extra = mondayWriteScopes(options.scopes);
    if (extra.length) {
      throw new MondayConfigError(`the monday.com token can change data (${extra.slice(0, 5).join(", ")}); reconnect it with only ${MONDAY_READ_SCOPES.join(" ")}`);
    }
  }
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;

  return {
    async query(name, variables) {
      // The allowlist: a personal token can change anything its user can, so nothing but these documents is ever sent.
      const document = Object.hasOwn(MONDAY_QUERIES, name) ? MONDAY_QUERIES[name] : undefined;
      if (!document || !mondayReadOnlyDocument(document)) throw new MondayConfigError("the monday.com connector only sends its listed queries");
      const body = JSON.stringify({ query: document, variables: checkedVariables(name, variables) });
      for (let attempt = 0; ; attempt++) {
        const response = await doFetch(MONDAY_API_URL, {
          method: "POST",
          // The token goes in Authorization as monday.com's docs show it, with no Bearer prefix.
          headers: { authorization: token, "api-version": MONDAY_API_VERSION, "content-type": "application/json", accept: "application/json" },
          body,
        });
        const parsed = (await response.json().catch(() => null)) as GraphQLBody | null;
        const { code, message, retryIn } = errorOf(parsed);
        if (code === "DAILY_LIMIT_EXCEEDED") {
          throw new MondayApiError("monday.com's daily call limit for this account is used up; the next sync resumes from the checkpoint", response.status, code);
        }
        if (response.status === 429 || (code !== undefined && RATE_LIMITED.has(code))) {
          if (attempt < retries) {
            const after = retryIn ?? Number(response.headers.get("retry-after"));
            await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : 1000 * 2 ** attempt);
            continue;
          }
          throw new MondayApiError(`monday.com kept rate-limiting the sync${code ? ` (${code})` : ""}`, response.status, code);
        }
        if (name.startsWith("ItemsNext") && (code === "CursorExpiredError" || /cursor.*expired|expired.*cursor/i.test(message ?? ""))) throw new MondayCursorExpiredError(code);
        if (!response.ok || code !== undefined || message !== undefined) {
          const hint = Object.hasOwn(HINTS, response.status) ? HINTS[response.status] : code === "missingRequiredPermissions" ? "; the token needs boards:read and updates:read" : "";
          throw new MondayApiError(`monday.com answered HTTP ${response.status} to ${name}${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}${hint}`, response.status, code);
        }
        if (!parsed || typeof parsed.data !== "object" || parsed.data === null) throw new MondayApiError(`monday.com answered ${name} without data`, response.status);
        return parsed.data as Record<string, unknown>;
      }
    },
  };
}
