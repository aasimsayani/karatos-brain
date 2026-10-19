/**
 * Reads the values exports write in their own styles: money as "$1,250.00"
 * or "(25.00)", dates as "10/03/2025 2:05 PM", yes/no flags as "Y" or "1".
 * Each parser returns null for anything it can't read for certain, so the
 * caller can dead-letter the row instead of guessing.
 */

/** "$1,250.50" → 125050, "(25.00)" and "-25" → negative. No floating point. */
export function parseMoney(text: string | undefined): number | null {
  if (text === undefined) return null;
  let t = text.trim().replace(/\s/g, "");
  if (!t) return null;
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  if (t.startsWith("-")) {
    negative = !negative;
    t = t.slice(1);
  }
  t = t.replace(/^\$/, "");
  if (t.startsWith("-")) {
    negative = !negative;
    t = t.slice(1);
  }
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!match) return null;
  const cents = Number(match[1]!.replace(/,/g, "")) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return negative && cents !== 0 ? -cents : cents;
}

/** Whole numbers only: "3", "-1", "1,200". Null for "1.5" or text. */
export function parseInteger(text: string | undefined): number | null {
  const t = (text ?? "").trim().replace(/,/g, "");
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/** A positive decimal such as a weight: "3.25". */
export function parseDecimal(text: string | undefined): number | null {
  const t = (text ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

const TRUE = new Set(["y", "yes", "true", "1", "x", "opted in", "subscribed"]);
const FALSE = new Set(["n", "no", "false", "0", "", "opted out", "unsubscribed"]);

/** Yes/no flags. Null for a value that is neither, so nothing is assumed. */
export function parseFlag(text: string | undefined): boolean | null {
  const t = (text ?? "").trim().toLowerCase();
  if (TRUE.has(t)) return true;
  if (FALSE.has(t)) return false;
  return null;
}

export type DateOrder = "ymd" | "mdy" | "dmy";

const YMD = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const SLASHED = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i;

function offsetMinutes(offset: string): number {
  if (offset.toUpperCase() === "Z") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset)!;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Reads a date or date and time as an ISO instant. `order` says how the
 * export writes slashed dates (03/10/2025 is March in mdy, October in dmy);
 * year-first dates are read in any order. A time without its own offset is
 * read at `utcOffset`, the store's offset from UTC, such as "-05:00".
 */
export function parseDate(text: string | undefined, order: DateOrder, utcOffset = "Z"): string | null {
  const t = (text ?? "").trim();
  let year: number, month: number, day: number, hour = 0, minute = 0, second = 0;
  let offset = utcOffset;
  const ymd = YMD.exec(t);
  const slashed = ymd || order === "ymd" ? null : SLASHED.exec(t);
  if (ymd) {
    [year, month, day] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
    hour = Number(ymd[4] ?? 0);
    minute = Number(ymd[5] ?? 0);
    second = Number(ymd[6] ?? 0);
    if (ymd[7]) offset = ymd[7];
  } else if (slashed) {
    const [a, b] = [Number(slashed[1]), Number(slashed[2])];
    [month, day] = order === "mdy" ? [a, b] : [b, a];
    year = Number(slashed[3]);
    if (slashed[3]!.length === 2) year += 2000;
    hour = Number(slashed[4] ?? 0);
    minute = Number(slashed[5] ?? 0);
    second = Number(slashed[6] ?? 0);
    const meridiem = slashed[7]?.toLowerCase();
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      if (meridiem === "pm" && hour !== 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
    }
  } else {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(local);
  // Rejects 02/30 and month 13 rather than rolling them over.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return new Date(local - offsetMinutes(offset) * 60_000).toISOString();
}
