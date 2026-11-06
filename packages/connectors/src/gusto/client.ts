import type { QuickBooksTokenStore } from "../quickbooks/client.js";

/**
 * A small client for Gusto's App Integrations API. It reads one company's
 * payrolls and nothing else: the only requests it sends to the company are
 * GETs of two payroll endpoints, and after every token refresh it asks
 * Gusto what the new token may do (token_info) and stops on a token that
 * belongs to another company or holds any scope beyond reading. Its one
 * POST is the OAuth token refresh.
 *
 * Access tokens last two hours. Each refresh returns a new refresh token,
 * and the old one is revoked as soon as the new access token is first
 * used, so the new refresh token goes to the token store before anything
 * else happens with it.
 *
 * Gusto allows 200 requests a minute per company and app; a 429 is waited
 * out a few times before the error goes to runSync.
 */

export const GUSTO_API_URLS = {
  production: "https://api.gusto.com",
  demo: "https://api.gusto-demo.com",
} as const;
export type GustoEnvironment = keyof typeof GUSTO_API_URLS;

/** The API version every request asks for, sent as X-Gusto-API-Version. */
export const GUSTO_API_VERSION = "2026-06-15";

/** Gusto's largest page. */
export const GUSTO_PAGE_SIZE = 100;

/** The scope the connector needs. Gusto sets an app's scopes in its developer portal. */
export const GUSTO_READ_SCOPES = ["payrolls:read"] as const;

/** Same shape as QuickBooks': the newest refresh token, kept encrypted by the instance. */
export type GustoTokenStore = QuickBooksTokenStore;

export interface GustoClientOptions {
  clientId: string;
  clientSecret: string;
  /** The redirect URI registered for the app; Gusto wants it on every refresh. */
  redirectUri: string;
  /** The company's UUID in Gusto. */
  companyUuid: string;
  tokens: GustoTokenStore;
  /** demo for Gusto's sandbox, production otherwise. */
  environment?: GustoEnvironment;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Milliseconds since the epoch; replaced in tests to expire access tokens. */
  clock?: () => number;
}

export class GustoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GustoConfigError";
  }
}

export class GustoApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GustoApiError";
    this.status = status;
  }
}

export interface GustoPayrollQuery {
  /** First check date, as YYYY-MM-DD. */
  startDate: string;
  /** Last check date, as YYYY-MM-DD, at most a year after startDate. */
  endDate: string;
  /** 1-based page. */
  page: number;
}

export interface GustoClient {
  /** Processed payrolls with their totals, by check date, oldest first. */
  listPayrolls(query: GustoPayrollQuery): Promise<unknown[]>;
  /** One payroll with each employee's compensation. */
  getPayroll(payrollUuid: string): Promise<Record<string, unknown>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Scopes that only read. */
const READ_SCOPE = /^[a-z_]+:read$/;
const ACCESS_RENEW_EARLY_MS = 5 * 60_000;
const MAX_RETRY_AFTER_S = 60;
const YEAR_DAYS = 365;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Scopes beyond reading. Empty means the token can only read. */
export const gustoWriteScopes = (scopes: readonly string[]) => scopes.filter((s) => !READ_SCOPE.test(s));

const isDay = (value: string) => DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** Gusto's message for an error, cut short. Error bodies describe the request, never the token. */
function messageOf(body: unknown): string {
  const b = (body ?? {}) as { errors?: unknown; message?: unknown; error_description?: unknown };
  const first = Array.isArray(b.errors) ? (b.errors[0] as { message?: unknown } | undefined)?.message : undefined;
  const message = [first, b.message, b.error_description].find((m): m is string => typeof m === "string" && m.trim() !== "");
  return (message ?? "").slice(0, 200);
}

export function gustoClient(options: GustoClientOptions): GustoClient {
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!clientId || !clientSecret) throw new GustoConfigError("set GUSTO_CLIENT_ID and GUSTO_CLIENT_SECRET");
  const redirectUri = options.redirectUri?.trim() ?? "";
  if (!/^https?:\/\/\S+$/.test(redirectUri)) throw new GustoConfigError("GUSTO_REDIRECT_URI must be the app's registered redirect URI");
  const companyUuid = options.companyUuid?.trim().toLowerCase() ?? "";
  if (!UUID.test(companyUuid)) throw new GustoConfigError("GUSTO_COMPANY_UUID must be the company's UUID in Gusto");
  const environment = options.environment ?? "production";
  if (!Object.hasOwn(GUSTO_API_URLS, environment)) throw new GustoConfigError("GUSTO_ENVIRONMENT must be production or demo");
  const base = GUSTO_API_URLS[environment];
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  const clock = options.clock ?? (() => Date.now());
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  const apiHeaders = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/json", "x-gusto-api-version": GUSTO_API_VERSION });

  /** Checks a new access token belongs to this company and can only read. */
  async function checkToken(token: string): Promise<void> {
    const response = await doFetch(`${base}/v1/token_info`, { method: "GET", headers: apiHeaders(token) });
    const body = (await response.json().catch(() => null)) as { scope?: unknown; resource?: { type?: unknown; uuid?: unknown } } | null;
    if (!response.ok || !body) throw new GustoApiError(`Gusto answered HTTP ${response.status} when asked what the token may do`, response.status);
    const resource = body.resource ?? {};
    if (resource.type !== "Company" || typeof resource.uuid !== "string" || resource.uuid.toLowerCase() !== companyUuid) {
      throw new GustoConfigError("the Gusto connection is for a different company than GUSTO_COMPANY_UUID; reconnect the right company");
    }
    if (typeof body.scope !== "string") throw new GustoConfigError("Gusto didn't say which scopes the connection holds, so the connector won't use it");
    const scopes = body.scope.split(" ").filter(Boolean);
    const extra = gustoWriteScopes(scopes);
    if (extra.length) {
      throw new GustoConfigError(`the Gusto connection can change data (${extra.slice(0, 5).join(", ")}); give the app only ${GUSTO_READ_SCOPES.join(" ")} and reconnect`);
    }
    if (!GUSTO_READ_SCOPES.every((s) => scopes.includes(s))) throw new GustoConfigError(`the Gusto connection is missing ${GUSTO_READ_SCOPES.join(" ")}`);
  }

  async function refresh(): Promise<string> {
    const refreshToken = (await options.tokens.load()).trim();
    if (!refreshToken) throw new GustoConfigError("set GUSTO_REFRESH_TOKEN");
    const response = await doFetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown };
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
      // invalid_grant: the refresh token was used already, or the company disconnected the app.
      const code = typeof body.error === "string" ? body.error.slice(0, 40) : undefined;
      const hint = code === "invalid_grant" ? "; reconnect Gusto to get a new refresh token" : "";
      throw new GustoApiError(`Gusto turned down the token refresh (HTTP ${response.status}${code ? `, ${code}` : ""})${hint}`, response.status);
    }
    // Saved before the new access token is used: that first use revokes the old refresh token.
    if (typeof body.refresh_token === "string" && body.refresh_token) await options.tokens.save(body.refresh_token);
    await checkToken(body.access_token);
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 7200;
    access = { token: body.access_token, expiresAt: clock() + seconds * 1000 };
    return access.token;
  }

  async function accessToken(): Promise<string> {
    if (access && access.expiresAt - ACCESS_RENEW_EARLY_MS > clock()) return access.token;
    // One refresh at a time: a second would spend a refresh token the first already replaced.
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function get(path: string): Promise<unknown> {
    const url = `${base}${path}`;
    let renewed = false;
    for (let attempt = 0; ; ) {
      // GET only: the connector never creates, changes or runs anything in Gusto.
      const response = await doFetch(url, { method: "GET", headers: apiHeaders(await accessToken()) });
      if (response.status === 401 && !renewed) {
        // An access token can be revoked before it expires; refresh once.
        renewed = true;
        access = null;
        continue;
      }
      if (response.status === 429) {
        if (attempt < retries) {
          const after = Number(response.headers.get("retry-after"));
          await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : 1000 * 2 ** attempt);
          attempt++;
          continue;
        }
        throw new GustoApiError("Gusto kept rate-limiting the sync", 429);
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = messageOf(body);
        const hint = response.status === 403 ? "; check the app still has payrolls:read for this company" : "";
        throw new GustoApiError(`Gusto answered HTTP ${response.status}${message ? `: ${message}` : ""}${hint}`, response.status);
      }
      if (body === null || typeof body !== "object") throw new GustoApiError("Gusto did not answer with JSON", response.status);
      return body;
    }
  }

  return {
    async listPayrolls({ startDate, endDate, page }) {
      if (!isDay(startDate) || !isDay(endDate)) throw new GustoConfigError("payroll dates must be YYYY-MM-DD");
      const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000;
      if (days < 0 || days > YEAR_DAYS) throw new GustoConfigError("Gusto lists at most a year of payrolls at a time");
      if (!Number.isInteger(page) || page < 1) throw new GustoConfigError("page must be a whole number from 1");
      const query = new URLSearchParams({
        processing_statuses: "processed",
        date_filter_by: "check_date",
        start_date: startDate,
        end_date: endDate,
        include: "totals",
        sort_order: "asc",
        page: String(page),
        per: String(GUSTO_PAGE_SIZE),
      });
      const body = await get(`/v1/companies/${companyUuid}/payrolls?${query}`);
      if (!Array.isArray(body)) throw new GustoApiError("Gusto's payroll list was not a list", 200);
      return body;
    },
    async getPayroll(payrollUuid) {
      if (!UUID.test(payrollUuid)) throw new GustoConfigError("a payroll id must be a UUID");
      const body = await get(`/v1/companies/${companyUuid}/payrolls/${payrollUuid.toLowerCase()}`);
      if (Array.isArray(body)) throw new GustoApiError("Gusto's payroll was a list", 200);
      return body as Record<string, unknown>;
    },
  };
}
