import { BrainPipeline, type DocumentationSource, type MemoryStore } from "@karatos/core";
import { combineDepartments, selectDepartments } from "@karatos/retail";

export interface InstancePipelineOptions {
  memory: MemoryStore;
  documentation: DocumentationSource;
  /** Department ids from ENABLED_DEPARTMENTS. Empty turns on every retail department. */
  departments: string[];
}

/** Builds the pipeline for one instance with the departments that client uses. */
export function createInstancePipeline(options: InstancePipelineOptions): BrainPipeline {
  const departments = selectDepartments(options.departments);
  return new BrainPipeline({
    memory: options.memory,
    documentation: options.documentation,
    ...combineDepartments(departments),
  });
}
