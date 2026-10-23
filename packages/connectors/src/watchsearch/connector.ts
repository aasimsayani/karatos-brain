import { createHash, createHmac } from "node:crypto";
import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { importFiles, parseFileCursor, type FileCursor } from "../files/import.js";
import type { FileSource, SourceFile } from "../files/source.js";
import { ChatExportError, parseChat, type ChatDateOrder } from "./chat.js";
import { offersIn, type WatchOffer } from "./offers.js";

/**
 * TheWatchSearch gathers dealer offers from hundreds of WhatsApp groups, but
 * publishes no API or export. The store is already in many of those groups,
 * and WhatsApp lets any member export a group's chat as a text file. This
 * connector reads those exports from a folder and keeps only the offers in
 * them: brand, reference, selling or looking for, price, year, condition and
 * set, and which group it came from. Dealers are kept as keyed hashes, and
 * the messages' own words are never stored. Nothing is sent to WhatsApp or TheWatchSearch.
 */

/** None: a chat export can't be written back to. */
export const WATCHSEARCH_WRITES: WriteAction[] = [];

export const WATCH_OFFER_EVENT = "watch_market.offer_seen";

export type WatchSearchCursor = FileCursor;

export interface WatchSearchOptions {
  source: FileSource;
  /** The instance's WATCHSEARCH_DEALER_KEY, for dealer references. */
  dealerKey: string;
  /** How the phone that exported the chats writes dates. Worked out from each file when "auto". */
  dateOrder?: ChatDateOrder | undefined;
  /** The exporting phone's offset from UTC, such as "+08:00". Exports carry local times. */
  utcOffset?: string | undefined;
  /** Currency for a bare "14.5k". Without one, those prices are left out. */
  defaultCurrency?: string | undefined;
  /** Offers older than this many days are skipped: an old asking price says little about today's market. */
  historyDays?: number;
  /** Events per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
}

export interface WatchOfferEvent {
  id: string;
  type: typeof WATCH_OFFER_EVENT;
  occurredAt: string;
  receivedAt: string;
  idempotencyKey: string;
  payload: Omit<WatchOffer, "part"> & { offerId: string; dealerRef: string; group: string; sourceRow: string };
}

export const MIN_DEALER_KEY_LENGTH = 32;

export class WatchSearchKeyError extends Error {
  constructor() {
    super(`WATCHSEARCH_DEALER_KEY must be at least ${MIN_DEALER_KEY_LENGTH} characters; let npm run secrets:setup generate it`);
    this.name = "WatchSearchKeyError";
  }
}

export class WatchExportError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(message.startsWith(file) ? message : `${file}: ${message}`);
    this.name = "WatchExportError";
  }
}

export const parseWatchSearchCursor = (raw: string | null): WatchSearchCursor | null => parseFileCursor(raw, "WatchSearch import");

const CURRENCY = /^[A-Z]{3}$/;
const OFFSET = /^(Z|[+-](0\d|1[0-4]):[0-5]\d)$/;

/** The group a file holds, from the name WhatsApp gives the export ("WhatsApp Chat with Rolex Dealers HK.txt"). */
export function groupOf(fileName: string): string | null {
  const stem = fileName.replace(/\.txt$/i, "").replace(/^WhatsApp Chat (with|-)\s*/i, "").trim();
  // iPhone names every export _chat.txt inside its zip; on its own that names no group.
  if (stem === "" || /^_?chat$/i.test(stem)) return null;
  return stem;
}

/**
 * The same dealer always gets the same reference, without the name or
 * number being kept. Numbers are compared by their digits, names without
 * regard to case or spacing.
 */
export function dealerRef(key: string, name: string): string {
  const trimmed = name.normalize("NFKC").trim();
  const normalized = /^\+?[\d\s().-]+$/.test(trimmed) ? trimmed.replace(/\D/g, "") : trimmed.toLowerCase().replace(/\s+/g, " ");
  return `watchsearch:dealer:${createHmac("sha256", key).update(normalized).digest("hex").slice(0, 24)}`;
}

export function watchSearchConnector(options: WatchSearchOptions): Connector {
  if (options.dealerKey.length < MIN_DEALER_KEY_LENGTH) throw new WatchSearchKeyError();
  if (options.defaultCurrency !== undefined && !CURRENCY.test(options.defaultCurrency)) throw new Error("defaultCurrency must be a three-letter currency code such as USD");
  if (options.utcOffset !== undefined && !OFFSET.test(options.utcOffset)) throw new Error('utcOffset must look like "+08:00", "-05:00" or "Z"');
  const now = options.now ?? (() => new Date());
  const historyDays = options.historyDays ?? 365;
  const batchSize = options.batchSize ?? 250;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive whole number");
  if (!Number.isInteger(historyDays) || historyDays < 1) throw new Error("historyDays must be a positive whole number");

  function eventsOf(file: SourceFile, text: string): WatchOfferEvent[] {
    const group = groupOf(file.name);
    if (group === null) throw new WatchExportError(file.name, "rename the export after its group, such as Rolex Dealers HK.txt, so offers from different groups stay apart");
    const at = now();
    const since = new Date(at.getTime() - historyDays * 86_400_000).toISOString();
    let messages;
    try {
      messages = parseChat(text, { fileName: file.name, dateOrder: options.dateOrder, utcOffset: options.utcOffset });
    } catch (error) {
      if (error instanceof ChatExportError) throw new WatchExportError(file.name, error.message);
      throw error;
    }
    return messages
      .filter((m) => m.at >= since)
      .flatMap((m) => {
        const dealer = dealerRef(options.dealerKey, m.sender);
        return offersIn(m.text, { defaultCurrency: options.defaultCurrency, now: at }).map(({ part, ...offer }): WatchOfferEvent => {
          const key = createHash("sha256").update([group, m.at, dealer, part, offer.brand, offer.reference].join("|")).digest("hex").slice(0, 32);
          return {
            id: `watchsearch_${key}`,
            type: WATCH_OFFER_EVENT,
            occurredAt: m.at,
            receivedAt: at.toISOString(),
            idempotencyKey: `watchsearch:${key}`,
            payload: { offerId: key, ...offer, dealerRef: dealer, group, sourceRow: `${file.name}:${m.line + part}` },
          };
        });
      });
  }

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseWatchSearchCursor(context.cursor);
    const files = (await options.source.list()).filter((f) => /\.txt$/i.test(f.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
    yield* importFiles(
      files.map((file) => ({ name: file.name, read: () => options.source.read(file.name), file })),
      saved,
      (f, text) => eventsOf(f.file, text),
      batchSize,
    );
  }

  return {
    source: "watchsearch",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: WATCHSEARCH_WRITES,
  };
}
