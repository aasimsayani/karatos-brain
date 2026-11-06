import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { MissingColumnsError } from "../files/columns.js";
import { CsvError } from "../files/csv.js";
import { importFiles, parseFileCursor, type FileCursor, type ImportFile } from "../files/import.js";
import { directorySource, type FileSource } from "../files/source.js";
import { csvSupplierDocuments, supplierEvents, type SupplierEvent } from "./normalize.js";
import { GENERIC_SUPPLIER_PROFILE, type SupplierProfile } from "./profile.js";

/**
 * Imports supplier invoices and memos as CSV exports, one folder per
 * supplier. Each sync reads the files that are new or changed since the last
 * one (see importFiles), so the historical import and incremental syncs work
 * the same way. Invoices are the client's business records: the folder
 * lives outside every git repo.
 */

/** None: an invoice or memo can't be written back to the supplier. */
export const SUPPLIER_INVOICE_WRITES: WriteAction[] = [];

export type SupplierInvoiceCursor = FileCursor;

export interface SupplierSource {
  /** Lowercase folder name for the supplier, such as `test_supplier`. */
  id: string;
  source: FileSource;
  /** How this supplier writes its exports. The generic profile when absent. */
  profile?: SupplierProfile;
}

export interface SupplierInvoiceOptions {
  suppliers: SupplierSource[];
  /** Documents dated earlier than this many years ago are skipped. */
  historyYears?: number;
  /** Events per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
}

export class SupplierFileError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "SupplierFileError";
  }
}

const SUPPLIER_ID = /^[a-z][a-z0-9_]{1,39}$/;

export const parseSupplierInvoiceCursor = (raw: string | null): SupplierInvoiceCursor | null => parseFileCursor(raw, "Supplier invoice import");

/**
 * One supplier per subfolder of SUPPLIER_INVOICES_IMPORT_DIR, named in
 * lowercase like `test_supplier`. Other folders are skipped, so a mistyped
 * one shows up as missing rather than as a wrong supplier.
 */
export async function suppliersFromDirectory(dir: string, profileFor: (supplier: string) => SupplierProfile = () => GENERIC_SUPPLIER_PROFILE): Promise<SupplierSource[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && SUPPLIER_ID.test(e.name))
    .map((e) => ({ id: e.name, source: directorySource(join(dir, e.name)), profile: profileFor(e.name) }));
}

export function supplierInvoicesConnector(options: SupplierInvoiceOptions): Connector {
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 6;
  const batchSize = options.batchSize ?? 250;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive whole number");
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");
  const ids = new Set<string>();
  for (const supplier of options.suppliers) {
    if (!SUPPLIER_ID.test(supplier.id)) throw new Error(`supplier ${JSON.stringify(supplier.id)} must be a lowercase folder name such as test_supplier`);
    if (ids.has(supplier.id)) throw new Error(`supplier ${supplier.id} is listed twice`);
    ids.add(supplier.id);
  }

  function eventsOf(supplier: SupplierSource, fileName: string, content: string): SupplierEvent[] {
    const where = `${supplier.id}/${fileName}`;
    try {
      const since = new Date(now());
      since.setUTCFullYear(since.getUTCFullYear() - historyYears);
      const documents = csvSupplierDocuments(content, supplier.profile ?? GENERIC_SUPPLIER_PROFILE, where);
      return supplierEvents(documents, { supplier: supplier.id, fileName: where, receivedAt: now().toISOString(), since: since.toISOString() });
    } catch (error) {
      if (error instanceof CsvError || error instanceof MissingColumnsError) {
        throw new SupplierFileError(where, error.message.replace(`${where}: `, "").replace(`${where} `, ""));
      }
      throw error;
    }
  }

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseSupplierInvoiceCursor(context.cursor);
    const files: (ImportFile & { supplier: SupplierSource; fileName: string })[] = [];
    for (const supplier of [...options.suppliers].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const listed = (await supplier.source.list()).filter((f) => /\.csv$/i.test(f.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const f of listed) files.push({ name: `${supplier.id}/${f.name}`, read: () => supplier.source.read(f.name), supplier, fileName: f.name });
    }
    yield* importFiles(files, saved, (f, text) => eventsOf(f.supplier, f.fileName, text), batchSize);
  }

  return {
    source: "supplier_invoices",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: SUPPLIER_INVOICE_WRITES,
  };
}
