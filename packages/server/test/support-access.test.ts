import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, type IntegrationStatus, type Reasoner } from "@karatos/core";
import {
  brainRoutes,
  createBrainApp,
  inMemoryDiagnostics,
  StaticDocumentationSource,
  SUPPORT_KEY_REFUSAL,
  type BrainAppOptions,
  type SupportStatusOptions,
  type SyncStatus,
} from "../src/index.js";

const ORG = "example-jewelers";
// Built at runtime so no key-shaped literal sits in the repository. The letter prefix keeps an upper-cased copy different.
const newKey = (prefix: string) => `${prefix}${randomBytes(32).toString("hex")}`;
const INSTANCE_KEY = newKey("i");
const SUPPORT_KEY = newKey("s");

/** The only routes the support key may reach, besides /healthz. */
const SUPPORT_ROUTES = ["GET /v1/integrations", "GET /v1/support/status"];

const NOW = new Date("2026-11-12T15:30:00Z");
const STARTED = new Date("2026-11-12T13:00:00Z");

const reasoner: Reasoner = {
  name: "never-runs",
  reason: () => {
    throw new Error("reasoning must not run for the support key");
  },
};

const integrations: IntegrationStatus[] = [
  { id: "shopify", name: "Shopify", domain: "ecommerce", departments: ["sales"], access: "public_api", catalogStatus: "built", configured: false, missingSettings: ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_ADMIN_ACCESS_TOKEN"] },
  { id: "stripe", name: "Stripe", domain: "financial", departments: ["finance"], access: "public_api", catalogStatus: "built", configured: true, missingSettings: [] },
  { id: "gia", name: "GIA", domain: "inventory", departments: ["inventory"], access: "public_api", catalogStatus: "built", configured: true, missingSettings: [] },
] as IntegrationStatus[];

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

type Omitted = "supportApiKey" | "support";

function appOptions(memory: InMemoryStore, overrides: Partial<BrainAppOptions> = {}, syncStatus: SyncStatus[] = [], omit: Omitted[] = []): BrainAppOptions {
  const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [reasoner], documentation: new StaticDocumentationSource(["doc_arch"]) });
  const support: SupportStatusOptions = {
    instanceName: "Example Jewelers",
    version: "0.1.0",
    startedAt: STARTED,
    retentionDays: 30,
    departments: ["sales", "inventory"],
    enabledIntegrations: ["stripe", "shopify"],
    skipped: [{ id: "shopify", reason: "missing SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN" }],
    syncStatus: () => syncStatus,
    diagnostics: inMemoryDiagnostics(memory, ["0001_core_schema.sql", "0002_ingestion.sql"]),
    now: () => NOW,
  };
  const options: BrainAppOptions = { pipeline, memory, organizationId: ORG, apiKey: INSTANCE_KEY, supportApiKey: SUPPORT_KEY, integrations, support, ...overrides };
  for (const name of omit) delete options[name];
  return options;
}

async function start(overrides: Partial<BrainAppOptions> = {}, syncStatus: SyncStatus[] = [], omit: Omitted[] = []) {
  const memory = new InMemoryStore();
  server = createServer(createBrainApp(appOptions(memory, overrides, syncStatus, omit)));
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit & { auth?: string | false } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.auth !== false) headers.authorization = `Bearer ${init.auth ?? INSTANCE_KEY}`;
    return fetch(base + path, { ...init, headers });
  };
  return { memory, call };
}

/** A concrete path for a route's pattern: each captured segment becomes "abc". */
function samplePath(pattern: RegExp): string {
  const path = pattern.source.replace(/^\^/, "").replace(/\$$/, "").replace(/\([^)]*\)/g, "abc").replace(/\\\//g, "/");
  expect(pattern.test(path), `sample for ${pattern.source}`).toBe(true);
  return path;
}

const table = () => brainRoutes(appOptions(new InMemoryStore())).map((r) => ({ name: `${r.method} ${samplePath(r.pattern)}`, method: r.method, path: samplePath(r.pattern), access: r.access }));

const validEvent = {
  id: "evt_1",
  source: "manual",
  type: "order.created",
  occurredAt: "2026-11-12T12:00:00Z",
  receivedAt: "2026-11-12T12:00:01Z",
  idempotencyKey: "order-1",
  payload: { orderId: "1" },
};

describe("support access: which routes the support key reaches", () => {
  it("marks exactly the diagnostic routes as open to the support key", () => {
    expect(table().filter((r) => r.access === "support").map((r) => r.name).sort()).toEqual(SUPPORT_ROUTES);
    expect(table().length).toBeGreaterThan(SUPPORT_ROUTES.length);
  });

  it("reaches /healthz and each diagnostic route", async () => {
    const { call } = await start();
    expect((await call("/healthz", { auth: SUPPORT_KEY })).status).toBe(200);
    for (const route of table().filter((r) => r.access === "support")) {
      expect((await call(route.path, { method: route.method, auth: SUPPORT_KEY })).status, route.name).toBe(200);
    }
  });

  it("is turned down with 403 on every other route in the table, before the route does anything", async () => {
    const { call, memory } = await start();
    const others = table().filter((r) => r.access !== "support");
    for (const route of others) {
      const res = await call(route.path, { method: route.method, auth: SUPPORT_KEY, ...(route.method === "POST" ? { body: JSON.stringify(validEvent) } : {}) });
      expect(res.status, route.name).toBe(403);
      expect(await res.json(), route.name).toEqual({ error: SUPPORT_KEY_REFUSAL });
    }
    // Nothing was ingested, dead-lettered, reasoned over or recorded.
    expect(memory.events).toEqual([]);
    expect(memory.deadLetters).toEqual([]);
    expect(memory.reasoningRuns).toEqual([]);
    expect(memory.feedback).toEqual([]);
    expect(memory.valueResults).toEqual([]);
  });

  it("names what the support key can reach when it turns a request down", async () => {
    const { call } = await start();
    const body = (await (await call("/v1/recommendations", { auth: SUPPORT_KEY })).json()) as { error: string };
    expect(body.error).toBe(SUPPORT_KEY_REFUSAL);
    for (const route of ["GET /healthz", ...SUPPORT_ROUTES]) expect(body.error).toContain(route);
  });

  it("keeps the instance key working on every route, the support status included", async () => {
    const { call } = await start();
    expect((await call("/healthz")).status).toBe(200);
    for (const route of table()) {
      const res = await call(route.path, { method: route.method, ...(route.method === "POST" ? { body: "{}" } : {}) });
      expect([401, 403], route.name).not.toContain(res.status);
    }
    expect((await call("/v1/support/status")).status).toBe(200);
    expect((await call("/v1/recommendations")).status).toBe(200);
  });

  it("still answers 404 and 405 before looking at any key", async () => {
    const { call } = await start();
    expect((await call("/v1/nope", { auth: SUPPORT_KEY })).status).toBe(404);
    expect((await call("/v1/support/status", { method: "POST", auth: SUPPORT_KEY, body: "{}" })).status).toBe(405);
  });
});

describe("support access: the key itself", () => {
  it("answers 401, not 403, for a missing, wrong, short, long or altered key", async () => {
    const { call } = await start();
    const wrong = [
      newKey("s"),
      SUPPORT_KEY.slice(0, -1),
      `${SUPPORT_KEY}0`,
      SUPPORT_KEY.toUpperCase(),
      ` ${SUPPORT_KEY}`,
      `${SUPPORT_KEY}${INSTANCE_KEY}`,
      SUPPORT_KEY.slice(0, 32),
      "s".repeat(400),
      "s".repeat(5_000),
    ];
    for (const auth of wrong) {
      for (const path of ["/v1/support/status", "/v1/integrations", "/v1/recommendations"]) {
        const res = await call(path, { auth });
        expect(res.status, `${path} with a ${auth.length}-character key`).toBe(401);
        expect(await res.json()).toEqual({ error: "missing or invalid API key" });
      }
    }
    expect((await call("/v1/support/status", { auth: false })).status).toBe(401);
    expect((await call("/v1/support/status", { auth: SUPPORT_KEY })).status).toBe(200);
  });

  it("only counts when the instance was given one", async () => {
    const { call } = await start({}, [], ["supportApiKey"]);
    for (const path of ["/v1/support/status", "/v1/integrations", "/v1/recommendations"]) {
      expect((await call(path, { auth: SUPPORT_KEY })).status, path).toBe(401);
    }
    expect((await call("/v1/support/status")).status).toBe(200);
  });

  it("can't be the instance key", () => {
    expect(() => createBrainApp(appOptions(new InMemoryStore(), { supportApiKey: INSTANCE_KEY }))).toThrow("the support key must differ from the instance API key");
  });
});

/** Recognisable synthetic business data that must never reach the support status. */
const MARKERS = ["Zephyrine", "Quillfeather", "example.test", "cust_marker", "4815162", "sapphire", "271828", "rec_marker", "idem_marker", "evt_marker", "srcrec_marker", "dl_marker", "Halo ring"];

async function seedBusinessData(memory: InMemoryStore) {
  const customer = { ref: { kind: "customer", id: "cust_marker_7731" }, organizationId: ORG, attributes: { name: "Zephyrine Quillfeather", email: "zephyrine@example.test", lifetimeCents: 4815162 }, sourceEventIds: ["evt_marker_1"], updatedAt: "2026-11-12T12:00:00Z" };
  const event = (n: number, receivedAt: string, source: string, type: string) => ({
    id: `evt_marker_${n}`,
    organizationId: ORG,
    source,
    type,
    occurredAt: receivedAt,
    receivedAt,
    idempotencyKey: `idem_marker_${n}`,
    payload: { customer: "Zephyrine Quillfeather", email: "zephyrine@example.test", totalCents: 4815162, item: "Halo ring with sapphire" },
    sourceRecord: { id: `srcrec_marker_${n}` },
  });
  await memory.appendEvent(event(1, "2026-11-12T09:00:00Z", "shopify", "order.created"));
  await memory.appendEvent(event(2, "2026-11-12T10:00:00Z", "shopify", "order.created"));
  await memory.appendEvent(event(3, "2026-11-10T10:00:00Z", "stripe", "payment.succeeded"));
  // A free-text source is grouped, not shown.
  await memory.appendEvent(event(4, "2026-11-11T10:00:00Z", "Zephyrine Quillfeather", "order.created"));
  // Older than the default 14 days.
  await memory.appendEvent(event(5, "2026-10-01T10:00:00Z", "shopify", "order.created"));
  // Another organization's event is never counted.
  await memory.appendEvent({ ...event(6, "2026-11-12T10:00:00Z", "shopify", "order.created"), organizationId: "other-jeweler" });
  await memory.upsertEntities([customer]);
  await memory.appendSignals([
    { id: "sig_marker_1", organizationId: ORG, kind: "customer.lifetime_value", subject: customer.ref, value: 271828, confidence: 0.9, derivedFromEventIds: ["evt_marker_1"], observedAt: "2026-11-12T12:00:00Z" },
  ]);
  await memory.saveRecommendations([
    {
      id: "rec_marker_1",
      organizationId: ORG,
      summary: "Offer Zephyrine Quillfeather the sapphire Halo ring",
      confidence: 0.8,
      expectedImpact: "4815162 cents from Zephyrine",
      provenance: { eventIds: ["evt_marker_1"], signalIds: ["sig_marker_1"], documentIds: [] },
      degraded: false,
      createdAt: "2026-11-12T12:00:00Z",
    },
  ]);
  const dead = (n: number, source: string | undefined, reason: string, organizationId: string | undefined = ORG) => ({
    id: `dl_marker_${n}`,
    ...(organizationId ? { organizationId } : {}),
    ...(source ? { source } : {}),
    reason,
    issues: [{ path: "payload.email", message: "zephyrine@example.test is not allowed" }],
    raw: { customer: "Zephyrine Quillfeather", totalCents: 4815162 },
    receivedAt: "2026-11-12T11:00:00Z",
  });
  await memory.appendDeadLetter(dead(1, "shopify", "validation_failed"));
  await memory.appendDeadLetter(dead(2, "shopify", "validation_failed"));
  await memory.appendDeadLetter(dead(3, "Zephyrine Quillfeather", "Zephyrine broke it"));
  await memory.appendDeadLetter(dead(4, undefined, "validation_failed", undefined));
  await memory.appendDeadLetter(dead(5, "shopify", "validation_failed", "other-jeweler"));
}

const syncRuns: SyncStatus[] = [
  {
    id: "stripe",
    mode: "incremental",
    outcome: "failed",
    startedAt: "2026-11-12T15:00:00.000Z",
    finishedAt: "2026-11-12T15:00:04.000Z",
    error: "Error: GET https://api.vendor.test/v1/customers/cust_marker_7731?key=abc failed for zephyrine@example.test, authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
  },
];

describe("GET /v1/support/status", () => {
  it("reports operational metadata and counts in a fixed shape", async () => {
    const { call, memory } = await start({}, syncRuns);
    await seedBusinessData(memory);
    const res = await call("/v1/support/status", { auth: SUPPORT_KEY });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      instance: { name: "Example Jewelers", organizationId: ORG, version: "0.1.0", startedAt: "2026-11-12T13:00:00.000Z", uptimeSeconds: 9000 },
      migrations: { count: 2, applied: ["0001_core_schema.sql", "0002_ingestion.sql"] },
      retention: { rawRetentionDays: 30 },
      departments: ["sales", "inventory"],
      integrations: [
        {
          id: "stripe",
          configured: true,
          missingSettings: [],
          syncing: true,
          notSyncingReason: null,
          lastSync: {
            mode: "incremental",
            outcome: "failed",
            startedAt: "2026-11-12T15:00:00.000Z",
            finishedAt: "2026-11-12T15:00:04.000Z",
            ingested: null,
            duplicates: null,
            deadLettered: null,
            batches: null,
            error: "Error: GET https://api.vendor.test/[redacted] failed for [email], authorization: [redacted] [redacted]",
          },
        },
        {
          id: "shopify",
          configured: false,
          missingSettings: ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_ADMIN_ACCESS_TOKEN"],
          syncing: false,
          notSyncingReason: "missing SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN",
          lastSync: null,
        },
      ],
      deadLetters: { total: 4, bySource: { shopify: 2, other: 1, unknown: 1 }, byReason: { validation_failed: 3, other: 1 } },
      events: {
        days: 14,
        since: "2026-10-30T00:00:00.000Z",
        total: 4,
        byDay: [
          { day: "2026-11-10", source: "stripe", type: "payment.succeeded", count: 1 },
          { day: "2026-11-11", source: "other", type: "order.created", count: 1 },
          { day: "2026-11-12", source: "shopify", type: "order.created", count: 2 },
        ],
      },
    });
  });

  it("never carries business data: payloads, ids, customer refs, amounts, names, recommendation text or signal values", async () => {
    const { call, memory } = await start({}, syncRuns);
    await seedBusinessData(memory);
    // The data is there for the instance key to read...
    const recs = await (await call("/v1/recommendations")).text();
    expect(recs).toContain("Zephyrine");
    // ...and absent from the status, whichever key asks.
    for (const auth of [SUPPORT_KEY, INSTANCE_KEY]) {
      for (const query of ["", "?days=90"]) {
        const text = await (await call(`/v1/support/status${query}`, { auth })).text();
        for (const marker of MARKERS) expect(text, `${marker} with ${query || "no query"}`).not.toContain(marker);
      }
    }
  });

  it("counts events for the days asked, from 1 to 90", async () => {
    const { call, memory } = await start();
    await seedBusinessData(memory);
    const status = async (days: string) => (await (await call(`/v1/support/status?days=${days}`, { auth: SUPPORT_KEY })).json()) as { events: { days: number; since: string; total: number } };
    expect((await status("1")).events).toMatchObject({ days: 1, since: "2026-11-12T00:00:00.000Z", total: 2 });
    expect((await status("3")).events).toMatchObject({ days: 3, since: "2026-11-10T00:00:00.000Z", total: 4 });
    expect((await status("90")).events).toMatchObject({ days: 90, total: 5 });
    for (const bad of ["0", "91", "-1", "1.5", "abc", ""]) {
      const res = await call(`/v1/support/status?days=${bad}`, { auth: SUPPORT_KEY });
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toEqual({ error: "days must be a whole number from 1 to 90" });
    }
  });

  it("answers 503 when the instance wasn't given what to report", async () => {
    const { call } = await start({}, [], ["support"]);
    const res = await call("/v1/support/status", { auth: SUPPORT_KEY });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "support status isn't set up on this instance" });
  });

  it("lists integration setup to the support key by setting names only", async () => {
    const { call } = await start();
    const res = await call("/v1/integrations", { auth: SUPPORT_KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ integrations });
  });
});
