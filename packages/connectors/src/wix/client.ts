/**
 * A small client for the Wix REST APIs (`https://www.wixapis.com`), signed in
 * as a self-managed Wix app installed on the client's site. Read-only by
 * construction:
 *
 * - Many Wix reads are POSTs (`.../query`, `.../search`), so the method is no
 *   guide. The client sends only the exact method and path pairs in
 *   WIX_ROUTES, each with its own body keys, and stops anything else before a
 *   request is made.
 * - Before the first read it asks Wix which permissions the site owner
 *   granted the app (Get App Instance, `instance.permissions`) and stops if
 *   any is a manage or write permission, or anything it can't recognise as a
 *   read. The one exception is Manage Your App, which Wix requires for that
 *   very call and which reaches only the app's own install, never the site's
 *   data.
 *
 * Why an app and not an API key: an API key's permissions are picked when it
 * is made, and Wix documents no way to read them back, so a key with Manage
 * permissions couldn't be caught. An app's granted permissions can be read,
 * and only an app receives webhooks. The app's token comes from the client
 * credentials grant (app ID, app secret and the site's instance ID), lasts
 * four hours and is renewed five minutes early or when Wix answers 401.
 *
 * Every request goes to www.wixapis.com, redirects are never followed, and
 * the token travels in the Authorization header only. Wix allows about 200
 * requests a minute per app instance; on 429 the client waits with
 * exponential backoff and a little jitter (or Retry-After, up to a minute),
 * then hands the error to runSync, which retries from its checkpoint.
 */

export const WIX_API = "https://www.wixapis.com";
const WIX_ORIGIN = new URL(WIX_API).origin;

/** The only requests the client sends, with the top-level body keys each may carry. */
export const WIX_ROUTES = {
  appInstance: { method: "GET", path: "/apps/v1/instance", body: [] },
  catalogVersion: { method: "GET", path: "/stores/v3/provision/version", body: [] },
  orders: { method: "POST", path: "/ecom/v1/orders/search", body: ["search"] },
  productsV3: { method: "POST", path: "/stores/v3/products/query", body: ["query", "fields"] },
  variantsV3: { method: "POST", path: "/stores/v3/products/query-variants", body: ["query", "fields"] },
  inventoryV3: { method: "POST", path: "/stores/v3/inventory-items/query", body: ["query"] },
  productsV1: { method: "POST", path: "/stores/v1/products/query", body: ["query", "includeVariants"] },
  contacts: { method: "POST", path: "/contacts/v5/contacts/query", body: ["query"] },
} as const satisfies Record<string, { method: "GET" | "POST"; path: string; body: readonly string[] }>;
export type WixRoute = keyof typeof WIX_ROUTES;

/** Keys a query (or search) object may hold. Catalog V1 pages by offset; the rest by cursor. */
const QUERY_KEYS: Record<string, readonly string[]> = {
  search: ["filter", "sort", "cursorPaging"],
  query: ["filter", "sort", "cursorPaging"],
  queryV1: ["filter", "sort", "paging"],
};

export const WIX_TOKEN_PATH = "/oauth2/token";
export const WIX_MANAGE_YOUR_APP = "SCOPE.DC.MANAGE-YOUR-APP";

export interface WixClientOptions {
  /** The app's ID, from the OAuth page of its dashboard. */
  appId: string;
  /** The app's secret. Used only to request tokens. */
  appSecret: string;
  /** The app's instance ID on the client's site. */
  instanceId: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** 0 to 1, for backoff jitter; replaced in tests. */
  random?: () => number;
  /** Milliseconds since the epoch; replaced in tests to expire tokens. */
  clock?: () => number;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class WixConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WixConfigError";
  }
}

/** Wix answered with an error. `code` is Wix's application error code when it gives a readable one. */
export class WixApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "WixApiError";
    this.status = status;
    this.code = code;
  }
}

export interface WixClient {
  /** The app instance the client reads, which keys its customer references. */
  readonly instanceId: string;
  /** Sends one allowlisted request and returns Wix's JSON object. */
  read(route: WixRoute, body?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The permissions the site owner granted, checked: throws on any manage or write permission. */
  checkPermissions(): Promise<string[]>;
}

/** Wix's app, instance and token identifiers are GUIDs. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RENEW_EARLY_MS = 5 * 60_000;
const DEFAULT_TOKEN_SECONDS = 4 * 3600;
const MAX_RETRY_AFTER_S = 60;
const BACKOFF_MS = 1000;
const MAX_PERMISSION = 100;
/** Words in a permission ID that mean it can change something. */
const WRITE_WORDS = /MANAGE|WRITE|EDIT|CREATE|DELETE|UPDATE|MODIFY|REMOVE|SEND|CHARGE|REFUND/;
const PERMISSION = /^[A-Z0-9._-]{1,100}$/;

/**
 * Whether a granted permission is one the connector may hold: a read, or
 * Manage Your App, which Get App Instance needs and which only reaches the
 * app's own install. Anything unreadable counts as a write.
 */
export function isWixReadPermission(permission: unknown): boolean {
  if (typeof permission !== "string" || permission.length > MAX_PERMISSION) return false;
  const p = permission.trim().toUpperCase();
  if (p === WIX_MANAGE_YOUR_APP) return true;
  if (!PERMISSION.test(p)) return false;
  return p.includes("READ") && !WRITE_WORDS.test(p);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wix's error code and message, cut short. Wix's errors describe the request, never the token. */
function errorOf(body: unknown): { code: string | undefined; message: string | undefined } {
  const b = body as { message?: unknown; details?: { applicationError?: { code?: unknown } } } | null;
  const raw = b?.details?.applicationError?.code;
  const code = typeof raw === "string" && raw.length <= 80 && /^[A-Za-z0-9_]+$/.test(raw) ? raw : undefined;
  const message = typeof b?.message === "string" ? b.message.slice(0, 200) : undefined;
  return { code, message };
}

function hint(status: number): string {
  if (status === 401) return "; check WIX_APP_ID, WIX_APP_SECRET and WIX_INSTANCE_ID, and that the app is still installed on the site";
  if (status === 403) return "; the app lacks a read permission it needs: add it in the app's Permissions page and have the site owner accept it";
  if (status === 404) return "; the endpoint isn't there for this site: check the Wix app (Stores, eCommerce) is installed";
  return "";
}

export function wixClient(options: WixClientOptions): WixClient {
  const appId = options.appId?.trim().slice(0, 100) ?? "";
  const appSecret = options.appSecret?.trim().slice(0, 200) ?? "";
  const instanceId = options.instanceId?.trim().slice(0, 100) ?? "";
  if (!GUID.test(appId)) throw new WixConfigError("WIX_APP_ID must be the app's ID, a GUID from the OAuth page of the app's dashboard");
  if (appSecret.length < 16 || /\s/.test(appSecret)) throw new WixConfigError("WIX_APP_SECRET must be the app's secret key from the OAuth page of the app's dashboard");
  if (!GUID.test(instanceId)) throw new WixConfigError("WIX_INSTANCE_ID must be the app's instance ID on the site, a GUID");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const clock = options.clock ?? (() => Date.now());
  const retries = options.rateLimitRetries ?? 3;
  let granted: { token: string; expiresAt: number } | null = null;
  let checked: Promise<string[]> | null = null;

  /** Sends one request to www.wixapis.com, retrying 429 here. Never follows a redirect. */
  async function send(method: string, path: string, headers: Record<string, string>, body: string | undefined): Promise<Response> {
    const url = `${WIX_API}${path}`;
    // Pinned: the request goes to Wix's API host and nowhere else.
    if (new URL(url).origin !== WIX_ORIGIN) throw new WixConfigError("the Wix connector only talks to www.wixapis.com");
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, { method, headers: { accept: "application/json", ...headers }, ...(body === undefined ? {} : { body }), redirect: "manual" });
      if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
        throw new WixApiError("Wix answered with a redirect, which the connector never follows", response.status, "redirect");
      }
      if (response.status !== 429) return response;
      if (attempt >= retries) throw new WixApiError("Wix kept rate-limiting the sync; the next run resumes from the checkpoint", 429, "rate_limited");
      const after = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : BACKOFF_MS * 2 ** attempt + Math.floor(random() * BACKOFF_MS));
    }
  }

  /** The client credentials grant. The token lasts four hours; it is renewed five minutes early. */
  async function token(): Promise<string> {
    if (granted && granted.expiresAt - TOKEN_RENEW_EARLY_MS > clock()) return granted.token;
    const response = await send("POST", WIX_TOKEN_PATH, { "content-type": "application/json" }, JSON.stringify({ grant_type: "client_credentials", client_id: appId, client_secret: appSecret, instance_id: instanceId }));
    const body = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
    const access = typeof body?.access_token === "string" && body.access_token.length >= 16 && body.access_token.length <= 8192 && !/\s/.test(body.access_token) ? body.access_token : undefined;
    if (!response.ok || !access) {
      const code = typeof body?.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : undefined;
      throw new WixApiError(`Wix refused the app's token request (HTTP ${response.status}${code ? `, ${code}` : ""})${hint(response.status === 400 ? 401 : response.status)}`, response.status, code);
    }
    const seconds = typeof body!.expires_in === "number" && body!.expires_in > 0 && body!.expires_in <= 86_400 ? body!.expires_in : DEFAULT_TOKEN_SECONDS;
    granted = { token: access, expiresAt: clock() + seconds * 1000 };
    return access;
  }

  /** One allowlisted call, renewing the token once if Wix answers 401. */
  async function call(route: WixRoute, body: Record<string, unknown> | undefined, renewed = false): Promise<Record<string, unknown>> {
    const spec = WIX_ROUTES[route];
    const headers: Record<string, string> = { authorization: await token() };
    let payload: string | undefined;
    if (spec.method === "POST") {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body ?? {});
    }
    const response = await send(spec.method, spec.path, headers, payload);
    if (response.status === 401 && !renewed) {
      // A token can be revoked before it expires (the app was reinstalled, say); ask for a new one once.
      granted = null;
      return call(route, body, true);
    }
    if (!response.ok) {
      const { code, message } = errorOf(await response.json().catch(() => null));
      throw new WixApiError(`Wix answered HTTP ${response.status} to ${spec.path}${code ? ` (${code}${message ? `: ${message}` : ""})` : ""}${hint(response.status)}`, response.status, code);
    }
    const json: unknown = await response.json().catch(() => null);
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new WixApiError(`Wix did not answer ${spec.path} with an object`, response.status);
    return json as Record<string, unknown>;
  }

  /** Stops before a request is made unless the route and every body key are on the list. */
  function allowed(route: WixRoute, body: Record<string, unknown> | undefined): void {
    const spec = Object.hasOwn(WIX_ROUTES, route) ? WIX_ROUTES[route] : undefined;
    if (!spec) throw new WixConfigError("the Wix connector only sends its listed read requests");
    if (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body))) throw new WixConfigError(`${spec.path} takes a JSON object`);
    const keys = Object.keys(body ?? {});
    const allowedKeys: readonly string[] = spec.body;
    const unknown = keys.filter((k) => !allowedKeys.includes(k));
    if (unknown.length) throw new WixConfigError(`the Wix connector doesn't send ${unknown.slice(0, 3).join(", ")} to ${spec.path}`);
    for (const key of ["search", "query"] as const) {
      const value = body?.[key];
      if (value === undefined) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new WixConfigError(`${key} must be an object`);
      const inner: readonly string[] = route === "productsV1" ? QUERY_KEYS.queryV1! : QUERY_KEYS[key]!;
      const extra = Object.keys(value).filter((k) => !inner.includes(k));
      if (extra.length) throw new WixConfigError(`the Wix connector doesn't send ${key}.${extra.slice(0, 3).join(", ")} to ${spec.path}`);
    }
    const fields = body?.fields;
    if (fields !== undefined && (!Array.isArray(fields) || fields.length > 0)) throw new WixConfigError("the Wix connector asks for no extra fields");
    if (body?.includeVariants !== undefined && body.includeVariants !== true) throw new WixConfigError("includeVariants must be true");
  }

  async function checkPermissions(): Promise<string[]> {
    checked ??= (async () => {
      const body = await call("appInstance", undefined);
      const instance = body.instance as { instanceId?: unknown; permissions?: unknown } | undefined;
      if (typeof instance?.instanceId === "string" && instance.instanceId.toLowerCase() !== instanceId.toLowerCase()) {
        throw new WixConfigError("Wix gave a token for a different app instance than WIX_INSTANCE_ID; check the setting");
      }
      const permissions = instance?.permissions;
      if (!Array.isArray(permissions)) throw new WixConfigError("Wix didn't say which permissions the app holds, so the connector stops rather than risk a write permission");
      const writes = permissions.filter((p) => !isWixReadPermission(p));
      if (writes.length) {
        const named = writes.slice(0, 3).map((p) => (typeof p === "string" && PERMISSION.test(p.trim().toUpperCase()) ? p.trim() : "an unreadable permission"));
        throw new WixConfigError(`the Wix app holds ${named.join(", ")}${writes.length > 3 ? " and more" : ""}; KaratOS reads only, so remove every Manage or write permission from the app's Permissions page and have the site owner accept the change`);
      }
      return permissions.map((p) => String(p).trim());
    })().catch((error: unknown) => {
      checked = null;
      throw error;
    });
    return checked;
  }

  return {
    instanceId: instanceId.toLowerCase(),
    checkPermissions,
    async read(route, body) {
      allowed(route, body);
      await checkPermissions();
      return call(route, body);
    },
  };
}
