import { describe, expect, it } from "vitest";
import { BrainPipeline, ClaudeReasoner, type ClaudeClient, type Reasoner } from "@karatos/core";
import { PostgresMemoryStore } from "../src/index.js";
import { freshDatabase } from "./helpers.js";

const ORG = "org_a";
const NOW = "2026-11-28T12:00:00.000Z";

const rule: Reasoner = {
  name: "repairs",
  reason: ({ organizationId, signals, now }) =>
    signals.map((s) => ({
      id: `rec_repairs_late_${s.subject.id}_${now.slice(0, 10)}`,
      organizationId,
      summary: "late",
      confidence: 0.8,
      expectedImpact: "",
      provenance: { eventIds: s.derivedFromEventIds, signalIds: [s.id], documentIds: [] },
      degraded: false,
      createdAt: now,
    })),
};

// A mocked client: these tests never reach the API.
const answering =
  (text: string): ClaudeClient =>
  async () => ({ text, stopReason: "end_turn", model: "claude-opus-5-5", usage: { inputTokens: 700, outputTokens: 90, cacheReadInputTokens: 600, cacheCreationInputTokens: 0 } });

async function setup() {
  const { client } = await freshDatabase();
  await client.query("insert into organizations (id, name) values ($1, $1)", [ORG]);
  const store = new PostgresMemoryStore(client);
  await store.appendSignals([
    { id: "sig_1", organizationId: ORG, kind: "repair.late", subject: { kind: "repair", id: "rp1" }, value: 3, confidence: 1, derivedFromEventIds: [], observedAt: NOW },
  ]);
  return { client, store };
}

function pipeline(store: PostgresMemoryStore, client?: ClaudeClient) {
  return new BrainPipeline({
    memory: store,
    normalizers: [],
    extractors: [],
    reasoners: [rule],
    documentation: { current: () => ({ documentIds: [], stale: false }) },
    now: () => new Date(NOW),
    ...(client ? { modelReasoner: new ClaudeReasoner({ client, log: () => {} }) } : {}),
  });
}

describe("the model reasoner on Postgres", () => {
  it("stores the model, prompt version and token usage on the run, and the finding's provenance", async () => {
    const { store } = await setup();
    const text = JSON.stringify({ findings: [{ topic: "repair backlog", summary: "Repairs are late.", expectedImpact: "", confidence: 0.4, cites: ["S1", "R1"] }] });
    const { recommendations, modelReasoning } = await pipeline(store, answering(text)).reasonWithFeedback(ORG);
    const run = await store.latestReasoningRun(ORG);
    expect(run!.modelReasoning).toEqual(modelReasoning);
    expect(run!.modelReasoning).toMatchObject({ model: "claude-opus-5-5", promptVersion: "claude-reasoner-v1", usage: { inputTokens: 700, outputTokens: 90 }, status: "succeeded", findings: 1 });
    expect(run!.reasoners).toEqual(["repairs", "claude"]);
    const stored = await store.getRecommendation(ORG, recommendations[1]!.id);
    expect(stored).toEqual(recommendations[1]);
    expect(stored!.provenance.recommendationIds).toEqual(["rec_repairs_late_rp1_2026-11-28"]);
  });

  it("stores a failed pass, and no record for a run without a model", async () => {
    const { store } = await setup();
    await pipeline(store, answering("not json")).reasonWithFeedback(ORG);
    expect((await store.latestReasoningRun(ORG))!.modelReasoning).toMatchObject({ status: "failed", reason: "malformed_output" });

    const plain = await setup();
    await pipeline(plain.store).reasonWithFeedback(ORG);
    const run = await plain.store.latestReasoningRun(ORG);
    expect(run).not.toHaveProperty("modelReasoning");
    const { rows } = await plain.client.query<{ model_reasoning: unknown }>("select model_reasoning from reasoning_runs");
    expect(rows).toEqual([{ model_reasoning: null }]);
  });
});
