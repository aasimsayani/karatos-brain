import { describe, expect, it } from "vitest";
import { BrainPipeline, readFeedbackSummary, type Reasoner, type Recommendation } from "@karatos/core";
import { PostgresMemoryStore } from "../src/index.js";
import { freshDatabase } from "./helpers.js";

const ORG = "org_a";
const DAY = 86_400_000;
const NOW = "2026-11-26T12:00:00.000Z";
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();

const rule = (name: string, subjects: string[], confidence = 0.8): Reasoner => ({
  name,
  reason: ({ organizationId, now }) =>
    subjects.map(
      (s): Recommendation => ({
        id: `rec_${name}_${s}_${now.slice(0, 10)}`,
        organizationId,
        summary: `${name} ${s}`,
        confidence,
        expectedImpact: "",
        provenance: { eventIds: [], signalIds: [], documentIds: [] },
        degraded: false,
        createdAt: now,
      }),
    ),
});

function pipeline(memory: PostgresMemoryStore, reasoners: Reasoner[], now: string) {
  return new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners, documentation: { current: () => ({ documentIds: [], stale: false }) }, now: () => new Date(now) });
}

async function setup() {
  const { client } = await freshDatabase();
  await client.query("insert into organizations (id, name) values ($1, $1)", [ORG]);
  return client;
}

describe("the feedback loop on Postgres", () => {
  it("stores each recommendation's rule and ranking and reads them back", async () => {
    const client = await setup();
    const store = new PostgresMemoryStore(client);
    const [saved] = await pipeline(store, [rule("a", ["s1"])], NOW).reason(ORG);
    expect(saved).toMatchObject({ rule: "a", ranking: { baseConfidence: 0.8, factor: 1 } });
    expect(await store.getRecommendation(ORG, saved!.id)).toEqual(saved);
    expect(await store.listRecommendations(ORG, 10)).toEqual([saved]);
    expect(await store.recommendationsBetween(ORG, ago(1), new Date(Date.parse(NOW) + 1).toISOString())).toEqual([saved]);
  });

  it("reads a recommendation stored before the loop with neither", async () => {
    const client = await setup();
    await client.query(
      `insert into recommendations (id, organization_id, summary, confidence, expected_impact, provenance, degraded, created_at)
       values ('rec_old_1', $1, 'old', 0.5, '', '{"eventIds":[],"signalIds":[],"documentIds":[]}', false, $2)`,
      [ORG, ago(3)],
    );
    const old = await new PostgresMemoryStore(client).getRecommendation(ORG, "rec_old_1");
    expect(old).not.toHaveProperty("rule");
    expect(old).not.toHaveProperty("ranking");
  });

  it("keeps holding back a dismissed subject after a restart, and lowers a rule the store keeps dismissing", async () => {
    const client = await setup();
    const reasoners = [rule("a", ["s1", "s2", "s3"]), rule("b", ["s1"])];
    const before = new PostgresMemoryStore(client);
    const first = await pipeline(before, reasoners, ago(2)).reason(ORG);
    for (const r of first.filter((r) => r.rule === "a")) {
      await before.recordFeedback({ recommendationId: r.id, organizationId: ORG, outcome: "rejected", actor: "owner", recordedAt: ago(2) });
    }

    // A new store over the same database: nothing is kept in the process.
    const after = new PostgresMemoryStore(client);
    const run = await pipeline(after, reasoners, NOW).reasonWithFeedback(ORG);
    expect(run.heldBack.map((h) => h.id)).toEqual(["rec_a_s1_2026-11-26", "rec_a_s2_2026-11-26", "rec_a_s3_2026-11-26"]);
    expect(run.recommendations.map((r) => r.id)).toEqual(["rec_b_s1_2026-11-26"]);

    // Past the cooldown, rule a comes back, ranked below b.
    const later = new Date(Date.parse(NOW) + 13 * DAY).toISOString();
    const back = await pipeline(new PostgresMemoryStore(client), reasoners, later).reason(ORG);
    expect(back.map((r) => [r.rule, r.confidence])).toEqual([
      ["b", 0.8],
      ["a", 0.48],
      ["a", 0.48],
      ["a", 0.48],
    ]);
    expect((await new PostgresMemoryStore(client).getRecommendation(ORG, back[1]!.id))!.ranking).toEqual(back[1]!.ranking);

    const summary = await readFeedbackSummary(new PostgresMemoryStore(client), ORG, later);
    expect(summary.rules.map((r) => [r.rule, r.shown, r.dismissed, r.coolingDown, r.factor])).toEqual([
      ["a", 6, 3, 0, 0.6],
      ["b", 3, 0, 0, 1],
    ]);
  });

  it("raises a rule whose accepted recommendation brought back measured value, after a restart", async () => {
    const client = await setup();
    const reasoners = [rule("a", ["s1"]), rule("b", ["s1"])];
    const store = new PostgresMemoryStore(client);
    const first = await pipeline(store, reasoners, ago(40)).reason(ORG);
    const b = first.find((r) => r.rule === "b")!;
    await store.recordFeedback({ recommendationId: b.id, organizationId: ORG, outcome: "accepted", actor: "owner", recordedAt: ago(39) });
    await store.recordValueResult({ recommendationId: b.id, organizationId: ORG, kind: "makes", cents: 2_500, source: "measured", measuredDays: 30, actor: "karatos", recordedAt: ago(10) });
    const next = await pipeline(new PostgresMemoryStore(client), reasoners, NOW).reason(ORG);
    expect(next.map((r) => [r.rule, r.confidence])).toEqual([
      ["b", 0.88],
      ["a", 0.8],
    ]);
    expect(next[0]!.ranking!.note).toContain("1 accepted recommendation brought back $25.00, so it ranks higher.");
  });
});
