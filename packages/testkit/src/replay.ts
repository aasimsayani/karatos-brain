import { readFile } from "node:fs/promises";

/**
 * Recorded vendor responses for contract tests. A recording holds the
 * method, URL and response only: never request headers, so tokens can't be
 * saved by accident, and `scrubRecording` redacts secrets in URLs and
 * response headers before a recording is written to disk.
 */
export interface Recording {
  request: { method: string; url: string };
  response: { status: number; headers?: Record<string, string>; body: unknown };
}

export class UnrecordedRequestError extends Error {
  constructor(readonly method: string, readonly url: string) {
    super(`no recording left for ${method} ${url}`);
    this.name = "UnrecordedRequestError";
  }
}

export interface ReplayFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Every request made, in order. */
  readonly calls: { method: string; url: string }[];
  /** Recordings no request has used yet. A finished test should leave none. */
  unused(): Recording[];
}

/** Sorts query parameters so the same request always matches. */
export function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.sort();
  return parsed.toString();
}

const key = (method: string, url: string) => `${method.toUpperCase()} ${normalizeUrl(url)}`;

/**
 * A fetch that answers from recordings. Each recording answers one request;
 * several recordings for the same request answer in order, so a test can
 * replay a 429 followed by a 200.
 */
export interface ReplayOptions {
  /**
   * Let the last recording for a request answer again, for connectors that
   * re-request a page on retry. Off by default so tests catch extra calls.
   */
  reuse?: boolean;
}

export function replayFetch(recordings: readonly Recording[], options: ReplayOptions = {}): ReplayFetch {
  const queues = new Map<string, Recording[]>();
  for (const recording of recordings) {
    const k = key(recording.request.method, recording.request.url);
    queues.set(k, [...(queues.get(k) ?? []), recording]);
  }
  const calls: { method: string; url: string }[] = [];
  const used = new Set<Recording>();

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    calls.push({ method, url });
    const queue = queues.get(key(method, url)) ?? [];
    const recording = options.reuse && queue.length === 1 ? queue[0] : queue.shift();
    if (!recording) throw new UnrecordedRequestError(method, url);
    used.add(recording);
    const { status, headers = {}, body } = recording.response;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const contentType = typeof body === "string" ? "text/plain" : "application/json";
    return new Response(status === 204 || status === 304 ? null : text, {
      status,
      headers: { "content-type": contentType, ...headers },
    });
  };

  return Object.assign(fetch, {
    calls,
    unused: () => recordings.filter((r) => !used.has(r)),
  });
}

const SECRET_PARAMS = /^(access_token|api_key|apikey|key|token|client_secret|secret|signature|sig|password|code)$/i;
const SECRET_HEADERS = /^(set-cookie|cookie|authorization|x-api-key|x-shopify-access-token|proxy-authorization)$/i;
export const REDACTED = "REDACTED";

/** Redacts secret query parameters and drops secret response headers. */
export function scrubRecording(recording: Recording): Recording {
  const url = new URL(recording.request.url);
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_PARAMS.test(name)) url.searchParams.set(name, REDACTED);
  }
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  const headers = Object.fromEntries(
    Object.entries(recording.response.headers ?? {}).filter(([name]) => !SECRET_HEADERS.test(name)),
  );
  return {
    request: { method: recording.request.method.toUpperCase(), url: url.toString() },
    response: { ...recording.response, headers },
  };
}

/** Names the secret a recording still carries, or returns null when it is clean. */
export function findSecret(recording: Recording): string | null {
  const url = new URL(recording.request.url);
  if (url.username || url.password) return "credentials in the URL";
  for (const [name, value] of url.searchParams) {
    if (SECRET_PARAMS.test(name) && value !== REDACTED) return `query parameter ${name}`;
  }
  const header = Object.keys(recording.response.headers ?? {}).find((name) => SECRET_HEADERS.test(name));
  return header === undefined ? null : `response header ${header}`;
}

/** Throws if any recording still carries a secret. */
export function assertScrubbed(recordings: readonly Recording[]): void {
  for (const recording of recordings) {
    const secret = findSecret(recording);
    if (secret !== null) {
      const { origin, pathname } = new URL(recording.request.url);
      throw new Error(`recording for ${recording.request.method} ${origin}${pathname} holds ${secret}; scrub it first`);
    }
  }
}

function isRecording(value: unknown): value is Recording {
  if (typeof value !== "object" || value === null) return false;
  const { request, response } = value as Record<string, unknown>;
  if (typeof request !== "object" || request === null || typeof response !== "object" || response === null) return false;
  const req = request as Record<string, unknown>;
  const res = response as Record<string, unknown>;
  return typeof req.method === "string" && typeof req.url === "string" && typeof res.status === "number" && "body" in res;
}

/** Reads a JSON array of recordings and checks that none holds a secret. */
export async function loadRecordings(path: string): Promise<Recording[]> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every(isRecording)) {
    throw new Error(`${path} is not a list of recordings`);
  }
  assertScrubbed(parsed);
  return parsed;
}
