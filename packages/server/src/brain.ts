import { BrainPipeline, type DocumentationSource, type MemoryStore, type ModelReasoner } from "@karatos/core";
import { MANUFACTURING_DEPARTMENTS, manufacturingDepartments, type BenchSettings, type ProductionSettings } from "@karatos/manufacturing";
import { combineDepartments, RETAIL_DEPARTMENTS, selectDepartments, type DepartmentModule, type StoreHours } from "@karatos/retail";

/** Every department an instance can run: retail's, then manufacturing's. */
export const INSTANCE_DEPARTMENTS: DepartmentModule[] = [...RETAIL_DEPARTMENTS, ...MANUFACTURING_DEPARTMENTS];

export interface InstanceDepartmentSettings {
  /** From STORE_TIME_ZONE, STORE_HOURS and STORE_CLOSED_DATES. Absent: Monday to Saturday, 10:00 to 18:00, New York time. */
  storeHours?: StoreHours;
  /** AWAITING_REPLY_HOURS. Absent: 4. */
  awaitingReplyHours?: number;
  /** FEEDBACK_COOLDOWN_DAYS: days a dismissed recommendation's rule and subject is held back. Absent: 14. 0 turns the cooldown off. */
  feedbackCooldownDays?: number;
  /** BENCH_STAGE_LIMIT_DAYS and BENCH_METAL_LOSS_PERCENT. Absent: the bench rules' defaults. */
  bench?: BenchSettings;
  /** BENCH_LABOR_RATE and BENCH_DAILY_HOURS. Absent: production planning's defaults. The store's hours above give its working days. */
  production?: Omit<ProductionSettings, "storeHours">;
}

export interface InstancePipelineOptions extends InstanceDepartmentSettings {
  memory: MemoryStore;
  documentation: DocumentationSource;
  /** Department ids from ENABLED_DEPARTMENTS. Empty turns on every department. */
  departments: string[];
  /** Runs after the rules, such as the Claude reasoner from instanceClaudeReasoner. Absent: rules only. */
  modelReasoner?: ModelReasoner | null;
}

/** The departments ENABLED_DEPARTMENTS names, or all of them when it is empty, with the instance's settings applied. */
export function instanceDepartments(ids: string[], settings: InstanceDepartmentSettings = {}): DepartmentModule[] {
  const production = settings.production || settings.storeHours ? { ...settings.production, ...(settings.storeHours ? { storeHours: settings.storeHours } : {}) } : undefined;
  const available = [
    ...RETAIL_DEPARTMENTS,
    ...manufacturingDepartments({ ...(settings.bench ? { bench: settings.bench } : {}), ...(production ? { production } : {}) }),
  ];
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
  const { memory, documentation, departments, feedbackCooldownDays, modelReasoner, ...settings } = options;
  return new BrainPipeline({
    memory,
    documentation,
    ...(modelReasoner ? { modelReasoner } : {}),
    ...(feedbackCooldownDays !== undefined ? { feedback: { cooldownDays: feedbackCooldownDays } } : {}),
    ...combineDepartments(instanceDepartments(departments, settings)),
  });
}
