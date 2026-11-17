import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * An Acumatica instance's contract-based REST API (the Default endpoint),
 * which JewelShop runs on, built from Acumatica's Integration Development
 * Guide. Data is synthetic. JewelShop needs a licensed Acumatica instance;
 * until one is set up, this mock stands in, and a live run confirms it.
 *
 * Docs facts the mock relies on:
 * - A token comes from POST /identity/connect/token, form-encoded with
 *   grant_type password, client_id (a GUID, an @ and the tenant),
 *   client_secret, username, password and scope api. It answers
 *   access_token, expires_in (an hour), token_type Bearer and scope.
 * - GET /entity/Default/{version}/{entity} takes $select, $filter
 *   (LastModified gt datetimeoffset'...'), $expand, $top and $skip, and
 *   answers a JSON list of records, each field written { "value": ... },
 *   with no count or next link.
 * - POST /entity/auth/logout ends the session, freeing the license's slot.
 * - Over the license's request rate, requests wait and then are answered
 *   429.
 */
// Acumatica's Integration Development Guide, as MYOB publishes it for MYOB Acumatica, the same product.
const DOCS = {
  rest: "https://help.myob.com.au/advanced/Docs/Published/IntegrationDevelopmentGuide/IntegrationDev_RESTExample_StockItem_GetModified.html",
  token: "https://help.myob.com.au/advanced/Docs/Published/IntegrationDevelopmentGuide/OAuthOIDC_ResourceOwner_AccessToken.html",
} as const;
export const ACUMATICA_DOC_PAGES = DOCS;

export type AcumaticaMockRecord = Record<string, unknown>;

const v = (value: unknown) => ({ value });
const at = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 86_400_000).toISOString().replace("Z", "+00:00");

/** A ring style stock item modified `n` days into October 2026, in two warehouses. */
export const acumaticaStockItem = fixtureBuilder<AcumaticaMockRecord>((n) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  rowNumber: n,
  note: v(""),
  InventoryID: v(`RING-${String(n).padStart(4, "0")}`),
  Description: v("Test 14K solitaire setting"),
  ItemClass: v("RINGS"),
  ItemStatus: v("Active"),
  ItemType: v("Finished Good"),
  BaseUOM: v("EA"),
  DefaultPrice: v(1250.5),
  LastModified: v(at(n)),
  WarehouseDetails: [
    { id: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`, WarehouseID: v("MAIN"), QtyOnHand: v(3) },
    { id: `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`, WarehouseID: v("MEMO"), QtyOnHand: v(1) },
  ],
  custom: {},
}));

/** A wholesale sales order modified `n` days into October 2026. */
export const acumaticaSalesOrder = fixtureBuilder<AcumaticaMockRecord>((n) => ({
  id: `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`,
  rowNumber: n,
  note: v("Test note for the customer"),
  OrderType: v("SO"),
  OrderNbr: v(`SO${String(n).padStart(6, "0")}`),
  Status: v("Open"),
  Date: v(at(n - 1)),
  CurrencyID: v("USD"),
  OrderTotal: v(4200.25),
  OrderedQty: v(4),
  CustomerID: v("TESTJEWELERS"),
  CustomerOrder: v("PO-TEST-1"),
  LastModified: v(at(n)),
  custom: {},
}));

export interface AcumaticaMockData {
  baseUrl?: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  stockItems?: AcumaticaMockRecord[];
  salesOrders?: AcumaticaMockRecord[];
  /** 429s to answer before the next reads. */
  rateLimits?: number;
  /** The tokens handed out are turned down this many times first, as if their session ended. */
  expireTokens?: number;
  /** Entities the user's role can't view. */
  hidden?: string[];
}

const error = (status: number, body: Record<string, string>): DocMockResponse => ({ status, body });
const FIELDS: Record<string, string> = {
  StockItem: "InventoryID,Description,ItemClass,ItemStatus,ItemType,BaseUOM,DefaultPrice,LastModified,WarehouseDetails/WarehouseID,WarehouseDetails/QtyOnHand",
  SalesOrder: "OrderType,OrderNbr,Status,Date,CurrencyID,OrderTotal,OrderedQty,CustomerID,LastModified",
};
const LITERAL = /^datetimeoffset'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00)'$/;

/** Reads the filter the connector sends: LastModified gt/le datetimeoffset terms joined by and. Null when it doesn't read. */
function filterOf(raw: string | undefined): ((t: number) => boolean) | null {
  if (raw === undefined) return () => true;
  const tests: ((t: number) => boolean)[] = [];
  for (const term of raw.split(" and ")) {
    const m = /^LastModified (gt|le) (.+)$/.exec(term);
    const lit = m ? LITERAL.exec(m[2]!) : null;
    if (!m || !lit) return null;
    const bound = Date.parse(lit[1]!);
    tests.push(m[1] === "gt" ? (t) => t > bound : (t) => t <= bound);
  }
  return (t) => tests.every((f) => f(t));
}

const modified = (r: AcumaticaMockRecord) => Date.parse(String((r.LastModified as { value?: unknown })?.value));

export interface AcumaticaMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each list read: its entity and query. */
  readonly reads: { entity: string; query: Record<string, string> }[];
  readonly signIns: number;
  readonly signOuts: number;
}

export function acumaticaDocMock(data: AcumaticaMockData): AcumaticaMock {
  const reads: { entity: string; query: Record<string, string> }[] = [];
  let limits = data.rateLimits ?? 0;
  let expire = data.expireTokens ?? 0;
  let signIns = 0;
  let signOuts = 0;
  const live = new Set<string>();
  const bearer = (h: Headers) => /^Bearer (\S+)$/.exec(h.get("authorization") ?? "")?.[1];
  const list = (entity: "StockItem" | "SalesOrder") => ({
    method: "GET" as const,
    path: `/entity/Default/24.200.001/${entity}`,
    documentedAt: DOCS.rest,
    respond(request: { headers: Headers; url: URL }): DocMockResponse {
      const token = bearer(request.headers);
      if (!token || !live.has(token)) return error(401, { message: "You are not logged in." });
      if (expire > 0) {
        expire--;
        live.delete(token);
        return error(401, { message: "You are not logged in." });
      }
      if (limits > 0) {
        limits--;
        return { status: 429, body: { message: "API request limit exceeded." }, headers: { "retry-after": "1" } };
      }
      if (data.hidden?.includes(entity)) return error(403, { message: "You have insufficient rights to access the object." });
      const query = Object.fromEntries(request.url.searchParams);
      reads.push({ entity, query });
      if (query.$select !== FIELDS[entity]) return error(400, { message: "Invalid $select." });
      if (entity === "StockItem" ? query.$expand !== "WarehouseDetails" : query.$expand !== undefined) return error(400, { message: "Invalid $expand." });
      const keep = filterOf(query.$filter);
      if (!keep) return error(400, { message: "Invalid $filter." });
      const top = query.$top === undefined ? Number.POSITIVE_INFINITY : Number(query.$top);
      const skip = query.$skip === undefined ? 0 : Number(query.$skip);
      if (!(top >= 1) || !Number.isInteger(skip) || skip < 0) return error(400, { message: "Invalid paging." });
      const rows = ((entity === "StockItem" ? data.stockItems : data.salesOrders) ?? []).filter((r) => keep(modified(r)));
      return { status: 200, body: rows.slice(skip, skip + top) };
    },
  });
  const api = checkDocMock({
    integration: "acumatica_jewelshop",
    baseUrl: data.baseUrl ?? "https://jewelshop.example.test",
    source: { url: DOCS.rest, title: "Acumatica Integration Development Guide: contract-based REST API", retrievedOn: "2026-11-11", version: "Default 24.200.001" },
    assumptions: [
      "Records list in key order, so $skip pages are stable while nothing changes",
      "LastModified is written with its offset",
      "A token whose session ended is answered 401",
      "JewelShop keeps stock items and sales orders on the Default endpoint",
    ],
    routes: [
      {
        method: "POST",
        path: "/identity/connect/token",
        documentedAt: DOCS.token,
        respond(request) {
          const form = new URLSearchParams(request.body);
          if (request.headers.get("content-type") !== "application/x-www-form-urlencoded" || form.get("grant_type") !== "password" || form.get("scope") !== "api") return error(400, { error: "unsupported_grant_type" });
          if (form.get("client_id") !== data.clientId || form.get("client_secret") !== data.clientSecret) return error(400, { error: "invalid_client" });
          if (form.get("username") !== data.username || form.get("password") !== data.password) return error(400, { error: "invalid_grant" });
          signIns++;
          const token = `tok${"0".repeat(20)}${signIns}`;
          live.add(token);
          return { status: 200, body: { access_token: token, expires_in: 3600, token_type: "Bearer", scope: "api" } };
        },
      },
      list("StockItem"),
      list("SalesOrder"),
      {
        method: "POST",
        path: "/entity/auth/logout",
        documentedAt: DOCS.rest,
        respond(request) {
          const token = bearer(request.headers);
          if (token) live.delete(token);
          signOuts++;
          return { status: 204 };
        },
      },
    ],
  });
  return {
    api,
    fetch: docMockFetch(api),
    reads,
    get signIns() {
      return signIns;
    },
    get signOuts() {
      return signOuts;
    },
  };
}

export default {
  integration: "acumatica_jewelshop",
  covers: "An Acumatica instance's token endpoint, stock items, sales orders and sign-out on the contract-based REST API (Default 24.200.001)",
  watchPages: [DOCS.rest, DOCS.token],
  docMocks: () => [acumaticaDocMock({ clientId: "", clientSecret: "", username: "", password: "" }).api],
} satisfies DocMockModule;
