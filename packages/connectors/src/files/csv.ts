/**
 * A small RFC 4180 CSV reader shared by every file-based connector (POS
 * exports now, bank statements next). It handles quoted fields, doubled
 * quotes, commas and line breaks inside quotes, CRLF or LF line endings, a
 * byte-order mark and a missing final newline. Blank lines are skipped.
 */

export class CsvError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`CSV line ${line}: ${message}`);
    this.name = "CsvError";
  }
}

export interface CsvRecord {
  /** Line the record starts on, counting the header as line 1. */
  line: number;
  fields: string[];
}

/** Splits CSV text into records. Throws CsvError on an unterminated quote or a stray quote inside a field. */
export function parseCsvRecords(text: string, delimiter = ","): CsvRecord[] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  let line = 1;
  let recordLine = 1;

  const endField = () => {
    fields.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    const started = fieldStarted;
    endField();
    // A blank line is one empty field; skip it. A lone "" is a value, not a blank line.
    if (fields.length > 1 || fields[0] !== "" || started) records.push({ line: recordLine, fields });
    fields = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          const next = input[i + 1];
          if (next !== undefined && next !== delimiter && next !== "\n" && next !== "\r") {
            throw new CsvError(line, "unexpected text after a closing quote");
          }
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (fieldStarted) throw new CsvError(line, "a quote inside an unquoted field");
      quoted = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (quoted) throw new CsvError(recordLine, "a quoted field is never closed");
  if (field !== "" || fieldStarted || fields.length) endRecord();
  return records;
}

export interface CsvRow {
  line: number;
  /** Values by header name, as written in the file. */
  values: Record<string, string>;
}

export interface CsvTable {
  headers: string[];
  rows: CsvRow[];
}

/**
 * Reads a CSV file with a header row. Headers are trimmed; a row with more
 * fields than headers throws, and a short row leaves the missing columns empty.
 */
export function parseCsv(text: string, delimiter = ","): CsvTable {
  const [header, ...records] = parseCsvRecords(text, delimiter);
  if (!header) return { headers: [], rows: [] };
  const headers = header.fields.map((h) => h.trim());
  const seen = new Set<string>();
  for (const h of headers) {
    const key = h.toLowerCase();
    if (h && seen.has(key)) throw new CsvError(1, `the column "${h}" appears twice`);
    seen.add(key);
  }
  const rows = records.map((record) => {
    if (record.fields.length > headers.length) {
      throw new CsvError(record.line, `${record.fields.length} fields but only ${headers.length} columns`);
    }
    const values: Record<string, string> = {};
    headers.forEach((h, i) => (values[h] = record.fields[i] ?? ""));
    return { line: record.line, values };
  });
  return { headers, rows };
}
