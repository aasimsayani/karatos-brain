import { createHash } from "node:crypto";
import type { ColumnGetter, ColumnMap } from "../files/columns.js";
import type { CsvRow } from "../files/csv.js";
import type { SourceFile } from "../files/source.js";
import { parseDate, parseFlag, parseMoney, type DateOrder } from "../files/values.js";

/**
 * Turns rows of a store's Form 8300 filings log into compliance events.
 * FinCEN's BSA E-Filing System has no API, so a store keeps one row per
 * filing: when it was filed, the sales it covers, the cash, and the BSA
 * Tracking ID or BSA ID the system gives back. Each row becomes
 * `compliance.form_8300_filing_recorded`, keyed by the filing and a hash
 * of what the row says, so the same log exported again stores only the
 * changes (a status moving from submitted to accepted, a customer
 * statement sent). Only the columns below are read: names, addresses and
 * taxpayer numbers stay on the form and never reach KaratOS. A row that
 * can't be read becomes an event with no time and the problems it has,
 * which the pipeline dead-letters with the row kept.
 */

export const FILING_EVENT_TYPE = "compliance.form_8300_filing_recorded";

/** BSA E-Filing's own words for where a filing stands, plus submitted for one not yet acknowledged. */
export const FILING_STATUSES = ["submitted", "accepted", "accepted_with_warnings", "rejected"] as const;
export type FilingStatus = (typeof FILING_STATUSES)[number];

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface Form8300Event {
  id: string;
  type: typeof FILING_EVENT_TYPE;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** The log's columns, by the names stores and the template in docs/integrations/fincen_8300.md use. */
export const FILING_COLUMNS: ColumnMap = {
  filedOn: ["Filed On", "Date Filed", "Filing Date", "Filed"],
  cashReceivedOn: ["Cash Received On", "Date Cash Received", "Transaction Date", "Payment Date"],
  saleIds: ["Sale IDs", "Sale ID", "Sales", "Receipt No", "Invoice No", "Transaction IDs"],
  cash: ["Cash Amount", "Total Cash", "Cash Received", "Amount"],
  bsaId: ["BSA ID", "BSAID"],
  trackingId: ["BSA Tracking ID", "Tracking ID", "Track ID"],
  customerId: ["Customer ID", "Customer No", "Customer Number"],
  status: ["Status", "Filing Status"],
  statementSentOn: ["Statement Sent On", "Customer Statement Sent", "Statement Sent"],
  /** Box 1b: filed voluntarily for a suspicious transaction. The customer must not be told about these. */
  suspicious: ["Suspicious", "Suspicious Transaction", "Box 1b"],
};

/** Columns every filings log needs. */
export const FILING_REQUIRED = ["filedOn", "cashReceivedOn", "saleIds", "cash"];

/** IRS: file within 15 days of the cash that makes the total reportable. */
export const FILING_DEADLINE_DAYS = 15;

export interface FilingRowContext {
  file: SourceFile;
  dateOrder: DateOrder;
  receivedAt: string;
  /** Rows filed before this ISO time are skipped. */
  since: string;
}

const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";
const hash12 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const DAY_MS = 86_400_000;

const STATUS_RULES: [RegExp, FilingStatus][] = [
  [/\breject/, "rejected"],
  [/\baccepted\b.*\bwarning/, "accepted_with_warnings"],
  [/\baccepted\b/, "accepted"],
  [/\b(?:submitted|filed|sent|pending|received|processing)\b/, "submitted"],
];

/** "Accepted with Warnings", "REJECTED", "Filed" to a status; null for anything else. Blank is submitted. */
export function filingStatus(label: string | undefined): FilingStatus | null {
  if (!present(label)) return "submitted";
  const t = label.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  return STATUS_RULES.find(([pattern]) => pattern.test(t))?.[1] ?? null;
}

/** BSA IDs are 14 digits; a BSA Tracking ID is a shorter run of digits. */
const BSA_ID = /^\d{14}$/;
const TRACKING_ID = /^\d{6,20}$/;
const SALE_ID = /^[A-Za-z0-9][A-Za-z0-9._#/-]{0,63}$/;

/** "S-1, S-2; S-3" to the distinct sale ids, in order. Null when one isn't an id. */
export function saleIdList(text: string): string[] | null {
  const ids = text.split(/[,;]+|\s+/).map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0 || !ids.every((id) => SALE_ID.test(id))) return null;
  return [...new Set(ids)];
}

function unreadable(ctx: FilingRowContext, row: CsvRow, problems: string[]): Form8300Event {
  const where = `${ctx.file.name}:${row.line}`;
  const key = `fincen_8300:unreadable:${where}`;
  return {
    id: key.replace(/[^A-Za-z0-9_.:-]/g, "_"),
    type: FILING_EVENT_TYPE,
    // A row with a problem has no time, so the pipeline dead-letters it with the row kept.
    occurredAt: undefined,
    receivedAt: ctx.receivedAt,
    idempotencyKey: key,
    payload: { system: "FinCEN BSA E-Filing", problems, sourceRow: where },
  };
}

/**
 * One filing. Its id is the BSA ID when the row has one, else the BSA
 * Tracking ID, else the sales and the day the cash came in, so a row
 * filled in over time (tracking ID first, BSA ID later) still reads as
 * one filing as long as it keeps its tracking ID. Its time is the day it
 * was filed.
 */
export function filingEvent(row: CsvRow, get: ColumnGetter, ctx: FilingRowContext): Form8300Event | null {
  const filedText = get(row, "filedOn");
  const receivedText = get(row, "cashReceivedOn");
  const salesText = get(row, "saleIds");
  const cashText = get(row, "cash");
  if (![filedText, receivedText, salesText, cashText].some(present)) return null;
  const problems: string[] = [];
  const date = (label: string, text: string | undefined): string | null => {
    if (!present(text)) {
      problems.push(`no ${label}`);
      return null;
    }
    const iso = parseDate(text, ctx.dateOrder);
    if (iso === null) problems.push(`${label} ${JSON.stringify(text.trim())} is not a date`);
    return iso;
  };
  const filedAt = date("filing date", filedText);
  const receivedAt = date("date cash was received", receivedText);
  const saleIds = present(salesText) ? saleIdList(salesText) : null;
  if (!present(salesText)) problems.push("no sale");
  else if (saleIds === null) problems.push(`sales ${JSON.stringify(salesText.trim())} are not sale ids`);
  const cashCents = present(cashText) ? parseMoney(cashText) : null;
  if (!present(cashText)) problems.push("no cash amount");
  else if (cashCents === null || cashCents <= 0) problems.push(`cash amount ${JSON.stringify(cashText.trim())} is not an amount of money`);
  const statusLabel = get(row, "status")?.trim();
  const status = filingStatus(statusLabel);
  if (status === null) problems.push(`status ${JSON.stringify(statusLabel)} is not a BSA E-Filing status`);
  const bsaId = get(row, "bsaId")?.trim() || undefined;
  if (bsaId !== undefined && !BSA_ID.test(bsaId)) problems.push(`BSA ID ${JSON.stringify(bsaId)} is not 14 digits`);
  const trackingId = get(row, "trackingId")?.trim() || undefined;
  if (trackingId !== undefined && !TRACKING_ID.test(trackingId)) problems.push(`BSA Tracking ID ${JSON.stringify(trackingId)} is not 6 to 20 digits`);
  const statementText = get(row, "statementSentOn");
  const statementAt = present(statementText) ? date("statement date", statementText) : undefined;
  const suspiciousText = get(row, "suspicious");
  const suspicious = present(suspiciousText) ? parseFlag(suspiciousText) : false;
  if (suspicious === null) problems.push(`suspicious ${JSON.stringify(suspiciousText!.trim())} is not yes or no`);
  if (filedAt && receivedAt && filedAt < receivedAt) problems.push("filed before the cash was received");
  if (problems.length || !filedAt || !receivedAt || !saleIds || cashCents === null || cashCents <= 0 || status === null || suspicious === null) return unreadable(ctx, row, problems);
  if (filedAt < ctx.since) return null;

  const filedOn = filedAt.slice(0, 10);
  const cashReceivedOn = receivedAt.slice(0, 10);
  const filingId = bsaId ?? trackingId ?? `${[...saleIds].sort().join("+")}@${cashReceivedOn}`;
  const say: Record<string, unknown> = {
    system: "FinCEN BSA E-Filing",
    filingId,
    filedOn,
    cashReceivedOn,
    saleIds,
    cashCents,
    status,
    daysToFile: Math.round((Date.parse(filedOn) - Date.parse(cashReceivedOn)) / DAY_MS),
  };
  if (statusLabel) say.statusLabel = statusLabel;
  if (bsaId) say.bsaId = bsaId;
  if (trackingId) say.trackingId = trackingId;
  const customerId = get(row, "customerId")?.trim();
  if (customerId) say.customerId = customerId;
  if (statementAt) say.statementSentOn = statementAt.slice(0, 10);
  if (suspicious) say.suspicious = true;
  const key = `fincen_8300:filing:${filingId}:${hash12(say)}`;
  return {
    id: key.replace(/[^A-Za-z0-9_.:-]/g, "_"),
    type: FILING_EVENT_TYPE,
    occurredAt: filedAt,
    receivedAt: ctx.receivedAt,
    idempotencyKey: key,
    payload: { ...say, sourceRow: `${ctx.file.name}:${row.line}` },
  };
}
