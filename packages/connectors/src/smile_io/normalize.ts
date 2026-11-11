import { createHash } from "node:crypto";
import { formCustomerRefs } from "../custom_forms/customer.js";
import { quoTime } from "../openphone/normalize.js";

/**
 * Turns Smile.io's loyalty program into events:
 *
 * - `loyalty.customer_updated` for each customer, as Yotpo's are: their
 *   state in the program, points balance, VIP tier and how close they are
 *   to the next one or to keeping theirs, so staff see a customer's points
 *   and tier at the counter and marketing spots lapsed members.
 * - `loyalty.points_changed` for each points transaction: whose balance,
 *   by how much, and when.
 *
 * Names, birthdays, referral links and the words of a transaction (its
 * description and internal note) are never read into an event. A
 * customer's email becomes the same customer reference custom forms,
 * Klaviyo, Quo and Yotpo make (an HMAC under CUSTOMER_REF_KEY).
 *
 * Each event is keyed by the record and a digest of what was kept, so
 * reading it again is a duplicate and a change is a new event. One without
 * an id or a time that reads is dead-lettered listing what was wrong.
 */

export interface SmileEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const SMILE_CUSTOMER_EVENT = "loyalty.customer_updated";
export const SMILE_POINTS_EVENT = "loyalty.points_changed";
const SYSTEM = "Smile.io";
const STATES = new Set(["candidate", "member", "disabled"]);
const TIER = /^[\p{L}\p{N}][\p{L}\p{N} ._/+#&'-]{0,39}$/u;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const idOf = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : undefined);
const amount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const time = (v: unknown) => quoTime(v) ?? undefined;

/** The program's tier names by id, from the VIP tier list. A name that doesn't read is left out. */
export function smileTierNames(tiers: unknown[]): Map<number, string> {
  const names = new Map<number, string>();
  for (const t of tiers) {
    const { id, name } = obj(t);
    if (idOf(id) && typeof name === "string" && TIER.test(name.trim())) names.set(id as number, name.trim());
  }
  return names;
}

export interface SmileContext {
  customerKey: string;
  receivedAt: string;
  /** Tier names by id. */
  tiers: Map<number, string>;
}

export type SmileRead = { ok: boolean; event: SmileEvent };

function read(kind: "customer" | "points_transaction", type: string, raw: unknown, problems: string[], id: number | undefined, at: string | undefined, payload: Record<string, unknown>, receivedAt: string): SmileRead {
  const ok = problems.length === 0;
  const key = ok ? `smile_io:${kind}:${id}:${short(payload)}` : `smile_io:unreadable_${kind}:${short(raw)}`;
  return {
    ok,
    event: {
      id: key.replace(/:/g, "_"),
      type,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? at : undefined,
      receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: SYSTEM, [`${kind === "customer" ? "customer" : "transaction"}Id`]: id ?? null, problems },
    },
  };
}

export function smileCustomerEvent(raw: unknown, ctx: SmileContext): SmileRead {
  const problems: string[] = [];
  const c = obj(raw);
  if (c !== raw) problems.push("customer is not an object");
  const id = idOf(c.id);
  if (!id) problems.push("customer has no id that reads");
  const createdAt = time(c.created_at);
  if (!createdAt) problems.push("customer has no creation time that reads");
  const updatedAt = time(c.updated_at) ?? createdAt;
  const state = typeof c.state === "string" && STATES.has(c.state) ? c.state : undefined;
  if (!state) problems.push("customer has no state that reads");
  const points = c.points_balance;
  if (!Number.isSafeInteger(points)) problems.push("customer has no points balance that reads");

  const vip = obj(c.vip_status);
  // vip_tier_id on the customer is the older field Smile is retiring.
  const tier = idOf(vip.vip_tier_id) ?? idOf(c.vip_tier_id);
  const payload: Record<string, unknown> = {
    system: SYSTEM,
    loyaltyCustomerId: `smile_io:customer:${id}`,
    customerRefs: formCustomerRefs(ctx.customerKey, { email: c.email }),
    state,
    member: state === "member",
    pointsBalance: points,
    vipTier: tier ? ctx.tiers.get(tier) : undefined,
    vipTierId: tier ? `smile_io:vip_tier:${tier}` : undefined,
    vipTierUntil: time(vip.vip_tier_expires_at),
    vipProgress: amount(vip.progress_value),
    vipPeriodEnd: time(vip.current_vip_period_end),
    toRetainVipTier: amount(vip.delta_to_retain_vip_tier),
    // Only tiers that read are in the map, so any other id names none.
    nextVipTier: ctx.tiers.get(vip.next_vip_tier_id as number),
    toNextVipTier: amount(vip.delta_to_next_vip_tier),
    createdAt,
    updatedAt,
  };
  return read("customer", SMILE_CUSTOMER_EVENT, raw, problems, id, updatedAt, payload, ctx.receivedAt);
}

export function smilePointsEvent(raw: unknown, ctx: SmileContext): SmileRead {
  const problems: string[] = [];
  const t = obj(raw);
  if (t !== raw) problems.push("points transaction is not an object");
  const id = idOf(t.id);
  if (!id) problems.push("points transaction has no id that reads");
  const customer = idOf(t.customer_id);
  if (!customer) problems.push("points transaction has no customer that reads");
  const change = t.points_change;
  if (!Number.isSafeInteger(change)) problems.push("points transaction has no points change that reads");
  const createdAt = time(t.created_at);
  if (!createdAt) problems.push("points transaction has no time that reads");

  const payload: Record<string, unknown> = {
    system: SYSTEM,
    transactionId: `smile_io:points_transaction:${id}`,
    loyaltyCustomerId: `smile_io:customer:${customer}`,
    pointsChange: change,
    direction: (change as number) < 0 ? "spent" : "earned",
    createdAt,
  };
  return read("points_transaction", SMILE_POINTS_EVENT, raw, problems, id, createdAt, payload, ctx.receivedAt);
}
