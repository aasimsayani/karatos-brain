import { createHash } from "node:crypto";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * Dropbox's token refresh, current account, folder listing with its change
 * feed, and download endpoints (API v2), built from Dropbox's HTTP
 * documentation and OAuth guide. Data is synthetic. Every change goes into
 * a log, so a listing cursor carries on with exactly what changed after the
 * listing, deletions included, as Dropbox's does. The token refresh checks
 * the app's key, secret and refresh token, and gives a token with only the
 * scopes asked for, which must be among the app's own.
 */
const API = "https://api.dropboxapi.com";
const CONTENT = "https://content.dropboxapi.com";
const DOCS = "https://www.dropbox.com/developers/documentation/http/documentation";
const OAUTH = "https://developers.dropbox.com/oauth-guide";

export interface DropboxMockFile {
  /** The path as shown, such as `/Statements/2026-10.csv`. */
  path: string;
  /** Omit for a folder. */
  content?: string | undefined;
  serverModified?: string | undefined;
  /** False for a file Dropbox can't download, such as a Google Doc. */
  downloadable?: boolean | undefined;
}

export interface DropboxMockData {
  appKey: string;
  appSecret: string;
  refreshToken: string;
  accountId: string;
  /** The scopes turned on in the app's Permissions tab. */
  appScopes: string[];
  /** Overrides the scopes a token is reported to have, to show the client stops. */
  grantedScope?: string | undefined;
  files: DropboxMockFile[];
  /** A team space's root namespace, which differs from the home one. */
  rootNamespaceId?: string | undefined;
  /** Entries per page the mock caps at, to exercise paging. */
  pageCap?: number | undefined;
  /** How many of the next listing calls answer 429, with Retry-After `retryAfter` (default 1). */
  rateLimited?: number | undefined;
  retryAfter?: string | undefined;
}

export interface DropboxMock {
  api: DocMock;
  content: DocMock;
  fetch: DocMockFetch;
  /** Adds or replaces a file or folder, as an upload or edit would. */
  put(file: DropboxMockFile): void;
  /** Deletes a file or folder and everything below it. */
  remove(path: string): void;
  /** Makes every cursor handed out so far answer reset. */
  resetCursors(): void;
  /** Makes every token handed out so far stop working. */
  revokeTokens(): void;
  readonly signIns: number;
}

type Item = { path: string; lower: string; id: string; folder: boolean; content: string; serverModified: string; rev: string; downloadable: boolean };
type Change = { kind: "put"; item: Item } | { kind: "delete"; path: string; lower: string };

const error = (status: number, summary: string, extra: Record<string, unknown> = {}): DocMockResponse => ({ status, body: { error_summary: `${summary}/..`, error: { ".tag": summary.split("/")[0], ...extra } } });
const sha = (data: Buffer) => createHash("sha256").update(data).digest();
/** Dropbox's content hash: SHA-256 over the SHA-256 of each 4 MB block. */
const contentHash = (text: string) => {
  const data = Buffer.from(text, "utf8");
  const blocks: Buffer[] = [];
  for (let i = 0; i < data.length; i += 4 * 1024 * 1024) blocks.push(sha(data.subarray(i, i + 4 * 1024 * 1024)));
  return createHash("sha256").update(Buffer.concat(blocks)).digest("hex");
};
const parse = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};
const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const under = (lower: string, folder: string, recursive: boolean) => lower.startsWith(`${folder}/`) && (recursive || !lower.slice(folder.length + 1).includes("/"));

export function dropboxDocMock(data: DropboxMockData): DropboxMock {
  const tokens = new Set<string>();
  const items = new Map<string, Item>();
  const log: Change[] = [];
  let signIns = 0;
  let ids = 0;
  let generation = 0;
  const root = data.rootNamespaceId ?? "3235641";

  function put(file: DropboxMockFile) {
    const lower = file.path.toLowerCase();
    const existing = items.get(lower);
    ids++;
    const item: Item = {
      path: file.path,
      lower,
      id: existing?.id ?? `id:a4ayc_80_OEAAAAAAAAA${String(ids).padStart(3, "0")}`,
      folder: file.content === undefined,
      content: file.content ?? "",
      serverModified: file.serverModified ?? "2026-10-01T10:00:00Z",
      rev: `0157a${String(ids).padStart(8, "0")}`,
      downloadable: file.downloadable ?? true,
    };
    items.set(lower, item);
    log.push({ kind: "put", item });
  }
  function remove(path: string) {
    const lower = path.toLowerCase();
    for (const key of [...items.keys()]) {
      if (key === lower || key.startsWith(`${lower}/`)) {
        const item = items.get(key)!;
        items.delete(key);
        log.push({ kind: "delete", path: item.path, lower: key });
      }
    }
  }
  for (const f of data.files) put(f);

  const metadata = (i: Item) =>
    i.folder
      ? { ".tag": "folder", name: name(i.path), path_lower: i.lower, path_display: i.path, id: i.id, sharing_info: { read_only: false, parent_shared_folder_id: "84528192421", traverse_only: false, no_access: false } }
      : {
          ".tag": "file",
          name: name(i.path),
          path_lower: i.lower,
          path_display: i.path,
          id: i.id,
          client_modified: i.serverModified,
          server_modified: i.serverModified,
          rev: i.rev,
          size: Buffer.byteLength(i.content, "utf8"),
          is_downloadable: i.downloadable,
          content_hash: contentHash(i.content),
          sharing_info: { read_only: false, parent_shared_folder_id: "84528192421", modified_by: "dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc" },
        };

  /** Cursors read back: the folder, whether recursive, the log position the listing was taken at, where in it the next page starts, and the page size, which a continue keeps. */
  type Cursor = { g: number; folder: string; recursive: boolean; at: number; offset: number; listing: boolean; limit: number };
  const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
  const decode = (raw: unknown): Cursor | null => {
    if (typeof raw !== "string") return null;
    const c = parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor | undefined;
    return c && typeof c.folder === "string" && typeof c.at === "number" ? c : null;
  };
  /** The items under a folder as they stood at a point in the log. */
  const snapshot = (folder: string, recursive: boolean, at: number) => {
    const state = new Map<string, Item>();
    for (const change of log.slice(0, at)) {
      if (change.kind === "put") state.set(change.item.lower, change.item);
      else state.delete(change.lower);
    }
    return [...state.values()].filter((i) => under(i.lower, folder, recursive)).sort((a, b) => a.lower.localeCompare(b.lower));
  };
  const cap = () => data.pageCap ?? 2000;

  function listPage(c: Cursor): DocMockResponse {
    const limit = c.limit;
    if (c.listing) {
      const all = snapshot(c.folder, c.recursive, c.at);
      const rows = all.slice(c.offset, c.offset + Math.min(limit, cap()));
      const offset = c.offset + rows.length;
      const more = offset < all.length;
      return { status: 200, body: { entries: rows.map(metadata), cursor: encode({ ...c, offset: more ? offset : 0, listing: more }), has_more: more } };
    }
    // The change feed: what happened under the folder after `at`.
    const changes = log.slice(c.at).filter((ch) => under(ch.kind === "put" ? ch.item.lower : ch.lower, c.folder, c.recursive));
    const rows = changes.slice(0, Math.min(limit, cap()));
    const consumed = rows.length === changes.length ? log.length : log.indexOf(rows[rows.length - 1]!) + 1;
    const entries = rows.map((ch) => (ch.kind === "put" ? metadata(ch.item) : { ".tag": "deleted", name: name(ch.path), path_lower: ch.lower, path_display: ch.path }));
    return { status: 200, body: { entries, cursor: encode({ ...c, at: consumed, offset: 0, listing: false }), has_more: rows.length < changes.length } };
  }

  const signedIn = (request: DocMockRequest) => tokens.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  /** Checks the token and the path root, and answers 429 when told to. */
  const denied = (request: DocMockRequest, throttle: boolean): DocMockResponse | null => {
    if (!signedIn(request)) return error(401, "expired_access_token");
    const pathRoot = request.headers.get("dropbox-api-path-root");
    if (pathRoot !== null) {
      const header = parse(pathRoot) as { ".tag"?: unknown; root?: unknown } | undefined;
      if (header?.[".tag"] !== "root" || header.root !== root) return { status: 422, body: { error_summary: "invalid_root/..", error: { ".tag": "invalid_root" } } };
    }
    if (throttle && data.rateLimited) {
      data.rateLimited--;
      return { ...error(429, "too_many_requests", { reason: { ".tag": "too_many_requests" }, retry_after: Number(data.retryAfter ?? "1") }), headers: { "Retry-After": data.retryAfter ?? "1" } };
    }
    return null;
  };

  const api = checkDocMock({
    integration: "dropbox",
    baseUrl: API,
    source: { url: DOCS, title: "Dropbox HTTP API documentation", retrievedOn: "2026-11-09", version: "v2" },
    assumptions: [
      "A refresh_token grant takes a scope parameter naming a subset of the app's scopes, and the token answer's scope lists only those",
      "list_folder with recursive true includes entries in mounted shared folders below the path, and its cursor's change feed reports deletions as deleted entries",
      "A cursor Dropbox wants restarted answers 409 with an error_summary starting reset/",
      "A 429 carries Retry-After as whole seconds",
      "Dropbox-API-Path-Root with the account's root namespace makes paths match the Dropbox website in a team space, and changes nothing in a personal account",
    ],
    routes: [
      {
        method: "POST",
        path: "/oauth2/token",
        documentedAt: OAUTH,
        respond(request) {
          const form = new URLSearchParams(request.body);
          if (form.get("grant_type") !== "refresh_token") return { status: 400, body: { error: "unsupported_grant_type", error_description: "grant_type is invalid" } };
          if (form.get("client_id") !== data.appKey || form.get("client_secret") !== data.appSecret) return { status: 400, body: { error: "invalid_client", error_description: "Invalid client_id or client_secret" } };
          if (form.get("refresh_token") !== data.refreshToken) return { status: 400, body: { error: "invalid_grant", error_description: "refresh token is invalid or revoked" } };
          const asked = (form.get("scope") ?? data.appScopes.join(" ")).split(" ").filter(Boolean);
          if (asked.some((s) => !data.appScopes.includes(s))) return { status: 400, body: { error: "invalid_scope", error_description: "scope is not granted to the app" } };
          signIns++;
          const token = `sl.u.${"t".repeat(40)}${signIns}`;
          tokens.add(token);
          return { status: 200, body: { access_token: token, token_type: "bearer", expires_in: 14400, scope: data.grantedScope ?? asked.join(" ") } };
        },
      },
      {
        method: "POST",
        path: "/2/users/get_current_account",
        documentedAt: DOCS,
        respond(request) {
          const no = denied(request, false);
          if (no) return no;
          if (request.body !== "null" && request.body !== "") return error(400, "bad_request");
          return {
            status: 200,
            body: {
              account_id: data.accountId,
              name: { given_name: "Test", surname: "Jeweler", familiar_name: "Test", display_name: "Test Jeweler", abbreviated_name: "TJ" },
              email: "owner@example.test",
              email_verified: true,
              disabled: false,
              locale: "en",
              country: "US",
              account_type: { ".tag": "basic" },
              root_info: { ".tag": data.rootNamespaceId ? "team" : "user", root_namespace_id: root, home_namespace_id: "3235641" },
            },
          };
        },
      },
      {
        method: "POST",
        path: "/2/files/list_folder",
        documentedAt: DOCS,
        respond(request) {
          const no = denied(request, true);
          if (no) return no;
          const body = parse(request.body) as Record<string, unknown> | undefined;
          const keys = new Set(["path", "recursive", "include_media_info", "include_deleted", "include_has_explicit_shared_members", "include_mounted_folders", "limit", "shared_link", "include_property_groups", "include_non_downloadable_files"]);
          if (!body || typeof body !== "object" || Object.keys(body).some((k) => !keys.has(k)) || typeof body.path !== "string") return error(400, "bad_request");
          const limit = body.limit ?? 2000;
          if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 2000) return error(400, "bad_request");
          const folder = body.path.toLowerCase();
          if (!items.get(folder)?.folder) return error(409, "path/not_found");
          return listPage({ g: generation, folder, recursive: body.recursive === true, at: log.length, offset: 0, listing: true, limit });
        },
      },
      {
        method: "POST",
        path: "/2/files/list_folder/continue",
        documentedAt: DOCS,
        respond(request) {
          const no = denied(request, true);
          if (no) return no;
          const body = parse(request.body) as Record<string, unknown> | undefined;
          if (!body || typeof body !== "object" || Object.keys(body).some((k) => k !== "cursor")) return error(400, "bad_request");
          const c = decode(body.cursor);
          if (!c) return error(409, "path/malformed_cursor");
          if (c.g !== generation) return error(409, "reset");
          return listPage(c);
        },
      },
    ],
  });

  const content = checkDocMock({
    integration: "dropbox",
    baseUrl: CONTENT,
    source: { url: DOCS, title: "Dropbox HTTP API documentation", retrievedOn: "2026-11-09", version: "v2" },
    auth: "bearer",
    assumptions: ["Download takes the file's id or path in Dropbox-API-Arg, with non-ASCII characters escaped, and answers its metadata in Dropbox-API-Result"],
    routes: [
      {
        method: "POST",
        path: "/2/files/download",
        documentedAt: DOCS,
        respond(request) {
          const no = denied(request, false);
          if (no) return no;
          const raw = request.headers.get("dropbox-api-arg") ?? "";
          if (/[^\x20-\x7e]/.test(raw)) return error(400, "bad_request");
          const arg = parse(raw) as { path?: unknown } | undefined;
          if (typeof arg?.path !== "string" || request.body !== "") return error(400, "bad_request");
          const item = arg.path.startsWith("id:") ? [...items.values()].find((i) => i.id === arg.path) : items.get(arg.path.toLowerCase());
          if (!item) return error(409, "path/not_found");
          if (item.folder) return error(409, "path/not_file");
          if (!item.downloadable) return error(409, "unsupported_file");
          return { status: 200, text: item.content, headers: { "content-type": "application/octet-stream", "Dropbox-API-Result": JSON.stringify(metadata(item)).replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`) } };
        },
      },
    ],
  });

  const apiFetch = docMockFetch(api);
  const contentFetch = docMockFetch(content);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      // Routed by exact origin, so a look-alike host goes to the API mock and is refused there.
      const toContent = new URL(input instanceof Request ? input.url : String(input)).origin === CONTENT;
      const response = await (toContent ? contentFetch : apiFetch)(input, init);
      calls.push(...(toContent ? contentFetch.calls : apiFetch.calls).slice(-1));
      return response;
    },
    { calls },
  );

  return {
    api,
    content,
    fetch,
    put,
    remove,
    resetCursors: () => void generation++,
    revokeTokens: () => tokens.clear(),
    get signIns() {
      return signIns;
    },
  };
}

export default {
  integration: "dropbox",
  covers: "Dropbox's token refresh, current account, folder listing and change feed, and download endpoints (API v2)",
  watchPages: [DOCS, OAUTH],
  docMocks: () => {
    const mock = dropboxDocMock({ appKey: "", appSecret: "", refreshToken: "", accountId: "", appScopes: [], files: [] });
    return [mock.api, mock.content];
  },
} satisfies DocMockModule;
