/**
 * A small client for Sola Payments' Reporting API (formerly Cardknox). Sola
 * gives each account API keys from its portal, and a key can run sales and
 * refunds as well as reports. Sola documents no way to limit one to
 * reports, so this client is what keeps KaratOS to reading: it posts only
 * to the reporting address (never the gateway, which moves money), only the
 * one command Report:All, with dates it builds itself from checked values.
 *
 * Sola answers errors in the body (xResult "E", with xError and
 * xErrorCode), and this client never puts Sola's error text, which could
 * echo what was sent, in its own errors: only the code. A 429 and 500, 502,
 * 503 and 504 are waited out a few times before the error goes to runSync,
 * which keeps the checkpoint.
 */

export const SOLA_REPORT_URL = "https://x1.cardknox.com/reportjson";
/** The only command this client sends. */
export const SOLA_REPORT_COMMAND = "Report:All";
export const SOLA_API_VERSION = "5.0.0";
/** Transactions asked for at a time: the most Sola returns for a range longer than a day. */
export const SOLA_REPORT_PAGE = 1000;
const MAX_RETRY_AFTER_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
/** A wall-clock time as Sola's report dates take it. */
export const SOLA_DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export interface SolaClientOptions {
  /** Sent to Sola only, and never logged or shown. */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class SolaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolaConfigError";
  }
}

/** Sola answered with an error. `code` is Sola's xErrorCode, when it gave one that reads. */
export class SolaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "SolaApiError";
  }
}

export interface SolaClient {
  /** The oldest transactions (up to SOLA_REPORT_PAGE) entered from `begin` to `end`, both wall-clock times in the account's time zone. */
  transactions(begin: string, end: string): Promise<unknown[]>;
}

/** Sola's error code, when it is one: digits only. */
const errorCode = (v: unknown) => (typeof v === "string" && /^\d{1,8}$/.test(v) ? v : undefined);

export function solaClient(options: SolaClientOptions): SolaClient {
  const apiKey = options.apiKey?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{16,250}$/.test(apiKey)) throw new SolaConfigError("SOLA_API_KEY is missing or not in the expected shape");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;

  return {
    async transactions(begin, end) {
      if (!SOLA_DATE_TIME.test(begin) || !SOLA_DATE_TIME.test(end) || begin > end) throw new SolaApiError("a report must run from one YYYY-MM-DD HH:MM:SS time to a later one", 0);
      const body = JSON.stringify({
        xKey: apiKey,
        xVersion: SOLA_API_VERSION,
        xSoftwareName: "KaratOS",
        xSoftwareVersion: "1.0",
        xCommand: SOLA_REPORT_COMMAND,
        xBeginDate: begin,
        xEndDate: end,
        xGetNewest: false,
        xMaxRecords: SOLA_REPORT_PAGE,
      });
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        response = await doFetch(SOLA_REPORT_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body });
        if (!RETRIED.has(response.status) || attempt >= retries) break;
        const after = Number(response.headers.get("retry-after"));
        await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : 1000 * 2 ** attempt);
      }
      const { status } = response;
      if (status === 401 || status === 403) throw new SolaConfigError(`Sola turned down SOLA_API_KEY (HTTP ${status})`);
      if (status !== 200) throw new SolaApiError(`Sola answered HTTP ${status} for the transaction report`, status);
      const page = (await response.json().catch(() => undefined)) as Record<string, unknown> | null | undefined;
      if (page?.xResult === "E") {
        const code = errorCode(page.xErrorCode);
        // Sola says a key it doesn't take in words only, so its own message is matched, never repeated.
        if (/\bx?key\b/i.test(String(page.xError))) throw new SolaConfigError(`Sola turned down SOLA_API_KEY${code ? ` (code ${code})` : ""}`);
        throw new SolaApiError(`Sola answered the transaction report with an error${code ? ` (code ${code})` : ""}`, 200, code);
      }
      if (!Array.isArray(page?.xReportData)) throw new SolaApiError("Sola answered the transaction report without its rows", 200);
      return page!.xReportData as unknown[];
    },
  };
}
