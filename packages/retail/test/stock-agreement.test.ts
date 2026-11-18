import { BrainPipeline, InMemoryStore, type Recommendation } from "@karatos/core";
import { describe, expect, it } from "vitest";
import {
  combineDepartments,
  inventory,
  RETAIL_DEPARTMENTS,
  STOCK_COMPARABLE_HOURS,
  STOCK_LOOKBACK_DAYS,
  STOCK_SYSTEMIC_MIN_ITEMS,
  STOCK_SYSTEMIC_SHARE,
  STOCK_TOLERANCE_SHARE,
  stockSkuKey,
  type StockReading,
} from "../src/index.js";

const ORG = "stock-test";
const NOW = "2026-11-18T15:00:00.000Z";
const T = "2026-11-18T09:00:00.000Z";
const hoursBefore = (iso: string, h: number) => new Date(Date.parse(iso) - h * 3_600_000).toISOString();

/** A store with every retail department, fed events from named sources with their own read times. */
function brain() {
  const memory = new InMemoryStore();
  let n = 0;
  const pipeline = new BrainPipeline({
    memory,
    ...combineDepartments(RETAIL_DEPARTMENTS),
    documentation: { current: () => ({ documentIds: [], stale: false }) },
    now: () => new Date(NOW),
  });
  const send = (source: string, type: string, payload: Record<string, unknown>, occurredAt = T, receivedAt = occurredAt, key?: string) => {
    n++;
    return pipeline.ingest({ id: `evt_${source}_${n}`, organizationId: ORG, source, type, occurredAt, receivedAt, idempotencyKey: key ?? `${source}:${n}`, payload });
  };
  return {
    memory,
    send,
    count: (source: string, sku: string, onHand: number, extra: Record<string, unknown> = {}, occurredAt = T, receivedAt = occurredAt) =>
      send(source, "inventory.counted", { sku, onHand, ...extra }, occurredAt, receivedAt),
    listing: (source: string, variants: { sku: string | null; qty: number | null; id?: string }[], occurredAt = T, receivedAt = occurredAt) =>
      send(source, "product.updated", {
        productId: `${source}:product:1`,
        title: "Synthetic piece",
        variants: variants.map((v, i) => ({ variantId: v.id ?? `${source}:variant:${i}`, sku: v.sku, priceCents: 10_000, inventoryQuantity: v.qty })),
      }, occurredAt, receivedAt),
    recs: async (): Promise<Recommendation[]> => (await pipeline.reason(ORG)).filter((r) => r.id.startsWith("rec_inventory_stock_")),
    readings: () => memory.signals.filter((s) => s.kind === "inventory.stock_level").map((s) => s.value as StockReading),
  };
}

const ids = (recs: Recommendation[]) => recs.map((r) => r.id);

describe("stock levels kept from the store systems", () => {
  it("keeps each count with its system, SKU, place and times", async () => {
    const b = brain();
    await b.count("katana", " r-1001 ", 3, { system: "Katana", locationId: "katana:location:1" }, T, "2026-11-18T10:00:00.000Z");
    expect(b.readings()).toEqual([
      { source: "katana", system: "Katana", sku: "r-1001", skuKey: "R1001", place: "katana:location:1", onHand: 3, kind: "count", countedAt: T, readAt: "2026-11-18T10:00:00.000Z" },
    ]);
    expect(b.memory.signals.find((s) => s.kind === "inventory.stock_level")!.subject).toEqual({ kind: "stock_level", id: "katana|R1001|katana:location:1||" });
  });

  it("keeps a Cin7 Core count by its location name, bin and batch", async () => {
    const b = brain();
    await b.count("cin7", "R-1", 2, { system: "Cin7 Core", location: "Main Store", bin: "A1", batch: "B7" });
    await b.count("cin7", "R-1", 1, { system: "Cin7 Core", location: "Main Store", bin: "A2", batch: null });
    expect(b.memory.signals.filter((s) => s.kind === "inventory.stock_level").map((s) => s.subject.id)).toEqual(["cin7|R1|Main Store|A1|B7", "cin7|R1|Main Store|A2|"]);
    expect(b.readings().map((r) => r.place)).toEqual(["Main Store", "Main Store"]);
  });

  it("prefers a location ID to a location name, and a count with neither is of everything", async () => {
    const b = brain();
    await b.count("x", "R-1", 2, { locationId: "x:location:1", location: "Front" });
    await b.count("y", "R-1", 2, { locationId: "  ", location: "  " });
    expect(b.readings().map((r) => r.place)).toEqual(["x:location:1", null]);
  });

  it("reads Shopify's quantity on each variant, but not a variant with no SKU or no quantity", async () => {
    const b = brain();
    await b.listing("shopify", [
      { sku: "R-1", qty: 2 },
      { sku: null, qty: 4 },
      { sku: "R-2", qty: null },
      { sku: "shopify-variant-99", qty: 1 },
      { sku: "R-3", qty: -1 },
    ]);
    expect(b.readings().map((r) => [r.sku, r.onHand, r.kind, r.place])).toEqual([
      ["R-1", 2, "listing", null],
      ["R-3", -1, "listing", null],
    ]);
    // Two variants of one event are two signals, never one.
    expect(new Set(b.memory.signals.filter((s) => s.kind === "inventory.stock_level").map((s) => s.id)).size).toBe(2);
  });

  it("ignores a product with no variant list, and a variant with no ID", async () => {
    const b = brain();
    await b.send("shopify", "product.updated", { productId: "shopify:product:1", variants: "none" });
    await b.send("shopify", "product.updated", { productId: "shopify:product:2", variants: [{ sku: "R-1", inventoryQuantity: 1 }] });
    expect(b.readings()).toEqual([]);
  });

  it("keeps the system a product names", async () => {
    const b = brain();
    await b.send("gadget", "product.updated", { system: " Gadget ", variants: [{ variantId: "g:1", sku: "R-1", inventoryQuantity: 1 }] });
    expect(b.readings()[0]).toMatchObject({ system: "Gadget" });
  });

  it("marks the POS export's rows as dated snapshots", async () => {
    const b = brain();
    await b.count("inventory_pos", "R-1", 1, { sourceRow: "stock.csv:2" });
    expect(b.readings()[0]).toMatchObject({ kind: "snapshot", place: null, system: null });
  });

  it("leaves out Amazon's warehouses, made-up SKUs and SKUs that are only dashes", async () => {
    const b = brain();
    await b.count("amazon", "R-1", 4, { locationId: "amazon:location:fba" });
    for (const sku of ["katana-variant-7", "Clover-Item-x", "etsy-listing-1", "woocommerce-product-5", "wix-line-2", "bigcommerce-variation-9", "lightspeed-product-3", "square-variation-1", "whatnot-variant-1", "ebay-item-1", "- _ -"]) {
      await b.count("x", sku, 1);
    }
    await b.count("x", "katana-r-1", 1);
    expect(b.readings().map((r) => r.sku)).toEqual(["katana-r-1"]);
  });

  it("is never fooled into reading a count that doesn't read", async () => {
    const b = brain();
    // The inventory schema dead-letters these before the extractor; the extractor itself still turns them down.
    const [extract] = inventory.extractors.filter((e) => e.name === "inventory-stock-levels");
    const event = (payload: Record<string, unknown>) => ({ id: "e", organizationId: ORG, source: "x", type: "inventory.counted", occurredAt: T, receivedAt: T, idempotencyKey: "e", payload });
    expect(await extract!.extract([], event({ sku: "R-1", onHand: 1.5 }))).toEqual([]);
    expect(await extract!.extract([], event({ sku: "R-1", onHand: -1 }))).toEqual([]);
    expect(await extract!.extract([], event({ onHand: 1 }))).toEqual([]);
    expect(await extract!.extract([], { ...event({ sku: "R-1", onHand: 1 }), type: "order.updated" })).toEqual([]);
    expect(b.readings()).toEqual([]);
  });
});

describe("SKUs as items are matched", () => {
  it("ignores case, spaces, dashes and underscores", () => {
    expect(stockSkuKey(" r-10 01 ")).toBe("R1001");
    expect(stockSkuKey("R_1001")).toBe("R1001");
    expect(stockSkuKey("R–1001")).toBe("R1001");
    expect(stockSkuKey("r\t1001")).toBe("R1001");
    expect(stockSkuKey("ＲＩＮＧ-1")).toBe("RING1");
    expect(stockSkuKey("R.1001/A")).toBe("R.1001/A");
  });

  it("matches the same item written differently by two systems", async () => {
    const b = brain();
    await b.count("katana", "rg-1001 ", 5, { system: "Katana" });
    await b.listing("shopify", [{ sku: "RG 1001", qty: 3 }]);
    const recs = await b.recs();
    expect(ids(recs)).toEqual(["rec_inventory_stock_mismatch_RG1001_2026-11-18"]);
  });
});

describe("comparing counts", () => {
  it("raises nothing when every system agrees", async () => {
    const b = brain();
    await b.count("katana", "R-1", 4, { system: "Katana" });
    await b.count("acumatica_jewelshop", "r-1", 4, { system: "Acumatica" });
    await b.listing("shopify", [{ sku: "R1", qty: 4 }]);
    expect(await b.recs()).toEqual([]);
  });

  it("raises two systems that disagree, naming both with their counts and times", async () => {
    const b = brain();
    await b.count("katana", "R-1", 5, { system: "Katana" }, T, "2026-11-18T09:30:00.000Z");
    await b.listing("shopify", [{ sku: "R-1", qty: 3 }], "2026-11-01T00:00:00.000Z", "2026-11-18T08:00:00.000Z");
    const [rec, ...rest] = await b.recs();
    expect(rest).toEqual([]);
    expect(rec).toMatchObject({
      id: "rec_inventory_stock_mismatch_R1_2026-11-18",
      confidence: 0.65,
      expectedImpact: "Accounts for 2 pieces the systems disagree on",
      summary:
        "Stock counts for R-1 disagree: Katana has 5 (as of 2026-11-18 09:30 UTC) and Shopify has 3 (as of 2026-11-18 08:00 UTC). Count it and correct the system that is wrong, so it is not sold when it isn't there, or lost track of when it is.",
    });
    expect(rec!.impact).toBeUndefined();
    expect(rec!.provenance.signalIds).toHaveLength(2);
    expect(rec!.provenance.eventIds).toHaveLength(2);
  });

  it("says one piece in the singular", async () => {
    const b = brain();
    await b.count("katana", "R-1", 1);
    await b.count("cin7", "R-1", 0);
    expect((await b.recs())[0]!.expectedImpact).toBe("Accounts for 1 piece the systems disagree on");
  });

  it("names a system it has no name for by the name in its record, then by its source", async () => {
    const b = brain();
    await b.count("gadget", "R-1", 1, { system: "Gadget POS" });
    await b.count("other_pos", "R-1", 2);
    await b.count("inventory_pos", "R-1", 3);
    expect((await b.recs())[0]!.summary).toContain("disagree: Gadget POS has 1 (as of 2026-11-18 09:00 UTC), the POS export has 3 (as of 2026-11-18 09:00 UTC) and other_pos has 2 (as of 2026-11-18 09:00 UTC).");
  });

  it("allows a difference of 5% of the larger count, rounded down, and no more", async () => {
    expect(STOCK_TOLERANCE_SHARE).toBe(0.05);
    const pair = async (a: number, c: number) => {
      const b = brain();
      await b.count("katana", "R-1", a);
      await b.count("cin7", "R-1", c);
      return (await b.recs()).length;
    };
    // Under 20 on hand, any difference counts.
    expect(await pair(19, 18)).toBe(1);
    expect(await pair(20, 19)).toBe(0);
    expect(await pair(20, 18)).toBe(1);
    expect(await pair(100, 95)).toBe(0);
    expect(await pair(100, 94)).toBe(1);
    expect(await pair(94, 100)).toBe(1);
    expect(await pair(0, 0)).toBe(0);
    expect(await pair(1, 0)).toBe(1);
  });

  it("judges a negative Shopify quantity by its size", async () => {
    const b = brain();
    await b.listing("shopify", [{ sku: "R-1", qty: -40 }]);
    await b.count("katana", "R-1", 0);
    expect(await b.recs()).toHaveLength(1);
    const c = brain();
    // 5% of 40 is 2, so -40 and -38 are within it.
    await c.listing("shopify", [{ sku: "R-1", qty: -40 }]);
    await c.listing("gadget", [{ sku: "R-1", qty: -38 }]);
    expect(await c.recs()).toEqual([]);
  });

  it("puts a dollar figure on it from what the store paid for the piece", async () => {
    const b = brain();
    await b.send("pos", "inventory.received", { sku: "r 1", title: "Synthetic ring", category: "ring", costCents: 40_000, retailPriceCents: 90_000, quantity: 1 }, "2026-10-01T00:00:00.000Z");
    await b.send("pos", "inventory.received", { sku: "R-1", title: "Synthetic ring", category: "ring", costCents: 50_000, retailPriceCents: 90_000, quantity: 1 }, "2026-11-01T00:00:00.000Z");
    await b.send("pos", "inventory.received", { sku: "R-1", title: "Synthetic ring", category: "ring", costCents: 45_000, retailPriceCents: 90_000, quantity: 1 }, "2026-10-15T00:00:00.000Z");
    await b.count("katana", "R-1", 5);
    await b.count("cin7", "R-1", 2);
    const [rec] = await b.recs();
    expect(rec).toMatchObject({
      expectedImpact: "Accounts for $1,500.00 of stock at cost",
      impact: { kind: "protects", cents: 150_000, lowCents: 150_000, highCents: 150_000, basis: "The cost of the 3 pieces the counts disagree by, at $500.00 each from the latest receipt." },
    });
    expect(rec!.provenance.signalIds.some((id) => id.startsWith("sig_inventory.received_"))).toBe(true);
  });

  it("puts no dollar figure on a piece received at no cost", async () => {
    const b = brain();
    await b.send("pos", "inventory.received", { sku: "R-1", title: "Synthetic ring", category: "ring", costCents: 0, retailPriceCents: 90_000, quantity: 1 }, "2026-11-01T00:00:00.000Z");
    await b.count("katana", "R-1", 5);
    await b.count("cin7", "R-1", 2);
    const [rec] = await b.recs();
    expect(rec!.expectedImpact).toBe("Accounts for 3 pieces the systems disagree on");
    expect(rec!.impact).toBeUndefined();
  });

  it("raises the same recommendation on a second run the same day", async () => {
    const b = brain();
    await b.count("katana", "R-1", 5);
    await b.count("cin7", "R-1", 2);
    const first = ids(await b.recs());
    expect(ids(await b.recs())).toEqual(first);
  });
});

describe("counts too far apart in time", () => {
  it(`compares counts read up to ${STOCK_COMPARABLE_HOURS} hours apart, and not further`, async () => {
    expect(STOCK_COMPARABLE_HOURS).toBe(24);
    const apart = async (hours: number) => {
      const b = brain();
      await b.listing("shopify", [{ sku: "R-1", qty: 3 }], T, T);
      await b.count("inventory_pos", "R-1", 5, {}, hoursBefore(T, hours), T);
      return (await b.recs()).length;
    };
    expect(await apart(24)).toBe(1);
    expect(await apart(24.01)).toBe(0);
    expect(await apart(0)).toBe(1);
  });

  it("dates a Shopify quantity when it was read, not when the product last changed", async () => {
    const b = brain();
    await b.listing("shopify", [{ sku: "R-1", qty: 3 }], "2026-09-01T00:00:00.000Z", T);
    await b.count("inventory_pos", "R-1", 5, {}, hoursBefore(T, 2), T);
    expect(await b.recs()).toHaveLength(1);
    const c = brain();
    await c.listing("shopify", [{ sku: "R-1", qty: 3 }], T, "2026-11-15T00:00:00.000Z");
    await c.count("inventory_pos", "R-1", 5, {}, T, T);
    expect(await c.recs()).toEqual([]);
  });

  it("dates a POS export row by its own date, however late it was imported", async () => {
    const b = brain();
    await b.count("inventory_pos", "R-1", 5, {}, "2026-11-10T09:00:00.000Z", T);
    await b.listing("shopify", [{ sku: "R-1", qty: 3 }], T, T);
    expect(await b.recs()).toEqual([]);
  });

  it("holds a store system's count from its time until that system was last read", async () => {
    const b = brain();
    // Cin7 Core stored this count on the 10th and has not changed it since; another item read today shows it was read again.
    await b.count("cin7", "R-1", 5, {}, "2026-11-10T09:00:00.000Z");
    await b.count("cin7", "R-2", 1, {}, T);
    await b.listing("shopify", [{ sku: "R-1", qty: 3 }], T, T);
    const recs = await b.recs();
    expect(ids(recs)).toEqual(["rec_inventory_stock_mismatch_R1_2026-11-18"]);
    expect(recs[0]!.summary).toContain("Cin7 Core has 5 (as of 2026-11-18 09:00 UTC)");
  });

  it("does not hold a count past its system's last read", async () => {
    const b = brain();
    await b.count("cin7", "R-1", 5, {}, "2026-11-10T09:00:00.000Z");
    await b.count("cin7", "R-2", 1, {}, "2026-11-12T09:00:00.000Z");
    await b.listing("shopify", [{ sku: "R-1", qty: 3 }], T, T);
    expect(await b.recs()).toEqual([]);
  });

  it("holds a count dated after it was read only to its own time", async () => {
    const b = brain();
    await b.count("cin7", "R-1", 5, {}, "2026-11-18T09:00:00.000Z", "2026-11-17T08:00:00.000Z");
    await b.count("katana", "R-1", 3, {}, "2026-11-18T09:00:00.000Z");
    expect(await b.recs()).toHaveLength(1);
    const c = brain();
    await c.count("cin7", "R-1", 5, {}, "2026-11-17T08:00:00.000Z", "2026-11-17T08:00:00.000Z");
    await c.count("katana", "R-1", 3, {}, "2026-11-18T09:00:00.000Z", "2026-11-18T09:00:00.000Z");
    expect(await c.recs()).toEqual([]);
  });

  it(`leaves alone counts last known more than ${STOCK_LOOKBACK_DAYS} days ago`, async () => {
    expect(STOCK_LOOKBACK_DAYS).toBe(7);
    const at = async (when: string) => {
      const b = brain();
      await b.count("katana", "R-1", 5, {}, when);
      await b.count("cin7", "R-1", 2, {}, when);
      return (await b.recs()).length;
    };
    expect(await at("2026-11-11T15:00:00.000Z")).toBe(1);
    expect(await at("2026-11-11T14:59:59.000Z")).toBe(0);
  });

  it("compares the latest counts it can, skipping a system read too long before", async () => {
    const b = brain();
    await b.count("katana", "R-1", 5, {}, T);
    await b.count("cin7", "R-1", 5, {}, hoursBefore(T, 6));
    // Acumatica's count disagrees but is two days older than the rest.
    await b.count("acumatica_jewelshop", "R-1", 1, {}, hoursBefore(T, 48));
    expect(await b.recs()).toEqual([]);
  });

  it("keeps every pair of the systems compared close in time", async () => {
    const b = brain();
    // POS rows at 0h and 40h, Shopify at 20h: Shopify is close to each, but the two rows are not close to each other.
    await b.count("inventory_pos", "R-1", 5, {}, T, T);
    await b.listing("shopify", [{ sku: "R-1", qty: 5 }], hoursBefore(T, 20), hoursBefore(T, 20));
    await b.count("other_export", "R-1", 1, {}, hoursBefore(T, 40), hoursBefore(T, 40));
    // other_export is a store system, held to its own last read, which is its only count.
    expect(await b.recs()).toEqual([]);
  });

  it("lets a newer count of the same place replace the older one", async () => {
    const b = brain();
    await b.count("katana", "R-1", 2, { locationId: "katana:location:1" }, hoursBefore(T, 3));
    await b.count("katana", "R-1", 5, { locationId: "katana:location:1" }, T);
    await b.count("cin7", "R-1", 5, {}, T);
    expect(await b.recs()).toEqual([]);
  });
});

describe("counts by location and in total", () => {
  it("adds up a system's places before comparing it with a system that counts everything", async () => {
    const b = brain();
    await b.count("katana", "R-1", 3, { locationId: "katana:location:1" });
    await b.count("katana", "R-1", 2, { locationId: "katana:location:2" });
    await b.listing("shopify", [{ sku: "R-1", qty: 5 }]);
    expect(await b.recs()).toEqual([]);
  });

  it("says when a count is across several places", async () => {
    const b = brain();
    await b.count("katana", "R-1", 3, { locationId: "katana:location:1" });
    await b.count("katana", "R-1", 2, { locationId: "katana:location:2" });
    await b.listing("shopify", [{ sku: "R-1", qty: 4 }]);
    expect((await b.recs())[0]!.summary).toContain("Katana has 5 across 2 places (as of 2026-11-18 09:00 UTC)");
  });

  it("adds up Cin7 Core's bins and batches as one place", async () => {
    const b = brain();
    await b.count("cin7", "R-1", 2, { location: "Main Store", bin: "A1" });
    await b.count("cin7", "R-1", 1, { location: "Main Store", bin: "A2" });
    await b.count("katana", "R-1", 4);
    const [rec] = await b.recs();
    expect(rec!.summary).toContain("Cin7 Core has 3 (as of");
  });

  it("adds up two Shopify variants with one SKU", async () => {
    const b = brain();
    await b.listing("shopify", [{ sku: "R-1", qty: 2 }, { sku: "r 1", qty: 3, id: "shopify:variant:b" }]);
    await b.count("katana", "R-1", 5);
    expect(await b.recs()).toEqual([]);
  });

  it("has no total for a system whose places were counted too far apart", async () => {
    const b = brain();
    await b.count("inventory_pos", "R-1", 3, { locationId: "pos:1" }, T);
    await b.count("inventory_pos", "R-1", 9, { locationId: "pos:2" }, hoursBefore(T, 30));
    await b.count("katana", "R-1", 3);
    expect(await b.recs()).toEqual([]);
    const c = brain();
    await c.count("inventory_pos", "R-1", 3, { locationId: "pos:1" }, T);
    await c.count("inventory_pos", "R-1", 9, { locationId: "pos:2" }, hoursBefore(T, 24));
    await c.count("katana", "R-1", 3);
    expect(await c.recs()).toHaveLength(1);
  });

  it("reads a system by its counts, not by the quantity on its products", async () => {
    const b = brain();
    await b.listing("square", [{ sku: "R-1", qty: 9 }]);
    await b.count("square", "R-1", 5, { locationId: "square:location:1" });
    await b.count("katana", "R-1", 5);
    expect(await b.recs()).toEqual([]);
  });

  it("never compares a system with itself", async () => {
    const b = brain();
    await b.count("katana", "R-1", 3, { locationId: "katana:location:1" });
    await b.count("katana", "R-1", 9, { locationId: "katana:location:2" });
    expect(await b.recs()).toEqual([]);
  });
});

describe("three or more systems", () => {
  it("names the one system that disagrees with the rest", async () => {
    const b = brain();
    await b.count("katana", "R-1", 5, { system: "Katana" });
    await b.count("acumatica_jewelshop", "R-1", 5, { system: "Acumatica" });
    await b.listing("shopify", [{ sku: "R-1", qty: 3 }]);
    const [rec, ...rest] = await b.recs();
    expect(rest).toEqual([]);
    expect(rec).toMatchObject({
      confidence: 0.75,
      summary:
        "Stock counts for R-1 disagree: Acumatica JewelShop 5 (as of 2026-11-18 09:00 UTC) and Katana 5 (as of 2026-11-18 09:00 UTC) agree, but Shopify has 3 (as of 2026-11-18 09:00 UTC). Count it and correct Shopify if it is wrong, so it is not sold when it isn't there, or lost track of when it is.",
    });
    expect(rec!.provenance.signalIds).toHaveLength(3);
  });

  it("names no one when no single system is out", async () => {
    const b = brain();
    await b.count("katana", "R-1", 5);
    await b.count("acumatica_jewelshop", "R-1", 4);
    await b.count("cin7", "R-1", 3);
    const [rec] = await b.recs();
    expect(rec).toMatchObject({ confidence: 0.65 });
    expect(rec!.summary).toContain("Acumatica JewelShop has 4 (as of 2026-11-18 09:00 UTC), Cin7 Core has 3 (as of 2026-11-18 09:00 UTC) and Katana has 5 (as of 2026-11-18 09:00 UTC). Count it and correct the system that is wrong");
  });

  it("lists four agreeing systems against the one that is out", async () => {
    const b = brain();
    for (const s of ["katana", "cin7", "netsuite", "square"]) await b.count(s, "R-1", 2);
    await b.count("clover", "R-1", 7);
    const [rec] = await b.recs();
    expect(rec!.summary).toContain("Cin7 Core 2 (as of 2026-11-18 09:00 UTC), Katana 2 (as of 2026-11-18 09:00 UTC), NetSuite 2 (as of 2026-11-18 09:00 UTC) and Square 2 (as of 2026-11-18 09:00 UTC) agree, but Clover has 7");
  });

  it("names no one when two systems each disagree with the rest", async () => {
    const b = brain();
    await b.count("katana", "R-1", 5);
    await b.count("cin7", "R-1", 5);
    await b.count("netsuite", "R-1", 2);
    await b.count("square", "R-1", 1);
    expect((await b.recs())[0]!.summary).toContain("correct the system that is wrong");
  });
});

describe("duplicates and many items at once", () => {
  it("counts a record read twice once", async () => {
    const b = brain();
    const first = await b.send("katana", "inventory.counted", { sku: "R-1", onHand: 5 }, T, T, "katana:count:1");
    const again = await b.send("katana", "inventory.counted", { sku: "R-1", onHand: 5 }, T, T, "katana:count:1");
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    await b.count("cin7", "R-1", 5);
    expect(b.readings()).toHaveLength(2);
    expect(await b.recs()).toEqual([]);
  });

  it("raises one recommendation per item, not per pair of systems", async () => {
    const b = brain();
    await b.count("katana", "R-1", 5);
    await b.count("cin7", "R-1", 4);
    await b.count("netsuite", "R-1", 3);
    await b.count("katana", "R-2", 1);
    await b.count("cin7", "R-2", 0);
    expect(ids(await b.recs()).sort()).toEqual(["rec_inventory_stock_mismatch_R1_2026-11-18", "rec_inventory_stock_mismatch_R2_2026-11-18"]);
  });

  it("raises nothing for an item only one system counts", async () => {
    const b = brain();
    await b.count("katana", "R-1", 5);
    await b.listing("shopify", [{ sku: "R-2", qty: 1 }]);
    expect(await b.recs()).toEqual([]);
  });

  it("raises many items two systems disagree on once, for the two systems", async () => {
    expect([STOCK_SYSTEMIC_MIN_ITEMS, STOCK_SYSTEMIC_SHARE]).toEqual([5, 0.5]);
    const b = brain();
    for (let i = 1; i <= 7; i++) {
      await b.count("katana", `R-${i}`, 5);
      await b.listing("shopify", [{ sku: `R-${i}`, qty: 2 }], T, T);
    }
    for (let i = 8; i <= 10; i++) {
      await b.count("katana", `R-${i}`, 5);
      await b.listing("shopify", [{ sku: `R-${i}`, qty: 5 }], T, T);
    }
    // A third system on one item puts that item in a set of its own.
    await b.count("cin7", "R-9", 1);
    const recs = await b.recs();
    expect(ids(recs).sort()).toEqual(["rec_inventory_stock_mismatch_R9_2026-11-18", "rec_inventory_stock_systems_katana+shopify_2026-11-18"]);
    const systems = recs.find((r) => r.id.includes("systems"))!;
    expect(systems).toMatchObject({
      confidence: 0.6,
      expectedImpact: "Keeps stock in Katana and Shopify true for 7 items",
      summary:
        "Katana and Shopify disagree on how many they have of 7 of the 9 items they all count (R-1, R-2, R-3, R-4, R-5 and 2 more). So many at once usually means they count different locations, or one has stopped syncing: check which locations each counts, and that each is still syncing, before correcting items one by one.",
    });
    expect(systems.impact).toBeUndefined();
    expect(systems.provenance.signalIds).toHaveLength(14);
  });

  it("raises each item when fewer than five disagree", async () => {
    const b = brain();
    for (let i = 1; i <= 4; i++) {
      await b.count("katana", `R-${i}`, 5);
      await b.count("cin7", `R-${i}`, 2);
    }
    expect(await b.recs()).toHaveLength(4);
  });

  it("raises each item when under half of those both count disagree", async () => {
    const b = brain();
    for (let i = 1; i <= 11; i++) {
      await b.count("katana", `R-${i}`, 5);
      await b.count("cin7", `R-${i}`, i <= 5 ? 2 : 5);
    }
    expect(await b.recs()).toHaveLength(5);
    const c = brain();
    for (let i = 1; i <= 10; i++) {
      await c.count("katana", `R-${i}`, 5);
      await c.count("cin7", `R-${i}`, i <= 5 ? 2 : 5);
    }
    expect(ids(await c.recs())).toEqual(["rec_inventory_stock_systems_cin7+katana_2026-11-18"]);
  });

  it("names every SKU when five disagree", async () => {
    const b = brain();
    for (let i = 1; i <= 5; i++) {
      await b.count("katana", `R-${i}`, 5);
      await b.count("cin7", `R-${i}`, 2);
    }
    expect((await b.recs())[0]!.summary).toContain("of 5 of the 5 items they all count (R-1, R-2, R-3, R-4, R-5). So");
  });
});

describe("edges a mutation check found untested", () => {
  it("names every store system it knows", async () => {
    const names: Record<string, string> = {
      lightspeed: "Lightspeed",
      bigcommerce: "BigCommerce",
      woocommerce: "WooCommerce",
      wix: "Wix",
      etsy: "Etsy",
      squarespace: "Squarespace",
      whatnot: "Whatnot",
      watchtraderhub: "WatchTraderHub",
    };
    for (const [source, name] of Object.entries(names)) {
      const b = brain();
      await b.count(source, "R-1", 1, { system: "raw name" });
      await b.count("katana", "R-1", 2, {}, hoursBefore(T, 1));
      expect((await b.recs())[0]!.summary).toContain(`disagree: ${name} has 1`);
    }
  });

  it("starts a sentence with a capital, even for the POS export", async () => {
    const b = brain();
    await b.count("inventory_pos", "R-1", 1);
    await b.count("katana", "R-1", 2, {}, hoursBefore(T, 1));
    expect((await b.recs())[0]!.summary).toContain("disagree: The POS export has 1");
  });

  it("only leaves out a made-up SKU that starts the SKU and ends in a dash", async () => {
    const b = brain();
    for (const sku of ["r-katana-variant-1", "katana-items-1", "katana-variant-1"]) await b.count("x", sku, 1);
    expect(b.readings().map((r) => r.sku)).toEqual(["r-katana-variant-1", "katana-items-1"]);
  });

  it("turns down a Shopify quantity that isn't a whole number, and variants on other events", async () => {
    const b = brain();
    await b.listing("shopify", [{ sku: "R-1", qty: 1.5 }]);
    await b.send("shopify", "order.updated", { variants: [{ variantId: "v", sku: "R-2", inventoryQuantity: 1 }] });
    expect(b.readings()).toEqual([]);
  });

  it(`compares nothing even a few milliseconds past ${STOCK_COMPARABLE_HOURS} hours apart`, async () => {
    const b = brain();
    await b.listing("shopify", [{ sku: "R-1", qty: 3 }], T, T);
    await b.count("inventory_pos", "R-1", 5, {}, new Date(Date.parse(T) - 24 * 3_600_000 - 10).toISOString(), T);
    expect(await b.recs()).toEqual([]);
  });

  it("compares a dated row that falls inside the time a store system's count held", async () => {
    const b = brain();
    await b.count("cin7", "R-1", 5, {}, "2026-11-10T09:00:00.000Z");
    await b.count("cin7", "R-2", 1, {}, T);
    await b.count("inventory_pos", "R-1", 2, {}, hoursBefore(T, 30), T);
    expect(await b.recs()).toHaveLength(1);
  });

  it("does not hold a Shopify quantity back to when its product last changed", async () => {
    const b = brain();
    await b.listing("shopify", [{ sku: "R-1", qty: 3 }], "2026-09-01T00:00:00.000Z", T);
    await b.count("inventory_pos", "R-1", 5, {}, hoursBefore(T, 30), T);
    expect(await b.recs()).toEqual([]);
  });

  it("does not let a system's product reads stand for when its counts were read", async () => {
    const b = brain();
    await b.count("square", "R-1", 5, {}, "2026-11-10T09:00:00.000Z");
    await b.listing("square", [{ sku: "R-9", qty: 1 }], T, T);
    await b.count("katana", "R-1", 3);
    expect(await b.recs()).toEqual([]);
  });

  it("takes a system's last read as its latest, in whatever order its counts came", async () => {
    const b = brain();
    await b.count("cin7", "R-2", 1, {}, T);
    await b.count("cin7", "R-1", 5, {}, "2026-11-10T09:00:00.000Z");
    await b.listing("shopify", [{ sku: "R-1", qty: 3 }], T, T);
    expect(await b.recs()).toHaveLength(1);
  });

  it("drops a system's total when its newest place is too far from its oldest", async () => {
    const b = brain();
    await b.count("inventory_pos", "R-1", 3, { locationId: "pos:1" }, T);
    await b.count("inventory_pos", "R-1", 9, { locationId: "pos:2" }, hoursBefore(T, 30));
    await b.count("katana", "R-1", 3, {}, hoursBefore(T, 27));
    expect(await b.recs()).toEqual([]);
  });

  it("dates a total across places to the latest of them", async () => {
    const b = brain();
    await b.count("inventory_pos", "R-1", 3, { locationId: "pos:1" }, T);
    await b.count("inventory_pos", "R-1", 9, { locationId: "pos:2" }, hoursBefore(T, 20));
    await b.count("katana", "R-1", 3, {}, T);
    const [rec] = await b.recs();
    expect(rec!.summary).toContain("The POS export has 12 across 2 places (as of 2026-11-18 09:00 UTC)");
    expect(rec!.provenance.signalIds).toHaveLength(3);
  });

  it("names no one when two systems could each be the one out", async () => {
    const b = brain();
    // 100 and 96 agree, and so do 96 and 92, but not all three.
    await b.count("katana", "R-1", 100);
    await b.count("cin7", "R-1", 96);
    await b.count("netsuite", "R-1", 92);
    expect((await b.recs())[0]!.summary).toContain("correct the system that is wrong");
  });

  it("raises systems together whichever of them was read last, naming SKUs and systems in order", async () => {
    const b = brain();
    for (const i of [6, 3, 1, 5, 2, 4]) {
      const posLast = i % 2 === 0;
      const [pos, shop] = posLast ? [T, hoursBefore(T, 1)] : [hoursBefore(T, 1), T];
      await b.count("inventory_pos", `R-${i}`, 5, { locationId: "pos:1" }, pos);
      await b.count("inventory_pos", `R-${i}`, 1, { locationId: "pos:2" }, pos);
      await b.listing("shopify", [{ sku: `R-${i}`, qty: 2 }], shop, shop);
    }
    const recs = await b.recs();
    expect(ids(recs)).toEqual(["rec_inventory_stock_systems_inventory_pos+shopify_2026-11-18"]);
    expect(recs[0]!.summary).toContain("Shopify and the POS export disagree on how many they have of 6 of the 6 items they all count (R-1, R-2, R-3, R-4, R-5 and 1 more)");
    expect(recs[0]!.provenance.signalIds).toHaveLength(18);
  });

  it("takes the cost of a piece from its receipt, not from a memo for it", async () => {
    const b = brain();
    await b.send("pos", "inventory.received", { sku: "R-1", title: "Synthetic ring", category: "ring", costCents: 50_000, retailPriceCents: 90_000, quantity: 1 }, "2026-11-01T00:00:00.000Z");
    await b.send("pos", "memo.received", { memoId: "m-1", vendorId: "v-1", sku: "R-1", costCents: 1_000, dueBack: "2026-12-30" }, "2026-11-10T00:00:00.000Z");
    await b.count("katana", "R-1", 2);
    await b.count("cin7", "R-1", 1);
    expect((await b.recs())[0]!.impact).toMatchObject({ cents: 50_000 });
  });
});
