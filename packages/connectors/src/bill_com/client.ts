/**
 * A small client for BILL's v3 API. It signs in with a developer app's
 * client id and secret (OAuth client credentials at /authx/token) and reads
 * one list page a call from GET /v3/vendors, /v3/bills or /v3/payments,
 * oldest change first. It sends nothing else: no payments, approvals,
 * vendor changes or funding account calls. The developer app should be
 * made with BILL's "Accounting data access" option, which leaves out
 * payment creation and funding account updates; BILL has no read-only
 * option, so this client is what keeps KaratOS to reading.
 *
 * BILL answers a bad or expired token with 401 (signed in again once),
 * and its rate limits with error codes: BDC_1322 when more than 3 requests
 * run at once for an organization (retried with backoff) and BDC_1144
 * when the 20,000 requests an hour are used up (stopped, since nothing
 * goes through until the next hour). 429 and 503 are retried too.
 */

export const BILL_HOSTS = {
  production: { auth: "https://auth.bill.com", api: "https://gateway.prod.bill.com/connect" },
  sandbox: { auth: "https://auth.stage.bill.com", api: "https://gateway.stage.bill.com/connect" },
} as const;
export type BillEnvironment = keyof typeof BILL_HOSTS;

export const BILL_RESOURCES = ["vendors", "bills", "payments"] as const;
export type BillResource = (typeof BILL_RESOURCES)[number];

/** BILL's largest page. */
export const BILL_PAGE_SIZE = 100;
/** Signed in again this long before the token runs out. */
const TOKEN_MARGIN_MS = 5 * 60_000;
const MAX_RETRY_AFTER_S = 60;
/** A page token BILL gave back. Anything else is not sent. */
export const BILL_PAGE_TOKEN = /^[A-Za-z0-9_=+/.-]{1,2048}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface BillClientOptions {
  clientId: string;
  /** Sent to BILL only and never logged or shown. */
  clientSecret: string;
  /** "production" (default) or "sandbox". */
  environment?: BillEnvironment | undefined;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Times a busy answer is retried here before the error goes to runSync. */
  retries?: number;
}

export class BillConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillConfigError";
  }
}

/** BILL answered with an error. `code` is the first BDC code in its error list, when it gave one. */
export class BillApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "BillApiError";
  }
}

export interface BillPage {
  results: Record<string, unknown>[];
  /** The token for the next page, when BILL gave one. */
  nextPage: string | undefined;
}

export interface BillClient {
  /** One page of records changed at or after `since`, oldest change first. */
  list(resource: BillResource, query: { since: string; page?: string | undefined }): Promise<BillPage>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The first error code BILL gave. Its errors come as a list of {code, message}, or one such object. */
export function billErrorCode(body: unknown): string | undefined {
  const first = Array.isArray(body) ? body[0] : body;
  const code = isObject(first) ? first.code : undefined;
  return typeof code === "string" && /^BDC_\d{1,6}$/.test(code) ? code : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function billClient(options: BillClientOptions): BillClient {
  if (!/^[A-Za-z0-9_.-]{8,128}$/.test(options.clientId)) throw new BillConfigError("BILL_CLIENT_ID is missing or not in the expected shape");
  if (!/^\S{8,512}$/.test(options.clientSecret)) throw new BillConfigError("BILL_CLIENT_SECRET is missing or not in the expected shape");
  const environment = options.environment ?? "production";
  if (!Object.hasOwn(BILL_HOSTS, environment)) throw new BillConfigError('BILL_ENVIRONMENT must be "production" or "sandbox"');
  const hosts = BILL_HOSTS[environment];
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => new Date());
  const retries = options.retries ?? 3;
  let token: { value: string; until: number } | null = null;

  async function send(request: () => Promise<Response>): Promise<{ response: Response; body: unknown }> {
    for (let attempt = 0; ; attempt++) {
      const response = await request();
      const body = await readJson(response);
      const busy = response.status === 429 || response.status === 503 || billErrorCode(body) === "BDC_1322";
      if (busy && billErrorCode(body) !== "BDC_1144" && attempt < retries) {
        const after = response.headers.get("retry-after");
        const seconds = after !== null && /^\d{1,6}$/.test(after) ? Number(after) : 0;
        await sleep(1000 * (seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_S) : 2 ** attempt));
        continue;
      }
      return { response, body };
    }
  }

  async function signIn(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: options.clientId, client_secret: options.clientSecret });
    const { response, body } = await send(() =>
      fetch(`${hosts.auth}/authx/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: form.toString(),
      }),
    );
    if (response.status === 400 || response.status === 401) throw new BillApiError("BILL turned down the client id and secret: check BILL_CLIENT_ID, BILL_CLIENT_SECRET and BILL_ENVIRONMENT", response.status, billErrorCode(body));
    if (response.status !== 200) throw new BillApiError(`BILL sign-in answered HTTP ${response.status}`, response.status, billErrorCode(body));
    const value = isObject(body) ? body.access_token : undefined;
    if (typeof value !== "string" || !/^\S{16,8192}$/.test(value)) throw new BillApiError("BILL sign-in answered without an access token", 200);
    // BILL writes expires_in as whole seconds. Anything else, or more than about four months, counts as already run out.
    const expires = isObject(body) && typeof body.expires_in === "number" ? body.expires_in : 0;
    const seconds = Number.isInteger(expires) && expires > 0 && expires < 10_000_000 ? expires : 0;
    token = { value, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return value;
  }

  async function list(resource: BillResource, query: { since: string; page?: string | undefined }): Promise<BillPage> {
    if (!BILL_RESOURCES.includes(resource)) throw new BillConfigError("not a BILL list this connector reads");
    if (!ISO.test(query.since)) throw new BillConfigError("since must be an ISO time in UTC");
    if (query.page !== undefined && !BILL_PAGE_TOKEN.test(query.page)) throw new BillConfigError("not a BILL page token");
    const params = new URLSearchParams({ max: String(BILL_PAGE_SIZE), sort: "updatedTime:asc", filters: `updatedTime:gte:${query.since}` });
    if (query.page !== undefined) params.set("page", query.page);
    const url = `${hosts.api}/v3/${resource}?${params.toString()}`;
    for (let signIns = 0; ; signIns++) {
      const bearer = await signIn();
      const { response, body } = await send(() => fetch(url, { method: "GET", headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" } }));
      if (response.status === 401 && signIns === 0) {
        token = null;
        continue;
      }
      const code = billErrorCode(body);
      if (code === "BDC_1144") throw new BillApiError("BILL's 20,000 requests for this hour are used up; the next sync picks up from the checkpoint", response.status, code);
      if (code === "BDC_1322") throw new BillApiError("BILL kept answering that 3 requests are already running for this organization", response.status, code);
      if (response.status === 401 || response.status === 403) throw new BillApiError(`BILL turned down the token for ${resource}: check the developer app's user can see ${resource}`, response.status, code);
      if (response.status !== 200) throw new BillApiError(`BILL ${resource} answered HTTP ${response.status}`, response.status, code);
      if (!isObject(body) || !Array.isArray(body.results)) throw new BillApiError(`BILL ${resource} answered without a results list`, 200);
      const results = body.results.filter(isObject);
      const next = typeof body.nextPage === "string" && BILL_PAGE_TOKEN.test(body.nextPage) ? body.nextPage : undefined;
      return { results, nextPage: next };
    }
  }

  return { list };
}
