import { createHash } from "node:crypto";

/**
 * Turns Google Ads report rows into Brain A events, one per campaign and
 * day: `ads.campaign_reported` with the campaign's status, channel and daily
 * budget, and the day's impressions, clicks, cost, conversions and
 * conversion value.
 *
 * Google keeps attributing conversions to a click for weeks after it, so the
 * last days are read again on each sync. Each row is keyed by its day, its
 * campaign and a digest of its numbers: a revised row is stored as a new
 * version, an unchanged one is a duplicate.
 *
 * Days are in the account's time zone, which each event carries. Money is in
 * cents of the account's currency; Google gives cost and budget in micros
 * (millionths) and conversion value as a decimal.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface GoogleAdsBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface GoogleAdsContext {
  customerId: string;
  receivedAt: string;
}

export const GOOGLE_ADS_EVENTS = {
  campaign: "ads.campaign_reported",
} as const;

/** One row of the report, as Google nests it: customer, campaign, campaignBudget, segments and metrics. */
export type GoogleAdsRow = Record<string, Record<string, unknown>>;

export interface GoogleAdsPage {
  rows: GoogleAdsRow[];
  /** Present when there is another page of the same query. */
  nextPageToken: string | undefined;
}

export class GoogleAdsShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAdsShapeError";
  }
}

const obj = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const ENUM = /^[A-Z][A-Z_]{0,39}$/;

/** A YYYY-MM-DD day. Undefined when it isn't a real day, so the pipeline dead-letters the row. */
export function googleAdsDay(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : undefined;
}

/** A count Google wrote as an int64, a string of digits. Undefined for anything else. */
export function googleAdsCount(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return undefined;
  return Number(value);
}

/** Micros (millionths of the currency) as cents, rounding half up. Undefined for anything but digits. */
export function googleAdsMicrosToCents(value: unknown): number | undefined {
  const micros = googleAdsCount(value);
  return micros === undefined ? undefined : Math.round(micros / 10_000);
}

/** A non-negative decimal amount Google wrote as a JSON number, in cents. Undefined for anything else. */
export function googleAdsAmountCents(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e13) return undefined;
  return Math.round(value * 100);
}

/** Conversions, which can be fractional under data-driven attribution, to two places. */
export function googleAdsConversions(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e13) return undefined;
  return Math.round(value * 100) / 100;
}

/** A campaign name, cut short; dropped if it holds an @. */
export function googleAdsLabel(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (!t || t.includes("@")) return undefined;
  return t.slice(0, max);
}

/** One page of the report. A body that isn't one throws, so a sync never skips rows unseen. */
export function googleAdsPage(body: unknown): GoogleAdsPage {
  const b = obj(body);
  if (b.results !== undefined && !Array.isArray(b.results)) throw new GoogleAdsShapeError("Google Ads answered with results that aren't a list");
  const rows = ((b.results as unknown[] | undefined) ?? []).map((raw) => {
    const r = obj(raw);
    return { customer: obj(r.customer), campaign: obj(r.campaign), campaignBudget: obj(r.campaignBudget), segments: obj(r.segments), metrics: obj(r.metrics) };
  });
  const token = b.nextPageToken;
  return { rows, nextPageToken: typeof token === "string" && token ? token : undefined };
}

/** One row as `ads.campaign_reported`. */
export function googleAdsCampaignEvent(row: GoogleAdsRow, ctx: GoogleAdsContext): GoogleAdsBrainEvent {
  const customer = obj(row.customer);
  const campaign = obj(row.campaign);
  const metrics = obj(row.metrics);
  const day = googleAdsDay(obj(row.segments).date);
  const campaignId = googleAdsCount(campaign.id) === undefined ? "unknown" : String(campaign.id);
  const enumOf = (value: unknown) => (typeof value === "string" && ENUM.test(value) ? value : undefined);
  const payload = defined({
    customerId: `google_ads:customer:${ctx.customerId}`,
    day,
    campaignId: `google_ads:campaign:${campaignId}`,
    campaignName: googleAdsLabel(campaign.name),
    status: enumOf(campaign.status),
    channel: enumOf(campaign.advertisingChannelType),
    dailyBudgetCents: googleAdsMicrosToCents(obj(row.campaignBudget).amountMicros),
    impressions: googleAdsCount(metrics.impressions),
    clicks: googleAdsCount(metrics.clicks),
    costCents: googleAdsMicrosToCents(metrics.costMicros),
    conversions: googleAdsConversions(metrics.conversions),
    conversionValueCents: googleAdsAmountCents(metrics.conversionsValue),
    currency: typeof customer.currencyCode === "string" && /^[A-Z]{3}$/.test(customer.currencyCode) ? customer.currencyCode : undefined,
    timeZone: typeof customer.timeZone === "string" && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(customer.timeZone) ? customer.timeZone : undefined,
  });
  const key = `campaign:${ctx.customerId}:${day ?? "unknown"}:${campaignId}:${digest(payload)}`;
  return {
    id: `gads_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`,
    type: GOOGLE_ADS_EVENTS.campaign,
    occurredAt: day && `${day}T00:00:00.000Z`,
    receivedAt: ctx.receivedAt,
    idempotencyKey: `gads:${key}`,
    payload,
  };
}

/** Every row of a page as events. */
export function googleAdsPageEvents(page: GoogleAdsPage, ctx: GoogleAdsContext): GoogleAdsBrainEvent[] {
  return page.rows.map((row) => googleAdsCampaignEvent(row, ctx));
}
