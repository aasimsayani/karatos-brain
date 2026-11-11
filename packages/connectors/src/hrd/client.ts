import { parseXml, textAt, XmlError, type XmlElement } from "./xml.js";

/**
 * A small client for HRD Antwerp's public MyHRD API. HRD issues one API
 * token per request through MyHRD, sent in the API-Token header, and the
 * API has two reads only: a report's data by report number, and which of
 * up to 1000 report numbers are still valid. There is nothing to write, so
 * the token can do nothing but read. Answers are XML.
 *
 * HRD allows 5 requests a second, 100 in 15 minutes and 1000 in 12 hours,
 * and answers past them with 429; the client waits a quarter second
 * between requests and waits out a 429 and 500, 502, 503 and 504 a few
 * times before the error goes to runSync, which keeps the checkpoint. The
 * validity check answers only from 19:00 to 04:00 UTC and 401 otherwise.
 * A 400 means HRD didn't take the token. Nothing HRD sends back is put in
 * an error, and neither is the token.
 */

/** Only HRD's own host receives the token. */
export const HRD_API_URL = "https://my.hrdantwerp.com/api/public";
/** Report numbers as HRD prints them: digits on diamond reports, J and digits on jewellery reports. */
export const HRD_REPORT_NUMBER = /^[A-Z]{0,2}\d{6,14}$/;
/** Report numbers one validity check takes. */
export const HRD_VALIDITY_BATCH = 1000;
/** Milliseconds between requests, inside HRD's five a second. */
export const HRD_SPACING_MS = 250;
const MAX_RETRY_AFTER_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
const DATE = /^\d{4}-\d{2}-\d{2}/;

export interface HrdClientOptions {
  /** Sent to HRD only, and never logged or shown. */
  apiToken: string;
  fetch?: typeof globalThis.fetch;
  /** Waits between requests and before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class HrdConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HrdConfigError";
  }
}

export class HrdApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HrdApiError";
  }
}

/** What a lookup found. */
export type HrdLookup = { kind: "found"; report: XmlElement } | { kind: "not_found" };

/** When a report number's report took effect and until when it holds, as the validity check says. */
export interface HrdValidity {
  validFrom: string;
  validUntil: string | null;
}

export interface HrdClient {
  report(reportNumber: string): Promise<HrdLookup>;
  /** The numbers among these that HRD says are valid, or null outside the hours HRD answers. */
  validities(reportNumbers: string[]): Promise<Map<string, HrdValidity> | null>;
}

export function hrdClient(options: HrdClientOptions): HrdClient {
  const token = options.apiToken?.trim() ?? "";
  if (!/^[A-Za-z0-9._~+/=-]{16,512}$/.test(token)) throw new HrdConfigError("HRD_API_TOKEN is missing or not in the expected shape");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  let sent = false;

  async function send(path: string, init: { method: "GET" | "POST"; body?: string }, what: string): Promise<Response> {
    const headers: Record<string, string> = { "API-Token": token, accept: "application/xml" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      if (sent) await sleep(HRD_SPACING_MS);
      sent = true;
      response = await doFetch(`${HRD_API_URL}${path}`, { method: init.method, headers, body: init.body });
      if (!RETRIED.has(response.status) || attempt >= retries) break;
      const after = Number(response.headers.get("retry-after"));
      await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : 1000 * 2 ** attempt);
    }
    if (response.status === 400 || response.status === 403) throw new HrdConfigError(`HRD turned down HRD_API_TOKEN (HTTP ${response.status})`);
    if (response.status === 429) throw new HrdApiError(`HRD's request limit was reached during ${what}; the rest waits for the next sync`, 429);
    return response;
  }

  async function xml(response: Response, what: string): Promise<XmlElement> {
    try {
      return parseXml(await response.text());
    } catch (e) {
      if (e instanceof XmlError) throw new HrdApiError(`HRD answered ${what} with XML that doesn't read`, response.status);
      throw e;
    }
  }

  return {
    async report(reportNumber) {
      if (!HRD_REPORT_NUMBER.test(reportNumber)) throw new HrdConfigError(`not an HRD report number: ${JSON.stringify(reportNumber.slice(0, 20))}`);
      const response = await send(`/GetReport/${reportNumber}`, { method: "GET" }, "a report lookup");
      if (response.status === 404) return { kind: "not_found" };
      if (response.status !== 200) throw new HrdApiError(`HRD answered HTTP ${response.status} for a report lookup`, response.status);
      const report = await xml(response, "a report lookup");
      if (report.name.toLowerCase() !== "report") throw new HrdApiError("HRD answered a report lookup without a report", 200);
      // HRD documents no answer for a number it doesn't know: one that carries no report number, or another one, is taken as none.
      return textAt(report, "ReportNumber")?.toUpperCase() === reportNumber ? { kind: "found", report } : { kind: "not_found" };
    },

    async validities(reportNumbers) {
      if (reportNumbers.length === 0 || reportNumbers.length > HRD_VALIDITY_BATCH || !reportNumbers.every((n) => HRD_REPORT_NUMBER.test(n))) {
        throw new HrdConfigError(`a validity check takes 1 to ${HRD_VALIDITY_BATCH} HRD report numbers`);
      }
      const response = await send("/GetReportValidities", { method: "POST", body: JSON.stringify(reportNumbers) }, "the validity check");
      if (response.status === 401) return null;
      if (response.status !== 200) throw new HrdApiError(`HRD answered HTTP ${response.status} for the validity check`, response.status);
      const root = await xml(response, "the validity check");
      if (root.name.toLowerCase() !== "validreports") throw new HrdApiError("HRD answered the validity check without its list", 200);
      const asked = new Set(reportNumbers);
      const valid = new Map<string, HrdValidity>();
      for (const entry of root.children) {
        const number = textAt(entry, "ReportNumber")?.toUpperCase();
        const from = textAt(entry, "ValidFrom");
        if (!number || !asked.has(number) || !from || !DATE.test(from)) continue;
        const until = textAt(entry, "ValidUntil");
        valid.set(number, { validFrom: from.slice(0, 10), validUntil: until && DATE.test(until) ? until.slice(0, 10) : null });
      }
      return valid;
    },
  };
}
