/**
 * Example Street Jewelers, a made-up store. Everything here is invented:
 * names, numbers, addresses and amounts. Emails use reserved test domains
 * and phone numbers sit in the 555-01xx range kept for fiction, so nothing
 * can reach a real person. Dates are counted back from the day the demo
 * is seeded, so the dashboard always reads as this week.
 */

export const DEMO_ORGANIZATION = "demo-example-street";
export const DEMO_STORE_NAME = "Example Street Jewelers";

const DAY_MS = 86_400_000;

/** The demo's calendar: every date is a whole number of days before `now`, at a fixed time of day. */
export interface DemoCalendar {
  now: Date;
  /** `days` ago at `hour` UTC, as an ISO time. */
  at(days: number, hour?: number): string;
  /** `days` ago as YYYY-MM-DD. */
  date(days: number): string;
  /** `days` ago as MM/DD/YYYY, the way most POS exports write dates. */
  usDate(days: number): string;
}

export function demoCalendar(now: Date): DemoCalendar {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = (days: number) => new Date(midnight - days * DAY_MS);
  return {
    now,
    at: (days, hour = 15) => {
      const t = new Date(midnight - days * DAY_MS + hour * 3_600_000);
      // A time later today than now would be in the future; keep it in the past.
      return (t > now ? new Date(now.getTime() - 60_000) : t).toISOString();
    },
    date: (days) => day(days).toISOString().slice(0, 10),
    usDate: (days) => {
      const [y, m, d] = day(days).toISOString().slice(0, 10).split("-");
      return `${m}/${d}/${y}`;
    },
  };
}

export interface DemoItem {
  sku: string;
  title: string;
  category: string;
  metal?: "gold" | "silver" | "platinum";
  karat?: number;
  weightGrams?: number;
  costCents: number;
  retailCents: number;
  /** Pieces received. */
  quantity: number;
  vendor: string;
  onMemo?: boolean;
  receivedDaysAgo: number;
}

/** The case: a few pieces that sell, a few that don't, and one on memo. */
export const DEMO_ITEMS: DemoItem[] = [
  { sku: "ES-1001", title: "14K Yellow Gold Diamond Solitaire Ring, 1.00 ct", category: "Engagement Ring", metal: "gold", karat: 14, weightGrams: 3.4, costCents: 240_000, retailCents: 520_000, quantity: 4, vendor: "Sample Bridal Supply", receivedDaysAgo: 150 },
  { sku: "ES-1002", title: "18K White Gold Halo Engagement Ring", category: "Engagement Ring", metal: "gold", karat: 18, weightGrams: 5.1, costCents: 310_000, retailCents: 690_000, quantity: 3, vendor: "Sample Bridal Supply", receivedDaysAgo: 600 },
  { sku: "ES-1003", title: "14K Gold Hoop Earrings, 20 mm", category: "Earrings", metal: "gold", karat: 14, weightGrams: 2.8, costCents: 21_000, retailCents: 54_000, quantity: 6, vendor: "Demo Findings Co", receivedDaysAgo: 90 },
  { sku: "ES-1004", title: "Sterling Silver Cuban Link Chain, 22 in", category: "Necklace", metal: "silver", weightGrams: 46, costCents: 9_500, retailCents: 29_500, quantity: 12, vendor: "Demo Findings Co", receivedDaysAgo: 120 },
  { sku: "ES-1005", title: "Platinum Comfort Fit Wedding Band, 4 mm", category: "Wedding Band", metal: "platinum", weightGrams: 9.5, costCents: 68_000, retailCents: 149_000, quantity: 3, vendor: "Sample Bridal Supply", receivedDaysAgo: 420 },
  { sku: "ES-1006", title: "Lab-Grown Diamond Tennis Bracelet, 14K White Gold, 5 ctw", category: "Bracelet", metal: "gold", karat: 14, weightGrams: 9.8, costCents: 145_000, retailCents: 349_000, quantity: 3, vendor: "Demo Lab Diamonds", receivedDaysAgo: 75 },
  { sku: "ES-1007", title: "Loose Oval Diamond, 1.52 ct, G VS2", category: "Loose Stone", costCents: 820_000, retailCents: 1_490_000, quantity: 1, vendor: "Demo Diamond Exchange", onMemo: true, receivedDaysAgo: 40 },
  { sku: "ES-1008", title: "Akoya Pearl Strand, 7 mm, 18 in", category: "Necklace", costCents: 64_000, retailCents: 165_000, quantity: 2, vendor: "Demo Pearl House", receivedDaysAgo: 300 },
  { sku: "ES-1009", title: "14K Rose Gold Diamond Pendant, 0.25 ct", category: "Pendant", metal: "gold", karat: 14, weightGrams: 1.9, costCents: 38_000, retailCents: 95_000, quantity: 5, vendor: "Demo Findings Co", receivedDaysAgo: 60 },
];

export interface DemoCustomer {
  id: string;
  name: string;
  optIn: boolean;
}

/** Customers, all invented. */
export const DEMO_CUSTOMERS: DemoCustomer[] = [
  { id: "C-1001", name: "Avery Sample", optIn: true },
  { id: "C-1002", name: "Jordan Example", optIn: true },
  { id: "C-1003", name: "Morgan Placeholder", optIn: true },
  { id: "C-1004", name: "Riley Fictional", optIn: false },
  { id: "C-1005", name: "Casey Demo", optIn: true },
  { id: "C-1006", name: "Quinn Testwell", optIn: true },
  { id: "C-1007", name: "Harper Madeup", optIn: true },
  { id: "C-1008", name: "Rowan Invented", optIn: true },
];

export type Tender = "Card" | "Cash" | "Financing";

export interface DemoSaleLine {
  saleId: string;
  daysAgo: number;
  sku: string;
  quantity: number;
  unitCents: number;
  tender: Tender;
  customerId?: string;
  /** Set on a return: the sale it reverses. */
  returnOf?: string;
}

const item = (sku: string) => DEMO_ITEMS.find((i) => i.sku === sku)!;
const sale = (n: number, daysAgo: number, sku: string, tender: Tender, customerId?: string, quantity = 1): DemoSaleLine => ({
  saleId: `S-${n}`,
  daysAgo,
  sku,
  quantity,
  unitCents: item(sku).retailCents,
  tender,
  ...(customerId ? { customerId } : {}),
});

/**
 * Sales and returns over the last two years. Each line is chosen to show
 * something on the dashboard:
 * - Hoops sell steadily and are nearly gone, so they need reordering.
 * - The silver chain comes back a third of the time.
 * - The memo diamond sold for $14,900 cash three days ago: a Form 8300.
 * - One customer paid cash twice in a week, each under $10,000.
 * - A customer who spent over $5,000 hasn't been back in over a year.
 * - The halo ring and platinum band haven't sold in months.
 */
export const DEMO_SALES: DemoSaleLine[] = [
  sale(4001, 560, "ES-1002", "Card", "C-1003"),
  sale(4002, 400, "ES-1005", "Card", "C-1003"),
  sale(4022, 100, "ES-1008", "Card", "C-1005"),
  sale(4003, 140, "ES-1001", "Financing", "C-1001"),
  sale(4004, 58, "ES-1003", "Card", "C-1002"),
  sale(4005, 44, "ES-1003", "Card", "C-1005"),
  sale(4006, 31, "ES-1003", "Card"),
  sale(4007, 19, "ES-1003", "Card", "C-1006"),
  sale(4008, 6, "ES-1003", "Card", "C-1008"),
  sale(4009, 70, "ES-1004", "Card", "C-1002"),
  sale(4010, 52, "ES-1004", "Card"),
  sale(4011, 40, "ES-1004", "Card", "C-1005"),
  sale(4012, 27, "ES-1004", "Card"),
  sale(4013, 15, "ES-1004", "Card", "C-1006"),
  sale(4014, 9, "ES-1004", "Card"),
  { saleId: "R-4010", daysAgo: 47, sku: "ES-1004", quantity: 1, unitCents: item("ES-1004").retailCents, tender: "Card", returnOf: "S-4010" },
  { saleId: "R-4012", daysAgo: 22, sku: "ES-1004", quantity: 1, unitCents: item("ES-1004").retailCents, tender: "Card", returnOf: "S-4012" },
  sale(4015, 3, "ES-1007", "Cash", "C-1007"),
  { ...sale(4017, 12, "ES-1001", "Cash", "C-1004"), unitCents: 480_000 },
  { ...sale(4018, 5, "ES-1006", "Cash", "C-1004"), unitCents: 349_000 + 240_000 },
  sale(4019, 24, "ES-1009", "Card", "C-1001"),
  sale(4020, 11, "ES-1001", "Financing", "C-1008"),
  sale(4021, 2, "ES-1009", "Card", "C-1002"),
];

/** Cash the bank shows deposited in the last month. The $14,900 from three days ago hasn't gone in yet. */
export const DEMO_CASH_DEPOSITS: { daysAgo: number; cents: number }[] = [
  { daysAgo: 11, cents: 480_000 },
  { daysAgo: 4, cents: 589_000 },
];
