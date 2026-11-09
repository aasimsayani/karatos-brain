import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { createHash } from "node:crypto";
import type { FileSource, SourceFile } from "../files/source.js";
import { DROPBOX_CURSOR, DropboxApiError, DropboxConfigError, DropboxResetError, dropboxClient, dropboxFolder, type DropboxClient, type DropboxClientOptions } from "./client.js";
import { dropboxEntryEvents, dropboxTime, type DropboxBrainEvent } from "./normalize.js";
import { dropboxWebhookNames } from "./webhooks.js";

/**
 * Dropbox: the folder a store keeps its statements, invoices, appraisals
 * and design files in.
 *
 * The historical import lists the folder and everything below it, 500
 * entries a page, keeping every folder and each file changed in the last
 * five years. When the listing ends, its cursor becomes the change feed:
 * each later sync asks Dropbox only for what changed since, including
 * deletions and moves, so nothing is listed twice. Every batch's checkpoint
 * keeps Dropbox's cursor, so a resumed sync asks again from the page it was
 * on and what it reads twice comes back as duplicates. If Dropbox resets
 * the cursor, the folder is listed again; anything deleted in between can't
 * be seen then.
 *
 * Dropbox webhooks only say an account changed, so they prompt a sync
 * (webhookPromptsSync) rather than carrying events.
 */

/** Declared so it can be gated and audited; it never runs while writes are off, and the token can only read. */
export const DROPBOX_WRITES: WriteAction[] = [{ integration: "dropbox", name: "save_report", description: "Save a generated report to a folder" }];

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface DropboxCursor {
  pass: "historical" | "incremental";
  /** The folder this cursor was made for, lowercased; a change in settings starts over. */
  folder: string;
  /** listing: the folder is being listed; changes: reading what changed since it was. */
  phase: "listing" | "changes";
  /** Dropbox's cursor for the next page, or null before the first. */
  list: string | null;
  /** True once Dropbox said there was nothing more. */
  done: boolean;
  /** Files changed before this aren't kept while listing. */
  since: string;
}

export interface DropboxOptions extends Partial<Pick<DropboxClientOptions, "fetch" | "sleep" | "rateLimitRetries">> {
  appKey: string;
  appSecret: string;
  refreshToken: string;
  /** DROPBOX_FOLDER: the folder to read, as the Dropbox website shows its path. */
  folder: string;
  /** DROPBOX_FILE_NAMES: "keep" (default) or "drop". */
  fileNames?: "keep" | "drop";
  /** Years of history a listing keeps. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: DropboxClient;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isTime = (t: unknown) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t)) && new Date(t).toISOString() === t;
/** Resets one sync takes before it stops and leaves the rest to the next. */
const MAX_RESETS = 3;

export function parseDropboxCursor(raw: string | null): DropboxCursor | null {
  if (raw === null) return null;
  let c: DropboxCursor | null;
  try {
    c = JSON.parse(raw) as DropboxCursor | null;
  } catch {
    c = null;
  }
  const ok =
    typeof c === "object" &&
    c !== null &&
    (c.pass === "historical" || c.pass === "incremental") &&
    typeof c.folder === "string" &&
    dropboxFolder(c.folder) === c.folder &&
    c.folder === c.folder.toLowerCase() &&
    (c.phase === "listing" || c.phase === "changes") &&
    (c.list === null || (typeof c.list === "string" && DROPBOX_CURSOR.test(c.list))) &&
    typeof c.done === "boolean" &&
    // A finished listing or a change feed always has a cursor.
    (c.list !== null || (!c.done && c.phase === "listing")) &&
    isTime(c.since);
  if (!ok || !c) throw new Error("Dropbox checkpoint is not in the expected shape");
  const { pass, folder, phase, list, done, since } = c;
  return { pass, folder, phase, list, done, since };
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

/** Reads DROPBOX_FOLDER, or throws a config error naming it. */
export function checkDropboxFolder(value: unknown): string {
  const folder = dropboxFolder(value);
  if (folder === undefined) throw new DropboxConfigError("set DROPBOX_FOLDER to the folder to read, such as /Statements: it starts with / and isn't the whole Dropbox");
  return folder;
}

export function dropboxConnector(options: DropboxOptions): Connector & { webhookPromptsSync(body: unknown): Promise<boolean> } {
  const folder = checkDropboxFolder(options.folder);
  const key = folder.toLowerCase();
  if (options.fileNames !== undefined && options.fileNames !== "keep" && options.fileNames !== "drop") throw new DropboxConfigError("DROPBOX_FILE_NAMES is keep or drop");
  const client = options.client ?? dropboxClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = positive(options.historyYears ?? 5, "historyYears");
  const fileNames = options.fileNames ?? "keep";

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseDropboxCursor(context.cursor);
    const at = now();
    const ours = saved?.folder === key ? saved : null;
    if (mode === "historical" && ours?.pass === "historical" && ours.done) return;
    const start = new Date(at);
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    const fresh: DropboxCursor = { pass: mode, folder: key, phase: "listing", list: null, done: false, since: start.toISOString() };
    let c: DropboxCursor;
    if (mode === "historical") c = ours?.pass === "historical" ? ours : fresh;
    // An incremental sync goes on from any checkpoint for this folder: the rest of a listing, or its changes.
    else c = ours ? { ...ours, pass: "incremental" } : fresh;
    const receivedAt = at.toISOString();
    let resets = 0;

    do {
      let page;
      try {
        page = c.list === null ? await client.listFolder(folder, true) : await client.listFolderContinue(c.list);
      } catch (error) {
        if (!(error instanceof DropboxResetError) || ++resets > MAX_RESETS) throw error;
        c = { ...fresh, since: c.since };
        continue;
      }
      const ctx = { receivedAt, folder: key, fileNames, since: c.phase === "listing" ? c.since : undefined, page: c.list ?? `list:${key}` };
      const events: DropboxBrainEvent[] = page.entries.flatMap((e) => dropboxEntryEvents(e, ctx));
      c = { ...c, list: page.cursor, done: !page.hasMore, phase: page.hasMore ? c.phase : "changes" };
      yield { events, cursor: JSON.stringify(c) };
    } while (!c.done);
  }

  return {
    source: "dropbox",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: DROPBOX_WRITES,
    async webhookPromptsSync(body) {
      return dropboxWebhookNames(body, (await client.account()).accountId);
    },
  };
}

/**
 * The files directly in one Dropbox folder, for the file imports (bank and
 * refiner statements, supplier invoices and the rest), so exports saved to
 * Dropbox are read without anyone moving them. Its client asks for
 * files.content.read as well; subfolders and files Dropbox can't download
 * (such as Google Docs) are skipped, and a file over 25 MB isn't read.
 */
export function dropboxFileSource(options: Omit<DropboxOptions, "fileNames" | "historyYears" | "now">): FileSource {
  const folder = checkDropboxFolder(options.folder);
  const client = options.client ?? dropboxClient({ ...options, contents: true });
  let listed: Map<string, { id: string; modifiedAt: string }> | null = null;

  async function list(): Promise<SourceFile[]> {
    const files = new Map<string, { id: string; modifiedAt: string }>();
    let page = await client.listFolder(folder, false);
    for (let n = 0; ; n++) {
      for (const e of page.entries) {
        const time = dropboxTime(e.server_modified);
        if (e[".tag"] !== "file" || e.is_downloadable === false || typeof e.id !== "string" || typeof e.name !== "string" || !time) continue;
        // Names come from one folder's listing, so they can't name a path elsewhere.
        if (e.name.includes("/") || e.name.startsWith(".") || e.name.length > 255) continue;
        files.set(e.name, { id: e.id, modifiedAt: time });
      }
      if (!page.hasMore) break;
      if (n >= 1000) throw new DropboxApiError("the folder has more files than one import reads", 0);
      page = await client.listFolderContinue(page.cursor);
    }
    listed = files;
    return [...files].map(([name, f]) => ({ name, modifiedAt: f.modifiedAt }));
  }

  async function bytes(name: string): Promise<Uint8Array> {
    const file = (listed ?? (await list(), listed))?.get(name);
    if (!file) throw new Error(`no file named ${name} in the Dropbox folder`);
    const download = await client.download(file.id);
    const hash = typeof download.metadata.content_hash === "string" ? download.metadata.content_hash : undefined;
    if (hash !== undefined && hash !== dropboxContentHash(download.bytes)) throw new DropboxApiError(`Dropbox's download of ${name} doesn't match its content hash`, 200);
    return download.bytes;
  }

  return {
    list,
    readBytes: bytes,
    read: async (name) => new TextDecoder().decode(await bytes(name)),
  };
}

/** Dropbox's content hash: the SHA-256 of the SHA-256 of each 4 MB block. */
export function dropboxContentHash(data: Uint8Array): string {
  const outer = createHash("sha256");
  for (let i = 0; i < data.length; i += 4 * 1024 * 1024) outer.update(createHash("sha256").update(data.subarray(i, i + 4 * 1024 * 1024)).digest());
  return outer.digest("hex");
}
