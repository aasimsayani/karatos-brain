import { randomUUID } from "node:crypto";
import { ZodError, type ZodType } from "zod";
import { parseEvent, type EventEnvelope } from "./events.js";
import type { NormalizedEntity } from "./entities.js";
import type { Signal } from "./signals.js";
import { impactProblem, type Recommendation } from "./reasoning.js";
import type { DocumentationSource, MemoryStore, Normalizer, Reasoner, SignalExtractor } from "./layers.js";
import { applyFeedback, DEFAULT_FEEDBACK_POLICY, feedbackPolicyProblem, readFeedbackHistory, type FeedbackHistory, type FeedbackPolicy, type HeldBack } from "./feedback.js";
import type { ModelFinding, ModelReasoner } from "./claude-reasoner.js";
import type { ModelReasoningRecord } from "./reasoning.js";

export interface BrainPipelineOptions {
  memory: MemoryStore;
  normalizers: Normalizer[];
  extractors: SignalExtractor[];
  reasoners: Reasoner[];
  documentation: DocumentationSource;
  /**
   * Payload schemas by event type. An event whose payload fails its schema is
   * dead-lettered before it is stored, just like a malformed envelope.
   */
  payloadSchemas?: Record<string, ZodType>;
  /** How many recent signals the reasoners see. */
  reasoningWindow?: number;
  /**
   * How feedback on earlier recommendations shapes each run: the cooldown
   * for dismissed subjects and how rules are ranked. Defaults to
   * DEFAULT_FEEDBACK_POLICY; false turns the loop off, leaving
   * recommendations as the rules wrote them apart from recording their rule.
   */
  feedback?: Partial<FeedbackPolicy> | false;
  /**
   * Runs after the rules and the feedback loop, reading the signals and the
   * rules' recommendations, such as the Claude reasoner. Its findings go
   * through the feedback loop as its own rule, never above the confidence
   * cap it gives each. Absent: rules only.
   */
  modelReasoner?: ModelReasoner;
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
  private readonly feedback: FeedbackPolicy | null;

  constructor(private readonly options: BrainPipelineOptions) {
    this.window = options.reasoningWindow ?? 200;
    this.feedback = options.feedback === false ? null : { ...DEFAULT_FEEDBACK_POLICY, ...options.feedback };
    const problem = this.feedback && feedbackPolicyProblem(this.feedback);
    if (problem) throw new RangeError(problem);
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  async ingest(input: unknown): Promise<IngestResult> {
    let event: EventEnvelope;
    try {
      event = parseEvent(input);
      const schema = this.options.payloadSchemas?.[event.type];
      if (schema) {
        const issues = schema.safeParse(event.payload);
        if (!issues.success) {
          throw new ZodError(issues.error.issues.map((i) => ({ ...i, path: ["payload", ...i.path] })));
        }
      }
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

    // Extractors see every stored event: status changes and prices carry
    // signals even when they create no entity.
    const signals: Signal[] = [];
    for (const extractor of this.options.extractors) {
      signals.push(...(await extractor.extract(entities, event)));
    }
    await this.options.memory.appendSignals(signals);

    return { event, duplicate: false, entities, signals };
  }

  async reason(organizationId: string): Promise<Recommendation[]> {
    return (await this.reasonWithFeedback(organizationId)).recommendations;
  }

  /** The policy the feedback loop runs with, or null when it is off. */
  get feedbackPolicy(): FeedbackPolicy | null {
    return this.feedback ? { ...this.feedback } : null;
  }

  /**
   * One reasoning run, with what feedback held back. Recommendations held
   * back by the cooldown are neither stored nor returned. With a model
   * reasoner, its findings follow the rules' recommendations, and
   * modelReasoning says what it did.
   */
  async reasonWithFeedback(
    organizationId: string,
  ): Promise<{ recommendations: Recommendation[]; heldBack: HeldBack[]; modelReasoning?: ModelReasoningRecord }> {
    const startedAt = this.now().toISOString();
    const documentation = await this.options.documentation.current();
    const signals = await this.options.memory.recentSignals(organizationId, this.window);

    const settle = (name: string, produced: Recommendation[]): Recommendation[] =>
      produced.map(({ impact, ranking: _ranking, ...r }) => ({
        ...r,
        // The rule is the reasoner that raised it, whatever the reasoner wrote.
        rule: name,
        // A dollar figure that doesn't add up is dropped rather than shown; the recommendation stands.
        ...(impact && !impactProblem(impact) ? { impact } : {}),
        // A reasoner cannot claim fresh docs when the documentation layer says otherwise.
        degraded: r.degraded || documentation.stale,
        provenance: {
          ...r.provenance,
          documentIds: [...new Set([...r.provenance.documentIds, ...documentation.documentIds])],
        },
      }));

    const fresh: Recommendation[] = [];
    for (const reasoner of this.options.reasoners) {
      fresh.push(...settle(reasoner.name, await reasoner.reason({ organizationId, signals, documentation, now: startedAt })));
    }
    let recommendations = fresh;
    let heldBack: HeldBack[] = [];
    let history: FeedbackHistory | null = null;
    if (this.feedback) {
      history = await readFeedbackHistory(this.options.memory, organizationId, startedAt, this.feedback);
      ({ recommendations, heldBack } = applyFeedback({ ...history, organizationId, now: startedAt, fresh, policy: this.feedback }));
    }

    let modelReasoning: ModelReasoningRecord | undefined;
    const model = this.options.modelReasoner;
    if (model) {
      let findings: ModelFinding[] = [];
      try {
        ({ findings, record: modelReasoning } = await model.review({ organizationId, now: startedAt, signals, recommendations, documentation }));
      } catch (error) {
        // review shouldn't throw; if it does, the rules' run stands and the run says the model failed.
        modelReasoning = failedModelRecord(model.name, error);
      }
      const caps = new Map(findings.map((f) => [f.recommendation.id, f.cap]));
      let kept = settle(model.name, findings.map((f) => f.recommendation));
      if (this.feedback && history) {
        const applied = applyFeedback({ ...history, organizationId, now: startedAt, fresh: kept, policy: this.feedback });
        kept = applied.recommendations;
        heldBack = [...heldBack, ...applied.heldBack];
      }
      // Feedback can lower a finding but never lift it past its cap.
      kept = kept.map((r) => ({ ...r, confidence: Math.min(r.confidence, caps.get(r.id) ?? 0) }));
      recommendations = [...recommendations, ...kept];
    }

    await this.options.memory.saveRecommendations(recommendations);
    await this.options.memory.recordReasoningRun({
      id: `run_${this.newId()}`,
      organizationId,
      startedAt,
      finishedAt: this.now().toISOString(),
      reasoners: [...this.options.reasoners.map((r) => r.name), ...(model ? [model.name] : [])],
      documentation,
      degraded: documentation.stale,
      recommendationIds: recommendations.map((r) => r.id),
      ...(modelReasoning ? { modelReasoning } : {}),
    });
    return { recommendations, heldBack, ...(modelReasoning ? { modelReasoning } : {}) };
  }
}

/** The record for a model reasoner that threw instead of reporting. */
function failedModelRecord(reasoner: string, error: unknown): ModelReasoningRecord {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(error.name) ? error.name : "UnknownError";
  return {
    reasoner,
    model: "unknown",
    promptVersion: "unknown",
    status: "failed",
    reason: `error:${name}`,
    tokenCap: 0,
    usage: null,
    sent: { signals: 0, recommendations: 0, omittedSignals: 0, omittedRecommendations: 0 },
    findings: 0,
    dropped: 0,
  };
}
