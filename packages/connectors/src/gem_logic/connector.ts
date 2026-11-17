import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { gemLogicClient, type GemLogicClient, type GemLogicClientOptions } from "./client.js";
import { gemLogicId, gemLogicProductEvent } from "./normalize.js";

/**
 * Gem Logic: a jewelry business's products on each sales channel Gem Logic
 * lists them on, so stock can be followed across the counter and the web.
 *
 * Gem Logic's API lists products by channel, with no filter for when they
 * changed, so every pass reads every channel's products: the historical
 * import once, and each later sync again. One read again unchanged is a
 * duplicate, so only what changed is new.
 *
 * Each page of a channel's products is one batch and one checkpoint, which
 * keeps the channel and the next page, so a resumed pass goes on from
 * there. A channel that has moved in the list since starts the pass over.
 */

/** None: products, sales and repairs are the business's to change. */
export const GEM_LOGIC_WRITES: WriteAction[] = [];

/** A pass under way: the channel it is on, by place in the list and ID, and the next page of it. */
export interface GemLogicPass {
  index: number;
  marketplaceId: string;
  page: number;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes. */
export interface GemLogicCursor {
  pass: GemLogicPass | null;
  /** The historical import finished. */
  done: boolean;
}

export interface GemLogicOptions extends Partial<Pick<GemLogicClientOptions, "fetch" | "sleep" | "retries">> {
  apiKey: string;
  instance: string;
  now?: () => Date;
  /** Replaced in tests. */
  client?: GemLogicClient;
}

export function parseGemLogicCursor(raw: string | null): GemLogicCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    c = null;
  }
  // Anything but an object reads as a checkpoint without the fields asked for.
  const r = (c ?? {}) as Record<string, unknown>;
  const p = (r.pass ?? {}) as Record<string, unknown>;
  const pass = Number.isSafeInteger(p.index) && (p.index as number) >= 0 && typeof p.marketplaceId === "string" && gemLogicId(p.marketplaceId) === p.marketplaceId && Number.isSafeInteger(p.page) && (p.page as number) >= 1 ? { index: p.index as number, marketplaceId: p.marketplaceId, page: p.page as number } : null;
  if (typeof r.done === "boolean" && (r.pass === null || pass)) return { pass, done: r.done };
  throw new Error("Gem Logic checkpoint is not in the expected shape");
}

export function gemLogicConnector(options: GemLogicOptions): Connector {
  const client = options.client ?? gemLogicClient(options);
  const now = options.now ?? (() => new Date());

  /** Reads every channel's products from `from` on. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(from: GemLogicPass | null, done: boolean, doneAtEnd: boolean): AsyncIterable<SourceBatch> {
    const receivedAt = now().toISOString();
    // A channel whose ID doesn't read can't have its products listed.
    const channels = (await client.marketplaces()).flatMap((m) => {
      const r = (m ?? {}) as Record<string, unknown>;
      const id = gemLogicId(r.id);
      return id === undefined ? [] : [{ id, name: typeof r.marketplace === "string" && r.marketplace.trim() !== "" ? r.marketplace.trim().slice(0, 60) : null }];
    });
    // Resumed where the channel still stands, or from the start.
    const start = from && channels[from.index]?.id === from.marketplaceId ? from : { index: 0, page: 1 };
    if (start.index >= channels.length) {
      yield { events: [], cursor: JSON.stringify({ pass: null, done: doneAtEnd } satisfies GemLogicCursor) };
      return;
    }
    for (let i = start.index, page = start.page; i < channels.length; i++, page = 1) {
      const marketplace = channels[i]!;
      for (; ; page++) {
        const result = await client.products(marketplace.id, page);
        const events = result.records.map((p) => gemLogicProductEvent(p, { receivedAt, marketplace }));
        const next: GemLogicPass | null = result.more ? { index: i, marketplaceId: marketplace.id, page: page + 1 } : i + 1 < channels.length ? { index: i + 1, marketplaceId: channels[i + 1]!.id, page: 1 } : null;
        const cursor: GemLogicCursor = next ? { pass: next, done } : { pass: null, done: doneAtEnd };
        yield { events, cursor: JSON.stringify(cursor) };
        if (!result.more) break;
      }
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseGemLogicCursor(context.cursor);
    if (saved?.done) return;
    yield* walk(saved?.pass ?? null, false, true);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseGemLogicCursor(context.cursor);
    const done = saved?.done ?? false;
    yield* walk(saved?.pass ?? null, done, done);
  }

  return { source: "gem_logic", historicalImport, incrementalSync, writes: GEM_LOGIC_WRITES };
}
