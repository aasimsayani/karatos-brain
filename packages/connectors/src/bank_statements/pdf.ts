import type { PdfLine } from "../files/pdf.js";
import { parseDate, parseMoney } from "../files/values.js";
import type { StatementLine } from "./normalize.js";
import { GENERIC_PDF_LAYOUT, type BankProfile, type PdfLayout } from "./profile.js";

/**
 * Reads the transactions in a PDF statement's text. Section headings say
 * which way the money moved, because statements list deposits and
 * withdrawals under their own headings with unsigned amounts. Dates written
 * without a year take it from the statement's closing date, so a December
 * line on a January statement lands in the right year. The lines this
 * returns are keyed like CSV lines, so a transaction in both a CSV export
 * and a PDF statement is stored once.
 */

export class PdfLayoutError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(message);
    this.name = "PdfLayoutError";
  }
}

type Mode = PdfLayout["sections"][number]["amounts"];

const DATE_FIRST = /^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\s/;
const MONEY_ANYWHERE = /\d\.\d{2}\b/;
const YEARLESS = /^(\d{1,2})[/-](\d{1,2})$/;

/** "25.00-" and "−25.00" are how some banks write money out. */
const money = (text: string | undefined) => {
  if (text === undefined) return null;
  let t = text.trim().replace(/−/g, "-");
  if (/\d-$/.test(t)) t = `-${t.slice(0, -1)}`;
  return parseMoney(t);
};

interface Closing {
  year: number;
  month: number;
  day: number;
}

function closingDate(text: string, profile: BankProfile): Closing | null {
  const iso = parseDate(text, profile.dateOrder);
  if (!iso) return null;
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) };
}

/** Adds the year to "12/03": the closing date's, or the year before when the day falls after it. */
function withYear(date: string, profile: BankProfile, closing: Closing | null): string | null {
  const m = YEARLESS.exec(date);
  if (!m) return date;
  if (!closing || profile.dateOrder === "ymd") return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  const [month, day] = profile.dateOrder === "mdy" ? [a, b] : [b, a];
  const after = month > closing.month || (month === closing.month && day > closing.day);
  const year = closing.year - (after ? 1 : 0);
  return profile.dateOrder === "mdy" ? `${month}/${day}/${year}` : `${day}/${month}/${year}`;
}

function signed(cents: number | null, mode: Mode, profile: BankProfile): number | null {
  if (cents === null) return null;
  if (mode === "money_in") return Math.abs(cents);
  if (mode === "money_out") return cents === 0 ? 0 : -Math.abs(cents);
  return profile.amounts === "money_out_positive" && cents !== 0 ? -cents : cents;
}

/**
 * No statement prints a line this long. Longer ones are never matched against
 * the layout's patterns, which can backtrack for seconds on a crafted line of
 * thousands of spaces; a dated one is kept, cut short, for a person to look at.
 */
export const MAX_PDF_LINE = 500;

export function pdfStatementLines(lines: readonly PdfLine[], profile: BankProfile, fileName: string): StatementLine[] {
  const layout = profile.pdf ?? GENERIC_PDF_LAYOUT;
  const transaction = new RegExp(layout.transaction, "i");
  const period = layout.period ? new RegExp(layout.period, "i") : null;
  const sections = layout.sections.map((s) => ({ match: new RegExp(s.match, "i"), amounts: s.amounts }));
  const ignore = layout.ignore.map((p) => new RegExp(p, "i"));

  let closing: Closing | null = null;
  if (period) {
    for (const line of lines) {
      if (line.text.length > MAX_PDF_LINE) continue;
      const end = period.exec(line.text)?.groups?.end;
      if (end && (closing = closingDate(end, profile))) break;
    }
  }

  const out: StatementLine[] = [];
  let mode: Mode = "signed";
  let headings = 0;
  for (const line of lines) {
    const text = line.text.trim();
    if (text.length > MAX_PDF_LINE) {
      if (headings > 0 && mode !== "skip" && DATE_FIRST.test(text)) {
        out.push({ sourceRow: `${fileName}:p${line.page}:${line.line}`, occurredAt: undefined, amountCents: null, description: text.slice(0, 120).replace(/\s+/g, " ") });
      }
      continue;
    }
    const section = sections.find((s) => s.match.test(text));
    if (section) {
      mode = section.amounts;
      headings++;
      continue;
    }
    if (mode === "skip" || ignore.some((p) => p.test(text))) continue;
    const sourceRow = `${fileName}:p${line.page}:${line.line}`;
    const groups = transaction.exec(text)?.groups;
    if (!groups) {
      // A dated line with money on it, inside a transactions section, that the layout can't read is kept for a person to look at.
      if (headings > 0 && DATE_FIRST.test(text) && MONEY_ANYWHERE.test(text)) {
        out.push({ sourceRow, occurredAt: undefined, amountCents: null, description: text.replace(/\s+/g, " ") });
      }
      continue;
    }
    const dated = groups.date ? withYear(groups.date.trim(), profile, closing) : null;
    let amountCents: number | null;
    if (groups.amount !== undefined) {
      amountCents = signed(money(groups.amount), mode, profile);
    } else {
      const out = groups.debit?.trim() ? money(groups.debit) : 0;
      const into = groups.credit?.trim() ? money(groups.credit) : 0;
      amountCents = out === null || into === null ? null : Math.abs(into) - Math.abs(out);
    }
    out.push({
      sourceRow,
      occurredAt: (dated && parseDate(dated, profile.dateOrder, profile.utcOffset)) ?? undefined,
      amountCents,
      description: (groups.description ?? "").trim().replace(/\s+/g, " "),
      ...(groups.balance !== undefined ? { balanceCents: money(groups.balance) } : {}),
    });
  }
  if (out.length === 0 && headings === 0) {
    throw new PdfLayoutError(fileName, "no transactions or section headings found; this bank's PDF layout needs a profile");
  }
  return out;
}
