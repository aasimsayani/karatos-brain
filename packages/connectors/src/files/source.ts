import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where file-based connectors read exports from. The instance points this at
 * a folder outside any git repo; tests use memoryFileSource.
 */
export interface FileSource {
  /** Files directly in the folder, without subfolders. */
  list(): Promise<SourceFile[]>;
  read(name: string): Promise<string>;
}

export interface SourceFile {
  name: string;
  /** ISO time the file last changed; used when a row carries no date of its own. */
  modifiedAt: string;
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Reads the files in one folder. Hidden files and subfolders are skipped. */
export function directorySource(dir: string): FileSource {
  return {
    async list() {
      const entries = await readdir(dir, { withFileTypes: true });
      const files = entries.filter((e) => e.isFile() && !e.name.startsWith("."));
      return Promise.all(files.map(async (e) => ({ name: e.name, modifiedAt: (await stat(join(dir, e.name))).mtime.toISOString() })));
    },
    read: (name) => readFile(join(dir, name), "utf8"),
  };
}

/** Files held in memory, for tests. Change `files` between syncs to simulate a new export. */
export function memoryFileSource(files: Record<string, string>, modifiedAt = "2026-01-01T00:00:00.000Z"): FileSource & { files: Record<string, string> } {
  return {
    files,
    async list() {
      return Object.keys(files).map((name) => ({ name, modifiedAt }));
    },
    async read(name) {
      const text = files[name];
      if (text === undefined) throw new Error(`no file named ${name}`);
      return text;
    },
  };
}
