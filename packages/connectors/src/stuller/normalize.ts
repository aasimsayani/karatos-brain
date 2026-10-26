import { createHash } from "node:crypto";

/**
 * Turns Stuller invoices and metal market rates into Brain A events. Each
 * invoice becomes vendor_invoice.received with its lines, totals, status,
 * tracking number and the metal rates it was priced at, keyed by invoice
 * number and content, so an invoice whose status or tracking changes is a
 * new event and one read again is a duplicate. Stuller's metal rates become
 * one vendor_metal_rate.published event whenever they change.
 *
 * Ship-to addresses aren't stored: a drop-shipped order carries the
 * business's customer's address. Only the ship-to account number is kept.
 * An invoice without a readable number or date, or with an amount that
 * doesn't read, is dead-lettered listing what was wrong.
 */

export interface StullerEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const STULLER_EVENT_TYPES = { invoice: "vendor_invoice.received", metalRates: "vendor_metal_rate.published" } as const;

/** Invoice numbers as Stuller writes them. */
export const STULLER_INVOICE_NUMBER = /^[A-Za-z0-9_-]{1,40}$/;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** An amount in US dollars, 251 or "0.00", as whole cents. Null when it isn't a number. */
export function stullerCents(value: unknown): number | null {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(/^\$/, "").replace(/,/g, "") : "";
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(Number((n * 100).toPrecision(12))) : null;
}

/** A weight as Stuller writes it, "2.10 DWT" or "1.5 g", as a number and unit. Null when it doesn't read. */
export function stullerWeight(value: unknown): { amount: number; unit: string } | null {
  const m = /^(\d+(?:\.\d+)?)\s*([A-Za-z]{1,6})$/.exec(text(value) ?? "");
  return m ? { amount: Number(m[1]), unit: m[2]!.toUpperCase() } : null;
}

/** A Stuller time as ISO, or null when it isn't a real time. Times without a zone are read as UTC. */
export function stullerTime(value: unknown): string | null {
  const raw = text(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw)) return null;
  const zoned = /T/.test(raw) && !/(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? `${raw}Z` : raw;
  const [y, m, d] = raw.slice(0, 10).split("-").map(Number) as [number, number, number];
  // Date.parse rolls 2026-02-30 over to March; a real day round-trips.
  if (new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) !== raw.slice(0, 10)) return null;
  const t = Date.parse(zoned);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export type StullerInvoiceRead = { ok: true; invoiceNumber: string; hash: string; event: StullerEvent } | { ok: false; invoiceNumber: string | null; event: StullerEvent };

/** Reads one invoice into an event, dead-lettered when anything in it doesn't read. */
export function invoiceEvent(raw: unknown, receivedAt: string): StullerInvoiceRead {
  const problems: string[] = [];
  const inv = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!inv) problems.push("is not an invoice");
  const get = (k: string) => inv?.[k];
  const invoiceNumber = text(get("InvoiceNumber")) ?? "";
  if (!STULLER_INVOICE_NUMBER.test(invoiceNumber)) problems.push("has no invoice number that reads");
  const invoiceDate = stullerTime(get("InvoiceDate"));
  if (!invoiceDate) problems.push("has no invoice date that reads");
  const orderDate = get("OrderDate") === undefined || get("OrderDate") === null || get("OrderDate") === "" ? null : stullerTime(get("OrderDate"));
  if (orderDate === null && text(get("OrderDate"))) problems.push("has an order date that doesn't read");

  const money = (k: string) => {
    const c = stullerCents(get(k));
    if (c === null) problems.push(`has an unreadable ${k}`);
    return c;
  };
  const totals = { orderCents: money("OrderTotal"), invoiceCents: money("InvoiceTotal"), dueCents: money("TotalDue"), salesTaxCents: money("SalesTax"), shippingCents: money("PostageAndHandling") };

  const rawLines = get("InvoiceDetails");
  if (!Array.isArray(rawLines)) problems.push("has no InvoiceDetails list");
  const lines = (Array.isArray(rawLines) ? rawLines : []).map((l, i) => {
    const line = typeof l === "object" && l !== null ? (l as Record<string, unknown>) : {};
    const lineMoney = (k: string, required: boolean) => {
      const v = line[k];
      if (!required && (v === undefined || v === null || v === "")) return null;
      const c = stullerCents(v);
      if (c === null) problems.push(`line ${i + 1} has an unreadable ${k}`);
      return c;
    };
    const qty = (k: string) => (typeof line[k] === "number" && Number.isFinite(line[k]) ? (line[k] as number) : null);
    const itemNumber = text(line.ItemNumber);
    if (!itemNumber) problems.push(`line ${i + 1} has no item number`);
    return {
      lineNumber: qty("LineNumber") ?? i + 1,
      customerLineReference: text(line.CustomerLineReference),
      itemNumber,
      description: text(line.ItemDescription),
      shipQuantity: qty("ShipQuantity"),
      backOrderedQuantity: qty("BackOrderedQuantity"),
      unitOfMeasure: text(line.UnitPriceUnitOfMeasure),
      unitPriceCents: lineMoney("UnitPrice", true),
      lineTotalCents: lineMoney("LineTotal", true),
      laborOtherChargesCents: lineMoney("LaborOtherCharges", false),
      weight: stullerWeight(line.TotalWeight),
      notes: text(line.CustomerNotes),
    };
  });

  const rate = (prefix: string) => {
    const r = stullerCents(get(`${prefix}MarketRate`));
    return r === null || r <= 0 ? undefined : { perTroyOunceCents: r, baseCents: stullerCents(get(`${prefix}MarketBase`)), adderCents: stullerCents(get(`${prefix}MarketAdder`)) };
  };

  const payload: Record<string, unknown> = {
    vendor: "Stuller",
    invoiceNumber,
    orderNumber: text(get("OrderNumber")),
    purchaseOrderNumber: text(get("PurchaseOrderNumber")),
    shipToAccount: text(get("ShipToAccountNumber")),
    status: text(get("Status")),
    invoiceDate,
    orderDate,
    currency: "USD",
    ...totals,
    shipMethod: text(get("ShipMethod")),
    trackingNumber: text(get("TrackingNumber")),
    metalRates: { gold: rate("Gold"), silver: rate("Silver"), platinum: rate("Platinum") },
    lines,
  };
  const hash = short(payload);
  const ok = problems.length === 0;
  const key = ok ? `stuller:invoice:${invoiceNumber}:${hash}` : `stuller:unreadable_invoice:${short(raw)}`;
  const event: StullerEvent = {
    id: key.replace(/^stuller:/, "stuller_"),
    type: STULLER_EVENT_TYPES.invoice,
    // The invoice's own date. One with a problem has none, so it is dead-lettered.
    occurredAt: ok ? invoiceDate! : undefined,
    receivedAt,
    idempotencyKey: key,
    payload: ok ? payload : { vendor: "Stuller", invoiceNumber: invoiceNumber || null, problems },
  };
  return ok ? { ok, invoiceNumber, hash, event } : { ok, invoiceNumber: STULLER_INVOICE_NUMBER.test(invoiceNumber) ? invoiceNumber : null, event };
}

const METAL_NAMES: Record<string, string> = { gold: "gold", silver: "silver", platinum: "platinum", palladium: "palladium" };

/** Stuller's current rates as one event, or null when none read. Keyed by the rates, so unchanged rates are a duplicate. */
export function metalRatesEvent(rows: unknown[], receivedAt: string): StullerEvent | null {
  const rates: Record<string, number> = {};
  for (const row of rows) {
    const r = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {};
    const metal = METAL_NAMES[(text(r.Type) ?? "").toLowerCase()];
    const cents = stullerCents(r.Rate);
    if (metal && cents !== null && cents > 0) rates[metal] = cents;
  }
  if (Object.keys(rates).length === 0) return null;
  const key = `stuller:metal_rates:${short(rates)}`;
  return {
    id: key.replace(/^stuller:/, "stuller_"),
    type: STULLER_EVENT_TYPES.metalRates,
    // When KaratOS read them: Stuller's answer carries no time.
    occurredAt: receivedAt,
    receivedAt,
    idempotencyKey: key,
    payload: { vendor: "Stuller", currency: "USD", unit: "per_troy_ounce", perTroyOunceCents: rates },
  };
}
