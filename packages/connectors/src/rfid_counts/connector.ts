import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { columnReader, MissingColumnsError } from "../files/columns.js";
import { CsvError, parseCsv } from "../files/csv.js";
import { importFiles, parseFileCursor, type FileCursor } from "../files/import.js";
import type { FileSource, SourceFile } from "../files/source.js";
import type { DateOrder } from "../files/values.js";
import { COUNT_COLUMNS, COUNT_REQUIRED, trayCountEvents, type TrayCountEvent } from "./normalize.js";

/**
 * Imports tray and case counts from RFID readers and barcode scanners,
 * exported as CSV into a folder, so the inventory department can check
 * each night's count against what should be in the tray. Reader software
 * varies, but each writes one row per tag; the column names in
 * COUNT_COLUMNS cover the common ones. Every sync reads the files that are
 * new or changed since the last one, so the historical import and
 * incremental syncs work the same way. Nothing is ever written back to the
 * reader software.
 */

/** None: a count export can't be written back to the reader software. */
export const RFID_COUNTS_WRITES: WriteAction[] = [];

export type RfidCountsCursor = FileCursor;

export interface RfidCountsOptions {
  source: FileSource;
  /** How the export writes slashed dates. US month first unless set. */
  dateOrder?: DateOrder;
  /** The store's offset from UTC, such as "-05:00", for times written without one. UTC unless set. */
  utcOffset?: string;
  /** Counts older than this many years are skipped. */
  historyYears?: number;
  /** Events per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
}

export class RfidCountsFileError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "RfidCountsFileError";
  }
}

export const parseRfidCountsCursor = (raw: string | null): RfidCountsCursor | null => parseFileCursor(raw, "Tray count import");

/** CSV and text exports in the folder are read as counts; anything else is skipped. */
export const isCountExport = (name: string) => /\.(csv|txt)$/i.test(name) && !name.startsWith(".");

const UTC_OFFSET = /^(Z|[+-](0\d|1[0-4]):[0-5]\d)$/;

export function rfidCountsConnector(options: RfidCountsOptions): Connector {
  const now = options.now ?? (() => new Date());
  const dateOrder = options.dateOrder ?? "mdy";
  const utcOffset = options.utcOffset ?? "Z";
  const historyYears = options.historyYears ?? 2;
  const batchSize = options.batchSize ?? 250;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive whole number");
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");
  if (!UTC_OFFSET.test(utcOffset)) throw new Error("utcOffset must be Z or an offset such as -05:00");

  function eventsOf(file: SourceFile, text: string): TrayCountEvent[] {
    try {
      const table = parseCsv(text);
      const get = columnReader(table.headers, COUNT_COLUMNS, COUNT_REQUIRED, file.name);
      const since = new Date(now());
      since.setUTCFullYear(since.getUTCFullYear() - historyYears);
      return trayCountEvents(table.rows, get, { file, dateOrder, utcOffset, receivedAt: now().toISOString(), since: since.toISOString() });
    } catch (error) {
      if (error instanceof CsvError || error instanceof MissingColumnsError) throw new RfidCountsFileError(file.name, error.message.replace(`${file.name} `, ""));
      throw error;
    }
  }

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const files = (await options.source.list()).filter((f) => isCountExport(f.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
    yield* importFiles(
      files.map((file) => ({ name: file.name, read: () => options.source.read(file.name), file })),
      parseRfidCountsCursor(context.cursor),
      (f, text) => eventsOf(f.file, text),
      batchSize,
    );
  }

  return {
    source: "rfid_counts",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: RFID_COUNTS_WRITES,
  };
}
