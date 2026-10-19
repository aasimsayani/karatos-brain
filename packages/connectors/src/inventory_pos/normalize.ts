import { createHash } from "node:crypto";
import { squash, type ColumnGetter } from "../files/columns.js";
import type { CsvRow } from "../files/csv.js";
import type { SourceFile } from "../files/source.js";
import { parseDate, parseDecimal, parseFlag, parseInteger, parseMoney } from "../files/values.js";
import type { FileKind, PosProfile } from "./profile.js";

/**
 * Turns rows of POS exports into Brain A events, following the retail
 * departments' schemas: sale.completed and sale.returned (sales),
 * inventory.received and inventory.counted (inventory) and
 * customer.profile_updated (clienteling). A row that can't be read becomes
 * an event with the bad value left null, so the department schema
 * dead-letters it with the row kept. Only the mapped columns are read: no
 * email addresses, phone numbers or street addresses.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface PosEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface RowContext {
  profile: PosProfile;
  file: SourceFile;
  receivedAt: string;
  /** Rows dated before this ISO time are skipped. */
  since: string;
}

type Getter = ColumnGetter;

const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

function event(ctx: RowContext, key: string, type: string, occurredAt: string | null | undefined, payload: Record<string, unknown>): PosEvent {
  const full = `${ctx.profile.id}:${key}`;
  return { id: `pos_${full.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt: occurredAt ?? undefined, receivedAt: ctx.receivedAt, idempotencyKey: `pos:${full}`, payload };
}

const ref = (ctx: RowContext, kind: string, id: string) => `pos:${ctx.profile.id}:${kind}:${id.trim()}`;
const where = (ctx: RowContext, row: CsvRow) => `${ctx.file.name}:${row.line}`;

/** A row's date, or the file's own time when the column is unmapped or empty. Undefined when the value can't be read. */
function dateOrFile(ctx: RowContext, value: string | undefined): string | undefined {
  if (!present(value)) return ctx.file.modifiedAt;
  return parseDate(value, ctx.profile.dateOrder, ctx.profile.utcOffset) ?? undefined;
}

/** An empty optional money column reads as zero; one that is filled but unreadable stays null. */
const moneyOrZero = (value: string | undefined) => (present(value) ? parseMoney(value) : 0);

const tooOld = (ctx: RowContext, occurredAt: string | undefined) => occurredAt !== undefined && occurredAt < ctx.since;

// Earrings before rings: "earrings" contains "ring".
const CATEGORY_WORDS: [RegExp, string][] = [
  [/engagement|bridal|solitaire/, "engagement_ring"],
  [/wedding|band/, "wedding_band"],
  [/earring|stud|hoop/, "earrings"],
  [/necklace|chain|choker/, "necklace"],
  [/pendant|charm/, "pendant"],
  [/bracelet|bangle/, "bracelet"],
  [/watch/, "watch"],
  [/loose|gemstone|stone/, "loose_stone"],
  [/ring/, "ring"],
];

export function posCategory(label: string | undefined, profile: PosProfile): string {
  const l = squash(label ?? "");
  if (profile.categories[l]) return profile.categories[l]!;
  return CATEGORY_WORDS.find(([words]) => words.test(l))?.[1] ?? "other";
}

/** "14K Yellow Gold" → gold, 14. Unrecognized metals are left out rather than guessed. */
export function posMetal(label: string | undefined): { metal?: string; karat?: number } {
  const l = (label ?? "").toLowerCase();
  const metal = /platinum|\bplat\b|\bpt\d*\b/.test(l)
    ? "platinum"
    : /palladium/.test(l)
      ? "palladium"
      : /silver|sterling|\b925\b/.test(l)
        ? "silver"
        : /gold|\d\s*k/.test(l)
          ? "gold"
          : undefined;
  const karat = /(\d{1,2})\s*(k|kt|karat)\b/.exec(l);
  return { ...(metal ? { metal } : {}), ...(karat ? { karat: Number(karat[1]) } : {}) };
}

export function posPaymentMethod(label: string | undefined, profile: PosProfile): string {
  const l = squash(label ?? "");
  if (profile.payments[l]) return profile.payments[l]!;
  if (/gift/.test(l)) return "gift_card";
  if (/trade/.test(l)) return "trade_in";
  if (/financ|synchrony|affirm|acima|klarna|afterpay|layaway/.test(l)) return "financing";
  if (/cash/.test(l)) return "cash";
  if (/check|cheque/.test(l)) return "check";
  if (/wire|ach|transfer|zelle/.test(l)) return "wire";
  if (/card|visa|master|amex|american express|discover|debit|credit|apple pay|google pay/.test(l)) return "card";
  return "other";
}

function channel(label: string | undefined): string {
  const l = squash(label ?? "");
  if (/online|web|ecom|internet|shop/.test(l)) return "online";
  if (/phone/.test(l)) return "phone";
  if (/event|show|trunk/.test(l)) return "event";
  return "store";
}

export function posItemEvents(rows: CsvRow[], get: Getter, ctx: RowContext): PosEvent[] {
  const events: PosEvent[] = [];
  for (const row of rows) {
    const sku = get(row, "sku")?.trim() ?? "";
    const qtyText = get(row, "quantity");
    const quantity = present(qtyText) ? parseInteger(qtyText) : 1;
    // An item list also carries pieces already sold; with none on hand there is nothing to receive.
    if (quantity === 0) continue;
    const occurredAt = dateOrFile(ctx, get(row, "receivedDate"));
    if (tooOld(ctx, occurredAt)) continue;
    const metalText = get(row, "metal");
    const { metal, karat: karatFromMetal } = posMetal(metalText);
    const karatText = get(row, "karat");
    const karat = present(karatText) ? parseInteger(karatText.replace(/\s*(k|kt|karat)$/i, "")) : karatFromMetal;
    const weightText = get(row, "weightGrams");
    const vendor = get(row, "vendor")?.trim();
    const memo = get(row, "onMemo");
    const categoryText = get(row, "category");
    events.push(
      event(ctx, `item:${sku}`, "inventory.received", occurredAt, {
        sku,
        title: get(row, "title")?.trim() ?? "",
        category: posCategory(categoryText, ctx.profile),
        ...(present(categoryText) ? { posCategory: categoryText.trim() } : {}),
        ...(metal ? { metal } : {}),
        ...(present(metalText) && !metal ? { posMetal: metalText.trim() } : {}),
        ...(karat !== undefined ? { karat } : {}),
        ...(present(weightText) ? { weightGrams: parseDecimal(weightText) } : {}),
        costCents: parseMoney(get(row, "cost")),
        retailPriceCents: parseMoney(get(row, "retailPrice")),
        quantity,
        ...(vendor ? { vendorId: ref(ctx, "vendor", vendor) } : {}),
        onMemo: present(memo) ? parseFlag(memo) : false,
        sourceRow: where(ctx, row),
      }),
    );
  }
  return events;
}

/** A stock count records what was on hand on a date; the inventory department reconciles counts against sales. */
export function posStockEvents(rows: CsvRow[], get: Getter, ctx: RowContext): PosEvent[] {
  const events: PosEvent[] = [];
  for (const row of rows) {
    const sku = get(row, "sku")?.trim() ?? "";
    const occurredAt = dateOrFile(ctx, get(row, "date"));
    if (tooOld(ctx, occurredAt)) continue;
    events.push(
      event(ctx, `count:${sku}:${occurredAt ?? where(ctx, row)}`, "inventory.counted", occurredAt, {
        sku,
        onHand: parseInteger(get(row, "onHand")),
        sourceRow: where(ctx, row),
      }),
    );
  }
  return events;
}

export function posCustomerEvents(rows: CsvRow[], get: Getter, ctx: RowContext): PosEvent[] {
  const events: PosEvent[] = [];
  for (const row of rows) {
    const id = get(row, "customerId")?.trim() ?? "";
    const occurredAt = dateOrFile(ctx, get(row, "updatedDate"));
    if (tooOld(ctx, occurredAt)) continue;
    const name = get(row, "name")?.trim() ?? "";
    const consentText = get(row, "marketingConsent");
    // Consent is never assumed: an empty column is no, and an unreadable one is dead-lettered.
    const marketingConsent = present(consentText) ? parseFlag(consentText) : false;
    // A changed name or consent is a new profile event; the same row exported again is not.
    events.push(
      event(ctx, `customer:${id}:${short(`${name}|${marketingConsent}`)}`, "customer.profile_updated", occurredAt, {
        customerId: id ? ref(ctx, "customer", id) : "",
        name,
        marketingConsent,
        sourceRow: where(ctx, row),
      }),
    );
  }
  return events;
}

/**
 * Groups line rows into receipts. Lines with a positive quantity make the
 * sale; negative ones are returned goods, grouped by return id. A receipt
 * with both (an exchange) gives one of each.
 */
export function posSalesEvents(rows: CsvRow[], get: Getter, ctx: RowContext): PosEvent[] {
  const receipts = new Map<string, CsvRow[]>();
  for (const row of rows) {
    const id = get(row, "saleId")?.trim() ?? "";
    receipts.set(id, [...(receipts.get(id) ?? []), row]);
  }
  const events: PosEvent[] = [];
  for (const [saleId, lines] of receipts) {
    const first = lines[0]!;
    const occurredAt = parseDate(get(first, "date"), ctx.profile.dateOrder, ctx.profile.utcOffset) ?? undefined;
    if (tooOld(ctx, occurredAt)) continue;
    const quantity = (r: CsvRow) => parseInteger(get(r, "quantity"));
    // An unreadable quantity stays on the sale, so the sale is dead-lettered rather than short a line.
    const sold = lines.filter((r) => quantity(r) === null || quantity(r)! > 0);
    const returned = lines.filter((r) => quantity(r)! < 0);
    const where0 = where(ctx, first);

    if (sold.length) {
      const saleLines = sold.map((r) => ({
        sku: get(r, "sku")?.trim() ?? "",
        quantity: quantity(r),
        unitPriceCents: parseMoney(get(r, "unitPrice")),
        discountCents: moneyOrZero(get(r, "discount")),
      }));
      const totalText = get(sold[0]!, "total");
      const summed = saleLines.every((l) => l.quantity !== null && l.unitPriceCents !== null && l.discountCents !== null)
        ? saleLines.reduce((sum, l) => sum + l.quantity! * l.unitPriceCents! - l.discountCents!, 0)
        : null;
      const totalCents = present(totalText) ? parseMoney(totalText) : summed;
      const methods = new Set(sold.map((r) => get(r, "paymentMethod")).filter(present).map((m) => posPaymentMethod(m, ctx.profile)));
      const customer = sold.map((r) => get(r, "customerId")).find(present);
      const salesperson = sold.map((r) => get(r, "salesperson")).find(present);
      events.push(
        event(ctx, `sale:${saleId}`, "sale.completed", occurredAt, {
          saleId: saleId ? ref(ctx, "sale", saleId) : "",
          ...(customer ? { customerId: ref(ctx, "customer", customer) } : {}),
          channel: channel(get(first, "channel")),
          lines: saleLines,
          totalCents,
          // One tender per sale: exports list it per line, so lines that disagree become "other".
          payments: [{ method: methods.size === 1 ? [...methods][0]! : "other", amountCents: totalCents }],
          ...(salesperson ? { salespersonId: ref(ctx, "staff", salesperson) } : {}),
          sourceRow: where0,
        }),
      );
    }

    const returns = new Map<string, CsvRow[]>();
    for (const r of returned) {
      const id = get(r, "returnId")?.trim() || saleId;
      returns.set(id, [...(returns.get(id) ?? []), r]);
    }
    for (const [returnId, rlines] of returns) {
      const original = rlines.map((r) => get(r, "originalSaleId")).find(present)?.trim() ?? saleId;
      events.push(
        event(ctx, `return:${returnId}`, "sale.returned", occurredAt, {
          saleId: original ? ref(ctx, "sale", original) : "",
          returnId: ref(ctx, "return", returnId),
          lines: rlines.map((r) => {
            const q = Math.abs(quantity(r)!);
            const unit = parseMoney(get(r, "unitPrice"));
            const discount = moneyOrZero(get(r, "discount"));
            return { sku: get(r, "sku")?.trim() ?? "", quantity: q, refundCents: unit === null || discount === null ? null : q * Math.abs(unit) - Math.abs(discount) };
          }),
          sourceRow: where(ctx, rlines[0]!),
        }),
      );
    }
  }
  return events;
}

export const REQUIRED_COLUMNS: Record<FileKind, string[]> = {
  items: ["sku", "title", "cost", "retailPrice"],
  stock: ["sku", "onHand"],
  customers: ["customerId", "name"],
  sales: ["saleId", "date", "sku", "quantity", "unitPrice"],
};

export const ROW_EVENTS: Record<FileKind, (rows: CsvRow[], get: Getter, ctx: RowContext) => PosEvent[]> = {
  items: posItemEvents,
  stock: posStockEvents,
  customers: posCustomerEvents,
  sales: posSalesEvents,
};
