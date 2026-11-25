import { BrainPipeline, InMemoryStore, type Recommendation, type Signal } from "@karatos/core";
import { describe, expect, it } from "vitest";
import {
  businessHoursBetween,
  combineDepartments,
  customerLinks,
  CustomerLinks,
  customerRefsOf,
  MAX_REFS_PER_RECORD,
  RETAIL_DEPARTMENTS,
  REPLY_BUSINESS_HOURS,
  REPLY_HIGH_VALUE_CENTS,
  REPLY_LOOKBACK_DAYS,
  STORE_HOURS,
  storeHours,
  waitingCustomers,
  type CustomerTouch,
  type StoreHours,
} from "../src/index.js";
import { customerMatchExtractor } from "../src/departments/customer-match.js";

/**
 * Recognizing one customer across channels by their references, and the
 * awaiting-reply rule. Every reference here is made up; none is a real
 * digest, address or number.
 */

const ORG = "customer-test";
// Wednesday 2026-11-18, 18:00 in New York (UTC-5): the store's default hours close.
const NOW = "2026-11-18T23:00:00.000Z";
/** Wednesday 10:00 in New York, when the store opens: 8 business hours before NOW. */
const OPEN = "2026-11-18T15:00:00.000Z";
const at = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

const ref = (name: string) => `form_customer:${name}`;
const ANA = { email: ref("anaemail"), phone: ref("anaphone"), shopify: "shopify:customer:7001", twilio: "twilio:contact:anatwilio" };
const BEN = { email: ref("benemail"), phone: ref("benphone"), shopify: "shopify:customer:7002", instagram: "meta_customer:beninsta" };

function brain() {
  const memory = new InMemoryStore();
  let n = 0;
  const pipeline = new BrainPipeline({
    memory,
    ...combineDepartments(RETAIL_DEPARTMENTS),
    documentation: { current: () => ({ documentIds: [], stale: false }) },
    now: () => new Date(NOW),
  });
  const send = async (source: string, type: string, payload: Record<string, unknown>, occurredAt: string, key?: string) => {
    n++;
    return pipeline.ingest({ id: `evt_${source}_${n}`, organizationId: ORG, source, type, occurredAt, receivedAt: occurredAt, idempotencyKey: key ?? `${source}:${n}`, payload });
  };
  let m = 0;
  return {
    memory,
    send,
    /** A message, as the connectors write `communication.message_logged`. */
    message: (source: string, direction: string, refs: Record<string, unknown>, occurredAt: string, extra: Record<string, unknown> = {}) =>
      send(source, "communication.message_logged", { system: source, channel: "sms", messageId: `${source}:message:${++m}`, direction, ...refs, ...extra }, occurredAt),
    call: (source: string, direction: string, refs: Record<string, unknown>, occurredAt: string, extra: Record<string, unknown> = {}) =>
      send(source, "communication.call_logged", { system: source, channel: "voice", callId: `${source}:call:${++m}`, direction, status: "completed", ...refs, ...extra }, occurredAt),
    profile: (source: string, payload: Record<string, unknown>, occurredAt = "2026-11-01T12:00:00.000Z") =>
      send(source, "customer.profile_updated", { name: "Synthetic profile", marketingConsent: false, ...payload }, occurredAt),
    sale: (saleId: string, customerId: string, totalCents: number, occurredAt = "2026-10-01T12:00:00.000Z") =>
      send("shopify", "sale.completed", { saleId, customerId, channel: "online", lines: [{ sku: "RG-1", quantity: 1, unitPriceCents: totalCents }], totalCents, payments: [{ method: "card", amountCents: totalCents }] }, occurredAt, `sale:${saleId}`),
    signals: async () => memory.recentSignals(ORG, 1000),
    recs: async (now = NOW): Promise<Recommendation[]> => {
      const reasoner = combineDepartments(RETAIL_DEPARTMENTS).reasoners.find((r) => r.name === "clienteling.awaiting-reply")!;
      return reasoner.reason({ organizationId: ORG, signals: await memory.recentSignals(ORG, 1000), documentation: { documentIds: [], stale: false }, now });
    },
  };
}

const ids = (recs: Recommendation[]) => recs.map((r) => r.id);

describe("customer references", () => {
  it("reads every reference a record names, once, sorted, and nothing that isn't one", () => {
    expect(customerRefsOf({ customerId: ANA.shopify, contactRefs: [ANA.phone, ANA.email, ANA.email], customerRefs: ANA.email, profileRef: "klaviyo:profile:abc" })).toEqual([
      "form_customer:anaemail",
      "form_customer:anaphone",
      "klaviyo:profile:abc",
      "shopify:customer:7001",
    ]);
    expect(customerRefsOf({ customerRef: ANA.phone })).toEqual([ANA.phone]);
    // Raw details never read as references: no @, no +, no spaces, and a prefix is needed.
    for (const raw of ["ana@example.test", "+12125550123", "12125550123", "form_customer:a b", "Form_customer:abc", "form_customer:", ":abc", `form_customer:${"a".repeat(65)}`, 42, null, { id: "x" }]) {
      expect(customerRefsOf({ customerId: raw, customerRefs: [raw] }), String(raw)).toEqual([]);
    }
    expect(customerRefsOf({ customerId: `form_customer:${"a".repeat(64)}` })).toHaveLength(1);
    expect(customerRefsOf({ customerId: `x:${"a".repeat(126)}` })).toEqual([]);
    // A reference is at most 128 characters, however long its prefix.
    expect(customerRefsOf({ customerId: `${"a".repeat(124)}:abc` })).toHaveLength(1);
    expect(customerRefsOf({ customerId: `${"a".repeat(125)}:abc` })).toEqual([]);
    expect(customerRefsOf({ customerId: "a:b:c_d:Z-9" })).toEqual(["a:b:c_d:Z-9"]);
    // Only the fields named are read.
    expect(customerRefsOf({ contactRef: ANA.twilio, saleId: "shopify:order:1" })).toEqual([]);
    expect(customerRefsOf({ contactRef: ANA.twilio }, ["contactRef"])).toEqual([ANA.twilio]);
  });

  it("links references into one customer whichever order the records come in", () => {
    const a = new CustomerLinks();
    a.link([ANA.email, ANA.phone]);
    a.link([ANA.shopify, ANA.email]);
    a.link([BEN.email]);
    a.link([]);
    const b = new CustomerLinks();
    b.link([ANA.shopify, ANA.email]);
    b.link([ANA.phone, ANA.email]);
    for (const links of [a, b]) {
      expect(new Set([ANA.email, ANA.phone, ANA.shopify].map((r) => links.find(r))).size).toBe(1);
      // The smallest reference names the customer.
      expect(links.find(ANA.shopify)).toBe(ANA.email);
      expect(links.find(BEN.email)).toBe(BEN.email);
      expect(links.find("never:seen")).toBe("never:seen");
    }
    // Linking two customers already linked within changes nothing; a chain still ends at one name.
    const c = new CustomerLinks();
    c.link(["d:4", "c:3"]);
    c.link(["b:2", "a:1"]);
    c.link(["c:3", "b:2"]);
    c.link(["d:4", "a:1"]);
    expect(["a:1", "b:2", "c:3", "d:4"].map((r) => c.find(r))).toEqual(["a:1", "a:1", "a:1", "a:1"]);
    // Linking a reference already linked elsewhere joins the two customers, never moves it out of the first.
    for (const second of [["c:3", "b:2"], ["b:2", "c:3"]]) {
      const d = new CustomerLinks();
      d.link(["c:3", "a:1"]);
      d.link(second);
      expect(["a:1", "b:2", "c:3"].map((r) => d.find(r)), second.join()).toEqual(["a:1", "a:1", "a:1"]);
    }
  });

  it("links what one profile names, and a Twilio contact with the number's references, but not a group's", async () => {
    const b = brain();
    await b.profile("klaviyo", { customerId: ANA.email, profileRef: "klaviyo:profile:ana", contactRefs: [ANA.email, ANA.phone] });
    await b.message("twilio", "inbound", { contactRef: ANA.twilio, customerRefs: [ANA.phone] }, OPEN);
    await b.message("quo", "outbound", { customerRefs: [BEN.phone, ref("carl")] }, OPEN);
    const links = customerLinks(await b.signals());
    expect(links.find(ANA.twilio)).toBe(links.find(ANA.email));
    expect(links.find("klaviyo:profile:ana")).toBe(links.find(ANA.email));
    expect(links.find(BEN.phone)).not.toBe(links.find(ref("carl")));
  });

  it("keeps references only: no detail, name or text reaches a signal", async () => {
    const b = brain();
    const raw = { email: "ana.synthetic@example.test", phone: "+1 212 555 0123" };
    await b.profile("shopify", { customerId: ANA.shopify, name: "Ana Synthetic", contactRefs: [ANA.email, raw.email, raw.phone] });
    await b.message("quo", "inbound", { customerRefs: [ANA.phone, raw.phone, "12125550123"], text: "Is my ring ready?", from: raw.phone }, OPEN);
    await b.send("forms", "forms.submission_received", { submissionId: "f:1", customerRef: raw.email, contactRefs: [ANA.email, raw.email] }, OPEN);
    const ours = (await b.signals()).filter((s) => s.kind === "customer.identity" || s.kind === "customer.touch");
    expect(ours.map((s) => s.kind).sort()).toEqual(["customer.identity", "customer.identity", "customer.touch"]);
    const flat = JSON.stringify(ours);
    for (const leaked of [raw.email, raw.phone, "12125550123", "5550123", "Ana Synthetic", "Is my ring ready", "@"]) expect(flat, leaked).not.toContain(leaked);
    const touch = value(ours.find((s) => s.kind === "customer.touch")!);
    expect(Object.keys(touch).sort()).toEqual(["channel", "conversationId", "kind", "onePerson", "recordId", "refs", "role", "system"]);
  });
});

const value = (s: Signal) => s.value as unknown as CustomerTouch;

describe("what counts as asking and answering", () => {
  const roleOf = async (send: (b: ReturnType<typeof brain>) => Promise<unknown>) => {
    const b = brain();
    await send(b);
    const touches = (await b.signals()).filter((s) => s.kind === "customer.touch");
    return touches.length ? value(touches[0]!).role : null;
  };
  const refs = { customerRefs: [ANA.phone] };

  it("reads each direction and status", async () => {
    expect(await roleOf((b) => b.message("quo", "inbound", refs, OPEN))).toBe("asked");
    expect(await roleOf((b) => b.message("gmail", "received", refs, OPEN))).toBe("asked");
    expect(await roleOf((b) => b.message("quo", "outbound", refs, OPEN, { status: "delivered" }))).toBe("answered");
    expect(await roleOf((b) => b.message("gmail", "sent", refs, OPEN))).toBe("answered");
    for (const status of ["failed", "undelivered", "canceled", "cancelled", "FAILED"]) expect(await roleOf((b) => b.message("twilio", "outbound", refs, OPEN, { status })), status).toBe("neither");
    for (const flag of ["failed", "deleted", "byRule"]) expect(await roleOf((b) => b.message("gorgias", "outbound", refs, OPEN, { [flag]: true })), flag).toBe("neither");
    expect(await roleOf((b) => b.message("gorgias", "outbound", refs, OPEN, { failed: false, deleted: false, byRule: false }))).toBe("answered");
    expect(await roleOf((b) => b.message("gorgias", "inbound", refs, OPEN, { deleted: true }))).toBe("neither");
    expect(await roleOf((b) => b.message("gorgias", "inbound", refs, OPEN, { byRule: true, failed: true }))).toBe("asked");
    expect(await roleOf((b) => b.message("quo", "outbound", { customerRefs: [] }, OPEN))).toBeNull();
    expect(await roleOf((b) => b.message("quo", "outbound", { customerRefs: ["+12125550123"] }, OPEN))).toBeNull();
    expect(await roleOf((b) => b.send("x", "communication.message_logged", { messageId: "x:1", customerRefs: [ANA.phone] }, OPEN))).toBeNull();
    expect(await roleOf((b) => b.send("x", "communication.message_logged", { messageId: "", direction: "inbound", customerRefs: [ANA.phone] }, OPEN).catch(() => null))).toBeNull();
  });

  it("counts a call the store made or picked up as an answer, and a missed one as neither", async () => {
    expect(await roleOf((b) => b.call("quo", "inbound", refs, OPEN))).toBe("answered");
    expect(await roleOf((b) => b.call("quo", "inbound", refs, OPEN, { status: "answered" }))).toBe("answered");
    expect(await roleOf((b) => b.call("quo", "inbound", refs, OPEN, { status: "in-progress" }))).toBe("answered");
    expect(await roleOf((b) => b.call("quo", "inbound", refs, OPEN, { status: "completed", missed: true }))).toBe("neither");
    expect(await roleOf((b) => b.call("quo", "inbound", refs, OPEN, { status: "ringing" }))).toBe("neither");
    expect(await roleOf((b) => b.call("twilio", "outbound", refs, OPEN, { status: "no-answer" }))).toBe("answered");
    expect(await roleOf((b) => b.call("twilio", "outbound", refs, OPEN, { status: "failed" }))).toBe("neither");
    expect(await roleOf((b) => b.send("x", "communication.call_logged", { callId: "", direction: "inbound", status: "completed", customerRefs: [ANA.phone] }, OPEN).catch(() => null))).toBeNull();
  });

  it("keeps a thread or conversation, the channel and the system, cut to length", async () => {
    const b = brain();
    await b.message("gmail", "received", refs, OPEN, { threadId: "gmail:thread:1", channel: "email", system: undefined });
    await b.message("quo", "inbound", refs, OPEN, { conversationId: "quo:conversation:2", threadId: "ignored", channel: `  ${"c".repeat(50)}  `, system: "   " });
    const touches = (await b.signals()).filter((s) => s.kind === "customer.touch").map(value);
    expect(touches.map((t) => [t.conversationId, t.channel, t.system, t.kind])).toEqual(
      expect.arrayContaining([
        ["gmail:thread:1", "email", null, "message"],
        ["quo:conversation:2", "c".repeat(40), null, "message"],
      ]),
    );
  });

  it("keeps long record and thread ids whole, and reads each reference once", async () => {
    const b = brain();
    const long = `meta:instagram:message:${"m".repeat(100)}`;
    await b.send("meta", "communication.message_logged", { messageId: long, threadId: `t:${"t".repeat(150)}`, direction: "inbound", contactRef: ANA.twilio, customerRefs: [ANA.twilio, ANA.phone] }, OPEN);
    const [t] = (await b.signals()).filter((s) => s.kind === "customer.touch").map(value);
    expect(t!.recordId).toBe(long);
    expect(t!.conversationId).toBe(`t:${"t".repeat(150)}`);
    expect(t!.refs).toEqual([ANA.phone, ANA.twilio].sort());
    // Straight from the extractor, as no department schema stands in front of it: a record with no id is no touch.
    const raw = (payload: Record<string, unknown>, type = "communication.message_logged") =>
      customerMatchExtractor.extract([], { id: "e1", organizationId: ORG, source: "x", type, occurredAt: OPEN, receivedAt: OPEN, idempotencyKey: "k1", payload }) as Signal[];
    expect(raw({ direction: "inbound", customerRefs: [ANA.phone] })).toEqual([]);
    expect(raw({ messageId: "  ", direction: "inbound", customerRefs: [ANA.phone] })).toEqual([]);
    expect(raw({ callId: "c:1", direction: "inbound", status: "completed", customerRefs: [ANA.phone] }, "communication.call_logged")).toHaveLength(1);
  });

  it("leaves a record naming more references than one person has", async () => {
    expect(MAX_REFS_PER_RECORD).toBe(8);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ref(`p${i}`));
    const b = brain();
    await b.message("quo", "inbound", { customerRefs: many(MAX_REFS_PER_RECORD) }, OPEN);
    await b.message("quo", "inbound", { customerRefs: many(MAX_REFS_PER_RECORD + 1) }, OPEN);
    await b.profile("klaviyo", { customerId: ref("q0"), contactRefs: many(MAX_REFS_PER_RECORD - 1) });
    await b.profile("klaviyo", { customerId: ref("r0"), contactRefs: many(MAX_REFS_PER_RECORD) });
    const s = await b.signals();
    expect(s.filter((x) => x.kind === "customer.touch")).toHaveLength(1);
    expect(s.filter((x) => x.kind === "customer.identity")).toHaveLength(1);
  });

  it("reads identities only from records about one person", async () => {
    const b = brain();
    for (const type of ["forms.submission_received", "loyalty.customer_updated", "review.updated", "payment.charge_updated", "payment.refund_updated", "appointment.booked", "appointment.canceled", "appointment.no_show"]) {
      await b.send("x", type, { customerRefs: [ANA.email, ANA.phone] }, OPEN);
    }
    await b.send("zoom", "appointment.held", { customerRefs: [ANA.email, BEN.email] }, OPEN);
    await b.send("gorgias", "communication.ticket_updated", { customerRefs: [ANA.email, BEN.email] }, OPEN);
    await b.profile("shopify", { customerId: ANA.shopify });
    // A record with no reference that reads names nobody.
    await b.profile("shopify", { customerId: "not a reference" });
    const identities = (await b.signals()).filter((x) => x.kind === "customer.identity");
    expect(identities).toHaveLength(9);
    expect(identities.every((x) => !(x.value as { refs: string[] }).refs.includes(BEN.email))).toBe(true);
  });
});

describe("business hours", () => {
  it("counts only the store's open hours, Monday to Saturday, 10 to 6 in New York", () => {
    const day = [{ open: 600, close: 1080 }];
    expect(STORE_HOURS).toEqual({ timeZone: "America/New_York", week: [[], day, day, day, day, day, day], closedDates: [] });
    expect(businessHoursBetween(OPEN, NOW)).toBe(8);
    expect(businessHoursBetween(OPEN, at(OPEN, 240))).toBe(4);
    expect(businessHoursBetween(at(OPEN, 7), at(OPEN, 37))).toBe(0.5);
    expect(businessHoursBetween(at(OPEN, -60), at(OPEN, 60))).toBe(1);
    expect(businessHoursBetween(at(NOW, -60), at(NOW, 60))).toBe(1);
    // Overnight: 5 to 6 pm Wednesday and 10 to 11 am Thursday.
    expect(businessHoursBetween("2026-11-18T22:00:00.000Z", "2026-11-19T16:00:00.000Z")).toBe(2);
    // Sunday is closed: 5 to 6 pm Saturday and 10 to 11 am Monday.
    expect(businessHoursBetween("2026-11-21T22:00:00.000Z", "2026-11-23T16:00:00.000Z")).toBe(2);
    expect(businessHoursBetween("2026-11-22T15:00:00.000Z", "2026-11-22T23:00:00.000Z")).toBe(0);
    // Saturday counts.
    expect(businessHoursBetween("2026-11-21T15:00:00.000Z", "2026-11-21T23:00:00.000Z")).toBe(8);
    expect(businessHoursBetween(NOW, OPEN)).toBe(0);
    expect(businessHoursBetween(NOW, NOW)).toBe(0);
    expect(businessHoursBetween("not a time", NOW)).toBe(0);
  });

  it("follows the clock change and another store's hours, to the quarter hour", () => {
    // Saturday 2026-10-31 is still daylight time (10:00 is 14:00 UTC); Monday 2026-11-02 isn't (15:00 UTC).
    expect(businessHoursBetween("2026-10-31T14:00:00.000Z", "2026-11-02T15:00:00.000Z")).toBe(8);
    expect(businessHoursBetween("2026-11-02T14:00:00.000Z", "2026-11-02T15:00:00.000Z")).toBe(0);
    const india: StoreHours = storeHours("Asia/Kolkata", "wed 10:00-11:00");
    // 10:00 in Kolkata is 04:30 UTC.
    expect(businessHoursBetween("2026-11-18T04:00:00.000Z", "2026-11-18T05:00:00.000Z", india)).toBe(0.5);
    expect(businessHoursBetween("2026-11-18T05:00:00.000Z", "2026-11-18T06:00:00.000Z", india)).toBe(0.5);
    expect(businessHoursBetween("2026-11-19T04:30:00.000Z", "2026-11-19T05:30:00.000Z", india)).toBe(0);
    // Kathmandu is 5:45 ahead: 10:00 there is 04:15 UTC.
    const nepal: StoreHours = storeHours("Asia/Kathmandu", "wed 10:00-11:00");
    expect(businessHoursBetween("2026-11-18T04:00:00.000Z", "2026-11-18T05:00:00.000Z", nepal)).toBe(0.75);
    // Opening on the half hour, and hours that start at midnight.
    expect(businessHoursBetween(OPEN, at(OPEN, 60), storeHours("America/New_York", "mon-sat 10:30-18:00"))).toBe(0.5);
    expect(businessHoursBetween("2026-11-18T05:00:00.000Z", "2026-11-18T06:00:00.000Z", storeHours("America/New_York", "mon-sat 00:00-01:00"))).toBe(1);
    // Backwards within one quarter hour is still nothing.
    expect(businessHoursBetween(at(OPEN, 10), at(OPEN, 5))).toBe(0);
  });
});

describe("customers waiting on a reply", () => {
  it("raises a past buyer whose text has had no answer on any channel, with what they spent, citing the messages and orders", async () => {
    const b = brain();
    await b.profile("shopify", { customerId: ANA.shopify, contactRefs: [ANA.email, ANA.phone] });
    await b.sale("shopify:order:1", ANA.shopify, 120_000);
    await b.sale("shopify:order:2", ANA.shopify, 80_000, "2026-10-20T12:00:00.000Z");
    const first = await b.message("Quo", "inbound", { customerRefs: [ANA.phone] }, OPEN);
    const second = await b.message("Instagram", "inbound", { customerRefs: [ANA.email] }, at(OPEN, 30));
    const recs = await b.recs();
    expect(ids(recs)).toEqual(["rec_clienteling_awaiting_reply_Quo:message:1_2026-11-18"]);
    expect(recs[0]!.summary).toBe(
      "A past customer, who has spent $2,000.00 over 2 orders, has waited 8 business hours for a reply. They wrote 2 messages on Instagram and Quo, the first at 2026-11-18 15:00 UTC, and nobody has answered on any channel since. Reply on Instagram, where they wrote last.",
    );
    expect(recs[0]!.confidence).toBe(0.75);
    expect(recs[0]!.expectedImpact).toBe("Keeps a past customer from going elsewhere");
    expect(recs[0]!.provenance.eventIds.sort()).toEqual(
      [first.event.id, second.event.id, ...(await b.memory.recentSignals(ORG, 100)).filter((s) => s.kind === "sale.customer_purchase").flatMap((s) => s.derivedFromEventIds)].sort(),
    );
    expect(recs[0]!.impact).toMatchObject({ kind: "makes", measure: { signalKind: "sale.customer_purchase", subject: { kind: "customer", id: ANA.shopify }, windowDays: 30 } });
    // 15% of an average order of $1,000 at a 45% margin.
    expect([recs[0]!.impact!.lowCents, recs[0]!.impact!.cents, recs[0]!.impact!.highCents]).toEqual([3500, 6750, 13750]);
    expect(recs[0]!.impact!.basis).toBe("15% of customers answered after a wait buy, at their average order of $1,000.00 and a 45% margin.");
  });

  it("calls a buyer high-value from the lapsed-VIP threshold up", async () => {
    for (const [cents, high] of [[REPLY_HIGH_VALUE_CENTS, true], [REPLY_HIGH_VALUE_CENTS - 1, false]] as const) {
      const b = brain();
      await b.profile("shopify", { customerId: ANA.shopify, contactRefs: [ANA.phone] });
      await b.sale("shopify:order:1", ANA.shopify, cents);
      await b.message("WhatsApp", "inbound", { customerRefs: [ANA.phone] }, OPEN);
      const [rec] = await b.recs();
      expect(rec!.summary.startsWith(high ? "A high-value customer, who has spent $5,000.00 over 1 order," : "A past customer, who has spent $4,999.99 over 1 order,")).toBe(true);
      expect(rec!.confidence).toBe(high ? 0.85 : 0.75);
      expect(rec!.expectedImpact).toBe(high ? "Keeps a high-value customer from going elsewhere" : "Keeps a past customer from going elsewhere");
    }
  });

  it("counts an answer on any linked channel, and only a linked one", async () => {
    const answered = brain();
    await answered.profile("klaviyo", { customerId: ANA.email, contactRefs: [ANA.email, ANA.phone] });
    await answered.message("WhatsApp", "inbound", { customerRefs: [ANA.phone] }, OPEN);
    await answered.message("Gmail", "sent", { customerRefs: [ANA.email], channel: "email" }, at(OPEN, 60));
    expect(await answered.recs()).toEqual([]);

    const unlinked = brain();
    await unlinked.message("WhatsApp", "inbound", { customerRefs: [ANA.phone] }, OPEN);
    await unlinked.message("Gmail", "sent", { customerRefs: [ANA.email], channel: "email" }, at(OPEN, 60));
    expect(ids(await unlinked.recs())).toEqual(["rec_clienteling_awaiting_reply_others_2026-11-18"]);
  });

  it("links Twilio's own contact references through a record that carries both", async () => {
    const b = brain();
    // An older Twilio text read before CUSTOMER_REF_KEY was set has only its contactRef.
    await b.message("Twilio", "inbound", { contactRef: ANA.twilio }, OPEN);
    await b.message("Twilio", "inbound", { contactRef: ANA.twilio, customerRefs: [ANA.phone] }, at(OPEN, 10));
    await b.message("Quo", "outbound", { customerRefs: [ANA.phone] }, at(OPEN, 20));
    expect(await b.recs()).toEqual([]);
  });

  it("raises from exactly the threshold, and not a quarter hour short of it", async () => {
    expect(REPLY_BUSINESS_HOURS).toBe(4);
    const wait = async (minutes: number) => {
      const b = brain();
      await b.message("Quo", "inbound", { customerRefs: [ANA.phone] }, at(NOW, -minutes));
      return b.recs();
    };
    expect(await wait(240)).toHaveLength(1);
    expect(await wait(225)).toEqual([]);
    expect((await wait(240))[0]!.summary).toBe(
      "1 customer has waited 4 or more business hours for a reply, with no answer on any channel: 1 on Quo. The longest has waited 4 business hours. Answer them from each inbox, oldest first.",
    );
  });

  it("leaves messages older than the lookback, and ones from after now", async () => {
    expect(REPLY_LOOKBACK_DAYS).toBe(14);
    const old = brain();
    await old.message("Quo", "inbound", { customerRefs: [ANA.phone] }, new Date(Date.parse(NOW) - REPLY_LOOKBACK_DAYS * 86_400_000 - 1).toISOString());
    expect(await old.recs()).toEqual([]);
    const edge = brain();
    await edge.message("Quo", "inbound", { customerRefs: [ANA.phone] }, at(NOW, -REPLY_LOOKBACK_DAYS * 1440));
    expect(await edge.recs()).toHaveLength(1);
    const future = brain();
    await future.message("Quo", "inbound", { customerRefs: [ANA.phone] }, at(NOW, 1));
    expect(await future.recs()).toEqual([]);
    // An answer from before the lookback doesn't count against a message inside it, and doesn't hide it.
    const mixed = brain();
    await mixed.message("Quo", "outbound", { customerRefs: [ANA.phone] }, at(NOW, -REPLY_LOOKBACK_DAYS * 1440 - 60));
    await mixed.message("Quo", "inbound", { customerRefs: [ANA.phone] }, OPEN);
    expect(await mixed.recs()).toHaveLength(1);
    // An answer at this very moment counts; one stamped after it doesn't.
    for (const [when, raised] of [[NOW, 0], [at(NOW, 1), 1]] as const) {
      const b = brain();
      await b.message("Quo", "inbound", { customerRefs: [ANA.phone] }, OPEN);
      await b.message("Quo", "outbound", { customerRefs: [ANA.phone] }, when);
      expect(await b.recs(), when).toHaveLength(raised);
    }
  });

  it("counts from the first message after the last answer, and an answer at the same moment counts", async () => {
    const b = brain();
    await b.message("Quo", "inbound", { customerRefs: [ANA.phone] }, "2026-11-17T15:00:00.000Z");
    await b.message("Quo", "outbound", { customerRefs: [ANA.phone] }, "2026-11-17T16:00:00.000Z");
    await b.message("Quo", "inbound", { customerRefs: [ANA.phone] }, at(NOW, -300));
    await b.message("Quo", "inbound", { customerRefs: [ANA.phone] }, at(NOW, -60));
    const [rec] = await b.recs();
    expect(rec!.summary).toContain("The longest has waited 5 business hours.");
    expect(rec!.provenance.signalIds).toHaveLength(2);

    // Answered, asked again, answered again: nothing waits.
    const twice = brain();
    await twice.message("Quo", "inbound", { customerRefs: [ANA.phone] }, "2026-11-17T15:00:00.000Z");
    await twice.message("Quo", "outbound", { customerRefs: [ANA.phone] }, "2026-11-17T16:00:00.000Z");
    await twice.message("Quo", "inbound", { customerRefs: [ANA.phone] }, OPEN);
    await twice.message("Quo", "outbound", { customerRefs: [ANA.phone] }, at(OPEN, 30));
    expect(await twice.recs()).toEqual([]);

    // Read out of order: the wait still counts from the earliest, part hours rounded down.
    const late = brain();
    await late.message("Quo", "inbound", { customerRefs: [ANA.phone] }, at(NOW, -60));
    await late.message("Quo", "inbound", { customerRefs: [ANA.phone] }, at(NOW, -275));
    expect(waitingCustomers(await late.signals(), NOW)[0]!.since).toBe(at(NOW, -275));
    expect((await late.recs())[0]!.summary).toContain("The longest has waited 4 business hours.");

    const tie = brain();
    await tie.message("Quo", "inbound", { customerRefs: [ANA.phone] }, OPEN);
    await tie.call("Quo", "outbound", { customerRefs: [ANA.phone] }, OPEN);
    expect(await tie.recs()).toEqual([]);
  });

  it("raises an email-only correspondent only once another record says they are a customer", async () => {
    const stranger = brain();
    await stranger.message("Gmail", "received", { customerRefs: [BEN.email], channel: "email" }, OPEN);
    expect(await stranger.recs()).toEqual([]);

    const known = brain();
    await known.send("forms", "forms.submission_received", { submissionId: "f:1", customerRef: BEN.email, contactRefs: [BEN.email] }, "2026-11-10T12:00:00.000Z");
    await known.message("Gmail", "received", { customerRefs: [BEN.email], channel: "email" }, OPEN);
    expect(ids(await known.recs())).toEqual(["rec_clienteling_awaiting_reply_others_2026-11-18"]);

    const buyer = brain();
    await buyer.sale("shopify:order:9", BEN.email, 50_000);
    await buyer.message("Gmail", "received", { customerRefs: [BEN.email], channel: "email" }, OPEN);
    expect(ids(await buyer.recs())).toEqual(["rec_clienteling_awaiting_reply_Gmail:message:1_2026-11-18"]);

    const otherChannel = brain();
    await otherChannel.message("Instagram", "inbound", { customerRefs: [BEN.instagram], channel: "instagram" }, OPEN);
    expect(await otherChannel.recs()).toHaveLength(1);
  });

  it("counts a message naming two of one customer's references once", async () => {
    const b = brain();
    await b.profile("klaviyo", { customerId: ANA.email, contactRefs: [ANA.email, ANA.phone] });
    await b.sale("s:1", ANA.email, 10_000);
    await b.message("Quo", "inbound", { customerRefs: [ANA.email, ANA.phone] }, OPEN);
    expect((await b.recs())[0]!.summary).toContain("They wrote 1 message on Quo,");
  });

  it("raises someone who wrote by email and on another channel, though no record says who they are", async () => {
    const b = brain();
    await b.message("Gmail", "received", { contactRef: ANA.twilio, customerRefs: [ANA.email], channel: "email" }, OPEN);
    await b.message("Twilio", "inbound", { contactRef: ANA.twilio }, at(OPEN, 5));
    expect(await b.recs()).toHaveLength(1);
  });

  it("answers everyone in a group message", async () => {
    const b = brain();
    await b.message("Quo", "inbound", { customerRefs: [ANA.phone] }, OPEN);
    await b.message("Quo", "inbound", { customerRefs: [BEN.phone] }, OPEN);
    await b.message("Quo", "outbound", { customerRefs: [ANA.phone, BEN.phone] }, at(OPEN, 5));
    expect(await b.recs()).toEqual([]);
  });

  it("counts a message read twice, or again with a new status, once", async () => {
    const b = brain();
    const payload = { system: "Twilio", channel: "sms", messageId: "twilio:message:1", direction: "inbound", customerRefs: [ANA.phone] };
    await b.send("twilio", "communication.message_logged", { ...payload, status: "received" }, OPEN, "t:1:received");
    await b.send("twilio", "communication.message_logged", { ...payload, status: "received" }, OPEN, "t:1:received");
    await b.send("twilio", "communication.message_logged", { ...payload, status: "read" }, OPEN, "t:1:read");
    const reply = { ...payload, messageId: "twilio:message:2", direction: "outbound" };
    await b.send("twilio", "communication.message_logged", { ...reply, status: "queued" }, at(OPEN, 5), "t:2:queued");
    await b.send("twilio", "communication.message_logged", { ...reply, status: "undelivered" }, at(OPEN, 6), "t:2:undelivered");
    await b.sale("shopify:order:1", ANA.phone, 10_000);
    await b.sale("shopify:order:1", ANA.phone, 10_000);
    await b.send("sales", "sale.completed", { saleId: "shopify:order:1", customerId: ANA.phone, channel: "online", lines: [{ sku: "RG-1", quantity: 1, unitPriceCents: 10_000 }], totalCents: 10_000, payments: [{ method: "card", amountCents: 10_000 }] }, OPEN, "other:1");
    const recs = await b.recs();
    // The reply never got there, so the customer is still waiting; one message, one order.
    expect(recs).toHaveLength(1);
    expect(recs[0]!.summary).toContain("who has spent $100.00 over 1 order,");
    expect(recs[0]!.summary).toContain("They wrote 1 message on Twilio");
    // Twice the same id for the same signal; the pipeline stores each once.
    expect(new Set(recs[0]!.provenance.signalIds).size).toBe(recs[0]!.provenance.signalIds.length);
  });

  it("names a channel when the record has no system, and raises everyone else together, busiest channel first", async () => {
    const b = brain();
    await b.message("x", "inbound", { customerRefs: [ref("one")], system: undefined, channel: "sms" }, OPEN);
    await b.message("x", "inbound", { customerRefs: [ref("two")], system: undefined, channel: undefined }, at(OPEN, 60));
    await b.message("Instagram", "inbound", { customerRefs: ["meta_customer:three"] }, at(OPEN, 90));
    await b.message("Instagram", "inbound", { customerRefs: ["meta_customer:four"] }, at(OPEN, 120));
    const recs = await b.recs();
    expect(ids(recs)).toEqual(["rec_clienteling_awaiting_reply_others_2026-11-18"]);
    expect(recs[0]!.summary).toBe(
      "4 customers have waited 4 or more business hours for a reply, with no answer on any channel: 2 on Instagram, 1 on an unnamed channel and 1 on sms. The longest has waited 8 business hours. Answer them from each inbox, oldest first.",
    );
    expect(recs[0]!.confidence).toBe(0.65);
    expect([recs[0]!.impact!.lowCents, recs[0]!.impact!.cents, recs[0]!.impact!.highCents]).toEqual([4 * 0.1 * 80_000 * 0.35, 4 * 0.15 * 150_000 * 0.45, 4 * 0.25 * 250_000 * 0.55]);
    expect(recs[0]!.impact!.basis).toBe("15% of customers answered after a wait buy: 4 customers at an average order of $1,500.00 and a 45% margin.");
    expect(recs[0]!.provenance.signalIds).toHaveLength(4);
  });

  it("raises buyers by what they spent, then by how long they waited", async () => {
    const b = brain();
    await b.sale("s:1", ANA.phone, 10_000);
    await b.sale("s:2", BEN.phone, 90_000);
    await b.sale("s:3", ref("carl"), 10_000);
    await b.message("Quo", "inbound", { customerRefs: [ANA.phone] }, at(OPEN, 60));
    await b.message("Quo", "inbound", { customerRefs: [BEN.phone] }, at(OPEN, 120));
    await b.message("Quo", "inbound", { customerRefs: [ref("carl")] }, OPEN);
    const waiting = waitingCustomers(await b.signals(), NOW);
    expect(waiting.map((w) => [w.lifetimeCents, w.hours])).toEqual([
      [90_000, 6],
      [10_000, 8],
      [10_000, 7],
    ]);
    const recs = await b.recs();
    expect(recs.map((r) => r.summary.slice(0, 61))).toEqual([
      "A past customer, who has spent $900.00 over 1 order, has wait",
      "A past customer, who has spent $100.00 over 1 order, has wait",
      "A past customer, who has spent $100.00 over 1 order, has wait",
    ]);
    // Equal spend and wait: the earlier message first.
    const tied = brain();
    await tied.message("Quo", "inbound", { customerRefs: [ref("late")] }, "2026-11-17T23:30:00.000Z");
    await tied.message("Quo", "inbound", { customerRefs: [ref("early")] }, "2026-11-17T23:10:00.000Z");
    expect(waitingCustomers(await tied.signals(), NOW).map((w) => w.since)).toEqual(["2026-11-17T23:10:00.000Z", "2026-11-17T23:30:00.000Z"]);
  });

  it("names each channel once, cites the latest order for its result, and counts others by where they wrote last", async () => {
    const b = brain();
    await b.profile("shopify", { customerId: ANA.shopify, contactRefs: [ANA.phone] });
    await b.sale("s:1", ANA.shopify, 10_000, "2026-10-01T12:00:00.000Z");
    await b.sale("s:2", ANA.phone, 20_000, "2026-11-01T12:00:00.000Z");
    await b.message("Quo", "inbound", { customerRefs: [ANA.phone] }, OPEN);
    await b.message("Quo", "inbound", { customerRefs: [ANA.phone] }, at(OPEN, 10));
    await b.message("Instagram", "inbound", { customerRefs: [BEN.instagram] }, OPEN);
    await b.message("WhatsApp", "inbound", { customerRefs: [BEN.instagram] }, at(OPEN, 10));
    const [buyer, others] = await b.recs();
    expect(buyer!.summary).toContain("They wrote 2 messages on Quo, the first");
    expect(buyer!.impact!.measure!.subject).toEqual({ kind: "customer", id: ANA.phone });
    expect(others!.summary).toContain(": 1 on WhatsApp.");
  });

  it("takes another store's hours", async () => {
    const b = brain();
    await b.message("Quo", "inbound", { customerRefs: [ANA.phone] }, at(NOW, -300));
    const signals = await b.signals();
    expect(waitingCustomers(signals, NOW)).toHaveLength(1);
    expect(waitingCustomers(signals, NOW, storeHours("America/New_York", "sun 10:00-18:00"))).toEqual([]);
  });
});
