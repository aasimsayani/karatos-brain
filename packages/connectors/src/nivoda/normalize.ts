import { createHash } from "node:crypto";

/**
 * Turns Nivoda search results into Brain A events, the same way the IDEX
 * feed is read. A diamond that is new to the saved search, or whose grades
 * or price changed, becomes diamond_listing.listed with its grades,
 * measurements and price, keyed by its Nivoda id and a hash of what was
 * read, so an unchanged diamond read again is a duplicate and a repriced
 * one is new. A diamond that leaves the search becomes
 * diamond_listing.delisted.
 *
 * Media links aren't stored, only whether an image or video exists: they
 * point at supplier hosting KaratOS doesn't control. An item that doesn't
 * read (no id, carat weight, shape or price) is dead-lettered with its
 * place in the search and what was wrong.
 */

export interface NivodaEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const NIVODA_EVENT_TYPES = { listed: "diamond_listing.listed", delisted: "diamond_listing.delisted" } as const;

/** Nivoda ids as its API returns them. */
export const NIVODA_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Values = Record<string, unknown>;
const object = (v: unknown): Values | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Values) : null);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : undefined);
const number = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null);
const yesNo = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

export type NivodaItem = { kind: "stone"; id: string; hash: string; payload: Values } | { kind: "unreadable"; position: number; problems: string[]; hash: string };

/**
 * Reads one search result: a diamond, or the problems that stop it being
 * one. `position` is its place in the search, counted from 1. Nivoda's
 * price is taken as whole US cents, as its integrations read it; the first
 * staging run checks that against Nivoda's own site.
 */
export function readNivodaItem(item: unknown, position: number): NivodaItem {
  const top = object(item);
  const diamond = object(top?.diamond);
  const certificate = object(diamond?.certificate);
  const problems: string[] = [];
  const id = typeof top?.id === "string" ? top.id : "";
  if (!NIVODA_ID.test(id)) problems.push("has no Nivoda id that reads");
  const price = top?.price;
  if (typeof price !== "number" || !Number.isInteger(price) || price <= 0) problems.push("has no price that reads");
  const carats = number(certificate?.carats);
  if (carats === null || carats <= 0) problems.push("has no carat weight that reads");
  const shape = text(certificate?.shape);
  if (!shape) problems.push("has no shape");
  if (problems.length) return { kind: "unreadable", position, problems, hash: short(item ?? null) };

  const payload: Values = {
    source: "Nivoda",
    nivodaId: id,
    diamondId: text(diamond?.id),
    nivodaStockId: text(diamond?.NivodaStockId),
    supplierStockId: text(diamond?.supplierStockId),
    labGrown: yesNo(certificate?.labgrown),
    shape,
    carat: carats,
    color: text(certificate?.color),
    clarity: text(certificate?.clarity),
    cutGrade: text(certificate?.cut),
    polish: text(certificate?.polish),
    symmetry: text(certificate?.symmetry),
    lab: text(certificate?.lab),
    certificateNumber: text(certificate?.certNumber),
    totalPriceCents: price,
    pricePerCaratCents: Math.round((price as number) / carats!),
    currency: "USD",
    discountPct: number(top?.discount),
    measurements: { length: number(certificate?.length), width: number(certificate?.width), height: number(certificate?.depth) },
    proportions: { depthPct: number(certificate?.depthPercentage), tablePct: number(certificate?.table), girdle: text(certificate?.girdle) },
    fluorescence: [text(certificate?.floInt), text(certificate?.floCol)].filter(Boolean).join(" ") || undefined,
    brown: text(diamond?.brown),
    green: text(diamond?.green),
    milky: text(diamond?.milky),
    eyeClean: text(diamond?.eyeClean),
    mineOfOrigin: text(diamond?.mine_of_origin),
    availability: text(diamond?.availability),
    media: { image: Boolean(text(diamond?.image)), video: Boolean(text(diamond?.video)) },
  };
  return { kind: "stone", id, hash: short(payload), payload };
}

const idOf = (key: string) => key.replace(/^nivoda:/, "nivoda_");

/** A diamond new to the search or changed. `returns` counts the times it left before, so one back unchanged is recorded again. */
export function nivodaListedEvent(stone: Extract<NivodaItem, { kind: "stone" }>, returns: number, receivedAt: string): NivodaEvent {
  const key = `nivoda:listed:${stone.id}:${stone.hash}${returns ? `:${returns}` : ""}`;
  // A listing's time is when KaratOS saw it: Nivoda doesn't say when the diamond was listed.
  return { id: idOf(key), type: NIVODA_EVENT_TYPES.listed, occurredAt: receivedAt, receivedAt, idempotencyKey: key, payload: stone.payload };
}

/** A diamond that left the search for the `departure`th time, so each departure is recorded once. */
export function nivodaDelistedEvent(id: string, departure: number, receivedAt: string): NivodaEvent {
  const key = `nivoda:delisted:${id}:${departure}`;
  return { id: idOf(key), type: NIVODA_EVENT_TYPES.delisted, occurredAt: receivedAt, receivedAt, idempotencyKey: key, payload: { source: "Nivoda", nivodaId: id } };
}

/** An item that doesn't read, kept and dead-lettered with what was wrong. */
export function nivodaUnreadableEvent(item: Extract<NivodaItem, { kind: "unreadable" }>, receivedAt: string): NivodaEvent {
  const key = `nivoda:unreadable:${item.position}:${item.hash}`;
  return { id: idOf(key), type: NIVODA_EVENT_TYPES.listed, occurredAt: undefined, receivedAt, idempotencyKey: key, payload: { source: "Nivoda", position: item.position, problems: item.problems } };
}
