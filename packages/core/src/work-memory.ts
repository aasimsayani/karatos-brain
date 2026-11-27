import {
  expiredLease,
  newLinks,
  type AgentTask,
  type HeldTaskChange,
  type IdempotencyClaim,
  type Inserted,
  type ReasoningSession,
  type SessionChange,
  type SessionStatus,
  type TaskLease,
  type TaskPick,
  type TaskStatus,
  type WorkAuditDraft,
  type WorkAuditEntry,
  type WorkStore,
} from "./work.js";

const byTime = (a: string, b: string) => Date.parse(a) - Date.parse(b);

/** In-process WorkStore for tests and local experiments. Records are copied in and out, as a database would. */
export class InMemoryWorkStore implements WorkStore {
  readonly sessions = new Map<string, ReasoningSession>();
  readonly tasks = new Map<string, AgentTask>();
  readonly audit: WorkAuditEntry[] = [];
  private readonly keys = new Map<string, { id: string; requestHash: string }>();

  private record(organizationId: string, sessionId: string, taskId: string | null, draft: WorkAuditDraft): void {
    this.audit.push(structuredClone({ organizationId, sessionId, taskId, ...draft }));
  }

  async insertSession(session: ReasoningSession, idempotency: IdempotencyClaim | null, audit: WorkAuditDraft): Promise<Inserted<ReasoningSession>> {
    const keyed = idempotency ? `session:${session.organizationId}:${idempotency.key}` : null;
    const used = keyed ? this.keys.get(keyed) : undefined;
    if (used) return { record: structuredClone(this.sessions.get(`${session.organizationId}:${used.id}`)!), created: false, requestHash: used.requestHash };
    this.sessions.set(`${session.organizationId}:${session.id}`, structuredClone(session));
    if (keyed) this.keys.set(keyed, { id: session.id, requestHash: idempotency!.requestHash });
    this.record(session.organizationId, session.id, null, audit);
    return { record: structuredClone(session), created: true, requestHash: idempotency?.requestHash ?? null };
  }

  async getSession(organizationId: string, id: string): Promise<ReasoningSession | null> {
    const found = this.sessions.get(`${organizationId}:${id}`);
    return found ? structuredClone(found) : null;
  }

  async listSessions(organizationId: string, status: SessionStatus | null, limit: number): Promise<ReasoningSession[]> {
    return [...this.sessions.values()]
      .filter((s) => s.organizationId === organizationId && (status === null || s.status === status))
      .sort((a, b) => byTime(b.updatedAt, a.updatedAt) || (a.id < b.id ? 1 : -1))
      .slice(0, Math.max(0, limit))
      .map((s) => structuredClone(s));
  }

  async changeSession(organizationId: string, id: string, change: SessionChange, audit: WorkAuditDraft): Promise<ReasoningSession | null> {
    const found = this.sessions.get(`${organizationId}:${id}`);
    if (!found || found.status !== (change.kind === "reopen" ? "closed" : "open")) return null;
    const next = structuredClone(found);
    if (change.kind === "note") {
      if (next.notes.length >= change.maxNotes) return null;
      next.notes.push(structuredClone(change.note));
    } else if (change.kind === "links") {
      const links = [...next.links, ...newLinks(next.links, change.links)];
      if (links.length > change.maxLinks) return null;
      next.links = structuredClone(links);
    } else if (change.kind === "close") {
      next.status = "closed";
      next.closedAt = change.at;
    } else {
      next.status = "open";
      next.closedAt = null;
    }
    next.updatedAt = change.at;
    this.sessions.set(`${organizationId}:${id}`, next);
    this.record(organizationId, id, null, audit);
    return structuredClone(next);
  }

  async insertTask(task: AgentTask, idempotency: IdempotencyClaim | null, audit: WorkAuditDraft): Promise<Inserted<AgentTask> | null> {
    const keyed = idempotency ? `task:${task.organizationId}:${idempotency.key}` : null;
    const used = keyed ? this.keys.get(keyed) : undefined;
    if (used) return { record: structuredClone(this.tasks.get(`${task.organizationId}:${used.id}`)!), created: false, requestHash: used.requestHash };
    if (this.sessions.get(`${task.organizationId}:${task.sessionId}`)?.status !== "open") return null;
    this.tasks.set(`${task.organizationId}:${task.id}`, structuredClone(task));
    if (keyed) this.keys.set(keyed, { id: task.id, requestHash: idempotency!.requestHash });
    this.record(task.organizationId, task.sessionId, task.id, audit);
    return { record: structuredClone(task), created: true, requestHash: idempotency?.requestHash ?? null };
  }

  async getTask(organizationId: string, id: string): Promise<AgentTask | null> {
    const found = this.tasks.get(`${organizationId}:${id}`);
    return found ? structuredClone(found) : null;
  }

  private ofOrg(organizationId: string): AgentTask[] {
    return [...this.tasks.values()].filter((t) => t.organizationId === organizationId);
  }

  async listTasks(organizationId: string, filter: { sessionId?: string; status?: TaskStatus }, limit: number): Promise<AgentTask[]> {
    return this.ofOrg(organizationId)
      .filter((t) => (filter.sessionId === undefined || t.sessionId === filter.sessionId) && (filter.status === undefined || t.status === filter.status))
      .sort((a, b) => byTime(b.createdAt, a.createdAt) || (a.id < b.id ? 1 : -1))
      .slice(0, Math.max(0, limit))
      .map((t) => structuredClone(t));
  }

  async expireLeases(organizationId: string, now: string, maxAttempts: number): Promise<number> {
    let changed = 0;
    for (const task of this.ofOrg(organizationId)) {
      if ((task.status !== "claimed" && task.status !== "running") || !task.lease || byTime(task.lease.expiresAt, now) > 0) continue;
      const expired = expiredLease(task, now, maxAttempts);
      this.tasks.set(`${organizationId}:${task.id}`, expired.task);
      this.record(organizationId, task.sessionId, task.id, expired.audit);
      changed++;
    }
    return changed;
  }

  async claimTask(organizationId: string, pick: TaskPick, lease: TaskLease, audit: WorkAuditDraft): Promise<AgentTask | null> {
    const queued = this.ofOrg(organizationId)
      .filter((t) => t.status === "queued")
      .filter((t) =>
        "taskId" in pick ? t.id === pick.taskId : (pick.sessionId === undefined || t.sessionId === pick.sessionId) && (pick.kinds === undefined || pick.kinds.includes(t.kind)),
      )
      .sort((a, b) => byTime(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : 1));
    const found = queued[0];
    if (!found) return null;
    const next: AgentTask = { ...found, status: "claimed", attempts: found.attempts + 1, lease: { ...lease }, progress: null, updatedAt: lease.claimedAt };
    this.tasks.set(`${organizationId}:${found.id}`, next);
    this.record(organizationId, found.sessionId, found.id, audit);
    return structuredClone(next);
  }

  async changeHeldTask(organizationId: string, id: string, leaseId: string, change: HeldTaskChange, audit: WorkAuditDraft): Promise<AgentTask | null> {
    const found = this.tasks.get(`${organizationId}:${id}`);
    if (!found?.lease || found.lease.leaseId !== leaseId) return null;
    const from = change.kind === "finish" ? change.from : "claimed";
    if (found.status !== from) return null;
    const live = byTime(found.lease.expiresAt, change.at) > 0;
    if (from === "claimed" && !live) return null;
    let next: AgentTask;
    if (change.kind === "progress") {
      next = { ...found, progress: { ...change.progress }, lease: { ...found.lease, expiresAt: change.expiresAt }, updatedAt: change.at };
    } else if (change.kind === "start") {
      next = { ...found, status: "running", lease: { ...found.lease, expiresAt: change.expiresAt }, updatedAt: change.at };
    } else {
      next = { ...found, status: change.status, result: structuredClone(change.result), resultBy: change.resultBy, error: change.error, finishedAt: change.at, updatedAt: change.at };
    }
    this.tasks.set(`${organizationId}:${id}`, next);
    this.record(organizationId, found.sessionId, id, audit);
    return structuredClone(next);
  }

  async cancelTask(organizationId: string, id: string, at: string, audit: WorkAuditDraft): Promise<AgentTask | null> {
    const found = this.tasks.get(`${organizationId}:${id}`);
    if (!found || (found.status !== "queued" && found.status !== "claimed")) return null;
    const next: AgentTask = { ...found, status: "cancelled", finishedAt: at, updatedAt: at };
    this.tasks.set(`${organizationId}:${id}`, next);
    this.record(organizationId, found.sessionId, id, audit);
    return structuredClone(next);
  }

  async listWorkAudit(organizationId: string, filter: { sessionId: string; taskId?: string }, limit: number): Promise<WorkAuditEntry[]> {
    const entries = this.audit.filter((e) => e.organizationId === organizationId && e.sessionId === filter.sessionId && (filter.taskId === undefined || e.taskId === filter.taskId));
    return (limit > 0 ? entries.slice(-limit) : []).map((e) => structuredClone(e));
  }
}
