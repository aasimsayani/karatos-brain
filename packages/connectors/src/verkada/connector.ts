import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { verkadaClient, type VerkadaClient, type VerkadaClientOptions } from "./client.js";
import { verkadaTrafficEvents } from "./normalize.js";

/**
 * Verkada store traffic: how many people came into the store and went out,
 * hour by hour, from each camera's counting line, so the owner sees
 * footfall against sales.
 *
 * Verkada answers one camera's line at a time, over a time range, by hour.
 * So a pass lists the cameras that count people and their lines, then
 * reads each line a week at a time from the pass's start to its end, the
 * last whole hour:
 *
 * - The historical import reads two years back.
 * - Each later sync reads from two hours before where the last one ended,
 *   since Verkada can still be counting the last hours, and the first
 *   later sync reads the last day. An hour read again unchanged is a
 *   duplicate; a recount is a new event.
 *
 * Each week of a line is one batch, and the checkpoint keeps the pass's
 * range, its lines, the line being read and where in it, so a resumed sync
 * goes on from there.
 */

/** Verkada store traffic only reads; nothing is declared to write. */
export const VERKADA_WRITES: WriteAction[] = [];

const HOUR_S = 3600;
const DAY_S = 24 * HOUR_S;
/** Each call reads this much of a line. */
export const VERKADA_WINDOW_S = 7 * DAY_S;
/** Each later sync reads again from this long before the last one ended. */
export const VERKADA_OVERLAP_S = 2 * HOUR_S;
/** A first later sync with no checkpoint reads this far back. */
export const VERKADA_FIRST_LOOKBACK_S = DAY_S;
/** Counting lines a pass reads at most. */
export const VERKADA_MAX_LINES = 500;
const LINE = /^[A-Za-z0-9_-]{1,64}\|[A-Za-z0-9_-]{1,64}$/;

/** Where a pass stands: its range in Unix seconds, its lines (camera|preset), and the line and time being read. */
export interface VerkadaPass {
  from: number;
  to: number;
  lines: string[];
  line: number;
  at: number;
}

/** Serialized as the runSync checkpoint. */
export interface VerkadaCursor {
  /** The historical import finished. */
  done: boolean;
  /** The end of the last finished pass, in Unix seconds. */
  mark: number | null;
  /** The pass being read, or null between syncs. */
  pass: VerkadaPass | null;
}

export interface VerkadaOptions extends Partial<Pick<VerkadaClientOptions, "region" | "fetch" | "sleep" | "clock" | "retries">> {
  apiKey: string;
  /** Hours older than this many years are skipped. Defaults to 2. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: VerkadaClient;
}

const hourOf = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) % HOUR_S === 0;

export function parseVerkadaCursor(raw: string | null): VerkadaCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    // Not JSON: fails the checks below.
  }
  const r = (c ?? {}) as Record<string, unknown>;
  const p = (r.pass ?? {}) as Record<string, unknown>;
  const lines = p.lines as unknown[];
  const pass =
    r.pass === null ||
    (hourOf(p.from) &&
      hourOf(p.to) &&
      Array.isArray(lines) &&
      lines.length <= VERKADA_MAX_LINES &&
      lines.every((l) => typeof l === "string" && LINE.test(l)) &&
      Number.isSafeInteger(p.line) &&
      (p.line as number) >= 0 &&
      (p.line as number) < lines.length &&
      hourOf(p.at) &&
      p.at >= p.from &&
      p.at < p.to);
  if (typeof r.done === "boolean" && (r.mark === null || hourOf(r.mark)) && pass) {
    return { done: r.done, mark: r.mark as number | null, pass: r.pass === null ? null : { from: p.from as number, to: p.to as number, lines: lines as string[], line: p.line as number, at: p.at as number } };
  }
  throw new Error("Verkada checkpoint is not in the expected shape");
}

export function verkadaConnector(options: VerkadaOptions): Connector {
  const client = options.client ?? verkadaClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 2;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");
  /** The start of the hour now is in: the end of the last whole hour. */
  const lastHour = () => Math.floor(now().getTime() / 1000 / HOUR_S) * HOUR_S;

  /** Reads every line from `from` to `to`, or goes on with `state`'s pass. */
  async function* read(state: VerkadaCursor, from: number, to: number, doneAtEnd: boolean): AsyncIterable<SourceBatch> {
    let pass = state.pass;
    if (!pass) {
      const cameras = await client.cameras();
      const lines = cameras.flatMap((c) => c.presetIds.map((p) => `${c.cameraId}|${p}`));
      if (lines.length > VERKADA_MAX_LINES) throw new Error(`Verkada has more than ${VERKADA_MAX_LINES} counting lines, more than one pass reads`);
      if (lines.length === 0) {
        yield { events: [], cursor: JSON.stringify({ done: doneAtEnd, mark: to, pass: null }) };
        return;
      }
      pass = { from, to, lines, line: 0, at: from };
    }
    for (;;) {
      const [cameraId, presetId] = pass.lines[pass.line]!.split("|") as [string, string];
      const end = Math.min(pass.at + VERKADA_WINDOW_S, pass.to);
      const body = await client.trends(cameraId, presetId, pass.at, end);
      const events = verkadaTrafficEvents(body, cameraId, presetId, { receivedAt: now().toISOString() });
      let last = false;
      if (end < pass.to) pass = { ...pass, at: end };
      else if (pass.line + 1 < pass.lines.length) pass = { ...pass, line: pass.line + 1, at: pass.from };
      else last = true;
      const cursor: VerkadaCursor = last ? { done: doneAtEnd, mark: pass.to, pass: null } : { done: state.done, mark: state.mark, pass };
      yield { events, cursor: JSON.stringify(cursor) };
      if (last) return;
    }
  }

  const fresh = (): VerkadaCursor => ({ done: false, mark: null, pass: null });

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseVerkadaCursor(context.cursor);
    if (saved?.done) return;
    const to = lastHour();
    const floor = new Date(to * 1000);
    floor.setUTCFullYear(floor.getUTCFullYear() - historyYears);
    yield* read(saved ?? fresh(), floor.getTime() / 1000, to, true);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const state = parseVerkadaCursor(context.cursor) ?? fresh();
    const to = lastHour();
    const from = state.mark === null ? to - VERKADA_FIRST_LOOKBACK_S : Math.min(state.mark - VERKADA_OVERLAP_S, to - HOUR_S);
    yield* read(state, from, to, state.done);
  }

  return { source: "verkada", historicalImport, incrementalSync, writes: VERKADA_WRITES };
}
