import { describe, expect, it } from "vitest";
import { combineDepartments, finance, money, PAYOUT_SCHEDULE_DAYS, processorOf } from "../src/index.js";
import { ORG, about, store } from "./harness.js";

const NOW = "2026-10-20T15:00:00.000Z";
const at = (date: string) => `${date}T12:00:00.000Z`;

// Synthetic records in the shapes the payment connectors write.
const klarnaPayout = (ref: string, amountCents: number, date: string, extra: Record<string, unknown> = {}) => ({
  system: "Klarna",
  payoutId: `klarna:payout:${ref}`,
  amountCents,
  currency: "USD",
  status: "paid",
  method: "bank_transfer",
  type: "settlement",
  arrivalDate: date,
  settledOn: date,
  salesCents: null,
  feeCents: null,
  ...extra,
});
const klarnaLine = (ref: string, type: string, amountCents: number, extra: Record<string, unknown> = {}) => ({
  system: "Klarna",
  payoutId: `klarna:payout:${ref}`,
  type,
  amountCents,
  currency: "USD",
  orderId: "klarna:order:o-1",
  captureId: "c-1",
  saleAt: "2026-10-10T00:00:00.000Z",
  capturedAt: "2026-10-11T00:00:00.000Z",
  ...extra,
});
const stripePayout = (id: string, amountCents: number, status = "paid", extra: Record<string, unknown> = {}) => ({
  payoutId: `stripe:payout:${id}`,
  amountCents,
  currency: "usd",
  status,
  method: "standard",
  type: "bank_account",
  arrivalDate: null,
  ...extra,
});
const stripeTxn = (id: string, type: string, amountCents: number, feeCents: number, availableOn: string, currency = "usd") => ({
  balanceTransactionId: `stripe:balance_transaction:${id}`,
  type,
  reportingCategory: type,
  amountCents,
  feeCents,
  netCents: amountCents - feeCents,
  currency,
  availableOn,
});
const authBatch = (id: string, amountCents: number, status = "paid") => ({
  payoutId: `authorize_net:batch:${id}`,
  amountCents,
  currency: "USD",
  status,
  method: "card",
  type: "settlement",
  arrivalDate: null,
  settledOn: null,
  chargeCents: null,
  refundCents: null,
});
const authCharge = (id: string, cents: number, batch?: string, captured = true) => ({
  chargeId: `authorize_net:transaction:${id}`,
  status: captured ? "succeeded" : "pending",
  paid: captured,
  captured,
  amountCents: cents,
  capturedCents: captured ? cents : 0,
  currency: "USD",
  ...(batch ? { batchId: `authorize_net:batch:${batch}` } : {}),
});
const authRefund = (id: string, cents: number, batch: string | undefined, status = "succeeded") => ({
  refundId: `authorize_net:transaction:${id}`,
  chargeId: "authorize_net:transaction:1",
  amountCents: cents,
  currency: "USD",
  status,
  reason: null,
  ...(batch ? { batchId: `authorize_net:batch:${batch}` } : {}),
});
const auroraBatch = (id: string, amountCents: number, status = "settled", extra: Record<string, unknown> = {}) => ({
  system: "Aurora Payments",
  payoutId: `aurora:batch:${id}`,
  processorBatchNumber: "0000000001",
  status,
  salesCents: null,
  refundsCents: null,
  amountCents,
  currency: "USD",
  ...extra,
});
const auroraTxn = (id: string, batch: string, transactionType: string, totalCents: number, status = "Captured") => ({
  system: "Aurora Payments",
  transactionId: `aurora:transaction:${id}`,
  payoutId: `aurora:batch:${batch}`,
  transactionType,
  status,
  currency: "USD",
  totalCents,
});

describe("payout matching: signals", () => {
  it("keeps each payout and each line it covers as signals", async () => {
    const s = store();
    const payout = await s.send("payout.updated", klarnaPayout("REF1", 85_200, "2026-10-12"), at("2026-10-12"));
    expect(payout.signals).toEqual([
      expect.objectContaining({
        kind: "payout.record",
        subject: { kind: "payout", id: "klarna:payout:REF1" },
        value: expect.objectContaining({ processor: "klarna", amountCents: 85_200, currency: "USD", status: "paid", createdOn: "2026-10-12", arrivalOn: "2026-10-12" }),
      }),
    ]);
    const line = await s.send("balance.transaction_recorded", klarnaLine("REF1", "fee", -1_200), at("2026-10-11"));
    expect(line.signals[0]).toMatchObject({
      kind: "payout.line",
      value: { processor: "klarna", payoutId: "klarna:payout:REF1", category: "fee", netCents: -1_200, feeCents: 1_200, on: "2026-10-11", orderId: "klarna:order:o-1", chargeId: "c-1" },
    });
  });

  it("reads every payment connector's lines in the same way", async () => {
    const s = store();
    const stripe = await s.send("balance.transaction_recorded", stripeTxn("txn_1", "charge", 10_000, 320, "2026-10-03"));
    expect(stripe.signals[0]!.value).toMatchObject({ processor: "stripe", payoutId: null, category: "sale", netCents: 9_680, feeCents: 320, currency: "USD", availableOn: "2026-10-03" });
    const refund = await s.send("balance.transaction_recorded", stripeTxn("txn_2", "refund", -2_000, 0, "2026-10-03"));
    expect(refund.signals[0]!.value).toMatchObject({ category: "refund", netCents: -2_000 });
    const fee = await s.send("balance.transaction_recorded", stripeTxn("txn_3", "stripe_fee", -500, 0, "2026-10-03"));
    expect(fee.signals[0]!.value).toMatchObject({ category: "fee" });
    const dispute = await s.send("balance.transaction_recorded", stripeTxn("txn_4", "adjustment", -1_500, 1_500, "2026-10-03"));
    expect(dispute.signals[0]!.value).toMatchObject({ category: "adjustment", netCents: -3_000 });
    const aurora = await s.send("balance.transaction_recorded", auroraTxn("t1", "b1", "refund", 5_000));
    expect(aurora.signals[0]!.value).toMatchObject({ processor: "aurora", category: "refund", netCents: -5_000, payoutId: "aurora:batch:b1" });
    const capture = await s.send("balance.transaction_recorded", auroraTxn("t2", "b1", "capture", 7_000));
    expect(capture.signals[0]!.value).toMatchObject({ category: "sale", netCents: 7_000 });
    const batched = await s.send("payment.charge_updated", authCharge("1", 4_000, "77"));
    expect(batched.signals.find((x) => x.kind === "payout.line")!.value).toMatchObject({ processor: "authorize_net", payoutId: "authorize_net:batch:77", netCents: 4_000 });
    const unsettled = await s.send("payment.charge_updated", authCharge("2", 4_000));
    expect(unsettled.signals.find((x) => x.kind === "payout.line")!.value).toMatchObject({ payoutId: null });
    const authRef = await s.send("payment.refund_updated", authRefund("3", 1_000, "77"));
    expect(authRef.signals[0]!.value).toMatchObject({ category: "refund", netCents: -1_000, chargeId: "authorize_net:transaction:1" });
    const klarnaOther = await s.send("balance.transaction_recorded", klarnaLine("R", "holdback", -300, { capturedAt: null, saleAt: null }), at("2026-10-09"));
    expect(klarnaOther.signals[0]!.value).toMatchObject({ category: "adjustment", on: "2026-10-09", feeCents: 0 });
  });

  it("keeps nothing for records that move no money or don't read", async () => {
    const s = store();
    const none = [
      await s.send("balance.transaction_recorded", stripeTxn("txn_p", "payout", -9_000, 0, "2026-10-03")),
      await s.send("balance.transaction_recorded", { balanceTransactionId: "stripe:balance_transaction:x", type: "charge", currency: "usd" }),
      await s.send("balance.transaction_recorded", auroraTxn("v", "b1", "void", 5_000)),
      await s.send("balance.transaction_recorded", auroraTxn("d", "b1", "sale", 5_000, "Declined")),
      await s.send("balance.transaction_recorded", { ...auroraTxn("n", "b1", "sale", 5_000), totalCents: null }),
      await s.send("balance.transaction_recorded", { system: "Klarna", payoutId: "klarna:payout:R", type: "sale", amountCents: null }),
      await s.send("balance.transaction_recorded", { system: "Klarna", payoutId: null, problems: ["no"] }),
      await s.send("balance.transaction_recorded", { amountCents: "12" }),
      await s.send("payout.updated", { payoutId: null, problems: ["payout has no settlement amount that reads"] }),
      // Square and Stripe charges say nothing about a payout; Stripe's come through its balance transactions.
      await s.send("payment.charge_updated", { chargeId: "square:payment:1", captured: true, capturedCents: 5_000, currency: "USD" }),
      await s.send("payment.charge_updated", authCharge("4", 5_000, undefined, false)),
      await s.send("payment.charge_updated", { chargeId: 7 }),
      await s.send("payment.refund_updated", authRefund("5", 1_000, undefined)),
      await s.send("payment.refund_updated", authRefund("6", 1_000, "77", "failed")),
      await s.send("payment.refund_updated", { refundId: "" }),
    ];
    expect(none.flatMap((r) => r.signals.filter((x) => x.kind.startsWith("payout.")))).toEqual([]);
  });

  it("names processors and money in their own words", () => {
    expect(processorOf("authorize_net:batch:1")).toBe("authorize_net");
    expect(processorOf("")).toBe("");
    expect(money(123_456, "USD")).toBe("$1,234.56");
    expect(money(5, null)).toBe("$0.05");
    expect(money(123_456, "EUR")).toBe("1,234.56 EUR");
    expect(PAYOUT_SCHEDULE_DAYS.stripe).toBeGreaterThan(0);
  });
});

describe("payout matching: matched and short", () => {
  it("raises nothing when a payout pays its sales less returns and fees", async () => {
    const s = store();
    await s.send("payout.updated", klarnaPayout("REF1", 85_200, "2026-10-12"), at("2026-10-12"));
    await s.send("balance.transaction_recorded", klarnaLine("REF1", "sale", 100_000), at("2026-10-11"));
    await s.send("balance.transaction_recorded", klarnaLine("REF1", "return", -13_600), at("2026-10-11"));
    await s.send("balance.transaction_recorded", klarnaLine("REF1", "fee", -1_200), at("2026-10-11"));
    expect(about(await s.ask(NOW), "payout")).toEqual([]);
  });

  it("raises a short payout with what it protects, linked to the payout and its lines", async () => {
    const s = store();
    const payout = await s.send("payout.updated", klarnaPayout("REF2", 80_000, "2026-10-12"), at("2026-10-12"));
    const sale = await s.send("balance.transaction_recorded", klarnaLine("REF2", "sale", 100_000), at("2026-10-11"));
    const ret = await s.send("balance.transaction_recorded", klarnaLine("REF2", "return", -13_600), at("2026-10-11"));
    const fee = await s.send("balance.transaction_recorded", klarnaLine("REF2", "fee", -1_200), at("2026-10-11"));
    const [rec, ...rest] = about(await s.ask(NOW), "payout");
    expect(rest).toEqual([]);
    expect(rec).toMatchObject({
      id: "rec_finance_payout_short_klarna:payout:REF2_2026-10-20",
      summary:
        "Klarna payout REF2 on 2026-10-12 paid $800.00, but the 3 sales, refunds and fees it covers come to $852.00: $52.00 short. Ask Klarna for the payout's detail and anything held back.",
      confidence: 0.75,
      impact: { kind: "protects", cents: 5_200, lowCents: 5_200, highCents: 5_200 },
      degraded: false,
    });
    expect(rec!.provenance.eventIds.sort()).toEqual([payout.event.id, sale.event.id, ret.event.id, fee.event.id].sort());
  });

  it("allows the larger of a dollar and half a percent before calling a payout short", async () => {
    const s = store();
    // $1.00 under on $852: within a dollar.
    await s.send("payout.updated", klarnaPayout("T1", 85_100, "2026-10-12"), at("2026-10-12"));
    await s.send("balance.transaction_recorded", klarnaLine("T1", "sale", 85_200), at("2026-10-11"));
    // $50.00 under on $10,000: within half a percent.
    await s.send("payout.updated", klarnaPayout("T2", 995_000, "2026-10-12"), at("2026-10-12"));
    await s.send("balance.transaction_recorded", klarnaLine("T2", "sale", 1_000_000), at("2026-10-11"));
    // $50.01 under on $10,000: just past it.
    await s.send("payout.updated", klarnaPayout("T3", 994_999, "2026-10-12"), at("2026-10-12"));
    await s.send("balance.transaction_recorded", klarnaLine("T3", "sale", 1_000_000), at("2026-10-11"));
    // Paid more than it covers: the processor's loss, not the store's.
    await s.send("payout.updated", klarnaPayout("T4", 90_000, "2026-10-12"), at("2026-10-12"));
    await s.send("balance.transaction_recorded", klarnaLine("T4", "sale", 85_200), at("2026-10-11"));
    const recs = about(await s.ask(NOW), "payout");
    expect(recs.map((r) => r.id)).toEqual(["rec_finance_payout_short_klarna:payout:T3_2026-10-20"]);
  });

  it("matches card batches to their charges less partial refunds", async () => {
    const s = store();
    await s.send("payout.updated", authBatch("77", 140_000), at("2026-10-12"));
    await s.send("payment.charge_updated", authCharge("1", 100_000, "77"), at("2026-10-11"));
    await s.send("payment.charge_updated", authCharge("2", 50_000, "77"), at("2026-10-11"));
    await s.send("payment.refund_updated", authRefund("3", 10_000, "77"), at("2026-10-11"));
    expect(about(await s.ask(NOW), "payout")).toEqual([]);
    // A second charge in the batch that the batch didn't pay for.
    await s.send("payment.charge_updated", authCharge("4", 20_000, "77"), at("2026-10-11"));
    const [rec] = about(await s.ask(NOW), "payout");
    expect(rec).toMatchObject({ id: "rec_finance_payout_short_authorize_net:batch:77_2026-10-20", impact: { cents: 20_000 } });
    expect(rec!.summary).toContain("Authorize.net payout 77 on 2026-10-12 paid $1,400.00, but the 4 sales, refunds and fees it covers come to $1,600.00");
  });

  it("matches Stripe payouts to what came available since the payout before, fees and refunds included", async () => {
    const s = store();
    await s.send("payout.updated", stripePayout("po_0", 1_000), at("2026-10-01"));
    // Paid in po_0: before the first payout seen, so po_0 itself isn't judged.
    await s.send("balance.transaction_recorded", stripeTxn("txn_0", "charge", 90_000, 2_640, "2026-10-01"));
    await s.send("balance.transaction_recorded", stripeTxn("txn_1", "charge", 50_000, 1_480, "2026-10-03"));
    await s.send("balance.transaction_recorded", stripeTxn("txn_2", "charge", 30_000, 900, "2026-10-05"));
    await s.send("balance.transaction_recorded", stripeTxn("txn_3", "refund", -10_000, 0, "2026-10-05"));
    // A payout's own balance transaction is not a line of it.
    await s.send("balance.transaction_recorded", stripeTxn("txn_po", "payout", -67_620, 0, "2026-10-05"));
    await s.send("payout.updated", stripePayout("po_1", 67_620), at("2026-10-05"));
    expect(about(await s.ask(NOW), "payout")).toEqual([]);

    const short = store();
    await short.send("payout.updated", stripePayout("po_0", 1_000), at("2026-10-01"));
    await short.send("balance.transaction_recorded", stripeTxn("txn_1", "charge", 50_000, 1_480, "2026-10-03"));
    await short.send("balance.transaction_recorded", stripeTxn("txn_2", "charge", 30_000, 900, "2026-10-05"));
    await short.send("payout.updated", stripePayout("po_1", 70_000), at("2026-10-05"));
    const [rec, ...rest] = about(await short.ask(NOW), "payout");
    expect(rest).toEqual([]);
    expect(rec).toMatchObject({ id: "rec_finance_payout_short_stripe:payout:po_1_2026-10-20", confidence: 0.6, impact: { cents: 7_620 } });
    expect(rec!.summary).toContain("Stripe payout po_1 on 2026-10-05 paid $700.00, but the 2 sales, refunds and fees it covers come to $776.20: $76.20 short.");
  });

  it("checks a payout read without its lines against the totals it reports", async () => {
    const s = store();
    const affirm = (id: string, settled: number) => ({
      payoutId: `affirm:deposit:${id}`,
      amountCents: settled,
      currency: "USD",
      status: "paid",
      method: "bank_transfer",
      type: "settlement",
      arrivalDate: null,
      settledOn: "2026-10-10",
      salesCents: 200_000,
      refundCents: 20_000,
      feeCents: 6_000,
    });
    await s.send("payout.updated", affirm("d1", 174_000), "2026-10-10T00:00:00.000Z");
    await s.send("payout.updated", affirm("d2", 150_000), "2026-10-10T00:00:00.000Z");
    // Klarna's totals carry holdbacks and debt too, so only its lines are trusted.
    await s.send("payout.updated", klarnaPayout("K", 1_000, "2026-10-10", { salesCents: 200_000, feeCents: 1_000 }), at("2026-10-10"));
    // Aurora reports refunds as refundsCents.
    await s.send("payout.updated", auroraBatch("b9", 100_000, "settled", { salesCents: 150_000, refundsCents: 10_000 }), at("2026-10-10"));
    const recs = about(await s.ask(NOW), "payout");
    expect(recs.map((r) => r.id).sort()).toEqual(["rec_finance_payout_short_affirm:deposit:d2_2026-10-20", "rec_finance_payout_short_aurora:batch:b9_2026-10-20"]);
    expect(recs.find((r) => r.id.includes("d2"))).toMatchObject({ confidence: 0.7, impact: { cents: 24_000 } });
    expect(recs.find((r) => r.id.includes("d2"))!.summary).toContain("the sales less refunds and fees it reports come to $1,740.00: $240.00 short");
  });
});

describe("payout matching: missing", () => {
  it("raises a payout that failed or was canceled", async () => {
    const s = store();
    await s.send("payout.updated", stripePayout("po_f", 45_000, "failed"), at("2026-10-08"));
    await s.send("payout.updated", stripePayout("po_c", 5_000, "canceled"), at("2026-10-08"));
    await s.send("payout.updated", stripePayout("po_z", 0, "failed"), at("2026-10-08"));
    const recs = about(await s.ask(NOW), "payout");
    expect(recs.map((r) => r.id).sort()).toEqual(["rec_finance_payout_failed_stripe:payout:po_c_2026-10-20", "rec_finance_payout_failed_stripe:payout:po_f_2026-10-20"]);
    expect(recs.find((r) => r.id.includes("po_f"))).toMatchObject({
      summary: "Stripe payout po_f of $450.00 from 2026-10-08 did not go through, so the sales it covers are not in the bank. Check the bank account on file with Stripe and that the money was sent again.",
      confidence: 0.8,
      impact: { kind: "protects", cents: 45_000 },
    });
    expect(recs.find((r) => r.id.includes("po_c"))!.summary).toContain("was canceled");
  });

  it("raises lines that name a payout with no record, once that payout is due", async () => {
    const s = store();
    // The payout itself was dead-lettered by the connector, so only its lines arrived.
    await s.send("balance.transaction_recorded", klarnaLine("GONE", "sale", 40_000, { capturedAt: "2026-10-14T00:00:00.000Z" }), at("2026-10-14"));
    await s.send("balance.transaction_recorded", klarnaLine("GONE", "fee", -1_000, { capturedAt: "2026-10-14T00:00:00.000Z" }), at("2026-10-14"));
    expect(about(await s.ask("2026-10-20T15:00:00.000Z"), "payout")).toEqual([]);
    const [rec] = about(await s.ask("2026-10-25T15:00:00.000Z"), "payout");
    expect(rec).toMatchObject({
      id: "rec_finance_payout_unrecorded_klarna:payout:GONE_2026-10-25",
      summary: "Klarna lists 2 lines worth $390.00 under payout GONE, but there is no record of that payout. Find the deposit on the bank statement, or ask Klarna for the payout report.",
      impact: { cents: 39_000 },
    });
  });

  it("puts no number on lines with no record when their currencies differ or they add to nothing", async () => {
    const s = store();
    const early = { capturedAt: "2026-10-01T00:00:00.000Z" };
    await s.send("balance.transaction_recorded", klarnaLine("MIX", "sale", 40_000, { ...early, currency: "EUR" }), at("2026-10-01"));
    await s.send("balance.transaction_recorded", klarnaLine("MIX", "sale", 40_000, early), at("2026-10-01"));
    await s.send("balance.transaction_recorded", klarnaLine("NIL", "fee", -1_000, early), at("2026-10-01"));
    const recs = about(await s.ask(NOW), "payout");
    expect(recs.map((r) => r.id).sort()).toEqual(["rec_finance_payout_unrecorded_klarna:payout:MIX_2026-10-20", "rec_finance_payout_unrecorded_klarna:payout:NIL_2026-10-20"]);
    const mix = recs.find((r) => r.id.includes("MIX"))!;
    expect(mix.summary).toContain("Klarna lists 2 lines under payout MIX");
    expect(mix.impact).toBeUndefined();
    expect(recs.find((r) => r.id.includes("NIL"))!.impact).toBeUndefined();
  });

  it("calls sales missing once they are a month past the processor's schedule", async () => {
    const s = store();
    await s.send("payout.updated", authBatch("80", 10_000), at("2026-10-15"));
    await s.send("payment.charge_updated", authCharge("80a", 10_000, "80"), at("2026-10-14"));
    await s.send("payment.charge_updated", authCharge("old", 25_000), at("2026-09-10"));
    const recs = about(await s.ask(NOW), "payout");
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      id: "rec_finance_payout_missing_authorize_net_USD_2026-10-20",
      summary: "1 Authorize.net sale worth $250.00, the oldest from 2026-09-10, is in no payout more than 30 days after Authorize.net would normally have paid. Ask Authorize.net where the money went.",
      confidence: 0.7,
      impact: { kind: "protects", cents: 25_000 },
    });
  });
});

describe("payout matching: late", () => {
  it("raises card sales not batched past the schedule, but only for a processor whose payouts are read", async () => {
    const unread = store();
    await unread.send("payment.charge_updated", authCharge("9", 30_000), at("2026-10-13"));
    expect(about(await unread.ask(NOW), "payout")).toEqual([]);

    const s = store();
    await s.send("payout.updated", authBatch("81", 10_000), at("2026-10-15"));
    await s.send("payment.charge_updated", authCharge("81a", 10_000, "81"), at("2026-10-14"));
    await s.send("payment.charge_updated", authCharge("9", 30_000), at("2026-10-13"));
    await s.send("payment.charge_updated", authCharge("10", 20_000), at("2026-10-14"));
    // Captured yesterday: still within the schedule.
    await s.send("payment.charge_updated", authCharge("11", 5_000), at("2026-10-19"));
    const recs = about(await s.ask(NOW), "payout");
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      id: "rec_finance_payout_late_authorize_net_USD_2026-10-20",
      summary: `2 Authorize.net sales worth $500.00, the oldest from 2026-10-13, have not been paid out, though Authorize.net normally pays within ${PAYOUT_SCHEDULE_DAYS.authorize_net} days. Check Authorize.net for a hold or a paused payout schedule.`,
      confidence: 0.6,
    });
    // Money paid out late isn't lost, so there is no dollar figure to protect.
    expect(recs[0]!.impact).toBeUndefined();
  });

  it("stops calling a sale late once it settles in a batch", async () => {
    const s = store();
    await s.send("payout.updated", authBatch("82", 30_000), at("2026-10-19"));
    await s.send("payment.charge_updated", authCharge("12", 30_000), at("2026-10-13"));
    expect(about(await s.ask(NOW), "payout")).toHaveLength(1);
    // The same charge, now settled in batch 82: the latest version wins.
    await s.send("payment.charge_updated", authCharge("12", 30_000, "82"), at("2026-10-13"));
    expect(about(await s.ask(NOW), "payout")).toEqual([]);
  });

  it("raises Stripe sales that came available after the last payout", async () => {
    const s = store();
    await s.send("payout.updated", stripePayout("po_0", 1_000), at("2026-10-01"));
    await s.send("balance.transaction_recorded", stripeTxn("txn_9", "charge", 20_000, 610, "2026-10-08"), at("2026-10-06"));
    // A refund after the last payout is owed back, not paid out.
    await s.send("balance.transaction_recorded", stripeTxn("txn_10", "refund", -2_000, 0, "2026-10-08"));
    // Came available two days ago: not yet late.
    await s.send("balance.transaction_recorded", stripeTxn("txn_11", "charge", 20_000, 610, "2026-10-18"));
    // Another currency, which no payout seen is in.
    await s.send("balance.transaction_recorded", stripeTxn("txn_12", "charge", 20_000, 610, "2026-10-08", "eur"));
    const recs = about(await s.ask(NOW), "payout");
    expect(recs.map((r) => r.id)).toEqual(["rec_finance_payout_late_stripe_USD_2026-10-20"]);
    expect(recs[0]!.summary).toContain("1 Stripe sale worth $193.90, the oldest from 2026-10-06, has not been paid out");
  });

  it("raises a payout still pending past when it would normally land", async () => {
    const s = store();
    await s.send("payout.updated", auroraBatch("open1", 50_000, "open"), at("2026-10-10"));
    await s.send("payout.updated", stripePayout("po_soon", 20_000, "pending", { arrivalDate: "2026-10-19" }), at("2026-10-17"));
    await s.send("payout.updated", stripePayout("po_odd", 20_000, "unknown_state"), at("2026-10-01"));
    const recs = about(await s.ask(NOW), "payout");
    expect(recs.map((r) => r.id)).toEqual(["rec_finance_payout_pending_aurora:batch:open1_2026-10-20"]);
    expect(recs[0]).toMatchObject({
      summary: "Aurora Payments payout open1 of $500.00 from 2026-10-10 still shows as open, 6 days after it would normally have landed. Check with Aurora Payments that it was sent.",
      confidence: 0.65,
    });
    expect(recs[0]!.impact).toBeUndefined();
  });
});

describe("payout matching: processors and currencies", () => {
  it("matches each processor's payouts only to its own sales", async () => {
    const s = store();
    await s.send("payout.updated", stripePayout("po_0", 1_000), at("2026-10-01"));
    await s.send("balance.transaction_recorded", stripeTxn("txn_1", "charge", 50_000, 1_480, "2026-10-03"));
    await s.send("payout.updated", stripePayout("po_1", 48_520), at("2026-10-05"));
    await s.send("payout.updated", klarnaPayout("K1", 30_000, "2026-10-12"), at("2026-10-12"));
    await s.send("balance.transaction_recorded", klarnaLine("K1", "sale", 40_000), at("2026-10-11"));
    await s.send("payout.updated", auroraBatch("a1", 120_000), at("2026-10-12"));
    await s.send("balance.transaction_recorded", auroraTxn("t1", "a1", "sale", 125_000), at("2026-10-11"));
    await s.send("balance.transaction_recorded", auroraTxn("t2", "a1", "refund", 5_000), at("2026-10-11"));
    await s.send("payout.updated", authBatch("90", 7_000), at("2026-10-12"));
    await s.send("payment.charge_updated", authCharge("90a", 7_000, "90"), at("2026-10-11"));
    const recs = about(await s.ask(NOW), "payout");
    expect(recs.map((r) => r.id)).toEqual(["rec_finance_payout_short_klarna:payout:K1_2026-10-20"]);
  });

  it("doesn't judge a payout against lines in another currency", async () => {
    const s = store();
    await s.send("payout.updated", klarnaPayout("FX", 30_000, "2026-10-12"), at("2026-10-12"));
    await s.send("balance.transaction_recorded", klarnaLine("FX", "sale", 40_000, { currency: "SEK" }), at("2026-10-11"));
    expect(about(await s.ask(NOW), "payout")).toEqual([]);
  });

  it("raises a short payout in another currency in its own money, with no dollar figure", async () => {
    const s = store();
    await s.send("payout.updated", klarnaPayout("EU", 30_000, "2026-10-12", { currency: "EUR" }), at("2026-10-12"));
    await s.send("balance.transaction_recorded", klarnaLine("EU", "sale", 40_000, { currency: "EUR" }), at("2026-10-11"));
    const [rec] = about(await s.ask(NOW), "payout");
    expect(rec!.summary).toContain("paid 300.00 EUR, but the 1 sale, refund and fee it covers come to 400.00 EUR: 100.00 EUR short");
    expect(rec!.impact).toBeUndefined();
  });

  it("names a processor it doesn't know by its id, on the default schedule", async () => {
    const s = store();
    await s.send("payout.updated", { payoutId: "newpay:payout:n1", amountCents: 9_000, currency: "USD", status: "paid" }, at("2026-10-12"));
    await s.send("balance.transaction_recorded", { system: "New", payoutId: "newpay:payout:n1", type: "sale", amountCents: 10_000, currency: "USD" }, at("2026-10-11"));
    const [rec] = about(await s.ask(NOW), "payout");
    expect(rec!.summary).toMatch(/^newpay payout n1 on 2026-10-12 paid \$90\.00/);
  });
});

describe("payout matching: duplicates and age", () => {
  it("stores a replayed record once and gives the same recommendation each run", async () => {
    const s = store();
    const send = (id: string, key: string, type: string, payload: Record<string, unknown>, occurredAt: string) =>
      s.pipeline.ingest({ id, organizationId: ORG, source: "klarna", type, occurredAt, receivedAt: occurredAt, idempotencyKey: key, payload });
    await send("p1", "klarna:payout:D", "payout.updated", klarnaPayout("D", 80_000, "2026-10-12"), at("2026-10-12"));
    await send("l1", "klarna:transaction:D:0", "balance.transaction_recorded", klarnaLine("D", "sale", 100_000), at("2026-10-11"));
    const again = await send("l1", "klarna:transaction:D:0", "balance.transaction_recorded", klarnaLine("D", "sale", 100_000), at("2026-10-11"));
    expect(again).toMatchObject({ duplicate: true, signals: [] });
    // A second version of the payout (re-read with a new digest) is the same payout.
    await send("p2", "klarna:payout:D:v2", "payout.updated", klarnaPayout("D", 80_000, "2026-10-12"), at("2026-10-12"));
    const first = about(await s.ask(NOW), "payout");
    const second = about(await s.ask(NOW), "payout");
    expect(first).toHaveLength(1);
    expect(first[0]!.impact).toMatchObject({ cents: 20_000 });
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });

  it("counts a line read twice under different keys once", async () => {
    const s = store();
    await s.send("payout.updated", auroraBatch("dup", 100_000), at("2026-10-12"));
    await s.send("balance.transaction_recorded", auroraTxn("same", "dup", "sale", 100_000), at("2026-10-11"));
    await s.send("balance.transaction_recorded", auroraTxn("same", "dup", "sale", 100_000), at("2026-10-11"));
    expect(about(await s.ask(NOW), "payout")).toEqual([]);
  });

  it("leaves payouts and sales older than the lookback alone", async () => {
    const s = store();
    await s.send("payout.updated", stripePayout("po_old", 45_000, "failed"), at("2026-05-01"));
    await s.send("payout.updated", authBatch("old", 10_000), at("2026-05-01"));
    await s.send("payment.charge_updated", authCharge("old1", 99_000, "old"), at("2026-05-01"));
    await s.send("payout.updated", authBatch("new", 10_000), at("2026-10-15"));
    await s.send("payment.charge_updated", authCharge("ancient", 10_000), at("2026-05-01"));
    await s.send("payout.updated", { payoutId: "stripe:payout:po_nil", amountCents: null, currency: "usd", status: "failed" }, at("2026-10-15"));
    expect(about(await s.ask(NOW), "payout")).toEqual([]);
  });

  it("runs as part of finance", () => {
    expect(finance.reasoners.map((r) => r.name)).toContain("finance.payout-match");
    expect(finance.extractors.map((e) => e.name)).toContain("finance-payouts");
    // Payment events stay unowned, so a connector's record is never dead-lettered by these rules.
    const { payloadSchemas } = combineDepartments([finance]);
    for (const type of ["payout.updated", "balance.transaction_recorded", "payment.charge_updated", "payment.refund_updated"]) expect(payloadSchemas[type]).toBeUndefined();
  });
});

describe("payout matching: edges", () => {
  const pending = (payoutId: string, extra: Record<string, unknown> = {}) => ({ payoutId, amountCents: 10_000, currency: "USD", status: "pending", arrivalDate: null, settledOn: null, ...extra });

  it("reads each kind of line the processors send", async () => {
    const s = store();
    const first = async (type: string, payload: Record<string, unknown>) => (await s.send(type, payload)).signals.find((x) => x.kind === "payout.line")?.value;
    expect(await first("balance.transaction_recorded", stripeTxn("p1", "payment", 5_000, -50, "2026-10-03"))).toMatchObject({ category: "sale", feeCents: 0 });
    expect(await first("balance.transaction_recorded", stripeTxn("p2", "payment_refund", -5_000, 0, "2026-10-03"))).toMatchObject({ category: "refund" });
    // Only Stripe's balance transactions are swept; another processor's line keeps its payout.
    expect(
      await first("balance.transaction_recorded", { balanceTransactionId: "newpay:balance_transaction:1", payoutId: "newpay:payout:p", type: "sale", amountCents: 500, netCents: 500, currency: "USD" }),
    ).toMatchObject({ processor: "newpay", payoutId: "newpay:payout:p", category: "sale", netCents: 500 });
    expect(await first("balance.transaction_recorded", auroraTxn("s1", "b1", "sale", 3_000))).toMatchObject({ category: "sale", netCents: 3_000 });
    expect(await first("balance.transaction_recorded", auroraTxn("r1", "b1", "refund", -3_000))).toMatchObject({ category: "refund", netCents: -3_000 });
    expect(await first("balance.transaction_recorded", klarnaLine("R", "commission", -400))).toMatchObject({ category: "fee", feeCents: 400 });
    expect(await first("balance.transaction_recorded", klarnaLine("R", "return", -400))).toMatchObject({ category: "refund" });
    expect(await first("balance.transaction_recorded", klarnaLine("R", "fee", 300))).toMatchObject({ category: "fee", feeCents: 0 });
    expect(await first("balance.transaction_recorded", klarnaLine("R", "sale", 300, { capturedAt: null }))).toMatchObject({ on: "2026-10-10" });
    expect(await first("payment.charge_updated", { chargeId: "newpay:charge:1", batchId: "newpay:batch:1", captured: true, capturedCents: 500, currency: "USD" })).toMatchObject({
      processor: "newpay",
      payoutId: "newpay:batch:1",
    });
    expect(await first("payment.charge_updated", { ...authCharge("pc", 10_000, "77"), capturedCents: 6_000, orderId: "authorize_net:order:o-9" })).toMatchObject({
      netCents: 6_000,
      orderId: "authorize_net:order:o-9",
    });
    expect(await first("payment.refund_updated", authRefund("neg", -1_000, "77"))).toMatchObject({ netCents: -1_000 });
    expect((await s.send("payout.updated", stripePayout("po_t", 1_000, "in_transit"))).signals[0]!.value).toMatchObject({ status: "paid" });
  });

  it("keeps nothing for transfers, dead transactions, uncaptured charges and canceled refunds", async () => {
    const s = store();
    const none = [
      await s.send("balance.transaction_recorded", stripeTxn("tr", "transfer", -9_000, 0, "2026-10-03")),
      await s.send("balance.transaction_recorded", stripeTxn("tu", "topup", 9_000, 0, "2026-10-03")),
      await s.send("balance.transaction_recorded", auroraTxn("f", "b1", "sale", 5_000, "Failed")),
      await s.send("balance.transaction_recorded", auroraTxn("e", "b1", "sale", 5_000, "Error")),
      await s.send("balance.transaction_recorded", auroraTxn("j", "b1", "sale", 5_000, "Rejected")),
      await s.send("payment.charge_updated", { chargeId: "authorize_net:transaction:u", captured: false, amountCents: 5_000, currency: "USD" }),
      await s.send("payment.charge_updated", authCharge("zero", 0)),
      await s.send("payment.refund_updated", authRefund("can", 1_000, "77", "canceled")),
    ];
    expect(none.flatMap((r) => r.signals.filter((x) => x.kind.startsWith("payout.")))).toEqual([]);
  });

  it("calls a pending payout late the day after each processor's schedule", async () => {
    const s = store();
    const pairs: [string, string, string][] = [
      ["stripe:payout:", "2026-10-16", "2026-10-15"],
      ["authorize_net:batch:", "2026-10-16", "2026-10-15"],
      ["aurora:batch:", "2026-10-16", "2026-10-15"],
      ["affirm:deposit:", "2026-10-13", "2026-10-12"],
      ["klarna:payout:", "2026-10-10", "2026-10-09"],
      ["newpay:payout:", "2026-10-13", "2026-10-12"],
    ];
    for (const [prefix, due, late] of pairs) {
      await s.send("payout.updated", pending(`${prefix}due`), at(due));
      await s.send("payout.updated", pending(`${prefix}late`), at(late));
    }
    // With no amount there is nothing to chase.
    await s.send("payout.updated", pending("affirm:deposit:none", { amountCents: null }), at("2026-10-01"));
    const recs = about(await s.ask(NOW), "payout");
    expect(recs.map((r) => r.id).sort()).toEqual(pairs.map(([prefix]) => `rec_finance_payout_pending_${prefix}late_2026-10-20`).sort());
    for (const r of recs) expect(r.summary).toContain(", 1 day after it would normally have landed");
  });

  it("counts a pending payout's schedule from the day it lands, or settled, when it says", async () => {
    const s = store();
    const landing = await s.send("payout.updated", pending("affirm:deposit:a", { settledOn: "2026-10-18" }), at("2026-10-01"));
    const both = await s.send("payout.updated", pending("affirm:deposit:b", { arrivalDate: "2026-10-18", settledOn: "2026-10-01" }), at("2026-10-01"));
    const garbled = await s.send("payout.updated", pending("affirm:deposit:c", { arrivalDate: " 2026-10-19", settledOn: "2026-13-45" }), at("2026-10-01"));
    expect([landing, both, garbled].map((r) => (r.signals[0]!.value as { arrivalOn: unknown }).arrivalOn)).toEqual(["2026-10-18", "2026-10-18", null]);
    expect(about(await s.ask(NOW), "payout").map((r) => r.id)).toEqual(["rec_finance_payout_pending_affirm:deposit:c_2026-10-20"]);
  });

  it("allows a dollar on a small payout", async () => {
    const s = store();
    await s.send("payout.updated", klarnaPayout("D1", 9_900, "2026-10-12"), at("2026-10-12"));
    await s.send("balance.transaction_recorded", klarnaLine("D1", "sale", 10_000), at("2026-10-11"));
    await s.send("payout.updated", klarnaPayout("D2", 9_899, "2026-10-12"), at("2026-10-12"));
    await s.send("balance.transaction_recorded", klarnaLine("D2", "sale", 10_000), at("2026-10-11"));
    expect(about(await s.ask(NOW), "payout").map((r) => r.id)).toEqual(["rec_finance_payout_short_klarna:payout:D2_2026-10-20"]);
  });

  it("judges payouts up to the lookback's last day, and names an id with no prefix as it is", async () => {
    const s = store();
    await s.send("payout.updated", stripePayout("po_edge", 45_000, "failed"), at("2026-07-22"));
    await s.send("payout.updated", stripePayout("po_past", 45_000, "failed"), at("2026-07-21"));
    await s.send("payout.updated", { payoutId: "solo", amountCents: 1_000, currency: "USD", status: "failed" }, at("2026-10-10"));
    const recs = about(await s.ask(NOW), "payout");
    expect(recs.map((r) => r.id).sort()).toEqual(["rec_finance_payout_failed_solo_2026-10-20", "rec_finance_payout_failed_stripe:payout:po_edge_2026-10-20"]);
    expect(recs.find((r) => r.id.includes("solo"))!.summary).toMatch(/^solo payout solo of \$10\.00/);
  });

  it("reads reported totals however each processor signs and names them", async () => {
    const s = store();
    const affirm = (id: string, settled: number, extra: Record<string, unknown>) => ({ payoutId: `affirm:deposit:${id}`, amountCents: settled, currency: "USD", status: "paid", salesCents: 200_000, ...extra });
    await s.send("payout.updated", affirm("comm", 170_000, { refundCents: 20_000, feeCents: 2_000, commissionCents: 4_000 }), at("2026-10-10"));
    await s.send("payout.updated", affirm("neg", 170_000, { refundCents: -20_000, feeCents: -6_000 }), at("2026-10-10"));
    // A status it doesn't know is not a payout made.
    await s.send("payout.updated", affirm("odd", 1_000, { status: "reversed_maybe" }), at("2026-10-10"));
    await s.send("payout.updated", { ...authBatch("rep", 80_000), chargeCents: 100_000, refundCents: 10_000 }, at("2026-10-10"));
    await s.send("payout.updated", auroraBatch("b9", 100_000, "settled", { salesCents: 150_000, refundsCents: 10_000 }), at("2026-10-10"));
    const recs = about(await s.ask(NOW), "payout");
    const cents = Object.fromEntries(recs.map((r) => [r.id, r.impact?.cents]));
    expect(cents).toEqual({
      "rec_finance_payout_short_affirm:deposit:comm_2026-10-20": 4_000,
      "rec_finance_payout_short_affirm:deposit:neg_2026-10-20": 4_000,
      "rec_finance_payout_short_authorize_net:batch:rep_2026-10-20": 10_000,
      "rec_finance_payout_short_aurora:batch:b9_2026-10-20": 40_000,
    });
  });

  it("doesn't judge a payout with no currency that reads, nor one that covers nothing", async () => {
    const s = store();
    await s.send("payout.updated", klarnaPayout("NC", 1_000, "2026-10-12", { currency: "usdollar" }), at("2026-10-12"));
    await s.send("balance.transaction_recorded", klarnaLine("NC", "sale", 100_000, { currency: "usdollar" }), at("2026-10-11"));
    await s.send("payout.updated", klarnaPayout("NEG", -50_000, "2026-10-12"), at("2026-10-12"));
    await s.send("balance.transaction_recorded", klarnaLine("NEG", "sale", 10_000), at("2026-10-11"));
    await s.send("balance.transaction_recorded", klarnaLine("NEG", "return", -10_000), at("2026-10-11"));
    expect(about(await s.ask(NOW), "payout")).toEqual([]);
  });

  it("puts no dollar figure on a failed payout in another currency", async () => {
    const s = store();
    await s.send("payout.updated", { ...stripePayout("po_eur", 45_000, "failed"), currency: "eur" }, at("2026-10-08"));
    const [rec] = about(await s.ask(NOW), "payout");
    expect(rec!.summary).toContain("payout po_eur of 450.00 EUR");
    expect(rec!.impact).toBeUndefined();
  });

  it("sweeps Stripe lines only into payouts made or on their way, in order, in their currency", async () => {
    // A failed payout paid nothing, so what came available before it is still owed.
    const failed = store();
    await failed.send("payout.updated", stripePayout("po_0", 1_000), at("2026-10-01"));
    await failed.send("balance.transaction_recorded", stripeTxn("t1", "charge", 10_000, 0, "2026-10-03"));
    await failed.send("payout.updated", stripePayout("po_f", 10_000, "failed"), at("2026-10-05"));
    expect(about(await failed.ask(NOW), "payout").map((r) => r.id).sort()).toEqual(["rec_finance_payout_failed_stripe:payout:po_f_2026-10-20", "rec_finance_payout_late_stripe_USD_2026-10-20"]);

    // A pending payout on its way covers what came available before it.
    const onItsWay = store();
    await onItsWay.send("payout.updated", stripePayout("po_0", 1_000), at("2026-10-01"));
    await onItsWay.send("balance.transaction_recorded", stripeTxn("t1", "charge", 10_000, 0, "2026-10-14"));
    await onItsWay.send("payout.updated", stripePayout("po_p", 10_000, "pending", { arrivalDate: "2026-10-19" }), at("2026-10-17"));
    expect(about(await onItsWay.ask(NOW), "payout")).toEqual([]);

    // Read out of order, the earliest payout is still the one with no known start.
    const reversed = store();
    await reversed.send("payout.updated", stripePayout("po_1", 70_000), at("2026-10-05"));
    await reversed.send("balance.transaction_recorded", stripeTxn("txn_1", "charge", 50_000, 1_480, "2026-10-03"));
    await reversed.send("balance.transaction_recorded", stripeTxn("txn_2", "charge", 30_000, 900, "2026-10-05"));
    await reversed.send("payout.updated", stripePayout("po_0", 1_000), at("2026-10-01"));
    expect(about(await reversed.ask(NOW), "payout").map((r) => r.id)).toEqual(["rec_finance_payout_short_stripe:payout:po_1_2026-10-20"]);

    // A line that already names its payout isn't swept into it a second time.
    const named = store();
    await named.send("payout.updated", stripePayout("po_0", 1_000), at("2026-10-01"));
    await named.send("balance.transaction_recorded", { payoutId: "stripe:payout:po_1", type: "sale", amountCents: 10_000, currency: "usd" }, at("2026-10-03"));
    await named.send("payout.updated", stripePayout("po_1", 10_000), at("2026-10-05"));
    expect(about(await named.ask(NOW), "payout")).toEqual([]);

    // Euro payouts sweep euro lines, and euro sales after the last one are late.
    const euro = store();
    await euro.send("payout.updated", { ...stripePayout("po_e0", 1_000), currency: "eur" }, at("2026-10-01"));
    await euro.send("balance.transaction_recorded", stripeTxn("e1", "charge", 50_000, 0, "2026-10-03", "eur"));
    await euro.send("payout.updated", { ...stripePayout("po_e1", 40_000), currency: "eur" }, at("2026-10-05"));
    await euro.send("balance.transaction_recorded", stripeTxn("e2", "charge", 20_000, 0, "2026-10-08", "eur"));
    expect(about(await euro.ask(NOW), "payout").map((r) => r.id).sort()).toEqual(["rec_finance_payout_late_stripe_EUR_2026-10-20", "rec_finance_payout_short_stripe:payout:po_e1_2026-10-20"]);
  });

  it("waits for the newest line under a payout with no record to be due", async () => {
    const s = store();
    await s.send("balance.transaction_recorded", klarnaLine("SPLIT", "sale", 10_000, { capturedAt: "2026-10-01T00:00:00.000Z" }), at("2026-10-01"));
    await s.send("balance.transaction_recorded", klarnaLine("SPLIT", "sale", 10_000, { capturedAt: "2026-10-18T00:00:00.000Z" }), at("2026-10-18"));
    await s.send("balance.transaction_recorded", klarnaLine("EDGE", "sale", 10_000, { capturedAt: "2026-10-10T00:00:00.000Z" }), at("2026-10-10"));
    expect(about(await s.ask(NOW), "payout")).toEqual([]);
    const recs = about(await s.ask("2026-10-21T15:00:00.000Z"), "payout");
    expect(recs.map((r) => r.id)).toEqual(["rec_finance_payout_unrecorded_klarna:payout:EDGE_2026-10-21"]);
    expect(recs[0]).toMatchObject({ confidence: 0.6 });
  });

  it("splits unpaid sales into late and missing at the schedule's and the month's edges", async () => {
    const s = store();
    await s.send("payout.updated", authBatch("B", 10_000), at("2026-10-15"));
    for (const [id, date] of [
      ["d0", "2026-10-16"],
      ["d1", "2026-10-15"],
      ["d30", "2026-09-16"],
      ["d31", "2026-09-15"],
      ["d45", "2026-09-01"],
    ] as const)
      await s.send("payment.charge_updated", authCharge(id, 10_000), at(date));
    const recs = about(await s.ask(NOW), "payout");
    expect(recs.map((r) => r.id).sort()).toEqual(["rec_finance_payout_late_authorize_net_USD_2026-10-20", "rec_finance_payout_missing_authorize_net_USD_2026-10-20"]);
    expect(recs.find((r) => r.id.includes("late"))!.summary).toMatch(/^2 Authorize\.net sales worth \$200\.00, the oldest from 2026-09-16,/);
    expect(recs.find((r) => r.id.includes("missing"))!.summary).toMatch(/^2 Authorize\.net sales worth \$200\.00, the oldest from 2026-09-01,/);
  });

  it("raises missing sales in another currency in its own money, with no dollar figure", async () => {
    const s = store();
    await s.send("payout.updated", { ...authBatch("E", 10_000), currency: "EUR" }, at("2026-10-15"));
    await s.send("payment.charge_updated", { ...authCharge("eu", 25_000), currency: "EUR" }, at("2026-09-01"));
    const [rec, ...rest] = about(await s.ask(NOW), "payout");
    expect(rest).toEqual([]);
    expect(rec).toMatchObject({ id: "rec_finance_payout_missing_authorize_net_EUR_2026-10-20" });
    expect(rec!.summary).toContain("1 Authorize.net sale worth 250.00 EUR");
    expect(rec!.impact).toBeUndefined();
  });

  it("raises unpaid sales with no currency that reads without making one up", async () => {
    const s = store();
    await s.send("payout.updated", { ...authBatch("N", 10_000), currency: null }, at("2026-10-15"));
    await s.send("payment.charge_updated", { ...authCharge("nc", 25_000), currency: null }, at("2026-10-10"));
    const [rec, ...rest] = about(await s.ask(NOW), "payout");
    expect(rest).toEqual([]);
    expect(rec).toMatchObject({ id: "rec_finance_payout_late_authorize_net_unknown_2026-10-20", expectedImpact: "Brings in sales paid out late" });
    expect(rec!.summary).toMatch(/^1 Authorize\.net sale, the oldest from 2026-10-10, has not been paid out/);
    expect(rec!.impact).toBeUndefined();
  });
});
