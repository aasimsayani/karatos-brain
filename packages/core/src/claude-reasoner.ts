import { z } from "zod";
import type { Signal } from "./signals.js";
import type { DocumentationState, ModelReasoningRecord, ModelUsage, Recommendation } from "./reasoning.js";

/**
 * Layer 5, after the department rules: Claude reads a compact, redacted
 * summary of the run (the recent signals, the rules' recommendations and
 * the evidence behind them) and returns findings the rules alone don't
 * make, each citing what it rests on.
 *
 * - Provenance is mandatory. Every id in the summary is sent as a short
 *   reference (S1, E1, R1), and a finding that cites a reference not in the
 *   summary, or cites nothing, is dropped.
 * - Confidence is capped below the rules': a finding that cites no rule
 *   recommendation stays under UNCORROBORATED_CONFIDENCE_CAP and under the
 *   lowest rule's confidence; one that does is capped at the highest
 *   confidence among the recommendations it cites.
 * - It only reads. The model gets no tools and the reasoner writes nothing
 *   but its findings, which go through the feedback loop like any rule's.
 * - No customer names, emails or phone numbers are sent: fields that name a
 *   person are left out, and any value that looks like contact details is
 *   replaced with "[redacted]". Customer references are the hashed refs
 *   already in the signals.
 * - It never breaks the run. A time-out, an error or output that doesn't fit
 *   the schema is recorded on the reasoning run and the rules' findings stand.
 */

export const CLAUDE_REASONER_NAME = "claude";
/** Changes whenever the instructions or the output schema change, so a run's findings can be traced to the prompt that made them. */
export const CLAUDE_PROMPT_VERSION = "claude-reasoner-v1";
export const CLAUDE_REASONER_MODEL = "claude-opus-5-5";
/** Tokens, in and out, one run may spend by default: about 30 cents at Claude Opus 5.5's list price. */
export const DEFAULT_CLAUDE_TOKEN_CAP = 40_000;
/** The lowest cap an instance setting may give. */
export const MIN_CLAUDE_TOKEN_CAP = 8_000;
export const MAX_CLAUDE_TOKEN_CAP = 200_000;
export const DEFAULT_CLAUDE_TIMEOUT_MS = 90_000;
/** The most output tokens asked for, thinking included. */
export const CLAUDE_MAX_OUTPUT_TOKENS = 8_000;
/** Below this much room for output the call isn't worth making. */
export const CLAUDE_MIN_OUTPUT_TOKENS = 2_000;
/** A finding that cites no rule recommendation never ranks above this. */
export const UNCORROBORATED_CONFIDENCE_CAP = 0.5;
/** How far below the lowest rule's confidence an uncorroborated finding stays. */
export const UNCORROBORATED_MARGIN = 0.05;
export const CLAUDE_MAX_FINDINGS = 8;

export interface ClaudeSummaryLimits {
  /** The most recent signals sent, those the rules cite first. */
  signals: number;
  recommendations: number;
  /** Event references kept per signal. */
  eventsPerSignal: number;
}

export const DEFAULT_CLAUDE_SUMMARY_LIMITS: ClaudeSummaryLimits = { signals: 150, recommendations: 50, eventsPerSignal: 5 };

/** One call to the model, as the reasoner builds it. A client adapter turns it into a Messages API request. */
export interface ClaudeRequest {
  model: string;
  /** Fixed instructions; the same on every run, so they can be cached. */
  system: string;
  /** The summary. */
  user: string;
  maxOutputTokens: number;
  /** JSON schema the answer must follow. */
  schema: Record<string, unknown>;
  timeoutMs: number;
}

export interface ClaudeResponse {
  /** The answer's text, which should be JSON in the schema. */
  text: string;
  stopReason: string | null;
  /** The model that answered. */
  model: string;
  usage: ModelUsage;
}

/** Sends one request. The signal aborts it when the reasoner's time-out passes. */
export type ClaudeClient = (request: ClaudeRequest, options: { signal: AbortSignal }) => Promise<ClaudeResponse>;

export interface ModelReasoningInput {
  organizationId: string;
  now: string;
  signals: Signal[];
  /** The rules' recommendations this run, after feedback. */
  recommendations: Recommendation[];
  documentation: DocumentationState;
}

/** A finding and the highest confidence it may have, which feedback can lower but not raise past. */
export interface ModelFinding {
  recommendation: Recommendation;
  cap: number;
}

export interface ModelReview {
  findings: ModelFinding[];
  record: ModelReasoningRecord;
}

/** A reasoner that runs after the rules and reads what they found. review never throws. */
export interface ModelReasoner {
  readonly name: string;
  review(input: ModelReasoningInput): Promise<ModelReview>;
}

// ---------------------------------------------------------------- summary

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ClaudeSummary {
  now: string;
  documentationStale: boolean;
  /** The rules' recommendations, by reference: no text, which can name a customer. */
  rules: { ref: string; rule: string | null; confidence: number; degraded: boolean; impact: { kind: string; cents: number } | null; signals: string[]; events: string[] }[];
  signals: { ref: string; kind: string; subject: { kind: string; id: string }; value: Json; confidence: number; events: string[]; observedAt: string }[];
  omitted: { signals: number; recommendations: number };
}

export type SummaryRef = { kind: "signal" | "event" | "recommendation"; id: string };

export interface BuiltSummary {
  summary: ClaudeSummary;
  /** Each reference in the summary and the id it stands for. */
  refs: Map<string, SummaryRef>;
}

export const REDACTED = "[redacted]";

/** Words in a field name that mean it can hold a person's name, contact details or free text. */
const PERSONAL_WORDS = new Set([
  "name", "names", "firstname", "lastname", "fullname", "nickname",
  "email", "emails", "mail", "phone", "phones", "mobile", "tel", "fax", "sms", "whatsapp",
  "address", "addresses", "street", "city", "postal", "zip", "zipcode", "postcode",
  "birthday", "birth", "dob", "ssn", "passport", "license",
  "note", "notes", "message", "messages", "body", "text", "subject", "title", "description", "comment", "comments",
  "card", "iban", "routing", "who", "person", "people", "signature", "contact", "contacts",
]);
/** Field names that end in one of these are references, kept even when they mention a person: customerRef, contactRefs. */
const REFERENCE_ENDINGS = new Set(["ref", "refs", "hash"]);

/** Whether a field name could hold a person's details. */
export function personalField(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return true;
  if (REFERENCE_ENDINGS.has(words.at(-1)!)) return false;
  return words.some((w) => PERSONAL_WORDS.has(w));
}

const MAX_STRING = 64;
const MAX_ARRAY = 10;
const MAX_KEYS = 20;
const MAX_DEPTH = 3;

/**
 * A string fit to send: a short token with no spaces, no @, no run of
 * seven or more digits that could be a phone or card number, and not a
 * capitalized word that could be a name. Anything else is redacted.
 */
export function safeToken(value: string): string {
  if (value.length === 0) return value;
  if (value.length > MAX_STRING || /\s/.test(value) || value.includes("@")) return REDACTED;
  const isoDay = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!isoDay && (value.match(/\d/g) ?? []).length >= 7 && /^\+?[\d().\-]+$/.test(value)) return REDACTED;
  if (/\d{13,}/.test(value)) return REDACTED;
  if (/^[A-Z][a-z]+$/.test(value)) return REDACTED;
  return value;
}

/** A signal value with personal fields left out and unsafe strings redacted, bounded in depth and size. */
export function redactValue(value: unknown, depth = 0): Json {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return safeToken(value);
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => redactValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    let kept = 0;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (kept >= MAX_KEYS) break;
      if (personalField(key) || safeToken(key) !== key) continue;
      out[key] = redactValue(v, depth + 1);
      kept++;
    }
    return out;
  }
  return null;
}

/**
 * The summary the model reads. Signals the rules cite go first, then the
 * most recent others, up to the limits. Ids are replaced by references so
 * nothing inside an id (a message id can hold an address) is sent.
 */
export function buildClaudeSummary(input: ModelReasoningInput, limits: ClaudeSummaryLimits = DEFAULT_CLAUDE_SUMMARY_LIMITS): BuiltSummary {
  const recs = input.recommendations.slice(0, limits.recommendations);
  const cited = new Set(recs.flatMap((r) => r.provenance.signalIds));
  const order = input.signals.map((s, i) => ({ s, i }));
  const picked = [...order.filter(({ s }) => cited.has(s.id)), ...order.filter(({ s }) => !cited.has(s.id)).reverse()]
    .slice(0, limits.signals)
    .sort((a, b) => a.i - b.i)
    .map(({ s }) => s);

  const refs = new Map<string, SummaryRef>();
  const byId = new Map<string, string>();
  const counters = { signal: 0, event: 0, recommendation: 0 };
  const prefix = { signal: "S", event: "E", recommendation: "R" } as const;
  const refFor = (kind: SummaryRef["kind"], id: string): string => {
    const key = `${kind}:${id}`;
    let ref = byId.get(key);
    if (!ref) {
      ref = `${prefix[kind]}${++counters[kind]}`;
      byId.set(key, ref);
      refs.set(ref, { kind, id });
    }
    return ref;
  };

  const signals = picked.map((s) => ({
    ref: refFor("signal", s.id),
    kind: safeToken(s.kind),
    subject: { kind: safeToken(s.subject.kind), id: safeToken(s.subject.id) },
    value: redactValue(s.value),
    confidence: s.confidence,
    events: s.derivedFromEventIds.slice(0, limits.eventsPerSignal).map((id) => refFor("event", id)),
    observedAt: s.observedAt,
  }));
  const sentSignals = new Set(picked.map((s) => s.id));
  const rules = recs.map((r) => ({
    ref: refFor("recommendation", r.id),
    rule: r.rule === undefined ? null : safeToken(r.rule),
    confidence: r.confidence,
    degraded: r.degraded,
    impact: r.impact ? { kind: r.impact.kind, cents: r.impact.cents } : null,
    signals: r.provenance.signalIds.filter((id) => sentSignals.has(id)).map((id) => refFor("signal", id)),
    events: r.provenance.eventIds.slice(0, limits.eventsPerSignal).map((id) => refFor("event", id)),
  }));
  return {
    summary: {
      now: input.now,
      documentationStale: input.documentation.stale,
      rules,
      signals,
      omitted: { signals: input.signals.length - picked.length, recommendations: input.recommendations.length - recs.length },
    },
    refs,
  };
}

// ---------------------------------------------------------------- prompt and schema

export const CLAUDE_SYSTEM_PROMPT = `You review one reasoning run for a jewelry business. Deterministic department rules have already run; you read a JSON summary of what they saw and found, and look for what they miss: patterns across several signals or rules, a likely shared cause, or a risk none of them names alone.

The summary has:
- signals: observations, each with a ref (S1, S2...), a kind, a subject, a value, a confidence from 0 to 1 and the events (E1, E2...) it came from.
- rules: the rules' recommendations, each with a ref (R1, R2...), the rule that raised it, its confidence, any dollar impact in cents, and the signals and events it rests on. Their text is left out.
Personal details are never included. Values marked "[redacted]" were removed on purpose; don't guess at them.

Return findings in the JSON schema given:
- Every finding cites, in cites, the refs (S, E or R) it rests on. Cite only refs that appear in the summary. A finding with no valid citation is discarded.
- Don't restate a single rule's recommendation; add something a rule didn't say. When nothing new stands out, return an empty findings list.
- confidence is how sure you are, from 0 to 1. Be conservative: you see a summary, not the records.
- topic is two to five lowercase words joined by underscores that name the subject, such as repair_backlog_rising, so the same finding keeps its name from one day to the next.
- summary is one to three plain sentences for the store owner saying what you see and what a person should check. Suggest checks, never actions on outside systems.
- expectedImpact is one sentence on what acting on it is worth, or an empty string when you can't say.
Return at most ${CLAUDE_MAX_FINDINGS} findings, most important first.`;

export const CLAUDE_FINDINGS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "summary", "expectedImpact", "confidence", "cites"],
        properties: {
          topic: { type: "string", description: "Two to five lowercase words joined by underscores." },
          summary: { type: "string", description: "One to three sentences for the store owner." },
          expectedImpact: { type: "string", description: "What acting on it is worth, or an empty string." },
          confidence: { type: "number", description: "0 to 1." },
          cites: { type: "array", items: { type: "string" }, description: "Refs from the summary, such as S1, E2 or R3." },
        },
      },
    },
  },
};

const OutputSchema = z.object({ findings: z.array(z.unknown()) });
const FindingSchema = z.object({
  topic: z.string().min(1).max(120),
  summary: z.string().trim().min(1).max(1000),
  expectedImpact: z.string().max(500),
  confidence: z.number().min(0).max(1),
  cites: z.array(z.string()).min(1).max(60),
});

/** A rough count of the tokens in a text, on the high side: three characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** The id part a topic gives a finding: lowercase letters, digits and underscores, at most 40 characters. */
export function topicSlug(topic: string): string {
  const slug = trimUnderscores(trimUnderscores(topic.toLowerCase().replace(/[^a-z0-9]+/g, "_")).slice(0, 40));
  return slug || "finding";
}

/** Drops leading and trailing underscores by index, so long runs stay linear. */
function trimUnderscores(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "_") start++;
  while (end > start && text[end - 1] === "_") end--;
  return text.slice(start, end);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The highest confidence a finding may have, from the rule recommendations it cites, or the lowest of all of them when it cites none. */
export function confidenceCap(cited: readonly Recommendation[], all: readonly Recommendation[]): number {
  if (cited.length > 0) return Math.max(...cited.map((r) => r.confidence));
  const lowest = all.length > 0 ? Math.min(...all.map((r) => r.confidence)) - UNCORROBORATED_MARGIN : UNCORROBORATED_CONFIDENCE_CAP;
  return round2(Math.max(0.01, Math.min(UNCORROBORATED_CONFIDENCE_CAP, lowest)));
}

// ---------------------------------------------------------------- the reasoner

export class ClaudeTimeoutError extends Error {
  constructor() {
    super("the model did not answer in time");
    this.name = "ClaudeTimeoutError";
  }
}

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
function errorCode(error: unknown): string {
  if (error instanceof ClaudeTimeoutError) return "timeout";
  const name = error instanceof Error ? error.name : "";
  return `error:${ERROR_NAME.test(name) ? name : "UnknownError"}`;
}

export interface ClaudeReasonerOptions {
  client: ClaudeClient;
  /** Tokens, in and out, one run may spend. Default DEFAULT_CLAUDE_TOKEN_CAP. */
  tokenCap?: number;
  timeoutMs?: number;
  model?: string;
  limits?: ClaudeSummaryLimits;
  /** Gets one line per pass, with counts and codes only. */
  log?: (line: string) => void;
}

export class ClaudeReasoner implements ModelReasoner {
  readonly name = CLAUDE_REASONER_NAME;
  private readonly tokenCap: number;
  private readonly timeoutMs: number;
  private readonly model: string;
  private readonly limits: ClaudeSummaryLimits;
  private readonly log: (line: string) => void;

  constructor(private readonly options: ClaudeReasonerOptions) {
    this.tokenCap = options.tokenCap ?? DEFAULT_CLAUDE_TOKEN_CAP;
    if (!Number.isSafeInteger(this.tokenCap) || this.tokenCap < 1 || this.tokenCap > MAX_CLAUDE_TOKEN_CAP) {
      throw new RangeError(`the token cap must be a whole number from 1 to ${MAX_CLAUDE_TOKEN_CAP}`);
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS;
    if (!(this.timeoutMs > 0) || !Number.isFinite(this.timeoutMs)) throw new RangeError("the time-out must be a positive number of milliseconds");
    this.model = options.model ?? CLAUDE_REASONER_MODEL;
    this.limits = options.limits ?? DEFAULT_CLAUDE_SUMMARY_LIMITS;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** The summary and request for this input, shrunk to fit the token cap, or null when even an empty summary doesn't fit. */
  prepare(input: ModelReasoningInput): { built: BuiltSummary; request: ClaudeRequest } | null {
    const fixed = estimateTokens(CLAUDE_SYSTEM_PROMPT) + estimateTokens(JSON.stringify(CLAUDE_FINDINGS_SCHEMA));
    let limits = { ...this.limits };
    for (;;) {
      const built = buildClaudeSummary(input, limits);
      const user = `The run's summary, as JSON:\n${JSON.stringify(built.summary)}`;
      const room = this.tokenCap - fixed - estimateTokens(user);
      if (room >= CLAUDE_MIN_OUTPUT_TOKENS) {
        const request: ClaudeRequest = {
          model: this.model,
          system: CLAUDE_SYSTEM_PROMPT,
          user,
          maxOutputTokens: Math.min(CLAUDE_MAX_OUTPUT_TOKENS, room),
          schema: CLAUDE_FINDINGS_SCHEMA,
          timeoutMs: this.timeoutMs,
        };
        return { built, request };
      }
      if (limits.signals === 0 && limits.recommendations === 0) return null;
      limits = { ...limits, signals: Math.floor(limits.signals / 2), recommendations: Math.floor(limits.recommendations / 2) };
    }
  }

  async review(input: ModelReasoningInput): Promise<ModelReview> {
    const record: ModelReasoningRecord = {
      reasoner: this.name,
      model: this.model,
      promptVersion: CLAUDE_PROMPT_VERSION,
      status: "skipped",
      reason: null,
      tokenCap: this.tokenCap,
      usage: null,
      sent: { signals: 0, recommendations: 0, omittedSignals: input.signals.length, omittedRecommendations: input.recommendations.length },
      findings: 0,
      dropped: 0,
    };
    const done = (findings: ModelFinding[]): ModelReview => {
      this.log(
        `reasoning (${this.name}): ${record.status}${record.reason ? ` (${record.reason})` : ""}, ${record.findings} findings kept, ${record.dropped} dropped` +
          (record.usage ? `, ${record.usage.inputTokens} tokens in, ${record.usage.outputTokens} out` : ""),
      );
      return { findings, record };
    };

    const prepared = this.prepare(input);
    if (!prepared) {
      record.reason = "token_cap";
      return done([]);
    }
    const { built, request } = prepared;
    record.sent = {
      signals: built.summary.signals.length,
      recommendations: built.summary.rules.length,
      omittedSignals: built.summary.omitted.signals,
      omittedRecommendations: built.summary.omitted.recommendations,
    };

    let response: ClaudeResponse;
    try {
      response = await this.call(request);
    } catch (error) {
      record.status = "failed";
      record.reason = errorCode(error);
      return done([]);
    }
    record.model = response.model || this.model;
    record.usage = { ...response.usage };
    record.status = "failed";
    if (response.stopReason === "refusal") {
      record.reason = "refusal";
      return done([]);
    }
    if (response.stopReason === "max_tokens") {
      record.reason = "truncated";
      return done([]);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(response.text);
    } catch {
      record.reason = "malformed_output";
      return done([]);
    }
    const parsed = OutputSchema.safeParse(raw);
    if (!parsed.success) {
      record.reason = "malformed_output";
      return done([]);
    }

    const findings = this.resolve(parsed.data.findings, built, input);
    record.status = "succeeded";
    record.findings = findings.length;
    record.dropped = parsed.data.findings.length - findings.length;
    return done(findings);
  }

  /** Calls the client, giving up after the time-out even when the client ignores the abort. */
  private async call(request: ClaudeRequest): Promise<ClaudeResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ClaudeTimeoutError());
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.options.client(request, { signal: controller.signal }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The findings that fit the schema and whose every citation resolves, as recommendations. */
  private resolve(raw: readonly unknown[], built: BuiltSummary, input: ModelReasoningInput): ModelFinding[] {
    const day = input.now.slice(0, 10);
    const rules = new Map(input.recommendations.map((r) => [r.id, r]));
    const signals = new Map(input.signals.map((s) => [s.id, s]));
    const used = new Set<string>();
    const out: ModelFinding[] = [];
    for (const item of raw.slice(0, CLAUDE_MAX_FINDINGS)) {
      const finding = FindingSchema.safeParse(item);
      if (!finding.success) continue;
      const cites = [...new Set(finding.data.cites.map((c) => c.trim().toUpperCase()))].map((c) => built.refs.get(c));
      if (cites.some((c) => c === undefined)) continue;
      const resolved = cites as SummaryRef[];
      const ids = (kind: SummaryRef["kind"]) => resolved.filter((c) => c.kind === kind).map((c) => c.id);
      const citedRecs = ids("recommendation").map((id) => rules.get(id)!);
      const citedSignals = ids("signal").map((id) => signals.get(id)!);
      const eventIds = [...new Set([...ids("event"), ...citedSignals.flatMap((s) => s.derivedFromEventIds), ...citedRecs.flatMap((r) => r.provenance.eventIds)])];
      const signalIds = [...new Set([...citedSignals.map((s) => s.id), ...citedRecs.flatMap((r) => r.provenance.signalIds)])];

      const base = `rec_${this.name}_${topicSlug(finding.data.topic)}`;
      let id = `${base}_${day}`;
      for (let n = 2; used.has(id); n++) id = `${base}_${n}_${day}`;
      used.add(id);

      const cap = confidenceCap(citedRecs, input.recommendations);
      out.push({
        cap,
        recommendation: {
          id,
          organizationId: input.organizationId,
          summary: finding.data.summary,
          confidence: round2(Math.min(finding.data.confidence, cap)),
          expectedImpact: finding.data.expectedImpact.trim() || "Not estimated.",
          provenance: {
            eventIds,
            signalIds,
            documentIds: [...input.documentation.documentIds],
            recommendationIds: citedRecs.map((r) => r.id),
          },
          degraded: input.documentation.stale,
          createdAt: input.now,
          rule: this.name,
        },
      });
    }
    return out;
  }
}
