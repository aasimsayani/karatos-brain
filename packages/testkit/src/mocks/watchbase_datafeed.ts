import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * The three reads of the WatchBase Data Feed API (v1) a read-only connector
 * uses, built from WatchBase's datafeed manual. Data is synthetic. WatchBase
 * has no sandbox; once a datafeed account's key is set up, recordings
 * replace this mock.
 *
 * Docs facts the mock relies on:
 * - The API takes simple HTTP requests, parameters as GET or POST vars, and
 *   answers XML by default or JSON with `format=json` (api-entry-points).
 * - Every entry point needs `key`, the account's API key, and takes
 *   `format` (xml or json) (each entry point's page).
 * - `GET https://api.watchbase.com/v1/brands` lists every brand,
 *   {num_results, brands: brand {id, name}} (brands).
 * - `GET /v1/watches` needs `brand-id` and takes `family-id` and
 *   `updated-since` (yyyy-mm-dd: only watches created or modified after that
 *   date); it answers {num_results, watches: watch {id, refnr, name, brand
 *   {id, name}, family {id, name}, thumb, updated}} (watches).
 * - `GET /v1/watch` needs `id` and answers {watch} with wb {id, added,
 *   modified, published}, reference_number, name, gender, released, stopped,
 *   waterresistance ("30.00 m"), description, brand {id, name, slug,
 *   country_code, logo, website, pricerange_currency}, family {id, name,
 *   slug}, caliber {reference_number, image, diameter, jewels, powerreserve
 *   ("40 h"), brand, type, display, hands}, case {materials {material},
 *   coating, glass, back, shape, diameter, height, lugwidth} and dial
 *   {color, finish, indextype, handstyle} (watch).
 * - Each watch entry costs US$0.25 in DataFeed credits, and the feed has no
 *   images (datafeed manual).
 */
const BASE = "https://api.watchbase.com/v1";
const MANUAL = "https://watchbase.com/manuals/datafeed/1/en/topic";
export const WATCHBASE_DOC_PAGES = {
  entryPoints: `${MANUAL}/api-entry-points`,
  brands: `${MANUAL}/brands`,
  watches: `${MANUAL}/watches`,
  watch: `${MANUAL}/watch`,
} as const;
/** Credits one watch read costs: US$0.25, at one cent a credit. */
export const WATCHBASE_CREDITS_PER_WATCH = 25;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[1-9][0-9]{0,8}$/;

export type WatchbaseMockRecord = Record<string, unknown>;

/** A synthetic brand, by number: Testmaker 1 is BrandID 901. */
export const watchbaseBrand = (n: number) => ({ id: 900 + n, name: `Testmaker ${n}` });

/**
 * Watch `n`: watch id 5000 + n of Testmaker 1, in family 7001, reference
 * TM-<n>, added on day `n` of 2026 and modified the day after, with every
 * spec the watch page shows, a description and images the connector must drop.
 */
export const watchbaseWatch = fixtureBuilder<WatchbaseMockRecord>((n) => {
  const day = (k: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + (k - 1) * 86_400_000).toISOString().slice(0, 10);
  return {
    wb: { id: 5000 + n, added: day(n), modified: day(n + 1), published: day(n + 1) },
    reference_number: `TM-${n}`,
    name: `Test Diver ${n}`,
    gender: "M",
    released: 2020,
    stopped: "",
    waterresistance: "100.00 m",
    description: "A test description the connector must drop",
    brand: { id: 901, name: "Testmaker 1", slug: "testmaker-1", country_code: "", logo: "https://example.test/logo.png", website: "https://example.test", pricerange_currency: "EUR" },
    family: { id: 7001, name: "Test Series", slug: "test-series" },
    caliber: { reference_number: "TC-1", image: "https://example.test/caliber.png", diameter: "26.00 mm", jewels: 21, powerreserve: "40 h", brand: "Testworks", type: "Automatic", display: "Analog", hands: "Hours, Minutes, Seconds" },
    case: { materials: { material: ["Stainless steel"] }, coating: "PVD", glass: "Sapphire", back: "Closed", shape: "Round", diameter: "40.00 mm", height: "12.50 mm", lugwidth: "20.00 mm" },
    dial: { color: "Black", finish: "Matte", indextype: "Stick", handstyle: "Sword" },
  };
});

export interface WatchbaseMockData {
  apiKey: string;
  /** The brands /v1/brands lists, {id, name}; Testmaker 1 and 2 unless given. */
  brands?: { id: number; name: string }[];
  /** Watches with the full record /v1/watch answers; /v1/watches lists them by their brand.id. */
  watches?: WatchbaseMockRecord[];
  /** Rate-limited (429) answers to give before the next calls. */
  rateLimits?: number;
}

export interface WatchbaseMock {
  mock: DocMock;
  fetch: DocMockFetch;
  /** Each read answered 200: its path and its query without the key. */
  readonly reads: { path: string; query: Record<string, string> }[];
  /** Credits the watch reads answered so far have cost. */
  readonly creditsUsed: number;
}

const obj = (v: unknown) => (v ?? {}) as Record<string, unknown>;

export function watchbaseDocMock(data: WatchbaseMockData): WatchbaseMock {
  const reads: WatchbaseMock["reads"] = [];
  let limits = data.rateLimits ?? 0;
  let credits = 0;
  const brands = data.brands ?? [watchbaseBrand(1), watchbaseBrand(2)];
  const watches = data.watches ?? [];

  /** Checks the key, the rate limit, the format and the parameters, then answers. */
  function read(allowed: string[], answer: (q: URLSearchParams) => DocMockResponse) {
    const names = new Set([...allowed, "key", "format"]);
    return (request: DocMockRequest): DocMockResponse => {
      const q = request.url.searchParams;
      if (!data.apiKey || q.get("key") !== data.apiKey) return { status: 401, body: { error: "Invalid API key" } };
      if (limits > 0) {
        limits--;
        return { status: 429, body: { error: "Too many requests" } };
      }
      const unknown = [...q.keys()].find((k) => !names.has(k));
      if (unknown) return { status: 400, body: { error: `unknown parameter ${unknown}` } };
      const format = q.get("format") ?? "xml";
      if (format !== "xml" && format !== "json") return { status: 400, body: { error: "format must be xml or json" } };
      if (format === "xml") return { status: 400, body: { error: "the mock answers only json" } };
      const response = answer(q);
      if (response.status === 200) reads.push({ path: request.url.pathname, query: Object.fromEntries([...q].filter(([k]) => k !== "key")) });
      return response;
    };
  }

  const listed = (w: WatchbaseMockRecord) => {
    const wb = obj(w.wb);
    const family = obj(w.family);
    return { id: wb.id, refnr: w.reference_number, name: w.name, brand: { id: obj(w.brand).id, name: obj(w.brand).name }, family: { id: family.id, name: family.name }, thumb: "https://example.test/thumb.jpg", updated: wb.modified };
  };

  const mock = checkDocMock({
    integration: "watchbase_datafeed",
    baseUrl: BASE,
    source: { url: WATCHBASE_DOC_PAGES.entryPoints, title: "WatchBase Data Feed API manual: API entry points", retrievedOn: "2026-11-11", version: "v1" },
    assumptions: [
      "The API key is 16 to 128 letters, digits, _ or -; the docs give none, and their example key is 40 letters and digits",
      "The JSON answer holds the XML answer's fields as keys, without the response root, and a list as an array of its entries; the docs show only XML",
      "Ids, jewels and released come as JSON numbers, and days as YYYY-MM-DD strings",
      "updated-since lists watches whose modified day is after the day given, not on it",
      "/v1/watches answers every watch of the brand in one answer; the docs give no paging",
      "A wrong or missing key answers 401 with {error}, a bad request 400 with {error}, an unknown watch 404 with {error}, and a rate limit 429; the docs give no error format, status codes or rate limit",
      "Only /v1/watch is charged, 25 credits a watch; the docs don't say whether the lists are",
    ],
    routes: [
      {
        method: "GET",
        path: "/brands",
        documentedAt: WATCHBASE_DOC_PAGES.brands,
        respond: read([], () => ({ status: 200, body: { num_results: brands.length, brands } })),
      },
      {
        method: "GET",
        path: "/watches",
        documentedAt: WATCHBASE_DOC_PAGES.watches,
        respond: read(["brand-id", "family-id", "updated-since"], (q) => {
          const brand = q.get("brand-id");
          if (!brand || !ID.test(brand)) return { status: 400, body: { error: "brand-id is required" } };
          const family = q.get("family-id");
          if (family !== null && !ID.test(family)) return { status: 400, body: { error: "family-id is not valid" } };
          const since = q.get("updated-since");
          if (since !== null && (!DAY.test(since) || Number.isNaN(Date.parse(since)))) return { status: 400, body: { error: "updated-since must be yyyy-mm-dd" } };
          const rows = watches
            .filter((w) => String(obj(w.brand).id) === brand && (family === null || String(obj(w.family).id) === family))
            .filter((w) => since === null || String(obj(w.wb).modified) > since)
            .map(listed);
          return { status: 200, body: { num_results: rows.length, watches: rows } };
        }),
      },
      {
        method: "GET",
        path: "/watch",
        documentedAt: WATCHBASE_DOC_PAGES.watch,
        respond: read(["id"], (q) => {
          const id = q.get("id");
          if (!id || !ID.test(id)) return { status: 400, body: { error: "id is required" } };
          const watch = watches.find((w) => String(obj(w.wb).id) === id);
          if (!watch) return { status: 404, body: { error: "Watch not found" } };
          credits += WATCHBASE_CREDITS_PER_WATCH;
          return { status: 200, body: { watch } };
        }),
      },
    ],
  });
  return {
    mock,
    fetch: docMockFetch(mock),
    get reads() {
      return reads;
    },
    get creditsUsed() {
      return credits;
    },
  };
}

export default {
  integration: "watchbase_datafeed",
  covers: "The WatchBase Data Feed API (v1) brand list, a brand's watch list with updated-since, and one watch's specs, with the key in the query string",
  watchPages: [WATCHBASE_DOC_PAGES.entryPoints, WATCHBASE_DOC_PAGES.brands, WATCHBASE_DOC_PAGES.watches, WATCHBASE_DOC_PAGES.watch],
  docMocks: () => [watchbaseDocMock({ apiKey: "" }).mock],
} satisfies DocMockModule;
