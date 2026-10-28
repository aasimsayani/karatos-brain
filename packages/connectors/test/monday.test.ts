import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runSync } from "@karatos/core";
import {
  MONDAY_MOCK_VERSIONS,
  MONDAY_TEST_BOARD,
  MONDAY_TEST_USER,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  mondayBoard,
  mondayDocMock,
  mondayId,
  mondayItem,
  mondayLogTime17,
  mondayRemoval,
  mondayUpdate,
  tamper,
  testPipeline,
  type MondayMock,
  type MondayMockData,
  type MondayMockItem,
} from "@karatos/connector-testkit";
import {
  MONDAY_API_URL,
  MONDAY_API_VERSION,
  MONDAY_CURSOR_MAX_AGE_MS,
  MONDAY_OVERLAP_MS,
  MONDAY_PAGE_SIZES,
  MONDAY_QUERIES,
  MONDAY_QUERY_NAMES,
  MONDAY_READ_SCOPES,
  MONDAY_SAFE_COLUMN_TYPES,
  MONDAY_UPDATED_WINDOWS,
  MONDAY_WRITES,
  MondayApiError,
  MondayConfigError,
  MondayCursorExpiredError,
  mondayActivityEvents,
  mondayBoardEvents,
  mondayClient,
  mondayColumnValues,
  mondayConnector,
  mondayItemEvents,
  mondayLogTime,
  mondayReadOnlyDocument,
  mondayTime,
  mondayUpdateEvents,
  mondayUpdatedFilter,
  mondayWebhookChallenge,
  mondayWebhookChanges,
  mondayWindowFor,
  mondayWriteScopes,
  parseMondayAllowedColumns,
  parseMondayCursor,
  parseMondayScopes,
  verifyMondayWebhook,
  type MondayConnectorOptions,
  type MondayCursor,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = ["monday", "test", "0".repeat(24)].join("-");
const NOW = () => new Date("2026-01-20T00:00:00Z");
const RECEIVED = "2026-01-20T00:00:00.000Z";
const BOARDS = [mondayId(10, 1), mondayId(10, 2), mondayId(10, 3)];
const ITEM = (n: number) => mondayId(40, n);

/** One account: a repairs board, an archived and a deleted board, items, updates and activity logs. */
function account(overrides: Partial<MondayMockData> = {}): MondayMockData {
  for (const b of [mondayBoard, mondayItem, mondayUpdate]) b.reset();
  const boards = [mondayBoard.one(), mondayBoard.one({ state: "archived", name: "Test Production" }), mondayBoard.one({ state: "deleted" })];
  const items: MondayMockItem[] = mondayItem.many(3);
  // One item monday.com returned without its update time: it is dead-lettered, not given a made-up one.
  delete (items[2] as Partial<MondayMockItem>).updated_at;
  return {
    token: TOKEN,
    boards,
    items: [
      ...items,
      // Last changed more than five years ago: outside the import.
      mondayItem.one({ updated_at: "2020-06-01T00:00:00Z" }),
      mondayItem.one({ on_board: BOARDS[1]! }),
      mondayItem.one({ on_board: BOARDS[2]! }),
    ],
    updates: mondayUpdate.many(2),
    activityLogs: [
      mondayRemoval(1, "delete_pulse", ITEM(1), "2026-01-19T12:00:00Z"),
      mondayRemoval(2, "archive_pulse", ITEM(2), "2026-01-19T12:30:00Z"),
      { ...mondayRemoval(3, "delete_pulse", ITEM(3), "2026-01-19T13:00:00Z"), event: "update_column_value" },
      mondayRemoval(4, "delete_pulse", ITEM(3), "2025-06-01T00:00:00Z"),
    ],
    now: NOW,
    ...overrides,
  };
}

const options = (mock: MondayMock, extra: Partial<MondayConnectorOptions> = {}): MondayConnectorOptions => ({
  token: TOKEN,
  fetch: mock.fetch,
  sleep: async () => {},
  now: NOW,
  ...extra,
});
const connector = (mock: MondayMock, extra: Partial<MondayConnectorOptions> = {}) => mondayConnector(options(mock, extra));
const ops = (mock: MondayMock) => mock.operations.map((o) => o.name);
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const graphql = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const collect = async (batches: AsyncIterable<{ events: unknown[]; cursor: string }>) => {
  const out: { events: unknown[]; cursor: string }[] = [];
  for await (const b of batches) out.push(b);
  return out;
};

describe("monday.com client", () => {
  it("checks its settings, naming them but never their values", () => {
    expect(() => mondayClient({ token: " " })).toThrow(new MondayConfigError("set MONDAY_API_TOKEN"));
    expect(() => mondayClient({ token: `Bearer ${TOKEN}` })).toThrow("MONDAY_API_TOKEN must be the token alone");
    expect(() => mondayClient({ token: ` ${TOKEN} ` })).not.toThrow();
    for (const message of [() => mondayClient({ token: `Bearer ${TOKEN}` })]) expect(message).not.toThrow(TOKEN);
  });

  it("refuses an OAuth token granted any scope that can change data", () => {
    expect(() => mondayClient({ token: TOKEN, scopes: [...MONDAY_READ_SCOPES] })).not.toThrow();
    expect(() => mondayClient({ token: TOKEN, scopes: ["boards:read", "boards:write", "updates:write"] })).toThrow(
      new MondayConfigError("the monday.com token can change data (boards:write, updates:write); reconnect it with only boards:read updates:read"),
    );
    expect(mondayWriteScopes(["boards:read", "updates:read", "users:read", "me:read", "account:read", "workspaces:read", "webhooks:read"])).toEqual([]);
    expect(mondayWriteScopes(["boards:write", "webhooks:write", "notifications:write", "docs:write", "boards:readwrite", "boards", "BOARDS:READ", "boards:read "])).toEqual([
      "boards:write",
      "webhooks:write",
      "notifications:write",
      "docs:write",
      "boards:readwrite",
      "boards",
      "BOARDS:READ",
      "boards:read ",
    ]);
  });

  it("sends only its listed queries, never caller GraphQL, and never a mutation", async () => {
    const mock = mondayDocMock(account());
    const client = mondayClient(options(mock));
    for (const name of [
      'mutation { create_item(board_id: 1, item_name: "x") { id } }',
      "query Me { me { id } }",
      // Well-formed read queries are refused too: only the listed documents go out, so nothing asks for names or emails.
      "query Users($page: Int!) { users(page: $page) { id name email } }",
      "query Items($board: [ID!]) { boards(ids: $board) { items_page(limit: 500) { items { name } } } }",
      "Users",
      "__proto__",
      "toString",
      "constructor",
    ]) {
      await expect(client.query(name as never, {})).rejects.toThrow(new MondayConfigError("the monday.com connector only sends its listed queries"));
    }
    expect(mock.fetch.calls).toEqual([]);
    expect(MONDAY_QUERY_NAMES).toEqual(["Boards", "ItemsFirst", "ItemsFirstText", "ItemsNext", "ItemsNextText", "ActivityLogs", "Updates"]);
    for (const name of MONDAY_QUERY_NAMES) expect(mondayReadOnlyDocument(MONDAY_QUERIES[name]), name).toBe(true);
  });

  it("tells a single named read query from anything that could write", () => {
    for (const bad of [
      'mutation CreateItem { create_item(board_id: 1, item_name: "x") { id } }',
      "query A($x: Int!) { boards { id } } mutation B { delete_item(item_id: 1) { id } }",
      "query A($x: Int!) { boards { id } } query B($y: Int!) { me { id } }",
      "subscription S($x: Int!) { boards { id } }",
      "{ boards { id } }",
      "query { boards { id } }",
      " query A($x: Int!) { boards { id } }",
      "query a($x: Int!) { boards { id } }",
      "query A($x: Int!) { boards { id } } # mutation",
    ]) {
      expect(mondayReadOnlyDocument(bad), bad).toBe(false);
    }
  });

  it("checks every variable, sending nothing it didn't check", async () => {
    const mock = mondayDocMock(account());
    const client = mondayClient(options(mock));
    const window = mondayUpdatedFilter(MONDAY_UPDATED_WINDOWS[0]);
    const refused: [Parameters<typeof client.query>[0], Record<string, unknown>, string][] = [
      ["Boards", { page: 1 }, "Boards needs limit"],
      ["Boards", { page: 1, limit: 25, state: "all" }, "Boards doesn't take state"],
      ["Boards", { page: 0, limit: 25 }, "Boards can't take that page"],
      ["Boards", { page: 1.5, limit: 25 }, "Boards can't take that page"],
      ["Boards", { page: 1, limit: 26 }, "Boards can't take that limit"],
      ["ItemsFirst", { board: ["1 OR 1"], limit: 500 }, "ItemsFirst can't take that board"],
      ["ItemsFirst", { board: [BOARDS[0], BOARDS[1]], limit: 500 }, "ItemsFirst can't take that board"],
      ["ItemsFirst", { board: [Number(BOARDS[0])], limit: 500 }, "ItemsFirst can't take that board"],
      ["ItemsFirst", { board: BOARDS[0], limit: 500 }, "ItemsFirst can't take that board"],
      ["ItemsFirst", { board: [BOARDS[0]], limit: 501 }, "ItemsFirst can't take that limit"],
      ["ItemsFirst", { board: [BOARDS[0]], limit: 500, filter: { rules: [{ column_id: "text", compare_value: ["x"], operator: "contains_text" }] } }, "ItemsFirst can't take that filter"],
      ["ItemsFirst", { board: [BOARDS[0]], limit: 500, filter: { ...window, operator: "or" } }, "ItemsFirst can't take that filter"],
      ["ItemsFirst", { board: [BOARDS[0]], limit: 500, filter: mondayUpdatedFilter(["PAST_DATETIME"] as never) }, "ItemsFirst can't take that filter"],
      ["ItemsNext", { cursor: 'x" } mutation { delete_item', limit: 500 }, "ItemsNext can't take that cursor"],
      ["ItemsNext", { cursor: "", limit: 500 }, "ItemsNext can't take that cursor"],
      ["ItemsNext", { limit: 500 }, "ItemsNext needs cursor"],
      ["ActivityLogs", { board: [BOARDS[0]], from: "yesterday", to: RECEIVED, limit: 500, page: 1 }, "ActivityLogs can't take that from"],
      ["ActivityLogs", { board: [BOARDS[0]], from: "2026-01-19T00:00:00+05:00", to: RECEIVED, limit: 500, page: 1 }, "ActivityLogs can't take that from"],
      ["ActivityLogs", { board: [BOARDS[0]], from: RECEIVED, to: "2026-13-45T00:00:00Z", limit: 500, page: 1 }, "ActivityLogs can't take that to"],
      ["Updates", { from: "2026-01-19T10:00", to: "2026-01-21", limit: 100, page: 1 }, "Updates can't take that from"],
      ["Updates", { from: "2026-01-19", to: "2026-01-21", limit: 101, page: 1 }, "Updates can't take that limit"],
    ];
    for (const [name, variables, message] of refused) await expect(client.query(name, variables), message).rejects.toThrow(new MondayConfigError(message));
    // Nothing above reached monday.com.
    expect(mock.fetch.calls).toEqual([]);
    for (const w of MONDAY_UPDATED_WINDOWS) await expect(client.query("ItemsFirst", { board: [BOARDS[0]], limit: 500, filter: mondayUpdatedFilter(w) })).resolves.toBeDefined();
  });

  it("posts to the v2 endpoint with the bare token in Authorization and the pinned API version, nowhere else", async () => {
    const mock = mondayDocMock(account());
    const seen: { method: string; url: string; headers: Headers; body: string }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input as string, init);
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: await request.clone().text() });
      return mock.fetch(request);
    };
    await mondayClient(options(mock, { fetch })).query("Boards", { page: 1, limit: 25 });
    expect(seen).toHaveLength(1);
    const [sent] = seen as [(typeof seen)[number]];
    expect([sent.method, sent.url]).toEqual(["POST", "https://api.monday.com/v2"]);
    expect(MONDAY_API_URL).toBe("https://api.monday.com/v2");
    expect(sent.headers.get("authorization")).toBe(TOKEN);
    expect(sent.headers.get("api-version")).toBe("2026-07");
    expect(MONDAY_API_VERSION).toBe("2026-07");
    expect(MONDAY_MOCK_VERSIONS).toContain(MONDAY_API_VERSION);
    expect(sent.headers.get("content-type")).toBe("application/json");
    // The token goes in Authorization only: not in the address, the body or any other header.
    expect(new URL(sent.url).search).toBe("");
    expect(sent.body).not.toContain(TOKEN);
    for (const [name, value] of sent.headers) if (name !== "authorization") expect(value, name).not.toContain(TOKEN);
    expect(JSON.parse(sent.body)).toEqual({ query: MONDAY_QUERIES.Boards, variables: { page: 1, limit: 25 } });
    expect(mock.versions).toEqual(["2026-07"]);
  });

  it("is answered 401 with the wrong token, with a hint and never the token", async () => {
    const mock = mondayDocMock(account({ token: ["other", "0".repeat(20)].join("-") }));
    const error = await failure(mondayClient(options(mock)).query("Boards", { page: 1, limit: 25 }));
    expect(error).toEqual(new MondayApiError("monday.com answered HTTP 401 to Boards: Not Authenticated; check MONDAY_API_TOKEN", 401));
    expect(error.message).not.toContain(TOKEN);
  });

  it("waits out complexity, concurrency and IP limits for the retry_in_seconds monday.com sends, up to a minute", async () => {
    const waits: number[] = [];
    const mock = mondayDocMock(
      account({
        rateLimits: [
          { code: "COMPLEXITY_BUDGET_EXHAUSTED", retryInSeconds: 7 },
          { code: "maxConcurrencyExceeded" },
          { code: "IP_RATE_LIMIT_EXCEEDED", retryInSeconds: 3600 },
        ],
      }),
    );
    await expect(mondayClient(options(mock, { sleep: async (ms) => void waits.push(ms) })).query("Boards", { page: 1, limit: 25 })).resolves.toHaveProperty("boards");
    // The second had no retry_in_seconds, so the Retry-After header counts.
    expect(waits).toEqual([7000, 60_000, 60_000]);
  });

  it("waits out a complexity error sent with HTTP 200 too, and gives up after its retries", async () => {
    const waits: number[] = [];
    let calls = 0;
    const budget = async () => {
      calls++;
      return graphql(200, { errors: [{ message: "Complexity budget exhausted", extensions: { code: "COMPLEXITY_BUDGET_EXHAUSTED", retry_in_seconds: 12 } }] });
    };
    const error = await failure(mondayClient({ token: TOKEN, fetch: budget, sleep: async (ms) => void waits.push(ms) }).query("Boards", { page: 1, limit: 25 }));
    expect([waits, calls]).toEqual([[12_000, 12_000, 12_000], 4]);
    expect(error).toMatchObject({ name: "MondayApiError", code: "COMPLEXITY_BUDGET_EXHAUSTED", message: "monday.com kept rate-limiting the sync (COMPLEXITY_BUDGET_EXHAUSTED)" });
    // A bare 429 with nothing to go on backs off exponentially.
    const backoff: number[] = [];
    const bare = async () => new Response("", { status: 429 });
    await expect(mondayClient({ token: TOKEN, fetch: bare, sleep: async (ms) => void backoff.push(ms) }).query("Boards", { page: 1, limit: 25 })).rejects.toMatchObject({ status: 429 });
    expect(backoff).toEqual([1000, 2000, 4000]);
    // The older error shape is understood as well.
    const legacy: number[] = [];
    let first = true;
    const old = async () => {
      if (!first) return graphql(200, { data: { boards: [] } });
      first = false;
      return graphql(200, { error_code: "ComplexityException", error_message: "Complexity budget exhausted", retry_in_seconds: 2 });
    };
    await expect(mondayClient({ token: TOKEN, fetch: old, sleep: async (ms) => void legacy.push(ms) }).query("Boards", { page: 1, limit: 25 })).resolves.toEqual({ boards: [] });
    expect(legacy).toEqual([2000]);
  });

  it("stops at the daily limit without waiting, so the next sync resumes from the checkpoint", async () => {
    const waits: number[] = [];
    const mock = mondayDocMock(account({ rateLimits: [{ code: "DAILY_LIMIT_EXCEEDED" }] }));
    const error = await failure(mondayClient(options(mock, { sleep: async (ms) => void waits.push(ms) })).query("Boards", { page: 1, limit: 25 }));
    expect(waits).toEqual([]);
    expect(error).toMatchObject({ name: "MondayApiError", code: "DAILY_LIMIT_EXCEEDED", message: "monday.com's daily call limit for this account is used up; the next sync resumes from the checkpoint" });
  });

  it("reports monday.com's errors cut short, with hints, and refuses an answer without data", async () => {
    const long = async () => graphql(200, { errors: [{ message: "x".repeat(500), extensions: { code: "InvalidArgumentException" } }] });
    const cut = await failure(mondayClient({ token: TOKEN, fetch: long }).query("Boards", { page: 1, limit: 25 }));
    expect(cut.message.length).toBeLessThan(280);
    expect(cut).toMatchObject({ code: "InvalidArgumentException", status: 200 });
    const scopes = async () => graphql(200, { errors: [{ message: "Missing scopes", extensions: { code: "missingRequiredPermissions" } }] });
    await expect(mondayClient({ token: TOKEN, fetch: scopes }).query("Updates", { from: "2026-01-19", to: "2026-01-21", limit: 100, page: 1 })).rejects.toThrow(
      "monday.com answered HTTP 200 to Updates (missingRequiredPermissions): Missing scopes; the token needs boards:read and updates:read",
    );
    const denied = async () => graphql(403, { errors: [{ message: "User unauthorized to perform action", extensions: { code: "UserUnauthorizedException" } }] });
    await expect(mondayClient({ token: TOKEN, fetch: denied }).query("Boards", { page: 1, limit: 25 })).rejects.toThrow(/; the token's user can't use the API or see this data$/);
    const bare = async () => new Response("not json", { status: 500 });
    await expect(mondayClient({ token: TOKEN, fetch: bare }).query("Boards", { page: 1, limit: 25 })).rejects.toThrow(new MondayApiError("monday.com answered HTTP 500 to Boards", 500));
    const empty = async () => graphql(200, { account_id: 1 });
    await expect(mondayClient({ token: TOKEN, fetch: empty }).query("Boards", { page: 1, limit: 25 })).rejects.toThrow("monday.com answered Boards without data");
    for (const e of [cut]) expect(e.message).not.toContain(TOKEN);
  });

  it("tells an expired items cursor from other errors, on next_items_page only", async () => {
    const expired = async () => graphql(200, { errors: [{ message: "The cursor provided for pagination has expired", extensions: { code: "CursorExpiredError" } }] });
    const client = mondayClient({ token: TOKEN, fetch: expired });
    await expect(client.query("ItemsNext", { cursor: "abc", limit: 500 })).rejects.toBeInstanceOf(MondayCursorExpiredError);
    await expect(client.query("ItemsNextText", { cursor: "abc", limit: 500 })).rejects.toBeInstanceOf(MondayCursorExpiredError);
    const byMessage = async () => graphql(200, { errors: [{ message: "Cursor has expired, please refresh" }] });
    await expect(mondayClient({ token: TOKEN, fetch: byMessage }).query("ItemsNext", { cursor: "abc", limit: 500 })).rejects.toBeInstanceOf(MondayCursorExpiredError);
    const other = await failure(client.query("Boards", { page: 1, limit: 25 }));
    expect(other).not.toBeInstanceOf(MondayCursorExpiredError);
  });
});

describe("monday.com doc mock", () => {
  it("answers read queries only and counts every mutation it refuses", async () => {
    const mock = mondayDocMock(account());
    const post = (query: string, variables: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
      mock.fetch(MONDAY_API_URL, { method: "POST", headers: { authorization: TOKEN, "content-type": "application/json", ...headers }, body: JSON.stringify({ query, variables }) }).then((r) => r.json());
    const refused = await post('mutation { create_item(board_id: 1, item_name: "x") { id } }');
    expect(refused.errors[0].extensions.code).toBe("MOCK_READ_ONLY");
    expect((await post(`${MONDAY_QUERIES.Boards} mutation B { delete_item(item_id: 1) { id } }`, { page: 1, limit: 25 })).errors[0].extensions.code).toBe("MOCK_READ_ONLY");
    expect((await post("query Me($x: Int!) { me { id } }")).errors[0].extensions.code).toBe("ParseError");
    expect((await post(MONDAY_QUERIES.Boards.replace("$limit: Int!", "$limit: String!"), { page: 1, limit: 25 })).errors[0].extensions.code).toBe("ParseError");
    expect((await post(MONDAY_QUERIES.Boards, { page: 1, limit: 25, state: "all" })).errors[0].extensions.code).toBe("ParseError");
    expect((await post(MONDAY_QUERIES.Boards, { page: 1, limit: 25 }, { "api-version": "2023" })).errors[0].extensions.code).toBe("InvalidVersionException");
    // The bad version is refused before the document is read.
    expect(mock.operations.map((o) => o.kind)).toEqual(["mutation", "mutation", "query", "query", "query"]);
    // A shorthand document is a query, and an unknown one.
    expect((await post("{ boards { id } }")).errors[0].extensions.code).toBe("ParseError");
  });

  it("returns only the fields a query selects, so an item's name, text and an update's body never leave it", async () => {
    const mock = mondayDocMock(account());
    const client = mondayClient(options(mock));
    const plain = (await client.query("ItemsFirst", { board: [BOARDS[0]], limit: 500 })) as { boards: { items_page: { items: Record<string, unknown>[] } }[] };
    const item = plain.boards[0]!.items_page.items[0]!;
    expect(Object.keys(item).sort()).toEqual(["column_values", "created_at", "creator_id", "group", "id", "state", "updated_at"]);
    expect(JSON.stringify(item)).not.toMatch(/Test Customer|@|555|Test Street|Synthetic note/);
    const text = (await client.query("ItemsFirstText", { board: [BOARDS[0]], limit: 500 })) as typeof plain;
    expect(JSON.stringify(text)).toContain("customer1@example.test");
    const updates = (await client.query("Updates", { from: "2025-01-01", to: "2026-01-21", limit: 100, page: 1 })) as { updates: Record<string, unknown>[] };
    expect(Object.keys(updates.updates[0]!).sort()).toEqual(["created_at", "creator_id", "id", "item_id", "updated_at"]);
  });

  it("routes by exact host, so a look-alike is refused", async () => {
    const mock = mondayDocMock(account());
    await expect(mock.fetch("https://api.monday.com.example.test/v2", { method: "POST" })).rejects.toThrow(/not in the vendor's docs/);
    await expect(mock.fetch("https://api.monday.com/v1", { method: "POST" })).rejects.toThrow(/not in the vendor's docs/);
  });

  it("writes activity log times as 17 digits that never look like a card number", () => {
    const t = mondayLogTime17("2026-01-19T12:00:00Z");
    expect(t).toMatch(/^\d{17}$/);
    expect(Date.parse("2026-01-19T12:00:00Z") - Number(t.slice(0, -4))).toBeLessThanOrEqual(0);
    for (let n = 0; n < 200; n++) expect(() => assertSynthetic({ t: mondayLogTime17(new Date(Date.UTC(2026, 0, 1) + n * 61_000).toISOString()) })).not.toThrow();
  });
});

describe("monday.com normalization", () => {
  const board = () => {
    mondayBoard.reset();
    return mondayBoard.one();
  };
  const item = (overrides: Partial<MondayMockItem> = {}) => {
    mondayItem.reset();
    return mondayItem.one(overrides);
  };

  it("keeps the safe column types, typed, and drops text, notes, emails, phones, addresses, files and links", () => {
    const [event] = mondayItemEvents(item(), MONDAY_TEST_BOARD, RECEIVED);
    expect(event).toEqual({
      id: `monday_item:${ITEM(1)}:${Date.parse("2026-01-01T01:30:00Z")}`,
      type: "work.item_updated",
      occurredAt: "2026-01-01T01:30:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `monday:item:${ITEM(1)}:${Date.parse("2026-01-01T01:30:00Z")}`,
      payload: {
        itemId: `monday:item:${ITEM(1)}`,
        boardId: `monday:board:${MONDAY_TEST_BOARD}`,
        groupId: "topics",
        state: "active",
        createdAt: "2026-01-01T00:30:00.000Z",
        updatedAt: "2026-01-01T01:30:00.000Z",
        creatorId: `monday:user:${MONDAY_TEST_USER}`,
        columns: {
          status: { type: "status", label: "At the bench", index: 1, done: false },
          date4: { type: "date", date: "2026-02-01" },
          numbers: { type: "numbers", number: 1250.5 },
          check: { type: "checkbox", checked: true },
          dropdown: { type: "dropdown", labels: ["14K", "Yellow"], ids: ["1", "2"] },
          timeline: { type: "timeline", from: "2026-01-05", to: "2026-01-19" },
          person: { type: "people", people: [`monday:user:${MONDAY_TEST_USER}`], teams: [`monday:team:${mondayId(31, 1)}`] },
        },
      },
    });
    expect([...MONDAY_SAFE_COLUMN_TYPES]).toEqual(["status", "date", "numbers", "checkbox", "dropdown", "timeline", "people"]);
    // Even with every column's display text in hand, none of it is kept.
    const text = JSON.stringify(event);
    for (const personal of ["Test Customer", "ring resize", "@", "555", "Test Street", "Testville", "Synthetic note", "example.test", "At the bench, ", "14K, Yellow"]) expect(text, personal).not.toContain(personal);
  });

  it("keeps an unsafe column's text only where the owner allowed that column on that board", () => {
    const allowed = parseMondayAllowedColumns(` ${MONDAY_TEST_BOARD}:long_text, ${mondayId(10, 9)}:email `);
    const columns = mondayColumnValues(item().column_values, MONDAY_TEST_BOARD, allowed);
    expect(columns.long_text).toEqual({ type: "long_text", text: "Synthetic note: resize from 6 to 7" });
    expect(Object.keys(columns)).not.toContain("email");
    expect(Object.keys(columns)).not.toContain("text");
    expect(mondayColumnValues(item().column_values, mondayId(10, 9), allowed).email).toEqual({ type: "email", text: "customer1@example.test" });
    // A safe column allowed by mistake stays typed.
    expect(mondayColumnValues(item().column_values, MONDAY_TEST_BOARD, parseMondayAllowedColumns(`${MONDAY_TEST_BOARD}:status`)).status).toEqual({ type: "status", label: "At the bench", index: 1, done: false });
    expect(() => parseMondayAllowedColumns("text")).toThrow(MondayConfigError);
    expect(() => parseMondayAllowedColumns(`${MONDAY_TEST_BOARD}:te xt`)).toThrow("MONDAY_ALLOWED_COLUMNS must be board:column pairs");
    expect(parseMondayAllowedColumns(undefined)).toEqual(new Map());
    expect(parseMondayAllowedColumns(`1:a,1:b`)).toEqual(new Map([["1", new Set(["a", "b"])]]));
  });

  it("reads empty and odd column values as nulls, and skips columns with no usable id or type", () => {
    const columns = mondayColumnValues(
      [
        { id: "status", type: "status", label: null, index: null },
        { id: "date4", type: "date", date: "" },
        { id: "numbers", type: "numbers", number: Number.NaN },
        { id: "check", type: "checkbox", checked: "true" },
        { id: "dropdown", type: "dropdown", values: "14K" },
        { id: "timeline", type: "timeline", from: null, to: "soon" },
        { id: "person", type: "people", persons_and_teams: [{ id: 5, kind: "person" }, { id: "../1", kind: "person" }, null] },
        { id: "../x", type: "status", label: "x" },
        { id: "nolabel" },
        null,
      ],
      MONDAY_TEST_BOARD,
    );
    expect(columns).toEqual({
      status: { type: "status", label: null, index: null },
      date4: { type: "date", date: null },
      numbers: { type: "numbers", number: null },
      check: { type: "checkbox", checked: false },
      dropdown: { type: "dropdown", labels: [], ids: [] },
      timeline: { type: "timeline", from: null, to: null },
      person: { type: "people", people: ["monday:user:5"], teams: [] },
    });
    expect(mondayColumnValues("not a list", MONDAY_TEST_BOARD)).toEqual({});
  });

  it("stores a new version when updated_at moves, drops items with no usable id, and dead-letters ones with no time", () => {
    const first = mondayItemEvents(item(), MONDAY_TEST_BOARD, RECEIVED)[0]!;
    const later = mondayItemEvents(item({ updated_at: "2026-01-05T00:00:00Z" }), MONDAY_TEST_BOARD, RECEIVED)[0]!;
    expect(first.idempotencyKey).not.toBe(later.idempotencyKey);
    expect(mondayItemEvents(item(), MONDAY_TEST_BOARD, RECEIVED)[0]!.idempotencyKey).toBe(first.idempotencyKey);
    expect(mondayItemEvents({ ...item(), id: "../1" }, MONDAY_TEST_BOARD, RECEIVED)).toEqual([]);
    expect(mondayItemEvents(item(), "../1", RECEIVED)).toEqual([]);
    expect(mondayItemEvents(null as never, MONDAY_TEST_BOARD, RECEIVED)).toEqual([]);
    const timeless = mondayItemEvents({ id: ITEM(9) }, MONDAY_TEST_BOARD, RECEIVED)[0]!;
    expect([timeless.occurredAt, timeless.idempotencyKey.endsWith(":0"), timeless.payload]).toEqual([
      undefined,
      true,
      { itemId: `monday:item:${ITEM(9)}`, boardId: `monday:board:${MONDAY_TEST_BOARD}`, state: "active", columns: {} },
    ]);
  });

  it("keeps who commented on which item and when, never what they said", () => {
    mondayUpdate.reset();
    const update = mondayUpdate.one();
    const [event] = mondayUpdateEvents(update, RECEIVED);
    expect(event).toMatchObject({
      type: "work.comment_updated",
      occurredAt: "2026-01-01T01:30:00.000Z",
      idempotencyKey: `monday:update:${update.id}:${Date.parse("2026-01-01T01:30:00Z")}`,
      payload: { commentId: `monday:update:${update.id}`, itemId: `monday:item:${ITEM(1)}`, creatorId: `monday:user:${MONDAY_TEST_USER}`, createdAt: "2026-01-01T01:30:00.000Z", updatedAt: "2026-01-01T01:30:00.000Z" },
    });
    expect(Object.keys(event!.payload).sort()).toEqual(["commentId", "createdAt", "creatorId", "itemId", "updatedAt"]);
    expect(JSON.stringify(event)).not.toContain("Synthetic comment");
    expect(mondayUpdateEvents({ id: "x" }, RECEIVED)).toEqual([]);
    expect(mondayUpdateEvents({ id: mondayId(50, 9), created_at: "2026-01-02T00:00:00Z" }, RECEIVED)[0]!.occurredAt).toBe("2026-01-02T00:00:00.000Z");
    // The update queries never ask for the words.
    expect(MONDAY_QUERIES.Updates).not.toMatch(/\bbody\b|text_body|replies|assets/);
  });

  it("turns deletions and archives in the activity log into work.item_deleted, without the item's name", () => {
    const deleted = mondayActivityEvents(mondayRemoval(1, "delete_pulse", ITEM(1), "2026-01-19T12:00:00Z"), MONDAY_TEST_BOARD, RECEIVED);
    expect(deleted).toEqual([
      {
        id: `monday_item:${ITEM(1)}:deleted:00000000-0000-4000-8000-000000000001`,
        type: "work.item_deleted",
        occurredAt: "2026-01-19T12:00:00.000Z",
        receivedAt: RECEIVED,
        idempotencyKey: `monday:item:${ITEM(1)}:deleted:00000000-0000-4000-8000-000000000001`,
        payload: { itemId: `monday:item:${ITEM(1)}`, boardId: `monday:board:${MONDAY_TEST_BOARD}`, reason: "deleted" },
      },
    ]);
    expect(mondayActivityEvents(mondayRemoval(2, "archive_pulse", ITEM(2), "2026-01-19T12:00:00Z"), MONDAY_TEST_BOARD, RECEIVED)[0]!.payload.reason).toBe("archived");
    expect(JSON.stringify(deleted)).not.toContain("Test Customer");
    const base = mondayRemoval(3, "delete_pulse", ITEM(3), "2026-01-19T12:00:00Z");
    for (const odd of [{ ...base, event: "update_column_value" }, { ...base, event: "__proto__" }, { ...base, data: "{not json" }, { ...base, data: JSON.stringify({ pulse_id: "x" }) }, { ...base, data: "null" }, { ...base, data: 5 }]) {
      expect(mondayActivityEvents(odd as never, MONDAY_TEST_BOARD, RECEIVED)).toEqual([]);
    }
    expect(mondayActivityEvents(base, "../1", RECEIVED)).toEqual([]);
    expect(mondayActivityEvents({ ...base, id: undefined }, MONDAY_TEST_BOARD, RECEIVED)[0]!.idempotencyKey).toBe(`monday:item:${ITEM(3)}:deleted:${Number(base.created_at.slice(0, -4))}`);
  });

  it("describes boards with their columns and groups, so departments can map stages", () => {
    const [event] = mondayBoardEvents(board(), RECEIVED);
    expect(event).toMatchObject({
      type: "work.board_updated",
      occurredAt: "2026-01-01T01:30:00.000Z",
      idempotencyKey: `monday:board:${MONDAY_TEST_BOARD}:${Date.parse("2026-01-01T01:30:00Z")}`,
      payload: { boardId: `monday:board:${MONDAY_TEST_BOARD}`, name: "Test Repairs 1", state: "active", kind: "public", workspaceId: `monday:workspace:${mondayId(20, 1)}` },
    });
    expect((event!.payload.columns as unknown[])[0]).toEqual({ id: "status", type: "status", title: "Stage" });
    expect((event!.payload.groups as unknown[])[1]).toEqual({ id: "group_ready", title: "Ready for pickup", archived: false, deleted: false });
    expect(mondayBoardEvents({ id: MONDAY_TEST_BOARD, columns: [{ id: "../x" }], groups: "x", workspace_id: null }, RECEIVED)[0]!.payload).toEqual({
      boardId: `monday:board:${MONDAY_TEST_BOARD}`,
      name: `Board ${MONDAY_TEST_BOARD}`,
      state: "active",
      columns: [],
      groups: [],
    });
    expect(mondayBoardEvents({ id: "x" }, RECEIVED)).toEqual([]);
  });

  it("reads monday.com's times as UTC, and dead-letters anything else", () => {
    expect(mondayTime("2026-01-19T12:00:00Z")).toBe("2026-01-19T12:00:00.000Z");
    expect(mondayTime("2026-01-19T12:00:00+05:00")).toBe("2026-01-19T07:00:00.000Z");
    expect(mondayTime("2026-01-19T12:00:00")).toBe("2026-01-19T12:00:00.000Z");
    for (const bad of ["soon", "2026-01-19", "2026-13-45T00:00:00Z", "", 5, undefined]) expect(mondayTime(bad)).toBeUndefined();
    expect(mondayLogTime("17112345678901234")).toBe(new Date(1711234567890).toISOString());
    expect(mondayLogTime(17112345678901234)).toBe(new Date(1711234567890).toISOString());
    for (const bad of ["1711234567890", "2026-01-19T12:00:00Z", "171123456789012345", undefined]) expect(mondayLogTime(bad)).toBeUndefined();
  });

  it("uses synthetic fixtures only, long monday.com ids and log times included", () => {
    expect(() => assertSynthetic(account())).not.toThrow();
  });
});

describe("monday.com sync", () => {
  it("imports, replays, resumes and retries the mocked account", async () => {
    // 3 boards; 2 items on the first board and one dead-lettered, one older than five years; 1 on the archived board,
    // none read from the deleted one; 2 updates.
    const result = await checkConnectorSync({ makeConnector: () => connector(mondayDocMock(account())), expected: { ingested: 8, deadLettered: 1 } });
    expect(result.full.batches).toBe(4);
    expect(parseMondayCursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done" });
  });

  it("reads every board, then each live board's items whole, then five years of updates, with nothing but queries", async () => {
    const mock = mondayDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 8, deadLettered: 1, batches: 4 });
    expect(mock.operations.map((o) => [o.name, o.variables])).toEqual([
      ["Boards", { page: 1, limit: 25 }],
      ["ItemsFirst", { board: [BOARDS[0]], limit: 500 }],
      ["ItemsFirst", { board: [BOARDS[1]], limit: 500 }],
      ["Updates", { from: "2021-01-19", to: "2026-01-21", limit: 100, page: 1 }],
    ]);
    expect(mock.operations.every((o) => o.kind === "query")).toBe(true);
    const types = memory.events.map((e) => e.type);
    expect(types.filter((t) => t === "work.board_updated")).toHaveLength(3);
    expect(types.filter((t) => t === "work.item_updated")).toHaveLength(3);
    expect(types.filter((t) => t === "work.comment_updated")).toHaveLength(2);
    expect(memory.events.filter((e) => e.type === "work.board_updated").map((e) => e.payload.state)).toEqual(["active", "archived", "deleted"]);
    const stored = JSON.stringify(memory.events);
    for (const personal of ["Test Customer", "@", "555", "Test Street", "Synthetic note", "Synthetic comment", "ring resize"]) expect(stored, personal).not.toContain(personal);
  });

  it("asks for display text only on boards with an allowed column, and keeps only that column", async () => {
    const mock = mondayDocMock(account());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock, { allowedColumns: parseMondayAllowedColumns(`${BOARDS[1]}:long_text`) }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(ops(mock)).toEqual(["Boards", "ItemsFirst", "ItemsFirstText", "Updates"]);
    const items = memory.events.filter((e) => e.type === "work.item_updated");
    const onArchived = items.find((e) => e.payload.boardId === `monday:board:${BOARDS[1]}`)!;
    expect((onArchived.payload.columns as Record<string, unknown>).long_text).toEqual({ type: "long_text", text: "Synthetic note: resize from 6 to 7" });
    expect(JSON.stringify(items)).not.toMatch(/Test Customer|@|555|Test Street/);
    expect(JSON.stringify(items.filter((e) => e !== onArchived))).not.toContain("Synthetic note");
  });

  it("follows every page: boards 25 at a time, items by cursor, updates 100 at a time", async () => {
    const data = account();
    for (let n = 0; n < 23; n++) data.boards.push(mondayBoard.one({ state: "deleted" }));
    const last = mondayBoard.one();
    data.boards.push(last);
    mondayItem.reset();
    data.items = mondayItem.many(MONDAY_PAGE_SIZES.items + 1);
    data.items.push(mondayItem.one({ on_board: last.id }));
    mondayUpdate.reset();
    data.updates = mondayUpdate.many(MONDAY_PAGE_SIZES.updates + 1);
    const mock = mondayDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(ops(mock)).toEqual(["Boards", "ItemsFirst", "ItemsNext", "ItemsFirst", "Boards", "ItemsFirst", "Updates", "Updates"]);
    expect(mock.operations.filter((o) => o.name === "Boards").map((o) => o.variables.page)).toEqual([1, 2]);
    expect(mock.operations.filter((o) => o.name === "Updates").map((o) => o.variables.page)).toEqual([1, 2]);
    expect(memory.events.filter((e) => e.type === "work.item_updated")).toHaveLength(MONDAY_PAGE_SIZES.items + 2);
    expect(report.ingested).toBe(27 + MONDAY_PAGE_SIZES.items + 2 + MONDAY_PAGE_SIZES.updates + 1);
  });

  it("leaves a finished import finished", async () => {
    const mock = mondayDocMock(account());
    const done: MondayCursor = { ...cursorAt("historical", "done"), boards: [] };
    expect(await collect(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) }))).toEqual([]);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("reads changes since the last pass started, deletions and archives included, and starts the next pass a little earlier", async () => {
    const data = account();
    data.items[1]!.updated_at = "2026-01-19T10:00:00Z";
    data.updates!.push(mondayUpdate.one({ created_at: "2026-01-19T11:00:00Z", updated_at: "2026-01-19T11:00:00Z" }));
    const mock = mondayDocMock(data);
    const previous: MondayCursor = { ...cursorAt("incremental", "done"), boards: [], since: "2026-01-18T00:00:00.000Z", until: "2026-01-19T00:05:00.000Z", nextFrom: "2026-01-19T00:00:00.000Z" };
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "monday", "incremental", JSON.stringify(previous));
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // A day since the last pass: today and yesterday might not reach back far enough, so this week and last.
    const week = mondayUpdatedFilter(["THIS_WEEK", "LAST_WEEK"]);
    expect(mock.operations.map((o) => [o.name, o.variables])).toEqual([
      ["Boards", { page: 1, limit: 25 }],
      ["ItemsFirst", { board: [BOARDS[0]], limit: 500, filter: week }],
      ["ActivityLogs", { board: [BOARDS[0]], from: "2026-01-19T00:00:00.000Z", to: RECEIVED, limit: 500, page: 1 }],
      ["ItemsFirst", { board: [BOARDS[1]], limit: 500, filter: week }],
      ["ActivityLogs", { board: [BOARDS[1]], from: "2026-01-19T00:00:00.000Z", to: RECEIVED, limit: 500, page: 1 }],
      ["Updates", { from: "2026-01-18", to: "2026-01-21", limit: 100, page: 1 }],
    ]);
    expect(report).toMatchObject({ ingested: 3 + 1 + 2 + 1, deadLettered: 0, batches: 6 });
    expect(memory.events.filter((e) => e.type === "work.item_deleted").map((e) => e.payload)).toEqual([
      { itemId: `monday:item:${ITEM(2)}`, boardId: `monday:board:${BOARDS[0]}`, reason: "archived" },
      { itemId: `monday:item:${ITEM(1)}`, boardId: `monday:board:${BOARDS[0]}`, reason: "deleted" },
    ]);
    expect(memory.events.filter((e) => e.type === "work.item_updated").map((e) => e.payload.itemId)).toEqual([`monday:item:${ITEM(2)}`]);
    expect(parseMondayCursor(report.cursor)).toMatchObject({ pass: "incremental", step: "done", since: "2026-01-19T00:00:00.000Z", until: RECEIVED, nextFrom: "2026-01-19T23:55:00.000Z" });
    expect(MONDAY_OVERLAP_MS).toBe(5 * 60_000);
  });

  it("keeps only items changed since the pass's start, though monday.com's window reaches further back", async () => {
    const data = account();
    data.items[0]!.updated_at = "2026-01-18T23:00:00Z";
    data.items[1]!.updated_at = "2026-01-19T10:00:00Z";
    const mock = mondayDocMock(data);
    const recent: MondayCursor = { ...cursorAt("incremental", "done"), boards: [], nextFrom: "2026-01-19T00:00:00.000Z" };
    const batches = await collect(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(recent) }));
    const items = batches.flatMap((b) => b.events as { type: string; payload: Record<string, unknown> }[]).filter((e) => e.type === "work.item_updated");
    expect(items.map((e) => e.payload.itemId)).toEqual([`monday:item:${ITEM(2)}`]);
  });

  it("picks the narrowest last-updated window that surely reaches back far enough, or reads boards whole", () => {
    const until = RECEIVED;
    const ago = (ms: number) => new Date(Date.parse(until) - ms).toISOString();
    const H = 3_600_000;
    expect(mondayWindowFor(ago(H), until)).toEqual(["TODAY", "YESTERDAY"]);
    expect(mondayWindowFor(ago(22 * H), until)).toEqual(["TODAY", "YESTERDAY"]);
    expect(mondayWindowFor(ago(22 * H + 1), until)).toEqual(["THIS_WEEK", "LAST_WEEK"]);
    expect(mondayWindowFor(ago(7 * 24 * H - 2 * H), until)).toEqual(["THIS_WEEK", "LAST_WEEK"]);
    expect(mondayWindowFor(ago(7 * 24 * H - 2 * H + 1), until)).toEqual(["THIS_MONTH", "LAST_MONTH"]);
    expect(mondayWindowFor(ago(28 * 24 * H - 2 * H), until)).toEqual(["THIS_MONTH", "LAST_MONTH"]);
    expect(mondayWindowFor(ago(28 * 24 * H - 2 * H + 1), until)).toBeNull();
  });

  it("looks back 48 hours without a checkpoint, and reads boards whole after four weeks away", async () => {
    const fresh = mondayDocMock(account());
    await runSync({ connector: connector(fresh), mode: "incremental", ...testPipeline(), organizationId: TEST_ORG });
    expect(fresh.operations[1]!.variables.filter).toEqual(mondayUpdatedFilter(["THIS_WEEK", "LAST_WEEK"]));
    expect(fresh.operations.find((o) => o.name === "ActivityLogs")!.variables.from).toBe("2026-01-18T00:00:00.000Z");
    const away = mondayDocMock(account());
    const old: MondayCursor = { ...cursorAt("incremental", "done"), boards: [], nextFrom: "2025-12-01T00:00:00.000Z" };
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "monday", "incremental", JSON.stringify(old));
    const report = await runSync({ connector: connector(away), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(away.operations[1]!.variables).toEqual({ board: [BOARDS[0]], limit: 500 });
    // Every item on the live boards changed after December 1st; the timeless one is dead-lettered.
    expect(report).toMatchObject({ deadLettered: 1 });
  });

  it("reads each activity log page by page until a short one", async () => {
    const data = account();
    data.activityLogs = Array.from({ length: MONDAY_PAGE_SIZES.activity + 1 }, (_, n) => mondayRemoval(n + 1, "archive_pulse", ITEM(1), new Date(Date.parse("2026-01-19T06:00:00Z") + n * 1000).toISOString()));
    const mock = mondayDocMock(data);
    const recent: MondayCursor = { ...cursorAt("incremental", "done"), boards: [], nextFrom: "2026-01-19T00:00:00.000Z" };
    const batches = await collect(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(recent) }));
    expect(mock.operations.filter((o) => o.name === "ActivityLogs").map((o) => [o.variables.board, o.variables.page])).toEqual([
      [[BOARDS[0]], 1],
      [[BOARDS[0]], 2],
      [[BOARDS[1]], 1],
    ]);
    expect(batches.flatMap((b) => b.events as { type: string }[]).filter((e) => e.type === "work.item_deleted")).toHaveLength(MONDAY_PAGE_SIZES.activity + 1);
  });

  it("reads a board again from the start when monday.com says its items cursor expired, and stops if it keeps expiring", async () => {
    let clock = Date.parse(RECEIVED);
    const data = account({ now: () => new Date(clock) });
    mondayItem.reset();
    data.items = mondayItem.many(MONDAY_PAGE_SIZES.items + 2);
    const mock = mondayDocMock(data);
    const c = connector(mock);
    const seen: string[] = [];
    let batches = 0;
    for await (const batch of c.historicalImport({ organizationId: TEST_ORG, cursor: null })) {
      seen.push(...(batch.events as { idempotencyKey: string }[]).map((e) => e.idempotencyKey));
      // After the first page of items, the cursor sits for over an hour.
      if (++batches === 2) clock += 61 * 60_000;
    }
    expect(ops(mock)).toEqual(["Boards", "ItemsFirst", "ItemsNext", "ItemsFirst", "ItemsNext", "ItemsFirst", "Updates"]);
    // Every item arrives; the first page twice, which the pipeline stores once.
    expect(new Set(seen.filter((k) => k.startsWith("monday:item:"))).size).toBe(MONDAY_PAGE_SIZES.items + 2);

    // A cursor that expires every time stops the sync rather than looping.
    let always = Date.parse(RECEIVED);
    const stuck = mondayDocMock({ ...data, now: () => new Date((always += 61 * 60_000)) });
    await expect(collect(connector(stuck).historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toBeInstanceOf(MondayCursorExpiredError);
  });

  it("doesn't trust a saved items cursor older than 55 minutes, reading that board again", async () => {
    const mock = mondayDocMock(account());
    const resumeAt = (age: number): MondayCursor => ({
      ...cursorAt("historical", "items"),
      items: Buffer.from(JSON.stringify({ b: BOARDS[0], o: 1, f: null, t: Date.parse(RECEIVED) })).toString("base64url"),
      itemsAt: new Date(Date.parse(RECEIVED) - age).toISOString(),
    });
    const take = async (cursor: MondayCursor) => {
      const it = connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(cursor) })[Symbol.asyncIterator]();
      await it.next();
      return mock.operations.at(-1)!.name;
    };
    expect(await take(resumeAt(MONDAY_CURSOR_MAX_AGE_MS))).toBe("ItemsNext");
    expect(await take(resumeAt(MONDAY_CURSOR_MAX_AGE_MS + 1))).toBe("ItemsFirst");
    expect(MONDAY_CURSOR_MAX_AGE_MS).toBe(55 * 60_000);
  });

  it("stops at the daily limit with the checkpoint where it was, and carries on from there", async () => {
    const mock = mondayDocMock(account());
    const { memory, pipeline } = testPipeline();
    let calls = 0;
    let limited = true;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (++calls >= 3 && limited) return graphql(429, { errors: [{ message: "Daily limit exceeded", extensions: { code: "DAILY_LIMIT_EXCEEDED" } }] });
      return mock.fetch(input as string, init);
    };
    const stopped = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: async () => {} }).catch((e: unknown) => e);
    expect(stopped).toMatchObject({ name: "MondayApiError", code: "DAILY_LIMIT_EXCEEDED" });
    expect(parseMondayCursor(await memory.getCheckpoint(TEST_ORG, "monday", "historical"))).toMatchObject({ step: "items", boards: [BOARDS[1]] });
    limited = false;
    const before = mock.operations.length;
    const resumed = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.operations.slice(before).map((o) => o.name)).toEqual(["ItemsFirst", "Updates"]);
    expect(resumed.batches).toBe(2);
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: MondayCursor = { ...cursorAt("incremental", "items"), items: "abc", itemsAt: RECEIVED, window: ["TODAY", "YESTERDAY"] };
    expect(parseMondayCursor(JSON.stringify(good))).toEqual(good);
    for (const bad of [
      { ...good, pass: "full" },
      { ...good, step: "users" },
      { ...good, boardsPage: 0 },
      { ...good, page: 1.5 },
      { ...good, boards: ["1 OR 1"] },
      { ...good, boards: [1] },
      { ...good, boards: "1" },
      { ...good, boards: [] },
      { ...good, boards: Array.from({ length: 26 }, (_, n) => String(n + 1)) },
      { ...good, lastBoardsPage: "yes" },
      { ...good, items: 'x" } mutation {' },
      { ...good, items: null },
      { ...good, itemsAt: "yesterday" },
      { ...good, since: "2026-01-19" },
      { ...good, until: "2026-13-45T00:00:00Z" },
      { ...good, nextFrom: "Mon, 19 Jan 2026 00:00:00 GMT" },
      { ...good, window: ["PAST_DATETIME"] },
      { ...good, window: ["YESTERDAY", "TODAY"] },
      { ...good, window: undefined },
      null,
      [],
    ]) {
      expect(() => parseMondayCursor(JSON.stringify(bad)), JSON.stringify(bad)).toThrow("monday.com checkpoint is not in the expected shape");
    }
    expect(parseMondayCursor(null)).toBeNull();
  });

  it("reads OAuth scopes as monday.com writes them, and nothing for a personal token", () => {
    expect(parseMondayScopes("boards:read updates:read")).toEqual(["boards:read", "updates:read"]);
    expect(parseMondayScopes("boards:read,updates:read")).toEqual(["boards:read", "updates:read"]);
    expect(parseMondayScopes(" ")).toBeUndefined();
    expect(parseMondayScopes(undefined)).toBeUndefined();
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const c = connector(mondayDocMock(account()));
    expect(c.writes).toBe(MONDAY_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => a.action)).toEqual(["create_item", "update_item"]);
  });
});

describe("monday.com webhooks", () => {
  const SECRET = ["signing", "test", "0".repeat(32)].join("-");
  const NOW_S = Date.parse(RECEIVED) / 1000;
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sign = (claims: object, secret = SECRET, header: object = { alg: "HS256", typ: "JWT" }) => {
    const unsigned = `${part(header)}.${part(claims)}`;
    return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  };
  const claims = { accountId: 12345, userId: Number(MONDAY_TEST_USER), aud: "https://instance.example.test/webhooks/monday", iat: NOW_S - 10, exp: NOW_S + 290, shortLivedToken: ["short", "0".repeat(20)].join("-") };

  it("accepts a token signed with the app's Signing Secret, and gives back the account but never the short-lived token", () => {
    const token = sign(claims);
    const check = verifyMondayWebhook(SECRET, token, { nowSeconds: NOW_S });
    expect(check).toEqual({ ok: true, accountId: "12345", userId: MONDAY_TEST_USER });
    expect(JSON.stringify(check)).not.toContain(claims.shortLivedToken);
    expect(verifyMondayWebhook(SECRET, `Bearer ${token}`, { nowSeconds: NOW_S }).ok).toBe(true);
    expect(verifyMondayWebhook(SECRET, token, { nowSeconds: NOW_S, audience: claims.aud }).ok).toBe(true);
  });

  it("rejects tampered, wrongly keyed, unsigned, other-algorithm and malformed tokens", () => {
    const token = sign(claims);
    const [h, p, s] = token.split(".") as [string, string, string];
    expect(verifyMondayWebhook(SECRET, `${h}.${part({ ...claims, accountId: 99999 })}.${s}`, { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyMondayWebhook(SECRET, `${h}.${p}.${s[0] === "A" ? "B" : "A"}${s.slice(1)}`, { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyMondayWebhook(SECRET, `${h}.${tamper(p)}.${s}`, { nowSeconds: NOW_S })).toMatchObject({ ok: false });
    expect(verifyMondayWebhook(`${SECRET}x`, token, { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyMondayWebhook(SECRET, `${h}.${p}.`, { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyMondayWebhook(SECRET, `${part({ alg: "none" })}.${p}.${s}`, { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyMondayWebhook(SECRET, sign(claims, SECRET, { alg: "HS512" }), { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyMondayWebhook(SECRET, sign(claims, SECRET, { alg: "RS256" }), { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyMondayWebhook(SECRET, "a.b", { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyMondayWebhook(SECRET, "a.b.c.d", { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyMondayWebhook(SECRET, `${part([1])}.${p}.${s}`, { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyMondayWebhook(SECRET, `%%%.${p}.${s}`, { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyMondayWebhook(SECRET, undefined, { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "missing" });
    expect(verifyMondayWebhook("", token, { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "missing" });
    expect(verifyMondayWebhook(SECRET, token, { nowSeconds: NOW_S, audience: "https://other.example.test/hook" })).toEqual({ ok: false, reason: "audience" });
  });

  it("refuses a replayed delivery once its token has expired, and one without exp at all", () => {
    const token = sign(claims);
    expect(verifyMondayWebhook(SECRET, token, { nowSeconds: claims.exp + 30 }).ok).toBe(true);
    expect(verifyMondayWebhook(SECRET, token, { nowSeconds: claims.exp + 31 })).toEqual({ ok: false, reason: "expired" });
    expect(verifyMondayWebhook(SECRET, token, { nowSeconds: claims.exp + 3600, leewaySeconds: 0 })).toEqual({ ok: false, reason: "expired" });
    const { exp: _exp, ...noExp } = claims;
    expect(verifyMondayWebhook(SECRET, sign(noExp), { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "expired" });
    expect(verifyMondayWebhook(SECRET, sign({ ...claims, exp: "never" }), { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "expired" });
    expect(verifyMondayWebhook(SECRET, sign({ ...claims, iat: NOW_S + 600 }), { nowSeconds: NOW_S })).toEqual({ ok: false, reason: "expired" });
    // Within its lifetime, the clock defaults to now.
    expect(verifyMondayWebhook(SECRET, sign({ ...claims, iat: undefined, exp: Math.floor(Date.now() / 1000) + 60 })).ok).toBe(true);
  });

  it("echoes the creation challenge, and nothing else", () => {
    expect(mondayWebhookChallenge({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" })).toEqual({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
    for (const other of [{ event: { type: "create_pulse" } }, { challenge: "x", event: {} }, { challenge: 5 }, { challenge: "<script>" }, { challenge: "" }, null, [], "challenge"]) {
      expect(mondayWebhookChallenge(other), JSON.stringify(other)).toBeNull();
    }
  });

  it("lists what a delivery says changed, without the item's name, values or user", () => {
    const delivery = { event: { userId: Number(MONDAY_TEST_USER), boardId: Number(BOARDS[0]), pulseId: Number(ITEM(1)), pulseName: "Test Customer 1 ring", type: "create_pulse", triggerTime: "2026-01-19T09:07:28.210Z", subscriptionId: 73, triggerUuid: "b5ed2e17c530f43668de130142445cba" } };
    expect(mondayWebhookChanges(delivery)).toEqual([{ type: "create_pulse", boardId: BOARDS[0], itemId: ITEM(1), time: "2026-01-19T09:07:28.210Z" }]);
    expect(mondayWebhookChanges({ event: { ...delivery.event, pulseId: undefined, triggerTime: "soon" } })).toEqual([{ type: "create_pulse", boardId: BOARDS[0], itemId: undefined, time: undefined }]);
    for (const odd of [null, {}, { event: null }, { event: { ...delivery.event, type: "Drop Table" } }, { event: { ...delivery.event, boardId: "../1" } }]) expect(mondayWebhookChanges(odd)).toEqual([]);
  });

  it("treats a replayed delivery as a prompt to sync, which stores nothing twice", async () => {
    const mock = mondayDocMock(account());
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    await memory.saveCheckpoint(TEST_ORG, "monday", "incremental", JSON.stringify({ ...parseMondayCursor(first.cursor)!, nextFrom: "2026-01-18T00:00:00.000Z" }));
    const again = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(first.ingested).toBeGreaterThan(0);
    expect(again.ingested).toBe(0);
  });
});

/** A cursor at a step, with the other fields set to a plausible pass. */
function cursorAt(pass: MondayCursor["pass"], step: MondayCursor["step"]): MondayCursor {
  return {
    pass,
    step,
    boardsPage: 1,
    boards: [BOARDS[0]!, BOARDS[1]!],
    lastBoardsPage: true,
    items: null,
    itemsAt: null,
    page: 1,
    since: "2026-01-19T00:00:00.000Z",
    until: RECEIVED,
    nextFrom: "2026-01-19T23:55:00.000Z",
    window: null,
  };
}
