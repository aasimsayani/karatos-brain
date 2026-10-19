import type { CsvRow } from "./csv.js";

/** A header name, or several a system has used for the same column. */
export type ColumnSpec = string | string[];
export type ColumnMap = Record<string, ColumnSpec | undefined>;
/** Reads one mapped field from a row; undefined when the column isn't mapped or isn't in the file. */
export type ColumnGetter = (row: CsvRow, field: string) => string | undefined;

/** Header and label matching ignores case, surrounding space and repeated spaces. */
export const squash = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ");

export class MissingColumnsError extends Error {
  constructor(
    readonly file: string,
    readonly missing: string[],
  ) {
    super(`${file} has no column for ${missing.join(", ")}`);
    this.name = "MissingColumnsError";
  }
}

/** True when every required field's column is among the headers. */
export function hasColumns(headers: string[], columns: ColumnMap, required: string[]): boolean {
  const names = new Set(headers.map(squash));
  return required.every((field) => {
    const spec = columns[field];
    return spec !== undefined && (Array.isArray(spec) ? spec : [spec]).some((n) => names.has(squash(n)));
  });
}

/**
 * Finds each mapped column in a file's headers. Throws MissingColumnsError
 * naming the file and the missing columns when a required one is absent,
 * because every row would be wrong.
 */
export function columnReader(headers: string[], columns: ColumnMap, required: string[], fileName: string): ColumnGetter {
  const byName = new Map(headers.map((h) => [squash(h), h]));
  const found: Record<string, string> = {};
  const missing: string[] = [];
  for (const [field, spec] of Object.entries(columns)) {
    if (spec === undefined) continue;
    const names = Array.isArray(spec) ? spec : [spec];
    const header = names.map((n) => byName.get(squash(n))).find((h) => h !== undefined);
    if (header !== undefined) found[field] = header;
    else if (required.includes(field)) missing.push(names.join(" or "));
  }
  if (missing.length) throw new MissingColumnsError(fileName, missing);
  return (row, field) => {
    const header = found[field];
    return header === undefined ? undefined : row.values[header];
  };
}
