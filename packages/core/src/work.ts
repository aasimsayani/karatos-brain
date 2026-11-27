import { randomUUID } from "node:crypto";
import type { MemoryStore } from "./layers.js";
import { sha256Json } from "./retention.js";

/**
 * Reasoning sessions and agent tasks: the work around one question, kept in
 * the store so it can be picked up again after a restart.
 *
 * A session groups what was looked at for one subject ("why did repairs slow
 * down"): notes, links to the recommendations and evidence it touched, and
 * the tasks run for it. A task is one read-only operation (reasoning, an
 * answer, a brief, a sync check and the like) that an outside agent or the
 * Brain Console queues, claims under a lease that runs out, reports progress
 * on and finishes. No task writes to a vendor's system: the kinds an instance
 * allows are its read-only operations, and writes still go only through the
 * WriteGate. Every change is kept in an append-only audit trail.
 */

export const SESSION_STATUSES = ["open", "closed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** What a session can link to: recommendations, and the evidence behind them. */
export const SESSION_LINK_KINDS = ["recommendation", "event", "entity", "signal", "reasoning_run"] as const;
export type SessionLinkKind = (typeof SESSION_LINK_KINDS)[number];

export interface SessionNote {
  text: string;
  actor: string;
  at: string;
}

export interface SessionLink {
  kind: SessionLinkKind;
  id: string;
  /** For an entity link: the entity's kind, such as customer. */
  entityKind?: string;
  note?: string;
  addedBy: string;
  addedAt: string;
}

export interface ReasoningSession {
  id: string;
  organizationId: string;
  subject: string;
  status: SessionStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** When it was last closed; null while open. */
  closedAt: string | null;
  /** Oldest first. */
  notes: SessionNote[];
  /** Oldest first, one per thing linked. */
  links: SessionLink[];
}

export const TASK_STATUSES = ["queued", "claimed", "running", "succeeded", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses a task never leaves. */
export const FINISHED_TASK_STATUSES: readonly TaskStatus[] = ["succeeded", "failed", "cancelled"];

export interface TaskLease {
  agent: string;
  /** Given only to the agent that claimed the task; every later call on the task must carry it. */
  leaseId: string;
  claimedAt: string;
  expiresAt: string;
}

export interface TaskProgress {
  message: string;
  /** 0 to 100, when the agent can say. */
  percent?: number;
  at: string;
}

export interface AgentTask {
  id: string;
  organizationId: string;
  sessionId: string;
  kind: string;
  input: Record<string, unknown>;
  status: TaskStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** How many times it has been claimed. */
  attempts: number;
  /** The current or last claim; null until it is first claimed, and again after a lease runs out. */
  lease: TaskLease | null;
  progress: TaskProgress | null;
  result: Record<string, unknown> | null;
  /** "brain" when the instance ran the task's operation, "agent" when the agent reported the result itself. */
  resultBy: "brain" | "agent" | null;
  error: string | null;
  finishedAt: string | null;
}

export const WORK_ACTIONS = [
  "session.created",
  "session.noted",
  "session.linked",
  "session.closed",
  "session.reopened",
  "task.created",
  "task.claimed",
  "task.progress",
  "task.started",
  "task.lease_expired",
  "task.succeeded",
  "task.failed",
  "task.cancelled",
] as const;
export type WorkAction = (typeof WORK_ACTIONS)[number];

/** One change to a session or task. Append-only. */
export interface WorkAuditEntry {
  organizationId: string;
  sessionId: string;
  taskId: string | null;
  action: WorkAction;
  actor: string;
  at: string;
  detail: Record<string, unknown>;
}

/** An audit entry before the store fills in which session and task it is about. */
export type WorkAuditDraft = Omit<WorkAuditEntry, "organizationId" | "sessionId" | "taskId">;

/** An idempotency key with a hash of the request it came with, so a reused key with a different request is caught. */
export interface IdempotencyClaim {
  key: string;
  requestHash: string;
}

export interface Inserted<T> {
  record: T;
  /** False when the idempotency key was already used and record is what it created then. */
  created: boolean;
  /** The request hash stored with the key; null when the record has no key. */
  requestHash: string | null;
}

export type SessionChange =
  | { kind: "note"; at: string; note: SessionNote; maxNotes: number }
  | { kind: "links"; at: string; links: SessionLink[]; maxLinks: number }
  | { kind: "close"; at: string }
  | { kind: "reopen"; at: string };

/** Which queued task to claim: one by id, or the oldest queued one, optionally of a session or of some kinds. */
export type TaskPick = { taskId: string } | { sessionId?: string; kinds?: readonly string[] };

export type HeldTaskChange =
  | { kind: "progress"; at: string; progress: TaskProgress; expiresAt: string }
  | { kind: "start"; at: string; expiresAt: string }
  | {
      kind: "finish";
      at: string;
      /** The status the task must be in: claimed when the agent reports, running when the instance ran it. */
      from: "claimed" | "running";
      status: "succeeded" | "failed";
      result: Record<string, unknown> | null;
      resultBy: "brain" | "agent";
      error: string | null;
    };

/**
 * Where sessions, tasks and their audit trail are kept. Every change is one
 * atomic step that also writes its audit entry, and each one checks the
 * state it needs (an open session, a live lease) as it changes it, so two
 * agents racing for the same task never both get it.
 */
export interface WorkStore {
  /** Saves a new session, unless the idempotency key was used before: then returns what that call created. */
  insertSession(session: ReasoningSession, idempotency: IdempotencyClaim | null, audit: WorkAuditDraft): Promise<Inserted<ReasoningSession>>;
  getSession(organizationId: string, id: string): Promise<ReasoningSession | null>;
  /** Most recently changed first. */
  listSessions(organizationId: string, status: SessionStatus | null, limit: number): Promise<ReasoningSession[]>;
  /**
   * Notes, links and closing need an open session, reopening a closed one. A
   * note or links that would take the session past its limit change nothing.
   * Links already on the session are left as they are. Null when nothing changed.
   */
  changeSession(organizationId: string, id: string, change: SessionChange, audit: WorkAuditDraft): Promise<ReasoningSession | null>;
  /**
   * Saves a new queued task if its session is open, unless the idempotency key
   * was used before: then returns what that call created. Null when the session
   * isn't open (or doesn't exist) and the key is new.
   */
  insertTask(task: AgentTask, idempotency: IdempotencyClaim | null, audit: WorkAuditDraft): Promise<Inserted<AgentTask> | null>;
  getTask(organizationId: string, id: string): Promise<AgentTask | null>;
  /** Most recently created first. */
  listTasks(organizationId: string, filter: { sessionId?: string; status?: TaskStatus }, limit: number): Promise<AgentTask[]>;
  /**
   * Claimed and running tasks whose lease ran out by `now` go back to queued,
   * or to failed once claimed `maxAttempts` times. Returns how many changed.
   */
  expireLeases(organizationId: string, now: string, maxAttempts: number): Promise<number>;
  /** Claims a queued task (the oldest that fits, for a pick that isn't by id), counting an attempt. Null when none fits. */
  claimTask(organizationId: string, pick: TaskPick, lease: TaskLease, audit: WorkAuditDraft): Promise<AgentTask | null>;
  /**
   * A change by the agent holding the lease. Progress and start need the task
   * claimed with its lease live at `at`; a finish needs it in `from`, with the
   * lease live when from is claimed. Null when that doesn't hold.
   */
  changeHeldTask(organizationId: string, id: string, leaseId: string, change: HeldTaskChange, audit: WorkAuditDraft): Promise<AgentTask | null>;
  /** Cancels a queued or claimed task. Null when it is in any other status or doesn't exist. */
  cancelTask(organizationId: string, id: string, at: string, audit: WorkAuditDraft): Promise<AgentTask | null>;
  /** A session's audit trail (or one task's), the latest `limit` entries, oldest first. */
  listWorkAudit(organizationId: string, filter: { sessionId: string; taskId?: string }, limit: number): Promise<WorkAuditEntry[]>;
}

/** The most notes a session keeps. */
export const MAX_SESSION_NOTES = 200;
/** The most links a session keeps. */
export const MAX_SESSION_LINKS = 500;
/** How long a claim lasts when the agent doesn't say, and the shortest and longest it may ask for. */
export const DEFAULT_TASK_LEASE_SECONDS = 300;
export const MIN_TASK_LEASE_SECONDS = 10;
export const MAX_TASK_LEASE_SECONDS = 3_600;
/** How long a lease is stretched to while the instance runs a task's operation, so a slow check isn't taken away mid-run. */
export const TASK_RUN_LEASE_SECONDS = 900;
/** Claims a task gets before a lease running out fails it instead of queuing it again. */
export const MAX_TASK_ATTEMPTS = 3;

/** Why a session or task call was turned down. */
export class WorkError extends Error {
  constructor(
    readonly reason: "not_found" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "WorkError";
  }
}

const sameLink = (a: Pick<SessionLink, "kind" | "id" | "entityKind">, b: Pick<SessionLink, "kind" | "id" | "entityKind">) =>
  a.kind === b.kind && a.id === b.id && (a.entityKind ?? null) === (b.entityKind ?? null);

/** Links not already in `existing`, and each only once. */
export function newLinks(existing: readonly SessionLink[], links: readonly SessionLink[]): SessionLink[] {
  const out: SessionLink[] = [];
  for (const link of links) if (!existing.some((e) => sameLink(e, link)) && !out.some((o) => sameLink(o, link))) out.push(link);
  return out;
}

/** A task as the API shows it: the lease id goes only to the agent that claimed it. */
export type TaskView = Omit<AgentTask, "lease"> & { lease: Omit<TaskLease, "leaseId"> | null };

export function taskView(task: AgentTask): TaskView {
  if (!task.lease) return { ...task, lease: null };
  const { leaseId: _hidden, ...lease } = task.lease;
  return { ...task, lease };
}

export interface WorkServiceOptions {
  store: WorkStore;
  /** Used to check that linked recommendations, events and entities exist. */
  memory: MemoryStore;
  organizationId: string;
  /** The task kinds this instance allows. Any other kind is turned down. */
  kinds: readonly string[];
  now?: () => Date;
  newId?: (prefix: "ses" | "task" | "lease") => string;
  maxAttempts?: number;
}

export interface NewLink {
  kind: SessionLinkKind;
  id: string;
  entityKind?: string;
  note?: string;
}

/** Seconds from now as ISO 8601. */
const after = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();

function leaseSeconds(value: number | undefined): number {
  const seconds = value ?? DEFAULT_TASK_LEASE_SECONDS;
  if (!Number.isInteger(seconds) || seconds < MIN_TASK_LEASE_SECONDS || seconds > MAX_TASK_LEASE_SECONDS) {
    throw new WorkError("invalid", `leaseSeconds must be a whole number from ${MIN_TASK_LEASE_SECONDS} to ${MAX_TASK_LEASE_SECONDS}`);
  }
  return seconds;
}

/**
 * The rules for sessions and tasks, the same over every store: what may
 * change when, idempotent creation, leases and their expiry, and the audit
 * entry for each change.
 */
export function createWorkService(options: WorkServiceOptions) {
  const { store, memory, organizationId: org } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? ((prefix: string) => `${prefix}_${randomUUID()}`);
  const maxAttempts = options.maxAttempts ?? MAX_TASK_ATTEMPTS;

  async function session(id: string): Promise<ReasoningSession> {
    const found = await store.getSession(org, id);
    if (!found) throw new WorkError("not_found", "session not found");
    return found;
  }

  /** The task after expired leases are settled, so what it says is current. */
  async function task(id: string): Promise<AgentTask> {
    await store.expireLeases(org, now().toISOString(), maxAttempts);
    const found = await store.getTask(org, id);
    if (!found) throw new WorkError("not_found", "task not found");
    return found;
  }

  function idempotency(key: string | undefined, request: unknown): IdempotencyClaim | null {
    return key === undefined ? null : { key, requestHash: sha256Json(request) };
  }

  function checkReplay<T>(inserted: Inserted<T>, claim: IdempotencyClaim | null): { record: T; created: boolean } {
    if (!inserted.created && claim && inserted.requestHash !== claim.requestHash) {
      throw new WorkError("conflict", "that idempotency key was already used for a different request");
    }
    return { record: inserted.record, created: inserted.created };
  }

  /** Why a change to a session found nothing to change. */
  async function sessionRefusal(id: string, wanted: SessionStatus, full?: string): Promise<never> {
    const current = await session(id);
    if (current.status !== wanted) throw new WorkError("conflict", wanted === "open" ? "the session is closed; reopen it first" : "the session is already open");
    throw new WorkError("conflict", full ?? "the session changed; try again");
  }

  /** Why a lease holder's change was turned down. */
  async function leaseRefusal(id: string, leaseId: string): Promise<never> {
    const current = await task(id);
    if (FINISHED_TASK_STATUSES.includes(current.status)) throw new WorkError("conflict", `the task is already ${current.status}`);
    if (!current.lease || current.lease.leaseId !== leaseId) throw new WorkError("conflict", "that lease is no longer held: it ran out or the task was claimed again; claim it again");
    if (current.status === "running") throw new WorkError("conflict", "the task is running");
    throw new WorkError("conflict", "the task changed; try again");
  }

  async function checkLink(link: NewLink): Promise<void> {
    if (link.kind === "entity" && !link.entityKind) throw new WorkError("invalid", "an entity link needs entityKind, such as customer");
    if (link.kind !== "entity" && link.entityKind !== undefined) throw new WorkError("invalid", "only an entity link takes entityKind");
    const found =
      link.kind === "recommendation"
        ? await memory.getRecommendation(org, link.id)
        : link.kind === "event"
          ? await memory.getEvent(org, link.id)
          : link.kind === "entity"
            ? await memory.getEntity(org, link.entityKind!, link.id)
            : true;
    if (!found) throw new WorkError("invalid", `no ${link.kind} ${link.id} in this instance`);
  }

  return {
    organizationId: org,
    kinds: options.kinds,

    async createSession(input: { subject: string; actor: string; note?: string; idempotencyKey?: string }) {
      const at = now().toISOString();
      const { idempotencyKey, ...request } = input;
      const claim = idempotency(idempotencyKey, request);
      const record: ReasoningSession = {
        id: newId("ses"),
        organizationId: org,
        subject: input.subject,
        status: "open",
        createdBy: input.actor,
        createdAt: at,
        updatedAt: at,
        closedAt: null,
        notes: input.note ? [{ text: input.note, actor: input.actor, at }] : [],
        links: [],
      };
      return checkReplay(await store.insertSession(record, claim, { action: "session.created", actor: input.actor, at, detail: { subject: input.subject } }), claim);
    },

    session,

    listSessions: (status: SessionStatus | null, limit: number) => store.listSessions(org, status, limit),

    async addNote(id: string, input: { actor: string; text: string }) {
      const at = now().toISOString();
      const change: SessionChange = { kind: "note", at, note: { text: input.text, actor: input.actor, at }, maxNotes: MAX_SESSION_NOTES };
      const changed = await store.changeSession(org, id, change, { action: "session.noted", actor: input.actor, at, detail: {} });
      return changed ?? sessionRefusal(id, "open", `a session keeps at most ${MAX_SESSION_NOTES} notes`);
    },

    async addLinks(id: string, input: { actor: string; links: NewLink[] }) {
      const current = await session(id);
      if (current.status !== "open") throw new WorkError("conflict", "the session is closed; reopen it first");
      for (const link of input.links) await checkLink(link);
      const at = now().toISOString();
      const links = newLinks(
        current.links,
        input.links.map((l) => ({ kind: l.kind, id: l.id, ...(l.entityKind !== undefined ? { entityKind: l.entityKind } : {}), ...(l.note !== undefined ? { note: l.note } : {}), addedBy: input.actor, addedAt: at })),
      );
      if (!links.length) return current;
      const detail = { links: links.map((l) => ({ kind: l.kind, id: l.id, ...(l.entityKind !== undefined ? { entityKind: l.entityKind } : {}) })) };
      const changed = await store.changeSession(org, id, { kind: "links", at, links, maxLinks: MAX_SESSION_LINKS }, { action: "session.linked", actor: input.actor, at, detail });
      return changed ?? sessionRefusal(id, "open", `a session keeps at most ${MAX_SESSION_LINKS} links`);
    },

    /** Closes the session and cancels its queued and claimed tasks. A running task finishes. */
    async close(id: string, input: { actor: string; note?: string }) {
      const at = now().toISOString();
      if (input.note) {
        const noted = await store.changeSession(org, id, { kind: "note", at, note: { text: input.note, actor: input.actor, at }, maxNotes: MAX_SESSION_NOTES }, { action: "session.noted", actor: input.actor, at, detail: {} });
        if (!noted) await sessionRefusal(id, "open", `a session keeps at most ${MAX_SESSION_NOTES} notes`);
      }
      const closed = await store.changeSession(org, id, { kind: "close", at }, { action: "session.closed", actor: input.actor, at, detail: {} });
      if (!closed) return sessionRefusal(id, "open");
      for (const status of ["queued", "claimed"] as const) {
        for (const open of await store.listTasks(org, { sessionId: id, status }, 1_000)) {
          await store.cancelTask(org, open.id, at, { action: "task.cancelled", actor: input.actor, at, detail: { reason: "the session was closed" } });
        }
      }
      return closed;
    },

    async reopen(id: string, input: { actor: string }) {
      const at = now().toISOString();
      const changed = await store.changeSession(org, id, { kind: "reopen", at }, { action: "session.reopened", actor: input.actor, at, detail: {} });
      return changed ?? sessionRefusal(id, "closed");
    },

    async createTask(input: { sessionId: string; kind: string; input: Record<string, unknown>; actor: string; idempotencyKey?: string }) {
      if (!options.kinds.includes(input.kind)) throw new WorkError("invalid", `${input.kind} isn't a task kind this instance allows; allowed: ${options.kinds.join(", ")}`);
      const at = now().toISOString();
      const { idempotencyKey, ...request } = input;
      const claim = idempotency(idempotencyKey, request);
      const record: AgentTask = {
        id: newId("task"),
        organizationId: org,
        sessionId: input.sessionId,
        kind: input.kind,
        input: input.input,
        status: "queued",
        createdBy: input.actor,
        createdAt: at,
        updatedAt: at,
        attempts: 0,
        lease: null,
        progress: null,
        result: null,
        resultBy: null,
        error: null,
        finishedAt: null,
      };
      const inserted = await store.insertTask(record, claim, { action: "task.created", actor: input.actor, at, detail: { kind: input.kind } });
      if (!inserted) {
        await session(input.sessionId);
        throw new WorkError("conflict", "the session is closed; reopen it first");
      }
      return checkReplay(inserted, claim);
    },

    task,

    async listTasks(filter: { sessionId?: string; status?: TaskStatus }, limit: number) {
      await store.expireLeases(org, now().toISOString(), maxAttempts);
      return store.listTasks(org, filter, limit);
    },

    /** Claims one task by id, or the oldest queued one that fits. Null when no queued task fits a pick that isn't by id. */
    async claim(pick: TaskPick, input: { agent: string; leaseSeconds?: number }): Promise<AgentTask | null> {
      const seconds = leaseSeconds(input.leaseSeconds);
      const at = now();
      await store.expireLeases(org, at.toISOString(), maxAttempts);
      const lease: TaskLease = { agent: input.agent, leaseId: newId("lease"), claimedAt: at.toISOString(), expiresAt: after(at, seconds) };
      const claimed = await store.claimTask(org, pick, lease, { action: "task.claimed", actor: input.agent, at: lease.claimedAt, detail: { leaseSeconds: seconds } });
      if (claimed || !("taskId" in pick)) return claimed;
      const current = await task(pick.taskId);
      throw new WorkError("conflict", `the task is ${current.status}${current.status === "claimed" || current.status === "running" ? ` by ${current.lease?.agent ?? "another agent"} until ${current.lease?.expiresAt ?? "its lease runs out"}` : ""}, so it can't be claimed`);
    },

    /** Progress from the lease holder, which also renews the lease. */
    async progress(id: string, input: { leaseId: string; message: string; percent?: number; leaseSeconds?: number }) {
      const seconds = leaseSeconds(input.leaseSeconds);
      const at = now();
      const progress: TaskProgress = { message: input.message, ...(input.percent !== undefined ? { percent: input.percent } : {}), at: at.toISOString() };
      const changed = await store.changeHeldTask(org, id, input.leaseId, { kind: "progress", at: at.toISOString(), progress, expiresAt: after(at, seconds) }, { action: "task.progress", actor: "agent", at: at.toISOString(), detail: { ...(input.percent !== undefined ? { percent: input.percent } : {}) } });
      return changed ?? leaseRefusal(id, input.leaseId);
    },

    /** The lease holder asks the instance to run the task's operation: the task moves to running and its lease is stretched for the run. */
    async start(id: string, leaseId: string) {
      const at = now();
      const changed = await store.changeHeldTask(org, id, leaseId, { kind: "start", at: at.toISOString(), expiresAt: after(at, TASK_RUN_LEASE_SECONDS) }, { action: "task.started", actor: "brain", at: at.toISOString(), detail: {} });
      return changed ?? leaseRefusal(id, leaseId);
    },

    /** Records what the instance's run of the operation came to. */
    async finishRun(id: string, leaseId: string, outcome: { result: Record<string, unknown> } | { error: string }) {
      const at = now().toISOString();
      const ok = "result" in outcome;
      const change: HeldTaskChange = { kind: "finish", at, from: "running", status: ok ? "succeeded" : "failed", result: ok ? outcome.result : null, resultBy: "brain", error: ok ? null : outcome.error };
      const changed = await store.changeHeldTask(org, id, leaseId, change, { action: ok ? "task.succeeded" : "task.failed", actor: "brain", at, detail: ok ? {} : { error: outcome.error } });
      return changed ?? leaseRefusal(id, leaseId);
    },

    /** The lease holder reports the task done, or failed, with its own result. */
    async complete(id: string, input: { leaseId: string; outcome: "succeeded" | "failed"; result?: Record<string, unknown>; error?: string }) {
      const at = now().toISOString();
      const change: HeldTaskChange = { kind: "finish", at, from: "claimed", status: input.outcome, result: input.result ?? null, resultBy: "agent", error: input.error ?? null };
      const changed = await store.changeHeldTask(org, id, input.leaseId, change, { action: input.outcome === "succeeded" ? "task.succeeded" : "task.failed", actor: "agent", at, detail: input.error ? { error: input.error } : {} });
      return changed ?? leaseRefusal(id, input.leaseId);
    },

    async cancel(id: string, input: { actor: string; reason?: string }) {
      const at = now().toISOString();
      await store.expireLeases(org, at, maxAttempts);
      const changed = await store.cancelTask(org, id, at, { action: "task.cancelled", actor: input.actor, at, detail: input.reason ? { reason: input.reason } : {} });
      if (changed) return changed;
      const current = await task(id);
      throw new WorkError("conflict", current.status === "running" ? "the task is running and can't be cancelled until it finishes" : `the task is already ${current.status}`);
    },

    audit: (filter: { sessionId: string; taskId?: string }, limit = 500) => store.listWorkAudit(org, filter, limit),
  };
}

export type WorkService = ReturnType<typeof createWorkService>;

/** What a lease running out does to a held task: back to queued, or failed once it has had its attempts. */
export function expiredLease(task: AgentTask, now: string, maxAttempts: number): { task: AgentTask; audit: WorkAuditDraft } {
  const fail = task.attempts >= maxAttempts;
  const agent = task.lease?.agent ?? null;
  const next: AgentTask = fail
    ? { ...task, status: "failed", error: `the lease ran out ${task.attempts} times without the task finishing`, finishedAt: now, updatedAt: now }
    : { ...task, status: "queued", lease: null, updatedAt: now };
  return { task: next, audit: { action: "task.lease_expired", actor: "brain", at: now, detail: { agent, attempts: task.attempts, requeued: !fail } } };
}
