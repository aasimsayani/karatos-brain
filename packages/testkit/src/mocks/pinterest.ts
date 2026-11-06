import { createHash } from "node:crypto";
import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Pinterest's API (v5): the Pin list, account analytics, top Pins and the
 * OAuth refresh, built from Pinterest's OpenAPI description
 * (github.com/pinterest/api-description, v5/openapi.yaml). Data is synthetic.
 *
 * - List Pins: GET /pins with `page_size` (up to 250), `bookmark` and
 *   `pin_metrics`; answers `items` and `bookmark`, null on the last page.
 *   Needs boards:read and pins:read.
 * - Account analytics: GET /user_account/analytics with `start_date` and
 *   `end_date` (no more than 90 days back from today, and 90 days long at
 *   most) and `metric_types`; answers the report under "all", with
 *   `daily_metrics` of `date`, `data_status` and `metrics`. Needs
 *   user_accounts:read.
 * - Top Pins: GET /user_account/analytics/top_pins with the same range,
 *   `sort_by` and `num_of_pins` (up to 50); answers `pins` of `pin_id` and
 *   `metrics`. Needs pins:read and user_accounts:read.
 * - Create Pin: POST /pins needs pins:write. The mock counts each call, so
 *   a test can show the connector never sends one.
 * - Refresh: POST /oauth/token with Basic client credentials,
 *   grant_type=refresh_token; answers a new access token, the scopes it
 *   holds and a new continuous refresh token.
 */
const API = "https://api.pinterest.com/v5";
const SPEC = "https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml";
const METRICS = ["ENGAGEMENT", "ENGAGEMENT_RATE", "IMPRESSION", "OUTBOUND_CLICK", "OUTBOUND_CLICK_RATE", "PIN_CLICK", "PIN_CLICK_RATE", "SAVE", "SAVE_RATE"];
const SORTS = ["ENGAGEMENT", "SAVE", "IMPRESSION", "OUTBOUND_CLICK", "PIN_CLICK"];
const DAY_MS = 86_400_000;

export const PINTEREST_MOCK_READ_SCOPES = ["boards:read", "pins:read", "user_accounts:read"] as const;

/** A Pin as Pinterest writes it, trimmed to the fields the mock knows. */
export type PinterestMockPin = Record<string, unknown> & { id: string };

/** Pin n of the store's account, on one of two boards, linking to a product page. */
export const pinterestPin = fixtureBuilder<PinterestMockPin>((n) => ({
  id: String(1_000_000_000_000_000 + n),
  created_at: new Date(Date.parse("2026-01-01T12:00:00Z") + n * DAY_MS).toISOString().replace(".000Z", ""),
  title: `Test oval halo ring ${n}`,
  description: `Test description ${n}`,
  link: `https://shop.example.test/products/test-ring-${n}?utm_source=pinterest#reviews`,
  board_id: String(500_000 + (n % 2)),
  board_owner: { username: "test_store" },
  is_owner: true,
  is_product: n % 2 === 0,
  creative_type: "REGULAR",
  dominant_color: "#6E7874",
  pin_metrics: { "90d": { pin_click: 7 * n, impression: 100 * n, clickthrough: 3 * n }, lifetime_metrics: { pin_click: 9 * n, impression: 150 * n, clickthrough: 4 * n, reaction: n, comment: 0 } },
}));

export interface PinterestMockData {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** The day the mock takes as today, YYYY-MM-DD. */
  today: string;
  pins: PinterestMockPin[];
  /** Account metrics by day, YYYY-MM-DD. */
  daily: Record<string, Record<string, number>>;
  /** Metrics by Pin id over any range, for the top Pins report. */
  pinTotals: Record<string, Record<string, number>>;
  /** Scopes the connection holds. Defaults to the three read scopes. */
  scopes?: string[];
  /** Rows per page the mock caps at, below the page size asked for, to exercise paging. */
  pageCap?: number;
  /** How many of the next API calls answer 429. */
  rateLimited?: number;
}

export interface PinterestMock {
  oauth: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  /** How many refreshes were answered. */
  readonly refreshes: number;
  /** The path and query of every API read, in order. */
  readonly reads: { path: string; query: URLSearchParams }[];
  /** How many Pins were created. */
  readonly writes: number;
  revokeAccessTokens(): void;
}

const pinError = (status: number, code: number, message: string): DocMockResponse => ({ status, body: { code, message } });
const bookmarkOf = (key: string, offset: number) => Buffer.from(`${createHash("sha256").update(key).digest("hex").slice(0, 8)}:${offset}`).toString("base64url");
const isDay = (d: string | null) => d !== null && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

export function pinterestDocMock(data: PinterestMockData): PinterestMock {
  let refreshes = 0;
  let issued = 0;
  let writes = 0;
  const access = new Set<string>();
  const reads: { path: string; query: URLSearchParams }[] = [];
  const scopes = () => data.scopes ?? [...PINTEREST_MOCK_READ_SCOPES];

  const oauth = checkDocMock({
    integration: "pinterest",
    baseUrl: `${API}/oauth`,
    source: { url: SPEC, title: "Pinterest REST API v5 OpenAPI description", retrievedOn: "2026-10-31", version: "v5" },
    auth: "basic",
    assumptions: [
      "A refresh answers access_token, expires_in, scope and a new continuous refresh_token",
      "scope lists the connection's scopes, separated by commas or spaces",
      "A refresh token that was replaced or revoked answers 400",
    ],
    routes: [
      {
        method: "POST",
        path: "/token",
        documentedAt: SPEC,
        respond(request) {
          refreshes++;
          const form = new URLSearchParams(request.body);
          if (request.headers.get("authorization") !== `Basic ${Buffer.from(`${data.clientId}:${data.clientSecret}`).toString("base64")}`) return pinError(401, 2, "Authentication failed.");
          if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== data.refreshToken) return pinError(400, 1, "Invalid refresh token.");
          const token = `pina_TEST${++issued}`;
          access.add(token);
          data.refreshToken = `pinr_TEST${issued}`;
          return { status: 200, body: { access_token: token, token_type: "bearer", expires_in: 2_592_000, scope: scopes().join(","), refresh_token: data.refreshToken, refresh_token_expires_in: 5_184_000, response_type: "refresh_token" } };
        },
      },
    ],
  });

  /** Checks shared by every API call: the token, its scopes and the rate limit. */
  function denied(request: { headers: Headers }, needs: string[]): DocMockResponse | null {
    if (!access.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) return pinError(401, 2, "Authentication failed.");
    if (!needs.every((s) => scopes().includes(s))) return pinError(403, 29, "You are not permitted to access that resource.");
    if (data.rateLimited) {
      data.rateLimited--;
      return pinError(429, 8, "You have exceeded your rate limit. Try again later.");
    }
    return null;
  }

  /** The range of an analytics read, or an error answer. */
  function rangeOf(q: URLSearchParams): { start: string; end: string } | DocMockResponse {
    const start = q.get("start_date");
    const end = q.get("end_date");
    if (!isDay(start) || !isDay(end) || end! < start!) return pinError(400, 1, "Invalid parameters.");
    const today = Date.parse(`${data.today}T00:00:00Z`);
    if (Date.parse(`${start}T00:00:00Z`) < today - 90 * DAY_MS || Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`) > 90 * DAY_MS) return pinError(400, 1, "Parameter 'start_date' cannot be more than 90 days back from today.");
    const metrics = (q.get("metric_types") ?? "").split(",").filter(Boolean);
    if (!metrics.every((m) => METRICS.includes(m))) return pinError(400, 1, "Invalid parameters.");
    return { start: start!, end: end! };
  }

  const pick = (all: Record<string, number>, q: URLSearchParams) => {
    const metrics = (q.get("metric_types") ?? "").split(",").filter(Boolean);
    return Object.fromEntries(Object.entries(all).filter(([k]) => !metrics.length || metrics.includes(k)));
  };

  const api = checkDocMock({
    integration: "pinterest",
    baseUrl: API,
    source: { url: SPEC, title: "Pinterest REST API v5 OpenAPI description", retrievedOn: "2026-10-31", version: "v5" },
    auth: "bearer",
    assumptions: [
      "Analytics counts are JSON numbers",
      "An unsplit analytics report sits under the key \"all\"",
      "Analytics days are in UTC",
      "A bookmark is good only for the list it came from",
      "Analytics for an account that isn't a business account answer 403",
    ],
    routes: [
      {
        method: "GET",
        path: "/pins",
        documentedAt: SPEC,
        respond(request) {
          const no = denied(request, ["boards:read", "pins:read"]);
          if (no) return no;
          const q = new URL(request.url).searchParams;
          reads.push({ path: "/pins", query: q });
          const size = Number(q.get("page_size") ?? 25);
          if (!Number.isInteger(size) || size < 1 || size > 250) return pinError(400, 1, "Invalid parameters.");
          const key = [...q.entries()].filter(([k]) => k !== "bookmark").join("&");
          let offset = 0;
          const bookmark = q.get("bookmark");
          if (bookmark !== null) {
            const parts = Buffer.from(bookmark, "base64url").toString().split(":");
            if (parts.length !== 2 || bookmark !== bookmarkOf(key, Number(parts[1]))) return pinError(400, 1, "Invalid bookmark.");
            offset = Number(parts[1]);
          }
          const take = Math.min(size, data.pageCap ?? size);
          const withMetrics = q.get("pin_metrics") === "true";
          const items = data.pins.slice(offset, offset + take).map((p) => (withMetrics ? p : Object.fromEntries(Object.entries(p).filter(([k]) => k !== "pin_metrics"))));
          return { status: 200, body: { items, bookmark: offset + take < data.pins.length ? bookmarkOf(key, offset + take) : null } };
        },
      },
      {
        method: "POST",
        path: "/pins",
        documentedAt: SPEC,
        respond(request) {
          writes++;
          return denied(request, ["boards:read", "boards:write", "pins:read", "pins:write"]) ?? { status: 201, body: { id: "1" } };
        },
      },
      {
        method: "GET",
        path: "/user_account/analytics",
        documentedAt: SPEC,
        respond(request) {
          const no = denied(request, ["user_accounts:read"]);
          if (no) return no;
          const q = new URL(request.url).searchParams;
          reads.push({ path: "/user_account/analytics", query: q });
          const range = rangeOf(q);
          if (!("start" in range)) return range;
          const days = Object.keys(data.daily).filter((d) => d >= range.start && d <= range.end).sort();
          const daily_metrics = days.map((date) => ({ date, data_status: date >= data.today ? "PROCESSING" : "READY", metrics: pick(data.daily[date]!, q) }));
          return { status: 200, body: { all: { daily_metrics, summary_metrics: {} } } };
        },
      },
      {
        method: "GET",
        path: "/user_account/analytics/top_pins",
        documentedAt: SPEC,
        respond(request) {
          const no = denied(request, ["pins:read", "user_accounts:read"]);
          if (no) return no;
          const q = new URL(request.url).searchParams;
          reads.push({ path: "/user_account/analytics/top_pins", query: q });
          const range = rangeOf(q);
          if (!("start" in range)) return range;
          const sort = q.get("sort_by") ?? "";
          const count = Number(q.get("num_of_pins") ?? 10);
          if (!SORTS.includes(sort) || !Number.isInteger(count) || count < 1 || count > 50) return pinError(400, 1, "Invalid parameters.");
          const pins = Object.entries(data.pinTotals)
            .sort(([, a], [, b]) => (b[sort] ?? 0) - (a[sort] ?? 0))
            .slice(0, count)
            .map(([pin_id, metrics]) => ({ pin_id, metrics: pick(metrics, q), data_status: { [range.end]: "READY" } }));
          return { status: 200, body: { date_availability: { is_realtime: false, latest_available_timestamp: Date.parse(`${data.today}T00:00:00Z`) }, pins, sort_by: sort } };
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
      const target = mocks.find((m) => url.origin === new URL(m.base).origin && url.pathname.startsWith(new URL(m.base).pathname)) ?? mocks[1]!;
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
    reads,
    get writes() {
      return writes;
    },
    revokeAccessTokens: () => access.clear(),
  };
}

export default {
  integration: "pinterest",
  covers: "Pinterest's API v5 Pin list, account analytics, top Pins and Pin creation with its OAuth refresh, enforcing the client credentials, each token's scopes, the 90-day analytics window, page sizes, metrics and bookmarks tied to their list",
  watchPages: [SPEC],
  docMocks: () => {
    const mock = pinterestDocMock({ clientId: "", clientSecret: "", refreshToken: "", today: "2026-10-31", pins: [], daily: {}, pinTotals: {} });
    return [mock.oauth, mock.api];
  },
} satisfies DocMockModule;
