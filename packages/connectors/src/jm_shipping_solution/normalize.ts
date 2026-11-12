import { createHash } from "node:crypto";
import type { ShipmentStatus } from "../shipping/tracking.js";
import { isJmShippingGid, jmShippingErrors } from "./client.js";

/**
 * JM Shipping Solution shipments, tracking, claims and reconciliation as
 * Brain A events, in the shapes the ShipStation and UPS connectors give, so
 * an insured parcel bought through Jewelers Mutual reads like any other:
 *
 * - `shipment.updated` for each shipment: its state (saved, purchased or
 *   voided), carrier and service, tracking number and JM's tracking state,
 *   the declared (insured) value next to the invoice value, so an
 *   underinsured parcel stands out, the cost of the one rate JM gives, its
 *   weight, the store's own reference, and the destination's state and
 *   country.
 * - `shipment.tracked` for its latest tracking event, the event the UPS and
 *   ShipStation connectors give: a status every carrier maps to, JM's own
 *   activity code and the carrier's, and the event's text and time.
 * - `shipment.claim_updated` for a shipment's insurance claim: its status,
 *   loss type, reason, cargo, the amounts claimed, insured and declared to
 *   the carrier, and when it was filed and is due. No other connector reads
 *   parcel insurance claims, so the type is new, named like
 *   `payment.dispute_updated`.
 * - `shipment.reconciled` once JM reconciles a shipment's carrier charges:
 *   the freight first quoted and finally billed, the adjustment and JM's
 *   invoice reference. No other connector reads carrier adjustments, so
 *   this type is new too.
 *
 * Names, companies, street addresses, cities, postal codes, phone numbers,
 * email addresses, package contents, police report numbers, damage
 * descriptions and comments are never read into an event: only a
 * destination's state and country, as ShipStation and UPS keep.
 *
 * JM writes money as a JSON number of US dollars (its docs name no
 * currency); it is kept as whole cents. Each event is keyed by its record
 * and a digest of what was kept, so reading it again is a duplicate and a
 * change is a new event. A record that doesn't read is dead-lettered
 * listing what was wrong, never guessed.
 */

export interface JmShippingEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export type JmShippingRead = { ok: boolean; event: JmShippingEvent };

export const JM_SHIPMENT_EVENT = "shipment.updated";
export const JM_TRACKING_EVENT = "shipment.tracked";
export const JM_CLAIM_EVENT = "shipment.claim_updated";
export const JM_RECONCILED_EVENT = "shipment.reconciled";
const SYSTEM = "JM Shipping Solution";
/** JM's docs name no currency; it is a US insurer billing in dollars. */
export const JM_CURRENCY = "USD";

/** JM's carriers (the Carrier enum), as the carrier codes the shipping connectors use. */
export const JM_CARRIERS = new Map<number, string>([
  [1, "dhl_express"],
  [2, "eastern_connection"],
  [3, "fedex"],
  [4, "lonestar"],
  [5, "newgistics"],
  [6, "ontrac"],
  [7, "ups"],
  [8, "dhl_gm"],
  [9, "usps"],
  [10, "purolator"],
  [100, "other"],
]);
/** JM's services (the Service enum). */
export const JM_SERVICES = new Map<number, string>([
  [1, "next_day_early_am"],
  [2, "next_day_am"],
  [3, "next_day_pm"],
  [4, "two_day_am"],
  [5, "two_day_pm"],
  [6, "third_day"],
  [7, "ground_or_first_class"],
  [8, "parcel_select"],
  [9, "international_1"],
  [10, "international_2"],
  [11, "international_3"],
  [12, "international_4"],
]);
/** JM's tracking states (TrackingStatus and tgActivityCode): its own name, and the status every carrier maps to. */
export const JM_TRACKING = new Map<number, { name: string; status: ShipmentStatus }>([
  [10, { name: "forwarded", status: "in_transit" }],
  [20, { name: "exception", status: "exception" }],
  [21, { name: "stale_tracking", status: "unknown" }],
  [30, { name: "left_notice", status: "exception" }],
  [40, { name: "undeliverable", status: "exception" }],
  [50, { name: "returned", status: "returned" }],
  [60, { name: "unknown", status: "unknown" }],
  [70, { name: "unscanned", status: "label_created" }],
  [80, { name: "enroute", status: "in_transit" }],
  [89, { name: "out_for_delivery", status: "out_for_delivery" }],
  [90, { name: "delivered", status: "delivered" }],
  [100, { name: "unavailable", status: "unknown" }],
  [110, { name: "finalized", status: "unknown" }],
  [111, { name: "manual_close", status: "unknown" }],
  [-1, { name: "not_checked", status: "unknown" }],
]);
/** A claim's status (Claim.Status). 0 and 1 are search filters, not a claim's state, so they don't read. */
export const JM_CLAIM_STATUSES = new Map<number, string>([
  [2, "no_claim"],
  [3, "not_submitted"],
  [4, "submitted"],
  [5, "acknowledged"],
  [6, "need_shipper_info"],
  [7, "need_recipient_info"],
  [8, "need_carrier_info"],
  [9, "with_underwriter"],
  [10, "investigating"],
  [11, "approved"],
  [12, "paid"],
  [13, "withdrawn"],
  [14, "denied"],
  [15, "npol_pending"],
  [16, "archived"],
]);
const LOSS_TYPES = new Map<number, string>([
  [1, "complete"],
  [2, "partial"],
]);
const CLAIM_REASONS = new Map<number, string>([
  [1, "not_received"],
  [2, "failed_to_deliver"],
  [3, "contents_damaged"],
  [4, "contents_stolen_or_missing"],
  [5, "other"],
]);
/** JM's cargo kinds (Cargo and eCargo), as it names them, lowercased. 0 is none selected. */
export const JM_CARGO = new Map<number, string>(
  (
    [
      [1, "WATCHES"],
      [2, "ART_WORK"],
      [3, "HANDGUNS"],
      [4, "FIREARMS_NOT_HANDGUNS"],
      [5, "CELL_PHONES"],
      [6, "CURRENCY"],
      [7, "GEMS_AND_JEWELERY"],
      [8, "GENERAL_CARGO"],
      [9, "NUMISMATIC_COINS"],
      [10, "CHECKS_STOCKS_BONDS_ETC"],
      [11, "ELECTRONICS"],
      [12, "DESIGN_PROTOTYPES"],
      [13, "DESIGNER_CLOTHING_AND_ACCESSORIES"],
      [14, "SILVER_AND_SILVER_JEWELRY"],
      [15, "PRECIOUS_METALS_NOT_SILVER"],
      [16, "DOCUMENTS"],
      [17, "LUGGAGE_PERSONAL_EFFECTS"],
      [18, "RARE_BOOKS"],
      [19, "MEDICAL_DIAGNOSTIC_EQUIPMENT"],
      [20, "AUTO"],
      [21, "FIREARMS_ANTIQUE"],
      [22, "PRECIOUS_METALS"],
      [23, "WINE"],
      [24, "CHECK"],
      [25, "STOCKS_AND_BONDS"],
      [26, "ART_WORK_FRAGILE"],
      [27, "ART_WORK_NOT_FRAGILE"],
      [28, "BOOKS"],
      [29, "ELECTRONICS_PHONE_COMPUTER"],
      [30, "FURNITURE"],
      [31, "GENERAL_CARGO_FRAGILE"],
      [32, "GENERAL_CARGO_NOT_FRAGILE"],
      [33, "HOUSEWARE_FRAGILE"],
      [34, "HOUSEWARE_NOT_FRAGILE"],
      [35, "MEMORABILIA_COLLECTIBLES"],
      [36, "SCULPTURE"],
      [37, "STAMPS_TRADING_CARDS"],
      [100, "OTHER"],
    ] as const
  ).map(([n, name]) => [n, name.toLowerCase()]),
);
/** ShipmentStatus: 0 saved without buying, 1 bought. */
const SHIPMENT_STATES = new Map<number, string>([
  [0, "pending"],
  [1, "label_purchased"],
]);
const RETURN_FAILURE = 0;

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/** .NET writes an unset date as year 1; anything before 2000 is taken as unset. */
const EARLIEST = Date.parse("2000-01-01T00:00:00Z");
const MAX_DOLLARS = 1e9;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify([value])).digest("hex").slice(0, 12);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown) => (Array.isArray(v) ? v : []);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const named = <T>(map: Map<number, T>, v: unknown) => (typeof v === "number" ? map.get(v) : undefined);
const region = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : undefined);

export const jmShippingRef = (kind: string, id: string) => `jm_shipping:${kind}:${id}`;

/** A shipment GUID JM gave, lowercased, or undefined. */
export function jmShippingGid(value: unknown): string | undefined {
  return isJmShippingGid(value) ? value.toLowerCase() : undefined;
}

/** A JM id: a whole number above zero. */
export function jmShippingId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** An ISO 8601 time with a zone, from 2000 on, as an ISO time, or undefined. */
export function jmShippingTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !TIME.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || ms < EARLIEST ? undefined : new Date(ms).toISOString();
}

/** A dollar amount from 0 to a billion as whole cents, or undefined. */
export function jmShippingCents(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_DOLLARS ? Math.round(value * 100) : undefined;
}

/** A dollar amount that may be below zero, such as an adjustment, as whole cents, or undefined. */
export function jmShippingSignedCents(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_DOLLARS ? Math.round(value * 100) : undefined;
}

/** A carrier tracking number: 8 to 40 letters and digits, uppercased. */
export function jmShippingTrackingNumber(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const n = value.trim().toUpperCase();
  return /^[A-Z0-9]{8,40}$/.test(n) ? n : undefined;
}

/** A store's reference, such as an order number: up to 50 characters, without spaces or markup, as ShipStation keeps one. */
export function jmShippingReference(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9#][A-Za-z0-9#_./-]{0,49}$/.test(value.trim()) ? value.trim() : undefined;
}

/** The one carrier or service a shipment asked for, from JM's list of them; undefined when there is none, or more than one. */
export function jmShippingOne(map: Map<number, string>, value: unknown): string | undefined {
  const picked = [...new Set(list(value).filter((v) => v !== 0))];
  return picked.length === 1 ? named(map, picked[0]) : undefined;
}

/** A positive weight in ounces, to two places. */
function ounces(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1e6 ? Math.round(value * 100) / 100 : undefined;
}

function read(kind: string, type: string, raw: unknown, problems: string[], key: string, payload: Record<string, unknown>, occurredAt: string | undefined, receivedAt: string): JmShippingRead {
  const ok = problems.length === 0;
  const idempotencyKey = ok ? `jm_shipping:${kind}:${key}:${digest(payload)}` : `jm_shipping:unreadable_${kind}:${short(raw)}`;
  return {
    ok,
    event: {
      id: idempotencyKey.replace(/[^A-Za-z0-9_.-]/g, "_"),
      type,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? occurredAt : undefined,
      receivedAt,
      idempotencyKey,
      payload: ok ? payload : { system: SYSTEM, kind, problems },
    },
  };
}

/** A GUID the shipment list gave that doesn't read: dead-lettered, since it can't be asked for. */
export function jmShippingUnlisted(raw: unknown, receivedAt: string): JmShippingRead {
  return read("shipment", JM_SHIPMENT_EVENT, { listed: raw }, ["listed shipment GUID doesn't read"], "", {}, undefined, receivedAt);
}

/** What the tracking and claim events take from the shipment they belong to. */
export interface JmShipmentFacts {
  gid: string;
  carrier: string | undefined;
  service: string | undefined;
  trackingNumber: string | undefined;
  destinationState: string | undefined;
  destinationCountry: string | undefined;
  /** Bought and not voided: only these can have a claim. */
  claimable: boolean;
}

/** One ShipmentReturn as shipment.updated, with the facts the other events use. */
export function jmShipmentEvent(raw: unknown, receivedAt: string): JmShippingRead & { facts: JmShipmentFacts | undefined } {
  const r = obj(raw);
  const s = obj(r.Shipment);
  const purchase = obj(r.Purchase);
  const problems: string[] = [];
  if (r !== raw) problems.push("shipment is not an object");
  if (r.Status === RETURN_FAILURE) problems.push(`JM answered the shipment with a failure${jmShippingErrors(r.Error).length ? `: ${jmShippingErrors(r.Error).join("; ")}` : ""}`);
  const gid = jmShippingGid(s.Gid) ?? jmShippingGid(purchase.Gid);
  if (!gid) problems.push("shipment has no GUID that reads");
  const state = named(SHIPMENT_STATES, r.ShipmentStatus);
  if (!state) problems.push("shipment has no status JM documents");
  const createdAt = jmShippingTime(s.TransactionTime);
  const shipDate = jmShippingTime(s.ShipDate);
  const voidedAt = jmShippingTime(s.VoidedOn);
  const voided = voidedAt !== undefined || jmShippingId(s.VoidId) !== undefined;
  const at = voidedAt ?? createdAt ?? shipDate;
  if (!at) problems.push("shipment has no time that reads");

  const to = obj(s.ToAddress);
  const tracking = named(JM_TRACKING, s.TrackingStatus);
  const insured = jmShippingCents(s.DeclaredValue);
  const invoice = jmShippingCents(s.InvoiceValue);
  // JM doesn't say which rate was bought; only a single rate is taken as the one.
  const rates = list(r.Rates);
  const rate = rates.length === 1 ? obj(rates[0]) : {};
  const cost = jmShippingCents(rate.Price);
  const freight = jmShippingCents(rate.FreightPrice);
  const insurance = jmShippingCents(rate.InsurancePrice);
  const money = [insured, invoice, cost, freight, insurance].some((v) => v !== undefined);
  const facts: JmShipmentFacts | undefined = gid
    ? {
        gid,
        carrier: jmShippingOne(JM_CARRIERS, s.Carriers),
        service: jmShippingOne(JM_SERVICES, s.Services),
        trackingNumber: jmShippingTrackingNumber(purchase.TrackingNumber) ?? jmShippingTrackingNumber(s.TrackingNumber),
        destinationState: region(to.State, /^[A-Z]{2,3}$/),
        destinationCountry: region(to.CountryCode, /^[A-Z]{2}$/),
        claimable: state === "label_purchased" && !voided,
      }
    : undefined;
  const payload = defined({
    system: SYSTEM,
    shipmentId: jmShippingRef("shipment", gid ?? ""),
    jmId: jmShippingId(s.Id),
    orderRef: jmShippingReference(s.Reference1),
    status: voided ? "cancelled" : state,
    voided,
    voidedAt,
    carrier: facts?.carrier,
    service: facts?.service,
    trackingNumber: facts?.trackingNumber,
    trackingStatus: tracking?.status,
    jmTrackingStatus: tracking?.name,
    insuredCents: insured,
    invoiceCents: invoice,
    // How far the declared value falls short of the invoice, so an underinsured parcel stands out.
    underinsuredCents: insured !== undefined && invoice !== undefined ? Math.max(0, invoice - insured) : undefined,
    costCents: cost,
    freightCents: freight,
    insuranceCostCents: insurance,
    currency: money ? JM_CURRENCY : undefined,
    weightOz: ounces(s.WeightOzDecimal),
    isReturn: s.IsReturnShipment === true,
    holdForPickup: s.IsHoldForPickup === true,
    approvalRequired: s.ApprovalRequired === true,
    reconciled: s.IsReconciled === true,
    destinationState: facts?.destinationState,
    destinationCountry: facts?.destinationCountry,
    shipDate,
    carrierDeliveryAt: jmShippingTime(s.CarrierDeliveryDate),
    createdAt,
  });
  const result = read("shipment", JM_SHIPMENT_EVENT, raw, problems, gid ?? "", payload, at, receivedAt);
  return { ...result, facts: result.ok ? facts : undefined };
}

/**
 * One shipment's tracking answer as shipment.tracked, from its latest
 * activity, or null when JM has nothing to say yet: no activities, or a
 * tracking failure for a label not yet scanned.
 */
export function jmTrackingEvent(raw: unknown, facts: ReadonlyMap<string, JmShipmentFacts>, receivedAt: string): JmShippingRead | null {
  const t = obj(raw);
  const activities = list(t.Activities).map(obj);
  if (t === raw && activities.length === 0) return null;
  const problems: string[] = [];
  if (t !== raw) problems.push("tracking is not an object");
  const gid = jmShippingGid(t.Gid);
  if (!gid) problems.push("tracking has no shipment GUID that reads");
  // The latest activity: JM is asked for only the latest, and the latest time decides if it gives more.
  const timed = activities.map((a) => ({ a, at: jmShippingTime(a.activityDateTime) })).filter((x) => x.at !== undefined);
  const latest = timed.sort((x, y) => (x.at! < y.at! ? 1 : x.at! > y.at! ? -1 : 0))[0];
  if (t === raw && !latest) problems.push("tracking has no activity with a time that reads");
  const code = latest ? named(JM_TRACKING, latest.a.tgActivityCode) : undefined;
  if (latest && !code) problems.push("tracking activity has no code JM documents");
  const shipment = gid ? facts.get(gid) : undefined;
  const description = typeof latest?.a.activityDescription === "string" && latest.a.activityDescription.trim() ? latest.a.activityDescription.trim().replace(/\s+/g, " ").slice(0, 200) : undefined;
  const carrierStatus = typeof latest?.a.carrierActivityCode === "string" && /^[A-Za-z0-9_.-]{1,20}$/.test(latest.a.carrierActivityCode.trim()) ? latest.a.carrierActivityCode.trim() : undefined;
  const payload = defined({
    system: SYSTEM,
    shipmentId: jmShippingRef("shipment", gid ?? ""),
    carrier: shipment?.carrier,
    trackingNumber: jmShippingTrackingNumber(t.TrackingNumber) ?? shipment?.trackingNumber,
    status: code?.status,
    jmStatus: code?.name,
    carrierStatus,
    description,
    lastEventAt: latest?.at,
    deliveredAt: code?.status === "delivered" ? latest!.at!.slice(0, 10) : undefined,
    service: shipment?.service,
    destinationState: shipment?.destinationState,
    destinationCountry: shipment?.destinationCountry,
  });
  return read("tracking", JM_TRACKING_EVENT, raw, problems, gid ?? "", payload, latest?.at, receivedAt);
}

/**
 * A shipment's claim answer as shipment.claim_updated, or null when it has
 * no claim: JM answers a claim with a zero id then, or an error and no claim.
 */
export function jmClaimEvent(raw: unknown, shipment: JmShipmentFacts, receivedAt: string): JmShippingRead | null {
  const answer = obj(raw);
  const c = obj(answer.Claim);
  const id = jmShippingId(c.Id);
  if (answer === raw && id === undefined && (c.Id === 0 || c.Id === undefined || c.Id === null)) return null;
  const problems: string[] = [];
  if (answer !== raw) problems.push("claim answer is not an object");
  else if (id === undefined) problems.push("claim has no id that reads");
  const status = named(JM_CLAIM_STATUSES, c.Status);
  if (!status) problems.push("claim has no status JM documents");
  const filedAt = jmShippingTime(c.ClaimFiledOn);
  const claimed = jmShippingCents(c.ClaimValue);
  const insured = jmShippingCents(c.InsuredValue);
  const amounts = {
    claimCents: claimed !== undefined && claimed > 0 ? claimed : undefined,
    insuredCents: insured,
    replacementCents: jmShippingCents(c.ReplacementValue),
    invoiceCents: jmShippingCents(c.InvoiceValue),
    carrierDeclaredCents: jmShippingCents(c.CarrierDeclaredValue),
    carrierLiabilityCents: jmShippingCents(c.CarrierLiability),
  };
  const payload = defined({
    system: SYSTEM,
    claimId: jmShippingRef("claim", String(id ?? "")),
    shipmentId: jmShippingRef("shipment", shipment.gid),
    carrier: shipment.carrier,
    trackingNumber: jmShippingTrackingNumber(c.TrackingNumber) ?? shipment.trackingNumber,
    status,
    lossType: named(LOSS_TYPES, c.LossType),
    reason: named(CLAIM_REASONS, c.ReasonForClaim),
    cargo: named(JM_CARGO, c.eCargo),
    ...amounts,
    // JM takes the insured value as the claim when none is given.
    claimIsInsuredValue: claimed === undefined || claimed === 0 ? true : undefined,
    currency: Object.values(amounts).some((v) => v !== undefined) ? JM_CURRENCY : undefined,
    packages: Number.isSafeInteger(c.PackageCount) && (c.PackageCount as number) > 0 ? c.PackageCount : undefined,
    carrierClaimFiled: typeof c.CarrierClaimNumber === "string" && c.CarrierClaimNumber.trim() !== "",
    postagePurchased: c.PostagePurchased === true,
    filedAt,
    dueAt: jmShippingTime(c.ClaimDueDate),
    shipDate: jmShippingTime(c.ShipDate),
  });
  // A claim JM hasn't filed yet has no time of its own; it is seen when read.
  return read("claim", JM_CLAIM_EVENT, raw, problems, String(id ?? ""), payload, filedAt ?? receivedAt, receivedAt);
}

/** One ReconciledShipment as shipment.reconciled. */
export function jmReconciledEvent(raw: unknown, receivedAt: string): JmShippingRead {
  const r = obj(raw);
  const problems: string[] = [];
  if (r !== raw) problems.push("reconciled shipment is not an object");
  const gid = jmShippingGid(r.ShipmentGid);
  if (!gid) problems.push("reconciled shipment has no GUID that reads");
  const reconciledAt = jmShippingTime(r.ReconciledOn);
  if (!reconciledAt) problems.push("reconciled shipment has no reconciliation time that reads");
  const freight = jmShippingCents(r.FreightPrice);
  if (freight === undefined) problems.push("reconciled shipment has no freight price that reads");
  const payload = defined({
    system: SYSTEM,
    shipmentId: jmShippingRef("shipment", gid ?? ""),
    jmId: jmShippingId(r.ShipmentId),
    trackingNumber: jmShippingTrackingNumber(r.TrackingNumber),
    carrier: named(JM_CARRIERS, r.Carrier),
    service: named(JM_SERVICES, r.Service),
    cargo: named(JM_CARGO, r.Cargo),
    originalFreightCents: jmShippingCents(r.OriginalFreightPrice),
    freightCents: freight,
    adjustmentCents: jmShippingSignedCents(r.AdjustmentAmount),
    currency: JM_CURRENCY,
    invoiceRef: jmShippingReference(r.InvoiceReference),
    purchasedAt: jmShippingTime(r.PurchasedOn),
    reconciledAt,
  });
  return read("reconciliation", JM_RECONCILED_EVENT, raw, problems, `${gid ?? ""}:${reconciledAt ?? ""}`, payload, reconciledAt, receivedAt);
}
