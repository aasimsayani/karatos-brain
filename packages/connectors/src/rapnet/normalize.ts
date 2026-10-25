import { createHash } from "node:crypto";
import type { RapnetShape } from "./client.js";

/**
 * Turns a Rapaport price list into Brain A events. Each shape's weekly list
 * becomes one diamond_price.list_published event holding every cell (carat
 * range, color, clarity and price per carat), and the cells that moved in
 * that list become one diamond_price.list_changed event with their old and
 * new prices. Both are keyed by shape, list date and content, so reading the
 * same list again is a duplicate and a corrected list is a new event.
 *
 * The list's date is the newest day any of its cells was priced; each cell
 * keeps its own. A list with a cell that doesn't read (a size, grade, price
 * or date that isn't one) is kept but dead-lettered, listing what was
 * wrong, so a person checks it before any price in it is used.
 */

export interface RapnetEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const RAPNET_EVENT_TYPES = { list: "diamond_price.list_published", changes: "diamond_price.list_changed" } as const;

/** One cell of the list: a carat range, color and clarity, and its price. */
export interface RapaportCell {
  fromCarat: number;
  toCarat: number;
  color: string;
  clarity: string;
  /** US dollars per carat, as the list states it. */
  perCaratUsd: number;
  /** The day Rapaport set this price, as YYYY-MM-DD. */
  pricedOn: string;
}

export interface RapaportChange extends RapaportCell {
  /** The price per carat in the list before, when Rapaport gives it. */
  previousPerCaratUsd: number | null;
  previousDate: string | null;
}

/** Single colors (D to N) and the groups small sizes are priced in (D-F, G-H). */
const COLOR = /^[D-Z](-[D-Z])?$/;
/** Single clarities and the groups small sizes are priced in (IF-VVS, VS). */
const CLARITY = /^(FL|IF|VVS[12]?|VS[12]?|SI[123]?|I[123]?)(-(FL|IF|VVS[12]?|VS[12]?|SI[123]?|I[123]?))?$/;

const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

/** A size or price as a number: "1370.0000" or 860. Null when it isn't a positive one. */
export function rapNumber(value: unknown): number | null {
  const raw = text(value);
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && Number.isFinite(n) ? n : null;
}

/** A list date, "09/15/2023 00:00:00" or "2023-09-15", as YYYY-MM-DD. Null when it isn't a real day. */
export function rapDate(value: unknown): string | null {
  const raw = text(value);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(raw);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s][\d:.]+Z?)?$/.exec(raw);
  const [y, m, d] = us ? [us[3], us[1], us[2]] : iso ? [iso[1], iso[2], iso[3]] : [];
  if (!y) return null;
  const day = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const out = `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  return day.toISOString().slice(0, 10) === out ? out : null;
}

interface Read<T> {
  cells: T[];
  /** The newest day any cell was priced: the list's own date. */
  latest: string | null;
  problems: string[];
}

function readCells<T extends RapaportCell>(shape: RapnetShape, rows: unknown[], extra: (row: Record<string, unknown>, problem: (what: string) => void) => Omit<T, keyof RapaportCell>): Read<T> {
  const out: Read<T> = { cells: [], latest: null, problems: [] };
  rows.forEach((raw, i) => {
    const problem = (what: string) => out.problems.push(`row ${i + 1}: ${what}`);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return problem("is not a row");
    const row = raw as Record<string, unknown>;
    const before = out.problems.length;
    if (text(row.shape).toLowerCase() !== shape.toLowerCase()) problem("is for another shape");
    const fromCarat = rapNumber(row.low_size);
    const toCarat = rapNumber(row.high_size);
    if (fromCarat === null || toCarat === null || fromCarat > toCarat || toCarat >= 100) problem("has no carat range that reads");
    const color = text(row.color).toUpperCase();
    if (!COLOR.test(color)) problem("has no color grade that reads");
    const clarity = text(row.clarity).toUpperCase();
    if (!CLARITY.test(clarity)) problem("has no clarity grade that reads");
    const perCaratUsd = rapNumber(row.caratprice);
    if (perCaratUsd === null) problem("has no price that reads");
    const pricedOn = rapDate(row.date);
    if (pricedOn === null) problem("has no date that reads");
    const more = extra(row, problem);
    if (out.problems.length === before) {
      out.cells.push({ fromCarat: fromCarat!, toCarat: toCarat!, color, clarity, perCaratUsd: perCaratUsd!, pricedOn: pricedOn!, ...more } as T);
      if (!out.latest || pricedOn! > out.latest) out.latest = pricedOn!;
    }
  });
  if (rows.length === 0) out.problems.push("the list has no rows");
  return out;
}

function event(kind: keyof typeof RAPNET_EVENT_TYPES, shape: RapnetShape, read: Read<RapaportCell>, receivedAt: string, extra: Record<string, unknown> = {}): RapnetEvent {
  const date = read.latest;
  const ok = read.problems.length === 0 && date !== null;
  const key = `rapnet:${kind}:${shape.toLowerCase()}:${date ?? "undated"}:${short(read.cells)}`;
  return {
    id: key.replace(/^rapnet:/, "rapnet_"),
    type: RAPNET_EVENT_TYPES[kind],
    // The list's own date, at midnight UTC. A list with a problem has none, so it is dead-lettered.
    occurredAt: ok ? `${date}T00:00:00.000Z` : undefined,
    receivedAt,
    idempotencyKey: key,
    payload: {
      source: "Rapaport",
      shape,
      priceDate: date ?? null,
      currency: "USD",
      unit: "per_carat",
      ...extra,
      cells: read.cells,
      ...(read.problems.length ? { problems: read.problems.slice(0, 50), problemCount: read.problems.length } : {}),
    },
  };
}

/** A shape's full list as one event. Returns its date too, for the checkpoint. */
export function listEvent(shape: RapnetShape, rows: unknown[], receivedAt: string): { event: RapnetEvent; date: string | null } {
  const read = readCells<RapaportCell>(shape, rows, () => ({}));
  const e = event("list", shape, read, receivedAt, { cellCount: read.cells.length });
  return { event: e, date: e.occurredAt ? (e.payload.priceDate as string) : null };
}

/** The cells that moved in a shape's latest list as one event, or null when none moved. */
export function changesEvent(shape: RapnetShape, rows: unknown[], receivedAt: string): RapnetEvent | null {
  if (rows.length === 0) return null;
  const read = readCells<RapaportChange>(shape, rows, (row, problem) => {
    const hasOld = row.old_caratprice !== undefined && row.old_caratprice !== null && text(row.old_caratprice) !== "";
    const previousPerCaratUsd = hasOld ? rapNumber(row.old_caratprice) : null;
    if (hasOld && previousPerCaratUsd === null) problem("has an old price that doesn't read");
    const hasOldDate = row.old_date !== undefined && row.old_date !== null && text(row.old_date) !== "";
    const previousDate = hasOldDate ? rapDate(row.old_date) : null;
    if (hasOldDate && previousDate === null) problem("has an old date that doesn't read");
    return { previousPerCaratUsd, previousDate };
  });
  const changes = read.cells as RapaportChange[];
  const up = changes.filter((c) => c.previousPerCaratUsd !== null && c.perCaratUsd > c.previousPerCaratUsd).length;
  const down = changes.filter((c) => c.previousPerCaratUsd !== null && c.perCaratUsd < c.previousPerCaratUsd).length;
  return event("changes", shape, read, receivedAt, { changedCount: changes.length, raised: up, lowered: down });
}
