import type {
  AgentTask,
  HeldTaskChange,
  IdempotencyClaim,
  Inserted,
  ReasoningSession,
  SessionChange,
  SessionStatus,
  TaskLease,
  TaskPick,
  TaskStatus,
  WorkAuditDraft,
  WorkAuditEntry,
  WorkStore,
} from "@karatos/core";
import type { SqlClient } from "./client.js";

type Time = Date | string;

interface SessionRow {
  organization_id: string;
  id: string;
  subject: string;
  status: SessionStatus;
  created_by: string;
  created_at: Time;
  updated_at: Time;
  closed_at: Time | null;
  notes: ReasoningSession["notes"];
  links: ReasoningSession["links"];
  request_hash: string | null;
}

interface TaskRow {
  organization_id: string;
  id: string;
  session_id: string;
  kind: string;
  input: Record<string, unknown>;
  status: TaskStatus;
  created_by: string;
  created_at: Time;
  updated_at: Time;
  attempts: number;
  lease_agent: string | null;
  lease_id: string | null;
  lease_claimed_at: Time | null;
  lease_expires_at: Time | null;
  progress: AgentTask["progress"];
  result: AgentTask["result"];
  result_by: AgentTask["resultBy"];
  error: string | null;
  finished_at: Time | null;
  request_hash: string | null;
}

interface AuditRow {
  organization_id: string;
  session_id: string;
  task_id: string | null;
  action: WorkAuditEntry["action"];
  actor: string;
  at: Time;
  detail: Record<string, unknown>;
}

const iso = (value: Time) => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
const isoOrNull = (value: Time | null) => (value === null ? null : iso(value));

function toSession(r: SessionRow): ReasoningSession {
  return {
    id: r.id,
    organizationId: r.organization_id,
    subject: r.subject,
    status: r.status,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    closedAt: isoOrNull(r.closed_at),
    notes: r.notes,
    links: r.links,
  };
}

function toTask(r: TaskRow): AgentTask {
  const lease: TaskLease | null =
    r.lease_id !== null && r.lease_agent !== null && r.lease_claimed_at !== null && r.lease_expires_at !== null
      ? { agent: r.lease_agent, leaseId: r.lease_id, claimedAt: iso(r.lease_claimed_at), expiresAt: iso(r.lease_expires_at) }
      : null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    sessionId: r.session_id,
    kind: r.kind,
    input: r.input,
    status: r.status,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    attempts: r.attempts,
    lease,
    progress: r.progress,
    result: r.result,
    resultBy: r.result_by,
    error: r.error,
    finishedAt: isoOrNull(r.finished_at),
  };
}

/**
 * The audit insert that rides along with a change, as one statement: it reads
 * the changed rows from the CTE named `changed`, so the entry is written
 * exactly when the change is. Parameters $a..$a+3 are action, actor, at and detail.
 */
function auditFrom(changed: string, first: number, taskColumn: "id" | "null"): string {
  const a = (n: number) => `$${first + n}`;
  return `audit as (
    insert into work_audit (organization_id, session_id, task_id, action, actor, at, detail)
    select organization_id, ${taskColumn === "id" ? "session_id, id" : "id, null"}, ${a(0)}, ${a(1)}, ${a(2)}::timestamptz, ${a(3)}::jsonb from ${changed}
  )`;
}

const auditParams = (audit: WorkAuditDraft) => [audit.action, audit.actor, audit.at, JSON.stringify(audit.detail)];

/** WorkStore over the reasoning_sessions, agent_tasks and work_audit tables. Each change is a single statement. */
export class PostgresWorkStore implements WorkStore {
  constructor(private readonly db: SqlClient) {}

  async insertSession(session: ReasoningSession, idempotency: IdempotencyClaim | null, audit: WorkAuditDraft): Promise<Inserted<ReasoningSession>> {
    const { rows } = await this.db.query<SessionRow>(
      `with inserted as (
         insert into reasoning_sessions (organization_id, id, subject, status, created_by, created_at, updated_at, closed_at, notes, links, idempotency_key, request_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12)
         on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing
         returning *
       ), ${auditFrom("inserted", 13, "null")}
       select * from inserted`,
      [
        session.organizationId,
        session.id,
        session.subject,
        session.status,
        session.createdBy,
        session.createdAt,
        session.updatedAt,
        session.closedAt,
        JSON.stringify(session.notes),
        JSON.stringify(session.links),
        idempotency?.key ?? null,
        idempotency?.requestHash ?? null,
        ...auditParams(audit),
      ],
    );
    if (rows[0]) return { record: toSession(rows[0]), created: true, requestHash: rows[0].request_hash };
    const existing = await this.db.query<SessionRow>("select * from reasoning_sessions where organization_id = $1 and idempotency_key = $2", [session.organizationId, idempotency!.key]);
    return { record: toSession(existing.rows[0]!), created: false, requestHash: existing.rows[0]!.request_hash };
  }

  async getSession(organizationId: string, id: string): Promise<ReasoningSession | null> {
    const { rows } = await this.db.query<SessionRow>("select * from reasoning_sessions where organization_id = $1 and id = $2", [organizationId, id]);
    return rows[0] ? toSession(rows[0]) : null;
  }

  async listSessions(organizationId: string, status: SessionStatus | null, limit: number): Promise<ReasoningSession[]> {
    const { rows } = await this.db.query<SessionRow>(
      "select * from reasoning_sessions where organization_id = $1 and ($2::text is null or status = $2) order by updated_at desc, id desc limit $3",
      [organizationId, status, Math.max(0, Math.floor(limit))],
    );
    return rows.map(toSession);
  }

  async changeSession(organizationId: string, id: string, change: SessionChange, audit: WorkAuditDraft): Promise<ReasoningSession | null> {
    const params: unknown[] = [organizationId, id, change.kind === "reopen" ? "closed" : "open", change.at];
    const p = (value: unknown) => `$${params.push(value)}`;
    // Only links the session doesn't already have, compared by kind, id and entity kind.
    const fresh = (links: string) => `(
      select n, o from jsonb_array_elements(${links}::jsonb) with ordinality as x(n, o)
      where not exists (
        select 1 from jsonb_array_elements(s.links) e
        where e->'kind' = n->'kind' and e->'id' = n->'id' and (e->'entityKind') is not distinct from (n->'entityKind')
      ))`;
    let set: string;
    let where = "true";
    if (change.kind === "note") {
      set = `notes = s.notes || jsonb_build_array(${p(JSON.stringify(change.note))}::jsonb)`;
      where = `jsonb_array_length(s.notes) < ${p(change.maxNotes)}`;
    } else if (change.kind === "links") {
      const links = p(JSON.stringify(change.links));
      set = `links = s.links || coalesce((select jsonb_agg(n order by o) from ${fresh(links)} f), '[]'::jsonb)`;
      where = `jsonb_array_length(s.links) + (select count(*) from ${fresh(links)} f) <= ${p(change.maxLinks)}`;
    } else if (change.kind === "close") {
      set = "status = 'closed', closed_at = $4::timestamptz";
    } else {
      set = "status = 'open', closed_at = null";
    }
    const first = params.length + 1;
    params.push(...auditParams(audit));
    const { rows } = await this.db.query<SessionRow>(
      `with changed as (
         update reasoning_sessions s set ${set}, updated_at = $4::timestamptz
         where s.organization_id = $1 and s.id = $2 and s.status = $3 and ${where}
         returning s.*
       ), ${auditFrom("changed", first, "null")}
       select * from changed`,
      params,
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async insertTask(task: AgentTask, idempotency: IdempotencyClaim | null, audit: WorkAuditDraft): Promise<Inserted<AgentTask> | null> {
    const { rows } = await this.db.query<TaskRow>(
      `with inserted as (
         insert into agent_tasks (organization_id, id, session_id, kind, input, status, created_by, created_at, updated_at, attempts, idempotency_key, request_hash)
         select $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12
         where exists (select 1 from reasoning_sessions where organization_id = $1 and id = $3 and status = 'open')
         on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing
         returning *
       ), ${auditFrom("inserted", 13, "id")}
       select * from inserted`,
      [
        task.organizationId,
        task.id,
        task.sessionId,
        task.kind,
        JSON.stringify(task.input),
        task.status,
        task.createdBy,
        task.createdAt,
        task.updatedAt,
        task.attempts,
        idempotency?.key ?? null,
        idempotency?.requestHash ?? null,
        ...auditParams(audit),
      ],
    );
    if (rows[0]) return { record: toTask(rows[0]), created: true, requestHash: rows[0].request_hash };
    if (!idempotency) return null;
    const existing = await this.db.query<TaskRow>("select * from agent_tasks where organization_id = $1 and idempotency_key = $2", [task.organizationId, idempotency.key]);
    return existing.rows[0] ? { record: toTask(existing.rows[0]), created: false, requestHash: existing.rows[0].request_hash } : null;
  }

  async getTask(organizationId: string, id: string): Promise<AgentTask | null> {
    const { rows } = await this.db.query<TaskRow>("select * from agent_tasks where organization_id = $1 and id = $2", [organizationId, id]);
    return rows[0] ? toTask(rows[0]) : null;
  }

  async listTasks(organizationId: string, filter: { sessionId?: string; status?: TaskStatus }, limit: number): Promise<AgentTask[]> {
    const { rows } = await this.db.query<TaskRow>(
      `select * from agent_tasks where organization_id = $1 and ($2::text is null or session_id = $2) and ($3::text is null or status = $3)
       order by created_at desc, id desc limit $4`,
      [organizationId, filter.sessionId ?? null, filter.status ?? null, Math.max(0, Math.floor(limit))],
    );
    return rows.map(toTask);
  }

  async expireLeases(organizationId: string, now: string, maxAttempts: number): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `with changed as (
         update agent_tasks t set
           status = case when t.attempts >= $3 then 'failed' else 'queued' end,
           error = case when t.attempts >= $3 then 'the lease ran out ' || t.attempts || ' times without the task finishing' else t.error end,
           finished_at = case when t.attempts >= $3 then $2::timestamptz else null end,
           lease_agent = case when t.attempts >= $3 then t.lease_agent end,
           lease_id = case when t.attempts >= $3 then t.lease_id end,
           lease_claimed_at = case when t.attempts >= $3 then t.lease_claimed_at end,
           lease_expires_at = case when t.attempts >= $3 then t.lease_expires_at end,
           updated_at = $2::timestamptz
         from agent_tasks old
         where t.organization_id = $1 and t.status in ('claimed', 'running') and t.lease_expires_at <= $2::timestamptz
           and old.organization_id = t.organization_id and old.id = t.id
         returning t.organization_id, t.session_id, t.id, t.attempts, old.lease_agent, t.status
       ), audit as (
         insert into work_audit (organization_id, session_id, task_id, action, actor, at, detail)
         select organization_id, session_id, id, 'task.lease_expired', 'brain', $2::timestamptz,
                jsonb_build_object('agent', lease_agent, 'attempts', attempts, 'requeued', status = 'queued')
         from changed
       )
       select count(*)::int as n from changed`,
      [organizationId, now, maxAttempts],
    );
    return rows[0]?.n ?? 0;
  }

  async claimTask(organizationId: string, pick: TaskPick, lease: TaskLease, audit: WorkAuditDraft): Promise<AgentTask | null> {
    const byId = "taskId" in pick;
    const { rows } = await this.db.query<TaskRow>(
      `with target as (
         select id from agent_tasks
         where organization_id = $1 and status = 'queued'
           and ($2::text is null or id = $2)
           and ($3::text is null or session_id = $3)
           and ($4::text[] is null or kind = any($4::text[]))
         order by created_at, id
         limit 1
         for update skip locked
       ), changed as (
         update agent_tasks t set status = 'claimed', attempts = t.attempts + 1, lease_agent = $5, lease_id = $6,
           lease_claimed_at = $7::timestamptz, lease_expires_at = $8::timestamptz, progress = null, updated_at = $7::timestamptz
         from target where t.organization_id = $1 and t.id = target.id and t.status = 'queued'
         returning t.*
       ), ${auditFrom("changed", 9, "id")}
       select * from changed`,
      [
        organizationId,
        byId ? pick.taskId : null,
        byId ? null : (pick.sessionId ?? null),
        byId || pick.kinds === undefined ? null : [...pick.kinds],
        lease.agent,
        lease.leaseId,
        lease.claimedAt,
        lease.expiresAt,
        ...auditParams(audit),
      ],
    );
    return rows[0] ? toTask(rows[0]) : null;
  }

  async changeHeldTask(organizationId: string, id: string, leaseId: string, change: HeldTaskChange, audit: WorkAuditDraft): Promise<AgentTask | null> {
    const params: unknown[] = [organizationId, id, leaseId, change.kind === "finish" ? change.from : "claimed", change.at];
    const p = (value: unknown) => `$${params.push(value)}`;
    const set =
      change.kind === "progress"
        ? `progress = ${p(JSON.stringify(change.progress))}::jsonb, lease_expires_at = ${p(change.expiresAt)}::timestamptz`
        : change.kind === "start"
          ? `status = 'running', lease_expires_at = ${p(change.expiresAt)}::timestamptz`
          : `status = ${p(change.status)}, result = ${p(change.result === null ? null : JSON.stringify(change.result))}::jsonb, result_by = ${p(change.resultBy)}, error = ${p(change.error)}, finished_at = $5::timestamptz`;
    const first = params.length + 1;
    params.push(...auditParams(audit));
    // A claimed task's lease must still be live; a running one's was stretched for the run, and only its holder can finish it.
    const { rows } = await this.db.query<TaskRow>(
      `with changed as (
         update agent_tasks set ${set}, updated_at = $5::timestamptz
         where organization_id = $1 and id = $2 and lease_id = $3 and status = $4
           and ($4 <> 'claimed' or lease_expires_at > $5::timestamptz)
         returning *
       ), ${auditFrom("changed", first, "id")}
       select * from changed`,
      params,
    );
    return rows[0] ? toTask(rows[0]) : null;
  }

  async cancelTask(organizationId: string, id: string, at: string, audit: WorkAuditDraft): Promise<AgentTask | null> {
    const { rows } = await this.db.query<TaskRow>(
      `with changed as (
         update agent_tasks set status = 'cancelled', finished_at = $3::timestamptz, updated_at = $3::timestamptz
         where organization_id = $1 and id = $2 and status in ('queued', 'claimed')
         returning *
       ), ${auditFrom("changed", 4, "id")}
       select * from changed`,
      [organizationId, id, at, ...auditParams(audit)],
    );
    return rows[0] ? toTask(rows[0]) : null;
  }

  async listWorkAudit(organizationId: string, filter: { sessionId: string; taskId?: string }, limit: number): Promise<WorkAuditEntry[]> {
    const { rows } = await this.db.query<AuditRow>(
      `select * from (
         select * from work_audit where organization_id = $1 and session_id = $2 and ($3::text is null or task_id = $3)
         order by id desc limit $4
       ) latest order by id`,
      [organizationId, filter.sessionId, filter.taskId ?? null, Math.max(0, Math.floor(limit))],
    );
    return rows.map((r) => ({ organizationId: r.organization_id, sessionId: r.session_id, taskId: r.task_id, action: r.action, actor: r.actor, at: iso(r.at), detail: r.detail }));
  }
}
