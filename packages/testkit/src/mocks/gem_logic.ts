import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Gem Logic's API, built from its API documentation page. Data is synthetic.
 * Gem Logic offers a free trial; until a trial instance is set up, this mock
 * stands in, and a trial run confirms it.
 *
 * Docs facts the mock relies on:
 * - Each business is at https://{instance}.gem-logic.com/api/, and a request
 *   sends its API key in the x-api-key header; a missing or bad key is 401.
 * - GET /api/marketplaces/ lists sales channels with id and marketplace.
 * - GET /api/products/{marketplace_id} lists a channel's products with id,
 *   item_sku, created, status, images (id, image), item_weight,
 *   item_height, item_length and item_width.
 * - A successful GET is 200; a resource not found is 404.
 */
const DOCS = {
  api: "https://www.gem-logic.com/documentation/applications/general/api.html",
} as const;
export const GEM_LOGIC_DOC_PAGES = DOCS;

export type GemLogicMockRecord = Record<string, unknown>;

export interface GemLogicMockData {
  apiKey: string;
  marketplaces?: GemLogicMockRecord[];
  /** Each channel's products, by channel ID. */
  products?: Record<string, GemLogicMockRecord[]>;
  /** Answer pages of this many under results, with next, instead of one plain list. */
  pageSize?: number;
  /** 429s to answer before the next reads. */
  rateLimits?: number;
}

/** A ring listed `n` days into 2026. */
export const gemLogicProduct = fixtureBuilder<GemLogicMockRecord>((n) => ({
  id: n,
  item_sku: `RING-${1000 + n}`,
  created: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString(),
  status: "active",
  images: [{ id: n, image: `https://example.test/media/ring-${n}.jpg` }],
  item_weight: 3.25,
  item_height: 2,
  item_length: 21,
  item_width: 21,
}));

const error = (status: number, detail: string): DocMockResponse => ({ status, body: { detail } });

export interface GemLogicMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Each list read: its path and query. */
  readonly reads: { path: string; query: Record<string, string> }[];
}

export function gemLogicDocMock(data: GemLogicMockData): GemLogicMock {
  const reads: { path: string; query: Record<string, string> }[] = [];
  let limits = data.rateLimits ?? 0;
  /** Checks the key and the limit, then answers the rows as one list or a page of them. */
  const answer = (request: { headers: Headers; url: URL }, rows: GemLogicMockRecord[]): DocMockResponse => {
    if (request.headers.get("x-api-key") !== data.apiKey || data.apiKey === "") return error(401, "Invalid API key.");
    if (limits > 0) {
      limits--;
      return { status: 429, body: { detail: "Request was throttled." }, headers: { "retry-after": "1" } };
    }
    const query = Object.fromEntries(request.url.searchParams);
    reads.push({ path: request.url.pathname, query });
    if (!data.pageSize) return { status: 200, body: rows };
    const page = query.page === undefined ? 1 : Number(query.page);
    if (!Number.isInteger(page) || page < 1) return error(404, "Invalid page.");
    const next = page * data.pageSize < rows.length ? `${request.url.origin}${request.url.pathname}?page=${page + 1}` : null;
    return { status: 200, body: { count: rows.length, next, previous: page > 1 ? `${request.url.origin}${request.url.pathname}?page=${page - 1}` : null, results: rows.slice((page - 1) * data.pageSize, page * data.pageSize) } };
  };
  const api = checkDocMock({
    integration: "gem_logic",
    baseUrl: "https://example.gem-logic.com",
    source: { url: DOCS.api, title: "Gem Logic API", retrievedOn: "2026-11-11" },
    assumptions: [
      "Lists answer as a plain JSON list; a paged list answers count, next, previous and results, and takes page",
      "Products come in a stable order, oldest ID first",
      "A key Gem Logic doesn't take, or a deactivated one, is answered 401",
      "Over a limit is answered 429 with Retry-After",
    ],
    routes: [
      {
        method: "GET",
        path: "/api/marketplaces/",
        documentedAt: DOCS.api,
        respond: (request) => answer(request, data.marketplaces ?? []),
      },
      {
        method: "GET",
        path: "/api/products/{marketplace_id}",
        documentedAt: DOCS.api,
        respond(request, params) {
          const rows = data.products?.[params.marketplace_id!];
          if (!rows && (data.marketplaces ?? []).every((m) => String(m.id) !== params.marketplace_id)) return error(404, "Not found.");
          return answer(request, [...(rows ?? [])].sort((x, y) => Number(x.id) - Number(y.id)));
        },
      },
    ],
  });
  return {
    api,
    fetch: docMockFetch(api),
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "gem_logic",
  covers: "Gem Logic's sales channel and product lists",
  watchPages: [DOCS.api],
  docMocks: () => [gemLogicDocMock({ apiKey: "" }).api],
} satisfies DocMockModule;
