import type { DepartmentModule } from "./department.js";
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

/** Picks departments by id, e.g. from ENABLED_DEPARTMENTS. An empty list means all. */
export function selectDepartments(ids: string[]): DepartmentModule[] {
  if (ids.length === 0) return RETAIL_DEPARTMENTS;
  const unknown = ids.filter((id) => !RETAIL_DEPARTMENTS.some((d) => d.id === id));
  if (unknown.length) throw new Error(`unknown departments: ${unknown.join(", ")}`);
  return RETAIL_DEPARTMENTS.filter((d) => ids.includes(d.id));
}
