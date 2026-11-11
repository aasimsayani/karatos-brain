import { createHash } from "node:crypto";
import { quoTime } from "../openphone/normalize.js";

/**
 * Turns ShipStation shipments and labels into Brain A events, so sales and
 * compliance see what shipped, how it was insured and whether it arrived:
 *
 * - `shipment.updated` for each shipment: its status, carrier and service,
 *   the confirmation asked for, the insurance provider and the insured
 *   value of its packages next to what the customer paid, the order it
 *   ships, its items' skus and count, and its destination's state and
 *   country. When both are in one currency, how far the insured value falls
 *   short of what was paid is kept, so an underinsured parcel stands out.
 * - `shipment.tracked` for each label, the event the UPS connector gives:
 *   its tracking number and carrier, a status every carrier maps to, the
 *   service, whether a signature was asked for, the label's and the
 *   insurance's cost, the insured value, and whether it was voided.
 *
 * Names, street addresses, postal codes, phone numbers, email addresses,
 * buyer and gift notes and label images are never read into an event.
 *
 * Each event is keyed by the record and a digest of what was kept, so
 * reading it again is a duplicate and a change is a new event. A shipment
 * or label without an id, a status or a time that reads is dead-lettered
 * listing what was wrong.
 */

export interface ShipStationEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const SHIPSTATION_SHIPMENT_EVENT = "shipment.updated";
export const SHIPSTATION_LABEL_EVENT = "shipment.tracked";
const SYSTEM = "ShipStation";
const SHIPMENT_STATUSES = new Set(["pending", "processing", "label_purchased", "cancelled"]);
const LABEL_STATUSES = new Set(["processing", "completed", "error", "voided"]);
/** Each tracking status as the status every carrier maps to. */
const TRACKING = new Map([
  ["in_transit", "in_transit"],
  ["delivered", "delivered"],
  ["error", "exception"],
]);
const MAX_SKUS = 20;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown) => (Array.isArray(v) ? v : []);
const time = (v: unknown) => quoTime(v) ?? undefined;
/** A ShipStation id or code, such as se-28529731 or usps_priority_mail. */
const word = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v) ? v : undefined);
/** A store's order or shipment number: up to 50 characters ShipStation keeps, without spaces or markup. */
const reference = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9#][A-Za-z0-9#_./-]{0,49}$/.test(v) ? v : undefined);
const region = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : undefined);

/** An amount as {currency, amount} in whole cents, or undefined when it doesn't read. */
export function shipStationMoney(v: unknown): { cents: number; currency: string } | undefined {
  const m = obj(v);
  const amount = m.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e9) return undefined;
  const currency = region(m.currency, /^[A-Z]{3}$/);
  return currency ? { cents: Math.round(amount * 100), currency } : undefined;
}

/** Amounts added up, when every one reads and all are in one currency. */
function total(amounts: unknown[]): { cents: number; currency: string } | undefined {
  const read = amounts.map(shipStationMoney);
  if (read.some((m) => !m) || new Set(read.map((m) => m!.currency)).size !== 1) return undefined;
  return { cents: read.reduce((sum, m) => sum + m!.cents, 0), currency: read[0]!.currency };
}

export interface ShipStationContext {
  receivedAt: string;
}

export type ShipStationRead = { ok: boolean; event: ShipStationEvent };

function read(kind: "shipment" | "label", type: string, raw: unknown, problems: string[], id: string | undefined, at: string | undefined, payload: Record<string, unknown>, receivedAt: string): ShipStationRead {
  const ok = problems.length === 0;
  const key = ok ? `shipstation:${kind}:${id}:${short(payload)}` : `shipstation:unreadable_${kind}:${short(raw)}`;
  return {
    ok,
    event: {
      id: key.replace(/:/g, "_"),
      type,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? at : undefined,
      receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: SYSTEM, [`${kind}Id`]: id ?? null, problems },
    },
  };
}

export function shipStationShipmentEvent(raw: unknown, ctx: ShipStationContext): ShipStationRead {
  const problems: string[] = [];
  const s = obj(raw);
  if (s !== raw) problems.push("shipment is not an object");
  const id = word(s.shipment_id);
  if (!id) problems.push("shipment has no id that reads");
  const modifiedAt = time(s.modified_at);
  if (!modifiedAt) problems.push("shipment has no change time that reads");
  const status = typeof s.shipment_status === "string" && SHIPMENT_STATUSES.has(s.shipment_status) ? s.shipment_status : undefined;
  if (!status) problems.push("shipment has no status ShipStation documents");

  const packages = list(s.packages).map(obj);
  const provider = word(s.insurance_provider);
  const insured = provider !== undefined && provider !== "none" ? total(packages.map((p) => p.insured_value)) : undefined;
  const paid = shipStationMoney(s.amount_paid);
  const items = list(s.items).map(obj);
  const quantities = items.map((i) => i.quantity);
  const skus = [...new Set(items.map((i) => reference(i.sku)).filter((sku): sku is string => sku !== undefined))].sort().slice(0, MAX_SKUS);
  const shipTo = obj(s.ship_to);
  const confirmation = word(s.confirmation);
  const payload: Record<string, unknown> = {
    system: SYSTEM,
    shipmentId: `shipstation:shipment:${id}`,
    orderRef: reference(s.external_order_id),
    shipmentNumber: reference(s.shipment_number),
    storeId: word(s.store_id),
    orderSource: word(s.order_source_code),
    status,
    carrierId: word(s.carrier_id),
    service: word(s.service_code),
    confirmation,
    signatureRequired: confirmation !== undefined && confirmation.includes("signature"),
    insuranceProvider: provider,
    insuredCents: insured?.cents,
    paidCents: paid?.cents,
    currency: insured?.currency ?? paid?.currency,
    // How far the insured value falls short of what the customer paid, when both are in one currency.
    underinsuredCents: insured && paid && insured.currency === paid.currency ? Math.max(0, paid.cents - insured.cents) : undefined,
    packages: packages.length,
    items: quantities.every((q) => Number.isSafeInteger(q) && (q as number) >= 0) ? quantities.reduce((sum: number, q) => sum + (q as number), 0) : undefined,
    skus,
    isReturn: s.is_return === true,
    isGift: s.is_gift === true,
    destinationState: region(shipTo.state_province, /^[A-Z]{2,3}$/),
    destinationCountry: region(shipTo.country_code, /^[A-Z]{2}$/),
    shipDate: time(s.ship_date),
    createdAt: time(s.created_at),
    modifiedAt,
  };
  return read("shipment", SHIPSTATION_SHIPMENT_EVENT, raw, problems, id, modifiedAt, payload, ctx.receivedAt);
}

export function shipStationLabelEvent(raw: unknown, ctx: ShipStationContext): ShipStationRead {
  const problems: string[] = [];
  const l = obj(raw);
  if (l !== raw) problems.push("label is not an object");
  const id = word(l.label_id);
  if (!id) problems.push("label has no id that reads");
  const createdAt = time(l.created_at);
  if (!createdAt) problems.push("label has no creation time that reads");
  const labelStatus = typeof l.status === "string" && LABEL_STATUSES.has(l.status) ? l.status : undefined;
  if (!labelStatus) problems.push("label has no status ShipStation documents");

  const tracking = TRACKING.get(l.tracking_status as string);
  const voided = l.voided === true || labelStatus === "voided";
  const confirmation = word(l.confirmation);
  const shipTo = obj(l.ship_to);
  const cost = shipStationMoney(l.shipment_cost);
  const insurance = shipStationMoney(l.insurance_cost);
  const insured = total(list(l.packages).map((p) => obj(p).insured_value));
  const payload: Record<string, unknown> = {
    system: SYSTEM,
    shipmentId: `shipstation:label:${id}`,
    shipmentRef: word(l.shipment_id) ? `shipstation:shipment:${l.shipment_id}` : undefined,
    orderRef: reference(l.external_order_id),
    carrier: word(l.carrier_code),
    trackingNumber: typeof l.tracking_number === "string" && /^[A-Z0-9]{8,40}$/.test(l.tracking_number.toUpperCase()) ? l.tracking_number.toUpperCase() : undefined,
    status: voided ? "unknown" : (tracking ?? (labelStatus === "error" ? "exception" : "label_created")),
    labelStatus,
    voided,
    voidedAt: voided ? time(l.voided_at) : undefined,
    service: word(l.service_code),
    signatureRequired: confirmation !== undefined && confirmation.includes("signature"),
    labelCostCents: cost?.cents,
    insuranceCostCents: insurance?.cents,
    insuredCents: insured?.cents,
    currency: cost?.currency ?? insurance?.currency ?? insured?.currency,
    isReturn: l.is_return_label === true,
    international: l.is_international === true,
    destinationState: region(shipTo.state_province, /^[A-Z]{2,3}$/),
    destinationCountry: region(shipTo.country_code, /^[A-Z]{2}$/),
    shipDate: time(l.ship_date),
    createdAt,
  };
  return read("label", SHIPSTATION_LABEL_EVENT, raw, problems, id, createdAt, payload, ctx.receivedAt);
}
