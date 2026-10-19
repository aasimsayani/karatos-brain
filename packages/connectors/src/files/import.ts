import type { SourceBatch } from "@karatos/core";
import { sha256 } from "./source.js";

/**
 * The read loop every file-based connector shares. Each sync reads the files
 * that are new or changed since the last one: the checkpoint holds each
 * finished file's SHA-256 and, for a file in progress, how many of its events
 * are stored, so a crash resumes mid-file. A changed file is read again from
 * the top; its unchanged rows come back as duplicates. Files no longer listed
 * drop out of the checkpoint so it doesn't grow forever.
 */

export interface FileCursor {
  /** Files fully read, by name, with the SHA-256 of the content that was read. */
  done: Record<string, string>;
  /** The file being read, and how many of its events are stored. */
  current: { name: string; hash: string; next: number } | null;
}

/** A file to read, in the order given. `name` must be unique across the import. */
export interface ImportFile {
  name: string;
  read(): Promise<string>;
}

/** Validates a checkpoint this loop wrote. `label` names the connector in the error. */
export function parseFileCursor(raw: string | null, label: string): FileCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as FileCursor;
  const hash = (h: unknown) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h);
  if (
    !c ||
    typeof c.done !== "object" ||
    c.done === null ||
    !Object.values(c.done).every(hash) ||
    (c.current !== null && (typeof c.current?.name !== "string" || !hash(c.current.hash) || !Number.isInteger(c.current.next) || c.current.next < 0))
  ) {
    throw new Error(`${label} checkpoint is not in the expected shape`);
  }
  return c;
}

export async function* importFiles<F extends ImportFile, E>(
  files: F[],
  saved: FileCursor | null,
  eventsOf: (file: F, text: string) => E[],
  batchSize: number,
): AsyncIterable<SourceBatch> {
  const names = new Set(files.map((f) => f.name));
  const done = Object.fromEntries(Object.entries(saved?.done ?? {}).filter(([name]) => names.has(name)));

  for (const file of files) {
    const text = await file.read();
    const hash = sha256(text);
    if (done[file.name] === hash) continue;
    const events = eventsOf(file, text);
    // An interrupted file resumes where it stopped, unless it changed since.
    let next = saved?.current?.name === file.name && saved.current.hash === hash ? Math.min(saved.current.next, events.length) : 0;
    do {
      const end = Math.min(next + batchSize, events.length);
      const finished = end === events.length;
      if (finished) done[file.name] = hash;
      const cursor: FileCursor = { done: { ...done }, current: finished ? null : { name: file.name, hash, next: end } };
      yield { events: events.slice(next, end), cursor: JSON.stringify(cursor) };
      next = end;
    } while (next < events.length);
  }
}
