import { columnReader, hasColumns, MissingColumnsError, type ColumnGetter } from "../files/columns.js";
import { parseCsv, parseCsvRecords, type CsvRow } from "../files/csv.js";
import { parseDate, parseMoney } from "../files/values.js";
import type { BankCategory, BankProfile } from "./profile.js";

/**
 * Turns statement rows into `bank.transaction_imported` events in the
 * finance department's shape. A transaction's key is its account, date,
 * amount and how many identical ones came before it that day, not its
 * description, so the same transaction from a CSV export and a PDF
 * statement, or from two overlapping exports, is stored once. An amount or
 * date that can't be read is left null or missing, so the pipeline
 * dead-letters the row with it kept.
 */

export type AccountKind = "bank" | "credit_card";

export interface StatementAccount {
  /** The account's folder name, such as `checking-1234`. */
  id: string;
  kind: AccountKind;
}

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface BankEvent {
  id: string;
  type: "bank.transaction_imported";
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface StatementContext {
  account: StatementAccount;
  profile: BankProfile;
  fileName: string;
  receivedAt: string;
  /** Rows dated before this ISO time are skipped. */
  since: string;
}

/** One transaction as read, before it becomes an event. Shared with the PDF reader. */
export interface StatementLine {
  /** Where it came from, as `file:line`. */
  sourceRow: string;
  /** ISO instant, or undefined when the date couldn't be read. */
  occurredAt: string | undefined;
  /** Money into the account positive, money out negative; null when unreadable. */
  amountCents: number | null;
  description: string;
  balanceCents?: number | null;
  checkNumber?: string;
}

const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

/** Banks pad and cut descriptions differently; this is only for matching rules. */
const plain = (d: string) => d.toUpperCase().replace(/\s+/g, " ").trim();

const RULES: { when: (amount: number, kind: AccountKind) => boolean; match: RegExp; category: BankCategory }[] = [
  // Processors pay out as "STRIPE TRANSFER" and the like, so this comes before transfers.
  { when: (a, kind) => a > 0 && kind === "bank", match: /STRIPE|SQUARE|SHOPIFY|PAYPAL|CLOVER|HEARTLAND|WORLDPAY|BANKCARD|MERCHANT|AUTHNET|AUTHORIZE\.NET|AMEX SETTLE|CARD SETTLE|\bSETTLEMENT\b/, category: "card_settlement" },
  // Moving money between the business's own accounts is neither income nor spending.
  { when: () => true, match: /\bTRANSFER\b|\bXFER\b|AUTOPAY|CARD PAYMENT|PAYMENT TO .*CARD|CREDIT CARD PAYMENT|PAYMENT THANK YOU|ONLINE PAYMENT.*THANK/, category: "other" },
  { when: (a) => a < 0, match: /PAYROLL|GUSTO|\bADP\b|PAYCHEX|RIPPLING|\bWAGES?\b/, category: "payroll" },
  { when: () => true, match: /\bFEES?\b|SERVICE CHARGE|OVERDRAFT|\bNSF\b|MAINTENANCE|INTEREST CHARGE|FINANCE CHARGE/, category: "fee" },
  // Check deposits are not cash.
  { when: (a) => a > 0, match: /\bMOBILE\b|\bREMOTE\b|CHECK DEP|\bACH\b|\bWIRE\b|ZELLE|REFUND|INTEREST/, category: "other" },
  // A teller or branch deposit is usually the cash drawer. A profile rule overrides this for a client who deposits checks at the branch.
  { when: (a, kind) => a > 0 && kind === "bank", match: /CASH|^DEPOSIT\b|BRANCH|TELLER|NIGHT DEP|COUNTER/, category: "cash_deposit" },
  { when: (a) => a < 0, match: /\bCHECK\b|\bCHK\b|\bACH\b|\bWIRE\b|BILL ?PAY|ZELLE|\bPOS\b|PURCHASE|DEBIT CARD/, category: "vendor_payment" },
  // On a card statement, every other charge is a purchase.
  { when: (a, kind) => a < 0 && kind === "credit_card", match: /./, category: "vendor_payment" },
];

/** The profile's own rules first, then the built-in ones. */
export function bankCategory(description: string, amountCents: number | null, kind: AccountKind, profile: BankProfile): BankCategory {
  for (const rule of profile.categories) if (new RegExp(rule.match, "i").test(description)) return rule.category;
  if (amountCents === null || amountCents === 0) return "other";
  const d = plain(description);
  return RULES.find((r) => r.when(amountCents, kind) && r.match.test(d))?.category ?? "other";
}

const REQUIRED_BASE = ["date", "description"];

/**
 * Finds the header row. Many banks put the account name and period above it,
 * so the first record that has every required column is the header.
 */
function tableOf(text: string, profile: BankProfile, fileName: string): { rows: CsvRow[]; get: ColumnGetter; signed: boolean } {
  const records = parseCsvRecords(text, profile.delimiter);
  const columns = profile.columns;
  const signedColumns = [...REQUIRED_BASE, "amount"];
  const splitColumns = [...REQUIRED_BASE, "debit", "credit"];
  const headerAt = records.findIndex((r) => hasColumns(r.fields, columns, signedColumns) || hasColumns(r.fields, columns, splitColumns));
  if (headerAt < 0) {
    const first = records[0]?.fields ?? [];
    // Name what's missing against the first line, the likeliest header.
    columnReader(first, columns, columns.amount !== undefined ? signedColumns : splitColumns, fileName);
    throw new MissingColumnsError(fileName, ["a header row"]);
  }
  const header = records[headerAt]!;
  const signed = hasColumns(header.fields, columns, signedColumns);
  // Re-read from the header so line numbers stay true to the file.
  const lines = text.split(/\r\n|\n|\r/);
  const table = parseCsv(lines.slice(header.line - 1).join("\n"), profile.delimiter);
  const offset = header.line - 1;
  const rows = table.rows.map((r) => ({ line: r.line + offset, values: r.values }));
  const get = columnReader(table.headers, columns, signed ? signedColumns : splitColumns, fileName);
  return { rows, get, signed };
}

/** Reads a CSV statement into lines. Rows with no date or no amount at all (titles, totals, opening balances) are skipped. */
export function csvStatementLines(text: string, profile: BankProfile, fileName: string): StatementLine[] {
  const { rows, get, signed } = tableOf(text, profile, fileName);
  const lines: StatementLine[] = [];
  for (const row of rows) {
    const dateText = get(row, "date");
    if (!present(dateText)) continue;
    let amountCents: number | null;
    if (signed) {
      const amount = get(row, "amount");
      if (!present(amount)) continue;
      const cents = parseMoney(amount);
      amountCents = cents === null ? null : profile.amounts === "money_out_positive" && cents !== 0 ? -cents : cents;
    } else {
      const debit = get(row, "debit");
      const credit = get(row, "credit");
      if (!present(debit) && !present(credit)) continue;
      const out = present(debit) ? parseMoney(debit) : 0;
      const into = present(credit) ? parseMoney(credit) : 0;
      amountCents = out === null || into === null ? null : Math.abs(into) - Math.abs(out);
    }
    const balance = get(row, "balance");
    const check = get(row, "checkNumber")?.trim();
    lines.push({
      sourceRow: `${fileName}:${row.line}`,
      occurredAt: parseDate(dateText, profile.dateOrder, profile.utcOffset) ?? undefined,
      amountCents,
      description: (get(row, "description") ?? "").trim().replace(/\s+/g, " "),
      ...(present(balance) ? { balanceCents: parseMoney(balance) } : {}),
      ...(check ? { checkNumber: check } : {}),
    });
  }
  return lines;
}

/** Statement lines to events, numbering identical same-day transactions so each is kept and none is doubled. */
export function statementEvents(lines: StatementLine[], ctx: StatementContext): BankEvent[] {
  const seen = new Map<string, number>();
  const events: BankEvent[] = [];
  for (const line of lines) {
    if (line.occurredAt !== undefined && line.occurredAt < ctx.since) continue;
    let base: string;
    if (line.occurredAt === undefined || line.amountCents === null) {
      // Unreadable: keyed by where it is, so fixing the file and re-reading stores it once.
      base = `${ctx.account.id}:row:${line.sourceRow}`;
    } else {
      const same = `${ctx.account.id}:${line.occurredAt.slice(0, 10)}:${line.amountCents}`;
      const n = seen.get(same) ?? 0;
      seen.set(same, n + 1);
      base = `${same}:${n}`;
    }
    const key = `bank:${base}`;
    const { sourceRow, occurredAt, amountCents, description, ...extra } = line;
    events.push({
      id: `bank_${base.replace(/[^A-Za-z0-9_.:-]/g, "_")}`,
      type: "bank.transaction_imported",
      occurredAt,
      receivedAt: ctx.receivedAt,
      idempotencyKey: key,
      payload: {
        transactionId: key,
        accountId: `bank:${ctx.account.id}`,
        accountKind: ctx.account.kind,
        amountCents,
        description,
        category: bankCategory(description, amountCents, ctx.account.kind, ctx.profile),
        ...extra,
        sourceRow,
      },
    });
  }
  return events;
}
