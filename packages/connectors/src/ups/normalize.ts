import type { PackageTracking, ShipmentStatus } from "../shipping/tracking.js";
import { UPS_TRACKING_NUMBER } from "./client.js";

/**
 * Reads the packages out of a UPS tracking answer. Kept for each: its
 * tracking number, status, UPS's status code and text, the latest scan time,
 * the scheduled or rescheduled delivery day, when it was delivered, the
 * service, whether a signature was asked for, its UPS Premier level and the
 * destination's state and country. Names, street addresses, postal codes,
 * who signed, signatures, photos and payment details are left out even when
 * UPS sends them.
 */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : undefined);

/**
 * UPS's status types. The Tracking API documentation gives `X` as the only
 * example, so this follows UPS's older tracking guides: D delivered, I in
 * transit, M label created (billing information received), MV label voided,
 * P picked up, X exception, RS returned to sender, O out for delivery.
 */
const STATUS_TYPES: Record<string, ShipmentStatus> = { D: "delivered", I: "in_transit", M: "label_created", MV: "label_created", P: "picked_up", X: "exception", RS: "returned", O: "out_for_delivery" };

/** A package's status. UPS often marks out for delivery as type I with that text, so the text decides then. */
export function upsStatus(current: unknown): ShipmentStatus {
  if (!isObject(current)) return "unknown";
  const type = typeof current.type === "string" ? current.type.trim().toUpperCase() : "";
  // Every key on an object's prototype has lowercase letters, so an uppercased type never reaches one.
  const status = STATUS_TYPES[type] ?? "unknown";
  if (status === "in_transit" && /out for delivery/i.test(`${String(current.simplifiedTextDescription ?? "")} ${String(current.description ?? "")}`)) return "out_for_delivery";
  return status;
}

/** A UPS date (YYYYMMDD) as YYYY-MM-DD, when it is a real day. */
export function upsDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!m) return undefined;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day ? day : undefined;
}

/** A UPS day and time (HHMMSS, leading zeros sometimes dropped) as an ISO time in UTC, when both read. */
export function upsTime(date: unknown, time: unknown): string | undefined {
  const day = upsDate(date);
  if (day === undefined || typeof time !== "string" || !/^\d{1,6}$/.test(time)) return undefined;
  const t = time.padStart(6, "0");
  const [h, m, s] = [Number(t.slice(0, 2)), Number(t.slice(2, 4)), Number(t.slice(4, 6))];
  if (h > 23 || m > 59 || s > 59) return undefined;
  return `${day}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}.000Z`;
}

/** The latest scan's time in UTC. UPS lists scans newest first, but the newest is picked to be safe. */
function lastEventAt(activity: unknown[]): string | undefined {
  let latest: string | undefined;
  for (const a of activity) {
    if (!isObject(a)) continue;
    const at = upsTime(a.gmtDate, a.gmtTime);
    if (at !== undefined && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

function deliveryDays(pkg: Record<string, unknown>): { estimated?: string; delivered?: string } {
  const out: { estimated?: string; delivered?: string } = {};
  for (const d of list(pkg.deliveryDate)) {
    if (!isObject(d)) continue;
    const day = upsDate(d.date);
    if (day === undefined) continue;
    // RDD (rescheduled) wins over SDD (scheduled).
    if (d.type === "RDD" || (d.type === "SDD" && out.estimated === undefined)) out.estimated = day;
    if (d.type === "DEL") out.delivered = day;
  }
  return out;
}

/** The destination's state and country. The rest of the address is left out. */
function destination(pkg: Record<string, unknown>): { state?: string; country?: string } {
  for (const a of list(pkg.packageAddress)) {
    if (!isObject(a) || a.type !== "DESTINATION" || !isObject(a.address)) continue;
    const state = typeof a.address.stateProvince === "string" && /^[A-Za-z]{2,3}$/.test(a.address.stateProvince.trim()) ? a.address.stateProvince.trim().toUpperCase() : undefined;
    const country = typeof a.address.countryCode === "string" && /^[A-Za-z]{2}$/.test(a.address.countryCode.trim()) ? a.address.countryCode.trim().toUpperCase() : undefined;
    return { ...(state ? { state } : {}), ...(country ? { country } : {}) };
  }
  return {};
}

const PREMIER: Record<string, string> = { UPS_PREMIER_SILVER: "ups_premier_silver", UPS_PREMIER_GOLD: "ups_premier_gold", UPS_PREMIER_PLATINUM: "ups_premier_platinum" };

/** The packages in a UPS tracking answer. A shipment UPS only answered with warnings has none. */
export function upsPackages(body: unknown): PackageTracking[] {
  const shipments = isObject(body) && isObject(body.trackResponse) ? list(body.trackResponse.shipment) : [];
  const out: PackageTracking[] = [];
  for (const shipment of shipments) {
    if (!isObject(shipment)) continue;
    for (const pkg of list(shipment.package)) {
      if (!isObject(pkg) || typeof pkg.trackingNumber !== "string") continue;
      const trackingNumber = pkg.trackingNumber.replace(/\s+/g, "").toUpperCase();
      if (!UPS_TRACKING_NUMBER.test(trackingNumber)) continue;
      const current = (pkg.currentStatus ?? {}) as Record<string, unknown>;
      const status = upsStatus(current);
      const days = deliveryDays(pkg);
      const dest = destination(pkg);
      const services = list(pkg.additionalServices);
      const premium = services.filter((s): s is string => typeof s === "string" && Object.hasOwn(PREMIER, s)).map((s) => PREMIER[s]!)[0];
      const code = typeof current.code === "string" && /^[A-Za-z0-9]{1,4}$/.test(current.code) ? current.code.toUpperCase() : undefined;
      out.push({
        trackingNumber,
        status,
        carrierStatus: code,
        description: text(current.simplifiedTextDescription, 200) ?? text(current.description, 200),
        lastEventAt: lastEventAt(list(pkg.activity)),
        estimatedDelivery: status === "delivered" ? undefined : days.estimated,
        deliveredAt: status === "delivered" ? days.delivered : undefined,
        service: text((pkg.service as Record<string, unknown> | null | undefined)?.description, 80),
        signatureRequired: services.includes("SIGNATURE_REQUIRED") || services.includes("ADULT_SIGNATURE_REQUIRED") ? true : undefined,
        premium,
        destinationState: dest.state,
        destinationCountry: dest.country,
      });
    }
  }
  return out;
}
