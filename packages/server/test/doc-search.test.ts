import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BrainPipeline, catalogDocuments, DOC_SEARCH_MAX_QUERY_CHARS, DocumentIndex, InMemoryDocChunkStore, InMemoryStore, textVersion, type SearchableDocument } from "@karatos/core";
import { loadMigrations, migrate, PostgresDocChunkStore, type SqlClient } from "@karatos/store-postgres";
import {
  brainRoutes,
  createBrainApp,
  createDocSearch,
  DOCS_LEFT_OUT,
  inMemoryDiagnostics,
  instanceDocuments,
  readAnswer,
  repoDocuments,
  StaticDocumentationSource,
  supportStatus,
  SUPPORT_KEY_REFUSAL,
  type BrainAppOptions,
  type DocSearch,
} from "../src/index.js";

const ORG = "example-jewelers";
const newKey = (prefix: string) => `${prefix}${randomBytes(32).toString("hex")}`;
const INSTANCE_KEY = newKey("i");
const SUPPORT_KEY = newKey("s");
const REPO_DOCS = fileURLToPath(new URL("../../../docs", import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));

const CORPUS: SearchableDocument[] = [
  {
    id: "docs/integrations/ups.md",
    title: "UPS tracking",
    version: "sha256:aaaaaaaaaaaa",
    source: "docs/integrations/ups.md",
    text: "# UPS tracking\n\nFollows packages on the business's list.\n\n## Settings\n\nSet UPS_CLIENT_ID and UPS_CLIENT_SECRET from a UPS developer app, and UPS_TRACKING_NUMBERS_FILE to the file of tracking numbers.",
  },
  {
    id: "docs/integrations/shopify.md",
    title: "Shopify",
    version: "sha256:bbbbbbbbbbbb",
    source: "docs/integrations/shopify.md",
    text: "# Shopify\n\n## Connecting\n\nTo connect Shopify, create a custom app in the Shopify admin and set SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.",
  },
];

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});
async function tempDocs(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docs-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

describe("repoDocuments", () => {
  it("reads every Markdown file, as docs/<path> with its first heading as title and a hash as version", async () => {
    const dir = await tempDocs({
      "ask.md": "Intro.\n\n# Asking questions\n\n## More\n",
      "integrations/ups.md": "### UPS tracking\n\nText.",
      "integrations/deep/note.md": "No heading at all.",
      "notes.txt": "not markdown",
      "research/plan.md": "# Plan",
      "vision/idea.md": "# Idea",
      // Only the top-level folders are left out.
      "integrations/research/kept.md": "# Kept",
    });
    const docs = await repoDocuments(dir);
    expect(docs.map((d) => [d.id, d.title, d.source])).toEqual([
      ["docs/ask.md", "Asking questions", "docs/ask.md"],
      ["docs/integrations/deep/note.md", "docs/integrations/deep/note.md", "docs/integrations/deep/note.md"],
      ["docs/integrations/research/kept.md", "Kept", "docs/integrations/research/kept.md"],
      ["docs/integrations/ups.md", "docs/integrations/ups.md", "docs/integrations/ups.md"],
    ]);
    expect(docs[0]!.text).toBe("Intro.\n\n# Asking questions\n\n## More\n");
    expect(docs[0]!.version).toBe(textVersion(docs[0]!.text));
    expect(DOCS_LEFT_OUT).toEqual(["research", "vision"]);
  });

  it("covers the repository's own docs, and finds the passage a how-to question needs", async () => {
    const docs = await repoDocuments(REPO_DOCS);
    expect(docs.length).toBeGreaterThan(50);
    expect(docs.some((d) => d.id.startsWith("docs/research/") || d.id.startsWith("docs/vision/"))).toBe(false);
    expect(docs.find((d) => d.id === "docs/doc-search.md")?.title).toBe("Documentation search");
    const index = new DocumentIndex({ store: new InMemoryDocChunkStore(), organizationId: ORG });
    await index.sync([...docs, ...catalogDocuments()]);
    const [top] = await index.search("where do I set the UPS tracking numbers file");
    expect(top?.text).toContain("UPS_TRACKING_NUMBERS_FILE");
  });
});

describe("instanceDocuments", () => {
  it("is the repository's docs and the catalog, or the catalog alone when there are no docs", async () => {
    const dir = await tempDocs({ "a.md": "# A\n\nText." });
    const catalog = catalogDocuments();
    expect((await instanceDocuments(dir)).map((d) => d.id)).toEqual(["docs/a.md", ...catalog.map((d) => d.id)]);
    expect(await instanceDocuments(null)).toEqual(catalog);
    expect(await instanceDocuments(join(dir, "missing"))).toEqual(catalog);
    // Anything but a missing folder is a real problem and is raised.
    await expect(instanceDocuments(join(dir, "a.md"))).rejects.toThrow(/ENOTDIR/);
  });
});

describe("createDocSearch", () => {
  const clock = () => {
    let t = Date.parse("2026-11-28T12:00:00Z");
    return () => new Date((t += 1000));
  };

  it("syncs, reports the last sync's times and counts, and searches", async () => {
    const search = createDocSearch({ index: new DocumentIndex({ store: new InMemoryDocChunkStore(), organizationId: ORG }), documents: async () => CORPUS, now: clock() });
    expect(search.status()).toEqual({ embedder: "local-hash-v1", syncing: false, lastSync: null });
    expect(search.embedder).toBe("local-hash-v1");
    const pending = search.sync();
    expect(search.status().syncing).toBe(true);
    const result = await pending;
    expect(result).toMatchObject({ documents: 2, saved: 2, chunks: 3, embedded: 3 });
    expect(search.status()).toEqual({
      embedder: "local-hash-v1",
      syncing: false,
      lastSync: { outcome: "succeeded", startedAt: "2026-11-28T12:00:01.000Z", finishedAt: "2026-11-28T12:00:02.000Z", result, error: null },
    });
    // The status is a copy.
    search.status().lastSync!.result!.documents = 99;
    expect(search.status().lastSync!.result!.documents).toBe(2);
    expect((await search.search("connect Shopify", 1))[0]?.documentId).toBe("docs/integrations/shopify.md");
    expect(await search.search("connect Shopify")).toHaveLength(2);
  });

  it("runs one sync at a time: a call during a sync shares it", async () => {
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const search = createDocSearch({
      index: new DocumentIndex({ store: new InMemoryDocChunkStore(), organizationId: ORG }),
      documents: async () => {
        reads++;
        await gate;
        return CORPUS;
      },
    });
    const a = search.sync();
    const b = search.sync();
    expect(b).toBe(a);
    release();
    await a;
    expect(reads).toBe(1);
    await search.sync();
    expect(reads).toBe(2);
  });

  it("reports a failed sync with its error scrubbed, then recovers", async () => {
    let fail = true;
    const search = createDocSearch({
      index: new DocumentIndex({ store: new InMemoryDocChunkStore(), organizationId: ORG }),
      documents: async () => {
        if (fail) throw new Error("could not read https://example.test/private/path?token=abc");
        return CORPUS;
      },
      now: clock(),
    });
    await expect(search.sync()).rejects.toThrow("could not read");
    expect(search.status()).toEqual({
      embedder: "local-hash-v1",
      syncing: false,
      lastSync: { outcome: "failed", startedAt: "2026-11-28T12:00:01.000Z", finishedAt: "2026-11-28T12:00:02.000Z", result: null, error: "could not read https://example.test/[redacted]" },
    });
    fail = false;
    await search.sync();
    expect(search.status().lastSync).toMatchObject({ outcome: "succeeded", error: null });
  });
});

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function start(docs: BrainAppOptions["docs"] | null) {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({ memory, normalizers: [], extractors: [], reasoners: [], documentation: new StaticDocumentationSource([]) });
  const options: BrainAppOptions = { pipeline, memory, organizationId: ORG, apiKey: INSTANCE_KEY, supportApiKey: SUPPORT_KEY, ...(docs ? { docs } : {}) };
  server = createServer(createBrainApp(options));
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return {
    options,
    call: async (path: string, auth: string | false = INSTANCE_KEY) => {
      const res = await fetch(base + path, auth === false ? {} : { headers: { authorization: `Bearer ${auth}` } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
  };
}

async function synced(): Promise<DocSearch> {
  const search = createDocSearch({ index: new DocumentIndex({ store: new InMemoryDocChunkStore(), organizationId: ORG }), documents: async () => CORPUS });
  await search.sync();
  return search;
}

describe("GET /v1/docs/search", () => {
  it("answers the instance key with the closest passages, each with its source, heading, version and score", async () => {
    const { call } = await start(await synced());
    const res = await call("/v1/docs/search?q=where+is+the+UPS+client+secret+set");
    expect(res.status).toBe(200);
    expect(res.body.query).toBe("where is the UPS client secret set");
    expect(res.body.embedder).toBe("local-hash-v1");
    const results = res.body.results as Record<string, unknown>[];
    expect(results[0]).toEqual({
      documentId: "docs/integrations/ups.md",
      title: "UPS tracking",
      source: "docs/integrations/ups.md",
      version: "sha256:aaaaaaaaaaaa",
      heading: "UPS tracking > Settings",
      text: expect.stringContaining("UPS_CLIENT_SECRET"),
      score: expect.any(Number),
    });
    expect((await call("/v1/docs/search?q=%20%20shopify%20&limit=1")).body).toMatchObject({ query: "shopify", results: [{ documentId: "docs/integrations/shopify.md" }] });
    expect(((await call("/v1/docs/search?q=zebra+xylophone")).body.results as unknown[]).length).toBe(0);
  });

  it("is for the instance key only: no key gets 401 and the support key 403", async () => {
    const { call, options } = await start(await synced());
    expect(await call("/v1/docs/search?q=ups", false)).toEqual({ status: 401, body: { error: "missing or invalid API key" } });
    expect(await call("/v1/docs/search?q=ups", SUPPORT_KEY)).toEqual({ status: 403, body: { error: SUPPORT_KEY_REFUSAL } });
    expect(brainRoutes(options).find((r) => r.pattern.test("/v1/docs/search"))).toMatchObject({ method: "GET", access: "instance" });
  });

  it("checks the query and the limit", async () => {
    const { call } = await start(await synced());
    const bad = async (path: string, error: string) => expect(await call(path), path).toEqual({ status: 400, body: { error } });
    await bad("/v1/docs/search", "search with ?q=, such as ?q=where+is+the+ups+tracking+file+set");
    await bad("/v1/docs/search?q=%20", "q can't be empty");
    await bad(`/v1/docs/search?q=${"a".repeat(DOC_SEARCH_MAX_QUERY_CHARS + 1)}`, `q must be at most ${DOC_SEARCH_MAX_QUERY_CHARS} characters`);
    // Counted in characters, not UTF-16 units: 500 letters outside the basic plane are within the limit.
    expect((await call(`/v1/docs/search?q=${encodeURIComponent("\u{1D49C}".repeat(DOC_SEARCH_MAX_QUERY_CHARS))}`)).status).toBe(200);
    for (const limit of ["0", "21", "-1", "2.5", "x", "", "1000", "1e1"]) await bad(`/v1/docs/search?q=ups&limit=${limit}`, "limit must be a whole number from 1 to 20");
    for (const [limit, n] of [["1", 1], ["20", 3], ["02", 2]] as const) {
      expect(((await call(`/v1/docs/search?q=ups+shopify+client+secret&limit=${limit}`)).body.results as unknown[]).length, limit).toBe(n);
    }
  });

  it("asks the search for five passages unless told otherwise, and for the trimmed query", async () => {
    const asked: [string, number | undefined][] = [];
    const { call } = await start({ embedder: "stub", search: async (q, limit) => (asked.push([q, limit]), []) });
    expect((await call("/v1/docs/search?q=%20ups%20")).body).toEqual({ query: "ups", embedder: "stub", results: [] });
    await call("/v1/docs/search?q=ups&limit=7");
    expect(asked).toEqual([["ups", 5], ["ups", 7]]);
  });

  it("answers 503 when the instance has no documentation search", async () => {
    const { call } = await start(null);
    expect(await call("/v1/docs/search?q=ups")).toEqual({ status: 503, body: { error: "documentation search isn't set up on this instance" } });
  });
});

describe("/v1/ask with documentation search", () => {
  const sources = (docs?: DocSearch) => ({ memory: new InMemoryStore(), organizationId: ORG, timeZone: "America/New_York", now: () => new Date("2026-11-20T15:00:00Z"), ...(docs ? { docs } : {}) });

  it("answers how-do-I and where-is questions with the closest passages, citing each source", async () => {
    const docs = await synced();
    const answer = await readAnswer(sources(docs), "How do I connect Shopify?");
    expect(answer).toMatchObject({ intent: "docs", status: "answered" });
    expect(answer.passages?.[0]).toMatchObject({ documentId: "docs/integrations/shopify.md", heading: "Shopify > Connecting" });
    expect(answer.text.split("\n")[0]).toBe("From the documentation this instance has, closest first:");
    expect(answer.text).toContain("- Shopify > Connecting: To connect Shopify, create a custom app");
    expect(answer.text).toContain("[docs/integrations/shopify.md, sha256:bbbbbbbbbbbb]");
    const where = await readAnswer(sources(docs), "Where is the UPS tracking numbers file set?");
    expect(where.passages?.[0]?.documentId).toBe("docs/integrations/ups.md");
  });

  it("asks the search for at most three passages", async () => {
    const asked: [string, number | undefined][] = [];
    const docs = { search: async (q: string, limit?: number) => (asked.push([q, limit]), []) };
    const answer = await readAnswer(sources(docs as unknown as DocSearch), "how do I turn on support access");
    expect(asked).toEqual([["how do I turn on support access", 3]]);
    expect(answer.status).toBe("no_data");
  });

  it("says when the instance has no documentation search", async () => {
    const answer = await readAnswer(sources(), "How do I connect Shopify?");
    expect(answer).toMatchObject({ intent: "docs", status: "no_data", text: "Documentation search isn't set up on this instance, so I can't look that up." });
  });

  it("reaches the search through GET /v1/ask", async () => {
    const { call } = await start(await synced());
    const res = await call("/v1/ask?q=how+do+i+connect+shopify");
    expect(res.status).toBe(200);
    expect(res.body.answer).toMatchObject({ intent: "docs", status: "answered", passages: [{ documentId: "docs/integrations/shopify.md" }, { documentId: "docs/integrations/ups.md" }] });
  });
});

describe("support status", () => {
  it("reports documentation search's embedder and last sync, or null when not reported", async () => {
    const memory = new InMemoryStore();
    const base = { instanceName: "Example Jewelers", version: "0.1.0", startedAt: new Date("2026-11-28T00:00:00Z"), retentionDays: 30, departments: [], enabledIntegrations: [], diagnostics: inMemoryDiagnostics(memory), now: () => new Date("2026-11-28T12:00:00Z") };
    expect((await supportStatus(ORG, base, [])).docSearch).toBeNull();
    const docs = await synced();
    const status = await supportStatus(ORG, { ...base, docSearch: () => docs.status() }, []);
    expect(status.docSearch).toMatchObject({ embedder: "local-hash-v1", syncing: false, lastSync: { outcome: "succeeded", result: { documents: 2, chunks: 3 } } });
  });
});

describe("documentation search over Postgres, across a restart", () => {
  let db: PGlite;
  let client: SqlClient;
  beforeAll(async () => {
    db = new PGlite();
    client = {
      query: async <T>(text: string, params?: unknown[]) =>
        params?.length ? { rows: (await db.query<T>(text, params)).rows } : { rows: ((await db.exec(text)).at(-1)?.rows ?? []) as T[] },
    };
    await migrate(client, await loadMigrations(MIGRATIONS_DIR));
    await client.query("insert into organizations (id, name) values ($1, 'Example Jewelers')", [ORG]);
  });
  afterAll(() => db.close());

  it("serves what the last run indexed before syncing, and re-embeds nothing that didn't change", async () => {
    const make = () => createDocSearch({ index: new DocumentIndex({ store: new PostgresDocChunkStore(client), organizationId: ORG }), documents: async () => CORPUS });
    expect(await make().sync()).toMatchObject({ saved: 2, embedded: 3 });
    // The instance restarts: a new search over the same database answers at once.
    const after = make();
    const { call } = await start(after);
    const res = await call("/v1/docs/search?q=UPS+client+secret&limit=1");
    expect(res.body.results).toMatchObject([{ documentId: "docs/integrations/ups.md", heading: "UPS tracking > Settings" }]);
    expect(await after.sync()).toMatchObject({ unchanged: 2, saved: 0, embedded: 0, reused: 3 });
  });
});
