import { describe, expect, it } from "vitest";
import { CLAUDE_FINDINGS_SCHEMA, CLAUDE_REASONER_MODEL, ClaudeReasoner, InMemoryStore, type ClaudeClient, type Signal } from "@karatos/core";
import { anthropicClaudeClient, CLAUDE_FALLBACK_BETA, createInstancePipeline, instanceClaudeReasoner, loadInstanceConfig, StaticDocumentationSource } from "../src/index.js";

const ORG = "example-jewelers";
const NOW = "2026-11-28T12:00:00.000Z";
// A placeholder, never a real key: every request below goes to a fake fetch, never the API.
const PLACEHOLDER_KEY = "placeholder-not-a-key";

const valid = {
  INSTANCE_NAME: "Example Jewelers",
  ORGANIZATION_ID: ORG,
  INSTANCE_API_KEY: "a".repeat(64),
  SUPABASE_DB_URL: "postgresql://user:pass@db.example.test:5432/postgres",
};

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

/** A fetch that answers like the Messages API, and keeps what it was sent. */
function fakeApi(reply: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)), signal: init?.signal });
    const message = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: CLAUDE_REASONER_MODEL,
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: '{"findings":' },
        { type: "text", text: '[{"topic":"stuck stage","summary":"Casting is slow.","expectedImpact":"","confidence":0.4,"cites":["S1"]}]}' },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 800, cache_creation_input_tokens: null },
      ...reply,
    };
    return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const signal = (over: Partial<Signal> = {}): Signal => ({
  id: "sig_1",
  organizationId: ORG,
  kind: "bench.stage_slow",
  subject: { kind: "customer", id: "cref_9f2c1a" },
  value: { stage: "casting", days: 9, customerName: "Jane Doe", email: "jane@example.test", phone: "555-0142" },
  confidence: 1,
  derivedFromEventIds: ["evt_1"],
  observedAt: NOW,
  ...over,
});

describe("the Anthropic client", () => {
  it("asks for JSON in the findings schema, with no tools, and maps the answer", async () => {
    const api = fakeApi();
    const client = anthropicClaudeClient({ apiKey: PLACEHOLDER_KEY, fetch: api.fetch });
    const controller = new AbortController();
    const answer = await client(
      { model: CLAUDE_REASONER_MODEL, system: "the instructions", user: "the summary", maxOutputTokens: 4000, schema: CLAUDE_FINDINGS_SCHEMA, timeoutMs: 5000 },
      { signal: controller.signal },
    );
    expect(api.sent).toHaveLength(1);
    const [request] = api.sent;
    expect(request!.url).toMatch(/\/v1\/messages$/);
    expect(request!.headers.get("anthropic-beta")).toContain(CLAUDE_FALLBACK_BETA);
    expect(request!.body).toEqual({
      model: CLAUDE_REASONER_MODEL,
      max_tokens: 4000,
      fallbacks: "default",
      system: [{ type: "text", text: "the instructions", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "the summary" }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: CLAUDE_FINDINGS_SCHEMA } },
    });
    expect(request!.body).not.toHaveProperty("tools");
    expect(request!.signal).toBeTruthy();
    expect(answer).toEqual({
      text: '{"findings":[{"topic":"stuck stage","summary":"Casting is slow.","expectedImpact":"","confidence":0.4,"cites":["S1"]}]}',
      stopReason: "end_turn",
      model: CLAUDE_REASONER_MODEL,
      usage: { inputTokens: 900, outputTokens: 120, cacheReadInputTokens: 800, cacheCreationInputTokens: 0 },
    });

    const bare = fakeApi({ usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: null, cache_creation_input_tokens: 7 } });
    const counts = await anthropicClaudeClient({ apiKey: PLACEHOLDER_KEY, fetch: bare.fetch })(
      { model: CLAUDE_REASONER_MODEL, system: "s", user: "u", maxOutputTokens: 10, schema: {}, timeoutMs: 1000 },
      { signal: controller.signal },
    );
    expect(counts.usage).toEqual({ inputTokens: 5, outputTokens: 6, cacheReadInputTokens: 0, cacheCreationInputTokens: 7 });

    // The reasoner's abort reaches the request.
    const stop = new AbortController();
    stop.abort();
    const aborted = fakeApi();
    await expect(
      anthropicClaudeClient({ apiKey: PLACEHOLDER_KEY, fetch: aborted.fetch, maxRetries: 0 })({ model: CLAUDE_REASONER_MODEL, system: "s", user: "u", maxOutputTokens: 10, schema: {}, timeoutMs: 1000 }, { signal: stop.signal }),
    ).rejects.toThrow();
  });

  it("sends only the redacted summary over the wire", async () => {
    const api = fakeApi();
    const reasoner = new ClaudeReasoner({ client: anthropicClaudeClient({ apiKey: PLACEHOLDER_KEY, fetch: api.fetch }), log: () => {} });
    const { findings, record } = await reasoner.review({ organizationId: ORG, now: NOW, signals: [signal()], recommendations: [], documentation: { documentIds: [], stale: false } });
    const wire = JSON.stringify(api.sent[0]!.body);
    for (const leak of ["Jane", "example.test", "555-0142", "customerName", "email", "phone", ORG]) expect(wire).not.toContain(leak);
    expect(wire).toContain("cref_9f2c1a");
    expect(findings.map((f) => f.recommendation.provenance.signalIds)).toEqual([["sig_1"]]);
    expect(record).toMatchObject({ status: "succeeded", model: CLAUDE_REASONER_MODEL, usage: { inputTokens: 900, outputTokens: 120 } });
  });

  it("fails the pass, not the run, when the API errors", async () => {
    const failing = (async () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }), { status: 400, headers: { "content-type": "application/json" } })) as typeof fetch;
    const reasoner = new ClaudeReasoner({ client: anthropicClaudeClient({ apiKey: PLACEHOLDER_KEY, fetch: failing, maxRetries: 0 }), log: () => {} });
    const { record } = await reasoner.review({ organizationId: ORG, now: NOW, signals: [signal()], recommendations: [], documentation: { documentIds: [], stale: false } });
    expect(record).toMatchObject({ status: "failed", reason: "error:BadRequestError" });
  });
});

describe("the Claude reasoner settings", () => {
  it("are off by default, with a safe token cap and time-out", () => {
    expect(loadInstanceConfig(valid)).toMatchObject({ CLAUDE_REASONER: false, CLAUDE_REASONER_MAX_TOKENS: 40_000, CLAUDE_REASONER_TIMEOUT_SECONDS: 90 });
    expect(loadInstanceConfig({ ...valid, CLAUDE_REASONER: "on", CLAUDE_REASONER_MAX_TOKENS: "8000", CLAUDE_REASONER_TIMEOUT_SECONDS: "5" })).toMatchObject({
      CLAUDE_REASONER: true,
      CLAUDE_REASONER_MAX_TOKENS: 8000,
      CLAUDE_REASONER_TIMEOUT_SECONDS: 5,
    });
    for (const bad of [{ CLAUDE_REASONER: "yes" }, { CLAUDE_REASONER_MAX_TOKENS: "7999" }, { CLAUDE_REASONER_MAX_TOKENS: "200001" }, { CLAUDE_REASONER_TIMEOUT_SECONDS: "4" }, { CLAUDE_REASONER_TIMEOUT_SECONDS: "301" }]) {
      expect(() => loadInstanceConfig({ ...valid, ...bad }), JSON.stringify(bad)).toThrow(new RegExp(Object.keys(bad)[0]!));
    }
  });

  it("runs only with CLAUDE_REASONER on and a key set, and never names the key", async () => {
    const made: string[] = [];
    const makeClient = (key: string): ClaudeClient => {
      made.push(key);
      return async () => ({ text: "{}", stopReason: "end_turn", model: "m", usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
    };
    const settings = (on: boolean) => ({ CLAUDE_REASONER: on, CLAUDE_REASONER_MAX_TOKENS: 12_000, CLAUDE_REASONER_TIMEOUT_SECONDS: 30 });

    const off = instanceClaudeReasoner(settings(false), { ANTHROPIC_API_KEY: PLACEHOLDER_KEY }, { makeClient });
    expect(off).toEqual({ reasoner: null, status: "claude reasoner off (CLAUDE_REASONER is not on)" });
    for (const key of [undefined, "", "  "]) {
      const keyless = instanceClaudeReasoner(settings(true), { ANTHROPIC_API_KEY: key }, { makeClient });
      expect(keyless).toEqual({ reasoner: null, status: "claude reasoner off: CLAUDE_REASONER is on but ANTHROPIC_API_KEY is not set" });
    }
    expect(made).toEqual([]);

    const on = instanceClaudeReasoner(settings(true), { ANTHROPIC_API_KEY: ` ${PLACEHOLDER_KEY} ` }, { makeClient, log: () => {} });
    expect(on.reasoner).toBeInstanceOf(ClaudeReasoner);
    expect(on.status).toBe("claude reasoner on: up to 12000 tokens a run, 30s time-out");
    expect(on.status).not.toContain(PLACEHOLDER_KEY);
    expect(made).toEqual([PLACEHOLDER_KEY]);
    expect((await on.reasoner!.review({ organizationId: ORG, now: NOW, signals: [], recommendations: [], documentation: { documentIds: [], stale: false } })).record.tokenCap).toBe(12_000);
    expect(on.reasoner!.prepare({ organizationId: ORG, now: NOW, signals: [], recommendations: [], documentation: { documentIds: [], stale: false } })!.request).toMatchObject({ timeoutMs: 30_000 });
  });

  it("builds the SDK client by default", () => {
    const { reasoner } = instanceClaudeReasoner({ CLAUDE_REASONER: true, CLAUDE_REASONER_MAX_TOKENS: 40_000, CLAUDE_REASONER_TIMEOUT_SECONDS: 90 }, { ANTHROPIC_API_KEY: PLACEHOLDER_KEY });
    expect(reasoner).toBeInstanceOf(ClaudeReasoner);
  });

  it("joins the instance pipeline after the departments", async () => {
    const memory = new InMemoryStore();
    const client: ClaudeClient = async () => ({ text: '{"findings":[]}', stopReason: "end_turn", model: CLAUDE_REASONER_MODEL, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
    const pipeline = createInstancePipeline({ memory, documentation: new StaticDocumentationSource([]), departments: ["repairs"], modelReasoner: new ClaudeReasoner({ client, log: () => {} }) });
    const { modelReasoning } = await pipeline.reasonWithFeedback(ORG);
    expect(modelReasoning).toMatchObject({ status: "succeeded", reasoner: "claude" });
    expect((await memory.latestReasoningRun(ORG))!.reasoners.at(-1)).toBe("claude");
    const rulesOnly = createInstancePipeline({ memory, documentation: new StaticDocumentationSource([]), departments: ["repairs"], modelReasoner: null });
    expect((await rulesOnly.reasonWithFeedback(ORG)).modelReasoning).toBeUndefined();
  });
});
