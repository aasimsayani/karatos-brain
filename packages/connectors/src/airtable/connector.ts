import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { AIRTABLE_ID, AIRTABLE_WRITE_SCOPE, AirtableApiError, AirtableConfigError, AirtableOffsetExpiredError, airtableClient, type AirtableClient, type AirtableClientOptions } from "./client.js";
import { airtableRecordEvents, airtableSafeFields, airtableTable, airtableTableEvents, type AirtableBrainEvent, type AirtableTable } from "./normalize.js";

/**
 * Airtable: the bases a store keeps memo logs, repair intake and custom
 * orders in. Each pass reads every base the token can see (or the ones
 * AIRTABLE_BASE_IDS names), each base's tables with their fields, then each
 * table's records, reading only the fields that hold no free text.
 *
 * The historical import reads records made or changed in the last five
 * years. Later syncs ask Airtable only for records made or changed since
 * the last pass started, less five minutes of overlap. Airtable doesn't
 * report deleted records to a reader, so a deleted record is simply no
 * longer read. A table with no field the connector reads is kept for its
 * structure only, since asking for no fields returns every field.
 *
 * Before reading, the connector asks Airtable which scopes its token has.
 * An OAuth token with any write scope stops the sync. A personal access
 * token's scopes aren't reported, so make it with the two read scopes only.
 */

/** Declared so they can be gated and audited; none runs while writes are off. */
export const AIRTABLE_WRITES: WriteAction[] = [
  { integration: "airtable", name: "create_record", description: "Create a record in a table, such as a new repair or memo entry" },
  { integration: "airtable", name: "update_record", description: "Change a record's fields, such as a repair's stage" },
];

/** Each incremental pass starts this long before the previous one did, so a change saved mid-pass is never missed. */
export const AIRTABLE_OVERLAP_MS = 5 * 60_000;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface AirtableCursor {
  pass: "historical" | "incremental";
  /** Bases still to read, the current one first. Empty once the pass is done. */
  bases: string[];
  /** The current base's tables still to read, the current one first, or null when the base's tables haven't been listed yet. */
  tables: string[] | null;
  /** The offset of the current table's next page of records, or null to start it. */
  recordsOffset: string | null;
  /** ISO times: a pass keeps records made or changed after `since`, and the next pass starts at `nextFrom`. */
  since: string;
  nextFrom: string;
}

export interface AirtableOptions extends Partial<Pick<AirtableClientOptions, "fetch" | "sleep" | "rateLimitRetries">> {
  token: string;
  /** Read only these bases, by id. Every base the token can see otherwise. */
  bases?: string[] | undefined;
  /** Years of history the first import reads. Defaults to 5. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. Defaults to 24 hours. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: AirtableClient;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OFFSET = /^[A-Za-z0-9/]{1,256}$/;
/** Airtable caps a workspace far below these; they bound what a checkpoint can hold. */
const MAX_BASES = 1000;
const MAX_TABLES = 1000;
const isTime = (t: unknown) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t)) && new Date(t).toISOString() === t;
const ids = (value: unknown, kind: "base" | "table", max: number) => Array.isArray(value) && value.length <= max && value.every((v) => typeof v === "string" && AIRTABLE_ID[kind].test(v));

export function parseAirtableCursor(raw: string | null): AirtableCursor | null {
  if (raw === null) return null;
  let c: AirtableCursor | null;
  try {
    c = JSON.parse(raw) as AirtableCursor | null;
  } catch {
    c = null;
  }
  const ok =
    typeof c === "object" &&
    c !== null &&
    (c.pass === "historical" || c.pass === "incremental") &&
    ids(c.bases, "base", MAX_BASES) &&
    (c.tables === null || ids(c.tables, "table", MAX_TABLES)) &&
    (c.recordsOffset === null || (typeof c.recordsOffset === "string" && OFFSET.test(c.recordsOffset))) &&
    isTime(c.since) &&
    isTime(c.nextFrom) &&
    // Tables and an offset only make sense inside a base still being read, and an offset inside a table.
    (c.bases.length > 0 || c.tables === null) &&
    (c.recordsOffset === null || (c.tables !== null && c.tables.length > 0));
  if (!ok || !c) throw new Error("Airtable checkpoint is not in the expected shape");
  const { pass, bases, tables, recordsOffset, since, nextFrom } = c;
  return { pass, bases, tables, recordsOffset, since, nextFrom };
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

/** Reads AIRTABLE_BASE_IDS: base ids separated by commas or spaces. */
export function parseAirtableBases(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const bases = value.split(/[\s,]+/).filter(Boolean);
  if (bases.length > MAX_BASES || !bases.every((b) => AIRTABLE_ID.base.test(b))) throw new Error("AIRTABLE_BASE_IDS must be Airtable base ids (app followed by 14 letters and digits), separated by commas");
  return [...new Set(bases)];
}

export function airtableConnector(options: AirtableOptions): Connector {
  if (options.bases !== undefined && (options.bases.length === 0 || !options.bases.every((b) => AIRTABLE_ID.base.test(b)))) throw new Error("AIRTABLE_BASE_IDS must be Airtable base ids (app followed by 14 letters and digits), separated by commas");
  const client = options.client ?? airtableClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = positive(options.historyYears ?? 5, "historyYears");
  const lookbackHours = positive(options.incrementalLookbackHours ?? 24, "incrementalLookbackHours");

  /** Stops before any record is read when the token can change something in Airtable. */
  async function checkReadOnly() {
    const scopes = await client.scopes();
    const writes = (scopes ?? []).filter((s) => AIRTABLE_WRITE_SCOPE.test(s));
    if (writes.length > 0) throw new AirtableConfigError(`AIRTABLE_ACCESS_TOKEN can change Airtable (${writes.join(", ")}). Make a token with only data.records:read and schema.bases:read`);
  }

  /** Every base the token can see, by id, with its name. */
  async function listBases(): Promise<Map<string, string | undefined>> {
    const out = new Map<string, string | undefined>();
    let offset: string | null = null;
    do {
      const page = await client.bases(offset);
      for (const b of page.data) {
        if (typeof b.id === "string" && AIRTABLE_ID.base.test(b.id) && out.size < MAX_BASES) out.set(b.id, typeof b.name === "string" ? b.name : undefined);
      }
      offset = page.next;
    } while (offset);
    return out;
  }

  /** A base, table or records list deleted part way through a pass answers 404; it has nothing left to read. */
  async function unlessGone<T>(read: () => Promise<T>, gone: T): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof AirtableApiError && error.status === 404) return gone;
      throw error;
    }
  }

  async function start(mode: "historical" | "incremental", saved: AirtableCursor | null, at: Date, visible: Map<string, string | undefined>): Promise<AirtableCursor> {
    let since: string;
    if (mode === "historical") {
      const from = new Date(at);
      from.setUTCFullYear(from.getUTCFullYear() - historyYears);
      since = from.toISOString();
    } else {
      since = saved?.nextFrom ?? new Date(at.getTime() - lookbackHours * 3_600_000).toISOString();
    }
    let bases = [...visible.keys()];
    if (options.bases) {
      const unseen = options.bases.filter((b) => !visible.has(b));
      if (unseen.length > 0) throw new AirtableConfigError(`AIRTABLE_BASE_IDS names bases the token can't see: ${unseen.join(", ")}. Add them to the token's access`);
      bases = options.bases;
    }
    return { pass: mode, bases, tables: null, recordsOffset: null, since, nextFrom: new Date(at.getTime() - AIRTABLE_OVERLAP_MS).toISOString() };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseAirtableCursor(context.cursor);
    const at = now();
    // A finished import stays finished (no bases left) and reads nothing.
    if (mode === "historical" && saved?.pass === "historical" && saved.bases.length === 0) return;
    await checkReadOnly();
    let names: Map<string, string | undefined> | null = null;
    const resume = mode === "historical" ? saved?.pass === "historical" : saved?.pass === "incremental" && saved.bases.length > 0;
    let c: AirtableCursor;
    if (resume) {
      c = saved!;
    } else {
      names = await listBases();
      c = await start(mode, saved, at, names);
    }
    const receivedAt = at.toISOString();
    // The schema of each base this run has read, so a resumed table knows its fields.
    const schemas = new Map<string, AirtableTable[]>();
    // Tables restarted after an expired offset, so one whose offset keeps expiring stops the sync instead of looping.
    const restarted = new Set<string>();
    const cursor = () => JSON.stringify(c);
    const schema = async (base: string) => {
      if (!schemas.has(base)) {
        const raw = await unlessGone(() => client.tables(base), [] as Record<string, unknown>[]);
        schemas.set(base, raw.map((t) => airtableTable(t, base)).filter((t): t is AirtableTable => t !== undefined).slice(0, MAX_TABLES));
      }
      return schemas.get(base)!;
    };

    while (c.bases.length > 0) {
      const base = c.bases[0]!;
      if (c.tables === null) {
        names ??= await listBases();
        const tables = await schema(base);
        const events: AirtableBrainEvent[] = tables.flatMap((t) => airtableTableEvents(t, names!.get(base), receivedAt));
        c = { ...c, tables: tables.map((t) => t.id), recordsOffset: null };
        yield { events, cursor: cursor() };
        continue;
      }
      if (c.tables.length === 0) {
        c = { ...c, bases: c.bases.slice(1), tables: null, recordsOffset: null };
        continue;
      }
      const tableId = c.tables[0]!;
      const table = (await schema(base)).find((t) => t.id === tableId);
      const fields = table ? airtableSafeFields(table).map((f) => f.id) : [];
      const next = (offset: string | null): AirtableCursor => (offset ? { ...c, recordsOffset: offset } : { ...c, tables: c.tables!.slice(1), recordsOffset: null });
      if (!table || fields.length === 0) {
        // Deleted since the checkpoint, or nothing in it the connector reads.
        c = next(null);
        continue;
      }
      let page;
      try {
        page = await unlessGone(() => client.records(base, tableId, fields, c.since, c.recordsOffset), { data: [], next: null });
      } catch (error) {
        if (!(error instanceof AirtableOffsetExpiredError) || restarted.has(tableId)) throw error;
        restarted.add(tableId);
        c = { ...c, recordsOffset: null };
        continue;
      }
      const events = page.data.flatMap((r) => airtableRecordEvents(r, table, receivedAt));
      c = next(page.next);
      yield { events, cursor: cursor() };
    }
    // The pass is done: the checkpoint keeps where the next one starts.
    yield { events: [], cursor: cursor() };
  }

  return {
    source: "airtable",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: AIRTABLE_WRITES,
  };
}
