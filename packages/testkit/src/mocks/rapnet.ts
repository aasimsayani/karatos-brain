import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * The Rapaport Price List API and the token service in front of it, built
 * from RapTech's developer pages. Prices are made up: the real list is
 * copyrighted and for subscribers only, so no fixture comes near it.
 *
 * Docs facts the mock relies on:
 * - A machine-to-machine token is a POST of client_id and client_secret as
 *   JSON to https://authztoken.api.rapaport.com/api/get, answering
 *   access_token, scope, expires_in and token_type Bearer; one token serves
 *   every API (raptech.rapaport.com/rapaport-developer-documentation).
 * - The lists are GETs on https://technet.rapnetapis.com with Authorization
 *   Bearer: /pricelist/api/Prices/list?shape=Round&csvnormalized=true for a
 *   shape's full list, and /pricelist/api/Prices/changes?shape=round for the
 *   cells that changed; both answer a bare JSON array of rows with shape,
 *   low_size, high_size, color, clarity, caratprice and date, changes adding
 *   old_caratprice and old_date (raptech.rapaport.com/rapaport-price-lists).
 * - Lists exist for Round and Pear only; a new list is published every
 *   Thursday at 11:59 pm Eastern (same page).
 */
const DOCS = "https://raptech.rapaport.com";
const AUTH = "https://authztoken.api.rapaport.com";
const API = "https://technet.rapnetapis.com";

export type RapnetMockRow = Record<string, unknown>;

export interface RapnetMockData {
  clientId: string;
  clientSecret: string;
  /** Each shape's list, by lowercase shape. */
  lists: Partial<Record<"round" | "pear", RapnetMockRow[]>>;
  /** Each shape's changed cells, by lowercase shape. */
  changes?: Partial<Record<"round" | "pear", RapnetMockRow[]>>;
  /** Seconds a token is good for. */
  expiresIn?: number;
  /** Answer 403 to the price list, as for an account without the subscription. */
  noSubscription?: boolean;
  /** The next this many price list requests answer 429. */
  throttle?: number;
}

/** Made-up cells in Rapaport's row shape, priced in round numbers no real list uses. */
export const rapaportRow = fixtureBuilder<RapnetMockRow>((n) => ({
  shape: "Round",
  low_size: "1.00",
  high_size: "1.49",
  color: "DEFGHIJKLM"[n % 10],
  clarity: ["IF", "VVS1", "VVS2", "VS1", "VS2", "SI1", "SI2", "SI3", "I1", "I2", "I3"][n % 11],
  caratprice: `${1000 + n * 10}.0000`,
  date: "10/22/2026 00:00:00",
}));

export interface RapnetMock {
  auth: DocMock;
  api: DocMock;
  /** Answers both hosts, and throws for any other. */
  fetch: DocMockFetch;
  /** Every request answered, in order: token, list:<shape> or changes:<shape>. */
  readonly operations: string[];
  /** Makes every token issued so far stop working, as when one expires early. */
  expireTokens(): void;
}

export function rapnetDocMock(data: RapnetMockData): RapnetMock {
  const operations: string[] = [];
  const live = new Set<string>();
  let issued = 0;
  let throttle = data.throttle ?? 0;

  const auth = checkDocMock({
    integration: "rapnet",
    baseUrl: AUTH,
    source: { url: `${DOCS}/rapaport-developer-documentation/`, title: "Rapaport Developer Documentation", retrievedOn: "2026-10-25", version: "machine-to-machine token, api/get" },
    assumptions: ["A wrong client ID or secret answers 401"],
    routes: [
      {
        method: "POST",
        path: "/api/get",
        documentedAt: `${DOCS}/rapaport-developer-documentation/`,
        respond(request) {
          operations.push("token");
          let body: { client_id?: unknown; client_secret?: unknown };
          try {
            body = JSON.parse(request.body) as typeof body;
          } catch {
            return { status: 400, body: { error: "invalid_request" } };
          }
          if (body.client_id !== data.clientId || body.client_secret !== data.clientSecret) return { status: 401, body: { error: "access_denied", error_description: "Unauthorized" } };
          const token = `mock-token-${++issued}`;
          live.add(token);
          return { status: 200, body: { access_token: token, scope: "apiGateway", expires_in: data.expiresIn ?? 28800, token_type: "Bearer" } };
        },
      },
    ],
  });

  const prices = (kind: "list" | "changes") => (request: { url: URL; headers: Headers }): DocMockResponse => {
    const shape = (request.url.searchParams.get("shape") ?? "").toLowerCase();
    operations.push(`${kind}:${shape}`);
    if (throttle > 0) {
      throttle--;
      return { status: 429, body: { message: "Too Many Requests" }, headers: { "retry-after": "2" } };
    }
    if (!live.has((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""))) return { status: 401, body: { message: "Unauthorized" } };
    if (data.noSubscription) return { status: 403, body: { message: "Forbidden" } };
    if (shape !== "round" && shape !== "pear") return { status: 400, body: { message: "Invalid shape" } };
    return { status: 200, body: (kind === "list" ? data.lists : (data.changes ?? {}))[shape] ?? [] };
  };

  const api = checkDocMock({
    integration: "rapnet",
    baseUrl: API,
    source: { url: `${DOCS}/rapaport-price-lists/`, title: "Rapaport Price List", retrievedOn: "2026-10-25", version: "pricelist/api" },
    auth: "bearer",
    assumptions: [
      "caratprice is US dollars per carat",
      "date on a row is the day that cell was priced, so the newest is the list's date",
      "An expired token answers 401 and an account without the price list answers 403",
      "Throttling answers 429 with Retry-After",
    ],
    routes: [
      { method: "GET", path: "/pricelist/api/Prices/list", documentedAt: `${DOCS}/rapaport-price-lists/`, respond: prices("list") },
      { method: "GET", path: "/pricelist/api/Prices/changes", documentedAt: `${DOCS}/rapaport-price-lists/`, respond: prices("changes") },
    ],
  });

  const authFetch = docMockFetch(auth);
  const apiFetch = docMockFetch(api);
  const calls: { method: string; url: string }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const response = await (url.origin === AUTH ? authFetch : apiFetch)(input, init);
    calls.push({ method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(), url: url.toString() });
    return response;
  };

  return {
    auth,
    api,
    fetch: Object.assign(fetch, { calls }),
    get operations() {
      return operations;
    },
    expireTokens: () => live.clear(),
  };
}

export default {
  integration: "rapnet",
  covers: "Rapaport's token service and Price List API: the full list and its changes",
  watchPages: [`${DOCS}/rapaport-developer-documentation/`, `${DOCS}/rapaport-price-lists/`],
  docMocks: () => {
    const mock = rapnetDocMock({ clientId: "", clientSecret: "", lists: {} });
    return [mock.auth, mock.api];
  },
} satisfies DocMockModule;
