/**
 * A small client for the Mailchimp Marketing API (3.0). A Mailchimp API key
 * can't be limited to reading, so read-only is enforced here: the client
 * sends GETs of five listed reads only, with parameters it checked, and
 * throws before sending anything else.
 *
 * Every read asks for a fixed list of fields, so names, addresses, phone
 * numbers, merge fields, tags, notes, locations and subject lines never
 * leave Mailchimp. A member's email address comes back only to be turned
 * into a keyed customer reference.
 *
 * Mailchimp allows 10 requests at once per account; the client sends one at
 * a time and waits out a 429 a few times before the error goes to runSync.
 */

/** Mailchimp's largest page. */
export const MAILCHIMP_PAGE_SIZE = 1000;

/** The fields the client asks for on each read, and nothing else. */
export const MAILCHIMP_FIELDS = {
  lists: ["total_items", "lists.id", "lists.name", "lists.date_created", "lists.double_optin", "lists.stats.member_count", "lists.stats.unsubscribe_count", "lists.stats.cleaned_count"],
  members: ["total_items", "members.email_address", "members.status", "members.timestamp_opt", "members.last_changed", "members.member_rating", "members.list_id"],
  campaigns: ["total_items", "campaigns.id", "campaigns.type", "campaigns.status", "campaigns.create_time", "campaigns.send_time", "campaigns.emails_sent", "campaigns.settings.title", "campaigns.recipients.list_id"],
  report: ["id", "campaign_title", "emails_sent", "abuse_reports", "unsubscribed", "send_time", "bounces", "opens", "clicks", "ecommerce"],
} as const;

export type MailchimpRead = "ping" | "lists" | "members" | "campaigns" | "report";

export interface MailchimpQuery {
  /** The audience, for members. */
  listId?: string;
  /** The campaign, for its report. */
  campaignId?: string;
  offset?: number;
  /** Members changed on or after this ISO time. */
  sinceLastChanged?: string;
  /** Campaigns sent on or after this ISO time. */
  sinceSendTime?: string;
}

export interface MailchimpClientOptions {
  /** The account's API key, ending in its data center (e.g. -us21). */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export interface MailchimpClient {
  /** The API host for the key's data center. */
  readonly baseUrl: string;
  get(read: MailchimpRead, query?: MailchimpQuery): Promise<Record<string, unknown>>;
}

export class MailchimpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailchimpConfigError";
  }
}

export class MailchimpApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "MailchimpApiError";
    this.status = status;
  }
}

/** A key is 32 hex characters, a dash and the data center. */
const API_KEY = /^[0-9a-f]{32}-([a-z]{2,4}\d{1,3})$/;
/** List and campaign ids are short letters and digits. */
const ID = /^[A-Za-z0-9]{1,32}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const MAX_RETRY_AFTER_S = 60;
/** Which query each read may take; anything else is turned down before a request is sent. */
const ALLOWED: Record<MailchimpRead, readonly (keyof MailchimpQuery)[]> = {
  ping: [],
  lists: ["offset"],
  members: ["listId", "offset", "sinceLastChanged"],
  campaigns: ["offset", "sinceSendTime"],
  report: ["campaignId"],
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Mailchimp's problem detail, cut short. Error bodies describe the request, never the key. */
function messageOf(body: unknown): string {
  const b = (body ?? {}) as { title?: unknown; detail?: unknown };
  const parts = [b.title, b.detail].filter((m): m is string => typeof m === "string" && m.trim() !== "");
  return parts.join(": ").slice(0, 200);
}

export function mailchimpClient(options: MailchimpClientOptions): MailchimpClient {
  const apiKey = options.apiKey?.trim() ?? "";
  if (!apiKey) throw new MailchimpConfigError("set MAILCHIMP_API_KEY");
  const match = API_KEY.exec(apiKey);
  if (!match) throw new MailchimpConfigError("MAILCHIMP_API_KEY must be a Mailchimp API key, ending in its data center such as -us21");
  const baseUrl = `https://${match[1]}.api.mailchimp.com/3.0`;
  const authorization = `Basic ${Buffer.from(`karatos:${apiKey}`).toString("base64")}`;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;

  function path(read: MailchimpRead, q: MailchimpQuery): string {
    if (!Object.hasOwn(ALLOWED, read)) throw new MailchimpConfigError("the Mailchimp connector only sends its listed reads");
    const extra = (Object.keys(q) as (keyof MailchimpQuery)[]).filter((k) => q[k] !== undefined && !ALLOWED[read].includes(k));
    if (extra.length) throw new MailchimpConfigError(`${read} doesn't take ${extra.join(", ")}`);
    const params = new URLSearchParams();
    if (q.offset !== undefined) {
      if (!Number.isInteger(q.offset) || q.offset < 0) throw new MailchimpConfigError("offset must be a whole number from 0");
      params.set("count", String(MAILCHIMP_PAGE_SIZE));
      params.set("offset", String(q.offset));
    }
    for (const [name, value] of [["since_last_changed", q.sinceLastChanged], ["since_send_time", q.sinceSendTime]] as const) {
      if (value === undefined) continue;
      if (!ISO.test(value) || Number.isNaN(Date.parse(value))) throw new MailchimpConfigError(`${name} must be an ISO time in UTC`);
      params.set(name, value);
    }
    const id = (value: string | undefined, name: string) => {
      if (value === undefined || !ID.test(value)) throw new MailchimpConfigError(`${read} needs a ${name} of letters and digits`);
      return value;
    };
    switch (read) {
      case "ping":
        return "/ping";
      case "lists":
        params.set("fields", MAILCHIMP_FIELDS.lists.join(","));
        return `/lists?${params}`;
      case "members":
        params.set("fields", MAILCHIMP_FIELDS.members.join(","));
        params.set("sort_field", "last_changed");
        params.set("sort_dir", "ASC");
        return `/lists/${id(q.listId, "list id")}/members?${params}`;
      case "campaigns":
        params.set("fields", MAILCHIMP_FIELDS.campaigns.join(","));
        params.set("status", "sent");
        params.set("sort_field", "send_time");
        params.set("sort_dir", "ASC");
        return `/campaigns?${params}`;
      case "report":
        params.set("fields", MAILCHIMP_FIELDS.report.join(","));
        return `/reports/${id(q.campaignId, "campaign id")}?${params}`;
    }
  }

  return {
    baseUrl,
    async get(read, query = {}) {
      const url = `${baseUrl}${path(read, query)}`;
      for (let attempt = 0; ; attempt++) {
        // GET only: the connector never adds, changes or sends anything in Mailchimp.
        const response = await doFetch(url, { method: "GET", headers: { authorization, accept: "application/json" } });
        if (response.status === 429 && attempt < retries) {
          const after = Number(response.headers.get("retry-after"));
          await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : 1000 * 2 ** attempt);
          continue;
        }
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const message = messageOf(body);
          const hint = response.status === 401 ? "; check MAILCHIMP_API_KEY is current" : response.status === 429 ? "; Mailchimp kept rate-limiting the sync" : "";
          throw new MailchimpApiError(`Mailchimp answered HTTP ${response.status} to ${read}${message ? `: ${message}` : ""}${hint}`, response.status);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new MailchimpApiError("Mailchimp did not answer with JSON", response.status);
        return body as Record<string, unknown>;
      }
    },
  };
}
