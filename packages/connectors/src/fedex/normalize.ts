import type { PackageTracking, ShipmentStatus } from "../shipping/tracking.js";
import { FEDEX_TRACKING_NUMBER } from "./client.js";

/**
 * Reads the packages out of FedEx track results. Kept for each: its
 * tracking number, status, FedEx's status code and text, the latest scan
 * time, the estimated delivery day, the delivered day, the service, whether
 * a signature was asked for and the destination's state and country. Names,
 * street addresses, postal codes, who received or signed, and photos are
 * left out even when FedEx sends them.
 */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : undefined);
const field = (value: unknown, key: string): unknown => (value as Record<string, unknown> | null | undefined)?.[key];

/**
 * FedEx status codes. The Track API's public pages don't list them, so this
 * follows the codes FedEx's sample responses and older guides use: OC and IN
 * label created, PU picked up, IT, AR, DP, AF and others in transit, OD out
 * for delivery, DL delivered, DE, SE, CA and DY exception, RS returned to sender.
 */
const STATUS_CODES: Record<string, ShipmentStatus> = {
  OC: "label_created",
  IN: "label_created",
  PU: "picked_up",
  PX: "picked_up",
  IT: "in_transit",
  AR: "in_transit",
  DP: "in_transit",
  AF: "in_transit",
  AP: "in_transit",
  CC: "in_transit",
  HL: "in_transit",
  OD: "out_for_delivery",
  DL: "delivered",
  DE: "exception",
  SE: "exception",
  CA: "exception",
  DY: "exception",
  RS: "returned",
};

/** A package's status, from FedEx's derived code when it gives one, else its code. Every key on an object's prototype has lowercase letters, so an uppercased code never reaches one. */
export function fedexStatus(latest: unknown): ShipmentStatus {
  for (const key of ["derivedCode", "code"]) {
    const code = field(latest, key);
    if (typeof code === "string" && code.trim()) return STATUS_CODES[code.trim().toUpperCase()] ?? "unknown";
  }
  return "unknown";
}

const LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** A FedEx time with its UTC offset, as an ISO time in UTC, when it is a real time. */
export function fedexTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = LOCAL.exec(value);
  if (!m) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  const offset = m[3] === "Z" ? 0 : (m[3]!.startsWith("-") ? -1 : 1) * (Number(m[3]!.slice(1, 3)) * 60 + Number(m[3]!.slice(4, 6)));
  // The day as written must be real, not rolled over from 30 February or 24:00.
  if (new Date(ms + offset * 60_000).toISOString().slice(0, 10) !== m[1]) return undefined;
  return new Date(ms).toISOString();
}

/** The day a FedEx time falls on where it was written, as YYYY-MM-DD. */
export function fedexDay(value: unknown): string | undefined {
  return fedexTime(value) === undefined ? undefined : (value as string).slice(0, 10);
}

function times(result: Record<string, unknown>): { delivered?: string | undefined; estimated?: string | undefined } {
  const out: { delivered?: string | undefined; estimated?: string | undefined } = {};
  for (const t of list(result.dateAndTimes)) {
    const day = fedexDay(field(t, "dateTime"));
    if (day === undefined) continue;
    if (field(t, "type") === "ACTUAL_DELIVERY") out.delivered = day;
    if (field(t, "type") === "ESTIMATED_DELIVERY") out.estimated = day;
  }
  const window = field(result.estimatedDeliveryTimeWindow, "window");
  out.estimated ??= fedexDay(field(window, "ends")) ?? fedexDay(field(window, "begins"));
  return out;
}

function lastEventAt(result: Record<string, unknown>): string | undefined {
  let latest: string | undefined;
  for (const e of list(result.scanEvents)) {
    const at = fedexTime(field(e, "date"));
    if (at !== undefined && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

/** The FedEx special handling types that ask for a signature. */
const SIGNATURE = new Set(["DIRECT_SIGNATURE_REQUIRED", "ADULT_SIGNATURE_REQUIRED", "INDIRECT_SIGNATURE_REQUIRED", "SIGNATURE_OPTION"]);

/** The packages in FedEx track results. */
export function fedexPackages(results: unknown[]): PackageTracking[] {
  const out: PackageTracking[] = [];
  for (const result of results) {
    if (!isObject(result)) continue;
    const raw = field(result.trackingNumberInfo, "trackingNumber");
    if (typeof raw !== "string") continue;
    const trackingNumber = raw.replace(/\s+/g, "").toUpperCase();
    if (!FEDEX_TRACKING_NUMBER.test(trackingNumber)) continue;
    const latest = result.latestStatusDetail;
    const status = fedexStatus(latest);
    const days = times(result);
    const address = field(result.recipientInformation, "address");
    const state = field(address, "stateOrProvinceCode");
    const country = field(address, "countryCode");
    const code = field(latest, "code");
    const signed = list(result.specialHandlings).some((h) => SIGNATURE.has(field(h, "type") as string));
    out.push({
      trackingNumber,
      status,
      carrierStatus: typeof code === "string" && /^[A-Za-z0-9]{1,4}$/.test(code) ? code.toUpperCase() : undefined,
      description: text(field(latest, "statusByLocale"), 200) ?? text(field(latest, "description"), 200),
      lastEventAt: lastEventAt(result),
      estimatedDelivery: status === "delivered" ? undefined : days.estimated,
      deliveredAt: status === "delivered" ? days.delivered : undefined,
      service: text(field(result.serviceDetail, "description"), 80),
      signatureRequired: signed ? true : undefined,
      destinationState: typeof state === "string" && /^[A-Za-z]{2,3}$/.test(state.trim()) ? state.trim().toUpperCase() : undefined,
      destinationCountry: typeof country === "string" && /^[A-Za-z]{2}$/.test(country.trim()) ? country.trim().toUpperCase() : undefined,
    });
  }
  return out;
}
