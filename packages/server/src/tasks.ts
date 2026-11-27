import { z } from "zod";
import {
  createWorkService,
  MAX_TASK_LEASE_SECONDS,
  MIN_TASK_LEASE_SECONDS,
  SESSION_LINK_KINDS,
  SESSION_STATUSES,
  taskView,
  TASK_STATUSES,
  WorkError,
  type AgentTask,
  type WorkService,
  type WorkStore,
} from "@karatos/core";
import { ASK_MAX_QUESTION_CHARS, isDay } from "@karatos/retail";
import { INSTANCE_DEPARTMENTS } from "./brain.js";
import { HttpError, idFrom, issuesOf, readJson } from "./http.js";
import { SIGNAL_KIND, VerifyBody } from "./inputs.js";
import type { BrainAppOptions, BrainOperations, Handler, RouteAccess } from "./app.js";

/**
 * Reasoning sessions and agent tasks over HTTP: /v1/sessions and /v1/tasks.
 * Every route needs the instance key; none is diagnostic. A task kind is one
 * of the instance's read-only operations, run with the same checks as its
 * route. No kind writes to a vendor's system, and none can: the operations
 * below read the store or a vendor's API, and writes go only through the
 * WriteGate, which no task reaches. See docs/sessions-and-tasks.md.
 */

export interface BrainWorkOptions {
  store: WorkStore;
  now?: () => Date;
  newId?: (prefix: "ses" | "task" | "lease") => string;
  maxAttempts?: number;
}

const day = z.string().refine(isDay, "must be a day, such as 2026-11-18");
const DEPARTMENT_IDS = INSTANCE_DEPARTMENTS.map((d) => d.id);

/** What an agent may ask a task to run: the instance operation each kind maps to, and the input it takes. */
export const TASK_KINDS = {
  reason: {
    operation: "POST /v1/reason",
    about: "Runs the department rules, as POST /v1/reason does. With departments, the result and the session's links keep only those departments' recommendations; the rules always run together.",
    input: z.object({ departments: z.array(z.enum(DEPARTMENT_IDS as [string, ...string[]])).min(1).max(DEPARTMENT_IDS.length).optional() }).strict(),
  },
  ask: {
    operation: "POST /v1/ask",
    about: "Answers a question in plain words from synced data, each number citing its events.",
    input: z.object({ question: z.string().trim().min(1).max(ASK_MAX_QUESTION_CHARS) }).strict(),
  },
  brief: {
    operation: "GET /v1/brief",
    about: "The daily brief for a day, yesterday when no date is given.",
    input: z.object({ date: day.optional() }).strict(),
  },
  verify: {
    operation: "POST /v1/verify",
    about: "Checks what has synced against each source system's own totals for a period, read-only.",
    input: VerifyBody,
  },
  value: {
    operation: "GET /v1/value",
    about: "The value ledger for a period (to is the day after it), or the month so far.",
    input: z.object({ from: day, to: day }).strict().or(z.object({}).strict()),
  },
  feedback: {
    operation: "GET /v1/feedback",
    about: "How the owner has treated each rule's recommendations.",
    input: z.object({}).strict(),
  },
  signals: {
    operation: "GET /v1/signals",
    about: "The latest signals, optionally of some kinds.",
    input: z.object({ kinds: z.array(z.string().regex(SIGNAL_KIND)).min(1).max(10).optional(), limit: z.number().int().min(1).max(1000).optional() }).strict(),
  },
  recommendations: {
    operation: "GET /v1/recommendations",
    about: "The latest recommendations, with provenance.",
    input: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
  },
} as const;

export type TaskKind = keyof typeof TASK_KINDS;
export const TASK_KIND_NAMES = Object.keys(TASK_KINDS) as TaskKind[];

const isKind = (kind: string): kind is TaskKind => Object.hasOwn(TASK_KINDS, kind);

/** Runs a task's operation with its input, which TASK_KINDS has already checked. */
async function runKind(ops: BrainOperations, kind: TaskKind, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (kind) {
    case "reason": {
      const pass = await ops.reason();
      const departments = (input.departments as string[] | undefined) ?? null;
      if (!departments) return { ...pass };
      const rules = new Set(INSTANCE_DEPARTMENTS.filter((d) => departments.includes(d.id)).flatMap((d) => d.reasoners.map((r) => r.name)));
      return { ...pass, recommendations: pass.recommendations.filter((r) => r.rule !== undefined && rules.has(r.rule)), departments };
    }
    case "ask":
      return ops.ask(input.question);
    case "brief":
      return ops.brief((input.date as string | undefined) ?? null);
    case "verify":
      return ops.verify(input as z.infer<typeof VerifyBody>);
    case "value":
      return ops.value((input.from as string | undefined) ?? null, (input.to as string | undefined) ?? null);
    case "feedback":
      return ops.feedback();
    case "signals":
      return ops.signals(input.kinds as string[] | undefined, (input.limit as number | undefined) ?? 200);
    case "recommendations":
      return ops.recommendations((input.limit as number | undefined) ?? 50);
  }
}

/** The largest body a session or task route reads. */
export const WORK_MAX_BODY_BYTES = 16_384;
/** The largest result an agent may report itself, as JSON. */
export const TASK_MAX_RESULT_BYTES = 32_768;

const name = z.string().trim().min(1).max(100);
const text = (max: number) => z.string().trim().min(1).max(max);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/, "idempotencyKey must be 1 to 200 letters, digits, dots, dashes, underscores or colons").optional();
const leaseSeconds = z.number().int().min(MIN_TASK_LEASE_SECONDS).max(MAX_TASK_LEASE_SECONDS).optional();
const leaseId = z.string().min(1).max(100);

const SessionBody = z.object({ subject: text(300), actor: name, note: text(2000).optional(), idempotencyKey }).strict();
const NoteBody = z.object({ actor: name, text: text(2000) }).strict();
const LinksBody = z
  .object({
    actor: name,
    links: z
      .array(z.object({ kind: z.enum(SESSION_LINK_KINDS), id: text(300), entityKind: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(), note: text(500).optional() }).strict())
      .min(1)
      .max(50),
  })
  .strict();
const CloseBody = z.object({ actor: name, note: text(2000).optional() }).strict();
const ReopenBody = z.object({ actor: name }).strict();
const TaskBody = z.object({ sessionId: text(100), kind: z.string(), input: z.record(z.string(), z.unknown()).optional(), actor: name, idempotencyKey }).strict();
const ClaimNextBody = z.object({ agent: name, kinds: z.array(z.string()).min(1).max(TASK_KIND_NAMES.length).optional(), sessionId: text(100).optional(), leaseSeconds }).strict();
const ClaimBody = z.object({ agent: name, leaseSeconds }).strict();
const ProgressBody = z.object({ leaseId, message: text(500), percent: z.number().min(0).max(100).optional(), leaseSeconds }).strict();
const RunBody = z.object({ leaseId }).strict();
const CompleteBody = z
  .object({ leaseId, outcome: z.enum(["succeeded", "failed"]), result: z.record(z.string(), z.unknown()).optional(), error: text(2000).optional() })
  .strict()
  .refine((b) => b.outcome === "succeeded" || b.error !== undefined, { message: "a failed task needs an error saying what went wrong", path: ["error"] });
const CancelBody = z.object({ actor: name, reason: text(500).optional() }).strict();

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, `invalid ${what}`, issuesOf(parsed.error));
  return parsed.data;
}

function checkKinds(kinds: readonly string[]): void {
  const unknown = kinds.filter((k) => !isKind(k));
  if (unknown.length) throw new HttpError(400, `${unknown.join(", ")} isn't a task kind this instance allows; allowed: ${TASK_KIND_NAMES.join(", ")}`);
}

const listLimit = (url: URL, fallback: number, max: number) => Math.min(Math.max(Number(url.searchParams.get("limit") ?? fallback) || fallback, 1), max);

/** A WorkError as the HTTP answer it stands for. */
async function answering<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof WorkError) throw new HttpError(error.reason === "not_found" ? 404 : error.reason === "conflict" ? 409 : 400, error.message);
    throw error;
  }
}

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

/** What a failed run records: a route's own message, or only the class name of anything else, which could quote business data. */
function runError(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  const name = error instanceof Error && ERROR_NAME.test(error.name) ? error.name : "UnknownError";
  return `the operation failed (${name})`;
}

export function workRoutes(options: BrainAppOptions, ops: BrainOperations, maxBody: number): [string, RegExp, Handler, RouteAccess?][] {
  const limit = Math.min(maxBody, WORK_MAX_BODY_BYTES);
  let service: WorkService | null = null;
  const work = (): WorkService => {
    if (!options.work) throw new HttpError(503, "sessions and tasks aren't set up on this instance");
    service ??= createWorkService({
      store: options.work.store,
      memory: options.memory,
      organizationId: options.organizationId,
      kinds: TASK_KIND_NAMES,
      ...(options.work.now ? { now: options.work.now } : {}),
      ...(options.work.newId ? { newId: options.work.newId } : {}),
      ...(options.work.maxAttempts !== undefined ? { maxAttempts: options.work.maxAttempts } : {}),
    });
    return service;
  };
  const body = async <T extends z.ZodTypeAny>(req: Parameters<Handler>[0], schema: T, what: string, bytes = limit) => {
    work();
    return parse(schema, await readJson(req, bytes), what);
  };
  const claimed = (task: AgentTask) => ({ task: taskView(task), leaseId: task.lease!.leaseId, leaseExpiresAt: task.lease!.expiresAt });

  return [
    [
      "GET",
      /^\/v1\/sessions$/,
      async (_req, _params, url) => {
        const status = url.searchParams.get("status");
        if (status !== null && !(SESSION_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "status must be open or closed");
        return [200, { sessions: await work().listSessions(status as "open" | "closed" | null, listLimit(url, 50, 200)) }];
      },
    ],
    [
      "POST",
      /^\/v1\/sessions$/,
      async (req) => {
        const input = await body(req, SessionBody, "session");
        const { record, created } = await answering(() =>
          work().createSession({ subject: input.subject, actor: input.actor, ...(input.note !== undefined ? { note: input.note } : {}), ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}) }),
        );
        return [created ? 201 : 200, { session: record, duplicate: !created }];
      },
    ],
    [
      "GET",
      /^\/v1\/sessions\/([^/]+)$/,
      async (_req, [id]) => {
        const w = work();
        const session = await answering(() => w.session(idFrom(id!)));
        const tasks = await w.listTasks({ sessionId: session.id }, 200);
        return [200, { session, tasks: tasks.map(taskView), audit: await w.audit({ sessionId: session.id }) }];
      },
    ],
    [
      "POST",
      /^\/v1\/sessions\/([^/]+)\/notes$/,
      async (req, [id]) => {
        const input = await body(req, NoteBody, "note");
        return [201, { session: await answering(() => work().addNote(idFrom(id!), input)) }];
      },
    ],
    [
      "POST",
      /^\/v1\/sessions\/([^/]+)\/links$/,
      async (req, [id]) => {
        const input = await body(req, LinksBody, "links");
        const links = input.links.map((l) => ({ kind: l.kind, id: l.id, ...(l.entityKind !== undefined ? { entityKind: l.entityKind } : {}), ...(l.note !== undefined ? { note: l.note } : {}) }));
        return [200, { session: await answering(() => work().addLinks(idFrom(id!), { actor: input.actor, links })) }];
      },
    ],
    [
      "POST",
      /^\/v1\/sessions\/([^/]+)\/close$/,
      async (req, [id]) => {
        const input = await body(req, CloseBody, "close");
        return [200, { session: await answering(() => work().close(idFrom(id!), { actor: input.actor, ...(input.note !== undefined ? { note: input.note } : {}) })) }];
      },
    ],
    [
      "POST",
      /^\/v1\/sessions\/([^/]+)\/reopen$/,
      async (req, [id]) => {
        const input = await body(req, ReopenBody, "reopen");
        return [200, { session: await answering(() => work().reopen(idFrom(id!), input)) }];
      },
    ],
    [
      "GET",
      /^\/v1\/tasks$/,
      async (_req, _params, url) => {
        const status = url.searchParams.get("status");
        if (status !== null && !(TASK_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, `status must be one of ${TASK_STATUSES.join(", ")}`);
        const sessionId = url.searchParams.get("sessionId");
        const tasks = await work().listTasks({ ...(sessionId !== null ? { sessionId } : {}), ...(status !== null ? { status: status as AgentTask["status"] } : {}) }, listLimit(url, 50, 200));
        return [200, { tasks: tasks.map(taskView) }];
      },
    ],
    [
      "POST",
      /^\/v1\/tasks$/,
      async (req) => {
        const input = await body(req, TaskBody, "task");
        checkKinds([input.kind]);
        const kind = TASK_KINDS[input.kind as TaskKind];
        const taskInput = parse(kind.input, input.input ?? {}, `input for a ${input.kind} task`) as Record<string, unknown>;
        const { record, created } = await answering(() =>
          work().createTask({ sessionId: input.sessionId, kind: input.kind, input: taskInput, actor: input.actor, ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}) }),
        );
        return [created ? 201 : 200, { task: taskView(record), duplicate: !created }];
      },
    ],
    [
      "GET",
      /^\/v1\/tasks\/kinds$/,
      async () => [200, { kinds: TASK_KIND_NAMES.map((kind) => ({ kind, operation: TASK_KINDS[kind].operation, about: TASK_KINDS[kind].about })), vendorWrites: false }],
    ],
    [
      "POST",
      /^\/v1\/tasks\/claim$/,
      async (req) => {
        const input = await body(req, ClaimNextBody, "claim");
        if (input.kinds) checkKinds(input.kinds);
        const task = await answering(() =>
          work().claim(
            { ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}), ...(input.kinds !== undefined ? { kinds: input.kinds } : {}) },
            { agent: input.agent, ...(input.leaseSeconds !== undefined ? { leaseSeconds: input.leaseSeconds } : {}) },
          ),
        );
        return [200, task ? claimed(task) : { task: null }];
      },
    ],
    [
      "GET",
      /^\/v1\/tasks\/([^/]+)$/,
      async (_req, [id]) => {
        const w = work();
        const task = await answering(() => w.task(idFrom(id!)));
        return [200, { task: taskView(task), audit: await w.audit({ sessionId: task.sessionId, taskId: task.id }) }];
      },
    ],
    [
      "POST",
      /^\/v1\/tasks\/([^/]+)\/claim$/,
      async (req, [id]) => {
        const input = await body(req, ClaimBody, "claim");
        const task = await answering(() => work().claim({ taskId: idFrom(id!) }, { agent: input.agent, ...(input.leaseSeconds !== undefined ? { leaseSeconds: input.leaseSeconds } : {}) }));
        return [200, claimed(task!)];
      },
    ],
    [
      "POST",
      /^\/v1\/tasks\/([^/]+)\/progress$/,
      async (req, [id]) => {
        const input = await body(req, ProgressBody, "progress");
        const task = await answering(() =>
          work().progress(idFrom(id!), {
            leaseId: input.leaseId,
            message: input.message,
            ...(input.percent !== undefined ? { percent: input.percent } : {}),
            ...(input.leaseSeconds !== undefined ? { leaseSeconds: input.leaseSeconds } : {}),
          }),
        );
        return [200, { task: taskView(task), leaseExpiresAt: task.lease!.expiresAt }];
      },
    ],
    [
      "POST",
      /^\/v1\/tasks\/([^/]+)\/run$/,
      async (req, [id]) => {
        const input = await body(req, RunBody, "run");
        const w = work();
        const taskId = idFrom(id!);
        const started = await answering(() => w.start(taskId, input.leaseId));
        // The allowed list was checked when the task was made; a kind no longer allowed fails rather than runs.
        let outcome: { result: Record<string, unknown> } | { error: string };
        if (!isKind(started.kind)) outcome = { error: `${started.kind} isn't a task kind this instance allows` };
        else {
          try {
            outcome = { result: await runKind(ops, started.kind, parse(TASK_KINDS[started.kind].input, started.input, "task input") as Record<string, unknown>) };
          } catch (error) {
            outcome = { error: runError(error) };
          }
        }
        if ("result" in outcome && started.kind === "reason") {
          const ids = (outcome.result.recommendations as { id: string }[]).map((r) => r.id);
          outcome.result.linked = await linkRecommendations(w, started.sessionId, ids);
        }
        return [200, { task: taskView(await answering(() => w.finishRun(taskId, input.leaseId, outcome))) }];
      },
    ],
    [
      "POST",
      /^\/v1\/tasks\/([^/]+)\/complete$/,
      async (req, [id]) => {
        // A completion may carry a result up to TASK_MAX_RESULT_BYTES, with room for the rest of the body.
        const input = await body(req, CompleteBody, "completion", Math.min(maxBody, TASK_MAX_RESULT_BYTES + WORK_MAX_BODY_BYTES));
        if (input.result !== undefined && Buffer.byteLength(JSON.stringify(input.result)) > TASK_MAX_RESULT_BYTES) {
          throw new HttpError(400, `a reported result must be at most ${TASK_MAX_RESULT_BYTES} bytes as JSON`);
        }
        const task = await answering(() =>
          work().complete(idFrom(id!), {
            leaseId: input.leaseId,
            outcome: input.outcome,
            ...(input.result !== undefined ? { result: input.result } : {}),
            ...(input.error !== undefined ? { error: input.error } : {}),
          }),
        );
        return [200, { task: taskView(task) }];
      },
    ],
    [
      "POST",
      /^\/v1\/tasks\/([^/]+)\/cancel$/,
      async (req, [id]) => {
        const input = await body(req, CancelBody, "cancel");
        return [200, { task: taskView(await answering(() => work().cancel(idFrom(id!), { actor: input.actor, ...(input.reason !== undefined ? { reason: input.reason } : {}) }))) }];
      },
    ],
  ];
}

/** Links what a reason task raised to its session. How many were new; 0 when the session was closed meanwhile or they would take it past its link limit. */
async function linkRecommendations(work: WorkService, sessionId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  try {
    const before = (await work.session(sessionId)).links.length;
    const after = (await work.addLinks(sessionId, { actor: "brain", links: ids.map((id) => ({ kind: "recommendation" as const, id })) })).links.length;
    return after - before;
  } catch (error) {
    if (error instanceof WorkError) return 0;
    throw error;
  }
}
