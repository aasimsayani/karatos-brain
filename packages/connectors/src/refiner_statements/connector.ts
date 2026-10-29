import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { MissingColumnsError } from "../files/columns.js";
import { CsvError } from "../files/csv.js";
import { importFiles, parseFileCursor, type FileCursor, type ImportFile } from "../files/import.js";
import { PdfError, pdfLines } from "../files/pdf.js";
import { directorySource, type FileSource } from "../files/source.js";
import { csvSettlementLines, settlementEvents, type RefinerEvent, type SettlementLine } from "./normalize.js";
import { RefinerPdfLayoutError, pdfSettlementLines } from "./pdf.js";
import { GENERIC_REFINER_PROFILE, type RefinerProfile } from "./profile.js";

/**
 * Imports refiner and scrap settlement statements, as CSV exports or PDF
 * statements, one folder per refiner. Each sync reads the files that are new
 * or changed since the last one (see importFiles), so the historical import
 * and incremental syncs work the same way. Statements are the client's
 * business records: the folder lives outside every git repo.
 */

/** None: a settlement can't be written back to the refiner. */
export const REFINER_STATEMENT_WRITES: WriteAction[] = [];

export type RefinerStatementCursor = FileCursor;

export interface RefinerSource {
  /** Lowercase folder name for the refiner, such as `test_refinery`. */
  id: string;
  source: FileSource;
  /** How this refiner writes its statements. The generic profile when absent. */
  profile?: RefinerProfile;
}

export type SettlementFormat = "csv" | "pdf";

export interface RefinerStatementOptions {
  refiners: RefinerSource[];
  /** Which files to read. Both by default. */
  formats?: readonly SettlementFormat[];
  /** Lines dated earlier than this many years ago are skipped. */
  historyYears?: number;
  /** Events per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
}

export class SettlementFileError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "SettlementFileError";
  }
}

const REFINER_ID = /^[a-z][a-z0-9_]{1,39}$/;

const isPdf = (name: string) => /\.pdf$/i.test(name);

export const parseRefinerStatementCursor = (raw: string | null): RefinerStatementCursor | null => parseFileCursor(raw, "Refiner statement import");

/**
 * One refiner per subfolder of REFINER_STATEMENTS_IMPORT_DIR, named in
 * lowercase like `test_refinery`. Other folders are skipped, so a mistyped
 * one shows up as missing rather than as a wrong refiner.
 */
export async function refinersFromDirectory(dir: string, profileFor: (refiner: string) => RefinerProfile = () => GENERIC_REFINER_PROFILE): Promise<RefinerSource[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && REFINER_ID.test(e.name))
    .map((e) => ({ id: e.name, source: directorySource(join(dir, e.name)), profile: profileFor(e.name) }));
}

export function refinerStatementsConnector(options: RefinerStatementOptions): Connector {
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const batchSize = options.batchSize ?? 250;
  const formats = new Set(options.formats ?? ["csv", "pdf"]);
  if (formats.size === 0 || [...formats].some((f) => f !== "csv" && f !== "pdf")) throw new Error("formats must list csv, pdf or both");
  const wanted = (name: string) => [...formats].some((f) => name.toLowerCase().endsWith(`.${f}`));
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive whole number");
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");
  const ids = new Set<string>();
  for (const refiner of options.refiners) {
    if (!REFINER_ID.test(refiner.id)) throw new Error(`refiner ${JSON.stringify(refiner.id)} must be a lowercase folder name such as test_refinery`);
    if (ids.has(refiner.id)) throw new Error(`refiner ${refiner.id} is listed twice`);
    ids.add(refiner.id);
  }

  /** PDFs are read as bytes and carried as latin1 text, which round-trips every byte, so the shared read loop can hash them. */
  async function eventsOf(refiner: RefinerSource, fileName: string, content: string): Promise<RefinerEvent[]> {
    const profile = refiner.profile ?? GENERIC_REFINER_PROFILE;
    const where = `${refiner.id}/${fileName}`;
    try {
      const since = new Date(now());
      since.setUTCFullYear(since.getUTCFullYear() - historyYears);
      const lines: SettlementLine[] = isPdf(fileName)
        ? pdfSettlementLines(await pdfLines(Buffer.from(content, "latin1")), profile, where)
        : csvSettlementLines(content, profile, where);
      return settlementEvents(lines, { refiner: refiner.id, fileName: where, receivedAt: now().toISOString(), since: since.toISOString() });
    } catch (error) {
      if (error instanceof CsvError || error instanceof MissingColumnsError || error instanceof PdfError || error instanceof RefinerPdfLayoutError) {
        throw new SettlementFileError(where, error.message.replace(`${where}: `, "").replace(`${where} `, ""));
      }
      throw error;
    }
  }

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseRefinerStatementCursor(context.cursor);
    const files: (ImportFile & { refiner: RefinerSource; fileName: string })[] = [];
    for (const refiner of [...options.refiners].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const listed = (await refiner.source.list()).filter((f) => wanted(f.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const f of listed) {
        const read = isPdf(f.name) ? async () => Buffer.from(await refiner.source.readBytes(f.name)).toString("latin1") : () => refiner.source.read(f.name);
        files.push({ name: `${refiner.id}/${f.name}`, read, refiner, fileName: f.name });
      }
    }
    yield* importFiles(files, saved, (f, text) => eventsOf(f.refiner, f.fileName, text), batchSize);
  }

  return {
    source: "refiner_statements",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: REFINER_STATEMENT_WRITES,
  };
}
