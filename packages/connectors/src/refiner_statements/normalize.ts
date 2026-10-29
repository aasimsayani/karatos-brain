import { createHash } from "node:crypto";
import { columnReader, hasColumns, MissingColumnsError, type ColumnGetter } from "../files/columns.js";
import { parseCsv, parseCsvRecords, type CsvRow } from "../files/csv.js";
import { parseDate, parseMoney } from "../files/values.js";
import { WEIGHT_UNITS, type LineField, type RefinerProfile, type WeightUnit } from "./profile.js";

/**
 * Turns refiner and scrap settlement lines into
 * `refining.settlement_line_imported` events in the metals department's
 * shape: the lot, the metal, the weights in grams, the assay, the fine metal
 * credited, and the money. Each line also says whether its fine weight adds
 * up (weight times assay), so a short assay is caught on the statement it
 * appears on. A line's key is its refiner, lot, metal and place among that
 * lot's lines for the metal, plus a hash of what it says, so overlapping
 * exports store it once and a corrected statement is stored as the newer
 * version. A value that can't be read is left null, so the pipeline
 * dead-letters the line with it kept.
 */

export type RefinedMetal = "gold" | "silver" | "platinum" | "palladium";

export const REFINING_EVENT_TYPE = "refining.settlement_line_imported";

export const GRAMS_PER: Readonly<Record<WeightUnit, number>> = { Grams: 1, Dwt: 1.55517384, Ozt: 31.1034768 };

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface RefinerEvent {
  id: string;
  type: typeof REFINING_EVENT_TYPE;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** One settlement line as read, before it becomes an event. Shared with the PDF reader. */
export interface SettlementLine {
  /** Where it came from, as `file:line`. */
  sourceRow: string;
  /** ISO instant at midnight UTC of the settlement day, or undefined when the date couldn't be read. */
  occurredAt: string | undefined;
  lot: string | null;
  metal: RefinedMetal | null;
  description?: string;
  grossGrams?: number | null;
  meltGrams?: number | null;
  /** Pure metal as a fraction, such as 0.585 for 14 karat. */
  fineness?: number | null;
  /** Fine metal credited, as the statement says or, when it doesn't, weight times assay. */
  fineGrams: number | null;
  fineFrom: "statement" | "assay";
  pricePerTroyOunceCents?: number | null;
  creditCents?: number | null;
  feeCents?: number | null;
  netCents?: number | null;
}

export interface SettlementContext {
  /** The refiner's folder name, such as `test_refinery`. */
  refiner: string;
  fileName: string;
  receivedAt: string;
  /** Lines dated before this ISO time are skipped. */
  since: string;
}

const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

const UNIT_WORDS: Readonly<Record<WeightUnit, RegExp>> = {
  Grams: /^(?:g|gr|grams?|gms?)$/i,
  Dwt: /^(?:dwt|dwts|pennyweights?)$/i,
  Ozt: /^(?:oz|ozs|ozt|toz|troy oz|troy ounces?|ounces?)$/i,
};

/**
 * A weight in the column's unit, in grams to the milligram. "1,250.5" and
 * "12.5 dwt" in a pennyweight column read; "12.5 g" there doesn't, so a
 * mislabeled column dead-letters instead of being read in the wrong unit.
 */
export function parseWeight(text: string | undefined, unit: WeightUnit): number | null {
  if (!present(text)) return null;
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*([A-Za-z][A-Za-z ]*)?$/.exec(text.trim());
  if (!m) return null;
  if (m[3] !== undefined && !UNIT_WORDS[unit].test(m[3].trim())) return null;
  const n = Number(`${m[1]!.replace(/,/g, "")}${m[2] ?? ""}`);
  return n > 0 ? round(n * GRAMS_PER[unit], 3) : null;
}

/**
 * Fineness as a fraction of pure metal: "58.5%", "0.585", "585" (parts per
 * thousand), "14K" or "14 kt". A bare number from 1 to 100 is a percentage,
 * except exactly 1, which is pure. Null for anything above pure or at zero.
 */
export function parseFineness(text: string | undefined): number | null {
  if (!present(text)) return null;
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  const karat = /^(\d{1,2}(?:\.\d+)?)(?:k|kt|karat|ct)$/.exec(t);
  if (karat) {
    const k = Number(karat[1]);
    return k > 0 && k <= 24 ? round(k / 24, 6) : null;
  }
  const m = /^(\d+(?:\.\d+)?)(%)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  let fraction: number;
  if (m[2]) fraction = n / 100;
  else if (n <= 1) fraction = n;
  else if (n <= 100) fraction = n / 100;
  else if (n <= 1000) fraction = n / 1000;
  else return null;
  return fraction > 0 && fraction <= 1 ? round(fraction, 6) : null;
}

const METAL_NAMES: [RegExp, RefinedMetal][] = [
  [/\b(?:gold|au)\b/, "gold"],
  [/\b(?:silver|ag)\b/, "silver"],
  [/\b(?:platinum|pt|plat)\b/, "platinum"],
  [/\b(?:palladium|pd)\b/, "palladium"],
];

/** "Gold", "AU", "14K gold scrap" or "Pt" to the metal. Null when no metal or more than one is named. */
export function parseRefinerMetal(text: string | undefined): RefinedMetal | null {
  if (!present(text)) return null;
  const t = text.toLowerCase();
  const found = METAL_NAMES.filter(([pattern]) => pattern.test(t)).map(([, metal]) => metal);
  return found.length === 1 ? found[0]! : null;
}

/** The first weight any unit's column holds for a measure, in grams. Null when a column is filled but unreadable. */
function weightOf(read: (field: LineField) => string | undefined, measure: "gross" | "melt" | "fine"): number | null | undefined {
  for (const unit of WEIGHT_UNITS) {
    const text = read(`${measure}${unit}`);
    if (present(text)) return parseWeight(text, unit);
  }
  return undefined;
}

/** Builds a line from its fields as text, from a CSV row or a PDF match. */
export function settlementLine(read: (field: LineField) => string | undefined, sourceRow: string, profile: RefinerProfile): SettlementLine {
  const gross = weightOf(read, "gross");
  const melt = weightOf(read, "melt");
  const fineText = read("fineness");
  const fineness = present(fineText) ? parseFineness(fineText) : undefined;
  const statedFine = weightOf(read, "fine");
  const basis = melt ?? gross;
  const fromAssay = statedFine === undefined && typeof basis === "number" && typeof fineness === "number";
  const fineGrams = statedFine !== undefined ? statedFine : fromAssay ? round(basis * fineness, 3) : null;
  const money = (field: LineField) => {
    const text = read(field);
    return present(text) ? parseMoney(text) : undefined;
  };
  const fee = money("fee");
  const description = read("description")?.trim().replace(/\s+/g, " ");
  const lot = read("lot")?.trim();
  const line: SettlementLine = {
    sourceRow,
    occurredAt: parseDate(read("date"), profile.dateOrder) ?? undefined,
    lot: lot ? lot : null,
    metal: parseRefinerMetal(read("metal")),
    fineGrams,
    fineFrom: fromAssay ? "assay" : "statement",
  };
  if (description) line.description = description;
  if (gross !== undefined) line.grossGrams = gross;
  if (melt !== undefined) line.meltGrams = melt;
  if (fineness !== undefined) line.fineness = fineness;
  const price = money("price");
  if (price !== undefined) line.pricePerTroyOunceCents = price === null || price <= 0 ? null : price;
  const credit = money("credit");
  if (credit !== undefined) line.creditCents = credit;
  // Statements print fees as charges or as negative amounts; either way it's money taken.
  if (fee !== undefined) line.feeCents = fee === null ? null : Math.abs(fee);
  const net = money("net");
  if (net !== undefined) line.netCents = net;
  return line;
}

const REQUIRED = ["date", "lot", "metal"];

/** The required fields, plus each weight and money field the profile maps, for finding the header row. */
function headerOf(records: { fields: string[] }[], profile: RefinerProfile): number {
  const columns = profile.columns;
  return records.findIndex((r) => {
    if (!hasColumns(r.fields, columns, REQUIRED)) return false;
    const has = (f: string) => hasColumns(r.fields, columns, [f]);
    return WEIGHT_UNITS.some((u) => has(`fine${u}`)) || (has("fineness") && WEIGHT_UNITS.some((u) => has(`gross${u}`) || has(`melt${u}`)));
  });
}

/**
 * Finds the header row. Refiners often put their name, the account and the
 * statement period above it, so the first record with the lot, metal, date
 * and a weight is the header.
 */
function tableOf(text: string, profile: RefinerProfile, fileName: string): { rows: CsvRow[]; get: ColumnGetter } {
  const records = parseCsvRecords(text, profile.delimiter);
  const headerAt = headerOf(records, profile);
  if (headerAt < 0) {
    // Name what's missing against the first line, the likeliest header.
    columnReader(records[0]?.fields ?? [], profile.columns, REQUIRED, fileName);
    throw new MissingColumnsError(fileName, ["a fine weight (or a weight and fineness)"]);
  }
  const header = records[headerAt]!;
  // Re-read from the header so line numbers stay true to the file.
  const lines = text.split(/\r\n|\n|\r/);
  const table = parseCsv(lines.slice(header.line - 1).join("\n"), profile.delimiter);
  const offset = header.line - 1;
  const rows = table.rows.map((r) => ({ line: r.line + offset, values: r.values }));
  return { rows, get: columnReader(table.headers, profile.columns, REQUIRED, fileName) };
}

/** Reads a CSV settlement statement into lines. Rows with no date (titles, subtotals, totals) are skipped. */
export function csvSettlementLines(text: string, profile: RefinerProfile, fileName: string): SettlementLine[] {
  const { rows, get } = tableOf(text, profile, fileName);
  const lines: SettlementLine[] = [];
  for (const row of rows) {
    if (!present(get(row, "date"))) continue;
    lines.push(settlementLine((field) => get(row, field), `${fileName}:${row.line}`, profile));
  }
  return lines;
}

/** Off by more than half a percent, or 10 milligrams on a small lot, is more than rounding. */
const FINE_TOLERANCE = 0.005;
const FINE_TOLERANCE_GRAMS = 0.01;

/** Whether the statement's fine weight is its weight times its assay. */
export function fineWeightCheck(line: Pick<SettlementLine, "grossGrams" | "meltGrams" | "fineness" | "fineGrams" | "fineFrom">): { check: "matches" | "differs" | "not_checked"; expectedFineGrams?: number } {
  const basis = line.meltGrams ?? line.grossGrams;
  if (line.fineFrom !== "statement" || typeof basis !== "number" || typeof line.fineness !== "number" || typeof line.fineGrams !== "number") return { check: "not_checked" };
  const expected = round(basis * line.fineness, 3);
  // Both sides to the milligram, so floating point never tips a line over the tolerance.
  const off = round(Math.abs(line.fineGrams - expected), 3);
  return { check: off > round(Math.max(expected * FINE_TOLERANCE, FINE_TOLERANCE_GRAMS), 3) ? "differs" : "matches", expectedFineGrams: expected };
}

const hash12 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

/** Settlement lines to events, numbering a lot's lines for the same metal so each is kept and none is doubled. */
export function settlementEvents(lines: SettlementLine[], ctx: SettlementContext): RefinerEvent[] {
  const seen = new Map<string, number>();
  const events: RefinerEvent[] = [];
  for (const line of lines) {
    if (line.occurredAt !== undefined && line.occurredAt < ctx.since) continue;
    const { sourceRow, occurredAt, lot, metal, fineFrom, ...rest } = line;
    const readable = occurredAt !== undefined && lot !== null && metal !== null && line.fineGrams !== null;
    let lineId: string;
    if (readable) {
      const same = `${ctx.refiner}:${lot}:${metal}`;
      const n = seen.get(same) ?? 0;
      seen.set(same, n + 1);
      lineId = `refiner:${same}:${n}`;
    } else {
      // Unreadable: keyed by where it is, so fixing the file and re-reading stores it once.
      lineId = `refiner:${ctx.refiner}:row:${sourceRow}`;
    }
    const check = fineWeightCheck(line);
    const payload: Record<string, unknown> = {
      lineId,
      refiner: ctx.refiner,
      lot,
      settledOn: occurredAt?.slice(0, 10) ?? null,
      metal,
      ...rest,
      fineFrom,
      fineTroyOunces: typeof line.fineGrams === "number" ? round(line.fineGrams / GRAMS_PER.Ozt, 4) : null,
      fineWeightCheck: check.check,
      ...(check.expectedFineGrams !== undefined ? { expectedFineGrams: check.expectedFineGrams } : {}),
      currency: "USD",
      sourceRow,
    };
    // What the line says, without where it was read, so the same line in two exports keys the same.
    const { sourceRow: _where, ...says } = payload;
    const key = readable ? `${lineId}:${hash12(says)}` : lineId;
    events.push({
      id: key.replace(/[^A-Za-z0-9_.:-]/g, "_"),
      type: REFINING_EVENT_TYPE,
      occurredAt,
      receivedAt: ctx.receivedAt,
      idempotencyKey: key,
      payload,
    });
  }
  return events;
}
