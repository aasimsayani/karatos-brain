import { constants, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * NetSuite's REST web services: the OAuth 2.0 client credentials token and
 * SuiteQL, built from NetSuite's help center. Data is synthetic. A client's
 * account replaces this mock on the first live run.
 *
 * Docs facts the mock relies on:
 * - POST /services/rest/auth/oauth2/v1/token takes a form with grant_type
 *   client_credentials, client_assertion_type
 *   urn:ietf:params:oauth:client-assertion-type:jwt-bearer and the signed
 *   JWT, form encoded, and answers {access_token, expires_in: 3600, token_type}
 *   (section_162755359851).
 * - The JWT header is typ JWT, alg PS256, PS384, PS512, ES256, ES384 or
 *   ES512, and kid the certificate id; its claims are iss (the client id),
 *   scope (restlets, rest_webservices or suite_analytics, comma separated),
 *   aud (the token endpoint), iat, and exp less than an hour after iat
 *   (section_162790605110).
 * - POST /services/rest/query/v1/suiteql takes {q, params} with
 *   `Prefer: transient`, limit and offset, and answers {links, count,
 *   hasMore, items, offset, totalResults}; a query reads 100,000 rows at
 *   most (section_157909186990).
 * - Pages hold up to 1,000 rows and the offset must be a multiple of the
 *   limit (section_156414087576).
 */
const DOCS = "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help";
export const NETSUITE_DOC_PAGES = {
  suiteql: `${DOCS}/section_157909186990.html`,
  paging: `${DOCS}/section_156414087576.html`,
  token: `${DOCS}/section_162755359851.html`,
  jwt: `${DOCS}/section_162790605110.html`,
} as const;

export type NetSuiteMockRecord = Record<string, unknown>;

/** The test account and its SuiteTalk host. */
export const NETSUITE_TEST_ACCOUNT = "1234567";
export const NETSUITE_TEST_BASE = `https://${NETSUITE_TEST_ACCOUNT}.suitetalk.api.netsuite.com/services/rest`;
const TOKEN_URL = `${NETSUITE_TEST_BASE}/auth/oauth2/v1/token`;
const ALGS = new Set(["PS256", "PS384", "PS512", "ES256", "ES384", "ES512"]);
const HASH: Record<string, string> = { "256": "sha256", "384": "sha384", "512": "sha512" };
const SCOPES = new Set(["restlets", "rest_webservices", "suite_analytics"]);
const MAX_ROWS = 100_000;

/** A time as the connector's queries write it: `n` minutes into 2026, in the account's zone. */
export const netSuiteTime = (n: number) => synthetic.isoTime(n).slice(0, 19).replace("T", " ");

/** An inventory item changed `n` minutes into 2026. */
export const netSuiteItem = fixtureBuilder<NetSuiteMockRecord>((n) => ({
  links: [],
  id: String(100 + n),
  itemid: synthetic.sku(n),
  displayname: `Test Ring ${n}`,
  itemtype: "InvtPart",
  isinactive: "F",
  modified: netSuiteTime(n),
}));

/** A company vendor changed `n` minutes into 2026. */
export const netSuiteVendor = fixtureBuilder<NetSuiteMockRecord>((n) => ({
  links: [],
  id: String(500 + n),
  companyname: `Test Casting Co ${n}`,
  isperson: "F",
  isinactive: "F",
  currency: "USD",
  modified: netSuiteTime(n),
}));

/** A customer invoice for 2,400.50 with 400.50 still owed, changed `n` minutes into 2026. */
export const netSuiteTransaction = fixtureBuilder<NetSuiteMockRecord>((n) => ({
  links: [],
  id: String(9000 + n),
  tranid: `INV${1000 + n}`,
  type: "CustInvc",
  status: "Open",
  trandate: "2026-01-05",
  duedate: "2026-02-04",
  entity: String(300 + n),
  currency: "USD",
  foreigntotal: "2400.5",
  foreignamountremaining: "400.5",
  modified: netSuiteTime(n),
}));

/** Item `n`'s stock at location 1. */
export const netSuiteStock = fixtureBuilder<NetSuiteMockRecord>((n) => ({
  links: [],
  item: String(100 + n),
  itemid: synthetic.sku(n),
  location: "1",
  quantityonhand: "4",
  quantityavailable: "3",
  quantitycommitted: "1",
  quantityonorder: "2",
  quantitybackordered: null,
}));

/** A key pair for the test certificate, made fresh each run: never a real key. */
export function netSuiteTestKeys(kind: "ec" | "rsa" = "ec"): { privateKey: KeyObject; publicKey: KeyObject; pem: string } {
  const pair = kind === "ec" ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }) : generateKeyPairSync("rsa", { modulusLength: 3072 });
  return { ...pair, pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string };
}

export interface NetSuiteMockData {
  clientId: string;
  certificateId: string;
  /** The certificate's public key, which checks each JWT. */
  publicKey: KeyObject;
  items: NetSuiteMockRecord[];
  vendors: NetSuiteMockRecord[];
  transactions: NetSuiteMockRecord[];
  stock: NetSuiteMockRecord[];
  /** 429s to answer before the next queries. */
  rateLimits?: number;
}

export interface NetSuiteMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each query: its table, start, limit and offset. */
  readonly reads: { table: string; since: string | null; limit: number; offset: number }[];
  /** Each JWT's header and claims, as the mock read them. */
  readonly assertions: { header: Record<string, unknown>; claims: Record<string, unknown> }[];
  /** Turns down every token handed out so far, as if they had ended. */
  expireTokens(): void;
}

const fail = (status: number, title: string): DocMockResponse => ({ status, body: { type: "https://www.rfc-editor.org/rfc/rfc9110.html", title, status, "o:errorDetails": [{ detail: title }] } });
const part = (s: string | undefined) => {
  try {
    return JSON.parse(Buffer.from(s ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export function netSuiteDocMock(data: NetSuiteMockData): NetSuiteMock {
  const reads: NetSuiteMock["reads"] = [];
  const assertions: NetSuiteMock["assertions"] = [];
  const live = new Set<string>();
  let issued = 0;
  let limits = data.rateLimits ?? 0;
  const tables = new Map([
    ["item", data.items],
    ["vendor", data.vendors],
    ["transaction", data.transactions],
    ["aggregateitemlocation", data.stock],
  ]);

  function token(request: DocMockRequest): DocMockResponse {
    if (!(request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) return { status: 400, body: { error: "invalid_request" } };
    const form = new URLSearchParams(request.body);
    if (form.get("grant_type") !== "client_credentials") return { status: 400, body: { error: "unsupported_grant_type" } };
    if (form.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") return { status: 400, body: { error: "invalid_request" } };
    const [h, c, s, extra] = (form.get("client_assertion") ?? "").split(".");
    const header = part(h);
    const claims = part(c);
    if (!header || !claims || s === undefined || extra !== undefined) return { status: 400, body: { error: "invalid_request" } };
    assertions.push({ header, claims });
    const alg = String(header.alg);
    if (header.typ !== "JWT" || !ALGS.has(alg) || header.kid !== data.certificateId) return { status: 400, body: { error: "invalid_client" } };
    const scopes = String(claims.scope).split(",");
    const iat = claims.iat as number;
    const exp = claims.exp as number;
    if (claims.iss !== data.clientId || claims.aud !== TOKEN_URL || !scopes.every((scope) => SCOPES.has(scope)) || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat || exp - iat >= 3600) {
      return { status: 400, body: { error: "invalid_grant" } };
    }
    const signed = Buffer.from(`${h}.${c}`);
    const signature = Buffer.from(s, "base64url");
    const hash = HASH[alg.slice(2)]!;
    const ok = alg.startsWith("PS")
      ? verify(hash, signed, { key: data.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: Number(alg.slice(2)) / 8 }, signature)
      : verify(hash, signed, { key: data.publicKey, dsaEncoding: "ieee-p1363" }, signature);
    if (!ok) return { status: 400, body: { error: "invalid_client" } };
    const value = `ns-test-token-${++issued}`;
    live.add(value);
    return { status: 200, body: { access_token: value, expires_in: 3600, token_type: "Bearer" } };
  }

  function suiteql(request: DocMockRequest): DocMockResponse {
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (!live.has(bearer)) return fail(401, "Invalid login attempt.");
    if (limits > 0) {
      limits--;
      return { ...fail(429, "Concurrent request limit exceeded."), headers: { "retry-after": "1" } };
    }
    if (request.headers.get("prefer") !== "transient") return fail(400, "The Prefer: transient header is required.");
    const q = Object.fromEntries(request.url.searchParams);
    for (const name of Object.keys(q)) if (name !== "limit" && name !== "offset") return fail(400, `Unknown parameter ${name}`);
    const limit = q.limit === undefined ? 1000 : Number(q.limit);
    const offset = q.offset === undefined ? 0 : Number(q.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0 || offset % limit !== 0 || offset >= MAX_ROWS) return fail(400, "Invalid limit or offset.");
    let body: { q?: unknown; params?: unknown };
    try {
      body = JSON.parse(request.body) as typeof body;
    } catch {
      return fail(400, "The body is not JSON.");
    }
    const text = typeof body.q === "string" ? body.q : "";
    const params = body.params === undefined ? [] : body.params;
    // SuiteQL only reads.
    if (!/^SELECT /.test(text) || !Array.isArray(params) || params.length !== (text.match(/\?/g) ?? []).length) return fail(400, "Invalid search query.");
    const table = /\bFROM (\w+)/.exec(text)?.[1] ?? "";
    const rows = tables.get(table);
    if (!rows) return fail(400, `Record '${table}' was not found.`);
    const filtered = /lastmodifieddate >= TO_DATE\(\?, 'YYYY-MM-DD HH24:MI:SS'\)/.test(text);
    const since = filtered ? String(params[0]) : null;
    reads.push({ table, since, limit, offset });
    const sorted = filtered
      ? rows.filter((r) => String(r.modified) >= since!).sort((a, b) => String(a.modified).localeCompare(String(b.modified)) || Number(a.id) - Number(b.id))
      : [...rows];
    const total = Math.min(sorted.length, MAX_ROWS);
    const items = sorted.slice(offset, Math.min(offset + limit, total));
    return { status: 200, body: { links: [], count: items.length, hasMore: offset + items.length < total, items, offset, totalResults: total } };
  }

  const api = checkDocMock({
    integration: "netsuite",
    baseUrl: NETSUITE_TEST_BASE,
    source: { url: NETSUITE_DOC_PAGES.suiteql, title: "NetSuite REST web services: SuiteQL and the OAuth 2.0 client credentials flow", retrievedOn: "2026-11-11", version: "v1" },
    assumptions: [
      "Transactions have the type codes SalesOrd, PurchOrd, CustInvc and Journal",
      "aggregateitemlocation has item, location, quantityonhand, quantityavailable, quantitycommitted, quantityonorder and quantitybackordered",
      "TO_CHAR(lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS') writes the change time in the account's zone, and TO_DATE with the same format filters by it",
      "Client ids are 16 to 128 letters and digits, and certificate ids 8 to 128 letters, digits, - and _",
      "A token turned down mid-sync answers 401",
    ],
    routes: [
      { method: "POST", path: "/auth/oauth2/v1/token", documentedAt: NETSUITE_DOC_PAGES.token, respond: token },
      { method: "POST", path: "/query/v1/suiteql", documentedAt: NETSUITE_DOC_PAGES.suiteql, respond: suiteql },
    ],
  });
  return {
    api,
    fetch: docMockFetch(api),
    get reads() {
      return reads;
    },
    get assertions() {
      return assertions;
    },
    expireTokens: () => live.clear(),
  };
}

export default {
  integration: "netsuite",
  covers: "NetSuite's OAuth 2.0 client credentials token and SuiteQL (REST web services v1)",
  watchPages: [NETSUITE_DOC_PAGES.suiteql, NETSUITE_DOC_PAGES.token],
  docMocks: () => [netSuiteDocMock({ clientId: "", certificateId: "", publicKey: netSuiteTestKeys().publicKey, items: [], vendors: [], transactions: [], stock: [] }).api],
} satisfies DocMockModule;
