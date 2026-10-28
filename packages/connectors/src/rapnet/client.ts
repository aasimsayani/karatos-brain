/**
 * A small client for the Rapaport Price List API. It signs in machine to
 * machine: the client ID and secret from Rapaport Trade's API access page go
 * to Rapaport's token service, which answers a bearer token good for several
 * hours that every price list call then carries. Both addresses are fixed
 * here, so the secret and the token are only ever sent to Rapaport.
 *
 * The client reads two things: the full price list for a shape, and the
 * cells that changed in the latest list. Both are GETs; it has no way to
 * upload, list or change anything. A 401 on a price list call gets one new
 * token and one retry, a 429 waits as Retry-After says, and a 403 means the
 * account's subscription doesn't include the price list.
 */

export const RAPNET_TOKEN_URL = "https://authztoken.api.rapaport.com/api/get";
export const RAPNET_API = "https://technet.rapnetapis.com";

/** The shapes Rapaport publishes a list for. Pear is the guide for other fancy shapes. */
export const RAPNET_SHAPES = ["Round", "Pear"] as const;
export type RapnetShape = (typeof RAPNET_SHAPES)[number];

const MAX_RETRY_AFTER_S = 60;
/** A token is renewed this long before it expires. */
const RENEW_EARLY_MS = 5 * 60 * 1000;


export interface RapnetClientOptions {
  clientId: string;
  /** Sent to Rapaport's token service only, and never logged or shown. */
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  now?: () => Date;
}

export class RapnetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RapnetConfigError";
  }
}

/** Rapaport answered with an error. `status` is its HTTP status. */
export class RapnetApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RapnetApiError";
  }
}

/** The client ID and secret were turned down, or the token was rejected twice. */
export class RapnetAuthError extends RapnetApiError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "RapnetAuthError";
  }
}

export interface RapnetClient {
  /** Every row of the current list for a shape, as Rapaport sent them; the normalizer checks each. */
  list(shape: RapnetShape): Promise<unknown[]>;
  /** The rows that changed in the latest list, with their old prices. */
  changes(shape: RapnetShape): Promise<unknown[]>;
}

export function rapnetClient(options: RapnetClientOptions): RapnetClient {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(options.clientId)) throw new RapnetConfigError("RAPNET_CLIENT_ID is missing or not in the expected shape");
  if (!/^\S{16,256}$/.test(options.clientSecret)) throw new RapnetConfigError("RAPNET_CLIENT_SECRET is missing or not in the expected shape");
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => new Date());
  const retries = options.rateLimitRetries ?? 3;
  let token: { value: string; renewAt: number } | null = null;

  /** Sends a request, waiting out 429s. */
  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, init);
      if (response.status !== 429 || attempt >= retries) return response;
      const after = Number(response.headers.get("retry-after"));
      await sleep(1000 * (Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) : 2 ** attempt));
    }
  }

  async function body(response: Response, what: string): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new RapnetApiError(`Rapaport answered the ${what} with a body that isn't JSON`, response.status);
    }
  }

  async function signIn(): Promise<string> {
    const response = await send(RAPNET_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: options.clientId, client_secret: options.clientSecret }),
    });
    if (response.status === 401 || response.status === 403) throw new RapnetAuthError("Rapaport turned down the client ID and secret: check RAPNET_CLIENT_ID and RAPNET_CLIENT_SECRET", response.status);
    if (response.status !== 200) throw new RapnetApiError(`Rapaport's token service answered HTTP ${response.status}`, response.status);
    const answer = (await body(response, "sign-in")) as { access_token?: unknown; expires_in?: unknown } | null;
    const value = answer?.access_token;
    if (typeof value !== "string" || !/^\S{8,8192}$/.test(value)) throw new RapnetApiError("Rapaport's token service answered without a token", 200);
    const seconds = typeof answer!.expires_in === "number" && answer!.expires_in > 0 ? answer!.expires_in : 3600;
    token = { value, renewAt: now().getTime() + seconds * 1000 - RENEW_EARLY_MS };
    return value;
  }

  const bearer = async () => (token && now().getTime() < token.renewAt ? token.value : signIn());

  async function get(path: string, shape: RapnetShape, query: Record<string, string>): Promise<unknown[]> {
    if (!RAPNET_SHAPES.includes(shape)) throw new RapnetConfigError(`not a Rapaport price list shape: ${JSON.stringify(String(shape).slice(0, 20))}`);
    const url = `${RAPNET_API}${path}?${new URLSearchParams(query)}`;
    for (let attempt = 0; ; attempt++) {
      const response = await send(url, { method: "GET", headers: { Authorization: `Bearer ${await bearer()}`, Accept: "application/json" } });
      if (response.status === 401 && attempt === 0) {
        token = null;
        continue;
      }
      if (response.status === 401) throw new RapnetAuthError("Rapaport rejected a new token for the price list: check the API access on Rapaport Trade", 401);
      if (response.status === 403) throw new RapnetApiError("This Rapaport account's subscription doesn't include the price list", 403);
      if (response.status !== 200) throw new RapnetApiError(`Rapaport answered HTTP ${response.status} for the ${shape} price list`, response.status);
      const rows = await body(response, `${shape} price list`);
      if (!Array.isArray(rows)) throw new RapnetApiError(`Rapaport answered the ${shape} price list with something other than a list of rows`, 200);
      return rows as unknown[];
    }
  }

  return {
    list: (shape) => get("/pricelist/api/Prices/list", shape, { shape, csvnormalized: "true" }),
    changes: (shape) => get("/pricelist/api/Prices/changes", shape, { shape: shape.toLowerCase() }),
  };
}
