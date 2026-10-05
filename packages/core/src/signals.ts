import type { EntityRef } from "./entities.js";

/**
 * Layer 3, Signal Extraction. Signals are typed observations derived from
 * normalized entities, always traceable back to the events behind them.
 */
export interface Signal {
  id: string;
  organizationId: string;
  kind: string;
  subject: EntityRef;
  value: number | string | boolean | Record<string, unknown>;
  /** 0 to 1. */
  confidence: number;
  derivedFromEventIds: string[];
  observedAt: string;
}
