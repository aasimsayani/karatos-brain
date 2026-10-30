import { describe, expect, it } from "vitest";
import { ASSUMPTIONS, estimate, pct } from "../src/index.js";
import { about, store } from "./harness.js";

const NOW = "2026-10-02T15:00:00.000Z";

const sale = (saleId: string, sku: string, opts: { qty?: number; price?: number; customerId?: string; cash?: number } = {}) => {
  const qty = opts.qty ?? 1;
  const price = opts.price ?? 50_000;
  const total = qty * price;
  return {
    saleId,
    channel: "store",
    lines: [{ sku, quantity: qty, unitPriceCents: price }],
    totalCents: total,
    payments: opts.cash
      ? [{ method: "cash", amountCents: opts.cash }, ...(total > opts.cash ? [{ method: "card", amountCents: total - opts.cash }] : [])]
      : [{ method: "card", amountCents: total }],
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

const range = (lowCents: number, cents: number, highCents: number) => ({ lowCents, cents, highCents });

describe("estimate", () => {
  it("works the figure out at the low, likely and high assumptions", () => {
    expect(estimate("makes", "b", (a) => 1_000 * a("margin"))).toEqual({ kind: "makes", basis: "b", ...range(350, 450, 550) });
  });

  it("sorts the range when a figure shrinks as an assumption grows, keeping the likely value", () => {
    expect(estimate("saves", "b", (a) => 300_000 - 10_000 * a("margin"))).toEqual({ kind: "saves", basis: "b", ...range(294_500, 295_500, 296_500) });
  });

  it("rounds to whole cents and counts a loss-making case as zero", () => {
    expect(estimate("makes", "b", (a) => 100.4 + (a("margin") - 0.45) * 1_000)).toMatchObject(range(0, 100, 200));
    expect(estimate("makes", "b", (a) => (a("margin") - 0.45) * 10_000)).toMatchObject(range(0, 0, 1_000));
  });

  it("shows nothing under a dollar, or for a figure that isn't a number", () => {
    expect(estimate("makes", "b", () => 99)).toBeUndefined();
    expect(estimate("makes", "b", () => 100)).toMatchObject(range(100, 100, 100));
    expect(estimate("makes", "b", () => Number.NaN)).toBeUndefined();
    expect(estimate("makes", "b", () => Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("uses likely values that match the website's payback defaults", () => {
    expect(ASSUMPTIONS.margin.likely).toBe(0.45);
    expect(ASSUMPTIONS.averageOrderCents.likely).toBe(150_000);
    expect(ASSUMPTIONS.winBackRate.likely).toBe(0.1);
    expect(ASSUMPTIONS.occasionRate.likely).toBe(0.1);
    expect(ASSUMPTIONS.callCloseRate.likely).toBe(0.15);
    expect(ASSUMPTIONS.carryingRate.likely).toBe(0.2);
    for (const a of Object.values(ASSUMPTIONS)) {
      expect(a.low).toBeLessThanOrEqual(a.likely);
      expect(a.likely).toBeLessThanOrEqual(a.high);
    }
    expect(pct(0.45)).toBe("45%");
    expect(pct(0.827)).toBe("82.7%");
  });
});

describe("dollar estimates on recommendations", () => {
  it("aged stock: a year of carrying cost on what it cost", async () => {
    const s = store();
    await s.send("inventory.received", received("CHAIN-1", { costCents: 50_000, quantity: 2 }), "2025-12-01T12:00:00Z");
    const [rec] = about(await s.ask(NOW), "CHAIN-1");
    expect(rec!.impact).toEqual({
      kind: "saves",
      ...range(15_000, 20_000, 25_000),
      basis: "A year of carrying cost on $1,000.00 of stock at cost, at 20% a year for insurance, capital and case space, saved once it sells or is remade.",
    });
  });

  it("reorder: profit on a month of sales at the recent pace", async () => {
    const s = store();
    await s.send("inventory.received", received("STUD-1", { quantity: 4 }), "2026-08-01T00:00:00Z");
    await s.send("sale.completed", sale("S1", "STUD-1", { qty: 3 }), "2026-09-10T00:00:00Z");
    const [rec] = about(await s.ask(NOW), "Reorder");
    expect(rec!.impact).toEqual({
      kind: "makes",
      ...range(52_500, 67_500, 82_500),
      basis: "Profit on a month of sales at the last 60 days' pace (1.5 a month at $1,000.00) and a 45% margin, which an empty case would miss.",
    });
  });

  describe("clienteling", () => {
    const profile = (customerId: string) => ({ customerId, name: `Customer ${customerId}`, marketingConsent: true });

    it("an occasion: the share of reminders that sell, at an average order", async () => {
      const s = store();
      await s.send("customer.profile_updated", profile("c1"));
      await s.send("customer.occasion_recorded", { customerId: "c1", occasion: "anniversary", month: 10, day: 12 });
      const [rec] = about(await s.ask(NOW), "anniversary");
      expect(rec!.impact).toEqual({
        kind: "makes",
        ...range(1_400, 6_750, 27_500),
        basis: "10% of customers reminded of an occasion buy, at an average order of $1,500.00 and a 45% margin.",
      });
    });

    it("an occasion: the customer's own average order when they have bought before, which joins the provenance", async () => {
      const s = store();
      await s.send("customer.profile_updated", profile("c1"));
      await s.send("customer.profile_updated", profile("c2"));
      await s.send("sale.completed", sale("S1", "A", { customerId: "c1", price: 100_000 }), "2026-03-01T00:00:00Z");
      await s.send("sale.completed", sale("S2", "B", { customerId: "c1", price: 300_000 }), "2026-04-01T00:00:00Z");
      await s.send("sale.completed", sale("S3", "C", { customerId: "c2", price: 900_000 }), "2026-04-01T00:00:00Z");
      await s.send("customer.occasion_recorded", { customerId: "c1", occasion: "birthday", month: 10, day: 12 });
      const [rec] = about(await s.ask(NOW), "birthday");
      expect(rec!.impact).toMatchObject({ ...range(3_500, 9_000, 22_000), basis: expect.stringContaining("at their average order of $2,000.00") });
      expect(rec!.provenance.signalIds.filter((id) => id.startsWith("sig_sale.customer_purchase"))).toHaveLength(2);
    });

    it("a lapsed big spender: the win-back share of their average order", async () => {
      const s = store();
      await s.send("customer.profile_updated", profile("vip"));
      await s.send("sale.completed", sale("S1", "A", { customerId: "vip", price: 400_000 }), "2025-05-01T00:00:00Z");
      await s.send("sale.completed", sale("S2", "B", { customerId: "vip", price: 800_000 }), "2025-06-01T00:00:00Z");
      const [rec] = about(await s.ask(NOW), "hasn't bought");
      expect(rec!.impact).toEqual({
        kind: "makes",
        ...range(10_500, 27_000, 49_500),
        basis: "10% of lapsed customers invited back in person buy, at their average order of $6,000.00 and a 45% margin.",
      });
    });

    it("missed calls: the share of returned calls that sell, per caller", async () => {
      const s = store();
      const missed = (contactRef: string, n: number) => ({ callId: `call-${contactRef}-${n}`, contactRef, direction: "inbound", status: "no-answer", missed: true });
      await s.send("communication.call_logged", missed("c1", 1), "2026-09-30T15:00:00Z");
      await s.send("communication.call_logged", missed("c1", 2), "2026-10-01T15:00:00Z");
      await s.send("communication.call_logged", missed("c2", 1), "2026-10-01T15:00:00Z");
      const [rec] = about(await s.ask(NOW), "rang the store");
      expect(rec!.impact).toEqual({
        kind: "makes",
        ...range(5_600, 20_250, 68_750),
        basis: "15% of returned calls become a sale: 2 callers at an average order of $1,500.00 and a 45% margin.",
      });
    });
  });

  it("returns: the handling cost of the same returns again", async () => {
    const s = store();
    for (let i = 0; i < 4; i++) await s.send("sale.completed", sale(`S${i}`, "RING-1"));
    await s.send("sale.returned", { saleId: "S0", returnId: "X0", lines: [{ sku: "RING-1", quantity: 1, refundCents: 50_000 }] });
    const [one] = about(await s.ask(), "RING-1");
    expect(one!.impact).toEqual({
      kind: "saves",
      ...range(2_000, 4_000, 7_500),
      basis: "Handling 1 return again over the next 4 sold, at $40.00 each for shipping, repacking, card fees and staff time, if the cause is fixed.",
    });
    await s.send("sale.returned", { saleId: "S1", returnId: "X1", lines: [{ sku: "RING-1", quantity: 1, refundCents: 50_000 }] });
    const [two] = about(await s.ask(), "RING-1");
    expect(two!.impact).toMatchObject({ ...range(4_000, 8_000, 15_000), basis: expect.stringMatching(/^Handling 2 returns again/) });
  });

  it("finance: the cash gap in full, and the collectable share of what's past due", async () => {
    const s = store();
    await s.send("sale.completed", sale("S1", "A", { price: 100_000, cash: 100_000 }), "2026-09-20T00:00:00Z");
    await s.send(
      "bank.transaction_imported",
      { transactionId: "T1", accountId: "checking", amountCents: 60_000, description: "DEPOSIT", category: "cash_deposit" },
      "2026-09-22T00:00:00Z",
    );
    const [gap] = about(await s.ask(NOW), "cash deposits");
    expect(gap!.impact).toEqual({ kind: "protects", ...range(40_000, 40_000, 40_000), basis: "The $400.00 of cash sales with no matching deposit." });
  });

  it("appraisals: an update fee times the share who take one", async () => {
    const s = store();
    await s.send(
      "appraisal.completed",
      { customerId: "c1", itemDescription: "Solitaire", appraisedValueCents: 1_200_000, appraisalId: "A1", purpose: "insurance" },
      "2022-06-01T00:00:00Z",
    );
    const [rec] = await s.ask(NOW);
    expect(rec!.impact).toEqual({
      kind: "makes",
      ...range(1_000, 3_000, 7_500),
      basis: "A $100.00 update fee, which is mostly the appraiser's time, taken by 30% of customers offered one.",
    });
  });

  it("repairs: the estimate on a pickup reminder, and no number on a late or unclaimed repair", async () => {
    const s = store();
    const ticket = { ticketId: "R1", customerId: "c1", itemDescription: "Ring", work: "Retip", promisedBy: "2026-09-25", estimateCents: 8_500 };
    await s.send("repair.received", ticket, "2026-01-01T00:00:00Z");
    await s.send("repair.received", { ...ticket, ticketId: "R2" }, "2026-09-18T00:00:00Z");
    await s.send("repair.status_changed", { ticketId: "R1", status: "ready" }, "2026-08-15T00:00:00Z");
    await s.send("repair.status_changed", { ticketId: "R2", status: "at_bench" }, "2026-09-19T00:00:00Z");
    const recs = await s.ask(NOW);
    expect(about(recs, "Remind the customer")[0]!.impact).toEqual({ kind: "protects", ...range(8_500, 8_500, 8_500), basis: "The repair's $85.00 estimate, collected at pickup." });
    expect(about(recs, "past its promised date")[0]!.impact).toBeUndefined();
    expect(about(await s.ask("2027-03-01T00:00:00.000Z"), "unclaimed property")[0]!.impact).toBeUndefined();
  });

  it("custom orders: the balance on a ready piece, and no number on stalled or late work", async () => {
    const s = store();
    await s.send("custom_order.created", { orderId: "CO1", customerId: "c1", description: "Halo", quotedCents: 450_000, dueBy: "2026-10-06" }, "2026-09-01T00:00:00Z");
    await s.send("custom_order.created", { orderId: "CO2", customerId: "c1", description: "Band", quotedCents: 90_000, dueBy: "2026-10-06" }, "2026-09-01T00:00:00Z");
    await s.send("custom_order.payment_received", { orderId: "CO1", amountCents: 225_000 }, "2026-09-01T00:00:00Z");
    await s.send("custom_order.stage_changed", { orderId: "CO1", stage: "ready" }, "2026-10-01T00:00:00Z");
    await s.send("custom_order.stage_changed", { orderId: "CO2", stage: "casting" }, "2026-09-10T00:00:00Z");
    const recs = await s.ask(NOW);
    expect(about(recs, "CO1")[0]!.impact).toEqual({ kind: "protects", ...range(225_000, 225_000, 225_000), basis: "The $2,250.00 balance, collected at pickup." });
    expect(about(recs, "CO2").map((r) => r.impact)).toEqual([undefined, undefined]);
  });

  it("memo goods: the cost of an unsold piece, and no number once it has sold", async () => {
    const s = store();
    const memo = { memoId: "M1", vendorId: "v1", sku: "SOL-1", costCents: 300_000, dueBack: "2026-10-10" };
    await s.send("memo.received", memo, "2026-08-01T00:00:00Z");
    await s.send("memo.received", { ...memo, memoId: "M2", sku: "SOL-2" }, "2026-08-01T00:00:00Z");
    await s.send("sale.completed", sale("S1", "SOL-2"), "2026-09-15T00:00:00Z");
    const recs = await s.ask(NOW);
    expect(about(recs, "Memo M1")[0]!.impact).toEqual({
      kind: "protects",
      ...range(300_000, 300_000, 300_000),
      basis: "The $3,000.00 cost of a piece that hasn't sold, owed if the memo runs past its due date.",
    });
    expect(about(recs, "Memo M2")[0]!.impact).toBeUndefined();
  });

  it("late purchase orders and compliance carry no number", async () => {
    const s = store();
    await s.send("purchase_order.created", { poId: "PO1", vendorId: "v1", expectedBy: "2026-09-20", totalCents: 80_000 }, "2026-09-01T00:00:00Z");
    await s.send("sale.completed", sale("S1", "R", { price: 1_200_000, cash: 1_050_000, customerId: "c1" }), "2026-09-28T15:00:00Z");
    await s.send("sale.completed", sale("S2", "A", { price: 600_000, cash: 600_000, customerId: "c9" }), "2026-09-05T10:00:00Z");
    await s.send("sale.completed", sale("S3", "B", { price: 600_000, cash: 600_000, customerId: "c9" }), "2026-09-20T10:00:00Z");
    await s.send("gold_purchase.completed", {
      purchaseId: "GP9",
      sellerId: "walk-in",
      items: [{ description: "Class ring", metal: "gold", weightGrams: 12 }],
      paidCents: 30_000,
      paymentMethod: "cash",
      sellerIdVerified: false,
    });
    const recs = await s.ask(NOW);
    for (const text of ["Purchase order PO1", "File IRS Form 8300", "AML", "verified ID"]) {
      expect(about(recs, text)).toHaveLength(1);
      expect(about(recs, text)[0]!.impact).toBeUndefined();
    }
  });

  describe("watches", () => {
    const offer = (dealerRef: string, side: "selling" | "looking_for", extra: Record<string, unknown> = {}) => ({
      offerId: `${dealerRef}-${side}-${JSON.stringify(extra)}`,
      side,
      brand: "Rolex",
      reference: "126610LN",
      dealerRef,
      group: "Test Group",
      ...extra,
    });

    it("a dealer margin on the lowest US dollar ask", async () => {
      const s = store();
      for (const d of ["d1", "d2", "d3"]) await s.send("watch_market.offer_seen", offer(d, "looking_for"), "2026-09-25T00:00:00Z");
      await s.send("watch_market.offer_seen", offer("d4", "selling", { priceMinor: 1_450_000, currency: "USD" }), "2026-09-27T00:00:00Z");
      await s.send("watch_market.offer_seen", offer("d5", "selling", { priceMinor: 1_390_000, currency: "USD" }), "2026-09-28T00:00:00Z");
      await s.send("watch_market.offer_seen", offer("d6", "selling", { priceMinor: 900_000, currency: "EUR" }), "2026-09-28T00:00:00Z");
      // A buyer's offer to pay is not an ask.
      await s.send("watch_market.offer_seen", offer("d1", "looking_for", { priceMinor: 1_000_000, currency: "USD" }), "2026-09-28T00:00:00Z");
      const [rec] = about(await s.ask(NOW), "126610LN");
      expect(rec!.impact).toEqual({
        kind: "makes",
        ...range(41_700, 69_500, 139_000),
        basis: "A 5% dealer margin on one sale at the lowest US dollar ask of $13,900.00.",
      });
    });

    it("no number when no dealer is asking in US dollars", async () => {
      const s = store();
      for (const d of ["d1", "d2", "d3"]) await s.send("watch_market.offer_seen", offer(d, "looking_for"), "2026-09-25T00:00:00Z");
      await s.send("watch_market.offer_seen", offer("d6", "selling", { priceMinor: 900_000, currency: "EUR" }), "2026-09-28T00:00:00Z");
      const [rec] = about(await s.ask(NOW), "126610LN");
      expect(rec!.impact).toBeUndefined();
    });
  });

  describe("metals", () => {
    it("a rise: the added metal value of the pieces with a weight, counting quantity", async () => {
      const s = store();
      await s.send("inventory.received", received("G1", { metal: "gold", karat: 18, weightGrams: 5, quantity: 2 }), "2026-09-01T00:00:00Z");
      // No karat and no weight: no metal value to count.
      await s.send("inventory.received", received("G2", { metal: "gold", weightGrams: 5 }), "2026-09-01T00:00:00Z");
      await s.send("inventory.received", received("G3", { metal: "gold", karat: 14 }), "2026-09-01T00:00:00Z");
      await s.send("metal.price_updated", { metal: "gold", spotPerTroyOunceCents: 250_000 }, "2026-09-01T00:00:00Z");
      await s.send("metal.price_updated", { metal: "gold", spotPerTroyOunceCents: 265_000 }, "2026-10-01T00:00:00Z");
      const [rec] = about(await s.ask(NOW), "per ounce");
      // 5 g of 18k is worth $319.50 at $2,650 and $301.41 at $2,500: $18.09 each.
      expect(rec!.impact).toEqual({
        kind: "makes",
        ...range(3_618, 3_618, 3_618),
        basis: "The $36.18 rise in metal value of the gold pieces received with a weight, kept by raising their prices with the metal.",
      });
    });

    it("a fall carries no number", async () => {
      const s = store();
      await s.send("inventory.received", received("G1", { metal: "gold", karat: 18, weightGrams: 5 }), "2026-09-01T00:00:00Z");
      await s.send("metal.price_updated", { metal: "gold", spotPerTroyOunceCents: 265_000 }, "2026-09-01T00:00:00Z");
      await s.send("metal.price_updated", { metal: "gold", spotPerTroyOunceCents: 250_000 }, "2026-10-01T00:00:00Z");
      const [rec] = about(await s.ask(NOW), "per ounce");
      expect(rec!.summary).toContain("is down");
      expect(rec!.impact).toBeUndefined();
    });

    it("a buy too close to melt: what was paid above the target rate", async () => {
      const s = store();
      await s.send("metal.price_updated", { metal: "gold", spotPerTroyOunceCents: 250_000 }, "2026-09-01T00:00:00Z");
      await s.send(
        "gold_purchase.completed",
        {
          purchaseId: "GP1",
          sellerId: "p1",
          items: [{ description: "14k chain", metal: "gold", karat: 14, weightGrams: 31.1034768 }],
          paidCents: 140_000,
          paymentMethod: "check",
          sellerIdVerified: true,
        },
        "2026-09-02T00:00:00Z",
      );
      const [rec] = about(await s.ask(NOW), "GP1");
      // Melt is $1,458.33; 85% of it is $1,239.58.
      expect(rec!.impact).toEqual({ kind: "saves", ...range(16_042, 16_042, 16_042), basis: "Paid $160.42 above 85% of melt, saved on the next purchase like it." });
    });

    const line = (lot: string, over: Record<string, unknown> = {}) => ({
      lineId: `refiner:test_refinery:${lot}:gold:0`,
      refiner: "test_refinery",
      lot,
      settledOn: "2026-09-10",
      metal: "gold",
      meltGrams: 100,
      fineness: 0.585,
      fineGrams: 55,
      fineTroyOunces: 1.8808,
      creditCents: 470_000,
      fineWeightCheck: "differs",
      expectedFineGrams: 58.5,
      currency: "USD",
      ...over,
    });

    it("an assay short: the missing metal at the settlement's own rate", async () => {
      const s = store();
      await s.send("refining.settlement_line_imported", line("LOT-1"), "2026-09-10T00:00:00Z");
      await s.send("refining.settlement_line_imported", line("LOT-2", { pricePerTroyOunceCents: 250_000 }), "2026-09-10T00:00:00Z");
      await s.send("refining.settlement_line_imported", line("LOT-3", { creditCents: undefined }), "2026-09-10T00:00:00Z");
      await s.send("refining.settlement_line_imported", line("LOT-4", { creditCents: 0 }), "2026-09-10T00:00:00Z");
      const recs = about(await s.ask(NOW), "recheck");
      // $4,700 for 55 g is $85.45 a gram, and 3.5 g short.
      expect(about(recs, "LOT-1")[0]!.impact).toEqual({
        kind: "protects",
        ...range(29_909, 29_909, 29_909),
        basis: "3.50 g of fine gold at the $85.45 a gram this settlement paid.",
      });
      // $2,500 an ounce is $80.38 a gram, which wins over the credit.
      expect(about(recs, "LOT-2")[0]!.impact).toMatchObject({ ...range(28_132, 28_132, 28_132), basis: expect.stringContaining("$80.38 a gram") });
      expect(about(recs, "LOT-3")[0]!.impact).toBeUndefined();
      expect(about(recs, "LOT-4")[0]!.impact).toBeUndefined();
    });

    it("a low payable: the same lot at a fair share of spot", async () => {
      const s = store();
      await s.send("metal.price_updated", { metal: "gold", spotPerTroyOunceCents: 270_000 }, "2026-09-09T21:00:00Z");
      await s.send("refining.settlement_line_imported", line("LOT-3", { creditCents: 420_000, fineGrams: 58.5, fineWeightCheck: "matches" }), "2026-09-10T00:00:00Z");
      const [rec] = about(await s.ask(NOW), "second quote");
      expect(rec!.impact).toEqual({
        kind: "makes",
        ...range(62_425, 72_582, 82_738),
        basis: "This lot at 97% of spot instead of 82.7%: 1.8808 oz of fine gold at $2,700.00 an ounce.",
      });
    });
  });

  it("marketing: one more run of a winner, or the loss saved by dropping a loser", async () => {
    const s = store();
    await s.send("campaign.sent", { campaignId: "C1", name: "Holiday email", channel: "email", costCents: 20_000 }, "2026-09-01T00:00:00Z");
    await s.send("campaign.sale_attributed", { campaignId: "C1", saleId: "S1", revenueCents: 90_000 }, "2026-09-05T00:00:00Z");
    await s.send("campaign.sent", { campaignId: "C2", name: "Billboard", channel: "print", costCents: 300_000 }, "2026-09-01T00:00:00Z");
    await s.send("campaign.sale_attributed", { campaignId: "C2", saleId: "S2", revenueCents: 100_000 }, "2026-09-05T00:00:00Z");
    // Exactly 3x counts as a winner.
    await s.send("campaign.sent", { campaignId: "C3", name: "Trunk show", channel: "event", costCents: 20_000 }, "2026-09-01T00:00:00Z");
    await s.send("campaign.sale_attributed", { campaignId: "C3", saleId: "S3", revenueCents: 60_000 }, "2026-09-05T00:00:00Z");
    const recs = await s.ask(NOW);
    expect(about(recs, "Trunk show")[0]!.impact).toMatchObject({ kind: "makes", ...range(1_000, 7_000, 13_000) });
    expect(about(recs, "Holiday email")[0]!.impact).toEqual({
      kind: "makes",
      ...range(11_500, 20_500, 29_500),
      basis: "One more run with the same result: $900.00 in sales at a 45% margin, less its $200.00 cost.",
    });
    expect(about(recs, "Billboard")[0]!.impact).toEqual({
      kind: "saves",
      ...range(245_000, 255_000, 265_000),
      basis: "Not running it again: its $3,000.00 cost, less the profit on its $1,000.00 in sales at a 45% margin.",
    });
  });
});
