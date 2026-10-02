import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, type Reasoner } from "@karatos/core";
import { createBrainApp, StaticDocumentationSource } from "../src/index.js";

const ORG = "fuse-jewelry";
const KEY = "k".repeat(40);

const event = {
  id: "evt_1",
  source: "manual",
  type: "order.created",
  occurredAt: "2026-10-01T12:00:00Z",
  receivedAt: "2026-10-01T12:00:01Z",
  idempotencyKey: "order-1001",
  payload: { orderId: "1001" },
};

const echoReasoner: Reasoner = {
  name: "echo",
  reason: ({ organizationId }) => [
    {
      id: "rec_1",
      organizationId,
      summary: "Check in with the customer",
      confidence: 0.5,
      expectedImpact: "Retention",
      provenance: { eventIds: [], signalIds: [], documentIds: [] },
      degraded: false,
      createdAt: "2026-10-01T12:00:02Z",
    },
  ],
};

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function start(docIds: string[] = ["doc_arch"], maxBodyBytes?: number, reasoner: Reasoner = echoReasoner) {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({
    memory,
    normalizers: [],
    extractors: [],
    reasoners: [reasoner],
    documentation: new StaticDocumentationSource(docIds),
  });
  server = createServer(
    createBrainApp({ pipeline, memory, organizationId: ORG, apiKey: KEY, ...(maxBodyBytes ? { maxBodyBytes } : {}) }),
  );
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit & { auth?: string | false } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.auth !== false) headers.authorization = `Bearer ${init.auth ?? KEY}`;
    return fetch(base + path, { ...init, headers });
  };
  return { memory, call };
}

describe("Brain API", () => {
  it("reports health without authentication", async () => {
    const { call } = await start();
    const res = await call("/healthz", { auth: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects requests without the instance API key", async () => {
    const { call, memory } = await start();
    expect((await call("/v1/events", { method: "POST", body: JSON.stringify(event), auth: false })).status).toBe(401);
    expect((await call("/v1/events", { method: "POST", body: JSON.stringify(event), auth: "wrong" })).status).toBe(401);
    expect(memory.events).toHaveLength(0);
  });

  it("stamps events with the instance organization", async () => {
    const { call, memory } = await start();
    const res = await call("/v1/events", { method: "POST", body: JSON.stringify(event) });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: "evt_1", duplicate: false, entities: 0, signals: 0 });
    expect(memory.events[0]?.organizationId).toBe(ORG);
  });

  it("refuses events addressed to another client", async () => {
    const { call, memory } = await start();
    const res = await call("/v1/events", {
      method: "POST",
      body: JSON.stringify({ ...event, organizationId: "other-jeweler" }),
    });
    expect(res.status).toBe(403);
    expect(memory.events).toHaveLength(0);
  });

  it("reports replays as duplicates", async () => {
    const { call } = await start();
    await call("/v1/events", { method: "POST", body: JSON.stringify(event) });
    const res = await call("/v1/events", { method: "POST", body: JSON.stringify({ ...event, id: "evt_2" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });
  });

  it("explains invalid events", async () => {
    const { call } = await start();
    const res = await call("/v1/events", { method: "POST", body: JSON.stringify({ ...event, type: "Bad Type" }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: { path: string }[] };
    expect(body.error).toBe("invalid event");
    expect(body.details.map((d) => d.path)).toContain("type");
  });

  it("rejects malformed and oversized bodies", async () => {
    const { call } = await start(["doc_arch"], 100);
    expect((await call("/v1/events", { method: "POST", body: "{not json" })).status).toBe(400);
    expect((await call("/v1/events", { method: "POST", body: "[]" })).status).toBe(400);
    expect((await call("/v1/events", { method: "POST", body: JSON.stringify(event) })).status).toBe(413);
  });

  it("returns 404 and 405 for unknown routes and methods", async () => {
    const { call } = await start();
    expect((await call("/v1/nope", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await call("/v1/events", { method: "GET" })).status).toBe(405);
  });

  it("returns recommendations scoped to the instance", async () => {
    const { call } = await start();
    const res = await call("/v1/reason", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const { recommendations } = (await res.json()) as { recommendations: { organizationId: string; degraded: boolean }[] };
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({ organizationId: ORG, degraded: false });
  });

  it("marks reasoning degraded when no documentation is registered", async () => {
    const { call } = await start([]);
    const res = await call("/v1/reason", { method: "POST", body: "{}" });
    const { recommendations } = (await res.json()) as { recommendations: { degraded: boolean }[] };
    expect(recommendations[0]?.degraded).toBe(true);
  });

  it("hides internal errors from callers", async () => {
    const failing: Reasoner = {
      name: "broken",
      reason: () => {
        throw new Error("database password is hunter2");
      },
    };
    const { call } = await start(["doc_arch"], undefined, failing);
    const original = console.error;
    console.error = () => {};
    try {
      const res = await call("/v1/reason", { method: "POST", body: "{}" });
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("hunter2");
    } finally {
      console.error = original;
    }
  });
});

describe("Brain API: memory endpoints", () => {
  it("lists recommendations and records feedback on them", async () => {
    const { call, memory } = await start();
    await call("/v1/reason", { method: "POST", body: "{}" });

    const list = await call("/v1/recommendations?limit=5");
    expect(list.status).toBe(200);
    const { recommendations } = (await list.json()) as { recommendations: { id: string }[] };
    expect(recommendations.map((r) => r.id)).toEqual(["rec_1"]);

    const ok = await call("/v1/recommendations/rec_1/feedback", {
      method: "POST",
      body: JSON.stringify({ outcome: "overridden", actor: "owner", note: "Already called them" }),
    });
    expect(ok.status).toBe(201);
    expect(memory.feedback[0]).toMatchObject({ recommendationId: "rec_1", organizationId: ORG, outcome: "overridden" });
  });

  it("validates feedback and 404s unknown recommendations", async () => {
    const { call } = await start();
    await call("/v1/reason", { method: "POST", body: "{}" });
    expect((await call("/v1/recommendations/nope/feedback", { method: "POST", body: "{}" })).status).toBe(404);
    const bad = await call("/v1/recommendations/rec_1/feedback", { method: "POST", body: JSON.stringify({ outcome: "maybe" }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { details: { path: string }[] }).details.map((d) => d.path)).toEqual(["outcome", "actor"]);
  });

  it("returns entities by kind and id", async () => {
    const { call, memory } = await start();
    await memory.upsertEntities([
      {
        ref: { kind: "repair_ticket", id: "R 1" },
        organizationId: ORG,
        attributes: {},
        sourceEventIds: [],
        updatedAt: "2026-10-01T00:00:00Z",
      },
    ]);
    expect((await call("/v1/entities/repair_ticket/R%201")).status).toBe(200);
    expect((await call("/v1/entities/repair_ticket/missing")).status).toBe(404);
  });

  it("returns the dead-letter id for invalid events", async () => {
    const { call, memory } = await start();
    const res = await call("/v1/events", { method: "POST", body: JSON.stringify({ type: "Bad" }) });
    const body = (await res.json()) as { deadLetterId: string };
    expect(body.deadLetterId).toBe(memory.deadLetters[0]?.id);
  });
});
