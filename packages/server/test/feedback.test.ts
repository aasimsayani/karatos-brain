import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BrainPipeline, DEFAULT_FEEDBACK_POLICY, InMemoryStore, type FeedbackPolicy, type Reasoner } from "@karatos/core";
import { createBrainApp, createInstancePipeline, loadInstanceConfig, StaticDocumentationSource } from "../src/index.js";

const ORG = "example-jewelers";
const KEY = "k".repeat(40);

const reasoner: Reasoner = {
  name: "clienteling.lapsed-vip",
  reason: ({ organizationId, now }) => [
    {
      id: `rec_clienteling_lapsed_c1_${now.slice(0, 10)}`,
      organizationId,
      summary: "Invite them in",
      confidence: 0.65,
      expectedImpact: "Win back",
      provenance: { eventIds: [], signalIds: [], documentIds: [] },
      degraded: false,
      createdAt: now,
    },
  ],
};

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function start(feedback?: Partial<FeedbackPolicy> | false) {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({
    memory,
    normalizers: [],
    extractors: [],
    reasoners: [reasoner],
    documentation: new StaticDocumentationSource([]),
    ...(feedback !== undefined ? { feedback } : {}),
  });
  server = createServer(createBrainApp({ pipeline, memory, organizationId: ORG, apiKey: KEY }));
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { memory, call };
}

describe("the feedback loop over HTTP", () => {
  it("holds back what the owner just dismissed on the next POST /v1/reason, and says why", async () => {
    const { call } = await start();
    const first = await call("POST", "/v1/reason", {});
    expect(first.body.heldBack).toEqual([]);
    const [rec] = first.body.recommendations;
    expect(rec).toMatchObject({ rule: "clienteling.lapsed-vip", confidence: 0.65, ranking: { baseConfidence: 0.65, factor: 1 } });
    expect((await call("POST", `/v1/recommendations/${rec.id}/feedback`, { outcome: "rejected", actor: "owner" })).status).toBe(201);

    const second = await call("POST", "/v1/reason", {});
    expect(second.status).toBe(200);
    expect(second.body.recommendations).toEqual([]);
    expect(second.body.heldBack).toEqual([{ id: rec.id, rule: "clienteling.lapsed-vip", dismissedAt: expect.any(String), until: expect.any(String) }]);
    const { dismissedAt, until } = second.body.heldBack[0];
    expect(Date.parse(until) - Date.parse(dismissedAt)).toBe(14 * 86_400_000);
  });

  it("summarises each rule at GET /v1/feedback", async () => {
    const { call } = await start({ cooldownDays: 7 });
    const empty = await call("GET", "/v1/feedback");
    expect(empty.status).toBe(200);
    expect(empty.body.feedback).toEqual({ organizationId: ORG, asOf: expect.any(String), cooldownDays: 7, lookbackDays: 180, rules: [], on: true });

    const [rec] = (await call("POST", "/v1/reason", {})).body.recommendations;
    await call("POST", `/v1/recommendations/${rec.id}/feedback`, { outcome: "rejected", actor: "owner" });
    const { body } = await call("GET", "/v1/feedback");
    expect(body.feedback.rules).toEqual([
      {
        rule: "clienteling.lapsed-vip",
        shown: 1,
        accepted: 0,
        dismissed: 1,
        overridden: 0,
        returned: { count: 0, cents: 0, estimatedCents: 0 },
        coolingDown: 1,
        factor: 1,
        note: "Only 1 of 3 decisions needed on this rule in the last 180 days, so dismissals don't count yet.",
      },
    ]);
  });

  it("says when the loop is off, and still shows the history by the default policy", async () => {
    const { call } = await start(false);
    const [rec] = (await call("POST", "/v1/reason", {})).body.recommendations;
    expect(rec).not.toHaveProperty("ranking");
    await call("POST", `/v1/recommendations/${rec.id}/feedback`, { outcome: "rejected", actor: "owner" });
    expect((await call("POST", "/v1/reason", {})).body.heldBack).toEqual([]);
    const { body } = await call("GET", "/v1/feedback");
    expect(body.feedback).toMatchObject({ on: false, cooldownDays: DEFAULT_FEEDBACK_POLICY.cooldownDays, rules: [{ rule: "clienteling.lapsed-vip", shown: 1, dismissed: 1 }] });
  });
});

describe("FEEDBACK_COOLDOWN_DAYS", () => {
  const valid = {
    INSTANCE_NAME: "Example Jewelers",
    ORGANIZATION_ID: ORG,
    INSTANCE_API_KEY: "a".repeat(64),
    SUPABASE_DB_URL: "postgresql://user:pass@db.example.test:5432/postgres",
  };

  it("defaults to 14 and takes 0 to 90 whole days", () => {
    expect(loadInstanceConfig(valid).FEEDBACK_COOLDOWN_DAYS).toBe(14);
    expect(loadInstanceConfig({ ...valid, FEEDBACK_COOLDOWN_DAYS: "0" }).FEEDBACK_COOLDOWN_DAYS).toBe(0);
    expect(loadInstanceConfig({ ...valid, FEEDBACK_COOLDOWN_DAYS: "90" }).FEEDBACK_COOLDOWN_DAYS).toBe(90);
    for (const bad of ["91", "-1", "1.5", "soon"]) expect(() => loadInstanceConfig({ ...valid, FEEDBACK_COOLDOWN_DAYS: bad })).toThrow(/FEEDBACK_COOLDOWN_DAYS/);
  });

  it("reaches the instance's pipeline", () => {
    const build = (feedbackCooldownDays?: number) =>
      createInstancePipeline({ memory: new InMemoryStore(), documentation: new StaticDocumentationSource([]), departments: [], ...(feedbackCooldownDays !== undefined ? { feedbackCooldownDays } : {}) });
    expect(build(3).feedbackPolicy).toEqual({ ...DEFAULT_FEEDBACK_POLICY, cooldownDays: 3 });
    expect(build(0).feedbackPolicy!.cooldownDays).toBe(0);
    expect(build().feedbackPolicy).toEqual(DEFAULT_FEEDBACK_POLICY);
  });
});
