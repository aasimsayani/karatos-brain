import { BrainPipeline, InMemoryStore, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import { describe, expect, it } from "vitest";
import {
  acumaticaItemEvents,
  cin7StockEvent,
  gemLogicProductEvent,
  inventoryPosConnector,
  katanaCountEvent,
  memoryFileSource,
  netSuiteStockEvent,
  productEvents,
  type ShopifyProduct,
} from "../src/index.js";

/**
 * The store systems' own records, run through every retail department, so
 * the stock check is held to the payloads the connectors really write.
 * Every record here is synthetic.
 */

const ORG = "stock-test";
const RECEIVED = "2026-11-18T08:00:00.000Z";
const NOW = "2026-11-18T15:00:00.000Z";
// GUID-shaped, assembled at runtime so no scanner takes it for a key.
const GUID = ["a".repeat(8), "a".repeat(4), "4aaa", "8aaa", "a".repeat(12)].join("-");

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
    stockRecs: async () => (await pipeline.reason(ORG)).filter((r) => r.id.startsWith("rec_inventory_stock_")),
  };
}

const shopifyProduct = (variants: { id: string; sku: string | null; qty: number | null }[], updatedAt = "2026-10-01T12:00:00Z"): ShopifyProduct => ({
  id: "gid://shopify/Product/1001",
  title: "Synthetic solitaire",
  status: "ACTIVE",
  vendor: "Test Vendor",
  productType: "Rings",
  tags: [],
  updatedAt,
  variants: { nodes: variants.map((v) => ({ id: `gid://shopify/ProductVariant/${v.id}`, sku: v.sku, price: "1200.00", inventoryQuantity: v.qty })) },
});
const katanaRow = (sku: string, location: number, inStock: string) => ({
  variant_id: 501,
  location_id: location,
  quantity_in_stock: inStock,
  quantity_committed: "0",
  variant: { sku, type: "product", product_or_material_name: "Synthetic solitaire" },
});
const acumaticaItem = (sku: string, warehouses: [string, number][]) => ({
  InventoryID: { value: sku },
  LastModified: { value: "2026-09-01T10:00:00Z" },
  Description: { value: "Synthetic solitaire" },
  WarehouseDetails: warehouses.map(([w, qty]) => ({ WarehouseID: { value: w }, QtyOnHand: { value: qty } })),
});
const cin7Stock = (sku: string, onHand: number, extra: Record<string, unknown> = {}) => ({ ID: GUID, SKU: sku, Location: "Main Store", OnHand: onHand, Allocated: 0, Available: onHand, OnOrder: 0, ...extra });

async function posEvents(csv: string, fileTime: string): Promise<Raw[]> {
  const connector = inventoryPosConnector({ source: memoryFileSource({ "items.csv": "SKU,Title,Cost,Retail Price\n", "stock.csv": csv }, fileTime), now: () => new Date(RECEIVED) });
  const out: Raw[] = [];
  for await (const page of connector.historicalImport({ organizationId: ORG, cursor: null }) as AsyncIterable<SourceBatch>) out.push(...(page.events as Raw[]));
  return out;
}

describe("stock counts from the store systems' records", () => {
  it("raises an item Shopify and Katana count differently, matching their SKUs", async () => {
    const b = brain();
    await b.send("shopify", productEvents(shopifyProduct([{ id: "1", sku: "sol-0001", qty: 2 }]), RECEIVED));
    await b.send("katana", [katanaCountEvent(katanaRow("SOL 0001", 1, "3.00000"), { receivedAt: RECEIVED }), katanaCountEvent(katanaRow("SOL 0001", 2, "1"), { receivedAt: RECEIVED })]);
    const recs = await b.stockRecs();
    expect(recs.map((r) => r.id)).toEqual(["rec_inventory_stock_mismatch_SOL0001_2026-11-18"]);
    expect(recs[0]!.summary).toBe(
      "Stock counts for SOL 0001 disagree: Katana has 4 across 2 places (as of 2026-11-18 08:00 UTC) and Shopify has 2 (as of 2026-11-18 08:00 UTC). Count it and correct the system that is wrong, so it is not sold when it isn't there, or lost track of when it is.",
    );
  });

  it("finds Acumatica JewelShop and Cin7 Core agreeing with Katana, and names Shopify as the one out", async () => {
    const b = brain();
    await b.send("acumatica_jewelshop", acumaticaItemEvents(acumaticaItem("SOL-0001", [["MAIN", 3], ["SAFE", 1]]), { receivedAt: RECEIVED, customerKey: "synthetic-key" }));
    await b.send("cin7", [cin7StockEvent(cin7Stock("SOL-0001", 2, { Bin: "A1" }), { receivedAt: RECEIVED }).event, cin7StockEvent(cin7Stock("SOL-0001", 2, { Bin: "A2" }), { receivedAt: RECEIVED }).event]);
    await b.send("katana", [katanaCountEvent(katanaRow("sol-0001", 1, "4"), { receivedAt: RECEIVED })]);
    await b.send("shopify", productEvents(shopifyProduct([{ id: "1", sku: "SOL-0001", qty: 1 }]), RECEIVED));
    const [rec, ...rest] = await b.stockRecs();
    expect(rest).toEqual([]);
    expect(rec!.summary).toContain("Acumatica JewelShop 4 across 2 places (as of 2026-11-18 08:00 UTC), Cin7 Core 4 (as of 2026-11-18 08:00 UTC) and Katana 4 (as of 2026-11-18 08:00 UTC) agree, but Shopify has 1");
    expect(rec!.confidence).toBe(0.75);
  });

  it("compares the POS export's count on its own date, and leaves out one too old to compare", async () => {
    const b = brain();
    await b.send("inventory_pos", await posEvents("SKU,On Hand,Date\nSOL-0001,5,11/18/2026\nSOL-0002,5,11/10/2026", "2026-11-18T07:00:00.000Z"));
    await b.send("netsuite", [netSuiteStockEvent({ item: "77", location: "1", itemid: "SOL-0001", quantityonhand: 3 }, { receivedAt: RECEIVED }).event]);
    await b.send("netsuite", [netSuiteStockEvent({ item: "78", location: "1", itemid: "SOL-0002", quantityonhand: 3 }, { receivedAt: RECEIVED }).event]);
    expect(b.memory.signals.filter((s) => s.kind === "inventory.stock_level").map((s) => (s.value as { kind: string }).kind)).toEqual(["snapshot", "snapshot", "count", "count"]);
    const recs = await b.stockRecs();
    expect(recs.map((r) => r.id)).toEqual(["rec_inventory_stock_mismatch_SOL0001_2026-11-18"]);
    expect(recs[0]!.summary).toContain("NetSuite has 3 (as of 2026-11-18 08:00 UTC) and the POS export has 5 (as of 2026-11-18 00:00 UTC)");
  });

  it("raises nothing when the systems agree, when a record is read again, or for Gem Logic, which gives no counts", async () => {
    const b = brain();
    const shopify = productEvents(shopifyProduct([{ id: "1", sku: "SOL-0001", qty: 4 }, { id: "2", sku: null, qty: 9 }]), RECEIVED);
    await b.send("shopify", [...shopify, ...shopify]);
    const katana = katanaCountEvent(katanaRow("SOL-0001", 1, "4"), { receivedAt: RECEIVED });
    await b.send("katana", [katana, katana]);
    await b.send("gem_logic", [gemLogicProductEvent({ id: 9, item_sku: "SOL-0001", status: "active", created: "2026-11-01" }, { receivedAt: RECEIVED, marketplace: { id: "m1", name: "Test channel" } })]);
    expect(b.memory.signals.filter((s) => s.kind === "inventory.stock_level")).toHaveLength(2);
    expect(await b.stockRecs()).toEqual([]);
  });

  it("skips a Shopify quantity read long before the other system's count", async () => {
    const b = brain();
    await b.send("shopify", productEvents(shopifyProduct([{ id: "1", sku: "SOL-0001", qty: 2 }]), "2026-11-14T08:00:00.000Z"));
    await b.send("katana", [katanaCountEvent(katanaRow("SOL-0001", 1, "4"), { receivedAt: RECEIVED })]);
    expect(await b.stockRecs()).toEqual([]);
  });
});
