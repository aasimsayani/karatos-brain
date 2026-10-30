import { createHash } from "node:crypto";
import { GA4_REPORTS, type Ga4Report } from "./client.js";

/**
 * Turns GA4 report rows into Brain A events, one per row:
 *
 * - Traffic rows (day, channel group, source / medium) become
 *   `analytics.traffic_reported` with sessions, users, new users, engaged
 *   sessions, key events (GA4's conversions), purchases and revenue.
 * - Product rows (day, item) become `analytics.product_views_reported` with
 *   views, adds to cart, purchases and item revenue.
 *
 * GA4 keeps revising the last few days as late hits arrive, so each row is
 * keyed by its day, its dimensions and a digest of its numbers: a revised
 * row is stored as a new version, an unchanged one is a duplicate.
 *
 * Days are in the property's time zone, which each event carries. Money is
 * in cents of the property's currency.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface Ga4BrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface Ga4Context {
  propertyId: string;
  receivedAt: string;
}

export const GA4_EVENTS = {
  traffic: "analytics.traffic_reported",
  products: "analytics.product_views_reported",
} as const;

/** One report row with its values by header name. */
export interface Ga4Row {
  dimensions: Record<string, string>;
  metrics: Record<string, string>;
}

/** What a page of a report gave: its rows, the total row count and the property's currency and time zone. */
export interface Ga4Page {
  rows: Ga4Row[];
  rowCount: number;
  currency: string | undefined;
  timeZone: string | undefined;
  /** GA4 withheld some rows to keep small groups of visitors from being picked out. */
  thresholded: boolean;
}

export class Ga4ShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Ga4ShapeError";
  }
}

const obj = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/** GA4's YYYYMMDD day as YYYY-MM-DD. Undefined when it isn't a real day, so the pipeline dead-letters the row. */
export function ga4Day(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) return undefined;
  const day = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day ? day : undefined;
}

/** A count GA4 wrote as a string of digits. Undefined for anything else. */
export function ga4Count(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return undefined;
  return Number(value);
}

/**
 * A money amount GA4 wrote as a decimal string, in cents, read digit by
 * digit so 0.1 + 0.2 sums don't creep in. Rounds half away from zero.
 * Revenue can be negative after refunds. Undefined for anything else,
 * exponents included.
 */
export function ga4Cents(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(-?)(\d{1,13})(?:\.(\d{1,20}))?$/.exec(value);
  if (!m) return undefined;
  const fraction = (m[3] ?? "").padEnd(3, "0");
  let cents = Number(m[2]) * 100 + Number(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) cents += 1;
  return m[1] && cents !== 0 ? -cents : cents;
}

/** A source, medium or item name, cut short; dropped if it holds an @, as a tag may have carried an email address. */
export function ga4Label(value: unknown, max = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (!t || t.includes("@")) return undefined;
  return t.slice(0, max);
}

/**
 * Reads one page of a report, checking GA4 answered with the dimensions
 * and metrics asked for in order. A different shape throws: the numbers
 * would be read under the wrong names otherwise.
 */
export function ga4Page(report: Ga4Report, body: unknown): Ga4Page {
  const b = obj(body);
  const { dimensions, metrics } = GA4_REPORTS[report];
  const dimNames = list(b.dimensionHeaders).map((h) => obj(h).name);
  const metricNames = list(b.metricHeaders).map((h) => obj(h).name);
  const rawRows = list(b.rows);
  // An empty report may come back with no headers at all.
  if (rawRows.length || dimNames.length || metricNames.length) {
    if (JSON.stringify(dimNames) !== JSON.stringify(dimensions) || JSON.stringify(metricNames) !== JSON.stringify(metrics)) {
      throw new Ga4ShapeError(`Google Analytics answered the ${report} report with different columns than asked for`);
    }
  }
  const rows = rawRows.map((raw) => {
    const r = obj(raw);
    const dv = list(r.dimensionValues);
    const mv = list(r.metricValues);
    return {
      dimensions: Object.fromEntries(dimensions.map((name, i) => [name, typeof obj(dv[i]).value === "string" ? (obj(dv[i]).value as string) : ""])),
      metrics: Object.fromEntries(metrics.map((name, i) => [name, typeof obj(mv[i]).value === "string" ? (obj(mv[i]).value as string) : ""])),
    };
  });
  const meta = obj(b.metadata);
  const rowCount = typeof b.rowCount === "number" && Number.isInteger(b.rowCount) && b.rowCount >= 0 ? b.rowCount : rows.length;
  return {
    rows,
    rowCount,
    currency: typeof meta.currencyCode === "string" && /^[A-Z]{3}$/.test(meta.currencyCode) ? meta.currencyCode : undefined,
    timeZone: typeof meta.timeZone === "string" && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(meta.timeZone) ? meta.timeZone : undefined,
    thresholded: meta.subjectToThresholding === true,
  };
}

function event(key: string, type: string, day: string | undefined, ctx: Ga4Context, payload: Record<string, unknown>): Ga4BrainEvent {
  return {
    id: `ga4_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`,
    type,
    occurredAt: day && `${day}T00:00:00.000Z`,
    receivedAt: ctx.receivedAt,
    idempotencyKey: `ga4:${key}`,
    payload,
  };
}

/** Splits GA4's "source / medium". */
function sourceMedium(value: string): { source?: string; medium?: string } {
  const at = value.lastIndexOf(" / ");
  return at < 0 ? defined({ source: ga4Label(value) }) : defined({ source: ga4Label(value.slice(0, at)), medium: ga4Label(value.slice(at + 3)) });
}

/** One traffic row as `analytics.traffic_reported`. */
export function ga4TrafficEvent(row: Ga4Row, page: Pick<Ga4Page, "currency" | "timeZone" | "thresholded">, ctx: Ga4Context): Ga4BrainEvent {
  const raw = row.dimensions.date;
  const day = ga4Day(raw);
  const m = row.metrics;
  const channel = ga4Label(row.dimensions.sessionDefaultChannelGroup) ?? "(not set)";
  const where = sourceMedium(row.dimensions.sessionSourceMedium ?? "");
  const payload = defined({
    propertyId: `ga4:property:${ctx.propertyId}`,
    day,
    channel,
    ...where,
    sessions: ga4Count(m.sessions),
    users: ga4Count(m.totalUsers),
    newUsers: ga4Count(m.newUsers),
    engagedSessions: ga4Count(m.engagedSessions),
    keyEvents: ga4Count(m.keyEvents),
    purchases: ga4Count(m.ecommercePurchases),
    revenueCents: ga4Cents(m.totalRevenue),
    currency: page.currency,
    timeZone: page.timeZone,
    thresholded: page.thresholded || undefined,
  });
  const group = digest([channel, where.source ?? "", where.medium ?? ""]).slice(0, 12);
  return event(`traffic:${ctx.propertyId}:${day ?? "unknown"}:${group}:${digest(payload)}`, GA4_EVENTS.traffic, day, ctx, payload);
}

/** One product row as `analytics.product_views_reported`. */
export function ga4ProductEvent(row: Ga4Row, page: Pick<Ga4Page, "currency" | "timeZone" | "thresholded">, ctx: Ga4Context): Ga4BrainEvent {
  const day = ga4Day(row.dimensions.date);
  const m = row.metrics;
  const itemId = ga4Label(row.dimensions.itemId, 100) ?? "(not set)";
  const payload = defined({
    propertyId: `ga4:property:${ctx.propertyId}`,
    day,
    itemId,
    itemName: ga4Label(row.dimensions.itemName, 200),
    views: ga4Count(m.itemsViewed),
    addedToCart: ga4Count(m.itemsAddedToCart),
    purchased: ga4Count(m.itemsPurchased),
    revenueCents: ga4Cents(m.itemRevenue),
    currency: page.currency,
    timeZone: page.timeZone,
    thresholded: page.thresholded || undefined,
  });
  return event(`product:${ctx.propertyId}:${day ?? "unknown"}:${digest(itemId).slice(0, 12)}:${digest(payload)}`, GA4_EVENTS.products, day, ctx, payload);
}

/** Every row of a page as events. */
export function ga4PageEvents(report: Ga4Report, page: Ga4Page, ctx: Ga4Context): Ga4BrainEvent[] {
  return page.rows.map((row) => (report === "traffic" ? ga4TrafficEvent(row, page, ctx) : ga4ProductEvent(row, page, ctx)));
}
