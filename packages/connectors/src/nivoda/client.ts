/**
 * A small client for Nivoda's GraphQL diamond API. It signs in with the
 * Nivoda account's API username and password, which Nivoda answers with a
 * token good for 6 hours; every search then runs as that token. The
 * staging and production addresses are fixed here, so the password and the
 * token only ever go to Nivoda.
 *
 * Nivoda answers at most 50 diamonds a request and asks for at least 30
 * seconds between requests, so the client spaces every request out itself.
 * It sends queries only: holds and orders (Nivoda's Pro API mutations)
 * aren't in it.
 */

export const NIVODA_ENDPOINTS = {
  production: "https://integrations.nivoda.net/api/diamonds",
  staging: "https://intg-customer-staging.nivodaapi.net/api/diamonds",
} as const;
export type NivodaEnvironment = keyof typeof NIVODA_ENDPOINTS;

/** Nivoda's most diamonds in one answer. */
export const NIVODA_PAGE_SIZE = 50;
/** Nivoda asks for at least this long between two requests. */
export const NIVODA_REQUEST_SPACING_MS = 30_000;
/** Nivoda's tokens last 6 hours; one is renewed 10 minutes before that. */
const TOKEN_LIFETIME_MS = 6 * 3_600_000;
const RENEW_EARLY_MS = 10 * 60_000;
const MAX_RETRY_AFTER_S = 120;

const SIGN_IN = `query ($username: String!, $password: String!) {
  authenticate { username_and_password(username: $username, password: $password) { token } }
}`;

/**
 * What each diamond is read with. The fields past Nivoda's installation
 * guide (the certificate's grades and measurements, stock numbers, shade)
 * are its schema's names as other integrations use them, checked on the
 * first staging run.
 */
export const NIVODA_DIAMOND_FIELDS = `id price discount
  diamond {
    id availability NivodaStockId supplierStockId image video brown green milky eyeClean mine_of_origin
    certificate { id lab certNumber shape carats color clarity cut polish symmetry floInt floCol length width depth depthPercentage table girdle labgrown }
  }`;

const SEARCH = `query ($token: String!, $query: DiamondQuery!, $offset: Int!, $limit: Int!) {
  as(token: $token) {
    diamonds_by_query(query: $query, offset: $offset, limit: $limit, order: { type: price, direction: ASC }) {
      total_count
      items { ${NIVODA_DIAMOND_FIELDS} }
    }
  }
}`;

const BY_ID = `query ($token: String!, $id: ID!) {
  as(token: $token) { get_diamond_by_id(diamond_id: $id) { ${NIVODA_DIAMOND_FIELDS} } }
}`;

export interface NivodaClientOptions {
  username: string;
  /** Sent to Nivoda only, and never logged or shown. */
  password: string;
  environment?: NivodaEnvironment;
  fetch?: typeof globalThis.fetch;
  /** Waits between requests and before retrying a throttled one; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class NivodaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NivodaConfigError";
  }
}

/** Nivoda answered with an error. `status` is its HTTP status; GraphQL errors arrive with 200. */
export class NivodaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NivodaApiError";
  }
}

/** The username and password were turned down. */
export class NivodaAuthError extends NivodaApiError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "NivodaAuthError";
  }
}

export interface NivodaPage {
  totalCount: number;
  /** The items as Nivoda sent them; the normalizer checks each. */
  items: unknown[];
}

export interface NivodaClient {
  /** One page of a saved search, cheapest first. */
  search(query: Record<string, unknown>, offset: number): Promise<NivodaPage>;
  /** One diamond by its Nivoda id, or null when Nivoda has none by that id. */
  diamond(id: string): Promise<unknown | null>;
}

/** Nivoda's error messages, cut short, with the password taken out in case one ever repeats it. */
const messageOf = (errors: unknown, password: string) =>
  (Array.isArray(errors) ? errors : [])
    .map((e) => (typeof (e as { message?: unknown })?.message === "string" ? (e as { message: string }).message : ""))
    .filter(Boolean)
    .join("; ")
    .split(password)
    .join("[hidden]")
    .slice(0, 300);

const AUTH_PROBLEM = /auth|token|unauthori[sz]ed|forbidden|expired|credential|password|login/i;

export function nivodaClient(options: NivodaClientOptions): NivodaClient {
  if (!/^[^\s:]{3,254}$/.test(options.username)) throw new NivodaConfigError("NIVODA_USERNAME is missing or not in the expected shape");
  if (!/^\S{8,256}$/.test(options.password)) throw new NivodaConfigError("NIVODA_PASSWORD is missing or not in the expected shape");
  const environment = options.environment ?? "production";
  if (!Object.hasOwn(NIVODA_ENDPOINTS, environment)) throw new NivodaConfigError("NIVODA_ENVIRONMENT must be production or staging");
  const endpoint = NIVODA_ENDPOINTS[environment];
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => new Date());
  const retries = options.rateLimitRetries ?? 3;
  let token: { value: string; renewAt: number } | null = null;
  let lastRequestAt: number | null = null;

  /** Posts one GraphQL request, spaced from the last and waiting out 429s. */
  async function post(query: string, variables: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      if (lastRequestAt !== null) {
        const wait = lastRequestAt + NIVODA_REQUEST_SPACING_MS - now().getTime();
        if (wait > 0) await sleep(wait);
      }
      lastRequestAt = now().getTime();
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (response.status === 429 && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(1000 * (Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) : NIVODA_REQUEST_SPACING_MS / 1000));
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new NivodaAuthError(`Nivoda turned down the request for ${what}: check NIVODA_USERNAME and NIVODA_PASSWORD`, response.status);
      if (response.status !== 200) throw new NivodaApiError(`Nivoda answered HTTP ${response.status} for ${what}`, response.status);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new NivodaApiError(`Nivoda answered ${what} with a body that isn't JSON`, 200);
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new NivodaApiError(`Nivoda answered ${what} with something other than a GraphQL answer`, 200);
      return body as Record<string, unknown>;
    }
  }

  async function signIn(): Promise<string> {
    const body = await post(SIGN_IN, { username: options.username, password: options.password }, "sign-in");
    const value = (body.data as { authenticate?: { username_and_password?: { token?: unknown } } } | null | undefined)?.authenticate?.username_and_password?.token;
    if (typeof value === "string" && /^\S{8,8192}$/.test(value)) {
      token = { value, renewAt: now().getTime() + TOKEN_LIFETIME_MS - RENEW_EARLY_MS };
      return value;
    }
    const message = messageOf(body.errors, options.password);
    throw new NivodaAuthError(`Nivoda turned down the sign-in${message ? ` (${message})` : ""}: check NIVODA_USERNAME, NIVODA_PASSWORD and NIVODA_ENVIRONMENT`, 200);
  }

  /** Runs a query as the token, signing in again once if Nivoda says the token is no good. */
  async function asToken(query: string, variables: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const current = token && now().getTime() < token.renewAt ? token.value : await signIn();
      const body = await post(query, { ...variables, token: current }, what);
      const result = (body.data as { as?: Record<string, unknown> | null } | null | undefined)?.as;
      const message = messageOf(body.errors, options.password);
      if (message && AUTH_PROBLEM.test(message) && attempt === 0) {
        token = null;
        continue;
      }
      if (message && AUTH_PROBLEM.test(message)) throw new NivodaAuthError(`Nivoda turned down a new token for ${what} (${message})`, 200);
      if (message) throw new NivodaApiError(`Nivoda answered ${what} with an error: ${message}`, 200);
      if (typeof result !== "object" || result === null) throw new NivodaApiError(`Nivoda answered ${what} without a result`, 200);
      return result;
    }
  }

  return {
    async search(query, offset) {
      if (!Number.isInteger(offset) || offset < 0) throw new NivodaConfigError("offset must be a whole number of 0 or more");
      const result = await asToken(SEARCH, { query, offset, limit: NIVODA_PAGE_SIZE }, "the diamond search");
      const page = result.diamonds_by_query as { total_count?: unknown; items?: unknown } | null | undefined;
      if (!page || !Array.isArray(page.items) || typeof page.total_count !== "number" || !Number.isInteger(page.total_count) || page.total_count < 0) {
        throw new NivodaApiError("Nivoda answered the diamond search without its items and total count", 200);
      }
      return { totalCount: page.total_count, items: page.items };
    },
    async diamond(id) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new NivodaConfigError("not a Nivoda diamond id");
      const result = await asToken(BY_ID, { id }, "the diamond lookup");
      return result.get_diamond_by_id ?? null;
    },
  };
}
