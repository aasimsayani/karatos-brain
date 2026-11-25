/**
 * When a store is open, from its STORE_HOURS and STORE_CLOSED_DATES
 * settings, and how many open hours fall between two times.
 *
 * STORE_HOURS is a list of entries separated by semicolons. Each entry is
 * days, then hours:
 *
 *     mon-fri 10:00-18:00; sat 10:00-17:00; sun closed
 *     tue-sat 10:00-13:00, 14:00-19:00
 *
 * - Days are mon, tue, wed, thu, fri, sat and sun, or the full English
 *   names. A range runs forward through the week from Monday to Sunday
 *   (mon-fri, fri-sun); several days or ranges are joined with commas
 *   (mon, wed, fri-sat). A day named twice is an error.
 * - Hours are `closed`, or one or more 24-hour ranges joined with commas,
 *   such as 10:00-13:00, 14:00-18:00. Times fall on the quarter hour (:00,
 *   :15, :30 or :45), and 24:00 closes at midnight. Ranges on one day may
 *   touch but not overlap.
 * - A range that runs past midnight (22:00-02:00) is rejected: split it at
 *   midnight, as fri 22:00-24:00; sat 00:00-02:00.
 * - A day no entry names is closed. A week with no open hours is an error.
 * - Case and spacing don't matter, and an empty entry (a trailing
 *   semicolon) is ignored.
 *
 * STORE_CLOSED_DATES lists days the store is shut whatever its week says,
 * as YYYY-MM-DD separated by commas, such as holidays. Both are read on the
 * clock of STORE_TIME_ZONE. See docs/deployment/instances.md#store-hours.
 */

/** Hours the store is open on one day: minutes after its midnight, open up to but not including close. */
export interface OpenRange {
  open: number;
  close: number;
}

/** When the store is open: in its time zone, each day's open ranges (0 Sunday to 6 Saturday), and dates it is shut. */
export interface StoreHours {
  timeZone: string;
  week: readonly (readonly OpenRange[])[];
  /** YYYY-MM-DD on the store's clock, sorted. */
  closedDates: readonly string[];
}

/** The hours STORE_HOURS defaults to: a typical jeweler's week. */
export const DEFAULT_STORE_HOURS = "mon-sat 10:00-18:00; sun closed";

/** Three-letter day names, 0 Sunday to 6 Saturday, as `Date#getDay` counts them. */
export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayName = (typeof DAY_NAMES)[number];

const FULL_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** Monday first: the order day ranges run in. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_MINUTES = 24 * 60;
const QUARTER_MINUTES = 15;

/** A STORE_HOURS or STORE_CLOSED_DATES value that can't be read. The message names the part that is wrong. */
export class StoreHoursError extends Error {
  override name = "StoreHoursError";
}

function dayIndex(name: string, entry: string): number {
  const short = DAY_NAMES.indexOf(name as DayName);
  const index = short >= 0 ? short : FULL_NAMES.indexOf(name);
  if (index < 0) throw new StoreHoursError(`"${name}" in "${entry}" isn't a day; use mon, tue, wed, thu, fri, sat or sun`);
  return index;
}

function daysOf(part: string, entry: string): number[] {
  const days: number[] = [];
  for (const piece of part.split(",").map((p) => p.trim())) {
    const m = /^([a-z]+)\s*(?:-\s*([a-z]+))?$/.exec(piece);
    if (!m) throw new StoreHoursError(`"${piece}" in "${entry}" isn't a day or a range of days, such as mon-fri`);
    const from = WEEK_ORDER.indexOf(dayIndex(m[1]!, entry));
    const to = m[2] === undefined ? from : WEEK_ORDER.indexOf(dayIndex(m[2], entry));
    if (to < from) throw new StoreHoursError(`"${piece}" in "${entry}" runs backwards; days run from mon to sun, so split it, e.g. sat-sun, mon`);
    days.push(...WEEK_ORDER.slice(from, to + 1));
  }
  return days;
}

function minutesOf(hour: string, minute: string, time: string, entry: string): number {
  const h = Number(hour);
  const m = Number(minute);
  if (h > 24 || m > 59 || (h === 24 && m !== 0)) throw new StoreHoursError(`"${time}" in "${entry}" isn't a time; use 24-hour times from 00:00 to 24:00`);
  if (m % QUARTER_MINUTES !== 0) throw new StoreHoursError(`"${time}" in "${entry}" isn't on the quarter hour; use :00, :15, :30 or :45`);
  return h * 60 + m;
}

function rangesOf(part: string, entry: string): OpenRange[] {
  if (part === "closed") return [];
  const ranges: OpenRange[] = [];
  for (const piece of part.split(",").map((p) => p.trim())) {
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(piece);
    if (!m) throw new StoreHoursError(`"${piece}" in "${entry}" isn't a range of hours; use 24-hour times such as 10:00-18:00, or closed`);
    const open = minutesOf(m[1]!, m[2]!, `${m[1]}:${m[2]}`, entry);
    const close = minutesOf(m[3]!, m[4]!, `${m[3]}:${m[4]}`, entry);
    if (open === DAY_MINUTES) throw new StoreHoursError(`"${piece}" in "${entry}" opens at 24:00; use 00:00 for midnight at the start of a day`);
    if (close < open) throw new StoreHoursError(`"${piece}" in "${entry}" runs past midnight; split it at midnight, e.g. fri 22:00-24:00; sat 00:00-02:00`);
    if (close === open) throw new StoreHoursError(`"${piece}" in "${entry}" opens and closes at the same time`);
    ranges.push({ open, close });
  }
  ranges.sort((a, b) => a.open - b.open);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]!.open < ranges[i - 1]!.close) throw new StoreHoursError(`the hours in "${entry}" overlap; give each time once`);
  }
  return ranges;
}

/**
 * Reads STORE_HOURS into each day's open ranges, 0 Sunday to 6 Saturday.
 * Throws a StoreHoursError naming the part that is wrong.
 */
export function parseStoreHours(text: string): OpenRange[][] {
  const week: (OpenRange[] | undefined)[] = Array.from({ length: 7 }, () => undefined);
  const entries = text
    .toLowerCase()
    .split(";")
    .map((e) => e.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (entries.length === 0) throw new StoreHoursError(`give days and hours, e.g. ${DEFAULT_STORE_HOURS}`);
  for (const entry of entries) {
    const m = /^(.*?)\s*(closed|\d.*)$/.exec(entry);
    if (!m) throw new StoreHoursError(`"${entry}" has no hours; give days then hours, e.g. mon-fri 10:00-18:00, or sun closed`);
    if (m[1] === "") throw new StoreHoursError(`"${entry}" has no days; give days then hours, e.g. mon-fri 10:00-18:00`);
    const ranges = rangesOf(m[2]!, entry);
    for (const day of daysOf(m[1]!, entry)) {
      if (week[day] !== undefined) throw new StoreHoursError(`${DAY_NAMES[day]} is given more than once`);
      week[day] = ranges;
    }
  }
  const filled = week.map((day) => day ?? []);
  if (filled.every((day) => day.length === 0)) throw new StoreHoursError("the store is never open; give at least one day's hours");
  return filled;
}

/** Reads STORE_CLOSED_DATES: real calendar dates as YYYY-MM-DD, sorted, without repeats. */
export function parseClosedDates(text: string): string[] {
  const dates = new Set<string>();
  for (const piece of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(piece);
    const real = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === piece;
    if (!real) throw new StoreHoursError(`"${piece}" isn't a date; use YYYY-MM-DD, e.g. 2026-12-25`);
    dates.add(piece);
  }
  return [...dates].sort();
}

/** The store's hours from its three settings. Throws a StoreHoursError when one can't be read. */
export function storeHours(timeZone: string, hours: string = DEFAULT_STORE_HOURS, closedDates = ""): StoreHours {
  return { timeZone, week: parseStoreHours(hours), closedDates: parseClosedDates(closedDates) };
}

/** Monday to Saturday, 10:00 to 18:00, New York time: the default until the store's own hours are set. */
export const STORE_HOURS: StoreHours = storeHours("America/New_York");

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const rangesText = (ranges: readonly OpenRange[]) => (ranges.length === 0 ? "closed" : ranges.map((r) => `${clock(r.open)}-${clock(r.close)}`).join(", "));

/** A week written back in STORE_HOURS form, Monday first, with days of the same hours run together: `mon-sat 10:00-18:00; sun closed`. */
export function formatStoreHours(week: readonly (readonly OpenRange[])[]): string {
  const runs: { from: number; to: number; text: string }[] = [];
  for (const day of WEEK_ORDER) {
    const text = rangesText(week[day] ?? []);
    const last = runs.at(-1);
    if (last && last.text === text) last.to = day;
    else runs.push({ from: day, to: day, text });
  }
  return runs.map((r) => `${DAY_NAMES[r.from]}${r.to === r.from ? "" : `-${DAY_NAMES[r.to]}`} ${r.text}`).join("; ");
}

/** The hours as the support status shows them: the zone, the week as text and by day, and the closed dates. */
export function describeStoreHours(hours: StoreHours): { timeZone: string; hours: string; week: Record<DayName, string[]>; closedDates: string[] } {
  const byDay = Object.fromEntries(WEEK_ORDER.map((d) => [DAY_NAMES[d], (hours.week[d] ?? []).map((r) => `${clock(r.open)}-${clock(r.close)}`)])) as Record<DayName, string[]>;
  return { timeZone: hours.timeZone, hours: formatStoreHours(hours.week), week: byDay, closedDates: [...hours.closedDates] };
}

const HOUR_MS = 3_600_000;
const SLOT_MS = QUARTER_MINUTES * 60_000;
const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * How many of the store's open hours fall between two times. Time is
 * counted in quarter hours, which every time zone's offset and every
 * opening time is a whole number of, so each quarter is open or closed as
 * a whole. Each quarter is read on the store's clock, so the hours stay
 * the same across a clock change, and a closed date shuts the whole day.
 */
export function businessHoursBetween(fromIso: string, toIso: string, hours: StoreHours = STORE_HOURS): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!(to > from)) return 0;
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: hours.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const closed = new Set(hours.closedDates);
  let open = 0;
  for (let slot = Math.floor(from / SLOT_MS) * SLOT_MS; slot < to; slot += SLOT_MS) {
    const parts = Object.fromEntries(format.formatToParts(slot).map((p) => [p.type, p.value]));
    if (closed.has(`${parts.year}-${parts.month}-${parts.day}`)) continue;
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    const ranges = hours.week[WEEKDAYS[parts.weekday!]!] ?? [];
    if (!ranges.some((r) => minute >= r.open && minute < r.close)) continue;
    open += Math.min(to, slot + SLOT_MS) - Math.max(from, slot);
  }
  return open / HOUR_MS;
}
