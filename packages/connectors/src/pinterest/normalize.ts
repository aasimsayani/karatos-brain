import { createHash } from "node:crypto";

/**
 * Turns Pinterest Pins and analytics into Brain A events:
 *
 * - social.pin_updated: one of the store's Pins, with its title, the page it
 *   links to and its board, and its metrics over 90 days and its lifetime;
 * - social.account_reported: the account's impressions, saves, Pin clicks,
 *   outbound clicks and engagements for one day;
 * - social.top_pin_reported: one of the account's most saved Pins over a
 *   range, with its rank, so the styles shoppers save most stand out.
 *
 * Pinterest keeps refining recent analytics, so each event is keyed by a
 * digest of its numbers: a revised day or Pin is stored as a new version, an
 * unchanged one is a duplicate.
 *
 * Nothing here names a customer. A Pin's description isn't kept, a title
 * holding an @ is dropped, and a link keeps its address without the query
 * string or fragment.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface PinterestBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface PinterestContext {
  receivedAt: string;
}

export const PINTEREST_EVENTS = {
  pin: "social.pin_updated",
  account: "social.account_reported",
  topPin: "social.top_pin_reported",
} as const;

export interface PinterestPinPage {
  pins: Record<string, unknown>[];
  /** The bookmark for the next page, present only when Pinterest says there is one. */
  bookmark: string | undefined;
}

export class PinterestShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinterestShapeError";
  }
}

const obj = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const pinId = (value: unknown) => (typeof value === "string" && /^\d{1,25}$/.test(value) ? value : undefined);
export const pinterestRef = (kind: string, id: string) => `pinterest:${kind}:${id}`;

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): PinterestBrainEvent {
  return { id: `pinterest_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `pinterest:${key}`, payload };
}

/** A YYYY-MM-DD day. Undefined when it isn't a real day, so the pipeline dead-letters the record. */
export function pinterestDay(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : undefined;
}

/** A count: a whole, non-negative JSON number. Undefined for anything else. */
export function pinterestCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** A Pin's title, cut short; dropped if it holds an @. */
export function pinterestLabel(value: unknown, max = 100): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (!t || t.includes("@")) return undefined;
  return t.slice(0, max);
}

/** The page a Pin links to, without its query string or fragment. Undefined for anything but a web address. */
export function pinterestLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return `${url.origin}${url.pathname}`.slice(0, 500);
}

/** The metrics Pinterest lists for a Pin over one period, keeping whole, non-negative counts. */
function pinMetrics(value: unknown): Record<string, number> | undefined {
  const entries = Object.entries(obj(value)).flatMap(([k, v]) => {
    const n = pinterestCount(v);
    return /^[a-z_]{1,40}$/.test(k) && n !== undefined ? [[k, n] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries.slice(0, 20)) : undefined;
}

/** The figures read for the account and its top Pins, from Pinterest's metric names. */
function figures(metrics: unknown) {
  const m = obj(metrics);
  return {
    impressions: pinterestCount(m.IMPRESSION),
    saves: pinterestCount(m.SAVE),
    pinClicks: pinterestCount(m.PIN_CLICK),
    outboundClicks: pinterestCount(m.OUTBOUND_CLICK),
    engagements: pinterestCount(m.ENGAGEMENT),
  };
}

const status = (value: unknown) => (typeof value === "string" && /^[A-Z_]{1,60}$/.test(value) ? value : undefined);

/** One page of Pins. A body that isn't one throws, so a sync never skips Pins unseen. */
export function pinterestPinPage(body: unknown): PinterestPinPage {
  const b = obj(body);
  if (!Array.isArray(b.items)) throw new PinterestShapeError("Pinterest answered the Pin list without items");
  return { pins: b.items.map(obj), bookmark: typeof b.bookmark === "string" && b.bookmark ? b.bookmark : undefined };
}

/** A Pin as social.pin_updated, or null without an id. */
export function pinterestPinEvent(pin: Record<string, unknown>, ctx: PinterestContext): PinterestBrainEvent | null {
  const id = pinId(pin?.id);
  if (!id) return null;
  const createdAt = typeof pin.created_at === "string" && !Number.isNaN(Date.parse(pin.created_at)) ? new Date(Date.parse(pin.created_at)).toISOString() : undefined;
  const board = pinId(pin.board_id);
  const metrics = obj(pin.pin_metrics);
  const payload = defined({
    pinId: pinterestRef("pin", id),
    createdAt,
    title: pinterestLabel(pin.title),
    link: pinterestLink(pin.link),
    boardId: board && pinterestRef("board", board),
    isProduct: typeof pin.is_product === "boolean" ? pin.is_product : undefined,
    creativeType: status(pin.creative_type),
    metrics90Days: pinMetrics(metrics["90d"]),
    lifetimeMetrics: pinMetrics(metrics.lifetime_metrics),
  });
  // Dated when it was pinned, since Pinterest gives no change time; a changed Pin is a new version of the same date.
  return event(`pin:${id}:${digest(payload)}`, PINTEREST_EVENTS.pin, createdAt, ctx.receivedAt, payload);
}

/** The account's daily metrics as social.account_reported, one per day. A body that isn't a report throws. */
export function pinterestAccountEvents(body: unknown, ctx: PinterestContext): PinterestBrainEvent[] {
  const b = obj(body);
  // Unsplit, the report sits under "all".
  const report = obj(b.all);
  if (b.all !== undefined && !Array.isArray(report.daily_metrics)) throw new PinterestShapeError("Pinterest answered account analytics without daily metrics");
  const days = Array.isArray(report.daily_metrics) ? report.daily_metrics.map(obj) : [];
  return days.map((d) => {
    const day = pinterestDay(d.date);
    const payload = defined({ day, dataStatus: status(d.data_status), ...figures(d.metrics) });
    return event(`account:${day ?? "unknown"}:${digest(payload)}`, PINTEREST_EVENTS.account, day && `${day}T00:00:00.000Z`, ctx.receivedAt, payload);
  });
}

/** The account's most saved Pins over a range as social.top_pin_reported, ranked from 1. A body that isn't a ranking throws. */
export function pinterestTopPinEvents(body: unknown, range: { startDate: string; endDate: string }, ctx: PinterestContext): PinterestBrainEvent[] {
  const b = obj(body);
  const pins = b.pins === undefined ? [] : b.pins;
  if (!Array.isArray(pins)) throw new PinterestShapeError("Pinterest answered top Pins without a Pin list");
  return pins.map(obj).flatMap((p, i) => {
    const id = pinId(p.pin_id);
    if (!id) return [];
    const until = pinterestDay(range.endDate);
    const payload = defined({ pinId: pinterestRef("pin", id), rank: i + 1, from: pinterestDay(range.startDate), until, rankedBy: "SAVE", ...figures(p.metrics) });
    return [event(`top:${until ?? "unknown"}:${id}:${digest(payload)}`, PINTEREST_EVENTS.topPin, until && `${until}T00:00:00.000Z`, ctx.receivedAt, payload)];
  });
}
