import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Quo's List calls and List messages (API version 2026-03-30), built from
 * Quo's API reference, read as Markdown from quo.com/docs. Data is
 * synthetic. Quo has no sandbox, so a client's key replaces this mock on
 * the first live run.
 *
 * Docs facts the mock relies on:
 * - GET https://api.quo.com/calls takes createdAt[gte] and createdAt[lte]
 *   (inclusive), limit (1 to 50, default 10) and after, and answers
 *   {data, nextCursor}, newest first; nextCursor is null on the last page
 *   (list-calls).
 * - GET /messages takes createdAt[gt] and createdAt[lt], limit and after,
 *   and answers the same way, most recently created first (list-messages).
 * - Every request carries the key as Authorization, with no Bearer, and
 *   Quo-Api-Version: 2026-03-30 (authentication, introduction).
 * - Errors are {message, docs, title, trace?, errors?}; a missing version
 *   header is a 400, a bad key a 401, and 10 requests a second a 429
 *   (errors, rate-limits).
 * - A call's participants list every party, the store's line included; a
 *   number outside the workspace has a null actorId (get-a-call-by-id).
 */
const DOCS = "https://www.quo.com/docs/2026-03-30";
export const QUO_DOC_PAGES = {
  calls: `${DOCS}/calls/list-calls.md`,
  messages: `${DOCS}/messages/list-messages.md`,
  errors: `${DOCS}/errors.md`,
} as const;

export const QUO_TEST_LINE = "PNtest0001";
export const QUO_TEST_USER = "UStest0001";
/** The store's own Quo number in fixtures: a 555-01xx number, reserved for fiction. */
export const QUO_TEST_NUMBER = "+12125550199";

export type QuoMockRecord = Record<string, unknown>;

export interface QuoMockData {
  apiKey: string;
  calls: QuoMockRecord[];
  messages?: QuoMockRecord[];
  /** 429s to answer before the next reads. */
  rateLimits?: number;
}

/** A customer number, 555-0100 to 555-0198, never the store's. */
export const quoCustomerNumber = (n: number) => `+1212555${String(100 + (n % 99)).padStart(4, "0")}`;

/** An answered incoming call from a customer, `n` minutes into 2026. */
export const quoCall = fixtureBuilder<QuoMockRecord>((n) => ({
  id: `ACtest${String(n).padStart(6, "0")}`,
  phoneNumberId: QUO_TEST_LINE,
  actorId: QUO_TEST_USER,
  direction: "incoming",
  status: "completed",
  participants: [
    { phoneNumber: QUO_TEST_NUMBER, actorId: QUO_TEST_USER },
    { phoneNumber: quoCustomerNumber(n), actorId: null },
  ],
  createdAt: synthetic.isoTime(n),
  updatedAt: synthetic.isoTime(n + 5),
  answeredAt: synthetic.isoTime(n),
  completedAt: synthetic.isoTime(n + 4),
  answeredBy: QUO_TEST_USER,
  initiatedBy: null,
  callRoute: "phone-number",
  duration: 240,
  forwardedFrom: null,
  forwardedTo: null,
  aiHandled: null,
}));

/** An incoming text from a customer, `n` minutes into 2026. */
export const quoMessage = fixtureBuilder<QuoMockRecord>((n) => ({
  id: `ACmsg${String(n).padStart(6, "0")}`,
  to: [QUO_TEST_NUMBER],
  from: quoCustomerNumber(n),
  text: `Is my ring ready yet? This is ${synthetic.name(n)}.`,
  phoneNumberId: QUO_TEST_LINE,
  conversationId: `CNtest${String(n).padStart(6, "0")}`,
  direction: "incoming",
  userId: null,
  status: "received",
  createdAt: synthetic.isoTime(n),
  updatedAt: synthetic.isoTime(n),
  media: [],
}));

const error = (status: number, title: string, message: string): DocMockResponse => ({ status, body: { message, docs: "https://quo.com/docs", title, trace: "1000000000000000001" } });
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export interface QuoMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each read: the list and its query. */
  readonly reads: { kind: string; query: Record<string, string> }[];
}

export function quoDocMock(data: QuoMockData): QuoMock {
  const reads: { kind: string; query: Record<string, string> }[] = [];
  let limits = data.rateLimits ?? 0;
  const tables: Record<string, QuoMockRecord[]> = { calls: data.calls, messages: data.messages ?? [] };

  const listRoute = (kind: "calls" | "messages", lower: string, upper: string, inclusive: boolean) => ({
    method: "GET" as const,
    path: `/${kind}`,
    documentedAt: kind === "calls" ? QUO_DOC_PAGES.calls : QUO_DOC_PAGES.messages,
    respond(request: { url: URL; headers: Headers }): DocMockResponse {
      if (request.headers.get("quo-api-version") !== "2026-03-30") return error(400, "Bad Request", "The input was invalid");
      if (request.headers.get("authorization") !== data.apiKey) return error(401, "Unauthorized", "Unauthorized");
      if (limits > 0) {
        limits--;
        return error(429, "Too Many Requests", "Rate limit exceeded");
      }
      const q = Object.fromEntries(request.url.searchParams);
      for (const name of Object.keys(q)) if (![`createdAt[${lower}]`, `createdAt[${upper}]`, "limit", "after"].includes(name)) return error(400, "Bad Request", `Unknown parameter ${name}`);
      const from = q[`createdAt[${lower}]`];
      const until = q[`createdAt[${upper}]`];
      if ((from !== undefined && !ISO.test(from)) || (until !== undefined && !ISO.test(until))) return error(400, "Bad Request", "The input was invalid");
      const limit = q.limit === undefined ? 10 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return error(400, "Bad Request", "The input was invalid");
      const decoded = q.after === undefined ? "offset:0" : Buffer.from(q.after, "base64url").toString("utf8");
      if (!/^offset:\d{1,6}$/.test(decoded)) return error(400, "Bad Request", "The input was invalid");
      const offset = Number(decoded.slice(7));
      reads.push({ kind, query: q });
      const at = (r: QuoMockRecord) => Date.parse(String(r.createdAt));
      const rows = tables[kind]!
        .filter((r) => from === undefined || (inclusive ? at(r) >= Date.parse(from) : at(r) > Date.parse(from)))
        .filter((r) => until === undefined || (inclusive ? at(r) <= Date.parse(until) : at(r) < Date.parse(until)))
        .sort((a, b) => at(b) - at(a) || String(b.id).localeCompare(String(a.id)));
      const page = rows.slice(offset, offset + limit);
      const nextCursor = offset + limit < rows.length ? Buffer.from(`offset:${offset + limit}`).toString("base64url") : null;
      return { status: 200, body: { data: page, nextCursor } };
    },
  });

  const api = checkDocMock({
    integration: "openphone",
    baseUrl: "https://api.quo.com",
    source: { url: QUO_DOC_PAGES.errors, title: "Quo API reference: errors, List calls and List messages", retrievedOn: "2026-11-10", version: "2026-03-30" },
    assumptions: [
      "A page cursor stays good while the calls or messages it pages through change",
      "A call or text's changes (answered, ended, delivered) come within a day of it being created",
      "A 429 carries no Retry-After header",
    ],
    routes: [listRoute("calls", "gte", "lte", true), listRoute("messages", "gt", "lt", false)],
  });
  const fetch = docMockFetch(api);
  return {
    api,
    fetch,
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "openphone",
  covers: "Quo's List calls and List messages",
  watchPages: [QUO_DOC_PAGES.errors, QUO_DOC_PAGES.calls, QUO_DOC_PAGES.messages],
  docMocks: () => [quoDocMock({ apiKey: "", calls: [] }).api],
} satisfies DocMockModule;
