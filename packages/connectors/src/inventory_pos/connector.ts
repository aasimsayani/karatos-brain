import { readFile } from "node:fs/promises";
import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { CsvError, parseCsv } from "../files/csv.js";
import { importFiles, parseFileCursor, type FileCursor } from "../files/import.js";
import type { FileSource, SourceFile } from "../files/source.js";
import { columnReader, MissingColumnsError } from "../files/columns.js";
import { REQUIRED_COLUMNS, ROW_EVENTS, type PosEvent } from "./normalize.js";
import { FILE_KINDS, GENERIC_POS_PROFILE, parsePosProfile, PosProfileError, type FileKind, type PosProfile } from "./profile.js";

/**
 * Imports point-of-sale exports dropped into a folder as CSV: item lists,
 * stock counts, customer lists and sales lines. A mapping profile says which
 * columns hold what. Every sync reads the files that are new or have changed
 * since the last one, so the historical import and incremental syncs work
 * the same way; a changed file is read again from the top and its unchanged
 * rows come back as duplicates. Nothing is ever written back to the POS.
 */

/** None: an export folder can't be written back to the POS. */
export const INVENTORY_POS_WRITES: WriteAction[] = [];

/** Where a POS import stands; see importFiles. */
export type PosCursor = FileCursor;

export interface InventoryPosOptions {
  source: FileSource;
  /** How this POS writes its exports. The generic profile when absent. */
  profile?: PosProfile;
  /** Rows dated earlier than this many years ago are skipped. */
  historyYears?: number;
  /** Events per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
}

export class PosFileError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "PosFileError";
  }
}

export const parsePosCursor = (raw: string | null): PosCursor | null => parseFileCursor(raw, "POS import");

/** The file kind a name matches under this profile, by the profile's patterns in FILE_KINDS order. */
export function fileKind(name: string, profile: PosProfile): FileKind | null {
  if (!/\.(csv|txt)$/i.test(name)) return null;
  return FILE_KINDS.find((kind) => profile.files[kind] !== undefined && new RegExp(profile.files[kind]!, "i").test(name)) ?? null;
}

/**
 * The profile the POS_MAPPING_PROFILE setting names: "generic", or a path to
 * a profile JSON file kept in the client's private instance repo.
 */
export async function resolvePosProfile(setting: string | undefined, read: (path: string) => Promise<string> = (p) => readFile(p, "utf8")): Promise<PosProfile> {
  const value = setting?.trim() ?? "";
  if (value === "" || value === "generic") return GENERIC_POS_PROFILE;
  let json: unknown;
  try {
    json = JSON.parse(await read(value));
  } catch (error) {
    throw new PosProfileError(`POS_MAPPING_PROFILE: could not read a JSON profile (${error instanceof Error ? error.name : "error"})`);
  }
  return parsePosProfile(json);
}

export function inventoryPosConnector(options: InventoryPosOptions): Connector {
  const profile = options.profile ?? GENERIC_POS_PROFILE;
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const batchSize = options.batchSize ?? 250;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive whole number");

  function eventsOf(file: SourceFile, kind: FileKind, text: string): PosEvent[] {
    try {
      const table = parseCsv(text, profile.delimiter);
      const get = columnReader(table.headers, profile.columns[kind]!, REQUIRED_COLUMNS[kind], file.name);
      const since = new Date(now());
      since.setUTCFullYear(since.getUTCFullYear() - historyYears);
      return ROW_EVENTS[kind](table.rows, get, { profile, file, receivedAt: now().toISOString(), since: since.toISOString() });
    } catch (error) {
      if (error instanceof CsvError || error instanceof MissingColumnsError) throw new PosFileError(file.name, error.message);
      throw error;
    }
  }

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parsePosCursor(context.cursor);
    const files = (await options.source.list())
      .map((file) => ({ file, kind: fileKind(file.name, profile) }))
      .filter((f): f is { file: SourceFile; kind: FileKind } => f.kind !== null)
      .sort((a, b) => FILE_KINDS.indexOf(a.kind) - FILE_KINDS.indexOf(b.kind) || (a.file.name < b.file.name ? -1 : 1));
    yield* importFiles(
      files.map(({ file, kind }) => ({ name: file.name, read: () => options.source.read(file.name), file, kind })),
      saved,
      (f, text) => eventsOf(f.file, f.kind, text),
      batchSize,
    );
  }

  return {
    source: "inventory_pos",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: INVENTORY_POS_WRITES,
  };
}
