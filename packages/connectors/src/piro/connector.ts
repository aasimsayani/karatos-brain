import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { columnReader, MissingColumnsError } from "../files/columns.js";
import { CsvError, parseCsv } from "../files/csv.js";
import { importFiles, parseFileCursor, type FileCursor } from "../files/import.js";
import type { FileSource, SourceFile } from "../files/source.js";
import { CASTING_REQUIRED, castingEvent, JOB_REQUIRED, jobEvent, type PiroEvent } from "./normalize.js";
import { GENERIC_PIRO_PROFILE, type PiroFileKind, type PiroProfile } from "./profile.js";

/**
 * Imports PIRO's job and casting tree reports, exported as CSV into a
 * folder: where each job stands, and how much metal each casting tree took
 * and gave back. Every sync reads the files that are new or changed since
 * the last one, so the historical import and incremental syncs work the
 * same way. PIRO's EDI documents with retail partners are read by the EDI
 * X12 connector pointed at the folder PIRO writes them to; PIRO's REST API
 * is offered only for custom integrations PIRO sets up, so this connector
 * starts from the reports every account can export. Nothing is written back
 * to PIRO.
 */

/** None: a report folder can't be written back to PIRO. */
export const PIRO_WRITES: WriteAction[] = [];

export type PiroCursor = FileCursor;

export interface PiroOptions {
  source: FileSource;
  /** How this PIRO account writes its reports. The generic profile when absent. */
  profile?: PiroProfile;
  /** Rows dated earlier than this many years ago are skipped. */
  historyYears?: number;
  /** Events per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
}

export class PiroFileError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "PiroFileError";
  }
}

export const parsePiroCursor = (raw: string | null): PiroCursor | null => parseFileCursor(raw, "PIRO import");

/** Casting reports first, since a casting report often names its jobs too. */
const KIND_ORDER: PiroFileKind[] = ["casting", "jobs"];

/** The kind of report a file name matches under this profile. Only CSV files are read. */
export function piroFileKind(name: string, profile: PiroProfile): PiroFileKind | null {
  if (!/\.csv$/i.test(name)) return null;
  return KIND_ORDER.find((kind) => profile.files[kind] !== undefined && new RegExp(profile.files[kind]!, "i").test(name)) ?? null;
}

export function piroConnector(options: PiroOptions): Connector {
  const profile = options.profile ?? GENERIC_PIRO_PROFILE;
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const batchSize = options.batchSize ?? 250;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive whole number");
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  function eventsOf(file: SourceFile, kind: PiroFileKind, text: string): PiroEvent[] {
    try {
      const table = parseCsv(text, profile.delimiter);
      const get = columnReader(table.headers, profile.columns[kind]!, kind === "jobs" ? JOB_REQUIRED : CASTING_REQUIRED, file.name);
      const since = new Date(now());
      since.setUTCFullYear(since.getUTCFullYear() - historyYears);
      const ctx = { file, profile, receivedAt: now().toISOString(), since: since.toISOString() };
      const toEvent = kind === "jobs" ? jobEvent : castingEvent;
      return table.rows.map((row) => toEvent(row, get, ctx)).filter((e): e is PiroEvent => e !== null);
    } catch (error) {
      if (error instanceof CsvError || error instanceof MissingColumnsError) throw new PiroFileError(file.name, error.message.replace(`${file.name} `, ""));
      throw error;
    }
  }

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const files = (await options.source.list())
      .map((file) => ({ file, kind: piroFileKind(file.name, profile) }))
      .filter((f): f is { file: SourceFile; kind: PiroFileKind } => f.kind !== null)
      .sort((a, b) => (a.file.name < b.file.name ? -1 : 1));
    yield* importFiles(
      files.map(({ file, kind }) => ({ name: file.name, read: () => options.source.read(file.name), file, kind })),
      parsePiroCursor(context.cursor),
      (f, text) => eventsOf(f.file, f.kind, text),
      batchSize,
    );
  }

  return {
    source: "piro",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: PIRO_WRITES,
  };
}
