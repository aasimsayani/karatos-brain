import { describe, expect, it } from "vitest";
import { runSync } from "@karatos/core";
import {
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  docMockFetch,
  notionDocMock,
  testPipeline,
  type NotionMockData,
  type NotionMockPage,
  type NotionMockProperty,
} from "@karatos/connector-testkit";
import {
  NOTION_API,
  NOTION_MAX_PROPERTIES,
  NOTION_OVERLAP_MS,
  NOTION_PAGE_SIZE,
  NOTION_SAFE_PROPERTY_TYPES,
  NOTION_VERSION,
  NOTION_WRITES,
  NotionApiError,
  NotionConfigError,
  notionClient,
  notionConnector,
  notionDay,
  notionId,
  notionPageEvents,
  notionPropertyId,
  notionPropertyValues,
  notionRef,
  notionSafeProperties,
  notionSource,
  notionSourceEvents,
  notionTime,
  parseNotionCursor,
  parseNotionDataSources,
  type NotionCursor,
  type NotionOptions,
  type NotionSource,
} from "../src/index.js";

const TOKEN = ["ntn", "x".repeat(46)].join("_");
const NOW = new Date("2026-11-06T12:00:00.000Z");
const RECEIVED = NOW.toISOString();
const SINCE = "2021-11-06T12:00:00.000Z";
const noSleep = async () => {};
/** A synthetic Notion id made of one repeated hex character, with an optional tail. */
const uid = (c: string, tail = "") => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${(c.repeat(12) + tail).slice(tail.length)}`;

const REPAIRS = uid("a");
const NOTES = uid("b");
const MEMOS = uid("c");
const OTHER = uid("d");
const DB = uid("e");
const page = (tag: string) => uid("f", tag);
const PAGE = { one: page("1"), two: page("2"), old: page("3"), bad: page("4"), memo1: page("5"), memo2: page("6"), else1: page("7") };
const USER = uid("9");

const REPAIR_SCHEMA: Record<string, NotionMockProperty> = {
  Name: { id: "title", name: "Name", type: "title", title: {} },
  Phone: { id: "ph%3Ax", name: "Phone", type: "phone_number", phone_number: {} },
  Notes: { id: "nt%5Cy", name: "Notes", type: "rich_text", rich_text: {} },
  Status: { id: "st%3Aa", name: "Status", type: "status", status: { options: [{ id: "s1", name: "At the bench", color: "blue" }] } },
  Quote: { id: "qt", name: "Quote", type: "number", number: { format: "dollar" } },
  Due: { id: "du%7Ce", name: "Due", type: "date", date: {} },
  "Picked up": { id: "pk", name: "Picked up", type: "checkbox", checkbox: {} },
  Metals: { id: "mt", name: "Metals", type: "multi_select", multi_select: { options: [] } },
  Memo: { id: "mm", name: "Memo", type: "relation", relation: {} },
  Bench: { id: "bn", name: "Bench", type: "people", people: {} },
  Ticket: { id: "tk", name: "Ticket", type: "unique_id", unique_id: { prefix: "REP" } },
  Summary: { id: "sm", name: "Summary", type: "formula", formula: { expression: "" } },
  Edited: { id: "ed", name: "Edited", type: "last_edited_time", last_edited_time: {} },
};
const READ_IDS = ["st%3Aa", "qt", "du%7Ce", "pk", "mt", "mm", "bn", "tk", "ed"];

function repair(id: string, created: string, edited: string, extra: Partial<NotionMockPage> = {}): NotionMockPage {
  return {
    id,
    created_time: created,
    last_edited_time: edited,
    url: `https://www.notion.so/Test-Customer-ring-resize-${id.replace(/-/g, "")}`,
    properties: {
      Name: { id: "title", type: "title", title: [{ type: "text", plain_text: "Test Customer ring resize", text: { content: "Test Customer ring resize" } }] },
      Phone: { id: "ph%3Ax", type: "phone_number", phone_number: "+1 212 555 0101" },
      Notes: { id: "nt%5Cy", type: "rich_text", rich_text: [{ type: "text", plain_text: "Call customer@example.test when ready" }] },
      Status: { id: "st%3Aa", type: "status", status: { id: "s1", name: "At the bench", color: "blue" } },
      Quote: { id: "qt", type: "number", number: 250 },
      Due: { id: "du%7Ce", type: "date", date: { start: "2026-11-10", end: null, time_zone: null } },
      "Picked up": { id: "pk", type: "checkbox", checkbox: false },
      Metals: { id: "mt", type: "multi_select", multi_select: [{ id: "m1", name: "Gold", color: "yellow" }, { id: "m2", name: "Platinum", color: "gray" }] },
      Memo: { id: "mm", type: "relation", relation: [{ id: PAGE.memo1 }], has_more: false },
      Bench: { id: "bn", type: "people", people: [{ object: "user", id: USER, name: "Test Jeweler", person: { email: "jeweler@example.test" } }] },
      Ticket: { id: "tk", type: "unique_id", unique_id: { number: 42, prefix: "REP" } },
      Summary: { id: "sm", type: "formula", formula: { type: "string", string: "Test Customer ring resize" } },
      Edited: { id: "ed", type: "last_edited_time", last_edited_time: edited },
    },
    ...extra,
  };
}

const memo = (id: string, edited: string, carats: number): NotionMockPage => ({
  id,
  created_time: "2026-10-15T09:00:00.000Z",
  last_edited_time: edited,
  url: `https://www.notion.so/Memo-${id.replace(/-/g, "")}`,
  properties: {
    Name: { id: "title", type: "title", title: [{ type: "text", plain_text: "Test Customer memo" }] },
    Carats: { id: "ca", type: "number", number: carats },
    Out: { id: "ou", type: "date", date: { start: "2026-10-15T10:00:00.000-04:00", end: null, time_zone: null } },
  },
});

/**
 * Against NOW (2026-11-06 noon): the history window starts 2021-11-06. Three
 * data sources: repairs (one page outside the window, one whose time doesn't
 * read), notes with only text, and memos.
 */
function account(extra: Partial<NotionMockData> = {}): NotionMockData {
  return {
    token: TOKEN,
    dataSources: [
      { id: REPAIRS, title: "Repairs", databaseId: DB, created_time: "2025-01-01T00:00:00.000Z", last_edited_time: "2026-10-30T10:00:00.000Z", properties: REPAIR_SCHEMA },
      { id: NOTES, title: "Notes", databaseId: DB, created_time: "2025-01-01T00:00:00.000Z", last_edited_time: "2026-10-30T10:00:00.000Z", properties: { Name: { id: "title", name: "Name", type: "title" }, Note: { id: "no", name: "Note", type: "rich_text" } } },
      { id: MEMOS, title: "Memos", databaseId: DB, created_time: "2025-01-01T00:00:00.000Z", last_edited_time: "2026-10-30T10:00:00.000Z", properties: { Name: { id: "title", name: "Name", type: "title" }, Carats: { id: "ca", name: "Carats", type: "number" }, Out: { id: "ou", name: "Out", type: "date" } } },
    ],
    pages: {
      [REPAIRS]: [
        repair(PAGE.one, "2026-01-01T09:00:00.000Z", "2026-11-01T10:00:00.000Z"),
        repair(PAGE.two, "2026-10-01T09:00:00.000Z", "2026-10-01T09:00:00.000Z"),
        repair(PAGE.old, "2020-01-01T09:00:00.000Z", "2020-02-01T09:00:00.000Z"),
        repair(PAGE.bad, "2026-09-01T09:00:00.000Z", "2026-09-01 10:00:00Z"),
      ],
      [NOTES]: [{ id: page("8"), created_time: "2026-10-01T09:00:00.000Z", last_edited_time: "2026-10-01T09:00:00.000Z", url: "https://www.notion.so/x", properties: { Note: { id: "no", type: "rich_text", rich_text: [{ plain_text: "Test Customer prefers yellow gold" }] } } }],
      [MEMOS]: [memo(PAGE.memo1, "2026-10-15T09:00:00.000Z", 1.5)],
    },
    ...extra,
  };
}

function connector(data: NotionMockData, options: Partial<NotionOptions> = {}) {
  const fetch = docMockFetch(notionDocMock(data));
  const c = notionConnector({ token: TOKEN, now: () => NOW, fetch, sleep: noSleep, ...options });
  return { c, fetch };
}

/** A fetch that answers each request from a list, recording what was sent. */
function scripted(responses: Response[]) {
  const sent: URL[] = [];
  const inits: RequestInit[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    sent.push(url);
    inits.push(init ?? {});
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetch: fetch as typeof globalThis.fetch, sent, inits, bodies: () => inits.map((i) => (typeof i.body === "string" ? JSON.parse(i.body) : undefined)) };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const LIST = (results: unknown[], next: string | null = null, extra: Record<string, unknown> = {}) => ({ object: "list", results, next_cursor: next, has_more: next !== null, ...extra });
const calls = (fetch: { calls: { method: string; url: string }[] }) => fetch.calls.map((call) => `${call.method} ${new URL(call.url).pathname.replace("/v1", "")}`);
const queries = (fetch: { calls: { method: string; url: string }[] }) => fetch.calls.map((call) => new URL(call.url)).filter((u) => u.pathname.endsWith("/query"));

async function batches(iterable: AsyncIterable<{ events: unknown[]; cursor: string | null }>) {
  const out: { events: { type: string; occurredAt?: string; payload: Record<string, unknown> }[]; cursor: string | null }[] = [];
  for await (const b of iterable) out.push(b as (typeof out)[number]);
  return out;
}

const repairsSource = (): NotionSource => notionSource({ id: REPAIRS, title: [{ plain_text: "Repairs" }], parent: { type: "database_id", database_id: DB }, last_edited_time: "2026-10-30T10:00:00.000Z", properties: REPAIR_SCHEMA })!;

describe("notionTime, notionDay and the id readers", () => {
  it("reads Notion's times as UTC and its days as calendar days", () => {
    expect(notionTime("2026-11-01T10:00:00.000Z")).toBe("2026-11-01T10:00:00.000Z");
    expect(notionTime("2026-11-01T10:00:00.000-04:00")).toBe("2026-11-01T14:00:00.000Z");
    expect(notionTime("2026-11-01T10:00Z")).toBe("2026-11-01T10:00:00.000Z");
    for (const bad of ["2026-11-01", "2026-11-01T10:00:00", " 2026-11-01T10:00:00Z", "2026-09-01 10:00:00Z", "2026-13-01T10:00:00Z", 1_700_000_000, null]) expect(notionTime(bad), String(bad)).toBeUndefined();
    expect(notionDay("2026-11-10")).toBe("2026-11-10");
    for (const bad of ["2026-02-30", "2026-11", "2026-11-10T00:00:00Z", " 2026-11-10", 20261110, null]) expect(notionDay(bad), String(bad)).toBeUndefined();
  });

  it("writes Notion ids in their dashed, lowercase form, and turns down anything else", () => {
    expect(notionId(REPAIRS)).toBe(REPAIRS);
    expect(notionId(REPAIRS.replace(/-/g, "").toUpperCase())).toBe(REPAIRS);
    for (const bad of ["", "a".repeat(31), `${REPAIRS}/x`, `x${REPAIRS}`, REPAIRS.replace("a", "g"), "../" + REPAIRS, 5, null]) expect(notionId(bad), String(bad)).toBeUndefined();
  });

  it("decodes property ids, and turns down ones that don't read", () => {
    expect(notionPropertyId("title")).toBe("title");
    expect(notionPropertyId("f%5C%5C%3Ap")).toBe("f\\\\:p");
    for (const bad of ["", "%E0%A4%A", "a b", "%0A", "x".repeat(101), "x".repeat(201), "%41".repeat(67), 5, null]) expect(notionPropertyId(bad), JSON.stringify(bad)).toBeUndefined();
    expect(notionPropertyId("x".repeat(100))).toBe("x".repeat(100));
  });
});

describe("notionSource and notionSafeProperties", () => {
  it("keeps a data source's ids, name, times and property definitions, and nothing else", () => {
    const source = notionSource({
      id: REPAIRS.replace(/-/g, ""),
      title: [{ plain_text: " Rep" }, { plain_text: "airs " }, { text: "no plain text" }, null],
      description: [{ plain_text: "Test Customer intake" }],
      parent: { type: "database_id", database_id: DB },
      in_trash: true,
      created_time: "2025-01-01T00:00:00.000Z",
      last_edited_time: "2026-10-30T10:00:00.000Z",
      properties: { Status: { id: "st%3Aa", name: "Status", type: "status", description: "Test Customer" }, Odd: { id: "", type: "number" }, Long: { id: "x".repeat(201), type: "number" }, NoName: { id: "nn" }, Bad: null },
    });
    expect(source).toEqual({ id: REPAIRS, name: "Repairs", databaseId: DB, inTrash: true, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2026-10-30T10:00:00.000Z", properties: [{ id: "st%3Aa", name: "Status", type: "status" }, { id: "nn", name: "nn", type: "unknown" }] });
    expect(notionSource({ id: REPAIRS })).toEqual({ id: REPAIRS, name: `Data source ${REPAIRS}`, databaseId: undefined, inTrash: false, createdAt: undefined, updatedAt: undefined, properties: [] });
    expect(notionSource({ id: REPAIRS, parent: { type: "page_id", page_id: DB, database_id: DB } })!.databaseId).toBeUndefined();
    expect(notionSource({ id: REPAIRS, in_trash: "yes" })!.inTrash).toBe(false);
    expect(notionSource({ id: REPAIRS, title: [{ plain_text: "x".repeat(250) }], properties: { P: { id: "p", name: "y".repeat(150), type: "number" } } })).toMatchObject({ name: "x".repeat(200), properties: [{ name: "y".repeat(100) }] });
    expect(notionSource({ id: "not-an-id" })).toBeUndefined();
    expect(notionSource(null)).toBeUndefined();
    expect(notionSource([REPAIRS])).toBeUndefined();
  });

  it("reads only the property types that hold no free text, up to the cap", () => {
    expect(NOTION_SAFE_PROPERTY_TYPES).toEqual(["number", "checkbox", "date", "select", "multi_select", "status", "created_time", "last_edited_time", "relation", "people", "unique_id"]);
    expect(notionSafeProperties(repairsSource()).map((p) => p.id)).toEqual(READ_IDS);
    const unsafe = ["title", "rich_text", "email", "phone_number", "url", "files", "formula", "rollup", "created_by", "last_edited_by", "verification", "button", "place", "location", "unknown"];
    const source: NotionSource = { ...repairsSource(), properties: unsafe.map((type, i) => ({ id: `u${i}`, name: type, type })) };
    expect(notionSafeProperties(source)).toEqual([]);
    const wide: NotionSource = { ...repairsSource(), properties: Array.from({ length: NOTION_MAX_PROPERTIES + 5 }, (_, i) => ({ id: `n${i}`, name: `n${i}`, type: "number" })) };
    expect(NOTION_MAX_PROPERTIES).toBe(100);
    expect(notionSafeProperties(wide)).toHaveLength(100);
    expect(notionSafeProperties(wide)[0]!.id).toBe("n0");
  });
});

describe("notionPropertyValues", () => {
  it("shapes each read property's value, and leaves the others out", () => {
    const raw = repair(PAGE.one, "2026-01-01T09:00:00.000Z", "2026-11-01T10:00:00.000Z").properties;
    expect(notionPropertyValues(repairsSource(), raw)).toEqual({
      "st%3Aa": { type: "status", label: "At the bench", id: "s1" },
      qt: { type: "number", number: 250 },
      "du%7Ce": { type: "date", start: "2026-11-10", end: null },
      pk: { type: "checkbox", checked: false },
      mt: { type: "multi_select", labels: ["Gold", "Platinum"], ids: ["m1", "m2"] },
      mm: { type: "relation", pages: [notionRef("page", PAGE.memo1)], more: false },
      bn: { type: "people", people: [notionRef("user", USER)] },
      tk: { type: "unique_id", number: 42, prefix: "REP" },
      ed: { type: "last_edited_time", at: "2026-11-01T10:00:00.000Z" },
    });
  });

  it("reads odd and empty values as empty, never as text", () => {
    const source: NotionSource = {
      ...repairsSource(),
      properties: [
        { id: "n", name: "n", type: "number" },
        { id: "c", name: "c", type: "checkbox" },
        { id: "d", name: "d", type: "date" },
        { id: "d2", name: "d2", type: "date" },
        { id: "d3", name: "d3", type: "date" },
        { id: "s", name: "s", type: "select" },
        { id: "s2", name: "s2", type: "select" },
        { id: "m", name: "m", type: "multi_select" },
        { id: "ct", name: "ct", type: "created_time" },
        { id: "r", name: "r", type: "relation" },
        { id: "p", name: "p", type: "people" },
        { id: "u", name: "u", type: "unique_id" },
        { id: "u2", name: "u2", type: "unique_id" },
      ],
    };
    const values = notionPropertyValues(source, {
      n: { id: "n", type: "number", number: Number.POSITIVE_INFINITY },
      c: { id: "c", type: "checkbox", checkbox: "true" },
      d: { id: "d", type: "date", date: { start: "2026-11-10T15:00:00.000+01:00", end: "2026-02-30" } },
      d2: { id: "d2", type: "date", date: null },
      d3: { id: "d3", type: "date", date: { start: "2026-11-10", end: "2026-11-12" } },
      s: { id: "s", type: "select", select: null },
      s2: { id: "s2", type: "select", select: { id: "x".repeat(150), name: " y ".repeat(60) } },
      m: { id: "m", type: "multi_select", multi_select: [{ id: "m1", name: "" }, "Gold", null, { name: "Silver" }] },
      ct: { id: "ct", type: "created_time", created_time: "soon" },
      r: { id: "r", type: "relation", relation: [{ id: PAGE.two }, { id: "x" }, "y"], has_more: true },
      p: { id: "p", type: "people", people: [{ id: "x", name: "Test Customer" }] },
      u: { id: "u", type: "unique_id", unique_id: { number: 1.5, prefix: null } },
      u2: { id: "u2", type: "unique_id", unique_id: null },
      extra: { id: "title", type: "title", title: [{ plain_text: "Test Customer" }] },
    });
    expect(values).toEqual({
      n: { type: "number", number: null },
      c: { type: "checkbox", checked: false },
      d: { type: "date", start: "2026-11-10T14:00:00.000Z", end: null },
      d2: { type: "date", start: null, end: null },
      d3: { type: "date", start: "2026-11-10", end: "2026-11-12" },
      s: { type: "select", label: null, id: null },
      s2: { type: "select", label: " y ".repeat(60).trim().slice(0, 100), id: "x".repeat(100) },
      m: { type: "multi_select", labels: ["Silver"], ids: ["m1"] },
      ct: { type: "created_time", at: null },
      r: { type: "relation", pages: [notionRef("page", PAGE.two)], more: true },
      p: { type: "people", people: [] },
      u: { type: "unique_id", number: null, prefix: null },
      u2: { type: "unique_id", number: null, prefix: null },
    });
    expect(JSON.stringify(values)).not.toMatch(/Test Customer/);
  });

  it("leaves out a property that is missing or whose type changed since the schema was read", () => {
    const values = notionPropertyValues(repairsSource(), { Quote: { id: "qt", type: "rich_text", rich_text: [{ plain_text: "Test Customer" }] }, Due: { id: "du%7Ce", type: "date", date: null } });
    expect(values).toEqual({ "du%7Ce": { type: "date", start: null, end: null } });
    expect(notionPropertyValues(repairsSource(), "nope")).toEqual({});
    expect(notionPropertyValues(repairsSource(), [{ id: "qt", type: "number", number: 1 }])).toEqual({});
    expect(notionPropertyValues(repairsSource(), { a: null, b: { type: "number" } })).toEqual({});
    // Only a property whose id is the schema's own string matches it.
    expect(notionPropertyValues(repairsSource(), { Quote: { id: ["qt"], type: "number", number: 1 } })).toEqual({});
  });
});

describe("the Notion normalizer", () => {
  it("makes a data source a board, with every property as a column marked with whether it is read", () => {
    const [e] = notionSourceEvents(repairsSource(), RECEIVED);
    expect(e).toMatchObject({ type: "work.board_updated", occurredAt: "2026-10-30T10:00:00.000Z", receivedAt: RECEIVED });
    expect(e!.payload).toEqual({
      boardId: notionRef("data_source", REPAIRS),
      databaseId: notionRef("database", DB),
      name: "Repairs",
      state: "active",
      columns: Object.values(REPAIR_SCHEMA).map((p) => ({ id: p.id, type: p.type, title: p.name, read: READ_IDS.includes(p.id) })),
    });
    expect(e!.idempotencyKey).toMatch(new RegExp(`^notion:data_source:${REPAIRS}:[0-9a-f]{16}$`));
    expect(e!.id).toBe(`notion_${e!.idempotencyKey.slice("notion:".length)}`);
    expect(notionSourceEvents(repairsSource(), "2026-11-07T00:00:00.000Z")[0]!.idempotencyKey).toBe(e!.idempotencyKey);
    expect(notionSourceEvents({ ...repairsSource(), name: "Repair intake" }, RECEIVED)[0]!.idempotencyKey).not.toBe(e!.idempotencyKey);
    const trashed = notionSourceEvents({ ...repairsSource(), inTrash: true, databaseId: undefined, createdAt: "2025-01-01T00:00:00.000Z" }, RECEIVED)[0]!;
    expect(trashed.payload).toMatchObject({ state: "deleted", createdAt: "2025-01-01T00:00:00.000Z" });
    expect(trashed.payload).not.toHaveProperty("databaseId");
    expect(notionSourceEvents({ ...repairsSource(), updatedAt: undefined }, RECEIVED)[0]!.occurredAt).toBeUndefined();
  });

  it("makes a page an item with only its read properties, never its title, text or address", () => {
    const raw = repair(PAGE.one, "2026-01-01T09:00:00.000Z", "2026-11-01T10:00:00.000Z");
    const [e] = notionPageEvents({ ...raw, object: "page", in_trash: false }, repairsSource(), RECEIVED);
    expect(e).toMatchObject({ type: "work.item_updated", occurredAt: "2026-11-01T10:00:00.000Z", receivedAt: RECEIVED });
    expect(e!.payload).toEqual({
      itemId: notionRef("page", PAGE.one),
      boardId: notionRef("data_source", REPAIRS),
      state: "active",
      createdAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-11-01T10:00:00.000Z",
      columns: notionPropertyValues(repairsSource(), raw.properties),
    });
    expect(JSON.stringify(e)).not.toMatch(/Test Customer|example\.test|ring resize|555|Test Jeweler|notion\.so/);
    expect(e!.idempotencyKey).toMatch(new RegExp(`^notion:page:${PAGE.one}:[0-9a-f]{16}$`));
    expect(e!.id).toMatch(/^notion_[A-Za-z0-9_.:-]+$/);
    const trashed = notionPageEvents({ ...raw, in_trash: true }, repairsSource(), RECEIVED)[0]!;
    expect(trashed.payload.state).toBe("deleted");
    expect(notionPageEvents({ ...raw, in_trash: "yes" }, repairsSource(), RECEIVED)[0]!.payload.state).toBe("active");
  });

  it("keys each version by what was read, so a replay is a duplicate and a change is new", () => {
    const one = (props: Record<string, unknown>, edited = "2026-11-01T10:00:00.000Z") => notionPageEvents({ id: PAGE.one, created_time: "2026-01-01T09:00:00.000Z", last_edited_time: edited, properties: props }, repairsSource(), RECEIVED)[0]!;
    const first = one({ Quote: { id: "qt", type: "number", number: 250 } });
    expect(notionPageEvents({ id: PAGE.one, created_time: "2026-01-01T09:00:00.000Z", last_edited_time: "2026-11-01T10:00:00.000Z", properties: { Quote: { id: "qt", type: "number", number: 250 } } }, repairsSource(), "2026-11-07T00:00:00.000Z")[0]!.idempotencyKey).toBe(first.idempotencyKey);
    // Two edits in the same minute are two versions.
    expect(one({ Quote: { id: "qt", type: "number", number: 300 } }).idempotencyKey).not.toBe(first.idempotencyKey);
    expect(one({ Quote: { id: "qt", type: "number", number: 250 } }, "2026-11-02T10:00:00.000Z").idempotencyKey).not.toBe(first.idempotencyKey);
    // A text property changing isn't read, so it isn't a new version.
    expect(one({ Quote: { id: "qt", type: "number", number: 250 }, Notes: { id: "nt%5Cy", type: "rich_text", rich_text: [{ plain_text: "Test Customer called" }] } }).idempotencyKey).toBe(first.idempotencyKey);
  });

  it("dead-letters a page whose edit time doesn't read and drops one with no id", () => {
    const [e] = notionPageEvents({ id: PAGE.bad, created_time: "soon", last_edited_time: "2026-09-01 10:00:00Z" }, repairsSource(), RECEIVED);
    expect(e!.occurredAt).toBeUndefined();
    expect(e!.payload).not.toHaveProperty("createdAt");
    expect(e!.payload).not.toHaveProperty("updatedAt");
    expect(e!.payload.columns).toEqual({});
    expect(notionPageEvents({ last_edited_time: "2026-11-01T10:00:00.000Z" }, repairsSource(), RECEIVED)).toEqual([]);
    expect(notionPageEvents({ id: "../x", last_edited_time: "2026-11-01T10:00:00.000Z" }, repairsSource(), RECEIVED)).toEqual([]);
    expect(notionPageEvents(null as unknown as Record<string, unknown>, repairsSource(), RECEIVED)).toEqual([]);
  });
});

describe("the Notion client", () => {
  it("checks the token's shape before sending anything", () => {
    for (const bad of ["", "short", `${"x".repeat(30)} spaced`, `${"x".repeat(30)}\n`, `ntn_${"x".repeat(20)}.x`]) expect(() => notionClient({ token: bad }), JSON.stringify(bad)).toThrow(NotionConfigError);
    expect(() => notionClient({ token: "x".repeat(4097) })).toThrow(/NOTION_ACCESS_TOKEN/);
    expect(() => notionClient({ token: "x".repeat(20) })).not.toThrow();
    expect(() => notionClient({ token: "x".repeat(19) })).toThrow(NotionConfigError);
  });

  it("searches for data sources only, on Notion's own address, with the token and the API version", async () => {
    const { fetch, sent, inits, bodies } = scripted([json(200, LIST([{ object: "data_source", id: REPAIRS }, "junk"], "cursor-1")), json(200, LIST([]))]);
    const client = notionClient({ token: TOKEN, fetch });
    expect(await client.dataSources()).toEqual({ data: [{ object: "data_source", id: REPAIRS }, {}], next: "cursor-1" });
    expect(await client.dataSources("cursor-1")).toEqual({ data: [], next: null });
    expect(sent.map((u) => u.toString())).toEqual([`${NOTION_API}/search`, `${NOTION_API}/search`]);
    expect(NOTION_VERSION).toBe("2026-03-11");
    expect(inits[0]).toMatchObject({ method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json", "Notion-Version": "2026-03-11", "Content-Type": "application/json" } });
    expect(bodies()).toEqual([
      { filter: { property: "object", value: "data_source" }, page_size: NOTION_PAGE_SIZE },
      { filter: { property: "object", value: "data_source" }, page_size: 100, start_cursor: "cursor-1" },
    ]);
  });

  it("reads a data source's schema with a GET to its documented path", async () => {
    const { fetch, sent, inits } = scripted([json(200, { object: "data_source", id: REPAIRS })]);
    expect(await notionClient({ token: TOKEN, fetch }).dataSource(REPAIRS.replace(/-/g, ""))).toEqual({ object: "data_source", id: REPAIRS });
    expect(sent[0]!.toString()).toBe(`${NOTION_API}/data_sources/${REPAIRS}`);
    expect(inits[0]).toEqual({ method: "GET", headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json", "Notion-Version": "2026-03-11" } });
  });

  it("queries a data source's pages by edit time, oldest first, naming only the properties asked for", async () => {
    const pageRow = { object: "page", id: PAGE.one, created_time: "c", last_edited_time: "e", in_trash: false, url: "https://www.notion.so/Test-Customer", icon: { emoji: "x" }, properties: { Quote: { id: "qt", type: "number", number: 1 }, Odd: { id: "f%5C%5C%3Ap", type: "number", number: 2 }, Name: { id: "title", type: "title", title: [] }, Bad: "x", NoId: { type: "number" } } };
    const { fetch, sent, bodies } = scripted([json(200, LIST([pageRow, 7], "cursor-1", { request_status: { type: "complete" } })), json(200, LIST([], null, { request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" } }))]);
    const client = notionClient({ token: TOKEN, fetch });
    const first = await client.pages(REPAIRS, ["qt", "f%5C%5C%3Ap"], "2026-11-01T00:00:00.000Z");
    // A property that wasn't asked for is dropped, whatever came back, and so is the page's address.
    expect(first).toEqual({
      data: [
        { object: "page", id: PAGE.one, created_time: "c", last_edited_time: "e", in_trash: false, properties: { Quote: { id: "qt", type: "number", number: 1 }, Odd: { id: "f%5C%5C%3Ap", type: "number", number: 2 } } },
        { object: undefined, id: undefined, created_time: undefined, last_edited_time: undefined, in_trash: undefined, properties: {} },
      ],
      next: "cursor-1",
      complete: true,
    });
    const second = await client.pages(REPAIRS, ["qt"], "2026-11-01T00:00:00.000Z", first.next);
    expect(second).toEqual({ data: [], next: null, complete: false });
    expect(sent.map((u) => u.origin + u.pathname)).toEqual([`${NOTION_API}/data_sources/${REPAIRS}/query`, `${NOTION_API}/data_sources/${REPAIRS}/query`]);
    expect([...sent[0]!.searchParams]).toEqual([
      ["filter_properties", "qt"],
      ["filter_properties", "f\\\\:p"],
    ]);
    const filter = { timestamp: "last_edited_time", last_edited_time: { on_or_after: "2026-11-01T00:00:00.000Z" } };
    const sorts = [{ timestamp: "last_edited_time", direction: "ascending" }];
    expect(bodies()).toEqual([
      { filter, sorts, page_size: 100 },
      { filter, sorts, page_size: 100, start_cursor: "cursor-1" },
    ]);
  });

  it("treats a page with no request status as complete, and a cursor without has_more as the end", async () => {
    const { fetch } = scripted([json(200, { results: [], next_cursor: "cursor-1", has_more: false }), json(200, { results: [], request_status: "incomplete" })]);
    const client = notionClient({ token: TOKEN, fetch });
    expect(await client.pages(REPAIRS, ["qt"], "2026-11-01T00:00:00.000Z")).toEqual({ data: [], next: null, complete: true });
    expect(await client.pages(REPAIRS, ["qt"], "2026-11-01T00:00:00.000Z")).toEqual({ data: [], next: null, complete: true });
  });

  it("turns down ids, properties, times and cursors that aren't Notion's before sending them", async () => {
    const { fetch, sent } = scripted([]);
    const client = notionClient({ token: TOKEN, fetch });
    await expect(client.dataSource(`${REPAIRS}/../x`)).rejects.toThrow(/data source id/);
    await expect(client.dataSource("Repairs")).rejects.toThrow(/data source id/);
    await expect(client.pages("Repairs", ["qt"], "2026-11-01T00:00:00.000Z")).rejects.toThrow(/data source id/);
    await expect(client.pages(REPAIRS, [], "2026-11-01T00:00:00.000Z")).rejects.toThrow(/must name its properties/);
    await expect(client.pages(REPAIRS, Array.from({ length: 101 }, (_, i) => `p${i}`), "2026-11-01T00:00:00.000Z")).rejects.toThrow(/at most 100 properties/);
    await expect(client.pages(REPAIRS, ["a b"], "2026-11-01T00:00:00.000Z")).rejects.toThrow(/property id/);
    await expect(client.pages(REPAIRS, ["qt"], "2026-11-01")).rejects.toThrow(/UTC time/);
    await expect(client.pages(REPAIRS, ["qt"], "2026-02-30T00:00:00.000Z")).rejects.toThrow(/UTC time/);
    await expect(client.pages(REPAIRS, ["qt"], "9999-99-99T99:99:99.999Z")).rejects.toThrow(/UTC time/);
    await expect(client.pages(REPAIRS, ["qt"], "2026-11-01T00:00:00.000Z", "a&b c")).rejects.toThrow(/cursor/);
    await expect(client.pages(REPAIRS, ["qt"], "2026-11-01T00:00:00.000Z", "x".repeat(513))).rejects.toThrow(/cursor/);
    await expect(client.dataSources("a b")).rejects.toThrow(/cursor/);
    expect(sent).toEqual([]);
    await expect(client.pages(REPAIRS, Array.from({ length: 100 }, (_, i) => `p${i}`), "2026-11-01T00:00:00.000Z", "x".repeat(512))).rejects.toThrow(/unexpected request/);
  });

  it("turns down a reply that isn't a page", async () => {
    const cases: [Response, RegExp, "pages" | "search" | "source"][] = [
      [json(200, LIST([], "bad cursor")), /page cursor/, "pages"],
      [json(200, { results: [], has_more: true, next_cursor: 7 }), /page cursor/, "pages"],
      [json(200, { results: "x" }), /without the results list/, "pages"],
      [json(200, []), /isn't a JSON object/, "pages"],
      [new Response("not json", { status: 200 }), /isn't a JSON object/, "pages"],
      [json(200, { results: {} }), /without the results list/, "search"],
      [json(200, "x"), /isn't a JSON object/, "source"],
    ];
    for (const [i, [response, error, kind]] of cases.entries()) {
      const { fetch } = scripted([response]);
      const client = notionClient({ token: TOKEN, fetch });
      const call = kind === "pages" ? client.pages(REPAIRS, ["qt"], "2026-11-01T00:00:00.000Z") : kind === "search" ? client.dataSources() : client.dataSource(REPAIRS);
      await expect(call, String(i)).rejects.toThrow(error);
    }
    const { fetch } = scripted([json(200, { results: [], has_more: true, next_cursor: null })]);
    expect(await notionClient({ token: TOKEN, fetch }).dataSources()).toEqual({ data: [], next: null });
  });

  it("says what to fix for each refusal, without the token", async () => {
    const cases: [number, RegExp][] = [
      [401, /turned down the token: check NOTION_ACCESS_TOKEN/],
      [403, /isn't allowed to read a data source's pages: give it the Read content capability/],
      [404, /couldn't find a data source's pages, or it isn't shared with the connection/],
      [400, /HTTP 400 for a data source's pages/],
      [503, /HTTP 503 for a data source's pages/],
    ];
    for (const [status, message] of cases) {
      const { fetch } = scripted([json(status, { object: "error", status, code: "x", message: "no" })]);
      const error = await notionClient({ token: TOKEN, fetch }).pages(REPAIRS, ["qt"], "2026-11-01T00:00:00.000Z").catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(NotionApiError);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain(TOKEN);
      expect((error as NotionApiError).status).toBe(status);
    }
  });

  it("waits out a 429 for Retry-After seconds, up to a minute, then gives up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const limited = (after?: string) => json(429, { object: "error", code: "rate_limited" }, after === undefined ? {} : { "Retry-After": after });
    const { fetch } = scripted([limited("5"), limited("600"), limited("0"), json(200, LIST([]))]);
    await notionClient({ token: TOKEN, fetch, sleep }).dataSources();
    expect(waits).toEqual([5000, 60_000, 1000]);

    waits.length = 0;
    const second = scripted([limited(), limited("soon"), limited(" 2 "), limited("1")]);
    const error = await notionClient({ token: TOKEN, fetch: second.fetch, sleep }).dataSources().catch((e: unknown) => e);
    expect(waits).toEqual([1000, 2000, 2000]);
    expect(error).toMatchObject({ status: 429, message: "Notion answered HTTP 429 for data sources" });
    expect(second.sent).toHaveLength(4);

    const none = scripted([limited("1")]);
    await expect(notionClient({ token: TOKEN, fetch: none.fetch, sleep, rateLimitRetries: 0 }).dataSources()).rejects.toMatchObject({ status: 429 });
  });
});

describe("parseNotionCursor and parseNotionDataSources", () => {
  const good: NotionCursor = { pass: "incremental", sources: [REPAIRS, MEMOS], from: "2026-11-05T12:00:00.000Z", since: "2026-11-05T12:00:00.000Z", nextFrom: "2026-11-06T11:55:00.000Z" };

  it("reads back a checkpoint it wrote and nothing else", () => {
    expect(parseNotionCursor(null)).toBeNull();
    expect(parseNotionCursor(JSON.stringify(good))).toEqual(good);
    expect(parseNotionCursor(JSON.stringify({ ...good, extra: "dropped" }))).toEqual(good);
    const done = { ...good, sources: [], from: null };
    expect(parseNotionCursor(JSON.stringify(done))).toEqual(done);
    const fresh = { ...good, from: null };
    expect(parseNotionCursor(JSON.stringify(fresh))).toEqual(fresh);
    const bad: unknown[] = [
      "not json",
      "null",
      "[]",
      { ...good, pass: "full" },
      { ...good, sources: [REPAIRS.replace(/-/g, "")] },
      { ...good, sources: [REPAIRS.toUpperCase()] },
      { ...good, sources: REPAIRS },
      { ...good, sources: [5] },
      { ...good, sources: Array.from({ length: 1001 }, () => REPAIRS) },
      { ...good, from: "2026-11-05" },
      { ...good, from: 5 },
      { ...good, since: null },
      { ...good, since: "2026-11-05T12:00:00Z" },
      { ...good, nextFrom: "2026-02-30T12:00:00.000Z" },
      { ...done, from: "2026-11-05T12:00:00.000Z" },
    ];
    for (const raw of bad) expect(() => parseNotionCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw).slice(0, 80)).toThrow("Notion checkpoint is not in the expected shape");
    expect(parseNotionCursor(JSON.stringify({ ...good, sources: Array.from({ length: 1000 }, () => REPAIRS) }))!.sources).toHaveLength(1000);
  });

  it("reads NOTION_DATA_SOURCE_IDS as ids separated by commas or spaces", () => {
    expect(parseNotionDataSources(undefined)).toBeUndefined();
    expect(parseNotionDataSources("  ")).toBeUndefined();
    expect(parseNotionDataSources(`${REPAIRS}, ${MEMOS}\n${REPAIRS.replace(/-/g, "").toUpperCase()}`)).toEqual([REPAIRS, MEMOS]);
    expect(parseNotionDataSources(` ${REPAIRS} `)).toEqual([REPAIRS]);
    for (const bad of ["Repairs", `${REPAIRS};${MEMOS}`, `${REPAIRS},x`, Array.from({ length: 1001 }, () => REPAIRS).join(",")]) expect(() => parseNotionDataSources(bad), bad.slice(0, 40)).toThrow(/NOTION_DATA_SOURCE_IDS/);
  });
});

describe("the Notion connector", () => {
  it("imports, replays, resumes and retries the mocked account", async () => {
    // Three data sources, three pages in the window, and one page dead-lettered.
    const result = await checkConnectorSync({ makeConnector: () => connector(account()).c, expected: { ingested: 6, deadLettered: 1 } });
    expect(result.full).toMatchObject({ ingested: 6, deadLettered: 1 });
    expect(result.resume).not.toBeNull();
  });

  it("reads five years of pages from every data source with a property it reads", async () => {
    const { c, fetch } = connector(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 6, deadLettered: 1 });
    // The text-only data source is never queried.
    expect(calls(fetch)).toEqual(["POST /search", `GET /data_sources/${REPAIRS}`, `POST /data_sources/${REPAIRS}/query`, `GET /data_sources/${NOTES}`, `GET /data_sources/${MEMOS}`, `POST /data_sources/${MEMOS}/query`]);
    expect(queries(fetch).map((u) => u.searchParams.getAll("filter_properties"))).toEqual([READ_IDS.map((id) => decodeURIComponent(id)), ["ca", "ou"]]);
    const types = memory.events.map((e) => `${e.type} ${String(e.payload.itemId ?? e.payload.boardId)}`).sort();
    expect(types).toEqual(
      [
        `work.board_updated notion:data_source:${MEMOS}`,
        `work.board_updated notion:data_source:${NOTES}`,
        `work.board_updated notion:data_source:${REPAIRS}`,
        `work.item_updated notion:page:${PAGE.memo1}`,
        `work.item_updated notion:page:${PAGE.one}`,
        `work.item_updated notion:page:${PAGE.two}`,
      ].sort(),
    );
    expect(memory.events.find((e) => e.payload.boardId === notionRef("data_source", NOTES))!.payload).toMatchObject({ name: "Notes", columns: [{ id: "title", type: "title", read: false }, { id: "no", type: "rich_text", read: false }] });
    expect(memory.events.find((e) => e.payload.itemId === notionRef("page", PAGE.memo1))!.payload.columns).toEqual({ ca: { type: "number", number: 1.5 }, ou: { type: "date", start: "2026-10-15T14:00:00.000Z", end: null } });
    expect(memory.deadLetters).toHaveLength(1);
    assertSynthetic(memory.events);
    expect(JSON.stringify(memory.events)).not.toMatch(/Test Customer|example\.test|ring resize|555|yellow gold|Test Jeweler|notion\.so/);
  });

  it("asks from the start of the history window, oldest edit first", async () => {
    const recorded: unknown[] = [];
    const { fetch: mock } = connector(account());
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith("/query")) recorded.push(JSON.parse(String(init?.body)));
      return mock(input, init);
    }) as typeof globalThis.fetch;
    const c = notionConnector({ token: TOKEN, now: () => NOW, fetch, sleep: noSleep });
    await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(recorded).toEqual([0, 1].map(() => ({ filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: SINCE } }, sorts: [{ timestamp: "last_edited_time", direction: "ascending" }], page_size: 100 })));
  });

  it("would get every property back if it named none, which is why it never does", async () => {
    const { fetch } = connector(account());
    const headers = { Authorization: `Bearer ${TOKEN}`, "Notion-Version": NOTION_VERSION };
    const all = await (await fetch(`${NOTION_API}/data_sources/${REPAIRS}/query`, { method: "POST", headers, body: "{}" })).json();
    expect(JSON.stringify(all)).toMatch(/Test Customer/);
    const named = await (await fetch(`${NOTION_API}/data_sources/${REPAIRS}/query?filter_properties=qt`, { method: "POST", headers, body: "{}" })).json();
    expect(JSON.stringify((named as { results: { properties: unknown }[] }).results.map((r) => r.properties))).not.toMatch(/Test Customer|555|example\.test/);
  });

  it("reads only the data sources it is given, and says which isn't shared", async () => {
    const { c, fetch } = connector(account(), { dataSources: [MEMOS.replace(/-/g, "")] });
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(calls(fetch)).toEqual([`GET /data_sources/${MEMOS}`, `POST /data_sources/${MEMOS}/query`]);
    expect(memory.events.map((e) => e.type)).toEqual(["work.board_updated", "work.item_updated"]);

    const missing = connector(account(), { dataSources: [MEMOS, OTHER] });
    await expect(batches(missing.c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow(`NOTION_DATA_SOURCE_IDS names a data source that isn't shared with the connection: ${OTHER}`);
    expect(() => notionConnector({ token: TOKEN, dataSources: ["Repairs"] })).toThrow(/NOTION_DATA_SOURCE_IDS/);
    expect(() => notionConnector({ token: TOKEN, dataSources: [] })).toThrow(/NOTION_DATA_SOURCE_IDS/);
    expect(() => notionConnector({ token: TOKEN, dataSources: Array.from({ length: 1001 }, () => REPAIRS) })).toThrow(/NOTION_DATA_SOURCE_IDS/);
    const twice = connector(account(), { dataSources: [MEMOS, MEMOS.toUpperCase()] });
    await batches(twice.c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(calls(twice.fetch)).toEqual([`GET /data_sources/${MEMOS}`, `POST /data_sources/${MEMOS}/query`]);
  });

  it("skips a data source deleted or unshared part way through a pass", async () => {
    const data = account();
    const { fetch: mock } = connector(data);
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === `${NOTION_API}/data_sources/${REPAIRS}`) return json(404, { object: "error", status: 404, code: "object_not_found" });
      return mock(input, init);
    }) as typeof globalThis.fetch;
    const c = notionConnector({ token: TOKEN, now: () => NOW, fetch, sleep: noSleep });
    const report = await runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 3, deadLettered: 0 });
  });

  it("honors a shorter history window", async () => {
    const { c } = connector(account(), { historyYears: 1 });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(parseNotionCursor(out.at(-1)!.cursor)!.since).toBe("2025-11-06T12:00:00.000Z");
    expect(() => notionConnector({ token: TOKEN, historyYears: 0 })).toThrow(/historyYears/);
    expect(() => notionConnector({ token: TOKEN, incrementalLookbackHours: 1.5 })).toThrow(/incrementalLookbackHours/);
  });

  it("pages through data sources and pages, checkpointing the latest edit read", async () => {
    const { c, fetch } = connector({ ...account(), pageCap: 1 });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(calls(fetch).filter((p) => p === "POST /search")).toHaveLength(3);
    const cursors = out.map((b) => parseNotionCursor(b.cursor)!);
    expect(cursors.map((k) => [k.sources.length, k.from])).toEqual([
      [3, SINCE],
      [3, SINCE],
      [3, "2026-10-01T09:00:00.000Z"],
      [2, null],
      [2, SINCE],
      [1, SINCE],
      [0, null],
      [0, null],
    ]);
    // The repairs board, then a page each oldest edit first (the unreadable one, Two, One), the notes and memos boards, and the memo.
    expect(out.map((b) => b.events.map((e) => String(e.payload.itemId ?? e.payload.boardId)))).toEqual([
      [notionRef("data_source", REPAIRS)],
      [notionRef("page", PAGE.bad)],
      [notionRef("page", PAGE.two)],
      [notionRef("page", PAGE.one)],
      [notionRef("data_source", NOTES)],
      [notionRef("data_source", MEMOS)],
      [notionRef("page", PAGE.memo1)],
      [],
    ]);
    expect(cursors.every((k) => k.pass === "historical" && k.since === SINCE && k.nextFrom === "2026-11-06T11:55:00.000Z")).toBe(true);
  });

  it("resumes an interrupted import from the latest edit read, and a finished one reads nothing", async () => {
    const saved: NotionCursor = { pass: "historical", sources: [REPAIRS, MEMOS], from: "2026-10-01T09:00:00.000Z", since: SINCE, nextFrom: "2026-11-01T00:00:00.000Z" };
    const recorded: string[] = [];
    const { fetch: mock } = connector(account());
    const fetch = Object.assign(
      (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("/query")) recorded.push(JSON.parse(String(init?.body)).filter.last_edited_time.on_or_after);
        return mock(input, init);
      }) as typeof globalThis.fetch,
      { calls: mock.calls },
    );
    const c = notionConnector({ token: TOKEN, now: () => NOW, fetch, sleep: noSleep });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    // The schema is read again for the data source's properties, without sending the board again.
    expect(calls(mock)).toEqual([`GET /data_sources/${REPAIRS}`, `POST /data_sources/${REPAIRS}/query`, `GET /data_sources/${MEMOS}`, `POST /data_sources/${MEMOS}/query`]);
    expect(recorded).toEqual(["2026-10-01T09:00:00.000Z", SINCE]);
    // Two is read again, as a duplicate of what was stored.
    expect(out.flatMap((b) => b.events).map((e) => String(e.payload.itemId ?? e.payload.boardId))).toEqual([notionRef("page", PAGE.two), notionRef("page", PAGE.one), notionRef("data_source", MEMOS), notionRef("page", PAGE.memo1)]);
    expect(parseNotionCursor(out.at(-1)!.cursor)).toMatchObject({ sources: [], since: SINCE, nextFrom: "2026-11-01T00:00:00.000Z" });

    const again = connector(account());
    expect(await batches(again.c.historicalImport({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }))).toEqual([]);
    expect(again.fetch.calls).toEqual([]);
  });

  it("starts a new import when the checkpoint is an incremental one", async () => {
    const saved: NotionCursor = { pass: "incremental", sources: [MEMOS], from: null, since: "2026-11-05T12:00:00.000Z", nextFrom: "2026-11-06T00:00:00.000Z" };
    const { c, fetch } = connector(account());
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(calls(fetch)[0]).toBe("POST /search");
    expect(parseNotionCursor(out.at(-1)!.cursor)).toMatchObject({ pass: "historical", since: SINCE });
  });

  it("asks only for pages edited since the last pass began, less five minutes", async () => {
    expect(NOTION_OVERLAP_MS).toBe(300_000);
    const { memory, pipeline } = testPipeline();
    const first = connector(account(), { now: () => new Date("2026-11-07T12:00:00.000Z") });
    await runSync({ connector: first.c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const next = connector(account(), { now: () => new Date("2026-11-08T12:00:00.000Z") });
    const report = await runSync({ connector: next.c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // Nothing changed since, so only the data sources are read again, as duplicates.
    expect(report).toMatchObject({ ingested: 0, duplicates: 3 });
    expect(JSON.parse((await memory.getCheckpoint(TEST_ORG, "notion", "incremental"))!)).toMatchObject({ pass: "incremental", sources: [], since: "2026-11-07T11:55:00.000Z", nextFrom: "2026-11-08T11:55:00.000Z" });
  });

  it("looks back 24 hours, or as long as it is told, when there is no checkpoint", async () => {
    const { c } = connector(account());
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(parseNotionCursor(out.at(-1)!.cursor)!.since).toBe("2026-11-05T12:00:00.000Z");
    const short = connector(account(), { incrementalLookbackHours: 2 });
    const shortOut = await batches(short.c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(parseNotionCursor(shortOut.at(-1)!.cursor)!.since).toBe("2026-11-06T10:00:00.000Z");
  });

  it("resumes an interrupted incremental pass, and starts the next after a historical one", async () => {
    const saved: NotionCursor = { pass: "incremental", sources: [REPAIRS], from: "2026-10-31T00:00:00.000Z", since: "2026-10-31T00:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" };
    const { c, fetch } = connector(account());
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(calls(fetch)).toEqual([`GET /data_sources/${REPAIRS}`, `POST /data_sources/${REPAIRS}/query`]);
    expect(out.flatMap((b) => b.events).map((e) => e.payload.itemId)).toEqual([notionRef("page", PAGE.one)]);

    const finishedImport: NotionCursor = { ...saved, pass: "historical", sources: [], from: null };
    const next = connector(account());
    const nextOut = await batches(next.c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(finishedImport) }));
    expect(calls(next.fetch)[0]).toBe("POST /search");
    expect(parseNotionCursor(nextOut.at(-1)!.cursor)).toMatchObject({ pass: "incremental", since: "2026-11-01T00:00:00.000Z" });
    const finishedPass: NotionCursor = { ...finishedImport, pass: "incremental" };
    const again = connector(account());
    await batches(again.c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(finishedPass) }));
    expect(calls(again.fetch)[0]).toBe("POST /search");
  });

  it("asks again from the latest edit read when Notion stops a query at its limit", async () => {
    const data = account({ resultLimit: 2 });
    data.pages[MEMOS] = [memo(PAGE.memo1, "2026-10-15T09:00:00.000Z", 1), memo(PAGE.memo2, "2026-10-16T09:00:00.000Z", 2), memo(PAGE.else1, "2026-10-17T09:00:00.000Z", 3)];
    const { c } = connector(data, { dataSources: [MEMOS] });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // The memo edited at the limit is read twice, the second time as a duplicate.
    expect(report).toMatchObject({ ingested: 4, duplicates: 1 });
    expect(memory.events.filter((e) => e.type === "work.item_updated").map((e) => e.payload.itemId)).toEqual([PAGE.memo1, PAGE.memo2, PAGE.else1].map((p) => notionRef("page", p)));
  });

  it("stops rather than loop when more pages than one query can read share an edit time", async () => {
    const data = account({ resultLimit: 1 });
    data.pages[MEMOS] = [memo(PAGE.memo1, "2026-10-15T09:00:00.000Z", 1), memo(PAGE.memo2, "2026-10-15T09:00:00.000Z", 2)];
    const { c, fetch } = connector(data, { dataSources: [MEMOS] });
    await expect(batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow(`Notion has more than 10,000 pages in data source ${MEMOS} edited at 2026-10-15T09:00:00.000Z`);
    expect(queries(fetch)).toHaveLength(2);
  });

  it("stops on any other error, leaving runSync to retry from the checkpoint", async () => {
    const { c } = connector(account({ token: "y".repeat(40) }));
    await expect(runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG, attempts: 1 })).rejects.toThrow(/turned down the token/);
    const blocked = scripted([json(200, LIST([{ object: "data_source", id: MEMOS }])), json(403, {})]);
    const c403 = notionConnector({ token: TOKEN, now: () => NOW, fetch: blocked.fetch, sleep: noSleep });
    await expect(batches(c403.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toMatchObject({ status: 403 });
    const late = scripted([json(200, LIST([{ object: "data_source", id: MEMOS }])), json(200, { object: "data_source", id: MEMOS, properties: { C: { id: "ca", type: "number" } } }), json(404, {})]);
    const c404 = notionConnector({ token: TOKEN, now: () => NOW, fetch: late.fetch, sleep: noSleep });
    await expect(batches(c404.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toMatchObject({ status: 404 });
  });

  it("waits out Notion's rate limit and carries on", async () => {
    const waits: number[] = [];
    const { c } = connector(account({ rateLimited: 2, retryAfter: "3" }), { sleep: async (ms) => void waits.push(ms) });
    const report = await runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(waits).toEqual([3000, 3000]);
    expect(report.ingested).toBe(6);
  });

  it("finishes cleanly when nothing is shared with the connection", async () => {
    const { c } = connector(account({ dataSources: [] }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(out).toHaveLength(1);
    expect(parseNotionCursor(out[0]!.cursor)).toMatchObject({ sources: [], pass: "historical" });
  });

  it("skips results and data sources with no usable id, and pages, without reading anything for them", async () => {
    const { fetch, sent } = scripted([
      json(200, LIST([{ object: "data_source", id: "bad" }, { object: "page", id: PAGE.one }, {}, { object: "data_source", id: NOTES }, { object: "data_source", id: MEMOS.toUpperCase() }, { object: "data_source", id: MEMOS }])),
      json(200, { object: "data_source", id: "not-an-id" }),
      json(200, { object: "data_source", id: MEMOS, properties: { C: { id: "ca", type: "number" } } }),
      json(200, LIST([{ object: "page", id: "../x", last_edited_time: "2026-10-01T00:00:00.000Z" }, { object: "page", id: PAGE.memo1, last_edited_time: "2026-10-01T00:00:00.000Z", properties: {} }])),
    ]);
    const c = notionConnector({ token: TOKEN, now: () => NOW, fetch, sleep: noSleep });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(sent.map((u) => u.pathname.replace("/v1", ""))).toEqual(["/search", `/data_sources/${NOTES}`, `/data_sources/${MEMOS}`, `/data_sources/${MEMOS}/query`]);
    expect(out.flatMap((b) => b.events).map((e) => String(e.payload.itemId ?? e.payload.boardId))).toEqual([notionRef("data_source", MEMOS), notionRef("page", PAGE.memo1)]);
  });

  it("checkpoints the latest edit read even when a page of results comes back out of order", async () => {
    const source = { object: "data_source", id: MEMOS, properties: { C: { id: "ca", type: "number" } } };
    const late = { object: "page", id: PAGE.memo2, last_edited_time: "2026-10-02T00:00:00.000Z", properties: {} };
    const early = { object: "page", id: PAGE.memo1, last_edited_time: "2026-10-01T00:00:00.000Z", properties: {} };
    const client = {
      dataSources: async () => ({ data: [], next: null }),
      dataSource: async () => source,
      pages: async (_id: string, _p: readonly string[], _from: string, cursor?: string | null) => (cursor ? { data: [], next: null, complete: true } : { data: [late, early], next: "cursor-2", complete: true }),
    };
    const c = notionConnector({ token: TOKEN, now: () => NOW, client, dataSources: [MEMOS] });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(parseNotionCursor(out[1]!.cursor!)!.from).toBe("2026-10-02T00:00:00.000Z");
  });

  it("keeps at most 1,000 data sources, so the checkpoint stays bounded", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ object: "data_source", id: uid("e", i.toString().padStart(4, "f")) }));
    const client = {
      dataSources: async () => ({ data: many, next: null }),
      dataSource: async (id: string) => ({ object: "data_source", id, properties: {} }),
      pages: async () => {
        throw new Error("never queried");
      },
    };
    const c = notionConnector({ token: TOKEN, now: () => NOW, client });
    const first = await c.historicalImport({ organizationId: TEST_ORG, cursor: null })[Symbol.asyncIterator]().next();
    expect(parseNotionCursor((first.value as { cursor: string }).cursor)!.sources).toHaveLength(1000);
  });

  it("declares creating and changing a page, and turns both down while writes are off", async () => {
    const { c } = connector(account());
    expect(c.writes).toBe(NOTION_WRITES);
    expect(NOTION_WRITES.map((w) => w.name)).toEqual(["create_page", "update_page"]);
    expect(NOTION_WRITES.every((w) => w.integration === "notion")).toBe(true);
    const audit = await assertWritesRefused(c);
    expect(audit.map((entry) => entry.action)).toEqual(["create_page", "update_page"]);
    expect(audit.every((entry) => entry.outcome === "refused")).toBe(true);
    expect("handleWebhook" in c).toBe(false);
    expect(c.source).toBe("notion");
  });
});
