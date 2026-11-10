import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Docusign's JWT Grant sign-in, its user info, and the eSignature REST API's
 * list of envelope status changes (v2.1), on the developer environment,
 * built from Docusign's developer docs. Data is synthetic. The sign-in
 * checks the JWT's RS256 signature against the app's public key and its
 * claims, so a test can show the connector asks for nothing beyond
 * `signature impersonation`.
 */
const ACCOUNT = "https://account-d.docusign.com";
const API = "https://demo.docusign.net";
const DOCS = "https://developers.docusign.com";

export interface DocusignMockRecipients {
  [list: string]: Record<string, unknown>[] | string | undefined;
}

export interface DocusignMockEnvelope {
  envelopeId: string;
  status: string;
  emailSubject: string;
  createdDateTime: string;
  statusChangedDateTime: string;
  lastModifiedDateTime?: string | undefined;
  sentDateTime?: string | undefined;
  completedDateTime?: string | undefined;
  [field: string]: unknown;
  recipients?: DocusignMockRecipients | undefined;
}

export interface DocusignMockData {
  integrationKey: string;
  userId: string;
  accountId: string;
  /** The app's public key, which checks each sign-in's signature. */
  publicKey: KeyObject | string;
  envelopes: DocusignMockEnvelope[];
  /** False until the user consents to the app. Defaults to true. */
  consented?: boolean;
  /** Rows per page the mock caps at, to exercise paging. */
  pageCap?: number;
  /** The account's API address in user info. */
  baseUri?: string;
  /** How many of the next envelope reads answer 429, each with Retry-After `retryAfter` seconds (default 1). */
  rateLimited?: number;
  retryAfter?: string;
}

export interface DocusignMock {
  identity: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  /** Tokens handed out so far. */
  readonly signIns: number;
  /** Makes every token handed out so far stop working, as an expiry or revocation would. */
  revokeTokens(): void;
}

const QUERY_KEYS = new Set(["from_date", "to_date", "status", "include", "order_by", "order", "count", "start_position", "from_to_status"]);

const error = (status: number, errorCode: string, message: string): DocMockResponse => ({ status, body: { errorCode, message } });
const oauthError = (error: string): DocMockResponse => ({ status: 400, body: { error } });
const decode = (part: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export function docusignDocMock(data: DocusignMockData): DocusignMock {
  const publicKey = typeof data.publicKey === "string" ? createPublicKey(data.publicKey) : data.publicKey;
  const tokens = new Set<string>();
  let signIns = 0;

  const identity = checkDocMock({
    integration: "docusign",
    baseUrl: ACCOUNT,
    source: { url: `${DOCS}/platform/auth/jwt-get-token/`, title: "How to get an access token with JWT Grant", retrievedOn: "2026-11-08", version: "OAuth 2.0 JWT Grant" },
    assumptions: [
      "An expired or wrongly signed JWT answers 400 invalid_grant",
      "A JWT for an app the user hasn't consented to answers 400 consent_required",
      "The JWT's scope is echoed back as the token's scope",
    ],
    routes: [
      {
        method: "POST",
        path: "/oauth/token",
        documentedAt: `${DOCS}/platform/auth/jwt-get-token/`,
        respond(request) {
          const form = new URLSearchParams(request.body);
          if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return oauthError("unsupported_grant_type");
          const parts = (form.get("assertion") ?? "").split(".");
          if (parts.length !== 3) return oauthError("invalid_request");
          const [h, c, s] = parts as [string, string, string];
          const header = decode(h);
          const claims = decode(c);
          if (!header || header.alg !== "RS256" || !claims) return oauthError("invalid_request");
          if (claims.iss !== data.integrationKey) return oauthError("issuer_not_found");
          if (!verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url"))) return oauthError("no_valid_keys_or_signatures");
          if (claims.sub !== data.userId) return oauthError("user_not_found");
          if (claims.aud !== "account-d.docusign.com" || typeof claims.iat !== "number" || typeof claims.exp !== "number" || claims.exp <= claims.iat || claims.exp - claims.iat > 3600) return oauthError("invalid_grant");
          if (typeof claims.scope !== "string" || claims.scope !== "signature impersonation") return oauthError("invalid_scope");
          if (data.consented === false) return oauthError("consent_required");
          signIns++;
          const token = `eyJ0eXAi.${"t".repeat(40)}${signIns}`;
          tokens.add(token);
          return { status: 200, body: { access_token: token, token_type: "Bearer", expires_in: 3600, scope: claims.scope } };
        },
      },
      {
        method: "GET",
        path: "/oauth/userinfo",
        documentedAt: `${DOCS}/platform/auth/reference/`,
        respond(request) {
          if (!tokens.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) return { status: 401, body: { error: "invalid_token" } };
          return {
            status: 200,
            body: {
              sub: data.userId,
              name: "Test Viewer",
              email: "viewer@example.test",
              accounts: [
                { account_id: "99999999-9999-4999-8999-999999999999", is_default: false, account_name: "Other Test Account", base_uri: "https://na2.docusign.net" },
                { account_id: data.accountId, is_default: true, account_name: "Test Jeweler", base_uri: data.baseUri ?? API },
              ],
            },
          };
        },
      },
    ],
  });

  const api = checkDocMock({
    integration: "docusign",
    baseUrl: API,
    source: { url: `${DOCS}/docs/esign-rest-api/esign101/rules-and-limits/`, title: "eSignature API rules and resource limits", retrievedOn: "2026-11-08", version: "v2.1" },
    auth: "bearer",
    assumptions: [
      "from_date with no status filter returns envelopes whose statusChangedDateTime is at or after it",
      "order_by=status_changed with order=asc keeps that order across start_position pages",
      "status=sent,delivered with from_date returns envelopes now in those statuses whose status changed since from_date",
      "Counts (resultSetSize, totalSetSize, startPosition, endPosition) are strings, and envelopes is left out when nothing matches",
      "A throttled request answers 429 with Retry-After in seconds",
      "The Viewer permission profile can't send envelopes, and shared access lets its user list the senders' envelopes",
    ],
    routes: [
      {
        method: "GET",
        path: "/restapi/v2.1/accounts/{accountId}/envelopes",
        documentedAt: `${DOCS}/docs/esign-rest-api/reference/envelopes/envelopes/liststatuschanges`,
        respond(request, params) {
          if (!tokens.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) return error(401, "USER_AUTHENTICATION_FAILED", "One or both of Username and Password are invalid.");
          if (params.accountId !== data.accountId) return error(400, "USER_DOES_NOT_BELONG_TO_SPECIFIED_ACCOUNT", "The specified User is not a member of the specified Account.");
          if (data.rateLimited) {
            data.rateLimited--;
            return { ...error(429, "HOURLY_APIINVOCATION_LIMIT_EXCEEDED", "The maximum number of hourly API invocations has been exceeded."), headers: { "Retry-After": data.retryAfter ?? "1" } };
          }
          const q = request.url.searchParams;
          if ([...q.keys()].some((k) => !QUERY_KEYS.has(k))) return error(400, "INVALID_REQUEST_PARAMETER", "The request contained at least one invalid parameter.");
          const from = q.get("from_date");
          if (!from || Number.isNaN(Date.parse(from))) return error(400, "INVALID_REQUEST_PARAMETER", "The request contained at least one invalid parameter. A value for 'from_date' must be set.");
          const count = Number(q.get("count") ?? "1000");
          const start = Number(q.get("start_position") ?? "0");
          if (!Number.isInteger(count) || count < 1 || count > 1000 || !Number.isInteger(start) || start < 0) return error(400, "INVALID_REQUEST_PARAMETER", "The request contained at least one invalid parameter.");
          const statuses = q.get("status")?.split(",");
          let rows = data.envelopes.filter((e) => Date.parse(e.statusChangedDateTime) >= Date.parse(from) && (!statuses || statuses.includes(e.status)));
          const by = q.get("order_by");
          const field = by === "created" ? "createdDateTime" : by === "status_changed" ? "statusChangedDateTime" : undefined;
          if (field) rows = [...rows].sort((a, b) => (Date.parse(String(a[field])) - Date.parse(String(b[field]))) * (q.get("order") === "desc" ? -1 : 1));
          const include = q.get("include")?.split(",") ?? [];
          const page = rows.slice(start, start + Math.min(count, data.pageCap ?? 1000)).map((e) => {
            const { recipients, ...rest } = e;
            return include.includes("recipients") ? { ...rest, recipients: recipients ?? {} } : rest;
          });
          const end = start + page.length;
          return {
            status: 200,
            body: {
              resultSetSize: String(page.length),
              totalSetSize: String(rows.length),
              startPosition: String(start),
              endPosition: String(Math.max(end - 1, 0)),
              nextUri: end < rows.length ? `/accounts/${data.accountId}/envelopes?start_position=${end}` : null,
              previousUri: start > 0 ? `/accounts/${data.accountId}/envelopes?start_position=${Math.max(start - count, 0)}` : null,
              ...(page.length ? { envelopes: page } : {}),
            },
          };
        },
      },
    ],
  });

  const identityFetch = docMockFetch(identity);
  const apiFetch = docMockFetch(api);
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      // Routed by exact origin, so a look-alike host goes to the API mock and is refused there.
      const toIdentity = new URL(input instanceof Request ? input.url : String(input)).origin === ACCOUNT;
      const response = await (toIdentity ? identityFetch : apiFetch)(input, init);
      calls.push(...(toIdentity ? identityFetch.calls : apiFetch.calls).slice(-1));
      return response;
    },
    { calls },
  );
  return {
    identity,
    api,
    fetch,
    get signIns() {
      return signIns;
    },
    revokeTokens: () => tokens.clear(),
  };
}

export default {
  integration: "docusign",
  covers: "Docusign's JWT Grant sign-in, user info and envelope status changes (eSignature REST API v2.1)",
  watchPages: [
    `${DOCS}/platform/auth/jwt-get-token/`,
    `${DOCS}/platform/auth/reference/`,
    `${DOCS}/docs/esign-rest-api/esign101/rules-and-limits/`,
    `${DOCS}/docs/esign-rest-api/reference/envelopes/envelopes/liststatuschanges`,
  ],
  docMocks: () => {
    const mock = docusignDocMock({ integrationKey: "", userId: "", accountId: "", publicKey: PLACEHOLDER_KEY, envelopes: [] });
    return [mock.identity, mock.api];
  },
} satisfies DocMockModule;

/** A public key for the empty mocks the registry lists; they never check a sign-in. */
const PLACEHOLDER_KEY = {} as KeyObject;
