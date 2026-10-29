import { BrainPipeline, InMemoryStore, runSync, type Recommendation, type SyncReport } from "@karatos/core";
import { combineDepartments, RETAIL_DEPARTMENTS } from "@karatos/retail";
import { DEMO_SOURCES } from "./sources/index.js";
import type { DemoSource } from "./sources/source.js";
import { DEMO_ORGANIZATION, demoCalendar } from "./store.js";

export interface DemoSourceReport {
  integration: string;
  role: string;
  /** Events the historical import and the first incremental sync took in. */
  ingested: number;
  deadLettered: number;
  /** When the last sync finished. */
  syncedAt: string;
}

export interface DemoBrain {
  memory: InMemoryStore;
  pipeline: BrainPipeline;
  organizationId: string;
  sources: DemoSourceReport[];
  recommendations: Recommendation[];
  seededAt: string;
}

export interface SeedOptions {
  now?: Date;
  sources?: readonly DemoSource[];
}

const noDocs = { current: () => ({ documentIds: [], stale: false }) };

/**
 * Runs every demo source through its real connector and the full retail
 * brain, the same way an instance syncs: a historical import, then an
 * incremental sync, then reasoning over what came in.
 */
export async function seedDemo(options: SeedOptions = {}): Promise<DemoBrain> {
  const calendar = demoCalendar(options.now ?? new Date());
  const memory = new InMemoryStore();
  // The brain runs on the demo calendar, so what it says matches the dates in the data.
  const pipeline = new BrainPipeline({ memory, documentation: noDocs, now: () => calendar.now, ...combineDepartments(RETAIL_DEPARTMENTS) });
  const sources: DemoSourceReport[] = [];
  for (const source of options.sources ?? DEMO_SOURCES) {
    const reports: SyncReport[] = [];
    for (const mode of ["historical", "incremental"] as const) {
      reports.push(await runSync({ connector: source.connector(calendar), mode, pipeline, memory, organizationId: DEMO_ORGANIZATION, sleep: async () => {} }));
    }
    sources.push({
      integration: source.integration,
      role: source.role,
      ingested: reports.reduce((n, r) => n + r.ingested, 0),
      deadLettered: reports.reduce((n, r) => n + r.deadLettered, 0),
      syncedAt: calendar.now.toISOString(),
    });
  }
  const recommendations = await pipeline.reason(DEMO_ORGANIZATION);
  return { memory, pipeline, organizationId: DEMO_ORGANIZATION, sources, recommendations, seededAt: calendar.now.toISOString() };
}
