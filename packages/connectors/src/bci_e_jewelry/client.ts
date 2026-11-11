/**
 * A small client for the Business Central API (v2.0) of a jeweler's
 * e-Jewelry tenant. e-Jewelry runs on Microsoft Dynamics 365 Business
 * Central, so its items, vendors, and sales and purchase invoices come
 * through Business Central's standard API.
 *
 * It signs in service to service: a Microsoft Entra app's client id and
 * secret are traded for a token (client credentials, scope
 * `https://api.businesscentral.dynamics.com/.default`). Business Central's
 * app permission is API.ReadWrite.All, with no read-only form, so what the
 * app can do is set by the permission sets the jeweler gives it on the
 * Microsoft Entra Applications page in Business Central, and the setup asks
 * for read-only ones. The client sends only that token request and GETs of
 * four lists in one company, marked `Data-Access-Intent: ReadOnly`, and
 * follows a list's `@odata.nextLink` only while it stays on that list.
 *
 * Business Central allows 6,000 calls in five minutes for a user, so calls
 * are spaced a tenth of a second apart. A 429, 500, 502, 503 or 504 is
 * waited out a few times (Retry-After when given, up to a minute, else five
 * seconds, doubling) before the error goes to runSync, which keeps the
 * checkpoint. A token is kept until five minutes before it lapses, and
 * fetched again once if a call is turned down.
 */

export const EJEWELRY_API = "https://api.businesscentral.dynamics.com";
export const EJEWELRY_SCOPE = `${EJEWELRY_API}/.default`;
/** Calls are spaced this far apart, to stay well inside 6,000 in five minutes. */
export const EJEWELRY_SPACING_MS = 100;
const TOKEN_MARGIN_S = 300;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENVIRONMENT = /^[A-Za-z0-9_-]{1,50}$/;
const SECRET = /^[\x21-\x7e]{16,200}$/;

/** The lists read, each as Business Central's entity set. */
export const EJEWELRY_LISTS = ["items", "vendors", "salesInvoices", "purchaseInvoices"] as const;
export type EJewelryList = (typeof EJEWELRY_LISTS)[number];

export interface EJewelryClientOptions {
  /** The Microsoft Entra tenant id of the jeweler's Business Central (EJEWELRY_TENANT_ID). */
  tenantId: string;
  /** The Business Central environment's name, such as production (EJEWELRY_ENVIRONMENT). */
  environment: string;
  /** The company's id in Business Central (EJEWELRY_COMPANY_ID). */
  companyId: string;
  /** The Microsoft Entra app's client id (EJEWELRY_CLIENT_ID). */
  clientId: string;
  /** The app's client secret (EJEWELRY_CLIENT_SECRET). Sent to Microsoft only, and never logged or shown. */
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before a call or a retry; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock calls are spaced and tokens timed by; replaced in tests. */
  clock?: () => number;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class EJewelryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EJewelryConfigError";
  }
}

export class EJewelryApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EJewelryApiError";
  }
}

/** One page of a list, and the link to the next page, if any. */
export interface EJewelryPage {
  rows: unknown[];
  next: string | null;
}

export interface EJewelryClient {
  /** The list's rows changed at or after `since` (all of them when null), from `next` when going on with a list. */
  page(list: EJewelryList, since: string | null, next: string | null): Promise<EJewelryPage>;
  /** Where a list's pages live; a next link must start with it. */
  listUrl(list: EJewelryList): string;
}

/** A moment as Business Central's filters take it: UTC, to the second or finer. */
export const EJEWELRY_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,7})?Z$/;

export function ejewelryClient(options: EJewelryClientOptions): EJewelryClient {
  const setting = (value: string | undefined, name: string, shape: RegExp) => {
    const v = value?.trim();
    if (v === undefined || !shape.test(v)) throw new EJewelryConfigError(`${name} is missing or not in the expected shape`);
    return v;
  };
  const tenant = setting(options.tenantId, "EJEWELRY_TENANT_ID", GUID);
  const environment = setting(options.environment, "EJEWELRY_ENVIRONMENT", ENVIRONMENT);
  const company = setting(options.companyId, "EJEWELRY_COMPANY_ID", GUID);
  const clientId = setting(options.clientId, "EJEWELRY_CLIENT_ID", GUID);
  const secret = setting(options.clientSecret, "EJEWELRY_CLIENT_SECRET", SECRET);
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock ?? Date.now;
  const retries = options.retries ?? 3;
  const base = `${EJEWELRY_API}/v2.0/${tenant}/${environment}/api/v2.0/companies(${company})`;
  let lastCall = Number.NEGATIVE_INFINITY;
  let token: { value: string; until: number } | null = null;

  /** One call, spaced from the last and retried on a 429 or 5xx. */
  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + EJEWELRY_SPACING_MS - clock();
      if (wait > 0) await sleep(wait);
      lastCall = clock();
      const response = await doFetch(url, init);
      if (RETRIED.has(response.status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isSafeInteger(after) && after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : 5000 * 2 ** attempt);
        continue;
      }
      return response;
    }
  }

  async function signIn(): Promise<string> {
    if (token && clock() < token.until) return token.value;
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret, scope: EJEWELRY_SCOPE });
    const response = await send(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() });
    if (response.status === 400 || response.status === 401) throw new EJewelryConfigError("Microsoft turned down EJEWELRY_CLIENT_ID and EJEWELRY_CLIENT_SECRET: check the app, its secret and EJEWELRY_TENANT_ID");
    if (response.status !== 200) throw new EJewelryApiError(`Microsoft answered HTTP ${response.status} for a token`, response.status);
    const answer = (await response.json().catch(() => undefined)) as { access_token?: unknown; expires_in?: unknown } | undefined;
    const lasts = Number(answer?.expires_in);
    if (typeof answer?.access_token !== "string" || !/^\S{1,8192}$/.test(answer.access_token) || !Number.isSafeInteger(lasts) || lasts <= 0) throw new EJewelryApiError("Microsoft answered without a token", 200);
    token = { value: answer.access_token, until: clock() + (lasts - TOKEN_MARGIN_S) * 1000 };
    return token.value;
  }

  const listUrl = (list: EJewelryList) => `${base}/${list}`;

  return {
    listUrl,
    async page(list, since, next) {
      if (!EJEWELRY_LISTS.includes(list)) throw new EJewelryApiError("not a list KaratOS reads", 0);
      if (since !== null && !EJEWELRY_TIME.test(since)) throw new EJewelryApiError("a start must be a UTC time", 0);
      // A next link is only followed while it stays on this list.
      if (next !== null && !next.startsWith(`${listUrl(list)}?`)) throw new EJewelryApiError("a next link must stay on the list being read", 0);
      const url = next ?? (since === null ? listUrl(list) : `${listUrl(list)}?${new URLSearchParams({ $filter: `lastModifiedDateTime ge ${since}` })}`);
      for (let fresh = false; ; fresh = true) {
        const response = await send(url, { method: "GET", headers: { authorization: `Bearer ${await signIn()}`, accept: "application/json", "data-access-intent": "ReadOnly" } });
        if (response.status === 401 && !fresh) {
          token = null;
          continue;
        }
        if (response.status === 401) throw new EJewelryConfigError("Business Central turned down the app's token: check the app is enabled on the Microsoft Entra Applications page");
        if (response.status === 403) throw new EJewelryConfigError(`The app can't read ${list}: give it a read-only permission set that covers them in Business Central`);
        if (response.status === 404) throw new EJewelryConfigError("Business Central has no such company: check EJEWELRY_ENVIRONMENT and EJEWELRY_COMPANY_ID");
        if (response.status !== 200) throw new EJewelryApiError(`Business Central answered HTTP ${response.status} for ${list}`, response.status);
        const body = (await response.json().catch(() => undefined)) as { value?: unknown; "@odata.nextLink"?: unknown } | undefined;
        if (!Array.isArray(body?.value)) throw new EJewelryApiError(`Business Central answered ${list} without a list`, 200);
        const link = body["@odata.nextLink"];
        if (link !== undefined && (typeof link !== "string" || !link.startsWith(`${listUrl(list)}?`))) throw new EJewelryApiError(`Business Central answered ${list} with a next link off the list`, 200);
        return { rows: body.value, next: (link as string | undefined) ?? null };
      }
    },
  };
}
