import { createHash } from "node:crypto";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Microsoft's client credentials sign-in and Microsoft Graph's driveItem
 * delta (v1.0), built from the Microsoft identity platform and Graph
 * reference pages. Data is synthetic. Every change goes into a log, so a
 * delta token carries on with exactly what changed after the listing,
 * deletions included, as Graph's does. The sign-in checks the tenant,
 * client id, secret and scope, and gives a JWT whose roles claim lists the
 * application permissions the app was given.
 */
const LOGIN = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
const DRIVE_ITEM = "https://learn.microsoft.com/en-us/graph/api/resources/driveitem";
const DELTA = "https://learn.microsoft.com/en-us/graph/api/driveitem-delta";
const CLIENT_CREDENTIALS = "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow";

export interface MicrosoftOneDriveMockFile {
  /** The path below the library's root, such as `Statements/2026-10.csv`. */
  path: string;
  /** Omit for a folder. */
  content?: string | undefined;
  modified?: string | undefined;
  mimeType?: string | undefined;
}

export interface MicrosoftOneDriveMockData {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  driveId: string;
  /** The application permissions the app was given, as the token's roles claim lists them; null leaves the claim out. */
  roles: string[] | null;
  files: MicrosoftOneDriveMockFile[];
  /** Items per page the mock caps at, to exercise paging. */
  pageCap?: number | undefined;
  /** How many of the next delta calls answer 429, with Retry-After `retryAfter` (default 1). */
  rateLimited?: number | undefined;
  retryAfter?: string | undefined;
  /** When true, Graph answers 403 as it does before the read role is granted on the site. */
  notGranted?: boolean | undefined;
}

export interface MicrosoftOneDriveMock {
  login: DocMock;
  graph: DocMock;
  fetch: DocMockFetch;
  /** Adds or replaces a file or folder, as an upload, edit or new folder would. */
  put(file: MicrosoftOneDriveMockFile): void;
  /** Renames or moves an item, keeping its id. */
  move(from: string, to: string): void;
  /** Deletes a file or folder and everything below it. */
  remove(path: string): void;
  /** Makes every delta token handed out so far answer 410 Gone. */
  expireTokens(): void;
  /** Makes every access token handed out so far stop working. */
  revokeTokens(): void;
  readonly signIns: number;
}

type Item = { id: string; path: string; lower: string; folder: boolean; content: string; modified: string; created: string; mimeType: string };
type Change = { kind: "put"; item: Item } | { kind: "delete"; id: string; name: string };
/** A delta token read back: the generation, the log position it was taken at, where a change round ends, the offset, and whether it is a listing. */
type Token = { g: number; at: number; end: number | null; offset: number; listing: boolean };

const graphError = (status: number, code: string, message: string, headers?: Record<string, string>): DocMockResponse => ({ status, body: { error: { code, message, innerError: { date: "2026-11-10T12:00:00", "request-id": "00000000-0000-4000-8000-000000000000" } } }, ...(headers ? { headers } : {}) });
const loginError = (status: number, error: string, code: number): DocMockResponse => ({ status, body: { error, error_description: `AADSTS${code}: synthetic.`, error_codes: [code], timestamp: "2026-11-10 12:00:00Z", trace_id: "00000000-0000-4000-8000-000000000000", correlation_id: "00000000-0000-4000-8000-000000000000" } });
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (lower: string) => (lower.includes("/") ? lower.slice(0, lower.lastIndexOf("/")) : "");

export function microsoftOneDriveDocMock(data: MicrosoftOneDriveMockData): MicrosoftOneDriveMock {
  const tokens = new Set<string>();
  const items = new Map<string, Item>();
  const log: Change[] = [];
  let signIns = 0;
  let ids = 0;
  let generation = 0;
  const rootId = `01KARAT${"R".repeat(27)}`;

  const nextId = () => `01KARAT${String(++ids).padStart(27, "0")}`;
  function put(file: MicrosoftOneDriveMockFile) {
    const lower = file.path.toLowerCase();
    const existing = items.get(lower);
    const item: Item = {
      id: existing?.id ?? nextId(),
      path: file.path,
      lower,
      folder: file.content === undefined,
      content: file.content ?? "",
      modified: file.modified ?? "2026-10-01T10:00:00Z",
      created: existing?.created ?? file.modified ?? "2026-10-01T10:00:00Z",
      mimeType: file.mimeType ?? "application/octet-stream",
    };
    items.set(lower, item);
    log.push({ kind: "put", item });
  }
  function move(from: string, to: string) {
    const lower = from.toLowerCase();
    for (const key of [...items.keys()].filter((k) => k === lower || k.startsWith(`${lower}/`))) {
      const item = items.get(key)!;
      items.delete(key);
      const path = to + item.path.slice(from.length);
      const moved = { ...item, path, lower: path.toLowerCase() };
      items.set(moved.lower, moved);
      // Graph reports the moved item itself; its children's ids and parents don't change.
      if (key === lower) log.push({ kind: "put", item: moved });
    }
  }
  function remove(path: string) {
    const lower = path.toLowerCase();
    for (const key of [...items.keys()].filter((k) => k === lower || k.startsWith(`${lower}/`))) {
      const item = items.get(key)!;
      items.delete(key);
      log.push({ kind: "delete", id: item.id, name: name(item.path) });
    }
  }
  for (const f of data.files) put(f);

  const parentId = (lower: string) => {
    const parent = parentOf(lower);
    return parent === "" ? rootId : (items.get(parent)?.id ?? rootId);
  };
  /** An item as Graph returns it, cut down to $select when the request has one. */
  const resource = (i: Item, select: string[] | null) => {
    const full: Record<string, unknown> = {
      id: i.id,
      name: name(i.path),
      size: i.folder ? 0 : Buffer.byteLength(i.content, "utf8"),
      createdDateTime: i.created,
      lastModifiedDateTime: i.modified,
      eTag: `"{${i.id}},1"`,
      webUrl: `https://contoso.sharepoint.example/sites/store/Shared%20Documents/${encodeURI(i.path)}`,
      createdBy: { user: { displayName: "Test Jeweler", email: "owner@example.test" } },
      lastModifiedBy: { user: { displayName: "Test Jeweler", email: "owner@example.test" } },
      parentReference: { driveType: "documentLibrary", driveId: data.driveId, id: parentId(i.lower) },
      ...(i.folder ? { folder: { childCount: [...items.keys()].filter((k) => parentOf(k) === i.lower).length } } : { file: { mimeType: i.mimeType, hashes: { quickXorHash: createHash("sha1").update(i.content).digest("base64") } } }),
    };
    return select ? Object.fromEntries(Object.entries(full).filter(([k]) => select.includes(k))) : full;
  };
  const root = (select: string[] | null) => {
    const full = { id: rootId, name: "root", root: {}, folder: { childCount: 0 }, createdDateTime: "2024-01-01T00:00:00Z", lastModifiedDateTime: "2026-10-01T10:00:00Z", parentReference: { driveType: "documentLibrary", driveId: data.driveId } };
    return select ? Object.fromEntries(Object.entries(full).filter(([k]) => select.includes(k))) : full;
  };
  const snapshot = (at: number) => {
    const state = new Map<string, Item>();
    for (const change of log.slice(0, at)) {
      if (change.kind === "put") {
        for (const [k, v] of state) if (v.id === change.item.id) state.delete(k);
        state.set(change.item.lower, change.item);
      } else for (const [k, v] of state) if (v.id === change.id) state.delete(k);
    }
    // Parents come before their children, as Graph lists them.
    return [...state.values()].sort((a, b) => a.lower.localeCompare(b.lower));
  };
  /** What changed in (at, end], each item once in its latest state, in the order of its last change. */
  const changes = (at: number, end: number) => {
    const last = new Map<string, Change>();
    for (const change of log.slice(at, end)) {
      const id = change.kind === "put" ? change.item.id : change.id;
      last.delete(id);
      last.set(id, change);
    }
    return [...last.values()];
  };
  const cap = () => data.pageCap ?? 200;
  const link = (t: Token, select: string | null) => {
    const url = new URL(`${GRAPH}/drives/${data.driveId}/root/delta`);
    url.searchParams.set("token", b64url(t));
    if (select !== null) url.searchParams.set("$select", select);
    return url.toString();
  };
  const decode = (raw: string): Token | null => {
    try {
      const t = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Token;
      return typeof t.g === "number" && typeof t.at === "number" && typeof t.offset === "number" && typeof t.listing === "boolean" ? t : null;
    } catch {
      return null;
    }
  };

  function page(t: Token, rawSelect: string | null): DocMockResponse {
    const select = rawSelect === null ? null : rawSelect.split(",");
    const context = `${GRAPH}/$metadata#Collection(driveItem)`;
    if (t.listing) {
      const all: Record<string, unknown>[] = [root(select), ...snapshot(t.at).map((i) => resource(i, select))];
      const rows = all.slice(t.offset, t.offset + cap());
      const offset = t.offset + rows.length;
      const more = offset < all.length;
      return { status: 200, body: { "@odata.context": context, value: rows, ...(more ? { "@odata.nextLink": link({ ...t, offset }, rawSelect) } : { "@odata.deltaLink": link({ g: t.g, at: t.at, end: null, offset: 0, listing: false }, rawSelect) }) } };
    }
    const end = t.end ?? log.length;
    const all = changes(t.at, end).map((c) => (c.kind === "put" ? resource(c.item, select) : { id: c.id, name: c.name, deleted: { state: "deleted" }, parentReference: { driveType: "documentLibrary", driveId: data.driveId } }));
    const rows = all.slice(t.offset, t.offset + cap());
    const offset = t.offset + rows.length;
    const more = offset < all.length;
    return { status: 200, body: { "@odata.context": context, value: rows, ...(more ? { "@odata.nextLink": link({ ...t, end, offset }, rawSelect) } : { "@odata.deltaLink": link({ g: t.g, at: end, end: null, offset: 0, listing: false }, rawSelect) }) } };
  }

  const login = checkDocMock({
    integration: "microsoft_onedrive",
    baseUrl: LOGIN,
    source: { url: CLIENT_CREDENTIALS, title: "Microsoft identity platform and the OAuth 2.0 client credentials flow", retrievedOn: "2026-11-10", version: "v2.0" },
    assumptions: [
      "A client credentials token for https://graph.microsoft.com/.default is a JWT whose roles claim lists the application permissions an admin consented to, and leaves the claim out when there are none",
      "A wrong or expired client secret answers 401 invalid_client with error code 7000215 or 7000222, an unknown app 400 unauthorized_client with 700016, and an unknown tenant 400 invalid_request with 90002",
    ],
    routes: [
      {
        method: "POST",
        path: "/{tenant}/oauth2/v2.0/token",
        documentedAt: CLIENT_CREDENTIALS,
        respond(request, params) {
          const form = new URLSearchParams(request.body);
          if (params.tenant !== data.tenantId) return loginError(400, "invalid_request", 90002);
          if (form.get("grant_type") !== "client_credentials") return loginError(400, "unsupported_grant_type", 70003);
          if (form.get("client_id") !== data.clientId) return loginError(400, "unauthorized_client", 700016);
          if (form.get("client_secret") !== data.clientSecret) return loginError(401, "invalid_client", 7000215);
          if (form.get("scope") !== "https://graph.microsoft.com/.default") return loginError(400, "invalid_scope", 1002012);
          signIns++;
          const claims = { aud: "https://graph.microsoft.com", iss: `https://sts.windows.net/${data.tenantId}/`, appid: data.clientId, tid: data.tenantId, n: signIns, ...(data.roles ? { roles: data.roles } : {}) };
          const token = `${b64url({ typ: "JWT", alg: "RS256" })}.${b64url(claims)}.${"s".repeat(43)}`;
          tokens.add(token);
          return { status: 200, body: { token_type: "Bearer", expires_in: 3599, ext_expires_in: 3599, access_token: token } };
        },
      },
    ],
  });

  const graph = checkDocMock({
    integration: "microsoft_onedrive",
    baseUrl: GRAPH,
    source: { url: DRIVE_ITEM, title: "driveItem resource type", retrievedOn: "2026-11-10", version: "v1.0" },
    auth: "bearer",
    assumptions: [
      "delta on a drive's root with no token lists every item the app can see, the root first and parents before their children, and its last page's deltaLink token returns only what changed after that",
      "Each changed item comes once, in its latest state; a deleted item carries the deleted facet and keeps its id, and parentReference.path isn't returned",
      "A delta token Graph can no longer use answers 410 Gone with code resyncChangesApplyDifferences",
      "An app given Sites.Selected with the read role on a site can read delta for that site's libraries, though Graph's delta page lists only Files.Read.All and broader application permissions",
      "$select cuts each item down to the fields named, and paging links keep it",
      "A drive the app hasn't been granted on the site answers 403 accessDenied, and a 429 carries Retry-After as whole seconds",
    ],
    routes: [
      {
        method: "GET",
        path: "/drives/{drive}/root/delta",
        documentedAt: DELTA,
        respond(request, params) {
          if (!tokens.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) return graphError(401, "InvalidAuthenticationToken", "Access token has expired or is not yet valid.");
          if (data.rateLimited) {
            data.rateLimited--;
            return graphError(429, "activityLimitReached", "The request has been throttled", { "Retry-After": data.retryAfter ?? "1" });
          }
          if (params.drive !== data.driveId) return graphError(404, "itemNotFound", "The resource could not be found.");
          if (data.notGranted) return graphError(403, "accessDenied", "Either scp or roles claim need to be present in the token.");
          const query = request.url.searchParams;
          if ([...query.keys()].some((k) => !["token", "$select", "$top"].includes(k))) return graphError(400, "invalidRequest", "Invalid request");
          const raw = query.get("token");
          const select = query.get("$select");
          if (raw === null || raw === "") return page({ g: generation, at: log.length, end: null, offset: 0, listing: true }, select);
          if (raw === "latest") return { status: 200, body: { value: [], "@odata.deltaLink": link({ g: generation, at: log.length, end: null, offset: 0, listing: false }, select) } };
          const t = decode(raw);
          if (!t) return graphError(400, "invalidRequest", "Invalid delta token");
          if (t.g !== generation) return graphError(410, "resyncChangesApplyDifferences", "Resync required.");
          return page(t, select);
        },
      },
    ],
  });

  const loginFetch = docMockFetch(login);
  const graphFetch = docMockFetch(graph);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      // Routed by exact origin, so a look-alike host goes to the Graph mock and is refused there.
      const toLogin = new URL(input instanceof Request ? input.url : String(input)).origin === LOGIN;
      const response = await (toLogin ? loginFetch : graphFetch)(input, init);
      calls.push(...(toLogin ? loginFetch.calls : graphFetch.calls).slice(-1));
      return response;
    },
    { calls },
  );

  return {
    login,
    graph,
    fetch,
    put,
    move,
    remove,
    expireTokens: () => void generation++,
    revokeTokens: () => tokens.clear(),
    get signIns() {
      return signIns;
    },
  };
}

export default {
  integration: "microsoft_onedrive",
  covers: "Microsoft's client credentials sign-in and Microsoft Graph's driveItem delta (v1.0)",
  watchPages: [CLIENT_CREDENTIALS, DRIVE_ITEM, DELTA],
  docMocks: () => {
    const mock = microsoftOneDriveDocMock({ tenantId: "", clientId: "", clientSecret: "", driveId: "", roles: null, files: [] });
    return [mock.login, mock.graph];
  },
} satisfies DocMockModule;
