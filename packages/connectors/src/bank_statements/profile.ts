import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * A parsing profile says how one bank writes its CSV exports: which columns
 * hold the date, description and amount, how amounts are signed, how dates
 * are written, and the client's own rules for categorizing transactions.
 * The generic profile reads the common layouts. A profile for one client's
 * bank, or one that names their payees, belongs in that client's private
 * instance repo, never here.
 */

const Column = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const optional = Column.optional();

export const BANK_CATEGORIES = ["cash_deposit", "card_settlement", "vendor_payment", "payroll", "fee", "other"] as const;
export type BankCategory = (typeof BANK_CATEGORIES)[number];

export const BankProfileSchema = z.object({
  /** Short lowercase name for messages and docs. Keys don't include it, so a CSV and a PDF profile for one bank store the same transaction once. */
  id: z.string().regex(/^[a-z0-9_]{2,40}$/),
  name: z.string().min(1),
  delimiter: z.string().length(1).default(","),
  dateOrder: z.enum(["ymd", "mdy", "dmy"]).default("mdy"),
  /** The bank's offset from UTC, for dates written without one. */
  utcOffset: z.string().regex(/^(Z|[+-]\d{2}:\d{2})$/).default("Z"),
  columns: z
    .object({
      date: Column,
      description: Column,
      /** One signed amount column. */
      amount: optional,
      /** Or separate money-out and money-in columns, read as unsigned. */
      debit: optional,
      credit: optional,
      balance: optional,
      checkNumber: optional,
    })
    .refine((c) => c.amount !== undefined || (c.debit !== undefined && c.credit !== undefined), {
      message: "map either amount, or both debit and credit",
    }),
  /** How the amount column is signed. Card exports often show purchases as positive. */
  amounts: z.enum(["money_in_positive", "money_out_positive"]).default("money_in_positive"),
  /** Regular expressions tested against the description, case-insensitive, in order, before the built-in rules. */
  categories: z.array(z.object({ match: z.string().min(1), category: z.enum(BANK_CATEGORIES) })).default([]),
});

export type BankProfile = z.output<typeof BankProfileSchema>;
export type BankProfileInput = z.input<typeof BankProfileSchema>;
export type BankColumnMap = BankProfile["columns"];

export class BankProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankProfileError";
  }
}

export function parseBankProfile(input: unknown): BankProfile {
  const result = BankProfileSchema.safeParse(input);
  if (!result.success) {
    const where = result.error.issues.map((i) => `${i.path.join(".") || "profile"}: ${i.message}`).join("; ");
    throw new BankProfileError(`bank statement profile is not valid: ${where}`);
  }
  result.data.categories.forEach((rule, i) => {
    try {
      new RegExp(rule.match, "i");
    } catch {
      throw new BankProfileError(`bank statement profile: categories.${i}.match is not a valid pattern`);
    }
  });
  return result.data;
}

/** Reads the column names listed under "Bank and card statements" in docs/integrations.md. */
export const GENERIC_BANK_PROFILE: BankProfile = parseBankProfile({
  id: "generic",
  name: "Generic CSV",
  columns: {
    date: ["Date", "Posting Date", "Transaction Date", "Posted Date"],
    description: ["Description", "Memo", "Details", "Payee"],
    amount: "Amount",
    debit: ["Debit", "Withdrawals", "Withdrawal", "Money Out"],
    credit: ["Credit", "Deposits", "Deposit", "Money In"],
    balance: ["Balance", "Running Balance"],
    checkNumber: ["Check Number", "Check or Slip #", "Check #"],
  },
});

/**
 * The profiles the BANK_STATEMENTS_PROFILES setting names: "generic", or a
 * path to a JSON file in the client's private instance repo mapping each
 * account folder to a profile (with "*" for the rest). Returns a lookup by
 * folder name.
 */
export async function resolveBankProfiles(
  setting: string | undefined,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<(account: string) => BankProfile> {
  const value = setting?.trim() ?? "";
  if (value === "" || value === "generic") return () => GENERIC_BANK_PROFILE;
  let json: unknown;
  try {
    json = JSON.parse(await read(value));
  } catch (error) {
    throw new BankProfileError(`BANK_STATEMENTS_PROFILES: could not read a JSON file (${error instanceof Error ? error.name : "error"})`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new BankProfileError("BANK_STATEMENTS_PROFILES: the file must map account folders to profiles");
  }
  const profiles = new Map(Object.entries(json).map(([folder, profile]) => [folder, parseBankProfile(profile)]));
  return (account) => profiles.get(account) ?? profiles.get("*") ?? GENERIC_BANK_PROFILE;
}
