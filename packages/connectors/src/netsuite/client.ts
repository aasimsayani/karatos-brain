import { constants, createPrivateKey, sign, type KeyObject } from "node:crypto";

/**
 * A small client for NetSuite's REST web services. It signs in with OAuth
 * 2.0 machine-to-machine (client credentials): it signs a short JWT with the
 * private key of a certificate the account's administrator mapped to the
 * integration record, a role and an entity, and swaps it for an access
 * token that lasts an hour. The token carries the role's permissions, so
 * the setup asks for a role that can only view. It asks only for the
 * `rest_webservices` scope.
 *
 * It sends only two requests, to the account's own SuiteTalk host:
 *
 * - `POST /services/rest/auth/oauth2/v1/token`, for a token;
 * - `POST /services/rest/query/v1/suiteql`, with one of five fixed SELECT
 *   queries (items, vendors, transactions, stock by location) and only
 *   bound parameters, 1,000 rows a page by offset.
 *
 * SuiteQL can only read, and no query text comes from anywhere but this
 * file. A 429 and 500, 502, 503 and 504 are waited out a few times before
 * the error goes to runSync, which keeps the checkpoint.
 */

/** Rows asked for at a time: NetSuite's largest page. */
export const NETSUITE_PAGE_SIZE = 1000;
/** A query reads at most this many rows; a pass that reaches it starts again from the newest change it saw. */
export const NETSUITE_MAX_ROWS = 100_000;
/** The scope asked for, and all the client needs. */
export const NETSUITE_SCOPE = "rest_webservices";
/** How NetSuite writes a time in these queries: the account's own time zone, to the second. */
export const NETSUITE_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
/** A token is used until this long before NetSuite says it ends. */
const TOKEN_MARGIN_S = 60;
/** How long the signed JWT is good for: NetSuite wants less than an hour. */
const ASSERTION_S = 300;
const ACCOUNT = /^(TSTDRV)?\d{4,10}(_(SB|RP)\d{1,3})?$/;
const CLIENT_ID = /^[A-Za-z0-9]{16,128}$/;
const CERTIFICATE_ID = /^[A-Za-z0-9_-]{8,128}$/;

export type NetSuiteList = "items" | "vendors" | "transactions" | "stock";

/**
 * The queries, fixed here. Every time is written back with TO_CHAR, since
 * SuiteQL would otherwise answer with the date only. Lists with a change
 * time are read oldest change first; stock has none and is read whole.
 */
const CHANGED = "TO_CHAR(%.lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS') AS modified";
const SINCE = "%.lastmodifieddate >= TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS')";
const ORDER = "ORDER BY %.lastmodifieddate, %.id";
const at = (sql: string, alias: string) => sql.replace(/%/g, alias);

export const NETSUITE_QUERIES: Readonly<Record<NetSuiteList, string>> = {
  items: `SELECT i.id, i.itemid, i.displayname, i.itemtype, i.isinactive, ${at(CHANGED, "i")} FROM item i WHERE ${at(SINCE, "i")} ${at(ORDER, "i")}`,
  vendors: `SELECT v.id, v.companyname, v.isperson, v.isinactive, c.symbol AS currency, ${at(CHANGED, "v")} FROM vendor v LEFT JOIN currency c ON c.id = v.currency WHERE ${at(SINCE, "v")} ${at(ORDER, "v")}`,
  transactions:
    "SELECT t.id, t.tranid, t.type, BUILTIN.DF(t.status) AS status, TO_CHAR(t.trandate, 'YYYY-MM-DD') AS trandate, TO_CHAR(t.duedate, 'YYYY-MM-DD') AS duedate, t.entity, c.symbol AS currency, t.foreigntotal, t.foreignamountremaining, " +
    `${at(CHANGED, "t")} FROM transaction t LEFT JOIN currency c ON c.id = t.currency WHERE t.type IN ('SalesOrd', 'PurchOrd', 'CustInvc', 'Journal') AND ${at(SINCE, "t")} ${at(ORDER, "t")}`,
  stock:
    "SELECT a.item, i.itemid, a.location, a.quantityonhand, a.quantityavailable, a.quantitycommitted, a.quantityonorder, a.quantitybackordered FROM aggregateitemlocation a JOIN item i ON i.id = a.item ORDER BY a.item, a.location",
};

export interface NetSuiteClientOptions {
  /** The account id (NETSUITE_ACCOUNT_ID), such as 1234567 or 1234567_SB1. */
  accountId: string;
  /** The integration record's client id (NETSUITE_CLIENT_ID). */
  clientId: string;
  /** The certificate id NetSuite gave when the certificate was mapped (NETSUITE_CERTIFICATE_ID). */
  certificateId: string;
  /** The certificate's private key, PEM or base64-encoded PEM (NETSUITE_PRIVATE_KEY). Signs the JWT here and is never sent. */
  privateKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
  now?: () => Date;
}

export class NetSuiteConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetSuiteConfigError";
  }
}

export class NetSuiteApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NetSuiteApiError";
  }
}

export interface NetSuitePage {
  rows: unknown[];
  /** NetSuite has rows after this page. */
  more: boolean;
}

export interface NetSuiteClient {
  /** One page of a list, from `offset` (a multiple of the page size), of rows changed at or after `since` (NetSuite time); stock takes no start. */
  page(list: NetSuiteList, since: string | null, offset: number): Promise<NetSuitePage>;
}

/** The account's SuiteTalk host: NetSuite writes the id in lower case, with a hyphen for the underscore. */
export const netSuiteHost = (accountId: string) => `https://${accountId.toLowerCase().replace("_", "-")}.suitetalk.api.netsuite.com`;

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** The JWT algorithm a key signs with: PS256 for RSA of 3072 bits or more, ES256, ES384 or ES512 for EC. */
export function netSuiteAlgorithm(key: KeyObject): "PS256" | "ES256" | "ES384" | "ES512" {
  const details = key.asymmetricKeyDetails ?? {};
  if (key.asymmetricKeyType === "rsa" && (details.modulusLength ?? 0) >= 3072) return "PS256";
  if (key.asymmetricKeyType === "ec") {
    const alg = new Map([["prime256v1", "ES256"], ["secp384r1", "ES384"], ["secp521r1", "ES512"]] as const).get(details.namedCurve as "prime256v1");
    if (alg) return alg;
  }
  throw new NetSuiteConfigError("NETSUITE_PRIVATE_KEY must be an RSA key of 3072 or 4096 bits, or an EC key on P-256, P-384 or P-521");
}

/**
 * The certificate's private key: PEM, with real line breaks or `\n`, or
 * that PEM base64-encoded on one line, which is easier to keep in a host's
 * settings.
 */
export function netSuitePrivateKey(value: string | undefined): KeyObject {
  const raw = value?.trim() ?? "";
  const pem = raw.startsWith("-----BEGIN") ? raw.replace(/\\n/g, "\n") : /^[A-Za-z0-9+/=\s]{1,20000}$/.test(raw) ? Buffer.from(raw, "base64").toString("utf8") : "";
  try {
    return createPrivateKey(pem);
  } catch {
    throw new NetSuiteConfigError("NETSUITE_PRIVATE_KEY is missing or isn't the certificate's private key, as PEM or base64-encoded PEM");
  }
}

const HASH = { PS256: "sha256", ES256: "sha256", ES384: "sha384", ES512: "sha512" } as const;

export function netSuiteClient(options: NetSuiteClientOptions): NetSuiteClient {
  const account = options.accountId?.trim().toUpperCase() ?? "";
  if (!ACCOUNT.test(account)) throw new NetSuiteConfigError("NETSUITE_ACCOUNT_ID is missing or not in the expected shape, such as 1234567 or 1234567_SB1");
  const clientId = options.clientId?.trim() ?? "";
  if (!CLIENT_ID.test(clientId)) throw new NetSuiteConfigError("NETSUITE_CLIENT_ID is missing or not in the expected shape");
  const certificateId = options.certificateId?.trim() ?? "";
  if (!CERTIFICATE_ID.test(certificateId)) throw new NetSuiteConfigError("NETSUITE_CERTIFICATE_ID is missing or not in the expected shape");
  const key = netSuitePrivateKey(options.privateKey);
  const alg = netSuiteAlgorithm(key);
  const host = netSuiteHost(account);
  const tokenUrl = `${host}/services/rest/auth/oauth2/v1/token`;
  const queryUrl = `${host}/services/rest/query/v1/suiteql`;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  const now = options.now ?? (() => new Date());
  let token: { value: string; until: number } | null = null;

  function assertion(): string {
    const iat = Math.floor(now().getTime() / 1000);
    const head = b64url(JSON.stringify({ typ: "JWT", alg, kid: certificateId }));
    const body = b64url(JSON.stringify({ iss: clientId, scope: NETSUITE_SCOPE, aud: tokenUrl, iat, exp: iat + ASSERTION_S }));
    const signature = sign(HASH[alg], Buffer.from(`${head}.${body}`), alg === "PS256" ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : { key, dsaEncoding: "ieee-p1363" });
    return `${head}.${body}.${b64url(signature)}`;
  }

  /** Sends a request, waiting out throttling and outages a few times. */
  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, init);
      if (!RETRIED.has(response.status) || attempt >= retries) return response;
      const after = Number(response.headers.get("retry-after"));
      await sleep(after > 0 ? 1000 * Math.min(after, MAX_WAIT_S) : 1000 * 2 ** attempt);
    }
  }

  async function accessToken(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const form = new URLSearchParams({ grant_type: "client_credentials", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion() });
    const response = await send(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString() });
    if (response.status === 400 || response.status === 401) {
      throw new NetSuiteConfigError("NetSuite turned down the sign-in: check NETSUITE_CLIENT_ID, NETSUITE_CERTIFICATE_ID and NETSUITE_PRIVATE_KEY, and that the certificate is mapped and not expired");
    }
    if (response.status !== 200) throw new NetSuiteApiError(`NetSuite answered HTTP ${response.status} for a token`, response.status);
    const body = ((await response.json().catch(() => undefined)) ?? {}) as Record<string, unknown>;
    const life = Number.isSafeInteger(body.expires_in) && (body.expires_in as number) > TOKEN_MARGIN_S ? (body.expires_in as number) : 0;
    if (typeof body.access_token !== "string" || body.access_token === "" || life === 0) throw new NetSuiteApiError("NetSuite answered without a token that reads", 200);
    token = { value: body.access_token, until: now().getTime() + 1000 * (life - TOKEN_MARGIN_S) };
    return token.value;
  }

  return {
    async page(list, since, offset) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset % NETSUITE_PAGE_SIZE !== 0 || offset >= NETSUITE_MAX_ROWS) {
        throw new NetSuiteApiError(`a ${list} offset must be a multiple of ${NETSUITE_PAGE_SIZE} below ${NETSUITE_MAX_ROWS}`, 0);
      }
      if ((list === "stock") !== (since === null) || (since !== null && !NETSUITE_TIME.test(since))) throw new NetSuiteApiError(`a ${list} start must be a NetSuite time, and stock takes none`, 0);
      const url = `${queryUrl}?limit=${NETSUITE_PAGE_SIZE}&offset=${offset}`;
      const payload = JSON.stringify(since === null ? { q: NETSUITE_QUERIES[list] } : { q: NETSUITE_QUERIES[list], params: [since] });
      for (let fresh = false; ; fresh = true) {
        const bearer = await accessToken();
        const response = await send(url, { method: "POST", headers: { authorization: `Bearer ${bearer}`, prefer: "transient", "content-type": "application/json", accept: "application/json" }, body: payload });
        const { status } = response;
        // A token can end early; one fresh token is tried before giving up.
        if (status === 401 && !fresh) {
          token = null;
          continue;
        }
        if (status === 401) throw new NetSuiteConfigError("NetSuite turned down the token: check that the role still has the Log in using OAuth 2.0 access tokens and REST Web Services permissions");
        if (status === 403) throw new NetSuiteConfigError(`NetSuite's role can't read the ${list}: give it view permission for them`);
        if (status !== 200) throw new NetSuiteApiError(`NetSuite answered HTTP ${status} for the ${list}`, status);
        const body = ((await response.json().catch(() => undefined)) ?? {}) as Record<string, unknown>;
        if (!Array.isArray(body.items) || typeof body.hasMore !== "boolean") throw new NetSuiteApiError(`NetSuite answered the ${list} without its rows and whether there are more`, 200);
        // A page NetSuite says starts elsewhere would read the same rows over and over.
        if (body.offset !== offset) throw new NetSuiteApiError(`NetSuite answered the ${list} from ${String(body.offset).slice(0, 12)} when asked from ${offset}`, 200);
        return { rows: body.items, more: body.hasMore };
      }
    },
  };
}
