import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runSync } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, microsoftOneDriveDocMock, testPipeline, type MicrosoftOneDriveMockData, type MicrosoftOneDriveMockFile } from "@karatos/connector-testkit";
import {
  MICROSOFT_DELTA_SELECT,
  MICROSOFT_ONEDRIVE_WRITES,
  MICROSOFT_READ_ROLES,
  MicrosoftApiError,
  MicrosoftConfigError,
  MicrosoftResyncError,
  checkMicrosoftDriveId,
  microsoftClient,
  microsoftClientStateOk,
  microsoftDeltaToken,
  microsoftDriveLabel,
  microsoftGuid,
  microsoftItemEvents,
  microsoftItemRef,
  microsoftOneDriveConnector,
  microsoftTime,
  microsoftTokenRoles,
  microsoftWebhookPrompts,
  microsoftWebhookValidation,
  parseMicrosoftOneDriveCursor,
  type MicrosoftClient,
  type MicrosoftDeltaPage,
  type MicrosoftOneDriveCursor,
} from "../src/index.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const RECEIVED = NOW.toISOString();
const SINCE = "2021-11-10T12:00:00.000Z";
const guid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
const TENANT = guid("a");
const CLIENT = guid("b");
const SECRET = "s".repeat(40);
const DRIVE = `b!${"D".repeat(30)}_${"d".repeat(30)}`;
const LOGIN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const DELTA_URL = `https://graph.microsoft.com/v1.0/drives/${DRIVE}/root/delta`;
const STATE = "c".repeat(32);
const noSleep = async () => {};

const FILES: MicrosoftOneDriveMockFile[] = [
  { path: "Statements" },
  { path: "Statements/2026-10 Bank.csv", content: "date,amount\n2026-10-01,100.00\n", modified: "2026-10-02T09:00:00Z", mimeType: "text/csv" },
  { path: "Invoices" },
  { path: "Invoices/INV-1001.pdf", content: "%PDF-1.4 test", modified: "2026-10-03T09:00:00.1234567Z", mimeType: "application/pdf" },
  { path: "Appraisals" },
  { path: "Appraisals/Ring 4421.jpg", content: "jpeg bytes", modified: "2026-10-04T09:00:00Z", mimeType: "image/jpeg" },
  { path: "old.xlsx", content: "old", modified: "2019-05-01T09:00:00Z" },
  { path: "broken.txt", content: "x", modified: "2026-13-01T09:00:00Z", mimeType: "text/plain" },
];

function tenant(extra: Partial<MicrosoftOneDriveMockData> = {}): MicrosoftOneDriveMockData {
  return { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, driveId: DRIVE, roles: ["Sites.Selected"], files: FILES.map((f) => ({ ...f })), ...extra };
}

function connector(data: MicrosoftOneDriveMockData, options: { driveId?: string; fileNames?: "keep" | "drop"; clientState?: string; historyYears?: number } = {}) {
  const mock = microsoftOneDriveDocMock(data);
  const c = microsoftOneDriveConnector({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, driveId: DRIVE, fetch: mock.fetch, sleep: noSleep, now: () => NOW, ...options });
  return { c, mock };
}

type Out = { events: { type: string; occurredAt?: string; idempotencyKey: string; payload: Record<string, unknown> }[]; cursor: string | null }[];
async function batches(iterable: AsyncIterable<{ events: unknown[]; cursor: string | null }>) {
  const out: Out = [];
  for await (const b of iterable) out.push(b as Out[number]);
  return out;
}
const names = (out: Out) => out.flatMap((b) => b.events).map((e) => `${e.type === "document.file_removed" ? "-" : ""}${String(e.payload.name)}`);
const cursorOf = (out: Out, i = -1) => parseMicrosoftOneDriveCursor(out.at(i)!.cursor)!;
const reads = (mock: { fetch: { calls: { method: string; url: string }[] } }) => mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).origin}${new URL(c.url).pathname}`);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: Record<string, unknown> = { roles: ["Sites.Selected"] }) => `${b64({ typ: "JWT", alg: "RS256" })}.${b64(claims)}.${"s".repeat(43)}`;
const TOKEN_OK = (extra: Record<string, unknown> = {}, claims?: Record<string, unknown>) => json(200, { token_type: "Bearer", expires_in: 3599, access_token: jwt(claims), ...extra });
const link = (token: string, drive = DRIVE) => `https://graph.microsoft.com/v1.0/drives/${drive}/root/delta?token=${token}`;
const PAGE = (value: unknown[] = [], links: Record<string, unknown> = { "@odata.deltaLink": link("d1") }) => json(200, { value, ...links });

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
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof microsoftClient>[0]> = {}) => microsoftClient({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, fetch, sleep: noSleep, now: () => NOW, ...extra });

describe("OneDrive settings", () => {
  it("reads directory and client ids as lowercased GUIDs", () => {
    expect(microsoftGuid(TENANT)).toBe(TENANT);
    expect(microsoftGuid(` ${guid("A")}\n`)).toBe(guid("a"));
    for (const bad of ["", "contoso.onmicrosoft.com", guid("g"), `${TENANT}0`, `0${TENANT}`, `{${TENANT}}`, TENANT.replace(/-/g, ""), 5, null, undefined]) expect(microsoftGuid(bad), String(bad)).toBeUndefined();
  });

  it("reads a drive id that starts with b!", () => {
    expect(checkMicrosoftDriveId(DRIVE)).toBe(DRIVE);
    expect(checkMicrosoftDriveId(` ${DRIVE} `)).toBe(DRIVE);
    expect(checkMicrosoftDriveId(`b!${"a".repeat(20)}`)).toBe(`b!${"a".repeat(20)}`);
    expect(checkMicrosoftDriveId(`b!${"a".repeat(200)}`)).toBe(`b!${"a".repeat(200)}`);
    for (const bad of ["", "Documents", `b!${"a".repeat(19)}`, `b!${"a".repeat(201)}`, `B!${"a".repeat(30)}`, `b!${"a".repeat(30)}/x`, `b!${"a".repeat(30)}=`, `x b!${"a".repeat(30)}`, 5, null]) {
      expect(() => checkMicrosoftDriveId(bad), String(bad)).toThrow(MicrosoftConfigError);
    }
    expect(() => checkMicrosoftDriveId("Documents")).toThrow("set MICROSOFT_ONEDRIVE_DRIVE_ID to the library's drive id, which starts with b!");
  });

  it("turns down ids and secrets that don't read, naming the setting", () => {
    const fetch = scripted().fetch;
    expect(() => microsoftClient({ tenantId: "contoso", clientId: CLIENT, clientSecret: SECRET, fetch })).toThrow("MICROSOFT_TENANT_ID is missing or not a directory (tenant) id");
    expect(() => microsoftClient({ tenantId: TENANT, clientId: "app", clientSecret: SECRET, fetch })).toThrow("MICROSOFT_CLIENT_ID is missing or not an application (client) id");
    expect(() => microsoftClient({ tenantId: TENANT, clientId: CLIENT, clientSecret: "s".repeat(15), fetch })).toThrow("MICROSOFT_CLIENT_SECRET is missing or not in the expected shape");
    expect(() => microsoftClient({ tenantId: TENANT, clientId: CLIENT, clientSecret: "s".repeat(257), fetch })).toThrow(/MICROSOFT_CLIENT_SECRET/);
    expect(() => microsoftClient({ tenantId: TENANT, clientId: CLIENT, clientSecret: `${"s".repeat(10)} ${"s".repeat(10)}`, fetch })).toThrow(/MICROSOFT_CLIENT_SECRET/);
    expect(() => microsoftClient({ tenantId: TENANT, clientId: CLIENT, clientSecret: undefined as unknown as string, fetch })).toThrow(/MICROSOFT_CLIENT_SECRET/);
    expect(() => microsoftClient({ tenantId: TENANT, clientId: CLIENT, clientSecret: `  ${"s".repeat(16)}\n`, fetch })).not.toThrow();
    expect(() => microsoftClient({ tenantId: TENANT, clientId: CLIENT, clientSecret: "~!".repeat(128), fetch })).not.toThrow();
    for (const e of [new MicrosoftConfigError("x"), new MicrosoftApiError("x", 500), new MicrosoftResyncError()]) expect(e.name).toBe(e.constructor.name);
  });
});

describe("OneDrive times, tokens and links", () => {
  it("reads Graph's times with up to seven decimal places, and nothing that doesn't exist", () => {
    expect(microsoftTime("2026-10-02T09:00:00Z")).toBe("2026-10-02T09:00:00.000Z");
    expect(microsoftTime("2026-10-02T09:00:00.1Z")).toBe("2026-10-02T09:00:00.100Z");
    expect(microsoftTime("2026-10-02T09:00:00.1234567Z")).toBe("2026-10-02T09:00:00.123Z");
    expect(microsoftTime("2024-02-29T00:00:00Z")).toBe("2024-02-29T00:00:00.000Z");
    for (const bad of ["2026-02-30T09:00:00Z", "2026-13-01T09:00:00Z", "2026-10-02T25:00:00Z", "2026-10-02T09:00:00.12345678Z", "2026-10-02T09:00:00", "2026-10-02T09:00:00+01:00", "2026-10-02", " 2026-10-02T09:00:00Z", "2026-10-02T09:00:00.Z", 5, null]) {
      expect(microsoftTime(bad), String(bad)).toBeUndefined();
    }
  });

  it("reads the permissions a token says it carries", () => {
    expect(microsoftTokenRoles(jwt({ roles: ["Sites.Selected", "Files.Read.All"] }))).toEqual(["Sites.Selected", "Files.Read.All"]);
    expect(microsoftTokenRoles(jwt({ roles: [] }))).toEqual([]);
    expect(microsoftTokenRoles(jwt({ aud: "x" }))).toBeUndefined();
    expect(microsoftTokenRoles(jwt({ roles: "Sites.Selected" }))).toBeUndefined();
    expect(microsoftTokenRoles(jwt({ roles: ["Sites.Selected", 5] }))).toBeUndefined();
    expect(microsoftTokenRoles(`a.${Buffer.from("[1]").toString("base64url")}.c`)).toBeUndefined();
    expect(microsoftTokenRoles("a.%%%.c")).toBeUndefined();
    expect(microsoftTokenRoles(`a.${Buffer.from("null").toString("base64url")}.c`)).toBeUndefined();
    expect(microsoftTokenRoles("opaque")).toBeUndefined();
    expect(microsoftTokenRoles(`${jwt()}.extra`)).toBeUndefined();
    expect(microsoftTokenRoles(jwt({ roles: ["Sites.Selected"] }).split(".").slice(0, 2).join("."))).toBeUndefined();
  });

  it("reads the delta token out of this drive's paging links only", () => {
    expect(microsoftDeltaToken(link("abc"), DRIVE)).toBe("abc");
    expect(microsoftDeltaToken(`${link("a.b~c_d-e=f")}&$select=id,name`, DRIVE)).toBe("a.b~c_d-e=f");
    expect(microsoftDeltaToken(link("a%2Bb"), DRIVE)).toBe("a+b");
    expect(microsoftDeltaToken(`https://graph.microsoft.com/v1.0/drives/${DRIVE.replaceAll("!", "%21")}/root/delta?token=t`, DRIVE)).toBe("t");
    expect(microsoftDeltaToken(`https://GRAPH.microsoft.com/V1.0/Drives/${DRIVE}/Root/Delta?token=t`, DRIVE)).toBe("t");
    expect(microsoftDeltaToken(`https://graph.microsoft.com:443/v1.0/drives/${DRIVE}/root/delta?token=t`, DRIVE)).toBe("t");
    const bad: unknown[] = [
      link("t").replace("https:", "http:"),
      link("t").replace("graph.microsoft.com", "graph.microsoft.com.example"),
      link("t").replace("graph.microsoft.com", "evil.example"),
      link("t").replace("https://", "https://user:pw@"),
      link("t").replace("https://", "https://user@"),
      link("t").replace("https://", "https://:pw@"),
      `${link("t")}#x`,
      link("t", `b!${"e".repeat(40)}`),
      link("t").replace("/v1.0/", "/beta/"),
      link("t").replace("/root/delta", "/root/children"),
      link("t").replace("/root/delta", "/root/delta/"),
      link("t").replace("/root/delta", "/items/x/delta"),
      `https://graph.microsoft.com/v1.0/%E0/drives/${DRIVE}/root/delta?token=t`,
      `${link("t")}&$top=5`,
      `${link("t")}&token=u`,
      `${link("t")}&redirect=https://evil.example`,
      DELTA_URL,
      `${DELTA_URL}?$select=id`,
      link(""),
      link("a%20b"),
      link("a%0Ab"),
      link("t".repeat(8193)),
      `${link("t")}${"&$select=id".repeat(1000)}`,
      "not a url",
      5,
      null,
    ];
    for (const b of bad) expect(microsoftDeltaToken(b, DRIVE), String(b)).toBeUndefined();
    expect(microsoftDeltaToken(link("t".repeat(8192)), DRIVE)).toBe("t".repeat(8192));
  });
});

describe("OneDrive items", () => {
  const ctx = { receivedAt: RECEIVED, page: "list:x" };
  const file = (extra: Record<string, unknown> = {}) => ({
    id: "01KARAT0001",
    name: " INV-1001.pdf ",
    size: 13,
    file: { mimeType: "application/pdf", hashes: { quickXorHash: `${"A".repeat(26)}+=` } },
    parentReference: { driveType: "documentLibrary", driveId: DRIVE, id: "01KARATFOLDER", path: "/drive/root:/Invoices" },
    createdDateTime: "2026-10-01T09:00:00Z",
    lastModifiedDateTime: "2026-10-03T09:00:00.5Z",
    createdBy: { user: { displayName: "Someone", email: "someone@example.test" } },
    webUrl: "https://example.test/x",
    ...extra,
  });

  it("keeps a file's id, name, kind, folder, times, MIME type, size and hash, and nothing else", () => {
    const [e] = microsoftItemEvents(file(), ctx);
    expect(e!.type).toBe("document.file_updated");
    expect(e!.occurredAt).toBe("2026-10-03T09:00:00.500Z");
    expect(e!.receivedAt).toBe(RECEIVED);
    expect(e!.payload).toEqual({
      fileId: "onedrive:item:01KARAT0001",
      name: "INV-1001.pdf",
      parentId: "onedrive:item:01KARATFOLDER",
      createdAt: "2026-10-01T09:00:00.000Z",
      modifiedAt: "2026-10-03T09:00:00.500Z",
      kind: "pdf",
      extension: "pdf",
      mimeType: "application/pdf",
      sizeBytes: 13,
      quickXorHash: `${"A".repeat(26)}+=`,
    });
    expect(microsoftItemRef("x")).toBe("onedrive:item:x");
    const payloadHash = createHash("sha256").update(JSON.stringify(e!.payload)).digest("hex").slice(0, 16);
    expect(e!.idempotencyKey).toBe(`microsoft_onedrive:file:01KARAT0001:${payloadHash}`);
    expect(e!.id).toBe(`microsoft_onedrive_${createHash("sha256").update(`file:01KARAT0001:${payloadHash}`).digest("hex").slice(0, 32)}`);
    expect(JSON.stringify(e)).not.toMatch(/Someone|example\.test|drive\/root/);
    // A OneDrive package, such as a OneNote notebook, says so.
    expect(microsoftItemEvents(file({ package: { type: "oneNote" }, file: undefined }), ctx)[0]!.payload.package).toBe(true);
  });

  it("keys each version by what's kept, so an edit, rename or move is new and a replay is a duplicate", () => {
    const key = (x: Record<string, unknown>) => microsoftItemEvents(file(x), ctx)[0]!.idempotencyKey;
    expect(key({})).toBe(key({}));
    expect(key({ createdBy: { user: { displayName: "Another" } } })).toBe(key({}));
    expect(key({ size: 14 })).not.toBe(key({}));
    expect(key({ name: "renamed.pdf" })).not.toBe(key({}));
    expect(key({ parentReference: { id: "01KARATOTHER" } })).not.toBe(key({}));
    expect(key({ lastModifiedDateTime: "2026-10-04T09:00:00Z" })).not.toBe(key({}));
    expect(microsoftItemEvents(file(), { ...ctx, page: "other" })[0]!.idempotencyKey).toBe(key({}));
  });

  it("leaves out what doesn't read", () => {
    const [e] = microsoftItemEvents(
      file({
        name: "   ",
        size: -1,
        file: { mimeType: "Application/PDF", hashes: { quickXorHash: "short" } },
        parentReference: { id: "../x" },
        createdDateTime: "yesterday",
      }),
      ctx,
    );
    expect(e!.payload).toEqual({ fileId: "onedrive:item:01KARAT0001", modifiedAt: "2026-10-03T09:00:00.500Z", kind: "file" });
    const odd = (x: Record<string, unknown>) => microsoftItemEvents(file(x), ctx)[0]!.payload;
    expect(odd({ size: 1.5 }).sizeBytes).toBeUndefined();
    expect(odd({ size: 2 ** 53 }).sizeBytes).toBeUndefined();
    expect(odd({ size: "13" }).sizeBytes).toBeUndefined();
    expect(odd({ size: 0 }).sizeBytes).toBe(0);
    expect(odd({ file: { mimeType: "text/csv", hashes: { quickXorHash: 5 } } })).toMatchObject({ mimeType: "text/csv" });
    expect(odd({ file: { mimeType: "text/csv", hashes: { quickXorHash: 5 } } }).quickXorHash).toBeUndefined();
    expect(odd({ file: { mimeType: 5, hashes: "x" } }).mimeType).toBeUndefined();
    expect(odd({ file: { mimeType: "text/csv; charset=utf-8" } }).mimeType).toBeUndefined();
    expect(odd({ file: { mimeType: `text/${"a".repeat(128)}` } }).mimeType).toBeUndefined();
    expect(odd({ file: { mimeType: `text/${"a".repeat(127)}` } }).mimeType).toBe(`text/${"a".repeat(127)}`);
    expect(odd({ file: { hashes: { quickXorHash: `${"A".repeat(27)}=` } } }).quickXorHash).toBe(`${"A".repeat(27)}=`);
    expect(odd({ file: { hashes: { quickXorHash: `${"A".repeat(28)}=` } } }).quickXorHash).toBeUndefined();
    expect(odd({ file: { hashes: { quickXorHash: `${"A".repeat(27)}=x` } } }).quickXorHash).toBeUndefined();
    expect(odd({ file: { hashes: { quickXorHash: `x${"A".repeat(27)}=` } } }).quickXorHash).toBeUndefined();
    expect(odd({ parentReference: "x" }).parentId).toBeUndefined();
    expect(odd({ parentReference: { id: 5 } }).parentId).toBeUndefined();
    expect(odd({ name: "a".repeat(300) }).name).toBe("a".repeat(255));
    expect(odd({ name: 5 })).toMatchObject({ kind: "file" });
    expect(odd({ name: 5 }).name).toBeUndefined();
  });

  it("has no time for a file whose modified time doesn't read, so it is dead-lettered", () => {
    const [e] = microsoftItemEvents(file({ lastModifiedDateTime: "2026-02-30T09:00:00Z" }), ctx);
    expect(e!.occurredAt).toBeUndefined();
    expect(e!.payload.modifiedAt).toBeUndefined();
  });

  it("keeps a folder, at its modified time or else the time it was read", () => {
    const folder = { id: "01KARATFOLDER", name: "Invoices", folder: { childCount: 3 }, parentReference: { id: "01KARATROOT" }, lastModifiedDateTime: "2026-10-01T10:00:00Z", size: 99, file: { mimeType: "x/y" } };
    const [e] = microsoftItemEvents(folder, ctx);
    expect(e!.payload).toEqual({ fileId: "onedrive:item:01KARATFOLDER", name: "Invoices", parentId: "onedrive:item:01KARATROOT", modifiedAt: "2026-10-01T10:00:00.000Z", kind: "folder" });
    expect(e!.occurredAt).toBe("2026-10-01T10:00:00.000Z");
    expect(e!.idempotencyKey).toMatch(/^microsoft_onedrive:folder:01KARATFOLDER:[0-9a-f]{16}$/);
    const [bare] = microsoftItemEvents({ ...folder, lastModifiedDateTime: undefined }, ctx);
    expect(bare!.occurredAt).toBe(RECEIVED);
    // Only Graph's folder facet, an object, marks a folder.
    expect(microsoftItemEvents({ ...folder, folder: null }, ctx)[0]!.payload.kind).toBe("file");
    // A folder is kept however old it is.
    expect(microsoftItemEvents({ ...folder, lastModifiedDateTime: "2010-01-01T00:00:00Z" }, { ...ctx, since: SINCE })).toHaveLength(1);
  });

  it("reports a deletion by its id, keyed by the page it was read on", () => {
    const gone = { id: "01KARAT0001", name: "INV-1001.pdf", deleted: { state: "deleted" }, file: { mimeType: "application/pdf" }, lastModifiedDateTime: "2010-01-01T00:00:00Z" };
    const [e] = microsoftItemEvents(gone, { ...ctx, since: SINCE });
    expect(e!.type).toBe("document.file_removed");
    expect(e!.payload).toEqual({ fileId: "onedrive:item:01KARAT0001", name: "INV-1001.pdf", reason: "removed" });
    expect([e!.occurredAt, e!.receivedAt]).toEqual([RECEIVED, RECEIVED]);
    const page = createHash("sha256").update("list:x").digest("hex").slice(0, 16);
    expect(e!.idempotencyKey).toBe(`microsoft_onedrive:removed:01KARAT0001:${page}`);
    expect(microsoftItemEvents(gone, { ...ctx, page: "p2" })[0]!.idempotencyKey).not.toBe(e!.idempotencyKey);
    // Only Graph's deleted facet, an object, marks a deletion.
    expect(microsoftItemEvents({ ...gone, deleted: null, lastModifiedDateTime: "2026-10-01T00:00:00Z" }, ctx)[0]!.type).toBe("document.file_updated");
    // A deleted folder is a deletion too, and one with no name is still reported.
    expect(microsoftItemEvents({ id: "01KARATF", folder: {}, deleted: {} }, ctx)[0]!.payload).toEqual({ fileId: "onedrive:item:01KARATF", reason: "removed" });
  });

  it("drops names when told to, keeping ids and kinds", () => {
    const [e] = microsoftItemEvents(file(), { ...ctx, fileNames: "drop" });
    expect(e!.payload).toMatchObject({ nameWithheld: true, kind: "pdf", extension: "pdf" });
    expect(e!.payload.name).toBeUndefined();
    const [d] = microsoftItemEvents({ id: "01KARAT0001", name: "secret.pdf", deleted: {} }, { ...ctx, fileNames: "drop" });
    expect(d!.payload).toEqual({ fileId: "onedrive:item:01KARAT0001", nameWithheld: true, reason: "removed" });
    expect(microsoftItemEvents(file(), { ...ctx, fileNames: "keep" })[0]!.payload.nameWithheld).toBeUndefined();
  });

  it("drops the root and items without a usable id", () => {
    expect(microsoftItemEvents({ id: "01KARATROOT", name: "root", root: {}, folder: {} }, ctx)).toEqual([]);
    for (const bad of [null, 5, "x", [], {}, { id: 5 }, { id: "" }, { id: "a/b" }, { id: "a b" }, { id: "a".repeat(201) }]) expect(microsoftItemEvents(bad, ctx), JSON.stringify(bad)).toEqual([]);
    expect(microsoftItemEvents(file({ id: "a".repeat(200) }), ctx)).toHaveLength(1);
    expect(microsoftItemEvents(file({ id: "D2A2B9E1FC0D18B2!106" }), ctx)).toHaveLength(1);
  });

  it("keeps files changed since the history start, and older ones only when no start is given", () => {
    expect(microsoftItemEvents(file({ lastModifiedDateTime: "2021-11-10T11:59:59Z" }), { ...ctx, since: SINCE })).toEqual([]);
    expect(microsoftItemEvents(file({ lastModifiedDateTime: "2021-11-10T12:00:00Z" }), { ...ctx, since: SINCE })).toHaveLength(1);
    expect(microsoftItemEvents(file({ lastModifiedDateTime: "2019-01-01T00:00:00Z" }), ctx)).toHaveLength(1);
    // One whose time doesn't read is kept, to be dead-lettered.
    expect(microsoftItemEvents(file({ lastModifiedDateTime: "bad" }), { ...ctx, since: SINCE })).toHaveLength(1);
  });
});

describe("the OneDrive client", () => {
  it("signs in as the app for Graph, and keeps the token until five minutes before it ends", async () => {
    let now = NOW.getTime();
    const { fetch, sent } = scripted(TOKEN_OK, PAGE, PAGE, PAGE, TOKEN_OK, PAGE);
    const c = client(fetch, { tenantId: ` ${guid("A")} `, now: () => new Date(now) });
    await c.delta(DRIVE, null);
    await c.delta(DRIVE, null);
    now += (3599 - 300) * 1000 - 1;
    await c.delta(DRIVE, null);
    now += 1;
    await c.delta(DRIVE, null);
    expect(sent.map((s) => `${s.init.method} ${s.url.split("?")[0]}`)).toEqual([`POST ${LOGIN_URL}`, `GET ${DELTA_URL}`, `GET ${DELTA_URL}`, `GET ${DELTA_URL}`, `POST ${LOGIN_URL}`, `GET ${DELTA_URL}`]);
    const form = new URLSearchParams(String(sent[0]!.init.body));
    expect(Object.fromEntries(form)).toEqual({ client_id: CLIENT, client_secret: SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
    expect(sent[0]!.init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" });
    expect(sent[1]!.init.headers).toEqual({ Authorization: `Bearer ${jwt()}`, Accept: "application/json" });
    expect(sent.every((s) => s.init.method === "POST" ? s.url === LOGIN_URL : s.init.method === "GET")).toBe(true);
  });

  it("signs in on every request when Microsoft gives no lifetime that reads", async () => {
    for (const expires of ["3599", null, Number.POSITIVE_INFINITY]) {
      const { fetch, sent } = scripted(() => TOKEN_OK({ expires_in: expires }), PAGE, () => TOKEN_OK({ expires_in: expires }), PAGE);
      const c = client(fetch);
      await c.delta(DRIVE, null);
      await c.delta(DRIVE, null);
      expect(sent.filter((s) => s.url === LOGIN_URL), String(expires)).toHaveLength(2);
    }
    // JSON's way of writing a number too big to read.
    const { fetch, sent } = scripted(() => new Response(`{"access_token":"${jwt()}","expires_in":1e400}`, { status: 200 }), PAGE, TOKEN_OK, PAGE);
    const c = client(fetch);
    await c.delta(DRIVE, null);
    await c.delta(DRIVE, null);
    expect(sent.filter((s) => s.url === LOGIN_URL)).toHaveLength(2);
  });

  it("stops when the token carries any permission that isn't a read one", async () => {
    for (const roles of [["Sites.Selected", "Files.ReadWrite.All"], ["Sites.FullControl.All"], ["Mail.Read"], ["sites.selected"]]) {
      const { fetch, sent } = scripted(() => TOKEN_OK({}, { roles }));
      const e = await failure(client(fetch).delta(DRIVE, null));
      expect(e, roles.join()).toBeInstanceOf(MicrosoftConfigError);
      expect(e.message).toContain(roles.filter((r) => r !== "Sites.Selected").join(", "));
      expect(e.message).toMatch(/give it Sites\.Selected with the read role and nothing else$/);
      expect(sent).toHaveLength(1);
    }
    const many = ["A", "B", "C", "D", "E", "F"].map((r) => `${r}.ReadWrite.All`);
    const e = await failure(client(scripted(() => TOKEN_OK({}, { roles: many })).fetch).delta(DRIVE, null));
    expect(e.message).toBe("the app has A.ReadWrite.All, B.ReadWrite.All, C.ReadWrite.All, D.ReadWrite.All, E.ReadWrite.All; KaratOS only reads, so give it Sites.Selected with the read role and nothing else");
    // Every read permission, or a token that doesn't say, is fine.
    expect(MICROSOFT_READ_ROLES).toEqual(["Sites.Selected", "Lists.SelectedOperations.Selected", "Files.SelectedOperations.Selected", "Files.Read.All", "Sites.Read.All"]);
    for (const claims of [{ roles: ["Sites.Selected", "Lists.SelectedOperations.Selected", "Files.SelectedOperations.Selected", "Files.Read.All", "Sites.Read.All"] }, { roles: [] }, {}]) {
      await expect(client(scripted(() => TOKEN_OK({}, claims), PAGE).fetch).delta(DRIVE, null)).resolves.toMatchObject({ delta: "d1" });
    }
    await expect(client(scripted(() => TOKEN_OK({ access_token: "opaque-token" }), PAGE).fetch).delta(DRIVE, null)).resolves.toMatchObject({ delta: "d1" });
  });

  it("explains a sign-in Microsoft turns down", async () => {
    const answer = (status: number, codes: unknown) => () => json(status, { error: "x", error_codes: codes });
    const cases: [() => Response, string][] = [
      [answer(401, [7000215]), "Microsoft turned down MICROSOFT_CLIENT_SECRET: it may have expired or been deleted. Add a new client secret to the app and save it"],
      [answer(401, [7000222]), "Microsoft turned down MICROSOFT_CLIENT_SECRET: it may have expired or been deleted. Add a new client secret to the app and save it"],
      [answer(400, [700016]), "Microsoft has no app with MICROSOFT_CLIENT_ID in this tenant"],
      [answer(400, [90002]), "Microsoft has no tenant with MICROSOFT_TENANT_ID"],
      [answer(400, [900023]), "Microsoft has no tenant with MICROSOFT_TENANT_ID"],
    ];
    for (const [reply, message] of cases) {
      const e = await failure(client(scripted(reply).fetch).delta(DRIVE, null));
      expect(e).toBeInstanceOf(MicrosoftConfigError);
      expect(e.message).toBe(message);
    }
    for (const reply of [answer(500, [1]), answer(400, "7000215"), () => new Response("busy", { status: 503 }), () => json(400, [7000215])]) {
      const e = (await failure(client(scripted(reply).fetch).delta(DRIVE, null))) as MicrosoftApiError;
      expect(e).toBeInstanceOf(MicrosoftApiError);
      expect(e.message).toMatch(/^Microsoft answered HTTP (500|400|503) to the sign-in$/);
      expect(e.status).not.toBe(200);
    }
    for (const reply of [() => json(200, { expires_in: 3599 }), () => json(200, { access_token: 5 }), () => json(200, { access_token: "a b" }), () => json(200, { access_token: "" }), () => json(200, { access_token: "a".repeat(16385) }), () => json(200, [1]), () => new Response("ok", { status: 200 }), () => json(201, { access_token: jwt() })]) {
      const e = (await failure(client(scripted(reply).fetch).delta(DRIVE, null))) as MicrosoftApiError;
      expect(e).toBeInstanceOf(MicrosoftApiError);
      expect(e.message).toMatch(/^Microsoft's sign-in had no access token in the expected shape$|^Microsoft answered HTTP 201 to the sign-in$/);
    }
    await expect(client(scripted(() => json(200, { access_token: "a".repeat(16384) }), PAGE).fetch).delta(DRIVE, null)).resolves.toBeDefined();
  });

  it("signs in again once on a 401, then gives up", async () => {
    const { fetch, sent } = scripted(TOKEN_OK, () => json(401, {}), TOKEN_OK, PAGE);
    await client(fetch).delta(DRIVE, null);
    expect(sent.map((s) => s.url === LOGIN_URL)).toEqual([true, false, true, false]);
    const twice = scripted(TOKEN_OK, () => json(401, {}), TOKEN_OK, () => json(401, { error: { code: "InvalidAuthenticationToken" } }));
    const e = (await failure(client(twice.fetch).delta(DRIVE, null))) as MicrosoftApiError;
    expect([e.message, e.status, e.code]).toEqual(["Microsoft Graph turned down the app's token twice", 401, "InvalidAuthenticationToken"]);
    expect(twice.sent).toHaveLength(4);
    // A sign-in again doesn't use up a retry.
    const busy = () => json(429, {}, { "Retry-After": "1" });
    await expect(client(scripted(TOKEN_OK, () => json(401, {}), TOKEN_OK, busy, busy, busy, PAGE).fetch).delta(DRIVE, null)).resolves.toMatchObject({ delta: "d1" });
  });

  it("waits out a 429 or 503 for Retry-After seconds, up to a minute, then leaves it to runSync", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const busy = (status: number, after?: string) => () => json(status, { error: { code: "activityLimitReached" } }, after === undefined ? {} : { "Retry-After": after });
    await client(scripted(TOKEN_OK, busy(429, "120"), busy(503, "0"), busy(429, " 7 "), PAGE).fetch, { sleep }).delta(DRIVE, null);
    expect(waits).toEqual([60_000, 1000, 7000]);
    waits.length = 0;
    await client(scripted(TOKEN_OK, busy(429), busy(429, "1.5"), busy(429, "soon"), PAGE).fetch, { sleep }).delta(DRIVE, null);
    expect(waits).toEqual([1000, 2000, 4000]);
    waits.length = 0;
    await client(scripted(TOKEN_OK, busy(429, "1234567"), PAGE).fetch, { sleep }).delta(DRIVE, null);
    expect(waits).toEqual([1000]);
    waits.length = 0;
    const e = (await failure(client(scripted(TOKEN_OK, busy(429, "1"), busy(429, "1"), busy(429, "1"), busy(429, "1")).fetch, { sleep }).delta(DRIVE, null))) as MicrosoftApiError;
    expect([e.message, e.status, e.code]).toEqual(["Microsoft Graph answered HTTP 429 for the drive", 429, "activityLimitReached"]);
    expect(waits).toHaveLength(3);
    const none = (await failure(client(scripted(TOKEN_OK, busy(503)).fetch, { sleep, rateLimitRetries: 0 }).delta(DRIVE, null))) as MicrosoftApiError;
    expect(none.status).toBe(503);
    // A 500 isn't retried.
    const sent = scripted(TOKEN_OK, busy(500));
    expect(((await failure(client(sent.fetch, { sleep }).delta(DRIVE, null))) as MicrosoftApiError).status).toBe(500);
    expect(sent.sent).toHaveLength(2);
  });

  it("explains a drive it can't read, a resync and an answer that isn't JSON", async () => {
    const err = async (reply: () => Response) => (await failure(client(scripted(TOKEN_OK, reply).fetch).delta(DRIVE, null))) as MicrosoftApiError;
    const gone = await err(() => json(410, { error: { code: "resyncChangesApplyDifferences" } }));
    expect(gone).toBeInstanceOf(MicrosoftResyncError);
    expect([gone.message, gone.status, gone.code]).toEqual(["Microsoft Graph asked for the drive to be read again from the start", 410, "resyncChangesApplyDifferences"]);
    expect((await err(() => new Response("", { status: 410 }))).code).toBeUndefined();
    const denied = await err(() => json(403, { error: { code: "accessDenied" } }));
    expect([denied.message, denied.status, denied.code]).toEqual(["the app isn't allowed to read the drive: grant it the read role on the site or library", 403, "accessDenied"]);
    expect(denied).not.toBeInstanceOf(MicrosoftResyncError);
    const missing = await err(() => json(404, { error: { code: "itemNotFound" } }));
    expect([missing.message, missing.status]).toEqual(["Microsoft Graph couldn't find the drive: check MICROSOFT_ONEDRIVE_DRIVE_ID", 404]);
    expect((await err(() => json(400, { error: { code: "invalid request!" } }))).code).toBeUndefined();
    expect((await err(() => json(400, { error: { code: "a".repeat(81) } }))).code).toBeUndefined();
    expect((await err(() => json(400, { error: { code: "a".repeat(80) } }))).code).toBe("a".repeat(80));
    expect((await err(() => json(400, { error: "invalidRequest" }))).code).toBeUndefined();
    expect((await err(() => json(400, { error: { code: 5 } }))).code).toBeUndefined();
    expect((await err(() => new Response("<html>", { status: 502 }))).message).toBe("Microsoft Graph answered HTTP 502 for the drive");
    const created = await err(() => json(201, { value: [], "@odata.deltaLink": link("d1") }));
    expect([created.message, created.status]).toEqual(["Microsoft Graph answered HTTP 201 for the drive", 201]);
    for (const reply of [() => new Response("<html>", { status: 200 }), () => json(200, [1]), () => json(200, null)]) {
      const e = await err(reply);
      expect([e.message, e.status]).toEqual(["Microsoft Graph answered the drive with a body that isn't a JSON object", 200]);
    }
  });

  it("checks each delta page's shape and its paging links", async () => {
    const page = async (body: unknown) => client(scripted(TOKEN_OK, () => json(200, body)).fetch).delta(DRIVE, null);
    expect(await page({ value: [{ id: "a" }, 5, null, [1], { id: "b" }], "@odata.deltaLink": link("d1") })).toEqual({ items: [{ id: "a" }, { id: "b" }], next: null, delta: "d1" });
    expect(await page({ value: [], "@odata.nextLink": `${link("n1")}&$select=${MICROSOFT_DELTA_SELECT}` })).toEqual({ items: [], next: "n1", delta: null });
    const bad: [unknown, string][] = [
      [{ "@odata.deltaLink": link("d1") }, "Microsoft Graph answered the drive without the value list"],
      [{ value: {}, "@odata.deltaLink": link("d1") }, "Microsoft Graph answered the drive without the value list"],
      [{ value: [] }, "Microsoft Graph's page of the drive has neither or both of its next and delta links"],
      [{ value: [], "@odata.nextLink": link("n"), "@odata.deltaLink": link("d") }, "Microsoft Graph's page of the drive has neither or both of its next and delta links"],
      [{ value: [], "@odata.nextLink": link("n", `b!${"e".repeat(40)}`) }, "Microsoft Graph sent a paging link that isn't this drive's delta"],
      [{ value: [], "@odata.deltaLink": "https://evil.example/v1.0/drives/x/root/delta?token=d" }, "Microsoft Graph sent a paging link that isn't this drive's delta"],
      [{ value: [], "@odata.deltaLink": null }, "Microsoft Graph sent a paging link that isn't this drive's delta"],
      [{ value: [], "@odata.nextLink": 5 }, "Microsoft Graph sent a paging link that isn't this drive's delta"],
    ];
    for (const [body, message] of bad) {
      const e = (await failure(page(body))) as MicrosoftApiError;
      expect(e.message, JSON.stringify(body)).toBe(message);
      expect(e.status).toBe(200);
    }
  });

  it("builds each request itself, with the token and the fields it wants", async () => {
    const { fetch, sent } = scripted(TOKEN_OK, PAGE, PAGE);
    const c = client(fetch);
    await c.delta(DRIVE, null);
    await c.delta(DRIVE, "a+b/c=");
    expect(sent[1]!.url).toBe(`${DELTA_URL}?%24select=${encodeURIComponent(MICROSOFT_DELTA_SELECT)}`);
    const second = new URL(sent[2]!.url);
    expect([...second.searchParams]).toEqual([["token", "a+b/c="], ["$select", MICROSOFT_DELTA_SELECT]]);
    expect(MICROSOFT_DELTA_SELECT.split(",")).not.toEqual(expect.arrayContaining(["createdBy"]));
    expect(MICROSOFT_DELTA_SELECT).not.toMatch(/By|shared|permissions|webUrl|@microsoft/);
    await expect(c.delta("Documents", null)).rejects.toThrow("MICROSOFT_ONEDRIVE_DRIVE_ID is not a drive id");
    await expect(c.delta("Documents", null)).rejects.toBeInstanceOf(MicrosoftConfigError);
    const badToken = (await failure(c.delta(DRIVE, "a&b"))) as MicrosoftApiError;
    expect([badToken.message, badToken.status]).toEqual(["the delta token isn't in the expected shape", 0]);
    await expect(c.delta(DRIVE, "")).rejects.toThrow("the delta token isn't in the expected shape");
    expect(sent).toHaveLength(3);
  });

  it("sends only the sign-in and delta reads against the mocked tenant", async () => {
    const mock = microsoftOneDriveDocMock(tenant({ pageCap: 4 }));
    const c = client(mock.fetch);
    const first = await c.delta(DRIVE, null);
    expect(first.items.map((i) => i.name)).toEqual(["root", "Appraisals", "Ring 4421.jpg", "broken.txt"]);
    expect(Object.keys(first.items[2]!).sort()).toEqual(["createdDateTime", "file", "id", "lastModifiedDateTime", "name", "parentReference", "size"]);
    const second = await c.delta(DRIVE, first.next);
    expect(second.items).toHaveLength(4);
    const third = await c.delta(DRIVE, second.next);
    expect([third.items.length, third.next, typeof third.delta]).toEqual([1, null, "string"]);
    expect(reads(mock)).toEqual([`POST ${LOGIN_URL}`, `GET ${DELTA_URL}`, `GET ${DELTA_URL}`, `GET ${DELTA_URL}`]);
    expect(mock.signIns).toBe(1);
  });

  it("is turned down by the mock until the read role is granted, and for another drive", async () => {
    const e = (await failure(client(microsoftOneDriveDocMock(tenant({ notGranted: true })).fetch).delta(DRIVE, null))) as MicrosoftApiError;
    expect([e.status, e.code]).toEqual([403, "accessDenied"]);
    const other = (await failure(client(microsoftOneDriveDocMock(tenant()).fetch).delta(`b!${"e".repeat(40)}`, null))) as MicrosoftApiError;
    expect([other.status, other.code]).toEqual([404, "itemNotFound"]);
    const wrong = await failure(client(microsoftOneDriveDocMock(tenant({ clientSecret: "x".repeat(40) })).fetch).delta(DRIVE, null));
    expect(wrong.message).toMatch(/turned down MICROSOFT_CLIENT_SECRET/);
    const revoked = microsoftOneDriveDocMock(tenant());
    const c = client(revoked.fetch);
    await c.delta(DRIVE, null);
    revoked.revokeTokens();
    await c.delta(DRIVE, null);
    expect(revoked.signIns).toBe(2);
  });
});

describe("the OneDrive checkpoint", () => {
  const ok: MicrosoftOneDriveCursor = { pass: "historical", drive: DRIVE, phase: "listing", token: "abc", done: false, since: SINCE };
  it("reads back what the connector wrote, and nothing else", () => {
    expect(parseMicrosoftOneDriveCursor(null)).toBeNull();
    expect(parseMicrosoftOneDriveCursor(JSON.stringify({ ...ok, extra: 1 }))).toEqual(ok);
    expect(parseMicrosoftOneDriveCursor(JSON.stringify({ ...ok, token: null }))).toEqual({ ...ok, token: null });
    expect(parseMicrosoftOneDriveCursor(JSON.stringify({ ...ok, phase: "changes", done: true, pass: "incremental" }))).toEqual({ ...ok, phase: "changes", done: true, pass: "incremental" });
    const bad: unknown[] = [
      "not json",
      "null",
      "5",
      { ...ok, pass: "other" },
      { ...ok, drive: "Documents" },
      { ...ok, drive: 5 },
      { ...ok, phase: "done" },
      { ...ok, token: "a b" },
      { ...ok, token: "" },
      { ...ok, token: 5 },
      { ...ok, token: "a".repeat(8193) },
      { ...ok, done: "no" },
      { ...ok, token: null, done: true },
      { ...ok, token: null, phase: "changes" },
      { ...ok, since: "2021-11-10" },
      { ...ok, since: "2021-02-30T12:00:00.000Z" },
      { ...ok, since: "2021-11-10T12:00:00Z" },
      { ...ok, since: 5 },
    ];
    for (const raw of bad) expect(() => parseMicrosoftOneDriveCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("OneDrive checkpoint is not in the expected shape");
  });
});

describe("the OneDrive connector", () => {
  it("imports, replays, resumes and retries the mocked library", async () => {
    // Three folders and three files in the window; old.xlsx is too old, broken.txt is dead-lettered.
    const result = await checkConnectorSync({ makeConnector: () => connector(tenant({ pageCap: 2 })).c, expected: { ingested: 6, deadLettered: 1 } });
    expect([result.full.ingested, result.full.deadLettered, result.full.batches]).toEqual([6, 1, 5]);
  });

  it("lists the library, keeping five years of files, and never the root", async () => {
    const { c, mock } = connector(tenant());
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(names(out)).toEqual(["Appraisals", "Ring 4421.jpg", "broken.txt", "Invoices", "INV-1001.pdf", "Statements", "2026-10 Bank.csv"]);
    expect(cursorOf(out)).toMatchObject({ pass: "historical", drive: DRIVE, phase: "changes", done: true, since: SINCE });
    expect(reads(mock)).toEqual([`POST ${LOGIN_URL}`, `GET ${DELTA_URL}`]);
    const ring = out.flatMap((b) => b.events).find((e) => e.payload.name === "Ring 4421.jpg")!;
    const folder = out.flatMap((b) => b.events).find((e) => e.payload.name === "Appraisals")!;
    expect(ring.payload).toMatchObject({ kind: "image", mimeType: "image/jpeg", sizeBytes: 10, parentId: folder.payload.fileId });
    expect(out.flatMap((b) => b.events).find((e) => e.payload.name === "INV-1001.pdf")!.occurredAt).toBe("2026-10-03T09:00:00.123Z");
    expect(JSON.stringify(out)).not.toMatch(/Test Jeweler|example\.test|sharepoint|date,amount|root/);
    assertSynthetic(out);
  });

  it("checkpoints Graph's token on every page, and a finished import reads nothing", async () => {
    const { c, mock } = connector(tenant({ pageCap: 3 }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    // The root is left out of page one and the old file out of page three.
    expect(out.map((b) => b.events.length)).toEqual([2, 3, 2]);
    expect(out.map((_, i) => [cursorOf(out, i).phase, cursorOf(out, i).done])).toEqual([
      ["listing", false],
      ["listing", false],
      ["changes", true],
    ]);
    const calls = mock.fetch.calls.length;
    expect(await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }))).toEqual([]);
    expect(mock.fetch.calls).toHaveLength(calls);
    // Resumed from page two, it asks Graph for the page after.
    const resumed = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: out[1]!.cursor }));
    expect(names(resumed)).toEqual(names(out).slice(5));
    expect(new URL(mock.fetch.calls.at(-1)!.url).searchParams.get("token")).toBe(cursorOf(out, 1).token);
  });

  it("reads only what changed since the last sync, with renames, moves and deletions", async () => {
    const { c, mock } = connector(tenant());
    const first = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const before = first.flatMap((b) => b.events);
    mock.put({ path: "Statements/2026-11 Bank.csv", content: "date,amount\n", modified: "2026-11-02T09:00:00Z" });
    mock.put({ path: "Invoices/INV-1001.pdf", content: "%PDF-1.4 paid", modified: "2026-11-03T09:00:00Z" });
    mock.move("Appraisals/Ring 4421.jpg", "Invoices/Ring 4421 sold.jpg");
    mock.remove("Statements/2026-10 Bank.csv");
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: first.at(-1)!.cursor }));
    expect(names(out)).toEqual(["2026-11 Bank.csv", "INV-1001.pdf", "Ring 4421 sold.jpg", "-2026-10 Bank.csv"]);
    const events = out.flatMap((b) => b.events);
    const id = (n: string, list = before) => list.find((e) => e.payload.name === n)!.payload.fileId;
    expect(id("Ring 4421 sold.jpg", events)).toBe(id("Ring 4421.jpg"));
    expect(events[2]!.payload.parentId).toBe(id("Invoices"));
    expect(events[3]!.payload.fileId).toBe(id("2026-10 Bank.csv"));
    expect(id("INV-1001.pdf", events)).toBe(id("INV-1001.pdf"));
    expect(cursorOf(out)).toMatchObject({ pass: "incremental", phase: "changes", done: true });
    // Nothing changed: one call, no events.
    const quiet = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }));
    expect(quiet.map((b) => b.events.length)).toEqual([0]);
    // A change older than five years is still kept, as it changed since the last sync.
    mock.put({ path: "restored.xlsx", content: "r", modified: "2019-01-01T00:00:00Z" });
    const restored = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: quiet.at(-1)!.cursor }));
    expect(names(restored)).toEqual(["restored.xlsx"]);
  });

  it("pages through a long change feed, checkpointing each page", async () => {
    const { c, mock } = connector(tenant({ pageCap: 2 }));
    const first = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    for (let i = 0; i < 5; i++) mock.put({ path: `Invoices/INV-20${i}.pdf`, content: `${i}`, modified: "2026-11-02T09:00:00Z" });
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: first.at(-1)!.cursor }));
    expect(out.map((b) => b.events.length)).toEqual([2, 2, 1]);
    expect(out.map((_, i) => [cursorOf(out, i).phase, cursorOf(out, i).done])).toEqual([
      ["changes", false],
      ["changes", false],
      ["changes", true],
    ]);
    // A change during the paging waits for the next sync.
    const part = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: out[0]!.cursor }));
    expect(names(part)).toEqual(names(out).slice(2));
  });

  it("stores a replayed change feed once", async () => {
    const t = testPipeline();
    const { c, mock } = connector(tenant());
    await runSync({ connector: c, mode: "historical", pipeline: t.pipeline, memory: t.memory, organizationId: TEST_ORG, sleep: noSleep });
    // The first incremental sync keeps its own checkpoint, so it lists the library once: all duplicates.
    const baseline = await runSync({ connector: c, mode: "incremental", pipeline: t.pipeline, memory: t.memory, organizationId: TEST_ORG, sleep: noSleep });
    expect([baseline.ingested, baseline.duplicates, baseline.deadLettered]).toEqual([0, 6, 1]);
    mock.remove("Invoices/INV-1001.pdf");
    const first = await runSync({ connector: c, mode: "incremental", pipeline: t.pipeline, memory: t.memory, organizationId: TEST_ORG, sleep: noSleep });
    expect([first.ingested, first.duplicates]).toEqual([1, 0]);
    const nothing = await runSync({ connector: c, mode: "incremental", pipeline: t.pipeline, memory: t.memory, organizationId: TEST_ORG, sleep: noSleep });
    expect([nothing.ingested, nothing.duplicates]).toEqual([0, 0]);
  });

  it("goes on from an unfinished listing when an incremental sync runs first", async () => {
    const { c } = connector(tenant({ pageCap: 3 }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const rest = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: out[0]!.cursor }));
    expect(names(rest)).toEqual(names(out).slice(2));
    expect(cursorOf(rest, 0)).toMatchObject({ pass: "incremental", phase: "listing", done: false, since: SINCE });
    expect(cursorOf(rest)).toMatchObject({ pass: "incremental", phase: "changes", done: true });
  });

  it("lists the library when an incremental sync has no checkpoint for it", async () => {
    const { c } = connector(tenant());
    const out = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(names(out)).toHaveLength(7);
    expect(cursorOf(out)).toMatchObject({ pass: "incremental", phase: "changes", done: true, since: SINCE });
  });

  it("starts over when the drive setting changes, or for a new import after incremental syncs", async () => {
    const { c } = connector(tenant());
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const otherDrive = `b!${"e".repeat(40)}`;
    const moved = connector(tenant({ driveId: otherDrive, files: [{ path: "Only.pdf", content: "x", modified: "2026-10-01T00:00:00Z" }] }), { driveId: otherDrive }).c;
    const fresh = await batches(moved.historicalImport({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }));
    expect(names(fresh)).toEqual(["Only.pdf"]);
    expect(cursorOf(fresh).drive).toBe(otherDrive);
    const inc = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }));
    const again = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: inc.at(-1)!.cursor }));
    expect(names(again)).toHaveLength(7);
    expect(cursorOf(again).pass).toBe("historical");
  });

  it("lists the library again when Graph answers 410, up to three times in one sync", async () => {
    const { c, mock } = connector(tenant());
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    mock.expireTokens();
    const relisted = await batches(c.incrementalSync({ organizationId: TEST_ORG, cursor: out.at(-1)!.cursor }));
    expect(names(relisted)).toEqual(names(out));
    expect(cursorOf(relisted)).toMatchObject({ pass: "incremental", phase: "changes", done: true, since: SINCE });

    let resyncs = 0;
    const always: MicrosoftClient = {
      delta: async (_drive, token) => {
        if (token === null) return { items: [], next: "n1", delta: null };
        resyncs++;
        throw new MicrosoftResyncError();
      },
    };
    const stuck = microsoftOneDriveConnector({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, driveId: DRIVE, client: always, now: () => NOW });
    await expect(batches(stuck.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow(MicrosoftResyncError);
    expect(resyncs).toBe(4);
    // A resync keeps the history start it had.
    const since = "2022-01-01T00:00:00.000Z";
    const seen: (string | null)[] = [];
    let once = true;
    const flaky: MicrosoftClient = {
      delta: async (_d, token) => {
        seen.push(token);
        if (token !== null && once) {
          once = false;
          throw new MicrosoftResyncError();
        }
        return { items: [], next: null, delta: "d2" };
      },
    };
    const again = microsoftOneDriveConnector({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, driveId: DRIVE, client: flaky, now: () => NOW });
    const kept = await batches(again.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ pass: "incremental", drive: DRIVE, phase: "changes", token: "old", done: true, since }) }));
    expect(seen).toEqual(["old", null]);
    expect(cursorOf(kept)).toEqual({ pass: "incremental", drive: DRIVE, phase: "changes", token: "d2", done: true, since });
    // Any other error goes straight to runSync.
    let calls = 0;
    const failing: MicrosoftClient = { delta: async () => (calls++, Promise.reject(new MicrosoftApiError("busy", 503))) };
    const broken = microsoftOneDriveConnector({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, driveId: DRIVE, client: failing, now: () => NOW });
    await expect(batches(broken.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow("busy");
    expect(calls).toBe(1);
  });

  it("stops a delta that never ends", async () => {
    let n = 0;
    const endless: MicrosoftClient = { delta: async () => ({ items: [], next: `n${++n}`, delta: null }) };
    const c = microsoftOneDriveConnector({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, driveId: DRIVE, client: endless, now: () => NOW });
    await expect(batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow("OneDrive's delta kept paging past the most one sync reads");
    expect(n).toBe(100_000);
  });

  it("names the page each deletion came from, and the first page by the drive", async () => {
    const gone = { id: "01KARAT0001", name: "a.pdf", deleted: { state: "deleted" } };
    const pages: MicrosoftDeltaPage[] = [
      { items: [gone], next: "p2", delta: null },
      { items: [gone], next: null, delta: "d3" },
    ];
    const fake: MicrosoftClient = { delta: async (_d, token) => pages[token === null ? 0 : 1]! };
    const c = microsoftOneDriveConnector({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, driveId: DRIVE, client: fake, now: () => NOW });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const keys = out.flatMap((b) => b.events).map((e) => e.idempotencyKey);
    const page = (p: string) => createHash("sha256").update(p).digest("hex").slice(0, 16);
    expect(keys.map((k) => k.split(":").at(-1))).toEqual([page(`list:${DRIVE}`), page("p2")]);
    expect(cursorOf(out)).toMatchObject({ token: "d3", done: true, phase: "changes" });
  });

  it("is prompted to sync by a notification carrying its client state", () => {
    const { c } = connector(tenant(), { clientState: STATE });
    expect(c.webhookPromptsSync({ value: [{ subscriptionId: "x", clientState: STATE, resource: "drives/x/root", changeType: "updated" }] })).toBe(true);
    expect(c.webhookPromptsSync({ value: [{ clientState: "d".repeat(32) }] })).toBe(false);
    expect(connector(tenant()).c.webhookPromptsSync({ value: [{ clientState: STATE }] })).toBe(false);
    expect(c.handleWebhook).toBeUndefined();
  });

  it("checks its settings", () => {
    const base = { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, driveId: DRIVE };
    expect(() => microsoftOneDriveConnector({ ...base, driveId: "Documents" })).toThrow(/MICROSOFT_ONEDRIVE_DRIVE_ID/);
    expect(() => microsoftOneDriveConnector({ ...base, fileNames: "hide" as "keep" })).toThrow("MICROSOFT_ONEDRIVE_FILE_NAMES is keep or drop");
    expect(() => microsoftOneDriveConnector({ ...base, clientState: "short" })).toThrow("MICROSOFT_GRAPH_CLIENT_STATE is 16 to 128 printable characters");
    expect(() => microsoftOneDriveConnector({ ...base, clientState: "short" })).toThrow(MicrosoftConfigError);
    expect(() => microsoftOneDriveConnector({ ...base, historyYears: 0 })).toThrow("historyYears must be a positive whole number");
    expect(() => microsoftOneDriveConnector({ ...base, historyYears: 1.5 })).toThrow(/historyYears/);
    expect(() => microsoftOneDriveConnector({ ...base, tenantId: "x" })).toThrow(/MICROSOFT_TENANT_ID/);
    expect(() => microsoftOneDriveConnector({ ...base, historyYears: 1, fileNames: "drop", clientState: STATE })).not.toThrow();
    expect(() => microsoftOneDriveConnector({ ...base, fileNames: "keep" })).not.toThrow();
    expect(microsoftDriveLabel(DRIVE)).toMatch(/^drive:[0-9a-f]{8}$/);
    expect(microsoftDriveLabel(DRIVE)).not.toContain(DRIVE);
  });

  it("keeps the history it's told to, and drops names when told to", async () => {
    const { c } = connector(tenant(), { fileNames: "drop" });
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(out.flatMap((b) => b.events).every((e) => e.payload.nameWithheld === true && !("name" in e.payload))).toBe(true);
    const ten = connector(tenant(), { historyYears: 10 }).c;
    const all = await batches(ten.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(names(all)).toContain("old.xlsx");
    expect(cursorOf(all).since).toBe("2016-11-10T12:00:00.000Z");
  });

  it("waits out Graph's throttling during a sync", async () => {
    const { c } = connector(tenant({ rateLimited: 2, retryAfter: "2" }));
    const out = await batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(names(out)).toHaveLength(7);
  });

  it("stops before reading when the app can do more than read", async () => {
    const { c, mock } = connector(tenant({ roles: ["Sites.Selected", "Sites.ReadWrite.All"] }));
    await expect(batches(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow(/the app has Sites\.ReadWrite\.All/);
    expect(reads(mock)).toEqual([`POST ${LOGIN_URL}`]);
  });

  it("declares saving a report and making a subscription, and turns both down while writes are off", async () => {
    const { c } = connector(tenant());
    expect(c.writes).toBe(MICROSOFT_ONEDRIVE_WRITES);
    expect(MICROSOFT_ONEDRIVE_WRITES).toEqual([
      { integration: "microsoft_onedrive", name: "save_report", description: "Save a generated report to a folder in the library" },
      { integration: "microsoft_onedrive", name: "create_subscription", description: "Ask Microsoft Graph to send change notifications for the drive" },
    ]);
    const audit = await assertWritesRefused(c);
    expect(audit.map((entry) => [entry.action, entry.outcome])).toEqual([
      ["save_report", "refused"],
      ["create_subscription", "refused"],
    ]);
    expect(c.source).toBe("microsoft_onedrive");
  });
});

describe("OneDrive notifications", () => {
  it("echoes the token that checks the notification address, as plain text", () => {
    const headers = { "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" };
    expect(microsoftWebhookValidation("Validation: Testing client application reachability for subscription Request-Id: 123")).toEqual({ status: 200, body: "Validation: Testing client application reachability for subscription Request-Id: 123", headers });
    expect(microsoftWebhookValidation("a".repeat(1024)).status).toBe(200);
    for (const bad of ["", "a".repeat(1025), "a\nb", "a\u0000b", "a\u007fb", "<script>", "a>b", null, undefined]) expect(microsoftWebhookValidation(bad), String(bad)).toEqual({ status: 400, body: "", headers });
  });

  it("reads a client state of 16 to 128 printable characters", () => {
    expect(microsoftClientStateOk("c".repeat(16))).toBe(true);
    expect(microsoftClientStateOk("~".repeat(128))).toBe(true);
    for (const bad of ["c".repeat(15), "c".repeat(129), `${"c".repeat(16)} `, `${"c".repeat(16)}\u00e9`, 5, undefined]) expect(microsoftClientStateOk(bad), String(bad)).toBe(false);
  });

  it("says whether any notification carries the client state", () => {
    const n = (...states: unknown[]) => ({ value: states.map((clientState) => ({ subscriptionId: "s", clientState, changeType: "updated" })) });
    expect(microsoftWebhookPrompts(n(STATE), STATE)).toBe(true);
    expect(microsoftWebhookPrompts(n("x", 5, STATE), STATE)).toBe(true);
    expect(microsoftWebhookPrompts(n(STATE, "x"), STATE)).toBe(true);
    expect(microsoftWebhookPrompts(n(`${STATE}x`), STATE)).toBe(false);
    expect(microsoftWebhookPrompts(n(STATE.slice(1)), STATE)).toBe(false);
    expect(microsoftWebhookPrompts(n(undefined), STATE)).toBe(false);
    expect(microsoftWebhookPrompts({ value: [null, 5, STATE] }, STATE)).toBe(false);
    expect(microsoftWebhookPrompts({ value: [] }, STATE)).toBe(false);
    expect(microsoftWebhookPrompts({ value: { clientState: STATE } }, STATE)).toBe(false);
    expect(microsoftWebhookPrompts({ value: [...Array(1000)].map(() => ({ clientState: STATE })) }, STATE)).toBe(true);
    expect(microsoftWebhookPrompts({ value: [...Array(1001)].map(() => ({ clientState: STATE })) }, STATE)).toBe(false);
    for (const body of [null, 5, "x", []]) expect(microsoftWebhookPrompts(body, STATE)).toBe(false);
    // A client state that doesn't read never matches, even itself.
    expect(microsoftWebhookPrompts(n("short"), "short")).toBe(false);
  });
});
