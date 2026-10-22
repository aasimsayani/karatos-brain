import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * The Clover REST API (v3) read endpoints for one merchant and Clover's v2
 * OAuth token refresh, built from docs.clover.com. Data is synthetic.
 * Clover's free sandbox (apisandbox.dev.clover.com) replaces this mock with
 * recordings once a developer account and test merchant are set up.
 */
const DOCS = "https://docs.clover.com/dev";
export const CLOVER_MOCK_HOST = "https://apisandbox.dev.clover.com";

/** A merchant and an app ID shaped like Clover's 13-character IDs. */
export const CLOVER_TEST_MERCHANT = "MTEST0000000A";
export const CLOVER_TEST_APP = "APPTEST00000A";

export const CLOVER_MOCK_RESOURCES = ["items", "item_stocks", "customers", "orders", "payments", "refunds"] as const;
type Resource = (typeof CLOVER_MOCK_RESOURCES)[number];
type Rec = Record<string, unknown>;

export interface CloverMockData {
  records: Partial<Record<Resource, Rec[]>>;
  /** A merchant API token the mock accepts, when testing that sign-in. */
  apiToken?: string;
  /** The refresh token the merchant was connected with, when testing OAuth. */
  refreshToken?: string;
  /** 429s to answer before the next API reads, in order, with Clover's retry-after when it sends one. */
  rateLimits?: { retryAfter?: number }[];
  /** The mock's clock in epoch milliseconds, for the 90-day cap and token expiry. */
  now?: () => number;
}

/** Luhn's check, which assertSynthetic uses to flag card numbers; a 13-digit millisecond time can pass it by chance. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** Epoch milliseconds nudged a millisecond or two, if needed, so the number never looks like a card number. */
export const notCardLike = (ms: number) => {
  let t = ms;
  while (luhn(String(t))) t += 1;
  return t;
};

/** A fixture time in epoch milliseconds: the synthetic start plus n minutes. */
export const cloverMs = (n: number, start?: string) => notCardLike(Date.parse(synthetic.isoTime(n, start)));

/** A 13-character Clover-shaped ID: letters, then the number padded with zeros. */
export const cloverTestId = (prefix: string, n: number) => `${prefix}${String(n).padStart(13 - prefix.length, "0")}`;

export const cloverItem = fixtureBuilder<Rec>((n) => ({
  id: cloverTestId("ITEM", n),
  name: `Test 14K ring ${n}`,
  sku: synthetic.sku(n),
  code: `UPC-TEST-${n}`,
  price: 125_000 + n * 100,
  priceType: "FIXED",
  cost: 60_000,
  hidden: false,
  available: true,
  modifiedTime: cloverMs(n * 60),
}));

export const cloverStock = fixtureBuilder<Rec>((n) => ({
  item: { id: cloverTestId("ITEM", n) },
  stockCount: 2,
  quantity: 2,
}));

export const cloverCustomer = fixtureBuilder<Rec>((n) => ({
  id: cloverTestId("CUST", n),
  firstName: "Test",
  lastName: `Customer ${n}`,
  marketingAllowed: n % 2 === 1,
  customerSince: cloverMs(n * 30),
  emailAddresses: [{ id: cloverTestId("EM", n), emailAddress: synthetic.email(n) }],
  phoneNumbers: [{ id: cloverTestId("PH", n), phoneNumber: synthetic.phone(n) }],
  addresses: [{ id: cloverTestId("AD", n), address1: `${n} Test Street`, city: "Testville", zip: "00000" }],
}));

/** An order with one line of item n, paid in full by card, with the payment nested as Clover expands it. */
export const cloverOrder = fixtureBuilder<Rec>((n) => ({
  id: cloverTestId("ORD", n),
  currency: "USD",
  total: 125_000 + n * 100,
  paymentState: "PAID",
  state: "locked",
  title: "Synthetic order title",
  note: "Synthetic staff note",
  testMode: false,
  createdTime: cloverMs(n * 1440),
  clientCreatedTime: cloverMs(n * 1440),
  modifiedTime: cloverMs(n * 1440 + 5),
  customers: [{ id: cloverTestId("CUST", 1), firstName: "Test", lastName: "Customer 1" }],
  lineItems: [{ id: cloverTestId("LI", n), item: { id: cloverTestId("ITEM", n) }, name: `Test 14K ring ${n}`, price: 125_000 + n * 100, printed: true }],
  payments: [{ id: cloverTestId("PAY", n), amount: 125_000 + n * 100, result: "SUCCESS", tender: { id: cloverTestId("TEND", 1), labelKey: "com.clover.tender.credit_card", label: "Credit Card" } }],
  refunds: [],
}));

export const cloverPayment = fixtureBuilder<Rec>((n) => ({
  id: cloverTestId("PAY", n),
  order: { id: cloverTestId("ORD", n) },
  amount: 125_000 + n * 100,
  tipAmount: 0,
  taxAmount: 0,
  result: "SUCCESS",
  offline: false,
  createdTime: cloverMs(n * 1440 + 1),
  modifiedTime: cloverMs(n * 1440 + 2),
  tender: { id: cloverTestId("TEND", 1), labelKey: "com.clover.tender.credit_card", label: "Credit Card" },
  cardTransaction: {
    cardType: "VISA",
    entryType: "EMV_CONTACT",
    first6: "400000",
    last4: "0002",
    type: "AUTH",
    authCode: "TEST01",
    referenceId: "REF-TEST",
    cardholderName: synthetic.name(n),
    token: "card-token-test",
    currency: "usd",
  },
  refunds: [],
}));

export const cloverRefund = fixtureBuilder<Rec>((n) => ({
  id: cloverTestId("REF", n),
  orderRef: { id: cloverTestId("ORD", n) },
  payment: { id: cloverTestId("PAY", n), amount: 125_000 },
  amount: 40_000,
  taxAmount: 0,
  tipAmount: 0,
  createdTime: cloverMs(n * 1440 + 600),
  clientCreatedTime: cloverMs(n * 1440 + 600),
  status: "SUCCESS",
}));

const error = (status: number, message: string): DocMockResponse => ({ status, body: { message } });

/** Filter fields the API reference lists per endpoint; a filter on anything else is refused. */
const FILTERABLE: Record<Resource, readonly string[]> = {
  items: ["modifiedTime", "deleted", "id", "name", "sku", "price", "hidden"],
  item_stocks: [],
  customers: ["customerSince", "firstName", "lastName", "emailAddress", "phoneNumber", "marketingAllowed", "fullName", "id", "deletedTime"],
  orders: ["modifiedTime", "createdTime", "clientCreatedTime", "id", "state", "total", "payType", "deletedTime", "employee.id", "device.id"],
  payments: ["modifiedTime", "createdTime", "clientCreatedTime", "result", "offline", "amount", "cardType", "device.id"],
  refunds: ["createdTime", "clientCreatedTime", "id", "voided", "orderRef.id", "payment.id", "employee.id", "device.id"],
};
/** Nested lists, shown only when expanded, as { elements }. */
const NESTED: Partial<Record<Resource, readonly string[]>> = {
  orders: ["lineItems", "payments", "refunds", "customers"],
  payments: ["refunds"],
};
/** Nested objects that, unexpanded, come back as a bare reference. */
const OBJECTS: Partial<Record<Resource, readonly string[]>> = {
  payments: ["tender", "cardTransaction"],
  refunds: ["payment"],
};
const CAPPED = new Set<Resource>(["orders", "payments", "refunds"]);
const NINETY_DAYS = 90 * 86_400_000;
const FILTER = /^([A-Za-z.]{1,40})(>=|<=|!=|=|<|>)(.{1,40})$/;
const NESTED_LIMIT = 100;

function compare(value: unknown, op: string, raw: string): boolean {
  const target: unknown = /^-?\d+$/.test(raw) ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw;
  if (typeof value !== typeof target) return op === "!=";
  const v = value as number;
  const t = target as number;
  switch (op) {
    case ">=":
      return v >= t;
    case "<=":
      return v <= t;
    case ">":
      return v > t;
    case "<":
      return v < t;
    case "=":
      return v === t;
    default:
      return v !== t;
  }
}

const field = (r: Rec, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Rec)[k] : undefined), r);

export interface CloverMock {
  oauth: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  /** The refresh token Clover would accept now; each refresh retires it. */
  readonly refreshToken: string | undefined;
  /** Refresh requests answered, failed ones included. */
  readonly refreshes: number;
  /** Revokes every access token, as when a token is cut off before it expires. */
  revokeAccessTokens(): void;
}

export function cloverDocMock(data: CloverMockData): CloverMock {
  let refreshToken = data.refreshToken;
  let issued = 0;
  let refreshes = 0;
  const now = data.now ?? (() => Date.now());
  const access = new Set<string>(data.apiToken ? [data.apiToken] : []);
  const limits = [...(data.rateLimits ?? [])];

  const oauth = checkDocMock({
    integration: "clover",
    baseUrl: `${CLOVER_MOCK_HOST}/oauth/v2`,
    source: { url: `${DOCS}/docs/refresh-access-tokens`, title: "Use refresh token to generate new expiring token", retrievedOn: "2026-10-22", version: "v2/OAuth" },
    assumptions: [
      "A used or unknown refresh token is answered 401 with no recovery token; Clover's /oauth/v2/recovery flow isn't modelled",
      "access_token_expiration is 30 minutes after the refresh; Clover says lifetimes aren't fixed",
    ],
    routes: [
      {
        method: "POST",
        path: "/refresh",
        documentedAt: `${DOCS}/docs/refresh-access-tokens`,
        respond(request) {
          refreshes++;
          let body: { client_id?: unknown; refresh_token?: unknown } = {};
          try {
            body = JSON.parse(request.body) as typeof body;
          } catch {
            return error(400, "Invalid JSON");
          }
          if (!refreshToken || body.client_id !== CLOVER_TEST_APP || body.refresh_token !== refreshToken) return error(401, "Invalid refresh token");
          issued++;
          refreshToken = `clover-refresh-test-${issued}`;
          const token = `clover-access-test-${issued}`;
          access.add(token);
          const seconds = Math.floor(now() / 1000);
          return { status: 200, body: { access_token: token, access_token_expiration: seconds + 1800, refresh_token: refreshToken, refresh_token_expiration: seconds + 365 * 86_400 } };
        },
      },
    ],
  });

  function authorized(request: DocMockRequest): boolean {
    return access.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  }

  function guard(request: DocMockRequest, params: Record<string, string>): DocMockResponse | null {
    if (!authorized(request)) return error(401, "401 Unauthorized");
    // A token belongs to one merchant.
    if (params.mId !== CLOVER_TEST_MERCHANT) return error(401, "401 Unauthorized");
    const limit = limits.shift();
    if (limit) return { status: 429, body: { message: "Too Many Requests" }, headers: { "x-ratelimit-tokenlimit": "16", ...(limit.retryAfter ? { "retry-after": String(limit.retryAfter) } : {}) } };
    return null;
  }

  function shape(resource: Resource, record: Rec, expand: Set<string>): Rec {
    const out: Rec = { ...record };
    for (const key of NESTED[resource] ?? []) {
      const list = Array.isArray(record[key]) ? (record[key] as Rec[]) : [];
      if (expand.has(key)) out[key] = { elements: list.slice(0, NESTED_LIMIT).map((r) => (key === "lineItems" && !expand.has("lineItems.discounts") ? { ...r, discounts: undefined } : r)) };
      else delete out[key];
    }
    for (const key of OBJECTS[resource] ?? []) {
      const value = record[key] as Rec | undefined;
      if (value && !expand.has(key)) {
        if (typeof value.id === "string") out[key] = { id: value.id };
        else delete out[key];
      }
    }
    return out;
  }

  function list(resource: Resource, request: DocMockRequest): DocMockResponse {
    const q = request.url.searchParams;
    let rows = [...(data.records[resource] ?? [])];
    const bounds: { lower?: number; upper?: number; field?: string } = {};
    const tests: ((r: Rec) => boolean)[] = [];
    for (const filter of q.getAll("filter")) {
      const m = FILTER.exec(filter);
      if (!m || !FILTERABLE[resource].includes(m[1]!)) return error(400, `Invalid filter: ${filter.slice(0, 40)}`);
      const [, name, op, value] = m as unknown as [string, string, string, string];
      if (/Time$/.test(name) && /^\d+$/.test(value)) {
        bounds.field = name;
        if (op === ">=" || op === ">") bounds.lower = Number(value);
        if (op === "<" || op === "<=") bounds.upper = Number(value);
      }
      tests.push((r) => compare(field(r, name), op, value));
    }
    rows = rows.filter((r) => tests.every((t) => t(r)));
    // Clover returns at most 90 days of orders, payments and refunds, trimming a longer range to its most recent 90 days.
    if (CAPPED.has(resource) && bounds.field) {
      const upper = bounds.upper ?? now();
      const lower = Math.max(bounds.lower ?? 0, upper - NINETY_DAYS);
      rows = rows.filter((r) => (field(r, bounds.field!) as number) >= lower);
    }
    const orderBy = q.get("orderBy");
    if (orderBy !== null) {
      const m = /^(modifiedTime|createdTime|customerSince|price)( ASC| DESC)?$/.exec(orderBy);
      if (!m) return error(400, "Invalid orderBy");
      const dir = m[2] === " DESC" ? -1 : 1;
      rows.sort((a, b) => dir * ((field(a, m[1]!) as number) - (field(b, m[1]!) as number)));
    } else {
      // Clover's default: newest created first.
      rows.sort((a, b) => ((field(b, "createdTime") as number) ?? 0) - ((field(a, "createdTime") as number) ?? 0));
    }
    const limit = Math.min(Math.max(Number(q.get("limit") ?? "100") || 100, 1), 1000);
    const offset = Math.max(Number(q.get("offset") ?? "0") || 0, 0);
    const expand = new Set((q.get("expand") ?? "").split(",").filter(Boolean));
    const page = rows.slice(offset, offset + limit).map((r) => shape(resource, r, expand));
    return { status: 200, body: { elements: page, href: `${CLOVER_MOCK_HOST}/v3/merchants/${CLOVER_TEST_MERCHANT}/${resource}?limit=${limit}` } };
  }

  const api = checkDocMock({
    integration: "clover",
    baseUrl: `${CLOVER_MOCK_HOST}/v3`,
    source: { url: `${DOCS}/docs/making-rest-api-calls`, title: "Use Clover REST API", retrievedOn: "2026-10-22", version: "v3" },
    auth: "bearer",
    assumptions: [
      "Orders and payments filtered on modifiedTime, and refunds on createdTime, return at most 90 days per request (the docs disagree on whether modifiedTime counts); a window of 89 days is never trimmed",
      "orderBy=modifiedTime ASC (createdTime ASC for refunds) is accepted on items, orders, payments and refunds and gives a stable order while paging",
      "Every item has a modifiedTime, so filter=modifiedTime>=0 reads them all",
      "A refund or payment on an order moves the order's modifiedTime",
      "item_stocks pages with limit and offset and answers { elements: [{ item: { id }, quantity, stockCount }] }; the reference documents no parameters or schema",
      "Customers can't be filtered by modified time, so every pass reads them all",
      "Unexpanded, an order's customers, lineItems, payments and refunds are left out, and a payment's tender and a refund's payment are { id } only",
      "lineItems.unitQty is in thousandths, with price per unit, for items sold by quantity or weight",
      "GET items/{itemId} answers 404 for an item the merchant no longer has",
      "Webhook notifications list { objectId, type, ts } directly under each merchant ID, as the sample shows (the field table describes an update array)",
    ],
    routes: [
      {
        method: "GET",
        path: "/merchants/{mId}",
        documentedAt: `${DOCS}/reference/merchantgetmerchant`,
        respond(request, params) {
          return guard(request, params) ?? { status: 200, body: { id: CLOVER_TEST_MERCHANT, name: "Synthetic Test Jeweler", address: { address1: "1 Test Street", city: "Testville" } } };
        },
      },
      {
        method: "GET",
        path: "/merchants/{mId}/items/{itemId}",
        documentedAt: `${DOCS}/reference/inventorygetitem`,
        respond(request, params) {
          const blocked = guard(request, params);
          if (blocked) return blocked;
          const item = (data.records.items ?? []).find((i) => i.id === params.itemId);
          return item ? { status: 200, body: item } : error(404, "Not Found");
        },
      },
      ...CLOVER_MOCK_RESOURCES.map((resource) => ({
        method: "GET" as const,
        path: `/merchants/{mId}/${resource}`,
        documentedAt: `${DOCS}/reference/${{ items: "inventorygetitems", item_stocks: "inventorygetitemstocks", customers: "customersgetcustomers", orders: "ordergetorders", payments: "paygetpayments", refunds: "paygetrefunds-3" }[resource]}`,
        respond(request: DocMockRequest, params: Record<string, string>) {
          return guard(request, params) ?? list(resource, request);
        },
      })),
    ],
  });

  const oauthFetch = docMockFetch(oauth);
  const apiFetch = docMockFetch(api);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const toOauth = url.origin === CLOVER_MOCK_HOST && url.pathname.startsWith("/oauth/");
      const target = toOauth ? oauthFetch : apiFetch;
      const response = await target(input, init);
      calls.push(...target.calls.slice(-1));
      return response;
    },
    { calls },
  );
  return {
    oauth,
    api,
    fetch,
    get refreshToken() {
      return refreshToken;
    },
    get refreshes() {
      return refreshes;
    },
    revokeAccessTokens: () => access.clear(),
  };
}
