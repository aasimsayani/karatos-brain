import type { DepartmentModule } from "./department.js";
import { AWAITING_REPLY_RULE, awaitingReplyReasoner, REPLY_BUSINESS_HOURS } from "./departments/customer-match.js";
import { STORE_HOURS, type StoreHours } from "./store-hours.js";
import { appraisals } from "./departments/appraisals.js";
import { buying } from "./departments/buying.js";
import { clienteling } from "./departments/clienteling.js";
import { compliance } from "./departments/compliance.js";
import { customOrders } from "./departments/custom-orders.js";
import { finance } from "./departments/finance.js";
import { inventory } from "./departments/inventory.js";
import { marketing } from "./departments/marketing.js";
import { metals } from "./departments/metals.js";
import { repairs } from "./departments/repairs.js";
import { sales } from "./departments/sales.js";

export * from "./department.js";
export * from "./brief.js";
export * from "./ask.js";
export * from "./verify.js";
export {
  DEFAULT_PAYOUT_SCHEDULE_DAYS,
  money,
  PAYOUT_LOOKBACK_DAYS,
  PAYOUT_MISSING_AFTER_DAYS,
  PAYOUT_SCHEDULE_DAYS,
  PAYOUT_TOLERANCE_CENTS,
  PAYOUT_TOLERANCE_SHARE,
  processorOf,
  type LineCategory,
  type PayoutLine,
  type PayoutRecord,
  type PayoutStatus,
} from "./departments/payouts.js";
export {
  STOCK_COMPARABLE_HOURS,
  STOCK_LOOKBACK_DAYS,
  STOCK_SYSTEMIC_MIN_ITEMS,
  STOCK_SYSTEMIC_SHARE,
  STOCK_TOLERANCE_SHARE,
  stockSkuKey,
  type StockReading,
  type StockReadingKind,
} from "./departments/stock-agreement.js";
export {
  MAX_REFS_PER_RECORD,
  REPLY_BUSINESS_HOURS,
  REPLY_HIGH_VALUE_CENTS,
  REPLY_LOOKBACK_DAYS,
  AWAITING_REPLY_RULE,
  awaitingReplyReasoner,
  customerLinks,
  customerRefsOf,
  waitingCustomers,
  CustomerLinks,
  type CustomerTouch,
} from "./departments/customer-match.js";
export {
  DAY_NAMES,
  DEFAULT_STORE_HOURS,
  STORE_HOURS,
  StoreHoursError,
  businessHoursBetween,
  describeStoreHours,
  formatStoreHours,
  parseClosedDates,
  parseStoreHours,
  storeHours,
  type DayName,
  type OpenRange,
  type StoreHours,
} from "./store-hours.js";
export { appraisals, buying, clienteling, compliance, customOrders, finance, inventory, marketing, metals, repairs, sales };

/** Every retail jewelry department, in the order a store usually adopts them. */
export const RETAIL_DEPARTMENTS: DepartmentModule[] = [
  sales,
  inventory,
  clienteling,
  repairs,
  customOrders,
  appraisals,
  buying,
  metals,
  marketing,
  finance,
  compliance,
];

/**
 * Combines departments into pipeline options. Fails if two departments claim
 * the same event type, so ownership is always clear.
 */
export function combineDepartments(departments: DepartmentModule[]) {
  const payloadSchemas: DepartmentModule["events"] = {};
  for (const department of departments) {
    for (const [type, schema] of Object.entries(department.events)) {
      if (payloadSchemas[type]) throw new Error(`event type ${type} is claimed by more than one department`);
      payloadSchemas[type] = schema;
    }
  }
  return {
    payloadSchemas,
    normalizers: departments.flatMap((d) => d.normalizers),
    extractors: departments.flatMap((d) => d.extractors),
    reasoners: departments.flatMap((d) => d.reasoners),
  };
}

/** An instance's own settings the department rules read. Each one left out keeps the rules' default. */
export interface RetailSettings {
  /** From STORE_TIME_ZONE, STORE_HOURS and STORE_CLOSED_DATES: the hours clienteling's awaiting-reply rule counts. */
  storeHours?: StoreHours;
  /** AWAITING_REPLY_HOURS: how many open hours a customer waits before awaiting-reply raises them. */
  awaitingReplyHours?: number;
}

/** The departments with the instance's settings applied: clienteling's awaiting-reply rule is rebuilt for the store's hours. */
export function configureDepartments(departments: DepartmentModule[], settings: RetailSettings = {}): DepartmentModule[] {
  if (settings.storeHours === undefined && settings.awaitingReplyHours === undefined) return departments;
  const rule = awaitingReplyReasoner(settings.storeHours ?? STORE_HOURS, settings.awaitingReplyHours ?? REPLY_BUSINESS_HOURS);
  return departments.map((d) =>
    d.reasoners.some((r) => r.name === AWAITING_REPLY_RULE) ? { ...d, reasoners: d.reasoners.map((r) => (r.name === AWAITING_REPLY_RULE ? rule : r)) } : d,
  );
}

/**
 * Picks departments by id, e.g. from ENABLED_DEPARTMENTS, with the instance's settings applied. An empty list means all.
 * `available` is the departments to pick from: the retail ones unless an instance adds others, such as manufacturing's.
 */
export function selectDepartments(ids: string[], settings: RetailSettings = {}, available: DepartmentModule[] = RETAIL_DEPARTMENTS): DepartmentModule[] {
  const unknown = ids.filter((id) => !available.some((d) => d.id === id));
  if (unknown.length) throw new Error(`unknown departments: ${unknown.join(", ")}`);
  return configureDepartments(ids.length === 0 ? available : available.filter((d) => ids.includes(d.id)), settings);
}
