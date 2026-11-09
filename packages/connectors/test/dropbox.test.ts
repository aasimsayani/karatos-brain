import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runSync } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, dropboxDocMock, testPipeline, type DropboxMockData, type DropboxMockFile } from "@karatos/connector-testkit";
import {
  DROPBOX_CONTENT_SCOPE,
  DROPBOX_MAX_DOWNLOAD_BYTES,
  DROPBOX_METADATA_SCOPES,
  DROPBOX_PAGE_SIZE,
  DROPBOX_WRITES,
  DropboxApiError,
  DropboxConfigError,
  DropboxResetError,
  checkDropboxFolder,
  dropboxClient,
  dropboxConnector,
  dropboxContentHash,
  dropboxEntryEvents,
  dropboxExtension,
  dropboxFileRef,
  dropboxFileSource,
  dropboxFolder,
  dropboxHeaderJson,
  dropboxKind,
  dropboxPathRef,
  dropboxTime,
  dropboxWebhookChallenge,
  dropboxWebhookNames,
  parseDropboxCursor,
  verifyDropboxWebhook,
  type DropboxClient,
  type DropboxCursor,
  type DropboxListPage,
} from "../src/index.js";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const RECEIVED = NOW.toISOString();
const SINCE = "2021-11-09T12:00:00.000Z";
const APP_KEY = "k".repeat(15);
const APP_SECRET = "s".repeat(15);
const REFRESH = "r".repeat(64);
const ACCOUNT = "dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc";
const noSleep = async () => {};

const FILES: DropboxMockFile[] = [
  { path: "/Accounting" },
  { path: "/Accounting/Statements" },
  { path: "/Accounting/Statements/2026-10 Bank.csv", content: "date,amount\n2026-10-01,100.00\n", serverModified: "2026-10-02T09:00:00Z" },
  { path: "/Accounting/Invoices" },
  { path: "/Accounting/Invoices/INV-1001.pdf", content: "%PDF-1.4 test", serverModified: "2026-10-03T09:00:00Z" },
  { path: "/Accounting/Appraisals" },
  { path: "/Accounting/Appraisals/Ring 4421.jpg", content: "jpeg bytes", serverModified: "2026-10-04T09:00:00Z" },
  { path: "/Accounting/old.xlsx", content: "old", serverModified: "2019-05-01T09:00:00Z" },
  { path: "/Accounting/Price list.gdoc", content: "", serverModified: "2026-10-05T09:00:00Z", downloadable: false },
  { path: "/Accounting/broken.txt", content: "x", serverModified: "2026-13-01T09:00:00Z" },
  { path: "/Other" },
  { path: "/Other/private.txt", content: "not shared", serverModified: "2026-10-06T09:00:00Z" },
];

function account(extra: Partial<DropboxMockData> = {}): DropboxMockData {
  return {
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    refreshToken: REFRESH,
    accountId: ACCOUNT,
    appScopes: ["account_info.read", "files.metadata.read", "files.content.read"],
    files: FILES.map((f) => ({ ...f })),
    ...extra,
  };
}

function connector(data: DropboxMockData, options: { folder?: string; fileNames?: "keep" | "drop" } = {}) {
  const mock = dropboxDocMock(data);
  const c = dropboxConnector({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: REFRESH, folder: options.folder ?? "/Accounting", fetch: mock.fetch, sleep: noSleep, now: () => NOW, ...(options.fileNames ? { fileNames: options.fileNames } : {}) });
  return { c, mock };
}

async function batches(iterable: AsyncIterable<{ events: unknown[]; cursor: string | null }>) {
  const out: { events: { type: string; occurredAt?: string; idempotencyKey: string; payload: Record<string, unknown> }[]; cursor: string | null }[] = [];
  for await (const b of iterable) out.push(b as (typeof out)[number]);
  return out;
}
const names = (out: Awaited<ReturnType<typeof batches>>) => out.flatMap((b) => b.events).map((e) => `${e.type === "document.file_removed" ? "-" : ""}${String(e.payload.name)}`);
const cursorOf = (out: Awaited<ReturnType<typeof batches>>, i = -1) => parseDropboxCursor(out.at(i)!.cursor)!;
const reads = (mock: { fetch: { calls: { method: string; url: string }[] } }) => mock.fetch.calls.map((c) => `${c.method} ${c.url}`);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const TOKEN_OK = (extra: Record<string, unknown> = {}) => json(200, { access_token: `sl.u.${"t".repeat(40)}`, token_type: "bearer", expires_in: 14400, ...extra });
const ACCOUNT_OK = () => json(200, { account_id: ACCOUNT, root_info: { ".tag": "user", root_namespace_id: "3235641", home_namespace_id: "3235641" } });

/** A fetch that answers in turn, recording each request. */
function scripted(...answers: (() => Response)[]) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected request to ${String(url)}`);
    return next();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof dropboxClient>[0]> = {}) => dropboxClient({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: REFRESH, fetch, sleep: noSleep, now: () => NOW, ...extra });

describe("Dropbox settings", () => {
  it("reads a folder path that starts with / and names a folder", () => {
    expect(dropboxFolder("/Accounting")).toBe("/Accounting");
    expect(dropboxFolder("  /Accounting/Statements  ")).toBe("/Accounting/Statements");
    expect(dropboxFolder("/Café")).toBe("/Café");
    expect(dropboxFolder(`/${"a".repeat(999)}`)).toBe(`/${"a".repeat(999)}`);
    for (const bad of ["", "/", "Accounting", "/Accounting/", "//Accounting", "/a//b", "/a/./b", "/a/../b", "/..", "/a\\b", "/a\nb", "/a\x7fb", `/${"a".repeat(1000)}`, 5, null, undefined]) {
      expect(dropboxFolder(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(checkDropboxFolder("/Accounting")).toBe("/Accounting");
    expect(() => checkDropboxFolder("/")).toThrow(DropboxConfigError);
    expect(() => checkDropboxFolder("/")).toThrow(/DROPBOX_FOLDER/);
  });

  it("writes header JSON with everything outside printable ASCII escaped", () => {
    expect(dropboxHeaderJson({ path: "/Café ☃" })).toBe('{"path":"/Caf\\u00e9 \\u2603"}');
    expect(dropboxHeaderJson({ path: "/a\x7f" })).toBe('{"path":"/a\\u007f"}');
    expect(JSON.parse(dropboxHeaderJson({ path: "/Café ☃" }))).toEqual({ path: "/Café ☃" });
    expect(dropboxHeaderJson({ path: "/plain~" })).toBe('{"path":"/plain~"}');
  });

  it("turns down app keys, secrets and refresh tokens that don't read, naming the setting", () => {
    const fetch = scripted().fetch;
    expect(() => dropboxClient({ appKey: "short", appSecret: APP_SECRET, refreshToken: REFRESH, fetch })).toThrow(/DROPBOX_APP_KEY/);
    expect(() => dropboxClient({ appKey: "K".repeat(15), appSecret: APP_SECRET, refreshToken: REFRESH, fetch })).toThrow(/DROPBOX_APP_KEY/);
    expect(() => dropboxClient({ appKey: "k".repeat(41), appSecret: APP_SECRET, refreshToken: REFRESH, fetch })).toThrow(/DROPBOX_APP_KEY/);
    expect(() => dropboxClient({ appKey: APP_KEY, appSecret: "s".repeat(9), refreshToken: REFRESH, fetch })).toThrow(/DROPBOX_APP_SECRET/);
    expect(() => dropboxClient({ appKey: APP_KEY, appSecret: "s!".repeat(8), refreshToken: REFRESH, fetch })).toThrow(/DROPBOX_APP_SECRET/);
    expect(() => dropboxClient({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: "r".repeat(19), fetch })).toThrow(/DROPBOX_REFRESH_TOKEN/);
    expect(() => dropboxClient({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: "r.".repeat(20), fetch })).toThrow(/DROPBOX_REFRESH_TOKEN/);
    expect(() => dropboxClient({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: "r".repeat(1025), fetch })).toThrow(/DROPBOX_REFRESH_TOKEN/);
    // Surrounding spaces, as a pasted setting has, are fine.
    expect(() => dropboxClient({ appKey: ` ${APP_KEY} `, appSecret: ` ${APP_SECRET}`, refreshToken: `${REFRESH}\n`, fetch })).not.toThrow();
    expect(() => dropboxClient({ appKey: "k".repeat(10), appSecret: "s".repeat(40), refreshToken: "r".repeat(20), fetch })).not.toThrow();
  });
});

describe("Dropbox entries", () => {
  const ctx = { receivedAt: RECEIVED, folder: "/accounting", page: "list:/accounting" };
  const file = (extra: Record<string, unknown> = {}) => ({
    ".tag": "file",
    name: "INV-1001.pdf",
    path_lower: "/accounting/invoices/inv-1001.pdf",
    path_display: "/Accounting/Invoices/INV-1001.pdf",
    id: "id:a4ayc_80_OEAAAAAAAAAXw",
    client_modified: "2026-10-03T08:00:00Z",
    server_modified: "2026-10-03T09:00:00Z",
    rev: "a1c10ce0dd78",
    size: 7212,
    content_hash: "e".repeat(64),
    is_downloadable: true,
    sharing_info: { modified_by: "dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc" },
    ...extra,
  });

  it("keeps a file's id, name, kind, path references, times, size, revision and content hash, and nothing else", () => {
    const [e] = dropboxEntryEvents(file(), ctx);
    expect(e).toEqual({
      id: expect.stringMatching(/^dropbox_[0-9a-f]{32}$/),
      type: "document.file_updated",
      occurredAt: "2026-10-03T09:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^dropbox:file:id:a4ayc_80_OEAAAAAAAAAXw:[0-9a-f]{16}$/),
      payload: {
        fileId: "dropbox:file:a4ayc_80_OEAAAAAAAAAXw",
        name: "INV-1001.pdf",
        pathId: dropboxPathRef("/accounting/invoices/inv-1001.pdf"),
        parentPathId: dropboxPathRef("/accounting/invoices"),
        kind: "pdf",
        extension: "pdf",
        modifiedAt: "2026-10-03T09:00:00.000Z",
        clientModifiedAt: "2026-10-03T08:00:00.000Z",
        sizeBytes: 7212,
        revision: "a1c10ce0dd78",
        contentHash: "e".repeat(64),
      },
    });
    expect(e!.id).toBe(`dropbox_${createHash("sha256").update(e!.idempotencyKey.slice("dropbox:".length)).digest("hex").slice(0, 32)}`);
    expect(JSON.stringify(e)).not.toMatch(/Accounting\/|dbid|modified_by|sharing/);
    expect(dropboxPathRef("/accounting")).toBe(`dropbox:path:${createHash("sha256").update("/accounting").digest("hex").slice(0, 16)}`);
    expect(dropboxFileRef("id:abc")).toBe("dropbox:file:abc");
  });

  it("keys each version by what's kept, so an edit is new and a replay is a duplicate", () => {
    const [a] = dropboxEntryEvents(file(), ctx);
    const [b] = dropboxEntryEvents(file({ sharing_info: { modified_by: "dbid:other" } }), { ...ctx, receivedAt: "2026-11-10T00:00:00.000Z" });
    const [c] = dropboxEntryEvents(file({ rev: "a1c10ce0dd79" }), ctx);
    expect(b!.idempotencyKey).toBe(a!.idempotencyKey);
    expect(c!.idempotencyKey).not.toBe(a!.idempotencyKey);
    // A rename or move keeps the id and is a new version.
    const [moved] = dropboxEntryEvents(file({ path_lower: "/accounting/paid/inv-1001.pdf" }), ctx);
    expect(moved!.payload.fileId).toBe(a!.payload.fileId);
    expect(moved!.idempotencyKey).not.toBe(a!.idempotencyKey);
  });

  it("leaves out what doesn't read, and marks a file Dropbox can't download", () => {
    const [e] = dropboxEntryEvents(file({ name: "  ", rev: "xyz", content_hash: "abc", size: -1, client_modified: "yesterday", is_downloadable: false }), ctx);
    expect(e!.payload).toEqual({
      fileId: "dropbox:file:a4ayc_80_OEAAAAAAAAAXw",
      pathId: dropboxPathRef("/accounting/invoices/inv-1001.pdf"),
      parentPathId: dropboxPathRef("/accounting/invoices"),
      kind: "file",
      modifiedAt: "2026-10-03T09:00:00.000Z",
      downloadable: false,
    });
    expect(dropboxEntryEvents(file({ size: 1.5 }), ctx)[0]!.payload.sizeBytes).toBeUndefined();
    expect(dropboxEntryEvents(file({ size: "12" }), ctx)[0]!.payload.sizeBytes).toBeUndefined();
    expect(dropboxEntryEvents(file({ size: 0 }), ctx)[0]!.payload.sizeBytes).toBe(0);
    expect(dropboxEntryEvents(file({ rev: "a".repeat(8) }), ctx)[0]!.payload.revision).toBeUndefined();
    expect(dropboxEntryEvents(file({ rev: "a".repeat(65) }), ctx)[0]!.payload.revision).toBeUndefined();
    expect(dropboxEntryEvents(file({ rev: "a".repeat(64) }), ctx)[0]!.payload.revision).toBe("a".repeat(64));
    expect(dropboxEntryEvents(file({ content_hash: "E".repeat(64) }), ctx)[0]!.payload.contentHash).toBeUndefined();
    expect(dropboxEntryEvents(file({ content_hash: "e".repeat(63) }), ctx)[0]!.payload.contentHash).toBeUndefined();
    expect(dropboxEntryEvents(file({ name: 5 }), ctx)[0]!.payload).not.toHaveProperty("name");
    expect(dropboxEntryEvents(file({ name: `  ${"n".repeat(300)} ` }), ctx)[0]!.payload.name).toBe("n".repeat(255));
  });

  it("has no time for a file whose modified time doesn't read, so it is dead-lettered", () => {
    for (const bad of ["2026-13-01T09:00:00Z", "2026-10-03T09:00:00.000Z", "2026-10-03 09:00:00Z", 5, undefined]) {
      const [e] = dropboxEntryEvents(file({ server_modified: bad }), ctx);
      expect(e!.occurredAt, String(bad)).toBeUndefined();
      expect(e!.payload).not.toHaveProperty("modifiedAt");
    }
    expect(dropboxTime("2026-10-03T09:00:00Z")).toBe("2026-10-03T09:00:00.000Z");
    expect(dropboxTime("2026-02-30T09:00:00Z")).toBeUndefined();
  });

  it("keeps a folder with no time of its own, at the time it was read", () => {
    const [e] = dropboxEntryEvents({ ".tag": "folder", name: "Invoices", path_lower: "/accounting/invoices", path_display: "/Accounting/Invoices", id: "id:a4ayc_80_OEAAAAAAAAAYa" }, ctx);
    expect(e).toMatchObject({ type: "document.file_updated", occurredAt: RECEIVED, idempotencyKey: expect.stringMatching(/^dropbox:folder:id:a4ayc_80_OEAAAAAAAAAYa:[0-9a-f]{16}$/) });
    expect(e!.payload).toEqual({ fileId: "dropbox:file:a4ayc_80_OEAAAAAAAAAYa", name: "Invoices", pathId: dropboxPathRef("/accounting/invoices"), parentPathId: dropboxPathRef("/accounting"), kind: "folder" });
    // The shared folder itself has no parent inside what is read.
    const [top] = dropboxEntryEvents({ ".tag": "folder", name: "Accounting", path_lower: "/accounting", id: "id:a4ayc_80_OEAAAAAAAAAYb" }, ctx);
    expect(top!.payload).not.toHaveProperty("parentPathId");
    const [deep] = dropboxEntryEvents({ ".tag": "folder", name: "X", path_lower: "/a", id: "id:a4ayc_80_OEAAAAAAAAAYc" }, { ...ctx, folder: "/a" });
    expect(deep!.payload.pathId).toBe(dropboxPathRef("/a"));
  });

  it("reports a deletion by its path, keyed by the page it was read on", () => {
    const deleted = { ".tag": "deleted", name: "INV-1001.pdf", path_lower: "/accounting/invoices/inv-1001.pdf", path_display: "/Accounting/Invoices/INV-1001.pdf" };
    const [e] = dropboxEntryEvents(deleted, { ...ctx, page: "cursor-a" });
    expect(e).toEqual({
      id: expect.stringMatching(/^dropbox_[0-9a-f]{32}$/),
      type: "document.file_removed",
      occurredAt: RECEIVED,
      receivedAt: RECEIVED,
      idempotencyKey: `dropbox:removed:${createHash("sha256").update("/accounting/invoices/inv-1001.pdf").digest("hex").slice(0, 16)}:${createHash("sha256").update("cursor-a").digest("hex").slice(0, 16)}`,
      payload: { pathId: dropboxPathRef("/accounting/invoices/inv-1001.pdf"), name: "INV-1001.pdf", reason: "removed" },
    });
    // Read again from the same page, it's a duplicate; from a later page, a new removal.
    expect(dropboxEntryEvents(deleted, { ...ctx, page: "cursor-a", receivedAt: "2026-11-10T00:00:00.000Z" })[0]!.idempotencyKey).toBe(e!.idempotencyKey);
    expect(dropboxEntryEvents(deleted, { ...ctx, page: "cursor-b" })[0]!.idempotencyKey).not.toBe(e!.idempotencyKey);
    // A deletion links to the file that was there.
    expect(e!.payload.pathId).toBe(dropboxEntryEvents(file(), ctx)[0]!.payload.pathId);
  });

  it("drops names when told to, keeping ids and kinds", () => {
    const drop = { ...ctx, fileNames: "drop" as const };
    expect(dropboxEntryEvents(file(), drop)[0]!.payload).toMatchObject({ nameWithheld: true, kind: "pdf", extension: "pdf" });
    expect(dropboxEntryEvents(file(), drop)[0]!.payload).not.toHaveProperty("name");
    const [gone] = dropboxEntryEvents({ ".tag": "deleted", name: "Smith.pdf", path_lower: "/accounting/smith.pdf" }, drop);
    expect(gone!.payload).toEqual({ pathId: dropboxPathRef("/accounting/smith.pdf"), nameWithheld: true, reason: "removed" });
    expect(JSON.stringify(gone)).not.toMatch(/smith/i);
    expect(dropboxEntryEvents(file(), { ...ctx, fileNames: "keep" })[0]!.payload).not.toHaveProperty("nameWithheld");
  });

  it("drops entries outside the folder, without a usable id, or of another kind", () => {
    expect(dropboxEntryEvents(file({ path_lower: "/other/inv-1001.pdf" }), ctx)).toEqual([]);
    expect(dropboxEntryEvents(file({ path_lower: "/accountingx/inv-1001.pdf" }), ctx)).toEqual([]);
    expect(dropboxEntryEvents(file({ path_lower: "/ACCOUNTING/inv.pdf" }), ctx)).toHaveLength(1);
    expect(dropboxEntryEvents(file({ path_lower: "/accounting/a\nb.pdf" }), ctx)).toEqual([]);
    expect(dropboxEntryEvents(file({ path_lower: `/accounting/${"a".repeat(4085)}` }), ctx)).toEqual([]);
    expect(dropboxEntryEvents(file({ path_lower: `/accounting/${"a".repeat(4084)}` }), ctx)).toHaveLength(1);
    expect(dropboxEntryEvents(file({ path_lower: 5 }), ctx)).toEqual([]);
    expect(dropboxEntryEvents({ ".tag": "deleted", path_lower: "/other/x.pdf" }, ctx)).toEqual([]);
    for (const id of ["a4ayc", "id:", "id:a b", `id:${"a".repeat(65)}`, 5]) expect(dropboxEntryEvents(file({ id }), ctx), String(id)).toEqual([]);
    expect(dropboxEntryEvents(file({ id: `id:${"a".repeat(64)}` }), ctx)).toHaveLength(1);
    expect(dropboxEntryEvents(file({ ".tag": "symlink" }), ctx)).toEqual([]);
    for (const bad of [null, "file", [file()], 5]) expect(dropboxEntryEvents(bad, ctx)).toEqual([]);
  });

  it("keeps files changed since the history start, and older ones only when no start is given", () => {
    const since = { ...ctx, since: "2026-10-03T09:00:00.000Z" };
    expect(dropboxEntryEvents(file(), since)).toHaveLength(1);
    expect(dropboxEntryEvents(file({ server_modified: "2026-10-03T08:59:59Z" }), since)).toEqual([]);
    expect(dropboxEntryEvents(file({ server_modified: "2026-10-03T08:59:59Z" }), ctx)).toHaveLength(1);
    // A file whose time doesn't read is kept, to be dead-lettered.
    expect(dropboxEntryEvents(file({ server_modified: "bad" }), since)).toHaveLength(1);
  });

  it("tells a file's kind from its extension", () => {
    const cases: [string, string, string | undefined][] = [
      ["Statement.PDF", "pdf", "pdf"],
      ["stock.csv", "spreadsheet", "csv"],
      ["stock.tsv", "spreadsheet", "tsv"],
      ["book.xlsx", "spreadsheet", "xlsx"],
      ["book.xls", "spreadsheet", "xls"],
      ["book.xlsm", "spreadsheet", "xlsm"],
      ["book.ods", "spreadsheet", "ods"],
      ["book.numbers", "spreadsheet", "numbers"],
      ["letter.docx", "document", "docx"],
      ["letter.doc", "document", "doc"],
      ["notes.txt", "document", "txt"],
      ["notes.md", "document", "md"],
      ["memo.rtf", "document", "rtf"],
      ["memo.odt", "document", "odt"],
      ["memo.pages", "document", "pages"],
      ["deck.pptx", "presentation", "pptx"],
      ["deck.ppt", "presentation", "ppt"],
      ["deck.key", "presentation", "key"],
      ["deck.odp", "presentation", "odp"],
      ["ring.jpg", "image", "jpg"],
      ["ring.jpeg", "image", "jpeg"],
      ["ring.HEIC", "image", "heic"],
      ["ring.heif", "image", "heif"],
      ["ring.png", "image", "png"],
      ["ring.gif", "image", "gif"],
      ["ring.webp", "image", "webp"],
      ["ring.tif", "image", "tif"],
      ["ring.tiff", "image", "tiff"],
      ["ring.bmp", "image", "bmp"],
      ["ring.svg", "image", "svg"],
      ["ring.3dm", "design", "3dm"],
      ["ring.stl", "design", "stl"],
      ["ring.obj", "design", "obj"],
      ["ring.step", "design", "step"],
      ["ring.stp", "design", "stp"],
      ["ring.iges", "design", "iges"],
      ["ring.igs", "design", "igs"],
      ["ring.dwg", "design", "dwg"],
      ["ring.dxf", "design", "dxf"],
      ["ring.ai", "design", "ai"],
      ["ring.psd", "design", "psd"],
      ["ring.matrix", "design", "matrix"],
      ["ring.jcd", "design", "jcd"],
      ["archive.zip", "file", "zip"],
      ["README", "file", undefined],
      [".hidden", "file", undefined],
      ["a.b.pdf", "pdf", "pdf"],
      ["x.pdfx", "file", "pdfx"],
      ["x.verylongextension", "file", undefined],
      ["x.", "file", undefined],
      ["x.p-f", "file", undefined],
    ];
    for (const [name, kind, ext] of cases) {
      expect(dropboxKind(name), name).toBe(kind);
      expect(dropboxExtension(name), name).toBe(ext);
    }
  });
});

describe("the Dropbox client", () => {
  it("refreshes a token asking for read scopes only, and keeps it until five minutes before it ends", async () => {
    let t = NOW.getTime();
    const { fetch, sent } = scripted(TOKEN_OK, ACCOUNT_OK, () => json(200, { entries: [], cursor: "c1", has_more: false }), () => json(200, { entries: [], cursor: "c2", has_more: false }), () => TOKEN_OK({ access_token: `sl.u.${"n".repeat(40)}` }), () => json(200, { entries: [], cursor: "c3", has_more: false }));
    const c = client(fetch, { now: () => new Date(t) });
    await c.listFolder("/Accounting", true);
    t += 14400_000 - 5 * 60_000 - 1;
    await c.listFolderContinue("c1");
    t += 1;
    await c.listFolderContinue("c2");
    expect(sent.map((s) => s.url)).toEqual([
      "https://api.dropboxapi.com/oauth2/token",
      "https://api.dropboxapi.com/2/users/get_current_account",
      "https://api.dropboxapi.com/2/files/list_folder",
      "https://api.dropboxapi.com/2/files/list_folder/continue",
      "https://api.dropboxapi.com/oauth2/token",
      "https://api.dropboxapi.com/2/files/list_folder/continue",
    ]);
    const form = new URLSearchParams(String(sent[0]!.init.body));
    expect(Object.fromEntries(form)).toEqual({ grant_type: "refresh_token", refresh_token: REFRESH, client_id: APP_KEY, client_secret: APP_SECRET, scope: "account_info.read files.metadata.read" });
    expect(sent[0]!.init.method).toBe("POST");
    expect(new Headers(sent[0]!.init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(new Headers(sent[5]!.init.headers).get("authorization")).toBe(`Bearer sl.u.${"n".repeat(40)}`);
    expect(new Headers(sent[3]!.init.headers).get("authorization")).toBe(`Bearer sl.u.${"t".repeat(40)}`);
    expect(DROPBOX_METADATA_SCOPES).toEqual(["account_info.read", "files.metadata.read"]);
  });

  it("asks for files.content.read as well only when made for file imports", async () => {
    const { fetch, sent } = scripted(TOKEN_OK, ACCOUNT_OK, () => json(200, { entries: [], cursor: "c1", has_more: false }));
    await client(fetch, { contents: true }).listFolder("/Accounting", false);
    expect(new URLSearchParams(String(sent[0]!.init.body)).get("scope")).toBe(`account_info.read files.metadata.read ${DROPBOX_CONTENT_SCOPE}`);
  });

  it("stops when Dropbox reports a token with any scope beyond what was asked", async () => {
    for (const scope of ["account_info.read files.metadata.read files.content.write", "files.metadata.write", "account_info.read files.metadata.read files.content.read", 5]) {
      const { fetch } = scripted(() => TOKEN_OK({ scope }));
      const error = await failure(client(fetch).account());
      expect(error, String(scope)).toBeInstanceOf(DropboxConfigError);
      expect(error.message).toMatch(/more than account_info.read, files.metadata.read; KaratOS only reads/);
    }
    // Exactly what was asked, or less, is fine; so is an answer without the scope.
    for (const scope of ["account_info.read files.metadata.read", "files.metadata.read", "  files.metadata.read  account_info.read ", undefined]) {
      const { fetch } = scripted(() => TOKEN_OK(scope === undefined ? {} : { scope }), ACCOUNT_OK);
      await expect(client(fetch).account(), String(scope)).resolves.toEqual({ accountId: ACCOUNT, rootNamespaceId: "3235641" });
    }
  });

  it("explains a refresh Dropbox turns down", async () => {
    const cases: [Response, RegExp, typeof DropboxConfigError | typeof DropboxApiError][] = [
      [json(400, { error: "invalid_grant", error_description: "refresh token is invalid or revoked" }), /turned down DROPBOX_REFRESH_TOKEN/, DropboxConfigError],
      [json(400, { error: "invalid_client" }), /DROPBOX_APP_KEY or DROPBOX_APP_SECRET/, DropboxConfigError],
      [json(401, { error: "unauthorized" }), /DROPBOX_APP_KEY or DROPBOX_APP_SECRET/, DropboxConfigError],
      [json(400, { error: "invalid_scope" }), /doesn't have account_info.read, files.metadata.read: turn them on in the app's Permissions tab/, DropboxConfigError],
      [json(500, { error: "server_error" }), /HTTP 500 to the token refresh/, DropboxApiError],
      [new Response("<html>", { status: 200 }), /HTTP 200 to the token refresh/, DropboxApiError],
      [json(200, [1]), /HTTP 200 to the token refresh/, DropboxApiError],
      [json(200, { token_type: "bearer" }), /no access token in the expected shape/, DropboxApiError],
      [json(200, { access_token: "a b" }), /no access token in the expected shape/, DropboxApiError],
      [json(200, { access_token: "a".repeat(4097) }), /no access token in the expected shape/, DropboxApiError],
    ];
    for (const [response, message, kind] of cases) {
      const { fetch } = scripted(() => response);
      const error = await failure(client(fetch).account());
      expect(error, message.source).toBeInstanceOf(kind);
      expect(error.message).toMatch(message);
      expect(error.message).not.toContain(REFRESH);
      expect(error.message).not.toContain(APP_SECRET);
    }
    const { fetch } = scripted(() => json(200, { access_token: "a".repeat(4096), expires_in: 14400 }), ACCOUNT_OK);
    await expect(client(fetch).account()).resolves.toMatchObject({ accountId: ACCOUNT });
  });

  it("asks for a new token on every request when Dropbox gives no lifetime that reads", async () => {
    // 1e400 parses as Infinity.
    const list = () => json(200, { entries: [], cursor: "c1", has_more: false });
    const { fetch, sent } = scripted(() => TOKEN_OK({ expires_in: "14400" }), ACCOUNT_OK, () => new Response(`{"access_token":"sl.u.${"t".repeat(40)}","expires_in":1e400}`, { status: 200 }), list, () => TOKEN_OK({ expires_in: -1 }), list, () => TOKEN_OK({ expires_in: 14400 }), list, list);
    const c = client(fetch);
    await c.listFolder("/Accounting", true);
    await c.listFolderContinue("c1");
    await c.listFolderContinue("c1");
    await c.listFolderContinue("c1");
    expect(sent.filter((s) => s.url.endsWith("/oauth2/token"))).toHaveLength(4);
  });

  it("signs in again once on a 401, then gives up", async () => {
    const { fetch, sent } = scripted(TOKEN_OK, () => json(401, { error_summary: "expired_access_token/.." }), TOKEN_OK, ACCOUNT_OK);
    await expect(client(fetch).account()).resolves.toMatchObject({ accountId: ACCOUNT });
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual(["/oauth2/token", "/2/users/get_current_account", "/oauth2/token", "/2/users/get_current_account"]);
    const twice = scripted(TOKEN_OK, () => json(401, { error_summary: "expired_access_token/.." }), TOKEN_OK, () => json(401, { error_summary: "invalid_access_token/.." }));
    const error = await failure(client(twice.fetch).account());
    expect(error).toBeInstanceOf(DropboxApiError);
    expect(error.message).toMatch(/turned down the token twice/);
    expect((error as DropboxApiError).status).toBe(401);
    expect((error as DropboxApiError).summary).toBe("invalid_access_token");
  });

  it("waits out a 429 for Retry-After seconds, up to a minute, then leaves it to runSync", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const throttled = (after?: string) => () => json(429, { error_summary: "too_many_requests/.." }, after === undefined ? {} : { "Retry-After": after });
    const { fetch } = scripted(TOKEN_OK, throttled("3"), throttled("600"), throttled("0"), ACCOUNT_OK);
    await client(fetch, { sleep }).account();
    expect(waits).toEqual([3000, 60_000, 1000]);
    const backoff: number[] = [];
    const { fetch: f2 } = scripted(TOKEN_OK, throttled(), throttled("soon"), throttled(" 2 "), throttled("1"));
    const error = await failure(client(f2, { sleep: async (ms) => void backoff.push(ms) }).account());
    expect(backoff).toEqual([1000, 2000, 2000]);
    expect(error.message).toMatch(/HTTP 429/);
    expect((error as DropboxApiError).summary).toBe("too_many_requests");
    const none = scripted(TOKEN_OK, throttled("1"));
    await expect(client(none.fetch, { rateLimitRetries: 0 }).account()).rejects.toThrow(/HTTP 429/);
  });

  it("explains a folder it can't read, a reset, and an answer that isn't JSON", async () => {
    const at = (response: () => Response) => scripted(TOKEN_OK, ACCOUNT_OK, response).fetch;
    const missing = await failure(client(at(() => json(409, { error_summary: "path/not_found/..", error: { ".tag": "path" } }))).listFolder("/Accounting", true));
    expect(missing.message).toBe("Dropbox couldn't read the folder (path/not_found): check DROPBOX_FOLDER, and that the folder is in the approving user's Dropbox");
    expect((missing as DropboxApiError).status).toBe(409);
    const odd = await failure(client(at(() => json(409, { error_summary: "<script>" }))).listFolder("/Accounting", true));
    expect(odd.message).toBe("Dropbox couldn't read the folder: check DROPBOX_FOLDER, and that the folder is in the approving user's Dropbox");
    expect((odd as DropboxApiError).summary).toBeUndefined();
    const reset = await failure(client(at(() => json(409, { error_summary: "reset/.." }))).listFolderContinue("c1"));
    // Only a 409 is a reset.
    const notReset = await failure(client(at(() => json(400, { error_summary: "reset/.." }))).listFolderContinue("c1"));
    expect(notReset).not.toBeInstanceOf(DropboxResetError);
    expect(notReset.message).toBe("Dropbox answered HTTP 400 for the folder's changes");
    const partial = await failure(client(at(() => json(206, { entries: [], cursor: "c1", has_more: false }))).listFolder("/Accounting", true));
    expect(partial.message).toBe("Dropbox answered HTTP 206 for the folder");
    const list = await failure(client(at(() => json(200, [1]))).listFolder("/Accounting", true));
    expect(list.message).toBe("Dropbox answered the folder with a body that isn't a JSON object");
    expect(reset).toBeInstanceOf(DropboxResetError);
    expect(reset.message).toBe("Dropbox asked for the folder to be listed again");
    const forbidden = await failure(client(at(() => json(403, { error_summary: "missing_scope/.." }))).listFolder("/Accounting", true));
    expect(forbidden.message).toBe("Dropbox's app isn't allowed to read the folder");
    expect((forbidden as DropboxApiError).summary).toBe("missing_scope");
    const busy = await failure(client(at(() => new Response("busy", { status: 503 }))).listFolder("/Accounting", true));
    expect(busy.message).toBe("Dropbox answered HTTP 503 for the folder");
    const html = await failure(client(at(() => new Response("<html>", { status: 200 }))).listFolder("/Accounting", true));
    expect(html.message).toBe("Dropbox answered the folder with a body that isn't a JSON object");
  });

  it("checks each listing page's shape", async () => {
    const page = (body: unknown) => scripted(TOKEN_OK, ACCOUNT_OK, () => json(200, body)).fetch;
    await expect(client(page({ cursor: "c1", has_more: false })).listFolder("/Accounting", true)).rejects.toThrow("Dropbox answered the folder without the entries list");
    await expect(client(page({ entries: [], has_more: false })).listFolder("/Accounting", true)).rejects.toThrow("Dropbox sent a cursor for the folder that isn't in the expected shape");
    await expect(client(page({ entries: [], cursor: "a b", has_more: false })).listFolder("/Accounting", true)).rejects.toThrow(/cursor/);
    await expect(client(page({ entries: [], cursor: "a.b", has_more: false })).listFolder("/Accounting", true)).rejects.toThrow(/cursor/);
    await expect(client(page({ entries: [], cursor: "a".repeat(16385), has_more: false })).listFolder("/Accounting", true)).rejects.toThrow(/cursor/);
    await expect(client(page({ entries: [], cursor: "c1", has_more: "no" })).listFolderContinue("c0")).rejects.toThrow("Dropbox answered the folder's changes without has_more");
    const ok = await client(page({ entries: [{ ".tag": "file" }, 5, null, ["x"]], cursor: `AAG-_+/=${"a".repeat(16376)}`, has_more: true })).listFolder("/Accounting", true);
    expect(ok).toEqual({ entries: [{ ".tag": "file" }], cursor: `AAG-_+/=${"a".repeat(16376)}`, hasMore: true });
    // A cursor that doesn't read is never sent.
    const { fetch, sent } = scripted();
    await expect(client(fetch).listFolderContinue("a b")).rejects.toThrow("the listing cursor isn't in the expected shape");
    await expect(client(fetch).listFolder("/", true)).rejects.toThrow(DropboxConfigError);
    expect(sent).toEqual([]);
  });

  it("checks the account's id and root", async () => {
    const acct = (body: unknown) => scripted(TOKEN_OK, () => json(200, body)).fetch;
    await expect(client(acct({ account_id: "user1", root_info: { root_namespace_id: "1" } })).account()).rejects.toThrow("Dropbox's account had no account id in the expected shape");
    await expect(client(acct({ account_id: ACCOUNT })).account()).rejects.toThrow("Dropbox's account had no root namespace in the expected shape");
    await expect(client(acct({ account_id: ACCOUNT, root_info: { root_namespace_id: 1 } })).account()).rejects.toThrow(/root namespace/);
    await expect(client(acct({ account_id: ACCOUNT, root_info: { root_namespace_id: "1a" } })).account()).rejects.toThrow(/root namespace/);
    await expect(client(acct({ account_id: ACCOUNT, root_info: { root_namespace_id: "1".repeat(21) } })).account()).rejects.toThrow(/root namespace/);
    await expect(client(acct({ account_id: ACCOUNT, root_info: [] })).account()).rejects.toThrow(/root namespace/);
    await expect(client(acct({ account_id: `dbid:${"a".repeat(101)}`, root_info: { root_namespace_id: "1" } })).account()).rejects.toThrow(/account id/);
  });

  it("sends only reads, with the account's root namespace, against the mocked account", async () => {
    const mock = dropboxDocMock(account({ rootNamespaceId: "7788990011" }));
    const c = client(mock.fetch);
    const page = await c.listFolder("/Accounting", true);
    expect(page.entries.map((e) => e.path_display)).toContain("/Accounting/Invoices/INV-1001.pdf");
    await c.listFolderContinue(page.cursor);
    expect(await c.account()).toEqual({ accountId: ACCOUNT, rootNamespaceId: "7788990011" });
    expect(reads(mock)).toEqual(["POST https://api.dropboxapi.com/oauth2/token", "POST https://api.dropboxapi.com/2/users/get_current_account", "POST https://api.dropboxapi.com/2/files/list_folder", "POST https://api.dropboxapi.com/2/files/list_folder/continue"]);
    // A root the mock doesn't know is refused.
    const other = dropboxDocMock(account({ rootNamespaceId: "1" }));
    const wrong = client(async (input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.has("dropbox-api-path-root")) headers.set("dropbox-api-path-root", '{".tag":"root","root":"2"}');
      return other.fetch(input, { ...init, headers });
    });
    await expect(wrong.listFolder("/Accounting", true)).rejects.toThrow(/HTTP 422/);
    expect(mock.signIns).toBe(1);
  });

  it("asks for each listing page in Dropbox's shape", async () => {
    const { fetch, sent } = scripted(TOKEN_OK, ACCOUNT_OK, () => json(200, { entries: [], cursor: "c1", has_more: false }), () => json(200, { entries: [], cursor: "c2", has_more: false }));
    const c = client(fetch);
    await c.listFolder(" /Accounting ", false);
    await c.listFolderContinue("c1");
    expect(JSON.parse(String(sent[1]!.init.body))).toBeNull();
    expect(new Headers(sent[1]!.init.headers).has("dropbox-api-path-root")).toBe(false);
    expect(JSON.parse(String(sent[2]!.init.body))).toEqual({ path: "/Accounting", recursive: false, include_deleted: false, include_mounted_folders: true, include_non_downloadable_files: true, limit: DROPBOX_PAGE_SIZE });
    expect(JSON.parse(String(sent[3]!.init.body))).toEqual({ cursor: "c1" });
    for (const s of sent.slice(1)) {
      const h = new Headers(s.init.headers);
      expect(s.init.method).toBe("POST");
      expect(h.get("content-type")).toBe("application/json");
      expect(h.get("authorization")).toBe(`Bearer sl.u.${"t".repeat(40)}`);
    }
    expect(new Headers(sent[2]!.init.headers).get("dropbox-api-path-root")).toBe('{".tag":"root","root":"3235641"}');
    expect(DROPBOX_PAGE_SIZE).toBe(500);
  });

  it("downloads a file by id with its metadata, only when made for file imports", async () => {
    const mock = dropboxDocMock(account());
    const page = await client(mock.fetch).listFolder("/Accounting/Statements", false);
    const id = String(page.entries.find((e) => e.name === "2026-10 Bank.csv")!.id);
    await expect(client(mock.fetch).download(id)).rejects.toThrow(DropboxConfigError);
    const c = client(mock.fetch, { contents: true });
    const file = await c.download(id);
    expect(new TextDecoder().decode(file.bytes)).toBe("date,amount\n2026-10-01,100.00\n");
    expect(file.metadata).toMatchObject({ id, name: "2026-10 Bank.csv", content_hash: dropboxContentHash(file.bytes) });
    const byPath = await c.download("/Accounting/Statements/2026-10 Bank.csv");
    expect(byPath.metadata.id).toBe(id);
    expect(reads(mock).filter((r) => r.includes("content."))).toEqual(["POST https://content.dropboxapi.com/2/files/download", "POST https://content.dropboxapi.com/2/files/download"]);
    for (const bad of ["Accounting/x", "id:a b", `/${"a".repeat(1100)}`, "/a/../b"]) await expect(c.download(bad), bad).rejects.toThrow("a download names a file by its id or its path");
    await expect(c.download("/Accounting/Statements")).rejects.toThrow(/path\/not_file/);
    await expect(c.download("/Accounting/Price list.gdoc")).rejects.toThrow(/unsupported_file/);
  });

  it("names a file with non-ASCII characters in an ASCII header", async () => {
    const mock = dropboxDocMock(account({ files: [...FILES, { path: "/Accounting/Café ☃.csv", content: "a,b\n", serverModified: "2026-10-07T09:00:00Z" }] }));
    const file = await client(mock.fetch, { contents: true }).download("/Accounting/Café ☃.csv");
    expect(file.metadata.name).toBe("Café ☃.csv");
  });

  it("won't read a file over 25 MB, or a download without metadata", async () => {
    const big = (headers: Record<string, string>, body: BodyInit = "x") => scripted(TOKEN_OK, ACCOUNT_OK, () => new Response(body, { status: 200, headers })).fetch;
    const meta = { "dropbox-api-result": JSON.stringify({ name: "a.csv" }) };
    await expect(client(big({ ...meta, "content-length": String(DROPBOX_MAX_DOWNLOAD_BYTES + 1) }), { contents: true }).download("id:abc")).rejects.toThrow(`the file is larger than ${DROPBOX_MAX_DOWNLOAD_BYTES} bytes`);
    await expect(client(big(meta, new Uint8Array(DROPBOX_MAX_DOWNLOAD_BYTES + 1)), { contents: true }).download("id:abc")).rejects.toThrow(/larger than/);
    await expect(client(big(meta, new Uint8Array(DROPBOX_MAX_DOWNLOAD_BYTES)), { contents: true }).download("id:abc")).resolves.toMatchObject({ metadata: { name: "a.csv" } });
    await expect(client(big({ ...meta, "content-length": String(DROPBOX_MAX_DOWNLOAD_BYTES) }), { contents: true }).download("id:abc")).resolves.toBeTruthy();
    await expect(client(big({}), { contents: true }).download("id:abc")).rejects.toThrow("Dropbox's download had no file metadata");
    await expect(client(big({ "dropbox-api-result": "{" }), { contents: true }).download("id:abc")).rejects.toThrow(/no file metadata/);
    await expect(client(big({ "dropbox-api-result": "[1]" }), { contents: true }).download("id:abc")).rejects.toThrow(/no file metadata/);
    expect(DROPBOX_MAX_DOWNLOAD_BYTES).toBe(25 * 1024 * 1024);
  });

  it("sends each download as Dropbox asks, with no body", async () => {
    const { fetch, sent } = scripted(TOKEN_OK, ACCOUNT_OK, () => new Response("a", { status: 200, headers: { "dropbox-api-result": "{}" } }));
    await client(fetch, { contents: true }).download("/Café");
    const h = new Headers(sent[2]!.init.headers);
    expect(sent[2]!.url).toBe("https://content.dropboxapi.com/2/files/download");
    expect(sent[2]!.init.method).toBe("POST");
    expect(sent[2]!.init.body).toBeUndefined();
    expect(h.get("dropbox-api-arg")).toBe('{"path":"/Caf\\u00e9"}');
    expect(h.get("dropbox-api-path-root")).toBe('{".tag":"root","root":"3235641"}');
    expect(h.get("authorization")).toBe(`Bearer sl.u.${"t".repeat(40)}`);
  });
});

describe("Dropbox content hashes", () => {
  it("hashes each 4 MB block, then the block hashes", () => {
    const block = 4 * 1024 * 1024;
    const data = new Uint8Array(block + 10).map((_, i) => i % 251);
    const inner = [data.subarray(0, block), data.subarray(block)].map((b) => createHash("sha256").update(b).digest());
    expect(dropboxContentHash(data)).toBe(createHash("sha256").update(Buffer.concat(inner)).digest("hex"));
    expect(dropboxContentHash(new Uint8Array(0))).toBe(createHash("sha256").digest("hex"));
    const one = new Uint8Array(block).fill(7);
    expect(dropboxContentHash(one)).toBe(createHash("sha256").update(createHash("sha256").update(one).digest()).digest("hex"));
  });
});

describe("the Dropbox checkpoint", () => {
  const ok: DropboxCursor = { pass: "historical", folder: "/accounting", phase: "listing", list: "AAGc1", done: false, since: SINCE };
  it("reads back what the connector wrote, and nothing else", () => {
    expect(parseDropboxCursor(null)).toBeNull();
    expect(parseDropboxCursor(JSON.stringify({ ...ok, extra: 1 }))).toEqual(ok);
    expect(parseDropboxCursor(JSON.stringify({ ...ok, list: null }))).toEqual({ ...ok, list: null });
    expect(parseDropboxCursor(JSON.stringify({ ...ok, phase: "changes", done: true, pass: "incremental" }))).toEqual({ ...ok, phase: "changes", done: true, pass: "incremental" });
    const bad: unknown[] = [
      "not json",
      "null",
      "5",
      { ...ok, pass: "other" },
      { ...ok, folder: "/Accounting" },
      { ...ok, folder: "/" },
      { ...ok, folder: "accounting" },
      { ...ok, folder: 5 },
      { ...ok, folder: " /accounting" },
      { ...ok, phase: "done" },
      { ...ok, list: "a b" },
      { ...ok, list: 5 },
      { ...ok, list: "a".repeat(16385) },
      { ...ok, done: "no" },
      { ...ok, list: null, done: true },
      { ...ok, list: null, phase: "changes" },
      { ...ok, since: "2021-11-09" },
      { ...ok, since: "2021-02-30T12:00:00.000Z" },
      { ...ok, since: 5 },
    ];
    for (const raw of bad) expect(() => parseDropboxCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("Dropbox checkpoint is not in the expected shape");
  });
});

describe("the Dropbox connector", () => {
  it("imports, replays, resumes and retries the mocked folder", async () => {
    // Three folders and four files in the window; old.xlsx is too old, broken.txt is dead-lettered.
    const result = await checkConnectorSync({ makeConnector: () => connector(account({ pageCap: 2 })).c, expected: { ingested: 7, deadLettered: 1 } });
    expect([result.full.ingested, result.full.deadLettered, result.full.batches]).toEqual([7, 1, 5]);
  });

  it("lists the folder and everything below it, keeping five years of files, and nothing outside it", async () => {
    const { c, mock } = connector(account());
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(names(out)).toEqual(["Appraisals", "Ring 4421.jpg", "broken.txt", "Invoices", "INV-1001.pdf", "Price list.gdoc", "Statements", "2026-10 Bank.csv"]);
    expect(out.flatMap((b) => b.events).find((e) => e.payload.name === "Price list.gdoc")!.payload.downloadable).toBe(false);
    expect(cursorOf(out)).toMatchObject({ pass: "historical", folder: "/accounting", phase: "changes", done: true, since: SINCE });
    expect(reads(mock)).toEqual(["POST https://api.dropboxapi.com/oauth2/token", "POST https://api.dropboxapi.com/2/users/get_current_account", "POST https://api.dropboxapi.com/2/files/list_folder"]);
    expect(JSON.stringify(out)).not.toMatch(/private|Other|Accounting\/|date,amount/);
    assertSynthetic(out);
  });

  it("checkpoints Dropbox's cursor on every page, and a finished import reads nothing", async () => {
    const { c, mock } = connector(account({ pageCap: 3 }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    // The old file is left out of page two.
    expect(out.map((b) => b.events.length)).toEqual([3, 2, 3]);
    expect(out.map((_, i) => [cursorOf(out, i).phase, cursorOf(out, i).done])).toEqual([
      ["listing", false],
      ["listing", false],
      ["changes", true],
    ]);
    const again = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }));
    expect(again).toEqual([]);
    // Resumed from page two, it asks Dropbox for the page after.
    const calls = mock.fetch.calls.length;
    const resumed = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: out[1]!.cursor }));
    expect(names(resumed)).toEqual(names(out).slice(5));
    expect(mock.fetch.calls.slice(calls).map((x) => new URL(x.url).pathname)).toEqual(["/2/files/list_folder/continue"]);
  });

  it("reads only what changed since the last sync, deletions and moves included", async () => {
    const { c, mock } = connector(account());
    const first = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    mock.put({ path: "/Accounting/Statements/2026-11 Bank.csv", content: "date,amount\n", serverModified: "2026-11-02T09:00:00Z" });
    mock.put({ path: "/Accounting/Invoices/INV-1001.pdf", content: "%PDF-1.4 paid", serverModified: "2026-11-03T09:00:00Z" });
    mock.remove("/Accounting/Appraisals/Ring 4421.jpg");
    mock.put({ path: "/Other/elsewhere.txt", content: "x", serverModified: "2026-11-03T09:00:00Z" });
    const calls = mock.fetch.calls.length;
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: first.at(-1)!.cursor }));
    expect(names(out)).toEqual(["2026-11 Bank.csv", "INV-1001.pdf", "-Ring 4421.jpg"]);
    expect(mock.fetch.calls.slice(calls).map((x) => new URL(x.url).pathname)).toEqual(["/2/files/list_folder/continue"]);
    const removed = out[0]!.events[2]!;
    const original = first.flatMap((b) => b.events).find((e) => e.payload.name === "Ring 4421.jpg")!;
    expect(removed.payload.pathId).toBe(original.payload.pathId);
    expect(cursorOf(out)).toMatchObject({ pass: "incremental", phase: "changes", done: true });
    // Nothing changed: one call, no events.
    const quiet = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }));
    expect(quiet.map((b) => b.events.length)).toEqual([0]);
    // A change older than five years is still kept, as it changed since the last sync.
    mock.put({ path: "/Accounting/restored.xlsx", content: "r", serverModified: "2019-01-01T00:00:00Z" });
    const restored = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: quiet.at(-1)!.cursor }));
    expect(names(restored)).toEqual(["restored.xlsx"]);
  });

  it("stores a replayed change feed once", async () => {
    const t = testPipeline();
    const { c, mock } = connector(account());
    await runSync({ connector: c, mode: "historical", pipeline: t.pipeline, memory: t.memory, organizationId: TEST_ORG, sleep: noSleep });
    // The first incremental sync keeps its own checkpoint, so it lists the folder once: all duplicates.
    const baseline = await runSync({ connector: c, mode: "incremental", pipeline: t.pipeline, memory: t.memory, organizationId: TEST_ORG, sleep: noSleep });
    expect([baseline.ingested, baseline.duplicates, baseline.deadLettered]).toEqual([0, 7, 1]);
    mock.remove("/Accounting/Invoices/INV-1001.pdf");
    const first = await runSync({ connector: c, mode: "incremental", pipeline: t.pipeline, memory: t.memory, organizationId: TEST_ORG, sleep: noSleep });
    expect([first.ingested, first.duplicates]).toEqual([1, 0]);
    const nothing = await runSync({ connector: c, mode: "incremental", pipeline: t.pipeline, memory: t.memory, organizationId: TEST_ORG, sleep: noSleep });
    expect([nothing.ingested, nothing.duplicates]).toEqual([0, 0]);
  });

  it("goes on from an unfinished listing when an incremental sync runs first", async () => {
    const { c } = connector(account({ pageCap: 3 }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const rest = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: out[0]!.cursor }));
    expect(names(rest)).toEqual(names(out).slice(3));
    expect(cursorOf(rest, 0)).toMatchObject({ pass: "incremental", phase: "listing", since: SINCE });
    expect(cursorOf(rest)).toMatchObject({ pass: "incremental", phase: "changes", done: true });
  });

  it("lists the folder when an incremental sync has no checkpoint for it", async () => {
    const { c, mock } = connector(account());
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(names(out)).toHaveLength(8);
    expect(cursorOf(out)).toMatchObject({ pass: "incremental", phase: "changes", done: true, since: SINCE });
    const other = await batches(connector(account(), { folder: "/Other" }).c.incrementalSync({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }));
    expect(names(other)).toEqual(["private.txt"]);
    expect(mock.fetch.calls.filter((x) => x.url.endsWith("/list_folder"))).toHaveLength(1);
  });

  it("starts over when the folder setting changes, or for a new import after incremental syncs", async () => {
    const { c } = connector(account());
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const moved = connector(account(), { folder: "/accounting/Invoices" }).c;
    const fresh = await batches(moved.historicalImport({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }));
    expect(names(fresh)).toEqual(["INV-1001.pdf"]);
    expect(cursorOf(fresh).folder).toBe("/accounting/invoices");
    const inc = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }));
    const again = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: inc.at(-1)!.cursor }));
    expect(names(again)).toHaveLength(8);
    expect(cursorOf(again).pass).toBe("historical");
    // The same folder written another way is the same folder.
    const same = connector(account(), { folder: "/ACCOUNTING" }).c;
    expect(await batches(same.historicalImport({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }))).toEqual([]);
  });

  it("lists the folder again when Dropbox resets the cursor, up to three times in one sync", async () => {
    const { c, mock } = connector(account());
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    mock.resetCursors();
    const relisted = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }));
    expect(names(relisted)).toEqual(names(out));
    expect(cursorOf(relisted)).toMatchObject({ pass: "incremental", phase: "changes", done: true, since: SINCE });

    let resets = 0;
    const always: DropboxClient = {
      account: async () => ({ accountId: ACCOUNT, rootNamespaceId: "1" }),
      listFolder: async () => ({ entries: [], cursor: "c1", hasMore: true }),
      listFolderContinue: async () => {
        resets++;
        throw new DropboxResetError();
      },
      download: async () => {
        throw new Error("no");
      },
    };
    const stuck = dropboxConnector({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: REFRESH, folder: "/Accounting", client: always, now: () => NOW });
    await expect(batches(stuck.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow(DropboxResetError);
    expect(resets).toBe(4);
    // Any other error goes straight to runSync.
    let calls = 0;
    const failing: DropboxClient = { ...always, listFolderContinue: async () => (calls++, Promise.reject(new DropboxApiError("busy", 503))) };
    const broken = dropboxConnector({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: REFRESH, folder: "/Accounting", client: failing, now: () => NOW });
    await expect(batches(broken.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...cursorOf(out), list: "c9" }) }))).rejects.toThrow("busy");
    expect(calls).toBe(1);
  });

  it("names the page each deletion came from, and the first page by the folder", async () => {
    const pages: DropboxListPage[] = [
      { entries: [{ ".tag": "deleted", name: "a.pdf", path_lower: "/accounting/a.pdf" }], cursor: "c2", hasMore: true },
      { entries: [{ ".tag": "deleted", name: "a.pdf", path_lower: "/accounting/a.pdf" }], cursor: "c3", hasMore: false },
    ];
    const fake: DropboxClient = {
      account: async () => ({ accountId: ACCOUNT, rootNamespaceId: "1" }),
      listFolder: async () => pages[0]!,
      listFolderContinue: async () => pages[1]!,
      download: async () => Promise.reject(new Error("no")),
    };
    const c = dropboxConnector({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: REFRESH, folder: "/Accounting", client: fake, now: () => NOW });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const keys = out.flatMap((b) => b.events).map((e) => e.idempotencyKey);
    const page = (p: string) => createHash("sha256").update(p).digest("hex").slice(0, 16);
    expect(keys.map((k) => k.split(":").at(-1))).toEqual([page("list:/accounting"), page("c2")]);
  });

  it("is prompted to sync by a webhook naming its account", async () => {
    const { c, mock } = connector(account());
    expect(await c.webhookPromptsSync({ list_folder: { accounts: [ACCOUNT] }, delta: { users: [12345] } })).toBe(true);
    expect(await c.webhookPromptsSync({ list_folder: { accounts: ["dbid:someone-else"] } })).toBe(false);
    expect(mock.fetch.calls.filter((x) => x.url.endsWith("/get_current_account"))).toHaveLength(1);
    expect(c.handleWebhook).toBeUndefined();
  });

  it("checks its settings", () => {
    const base = { appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: REFRESH, folder: "/Accounting" };
    expect(() => dropboxConnector({ ...base, folder: "/" })).toThrow(/DROPBOX_FOLDER/);
    expect(() => dropboxConnector({ ...base, fileNames: "hide" as "keep" })).toThrow("DROPBOX_FILE_NAMES is keep or drop");
    expect(() => dropboxConnector({ ...base, historyYears: 0 })).toThrow("historyYears must be a positive whole number");
    expect(() => dropboxConnector({ ...base, historyYears: 1.5 })).toThrow(/historyYears/);
    expect(() => dropboxConnector({ ...base, appKey: "x" })).toThrow(/DROPBOX_APP_KEY/);
    expect(() => dropboxConnector({ ...base, historyYears: 1, fileNames: "drop" })).not.toThrow();
  });

  it("keeps the history it's told to, and drops names when told to", async () => {
    const { c } = connector(account(), { fileNames: "drop" });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(out.flatMap((b) => b.events).every((e) => e.payload.nameWithheld === true && !("name" in e.payload))).toBe(true);
    const mock = dropboxDocMock(account());
    const ten = dropboxConnector({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: REFRESH, folder: "/Accounting", fetch: mock.fetch, now: () => NOW, historyYears: 10 });
    const all = await batches(ten.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(names(all)).toContain("old.xlsx");
    expect(cursorOf(all).since).toBe("2016-11-09T12:00:00.000Z");
  });

  it("waits out Dropbox's throttling during a sync", async () => {
    const { c } = connector(account({ rateLimited: 2, retryAfter: "2" }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(names(out)).toHaveLength(8);
  });

  it("declares saving a report, and turns it down while writes are off", async () => {
    const { c } = connector(account());
    expect(c.writes).toBe(DROPBOX_WRITES);
    expect(DROPBOX_WRITES).toEqual([{ integration: "dropbox", name: "save_report", description: "Save a generated report to a folder" }]);
    const audit = await assertWritesRefused(c);
    expect(audit.map((entry) => [entry.action, entry.outcome])).toEqual([["save_report", "refused"]]);
    expect(c.source).toBe("dropbox");
  });
});

describe("the Dropbox file source", () => {
  const source = (data = account(), folder = "/Accounting") => {
    const mock = dropboxDocMock(data);
    return { mock, files: dropboxFileSource({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: REFRESH, folder, fetch: mock.fetch, sleep: noSleep }) };
  };

  it("lists the files directly in the folder that can be downloaded, with their times", async () => {
    // Not the subfolders, the Google Doc it can't download, or the file whose time doesn't read.
    expect(await source().files.list()).toEqual([{ name: "old.xlsx", modifiedAt: "2019-05-01T09:00:00.000Z" }]);
    const statements = source(account(), "/Accounting/Statements").files;
    expect(await statements.list()).toEqual([{ name: "2026-10 Bank.csv", modifiedAt: "2026-10-02T09:00:00.000Z" }]);
  });

  it("asks Dropbox for read scopes, contents included, and reads text and bytes", async () => {
    const { files, mock } = source(account(), "/Accounting/Statements");
    expect(await files.read("2026-10 Bank.csv")).toBe("date,amount\n2026-10-01,100.00\n");
    expect(new TextDecoder().decode(await files.readBytes("2026-10 Bank.csv"))).toBe("date,amount\n2026-10-01,100.00\n");
    expect(reads(mock)).toEqual([
      "POST https://api.dropboxapi.com/oauth2/token",
      "POST https://api.dropboxapi.com/2/users/get_current_account",
      "POST https://api.dropboxapi.com/2/files/list_folder",
      "POST https://content.dropboxapi.com/2/files/download",
      "POST https://content.dropboxapi.com/2/files/download",
    ]);
    // Without files.content.read on the app, the refresh is turned down.
    const noContent = source(account({ appScopes: ["account_info.read", "files.metadata.read"] }), "/Accounting/Statements").files;
    await expect(noContent.list()).rejects.toThrow(/files.content.read: turn them on/);
  });

  it("reads only files it listed, and checks each against its content hash", async () => {
    const { files } = source(account(), "/Accounting/Statements");
    await expect(files.read("../Invoices/INV-1001.pdf")).rejects.toThrow("no file named ../Invoices/INV-1001.pdf in the Dropbox folder");
    await expect(files.read("missing.csv")).rejects.toThrow(/no file named missing.csv/);
    const asked: string[] = [];
    const tampered: DropboxClient = {
      account: async () => ({ accountId: ACCOUNT, rootNamespaceId: "1" }),
      listFolder: async () => ({ entries: [{ ".tag": "file", name: "a.csv", id: "id:abc", server_modified: "2026-10-01T00:00:00Z" }], cursor: "c1", hasMore: false }),
      listFolderContinue: async () => Promise.reject(new Error("no")),
      download: async (path) => (asked.push(path), { bytes: new TextEncoder().encode("changed"), metadata: { content_hash: dropboxContentHash(new TextEncoder().encode("original")) } }),
    };
    const t = dropboxFileSource({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: REFRESH, folder: "/Accounting", client: tampered });
    await expect(t.read("a.csv")).rejects.toThrow("Dropbox's download of a.csv doesn't match its content hash");
    // Files are downloaded by id, so a rename between listing and reading can't swap them.
    expect(asked).toEqual(["id:abc"]);
    const noHash = dropboxFileSource({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: REFRESH, folder: "/Accounting", client: { ...tampered, download: async () => ({ bytes: new TextEncoder().encode("ok"), metadata: {} }) } });
    await expect(noHash.read("a.csv")).resolves.toBe("ok");
  });

  it("skips entries it can't read by name, and pages through a big folder", async () => {
    const entry = (name: unknown, extra: Record<string, unknown> = {}) => ({ ".tag": "file", name, id: "id:abc", server_modified: "2026-10-01T00:00:00Z", ...extra });
    const listed: DropboxListPage[] = [
      { entries: [entry("a.csv"), entry(".hidden.csv"), entry("x/y.csv"), entry("n".repeat(256)), entry(5), entry("t.csv", { server_modified: "bad" }), entry("g.gdoc", { is_downloadable: false }), entry("f", { ".tag": "folder" }), entry("i.csv", { id: 5 })], cursor: "c1", hasMore: true },
      { entries: [entry("b.csv"), entry("n".repeat(255))], cursor: "c2", hasMore: false },
    ];
    const cursors: string[] = [];
    const fake: DropboxClient = {
      account: async () => ({ accountId: ACCOUNT, rootNamespaceId: "1" }),
      listFolder: async (path, recursive) => (expect([path, recursive]).toEqual(["/Accounting", false]), listed[0]!),
      listFolderContinue: async (c) => (cursors.push(c), listed[1]!),
      download: async () => Promise.reject(new Error("no")),
    };
    const files = dropboxFileSource({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: REFRESH, folder: "/Accounting", client: fake });
    expect((await files.list()).map((f) => f.name)).toEqual(["a.csv", "b.csv", "n".repeat(255)]);
    expect(cursors).toEqual(["c1"]);
    const endless: DropboxClient = { ...fake, listFolderContinue: async () => ({ entries: [], cursor: "c1", hasMore: true }) };
    const big = dropboxFileSource({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: REFRESH, folder: "/Accounting", client: endless });
    await expect(big.list()).rejects.toThrow("the folder has more files than one import reads");
    expect(() => dropboxFileSource({ appKey: APP_KEY, appSecret: APP_SECRET, refreshToken: REFRESH, folder: "Accounting", client: fake })).toThrow(/DROPBOX_FOLDER/);
  });
});

describe("Dropbox webhooks", () => {
  const body = JSON.stringify({ list_folder: { accounts: [ACCOUNT] }, delta: { users: [12345] } });
  const sign = (text: string, secret = APP_SECRET) => createHmac("sha256", secret).update(text).digest("hex");

  it("echoes the challenge that checks the webhook address, as plain text", () => {
    expect(dropboxWebhookChallenge("abc-123_XYZ")).toEqual({ status: 200, body: "abc-123_XYZ", headers: { "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" } });
    expect(dropboxWebhookChallenge("a".repeat(200)).status).toBe(200);
    for (const bad of ["", "<script>", "a b", "a".repeat(201), null, undefined]) expect(dropboxWebhookChallenge(bad), String(bad)).toEqual({ status: 400, body: "", headers: { "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" } });
  });

  it("trusts a notification signed with the app secret, and nothing else", () => {
    expect(verifyDropboxWebhook(APP_SECRET, body, sign(body))).toEqual({ ok: true });
    expect(verifyDropboxWebhook(` ${APP_SECRET} `, Buffer.from(body), ` ${sign(body).toUpperCase()} `)).toEqual({ ok: true });
    expect(verifyDropboxWebhook(APP_SECRET, `${body} `, sign(body))).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyDropboxWebhook("t".repeat(15), body, sign(body))).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyDropboxWebhook(APP_SECRET, body, sign(body).slice(1))).toEqual({ ok: false, reason: "malformed" });
    expect(verifyDropboxWebhook(APP_SECRET, body, `${sign(body)}0`)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyDropboxWebhook(APP_SECRET, body, "z".repeat(64))).toEqual({ ok: false, reason: "malformed" });
    expect(verifyDropboxWebhook(APP_SECRET, body, Buffer.from(sign(body), "hex").toString("base64"))).toEqual({ ok: false, reason: "malformed" });
    expect(verifyDropboxWebhook(APP_SECRET, body, "")).toEqual({ ok: false, reason: "missing" });
    expect(verifyDropboxWebhook(APP_SECRET, body, null)).toEqual({ ok: false, reason: "missing" });
    expect(verifyDropboxWebhook("  ", body, sign(body, "  "))).toEqual({ ok: false, reason: "missing" });
    expect(verifyDropboxWebhook(undefined as unknown as string, body, sign(body))).toEqual({ ok: false, reason: "missing" });
  });

  it("says whether a notification names the account", () => {
    expect(dropboxWebhookNames(JSON.parse(body), ACCOUNT)).toBe(true);
    expect(dropboxWebhookNames({ list_folder: { accounts: ["dbid:other", ACCOUNT] } }, ACCOUNT)).toBe(true);
    expect(dropboxWebhookNames({ list_folder: { accounts: ["dbid:other"] } }, ACCOUNT)).toBe(false);
    expect(dropboxWebhookNames({ delta: { users: [12345] } }, ACCOUNT)).toBe(false);
    expect(dropboxWebhookNames({ list_folder: { accounts: ACCOUNT } }, ACCOUNT)).toBe(false);
    expect(dropboxWebhookNames({ list_folder: null }, ACCOUNT)).toBe(false);
    expect(dropboxWebhookNames({ list_folder: { accounts: [...Array(10_000).fill("dbid:x"), ACCOUNT] } }, ACCOUNT)).toBe(false);
    expect(dropboxWebhookNames({ list_folder: { accounts: [...Array(9_999).fill("dbid:x"), ACCOUNT] } }, ACCOUNT)).toBe(true);
    expect(dropboxWebhookNames({ list_folder: { accounts: [""] } }, "")).toBe(false);
    expect(dropboxWebhookNames(null, ACCOUNT)).toBe(false);
    expect(dropboxWebhookNames("x", ACCOUNT)).toBe(false);
  });
});
