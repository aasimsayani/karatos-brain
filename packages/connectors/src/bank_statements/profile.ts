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

const Pattern = z.string().min(1);

/** How a PDF statement is laid out. Every pattern is a regular expression, matched case-insensitively against one line. */
export const PdfLayoutSchema = z.object({
  /**
   * A transaction line, with named groups: `date`, `description`, and
   * `amount`, or `debit` and `credit`; optionally `balance`. Columns are
   * separated by two or more spaces in the text read from the PDF.
   */
  transaction: Pattern,
  /** Finds the statement's closing date, as a group named `end`, for dates written without a year. */
  period: Pattern.optional(),
  /** Section headings, in order of precedence. A heading sets how the amounts below it are signed until the next one. */
  sections: z
    .array(z.object({ match: Pattern, amounts: z.enum(["money_in", "money_out", "signed", "skip"]) }))
    .default([]),
  /** Lines that look like transactions but aren't, such as opening and closing balances. */
  ignore: z.array(Pattern).default([]),
});

export type PdfLayout = z.output<typeof PdfLayoutSchema>;

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
  /** How this bank's PDF statements are laid out. The generic layout when absent. */
  pdf: PdfLayoutSchema.optional(),
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
  const patterns: [string, string][] = result.data.categories.map((rule, i) => [`categories.${i}.match`, rule.match]);
  const pdf = result.data.pdf;
  if (pdf) {
    patterns.push(["pdf.transaction", pdf.transaction]);
    if (pdf.period) patterns.push(["pdf.period", pdf.period]);
    pdf.sections.forEach((section, i) => patterns.push([`pdf.sections.${i}.match`, section.match]));
    pdf.ignore.forEach((pattern, i) => patterns.push([`pdf.ignore.${i}`, pattern]));
  }
  for (const [where, pattern] of patterns) {
    try {
      new RegExp(pattern, "i");
    } catch {
      throw new BankProfileError(`bank statement profile: ${where} is not a valid pattern`);
    }
  }
  if (pdf) {
    const groups = new Set([...pdf.transaction.matchAll(/\(\?<([A-Za-z]+)>/g)].map((m) => m[1]));
    const missing = ["date", "description"].filter((g) => !groups.has(g));
    if (!groups.has("amount") && !(groups.has("debit") && groups.has("credit"))) missing.push("amount (or debit and credit)");
    if (missing.length) throw new BankProfileError(`bank statement profile: pdf.transaction needs named groups for ${missing.join(", ")}`);
    if (pdf.period && !/\(\?<end>/.test(pdf.period)) throw new BankProfileError("bank statement profile: pdf.period needs a named group end");
  }
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

const MONEY = String.raw`[-−]?\(?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?-?`;

/**
 * Reads the common statement layout: a date (with or without the year), the
 * description, then the amount, and sometimes a running balance, under
 * section headings that say which way the money moved.
 */
export const GENERIC_PDF_LAYOUT: PdfLayout = PdfLayoutSchema.parse({
  transaction: String.raw`^(?<date>\d{1,2}/\d{1,2}(?:/\d{2,4})?)\s+(?<description>\S.*?)\s{2,}(?<amount>${MONEY})(?:\s{2,}(?<balance>${MONEY}))?$`,
  period: String.raw`(?:\bthrough|\bthru|\bto|\bclosing date:?|\bending date:?|\bstatement date:?|-|–)\s*(?<end>\d{1,2}/\d{1,2}/\d{2,4})`,
  sections: [
    { match: String.raw`^(?:daily (?:ending )?balance|balance summary|account summary|summary of accounts?)\b`, amounts: "skip" },
    { match: String.raw`^(?:deposits(?: and (?:other )?(?:additions|credits))?|(?:electronic |other )?deposits|additions|other credits|credits|payments,? (?:and|&) (?:other )?credits)\b`, amounts: "money_in" },
    {
      match: String.raw`^(?:(?:electronic |other |atm (?:and|&) debit card )?withdrawals|subtractions|debits|checks(?: paid)?|(?:service )?fees(?: charged)?|(?:card )?purchases(?: and adjustments)?|cash advances|interest charged)\b`,
      amounts: "money_out",
    },
    { match: String.raw`^(?:transaction (?:history|detail)|account activity|transactions)\b`, amounts: "signed" },
  ],
  ignore: [String.raw`\b(?:beginning|ending|opening|closing|previous|new) balance\b`, String.raw`^total\b`, String.raw`\btotal (?:deposits|withdrawals|fees|checks|purchases)\b`],
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
