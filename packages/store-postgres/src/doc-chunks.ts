import type { DocChunkStore, DocSearchHit, DocSearchQuery, EmbeddedDocChunk, IndexedDocument } from "@karatos/core";
import type { SqlClient } from "./client.js";

interface ChunkRow {
  document_id: string;
  ordinal: number;
  heading: string;
  body: string;
  content_hash: string;
  embedder: string;
  embedding: number[];
}

interface HitRow {
  document_id: string;
  title: string;
  source: string;
  version: string;
  heading: string;
  body: string;
  score: number | string | null;
}

/** The most dimensions a vector may have; pgvector's HNSW index takes up to 2,000, the column more. */
const MAX_DIMENSIONS = 4096;

/**
 * Documentation passages and their vectors in Postgres, on top of the
 * documentation registry: each indexed document is a registry row (with its
 * source and the version read), and its passages are rows of doc_chunks.
 * Search uses pgvector's index where the database has the extension, and
 * otherwise works out cosine similarity over the stored real[] vectors.
 */
export class PostgresDocChunkStore implements DocChunkStore {
  private vectorColumn: Promise<boolean> | undefined;

  constructor(private readonly db: SqlClient) {}

  /** True when the migration found pgvector and added the indexed vector column. */
  usesPgvector(): Promise<boolean> {
    this.vectorColumn ??= this.db
      .query<{ found: boolean }>(
        `select exists (select 1 from information_schema.columns
          where table_schema = current_schema() and table_name = 'doc_chunks' and column_name = 'embedding_vector') as found`,
      )
      .then(({ rows }) => rows[0]?.found === true);
    return this.vectorColumn;
  }

  async documents(organizationId: string): Promise<IndexedDocument[]> {
    const { rows } = await this.db.query<{ document_id: string; title: string; current_version: string; source: string }>(
      `select document_id, title, current_version, source from documentation_registry
        where organization_id = $1 and indexed_at is not null
        order by document_id`,
      [organizationId],
    );
    return rows.map((r) => ({ id: r.document_id, title: r.title, version: r.current_version, source: r.source }));
  }

  async chunks(organizationId: string, documentId: string): Promise<EmbeddedDocChunk[]> {
    const { rows } = await this.db.query<ChunkRow>(
      `select document_id, ordinal, heading, body, content_hash, embedder, embedding from doc_chunks
        where organization_id = $1 and document_id = $2
        order by ordinal`,
      [organizationId, documentId],
    );
    return rows.map((r) => ({
      documentId: r.document_id,
      ordinal: r.ordinal,
      heading: r.heading,
      text: r.body,
      contentHash: r.content_hash,
      embedder: r.embedder,
      embedding: r.embedding.map(Number),
    }));
  }

  /**
   * One statement, so a document and its passages change together: the
   * registry row is written, each passage is written over the one at its
   * ordinal (keeping when it was embedded if its hash and embedder are the
   * same), and passages past the new end are dropped.
   */
  async save(organizationId: string, document: IndexedDocument, chunks: readonly EmbeddedDocChunk[], at: string): Promise<void> {
    const rows = chunks.map((c, i) => {
      if (c.ordinal !== i) throw new Error(`passage ${i} of ${document.id} has ordinal ${c.ordinal}`);
      if (c.embedding.length < 1 || c.embedding.length > MAX_DIMENSIONS) throw new Error(`passage ${i} of ${document.id} has ${c.embedding.length} dimensions`);
      return { ordinal: c.ordinal, heading: c.heading, body: c.text, content_hash: c.contentHash, embedder: c.embedder, dimensions: c.embedding.length, embedding: c.embedding };
    });
    await this.db.query(
      `with registered as (
         insert into documentation_registry (organization_id, document_id, title, expected_version, current_version, source, last_checked_at, indexed_at)
         values ($1, $2, $3, $4, $4, $5, $6, $6)
         on conflict (organization_id, document_id) do update
           set title = excluded.title, current_version = excluded.current_version, source = excluded.source,
               last_checked_at = excluded.last_checked_at, indexed_at = excluded.indexed_at
         returning document_id
       ), written as (
         insert into doc_chunks (organization_id, document_id, ordinal, heading, body, content_hash, embedder, dimensions, embedding, embedded_at)
         select $1, $2, x.ordinal, x.heading, x.body, x.content_hash, x.embedder, x.dimensions, x.embedding, $6
           from jsonb_to_recordset($7::jsonb) as x(ordinal integer, heading text, body text, content_hash text, embedder text, dimensions integer, embedding real[])
         on conflict (organization_id, document_id, ordinal) do update
           set heading = excluded.heading, body = excluded.body, content_hash = excluded.content_hash, embedder = excluded.embedder,
               dimensions = excluded.dimensions, embedding = excluded.embedding,
               embedded_at = case when doc_chunks.content_hash = excluded.content_hash and doc_chunks.embedder = excluded.embedder
                                  then doc_chunks.embedded_at else excluded.embedded_at end
         returning ordinal
       ), trimmed as (
         delete from doc_chunks where organization_id = $1 and document_id = $2 and ordinal >= $8
         returning ordinal
       )
       select (select count(*) from registered) as registered, (select count(*) from written) as written, (select count(*) from trimmed) as trimmed`,
      [organizationId, document.id, document.title, document.version, document.source, at, JSON.stringify(rows), rows.length],
    );
  }

  /** Drops the passages and marks the registry row as no longer held, so drift detection sees the document missing. */
  async remove(organizationId: string, documentId: string, at: string): Promise<void> {
    await this.db.query(
      `with gone as (delete from doc_chunks where organization_id = $1 and document_id = $2 returning ordinal)
       update documentation_registry set current_version = null, indexed_at = null, last_checked_at = $3
        where organization_id = $1 and document_id = $2`,
      [organizationId, documentId, at],
    );
  }

  async search(organizationId: string, query: DocSearchQuery): Promise<DocSearchHit[]> {
    const dims = query.vector.length;
    if (!Number.isInteger(dims) || dims < 1 || dims > MAX_DIMENSIONS) throw new RangeError(`a query vector needs 1 to ${MAX_DIMENSIONS} numbers`);
    if (!query.vector.every(Number.isFinite)) throw new RangeError("a query vector must hold finite numbers");
    const limit = Math.max(1, Math.trunc(query.limit));
    // dims is a checked whole number, so it can sit in the SQL: an HNSW index is built on a cast to one dimension count.
    const sql = (await this.usesPgvector())
      ? // The nearest passages first, alone, so the HNSW index can supply them in order; then their documents.
        `select n.document_id, r.title, r.source, r.current_version as version, n.heading, n.body, 1 - n.distance as score
           from (
             select c.organization_id, c.document_id, c.ordinal, c.heading, c.body,
                    c.embedding_vector::vector(${dims}) <=> $3::vector(${dims}) as distance
               from doc_chunks c
              where c.organization_id = $1 and c.embedder = $2 and c.dimensions = ${dims}
              order by c.embedding_vector::vector(${dims}) <=> $3::vector(${dims})
              limit $4
           ) n
           join documentation_registry r on r.organization_id = n.organization_id and r.document_id = n.document_id
          order by n.distance, n.document_id, n.ordinal`
      : `select c.document_id, r.title, r.source, r.current_version as version, c.heading, c.body,
                s.dot / nullif(sqrt(s.aa) * sqrt(s.bb), 0) as score
           from doc_chunks c
           join documentation_registry r on r.organization_id = c.organization_id and r.document_id = c.document_id
           cross join lateral (
             select sum(a::float8 * b::float8) as dot, sum(a::float8 * a::float8) as aa, sum(b::float8 * b::float8) as bb
               from unnest(c.embedding, $3::real[]) as t(a, b)
           ) s
          where c.organization_id = $1 and c.embedder = $2 and c.dimensions = ${dims}
          order by score desc nulls last, c.document_id, c.ordinal
          limit $4`;
    const vector = (await this.usesPgvector()) ? JSON.stringify(query.vector) : [...query.vector];
    const { rows } = await this.db.query<HitRow>(sql, [organizationId, query.embedder, vector, limit]);
    return rows.map((r) => ({
      documentId: r.document_id,
      title: r.title,
      source: r.source,
      version: r.version,
      heading: r.heading,
      text: r.body,
      score: r.score === null ? 0 : Number(r.score),
    }));
  }
}
