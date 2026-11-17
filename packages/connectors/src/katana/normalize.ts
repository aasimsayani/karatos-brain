import { createHash } from "node:crypto";

/**
 * Turns Katana manufacturing orders and stock into Brain A events, in the
 * types PIRO and the store systems already give:
 *
 * - A manufacturing order becomes `manufacturing.job_updated`, the job
 *   event PIRO gives, with its status, quantities, dates, whether its
 *   materials are in stock, and its costs, so production sees job costs
 *   and shortages before they hold up an order. It is keyed by the order
 *   and a digest of what was kept, so an unchanged order read again is a
 *   duplicate and each change is a new version. A deleted order is kept as
 *   cancelled.
 * - Stock for an item at a location becomes `inventory.counted`, keyed by
 *   the day and what was counted, so a count read again the same day is a
 *   duplicate.
 *
 * An order's notes, serial numbers, batches and custom fields are not
 * kept: they are free text a maker may fill with a customer's name. An
 * order or count without an ID that reads is dead-lettered listing what
 * was wrong.
 */

export interface KatanaEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const KATANA_JOB_EVENT = "manufacturing.job_updated";
export const KATANA_COUNT_EVENT = "inventory.counted";

const STATUSES: Record<string, string> = { NOT_STARTED: "open", BLOCKED: "on_hold", IN_PROGRESS: "in_progress", DONE: "completed" };
const AVAILABILITY = new Set(["PROCESSED", "IN_STOCK", "NOT_AVAILABLE", "EXPECTED", "NO_RECIPE", "NOT_APPLICABLE"]);
// Date.parse turns down anything after the zone, so only the start is anchored.
const TIME = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})/;
const DECIMAL = /^-?\d+(\.\d{1,12})?$/;
const MAX = 1e15;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
// An array reads as a record without the fields asked for.
const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const text = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);

/** A Katana ID: a positive whole number, as a number or digits. */
export function katanaId(v: unknown): string | undefined {
  const n = typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? String(n) : undefined;
}

export const katanaRef = (kind: "order" | "variant" | "location" | "sales_order", id: string) => `katana:${kind}:${id}`;

/** A time as Katana writes it (ISO 8601 with a zone), as UTC, or undefined. */
export function katanaTime(v: unknown): string | undefined {
  if (typeof v !== "string" || !TIME.test(v)) return undefined;
  const t = Date.parse(v);
  // Date.parse rolls a day like 02-30 into the next month, so the day must read back as itself.
  if (Number.isNaN(t) || new Date(Date.parse(`${v.slice(0, 10)}T00:00:00Z`)).toISOString().slice(0, 10) !== v.slice(0, 10)) return undefined;
  return new Date(t).toISOString();
}

/** A quantity or amount Katana gives as a number or a decimal string ("7.00000"), or null. */
export function katanaNumber(v: unknown): number | null {
  const n = typeof v === "string" && DECIMAL.test(v.trim()) ? Number(v) : v;
  // NaN and Infinity fail the size check.
  return typeof n === "number" && Math.abs(n) < MAX ? n : null;
}

/** An amount in the account's currency as whole cents, or null. */
export function katanaCents(v: unknown): number | null {
  const n = katanaNumber(v);
  if (n === null) return null;
  // Rounded on the size, then signed, so half a cent rounds away from zero either way.
  const cents = Math.round(Math.abs(n) * 100);
  return n < 0 ? -cents : cents;
}

export interface KatanaContext {
  receivedAt: string;
}

function event(type: string, key: string, occurredAt: string | undefined, ctx: KatanaContext, payload: Record<string, unknown>): KatanaEvent {
  return { id: key.replace(/:/g, "_"), type, occurredAt, receivedAt: ctx.receivedAt, idempotencyKey: key, payload };
}

/** The event for one manufacturing order. */
export function katanaOrderEvent(raw: unknown, ctx: KatanaContext): KatanaEvent {
  const r = record(raw);
  const id = katanaId(r.id);
  const updated = katanaTime(r.updated_at) ?? katanaTime(r.created_at);
  const problems: string[] = [];
  if (!id) problems.push("manufacturing order has no ID that reads");
  if (!updated) problems.push("manufacturing order has no update time that reads");
  if (problems.length) return event(KATANA_JOB_EVENT, `katana:unreadable_order:${short(raw)}`, undefined, ctx, { system: "Katana", jobId: id ?? null, problems });

  const label = typeof r.status === "string" && Object.hasOwn(STATUSES, r.status) ? r.status : null;
  const deleted = katanaTime(r.deleted_at);
  const variant = katanaId(r.variant_id);
  const location = katanaId(r.location_id);
  const salesOrder = katanaId(r.sales_order_id);
  const day = (v: unknown) => katanaTime(v)?.slice(0, 10) ?? null;
  const payload: Record<string, unknown> = {
    system: "Katana",
    jobId: katanaRef("order", id!),
    status: deleted ? "cancelled" : label ? STATUSES[label] : "other",
    statusLabel: label,
    deleted: deleted !== undefined,
    orderNumber: text(r.order_no, 100),
    variantRef: variant ? katanaRef("variant", variant) : null,
    locationRef: location ? katanaRef("location", location) : null,
    salesOrderRef: salesOrder ? katanaRef("sales_order", salesOrder) : null,
    plannedQuantity: katanaNumber(r.planned_quantity),
    producedQuantity: katanaNumber(r.actual_quantity),
    materials: typeof r.ingredient_availability === "string" && AVAILABILITY.has(r.ingredient_availability) ? r.ingredient_availability.toLowerCase() : null,
    createdOn: day(r.order_created_date) ?? day(r.created_at),
    dueOn: day(r.production_deadline_date),
    deliveryDueOn: day(r.sales_order_delivery_deadline),
    completedOn: day(r.done_date),
    totalCostCents: katanaCents(r.total_cost),
    materialCostCents: katanaCents(r.material_cost),
    subassembliesCostCents: katanaCents(r.subassemblies_cost),
    operationsCostCents: katanaCents(r.operations_cost),
    plannedSeconds: katanaNumber(r.total_planned_time),
    actualSeconds: katanaNumber(r.total_actual_time),
  };
  return event(KATANA_JOB_EVENT, `katana:order:${id}:${short(payload)}`, deleted ?? updated, ctx, payload);
}

/** The event for one inventory row: an item's stock at a location. */
export function katanaCountEvent(raw: unknown, ctx: KatanaContext): KatanaEvent {
  const r = record(raw);
  const variantId = katanaId(r.variant_id);
  const locationId = katanaId(r.location_id);
  const problems: string[] = [];
  if (!variantId) problems.push("inventory row has no item ID that reads");
  if (!locationId) problems.push("inventory row has no location ID that reads");
  const onHand = katanaNumber(r.quantity_in_stock);
  if (onHand === null) problems.push("inventory row has no quantity in stock that reads");
  if (problems.length) return event(KATANA_COUNT_EVENT, `katana:unreadable_count:${short(raw)}`, undefined, ctx, { system: "Katana", problems });

  const variant = record(r.variant);
  const kind = typeof variant.type === "string" && /^(product|material)$/.test(variant.type) ? variant.type : null;
  const payload: Record<string, unknown> = {
    system: "Katana",
    sku: text(variant.sku, 100) ?? `katana-variant-${variantId}`,
    name: text(variant.product_or_material_name),
    kind,
    onHand,
    committed: katanaNumber(r.quantity_committed),
    expected: katanaNumber(r.quantity_expected),
    missingOrExcess: katanaNumber(r.quantity_missing_or_excess),
    reorderPoint: katanaNumber(r.reorder_point),
    averageCostCents: katanaCents(r.average_cost),
    valueCents: katanaCents(r.value_in_stock),
    variantId: katanaRef("variant", variantId!),
    locationId: katanaRef("location", locationId!),
  };
  return event(KATANA_COUNT_EVENT, `katana:count:${variantId}:${locationId}:${ctx.receivedAt.slice(0, 10)}:${short(payload)}`, ctx.receivedAt, ctx, payload);
}
