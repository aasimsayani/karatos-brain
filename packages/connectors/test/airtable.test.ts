import { describe, expect, it } from "vitest";
import { runSync } from "@karatos/core";
import {
  TEST_ORG,
  airtableDocMock,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  docMockFetch,
  testPipeline,
  type AirtableMockData,
  type AirtableMockField,
  type AirtableMockRecord,
} from "@karatos/connector-testkit";
import {
  AIRTABLE_API,
  AIRTABLE_MAX_FIELDS,
  AIRTABLE_OVERLAP_MS,
  AIRTABLE_PAGE_SIZE,
  AIRTABLE_RATE_LIMIT_WAIT_MS,
  AIRTABLE_SAFE_FIELD_TYPES,
  AIRTABLE_WRITES,
  AirtableApiError,
  AirtableConfigError,
  AirtableOffsetExpiredError,
  airtableChangedAfter,
  airtableClient,
  airtableConnector,
  airtableDay,
  airtableFieldValues,
  airtableRecordEvents,
  airtableRef,
  airtableSafeFields,
  airtableTable,
  airtableTableEvents,
  airtableTime,
  parseAirtableBases,
  parseAirtableCursor,
  type AirtableCursor,
  type AirtableOptions,
  type AirtableTable,
} from "../src/index.js";

const TOKEN = ["pat", "x".repeat(14), ".", "x".repeat(64)].join("");
const NOW = new Date("2026-11-06T12:00:00.000Z");
const RECEIVED = NOW.toISOString();
const noSleep = async () => {};
/** An Airtable id: the kind's three letters, then a tag padded to 14 characters. */
const aid = (kind: string, tag: string) => `${kind}${(tag + "x".repeat(14)).slice(0, 14)}`;

const SHOP = aid("app", "Shop");
const OTHER = aid("app", "Other");
const REPAIRS = aid("tbl", "Repairs");
const NOTES = aid("tbl", "Notes");
const MEMOS = aid("tbl", "Memos");
const F = {
  name: aid("fld", "Name"),
  phone: aid("fld", "Phone"),
  notes: aid("fld", "Notes"),
  stage: aid("fld", "Stage"),
  quote: aid("fld", "Quote"),
  due: aid("fld", "Due"),
  done: aid("fld", "Done"),
  metals: aid("fld", "Metals"),
  memo: aid("fld", "Memo"),
  changed: aid("fld", "Changed"),
  summary: aid("fld", "Summary"),
  carats: aid("fld", "Carats"),
  out: aid("fld", "Out"),
  text: aid("fld", "Text"),
};
const rec = (tag: string) => aid("rec", tag);

const REPAIR_FIELDS: AirtableMockField[] = [
  { id: F.name, name: "Customer name", type: "singleLineText" },
  { id: F.phone, name: "Phone", type: "phoneNumber" },
  { id: F.notes, name: "Notes", type: "multilineText" },
  { id: F.stage, name: "Stage", type: "singleSelect", options: { choices: [{ id: aid("sel", "Bench"), name: "At the bench" }] } },
  { id: F.quote, name: "Quote", type: "currency", options: { precision: 2, symbol: "$" } },
  { id: F.due, name: "Due", type: "date" },
  { id: F.done, name: "Picked up", type: "checkbox" },
  { id: F.metals, name: "Metals", type: "multipleSelects" },
  { id: F.memo, name: "Memo", type: "multipleRecordLinks" },
  { id: F.changed, name: "Last changed", type: "lastModifiedTime" },
  { id: F.summary, name: "Summary", type: "formula" },
];

function repair(tag: string, createdTime: string, extra: Partial<AirtableMockRecord> = {}): AirtableMockRecord {
  return {
    id: rec(tag),
    createdTime,
    fields: {
      "Customer name": `Test Customer ${tag}`,
      Phone: "+1 212 555 0101",
      Notes: `Call customer${tag}@example.test when ready`,
      Stage: "At the bench",
      Quote: 250,
      Due: "2026-11-10",
      "Picked up": false,
      Metals: ["Gold", "Platinum"],
      Memo: [rec("Memo1")],
      "Last changed": createdTime,
      Summary: `Test Customer ${tag} ring resize`,
    },
    ...extra,
  };
}

/**
 * Against NOW (2026-11-06 noon): the history window starts 2021-11-06. One
 * base with three tables: repairs (one record outside the window, one whose
 * time doesn't read), a table of text only, and memos.
 */
function account(extra: Partial<AirtableMockData> = {}): AirtableMockData {
  return {
    token: TOKEN,
    bases: [
      { id: SHOP, name: "Test Shop" },
      { id: OTHER, name: "Other base" },
    ].slice(0, 1),
    tables: {
      [SHOP]: [
        { id: REPAIRS, name: "Repairs", primaryFieldId: F.name, fields: REPAIR_FIELDS },
        { id: NOTES, name: "Notes", primaryFieldId: F.text, fields: [{ id: F.text, name: "Note", type: "multilineText" }] },
        { id: MEMOS, name: "Memos", primaryFieldId: F.carats, fields: [{ id: F.carats, name: "Carats", type: "number" }, { id: F.out, name: "Out at", type: "dateTime" }] },
      ],
      [OTHER]: [{ id: aid("tbl", "Elsewhere"), name: "Elsewhere", primaryFieldId: F.carats, fields: [{ id: F.carats, name: "Carats", type: "number" }] }],
    },
    records: {
      [REPAIRS]: [
        repair("One", "2026-01-01T09:00:00.000Z", { lastModified: "2026-11-01T10:00:00.000Z" }),
        repair("Two", "2026-10-01T09:00:00.000Z"),
        repair("Old", "2020-01-01T09:00:00.000Z", { lastModified: "2020-02-01T09:00:00.000Z" }),
        repair("Bad", "2026-09-01 10:00:00Z"),
      ],
      [NOTES]: [{ id: rec("Note1"), createdTime: "2026-10-01T09:00:00.000Z", fields: { Note: "Test Customer prefers yellow gold" } }],
      [MEMOS]: [{ id: rec("Memo1"), createdTime: "2026-10-15T09:00:00.000Z", fields: { Carats: 1.5, "Out at": "2026-10-15T10:00:00.000Z" } }],
      [aid("tbl", "Elsewhere")]: [{ id: rec("Else1"), createdTime: "2026-10-15T09:00:00.000Z", fields: { Carats: 2 } }],
    },
    ...extra,
  };
}

const bothBases = () => account({ bases: [{ id: SHOP, name: "Test Shop" }, { id: OTHER, name: "Other base" }] });

function connector(data: AirtableMockData, options: Partial<AirtableOptions> = {}) {
  const fetch = docMockFetch(airtableDocMock(data));
  const c = airtableConnector({ token: TOKEN, now: () => NOW, fetch, sleep: noSleep, ...options });
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
  return { fetch: fetch as typeof globalThis.fetch, sent, inits };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const paths = (fetch: { calls: { url: string }[] }) => fetch.calls.map((call) => new URL(call.url).pathname.replace("/v0", ""));
const recordCalls = (fetch: { calls: { url: string }[] }) => fetch.calls.map((call) => new URL(call.url)).filter((u) => /^\/v0\/app/.test(u.pathname));

async function batches(iterable: AsyncIterable<{ events: unknown[]; cursor: string | null }>) {
  const out: { events: { type: string; occurredAt?: string; payload: Record<string, unknown> }[]; cursor: string | null }[] = [];
  for await (const b of iterable) out.push(b as (typeof out)[number]);
  return out;
}

const repairsTable = (): AirtableTable => airtableTable({ id: REPAIRS, name: "Repairs", fields: REPAIR_FIELDS }, SHOP)!;

describe("airtableTime and airtableDay", () => {
  it("reads Airtable's times as UTC and its days as calendar days", () => {
    expect(airtableTime("2026-11-01T10:00:00.000Z")).toBe("2026-11-01T10:00:00.000Z");
    expect(airtableTime("2026-11-01T10:00:00.123456Z")).toBe("2026-11-01T10:00:00.123Z");
    expect(airtableTime("2026-11-01T10:00:00-05:00")).toBe("2026-11-01T15:00:00.000Z");
    expect(airtableTime("2026-11-01T10:00Z")).toBe("2026-11-01T10:00:00.000Z");
    for (const bad of ["2026-11-01", "2026-11-01T10:00:00", " 2026-11-01T10:00:00Z", "2026-09-01 10:00:00Z", "2026-13-01T10:00:00Z", 1_700_000_000, null, undefined]) expect(airtableTime(bad), String(bad)).toBeUndefined();
    expect(airtableDay("2026-11-10")).toBe("2026-11-10");
    for (const bad of ["2026-02-30", "2026-11", "2026-11-10T00:00:00Z", "11/10/2026", " 2026-11-10", 20261110, null]) expect(airtableDay(bad), String(bad)).toBeUndefined();
  });
});

describe("airtableTable and airtableSafeFields", () => {
  it("keeps a table's ids, name and field definitions, and nothing else", () => {
    const table = airtableTable(
      { id: REPAIRS, name: " Repairs ", description: "Test Customer intake", fields: [{ id: F.stage, name: "Stage", type: "singleSelect", description: "notes about it" }, { id: "fldbad", name: "x", type: "number" }, { id: F.due }, null, "x"] },
      SHOP,
    );
    expect(table).toEqual({ id: REPAIRS, base: SHOP, name: "Repairs", fields: [{ id: F.stage, name: "Stage", type: "singleSelect" }, { id: F.due, name: F.due, type: "unknown" }] });
    expect(airtableTable({ id: REPAIRS }, SHOP)).toEqual({ id: REPAIRS, base: SHOP, name: `Table ${REPAIRS}`, fields: [] });
    expect(airtableTable({ id: REPAIRS, name: "x".repeat(250), fields: [{ id: F.due, name: "y".repeat(150), type: "date" }] }, SHOP)).toMatchObject({ name: "x".repeat(200), fields: [{ name: "y".repeat(100) }] });
    expect(airtableTable({ id: "tblShort" }, SHOP)).toBeUndefined();
    expect(airtableTable({ id: REPAIRS }, "appShort")).toBeUndefined();
    expect(airtableTable(null, SHOP)).toBeUndefined();
    expect(airtableTable([REPAIRS], SHOP)).toBeUndefined();
  });

  it("reads only the field types that hold no free text, up to the cap", () => {
    expect(AIRTABLE_SAFE_FIELD_TYPES).toEqual(["number", "currency", "percent", "rating", "duration", "autoNumber", "count", "checkbox", "date", "dateTime", "createdTime", "lastModifiedTime", "singleSelect", "multipleSelects", "multipleRecordLinks"]);
    expect(airtableSafeFields(repairsTable()).map((f) => f.name)).toEqual(["Stage", "Quote", "Due", "Picked up", "Metals", "Memo", "Last changed"]);
    const unsafe = ["singleLineText", "multilineText", "richText", "email", "url", "phoneNumber", "multipleAttachments", "singleCollaborator", "multipleCollaborators", "createdBy", "lastModifiedBy", "barcode", "button", "formula", "rollup", "multipleLookupValues", "aiText", "externalSyncSource", "unknown"];
    const table: AirtableTable = { id: REPAIRS, base: SHOP, name: "R", fields: unsafe.map((type, i) => ({ id: aid("fld", `U${i}`), name: type, type })) };
    expect(airtableSafeFields(table)).toEqual([]);
    const wide: AirtableTable = { id: REPAIRS, base: SHOP, name: "R", fields: Array.from({ length: AIRTABLE_MAX_FIELDS + 5 }, (_, i) => ({ id: aid("fld", `N${i}`), name: `n${i}`, type: "number" })) };
    expect(AIRTABLE_MAX_FIELDS).toBe(200);
    expect(airtableSafeFields(wide)).toHaveLength(200);
    expect(airtableSafeFields(wide)[0]!.name).toBe("n0");
  });
});

describe("airtableFieldValues", () => {
  it("shapes each read field's value, and leaves the others out", () => {
    const fields = (["number", "currency", "percent", "rating", "duration", "autoNumber", "count"] as const).map((type) => ({ id: aid("fld", type), name: type, type }));
    const table: AirtableTable = {
      id: REPAIRS,
      base: SHOP,
      name: "R",
      fields: [
        ...fields,
        { id: aid("fld", "check"), name: "c", type: "checkbox" },
        { id: aid("fld", "date"), name: "d", type: "date" },
        { id: aid("fld", "dateTime"), name: "dt", type: "dateTime" },
        { id: aid("fld", "created"), name: "ct", type: "createdTime" },
        { id: aid("fld", "modified"), name: "mt", type: "lastModifiedTime" },
        { id: aid("fld", "select"), name: "s", type: "singleSelect" },
        { id: aid("fld", "multi"), name: "m", type: "multipleSelects" },
        { id: aid("fld", "links"), name: "l", type: "multipleRecordLinks" },
        { id: aid("fld", "text"), name: "t", type: "singleLineText" },
      ],
    };
    const values = airtableFieldValues(table, {
      [aid("fld", "number")]: 12.5,
      [aid("fld", "currency")]: Number.POSITIVE_INFINITY,
      [aid("fld", "percent")]: "0.5",
      [aid("fld", "rating")]: 4,
      [aid("fld", "duration")]: 3600,
      [aid("fld", "autoNumber")]: 7,
      [aid("fld", "check")]: true,
      [aid("fld", "date")]: "2026-02-30",
      [aid("fld", "dateTime")]: "2026-11-10T15:00:00.000Z",
      [aid("fld", "created")]: "soon",
      [aid("fld", "modified")]: "2026-11-01T10:00:00.000Z",
      [aid("fld", "select")]: " Rush ",
      [aid("fld", "multi")]: ["Gold", "", 3, "y".repeat(150)],
      [aid("fld", "links")]: [rec("A"), { id: rec("B"), name: "Test Customer" }, "recShort", null],
      [aid("fld", "text")]: "Test Customer",
    });
    expect(values).toEqual({
      [aid("fld", "number")]: { type: "number", value: 12.5 },
      [aid("fld", "currency")]: { type: "currency", value: null },
      [aid("fld", "percent")]: { type: "percent", value: null },
      [aid("fld", "rating")]: { type: "rating", value: 4 },
      [aid("fld", "duration")]: { type: "duration", value: 3600 },
      [aid("fld", "autoNumber")]: { type: "autoNumber", value: 7 },
      [aid("fld", "count")]: { type: "count", value: null },
      [aid("fld", "check")]: { type: "checkbox", value: true },
      [aid("fld", "date")]: { type: "date", value: null },
      [aid("fld", "dateTime")]: { type: "dateTime", value: "2026-11-10T15:00:00.000Z" },
      [aid("fld", "created")]: { type: "createdTime", value: null },
      [aid("fld", "modified")]: { type: "lastModifiedTime", value: "2026-11-01T10:00:00.000Z" },
      [aid("fld", "select")]: { type: "singleSelect", value: "Rush" },
      [aid("fld", "multi")]: { type: "multipleSelects", value: ["Gold", "y".repeat(100)] },
      [aid("fld", "links")]: { type: "multipleRecordLinks", value: [airtableRef("record", rec("A")), airtableRef("record", rec("B"))] },
    });
    // Airtable leaves empty fields out, so a missing one is empty: false for a checkbox, an empty list for a list.
    const blank = airtableFieldValues(table, {});
    expect(blank[aid("fld", "check")]).toEqual({ type: "checkbox", value: false });
    expect(blank[aid("fld", "multi")]).toEqual({ type: "multipleSelects", value: [] });
    expect(blank[aid("fld", "links")]).toEqual({ type: "multipleRecordLinks", value: [] });
    expect(blank[aid("fld", "select")]).toEqual({ type: "singleSelect", value: null });
    expect(airtableFieldValues(table, { [aid("fld", "check")]: "true" })[aid("fld", "check")]!.value).toBe(false);
    expect(airtableFieldValues(table, "nope")[aid("fld", "number")]).toEqual({ type: "number", value: null });
    expect(airtableFieldValues(table, [12])[aid("fld", "number")]).toEqual({ type: "number", value: null });
  });
});

describe("the Airtable normalizer", () => {
  it("makes a table a board, with every field as a column marked with whether it is read", () => {
    const [e] = airtableTableEvents(repairsTable(), " Test Shop ", RECEIVED);
    expect(e).toMatchObject({ type: "work.board_updated", occurredAt: RECEIVED, receivedAt: RECEIVED });
    expect(e!.payload).toEqual({
      boardId: airtableRef("table", REPAIRS),
      baseId: airtableRef("base", SHOP),
      baseName: "Test Shop",
      name: "Repairs",
      state: "active",
      columns: REPAIR_FIELDS.map((f) => ({ id: f.id, type: f.type, title: f.name, read: !["singleLineText", "phoneNumber", "multilineText", "formula"].includes(f.type) })),
    });
    expect(e!.idempotencyKey).toMatch(new RegExp(`^airtable:table:${REPAIRS}:[0-9a-f]{16}$`));
    expect(e!.id).toBe(`airtable_${e!.idempotencyKey.slice("airtable:".length)}`);
    // The same table seen later is a duplicate; a changed one is a new version.
    const [later] = airtableTableEvents(repairsTable(), "Test Shop", "2026-11-07T12:00:00.000Z");
    expect(later!.idempotencyKey).toBe(e!.idempotencyKey);
    const renamed = airtableTableEvents({ ...repairsTable(), name: "Repair intake" }, "Test Shop", RECEIVED)[0]!;
    expect(renamed.idempotencyKey).not.toBe(e!.idempotencyKey);
    const noName = airtableTableEvents(repairsTable(), undefined, RECEIVED)[0]!;
    expect(noName.payload).not.toHaveProperty("baseName");
    expect(airtableTableEvents(repairsTable(), "  ", RECEIVED)[0]!.payload).not.toHaveProperty("baseName");
  });

  it("makes a record an item with only its read fields, never a name, phone or note", () => {
    const raw = repair("One", "2026-01-01T09:00:00.000Z");
    const fields = Object.fromEntries(REPAIR_FIELDS.map((f) => [f.id, raw.fields[f.name]]));
    fields[F.changed] = "2026-11-01T10:00:00.000Z";
    const [e] = airtableRecordEvents({ id: rec("One"), createdTime: raw.createdTime, fields }, repairsTable(), RECEIVED);
    expect(e).toMatchObject({ type: "work.item_updated", occurredAt: "2026-11-01T10:00:00.000Z", receivedAt: RECEIVED });
    expect(e!.payload).toEqual({
      itemId: airtableRef("record", rec("One")),
      boardId: airtableRef("table", REPAIRS),
      baseId: airtableRef("base", SHOP),
      state: "active",
      createdAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-11-01T10:00:00.000Z",
      columns: {
        [F.stage]: { type: "singleSelect", value: "At the bench" },
        [F.quote]: { type: "currency", value: 250 },
        [F.due]: { type: "date", value: "2026-11-10" },
        [F.done]: { type: "checkbox", value: false },
        [F.metals]: { type: "multipleSelects", value: ["Gold", "Platinum"] },
        [F.memo]: { type: "multipleRecordLinks", value: [airtableRef("record", rec("Memo1"))] },
        [F.changed]: { type: "lastModifiedTime", value: "2026-11-01T10:00:00.000Z" },
      },
    });
    expect(JSON.stringify(e)).not.toMatch(/Test Customer|example\.test|ring resize|555/);
    expect(e!.idempotencyKey).toMatch(new RegExp(`^airtable:record:${rec("One")}:[0-9a-f]{16}$`));
    expect(e!.id).toMatch(/^airtable_[A-Za-z0-9_.:-]+$/);
  });

  it("keys each version by what was read, so a replay is a duplicate and a change is new", () => {
    const table = repairsTable();
    const one = (fields: Record<string, unknown>) => airtableRecordEvents({ id: rec("One"), createdTime: "2026-01-01T09:00:00.000Z", fields }, table, RECEIVED)[0]!;
    const first = one({ [F.quote]: 250 });
    expect(airtableRecordEvents({ id: rec("One"), createdTime: "2026-01-01T09:00:00.000Z", fields: { [F.quote]: 250 } }, table, "2026-11-07T00:00:00.000Z")[0]!.idempotencyKey).toBe(first.idempotencyKey);
    expect(one({ [F.quote]: 300 }).idempotencyKey).not.toBe(first.idempotencyKey);
    // A record made again with the same values is a new record version.
    expect(airtableRecordEvents({ id: rec("One"), createdTime: "2026-02-01T09:00:00.000Z", fields: { [F.quote]: 250 } }, table, RECEIVED)[0]!.idempotencyKey).not.toBe(first.idempotencyKey);
    // A text field changing isn't read, so it isn't a new version.
    expect(one({ [F.quote]: 250, [F.notes]: "Test Customer called" }).idempotencyKey).toBe(first.idempotencyKey);
  });

  it("times a record by its latest last modified field, else when it was made", () => {
    const table: AirtableTable = { ...repairsTable(), fields: [...repairsTable().fields, { id: aid("fld", "Changed2"), name: "Stage changed", type: "lastModifiedTime" }] };
    const both = airtableRecordEvents({ id: rec("One"), createdTime: "2026-01-01T09:00:00.000Z", fields: { [F.changed]: "2026-11-01T10:00:00.000Z", [aid("fld", "Changed2")]: "2026-11-03T10:00:00.000Z" } }, table, RECEIVED)[0]!;
    expect(both.occurredAt).toBe("2026-11-03T10:00:00.000Z");
    const reversed = airtableRecordEvents({ id: rec("One"), createdTime: "2026-01-01T09:00:00.000Z", fields: { [F.changed]: "2026-11-04T10:00:00.000Z", [aid("fld", "Changed2")]: "2026-11-03T10:00:00.000Z" } }, table, RECEIVED)[0]!;
    expect(reversed.occurredAt).toBe("2026-11-04T10:00:00.000Z");
    // Other time fields, such as when a repair is due back, aren't when the record changed.
    const times: AirtableTable = { ...table, fields: [...table.fields, { id: aid("fld", "Back"), name: "Back at", type: "dateTime" }, { id: aid("fld", "Made"), name: "Made", type: "createdTime" }] };
    const due = airtableRecordEvents({ id: rec("One"), createdTime: "2026-01-01T09:00:00.000Z", fields: { [F.changed]: "2026-11-01T10:00:00.000Z", [aid("fld", "Back")]: "2026-12-01T10:00:00.000Z", [aid("fld", "Made")]: "2026-12-02T10:00:00.000Z" } }, times, RECEIVED)[0]!;
    expect(due.occurredAt).toBe("2026-11-01T10:00:00.000Z");
    const none = airtableRecordEvents({ id: rec("One"), createdTime: "2026-01-01T09:00:00.000Z", fields: {} }, table, RECEIVED)[0]!;
    expect(none).toMatchObject({ occurredAt: "2026-01-01T09:00:00.000Z", payload: { updatedAt: "2026-01-01T09:00:00.000Z" } });
  });

  it("dead-letters a record whose created time doesn't read and drops one with no id", () => {
    const [e] = airtableRecordEvents({ id: rec("Bad"), createdTime: "2026-09-01 10:00:00Z", fields: { [F.changed]: "2026-11-01T10:00:00.000Z" } }, repairsTable(), RECEIVED);
    expect(e!.occurredAt).toBeUndefined();
    expect(e!.payload).not.toHaveProperty("createdAt");
    expect(e!.payload).not.toHaveProperty("updatedAt");
    expect(airtableRecordEvents({ createdTime: "2026-01-01T09:00:00.000Z" }, repairsTable(), RECEIVED)).toEqual([]);
    expect(airtableRecordEvents({ id: "rec../x", createdTime: "2026-01-01T09:00:00.000Z" }, repairsTable(), RECEIVED)).toEqual([]);
    expect(airtableRecordEvents(null as unknown as Record<string, unknown>, repairsTable(), RECEIVED)).toEqual([]);
  });
});

describe("the Airtable client", () => {
  it("checks the token's shape before sending anything", () => {
    for (const bad of ["", "short", `${"x".repeat(30)} spaced`, `${"x".repeat(30)}\n`, `pat${"x".repeat(20)}/x`]) expect(() => airtableClient({ token: bad }), JSON.stringify(bad)).toThrow(AirtableConfigError);
    expect(() => airtableClient({ token: "x".repeat(4097) })).toThrow(/AIRTABLE_ACCESS_TOKEN/);
    expect(() => airtableClient({ token: "x".repeat(20) })).not.toThrow();
    expect(() => airtableClient({ token: "x".repeat(19) })).toThrow(AirtableConfigError);
  });

  it("sends only GETs to Airtable's own address, with the token as a bearer", async () => {
    const { fetch, sent, inits } = scripted([json(200, { id: aid("usr", "Me") })]);
    expect(await airtableClient({ token: TOKEN, fetch }).scopes()).toBeNull();
    expect(sent[0]!.toString()).toBe(`${AIRTABLE_API}/meta/whoami`);
    expect(inits[0]).toMatchObject({ method: "GET", headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" } });
  });

  it("reports an OAuth token's scopes, and turns down scopes that aren't names", async () => {
    const ok = scripted([json(200, { id: aid("usr", "Me"), scopes: ["data.records:read", "schema.bases:read"] })]);
    expect(await airtableClient({ token: TOKEN, fetch: ok.fetch }).scopes()).toEqual(["data.records:read", "schema.bases:read"]);
    for (const scopes of ["data.records:read", [1], null]) {
      const bad = scripted([json(200, { id: aid("usr", "Me"), scopes })]);
      await expect(airtableClient({ token: TOKEN, fetch: bad.fetch }).scopes(), JSON.stringify(scopes)).rejects.toThrow(/scopes that aren't a list/);
    }
  });

  it("asks for a page of records with only the named fields, by id, and the filter it builds", async () => {
    const { fetch, sent } = scripted([
      json(200, { records: [{ id: rec("One"), createdTime: "2026-01-01T09:00:00.000Z", fields: { [F.quote]: 250, [F.name]: "Test Customer", "Customer name": "Test Customer" } }, "junk"], offset: `itr${"x".repeat(14)}/${rec("Two")}` }),
      json(200, { records: [] }),
    ]);
    const client = airtableClient({ token: TOKEN, fetch });
    const first = await client.records(SHOP, REPAIRS, [F.quote, F.due], "2026-11-01T00:00:00.000Z");
    // A field that wasn't asked for is dropped, whatever came back.
    expect(first).toEqual({ data: [{ id: rec("One"), createdTime: "2026-01-01T09:00:00.000Z", fields: { [F.quote]: 250 } }, { id: undefined, createdTime: undefined, fields: {} }], next: `itr${"x".repeat(14)}/${rec("Two")}` });
    await client.records(SHOP, REPAIRS, [F.quote], null, first.next);
    expect(sent.map((u) => u.origin + u.pathname)).toEqual([`${AIRTABLE_API}/${SHOP}/${REPAIRS}`, `${AIRTABLE_API}/${SHOP}/${REPAIRS}`]);
    expect([...sent[0]!.searchParams]).toEqual([
      ["pageSize", String(AIRTABLE_PAGE_SIZE)],
      ["returnFieldsByFieldId", "true"],
      ["fields[]", F.quote],
      ["fields[]", F.due],
      ["filterByFormula", "OR(IS_AFTER(LAST_MODIFIED_TIME(),'2026-11-01T00:00:00.000Z'),IS_AFTER(CREATED_TIME(),'2026-11-01T00:00:00.000Z'))"],
    ]);
    expect([...sent[1]!.searchParams]).toEqual([
      ["pageSize", "100"],
      ["returnFieldsByFieldId", "true"],
      ["fields[]", F.quote],
      ["offset", `itr${"x".repeat(14)}/${rec("Two")}`],
    ]);
  });

  it("asks for bases and a base's tables at their documented paths, paging bases by offset", async () => {
    const { fetch, sent } = scripted([json(200, { bases: [{ id: SHOP }], offset: `itr${"x".repeat(14)}` }), json(200, { bases: [] }), json(200, { tables: [{ id: REPAIRS }, 5] })]);
    const client = airtableClient({ token: TOKEN, fetch });
    expect(await client.bases()).toEqual({ data: [{ id: SHOP }], next: `itr${"x".repeat(14)}` });
    expect(await client.bases(`itr${"x".repeat(14)}`)).toEqual({ data: [], next: null });
    expect(await client.tables(SHOP)).toEqual([{ id: REPAIRS }, {}]);
    expect(sent.map((u) => u.pathname + u.search)).toEqual(["/v0/meta/bases", `/v0/meta/bases?offset=itr${"x".repeat(14)}`, `/v0/meta/bases/${SHOP}/tables`]);
  });

  it("turns down ids, fields, times and offsets that aren't Airtable's before sending them", async () => {
    const { fetch, sent } = scripted([]);
    const client = airtableClient({ token: TOKEN, fetch });
    await expect(client.tables(`${SHOP}/../x`)).rejects.toThrow(/base id/);
    await expect(client.tables(REPAIRS)).rejects.toThrow(/base id/);
    await expect(client.records(REPAIRS, REPAIRS, [F.quote], null)).rejects.toThrow(/base id/);
    await expect(client.records(SHOP, "Repairs", [F.quote], null)).rejects.toThrow(/table id/);
    await expect(client.records(SHOP, `${REPAIRS}/x`, [F.quote], null)).rejects.toThrow(/table id/);
    await expect(client.records(SHOP, `x${REPAIRS}`, [F.quote], null)).rejects.toThrow(/table id/);
    await expect(client.records(SHOP, REPAIRS, ["Quote"], null)).rejects.toThrow(/field id/);
    await expect(client.records(SHOP, REPAIRS, [], null)).rejects.toThrow(/must name its fields/);
    await expect(client.records(SHOP, REPAIRS, Array.from({ length: 201 }, (_, i) => aid("fld", `N${i}`)), null)).rejects.toThrow(/at most 200 fields/);
    await expect(client.records(SHOP, REPAIRS, [F.quote], "2026-11-01")).rejects.toThrow(/UTC time/);
    await expect(client.records(SHOP, REPAIRS, [F.quote], "2026-11-01T00:00:00.000Z') , TRUE()")).rejects.toThrow(/UTC time/);
    await expect(client.records(SHOP, REPAIRS, [F.quote], null, "a&b=c")).rejects.toThrow(/offset/);
    await expect(client.records(SHOP, REPAIRS, [F.quote], null, "x".repeat(257))).rejects.toThrow(/offset/);
    await expect(client.bases("a b")).rejects.toThrow(/offset/);
    expect(sent).toEqual([]);
    expect(() => airtableChangedAfter("2026-02-30T00:00:00.000Z")).toThrow(/UTC time/);
    expect(airtableChangedAfter("2026-02-28T00:00:00.000Z")).toContain("'2026-02-28T00:00:00.000Z'");
    expect(() => airtableChangedAfter("9999-99-99T99:99:99.999Z")).toThrow(/UTC time/);
    await expect(client.records(SHOP, REPAIRS, Array.from({ length: 200 }, (_, i) => aid("fld", `N${i}`)), null)).rejects.toThrow(/unexpected request/);
  });

  it("turns down a reply that isn't a page", async () => {
    const cases: [Response, RegExp, "records" | "bases" | "tables"][] = [
      [json(200, { records: [], offset: "bad offset" }), /page offset/, "records"],
      [json(200, { records: [], offset: 7 }), /page offset/, "records"],
      [json(200, { records: "x" }), /without the records list/, "records"],
      [json(200, []), /isn't a JSON object/, "records"],
      [new Response("not json", { status: 200 }), /isn't a JSON object/, "records"],
      [json(200, { bases: {} }), /without the bases list/, "bases"],
      [json(200, {}), /without the tables list/, "tables"],
    ];
    for (const [i, [response, error, kind]] of cases.entries()) {
      const { fetch } = scripted([response]);
      const client = airtableClient({ token: TOKEN, fetch });
      const call = kind === "records" ? client.records(SHOP, REPAIRS, [F.quote], null) : kind === "bases" ? client.bases() : client.tables(SHOP);
      await expect(call, String(i)).rejects.toThrow(error);
    }
    const { fetch } = scripted([json(200, { records: [], offset: null })]);
    expect(await airtableClient({ token: TOKEN, fetch }).records(SHOP, REPAIRS, [F.quote], null)).toEqual({ data: [], next: null });
  });

  it("says what to fix for each refusal, without the token", async () => {
    const cases: [number, unknown, RegExp][] = [
      [401, { error: { type: "AUTHENTICATION_REQUIRED" } }, /turned down the token: check AIRTABLE_ACCESS_TOKEN/],
      [403, { error: { type: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND" } }, /isn't allowed to read a table's records: it needs the data.records:read and schema.bases:read scopes/],
      [404, { error: "NOT_FOUND" }, /couldn't find a table's records/],
      [422, { error: { type: "LIST_RECORDS_ITERATOR_NOT_AVAILABLE" } }, /HTTP 422 for a table's records/],
      [500, {}, /HTTP 500 for a table's records/],
    ];
    for (const [status, body, message] of cases) {
      const { fetch } = scripted([json(status, body)]);
      const error = await airtableClient({ token: TOKEN, fetch }).records(SHOP, REPAIRS, [F.quote], null).catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(AirtableApiError);
      expect(error, String(status)).not.toBeInstanceOf(AirtableOffsetExpiredError);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain(TOKEN);
      expect((error as AirtableApiError).status).toBe(status);
    }
  });

  it("reads a 422 naming an expired iterator, on a request carrying an offset, as an expired offset", async () => {
    const offset = `itr${"x".repeat(14)}/${rec("Two")}`;
    const { fetch } = scripted([json(422, { error: { type: "LIST_RECORDS_ITERATOR_NOT_AVAILABLE", message: "gone" } })]);
    const error = await airtableClient({ token: TOKEN, fetch }).records(SHOP, REPAIRS, [F.quote], null, offset).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AirtableOffsetExpiredError);
    expect(error).toMatchObject({ status: 422, name: "AirtableOffsetExpiredError", message: "Airtable no longer accepts the saved page offset for a table's records" });
    const other = scripted([json(422, { error: { type: "INVALID_FILTER_BY_FORMULA" } })]);
    const notExpired = await airtableClient({ token: TOKEN, fetch: other.fetch }).records(SHOP, REPAIRS, [F.quote], null, offset).catch((e: unknown) => e);
    expect(notExpired).not.toBeInstanceOf(AirtableOffsetExpiredError);
    const bare = scripted([json(422, { error: "LIST_RECORDS_ITERATOR_NOT_AVAILABLE" })]);
    expect(await airtableClient({ token: TOKEN, fetch: bare.fetch }).records(SHOP, REPAIRS, [F.quote], null, offset).catch((e: unknown) => e)).toBeInstanceOf(AirtableOffsetExpiredError);
    const bases = scripted([json(422, { error: { type: "LIST_RECORDS_ITERATOR_NOT_AVAILABLE" } })]);
    expect(await airtableClient({ token: TOKEN, fetch: bases.fetch }).bases(`itr${"x".repeat(14)}`).catch((e: unknown) => e)).not.toBeInstanceOf(AirtableOffsetExpiredError);
  });

  it("waits 30 seconds after a 429, three times, then gives up", async () => {
    expect(AIRTABLE_RATE_LIMIT_WAIT_MS).toBe(30_000);
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const limited = () => json(429, { errors: [{ error: "RATE_LIMIT_REACHED" }] });
    const { fetch } = scripted([limited(), limited(), json(200, { bases: [] })]);
    await airtableClient({ token: TOKEN, fetch, sleep }).bases();
    expect(waits).toEqual([30_000, 30_000]);

    waits.length = 0;
    const second = scripted([limited(), limited(), limited(), limited()]);
    const error = await airtableClient({ token: TOKEN, fetch: second.fetch, sleep }).bases().catch((e: unknown) => e);
    expect(waits).toEqual([30_000, 30_000, 30_000]);
    expect(error).toMatchObject({ status: 429, message: "Airtable answered HTTP 429 for bases" });
    expect(second.sent).toHaveLength(4);

    const none = scripted([limited()]);
    await expect(airtableClient({ token: TOKEN, fetch: none.fetch, sleep, rateLimitRetries: 0 }).bases()).rejects.toMatchObject({ status: 429 });
  });
});

describe("parseAirtableCursor and parseAirtableBases", () => {
  const good: AirtableCursor = { pass: "incremental", bases: [SHOP, OTHER], tables: [REPAIRS, MEMOS], recordsOffset: `itr${"x".repeat(14)}/${rec("Two")}`, since: "2026-11-05T12:00:00.000Z", nextFrom: "2026-11-06T11:55:00.000Z" };

  it("reads back a checkpoint it wrote and nothing else", () => {
    expect(parseAirtableCursor(null)).toBeNull();
    expect(parseAirtableCursor(JSON.stringify(good))).toEqual(good);
    expect(parseAirtableCursor(JSON.stringify({ ...good, extra: "dropped" }))).toEqual(good);
    const done = { ...good, bases: [], tables: null, recordsOffset: null };
    expect(parseAirtableCursor(JSON.stringify(done))).toEqual(done);
    const listing = { ...good, tables: null, recordsOffset: null };
    expect(parseAirtableCursor(JSON.stringify(listing))).toEqual(listing);
    const emptied = { ...good, tables: [], recordsOffset: null };
    expect(parseAirtableCursor(JSON.stringify(emptied))).toEqual(emptied);
    const bad: unknown[] = [
      "not json",
      "null",
      "[]",
      { ...good, pass: "full" },
      { ...good, bases: ["appShort"] },
      { ...good, bases: SHOP },
      { ...good, bases: Array.from({ length: 1001 }, () => SHOP) },
      { ...good, tables: [SHOP] },
      { ...good, tables: REPAIRS },
      { ...good, tables: Array.from({ length: 1001 }, () => REPAIRS) },
      { ...good, recordsOffset: "a b" },
      { ...good, recordsOffset: 5 },
      { ...good, recordsOffset: "" },
      { ...good, since: null },
      { ...good, since: "2026-11-05" },
      { ...good, since: "2026-11-05T12:00:00Z" },
      { ...good, nextFrom: "2026-02-30T12:00:00.000Z" },
      { ...done, tables: [] },
      { ...done, tables: [REPAIRS] },
      { ...good, tables: null },
      { ...good, tables: [] },
    ];
    for (const raw of bad) expect(() => parseAirtableCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw).slice(0, 80)).toThrow("Airtable checkpoint is not in the expected shape");
  });

  it("reads AIRTABLE_BASE_IDS as base ids separated by commas or spaces", () => {
    expect(parseAirtableBases(undefined)).toBeUndefined();
    expect(parseAirtableBases("  ")).toBeUndefined();
    expect(parseAirtableBases(`${SHOP}, ${OTHER}\n${SHOP}`)).toEqual([SHOP, OTHER]);
    expect(parseAirtableBases(` ${SHOP} `)).toEqual([SHOP]);
    for (const bad of ["Repairs", `${SHOP};${OTHER}`, `${SHOP},${REPAIRS}`, Array.from({ length: 1001 }, () => SHOP).join(",")]) expect(() => parseAirtableBases(bad), bad.slice(0, 40)).toThrow(/AIRTABLE_BASE_IDS/);
  });
});

describe("the Airtable connector", () => {
  it("imports, replays, resumes and retries the mocked account", async () => {
    // Three tables, three records in the window, and one record dead-lettered.
    const result = await checkConnectorSync({ makeConnector: () => connector(account()).c, expected: { ingested: 6, deadLettered: 1 } });
    expect(result.full).toMatchObject({ ingested: 6, deadLettered: 1 });
    expect(result.resume).not.toBeNull();
  });

  it("checks the token, then reads five years of records from every table with a field it reads", async () => {
    const { c, fetch } = connector(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 6, deadLettered: 1 });
    // The text-only table is never asked for its records.
    expect(paths(fetch)).toEqual(["/meta/whoami", "/meta/bases", `/meta/bases/${SHOP}/tables`, `/${SHOP}/${REPAIRS}`, `/${SHOP}/${MEMOS}`]);
    const calls = recordCalls(fetch);
    expect(calls.map((u) => u.searchParams.getAll("fields[]"))).toEqual([
      [F.stage, F.quote, F.due, F.done, F.metals, F.memo, F.changed],
      [F.carats, F.out],
    ]);
    expect(calls.every((u) => u.searchParams.get("filterByFormula") === airtableChangedAfter("2021-11-06T12:00:00.000Z"))).toBe(true);
    const types = memory.events.map((e) => `${e.type} ${String(e.payload.itemId ?? e.payload.boardId)}`).sort();
    expect(types).toEqual(
      [
        `work.board_updated airtable:table:${MEMOS}`,
        `work.board_updated airtable:table:${NOTES}`,
        `work.board_updated airtable:table:${REPAIRS}`,
        `work.item_updated airtable:record:${rec("Memo1")}`,
        `work.item_updated airtable:record:${rec("One")}`,
        `work.item_updated airtable:record:${rec("Two")}`,
      ].sort(),
    );
    expect(memory.events.find((e) => e.payload.boardId === `airtable:table:${NOTES}`)!.payload).toMatchObject({ baseName: "Test Shop", columns: [{ id: F.text, type: "multilineText", title: "Note", read: false }] });
    expect(memory.deadLetters).toHaveLength(1);
    assertSynthetic(memory.events);
    const stored = JSON.stringify(memory.events);
    expect(stored).not.toMatch(/Test Customer|example\.test|ring resize|555|yellow gold/);
  });

  it("would get every field back if it named none, which is why it never does", async () => {
    const { fetch } = connector(account());
    const all = await (await fetch(`${AIRTABLE_API}/${SHOP}/${REPAIRS}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    expect(JSON.stringify(all)).toMatch(/Test Customer/);
    const named = await (await fetch(`${AIRTABLE_API}/${SHOP}/${REPAIRS}?returnFieldsByFieldId=true&fields[]=${F.quote}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
    expect(JSON.stringify(named)).not.toMatch(/Test Customer|555|example\.test/);
  });

  it("reads only the bases it is given, and says which it can't see", async () => {
    const { c, fetch } = connector(bothBases(), { bases: [OTHER] });
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(paths(fetch)).toEqual(["/meta/whoami", "/meta/bases", `/meta/bases/${OTHER}/tables`, `/${OTHER}/${aid("tbl", "Elsewhere")}`]);
    expect(memory.events.find((e) => e.type === "work.board_updated")!.payload).toMatchObject({ baseName: "Other base" });

    const missing = connector(account(), { bases: [OTHER, SHOP] });
    await expect(batches(missing.c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow(`AIRTABLE_BASE_IDS names bases the token can't see: ${OTHER}`);
    expect(paths(missing.fetch)).toEqual(["/meta/whoami", "/meta/bases"]);
    expect(() => airtableConnector({ token: TOKEN, bases: ["Repairs"] })).toThrow(/AIRTABLE_BASE_IDS/);
    expect(() => airtableConnector({ token: TOKEN, bases: [] })).toThrow(/AIRTABLE_BASE_IDS/);
  });

  it("reads every base the token can see, one after another", async () => {
    const { c } = connector(bothBases());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(memory.events.filter((e) => e.type === "work.board_updated").map((e) => e.payload.boardId)).toEqual([REPAIRS, NOTES, MEMOS, aid("tbl", "Elsewhere")].map((t) => `airtable:table:${t}`));
  });

  it("honors a shorter history window", async () => {
    const { c, fetch } = connector(account(), { historyYears: 1 });
    await runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(new Set(recordCalls(fetch).map((u) => u.searchParams.get("filterByFormula")))).toEqual(new Set([airtableChangedAfter("2025-11-06T12:00:00.000Z")]));
    expect(() => airtableConnector({ token: TOKEN, historyYears: 0 })).toThrow(/historyYears/);
    expect(() => airtableConnector({ token: TOKEN, incrementalLookbackHours: 1.5 })).toThrow(/incrementalLookbackHours/);
  });

  it("pages through bases and records by offset, checkpointing each page", async () => {
    const data = { ...bothBases(), pageCap: 1 };
    const { c, fetch } = connector(data);
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(paths(fetch).filter((p) => p === "/meta/bases")).toHaveLength(2);
    expect(recordCalls(fetch).filter((u) => u.pathname.endsWith(REPAIRS)).map((u) => u.searchParams.get("offset"))).toEqual([null, `itrPage1/${rec("Two")}`, `itrPage2/${rec("Bad")}`]);
    const cursors = out.map((b) => parseAirtableCursor(b.cursor)!);
    expect(cursors.map((k) => [k.bases.length, k.tables?.length ?? null, k.recordsOffset])).toEqual([
      [2, 3, null],
      [2, 3, `itrPage1/${rec("Two")}`],
      [2, 3, `itrPage2/${rec("Bad")}`],
      [2, 2, null],
      [2, 0, null],
      [1, 1, null],
      [1, 0, null],
      [0, null, null],
    ]);
    // Three tables, then a record a page (One, Two, Bad), Memo1, the other base's table and its record.
    expect(out.map((b) => b.events.length)).toEqual([3, 1, 1, 1, 1, 1, 1, 0]);
    expect(cursors.every((k) => k.pass === "historical" && k.since === "2021-11-06T12:00:00.000Z" && k.nextFrom === "2026-11-06T11:55:00.000Z")).toBe(true);
  });

  it("resumes an interrupted import where its checkpoint says, and a finished one reads nothing", async () => {
    const saved: AirtableCursor = { pass: "historical", bases: [SHOP], tables: [MEMOS], recordsOffset: null, since: "2021-11-06T12:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" };
    const { c, fetch } = connector(account());
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    // The schema is read again for the table's fields, without sending the tables as new events.
    expect(paths(fetch)).toEqual(["/meta/whoami", `/meta/bases/${SHOP}/tables`, `/${SHOP}/${MEMOS}`]);
    expect(out.flatMap((b) => b.events).map((e) => e.payload.itemId)).toEqual([`airtable:record:${rec("Memo1")}`]);
    expect(parseAirtableCursor(out.at(-1)!.cursor)).toMatchObject({ bases: [], since: "2021-11-06T12:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" });

    const again = connector(account());
    expect(await batches(again.c.historicalImport({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }))).toEqual([]);
    expect(again.fetch.calls).toEqual([]);
  });

  it("lists a resumed base's tables with the base's name", async () => {
    const saved: AirtableCursor = { pass: "historical", bases: [SHOP], tables: null, recordsOffset: null, since: "2021-11-06T12:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" };
    const { c, fetch } = connector(account());
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(paths(fetch).slice(0, 3)).toEqual(["/meta/whoami", "/meta/bases", `/meta/bases/${SHOP}/tables`]);
    expect(out[0]!.events.map((e) => e.payload.baseName)).toEqual(["Test Shop", "Test Shop", "Test Shop"]);
  });

  it("keeps at most 1,000 tables of a base, so the checkpoint stays bounded", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ id: aid("tbl", `T${i}`), name: `T${i}`, primaryFieldId: F.text, fields: [{ id: F.text, name: "Note", type: "multilineText" }] }));
    const { c } = connector(account({ tables: { [SHOP]: many } }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(out[0]!.events).toHaveLength(1000);
    expect(parseAirtableCursor(out[0]!.cursor)!.tables).toHaveLength(1000);
  });

  it("skips a table deleted since the checkpoint", async () => {
    const saved: AirtableCursor = { pass: "historical", bases: [SHOP], tables: [aid("tbl", "Gone"), MEMOS], recordsOffset: null, since: "2021-11-06T12:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" };
    const { c, fetch } = connector(account());
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(paths(fetch)).toEqual(["/meta/whoami", `/meta/bases/${SHOP}/tables`, `/${SHOP}/${MEMOS}`]);
    expect(out.flatMap((b) => b.events)).toHaveLength(1);
  });

  it("starts a new import when the checkpoint is an incremental one", async () => {
    const saved: AirtableCursor = { pass: "incremental", bases: [], tables: null, recordsOffset: null, since: "2026-11-05T12:00:00.000Z", nextFrom: "2026-11-06T00:00:00.000Z" };
    const { c, fetch } = connector(account());
    await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(recordCalls(fetch)[0]!.searchParams.get("filterByFormula")).toBe(airtableChangedAfter("2021-11-06T12:00:00.000Z"));
  });

  it("asks only for records made or changed since the last pass began, less five minutes", async () => {
    expect(AIRTABLE_OVERLAP_MS).toBe(300_000);
    const { memory, pipeline } = testPipeline();
    const first = connector(account(), { now: () => new Date("2026-11-07T12:00:00.000Z") });
    await runSync({ connector: first.c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });

    const next = connector(account(), { now: () => new Date("2026-11-08T12:00:00.000Z") });
    const report = await runSync({ connector: next.c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(recordCalls(next.fetch).map((u) => u.searchParams.get("filterByFormula"))).toEqual([airtableChangedAfter("2026-11-07T11:55:00.000Z"), airtableChangedAfter("2026-11-07T11:55:00.000Z")]);
    // Nothing changed since, so only the tables are read again, as duplicates.
    expect(report).toMatchObject({ ingested: 0, duplicates: 3 });
    expect(JSON.parse((await memory.getCheckpoint(TEST_ORG, "airtable", "incremental"))!)).toMatchObject({ pass: "incremental", bases: [], since: "2026-11-07T11:55:00.000Z", nextFrom: "2026-11-08T11:55:00.000Z" });
  });

  it("looks back 24 hours, or as long as it is told, when there is no checkpoint", async () => {
    const { c, fetch } = connector(account());
    await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(recordCalls(fetch)[0]!.searchParams.get("filterByFormula")).toBe(airtableChangedAfter("2026-11-05T12:00:00.000Z"));
    const short = connector(account(), { incrementalLookbackHours: 2 });
    await batches(short.c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(recordCalls(short.fetch)[0]!.searchParams.get("filterByFormula")).toBe(airtableChangedAfter("2026-11-06T10:00:00.000Z"));
  });

  it("resumes an interrupted incremental pass, and starts the next after a historical one", async () => {
    const saved: AirtableCursor = { pass: "incremental", bases: [SHOP], tables: [REPAIRS], recordsOffset: null, since: "2026-10-31T00:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" };
    const { c, fetch } = connector(account());
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(paths(fetch)).toEqual(["/meta/whoami", `/meta/bases/${SHOP}/tables`, `/${SHOP}/${REPAIRS}`]);
    expect(out.flatMap((b) => b.events).map((e) => e.payload.itemId)).toEqual([`airtable:record:${rec("One")}`]);

    const finishedImport: AirtableCursor = { ...saved, pass: "historical", bases: [], tables: null };
    const next = connector(account());
    await batches(next.c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(finishedImport) }));
    expect(paths(next.fetch).slice(0, 2)).toEqual(["/meta/whoami", "/meta/bases"]);
    expect(recordCalls(next.fetch)[0]!.searchParams.get("filterByFormula")).toBe(airtableChangedAfter("2026-11-01T00:00:00.000Z"));
  });

  it("reads a table again from its start when Airtable turns down a saved offset, once", async () => {
    const saved: AirtableCursor = { pass: "historical", bases: [SHOP], tables: [REPAIRS], recordsOffset: `itrPage1/${rec("Two")}`, since: "2021-11-06T12:00:00.000Z", nextFrom: "2026-11-06T11:55:00.000Z" };
    const { c, fetch } = connector(account({ expiredOffsets: 1 }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(recordCalls(fetch).map((u) => u.searchParams.get("offset"))).toEqual([`itrPage1/${rec("Two")}`, null]);
    expect(out.flatMap((b) => b.events).map((e) => e.payload.itemId)).toEqual([`airtable:record:${rec("One")}`, `airtable:record:${rec("Two")}`, `airtable:record:${rec("Bad")}`]);

    const looping = connector(account({ expiredOffsets: 5, pageCap: 1 }));
    await expect(batches(looping.c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }))).rejects.toBeInstanceOf(AirtableOffsetExpiredError);
    expect(recordCalls(looping.fetch).map((u) => u.searchParams.get("offset"))).toEqual([`itrPage1/${rec("Two")}`, null, `itrPage1/${rec("Two")}`]);
  });

  it("restarts each table's expired offset on its own", async () => {
    const saved: AirtableCursor = { pass: "historical", bases: [SHOP], tables: [REPAIRS, MEMOS], recordsOffset: `itrPage1/${rec("Two")}`, since: "2021-11-06T12:00:00.000Z", nextFrom: "2026-11-06T11:55:00.000Z" };
    const data = account({ expiredOffsets: 2, pageCap: 1 });
    data.records[MEMOS] = [...data.records[MEMOS]!, { id: rec("Memo2"), createdTime: "2026-10-16T09:00:00.000Z", fields: { Carats: 2 } }];
    const { c, fetch } = connector(data);
    // The second expiry lands on the repairs table's next page, which was already restarted once.
    await expect(batches(c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }))).rejects.toBeInstanceOf(AirtableOffsetExpiredError);
    expect(recordCalls(fetch).filter((u) => u.pathname.endsWith(MEMOS))).toEqual([]);
  });

  it("skips a base or table deleted part way through a pass", async () => {
    const data = bothBases();
    const { fetch: mockFetch } = connector(data);
    const gone = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === `/v0/meta/bases/${OTHER}/tables` || url.pathname === `/v0/${SHOP}/${REPAIRS}`) return json(404, { error: "NOT_FOUND" });
      return mockFetch(url, init);
    }) as typeof globalThis.fetch;
    const c = airtableConnector({ token: TOKEN, now: () => NOW, fetch: gone, sleep: noSleep });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // Three tables from the first base and the memo; the second base has nothing left.
    expect(report).toMatchObject({ ingested: 4, deadLettered: 0 });
  });

  it("stops on any other error, leaving runSync to retry from the checkpoint", async () => {
    const { c } = connector(account({ token: "y".repeat(40) }));
    await expect(runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG, attempts: 1 })).rejects.toThrow(/turned down the token/);
    const blocked = scripted([json(200, { id: aid("usr", "Me") }), json(200, { bases: [{ id: SHOP, name: "Test Shop" }] }), json(403, {})]);
    const c403 = airtableConnector({ token: TOKEN, now: () => NOW, fetch: blocked.fetch, sleep: noSleep });
    await expect(batches(c403.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toMatchObject({ status: 403 });
    const late = scripted([json(200, { id: aid("usr", "Me") }), json(200, { bases: [{ id: SHOP }] }), json(200, { tables: [{ id: MEMOS, fields: [{ id: F.carats, type: "number" }] }] }), json(500, {})]);
    const failing = airtableConnector({ token: TOKEN, now: () => NOW, fetch: late.fetch, sleep: noSleep });
    await expect(batches(failing.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toMatchObject({ status: 500 });
  });

  it("waits out Airtable's rate limit and carries on", async () => {
    const waits: number[] = [];
    const { c } = connector(account({ rateLimited: 2 }), { sleep: async (ms) => void waits.push(ms) });
    const report = await runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(waits).toEqual([30_000, 30_000]);
    expect(report.ingested).toBe(6);
  });

  it("finishes cleanly when the token sees no base", async () => {
    const { c } = connector(account({ bases: [] }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(out).toHaveLength(1);
    expect(parseAirtableCursor(out[0]!.cursor)).toMatchObject({ bases: [], pass: "historical" });
  });

  it("skips bases, tables and records with no usable id without reading anything for them", async () => {
    const { fetch, sent } = scripted([
      json(200, { id: aid("usr", "Me") }),
      json(200, { bases: [{ id: "appShort" }, {}, { id: SHOP, name: 5 }] }),
      json(200, { tables: [{ id: "tblShort", fields: [{ id: F.carats, type: "number" }] }, { id: MEMOS, fields: [{ id: F.carats, type: "number" }] }] }),
      json(200, { records: [{ id: "rec../x", createdTime: "2026-10-01T00:00:00.000Z" }, { id: rec("Memo1"), createdTime: "2026-10-01T00:00:00.000Z" }] }),
    ]);
    const c = airtableConnector({ token: TOKEN, now: () => NOW, fetch, sleep: noSleep });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(sent.map((u) => u.pathname.replace("/v0", ""))).toEqual(["/meta/whoami", "/meta/bases", `/meta/bases/${SHOP}/tables`, `/${SHOP}/${MEMOS}`]);
    expect(out.flatMap((b) => b.events).map((e) => String(e.payload.itemId ?? e.payload.boardId))).toEqual([`airtable:table:${MEMOS}`, `airtable:record:${rec("Memo1")}`]);
    expect(out[0]!.events[0]!.payload).not.toHaveProperty("baseName");
  });

  it("stops before reading anything when an OAuth token can write, and reads with a read-only one", async () => {
    for (const scope of ["data.records:write", "schema.bases:write", "webhook:manage", "workspacesAndBases:manage"]) {
      const { c, fetch } = connector(account({ scopes: ["data.records:read", "schema.bases:read", scope] }));
      await expect(batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null })), scope).rejects.toThrow(`AIRTABLE_ACCESS_TOKEN can change Airtable (${scope}). Make a token with only data.records:read and schema.bases:read`);
      expect(paths(fetch)).toEqual(["/meta/whoami"]);
      await expect(batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).rejects.toBeInstanceOf(AirtableConfigError);
    }
    const two = connector(account({ scopes: ["data.records:write", "schema.bases:manage"] }));
    await expect(batches(two.c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow("(data.records:write, schema.bases:manage)");
    const readOnly = connector(account({ scopes: ["data.records:read", "schema.bases:read", "user.email:read", "data.recordComments:read"] }));
    const report = await runSync({ connector: readOnly.c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(report.ingested).toBe(6);
    // A resumed pass checks too.
    const saved: AirtableCursor = { pass: "historical", bases: [SHOP], tables: [MEMOS], recordsOffset: null, since: "2021-11-06T12:00:00.000Z", nextFrom: "2026-11-01T00:00:00.000Z" };
    const resumed = connector(account({ scopes: ["data.records:write"] }));
    await expect(batches(resumed.c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }))).rejects.toBeInstanceOf(AirtableConfigError);
    expect(paths(resumed.fetch)).toEqual(["/meta/whoami"]);
  });

  it("declares creating and changing a record, and turns both down while writes are off", async () => {
    const { c } = connector(account());
    expect(c.writes).toBe(AIRTABLE_WRITES);
    expect(AIRTABLE_WRITES.map((w) => w.name)).toEqual(["create_record", "update_record"]);
    expect(AIRTABLE_WRITES.every((w) => w.integration === "airtable")).toBe(true);
    const audit = await assertWritesRefused(c);
    expect(audit.map((entry) => entry.action)).toEqual(["create_record", "update_record"]);
    expect(audit.every((entry) => entry.outcome === "refused")).toBe(true);
    expect("handleWebhook" in c).toBe(false);
    expect(c.source).toBe("airtable");
  });
});
