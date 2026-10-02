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
}

export interface IngestResult {
  event: EventEnvelope;
  duplicate: boolean;
  entities: NormalizedEntity[];
  signals: Signal[];
}

/**
 * Wires the layers together in their fixed order. No layer can be skipped:
 * an event is validated and stored before normalization, and signals are
 * stored before reasoning ever sees them.
 */
export class BrainPipeline {
  private readonly window: number;

  constructor(private readonly options: BrainPipelineOptions) {
    this.window = options.reasoningWindow ?? 200;
  }

  async ingest(input: unknown): Promise<IngestResult> {
    const event = parseEvent(input);
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
    return recommendations;
  }
}
