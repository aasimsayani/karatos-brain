import { createHash } from "node:crypto";
import { dropboxExtension, dropboxKind } from "../dropbox/normalize.js";

/**
 * Turns the items of a OneDrive or SharePoint drive's delta into Brain A
 * events, the same two Google Drive and Dropbox give: `document.file_updated`
 * for a file or folder, and `document.file_removed` for one that was
 * deleted or that the app can no longer see.
 *
 * Kept for a file: its id, name (unless names are turned off), kind and
 * extension, MIME type, its folder's id, its created and modified times,
 * size and QuickXorHash. Graph is never asked for who created or changed an
 * item, its sharing or its links, and paths aren't returned by delta.
 */

export interface MicrosoftBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface MicrosoftContext {
  receivedAt: string;
  /** "keep" (default) keeps file and folder names; "drop" keeps ids and kinds only. */
  fileNames?: "keep" | "drop";
  /** Files changed before this ISO time are left out (folders and deletions never are). */
  since?: string | undefined;
  /** Names the page the items came from, so a deletion read again from the same page is a duplicate. */
  page: string;
}

/** Item ids: hex with `!` in OneDrive personal, base32-like letters and digits in OneDrive for Business and SharePoint. */
const ITEM_ID = /^[A-Za-z0-9!_-]{1,200}$/;
const MIME = /^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/;
const QUICK_XOR = /^[A-Za-z0-9+/]{27}=$/;
const NAME_MAX = 255;

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A time Graph wrote (up to seven decimal places), as an ISO time, or undefined when it doesn't read. */
export function microsoftTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,7})?Z$/.exec(value);
  if (!m) return undefined;
  const ms = Date.parse(`${m[1]}${m[2] ?? ""}Z`);
  if (Number.isNaN(ms)) return undefined;
  const iso = new Date(ms).toISOString();
  // A date that doesn't exist, such as 30 February, isn't rolled over.
  return iso.slice(0, 19) === m[1] ? iso : undefined;
}

/** The reference for an item id. */
export const microsoftItemRef = (id: string) => `onedrive:item:${id}`;

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): MicrosoftBrainEvent {
  return { id: `microsoft_onedrive_${sha(key).slice(0, 32)}`, type, occurredAt, receivedAt, idempotencyKey: `microsoft_onedrive:${key}`, payload };
}

/**
 * The event for one delta item. A file or folder is keyed by its id and a
 * hash of what's kept, so a rename, move or edit is a new version and a
 * replay is a duplicate. A file with no modified time that reads has no
 * occurredAt and is dead-lettered. A deletion is keyed by its id and the
 * page it was read on. The drive's root folder isn't an event.
 */
export function microsoftItemEvents(item: unknown, ctx: MicrosoftContext): MicrosoftBrainEvent[] {
  if (!isObject(item) || typeof item.id !== "string" || !ITEM_ID.test(item.id) || item.root !== undefined) return [];
  const id = item.id;
  const keepNames = (ctx.fileNames ?? "keep") === "keep";
  const name = keepNames && typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, NAME_MAX) : undefined;
  const named = { name, nameWithheld: keepNames ? undefined : true };

  if (isObject(item.deleted)) {
    const payload = defined({ fileId: microsoftItemRef(id), ...named, reason: "removed" });
    return [event(`removed:${id}:${sha(ctx.page).slice(0, 16)}`, "document.file_removed", ctx.receivedAt, ctx.receivedAt, payload)];
  }
  const parent = isObject(item.parentReference) && typeof item.parentReference.id === "string" && ITEM_ID.test(item.parentReference.id) ? microsoftItemRef(item.parentReference.id) : undefined;
  const modifiedAt = microsoftTime(item.lastModifiedDateTime);
  const base = { fileId: microsoftItemRef(id), ...named, parentId: parent, createdAt: microsoftTime(item.createdDateTime), modifiedAt };

  if (isObject(item.folder)) {
    const payload = defined({ ...base, kind: "folder" });
    return [event(`folder:${id}:${sha(JSON.stringify(payload)).slice(0, 16)}`, "document.file_updated", modifiedAt ?? ctx.receivedAt, ctx.receivedAt, payload)];
  }
  if (ctx.since !== undefined && modifiedAt !== undefined && modifiedAt < ctx.since) return [];
  const fileName = typeof item.name === "string" ? item.name.trim() : "";
  const file = isObject(item.file) ? item.file : {};
  const hashes = isObject(file.hashes) ? file.hashes : {};
  const payload = defined({
    ...base,
    kind: dropboxKind(fileName),
    extension: dropboxExtension(fileName),
    mimeType: typeof file.mimeType === "string" && MIME.test(file.mimeType) ? file.mimeType : undefined,
    sizeBytes: typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : undefined,
    quickXorHash: typeof hashes.quickXorHash === "string" && QUICK_XOR.test(hashes.quickXorHash) ? hashes.quickXorHash : undefined,
    package: isObject(item.package) ? true : undefined,
  });
  return [event(`file:${id}:${sha(JSON.stringify(payload)).slice(0, 16)}`, "document.file_updated", modifiedAt, ctx.receivedAt, payload)];
}
