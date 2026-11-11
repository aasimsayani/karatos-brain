import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { stwmClient, stwmText, type StwmClient, type StwmClientOptions, type StwmModel } from "./client.js";
import { stwmPriceEvents, stwmUnmatched, stwmWeekEvents, type StwmEvent } from "./normalize.js";

/**
 * Search The Watch Market prices for the watch references a store follows.
 * The store lists the references (or names) it buys and sells in
 * STWM_REFERENCES; each pass reads, for each one, its model's prices, days
 * to sell and 13 weeks of history, one batch per reference.
 *
 * The API has no history past 13 weeks, so the historical import is one
 * pass, and each later sync is another. A reference is resolved to its
 * model once and the model kept in the checkpoint, so later passes spend
 * three calls on it, not four. Two references for the same model are read
 * once, and a reference that matches no model is dead-lettered so the
 * store can correct it. The checkpoint keeps the pass's references, day
 * and place, so a resumed sync goes on from there. A pass stops early, to
 * go on next time, when the day's allowance falls to STWM_RESERVE calls,
 * leaving room for the vendor's AI assistant access that shares it.
 */

/** Search The Watch Market only reads; nothing is declared to write. */
export const STWM_WRITES: WriteAction[] = [];
/** References a store can follow. */
export const STWM_MAX_REFERENCES = 200;
/** Calls left in the day's allowance below which a pass stops, to go on next time. */
export const STWM_RESERVE = 25;
/** Calls one reference can take: resolve, prices, days to sell and history. */
const CALLS_PER_REFERENCE = 4;

/** Where a pass stands: its references, the day it began and the next reference to read. */
export interface StwmPass {
  references: string[];
  day: string;
  next: number;
}

/** Serialized as the runSync checkpoint. */
export interface StwmCursor {
  /** The historical import finished. */
  done: boolean;
  /** Each reference resolved so far, and its model. */
  models: [string, StwmModel][];
  /** The pass being read, or null between syncs. */
  pass: StwmPass | null;
}

export interface StwmOptions extends Partial<Pick<StwmClientOptions, "fetch" | "sleep" | "clock" | "retries">> {
  apiKey: string;
  /** The references or names to follow (STWM_REFERENCES), comma or newline separated. */
  references: string;
  now?: () => Date;
  /** Replaced in tests. */
  client?: StwmClient;
}

/** The references a store follows: trimmed, without repeats (ignoring case), in order. */
export function parseStwmReferences(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    if (part.trim() === "") continue;
    const ref = stwmText(part);
    if (ref === undefined) throw new Error("STWM_REFERENCES has a reference that isn't plain text up to 120 characters");
    if (seen.has(ref.toLowerCase())) continue;
    seen.add(ref.toLowerCase());
    out.push(ref);
  }
  if (out.length === 0) throw new Error("STWM_REFERENCES lists no reference");
  if (out.length > STWM_MAX_REFERENCES) throw new Error(`STWM_REFERENCES lists more than ${STWM_MAX_REFERENCES} references`);
  return out;
}

const optionalText = (v: unknown) => v === undefined || (typeof v === "string" && stwmText(v) === v);
const isModel = (v: unknown) => {
  const m = (v ?? {}) as Record<string, unknown>;
  return Number.isSafeInteger(m.groupId) && (m.groupId as number) > 0 && optionalText(m.brand) && optionalText(m.modelNumber) && optionalText(m.name);
};

export function parseStwmCursor(raw: string | null): StwmCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    // Not JSON: fails the checks below.
  }
  const r = (c ?? {}) as Record<string, unknown>;
  const p = (r.pass ?? {}) as Record<string, unknown>;
  const refs = p.references as unknown[];
  const models = r.models as unknown[];
  const okModels = Array.isArray(models) && models.length <= STWM_MAX_REFERENCES && models.every((m) => Array.isArray(m) && m.length === 2 && stwmText(m[0]) === m[0] && isModel(m[1]));
  const okPass = r.pass === null || (Array.isArray(refs) && refs.length <= STWM_MAX_REFERENCES && refs.every((x) => stwmText(x) === x) && typeof p.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.day) && Number.isSafeInteger(p.next) && (p.next as number) > 0 && (p.next as number) < refs.length);
  if (typeof r.done === "boolean" && okModels && okPass)
    return {
      done: r.done,
      models: models as [string, StwmModel][],
      pass:
        r.pass === null
          ? null
          : {
              references: refs as string[],
              day: p.day as string,
              next: p.next as number,
            },
    };
  throw new Error("Search The Watch Market checkpoint is not in the expected shape");
}

export function stwmConnector(options: StwmOptions): Connector {
  const references = parseStwmReferences(options.references);
  const client = options.client ?? stwmClient(options);
  const now = options.now ?? (() => new Date());

  async function* pass(state: StwmCursor, doneAtEnd: boolean): AsyncIterable<SourceBatch> {
    const same = state.pass !== null && JSON.stringify(state.pass.references) === JSON.stringify(references);
    const day = same ? state.pass!.day : now().toISOString().slice(0, 10);
    const models = new Map(state.models.filter(([ref]) => references.includes(ref)));
    /** The models already read this pass. */
    const read = new Set<number>();
    for (const ref of references.slice(0, same ? state.pass!.next : 0)) {
      const m = models.get(ref);
      if (m) read.add(m.groupId);
    }
    for (let i = same ? state.pass!.next : 0; i < references.length; i++) {
      const left = client.remaining();
      if (left !== null && left < STWM_RESERVE + CALLS_PER_REFERENCE) return;
      const reference = references[i]!;
      let model = models.get(reference) ?? null;
      if (!model) {
        model = await client.resolve(reference);
        if (model) models.set(reference, model);
      }
      const ctx = { receivedAt: now().toISOString(), day };
      const events: StwmEvent[] = [];
      if (!model) events.push(stwmUnmatched(reference, ctx));
      else if (!read.has(model.groupId)) {
        read.add(model.groupId);
        const prices = await client.prices(model.groupId);
        const days = await client.daysToSell(model.groupId);
        const history = await client.history(model.groupId);
        events.push(...stwmPriceEvents(prices, days, reference, model, ctx), ...stwmWeekEvents(history, reference, model, ctx));
      }
      const last = i + 1 === references.length;
      const cursor: StwmCursor = {
        done: last ? doneAtEnd : state.done,
        models: [...models],
        pass: last ? null : { references, day, next: i + 1 },
      };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  const fresh = (): StwmCursor => ({ done: false, models: [], pass: null });

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseStwmCursor(context.cursor);
    if (saved?.done) return;
    yield* pass(saved ?? fresh(), true);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const state = parseStwmCursor(context.cursor) ?? fresh();
    yield* pass(state, state.done);
  }

  return {
    source: "search_the_watch_market",
    historicalImport,
    incrementalSync,
    writes: STWM_WRITES,
  };
}
