/**
 * A small client for an Acumatica instance's contract-based REST API (the
 * Default endpoint), which JewelShop runs on, read-only.
 *
 * It signs in with OAuth 2.0's resource owner password flow: a connected
 * application's client ID and secret, made on the Connected Applications
 * form (SM303010), and an Acumatica user made for KaratOS whose role can
 * only view stock items and sales orders. Acumatica can't limit a token to
 * reading, so the role is what keeps it read-only, and the client keeps to
 * the reads itself: it sends one POST for a token, GET requests for stock
 * items and sales orders built from fixed field lists, and a POST to sign
 * out once a pass ends, which frees the API session the license counts.
 *
 * Acumatica's own error text is never put in an error here, only the HTTP
 * status. A 429, or a 500, 502, 503 or 504, is waited out (as long as
 * Retry-After says, up to a minute) a few times before the error goes to
 * runSync, which keeps the checkpoint.
 */

/** Contract versions whose records carry LastModified. */
export const ACUMATICA_ENDPOINT_VERSIONS = ["23.200.001", "24.200.001", "25.100.001", "25.200.001"] as const;
export type AcumaticaEndpointVersion = (typeof ACUMATICA_ENDPOINT_VERSIONS)[number];
export const ACUMATICA_DEFAULT_VERSION: AcumaticaEndpointVersion = "24.200.001";
/** Records asked for on a page. */
export const ACUMATICA_PAGE_SIZE = 500;

/** The two reads, each with the fields it asks for. */
export const ACUMATICA_ENTITIES = {
  StockItem: { select: "InventoryID,Description,ItemClass,ItemStatus,ItemType,BaseUOM,DefaultPrice,LastModified,WarehouseDetails/WarehouseID,WarehouseDetails/QtyOnHand", expand: "WarehouseDetails" },
  SalesOrder: { select: "OrderType,OrderNbr,Status,Date,CurrencyID,OrderTotal,OrderedQty,CustomerID,LastModified", expand: null },
} as const;
export type AcumaticaEntity = keyof typeof ACUMATICA_ENTITIES;

const MAX_RETRY_AFTER_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
const TOKEN_MARGIN_MS = 60_000;
/** A connected application's ID: a GUID, an @ and the tenant. */
const CLIENT_ID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}@[A-Za-z0-9 _-]{1,64}$/;
const SECRET = /^[\x21-\x7e]{8,512}$/;
const USERNAME = /^[\x21-\x7e]{1,128}$/;
const ACCESS_TOKEN = /^[A-Za-z0-9._~+/=-]{16,8192}$/;
/** A UTC time as toISOString writes it. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface AcumaticaClientOptions {
  /** The instance's address, with its path if it isn't at the site root (ACUMATICA_URL). */
  url: string;
  clientId: string;
  /** Sent to the token endpoint only, never logged or shown. */
  clientSecret: string;
  username: string;
  /** Sent to the token endpoint only, never logged or shown. */
  password: string;
  endpointVersion?: string | undefined;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock a token's lifetime is counted on; replaced in tests. */
  now?: () => Date;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class AcumaticaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcumaticaConfigError";
  }
}

export class AcumaticaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AcumaticaApiError";
  }
}

export interface AcumaticaQuery {
  /** Records modified after this UTC time, or every record when null. */
  from: string | null;
  /** And at or before this one. */
  to: string;
  /** Records already read. */
  skip: number;
}

export interface AcumaticaPage {
  records: unknown[];
  /** A later page may hold more. */
  more: boolean;
}

export interface AcumaticaClient {
  readonly baseUrl: string;
  list(entity: AcumaticaEntity, query: AcumaticaQuery): Promise<AcumaticaPage>;
  /** Signs out, if signed in. Never throws. */
  signOut(): Promise<void>;
}

/** The instance's address as https://host[/path], or a config error. */
export function acumaticaBaseUrl(raw: unknown): string {
  const t = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  let u: URL | null = null;
  try {
    u = new URL(t);
  } catch {
    u = null;
  }
  // A name with a dot, not an address. Reading back as its origin and path rules out a user, password, query or hash.
  const ok = u !== null && u.protocol === "https:" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(u.hostname) && !/^[\d.]+$/.test(u.hostname) && `${u.origin}${u.pathname.replace(/\/$/, "")}` === t;
  if (!ok) throw new AcumaticaConfigError("ACUMATICA_URL must be the instance's https address, such as https://example.acumatica.com or https://erp.example.test/Instance");
  return t;
}

/** Acumatica's datetimeoffset literal for a UTC time. */
const literal = (t: string) => `datetimeoffset'${t.replace("Z", "+00:00")}'`;

/** The query string for one page, or a config error before anything is sent. */
export function acumaticaListParams(entity: AcumaticaEntity, query: AcumaticaQuery): URLSearchParams {
  const spec = ACUMATICA_ENTITIES[entity];
  if (!spec) throw new AcumaticaConfigError(`Acumatica reads only ${Object.keys(ACUMATICA_ENTITIES).join(" and ")}`);
  if ((query.from !== null && !TIME.test(query.from)) || !TIME.test(query.to) || (query.from !== null && query.from > query.to)) throw new AcumaticaConfigError("records are listed between two UTC times");
  if (!Number.isSafeInteger(query.skip) || query.skip < 0) throw new AcumaticaConfigError("skip must be a whole number, 0 or more");
  const filter = [...(query.from === null ? [] : [`LastModified gt ${literal(query.from)}`]), `LastModified le ${literal(query.to)}`].join(" and ");
  const params = new URLSearchParams({ $select: spec.select, $filter: filter, $top: String(ACUMATICA_PAGE_SIZE), $skip: String(query.skip) });
  if (spec.expand) params.set("$expand", spec.expand);
  return params;
}

export function acumaticaClient(options: AcumaticaClientOptions): AcumaticaClient {
  const baseUrl = acumaticaBaseUrl(options.url);
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  const username = options.username?.trim() ?? "";
  const password = options.password ?? "";
  if (!CLIENT_ID.test(clientId)) throw new AcumaticaConfigError("ACUMATICA_CLIENT_ID must be the connected application's ID, a GUID, an @ and the tenant");
  if (!SECRET.test(clientSecret)) throw new AcumaticaConfigError("ACUMATICA_CLIENT_SECRET is missing or not in the expected shape");
  if (!USERNAME.test(username)) throw new AcumaticaConfigError("ACUMATICA_USERNAME is missing or not in the expected shape");
  if (password.length === 0 || password.length > 512) throw new AcumaticaConfigError("ACUMATICA_PASSWORD is missing");
  const version = options.endpointVersion?.trim() || ACUMATICA_DEFAULT_VERSION;
  if (!(ACUMATICA_ENDPOINT_VERSIONS as readonly string[]).includes(version)) throw new AcumaticaConfigError(`ACUMATICA_ENDPOINT_VERSION must be one of ${ACUMATICA_ENDPOINT_VERSIONS.join(", ")}`);
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const retries = options.retries ?? 3;
  let token: { value: string; until: number } | null = null;

  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, init);
      if (!RETRIED.has(response.status) || attempt >= retries) return response;
      const after = Number(response.headers.get("retry-after"));
      await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : 1000 * 2 ** attempt);
    }
  }

  async function signIn(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const response = await send(`${baseUrl}/identity/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "password", client_id: clientId, client_secret: clientSecret, username, password, scope: "api" }).toString(),
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) throw new AcumaticaConfigError(`Acumatica turned down the sign-in (HTTP ${response.status}); check ACUMATICA_CLIENT_ID, ACUMATICA_CLIENT_SECRET, ACUMATICA_USERNAME and ACUMATICA_PASSWORD, and that the connected application allows the resource owner password flow`);
    if (response.status !== 200) throw new AcumaticaApiError(`Acumatica sign-in answered HTTP ${response.status}`, response.status);
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const value = body?.access_token;
    if (typeof value !== "string" || !ACCESS_TOKEN.test(value)) throw new AcumaticaApiError("Acumatica sign-in answered without an access token", 200);
    // expires_in is seconds; anything else, or more than a day, counts as already run out.
    const expires = body!.expires_in;
    const seconds = typeof expires === "number" && expires <= 86_400 ? expires : 0;
    token = { value, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return value;
  }

  return {
    baseUrl,
    async list(entity, query) {
      const url = `${baseUrl}/entity/Default/${version}/${entity}?${acumaticaListParams(entity, query)}`;
      for (let signIns = 0; ; signIns++) {
        const bearer = await signIn();
        const response = await send(url, { method: "GET", headers: { authorization: `Bearer ${bearer}`, accept: "application/json" } });
        // A token can end early, as when its session times out; sign in again once.
        if (response.status === 401 && signIns === 0) {
          token = null;
          continue;
        }
        const { status } = response;
        if (status === 401 || status === 403) throw new AcumaticaConfigError(`Acumatica turned down reading ${entity} (HTTP ${status}); give the KaratOS user's role view access to it`);
        if (status !== 200) throw new AcumaticaApiError(`Acumatica answered HTTP ${status} for ${entity}`, status);
        const body: unknown = await response.json().catch(() => null);
        if (!Array.isArray(body)) throw new AcumaticaApiError(`Acumatica answered without a list of ${entity}`, status);
        // There is no count or next link: a full page may have more after it.
        return { records: body, more: body.length === ACUMATICA_PAGE_SIZE };
      }
    },
    async signOut() {
      if (!token) return;
      const bearer = token.value;
      token = null;
      await doFetch(`${baseUrl}/entity/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, accept: "application/json" } }).catch(() => undefined);
    },
  };
}
