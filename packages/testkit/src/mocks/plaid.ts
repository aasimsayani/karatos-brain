import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockResponse } from "../doc-mock.js";

/**
 * Plaid's /accounts/get, /transactions/sync, /item/get and
 * /webhook_verification_key/get, built from Plaid's API reference (API
 * version 2020-09-14). Data is synthetic. It also signs webhooks the way the
 * webhook verification docs describe, with a P-256 key made fresh for each
 * mock. Plaid's free sandbox replaces this mock with recordings once an
 * account is set up for the nightly run.
 */
const DOCS = "https://plaid.com/docs";
const SANDBOX = "https://sandbox.plaid.com";
const VERSION = "2020-09-14";

export interface PlaidMockAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: { available: number | null; current: number | null; limit: number | null; iso_currency_code: string | null; unofficial_currency_code: string | null };
  [field: string]: unknown;
}

export interface PlaidMockTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  pending: boolean;
  name: string;
  [field: string]: unknown;
}

/** One entry in the Item's change log, which /transactions/sync pages through. */
export type PlaidMockChange =
  | { kind: "added" | "modified"; transaction: PlaidMockTransaction }
  | { kind: "removed"; transaction_id: string; account_id: string };

export interface PlaidMockData {
  clientId: string;
  secret: string;
  accessToken: string;
  itemId: string;
  accounts: PlaidMockAccount[];
  changes: PlaidMockChange[];
  /** The Item's transactions aren't ready yet: sync answers empty, with an empty cursor. */
  notReady?: boolean;
}

export const plaidAccount = fixtureBuilder<PlaidMockAccount>((n) => ({
  account_id: `acct_test_${n}`,
  name: `Test Business Checking ${n}`,
  official_name: `Test Bank Business Checking ${n}`,
  mask: String(1000 + n),
  type: "depository",
  subtype: "checking",
  balances: { available: 1000 + n, current: 1100 + n, limit: null, iso_currency_code: "USD", unofficial_currency_code: null },
  verification_status: null,
  holder_category: "business",
  persistent_account_id: `persist_test_${n}`,
}));

export const plaidTransaction = fixtureBuilder<PlaidMockTransaction>((n) => ({
  transaction_id: `txn_test_${n}`,
  account_id: "acct_test_1",
  account_owner: synthetic.name(n),
  amount: 12.34 * n,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
  date: synthetic.isoTime(n * 1440).slice(0, 10),
  authorized_date: synthetic.isoTime(n * 1440 - 1440).slice(0, 10),
  pending: false,
  pending_transaction_id: null,
  name: `TEST VENDOR ${n} PURCHASE`,
  merchant_name: `Test Vendor ${n}`,
  check_number: null,
  payment_channel: "in store",
  personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_OTHER", confidence_level: "HIGH" },
  location: { address: `${n} Test Street`, city: "Testville", region: "TS", postal_code: "00000", country: "US", lat: null, lon: null, store_number: null },
  payment_meta: { payee: synthetic.name(n + 1), payer: synthetic.name(n + 2), reference_number: `REF-TEST-${n}`, payment_method: null, ppd_id: null, by_order_of: null, payment_processor: null, reason: null },
  counterparties: [{ name: `Test Vendor ${n}`, type: "merchant", entity_id: null, confidence_level: "HIGH", logo_url: null, website: null }],
  logo_url: null,
  website: null,
  original_description: null,
}));

const error = (status: number, type: string, code: string, message: string): DocMockResponse => ({
  status,
  body: { error_type: type, error_code: code, error_message: message, display_message: null, request_id: "req-test" },
});

const encodeCursor = (n: number) => Buffer.from(`log:${n}`).toString("base64url");
function decodeCursor(cursor: string): number | null {
  const m = /^log:(\d{1,9})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  return m ? Number(m[1]) : null;
}

export interface PlaidWebhookSignOptions {
  /** Unix seconds; now by default. */
  iat?: number;
  alg?: string;
  kid?: string;
  /** Overrides the body hash the JWT claims. */
  bodySha256?: string;
}

export interface PlaidMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** The key ID the mock signs webhooks with. */
  readonly keyId: string;
  /** Adds a change to the Item's log, as when the bank posts a transaction. */
  push(...changes: PlaidMockChange[]): void;
  /** The next /transactions/sync call fails with TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION. */
  mutateDuringPagination(times?: number): void;
  /** The next calls answer HTTP 429 RATE_LIMIT_EXCEEDED. */
  rateLimit(times: number): void;
  /** Every call on the Item answers ITEM_LOGIN_REQUIRED until it is relinked. */
  requireLogin(on?: boolean): void;
  /** The transactions become ready after starting NOT_READY. */
  setReady(): void;
  /** Marks the signing key retired, as Plaid does when it rotates keys. */
  expireKey(atUnixSeconds: number): void;
  /** A Plaid-Verification JWT for a body. */
  signWebhook(body: string, options?: PlaidWebhookSignOptions): string;
  /** /transactions/sync cursors asked for, in order; null for none. */
  readonly syncCursors: (string | null)[];
}

export function plaidDocMock(data: PlaidMockData): PlaidMock {
  const changes = [...data.changes];
  const syncCursors: (string | null)[] = [];
  let notReady = data.notReady === true;
  let mutations = 0;
  let limited = 0;
  let loginRequired = false;
  let expiredAt: number | null = null;
  const keyId = "kid_test_1";
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" }) as { privateKey: KeyObject; publicKey: KeyObject };
  const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };

  /** The checks every call shares: credentials in the headers, the pinned version, a JSON body. */
  function guard(headers: Headers, rawBody: string, needsItem: boolean): DocMockResponse | Record<string, unknown> {
    if (limited > 0) {
      limited--;
      return error(429, "RATE_LIMIT_EXCEEDED", "RATE_LIMIT", "rate limit exceeded for attempts to access this item. please try again later");
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return error(400, "INVALID_REQUEST", "INVALID_BODY", "body could not be parsed as JSON");
    }
    const clientId = headers.get("plaid-client-id") ?? body.client_id;
    const secret = headers.get("plaid-secret") ?? body.secret;
    if (clientId !== data.clientId || secret !== data.secret) return error(400, "INVALID_INPUT", "INVALID_API_KEYS", "invalid client_id or secret provided");
    if (!headers.get("plaid-version")) return error(400, "INVALID_REQUEST", "MISSING_FIELDS", "the Plaid-Version header is missing");
    if (needsItem) {
      if (body.access_token !== data.accessToken) return error(400, "INVALID_INPUT", "INVALID_ACCESS_TOKEN", "provided access token is in an invalid format");
      if (loginRequired) return error(400, "ITEM_ERROR", "ITEM_LOGIN_REQUIRED", "the login details of this item have changed (credentials, MFA, or required user action) and a user login is required to update this information. use Link's update mode to restore the item to a good state");
    }
    return body;
  }
  const failed = (r: DocMockResponse | Record<string, unknown>): r is DocMockResponse => typeof (r as DocMockResponse).status === "number" && "body" in r;

  const api = checkDocMock({
    integration: "plaid",
    baseUrl: SANDBOX,
    source: { url: `${DOCS}/api/products/transactions/`, title: "Plaid Transactions API", retrievedOn: "2026-10-21", version: VERSION },
    assumptions: [
      "Credentials in the PLAID-CLIENT-ID and PLAID-SECRET headers work on every endpoint here, as the API reference says they may replace the body fields",
      "A /transactions/sync cursor is printable ASCII with no spaces; the docs only cap it at 256 characters",
      "Rate-limited calls answer HTTP 429 with error_type RATE_LIMIT_EXCEEDED, as the RATE_LIMIT error page shows; other limit codes are assumed to match",
      "SYNC_UPDATES_AVAILABLE carries webhook_type, webhook_code, item_id, initial_update_complete and historical_update_complete; the guide names only the last two",
      "An unknown key_id on /webhook_verification_key/get answers a 400 error rather than a key",
      "Access tokens begin access-sandbox- or access-production-, as every example in the docs does",
    ],
    routes: [
      {
        method: "POST",
        path: "/accounts/get",
        documentedAt: `${DOCS}/api/accounts/`,
        respond(request) {
          const body = guard(request.headers, request.body, true);
          if (failed(body)) return body;
          return { status: 200, body: { accounts: data.accounts, item: { item_id: data.itemId, institution_id: "ins_test_1" }, request_id: "req-test" } };
        },
      },
      {
        method: "POST",
        path: "/transactions/sync",
        documentedAt: `${DOCS}/api/products/transactions/`,
        respond(request) {
          const body = guard(request.headers, request.body, true);
          if (failed(body)) return body;
          const cursor = typeof body.cursor === "string" && body.cursor !== "" ? body.cursor : null;
          syncCursors.push(cursor);
          if (mutations > 0) {
            mutations--;
            return error(400, "TRANSACTIONS_ERROR", "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "Underlying transaction data changed since last page was fetched. Please restart pagination from last update.");
          }
          const count = body.count === undefined ? 100 : Number(body.count);
          if (!Number.isInteger(count) || count < 1 || count > 500) return error(400, "INVALID_REQUEST", "INVALID_FIELD", "count must be between 1 and 500");
          if (notReady) {
            return { status: 200, body: { added: [], modified: [], removed: [], accounts: [], next_cursor: "", has_more: false, transactions_update_status: "NOT_READY", request_id: "req-test" } };
          }
          const from = cursor === null ? 0 : decodeCursor(cursor);
          if (from === null || from > changes.length) return error(400, "INVALID_REQUEST", "INVALID_FIELD", "cursor is not valid");
          const page = changes.slice(from, from + count);
          const to = from + page.length;
          return {
            status: 200,
            body: {
              added: page.flatMap((c) => (c.kind === "added" ? [c.transaction] : [])),
              modified: page.flatMap((c) => (c.kind === "modified" ? [c.transaction] : [])),
              removed: page.flatMap((c) => (c.kind === "removed" ? [{ transaction_id: c.transaction_id, account_id: c.account_id }] : [])),
              accounts: data.accounts,
              next_cursor: encodeCursor(to),
              has_more: to < changes.length,
              transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
              request_id: "req-test",
            },
          };
        },
      },
      {
        method: "POST",
        path: "/item/get",
        documentedAt: `${DOCS}/api/items/`,
        respond(request) {
          const body = guard(request.headers, request.body, true);
          if (failed(body)) return body;
          return { status: 200, body: { item: { item_id: data.itemId, institution_id: "ins_test_1", webhook: "", error: null, products: ["transactions"] }, request_id: "req-test" } };
        },
      },
      {
        method: "POST",
        path: "/webhook_verification_key/get",
        documentedAt: `${DOCS}/api/webhooks/webhook-verification/`,
        respond(request) {
          const body = guard(request.headers, request.body, false);
          if (failed(body)) return body;
          if (body.key_id !== keyId) return error(400, "INVALID_INPUT", "INVALID_WEBHOOK_VERIFICATION_KEY_ID", "invalid key_id provided");
          return { status: 200, body: { key: { ...jwk, alg: "ES256", use: "sig", kid: keyId, created_at: 1_700_000_000, expired_at: expiredAt }, request_id: "req-test" } };
        },
      },
    ],
  });

  const fetch = docMockFetch(api);
  return {
    api,
    fetch,
    keyId,
    get syncCursors() {
      return syncCursors;
    },
    push: (...more) => void changes.push(...more),
    mutateDuringPagination: (times = 1) => void (mutations = times),
    rateLimit: (times) => void (limited = times),
    requireLogin: (on = true) => void (loginRequired = on),
    setReady: () => void (notReady = false),
    expireKey: (at) => void (expiredAt = at),
    signWebhook(body, options = {}) {
      const header = Buffer.from(JSON.stringify({ alg: options.alg ?? "ES256", kid: options.kid ?? keyId, typ: "JWT" })).toString("base64url");
      const claims = {
        iat: options.iat ?? Math.floor(Date.now() / 1000),
        request_body_sha256: options.bodySha256 ?? createHash("sha256").update(body, "utf8").digest("hex"),
      };
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
      return `${header}.${payload}.${signature}`;
    },
  };
}
