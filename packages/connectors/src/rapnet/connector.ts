import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { RAPNET_SHAPES, rapnetClient, type RapnetClient, type RapnetClientOptions, type RapnetShape } from "./client.js";
import { changesEvent, listEvent, type RapnetEvent } from "./normalize.js";

/**
 * The Rapaport Price List, for a business with a Rapaport subscription. Each
 * sync reads the Round and Pear lists; a list it hasn't seen becomes an
 * event, followed by the cells that moved in it. Rapaport publishes a new
 * list each Thursday night (Eastern), so a daily sync picks it up by Friday
 * morning and every other sync reads two lists and stops.
 *
 * RapNet's Instant Inventory isn't read: Rapaport's terms forbid copying
 * listings into another database, so network stones are for live searches,
 * not syncs.
 */

/** Declared so they can be gated and audited; none runs while writes are off. */
export const RAPNET_WRITES: WriteAction[] = [
  { integration: "rapnet", name: "upload_listings", description: "Upload or replace the business's diamond listings on RapNet" },
  { integration: "rapnet", name: "contact_seller", description: "Send a RapNet seller an inquiry about one of their listings" },
];

/** Where a RapNet sync stands: the key of the last list read for each shape. Serialized as the runSync checkpoint. */
export type RapnetCursor = Partial<Record<RapnetShape, string>>;

export interface RapnetOptions extends Partial<Pick<RapnetClientOptions, "fetch" | "sleep" | "rateLimitRetries">> {
  clientId: string;
  clientSecret: string;
  /** The lists to read. Both by default. */
  shapes?: readonly RapnetShape[];
  now?: () => Date;
  /** Replaced in tests. */
  client?: RapnetClient;
}

const KEY = /^rapnet:list:(round|pear):[0-9a-z-]{1,10}:[0-9a-f]{12}$/;

export function parseRapnetCursor(raw: string | null): RapnetCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as RapnetCursor;
  const ok = typeof c === "object" && c !== null && !Array.isArray(c) && Object.entries(c).every(([shape, key]) => RAPNET_SHAPES.includes(shape as RapnetShape) && typeof key === "string" && KEY.test(key));
  if (!ok) throw new Error("RapNet checkpoint is not in the expected shape");
  return c;
}

export function rapnetConnector(options: RapnetOptions): Connector {
  const now = options.now ?? (() => new Date());
  const client = options.client ?? rapnetClient({ ...options, now });
  const shapes = options.shapes ?? RAPNET_SHAPES;
  if (shapes.length === 0 || !shapes.every((s) => RAPNET_SHAPES.includes(s))) throw new Error(`shapes must be some of ${RAPNET_SHAPES.join(", ")}`);

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const cursor: RapnetCursor = { ...parseRapnetCursor(context.cursor) };
    for (const shape of shapes) {
      const rows = await client.list(shape);
      const read = listEvent(shape, rows, now().toISOString());
      if (cursor[shape] === read.event.idempotencyKey) continue;
      const events: RapnetEvent[] = [read.event];
      // The changes only mean something beside a list that read.
      if (read.date !== null) {
        const changed = changesEvent(shape, await client.changes(shape), now().toISOString());
        if (changed) events.push(changed);
      }
      cursor[shape] = read.event.idempotencyKey;
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "rapnet",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: RAPNET_WRITES,
  };
}
