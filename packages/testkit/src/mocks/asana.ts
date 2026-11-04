import { checkDocMock, type DocMock, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Asana's REST API (1.0) endpoints for the signed-in user, a workspace's
 * projects, a project's sections and tasks, and a task's stories, built
 * from the API reference. Data is synthetic. Like Asana, the mock returns
 * only the gid and the fields opt_fields names, so a test can show the
 * connector never asks for a task's name or notes.
 */
const API = "https://app.asana.com/api/1.0";
const DOCS = "https://developers.asana.com/reference";

export interface AsanaMockProject {
  gid: string;
  workspace: string;
  name: string;
  archived: boolean;
  created_at: string;
  modified_at: string;
  due_on?: string | null;
  start_on?: string | null;
  owner?: { gid: string } | null;
  team?: { gid: string } | null;
  notes?: string;
  custom_field_settings?: { custom_field: { gid: string; name: string; resource_subtype: string } }[];
}

export interface AsanaMockTask {
  gid: string;
  /** Projects the task is in, with its section in each. */
  memberships: { project: { gid: string }; section?: { gid: string } }[];
  name: string;
  notes: string;
  resource_subtype?: "default_task" | "milestone" | "approval";
  created_at: string;
  modified_at: string;
  completed: boolean;
  completed_at?: string | null;
  due_on?: string | null;
  due_at?: string | null;
  start_on?: string | null;
  assignee?: { gid: string } | null;
  parent?: { gid: string } | null;
  custom_fields?: Record<string, unknown>[];
}

export interface AsanaMockStory {
  gid: string;
  resource_subtype: string;
  created_at: string;
  created_by?: { gid: string } | null;
  text?: string;
}

export interface AsanaMockData {
  workspaces: string[];
  projects: AsanaMockProject[];
  /** Sections by project gid. */
  sections?: Record<string, { gid: string; name: string }[]>;
  tasks: AsanaMockTask[];
  /** Stories by task gid. */
  stories?: Record<string, AsanaMockStory[]>;
  /** The token the mock accepts. Any bearer token is accepted when absent. */
  token?: string;
  /** Rows per page the mock caps at, to exercise paging. Defaults to 100. */
  pageCap?: number;
  /** How many of the next requests answer 429, each with Retry-After `retryAfter` seconds (default 1). */
  rateLimited?: number;
  retryAfter?: string;
  /** How many of the next requests carrying an offset answer 400, as an expired offset does. */
  expiredOffsets?: number;
}

const error = (status: number, message: string): DocMockResponse => ({ status, body: { errors: [{ message, help: "For more information on API status codes and how to handle them, read the docs on errors: https://developers.asana.com/docs/errors" }] } });

/** The gid plus each field opt_fields names, following dotted paths into objects and lists, as Asana does. */
export function asanaPick(record: unknown, fields: string[]): unknown {
  if (Array.isArray(record)) return record.map((r) => asanaPick(r, fields));
  if (typeof record !== "object" || record === null) return record;
  const r = record as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ("gid" in r) out.gid = r.gid;
  const groups = new Map<string, string[]>();
  for (const f of fields) {
    const [head, ...rest] = f.split(".");
    if (!groups.has(head!)) groups.set(head!, []);
    if (rest.length) groups.get(head!)!.push(rest.join("."));
  }
  for (const [head, rest] of groups) {
    if (!(head in r)) continue;
    out[head] = rest.length ? asanaPick(r[head], rest) : r[head];
  }
  return out;
}

export function asanaDocMock(data: AsanaMockData): DocMock {
  const denied = (request: { headers: Headers; url: URL }): DocMockResponse | null => {
    if (data.token !== undefined && request.headers.get("authorization") !== `Bearer ${data.token}`) return error(401, "Not Authorized");
    if (data.rateLimited) {
      data.rateLimited--;
      return { ...error(429, "You have made too many requests recently. Please, be chill."), headers: { "Retry-After": data.retryAfter ?? "1" } };
    }
    if (data.expiredOffsets && request.url.searchParams.has("offset")) {
      data.expiredOffsets--;
      return error(400, "offset: Your pagination token has expired.");
    }
    return null;
  };
  const fields = (url: URL) => (url.searchParams.get("opt_fields") ?? "").split(",").filter(Boolean);
  const paged = (rows: unknown[], url: URL): DocMockResponse => {
    const asked = Number(url.searchParams.get("limit") ?? 100);
    if (!Number.isInteger(asked) || asked < 1 || asked > 100) return error(400, "limit: Must be between 1 and 100");
    const limit = Math.min(asked, data.pageCap ?? 100);
    const offset = url.searchParams.has("offset") ? Number(/^offset-(\d+)$/.exec(url.searchParams.get("offset")!)?.[1] ?? NaN) : 0;
    if (!Number.isInteger(offset)) return error(400, "offset: Not a valid offset");
    const next = offset + limit < rows.length ? `offset-${offset + limit}` : null;
    const path = url.pathname.replace(/^\/api\/1\.0/, "");
    return {
      status: 200,
      body: { data: asanaPick(rows.slice(offset, offset + limit), fields(url)), next_page: next && { offset: next, path: `${path}?limit=${limit}&offset=${next}`, uri: `${API}${path}?limit=${limit}&offset=${next}` } },
    };
  };
  const project = (gid: string | undefined) => data.projects.find((p) => p.gid === gid);
  return checkDocMock({
    integration: "asana",
    baseUrl: API,
    source: { url: `${DOCS}/rest-api-reference`, title: "Asana API reference", retrievedOn: "2026-11-03", version: "1.0" },
    auth: "bearer",
    assumptions: [
      "An expired offset answers 400 with an error naming the offset",
      "A task's modified_at doesn't change when a comment is added, as the docs say",
      "Listing a project's tasks returns completed tasks too unless completed_since is sent",
      "modified_since keeps tasks whose modified_at is at or after the time given",
      "Projects are listed in a stable order, so offsets resume where they left off",
      "A 429 carries Retry-After as whole seconds",
    ],
    routes: [
      {
        method: "GET",
        path: "/users/me",
        documentedAt: `${DOCS}/getuser`,
        respond: (request) =>
          denied(request) ?? { status: 200, body: { data: asanaPick({ gid: "9001", resource_type: "user", name: "Test User", email: "user@example.test", workspaces: data.workspaces.map((gid) => ({ gid, resource_type: "workspace", name: `Test Workspace ${gid}` })) }, fields(request.url)) } },
      },
      {
        method: "GET",
        path: "/projects",
        documentedAt: `${DOCS}/getprojects`,
        respond(request) {
          const no = denied(request);
          if (no) return no;
          const workspace = request.url.searchParams.get("workspace");
          if (!workspace && !request.url.searchParams.get("team")) return error(400, "workspace: Missing input");
          if (workspace && !data.workspaces.includes(workspace)) return error(403, "workspace: Not a recognized ID");
          return paged(data.projects.filter((p) => p.workspace === workspace), request.url);
        },
      },
      {
        method: "GET",
        path: "/projects/{project_gid}/sections",
        documentedAt: `${DOCS}/getsectionsforproject`,
        respond(request, params) {
          const no = denied(request);
          if (no) return no;
          if (!project(params.project_gid)) return error(404, "project: Unknown object");
          return paged(data.sections?.[params.project_gid!] ?? [], request.url);
        },
      },
      {
        method: "GET",
        path: "/tasks",
        documentedAt: `${DOCS}/gettasks`,
        respond(request) {
          const no = denied(request);
          if (no) return no;
          const q = request.url.searchParams;
          const gid = q.get("project");
          if (!gid) return error(400, "project: Must specify exactly one of project, tag, section, user task list, or assignee + workspace");
          if (!project(gid)) return error(404, "project: Unknown object");
          const since = q.get("modified_since");
          if (since !== null && Number.isNaN(Date.parse(since))) return error(400, "modified_since: Not a valid date-time");
          const rows = data.tasks.filter((t) => t.memberships.some((m) => m.project.gid === gid) && (since === null || Date.parse(t.modified_at) >= Date.parse(since)));
          return paged(rows, request.url);
        },
      },
      {
        method: "GET",
        path: "/tasks/{task_gid}/stories",
        documentedAt: `${DOCS}/getstoriesfortask`,
        respond(request, params) {
          const no = denied(request);
          if (no) return no;
          if (!data.tasks.some((t) => t.gid === params.task_gid)) return error(404, "task: Unknown object");
          return paged(data.stories?.[params.task_gid!] ?? [], request.url);
        },
      },
    ],
  });
}

export default {
  integration: "asana",
  covers: "Asana's current user, project, section, task and story endpoints (REST API 1.0)",
  watchPages: [`${DOCS}/rest-api-reference`, `${DOCS}/getuser`, `${DOCS}/getprojects`, `${DOCS}/getsectionsforproject`, `${DOCS}/gettasks`, `${DOCS}/getstoriesfortask`],
  docMocks: () => [asanaDocMock({ workspaces: [], projects: [], tasks: [] })],
} satisfies DocMockModule;
