/**
 * A small client for Shopify's GraphQL Admin API. Read-only: it only sends
 * queries, never mutations, and the app's token should hold read scopes only.
 *
 * It signs in one of two ways:
 * - clientId and clientSecret of a Dev Dashboard app installed on the store.
 *   Shopify stopped letting merchants create custom apps in the store admin
 *   on 2026-01-01; Dev Dashboard apps get a 24-hour token from the client
 *   credentials grant, which this client requests and renews itself.
 * - accessToken, the permanent Admin API token of an older admin-made app.
 */

/** Quarterly versions are supported for 12 months; override with SHOPIFY_API_VERSION. */
export const SHOPIFY_DEFAULT_API_VERSION = "2026-07";

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const API_VERSION = /^\d{4}-(01|04|07|10)$/;

export interface ShopifyClientOptions {
  /** The store's myshopify.com domain, e.g. example-store.myshopify.com. */
  shopDomain: string;
  /** An older admin-made custom app's Admin API token. */
  accessToken?: string;
  /** A Dev Dashboard app's client ID and secret, exchanged for a 24-hour token. */
  clientId?: string;
  clientSecret?: string;
  apiVersion?: string;
  fetch?: typeof globalThis.fetch;
  /** Waits while the query cost bucket refills; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a throttled query is retried here before the error goes to runSync. */
  throttleRetries?: number;
  /** Milliseconds since the epoch; replaced in tests to expire granted tokens. */
  clock?: () => number;
}

const TOKEN_RENEW_EARLY_MS = 5 * 60_000;

export class ShopifyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyConfigError";
  }
}

/** Shopify answered with an error. `status` is the HTTP status, 200 for GraphQL-level errors. */
export class ShopifyApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ShopifyApiError";
    this.status = status;
    this.code = code;
  }
}

interface ThrottleStatus {
  currentlyAvailable: number;
  restoreRate: number;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message?: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: ThrottleStatus } };
}

export interface ShopifyClient {
  readonly endpoint: string;
  query<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function shopifyClient(options: ShopifyClientOptions): ShopifyClient {
  const shopDomain = options.shopDomain.trim().toLowerCase();
  if (!SHOP_DOMAIN.test(shopDomain)) throw new ShopifyConfigError("SHOPIFY_SHOP_DOMAIN must be the store's myshopify.com domain");
  const clientId = options.clientId?.trim();
  const clientSecret = options.clientSecret?.trim();
  if (Boolean(clientId) !== Boolean(clientSecret)) throw new ShopifyConfigError("set both SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET");
  if (!clientId && !options.accessToken) {
    throw new ShopifyConfigError("set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET, or SHOPIFY_ADMIN_ACCESS_TOKEN for an older admin app");
  }
  const apiVersion = options.apiVersion || SHOPIFY_DEFAULT_API_VERSION;
  if (!API_VERSION.test(apiVersion)) throw new ShopifyConfigError("SHOPIFY_API_VERSION must look like 2026-07");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.throttleRetries ?? 3;
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
  const clock = options.clock ?? (() => Date.now());
  let granted: { token: string; expiresAt: number } | null = null;

  /** The client credentials grant. The token lasts 24 hours; it is renewed 5 minutes early. */
  async function token(): Promise<string> {
    if (!clientId) return options.accessToken!;
    if (granted && granted.expiresAt - TOKEN_RENEW_EARLY_MS > clock()) return granted.token;
    const response = await doFetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret! }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!response.ok || !body.access_token) {
      // shop_not_permitted means the app and the store are in different Shopify organizations.
      const code = typeof body.error === "string" ? body.error.slice(0, 60) : undefined;
      throw new ShopifyApiError(`Shopify refused the client credentials grant (HTTP ${response.status}${code ? `, ${code}` : ""})`, response.status, code);
    }
    granted = { token: body.access_token, expiresAt: clock() + (body.expires_in ?? 86_399) * 1000 };
    return granted.token;
  }

  async function once<T>(query: string, variables: Record<string, unknown>, renewed = false): Promise<{ body: GraphQLResponse<T> }> {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-shopify-access-token": await token() },
      body: JSON.stringify({ query, variables }),
    });
    if (response.status === 401 && clientId && !renewed) {
      // A granted token can be revoked before it expires; ask for a new one once.
      granted = null;
      return once<T>(query, variables, true);
    }
    if (!response.ok) {
      // Error bodies are short; nothing from the request (the token) is echoed.
      const text = (await response.text().catch(() => "")).slice(0, 200);
      throw new ShopifyApiError(`Shopify answered HTTP ${response.status}${text ? `: ${text}` : ""}`, response.status);
    }
    return { body: (await response.json()) as GraphQLResponse<T> };
  }

  return {
    endpoint,
    async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      // Connectors are read-only: refuse anything that isn't a query.
      if (/^\s*mutation\b/i.test(query)) throw new ShopifyConfigError("the Shopify connector only sends queries");
      for (let attempt = 0; ; attempt++) {
        const { body } = await once<T>(query, variables);
        const errors = body.errors ?? [];
        const throttled = errors.some((e) => e.extensions?.code === "THROTTLED");
        if (throttled && attempt < retries) {
          const cost = body.extensions?.cost;
          const needed = (cost?.requestedQueryCost ?? 100) - (cost?.throttleStatus?.currentlyAvailable ?? 0);
          const rate = cost?.throttleStatus?.restoreRate || 50;
          await sleep(Math.max(1000, Math.ceil((needed / rate) * 1000)));
          continue;
        }
        if (errors.length) {
          const first = errors[0]!;
          throw new ShopifyApiError(`Shopify GraphQL error: ${(first.message ?? "unknown").slice(0, 200)}`, 200, first.extensions?.code);
        }
        if (body.data === undefined) throw new ShopifyApiError("Shopify answered without data", 200);
        return body.data;
      }
    },
  };
}
