import { createHash } from "node:crypto";
import { formCustomerRefs } from "../custom_forms/customer.js";

/**
 * Turns Zendesk tickets and users into events:
 *
 * - `communication.ticket_updated` for each ticket, as Gorgias's are: its
 *   status, type, priority, channel, tags, who asked and who it is assigned
 *   to, its satisfaction rating and its times, so clienteling, sales and
 *   repairs see what customers asked and how fast the store answered.
 * - `customer.profile_updated` for each end user (a customer, not staff),
 *   carrying the customer references of their email and phone, so a
 *   ticket's requester lines up with the same person in other systems.
 *
 * Subjects, descriptions, comments, names, notes and custom fields are
 * never read into an event. An email or phone becomes the same customer
 * reference custom forms, Klaviyo, Quo and Gorgias make (an HMAC under
 * CUSTOMER_REF_KEY), so the address isn't kept. People are Zendesk's user
 * ids, which name no one outside Zendesk.
 *
 * Each event is keyed by the record and a digest of what was kept, so
 * reading it again is a duplicate and a change is a new event. One without
 * an id or a time that reads is dead-lettered listing what was wrong.
 */

export interface ZendeskEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const ZENDESK_TICKET_EVENT = "communication.ticket_updated";
export const ZENDESK_PROFILE_EVENT = "customer.profile_updated";
const SYSTEM = "Zendesk";
const MAX_TAGS = 20;
const WORD = /^[a-z][a-z0-9_-]{0,39}$/;
const TAG = /^[\p{L}\p{N}][\p{L}\p{N}_&'./-]{0,39}$/u;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const word = (v: unknown) => (typeof v === "string" && WORD.test(v) ? v : undefined);
const idOf = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : undefined);
const ref = (kind: string, v: unknown) => (idOf(v) ? `zendesk_${kind}:${v}` : undefined);

/** A time as Zendesk writes it (ISO 8601 in UTC), as UTC with milliseconds, or null when it isn't one. */
export function zendeskTime(value: unknown): string | null {
  const m = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.exec(value) : null;
  if (!m) return null;
  const t = Date.parse(m[0]);
  // Date.parse rolls an impossible day (Feb 30) into the next month, so the day must read back as itself.
  return t >= 0 && new Date(t).toISOString().slice(0, 10) === m[1] ? new Date(t).toISOString() : null;
}

export interface ZendeskContext {
  customerKey: string;
  receivedAt: string;
}

export type ZendeskRead = { ok: boolean; event: ZendeskEvent };

function read(kind: "ticket" | "user", type: string, raw: unknown, problems: string[], id: number | undefined, at: string | null, payload: Record<string, unknown>, receivedAt: string): ZendeskRead {
  const ok = problems.length === 0;
  const key = ok ? `zendesk:${kind}:${id}:${short(payload)}` : `zendesk:unreadable_${kind}:${short(raw)}`;
  return {
    ok,
    event: {
      id: key.replace(/:/g, "_"),
      type,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? at! : undefined,
      receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: SYSTEM, [`${kind}Id`]: id ?? null, problems },
    },
  };
}

/** Tags the store chose (repair, return, sizing), sorted and capped. Zendesk tags have no spaces. */
function tagsOf(v: unknown): string[] {
  const tags = (Array.isArray(v) ? v : []).filter((t): t is string => typeof t === "string" && TAG.test(t));
  return [...new Set(tags.map((t) => t.toLowerCase()))].sort().slice(0, MAX_TAGS);
}

export function zendeskTicketEvent(raw: unknown, ctx: ZendeskContext): ZendeskRead {
  const problems: string[] = [];
  const t = obj(raw);
  if (t !== raw) problems.push("ticket is not an object");
  const id = idOf(t.id);
  if (!id) problems.push("ticket has no id that reads");
  const createdAt = zendeskTime(t.created_at);
  if (!createdAt) problems.push("ticket has no creation time that reads");
  const updatedAt = zendeskTime(t.updated_at) ?? createdAt;
  const status = word(t.status);
  if (!status) problems.push("ticket has no status that reads");

  const payload: Record<string, unknown> = {
    system: SYSTEM,
    ticketId: `zendesk:ticket:${id}`,
    requester: ref("user", t.requester_id),
    submittedBy: ref("user", t.submitter_id),
    assignedTo: ref("user", t.assignee_id),
    organization: ref("organization", t.organization_id),
    group: ref("group", t.group_id),
    brand: ref("brand", t.brand_id),
    status,
    ticketType: word(t.type),
    priority: word(t.priority),
    channel: word(obj(t.via).channel),
    tags: tagsOf(t.tags),
    satisfaction: word(obj(t.satisfaction_rating).score),
    public: t.is_public !== false,
    createdAt: createdAt ?? undefined,
    dueAt: zendeskTime(t.due_at) ?? undefined,
    updatedAt: updatedAt ?? undefined,
  };
  return read("ticket", ZENDESK_TICKET_EVENT, raw, problems, id, updatedAt, payload, ctx.receivedAt);
}

/** An end user's profile, or null for staff (agents and admins), who aren't customers. */
export function zendeskUserEvent(raw: unknown, ctx: ZendeskContext): ZendeskRead | null {
  const problems: string[] = [];
  const u = obj(raw);
  if (u !== raw) problems.push("user is not an object");
  else if (u.role !== "end-user") return null;
  const id = idOf(u.id);
  if (!id) problems.push("user has no id that reads");
  const createdAt = zendeskTime(u.created_at);
  if (!createdAt) problems.push("user has no creation time that reads");
  const updatedAt = zendeskTime(u.updated_at) ?? createdAt;

  const payload: Record<string, unknown> = {
    system: SYSTEM,
    customerId: `zendesk_user:${id}`,
    name: `Zendesk customer ${id}`,
    // Zendesk doesn't record marketing consent, so none is claimed.
    marketingConsent: false,
    customerRefs: formCustomerRefs(ctx.customerKey, { email: u.email, phone: u.phone }),
    organization: ref("organization", u.organization_id),
    tags: tagsOf(u.tags),
    verified: u.verified === true,
    suspended: u.suspended === true,
    // Zendesk lists a deleted user with active false.
    deleted: u.active === false,
    createdAt: createdAt ?? undefined,
    updatedAt: updatedAt ?? undefined,
  };
  return read("user", ZENDESK_PROFILE_EVENT, raw, problems, id, updatedAt, payload, ctx.receivedAt);
}
