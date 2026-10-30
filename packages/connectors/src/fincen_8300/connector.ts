import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { columnReader, MissingColumnsError } from "../files/columns.js";
import { CsvError, parseCsv } from "../files/csv.js";
import { importFiles, parseFileCursor, type FileCursor } from "../files/import.js";
import type { FileSource, SourceFile } from "../files/source.js";
import type { DateOrder } from "../files/values.js";
import { FILING_COLUMNS, FILING_REQUIRED, filingEvent, type Form8300Event } from "./normalize.js";

/**
 * Imports a store's Form 8300 filings log, kept as CSV in a folder, so the
 * brain knows which cash sales are already reported, which filings FinCEN
 * rejected, and which customers still need the written statement due by
 * January 31. Filing itself stays with a person in FinCEN's BSA E-Filing
 * System, which has no API; the compliance department finds the cash
 * sales that need a filing from the POS and bank data. Every sync reads
 * the files that are new or changed since the last one, so the historical
 * import and incremental syncs work the same way.
 */

/** None: Form 8300 is filed by a person in BSA E-Filing, and the log is the store's own file. */
export const FINCEN_8300_WRITES: WriteAction[] = [];

export type Fincen8300Cursor = FileCursor;

export interface Fincen8300Options {
  source: FileSource;
  /** How the log writes dates. US month first unless set. */
  dateOrder?: DateOrder;
  /** Filings older than this many years are skipped; the IRS asks for five years of copies. */
  historyYears?: number;
  /** Events per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
}

export class Fincen8300FileError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "Fincen8300FileError";
  }
}

export const parseFincen8300Cursor = (raw: string | null): Fincen8300Cursor | null => parseFileCursor(raw, "Form 8300 import");

/** CSV files in the folder are read as the filings log; anything else is skipped. */
export const isFilingsLog = (name: string) => /\.csv$/i.test(name) && !name.startsWith(".");

export function fincen8300Connector(options: Fincen8300Options): Connector {
  const now = options.now ?? (() => new Date());
  const dateOrder = options.dateOrder ?? "mdy";
  const historyYears = options.historyYears ?? 5;
  const batchSize = options.batchSize ?? 250;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive whole number");
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  function eventsOf(file: SourceFile, text: string): Form8300Event[] {
    try {
      const table = parseCsv(text);
      const get = columnReader(table.headers, FILING_COLUMNS, FILING_REQUIRED, file.name);
      const since = new Date(now());
      since.setUTCFullYear(since.getUTCFullYear() - historyYears);
      const ctx = { file, dateOrder, receivedAt: now().toISOString(), since: since.toISOString() };
      return table.rows.map((row) => filingEvent(row, get, ctx)).filter((e): e is Form8300Event => e !== null);
    } catch (error) {
      if (error instanceof CsvError || error instanceof MissingColumnsError) throw new Fincen8300FileError(file.name, error.message.replace(`${file.name} `, ""));
      throw error;
    }
  }

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const files = (await options.source.list()).filter((f) => isFilingsLog(f.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
    yield* importFiles(
      files.map((file) => ({ name: file.name, read: () => options.source.read(file.name), file })),
      parseFincen8300Cursor(context.cursor),
      (f, text) => eventsOf(f.file, text),
      batchSize,
    );
  }

  return {
    source: "fincen_8300",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: FINCEN_8300_WRITES,
  };
}
