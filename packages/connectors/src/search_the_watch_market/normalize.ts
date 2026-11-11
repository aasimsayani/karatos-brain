import { createHash } from "node:crypto";
import type { StwmModel } from "./client.js";

/**
 * Turns Search The Watch Market's answers into Brain A events, so the
 * store sees a fair market price, and how fast a reference sells, before it
 * buys, takes a trade-in or prices a watch:
 *
 * - `watch_market.price_observed`: one for each model each day it is read,
 *   with the number of listings, the low, high and mean asking price, the
 *   market value, and the days half and 95% of listings take to sell;
 * - `watch_market.price_week`: one for each complete week of the model's
 *   price history, with the low, high and mean in each currency and the
 *   number of listings.
 *
 * A day's prices are keyed by the model, the day and a digest of what was
 * kept, and a week by the model, the week and a digest, so reading again
 * unchanged is a duplicate and a change is a new event. An answer that
 * doesn't read is dead-lettered listing what was wrong.
 */

export interface StwmEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface StwmContext {
  receivedAt: string;
  /** The day the pass began, YYYY-MM-DD in UTC. */
  day: string;
}

export const STWM_PRICE_EVENT = "watch_market.price_observed";
export const STWM_WEEK_EVENT = "watch_market.price_week";
const SYSTEM = "Search The Watch Market";
/** The currencies the history is documented to answer in. */
export const STWM_CURRENCIES = ["AED", "AUD", "CAD", "CHF", "EUR", "GBP", "HKD", "JPY", "PLN", "SGD", "USD"] as const;
const CURRENCIES = new Set<string>(STWM_CURRENCIES);
const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const whole = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
/** The day a date names, or undefined when it names none (so 2026-02-30 is turned down). */
const dayOf = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
};
/** Fields of an answer that may be anything; a field of a string or number reads as missing. */
const rec = (v: unknown) => (v ?? {}) as Record<string, unknown>;

function event(type: string, key: string, occurredAt: string | undefined, payload: Record<string, unknown>, ctx: StwmContext): StwmEvent {
  return {
    id: key.replace(/:/g, "_"),
    type,
    occurredAt,
    receivedAt: ctx.receivedAt,
    idempotencyKey: key,
    payload,
  };
}

function deadLetter(type: string, problems: string[], raw: unknown, ctx: StwmContext): StwmEvent {
  return event(type, `stwm:unreadable:${short(raw)}`, undefined, { system: SYSTEM, problems }, ctx);
}

const modelFields = (reference: string, model: StwmModel) => ({
  system: SYSTEM,
  groupId: `stwm:model:${model.groupId}`,
  reference,
  brand: model.brand,
  modelNumber: model.modelNumber,
  name: model.name,
});

/** A model's prices and days to sell, as the day's observation; none when the API has no prices for it. */
export function stwmPriceEvents(prices: unknown, daysToSell: unknown, reference: string, model: StwmModel, ctx: StwmContext): StwmEvent[] {
  if (prices === null) return [];
  const p = rec(prices);
  const d = rec(daysToSell);
  const problems: string[] = [];
  if (p.group_id !== model.groupId) problems.push("the prices are not for the model asked about");
  if (typeof p.currency !== "string" || !CURRENCIES.has(p.currency)) problems.push("the prices have no known currency");
  for (const field of ["listing_count", "min", "max", "mean", "market_value"]) if (!whole(p[field])) problems.push(`the prices have no whole ${field}`);
  if (daysToSell !== null && d.group_id !== model.groupId) problems.push("the days to sell are not for the model asked about");
  for (const field of ["sell_within_50_days", "sell_within_95_days"]) if (d[field] !== undefined && !whole(d[field])) problems.push(`the days to sell have a ${field} that isn't a whole number`);
  if (problems.length > 0) return [deadLetter(STWM_PRICE_EVENT, problems, { reference, groupId: model.groupId, prices, daysToSell }, ctx)];
  const payload = {
    ...modelFields(reference, model),
    observedOn: ctx.day,
    currency: p.currency,
    listings: p.listing_count,
    low: p.min,
    high: p.max,
    mean: p.mean,
    marketValue: p.market_value,
    sellWithin50Days: d.sell_within_50_days,
    sellWithin95Days: d.sell_within_95_days,
  };
  return [event(STWM_PRICE_EVENT, `stwm:price:${model.groupId}:${ctx.day}:${short(payload)}`, ctx.receivedAt, payload, ctx)];
}

/** A model's weekly price history, one event for each week, with a dead letter for each week that doesn't read. */
export function stwmWeekEvents(history: unknown, reference: string, model: StwmModel, ctx: StwmContext): StwmEvent[] {
  if (history === null) return [];
  const h = rec(history);
  if (h.group_id !== model.groupId || !Array.isArray(h.weeks)) return [deadLetter(STWM_WEEK_EVENT, ["the history is not a list of weeks for the model asked about"], { reference, groupId: model.groupId, history }, ctx)];
  const out: StwmEvent[] = [];
  for (const raw of h.weeks as unknown[]) {
    const w = rec(raw);
    const week = dayOf(String(w.week)) === w.week ? (w.week as string) : undefined;
    const mean = new Map(Object.entries(rec(w.mean)));
    const low = new Map(Object.entries(rec(w.min)));
    const high = new Map(Object.entries(rec(w.max)));
    const prices = STWM_CURRENCIES.filter((c) => mean.has(c) || low.has(c) || high.has(c)).map((currency) => ({
      currency,
      low: low.get(currency),
      high: high.get(currency),
      mean: mean.get(currency),
    }));
    const problems: string[] = [];
    if (week === undefined) problems.push("a week has no date");
    if (!whole(w.count)) problems.push("a week has no whole count");
    if (prices.some((x) => !whole(x.low) || !whole(x.high) || !whole(x.mean))) problems.push("a week has a price that isn't a whole number");
    if (problems.length > 0) {
      out.push(deadLetter(STWM_WEEK_EVENT, problems, { reference, groupId: model.groupId, week: raw }, ctx));
      continue;
    }
    const payload = {
      ...modelFields(reference, model),
      week,
      listings: w.count,
      prices,
    };
    out.push(event(STWM_WEEK_EVENT, `stwm:week:${model.groupId}:${week}:${short(payload)}`, `${week}T00:00:00.000Z`, payload, ctx));
  }
  return out;
}

/** A dead letter for a reference that matches no model, so the store can correct it. */
export const stwmUnmatched = (reference: string, ctx: StwmContext): StwmEvent => deadLetter(STWM_PRICE_EVENT, [`the reference ${reference} matches no model`], { reference, day: ctx.day }, ctx);
