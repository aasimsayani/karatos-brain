/**
 * A small client for Dropbox's API (v2): the token refresh, the signed-in
 * account, folder listings and their change feed, and, for file imports
 * only, a file's contents. It sends only these requests, to Dropbox's fixed
 * addresses:
 *
 * - `POST /oauth2/token` with the refresh token, asking for read scopes only;
 * - `POST /2/users/get_current_account`, for the account id and its root;
 * - `POST /2/files/list_folder` and `POST /2/files/list_folder/continue`;
 * - `POST /2/files/download`, only when the client is made with `contents`.
 *
 * Dropbox's RPC calls are POSTs, but all of these only read. Each token
 * refresh asks for `account_info.read` and `files.metadata.read` (and
 * `files.content.read` for file imports), so the token can do nothing else
 * whatever the app was given. If Dropbox reports a token with any other
 * scope, the client stops.
 *
 * Every call names the account's root namespace in `Dropbox-API-Path-Root`,
 * so in a team space a folder path is the one the Dropbox website shows.
 */

export const DROPBOX_API = "https://api.dropboxapi.com";
export const DROPBOX_CONTENT = "https://content.dropboxapi.com";
/** What every token is asked for: the account's id and file metadata. */
export const DROPBOX_METADATA_SCOPES = ["account_info.read", "files.metadata.read"] as const;
/** Added for file imports, which read contents. */
export const DROPBOX_CONTENT_SCOPE = "files.content.read";
/** Entries per listing page; Dropbox allows up to 2,000. */
export const DROPBOX_PAGE_SIZE = 500;
/** The largest file a file import downloads. */
export const DROPBOX_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** A new token is asked for this long before the current one ends. */
const TOKEN_MARGIN_MS = 5 * 60_000;
const MAX_RETRY_AFTER_S = 60;
/** Listing cursors grow with the folder; Dropbox gives no limit, so this is generous. */
export const DROPBOX_CURSOR = /^[A-Za-z0-9_+/=-]{1,16384}$/;
const ACCOUNT_ID = /^dbid:[A-Za-z0-9_-]{1,100}$/;
const NAMESPACE = /^\d{1,20}$/;
const TOKEN = /^[\x21-\x7e]{1,4096}$/;
const ERROR_SUMMARY = /^[a-z_]{1,60}(\/[a-z_]{1,60}){0,5}/;

export interface DropboxClientOptions {
  /** The app key (DROPBOX_APP_KEY). */
  appKey: string;
  /** The app secret (DROPBOX_APP_SECRET). Sent to Dropbox only, and never logged or shown. */
  appSecret: string;
  /** The refresh token from the store's one-time approval (DROPBOX_REFRESH_TOKEN). Sent to Dropbox only. */
  refreshToken: string;
  /** Also ask for files.content.read, so files can be downloaded. Only file imports set this. */
  contents?: boolean;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  now?: () => Date;
}

export class DropboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DropboxConfigError";
  }
}

export class DropboxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Dropbox's error_summary without its trailing detail, such as `path/not_found`, when it reads as one. */
    readonly summary?: string,
  ) {
    super(message);
    this.name = "DropboxApiError";
  }
}

/** The listing cursor expired or the folder changed so much that Dropbox wants it listed again. */
export class DropboxResetError extends DropboxApiError {
  constructor() {
    super("Dropbox asked for the folder to be listed again", 409, "reset");
    this.name = "DropboxResetError";
  }
}

export interface DropboxListPage {
  entries: Record<string, unknown>[];
  cursor: string;
  hasMore: boolean;
}

export interface DropboxAccount {
  accountId: string;
  rootNamespaceId: string;
}

export interface DropboxDownload {
  bytes: Uint8Array;
  metadata: Record<string, unknown>;
}

export interface DropboxClient {
  account(): Promise<DropboxAccount>;
  /** The first page of a folder's listing. */
  listFolder(path: string, recursive: boolean): Promise<DropboxListPage>;
  /** The next page of a listing, or the changes since its last page. Throws DropboxResetError when Dropbox wants it listed again. */
  listFolderContinue(cursor: string): Promise<DropboxListPage>;
  /** A file's contents, by path or id. Only for a client made with `contents`. */
  download(path: string): Promise<DropboxDownload>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Seconds from a Retry-After header, or undefined when it doesn't read as seconds. */
function retryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value);
}

/** A folder path as Dropbox takes it: starting with `/`, without a trailing `/`, and not the whole Dropbox. */
export function dropboxFolder(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim();
  // No control characters or backslashes, and no empty, `.` or `..` segments, which also turns down `/` and a trailing `/`.
  if (path.length > 1000 || !path.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(path)) return undefined;
  if (path.slice(1).split("/").some((s) => s === "" || s === "." || s === "..")) return undefined;
  return path;
}

/** JSON with every character outside printable ASCII escaped, as an HTTP header needs. */
export function dropboxHeaderJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function summaryOf(reply: unknown): string | undefined {
  const summary = isObject(reply) ? reply.error_summary : undefined;
  if (typeof summary !== "string") return undefined;
  return ERROR_SUMMARY.exec(summary)?.[0];
}

export function dropboxClient(options: DropboxClientOptions): DropboxClient {
  const appKey = options.appKey?.trim() ?? "";
  const appSecret = options.appSecret?.trim() ?? "";
  const refreshToken = options.refreshToken?.trim() ?? "";
  if (!/^[a-z0-9]{10,40}$/.test(appKey)) throw new DropboxConfigError("DROPBOX_APP_KEY is missing or not in the expected shape");
  if (!/^[a-z0-9]{10,40}$/.test(appSecret)) throw new DropboxConfigError("DROPBOX_APP_SECRET is missing or not in the expected shape");
  if (!/^[A-Za-z0-9_-]{20,1024}$/.test(refreshToken)) throw new DropboxConfigError("DROPBOX_REFRESH_TOKEN is missing or not in the expected shape");
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.rateLimitRetries ?? 3;
  const now = options.now ?? (() => new Date());
  const scopes: string[] = [...DROPBOX_METADATA_SCOPES, ...(options.contents ? [DROPBOX_CONTENT_SCOPE] : [])];

  let token: { value: string; until: number } | null = null;
  let account: DropboxAccount | null = null;

  async function signIn(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: appKey, client_secret: appSecret, scope: scopes.join(" ") });
    const response = await fetch(`${DROPBOX_API}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
    const reply: unknown = await response.json().catch(() => undefined);
    const error = isObject(reply) && typeof reply.error === "string" ? reply.error : undefined;
    if (error === "invalid_grant") throw new DropboxConfigError("Dropbox turned down DROPBOX_REFRESH_TOKEN: it may have been revoked, or was made for another app. Approve the app again and save the new refresh token");
    if (error === "invalid_client" || response.status === 401) throw new DropboxConfigError("Dropbox turned down DROPBOX_APP_KEY or DROPBOX_APP_SECRET");
    if (error === "invalid_scope") throw new DropboxConfigError(`the Dropbox app doesn't have ${scopes.join(", ")}: turn them on in the app's Permissions tab, then approve the app again`);
    if (response.status !== 200 || !isObject(reply)) throw new DropboxApiError(`Dropbox answered HTTP ${response.status} to the token refresh`, response.status);
    if (typeof reply.access_token !== "string" || !TOKEN.test(reply.access_token)) throw new DropboxApiError("Dropbox's token refresh had no access token in the expected shape", 200);
    // A token that can do more than asked is never used.
    if (reply.scope !== undefined) {
      const granted = typeof reply.scope === "string" ? reply.scope.split(" ").filter(Boolean) : null;
      if (!granted || granted.some((s) => !scopes.includes(s))) throw new DropboxConfigError(`Dropbox gave a token with more than ${scopes.join(", ")}; KaratOS only reads, so it stops`);
    }
    // No lifetime that reads means the token is used once.
    const seconds = Number.isFinite(reply.expires_in) ? (reply.expires_in as number) : 0;
    token = { value: reply.access_token, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return token.value;
  }

  /** One request, signed in, with one fresh sign-in on a 401 and 429s waited out. */
  async function send(url: string, init: (bearer: string) => RequestInit, what: string): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, init(await signIn()));
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        token = null;
        attempt--;
        continue;
      }
      if (response.status === 429 && attempt < retries) {
        const wait = retryAfter(response.headers.get("retry-after"));
        await sleep(1000 * (wait !== undefined ? Math.min(Math.max(wait, 1), MAX_RETRY_AFTER_S) : 2 ** attempt));
        continue;
      }
      if (response.status === 200) return response;
      const reply: unknown = await response.json().catch(() => undefined);
      const summary = summaryOf(reply);
      if (response.status === 409 && summary?.startsWith("reset")) throw new DropboxResetError();
      if (response.status === 401) throw new DropboxApiError("Dropbox turned down the token twice: check DROPBOX_REFRESH_TOKEN, which may have been revoked", 401, summary);
      if (response.status === 403) throw new DropboxApiError(`Dropbox's app isn't allowed to read ${what}`, 403, summary);
      if (response.status === 409) throw new DropboxApiError(`Dropbox couldn't read ${what}${summary ? ` (${summary})` : ""}: check DROPBOX_FOLDER, and that the folder is in the approving user's Dropbox`, 409, summary);
      throw new DropboxApiError(`Dropbox answered HTTP ${response.status} for ${what}`, response.status, summary);
    }
  }

  async function rpc(path: string, body: unknown, what: string, root: string | null): Promise<Record<string, unknown>> {
    const response = await send(
      `${DROPBOX_API}/2${path}`,
      (bearer) => ({
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json", ...(root ? { "Dropbox-API-Path-Root": dropboxHeaderJson({ ".tag": "root", root }) } : {}) },
        body: JSON.stringify(body),
      }),
      what,
    );
    const reply: unknown = await response.json().catch(() => undefined);
    if (!isObject(reply)) throw new DropboxApiError(`Dropbox answered ${what} with a body that isn't a JSON object`, 200);
    return reply;
  }

  async function me(): Promise<DropboxAccount> {
    if (account) return account;
    const reply = await rpc("/users/get_current_account", null, "the signed-in account", null);
    const root = isObject(reply.root_info) ? reply.root_info.root_namespace_id : undefined;
    if (typeof reply.account_id !== "string" || !ACCOUNT_ID.test(reply.account_id)) throw new DropboxApiError("Dropbox's account had no account id in the expected shape", 200);
    if (typeof root !== "string" || !NAMESPACE.test(root)) throw new DropboxApiError("Dropbox's account had no root namespace in the expected shape", 200);
    account = { accountId: reply.account_id, rootNamespaceId: root };
    return account;
  }

  function page(reply: Record<string, unknown>, what: string): DropboxListPage {
    if (!Array.isArray(reply.entries)) throw new DropboxApiError(`Dropbox answered ${what} without the entries list`, 200);
    if (typeof reply.cursor !== "string" || !DROPBOX_CURSOR.test(reply.cursor)) throw new DropboxApiError(`Dropbox sent a cursor for ${what} that isn't in the expected shape`, 200);
    if (typeof reply.has_more !== "boolean") throw new DropboxApiError(`Dropbox answered ${what} without has_more`, 200);
    return { entries: (reply.entries as unknown[]).filter(isObject), cursor: reply.cursor, hasMore: reply.has_more };
  }

  return {
    account: me,
    async listFolder(path, recursive) {
      const folder = dropboxFolder(path);
      if (folder === undefined) throw new DropboxConfigError("a Dropbox folder path starts with / and names a folder, not the whole Dropbox");
      const { rootNamespaceId } = await me();
      const body = { path: folder, recursive, include_deleted: false, include_mounted_folders: true, include_non_downloadable_files: true, limit: DROPBOX_PAGE_SIZE };
      return page(await rpc("/files/list_folder", body, "the folder", rootNamespaceId), "the folder");
    },
    async listFolderContinue(cursor) {
      if (!DROPBOX_CURSOR.test(cursor)) throw new DropboxApiError("the listing cursor isn't in the expected shape", 0);
      const { rootNamespaceId } = await me();
      return page(await rpc("/files/list_folder/continue", { cursor }, "the folder's changes", rootNamespaceId), "the folder's changes");
    },
    async download(path) {
      if (!options.contents) throw new DropboxConfigError("this Dropbox client reads metadata only; file imports make their own with contents");
      if (typeof path !== "string" || !(/^id:[A-Za-z0-9_-]{1,64}$/.test(path) || dropboxFolder(path) !== undefined)) throw new DropboxApiError("a download names a file by its id or its path", 0);
      const { rootNamespaceId } = await me();
      const response = await send(
        `${DROPBOX_CONTENT}/2/files/download`,
        (bearer) => ({ method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Dropbox-API-Arg": dropboxHeaderJson({ path }), "Dropbox-API-Path-Root": dropboxHeaderJson({ ".tag": "root", root: rootNamespaceId }) } }),
        "the file",
      );
      const length = Number(response.headers.get("content-length") ?? "0");
      if (length > DROPBOX_MAX_DOWNLOAD_BYTES) throw new DropboxApiError(`the file is larger than ${DROPBOX_MAX_DOWNLOAD_BYTES} bytes, so it isn't read`, 200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > DROPBOX_MAX_DOWNLOAD_BYTES) throw new DropboxApiError(`the file is larger than ${DROPBOX_MAX_DOWNLOAD_BYTES} bytes, so it isn't read`, 200);
      let metadata: unknown;
      try {
        metadata = JSON.parse(response.headers.get("dropbox-api-result") ?? "");
      } catch {
        metadata = undefined;
      }
      if (!isObject(metadata)) throw new DropboxApiError("Dropbox's download had no file metadata", 200);
      return { bytes, metadata };
    },
  };
}
