/**
 * A small client for Calendly's API v2: the signed-in user, the
 * organization's scheduled events and each event's invitees. Requests carry
 * a personal access token, which Calendly lets the owner limit to scopes
 * when it is made: users:read and scheduled_events:read are all this needs.
 * Calendly can't report a token's scopes, so the client only ever sends the
 * three GETs below, to Calendly's fixed address, and follows pages by token
 * rather than by the next-page URL, so a page link can't send the token
 * anywhere else.
 */

export const CALENDLY_API = "https://api.calendly.com";
/** Rows per page. Calendly's docs give the default (20) but no maximum; 100 is what its own examples go up to. */
export const CALENDLY_PAGE_SIZE = 100;
const MAX_RESET_WAIT_S = 60;
/** Calendly's ids: the last segment of a resource URI. */
export const CALENDLY_UUID = /^[A-Za-z0-9-]{1,64}$/;
const URI = (kind: string) => new RegExp(`^https://api\\.calendly\\.com/${kind}/([A-Za-z0-9-]{1,64})$`);
export const CALENDLY_USER_URI = URI("users");
export const CALENDLY_ORGANIZATION_URI = URI("organizations");

export interface CalendlyClientOptions {
  /** A personal access token. Sent to Calendly only, and never logged or shown. */
  token: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class CalendlyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendlyConfigError";
  }
}

export class CalendlyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CalendlyApiError";
  }
}

export interface CalendlyMe {
  userUri: string;
  organizationUri: string;
}

export interface CalendlyPage {
  collection: unknown[];
  nextPageToken: string | null;
}

/** Whose events to read: the whole organization (needs an owner or admin token) or one user's. */
export type CalendlyScope = { organization: string } | { user: string };

export interface CalendlyClient {
  me(): Promise<CalendlyMe>;
  /** One page of scheduled events starting in [minStart, maxStart), earliest first. */
  scheduledEvents(scope: CalendlyScope, window: { minStart: string; maxStart: string }, pageToken?: string | null): Promise<CalendlyPage>;
  /** One page of an event's invitees, oldest booking first. */
  invitees(eventUuid: string, pageToken?: string | null): Promise<CalendlyPage>;
}

const PAGE_TOKEN = /^[A-Za-z0-9_=+/.-]{1,512}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function calendlyClient(options: CalendlyClientOptions): CalendlyClient {
  if (!/^[A-Za-z0-9._-]{20,4096}$/.test(options.token)) throw new CalendlyConfigError("CALENDLY_ACCESS_TOKEN is missing or not in the expected shape");
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.rateLimitRetries ?? 3;
  const headers = { Authorization: `Bearer ${options.token}`, Accept: "application/json" };

  async function get(path: string, query: Record<string, string>, what: string): Promise<Record<string, unknown>> {
    const url = new URL(path, CALENDLY_API);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { method: "GET", headers });
      if (response.status === 429 && attempt < retries) {
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        await sleep(1000 * (Number.isFinite(reset) && reset > 0 ? Math.min(reset, MAX_RESET_WAIT_S) : 2 ** attempt));
        continue;
      }
      const body = await response.json().catch(() => undefined);
      if (response.status === 401) throw new CalendlyApiError("Calendly turned down the token: check CALENDLY_ACCESS_TOKEN, which may have been revoked", 401);
      if (response.status === 403) {
        const scopes = (body as { required_scopes?: unknown } | undefined)?.required_scopes;
        const named = Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string" && /^[a-z_]{1,40}:(read|write)$/.test(s)) : [];
        throw new CalendlyApiError(named.length ? `Calendly's token is missing the ${named.join(", ")} scope to read ${what}` : `Calendly's token isn't allowed to read ${what}`, 403);
      }
      if (response.status !== 200) throw new CalendlyApiError(`Calendly answered HTTP ${response.status} for ${what}`, response.status);
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new CalendlyApiError(`Calendly answered ${what} with a body that isn't a JSON object`, 200);
      return body as Record<string, unknown>;
    }
  }

  async function page(path: string, query: Record<string, string>, what: string, pageToken: string | null | undefined): Promise<CalendlyPage> {
    if (pageToken != null && !PAGE_TOKEN.test(pageToken)) throw new CalendlyApiError(`Calendly sent a page token for ${what} that isn't in the expected shape`, 200);
    const body = await get(path, { ...query, count: String(CALENDLY_PAGE_SIZE), ...(pageToken ? { page_token: pageToken } : {}) }, what);
    if (!Array.isArray(body.collection)) throw new CalendlyApiError(`Calendly answered ${what} without the collection list`, 200);
    const next = (body.pagination as { next_page_token?: unknown } | undefined)?.next_page_token;
    if (next != null && (typeof next !== "string" || !PAGE_TOKEN.test(next))) throw new CalendlyApiError(`Calendly sent a page token for ${what} that isn't in the expected shape`, 200);
    return { collection: body.collection, nextPageToken: (next as string | null | undefined) ?? null };
  }

  return {
    async me() {
      const resource = (await get("/users/me", {}, "the signed-in user")).resource as Record<string, unknown> | undefined;
      const userUri = resource?.uri;
      const organizationUri = resource?.current_organization;
      if (typeof userUri !== "string" || !CALENDLY_USER_URI.test(userUri) || typeof organizationUri !== "string" || !CALENDLY_ORGANIZATION_URI.test(organizationUri)) {
        throw new CalendlyApiError("Calendly answered the signed-in user without a user and organization that read", 200);
      }
      return { userUri, organizationUri };
    },
    async scheduledEvents(scope, window, pageToken) {
      const owner = "organization" in scope ? { organization: scope.organization } : { user: scope.user };
      if (!("organization" in scope ? CALENDLY_ORGANIZATION_URI.test(scope.organization) : CALENDLY_USER_URI.test(scope.user))) throw new CalendlyApiError("Calendly scope is not a user or organization URI", 0);
      if (!ISO.test(window.minStart) || !ISO.test(window.maxStart)) throw new CalendlyApiError("scheduled events window must be UTC times", 0);
      return page("/scheduled_events", { ...owner, min_start_time: window.minStart, max_start_time: window.maxStart, sort: "start_time:asc" }, "scheduled events", pageToken);
    },
    async invitees(eventUuid, pageToken) {
      if (!CALENDLY_UUID.test(eventUuid)) throw new CalendlyApiError("event id is not a Calendly id", 0);
      return page(`/scheduled_events/${eventUuid}/invitees`, { sort: "created_at:asc" }, "invitees", pageToken);
    },
  };
}
