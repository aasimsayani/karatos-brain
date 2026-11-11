/**
 * A small client for Gorgias's REST API: one helpdesk account's tickets and
 * their messages. It signs in as a Gorgias app the store connected with
 * read-only scopes, using the refresh token from that connection, and
 * sends only these requests to the account's own address,
 * `https://{domain}.gorgias.com`:
 *
 * - `POST /oauth/token`, with the refresh token grant;
 * - `GET /api/tickets`, most recently updated first;
 * - `GET /api/messages`, for one ticket.
 *
 * The token answer lists the app's scopes; the client stops if any isn't a
 * read one, so an app that could reply, tag or change a ticket is never
 * used. Gorgias's API keys carry their user's full permissions and the
 * read-only Observer role can't make one, which is why the client uses an
 * app. Every request is built here from checked values and Gorgias's page
 * cursor, never from a link in an answer.
 */

/** The scopes a token may carry: sign-in ones and ones that only read. */
export const GORGIAS_READ_SCOPES = ["openid", "email", "profile", "offline", "tickets:read", "customers:read", "tags:read", "satisfaction_survey:read", "account:read", "users:read"] as const;
/** Tickets or messages asked for at a time: Gorgias's largest page. */
export const GORGIAS_PAGE_SIZE = 100;
const TOKEN_MARGIN_MS = 5 * 60_000;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 503, 504]);
const ACCESS_TOKEN = /^[\x21-\x7e]{1,4096}$/;
/** Gorgias's page cursor, as it writes them. */
export const GORGIAS_CURSOR = /^[A-Za-z0-9_.~=+/-]{1,2048}$/;

export interface GorgiasClientOptions {
  /** The account's subdomain (GORGIAS_DOMAIN): `store` for store.gorgias.com. */
  domain: string;
  /** The app's client id (GORGIAS_CLIENT_ID). */
  clientId: string;
  /** The app's client secret (GORGIAS_CLIENT_SECRET). Sent to Gorgias only. */
  clientSecret: string;
  /** The refresh token from connecting the app (GORGIAS_REFRESH_TOKEN). Sent to Gorgias only. */
  refreshToken: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429, 503 or 504 is retried here before the error goes to runSync. */
  retries?: number;
  now?: () => Date;
}

export class GorgiasConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GorgiasConfigError";
  }
}

/** Gorgias answered with an error. */
export class GorgiasApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GorgiasApiError";
  }
}

export interface GorgiasPage {
  rows: unknown[];
  /** The cursor of the next page, or null when this was the last. */
  next: string | null;
}

export interface GorgiasClient {
  /** One page of the account's tickets, most recently updated first. */
  tickets(cursor: string | null): Promise<GorgiasPage>;
  /** One page of a ticket's messages, oldest first. */
  messages(ticketId: number, cursor: string | null): Promise<GorgiasPage>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function gorgiasClient(options: GorgiasClientOptions): GorgiasClient {
  const domain = options.domain?.trim().toLowerCase() ?? "";
  const clientId = options.clientId?.trim() ?? "";
  const secret = options.clientSecret?.trim() ?? "";
  const refreshToken = options.refreshToken?.trim() ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) throw new GorgiasConfigError("GORGIAS_DOMAIN must be the account's subdomain, such as store for store.gorgias.com");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId)) throw new GorgiasConfigError("GORGIAS_CLIENT_ID is missing or not in the expected shape");
  if (!/^[\x21-\x7e]{16,256}$/.test(secret)) throw new GorgiasConfigError("GORGIAS_CLIENT_SECRET is missing or not in the expected shape");
  if (!/^[\x21-\x7e]{16,4096}$/.test(refreshToken)) throw new GorgiasConfigError("GORGIAS_REFRESH_TOKEN is missing or not in the expected shape");
  const base = `https://${domain}.gorgias.com`;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = options.retries ?? 3;
  const now = options.now ?? (() => new Date());
  let token: { value: string; until: number } | null = null;

  async function signIn(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
    const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
    const response = await doFetch(`${base}/oauth/token`, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
    const reply: unknown = await response.json().catch(() => undefined);
    if (response.status === 400 || response.status === 401) throw new GorgiasConfigError("Gorgias turned down the sign-in: check GORGIAS_CLIENT_ID, GORGIAS_CLIENT_SECRET and GORGIAS_REFRESH_TOKEN, and that the app is still active in the helpdesk");
    if (response.status !== 200) throw new GorgiasApiError(`Gorgias answered HTTP ${response.status} to the sign-in`, response.status);
    if (!isObject(reply) || typeof reply.access_token !== "string" || !ACCESS_TOKEN.test(reply.access_token)) throw new GorgiasApiError("Gorgias's sign-in had no access token in the expected shape", 200);
    // A token for an app that can do more than read is never used.
    if (typeof reply.scope !== "string") throw new GorgiasApiError("Gorgias's sign-in didn't say which scopes the app has, so KaratOS can't tell that it only reads", 200);
    const extra = reply.scope.split(" ").filter((s) => s && !(GORGIAS_READ_SCOPES as readonly string[]).includes(s));
    if (extra.length > 0) throw new GorgiasConfigError(`the app has ${extra.slice(0, 5).join(", ")}; KaratOS only reads, so connect an app with tickets:read and nothing else that writes`);
    const seconds = Number.isFinite(reply.expires_in) ? (reply.expires_in as number) : 0;
    token = { value: reply.access_token, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return token.value;
  }

  async function page(path: string, query: Record<string, string>, cursor: string | null): Promise<GorgiasPage> {
    if (cursor !== null && !GORGIAS_CURSOR.test(cursor)) throw new GorgiasApiError("Gorgias's page cursor isn't in the expected shape", 0);
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url.toString(), { method: "GET", headers: { Authorization: `Bearer ${await signIn()}`, Accept: "application/json" } });
      const { status } = response;
      if (status === 401 && !refreshed) {
        refreshed = true;
        token = null;
        attempt--;
        continue;
      }
      if (RETRIED.has(status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(after > 0 ? 1000 * Math.min(after, MAX_WAIT_S) : 1000 * 2 ** attempt);
        continue;
      }
      if (status === 401) throw new GorgiasApiError("Gorgias turned down the app's token twice", 401);
      if (status === 403) throw new GorgiasConfigError("the app isn't allowed to read the helpdesk's tickets: connect it with tickets:read");
      if (status === 404) throw new GorgiasConfigError("Gorgias has no account at GORGIAS_DOMAIN, or the ticket is gone");
      if (status !== 200) throw new GorgiasApiError(`Gorgias answered HTTP ${status} for ${path}`, status);
      const body: unknown = await response.json().catch(() => undefined);
      if (!isObject(body) || !Array.isArray(body.data) || !isObject(body.meta)) throw new GorgiasApiError(`Gorgias answered ${path} without a list of data and its meta`, 200);
      const next = body.meta.next_cursor;
      if (next !== null && next !== undefined && (typeof next !== "string" || !GORGIAS_CURSOR.test(next))) throw new GorgiasApiError("Gorgias's next page cursor isn't in the expected shape", 200);
      return { rows: body.data, next: next ?? null };
    }
  }

  return {
    tickets: (cursor) => page("/api/tickets", { order_by: "updated_datetime:desc", limit: String(GORGIAS_PAGE_SIZE) }, cursor),
    messages(ticketId, cursor) {
      if (!Number.isSafeInteger(ticketId) || ticketId < 1) return Promise.reject(new GorgiasApiError("a ticket id must be a positive whole number", 0));
      return page("/api/messages", { ticket_id: String(ticketId), order_by: "created_datetime:asc", limit: String(GORGIAS_PAGE_SIZE) }, cursor);
    },
  };
}
