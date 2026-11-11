import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Verkada's Command API token and occupancy trends, built from Verkada's
 * API docs. Data is synthetic. Occupancy Trends needs Verkada cameras with
 * the feature turned on, so a client's organization replaces this mock on
 * the first live run.
 *
 * Docs facts the mock relies on:
 * - An organization admin makes an API key that is read-only or
 *   read/write; POST /token with the key in `x-api-key` answers
 *   {"token": ...}, good for 30 minutes, and calls send it in
 *   `x-verkada-auth`. The US address is api.verkada.com and the EU's
 *   api.eu.verkada.com (quick start guide).
 * - GET /cameras/v1/occupancy_trend_enabled answers each camera_id with its
 *   line presets' preset_ids (occupancy trends cameras).
 * - GET /cameras/v1/analytics/occupancy_trends takes camera_id, start_time
 *   and end_time (Unix seconds), interval (15_minutes, 1_hour, 1_day),
 *   type (person, vehicle) and preset_id, and answers the camera's id,
 *   name and site, the range, and trend_in and trend_out, each an array of
 *   range timestamps and a count (occupancy trends).
 * - 401 is a missing or expired key, 403 a key without the permission, 429
 *   past 300 calls a minute (request methods).
 */
const DOCS = "https://apidocs.verkada.com/reference";
export const VERKADA_DOC_PAGES = {
  quickStart: `${DOCS}/quick-start-guide`,
  cameras: `${DOCS}/getoccupancytrendscamerasviewv1`,
  trends: `${DOCS}/getoccupancytrendsview`,
  requests: `${DOCS}/request-methods`,
} as const;

export const VERKADA_BASE = "https://api.verkada.com";

export interface VerkadaMockCamera {
  camera_id: string;
  preset_ids: string[];
  camera_name?: string;
  camera_site?: string;
}

export interface VerkadaMockData {
  apiKey: string;
  cameras?: VerkadaMockCamera[];
  /** People in and out across a line in the hour starting at `start` (Unix seconds); 3 in and 2 out unless given. */
  count?: (cameraId: string, presetId: string, start: number) => [number, number] | null;
  /** 429s to answer before the next calls. */
  rateLimits?: number;
}

/** A front-door camera at the main store, counting across one line. */
export const verkadaCamera = (n: number): VerkadaMockCamera => ({ camera_id: `cam-test-${n}`, preset_ids: [`line-test-${n}`], camera_name: `Front door ${n}`, camera_site: "Main Store" });

export interface VerkadaMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each counts read: camera, preset and range. */
  readonly reads: { camera: string; preset: string; start: number; end: number }[];
  /** How many tokens were handed out. */
  readonly tokens: number;
  /** Makes every token handed out so far stop working, as if 30 minutes had passed. */
  expireTokens(): void;
}

const HOUR_S = 3600;

export function verkadaDocMock(data: VerkadaMockData): VerkadaMock {
  const reads: { camera: string; preset: string; start: number; end: number }[] = [];
  const live = new Set<string>();
  let issued = 0;
  let limits = data.rateLimits ?? 0;
  const message = (status: number, text: string): DocMockResponse => ({ status, body: { id: "test", message: text, data: null } });
  const limited = (): DocMockResponse | null => {
    if (limits <= 0) return null;
    limits--;
    return message(429, "API rate limit has been exceeded");
  };
  const authed = (headers: Headers) => live.has(headers.get("x-verkada-auth") ?? "");
  const cameras = () => data.cameras ?? [];

  const api = checkDocMock({
    integration: "verkada",
    baseUrl: VERKADA_BASE,
    source: { url: VERKADA_DOC_PAGES.quickStart, title: "Verkada API: quick start, occupancy trends cameras and occupancy trends", retrievedOn: "2026-11-11", version: "v1" },
    assumptions: [
      "The cameras answer comes under cameras",
      "Each trend_in and trend_out entry is [start, end, count] in Unix seconds",
      "A week at 1_hour is one answer, with no paging",
      "preset_id picks the counting line, and a camera's lines are counted apart",
      "The API key is 20 to 200 letters, digits, _ and -",
    ],
    routes: [
      {
        method: "POST",
        path: "/token",
        documentedAt: VERKADA_DOC_PAGES.quickStart,
        respond(request) {
          const busy = limited();
          if (busy) return busy;
          if (request.headers.get("x-api-key") !== data.apiKey) return message(401, "Missing or invalid API key");
          const token = `token-${++issued}`;
          live.add(token);
          return { status: 200, body: { token } };
        },
      },
      {
        method: "GET",
        path: "/cameras/v1/occupancy_trend_enabled",
        documentedAt: VERKADA_DOC_PAGES.cameras,
        respond(request) {
          const busy = limited();
          if (busy) return busy;
          if (!authed(request.headers)) return message(401, "Missing or invalid API key");
          return { status: 200, body: { cameras: cameras().map((c) => ({ camera_id: c.camera_id, preset_ids: c.preset_ids })) } };
        },
      },
      {
        method: "GET",
        path: "/cameras/v1/analytics/occupancy_trends",
        documentedAt: VERKADA_DOC_PAGES.trends,
        respond(request) {
          const busy = limited();
          if (busy) return busy;
          if (!authed(request.headers)) return message(401, "Missing or invalid API key");
          const q = Object.fromEntries(request.url.searchParams);
          for (const name of Object.keys(q)) if (!["camera_id", "start_time", "end_time", "interval", "type", "preset_id"].includes(name)) return message(400, `Unknown parameter ${name}`);
          const camera = cameras().find((c) => c.camera_id === q.camera_id);
          if (!camera) return message(400, "camera_id is not a camera with Occupancy Trends");
          if (!q.preset_id || !camera.preset_ids.includes(q.preset_id)) return message(400, "preset_id is required and must be one of the camera's line presets");
          if (q.interval !== undefined && !["15_minutes", "1_hour", "1_day"].includes(q.interval)) return message(400, "Invalid interval");
          if (q.type !== undefined && !["person", "vehicle"].includes(q.type)) return message(400, "Invalid type");
          const start = Number(q.start_time);
          const end = Number(q.end_time);
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return message(400, "start_time and end_time must be Unix seconds, end after start");
          reads.push({ camera: camera.camera_id, preset: q.preset_id, start, end });
          const trendIn: number[][] = [];
          const trendOut: number[][] = [];
          // Hourly counts only, which is what the connector asks for.
          for (let h = Math.ceil(start / HOUR_S) * HOUR_S; h + HOUR_S <= end; h += HOUR_S) {
            const counts: [number, number] | null = data.count ? data.count(camera.camera_id, q.preset_id, h) : [3, 2];
            if (!counts) continue;
            trendIn.push([h, h + HOUR_S, counts[0]]);
            trendOut.push([h, h + HOUR_S, counts[1]]);
          }
          return {
            status: 200,
            body: { camera_id: camera.camera_id, camera_name: camera.camera_name, camera_site: camera.camera_site, camera_address: "1 Test Street, Testville", org_id: "org-test", org_name: "Test Org", start_time: start, end_time: end, type: q.type ?? "person", trend_in: trendIn, trend_out: trendOut },
          };
        },
      },
    ],
  });
  return {
    api,
    fetch: docMockFetch(api),
    get reads() {
      return reads;
    },
    get tokens() {
      return issued;
    },
    expireTokens() {
      live.clear();
    },
  };
}

export default {
  integration: "verkada",
  covers: "Verkada's API token, occupancy trends cameras and occupancy trends",
  watchPages: [VERKADA_DOC_PAGES.quickStart, VERKADA_DOC_PAGES.cameras, VERKADA_DOC_PAGES.trends],
  docMocks: () => [verkadaDocMock({ apiKey: "" }).api],
} satisfies DocMockModule;
