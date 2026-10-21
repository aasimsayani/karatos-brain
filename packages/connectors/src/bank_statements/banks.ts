import { readFile } from "node:fs/promises";
import { BankProfileError, GENERIC_BANK_PROFILE, GENERIC_PDF_LAYOUT, parseBankProfile, type BankProfile } from "./profile.js";

/**
 * Profiles for specific banks' exports and statements, chosen by name in
 * BANK_STATEMENTS_PROFILES. They describe a bank's public format, never a
 * client: payee rules for one business still go in that client's own
 * profile file. Each one was written from the bank's published export
 * format and statement layout and is checked against a client's own
 * statement before sign-off (see docs/integrations.md).
 */

const MONEY = String.raw`[-−]?\(?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?-?`;
const SPELLED_DATE = String.raw`[A-Za-z]{3,9}\.?\s+\d{1,2},\s*\d{4}`;

/** Chase business checking and savings: CSV activity downloads and monthly PDF statements. */
export const CHASE_CHECKING_PROFILE: BankProfile = parseBankProfile({
  id: "chase_checking",
  name: "Chase checking and savings",
  columns: { date: "Posting Date", description: "Description", amount: "Amount", balance: "Balance", checkNumber: "Check or Slip #" },
  pdf: {
    transaction: [
      // CHECKS PAID lists the check number first, sometimes with a caret for an image, then the date paid.
      String.raw`^(?<checkNumber>\d{3,})\s+(?:\^\s+|\*\s+)?(?<description>)(?<date>\d{1,2}/\d{1,2})\s{2,}(?<amount>${MONEY})$`,
      ...[GENERIC_PDF_LAYOUT.transaction].flat(),
    ],
    period: String.raw`\bthrough\s+(?<end>${SPELLED_DATE}|\d{1,2}/\d{1,2}/\d{2,4})`,
    sections: GENERIC_PDF_LAYOUT.sections,
    ignore: GENERIC_PDF_LAYOUT.ignore,
  },
});

/** Chase business credit cards: CSV activity downloads and monthly PDF statements. */
export const CHASE_CARD_PROFILE: BankProfile = parseBankProfile({
  id: "chase_card",
  name: "Chase credit card",
  columns: { date: "Transaction Date", description: "Description", amount: "Amount" },
  pdf: {
    transaction: GENERIC_PDF_LAYOUT.transaction,
    period: String.raw`(?:opening/closing date|closing date)\s+(?:\d{1,2}/\d{1,2}/\d{2,4}\s*-\s*)?(?<end>\d{1,2}/\d{1,2}/\d{2,4})`,
    // Chase heads card purchases "PURCHASE", in the singular.
    sections: [{ match: String.raw`^purchases?\b`, amounts: "money_out" }, ...GENERIC_PDF_LAYOUT.sections],
    ignore: GENERIC_PDF_LAYOUT.ignore,
  },
});

/** Built-in profiles by the name BANK_STATEMENTS_PROFILES uses. */
export const BANK_PROFILES: Readonly<Record<string, BankProfile>> = Object.freeze({
  generic: GENERIC_BANK_PROFILE,
  chase_checking: CHASE_CHECKING_PROFILE,
  chase_card: CHASE_CARD_PROFILE,
});

export const builtInBankProfile = (name: string): BankProfile | undefined => (Object.hasOwn(BANK_PROFILES, name) ? BANK_PROFILES[name] : undefined);

/**
 * The profiles the BANK_STATEMENTS_PROFILES setting names: a built-in
 * profile's name ("generic", "chase_checking", "chase_card"), or a path to a
 * JSON file in the client's private instance repo mapping each account
 * folder to a profile or a built-in profile's name (with "*" for the rest).
 * Returns a lookup by folder name.
 */
export async function resolveBankProfiles(
  setting: string | undefined,
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<(account: string) => BankProfile> {
  const value = setting?.trim() ?? "";
  if (value === "") return () => GENERIC_BANK_PROFILE;
  const named = builtInBankProfile(value);
  if (named) return () => named;
  let json: unknown;
  try {
    json = JSON.parse(await read(value));
  } catch (error) {
    throw new BankProfileError(`BANK_STATEMENTS_PROFILES: could not read a JSON file (${error instanceof Error ? error.name : "error"})`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new BankProfileError("BANK_STATEMENTS_PROFILES: the file must map account folders to profiles");
  }
  const profiles = new Map(
    Object.entries(json).map(([folder, profile]) => {
      if (typeof profile !== "string") return [folder, parseBankProfile(profile)];
      const named = builtInBankProfile(profile);
      if (!named) throw new BankProfileError(`BANK_STATEMENTS_PROFILES: ${JSON.stringify(folder)} names no built-in profile`);
      return [folder, named];
    }),
  );
  return (account) => profiles.get(account) ?? profiles.get("*") ?? GENERIC_BANK_PROFILE;
}
