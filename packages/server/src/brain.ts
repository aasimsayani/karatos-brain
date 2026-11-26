import { BrainPipeline, type DocumentationSource, type MemoryStore } from "@karatos/core";
import { MANUFACTURING_DEPARTMENTS, manufacturingDepartments, type BenchSettings } from "@karatos/manufacturing";
import { combineDepartments, RETAIL_DEPARTMENTS, selectDepartments, type DepartmentModule, type StoreHours } from "@karatos/retail";

/** Every department an instance can run: retail's, then manufacturing's. */
export const INSTANCE_DEPARTMENTS: DepartmentModule[] = [...RETAIL_DEPARTMENTS, ...MANUFACTURING_DEPARTMENTS];

export interface InstanceDepartmentSettings {
  /** From STORE_TIME_ZONE, STORE_HOURS and STORE_CLOSED_DATES. Absent: Monday to Saturday, 10:00 to 18:00, New York time. */
  storeHours?: StoreHours;
  /** AWAITING_REPLY_HOURS. Absent: 4. */
  awaitingReplyHours?: number;
  /** BENCH_STAGE_LIMIT_DAYS and BENCH_METAL_LOSS_PERCENT. Absent: the bench rules' defaults. */
  bench?: BenchSettings;
}

export interface InstancePipelineOptions extends InstanceDepartmentSettings {
  memory: MemoryStore;
  documentation: DocumentationSource;
  /** Department ids from ENABLED_DEPARTMENTS. Empty turns on every department. */
  departments: string[];
}

/** The departments ENABLED_DEPARTMENTS names, or all of them when it is empty, with the instance's settings applied. */
export function instanceDepartments(ids: string[], settings: InstanceDepartmentSettings = {}): DepartmentModule[] {
  const available = [...RETAIL_DEPARTMENTS, ...manufacturingDepartments(settings.bench ? { bench: settings.bench } : {})];
  return selectDepartments(
    ids,
    {
      ...(settings.storeHours ? { storeHours: settings.storeHours } : {}),
      ...(settings.awaitingReplyHours !== undefined ? { awaitingReplyHours: settings.awaitingReplyHours } : {}),
    },
    available,
  );
}

/** Builds the pipeline for one instance with the departments that client uses. */
export function createInstancePipeline(options: InstancePipelineOptions): BrainPipeline {
  const { memory, documentation, departments, ...settings } = options;
  return new BrainPipeline({
    memory,
    documentation,
    ...combineDepartments(instanceDepartments(departments, settings)),
  });
}
