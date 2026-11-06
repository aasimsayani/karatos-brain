import { createHash } from "node:crypto";
import { columnReader, hasColumns, MissingColumnsError, type ColumnGetter } from "../files/columns.js";
import { parseCsv, parseCsvRecords, type CsvRow } from "../files/csv.js";
import { parseDate, parseInteger, parseMoney } from "../files/values.js";
import { MONEY_FIELDS, REQUIRED_FIELDS, type DocumentField, type SupplierProfile } from "./profile.js";

/**
 * Turns the lines of supplier invoices and memos into
 * `supplier_invoice.line_imported` events in the buying department's shape:
 * the supplier, the document, the item, its quantity and cost, whether it is
 * a natural or lab-grown diamond, and whether the document carries the
 * diamond trade's System of Warranties statement or names the Kimberley
 * Process. A memo line with an item, a cost and a date to go back by also
 * becomes `memo.received`, so the memo reminder follows it. A line's key is
 * its supplier, document and place in the document, plus a hash of what it
 * says, so overlapping exports store it once and a corrected document is
 * stored as the newer version. A value that can't be read is left null, so
 * the pipeline dead-letters the line with it kept.
 */

export const SUPPLIER_LINE_EVENT = "supplier_invoice.line_imported";
export const MEMO_RECEIVED_EVENT = "memo.received";

export type DocumentType = "invoice" | "memo";
export type DiamondKind = "natural" | "lab_grown" | "none";
export type WarrantyStatement = "current" | "earlier" | "none";

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface SupplierEvent {
  id: string;
  type: typeof SUPPLIER_LINE_EVENT | typeof MEMO_RECEIVED_EVENT;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** One document line as read, before it becomes events. */
export interface DocumentLine {
  /** Where it came from, as `file:line`. */
  sourceRow: string;
  documentType: DocumentType | null;
  documentNumber: string;
  /** ISO instant at midnight UTC of the document's date, or undefined when it couldn't be read. */
  occurredAt: string | undefined;
  sku?: string;
  description?: string;
  stone?: string;
  quantity?: number | null;
  unitCostCents?: number | null;
  /** The line's amount as written or, when it isn't, quantity times unit cost. */
  amountCents: number | null;
  /** The date a memo goes back by, or an invoice is due, from its column or its terms. */
  due?: string | null;
  terms?: string;
  diamond: DiamondKind;
}

/** What a document says about where its diamonds came from, read from all of its text. */
export interface DocumentStatements {
  warrantyStatement: WarrantyStatement;
  kimberleyProcess: boolean;
}

export interface SupplierDocuments {
  lines: DocumentLine[];
  /** By document number. */
  statements: Map<string, DocumentStatements>;
}

export interface SupplierContext {
  /** The supplier's folder name, such as `test_supplier`. */
  supplier: string;
  fileName: string;
  receivedAt: string;
  /** Documents dated before this ISO time are skipped. */
  since: string;
}

const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";
const tidy = (v: string | undefined) => (present(v) ? v.trim().replace(/\s+/g, " ") : undefined);

/** Words that name a diamond's look or cut in metal, not a diamond: "diamond-cut chain". */
const NOT_A_DIAMOND = /\bdiamond[- ]?(?:cut|cuts|shaped?|pattern|finish|textured?|look)\b|\b(?:simulated|imitation|faux)\s+diamonds?\b|\bdiamond\s+simulants?\b/g;
const DIAMOND = /\bdiamonds?\b|\bdia\b|\bdiam\b|\bdias\b/;
const LAB_GROWN = /\blab(?:oratory)?[- ]?(?:grown|created|made)\b|\blgd\b|\bsynthetic\b|\bman[- ]made\b|\bcvd\b|\bhpht\b|\bcultured\s+diamonds?\b/;

/**
 * Whether a line is a natural diamond, a lab-grown one, or neither, from its
 * stone and description. "Diamond-cut", "diamond-shaped" and simulants are
 * not diamonds. A lab-grown word wins, since a lab-grown stone is still
 * called a diamond.
 */
export function diamondKind(...texts: (string | undefined)[]): DiamondKind {
  const t = texts.filter(present).join(" ").toLowerCase().replace(NOT_A_DIAMOND, " ");
  if (!DIAMOND.test(t)) return "none";
  return LAB_GROWN.test(t) ? "lab_grown" : "natural";
}

/**
 * The System of Warranties statement, in the World Diamond Council's current
 * wording ("...not involved in funding conflict, in compliance with United
 * Nations Resolutions and corresponding national laws. The seller hereby
 * guarantees that these diamonds are conflict free and confirms adherence to
 * the WDC SoW Guidelines.") or the earlier one, which ends at "conflict free,
 * based on personal knowledge and/or written guarantees".
 */
export function documentStatements(text: string): DocumentStatements {
  const t = text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const warranty =
    / not involved in funding conflict /.test(` ${t} `) || /guarantees? that these diamonds are conflict free/.test(t) || /\bsystem of warranties\b/.test(t) || /\bwdc sow\b/.test(t);
  return {
    warrantyStatement: !warranty ? "none" : /\bwdc sow guidelines\b/.test(t) ? "current" : "earlier",
    kimberleyProcess: /\bkimberley process\b|\bkpcs\b/.test(t),
  };
}

/** "Memo", "Consignment" or "Invoice" to the document type; null for anything else, such as a credit note. */
export function documentType(text: string | undefined, fileName: string): DocumentType | null {
  if (!present(text)) return /memo|consign/i.test(fileName.split("/").pop() ?? "") ? "memo" : "invoice";
  const t = text.trim().toLowerCase();
  if (/^(?:memo|memorandum|consignment|consigned|on memo)$/.test(t)) return "memo";
  if (/^(?:invoice|inv|sale|sales invoice|bill|purchase)$/.test(t)) return "invoice";
  return null;
}

const DAY_MS = 86_400_000;

/** "Net 30", "30 days" or "30 day memo" to a date that many days after the document. */
export function dueFromTerms(terms: string | undefined, documentAt: string | undefined): string | null {
  if (!present(terms) || documentAt === undefined) return null;
  const m = /^(?:net\s*)?(\d{1,3})(?:\s*days?(?:\s+memo)?)?$/i.exec(terms.trim());
  if (!m) return null;
  return new Date(Date.parse(documentAt) + Number(m[1]) * DAY_MS).toISOString().slice(0, 10);
}

/** Builds a line from its fields as text. */
export function documentLine(read: (field: DocumentField) => string | undefined, sourceRow: string, fileName: string, profile: SupplierProfile): DocumentLine {
  const occurredAt = parseDate(read("date"), profile.dateOrder) ?? undefined;
  const sku = tidy(read("sku"));
  const description = tidy(read("description"));
  const stone = tidy(read("stone"));
  const terms = tidy(read("terms"));
  const line: DocumentLine = {
    sourceRow,
    documentType: documentType(read("type"), fileName),
    documentNumber: tidy(read("number")) ?? "",
    occurredAt,
    amountCents: null,
    diamond: diamondKind(stone, description),
  };
  if (sku) line.sku = sku;
  if (description) line.description = description;
  if (stone) line.stone = stone;
  if (terms) line.terms = terms;
  const qtyText = read("quantity");
  if (present(qtyText)) {
    const q = parseInteger(qtyText);
    line.quantity = q !== null && q > 0 ? q : null;
  }
  const unitText = read("unitCost");
  if (present(unitText)) {
    const c = parseMoney(unitText);
    line.unitCostCents = c !== null && c >= 0 ? c : null;
  }
  const amountText = read("amount");
  if (present(amountText)) {
    line.amountCents = parseMoney(amountText);
  } else if (typeof line.unitCostCents === "number" && line.quantity !== null) {
    line.amountCents = line.unitCostCents * (line.quantity ?? 1);
  }
  const dueText = read("due");
  if (present(dueText)) line.due = parseDate(dueText, profile.dateOrder)?.slice(0, 10) ?? null;
  else if (terms) line.due = dueFromTerms(terms, occurredAt);
  return line;
}

/** The first record with the document number, its date and a money column is the header; suppliers often put their name and address above it. */
function headerOf(records: { fields: string[] }[], profile: SupplierProfile): number {
  const columns = profile.columns;
  return records.findIndex((r) => hasColumns(r.fields, columns, [...REQUIRED_FIELDS]) && MONEY_FIELDS.some((f) => hasColumns(r.fields, columns, [f])));
}

function tableOf(text: string, profile: SupplierProfile, fileName: string): { rows: CsvRow[]; get: ColumnGetter; before: string } {
  const records = parseCsvRecords(text, profile.delimiter);
  const headerAt = headerOf(records, profile);
  if (headerAt < 0) {
    // Name what's missing against the first line, the likeliest header.
    columnReader(records[0]?.fields ?? [], profile.columns, [...REQUIRED_FIELDS], fileName);
    throw new MissingColumnsError(fileName, ["amount or unit cost"]);
  }
  const header = records[headerAt]!;
  // Re-read from the header so line numbers stay true to the file.
  const lines = text.split(/\r\n|\n|\r/);
  const table = parseCsv(lines.slice(header.line - 1).join("\n"), profile.delimiter);
  const offset = header.line - 1;
  const rows = table.rows.map((r) => ({ line: r.line + offset, values: r.values }));
  return { rows, get: columnReader(table.headers, profile.columns, [...REQUIRED_FIELDS], fileName), before: lines.slice(0, header.line - 1).join("\n") };
}

/**
 * Reads a CSV export of invoices and memos into lines, and what each
 * document says about its diamonds. A row with a document number and an
 * item, unit cost or amount is a line; other rows, such as a statement
 * printed once under the lines, count toward their document's text. When a
 * file holds one document, the text above the header and rows without a
 * number count toward it too, since that is where a printed statement sits.
 */
export function csvSupplierDocuments(text: string, profile: SupplierProfile, fileName: string): SupplierDocuments {
  const { rows, get, before } = tableOf(text, profile, fileName);
  const lines: DocumentLine[] = [];
  const texts = new Map<string, string[]>();
  const loose: string[] = [before];
  for (const row of rows) {
    const number = tidy(get(row, "number"));
    const all = Object.values(row.values).join(" ");
    if (!number) {
      loose.push(all);
      continue;
    }
    texts.set(number, [...(texts.get(number) ?? []), all]);
    // A row with only words, such as the statement, belongs to the document's text.
    const isLine = present(get(row, "sku")) || present(get(row, "amount")) || present(get(row, "unitCost"));
    if (isLine) lines.push(documentLine((field) => get(row, field), `${fileName}:${row.line}`, fileName, profile));
  }
  const single = texts.size === 1;
  const statements = new Map([...texts.entries()].map(([number, parts]) => [number, documentStatements([...parts, ...(single ? loose : [])].join(" "))]));
  return { lines, statements };
}

const hash12 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const safe = (key: string) => key.replace(/[^A-Za-z0-9_.:-]/g, "_");

/** Document lines to events, numbering each document's lines so each is kept and none is doubled. */
export function supplierEvents(documents: SupplierDocuments, ctx: SupplierContext): SupplierEvent[] {
  const seen = new Map<string, number>();
  const events: SupplierEvent[] = [];
  for (const line of documents.lines) {
    if (line.occurredAt !== undefined && line.occurredAt < ctx.since) continue;
    const { sourceRow, occurredAt, documentType: type, documentNumber, diamond, ...rest } = line;
    const said = documents.statements.get(documentNumber) ?? { warrantyStatement: "none", kimberleyProcess: false };
    const readable = occurredAt !== undefined && type !== null && line.amountCents !== null;
    let lineId: string;
    let place: number | undefined;
    if (readable) {
      const same = `${ctx.supplier}:${type}:${documentNumber}`;
      place = seen.get(same) ?? 0;
      seen.set(same, place + 1);
      lineId = `supplier:${same}:${place}`;
    } else {
      // Unreadable: keyed by where it is, so fixing the file and re-reading stores it once.
      lineId = `supplier:${ctx.supplier}:row:${sourceRow}`;
    }
    const payload: Record<string, unknown> = {
      lineId,
      supplier: ctx.supplier,
      documentType: type,
      documentNumber,
      documentDate: occurredAt?.slice(0, 10) ?? null,
      ...rest,
      diamond,
      warrantyStatement: said.warrantyStatement,
      kimberleyProcess: said.kimberleyProcess,
      currency: "USD",
      sourceRow,
    };
    // What the line says, without where it was read, so the same line in two exports keys the same.
    const { sourceRow: _where, ...says } = payload;
    const key = readable ? `${lineId}:${hash12(says)}` : lineId;
    events.push({ id: safe(key), type: SUPPLIER_LINE_EVENT, occurredAt, receivedAt: ctx.receivedAt, idempotencyKey: key, payload });
    if (readable && type === "memo" && line.sku && typeof line.amountCents === "number" && line.amountCents > 0 && line.due) {
      // Memo numbers repeat between suppliers, so the supplier is part of the memo's id.
      const memo = { memoId: `${ctx.supplier}/${documentNumber}/${place! + 1}`, vendorId: ctx.supplier, sku: line.sku, costCents: line.amountCents, dueBack: line.due };
      const memoKey = `${lineId}:memo:${hash12(memo)}`;
      events.push({ id: safe(memoKey), type: MEMO_RECEIVED_EVENT, occurredAt, receivedAt: ctx.receivedAt, idempotencyKey: memoKey, payload: memo });
    }
  }
  return events;
}
