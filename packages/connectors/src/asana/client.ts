/**
 * A small client for Asana's REST API (1.0): the signed-in user's
 * workspaces, each workspace's projects, a project's sections and tasks,
 * and a task's stories. It only ever sends these five GETs, to Asana's fixed
 * address, and follows pages by their offset token rather than by the
 * next-page URI, so a page link can't send the token anywhere else.
 *
 * It names every field it wants with opt_fields, and never asks for a task's
 * name or notes, a story's text, or a custom field's text: those are where
 * customers' names and messages are written.
 */

export const ASANA_API = "https://app.asana.com/api/1.0";
/** Asana's largest page. */
export const ASANA_PAGE_SIZE = 100;
const MAX_RETRY_AFTER_S = 60;
/** Asana's ids (gids) are strings of digits. */
export const ASANA_GID = /^\d{1,32}$/;
const OFFSET = /^[A-Za-z0-9_.=+/-]{1,1024}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/** The fields read for each kind of record. Nothing here holds free text a person typed about a customer. */
export const ASANA_FIELDS = {
  me: ["workspaces.gid"],
  projects: ["archived", "created_at", "modified_at", "due_on", "start_on", "name", "owner.gid", "team.gid", "custom_field_settings.custom_field.gid", "custom_field_settings.custom_field.name", "custom_field_settings.custom_field.resource_subtype"],
  sections: ["name"],
  tasks: [
    "resource_subtype",
    "created_at",
    "modified_at",
    "completed",
    "completed_at",
    "due_on",
    "due_at",
    "start_on",
    "assignee.gid",
    "parent.gid",
    "memberships.project.gid",
    "memberships.section.gid",
    "custom_fields.gid",
    "custom_fields.resource_subtype",
    "custom_fields.number_value",
    "custom_fields.enum_value.gid",
    "custom_fields.enum_value.name",
    "custom_fields.multi_enum_values.gid",
    "custom_fields.multi_enum_values.name",
    "custom_fields.date_value.date",
    "custom_fields.date_value.date_time",
    "custom_fields.people_value.gid",
  ],
  stories: ["resource_subtype", "created_at", "created_by.gid"],
} as const;

export interface AsanaClientOptions {
  /** A personal access token or an OAuth access token. Sent to Asana only, and never logged or shown. */
  token: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class AsanaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsanaConfigError";
  }
}

export class AsanaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AsanaApiError";
  }
}

/** A saved offset token Asana no longer accepts; the list is read again from its start. */
export class AsanaOffsetExpiredError extends AsanaApiError {
  constructor(what: string) {
    super(`Asana no longer accepts the saved page offset for ${what}`, 400);
    this.name = "AsanaOffsetExpiredError";
  }
}

export interface AsanaPage {
  data: Record<string, unknown>[];
  /** The offset token for the next page, or null on the last page. */
  next: string | null;
}

export interface AsanaClient {
  /** The gids of the workspaces the token's user belongs to. */
  workspaces(): Promise<string[]>;
  /** One page of a workspace's projects, archived ones included. */
  projects(workspace: string, offset?: string | null): Promise<AsanaPage>;
  /** One page of a project's sections. */
  sections(project: string, offset?: string | null): Promise<AsanaPage>;
  /** One page of a project's tasks, those changed since `modifiedSince` when given. */
  tasks(project: string, modifiedSince: string | null, offset?: string | null): Promise<AsanaPage>;
  /** One page of a task's stories (comments and the changes Asana records). */
  stories(task: string, offset?: string | null): Promise<AsanaPage>;
}

const gid = (value: string, what: string) => {
  if (!ASANA_GID.test(value)) throw new AsanaApiError(`${what} id is not an Asana id`, 0);
  return value;
};

/** Seconds from a Retry-After header, or undefined when it doesn't read as seconds. */
function retryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value);
}

export function asanaClient(options: AsanaClientOptions): AsanaClient {
  if (!/^[A-Za-z0-9/:._-]{20,4096}$/.test(options.token)) throw new AsanaConfigError("ASANA_ACCESS_TOKEN is missing or not in the expected shape");
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.rateLimitRetries ?? 3;
  const headers = { Authorization: `Bearer ${options.token}`, Accept: "application/json" };

  async function get(path: string, query: Record<string, string>, what: string, offsetSent: boolean): Promise<Record<string, unknown>> {
    const url = new URL(`${ASANA_API}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { method: "GET", headers });
      if (response.status === 429 && attempt < retries) {
        const wait = retryAfter(response.headers.get("retry-after"));
        await sleep(1000 * (wait !== undefined ? Math.min(Math.max(wait, 1), MAX_RETRY_AFTER_S) : 2 ** attempt));
        continue;
      }
      const body = await response.json().catch(() => undefined);
      if (response.status === 401) throw new AsanaApiError("Asana turned down the token: check ASANA_ACCESS_TOKEN, which may have been revoked or expired", 401);
      if (response.status === 402) throw new AsanaApiError(`Asana needs a paid plan to read ${what}`, 402);
      if (response.status === 403) throw new AsanaApiError(`Asana's token isn't allowed to read ${what}`, 403);
      if (response.status === 404) throw new AsanaApiError(`Asana couldn't find ${what}`, 404);
      if (response.status === 400 && offsetSent) throw new AsanaOffsetExpiredError(what);
      if (response.status !== 200) throw new AsanaApiError(`Asana answered HTTP ${response.status} for ${what}`, response.status);
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new AsanaApiError(`Asana answered ${what} with a body that isn't a JSON object`, 200);
      return body as Record<string, unknown>;
    }
  }

  async function page(path: string, query: Record<string, string>, fields: readonly string[], what: string, offset: string | null | undefined): Promise<AsanaPage> {
    if (offset != null && !OFFSET.test(offset)) throw new AsanaApiError(`Asana sent a page offset for ${what} that isn't in the expected shape`, 200);
    const body = await get(path, { ...query, limit: String(ASANA_PAGE_SIZE), opt_fields: fields.join(","), ...(offset ? { offset } : {}) }, what, Boolean(offset));
    if (!Array.isArray(body.data)) throw new AsanaApiError(`Asana answered ${what} without the data list`, 200);
    const next = (body.next_page as { offset?: unknown } | null | undefined)?.offset;
    if (next != null && (typeof next !== "string" || !OFFSET.test(next))) throw new AsanaApiError(`Asana sent a page offset for ${what} that isn't in the expected shape`, 200);
    const data = (body.data as unknown[]).map((r) => (typeof r === "object" && r !== null && !Array.isArray(r) ? (r as Record<string, unknown>) : {}));
    return { data, next: (next as string | null | undefined) ?? null };
  }

  return {
    async workspaces() {
      const data = (await get("/users/me", { opt_fields: ASANA_FIELDS.me.join(",") }, "the signed-in user", false)).data as { workspaces?: unknown } | undefined;
      if (!Array.isArray(data?.workspaces)) throw new AsanaApiError("Asana answered the signed-in user without a list of workspaces", 200);
      return data.workspaces.map((w) => (w as { gid?: unknown } | null)?.gid).filter((g): g is string => typeof g === "string" && ASANA_GID.test(g));
    },
    projects: async (workspace, offset) => page("/projects", { workspace: gid(workspace, "workspace") }, ASANA_FIELDS.projects, "projects", offset),
    sections: async (project, offset) => page(`/projects/${gid(project, "project")}/sections`, {}, ASANA_FIELDS.sections, "a project's sections", offset),
    async tasks(project, modifiedSince, offset) {
      if (modifiedSince !== null && !ISO.test(modifiedSince)) throw new AsanaApiError("modified_since must be a UTC time", 0);
      return page("/tasks", { project: gid(project, "project"), ...(modifiedSince ? { modified_since: modifiedSince } : {}) }, ASANA_FIELDS.tasks, "a project's tasks", offset);
    },
    stories: async (task, offset) => page(`/tasks/${gid(task, "task")}/stories`, {}, ASANA_FIELDS.stories, "a task's stories", offset),
  };
}
