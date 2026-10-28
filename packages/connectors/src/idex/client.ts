/**
 * A small client for IDEX's Onsite feeds: the CSV files of IDEX diamond
 * listings a subscriber shows on its own website, with the filters and
 * markups it set on IDEX already applied. One POST carries the API key and
 * secret in its JSON body and answers the whole file. The addresses are
 * fixed here, so the secret only ever goes to IDEX.
 *
 * The file is asked for unzipped. IDEX makes a new one every hour or two
 * and answers the previous file until then, so a sync can't make it read
 * more often. An error is HTTP 500 with a result_info code and description.
 */

export const IDEX_FEEDS = {
  natural: { url: "https://api.idexonline.com/onsite/api/fullfeed", dataFormat: "format_20230628_extended" },
  lab_grown: { url: "https://api.idexonline.com/onsite/api/labgrownfullfile", dataFormat: "format_lg_20221130" },
} as const;
export type IdexFeed = keyof typeof IDEX_FEEDS;

/** The largest file the client reads, so a misconfigured feed can't fill memory. */
export const IDEX_MAX_BYTES = 200 * 1024 * 1024;
const MAX_RETRY_AFTER_S = 60;

export interface IdexClientOptions {
  apiKey: string;
  /** Sent to IDEX only, and never logged or shown. */
  apiSecret: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class IdexConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdexConfigError";
  }
}

/** IDEX answered with an error. `code` is its result_info response_code, when it gave one. */
export class IdexApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "IdexApiError";
  }
}

export interface IdexClient {
  /** The feed's CSV file, as text. */
  file(feed: IdexFeed): Promise<string>;
}

/** IDEX's error body: {"result_info": {"response_code": 32110, "response_description": "..."}}. */
function resultInfo(text: string): { code?: number; description?: string } | null {
  try {
    const info = (JSON.parse(text) as { result_info?: { response_code?: unknown; response_description?: unknown } } | null)?.result_info;
    if (!info) return null;
    return {
      ...(typeof info.response_code === "number" ? { code: info.response_code } : {}),
      ...(typeof info.response_description === "string" ? { description: info.response_description.slice(0, 200) } : {}),
    };
  } catch {
    return null;
  }
}

export function idexClient(options: IdexClientOptions): IdexClient {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(options.apiKey)) throw new IdexConfigError("IDEX_API_KEY is missing or not in the expected shape");
  if (!/^\S{8,256}$/.test(options.apiSecret)) throw new IdexConfigError("IDEX_API_SECRET is missing or not in the expected shape");
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.rateLimitRetries ?? 3;

  return {
    async file(feed) {
      const target = IDEX_FEEDS[feed];
      if (!target) throw new IdexConfigError(`not an IDEX Onsite feed: ${JSON.stringify(String(feed).slice(0, 20))}`);
      const parameters = feed === "natural" ? { file_format: "csv", data_format: target.dataFormat, create_zip_file: false } : { data_format: target.dataFormat, create_zip_file: false };
      const body = JSON.stringify({ authentication_details: { api_key: options.apiKey, api_secret: options.apiSecret }, parameters });
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(target.url, { method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8", Accept: "text/csv, application/json" }, body });
        if (response.status === 429 && attempt < retries) {
          const after = Number(response.headers.get("retry-after"));
          await sleep(1000 * (Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) : 2 ** attempt));
          continue;
        }
        if (Number(response.headers.get("content-length") ?? 0) > IDEX_MAX_BYTES) throw new IdexApiError(`the IDEX ${feed} file is larger than ${IDEX_MAX_BYTES / 1024 / 1024} MB; narrow the feed's filters on IDEX`, response.status);
        const text = await response.text();
        if (text.length > IDEX_MAX_BYTES) throw new IdexApiError(`the IDEX ${feed} file is larger than ${IDEX_MAX_BYTES / 1024 / 1024} MB; narrow the feed's filters on IDEX`, response.status);
        // An error can come back as JSON on any status, so it is checked before the file is used.
        const info = resultInfo(text);
        if (info || response.status !== 200) {
          // IDEX's own words, with the key and secret taken out in case it repeats them.
          const why = info?.description ? `: ${info.description.split(options.apiSecret).join("[hidden]").split(options.apiKey).join("[hidden]")}` : "";
          if (response.status === 401 || response.status === 403) throw new IdexApiError(`IDEX turned down the API key and secret${why}`, response.status, info?.code);
          throw new IdexApiError(`IDEX answered HTTP ${response.status} for the ${feed} feed${info?.code !== undefined ? ` (code ${info.code})` : ""}${why}`, response.status, info?.code);
        }
        if (/^\s*</.test(text)) throw new IdexApiError(`IDEX answered the ${feed} feed with a page, not a CSV file`, 200);
        if (/^PK\x03\x04/.test(text)) throw new IdexApiError(`IDEX answered the ${feed} feed with a zip file although an unzipped one was asked for`, 200);
        return text;
      }
    },
  };
}
