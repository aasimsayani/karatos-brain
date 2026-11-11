import { createHash } from "node:crypto";
import { isWatchbaseDay } from "./client.js";

/**
 * Turns WatchBase watches into Brain A events. WatchBase is reference data
 * about watch models, not store activity, so it gets its own event type, the
 * way the other reference feeds do (grading.report_retrieved for GIA,
 * watch_market.price_observed for Search The Watch Market):
 *
 * - `watch_reference.updated`: one for each version of a watch model, with
 *   its brand, family, reference number and name, gender, release year and
 *   water resistance, its caliber (maker, type, display, jewels, diameter,
 *   power reserve, hands), case (materials, coating, glass, back, shape,
 *   diameter, height, lug width) and dial (color, finish, index type, hand
 *   style). It is keyed by the watch's id, its modified day and a digest of
 *   what was kept, so reading it again unchanged is a duplicate and a change
 *   is a new event.
 *
 * Only the specs are kept: no description, no images, logos or thumbnails
 * (WatchBase can't license its images), and no brand website or slugs.
 * Measurements come as text with a unit, "49.70 mm", and are kept as numbers
 * in that unit; one that doesn't read is left out, never guessed. A watch
 * without an id, reference number, brand or modified day is dead-lettered
 * listing what was wrong.
 */

export interface WatchbaseEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export type WatchbaseRead = { ok: boolean; event: WatchbaseEvent };

export const WATCHBASE_WATCH_EVENT = "watch_reference.updated";
const SYSTEM = "WatchBase";
const ID = /^[1-9][0-9]{0,8}$/;
const YEAR = /^(1[7-9][0-9]{2}|20[0-9]{2}|2100)$/;
const COUNT = /^(0|[1-9][0-9]{0,2})$/;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
/** Fields kept, or undefined when none read. */
const group = (fields: Record<string, unknown>) => {
  const kept = defined(fields);
  return Object.keys(kept).length ? kept : undefined;
};

export const watchbaseRef = (kind: string, id: number) => `watchbase:${kind}:${id}`;

/** An id WatchBase gave, as a whole number written as a number or as digits, or undefined. */
export function watchbaseId(value: unknown): number | undefined {
  const s = typeof value === "number" ? String(value) : value;
  return typeof s === "string" && ID.test(s) ? Number(s) : undefined;
}

/** Trimmed text up to `max` characters, or undefined for none. WatchBase writes "None" for a family with no name. */
export function watchbaseText(value: unknown, max = 120): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, max);
  if (typeof value !== "string") return undefined;
  const t = value.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

/** A day WatchBase gave as YYYY-MM-DD, or undefined. */
export function watchbaseDay(value: unknown): string | undefined {
  return isWatchbaseDay(value) ? value : undefined;
}

/** A measurement written with its unit, such as "49.70 mm", "30.00 m" or "40 h", as a number in that unit, or undefined. */
export function watchbaseMeasure(value: unknown, unit: "mm" | "m" | "h"): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^\s*(0|[1-9][0-9]{0,4})(\.[0-9]{1,3})?\s*([a-z]+)\s*$/i.exec(value);
  if (!m || m[3]!.toLowerCase() !== unit) return undefined;
  return Number(`${m[1]}${m[2] ?? ""}`);
}

/** A whole count up to 999, such as a caliber's jewels, written as a number or as digits. */
export function watchbaseCount(value: unknown): number | undefined {
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : undefined;
  return s !== undefined && COUNT.test(s) ? Number(s) : undefined;
}

/** A release year from 1700 to 2100, or undefined. */
export function watchbaseYear(value: unknown): number | undefined {
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : undefined;
  return s !== undefined && YEAR.test(s) ? Number(s) : undefined;
}

/** A case's materials: `materials.material` holds one or many, or the list is given as is. Unreadable entries are left out. */
export function watchbaseMaterials(value: unknown): string[] | undefined {
  const holder = obj(value);
  const raw = Array.isArray(value) ? value : Object.hasOwn(holder, "material") ? holder.material : typeof value === "string" ? value : undefined;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const out = [...new Set(list.map((m) => watchbaseText(m, 60)).filter((m): m is string => m !== undefined))];
  return out.length ? out : undefined;
}

/** A caliber's hands, written comma separated, such as "Hours, Minutes, Seconds". */
export function watchbaseHands(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const out = value
    .split(",")
    .map((h) => watchbaseText(h, 40))
    .filter((h): h is string => h !== undefined);
  return out.length ? out : undefined;
}

/** A family's name, unless WatchBase wrote "None" for a watch that has none. */
const familyName = (value: unknown) => {
  const t = watchbaseText(value);
  return t && t.toLowerCase() !== "none" ? t : undefined;
};

function dead(kind: string, raw: unknown, problems: string[], receivedAt: string): WatchbaseRead {
  const idempotencyKey = `watchbase:unreadable_${kind}:${short(raw)}`;
  return {
    ok: false,
    event: {
      id: idempotencyKey.replace(/[^A-Za-z0-9_.-]/g, "_"),
      type: WATCHBASE_WATCH_EVENT,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: undefined,
      receivedAt,
      idempotencyKey,
      payload: { system: SYSTEM, kind, problems },
    },
  };
}

/** One watch from `/v1/watch`, as watch_reference.updated, or dead-lettered with what was wrong. */
export function watchbaseWatchEvent(raw: unknown, receivedAt: string): WatchbaseRead {
  const w = obj(raw);
  const wb = obj(w.wb);
  const brand = obj(w.brand);
  const family = obj(w.family);
  const caliber = obj(w.caliber);
  const box = obj(w.case);
  const dial = obj(w.dial);
  const id = watchbaseId(wb.id);
  const reference = watchbaseText(w.reference_number, 60);
  const brandId = watchbaseId(brand.id);
  const brandName = watchbaseText(brand.name, 80);
  const modified = watchbaseDay(wb.modified);
  const problems: string[] = [];
  if (id === undefined) problems.push("no watch id");
  if (reference === undefined) problems.push("no reference number");
  if (brandId === undefined || brandName === undefined) problems.push("no brand id and name");
  if (modified === undefined) problems.push("no modified day");
  if (problems.length) return dead("watch", raw, problems, receivedAt);

  const familyId = watchbaseId(family.id);
  const payload = defined({
    system: SYSTEM,
    watchId: watchbaseRef("watch", id!),
    brand: brandName,
    brandId: watchbaseRef("brand", brandId!),
    reference,
    name: watchbaseText(w.name),
    family: familyName(family.name),
    familyId: familyId === undefined ? undefined : watchbaseRef("family", familyId),
    gender: watchbaseText(w.gender, 20),
    released: watchbaseYear(w.released),
    waterResistanceM: watchbaseMeasure(w.waterresistance, "m"),
    caliber: group({
      reference: watchbaseText(caliber.reference_number, 60),
      maker: watchbaseText(caliber.brand, 80),
      type: watchbaseText(caliber.type, 40),
      display: watchbaseText(caliber.display, 40),
      jewels: watchbaseCount(caliber.jewels),
      diameterMm: watchbaseMeasure(caliber.diameter, "mm"),
      powerReserveHours: watchbaseMeasure(caliber.powerreserve, "h"),
      hands: watchbaseHands(caliber.hands),
    }),
    case: group({
      materials: watchbaseMaterials(box.materials),
      coating: watchbaseText(box.coating, 60),
      glass: watchbaseText(box.glass, 60),
      back: watchbaseText(box.back, 60),
      shape: watchbaseText(box.shape, 60),
      diameterMm: watchbaseMeasure(box.diameter, "mm"),
      heightMm: watchbaseMeasure(box.height, "mm"),
      lugWidthMm: watchbaseMeasure(box.lugwidth, "mm"),
    }),
    dial: group({
      color: watchbaseText(dial.color, 60),
      finish: watchbaseText(dial.finish, 60),
      indexType: watchbaseText(dial.indextype, 60),
      handStyle: watchbaseText(dial.handstyle, 60),
    }),
    added: watchbaseDay(wb.added),
    modified,
  });
  const idempotencyKey = `watchbase:watch:${id}:${modified}:${digest(payload)}`;
  return {
    ok: true,
    event: {
      id: idempotencyKey.replace(/[^A-Za-z0-9_.-]/g, "_"),
      type: WATCHBASE_WATCH_EVENT,
      occurredAt: `${modified}T00:00:00.000Z`,
      receivedAt,
      idempotencyKey,
      payload,
    },
  };
}

/** A watch list entry without an id that reads, so its watch can't be read: dead-lettered, keyed by the brand and the entry. */
export function watchbaseUnlisted(raw: unknown, brandId: number, receivedAt: string): WatchbaseEvent {
  return dead("listed_watch", [brandId, raw], [`a watch listed for BrandID ${brandId} has no id`], receivedAt).event;
}
