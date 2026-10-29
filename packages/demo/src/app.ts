import type { RequestListener, ServerResponse } from "node:http";
import { INTEGRATIONS, integrationStatuses, type IntegrationStatus, type MemoryStore } from "@karatos/core";
import { API_SECURITY_HEADERS, createBrainApp } from "@karatos/server";
import type { DemoBrain } from "./seed.js";

/** Feedback the demo keeps before it stops taking more until the next reset, so nobody can fill its memory. */
export const DEMO_FEEDBACK_LIMIT = 2_000;

export interface DemoIntegrationStatus extends IntegrationStatus {
  /** Set on the systems the demo store runs on. */
  demo?: { role: string; ingested: number; syncedAt: string };
}

/** The catalog as the demo store sees it: its own systems connected, the rest listed as available. */
export function demoIntegrations(brain: Pick<DemoBrain, "sources">): DemoIntegrationStatus[] {
  const used = new Map(brain.sources.map((s) => [s.integration, s]));
  return integrationStatuses({}, INTEGRATIONS).map((status) => {
    const source = used.get(status.id);
    if (!source) return status;
    return { ...status, configured: true, missingSettings: [], demo: { role: source.role, ingested: source.ingested, syncedAt: source.syncedAt } };
  });
}

/** Counts feedback and turns it down past the limit; everything else goes to the store as is. */
function cappedFeedback(memory: MemoryStore, limit: number): { memory: MemoryStore; full: () => boolean } {
  let recorded = 0;
  const recordFeedback: MemoryStore["recordFeedback"] = async (feedback) => {
    recorded++;
    return memory.recordFeedback(feedback);
  };
  const capped = new Proxy(memory, {
    get(target, property) {
      if (property === "recordFeedback") return recordFeedback;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { memory: capped, full: () => recorded >= limit };
}

function deny(res: ServerResponse, status: number, error: string): void {
  const body = JSON.stringify({ error });
  res.writeHead(status, { ...API_SECURITY_HEADERS, "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export interface DemoAppOptions {
  apiKey: string;
  feedbackLimit?: number;
}

/**
 * The instance API over the demo store. It reads like any instance, takes
 * Accept and Dismiss as feedback, and turns down anything that would add
 * events or rerun the brain, so a visitor can't change what others see.
 */
export function createDemoApp(brain: DemoBrain, options: DemoAppOptions): RequestListener {
  const { memory, full } = cappedFeedback(brain.memory, options.feedbackLimit ?? DEMO_FEEDBACK_LIMIT);
  const app = createBrainApp({ pipeline: brain.pipeline, memory, organizationId: brain.organizationId, apiKey: options.apiKey, integrations: demoIntegrations(brain) });
  return (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "POST" && (path === "/v1/events" || path === "/v1/reason")) return deny(res, 403, "the demo store is read-only");
    if (req.method === "POST" && /^\/v1\/recommendations\/[^/]+\/feedback$/.test(path) && full()) return deny(res, 429, "the demo has taken all the feedback it keeps until tonight's reset");
    return app(req, res);
  };
}
