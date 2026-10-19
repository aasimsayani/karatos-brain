/**
 * A small client for Stripe's REST API. Read-only: it only sends GET
 * requests, and it only accepts restricted keys (`rk_`), which the account
 * owner creates with read access only. A full secret key (`sk_`) can move
 * money, so it is refused.
 */

/** The version the connector was built against; override with STRIPE_API_VERSION. */
export const STRIPE_DEFAULT_API_VERSION = "2026-09-30.endive";

const KEY = /^rk_(live|test)_[A-Za-z0-9]{16,}$/;
const API_VERSION = /^\d{4}-\d{2}-\d{2}\.[a-z]+$/;

export interface StripeClientOptions {
  /** A restricted key with read-only access. */
  secretKey: string;
  apiVersion?: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Base URL, for tests. */
  baseUrl?: string;
}

export class StripeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeConfigError";
  }
}

/** Stripe answered with an error. `code` is Stripe's error code or type when it gives one. */
export class StripeApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "StripeApiError";
    this.status = status;
    this.code = code;
  }
}

/** A page of a Stripe list endpoint. */
export interface StripeList<T> {
  object: "list";
  data: T[];
  has_more: boolean;
}

/** Query values; arrays become `key[]=a&key[]=b`, objects become `key[sub]=v`. */
export type StripeParams = Record<string, string | number | undefined | readonly string[] | Record<string, string | number>>;

export interface StripeClient {
  list<T extends { id: string }>(path: string, params: StripeParams): Promise<StripeList<T>>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Stripe's bracket syntax for nested and array query parameters. */
export function stripeQuery(params: StripeParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) query.append(`${key}[]`, String(item));
    else if (typeof value === "object") for (const [sub, v] of Object.entries(value)) query.append(`${key}[${sub}]`, String(v));
    else query.append(key, String(value));
  }
  return query.toString();
}

export function stripeClient(options: StripeClientOptions): StripeClient {
  const key = options.secretKey?.trim() ?? "";
  if (/^sk_/.test(key)) throw new StripeConfigError("STRIPE_SECRET_KEY must be a restricted key (rk_) with read-only access, not a full secret key");
  if (!KEY.test(key)) throw new StripeConfigError("STRIPE_SECRET_KEY must be a Stripe restricted key starting rk_live_ or rk_test_");
  const apiVersion = options.apiVersion || STRIPE_DEFAULT_API_VERSION;
  if (!API_VERSION.test(apiVersion)) throw new StripeConfigError("STRIPE_API_VERSION must look like 2026-09-30.endive");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  const base = options.baseUrl ?? "https://api.stripe.com";

  return {
    async list<T extends { id: string }>(path: string, params: StripeParams): Promise<StripeList<T>> {
      if (!/^\/v1\/[a-z_]+$/.test(path)) throw new StripeConfigError(`not a Stripe list endpoint: ${path}`);
      const qs = stripeQuery(params);
      const url = `${base}${path}${qs ? `?${qs}` : ""}`;
      for (let attempt = 0; ; attempt++) {
        // GET only: the connector never creates, updates or deletes anything in Stripe.
        const response = await doFetch(url, {
          method: "GET",
          headers: { authorization: `Bearer ${key}`, "stripe-version": apiVersion, accept: "application/json" },
        });
        if (response.status === 429 && attempt < retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        const body = (await response.json().catch(() => null)) as (StripeList<T> & { error?: { message?: string; code?: string; type?: string } }) | null;
        if (!response.ok) {
          const error = body?.error;
          // Stripe's messages never contain the key; they are still cut short.
          throw new StripeApiError(`Stripe answered HTTP ${response.status}${error?.message ? `: ${error.message.slice(0, 200)}` : ""}`, response.status, error?.code ?? error?.type);
        }
        if (!body || body.object !== "list" || !Array.isArray(body.data)) throw new StripeApiError(`Stripe ${path} did not answer with a list`, response.status);
        return body;
      }
    },
  };
}
