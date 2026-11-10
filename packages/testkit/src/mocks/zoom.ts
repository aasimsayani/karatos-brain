import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Zoom's Server-to-Server OAuth token request, its meeting history report
 * and its meeting participant report, built from Zoom's developer docs.
 * Data is synthetic. Zoom has no sandbox for reports (they need a paid
 * plan), so a client's app replaces this mock on the first live run.
 *
 * Docs facts the mock relies on:
 * - POST https://zoom.us/oauth/token with grant_type=account_credentials
 *   and account_id, signed with Basic client_id:client_secret, answers
 *   {access_token, token_type: "bearer", expires_in: 3599, scope, api_url};
 *   there is no refresh token, and a new token is asked for when one
 *   lapses (s2s-oauth).
 * - Scopes are granular, such as report:read:list_history_meetings:admin,
 *   and an app holds only the ones its admin adds (oauth-scopes-granular).
 * - GET https://api.zoom.us/v2/report/history_meetings takes from and to
 *   (yyyy-mm-dd, at most a month apart), date_type, meeting_type, page_size
 *   (up to 300) and next_page_token, and answers {from, to, page_size,
 *   next_page_token, history_meetings}; next_page_token is empty on the
 *   last page and lasts 15 minutes (meetings API, Reports).
 * - GET /report/meetings/{meetingId}/participants takes a meeting id or a
 *   UUID, the UUID encoded twice when it starts with / or holds //, and
 *   answers {page_size, next_page_token, total_records, participants}; a
 *   meeting it has no report for is a 404 with code 3001 (meetings API).
 * - Errors are {code, message}; a lapsed or wrong token is a 401 with code
 *   124, a missing scope a 400 with code 4711, and rate limits a 429.
 */
const DOCS = {
  oauth: "https://developers.zoom.us/docs/internal-apps/s2s-oauth/",
  api: "https://developers.zoom.us/docs/api/meetings/",
} as const;
export const ZOOM_DOC_PAGES = DOCS;

const READ_SCOPES = ["report:read:list_history_meetings:admin", "report:read:list_meeting_participants:admin"];
/** The store's host in fixtures. */
export const ZOOM_TEST_HOST = "stylist@store.test";

export type ZoomMockRecord = Record<string, unknown>;

export interface ZoomMockData {
  accountId: string;
  clientId: string;
  clientSecret: string;
  /** The scopes the app holds; defaults to the two report reads. */
  scopes?: string[];
  meetings: ZoomMockRecord[];
  /** Participant rows by meeting UUID; a meeting left out has no report (404). */
  participants?: Record<string, ZoomMockRecord[]>;
  /** Rows per page the mock caps at, to exercise paging. */
  pageCap?: number;
  /** 429s to answer before the next report reads. */
  rateLimits?: number;
}

/** A meeting held with one customer, `n` hours into 2026. */
export const zoomMeeting = fixtureBuilder<ZoomMockRecord>((n) => ({
  meeting_uuid: `TstMtg${String(n).padStart(6, "0")}AAAAAAAAAA==`,
  meeting_id: 81_000_000_000 + n,
  type: "Meeting",
  host_display_name: "Store Stylist",
  host_email: ZOOM_TEST_HOST,
  start_time: synthetic.isoTime(n * 60).replace(".000Z", "Z"),
  end_time: synthetic.isoTime(n * 60 + 30).replace(".000Z", "Z"),
  topic: "Bridal consultation",
  participants: 2,
  duration: 30,
  total_participant_minutes: 60,
  department: "",
  group: [],
  source: "Zoom",
  create_time: synthetic.isoTime(n * 60 - 1440).replace(".000Z", "Z"),
  custom_fields: [],
  tracking_fields: [],
  feature_used: { screen_sharing: true, record_to_cloud: false, record_to_computer: false, meeting_summary: false },
}));

/** The participant report for a fixture meeting: the host and customer `n`. */
export function zoomParticipants(meeting: ZoomMockRecord, n: number): ZoomMockRecord[] {
  const start = String(meeting.start_time);
  const end = String(meeting.end_time);
  return [
    { id: "", participant_user_id: "TstHost0001", user_id: "16778240", name: "Store Stylist", user_email: ZOOM_TEST_HOST, join_time: start, leave_time: end, duration: 1800, status: "in_meeting", customer_key: "" },
    { id: "", participant_user_id: `TstGuest${String(n).padStart(4, "0")}`, user_id: "16779264", name: synthetic.name(n), user_email: synthetic.email(n), join_time: start, leave_time: end, duration: 1800, status: "in_meeting", customer_key: "" },
  ];
}

const error = (status: number, code: number, message: string): DocMockResponse => ({ status, body: { code, message } });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface ZoomMock {
  oauth: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  /** Makes every token handed out so far lapse. */
  expireTokens(): void;
  readonly signIns: number;
  /** Each report read: its path and query. */
  readonly reads: { path: string; query: Record<string, string> }[];
}

export function zoomDocMock(data: ZoomMockData): ZoomMock {
  const tokens = new Set<string>();
  const reads: { path: string; query: Record<string, string> }[] = [];
  const scopes = data.scopes ?? READ_SCOPES;
  const cap = data.pageCap ?? 300;
  let limits = data.rateLimits ?? 0;
  let signIns = 0;

  const oauth = checkDocMock({
    integration: "zoom",
    baseUrl: "https://zoom.us",
    source: { url: DOCS.oauth, title: "Zoom Server-to-Server OAuth", retrievedOn: "2026-11-10", version: "OAuth 2.0" },
    assumptions: ["A token asked for while another is still good is a new token, and both work"],
    routes: [
      {
        method: "POST",
        path: "/oauth/token",
        documentedAt: DOCS.oauth,
        respond(request) {
          const basic = `Basic ${Buffer.from(`${data.clientId}:${data.clientSecret}`).toString("base64")}`;
          if (request.headers.get("authorization") !== basic) return { status: 401, body: { reason: "Invalid client_id or client_secret", error: "invalid_client" } };
          const form = new URLSearchParams(request.body);
          if (form.get("grant_type") !== "account_credentials") return { status: 400, body: { reason: "Unsupported grant type", error: "unsupported_grant_type" } };
          if (form.get("account_id") !== data.accountId) return { status: 400, body: { reason: "Invalid account_id", error: "invalid_request" } };
          signIns++;
          const token = `zoomtok_${signIns}_${"x".repeat(24)}`;
          tokens.add(token);
          return { status: 200, body: { access_token: token, token_type: "bearer", expires_in: 3599, scope: scopes.join(" "), api_url: "https://api.zoom.us" } };
        },
      },
    ],
  });

  /** Pages a list with an opaque token, as Zoom does. */
  function paged(rows: ZoomMockRecord[], q: Record<string, string>): { rows: ZoomMockRecord[]; next: string } | DocMockResponse {
    const size = q.page_size === undefined ? 30 : Number(q.page_size);
    if (!Number.isInteger(size) || size < 1 || size > 300) return error(400, 300, "Invalid page_size");
    const decoded = q.next_page_token === undefined ? "offset:0" : Buffer.from(q.next_page_token, "base64url").toString("utf8");
    if (!/^offset:\d{1,6}$/.test(decoded)) return error(400, 300, "Invalid next_page_token");
    const offset = Number(decoded.slice(7));
    const take = Math.min(size, cap);
    return { rows: rows.slice(offset, offset + take), next: offset + take < rows.length ? Buffer.from(`offset:${offset + take}`).toString("base64url") : "" };
  }

  /** Checks the token, the scope and the rate limit, and logs the read. */
  function gate(headers: Headers, scope: string, path: string, q: Record<string, string>): DocMockResponse | null {
    const token = /^Bearer (\S+)$/.exec(headers.get("authorization") ?? "")?.[1];
    if (!token || !tokens.has(token)) return error(401, 124, "Invalid access token.");
    if (!scopes.includes(scope) && !scopes.includes("report:read:admin")) return error(400, 4711, `Invalid access token, does not contain scopes:[${scope}].`);
    if (limits > 0) {
      limits--;
      return error(429, 429, "You have reached the maximum per-second rate limit for this API.");
    }
    reads.push({ path, query: q });
    return null;
  }

  const api = checkDocMock({
    integration: "zoom",
    baseUrl: "https://api.zoom.us/v2",
    source: { url: DOCS.api, title: "Zoom Meetings API: Reports", retrievedOn: "2026-11-10", version: "v2" },
    auth: "bearer",
    assumptions: [
      "The meeting history lists a meeting by the day it started, in the account's time zone, once it has ended",
      "A participant who leaves and rejoins is listed once per join",
      "A 429 for the per-second limit carries no Retry-After header",
    ],
    routes: [
      {
        method: "GET",
        path: "/report/history_meetings",
        documentedAt: DOCS.api,
        respond(request) {
          const q = Object.fromEntries(request.url.searchParams);
          const denied = gate(request.headers, READ_SCOPES[0]!, "/report/history_meetings", q);
          if (denied) return denied;
          for (const name of Object.keys(q)) if (!["from", "to", "date_type", "meeting_type", "page_size", "next_page_token"].includes(name)) return error(400, 300, `Unknown parameter ${name}`);
          if (!DAY.test(q.from ?? "") || !DAY.test(q.to ?? "")) return error(400, 300, "Invalid from or to");
          const days = (Date.parse(q.to!) - Date.parse(q.from!)) / 86_400_000;
          if (!(days >= 0 && days <= 31)) return error(400, 300, "The date range must be within one month");
          if (q.date_type !== undefined && !["start_time", "end_time"].includes(q.date_type)) return error(400, 300, "Invalid date_type");
          if (q.meeting_type !== undefined && !["meeting", "webinar", "all"].includes(q.meeting_type)) return error(400, 300, "Invalid meeting_type");
          const byStart = q.date_type === "start_time";
          const rows = data.meetings
            .filter((m) => q.meeting_type !== "meeting" || m.type === "Meeting")
            .filter((m) => {
              const d = String(byStart ? m.start_time : m.end_time).slice(0, 10);
              return d >= q.from! && d <= q.to!;
            })
            .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
          const page = paged(rows, q);
          if ("status" in page) return page;
          return { status: 200, body: { from: q.from, to: q.to, page_size: Number(q.page_size ?? 30), next_page_token: page.next, history_meetings: page.rows } };
        },
      },
      {
        method: "GET",
        path: "/report/meetings/{meetingId}/participants",
        documentedAt: DOCS.api,
        respond(request, params) {
          const q = Object.fromEntries(request.url.searchParams);
          const denied = gate(request.headers, READ_SCOPES[1]!, "/report/meetings/{meetingId}/participants", { meetingId: params.meetingId!, ...q });
          if (denied) return denied;
          for (const name of Object.keys(q)) if (!["page_size", "next_page_token", "include_fields"].includes(name)) return error(400, 300, `Unknown parameter ${name}`);
          // The path segment arrives decoded once; a UUID with / in it must have been encoded twice.
          const segment = params.meetingId!;
          const uuid = segment.includes("%") ? decodeURIComponent(segment) : segment;
          if (uuid.startsWith("/") || uuid.includes("//") ? !segment.includes("%") : segment.includes("%")) return error(404, 3001, "Meeting does not exist.");
          const rows = data.participants?.[uuid];
          if (!rows) return error(404, 3001, "Meeting does not exist.");
          const page = paged(rows, q);
          if ("status" in page) return page;
          return { status: 200, body: { page_size: Number(q.page_size ?? 30), next_page_token: page.next, total_records: rows.length, participants: page.rows } };
        },
      },
    ],
  });

  const oauthFetch = docMockFetch(oauth);
  const apiFetch = docMockFetch(api);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      // Routed by exact origin, so a look-alike host goes to the API mock and is turned down there.
      const toOauth = new URL(input instanceof Request ? input.url : String(input)).origin === "https://zoom.us";
      const response = await (toOauth ? oauthFetch : apiFetch)(input, init);
      calls.push(...(toOauth ? oauthFetch.calls : apiFetch.calls).slice(-1));
      return response;
    },
    { calls },
  );

  return {
    oauth,
    api,
    fetch,
    expireTokens: () => tokens.clear(),
    get signIns() {
      return signIns;
    },
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "zoom",
  covers: "Zoom's Server-to-Server OAuth token, meeting history and meeting participant reports (API v2)",
  watchPages: [DOCS.oauth, DOCS.api],
  docMocks: () => {
    const mock = zoomDocMock({ accountId: "", clientId: "", clientSecret: "", meetings: [] });
    return [mock.oauth, mock.api];
  },
} satisfies DocMockModule;
