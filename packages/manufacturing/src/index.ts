import type { DepartmentModule } from "@karatos/retail";
import { bench, benchDepartment, type BenchSettings } from "./bench.js";

export * from "./bench.js";

/** Every manufacturing department, in the order a workshop usually adopts them. */
export const MANUFACTURING_DEPARTMENTS: DepartmentModule[] = [bench];

/** The instance's own settings the manufacturing rules read. Each one left out keeps the default. */
export interface ManufacturingSettings {
  bench?: BenchSettings;
}

/** The manufacturing departments with the instance's settings applied. */
export function manufacturingDepartments(settings: ManufacturingSettings = {}): DepartmentModule[] {
  return settings.bench === undefined ? MANUFACTURING_DEPARTMENTS : [benchDepartment(settings.bench)];
}
