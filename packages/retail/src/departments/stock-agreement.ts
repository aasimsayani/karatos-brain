import type { EventEnvelope, Reasoner, Recommendation, Signal } from "@karatos/core";
import { z } from "zod";
import { dollars, estimate, extractor, latestBySubject, recommend, signalFrom, value } from "../department.js";

/**
 * Checking that the systems which count stock agree.
 *
 * The store systems write what they have on hand in one type,
 * `inventory.counted`: an item's count, at a location (and, for Cin7 Core,
 * a bin and batch) when the system keeps stock by location. Shopify writes
 * none, but each variant of its `product.updated` carries the quantity
 * Shopify has across its locations. These rules keep each as an
 * `inventory.stock_level` signal, one per system, item and place counted,
 * and then the inventory department adds up what each system has of each
 * item and raises a recommendation when two or more systems disagree.
 *
 * Items are matched by SKU, read without case, spaces, dashes or
 * underscores. Counts are only compared when they hold at about the same
 * time. See docs/departments/README.md#checking-stock-counts-agree for what
 * each system gives and the limits.
 */

/** Two counts are compared only when they held within this many hours of each other. */
export const STOCK_COMPARABLE_HOURS = 24;
/** Counts that disagree by more than this share of the larger are raised; under 20 on hand, any difference is. */
export const STOCK_TOLERANCE_SHARE = 0.05;
/** Counts last known to hold longer ago than this are left alone. */
export const STOCK_LOOKBACK_DAYS = 7;
/** When at least this many items, and half or more of those two systems both count, disagree, it is raised once for the systems. */
export const STOCK_SYSTEMIC_MIN_ITEMS = 5;
export const STOCK_SYSTEMIC_SHARE = 0.5;
/** How many SKUs a recommendation names before it says how many more. */
const SKUS_NAMED = 5;

const HOUR_MS = 3_600_000;

const NAMES: Readonly<Record<string, string>> = {
  shopify: "Shopify",
  katana: "Katana",
  acumatica_jewelshop: "Acumatica JewelShop",
  cin7: "Cin7 Core",
  netsuite: "NetSuite",
  inventory_pos: "the POS export",
  square: "Square",
  clover: "Clover",
  lightspeed: "Lightspeed",
  bigcommerce: "BigCommerce",
  woocommerce: "WooCommerce",
  wix: "Wix",
  etsy: "Etsy",
  squarespace: "Squarespace",
  whatnot: "Whatnot",
  watchtraderhub: "WatchTraderHub",
};

/**
 * Sources whose counts are rows of a dated export: a row holds on its own
 * date only, since a later export may simply leave an item out.
 */
const SNAPSHOT_SOURCES = new Set(["inventory_pos"]);
/** Places whose stock is apart from the store's own, so no other system counts it: Amazon's warehouses. */
const SEPARATE_STOCK = new Set(["amazon:location:fba"]);
/** The SKU a connector makes up for a record that has none; no other system can know it. */
const MADE_UP_SKU = /^(shopify|bigcommerce|clover|ebay|etsy|katana|lightspeed|square|whatnot|wix|woocommerce)-(variant|variation|item|line|listing|product)-/i;

const Text = z.string().nullable().optional();

const CountPayload = z.object({
  system: Text,
  sku: z.string(),
  onHand: z.number().int().nonnegative(),
  locationId: Text,
  location: Text,
  bin: Text,
  batch: Text,
});

const ListingVariant = z.object({
  variantId: z.string().min(1),
  sku: Text,
  inventoryQuantity: z.number().int().nullable().optional(),
});

/** How a reading's time is to be read. */
export type StockReadingKind = "count" | "snapshot" | "listing";

/** One system's count of one item at one place, as the `inventory.stock_level` signal keeps it. */
export type StockReading = {
  source: string;
  system: string | null;
  /** The SKU as the system writes it. */
  sku: string;
  /** The SKU as items are matched: upper case, without spaces, dashes or underscores. */
  skuKey: string;
  /** The place counted, in the system's own terms; null for a count of everything the system has. */
  place: string | null;
  onHand: number;
  kind: StockReadingKind;
  /** When the system says the count was: when it was read, or when it last changed. */
  countedAt: string;
  /** When KaratOS read it. */
  readAt: string;
};

/** A SKU as items are matched across systems: case, spaces, dashes and underscores don't count. */
export const stockSkuKey = (sku: string) => sku.normalize("NFKC").toUpperCase().replace(/[\s\p{Pd}_]+/gu, "");

const nameOf = (source: string, system: string | null) => NAMES[source] ?? system ?? source;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const text = (v: string | null | undefined) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const shownTime = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (items: string[]) => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

function reading(event: EventEnvelope, kind: StockReadingKind, sku: string, place: string | null, onHand: number, system: string | null, slot: string): Signal[] {
  const raw = sku.trim();
  const skuKey = stockSkuKey(raw);
  if (skuKey === "" || MADE_UP_SKU.test(raw)) return [];
  const r: StockReading = { source: event.source, system, sku: raw, skuKey, place, onHand, kind, countedAt: event.occurredAt, readAt: event.receivedAt };
  const subject = { kind: "stock_level", id: `${event.source}|${skuKey}|${slot}` };
  // The subject holds the place, so two variants or places of one event are two signals.
  return [signalFrom(event, "inventory.stock_level", subject, { ...r })];
}

function countReading(event: EventEnvelope): Signal[] {
  const parsed = CountPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const place = text(p.locationId) ?? text(p.location);
  if (place !== null && SEPARATE_STOCK.has(place)) return [];
  // Cin7 Core splits a location's stock by bin and batch, so each split is a place of its own, added up with the rest.
  const slot = [place ?? "", text(p.bin) ?? "", text(p.batch) ?? ""].join("|");
  const kind = SNAPSHOT_SOURCES.has(event.source) ? "snapshot" : "count";
  return reading(event, kind, p.sku, place, p.onHand, text(p.system), slot);
}

function listingReadings(event: EventEnvelope): Signal[] {
  const variants = event.payload.variants;
  if (!Array.isArray(variants)) return [];
  const system = typeof event.payload.system === "string" ? text(event.payload.system) : null;
  return variants.flatMap((v) => {
    const parsed = ListingVariant.safeParse(v);
    if (!parsed.success || typeof parsed.data.sku !== "string" || typeof parsed.data.inventoryQuantity !== "number") return [];
    return reading(event, "listing", parsed.data.sku, null, parsed.data.inventoryQuantity, system, `listing|${parsed.data.variantId}`);
  });
}

export const stockLevelExtractor = extractor("inventory-stock-levels", (event) => {
  if (event.type === "inventory.counted") return countReading(event);
  if (event.type === "product.updated") return listingReadings(event);
  return [];
});

/** When a count is known to have held, as epoch milliseconds. */
interface Span {
  from: number;
  to: number;
}

/** What one system has of one item: its places added up. */
interface Holding {
  source: string;
  name: string;
  sku: string;
  onHand: number;
  places: number;
  span: Span;
  signals: Signal[];
}

const gap = (a: Span, b: Span) => Math.max(0, a.from - b.to, b.from - a.to);
const WINDOW_MS = STOCK_COMPARABLE_HOURS * HOUR_MS;
const allowance = (counts: number[]) => Math.floor(Math.max(...counts.map(Math.abs)) * STOCK_TOLERANCE_SHARE);
const agree = (counts: number[]) => Math.max(...counts) - Math.min(...counts) <= allowance(counts);

/**
 * When a reading is known to hold. A row of an export holds on its own date
 * and a Shopify quantity when it was read, as a product isn't read again
 * when only its stock moves. A store system reads every count each pass and
 * stores one again when it changes, so a count holds from its time until
 * that system was last read.
 */
function spanOf(r: StockReading, lastRead: Map<string, number>): Span {
  const counted = Date.parse(r.countedAt);
  if (r.kind === "snapshot") return { from: counted, to: counted };
  const read = Date.parse(r.readAt);
  if (r.kind === "listing") return { from: read, to: read };
  return { from: counted, to: Math.max(counted, lastRead.get(r.source) ?? read) };
}

/**
 * Each system's holding of each item. Where a system counts an item at
 * several places, they are added up, and the total holds only where every
 * place's count does; a system whose places were counted too far apart has
 * no total for it. A system that writes counts is read by them, not by any
 * quantity on its products.
 */
function holdings(signals: Signal[]): Map<string, Holding[]> {
  const readings = [...latestBySubject(signals, ["inventory.stock_level"]).values()];
  const lastRead = new Map<string, number>();
  for (const s of readings) {
    const r = value<StockReading>(s);
    if (r.kind === "count") lastRead.set(r.source, Math.max(lastRead.get(r.source) ?? 0, Date.parse(r.readAt)));
  }
  const bySystem = new Map<string, Signal[]>();
  for (const s of readings) {
    const r = value<StockReading>(s);
    const key = `${r.skuKey}\u0000${r.source}`;
    bySystem.set(key, [...(bySystem.get(key) ?? []), s]);
  }
  const items = new Map<string, Holding[]>();
  for (const all of bySystem.values()) {
    const counted = all.filter((s) => value<StockReading>(s).kind !== "listing");
    const used = counted.length > 0 ? counted : all;
    const spans = used.map((s) => spanOf(value<StockReading>(s), lastRead));
    const from = Math.max(...spans.map((s) => s.from));
    const to = Math.min(...spans.map((s) => s.to));
    if (from - to > WINDOW_MS) continue;
    const first = value<StockReading>(used[0]!);
    const holding: Holding = {
      source: first.source,
      name: nameOf(first.source, first.system),
      sku: first.sku,
      onHand: used.reduce((n, s) => n + value<StockReading>(s).onHand, 0),
      places: new Set(used.map((s) => value<StockReading>(s).place)).size,
      span: { from: Math.min(from, to), to: Math.max(from, to) },
      signals: used,
    };
    items.set(first.skuKey, [...(items.get(first.skuKey) ?? []), holding]);
  }
  return items;
}

/** The systems whose counts held close enough together to compare, starting from the latest. */
function comparable(list: Holding[]): Holding[] {
  const sorted = [...list].sort((a, b) => b.span.to - a.span.to || a.source.localeCompare(b.source));
  const group: Holding[] = [];
  for (const h of sorted) if (group.every((g) => gap(g.span, h.span) <= WINDOW_MS)) group.push(h);
  return group;
}

/** The one system that disagrees with all the others, when there is one. */
function oddOneOut(group: Holding[]): Holding | null {
  if (group.length < 3) return null;
  const odd = group.filter((h) => agree(group.filter((g) => g !== h).map((g) => g.onHand)));
  return odd.length === 1 ? odd[0]! : null;
}

interface Mismatch {
  skuKey: string;
  sku: string;
  group: Holding[];
  units: number;
}

const shownCount = (h: Holding) => `${h.onHand}${h.places > 1 ? ` across ${h.places} places` : ""} (as of ${shownTime(new Date(h.span.to).toISOString())})`;
const setKey = (group: Holding[]) => group.map((h) => h.source).sort().join("+");

/** What the store paid for each item, by SKU as matched, from the latest receipt of it. */
function costs(signals: Signal[]): Map<string, { cents: number; signal: Signal }> {
  const out = new Map<string, { cents: number; signal: Signal }>();
  for (const s of signals) {
    if (s.kind !== "inventory.received") continue;
    const v = value<{ sku?: unknown; costCents?: unknown }>(s);
    if (typeof v.sku !== "string" || typeof v.costCents !== "number") continue;
    const key = stockSkuKey(v.sku);
    const seen = out.get(key);
    if (!seen || s.observedAt >= seen.signal.observedAt) out.set(key, { cents: v.costCents, signal: s });
  }
  return out;
}

export const stockAgreementReasoner: Reasoner = {
  name: "inventory.stock-agreement",
  reason: ({ organizationId, signals, now }) => {
    const nowMs = Date.parse(now);
    const compared = new Map<string, number>();
    const mismatches: Mismatch[] = [];
    for (const [skuKey, list] of holdings(signals)) {
      const group = comparable(list);
      if (group.length < 2 || nowMs - group[0]!.span.to > STOCK_LOOKBACK_DAYS * 86_400_000) continue;
      const key = setKey(group);
      compared.set(key, (compared.get(key) ?? 0) + 1);
      const counts = group.map((h) => h.onHand);
      if (agree(counts)) continue;
      mismatches.push({ skuKey, sku: group[0]!.sku, group, units: Math.max(...counts) - Math.min(...counts) });
    }

    const bySet = new Map<string, Mismatch[]>();
    for (const m of mismatches) bySet.set(setKey(m.group), [...(bySet.get(setKey(m.group)) ?? []), m]);
    const cost = costs(signals);
    const out: Recommendation[] = [];

    for (const [key, found] of bySet) {
      const total = compared.get(key)!;
      if (found.length >= STOCK_SYSTEMIC_MIN_ITEMS && found.length >= total * STOCK_SYSTEMIC_SHARE) {
        const names = found[0]!.group.map((h) => h.name).sort();
        const skus = found.map((m) => m.sku).sort();
        const named = skus.slice(0, SKUS_NAMED);
        const more = skus.length - named.length;
        out.push(
          recommend({
            department: "inventory",
            key: `stock_systems_${key}`,
            organizationId,
            summary: `${capital(list(names))} disagree on how many they have of ${found.length} of the ${total} items they all count (${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}). So many at once usually means they count different locations, or one has stopped syncing: check which locations each counts, and that each is still syncing, before correcting items one by one.`,
            confidence: 0.6,
            expectedImpact: `Keeps stock in ${list(names)} true for ${plural(found.length, "item")}`,
            basedOn: found.flatMap((m) => m.group.flatMap((h) => h.signals)),
            now,
          }),
        );
        continue;
      }
      for (const m of found) {
        const odd = oddOneOut(m.group);
        const rest = odd ? m.group.filter((h) => h !== odd) : [];
        const said = odd
          ? `${capital(list(rest.map((h) => `${h.name} ${shownCount(h)}`)))} agree, but ${odd.name} has ${shownCount(odd)}.`
          : `${capital(list(m.group.map((h) => `${h.name} has ${shownCount(h)}`)))}.`;
        const fix = odd ? `Count it and correct ${odd.name} if it is wrong` : "Count it and correct the system that is wrong";
        const paid = cost.get(m.skuKey);
        const atCost = paid ? paid.cents * m.units : 0;
        out.push(
          recommend({
            department: "inventory",
            key: `stock_mismatch_${m.skuKey}`,
            organizationId,
            summary: `Stock counts for ${m.sku} disagree: ${said} ${fix}, so it is not sold when it isn't there, or lost track of when it is.`,
            confidence: odd ? 0.75 : 0.65,
            expectedImpact: paid && atCost > 0 ? `Accounts for ${dollars(atCost)} of stock at cost` : `Accounts for ${plural(m.units, "piece")} the systems disagree on`,
            impact: paid ? estimate("protects", `The cost of the ${plural(m.units, "piece")} the counts disagree by, at ${dollars(paid.cents)} each from the latest receipt.`, () => atCost) : undefined,
            basedOn: [...m.group.flatMap((h) => h.signals), ...(paid ? [paid.signal] : [])],
            now,
          }),
        );
      }
    }
    return out;
  },
};

