import { BrainPipeline, type DocumentationSource, type MemoryStore } from "@karatos/core";
import { combineDepartments, selectDepartments, type StoreHours } from "@karatos/retail";

export interface InstancePipelineOptions {
  memory: MemoryStore;
  documentation: DocumentationSource;
  /** Department ids from ENABLED_DEPARTMENTS. Empty turns on every retail department. */
  departments: string[];
  /** From STORE_TIME_ZONE, STORE_HOURS and STORE_CLOSED_DATES. Absent: Monday to Saturday, 10:00 to 18:00, New York time. */
  storeHours?: StoreHours;
  /** AWAITING_REPLY_HOURS. Absent: 4. */
  awaitingReplyHours?: number;
  /** FEEDBACK_COOLDOWN_DAYS: days a dismissed recommendation's rule and subject is held back. Absent: 14. 0 turns the cooldown off. */
  feedbackCooldownDays?: number;
}

/** Builds the pipeline for one instance with the departments that client uses. */
export function createInstancePipeline(options: InstancePipelineOptions): BrainPipeline {
  const departments = selectDepartments(options.departments, {
    ...(options.storeHours ? { storeHours: options.storeHours } : {}),
    ...(options.awaitingReplyHours !== undefined ? { awaitingReplyHours: options.awaitingReplyHours } : {}),
  });
  return new BrainPipeline({
    memory: options.memory,
    documentation: options.documentation,
    ...(options.feedbackCooldownDays !== undefined ? { feedback: { cooldownDays: options.feedbackCooldownDays } } : {}),
    ...combineDepartments(departments),
  });
}
