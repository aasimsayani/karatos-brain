/**
 * Turns Asana projects, tasks and comments into Brain A events in the same
 * vendor-neutral work-tracking types the monday.com connector sends, so a
 * project of custom orders, repairs or production jobs reads the same
 * whichever tool it came from: work.board_updated for a project (its
 * sections as groups, its custom fields as columns), work.item_updated for a
 * task and work.comment_updated for a comment.
 *
 * A task's name and notes are never read; they often hold a customer's name.
 * Custom fields are kept only for types that hold no free text: number,
 * single and multi select (their option labels), date and people (as user
 * ids). A comment keeps its id, task, author and time, never its words.
 *
 * Each version is keyed by its id and modified time, so every change is
 * stored once and a replay is a duplicate.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface AsanaBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** Custom field types whose values hold no free text, the only ones kept. */
export const ASANA_SAFE_FIELD_TYPES = ["number", "enum", "multi_enum", "date", "people"] as const;
const SAFE = new Set<string>(ASANA_SAFE_FIELD_TYPES);

const GID = /^\d{1,32}$/;

export const asanaRef = (kind: string, gid: string) => `asana:${kind}:${gid}`;

const str = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const gidOf = (value: unknown) => (typeof value === "string" && GID.test(value) ? value : undefined);
const refOf = (kind: string, record: unknown) => {
  const g = gidOf((record as { gid?: unknown } | null | undefined)?.gid);
  return g && asanaRef(kind, g);
};
const list = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]).filter((v) => v && typeof v === "object" && !Array.isArray(v)) : []);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/** A time Asana wrote, as an ISO time in UTC. Anything unreadable is undefined, so the pipeline dead-letters the record. */
export function asanaTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/.test(value.trim())) return undefined;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A calendar day Asana wrote, as YYYY-MM-DD. */
export function asanaDay(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(value) ? value : undefined;
}

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): AsanaBrainEvent {
  return { id: `asana_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `asana:${key}`, payload };
}

const version = (occurredAt: string | undefined) => (occurredAt ? String(Date.parse(occurredAt)) : "0");

/** A safe custom field's value, in a shape that holds no free text; undefined for any other type. */
function fieldValue(field: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = str(field.resource_subtype, 40);
  if (!type || !SAFE.has(type)) return undefined;
  switch (type) {
    case "number":
      return { type, number: typeof field.number_value === "number" && Number.isFinite(field.number_value) ? field.number_value : null };
    case "enum": {
      const option = field.enum_value as Record<string, unknown> | null | undefined;
      return { type, label: str(option?.name, 100) ?? null, id: gidOf(option?.gid) ?? null };
    }
    case "multi_enum": {
      const options = list(field.multi_enum_values);
      return { type, labels: options.map((o) => str(o.name, 100)).filter((l): l is string => l !== undefined), ids: options.map((o) => gidOf(o.gid)).filter((g): g is string => g !== undefined) };
    }
    case "date": {
      const value = field.date_value as Record<string, unknown> | null | undefined;
      return defined({ type, date: asanaDay(value?.date) ?? null, at: asanaTime(value?.date_time) });
    }
    default: {
      // people
      return { type, people: list(field.people_value).map((p) => gidOf(p.gid)).filter((g): g is string => g !== undefined).map((g) => asanaRef("user", g)) };
    }
  }
}

/** The kept custom field values of one task, by field id. */
export function asanaFieldValues(fields: unknown): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const f of list(fields)) {
    const id = gidOf(f.gid);
    const value = id && fieldValue(f);
    if (id && value) out[id] = value;
  }
  return out;
}

/** A project, with its sections as groups and its custom fields as columns, so departments can map them. */
export function asanaProjectEvents(project: Record<string, unknown>, sections: Record<string, unknown>[], receivedAt: string): AsanaBrainEvent[] {
  const projectId = gidOf(project?.gid);
  if (!projectId) return [];
  const occurredAt = asanaTime(project.modified_at);
  const fields = list(project.custom_field_settings)
    .map((s) => s.custom_field as Record<string, unknown> | undefined)
    .filter((f): f is Record<string, unknown> => !!f && gidOf(f.gid) !== undefined);
  return [
    event(`project:${projectId}:${version(occurredAt)}`, "work.board_updated", occurredAt, receivedAt, defined({
      boardId: asanaRef("project", projectId),
      name: str(project.name) ?? `Project ${projectId}`,
      state: project.archived === true ? "archived" : "active",
      createdAt: asanaTime(project.created_at),
      startOn: asanaDay(project.start_on),
      dueOn: asanaDay(project.due_on),
      ownerId: refOf("user", project.owner),
      teamId: refOf("team", project.team),
      columns: fields.map((f) => defined({ id: f.gid, type: str(f.resource_subtype, 40), title: str(f.name, 100) })),
      groups: sections.filter((s) => gidOf(s.gid)).map((s) => defined({ id: s.gid, title: str(s.name, 100) })),
    })),
  ];
}

/** One task version. A task with no usable id is dropped; one with no readable modified_at is dead-lettered. */
export function asanaTaskEvents(task: Record<string, unknown>, projectId: string, receivedAt: string): AsanaBrainEvent[] {
  const taskId = gidOf(task?.gid);
  if (!taskId || !GID.test(projectId)) return [];
  const occurredAt = asanaTime(task.modified_at);
  const membership = list(task.memberships).find((m) => gidOf((m.project as { gid?: unknown } | undefined)?.gid) === projectId);
  const section = gidOf((membership?.section as { gid?: unknown } | undefined)?.gid);
  const completed = task.completed === true;
  return [
    event(`task:${taskId}:${version(occurredAt)}`, "work.item_updated", occurredAt, receivedAt, defined({
      itemId: asanaRef("task", taskId),
      boardId: asanaRef("project", projectId),
      groupId: section,
      kind: str(task.resource_subtype, 40),
      state: "active",
      completed,
      completedAt: completed ? asanaTime(task.completed_at) : undefined,
      createdAt: asanaTime(task.created_at),
      updatedAt: occurredAt,
      startOn: asanaDay(task.start_on),
      dueOn: asanaDay(task.due_on) ?? asanaTime(task.due_at)?.slice(0, 10),
      dueAt: asanaTime(task.due_at),
      assigneeId: refOf("user", task.assignee),
      parentId: refOf("task", task.parent),
      columns: asanaFieldValues(task.custom_fields),
    })),
  ];
}

/** A comment on a task: who wrote it and when, never what it says. Stories that aren't comments are dropped. */
export function asanaCommentEvents(story: Record<string, unknown>, taskId: string, receivedAt: string): AsanaBrainEvent[] {
  const storyId = gidOf(story?.gid);
  if (!storyId || story.resource_subtype !== "comment_added" || !GID.test(taskId)) return [];
  const occurredAt = asanaTime(story.created_at);
  return [
    event(`comment:${storyId}:${version(occurredAt)}`, "work.comment_updated", occurredAt, receivedAt, defined({
      commentId: asanaRef("story", storyId),
      itemId: asanaRef("task", taskId),
      creatorId: refOf("user", story.created_by),
      createdAt: occurredAt,
      updatedAt: occurredAt,
    })),
  ];
}
