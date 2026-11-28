import type { RegisteredDocument } from "./documentation.js";
import { INTEGRATIONS, type IntegrationSpec } from "./integrations.js";
import { sha256Hex } from "./vendor-docs.js";

/**
 * Searching the documentation an instance knows by meaning rather than by
 * exact words. Each document in the registry is cut into passages under its
 * headings, each passage is turned into a vector by an Embedder, and a
 * question is answered with the passages whose vectors are closest to its
 * own. A passage is embedded again only when its text changed.
 *
 * The built-in embedder (HashingEmbedder) runs in process with no outside
 * service and no key, so search works out of the box and in tests. A hosted
 * embedder can take its place later by implementing Embedder; its vectors are
 * stored under its own id, so switching re-embeds every passage once.
 */

/** A document in the registry, with the text to search. */
export interface SearchableDocument extends RegisteredDocument {
  /** Where the text came from: a path in the repository or a URL. */
  source: string;
  /** The document's text, as Markdown or plain text. */
  text: string;
}

/** One passage of a document. */
export interface DocChunk {
  documentId: string;
  /** Position in the document, from 0. */
  ordinal: number;
  /** The headings above the passage, outermost first, joined with " > ". Empty before the first heading. */
  heading: string;
  text: string;
  /** SHA-256 of what is embedded (title, heading and text), in hex. The same hash means the same vector. */
  contentHash: string;
}

/** Turns text into vectors. Every vector it returns has `dimensions` numbers. */
export interface Embedder {
  /** Names the model and its settings. Vectors from different ids are never compared. */
  readonly id: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** The longest passage, in characters, unless the caller says otherwise. */
export const DOC_CHUNK_MAX_CHARS = 800;
/** The most passages one search returns. */
export const DOC_SEARCH_MAX_RESULTS = 20;
/** The longest query taken, in characters. */
export const DOC_SEARCH_MAX_QUERY_CHARS = 500;
/** Passages less similar than this to the query are not returned: they share no meaningful words with it. */
export const DOC_SEARCH_MIN_SCORE = 0.05;

// ---------------------------------------------------------------------------
// Cutting documents into passages

const HEADING = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** The text that is embedded for a passage, and hashed to tell whether it changed. */
export const chunkEmbeddingText = (title: string, heading: string, text: string) => [title, heading, text].filter(Boolean).join("\n");

/** Splits one block that is too long: by lines, then sentences, then words, then characters. */
function splitLong(block: string, max: number): string[] {
  if (block.length <= max) return [block];
  const lines = block.split("\n");
  if (lines.length > 1) return pack(lines.flatMap((l) => splitLong(l, max)), max, "\n");
  const sentences = block.split(/(?<=[.!?])\s+/);
  if (sentences.length > 1) return pack(sentences.flatMap((s) => splitLong(s, max)), max, " ");
  const words = block.split(/\s+/);
  if (words.length > 1) return pack(words.flatMap((w) => splitLong(w, max)), max, " ");
  const out: string[] = [];
  for (let i = 0; i < block.length; i += max) out.push(block.slice(i, i + max));
  return out;
}

/** Joins pieces in order into runs of at most `max` characters. */
function pack(pieces: readonly string[], max: number, joiner: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (!piece) continue;
    if (!current) current = piece;
    else if (current.length + joiner.length + piece.length <= max) current += joiner + piece;
    else {
      out.push(current);
      current = piece;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Cuts a document into passages of at most `maxChars` characters, one
 * section (the text under a heading) at a time, so a passage never spans two
 * headings. Paragraphs are kept whole where they fit; a code fence is one
 * paragraph, and a `#` line inside it is not a heading. Sections with no text
 * of their own give no passage.
 */
export function chunkDocument(doc: SearchableDocument, maxChars: number = DOC_CHUNK_MAX_CHARS): DocChunk[] {
  if (!Number.isInteger(maxChars) || maxChars < 50) throw new RangeError("maxChars must be a whole number of at least 50");
  const sections: { heading: string; blocks: string[] }[] = [];
  const headings: string[] = [];
  let section = { heading: "", blocks: [] as string[] };
  let block: string[] = [];
  let fence: string | null = null;
  const endBlock = () => {
    const text = block.join("\n").trim();
    if (text) section.blocks.push(text);
    block = [];
  };

  for (const line of doc.text.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      block.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
        fence = null;
        endBlock();
      }
      continue;
    }
    if (marker) {
      endBlock();
      fence = marker;
      block.push(line);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endBlock();
      sections.push(section);
      headings.length = heading[1]!.length - 1;
      headings[heading[1]!.length - 1] = heading[2]!.trim();
      section = { heading: headings.filter(Boolean).join(" > "), blocks: [] };
      continue;
    }
    if (line.trim() === "") endBlock();
    else block.push(line);
  }
  endBlock();
  sections.push(section);

  const chunks: DocChunk[] = [];
  for (const { heading, blocks } of sections) {
    for (const text of pack(blocks.flatMap((b) => splitLong(b, maxChars)), maxChars, "\n\n")) {
      chunks.push({ documentId: doc.id, ordinal: chunks.length, heading, text, contentHash: sha256Hex(chunkEmbeddingText(doc.title, heading, text)) });
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// The built-in embedder

const STOPWORDS = new Set(
  "a an and are as at be been but by can could did do does doing for from had has have how i if in into is it its me my no not of on or our so than that the their them then there these they this to us was we were what when where which while who why will with would you your".split(" "),
);

/** A word cut to a rough stem, so "payouts", "payout" and "paying out" meet. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("sses")) return word.slice(0, -2);
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** The words a text is searched by: lowercased, accents dropped, stop words left out, each cut to its stem. */
export function searchTerms(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

/** FNV-1a, 32 bits. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The built-in embedder's dimensions. */
export const HASHING_EMBEDDER_DIMENSIONS = 1024;
export const HASHING_EMBEDDER_ID = "local-hash-v1";

/**
 * A deterministic embedder that needs no model, service or key: each search
 * term, and each pair of neighbouring terms at half weight, is hashed to one
 * of a fixed number of positions with a sign, weighted by how often it
 * appears (1 + ln of the count), and the vector is scaled to length 1. Texts that share
 * words point the same way. It knows nothing of synonyms; a hosted embedder
 * would, behind the same interface.
 */
export class HashingEmbedder implements Embedder {
  readonly id: string;
  constructor(readonly dimensions: number = HASHING_EMBEDDER_DIMENSIONS) {
    if (!Number.isInteger(dimensions) || dimensions < 16 || dimensions > 4096) throw new RangeError("dimensions must be a whole number from 16 to 4096");
    this.id = dimensions === HASHING_EMBEDDER_DIMENSIONS ? HASHING_EMBEDDER_ID : `${HASHING_EMBEDDER_ID}-${dimensions}`;
  }

  embedOne(text: string): number[] {
    const terms = searchTerms(text);
    const counts = new Map<string, number>();
    const add = (feature: string) => counts.set(feature, (counts.get(feature) ?? 0) + 1);
    terms.forEach((term, i) => {
      add(`w:${term}`);
      if (i > 0) add(`b:${terms[i - 1]} ${term}`);
    });
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const [feature, count] of counts) {
      const hash = fnv1a(feature);
      // A pair of words counts half as much as a word.
      const weight = (feature.startsWith("b:") ? 0.5 : 1) * (1 + Math.log(count));
      vector[hash % this.dimensions]! += hash & 0x80000000 ? -weight : weight;
    }
    return normalized(vector);
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}

/** The vector scaled to length 1; a vector of zeros stays zeros. */
function normalized(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((v) => v / length);
}

/** Cosine similarity, from -1 to 1. Zero when either vector is all zeros or they differ in length. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

// ---------------------------------------------------------------------------
// Storing passages

/** A document as the index holds it. */
export interface IndexedDocument {
  id: string;
  title: string;
  version: string;
  source: string;
}

/** A passage with its vector, ready to store. */
export interface EmbeddedDocChunk extends DocChunk {
  embedder: string;
  embedding: number[];
}

/** One passage found by a search. */
export interface DocSearchHit {
  documentId: string;
  title: string;
  source: string;
  version: string;
  heading: string;
  text: string;
  /** Cosine similarity to the query, from -1 to 1; higher is closer. */
  score: number;
}

export interface DocSearchQuery {
  embedder: string;
  vector: readonly number[];
  limit: number;
}

/** Where passages and their vectors are kept. Postgres in an instance (PostgresDocChunkStore), memory in tests. */
export interface DocChunkStore {
  /** Every document the index holds for the organization. */
  documents(organizationId: string): Promise<IndexedDocument[]>;
  /** A document's passages with their vectors, by ordinal. */
  chunks(organizationId: string, documentId: string): Promise<EmbeddedDocChunk[]>;
  /** Replaces a document and all its passages at once. */
  save(organizationId: string, document: IndexedDocument, chunks: readonly EmbeddedDocChunk[], at: string): Promise<void>;
  /** Drops a document's passages. */
  remove(organizationId: string, documentId: string, at: string): Promise<void>;
  /** The passages embedded by `query.embedder` closest to the vector, closest first. */
  search(organizationId: string, query: DocSearchQuery): Promise<DocSearchHit[]>;
}

/** Keeps passages in memory and ranks them by cosine similarity. */
export class InMemoryDocChunkStore implements DocChunkStore {
  private readonly orgs = new Map<string, Map<string, { document: IndexedDocument; chunks: EmbeddedDocChunk[] }>>();
  private docsOf(organizationId: string) {
    let docs = this.orgs.get(organizationId);
    if (!docs) this.orgs.set(organizationId, (docs = new Map()));
    return docs;
  }

  async documents(organizationId: string) {
    return [...this.docsOf(organizationId).values()].map((v) => ({ ...v.document }));
  }

  async chunks(organizationId: string, documentId: string) {
    return (this.docsOf(organizationId).get(documentId)?.chunks ?? []).map((c) => ({ ...c, embedding: [...c.embedding] }));
  }

  async save(organizationId: string, document: IndexedDocument, chunks: readonly EmbeddedDocChunk[]) {
    this.docsOf(organizationId).set(document.id, { document: { ...document }, chunks: chunks.map((c) => ({ ...c, embedding: [...c.embedding] })) });
  }

  async remove(organizationId: string, documentId: string) {
    this.docsOf(organizationId).delete(documentId);
  }

  async search(organizationId: string, query: DocSearchQuery) {
    const hits: DocSearchHit[] = [];
    for (const { document, chunks } of this.docsOf(organizationId).values()) {
      for (const c of chunks) {
        if (c.embedder !== query.embedder) continue;
        hits.push({ documentId: document.id, title: document.title, source: document.source, version: document.version, heading: c.heading, text: c.text, score: cosineSimilarity(c.embedding, query.vector) });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, query.limit);
  }
}

// ---------------------------------------------------------------------------
// Keeping the index current and searching it

export interface DocIndexSyncResult {
  /** Documents given. */
  documents: number;
  /** Documents whose passages, title, version and source were already stored as they are. */
  unchanged: number;
  /** Documents saved, new or changed. */
  saved: number;
  /** Documents dropped because they are no longer given. */
  removed: number;
  /** Passages across every document given. */
  chunks: number;
  /** Passages sent to the embedder. */
  embedded: number;
  /** Passages whose stored vector was kept because their text hadn't changed. */
  reused: number;
}

function checkVectors(embedder: Embedder, vectors: number[][], count: number): void {
  if (!Array.isArray(vectors) || vectors.length !== count) throw new Error(`embedder ${embedder.id} returned ${Array.isArray(vectors) ? vectors.length : "no"} vectors for ${count} texts`);
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== embedder.dimensions || !v.every(Number.isFinite)) {
      throw new Error(`embedder ${embedder.id} returned a vector that isn't ${embedder.dimensions} finite numbers`);
    }
  }
}

const sameChunks = (a: readonly EmbeddedDocChunk[], b: readonly DocChunk[], embedder: string) =>
  a.length === b.length && a.every((c, i) => c.embedder === embedder && c.contentHash === b[i]!.contentHash && c.heading === b[i]!.heading && c.text === b[i]!.text);

export interface DocumentIndexOptions {
  store: DocChunkStore;
  organizationId: string;
  /** Defaults to the built-in HashingEmbedder. */
  embedder?: Embedder;
  maxChunkChars?: number;
  now?: () => Date;
}

/**
 * The documentation index for one organization: brings the store in line
 * with the documents given, embedding only passages it doesn't already hold,
 * and answers searches.
 */
export class DocumentIndex {
  readonly embedder: Embedder;
  constructor(private readonly options: DocumentIndexOptions) {
    this.embedder = options.embedder ?? new HashingEmbedder();
  }

  /**
   * Makes the index hold exactly these documents. A passage whose text
   * (with its title and heading) hashes the same as one already stored for
   * that document, by this embedder, keeps its vector; only the rest are
   * embedded. Documents not given are removed.
   */
  async sync(documents: readonly SearchableDocument[]): Promise<DocIndexSyncResult> {
    const { store, organizationId } = this.options;
    const at = (this.options.now ?? (() => new Date()))().toISOString();
    const ids = new Set<string>();
    for (const doc of documents) {
      if (!doc.id) throw new Error("every document needs an id");
      if (ids.has(doc.id)) throw new Error(`document ${doc.id} is given twice`);
      ids.add(doc.id);
    }
    const indexed = new Map((await store.documents(organizationId)).map((d) => [d.id, d]));
    const result: DocIndexSyncResult = { documents: documents.length, unchanged: 0, saved: 0, removed: 0, chunks: 0, embedded: 0, reused: 0 };

    for (const doc of documents) {
      const chunks = chunkDocument(doc, this.options.maxChunkChars);
      result.chunks += chunks.length;
      const before = indexed.get(doc.id);
      const stored = before ? await store.chunks(organizationId, doc.id) : [];
      const meta: IndexedDocument = { id: doc.id, title: doc.title, version: doc.version, source: doc.source };
      if (before && before.title === meta.title && before.version === meta.version && before.source === meta.source && sameChunks(stored, chunks, this.embedder.id)) {
        result.unchanged++;
        result.reused += chunks.length;
        continue;
      }
      const kept = new Map(stored.filter((c) => c.embedder === this.embedder.id && c.embedding.length === this.embedder.dimensions).map((c) => [c.contentHash, c.embedding]));
      const fresh = [...new Set(chunks.filter((c) => !kept.has(c.contentHash)).map((c) => c.contentHash))];
      const texts = new Map(chunks.map((c) => [c.contentHash, chunkEmbeddingText(doc.title, c.heading, c.text)]));
      if (fresh.length) {
        const vectors = await this.embedder.embed(fresh.map((h) => texts.get(h)!));
        checkVectors(this.embedder, vectors, fresh.length);
        fresh.forEach((h, i) => kept.set(h, vectors[i]!));
      }
      result.embedded += fresh.length;
      result.reused += chunks.length - fresh.length;
      await store.save(organizationId, meta, chunks.map((c) => ({ ...c, embedder: this.embedder.id, embedding: kept.get(c.contentHash)! })), at);
      result.saved++;
    }

    for (const id of indexed.keys()) {
      if (ids.has(id)) continue;
      await store.remove(organizationId, id, at);
      result.removed++;
    }
    return result;
  }

  /** The passages closest in meaning to the query, closest first, leaving out any that share nothing with it. */
  async search(query: string, limit = 5): Promise<DocSearchHit[]> {
    const text = query.trim().slice(0, DOC_SEARCH_MAX_QUERY_CHARS);
    const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), DOC_SEARCH_MAX_RESULTS);
    if (!text) return [];
    const [vector] = await this.embedder.embed([text]);
    checkVectors(this.embedder, vector ? [vector] : [], 1);
    if (vector!.every((v) => v === 0)) return [];
    // Twice as many as asked, since a passage copied into two documents (a page and a generated list of pages) is shown once.
    const hits = await this.options.store.search(this.options.organizationId, { embedder: this.embedder.id, vector: vector!, limit: n * 2 });
    const seen = new Set<string>();
    return hits
      // NaN, from a passage with no direction, is never at least the minimum, so it is left out too.
      .filter((h) => h.score >= DOC_SEARCH_MIN_SCORE && !seen.has(h.text) && seen.add(h.text))
      .slice(0, n)
      .map((h) => ({ ...h, score: Math.round(h.score * 10_000) / 10_000 }));
  }

  /** What the index holds, as the registry's `fetchCurrent`: each document's id and version. */
  async current(): Promise<{ id: string; version: string }[]> {
    return (await this.options.store.documents(this.options.organizationId)).map((d) => ({ id: d.id, version: d.version }));
  }
}

// ---------------------------------------------------------------------------
// Documents every instance has

/** A short, stable version for a text: the first 12 hex digits of its SHA-256. */
export const textVersion = (text: string) => `sha256:${sha256Hex(text).slice(0, 12)}`;

/**
 * One document per integration in the catalog: what it is, what it reads,
 * the settings it needs and where its vendor publishes API changes. Built
 * from the code, so every instance can search it with no files at all.
 */
export function catalogDocuments(specs: readonly IntegrationSpec[] = INTEGRATIONS): SearchableDocument[] {
  return specs.map((spec) => {
    // One section, so the passage that names a setting also names the system and what it does.
    const settings = [...new Set([...spec.settings, ...(spec.signIn?.[0] ?? [])])];
    const lines = [
      `# ${spec.name}`,
      "",
      `${spec.name} is a ${spec.domain} system (${spec.access.replace("_", " ")}), ${spec.status === "built" ? "with a built connector" : `with its connector ${spec.status}`}.`,
      ...(spec.note ? ["", spec.note] : []),
      ...(spec.capabilities?.length ? ["", "What it does:", ...spec.capabilities.map((c) => `- ${c}`)] : []),
      ...(settings.length ? ["", `Settings, kept in the instance's secrets: ${settings.join(", ")}.`] : []),
      ...(spec.changelog ? ["", `${spec.name} publishes API changes at ${spec.changelog}; the daily vendor docs watch follows it.`] : []),
    ];
    const text = lines.join("\n");
    return { id: `catalog/${spec.id}`, title: spec.name, version: textVersion(text), source: `catalog:${spec.id}`, text };
  });
}
