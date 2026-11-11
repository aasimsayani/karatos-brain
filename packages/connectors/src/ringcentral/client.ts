/**
 * A small client for RingCentral's REST API (v1.0): one extension's call log
 * and message store (texts and voicemail). It signs in with a JWT credential
 * made by the extension's user, under an app given only read permissions,
 * and sends only these requests:
 *
 * - `POST https://platform.ringcentral.com/restapi/oauth/token`, with the
 *   JWT bearer grant;
 * - `GET /restapi/v1.0/account/~/extension/~/call-log`;
 * - `GET /restapi/v1.0/account/~/extension/~/message-store`, for texts and
 *   voicemail only.
 *
 * The token answer says which permissions the app holds; the client stops
 * if any isn't one of the read permissions below, so an app that could
 * send texts, place calls or change anything is never used. Every request
 * goes to RingCentral's fixed address with parameters the client builds
 * itself from checked values and a page number, never from a link in an
 * answer.
 */

export const RINGCENTRAL_SERVER = "https://platform.ringcentral.com";
/** The permissions a token may carry: ones that only read. */
export const RINGCENTRAL_READ_SCOPES = ["ReadCallLog", "ReadMessages", "ReadAccounts", "ReadContacts", "ReadPresence"] as const;
/** Records asked for at a time. */
export const RINGCENTRAL_PAGE_SIZE = 250;
/** Pages read of one span before giving up: far more than two years of a store's calls. */
const MAX_PAGE = 1000;
const TOKEN_MARGIN_MS = 5 * 60_000;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 503, 504]);
const ACCESS_TOKEN = /^[\x21-\x7e]{1,4096}$/;
/** A UTC time as the client sends it. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface RingCentralClientOptions {
  /** The app's client id (RINGCENTRAL_CLIENT_ID). */
  clientId: string;
  /** The app's client secret (RINGCENTRAL_CLIENT_SECRET). Sent to RingCentral only. */
  clientSecret: string;
  /** The user's JWT credential (RINGCENTRAL_JWT). Sent to RingCentral only. */
  jwt: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429, 503 or 504 is retried here before the error goes to runSync. */
  retries?: number;
  now?: () => Date;
}

export class RingCentralConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RingCentralConfigError";
  }
}

/** RingCentral answered with an error. `code` is its error code (such as CMN-102), when it gave one that reads. */
export class RingCentralApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RingCentralApiError";
  }
}

export type RingCentralKind = "calls" | "messages";

export interface RingCentralPageQuery {
  /** From this time, to `until`. */
  from: string;
  until: string;
  /** The page, from 1. */
  page: number;
}

export interface RingCentralPage {
  rows: unknown[];
  /** The next page, or null when this was the last. */
  next: number | null;
}

export interface RingCentralClient {
  /** One page of the extension's calls, or its texts and voicemail, in a span, newest first. */
  page(kind: RingCentralKind, query: RingCentralPageQuery): Promise<RingCentralPage>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** RingCentral's error code from its answer, when it is one that reads, such as CMN-102 or OAU-251. */
export function ringCentralErrorCode(body: unknown): string | undefined {
  const r = (body ?? {}) as { errorCode?: unknown; errors?: { errorCode?: unknown }[]; error?: unknown };
  const code = r.errorCode ?? (Array.isArray(r.errors) ? r.errors[0]?.errorCode : undefined) ?? r.error;
  return typeof code === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : undefined;
}

export function ringCentralClient(options: RingCentralClientOptions): RingCentralClient {
  const clientId = options.clientId?.trim() ?? "";
  const secret = options.clientSecret?.trim() ?? "";
  const jwt = options.jwt?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) throw new RingCentralConfigError("RINGCENTRAL_CLIENT_ID is missing or not in the expected shape");
  if (!/^[\x21-\x7e]{16,256}$/.test(secret)) throw new RingCentralConfigError("RINGCENTRAL_CLIENT_SECRET is missing or not in the expected shape");
  if (!/^[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,2048}$/.test(jwt)) throw new RingCentralConfigError("RINGCENTRAL_JWT is missing or not a JWT credential");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = options.retries ?? 3;
  const now = options.now ?? (() => new Date());
  let token: { value: string; until: number } | null = null;

  async function signIn(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt });
    const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
    const response = await doFetch(`${RINGCENTRAL_SERVER}/restapi/oauth/token`, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
    const reply: unknown = await response.json().catch(() => undefined);
    if (response.status !== 200) {
      const code = ringCentralErrorCode(reply);
      if (response.status === 400 || response.status === 401) throw new RingCentralConfigError(`RingCentral turned down the sign-in${code ? ` (${code})` : ""}: check RINGCENTRAL_CLIENT_ID, RINGCENTRAL_CLIENT_SECRET and RINGCENTRAL_JWT, and that the app allows the JWT auth flow`);
      throw new RingCentralApiError(`RingCentral answered HTTP ${response.status} to the sign-in`, response.status, code);
    }
    const r = (reply ?? {}) as { access_token?: unknown; scope?: unknown; expires_in?: unknown };
    if (typeof r.access_token !== "string" || !ACCESS_TOKEN.test(r.access_token)) throw new RingCentralApiError("RingCentral's sign-in had no access token in the expected shape", 200);
    // A token for an app that can do more than read is never used.
    if (typeof r.scope !== "string") throw new RingCentralApiError("RingCentral's sign-in didn't say which permissions the app has, so KaratOS can't tell that it only reads", 200);
    const extra = r.scope.split(" ").filter(Boolean).filter((s) => !(RINGCENTRAL_READ_SCOPES as readonly string[]).includes(s));
    if (extra.length > 0) throw new RingCentralConfigError(`the app has ${extra.slice(0, 5).join(", ")}; KaratOS only reads, so give the app ReadCallLog and ReadMessages and nothing else`);
    const seconds = typeof r.expires_in === "number" ? r.expires_in : 0;
    token = { value: r.access_token, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return token.value;
  }

  async function get(url: URL, what: string): Promise<Record<string, unknown>> {
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
      const body: unknown = await response.json().catch(() => undefined);
      const code = ringCentralErrorCode(body);
      if (status === 401) throw new RingCentralApiError("RingCentral turned down the app's token twice", 401, code);
      if (status === 403) throw new RingCentralConfigError(`the app isn't allowed to read the extension's ${what}: give it ${what === "calls" ? "ReadCallLog" : "ReadMessages"}`);
      if (status !== 200) throw new RingCentralApiError(`RingCentral answered HTTP ${status} for the extension's ${what}`, status, code);
      if (!isObject(body)) throw new RingCentralApiError(`RingCentral answered the extension's ${what} with a body that isn't a JSON object`, 200);
      return body;
    }
  }

  return {
    async page(kind, query) {
      if (!ISO.test(query.from) || !ISO.test(query.until) || query.from >= query.until) throw new RingCentralApiError(`${kind} must be listed between two UTC times`, 0);
      if (!Number.isInteger(query.page) || query.page < 1 || query.page > MAX_PAGE) throw new RingCentralApiError(`${kind} page is out of range`, 0);
      const url = new URL(`/restapi/v1.0/account/~/extension/~/${kind === "calls" ? "call-log" : "message-store"}`, RINGCENTRAL_SERVER);
      url.searchParams.set("dateFrom", query.from);
      url.searchParams.set("dateTo", query.until);
      url.searchParams.set("perPage", String(RINGCENTRAL_PAGE_SIZE));
      url.searchParams.set("page", String(query.page));
      if (kind === "calls") url.searchParams.set("view", "Simple");
      else for (const type of ["SMS", "VoiceMail"]) url.searchParams.append("messageType", type);
      const body = await get(url, kind);
      if (!Array.isArray(body.records)) throw new RingCentralApiError(`RingCentral answered the extension's ${kind} without the records list`, 200);
      // The guides show a navigation link to the next page and a page count; either says there is more.
      const total = (body.paging as { totalPages?: unknown } | null | undefined)?.totalPages;
      const more = isObject(body.navigation) && isObject(body.navigation.nextPage) || (Number.isSafeInteger(total) && query.page < (total as number));
      return { rows: body.records, next: more ? query.page + 1 : null };
    },
  };
}
