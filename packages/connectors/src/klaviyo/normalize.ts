import { createHash } from "node:crypto";
import type { KlaviyoReportRow, KlaviyoResource } from "./client.js";
import { klaviyoContactRefs, klaviyoProfileRef } from "./customer.js";

/**
 * Turns Klaviyo resources into Brain A events. Only the minimum is kept:
 *
 * - Profiles become clienteling `customer.profile_updated` events under keyed
 *   references (customer.ts), with email and SMS consent status and the
 *   profile's created and updated times. Email addresses, phone numbers,
 *   names, locations and custom properties are never stored; the client
 *   doesn't even ask for names, locations or properties.
 * - List and segment memberships keep the group and the profile reference.
 * - Lists, segments, campaigns and flows keep their name, state and times.
 *   Segment definitions are left out, as their conditions can hold an
 *   address or a phone number.
 * - Campaign and flow reports keep aggregate counts and revenue per message
 *   and channel for one calendar year: sends, opens, clicks, conversions.
 *
 * Every event is keyed so a replay is a duplicate: a profile by its
 * reference and update time, a membership by group and profile, a report row
 * by message, channel, year and a digest of its numbers, so a figure that
 * changes is stored again and one that doesn't is a duplicate.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface KlaviyoBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface KlaviyoContext {
  /** CUSTOMER_REF_KEY. */
  customerKey: string;
  receivedAt: string;
}

export const KLAVIYO_EVENTS = {
  profile: "customer.profile_updated",
  membership: "marketing.group_membership_seen",
  list: "marketing.list_updated",
  segment: "marketing.segment_updated",
  campaign: "marketing.campaign_updated",
  flow: "marketing.flow_updated",
  campaignSent: "campaign.sent",
  campaignMetrics: "marketing.campaign_metrics_reported",
  flowMetrics: "marketing.flow_metrics_reported",
  consent: "marketing.consent_changed",
} as const;

export type KlaviyoConsent = "subscribed" | "unsubscribed" | "never_subscribed" | "unknown";
export type KlaviyoChannel = "email" | "sms" | "push" | "whatsapp" | "other";

const ID = /^[A-Za-z0-9]{1,64}$/;
const id = (value: unknown) => (typeof value === "string" && value.length <= 64 && ID.test(value) ? value : undefined);
const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);

/** An ISO time Klaviyo wrote, in UTC. Undefined when missing or unreadable, so the pipeline dead-letters the record. */
export function klaviyoTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Klaviyo's consent strings (SUBSCRIBED, UNSUBSCRIBED, NEVER_SUBSCRIBED) as one of a few fixed values. */
export function klaviyoConsent(value: unknown): KlaviyoConsent {
  const v = typeof value === "string" ? value.slice(0, 40).toUpperCase() : "";
  return v === "SUBSCRIBED" ? "subscribed" : v === "UNSUBSCRIBED" ? "unsubscribed" : v === "NEVER_SUBSCRIBED" ? "never_subscribed" : "unknown";
}

/** A send channel as one of a few fixed values. */
export function klaviyoChannel(value: unknown): KlaviyoChannel {
  const v = typeof value === "string" ? value.slice(0, 40) : "";
  return v === "email" ? "email" : v === "sms" ? "sms" : v === "push-notification" ? "push" : v === "whatsapp" ? "whatsapp" : "other";
}

/** Optional fields are left out rather than sent as undefined. */
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): KlaviyoBrainEvent {
  return { id: `klaviyo_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `klaviyo:${key}`, payload };
}

const hashOf = (ref: string) => ref.slice(ref.lastIndexOf(":") + 1);

/**
 * A profile's clienteling event. `customerId` is the email's contact
 * reference when the profile has an address, so it is the same customer a
 * form submission names, and the profile reference otherwise.
 * `marketingConsent` is true only when Klaviyo says the profile subscribed
 * to email marketing.
 */
export function klaviyoProfileEvent(profile: KlaviyoResource, ctx: KlaviyoContext): KlaviyoBrainEvent | null {
  const profileRef = klaviyoProfileRef(ctx.customerKey, profile?.id);
  if (!profileRef) return null;
  const a = profile.attributes ?? {};
  const subs = (a.subscriptions ?? {}) as { email?: { marketing?: { consent?: unknown } }; sms?: { marketing?: { consent?: unknown } } };
  const contactRefs = klaviyoContactRefs(ctx.customerKey, { email: a.email, phone: a.phone_number });
  const [emailRef] = klaviyoContactRefs(ctx.customerKey, { email: a.email });
  const updatedAt = klaviyoTime(a.updated);
  const emailConsent = klaviyoConsent(subs.email?.marketing?.consent);
  const hash = hashOf(profileRef);
  return event(`profile:${hash}:${updatedAt ?? "unknown"}`, KLAVIYO_EVENTS.profile, updatedAt, ctx.receivedAt, defined({
    customerId: emailRef ?? profileRef,
    name: `Klaviyo profile ${hash.slice(0, 8)}`,
    marketingConsent: emailConsent === "subscribed",
    profileRef,
    contactRefs,
    emailConsent,
    smsConsent: klaviyoConsent(subs.sms?.marketing?.consent),
    createdAt: klaviyoTime(a.created),
    updatedAt,
  }));
}

/** One profile seen in a list or segment. Klaviyo's relationship endpoints return ids only, so the time is when the sync saw it. */
export function klaviyoMembershipEvent(kind: "list" | "segment", groupId: string, member: KlaviyoResource, ctx: KlaviyoContext): KlaviyoBrainEvent | null {
  const group = id(groupId);
  const profileRef = member?.type === "profile" ? klaviyoProfileRef(ctx.customerKey, member.id) : undefined;
  if (!group || !profileRef) return null;
  return event(`${kind}_member:${group}:${hashOf(profileRef)}`, KLAVIYO_EVENTS.membership, ctx.receivedAt, ctx.receivedAt, {
    groupId: `klaviyo:${kind}:${group}`,
    groupKind: kind,
    profileRef,
  });
}

/** A list or segment's name, state and times. */
export function klaviyoGroupEvent(kind: "list" | "segment", resource: KlaviyoResource, ctx: KlaviyoContext): KlaviyoBrainEvent | null {
  const group = id(resource?.id);
  if (!group) return null;
  const a = resource.attributes ?? {};
  const updatedAt = klaviyoTime(a.updated);
  const optIn = a.opt_in_process === "double_opt_in" ? "double" : a.opt_in_process === "single_opt_in" ? "single" : undefined;
  return event(`${kind}:${group}:${updatedAt ?? "unknown"}`, kind === "list" ? KLAVIYO_EVENTS.list : KLAVIYO_EVENTS.segment, updatedAt, ctx.receivedAt, defined({
    [kind === "list" ? "listId" : "segmentId"]: `klaviyo:${kind}:${group}`,
    name: text(a.name) ?? `Klaviyo ${kind} ${group}`,
    optIn: kind === "list" ? optIn : undefined,
    active: kind === "segment" && typeof a.is_active === "boolean" ? a.is_active : undefined,
    createdAt: klaviyoTime(a.created),
    updatedAt,
  }));
}

/** A campaign's name, archived flag and times. Klaviyo's omnichannel campaigns (revision 2026-10-15) keep them under `definition`. */
export function klaviyoCampaignEvent(resource: KlaviyoResource, ctx: KlaviyoContext): KlaviyoBrainEvent | null {
  const campaign = id(resource?.id);
  if (!campaign) return null;
  const a = resource.attributes ?? {};
  const definition = (a.definition ?? {}) as { name?: unknown; archived?: unknown };
  const updatedAt = klaviyoTime(a.updated_at);
  return event(`campaign:${campaign}:${updatedAt ?? "unknown"}`, KLAVIYO_EVENTS.campaign, updatedAt, ctx.receivedAt, defined({
    campaignId: `klaviyo:campaign:${campaign}`,
    name: text(definition.name) ?? `Klaviyo campaign ${campaign}`,
    archived: definition.archived === true,
    createdAt: klaviyoTime(a.created_at),
    updatedAt,
  }));
}

/** A flow's name, status, trigger and times. */
export function klaviyoFlowEvent(resource: KlaviyoResource, ctx: KlaviyoContext): KlaviyoBrainEvent | null {
  const flow = id(resource?.id);
  if (!flow) return null;
  const a = resource.attributes ?? {};
  const updatedAt = klaviyoTime(a.updated);
  return event(`flow:${flow}:${updatedAt ?? "unknown"}`, KLAVIYO_EVENTS.flow, updatedAt, ctx.receivedAt, defined({
    flowId: `klaviyo:flow:${flow}`,
    name: text(a.name) ?? `Klaviyo flow ${flow}`,
    status: text(a.status, 20),
    archived: a.archived === true,
    triggerType: text(a.trigger_type, 40),
    createdAt: klaviyoTime(a.created),
    updatedAt,
  }));
}

/** A count: a whole number of zero or more. Anything else is left out. */
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);
/** Conversion value in the account's currency, as whole cents. */
const cents = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : undefined);

function statistics(s: Record<string, unknown>) {
  return defined({
    recipients: count(s.recipients),
    delivered: count(s.delivered),
    bounced: count(s.bounced),
    opens: count(s.opens),
    uniqueOpens: count(s.opens_unique),
    clicks: count(s.clicks),
    uniqueClicks: count(s.clicks_unique),
    conversions: count(s.conversions),
    uniqueConversions: count(s.conversion_uniques),
    revenueCents: cents(s.conversion_value),
    unsubscribes: count(s.unsubscribes),
  });
}

/** A report's time span: the calendar year it covers, and the times it actually ran from and to. */
export interface KlaviyoReportWindow {
  year: number;
  start: string;
  end: string;
}

/**
 * Events for one campaign or flow report row: the aggregate figures for one
 * message on one channel over one year, plus, for a campaign message that
 * reached anyone, the marketing department's `campaign.sent` (Klaviyo has
 * no send cost, so costCents is 0, and the department's return reasoner
 * leaves it alone until a cost is known).
 */
export function klaviyoReportEvents(kind: "campaign" | "flow", row: KlaviyoReportRow, window: KlaviyoReportWindow, ctx: KlaviyoContext): KlaviyoBrainEvent[] {
  const g = row?.groupings ?? {};
  const parent = id(kind === "campaign" ? g.campaign_id : g.flow_id);
  const message = id(kind === "campaign" ? g.campaign_message_id : g.flow_message_id);
  if (!parent || !message) return [];
  const channel = klaviyoChannel(g.send_channel);
  const figures = statistics((row.statistics ?? {}) as Record<string, unknown>);
  const digest = createHash("sha256").update(JSON.stringify(figures)).digest("hex").slice(0, 16);
  const parentRef = `klaviyo:${kind}:${parent}`;
  const metrics = event(`${kind}_values:${parent}:${message}:${channel}:${window.year}:${digest}`, kind === "campaign" ? KLAVIYO_EVENTS.campaignMetrics : KLAVIYO_EVENTS.flowMetrics, window.end, ctx.receivedAt, {
    [kind === "campaign" ? "campaignId" : "flowId"]: parentRef,
    messageId: `klaviyo:${kind}_message:${message}`,
    channel,
    year: window.year,
    from: window.start,
    through: window.end,
    ...figures,
  });
  if (kind !== "campaign" || !(typeof figures.recipients === "number" && figures.recipients > 0)) return [metrics];
  const sent = event(`campaign_sent:${parent}:${message}:${channel}`, KLAVIYO_EVENTS.campaignSent, window.end, ctx.receivedAt, {
    campaignId: parentRef,
    name: text(g.campaign_message_name) ?? `Klaviyo campaign ${parent}`,
    channel: channel === "email" || channel === "sms" ? channel : "other",
    costCents: 0,
  });
  return [metrics, sent];
}
