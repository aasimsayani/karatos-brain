import { createHash } from "node:crypto";
import { formCustomerRefs } from "../custom_forms/customer.js";

/**
 * Turns Mailchimp records into Brain A events, in the same types Klaviyo's
 * use, so marketing and clienteling read either the same way:
 *
 * - Audiences become `marketing.list_updated` with their name, opt-in and
 *   counts.
 * - Members become clienteling `customer.profile_updated` events, named by
 *   the keyed reference custom forms makes for the same email address, so a
 *   subscriber lines up with a person who filled in a form, booked on
 *   Calendly or is on Klaviyo. Mailchimp's own member id is the MD5 of the
 *   email address, which anyone can recompute from a guessed address, so it
 *   is never kept; nor is the address itself.
 * - Each member also gives a `marketing.group_membership_seen` for its
 *   audience.
 * - Sent campaigns become `marketing.campaign_updated`, their report
 *   `marketing.campaign_metrics_reported`, and, once emails went out,
 *   marketing's `campaign.sent` (Mailchimp has no send cost, so 0).
 *
 * Every event is keyed so a replay is a duplicate: members by audience,
 * reference and last change, reports by a digest of their numbers.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface MailchimpBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface MailchimpContext {
  /** CUSTOMER_REF_KEY. */
  customerKey: string;
  receivedAt: string;
}

export const MAILCHIMP_EVENTS = {
  list: "marketing.list_updated",
  profile: "customer.profile_updated",
  membership: "marketing.group_membership_seen",
  campaign: "marketing.campaign_updated",
  campaignMetrics: "marketing.campaign_metrics_reported",
  campaignSent: "campaign.sent",
} as const;

export type MailchimpStatus = "subscribed" | "unsubscribed" | "cleaned" | "pending" | "transactional" | "archived" | "unknown";

const ID = /^[A-Za-z0-9]{1,32}$/;
const id = (value: unknown) => (typeof value === "string" && ID.test(value) ? value : undefined);
const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const obj = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);
const cents = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : undefined);

/** An ISO time Mailchimp wrote, in UTC. Undefined when missing or unreadable, so the pipeline dead-letters the record. */
export function mailchimpTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A member's status as one of a few fixed values. */
export function mailchimpStatus(value: unknown): MailchimpStatus {
  const statuses: MailchimpStatus[] = ["subscribed", "unsubscribed", "cleaned", "pending", "transactional", "archived"];
  return statuses.find((s) => s === value) ?? "unknown";
}

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): MailchimpBrainEvent {
  return { id: `mailchimp_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `mailchimp:${key}`, payload };
}

/** An audience's name, opt-in and counts. Mailchimp stamps no update time on an audience, so the counts' digest keys each version. */
export function mailchimpListEvent(list: unknown, ctx: MailchimpContext): MailchimpBrainEvent | null {
  const l = obj(list);
  const listId = id(l.id);
  if (!listId) return null;
  const stats = obj(l.stats);
  const payload = defined({
    listId: `mailchimp:list:${listId}`,
    name: text(l.name) ?? `Mailchimp audience ${listId}`,
    optIn: l.double_optin === true ? "double" : l.double_optin === false ? "single" : undefined,
    memberCount: count(stats.member_count),
    unsubscribeCount: count(stats.unsubscribe_count),
    cleanedCount: count(stats.cleaned_count),
    createdAt: mailchimpTime(l.date_created),
  });
  return event(`list:${listId}:${digest(payload)}`, MAILCHIMP_EVENTS.list, ctx.receivedAt, ctx.receivedAt, payload);
}

/**
 * A member's clienteling profile and audience membership. A member with no
 * usable email address gives nothing, as there is nothing to link it by.
 * `marketingConsent` is true only for a subscribed member.
 */
export function mailchimpMemberEvents(member: unknown, listId: string, ctx: MailchimpContext): MailchimpBrainEvent[] {
  const m = obj(member);
  const list = id(listId);
  const [customerId] = formCustomerRefs(ctx.customerKey, { email: m.email_address });
  if (!list || !customerId) return [];
  const hash = customerId.slice(customerId.lastIndexOf(":") + 1);
  const status = mailchimpStatus(m.status);
  const updatedAt = mailchimpTime(m.last_changed);
  const rating = typeof m.member_rating === "number" && Number.isInteger(m.member_rating) && m.member_rating >= 0 && m.member_rating <= 5 ? m.member_rating : undefined;
  const groupId = `mailchimp:list:${list}`;
  const profile = event(`member:${list}:${hash}:${updatedAt ?? "unknown"}`, MAILCHIMP_EVENTS.profile, updatedAt, ctx.receivedAt, defined({
    customerId,
    name: `Mailchimp contact ${hash.slice(0, 8)}`,
    marketingConsent: status === "subscribed",
    contactRefs: [customerId],
    emailStatus: status,
    listId: groupId,
    memberRating: rating,
    optedInAt: mailchimpTime(m.timestamp_opt),
    updatedAt,
  }));
  const membership = event(`list_member:${list}:${hash}`, MAILCHIMP_EVENTS.membership, ctx.receivedAt, ctx.receivedAt, { groupId, groupKind: "list", profileRef: customerId });
  return [profile, membership];
}

/** A sent campaign's internal title, type, audience and send time. Subject lines and content are left out. */
export function mailchimpCampaignEvent(campaign: unknown, ctx: MailchimpContext): MailchimpBrainEvent | null {
  const c = obj(campaign);
  const campaignId = id(c.id);
  if (!campaignId) return null;
  const sentAt = mailchimpTime(c.send_time);
  const listId = id(obj(c.recipients).list_id);
  return event(`campaign:${campaignId}:${sentAt ?? "unknown"}`, MAILCHIMP_EVENTS.campaign, sentAt, ctx.receivedAt, defined({
    campaignId: `mailchimp:campaign:${campaignId}`,
    name: text(obj(c.settings).title) ?? `Mailchimp campaign ${campaignId}`,
    kind: text(c.type, 20),
    status: text(c.status, 20),
    listId: listId && `mailchimp:list:${listId}`,
    createdAt: mailchimpTime(c.create_time),
    sentAt,
  }));
}

/**
 * A campaign report's aggregate figures, keyed by a digest of them so a
 * report that grows as opens come in is stored again and one that doesn't
 * is a duplicate. A report that reached anyone also gives `campaign.sent`.
 */
export function mailchimpReportEvents(report: unknown, ctx: MailchimpContext): MailchimpBrainEvent[] {
  const r = obj(report);
  const campaignId = id(r.id);
  if (!campaignId) return [];
  const sentAt = mailchimpTime(r.send_time);
  const bounces = obj(r.bounces);
  const opens = obj(r.opens);
  const clicks = obj(r.clicks);
  const ecommerce = obj(r.ecommerce);
  const hard = count(bounces.hard_bounce);
  const soft = count(bounces.soft_bounce);
  const recipients = count(r.emails_sent);
  const figures = defined({
    recipients,
    bounced: hard === undefined && soft === undefined ? undefined : (hard ?? 0) + (soft ?? 0),
    opens: count(opens.opens_total),
    uniqueOpens: count(opens.unique_opens),
    clicks: count(clicks.clicks_total),
    uniqueClicks: count(clicks.unique_subscriber_clicks),
    conversions: count(ecommerce.total_orders),
    revenueCents: cents(ecommerce.total_revenue),
    currency: typeof ecommerce.currency_code === "string" && /^[A-Z]{3}$/.test(ecommerce.currency_code) ? ecommerce.currency_code : undefined,
    unsubscribes: count(r.unsubscribed),
    abuseReports: count(r.abuse_reports),
  });
  const ref = `mailchimp:campaign:${campaignId}`;
  const metrics = event(`campaign_values:${campaignId}:${digest(figures)}`, MAILCHIMP_EVENTS.campaignMetrics, sentAt, ctx.receivedAt, {
    campaignId: ref,
    channel: "email",
    ...(sentAt ? { from: sentAt } : {}),
    through: ctx.receivedAt,
    ...figures,
  });
  if (!(typeof recipients === "number" && recipients > 0)) return [metrics];
  const sent = event(`campaign_sent:${campaignId}`, MAILCHIMP_EVENTS.campaignSent, sentAt, ctx.receivedAt, {
    campaignId: ref,
    name: text(r.campaign_title) ?? `Mailchimp campaign ${campaignId}`,
    channel: "email",
    costCents: 0,
  });
  return [metrics, sent];
}
