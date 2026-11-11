import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { WatchbaseConfigError, isWatchbaseDay, isWatchbaseId, watchbaseClient, type WatchbaseClient, type WatchbaseClientOptions } from "./client.js";
import { watchbaseId, watchbaseText, watchbaseUnlisted, watchbaseWatchEvent, type WatchbaseEvent } from "./normalize.js";

/**
 * WatchBase reference specs for the watch brands a store deals in. The
 * store lists them in WATCHBASE_BRANDS, by name or BrandID; names are looked
 * up in WatchBase's brand list.
 *
 * A watch's specs have no history: WatchBase gives each watch's current
 * version. And each watch read is charged (US$0.25 a watch). So:
 *
 * - The historical import reads nothing and finishes at once. The sync
 *   runner runs it once and marks it complete even when it stops early, so a
 *   capped import there would lose its place.
 * - Each sync lists each brand's watches and reads them, in id order, 25 to
 *   a batch. A brand not read before is read in full; after that, only the
 *   watches created or changed after the day before the brand was last read
 *   are listed (`updated-since`). A brand is read at most once a day.
 * - A sync reads at most WATCHBASE_MAX_WATCHES watches (200 unless set),
 *   then stops, and the next sync goes on where it stopped. So reading a
 *   large catalog is spread over several syncs, and no sync spends more
 *   than the store allows.
 *
 * The checkpoint keeps, for each brand, the day its last read began, and the
 * open pass: the day it began, and the brand and last watch id it got to. A
 * resumed sync lists that brand again and goes on after that id.
 */

/** WatchBase only gives data; nothing is declared to write. */
export const WATCHBASE_WRITES: WriteAction[] = [];
/** Brands a store can follow. */
export const WATCHBASE_MAX_BRANDS = 50;
/** Watches read per sync unless WATCHBASE_MAX_WATCHES says otherwise. */
export const WATCHBASE_DEFAULT_MAX_WATCHES = 200;
/** The most WATCHBASE_MAX_WATCHES can be. */
export const WATCHBASE_MAX_WATCHES_LIMIT = 10_000;
/** Watches read per batch. */
export const WATCHBASE_BATCH_SIZE = 25;
const DAY_MS = 86_400_000;

/** A brand the store follows: a BrandID, or a name to look up. */
export type WatchbaseBrand = { id: number } | { name: string };

/** The open pass. */
export interface WatchbasePass {
  /** The day it began, YYYY-MM-DD in UTC. */
  started: string;
  /** The brand it is reading, or null between brands. */
  brand: number | null;
  /** The last watch id of that brand it read, or 0. */
  after: number;
}

/** Serialized as the incremental sync's checkpoint. */
export interface WatchbaseCursor {
  /** Each brand's BrandID and the day its last read began. */
  synced: [number, string][];
  pass: WatchbasePass | null;
}

export interface WatchbaseOptions extends Partial<Pick<WatchbaseClientOptions, "fetch" | "sleep" | "retries">> {
  apiKey: string;
  /** The brands to follow (WATCHBASE_BRANDS), by name or BrandID, comma or newline separated. */
  brands: string;
  /** Watches read per sync at most (WATCHBASE_MAX_WATCHES). */
  maxWatches?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: WatchbaseClient;
}

/** The brands a store follows: BrandIDs as numbers and names as trimmed text, without repeats (ignoring case), in order. */
export function parseWatchbaseBrands(raw: string): WatchbaseBrand[] {
  const out: WatchbaseBrand[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const t = part.trim();
    if (t === "") continue;
    let brand: WatchbaseBrand;
    if (/^[0-9]+$/.test(t)) {
      const id = Number(t);
      if (!isWatchbaseId(id) || String(id) !== t) throw new WatchbaseConfigError("WATCHBASE_BRANDS has a BrandID that isn't a whole number from 1 to 999999999");
      brand = { id };
    } else {
      if (t.length > 80 || /[\u0000-\u001f\u007f]/.test(t)) throw new WatchbaseConfigError("WATCHBASE_BRANDS has a brand name that isn't plain text up to 80 characters");
      brand = { name: t };
    }
    const k = "id" in brand ? `#${brand.id}` : brand.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(brand);
  }
  if (out.length === 0) throw new WatchbaseConfigError("WATCHBASE_BRANDS lists no brand");
  if (out.length > WATCHBASE_MAX_BRANDS) throw new WatchbaseConfigError(`WATCHBASE_BRANDS lists more than ${WATCHBASE_MAX_BRANDS} brands`);
  return out;
}

/** WATCHBASE_MAX_WATCHES: a whole number from 1 to 10,000, or the default when unset. */
export function parseWatchbaseMaxWatches(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return WATCHBASE_DEFAULT_MAX_WATCHES;
  const t = raw.trim();
  const n = Number(t);
  if (!/^[1-9][0-9]*$/.test(t) || n > WATCHBASE_MAX_WATCHES_LIMIT) throw new WatchbaseConfigError(`WATCHBASE_MAX_WATCHES must be a whole number from 1 to ${WATCHBASE_MAX_WATCHES_LIMIT}`);
  return n;
}

const MESSAGE = "WatchBase checkpoint is not in the expected shape";
const keysAre = (r: Record<string, unknown>, keys: string) => Object.keys(r).sort().join(",") === keys;
const isAfter = (v: unknown): v is number => v === 0 || isWatchbaseId(v);

export function parseWatchbaseCursor(raw: string | null): WatchbaseCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new Error(MESSAGE);
  }
  if (typeof c !== "object" || c === null || Array.isArray(c)) throw new Error(MESSAGE);
  const r = c as Record<string, unknown>;
  if (!keysAre(r, "pass,synced")) throw new Error(MESSAGE);
  const synced = r.synced;
  const okSynced =
    Array.isArray(synced) &&
    synced.length <= WATCHBASE_MAX_BRANDS &&
    synced.every((s) => Array.isArray(s) && s.length === 2 && isWatchbaseId(s[0]) && isWatchbaseDay(s[1])) &&
    new Set(synced.map((s) => (s as unknown[])[0])).size === synced.length;
  if (!okSynced) throw new Error(MESSAGE);
  let pass: WatchbasePass | null = null;
  if (r.pass !== null) {
    const p = r.pass as Record<string, unknown>;
    const ok =
      typeof p === "object" &&
      !Array.isArray(p) &&
      keysAre(p, "after,brand,started") &&
      isWatchbaseDay(p.started) &&
      (p.brand === null ? p.after === 0 : isWatchbaseId(p.brand) && isAfter(p.after));
    if (!ok) throw new Error(MESSAGE);
    pass = { started: p.started as string, brand: p.brand as number | null, after: p.after as number };
  }
  return { synced: synced as [number, string][], pass };
}

const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

export function watchbaseConnector(options: WatchbaseOptions): Connector {
  const wanted = parseWatchbaseBrands(options.brands);
  const maxWatches = options.maxWatches ?? WATCHBASE_DEFAULT_MAX_WATCHES;
  if (!Number.isSafeInteger(maxWatches) || maxWatches < 1 || maxWatches > WATCHBASE_MAX_WATCHES_LIMIT) throw new WatchbaseConfigError(`WATCHBASE_MAX_WATCHES must be a whole number from 1 to ${WATCHBASE_MAX_WATCHES_LIMIT}`);
  const client = options.client ?? watchbaseClient(options);
  const now = options.now ?? (() => new Date());

  /** The BrandIDs to read, in order: names are looked up in WatchBase's brand list, once a sync. */
  async function brandIds(): Promise<number[]> {
    const names = wanted.filter((b): b is { name: string } => "name" in b);
    const byName = new Map<string, number>();
    if (names.length) {
      for (const b of await client.brands()) {
        const row = (b ?? {}) as Record<string, unknown>;
        const id = watchbaseId(row.id);
        const name = watchbaseText(row.name, 80);
        if (id !== undefined && name !== undefined && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), id);
      }
    }
    const ids: number[] = [];
    for (const b of wanted) {
      if ("id" in b) {
        if (!ids.includes(b.id)) ids.push(b.id);
        continue;
      }
      const id = byName.get(b.name.toLowerCase());
      if (id === undefined) throw new WatchbaseConfigError(`WATCHBASE_BRANDS names a brand WatchBase doesn't list: ${b.name}`);
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  async function* pass(state: WatchbaseCursor): AsyncIterable<SourceBatch> {
    const brands = await brandIds();
    const synced = new Map(state.synced);
    const open = state.pass ?? { started: now().toISOString().slice(0, 10), brand: null, after: 0 };
    // A pass that stopped in a brand no longer followed goes on between brands.
    let current: WatchbasePass = open.brand !== null && !brands.includes(open.brand) ? { ...open, brand: null, after: 0 } : open;
    let budget = maxWatches;
    let last: string | null = null;
    const cursor = (): string => {
      const finished = current.brand === null && brands.every((b) => synced.get(b) === current.started);
      const kept: [number, string][] = brands.filter((b) => synced.has(b)).map((b) => [b, synced.get(b)!]);
      return JSON.stringify({ synced: kept, pass: finished ? null : current } satisfies WatchbaseCursor);
    };

    for (const brand of brands) {
      // A brand read on the day this pass began, and not the one it stopped in, is done.
      if (synced.get(brand) === current.started && current.brand !== brand) continue;
      if (budget === 0) return;
      const after = current.brand === brand ? current.after : 0;
      const since = synced.has(brand) ? dayBefore(synced.get(brand)!) : null;
      const listed = await client.watches(brand, since);
      const receivedAt = now().toISOString();
      const unreadable: WatchbaseEvent[] = [];
      const ids = new Set<number>();
      for (const entry of listed) {
        const id = watchbaseId(((entry ?? {}) as Record<string, unknown>).id);
        if (id === undefined) unreadable.push(watchbaseUnlisted(entry, brand, receivedAt));
        else if (id > after) ids.add(id);
      }
      const todo = [...ids].sort((x, y) => x - y);
      // A resumed brand already gave its unreadable entries the first time.
      let pending = after === 0 ? unreadable : [];
      if (todo.length === 0) {
        synced.set(brand, current.started);
        current = { ...current, brand: null, after: 0 };
        last = cursor();
        yield { events: pending, cursor: last };
        continue;
      }
      for (let i = 0; i < todo.length; ) {
        if (budget === 0) return;
        const chunk = todo.slice(i, i + Math.min(WATCHBASE_BATCH_SIZE, budget));
        const events: WatchbaseEvent[] = [...pending];
        pending = [];
        for (const id of chunk) events.push(watchbaseWatchEvent(await client.watch(id), now().toISOString()).event);
        budget -= chunk.length;
        i += chunk.length;
        if (i === todo.length) {
          synced.set(brand, current.started);
          current = { ...current, brand: null, after: 0 };
        } else current = { ...current, brand, after: chunk[chunk.length - 1]! };
        last = cursor();
        yield { events, cursor: last };
      }
    }
    // Brands read earlier in the pass, or dropped from the setting, can leave it open with nothing left to read.
    const end = cursor();
    if (end !== last) yield { events: [], cursor: end };
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    // Specs have no history, and every read is charged: the incremental sync reads the catalog, capped and resumable.
    parseWatchbaseCursor(context.cursor);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    yield* pass(parseWatchbaseCursor(context.cursor) ?? { synced: [], pass: null });
  }

  return { source: "watchbase_datafeed", historicalImport, incrementalSync, writes: WATCHBASE_WRITES };
}
