import { createHash } from "node:crypto";

/**
 * Turns Dropbox listing entries into Brain A events, the same two Google
 * Drive gives: `document.file_updated` for a file or folder, and
 * `document.file_removed` for one that was deleted or moved away.
 *
 * Kept for a file: its id, name (unless names are turned off), kind and
 * extension, a reference to its path and its folder's, its modified times,
 * size, revision and content hash. Paths themselves aren't kept, since
 * folder names often name customers; the reference is a hash of the
 * lowercased path, so a deletion, which Dropbox reports by path only, links
 * to the file that was there. Never kept: sharing, links, or who changed it.
 */

export interface DropboxBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface DropboxContext {
  receivedAt: string;
  /** The folder being read, lowercased. Entries outside it are dropped. */
  folder: string;
  /** "keep" (default) keeps file and folder names; "drop" keeps ids and kinds only. */
  fileNames?: "keep" | "drop";
  /** Files changed before this ISO time are left out (folders and deletions never are). */
  since?: string | undefined;
  /** Names the page the entries came from, so a deletion read again from the same page is a duplicate. */
  page: string;
}

export type DropboxKind = "folder" | "spreadsheet" | "document" | "presentation" | "pdf" | "image" | "design" | "file";
const KINDS: [RegExp, DropboxKind][] = [
  [/^pdf$/, "pdf"],
  [/^(csv|tsv|xlsx?|xlsm|ods|numbers)$/, "spreadsheet"],
  [/^(docx?|odt|rtf|txt|pages|md)$/, "document"],
  [/^(pptx?|odp|key)$/, "presentation"],
  [/^(jpe?g|png|gif|heic|heif|webp|tiff?|bmp|svg)$/, "image"],
  [/^(3dm|stl|obj|step|stp|iges|igs|dwg|dxf|ai|psd|matrix|jcd)$/, "design"],
];

const FILE_ID = /^id:[A-Za-z0-9_-]{1,64}$/;
const REV = /^[0-9a-f]{9,64}$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;
const NAME_MAX = 255;
const PATH_MAX = 4096;

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/** A time Dropbox wrote, as an ISO time, or undefined when it doesn't read. */
export function dropboxTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  // Only Dropbox's own form reads: a date that doesn't exist, such as 30 February, isn't rolled over.
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 19)}Z` === value ? iso : undefined;
}

/** The reference for a lowercased path: a hash, never the path. */
export const dropboxPathRef = (pathLower: string) => `dropbox:path:${sha(pathLower).slice(0, 16)}`;
/** The reference for a file or folder id. */
export const dropboxFileRef = (id: string) => `dropbox:file:${id.slice(3)}`;

/** A file name's extension, lowercased, when it has a short one. */
export function dropboxExtension(name: string): string | undefined {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m && m.index > 0 ? m[1]!.toLowerCase() : undefined;
}

/** What kind of file a name is, from its extension. */
export function dropboxKind(name: string): DropboxKind {
  const ext = dropboxExtension(name);
  return (ext && KINDS.find(([rule]) => rule.test(ext))?.[1]) || "file";
}

/** The lowercased path, when it reads and lies in the folder being read (or is the folder). */
function inside(value: unknown, folder: string): string | undefined {
  if (typeof value !== "string" || value.length > PATH_MAX || /[\x00-\x1f]/.test(value)) return undefined;
  const path = value.toLowerCase();
  return path === folder || path.startsWith(`${folder}/`) ? path : undefined;
}

/** Paths read are inside a folder that isn't the root, so a parent is never the root. */
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): DropboxBrainEvent {
  return { id: `dropbox_${sha(key).slice(0, 32)}`, type, occurredAt, receivedAt, idempotencyKey: `dropbox:${key}`, payload };
}

/**
 * The event for one listing entry. A file or folder is keyed by its id and a
 * hash of what's kept, so a rename, move or edit is a new version and a
 * replay is a duplicate. A file with no modified time that reads has no
 * occurredAt and is dead-lettered. A deletion is keyed by its path and the
 * page it was read from.
 */
export function dropboxEntryEvents(entry: unknown, ctx: DropboxContext): DropboxBrainEvent[] {
  if (typeof entry !== "object" || entry === null) return [];
  const e = entry as Record<string, unknown>;
  const tag = e[".tag"];
  const path = inside(e.path_lower, ctx.folder);
  if (path === undefined) return [];
  const keepNames = (ctx.fileNames ?? "keep") === "keep";
  const name = keepNames && typeof e.name === "string" && e.name.trim() ? e.name.trim().slice(0, NAME_MAX) : undefined;
  const named = { name, nameWithheld: keepNames ? undefined : true };

  if (tag === "deleted") {
    const payload = defined({ pathId: dropboxPathRef(path), ...named, reason: "removed" });
    return [event(`removed:${sha(path).slice(0, 16)}:${sha(ctx.page).slice(0, 16)}`, "document.file_removed", ctx.receivedAt, ctx.receivedAt, payload)];
  }
  if ((tag !== "file" && tag !== "folder") || typeof e.id !== "string" || !FILE_ID.test(e.id)) return [];
  const base = { fileId: dropboxFileRef(e.id), ...named, pathId: dropboxPathRef(path), parentPathId: path === ctx.folder ? undefined : dropboxPathRef(parentOf(path)) };

  if (tag === "folder") {
    const payload = defined({ ...base, kind: "folder" });
    return [event(`folder:${e.id}:${sha(JSON.stringify(payload)).slice(0, 16)}`, "document.file_updated", ctx.receivedAt, ctx.receivedAt, payload)];
  }
  const modifiedAt = dropboxTime(e.server_modified);
  if (ctx.since !== undefined && modifiedAt !== undefined && modifiedAt < ctx.since) return [];
  const fileName = typeof e.name === "string" ? e.name : "";
  const size = typeof e.size === "number" && Number.isSafeInteger(e.size) && e.size >= 0 ? e.size : undefined;
  const payload = defined({
    ...base,
    kind: dropboxKind(fileName),
    extension: dropboxExtension(fileName),
    modifiedAt,
    clientModifiedAt: dropboxTime(e.client_modified),
    sizeBytes: size,
    revision: typeof e.rev === "string" && REV.test(e.rev) ? e.rev : undefined,
    contentHash: typeof e.content_hash === "string" && CONTENT_HASH.test(e.content_hash) ? e.content_hash : undefined,
    downloadable: e.is_downloadable === false ? false : undefined,
  });
  return [event(`file:${e.id}:${sha(JSON.stringify(payload)).slice(0, 16)}`, "document.file_updated", modifiedAt, ctx.receivedAt, payload)];
}
