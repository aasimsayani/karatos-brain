import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * TikTok's Display API (v2): the profile read, the video list and the OAuth
 * refresh, built from TikTok for Developers' docs. Data is synthetic.
 *
 * - Get user info: GET /user/info/ with `fields`; answers data.user with the
 *   fields asked for. open_id and display_name need user.info.basic, the
 *   follower, following, likes and video counts need user.info.stats.
 * - List videos: POST /video/list/ with `fields` in the query and a JSON body
 *   of `max_count` (default 10, up to 20) and `cursor`, a time in epoch
 *   milliseconds; answers data.videos newest first, `cursor` and `has_more`.
 *   Needs video.list.
 * - Errors sit in an `error` object of `code`, `message` and `log_id`; its
 *   code is "ok" on success.
 * - Refresh: POST /oauth/token/ as a form with client_key, client_secret,
 *   grant_type=refresh_token and refresh_token; answers access_token,
 *   expires_in, the scopes held and a refresh_token, which may be new.
 */
const API = "https://open.tiktokapis.com/v2";
const GUIDE = "https://developers.tiktok.com/docs/en/display-api-get-started";
const TOKEN_DOC = "https://developers.tiktok.com/docs/en/oauth-user-access-token-management";
const USER_DOC = "https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info";
const LIST_DOC = "https://developers.tiktok.com/docs/en/tiktok-api-v2-video-list";
const SOURCE = { url: GUIDE, title: "TikTok for Developers: Display API", retrievedOn: "2026-11-01", version: "v2" };

/** The scope each user field needs. */
const USER_FIELDS: Record<string, string> = {
  open_id: "user.info.basic",
  union_id: "user.info.basic",
  avatar_url: "user.info.basic",
  display_name: "user.info.basic",
  bio_description: "user.info.profile",
  username: "user.info.profile",
  is_verified: "user.info.profile",
  follower_count: "user.info.stats",
  following_count: "user.info.stats",
  likes_count: "user.info.stats",
  video_count: "user.info.stats",
};
const VIDEO_FIELDS = ["id", "create_time", "cover_image_url", "share_url", "video_description", "duration", "height", "width", "title", "embed_html", "embed_link", "like_count", "comment_count", "share_count", "view_count", "is_aigc"];

export const TIKTOK_MOCK_READ_SCOPES = ["user.info.basic", "user.info.stats", "video.list"] as const;

/** A video as TikTok writes it. */
export type TikTokMockVideo = Record<string, unknown> & { id: string; create_time: number };

/** Video n of the store's account, posted a day after video n - 1, with a product title and a share link. */
export const tiktokVideo = fixtureBuilder<TikTokMockVideo>((n) => ({
  id: String(700_000_000_000 + n),
  create_time: Date.parse("2026-01-01T12:00:00Z") / 1000 + n * 86_400,
  title: `Test oval halo ring ${n}`,
  video_description: `Test description ${n}`,
  duration: 15 + (n % 30),
  share_url: `https://www.tiktok.com/@test_store/video/${700_000_000_000 + n}?is_from_webapp=1`,
  embed_link: `https://www.tiktok.com/player/v1/${700_000_000_000 + n}`,
  cover_image_url: `https://p16-sign.tiktokcdn.example/test-${n}.jpeg`,
  view_count: 1000 * n,
  like_count: 40 * n,
  comment_count: 3 * n,
  share_count: 2 * n,
  height: 1920,
  width: 1080,
  is_aigc: false,
}));

export interface TikTokMockData {
  clientKey: string;
  clientSecret: string;
  refreshToken: string;
  /** The account's profile and counts. */
  user: Record<string, unknown>;
  /** The account's public videos, in any order. */
  videos: TikTokMockVideo[];
  /** Scopes the connection holds. Defaults to the three read scopes. */
  scopes?: string[];
  /** Whether a refresh answers a new refresh token. Defaults to true. */
  rotate?: boolean;
  /** Videos per page the mock caps at, below max_count, to exercise paging. */
  pageCap?: number;
  /** How many of the next API calls answer 429. */
  rateLimited?: number;
}

export interface TikTokMock {
  oauth: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  /** How many refreshes were answered. */
  readonly refreshes: number;
  /** Every video list body read, in order. */
  readonly listed: { max_count?: unknown; cursor?: unknown }[];
  revokeAccessTokens(): void;
}

const apiError = (status: number, code: string, message: string): DocMockResponse => ({ status, body: { data: {}, error: { code, message, log_id: "202611010000000000TEST" } } });
const ok = (data: unknown): DocMockResponse => ({ status: 200, body: { data, error: { code: "ok", message: "", log_id: "202611010000000000TEST" } } });

export function tiktokDocMock(data: TikTokMockData): TikTokMock {
  let refreshes = 0;
  let issued = 0;
  const access = new Set<string>();
  const listed: { max_count?: unknown; cursor?: unknown }[] = [];
  const scopes = () => data.scopes ?? [...TIKTOK_MOCK_READ_SCOPES];

  const oauth = checkDocMock({
    integration: "tiktok",
    baseUrl: `${API}/oauth`,
    source: SOURCE,
    assumptions: [
      "Wrong client credentials answer 401 with error invalid_client",
      "A refresh token that was replaced or revoked answers 400 with error invalid_grant",
      "scope lists the connection's scopes separated by commas",
    ],
    routes: [
      {
        method: "POST",
        path: "/token/",
        documentedAt: TOKEN_DOC,
        respond(request) {
          refreshes++;
          if (!/^application\/x-www-form-urlencoded/.test(request.headers.get("content-type") ?? "")) return { status: 400, body: { error: "invalid_request", error_description: "Content-Type must be application/x-www-form-urlencoded", log_id: "TEST" } };
          const form = new URLSearchParams(request.body);
          if (form.get("client_key") !== data.clientKey || form.get("client_secret") !== data.clientSecret) return { status: 401, body: { error: "invalid_client", error_description: "Client key or secret is incorrect.", log_id: "TEST" } };
          if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== data.refreshToken) return { status: 400, body: { error: "invalid_grant", error_description: "Refresh token is invalid or expired.", log_id: "TEST" } };
          const token = `act.TEST${++issued}`;
          access.add(token);
          if (data.rotate ?? true) data.refreshToken = `rft.TEST${issued}`;
          return { status: 200, body: { access_token: token, expires_in: 86_400, open_id: "test-open-id", refresh_expires_in: 31_536_000, refresh_token: data.refreshToken, scope: scopes().join(","), token_type: "Bearer" } };
        },
      },
    ],
  });

  /** Checks shared by every API call: the token, the endpoint's scope and the rate limit. */
  function denied(request: { headers: Headers }, needs: string): DocMockResponse | null {
    if (!access.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) return apiError(401, "access_token_invalid", "The access token is invalid or not found in the request.");
    if (!scopes().includes(needs)) return apiError(401, "scope_not_authorized", `The user did not authorize the scope required for completing this request.`);
    if (data.rateLimited) {
      data.rateLimited--;
      return apiError(429, "rate_limit_exceeded", "API rate limit was exceeded, please try again later.");
    }
    return null;
  }

  const fieldsOf = (url: URL) => (url.searchParams.get("fields") ?? "").split(",").filter(Boolean);

  const api = checkDocMock({
    integration: "tiktok",
    baseUrl: API,
    source: SOURCE,
    auth: "bearer",
    assumptions: [
      "A field the token's scopes don't cover answers 400 scope_permission_missed",
      "A field that doesn't exist answers 400 invalid_params",
      "The next page's cursor is the last video's create_time in milliseconds",
      "Counts are JSON numbers",
    ],
    routes: [
      {
        method: "GET",
        path: "/user/info/",
        documentedAt: USER_DOC,
        respond(request) {
          const no = denied(request, "user.info.basic");
          if (no) return no;
          const fields = fieldsOf(request.url);
          if (!fields.length || !fields.every((f) => f in USER_FIELDS)) return apiError(400, "invalid_params", "Invalid fields.");
          if (!fields.every((f) => scopes().includes(USER_FIELDS[f]!))) return apiError(400, "scope_permission_missed", "Some fields need additional scopes.");
          return ok({ user: Object.fromEntries(fields.filter((f) => f in data.user).map((f) => [f, data.user[f]])) });
        },
      },
      {
        method: "POST",
        path: "/video/list/",
        documentedAt: LIST_DOC,
        respond(request) {
          const no = denied(request, "video.list");
          if (no) return no;
          if (!/^application\/json/.test(request.headers.get("content-type") ?? "")) return apiError(400, "invalid_params", "Content-Type must be application/json.");
          const fields = fieldsOf(request.url);
          if (!fields.length || !fields.every((f) => VIDEO_FIELDS.includes(f))) return apiError(400, "invalid_params", "Invalid fields.");
          let body: { max_count?: unknown; cursor?: unknown };
          try {
            body = JSON.parse(request.body || "{}") as typeof body;
          } catch {
            return apiError(400, "invalid_params", "Invalid JSON body.");
          }
          listed.push(body);
          const max = body.max_count ?? 10;
          if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > 20) return apiError(400, "invalid_params", "max_count must be 1 to 20.");
          if (body.cursor !== undefined && !(Number.isSafeInteger(body.cursor) && (body.cursor as number) > 0)) return apiError(400, "invalid_params", "Invalid cursor.");
          const before = (body.cursor as number | undefined) ?? Number.MAX_SAFE_INTEGER;
          const all = [...data.videos].sort((a, b) => b.create_time - a.create_time).filter((v) => v.create_time * 1000 < before);
          const page = all.slice(0, Math.min(max as number, data.pageCap ?? (max as number)));
          const more = all.length > page.length;
          const last = page.at(-1);
          return ok({
            videos: page.map((v) => Object.fromEntries(fields.filter((f) => f in v).map((f) => [f, v[f]]))),
            cursor: last ? last.create_time * 1000 : 0,
            has_more: more,
          });
        },
      },
    ],
  });

  const mocks = [
    { base: `${API}/oauth`, fetch: docMockFetch(oauth) },
    { base: API, fetch: docMockFetch(api) },
  ];
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // Routed by exact origin and path, so a look-alike host goes to the API mock and is turned down there.
      const target = mocks.find((m) => url.origin === new URL(m.base).origin && url.pathname.startsWith(`${new URL(m.base).pathname}/`)) ?? mocks[1]!;
      const response = await target.fetch(input, init);
      calls.push(...target.fetch.calls.slice(-1));
      return response;
    },
    { calls },
  );

  return {
    oauth,
    api,
    fetch,
    get refreshes() {
      return refreshes;
    },
    listed,
    revokeAccessTokens: () => access.clear(),
  };
}

export default {
  integration: "tiktok",
  covers: "TikTok's Display API v2 profile read and video list with its OAuth refresh, enforcing the client credentials, each token's scopes and the scope each field needs, page sizes and time cursors",
  watchPages: [GUIDE, TOKEN_DOC, USER_DOC, LIST_DOC],
  docMocks: () => {
    const mock = tiktokDocMock({ clientKey: "", clientSecret: "", refreshToken: "", user: {}, videos: [] });
    return [mock.oauth, mock.api];
  },
} satisfies DocMockModule;
