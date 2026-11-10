import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Sola Payments' Reporting API (formerly Cardknox), built from
 * docs.solapayments.com. Data is synthetic. Sola has a free sandbox; until
 * one is set up, this mock stands in, and a sandbox run confirms it.
 *
 * Docs facts the mock relies on:
 * - POST https://x1.cardknox.com/reportjson (GET isn't supported) with
 *   xKey, xVersion, xSoftwareName, xSoftwareVersion and xCommand.
 *   Report:All takes xBeginDate and xEndDate as YYYY-MM-DD or
 *   YYYY-MM-DD HH:MM:SS, xGetNewest and xMaxRecords (1 to 1000, or 5000
 *   within 24 hours) (reporting).
 * - An answer carries xResult, xStatus, xError, xRefNum,
 *   xRecordsReturned and xReportData; past xReportingMaxTransactions rows,
 *   the next request starts at the last row's time (reporting).
 * - Gateway times read like 3/3/2022 7:36:34 AM (credit-card).
 */
const DOCS = {
  reporting: "https://docs.solapayments.com/api/reporting",
} as const;
export const SOLA_DOC_PAGES = DOCS;

export type SolaMockRecord = Record<string, unknown>;

export interface SolaMockData {
  apiKey: string;
  /** Rows with xEnteredDate as Sola writes it; the mock pages on it. */
  rows: SolaMockRecord[];
  /** 429s to answer before the next reads. */
  rateLimits?: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A wall-clock time (YYYY-MM-DD HH:MM:SS) as Sola writes it: 3/3/2022 7:36:34 AM. */
export function solaEnteredDate(wall: string): string {
  const [y, mo, d, h, mi, s] = wall.split(/[- :]/).map(Number) as [number, number, number, number, number, number];
  return `${mo}/${d}/${y} ${h % 12 || 12}:${pad(mi)}:${pad(s)} ${h < 12 ? "AM" : "PM"}`;
}

/** Sola's time read back as a wall-clock time, for the mock's own paging. */
function wallOf(entered: unknown): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(String(entered));
  if (!m) return "";
  const h = (Number(m[4]) % 12) + (m[7] === "PM" ? 12 : 0);
  return `${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))} ${pad(h)}:${m[5]}:${m[6]}`;
}

/** An approved $1,250 Visa sale, `n` hours into 2026 on the account's clock. */
export const solaTransaction = fixtureBuilder<SolaMockRecord>((n) => ({
  xRefNum: String(600_000_000 + n),
  xEnteredDate: solaEnteredDate(new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString().slice(0, 19).replace("T", " ")),
  xCommand: "cc:sale",
  xAmount: "1250.00",
  xResponseResult: "Approved",
  xVoid: "0",
  xCardType: "Visa",
  xMaskedCardNumber: "4xxxxxxxxxxx1111",
  xToken: `tok${String(n).padStart(29, "0")}`,
  xName: synthetic.name(n),
  xEmail: synthetic.email(n),
  xBillPhone: `212555${String(n % 10_000).padStart(4, "0")}`,
  xInvoice: `INV-${n}`,
  xResponseBatch: String(11_000_000 + Math.floor(n / 24)),
  xDescription: "Engagement ring",
}));

const WALL = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/;
const error = (message: string, code: string): DocMockResponse => ({ status: 200, body: { xResult: "E", xStatus: "Error", xError: message, xErrorCode: code, xRefNum: "1" } });

export interface SolaMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each report request, the key left out. */
  readonly reads: Record<string, unknown>[];
}

export function solaDocMock(data: SolaMockData): SolaMock {
  const reads: Record<string, unknown>[] = [];
  let limits = data.rateLimits ?? 0;
  const api = checkDocMock({
    integration: "sola_payments",
    baseUrl: "https://x1.cardknox.com",
    source: { url: DOCS.reporting, title: "Sola Payments Reporting API", retrievedOn: "2026-11-10", version: "Gateway 5.0.0" },
    assumptions: [
      "xReportData is a list of rows, one object each, with fields named as the gateway names them",
      "xBeginDate and xEndDate are both inclusive, and are read on the account's clock, as the rows' times are",
      "Rows come back oldest first when xGetNewest is false",
      "A key Sola doesn't take is answered xResult E with an error naming the key",
    ],
    routes: [
      {
        method: "POST",
        path: "/reportjson",
        documentedAt: DOCS.reporting,
        respond(request) {
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(request.body) as Record<string, unknown>;
          } catch {
            return error("Invalid request", "00002");
          }
          if (body.xKey !== data.apiKey) return error("Invalid xKey", "00001");
          if (limits > 0) {
            limits--;
            return { status: 429, text: "", headers: { "retry-after": "1" } };
          }
          for (const field of ["xVersion", "xSoftwareName", "xSoftwareVersion"]) if (typeof body[field] !== "string" || body[field] === "") return error(`Missing ${field}`, "00003");
          if (typeof body.xCommand !== "string" || !/^report:/i.test(body.xCommand)) return error("Invalid command", "00004");
          const { xKey: _, ...shown } = body;
          reads.push(shown);
          if (String(body.xCommand).toLowerCase() !== "report:all") return { status: 200, body: { xResult: "S", xStatus: "Success", xError: "", xRecordsReturned: "0", xReportData: [] } };
          const begin = String(body.xBeginDate ?? "");
          const end = String(body.xEndDate ?? "");
          if (!WALL.test(begin) || !WALL.test(end)) return error("Invalid date", "00005");
          const from = begin.length === 10 ? `${begin} 00:00:00` : begin;
          const to = end.length === 10 ? `${end} 23:59:59` : end;
          const day = to.slice(0, 10) === from.slice(0, 10);
          const max = body.xMaxRecords === undefined ? 1000 : Number(body.xMaxRecords);
          if (!Number.isInteger(max) || max < 1 || max > (day ? 5000 : 1000)) return error("Invalid xMaxRecords", "00006");
          const rows = data.rows
            .filter((r) => wallOf(r.xEnteredDate) >= from && wallOf(r.xEnteredDate) <= to)
            .sort((a, b) => wallOf(a.xEnteredDate).localeCompare(wallOf(b.xEnteredDate)) || String(a.xRefNum).localeCompare(String(b.xRefNum)));
          const ordered = body.xGetNewest === true || body.xGetNewest === "True" ? rows.reverse() : rows;
          const page = ordered.slice(0, max);
          return { status: 200, body: { xResult: "S", xStatus: "Success", xError: "", xRefNum: "2", xRecordsReturned: String(page.length), xReportingMaxTransactions: String(max), xReportData: page } };
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
  };
}

export default {
  integration: "sola_payments",
  covers: "Sola Payments' transaction report (Report:All)",
  watchPages: [DOCS.reporting],
  docMocks: () => [solaDocMock({ apiKey: "", rows: [] }).api],
} satisfies DocMockModule;
