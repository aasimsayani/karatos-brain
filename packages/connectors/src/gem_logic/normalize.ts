import { createHash } from "node:crypto";

/**
 * Turns Gem Logic's products into Brain A events, so a business's stock can
 * be followed across the sales channels Gem Logic lists it on.
 *
 * A product becomes `product.updated`, with its SKU, its status, the channel
 * it is listed on, when it was made, how many images it has, and its weight
 * and size. Gem Logic gives a product no time it last changed, so each is
 * keyed by its record, its channel and a digest of what was kept: reading
 * one again unchanged is a duplicate, and a new status is a new version.
 * Image links are not kept, only how many there are. A product without an
 * ID or a time that reads is dead-lettered listing what was wrong.
 */

export interface GemLogicEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const GEM_LOGIC_EVENTS = { product: "product.updated" } as const;

const ID = /^[A-Za-z0-9-]{1,64}$/;
// Date.parse turns down minute or second 60; hour 24 it reads as the next day, so it is ruled out here.
const TIME = /^(\d{4}-\d{2}-\d{2})(?:[T ]((?:[01]\d|2[0-3]):\d{2}:\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?)?$/;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
// Anything but an object reads as a record without the fields asked for.
const record = (v: unknown) => (v ?? {}) as Record<string, unknown>;
const text = (v: unknown, max = 60): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);
/** An ID Gem Logic writes as a positive whole number or a string, as text, or undefined. */
export const gemLogicId = (v: unknown): string | undefined => {
  const s = Number.isSafeInteger(v) && (v as number) > 0 ? String(v) : v;
  return typeof s === "string" && ID.test(s) ? s.toLowerCase() : undefined;
};
/** A size or weight: a number, or a decimal string, 0 or more. */
const measure = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\d{1,9}(\.\d{1,6})?$/.test(v.trim()) ? Number(v) : v;
  return Number.isFinite(n) && (n as number) >= 0 && (n as number) < 1e9 ? (n as number) : null;
};

export const gemLogicRef = (kind: string, id: string) => `gem_logic:${kind}:${id}`;

/** A Gem Logic time or day as a UTC ISO time, or undefined. One without a zone is read as UTC. */
export function gemLogicTime(v: unknown): string | undefined {
  const m = typeof v === "string" ? TIME.exec(v.trim()) : null;
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2] ?? "00:00:00"}${m[3] ?? ""}${m[4] ?? "Z"}`);
  // Date.parse rolls a day like 02-30 into the next month, so the day must read back as itself.
  if (Number.isNaN(t) || new Date(Date.parse(`${m[1]}T00:00:00Z`)).toISOString().slice(0, 10) !== m[1]) return undefined;
  return new Date(t).toISOString();
}

export interface GemLogicContext {
  receivedAt: string;
  /** The sales channel the product was listed under. */
  marketplace: { id: string; name: string | null };
}

/** The event for one product, as listed on one sales channel. */
export function gemLogicProductEvent(raw: unknown, ctx: GemLogicContext): GemLogicEvent {
  const r = record(raw);
  const problems: string[] = [];
  const id = gemLogicId(r.id);
  if (id === undefined) problems.push("product has no ID that reads");
  const at = gemLogicTime(r.created);
  if (!at) problems.push("product has no time that reads");
  const ok = problems.length === 0;
  const productId = id === undefined ? null : gemLogicRef("product", id);
  const marketplaceId = gemLogicRef("marketplace", ctx.marketplace.id);
  const payload: Record<string, unknown> = ok
    ? {
        system: "Gem Logic",
        productId,
        marketplaceId,
        marketplace: ctx.marketplace.name,
        sku: text(r.item_sku, 80),
        status: text(r.status, 40),
        createdAt: at,
        imageCount: Array.isArray(r.images) ? r.images.length : null,
        weight: measure(r.item_weight),
        height: measure(r.item_height),
        length: measure(r.item_length),
        width: measure(r.item_width),
      }
    : { system: "Gem Logic", productId, marketplaceId, problems };
  const key = ok ? `gem_logic:product:${ctx.marketplace.id}:${id}:${short(payload)}` : `gem_logic:unreadable_product:${short(raw)}`;
  return { id: key.replace(/:/g, "_"), type: GEM_LOGIC_EVENTS.product, occurredAt: at, receivedAt: ctx.receivedAt, idempotencyKey: key, payload };
}
