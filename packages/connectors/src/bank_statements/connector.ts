import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { MissingColumnsError } from "../files/columns.js";
import { CsvError } from "../files/csv.js";
import { importFiles, parseFileCursor, type FileCursor, type ImportFile } from "../files/import.js";
import { directorySource, type FileSource } from "../files/source.js";
import { csvStatementLines, statementEvents, type AccountKind, type BankEvent } from "./normalize.js";
import { GENERIC_BANK_PROFILE, type BankProfile } from "./profile.js";

/**
 * Imports bank and credit card statements exported as CSV, one folder per
 * account. Each sync reads the files that are new or changed since the last
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

export interface BankStatementOptions {
  accounts: StatementAccountSource[];
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
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive whole number");
  const ids = new Set<string>();
  for (const account of options.accounts) {
    if (!ACCOUNT_ID.test(account.id)) throw new Error(`account ${JSON.stringify(account.id)} must be named like checking-1234`);
    if (ids.has(account.id)) throw new Error(`account ${account.id} is listed twice`);
    ids.add(account.id);
  }

  function eventsOf(account: StatementAccountSource, fileName: string, text: string): BankEvent[] {
    const profile = account.profile ?? GENERIC_BANK_PROFILE;
    const where = `${account.id}/${fileName}`;
    try {
      const since = new Date(now());
      since.setUTCFullYear(since.getUTCFullYear() - historyYears);
      const lines = csvStatementLines(text, profile, where);
      return statementEvents(lines, { account, profile, fileName: where, receivedAt: now().toISOString(), since: since.toISOString() });
    } catch (error) {
      if (error instanceof CsvError || error instanceof MissingColumnsError) throw new StatementFileError(where, error.message);
      throw error;
    }
  }

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseBankStatementCursor(context.cursor);
    const files: (ImportFile & { account: StatementAccountSource; fileName: string })[] = [];
    for (const account of [...options.accounts].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const listed = (await account.source.list()).filter((f) => /\.csv$/i.test(f.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const f of listed) {
        files.push({ name: `${account.id}/${f.name}`, read: () => account.source.read(f.name), account, fileName: f.name });
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
