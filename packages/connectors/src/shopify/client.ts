/**
 * A small client for Shopify's GraphQL Admin API. Read-only: it only sends
 * queries, never mutations, and the app's token should hold read scopes only.
 */

/** Quarterly versions are supported for 12 months; override with SHOPIFY_API_VERSION. */
export const SHOPIFY_DEFAULT_API_VERSION = "2026-07";

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const API_VERSION = /^\d{4}-(01|04|07|10)$/;

export interface ShopifyClientOptions {
  /** The store's myshopify.com domain, e.g. example-store.myshopify.com. */
  shopDomain: string;
  accessToken: string;
  apiVersion?: string;
  fetch?: typeof globalThis.fetch;
  /** Waits while the query cost bucket refills; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a throttled query is retried here before the error goes to runSync. */
  throttleRetries?: number;
}

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
  if (!options.accessToken) throw new ShopifyConfigError("SHOPIFY_ADMIN_ACCESS_TOKEN is empty");
  const apiVersion = options.apiVersion || SHOPIFY_DEFAULT_API_VERSION;
  if (!API_VERSION.test(apiVersion)) throw new ShopifyConfigError("SHOPIFY_API_VERSION must look like 2026-07");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.throttleRetries ?? 3;
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  async function once<T>(query: string, variables: Record<string, unknown>): Promise<{ body: GraphQLResponse<T> }> {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-shopify-access-token": options.accessToken },
      body: JSON.stringify({ query, variables }),
    });
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
