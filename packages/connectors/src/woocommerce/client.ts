import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * A small client for the WooCommerce REST API (v3, `/wp-json/wc/v3/`).
 * Read-only by construction:
 *
 * - It sends GET requests only, to a fixed list of read endpoints, each with
 *   its own parameters; anything else is stopped before a request is made.
 * - WooCommerce keys carry a permission (Read, Write or Read/Write), but the
 *   API has no documented way to ask which one a key holds: WooCommerce only
 *   reveals it by refusing a request the key may not make. Checking it would
 *   mean sending a write, so the client doesn't. The GET allowlist is the
 *   guard, and the owner is asked to create a Read key. A Write-only key is
 *   caught on the first read, which WooCommerce refuses.
 *
 * The store's address is the client's own, so it is checked hard: https
 * only (WooCommerce takes Basic auth only over TLS, and over http the keys
 * would travel in the clear), a plain public hostname with no credentials,
 * port, query or IP address, and a hostname that resolves to public
 * addresses only, so a setting can't point the connector at a private
 * network. Every request goes to that address, redirects are never
 * followed, and the keys travel in the Authorization header, never the query
 * string.
 *
 * Hosts and firewalls in front of WooCommerce may answer 429. The client
 * waits with exponential backoff and a little jitter, then hands the error
 * to runSync, which retries the batch from its checkpoint.
 */

export const WOOCOMMERCE_API_PATH = "/wp-json/wc/v3";
/** WordPress caps per_page at 100. */
export const WOOCOMMERCE_PAGE_SIZE = 100;

/** The only endpoints the client reads, with the parameters each may carry. All are GET. */
export const WOOCOMMERCE_ROUTES = {
  orders: { path: "/orders", params: ["page", "per_page", "modified_after", "dates_are_gmt", "orderby", "order", "status"] },
  products: { path: "/products", params: ["page", "per_page", "modified_after", "dates_are_gmt", "orderby", "order", "status"] },
  variations: { path: "/products/{id}/variations", params: ["page", "per_page", "orderby", "order", "status"] },
  customers: { path: "/customers", params: ["page", "per_page", "orderby", "order", "role"] },
  refunds: { path: "/refunds", params: ["page", "per_page", "after", "orderby", "order"] },
} as const satisfies Record<string, { path: string; params: readonly string[] }>;
export type WooCommerceRoute = keyof typeof WOOCOMMERCE_ROUTES;

export interface WooCommerceClientOptions {
  /** The store's address, e.g. https://shop.example.com, or https://example.com/shop when WordPress lives in a folder. */
  storeUrl: string;
  /** A REST API key with Read permission: ck_ followed by 40 hex characters. */
  consumerKey: string;
  /** Its secret: cs_ followed by 40 hex characters. */
  consumerSecret: string;
  fetch?: typeof globalThis.fetch;
  /** The addresses a hostname resolves to; replaced in tests. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** 0 to 1, for backoff jitter; replaced in tests. */
  random?: () => number;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class WooCommerceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WooCommerceConfigError";
  }
}

/** The store answered with an error. `code` is WooCommerce's error code (woocommerce_rest_authentication_error, rest_no_route, ...) when it gives one. */
export class WooCommerceApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "WooCommerceApiError";
    this.status = status;
    this.code = code;
  }
}

export interface WooCommercePage {
  items: Record<string, unknown>[];
  /** X-WP-TotalPages, or null when the store didn't send a readable one. */
  totalPages: number | null;
}

export interface WooCommerceClient {
  /** The checked store address the client is pinned to, without a trailing slash. */
  readonly storeUrl: string;
  /** The store's hostname, which keys its customer references. */
  readonly storeHost: string;
  /** Reads one page of an allowlisted endpoint. `id` fills `{id}` in the path. */
  read(route: WooCommerceRoute, params?: Record<string, string | number | boolean | undefined>, id?: number): Promise<WooCommercePage>;
}

const CONSUMER_KEY = /^ck_[a-f0-9]{40}$/;
const CONSUMER_SECRET = /^cs_[a-f0-9]{40}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]{1,60}$/;
/** Names that only ever mean this machine or a private network. */
const LOCAL_SUFFIXES = ["localhost", "local", "internal", "intranet", "lan", "home", "corp", "arpa"];
const MAX_RETRY_AFTER_S = 60;
const BACKOFF_MS = 1000;

/**
 * Checks WOOCOMMERCE_STORE_URL and returns it normalized (lowercase host, no
 * trailing slash). Never echoes the value, which could hold a pasted key.
 */
export function checkWooCommerceStoreUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) throw new WooCommerceConfigError("set WOOCOMMERCE_STORE_URL to the store's https address");
  if (value.length > 200) throw new WooCommerceConfigError("WOOCOMMERCE_STORE_URL is too long to be a store address");
  if (!/^https:\/\//i.test(value)) {
    throw new WooCommerceConfigError("WOOCOMMERCE_STORE_URL must start with https://; over http WooCommerce keys would travel in the clear");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WooCommerceConfigError("WOOCOMMERCE_STORE_URL is not a web address");
  }
  if (url.protocol !== "https:") throw new WooCommerceConfigError("WOOCOMMERCE_STORE_URL must use https");
  if (url.username || url.password) throw new WooCommerceConfigError("WOOCOMMERCE_STORE_URL must not hold a user name or password");
  if (url.port) throw new WooCommerceConfigError("WOOCOMMERCE_STORE_URL must use the standard https port");
  if (url.search || url.hash || value.includes("?") || value.includes("#")) throw new WooCommerceConfigError("WOOCOMMERCE_STORE_URL must not have a query or fragment; keys never go in the address");
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) throw new WooCommerceConfigError("WOOCOMMERCE_STORE_URL must name the store's hostname, not an IP address");
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !TLD.test(labels[labels.length - 1]!)) {
    throw new WooCommerceConfigError("WOOCOMMERCE_STORE_URL must have a public hostname like shop.example.com");
  }
  if (LOCAL_SUFFIXES.includes(labels[labels.length - 1]!) || labels.includes("localhost")) {
    throw new WooCommerceConfigError("WOOCOMMERCE_STORE_URL names a local or private host; KaratOS reads public stores only");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length > 5 || !segments.every((s) => PATH_SEGMENT.test(s) && s !== "." && s !== "..")) {
    throw new WooCommerceConfigError("WOOCOMMERCE_STORE_URL's path may hold only plain folder names");
  }
  if (segments.some((s) => s.toLowerCase() === "wp-json" || s.toLowerCase() === "wp-admin")) {
    throw new WooCommerceConfigError("WOOCOMMERCE_STORE_URL is the store's home address, without /wp-json or /wp-admin");
  }
  return `https://${host}${segments.length ? `/${segments.join("/")}` : ""}`;
}

/** Parses an IPv6 address into eight 16-bit groups, or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  if (text.length > 45) return null;
  // A trailing dotted IPv4 part becomes two groups.
  const v4 = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4) {
    const parts = v4[1]!.split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    text = `${text.slice(0, v4.index)}:${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/**
 * True for addresses the connector must never reach: loopback, private,
 * link-local, carrier-grade NAT, documentation, multicast and reserved
 * ranges, in IPv4 or IPv6 (mapped and NAT64 forms included). Anything that
 * can't be read counts as private.
 */
export function isPrivateAddress(address: string): boolean {
  if (typeof address !== "string" || address.length > 64) return true;
  const kind = isIP(address.replace(/^\[|\]$/g, "").split("%")[0]!);
  if (kind === 4) return privateIpv4(address);
  if (kind !== 6) return true;
  const g = ipv6Groups(address);
  if (!g) return true;
  const embedded = () => `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateIpv4(embedded()); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateIpv4(embedded()); // 64:ff9b::/96
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1 and the old IPv4-compatible form
  return (
    (g[0]! & 0xfe00) === 0xfc00 || // unique local
    (g[0]! & 0xffc0) === 0xfe80 || // link-local
    (g[0]! & 0xffc0) === 0xfec0 || // site-local
    (g[0]! & 0xff00) === 0xff00 || // multicast
    (g[0] === 0x2001 && g[1] === 0x0db8) || // documentation
    g[0] === 0x2002 || // 6to4, which embeds any IPv4 address
    (g[0] === 0x2001 && g[1] === 0) // Teredo
  );
}

const defaultResolve = async (hostname: string) => (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** WooCommerce's error code and message, cut short. WooCommerce's errors describe the request, never the key. */
function errorOf(body: unknown): { code: string | undefined; message: string | undefined } {
  const b = body as { code?: unknown; message?: unknown } | null;
  const code = typeof b?.code === "string" && b.code.length <= 80 && /^[a-z0-9_]+$/.test(b.code) ? b.code : undefined;
  const message = typeof b?.message === "string" ? b.message.slice(0, 200) : undefined;
  return { code, message };
}

function hint(status: number, code: string | undefined, message: string | undefined): string {
  if (code === "woocommerce_rest_authentication_error" && /read permissions/i.test(message ?? "")) return "; the key can't read: create a key with Read permission";
  if (code === "woocommerce_rest_cannot_view") return "; the key's user can't view this: make the key for an administrator or shop manager, with Read permission";
  if (status === 401) return "; check the consumer key and secret, and that the server passes the Authorization header on to WordPress";
  if (code === "rest_no_route") return "; this WooCommerce is too old for the endpoint: update WooCommerce";
  return "";
}

export function wooCommerceClient(options: WooCommerceClientOptions): WooCommerceClient {
  const storeUrl = checkWooCommerceStoreUrl(options.storeUrl);
  const storeHost = new URL(storeUrl).hostname;
  const key = options.consumerKey?.trim().slice(0, 100) ?? "";
  const secret = options.consumerSecret?.trim().slice(0, 100) ?? "";
  if (!CONSUMER_KEY.test(key)) throw new WooCommerceConfigError("WOOCOMMERCE_CONSUMER_KEY must be the key's ck_ value, 43 characters");
  if (!CONSUMER_SECRET.test(secret)) throw new WooCommerceConfigError("WOOCOMMERCE_CONSUMER_SECRET must be the key's cs_ value, 43 characters");
  const authorization = `Basic ${Buffer.from(`${key}:${secret}`, "utf8").toString("base64")}`;
  const doFetch = options.fetch ?? fetch;
  const resolve = options.resolve ?? defaultResolve;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const retries = options.rateLimitRetries ?? 3;
  const origin = new URL(storeUrl).origin;
  let checked: Promise<void> | null = null;

  /** Resolves the store's hostname once per client and stops if any address is private. */
  function checkAddresses(): Promise<void> {
    checked ??= (async () => {
      let addresses: string[];
      try {
        addresses = await resolve(storeHost);
      } catch {
        throw new WooCommerceApiError("the store's hostname didn't resolve; check WOOCOMMERCE_STORE_URL", 0, "dns_failed");
      }
      if (!addresses.length || addresses.some(isPrivateAddress)) {
        throw new WooCommerceConfigError("WOOCOMMERCE_STORE_URL resolves to a private or local address; KaratOS reads public stores only");
      }
    })().catch((error: unknown) => {
      checked = null;
      throw error;
    });
    return checked;
  }

  async function get(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, { method: "GET", headers: { authorization, accept: "application/json" }, redirect: "manual" });
      if (response.status !== 429) return response;
      if (attempt >= retries) throw new WooCommerceApiError("the store kept rate-limiting the sync; the next run resumes from the checkpoint", 429, "rate_limited");
      const after = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : BACKOFF_MS * 2 ** attempt + Math.floor(random() * BACKOFF_MS));
    }
  }

  return {
    storeUrl,
    storeHost,
    async read(route, params = {}, id) {
      const spec = Object.hasOwn(WOOCOMMERCE_ROUTES, route) ? WOOCOMMERCE_ROUTES[route] : undefined;
      if (!spec) throw new WooCommerceConfigError("the WooCommerce connector only reads its listed endpoints");
      const allowed: readonly string[] = spec.params;
      const unknown = Object.keys(params).filter((k) => !allowed.includes(k));
      if (unknown.length) throw new WooCommerceConfigError(`the WooCommerce connector doesn't send ${unknown.slice(0, 3).join(", ")} to ${spec.path}`);
      let path: string = spec.path;
      if (path.includes("{id}")) {
        if (!Number.isSafeInteger(id) || id! <= 0) throw new WooCommerceConfigError(`${spec.path} needs a numeric id`);
        path = path.replace("{id}", String(id));
      }
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined) continue;
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new WooCommerceConfigError(`${k} must be a plain value`);
        query.set(k, String(v));
      }
      const url = `${storeUrl}${WOOCOMMERCE_API_PATH}${path}${query.toString() ? `?${query}` : ""}`;
      // Pinned: the request goes to the checked store and nowhere else.
      if (new URL(url).origin !== origin) throw new WooCommerceConfigError("the WooCommerce connector only reads the configured store");
      await checkAddresses();
      const response = await get(url);
      if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
        throw new WooCommerceConfigError("the store answered with a redirect; set WOOCOMMERCE_STORE_URL to the store's final https address (redirects aren't followed, so the keys never leave the store)");
      }
      if (!response.ok) {
        const { code, message } = errorOf(await response.json().catch(() => null));
        throw new WooCommerceApiError(`WooCommerce answered HTTP ${response.status}${code ? ` (${code}${message ? `: ${message}` : ""})` : ""}${hint(response.status, code, message)}`, response.status, code);
      }
      const body: unknown = await response.json().catch(() => null);
      if (!Array.isArray(body)) throw new WooCommerceApiError("WooCommerce did not answer with a list", response.status);
      const pages = response.headers.get("x-wp-totalpages") ?? "";
      return {
        items: body.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r)),
        totalPages: /^\d{1,7}$/.test(pages) ? Number(pages) : null,
      };
    },
  };
}
