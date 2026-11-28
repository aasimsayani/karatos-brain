import { describe, expect, it } from "vitest";
import {
  BrainPipeline,
  buildClaudeSummary,
  CLAUDE_FINDINGS_SCHEMA,
  CLAUDE_MAX_FINDINGS,
  CLAUDE_MAX_OUTPUT_TOKENS,
  CLAUDE_PROMPT_VERSION,
  CLAUDE_REASONER_MODEL,
  CLAUDE_SYSTEM_PROMPT,
  ClaudeReasoner,
  ClaudeTimeoutError,
  confidenceCap,
  DEFAULT_CLAUDE_TOKEN_CAP,
  estimateTokens,
  InMemoryStore,
  personalField,
  redactValue,
  REDACTED,
  safeToken,
  topicSlug,
  UNCORROBORATED_CONFIDENCE_CAP,
  type ClaudeClient,
  type ClaudeRequest,
  type ClaudeResponse,
  type Feedback,
  type ModelReasoner,
  type ModelReasoningInput,
  type Reasoner,
  type Recommendation,
  type Signal,
} from "../src/index.js";

const ORG = "example-jewelers";
const NOW = "2026-11-28T12:00:00.000Z";
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();

function signal(id: string, over: Partial<Signal> = {}): Signal {
  return {
    id,
    organizationId: ORG,
    kind: "repair.late",
    subject: { kind: "repair", id: `rp_${id}` },
    value: { daysLate: 3 },
    confidence: 1,
    derivedFromEventIds: [`evt_${id}`],
    observedAt: NOW,
    ...over,
  };
}

function rec(id: string, over: Partial<Recommendation> = {}): Recommendation {
  return {
    id,
    organizationId: ORG,
    summary: `summary of ${id}`,
    confidence: 0.8,
    expectedImpact: "",
    provenance: { eventIds: [], signalIds: [], documentIds: [] },
    degraded: false,
    createdAt: NOW,
    rule: "repairs",
    ...over,
  };
}

function input(over: Partial<ModelReasoningInput> = {}): ModelReasoningInput {
  return {
    organizationId: ORG,
    now: NOW,
    signals: [signal("s1"), signal("s2")],
    recommendations: [rec("rec_repairs_late_rp_s1_2026-11-28", { provenance: { eventIds: ["evt_s1"], signalIds: ["s1"], documentIds: [] } })],
    documentation: { documentIds: ["doc_1"], stale: false },
    ...over,
  };
}

const usage = { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 0, cacheCreationInputTokens: 1000 };

type Finding = { topic: string; summary: string; expectedImpact: string; confidence: number; cites: string[] };
const finding = (over: Partial<Finding> = {}): Finding => ({
  topic: "repair backlog",
  summary: "Late repairs are piling up at one stage.",
  expectedImpact: "Fewer calls from waiting customers.",
  confidence: 0.4,
  cites: ["S1"],
  ...over,
});

/** A mocked client: never the real API. Keeps every request it was sent. */
function mockClient(answer: Partial<ClaudeResponse> | ((request: ClaudeRequest) => Promise<ClaudeResponse>), sent: ClaudeRequest[] = []) {
  const client: ClaudeClient = async (request, options) => {
    sent.push(request);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    if (typeof answer === "function") return answer(request);
    return { text: "", stopReason: "end_turn", model: CLAUDE_REASONER_MODEL, usage, ...answer };
  };
  return { client, sent };
}

const answering = (findings: unknown[], over: Partial<ClaudeResponse> = {}) => mockClient({ text: JSON.stringify({ findings }), ...over });

function reasoner(client: ClaudeClient, over: Partial<ConstructorParameters<typeof ClaudeReasoner>[0]> = {}) {
  const lines: string[] = [];
  return { reasoner: new ClaudeReasoner({ client, log: (l) => lines.push(l), ...over }), lines };
}

describe("redaction", () => {
  it("leaves out fields that name a person and keeps references", () => {
    for (const key of ["name", "customerName", "contact", "first_name", "email", "phoneNumber", "billingAddress", "note", "messageBody", "who", "title", "refName", "customerRefNote", ""]) {
      expect(personalField(key), key).toBe(true);
    }
    for (const key of ["customerRef", "contactRefs", "customerNameHash", "amountCents", "status", "daysLate", "sku", "capacity"]) {
      expect(personalField(key), key).toBe(false);
    }
  });

  it("redacts strings that could be contact details, names or free text", () => {
    for (const v of ["jane@example.test", "555-0142", "5550142", "555-0142 x", "+1 (555) 555-0142", "(555)555-0142", "+15555550142", "Jane", "a".repeat(65), "4111111111111111x", "call me"]) {
      expect(safeToken(v), v).toBe(REDACTED);
    }
    for (const v of ["", "cref_9f2c1a", "ready", "RING-14K-01", "2026-11-28", "2026-11-28T12:00:00Z", "1001", "123456", "JM", "a".repeat(64), "stage:casting"]) {
      expect(safeToken(v), v).toBe(v);
    }
  });

  it("bounds values in depth, length and keys", () => {
    expect(redactValue(Number.NaN)).toBeNull();
    expect(redactValue(undefined)).toBeNull();
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(Array.from({ length: 30 }, (_, i) => i))).toHaveLength(10);
    expect(redactValue({ a: { b: { c: { d: 1 } } } })).toEqual({ a: { b: { c: REDACTED } } });
    expect(redactValue([[[["deep"]]]])).toEqual([[[REDACTED]]]);
    const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(redactValue(wide) as object)).toHaveLength(20);
    expect(redactValue({ "bad key": 1, email: "x", ok: 2 })).toEqual({ ok: 2 });
  });

  it("sends no customer names, emails or phone numbers, nor the store's id", async () => {
    const { client, sent } = answering([]);
    const pii: Signal = signal("sig_pii", {
      subject: { kind: "customer", id: "jane@example.test" },
      value: {
        customerName: "Jane Doe",
        name: "Jane",
        email: "jane@example.test",
        phone: "555-0142",
        contact: { mobile: "+15555550142", city: "Springfield" },
        note: "Prefers calls after five",
        lastSeen: "Jane",
        refs: ["cref_9f2c1a", "jane@example.test", "(555) 555-0142"],
        customerRefs: ["cref_9f2c1a"],
        amountCents: 120_000,
      },
      derivedFromEventIds: ["evt_<msg-1@mail.example.test>"],
    });
    const named = rec("rec_clienteling_lapsed_c1_2026-11-28", {
      summary: "Jane Doe (jane@example.test, 555-0142) hasn't bought in 200 days.",
      expectedImpact: "Call Jane Doe at 555-0142.",
      rule: "clienteling",
      provenance: { eventIds: ["evt_<msg-1@mail.example.test>"], signalIds: ["sig_pii"], documentIds: [] },
    });
    await reasoner(client).reasoner.review(input({ signals: [pii], recommendations: [named] }));
    expect(sent).toHaveLength(1);
    const payload = JSON.stringify(sent[0]);
    for (const leak of ["Jane", "Doe", "example.test", "0142", "Springfield", "Prefers", ORG]) expect(payload).not.toContain(leak);
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.push(k), walk(x));
    };
    walk(JSON.parse(sent[0]!.user.slice(sent[0]!.user.indexOf("{"))));
    for (const k of ["name", "customerName", "email", "phone", "mobile", "contact", "note", "summary", "expectedImpact", "organizationId"]) expect(keys).not.toContain(k);
    // Hashed customer references and amounts still go.
    expect(payload).toContain("cref_9f2c1a");
    expect(payload).toContain("120000");
  });
});

describe("the summary", () => {
  it("replaces ids with references and keeps the rules' evidence", () => {
    const { summary, refs } = buildClaudeSummary(
      input({
        recommendations: [
          rec("r_a", {
            confidence: 0.7,
            impact: { kind: "protects", cents: 5000, lowCents: 0, highCents: 9000, basis: "b" },
            provenance: { eventIds: ["evt_s2", "evt_x"], signalIds: ["s2", "s_gone"], documentIds: [] },
          }),
          rec("r_b", { rule: undefined as unknown as string, degraded: true }),
        ],
      }),
    );
    expect(summary.signals.map((s) => s.ref)).toEqual(["S1", "S2"]);
    expect(summary.signals[0]).toMatchObject({ kind: "repair.late", subject: { kind: "repair", id: "rp_s1" }, value: { daysLate: 3 }, confidence: 1, events: ["E1"], observedAt: NOW });
    expect(summary.rules).toEqual([
      { ref: "R1", rule: "repairs", confidence: 0.7, degraded: false, impact: { kind: "protects", cents: 5000 }, signals: ["S2"], events: ["E2", "E3"] },
      { ref: "R2", rule: null, confidence: 0.8, degraded: true, impact: null, signals: [], events: [] },
    ]);
    expect(refs.get("S2")).toEqual({ kind: "signal", id: "s2" });
    expect(refs.get("E3")).toEqual({ kind: "event", id: "evt_x" });
    expect(refs.get("R2")).toEqual({ kind: "recommendation", id: "r_b" });
    expect(summary).toMatchObject({ now: NOW, documentationStale: false, omitted: { signals: 0, recommendations: 0 } });
  });

  it("sends the signals the rules cite first, then the newest, in their own order", () => {
    const signals = Array.from({ length: 6 }, (_, i) => signal(`s${i}`));
    const { summary, refs } = buildClaudeSummary(
      input({ signals, recommendations: [rec("r1", { provenance: { eventIds: [], signalIds: ["s0"], documentIds: [] } }), rec("r2"), rec("r3")] }),
      { signals: 3, recommendations: 2, eventsPerSignal: 0 },
    );
    expect(summary.signals.map((s) => refs.get(s.ref)!.id)).toEqual(["s0", "s4", "s5"]);
    expect(summary.signals[0]!.events).toEqual([]);
    expect(summary.omitted).toEqual({ signals: 3, recommendations: 1 });
    expect(summary.rules).toHaveLength(2);
  });

  it("gives one reference to an id however often it appears", () => {
    const { summary } = buildClaudeSummary(input({ signals: [signal("a", { derivedFromEventIds: ["e1", "e2"] }), signal("b", { derivedFromEventIds: ["e1"] })], recommendations: [] }));
    expect(summary.signals.map((s) => s.events)).toEqual([["E1", "E2"], ["E1"]]);
  });

  it("estimates tokens on the high side and slugs topics", () => {
    expect(estimateTokens("abcdef")).toBe(2);
    expect(estimateTokens("abcdefg")).toBe(3);
    expect(topicSlug(" Repair Backlog: Rising! ")).toBe("repair_backlog_rising");
    expect(topicSlug("***")).toBe("finding");
    expect(topicSlug(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
    expect(topicSlug("x".repeat(50))).toHaveLength(40);
  });
});

describe("confidence caps", () => {
  it("keeps an uncorroborated finding below every rule and the fixed cap", () => {
    expect(confidenceCap([], [])).toBe(UNCORROBORATED_CONFIDENCE_CAP);
    expect(confidenceCap([], [rec("a", { confidence: 0.9 })])).toBe(0.5);
    expect(confidenceCap([], [rec("a", { confidence: 0.9 }), rec("b", { confidence: 0.4 })])).toBe(0.35);
    expect(confidenceCap([], [rec("a", { confidence: 0.02 })])).toBe(0.01);
  });

  it("lets a corroborated finding reach the highest rule it cites", () => {
    expect(confidenceCap([rec("a", { confidence: 0.6 }), rec("b", { confidence: 0.85 })], [rec("c", { confidence: 0.3 })])).toBe(0.85);
  });
});

describe("the Claude reasoner", () => {
  it("returns findings that cite the summary, with full provenance, and records the run", async () => {
    const { client, sent } = answering([finding({ cites: ["S1", "r1", "E2"], confidence: 0.95 }), finding({ topic: "repair backlog", cites: ["S2"], confidence: 0.9, expectedImpact: "  " })]);
    const { reasoner: claude, lines } = reasoner(client);
    const ruleRec = rec("rec_repairs_late_rp_s1_2026-11-28", { confidence: 0.7, provenance: { eventIds: ["evt_r"], signalIds: ["s1", "s_old"], documentIds: [] } });
    const { findings, record } = await claude.review(input({ recommendations: [ruleRec] }));

    expect(sent[0]).toMatchObject({ model: CLAUDE_REASONER_MODEL, system: CLAUDE_SYSTEM_PROMPT, schema: CLAUDE_FINDINGS_SCHEMA, timeoutMs: 90_000 });
    expect(sent[0]!.maxOutputTokens).toBe(CLAUDE_MAX_OUTPUT_TOKENS);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toEqual({
      cap: 0.7,
      recommendation: {
        id: "rec_claude_repair_backlog_2026-11-28",
        organizationId: ORG,
        summary: "Late repairs are piling up at one stage.",
        confidence: 0.7,
        expectedImpact: "Fewer calls from waiting customers.",
        provenance: { eventIds: ["evt_s2", "evt_s1", "evt_r"], signalIds: ["s1", "s_old"], documentIds: ["doc_1"], recommendationIds: [ruleRec.id] },
        degraded: false,
        createdAt: NOW,
        rule: "claude",
      },
    });
    // The same topic twice gets its own id; uncorroborated, it stays under the rules.
    expect(findings[1]!.recommendation).toMatchObject({ id: "rec_claude_repair_backlog_2_2026-11-28", confidence: 0.5, expectedImpact: "Not estimated.", provenance: { signalIds: ["s2"], eventIds: ["evt_s2"], recommendationIds: [] } });
    expect(findings[1]!.cap).toBe(0.5);
    expect(record).toEqual({
      reasoner: "claude",
      model: CLAUDE_REASONER_MODEL,
      promptVersion: CLAUDE_PROMPT_VERSION,
      status: "succeeded",
      reason: null,
      tokenCap: DEFAULT_CLAUDE_TOKEN_CAP,
      usage,
      sent: { signals: 2, recommendations: 1, omittedSignals: 0, omittedRecommendations: 0 },
      findings: 2,
      dropped: 0,
    });
    expect(lines).toEqual(["reasoning (claude): succeeded, 2 findings kept, 0 dropped, 1200 tokens in, 300 out"]);
  });

  it("drops a finding whose citations don't all resolve to the summary", async () => {
    const { client } = answering([
      finding({ topic: "real", cites: ["S1"] }),
      finding({ topic: "blank", summary: "   " }),
      finding({ topic: "made up", cites: ["S99"] }),
      finding({ topic: "half made up", cites: ["S1", "R7"] }),
      finding({ topic: "raw id", cites: ["evt_s1"] }),
      finding({ topic: "lower case", cites: ["s2"] }),
      finding({ topic: "uncited", cites: [] }),
      { topic: "wrong shape", summary: 3 },
      finding({ topic: "too sure", confidence: 1.5 }),
    ]);
    const { findings, record } = await reasoner(client).reasoner.review(input());
    expect(findings.map((f) => f.recommendation.id)).toEqual(["rec_claude_real_2026-11-28", "rec_claude_lower_case_2026-11-28"]);
    expect(record).toMatchObject({ status: "succeeded", findings: 2, dropped: 7 });
  });

  it("keeps at most CLAUDE_MAX_FINDINGS", async () => {
    const { client } = answering(Array.from({ length: CLAUDE_MAX_FINDINGS + 3 }, (_, i) => finding({ topic: `t${i}` })));
    const { findings, record } = await reasoner(client).reasoner.review(input());
    expect(findings).toHaveLength(CLAUDE_MAX_FINDINGS);
    expect(record.dropped).toBe(3);
  });

  it("marks degraded findings when the docs are stale and uses the model that answered", async () => {
    const { client } = answering([finding()], { model: "claude-opus-4-8" });
    const { findings, record } = await reasoner(client).reasoner.review(input({ documentation: { documentIds: [], stale: true } }));
    expect(findings[0]!.recommendation.degraded).toBe(true);
    expect(record.model).toBe("claude-opus-4-8");
    const { client: blank } = answering([finding()], { model: "" });
    expect((await reasoner(blank).reasoner.review(input())).record.model).toBe(CLAUDE_REASONER_MODEL);
  });

  it("fails the pass, not the run, on output that isn't JSON in the schema", async () => {
    for (const text of ["not json", "[]", JSON.stringify({ findings: "none" }), JSON.stringify({ other: [] })]) {
      const { client } = mockClient({ text });
      const { reasoner: claude, lines } = reasoner(client);
      const { findings, record } = await claude.review(input());
      expect(findings, text).toEqual([]);
      expect(record, text).toMatchObject({ status: "failed", reason: "malformed_output", usage, findings: 0, dropped: 0 });
      expect(lines[0]).toBe("reasoning (claude): failed (malformed_output), 0 findings kept, 0 dropped, 1200 tokens in, 300 out");
    }
  });

  it("treats a refusal or a truncated answer as failed", async () => {
    const valid = JSON.stringify({ findings: [finding()] });
    const declined = await reasoner(mockClient({ text: valid, stopReason: "refusal" }).client).reasoner.review(input());
    expect(declined).toMatchObject({ findings: [], record: { status: "failed", reason: "refusal" } });
    const cut = await reasoner(mockClient({ text: valid, stopReason: "max_tokens" }).client).reasoner.review(input());
    expect(cut).toMatchObject({ findings: [], record: { status: "failed", reason: "truncated" } });
  });

  it("gives up after the time-out even when the client ignores the abort", async () => {
    let aborted: AbortSignal | undefined;
    const hang: ClaudeClient = (_request, { signal }) => {
      aborted = signal;
      return new Promise(() => {});
    };
    const { reasoner: claude, lines } = reasoner(hang, { timeoutMs: 20 });
    const { findings, record } = await claude.review(input());
    expect(findings).toEqual([]);
    expect(record).toMatchObject({ status: "failed", reason: "timeout", usage: null });
    expect(aborted?.aborted).toBe(true);
    expect(lines[0]).toBe("reasoning (claude): failed (timeout), 0 findings kept, 0 dropped");
    expect(new ClaudeTimeoutError().name).toBe("ClaudeTimeoutError");
  });

  it("records an error by its class name only", async () => {
    class RateLimitError extends Error {
      override name = "RateLimitError";
    }
    const secretish = "jane@example.test leaked in a message";
    const { reasoner: claude, lines } = reasoner(async () => {
      throw new RateLimitError(secretish);
    });
    expect((await claude.review(input())).record).toMatchObject({ status: "failed", reason: "error:RateLimitError" });
    expect(lines.join("\n")).not.toContain("jane");
    const odd = reasoner(async () => {
      throw "a string";
    });
    expect((await odd.reasoner.review(input())).record.reason).toBe("error:UnknownError");
    const badName = new Error("x");
    badName.name = "bad name with spaces";
    expect((await reasoner(async () => Promise.reject(badName)).reasoner.review(input())).record.reason).toBe("error:UnknownError");
  });

  it("shrinks the summary to fit the token cap and leaves room for the answer", async () => {
    const signals = Array.from({ length: 400 }, (_, i) => signal(`sig_${i}`, { value: { stage: "casting", daysLate: i, bench: `b${i}` } }));
    const { client, sent } = answering([]);
    const cap = 12_000;
    const { record } = await reasoner(client, { tokenCap: cap }).reasoner.review(input({ signals }));
    const request = sent[0]!;
    const spent = estimateTokens(request.system) + estimateTokens(JSON.stringify(request.schema)) + estimateTokens(request.user);
    expect(spent + request.maxOutputTokens).toBeLessThanOrEqual(cap);
    expect(request.maxOutputTokens).toBeGreaterThanOrEqual(2_000);
    expect(record.sent.omittedSignals).toBeGreaterThan(0);
    expect(record.sent.signals + record.sent.omittedSignals).toBe(400);
    expect(record.tokenCap).toBe(cap);
  });

  it("keeps halving the recommendations once no signals are left", async () => {
    const recommendations = Array.from({ length: 50 }, (_, i) =>
      rec(`r${i}`, { provenance: { eventIds: Array.from({ length: 8 }, (_, j) => `evt_${i}_${j}`), signalIds: [], documentIds: [] } }),
    );
    const { client, sent } = answering([]);
    const claude = reasoner(client, { tokenCap: 4_000, limits: { signals: 1, recommendations: 50, eventsPerSignal: 8 } }).reasoner;
    const { record } = await claude.review(input({ recommendations }));
    expect(sent).toHaveLength(1);
    expect(record.status).toBe("succeeded");
    expect(record.sent.signals).toBe(0);
    expect(record.sent.recommendations).toBeGreaterThan(0);
    expect(record.sent.recommendations).toBeLessThan(25);
    expect(record.sent.omittedRecommendations).toBeGreaterThan(0);
  });

  it("skips the call when even an empty summary can't fit the cap", async () => {
    const { client, sent } = answering([]);
    const { reasoner: claude, lines } = reasoner(client, { tokenCap: 1_000 });
    const { findings, record } = await claude.review(input());
    expect(sent).toEqual([]);
    expect(findings).toEqual([]);
    expect(record).toMatchObject({ status: "skipped", reason: "token_cap", usage: null, sent: { signals: 0, recommendations: 0, omittedSignals: 2, omittedRecommendations: 1 } });
    expect(lines[0]).toBe("reasoning (claude): skipped (token_cap), 0 findings kept, 0 dropped");
  });

  it("checks its settings", () => {
    const { client } = answering([]);
    for (const tokenCap of [0, 1.5, 200_001]) expect(() => new ClaudeReasoner({ client, tokenCap })).toThrow(RangeError);
    expect(() => new ClaudeReasoner({ client, tokenCap: 200_000 })).not.toThrow();
    for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY]) expect(() => new ClaudeReasoner({ client, timeoutMs })).toThrow(RangeError);
    const claude = new ClaudeReasoner({ client, model: "claude-sonnet-5-5", limits: { signals: 1, recommendations: 0, eventsPerSignal: 1 } });
    expect(claude.prepare(input())!.request.model).toBe("claude-sonnet-5-5");
    expect(claude.prepare(input())!.built.summary.signals).toHaveLength(1);
  });

  it("logs to the console by default", async () => {
    const { client } = answering([]);
    const logged: unknown[] = [];
    const original = console.log;
    console.log = (line: unknown) => void logged.push(line);
    try {
      await new ClaudeReasoner({ client }).review(input());
    } finally {
      console.log = original;
    }
    expect(logged).toEqual(["reasoning (claude): succeeded, 0 findings kept, 0 dropped, 1200 tokens in, 300 out"]);
  });
});

describe("the Claude reasoner in the pipeline", () => {
  const repairsRule = (confidence = 0.8): Reasoner => ({
    name: "repairs",
    reason: ({ organizationId, signals, now }) =>
      signals.map((s) => rec(`rec_repairs_late_${s.subject.id}_${now.slice(0, 10)}`, { organizationId, confidence, createdAt: now, provenance: { eventIds: s.derivedFromEventIds, signalIds: [s.id], documentIds: [] } })),
  });

  async function setup(over: { model?: ModelReasoner; feedback?: false; memory?: InMemoryStore; now?: string; rule?: Reasoner } = {}) {
    const memory = over.memory ?? new InMemoryStore();
    if (!over.memory) await memory.appendSignals([signal("s1")]);
    const pipeline = new BrainPipeline({
      memory,
      normalizers: [],
      extractors: [],
      reasoners: [over.rule ?? repairsRule()],
      documentation: { current: () => ({ documentIds: ["doc_1"], stale: false }) },
      now: () => new Date(over.now ?? NOW),
      newId: () => "1",
      ...(over.model ? { modelReasoner: over.model } : {}),
      ...(over.feedback === false ? { feedback: false as const } : {}),
    });
    return { memory, pipeline };
  }

  it("runs nothing extra without a model reasoner", async () => {
    const { memory, pipeline } = await setup();
    const result = await pipeline.reasonWithFeedback(ORG);
    expect(result.modelReasoning).toBeUndefined();
    const run = await memory.latestReasoningRun(ORG);
    expect(run!.reasoners).toEqual(["repairs"]);
    expect(run!.modelReasoning).toBeUndefined();
  });

  it("adds the model's findings after the rules', as their own rule, and records the model on the run", async () => {
    const { client, sent } = answering([finding({ cites: ["S1", "R1"], confidence: 0.6 })]);
    const { memory, pipeline } = await setup({ model: reasoner(client).reasoner });
    const { recommendations, modelReasoning } = await pipeline.reasonWithFeedback(ORG);
    expect(sent[0]!.user).toContain('"rule":"repairs"');
    expect(recommendations.map((r) => [r.id, r.rule])).toEqual([
      ["rec_repairs_late_rp_s1_2026-11-28", "repairs"],
      ["rec_claude_repair_backlog_2026-11-28", "claude"],
    ]);
    expect(recommendations[1]).toMatchObject({
      confidence: 0.6,
      ranking: { baseConfidence: 0.6, factor: 1 },
      provenance: { recommendationIds: ["rec_repairs_late_rp_s1_2026-11-28"], signalIds: ["s1"], eventIds: ["evt_s1"], documentIds: ["doc_1"] },
    });
    const run = await memory.latestReasoningRun(ORG);
    expect(run).toMatchObject({ reasoners: ["repairs", "claude"], recommendationIds: recommendations.map((r) => r.id) });
    expect(run!.modelReasoning).toEqual(modelReasoning);
    expect(modelReasoning).toMatchObject({ model: CLAUDE_REASONER_MODEL, promptVersion: CLAUDE_PROMPT_VERSION, usage, status: "succeeded", findings: 1 });
    expect(await memory.listRecommendations(ORG, 10)).toHaveLength(2);
  });

  it("keeps the rules' findings when the model fails or times out", async () => {
    const { reasoner: failing } = reasoner(async () => {
      throw new TypeError("fetch failed");
    });
    const { memory, pipeline } = await setup({ model: failing });
    const { recommendations, modelReasoning } = await pipeline.reasonWithFeedback(ORG);
    expect(recommendations.map((r) => r.rule)).toEqual(["repairs"]);
    expect(modelReasoning).toMatchObject({ status: "failed", reason: "error:TypeError" });
    expect((await memory.latestReasoningRun(ORG))!.modelReasoning).toMatchObject({ status: "failed" });

    const { reasoner: slow } = reasoner(() => new Promise(() => {}), { timeoutMs: 10 });
    const timed = await (await setup({ model: slow })).pipeline.reasonWithFeedback(ORG);
    expect(timed.recommendations).toHaveLength(1);
    expect(timed.modelReasoning).toMatchObject({ status: "failed", reason: "timeout" });
  });

  it("survives a model reasoner that throws", async () => {
    for (const [thrown, reason] of [
      [new RangeError("boom"), "error:RangeError"],
      [42, "error:UnknownError"],
    ] as const) {
      const broken: ModelReasoner = { name: "broken", review: () => Promise.reject(thrown) };
      const { memory, pipeline } = await setup({ model: broken });
      const { recommendations, modelReasoning } = await pipeline.reasonWithFeedback(ORG);
      expect(recommendations).toHaveLength(1);
      expect(modelReasoning).toEqual({
        reasoner: "broken",
        model: "unknown",
        promptVersion: "unknown",
        status: "failed",
        reason,
        tokenCap: 0,
        usage: null,
        sent: { signals: 0, recommendations: 0, omittedSignals: 0, omittedRecommendations: 0 },
        findings: 0,
        dropped: 0,
      });
      expect((await memory.latestReasoningRun(ORG))!.reasoners).toEqual(["repairs", "broken"]);
    }
  });

  it("holds back a finding dismissed within the cooldown, like any rule's", async () => {
    const memory = new InMemoryStore();
    await memory.appendSignals([signal("s1")]);
    const id = (day: string) => `rec_claude_repair_backlog_${day}`;
    await memory.saveRecommendations([rec(id(ago(1).slice(0, 10)), { rule: "claude", confidence: 0.4, createdAt: ago(1) })]);
    await memory.recordFeedback({ recommendationId: id(ago(1).slice(0, 10)), organizationId: ORG, outcome: "rejected", actor: "owner", recordedAt: ago(1) } satisfies Feedback);
    const { client } = answering([finding({ confidence: 0.4 })]);
    const { pipeline } = await setup({ memory, model: reasoner(client).reasoner });
    const { recommendations, heldBack } = await pipeline.reasonWithFeedback(ORG);
    expect(recommendations.map((r) => r.rule)).toEqual(["repairs"]);
    expect(heldBack).toEqual([expect.objectContaining({ id: id("2026-11-28"), rule: "claude" })]);
  });

  it("lowers a mostly dismissed model's findings, and never lifts one past its cap", async () => {
    const memory = new InMemoryStore();
    await memory.appendSignals([signal("s1")]);
    const past: Recommendation[] = [];
    const words: Feedback[] = [];
    for (let i = 0; i < 4; i++) {
      const pid = `rec_claude_old${i}_${ago(30).slice(0, 10)}`;
      past.push(rec(pid, { rule: "claude", createdAt: ago(30) }));
      words.push({ recommendationId: pid, organizationId: ORG, outcome: "rejected", actor: "owner", recordedAt: ago(29) });
    }
    await memory.saveRecommendations(past);
    for (const w of words) await memory.recordFeedback(w);
    const { client } = answering([finding({ confidence: 0.5, cites: ["R1"] })]);
    const { pipeline } = await setup({ memory, model: reasoner(client).reasoner });
    const [, claude] = (await pipeline.reasonWithFeedback(ORG)).recommendations;
    expect(claude).toMatchObject({ rule: "claude", confidence: 0.3, ranking: { baseConfidence: 0.5, factor: 0.6 } });

    // Accepted findings that brought value back raise the rule's factor, but the cap still holds.
    const earned = new InMemoryStore();
    await earned.appendSignals([signal("s1")]);
    const won = `rec_claude_won_${ago(40).slice(0, 10)}`;
    await earned.saveRecommendations([rec(won, { rule: "claude", createdAt: ago(40), impact: { kind: "makes", cents: 100, lowCents: 0, highCents: 200, basis: "b" } })]);
    await earned.recordFeedback({ recommendationId: won, organizationId: ORG, outcome: "accepted", actor: "owner", recordedAt: ago(39) });
    await earned.recordValueResult({ recommendationId: won, organizationId: ORG, kind: "makes", cents: 500, source: "measured", measuredDays: 30, actor: "karatos", recordedAt: ago(5) });
    const { client: sure } = answering([finding({ confidence: 0.9, cites: ["R1"] })]);
    const lifted = (await (await setup({ memory: earned, model: reasoner(sure).reasoner, rule: repairsRule(0.7) })).pipeline.reasonWithFeedback(ORG)).recommendations;
    expect(lifted[1]).toMatchObject({ rule: "claude", confidence: 0.7, ranking: { baseConfidence: 0.7, factor: 1.2 } });
  });

  it("shows the model only what the rules kept after feedback", async () => {
    const memory = new InMemoryStore();
    await memory.appendSignals([signal("s1")]);
    const dismissed = `rec_repairs_late_rp_s1_${ago(1).slice(0, 10)}`;
    await memory.saveRecommendations([rec(dismissed, { createdAt: ago(1) })]);
    await memory.recordFeedback({ recommendationId: dismissed, organizationId: ORG, outcome: "rejected", actor: "owner", recordedAt: ago(1) });
    const { client, sent } = answering([]);
    const { pipeline } = await setup({ memory, model: reasoner(client).reasoner });
    const { recommendations, heldBack } = await pipeline.reasonWithFeedback(ORG);
    expect(recommendations).toEqual([]);
    expect(heldBack).toHaveLength(1);
    expect(sent[0]!.user).toContain('"rules":[]');
  });

  it("keeps findings as the model wrote them with the feedback loop off", async () => {
    const { client } = answering([finding({ confidence: 0.3 })]);
    const { pipeline } = await setup({ model: reasoner(client).reasoner, feedback: false });
    const [, claude] = (await pipeline.reasonWithFeedback(ORG)).recommendations;
    expect(claude).toMatchObject({ rule: "claude", confidence: 0.3 });
    expect(claude!.ranking).toBeUndefined();
  });
});
