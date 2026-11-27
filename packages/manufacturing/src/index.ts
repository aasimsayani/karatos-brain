import type { DepartmentModule } from "@karatos/retail";
import { bench, benchDepartment, type BenchSettings } from "./bench.js";
import { production, productionDepartment, type ProductionSettings } from "./production.js";

export * from "./bench.js";
export * from "./production.js";

/** Every manufacturing department, in the order a workshop usually adopts them. */
export const MANUFACTURING_DEPARTMENTS: DepartmentModule[] = [bench, production];

/** The instance's own settings the manufacturing rules read. Each one left out keeps the default. */
export interface ManufacturingSettings {
  bench?: BenchSettings;
  production?: ProductionSettings;
}

/** The manufacturing departments with the instance's settings applied. */
export function manufacturingDepartments(settings: ManufacturingSettings = {}): DepartmentModule[] {
  if (settings.bench === undefined && settings.production === undefined) return MANUFACTURING_DEPARTMENTS;
  return [
    settings.bench === undefined ? bench : benchDepartment(settings.bench),
    settings.production === undefined ? production : productionDepartment(settings.production),
  ];
}
