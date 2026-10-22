/**
 * A small client for HubSpot's CRM API, pinned to the 2026-09 date version.
 * Requests authenticate with a private app or service key access token sent
 * as a Bearer token. Read-only twice over: before its first read the client
 * asks HubSpot which scopes the token holds and refuses to go on if any of
 * them is more than a read scope, and the only requests it sends are the
 * reads below, built and checked here, which throw before anything else
 * leaves the server. Its POSTs are the documented read-only ones: the token
 * info lookup, CRM search and batch association reads.
 *
 * Private apps get 100 requests per 10 seconds (190 on Professional and
 * Enterprise) and a daily allowance per account. Search has its own limit of
 * five requests a second and answers without rate limit headers, so searches
 * are spaced 200 ms apart. Calls go one at a time; a 10-second limit or a 5xx
 * is retried with backoff, and the daily limit stops the sync so it resumes
 * from its checkpoint the next day.
 */

export const HUBSPOT_API_URL = "https://api.hubapi.com";
/** HubSpot's date-based API version. 2026-09 is the latest; 2026-03 keeps working until its end of life. */
export const HUBSPOT_API_VERSION = "2026-09";

/** The CRM objects the connector reads: four records and five kinds of engagement. */
export const HUBSPOT_OBJECTS = ["companies", "contacts", "deals", "tickets", "calls", "emails", "meetings", "notes", "tasks"] as const;
export type HubSpotObject = (typeof HUBSPOT_OBJECTS)[number];
export const HUBSPOT_ENGAGEMENTS = ["calls", "emails", "meetings", "notes", "tasks"] as const satisfies readonly HubSpotObject[];

/**
 * The scopes the token needs. HubSpot's engagement reads (calls, emails,
 * meetings, notes and tasks) come under the contacts scope.
 */
export const HUBSPOT_READ_SCOPES = ["crm.objects.contacts.read", "crm.objects.companies.read", "crm.objects.deals.read", "crm.objects.tickets.read"] as const;

/** Search's largest page, and the most results one search query can page through. */
export const HUBSPOT_SEARCH_PAGE_SIZE = 200;
export const HUBSPOT_SEARCH_CAP = 10_000;
/** The page size for list reads, which the docs give as up to 100. */
export const HUBSPOT_LIST_PAGE_SIZE = 100;
/** Ids per batch association read: HubSpot lowered the limit to 100 in January 2025. */
export const HUBSPOT_ASSOCIATION_BATCH = 100;
/** Search allows five requests a second per account. */
export const HUBSPOT_SEARCH_INTERVAL_MS = 200;

/** The property holding each object's last-modified time. Contacts name theirs differently. */
export const hubSpotModifiedProperty = (object: HubSpotObject) => (object === "contacts" ? "lastmodifieddate" : "hs_lastmodifieddate");

/**
 * The properties the connector asks for, and the only ones it may ask for.
 * None holds an email address, phone number, street address, note, message
 * body, meeting description or call recording.
 */
export const HUBSPOT_PROPERTIES: Record<HubSpotObject, readonly string[]> = {
  companies: ["name", "hs_lastmodifieddate"],
  contacts: ["firstname", "lastname", "lastmodifieddate"],
  deals: ["dealname", "amount", "deal_currency_code", "closedate", "pipeline", "dealstage", "hs_lastmodifieddate"],
  tickets: ["hs_pipeline", "hs_pipeline_stage", "hs_ticket_priority", "hs_lastmodifieddate"],
  calls: ["hs_timestamp", "hs_lastmodifieddate"],
  emails: ["hs_timestamp", "hs_lastmodifieddate"],
  meetings: ["hs_timestamp", "hs_lastmodifieddate"],
  notes: ["hs_timestamp", "hs_lastmodifieddate"],
  tasks: ["hs_timestamp", "hs_lastmodifieddate"],
};

/** The associations read for each object, so deals, tickets and engagements point at their contacts, companies and deals. */
export const HUBSPOT_ASSOCIATIONS: Partial<Record<HubSpotObject, readonly ("contacts" | "companies" | "deals")[]>> = {
  deals: ["contacts", "companies"],
  tickets: ["contacts", "companies"],
  calls: ["contacts", "deals"],
  emails: ["contacts", "deals"],
  meetings: ["contacts", "deals"],
  notes: ["contacts", "deals"],
  tasks: ["contacts", "deals"],
};

export const HUBSPOT_TOKEN_INFO_PATH = "/oauth/v2/private-apps/get/access-token-info";

export interface HubSpotClientOptions {
  /** A private app or service key access token (pat-…). It is only ever sent in the Authorization header, and to the token info lookup. */
  accessToken: string;
  fetch?: typeof globalThis.fetch;
  /** Waits between searches and before retries; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 10-second limit or 5xx is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Milliseconds since the epoch; replaced in tests. */
  clock?: () => number;
}

export class HubSpotConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubSpotConfigError";
  }
}

/** HubSpot answered with an error. `policy` names the rate limit HubSpot says was hit, such as DAILY. */
export class HubSpotApiError extends Error {
  readonly status: number;
  readonly policy: string | undefined;

  constructor(message: string, status: number, policy?: string) {
    super(message);
    this.name = "HubSpotApiError";
    this.status = status;
    this.policy = policy;
  }
}

/** A search body, as the connector builds it with hubSpotSearchBody. The client checks every field again before sending it. */
export interface HubSpotSearchBody {
  filterGroups: { filters: { propertyName: string; operator: string; value: string }[] }[];
  sorts: { propertyName: string; direction: string }[];
  properties: string[];
  limit: number;
  after?: string;
}

export interface HubSpotTokenInfo {
  hubId: number | undefined;
  scopes: string[];
}

export interface HubSpotClient {
  /** The token's account and scopes, checked once: a token with any write scope throws. */
  tokenInfo(): Promise<HubSpotTokenInfo>;
  /** One page of records changed in a time range, oldest change first. Archived records never appear. */
  search(object: HubSpotObject, body: HubSpotSearchBody): Promise<Record<string, unknown>>;
  /** One page of archived (deleted) records. */
  listArchived(object: HubSpotObject, options?: { after?: string }): Promise<Record<string, unknown>>;
  /** The ids of the `to` records each `ids` record is associated with. */
  associations(from: HubSpotObject, to: "contacts" | "companies" | "deals", ids: readonly string[]): Promise<Record<string, unknown>>;
}

const TOKEN = /^pat-[a-z]{2,3}\d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** HubSpot record ids are whole numbers. */
export const HUBSPOT_ID = /^\d{1,20}$/;
/** Search's paging cursor is an offset, below the 10,000 cap. List cursors are opaque tokens. */
const SEARCH_AFTER = /^\d{1,5}$/;
const LIST_AFTER = /^[A-Za-z0-9+/=_-]{1,256}$/;
/** Filter values are millisecond times, as the docs' examples write them. */
const MILLIS = /^\d{1,15}$/;
/** Scopes that only read: crm.objects.contacts.read, sales-email-read and the like. `oauth` only identifies the app. */
const READ_SCOPE = /^(oauth|[a-z0-9]+(?:[._-][a-z0-9]+)*[.-]read)$/;
const MAX_RETRY_AFTER_S = 10;
const RETRIED = new Set([429, 500, 502, 503, 504]);

interface Prepared {
  kind: HubSpotRequestKind;
  method: "GET" | "POST";
  url: string;
  payload: string | undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Scopes beyond reading. Empty means the token can only read. */
export const hubSpotWriteScopes = (scopes: readonly string[]) => scopes.filter((s) => !READ_SCOPE.test(s));

const OBJECTS = HUBSPOT_OBJECTS.join("|");
const TO = "contacts|companies|deals";

/** Every request the client may send, by method and path. Nothing else leaves the server. */
export const HUBSPOT_ALLOWED_REQUESTS = [
  { kind: "token_info", method: "POST", path: new RegExp(`^${HUBSPOT_TOKEN_INFO_PATH.replace(/\//g, "\\/")}$`) },
  { kind: "list", method: "GET", path: new RegExp(`^/crm/objects/${HUBSPOT_API_VERSION}/(${OBJECTS})$`) },
  { kind: "search", method: "POST", path: new RegExp(`^/crm/objects/${HUBSPOT_API_VERSION}/(${OBJECTS})/search$`) },
  { kind: "associations", method: "POST", path: new RegExp(`^/crm/associations/${HUBSPOT_API_VERSION}/(${OBJECTS})/(${TO})/batch/read$`) },
] as const;
export type HubSpotRequestKind = (typeof HUBSPOT_ALLOWED_REQUESTS)[number]["kind"];

/** The query parameters a list read may carry, archived reads only. */
const LIST_QUERY = new Set(["archived", "limit", "properties", "after"]);

/**
 * Which allowed request a method and URL is, or null when it isn't one.
 * Only HubSpot's API host, only the paths above, and for list reads only
 * archived ones with the parameters the client sets.
 */
export function hubSpotRequestKind(method: string, url: string): HubSpotRequestKind | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== HUBSPOT_API_URL || parsed.username || parsed.password || parsed.hash) return null;
  const allowed = HUBSPOT_ALLOWED_REQUESTS.find((r) => r.method === method && r.path.test(parsed.pathname));
  if (!allowed) return null;
  const keys = [...parsed.searchParams.keys()];
  if (allowed.kind !== "list") return keys.length === 0 ? allowed.kind : null;
  if (keys.some((k) => !LIST_QUERY.has(k)) || new Set(keys).size !== keys.length || parsed.searchParams.get("archived") !== "true") return null;
  return allowed.kind;
}

const exactKeys = (value: unknown, keys: readonly string[], optional: readonly string[] = []) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  keys.every((k) => Object.hasOwn(value, k)) &&
  Object.keys(value).every((k) => keys.includes(k) || optional.includes(k));

/**
 * Checks a search body is one the connector builds: a single filter group
 * holding a last-modified range (on or after one time, before another),
 * sorted oldest first, asking only for the connector's own properties, a
 * page of up to 200, and an offset under the 10,000 cap. Anything else,
 * a free-text query or another filter, throws.
 */
export function checkHubSpotSearchBody(object: HubSpotObject, body: unknown): HubSpotSearchBody {
  const refuse = (why: string): never => {
    throw new HubSpotConfigError(`the HubSpot connector only searches by last-modified time (${why})`);
  };
  if (!exactKeys(body, ["filterGroups", "sorts", "properties", "limit"], ["after"])) refuse("unexpected fields");
  const b = body as HubSpotSearchBody;
  const modified = hubSpotModifiedProperty(object);
  if (!Array.isArray(b.filterGroups) || b.filterGroups.length !== 1 || !exactKeys(b.filterGroups[0], ["filters"])) refuse("one filter group");
  const filters = b.filterGroups[0]!.filters;
  if (!Array.isArray(filters) || filters.length !== 2) refuse("two filters");
  const [gte, lt] = filters;
  for (const [filter, operator] of [
    [gte, "GTE"],
    [lt, "LT"],
  ] as const) {
    if (!filter || !exactKeys(filter, ["propertyName", "operator", "value"]) || filter.propertyName !== modified || filter.operator !== operator) refuse(`${operator} on ${modified}`);
    if (typeof filter!.value !== "string" || !MILLIS.test(filter!.value)) refuse("millisecond times");
  }
  if (Number(gte!.value) >= Number(lt!.value)) refuse("an empty range");
  if (!Array.isArray(b.sorts) || b.sorts.length !== 1 || !exactKeys(b.sorts[0], ["propertyName", "direction"]) || b.sorts[0]!.propertyName !== modified || b.sorts[0]!.direction !== "ASCENDING") {
    refuse(`sorted by ${modified}, oldest first`);
  }
  const allowed = HUBSPOT_PROPERTIES[object];
  if (!Array.isArray(b.properties) || b.properties.length === 0 || b.properties.some((p) => typeof p !== "string" || !allowed.includes(p))) refuse("its own properties");
  if (!Number.isInteger(b.limit) || b.limit < 1 || b.limit > HUBSPOT_SEARCH_PAGE_SIZE) refuse(`pages of 1 to ${HUBSPOT_SEARCH_PAGE_SIZE}`);
  if (b.after !== undefined && (typeof b.after !== "string" || !SEARCH_AFTER.test(b.after) || Number(b.after) + b.limit > HUBSPOT_SEARCH_CAP)) {
    refuse(`an offset within the first ${HUBSPOT_SEARCH_CAP} results`);
  }
  return b;
}

/** HubSpot's message for an error, cut short. Error bodies describe the request, never the token. */
function errorOf(body: unknown): { message?: string; category?: string; policy?: string } {
  const b = (body ?? {}) as { message?: unknown; category?: unknown; policyName?: unknown };
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const out: { message?: string; category?: string; policy?: string } = {};
  const message = text(b.message, 200);
  const category = text(b.category, 60);
  const policy = text(b.policyName, 40);
  if (message) out.message = message;
  if (category) out.category = category;
  if (policy) out.policy = policy;
  return out;
}

/** Hints for the errors an owner can fix. */
const HINTS: Record<number, string> = {
  401: "; check HUBSPOT_ACCESS_TOKEN, which may have been rotated or revoked",
  403: `; the token needs ${HUBSPOT_READ_SCOPES.join(", ")}`,
};

export function hubSpotClient(options: HubSpotClientOptions): HubSpotClient {
  const token = options.accessToken?.trim() ?? "";
  if (!token) throw new HubSpotConfigError("set HUBSPOT_ACCESS_TOKEN");
  if (!TOKEN.test(token)) throw new HubSpotConfigError("HUBSPOT_ACCESS_TOKEN must be a private app or service key access token (pat-…)");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  const clock = options.clock ?? (() => Date.now());
  let checked: Promise<HubSpotTokenInfo> | null = null;
  let lastSearch = Number.NEGATIVE_INFINITY;

  /**
   * Checks one request against the allowlist and returns what to send. The
   * method, URL and body are checked here, whoever built them, and before
   * anything at all is sent, the token lookup included.
   */
  function prepare(method: "GET" | "POST", path: string, body?: unknown): Prepared {
    const url = `${HUBSPOT_API_URL}${path}`;
    const kind = hubSpotRequestKind(method, url);
    // The URL must say exactly what was built: no dot segments or encodings that resolve to another path.
    const parsed = new URL(url);
    if (!kind || `${parsed.pathname}${parsed.search}` !== path) throw new HubSpotConfigError("the HubSpot connector only sends its listed reads");
    // A list read has no body; every POST has its checked one.
    if ((kind === "list") !== (body === undefined)) throw new HubSpotConfigError("the HubSpot connector only sends its listed reads");
    if (kind === "search") checkHubSpotSearchBody(/^\/crm\/objects\/[^/]+\/([a-z]+)\/search$/.exec(parsed.pathname)![1] as HubSpotObject, body);
    if (kind === "associations") checkAssociationsBody(body);
    if (kind === "token_info" && !(exactKeys(body, ["tokenKey"]) && (body as { tokenKey: unknown }).tokenKey === token)) {
      throw new HubSpotConfigError("the token info lookup only sends the connector's own token");
    }
    return { kind, method, url, payload: body === undefined ? undefined : JSON.stringify(body) };
  }

  async function send({ kind, method, url, payload }: Prepared): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      if (kind === "search") {
        // Search's own limit is five a second, and its answers carry no rate limit headers to go by.
        const wait = lastSearch + HUBSPOT_SEARCH_INTERVAL_MS - clock();
        if (wait > 0) await sleep(wait);
        lastSearch = clock();
      }
      // The token goes in the Authorization header only, never the URL.
      const response = await doFetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(payload === undefined ? {} : { "content-type": "application/json" }) },
        ...(payload === undefined ? {} : { body: payload }),
      });
      const parsed: unknown = await response.json().catch(() => null);
      if (RETRIED.has(response.status)) {
        const { policy } = errorOf(parsed);
        if (policy === "DAILY") {
          throw new HubSpotApiError("HubSpot's daily API limit for this account is used up; the next sync resumes from the checkpoint", 429, policy);
        }
        if (attempt < retries) {
          // HubSpot documents no Retry-After; honor one if it comes, else back off.
          const after = Number(response.headers?.get("retry-after"));
          await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : 1000 * 2 ** attempt);
          continue;
        }
        throw new HubSpotApiError(`HubSpot kept answering HTTP ${response.status}${policy ? ` (${policy})` : ""}`, response.status, policy);
      }
      if (!response.ok) {
        const { message, category } = errorOf(parsed);
        const hint = Object.hasOwn(HINTS, response.status) ? HINTS[response.status] : "";
        throw new HubSpotApiError(`HubSpot answered HTTP ${response.status} to a ${kind} read${category ? ` (${category}${message ? `: ${message}` : ""})` : message ? `: ${message}` : ""}${hint}`, response.status);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HubSpotApiError("HubSpot did not answer with JSON", response.status);
      return parsed as Record<string, unknown>;
    }
  }

  async function lookUpToken(): Promise<HubSpotTokenInfo> {
    const body = await send(prepare("POST", HUBSPOT_TOKEN_INFO_PATH, { tokenKey: token }));
    if (!Array.isArray(body.scopes)) throw new HubSpotConfigError("HubSpot didn't say which scopes the token holds, so the connector can't confirm it only reads");
    const scopes = body.scopes.filter((s): s is string => typeof s === "string");
    const extra = hubSpotWriteScopes(scopes);
    if (extra.length || scopes.length !== body.scopes.length) {
      throw new HubSpotConfigError(`the HubSpot token can change data (${extra.slice(0, 5).join(", ") || "unreadable scopes"}); give the private app only ${HUBSPOT_READ_SCOPES.join(" ")}`);
    }
    const missing = HUBSPOT_READ_SCOPES.filter((s) => !scopes.includes(s));
    if (missing.length) throw new HubSpotConfigError(`the HubSpot token is missing ${missing.join(", ")}`);
    return { hubId: typeof body.hubId === "number" ? body.hubId : undefined, scopes };
  }

  /** Every read waits for the scope check; a failed check is tried again next time rather than remembered. */
  function tokenInfo(): Promise<HubSpotTokenInfo> {
    checked ??= lookUpToken().catch((error: unknown) => {
      checked = null;
      throw error;
    });
    return checked;
  }

  return {
    tokenInfo,
    async search(object, body) {
      const request = prepare("POST", `/crm/objects/${HUBSPOT_API_VERSION}/${object}/search`, body);
      await tokenInfo();
      return send(request);
    },
    async listArchived(object, opts = {}) {
      const query = new URLSearchParams({ archived: "true", limit: String(HUBSPOT_LIST_PAGE_SIZE), properties: (HUBSPOT_PROPERTIES[object] ?? []).join(",") });
      if (opts.after !== undefined) {
        if (typeof opts.after !== "string" || !LIST_AFTER.test(opts.after)) throw new HubSpotConfigError("after must be HubSpot's paging token");
        query.set("after", opts.after);
      }
      const request = prepare("GET", `/crm/objects/${HUBSPOT_API_VERSION}/${object}?${query.toString()}`);
      await tokenInfo();
      return send(request);
    },
    async associations(from, to, ids) {
      if (!HUBSPOT_ASSOCIATIONS[from]?.includes(to)) throw new HubSpotConfigError(`the HubSpot connector doesn't read ${from} to ${to} associations`);
      const request = prepare("POST", `/crm/associations/${HUBSPOT_API_VERSION}/${from}/${to}/batch/read`, { inputs: ids.map((id) => ({ id })) });
      await tokenInfo();
      return send(request);
    },
  };
}

/** A batch association read: 1 to 100 record ids and nothing else. */
function checkAssociationsBody(body: unknown): void {
  const inputs = (body as { inputs?: unknown } | null)?.inputs;
  if (
    !exactKeys(body, ["inputs"]) ||
    !Array.isArray(inputs) ||
    inputs.length < 1 ||
    inputs.length > HUBSPOT_ASSOCIATION_BATCH ||
    !inputs.every((i) => exactKeys(i, ["id"]) && typeof (i as { id: unknown }).id === "string" && HUBSPOT_ID.test((i as { id: string }).id))
  ) {
    throw new HubSpotConfigError(`an association read takes 1 to ${HUBSPOT_ASSOCIATION_BATCH} record ids`);
  }
}
