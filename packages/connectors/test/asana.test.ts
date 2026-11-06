import { describe, expect, it } from "vitest";
import { runSync } from "@karatos/core";
import {
  TEST_ORG,
  asanaDocMock,
  asanaPick,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  docMockFetch,
  testPipeline,
  type AsanaMockData,
  type AsanaMockTask,
} from "@karatos/connector-testkit";
import {
  ASANA_API,
  ASANA_FIELDS,
  ASANA_OVERLAP_MS,
  ASANA_PAGE_SIZE,
  ASANA_SAFE_FIELD_TYPES,
  ASANA_WRITES,
  AsanaApiError,
  AsanaConfigError,
  AsanaOffsetExpiredError,
  asanaClient,
  asanaCommentEvents,
  asanaConnector,
  asanaDay,
  asanaFieldValues,
  asanaProjectEvents,
  asanaRef,
  asanaTaskEvents,
  asanaTime,
  parseAsanaCursor,
  type AsanaCursor,
  type AsanaOptions,
} from "../src/index.js";

const TOKEN = ["2", "x".repeat(40)].join("/");
const NOW = new Date("2026-11-03T12:00:00.000Z");
const RECEIVED = NOW.toISOString();
const noSleep = async () => {};

function task(gid: string, project: string, modified: string, extra: Partial<AsanaMockTask> = {}): AsanaMockTask {
  return {
    gid,
    memberships: [{ project: { gid: project }, section: { gid: "3001" } }],
    name: `Test Customer ${gid} ring resize`,
    notes: `Call customer${gid}@example.test when ready`,
    resource_subtype: "default_task",
    created_at: "2026-01-01T09:00:00.000Z",
    modified_at: modified,
    completed: false,
    completed_at: null,
    due_on: "2026-11-10",
    due_at: null,
    start_on: null,
    assignee: { gid: "9001" },
    parent: null,
    custom_fields: [
      { gid: "5001", name: "Stage", resource_subtype: "enum", enum_value: { gid: "5101", name: "At the bench" }, display_value: "At the bench" },
      { gid: "5002", name: "Quote", resource_subtype: "number", number_value: 250, display_value: "250" },
      { gid: "5003", name: "Customer phone", resource_subtype: "text", text_value: "+1 212 555 0101", display_value: "+1 212 555 0101" },
    ],
    ...extra,
  };
}

/**
 * Against NOW (2026-11-03 noon): the history window starts 2021-11-03. One
 * workspace with two projects; the old task is outside the window and the
 * one with an unreadable time is dead-lettered.
 */
function account(extra: Partial<AsanaMockData> = {}): AsanaMockData {
  return {
    token: TOKEN,
    workspaces: ["1001"],
    projects: [
      {
        gid: "2001",
        workspace: "1001",
        name: "Repairs",
        archived: false,
        created_at: "2025-01-01T00:00:00.000Z",
        modified_at: "2026-10-30T10:00:00.000Z",
        owner: { gid: "9001" },
        team: { gid: "8001" },
        notes: "Project notes that are never read",
        custom_field_settings: [
          { custom_field: { gid: "5001", name: "Stage", resource_subtype: "enum" } },
          { custom_field: { gid: "5002", name: "Quote", resource_subtype: "number" } },
        ],
      },
      { gid: "2002", workspace: "1001", name: "Custom orders", archived: true, created_at: "2024-01-01T00:00:00.000Z", modified_at: "2026-06-01T00:00:00.000Z" },
      { gid: "2009", workspace: "1009", name: "Other workspace", archived: false, created_at: "2024-01-01T00:00:00.000Z", modified_at: "2026-06-01T00:00:00.000Z" },
    ],
    sections: { "2001": [{ gid: "3001", name: "At the bench" }, { gid: "3002", name: "Ready for pickup" }] },
    tasks: [
      task("4001", "2001", "2026-11-01T10:00:00.000Z"),
      task("4002", "2001", "2026-10-01T10:00:00.000Z", { completed: true, completed_at: "2026-10-01T10:00:00.000Z" }),
      task("4003", "2001", "2020-01-01T10:00:00.000Z"),
      task("4004", "2002", "2026-09-01T10:00:00.000Z", { resource_subtype: "milestone" }),
      task("4005", "2002", "2026-09-01 10:00:00Z"),
    ],
    stories: {
      "4001": [
        { gid: "6001", resource_subtype: "comment_added", created_at: "2026-11-01T11:00:00.000Z", created_by: { gid: "9002" }, text: "Customer called about the ring" },
        { gid: "6002", resource_subtype: "section_changed", created_at: "2026-11-01T12:00:00.000Z", created_by: { gid: "9001" }, text: "moved this task" },
      ],
    },
    ...extra,
  };
}

function connector(data: AsanaMockData, options: Partial<AsanaOptions> = {}) {
  const fetch = docMockFetch(asanaDocMock(data));
  const c = asanaConnector({ token: TOKEN, now: () => NOW, fetch, sleep: noSleep, ...options });
  return { c, fetch };
}

/** A fetch that answers each request from a list, recording what was sent. */
function scripted(responses: Response[]) {
  const sent: URL[] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    sent.push(url);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const PAGE = (data: unknown[], next: string | null = null) => ({ data, next_page: next && { offset: next, path: `/x?offset=${next}`, uri: `https://evil.example.test/x?offset=${next}` } });
const paths = (fetch: { calls: { url: string }[] }) => fetch.calls.map((call) => new URL(call.url).pathname.replace("/api/1.0", ""));

async function batches(iterable: AsyncIterable<{ events: unknown[]; cursor: string | null }>) {
  const out: { events: { type: string; payload: Record<string, unknown> }[]; cursor: string | null }[] = [];
  for await (const b of iterable) out.push(b as (typeof out)[number]);
  return out;
}

describe("asanaTime and asanaDay", () => {
  it("reads Asana's times as UTC and its days as calendar days", () => {
    expect(asanaTime("2026-11-01T10:00:00.000Z")).toBe("2026-11-01T10:00:00.000Z");
    expect(asanaTime("2026-11-01T10:00:00.123456Z")).toBe("2026-11-01T10:00:00.123Z");
    expect(asanaTime(" 2026-11-01T10:00:00-05:00 ")).toBe("2026-11-01T15:00:00.000Z");
    expect(asanaTime("2026-11-01T10:00Z")).toBe("2026-11-01T10:00:00.000Z");
    for (const bad of ["2026-11-01", "2026-11-01T10:00:00", "yesterday", "2026-13-01T10:00:00Z", 1_700_000_000, null, undefined]) expect(asanaTime(bad), String(bad)).toBeUndefined();
    expect(asanaDay("2026-11-10")).toBe("2026-11-10");
    for (const bad of ["2026-02-30", "2026-11", "2026-11-10T00:00:00Z", "11/10/2026", " 2026-11-10", 20261110, null]) expect(asanaDay(bad), String(bad)).toBeUndefined();
  });
});

describe("asanaFieldValues", () => {
  it("keeps number, select, multi select, date and people fields, and nothing that holds text", () => {
    expect(ASANA_SAFE_FIELD_TYPES).toEqual(["number", "enum", "multi_enum", "date", "people"]);
    const values = asanaFieldValues([
      { gid: "1", resource_subtype: "number", number_value: 12.5 },
      { gid: "2", resource_subtype: "number", number_value: null },
      { gid: "3", resource_subtype: "number", number_value: Number.POSITIVE_INFINITY },
      { gid: "4", resource_subtype: "enum", enum_value: { gid: "41", name: " Rush " } },
      { gid: "5", resource_subtype: "enum", enum_value: null },
      { gid: "6", resource_subtype: "multi_enum", multi_enum_values: [{ gid: "61", name: "Gold" }, { gid: "x", name: "" }, null, "bad"] },
      { gid: "7", resource_subtype: "date", date_value: { date: "2026-11-10", date_time: "2026-11-10T15:00:00.000Z" } },
      { gid: "8", resource_subtype: "date", date_value: { date: "2026-11-31" } },
      { gid: "9", resource_subtype: "people", people_value: [{ gid: "9001" }, { gid: "not-a-gid" }] },
      { gid: "10", resource_subtype: "text", text_value: "Test Customer", display_value: "Test Customer" },
      { gid: "11", resource_subtype: "formula", display_value: "Test Customer" },
      { gid: "x12", resource_subtype: "number", number_value: 1 },
      { resource_subtype: "number", number_value: 1 },
      { gid: "13" },
    ]);
    expect(values).toEqual({
      "1": { type: "number", number: 12.5 },
      "2": { type: "number", number: null },
      "3": { type: "number", number: null },
      "4": { type: "enum", label: "Rush", id: "41" },
      "5": { type: "enum", label: null, id: null },
      "6": { type: "multi_enum", labels: ["Gold"], ids: ["61"] },
      "7": { type: "date", date: "2026-11-10", at: "2026-11-10T15:00:00.000Z" },
      "8": { type: "date", date: null },
      "9": { type: "people", people: ["asana:user:9001"] },
    });
    expect(asanaFieldValues("nope")).toEqual({});
    expect(asanaFieldValues([{ gid: "4", resource_subtype: "enum", enum_value: { gid: "41", name: "x".repeat(150) } }])["4"]!.label).toHaveLength(100);
  });
});

describe("the Asana normalizer", () => {
  it("makes a project a board, with its sections as groups and its custom fields as columns", () => {
    const [e] = asanaProjectEvents(
      {
        gid: "2001",
        name: " Repairs ",
        archived: false,
        created_at: "2025-01-01T00:00:00.000Z",
        modified_at: "2026-10-30T10:00:00.000Z",
        start_on: "2026-01-01",
        due_on: "2026-12-31",
        owner: { gid: "9001" },
        team: { gid: "8001" },
        custom_field_settings: [{ custom_field: { gid: "5001", name: "Stage", resource_subtype: "enum" } }, { custom_field: { gid: "bad" } }, {}],
      },
      [{ gid: "3001", name: "At the bench" }, { gid: "x" }],
      RECEIVED,
    );
    expect(e).toEqual({
      id: `asana_project:2001:${Date.parse("2026-10-30T10:00:00.000Z")}`,
      type: "work.board_updated",
      occurredAt: "2026-10-30T10:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `asana:project:2001:${Date.parse("2026-10-30T10:00:00.000Z")}`,
      payload: {
        boardId: "asana:project:2001",
        name: "Repairs",
        state: "active",
        createdAt: "2025-01-01T00:00:00.000Z",
        startOn: "2026-01-01",
        dueOn: "2026-12-31",
        ownerId: "asana:user:9001",
        teamId: "asana:team:8001",
        columns: [{ id: "5001", type: "enum", title: "Stage" }],
        groups: [{ id: "3001", title: "At the bench" }],
      },
    });
    const [archived] = asanaProjectEvents({ gid: "2002", archived: true, modified_at: "bad" }, [], RECEIVED);
    expect(archived).toMatchObject({ occurredAt: undefined, idempotencyKey: "asana:project:2002:0", payload: { name: "Project 2002", state: "archived", columns: [], groups: [] } });
    expect(archived!.payload).not.toHaveProperty("ownerId");
    const odd = asanaProjectEvents({ gid: "2003", archived: "yes", name: "x".repeat(250), modified_at: "2026-10-30T10:00:00Z" }, [], RECEIVED)[0]!;
    expect(odd.payload).toMatchObject({ state: "active", name: "x".repeat(200) });
    expect(asanaProjectEvents({ gid: "../2001" }, [], RECEIVED)).toEqual([]);
    expect(asanaProjectEvents(null as unknown as Record<string, unknown>, [], RECEIVED)).toEqual([]);
  });

  it("makes a task an item, keeping its section in this project and never its name or notes", () => {
    const raw = task("4001", "2001", "2026-11-01T10:00:00.000Z", {
      memberships: [{ project: { gid: "2999" }, section: { gid: "3999" } }, { project: { gid: "2001" }, section: { gid: "3001" } }],
      due_at: "2026-11-10T15:00:00.000Z",
      start_on: "2026-11-02",
      parent: { gid: "4000" },
    });
    const [e] = asanaTaskEvents(raw as unknown as Record<string, unknown>, "2001", RECEIVED);
    expect(e).toEqual({
      id: `asana_task:4001:${Date.parse("2026-11-01T10:00:00.000Z")}`,
      type: "work.item_updated",
      occurredAt: "2026-11-01T10:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `asana:task:4001:${Date.parse("2026-11-01T10:00:00.000Z")}`,
      payload: {
        itemId: "asana:task:4001",
        boardId: "asana:project:2001",
        groupId: "3001",
        kind: "default_task",
        state: "active",
        completed: false,
        createdAt: "2026-01-01T09:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
        startOn: "2026-11-02",
        dueOn: "2026-11-10",
        dueAt: "2026-11-10T15:00:00.000Z",
        assigneeId: "asana:user:9001",
        parentId: "asana:task:4000",
        columns: { "5001": { type: "enum", label: "At the bench", id: "5101" }, "5002": { type: "number", number: 250 } },
      },
    });
    expect(JSON.stringify(e)).not.toMatch(/Test Customer|example\.test|ring resize|555/);
  });

  it("keeps when a task was finished only once it is", () => {
    const done = asanaTaskEvents({ gid: "1", modified_at: "2026-11-01T10:00:00Z", completed: true, completed_at: "2026-11-01T09:00:00Z" }, "2", RECEIVED)[0]!;
    expect(done.payload).toMatchObject({ completed: true, completedAt: "2026-11-01T09:00:00.000Z" });
    const reopened = asanaTaskEvents({ gid: "1", modified_at: "2026-11-01T10:00:00Z", completed: false, completed_at: "2026-11-01T09:00:00Z" }, "2", RECEIVED)[0]!;
    expect(reopened.payload).toMatchObject({ completed: false });
    expect(reopened.payload).not.toHaveProperty("completedAt");
    const odd = asanaTaskEvents({ gid: "1", modified_at: "2026-11-01T10:00:00Z", completed: "yes" }, "2", RECEIVED)[0]!;
    expect(odd.payload.completed).toBe(false);
  });

  it("takes a due day from the due time when only that is set, and leaves out what doesn't read", () => {
    const e = asanaTaskEvents({ gid: "1", modified_at: "2026-11-01T10:00:00Z", due_at: "2026-11-10T23:30:00-05:00", memberships: "x", assignee: { gid: "bad" } }, "2", RECEIVED)[0]!;
    expect(e.payload).toMatchObject({ dueOn: "2026-11-11", dueAt: "2026-11-11T04:30:00.000Z", columns: {} });
    for (const key of ["groupId", "assigneeId", "parentId", "startOn", "kind", "createdAt"]) expect(e.payload, key).not.toHaveProperty(key);
  });

  it("dead-letters a task whose time doesn't read and drops one with no id", () => {
    const [e] = asanaTaskEvents({ gid: "4005", modified_at: "yesterday" }, "2002", RECEIVED);
    expect(e).toMatchObject({ occurredAt: undefined, idempotencyKey: "asana:task:4005:0" });
    expect(asanaTaskEvents({ modified_at: "2026-11-01T10:00:00Z" }, "2002", RECEIVED)).toEqual([]);
    expect(asanaTaskEvents({ gid: "4005", modified_at: "2026-11-01T10:00:00Z" }, "../2002", RECEIVED)).toEqual([]);
    expect(asanaTaskEvents({ gid: "a b", modified_at: "2026-11-01T10:00:00Z" }, "2002", RECEIVED)).toEqual([]);
  });

  it("keeps who commented and when, never what they wrote, and drops other stories", () => {
    const [e] = asanaCommentEvents({ gid: "6001", resource_subtype: "comment_added", created_at: "2026-11-01T11:00:00.000Z", created_by: { gid: "9002" }, text: "Customer called" }, "4001", RECEIVED);
    expect(e).toEqual({
      id: `asana_comment:6001:${Date.parse("2026-11-01T11:00:00.000Z")}`,
      type: "work.comment_updated",
      occurredAt: "2026-11-01T11:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `asana:comment:6001:${Date.parse("2026-11-01T11:00:00.000Z")}`,
      payload: { commentId: "asana:story:6001", itemId: "asana:task:4001", creatorId: "asana:user:9002", createdAt: "2026-11-01T11:00:00.000Z", updatedAt: "2026-11-01T11:00:00.000Z" },
    });
    expect(asanaCommentEvents({ gid: "6002", resource_subtype: "section_changed", created_at: "2026-11-01T11:00:00Z" }, "4001", RECEIVED)).toEqual([]);
    expect(asanaCommentEvents({ resource_subtype: "comment_added", created_at: "2026-11-01T11:00:00Z" }, "4001", RECEIVED)).toEqual([]);
    expect(asanaCommentEvents({ gid: "6001", resource_subtype: "comment_added" }, "x", RECEIVED)).toEqual([]);
    const anonymous = asanaCommentEvents({ gid: "6003", resource_subtype: "comment_added", created_at: "soon", created_by: null }, "4001", RECEIVED)[0]!;
    expect(anonymous).toMatchObject({ occurredAt: undefined, idempotencyKey: "asana:comment:6003:0" });
    expect(anonymous.payload).not.toHaveProperty("creatorId");
    expect(asanaRef("task", "1")).toBe("asana:task:1");
  });

  it("makes ids that only hold safe characters", () => {
    const [e] = asanaTaskEvents({ gid: "1", modified_at: "2026-11-01T10:00:00Z" }, "2", RECEIVED);
    expect(e!.id).toMatch(/^asana_[A-Za-z0-9_.:-]+$/);
  });
});

describe("the Asana client", () => {
  it("checks the token's shape before sending anything", () => {
    for (const bad of ["", "short", `${"x".repeat(30)} spaced`, `${"x".repeat(30)}\n`]) expect(() => asanaClient({ token: bad }), JSON.stringify(bad)).toThrow(AsanaConfigError);
    expect(() => asanaClient({ token: "x".repeat(4097) })).toThrow(/ASANA_ACCESS_TOKEN/);
    expect(() => asanaClient({ token: "x".repeat(20) })).not.toThrow();
  });

  it("names every field it reads, and none of them is a name, notes or text", () => {
    const all = Object.values(ASANA_FIELDS).flat();
    expect(all.filter((f) => /(^|\.)(notes|html_notes|text|html_text|text_value|display_value)$/.test(f))).toEqual([]);
    expect(ASANA_FIELDS.tasks).not.toContain("name");
    expect(ASANA_FIELDS.stories).not.toContain("text");
  });

  it("sends only GETs to Asana's own address, with the token as a bearer", async () => {
    const { fetch, sent } = scripted([json(200, { data: { workspaces: [{ gid: "1001" }, { gid: "bad" }, null] } })]);
    const calls: RequestInit[] = [];
    const recording = (async (url: URL, init: RequestInit) => {
      calls.push(init);
      return fetch(url, init);
    }) as typeof globalThis.fetch;
    expect(await asanaClient({ token: TOKEN, fetch: recording }).workspaces()).toEqual(["1001"]);
    expect(sent[0]!.toString()).toBe(`${ASANA_API}/users/me?opt_fields=workspaces.gid`);
    expect(calls[0]).toMatchObject({ method: "GET", headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" } });
  });

  it("builds each list request itself and follows pages by offset, never by the URI Asana sends", async () => {
    const { fetch, sent } = scripted([json(200, PAGE([{ gid: "4001" }, "junk"], "eyJ0.abc_-=")), json(200, PAGE([]))]);
    const client = asanaClient({ token: TOKEN, fetch });
    const first = await client.tasks("2001", "2026-11-01T00:00:00.000Z");
    expect(first).toEqual({ data: [{ gid: "4001" }, {}], next: "eyJ0.abc_-=" });
    await client.tasks("2001", null, first.next);
    expect(sent.map((u) => u.origin + u.pathname)).toEqual([`${ASANA_API}/tasks`, `${ASANA_API}/tasks`]);
    expect(Object.fromEntries(sent[0]!.searchParams)).toEqual({ project: "2001", modified_since: "2026-11-01T00:00:00.000Z", limit: String(ASANA_PAGE_SIZE), opt_fields: ASANA_FIELDS.tasks.join(",") });
    expect(Object.fromEntries(sent[1]!.searchParams)).toEqual({ project: "2001", limit: "100", opt_fields: ASANA_FIELDS.tasks.join(","), offset: "eyJ0.abc_-=" });
  });

  it("asks for projects, sections and stories at their documented paths", async () => {
    const { fetch, sent } = scripted([json(200, PAGE([])), json(200, PAGE([])), json(200, PAGE([]))]);
    const client = asanaClient({ token: TOKEN, fetch });
    await client.projects("1001");
    await client.sections("2001");
    await client.stories("4001");
    expect(sent.map((u) => u.pathname)).toEqual(["/api/1.0/projects", "/api/1.0/projects/2001/sections", "/api/1.0/tasks/4001/stories"]);
    expect(sent[0]!.searchParams.get("workspace")).toBe("1001");
    expect(sent[1]!.searchParams.get("opt_fields")).toBe("name");
    expect(sent[2]!.searchParams.get("opt_fields")).toBe("resource_subtype,created_at,created_by.gid");
  });

  it("turns down ids, times and offsets that aren't Asana's before sending them", async () => {
    const { fetch, sent } = scripted([]);
    const client = asanaClient({ token: TOKEN, fetch });
    await expect(client.projects("1001/../x")).rejects.toThrow(/workspace id/);
    await expect(client.sections("2001?x=1")).rejects.toThrow(/project id/);
    await expect(client.tasks("abc", null)).rejects.toThrow(/project id/);
    await expect(client.stories("")).rejects.toThrow(/task id/);
    await expect(client.tasks("2001", "2026-11-01")).rejects.toThrow(/modified_since/);
    await expect(client.tasks("2001", null, "a&b=c")).rejects.toThrow(/offset/);
    await expect(client.tasks("2001", null, "x".repeat(1025))).rejects.toThrow(/offset/);
    expect(sent).toEqual([]);
  });

  it("turns down a reply that isn't a page", async () => {
    const cases: [Response, RegExp][] = [
      [json(200, PAGE([], "bad offset")), /page offset/],
      [json(200, { data: [], next_page: { offset: 7 } }), /page offset/],
      [json(200, { data: "x" }), /without the data list/],
      [json(200, []), /isn't a JSON object/],
      [new Response("not json", { status: 200 }), /isn't a JSON object/],
      [json(200, { data: {} }), /without a list of workspaces/],
    ];
    for (const [i, [response, error]] of cases.entries()) {
      const { fetch } = scripted([response]);
      const client = asanaClient({ token: TOKEN, fetch });
      await expect(i === cases.length - 1 ? client.workspaces() : client.tasks("2001", null), String(i)).rejects.toThrow(error);
    }
    const { fetch } = scripted([json(200, { data: [], next_page: null })]);
    expect(await asanaClient({ token: TOKEN, fetch }).projects("1001")).toEqual({ data: [], next: null });
  });

  it("says what to fix for each refusal, without the token", async () => {
    const cases: [number, RegExp, typeof AsanaApiError][] = [
      [401, /turned down the token: check ASANA_ACCESS_TOKEN/, AsanaApiError],
      [402, /paid plan to read a project's tasks/, AsanaApiError],
      [403, /isn't allowed to read a project's tasks/, AsanaApiError],
      [404, /couldn't find a project's tasks/, AsanaApiError],
      [400, /HTTP 400 for a project's tasks/, AsanaApiError],
      [500, /HTTP 500 for a project's tasks/, AsanaApiError],
    ];
    for (const [status, message, type] of cases) {
      const { fetch } = scripted([json(status, { errors: [{ message: "no" }] })]);
      const error = await asanaClient({ token: TOKEN, fetch }).tasks("2001", null).catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(type);
      expect(error, String(status)).not.toBeInstanceOf(AsanaOffsetExpiredError);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain(TOKEN);
      expect((error as AsanaApiError).status).toBe(status);
    }
  });

  it("reads a 400 to a request carrying an offset as an expired offset", async () => {
    const { fetch } = scripted([json(400, { errors: [{ message: "offset: Your pagination token has expired." }] })]);
    const error = await asanaClient({ token: TOKEN, fetch }).projects("1001", "offset-100").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AsanaOffsetExpiredError);
    expect(error).toMatchObject({ status: 400, name: "AsanaOffsetExpiredError", message: "Asana no longer accepts the saved page offset for projects" });
  });

  it("waits out a 429 for Retry-After seconds, up to a minute, then gives up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const limited = (after?: string) => json(429, {}, after === undefined ? {} : { "Retry-After": after });
    const { fetch } = scripted([limited("5"), limited("600"), limited("0"), json(200, PAGE([]))]);
    await asanaClient({ token: TOKEN, fetch, sleep }).projects("1001");
    expect(waits).toEqual([5000, 60_000, 1000]);

    waits.length = 0;
    const second = scripted([limited(), limited("soon"), limited(" 2 "), limited("1")]);
    const error = await asanaClient({ token: TOKEN, fetch: second.fetch, sleep }).projects("1001").catch((e: unknown) => e);
    expect(waits).toEqual([1000, 2000, 2000]);
    expect(error).toMatchObject({ status: 429, message: "Asana answered HTTP 429 for projects" });
    expect(second.sent).toHaveLength(4);

    const none = scripted([limited("1")]);
    await expect(asanaClient({ token: TOKEN, fetch: none.fetch, sleep, rateLimitRetries: 0 }).projects("1001")).rejects.toMatchObject({ status: 429 });
  });
});

describe("parseAsanaCursor", () => {
  const good: AsanaCursor = { pass: "incremental", workspaces: ["1001"], listed: true, projectsOffset: "offset-100", projects: ["2001", "2002"], tasksOffset: "offset-100", since: "2026-11-02T12:00:00.000Z", nextFrom: "2026-11-03T11:55:00.000Z" };

  it("reads back a checkpoint it wrote and nothing else", () => {
    expect(parseAsanaCursor(null)).toBeNull();
    expect(parseAsanaCursor(JSON.stringify(good))).toEqual(good);
    expect(parseAsanaCursor(JSON.stringify({ ...good, extra: "dropped" }))).toEqual(good);
    const done = { ...good, workspaces: [], listed: false, projectsOffset: null, projects: [], tasksOffset: null };
    expect(parseAsanaCursor(JSON.stringify(done))).toEqual(done);
    const bad: unknown[] = [
      "not json",
      "null",
      "[]",
      { ...good, pass: "full" },
      { ...good, workspaces: ["x"] },
      { ...good, workspaces: "1001" },
      { ...good, workspaces: Array.from({ length: 101 }, (_, i) => String(i + 1)) },
      { ...good, listed: "yes" },
      { ...good, projectsOffset: "a b" },
      { ...good, projectsOffset: 5 },
      { ...good, projects: ["../1"] },
      { ...good, projects: Array.from({ length: 101 }, (_, i) => String(i + 1)) },
      { ...good, tasksOffset: "" },
      { ...good, since: null },
      { ...good, since: "2026-11-02" },
      { ...good, since: "2026-11-02T12:00:00Z" },
      { ...good, nextFrom: "2026-02-30T12:00:00.000Z" },
      { ...done, projects: ["2001"] },
      { ...done, projectsOffset: "offset-100" },
      { ...done, listed: true },
      { ...good, projects: [], tasksOffset: "offset-100" },
      { ...good, listed: false },
    ];
    for (const raw of bad) expect(() => parseAsanaCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("Asana checkpoint is not in the expected shape");
  });
});

describe("the Asana connector", () => {
  it("imports, replays, resumes and retries the mocked account", async () => {
    // Two projects, three tasks in the window, one comment, and one task dead-lettered.
    const result = await checkConnectorSync({ makeConnector: () => connector(account()).c, expected: { ingested: 6, deadLettered: 1 } });
    expect(result.full).toMatchObject({ ingested: 6, deadLettered: 1 });
    expect(result.resume).not.toBeNull();
  });

  it("reads five years of tasks from every project, archived ones too, with each task's comments", async () => {
    const { c, fetch } = connector(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 6, deadLettered: 1 });
    expect(paths(fetch)).toEqual([
      "/users/me",
      "/projects",
      "/projects/2001/sections",
      "/projects/2002/sections",
      "/tasks",
      "/tasks/4001/stories",
      "/tasks/4002/stories",
      "/tasks",
      "/tasks/4004/stories",
      "/tasks/4005/stories",
    ]);
    const tasks = fetch.calls.filter((call) => new URL(call.url).pathname.endsWith("/tasks")).map((call) => new URL(call.url).searchParams);
    expect(tasks.map((q) => [q.get("project"), q.get("modified_since")])).toEqual([
      ["2001", "2021-11-03T12:00:00.000Z"],
      ["2002", "2021-11-03T12:00:00.000Z"],
    ]);
    const types = memory.events.map((e) => `${e.type} ${String(e.payload.itemId ?? e.payload.boardId)}`).sort();
    expect(types).toEqual([
      "work.board_updated asana:project:2001",
      "work.board_updated asana:project:2002",
      "work.comment_updated asana:task:4001",
      "work.item_updated asana:task:4001",
      "work.item_updated asana:task:4002",
      "work.item_updated asana:task:4004",
    ]);
    expect(memory.events.find((e) => e.payload.boardId === "asana:project:2001" && e.type === "work.board_updated")!.payload.groups).toEqual([
      { id: "3001", title: "At the bench" },
      { id: "3002", title: "Ready for pickup" },
    ]);
    expect(memory.events.find((e) => e.payload.boardId === "asana:project:2002")!.payload.state).toBe("archived");
    expect(memory.deadLetters).toHaveLength(1);
    assertSynthetic(memory.events);
    // The mock returns only what opt_fields names, so nothing a person typed ever arrives.
    const stored = JSON.stringify(memory.events);
    expect(stored).not.toMatch(/Test Customer|example\.test|ring resize|555|Customer called|never read|moved this task/);
  });

  it("never receives a task's name, notes or text fields from the mock", async () => {
    const { fetch } = connector(account());
    const page = await (await fetch(`${ASANA_API}/tasks?project=2001&opt_fields=${ASANA_FIELDS.tasks.join(",")}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    const body = JSON.stringify(page);
    expect(body).not.toMatch(/Test Customer|example\.test|555/);
    expect(asanaPick({ gid: "1", name: "n", a: [{ b: 1, c: 2 }] }, ["a.b"])).toEqual({ gid: "1", a: [{ b: 1 }] });
  });

  it("reads only the workspace it is given", async () => {
    const { c, fetch } = connector(account({ workspaces: ["1001", "1009"] }), { workspace: "1009" });
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(paths(fetch)[0]).toBe("/projects");
    expect(new URL(fetch.calls[0]!.url).searchParams.get("workspace")).toBe("1009");
    expect(memory.events.map((e) => e.payload.boardId)).toEqual(["asana:project:2009"]);
    expect(() => asanaConnector({ token: TOKEN, workspace: "1009 " })).toThrow(/ASANA_WORKSPACE_GID/);
  });

  it("reads every workspace the user belongs to, one after another", async () => {
    const { c } = connector(account({ workspaces: ["1001", "1009"] }));
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(memory.events.filter((e) => e.type === "work.board_updated").map((e) => e.payload.boardId)).toEqual(["asana:project:2001", "asana:project:2002", "asana:project:2009"]);
  });

  it("honors a shorter history window", async () => {
    const { c, fetch } = connector(account(), { historyYears: 1 });
    await runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    const since = fetch.calls.map((call) => new URL(call.url).searchParams.get("modified_since")).filter(Boolean);
    expect(new Set(since)).toEqual(new Set(["2025-11-03T12:00:00.000Z"]));
    expect(() => asanaConnector({ token: TOKEN, historyYears: 0 })).toThrow(/historyYears/);
    expect(() => asanaConnector({ token: TOKEN, incrementalLookbackHours: 1.5 })).toThrow(/incrementalLookbackHours/);
  });

  it("pages through projects, sections, tasks and stories by offset", async () => {
    const data = account({
      pageCap: 1,
      sections: { "2001": [{ gid: "3001", name: "At the bench" }, { gid: "3002", name: "Ready" }] },
      stories: { "4001": [{ gid: "6001", resource_subtype: "comment_added", created_at: "2026-11-01T11:00:00.000Z" }, { gid: "6003", resource_subtype: "comment_added", created_at: "2026-11-01T13:00:00.000Z" }] },
    });
    const { c, fetch } = connector(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 7, deadLettered: 1 });
    const count = (path: string) => paths(fetch).filter((p) => p === path).length;
    expect(count("/projects")).toBe(2);
    expect(count("/projects/2001/sections")).toBe(2);
    expect(count("/tasks")).toBe(4);
    expect(count("/tasks/4001/stories")).toBe(2);
    expect(memory.events.find((e) => e.payload.boardId === "asana:project:2001" && e.type === "work.board_updated")!.payload.groups).toHaveLength(2);
  });

  it("checkpoints each page with the workspace, project and offset it got to", async () => {
    const { c } = connector(account({ pageCap: 1 }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const cursors = out.map((b) => parseAsanaCursor(b.cursor)!);
    expect(cursors.map((k) => [k.projects.join("+"), k.projectsOffset, k.tasksOffset, k.workspaces.length])).toEqual([
      ["2001", "offset-1", null, 1],
      ["2001", "offset-1", "offset-1", 1],
      ["", "offset-1", null, 1],
      ["2002", null, null, 1],
      ["2002", null, "offset-1", 1],
      ["", null, null, 1],
      ["", null, null, 0],
    ]);
    // The first project, its first task with a comment, its second task, the second project, then a task a page.
    expect(out.map((b) => b.events.length)).toEqual([1, 2, 1, 1, 1, 1, 0]);
    expect(cursors.every((k) => k.pass === "historical" && k.since === "2021-11-03T12:00:00.000Z" && k.nextFrom === "2026-11-03T11:55:00.000Z")).toBe(true);
  });

  it("resumes an interrupted import where its checkpoint says, and a finished one reads nothing", async () => {
    const saved: AsanaCursor = { pass: "historical", workspaces: ["1001"], listed: true, projectsOffset: null, projects: ["2002"], tasksOffset: null, since: "2021-11-03T12:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" };
    const { c, fetch } = connector(account());
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(paths(fetch)).toEqual(["/tasks", "/tasks/4004/stories", "/tasks/4005/stories"]);
    expect(out.flatMap((b) => b.events).map((e) => e.payload.itemId)).toEqual(["asana:task:4004", "asana:task:4005"]);
    // The resumed pass keeps the times it started with.
    expect(parseAsanaCursor(out.at(-1)!.cursor)).toMatchObject({ workspaces: [], since: "2021-11-03T12:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" });

    const again = connector(account());
    expect(await batches(again.c.historicalImport({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }))).toEqual([]);
    expect(again.fetch.calls).toEqual([]);
  });

  it("starts a new import when the checkpoint is an incremental one", async () => {
    const saved: AsanaCursor = { pass: "incremental", workspaces: [], listed: false, projectsOffset: null, projects: [], tasksOffset: null, since: "2026-11-02T12:00:00.000Z", nextFrom: "2026-11-03T00:00:00.000Z" };
    const { c, fetch } = connector(account());
    await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(new URL(fetch.calls.find((call) => call.url.includes("/tasks?"))!.url).searchParams.get("modified_since")).toBe("2021-11-03T12:00:00.000Z");
  });

  it("asks only for tasks changed since the last pass began, less five minutes", async () => {
    expect(ASANA_OVERLAP_MS).toBe(300_000);
    const { memory, pipeline } = testPipeline();
    const first = connector(account(), { now: () => new Date("2026-11-04T12:00:00.000Z") });
    await runSync({ connector: first.c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });

    const next = connector(account(), { now: () => new Date("2026-11-05T12:00:00.000Z") });
    const report = await runSync({ connector: next.c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const since = next.fetch.calls.filter((call) => call.url.includes("/tasks?")).map((call) => new URL(call.url).searchParams.get("modified_since"));
    expect(since).toEqual(["2026-11-04T11:55:00.000Z", "2026-11-04T11:55:00.000Z"]);
    // Nothing changed since, so only the projects are read again, as duplicates.
    expect(report).toMatchObject({ ingested: 0, duplicates: 2 });
    expect(JSON.parse((await memory.getCheckpoint(TEST_ORG, "asana", "incremental"))!)).toMatchObject({ pass: "incremental", workspaces: [], since: "2026-11-04T11:55:00.000Z", nextFrom: "2026-11-05T11:55:00.000Z" });
  });

  it("looks back 24 hours, or as long as it is told, when there is no checkpoint", async () => {
    const { c, fetch } = connector(account());
    await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(new URL(fetch.calls.find((call) => call.url.includes("/tasks?"))!.url).searchParams.get("modified_since")).toBe("2026-11-02T12:00:00.000Z");
    const short = connector(account(), { incrementalLookbackHours: 2 });
    await batches(short.c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(new URL(short.fetch.calls.find((call) => call.url.includes("/tasks?"))!.url).searchParams.get("modified_since")).toBe("2026-11-03T10:00:00.000Z");
  });

  it("resumes an interrupted incremental pass, and starts the next after a historical one", async () => {
    const saved: AsanaCursor = { pass: "incremental", workspaces: ["1001"], listed: true, projectsOffset: null, projects: ["2001"], tasksOffset: null, since: "2026-10-31T00:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" };
    const { c, fetch } = connector(account());
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(paths(fetch)).toEqual(["/tasks", "/tasks/4001/stories"]);
    expect(out.flatMap((b) => b.events).map((e) => e.type)).toEqual(["work.item_updated", "work.comment_updated"]);

    const finishedImport: AsanaCursor = { ...saved, pass: "historical", workspaces: [], listed: false, projects: [] };
    const next = connector(account());
    await batches(next.c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(finishedImport) }));
    expect(paths(next.fetch)[0]).toBe("/users/me");
    expect(new URL(next.fetch.calls.find((call) => call.url.includes("/tasks?"))!.url).searchParams.get("modified_since")).toBe("2026-11-01T00:00:00.000Z");
  });

  it("reads a list again from its start when Asana turns down a saved offset, once", async () => {
    const saved: AsanaCursor = { pass: "historical", workspaces: ["1001"], listed: true, projectsOffset: null, projects: ["2001"], tasksOffset: "offset-1", since: "2021-11-03T12:00:00.000Z", nextFrom: "2026-11-03T11:55:00.000Z" };
    const { c, fetch } = connector(account({ expiredOffsets: 1 }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    const tasks = fetch.calls.filter((call) => call.url.includes("/tasks?")).map((call) => new URL(call.url).searchParams.get("offset"));
    expect(tasks).toEqual(["offset-1", null]);
    expect(out.flatMap((b) => b.events).filter((e) => e.type === "work.item_updated").map((e) => e.payload.itemId)).toEqual(["asana:task:4001", "asana:task:4002"]);

    const projects: AsanaCursor = { ...saved, projects: [], tasksOffset: null, projectsOffset: "offset-1" };
    const again = connector(account({ expiredOffsets: 1 }));
    await batches(again.c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(projects) }));
    expect(again.fetch.calls.filter((call) => call.url.includes("/projects?")).map((call) => new URL(call.url).searchParams.get("offset"))).toEqual(["offset-1", null]);

    const stuck = connector(account({ expiredOffsets: 5 }));
    await expect(batches(stuck.c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }))).resolves.toBeDefined();
    // No sections or comments to page through, so only the list being resumed meets an expired offset.
    const quiet = { sections: {}, stories: {} };
    const looping = connector(account({ ...quiet, expiredOffsets: 5, pageCap: 1 }));
    await expect(batches(looping.c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }))).rejects.toBeInstanceOf(AsanaOffsetExpiredError);
    const projectsLooping = connector(account({ ...quiet, tasks: [], expiredOffsets: 5, pageCap: 1 }));
    await expect(batches(projectsLooping.c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(projects) }))).rejects.toBeInstanceOf(AsanaOffsetExpiredError);
  });

  it("skips a project or task deleted part way through a pass", async () => {
    const data = account();
    const { fetch: mockFetch } = connector(data);
    const gone = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.includes("/projects/2002/") || (url.pathname.endsWith("/tasks") && url.searchParams.get("project") === "2002") || url.pathname.includes("/tasks/4001/")) {
        return json(404, { errors: [{ message: "Unknown object" }] });
      }
      return mockFetch(url, init);
    }) as typeof globalThis.fetch;
    const c = asanaConnector({ token: TOKEN, now: () => NOW, fetch: gone, sleep: noSleep });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 4, deadLettered: 0 });
    expect(memory.events.filter((e) => e.type === "work.board_updated").find((e) => e.payload.boardId === "asana:project:2002")!.payload.groups).toEqual([]);
  });

  it("stops on any other error, leaving runSync to retry from the checkpoint", async () => {
    const { c } = connector(account({ token: "y".repeat(40) }));
    await expect(runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG, attempts: 1 })).rejects.toThrow(/turned down the token/);
    const responses = [json(200, { data: { workspaces: [{ gid: "1001" }] } }), json(200, PAGE([{ gid: "2001" }])), json(403, {})];
    const { fetch } = scripted(responses);
    const blocked = asanaConnector({ token: TOKEN, now: () => NOW, fetch, sleep: noSleep });
    await expect(batches(blocked.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toMatchObject({ status: 403 });
    const late = scripted([json(200, { data: { workspaces: [{ gid: "1001" }] } }), json(200, PAGE([{ gid: "2001" }])), json(200, PAGE([])), json(500, {})]);
    const failing = asanaConnector({ token: TOKEN, now: () => NOW, fetch: late.fetch, sleep: noSleep });
    await expect(batches(failing.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toMatchObject({ status: 500 });
  });

  it("waits out Asana's rate limit and carries on", async () => {
    const waits: number[] = [];
    const { c } = connector(account({ rateLimited: 2, retryAfter: "3" }), { sleep: async (ms) => void waits.push(ms) });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(waits).toEqual([3000, 3000]);
    expect(report.ingested).toBe(6);
  });

  it("finishes cleanly when the user belongs to no workspace", async () => {
    const { c } = connector(account({ workspaces: [] }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(out).toHaveLength(1);
    expect(parseAsanaCursor(out[0]!.cursor)).toMatchObject({ workspaces: [], pass: "historical" });
  });

  it("skips projects and tasks with no usable id without reading anything for them", async () => {
    const responses = [
      json(200, { data: { workspaces: [{ gid: "1001" }] } }),
      json(200, PAGE([{ gid: "bad" }, {}, { gid: "2001", modified_at: "2026-10-30T10:00:00.000Z" }])),
      json(200, PAGE([])),
      json(200, PAGE([{ gid: "../x", modified_at: "2026-10-30T10:00:00.000Z" }, { gid: "4001", modified_at: "2026-10-30T10:00:00.000Z" }])),
      json(200, PAGE([])),
    ];
    const { fetch, sent } = scripted(responses);
    const c = asanaConnector({ token: TOKEN, now: () => NOW, fetch, sleep: noSleep });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(sent.map((u) => u.pathname.replace("/api/1.0", ""))).toEqual(["/users/me", "/projects", "/projects/2001/sections", "/tasks", "/tasks/4001/stories"]);
    expect(out.flatMap((b) => b.events).map((e) => String(e.payload.itemId ?? e.payload.boardId))).toEqual(["asana:project:2001", "asana:task:4001"]);
  });

  it("declares creating a task and commenting, and turns both down while writes are off", async () => {
    const { c } = connector(account());
    expect(c.writes).toBe(ASANA_WRITES);
    expect(ASANA_WRITES.map((w) => w.name)).toEqual(["create_task", "comment_on_task"]);
    expect(ASANA_WRITES.every((w) => w.integration === "asana")).toBe(true);
    const audit = await assertWritesRefused(c);
    expect(audit.map((entry) => entry.action)).toEqual(["create_task", "comment_on_task"]);
    expect(audit.every((entry) => entry.outcome === "refused")).toBe(true);
    expect("handleWebhook" in c).toBe(false);
    expect(c.source).toBe("asana");
  });
});
