import type { EventEnvelope, Reasoner, Recommendation, Signal } from "@karatos/core";
import { ASSUMPTIONS, dollars, estimate, extractor, latestBySubject, measured, pct, recommend, signalFrom, value } from "../department.js";
import { businessHoursBetween, STORE_HOURS, type StoreHours } from "../store-hours.js";

/**
 * Recognizing the same customer across channels, and noticing when one is
 * waiting on a reply.
 *
 * The connectors never keep a customer's name, email address or phone
 * number. Each turns them into keyed references (HMAC-SHA256 under the
 * instance's CUSTOMER_REF_KEY), and the same detail gives the same
 * reference in every system: an email address in Klaviyo, Gmail, Gorgias
 * and a web form; a phone number in Quo, Twilio, WhatsApp, Zendesk and a
 * booking. A record that describes one person and names several of their
 * references (a Klaviyo or Shopify profile with an email address and a
 * phone number, a form, a help desk user) says those references are the
 * same person. These rules put that together from references alone:
 *
 * - `customer.identity` keeps the references one record names for one
 *   person.
 * - `customer.touch` keeps one message or call with a customer: the
 *   references of who it was with, which way it went, and whether it is a
 *   customer asking or the store answering.
 *
 * Clienteling's `clienteling.awaiting-reply` then links the references
 * into customers, follows each one's messages across every channel, and
 * raises a customer whose message has had no answer on any channel for
 * REPLY_BUSINESS_HOURS (AWAITING_REPLY_HOURS on an instance) of the
 * store's open hours, from STORE_HOURS and STORE_CLOSED_DATES. A past buyer, found through
 * the same links to their orders, is raised on their own with what they
 * have spent; everyone else waiting is raised together. See
 * docs/departments/README.md#customers-waiting-on-a-reply.
 */

/** A message unanswered on every channel for this many of the store's open hours is raised, unless AWAITING_REPLY_HOURS says otherwise. */
export const REPLY_BUSINESS_HOURS = 4;
/** Messages older than this are left alone: the conversation has moved on, or happened elsewhere. */
export const REPLY_LOOKBACK_DAYS = 14;
/** Lifetime spend at which a waiting customer is called high-value, as clienteling's lapsed-VIP rule does. */
export const REPLY_HIGH_VALUE_CENTS = 500_000;
/** At most this many references are read from one record, so a malformed one can't link a crowd. */
export const MAX_REFS_PER_RECORD = 8;

/**
 * A customer reference as the connectors write them: a lowercase prefix and
 * an id or digest, such as `form_customer:3f…`, `shopify:customer:1001` or
 * `meta_customer:9a…`. Nothing with an @, a + or a space reads as one, so a
 * raw address or number never becomes a link.
 */
const REF = /^[a-z][a-z0-9_]*(?::[a-z0-9_]+)*:[A-Za-z0-9_-]{1,64}$/;

/** Records that each describe one person, so every reference they name is that person's. */
const ONE_PERSON_EVENTS = new Set([
  "customer.profile_updated",
  "forms.submission_received",
  "loyalty.customer_updated",
  "review.updated",
  "payment.charge_updated",
  "payment.refund_updated",
  "appointment.booked",
  "appointment.canceled",
  "appointment.no_show",
]);
/** Fields a record names a customer in. */
const REF_FIELDS = ["customerId", "customerRef", "profileRef", "contactRefs", "customerRefs"] as const;
/** An outgoing message or call in one of these states never reached the customer. */
const FAILED = new Set(["failed", "undelivered", "canceled", "cancelled"]);
/** An incoming call in one of these states was a conversation. */
const ANSWERED_CALL = new Set(["completed", "answered", "in-progress"]);

const DAY_MS = 86_400_000;

/** What a `customer.touch` signal keeps. */
export type CustomerTouch = {
  /** The message or call. */
  recordId: string;
  conversationId: string | null;
  kind: "message" | "call";
  /**
   * "asked": the customer wrote in. "answered": the store wrote, called, or picked up. "neither": a send that
   * failed, an automatic reply, a missed call or a deleted message. It is kept, so a later status of the same
   * record replaces an earlier one: a text queued and then undelivered is no answer.
   */
  role: "asked" | "answered" | "neither";
  channel: string | null;
  system: string | null;
  refs: string[];
  /** True when the record is with one person, so its references are that person's (Twilio's contactRef beside customerRefs). */
  onePerson: boolean;
};

const text = (v: unknown, max = 40) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);

/** The customer references a field holds: one string or a list. Anything that doesn't read as a reference is dropped. */
function refsIn(v: unknown): string[] {
  const list = Array.isArray(v) ? v : [v];
  return list.filter((r): r is string => typeof r === "string" && r.length <= 128 && REF.test(r));
}

/** Every reference a record names, without repeats, sorted. */
export function customerRefsOf(payload: Record<string, unknown>, fields: readonly string[] = REF_FIELDS): string[] {
  return [...new Set(fields.flatMap((f) => refsIn(payload[f])))].sort();
}

function identity(event: EventEnvelope): Signal[] {
  const refs = customerRefsOf(event.payload);
  if (refs.length === 0 || refs.length > MAX_REFS_PER_RECORD) return [];
  return [signalFrom(event, "customer.identity", { kind: "customer_identity", id: refs[0]! }, { refs })];
}

function touch(event: EventEnvelope, kind: "message" | "call"): Signal[] {
  const p = event.payload;
  const recordId = text(p.messageId ?? p.callId, 200);
  if (!recordId) return [];
  const contact = refsIn(p.contactRef);
  const refs = [...new Set([...contact, ...refsIn(p.customerRefs)])].sort();
  if (refs.length === 0 || refs.length > MAX_REFS_PER_RECORD) return [];
  const way = p.direction === "inbound" || p.direction === "received" ? "in" : p.direction === "outbound" || p.direction === "sent" ? "out" : null;
  if (!way) return [];
  const status = typeof p.status === "string" ? p.status.toLowerCase() : "";
  let role: CustomerTouch["role"];
  if (way === "out") {
    // A failed send, or a help desk rule's automatic reply, isn't an answer.
    role = FAILED.has(status) || p.failed === true || p.deleted === true || p.byRule === true ? "neither" : "answered";
  } else if (kind === "call") {
    // A call the store picked up is a conversation; a missed one is left to the missed-calls rule.
    role = p.missed !== true && ANSWERED_CALL.has(status) ? "answered" : "neither";
  } else {
    role = p.deleted === true ? "neither" : "asked";
  }
  const t: CustomerTouch = {
    recordId,
    conversationId: text(p.conversationId ?? p.threadId, 200),
    kind,
    role,
    channel: text(p.channel),
    system: text(p.system),
    refs,
    // Twilio's contactRef is the one number at the far end, so the customer references beside it are the same person's.
    onePerson: contact.length === 1,
  };
  return [signalFrom(event, "customer.touch", { kind: "customer_touch", id: recordId }, { ...t })];
}

/** Keeps who each record is about, and each message and call with a customer, as references only. */
export const customerMatchExtractor = extractor("customer-match", (event) => {
  if (event.type === "communication.message_logged") return touch(event, "message");
  if (event.type === "communication.call_logged") return touch(event, "call");
  if (ONE_PERSON_EVENTS.has(event.type)) return identity(event);
  return [];
});

/** Groups references that name the same person. */
export class CustomerLinks {
  private readonly parent = new Map<string, string>();

  /** The customer a reference belongs to: the same string for every reference linked to it. */
  find(ref: string): string {
    let root = ref;
    // A customer has a handful of references, so the walk is short.
    while (this.parent.has(root)) root = this.parent.get(root)!;
    return root;
  }

  /** Says the references are one person's. */
  link(refs: readonly string[]): void {
    for (const r of refs.slice(1)) {
      const a = this.find(refs[0]!);
      const b = this.find(r);
      if (a === b) continue;
      // The smaller reference names the customer, so the result doesn't depend on the order records arrived in.
      if (a < b) this.parent.set(b, a);
      else this.parent.set(a, b);
    }
  }
}

/** The links every `customer.identity` signal, and every touch with one person, make. */
export function customerLinks(signals: readonly Signal[]): CustomerLinks {
  const links = new CustomerLinks();
  for (const s of signals) {
    if (s.kind === "customer.identity") links.link(value<{ refs: string[] }>(s).refs);
    else if (s.kind === "customer.touch" && value<CustomerTouch>(s).onePerson) links.link(value<CustomerTouch>(s).refs);
  }
  return links;
}

/** One customer still waiting: what they wrote, and what they have bought. */
interface Waiting {
  asked: Signal[];
  since: string;
  hours: number;
  purchases: Signal[];
  lifetimeCents: number;
}

const shownTime = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (items: string[]) => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const hoursText = (h: number) => plural(Math.floor(h), "business hour");
const where = (s: Signal) => {
  const t = value<CustomerTouch>(s);
  return t.system ?? t.channel ?? "an unnamed channel";
};

/** Who is waiting, from the signals: every customer whose last message has had no answer on any channel. */
export function waitingCustomers(signals: readonly Signal[], now: string, hours: StoreHours = STORE_HOURS, threshold: number = REPLY_BUSINESS_HOURS): Waiting[] {
  const nowMs = Date.parse(now);
  const links = customerLinks(signals);
  const recent = [...latestBySubject([...signals], ["customer.touch"]).values()].filter((s) => {
    const at = Date.parse(s.observedAt);
    return at <= nowMs && nowMs - at <= REPLY_LOOKBACK_DAYS * DAY_MS;
  });

  const byCustomer = new Map<string, Signal[]>();
  for (const s of recent) {
    // A message to several people is each one's, so an answer to a group answers everyone in it.
    for (const c of new Set(value<CustomerTouch>(s).refs.map((r) => links.find(r)))) byCustomer.set(c, [...(byCustomer.get(c) ?? []), s]);
  }

  // Known customers: anyone a record outside email describes, or who has bought.
  const known = new Set<string>();
  for (const s of signals) if (s.kind === "customer.identity") for (const r of value<{ refs: string[] }>(s).refs) known.add(links.find(r));
  const purchases = new Map<string, Signal[]>();
  const seenSales = new Set<string>();
  for (const s of signals) {
    if (s.kind !== "sale.customer_purchase") continue;
    const sale = value<{ saleId: string }>(s).saleId;
    if (seenSales.has(sale)) continue;
    seenSales.add(sale);
    const c = links.find(s.subject.id);
    purchases.set(c, [...(purchases.get(c) ?? []), s]);
  }

  const out: Waiting[] = [];
  for (const [customer, touches] of byCustomer) {
    const answered = touches.filter((s) => value<CustomerTouch>(s).role === "answered").map((s) => s.observedAt).sort().at(-1);
    const asked = touches.filter((s) => value<CustomerTouch>(s).role === "asked" && (answered === undefined || s.observedAt > answered)).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    if (asked.length === 0) continue;
    // Email alone also brings newsletters, receipts and vendors, so an address is raised only once something else says it's a customer.
    const bought = purchases.get(customer) ?? [];
    const emailOnly = touches.every((s) => value<CustomerTouch>(s).channel === "email");
    if (emailOnly && !known.has(customer) && bought.length === 0) continue;
    const since = asked[0]!.observedAt;
    const waited = businessHoursBetween(since, now, hours);
    if (waited < threshold) continue;
    out.push({ asked, since, hours: waited, purchases: bought, lifetimeCents: bought.reduce((n, s) => n + value<{ totalCents: number }>(s).totalCents, 0) });
  }
  return out.sort((a, b) => b.lifetimeCents - a.lifetimeCents || a.since.localeCompare(b.since));
}

function buyerRecommendation(w: Waiting, organizationId: string, now: string): Recommendation {
  const systems = [...new Set(w.asked.map(where))].sort();
  const last = w.asked.at(-1)!;
  const orders = w.purchases.length;
  const average = Math.round(w.lifetimeCents / orders);
  const high = w.lifetimeCents >= REPLY_HIGH_VALUE_CENTS;
  const latestSale = [...w.purchases].sort((a, b) => a.observedAt.localeCompare(b.observedAt)).at(-1)!;
  const who = `${high ? "A high-value customer" : "A past customer"}, who has spent ${dollars(w.lifetimeCents)} over ${plural(orders, "order")},`;
  return recommend({
    department: "clienteling",
    key: `awaiting_reply_${w.asked[0]!.subject.id}`,
    organizationId,
    summary: `${who} has waited ${hoursText(w.hours)} for a reply. They wrote ${plural(w.asked.length, "message")} on ${list(systems)}, the first at ${shownTime(w.since)}, and nobody has answered on any channel since. Reply on ${where(last)}, where they wrote last.`,
    confidence: high ? 0.85 : 0.75,
    expectedImpact: high ? "Keeps a high-value customer from going elsewhere" : "Keeps a past customer from going elsewhere",
    impact: measured(
      estimate(
        "makes",
        `${pct(ASSUMPTIONS.callCloseRate.likely)} of customers answered after a wait buy, at their average order of ${dollars(average)} and a ${pct(ASSUMPTIONS.margin.likely)} margin.`,
        (a) => a("callCloseRate") * average * a("margin"),
      ),
      { signalKind: "sale.customer_purchase", subject: latestSale.subject, centsField: "totalCents", share: ASSUMPTIONS.margin.likely, windowDays: 30, label: "purchases" },
    ),
    basedOn: [...w.asked, ...w.purchases],
    now,
  });
}

function othersRecommendation(waiting: Waiting[], organizationId: string, now: string, threshold: number): Recommendation {
  const bySystem = new Map<string, number>();
  for (const w of waiting) {
    const s = where(w.asked.at(-1)!);
    bySystem.set(s, (bySystem.get(s) ?? 0) + 1);
  }
  const counts = [...bySystem.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s, n]) => `${n} on ${s}`);
  const longest = Math.max(...waiting.map((w) => w.hours));
  const people = waiting.length === 1 ? "1 customer has" : `${waiting.length} customers have`;
  return recommend({
    department: "clienteling",
    key: "awaiting_reply_others",
    organizationId,
    summary: `${people} waited ${threshold} or more business hours for a reply, with no answer on any channel: ${list(counts)}. The longest has waited ${hoursText(longest)}. Answer them from each inbox, oldest first.`,
    confidence: 0.65,
    expectedImpact: "Answers customers before they buy elsewhere",
    impact: estimate(
      "makes",
      `${pct(ASSUMPTIONS.callCloseRate.likely)} of customers answered after a wait buy: ${plural(waiting.length, "customer")} at an average order of ${dollars(ASSUMPTIONS.averageOrderCents.likely)} and a ${pct(ASSUMPTIONS.margin.likely)} margin.`,
      (a) => waiting.length * a("callCloseRate") * a("averageOrderCents") * a("margin"),
    ),
    basedOn: waiting.flatMap((w) => w.asked),
    now,
  });
}

/** The awaiting-reply rule's name, which an instance's settings replace it by. */
export const AWAITING_REPLY_RULE = "clienteling.awaiting-reply";

/** Builds the awaiting-reply rule for a store's hours, raising a wait of `threshold` or more open hours. */
export function awaitingReplyReasoner(hours: StoreHours = STORE_HOURS, threshold: number = REPLY_BUSINESS_HOURS): Reasoner {
  if (!(threshold > 0)) throw new RangeError("the awaiting-reply threshold must be more than 0 hours");
  return {
    name: AWAITING_REPLY_RULE,
    reason: ({ organizationId, signals, now }) => {
      const waiting = waitingCustomers(signals, now, hours, threshold);
      const buyers = waiting.filter((w) => w.purchases.length > 0);
      const others = waiting.filter((w) => w.purchases.length === 0);
      return [...buyers.map((w) => buyerRecommendation(w, organizationId, now)), ...(others.length ? [othersRecommendation(others, organizationId, now, threshold)] : [])];
    },
  };
}

export const awaitingReply = awaitingReplyReasoner();

export { businessHoursBetween, STORE_HOURS, type StoreHours };
