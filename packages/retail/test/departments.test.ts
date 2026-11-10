import { describe, expect, it } from "vitest";
import { about, store } from "./harness.js";

const NOW = "2026-10-02T15:00:00.000Z";

const sale = (saleId: string, sku: string, opts: { qty?: number; price?: number; customerId?: string; cash?: number } = {}) => {
  const qty = opts.qty ?? 1;
  const price = opts.price ?? 50_000;
  const total = qty * price;
  const payments = opts.cash
    ? [{ method: "cash", amountCents: opts.cash }, ...(total > opts.cash ? [{ method: "card", amountCents: total - opts.cash }] : [])]
    : [{ method: "card", amountCents: total }];
  return {
    saleId,
    channel: "store",
    lines: [{ sku, quantity: qty, unitPriceCents: price }],
    totalCents: total,
    payments,
    ...(opts.customerId ? { customerId: opts.customerId } : {}),
  };
};

const received = (sku: string, extra: Record<string, unknown> = {}) => ({
  sku,
  title: `Item ${sku}`,
  category: "ring",
  costCents: 40_000,
  retailPriceCents: 100_000,
  quantity: 1,
  ...extra,
});

describe("sales", () => {
  it("flags a SKU that keeps coming back", async () => {
    const s = store();
    for (let i = 0; i < 4; i++) await s.send("sale.completed", sale(`S${i}`, "RING-1"));
    await s.send("sale.returned", { saleId: "S0", returnId: "X0", lines: [{ sku: "RING-1", quantity: 1, refundCents: 50_000 }] });
    const recs = about(await s.ask(), "RING-1");
    expect(recs).toHaveLength(1);
    expect(recs[0]!.summary).toContain("1 of 4 times (25%)");
  });

  it("ignores SKUs with few sales or few returns", async () => {
    const s = store();
    for (let i = 0; i < 3; i++) await s.send("sale.completed", sale(`S${i}`, "RING-1"));
    await s.send("sale.returned", { saleId: "S0", returnId: "X0", lines: [{ sku: "RING-1", quantity: 1, refundCents: 1 }] });
    for (let i = 0; i < 8; i++) await s.send("sale.completed", sale(`T${i}`, "RING-2"));
    await s.send("sale.returned", { saleId: "T0", returnId: "X1", lines: [{ sku: "RING-2", quantity: 1, refundCents: 1 }] });
    expect(await s.ask()).toEqual([]);
  });
});

describe("inventory", () => {
  it("flags stock that has sat for 9 months and values its gold", async () => {
    const s = store();
    await s.send("metal.price_updated", { metal: "gold", spotPerTroyOunceCents: 250_000 }, "2026-09-30T12:00:00Z");
    await s.send(
      "inventory.received",
      received("CHAIN-1", { title: "14k Cuban chain", category: "necklace", metal: "gold", karat: 14, weightGrams: 25, costCents: 100_000 }),
      "2025-12-01T12:00:00Z",
    );
    const [rec] = about(await s.ask(NOW), "CHAIN-1");
    expect(rec!.summary).toContain("sat for 305 days");
    // 25g of 14k at $2,500/ozt is $1,172.16, above 85% of the $1,000 cost.
    expect(rec!.summary).toContain("metal alone is worth about $1,172.16");
    expect(rec!.provenance.signalIds.some((id) => id.startsWith("sig_metal.price"))).toBe(true);
  });

  it("leaves memo goods, sold-out and recently sold items alone", async () => {
    const s = store();
    await s.send("inventory.received", received("MEMO-1", { onMemo: true }), "2025-01-01T00:00:00Z");
    await s.send("inventory.received", received("SOLD-1"), "2025-01-01T00:00:00Z");
    await s.send("sale.completed", sale("S1", "SOLD-1"), "2025-02-01T00:00:00Z");
    await s.send("inventory.received", received("MOVING-1", { quantity: 3 }), "2025-01-01T00:00:00Z");
    await s.send("sale.completed", sale("S2", "MOVING-1"), "2026-09-01T00:00:00Z");
    expect(about(await s.ask(NOW), "has sat")).toEqual([]);
  });

  it("recommends reordering fast sellers that are nearly out", async () => {
    const s = store();
    await s.send("inventory.received", received("STUD-1", { title: "Diamond studs", category: "earrings", quantity: 3 }), "2026-08-01T00:00:00Z");
    await s.send("sale.completed", sale("S1", "STUD-1", { qty: 2 }), "2026-09-10T00:00:00Z");
    await s.send("inventory.adjusted", { sku: "STUD-1", delta: 0, reason: "count" }, "2026-09-11T00:00:00Z");
    const [rec] = about(await s.ask(NOW), "Reorder");
    expect(rec!.summary).toBe("Reorder Diamond studs (STUD-1): 2 sold in the last 60 days and 1 left.");
  });
});

const trayCount = (tray: string, extra: Record<string, unknown> = {}) => ({
  tray,
  startedAt: "2026-10-01T21:00:00.000Z",
  countedAt: "2026-10-01T21:05:00.000Z",
  staff: [],
  found: [{ tag: "TEST-BC-1", sku: "RING-1" }],
  missing: [],
  unexpected: [],
  ...extra,
});

describe("inventory: tray counts", () => {
  it("flags a short count, naming the missing tags and what they cost", async () => {
    const s = store();
    await s.send("inventory.received", received("RING-2", { costCents: 30_000 }), "2026-01-01T00:00:00Z");
    await s.send("inventory.received", received("RING-2", { costCents: 45_000 }), "2026-06-01T00:00:00Z");
    await s.send("inventory.received", received("RING-9", { costCents: 99_000 }), "2026-06-01T00:00:00Z");
    await s.send(
      "inventory.tray_counted",
      trayCount("Tray A1", { staff: ["TEST-STAFF-1", "TEST-STAFF-2"], missing: [{ tag: "TEST-BC-2", sku: "RING-2" }, { tag: "TEST-BC-3", sku: "RING-3" }, { tag: "TEST-BC-4" }] }),
      "2026-10-01T21:05:00Z",
    );
    const [rec, ...rest] = about(await s.ask(NOW), "Tray A1");
    expect(rest).toEqual([]);
    expect(rec!.summary).toBe(
      "The count of Tray A1 on 2026-10-01 by TEST-STAFF-1 and TEST-STAFF-2 came up 3 short: TEST-BC-2 (RING-2), TEST-BC-3 (RING-3), TEST-BC-4. Check the safe, repair envelopes and pieces out on memo or approval before calling it a loss.",
    );
    expect(rec!.id).toBe("rec_inventory_tray_Tray A1_2026-10-02");
    expect(rec!.confidence).toBe(0.8);
    // The latest receipt of RING-2 says what it cost; RING-3 was never received and the last tag has no SKU.
    expect(rec!.expectedImpact).toBe("Accounts for $450.00 of stock at cost");
    expect(rec!.impact).toEqual({ kind: "protects", cents: 45_000, lowCents: 45_000, highCents: 45_000, basis: "The cost of the missing pieces whose SKU KaratOS knows (1 of 3)." });
    expect(rec!.provenance.signalIds.filter((id) => id.startsWith("sig_inventory.received"))).toHaveLength(1);
    expect(rec!.provenance.signalIds.some((id) => id.startsWith("sig_inventory.tray_counted_tray_Tray A1"))).toBe(true);
  });

  it("names five tags and says how many more", async () => {
    const s = store();
    const tags = (n: number) => Array.from({ length: n }, (_, i) => ({ tag: `TEST-BC-${i + 1}` }));
    await s.send("inventory.tray_counted", trayCount("Tray A1", { missing: tags(7) }));
    await s.send("inventory.tray_counted", trayCount("Tray A2", { missing: tags(5) }));
    const recs = await s.ask(NOW);
    expect(about(recs, "Tray A1")[0]!.summary).toContain("came up 7 short: TEST-BC-1, TEST-BC-2, TEST-BC-3, TEST-BC-4, TEST-BC-5 and 2 more. Check");
    expect(about(recs, "Tray A2")[0]!.summary).toContain("came up 5 short: TEST-BC-1, TEST-BC-2, TEST-BC-3, TEST-BC-4, TEST-BC-5. Check");
  });

  it("points out pieces read in the wrong tray", async () => {
    const s = store();
    await s.send("inventory.tray_counted", trayCount("Case 3", { unexpected: [{ tag: "TEST-BC-7", sku: "NECK-1" }] }));
    await s.send("inventory.tray_counted", trayCount("Case 4", { missing: [{ tag: "TEST-BC-8" }], unexpected: [{ tag: "TEST-BC-5" }, { tag: "TEST-BC-6" }] }));
    const recs = await s.ask(NOW);
    const [one] = about(recs, "Case 3");
    expect(one!.summary).toBe("The count of Case 3 on 2026-10-01 found everything that belongs there. 1 piece read there belongs in another tray: TEST-BC-7 (NECK-1).");
    expect(one!.confidence).toBe(0.6);
    expect(one!.expectedImpact).toBe("Keeps the case count true");
    expect(one!.impact).toBeUndefined();
    expect(about(recs, "Case 4")[0]!.summary).toBe(
      "The count of Case 4 on 2026-10-01 came up 1 short: TEST-BC-8. Check the safe, repair envelopes and pieces out on memo or approval before calling it a loss. 2 pieces read there belong in another tray: TEST-BC-5, TEST-BC-6.",
    );
  });

  it("goes by each tray's latest count, so a clean recount clears it", async () => {
    const s = store();
    await s.send("inventory.tray_counted", trayCount("Tray A1", { missing: [{ tag: "TEST-BC-2" }] }), "2026-09-30T21:00:00Z");
    await s.send("inventory.tray_counted", trayCount("Tray A1"), "2026-10-01T21:00:00Z");
    await s.send("inventory.tray_counted", trayCount("Tray B1"), "2026-09-30T21:00:00Z");
    await s.send("inventory.tray_counted", trayCount("Tray B1", { missing: [{ tag: "TEST-BC-9" }] }), "2026-10-01T21:00:00Z");
    const recs = await s.ask(NOW);
    expect(about(recs, "Tray A1")).toEqual([]);
    expect(about(recs, "Tray B1")).toHaveLength(1);
  });

  it("dead-letters a count that doesn't say which tray", async () => {
    const s = store();
    await expect(s.send("inventory.tray_counted", trayCount(""))).rejects.toThrow();
    await expect(s.send("inventory.tray_counted", trayCount("Tray A1", { countedAt: "last night" }))).rejects.toThrow();
  });
});

describe("clienteling", () => {
  const profile = (customerId: string, marketingConsent = true) => ({ customerId, name: `Customer ${customerId}`, marketingConsent });

  it("reminds staff about upcoming occasions and mentions the wish list", async () => {
    const s = store();
    await s.send("customer.profile_updated", profile("c1"));
    await s.send("customer.occasion_recorded", { customerId: "c1", occasion: "anniversary", month: 10, day: 12, forPerson: "wife" });
    await s.send("wishlist.item_added", { customerId: "c1", sku: "PEND-9" });
    const [rec] = about(await s.ask(NOW), "anniversary");
    expect(rec!.summary).toBe("Customer c1's anniversary (wife) is in 10 days. Reach out; their wish list has PEND-9.");
    expect(rec!.confidence).toBe(0.8);
  });

  it("respects marketing consent and the 21-day window", async () => {
    const s = store();
    await s.send("customer.profile_updated", profile("c1", false));
    await s.send("customer.occasion_recorded", { customerId: "c1", occasion: "birthday", month: 10, day: 5 });
    await s.send("customer.profile_updated", profile("c2"));
    await s.send("customer.occasion_recorded", { customerId: "c2", occasion: "birthday", month: 12, day: 25 });
    expect(await s.ask(NOW)).toEqual([]);
  });

  it("finds big spenders who have gone quiet", async () => {
    const s = store();
    await s.send("customer.profile_updated", profile("vip"));
    await s.send("sale.completed", sale("S1", "BRACELET-1", { customerId: "vip", price: 600_000 }), "2025-06-01T00:00:00Z");
    const [rec] = about(await s.ask(NOW), "hasn't bought");
    expect(rec!.summary).toBe("Customer vip has spent $6,000.00 with you but hasn't bought in 488 days. Invite them in personally.");
  });

  const callFrom = (contactRef: string, status: string, extra: Record<string, unknown> = {}) => ({
    callId: `call-${contactRef}-${status}-${JSON.stringify(extra)}`,
    contactRef,
    direction: "inbound",
    status,
    ...(["busy", "no-answer", "canceled"].includes(status) ? { missed: true } : {}),
    ...extra,
  });

  it("flags callers who couldn't get through until someone calls or texts them back", async () => {
    const s = store();
    await s.send("communication.call_logged", callFrom("c1", "no-answer"), "2026-09-28T15:00:00Z");
    await s.send("communication.call_logged", callFrom("c1", "busy"), "2026-09-29T15:00:00Z");
    await s.send("communication.call_logged", callFrom("c2", "canceled"), "2026-10-01T15:00:00Z");
    // c3 was texted back, c4 called back, c5 got through later; none of them count.
    await s.send("communication.call_logged", callFrom("c3", "no-answer"), "2026-09-30T15:00:00Z");
    await s.send("communication.message_logged", { messageId: "m1", contactRef: "c3", direction: "outbound" }, "2026-09-30T16:00:00Z");
    await s.send("communication.call_logged", callFrom("c4", "no-answer"), "2026-09-30T15:00:00Z");
    await s.send("communication.call_logged", callFrom("c4", "no-answer", { direction: "outbound" }), "2026-09-30T17:00:00Z");
    await s.send("communication.call_logged", callFrom("c5", "busy"), "2026-09-30T15:00:00Z");
    await s.send("communication.call_logged", callFrom("c5", "completed", { durationSeconds: 120 }), "2026-10-01T09:00:00Z");
    const [rec, ...rest] = about(await s.ask(NOW), "rang the store");
    expect(rest).toEqual([]);
    expect(rec!.summary).toBe(
      "2 callers rang the store 3 times in the last 7 days without getting through, and nobody has called or texted them back. The oldest missed call was 4 days ago. Return them from the call log.",
    );
    expect(rec!.provenance.signalIds).toHaveLength(3);
  });

  it("doesn't count what came before the missed call, inbound texts, unconnected calls, or calls outside the week", async () => {
    const s = store();
    await s.send("communication.message_logged", { messageId: "m1", contactRef: "c1", direction: "outbound" }, "2026-09-30T10:00:00Z");
    await s.send("communication.call_logged", callFrom("c1", "completed"), "2026-09-30T11:00:00Z");
    await s.send("communication.call_logged", callFrom("c1", "no-answer"), "2026-09-30T12:00:00Z");
    await s.send("communication.message_logged", { messageId: "m2", contactRef: "c1", direction: "inbound" }, "2026-09-30T13:00:00Z");
    // An inbound call still ringing, or one that failed, isn't getting through.
    await s.send("communication.call_logged", callFrom("c1", "ringing"), "2026-09-30T14:00:00Z");
    await s.send("communication.call_logged", callFrom("c1", "failed"), "2026-09-30T14:30:00Z");
    await s.send("communication.call_logged", callFrom("c2", "no-answer"), "2026-09-25T14:59:59Z");
    await s.send("communication.call_logged", callFrom("c3", "no-answer"), "2026-10-03T00:00:00Z");
    expect(about(await s.ask(NOW), "rang the store").map((r) => r.summary)).toEqual([
      "1 caller rang the store once in the last 7 days without getting through, and nobody has called or texted them back. The oldest missed call was 2 days ago. Return them from the call log.",
    ]);
    // A call back that didn't connect still counts as trying.
    await s.send("communication.call_logged", callFrom("c1", "failed", { direction: "outbound" }), "2026-10-01T09:00:00Z");
    expect(about(await s.ask(NOW), "rang the store")).toEqual([]);
  });

  it("says today and yesterday, ignores calls with no contact, and accepts other channels' messages", async () => {
    const s = store();
    await s.send("communication.call_logged", callFrom("c1", "busy"), "2026-10-02T09:00:00Z");
    await s.send("communication.call_logged", { callId: "anon", direction: "inbound", status: "no-answer", missed: true }, "2026-10-02T09:00:00Z");
    await s.send("communication.message_logged", { messageId: "slack:message:1", channel: "slack", conversationId: "slack:channel:1" }, "2026-10-02T09:00:00Z");
    await s.send("communication.message_logged", { messageId: "gmail:message:1", channel: "email", direction: "sent" }, "2026-10-02T09:00:00Z");
    expect(about(await s.ask(NOW), "rang the store")[0]!.summary).toContain("1 caller rang the store once in the last 7 days");
    expect(about(await s.ask(NOW), "rang the store")[0]!.summary).toContain("The oldest missed call was today.");
    const t = store();
    await t.send("communication.call_logged", callFrom("c1", "busy"), "2026-10-01T09:00:00Z");
    expect(about(await t.ask(NOW), "rang the store")[0]!.summary).toContain("The oldest missed call was yesterday.");
    await expect(t.send("communication.call_logged", { callId: "x", direction: "sideways", status: "busy" })).rejects.toThrow(/dead-lettered/);
  });
});

describe("repairs", () => {
  const ticket = { ticketId: "R1", customerId: "c1", itemDescription: "Engagement ring", work: "Retip prongs", promisedBy: "2026-09-25", estimateCents: 8_500 };

  it("flags late repairs", async () => {
    const s = store();
    await s.send("repair.received", ticket, "2026-09-18T00:00:00Z");
    await s.send("repair.status_changed", { ticketId: "R1", status: "sent_out" }, "2026-09-19T00:00:00Z");
    const [rec] = about(await s.ask(NOW), "R1");
    expect(rec!.summary).toBe("Repair R1 (Engagement ring) is 7 days past its promised date and still sent out. Call the customer with an update today.");
  });

  it("reminds about pickups, then escalates long-unclaimed items", async () => {
    const s = store();
    await s.send("repair.received", ticket, "2026-01-01T00:00:00Z");
    await s.send("repair.status_changed", { ticketId: "R1", status: "ready" }, "2026-08-15T00:00:00Z");
    expect(about(await s.ask(NOW), "Remind the customer")).toHaveLength(1);
    expect(about(await s.ask("2027-03-01T00:00:00.000Z"), "unclaimed property")).toHaveLength(1);
  });

  it("stays quiet for on-time and finished repairs", async () => {
    const s = store();
    await s.send("repair.received", { ...ticket, promisedBy: "2026-10-10" });
    await s.send("repair.received", { ...ticket, ticketId: "R2" }, "2026-09-01T00:00:00Z");
    await s.send("repair.status_changed", { ticketId: "R2", status: "picked_up" }, "2026-09-20T00:00:00Z");
    expect(await s.ask(NOW)).toEqual([]);
  });
});

describe("custom orders", () => {
  const order = { orderId: "CO1", customerId: "c1", description: "Custom halo ring", quotedCents: 450_000, dueBy: "2026-10-06" };

  it("flags stalled work and orders at risk of missing their date", async () => {
    const s = store();
    await s.send("custom_order.created", order, "2026-09-01T00:00:00Z");
    await s.send("custom_order.stage_changed", { orderId: "CO1", stage: "casting" }, "2026-09-10T00:00:00Z");
    const recs = await s.ask(NOW);
    expect(about(recs, "in casting for 22 days")).toHaveLength(1);
    expect(about(recs, "due in 4 days but is only at casting")).toHaveLength(1);
  });

  it("asks to collect the balance when the piece is ready", async () => {
    const s = store();
    await s.send("custom_order.created", order, "2026-09-01T00:00:00Z");
    await s.send("custom_order.payment_received", { orderId: "CO1", amountCents: 225_000 }, "2026-09-01T00:00:00Z");
    await s.send("custom_order.stage_changed", { orderId: "CO1", stage: "ready" }, "2026-10-01T00:00:00Z");
    const recs = await s.ask(NOW);
    expect(recs.map((r) => r.summary)).toEqual([
      "Custom order CO1 is ready with $2,250.00 still due. Collect the balance when the customer picks it up.",
    ]);
  });
});

describe("appraisals", () => {
  it("offers updates on insurance appraisals older than 3 years", async () => {
    const s = store();
    const base = { customerId: "c1", itemDescription: "Diamond solitaire", appraisedValueCents: 1_200_000 };
    await s.send("appraisal.completed", { ...base, appraisalId: "A1", purpose: "insurance" }, "2022-06-01T00:00:00Z");
    await s.send("appraisal.completed", { ...base, appraisalId: "A2", purpose: "estate" }, "2020-06-01T00:00:00Z");
    await s.send("appraisal.completed", { ...base, appraisalId: "A3", purpose: "insurance" }, "2025-06-01T00:00:00Z");
    const recs = await s.ask(NOW);
    expect(recs.map((r) => r.summary)).toEqual([
      "The insurance appraisal for Diamond solitaire ($12,000.00) is 4 years old. Offer the customer an update so they aren't underinsured.",
    ]);
  });
});

describe("buying", () => {
  const memo = { memoId: "M1", vendorId: "acme-diamonds", sku: "SOL-1", costCents: 300_000, dueBack: "2026-10-10" };

  it("tells you to settle memo goods that sold", async () => {
    const s = store();
    await s.send("memo.received", memo, "2026-08-01T00:00:00Z");
    await s.send("sale.completed", sale("S1", "SOL-1"), "2026-09-15T00:00:00Z");
    const [rec] = about(await s.ask(NOW), "Memo M1");
    expect(rec!.summary).toContain("is due back in 8 days. It has sold, so settle the memo and pay $3,000.00.");
  });

  it("tells you to return or buy unsold memo goods, and ignores settled ones", async () => {
    const s = store();
    await s.send("memo.received", memo, "2026-08-01T00:00:00Z");
    await s.send("memo.received", { ...memo, memoId: "M2", sku: "SOL-2" }, "2026-08-01T00:00:00Z");
    await s.send("memo.settled", { memoId: "M2", outcome: "returned" }, "2026-09-01T00:00:00Z");
    const recs = await s.ask(NOW);
    expect(recs.map((r) => r.summary)).toEqual([
      "Memo M1 (SOL-1) from acme-diamonds is due back in 8 days. It hasn't sold. Return it, or buy it for $3,000.00 if you want to keep it.",
    ]);
  });

  it("chases late purchase orders", async () => {
    const s = store();
    await s.send("purchase_order.created", { poId: "PO1", vendorId: "v1", expectedBy: "2026-09-20", totalCents: 80_000 }, "2026-09-01T00:00:00Z");
    await s.send("purchase_order.created", { poId: "PO2", vendorId: "v1", expectedBy: "2026-09-20", totalCents: 80_000 }, "2026-09-01T00:00:00Z");
    await s.send("purchase_order.received", { poId: "PO2" }, "2026-09-19T00:00:00Z");
    const recs = await s.ask(NOW);
    expect(recs.map((r) => r.summary)).toEqual(["Purchase order PO1 from v1 ($800.00) is 12 days late. Follow up with the vendor."]);
  });

  const offer = (dealerRef: string, side: "selling" | "looking_for", extra: Record<string, unknown> = {}) => ({
    offerId: `${dealerRef}-${side}-${JSON.stringify(extra)}`,
    side,
    brand: "Rolex",
    reference: "126610LN",
    dealerRef,
    group: "Test Group",
    ...extra,
  });

  it("says when several dealers are hunting the same reference, with the lowest ask in the groups", async () => {
    const s = store();
    for (const d of ["d1", "d2", "d3"]) await s.send("watch_market.offer_seen", offer(d, "looking_for"), "2026-09-25T00:00:00Z");
    // The same dealer asking twice counts once.
    await s.send("watch_market.offer_seen", offer("d3", "looking_for", { year: 2024 }), "2026-09-26T00:00:00Z");
    await s.send("watch_market.offer_seen", offer("d4", "selling", { priceMinor: 1_450_000, currency: "USD" }), "2026-09-27T00:00:00Z");
    await s.send("watch_market.offer_seen", offer("d5", "selling", { priceMinor: 1_390_000, currency: "USD" }), "2026-09-28T00:00:00Z");
    await s.send("watch_market.offer_seen", offer("d6", "selling", { priceMinor: 1_200_000, currency: "EUR" }), "2026-09-28T00:00:00Z");
    await s.send("watch_market.offer_seen", offer("d7", "selling"), "2026-09-28T00:00:00Z");
    // What a buyer offers to pay is not an ask.
    await s.send("watch_market.offer_seen", offer("d1", "looking_for", { priceMinor: 1_000_000, currency: "USD" }), "2026-09-28T00:00:00Z");
    const [rec, ...rest] = about(await s.ask(NOW), "126610LN");
    expect(rest).toEqual([]);
    expect(rec!.summary).toBe(
      "3 dealers in your WhatsApp groups have asked for the Rolex 126610LN in the last 14 days. Dealers in the same groups are asking from $13,900.00 (lowest of 2 asks). If you have one, or can source one, offer it to them.",
    );
    expect(rec!.provenance.eventIds).toHaveLength(9);
  });

  it("names the asking price in the currency most dealers use, and leaves it out when nobody is selling", async () => {
    const s = store();
    for (const d of ["d1", "d2", "d3"]) await s.send("watch_market.offer_seen", offer(d, "looking_for", { brand: "Patek Philippe", reference: "5711/1A-010" }), "2026-09-25T00:00:00Z");
    await s.send("watch_market.offer_seen", offer("d4", "selling", { brand: "Patek Philippe", reference: "5711/1A-010", priceMinor: 105_000_000, currency: "HKD" }), "2026-09-25T00:00:00Z");
    for (const d of ["d1", "d2", "d3"]) await s.send("watch_market.offer_seen", offer(d, "looking_for", { reference: "116500LN" }), "2026-09-25T00:00:00Z");
    const recs = (await s.ask(NOW)).map((r) => r.summary);
    expect(recs).toEqual([
      "3 dealers in your WhatsApp groups have asked for the Patek Philippe 5711/1A-010 in the last 14 days. Dealers in the same groups are asking from HK$1,050,000.00 (lowest of 1 ask). If you have one, or can source one, offer it to them.",
      "3 dealers in your WhatsApp groups have asked for the Rolex 116500LN in the last 14 days. If you have one, or can source one, offer it to them.",
    ]);
  });

  it("ignores references too few dealers want, and asks older than 14 days or still to come", async () => {
    const s = store();
    await s.send("watch_market.offer_seen", offer("d1", "looking_for"), "2026-09-18T15:00:01Z");
    await s.send("watch_market.offer_seen", offer("d2", "looking_for"), "2026-09-30T00:00:00Z");
    await s.send("watch_market.offer_seen", offer("d3", "looking_for"), "2026-09-18T14:59:59Z");
    await s.send("watch_market.offer_seen", offer("d4", "looking_for"), "2026-10-03T00:00:00Z");
    for (const d of ["d5", "d6", "d7"]) await s.send("watch_market.offer_seen", offer(d, "selling", { reference: "116500LN" }), "2026-09-30T00:00:00Z");
    expect(about(await s.ask(NOW), "dealers")).toEqual([]);
    await s.send("watch_market.offer_seen", offer("d8", "looking_for"), "2026-10-01T00:00:00Z");
    expect(about(await s.ask(NOW), "dealers")).toHaveLength(1);
  });

  it("dead-letters an offer whose price has no currency", async () => {
    const s = store();
    await expect(s.send("watch_market.offer_seen", offer("d1", "selling", { priceMinor: 1_450_000 }))).rejects.toThrow(/dead-lettered/);
    await expect(s.send("watch_market.offer_seen", offer("d1", "selling", { currency: "USD" }))).rejects.toThrow(/dead-lettered/);
    expect(s.memory.deadLetters.map((d) => d.issues.map((i) => i.message))).toEqual([["a price needs its currency, and a currency its price"], ["a price needs its currency, and a currency its price"]]);
  });
});

describe("metals", () => {
  it("calls out big moves in spot price", async () => {
    const s = store();
    await s.send("inventory.received", received("G1", { metal: "gold", karat: 18, weightGrams: 5 }), "2026-09-01T00:00:00Z");
    await s.send("metal.price_updated", { metal: "gold", spotPerTroyOunceCents: 250_000 }, "2026-09-01T00:00:00Z");
    await s.send("metal.price_updated", { metal: "gold", spotPerTroyOunceCents: 265_000 }, "2026-10-01T00:00:00Z");
    await s.send("metal.price_updated", { metal: "silver", spotPerTroyOunceCents: 3_000 }, "2026-09-01T00:00:00Z");
    await s.send("metal.price_updated", { metal: "silver", spotPerTroyOunceCents: 3_050 }, "2026-10-01T00:00:00Z");
    const recs = about(await s.ask(NOW), "per ounce");
    expect(recs.map((r) => r.summary)).toEqual([
      "Gold is up 6% ($2,500.00 to $2,650.00 per ounce). Review prices on 1 gold pieces and your buy-from-public rates.",
    ]);
  });

  it("flags gold bought too close to melt value", async () => {
    const s = store();
    await s.send("metal.price_updated", { metal: "gold", spotPerTroyOunceCents: 250_000 }, "2026-09-01T00:00:00Z");
    const purchase = (purchaseId: string, paidCents: number) => ({
      purchaseId,
      sellerId: "p1",
      items: [{ description: "14k chain", metal: "gold", karat: 14, weightGrams: 31.1034768 }],
      paidCents,
      paymentMethod: "check",
      sellerIdVerified: true,
    });
    // Melt is $1,458.33; 85% of that is $1,239.58.
    await s.send("gold_purchase.completed", purchase("GP1", 140_000), "2026-09-02T00:00:00Z");
    await s.send("gold_purchase.completed", purchase("GP2", 110_000), "2026-09-02T00:00:00Z");
    const recs = await s.ask(NOW);
    expect(recs.map((r) => r.summary)).toEqual([
      "Gold purchase GP1 paid $1,400.00 for metal worth about $1,458.33 at spot (96%). Check your buy rates and scale calibration.",
    ]);
  });
});

describe("metals: refiner settlements", () => {
  const line = (lot: string, over: Record<string, unknown> = {}) => ({
    lineId: `refiner:test_refinery:${lot}:gold:0`,
    refiner: "test_refinery",
    lot,
    settledOn: "2026-09-10",
    metal: "gold",
    meltGrams: 100,
    fineness: 0.585,
    fineGrams: 58.5,
    fineTroyOunces: 1.8808,
    creditCents: 470_000,
    fineWeightCheck: "matches",
    expectedFineGrams: 58.5,
    currency: "USD",
    ...over,
  });
  const spot = (s: ReturnType<typeof store>, cents: number, at: string) => s.send("metal.price_updated", { metal: "gold", spotPerTroyOunceCents: cents }, at);

  it("asks for a recheck when a lot is credited less fine metal than its weight and assay", async () => {
    const s = store();
    await s.send("refining.settlement_line_imported", line("TEST-LOT-1", { fineGrams: 55, fineWeightCheck: "differs" }), "2026-09-10T00:00:00Z");
    await s.send("refining.settlement_line_imported", line("TEST-LOT-2", { fineGrams: 60, fineWeightCheck: "differs" }), "2026-09-10T00:00:00Z");
    await s.send("refining.settlement_line_imported", line("TEST-LOT-3"), "2026-09-10T00:00:00Z");
    const recs = about(await s.ask(NOW), "recheck");
    expect(recs.map((r) => r.summary)).toEqual([
      "Lot TEST-LOT-1 from test_refinery credits 55.00 g of fine gold, but 100.00 g at 58.5% is 58.50 g. Ask the refiner to recheck the assay on the 3.50 g short.",
    ]);
  });

  it("follows a corrected statement, so a lot fixed since stops being flagged", async () => {
    const s = store();
    await s.send("refining.settlement_line_imported", line("TEST-LOT-1", { fineGrams: 55, fineWeightCheck: "differs" }), "2026-09-10T00:00:00Z");
    await s.send("refining.settlement_line_imported", line("TEST-LOT-1"), "2026-09-11T00:00:00Z");
    expect(about(await s.ask(NOW), "recheck")).toEqual([]);
  });

  it("compares what a lot paid per fine ounce with spot on the day it settled", async () => {
    const s = store();
    await spot(s, 270_000, "2026-09-09T21:00:00Z");
    // $4,700 for 1.8808 oz is $2,498.94, 92.6% of spot: fine.
    await s.send("refining.settlement_line_imported", line("TEST-LOT-1"), "2026-09-10T00:00:00Z");
    await s.send("refining.settlement_line_imported", line("TEST-LOT-2", { creditCents: 420_000, feeCents: 9_000 }), "2026-09-10T00:00:00Z");
    await s.send("refining.settlement_line_imported", line("TEST-LOT-3", { creditCents: 420_000 }), "2026-09-10T00:00:00Z");
    // Spot moved after these settled; the later price isn't the one they settled against.
    await spot(s, 200_000, "2026-09-20T21:00:00Z");
    const recs = about(await s.ask(NOW), "second quote");
    expect(recs.map((r) => r.summary)).toEqual([
      "Lot TEST-LOT-2 from test_refinery paid $4,200.00 for 1.8808 oz of fine gold, 82.7% of spot on 2026-09-10, before $90.00 in fees. Get a second quote on payable rates and fees.",
      "Lot TEST-LOT-3 from test_refinery paid $4,200.00 for 1.8808 oz of fine gold, 82.7% of spot on 2026-09-10. Get a second quote on payable rates and fees.",
    ]);
  });

  it("says nothing about payable rates without a credit or a spot price from that week", async () => {
    const s = store();
    await spot(s, 270_000, "2026-09-01T21:00:00Z");
    await s.send("refining.settlement_line_imported", line("TEST-LOT-1", { creditCents: 100_000 }), "2026-09-10T00:00:00Z");
    await s.send("refining.settlement_line_imported", line("TEST-LOT-2", { creditCents: undefined, settledOn: "2026-09-02" }), "2026-09-02T00:00:00Z");
    await s.send("refining.settlement_line_imported", line("TEST-LOT-3", { creditCents: 0, settledOn: "2026-09-02" }), "2026-09-02T00:00:00Z");
    expect(about(await s.ask(NOW), "second quote")).toEqual([]);
  });

  it("dead-letters a settlement line missing its lot or fine metal", async () => {
    const s = store();
    await expect(s.send("refining.settlement_line_imported", line("TEST-LOT-1", { lot: null }))).rejects.toThrow(/dead-lettered/);
    await expect(s.send("refining.settlement_line_imported", line("TEST-LOT-1", { fineGrams: null }))).rejects.toThrow(/dead-lettered/);
    await expect(s.send("refining.settlement_line_imported", line("TEST-LOT-1", { fineness: 1.2 }))).rejects.toThrow(/dead-lettered/);
    expect(s.memory.deadLetters).toHaveLength(3);
  });
});

describe("compliance", () => {
  it("reminds you to file Form 8300 for cash over $10,000", async () => {
    const s = store();
    await s.send("sale.completed", sale("S1", "ROLEX-1", { price: 1_200_000, cash: 1_050_000, customerId: "c1" }), "2026-09-28T15:00:00Z");
    const [rec] = about(await s.ask(NOW), "Form 8300");
    expect(rec!.summary).toBe("$10,500.00 in cash was received for sale S1. File IRS Form 8300 within 11 days and keep a copy for 5 years.");
  });

  it("adds up related cash payments from the same customer within 24 hours", async () => {
    const s = store();
    await s.send("sale.completed", sale("S1", "A", { price: 600_000, cash: 600_000, customerId: "c1" }), "2026-09-28T10:00:00Z");
    await s.send("sale.completed", sale("S2", "B", { price: 500_000, cash: 500_000, customerId: "c1" }), "2026-09-28T20:00:00Z");
    await s.send("sale.completed", sale("S3", "C", { price: 900_000, cash: 900_000 }), "2026-09-28T11:00:00Z");
    await s.send("sale.completed", sale("S4", "D", { price: 900_000, cash: 900_000 }), "2026-09-28T12:00:00Z");
    const recs = about(await s.ask(NOW), "Form 8300");
    expect(recs.map((r) => r.summary)).toEqual([
      "$11,000.00 in cash was received for sale S1, S2. File IRS Form 8300 within 11 days and keep a copy for 5 years.",
    ]);
  });

  it("watches for cash split to stay under $10,000", async () => {
    const s = store();
    await s.send("sale.completed", sale("S1", "A", { price: 600_000, cash: 600_000, customerId: "c9" }), "2026-09-05T10:00:00Z");
    await s.send("sale.completed", sale("S2", "B", { price: 600_000, cash: 600_000, customerId: "c9" }), "2026-09-20T10:00:00Z");
    const recs = about(await s.ask(NOW), "AML");
    expect(recs).toHaveLength(1);
    expect(recs[0]!.summary).toContain("Customer c9 paid $12,000.00 in cash across 2 payments");
  });

  const filing = (overrides: Record<string, unknown> = {}) => ({
    filingId: "7700124",
    filedOn: "2026-09-30",
    cashReceivedOn: "2026-09-28",
    saleIds: ["S1"],
    cashCents: 1_050_000,
    status: "submitted",
    trackingId: "7700124",
    customerId: "c1",
    ...overrides,
  });

  it("stops the Form 8300 reminder once the filings log covers the sale", async () => {
    const s = store();
    await s.send("sale.completed", sale("S1", "ROLEX-1", { price: 1_200_000, cash: 1_050_000, customerId: "c1" }), "2026-09-28T15:00:00Z");
    await s.send("sale.completed", sale("S9", "ROLEX-2", { price: 1_200_000, cash: 1_100_000 }), "2026-09-28T16:00:00Z");
    await s.send("compliance.form_8300_filing_recorded", filing(), "2026-09-30T00:00:00Z");
    expect(about(await s.ask(NOW), "Form 8300").map((r) => r.summary)).toEqual([
      "$11,000.00 in cash was received for sale S9. File IRS Form 8300 within 12 days and keep a copy for 5 years.",
    ]);
  });

  it("matches the receipt number in the log to the POS connector's full sale id", async () => {
    const s = store();
    await s.send("sale.completed", sale("pos:generic:sale:S-4015", "RING", { price: 1_490_000, cash: 1_490_000, customerId: "c7" }), "2026-09-28T15:00:00Z");
    await s.send("sale.completed", sale("pos:generic:sale:AS-4015", "RING", { price: 1_490_000, cash: 1_490_000, customerId: "c8" }), "2026-09-28T15:00:00Z");
    await s.send("compliance.form_8300_filing_recorded", filing({ saleIds: ["S-4015"], customerId: "c7" }), "2026-09-30T00:00:00Z");
    expect(about(await s.ask(NOW), "File IRS Form 8300").map((r) => r.summary)).toEqual([
      "$14,900.00 in cash was received for sale pos:generic:sale:AS-4015. File IRS Form 8300 within 11 days and keep a copy for 5 years.",
    ]);
  });

  it("raises the reminder again when FinCEN rejects the filing, until a new one is accepted", async () => {
    const s = store();
    await s.send("sale.completed", sale("S1", "ROLEX-1", { price: 1_200_000, cash: 1_050_000, customerId: "c1" }), "2026-09-28T15:00:00Z");
    await s.send("compliance.form_8300_filing_recorded", filing(), "2026-09-30T00:00:00Z");
    await s.send("compliance.form_8300_filing_recorded", filing({ status: "rejected" }), "2026-09-30T00:00:00Z");
    // A later "submitted" row for the same tracking ID doesn't undo the rejection.
    await s.send("compliance.form_8300_filing_recorded", filing({ statementSentOn: "2026-10-01" }), "2026-09-30T00:00:00Z");
    const [rec] = about(await s.ask(NOW), "Form 8300");
    expect(rec!.summary).toBe("FinCEN rejected the Form 8300 for sale S1 (BSA Tracking ID 7700124). Correct it and file again within 11 days, then add the new filing to the log.");
    expect(rec!.provenance.signalIds.some((id) => id.startsWith("sig_compliance.form_8300_filing_"))).toBe(true);
    await s.send("compliance.form_8300_filing_recorded", filing({ filingId: "31000000123465", bsaId: "31000000123465", trackingId: "7700199", status: "accepted" }), "2026-10-01T00:00:00Z");
    expect(about(await s.ask(NOW), "Form 8300")).toEqual([]);
  });

  it("reminds you to send each customer their Form 8300 statement by January 31", async () => {
    const s = store();
    await s.send("compliance.form_8300_filing_recorded", filing({ status: "accepted", bsaId: "31000000123457", filingId: "31000000123457" }), "2026-09-30T00:00:00Z");
    await s.send("compliance.form_8300_filing_recorded", filing({ filingId: "7700125", trackingId: "7700125", saleIds: ["S2"], customerId: undefined, cashCents: 1_200_000 }), "2026-09-30T00:00:00Z");
    await s.send("compliance.form_8300_filing_recorded", filing({ filingId: "7700126", trackingId: "7700126", saleIds: ["S3"], statementSentOn: "2026-10-01" }), "2026-09-30T00:00:00Z");
    await s.send("compliance.form_8300_filing_recorded", filing({ filingId: "7700127", trackingId: "7700127", saleIds: ["S4"], status: "rejected" }), "2026-09-30T00:00:00Z");
    // Filed voluntarily as suspicious, or for $10,000 or less: the customer must not be told.
    await s.send("compliance.form_8300_filing_recorded", filing({ filingId: "7700128", trackingId: "7700128", saleIds: ["S5"], suspicious: true }), "2026-09-30T00:00:00Z");
    await s.send("compliance.form_8300_filing_recorded", filing({ filingId: "7700129", trackingId: "7700129", saleIds: ["S6"], cashCents: 1_000_000 }), "2026-09-30T00:00:00Z");
    // The log saved again with the statement sent: the newer row doesn't need a higher status to count.
    await s.send("compliance.form_8300_filing_recorded", filing({ filingId: "7700130", trackingId: "7700130", saleIds: ["S7"] }), "2026-09-30T00:00:00Z");
    await s.send("compliance.form_8300_filing_recorded", filing({ filingId: "7700130", trackingId: "7700130", saleIds: ["S7"], statementSentOn: "2026-10-01" }), "2026-09-30T00:00:00Z");
    // Too early in the year to be worth a reminder.
    expect(about(await s.ask(NOW), "statement")).toEqual([]);
    expect(about(await s.ask("2026-11-30T23:00:00.000Z"), "statement")).toEqual([]);
    const january = about(await s.ask("2027-01-10T15:00:00.000Z"), "statement").map((r) => r.summary);
    expect(january).toEqual([
      "Send customer c1 the written Form 8300 statement for sale S1 ($10,500.00 in cash, BSA ID 31000000123457). It is due by January 31, 2027 and must give the store's contact name, phone number and address, the total cash reported, and that it was reported to the IRS. Note the date sent in the log.",
      "Send each person named on it the written Form 8300 statement for sale S2 ($12,000.00 in cash, BSA Tracking ID 7700125). It is due by January 31, 2027 and must give the store's contact name, phone number and address, the total cash reported, and that it was reported to the IRS. Note the date sent in the log.",
    ]);
    expect(about(await s.ask("2026-12-01T00:00:00.000Z"), "statement")).toHaveLength(2);
    expect(about(await s.ask("2027-01-31T23:00:00.000Z"), "is due by January 31, 2027")).toHaveLength(2);
    expect(about(await s.ask("2027-02-01T15:00:00.000Z"), "was due January 31, 2027; send it now")).toHaveLength(2);
    expect(about(await s.ask("2027-12-31T15:00:00.000Z"), "statement")).toHaveLength(2);
    expect(about(await s.ask("2028-01-01T15:00:00.000Z"), "statement")).toEqual([]);
  });

  it("dead-letters a filing row it can't use", async () => {
    const s = store();
    await expect(s.send("compliance.form_8300_filing_recorded", filing({ saleIds: [] }))).rejects.toThrow(/dead-lettered/);
    await expect(s.send("compliance.form_8300_filing_recorded", filing({ status: "lost" }))).rejects.toThrow(/dead-lettered/);
    await expect(s.send("compliance.form_8300_filing_recorded", filing({ filedOn: "09/30/2026" }))).rejects.toThrow(/dead-lettered/);
    expect(s.memory.deadLetters).toHaveLength(3);
  });

  it("requires seller ID on gold bought from the public", async () => {
    const s = store();
    await s.send("gold_purchase.completed", {
      purchaseId: "GP9",
      sellerId: "walk-in",
      items: [{ description: "Class ring", metal: "gold", weightGrams: 12 }],
      paidCents: 30_000,
      paymentMethod: "cash",
      sellerIdVerified: false,
    });
    const recs = about(await s.ask(NOW), "verified ID");
    expect(recs).toHaveLength(1);
  });
});

describe("compliance: diamond warranty statements", () => {
  const line = (documentNumber: string, n: number, over: Record<string, unknown> = {}) => ({
    lineId: `supplier:test_supplier:invoice:${documentNumber}:${n}`,
    supplier: "test_supplier",
    documentType: "invoice",
    documentNumber,
    documentDate: "2026-09-15",
    sku: `TEST-${documentNumber}-${n}`,
    amountCents: 100_000,
    diamond: "natural",
    warrantyStatement: "none",
    kimberleyProcess: false,
    currency: "USD",
    ...over,
  });
  const send = (s: ReturnType<typeof store>, l: ReturnType<typeof line>) => s.send("supplier_invoice.line_imported", l, `${l.documentDate}T00:00:00Z`);

  it("flags each recent document for natural diamonds with no statement, once, counting its diamond lines", async () => {
    const s = store();
    await send(s, line("INV-1", 0));
    await send(s, line("INV-1", 1));
    await send(s, line("INV-1", 2, { diamond: "none" }));
    await send(s, line("M-7", 0, { documentType: "memo", lineId: "supplier:test_supplier:memo:M-7:0" }));
    const recs = about(await s.ask(NOW), "System of Warranties");
    expect(recs.map((r) => r.summary)).toEqual([
      "Invoice INV-1 from test_supplier (2026-09-15) lists 2 natural diamond lines but no System of Warranties statement was found on it. Ask test_supplier for a copy that carries the statement, and keep it with the purchase records.",
      "Memo M-7 from test_supplier (2026-09-15) lists a natural diamond but no System of Warranties statement was found on it. Ask test_supplier for a copy that carries the statement, and keep it with the purchase records.",
    ]);
    expect(recs[0]!.confidence).toBe(0.7);
    expect(recs[0]!.provenance.signalIds).toHaveLength(2);
  });

  it("keeps the same number from two suppliers, or as a memo and an invoice, apart", async () => {
    const s = store();
    await send(s, line("X-1", 0));
    await send(s, line("X-1", 0, { supplier: "other_supplier", lineId: "supplier:other_supplier:invoice:X-1:0" }));
    await send(s, line("X-1", 0, { documentType: "memo", lineId: "supplier:test_supplier:memo:X-1:0" }));
    const recs = about(await s.ask(NOW), "System of Warranties");
    expect(new Set(recs.map((r) => r.id)).size).toBe(3);
  });

  it("says nothing for a document with the statement, lab-grown stones, no diamonds, or one older than 90 days", async () => {
    const s = store();
    await send(s, line("A", 0, { warrantyStatement: "current" }));
    await send(s, line("B", 0, { warrantyStatement: "earlier" }));
    await send(s, line("C", 0, { diamond: "lab_grown" }));
    await send(s, line("D", 0, { diamond: "none" }));
    await send(s, line("E", 0, { documentDate: "2026-07-03" }));
    // 91 days before is too old; 90 is still checked.
    await send(s, line("F", 0, { documentDate: "2026-07-04" }));
    // A statement anywhere on the document covers all of it.
    await send(s, line("G", 0));
    await send(s, line("G", 1, { warrantyStatement: "current" }));
    expect(about(await s.ask(NOW), "System of Warranties").map((r) => r.summary.split(" from")[0])).toEqual(["Invoice F"]);
  });

  it("follows a corrected document, so one that gained its statement stops being flagged", async () => {
    const s = store();
    await s.send("supplier_invoice.line_imported", line("INV-2", 0), "2026-09-15T00:00:00Z");
    await s.send("supplier_invoice.line_imported", line("INV-2", 0, { warrantyStatement: "current" }), "2026-09-16T00:00:00Z");
    expect(about(await s.ask(NOW), "System of Warranties")).toEqual([]);
    // A line read again with a new amount is one line, not two.
    await s.send("supplier_invoice.line_imported", line("INV-3", 0), "2026-09-15T00:00:00Z");
    await s.send("supplier_invoice.line_imported", line("INV-3", 0, { amountCents: 120_000 }), "2026-09-16T00:00:00Z");
    expect(about(await s.ask(NOW), "System of Warranties").map((r) => r.summary)).toEqual([expect.stringContaining("Invoice INV-3 from test_supplier (2026-09-15) lists a natural diamond but")]);
  });

  it("dead-letters a line it can't read", async () => {
    const s = store();
    for (const over of [{ documentType: null }, { documentNumber: "" }, { documentDate: null }, { amountCents: null }, { quantity: null }, { unitCostCents: -1 }, { due: null }, { diamond: "maybe" }, { warrantyStatement: "yes" }, { kimberleyProcess: "no" }, { currency: "usd" }]) {
      await expect(s.send("supplier_invoice.line_imported", line("BAD", 0, over))).rejects.toThrow(/dead-lettered/);
    }
    expect(s.memory.deadLetters).toHaveLength(11);
    await s.send("supplier_invoice.line_imported", line("OK", 0, { quantity: 2, unitCostCents: 0, due: "2026-10-15", terms: "Net 30", stone: "Diamond", description: "Ring", amountCents: -500 }));
  });
});

describe("marketing", () => {
  it("separates campaigns worth repeating from ones losing money", async () => {
    const s = store();
    await s.send("campaign.sent", { campaignId: "C1", name: "Holiday email", channel: "email", costCents: 20_000 }, "2026-09-01T00:00:00Z");
    await s.send("campaign.sale_attributed", { campaignId: "C1", saleId: "S1", revenueCents: 90_000 }, "2026-09-05T00:00:00Z");
    await s.send("campaign.sent", { campaignId: "C2", name: "Billboard", channel: "print", costCents: 300_000 }, "2026-09-01T00:00:00Z");
    await s.send("campaign.sent", { campaignId: "C3", name: "Too new", channel: "instagram", costCents: 10_000 }, "2026-09-30T00:00:00Z");
    const recs = await s.ask(NOW);
    expect(recs.map((r) => r.summary)).toEqual([
      '"Holiday email" (email) returned $900.00 on $200.00, 4.5x. Run it again or scale it up.',
      '"Billboard" (print) returned $0.00 on $3,000.00. Rework or drop it before spending more.',
    ]);
  });
});

describe("finance", () => {
  it("flags cash sales that never reached the bank", async () => {
    const s = store();
    await s.send("sale.completed", sale("S1", "A", { price: 100_000, cash: 100_000 }), "2026-09-20T00:00:00Z");
    await s.send("sale.completed", sale("S2", "B", { price: 50_000, cash: 50_000 }), "2026-10-01T00:00:00Z");
    await s.send(
      "bank.transaction_imported",
      { transactionId: "T1", accountId: "chase-checking", amountCents: 60_000, description: "DEPOSIT", category: "cash_deposit" },
      "2026-09-22T00:00:00Z",
    );
    const [rec] = about(await s.ask(NOW), "cash deposits");
    expect(rec!.summary).toBe("$1,000.00 in cash sales over the last 30 days but only $600.00 in cash deposits. Reconcile the drawer logs and deposits.");
  });

  it("is quiet when deposits match", async () => {
    const s = store();
    await s.send("sale.completed", sale("S1", "A", { price: 100_000, cash: 100_000 }), "2026-09-20T00:00:00Z");
    await s.send(
      "bank.transaction_imported",
      { transactionId: "T1", accountId: "chase-checking", amountCents: 100_000, description: "DEPOSIT", category: "cash_deposit" },
      "2026-09-21T00:00:00Z",
    );
    expect(about(await s.ask(NOW), "cash deposits")).toEqual([]);
  });
});

describe("finance balances and receivables", () => {
  const invoice = (id: string, extra: Record<string, unknown> = {}) => ({
    invoiceId: `quickbooks:invoice:${id}`,
    number: `INV-${id}`,
    customerId: "quickbooks:customer:1",
    txnDate: "2026-07-01",
    dueDate: "2026-08-01",
    totalCents: 40_000,
    balanceCents: 40_000,
    currency: "USD",
    ...extra,
  });

  it("keeps each bank account's balance as a signal, with nothing left out or made up", async () => {
    const s = store();
    await s.send("bank.account_updated", { accountId: "plaid:account:a1", name: "Checking", accountKind: "bank", currentBalanceCents: 1_250_000, availableBalanceCents: 1_200_000, currency: "USD", mask: "0000" });
    await s.send("bank.account_updated", { accountId: "plaid:account:a2", currentBalanceCents: null });
    const balances = s.memory.signals.filter((x) => x.kind === "bank.balance");
    expect(balances.map((x) => [x.subject, x.value])).toEqual([
      [{ kind: "bank_account", id: "plaid:account:a1" }, { accountId: "plaid:account:a1", name: "Checking", accountKind: "bank", currentBalanceCents: 1_250_000, availableBalanceCents: 1_200_000, currency: "USD" }],
      [{ kind: "bank_account", id: "plaid:account:a2" }, { accountId: "plaid:account:a2", currentBalanceCents: null }],
    ]);
  });

  it("keeps each invoice and each deleted invoice as signals, and ignores other deleted records", async () => {
    const s = store();
    await s.send("accounting.invoice_updated", { ...invoice("1"), lines: [{ amountCents: 40_000 }] });
    await s.send("accounting.record_deleted", { recordId: "quickbooks:invoice:1", entity: "invoice" });
    await s.send("accounting.record_deleted", { recordId: "quickbooks:bill:9", entity: "bill" });
    expect(s.memory.signals.filter((x) => x.kind.startsWith("receivable.")).map((x) => [x.kind, x.subject.id, x.value])).toEqual([
      ["receivable.invoice", "quickbooks:invoice:1", invoice("1")],
      ["receivable.removed", "quickbooks:invoice:1", { invoiceId: "quickbooks:invoice:1" }],
    ]);
  });

  it("dead-letters a balance or invoice without an id, or with an amount that isn't whole cents", async () => {
    const s = store();
    await expect(s.send("bank.account_updated", { name: "No id" })).rejects.toThrow();
    await expect(s.send("bank.account_updated", { accountId: "" })).rejects.toThrow();
    await expect(s.send("accounting.invoice_updated", invoice("2", { balanceCents: 12.5 }))).rejects.toThrow();
    await expect(s.send("accounting.record_deleted", { recordId: "x" })).rejects.toThrow();
    expect(s.memory.deadLetters.map((d) => d.issues[0]?.path)).toEqual(["payload.accountId", "payload.accountId", "payload.balanceCents", "payload.entity"]);
  });

  it("asks for follow-up on invoices more than 30 days past due, using the latest word on each", async () => {
    const s = store();
    await s.send("accounting.invoice_updated", invoice("1"), "2026-07-01T00:00:00Z");
    await s.send("accounting.invoice_updated", invoice("2", { balanceCents: 25_000 }), "2026-07-02T00:00:00Z");
    // Paid later, deleted, voided, not yet 30 days late, in another currency, or nothing owed: none count.
    await s.send("accounting.invoice_updated", invoice("3"), "2026-07-03T00:00:00Z");
    await s.send("accounting.invoice_updated", invoice("3", { balanceCents: 0 }), "2026-08-15T00:00:00Z");
    await s.send("accounting.invoice_updated", invoice("4"), "2026-07-04T00:00:00Z");
    await s.send("accounting.record_deleted", { recordId: "quickbooks:invoice:4", entity: "invoice" }, "2026-08-20T00:00:00Z");
    await s.send("accounting.invoice_updated", invoice("5", { status: "voided" }), "2026-07-05T00:00:00Z");
    await s.send("accounting.invoice_updated", invoice("6", { dueDate: "2026-09-03" }), "2026-07-06T00:00:00Z");
    await s.send("accounting.invoice_updated", invoice("7", { currency: "EUR" }), "2026-07-07T00:00:00Z");
    await s.send("accounting.invoice_updated", invoice("8", { dueDate: undefined }), "2026-07-08T00:00:00Z");
    await s.send("accounting.invoice_updated", invoice("9", { dueDate: "August 1" }), "2026-07-09T00:00:00Z");
    const [rec, ...rest] = about(await s.ask(NOW), "past due");
    expect(rest).toEqual([]);
    expect(rec).toMatchObject({
      id: "rec_finance_overdue_receivables_2026-10-02",
      summary: "$650.00 across 2 invoices are more than 30 days past due. Follow up with those customers, oldest first.",
      expectedImpact: "Brings in up to $650.00 owed",
      impact: { kind: "protects", lowCents: 32_500, cents: 52_000, highCents: 61_750, basis: "80% of the $650.00 past due, brought in by following up." },
      confidence: 0.8,
    });
    expect(rec!.provenance.signalIds).toHaveLength(2);
  });

  it("counts an invoice exactly 30 days late, and is quiet under $500", async () => {
    const s = store();
    await s.send("accounting.invoice_updated", invoice("1", { dueDate: "2026-09-02", balanceCents: 50_000 }));
    expect(about(await s.ask(NOW), "past due").map((r) => r.summary)).toEqual(["$500.00 across 1 invoice is more than 30 days past due. Follow up with those customers, oldest first."]);
    const quiet = store();
    await quiet.send("accounting.invoice_updated", invoice("1", { balanceCents: 49_999 }));
    expect(about(await quiet.ask(NOW), "past due")).toEqual([]);
  });
});

const payroll = (n: number, checkDate: string, extra: Record<string, unknown> = {}) => ({
  payrollId: `gusto:payroll:${n}`,
  checkDate,
  payScheduleId: "gusto:pay_schedule:1",
  kind: "regular",
  grossPayCents: 450_000,
  netPayCents: 355_000,
  companyDebitCents: 495_000,
  employeeCount: 2,
  ...extra,
});

describe("finance payroll", () => {
  it("keeps payrolls and each employee's pay as signals, by id only", async () => {
    const s = store();
    await s.send("payroll.payroll_processed", payroll(1, "2026-09-18"));
    await s.send("payroll.employee_paid", { payrollId: "gusto:payroll:1", employeeId: "gusto:employee:e1", checkDate: "2026-09-18", kind: "regular", grossPayCents: 160_000, netPayCents: 122_500, hours: 82.5, overtimeCents: 5_000, commissionCents: 5_000, bonusCents: 0, tipsCents: 0 });
    expect(s.memory.signals.filter((x) => x.kind.startsWith("payroll.")).map((x) => [x.kind, x.subject])).toEqual([
      ["payroll.run", { kind: "payroll", id: "gusto:payroll:1" }],
      ["payroll.employee_pay", { kind: "employee_pay", id: "gusto:payroll:1/gusto:employee:e1" }],
    ]);
  });

  it("dead-letters a payroll with no kind or an amount that isn't whole cents, and employee pay with no employee", async () => {
    const s = store();
    await expect(s.send("payroll.payroll_processed", payroll(1, "2026-09-18", { kind: "bonus" }))).rejects.toThrow();
    await expect(s.send("payroll.payroll_processed", payroll(2, "2026-09-18", { grossPayCents: 10.5 }))).rejects.toThrow();
    await expect(s.send("payroll.employee_paid", { payrollId: "p", kind: "regular", hours: 1, overtimeCents: 0, commissionCents: 0, bonusCents: 0, tipsCents: 0 })).rejects.toThrow();
    expect(s.memory.deadLetters.map((d) => d.issues[0]?.path)).toEqual(["payload.kind", "payload.grossPayCents", "payload.employeeId"]);
  });

  it("asks for a second look at a regular payroll well above the three before it", async () => {
    const s = store();
    await s.send("payroll.payroll_processed", payroll(1, "2026-08-21", { grossPayCents: 450_000 }));
    await s.send("payroll.payroll_processed", payroll(2, "2026-09-04", { grossPayCents: 440_000 }));
    await s.send("payroll.payroll_processed", payroll(3, "2026-09-18", { grossPayCents: 460_000 }));
    await s.send("payroll.payroll_processed", payroll(4, "2026-10-02", { grossPayCents: 620_000 }));
    // An off-cycle bonus run and another pay schedule's payroll don't count toward the average.
    await s.send("payroll.payroll_processed", payroll(5, "2026-09-25", { kind: "off_cycle", grossPayCents: 2_000_000 }));
    await s.send("payroll.payroll_processed", payroll(6, "2026-09-26", { payScheduleId: "gusto:pay_schedule:2", grossPayCents: 10_000 }));
    const [rec, ...rest] = about(await s.ask(NOW), "gross");
    expect(rest).toEqual([]);
    expect(rec).toMatchObject({
      id: "rec_finance_payroll_jump_gusto:payroll:4_2026-10-02",
      summary: "The payroll for 2026-10-02 came to $6,200.00 gross, 38% more than the $4,500.00 average of the 3 before it. Check its hours, overtime, commissions and bonuses before the next payroll runs.",
      expectedImpact: "Catches up to $1,700.00 of payroll errors",
      confidence: 0.6,
    });
    expect(rec!.provenance.signalIds).toHaveLength(4);
  });

  it("uses the latest version of each payroll, and its own pay schedule", async () => {
    const s = store();
    for (const [n, day] of [[1, "2026-08-21"], [2, "2026-09-04"], [3, "2026-09-18"]] as const) await s.send("payroll.payroll_processed", payroll(n, day));
    await s.send("payroll.payroll_processed", payroll(4, "2026-10-02", { grossPayCents: 620_000 }));
    // Gusto corrected it before the check date.
    await s.send("payroll.payroll_processed", payroll(4, "2026-10-02", { grossPayCents: 470_000 }));
    expect(about(await s.ask(NOW), "gross")).toEqual([]);
    // An earlier payroll entered far too high and then corrected counts at its corrected amount.
    const corrected = store();
    for (const [n, day] of [[1, "2026-08-21"], [2, "2026-09-04"]] as const) await corrected.send("payroll.payroll_processed", payroll(n, day));
    await corrected.send("payroll.payroll_processed", payroll(3, "2026-09-18", { grossPayCents: 900_000 }));
    await corrected.send("payroll.payroll_processed", payroll(3, "2026-09-18"));
    await corrected.send("payroll.payroll_processed", payroll(4, "2026-10-02", { grossPayCents: 600_000 }));
    expect(about(await corrected.ask(NOW), "gross").map((r) => r.summary)).toEqual([expect.stringContaining("$6,000.00 gross, 33% more than the $4,500.00 average")]);
    const unscheduled = store();
    for (const n of [1, 2, 3]) await unscheduled.send("payroll.payroll_processed", payroll(n, `2026-09-0${n}`, { payScheduleId: undefined }));
    await unscheduled.send("payroll.payroll_processed", payroll(4, "2026-09-10", { payScheduleId: undefined, grossPayCents: 700_000 }));
    expect(about(await unscheduled.ask(NOW), "gross").map((r) => r.summary)).toEqual([expect.stringContaining("The payroll for 2026-09-10 came to $7,000.00 gross, 56% more")]);
  });

  it("is quiet with fewer than three payrolls before, a rise of 25% or less, under $500 more, or a payroll over 30 days old", async () => {
    const cases: [number[], string][] = [
      [[450_000, 450_000, 900_000], "2026-10-02"],
      [[450_000, 450_000, 450_000, 562_500], "2026-10-02"],
      [[100_000, 100_000, 100_000, 149_999], "2026-10-02"],
      [[450_000, 450_000, 450_000, 900_000], "2026-09-01"],
    ];
    for (const [gross, last] of cases) {
      const s = store();
      for (const [i, cents] of gross.entries()) await s.send("payroll.payroll_processed", payroll(i + 1, i === gross.length - 1 ? last : `2026-08-0${i + 1}`, { grossPayCents: cents }));
      expect(about(await s.ask(NOW), "gross")).toEqual([]);
    }
    // Exactly 30 days old still counts.
    const s = store();
    for (const n of [1, 2, 3]) await s.send("payroll.payroll_processed", payroll(n, `2026-08-0${n}`));
    await s.send("payroll.payroll_processed", payroll(4, "2026-09-02", { grossPayCents: 900_000 }));
    expect(about(await s.ask(NOW), "gross")).toHaveLength(1);
    const missing = store();
    for (const n of [1, 2, 3]) await missing.send("payroll.payroll_processed", payroll(n, `2026-09-0${n}`));
    await missing.send("payroll.payroll_processed", payroll(4, "2026-09-10", { grossPayCents: null }));
    await missing.send("payroll.payroll_processed", payroll(5, undefined as never, { grossPayCents: 900_000 }));
    expect(about(await missing.ask(NOW), "gross")).toEqual([]);
  });
});

describe("overdue wording", () => {
  it("says how overdue memos, custom orders and Form 8300 filings are", async () => {
    const s = store();
    await s.send("memo.received", { memoId: "M1", vendorId: "v", sku: "X", costCents: 100, dueBack: "2026-09-30" }, "2026-08-01T00:00:00Z");
    await s.send("custom_order.created", { orderId: "CO1", customerId: "c", description: "Ring", quotedCents: 100, dueBy: "2026-09-29" }, "2026-09-25T00:00:00Z");
    await s.send("sale.completed", sale("S1", "W", { price: 1_100_000, cash: 1_100_000 }), "2026-09-01T00:00:00Z");
    const summaries = (await s.ask(NOW)).map((r) => r.summary).join("\n");
    expect(summaries).toContain("was due back 2 days ago");
    expect(summaries).toContain("was due 3 days ago but is only at design");
    expect(summaries).toContain("File IRS Form 8300 now (16 days overdue)");
  });
});

describe("entities", () => {
  it("are created for the records each department owns", async () => {
    const s = store();
    await s.send("sale.completed", sale("S1", "A", { customerId: "c1" }));
    await s.send("inventory.received", received("A"));
    await s.send("customer.profile_updated", { customerId: "c1", name: "Ana", marketingConsent: true });
    await s.send("repair.received", { ticketId: "R1", customerId: "c1", itemDescription: "Ring", work: "Size", promisedBy: "2026-10-09", estimateCents: 1 });
    await s.send("custom_order.created", { orderId: "CO1", customerId: "c1", description: "Ring", quotedCents: 100, dueBy: "2026-12-01" });
    await s.send("appraisal.completed", { appraisalId: "AP1", customerId: "c1", itemDescription: "Ring", appraisedValueCents: 100, purpose: "insurance" });
    expect([...s.memory.entities.values()].map((e) => `${e.ref.kind}/${e.ref.id}`).sort()).toEqual([
      "appraisal/AP1",
      "custom_order/CO1",
      "customer/c1",
      "order/S1",
      "product/A",
      "repair_ticket/R1",
    ]);
  });
});
