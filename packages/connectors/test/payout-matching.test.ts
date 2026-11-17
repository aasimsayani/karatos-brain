import { BrainPipeline, InMemoryStore } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import { describe, expect, it } from "vitest";
import {
  affirmSettlementEvents,
  auroraBatchEvent,
  auroraTransactionEvent,
  authorizeNetBatchEvents,
  authorizeNetTransactionEvents,
  balanceTransactionEvent,
  klarnaPayoutEvent,
  klarnaTransactionEvent,
  payoutEvent,
  type StripeBalanceTransaction,
  type StripePayout,
} from "../src/index.js";

/**
 * The payment connectors' own records, run through every retail department,
 * so payout matching is checked against the payloads the connectors really
 * write. Every record here is synthetic.
 */

const ORG = "payout-test";
const RECEIVED = "2026-10-20T00:00:00.000Z";
const NOW = "2026-10-20T15:00:00.000Z";
const unix = (iso: string) => Date.parse(iso) / 1000;

type Raw = { id: string; type: string; occurredAt: string | undefined; receivedAt: string; idempotencyKey: string; payload: Record<string, unknown> };

function brain() {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({
    memory,
    ...combineDepartments(RETAIL_DEPARTMENTS),
    documentation: { current: () => ({ documentIds: [], stale: false }) },
    now: () => new Date(NOW),
  });
  return {
    memory,
    send: async (source: string, events: Raw[]) => {
      for (const e of events) await pipeline.ingest({ ...e, organizationId: ORG, source });
    },
    payoutRecs: async () => (await pipeline.reason(ORG)).filter((r) => r.id.startsWith("rec_finance_payout_")),
  };
}

const klarnaPayout = (ref: string, settled: number) => ({
  payment_reference: ref,
  payout_date: "2026-10-12T06:00:00Z",
  currency_code: "USD",
  merchant_settlement_type: "NET",
  totals: { settlement_amount: settled, sale_amount: 100_000, return_amount: 13_600, fee_amount: 1_200 },
});
const klarnaLine = (type: string, amount: number, captured = "2026-10-11T10:00:00Z") => ({
  type,
  amount,
  currency_code: "USD",
  order_id: "order-1",
  capture_id: "capture-1",
  sale_date: "2026-10-10T10:00:00Z",
  capture_date: captured,
  merchant_reference1: "SALE-1001",
});
const stripePayout = (id: string, amount: number, created: string, status = "paid"): StripePayout => ({
  id,
  object: "payout",
  amount,
  currency: "usd",
  created: unix(created),
  arrival_date: unix(created) + 86_400,
  status,
  method: "standard",
  type: "bank_account",
});
const stripeTxn = (id: string, type: string, amount: number, fee: number, availableOn: string): StripeBalanceTransaction => ({
  id,
  object: "balance_transaction",
  amount,
  fee,
  net: amount - fee,
  currency: "usd",
  created: unix(availableOn) - 2 * 86_400,
  available_on: unix(availableOn),
  type,
  reporting_category: type,
  source: null,
});

describe("payout matching from the payment connectors' records", () => {
  it("matches a Klarna payout to its lines, and raises one paid short", async () => {
    const b = brain();
    const lines = (ref: string) =>
      [klarnaLine("SALE", 100_000), klarnaLine("RETURN", -13_600), klarnaLine("FEE", -1_200)].map((l, line) => klarnaTransactionEvent(l, { receivedAt: RECEIVED, paymentReference: ref, line }));
    await b.send("klarna", [klarnaPayoutEvent(klarnaPayout("XISA0001", 85_200), { receivedAt: RECEIVED }), ...lines("XISA0001")]);
    await b.send("klarna", [klarnaPayoutEvent(klarnaPayout("XISA0002", 80_000), { receivedAt: RECEIVED }), ...lines("XISA0002")]);
    const recs = await b.payoutRecs();
    expect(recs.map((r) => r.id)).toEqual(["rec_finance_payout_short_klarna:payout:XISA0002_2026-10-20"]);
    expect(recs[0]).toMatchObject({ impact: { kind: "protects", cents: 5_200 } });
    expect(b.memory.signals.filter((s) => s.kind === "payout.line").map((s) => (s.value as { orderId: string }).orderId)).toContain("klarna:order:order-1");
  });

  it("raises Klarna lines whose payout was dead-lettered", async () => {
    const b = brain();
    const unreadable = klarnaPayoutEvent({ ...klarnaPayout("XISA0003", 85_200), totals: {} }, { receivedAt: RECEIVED });
    await expect(b.send("klarna", [unreadable])).rejects.toThrow("dead-lettered");
    // Its line still reads, and is stored under the payout it names.
    await b.send("klarna", [klarnaTransactionEvent(klarnaLine("SALE", 100_000, "2026-10-05T10:00:00Z"), { receivedAt: RECEIVED, paymentReference: "XISA0003", line: 0 })]);
    expect(b.memory.deadLetters).toHaveLength(1);
    expect((await b.payoutRecs()).map((r) => r.id)).toEqual(["rec_finance_payout_unrecorded_klarna:payout:XISA0003_2026-10-20"]);
  });

  it("matches Stripe payouts to the balance that came available, and raises a failed one", async () => {
    const b = brain();
    await b.send("stripe", [
      payoutEvent(stripePayout("po_A", 500, "2026-10-01T09:00:00Z"), RECEIVED),
      balanceTransactionEvent(stripeTxn("txn_A", "charge", 50_000, 1_480, "2026-10-03T00:00:00Z"), RECEIVED),
      balanceTransactionEvent(stripeTxn("txn_B", "refund", -5_000, 0, "2026-10-04T00:00:00Z"), RECEIVED),
      balanceTransactionEvent(stripeTxn("txn_C", "payout", -43_520, 0, "2026-10-05T00:00:00Z"), RECEIVED),
      payoutEvent(stripePayout("po_B", 43_520, "2026-10-05T09:00:00Z"), RECEIVED),
      payoutEvent(stripePayout("po_C", 12_000, "2026-10-08T09:00:00Z", "failed"), RECEIVED),
    ]);
    expect((await b.payoutRecs()).map((r) => r.id)).toEqual(["rec_finance_payout_failed_stripe:payout:po_C_2026-10-20"]);
  });

  it("matches Aurora batches to their transactions, and raises one left open", async () => {
    const b = brain();
    const batch = (id: string, statusId: number, net: number) => ({ id, externalBatchId: "0000000042", batchDateTime: "2026-10-12T22:00:00Z", statusId, transactionCount: 2, salesAmount: 1299.75, refundsAmount: 50, netAmount: net });
    const txn = (id: string, typeId: number, total: number) => ({ id, date: "2026-10-12T15:00:00Z", typeId, status: "Captured", paymentMethodTypeId: 1, currencyCode: "USD", baseAmount: total, totalAmount: total });
    await b.send("aurora_payments", [
      auroraBatchEvent(batch("b-1", 2, 1249.75), { receivedAt: RECEIVED }),
      auroraTransactionEvent(txn("t-1", 2, 1299.75), { receivedAt: RECEIVED, batchId: "b-1" }),
      auroraTransactionEvent(txn("t-2", 5, 50), { receivedAt: RECEIVED, batchId: "b-1" }),
      auroraBatchEvent(batch("b-2", 1, 300), { receivedAt: RECEIVED }),
    ]);
    expect((await b.payoutRecs()).map((r) => r.id)).toEqual(["rec_finance_payout_pending_aurora:batch:b-2_2026-10-20"]);
  });

  it("matches Authorize.net batches to their charges and raises charges left unsettled", async () => {
    const b = brain();
    const charge = (transId: string, status: string, amount: string, submitted: string) => ({ transId, submitTimeUTC: submitted, transactionStatus: status, settleAmount: amount, accountType: "Visa", marketType: "Retail" });
    await b.send("authorize_net", [
      ...authorizeNetBatchEvents({ batchId: "9001", settlementTimeUTC: "2026-10-12T03:00:00Z", settlementState: "settledSuccessfully", paymentMethod: "creditCard", statistics: [{ chargeAmount: "1500.00", refundAmount: "100.00" }] }, "USD", RECEIVED),
      ...authorizeNetTransactionEvents(charge("101", "settledSuccessfully", "1500.00", "2026-10-11T18:00:00Z"), { currency: "USD", batchId: "9001" }, RECEIVED),
      ...authorizeNetTransactionEvents(charge("102", "refundSettledSuccessfully", "100.00", "2026-10-11T19:00:00Z"), { currency: "USD", batchId: "9001", refTransId: "101" }, RECEIVED),
      ...authorizeNetTransactionEvents(charge("103", "capturedPendingSettlement", "250.00", "2026-10-13T18:00:00Z"), { currency: "USD" }, RECEIVED),
    ]);
    expect((await b.payoutRecs()).map((r) => r.id)).toEqual(["rec_finance_payout_late_authorize_net_USD_2026-10-20"]);
  });

  it("checks an Affirm settlement against the totals it reports", async () => {
    const b = brain();
    const day = (deposit_id: string, total_settled: number) => ({ deposit_id, date: "2026-10-10", total_sales: 200_000, total_refunds: 20_000, total_fees: 6_000, total_settled, currency: "USD" });
    await b.send("affirm", [...affirmSettlementEvents(day("dep-1", 174_000), RECEIVED), ...affirmSettlementEvents(day("dep-2", 170_000), RECEIVED)]);
    expect((await b.payoutRecs()).map((r) => r.id)).toEqual(["rec_finance_payout_short_affirm:deposit:dep-2_2026-10-20"]);
  });
});
