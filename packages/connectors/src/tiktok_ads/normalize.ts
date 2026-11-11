import { createHash } from "node:crypto";

/**
 * Turns TikTok Ads report rows into Brain A events, one per campaign and
 * day: `ads.campaign_reported`, the same event Google Ads and Meta Ads give,
 * with the campaign's objective and the day's spend, impressions, reach,
 * clicks, purchases and purchase value.
 *
 * TikTok keeps attributing purchases to an ad for days after it is seen, so
 * the last weeks are read again on each sync. Each row is keyed by its day,
 * its campaign and a digest of its numbers: a revised row is stored as a
 * new version, an unchanged one is a duplicate.
 *
 * Days are in the advertiser's time zone. Money is in cents of the
 * advertiser's currency. A row without a campaign ID or a day that reads is
 * dead-lettered listing what was wrong.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface TikTokAdsEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface TikTokAdsContext {
  advertiserId: string;
  receivedAt: string;
}

export const TIKTOK_ADS_EVENTS = { campaign: "ads.campaign_reported" } as const;

// Anything but an object reads as a record without the fields asked for.
const obj = (v: unknown) => (v ?? {}) as Record<string, unknown>;
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/** A day as TikTok writes it in a report ("2026-10-01 00:00:00"), as YYYY-MM-DD, or undefined when it isn't a real day. */
export function tiktokAdsDay(value: unknown): string | undefined {
  const m = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})(?: 00:00:00)?$/.exec(value) : null;
  if (!m) return undefined;
  return new Date(Date.parse(`${m[1]}T00:00:00Z`)).toISOString().slice(0, 10) === m[1] ? m[1] : undefined;
}

/** A count TikTok wrote as digits, in a string or a number. Undefined for anything else. */
export function tiktokAdsCount(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  return typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : undefined;
}

/**
 * A non-negative amount in cents. TikTok writes money as a decimal string,
 * read digit by digit and rounded half up, and sometimes as a JSON number.
 * Undefined for anything else.
 */
export function tiktokAdsCents(value: unknown): number | undefined {
  if (typeof value === "number") return value >= 0 && value <= 1e13 ? Math.round(value * 100) : undefined;
  const m = typeof value === "string" ? /^(\d{1,13})(?:\.(\d{1,20}))?$/.exec(value) : null;
  if (!m) return undefined;
  const fraction = (m[2] ?? "").padEnd(2, "0");
  return Number(m[1]) * 100 + Number(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1 : 0);
}

/** A campaign name, cut short; dropped if it holds an @. */
export function tiktokAdsLabel(value: unknown): string | undefined {
  const t = typeof value === "string" ? value.trim() : "";
  return t && !t.includes("@") ? t.slice(0, 200) : undefined;
}

/** One report row as `ads.campaign_reported`. */
export function tiktokAdsCampaignEvent(raw: unknown, ctx: TikTokAdsContext): TikTokAdsEvent {
  const dims = obj(obj(raw).dimensions);
  const m = obj(obj(raw).metrics);
  const day = tiktokAdsDay(dims.stat_time_day);
  // TikTok IDs run to 19 digits, past what a count may hold, so they stay text.
  const campaignId = typeof dims.campaign_id === "string" && /^\d{1,25}$/.test(dims.campaign_id) ? dims.campaign_id : undefined;
  const problems = [...(campaignId ? [] : ["row has no campaign ID that reads"]), ...(day ? [] : ["row has no day that reads"])];
  const account = `tiktok_ads:account:${ctx.advertiserId}`;
  const payload = problems.length
    ? { accountId: account, problems }
    : defined({
        accountId: account,
        day,
        campaignId: `tiktok_ads:campaign:${campaignId}`,
        campaignName: tiktokAdsLabel(m.campaign_name),
        objective: typeof m.objective_type === "string" && /^[A-Z][A-Z_]{0,39}$/.test(m.objective_type) ? m.objective_type : undefined,
        impressions: tiktokAdsCount(m.impressions),
        reach: tiktokAdsCount(m.reach),
        clicks: tiktokAdsCount(m.clicks),
        costCents: tiktokAdsCents(m.spend),
        conversions: tiktokAdsCount(m.complete_payment),
        conversionValueCents: tiktokAdsCents(m.total_complete_payment_rate),
      });
  const key = problems.length ? `tiktok_ads:unreadable_campaign:${ctx.advertiserId}:${digest(raw)}` : `tiktok_ads:campaign:${ctx.advertiserId}:${day}:${campaignId}:${digest(payload)}`;
  return { id: key.replace(/:/g, "_"), type: TIKTOK_ADS_EVENTS.campaign, occurredAt: day && `${day}T00:00:00.000Z`, receivedAt: ctx.receivedAt, idempotencyKey: key, payload };
}
