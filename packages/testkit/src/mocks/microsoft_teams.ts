import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Microsoft's client credentials sign-in and Microsoft Graph's listings of
 * one team's channels, channel messages and replies (v1.0), built from the
 * Microsoft identity platform, Graph and Teams reference pages. Data is
 * synthetic.
 *
 * Docs facts the mock relies on:
 * - `GET /teams/{team}/channels` takes `$filter` and `$select`.
 * - `GET /teams/{team}/channels/{channel}/messages` takes `$top` (20 by
 *   default, at most 50) and `$expand=replies`, and no other query. Threads
 *   come sorted by the last change to the whole thread, the message or any
 *   reply. With `$expand=replies` each carries up to 200 replies, and
 *   `replies@odata.nextLink` when it has more. More pages come as an
 *   `@odata.nextLink` with an opaque `$skiptoken`.
 * - `GET .../messages/{message}/replies` takes `$top`, at most 50.
 * - An app granted ChannelMessage.Read.Group and ChannelSettings.Read.Group
 *   by resource-specific consent reads only the team that installed it.
 */
const LOGIN = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
const LIST_MESSAGES = "https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0";
const LIST_REPLIES = "https://learn.microsoft.com/en-us/graph/api/chatmessage-list-replies?view=graph-rest-1.0";
const LIST_CHANNELS = "https://learn.microsoft.com/en-us/graph/api/channel-list?view=graph-rest-1.0";
const CLIENT_CREDENTIALS = "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow";

export type TeamsMockRecord = Record<string, unknown>;
const DAY_MS = 86_400_000;
const at = (n: number) => new Date(Date.parse("2026-10-01T09:00:00Z") + n * DAY_MS).toISOString();
const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A channel of the test team; `n` 1 is General. */
export const teamsChannel = fixtureBuilder<TeamsMockRecord>((n) => ({
  id: `19:test${String(n).padStart(28, "0")}@thread.tacv2`,
  createdDateTime: at(-n),
  displayName: n === 1 ? "General" : `Test repairs ${n}`,
  description: `Test channel ${n}`,
  email: "",
  membershipType: "standard",
  isArchived: false,
  webUrl: `https://teams.microsoft.test/l/channel/${n}`,
}));

/** A staff message about a repair, posted `n` days into October 2026, with no replies. */
export const teamsMessage = fixtureBuilder<TeamsMockRecord>((n) => ({
  // Teams numbers messages by when they were posted; these short ones can't pass for a card number.
  id: String(1_000_000 + n * 10_000),
  replyToId: null,
  etag: "1",
  messageType: "message",
  createdDateTime: at(n),
  lastModifiedDateTime: at(n),
  lastEditedDateTime: null,
  deletedDateTime: null,
  subject: null,
  summary: null,
  chatId: null,
  importance: "normal",
  locale: "en-us",
  webUrl: `https://teams.microsoft.test/l/message/${n}`,
  policyViolation: null,
  eventDetail: null,
  from: { application: null, device: null, user: { "@odata.type": "#microsoft.graph.teamworkUserIdentity", id: guid(n % 3), displayName: `Test Staff ${n % 3}`, userIdentityType: "aadUser" } },
  body: { contentType: "html", content: `<p>Test: ring resize for order ${1000 + n} is ready</p>` },
  attachments: [],
  mentions: [],
  reactions: [],
  messageHistory: [],
  replies: [],
}));

/** A reply to `parent`, posted `minutes` after it. */
export function teamsReply(parent: TeamsMockRecord, minutes: number, extra: TeamsMockRecord = {}): TeamsMockRecord {
  const t = new Date(Date.parse(String(parent.createdDateTime)) + minutes * 60_000).toISOString();
  const { replies: _, ...rest } = parent;
  return { ...rest, id: String(Number(parent.id) + minutes), etag: "1", replyToId: parent.id, createdDateTime: t, lastModifiedDateTime: t, body: { contentType: "text", content: `Test reply ${minutes}` }, ...extra };
}

export interface TeamsMockData {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The one team that installed the app. */
  teamId: string;
  /** The application permissions the app was given in Entra, as the token's roles claim lists them; null leaves the claim out. */
  roles?: string[] | null;
  /** False when the team hasn't installed the app (or a team owner took it out). */
  installed?: boolean;
  channels?: TeamsMockRecord[];
  /** Each channel's threads by channel id, each root with its replies under `replies`. */
  threads?: Record<string, TeamsMockRecord[]>;
  /** Threads or channels per page the mock caps at, to exercise paging. */
  pageCap?: number;
  /** Replies a thread carries when the listing expands them. Defaults to 200. */
  expandCap?: number;
  /** How many of the next requests answer 429, with Retry-After `retryAfter` (default 1). */
  rateLimited?: number;
  retryAfter?: string;
}

export interface TeamsMock {
  login: DocMock;
  graph: DocMock;
  fetch: DocMockFetch;
  /** Posts or edits a thread's message in a channel. */
  putThread(channel: string, root: TeamsMockRecord): void;
  /** Posts or edits a reply in a thread. */
  putReply(channel: string, rootId: string, reply: TeamsMockRecord): void;
  /** Deletes a message or reply, as Teams does: it stays, with its deletion time and no content. */
  remove(channel: string, id: string, when: string): void;
  /** Makes every access token handed out so far stop working. */
  revokeTokens(): void;
  readonly signIns: number;
}

type Skip = { kind: "channels" | "messages" | "replies"; offset: number; root?: string };
const graphError = (status: number, code: string, message: string, headers?: Record<string, string>): DocMockResponse => ({ status, body: { error: { code, message, innerError: { date: "2026-11-11T12:00:00", "request-id": "00000000-0000-4000-8000-000000000000" } } }, ...(headers ? { headers } : {}) });
const loginError = (status: number, error: string, code: number): DocMockResponse => ({ status, body: { error, error_description: `AADSTS${code}: synthetic.`, error_codes: [code], timestamp: "2026-11-11 12:00:00Z", trace_id: "00000000-0000-4000-8000-000000000000", correlation_id: "00000000-0000-4000-8000-000000000000" } });
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const replyList = (root: TeamsMockRecord) => root.replies as TeamsMockRecord[];
/** When a thread last changed: its message or any reply. */
const changed = (root: TeamsMockRecord) => [root, ...replyList(root)].map((m) => String(m.lastModifiedDateTime)).sort().at(-1)!;

export function teamsDocMock(data: TeamsMockData): TeamsMock {
  const tokens = new Set<string>();
  const threads = new Map<string, TeamsMockRecord[]>(Object.entries(data.threads ?? {}).map(([k, v]) => [k, v.map((t) => ({ replies: [], ...t }))]));
  let signIns = 0;
  let limits = data.rateLimited ?? 0;
  const cap = (top: number) => Math.min(top, data.pageCap ?? 1000);
  const expandCap = data.expandCap ?? 200;
  const decode = (raw: string, kind: Skip["kind"]): Skip | null => {
    try {
      const t = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Skip;
      return t.kind === kind && Number.isInteger(t.offset) ? t : null;
    } catch {
      return null;
    }
  };

  const login = checkDocMock({
    integration: "microsoft_teams",
    baseUrl: LOGIN,
    source: { url: CLIENT_CREDENTIALS, title: "Microsoft identity platform and the OAuth 2.0 client credentials flow", retrievedOn: "2026-11-11", version: "v2.0" },
    assumptions: [
      "A client credentials token for https://graph.microsoft.com/.default is a JWT whose roles claim lists the application permissions an admin consented to in Entra, and leaves the claim out when there are none; resource-specific consent a team granted isn't listed in it",
      "A wrong or expired client secret answers 401 invalid_client with error code 7000215, an unknown app 400 unauthorized_client with 700016, and an unknown tenant 400 invalid_request with 90002",
    ],
    routes: [
      {
        method: "POST",
        path: "/{tenant}/oauth2/v2.0/token",
        documentedAt: CLIENT_CREDENTIALS,
        respond(request, params) {
          const form = new URLSearchParams(request.body);
          if (params.tenant !== data.tenantId) return loginError(400, "invalid_request", 90002);
          if (form.get("grant_type") !== "client_credentials") return loginError(400, "unsupported_grant_type", 70003);
          if (form.get("client_id") !== data.clientId) return loginError(400, "unauthorized_client", 700016);
          if (form.get("client_secret") !== data.clientSecret) return loginError(401, "invalid_client", 7000215);
          if (form.get("scope") !== "https://graph.microsoft.com/.default") return loginError(400, "invalid_scope", 1002012);
          signIns++;
          const claims = { aud: "https://graph.microsoft.com", iss: `https://sts.windows.net/${data.tenantId}/`, appid: data.clientId, tid: data.tenantId, n: signIns, ...(data.roles ? { roles: data.roles } : {}) };
          const token = `${b64url({ typ: "JWT", alg: "RS256" })}.${b64url(claims)}.${"s".repeat(43)}`;
          tokens.add(token);
          return { status: 200, body: { token_type: "Bearer", expires_in: 3599, ext_expires_in: 3599, access_token: token } };
        },
      },
    ],
  });

  /** Checks the token, throttling, the team and the query, then answers a page of `all`. */
  function answer(request: { headers: Headers; url: URL }, team: string, kind: Skip["kind"], allowed: string[], all: () => TeamsMockRecord[] | DocMockResponse, link: string, shape: (row: TeamsMockRecord) => TeamsMockRecord = (r) => r): DocMockResponse {
    if (!tokens.has(request.headers.get("authorization")!.slice("Bearer ".length))) return graphError(401, "InvalidAuthenticationToken", "Access token has expired or is not yet valid.");
    if (limits > 0) {
      limits--;
      return graphError(429, "TooManyRequests", "Too many requests.", { "Retry-After": data.retryAfter ?? "1" });
    }
    if (team.toLowerCase() !== data.teamId.toLowerCase() || data.installed === false) return graphError(403, "Forbidden", "Missing role permissions on the request.");
    const q = request.url.searchParams;
    if ([...q.keys()].some((k) => !allowed.includes(k) && k !== "$skiptoken")) return graphError(400, "BadRequest", "Query option is not supported.");
    const topRaw = q.get("$top");
    const top = topRaw === null ? 20 : Number(topRaw);
    if (kind !== "channels" && (!Number.isInteger(top) || top < 1 || top > 50)) return graphError(400, "BadRequest", "The $top value must be between 1 and 50.");
    const raw = q.get("$skiptoken");
    const skip = raw === null ? { kind, offset: 0 } : decode(raw, kind);
    if (!skip) return graphError(400, "BadRequest", "The skip token is invalid.");
    const rows = all();
    if (!Array.isArray(rows)) return rows;
    const size = kind === "channels" ? cap(1000) : cap(top);
    const value = rows.slice(skip.offset, skip.offset + size).map(shape);
    const offset = skip.offset + value.length;
    const kept = new URLSearchParams([...q.entries()].filter(([k]) => k !== "$skiptoken"));
    kept.set("$skiptoken", b64url({ kind, offset }));
    return { status: 200, body: { "@odata.context": `${GRAPH}/$metadata#Collection(${kind === "channels" ? "channel" : "chatMessage"})`, "@odata.count": value.length, value, ...(offset < rows.length ? { "@odata.nextLink": `${link}?${kept.toString()}` } : {}) } };
  }
  const threadsOf = (channel: string) => [...(threads.get(channel) ?? [])].sort((a, b) => changed(b).localeCompare(changed(a)));
  const channelKnown = (channel: string) => (data.channels ?? []).some((c) => c.id === channel);

  const graph = checkDocMock({
    integration: "microsoft_teams",
    baseUrl: GRAPH,
    source: { url: LIST_MESSAGES, title: "List channel messages", retrievedOn: "2026-11-11", version: "v1.0" },
    auth: "bearer",
    assumptions: [
      "A thread's replies come newest first, and a thread with more than the expansion carries has replies@odata.nextLink to its replies listing",
      "A deleted message stays in the listing with deletedDateTime set and its body emptied",
      "A team that didn't install the app, or any other team, answers 403; a 429 carries Retry-After as whole seconds",
      "The channels listing returns every channel of a team that installed the app with ChannelSettings.Read.Group, private and shared ones included",
    ],
    routes: [
      {
        method: "GET",
        path: "/teams/{team}/channels/{channel}/messages",
        documentedAt: LIST_MESSAGES,
        respond(request, params) {
          const expand = request.url.searchParams.get("$expand");
          if (expand !== null && expand !== "replies") return graphError(400, "BadRequest", "Only replies can be expanded.");
          const link = `${GRAPH}/teams/${params.team}/channels/${params.channel}/messages`;
          return answer(request, params.team!, "messages", ["$top", "$expand"], () => (channelKnown(params.channel!) ? threadsOf(params.channel!) : graphError(404, "NotFound", "Channel not found.")), link, (root) => {
            const { replies: _, ...rest } = root;
            if (expand === null) return rest;
            const all = [...replyList(root)].reverse();
            const more = all.length > expandCap ? { "replies@odata.nextLink": `${link}/${root.id}/replies?$skiptoken=${b64url({ kind: "replies", offset: 0 })}` } : {};
            return { ...rest, "replies@odata.count": all.length, ...more, replies: all.slice(0, expandCap) };
          });
        },
      },
      {
        method: "GET",
        path: "/teams/{team}/channels/{channel}/messages/{message}/replies",
        documentedAt: LIST_REPLIES,
        respond(request, params) {
          const root = (threads.get(params.channel!) ?? []).find((t) => t.id === params.message);
          return answer(request, params.team!, "replies", ["$top"], () => (root ? [...replyList(root)].reverse() : graphError(404, "NotFound", "Message not found.")), `${GRAPH}/teams/${params.team}/channels/${params.channel}/messages/${params.message}/replies`);
        },
      },
      {
        method: "GET",
        path: "/teams/{team}/channels",
        documentedAt: LIST_CHANNELS,
        respond(request, params) {
          const select = request.url.searchParams.get("$select");
          const fields = select === null ? null : select.split(",");
          return answer(request, params.team!, "channels", ["$select", "$filter"], () => data.channels ?? [], `${GRAPH}/teams/${params.team}/channels`, (c) => (fields === null ? c : Object.fromEntries(Object.entries(c).filter(([k]) => fields.includes(k)))));
        },
      },
    ],
  });

  const loginFetch = docMockFetch(login);
  const graphFetch = docMockFetch(graph);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      // Routed by exact origin, so a look-alike host goes to the Graph mock and is refused there.
      const toLogin = new URL(input instanceof Request ? input.url : String(input)).origin === LOGIN;
      const response = await (toLogin ? loginFetch : graphFetch)(input, init);
      calls.push(...(toLogin ? loginFetch.calls : graphFetch.calls).slice(-1));
      return response;
    },
    { calls },
  );
  const list = (channel: string) => {
    if (!threads.has(channel)) threads.set(channel, []);
    return threads.get(channel)!;
  };

  return {
    login,
    graph,
    fetch,
    putThread(channel, root) {
      const all = list(channel);
      const i = all.findIndex((t) => t.id === root.id);
      if (i === -1) all.push({ replies: [], ...root });
      else all[i] = { replies: replyList(all[i]!), ...root };
    },
    putReply(channel, rootId, reply) {
      const root = list(channel).find((t) => t.id === rootId)!;
      root.replies = [...replyList(root).filter((r) => r.id !== reply.id), reply];
    },
    remove(channel, id, when) {
      const scrub = (m: TeamsMockRecord) => ({ ...m, deletedDateTime: when, lastModifiedDateTime: when, body: { contentType: "text", content: "" }, attachments: [], mentions: [], reactions: [] });
      for (const root of list(channel)) {
        if (root.id === id) Object.assign(root, scrub(root));
        root.replies = replyList(root).map((r) => (r.id === id ? scrub(r) : r));
      }
    },
    revokeTokens: () => tokens.clear(),
    get signIns() {
      return signIns;
    },
  };
}

export default {
  integration: "microsoft_teams",
  covers: "Microsoft's client credentials sign-in and Microsoft Graph's listings of one team's channels, channel messages and replies (v1.0), enforcing the team the app is installed in, page sizes, skip tokens and the reply expansion",
  watchPages: [CLIENT_CREDENTIALS, LIST_MESSAGES, LIST_REPLIES, LIST_CHANNELS],
  docMocks: () => {
    const mock = teamsDocMock({ tenantId: "", clientId: "", clientSecret: "", teamId: "" });
    return [mock.login, mock.graph];
  },
} satisfies DocMockModule;
