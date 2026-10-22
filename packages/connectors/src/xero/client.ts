import type { QuickBooksTokenStore } from "../quickbooks/client.js";

/**
 * A small client for the Xero Accounting API. Read-only twice over: the
 * connection is made with Xero's read-only scopes, which the client checks
 * on every new access token, and the only requests it sends to the
 * organisation are GETs of a fixed list of endpoints. Its one POST is the
 * OAuth token refresh, which goes to Xero's identity service.
 *
 * Access tokens last 30 minutes. Every refresh returns a new refresh token
 * and retires the old one, and an unused one expires after 60 days, so each
 * new refresh token is handed to the token store before it is used.
 *
 * Xero allows 60 calls a minute and 5 at once per organisation, and 1,000 or
 * 5,000 a day depending on the plan. Calls go one at a time; a minute or
 * concurrency limit is waited out, and the daily limit stops the sync so it
 * resumes from its checkpoint the next day.
 */

export const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
export const XERO_API_URL = "https://api.xero.com/api.xro/2.0";

/** Xero's largest page. */
export const XERO_PAGE_SIZE = 1000;

/**
 * The scopes to connect with: read-only granular scopes, as apps created
 * from 2 March 2026 must use, plus offline_access for a refresh token.
 */
export const XERO_READ_SCOPES = [
  "offline_access",
  "accounting.settings.read",
  "accounting.contacts.read",
  "accounting.invoices.read",
  "accounting.payments.read",
  "accounting.banktransactions.read",
  "accounting.manualjournals.read",
] as const;

/** The endpoints the client may read, and nothing else. */
export const XERO_ENDPOINTS = ["Accounts", "Contacts", "Invoices", "CreditNotes", "Payments", "BankTransactions", "ManualJournals"] as const;
export type XeroEndpoint = (typeof XERO_ENDPOINTS)[number];

/** Same shape as QuickBooks': the newest refresh token, kept encrypted by the instance. */
export type XeroTokenStore = QuickBooksTokenStore;

export interface XeroClientOptions {
  clientId: string;
  clientSecret: string;
  /** The organisation's tenant ID, from Xero's connections endpoint. */
  tenantId: string;
  tokens: XeroTokenStore;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a minute or concurrency 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Milliseconds since the epoch; replaced in tests to expire access tokens. */
  clock?: () => number;
}

export class XeroConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XeroConfigError";
  }
}

/** Xero or its identity service answered with an error. `problem` names the rate limit Xero says was hit. */
export class XeroApiError extends Error {
  readonly status: number;
  readonly problem: string | undefined;

  constructor(message: string, status: number, problem?: string) {
    super(message);
    this.name = "XeroApiError";
    this.status = status;
    this.problem = problem;
  }
}

export interface XeroGetOptions {
  /** 1-based page, for the endpoints that page. */
  page?: number;
  /** A filter the connector built from dates, never from outside text. */
  where?: string;
  order?: string;
  /** Only records changed after this ISO time. */
  modifiedSince?: string;
  includeArchived?: boolean;
}

export interface XeroClient {
  get(endpoint: XeroEndpoint, options?: XeroGetOptions): Promise<Record<string, unknown>>;
}

const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The only filters the connector sends: a date on or after a day. */
const WHERE = /^Date>=DateTime\(\d{4},\d{1,2},\d{1,2}\)$/;
const ORDER = /^UpdatedDateUTC( ASC| DESC)?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
/** Scopes that only read, or that only identify the user. */
const SAFE_SCOPE = /^(offline_access|openid|profile|email|[a-z]+(\.[a-z0-9]+)*\.read)$/;
const ACCESS_RENEW_EARLY_MS = 2 * 60_000;
const MAX_RETRY_AFTER_S = 60;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The scopes a Xero access token was granted, read from its JWT payload.
 * The token isn't verified here (Xero does that); this only lets the client
 * notice a connection made with more than read access. Null when the token
 * isn't a readable JWT.
 */
export function xeroTokenScopes(accessToken: string): string[] | null {
  const part = accessToken.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { scope?: unknown };
    if (Array.isArray(claims.scope)) return claims.scope.filter((s): s is string => typeof s === "string");
    if (typeof claims.scope === "string") return claims.scope.split(" ").filter(Boolean);
    return [];
  } catch {
    return null;
  }
}

/** Scopes beyond read-only access. Empty means the token can only read. */
export const xeroWriteScopes = (scopes: readonly string[]) => scopes.filter((s) => !SAFE_SCOPE.test(s));

/** Xero's message for an error, cut short. Error bodies describe the request, never the token. */
function messageOf(body: unknown): string {
  const b = (body ?? {}) as { Message?: unknown; Detail?: unknown; Title?: unknown; error?: unknown };
  const message = [b.Message, b.Detail, b.Title].find((m): m is string => typeof m === "string" && m.trim() !== "");
  return (message ?? "").slice(0, 200);
}

export function xeroClient(options: XeroClientOptions): XeroClient {
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!clientId || !clientSecret) throw new XeroConfigError("set XERO_CLIENT_ID and XERO_CLIENT_SECRET");
  const tenantId = options.tenantId?.trim() ?? "";
  if (!TENANT.test(tenantId)) throw new XeroConfigError("XERO_TENANT_ID must be the organisation's tenant ID, a UUID");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  const clock = options.clock ?? (() => Date.now());
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    const refreshToken = (await options.tokens.load()).trim();
    if (!refreshToken) throw new XeroConfigError("set XERO_REFRESH_TOKEN");
    const response = await doFetch(XERO_TOKEN_URL, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown };
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
      // invalid_grant: the refresh token was used already, expired after 60 days unused, or the connection was removed.
      const code = typeof body.error === "string" ? body.error.slice(0, 40) : undefined;
      const hint = code === "invalid_grant" ? "; reconnect Xero to get a new refresh token" : "";
      throw new XeroApiError(`Xero refused the token refresh (HTTP ${response.status}${code ? `, ${code}` : ""})${hint}`, response.status);
    }
    // Saved before anything else: Xero has already retired the old token, so losing this one would cut the connection.
    if (typeof body.refresh_token === "string" && body.refresh_token) await options.tokens.save(body.refresh_token);
    const scopes = xeroTokenScopes(body.access_token);
    const extra = scopes ? xeroWriteScopes(scopes) : [];
    if (extra.length) {
      throw new XeroConfigError(`the Xero connection can change data (${extra.slice(0, 5).join(", ")}); reconnect it with only ${XERO_READ_SCOPES.join(" ")}`);
    }
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 1800;
    access = { token: body.access_token, expiresAt: clock() + seconds * 1000 };
    return access.token;
  }

  async function accessToken(): Promise<string> {
    if (access && access.expiresAt - ACCESS_RENEW_EARLY_MS > clock()) return access.token;
    // One refresh at a time: a second would spend a refresh token the first already retired.
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  return {
    async get(endpoint, opts = {}) {
      if (!XERO_ENDPOINTS.includes(endpoint)) throw new XeroConfigError("the Xero connector only reads its listed endpoints");
      const query = new URLSearchParams();
      if (opts.page !== undefined) {
        if (!Number.isInteger(opts.page) || opts.page < 1) throw new XeroConfigError("page must be a whole number from 1");
        query.set("page", String(opts.page));
        query.set("pageSize", String(XERO_PAGE_SIZE));
      }
      if (opts.where !== undefined) {
        if (!WHERE.test(opts.where)) throw new XeroConfigError("the Xero connector only filters by date");
        query.set("where", opts.where);
      }
      if (opts.order !== undefined) {
        if (!ORDER.test(opts.order)) throw new XeroConfigError("the Xero connector only orders by UpdatedDateUTC");
        query.set("order", opts.order);
      }
      if (opts.includeArchived) query.set("includeArchived", "true");
      const headers: Record<string, string> = { "xero-tenant-id": tenantId, accept: "application/json" };
      if (opts.modifiedSince !== undefined) {
        if (!ISO.test(opts.modifiedSince)) throw new XeroConfigError("modifiedSince must be an ISO time in UTC");
        // Xero reads If-Modified-Since as UTC to the second.
        headers["if-modified-since"] = opts.modifiedSince.slice(0, 19);
      }
      const qs = query.toString();
      const url = `${XERO_API_URL}/${endpoint}${qs ? `?${qs}` : ""}`;
      let renewed = false;
      for (let attempt = 0; ; ) {
        // GET only: the connector never creates, updates or deletes anything in Xero.
        const response = await doFetch(url, { method: "GET", headers: { ...headers, authorization: `Bearer ${await accessToken()}` } });
        if (response.status === 401 && !renewed) {
          // An access token can be revoked before it expires; refresh once.
          renewed = true;
          access = null;
          continue;
        }
        if (response.status === 429) {
          const problem = response.headers.get("x-rate-limit-problem")?.toLowerCase().slice(0, 20);
          if (problem === "day") {
            throw new XeroApiError("Xero's daily call limit for this organisation is used up; the next sync resumes from the checkpoint", 429, problem);
          }
          if (attempt < retries) {
            const after = Number(response.headers.get("retry-after"));
            await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : 1000 * 2 ** attempt);
            attempt++;
            continue;
          }
          throw new XeroApiError(`Xero kept rate-limiting the sync${problem ? ` (${problem})` : ""}`, 429, problem);
        }
        // Nothing changed since If-Modified-Since.
        if (response.status === 304) return {};
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const message = messageOf(body);
          const hint = response.status === 403 ? "; check that the organisation is still connected to the KaratOS app" : "";
          throw new XeroApiError(`Xero answered HTTP ${response.status}${message ? `: ${message}` : ""}${hint}`, response.status);
        }
        if (!body || typeof body !== "object") throw new XeroApiError("Xero did not answer with JSON", response.status);
        return body as Record<string, unknown>;
      }
    },
  };
}
