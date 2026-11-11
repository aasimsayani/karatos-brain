/**
 * A small client for Verkada's Command API, for the store's people counts.
 * Verkada gives an organization's admin API keys that are read-only or
 * read/write, and KaratOS asks only for a read-only key. The key is traded
 * for a token that lasts 30 minutes (`POST /token` with the key in
 * `x-api-key`), and each call sends the token in `x-verkada-auth`. The
 * client sends only that and two GETs:
 *
 * - `GET /cameras/v1/occupancy_trend_enabled`: the cameras that count
 *   people, with the line presets each one counts across;
 * - `GET /cameras/v1/analytics/occupancy_trends`: for one camera and
 *   preset, people in and out each hour over a time range.
 *
 * The token is kept until five minutes before it lapses, and fetched again
 * once if a call is turned down. Verkada allows 300 calls a minute for an
 * organization, enforced 25 to each five seconds, so calls are spaced a
 * quarter second apart, and a 429 or 500, 502, 503 or 504 is waited out a
 * few times (five seconds at first, doubling) before the error goes to
 * runSync, which keeps the checkpoint.
 */

export const VERKADA_REGIONS = new Map([
  ["us", "https://api.verkada.com"],
  ["eu", "https://api.eu.verkada.com"],
]);
/** Calls are spaced this far apart, to stay inside 25 every five seconds. */
export const VERKADA_SPACING_MS = 250;
/** How long a token lasts, and how long before that it is fetched again. */
export const VERKADA_TOKEN_MS = 30 * 60_000;
const TOKEN_MARGIN_MS = 5 * 60_000;
const RETRIED = new Set([429, 500, 502, 503, 504]);
const API_KEY = /^[A-Za-z0-9_-]{20,200}$/;
/** Verkada's camera ids and preset ids are GUIDs or other plain ids. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface VerkadaClientOptions {
  /** A read-only API key (VERKADA_API_KEY). Sent to Verkada only, and never logged or shown. */
  apiKey: string;
  /** Where the organization's data lives: us (the default) or eu (VERKADA_REGION). */
  region?: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before a call or a retry; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock calls are spaced and tokens timed by; replaced in tests. */
  clock?: () => number;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class VerkadaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerkadaConfigError";
  }
}

export class VerkadaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VerkadaApiError";
  }
}

/** A camera that counts people, and the line presets it counts across. */
export interface VerkadaCamera {
  cameraId: string;
  presetIds: string[];
}

export interface VerkadaClient {
  /** The cameras with occupancy trends turned on. */
  cameras(): Promise<VerkadaCamera[]>;
  /** People in and out each hour across one camera's preset line, from `start` to `end` (Unix seconds). */
  trends(cameraId: string, presetId: string, start: number, end: number): Promise<unknown>;
}

export function verkadaClient(options: VerkadaClientOptions): VerkadaClient {
  const key = options.apiKey?.trim() ?? "";
  if (!API_KEY.test(key)) throw new VerkadaConfigError("VERKADA_API_KEY is missing or not in the expected shape");
  const base = VERKADA_REGIONS.get((options.region ?? "us").trim().toLowerCase());
  if (!base) throw new VerkadaConfigError("VERKADA_REGION must be us or eu");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock ?? Date.now;
  const retries = options.retries ?? 3;
  let lastCall = Number.NEGATIVE_INFINITY;
  let token: { value: string; until: number } | null = null;

  /** One call, spaced from the last and retried on a 429 or 5xx. */
  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + VERKADA_SPACING_MS - clock();
      if (wait > 0) await sleep(wait);
      lastCall = clock();
      const response = await doFetch(url, init);
      if (RETRIED.has(response.status) && attempt < retries) {
        await sleep(5000 * 2 ** attempt);
        continue;
      }
      return response;
    }
  }

  async function signIn(): Promise<string> {
    if (token && clock() < token.until) return token.value;
    const response = await send(`${base}/token`, { method: "POST", headers: { "x-api-key": key, accept: "application/json" } });
    if (response.status === 400 || response.status === 401 || response.status === 403) throw new VerkadaConfigError("Verkada turned down VERKADA_API_KEY: check it, that it hasn't expired, and VERKADA_REGION");
    if (response.status !== 200) throw new VerkadaApiError(`Verkada answered HTTP ${response.status} for a token`, response.status);
    const body = (await response.json().catch(() => undefined)) as { token?: unknown } | undefined;
    if (typeof body?.token !== "string" || !/^\S{1,4096}$/.test(body.token)) throw new VerkadaApiError("Verkada answered without a token", 200);
    token = { value: body.token, until: clock() + VERKADA_TOKEN_MS - TOKEN_MARGIN_MS };
    return token.value;
  }

  /** A GET with the token, signed in again once if the token is turned down. */
  async function get(path: string, query: [string, string][], what: string): Promise<unknown> {
    const url = new URL(`${base}${path}`);
    for (const [name, value] of query) url.searchParams.set(name, value);
    for (let fresh = false; ; fresh = true) {
      const response = await send(url.toString(), { method: "GET", headers: { "x-verkada-auth": await signIn(), accept: "application/json" } });
      if (response.status === 401 && !fresh) {
        token = null;
        continue;
      }
      if (response.status === 403) throw new VerkadaConfigError(`VERKADA_API_KEY can't read ${what}: check that Occupancy Trends is on for these cameras and the key can see them`);
      if (response.status === 401) throw new VerkadaConfigError("Verkada turned down the token VERKADA_API_KEY was traded for: check the key hasn't expired");
      if (response.status !== 200) throw new VerkadaApiError(`Verkada answered HTTP ${response.status} for ${what}`, response.status);
      const body = await response.json().catch(() => undefined);
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new VerkadaApiError(`Verkada answered ${what} with something other than an object`, 200);
      return body;
    }
  }

  return {
    async cameras() {
      const body = (await get("/cameras/v1/occupancy_trend_enabled", [], "the cameras")) as { cameras?: unknown };
      if (!Array.isArray(body.cameras)) throw new VerkadaApiError("Verkada answered the cameras without a list", 200);
      const out: VerkadaCamera[] = [];
      for (const raw of body.cameras as unknown[]) {
        const c = (raw ?? {}) as { camera_id?: unknown; preset_ids?: unknown };
        // A camera or preset id that doesn't read is never sent back to Verkada.
        if (typeof c.camera_id !== "string" || !ID.test(c.camera_id) || !Array.isArray(c.preset_ids)) continue;
        const presetIds = c.preset_ids.filter((p): p is string => typeof p === "string" && ID.test(p));
        if (presetIds.length > 0) out.push({ cameraId: c.camera_id, presetIds });
      }
      return out;
    },
    async trends(cameraId, presetId, start, end) {
      if (!ID.test(cameraId) || !ID.test(presetId)) throw new VerkadaApiError("a camera and preset must be plain ids", 0);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw new VerkadaApiError("a range must be whole seconds, ending after it starts", 0);
      return get(
        "/cameras/v1/analytics/occupancy_trends",
        [
          ["camera_id", cameraId],
          ["preset_id", presetId],
          ["start_time", String(start)],
          ["end_time", String(end)],
          ["interval", "1_hour"],
          ["type", "person"],
        ],
        "the people counts",
      );
    },
  };
}
