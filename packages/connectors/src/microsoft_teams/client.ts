/**
 * A small client for one team's channels in Microsoft Teams through
 * Microsoft Graph (v1.0). It signs in as the app itself, with the client
 * credentials grant, and sends only these requests:
 *
 * - `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`;
 * - `GET /teams/{team}/channels`;
 * - `GET /teams/{team}/channels/{channel}/messages`, with each thread's replies;
 * - `GET /teams/{team}/channels/{channel}/messages/{message}/replies`, for a
 *   thread with more replies than the listing carries.
 *
 * The app is meant to hold only the resource-specific consent permissions
 * ChannelMessage.Read.Group and ChannelSettings.Read.Group, granted when the
 * team installs it, so it can read that one team and nothing else in the
 * tenant. When the token says which application permissions it carries, the
 * client stops if any isn't one of the read permissions below.
 *
 * Graph's paging links are never fetched as given: the client reads the
 * skip token out of each one and builds the next request itself, so a link
 * can't send it, or its token, anywhere else.
 */
import { MICROSOFT_GRAPH, MICROSOFT_LOGIN, MicrosoftApiError, MicrosoftConfigError, microsoftGuid, microsoftTokenRoles } from "../microsoft_onedrive/client.js";

/** The tenant-wide application permissions a token may carry: ones that read channels and their messages, and nothing more. */
export const TEAMS_READ_ROLES = ["ChannelMessage.Read.All", "ChannelSettings.Read.All", "Channel.ReadBasic.All"] as const;
/** Messages, and replies, Graph is asked to put on a page: its most. */
export const TEAMS_PAGE_SIZE = 50;
/** The channel fields asked for. The name, description and email are never asked for. */
export const TEAMS_CHANNEL_SELECT = "id,membershipType,createdDateTime,isArchived";
/** A channel id, as Teams writes it. */
export const TEAMS_CHANNEL_ID = /^19:[A-Za-z0-9_-]{1,128}@thread\.(?:tacv2|skype)$/;
/** A message id: the time it was posted, in milliseconds. */
export const TEAMS_MESSAGE_ID = /^\d{1,20}$/;
/** A skip token, as Graph puts it in its paging links. */
export const TEAMS_SKIP_TOKEN = /^[A-Za-z0-9_.~=+/-]{1,8192}$/;
/** Pages of channels read before giving up: far more channels than a team can have. */
const MAX_CHANNEL_PAGES = 20;
const TOKEN_MARGIN_MS = 5 * 60_000;
const MAX_WAIT_S = 60;
const ACCESS_TOKEN = /^[\x21-\x7e]{1,16384}$/;

export interface TeamsClientOptions {
  /** The directory (tenant) id (MICROSOFT_TENANT_ID). */
  tenantId: string;
  /** The Teams app's client id (MICROSOFT_TEAMS_CLIENT_ID). */
  clientId: string;
  /** The Teams app's client secret (MICROSOFT_TEAMS_CLIENT_SECRET). Sent to Microsoft only. */
  clientSecret: string;
  /** The team to read (MICROSOFT_TEAMS_TEAM_ID): its group id. */
  teamId: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429, 503 or 504 is retried here before the error goes to runSync. */
  retries?: number;
  now?: () => Date;
}

export interface TeamsPage {
  items: Record<string, unknown>[];
  /** The skip token of the next page, or null on the last. */
  next: string | null;
}

export interface TeamsClient {
  /** The team's channels, every page. */
  channels(): Promise<Record<string, unknown>[]>;
  /** One page of a channel's threads, each with its replies, newest change first. */
  messages(channel: string, skip: string | null): Promise<TeamsPage>;
  /** One page of a thread's replies. */
  replies(channel: string, message: string, skip: string | null): Promise<TeamsPage>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The skip token in one of Graph's paging links, or undefined unless the
 * link is a listing on Graph that ends with `suffix` and carries a skip
 * token, with at most the page size and replies asked for beside it.
 */
export function teamsSkipOf(link: unknown, suffix: string): string | undefined {
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
  if (!path.startsWith("/v1.0/teams/") || !path.endsWith(suffix)) return undefined;
  if ([...url.searchParams.keys()].some((k) => !["$skiptoken", "$top", "$expand", "$select"].includes(k))) return undefined;
  const tokens = url.searchParams.getAll("$skiptoken");
  return tokens.length === 1 && TEAMS_SKIP_TOKEN.test(tokens[0]!) ? tokens[0] : undefined;
}

export function teamsClient(options: TeamsClientOptions): TeamsClient {
  const tenant = microsoftGuid(options.tenantId);
  const clientId = microsoftGuid(options.clientId);
  const team = microsoftGuid(options.teamId);
  const secret = options.clientSecret?.trim() ?? "";
  if (!tenant) throw new MicrosoftConfigError("MICROSOFT_TENANT_ID is missing or not a directory (tenant) id");
  if (!clientId) throw new MicrosoftConfigError("MICROSOFT_TEAMS_CLIENT_ID is missing or not an application (client) id");
  if (!/^[\x21-\x7e]{16,256}$/.test(secret)) throw new MicrosoftConfigError("MICROSOFT_TEAMS_CLIENT_SECRET is missing or not in the expected shape");
  if (!team) throw new MicrosoftConfigError("MICROSOFT_TEAMS_TEAM_ID is missing or not a team's group id");
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = options.retries ?? 3;
  const now = options.now ?? (() => new Date());
  const base = `${MICROSOFT_GRAPH}/teams/${team}`;
  let token: { value: string; until: number } | null = null;

  async function signIn(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const body = new URLSearchParams({ client_id: clientId!, client_secret: secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
    const response = await fetch(`${MICROSOFT_LOGIN}/${tenant}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
    const reply: unknown = await response.json().catch(() => undefined);
    if (response.status !== 200) {
      const codes = isObject(reply) && Array.isArray(reply.error_codes) ? reply.error_codes : [];
      if (codes.includes(7000215) || codes.includes(7000222)) throw new MicrosoftConfigError("Microsoft turned down MICROSOFT_TEAMS_CLIENT_SECRET: it may have expired or been deleted. Add a new client secret to the app and save it");
      if (codes.includes(700016)) throw new MicrosoftConfigError("Microsoft has no app with MICROSOFT_TEAMS_CLIENT_ID in this tenant");
      if (codes.includes(90002)) throw new MicrosoftConfigError("Microsoft has no tenant with MICROSOFT_TENANT_ID");
      throw new MicrosoftApiError(`Microsoft answered HTTP ${response.status} to the sign-in`, response.status);
    }
    if (!isObject(reply) || typeof reply.access_token !== "string" || !ACCESS_TOKEN.test(reply.access_token)) throw new MicrosoftApiError("Microsoft's sign-in had no access token in the expected shape", 200);
    // A token that says it can do more than read is never used.
    const extra = (microsoftTokenRoles(reply.access_token) ?? []).filter((r) => !(TEAMS_READ_ROLES as readonly string[]).includes(r));
    if (extra.length > 0) throw new MicrosoftConfigError(`the app has ${extra.slice(0, 5).join(", ")}; KaratOS only reads, so install it in the team with ChannelMessage.Read.Group and ChannelSettings.Read.Group and give it nothing else`);
    const seconds = Number.isFinite(reply.expires_in) ? (reply.expires_in as number) : 0;
    token = { value: reply.access_token, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return token.value;
  }

  async function page(path: string, query: Record<string, string>, skip: string | null, suffix: string): Promise<TeamsPage> {
    if (skip !== null && !TEAMS_SKIP_TOKEN.test(skip)) throw new MicrosoftApiError("the saved skip token isn't in the expected shape", 0);
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(skip === null ? query : { ...query, $skiptoken: skip })) url.searchParams.set(k, v);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${await signIn()}`, Accept: "application/json" } });
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
      if (status === 401) throw new MicrosoftApiError("Microsoft Graph turned down the app's token twice", 401, code);
      if (status === 403) throw new MicrosoftConfigError("the app isn't allowed to read the team: install it in MICROSOFT_TEAMS_TEAM_ID with ChannelMessage.Read.Group and ChannelSettings.Read.Group");
      if (status === 404) throw new MicrosoftConfigError("Microsoft Graph has no team at MICROSOFT_TEAMS_TEAM_ID, or the channel is gone");
      if (status !== 200) throw new MicrosoftApiError(`Microsoft Graph answered HTTP ${status} for the team`, status, code);
      if (!isObject(reply) || !Array.isArray(reply.value)) throw new MicrosoftApiError("Microsoft Graph answered the team without the value list", 200);
      const link = reply["@odata.nextLink"];
      const next = link === undefined ? null : teamsSkipOf(link, suffix);
      if (next === undefined) throw new MicrosoftApiError("Microsoft Graph sent a paging link that isn't the team's", 200);
      return { items: (reply.value as unknown[]).filter(isObject), next };
    }
  }

  const channelPath = (channel: string) => {
    if (!TEAMS_CHANNEL_ID.test(channel)) throw new MicrosoftApiError("the channel id isn't in the expected shape", 0);
    return `/channels/${encodeURIComponent(channel)}`;
  };

  return {
    async channels() {
      const all: Record<string, unknown>[] = [];
      let skip: string | null = null;
      for (let n = 0; n < MAX_CHANNEL_PAGES; n++) {
        const p: TeamsPage = await page("/channels", { $select: TEAMS_CHANNEL_SELECT }, skip, "/channels");
        all.push(...p.items);
        skip = p.next;
        if (skip === null) return all;
      }
      throw new MicrosoftApiError("Microsoft Graph listed more pages of channels than a team can have", 200);
    },
    async messages(channel, skip) {
      return page(`${channelPath(channel)}/messages`, { $top: String(TEAMS_PAGE_SIZE), $expand: "replies" }, skip, "/messages");
    },
    async replies(channel, message, skip) {
      if (!TEAMS_MESSAGE_ID.test(message)) throw new MicrosoftApiError("the message id isn't in the expected shape", 0);
      return page(`${channelPath(channel)}/messages/${message}/replies`, { $top: String(TEAMS_PAGE_SIZE) }, skip, `/messages/${message}/replies`);
    },
  };
}
