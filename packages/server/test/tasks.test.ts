import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, InMemoryWorkStore, type MemoryStore, type Reasoner, type WorkStore } from "@karatos/core";
import { loadMigrations, migrate, PostgresMemoryStore, PostgresWorkStore, type SqlClient } from "@karatos/store-postgres";
import { brainRoutes, createBrainApp, createVerifier, StaticDocumentationSource, TASK_KIND_NAMES, TASK_KINDS, TASK_MAX_RESULT_BYTES, type BrainAppOptions } from "../src/index.js";

const ORG = "example-jewelers";
const newKey = (prefix: string) => `${prefix}${randomBytes(32).toString("hex")}`;
const KEY = newKey("i");
const SUPPORT_KEY = newKey("s");
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));

const rec = (id: string, rule: string, organizationId: string, now: string) => ({
  id,
  organizationId,
  summary: `From ${rule}`,
  confidence: 0.7,
  expectedImpact: "Something better",
  provenance: { eventIds: [], signalIds: [], documentIds: [] },
  degraded: false,
  createdAt: now,
});

/** One rule from inventory and one from repairs, so a department filter has something to leave out. */
const reasoners: Reasoner[] = [
  { name: "inventory.reorder", reason: ({ organizationId, now }) => [rec(`rec_inventory_reorder_s1_${now.slice(0, 10)}`, "inventory.reorder", organizationId, now)] },
  { name: "repairs.follow-up", reason: ({ organizationId, now }) => [rec(`rec_repairs_follow_r1_${now.slice(0, 10)}`, "repairs.follow-up", organizationId, now)] },
];

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
});

interface Started {
  call: (method: string, path: string, body?: unknown, auth?: string | false) => Promise<{ status: number; body: Record<string, any> }>;
  clock: { now: Date };
  advance: (seconds: number) => void;
  memory: MemoryStore;
  work: WorkStore;
}

async function start(options: { memory?: MemoryStore; work?: WorkStore | false; reasoners?: Reasoner[]; clock?: { now: Date }; extra?: Partial<BrainAppOptions> } = {}): Promise<Started> {
  const memory = options.memory ?? new InMemoryStore();
  const work = options.work === false ? undefined : (options.work ?? new InMemoryWorkStore());
  const clock = options.clock ?? { now: new Date("2026-11-27T15:00:00.000Z") };
  const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: options.reasoners ?? reasoners, documentation: new StaticDocumentationSource(["doc_arch"]), now: () => clock.now });
  const app = createBrainApp({
    pipeline,
    memory,
    organizationId: ORG,
    apiKey: KEY,
    supportApiKey: SUPPORT_KEY,
    brief: { timeZone: "America/New_York", now: () => clock.now },
    ...(work ? { work: { store: work, now: () => clock.now } } : {}),
    ...options.extra,
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call: Started["call"] = async (method, path, body, auth) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth !== false) headers.authorization = `Bearer ${auth ?? KEY}`;
    const res = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, clock, advance: (s) => (clock.now = new Date(clock.now.getTime() + s * 1000)), memory, work: work! };
}

async function openSession(call: Started["call"], subject = "Why did repairs slow down?") {
  const res = await call("POST", "/v1/sessions", { subject, actor: "owner" });
  expect(res.status).toBe(201);
  return res.body.session.id as string;
}

async function queued(call: Started["call"], sessionId: string, kind: string, input: Record<string, unknown> = {}) {
  const res = await call("POST", "/v1/tasks", { sessionId, kind, input, actor: "console" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.task.id as string;
}

/** Claims a task and asks the instance to run it; the task as it finished. */
async function runTask(call: Started["call"], id: string) {
  const claim = await call("POST", `/v1/tasks/${id}/claim`, { agent: "agent-a" });
  expect(claim.status).toBe(200);
  const run = await call("POST", `/v1/tasks/${id}/run`, { leaseId: claim.body.leaseId });
  expect(run.status).toBe(200);
  return run.body.task;
}

const WORK_ROUTES = () =>
  brainRoutes({ pipeline: {} as BrainPipeline, memory: new InMemoryStore(), organizationId: ORG, apiKey: KEY }).filter((r) => /^\^\\\/v1\\\/(sessions|tasks)/.test(r.pattern.source));

const samplePath = (pattern: RegExp) => pattern.source.replace(/^\^/, "").replace(/\$$/, "").replace(/\([^)]*\)/g, "abc").replace(/\\\//g, "/");

describe("sessions and tasks: who can reach them", () => {
  it("are all instance-key routes", () => {
    const routes = WORK_ROUTES();
    expect(routes.map((r) => `${r.method} ${samplePath(r.pattern)}`)).toEqual([
      "GET /v1/sessions",
      "POST /v1/sessions",
      "GET /v1/sessions/abc",
      "POST /v1/sessions/abc/notes",
      "POST /v1/sessions/abc/links",
      "POST /v1/sessions/abc/close",
      "POST /v1/sessions/abc/reopen",
      "GET /v1/tasks",
      "POST /v1/tasks",
      "GET /v1/tasks/kinds",
      "POST /v1/tasks/claim",
      "GET /v1/tasks/abc",
      "POST /v1/tasks/abc/claim",
      "POST /v1/tasks/abc/progress",
      "POST /v1/tasks/abc/run",
      "POST /v1/tasks/abc/complete",
      "POST /v1/tasks/abc/cancel",
    ]);
    expect(routes.every((r) => r.access === "instance")).toBe(true);
  });

  it("answer 401 without the instance key or with a wrong one, and 403 to the support key, changing nothing", async () => {
    const { call, work } = await start();
    const store = work as InMemoryWorkStore;
    const sessionId = await openSession(call);
    const taskId = await queued(call, sessionId, "ask", { question: "what sold this week?" });
    const before = structuredClone({ sessions: [...store.sessions.values()], tasks: [...store.tasks.values()], audit: store.audit });
    for (const route of WORK_ROUTES()) {
      const path = samplePath(route.pattern).replace("/sessions/abc", `/sessions/${sessionId}`).replace("/tasks/abc", `/tasks/${taskId}`);
      const body = route.method === "POST" ? { subject: "x", actor: "x", agent: "x", sessionId, kind: "ask", input: { question: "q" }, leaseId: "x", text: "x" } : undefined;
      for (const auth of [false, newKey("i"), KEY.slice(0, -1), `${KEY}0`] as const) {
        const res = await call(route.method, path, body, auth);
        expect(res.status, `${route.method} ${path}`).toBe(401);
      }
      const support = await call(route.method, path, body, SUPPORT_KEY);
      expect(support.status, `${route.method} ${path}`).toBe(403);
    }
    expect({ sessions: [...store.sessions.values()], tasks: [...store.tasks.values()], audit: store.audit }).toEqual(before);
  });

  it("answer 503 when the instance has no work store", async () => {
    const { call } = await start({ work: false });
    expect(await call("GET", "/v1/sessions")).toEqual({ status: 503, body: { error: "sessions and tasks aren't set up on this instance" } });
    expect((await call("POST", "/v1/tasks/claim", { agent: "a" })).status).toBe(503);
    expect((await call("GET", "/v1/tasks/task_1")).status).toBe(503);
  });
});

describe("sessions over HTTP", () => {
  it("creates once per idempotency key, shows notes, links, tasks and the audit trail, and closes and reopens", async () => {
    const { call, memory, advance } = await start();
    await memory.saveRecommendations([rec("rec_repairs_follow_r1_2026-11-26", "repairs.follow-up", ORG, "2026-11-26T12:00:00.000Z")]);
    const body = { subject: "Why did repairs slow down?", actor: "owner", note: "From the brief", idempotencyKey: "repairs-nov" };
    const created = await call("POST", "/v1/sessions", body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ duplicate: false, session: { subject: "Why did repairs slow down?", status: "open", notes: [{ text: "From the brief", actor: "owner" }] } });
    const id = created.body.session.id as string;
    expect(id).toMatch(/^ses_[0-9a-f-]{36}$/);
    const again = await call("POST", "/v1/sessions", body);
    expect(again).toEqual({ status: 200, body: { duplicate: true, session: created.body.session } });
    expect(await call("POST", "/v1/sessions", { ...body, subject: "Another" })).toEqual({ status: 409, body: { error: "that idempotency key was already used for a different request" } });

    advance(60);
    expect((await call("POST", `/v1/sessions/${id}/notes`, { actor: "agent", text: "Bench backlog doubled" })).body.session.notes).toHaveLength(2);
    const linked = await call("POST", `/v1/sessions/${encodeURIComponent(id)}/links`, { actor: "agent", links: [{ kind: "recommendation", id: "rec_repairs_follow_r1_2026-11-26" }, { kind: "signal", id: "sig_1", note: "the jump" }] });
    expect(linked.status).toBe(200);
    expect(linked.body.session.links.map((l: { id: string }) => l.id)).toEqual(["rec_repairs_follow_r1_2026-11-26", "sig_1"]);
    expect(await call("POST", `/v1/sessions/${id}/links`, { actor: "agent", links: [{ kind: "recommendation", id: "rec_nope" }] })).toEqual({ status: 400, body: { error: "no recommendation rec_nope in this instance" } });
    const taskId = await queued(call, id, "ask", { question: "which repairs are late?" });

    const shown = await call("GET", `/v1/sessions/${id}`);
    expect(shown.status).toBe(200);
    expect(shown.body.tasks.map((t: { id: string }) => t.id)).toEqual([taskId]);
    expect(shown.body.audit.map((e: { action: string }) => e.action)).toEqual(["session.created", "session.noted", "session.linked", "task.created"]);

    const closed = await call("POST", `/v1/sessions/${id}/close`, { actor: "owner", note: "Two techs were out" });
    expect(closed.body.session).toMatchObject({ status: "closed", closedAt: "2026-11-27T15:01:00.000Z" });
    expect((await call("GET", `/v1/tasks/${taskId}`)).body.task.status).toBe("cancelled");
    expect(await call("POST", `/v1/sessions/${id}/close`, { actor: "owner" })).toEqual({ status: 409, body: { error: "the session is closed; reopen it first" } });
    expect((await call("POST", "/v1/tasks", { sessionId: id, kind: "ask", input: { question: "q" }, actor: "console" })).status).toBe(409);
    expect((await call("GET", "/v1/sessions?status=closed")).body.sessions.map((s: { id: string }) => s.id)).toEqual([id]);
    expect((await call("GET", "/v1/sessions?status=open")).body.sessions).toEqual([]);
    expect((await call("POST", `/v1/sessions/${id}/reopen`, { actor: "owner" })).body.session.status).toBe("open");
    expect((await call("GET", "/v1/sessions?limit=1")).body.sessions).toHaveLength(1);
  });

  it("says what is wrong with a request", async () => {
    const { call } = await start();
    expect(await call("GET", "/v1/sessions?status=pending")).toEqual({ status: 400, body: { error: "status must be open or closed" } });
    expect((await call("POST", "/v1/sessions", { subject: "", actor: "owner" })).body).toMatchObject({ error: "invalid session", details: [{ path: "subject" }] });
    expect((await call("POST", "/v1/sessions", { subject: "x".repeat(301), actor: "owner" })).status).toBe(400);
    expect((await call("POST", "/v1/sessions", { subject: "x", actor: "owner", idempotencyKey: "has spaces" })).status).toBe(400);
    expect((await call("POST", "/v1/sessions", { subject: "x", actor: "owner", extra: true })).status).toBe(400);
    expect((await call("POST", "/v1/sessions", "not json")).status).toBe(400);
    expect((await call("POST", "/v1/sessions", { subject: "x".repeat(20_000), actor: "owner" })).status).toBe(413);
    expect(await call("GET", "/v1/sessions/ses_nope")).toEqual({ status: 404, body: { error: "session not found" } });
    expect((await call("GET", "/v1/sessions/%E0%A4%A")).status).toBe(400);
    expect((await call("POST", "/v1/sessions/ses_nope/notes", { actor: "a", text: "x" })).status).toBe(404);
    expect((await call("POST", "/v1/sessions/ses_nope/links", { actor: "a", links: [] })).status).toBe(400);
    expect((await call("POST", "/v1/sessions/ses_nope/links", { actor: "a", links: [{ kind: "customer", id: "c1" }] })).status).toBe(400);
    expect((await call("POST", "/v1/sessions/ses_nope/reopen", { actor: "a" })).status).toBe(404);
    expect((await call("POST", "/v1/sessions/ses_nope/close", { actor: "a" })).status).toBe(404);
    expect((await call("DELETE", "/v1/sessions")).status).toBe(405);
  });
});

describe("agent tasks over HTTP", () => {
  it("lists the allowed kinds, each an existing read-only operation, and turns any other kind down", async () => {
    const { call, work } = await start();
    const kinds = await call("GET", "/v1/tasks/kinds");
    expect(kinds.body.vendorWrites).toBe(false);
    expect(kinds.body.kinds.map((k: { kind: string; operation: string }) => `${k.kind} ${k.operation}`)).toEqual([
      "reason POST /v1/reason",
      "ask POST /v1/ask",
      "brief GET /v1/brief",
      "verify POST /v1/verify",
      "value GET /v1/value",
      "feedback GET /v1/feedback",
      "signals GET /v1/signals",
      "recommendations GET /v1/recommendations",
    ]);
    const sessionId = await openSession(call);
    for (const kind of ["write_back", "shopify:tag_customer", "constructor", "__proto__", "toString", "events", "feedback_record", ""]) {
      const res = await call("POST", "/v1/tasks", { sessionId, kind, actor: "agent" });
      expect(res.status, kind).toBe(400);
      expect(res.body.error, kind).toContain(`isn't a task kind this instance allows; allowed: ${TASK_KIND_NAMES.join(", ")}`);
    }
    expect((await call("POST", "/v1/tasks/claim", { agent: "a", kinds: ["write_back"] })).status).toBe(400);
    expect((work as InMemoryWorkStore).tasks.size).toBe(0);
  });

  it("never reaches a write path: the task routes and operations don't touch the WriteGate", async () => {
    for (const file of ["../src/tasks.ts", "../src/app.ts", "../src/inputs.ts", "../src/http.ts"]) {
      // Code only: the comments say why no write path is reached, and may name it.
      const source = (await readFile(fileURLToPath(new URL(file, import.meta.url)), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const name of ["WriteGate", "SafeWriter", "WriteTarget", "WriteProposal", "ENABLED_WRITES", "connector-factory"]) expect(source, `${file} ${name}`).not.toContain(name);
    }
    expect(Object.values(TASK_KINDS).map((k) => k.operation.split(" ")[1])).toEqual(["/v1/reason", "/v1/ask", "/v1/brief", "/v1/verify", "/v1/value", "/v1/feedback", "/v1/signals", "/v1/recommendations"]);
  });

  it("checks each kind's input when the task is made", async () => {
    const { call } = await start();
    const sessionId = await openSession(call);
    const bad: [string, unknown][] = [
      ["ask", {}],
      ["ask", { question: " " }],
      ["ask", { question: "x".repeat(501) }],
      ["reason", { departments: ["payroll"] }],
      ["reason", { departments: [] }],
      ["brief", { date: "2026-02-30" }],
      ["verify", { from: "2026-11-01" }],
      ["verify", { from: "2026-11-01", to: "2026-11-02", toleranceCents: 101 }],
      ["value", { from: "2026-11-01" }],
      ["feedback", { anything: 1 }],
      ["signals", { kinds: ["Bad Kind"] }],
      ["signals", { limit: 0 }],
      ["recommendations", { limit: 201 }],
    ];
    for (const [kind, input] of bad) {
      const res = await call("POST", "/v1/tasks", { sessionId, kind, input, actor: "agent" });
      expect(res.status, `${kind} ${JSON.stringify(input)}`).toBe(400);
      expect(res.body.error).toBe(`invalid input for a ${kind} task`);
    }
    expect((await call("POST", "/v1/tasks", { sessionId, kind: "ask", input: [], actor: "agent" })).status).toBe(400);
    expect(await call("POST", "/v1/tasks", { sessionId: "ses_nope", kind: "feedback", actor: "agent" })).toEqual({ status: 404, body: { error: "session not found" } });
    // Input defaults to {}.
    expect((await call("POST", "/v1/tasks", { sessionId, kind: "feedback", actor: "agent" })).body.task.input).toEqual({});
  });

  it("creates a task once per idempotency key", async () => {
    const { call } = await start();
    const sessionId = await openSession(call);
    const body = { sessionId, kind: "verify", input: { system: "stripe", from: "2026-11-16", to: "2026-11-22" }, actor: "console", idempotencyKey: "payouts-w47" };
    const first = await call("POST", "/v1/tasks", body);
    expect(first.status).toBe(201);
    const again = await call("POST", "/v1/tasks", body);
    expect(again).toEqual({ status: 200, body: { duplicate: true, task: first.body.task } });
    expect((await call("POST", "/v1/tasks", { ...body, input: { system: "stripe", from: "2026-11-16", to: "2026-11-23" } })).status).toBe(409);
    expect((await call("GET", `/v1/tasks?sessionId=${sessionId}`)).body.tasks).toHaveLength(1);
  });

  it("claims, reports progress and a result, and keeps the lease id from everyone but the claimant", async () => {
    const { call, advance } = await start();
    const sessionId = await openSession(call);
    const id = await queued(call, sessionId, "ask", { question: "which payouts are late?" });
    expect(await call("POST", "/v1/tasks/claim", { agent: "agent-a", kinds: ["verify"] })).toEqual({ status: 200, body: { task: null } });
    const claim = await call("POST", "/v1/tasks/claim", { agent: "agent-a", sessionId, leaseSeconds: 60 });
    expect(claim.status).toBe(200);
    expect(claim.body).toMatchObject({ task: { id, status: "claimed", attempts: 1, lease: { agent: "agent-a", expiresAt: "2026-11-27T15:01:00.000Z" } }, leaseExpiresAt: "2026-11-27T15:01:00.000Z" });
    const leaseId = claim.body.leaseId as string;
    expect(leaseId).toMatch(/^lease_/);
    expect(JSON.stringify(claim.body.task)).not.toContain(leaseId);
    const shown = await call("GET", `/v1/tasks/${id}`);
    expect(JSON.stringify(shown.body)).not.toContain(leaseId);
    expect(JSON.stringify(await call("GET", `/v1/sessions/${sessionId}`))).not.toContain(leaseId);
    expect(JSON.stringify(await call("GET", "/v1/tasks"))).not.toContain(leaseId);
    expect(await call("POST", `/v1/tasks/${id}/claim`, { agent: "agent-b" })).toEqual({ status: 409, body: { error: "the task is claimed by agent-a until 2026-11-27T15:01:00.000Z, so it can't be claimed" } });

    advance(30);
    const progress = await call("POST", `/v1/tasks/${id}/progress`, { leaseId, message: "Reading payouts", percent: 50, leaseSeconds: 120 });
    expect(progress.body).toMatchObject({ task: { progress: { message: "Reading payouts", percent: 50 } }, leaseExpiresAt: "2026-11-27T15:02:30.000Z" });
    expect((await call("POST", `/v1/tasks/${id}/progress`, { leaseId: "lease_other", message: "x" })).status).toBe(409);
    expect((await call("POST", `/v1/tasks/${id}/progress`, { leaseId, message: "x", leaseSeconds: 1 })).status).toBe(400);
    expect((await call("POST", `/v1/tasks/${id}/complete`, { leaseId, outcome: "failed" })).body).toMatchObject({ error: "invalid completion", details: [{ path: "error" }] });
    const huge = { text: "x".repeat(TASK_MAX_RESULT_BYTES + 20_000) };
    expect((await call("POST", `/v1/tasks/${id}/complete`, { leaseId, outcome: "succeeded", result: huge })).status).toBe(413);
    const near = { text: "x".repeat(TASK_MAX_RESULT_BYTES - 11) };
    expect(Buffer.byteLength(JSON.stringify(near))).toBe(TASK_MAX_RESULT_BYTES);
    const over = { text: "x".repeat(TASK_MAX_RESULT_BYTES - 10) };
    expect(await call("POST", `/v1/tasks/${id}/complete`, { leaseId, outcome: "succeeded", result: over })).toEqual({ status: 400, body: { error: `a reported result must be at most ${TASK_MAX_RESULT_BYTES} bytes as JSON` } });
    const done = await call("POST", `/v1/tasks/${id}/complete`, { leaseId, outcome: "succeeded", result: near });
    expect(done.status).toBe(200);
    expect(done.body.task).toMatchObject({ status: "succeeded", resultBy: "agent", finishedAt: "2026-11-27T15:00:30.000Z" });
    expect(await call("POST", `/v1/tasks/${id}/complete`, { leaseId, outcome: "succeeded" })).toEqual({ status: 409, body: { error: "the task is already succeeded" } });
    const trail = (await call("GET", `/v1/tasks/${id}`)).body.audit.map((e: { action: string }) => e.action);
    expect(trail).toEqual(["task.created", "task.claimed", "task.progress", "task.succeeded"]);
    expect((await call("GET", "/v1/tasks?status=succeeded")).body.tasks).toHaveLength(1);
    expect((await call("GET", "/v1/tasks?status=done")).status).toBe(400);
    expect((await call("GET", "/v1/tasks?limit=1&status=queued")).body.tasks).toEqual([]);
  });

  it("gives an expired lease's task to the next agent and turns the old lease down", async () => {
    const { call, advance } = await start();
    const sessionId = await openSession(call);
    const id = await queued(call, sessionId, "feedback");
    const first = await call("POST", `/v1/tasks/${id}/claim`, { agent: "agent-a", leaseSeconds: 10 });
    advance(10);
    expect((await call("GET", `/v1/tasks/${id}`)).body.task).toMatchObject({ status: "queued", lease: null, attempts: 1 });
    expect(await call("POST", `/v1/tasks/${id}/run`, { leaseId: first.body.leaseId })).toEqual({ status: 409, body: { error: "that lease is no longer held: it ran out or the task was claimed again; claim it again" } });
    const second = await call("POST", "/v1/tasks/claim", { agent: "agent-b" });
    expect(second.body.task).toMatchObject({ id, attempts: 2, lease: { agent: "agent-b" } });
    expect((await call("POST", `/v1/tasks/${id}/complete`, { leaseId: first.body.leaseId, outcome: "succeeded" })).status).toBe(409);
    expect((await call("POST", `/v1/tasks/${id}/run`, { leaseId: second.body.leaseId })).body.task.status).toBe("succeeded");
    const expired = (await call("GET", `/v1/tasks/${id}`)).body.audit.find((e: { action: string }) => e.action === "task.lease_expired");
    expect(expired).toMatchObject({ actor: "brain", detail: { agent: "agent-a", attempts: 1, requeued: true } });
  });

  it("runs every kind's operation as its route does", async () => {
    const { call, memory } = await start({ extra: { verify: createVerifier({ memory: new InMemoryStore(), organizationId: ORG, connectors: [], skipped: [] }) } });
    await memory.appendSignals([
      { id: "sig_1", organizationId: ORG, kind: "bank.balance", subject: { kind: "account", id: "a1" }, value: 1, confidence: 1, derivedFromEventIds: [], observedAt: "2026-11-26T00:00:00.000Z" },
      { id: "sig_2", organizationId: ORG, kind: "receivable.invoice", subject: { kind: "invoice", id: "i1" }, value: 1, confidence: 1, derivedFromEventIds: [], observedAt: "2026-11-26T00:00:00.000Z" },
    ]);
    const sessionId = await openSession(call, "Inventory");

    const reason = await runTask(call, await queued(call, sessionId, "reason", { departments: ["inventory"] }));
    expect(reason).toMatchObject({ status: "succeeded", resultBy: "brain", error: null, result: { departments: ["inventory"], measured: 0, heldBack: [], linked: 1 } });
    expect(reason.result.recommendations.map((r: { id: string }) => r.id)).toEqual(["rec_inventory_reorder_s1_2026-11-27"]);
    const all = await runTask(call, await queued(call, sessionId, "reason"));
    expect(all.result.recommendations).toHaveLength(2);
    // The second run raised the same inventory recommendation again; only the repairs one is new to the session.
    expect(all.result.linked).toBe(1);
    expect((await call("GET", `/v1/sessions/${sessionId}`)).body.session.links.map((l: { id: string }) => l.id)).toEqual(["rec_inventory_reorder_s1_2026-11-27", "rec_repairs_follow_r1_2026-11-27"]);

    const answer = await runTask(call, await queued(call, sessionId, "ask", { question: "what sold this week?" }));
    expect(answer.result).toEqual((await call("POST", "/v1/ask", { question: "what sold this week?" })).body);
    const brief = await runTask(call, await queued(call, sessionId, "brief", { date: "2026-11-26" }));
    expect(brief.result).toEqual((await call("GET", "/v1/brief?date=2026-11-26")).body);
    const yesterday = await runTask(call, await queued(call, sessionId, "brief"));
    expect(yesterday.result.brief.date).toBe("2026-11-26");
    const value = await runTask(call, await queued(call, sessionId, "value", { from: "2026-11-01", to: "2026-11-27" }));
    expect(value.result).toEqual((await call("GET", "/v1/value?from=2026-11-01&to=2026-11-27")).body);
    const month = await runTask(call, await queued(call, sessionId, "value"));
    expect(month.result.report).toBeDefined();
    const feedback = await runTask(call, await queued(call, sessionId, "feedback"));
    // asOf is the wall clock, as at the route.
    expect({ ...feedback.result, feedback: { ...feedback.result.feedback, asOf: null } }).toEqual({ feedback: { ...(await call("GET", "/v1/feedback")).body.feedback, asOf: null } });
    const signals = await runTask(call, await queued(call, sessionId, "signals", { kinds: ["bank.balance"], limit: 5 }));
    expect(signals.result.signals.map((s: { id: string }) => s.id)).toEqual(["sig_1"]);
    expect((await runTask(call, await queued(call, sessionId, "signals"))).result.signals).toHaveLength(2);
    const recs = await runTask(call, await queued(call, sessionId, "recommendations", { limit: 1 }));
    expect(recs.result.recommendations).toHaveLength(1);
    expect((await runTask(call, await queued(call, sessionId, "recommendations"))).result.recommendations.length).toBeGreaterThan(1);
    const verify = await runTask(call, await queued(call, sessionId, "verify", { from: "2026-11-16", to: "2026-11-22" }));
    expect(verify).toMatchObject({ status: "succeeded", result: { verification: { summary: { match: 0, mismatch: 0 } } } });
  });

  it("records an operation's own refusal, and only the class name of anything else", async () => {
    const leaky: Reasoner = {
      name: "inventory.reorder",
      reason: () => {
        throw new TypeError("customer Zephyrine owes 4815162");
      },
    };
    const { call } = await start({ reasoners: [leaky] });
    const sessionId = await openSession(call);
    const verify = await runTask(call, await queued(call, sessionId, "verify", { from: "2026-11-16", to: "2026-11-22" }));
    expect(verify).toMatchObject({ status: "failed", resultBy: "brain", result: null, error: "sync verification isn't set up on this instance" });
    const late = await runTask(call, await queued(call, sessionId, "brief", { date: "2026-11-29" }));
    expect(late.error).toBe("date can't be after today in the store's time zone");
    const reason = await runTask(call, await queued(call, sessionId, "reason"));
    expect(reason).toMatchObject({ status: "failed", error: "the operation failed (TypeError)" });
    const shown = JSON.stringify(await call("GET", `/v1/sessions/${sessionId}`));
    expect(shown).not.toContain("Zephyrine");
    expect(shown).not.toContain("4815162");
  });

  it("turns down a second run, and a run on a reason task whose session closed while it ran still finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: Reasoner = {
      name: "inventory.reorder",
      reason: async ({ organizationId, now }) => {
        await gate;
        return [rec("rec_inventory_reorder_s9_x", "inventory.reorder", organizationId, now)];
      },
    };
    const { call } = await start({ reasoners: [slow] });
    const sessionId = await openSession(call);
    const id = await queued(call, sessionId, "reason");
    const claim = await call("POST", `/v1/tasks/${id}/claim`, { agent: "agent-a" });
    const running = call("POST", `/v1/tasks/${id}/run`, { leaseId: claim.body.leaseId });
    await expect.poll(async () => (await call("GET", `/v1/tasks/${id}`)).body.task.status).toBe("running");
    expect(await call("POST", `/v1/tasks/${id}/run`, { leaseId: claim.body.leaseId })).toEqual({ status: 409, body: { error: "the task is running" } });
    expect(await call("POST", `/v1/tasks/${id}/cancel`, { actor: "owner" })).toEqual({ status: 409, body: { error: "the task is running and can't be cancelled until it finishes" } });
    expect((await call("POST", `/v1/sessions/${sessionId}/close`, { actor: "owner" })).status).toBe(200);
    release();
    const done = await running;
    expect(done.body.task).toMatchObject({ status: "succeeded", result: { linked: 0 } });
    expect((await call("GET", `/v1/sessions/${sessionId}`)).body.session.links).toEqual([]);
  });

  it("fails rather than runs a stored task whose kind isn't allowed", async () => {
    const { call, work } = await start();
    const sessionId = await openSession(call);
    // Written straight to the store, as an older instance or a hand-edited row might have left it.
    await work.insertTask(
      { id: "task_old", organizationId: ORG, sessionId, kind: "write_back", input: {}, status: "queued", createdBy: "x", createdAt: "2026-11-27T15:00:00.000Z", updatedAt: "2026-11-27T15:00:00.000Z", attempts: 0, lease: null, progress: null, result: null, resultBy: null, error: null, finishedAt: null },
      null,
      { action: "task.created", actor: "x", at: "2026-11-27T15:00:00.000Z", detail: {} },
    );
    expect(await runTask(call, "task_old")).toMatchObject({ status: "failed", result: null, error: "write_back isn't a task kind this instance allows" });
  });

  it("cancels, and says what is wrong with a request", async () => {
    const { call } = await start();
    const sessionId = await openSession(call);
    const id = await queued(call, sessionId, "feedback");
    expect((await call("POST", `/v1/tasks/${id}/cancel`, { actor: "owner", reason: "asked twice" })).body.task).toMatchObject({ status: "cancelled" });
    expect(await call("POST", `/v1/tasks/${id}/cancel`, { actor: "owner" })).toEqual({ status: 409, body: { error: "the task is already cancelled" } });
    expect(await call("POST", `/v1/tasks/${id}/claim`, { agent: "a" })).toEqual({ status: 409, body: { error: "the task is cancelled, so it can't be claimed" } });
    expect(await call("GET", "/v1/tasks/task_nope")).toEqual({ status: 404, body: { error: "task not found" } });
    expect((await call("POST", "/v1/tasks/task_nope/claim", { agent: "a" })).status).toBe(404);
    expect((await call("POST", "/v1/tasks/task_nope/run", { leaseId: "x" })).status).toBe(404);
    expect((await call("POST", "/v1/tasks/task_nope/progress", { leaseId: "x", message: "m" })).status).toBe(404);
    expect((await call("POST", "/v1/tasks/task_nope/complete", { leaseId: "x", outcome: "succeeded" })).status).toBe(404);
    expect((await call("POST", "/v1/tasks/task_nope/cancel", { actor: "a" })).status).toBe(404);
    expect((await call("POST", "/v1/tasks/claim", { agent: "" })).status).toBe(400);
    expect((await call("POST", "/v1/tasks/claim", { agent: "a", leaseSeconds: 3601 })).status).toBe(400);
    expect((await call("POST", "/v1/tasks/claim", { agent: "a", leaseSeconds: 3600 })).status).toBe(200);
    expect((await call("POST", "/v1/tasks/claim", { agent: "a", leaseSeconds: 10 })).status).toBe(200);
    expect((await call("POST", "/v1/tasks/claim", { agent: "a", leaseSeconds: 9 })).status).toBe(400);
    expect((await call("POST", "/v1/tasks/claim", { agent: "a", kinds: [] })).status).toBe(400);
    expect((await call("POST", `/v1/tasks/${id}/run`, {})).status).toBe(400);
  });
});

function pgliteClient(db: PGlite): SqlClient {
  return {
    async query<T>(text: string, params?: unknown[]) {
      if (params === undefined || params.length === 0) {
        const results = await db.exec(text);
        return { rows: (results.at(-1)?.rows ?? []) as T[] };
      }
      return { rows: (await db.query<T>(text, params)).rows };
    },
  };
}

describe("sessions and tasks across a restart (Postgres)", () => {
  it("resume where they left off: the session, its tasks, the claim and the idempotency keys", async () => {
    const client = pgliteClient(new PGlite());
    await migrate(client, await loadMigrations(MIGRATIONS_DIR));
    await client.query("insert into organizations (id, name) values ($1, 'Example Jewelers')", [ORG]);
    const clock = { now: new Date("2026-11-27T15:00:00.000Z") };
    const first = await start({ memory: new PostgresMemoryStore(client), work: new PostgresWorkStore(client), clock });
    const sessionId = (await first.call("POST", "/v1/sessions", { subject: "Why did repairs slow down?", actor: "owner", idempotencyKey: "repairs" })).body.session.id;
    const reason = (await first.call("POST", "/v1/tasks", { sessionId, kind: "reason", actor: "console", idempotencyKey: "rerun" })).body.task.id;
    const ask = await queued(first.call, sessionId, "ask", { question: "which repairs are late?" });
    const claim = await first.call("POST", `/v1/tasks/${reason}/claim`, { agent: "agent-a", leaseSeconds: 60 });

    // The instance restarts: new stores and a new app over the same database.
    const second = await start({ memory: new PostgresMemoryStore(client), work: new PostgresWorkStore(client), clock });
    expect((await second.call("POST", "/v1/sessions", { subject: "Why did repairs slow down?", actor: "owner", idempotencyKey: "repairs" })).body).toMatchObject({ duplicate: true, session: { id: sessionId } });
    expect((await second.call("POST", "/v1/tasks", { sessionId, kind: "reason", actor: "console", idempotencyKey: "rerun" })).body).toMatchObject({ duplicate: true, task: { id: reason } });
    const shown = await second.call("GET", `/v1/sessions/${sessionId}`);
    expect(shown.body.tasks.map((t: { id: string; status: string }) => `${t.id}:${t.status}`).sort()).toEqual([`${reason}:claimed`, `${ask}:queued`].sort());
    // The agent that held the claim carries on with its lease.
    const ran = await second.call("POST", `/v1/tasks/${reason}/run`, { leaseId: claim.body.leaseId });
    expect(ran.body.task).toMatchObject({ status: "succeeded", result: { linked: 2 } });
    // A claim nobody finished before the restart runs out and goes to the next agent.
    const stale = await second.call("POST", `/v1/tasks/${ask}/claim`, { agent: "agent-b", leaseSeconds: 10 });
    clock.now = new Date(clock.now.getTime() + 10_000);
    const third = await start({ memory: new PostgresMemoryStore(client), work: new PostgresWorkStore(client), clock });
    const next = await third.call("POST", "/v1/tasks/claim", { agent: "agent-c" });
    expect(next.body.task).toMatchObject({ id: ask, attempts: 2, lease: { agent: "agent-c" } });
    expect((await third.call("POST", `/v1/tasks/${ask}/complete`, { leaseId: stale.body.leaseId, outcome: "succeeded" })).status).toBe(409);
    const audit = (await third.call("GET", `/v1/sessions/${sessionId}`)).body.audit.map((e: { action: string }) => e.action);
    expect(audit).toEqual(["session.created", "task.created", "task.created", "task.claimed", "task.started", "session.linked", "task.succeeded", "task.claimed", "task.lease_expired", "task.claimed"]);
  });
});
