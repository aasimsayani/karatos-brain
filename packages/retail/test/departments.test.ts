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
