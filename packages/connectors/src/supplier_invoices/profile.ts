import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * A parsing profile says how one supplier's invoice and memo exports are
 * laid out: which columns hold the document number, its date, each line's
 * item and money, a memo's due date or terms, and any warranty statement.
 * The generic profile reads the common column names. A profile for one
 * client's supplier belongs in that client's private instance repo, never
 * here.
 */

const Column = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const optional = Column.optional();

/** The fields an invoice or memo line can carry. */
export const DOCUMENT_FIELDS = [
  "type",
  "number",
  "date",
  "sku",
  "description",
  "stone",
  "quantity",
  "unitCost",
  "amount",
  "due",
  "terms",
  "statement",
] as const;
export type DocumentField = (typeof DOCUMENT_FIELDS)[number];

/** Every line needs its document's number and date, and its money as a line amount or a unit cost. */
export const REQUIRED_FIELDS: readonly DocumentField[] = ["number", "date"];
export const MONEY_FIELDS: readonly DocumentField[] = ["amount", "unitCost"];

export const SupplierProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{2,40}$/),
  name: z.string().min(1),
  delimiter: z.string().length(1).default(","),
  dateOrder: z.enum(["ymd", "mdy", "dmy"]).default("mdy"),
  columns: z.object(Object.fromEntries(DOCUMENT_FIELDS.map((f) => [f, REQUIRED_FIELDS.includes(f) ? Column : optional])) as Record<DocumentField, typeof optional>),
});

export type SupplierProfile = z.output<typeof SupplierProfileSchema>;
export type SupplierProfileInput = z.input<typeof SupplierProfileSchema>;

export class SupplierProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierProfileError";
  }
}

export function parseSupplierProfile(input: unknown): SupplierProfile {
  const result = SupplierProfileSchema.safeParse(input);
  if (!result.success) {
    const where = result.error.issues.map((i) => `${i.path.join(".") || "profile"}: ${i.message}`).join("; ");
    throw new SupplierProfileError(`supplier invoice profile is not valid: ${where}`);
  }
  const profile = result.data;
  if (!MONEY_FIELDS.some((f) => profile.columns[f] !== undefined)) throw new SupplierProfileError("supplier invoice profile: columns need amount or unitCost");
  return profile;
}

/** Reads the column names listed in docs/integrations/supplier_invoices.md. */
export const GENERIC_SUPPLIER_PROFILE: SupplierProfile = parseSupplierProfile({
  id: "generic",
  name: "Generic CSV",
  columns: {
    type: ["Type", "Document Type", "Doc Type", "Transaction Type"],
    number: ["Invoice", "Invoice Number", "Invoice No", "Invoice #", "Memo", "Memo Number", "Memo No", "Memo #", "Document", "Document Number", "Doc #"],
    date: ["Date", "Invoice Date", "Memo Date", "Document Date"],
    sku: ["SKU", "Style", "Style #", "Style Number", "Item #", "Item Number", "Stock #", "Stock Number"],
    description: ["Description", "Item Description", "Details"],
    stone: ["Stone", "Stone Type", "Center Stone", "Gem"],
    quantity: ["Qty", "Quantity", "Pcs", "Pieces", "Units"],
    unitCost: ["Unit Price", "Unit Cost", "Price", "Cost", "Price Each"],
    amount: ["Amount", "Extended", "Ext Price", "Extended Price", "Line Total", "Total"],
    due: ["Due Back", "Return By", "Memo Due", "Memo Due Date", "Due Date"],
    terms: ["Terms", "Memo Terms", "Payment Terms"],
    statement: ["Statement", "Warranty", "Warranty Statement", "Notes", "Remarks", "Comments"],
  },
});

/** Built-in profiles by the name SUPPLIER_INVOICES_PROFILES uses. */
export const SUPPLIER_PROFILES: Readonly<Record<string, SupplierProfile>> = Object.freeze({ generic: GENERIC_SUPPLIER_PROFILE });

/**
 * The profiles the SUPPLIER_INVOICES_PROFILES setting names: "generic", or
 * the path to a JSON file in the client's private instance repo mapping each
 * supplier folder to a profile or a built-in profile's name (with "*" for
 * the rest). Returns a lookup by folder name.
 */
export async function resolveSupplierProfiles(
  setting: string | undefined,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<(supplier: string) => SupplierProfile> {
  const value = setting?.trim() ?? "";
  const builtIn = (name: string) => (Object.hasOwn(SUPPLIER_PROFILES, name) ? SUPPLIER_PROFILES[name] : undefined);
  if (value === "") return () => GENERIC_SUPPLIER_PROFILE;
  const named = builtIn(value);
  if (named) return () => named;
  let json: unknown;
  try {
    json = JSON.parse(await read(value));
  } catch (error) {
    throw new SupplierProfileError(`SUPPLIER_INVOICES_PROFILES: could not read a JSON file (${error instanceof Error ? error.name : "error"})`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new SupplierProfileError("SUPPLIER_INVOICES_PROFILES: the file must map supplier folders to profiles");
  }
  const profiles = new Map(
    Object.entries(json).map(([folder, profile]) => {
      if (typeof profile !== "string") return [folder, parseSupplierProfile(profile)];
      const found = builtIn(profile);
      if (!found) throw new SupplierProfileError(`SUPPLIER_INVOICES_PROFILES: ${JSON.stringify(folder)} names no built-in profile`);
      return [folder, found];
    }),
  );
  return (supplier) => profiles.get(supplier) ?? profiles.get("*") ?? GENERIC_SUPPLIER_PROFILE;
}
