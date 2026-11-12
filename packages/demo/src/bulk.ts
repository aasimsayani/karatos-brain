/**
 * The everyday business of a busy store, made up the same way every time.
 *
 * The story pieces in store.ts each show one problem. This file adds the
 * rest of a store doing about $2 million a year: a full case of pieces that
 * sell, a few hundred customers, a year of card and financing sales, and the
 * repair envelopes that go out on time. None of it should raise a
 * recommendation on its own. It is there so the numbers read like a real
 * store, and so the problems have to be found among normal business.
 *
 * Rules the generator keeps so the dashboard stays about the story:
 * - Every piece sold in the last 120 days, so none is aged stock.
 * - Every piece has at least 2 left, so none needs reordering.
 * - Returns stay under one in four sales of a piece.
 * - Customers bought in the last year and paid by card or financing, so no
 *   VIP has lapsed and no cash rule fires.
 * - Repairs are picked up, or at the bench ahead of their promised date.
 */
import type { DemoCustomer, DemoItem, DemoRepair, DemoSaleLine, Tender } from "./store.js";

/** A small seeded random number generator (mulberry32), so the store is the same on every seed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Style {
  category: string;
  /** Title words; one is picked. */
  names: string[];
  metal?: DemoItem["metal"];
  karats?: number[];
  grams: [number, number];
  /** Retail price range in dollars. */
  retail: [number, number];
  vendor: string;
  /** How many of this style the case carries. */
  count: number;
}

const STYLES: Style[] = [
  { category: "Engagement Ring", names: ["Round Diamond Solitaire", "Oval Diamond Halo", "Cushion Diamond Hidden Halo", "Three Stone Diamond", "Emerald Cut Diamond Solitaire", "Pear Diamond Pave"], metal: "gold", karats: [14, 18], grams: [2.8, 5.5], retail: [2_800, 12_500], vendor: "Sample Bridal Supply", count: 34 },
  { category: "Wedding Band", names: ["Comfort Fit Band", "Diamond Eternity Band", "Milgrain Band", "Brushed Center Band", "Curved Diamond Band"], metal: "gold", karats: [14, 18], grams: [3, 8], retail: [650, 3_900], vendor: "Sample Bridal Supply", count: 26 },
  { category: "Wedding Band", names: ["Platinum Comfort Fit Band", "Platinum Diamond Eternity Band"], metal: "platinum", grams: [6, 11], retail: [1_400, 4_800], vendor: "Sample Bridal Supply", count: 6 },
  { category: "Earrings", names: ["Diamond Stud Earrings", "Huggie Hoop Earrings", "Pearl Drop Earrings", "Diamond Halo Studs", "Sapphire Stud Earrings", "Gold Knot Studs"], metal: "gold", karats: [14], grams: [1.2, 4], retail: [320, 4_200], vendor: "Demo Findings Co", count: 30 },
  { category: "Necklace", names: ["Diamond Bezel Necklace", "Paperclip Chain", "Rope Chain", "Tennis Necklace", "Initial Necklace", "Station Necklace"], metal: "gold", karats: [10, 14, 18], grams: [2, 22], retail: [380, 9_500], vendor: "Demo Findings Co", count: 28 },
  { category: "Necklace", names: ["Sterling Silver Box Chain", "Sterling Silver Figaro Chain", "Sterling Silver Locket"], metal: "silver", grams: [8, 40], retail: [90, 420], vendor: "Demo Findings Co", count: 10 },
  { category: "Pendant", names: ["Diamond Cross Pendant", "Birthstone Pendant", "Heart Pendant", "Solitaire Pendant", "Medallion Pendant"], metal: "gold", karats: [14], grams: [1, 6], retail: [260, 3_400], vendor: "Demo Findings Co", count: 18 },
  { category: "Bracelet", names: ["Diamond Tennis Bracelet", "Cuban Link Bracelet", "Bangle", "Diamond Station Bracelet", "Charm Bracelet"], metal: "gold", karats: [14, 18], grams: [4, 28], retail: [690, 11_000], vendor: "Demo Lab Diamonds", count: 18 },
  { category: "Fashion Ring", names: ["Sapphire and Diamond Ring", "Emerald Ring", "Signet Ring", "Stacking Ring", "Ruby Halo Ring", "Cocktail Ring"], metal: "gold", karats: [10, 14, 18], grams: [2, 9], retail: [240, 6_800], vendor: "Demo Gem Imports", count: 22 },
];

const FIRST = ["Alex", "Blair", "Cameron", "Dakota", "Emerson", "Finley", "Gray", "Hayden", "Indigo", "Jamie", "Kendall", "Logan", "Marlowe", "Noel", "Oakley", "Parker", "Reese", "Sage", "Taylor", "Umber", "Val", "Wren", "Yael", "Zion", "Ari", "Bellamy", "Corey", "Drew", "Ellis", "Frankie"];
const LAST = ["Sample", "Example", "Placeholder", "Testwell", "Madeup", "Demoson", "Mockford", "Fakely", "Notreal", "Inventer", "Pretendo", "Dummyer", "Specimen", "Prototype", "Standin", "Lorem", "Ipsum", "Fixture", "Stubbs", "Mockridge"];

const toCents = (dollars: number) => Math.round(dollars) * 100;
/** Prices end in 0 or 5 dollars, like a price tag. */
const tagPrice = (dollars: number) => (dollars < 1_000 ? Math.round(dollars / 5) * 5 : Math.round(dollars / 50) * 50);

export interface BulkStore {
  items: DemoItem[];
  customers: DemoCustomer[];
  sales: DemoSaleLine[];
  repairs: DemoRepair[];
}

/** Days of sales history the everyday store has. Kept under a year so no regular customer reads as lapsed. */
export const BULK_HISTORY_DAYS = 330;

export function bulkStore(seed = 20_261_111): BulkStore {
  const rand = random(seed);
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const whole = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;

  const customers: DemoCustomer[] = [];
  for (let n = 1; n <= 280; n++) {
    const name = `${FIRST[(n * 7) % FIRST.length]} ${LAST[(n * 11 + Math.floor(n / FIRST.length)) % LAST.length]}`;
    customers.push({ id: `C-${2000 + n}`, name, optIn: rand() < 0.85 });
  }

  const items: DemoItem[] = [];
  const sales: DemoSaleLine[] = [];
  let sku = 2000;
  let saleNo = 6000;
  for (const style of STYLES) {
    for (let k = 0; k < style.count; k++) {
      const karat = style.karats ? pick(style.karats) : undefined;
      const name = pick(style.names);
      const metalWord = style.metal === "gold" ? `${karat}K ${pick(["Yellow", "White", "Rose"])} Gold ` : style.metal === "platinum" ? "" : "";
      const retail = tagPrice(between(...style.retail));
      const cost = Math.round(retail * between(0.38, 0.5));
      const received = whole(30, BULK_HISTORY_DAYS);
      const sold = whole(3, retail > 6_000 ? 6 : 12);
      const id = `ES-${++sku}`;
      items.push({
        sku: id,
        title: `${metalWord}${name}`.trim(),
        category: style.category,
        ...(style.metal ? { metal: style.metal } : {}),
        ...(karat ? { karat } : {}),
        weightGrams: Math.round(between(...style.grams) * 10) / 10,
        costCents: toCents(cost),
        retailCents: toCents(retail),
        quantity: sold + whole(2, 5),
        vendor: style.vendor,
        receivedDaysAgo: received,
      });
      // One sale in the last 120 days, the rest anywhere since the piece came in.
      const days = [whole(1, Math.min(120, received - 1)), ...Array.from({ length: sold - 1 }, () => whole(1, received - 1))];
      for (const daysAgo of days) {
        const tender: Tender = retail >= 2_000 && rand() < 0.3 ? "Financing" : "Card";
        const customer = rand() < 0.75 ? pick(customers).id : undefined;
        // Now and then a piece sells a little under the tag.
        const unit = rand() < 0.2 ? toCents(tagPrice(retail * 0.9)) : toCents(retail);
        sales.push({ saleId: `S-${++saleNo}`, daysAgo, sku: id, quantity: 1, unitCents: unit, tender, ...(customer ? { customerId: customer } : {}) });
      }
      // About one piece in twelve that sells well has one come back.
      if (sold >= 6 && rand() < 0.35) {
        const original = sales.at(-1)!;
        if (original.daysAgo > 3) sales.push({ saleId: original.saleId, daysAgo: original.daysAgo - 2, sku: id, quantity: 1, unitCents: original.unitCents, tender: original.tender, returnOf: original.saleId });
      }
    }
  }
  // Returns name the sale they reverse; give each its own return number.
  for (const line of sales) if (line.returnOf) line.saleId = `R-${line.returnOf.slice(2)}`;

  const WORK: [string, string, number][] = [
    ["14K gold ring", "Size down one", 55],
    ["14K gold ring", "Size up two", 85],
    ["Diamond engagement ring", "Retip four prongs", 160],
    ["Gold chain", "Solder a broken link", 45],
    ["Sterling silver bracelet", "Replace the clasp", 40],
    ["Pearl strand", "Restring with knots", 120],
    ["Wedding band", "Polish and refinish", 65],
    ["Earrings", "Replace the backs", 25],
    ["Watch", "Replace the battery", 25],
    ["Watch", "Shorten the bracelet", 30],
    ["Pendant", "Replace the bail", 50],
    ["Tennis bracelet", "Tighten the stones", 90],
  ];
  const repairs: DemoRepair[] = [];
  for (let n = 1; n <= 64; n++) {
    const [item, work, estimate] = pick(WORK);
    const received = whole(1, 120);
    const turnaround = whole(5, 14);
    const promised = received - turnaround;
    const customerId = pick(customers).id;
    const ticketId = `T-${600 + n}`;
    if (promised > 2) {
      // Back and collected, a day or so after it was ready.
      repairs.push({ ticketId, customerId, item, work, receivedDaysAgo: received, promisedDaysAgo: promised, estimateCents: toCents(estimate), status: "Picked up", statusDaysAgo: Math.max(promised - whole(0, 2), 0) });
    } else {
      // Still due back in the coming days, at the bench or sent out.
      repairs.push({ ticketId, customerId, item, work, receivedDaysAgo: received, promisedDaysAgo: Math.min(promised, -1), estimateCents: toCents(estimate), status: rand() < 0.8 ? "At bench" : "Sent out", statusDaysAgo: Math.max(received - 1, 0) });
    }
  }
  return { items, customers, sales, repairs };
}
