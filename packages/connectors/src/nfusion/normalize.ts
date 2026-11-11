import { createHash } from "node:crypto";
import type { PricedMetal } from "../metals_api/client.js";
import { METALS, type MetalPriceEvent } from "../metals_api/connector.js";

/**
 * nFusion spot prices as the metals department's metal.price_updated
 * events, in the shape the Metals-API connector gives: `{ metal,
 * spotPerTroyOunceCents, quote, priceDate }`, in US cents per troy ounce.
 *
 * - A spot summary's `last` is a `latest` quote, keyed by metal and the
 *   time nFusion gives it.
 * - A daily history interval's `last` is a `daily` close, keyed by metal and
 *   day, and stands for the interval's end. Only finished days are kept.
 *
 * nFusion also gives bid, ask, open, high and low. The department's schema
 * for metal.price_updated names only the metal and the price, and parsing
 * drops anything else, so they are left out.
 *
 * Each response element carries its own `success` and `error`, so one metal
 * can fail while the others read. An element or interval that doesn't read
 * is dead-lettered listing what was wrong, never guessed. A history `last`
 * of null means nFusion has no close for that day, so the day is skipped.
 */

export interface NfusionDeadLetter {
  id: string;
  type: "metal.price_updated";
  occurredAt: undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: { system: "nFusion"; kind: string; problems: string[] };
}

export type NfusionEvent = MetalPriceEvent | NfusionDeadLetter;

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify([value])).digest("hex").slice(0, 16);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const said = (v: unknown) => (typeof v === "string" && v.trim() ? `: ${v.trim().replace(/\s+/g, " ").slice(0, 200)}` : "");

const realDay = (day: string) => {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
};

/**
 * A time nFusion gives, as an ISO time, or undefined. nFusion's spec types
 * these as date-time without saying whether a zone is always sent; one
 * without a zone is read as UTC. A day that isn't on the calendar, such as
 * February 30, doesn't read.
 */
export function nfusionTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !TIME.test(value) || !realDay(value.slice(0, 10))) return undefined;
  const ms = Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** The calendar day a time nFusion gives starts on, as nFusion wrote it, or undefined. */
export function nfusionDay(value: unknown): string | undefined {
  return nfusionTime(value) === undefined ? undefined : (value as string).slice(0, 10);
}

/**
 * Dollars per troy ounce as whole cents, or undefined for anything that
 * isn't a finite number, or is under a cent or over a million dollars an
 * ounce, which no precious metal has traded at.
 */
export function nfusionCents(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const cents = Math.round(value * 100);
  return cents >= 1 && cents <= 100_000_000 ? cents : undefined;
}

/** A metal name nFusion gives, as one the brain prices, or undefined. */
export function nfusionMetal(value: unknown): PricedMetal | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().toLowerCase();
  return METALS.find((m) => m === name);
}

export function nfusionPriceEvent(metal: PricedMetal, cents: number, quote: "daily" | "latest", occurredAt: string, priceDate: string, receivedAt: string): MetalPriceEvent {
  const key = quote === "daily" ? `${metal}:daily:${priceDate}` : `${metal}:latest:${occurredAt}`;
  return {
    id: `nfusion_${key.replace(/[^A-Za-z0-9_-]/g, "_")}`,
    type: "metal.price_updated",
    occurredAt,
    receivedAt,
    idempotencyKey: `nfusion:${key}`,
    payload: { metal, spotPerTroyOunceCents: cents, quote, priceDate },
  };
}

export function nfusionDeadLetter(kind: string, raw: unknown, problems: string[], receivedAt: string): NfusionDeadLetter {
  const idempotencyKey = `nfusion:unreadable_${kind}:${short(raw)}`;
  return {
    id: idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "_"),
    type: "metal.price_updated",
    occurredAt: undefined,
    receivedAt,
    idempotencyKey,
    payload: { system: "nFusion", kind, problems },
  };
}

/** What is wrong with a response element as a whole: its success flag, metal, currency and unit. */
function elementProblems(raw: unknown, data: Record<string, unknown> | undefined): { metal: PricedMetal | undefined; problems: string[] } {
  const e = obj(raw);
  if (!e) return { metal: undefined, problems: ["element is not an object"] };
  const problems: string[] = [];
  if (e.success !== true) problems.push(`nFusion did not answer it${said(e.error)}`);
  const metal = nfusionMetal(data && data.symbol !== undefined ? data.symbol : e.requestedSymbol);
  if (e.success === true) {
    if (!data) problems.push("element has no data");
    if (!metal) problems.push("element is not for gold, silver, platinum or palladium");
    if (data && data.baseCurrency !== "USD") problems.push("element is not in USD");
    if (e.requestedUnitOfMeasure !== undefined && e.requestedUnitOfMeasure !== null && e.requestedUnitOfMeasure !== "toz") problems.push("element is not per troy ounce");
  }
  return { metal, problems };
}

/** The latest spot summary: one `latest` quote for each element that reads. */
export function nfusionSummaryEvents(elements: readonly unknown[], receivedAt: string): NfusionEvent[] {
  return elements.map((raw) => {
    const data = obj(obj(raw)?.data);
    const { metal, problems } = elementProblems(raw, data);
    const at = nfusionTime(data?.timeStamp);
    const cents = nfusionCents(data?.last);
    if (problems.length === 0) {
      if (!at) problems.push("summary has no timeStamp that reads");
      if (cents === undefined) problems.push("summary has no last price that reads");
    }
    if (problems.length > 0 || !metal || !at || cents === undefined) return nfusionDeadLetter("summary", raw, problems, receivedAt);
    return nfusionPriceEvent(metal, cents, "latest", at, at.slice(0, 10), receivedAt);
  });
}

export interface NfusionHistoryRead {
  events: NfusionEvent[];
  /** The last day a close was kept for, or null when none was. */
  lastDay: string | null;
}

/**
 * Daily history: a `daily` close for each finished interval from `from` to
 * `through` (YYYY-MM-DD, both kept) of each element that reads. An interval
 * not yet over at `now`, or outside the days asked for, is left for a
 * later read.
 */
export function nfusionHistoryEvents(elements: readonly unknown[], from: string, through: string, now: Date, receivedAt: string): NfusionHistoryRead {
  const events: NfusionEvent[] = [];
  let lastDay: string | null = null;
  for (const raw of elements) {
    const data = obj(obj(raw)?.data);
    const { metal, problems } = elementProblems(raw, data);
    if (problems.length === 0 && !Array.isArray(data?.intervals)) problems.push("element has no intervals");
    if (problems.length > 0 || !metal) {
      events.push(nfusionDeadLetter("history", raw, problems, receivedAt));
      continue;
    }
    for (const interval of data!.intervals as unknown[]) {
      const i = obj(interval);
      const day = nfusionDay(i?.start);
      const start = nfusionTime(i?.start);
      const end = nfusionTime(i?.end);
      const wrong: string[] = [];
      if (!i) wrong.push("interval is not an object");
      else {
        if (!day) wrong.push("interval has no start that reads");
        if (!end) wrong.push("interval has no end that reads");
        else if (start && Date.parse(end) <= Date.parse(start)) wrong.push("interval ends before it starts");
      }
      if (wrong.length > 0 || !day || !end) {
        events.push(nfusionDeadLetter("history_interval", { metal, interval }, wrong, receivedAt));
        continue;
      }
      // Not over yet, or not a day asked for: a later read keeps it.
      if (Date.parse(end) > now.getTime() || day < from || day > through) continue;
      // No close that day.
      if (i!.last === null || i!.last === undefined) continue;
      const cents = nfusionCents(i!.last);
      if (cents === undefined) {
        events.push(nfusionDeadLetter("history_interval", { metal, interval }, ["interval has no last price that reads"], receivedAt));
        continue;
      }
      events.push(nfusionPriceEvent(metal, cents, "daily", end, day, receivedAt));
      if (lastDay === null || day > lastDay) lastDay = day;
    }
  }
  return { events, lastDay };
}
