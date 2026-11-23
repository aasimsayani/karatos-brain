import { describe, expect, it } from "vitest";
import { sha256Json, type StoredEvent } from "@karatos/core";
import {
  compareRecords,
  salesDay,
  sourceFor,
  syncedRecords,
  systemStatus,
  unavailableMetrics,
  verifyPeriod,
  VERIFY_METRICS,
  VERIFY_SAMPLE_IDS,
  type VerifyMetric,
} from "../src/index.js";

const ORG = "example-jewelers";
const CLEARED = "2026-11-19T12:00:00.000Z";
const NY = "America/New_York";

function stored(id: string, source: string, type: string, occurredAt: string, payload: Record<string, unknown>, opts: { cleared?: boolean; receivedAt?: string } = {}): StoredEvent {
  return {
    id,
    organizationId: ORG,
    source,
    type,
    occurredAt,
    receivedAt: opts.receivedAt ?? occurredAt,
    idempotencyKey: `${source}:${id}`,
    payload: opts.cleared ? { cleared: true, at: CLEARED, reason: "retention" } : payload,
    sourceRef: { system: source, recordId: id },
    payloadSha256: sha256Json(payload),
    payloadClearedAt: opts.cleared ? CLEARED : null,
  };
}
const sale = (ref: string, source: string, at: string, totalCents: unknown, cleared = false) =>
  stored(`evt_${ref}_${at}`, source, "sale.completed", at, { saleId: ref, channel: "store", totalCents, lines: [{ sku: "R1", quantity: 1, unitPriceCents: totalCents }] }, { cleared });
const charge = (ref: string, at: string, receivedAt: string, status: string, capturedCents: unknown, cleared = false) =>
  stored(`evt_${ref}_${receivedAt}`, "stripe", "payment.charge_updated", at, { chargeId: ref, status, capturedCents }, { receivedAt, cleared });
const profile = (ref: string, updated: string, createdAt: unknown, cleared = false) =>
  stored(`evt_${ref}_${updated}`, "klaviyo", "customer.profile_updated", updated, { profileRef: ref, createdAt }, { cleared });

const metric = (metrics: VerifyMetric[], name: string) => metrics.find((m) => m.metric === name)!;

describe("verify periods", () => {
  it("runs from local midnight on the first day to local midnight after the last", () => {
    expect(verifyPeriod("2026-11-01", "2026-11-15", NY)).toEqual({ startDay: "2026-11-01", endDay: "2026-11-15", timeZone: NY, from: "2026-11-01T04:00:00.000Z", to: "2026-11-16T05:00:00.000Z" });
    expect(verifyPeriod("2026-11-18", "2026-11-18", "UTC")).toMatchObject({ from: "2026-11-18T00:00:00.000Z", to: "2026-11-19T00:00:00.000Z" });
  });

  it("is 23 or 25 hours long on the days the clocks change", () => {
    const spring = verifyPeriod("2026-03-08", "2026-03-08", NY);
    const fall = verifyPeriod("2026-11-01", "2026-11-01", NY);
    expect(Date.parse(spring.to) - Date.parse(spring.from)).toBe(23 * 3_600_000);
    expect(Date.parse(fall.to) - Date.parse(fall.from)).toBe(25 * 3_600_000);
  });

  it("puts a late-evening sale on the store's day, not the UTC day", () => {
    const day = verifyPeriod("2026-11-18", "2026-11-18", NY);
    const events = [sale("shopify:order:1", "shopify", "2026-11-19T04:30:00.000Z", 100), sale("shopify:order:2", "shopify", "2026-11-19T05:00:00.000Z", 100)];
    expect(syncedRecords("sales", "shopify", events, day).records.map((r) => r.ref)).toEqual(["shopify:order:1"]);
  });
});

describe("the synced side", () => {
  const day = verifyPeriod("2026-11-18", "2026-11-18", NY);
  const at = "2026-11-18T15:00:00.000Z";

  it("reads sales as the brief counts them: this system's sale events at their totals, each event once", () => {
    const events = [
      sale("shopify:order:1", "shopify", at, 10_000),
      sale("shopify:order:2", "shopify", at, 2_500),
      sale("square:order:9", "square", at, 99_999),
      stored("evt_return", "shopify", "sale.returned", at, { saleId: "shopify:order:1", lines: [{ refundCents: 4_000 }] }),
      sale("shopify:order:3", "shopify", at, 700, true),
      sale("shopify:order:4", "shopify", at, -5),
      sale("shopify:order:5", "shopify", at, 1.5),
      stored("evt_noref", "shopify", "sale.completed", at, { totalCents: 100 }),
      stored("evt_emptyref", "shopify", "sale.completed", at, { saleId: "", totalCents: 100 }),
      // Marked cleared, so never read, whatever its payload still holds.
      { ...sale("shopify:order:6", "shopify", at, 100), payloadClearedAt: CLEARED },
    ];
    const synced = syncedRecords("sales", "shopify", events, day);
    expect(synced.records).toEqual([
      { ref: "shopify:order:1", cents: 10_000 },
      { ref: "shopify:order:2", cents: 2_500 },
    ]);
    expect(synced.uncounted).toBe(6);
    expect(synced.basis).toContain("daily brief");
    // The same gross the brief reports for the system, refunds left to its own figure.
    const brief = salesDay("2026-11-18", NY, { events: events.filter((e) => e.source === "shopify" && e.payloadClearedAt === null && !["evt_noref", "evt_emptyref"].includes(e.id) && !["shopify:order:4", "shopify:order:5"].includes(String(e.payload.saleId))), truncated: false });
    expect(brief.totals.grossCents).toBe(12_500);
    expect(brief.totals.refundCents).toBe(4_000);
  });

  it("leaves out sale events dated outside the period", () => {
    expect(syncedRecords("sales", "shopify", [sale("shopify:order:1", "shopify", "2026-11-17T12:00:00.000Z", 100)], day).records).toEqual([]);
  });

  it("reads each charge at its latest received state, counting those that succeeded with something captured", () => {
    const events = [
      charge("stripe:charge:a", at, "2026-11-18T15:00:01.000Z", "pending", 0),
      charge("stripe:charge:a", at, "2026-11-18T15:05:00.000Z", "succeeded", 5_000),
      charge("stripe:charge:b", at, "2026-11-18T15:00:01.000Z", "succeeded", 7_000),
      charge("stripe:charge:b", at, "2026-11-18T16:00:00.000Z", "failed", 0),
      charge("stripe:charge:c", at, "2026-11-18T15:00:01.000Z", "succeeded", 0),
      charge("stripe:charge:d", at, "2026-11-18T15:00:01.000Z", "succeeded", 1.5),
      charge("stripe:charge:e", at, "2026-11-18T15:00:01.000Z", "succeeded", 300),
      charge("stripe:charge:e", at, "2026-11-18T15:00:01.000Z", "succeeded", 400),
      charge("stripe:charge:f", "2026-11-17T15:00:00.000Z", "2026-11-17T15:00:01.000Z", "succeeded", 900),
      charge("stripe:charge:g", at, "2026-11-18T15:00:01.000Z", "succeeded", 900, true),
      { ...charge("square:payment:x", at, "2026-11-18T15:00:01.000Z", "succeeded", 100), source: "square" },
      // Captured but not succeeded: refunded in full, or still settling.
      charge("stripe:charge:h", at, "2026-11-18T15:00:01.000Z", "pending", 500),
      { ...charge("stripe:charge:i", at, "2026-11-18T15:00:01.000Z", "succeeded", 600), payloadClearedAt: CLEARED },
    ];
    const synced = syncedRecords("charges", "stripe", events, day);
    // e's two states arrived together: the later one stands.
    expect(synced.records).toEqual([
      { ref: "stripe:charge:a", cents: 5_000 },
      { ref: "stripe:charge:e", cents: 400 },
    ]);
    expect(synced.uncounted).toBe(2);
  });

  it("reads each profile once, by the day it was created", () => {
    const events = [
      profile("klaviyo_profile:a", "2026-11-18T15:00:00.000Z", "2026-11-18T15:00:00.000Z"),
      profile("klaviyo_profile:a", "2026-11-20T15:00:00.000Z", "2026-11-18T15:00:00.000Z"),
      profile("klaviyo_profile:b", "2026-11-20T15:00:00.000Z", "2026-11-17T15:00:00.000Z"),
      profile("klaviyo_profile:c", "2026-11-20T15:00:00.000Z", "2026-11-18T23:59:00.000Z"),
      profile("klaviyo_profile:d", "2026-11-20T15:00:00.000Z", undefined),
      profile("klaviyo_profile:e", "2026-11-20T15:00:00.000Z", "2026-11-18T12:00:00.000Z", true),
      stored("evt_noref", "klaviyo", "customer.profile_updated", at, { createdAt: at }),
      { ...profile("klaviyo_profile:f", "2026-11-20T15:00:00.000Z", "2026-11-18T12:00:00.000Z"), payloadClearedAt: CLEARED },
    ];
    const synced = syncedRecords("profiles", "klaviyo", events, day);
    expect(synced.records).toEqual([{ ref: "klaviyo_profile:a" }, { ref: "klaviyo_profile:c" }]);
    expect(synced.uncounted).toBe(3);
    expect(syncedRecords("profiles", "shopify", events, day).records).toEqual([]);
  });
});

describe("comparing the two sides", () => {
  const a = { ref: "shopify:order:1", cents: 10_000 };
  const b = { ref: "shopify:order:2", cents: 2_500 };
  const c = { ref: "shopify:order:3", cents: 7_000 };

  it("matches when every record and every cent agree", () => {
    const metrics = compareRecords({ subject: "sales", source: [a, b], synced: [b, a] });
    expect(metrics).toEqual([
      { metric: "sale_count", unit: "count", status: "match", sourceTotal: 2, syncedTotal: 2, difference: 0, missing: { count: 0, sample: [] }, extra: { count: 0, sample: [] } },
      { metric: "gross_sales", unit: "cents", status: "match", sourceTotal: 12_500, syncedTotal: 12_500, difference: 0, toleranceCents: 0, missing: { count: 0, sample: [] }, extra: { count: 0, sample: [] }, amountDiffers: { count: 0, sample: [] } },
    ]);
    expect(systemStatus(metrics)).toBe("match");
  });

  it("names what is missing and what is extra, synced less source", () => {
    const metrics = compareRecords({ subject: "sales", source: [a, b], synced: [a] });
    expect(metric(metrics, "sale_count")).toMatchObject({ status: "mismatch", sourceTotal: 2, syncedTotal: 1, difference: -1, missing: { count: 1, sample: ["shopify:order:2"] }, extra: { count: 0 } });
    expect(metric(metrics, "gross_sales")).toMatchObject({ status: "mismatch", difference: -2_500 });
    const over = compareRecords({ subject: "sales", source: [a], synced: [a, c] });
    expect(metric(over, "sale_count")).toMatchObject({ status: "mismatch", difference: 1, extra: { count: 1, sample: ["shopify:order:3"] }, missing: { count: 0 } });
    expect(systemStatus(over)).toBe("mismatch");
  });

  it("is a mismatch when the counts agree but the records don't", () => {
    const metrics = compareRecords({ subject: "sales", source: [a, b], synced: [a, { ...c, cents: 2_500 }] });
    expect(metric(metrics, "sale_count")).toMatchObject({ status: "mismatch", difference: 0, missing: { sample: ["shopify:order:2"] }, extra: { sample: ["shopify:order:3"] } });
    expect(metric(metrics, "gross_sales")).toMatchObject({ status: "mismatch", difference: 0 });
  });

  it("counts a record synced twice as extra", () => {
    const metrics = compareRecords({ subject: "sales", source: [a], synced: [a, a] });
    expect(metric(metrics, "sale_count")).toMatchObject({ status: "mismatch", difference: 1, extra: { count: 1, sample: ["shopify:order:1"] }, missing: { count: 0 } });
    expect(metric(compareRecords({ subject: "sales", source: [a, a], synced: [a] }), "sale_count")).toMatchObject({ missing: { count: 1 } });
    // A record's amount is what all its copies add up to.
    const split = compareRecords({ subject: "sales", source: [{ ref: "x", cents: 100 }, { ref: "x", cents: 200 }], synced: [{ ref: "x", cents: 300 }] });
    expect(metric(split, "gross_sales")).toMatchObject({ difference: 0, amountDiffers: { count: 0 }, missing: { count: 1 } });
  });

  it("compares money to the cent unless a tolerance is given, record by record and in total", () => {
    const off = { ...a, cents: 10_001 };
    expect(metric(compareRecords({ subject: "sales", source: [a], synced: [off] }), "gross_sales")).toMatchObject({ status: "mismatch", difference: 1, amountDiffers: { count: 1, sample: ["shopify:order:1"] } });
    expect(metric(compareRecords({ subject: "sales", source: [a], synced: [off] }), "sale_count").status).toBe("match");
    expect(metric(compareRecords({ subject: "sales", source: [a], synced: [off], toleranceCents: 1 }), "gross_sales")).toMatchObject({ status: "match", toleranceCents: 1, amountDiffers: { count: 0 } });
    // Each record within the tolerance, the total past it.
    const both = compareRecords({ subject: "sales", source: [a, b], synced: [off, { ...b, cents: 2_501 }], toleranceCents: 1 });
    expect(metric(both, "gross_sales")).toMatchObject({ status: "mismatch", difference: 2, amountDiffers: { count: 0 } });
    const short = compareRecords({ subject: "sales", source: [a, b], synced: [{ ...a, cents: 9_999 }, { ...b, cents: 2_499 }], toleranceCents: 1 });
    expect(metric(short, "gross_sales")).toMatchObject({ status: "mismatch", difference: -2, amountDiffers: { count: 0 } });
    // Totals that agree, records that don't.
    const swapped = compareRecords({ subject: "sales", source: [a, b], synced: [{ ...a, cents: 2_500 }, { ...b, cents: 10_000 }] });
    expect(metric(swapped, "gross_sales")).toMatchObject({ status: "mismatch", difference: 0, amountDiffers: { count: 2 } });
    expect(() => compareRecords({ subject: "sales", source: [], synced: [], toleranceCents: -1 })).toThrow(RangeError);
    expect(() => compareRecords({ subject: "sales", source: [], synced: [], toleranceCents: 0.5 })).toThrow("whole number of cents");
  });

  it("matches an empty period on both sides", () => {
    expect(systemStatus(compareRecords({ subject: "charges", source: [], synced: [] }))).toBe("match");
  });

  it("compares profiles by count only", () => {
    const metrics = compareRecords({ subject: "profiles", source: [{ ref: "p1" }, { ref: "p2" }], synced: [{ ref: "p1" }] });
    expect(metrics.map((m) => m.metric)).toEqual(["profile_count"]);
    expect(metrics[0]).toMatchObject({ status: "mismatch", difference: -1, missing: { sample: ["p2"] } });
    expect(metrics[0]).not.toHaveProperty("amountDiffers");
  });

  it("lists a sorted sample of ids and counts the rest", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ref: `shopify:order:${String(i).padStart(2, "0")}`, cents: 1 }));
    const m = metric(compareRecords({ subject: "sales", source: [...many].reverse(), synced: [] }), "sale_count");
    expect(m.missing.count).toBe(30);
    expect(m.missing.sample).toHaveLength(VERIFY_SAMPLE_IDS);
    expect(m.missing.sample[0]).toBe("shopify:order:00");
    expect(m.missing.sample.at(-1)).toBe("shopify:order:19");
  });
});

describe("unavailable metrics and system status", () => {
  it("says why for every metric of every subject", () => {
    const metrics = unavailableMetrics(["sales", "profiles"], "not turned on");
    expect(metrics.map((m) => m.metric)).toEqual(["sale_count", "gross_sales", "profile_count"]);
    for (const m of metrics) expect(m).toMatchObject({ status: "unavailable", sourceTotal: null, syncedTotal: null, difference: null, reason: "not turned on", missing: { count: 0, sample: [] }, extra: { count: 0, sample: [] } });
  });

  it("ranks unavailable over mismatch over match, and nothing as unavailable", () => {
    const [match] = compareRecords({ subject: "profiles", source: [], synced: [] });
    const [mismatch] = compareRecords({ subject: "profiles", source: [{ ref: "p" }], synced: [] });
    const [off] = unavailableMetrics(["profiles"], "x");
    expect(systemStatus([match!, mismatch!])).toBe("mismatch");
    expect(systemStatus([match!, mismatch!, off!])).toBe("unavailable");
    expect(systemStatus([match!])).toBe("match");
    expect(systemStatus([])).toBe("unavailable");
  });

  it("finds a subject's source among what a connector reported", () => {
    const sources = [{ subject: "sales" as const, records: [], basis: "x" }];
    expect(sourceFor(sources, "sales")).toBe(sources[0]);
    expect(sourceFor(sources, "charges")).toBeUndefined();
    expect(Object.keys(VERIFY_METRICS)).toEqual(["sales", "charges", "profiles"]);
  });
});
