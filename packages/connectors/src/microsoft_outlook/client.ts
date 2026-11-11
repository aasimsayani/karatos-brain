/**
 * A small client for one Exchange Online mailbox through Microsoft Graph
 * (v1.0): the delta of its Inbox and Sent Items and of its calendar view.
 * It signs in as the app itself, with the client credentials grant, and
 * sends only these requests:
 *
 * - `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`;
 * - `GET /users/{mailbox}/mailFolders/{inbox|sentitems}/messages/delta`;
 * - `GET /users/{mailbox}/calendarView/delta`.
 *
 * The app is meant to hold Exchange's `Application Mail.ReadBasic` and
 * `Application Calendars.Read` roles, scoped to the one mailbox through
 * RBAC for Applications, and no Entra consent for mail at all. Mail.ReadBasic
 * leaves out every message's body, preview, attachments and extended
 * properties, so they can't be read even by mistake; the subject is asked
 * for by nobody. When the token says which application permissions it
 * carries, the client stops if any isn't one of the read permissions below.
 *
 * Graph's paging links are never fetched as given: the client reads the
 * skip or delta token out of each one and builds the next request itself,
 * so a link can't send it, or its token, anywhere else.
 */
import { MICROSOFT_GRAPH, MICROSOFT_LOGIN, MicrosoftApiError, MicrosoftConfigError, microsoftGuid, microsoftTokenRoles } from "../microsoft_onedrive/client.js";

/** The application permissions a token may carry: ones that read mail without bodies, or calendars, and nothing more. */
export const OUTLOOK_READ_ROLES = ["Mail.ReadBasic", "Mail.ReadBasic.All", "Calendars.ReadBasic", "Calendars.ReadBasic.All", "Calendars.Read"] as const;
/** The message fields asked for. The subject, body, preview, categories and flags are never asked for. */
export const OUTLOOK_MESSAGE_SELECT = "id,conversationId,receivedDateTime,sentDateTime,from,toRecipients,ccRecipients,hasAttachments,importance,isDraft";
export const OUTLOOK_FOLDERS = ["inbox", "sentitems"] as const;
export type OutlookFolder = (typeof OUTLOOK_FOLDERS)[number];
/** Items Graph is asked to put on a page. */
export const OUTLOOK_PAGE_SIZE = 100;
/** A new token is asked for this long before the current one ends. */
const TOKEN_MARGIN_MS = 5 * 60_000;
const MAX_WAIT_S = 60;
/** A mailbox: its object id, or its address. */
const MAILBOX_ADDRESS = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;
/** A skip or delta token, as Graph puts it in its paging links. */
export const OUTLOOK_STATE_TOKEN = /^[A-Za-z0-9_.~=+/-]{1,8192}$/;
const ACCESS_TOKEN = /^[\x21-\x7e]{1,16384}$/;
/** A UTC time as toISOString writes it. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface OutlookClientOptions {
  /** The directory (tenant) id (MICROSOFT_TENANT_ID). */
  tenantId: string;
  /** The Outlook app's client id (MICROSOFT_OUTLOOK_CLIENT_ID). */
  clientId: string;
  /** The Outlook app's client secret (MICROSOFT_OUTLOOK_CLIENT_SECRET). Sent to Microsoft only. */
  clientSecret: string;
  /** The mailbox to read (MICROSOFT_OUTLOOK_MAILBOX): its address or object id. */
  mailbox: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429, 503 or 504 is retried here before the error goes to runSync. */
  retries?: number;
  now?: () => Date;
}

/** Graph's place in a listing: the next page of a round (skip) or the start of the next round (delta). */
export interface OutlookState {
  kind: "skip" | "delta";
  token: string;
}

export interface OutlookPage {
  items: Record<string, unknown>[];
  /** A skip state while the round goes on, a delta state at its end. */
  next: OutlookState;
}

/** Graph wants the listing read again from the start (410 Gone). */
export class OutlookResyncError extends MicrosoftApiError {
  constructor(code?: string) {
    super("Microsoft Graph asked for the mailbox to be read again from the start", 410, code);
    this.name = "OutlookResyncError";
  }
}

export interface OutlookClient {
  /** One page of a folder's message delta: from `since` when `state` is null. */
  messages(folder: OutlookFolder, state: OutlookState | null, since: string): Promise<OutlookPage>;
  /** One page of the calendar view's delta between `start` and `end`, when `state` is null. */
  events(state: OutlookState | null, start: string, end: string): Promise<OutlookPage>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** MICROSOFT_OUTLOOK_MAILBOX, lowercased, or undefined when it is neither an address nor an object id. */
export function outlookMailbox(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return microsoftGuid(v) ?? (MAILBOX_ADDRESS.test(v) ? v : undefined);
}

/**
 * The state in one of Graph's paging links, or undefined unless the link is
 * a user's delta (`suffix`) on Graph and carries one token. The link is
 * never fetched, so which user it names doesn't matter: Graph may name the
 * mailbox by its address or its object id.
 */
export function outlookStateOf(link: unknown, suffix: string): OutlookState | undefined {
  if (typeof link !== "string" || link.length > 10_000) return undefined;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.origin !== new URL(MICROSOFT_GRAPH).origin || url.username || url.password || url.hash) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return undefined;
  }
  // Graph writes the folder as mailFolders/{id} or mailFolders('{id}'), so only the ends are checked.
  if (!path.startsWith("/v1.0/users") || !path.endsWith(suffix)) return undefined;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || (keys[0] !== "$skiptoken" && keys[0] !== "$deltatoken")) return undefined;
  const token = url.searchParams.get(keys[0])!;
  return OUTLOOK_STATE_TOKEN.test(token) ? { kind: keys[0] === "$skiptoken" ? "skip" : "delta", token } : undefined;
}

export function outlookClient(options: OutlookClientOptions): OutlookClient {
  const tenant = microsoftGuid(options.tenantId);
  const clientId = microsoftGuid(options.clientId);
  const mailbox = outlookMailbox(options.mailbox);
  const secret = options.clientSecret?.trim() ?? "";
  if (!tenant) throw new MicrosoftConfigError("MICROSOFT_TENANT_ID is missing or not a directory (tenant) id");
  if (!clientId) throw new MicrosoftConfigError("MICROSOFT_OUTLOOK_CLIENT_ID is missing or not an application (client) id");
  if (!/^[\x21-\x7e]{16,256}$/.test(secret)) throw new MicrosoftConfigError("MICROSOFT_OUTLOOK_CLIENT_SECRET is missing or not in the expected shape");
  if (!mailbox) throw new MicrosoftConfigError("MICROSOFT_OUTLOOK_MAILBOX is missing or not a mailbox address or object id");
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = options.retries ?? 3;
  const now = options.now ?? (() => new Date());
  const base = `${MICROSOFT_GRAPH}/users/${encodeURIComponent(mailbox)}`;
  let token: { value: string; until: number } | null = null;

  async function signIn(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const body = new URLSearchParams({ client_id: clientId!, client_secret: secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
    const response = await fetch(`${MICROSOFT_LOGIN}/${tenant}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
    const reply: unknown = await response.json().catch(() => undefined);
    if (response.status !== 200) {
      const codes = isObject(reply) && Array.isArray(reply.error_codes) ? reply.error_codes : [];
      if (codes.includes(7000215) || codes.includes(7000222)) throw new MicrosoftConfigError("Microsoft turned down MICROSOFT_OUTLOOK_CLIENT_SECRET: it may have expired or been deleted. Add a new client secret to the app and save it");
      if (codes.includes(700016)) throw new MicrosoftConfigError("Microsoft has no app with MICROSOFT_OUTLOOK_CLIENT_ID in this tenant");
      if (codes.includes(90002)) throw new MicrosoftConfigError("Microsoft has no tenant with MICROSOFT_TENANT_ID");
      throw new MicrosoftApiError(`Microsoft answered HTTP ${response.status} to the sign-in`, response.status);
    }
    if (!isObject(reply) || typeof reply.access_token !== "string" || !ACCESS_TOKEN.test(reply.access_token)) throw new MicrosoftApiError("Microsoft's sign-in had no access token in the expected shape", 200);
    // A token that says it can do more than read is never used.
    const extra = (microsoftTokenRoles(reply.access_token) ?? []).filter((r) => !(OUTLOOK_READ_ROLES as readonly string[]).includes(r));
    if (extra.length > 0) throw new MicrosoftConfigError(`the app has ${extra.slice(0, 5).join(", ")}; KaratOS only reads, so give it Application Mail.ReadBasic and Application Calendars.Read for the mailbox and nothing else`);
    const seconds = Number.isFinite(reply.expires_in) ? (reply.expires_in as number) : 0;
    token = { value: reply.access_token, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return token.value;
  }

  async function page(url: URL, what: string, suffix: string): Promise<OutlookPage> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      // GET only, with immutable ids so a message keeps its id when it moves.
      const response = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${await signIn()}`, Accept: "application/json", Prefer: `IdType="ImmutableId", odata.maxpagesize=${OUTLOOK_PAGE_SIZE}` } });
      const { status } = response;
      if (status === 401 && !refreshed) {
        refreshed = true;
        token = null;
        attempt--;
        continue;
      }
      if ((status === 429 || status === 503 || status === 504) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(after > 0 ? 1000 * Math.min(after, MAX_WAIT_S) : 1000 * 2 ** attempt);
        continue;
      }
      const reply: unknown = await response.json().catch(() => undefined);
      const raw = (reply as { error?: { code?: unknown } } | undefined)?.error?.code;
      const code = typeof raw === "string" && /^[A-Za-z]{1,80}$/.test(raw) ? raw : undefined;
      if (status === 410) throw new OutlookResyncError(code);
      if (status === 401) throw new MicrosoftApiError("Microsoft Graph turned down the app's token twice", 401, code);
      if (status === 403) throw new MicrosoftConfigError(`the app isn't allowed to read the mailbox's ${what}: assign it Application ${what === "mail" ? "Mail.ReadBasic" : "Calendars.Read"} for MICROSOFT_OUTLOOK_MAILBOX`);
      if (status === 404) throw new MicrosoftConfigError("Microsoft Graph has no Exchange Online mailbox at MICROSOFT_OUTLOOK_MAILBOX");
      if (status !== 200) throw new MicrosoftApiError(`Microsoft Graph answered HTTP ${status} for the mailbox's ${what}`, status, code);
      if (!isObject(reply) || !Array.isArray(reply.value)) throw new MicrosoftApiError(`Microsoft Graph answered the mailbox's ${what} without the value list`, 200);
      const nextLink = reply["@odata.nextLink"];
      const deltaLink = reply["@odata.deltaLink"];
      if ((nextLink === undefined) === (deltaLink === undefined)) throw new MicrosoftApiError(`Microsoft Graph's page of the mailbox's ${what} has neither or both of its next and delta links`, 200);
      const next = outlookStateOf(nextLink ?? deltaLink, suffix);
      if (!next || next.kind !== (nextLink === undefined ? "delta" : "skip")) throw new MicrosoftApiError(`Microsoft Graph sent a paging link that isn't the mailbox's ${what}`, 200);
      return { items: (reply.value as unknown[]).filter(isObject), next };
    }
  }

  function at(path: string, state: OutlookState | null, first: Record<string, string>): URL {
    if (state !== null && !OUTLOOK_STATE_TOKEN.test(state.token)) throw new MicrosoftApiError("the saved state token isn't in the expected shape", 0);
    const url = new URL(`${base}${path}`);
    const params = state === null ? first : { [state.kind === "skip" ? "$skiptoken" : "$deltatoken"]: state.token };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url;
  }

  return {
    async messages(folder, state, since) {
      if (!(OUTLOOK_FOLDERS as readonly string[]).includes(folder)) throw new MicrosoftConfigError("Outlook reads only the Inbox and Sent Items");
      if (!TIME.test(since)) throw new MicrosoftConfigError("messages are read from a UTC time");
      return page(at(`/mailFolders/${folder}/messages/delta`, state, { $select: OUTLOOK_MESSAGE_SELECT, $filter: `receivedDateTime ge ${since}` }), "mail", "/messages/delta");
    },
    async events(state, start, end) {
      if (!TIME.test(start) || !TIME.test(end) || start >= end) throw new MicrosoftConfigError("the calendar is read between two UTC times");
      return page(at("/calendarView/delta", state, { startDateTime: start, endDateTime: end }), "calendar", "/calendarview/delta");
    },
  };
}
