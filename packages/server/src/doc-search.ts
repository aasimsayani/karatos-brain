import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { catalogDocuments, textVersion, type DocIndexSyncResult, type DocSearchHit, type DocumentIndex, type SearchableDocument } from "@karatos/core";
import { scrubSupportText } from "./support.js";

/**
 * Documentation search in a running instance: what it indexes, keeping the
 * index current, and what support status reports about it. See
 * docs/doc-search.md.
 */

/** Folders under docs/ that are plans and research, not how to run or use anything; they are left out. */
export const DOCS_LEFT_OUT = ["research", "vision"] as const;

/** Every Markdown file under `dir` but the folders left out, each as `docs/<path>`, sorted by path. */
export async function repoDocuments(dir: string): Promise<SearchableDocument[]> {
  const files: string[] = [];
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        if (at === dir && (DOCS_LEFT_OUT as readonly string[]).includes(entry.name)) continue;
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }
  };
  await walk(dir);
  const docs = await Promise.all(
    files.map(async (file) => {
      const text = await readFile(file, "utf8");
      const id = `docs/${relative(dir, file).split(sep).join("/")}`;
      const title = /^#[ \t]+(.+?)[ \t]*$/m.exec(text)?.[1] ?? id;
      return { id, title, version: textVersion(text), source: id, text };
    }),
  );
  return docs.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * What an instance searches: the repository's docs shipped in its image,
 * when it has them, and a document for each integration in the catalog.
 */
export async function instanceDocuments(docsDir: string | null): Promise<SearchableDocument[]> {
  let repo: SearchableDocument[] = [];
  if (docsDir !== null) {
    try {
      repo = await repoDocuments(docsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...repo, ...catalogDocuments()];
}

export interface DocSearchLastSync {
  outcome: "succeeded" | "failed";
  startedAt: string;
  finishedAt: string;
  /** Counts from the sync; null when it failed. */
  result: DocIndexSyncResult | null;
  error: string | null;
}

/** What support status shows about documentation search: names, times and counts. */
export interface DocSearchStatus {
  embedder: string;
  syncing: boolean;
  lastSync: DocSearchLastSync | null;
}

export interface DocSearch {
  /** Brings the index in line with the documents, one sync at a time: a call during a sync waits for that one. */
  sync(): Promise<DocIndexSyncResult>;
  search(query: string, limit?: number): Promise<DocSearchHit[]>;
  readonly embedder: string;
  status(): DocSearchStatus;
}

export interface DocSearchOptions {
  index: DocumentIndex;
  /** Read at each sync, so a changed file is picked up. */
  documents: () => Promise<SearchableDocument[]>;
  now?: () => Date;
}

export function createDocSearch(options: DocSearchOptions): DocSearch {
  const now = options.now ?? (() => new Date());
  let running: Promise<DocIndexSyncResult> | null = null;
  let last: DocSearchLastSync | null = null;

  const run = async () => {
    const startedAt = now().toISOString();
    try {
      const result = await options.index.sync(await options.documents());
      last = { outcome: "succeeded", startedAt, finishedAt: now().toISOString(), result, error: null };
      return result;
    } catch (error) {
      last = { outcome: "failed", startedAt, finishedAt: now().toISOString(), result: null, error: scrubSupportText((error as Error).message ?? String(error)) };
      throw error;
    }
  };

  return {
    embedder: options.index.embedder.id,
    sync() {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
    search: (query, limit) => options.index.search(query, limit),
    status: () => ({ embedder: options.index.embedder.id, syncing: running !== null, lastSync: last ? { ...last, result: last.result ? { ...last.result } : null } : null }),
  };
}
