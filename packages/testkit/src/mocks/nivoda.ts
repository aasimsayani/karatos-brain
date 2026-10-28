import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Nivoda's GraphQL diamond API, built from Nivoda's buyer help pages on its
 * API. Diamonds are synthetic, with made-up ids, certificate numbers and
 * prices.
 *
 * Docs facts the mock relies on:
 * - Every request is a GraphQL POST to /api/diamonds: integrations.nivoda.net
 *   in production, intg-customer-staging.nivodaapi.net on staging (API
 *   Installation Guide).
 * - authenticate { username_and_password(username, password) { token } }
 *   signs in, and the token lasts 6 hours (same page).
 * - Searches run inside as(token) as diamonds_by_query(query, offset, limit,
 *   order), answering items and total_count; get_diamond_by_id looks one up
 *   (same page).
 * - At most 50 diamonds come back a response; offset pages through the rest
 *   (Why does the API only receive 50 diamonds per response).
 * - At least 30 seconds should pass between two requests (How much time
 *   should you wait before firing another API request).
 * - No query field is mandatory (What mandatory fields do I need).
 */
const BASE = "https://integrations.nivoda.net";
const HELP = "https://buyerhelp.nivoda.com/hc/en-gb/articles";
const GUIDE = `${HELP}/47645423678993-API-Installation-Guide`;

/** A search result as Nivoda answers it: the offer, with the diamond and its certificate inside. */
export interface NivodaMockDiamond {
  id: string;
  price: number;
  discount?: number | null;
  diamond: {
    id: string;
    availability?: string | null;
    NivodaStockId?: string | null;
    supplierStockId?: string | null;
    image?: string | null;
    video?: string | null;
    brown?: string | null;
    green?: string | null;
    milky?: string | null;
    eyeClean?: string | null;
    mine_of_origin?: string | null;
    certificate: Record<string, unknown>;
  };
}

export const nivodaDiamond = fixtureBuilder<NivodaMockDiamond>((n) => ({
  id: `TESTOFFER${n}`,
  price: 400_000 + n * 1_000,
  discount: -20.5,
  diamond: {
    id: `TESTDIAMOND${n}`,
    availability: "AVAILABLE",
    NivodaStockId: `NIV-TEST-${n}`,
    supplierStockId: `SUP-TEST-${n}`,
    image: `https://example.test/nivoda/${n}.jpg`,
    video: null,
    brown: "NONE",
    green: "NONE",
    milky: "NONE",
    eyeClean: "YES",
    mine_of_origin: null,
    certificate: {
      id: `TESTCERTID${n}`,
      lab: "GIA",
      certNumber: `TESTCERT${n}`,
      shape: "ROUND",
      carats: 1.01,
      color: "G",
      clarity: "VS1",
      cut: "EX",
      polish: "EX",
      symmetry: "VG",
      floInt: "FAINT",
      floCol: "BLUE",
      length: 6.42,
      width: 6.45,
      depth: 3.98,
      depthPercentage: 61.8,
      table: 57,
      girdle: "MEDIUM",
      labgrown: false,
    },
  },
}));

export interface NivodaMockData {
  username: string;
  password: string;
  /** The diamonds the search finds, cheapest first, or a function of the offset asked for, for a search that changes while it is read. */
  diamonds: NivodaMockDiamond[] | ((offset: number) => { items: unknown[]; total: number });
  /** The next this many requests answer 429. */
  throttle?: number;
}

/** One request the mock answered: what it asked for, without the password or token. */
export type NivodaMockOperation = { op: "sign_in"; username: unknown } | { op: "search"; query: unknown; offset: unknown; limit: unknown; order: string } | { op: "diamond"; id: unknown } | { op: "unknown" };

export interface NivodaMock {
  api: DocMock;
  fetch: DocMockFetch;
  readonly operations: NivodaMockOperation[];
  /** Every token issued so far stops working, as one does after 6 hours. */
  expireTokens(): void;
}

const errors = (message: string): DocMockResponse => ({ status: 200, body: { data: null, errors: [{ message }] } });

export function nivodaDocMock(data: NivodaMockData): NivodaMock {
  const operations: NivodaMockOperation[] = [];
  const tokens = new Set<string>();
  let issued = 0;
  let throttle = data.throttle ?? 0;

  const api = checkDocMock({
    integration: "nivoda",
    baseUrl: BASE,
    source: { url: GUIDE, title: "Nivoda - API Installation Guide", retrievedOn: "2026-10-28", version: "GraphQL API, diamonds endpoint" },
    assumptions: [
      "price is the whole price in US cents, for an account whose API currency is US dollars",
      "The certificate's grades and measurements, stock ids, shade and eye-clean fields carry the names other Nivoda integrations use",
      "The search filter is the DiamondQuery input type",
      "A bad sign-in or a token that has expired answers HTTP 200 with a GraphQL error naming it",
      "Throttling answers 429 with Retry-After",
    ],
    routes: [
      {
        method: "POST",
        path: "/api/diamonds",
        documentedAt: GUIDE,
        respond(request): DocMockResponse {
          if (throttle > 0) {
            throttle--;
            return { status: 429, body: { message: "Too Many Requests" }, headers: { "retry-after": "5" } };
          }
          let body: { query?: unknown; variables?: Record<string, unknown> };
          try {
            body = JSON.parse(request.body) as typeof body;
          } catch {
            return { status: 400, body: { errors: [{ message: "Unexpected token in JSON" }] } };
          }
          const query = typeof body.query === "string" ? body.query : "";
          const v = body.variables ?? {};
          if (/username_and_password/.test(query)) {
            operations.push({ op: "sign_in", username: v.username });
            if (v.username !== data.username || v.password !== data.password) return errors("Unauthorized: the username or password is wrong");
            const token = `test-token-${++issued}-${"x".repeat(24)}`;
            tokens.add(token);
            return { status: 200, body: { data: { authenticate: { username_and_password: { token } } } } };
          }
          const signedIn = typeof v.token === "string" && tokens.has(v.token);
          if (/diamonds_by_query/.test(query)) {
            const order = /order:\s*\{\s*type:\s*(\w+),\s*direction:\s*(\w+)\s*\}/.exec(query);
            operations.push({ op: "search", query: v.query, offset: v.offset, limit: v.limit, order: order ? `${order[1]} ${order[2]}` : "none" });
            if (!signedIn) return errors("Token expired or invalid");
            if (typeof v.limit !== "number" || v.limit > 50) return errors("limit must be 50 or fewer");
            if (typeof v.offset !== "number" || v.offset < 0 || v.offset > 50_000) return errors("offset must be from 0 to 50000");
            const page = typeof data.diamonds === "function" ? data.diamonds(v.offset) : { items: data.diamonds.slice(v.offset, v.offset + v.limit), total: data.diamonds.length };
            return { status: 200, body: { data: { as: { diamonds_by_query: { total_count: page.total, items: page.items } } } } };
          }
          if (/get_diamond_by_id/.test(query)) {
            operations.push({ op: "diamond", id: v.id });
            if (!signedIn) return errors("Token expired or invalid");
            const all = typeof data.diamonds === "function" ? (data.diamonds(0).items as NivodaMockDiamond[]) : data.diamonds;
            return { status: 200, body: { data: { as: { get_diamond_by_id: all.find((d) => d.id === v.id) ?? null } } } };
          }
          operations.push({ op: "unknown" });
          return errors("Cannot query that field");
        },
      },
    ],
  });

  return {
    api,
    fetch: docMockFetch(api),
    get operations() {
      return operations;
    },
    expireTokens: () => tokens.clear(),
  };
}

export default {
  integration: "nivoda",
  covers: "Nivoda's GraphQL diamond search: sign-in, diamonds_by_query and get_diamond_by_id",
  watchPages: [GUIDE],
  docMocks: () => [nivodaDocMock({ username: "", password: "", diamonds: [] }).api],
} satisfies DocMockModule;
