import { BrainPipeline, InMemoryStore, type Recommendation } from "@karatos/core";
import { combineDepartments, RETAIL_DEPARTMENTS, type DepartmentModule } from "../src/index.js";

export const ORG = "fuse-jewelry";
let counter = 0;

/** A store wired with retail departments, plus helpers to feed it and ask it. */
export function store(departments: DepartmentModule[] = RETAIL_DEPARTMENTS) {
  const memory = new InMemoryStore();
  let now = "2026-10-02T15:00:00.000Z";
  const pipeline = new BrainPipeline({
    memory,
    ...combineDepartments(departments),
    documentation: { current: () => ({ documentIds: ["retail-playbook"], stale: false }) },
    now: () => new Date(now),
  });
  return {
    memory,
    pipeline,
    async send(type: string, payload: Record<string, unknown>, occurredAt = "2026-10-01T15:00:00Z") {
      counter++;
      return pipeline.ingest({
        id: `evt_${counter}`,
        organizationId: ORG,
        source: "test",
        type,
        occurredAt,
        receivedAt: occurredAt,
        idempotencyKey: `k_${counter}`,
        payload,
      });
    },
    async ask(at = now): Promise<Recommendation[]> {
      now = at;
      return pipeline.reason(ORG);
    },
  };
}

export const about = (recs: Recommendation[], text: string) => recs.filter((r) => r.summary.includes(text));
