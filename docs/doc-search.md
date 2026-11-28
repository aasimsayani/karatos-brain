# Documentation search

An instance can search the documentation it knows by meaning, not only by exact words. Ask `GET /v1/docs/search?q=where is the UPS tracking numbers file set` and it answers with the passages closest to the question, each naming the document it came from, the heading it sits under, the document's version and a score. `/v1/ask` uses the same search for "how do I" and "where is" questions (see [asking the instance](ask.md)).

Search is read-only and runs inside the instance. It calls no outside service and needs no key.

## What it searches

Documentation search builds on the [documentation registry](architecture/overview.md): every document it indexes is a row in `documentation_registry`, with its title, where it came from and the version that was read.

| Documents | Id | Source | Version |
| --- | --- | --- | --- |
| The repository's docs, shipped in the instance image under `docs/`. `docs/research/` and `docs/vision/` are plans and research, so they are left out | `docs/<path>`, such as `docs/integrations/ups.md` | The same path | `sha256:` and the first 12 hex digits of the file's SHA-256 |
| One document for each integration in the catalog: what it is, what its connector does, the settings it needs, and where the vendor publishes API changes. It is built from the code, so every instance has it, even with no docs folder | `catalog/<integration id>`, such as `catalog/shopify` | `catalog:<integration id>` | The same kind of hash, of the document's text |

The instance reads the docs from `DOCS_DIR`, or the image's own `docs/` folder when that isn't set. A missing folder isn't an error: the catalog documents are still indexed.

## How it works

1. **Passages.** Each document is cut into passages under its headings. A passage never spans two headings, keeps paragraphs whole where they fit, and is at most 800 characters. A paragraph that is too long is split by lines, then sentences, then words. A code fence stays in one paragraph, and a `#` line inside it isn't read as a heading. Each passage records its heading path, such as `UPS tracking > Settings`.
2. **Vectors.** Each passage's title, heading and text are turned into a vector by an embedder. The built-in one, `local-hash-v1`, needs no model, service or key: it lowercases the words, drops common words such as "the" and "how", trims each word to a rough stem, and hashes each word, and each pair of neighbouring words at half weight, into one of 1,024 positions. Passages that share words with a question point the same way as it. It doesn't know synonyms.
3. **Only what changed.** A passage is identified by the SHA-256 of what is embedded. When the instance starts, it reads every document again. A passage whose hash it already holds for that document keeps its stored vector. Only new or changed passages are embedded, and a document whose passages, title, version and source are all the same isn't written at all. A document no longer found is dropped from the index, and its registry row keeps no current version, which drift detection reads as missing.
4. **Search.** The question is embedded the same way, and the passages with the highest cosine similarity come back first. A passage that appears word for word in two documents, such as a connector's page and the generated list of connectors in `docs/integrations.md`, is shown once. Passages scoring under 0.05 share no meaningful words with the question and are left out, so a question about something the docs don't cover gets no results, not unrelated ones.

The index lives in Postgres and survives a restart: search answers from what the last run indexed straight away, while the startup sync runs.

## Postgres and pgvector

Migration `20261128000002_doc_search.sql` adds `doc_chunks`, one row per passage, beside the registry. Each vector is always kept as `real[]`, which any Postgres can store.

Where the [pgvector](https://github.com/pgvector/pgvector) extension is available, as on Supabase, the migration turns it on, keeps each vector in a pgvector column too, and builds an HNSW index for the built-in embedder, so the nearest passages are found without reading them all. Where it isn't, as on a plain Postgres without the extension, the migration leaves it out and search works out cosine similarity in SQL over the `real[]` vectors. The store checks which it has when it first searches. Both ways give the same ranking; the tests run both, on PGlite with and without its pgvector extension, and check that the query the store runs can use the HNSW index.

## API

`GET /v1/docs/search?q=<query>&limit=<n>` needs the instance API key. The support key gets 403, since its routes are limited to diagnostics.

| Parameter | |
| --- | --- |
| `q` | Required. The question or words to search for, at most 500 characters |
| `limit` | Optional. How many passages to return, 1 to 20; 5 when not given |

For `?q=how do I connect Shopify&limit=1`, the answer looks like this (the version and score depend on the docs in the image):

```json
{
  "query": "how do I connect Shopify",
  "embedder": "local-hash-v1",
  "results": [
    {
      "documentId": "catalog/shopify",
      "title": "Shopify",
      "source": "catalog:shopify",
      "version": "sha256:0c4f7d2a91be",
      "heading": "Shopify",
      "text": "Settings, kept in the instance's secrets: SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET. …",
      "score": 0.3564
    }
  ]
}
```

A missing or empty `q`, one over 500 characters, or a `limit` that isn't a whole number from 1 to 20 gets 400. An instance without documentation search answers 503.

`GET /v1/support/status` reports `docSearch`: the embedder, whether a sync is running, and the last sync's times, outcome and counts (documents, passages, how many were embedded and how many kept their vectors), with any error scrubbed like other support errors.

## Adding a hosted embedder

The built-in embedder is a starting point. A hosted model would find passages that answer a question in other words. To add one, implement `Embedder` from `@karatos/core` (an `id`, its `dimensions`, and `embed(texts)`), pass it to `DocumentIndex`, and add a migration with an HNSW index for its id and dimension count, like the one for `local-hash-v1`. Vectors are stored and searched under the embedder's id, so switching embeds every passage once and never compares vectors from two models. A hosted embedder sends the docs' text to its service, so it needs its key in the secrets manifest and a note in [security](security.md). None is built yet.
