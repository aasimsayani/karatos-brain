import { describe, expect, it } from "vitest";
import {
  createWorkService,
  InMemoryStore,
  InMemoryWorkStore,
  MAX_SESSION_LINKS,
  MAX_SESSION_NOTES,
  TASK_RUN_LEASE_SECONDS,
  WorkError,
  type MemoryStore,
  type WorkStore,
} from "@karatos/core";
import { PostgresMemoryStore, PostgresWorkStore, type SqlClient } from "../src/index.js";
import { freshDatabase } from "./helpers.js";

const ORG = "example-jewelers";
const OTHER = "other-jewelers";
const KINDS = ["reason", "ask", "verify"];

interface Setup {
  store: WorkStore;
  memory: MemoryStore;
  /** A new store over the same data, as after a restart. Null in memory, where nothing survives one. */
  reopen: (() => WorkStore) | null;
  client: SqlClient | null;
}

const stores: [string, () => Promise<Setup>][] = [
  ["in memory", async () => ({ store: new InMemoryWorkStore(), memory: new InMemoryStore(), reopen: null, client: null })],
  [
    "Postgres",
    async () => {
      const { client } = await freshDatabase();
      await client.query("insert into organizations (id, name) values ($1, 'Example Jewelers'), ($2, 'Other Jewelers')", [ORG, OTHER]);
      return { store: new PostgresWorkStore(client), memory: new PostgresMemoryStore(client), reopen: () => new PostgresWorkStore(client), client };
    },
  ],
];

/** A clock the test moves by hand, and ids counted up so they are predictable. */
function harness(setup: Setup, organizationId = ORG, store: WorkStore = setup.store) {
  const clock = { now: new Date("2026-11-27T12:00:00.000Z") };
  let n = 0;
  const service = createWorkService({
    store,
    memory: setup.memory,
    organizationId,
    kinds: KINDS,
    now: () => clock.now,
    newId: (prefix) => `${prefix}_${organizationId}_${++n}`,
  });
  const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
  return { service, clock, advance };
}

const rejects = async (promise: Promise<unknown>, reason: WorkError["reason"], message: RegExp) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WorkError);
  expect((error as WorkError).reason).toBe(reason);
  expect((error as WorkError).message).toMatch(message);
};

describe.each(stores)("reasoning sessions and agent tasks (%s)", (_name, make) => {
  it("creates a session once per idempotency key, and turns a reused key with a different request down", async () => {
    const setup = await make();
    const { service } = harness(setup);
    const first = await service.createSession({ subject: "Why did repairs slow down?", actor: "owner", note: "Started from the brief", idempotencyKey: "k-1" });
    expect(first.created).toBe(true);
    expect(first.record).toEqual({
      id: `ses_${ORG}_1`,
      organizationId: ORG,
      subject: "Why did repairs slow down?",
      status: "open",
      createdBy: "owner",
      createdAt: "2026-11-27T12:00:00.000Z",
      updatedAt: "2026-11-27T12:00:00.000Z",
      closedAt: null,
      notes: [{ text: "Started from the brief", actor: "owner", at: "2026-11-27T12:00:00.000Z" }],
      links: [],
    });
    const again = await service.createSession({ subject: "Why did repairs slow down?", actor: "owner", note: "Started from the brief", idempotencyKey: "k-1" });
    expect(again).toEqual({ record: first.record, created: false });
    await rejects(service.createSession({ subject: "Something else", actor: "owner", idempotencyKey: "k-1" }), "conflict", /already used for a different request/);
    // Without a key, each call is a new session.
    const a = await service.createSession({ subject: "Payouts", actor: "owner" });
    const b = await service.createSession({ subject: "Payouts", actor: "owner" });
    expect(a.record.id).not.toBe(b.record.id);
    expect((await service.listSessions(null, 10)).length).toBe(3);
    // Another organization's key space is its own.
    const other = harness(setup, OTHER);
    expect((await other.service.createSession({ subject: "Theirs", actor: "owner", idempotencyKey: "k-1" })).created).toBe(true);
    expect((await service.listSessions(null, 10)).map((s) => s.organizationId)).toEqual([ORG, ORG, ORG]);
    expect(await other.service.session(first.record.id).catch((e: WorkError) => e.reason)).toBe("not_found");
  });

  it("keeps notes and links, each link once, and checks what it links exists", async () => {
    const setup = await make();
    const { service, advance } = harness(setup);
    await setup.memory.saveRecommendations([
      { id: "rec_repairs_slow_1", organizationId: ORG, summary: "Chase the bench", confidence: 0.7, expectedImpact: "Faster repairs", provenance: { eventIds: [], signalIds: [], documentIds: [] }, degraded: false, createdAt: "2026-11-26T12:00:00.000Z" },
    ]);
    await setup.memory.appendEvent({ id: "evt_1", organizationId: ORG, source: "manual", type: "repair.received", occurredAt: "2026-11-20T12:00:00.000Z", receivedAt: "2026-11-20T12:00:00.000Z", idempotencyKey: "r1", payload: {} });
    await setup.memory.upsertEntities([{ ref: { kind: "repair_ticket", id: "R 100" }, organizationId: ORG, attributes: {}, sourceEventIds: ["evt_1"], updatedAt: "2026-11-20T12:00:00.000Z" }]);
    const { record } = await service.createSession({ subject: "Repairs", actor: "owner" });
    advance(60);
    const noted = await service.addNote(record.id, { actor: "agent", text: "Bench backlog doubled" });
    expect(noted.notes).toEqual([{ text: "Bench backlog doubled", actor: "agent", at: "2026-11-27T12:01:00.000Z" }]);
    expect(noted.updatedAt).toBe("2026-11-27T12:01:00.000Z");
    const linked = await service.addLinks(record.id, {
      actor: "agent",
      links: [
        { kind: "recommendation", id: "rec_repairs_slow_1", note: "the finding" },
        { kind: "event", id: "evt_1" },
        { kind: "entity", entityKind: "repair_ticket", id: "R 100" },
        { kind: "signal", id: "sig_anything" },
        { kind: "reasoning_run", id: "run_1" },
        { kind: "event", id: "evt_1" },
      ],
    });
    expect(linked.links.map((l) => `${l.kind}:${l.entityKind ?? ""}:${l.id}`)).toEqual(["recommendation::rec_repairs_slow_1", "event::evt_1", "entity:repair_ticket:R 100", "signal::sig_anything", "reasoning_run::run_1"]);
    expect(linked.links[0]).toEqual({ kind: "recommendation", id: "rec_repairs_slow_1", note: "the finding", addedBy: "agent", addedAt: "2026-11-27T12:01:00.000Z" });
    // The same links again change nothing, and leave no audit entry.
    const before = (await service.audit({ sessionId: record.id })).length;
    expect((await service.addLinks(record.id, { actor: "agent", links: [{ kind: "event", id: "evt_1" }] })).links).toHaveLength(5);
    expect((await service.audit({ sessionId: record.id })).length).toBe(before);
    await rejects(service.addLinks(record.id, { actor: "agent", links: [{ kind: "recommendation", id: "rec_nope" }] }), "invalid", /no recommendation rec_nope/);
    await rejects(service.addLinks(record.id, { actor: "agent", links: [{ kind: "event", id: "evt_nope" }] }), "invalid", /no event evt_nope/);
    await rejects(service.addLinks(record.id, { actor: "agent", links: [{ kind: "entity", entityKind: "customer", id: "R 100" }] }), "invalid", /no entity R 100/);
    await rejects(service.addLinks(record.id, { actor: "agent", links: [{ kind: "entity", id: "R 100" }] }), "invalid", /needs entityKind/);
    await rejects(service.addLinks(record.id, { actor: "agent", links: [{ kind: "event", entityKind: "x", id: "evt_1" }] }), "invalid", /only an entity link/);
    await rejects(service.addNote("ses_nope", { actor: "agent", text: "x" }), "not_found", /session not found/);
    await rejects(service.addLinks("ses_nope", { actor: "agent", links: [{ kind: "signal", id: "s" }] }), "not_found", /session not found/);
    // Another organization can't see this organization's recommendation.
    const other = harness(setup, OTHER);
    const theirs = await other.service.createSession({ subject: "Theirs", actor: "owner" });
    await rejects(other.service.addLinks(theirs.record.id, { actor: "agent", links: [{ kind: "recommendation", id: "rec_repairs_slow_1" }] }), "invalid", /no recommendation/);
  });

  it("stops at the note and link limits", async () => {
    const setup = await make();
    const { service } = harness(setup);
    const { record } = await service.createSession({ subject: "Full", actor: "owner" });
    for (let i = 0; i < MAX_SESSION_NOTES; i++) await service.addNote(record.id, { actor: "a", text: `n${i}` });
    await rejects(service.addNote(record.id, { actor: "a", text: "one more" }), "conflict", new RegExp(`at most ${MAX_SESSION_NOTES} notes`));
    await rejects(service.close(record.id, { actor: "a", note: "closing note" }), "conflict", /at most/);
    expect((await service.session(record.id)).status).toBe("open");
    for (let i = 0; i < MAX_SESSION_LINKS; i += 50) {
      await service.addLinks(record.id, { actor: "a", links: Array.from({ length: 50 }, (_, j) => ({ kind: "signal" as const, id: `s${i + j}` })) });
    }
    expect((await service.session(record.id)).links).toHaveLength(MAX_SESSION_LINKS);
    // Already-linked ones still change nothing; a new one is over the limit.
    expect((await service.addLinks(record.id, { actor: "a", links: [{ kind: "signal", id: "s0" }] })).links).toHaveLength(MAX_SESSION_LINKS);
    await rejects(service.addLinks(record.id, { actor: "a", links: [{ kind: "signal", id: "s0" }, { kind: "signal", id: "new" }] }), "conflict", new RegExp(`at most ${MAX_SESSION_LINKS} links`));
  });

  it("closes a session, cancelling its queued and claimed tasks but not a running one, and reopens it", async () => {
    const setup = await make();
    const { service, advance } = harness(setup);
    const { record: session } = await service.createSession({ subject: "Payouts last week", actor: "owner" });
    const queued = (await service.createTask({ sessionId: session.id, kind: "ask", input: { question: "which payouts are late?" }, actor: "console" })).record;
    const held = (await service.createTask({ sessionId: session.id, kind: "verify", input: { from: "2026-11-16", to: "2026-11-22" }, actor: "console" })).record;
    const running = (await service.createTask({ sessionId: session.id, kind: "reason", input: {}, actor: "console" })).record;
    advance(1);
    await service.claim({ taskId: held.id }, { agent: "agent-a" });
    const run = await service.claim({ taskId: running.id }, { agent: "agent-b" });
    await service.start(running.id, run!.lease!.leaseId);
    advance(1);
    const closed = await service.close(session.id, { actor: "owner", note: "Payouts were all on time" });
    expect(closed).toMatchObject({ status: "closed", closedAt: "2026-11-27T12:00:02.000Z", updatedAt: "2026-11-27T12:00:02.000Z" });
    expect(closed.notes.at(-1)).toEqual({ text: "Payouts were all on time", actor: "owner", at: "2026-11-27T12:00:02.000Z" });
    expect((await service.task(queued.id)).status).toBe("cancelled");
    expect((await service.task(held.id))).toMatchObject({ status: "cancelled", finishedAt: "2026-11-27T12:00:02.000Z" });
    expect((await service.task(running.id)).status).toBe("running");
    await rejects(service.close(session.id, { actor: "owner" }), "conflict", /the session is closed/);
    await rejects(service.addNote(session.id, { actor: "owner", text: "late" }), "conflict", /the session is closed/);
    await rejects(service.addLinks(session.id, { actor: "owner", links: [{ kind: "signal", id: "s" }] }), "conflict", /the session is closed/);
    await rejects(service.createTask({ sessionId: session.id, kind: "ask", input: {}, actor: "console" }), "conflict", /the session is closed/);
    await rejects(service.createTask({ sessionId: "ses_nope", kind: "ask", input: {}, actor: "console" }), "not_found", /session not found/);
    expect((await service.listSessions("closed", 10)).map((s) => s.id)).toEqual([session.id]);
    expect(await service.listSessions("open", 10)).toEqual([]);
    advance(1);
    const reopened = await service.reopen(session.id, { actor: "owner" });
    expect(reopened).toMatchObject({ status: "open", closedAt: null, updatedAt: "2026-11-27T12:00:03.000Z" });
    await rejects(service.reopen(session.id, { actor: "owner" }), "conflict", /already open/);
    await rejects(service.reopen("ses_nope", { actor: "owner" }), "not_found", /session not found/);
    const actions = (await service.audit({ sessionId: session.id })).map((e) => `${e.action}${e.taskId ? `:${e.taskId}` : ""}`);
    expect(actions).toEqual([
      "session.created",
      `task.created:${queued.id}`,
      `task.created:${held.id}`,
      `task.created:${running.id}`,
      `task.claimed:${held.id}`,
      `task.claimed:${running.id}`,
      `task.started:${running.id}`,
      "session.noted",
      "session.closed",
      `task.cancelled:${queued.id}`,
      `task.cancelled:${held.id}`,
      "session.reopened",
    ]);
  });

  it("creates a task once per idempotency key and turns down kinds the instance doesn't allow", async () => {
    const setup = await make();
    const { service } = harness(setup);
    const { record: session } = await service.createSession({ subject: "Inventory", actor: "owner" });
    const first = await service.createTask({ sessionId: session.id, kind: "reason", input: {}, actor: "console", idempotencyKey: "rerun-1" });
    expect(first.created).toBe(true);
    expect(first.record).toMatchObject({ status: "queued", attempts: 0, lease: null, progress: null, result: null, resultBy: null, error: null, finishedAt: null, input: {} });
    expect(await service.createTask({ sessionId: session.id, kind: "reason", input: {}, actor: "console", idempotencyKey: "rerun-1" })).toEqual({ record: first.record, created: false });
    await rejects(service.createTask({ sessionId: session.id, kind: "ask", input: { question: "x" }, actor: "console", idempotencyKey: "rerun-1" }), "conflict", /different request/);
    await rejects(service.createTask({ sessionId: session.id, kind: "write_back", input: {}, actor: "console" }), "invalid", /write_back isn't a task kind this instance allows; allowed: reason, ask, verify/);
    // A key replayed after its session closed still returns what it created.
    await service.close(session.id, { actor: "owner" });
    expect((await service.createTask({ sessionId: session.id, kind: "reason", input: {}, actor: "console", idempotencyKey: "rerun-1" })).created).toBe(false);
    expect((await service.listTasks({ sessionId: session.id }, 10)).map((t) => t.status)).toEqual(["cancelled"]);
  });

  it("gives a task to one agent at a time, and lets only the lease holder report on it", async () => {
    const setup = await make();
    const { service, advance } = harness(setup);
    const { record: session } = await service.createSession({ subject: "Payouts", actor: "owner" });
    const older = (await service.createTask({ sessionId: session.id, kind: "verify", input: { from: "2026-11-16", to: "2026-11-22" }, actor: "console" })).record;
    advance(1);
    const newer = (await service.createTask({ sessionId: session.id, kind: "ask", input: { question: "q" }, actor: "console" })).record;
    const claimed = await service.claim({}, { agent: "agent-a", leaseSeconds: 60 });
    expect(claimed).toMatchObject({ id: older.id, status: "claimed", attempts: 1, lease: { agent: "agent-a", claimedAt: "2026-11-27T12:00:01.000Z", expiresAt: "2026-11-27T12:01:01.000Z" } });
    const lease = claimed!.lease!.leaseId;
    await rejects(service.claim({ taskId: older.id }, { agent: "agent-b" }), "conflict", /claimed by agent-a until 2026-11-27T12:01:01.000Z/);
    // The next claim takes the next queued task, by kind if asked.
    expect(await service.claim({ kinds: ["reason"] }, { agent: "agent-b" })).toBeNull();
    expect(await service.claim({ sessionId: "ses_other" }, { agent: "agent-b" })).toBeNull();
    const second = await service.claim({ kinds: ["ask"], sessionId: session.id }, { agent: "agent-b" });
    expect(second?.id).toBe(newer.id);
    expect(await service.claim({}, { agent: "agent-c" })).toBeNull();

    advance(30);
    const progressed = await service.progress(older.id, { leaseId: lease, message: "Read Stripe's payouts", percent: 40, leaseSeconds: 120 });
    expect(progressed).toMatchObject({ progress: { message: "Read Stripe's payouts", percent: 40, at: "2026-11-27T12:00:31.000Z" }, lease: { expiresAt: "2026-11-27T12:02:31.000Z" } });
    await rejects(service.progress(older.id, { leaseId: second!.lease!.leaseId, message: "not mine" }), "conflict", /no longer held/);
    await rejects(service.progress(older.id, { leaseId: lease, message: "x", leaseSeconds: 5 }), "invalid", /leaseSeconds must be a whole number from 10 to 3600/);
    await rejects(service.claim({}, { agent: "a", leaseSeconds: 3601 }), "invalid", /leaseSeconds/);
    await rejects(service.claim({}, { agent: "a", leaseSeconds: 10.5 }), "invalid", /leaseSeconds/);
    await rejects(service.complete(older.id, { leaseId: "lease_wrong", outcome: "succeeded" }), "conflict", /no longer held/);
    const done = await service.complete(older.id, { leaseId: lease, outcome: "succeeded", result: { matched: 4, missing: [] } });
    expect(done).toMatchObject({ status: "succeeded", result: { matched: 4, missing: [] }, resultBy: "agent", error: null, finishedAt: "2026-11-27T12:00:31.000Z" });
    await rejects(service.complete(older.id, { leaseId: lease, outcome: "succeeded" }), "conflict", /already succeeded/);
    await rejects(service.progress(older.id, { leaseId: lease, message: "x" }), "conflict", /already succeeded/);
    await rejects(service.cancel(older.id, { actor: "owner" }), "conflict", /already succeeded/);
    await rejects(service.claim({ taskId: older.id }, { agent: "agent-b" }), "conflict", /the task is succeeded, so it can't be claimed/);
    await rejects(service.claim({ taskId: "task_nope" }, { agent: "agent-b" }), "not_found", /task not found/);
    const failed = await service.complete(newer.id, { leaseId: second!.lease!.leaseId, outcome: "failed", error: "couldn't reach the instance" });
    expect(failed).toMatchObject({ status: "failed", error: "couldn't reach the instance", result: null, resultBy: "agent" });
    expect((await service.audit({ sessionId: session.id, taskId: older.id })).map((e) => [e.action, e.actor, e.detail])).toEqual([
      ["task.created", "console", { kind: "verify" }],
      ["task.claimed", "agent-a", { leaseSeconds: 60 }],
      ["task.progress", "agent", { percent: 40 }],
      ["task.succeeded", "agent", {}],
    ]);
    expect((await service.audit({ sessionId: session.id, taskId: newer.id })).at(-1)).toMatchObject({ action: "task.failed", detail: { error: "couldn't reach the instance" } });
    expect(await service.audit({ sessionId: session.id }, 2)).toHaveLength(2);
    expect(await service.audit({ sessionId: session.id }, 0)).toEqual([]);
  });

  it("puts a task back in the queue when its lease runs out, turns the old lease down, and fails it after its attempts", async () => {
    const setup = await make();
    const { service, advance } = harness(setup);
    const { record: session } = await service.createSession({ subject: "Inventory", actor: "owner" });
    const task = (await service.createTask({ sessionId: session.id, kind: "reason", input: {}, actor: "console" })).record;
    const first = await service.claim({ taskId: task.id }, { agent: "agent-a", leaseSeconds: 10 });
    advance(9.999);
    expect((await service.task(task.id)).status).toBe("claimed");
    await service.progress(task.id, { leaseId: first!.lease!.leaseId, message: "still here", leaseSeconds: 10 });
    advance(10);
    // Exactly at the end of the lease it has run out.
    expect(await service.task(task.id)).toMatchObject({ status: "queued", lease: null, attempts: 1 });
    await rejects(service.progress(task.id, { leaseId: first!.lease!.leaseId, message: "too late" }), "conflict", /no longer held/);
    await rejects(service.complete(task.id, { leaseId: first!.lease!.leaseId, outcome: "succeeded" }), "conflict", /no longer held/);
    await rejects(service.start(task.id, first!.lease!.leaseId), "conflict", /no longer held/);
    const second = await service.claim({}, { agent: "agent-b", leaseSeconds: 10 });
    expect(second).toMatchObject({ id: task.id, attempts: 2, lease: { agent: "agent-b" } });
    await rejects(service.complete(task.id, { leaseId: first!.lease!.leaseId, outcome: "succeeded" }), "conflict", /no longer held/);
    // A running task's lease is stretched for the run, and runs out too if the instance stopped mid-run.
    const started = await service.start(task.id, second!.lease!.leaseId);
    expect(started.status).toBe("running");
    expect(Date.parse(started.lease!.expiresAt) - Date.parse(started.updatedAt)).toBe(TASK_RUN_LEASE_SECONDS * 1000);
    await rejects(service.start(task.id, second!.lease!.leaseId), "conflict", /the task is running/);
    await rejects(service.complete(task.id, { leaseId: second!.lease!.leaseId, outcome: "succeeded" }), "conflict", /the task is running/);
    await rejects(service.cancel(task.id, { actor: "owner" }), "conflict", /running and can't be cancelled/);
    advance(TASK_RUN_LEASE_SECONDS);
    expect((await service.listTasks({}, 10))[0]).toMatchObject({ status: "queued", attempts: 2 });
    await rejects(service.finishRun(task.id, second!.lease!.leaseId, { result: {} }), "conflict", /no longer held/);
    const third = await service.claim({}, { agent: "agent-c", leaseSeconds: 10 });
    expect(third!.attempts).toBe(3);
    advance(10);
    expect(await service.task(task.id)).toMatchObject({ status: "failed", error: "the lease ran out 3 times without the task finishing", finishedAt: "2026-11-27T12:15:29.999Z", lease: { agent: "agent-c" } });
    expect(await service.claim({}, { agent: "agent-d" })).toBeNull();
    const expiries = (await service.audit({ sessionId: session.id, taskId: task.id })).filter((e) => e.action === "task.lease_expired");
    expect(expiries.map((e) => [e.actor, e.detail])).toEqual([
      ["brain", { agent: "agent-a", attempts: 1, requeued: true }],
      ["brain", { agent: "agent-b", attempts: 2, requeued: true }],
      ["brain", { agent: "agent-c", attempts: 3, requeued: false }],
    ]);
  });

  it("checks the lease as it changes the task, clears old progress on a new claim, and says why it turned a call down", async () => {
    const setup = await make();
    const { service, advance } = harness(setup);
    const { record: session } = await service.createSession({ subject: "Leases", actor: "owner" });
    const task = (await service.createTask({ sessionId: session.id, kind: "ask", input: {}, actor: "c" })).record;
    const first = await service.claim({ taskId: task.id }, { agent: "agent-a", leaseSeconds: 10 });
    await service.progress(task.id, { leaseId: first!.lease!.leaseId, message: "halfway", leaseSeconds: 10 });
    advance(10);
    // Nothing has read the task since its lease ran out: the store itself must see that it did.
    await rejects(service.progress(task.id, { leaseId: first!.lease!.leaseId, message: "late" }), "conflict", /no longer held/);
    const second = await service.claim({}, { agent: "agent-b" });
    expect(second).toMatchObject({ id: task.id, progress: null });
    await service.start(task.id, second!.lease!.leaseId);
    await rejects(service.claim({ taskId: task.id }, { agent: "agent-c" }), "conflict", /the task is running by agent-b until/);
    const other = (await service.createTask({ sessionId: session.id, kind: "ask", input: {}, actor: "c" })).record;
    const held = await service.claim({ taskId: other.id }, { agent: "agent-a" });
    await service.cancel(other.id, { actor: "owner" });
    await rejects(service.progress(other.id, { leaseId: held!.lease!.leaseId, message: "x" }), "conflict", /the task is already cancelled/);
    expect((await service.audit({ sessionId: session.id }, 2)).map((e) => e.action)).toEqual(["task.claimed", "task.cancelled"]);
  });

  it("links each thing once at the store, by kind, id and entity kind", async () => {
    const setup = await make();
    const { service } = harness(setup);
    const { record: session } = await service.createSession({ subject: "Links", actor: "owner" });
    const link = (kind: "event" | "signal" | "entity", id: string, entityKind?: string) => ({ kind, id, ...(entityKind ? { entityKind } : {}), addedBy: "a", addedAt: "2026-11-27T12:00:00.000Z" });
    const audit = { action: "session.linked" as const, actor: "a", at: "2026-11-27T12:00:00.000Z", detail: {} };
    await setup.store.changeSession(ORG, session.id, { kind: "links", at: audit.at, links: [link("event", "x1"), link("entity", "c1", "customer")], maxLinks: 4 }, audit);
    const changed = await setup.store.changeSession(ORG, session.id, { kind: "links", at: audit.at, links: [link("event", "x1"), link("signal", "x1"), link("entity", "c1", "customer"), link("entity", "c1", "product")], maxLinks: 4 }, audit);
    expect(changed!.links.map((l) => `${l.kind}:${l.entityKind ?? ""}:${l.id}`)).toEqual(["event::x1", "entity:customer:c1", "signal::x1", "entity:product:c1"]);
    expect(await setup.store.changeSession(ORG, session.id, { kind: "links", at: audit.at, links: [link("signal", "x2")], maxLinks: 4 }, audit)).toBeNull();
  });

  it("records the instance's own run of a task", async () => {
    const setup = await make();
    const { service } = harness(setup);
    const { record: session } = await service.createSession({ subject: "Inventory", actor: "owner" });
    const ok = (await service.createTask({ sessionId: session.id, kind: "reason", input: {}, actor: "console" })).record;
    const bad = (await service.createTask({ sessionId: session.id, kind: "ask", input: {}, actor: "console" })).record;
    const a = await service.claim({ taskId: ok.id }, { agent: "agent" });
    await rejects(service.finishRun(ok.id, a!.lease!.leaseId, { result: {} }), "conflict", /the task changed/);
    await service.start(ok.id, a!.lease!.leaseId);
    expect(await service.finishRun(ok.id, a!.lease!.leaseId, { result: { recommendations: [] } })).toMatchObject({ status: "succeeded", result: { recommendations: [] }, resultBy: "brain", error: null });
    const b = await service.claim({ taskId: bad.id }, { agent: "agent" });
    await service.start(bad.id, b!.lease!.leaseId);
    expect(await service.finishRun(bad.id, b!.lease!.leaseId, { error: "the operation failed (TypeError)" })).toMatchObject({ status: "failed", result: null, resultBy: "brain", error: "the operation failed (TypeError)" });
    const trail = (await service.audit({ sessionId: session.id, taskId: bad.id })).map((e) => [e.action, e.actor]);
    expect(trail).toEqual([["task.created", "console"], ["task.claimed", "agent"], ["task.started", "brain"], ["task.failed", "brain"]]);
  });

  it("cancels a queued or claimed task, and lists tasks newest first by session and status", async () => {
    const setup = await make();
    const { service, advance } = harness(setup);
    const one = (await service.createSession({ subject: "One", actor: "owner" })).record;
    const two = (await service.createSession({ subject: "Two", actor: "owner" })).record;
    const t1 = (await service.createTask({ sessionId: one.id, kind: "ask", input: { question: "a" }, actor: "c" })).record;
    advance(1);
    const t2 = (await service.createTask({ sessionId: two.id, kind: "ask", input: { question: "b" }, actor: "c" })).record;
    advance(1);
    const t3 = (await service.createTask({ sessionId: one.id, kind: "ask", input: { question: "c" }, actor: "c" })).record;
    expect((await service.listTasks({}, 10)).map((t) => t.id)).toEqual([t3.id, t2.id, t1.id]);
    expect((await service.listTasks({}, 2)).map((t) => t.id)).toEqual([t3.id, t2.id]);
    expect((await service.listTasks({ sessionId: one.id }, 10)).map((t) => t.id)).toEqual([t3.id, t1.id]);
    await service.claim({ taskId: t3.id }, { agent: "a" });
    expect((await service.cancel(t3.id, { actor: "owner", reason: "not needed" }))).toMatchObject({ status: "cancelled", finishedAt: "2026-11-27T12:00:02.000Z" });
    expect(await service.cancel(t1.id, { actor: "owner" })).toMatchObject({ status: "cancelled" });
    await rejects(service.cancel("task_nope", { actor: "owner" }), "not_found", /task not found/);
    expect((await service.listTasks({ status: "cancelled" }, 10)).map((t) => t.id)).toEqual([t3.id, t1.id]);
    expect((await service.listTasks({ status: "queued", sessionId: two.id }, 10)).map((t) => t.id)).toEqual([t2.id]);
    expect((await service.audit({ sessionId: one.id, taskId: t3.id })).at(-1)).toMatchObject({ action: "task.cancelled", actor: "owner", detail: { reason: "not needed" } });
    // Sessions list most recently changed first.
    advance(1);
    await service.addNote(one.id, { actor: "owner", text: "bump" });
    expect((await service.listSessions(null, 10)).map((s) => s.id)).toEqual([one.id, two.id]);
    expect((await service.listSessions(null, 1)).map((s) => s.id)).toEqual([one.id]);
  });

  it("picks up after a restart: sessions, tasks, leases and the audit trail are all still there", async () => {
    const setup = await make();
    if (!setup.reopen) return;
    const before = harness(setup);
    const { record: session } = await before.service.createSession({ subject: "Why did repairs slow down?", actor: "owner", idempotencyKey: "repairs-q4" });
    await before.service.addNote(session.id, { actor: "agent", text: "Checked the bench" });
    const task = (await before.service.createTask({ sessionId: session.id, kind: "reason", input: {}, actor: "console", idempotencyKey: "rerun" })).record;
    const claim = await before.service.claim({ taskId: task.id }, { agent: "agent-a", leaseSeconds: 60 });

    // A new process: a new store over the same database, with its own clock.
    const after = harness(setup, ORG, setup.reopen());
    after.clock.now = new Date(before.clock.now.getTime() + 30_000);
    expect(await after.service.session(session.id)).toEqual(await before.service.session(session.id));
    expect((await after.service.createSession({ subject: "Why did repairs slow down?", actor: "owner", idempotencyKey: "repairs-q4" })).created).toBe(false);
    expect((await after.service.createTask({ sessionId: session.id, kind: "reason", input: {}, actor: "console", idempotencyKey: "rerun" })).record.id).toBe(task.id);
    // The lease survived the restart, and the same agent can carry on.
    expect(await after.service.task(task.id)).toMatchObject({ status: "claimed", lease: { agent: "agent-a", leaseId: claim!.lease!.leaseId } });
    await after.service.progress(task.id, { leaseId: claim!.lease!.leaseId, message: "resumed", leaseSeconds: 10 });
    after.clock.now = new Date(after.clock.now.getTime() + 10_000);
    expect((await after.service.task(task.id)).status).toBe("queued");
    const audit = await after.service.audit({ sessionId: session.id });
    expect(audit.map((e) => e.action)).toEqual(["session.created", "session.noted", "task.created", "task.claimed", "task.progress", "task.lease_expired"]);
  });

  it("keeps the audit trail append-only and each organization's work to itself in the database", async () => {
    const setup = await make();
    if (!setup.client) return;
    const { service } = harness(setup);
    const { record } = await service.createSession({ subject: "Ours", actor: "owner" });
    await harness(setup, OTHER).service.createSession({ subject: "Theirs", actor: "owner" });
    const client = setup.client;
    await expect(client.query("update work_audit set actor = 'someone'")).rejects.toThrow(/append-only/);
    await expect(client.query("delete from work_audit")).rejects.toThrow(/append-only/);
    await expect(client.query("update reasoning_sessions set status = 'closed'")).rejects.toThrow(/check constraint/);
    await expect(
      client.query("insert into agent_tasks (organization_id, id, session_id, kind, status, created_by, created_at, updated_at) values ($1, 't', $2, 'ask', 'claimed', 'c', now(), now())", [ORG, record.id]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      client.query("insert into agent_tasks (organization_id, id, session_id, kind, status, created_by, created_at, updated_at) values ($1, 't', 'ses_missing', 'ask', 'queued', 'c', now(), now())", [ORG]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      client.query("insert into agent_tasks (organization_id, id, session_id, kind, status, created_by, created_at, updated_at, lease_id) values ($1, 't', $2, 'ask', 'queued', 'c', now(), now(), 'lease_x')", [ORG, record.id]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      client.query("insert into agent_tasks (organization_id, id, session_id, kind, status, created_by, created_at, updated_at) values ($1, 't', $2, 'ask', 'succeeded', 'c', now(), now())", [ORG, record.id]),
    ).rejects.toThrow(/check constraint/);
    await client.query(`
      create role work_reader;
      grant select, insert on all tables in schema public to work_reader;
      set role work_reader;
      select set_config('request.jwt.claims', '{"organization_id": "${ORG}"}', false);
    `);
    for (const table of ["reasoning_sessions", "work_audit"]) {
      const { rows } = await client.query<{ organization_id: string }>(`select distinct organization_id from ${table}`);
      expect(rows, table).toEqual([{ organization_id: ORG }]);
    }
    await expect(client.query("insert into work_audit (organization_id, session_id, action, actor, at) values ($1, 's', 'session.created', 'x', now())", [OTHER])).rejects.toThrow(/row-level security/);
  });
});
