import { describe, expect, it } from "vitest";
import {
  chunkDocument,
  DocumentIndex,
  HashingEmbedder,
  InMemoryDocChunkStore,
  RegistryDocumentationSource,
  type DocChunkStore,
  type EmbeddedDocChunk,
  type Embedder,
  type SearchableDocument,
} from "@karatos/core";
import { PostgresDocChunkStore, type SqlClient } from "../src/index.js";
import { freshDatabase } from "./helpers.js";

const ORG = "example-jewelers";
const OTHER = "other-jewelers";
const AT = "2026-11-28T12:00:00.000Z";
const LATER = "2026-11-29T12:00:00.000Z";

const CORPUS: SearchableDocument[] = [
  {
    id: "docs/integrations/ups.md",
    title: "UPS tracking",
    version: "sha256:aaaaaaaaaaaa",
    source: "docs/integrations/ups.md",
    text: "# UPS tracking\n\nFollows packages on the business's list.\n\n## Settings\n\nSet UPS_CLIENT_ID and UPS_CLIENT_SECRET from a UPS developer app, and UPS_TRACKING_NUMBERS_FILE to the file of tracking numbers.\n\n## Events\n\nshipment.tracked carries the package status.",
  },
  {
    id: "docs/integrations/stripe.md",
    title: "Stripe",
    version: "sha256:bbbbbbbbbbbb",
    source: "docs/integrations/stripe.md",
    text: "# Stripe\n\nReads charges, refunds, disputes and payouts.\n\n## Settings\n\nSet STRIPE_SECRET_KEY to a restricted key with read access.\n\n## Payouts\n\nA payout that hasn't arrived by its expected day is flagged as late.",
  },
  {
    id: "docs/security.md",
    title: "Security",
    version: "sha256:cccccccccccc",
    source: "docs/security.md",
    text: "# Security\n\n## Support access\n\nThe support key reaches only diagnostic routes, never business data.",
  },
];

const QUERIES = ["Where do I put the UPS client secret?", "is a stripe payout late", "support key routes", "refunds and disputes"];

class CountingEmbedder implements Embedder {
  readonly inner = new HashingEmbedder();
  readonly id = this.inner.id;
  readonly dimensions = this.inner.dimensions;
  embedded = 0;
  async embed(texts: readonly string[]) {
    this.embedded += texts.length;
    return this.inner.embed(texts);
  }
}

async function database(pgvector: boolean): Promise<SqlClient> {
  const { client } = await freshDatabase({ pgvector });
  await client.query("insert into organizations (id, name) values ($1, 'Example Jewelers'), ($2, 'Other Jewelers')", [ORG, OTHER]);
  return client;
}

const kinds: [string, boolean][] = [
  ["with pgvector", true],
  ["without pgvector", false],
];

describe("documentation search migration", () => {
  it("turns on pgvector, adds the vector column and the built-in embedder's HNSW index where the extension is available", async () => {
    const client = await database(true);
    const { rows: ext } = await client.query<{ extname: string }>("select extname from pg_extension where extname = 'vector'");
    expect(ext).toEqual([{ extname: "vector" }]);
    const { rows: index } = await client.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'doc_chunks_local_hash_hnsw'");
    expect(index[0]?.indexdef).toMatch(/USING hnsw \(\(\(embedding_vector\)::vector\(1024\)\) vector_cosine_ops\) WHERE \(embedder = 'local-hash-v1'::text\)/);
    expect(await new PostgresDocChunkStore(client).usesPgvector()).toBe(true);
  });

  it("leaves pgvector out where the extension isn't available, keeping the real[] column", async () => {
    const client = await database(false);
    expect((await client.query("select extname from pg_extension where extname = 'vector'")).rows).toEqual([]);
    const { rows } = await client.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'doc_chunks' order by ordinal_position");
    expect(rows.map((r) => r.column_name)).toEqual(["organization_id", "document_id", "ordinal", "heading", "body", "content_hash", "embedder", "dimensions", "embedding", "embedded_at"]);
    expect(await new PostgresDocChunkStore(client).usesPgvector()).toBe(false);
  });

  it("keeps the vector column in step with the real[] one", async () => {
    const client = await database(true);
    const store = new PostgresDocChunkStore(client);
    await new DocumentIndex({ store, organizationId: ORG }).sync([CORPUS[2]!]);
    const { rows } = await client.query<{ same: boolean }>("select embedding_vector = embedding::vector as same from doc_chunks");
    expect(rows).toEqual([{ same: true }]);
  });

  it("checks each passage: it needs a registry row, a hash, text, and the dimensions it says", async () => {
    const client = await database(false);
    const insert = (overrides: Record<string, unknown>) => {
      const row = { org: ORG, doc: "d", ordinal: 0, body: "text", hash: "a".repeat(64), embedder: "local-hash-v1", dimensions: 1024, embedding: Array(1024).fill(0.1), ...overrides };
      return client.query(
        "insert into doc_chunks (organization_id, document_id, ordinal, heading, body, content_hash, embedder, dimensions, embedding, embedded_at) values ($1, $2, $3, '', $4, $5, $6, $7, $8, now())",
        [row.org, row.doc, row.ordinal, row.body, row.hash, row.embedder, row.dimensions, row.embedding],
      );
    };
    await expect(insert({})).rejects.toThrow(/foreign key/);
    await client.query("insert into documentation_registry (organization_id, document_id, title, expected_version) values ($1, 'd', 'D', 'v1')", [ORG]);
    await insert({});
    await expect(insert({ ordinal: -1 })).rejects.toThrow(/check/);
    await expect(insert({ ordinal: 1, body: "" })).rejects.toThrow(/check/);
    await expect(insert({ ordinal: 1, hash: "xyz" })).rejects.toThrow(/check/);
    await expect(insert({ ordinal: 1, dimensions: 1023 })).rejects.toThrow(/check/);
    await expect(insert({ ordinal: 1, embedder: "other", dimensions: 3 })).rejects.toThrow(/check/);
    await insert({ ordinal: 1, embedder: "other", dimensions: 3, embedding: [1, 0, 0] });
    // Dropping the registry row drops its passages.
    await client.query("delete from documentation_registry where document_id = 'd'");
    expect((await client.query("select * from doc_chunks")).rows).toEqual([]);
  });
});

describe.each(kinds)("PostgresDocChunkStore %s", (_name, pgvector) => {
  it("writes each document into the registry and its passages beside it", async () => {
    const client = await database(pgvector);
    const store = new PostgresDocChunkStore(client);
    const index = new DocumentIndex({ store, organizationId: ORG, now: () => new Date(AT) });
    expect(await index.sync(CORPUS)).toMatchObject({ saved: 3, embedded: 7 });
    const { rows } = await client.query<Record<string, unknown>>(
      "select document_id, title, expected_version, current_version, source, last_checked_at, indexed_at from documentation_registry order by document_id",
    );
    expect(rows).toEqual(
      [...CORPUS]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((d) => ({ document_id: d.id, title: d.title, expected_version: d.version, current_version: d.version, source: d.source, last_checked_at: new Date(AT), indexed_at: new Date(AT) })),
    );
    expect(await store.documents(ORG)).toEqual([...CORPUS].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, title, version, source }) => ({ id, title, version, source })));
    const stored = await store.chunks(ORG, CORPUS[0]!.id);
    const expected = chunkDocument(CORPUS[0]!);
    expect(stored.map(({ embedding, ...c }) => c)).toEqual(expected.map((c) => ({ ...c, embedder: "local-hash-v1" })));
    // Kept as real, so each number is within float4 rounding of the embedder's.
    const fresh = await new HashingEmbedder().embed(expected.map((c) => [CORPUS[0]!.title, c.heading, c.text].join("\n")));
    stored.forEach((c, i) => c.embedding.forEach((v, j) => expect(v).toBeCloseTo(fresh[i]![j]!, 6)));
    expect(await store.documents(OTHER)).toEqual([]);
    expect(await store.chunks(OTHER, CORPUS[0]!.id)).toEqual([]);
  });

  it("re-embeds nothing after a restart, and searches what it held before syncing again", async () => {
    const client = await database(pgvector);
    await new DocumentIndex({ store: new PostgresDocChunkStore(client), organizationId: ORG }).sync(CORPUS);
    // A new process: a new store and index over the same database.
    const embedder = new CountingEmbedder();
    const index = new DocumentIndex({ store: new PostgresDocChunkStore(client), organizationId: ORG, embedder });
    const before = await index.search(QUERIES[0]!);
    expect(before[0]?.heading).toBe("UPS tracking > Settings");
    embedder.embedded = 0;
    expect(await index.sync(CORPUS)).toMatchObject({ unchanged: 3, saved: 0, embedded: 0, reused: 7 });
    expect(embedder.embedded).toBe(0);
  });

  it("keeps when an unchanged passage was embedded, rewrites changed ones and drops passages past the new end", async () => {
    const client = await database(pgvector);
    const store = new PostgresDocChunkStore(client);
    await new DocumentIndex({ store, organizationId: ORG, now: () => new Date(AT) }).sync(CORPUS);
    const stripe = CORPUS[1]!;
    const shorter = { ...stripe, version: "sha256:dddddddddddd", text: stripe.text.replace(/\n\n## Payouts[\s\S]*$/, "").replace("read access.", "read access only.") };
    const embedder = new CountingEmbedder();
    expect(await new DocumentIndex({ store, organizationId: ORG, embedder, now: () => new Date(LATER) }).sync([CORPUS[0]!, shorter, CORPUS[2]!])).toMatchObject({ saved: 1, embedded: 1, reused: 5 });
    const { rows } = await client.query<{ ordinal: number; heading: string; embedded_at: Date }>(
      "select ordinal, heading, embedded_at from doc_chunks where document_id = $1 order by ordinal",
      [stripe.id],
    );
    expect(rows).toEqual([
      { ordinal: 0, heading: "Stripe", embedded_at: new Date(AT) },
      { ordinal: 1, heading: "Stripe > Settings", embedded_at: new Date(LATER) },
    ]);
    const { rows: registry } = await client.query("select expected_version, current_version, last_checked_at from documentation_registry where document_id = $1", [stripe.id]);
    // The registry still expects the version first indexed, so drift detection sees the change.
    expect(registry).toEqual([{ expected_version: stripe.version, current_version: shorter.version, last_checked_at: new Date(LATER) }]);
  });

  it("marks a dropped document as missing in the registry, which drift detection reports", async () => {
    const client = await database(pgvector);
    const store = new PostgresDocChunkStore(client);
    const index = new DocumentIndex({ store, organizationId: ORG, now: () => new Date(AT) });
    await index.sync(CORPUS);
    await new DocumentIndex({ store, organizationId: ORG, now: () => new Date(LATER) }).sync(CORPUS.slice(0, 2));
    expect((await client.query("select count(*)::int as n from doc_chunks where document_id = $1", [CORPUS[2]!.id])).rows).toEqual([{ n: 0 }]);
    const { rows } = await client.query("select current_version, indexed_at, last_checked_at from documentation_registry where document_id = $1", [CORPUS[2]!.id]);
    expect(rows).toEqual([{ current_version: null, indexed_at: null, last_checked_at: new Date(LATER) }]);
    expect((await store.documents(ORG)).map((d) => d.id)).toEqual(CORPUS.slice(0, 2).map((d) => d.id).sort());
    const registry = CORPUS.map(({ id, title, version }) => ({ id, title, version }));
    expect(await new RegistryDocumentationSource(registry, () => index.current()).current()).toMatchObject({ stale: true, reason: "Security is missing" });
    // Coming back, it is indexed again.
    expect(await index.sync(CORPUS)).toMatchObject({ saved: 1, embedded: 1 });
    expect((await store.documents(ORG)).map((d) => d.id)).toContain(CORPUS[2]!.id);
  });

  it("leaves a registry row the index never wrote out of what it holds", async () => {
    const client = await database(pgvector);
    await client.query("insert into documentation_registry (organization_id, document_id, title, expected_version) values ($1, 'doc_arch', 'Architecture', 'v1')", [ORG]);
    const store = new PostgresDocChunkStore(client);
    expect(await store.documents(ORG)).toEqual([]);
    expect(await new DocumentIndex({ store, organizationId: ORG }).sync([])).toMatchObject({ removed: 0 });
    expect((await client.query("select document_id from documentation_registry")).rows).toEqual([{ document_id: "doc_arch" }]);
  });

  it("ranks passages as the in-memory store does, with the same scores", async () => {
    const client = await database(pgvector);
    const pg = new DocumentIndex({ store: new PostgresDocChunkStore(client), organizationId: ORG });
    const memory = new DocumentIndex({ store: new InMemoryDocChunkStore(), organizationId: ORG });
    await pg.sync(CORPUS);
    await memory.sync(CORPUS);
    for (const q of QUERIES) {
      const [a, b] = [await pg.search(q, 10), await memory.search(q, 10)];
      expect(a.map((h) => [h.documentId, h.heading]), q).toEqual(b.map((h) => [h.documentId, h.heading]));
      a.forEach((h, i) => expect(Math.abs(h.score - b[i]!.score), q).toBeLessThanOrEqual(0.0002));
      expect(a.length, q).toBeGreaterThan(0);
    }
    expect((await pg.search(QUERIES[0]!, 1))[0]).toEqual({
      documentId: "docs/integrations/ups.md",
      title: "UPS tracking",
      source: "docs/integrations/ups.md",
      version: "sha256:aaaaaaaaaaaa",
      heading: "UPS tracking > Settings",
      text: expect.stringContaining("UPS_CLIENT_SECRET"),
      score: expect.any(Number),
    });
  });

  it("searches only its own organization and embedder, closest first, up to the limit", async () => {
    const client = await database(pgvector);
    const store = new PostgresDocChunkStore(client);
    await new DocumentIndex({ store, organizationId: OTHER }).sync(CORPUS);
    expect(await new DocumentIndex({ store, organizationId: ORG }).search(QUERIES[0]!)).toEqual([]);
    await new DocumentIndex({ store, organizationId: ORG, embedder: new HashingEmbedder(64) }).sync(CORPUS);
    expect(await new DocumentIndex({ store, organizationId: ORG }).search(QUERIES[0]!)).toEqual([]);
    const small = new DocumentIndex({ store, organizationId: ORG, embedder: new HashingEmbedder(64) });
    const hits = await small.search("UPS stripe support settings payouts", 3);
    expect(hits).toHaveLength(3);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
    // Asked directly, a limit below one still returns one.
    const vector = new HashingEmbedder(64).embedOne("ups");
    expect(await store.search(ORG, { embedder: small.embedder.id, vector, limit: 0 })).toHaveLength(1);
  });

  it("scores a passage with no search terms as nothing, and leaves it out", async () => {
    const client = await database(pgvector);
    const store = new PostgresDocChunkStore(client);
    const index = new DocumentIndex({ store, organizationId: ORG });
    await index.sync([{ id: "table", title: "", version: "v1", source: "x", text: "| --- | --- |" }, CORPUS[0]!]);
    const vector = new HashingEmbedder().embedOne("ups");
    const raw = await store.search(ORG, { embedder: index.embedder.id, vector, limit: 10 });
    // pgvector's index holds no all-zero vector, since it has no direction; read without the index it scores NaN.
    const blank = raw.find((h) => h.documentId === "table");
    expect(blank === undefined || blank.score === 0 || Number.isNaN(blank.score)).toBe(true);
    if (!pgvector) expect(blank?.score).toBe(0);
    expect((await index.search("ups", 10)).map((h) => h.documentId)).not.toContain("table");
  });

  it("turns down a query vector it can't use, and passages out of order", async () => {
    const store = new PostgresDocChunkStore(await database(pgvector));
    await expect(store.search(ORG, { embedder: "e", vector: [], limit: 5 })).rejects.toThrow("a query vector needs 1 to 4096 numbers");
    await expect(store.search(ORG, { embedder: "e", vector: Array(4097).fill(1), limit: 5 })).rejects.toThrow(RangeError);
    await expect(store.search(ORG, { embedder: "e", vector: [1, Number.POSITIVE_INFINITY], limit: 5 })).rejects.toThrow("a query vector must hold finite numbers");
    expect(await store.search(ORG, { embedder: "e", vector: Array(4096).fill(1), limit: 5 })).toEqual([]);
    const chunk = (ordinal: number, embedding: number[]): EmbeddedDocChunk => ({ documentId: "d", ordinal, heading: "", text: "t", contentHash: "a".repeat(64), embedder: "e", embedding });
    const doc = { id: "d", title: "D", version: "v1", source: "s" };
    await expect(store.save(ORG, doc, [chunk(1, [1])], AT)).rejects.toThrow("passage 0 of d has ordinal 1");
    await expect(store.save(ORG, doc, [chunk(0, [])], AT)).rejects.toThrow("passage 0 of d has 0 dimensions");
    await expect(store.save(ORG, doc, [chunk(0, Array(4097).fill(0))], AT)).rejects.toThrow("passage 0 of d has 4097 dimensions");
    await store.save(ORG, doc, [chunk(0, Array(4096).fill(0))], AT);
    expect(await store.documents(ORG)).toEqual([doc]);
  });
});

describe("PostgresDocChunkStore with pgvector", () => {
  it("finds the nearest passages through the HNSW index", async () => {
    const client = await database(true);
    const store: DocChunkStore = new PostgresDocChunkStore(client);
    const docs = Array.from({ length: 60 }, (_, i) => ({ id: `doc-${i}`, title: `Doc ${i}`, version: "v1", source: `docs/${i}.md`, text: `# Part ${i}\n\nRing sizing note item${i} for stone setting and casting.` }));
    await new DocumentIndex({ store, organizationId: ORG }).sync(docs);
    expect((await new DocumentIndex({ store, organizationId: ORG }).search("ring sizing note item7", 3))[0]?.documentId).toBe("doc-7");
    // Enough rows that reading them all costs more than the index, as in a real instance's thousands of passages.
    await client.query(
      `insert into doc_chunks (organization_id, document_id, ordinal, heading, body, content_hash, embedder, dimensions, embedding, embedded_at)
       select organization_id, document_id, ordinal + g * 100, heading, body, content_hash, embedder, dimensions, embedding, embedded_at
         from doc_chunks cross join generate_series(1, 40) g`,
    );
    await client.query("analyze doc_chunks");
    // The query the store runs, caught on its way out and explained with plain scans turned off: it must be able to use the index.
    const seen: { text: string; params: unknown[] }[] = [];
    const watching: SqlClient = { query: (text, params) => (seen.push({ text, params: params ?? [] }), client.query(text, params)) };
    await new DocumentIndex({ store: new PostgresDocChunkStore(watching), organizationId: ORG }).search("ring sizing");
    const search = seen.find((q) => q.text.includes("<=>"))!;
    await client.query("set enable_seqscan = off; set enable_bitmapscan = off");
    const { rows } = await client.query<{ "QUERY PLAN": string }>(`explain ${search.text}`, search.params);
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan, plan).toContain("Index Scan using doc_chunks_local_hash_hnsw on doc_chunks");
    await client.query("reset enable_seqscan; reset enable_bitmapscan");
  });
});
