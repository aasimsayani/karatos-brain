import { createHash } from "node:crypto";
import { quoTime } from "../openphone/normalize.js";
import { yextMasked } from "../yext/normalize.js";
import { gbpDayMs, type GbpMetric } from "./client.js";

/**
 * Turns Google Business Profile answers into Brain A events, in the shapes
 * the Yext, Trustpilot and Google Analytics connectors give, so marketing
 * and clienteling read a store's Google listing the same way:
 *
 * - `location.updated` for each location: its name and store code, never
 *   its address, phone or hours (they aren't asked for);
 * - `review.updated` for each review: the rating, an excerpt with email
 *   addresses and phone numbers masked, whether and when the store
 *   replied, and when it was written and edited. The reviewer's name and
 *   photo are never kept, nor the reply's text. A review of two stars or
 *   fewer is marked for follow-up, and one without a reply as waiting on
 *   one;
 * - `analytics.local_listing_reported` for each location and day: how often
 *   it was seen on Maps and Search, on desktop and mobile, and how many
 *   asked for directions, called, visited the website, messaged or booked.
 *   Google leaves a zero out, so a metric it doesn't give is zero.
 *
 * Each event is keyed by what it is about and a digest of what was kept, so
 * reading it again is a duplicate and a change is a new event. A row that
 * doesn't read is dead-lettered listing what was wrong.
 */

export interface GbpEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const GBP_EVENTS = {
  location: "location.updated",
  review: "review.updated",
  metrics: "analytics.local_listing_reported",
} as const;
/** A review rated this or lower is marked for follow-up. */
export const GBP_FOLLOW_UP_RATING = 2;
const SYSTEM = "Google Business Profile";
const RATINGS = new Map([
  ["ONE", 1],
  ["TWO", 2],
  ["THREE", 3],
  ["FOUR", 4],
  ["FIVE", 5],
]);
/** Each metric as the payload field it fills. */
const FIELDS = new Map<GbpMetric, string>([
  ["BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "desktopMapsViews"],
  ["BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "desktopSearchViews"],
  ["BUSINESS_IMPRESSIONS_MOBILE_MAPS", "mobileMapsViews"],
  ["BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "mobileSearchViews"],
  ["BUSINESS_DIRECTION_REQUESTS", "directionRequests"],
  ["CALL_CLICKS", "calls"],
  ["WEBSITE_CLICKS", "websiteClicks"],
  ["MESSAGING_CLICKS", "messages"],
  ["BUSINESS_BOOKINGS", "bookings"],
]);
const DAY_MS = 86_400_000;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify([value])).digest("hex").slice(0, 12);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const time = (v: unknown) => quoTime(v) ?? undefined;
/** Text Google keeps, trimmed, without markup, up to `max` characters. */
const text = (v: unknown, max: number) => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t !== "" && t.length <= max && !/[<>\p{Cc}]/u.test(t) ? t : undefined;
};
/** The id after a prefix in a resource name, such as 123 in locations/123. */
const idAfter = (prefix: string, v: unknown) => {
  const m = typeof v === "string" ? new RegExp(`^${prefix}/([0-9]{1,30})$`).exec(v) : null;
  return m?.[1];
};
/** A review id: Google writes them as letters, digits, - and _. */
const reviewIdOf = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v) ? v : undefined);
/** A count Google writes as an int64 string. */
const count = (v: unknown) => (typeof v === "string" && /^(0|[1-9][0-9]{0,14})$/.test(v) ? Number(v) : undefined);

export interface GbpContext {
  receivedAt: string;
}

export type GbpRead = { ok: boolean; event: GbpEvent };

function read(kind: string, type: string, raw: unknown, problems: string[], key: string, payload: Record<string, unknown>, occurredAt: string | undefined, receivedAt: string): GbpRead {
  const ok = problems.length === 0;
  const idempotencyKey = ok ? `gbp:${kind}:${key}:${short(payload)}` : `gbp:unreadable_${kind}:${short(raw)}`;
  return {
    ok,
    event: {
      id: idempotencyKey.replace(/:/g, "_"),
      type,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? occurredAt : undefined,
      receivedAt,
      idempotencyKey,
      payload: ok ? payload : { system: SYSTEM, kind, problems },
    },
  };
}

export function gbpLocationEvent(raw: unknown, ctx: GbpContext): GbpRead {
  const r = obj(raw);
  const problems: string[] = [];
  if (r !== raw) problems.push("location is not an object");
  const id = idAfter("locations", r.name);
  if (!id) problems.push("location has no name that reads");
  const payload = {
    system: SYSTEM,
    locationId: `gbp:location:${id}`,
    name: text(r.title, 200),
    storeCode: typeof r.storeCode === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(r.storeCode) ? r.storeCode : undefined,
  };
  return read("location", GBP_EVENTS.location, raw, problems, id!, payload, ctx.receivedAt, ctx.receivedAt);
}

/** The location a review's name says it belongs to, or undefined. */
export function gbpReviewLocation(raw: unknown): string | undefined {
  const name = obj(raw).name;
  const m = typeof name === "string" ? /^accounts\/[0-9]{1,30}\/locations\/([0-9]{1,30})\/reviews\/[A-Za-z0-9_-]{1,200}$/.exec(name) : null;
  return m?.[1];
}

export function gbpReviewEvent(raw: unknown, ctx: GbpContext & { locationId: string }): GbpRead {
  const r = obj(raw);
  const problems: string[] = [];
  if (r !== raw) problems.push("review is not an object");
  const id = reviewIdOf(r.reviewId);
  if (!id) problems.push("review has no id that reads");
  if (gbpReviewLocation(r) !== ctx.locationId) problems.push("review is not of the location read");
  const rating = RATINGS.get(r.starRating as string);
  if (rating === undefined) problems.push("review has no rating from one to five");
  const publishedAt = time(r.createTime);
  if (!publishedAt) problems.push("review has no time that reads");
  const reply = obj(r.reviewReply);
  const repliedAt = time(reply.updateTime);
  const state = typeof reply.reviewReplyState === "string" && /^[A-Z_]{1,40}$/.test(reply.reviewReplyState) ? reply.reviewReplyState.toLowerCase() : undefined;
  const payload = {
    system: SYSTEM,
    reviewId: `gbp:review:${id}`,
    publisher: "Google",
    kind: "listing",
    locationId: `gbp:location:${ctx.locationId}`,
    rating,
    // A review without a rating is dead-lettered, so this is only read when there is one.
    needsFollowUp: rating! <= GBP_FOLLOW_UP_RATING,
    excerpt: yextMasked(r.comment),
    anonymous: obj(r.reviewer).isAnonymous === true,
    ownerReplies: repliedAt ? 1 : 0,
    awaitingReply: !repliedAt,
    repliedAt,
    replyState: repliedAt ? state : undefined,
    publishedAt,
    editedAt: time(r.updateTime),
  };
  return read("review", GBP_EVENTS.review, raw, problems, id!, payload, publishedAt, ctx.receivedAt);
}

/** A Google Date ({year, month, day}) written as YYYY-MM-DD, or undefined. Only days of the window read are kept, so one that isn't a real day is never kept. */
function dayOf(v: unknown): string | undefined {
  const d = obj(v);
  if (![d.year, d.month, d.day].every(Number.isSafeInteger)) return undefined;
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/**
 * One event for each day from `from` to `to` of a location's metrics. An
 * answer without the series list is dead-lettered as one event for the
 * window; a value that doesn't read is left out of its day and listed.
 */
export function gbpMetricsEvents(raw: unknown, ctx: GbpContext & { locationId: string; from: string; to: string }): GbpRead[] {
  const series = obj(raw).multiDailyMetricTimeSeries;
  const window = `${ctx.locationId}:${ctx.from}:${ctx.to}`;
  if (!Array.isArray(series)) return [read("metrics", GBP_EVENTS.metrics, raw, ["metrics have no series list"], window, {}, undefined, ctx.receivedAt)];
  const days = new Map<string, Record<string, number>>();
  const unread: string[] = [];
  for (let ms = gbpDayMs(ctx.from); ms <= gbpDayMs(ctx.to); ms += DAY_MS) days.set(new Date(ms).toISOString().slice(0, 10), Object.fromEntries([...FIELDS.values()].map((f) => [f, 0])));
  for (const group of series) {
    for (const one of Array.isArray(obj(group).dailyMetricTimeSeries) ? (obj(group).dailyMetricTimeSeries as unknown[]) : []) {
      const field = FIELDS.get(obj(one).dailyMetric as GbpMetric);
      // A breakdown by sub-entity would count the same views twice.
      if (!field || obj(one).dailySubEntityType !== undefined) continue;
      const values = obj(obj(one).timeSeries).datedValues;
      for (const point of Array.isArray(values) ? values : []) {
        const p = obj(point);
        const day = dayOf(p.date);
        const value = count(p.value ?? "0");
        if (day === undefined || !days.has(day) || value === undefined) unread.push(field);
        else days.get(day)![field] = value;
      }
    }
  }
  return [...days].map(([day, metrics]) =>
    read("metrics", GBP_EVENTS.metrics, raw, [], `${ctx.locationId}:${day}`, { system: SYSTEM, locationId: `gbp:location:${ctx.locationId}`, day, ...metrics, ...(unread.length > 0 ? { unread: [...new Set(unread)] } : {}) }, `${day}T00:00:00.000Z`, ctx.receivedAt),
  );
}

