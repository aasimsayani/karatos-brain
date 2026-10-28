import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { importFiles, parseFileCursor, type FileCursor } from "../files/import.js";
import type { FileSource, SourceFile } from "../files/source.js";
import { documentEvent, isEdiSet, type EdiEvent } from "./normalize.js";
import { parseX12, X12Error } from "./x12.js";

/**
 * EDI with retail partners, read from the folder where the business's VAN
 * or SFTP mailbox keeps its X12 files: what partners sent (purchase orders,
 * inventory and sell-through) and copies of what the business sent back
 * (acknowledgements, ship notices and invoices). Every sync reads the files
 * that are new or changed since the last one. Test interchanges (ISA15 "T")
 * and transaction sets it doesn't read, such as 997 functional
 * acknowledgements, are skipped. It never sends a document: the mailbox is
 * only read.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the mailbox is only read. */
export const EDI_X12_WRITES: WriteAction[] = [
  { integration: "edi_x12", name: "send_po_acknowledgment", description: "Send an 855 purchase order acknowledgment to a partner" },
  { integration: "edi_x12", name: "send_ship_notice", description: "Send an 856 advance ship notice to a partner" },
  { integration: "edi_x12", name: "send_invoice", description: "Send an 810 invoice to a partner" },
];

/** File names read as X12. Partners and VANs use any of these. */
export const EDI_FILE = /\.(edi|x12|txt|dat)$/i;

/** Where an EDI import stands; see importFiles. */
export type EdiCursor = FileCursor;

export interface EdiX12Options {
  source: FileSource;
  /** Documents dated earlier than this many years ago are skipped. */
  historyYears?: number;
  /** Also read interchanges marked as test (ISA15 "T"). Off by default. */
  includeTest?: boolean;
  /** Events per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
}

export class EdiFileError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "EdiFileError";
  }
}

export const parseEdiCursor = (raw: string | null): EdiCursor | null => parseFileCursor(raw, "EDI import");

export function ediX12Connector(options: EdiX12Options): Connector {
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 2;
  const batchSize = options.batchSize ?? 250;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive whole number");

  function eventsOf(file: SourceFile, text: string): EdiEvent[] {
    let interchanges;
    try {
      interchanges = parseX12(text);
    } catch (error) {
      if (error instanceof X12Error) throw new EdiFileError(file.name, error.message);
      throw error;
    }
    const since = new Date(now());
    since.setUTCFullYear(since.getUTCFullYear() - historyYears);
    const ctx = { file: file.name, receivedAt: now().toISOString(), since: since.toISOString() };
    const events: EdiEvent[] = [];
    for (const interchange of interchanges) {
      if (interchange.usage === "T" && !options.includeTest) continue;
      for (const transaction of interchange.groups.flatMap((g) => g.transactions)) {
        if (!isEdiSet(transaction.set)) continue;
        const event = documentEvent(transaction.set, { ...ctx, interchange, transaction });
        if (event) events.push(event);
      }
    }
    return events;
  }

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const files = (await options.source.list()).filter((f) => EDI_FILE.test(f.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
    yield* importFiles(
      files.map((file) => ({ name: file.name, read: () => options.source.read(file.name), file })),
      parseEdiCursor(context.cursor),
      (f, text) => eventsOf(f.file, text),
      batchSize,
    );
  }

  return {
    source: "edi_x12",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: EDI_X12_WRITES,
  };
}
