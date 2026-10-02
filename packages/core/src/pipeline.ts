import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { parseEvent, type EventEnvelope } from "./events.js";
import type { NormalizedEntity } from "./entities.js";
import type { Signal } from "./signals.js";
import type { Recommendation } from "./reasoning.js";
import type { DocumentationSource, MemoryStore, Normalizer, Reasoner, SignalExtractor } from "./layers.js";

export interface BrainPipelineOptions {
  memory: MemoryStore;
  normalizers: Normalizer[];
  extractors: SignalExtractor[];
  reasoners: Reasoner[];
  documentation: DocumentationSource;
  /** How many recent signals the reasoners see. */
  reasoningWindow?: number;
  now?: () => Date;
  newId?: () => string;
}

export interface IngestResult {
  event: EventEnvelope;
  duplicate: boolean;
  entities: NormalizedEntity[];
  signals: Signal[];
}

/** Thrown after an invalid input has been safely stored as a dead letter. */
export class DeadLetteredError extends Error {
  constructor(
    readonly deadLetterId: string,
    readonly cause: ZodError,
  ) {
    super(`event rejected and dead-lettered as ${deadLetterId}`);
    this.name = "DeadLetteredError";
  }
}

function pick(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Wires the layers together in their fixed order. No layer can be skipped:
 * an event is validated and stored before normalization, and signals are
 * stored before reasoning ever sees them.
 */
export class BrainPipeline {
  private readonly window: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: BrainPipelineOptions) {
    this.window = options.reasoningWindow ?? 200;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  async ingest(input: unknown): Promise<IngestResult> {
    let event: EventEnvelope;
    try {
      event = parseEvent(input);
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      const id = `dl_${this.newId()}`;
      const organizationId = pick(input, "organizationId");
      const source = pick(input, "source");
      await this.options.memory.appendDeadLetter({
        id,
        ...(organizationId ? { organizationId } : {}),
        ...(source ? { source } : {}),
        reason: "validation_failed",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        raw: input,
        receivedAt: this.now().toISOString(),
      });
      throw new DeadLetteredError(id, error);
    }

    const { inserted } = await this.options.memory.appendEvent(event);
    if (!inserted) {
      return { event, duplicate: true, entities: [], signals: [] };
    }

    const entities: NormalizedEntity[] = [];
    for (const normalizer of this.options.normalizers) {
      if (normalizer.supports(event)) {
        entities.push(...(await normalizer.normalize(event)));
      }
    }
    await this.options.memory.upsertEntities(entities);

    const signals: Signal[] = [];
    if (entities.length > 0) {
      for (const extractor of this.options.extractors) {
        signals.push(...(await extractor.extract(entities, event)));
      }
    }
    await this.options.memory.appendSignals(signals);

    return { event, duplicate: false, entities, signals };
  }

  async reason(organizationId: string): Promise<Recommendation[]> {
    const startedAt = this.now().toISOString();
    const documentation = await this.options.documentation.current();
    const signals = await this.options.memory.recentSignals(organizationId, this.window);

    const recommendations: Recommendation[] = [];
    for (const reasoner of this.options.reasoners) {
      const produced = await reasoner.reason({ organizationId, signals, documentation });
      recommendations.push(
        ...produced.map((r) => ({
          ...r,
          // A reasoner cannot claim fresh docs when the documentation layer says otherwise.
          degraded: r.degraded || documentation.stale,
          provenance: {
            ...r.provenance,
            documentIds: [...new Set([...r.provenance.documentIds, ...documentation.documentIds])],
          },
        })),
      );
    }
    await this.options.memory.saveRecommendations(recommendations);
    await this.options.memory.recordReasoningRun({
      id: `run_${this.newId()}`,
      organizationId,
      startedAt,
      finishedAt: this.now().toISOString(),
      reasoners: this.options.reasoners.map((r) => r.name),
      documentation,
      degraded: documentation.stale,
      recommendationIds: recommendations.map((r) => r.id),
    });
    return recommendations;
  }
}
