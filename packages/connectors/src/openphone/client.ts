/**
 * A small client for Quo's public API (formerly OpenPhone), version
 * 2026-03-30: the workspace's calls and text messages. Quo issues one kind
 * of API key, made by a workspace owner or admin, and "each key has full
 * access to your workspace's API": the same key can send texts, change
 * contacts and add webhooks. So this client is what keeps KaratOS to
 * reading. It only ever sends two GETs, List calls and List messages, to
 * Quo's fixed address, with filters it builds itself from checked values
 * and the page cursor Quo gave it.
 *
 * Quo allows 10 requests a second per key and answers 429 past it, without
 * a Retry-After header; that and 500, 502, 503 and 504 are waited out a few
 * times, backing off, before the error goes to runSync, which keeps the
 * checkpoint.
 */

export const QUO_API_URL = "https://api.quo.com";
/** Sent on every request, as Quo requires; a dated version never changes once it ships. */
export const QUO_API_VERSION = "2026-03-30";
/** Calls or messages asked for at a time: Quo's largest page. */
export const QUO_PAGE_SIZE = 50;
const MAX_RETRY_AFTER_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
/** A UTC time as the client sends it. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Quo's page cursors are base64url text, such as eyJsYXN0SWQiOiJVU211a09NaXBhIn0. */
export const QUO_CURSOR = /^[A-Za-z0-9_=-]{1,1024}$/;

export interface QuoClientOptions {
  /** Sent to Quo only, and never logged or shown. */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class QuoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoConfigError";
  }
}

/** Quo answered with an error. `title` is Quo's error class, when it gave one that reads. */
export class QuoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly title?: string,
  ) {
    super(message);
    this.name = "QuoApiError";
  }
}

export type QuoKind = "calls" | "messages";

export interface QuoPageQuery {
  /** Created from this time, to `until`. */
  from: string;
  until: string;
  /** The cursor Quo gave for the next page, or null for the first. */
  after: string | null;
}

export interface QuoPage {
  rows: unknown[];
  /** The cursor for the next page, or null when this was the last. */
  next: string | null;
}

export interface QuoClient {
  /** One page of the workspace's calls or messages created in a span, newest first. */
  page(kind: QuoKind, query: QuoPageQuery): Promise<QuoPage>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Quo's error class from its envelope ({title, message, docs, trace}), when it is a few plain words. */
export function quoErrorTitle(body: unknown): string | undefined {
  const title = isObject(body) ? body.title : undefined;
  return typeof title === "string" && /^[A-Za-z ]{1,40}$/.test(title) ? title : undefined;
}

export function quoClient(options: QuoClientOptions): QuoClient {
  const apiKey = options.apiKey?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(apiKey)) throw new QuoConfigError("QUO_API_KEY is missing or not in the expected shape");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  // Quo takes the key as it is, with no "Bearer".
  const headers = { Authorization: apiKey, Accept: "application/json", "Quo-Api-Version": QUO_API_VERSION };

  async function get(url: URL, what: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url.toString(), { method: "GET", headers });
      if (RETRIED.has(response.status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : 1000 * 2 ** attempt);
        continue;
      }
      const body: unknown = await response.json().catch(() => undefined);
      const title = quoErrorTitle(body);
      if (response.status === 401) throw new QuoApiError("Quo turned down the API key: check QUO_API_KEY, and that it wasn't deleted in Workspace Settings > API", 401, title);
      if (response.status === 403) throw new QuoApiError(`Quo's workspace isn't allowed to read ${what}: the API may be turned off for it`, 403, title);
      if (response.status !== 200) throw new QuoApiError(`Quo answered HTTP ${response.status} for ${what}${title ? ` (${title})` : ""}`, response.status, title);
      if (!isObject(body)) throw new QuoApiError(`Quo answered ${what} with a body that isn't a JSON object`, 200);
      return body;
    }
  }

  return {
    async page(kind, query) {
      if (!ISO.test(query.from) || !ISO.test(query.until)) throw new QuoApiError(`${kind} must be listed between UTC times`, 0);
      if (query.after !== null && !QUO_CURSOR.test(query.after)) throw new QuoApiError(`${kind} page cursor is not in the expected shape`, 0);
      const url = new URL(`/${kind}`, QUO_API_URL);
      // List calls takes inclusive bounds and List messages exclusive ones; a later pass's overlap covers the difference.
      const [gte, lte] = kind === "calls" ? ["gte", "lte"] : ["gt", "lt"];
      url.searchParams.set(`createdAt[${gte}]`, query.from);
      url.searchParams.set(`createdAt[${lte}]`, query.until);
      url.searchParams.set("limit", String(QUO_PAGE_SIZE));
      if (query.after !== null) url.searchParams.set("after", query.after);
      const body = await get(url, kind);
      if (!Array.isArray(body.data)) throw new QuoApiError(`Quo answered ${kind} without the data list`, 200);
      const next = body.nextCursor;
      if (next !== null && (typeof next !== "string" || !QUO_CURSOR.test(next))) throw new QuoApiError(`Quo answered ${kind} with a next cursor that doesn't read`, 200);
      return { rows: body.data, next };
    },
  };
}
