import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { DEPUTY_OBJECTS, deputyClient, type DeputyClient, type DeputyClientOptions, type DeputyObject, type DeputyQuery } from "./client.js";
import { deputyEvent } from "./normalize.js";

/**
 * Deputy: staff schedules and worked hours, with their cost, by location
 * and area, so labor can be set against sales and bench output by day.
 *
 * - The historical import reads every location, area and team member, then
 *   three years of shifts and timesheets by date, and the leave that ends
 *   in that time.
 * - Each later sync reads each of those records Deputy says changed since
 *   an hour before the last pass started, so an approval, a cost or a new
 *   shift is read again. One read again unchanged is a duplicate.
 *
 * A pass reads one record type after another, in Id order, 500 to a page.
 * Each page is one batch and one checkpoint, which keeps the record type
 * and how many of it the pass has read, so a resumed pass goes on from
 * there. Deputy can send webhooks, but the connector polls so it needs no
 * public route.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no request to send them. */
export const DEPUTY_WRITES: WriteAction[] = [
  { integration: "deputy", name: "publish_roster", description: "Publish a Deputy schedule, so team members see their shifts", kind: "update", approval: "each", dailyCap: 5 },
  { integration: "deputy", name: "approve_timesheet", description: "Approve the time on a Deputy timesheet", kind: "update", approval: "each", dailyCap: 50 },
];

const HOUR_MS = 3_600_000;
/** Each later pass reads what changed from this long before the last one started. */
export const DEPUTY_OVERLAP_MS = HOUR_MS;

/** A pass under way: the record type it is on, and how many of it are read. */
export interface DeputyPass {
  object: DeputyObject;
  start: number;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `from` is what the pass reads from; `nextFrom` is where the next later sync starts. */
export interface DeputyCursor {
  pass: DeputyPass | null;
  /** The historical import finished. */
  done: boolean;
  /** The first day of the import, or the time a later sync reads changes from. */
  from: string;
  nextFrom: string;
}

export interface DeputyOptions extends Partial<Pick<DeputyClientOptions, "fetch" | "sleep" | "retries">> {
  accessToken: string;
  install: string;
  /** Shifts, timesheets and leave older than this many years are skipped. Defaults to 3. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: DeputyClient;
}

/** A time as toISOString writes it, which reads back as itself. */
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;

export function parseDeputyCursor(raw: string | null): DeputyCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    c = null;
  }
  const r = typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
  const p = r && typeof r.pass === "object" && r.pass !== null ? (r.pass as Record<string, unknown>) : null;
  const pass = p && (DEPUTY_OBJECTS as readonly unknown[]).includes(p.object) && Number.isSafeInteger(p.start) && (p.start as number) >= 0 ? { object: p.object as DeputyObject, start: p.start as number } : null;
  if (r && typeof r.done === "boolean" && isTime(r.from) && isTime(r.nextFrom) && (r.pass === null || pass)) return { pass, done: r.done, from: r.from, nextFrom: r.nextFrom };
  throw new Error("Deputy checkpoint is not in the expected shape");
}

/** What a first import reads of each record type: the people and places whole, the rest from the first day. */
function importSince(object: DeputyObject, day: string): DeputyQuery["since"] {
  if (object === "Roster" || object === "Timesheet") return { field: "Date", value: day };
  if (object === "Leave") return { field: "DateEnd", value: day };
  return undefined;
}

/** A UTC time as the client sends it in a search. */
const searchTime = (iso: string) => `${iso.slice(0, 19)}+00:00`;

export function deputyConnector(options: DeputyOptions): Connector {
  const client = options.client ?? deputyClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 3;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads a pass from where it stands to its end. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(at: DeputyPass, since: (object: DeputyObject) => DeputyQuery["since"], cursor: Omit<DeputyCursor, "pass">, doneAtEnd: boolean, receivedAt: string): AsyncIterable<SourceBatch> {
    for (let i = DEPUTY_OBJECTS.indexOf(at.object), start = at.start; i < DEPUTY_OBJECTS.length; i++, start = 0) {
      const object = DEPUTY_OBJECTS[i]!;
      for (;;) {
        const page = await client.query({ object, since: since(object), start });
        start += page.records.length;
        const events = page.records.map((r) => deputyEvent(object, r, { receivedAt }));
        const next: DeputyPass | null = page.more ? { object, start } : i + 1 < DEPUTY_OBJECTS.length ? { object: DEPUTY_OBJECTS[i + 1]!, start: 0 } : null;
        const saved: DeputyCursor = next ? { ...cursor, pass: next } : { ...cursor, pass: null, done: doneAtEnd };
        yield { events, cursor: JSON.stringify(saved) };
        if (!page.more) break;
      }
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseDeputyCursor(context.cursor);
    if (saved?.done) return;
    const at = now();
    const receivedAt = at.toISOString();
    if (saved?.pass) {
      const day = saved.from.slice(0, 10);
      return yield* walk(saved.pass, (o) => importSince(o, day), { done: false, from: saved.from, nextFrom: saved.nextFrom }, true, receivedAt);
    }
    const from = new Date(at);
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    const day = from.toISOString().slice(0, 10);
    yield* walk({ object: DEPUTY_OBJECTS[0], start: 0 }, (o) => importSince(o, day), { done: false, from: `${day}T00:00:00.000Z`, nextFrom: new Date(at.getTime() - DEPUTY_OVERLAP_MS).toISOString() }, true, receivedAt);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseDeputyCursor(context.cursor);
    const at = now();
    const receivedAt = at.toISOString();
    const changed = (from: string) => () => ({ field: "Modified" as const, value: searchTime(from) });
    if (saved?.pass) return yield* walk(saved.pass, changed(saved.from), { done: saved.done, from: saved.from, nextFrom: saved.nextFrom }, saved.done, receivedAt);
    const from = saved?.nextFrom ?? new Date(at.getTime() - DEPUTY_OVERLAP_MS).toISOString();
    const done = saved?.done ?? false;
    yield* walk({ object: DEPUTY_OBJECTS[0], start: 0 }, changed(from), { done, from, nextFrom: new Date(at.getTime() - DEPUTY_OVERLAP_MS).toISOString() }, done, receivedAt);
  }

  return { source: "deputy", historicalImport, incrementalSync, writes: DEPUTY_WRITES };
}
