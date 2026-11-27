import { describe, expect, it } from "vitest";
import {
  createWorkService,
  DEFAULT_TASK_LEASE_SECONDS,
  expiredLease,
  MAX_SESSION_LINKS,
  MAX_SESSION_NOTES,
  MAX_TASK_ATTEMPTS,
  MAX_TASK_LEASE_SECONDS,
  MIN_TASK_LEASE_SECONDS,
  TASK_RUN_LEASE_SECONDS,
  InMemoryStore,
  InMemoryWorkStore,
  newLinks,
  taskView,
  type AgentTask,
  type SessionLink,
} from "../src/index.js";

const task: AgentTask = {
  id: "task_1",
  organizationId: "org",
  sessionId: "ses_1",
  kind: "ask",
  input: { question: "q" },
  status: "claimed",
  createdBy: "console",
  createdAt: "2026-11-27T12:00:00.000Z",
  updatedAt: "2026-11-27T12:00:00.000Z",
  attempts: 1,
  lease: { agent: "agent-a", leaseId: "lease_secret", claimedAt: "2026-11-27T12:00:00.000Z", expiresAt: "2026-11-27T12:05:00.000Z" },
  progress: null,
  result: null,
  resultBy: null,
  error: null,
  finishedAt: null,
};

describe("agent task helpers", () => {
  it("keeps the limits the docs and the migration's checks state", () => {
    expect([MAX_SESSION_NOTES, MAX_SESSION_LINKS]).toEqual([200, 500]);
    expect([DEFAULT_TASK_LEASE_SECONDS, MIN_TASK_LEASE_SECONDS, MAX_TASK_LEASE_SECONDS, TASK_RUN_LEASE_SECONDS, MAX_TASK_ATTEMPTS]).toEqual([300, 10, 3_600, 900, 3]);
  });

  it("shows a task without its lease id", () => {
    expect(taskView(task).lease).toEqual({ agent: "agent-a", claimedAt: "2026-11-27T12:00:00.000Z", expiresAt: "2026-11-27T12:05:00.000Z" });
    expect(JSON.stringify(taskView(task))).not.toContain("lease_secret");
    expect(taskView({ ...task, status: "queued", lease: null }).lease).toBeNull();
    // The task itself keeps it.
    expect(task.lease?.leaseId).toBe("lease_secret");
  });

  it("requeues a task whose lease ran out, or fails it once it has had its attempts", () => {
    const at = "2026-11-27T12:05:00.000Z";
    expect(expiredLease(task, at, 3)).toEqual({
      task: { ...task, status: "queued", lease: null, updatedAt: at },
      audit: { action: "task.lease_expired", actor: "brain", at, detail: { agent: "agent-a", attempts: 1, requeued: true } },
    });
    const failed = expiredLease({ ...task, attempts: 3 }, at, 3);
    expect(failed.task).toMatchObject({ status: "failed", error: "the lease ran out 3 times without the task finishing", finishedAt: at, lease: task.lease });
    expect(failed.audit.detail).toEqual({ agent: "agent-a", attempts: 3, requeued: false });
    expect(expiredLease({ ...task, attempts: 2 }, at, 3).task.status).toBe("queued");
    expect(expiredLease({ ...task, lease: null }, at, 3).audit.detail.agent).toBeNull();
  });

  it("keeps only links not already there, each once, by kind, id and entity kind", () => {
    const link = (kind: SessionLink["kind"], id: string, entityKind?: string): SessionLink => ({ kind, id, ...(entityKind ? { entityKind } : {}), addedBy: "a", addedAt: "t" });
    const existing = [link("event", "e1"), link("entity", "c1", "customer")];
    expect(newLinks(existing, [link("event", "e1"), link("signal", "e1"), link("entity", "c1", "product"), link("entity", "c1", "customer"), link("signal", "e1")])).toEqual([
      link("signal", "e1"),
      link("entity", "c1", "product"),
    ]);
  });

  it("makes ids, times and leases on its own when not given them", async () => {
    const service = createWorkService({ store: new InMemoryWorkStore(), memory: new InMemoryStore(), organizationId: "org", kinds: ["ask"] });
    const before = Date.now();
    const { record: session } = await service.createSession({ subject: "s", actor: "owner" });
    expect(session.id).toMatch(/^ses_[0-9a-f-]{36}$/);
    expect(Date.parse(session.createdAt)).toBeGreaterThanOrEqual(before);
    const { record } = await service.createTask({ sessionId: session.id, kind: "ask", input: {}, actor: "c" });
    expect(record.id).toMatch(/^task_/);
    const claimed = await service.claim({}, { agent: "a" });
    expect(claimed!.lease!.leaseId).toMatch(/^lease_[0-9a-f-]{36}$/);
    expect(Date.parse(claimed!.lease!.expiresAt) - Date.parse(claimed!.lease!.claimedAt)).toBe(DEFAULT_TASK_LEASE_SECONDS * 1000);
    expect(service.kinds).toEqual(["ask"]);
    expect(service.organizationId).toBe("org");
  });

  it("fails a task after the attempts it is given", async () => {
    let now = new Date("2026-11-27T12:00:00.000Z");
    const service = createWorkService({ store: new InMemoryWorkStore(), memory: new InMemoryStore(), organizationId: "org", kinds: ["ask"], now: () => now, maxAttempts: 1 });
    const { record: session } = await service.createSession({ subject: "s", actor: "owner" });
    const { record } = await service.createTask({ sessionId: session.id, kind: "ask", input: {}, actor: "c" });
    await service.claim({}, { agent: "a", leaseSeconds: 10 });
    now = new Date(now.getTime() + 10_000);
    expect((await service.task(record.id)).status).toBe("failed");
  });
});
