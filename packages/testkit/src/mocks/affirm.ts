import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockRequest, type DocMockResponse, type DocMockModule } from "../doc-mock.js";

/**
 * Affirm's Merchant API reads, built from Affirm's developer docs: list and
 * read transactions, list transaction events, the daily settlement
 * summaries and Disputes API v3. Data is synthetic. A free Affirm sandbox
 * merchant account replaces this mock with recordings once one is set up.
 *
 * Docs facts the mock relies on:
 * - Base URLs https://sandbox.affirm.com/api/v1 and https://api.affirm.com/api/v1,
 *   and /api/v3 on the same hosts for disputes; sandbox and production have
 *   different keys (docs.affirm.com/developers/reference/introduction,
 *   .../reference/authentication, .../reference/listdisputes).
 * - Requests authenticate with HTTP Basic, the public API key as the user
 *   and the private API key as the password, over HTTPS only (.../reference/authentication).
 * - GET /transactions takes transaction_type (charge, required), limit
 *   (default 20), before and after (ARIs, mutually exclusive),
 *   before_timestamp and after_timestamp (Unix), before_date and after_date
 *   (MM-DD-YYYY), query, merchant_id and expand=checkout, and answers
 *   transactions, has_next (older results exist) and has_prev (.../reference/list_transactions).
 * - GET /transactions/{transaction_id} takes expand=checkout,events (.../reference/read_transaction).
 * - A transaction has id, status, amount and amount_refunded in the smallest
 *   currency unit, currency, created (RFC 3339), order_id, checkout_id,
 *   provider_id, events and a token, a JWT that is also encrypted when the
 *   response holds personal data (.../reference/the-transaction-object).
 * - Transaction statuses are authorized, captured, partially_refunded,
 *   refunded, voided (expired authorizations too), disputed and
 *   dispute_refunded (docs.affirm.com/developers/docs/transaction-states).
 * - GET /transactions/events takes transaction_type (charge) and
 *   transaction_event_type (authorize, capture, refund, void or all), both
 *   required, limit, before_date, after_date, before_ari and after_ari, and
 *   answers transactions grouped as transaction_id and transaction_events,
 *   with prev_page and next_page holding URL-encoded parameters for newer
 *   and older results (.../reference/list_transaction_events).
 * - Event types include auth, auth_expired, capture, split_capture, refund,
 *   refund_voided, void, partial_void, update and charge_off; events carry
 *   amount, fee, fee_refunded, currency and created, and may carry shipping
 *   name, email, phone and address (same page).
 * - GET /settlements/daily needs merchant_id, takes limit (1 to 1000,
 *   default 5), after (default 30 days ago) and before (dates, inclusive),
 *   ordering (default descending) and to_cursor_uuid with to_cursor_date
 *   from next_page; it answers count, data, prev_page and next_page, empty
 *   when there are no more, and each summary has deposit_id, date,
 *   total_sales, total_refunds, total_fees, total_settled, currency and
 *   optionally account_last_four and removal_state (failed or rejected)
 *   (.../reference/list_settlement_event_summaries).
 * - GET /api/v3/disputes takes limit (1 to 100, default 25), page_number
 *   (default 1) and status, and answers disputes and page_info with has_next
 *   and has_prev; a dispute has id, transaction_id, dispute_amount, currency,
 *   status, dispute_reason, created and updated; 401 is api-key-pair-invalid
 *   (.../reference/listdisputes).
 * - Errors carry status_code, message, code, type and field (.../reference/errors).
 */
const DOCS = "https://docs.affirm.com/developers/reference";
const HOSTS = { production: "https://api.affirm.com", sandbox: "https://sandbox.affirm.com" } as const;

export type AffirmMockRecord = Record<string, unknown>;

export interface AffirmMockData {
  publicApiKey: string;
  privateApiKey: string;
  merchantId: string;
  /** The host the mock answers; sandbox unless a test says otherwise. */
  environment?: "sandbox" | "production";
  transactions: AffirmMockRecord[];
  /** Each transaction's events, by transaction id. */
  events?: Record<string, AffirmMockRecord[]>;
  settlements?: AffirmMockRecord[];
  disputes?: AffirmMockRecord[];
  /** The mock's clock, for the settlement list's default start; fixed unless a test says otherwise. */
  now?: () => Date;
}

/** Every read the mock answers, by the docs' operation name. */
export const AFFIRM_MOCK_READS = ["list_transactions", "read_transaction", "list_transaction_events", "list_settlement_event_summaries", "list_disputes"] as const;

const iso = (n: number) => synthetic.isoTime(n);
const base36 = (n: number, width: number) => n.toString(36).toUpperCase().padStart(width, "0");

/** A transaction id shaped like the docs' V55Z-229C. */
export const affirmTransactionId = (n: number) => `T${base36(n, 3)}-TEST`;
/** An event id shaped like the docs' WDJN3ETDMKGIZJIY. */
export const affirmEventId = (n: number) => `EV${base36(n, 5)}TESTEVT`;
/** A cursor uuid, with a letter in each group so no run of digits looks like a card number. */
export const affirmCursorUuid = (n: number) => `aaaaaaaa-0000-4000-a000-${String(n).padStart(12, "0")}`;

export const affirmTransaction = fixtureBuilder<AffirmMockRecord>((n) => ({
  id: affirmTransactionId(n),
  checkout_id: `CHK${base36(n, 5)}TESTCHK`,
  order_id: `ORDER-TEST-${n}`,
  provider_id: 1,
  remove_tax: false,
  status: "captured",
  currency: "USD",
  created: iso(n * 60),
  authorization_expiration: iso(n * 60 + 30 * 1440),
  amount: 125_050,
  amount_refunded: 0,
  events: null,
  token: "test-header.test-payload.test-signature",
}));

/** A transaction event, with the shipping details events can carry, which a connector must not keep. */
export const affirmTransactionEvent = fixtureBuilder<AffirmMockRecord>((n) => {
  const [first, ...rest] = synthetic.name(n).split(" ");
  return {
    id: affirmEventId(n),
    type: "capture",
    amount: 125_050,
    fee: 7_503,
    fee_refunded: 0,
    currency: "USD",
    created: iso(n * 60 + 5),
    reference_id: `REF-TEST-${n}`,
    order_id: `ORDER-TEST-${n}`,
    metadata: {},
    shipping: {
      name: { first, last: rest.join(" "), full: synthetic.name(n) },
      email: synthetic.email(n),
      phone_number: synthetic.phone(n),
      address: { line1: `${n} Test Street`, city: "Testville", state: "NY", zipcode: "00000", country: "US" },
    },
  };
});

export const affirmSettlement = fixtureBuilder<AffirmMockRecord>((n) => ({
  deposit_id: `DEPOSIT-TEST-${n}`,
  date: `${iso(n * 1440).slice(0, 10)}T00:00:00.000Z`,
  total_sales: 125_050,
  total_refunds: -10_000,
  total_fees: 7_503,
  total_settled: 107_547,
  currency: "USD",
  account_last_four: "6789",
}));

export const affirmDispute = fixtureBuilder<AffirmMockRecord>((n) => ({
  id: `dispute_test_${n}`,
  merchant_id: "MERCHANT-TEST",
  transaction_id: affirmTransactionId(n),
  dispute_amount: 125_050,
  currency: "USD",
  status: "action_required_merchant",
  dispute_reason: "product_not_received",
  created: iso(n * 1440 + 600),
  updated: null,
  response_due_by: iso(n * 1440 + 600 + 14 * 1440),
}));

const error = (status: number, code: string, message: string, field?: string): DocMockResponse => ({
  status,
  body: { status_code: String(status), type: status === 401 ? "unauthorized_error" : "invalid_request", code, message, ...(field ? { field } : {}) },
});
const MDY = /^(\d{2})-(\d{2})-(\d{4})$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: string) => {
  const m = MDY.exec(value);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : YMD.test(value) ? value : null;
};
/** A record's time; one Affirm sent without a readable time sorts last. */
const timeOf = (value: unknown) => Date.parse(String(value)) || 0;
const newestFirst = (a: AffirmMockRecord, b: AffirmMockRecord) => timeOf(b.created) - timeOf(a.created) || String(b.id).localeCompare(String(a.id));
/** Whether a record falls in a range; one with no readable time is listed anyway, so a connector meets it. */
const within = (value: unknown, from: number | null, to: number | null) => {
  const at = Date.parse(String(value));
  return Number.isNaN(at) || ((from === null || at >= from) && (to === null || at <= to));
};

/** A limit from the query: a default when absent, null when it isn't a whole number in range. */
function limitOf(query: URLSearchParams, fallback: number, max: number): number | null {
  const raw = query.get("limit");
  if (raw === null) return fallback;
  const n = Number(raw);
  return /^\d+$/.test(raw) && n >= 1 && n <= max ? n : null;
}

/** Refuses parameters the page doesn't document, and throws for documented ones the mock doesn't model, so neither is relied on unseen. */
function unknownParam(query: URLSearchParams, modelled: readonly string[], documented: readonly string[]): DocMockResponse | null {
  for (const name of query.keys()) {
    if (modelled.includes(name)) continue;
    if (documented.includes(name)) throw new Error(`the Affirm mock doesn't model ${name}`);
    return error(400, "invalid_field", `Unknown parameter ${name}`, name);
  }
  return null;
}

export interface AffirmMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Every read answered, in order, by the docs' operation name. */
  readonly reads: string[];
}

export function affirmDocMock(data: AffirmMockData): AffirmMock {
  const host = HOSTS[data.environment ?? "sandbox"];
  const now = data.now ?? (() => new Date("2026-01-20T00:00:00Z"));
  const reads: string[] = [];
  const events = data.events ?? {};

  /** The key pair Basic auth carries, compared with the account's. */
  function authorized(request: DocMockRequest): boolean {
    const m = /^Basic ([A-Za-z0-9+/]+=*)$/.exec(request.headers.get("authorization") ?? "");
    return !!m && Buffer.from(m[1]!, "base64").toString("utf8") === `${data.publicApiKey}:${data.privateApiKey}`;
  }

  /** Wraps a route: checks the key pair and records the read. */
  const read =
    (name: (typeof AFFIRM_MOCK_READS)[number], respond: (request: DocMockRequest, params: Record<string, string>) => DocMockResponse) =>
    (request: DocMockRequest, params: Record<string, string>): DocMockResponse => {
      if (!authorized(request)) return error(401, "api-key-pair-invalid", "Invalid API key pair");
      reads.push(name);
      return respond(request, params);
    };

  const api = checkDocMock({
    integration: "affirm",
    baseUrl: host,
    auth: "basic",
    source: { url: `${DOCS}/introduction`, title: "Affirm API Reference", retrievedOn: "2026-10-22", version: "v1" },
    assumptions: [
      "GET /transactions lists newest first, and before=<id> pages to the transactions created before that one",
      "GET /transactions answers events as null unless they are expanded",
      "limit on /transactions and /transactions/events takes up to 100; the docs give no maximum",
      "before_date and after_date on /transactions/events are MM-DD-YYYY, as on /transactions, and inclusive",
      "next_page on /transactions/events is URL-encoded before_ari=<event id>, and empty on the last page",
      "next_page on /settlements/daily is URL-encoded to_cursor_uuid=<uuid>&to_cursor_date=<date>, and empty on the last page",
      "after and before on /settlements/daily are YYYY-MM-DD",
      "/api/v3/disputes authenticates with the same Basic key pair as /api/v1",
      "Every endpoint answers a bad key pair with 401 and code api-key-pair-invalid",
      "Affirm publishes no rate limit; throttling, if any, is a 429 or 503",
    ],
    routes: [
      // Listed before the transaction read, so "events" is never taken for an id.
      {
        method: "GET",
        path: "/api/v1/transactions/events",
        documentedAt: `${DOCS}/list_transaction_events`,
        respond: read("list_transaction_events", ({ url }) => {
          const q = url.searchParams;
          const bad = unknownParam(q, ["transaction_type", "transaction_event_type", "limit", "before_date", "after_date", "before_ari"], ["after_ari", "merchant_id"]);
          if (bad) return bad;
          if (q.get("transaction_type") !== "charge") return error(400, "invalid_field", "transaction_type is required", "transaction_type");
          const kind = q.get("transaction_event_type") ?? "";
          const TYPES: Record<string, string[] | null> = { authorize: ["auth"], capture: ["capture", "split_capture"], refund: ["refund", "refund_voided"], void: ["void", "partial_void"], all: null };
          if (!Object.hasOwn(TYPES, kind)) return error(400, "invalid_field", "transaction_event_type is required", "transaction_event_type");
          const limit = limitOf(q, 20, 100);
          if (limit === null) return error(400, "invalid_field", "Invalid limit", "limit");
          const from = q.has("after_date") ? day(q.get("after_date")!) : null;
          const to = q.has("before_date") ? day(q.get("before_date")!) : null;
          if ((q.has("after_date") && !MDY.test(q.get("after_date")!)) || (q.has("before_date") && !MDY.test(q.get("before_date")!))) return error(400, "invalid_field", "Invalid date", "after_date");
          const all = Object.entries(events)
            .flatMap(([transaction_id, list]) => list.map((e): AffirmMockRecord & { transaction_id: string } => ({ ...e, transaction_id })))
            .filter((e) => TYPES[kind] === null || TYPES[kind]!.includes(String(e.type)))
            .filter((e) => (!from || String(e.created).slice(0, 10) >= from) && (!to || String(e.created).slice(0, 10) <= to))
            .sort(newestFirst);
          let start = 0;
          if (q.has("before_ari")) {
            const at = all.findIndex((e) => e.id === q.get("before_ari"));
            if (at < 0) return error(400, "invalid_field", "Invalid before_ari", "before_ari");
            start = at + 1;
          }
          const page = all.slice(start, start + limit);
          const transactions: { transaction_id: string; transaction_events: AffirmMockRecord[] }[] = [];
          for (const { transaction_id, ...e } of page) {
            const group = transactions.at(-1);
            if (group?.transaction_id === transaction_id) group.transaction_events.push(e);
            else transactions.push({ transaction_id, transaction_events: [e] });
          }
          const more = start + limit < all.length;
          return {
            status: 200,
            body: {
              transactions,
              next_page: more ? encodeURIComponent(`before_ari=${String(page.at(-1)!.id)}`) : "",
              prev_page: start > 0 && page.length ? encodeURIComponent(`after_ari=${String(page[0]!.id)}`) : "",
            },
          };
        }),
      },
      {
        method: "GET",
        path: "/api/v1/transactions/{transaction_id}",
        documentedAt: `${DOCS}/read_transaction`,
        respond: read("read_transaction", ({ url }, { transaction_id }) => {
          const bad = unknownParam(url.searchParams, ["expand"], []);
          if (bad) return bad;
          const expand = (url.searchParams.get("expand") ?? "").split(",").filter(Boolean);
          if (expand.includes("checkout")) throw new Error("the Affirm mock doesn't model expand=checkout");
          if (expand.some((e) => e !== "events")) return error(400, "invalid_field", "Invalid expand", "expand");
          const t = data.transactions.find((r) => r.id === transaction_id);
          if (!t) return error(404, "transaction-not-found", "The transaction could not be found");
          return { status: 200, body: { ...t, events: expand.includes("events") ? (events[String(t.id)] ?? []) : null } };
        }),
      },
      {
        method: "GET",
        path: "/api/v1/transactions",
        documentedAt: `${DOCS}/list_transactions`,
        respond: read("list_transactions", ({ url }) => {
          const q = url.searchParams;
          const bad = unknownParam(q, ["transaction_type", "limit", "before", "after_timestamp", "before_timestamp"], ["allow_marqeta_view", "after", "before_date", "after_date", "query", "merchant_id", "expand"]);
          if (bad) return bad;
          if (q.get("transaction_type") !== "charge") return error(400, "invalid_field", "transaction_type is required", "transaction_type");
          const limit = limitOf(q, 20, 100);
          if (limit === null) return error(400, "invalid_field", "Invalid limit", "limit");
          const bound = (name: string) => (q.has(name) ? (/^\d+$/.test(q.get(name)!) ? Number(q.get(name)) * 1000 : Number.NaN) : null);
          const after = bound("after_timestamp");
          const before = bound("before_timestamp");
          if (Number.isNaN(after) || Number.isNaN(before)) return error(400, "invalid_field", "Invalid timestamp", "after_timestamp");
          const all = data.transactions
            .filter((t) => within(t.created, after, before))
            .sort(newestFirst);
          let start = 0;
          if (q.has("before")) {
            const at = all.findIndex((t) => t.id === q.get("before"));
            if (at < 0) return error(400, "invalid_field", "Invalid before", "before");
            start = at + 1;
          }
          const page = all.slice(start, start + limit).map((t) => ({ ...t, events: null }));
          return { status: 200, body: { transactions: page, has_next: start + limit < all.length, has_prev: start > 0 } };
        }),
      },
      {
        method: "GET",
        path: "/api/v1/settlements/daily",
        documentedAt: `${DOCS}/list_settlement_event_summaries`,
        respond: read("list_settlement_event_summaries", ({ url }) => {
          const q = url.searchParams;
          const bad = unknownParam(q, ["merchant_id", "limit", "after", "before", "to_cursor_uuid", "to_cursor_date"], ["ordering", "from_cursor_uuid", "from_cursor_date"]);
          if (bad) return bad;
          if (!q.has("merchant_id")) return error(400, "invalid_field", "merchant_id is required", "merchant_id");
          if (q.get("merchant_id") !== data.merchantId) return error(404, "merchant-not-found", "The merchant could not be found");
          const limit = limitOf(q, 5, 1000);
          if (limit === null) return error(400, "invalid_field", "Invalid limit", "limit");
          const from = q.get("after") ?? new Date(now().getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
          const to = q.get("before");
          if (!YMD.test(from) || (to !== null && !YMD.test(to))) return error(400, "invalid_field", "Invalid date", "after");
          const all = (data.settlements ?? [])
            .map((s, i) => ({ s, uuid: affirmCursorUuid(i + 1) }))
            .filter(({ s }) => String(s.date).slice(0, 10) >= from && (to === null || String(s.date).slice(0, 10) <= to))
            .sort((a, b) => Date.parse(String(b.s.date)) - Date.parse(String(a.s.date)) || b.uuid.localeCompare(a.uuid));
          let start = 0;
          if (q.has("to_cursor_uuid") || q.has("to_cursor_date")) {
            const at = all.findIndex(({ s, uuid }) => uuid === q.get("to_cursor_uuid") && s.date === q.get("to_cursor_date"));
            if (at < 0) return error(400, "invalid_field", "Invalid cursor", "to_cursor_uuid");
            start = at + 1;
          }
          const page = all.slice(start, start + limit);
          const cursor = (name: string, row: (typeof all)[number]) => encodeURIComponent(`${name}_cursor_uuid=${row.uuid}&${name}_cursor_date=${String(row.s.date)}`);
          return {
            status: 200,
            body: {
              count: page.length,
              data: page.map(({ s }) => s),
              next_page: start + limit < all.length ? cursor("to", page.at(-1)!) : "",
              prev_page: start > 0 && page.length ? cursor("from", page[0]!) : "",
            },
          };
        }),
      },
      {
        method: "GET",
        path: "/api/v3/disputes",
        documentedAt: `${DOCS}/listdisputes`,
        respond: read("list_disputes", ({ url }) => {
          const q = url.searchParams;
          const bad = unknownParam(q, ["limit", "page_number"], ["created_after", "created_before", "resolved_after", "resolved_before", "status", "dispute_reason", "merchant_id"]);
          if (bad) return bad;
          const limit = limitOf(q, 25, 100);
          const page = q.has("page_number") ? Number(q.get("page_number")) : 1;
          if (limit === null || !Number.isInteger(page) || page < 1) return error(400, "invalid_field", "Invalid paging", "limit");
          const all = [...(data.disputes ?? [])].sort(newestFirst);
          const rows = all.slice((page - 1) * limit, page * limit);
          return { status: 200, body: { token: "test-header.test-payload.test-signature", disputes: rows, page_info: { has_next: page * limit < all.length, has_prev: page > 1 } } };
        }),
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
  integration: "affirm",
  covers: "Affirm's transaction, transaction event, daily settlement and dispute reads",
  watchPages: [
    "https://docs.affirm.com/developers/reference/introduction",
    "https://docs.affirm.com/developers/reference/list_transaction_events",
    "https://docs.affirm.com/developers/reference/read_transaction",
    "https://docs.affirm.com/developers/reference/list_transactions",
    "https://docs.affirm.com/developers/reference/list_settlement_event_summaries",
    "https://docs.affirm.com/developers/reference/listdisputes",
  ],
  docMocks: () => [affirmDocMock({ publicApiKey: "", privateApiKey: "", merchantId: "", transactions: [] }).api],
} satisfies DocMockModule;
