import { createHash } from "node:crypto";

/**
 * Turns Meta Ads insights rows into Brain A events, one per campaign and
 * day: `ads.campaign_reported`, the same event Google Ads gives, with the
 * campaign's objective and the day's spend, impressions, reach, clicks,
 * purchases and purchase value.
 *
 * Meta keeps attributing purchases to an ad for days after it is seen, so
 * the last days are read again on each sync. Each row is keyed by its day,
 * its campaign and a digest of its numbers: a revised row is stored as a
 * new version, an unchanged one is a duplicate.
 *
 * Days are in the ad account's time zone. Money is in cents of the ad
 * account's currency.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface MetaAdsBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface MetaAdsContext {
  accountId: string;
  receivedAt: string;
}

export const META_ADS_EVENTS = {
  campaign: "ads.campaign_reported",
} as const;

/** The action type Meta counts every purchase under, on the website, in the app and offline. */
export const META_PURCHASE_ACTION = "purchase";

export interface MetaAdsPage {
  rows: Record<string, unknown>[];
  /** The cursor for the next page, present only when Meta says there is one. */
  after: string | undefined;
}

export class MetaAdsShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaAdsShapeError";
  }
}

const obj = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/** A YYYY-MM-DD day. Undefined when it isn't a real day, so the pipeline dead-letters the row. */
export function metaAdsDay(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : undefined;
}

/** A count Meta wrote as a string of digits. Undefined for anything else. */
export function metaAdsCount(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return undefined;
  return Number(value);
}

/**
 * A non-negative amount in cents. Meta writes money as a decimal string,
 * read digit by digit and rounded half up, and sometimes as a JSON number.
 * Undefined for anything else.
 */
export function metaAdsCents(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 1e13 ? Math.round(value * 100) : undefined;
  if (typeof value !== "string") return undefined;
  const m = /^(\d{1,13})(?:\.(\d{1,20}))?$/.exec(value);
  if (!m) return undefined;
  const fraction = (m[2] ?? "").padEnd(3, "0");
  return Number(m[1]) * 100 + Number(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1 : 0);
}

/** A campaign name, cut short; dropped if it holds an @. */
export function metaAdsLabel(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (!t || t.includes("@")) return undefined;
  return t.slice(0, max);
}

/** The value of one action type in Meta's list of actions, or undefined when it isn't listed. */
export function metaAdsAction(list: unknown, type: string): unknown {
  if (!Array.isArray(list)) return undefined;
  return list.map(obj).find((a) => a.action_type === type)?.value;
}

/** One page of insights. A body that isn't one throws, so a sync never skips rows unseen. */
export function metaAdsPage(body: unknown): MetaAdsPage {
  const b = obj(body);
  if (!Array.isArray(b.data)) throw new MetaAdsShapeError("Meta answered insights without a data list");
  const paging = obj(b.paging);
  const after = obj(paging.cursors).after;
  // Meta sends cursors on the last page too; only a next link says there is more.
  return { rows: b.data.map(obj), after: typeof paging.next === "string" && typeof after === "string" && after ? after : undefined };
}

/** One row as `ads.campaign_reported`. */
export function metaAdsCampaignEvent(row: Record<string, unknown>, ctx: MetaAdsContext): MetaAdsBrainEvent {
  const day = metaAdsDay(row.date_start);
  // Meta ids run to 18 digits and more, past what a count may hold, so they stay text.
  const campaignId = typeof row.campaign_id === "string" && /^\d{1,25}$/.test(row.campaign_id) ? row.campaign_id : "unknown";
  const purchases = metaAdsCount(metaAdsAction(row.actions, META_PURCHASE_ACTION));
  const payload = defined({
    accountId: `meta_ads:account:${ctx.accountId}`,
    day,
    campaignId: `meta_ads:campaign:${campaignId}`,
    campaignName: metaAdsLabel(row.campaign_name),
    objective: typeof row.objective === "string" && /^[A-Z][A-Z_]{0,39}$/.test(row.objective) ? row.objective : undefined,
    impressions: metaAdsCount(row.impressions),
    reach: metaAdsCount(row.reach),
    clicks: metaAdsCount(row.clicks),
    costCents: metaAdsCents(row.spend),
    // A row lists only the actions that happened, so none listed means none.
    conversions: purchases ?? 0,
    conversionValueCents: metaAdsCents(metaAdsAction(row.action_values, META_PURCHASE_ACTION)) ?? 0,
    currency: typeof row.account_currency === "string" && /^[A-Z]{3}$/.test(row.account_currency) ? row.account_currency : undefined,
  });
  const key = `campaign:${ctx.accountId}:${day ?? "unknown"}:${campaignId}:${digest(payload)}`;
  return {
    id: `meta_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`,
    type: META_ADS_EVENTS.campaign,
    occurredAt: day && `${day}T00:00:00.000Z`,
    receivedAt: ctx.receivedAt,
    idempotencyKey: `meta:${key}`,
    payload,
  };
}

/** Every row of a page as events. */
export function metaAdsPageEvents(page: MetaAdsPage, ctx: MetaAdsContext): MetaAdsBrainEvent[] {
  return page.rows.map((row) => metaAdsCampaignEvent(row, ctx));
}
