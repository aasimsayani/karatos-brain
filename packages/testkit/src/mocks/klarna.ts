import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Klarna's Settlements API, built from docs.klarna.com. Data is synthetic.
 * Klarna's playground is free to sign up for; until a playground account
 * is set up, this mock stands in, and a playground run confirms it.
 *
 * Docs facts the mock relies on:
 * - Requests use HTTP Basic: an API key `klarna_<live|test>_api_…` sent
 *   as `Basic <key>`, or the username the portal shows with the key (or a
 *   legacy password) as the password. A credential belongs to one
 *   merchant ID and one environment (authentication). The key holds
 *   underscores, so the mock checks the header in its routes rather than
 *   as base64.
 * - Live hosts are api.klarna.com (Europe), api-na.klarna.com (North
 *   America) and api-oc.klarna.com (Oceania); the playground adds
 *   `.playground` before klarna.com (api-urls).
 * - GET /settlements/v1/payouts takes start_date, end_date, currency_code,
 *   size (default 20, at most 500) and offset, and answers payouts and
 *   pagination {count, total, next, prev, offset}. A payout has totals in
 *   minor units, payment_reference, payout_date, currency_code,
 *   merchant_settlement_type and merchant_id (settlements).
 * - GET /settlements/v1/transactions takes payment_reference or order_id,
 *   size and offset, and answers transactions and pagination. A
 *   transaction has amount in minor units, type, sale_date, capture_date,
 *   order_id, currency_code and purchase_country, and may carry
 *   capture_id, refund_id, merchant_reference1 and 2, vat_rate, vat_amount
 *   and detailed_type (settlements).
 * - A bad request is answered 400 with error_code, error_messages and
 *   correlation_id (settlements).
 */
const DOCS = {
  authentication: "https://docs.klarna.com/api/authentication",
  apiUrls: "https://docs.klarna.com/api/api-urls/",
  settlements: "https://docs.klarna.com/api/settlements/",
} as const;
export const KLARNA_DOC_PAGES = DOCS;

export type KlarnaMockRecord = Record<string, unknown>;

export interface KlarnaMockData {
  /** An API key, or a username and password; the mock takes the one given. */
  apiKey?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  payouts: KlarnaMockRecord[];
  /** Each payout's lines, by payment reference. */
  transactions: Record<string, KlarnaMockRecord[]>;
  /** 429s to answer before the next reads. */
  rateLimits?: number;
  /** Leaves pagination.total out of answers, which the docs don't mark required. */
  noTotal?: boolean;
  /** Base URL: North America production unless a test says otherwise. */
  baseUrl?: string;
}

const uuid = (n: number, tag: number) => `${String(tag).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A net USD payout `n` days into 2026: $1,200 of sales less $300 returned, $36 of fees and $12 commission. */
export const klarnaPayout = fixtureBuilder<KlarnaMockRecord>((n) => ({
  totals: {
    commission_amount: 1_200,
    repay_amount: 0,
    sale_amount: 120_000,
    holdback_amount: 0,
    tax_amount: 0,
    settlement_amount: 85_200,
    fee_correction_amount: 0,
    reversal_amount: 0,
    release_amount: 0,
    return_amount: 30_000,
    fee_amount: 3_600,
    charge_amount: 0,
    credit_amount: 0,
    fee_refund_amount: 0,
    tax_refund_amount: 0,
    deposit_amount: 0,
    opening_debt_balance_amount: 0,
    closing_debt_balance_amount: 0,
  },
  payment_reference: `XISA${String(n).padStart(10, "0")}`,
  payout_date: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000 + 6 * 3_600_000).toISOString().replace(".000Z", "Z"),
  currency_code: "USD",
  currency_code_of_registration_country: "USD",
  merchant_settlement_type: "NET",
  merchant_id: "N100000",
  transactions: `https://api-na.klarna.com/settlements/v1/transactions?payment_reference=XISA${String(n).padStart(10, "0")}`,
}));

/** A $400 sale captured `n` hours into 2026, for the merchant's order TEST-n. */
export const klarnaTransaction = fixtureBuilder<KlarnaMockRecord>((n) => {
  const at = new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString().replace(".000Z", "Z");
  return {
    amount: 40_000,
    capture_id: uuid(n, 2),
    merchant_reference1: `TEST-${n}`,
    merchant_reference2: "Engagement ring deposit",
    sale_date: at,
    type: "SALE",
    capture_date: at,
    order_id: uuid(n, 1),
    short_order_id: `${String(n).padStart(6, "0")}A`,
    currency_code: "USD",
    purchase_country: "US",
    shipping_country: "US",
    vat_rate: 0,
    vat_amount: 0,
    initial_payment_method_type: "INSTALLMENT",
    initial_number_of_installments: 4,
    detailed_type: "PURCHASE",
    klarna_comment: "Test comment",
  };
});

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const badRequest = (message: string): DocMockResponse => ({ status: 400, body: { error_code: "BAD_VALUE", error_messages: [message], correlation_id: uuid(0, 9) } });

export interface KlarnaMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each request's path and query. */
  readonly reads: { path: string; query: Record<string, string> }[];
}

export function klarnaDocMock(data: KlarnaMockData): KlarnaMock {
  const base = data.baseUrl ?? "https://api-na.klarna.com";
  const reads: { path: string; query: Record<string, string> }[] = [];
  let limits = data.rateLimits ?? 0;
  const expected = data.apiKey ? `Basic ${data.apiKey}` : `Basic ${Buffer.from(`${data.username}:${data.password}`).toString("base64")}`;

  /** Checks the credential, the rate limit and the paging; answers an error or the page's bounds. */
  function begin(request: { url: URL; headers: Headers }): DocMockResponse | { size: number; offset: number; q: Record<string, string> } {
    if (request.headers.get("authorization") !== expected) return { status: 401, body: { error_code: "UNAUTHORIZED", error_messages: ["Unauthorized"], correlation_id: uuid(0, 9) } };
    if (limits > 0) {
      limits--;
      return { status: 429, body: { error_code: "TOO_MANY_REQUESTS", error_messages: ["Too many requests"], correlation_id: uuid(0, 9) }, headers: { "retry-after": "1" } };
    }
    const q = Object.fromEntries(request.url.searchParams);
    reads.push({ path: request.url.pathname, query: q });
    const size = q.size === undefined ? 20 : Number(q.size);
    const offset = q.offset === undefined ? 0 : Number(q.offset);
    if (!Number.isInteger(size) || size < 1 || size > 500) return badRequest("size must be 1 to 500");
    if (!Number.isInteger(offset) || offset < 0) return badRequest("offset must be 0 or more");
    return { size, offset, q };
  }

  function page(key: string, rows: KlarnaMockRecord[], size: number, offset: number, url: URL): DocMockResponse {
    const items = rows.slice(offset, offset + size);
    const link = (at: number) => {
      const u = new URL(url);
      u.searchParams.set("offset", String(at));
      return u.toString();
    };
    const pagination: Record<string, unknown> = { count: items.length, offset };
    if (!data.noTotal) pagination.total = rows.length;
    if (offset + size < rows.length) pagination.next = link(offset + size);
    if (offset > 0) pagination.prev = link(Math.max(0, offset - size));
    return { status: 200, body: { [key]: items, pagination } };
  }

  const api = checkDocMock({
    integration: "klarna",
    baseUrl: base,
    source: { url: DOCS.settlements, title: "Klarna Settlements API", retrievedOn: "2026-11-11", version: "Settlements API v1" },
    assumptions: [
      "start_date and end_date match payout_date, both inclusive, and take ISO 8601 times",
      "Payouts are listed oldest first and stay in that order between pages, so offset paging is stable",
      "A payout's transactions stay in the same order once it is paid",
      "An API key is sent as the whole Basic credential, not as a username with an empty password",
      "A credential Klarna doesn't take is answered 401",
    ],
    routes: [
      {
        method: "GET",
        path: "/settlements/v1/payouts",
        documentedAt: DOCS.settlements,
        respond(request) {
          const b = begin(request);
          if ("status" in b) return b;
          for (const name of ["start_date", "end_date"]) if (b.q[name] !== undefined && !TIME.test(b.q[name]!)) return badRequest(`${name} is not a time`);
          const at = (p: KlarnaMockRecord) => Date.parse(String(p.payout_date));
          const rows = data.payouts
            .filter((p) => b.q.start_date === undefined || at(p) >= Date.parse(b.q.start_date))
            .filter((p) => b.q.end_date === undefined || at(p) <= Date.parse(b.q.end_date))
            .filter((p) => b.q.currency_code === undefined || p.currency_code === b.q.currency_code)
            .sort((a, z) => at(a) - at(z) || String(a.payment_reference).localeCompare(String(z.payment_reference)));
          return page("payouts", rows, b.size, b.offset, request.url);
        },
      },
      {
        method: "GET",
        path: "/settlements/v1/transactions",
        documentedAt: DOCS.settlements,
        respond(request) {
          const b = begin(request);
          if ("status" in b) return b;
          const reference = b.q.payment_reference;
          const rows = reference === undefined ? Object.values(data.transactions).flat() : (data.transactions[reference] ?? []);
          return page("transactions", rows, b.size, b.offset, request.url);
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
  integration: "klarna",
  covers: "Klarna's payouts and settlement transactions endpoints (Settlements API v1)",
  watchPages: [DOCS.settlements],
  docMocks: () => [klarnaDocMock({ apiKey: "", payouts: [], transactions: {} }).api],
} satisfies DocMockModule;
