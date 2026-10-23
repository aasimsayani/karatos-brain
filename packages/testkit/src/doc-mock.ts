import { INTEGRATIONS, type VendorDocsTarget } from "@karatos/core";

/**
 * Mocks built from a vendor's published API docs, for systems we can't reach
 * yet (paid accounts, partner programs). A connector is written and tested
 * against the mock now and verified live once access arrives.
 *
 * Every mock names the doc pages it was built from and the day they were
 * read, so the vendor docs watch can flag when a page changes and the mock
 * may have drifted from the real API.
 */

/** Where a mock's behavior comes from. */
export interface DocSource {
  /** The doc page the mock was built from. */
  url: string;
  title: string;
  /** The day the page was read, as YYYY-MM-DD. */
  retrievedOn: string;
  /** The API version the docs describe, when they state one. */
  version?: string;
}

export interface DocMockRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export interface DocMockResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface DocRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path as documented, e.g. `/api/v2/invoice`. `{name}` matches one path segment. */
  path: string;
  /** The doc page for this endpoint. */
  documentedAt: string;
  respond(request: DocMockRequest, params: Record<string, string>): DocMockResponse;
}

export interface DocMock {
  /** Catalog id of the integration the mock stands in for. */
  integration: string;
  /** Base URL the documented paths hang off. */
  baseUrl: string;
  source: DocSource;
  /** How the docs say requests authenticate. The mock answers 401 without it. */
  auth?: "basic" | "bearer";
  routes: DocRoute[];
  /**
   * What the mock does that the docs don't spell out. Each one is checked
   * against the real API on the first live run and then removed or fixed.
   */
  assumptions: string[];
}

/**
 * What a mock module in `src/mocks/<id>.ts` registers as its default export.
 * `npm run registry:write` collects them into `allDocMocks()` and the mock
 * list in docs/integrations.md, so adding a mock touches only its own file.
 */
export interface DocMockModule {
  /** Catalog id of the integration the mocks stand in for. */
  integration: string;
  /** What the mocks cover, as one line of the docs' mock list, e.g. "Stuller's invoice endpoints (API v2)". */
  covers: string;
  /**
   * Every doc page the mocks were built from, in the order the docs watch
   * lists them. A test checks this matches the mocks, so a page added to a
   * route is never left out of the watch by mistake.
   */
  watchPages: string[];
  /** The module's mocks with empty data, for checks and the vendor docs watch. */
  docMocks: () => DocMock[];
}

export class UndocumentedRequestError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
  ) {
    super(`${method} ${url} is not in the vendor's docs this mock was built from`);
    this.name = "UndocumentedRequestError";
  }
}

export class DocMockDefinitionError extends Error {
  constructor(readonly integration: string, readonly problems: string[]) {
    super(`doc mock for ${integration} is incomplete: ${problems.join("; ")}`);
    this.name = "DocMockDefinitionError";
  }
}

const isHttps = (url: string) => {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};

/** Checks a mock says where it came from and that its routes are unambiguous. */
export function checkDocMock(mock: DocMock): DocMock {
  const problems: string[] = [];
  if (!/^[a-z][a-z0-9_]*$/.test(mock.integration)) problems.push("integration must be a catalog id");
  if (!isHttps(mock.baseUrl)) problems.push("baseUrl must be https");
  if (!isHttps(mock.source.url)) problems.push("source.url must be https");
  if (!mock.source.title.trim()) problems.push("source.title is empty");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(mock.source.retrievedOn) ? new Date(`${mock.source.retrievedOn}T00:00:00Z`) : null;
  if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== mock.source.retrievedOn) {
    problems.push("source.retrievedOn must be a YYYY-MM-DD date");
  }
  if (mock.routes.length === 0) problems.push("no routes");
  const seen = new Set<string>();
  for (const route of mock.routes) {
    const key = `${route.method} ${route.path.toLowerCase()}`;
    if (seen.has(key)) problems.push(`${key} is defined twice`);
    seen.add(key);
    if (!route.path.startsWith("/")) problems.push(`${key} must start with /`);
    if (!isHttps(route.documentedAt)) problems.push(`${key} needs an https documentedAt page`);
  }
  if (problems.length) throw new DocMockDefinitionError(mock.integration, problems);
  return mock;
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = got[i]!;
    const param = /^\{(\w+)\}$/.exec(w);
    if (param) {
      if (!g) return null;
      params[param[1]!] = decodeURIComponent(g);
    } else if (w.toLowerCase() !== g.toLowerCase()) {
      return null;
    }
  }
  return params;
}

export interface DocMockFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Every request answered, in order, without headers so credentials aren't kept. */
  readonly calls: { method: string; url: string }[];
}

/**
 * A fetch that answers from the mock. Requests to other hosts, or to paths
 * and methods the docs don't list, throw `UndocumentedRequestError` so a
 * connector can't quietly depend on behavior nobody has seen documented.
 */
export function docMockFetch(mock: DocMock): DocMockFetch {
  checkDocMock(mock);
  const base = new URL(mock.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const calls: { method: string; url: string }[] = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (url.origin !== base.origin || !url.pathname.startsWith(basePath)) throw new UndocumentedRequestError(method, url.toString());
    const path = url.pathname.slice(basePath.length) || "/";
    let found: { route: DocRoute; params: Record<string, string> } | undefined;
    for (const route of mock.routes) {
      const params = route.method === method ? matchPath(route.path, path) : null;
      if (params) {
        found = { route, params };
        break;
      }
    }
    if (!found) throw new UndocumentedRequestError(method, url.toString());
    calls.push({ method, url: url.toString() });

    const authorization = request.headers.get("authorization") ?? "";
    if (mock.auth === "basic" && !/^Basic [A-Za-z0-9+/]+=*$/.test(authorization)) return json(401, { Message: "Authorization has been denied for this request." });
    if (mock.auth === "bearer" && !/^Bearer \S+$/.test(authorization)) return json(401, { error: "unauthorized" });

    const body = method === "GET" || method === "HEAD" ? "" : await request.text();
    const response = found.route.respond({ method, url, headers: request.headers, body }, found.params);
    return json(response.status, response.body, response.headers);
  };
  return Object.assign(fetch, { calls });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** One page for the vendor docs watch to check. */
export interface DocWatchTarget {
  /** Stable id: the integration and a slug of the page path. */
  id: string;
  integration: string;
  url: string;
  /** The day the mock last matched this page. */
  retrievedOn: string;
}

/**
 * Every doc page the mocks were built from, de-duplicated, for the vendor
 * docs watch. When one of these pages changes, the mock may be out of date.
 */
export function docMockWatchTargets(mocks: readonly DocMock[]): DocWatchTarget[] {
  const targets = new Map<string, DocWatchTarget>();
  for (const mock of mocks) {
    for (const url of [mock.source.url, ...mock.routes.map((r) => r.documentedAt)]) {
      if (targets.has(url)) continue;
      const parsed = new URL(url);
      const slug = `${parsed.hostname}${parsed.pathname}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      targets.set(url, { id: `${mock.integration}:${slug}`, integration: mock.integration, url, retrievedOn: mock.source.retrievedOn });
    }
  }
  return [...targets.values()];
}

/**
 * The mocks' doc pages as vendor docs watch targets. Each page is keyed
 * `integration:page`, so it gets its own snapshot and issue, apart from the
 * vendor's changelog.
 */
export function docMockVendorDocsTargets(mocks: readonly DocMock[]): VendorDocsTarget[] {
  const names = new Map(INTEGRATIONS.map((spec) => [spec.id, spec.name]));
  return docMockWatchTargets(mocks).map((target) => ({
    integration: target.id,
    name: names.get(target.integration) ?? target.integration,
    url: target.url,
    mock: { integration: target.integration, retrievedOn: target.retrievedOn },
  }));
}
