import type { Connector } from "@karatos/core";
import { CHASE_CARD_PROFILE, CHASE_CHECKING_PROFILE } from "../bank_statements/banks.js";
import { accountsFromDirectory, bankStatementsConnector, type BankStatementOptions, type StatementFormat } from "../bank_statements/connector.js";

/**
 * Chase business checking, savings and credit cards, from CSV activity
 * downloads, PDF statements or both. It is the bank statements connector
 * with Chase's own profiles: each account folder (`checking-1234`,
 * `card-5678`) is read with the checking or card profile by its name.
 * Read-only, like every statement import.
 */

export const CHASE_IMPORT_MODES = ["manual_csv", "manual_pdf", "manual_csv_and_pdf"] as const;
export type ChaseImportMode = (typeof CHASE_IMPORT_MODES)[number];

/** CHASE_IMPORT_MODE as the formats to read. */
export function chaseFormats(mode: string | undefined): StatementFormat[] {
  const value = mode?.trim() ?? "";
  if (value === "manual_csv") return ["csv"];
  if (value === "manual_pdf") return ["pdf"];
  if (value === "manual_csv_and_pdf") return ["csv", "pdf"];
  throw new Error(`CHASE_IMPORT_MODE must be one of ${CHASE_IMPORT_MODES.join(", ")}`);
}

/** One account per subfolder of CHASE_MANUAL_IMPORT_DIR; card folders get the card profile. */
export const chaseAccountsFromDirectory = (dir: string) =>
  accountsFromDirectory(dir, (account) => (/card|credit/.test(account) ? CHASE_CARD_PROFILE : CHASE_CHECKING_PROFILE));

export function chaseConnector(options: BankStatementOptions): Connector {
  return { ...bankStatementsConnector(options), source: "chase" };
}
