import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, integrationStatuses, type IntegrationStatus, type Reasoner } from "@karatos/core";
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

async function start(
  docIds: string[] = ["doc_arch"],
  maxBodyBytes?: number,
  reasoner: Reasoner = echoReasoner,
  integrations?: IntegrationStatus[],
) {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({
    memory,
    normalizers: [],
    extractors: [],
    reasoners: [reasoner],
    documentation: new StaticDocumentationSource(docIds),
  });
  server = createServer(
    createBrainApp({
      pipeline,
      memory,
      organizationId: ORG,
      apiKey: KEY,
      ...(maxBodyBytes ? { maxBodyBytes } : {}),
      ...(integrations ? { integrations } : {}),
    }),
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

  it("accepts only the exact key, whatever its length", async () => {
    const { call } = await start();
    for (const auth of [KEY.slice(0, -1), KEY + "k", KEY.toUpperCase(), ` ${KEY}`, "x".repeat(40), "k".repeat(400), "k".repeat(5_000)]) {
      expect((await call("/v1/recommendations", { auth })).status, auth.length.toString()).toBe(401);
    }
    expect((await call("/v1/recommendations")).status).toBe(200);
  });

  it("marks every response uncacheable, unframeable and not to be sniffed", async () => {
    const { call } = await start();
    for (const res of [await call("/healthz", { auth: false }), await call("/v1/recommendations"), await call("/v1/recommendations", { auth: false }), await call("/nope")]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    }
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
  it("reads the latest signals, by kind when asked, for this instance's organization only", async () => {
    const { memory, call } = await start();
    const signal = (id: string, kind: string, organizationId = ORG) => ({
      id,
      organizationId,
      kind,
      subject: { kind: "bank_account" as const, id },
      value: { currentBalanceCents: 100 },
      confidence: 1,
      derivedFromEventIds: ["evt_1"],
      observedAt: "2026-10-01T12:00:00.000Z",
    });
    await memory.appendSignals([signal("s1", "bank.balance"), signal("s2", "receivable.invoice"), signal("s3", "bank.balance", "other-org"), signal("s4", "sale.line")]);
    const read = async (query: string) => {
      const res = await call(`/v1/signals${query}`);
      return [res.status, ((await res.json()) as { signals?: { id: string }[]; error?: string })] as const;
    };
    expect((await read(""))[1].signals!.map((s) => s.id)).toEqual(["s1", "s2", "s4"]);
    expect((await read("?kind=bank.balance"))[1].signals).toEqual([signal("s1", "bank.balance")]);
    expect((await read("?kind=bank.balance&org=other-org&organizationId=other-org"))[1].signals!.map((s) => s.id)).toEqual(["s1"]);
    expect((await read("?kind=bank.balance,%20receivable.invoice&limit=1"))[1].signals!.map((s) => s.id)).toEqual(["s2"]);
    expect((await read("?limit=-5"))[1].signals!.map((s) => s.id)).toEqual(["s4"]);
    expect((await read("?limit=nope"))[1].signals).toHaveLength(3);
    for (const bad of ["?kind=", "?kind=Bank.Balance", "?kind=a;drop", "?kind=bank.balance,", `?kind=${Array.from({ length: 11 }, (_, i) => `k${i}`).join(",")}`]) {
      expect(await read(bad), bad).toEqual([400, { error: "kind must be up to 10 comma-separated signal kinds, such as bank.balance" }]);
    }
    expect((await call("/v1/signals", { auth: false })).status).toBe(401);
    expect((await call("/v1/signals", { method: "POST", body: "{}" })).status).toBe(405);
  });

  it("caps a signals read at 1,000", async () => {
    const { memory, call } = await start();
    const many = Array.from({ length: 1_005 }, (_, i) => ({ id: `s${i}`, organizationId: ORG, kind: "bank.balance", subject: { kind: "bank_account" as const, id: `a${i}` }, value: 1, confidence: 1, derivedFromEventIds: [], observedAt: "2026-10-01T12:00:00.000Z" }));
    await memory.appendSignals(many);
    const body = (await (await call("/v1/signals?limit=5000")).json()) as { signals: { id: string }[] };
    expect(body.signals).toHaveLength(1_000);
    expect(body.signals[0]!.id).toBe("s5");
    expect(((await (await call("/v1/signals")).json()) as { signals: unknown[] }).signals).toHaveLength(200);
  });

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

  it("finds a recommendation whose id the client encoded, as the console does", async () => {
    // Real ids carry colons, such as rec_compliance_structuring_pos:generic:customer:C-1004_2026-10-29.
    const id = "rec_compliance_x_pos:generic:customer:C 1_2026-10-29";
    const { call, memory } = await start(undefined, undefined, { name: "colon", reason: async (input) => (await echoReasoner.reason(input)).map((r) => ({ ...r, id })) });
    await call("/v1/reason", { method: "POST", body: "{}" });
    const res = await call(`/v1/recommendations/${encodeURIComponent(id)}/feedback`, {
      method: "POST",
      body: JSON.stringify({ outcome: "accepted", actor: "owner" }),
    });
    expect(res.status).toBe(201);
    expect(memory.feedback[0]).toMatchObject({ recommendationId: id, outcome: "accepted" });
    // Left unencoded, the colons still reach the same recommendation.
    expect((await call("/v1/recommendations/rec_compliance_x_pos:generic:customer:C%201_2026-10-29/feedback", { method: "POST", body: JSON.stringify({ outcome: "accepted", actor: "owner" }) })).status).toBe(201);
  });

  it("answers 400, not 500, for an id with a broken escape", async () => {
    const { call } = await start();
    const answers = [
      await call("/v1/recommendations/%E0%A4%A/feedback", { method: "POST", body: "{}" }),
      await call("/v1/entities/repair_ticket/%E0%A4%A"),
    ];
    for (const res of answers) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "the id in the path isn't validly encoded" });
    }
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

describe("Brain API: integrations", () => {
  it("lists catalog integrations with this instance's setup status, behind the API key", async () => {
    const statuses = integrationStatuses({ STRIPE_SECRET_KEY: "stripe-key-value", STRIPE_WEBHOOK_SECRET: "stripe-hook-value", SHOPIFY_SHOP_DOMAIN: "demo.myshopify.com" });
    const { call } = await start(undefined, undefined, undefined, statuses);
    expect((await call("/v1/integrations", { auth: false })).status).toBe(401);
    const response = await call("/v1/integrations");
    expect(response.status).toBe(200);
    const { integrations } = (await response.json()) as { integrations: IntegrationStatus[] };
    expect(integrations).toHaveLength(statuses.length);
    expect(integrations.find((i) => i.id === "stripe")).toMatchObject({ configured: true, missingSettings: [] });
    expect(integrations.find((i) => i.id === "shopify")).toMatchObject({ configured: false, missingSettings: ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"] });
    expect(JSON.stringify(integrations)).not.toMatch(/stripe-key-value|stripe-hook-value|myshopify/);
  });

  it("returns an empty list when the instance wasn't given the catalog", async () => {
    const { call } = await start();
    expect(await (await call("/v1/integrations")).json()).toEqual({ integrations: [] });
  });
});

describe("value ledger API", () => {
  const priced: Reasoner = {
    name: "priced",
    reason: async (context) => {
      const [base] = await echoReasoner.reason(context);
      return [
        { ...base!, id: "rec_priced", impact: { kind: "saves", lowCents: 100, cents: 200, highCents: 300, basis: "test" } },
        { ...base!, id: "rec_plain" },
      ];
    },
  };
  const post = (call: Awaited<ReturnType<typeof start>>["call"], id: string, body: unknown) =>
    call(`/v1/recommendations/${id}/result`, { method: "POST", body: JSON.stringify(body) });

  it("records what a recommendation brought back, taking its kind from the estimate", async () => {
    const { call, memory } = await start(undefined, undefined, priced);
    await call("/v1/reason", { method: "POST" });
    const res = await post(call, "rec_priced", { cents: 450, actor: "owner", note: "Sold the chain" });
    expect(res.status).toBe(201);
    expect(memory.valueResults).toEqual([
      { recommendationId: "rec_priced", organizationId: ORG, kind: "saves", cents: 450, source: "reported", actor: "owner", note: "Sold the chain", recordedAt: expect.any(String) },
    ]);
    expect(Date.parse(memory.valueResults[0]!.recordedAt)).not.toBeNaN();
    expect((await post(call, "rec_priced", { cents: 0, actor: "owner", kind: "saves" })).status).toBe(201);
    expect(memory.valueResults[1]).not.toHaveProperty("note");
  });

  it("needs a kind when there is no estimate, and the estimate's kind when there is", async () => {
    const { call, memory } = await start(undefined, undefined, priced);
    await call("/v1/reason", { method: "POST" });
    const none = await post(call, "rec_plain", { cents: 100, actor: "owner" });
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: string }).error).toContain("say whether the result made, saved or protected money");
    expect((await post(call, "rec_plain", { cents: 100, actor: "owner", kind: "protects" })).status).toBe(201);
    const mismatch = await post(call, "rec_priced", { cents: 100, actor: "owner", kind: "makes" });
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as { error: string }).error).toBe("this recommendation's estimate saves money, so its result must too");
    expect(memory.valueResults.map((r) => r.kind)).toEqual(["protects"]);
  });

  it("turns down a result that isn't whole cents or has no actor, and 404s unknown recommendations", async () => {
    const { call, memory } = await start(undefined, undefined, priced);
    await call("/v1/reason", { method: "POST" });
    for (const body of [{ cents: -1, actor: "o" }, { cents: 1.5, actor: "o" }, { cents: "5", actor: "o" }, { cents: 2 ** 53, actor: "o" }, { cents: 1 }, { cents: 1, actor: "  " }, { cents: 1, actor: "o", kind: "earns" }, { cents: 1, actor: "o", note: "n".repeat(2001) }]) {
      const res = await post(call, "rec_priced", body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid result");
    }
    expect((await post(call, "nope", { cents: 1, actor: "o" })).status).toBe(404);
    expect((await call("/v1/recommendations/rec_priced/result", { method: "POST", body: JSON.stringify({ cents: 1, actor: "o" }), auth: false })).status).toBe(401);
    expect(memory.valueResults).toEqual([]);
  });

  it("reports a period's ledger, defaulting to this month", async () => {
    const { call, memory } = await start(undefined, undefined, priced);
    await call("/v1/reason", { method: "POST" });
    await call("/v1/recommendations/rec_priced/feedback", { method: "POST", body: JSON.stringify({ outcome: "accepted", actor: "owner" }) });
    await post(call, "rec_priced", { cents: 450, actor: "owner" });
    const res = await call("/v1/value?from=2026-10-01&to=2026-11-01");
    expect(res.status).toBe(200);
    const { report } = (await res.json()) as { report: { from: string; to: string; shown: { count: number }; approved: { count: number }; returned: { cents: { saves: number } } } };
    expect(report).toMatchObject({ from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z", shown: { count: 2 }, approved: { count: 1 }, returned: { cents: { saves: 450 } } });
    // The echo reasoner dates its recommendations 2026-10-01, so a later month is empty.
    memory.recommendations.forEach((r) => (r.createdAt = new Date().toISOString()));
    const now = (await (await call("/v1/value")).json()) as { report: { from: string; shown: { count: number } } };
    expect(now.report.shown.count).toBe(2);
    expect(now.report.from).toBe(`${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`);
  });

  it("explains a period it can't report on", async () => {
    const { call } = await start();
    for (const [query, error] of [
      ["from=2026-10-01", "from and to must both be days, such as 2026-10-01 and 2026-11-01"],
      ["to=2026-11-01", "from and to must both be days, such as 2026-10-01 and 2026-11-01"],
      ["from=2026-02-30&to=2026-03-01", "from and to must both be days, such as 2026-10-01 and 2026-11-01"],
      ["from=2026-10-01T00:00&to=2026-11-01", "from and to must both be days, such as 2026-10-01 and 2026-11-01"],
      ["from=2026-11-01&to=2026-11-01", "from must be before to; to is the day after the period"],
      ["from=2026-11-01&to=2026-10-01", "from must be before to; to is the day after the period"],
      ["from=2025-01-01&to=2026-01-03", "a report covers at most 366 days"],
    ] as const) {
      const res = await call(`/v1/value?${query}`);
      expect(res.status, query).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
    expect((await call("/v1/value?from=2024-01-01&to=2025-01-01")).status).toBe(200);
    expect((await call("/v1/value", { auth: false })).status).toBe(401);
  });
});
