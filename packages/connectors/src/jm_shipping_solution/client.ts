import { WHATNOT_USER_AGENT } from "../whatnot/client.js";

/**
 * A small client for the JM Shipping Solution API from Jewelers Mutual, the
 * insured shipping service a store buys labels and parcel insurance from.
 * JM issues each integrator a key and a password: every request carries the
 * key in the `API_KEY` header and the pair as HTTP Basic credentials in the
 * `Authorization` header. JM documents no scopes, so the credentials can do
 * everything the API offers, buying labels and filing claims included.
 * Read-only is enforced here, in code: the client sends GET requests to five
 * read endpoints, with paths it builds itself, and has no way to send
 * anything else.
 *
 * JM documents only its UAT host, `uat2.transguardian.com`, and gives the
 * production host with the credentials, so the host is a setting that must
 * be on transguardian.com. JM answers a bad request, and credentials it
 * doesn't accept, with 400, and documents no rate limit; a 429 or 5xx is
 * retried with backoff before the error goes to runSync.
 */

/** The only host JM's docs give: its UAT environment. */
export const JM_SHIPPING_UAT_BASE = "https://uat2.transguardian.com";
/** Every request carries the same User-Agent as the other connectors. */
export const JM_SHIPPING_USER_AGENT = WHATNOT_USER_AGENT;
/** Shipment GUIDs sent in one comma-delimited request; JM documents no limit. */
export const JM_SHIPPING_IDS_PER_REQUEST = 20;

const GUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const CLIENT_ID = /^[1-9][0-9]{0,9}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PASSWORD_MAX = 256;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
const MISSING = Symbol("missing");
const SETTINGS = "JM_SHIPPING_API_KEY and JM_SHIPPING_PASSWORD must be the key and password JM issued the store, for the host in JM_SHIPPING_API_BASE";

export interface JmShippingClientOptions {
  /** The key JM issued, a GUID. It is never logged or shown. */
  apiKey: string;
  /** The password JM issued with the key. It is never logged or shown. */
  password: string;
  /** The store's JM client id, a whole number. */
  clientId: string;
  /** The API host JM gave with the credentials; JM's UAT host when unset. */
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class JmShippingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JmShippingConfigError";
  }
}

/** JM answered with an error, or with something that doesn't read. */
export class JmShippingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JmShippingApiError";
  }
}

/** What JM answers for one shipment's claim: the body of a 200, or null for a 404. */
export type JmShippingClaimAnswer = { Claim?: unknown; Error?: unknown } | null;

export interface JmShippingClient {
  /** The GUIDs of the store's shipments between two days, as JM lists them. */
  shipmentGids(from: string, to: string): Promise<unknown[]>;
  /** The details of up to JM_SHIPPING_IDS_PER_REQUEST shipments. */
  shipments(gids: readonly string[]): Promise<unknown[]>;
  /** The latest tracking event of up to JM_SHIPPING_IDS_PER_REQUEST shipments. */
  tracking(gids: readonly string[]): Promise<unknown[]>;
  /** A shipment's claim. */
  claim(gid: string): Promise<JmShippingClaimAnswer>;
  /** The store's reconciled shipments between two days. */
  reconciled(from: string, to: string): Promise<unknown[]>;
}

export const isJmShippingGid = (v: unknown): v is string => typeof v === "string" && GUID.test(v);

/** A YYYY-MM-DD day that is a real day. */
export const isJmShippingDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** The API host as an origin, or a config error: https on transguardian.com, with no path, query or credentials. */
export function jmShippingBase(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value === "") return JM_SHIPPING_UAT_BASE;
  const problem = new JmShippingConfigError("JM_SHIPPING_API_BASE must be the https address of a JM Shipping Solution host on transguardian.com, such as https://uat2.transguardian.com, with no path");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw problem;
  }
  // URL lowercases the host already.
  const host = url.hostname;
  const onJm = host === "transguardian.com" || host.endsWith(".transguardian.com");
  if (url.protocol !== "https:" || !onJm || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw problem;
  return url.origin;
}

/** JM's error text, with the key and password masked, cut short. */
function detail(body: unknown, secrets: readonly string[]): string {
  const b = (typeof body === "object" && body !== null ? body : {}) as { Message?: unknown; ErrorMessage?: unknown; Error?: unknown };
  const first = Array.isArray(b.Error) ? (b.Error[0] as { ErrorMessage?: unknown } | undefined) : undefined;
  const said = [b.Message, b.ErrorMessage, first?.ErrorMessage].find((v): v is string => typeof v === "string" && v.trim() !== "") ?? "";
  let text = said.trim().replace(/\s+/g, " ");
  for (const secret of secrets) text = text.split(secret).join("***");
  text = text.slice(0, 200);
  return text ? `: ${text}` : "";
}

/** The errors in JM's Error list, when it has any. */
export function jmShippingErrors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((e) => {
    const o = (typeof e === "object" && e !== null ? e : {}) as { ErrorCode?: unknown; ErrorMessage?: unknown };
    const code = typeof o.ErrorCode === "string" || typeof o.ErrorCode === "number" ? String(o.ErrorCode).slice(0, 20) : "";
    const message = typeof o.ErrorMessage === "string" ? o.ErrorMessage.trim().slice(0, 200) : "";
    return [code, message].filter(Boolean).join(" ") || "an error without a message";
  });
}

export function jmShippingClient(options: JmShippingClientOptions): JmShippingClient {
  const key = options.apiKey?.trim() ?? "";
  if (!GUID.test(key)) throw new JmShippingConfigError("set JM_SHIPPING_API_KEY to the key JM issued the store, a GUID such as 00000000-0000-0000-0000-000000000000");
  const password = options.password?.trim() ?? "";
  // The pattern needs one character at least, so an empty password fails it.
  if (password.length > PASSWORD_MAX || !/^[ -~]+$/.test(password)) {
    throw new JmShippingConfigError(`set JM_SHIPPING_PASSWORD to the password JM issued with the key: 1 to ${PASSWORD_MAX} printable ASCII characters`);
  }
  const clientId = options.clientId?.trim() ?? "";
  if (!CLIENT_ID.test(clientId)) throw new JmShippingConfigError("set JM_SHIPPING_CLIENT_ID to the store's JM client id, a whole number from 1 to 9999999999");
  const base = jmShippingBase(options.apiBase);
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  const headers = {
    accept: "application/json",
    authorization: `Basic ${Buffer.from(`${key}:${password}`, "utf8").toString("base64")}`,
    API_KEY: key,
    "user-agent": JM_SHIPPING_USER_AGENT,
  };
  const secrets = [key, password, headers.authorization.slice("Basic ".length)];

  /** One GET; a 404 is MISSING when `missingOk`. */
  async function get(path: string, what: string, missingOk = false): Promise<unknown> {
    const url = `${base}${path}`;
    for (let attempt = 0; ; attempt++) {
      // GET only, with the credentials in headers and never in the URL.
      let response: Response;
      try {
        response = await doFetch(url, { method: "GET", headers });
      } catch {
        throw new JmShippingApiError(`JM Shipping Solution could not be reached for the ${what}`, 0);
      }
      if (RETRIED.has(response.status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isSafeInteger(after) && after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const body: unknown = await response.json().catch(() => null);
      const text = detail(body, secrets);
      if (response.status === 401 || response.status === 403) {
        throw new JmShippingConfigError(`JM Shipping Solution turned down the credentials (HTTP ${response.status})${text}; ${SETTINGS}`);
      }
      if (response.status === 400) throw new JmShippingApiError(`JM Shipping Solution answered HTTP 400 for the ${what}${text}; JM gives 400 for a bad request and for credentials it doesn't accept, so check that ${SETTINGS}, and that JM_SHIPPING_CLIENT_ID is the store's`, 400);
      if (response.status === 404 && missingOk) return MISSING;
      if (response.status !== 200) throw new JmShippingApiError(`JM Shipping Solution answered HTTP ${response.status} for the ${what}${text}`, response.status);
      return body;
    }
  }

  const days = (from: string, to: string) => {
    if (!isJmShippingDay(from) || !isJmShippingDay(to) || from > to) throw new JmShippingApiError("a date range must be two YYYY-MM-DD days, the first not after the second", 0);
    return `${from}/${to}`;
  };
  const ids = (gids: readonly string[]) => {
    if (gids.length === 0 || gids.length > JM_SHIPPING_IDS_PER_REQUEST || !gids.every(isJmShippingGid)) throw new JmShippingApiError(`a request takes 1 to ${JM_SHIPPING_IDS_PER_REQUEST} shipment GUIDs JM gave`, 0);
    return gids.join(",");
  };
  const array = async (path: string, what: string) => {
    const body = await get(path, what);
    if (!Array.isArray(body)) throw new JmShippingApiError(`JM Shipping Solution answered the ${what} without a list`, 200);
    return body;
  };

  return {
    async shipmentGids(from, to) {
      const body = await get(`/api/v1/shipment/list/${clientId}/${days(from, to)}`, "shipment list");
      const b = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : null) as { ShipmentGids?: unknown; Error?: unknown } | null;
      if (!b) throw new JmShippingApiError("JM Shipping Solution answered the shipment list without an object", 200);
      const errors = jmShippingErrors(b.Error);
      if (errors.length > 0) throw new JmShippingApiError(`JM Shipping Solution answered the shipment list with an error: ${errors.join("; ")}`, 200);
      if (b.ShipmentGids === undefined || b.ShipmentGids === null) return [];
      if (!Array.isArray(b.ShipmentGids)) throw new JmShippingApiError("JM Shipping Solution answered the shipment list without a list of GUIDs", 200);
      return b.ShipmentGids;
    },
    shipments: async (gids) => array(`/api/v1/shipment/${ids(gids)}`, "shipments"),
    tracking: async (gids) => array(`/api/v1/shipment/track/latest/${ids(gids)}`, "tracking"),
    async claim(gid) {
      if (!isJmShippingGid(gid)) throw new JmShippingApiError("a claim is read by a shipment GUID JM gave", 0);
      const body = await get(`/api/v1/claim/${gid}`, "claim", true);
      if (body === MISSING) return null;
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new JmShippingApiError("JM Shipping Solution answered the claim without an object", 200);
      return body as JmShippingClaimAnswer;
    },
    reconciled: async (from, to) => array(`/api/v1/shipment/reconciliation/${clientId}/${days(from, to)}`, "reconciled shipments"),
  };
}
