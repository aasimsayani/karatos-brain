import { z } from "zod";

/**
 * A mapping profile says how one point-of-sale system writes its exports:
 * which files hold what, which column holds each value, and how dates and
 * labels are written. The generic profile reads the column names in
 * docs/integrations/inventory_pos.md. A profile for one client's system belongs in that
 * client's private instance repo, never here.
 */

/** A header name, or several a system has used for the same column. Matched without regard to case or spacing. */
const Column = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const optional = Column.optional();

const SalesColumns = z.object({
  saleId: Column,
  date: Column,
  sku: Column,
  quantity: Column,
  unitPrice: Column,
  discount: optional,
  /** The sale's total, repeated on each of its lines. Summed from the lines when absent. */
  total: optional,
  paymentMethod: optional,
  customerId: optional,
  salesperson: optional,
  channel: optional,
  /** On a return line, the receipt it returns. The line's own sale id is used when absent. */
  originalSaleId: optional,
  returnId: optional,
});

const ItemColumns = z.object({
  sku: Column,
  title: Column,
  category: optional,
  metal: optional,
  karat: optional,
  weightGrams: optional,
  cost: Column,
  retailPrice: Column,
  quantity: optional,
  vendor: optional,
  onMemo: optional,
  receivedDate: optional,
});

const StockColumns = z.object({ sku: Column, onHand: Column, date: optional });

const CustomerColumns = z.object({ customerId: Column, name: Column, marketingConsent: optional, updatedDate: optional });

export const FILE_KINDS = ["items", "stock", "customers", "sales"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

const PAYMENT_METHODS = ["card", "cash", "check", "financing", "trade_in", "gift_card", "wire", "other"] as const;
const CATEGORIES = ["ring", "engagement_ring", "wedding_band", "necklace", "pendant", "earrings", "bracelet", "watch", "loose_stone", "other"] as const;

export const PosProfileSchema = z.object({
  /** Short lowercase name; part of every idempotency key, so never change it once data is imported. */
  id: z.string().regex(/^[a-z0-9_]{2,40}$/),
  name: z.string().min(1),
  delimiter: z.string().length(1).default(","),
  dateOrder: z.enum(["ymd", "mdy", "dmy"]).default("mdy"),
  /** The store's offset from UTC, for times written without one. */
  utcOffset: z.string().regex(/^(Z|[+-]\d{2}:\d{2})$/).default("Z"),
  /** Regular expressions tested against each file name, case-insensitive. The first match decides; unmatched files are skipped. */
  files: z.object({
    items: z.string().optional(),
    stock: z.string().optional(),
    customers: z.string().optional(),
    sales: z.string().optional(),
  }),
  columns: z.object({
    sales: SalesColumns.optional(),
    items: ItemColumns.optional(),
    stock: StockColumns.optional(),
    customers: CustomerColumns.optional(),
  }),
  /** The system's payment labels, lowercased, mapped to the sales department's methods. Checked before the built-in guesses. */
  payments: z.record(z.string(), z.enum(PAYMENT_METHODS)).default({}),
  /** The system's category labels, lowercased, mapped to inventory categories. Checked before the built-in guesses. */
  categories: z.record(z.string(), z.enum(CATEGORIES)).default({}),
});

export type PosProfile = z.output<typeof PosProfileSchema>;
export type PosProfileInput = z.input<typeof PosProfileSchema>;
export type SalesColumnMap = z.output<typeof SalesColumns>;
export type ItemColumnMap = z.output<typeof ItemColumns>;
export type StockColumnMap = z.output<typeof StockColumns>;
export type CustomerColumnMap = z.output<typeof CustomerColumns>;

export class PosProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosProfileError";
  }
}

/** Validates a profile, including that each file pattern compiles and each mapped file kind has columns. */
export function parsePosProfile(input: unknown): PosProfile {
  const result = PosProfileSchema.safeParse(input);
  if (!result.success) {
    const where = result.error.issues.map((i) => `${i.path.join(".") || "profile"}: ${i.message}`).join("; ");
    throw new PosProfileError(`POS mapping profile is not valid: ${where}`);
  }
  const profile = result.data;
  for (const kind of FILE_KINDS) {
    const pattern = profile.files[kind];
    if (pattern === undefined) continue;
    try {
      new RegExp(pattern, "i");
    } catch {
      throw new PosProfileError(`POS mapping profile: files.${kind} is not a valid pattern`);
    }
    if (!profile.columns[kind]) throw new PosProfileError(`POS mapping profile: files.${kind} is set but columns.${kind} is missing`);
  }
  return profile;
}

/** Reads the column names listed in docs/integrations/inventory_pos.md. */
export const GENERIC_POS_PROFILE: PosProfile = parsePosProfile({
  id: "generic",
  name: "Generic CSV",
  dateOrder: "mdy",
  files: { items: "item|inventory", stock: "stock|on.?hand", customers: "customer|client", sales: "sale|transaction|receipt" },
  columns: {
    sales: {
      saleId: ["Sale ID", "Receipt", "Ticket"],
      date: ["Date", "Sale Date"],
      sku: ["SKU", "Item Number", "Stock Number"],
      quantity: ["Quantity", "Qty"],
      unitPrice: ["Unit Price", "Price"],
      discount: "Discount",
      total: ["Sale Total", "Total"],
      paymentMethod: ["Payment Method", "Tender"],
      customerId: ["Customer ID", "Customer Number"],
      salesperson: ["Salesperson", "Associate"],
      channel: "Channel",
      originalSaleId: ["Original Sale ID", "Original Receipt"],
      returnId: "Return ID",
    },
    items: {
      sku: ["SKU", "Item Number", "Stock Number"],
      title: ["Title", "Description"],
      category: "Category",
      metal: "Metal",
      karat: "Karat",
      weightGrams: ["Weight (g)", "Weight Grams", "Grams"],
      cost: "Cost",
      retailPrice: ["Retail Price", "Retail", "Price"],
      quantity: ["Quantity", "Qty"],
      vendor: ["Vendor", "Supplier"],
      onMemo: ["On Memo", "Memo"],
      receivedDate: ["Received", "Date Received"],
    },
    stock: { sku: ["SKU", "Item Number", "Stock Number"], onHand: ["On Hand", "Quantity", "Qty"], date: ["Date", "Count Date"] },
    customers: {
      customerId: ["Customer ID", "Customer Number"],
      name: ["Name", "Customer Name"],
      marketingConsent: ["Marketing Opt In", "Opt In"],
      updatedDate: ["Updated", "Last Updated"],
    },
  },
});
