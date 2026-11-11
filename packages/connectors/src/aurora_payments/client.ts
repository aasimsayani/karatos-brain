/**
 * A small client for Aurora Payments' API, read-only. Aurora renamed itself
 * Flute in 2026, and its API lives at api.flute.com. A request is signed in
 * with a short-lived token from Flute's OAuth server, made from an API key
 * (a client ID and secret) with the client credentials grant.
 *
 * A merchant's own API key can reach every endpoint, writes included; only
 * a key made under a partner whose permissions allow just the reads is
 * limited. So the client keeps to the reads itself: it sends one POST, for
 * a token, to the OAuth server, and otherwise only GET requests to the
 * settlement batches and transactions lists, on the one environment the
 * settings name.
 *
 * Flute's own error text is never put in an error here, only the HTTP
 * status. A 429 and 500, 502, 503 and 504 are waited out a few times,
 * honoring Retry-After, before the error goes to runSync, which keeps the
 * checkpoint.
 */

export type AuroraEnvironment = "production" | "sandbox";
export const AURORA_HOSTS: Readonly<Record<AuroraEnvironment, { api: string; oauth: string }>> = {
  production: { api: "https://api.flute.com", oauth: "https://oauth.api.flute.com" },
  sandbox: { api: "https://sandbox.api.flute.com", oauth: "https://sandbox.oauth.api.flute.com" },
};
/** Records on a page. */
export const AURORA_PAGE_SIZE = 50;
const MAX_RETRY_AFTER_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
/** Signed in again this long before the token runs out. */
const TOKEN_MARGIN_MS = 60_000;
const CLIENT_ID = /^[A-Za-z0-9._~-]{8,256}$/;
const CLIENT_SECRET = /^[\x21-\x7e]{16,512}$/;
const ACCESS_TOKEN = /^[A-Za-z0-9._~+/=-]{16,8192}$/;
/** A UTC time as toISOString writes it. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A batch's ID, as Flute writes it. */
const BATCH_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface AuroraClientOptions {
  /** The API key's client ID. */
  clientId: string;
  /** The API key's client secret. Sent to Flute's OAuth server only, and never logged or shown. */
  clientSecret: string;
  /** Production unless given. */
  environment?: AuroraEnvironment | undefined;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock a token's lifetime is counted on; replaced in tests. */
  now?: () => Date;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class AuroraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuroraConfigError";
  }
}

export class AuroraApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuroraApiError";
  }
}

export interface AuroraPage {
  items: unknown[];
  /** A later page may hold more. */
  more: boolean;
}

export interface AuroraClient {
  readonly baseUrl: string;
  /** Settlement batches dated from `from` to `to`, oldest first; pages count from 0. */
  batches(range: { from: string; to: string }, page: number): Promise<AuroraPage>;
  /** The transactions in one settlement batch; pages count from 0. */
  transactions(batchId: string, page: number): Promise<AuroraPage>;
}

export function auroraClient(options: AuroraClientOptions): AuroraClient {
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!CLIENT_ID.test(clientId)) throw new AuroraConfigError("AURORA_CLIENT_ID is missing or not in the expected shape");
  if (!CLIENT_SECRET.test(clientSecret)) throw new AuroraConfigError("AURORA_CLIENT_SECRET is missing or not in the expected shape");
  const environment = options.environment ?? "production";
  if (!Object.hasOwn(AURORA_HOSTS, environment)) throw new AuroraConfigError("AURORA_ENVIRONMENT must be production or sandbox");
  const hosts = AURORA_HOSTS[environment];
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const retries = options.retries ?? 3;
  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  let token: { value: string; until: number } | null = null;

  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, init);
      if (!RETRIED.has(response.status) || attempt >= retries) return response;
      const after = Number(response.headers.get("retry-after"));
      await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : 1000 * 2 ** attempt);
    }
  }

  async function signIn(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const response = await send(`${hosts.oauth}/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: "grant_type=client_credentials&scope=offline_access",
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) throw new AuroraConfigError(`Flute turned down AURORA_CLIENT_ID and AURORA_CLIENT_SECRET (HTTP ${response.status}); check the key is for ${environment}`);
    if (response.status !== 200) throw new AuroraApiError(`Flute sign-in answered HTTP ${response.status}`, response.status);
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const value = body?.access_token;
    if (typeof value !== "string" || !ACCESS_TOKEN.test(value)) throw new AuroraApiError("Flute sign-in answered without an access token", 200);
    // expires_in is seconds; anything else, or more than a day, counts as already run out.
    const seconds = Number.isSafeInteger(body!.expires_in) && (body!.expires_in as number) > 0 && (body!.expires_in as number) <= 86_400 ? (body!.expires_in as number) : 0;
    token = { value, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return value;
  }

  async function list(path: string, query: Record<string, string>, what: string, page: number): Promise<AuroraPage> {
    if (!Number.isSafeInteger(page) || page < 0) throw new AuroraApiError("page must be a whole number, 0 or more", 0);
    const url = `${hosts.api}${path}?${new URLSearchParams({ ...query, page: String(page), pageSize: String(AURORA_PAGE_SIZE) })}`;
    for (let signIns = 0; ; signIns++) {
      const bearer = await signIn();
      const response = await send(url, { method: "GET", headers: { authorization: `Bearer ${bearer}`, accept: "application/json" } });
      // A token can run out early; sign in again once.
      if (response.status === 401 && signIns === 0) {
        token = null;
        continue;
      }
      const { status } = response;
      if (status === 401 || status === 403) throw new AuroraConfigError(`Flute turned down the API key for ${what} (HTTP ${status}); check it may list ${what}`);
      if (status !== 200) throw new AuroraApiError(`Flute answered HTTP ${status} for ${what}`, status);
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const items = body?.items;
      if (!Array.isArray(items)) throw new AuroraApiError(`Flute answered without a list of ${what}`, status);
      const total = body!.total;
      // With a total, that says when to stop; without one, a short page does.
      const more = Number.isSafeInteger(total) ? (page + 1) * AURORA_PAGE_SIZE < (total as number) : items.length >= AURORA_PAGE_SIZE;
      return { items, more };
    }
  }

  return {
    baseUrl: hosts.api,
    async batches(range, page) {
      if (!TIME.test(range.from) || !TIME.test(range.to) || range.from > range.to) throw new AuroraApiError("batches are listed between two UTC times", 0);
      return list("/pay-api/v1/settlements/batches", { dateFrom: range.from, dateTo: range.to, orderBy: "batchDateTime", asc: "true" }, "settlement batches", page);
    },
    async transactions(batchId, page) {
      if (!BATCH_ID.test(batchId)) throw new AuroraApiError("not a settlement batch ID", 0);
      return list("/pay-api/v1/transactions", { batchId, orderBy: "date", asc: "true" }, "transactions", page);
    },
  };
}
