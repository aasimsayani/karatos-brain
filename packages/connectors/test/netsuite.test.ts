import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import {
  NETSUITE_DOC_PAGES,
  NETSUITE_TEST_ACCOUNT,
  NETSUITE_TEST_BASE,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  netSuiteDocMock,
  netSuiteItem,
  netSuiteStock,
  netSuiteTestKeys,
  netSuiteTime,
  netSuiteTransaction,
  netSuiteVendor,
  testPipeline,
  type NetSuiteMock,
  type NetSuiteMockData,
} from "@karatos/connector-testkit";
import {
  NETSUITE_FIRST_LOOKBACK_MS,
  NETSUITE_MAX_ROWS,
  NETSUITE_OVERLAP_MS,
  NETSUITE_PAGE_SIZE,
  NETSUITE_QUERIES,
  NETSUITE_SCOPE,
  NETSUITE_WRITES,
  NetSuiteApiError,
  NetSuiteConfigError,
  netSuiteAlgorithm,
  netSuiteCents,
  netSuiteClient,
  netSuiteConnector,
  netSuiteHost,
  netSuiteItemEvent,
  netSuitePrivateKey,
  netSuiteStockEvent,
  netSuiteTransactionEvent,
  netSuiteVendorEvent,
  parseNetSuiteCursor,
  type NetSuiteClient,
  type NetSuiteCursor,
  type NetSuiteEvent,
  type NetSuiteList,
  type NetSuiteOptions,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak. Keys are made fresh each run.
const CLIENT_ID = ["cl", "a".repeat(30)].join("");
const CERT_ID = ["cert", "-b".repeat(10)].join("");
const EC = netSuiteTestKeys("ec");
const RSA = netSuiteTestKeys("rsa");
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const TOKEN_URL = `${NETSUITE_TEST_BASE}/auth/oauth2/v1/token`;
const QUERY_URL = `${NETSUITE_TEST_BASE}/query/v1/suiteql`;
const noSleep = async () => {};
const ctx = { receivedAt: RECEIVED };
const ALL = "1970-01-01 00:00:00";
/** Six years and a day before NOW, as NetSuite writes it. */
const SIX_YEARS = "2020-11-10 15:00:00";

/** Rows changed at minutes 10, 20 and 30 of 2026, and stock at two items. */
function account(overrides: Partial<NetSuiteMockData> = {}): NetSuiteMockData {
  for (const b of [netSuiteItem, netSuiteVendor, netSuiteTransaction, netSuiteStock]) b.reset();
  const at = (n: number) => ({ modified: netSuiteTime(n) });
  return {
    clientId: CLIENT_ID,
    certificateId: CERT_ID,
    publicKey: EC.publicKey,
    items: [netSuiteItem.one(at(10)), netSuiteItem.one(at(30))],
    vendors: [netSuiteVendor.one(at(20))],
    transactions: [netSuiteTransaction.one(at(10)), netSuiteTransaction.one({ ...at(20), type: "SalesOrd", tranid: "SO1002", status: "Pending Fulfillment" }), netSuiteTransaction.one({ ...at(30), type: "PurchOrd", tranid: "PO1003" })],
    stock: netSuiteStock.many(2),
    ...overrides,
  };
}

const settings = { accountId: NETSUITE_TEST_ACCOUNT, clientId: CLIENT_ID, certificateId: CERT_ID, privateKey: EC.pem };
const connector = (mock: NetSuiteMock, overrides: Partial<NetSuiteOptions> = {}) => netSuiteConnector({ ...settings, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as NetSuiteEvent[];

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string;
}

/** A fetch that answers tokens itself, answers queries in turn, and records the queries sent. */
function scripted(...answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const tokens: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url === TOKEN_URL) {
      tokens.push(String(init?.body));
      return new Response(JSON.stringify({ access_token: `t${tokens.length}`, expires_in: 3600, token_type: "Bearer" }), { status: 200 });
    }
    sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body) });
    return answers[Math.min(sent.length - 1, answers.length - 1)]!();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent, tokens };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const PAGE = { links: [], count: 0, hasMore: false, items: [], offset: 0, totalResults: 0 };
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof netSuiteClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = netSuiteClient({ ...settings, fetch, sleep: async (ms) => void slept.push(ms), now: NOW, ...extra });
  return { c, slept };
};
const T = netSuiteTime;

describe("NetSuite client", () => {
  it("checks its settings before sending anything", () => {
    const bad: [Partial<typeof settings>, string][] = [
      [{ accountId: "" }, "NETSUITE_ACCOUNT_ID is missing or not in the expected shape, such as 1234567 or 1234567_SB1"],
      [{ accountId: "acme" }, "NETSUITE_ACCOUNT_ID"],
      [{ accountId: "123" }, "NETSUITE_ACCOUNT_ID"],
      [{ accountId: "12345678901" }, "NETSUITE_ACCOUNT_ID"],
      [{ accountId: "1234567_XX1" }, "NETSUITE_ACCOUNT_ID"],
      [{ accountId: "1234567_SB" }, "NETSUITE_ACCOUNT_ID"],
      [{ accountId: "1234567_SB1234" }, "NETSUITE_ACCOUNT_ID"],
      [{ accountId: "x1234567" }, "NETSUITE_ACCOUNT_ID"],
      [{ accountId: "1234567x" }, "NETSUITE_ACCOUNT_ID"],
      [{ clientId: "short" }, "NETSUITE_CLIENT_ID is missing or not in the expected shape"],
      [{ clientId: "a".repeat(15) }, "NETSUITE_CLIENT_ID"],
      [{ clientId: "a".repeat(129) }, "NETSUITE_CLIENT_ID"],
      [{ clientId: `${"a".repeat(20)}-` }, "NETSUITE_CLIENT_ID"],
      [{ clientId: `-${"a".repeat(20)}` }, "NETSUITE_CLIENT_ID"],
      [{ certificateId: "short" }, "NETSUITE_CERTIFICATE_ID is missing or not in the expected shape"],
      [{ certificateId: "a".repeat(7) }, "NETSUITE_CERTIFICATE_ID"],
      [{ certificateId: "a".repeat(129) }, "NETSUITE_CERTIFICATE_ID"],
      [{ certificateId: "abc.defgh" }, "NETSUITE_CERTIFICATE_ID"],
      [{ certificateId: ".abcdefgh" }, "NETSUITE_CERTIFICATE_ID"],
      [{ certificateId: "abcdefgh." }, "NETSUITE_CERTIFICATE_ID"],
      [{ privateKey: "" }, "NETSUITE_PRIVATE_KEY is missing or isn't the certificate's private key, as PEM or base64-encoded PEM"],
      [{ privateKey: "not a key!" }, "NETSUITE_PRIVATE_KEY is missing"],
      [{ privateKey: "bm90IGEga2V5" }, "NETSUITE_PRIVATE_KEY is missing"],
      [{ privateKey: ["-----BEGIN", "PRIVATE KEY-----\nAAAA\n-----END", "PRIVATE KEY-----"].join(" ") }, "NETSUITE_PRIVATE_KEY is missing"],
      [{ privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string }, "NETSUITE_PRIVATE_KEY must be an RSA key of 3072 or 4096 bits, or an EC key on P-256, P-384 or P-521"],
      [{ privateKey: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string }, "NETSUITE_PRIVATE_KEY must be"],
      [{ privateKey: generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string }, "NETSUITE_PRIVATE_KEY must be"],
    ];
    for (const [over, message] of bad) {
      const { fetch, sent, tokens } = scripted(json(200, PAGE));
      expect(() => netSuiteClient({ ...settings, fetch, ...over }), JSON.stringify(over).slice(0, 60)).toThrow(message);
      expect(() => netSuiteClient({ ...settings, fetch, ...over })).toThrow(NetSuiteConfigError);
      expect(sent.length + tokens.length).toBe(0);
    }
    for (const accountId of ["1234", "1234567890", "1234567_SB1", " 1234567_sb12 ", "TSTDRV1234567", "1234567_RP123"]) expect(() => netSuiteClient({ ...settings, accountId })).not.toThrow();
    for (const clientId of ["a".repeat(16), "A1".repeat(64), ` ${CLIENT_ID} `]) expect(() => netSuiteClient({ ...settings, clientId })).not.toThrow();
    for (const certificateId of ["a".repeat(8), "_-".repeat(64), ` ${CERT_ID} `]) expect(() => netSuiteClient({ ...settings, certificateId })).not.toThrow();
    expect(() => netSuiteClient({ ...settings, privateKey: undefined as never })).toThrow("NETSUITE_PRIVATE_KEY is missing");
    expect(() => netSuiteClient({ ...settings, accountId: undefined as never })).toThrow("NETSUITE_ACCOUNT_ID");
    expect(() => netSuiteClient({ ...settings, clientId: undefined as never })).toThrow("NETSUITE_CLIENT_ID");
    expect(() => netSuiteClient({ ...settings, certificateId: undefined as never })).toThrow("NETSUITE_CERTIFICATE_ID");
  });

  it("takes the key as PEM, as PEM with \\n, or base64-encoded, and picks the algorithm from it", () => {
    const pem = EC.pem.trim();
    for (const value of [pem, ` ${pem} `, pem.replace(/\n/g, "\\n"), Buffer.from(pem).toString("base64"), Buffer.from(pem).toString("base64").replace(/(.{64})/g, "$1\n")]) {
      expect(netSuitePrivateKey(value).asymmetricKeyType).toBe("ec");
    }
    expect(netSuiteAlgorithm(EC.privateKey)).toBe("PS256".replace("PS", "ES"));
    expect(netSuiteAlgorithm(RSA.privateKey)).toBe("PS256");
    expect(netSuiteAlgorithm(generateKeyPairSync("rsa", { modulusLength: 4096 }).privateKey)).toBe("PS256");
    expect(netSuiteAlgorithm(generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey)).toBe("ES384");
    expect(netSuiteAlgorithm(generateKeyPairSync("ec", { namedCurve: "secp521r1" }).privateKey)).toBe("ES512");
    expect(() => netSuiteAlgorithm(createPublicKey(EC.pem) as never)).not.toThrow();
    expect(netSuiteHost("1234567_SB1")).toBe("https://1234567-sb1.suitetalk.api.netsuite.com");
    expect(netSuiteHost("TSTDRV1234567")).toBe("https://tstdrv1234567.suitetalk.api.netsuite.com");
  });

  it("signs in with a JWT NetSuite checks, for the REST web services scope only, with EC or RSA", async () => {
    for (const keys of [EC, RSA]) {
      const mock = netSuiteDocMock(account({ publicKey: keys.publicKey }));
      const { c } = client(mock.fetch, { privateKey: keys.pem });
      expect((await c.page("items", ALL, 0)).rows).toHaveLength(2);
      const [{ header, claims }] = mock.assertions as [{ header: Record<string, unknown>; claims: Record<string, unknown> }];
      expect(header).toEqual({ typ: "JWT", alg: keys === EC ? "ES256" : "PS256", kid: CERT_ID });
      const iat = NOW().getTime() / 1000;
      expect(claims).toEqual({ iss: CLIENT_ID, scope: "rest_webservices", aud: TOKEN_URL, iat, exp: iat + 300 });
    }
    expect(NETSUITE_SCOPE).toBe("rest_webservices");
    // A key that isn't the certificate's is turned down.
    const other = netSuiteDocMock(account({ publicKey: netSuiteTestKeys("ec").publicKey }));
    await expect(client(other.fetch).c.page("items", ALL, 0)).rejects.toThrow(NetSuiteConfigError);
    await expect(client(netSuiteDocMock(account({ publicKey: RSA.publicKey })).fetch, { privateKey: netSuiteTestKeys("rsa").pem }).c.page("items", ALL, 0)).rejects.toThrow(
      "NetSuite turned down the sign-in: check NETSUITE_CLIENT_ID, NETSUITE_CERTIFICATE_ID and NETSUITE_PRIVATE_KEY, and that the certificate is mapped and not expired",
    );
  });

  it("keeps a token until a minute before it ends, then signs in again", async () => {
    let at = NOW().getTime();
    const { fetch, tokens, sent } = scripted(json(200, PAGE));
    const { c } = client(fetch, { now: () => new Date(at) });
    await c.page("items", ALL, 0);
    at += 3539_000;
    await c.page("items", ALL, 0);
    expect(tokens).toHaveLength(1);
    at += 1000;
    await c.page("items", ALL, 0);
    expect(tokens).toHaveLength(2);
    expect(sent.map((s) => s.headers.authorization)).toEqual(["Bearer t1", "Bearer t1", "Bearer t2"]);
    const form = new URLSearchParams(tokens[0]);
    expect([...form.keys()]).toEqual(["grant_type", "client_assertion_type", "client_assertion"]);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
  });

  it("explains a sign-in NetSuite turns down, and reports a token that doesn't read", async () => {
    const answer = (status: number, body: unknown) =>
      (async (url: string) => (url === TOKEN_URL ? new Response(JSON.stringify(body), { status }) : new Response(JSON.stringify(PAGE)))) as unknown as typeof globalThis.fetch;
    for (const status of [400, 401]) await expect(client(answer(status, { error: "invalid_client" })).c.page("items", ALL, 0)).rejects.toThrow(NetSuiteConfigError);
    await expect(client(answer(500, {})).c.page("items", ALL, 0)).rejects.toMatchObject({ message: "NetSuite answered HTTP 500 for a token", status: 500 });
    await expect(client(answer(403, {})).c.page("items", ALL, 0)).rejects.toThrow(NetSuiteApiError);
    for (const body of [{}, { access_token: "", expires_in: 3600 }, { access_token: 5, expires_in: 3600 }, { access_token: "t", expires_in: 60 }, { access_token: "t", expires_in: "3600" }, { access_token: "t", expires_in: 3600.5 }]) {
      await expect(client(answer(200, body)).c.page("items", ALL, 0), JSON.stringify(body)).rejects.toMatchObject({ message: "NetSuite answered without a token that reads", status: 200 });
    }
    const notJson = (async (url: string) => (url === TOKEN_URL ? new Response("<html>", { status: 200 }) : new Response("{}"))) as unknown as typeof globalThis.fetch;
    await expect(client(notJson).c.page("items", ALL, 0)).rejects.toThrow("NetSuite answered without a token that reads");
    const empty = (async (url: string) => (url === TOKEN_URL ? new Response("null", { status: 200 }) : new Response("{}"))) as unknown as typeof globalThis.fetch;
    await expect(client(empty).c.page("items", ALL, 0)).rejects.toThrow("NetSuite answered without a token that reads");
    expect(await client(answer(200, { access_token: "t", expires_in: 61 })).c.page("items", ALL, 0)).toEqual({ rows: [], more: false });
  });

  it("sends one of its fixed SELECT queries with the start bound, 1,000 rows from an offset, transient", async () => {
    const { fetch, sent } = scripted(json(200, { ...PAGE, offset: 2000, hasMore: true, items: [{ id: "1" }] }), json(200, PAGE));
    const { c } = client(fetch);
    expect(await c.page("transactions", T(5), 2000)).toEqual({ rows: [{ id: "1" }], more: true });
    expect(await c.page("stock", null, 0)).toEqual({ rows: [], more: false });
    expect(sent[0]).toEqual({
      url: `${QUERY_URL}?limit=1000&offset=2000`,
      method: "POST",
      headers: { authorization: "Bearer t1", prefer: "transient", "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ q: NETSUITE_QUERIES.transactions, params: [T(5)] }),
    });
    expect(sent[1]!.body).toBe(JSON.stringify({ q: NETSUITE_QUERIES.stock }));
    for (const q of Object.values(NETSUITE_QUERIES)) expect(q).toMatch(/^SELECT [^;]+$/);
    expect(NETSUITE_QUERIES.items).toBe(
      "SELECT i.id, i.itemid, i.displayname, i.itemtype, i.isinactive, TO_CHAR(i.lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS') AS modified FROM item i WHERE i.lastmodifieddate >= TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS') ORDER BY i.lastmodifieddate, i.id",
    );
    expect(NETSUITE_QUERIES.vendors).toBe(
      "SELECT v.id, v.companyname, v.isperson, v.isinactive, c.symbol AS currency, TO_CHAR(v.lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS') AS modified FROM vendor v LEFT JOIN currency c ON c.id = v.currency WHERE v.lastmodifieddate >= TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS') ORDER BY v.lastmodifieddate, v.id",
    );
    expect(NETSUITE_QUERIES.transactions).toBe(
      "SELECT t.id, t.tranid, t.type, BUILTIN.DF(t.status) AS status, TO_CHAR(t.trandate, 'YYYY-MM-DD') AS trandate, TO_CHAR(t.duedate, 'YYYY-MM-DD') AS duedate, t.entity, c.symbol AS currency, t.foreigntotal, t.foreignamountremaining, TO_CHAR(t.lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS') AS modified FROM transaction t LEFT JOIN currency c ON c.id = t.currency WHERE t.type IN ('SalesOrd', 'PurchOrd', 'CustInvc', 'Journal') AND t.lastmodifieddate >= TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS') ORDER BY t.lastmodifieddate, t.id",
    );
    expect(NETSUITE_QUERIES.stock).toBe(
      "SELECT a.item, i.itemid, a.location, a.quantityonhand, a.quantityavailable, a.quantitycommitted, a.quantityonorder, a.quantitybackordered FROM aggregateitemlocation a JOIN item i ON i.id = a.item ORDER BY a.item, a.location",
    );
    expect([NETSUITE_PAGE_SIZE, NETSUITE_MAX_ROWS]).toEqual([1000, 100_000]);
  });

  it("asks only from offsets that are multiples of the page, below the most a query reads, from a NetSuite time", async () => {
    const { fetch, sent } = scripted(json(200, { ...PAGE, offset: 99_000 }));
    const { c } = client(fetch);
    for (const offset of [-1000, 1, 1500, 100_000, 1.5, Number.NaN]) await expect(c.page("items", ALL, offset)).rejects.toMatchObject({ message: "a items offset must be a multiple of 1000 below 100000", status: 0 });
    for (const [list, since] of [["items", null], ["stock", ALL], ["vendors", "2026-01-01T00:00:00Z"], ["transactions", "2026-13-01 00:00:00"], ["items", "2026-01-01 24:00:00"], ["items", "2026-01-32 00:00:00"], ["items", "2026-01-01 00:60:00"], ["items", " 2026-01-01 00:00:00"]] as [NetSuiteList, string | null][]) {
      await expect(c.page(list, since, 0), `${list} ${since}`).rejects.toMatchObject({ message: `a ${list} start must be a NetSuite time, and stock takes none`, status: 0 });
    }
    expect(sent).toHaveLength(0);
    expect(await c.page("items", "2026-12-31 23:59:59", 99_000)).toEqual({ rows: [], more: false });
  });

  it("says when an answer has no rows, no more flag, or another offset", async () => {
    for (const body of [{}, { ...PAGE, items: null }, { ...PAGE, hasMore: "false" }, { ...PAGE, hasMore: undefined }]) {
      await expect(client(scripted(json(200, body)).fetch).c.page("vendors", ALL, 0), JSON.stringify(body)).rejects.toMatchObject({ message: "NetSuite answered the vendors without its rows and whether there are more", status: 200 });
    }
    await expect(client(scripted(() => new Response("<html>", { status: 200 })).fetch).c.page("vendors", ALL, 0)).rejects.toThrow("without its rows");
    await expect(client(scripted(() => new Response("null", { status: 200 })).fetch).c.page("vendors", ALL, 0)).rejects.toThrow("without its rows");
    await expect(client(scripted(json(200, { ...PAGE, offset: 1000 })).fetch).c.page("vendors", ALL, 0)).rejects.toMatchObject({ message: "NetSuite answered the vendors from 1000 when asked from 0", status: 200 });
    await expect(client(scripted(json(200, { ...PAGE, offset: "0".repeat(20) })).fetch).c.page("vendors", ALL, 0)).rejects.toThrow("NetSuite answered the vendors from 000000000000 when asked from 0");
  });

  it("explains a role that can't read, replaces a token NetSuite turns down once, and reports other errors", async () => {
    await expect(client(scripted(json(403, {})).fetch).c.page("vendors", ALL, 0)).rejects.toThrow(new NetSuiteConfigError("NetSuite's role can't read the vendors: give it view permission for them"));
    const twice = scripted(json(401, {}));
    await expect(client(twice.fetch).c.page("items", ALL, 0)).rejects.toThrow(
      new NetSuiteConfigError("NetSuite turned down the token: check that the role still has the Log in using OAuth 2.0 access tokens and REST Web Services permissions"),
    );
    expect(twice.tokens).toHaveLength(2);
    expect(twice.sent).toHaveLength(2);
    const once = scripted(json(401, {}), json(200, PAGE));
    expect(await client(once.fetch).c.page("items", ALL, 0)).toEqual({ rows: [], more: false });
    expect(once.sent.map((s) => s.headers.authorization)).toEqual(["Bearer t1", "Bearer t2"]);
    for (const status of [400, 404, 201]) await expect(client(scripted(json(status, {})).fetch, { retries: 0 }).c.page("items", ALL, 0)).rejects.toMatchObject({ message: `NetSuite answered HTTP ${status} for the items`, status });
  });

  it("waits out throttling as Retry-After says, up to a minute, or backs off 1, 2 and 4 seconds, then gives up", async () => {
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "7" }), json(429, {}, { "retry-after": "600" }), json(200, PAGE));
    const { c, slept } = client(fetch);
    await c.page("items", ALL, 0);
    expect(slept).toEqual([7000, 60_000]);
    expect(sent).toHaveLength(3);
    for (const status of [429, 500, 502, 503, 504]) {
      const s = scripted(json(status, {}));
      const r = client(s.fetch);
      await expect(r.c.page("items", ALL, 0)).rejects.toMatchObject({ status });
      expect(r.slept, String(status)).toEqual([1000, 2000, 4000]);
      expect(s.sent).toHaveLength(4);
    }
    const zero = client(scripted(json(503, {}, { "retry-after": "0" }), json(200, PAGE)).fetch);
    await zero.c.page("items", ALL, 0);
    expect(zero.slept).toEqual([1000]);
    const told = scripted(json(500, {}));
    const r = client(told.fetch, { retries: 1 });
    await expect(r.c.page("items", ALL, 0)).rejects.toThrow("NetSuite answered HTTP 500 for the items");
    expect(r.slept).toEqual([1000]);
    // The token request is waited out the same way.
    let calls = 0;
    const busy = (async (url: string) => {
      if (url === TOKEN_URL && calls++ === 0) return new Response("{}", { status: 503 });
      return url === TOKEN_URL ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 })) : new Response(JSON.stringify(PAGE));
    }) as unknown as typeof globalThis.fetch;
    const b = client(busy);
    expect(await b.c.page("items", ALL, 0)).toEqual({ rows: [], more: false });
    expect(b.slept).toEqual([1000]);
  });

  it("waits for real, and uses the global fetch and clock, when none is given", async () => {
    const real = globalThis.fetch;
    const s = scripted(json(503, {}, { "retry-after": "0.01" }), json(200, PAGE));
    globalThis.fetch = s.fetch;
    try {
      const started = Date.now();
      const c = netSuiteClient(settings);
      expect(await c.page("items", ALL, 0)).toEqual({ rows: [], more: false });
      expect(Date.now() - started).toBeGreaterThanOrEqual(5);
      const claims = JSON.parse(Buffer.from(new URLSearchParams(s.tokens[0]).get("client_assertion")!.split(".")[1]!, "base64url").toString()) as { iat: number };
      expect(Math.abs(claims.iat * 1000 - Date.now())).toBeLessThan(5000);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("only ever sends POSTs to the token and SuiteQL addresses", async () => {
    const mock = netSuiteDocMock(account());
    const seen: string[] = [];
    const watch = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${url.split("?")[0]}`);
      return mock.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    await drain(connector(mock, { fetch: watch }).historicalImport({ cursor: null } as never));
    expect(new Set(seen)).toEqual(new Set([`POST ${TOKEN_URL}`, `POST ${QUERY_URL}`]));
  });
});

describe("NetSuite events", () => {
  it("reads money in whole cents", () => {
    expect([netSuiteCents("2400.5"), netSuiteCents(2400.556), netSuiteCents("-12.34"), netSuiteCents("0"), netSuiteCents(1e12), netSuiteCents("1234567890123.12345678")]).toEqual([240_050, 240_056, -1234, 0, 1e14, undefined]);
    for (const v of [null, undefined, "", "1e5", "12.", ".5", "1,000", "12.123456789", "abc", Number.NaN, Number.POSITIVE_INFINITY, 1e12 + 1, {}]) expect(netSuiteCents(v), String(v)).toBeUndefined();
    expect(netSuiteCents("-1000000000000")).toBe(-1e14);
  });

  it("logs an item with its sku, name, kind and whether it is active", () => {
    netSuiteItem.reset();
    const { ok, event } = netSuiteItemEvent(netSuiteItem.one(), ctx);
    expect(ok).toBe(true);
    expect(event).toEqual({
      id: `netsuite_item_101_${event.idempotencyKey.slice(-12)}`,
      type: "accounting.item_updated",
      occurredAt: RECEIVED,
      receivedAt: RECEIVED,
      idempotencyKey: event.idempotencyKey,
      payload: { system: "NetSuite", itemId: "netsuite:item:101", sku: "SKU-TEST-0001", name: "Test Ring 1", kind: "invtpart", active: true, changedAt: T(1) },
    });
    expect(event.idempotencyKey).toMatch(/^netsuite:item:101:[0-9a-f]{12}$/);
    const odd = netSuiteItemEvent(netSuiteItem.one({ id: 7, itemid: "a b", displayname: "<b>Ring</b>", itemtype: "Kit/Package Item", isinactive: "T" }), ctx).event.payload;
    expect(odd).toMatchObject({ itemId: "netsuite:item:7", sku: undefined, name: undefined, kind: "kit_package_item", active: false });
    expect(netSuiteItemEvent(netSuiteItem.one({ isinactive: true, itemtype: "9Lives", displayname: "x".repeat(201) }), ctx).event.payload).toMatchObject({ active: false, kind: undefined, name: undefined });
    expect(netSuiteItemEvent(netSuiteItem.one({ isinactive: false, displayname: "  Ring  ", itemid: "R-1/2:B.3#" }), ctx).event.payload).toMatchObject({ active: true, name: "Ring", sku: "R-1/2:B.3#" });
    expect(netSuiteItemEvent(netSuiteItem.one({ isinactive: null, itemid: "x".repeat(61), displayname: "a\u0007b" }), ctx).event.payload).toMatchObject({ active: false, sku: undefined, name: undefined });
    expect(netSuiteItemEvent(netSuiteItem.one({ itemid: "#".repeat(60), displayname: "x".repeat(200), itemtype: "Non Inventory - Part" }), ctx).event.payload).toMatchObject({ sku: "#".repeat(60), name: "x".repeat(200), kind: "non_inventory_part" });
    expect(netSuiteItemEvent(netSuiteItem.one({ displayname: "   ", itemtype: "x".repeat(61) }), ctx).event.payload).toMatchObject({ name: undefined, kind: undefined });
  });

  it("names a vendor that is a company, and never one that is a person", () => {
    netSuiteVendor.reset();
    const { ok, event } = netSuiteVendorEvent(netSuiteVendor.one(), ctx);
    expect(ok).toBe(true);
    expect(event.type).toBe("accounting.vendor_updated");
    expect(event.payload).toEqual({ system: "NetSuite", vendorId: "netsuite:vendor:501", name: "Test Casting Co 1", currency: "USD", active: true, changedAt: T(1) });
    expect(netSuiteVendorEvent(netSuiteVendor.one({ isperson: "T", companyname: synthetic() }), ctx).event.payload).toMatchObject({ name: "NetSuite vendor 502" });
    expect(netSuiteVendorEvent(netSuiteVendor.one({ isperson: null }), ctx).event.payload).toMatchObject({ name: "NetSuite vendor 503" });
    expect(netSuiteVendorEvent(netSuiteVendor.one({ isperson: false, companyname: null, currency: " eur ", isinactive: "T" }), ctx).event.payload).toMatchObject({ name: "NetSuite vendor 504", currency: "EUR", active: false });
    expect(netSuiteVendorEvent(netSuiteVendor.one({ currency: "US Dollar" }), ctx).event.payload.currency).toBeUndefined();
    expect(netSuiteVendorEvent(netSuiteVendor.one({ currency: 1 }), ctx).event.payload.currency).toBeUndefined();
  });

  it("logs each kind of transaction it reads as its own event, with whole cents", () => {
    netSuiteTransaction.reset();
    const invoice = netSuiteTransactionEvent(netSuiteTransaction.one(), ctx).event;
    expect(invoice.type).toBe("accounting.invoice_updated");
    expect(invoice.payload).toEqual({
      system: "NetSuite",
      invoiceId: "netsuite:transaction:9001",
      customerId: "netsuite:customer:301",
      number: "INV1001",
      txnDate: "2026-01-05",
      dueDate: "2026-02-04",
      totalCents: 240_050,
      balanceCents: 40_050,
      currency: "USD",
      status: "open",
      changedAt: T(1),
    });
    const order = netSuiteTransactionEvent(netSuiteTransaction.one({ type: "SalesOrd", status: "Pending Fulfillment", duedate: null, foreignamountremaining: null }), ctx).event;
    expect(order.type).toBe("accounting.sales_order_updated");
    expect(order.payload).toMatchObject({ salesOrderId: "netsuite:transaction:9002", customerId: "netsuite:customer:302", status: "pending_fulfillment", dueDate: undefined, balanceCents: undefined });
    const po = netSuiteTransactionEvent(netSuiteTransaction.one({ type: "PurchOrd", foreigntotal: "-500", entity: 77 }), ctx).event;
    expect(po.type).toBe("accounting.purchase_order_updated");
    expect(po.payload).toMatchObject({ purchaseOrderId: "netsuite:transaction:9003", vendorId: "netsuite:vendor:77", totalCents: 50_000 });
    expect(po.payload.customerId).toBeUndefined();
    const journal = netSuiteTransactionEvent(netSuiteTransaction.one({ type: "Journal", entity: null, status: "Approved for Posting" }), ctx).event;
    expect(journal.type).toBe("accounting.journal_entry_updated");
    expect(journal.payload).toMatchObject({ journalEntryId: "netsuite:transaction:9004", status: "approved_for_posting" });
    expect(Object.keys(journal.payload)).not.toContain("customerId");
    expect(Object.keys(journal.payload)).not.toContain("vendorId");
    const odd = netSuiteTransactionEvent(netSuiteTransaction.one({ entity: "x", tranid: "a b", trandate: "2026-1-5", duedate: "2026-02-30T00:00:00", currency: "usd", foreigntotal: "x", status: "<i>" }), ctx).event.payload;
    expect(odd).toMatchObject({ customerId: undefined, number: undefined, txnDate: undefined, dueDate: undefined, currency: "USD", totalCents: undefined, status: undefined });
    for (const v of ["2026-00-10", "2026-13-10", "2026-01-00", "2026-01-32", "x2026-01-10", "2026-01-10x"]) expect(netSuiteTransactionEvent(netSuiteTransaction.one({ trandate: v }), ctx).event.payload.txnDate, v).toBeUndefined();
    for (const v of ["2026-01-01", "2026-12-31", "2026-09-19", "2026-10-29", "2026-11-30"]) expect(netSuiteTransactionEvent(netSuiteTransaction.one({ trandate: v }), ctx).event.payload.txnDate, v).toBe(v);
  });

  it("reads stock at each location as a count, with what's available, committed and on order", () => {
    netSuiteStock.reset();
    const { ok, event } = netSuiteStockEvent(netSuiteStock.one(), ctx);
    expect(ok).toBe(true);
    expect(event.type).toBe("inventory.counted");
    expect(event.payload).toEqual({ system: "NetSuite", sku: "SKU-TEST-0001", onHand: 4, itemId: "netsuite:item:101", locationId: "netsuite:location:1", available: 3, committed: 1, onOrder: 2, backOrdered: undefined });
    expect(event.idempotencyKey).toMatch(/^netsuite:stock:101_1:[0-9a-f]{12}$/);
    // No on hand is none.
    expect(netSuiteStockEvent(netSuiteStock.one({ quantityonhand: null, quantityavailable: 1.5 }), ctx).event.payload).toMatchObject({ onHand: 0, available: 1.5 });
    expect(netSuiteStockEvent(netSuiteStock.one({ quantityonhand: 3 }), ctx).event.payload.onHand).toBe(3);
  });

  it("is a duplicate when read again unchanged, and a new event when it changes", () => {
    netSuiteItem.reset();
    const row = netSuiteItem.one();
    const again = netSuiteItemEvent({ ...row }, { receivedAt: "2026-11-12T00:00:00.000Z" }).event;
    expect(again.idempotencyKey).toBe(netSuiteItemEvent(row, ctx).event.idempotencyKey);
    expect(netSuiteItemEvent({ ...row, displayname: "Other" }, ctx).event.idempotencyKey).not.toBe(again.idempotencyKey);
    expect(netSuiteItemEvent({ ...row, links: [{ rel: "self" }] }, ctx).event.idempotencyKey).toBe(again.idempotencyKey);
  });

  it("dead-letters a row it can't read, saying why", () => {
    const dead = (r: { ok: boolean; event: NetSuiteEvent }) => {
      expect(r.ok).toBe(false);
      expect(r.event.occurredAt).toBeUndefined();
      expect(r.event.idempotencyKey).toMatch(/^netsuite:unreadable_[a-z]+:[0-9a-f]{12}$/);
      expect(r.event.id).toBe(r.event.idempotencyKey.replace(/:/g, "_"));
      return r.event.payload;
    };
    expect(dead(netSuiteItemEvent(null, ctx))).toEqual({ system: "NetSuite", kind: "item", id: null, problems: ["item is not an object", "item has no id that reads", "item has no change time that reads"] });
    expect(dead(netSuiteItemEvent([], ctx))).toMatchObject({ problems: ["item is not an object", "item has no id that reads", "item has no change time that reads"] });
    expect(dead(netSuiteVendorEvent({ id: "5", modified: "2026-01-01" }, ctx))).toEqual({ system: "NetSuite", kind: "vendor", id: "5", problems: ["vendor has no change time that reads"] });
    expect(dead(netSuiteVendorEvent({ id: "1.5", modified: T(1) }, ctx))).toMatchObject({ problems: ["vendor has no id that reads"] });
    for (const id of ["", "1234567890123", "1e3", 1.5, true, " 5"]) expect(netSuiteItemEvent({ id, modified: T(1) }, ctx).ok, String(id)).toBe(false);
    for (const id of ["-5", "123456789012", 0]) expect(netSuiteItemEvent({ id, modified: T(1) }, ctx).ok, String(id)).toBe(true);
    expect(dead(netSuiteTransactionEvent({ id: "5", modified: T(1), type: "VendBill" }, ctx))).toEqual({ system: "NetSuite", kind: "transaction", id: "5", problems: ["transaction is not a kind KaratOS reads"] });
    expect(netSuiteTransactionEvent({ id: "5", modified: T(1), type: "toString" }, ctx).ok).toBe(false);
    expect(netSuiteTransactionEvent({ id: "5", modified: T(1), type: ["Journal"] }, ctx).event.type).toBe("accounting.transaction_updated");
    expect(dead(netSuiteStockEvent("x", ctx))).toEqual({ system: "NetSuite", kind: "stock", id: null, problems: ["stock is not an object", "stock has no item and location that read", "stock's item has no sku that reads"] });
    expect(dead(netSuiteStockEvent({ item: "1", location: "x", itemid: "S" }, ctx))).toMatchObject({ id: null, problems: ["stock has no item and location that read"] });
    expect(dead(netSuiteStockEvent({ location: "1", itemid: "S" }, ctx))).toMatchObject({ problems: ["stock has no item and location that read"] });
    for (const quantityonhand of ["-1", -2, "1.5", "x"]) {
      expect(dead(netSuiteStockEvent({ item: "1", location: "2", itemid: "S", quantityonhand }, ctx))).toEqual({ system: "NetSuite", kind: "stock", id: "1_2", problems: ["stock on hand isn't a count of zero or more"] });
    }
    expect(dead(netSuiteStockEvent({ item: "1", location: "2", itemid: "a b" }, ctx))).toMatchObject({ problems: ["stock's item has no sku that reads"] });
  });
});

const synthetic = () => "Test Person";

describe("NetSuite checkpoint", () => {
  const marks = { items: T(1), vendors: null, transactions: T(3) };
  const pass = { list: "vendors" as const, since: T(1), offset: 2000, top: T(2) };
  const cursor = (c: unknown) => JSON.stringify(c);

  it("round-trips and turns down any other shape", () => {
    const good: NetSuiteCursor[] = [
      { done: false, marks, pass },
      { done: true, marks: { items: null, vendors: null, transactions: null }, pass: null },
      { done: false, marks, pass: { list: "stock", since: null, offset: 0, top: null } },
      { done: false, marks, pass: { ...pass, offset: NETSUITE_MAX_ROWS - NETSUITE_PAGE_SIZE, top: null } },
    ];
    for (const c of good) expect(parseNetSuiteCursor(cursor(c))).toEqual(c);
    expect(parseNetSuiteCursor(null)).toBeNull();
    const bad = [
      "",
      "{",
      "null",
      "[]",
      cursor({ marks, pass }),
      cursor({ done: "no", marks, pass }),
      cursor({ done: true, pass }),
      cursor({ done: true, marks: null, pass }),
      cursor({ done: true, marks: "x", pass }),
      cursor({ done: true, marks: { ...marks, items: "yesterday" }, pass }),
      cursor({ done: true, marks: { ...marks, vendors: undefined }, pass }),
      cursor({ done: true, marks: { ...marks, transactions: 5 }, pass }),
      cursor({ done: true, marks }),
      cursor({ done: true, marks, pass: { ...pass, list: "bills" } }),
      cursor({ done: true, marks, pass: { ...pass, list: "toString" } }),
      cursor({ done: true, marks, pass: { ...pass, since: null } }),
      cursor({ done: true, marks, pass: { ...pass, since: "2026-01-01T00:00:00Z" } }),
      cursor({ done: true, marks, pass: { list: "stock", since: T(1), offset: 0, top: null } }),
      cursor({ done: true, marks, pass: { ...pass, offset: -1000 } }),
      cursor({ done: true, marks, pass: { ...pass, offset: 1500 } }),
      cursor({ done: true, marks, pass: { ...pass, offset: NETSUITE_MAX_ROWS } }),
      cursor({ done: true, marks, pass: { ...pass, offset: "0" } }),
      cursor({ done: true, marks, pass: { ...pass, offset: 1000.5 } }),
      cursor({ done: true, marks, pass: { ...pass, top: "x" } }),
      cursor({ done: true, marks, pass: { ...pass, top: undefined } }),
    ];
    for (const raw of bad) expect(() => parseNetSuiteCursor(raw), raw).toThrow("NetSuite checkpoint is not in the expected shape");
    expect(parseNetSuiteCursor(cursor({ done: true, marks: { ...marks, extra: 1 }, pass: { ...pass, extra: 2 }, more: 3 }))).toEqual({ done: true, marks, pass });
  });
});

/** A client that answers each list from `rows`, `size` rows a page, recording what was asked. */
function fake(rows: Partial<Record<NetSuiteList, unknown[]>>, size = NETSUITE_PAGE_SIZE) {
  const asked: [NetSuiteList, string | null, number][] = [];
  const c: NetSuiteClient = {
    page: async (list, since, offset) => {
      asked.push([list, since, offset]);
      const all = (rows[list] ?? []).filter((r) => since === null || String((r as { modified?: unknown } | null)?.modified) >= since);
      const page = all.slice(offset, offset + size);
      return { rows: page, more: offset + page.length < all.length };
    },
  };
  return { c, asked };
}
const changed = (count: number, at: (i: number) => string) => Array.from({ length: count }, (_, i) => ({ id: String(i + 1), modified: at(i) }));

describe("NetSuite connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(netSuiteDocMock(account())), expected: { ingested: 8 } });
    expect(result.full.ingested).toBe(8);
  });

  it("imports every item and vendor, six years of transactions, then stock, and stops for good", async () => {
    const mock = netSuiteDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(8);
    expect(mock.reads).toEqual([
      { table: "item", since: ALL, limit: 1000, offset: 0 },
      { table: "vendor", since: ALL, limit: 1000, offset: 0 },
      { table: "transaction", since: SIX_YEARS, limit: 1000, offset: 0 },
      { table: "aggregateitemlocation", since: null, limit: 1000, offset: 0 },
    ]);
    expect(memory.events.map((e) => e.type)).toEqual([
      "accounting.item_updated",
      "accounting.item_updated",
      "accounting.vendor_updated",
      "accounting.invoice_updated",
      "accounting.sales_order_updated",
      "accounting.purchase_order_updated",
      "inventory.counted",
      "inventory.counted",
    ]);
    expect(parseNetSuiteCursor(report.cursor)).toEqual({ done: true, marks: { items: T(30), vendors: T(20), transactions: T(30) }, pass: null });
    expect(mock.assertions).toHaveLength(1);
    assertSynthetic(memory.events);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(4);
  });

  it("reads 1,000 a page by offset, keeping the offset in the checkpoint, and resumes there", async () => {
    const { c, asked } = fake({ items: changed(2500, (i) => T(i)) });
    const batches = await drain(connector(netSuiteDocMock(account()), { client: c }).historicalImport({ cursor: null } as never));
    expect(asked.slice(0, 3)).toEqual([["items", ALL, 0], ["items", ALL, 1000], ["items", ALL, 2000]]);
    expect(batches.map((b) => b.events.length).slice(0, 3)).toEqual([1000, 1000, 500]);
    expect(parseNetSuiteCursor(batches[0]!.cursor as string)!.pass).toEqual({ list: "items", since: ALL, offset: 1000, top: T(999) });
    expect(parseNetSuiteCursor(batches[2]!.cursor as string)).toMatchObject({ marks: { items: T(2499) }, pass: { list: "vendors", since: ALL, offset: 0, top: null } });
    asked.length = 0;
    await drain(connector(netSuiteDocMock(account()), { client: c }).historicalImport({ cursor: batches[0]!.cursor } as never));
    expect(asked.slice(0, 2)).toEqual([["items", ALL, 1000], ["items", ALL, 2000]]);
  });

  it("ends a list at a short page or when NetSuite has no more, and reads stock up to the most a query reads", async () => {
    // A full page NetSuite says is the last ends the list.
    const exact = fake({ vendors: changed(1000, (i) => T(i)) });
    await drain(connector(netSuiteDocMock(account()), { client: exact.c }).historicalImport({ cursor: null } as never));
    expect(exact.asked.filter(([l]) => l === "vendors")).toEqual([["vendors", ALL, 0]]);
    // A short page with more after it still ends the list.
    const short: NetSuiteClient = { page: async (list, since, offset) => ({ rows: list === "items" && offset === 0 ? [{ id: "1", modified: T(1) }] : [], more: list === "items" }) };
    const s = await drain(connector(netSuiteDocMock(account()), { client: short }).historicalImport({ cursor: null } as never));
    expect(parseNetSuiteCursor(s[0]!.cursor as string)!.pass!.list).toBe("vendors");
    const stock = fake({ stock: Array.from({ length: 5 }, (_, i) => ({ item: String(i) })) }, 1);
    const big: NetSuiteClient = { page: async (list, since, offset) => (list === "stock" ? { rows: Array(NETSUITE_PAGE_SIZE).fill({}), more: true } : stock.c.page(list, since, offset)) };
    const asked: number[] = [];
    const watch: NetSuiteClient = { page: async (list, since, offset) => (list === "stock" && asked.push(offset), big.page(list, since, offset)) };
    const b = await drain(connector(netSuiteDocMock(account()), { client: watch }).historicalImport({ cursor: JSON.stringify({ done: false, marks: { items: null, vendors: null, transactions: null }, pass: { list: "stock", since: null, offset: 98_000, top: null } }) } as never));
    expect(asked).toEqual([98_000, 99_000]);
    expect(parseNetSuiteCursor(b.at(-1)!.cursor as string)).toEqual({ done: true, marks: { items: null, vendors: null, transactions: null }, pass: null });
  });

  it("starts a pass again from the newest change it saw when it reaches 100,000 rows", async () => {
    const asked: [string | null, number][] = [];
    const c: NetSuiteClient = {
      page: async (list, since, offset) => {
        if (list !== "transactions") return { rows: [], more: false };
        asked.push([since, offset]);
        if (since === T(5)) return { rows: [{ id: "1", modified: T(5) }], more: false };
        return { rows: Array.from({ length: NETSUITE_PAGE_SIZE }, (_, i) => ({ id: String(i), modified: i === 3 ? T(5) : T(1) })), more: true };
      },
    };
    const start = JSON.stringify({ done: false, marks: { items: null, vendors: null, transactions: null }, pass: { list: "transactions", since: T(0), offset: 99_000, top: T(2) } });
    const batches = await drain(connector(netSuiteDocMock(account()), { client: c }).historicalImport({ cursor: start } as never));
    expect(asked).toEqual([[T(0), 99_000], [T(5), 0]]);
    expect(parseNetSuiteCursor(batches[0]!.cursor as string)!.pass).toEqual({ list: "transactions", since: T(5), offset: 0, top: T(5) });
    expect(parseNetSuiteCursor(batches[1]!.cursor as string)!.marks.transactions).toBe(T(5));
    // A pass whose newest change is its start can't move on.
    const stuck: NetSuiteClient = { page: async (list) => ({ rows: Array(NETSUITE_PAGE_SIZE).fill({ modified: T(0) }), more: list === "items" }) };
    const at = (top: string | null) => JSON.stringify({ done: false, marks: { items: null, vendors: null, transactions: null }, pass: { list: "items", since: T(0), offset: 99_000, top } });
    await expect(drain(connector(netSuiteDocMock(account()), { client: stuck }).historicalImport({ cursor: at(T(0)) } as never))).rejects.toThrow("NetSuite has more than 100000 items changed in one second, more than SuiteQL can page through");
    const blank: NetSuiteClient = { page: async (list) => ({ rows: Array(NETSUITE_PAGE_SIZE).fill({}), more: list === "items" }) };
    await expect(drain(connector(netSuiteDocMock(account()), { client: blank }).historicalImport({ cursor: at(null) } as never))).rejects.toThrow("changed in one second");
  });

  it("reads what changed since the newest change the last sync saw, less ten minutes, and stock again", async () => {
    const mock = netSuiteDocMock(account());
    const cursor = JSON.stringify({ done: true, marks: { items: T(25), vendors: null, transactions: T(15) }, pass: null });
    const batches = await drain(connector(mock).incrementalSync({ cursor } as never));
    expect(mock.reads.map((r) => [r.table, r.since])).toEqual([
      ["item", T(15)],
      ["vendor", "2026-11-08 15:00:00"],
      ["transaction", T(5)],
      ["aggregateitemlocation", null],
    ]);
    // The vendor changed long before the three days a first read of vendors looks back.
    expect(eventsOf(batches).map((e) => e.type)).toEqual([
      "accounting.item_updated",
      "accounting.invoice_updated",
      "accounting.sales_order_updated",
      "accounting.purchase_order_updated",
      "inventory.counted",
      "inventory.counted",
    ]);
    expect(parseNetSuiteCursor(batches.at(-1)!.cursor as string)).toEqual({ done: true, marks: { items: T(30), vendors: null, transactions: T(30) }, pass: null });
    expect(eventsOf(batches).every((e) => e.receivedAt === RECEIVED)).toBe(true);
    expect([NETSUITE_OVERLAP_MS, NETSUITE_FIRST_LOOKBACK_MS]).toEqual([600_000, 3 * 86_400_000]);
  });

  it("marks the newest change whatever order rows come in, ignores times that don't read, and keeps a mark when nothing changed", async () => {
    const rows: Partial<Record<NetSuiteList, unknown[]>> = { items: [{ modified: T(5) }, { modified: T(9) }, { modified: "x" }, null, { modified: T(7) }], stock: [{ modified: T(99) }] };
    const c: NetSuiteClient = { page: async (list) => ({ rows: rows[list] ?? [], more: false }) };
    const batches = await drain(connector(netSuiteDocMock(account()), { client: c }).incrementalSync({ cursor: JSON.stringify({ done: true, marks: { items: null, vendors: T(3), transactions: null }, pass: null }) } as never));
    expect(parseNetSuiteCursor(batches.at(-1)!.cursor as string)!.marks).toEqual({ items: T(9), vendors: T(3), transactions: null });
  });

  it("looks back three days on a first sync with no checkpoint, and doesn't call the import done", async () => {
    const { c, asked } = fake({});
    const batches = await drain(connector(netSuiteDocMock(account()), { client: c }).incrementalSync({ cursor: null } as never));
    expect(asked).toEqual([["items", "2026-11-08 15:00:00", 0], ["vendors", "2026-11-08 15:00:00", 0], ["transactions", "2026-11-08 15:00:00", 0], ["stock", null, 0]]);
    expect(parseNetSuiteCursor(batches.at(-1)!.cursor as string)!.done).toBe(false);
  });

  it("keeps a finished import finished on every page, and resumes a later sync part way", async () => {
    const { c, asked } = fake({ vendors: changed(1500, (i) => T(i)) });
    const resume = JSON.stringify({ done: true, marks: { items: T(1), vendors: null, transactions: null }, pass: { list: "vendors", since: T(0), offset: 0, top: null } });
    const batches = await drain(connector(netSuiteDocMock(account()), { client: c }).incrementalSync({ cursor: resume } as never));
    expect(asked[0]).toEqual(["vendors", T(0), 0]);
    expect(batches.every((b) => parseNetSuiteCursor(b.cursor as string)!.done)).toBe(true);
    expect(parseNetSuiteCursor(batches[0]!.cursor as string)!.marks.items).toBe(T(1));
    const partly = await drain(connector(netSuiteDocMock(account()), { client: c }).incrementalSync({ cursor: JSON.stringify({ done: false, marks: { items: null, vendors: null, transactions: null }, pass: null }) } as never));
    expect(partly.every((b) => !parseNetSuiteCursor(b.cursor as string)!.done)).toBe(true);
  });

  it("dead-letters what it can't read and carries on", async () => {
    const mock = netSuiteDocMock(account({ transactions: [netSuiteTransaction.one({ modified: T(10) }), { id: "x", modified: T(11), type: "VendBill" }], stock: [{ item: "1", location: "1", itemid: "S", quantityonhand: "-2" }] }));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(4);
    expect(report.deadLettered).toBe(2);
  });

  it("waits out a rate limit inside a sync, and replaces a token that ends", async () => {
    const mock = netSuiteDocMock(account({ rateLimits: 1 }));
    const slept: number[] = [];
    let expired = false;
    const watch = (async (url: string, init?: RequestInit) => {
      if (url.includes("suiteql") && mock.reads.length === 2 && !expired) {
        expired = true;
        mock.expireTokens();
      }
      return mock.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    const batches = await drain(connector(mock, { fetch: watch, sleep: async (ms) => void slept.push(ms) }).historicalImport({ cursor: null } as never));
    expect(eventsOf(batches)).toHaveLength(8);
    expect(slept).toEqual([1000]);
    expect(mock.assertions).toHaveLength(2);
  });

  it("stops on a sign-in that's turned down", async () => {
    await expect(drain(connector(netSuiteDocMock(account({ clientId: "other".repeat(4) }))).historicalImport({ cursor: null } as never))).rejects.toThrow(NetSuiteConfigError);
  });

  it("checks its settings", () => {
    expect(() => netSuiteConnector({ ...settings, accountId: "acme" })).toThrow("NETSUITE_ACCOUNT_ID is missing or not in the expected shape");
    for (const historyYears of [0, -1, 1.5]) expect(() => netSuiteConnector({ ...settings, historyYears }), String(historyYears)).toThrow("historyYears must be a positive whole number");
    expect(() => netSuiteConnector({ ...settings, historyYears: 1 })).not.toThrow();
  });

  it("reads transactions back as far as told, and up to now when no clock is given", async () => {
    const { c, asked } = fake({});
    await drain(netSuiteConnector({ ...settings, client: c, now: NOW, historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(asked.find(([l]) => l === "transactions")![1]).toBe("2025-11-10 15:00:00");
    asked.length = 0;
    await drain(netSuiteConnector({ ...settings, client: c }).incrementalSync({ cursor: null } as never));
    const since = Date.parse(`${asked[0]![1]!.replace(" ", "T")}Z`);
    expect(Math.abs(since - (Date.now() - NETSUITE_FIRST_LOOKBACK_MS))).toBeLessThan(5000);
    asked.length = 0;
    await drain(netSuiteConnector({ ...settings, client: c }).historicalImport({ cursor: null } as never));
    const floor = Date.parse(`${asked[2]![1]!.replace(" ", "T")}Z`);
    const expected = new Date();
    expected.setUTCFullYear(expected.getUTCFullYear() - 6);
    expect(Math.abs(floor - (expected.getTime() - 86_400_000))).toBeLessThan(5000);
    expect(netSuiteConnector({ ...settings, client: c }).source).toBe("netsuite");
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(NETSUITE_WRITES).toEqual([
      { integration: "netsuite", name: "create_sales_order", description: "Create a sales order in NetSuite", kind: "append", approval: "each", dailyCap: 20 },
      { integration: "netsuite", name: "create_purchase_order", description: "Create a purchase order in NetSuite", kind: "append", approval: "each", dailyCap: 10 },
    ]);
    const c = connector(netSuiteDocMock(account()));
    expect(c.writes).toBe(NETSUITE_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "create_sales_order", integration: "netsuite", outcome: "refused" },
      { action: "create_purchase_order", integration: "netsuite", outcome: "refused" },
    ]);
  });
});

describe("NetSuite doc mock", () => {
  async function bearer(mock: NetSuiteMock) {
    const { c } = client(mock.fetch);
    await c.page("stock", null, 0);
    return mock.reads.length;
  }
  const post = (mock: NetSuiteMock, query: string, body: unknown, headers: Record<string, string>) =>
    mock.fetch(`${QUERY_URL}${query}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("wants a token it handed out, transient, a SELECT with its parameters, and paging NetSuite allows", async () => {
    const mock = netSuiteDocMock(account());
    await bearer(mock);
    const ok = { authorization: "Bearer ns-test-token-1", prefer: "transient" };
    const q = { q: "SELECT id FROM item i WHERE i.lastmodifieddate >= TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS') ORDER BY 1", params: [T(5)] };
    expect((await post(mock, "", q, { prefer: "transient" })).status).toBe(401);
    expect((await post(mock, "", q, { ...ok, authorization: "Bearer other" })).status).toBe(401);
    expect((await post(mock, "", q, { authorization: ok.authorization })).status).toBe(400);
    for (const paging of ["?limit=0", "?limit=1001", "?limit=10&offset=5", "?offset=-1000", "?offset=100000", "?limit=x", "?page=2"]) expect((await post(mock, paging, q, ok)).status, paging).toBe(400);
    for (const body of ["{", { q: "DELETE FROM item" }, { q: "SELECT id FROM item WHERE id = ?" }, { q: "SELECT id FROM item", params: "x" }, { q: "SELECT id FROM bill" }, { params: [] }]) expect((await post(mock, "", body, ok)).status, JSON.stringify(body)).toBe(400);
    const page = (await (await post(mock, "?limit=1", q, ok)).json()) as { items: { id: string }[]; hasMore: boolean; count: number; offset: number; totalResults: number };
    expect(page).toMatchObject({ count: 1, hasMore: true, offset: 0, totalResults: 2 });
    expect(page.items.map((r) => r.id)).toEqual(["101"]);
    const next = (await (await post(mock, "?limit=1&offset=1", q, ok)).json()) as typeof page;
    expect(next).toMatchObject({ count: 1, hasMore: false, offset: 1 });
    const all = (await (await post(mock, "", { q: "SELECT * FROM vendor" }, ok)).json()) as typeof page;
    expect(all).toMatchObject({ count: 1, totalResults: 1 });
    expect(mock.reads.at(-1)).toEqual({ table: "vendor", since: null, limit: 1000, offset: 0 });
    mock.expireTokens();
    expect((await post(mock, "", q, ok)).status).toBe(401);
  });

  it("checks each JWT's form, header, claims and signature", async () => {
    const mock = netSuiteDocMock(account());
    const sign = async (form: Record<string, string>) => (await mock.fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() })).status;
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const type = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
    const header = { typ: "JWT", alg: "ES256", kid: CERT_ID };
    const claims = { iss: CLIENT_ID, scope: "rest_webservices", aud: TOKEN_URL, iat: 100, exp: 400 };
    const jwt = (h: unknown, c: unknown) => `${b64(h)}.${b64(c)}.c2ln`;
    expect(await sign({ grant_type: "password", client_assertion_type: type, client_assertion: jwt(header, claims) })).toBe(400);
    expect(await sign({ grant_type: "client_credentials", client_assertion_type: "x", client_assertion: jwt(header, claims) })).toBe(400);
    for (const assertion of ["", "a.b", "a.b.c.d", `${b64(header)}.!!.c`]) expect(await sign({ grant_type: "client_credentials", client_assertion_type: type, client_assertion: assertion }), assertion).toBe(400);
    for (const h of [{ ...header, typ: "jwt" }, { ...header, alg: "RS256" }, { ...header, alg: "HS256" }, { ...header, kid: "other" }]) {
      expect(await sign({ grant_type: "client_credentials", client_assertion_type: type, client_assertion: jwt(h, claims) }), JSON.stringify(h)).toBe(400);
    }
    for (const c of [{ ...claims, iss: "x" }, { ...claims, aud: "x" }, { ...claims, scope: "rest_webservices,everything" }, { ...claims, exp: 3700 }, { ...claims, exp: 100 }, { ...claims, iat: "100" }, { ...claims, exp: 1.5 }]) {
      expect(await sign({ grant_type: "client_credentials", client_assertion_type: type, client_assertion: jwt(header, c) }), JSON.stringify(c)).toBe(400);
    }
    // Well formed, but not signed by the certificate's key.
    expect(await sign({ grant_type: "client_credentials", client_assertion_type: type, client_assertion: jwt(header, { ...claims, scope: "restlets,rest_webservices" }) })).toBe(400);
    expect(await sign({ grant_type: "client_credentials", client_assertion_type: type, client_assertion: jwt({ ...header, alg: "PS256" }, claims) })).toBe(400);
    expect(mock.assertions.length).toBeGreaterThan(0);
  });

  it("answers 429 with Retry-After", async () => {
    const mock = netSuiteDocMock(account({ rateLimits: 1 }));
    const { c, slept } = client(mock.fetch);
    await c.page("items", ALL, 0);
    expect(slept).toEqual([1000]);
  });

  it("is built from NetSuite's docs pages", () => {
    const { api } = netSuiteDocMock(account());
    expect(api.source.url).toBe(NETSUITE_DOC_PAGES.suiteql);
    expect(api.routes.map((r) => `${r.method} ${r.path} ${r.documentedAt}`)).toEqual([`POST /auth/oauth2/v1/token ${NETSUITE_DOC_PAGES.token}`, `POST /query/v1/suiteql ${NETSUITE_DOC_PAGES.suiteql}`]);
  });
});
