import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { ASANA_GID, AsanaOffsetExpiredError, AsanaApiError, asanaClient, type AsanaClient, type AsanaClientOptions } from "./client.js";
import { asanaCommentEvents, asanaProjectEvents, asanaTaskEvents, type AsanaBrainEvent } from "./normalize.js";

/**
 * Asana: the projects a store tracks repairs, custom orders and production
 * jobs in. Each pass reads every workspace the token's user belongs to (or
 * the one ASANA_WORKSPACE_GID names), every project in it, archived ones
 * too, with its sections, then each project's tasks and the comments on
 * each task read.
 *
 * The historical import reads tasks changed in the last five years. Later
 * syncs ask Asana only for tasks changed since the last pass started, less
 * five minutes of overlap. Asana doesn't count a new comment as a change to
 * its task, so a comment on a task that otherwise didn't change is read on
 * the task's next change.
 *
 * Subtasks aren't listed in a project unless they were added to it, so they
 * aren't read. Asana's page offsets expire; a pass resumed with an offset
 * Asana no longer accepts reads that list again from its start, and the
 * records already stored are duplicates.
 */

/** Declared so they can be gated and audited; none runs while writes are off. */
export const ASANA_WRITES: WriteAction[] = [
  { integration: "asana", name: "create_task", description: "Create a task in a project, such as a new repair or custom order" },
  { integration: "asana", name: "comment_on_task", description: "Add a comment to a task" },
];

/** Each incremental pass starts this long before the previous one did, so a change saved mid-pass is never missed. */
export const ASANA_OVERLAP_MS = 5 * 60_000;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface AsanaCursor {
  pass: "historical" | "incremental";
  /** Workspaces still to read, the current one first. Empty once the pass is done. */
  workspaces: string[];
  /** Whether the current workspace's projects have been listed from the start yet. */
  listed: boolean;
  /** The offset of the current workspace's next page of projects, or null when the page read was the last. */
  projectsOffset: string | null;
  /** Projects from the page read still to work through, the current one first. */
  projects: string[];
  /** The offset of the current project's next page of tasks, or null to start it. */
  tasksOffset: string | null;
  /** ISO times: a pass keeps tasks changed from `since`, and the next pass starts at `nextFrom`. */
  since: string;
  nextFrom: string;
}

export interface AsanaOptions extends Partial<Pick<AsanaClientOptions, "fetch" | "sleep" | "rateLimitRetries">> {
  token: string;
  /** Read only this workspace, by its gid. Every workspace the user belongs to otherwise. */
  workspace?: string | undefined;
  /** Years of history the first import reads. Defaults to 5. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. Defaults to 24 hours. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: AsanaClient;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OFFSET = /^[A-Za-z0-9_.=+/-]{1,1024}$/;
const MAX_PROJECTS = 100;
const MAX_WORKSPACES = 100;
const isTime = (t: unknown) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t)) && new Date(t).toISOString() === t;
const isOffset = (o: unknown) => o === null || (typeof o === "string" && OFFSET.test(o));
const gids = (value: unknown, max: number) => Array.isArray(value) && value.length <= max && value.every((g) => typeof g === "string" && ASANA_GID.test(g));

export function parseAsanaCursor(raw: string | null): AsanaCursor | null {
  if (raw === null) return null;
  let c: AsanaCursor | null;
  try {
    c = JSON.parse(raw) as AsanaCursor | null;
  } catch {
    c = null;
  }
  const ok =
    typeof c === "object" &&
    c !== null &&
    (c.pass === "historical" || c.pass === "incremental") &&
    gids(c.workspaces, MAX_WORKSPACES) &&
    typeof c.listed === "boolean" &&
    isOffset(c.projectsOffset) &&
    gids(c.projects, MAX_PROJECTS) &&
    isOffset(c.tasksOffset) &&
    isTime(c.since) &&
    isTime(c.nextFrom) &&
    // A project or an offset only makes sense inside a workspace still being read.
    (c.workspaces.length > 0 || (c.projects.length === 0 && c.projectsOffset === null && !c.listed)) &&
    (c.tasksOffset === null || c.projects.length > 0) &&
    (c.listed || c.projectsOffset === null);
  if (!ok || !c) throw new Error("Asana checkpoint is not in the expected shape");
  const { pass, workspaces, listed, projectsOffset, projects, tasksOffset, since, nextFrom } = c;
  return { pass, workspaces, listed, projectsOffset, projects, tasksOffset, since, nextFrom };
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

export function asanaConnector(options: AsanaOptions): Connector {
  if (options.workspace !== undefined && !ASANA_GID.test(options.workspace)) throw new Error("ASANA_WORKSPACE_GID must be a workspace's id, a string of digits");
  const client = options.client ?? asanaClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = positive(options.historyYears ?? 5, "historyYears");
  const lookbackHours = positive(options.incrementalLookbackHours ?? 24, "incrementalLookbackHours");

  /** Every page of a short list (a project's sections, a task's stories), read in one go so no offset is kept. */
  async function all(read: (offset: string | null) => Promise<{ data: Record<string, unknown>[]; next: string | null }>): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let offset: string | null = null;
    do {
      const page = await read(offset);
      out.push(...page.data);
      offset = page.next;
    } while (offset);
    return out;
  }

  /** A project or task deleted part way through a pass answers 404; it has nothing left to read. */
  async function unlessGone<T>(read: () => Promise<T>, gone: T): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof AsanaApiError && error.status === 404) return gone;
      throw error;
    }
  }

  async function start(mode: "historical" | "incremental", saved: AsanaCursor | null, at: Date): Promise<AsanaCursor> {
    let since: string;
    if (mode === "historical") {
      const from = new Date(at);
      from.setUTCFullYear(from.getUTCFullYear() - historyYears);
      since = from.toISOString();
    } else {
      since = saved?.nextFrom ?? new Date(at.getTime() - lookbackHours * 3_600_000).toISOString();
    }
    const workspaces = options.workspace ? [options.workspace] : (await client.workspaces()).slice(0, MAX_WORKSPACES);
    return { pass: mode, workspaces, listed: false, projectsOffset: null, projects: [], tasksOffset: null, since, nextFrom: new Date(at.getTime() - ASANA_OVERLAP_MS).toISOString() };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseAsanaCursor(context.cursor);
    const at = now();
    let c: AsanaCursor;
    if (mode === "historical") {
      // A finished import stays finished (no workspaces left); an interrupted one resumes.
      c = saved?.pass === "historical" ? saved : await start(mode, saved, at);
    } else {
      c = saved?.pass === "incremental" && saved.workspaces.length > 0 ? saved : await start(mode, saved, at);
    }
    if (c.workspaces.length === 0 && saved === c) return;
    const receivedAt = at.toISOString();
    // Lists restarted after an expired offset, so one whose offset keeps expiring stops the sync instead of looping.
    const restarted = new Set<string>();
    const cursor = () => JSON.stringify(c);

    while (c.workspaces.length > 0) {
      const workspace = c.workspaces[0]!;
      if (c.projects.length === 0) {
        if (c.listed && c.projectsOffset === null) {
          c = { ...c, workspaces: c.workspaces.slice(1), listed: false };
          continue;
        }
        let page;
        try {
          page = await client.projects(workspace, c.projectsOffset);
        } catch (error) {
          if (!(error instanceof AsanaOffsetExpiredError) || restarted.has(`workspace:${workspace}`)) throw error;
          restarted.add(`workspace:${workspace}`);
          c = { ...c, listed: false, projectsOffset: null };
          continue;
        }
        const events: AsanaBrainEvent[] = [];
        const projects: string[] = [];
        for (const project of page.data) {
          const id = typeof project.gid === "string" && ASANA_GID.test(project.gid) ? project.gid : undefined;
          if (!id) continue;
          const sections = await unlessGone(() => all((offset) => client.sections(id, offset)), [] as Record<string, unknown>[]);
          events.push(...asanaProjectEvents(project, sections, receivedAt));
          projects.push(id);
        }
        c = { ...c, listed: true, projectsOffset: page.next, projects: projects.slice(0, MAX_PROJECTS), tasksOffset: null };
        yield { events, cursor: cursor() };
        continue;
      }

      const project = c.projects[0]!;
      let page;
      try {
        page = await unlessGone(() => client.tasks(project, c.since, c.tasksOffset), { data: [], next: null });
      } catch (error) {
        if (!(error instanceof AsanaOffsetExpiredError) || restarted.has(`project:${project}`)) throw error;
        restarted.add(`project:${project}`);
        c = { ...c, tasksOffset: null };
        continue;
      }
      const events: AsanaBrainEvent[] = [];
      for (const task of page.data) {
        const read = asanaTaskEvents(task, project, receivedAt);
        if (read.length === 0) continue;
        events.push(...read);
        const id = task.gid as string;
        const stories = await unlessGone(() => all((offset) => client.stories(id, offset)), [] as Record<string, unknown>[]);
        for (const story of stories) events.push(...asanaCommentEvents(story, id, receivedAt));
      }
      c = page.next ? { ...c, tasksOffset: page.next } : { ...c, projects: c.projects.slice(1), tasksOffset: null };
      yield { events, cursor: cursor() };
    }
    // The pass is done: the checkpoint keeps where the next one starts.
    yield { events: [], cursor: cursor() };
  }

  return {
    source: "asana",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: ASANA_WRITES,
  };
}
