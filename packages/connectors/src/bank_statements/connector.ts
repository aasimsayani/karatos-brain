import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { MissingColumnsError } from "../files/columns.js";
import { CsvError } from "../files/csv.js";
import { importFiles, parseFileCursor, type FileCursor, type ImportFile } from "../files/import.js";
import { PdfError, pdfLines } from "../files/pdf.js";
import { directorySource, type FileSource } from "../files/source.js";
import { csvStatementLines, statementEvents, type AccountKind, type BankEvent, type StatementLine } from "./normalize.js";
import { PdfLayoutError, pdfStatementLines } from "./pdf.js";
import { GENERIC_BANK_PROFILE, type BankProfile } from "./profile.js";

/**
 * Imports bank and credit card statements, as CSV exports or PDF
 * statements, one folder per account. Each sync reads the files that are new or changed since the last
 * one (see importFiles), so the historical import and incremental syncs work
 * the same way, and overlapping exports store each transaction once.
 * Statements are customer data: the folder lives outside every git repo.
 */

/** None: a statement can't be written back to the bank. */
export const BANK_STATEMENT_WRITES: WriteAction[] = [];

export type BankStatementCursor = FileCursor;

export interface StatementAccountSource {
  /** Lowercase name ending in the account's last four digits, such as `checking-1234`. */
  id: string;
  kind: AccountKind;
  source: FileSource;
  /** How this bank writes its exports. The generic profile when absent. */
  profile?: BankProfile;
}

export type StatementFormat = "csv" | "pdf";

export interface BankStatementOptions {
  accounts: StatementAccountSource[];
  /** Which files to read. Both by default. */
  formats?: readonly StatementFormat[];
  /** Rows dated earlier than this many years ago are skipped. */
  historyYears?: number;
  /** Events per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
}

export class StatementFileError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "StatementFileError";
  }
}

const ACCOUNT_ID = /^[a-z][a-z0-9_]*-\d{4}$/;

const isPdf = (name: string) => /\.pdf$/i.test(name);

export const parseBankStatementCursor = (raw: string | null): BankStatementCursor | null => parseFileCursor(raw, "Bank statement import");

/** Card accounts are named for it: `card-5678`, `credit_card-5678`, `amex_card-1001`. */
export const accountKind = (id: string): AccountKind => (/card|credit/.test(id) ? "credit_card" : "bank");

/**
 * One account per subfolder of BANK_STATEMENTS_IMPORT_DIR, named like
 * `checking-1234`. Other folders are skipped, so a mistyped one shows up as
 * missing rather than as a wrong account.
 */
export async function accountsFromDirectory(dir: string, profileFor: (account: string) => BankProfile = () => GENERIC_BANK_PROFILE): Promise<StatementAccountSource[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && ACCOUNT_ID.test(e.name))
    .map((e) => ({ id: e.name, kind: accountKind(e.name), source: directorySource(join(dir, e.name)), profile: profileFor(e.name) }));
}

export function bankStatementsConnector(options: BankStatementOptions): Connector {
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 6;
  const batchSize = options.batchSize ?? 250;
  const formats = new Set(options.formats ?? ["csv", "pdf"]);
  if (formats.size === 0 || [...formats].some((f) => f !== "csv" && f !== "pdf")) throw new Error("formats must list csv, pdf or both");
  const wanted = (name: string) => [...formats].some((f) => name.toLowerCase().endsWith(`.${f}`));
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive whole number");
  const ids = new Set<string>();
  for (const account of options.accounts) {
    if (!ACCOUNT_ID.test(account.id)) throw new Error(`account ${JSON.stringify(account.id)} must be named like checking-1234`);
    if (ids.has(account.id)) throw new Error(`account ${account.id} is listed twice`);
    ids.add(account.id);
  }

  /** PDFs are read as bytes and carried as latin1 text, which round-trips every byte, so the shared read loop can hash them. */
  async function eventsOf(account: StatementAccountSource, fileName: string, content: string): Promise<BankEvent[]> {
    const profile = account.profile ?? GENERIC_BANK_PROFILE;
    const where = `${account.id}/${fileName}`;
    try {
      const since = new Date(now());
      since.setUTCFullYear(since.getUTCFullYear() - historyYears);
      const lines: StatementLine[] = isPdf(fileName)
        ? pdfStatementLines(await pdfLines(Buffer.from(content, "latin1")), profile, where)
        : csvStatementLines(content, profile, where);
      return statementEvents(lines, { account, profile, fileName: where, receivedAt: now().toISOString(), since: since.toISOString() });
    } catch (error) {
      if (error instanceof CsvError || error instanceof MissingColumnsError || error instanceof PdfError || error instanceof PdfLayoutError) {
        throw new StatementFileError(where, error.message.replace(`${where}: `, ""));
      }
      throw error;
    }
  }

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseBankStatementCursor(context.cursor);
    const files: (ImportFile & { account: StatementAccountSource; fileName: string })[] = [];
    for (const account of [...options.accounts].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const listed = (await account.source.list()).filter((f) => wanted(f.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const f of listed) {
        const read = isPdf(f.name) ? async () => Buffer.from(await account.source.readBytes(f.name)).toString("latin1") : () => account.source.read(f.name);
        files.push({ name: `${account.id}/${f.name}`, read, account, fileName: f.name });
      }
    }
    yield* importFiles(files, saved, (f, text) => eventsOf(f.account, f.fileName, text), batchSize);
  }

  return {
    source: "bank_statements",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: BANK_STATEMENT_WRITES,
  };
}
