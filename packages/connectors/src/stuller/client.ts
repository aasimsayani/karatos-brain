/**
 * A small client for Stuller's API v2: the invoices on the business's
 * account and Stuller's current metal market rates. Requests use Basic auth
 * with a developer login, which Stuller makes for API use only (it can't
 * sign in to Stuller.com). The address is fixed here, so the password only
 * ever goes to Stuller.
 *
 * The client sends GETs only. It has no way to submit an order or configure
 * a product.
 */

export const STULLER_API = "https://api.stuller.com";
const MAX_RETRY_AFTER_S = 60;

export interface StullerClientOptions {
  username: string;
  /** Sent to Stuller only, and never logged or shown. */
  password: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class StullerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StullerConfigError";
  }
}

export class StullerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StullerApiError";
  }
}

export interface StullerClient {
  /** Every invoice on the account, as Stuller sent them; the normalizer checks each. */
  invoices(): Promise<unknown[]>;
  /** Stuller's current market rate for each metal. */
  metalRates(): Promise<unknown[]>;
}

export function stullerClient(options: StullerClientOptions): StullerClient {
  if (!/^[^\s:]{3,128}$/.test(options.username)) throw new StullerConfigError("STULLER_USERNAME is missing or not in the expected shape");
  if (!/^\S{8,256}$/.test(options.password)) throw new StullerConfigError("STULLER_PASSWORD is missing or not in the expected shape");
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.rateLimitRetries ?? 3;
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;

  async function get(path: string, list: string, what: string): Promise<unknown[]> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${STULLER_API}${path}`, { method: "GET", headers: { Authorization: authorization, Accept: "application/json" } });
      if (response.status === 429 && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(1000 * (Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) : 2 ** attempt));
        continue;
      }
      if (response.status === 401) throw new StullerApiError("Stuller turned down the login: check STULLER_USERNAME and STULLER_PASSWORD, and that the login has the Developer role", 401);
      if (response.status === 403) throw new StullerApiError(`Stuller's login isn't allowed to read ${what}`, 403);
      if (response.status !== 200) throw new StullerApiError(`Stuller answered HTTP ${response.status} for ${what}`, response.status);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new StullerApiError(`Stuller answered ${what} with a body that isn't JSON`, 200);
      }
      const items = (body as Record<string, unknown> | null)?.[list];
      if (!Array.isArray(items)) throw new StullerApiError(`Stuller answered ${what} without the ${list} list`, 200);
      return items;
    }
  }

  return {
    invoices: () => get("/api/v2/invoice", "Invoices", "invoices"),
    metalRates: () => get("/api/v2/products/metalmarketrates", "MetalMarkets", "metal market rates"),
  };
}
