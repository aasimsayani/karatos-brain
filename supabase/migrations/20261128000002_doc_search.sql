-- Documentation search: each document in the registry, cut into passages
-- under its headings, with a vector for each passage so a question can be
-- matched by meaning. A passage keeps its vector until its text changes.
--
-- Vectors are always kept as real[], which any Postgres can store. Where the
-- pgvector extension is available (Supabase has it), it is turned on and each
-- vector is also kept as a pgvector column with an HNSW index for the
-- built-in embedder, so the nearest passages are found without reading them
-- all. Where it isn't (plain Postgres without the extension), search reads
-- the real[] column instead; the store checks which it has.

-- The registry learns where each document came from and when the index last
-- saved it. A document the index dropped keeps its row with no current version,
-- which drift detection reads as missing.
alter table documentation_registry add column if not exists source text;
alter table documentation_registry add column if not exists indexed_at timestamptz;

create table if not exists doc_chunks (
  organization_id  text not null,
  document_id      text not null,
  ordinal          integer not null check (ordinal >= 0),
  heading          text not null,
  body             text not null check (length(body) > 0),
  content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  embedder         text not null check (length(embedder) between 1 and 200),
  dimensions       integer not null check (dimensions between 1 and 4096),
  embedding        real[] not null check (cardinality(embedding) = dimensions and array_ndims(embedding) = 1),
  embedded_at      timestamptz not null,
  primary key (organization_id, document_id, ordinal),
  foreign key (organization_id, document_id) references documentation_registry (organization_id, document_id) on delete cascade,
  -- The built-in embedder's index below casts to 1024 dimensions.
  check (embedder <> 'local-hash-v1' or dimensions = 1024)
);

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'vector') then
    create extension if not exists vector;
    alter table doc_chunks add column if not exists embedding_vector vector generated always as (embedding::vector) stored;
    -- One index per embedder, since an HNSW index needs one dimension count. A hosted embedder adds its own.
    create index if not exists doc_chunks_local_hash_hnsw on doc_chunks
      using hnsw ((embedding_vector::vector(1024)) vector_cosine_ops)
      where embedder = 'local-hash-v1';
  end if;
end
$$;

alter table doc_chunks enable row level security;
drop policy if exists tenant_isolation on doc_chunks;
create policy tenant_isolation on doc_chunks
  using (organization_id = current_organization_id())
  with check (organization_id = current_organization_id());
