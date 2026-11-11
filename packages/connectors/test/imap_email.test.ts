import { createServer, type Server } from "node:net";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { InMemoryWriteAuditLog, READ_ONLY, WriteGate, WritesDisabledError, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  ImapFakeTransport,
  TEST_ORG,
  assertSynthetic,
  checkConnectorSync,
  imapDate,
  imapFakeServer,
  imapMessage,
  testPipeline,
  type ImapFakeMailbox,
  type ImapFakeMessage,
  type ImapFakeServer,
} from "@karatos/connector-testkit";
import {
  IMAP_BATCH_SIZE,
  IMAP_COMMANDS,
  IMAP_DEFAULT_PORT,
  IMAP_EMAIL_WRITES,
  IMAP_FETCH_ITEMS,
  IMAP_HEADER_FIELDS,
  IMAP_HEADER_MAX,
  IMAP_MAX_LINE,
  IMAP_MAX_LITERAL,
  IMAP_TIMEOUT_MS,
  ImapConfigError,
  ImapError,
  ImapLiteralTooLarge,
  ImapProtocolError,
  ImapReader,
  decodeEncodedWords,
  gmailNormalizer,
  imapAccountLabel,
  imapAddresses,
  imapAstring,
  imapClient,
  imapCommandParts,
  imapEmailConnector,
  imapFolders,
  imapInternalDate,
  imapNormalizer,
  imapSearchDate,
  imapSequenceSet,
  imapSettings,
  imapTlsConnect,
  isUid,
  messageIds,
  parseHeaderBlock,
  parseImapCursor,
  parseImapValues,
  readImapResponse,
  type ImapClientOptions,
  type ImapCursor,
  type ImapEmailEvent,
  type ImapEmailOptions,
  type ImapFetched,
  type ImapMessagePlace,
  type ImapRawResponse,
  type ImapRequest,
} from "../src/index.js";

// Test values assembled at runtime, so no scanner mistakes the source for a leak.
const PASSWORD = ["app", "pass", "x".repeat(12)].join("-");
const KEY = ["k", "e", "y"].join("").repeat(11);
const HOST = "imap.example.test";
const USER = "store@example.test";
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;
const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);
const latin = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

/**
 * assertSynthetic on a payload. References are hex digests, whose digit runs
 * can look like phone numbers, so they are checked as a placeholder.
 */
const synthetic = (payload: unknown) => assertSynthetic(JSON.parse(JSON.stringify(payload).replace(/:[0-9a-f]{16,}"/g, ':digest"')));

/** Feeds text to a reader whole, then byte by byte, and checks both read the same. */
function readAll(text: string | Uint8Array, options: ConstructorParameters<typeof ImapReader>[0] = {}): ImapRawResponse[] {
  const data = typeof text === "string" ? latin(text) : text;
  const whole = new ImapReader(options).feed(data);
  const reader = new ImapReader(options);
  const split: ImapRawResponse[] = [];
  for (let i = 0; i < data.length; i++) split.push(...reader.feed(data.subarray(i, i + 1)));
  expect(split).toEqual(whole);
  return whole;
}
const response = (text: string) => readImapResponse(readAll(text)[0]!);
const values = (text: string) => parseImapValues(response(text));

describe("IMAP reader", () => {
  it("cuts the stream into lines at CRLF or a bare LF, wherever the chunks split", () => {
    expect(readAll("* OK ready\r\nK1 OK done\nK2 NO no\r\n")).toEqual([
      { text: ["* OK ready"], literals: [] },
      { text: ["K1 OK done"], literals: [] },
      { text: ["K2 NO no"], literals: [] },
    ]);
    const reader = new ImapReader();
    expect(reader.feed(latin("* OK par"))).toEqual([]);
    expect(reader.feed(latin("tial\r"))).toEqual([]);
    expect(reader.feed(latin("\n"))).toEqual([{ text: ["* OK partial"], literals: [] }]);
  });

  it("reads literals, CRLFs and parentheses inside them included, and the text after", () => {
    const body = "From: a@example.test\r\n)\r\n";
    const [r] = readAll(`* 1 FETCH (UID 4 BODY[HEADER] {${body.length}}\r\n${body} FLAGS ())\r\n`);
    expect(r!.text).toEqual([`* 1 FETCH (UID 4 BODY[HEADER] {${body.length}}`, " FLAGS ())"]);
    expect(Buffer.from(r!.literals[0] as Uint8Array).toString("latin1")).toBe(body);
    // Two literals, and one that is empty.
    const [two] = readAll("* LIST () {1}\r\n/ {0}\r\n\r\nK1 OK x\r\n");
    expect(two!.text).toEqual(["* LIST () {1}", " {0}", ""]);
    expect(two!.literals.map((l) => Buffer.from(l as Uint8Array).toString())).toEqual(["/", ""]);
    // Literal bytes are kept as sent, not read as text.
    const [raw] = readAll(new Uint8Array([...latin("* 1 FETCH (X {2}\r\n"), 0xc3, 0xa9, ...latin(")\r\n")]));
    expect([...(raw!.literals[0] as Uint8Array)]).toEqual([0xc3, 0xa9]);
    // Only a {n} that ends the line announces a literal.
    expect(readAll("* OK [ALERT] {5} left\r\nK1 OK done\r\n")).toEqual([
      { text: ["* OK [ALERT] {5} left"], literals: [] },
      { text: ["K1 OK done"], literals: [] },
    ]);
    // Ten digits still announce one, which the reader then waits for.
    expect(new ImapReader().feed(latin("* 1 FETCH (B {1234567890}\r\n"))).toEqual([]);
  });

  it("keeps a literal up to its cap and skips one past it, staying in step", () => {
    const at = (n: number) => readAll(`* 1 FETCH (B {${n}}\r\n${"x".repeat(n)})\r\nK1 OK done\r\n`, { maxLiteral: 5 });
    const kept = at(5);
    expect((kept[0]!.literals[0] as Uint8Array).length).toBe(5);
    const skipped = at(6);
    expect(skipped[0]!.literals[0]).toEqual(new ImapLiteralTooLarge(6));
    expect(skipped[1]!.text).toEqual(["K1 OK done"]);
    expect(IMAP_MAX_LITERAL).toBe(256 * 1024);
    expect(new ImapReader().feed(latin(`* 1 FETCH (B {${IMAP_MAX_LITERAL + 1}}\r\n`))).toEqual([]);
  });

  it("turns down a line past its cap, whole or still coming, and a NUL", () => {
    expect(readAll(`${"a".repeat(10)}\r\n`, { maxLine: 10 })).toHaveLength(1);
    expect(() => new ImapReader({ maxLine: 10 }).feed(latin(`${"a".repeat(11)}\r\n`))).toThrow(ImapProtocolError);
    expect(() => new ImapReader({ maxLine: 10 }).feed(latin("a".repeat(12)))).toThrow("longer than 10 bytes");
    expect(new ImapReader({ maxLine: 10 }).feed(latin(`${"a".repeat(10)}\r`))).toEqual([]);
    expect(new ImapReader({ maxLine: 10 }).feed(latin("a".repeat(11)))).toEqual([]);
    // Text on both sides of a literal counts toward the one line.
    expect(() => new ImapReader({ maxLine: 10 }).feed(latin("* A {1}\r\nx bbbb\r\n"))).toThrow(ImapProtocolError);
    expect(new ImapReader({ maxLine: 11 }).feed(latin("* A {1}\r\nx bbb\r\n"))).toHaveLength(1);
    expect(() => new ImapReader().feed(new Uint8Array([0x2a, 0x20, 0x00, 0x0d, 0x0a]))).toThrow("NUL");
    expect(IMAP_MAX_LINE).toBe(16 * 1024 * 1024);
  });
});

describe("IMAP responses", () => {
  it("reads tags, numbers, kinds and status codes", () => {
    const tagged = response("K7 ok [UIDVALIDITY 3857529045] EXAMINE done\r\n");
    expect([tagged.tag, tagged.kind, tagged.code, tagged.rest, tagged.number]).toEqual(["K7", "OK", { name: "UIDVALIDITY", args: "3857529045" }, "EXAMINE done", undefined]);
    const coded = response("* OK [read-only]\r\n");
    expect([coded.code, coded.rest]).toEqual([{ name: "READ-ONLY", args: "" }, ""]);
    const fetch = response("* 12 FETCH (UID 4)\r\n");
    expect([fetch.tag, fetch.number, fetch.kind, fetch.rest, fetch.code]).toEqual(["*", 12, "FETCH", "(UID 4)", undefined]);
    // A number before a status kind isn't a code holder.
    expect(response("* 3 OK [X]\r\n").code).toBeUndefined();
    expect(response("* OK [UNCLOSED text\r\n").code).toBeUndefined();
    expect(response("* OK [] x\r\n")).toMatchObject({ code: { name: "", args: "" }, rest: "x" });
    expect(response("* BYE\r\n")).toMatchObject({ tag: "*", kind: "BYE", rest: "" });
    expect(response("+ Ready\r\n")).toMatchObject({ tag: "+", kind: "", rest: "Ready" });
    expect(response("+\r\n")).toMatchObject({ tag: "+", rest: "" });
    expect(response("K1 NO\r\n")).toMatchObject({ tag: "K1", kind: "NO", rest: "" });
  });

  it("turns down a response without a tag or a kind", () => {
    for (const bad of ["(junk) OK\r\n", "\r\n", " OK x\r\n", "K1 \r\n", "K1 (x)\r\n", "* 12\r\n", "K1 3 OK done\r\n", "Ké1 OK\r\n"]) {
      expect(() => response(bad), bad).toThrow(ImapProtocolError);
    }
  });

  it("parses atoms, NIL, quoted strings, lists, sections and literals", () => {
    expect(values('* LIST (\\HasNoChildren \\Sent) "/" "Sent Items"\r\n')).toEqual([["\\HasNoChildren", "\\Sent"], "/", "Sent Items"]);
    expect(values("* LIST () NIL INBOX\r\n")).toEqual([[], null, "INBOX"]);
    expect(values('* X nil Nil "NIL" ""\r\n')).toEqual([null, null, "NIL", ""]);
    expect(values('* X "a \\"b\\" c\\\\d"\r\n')).toEqual(['a "b" c\\d']);
    expect(values("* X (a (b (c)) ())\r\n")).toEqual([["a", ["b", ["c"]], []]]);
    expect(values("* 1 FETCH (BODY[HEADER.FIELDS (FROM TO)] NIL BODY[]<0> x)\r\n")).toEqual([["BODY[HEADER.FIELDS (FROM TO)]", null, "BODY[]<0>", "x"]]);
    expect(values("* X a[b[c]d]e f\r\n")).toEqual(["a[b[c]d]e", "f"]);
    expect(values("* X a[b[c d] e] f\r\n")).toEqual(["a[b[c d] e]", "f"]);
    // An atom ends where a quoted string, a list or a literal starts.
    expect(values('* X a"b" c(d)\r\n')).toEqual(["a", "b", "c", ["d"]]);
    expect(values("* X a{0}\r\n\r\n")).toEqual(["a", new Uint8Array(0)]);
    // A literal's size may take all ten digits.
    expect(parseImapValues(readImapResponse({ text: ["* 1 FETCH (B {1234567890}", ")"], literals: [new ImapLiteralTooLarge(1234567890)] }))).toEqual([["B", new ImapLiteralTooLarge(1234567890)]]);
    const [list] = values("* 1 FETCH (B {3}\r\nabc C {1}\r\nd)\r\n") as [unknown[]];
    expect(list.map((v) => (v instanceof Uint8Array ? `lit:${Buffer.from(v).toString()}` : v))).toEqual(["B", "lit:abc", "C", "lit:d"]);
    const big = parseImapValues(readImapResponse(new ImapReader({ maxLiteral: 1 }).feed(latin("* 1 FETCH (B {3}\r\nabc)\r\n"))[0]!));
    expect(big).toEqual([["B", new ImapLiteralTooLarge(3)]]);
    expect(values("* X  a   b \r\n")).toEqual(["a", "b"]);
    expect(values("* SEARCH\r\n")).toEqual([]);
  });

  it("turns down values that don't read", () => {
    const bad = ["* X (a b\r\n", '* X "abc\r\n', '* X "a\\b"\r\n', '* X "a\\\r\n', "* X a[b c\r\n", "* X {x}\r\n", "* X )\r\n"];
    for (const text of bad) expect(() => values(text), text).toThrow(ImapProtocolError);
    // A literal must be the size it says, and one the reader read.
    const r = readImapResponse({ text: ["* 1 FETCH (B {3}", ")"], literals: [bytes("ab")] });
    expect(() => parseImapValues(r)).toThrow("wrong length");
    expect(() => parseImapValues(readImapResponse({ text: ["* 1 FETCH (B {3}", ")"], literals: [] }))).toThrow("didn't send");
    expect(() => parseImapValues(readImapResponse({ text: ["* 1 FETCH (B", ")"], literals: [bytes("ab")] }))).toThrow("inside an atom");
    expect(() => parseImapValues(readImapResponse({ text: ['* 1 X "a', '"'], literals: [bytes("b")] }))).toThrow("doesn't end");
  });
});

describe("IMAP values the client writes and reads", () => {
  it("quotes an astring, escaping, or sends a literal for anything but printable ASCII", () => {
    expect(imapAstring("plain")).toBe('"plain"');
    expect(imapAstring("")).toBe('""');
    expect(imapAstring('a"b\\c d')).toBe('"a\\"b\\\\c d"');
    expect(imapAstring("~ !")).toBe('"~ !"');
    expect(imapAstring("café")).toEqual({ literal: bytes("café") });
    expect(imapAstring("tab\there")).toEqual({ literal: bytes("tab\there") });
    expect(imapAstring("del\u007f")).toEqual({ literal: bytes("del\u007f") });
    for (const bad of ["a\rb", "a\nb", "a\u0000b"]) expect(() => imapAstring(bad)).toThrow(ImapProtocolError);
  });

  it("writes SEARCH days in UTC and reads INTERNALDATE with its zone", () => {
    expect(imapSearchDate(new Date("2021-02-01T23:30:00Z"))).toBe("1-Feb-2021");
    expect(imapSearchDate(new Date("2021-12-25T00:00:00Z"))).toBe("25-Dec-2021");
    // The day is the UTC one, whatever the local zone says.
    const local = Object.assign(new Date("2021-02-01T23:30:00Z"), { getDate: () => 2 });
    expect(imapSearchDate(local)).toBe("1-Feb-2021");
    expect(imapInternalDate("17-Jul-1996 02:44:25 -0700")).toBe("1996-07-17T09:44:25.000Z");
    expect(imapInternalDate("17-Jul-1996 02:44:25 +0130")).toBe("1996-07-17T01:14:25.000Z");
    expect(imapInternalDate(" 7-Jan-2026 00:00:00 +0000")).toBe("2026-01-07T00:00:00.000Z");
    expect(imapInternalDate("7-Jan-2026 23:59:59 +0000")).toBe("2026-01-07T23:59:59.000Z");
    expect(imapInternalDate("29-Feb-2024 12:00:00 +0000")).toBe("2024-02-29T12:00:00.000Z");
    expect(imapInternalDate("31-Dec-2025 23:00:00 -2359")).toBe("2026-01-01T22:59:00.000Z");
    const bad = [
      "29-Feb-2025 12:00:00 +0000",
      "31-Apr-2026 12:00:00 +0000",
      "00-Jan-2026 12:00:00 +0000",
      "07-Jab-2026 12:00:00 +0000",
      "07-jan-2026 12:00:00 +0000",
      "07-Jan-2026 24:00:00 +0000",
      "07-Jan-2026 12:60:00 +0000",
      "07-Jan-2026 12:00:60 +0000",
      "07-Jan-2026 12:00:00 +2400",
      "07-Jan-2026 12:00:00 +0060",
      "07-Jan-2026 12:00:00",
      "2026-01-07T12:00:00Z",
      "",
      "x07-Jan-2026 12:00:00 +0000",
      "07-Jan-2026 12:00:00 +0000x",
    ];
    for (const value of bad) expect(imapInternalDate(value), value).toBeUndefined();
    expect(imapInternalDate(1234)).toBeUndefined();
    expect(imapInternalDate(null)).toBeUndefined();
  });

  it("writes UID sets as ranges, sorted and without repeats", () => {
    expect(imapSequenceSet([1, 2, 3, 7, 9, 10])).toBe("1:3,7,9:10");
    expect(imapSequenceSet([10, 9, 9, 1])).toBe("1,9:10");
    expect(imapSequenceSet([5])).toBe("5");
    expect(imapSequenceSet([4294967295, 4294967294])).toBe("4294967294:4294967295");
    for (const bad of [[], [0], [4294967296], [1.5], [-1], [Number.NaN]]) expect(() => imapSequenceSet(bad), JSON.stringify(bad)).toThrow(ImapProtocolError);
    expect([isUid(1), isUid(0), isUid(4294967295), isUid(4294967296), isUid("1"), isUid(2.5)]).toEqual([true, false, true, false, false, false]);
  });
});

describe("IMAP header fields", () => {
  const block = (lines: string[]) => bytes(lines.join("\r\n"));

  it("reads fields by name, unfolding, every value of a repeated field, up to the blank line", () => {
    const fields = parseHeaderBlock(
      block([
        "From: Customer <customer1@example.test>",
        "TO: a@example.test,",
        "\tb@example.test",
        "Cc: c@example.test",
        "cc: d@example.test",
        "Message-ID :  <m1@example.test>  ",
        "junk line without a colon",
        "Bad Name: skipped",
        ": skipped",
        "",
        "From: body@example.test",
      ]),
    );
    expect([...fields]).toEqual([
      ["from", ["Customer <customer1@example.test>"]],
      ["to", ["a@example.test,\tb@example.test"]],
      ["cc", ["c@example.test", "d@example.test"]],
      ["message-id", ["<m1@example.test>"]],
    ]);
    // A continuation before any field, or after a skipped line, belongs to nothing.
    expect([...parseHeaderBlock(block([" orphan", "From: a@example.test", "junk", " more"]))]).toEqual([["from", ["a@example.test"]]]);
    expect(parseHeaderBlock(bytes("From: café <a@example.test>\n")).get("from")).toEqual(["café <a@example.test>"]);
    expect(parseHeaderBlock(new Uint8Array([...bytes("From: "), 0xff, ...bytes(" <a@example.test>")])).get("from")).toEqual(["� <a@example.test>"]);
    expect(parseHeaderBlock(new Uint8Array(0)).size).toBe(0);
    expect([...parseHeaderBlock(bytes("From: a@example.test\nTo: b@example.test\n"))]).toEqual([["from", ["a@example.test"]], ["to", ["b@example.test"]]]);
    expect(parseHeaderBlock(bytes(`${"X".repeat(76)}: kept\r\n${"Y".repeat(77)}: skipped\r\n`)).size).toBe(1);
    expect(IMAP_HEADER_FIELDS).toEqual(["FROM", "TO", "CC", "MESSAGE-ID", "IN-REPLY-TO", "REFERENCES"]);
  });

  it("decodes RFC 2047 encoded words in B and Q, in UTF-8 and Latin-1", () => {
    expect(decodeEncodedWords("=?utf-8?B?Q2Fmw6k=?=")).toBe("Café");
    expect(decodeEncodedWords("=?UTF-8?b?Q2Fmw6k?=")).toBe("Café");
    expect(decodeEncodedWords("=?iso-8859-1?Q?Caf=E9_cr=e8me?=")).toBe("Café crème");
    expect(decodeEncodedWords("=?ISO-8859-1?q?a?= \t =?utf-8?q?b?=")).toBe("ab");
    expect(decodeEncodedWords("=?us-ascii?Q?a?= x =?latin1?Q?b?=")).toBe("a x b");
    expect(decodeEncodedWords("Hi =?utf-8?Q?there?= you")).toBe("Hi there you");
    expect(decodeEncodedWords("=?utf-8*en?Q?lang?=")).toBe("lang");
    expect(decodeEncodedWords("=?windows-1252?Q?=80?=")).toBe("€");
    expect(decodeEncodedWords("=?utf8?B?w6k=?= =?ascii?Q?_?=")).toBe("é ");
    expect(decodeEncodedWords("=?iso-8859-15?Q?=A4?= =?cp1252?Q?=80?=")).toBe("€€");
    expect(decodeEncodedWords("=?utf-8?Q??=")).toBe("");
    expect(decodeEncodedWords("no words here")).toBe("no words here");
  });

  it("leaves a word it can't read as it was, and keeps the space around it", () => {
    for (const word of ["=?koi8-r?Q?abc?=", "=?utf-8?B?a?=", "=?utf-8?B?abcde?=", "=?utf-8?B?a===?=", "=?utf-8?B?ab=c?=", "=?utf-8?Q?=ZZ?=", "=?utf-8?Q?a=?=", "=?utf-8?Q?a=4?=", "=?utf-8?X?abc?="]) {
      expect(decodeEncodedWords(word), word).toBe(word);
    }
    expect(decodeEncodedWords("=?utf-8?Q?a?= =?koi8-r?Q?b?= =?utf-8?Q?c?=")).toBe("a =?koi8-r?Q?b?= c");
  });

  it("finds addresses as Gmail does, decoding only a field that holds none otherwise", () => {
    expect(imapAddresses(["Customer <Customer1@Example.TEST>", "b@example.test"])).toEqual(["customer1@example.test", "b@example.test"]);
    // A decoded display name can't pose as an address.
    expect(imapAddresses(["=?utf-8?Q?evil=40example.test?= <real@example.test>"])).toEqual(["real@example.test"]);
    expect(imapAddresses(["=?utf-8?B?PGVuY29kZWRAZXhhbXBsZS50ZXN0Pg==?="])).toEqual(["encoded@example.test"]);
    // A field that holds an address isn't decoded, even when part of it is encoded.
    expect(imapAddresses(["a@example.test, =?utf-8?B?PGVuY29kZWRAZXhhbXBsZS50ZXN0Pg==?="])).toEqual(["a@example.test"]);
    expect(imapAddresses(["Nobody"])).toEqual([]);
    expect(imapAddresses(["=?utf-8?Q?Nobody?="])).toEqual([]);
    expect(imapAddresses(undefined)).toEqual([]);
    expect(imapAddresses([])).toEqual([]);
  });

  it("reads message ids in order", () => {
    expect(messageIds(["<a@example.test> <b@example.test>", "<c@example.test>"])).toEqual(["a@example.test", "b@example.test", "c@example.test"]);
    expect(messageIds(["no id", "<>", "< spaced@example.test>"])).toEqual([]);
    expect(messageIds(undefined)).toEqual([]);
    expect(messageIds([`<${"a".repeat(998)}>`, `<${"b".repeat(999)}>`])).toEqual(["a".repeat(998)]);
    // Each value stands alone: an id can't be pieced together across two.
    expect(messageIds(["<a@example.test", ">"])).toEqual([]);
    expect(messageIds([`${" ".repeat(16_384)}<late@example.test>`])).toEqual([]);
    expect(messageIds([`${" ".repeat(16_360)}<early@example.test>`])).toEqual(["early@example.test"]);
  });
});

/** A mailbox with three messages in INBOX (UIDs 1 to 3) and two in Sent (UIDs 1 and 2). */
function mailbox(over: Partial<ImapFakeMailbox> = {}): ImapFakeMailbox {
  imapMessage.reset();
  const inbox = imapMessage.many(3);
  const sent = imapMessage.many(2).map((m, i) => ({ ...m, uid: i + 1, header: m.header.replace(/From: .*\r\nTo: .*\r\n/, `From: Store <${USER}>\r\nTo: customer${i + 1}@example.test\r\n`) }));
  return {
    username: USER,
    password: PASSWORD,
    folders: [
      { name: "INBOX", attributes: ["\\HasNoChildren"], uidValidity: 7, messages: inbox },
      { name: "Sent", attributes: ["\\HasNoChildren", "\\Sent"], uidValidity: 9, messages: sent },
    ],
    ...over,
  };
}
const folder = (server: ImapFakeServer, name: string) => server.mailbox.folders.find((f) => f.name === name)!;
const clientOptions = (server: ImapFakeServer, over: Partial<ImapClientOptions> = {}): ImapClientOptions => ({ host: HOST, username: USER, password: PASSWORD, connect: server.connect, ...over });
const errorOf = async (promise: Promise<unknown>) => promise.then(() => null, (e: unknown) => e as Error);
const FETCH = (tag: string, set: string) => `${tag} UID FETCH ${set} ${IMAP_FETCH_ITEMS}`;

describe("IMAP settings", () => {
  const base = { host: HOST, username: USER, password: PASSWORD };
  const message = (over: Record<string, unknown>) => {
    try {
      imapSettings({ ...base, ...over } as never);
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(ImapConfigError);
      return (error as Error).message;
    }
  };

  it("takes a host name, a port from 1 to 65535 (993 by default), a username and a password", () => {
    expect(imapSettings(base)).toEqual({ host: HOST, port: 993, username: USER, password: PASSWORD });
    expect(imapSettings({ ...base, host: " IMAP.Example.TEST ", username: ` ${USER} `, port: " 1 " })).toEqual({ host: HOST, port: 1, username: USER, password: PASSWORD });
    expect(imapSettings({ ...base, port: "" }).port).toBe(IMAP_DEFAULT_PORT);
    expect(imapSettings({ ...base, port: 65535 }).port).toBe(65535);
    expect(imapSettings({ ...base, port: "65535" }).port).toBe(65535);
    expect(imapSettings({ ...base, host: "a.bc" }).host).toBe("a.bc");
    expect(imapSettings({ ...base, host: `${"a".repeat(63)}.example.test` }).host).toHaveLength(76);
    expect(imapSettings({ ...base, host: "mail-1.example.xn--p1ai" }).host).toBe("mail-1.example.xn--p1ai");
    const long = (n: number) => `${`${"a".repeat(63)}.`.repeat(3)}${"a".repeat(n)}.test`;
    expect(imapSettings({ ...base, host: long(56) }).host).toHaveLength(253);
    expect(() => imapSettings({ ...base, host: long(57) })).toThrow(ImapConfigError);
    // A password keeps its spaces; it is the mailbox's own.
    expect(imapSettings({ ...base, password: " spaced pass " }).password).toBe(" spaced pass ");
    expect(imapSettings({ ...base, password: "p".repeat(1024) }).password).toHaveLength(1024);
    expect(imapSettings({ ...base, username: `${"u".repeat(307)}@example.test` }).username).toHaveLength(320);
  });

  it("turns down a host that isn't a host name, naming IMAP_HOST and not the value", () => {
    const hostError = "set IMAP_HOST to the IMAP server's host name, such as imap.example.com, without imaps:// or a port";
    for (const host of ["", "  ", "imaps://imap.example.test", "imap.example.test:993", "imap.example.test/", "localhost", "a.b", "-imap.example.test", "imap-.example.test", "imap..example.test", "192.168.0.1", "10.0.0.12", "imap.example.1", "imap.example.test.", "imap_x.example.test", `${"a".repeat(64)}.example.test`, `${"a.".repeat(126)}test`, 5]) {
      expect(message({ host }), String(host)).toBe(hostError);
    }
  });

  it("turns down a port outside 1 to 65535, or that isn't a whole number", () => {
    const portError = "IMAP_PORT must be a whole number from 1 to 65535; leave it empty for 993, IMAP over TLS";
    for (const port of [0, "0", 65536, "65536", -1, "-1", 1.5, "1.5", "abc", "993a", "123456", "000993", Number.NaN]) expect(message({ port }), String(port)).toBe(portError);
  });

  it("turns down a username or password that can't be sent, naming the setting and not the value", () => {
    const userError = "set IMAP_USERNAME to the mailbox's sign-in name, usually its address";
    for (const username of ["", "   ", "a\r\nb", "a\u0000b", "u".repeat(321), 5]) expect(message({ username }), String(username)).toBe(userError);
    const passError = "set IMAP_PASSWORD to the mailbox's app password, on one line with no control characters";
    for (const password of ["", "a\rb", "a\nb", "a\u0000b", "a\tb", "a\u007fb", "p".repeat(1025), 5]) {
      const text = message({ password });
      expect(text, String(password)).toBe(passError);
    }
  });
});

describe("IMAP commands", () => {
  const parts = (request: ImapRequest, tag = "K1") => imapCommandParts(tag, request);

  it("writes each allowed command exactly", () => {
    expect(IMAP_COMMANDS).toEqual(["CAPABILITY", "LOGIN", "LIST", "EXAMINE", "UID SEARCH", "UID FETCH", "LOGOUT"]);
    expect(IMAP_FETCH_ITEMS).toBe("(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC MESSAGE-ID IN-REPLY-TO REFERENCES)])");
    expect(parts({ command: "CAPABILITY" })).toEqual(["K1 CAPABILITY\r\n"]);
    expect(parts({ command: "LOGOUT" }, "K22")).toEqual(["K22 LOGOUT\r\n"]);
    expect(parts({ command: "LIST" })).toEqual(['K1 LIST "" "*"\r\n']);
    expect(parts({ command: "LOGIN", username: USER, password: 'p"w\\' })).toEqual(["K1 LOGIN ", `"${USER}"`, " ", '"p\\"w\\\\"', "\r\n"]);
    expect(parts({ command: "LOGIN", username: USER, password: "päss" })).toEqual(["K1 LOGIN ", `"${USER}"`, " ", { literal: bytes("päss") }, "\r\n"]);
    expect(parts({ command: "EXAMINE", mailbox: 'Sent "Items"' })).toEqual(["K1 EXAMINE ", '"Sent \\"Items\\""', "\r\n"]);
    expect(parts({ command: "EXAMINE", mailbox: "m".repeat(1000) })).toHaveLength(3);
    expect(parts({ command: "UID SEARCH", since: new Date("2021-11-11T15:00:00Z"), afterUid: 0 })).toEqual(["K1 UID SEARCH SINCE 11-Nov-2021\r\n"]);
    expect(parts({ command: "UID SEARCH", since: new Date("2021-11-11T15:00:00Z"), afterUid: 41 })).toEqual(["K1 UID SEARCH UID 42:* SINCE 11-Nov-2021\r\n"]);
    expect(parts({ command: "UID SEARCH", since: new Date("2021-11-11T15:00:00Z"), afterUid: 4294967294 })).toEqual(["K1 UID SEARCH UID 4294967295:* SINCE 11-Nov-2021\r\n"]);
    expect(parts({ command: "UID FETCH", uids: "1:3,7,9:*" })).toEqual([`${FETCH("K1", "1:3,7,9:*")}\r\n`]);
    expect(parts({ command: "UID FETCH", uids: "4294967295" })).toHaveLength(1);
    expect(parts({ command: "UID FETCH", uids: `${"1,".repeat(4095)}11` })).toHaveLength(1);
  });

  it("can't write anything else: no SELECT, STORE, COPY, MOVE, EXPUNGE, APPEND, CREATE or DELETE", () => {
    const forbidden = ["SELECT", "STORE", "UID STORE", "COPY", "UID COPY", "MOVE", "UID MOVE", "EXPUNGE", "UID EXPUNGE", "APPEND", "CREATE", "DELETE", "RENAME", "SUBSCRIBE", "FETCH", "SEARCH", "NOOP", "AUTHENTICATE", "STARTTLS", "ID", "IDLE", "uid fetch", "toString", "__proto__", ""];
    for (const command of forbidden) expect(() => parts({ command } as never), command).toThrow(new ImapConfigError("the IMAP connector only sends its listed commands"));
    expect(() => parts({} as never)).toThrow(ImapConfigError);
    expect(() => parts(null as never)).toThrow(ImapConfigError);
    // An allowed command can't carry anything it wasn't made to.
    expect(() => parts({ command: "UID FETCH", uids: "1", items: "BODY[]" } as never)).toThrow("UID FETCH doesn't take items");
    expect(() => parts({ command: "LIST", pattern: "%" } as never)).toThrow("LIST doesn't take pattern");
    expect(() => parts({ command: "LOGOUT", a: 1, b: 2, c: 3, d: 4 } as never)).toThrow(new ImapConfigError("LOGOUT doesn't take a, b, c"));
    // Nor another command's arguments.
    const valid: ImapRequest[] = [
      { command: "CAPABILITY" },
      { command: "LOGIN", username: USER, password: PASSWORD },
      { command: "LIST" },
      { command: "EXAMINE", mailbox: "INBOX" },
      { command: "UID SEARCH", since: new Date("2021-11-11T15:00:00Z"), afterUid: 0 },
      { command: "UID FETCH", uids: "1" },
      { command: "LOGOUT" },
    ];
    for (const request of valid) {
      expect(() => parts(request), request.command).not.toThrow();
      for (const key of ["username", "password", "mailbox", "since", "afterUid", "uids"].filter((k) => !(k in request))) {
        expect(() => parts({ ...request, [key]: "x" } as never), `${request.command} ${key}`).toThrow(new ImapConfigError(`${request.command} doesn't take ${key}`));
      }
    }
  });

  it("checks every argument before writing a byte", () => {
    for (const tag of ["A1", "K", "K1 ", "K1234567890", "k1"]) expect(() => parts({ command: "CAPABILITY" }, tag), tag).toThrow("a command tag is K and a number");
    expect(parts({ command: "CAPABILITY" }, "K123456789")).toEqual(["K123456789 CAPABILITY\r\n"]);
    for (const uids of ["", "0", "1:0", "*", "1,", ",1", "1 2", "1;STORE", "a", "01", " 1", "1:*:2", "12345678901", "1".repeat(8193), `${"1,".repeat(4096)}1`]) {
      expect(() => parts({ command: "UID FETCH", uids }), uids.slice(0, 20)).toThrow("UID FETCH takes a set of UIDs");
    }
    expect(() => parts({ command: "UID FETCH", uids: 5 } as never)).toThrow(ImapConfigError);
    for (const since of [new Date("x"), "2021-01-01", null]) expect(() => parts({ command: "UID SEARCH", since, afterUid: 0 } as never)).toThrow("UID SEARCH takes a day to search since");
    for (const afterUid of [-1, 1.5, 4294967295, "1", null]) expect(() => parts({ command: "UID SEARCH", since: new Date(), afterUid } as never), String(afterUid)).toThrow("UID SEARCH takes the last UID read, or 0");
    for (const mailbox of ["", "m".repeat(1001), 5]) expect(() => parts({ command: "EXAMINE", mailbox } as never)).toThrow("EXAMINE takes a folder name");
    expect(() => parts({ command: "EXAMINE", mailbox: "a\r\nK9 STORE" })).toThrow(ImapProtocolError);
    expect(() => parts({ command: "LOGIN", username: USER, password: 5 } as never)).toThrow("LOGIN takes a username and a password");
    expect(() => parts({ command: "LOGIN", username: 5, password: PASSWORD } as never)).toThrow("LOGIN takes a username and a password");
  });
});

describe("IMAP client", () => {
  it("connects, checks the server, signs in and reads, sending only what it must", async () => {
    const server = imapFakeServer(mailbox(), { chunkSize: 3 });
    const connection = await imapClient(clientOptions(server)).open();
    expect(await connection.list()).toEqual([
      { name: "INBOX", attributes: ["\\hasnochildren"] },
      { name: "Sent", attributes: ["\\hasnochildren", "\\sent"] },
    ]);
    expect(await connection.examine("INBOX")).toEqual({ uidValidity: "7", uidNext: 4 });
    expect(await connection.search(new Date("2021-11-11T00:00:00Z"), 0)).toEqual([1, 2, 3]);
    expect(await connection.search(new Date("2021-11-11T00:00:00Z"), 1)).toEqual([2, 3]);
    const fetched = await connection.fetch("2:3");
    expect(fetched.map((m) => [m.uid, m.flags, m.internalDate, m.size])).toEqual([
      [2, ["\\Seen"], imapDate("2026-01-01T00:02:00.000Z"), bytes(folder(server, "INBOX").messages[1]!.header).length + 100],
      [3, ["\\Seen"], imapDate("2026-01-01T00:03:00.000Z"), bytes(folder(server, "INBOX").messages[2]!.header).length + 100],
    ]);
    // Only the fields asked for come back: no Subject.
    expect(Buffer.from(fetched[0]!.header as Uint8Array).toString()).toBe("From: \"Test Customer 2\" <customer2@example.test>\r\nTo: Store <store@example.test>\r\nMessage-ID: <message-2@example.test>\r\n\r\n");
    await connection.close();
    expect(server.lines).toEqual([
      "K1 CAPABILITY",
      `K2 LOGIN "${USER}" "${PASSWORD}"`,
      'K3 LIST "" "*"',
      'K4 EXAMINE "INBOX"',
      "K5 UID SEARCH SINCE 11-Nov-2021",
      "K6 UID SEARCH UID 2:* SINCE 11-Nov-2021",
      FETCH("K7", "2:3"),
      "K8 LOGOUT",
    ]);
    expect(server.forbidden).toEqual([]);
    expect(server.closed).toBe(1);
  });

  it("sends a password outside printable ASCII as a literal, once the server says to go on", async () => {
    const password = `päss-${"x".repeat(8)}`;
    const server = imapFakeServer(mailbox({ password }), { chunkSize: 2 });
    const connection = await imapClient(clientOptions(server, { password })).open();
    await connection.close();
    const length = bytes(password).length;
    expect(server.lines[1]).toBe(`K2 LOGIN "${USER}" {${length}}\r\n${Buffer.from(password).toString("latin1")}`);
    expect(server.commands[1]).toMatchObject({ tag: "K2", command: "LOGIN" });
  });

  it("turns a LOGIN the server turns down into a config error naming the settings and app passwords, never the password", async () => {
    for (const [script, said] of [
      [undefined, "NO AUTHENTICATIONFAILED"],
      [`K2 BAD [${"x".repeat(41)}] ${PASSWORD}\r\n`, "BAD"],
      [`K2 NO [w3ird] ${PASSWORD}\r\n`, "NO"],
      [`K2 NO [weird code] ${PASSWORD}\r\n`, "NO WEIRD"],
      [`K2 NO ${PASSWORD}\r\n`, "NO"],
    ] as const) {
      const server = imapFakeServer(mailbox({ password: "other" }), { script: (c) => (c.command === "LOGIN" ? script : undefined) });
      const error = await errorOf(imapClient(clientOptions(server)).open());
      expect(error).toBeInstanceOf(ImapConfigError);
      expect(error!.message).toBe(
        `the IMAP server turned down IMAP_USERNAME and IMAP_PASSWORD (${said}); check both, and use an app password if the provider asks for one, as most do once two-step sign-in is on`,
      );
      expect(error!.message).not.toContain(PASSWORD);
      expect(server.closed).toBe(1);
    }
  });

  it("stops at a LOGIN turned down before its literal was asked for", async () => {
    const password = "p\u00e4ss";
    const writes: string[] = [];
    const scripted = {
      connect: async () => {
        const t = new ImapFakeTransport(
          (data) => {
            const text = Buffer.from(data).toString("latin1");
            writes.push(text);
            if (text.startsWith("K1 ")) t.emit("data", bytes("* CAPABILITY IMAP4rev1\r\nK1 OK done\r\n"));
            if (text.startsWith("K2 LOGIN")) t.emit("data", bytes("K2 NO [AUTHENTICATIONFAILED] Invalid\r\n"));
          },
          () => undefined,
        );
        t.emit("data", bytes("* OK ready\r\n"));
        return t;
      },
    };
    const error = await errorOf(imapClient({ host: HOST, username: USER, password, connect: scripted.connect }).open());
    expect(error).toBeInstanceOf(ImapConfigError);
    expect(error!.message).toContain("(NO AUTHENTICATIONFAILED)");
    // The literal itself was never written.
    expect(writes).toEqual(["K1 CAPABILITY\r\n", `K2 LOGIN "${USER}" {${bytes(password).length}}\r\n`]);
  });

  it("won't sign in where LOGIN is turned off, and skips it on a PREAUTH greeting", async () => {
    const disabled = imapFakeServer(mailbox(), { capabilities: ["IMAP4rev1", "LOGINDISABLED", "STARTTLS"] });
    const error = await errorOf(imapClient(clientOptions(disabled)).open());
    expect(error).toEqual(new ImapConfigError(`the IMAP server at ${HOST}:993 doesn't take LOGIN; IMAP_USERNAME and IMAP_PASSWORD can't sign in there`));
    expect(disabled.lines).toEqual(["K1 CAPABILITY"]);
    const preauth = imapFakeServer(mailbox(), { greeting: "* PREAUTH ready\r\n", script: (c) => (c.command === "LIST" ? '* LIST () "/" INBOX\r\n{tag} OK done\r\n' : undefined) });
    const connection = await imapClient(clientOptions(preauth)).open();
    expect(await connection.list()).toEqual([{ name: "INBOX", attributes: [] }]);
    expect(preauth.lines).toEqual(["K1 CAPABILITY", 'K2 LIST "" "*"']);
    // IMAP4rev2 alone is spoken too.
    const rev2 = imapFakeServer(mailbox(), { capabilities: ["imap4rev2"] });
    await (await imapClient(clientOptions(rev2)).open()).close();
    expect(rev2.lines[1]).toMatch(/^K2 LOGIN /);
  });

  it("turns away a server that doesn't speak IMAP4rev1 or greets with BYE", async () => {
    const old = imapFakeServer(mailbox(), { capabilities: ["IMAP2"] });
    expect(await errorOf(imapClient(clientOptions(old)).open())).toEqual(new ImapError(`the server at ${HOST}:993 doesn't speak IMAP4rev1`, false));
    expect(old.closed).toBe(1);
    for (const [greeting, text] of [
      ["* BYE [UNAVAILABLE] busy\r\n", " UNAVAILABLE (BYE)"],
      ["* BYE busy\r\n", " (BYE)"],
      ["* NO go away\r\n", ""],
      ["K1 OK early\r\n", ""],
    ] as const) {
      const server = imapFakeServer(mailbox(), { greeting });
      const error = (await errorOf(imapClient(clientOptions(server)).open())) as ImapError;
      expect([error.message, error.retryable], greeting).toEqual([`the IMAP server at ${HOST}:993 turned the connection away${text}`, true]);
      expect(server.lines).toEqual([]);
    }
  });

  it("names the host, port and error code when it can't connect, never the password", async () => {
    for (const [code, shown] of [["EHOSTUNREACH", " (EHOSTUNREACH)"], ["CERT_HAS_EXPIRED", " (CERT_HAS_EXPIRED)"], ["not a code", ""], [undefined, ""]] as const) {
      const failing = async () => {
        throw Object.assign(new Error(`connect failed for ${PASSWORD}`), code === undefined ? {} : { code });
      };
      const error = (await errorOf(imapClient({ host: HOST, port: "1993", username: USER, password: PASSWORD, connect: failing }).open())) as ImapError;
      expect(error).toBeInstanceOf(ImapError);
      expect([error.message, error.retryable]).toEqual([`couldn't open a TLS connection to the IMAP server at ${HOST}:1993${shown}; check IMAP_HOST and IMAP_PORT`, true]);
      expect(error.message).not.toContain(PASSWORD);
    }
    let asked: unknown;
    const remember = async (target: unknown) => {
      asked = target;
      throw new Error("no");
    };
    await errorOf(imapClient({ host: HOST, username: USER, password: PASSWORD, connect: remember, timeoutMs: 5 }).open());
    expect(asked).toEqual({ host: HOST, port: 993, timeoutMs: 5 });
    await errorOf(imapClient({ host: HOST, username: USER, password: PASSWORD, connect: remember }).open());
    expect(asked).toEqual({ host: HOST, port: 993, timeoutMs: IMAP_TIMEOUT_MS });
    expect(IMAP_TIMEOUT_MS).toBe(60_000);
  });

  it("checks its settings before connecting", () => {
    let connected = false;
    const connect = async () => {
      connected = true;
      throw new Error("never");
    };
    expect(() => imapClient({ host: "imaps://x", username: USER, password: PASSWORD, connect })).toThrow(ImapConfigError);
    expect(() => imapClient({ host: HOST, port: 0, username: USER, password: PASSWORD, connect })).toThrow(ImapConfigError);
    expect(connected).toBe(false);
  });

  it("gives up on a server that stops answering, and on one that drops or breaks the connection", async () => {
    const hangs = imapFakeServer(mailbox(), { script: (c) => (c.command === "LIST" ? "hang" : undefined) });
    const connection = await imapClient(clientOptions(hangs, { timeoutMs: 20 })).open();
    const error = (await errorOf(connection.list())) as ImapError;
    expect([error.message, error.retryable]).toEqual([`the IMAP server at ${HOST}:993 didn't answer within 0 s`, true]);
    expect(hangs.closed).toBe(1);
    // Later commands fail the same way, and closing doesn't throw.
    expect(await errorOf(connection.examine("INBOX"))).toBe(error);
    await connection.close();
    expect(hangs.lines.at(-1)).toBe('K3 LIST "" "*"');
    // A close that comes after the failure doesn't replace it.
    let socket: ImapFakeTransport | undefined;
    const late = imapFakeServer(mailbox(), { script: (c) => (c.command === "LIST" ? "hang" : undefined) });
    const lateConnection = await imapClient(clientOptions({ ...late, connect: async () => (socket = (await late.connect()) as ImapFakeTransport) }, { timeoutMs: 20 })).open();
    const first = await errorOf(lateConnection.list());
    socket!.emit("close");
    await new Promise((r) => setTimeout(r, 10));
    expect(await errorOf(lateConnection.examine("INBOX"))).toBe(first);

    const slowGreeting = imapFakeServer(mailbox(), { greeting: "" });
    expect(((await errorOf(imapClient(clientOptions(slowGreeting, { timeoutMs: 1500 })).open())) as Error).message).toBe(`the IMAP server at ${HOST}:993 didn't answer within 2 s`);

    const drops = imapFakeServer(mailbox(), { script: (c) => (c.command === "EXAMINE" ? "close" : undefined) });
    const dropped = await imapClient(clientOptions(drops)).open();
    expect(await errorOf(dropped.examine("INBOX"))).toEqual(new ImapError(`the IMAP server at ${HOST}:993 closed the connection`, true));

    const breaks = imapFakeServer(mailbox());
    const broken = await imapClient(clientOptions({ ...breaks, connect: async () => {
      const t = await breaks.connect();
      setTimeout(() => t.emit("error", Object.assign(new Error(`reset ${PASSWORD}`), { code: "ECONNRESET" })), 5);
      return t;
    } })).open();
    const reset = (await errorOf(new Promise((_, reject) => setTimeout(() => broken.list().then(() => reject(new Error("listed")), reject), 30)))) as ImapError;
    expect([reset.message, reset.retryable]).toEqual([`lost the connection to the IMAP server at ${HOST}:993 (ECONNRESET)`, true]);
    const plain = imapFakeServer(mailbox());
    const plainConnection = await imapClient(clientOptions({ ...plain, connect: async () => {
      const t = await plain.connect();
      setTimeout(() => t.emit("error", new Error("no code")), 5);
      return t;
    } })).open();
    await new Promise((r) => setTimeout(r, 20));
    expect(((await errorOf(plainConnection.list())) as Error).message).toBe(`lost the connection to the IMAP server at ${HOST}:993`);
  });

  it("stops on a BYE in the middle of a command, a reply to a command it didn't send, or a stray continuation", async () => {
    const cases: [string, ImapError][] = [
      ["* BYE [ALERT] shutting down\r\n", new ImapError(`the IMAP server at ${HOST}:993 ended the session ALERT`, true)],
      ["* BYE bye\r\n", new ImapError(`the IMAP server at ${HOST}:993 ended the session`, true)],
      ["K9 OK what\r\n", new ImapError(`the IMAP server at ${HOST}:993 answered a command it wasn't sent`, false)],
      ["+ more\r\n", new ImapError(`the IMAP server at ${HOST}:993 asked for a literal that wasn't sent`, false)],
      ["* 1 FETCH (UID \u0000)\r\n", new ImapError(`the IMAP server at ${HOST}:993 didn't speak IMAP: the server sent a NUL byte`, false)],
      ["(nonsense\r\n", new ImapError(`the IMAP server at ${HOST}:993 didn't speak IMAP: the server sent a response without a tag`, false)],
    ];
    for (const [answer, expected] of cases) {
      const server = imapFakeServer(mailbox(), { script: (c) => (c.command === "LIST" ? answer : undefined) });
      const connection = await imapClient(clientOptions(server)).open();
      const error = (await errorOf(connection.list())) as ImapError;
      expect([error.message, error.retryable], answer).toEqual([expected.message, expected.retryable]);
      expect(server.closed, answer).toBe(1);
      await connection.close();
      // Nothing more is sent on a connection that failed, LOGOUT included.
      expect(server.lines.at(-1)).toBe('K3 LIST "" "*"');
    }
  });

  it("explains a command the server answers NO or BAD", async () => {
    const server = imapFakeServer(mailbox(), {
      script: (c) => (c.command === "EXAMINE" && c.args === '"Gone"' ? "{tag} NO [NONEXISTENT] gone\r\n" : c.command === "EXAMINE" && c.args === '"Odd"' ? "{tag} BAD what\r\n" : undefined),
    });
    const connection = await imapClient(clientOptions(server)).open();
    await connection.list();
    expect(await errorOf(connection.examine("Gone"))).toEqual(new ImapError(`the IMAP server at ${HOST}:993 answered EXAMINE with NO NONEXISTENT`, true));
    const bad = (await errorOf(connection.examine("Odd"))) as ImapError;
    expect([bad.message, bad.retryable]).toEqual([`the IMAP server at ${HOST}:993 answered EXAMINE with BAD`, false]);
    expect(await connection.examine("Sent")).toEqual({ uidValidity: "9", uidNext: 3 });
    await connection.close();
  });

  it("needs a UIDVALIDITY from EXAMINE, and reads UIDNEXT when there is one", async () => {
    const answers = new Map<string, string>([
      ['"A"', "* OK [UIDNEXT 5] x\r\n{tag} OK done\r\n"],
      ['"B"', "* OK [UIDVALIDITY 0] x\r\n{tag} OK done\r\n"],
      ['"C"', "* OK [UIDVALIDITY 4294967296] x\r\n{tag} OK done\r\n"],
      ['"D"', "* OK [UIDVALIDITY abc] x\r\n{tag} OK done\r\n"],
      ['"E"', "* NO [UIDVALIDITY 5] x\r\n{tag} OK done\r\n"],
      ['"F"', "* OK [UIDVALIDITY  4294967295 ] x\r\n* OK [UIDNEXT 0] y\r\n{tag} OK done\r\n"],
      ['"G"', "* OK [UIDVALIDITY 12] x\r\n* OK [UIDNEXT 4294967295] y\r\n{tag} OK done\r\n"],
      ['"H"', "* OK [UIDVALIDITY 12] x\r\n* OK [UIDNEXT 4294967296] y\r\n{tag} OK done\r\n"],
      ['"I"', "* OK [UIDVALIDITY 12] x\r\n* OK [UIDNEXT x] y\r\n{tag} OK done\r\n"],
    ]);
    const results: unknown[] = [];
    for (const [name, answer] of answers) {
      const server = imapFakeServer(mailbox(), { script: (c) => (c.command === "EXAMINE" ? answer : undefined) });
      const connection = await imapClient(clientOptions(server)).open();
      results.push(await connection.examine(name.slice(1, -1)).then((s) => s, (e: Error) => e.message));
      await connection.close();
    }
    const missing = `the IMAP server at ${HOST}:993 didn't give a folder's UIDVALIDITY`;
    expect(results).toEqual([missing, missing, missing, missing, missing, { uidValidity: "4294967295", uidNext: null }, { uidValidity: "12", uidNext: 4294967295 }, { uidValidity: "12", uidNext: null }, { uidValidity: "12", uidNext: null }]);
  });

  it("reads LIST names quoted, as atoms or as literals, and skips entries that don't read", async () => {
    const list = [
      '* LIST (\\Noselect \\HasChildren) "/" "[Gmail]"',
      '* LIST (\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"',
      "* LIST () NIL INBOX",
      '* LIST () "." {9}\r\nINBOX.Bin',
      '* LIST () "." {3}\r\na\nb',
      '* LIST () "/" ""',
      '* LIST \\Bad "/" "x"',
      '* LIST () "/" NIL',
      '* LIST () "/"',
      `* LIST () "/" "${"n".repeat(1001)}"`,
      `* LIST () "/" "${"n".repeat(1000)}"`,
      '* LSUB () "/" "Other"',
      "{tag} OK done",
      "",
    ].join("\r\n");
    const server = imapFakeServer(mailbox(), { script: (c) => (c.command === "LIST" ? list : undefined) });
    const connection = await imapClient(clientOptions(server)).open();
    expect(await connection.list()).toEqual([
      { name: "[Gmail]", attributes: ["\\noselect", "\\haschildren"] },
      { name: "[Gmail]/Sent Mail", attributes: ["\\hasnochildren", "\\sent"] },
      { name: "INBOX", attributes: [] },
      { name: "INBOX.Bin", attributes: [] },
      { name: "n".repeat(1000), attributes: [] },
    ]);
    await connection.close();
    const broken = imapFakeServer(mailbox(), { script: (c) => (c.command === "LIST" ? '* LIST (\\x "/" y\r\n{tag} OK done\r\n' : undefined) });
    const b = await imapClient(clientOptions(broken)).open();
    const error = (await errorOf(b.list())) as ImapError;
    expect([error.message, error.retryable]).toEqual([`the IMAP server at ${HOST}:993 sent a LIST response that doesn't read (the server sent a list that doesn't end)`, false]);
    expect(broken.closed).toBe(1);
  });

  it("reads SEARCH results, dropping what isn't past the last UID read", async () => {
    const answer = (c: { command: string }) => (c.command === "UID SEARCH" ? "* SEARCH 9 3 5\r\n* SEARCH 5 12\r\n* SEARCH\r\n{tag} OK done\r\n" : undefined);
    const server = imapFakeServer(mailbox(), { script: answer });
    const connection = await imapClient(clientOptions(server)).open();
    expect(await connection.search(new Date("2026-01-01T00:00:00Z"), 0)).toEqual([3, 5, 9, 12]);
    // "UID 6:*" brings in the last message even when it is older; it is dropped, as is the UID itself.
    expect(await connection.search(new Date("2026-01-01T00:00:00Z"), 5)).toEqual([9, 12]);
    expect(await connection.search(new Date("2026-01-01T00:00:00Z"), 12)).toEqual([]);
    await connection.close();
    for (const bad of ["0", "x", "4294967296", "(1)", "12345678901"]) {
      const s = imapFakeServer(mailbox(), { script: (c) => (c.command === "UID SEARCH" ? `* SEARCH 1 ${bad}\r\n{tag} OK done\r\n` : undefined) });
      const c = await imapClient(clientOptions(s)).open();
      expect(((await errorOf(c.search(new Date(), 0))) as Error).message, bad).toBe(`the IMAP server at ${HOST}:993 answered UID SEARCH with something that isn't a UID`);
      expect(s.closed).toBe(1);
    }
    const unreadable = imapFakeServer(mailbox(), { script: (c) => (c.command === "UID SEARCH" ? '* SEARCH "1\r\n{tag} OK done\r\n' : undefined) });
    const u = await imapClient(clientOptions(unreadable)).open();
    expect(await errorOf(u.search(new Date(), 0))).toBeInstanceOf(ImapError);
  });

  it("reads FETCH responses, merged per message, sorted, and past the last UID read", async () => {
    const lit = "From: a@example.test\r\n\r\n";
    const answer = [
      `* 3 FETCH (UID 30 FLAGS (\\Seen \\Flagged) INTERNALDATE "01-Feb-2026 10:00:00 +0000" RFC822.SIZE 900 BODY[HEADER.FIELDS (FROM TO CC MESSAGE-ID IN-REPLY-TO REFERENCES)] {${lit.length}}\r\n${lit})`,
      "* 1 FETCH (UID 10 FLAGS ())",
      '* 1 FETCH (INTERNALDATE "01-Jan-2026 10:00:00 +0000" BODY[HEADER.FIELDS ("From")] "From: q@example.test")',
      "* 2 FETCH (FLAGS (\\Seen))",
      "* 4 FETCH (UID 40 RFC822.SIZE big BODY[HEADER.FIELDS (FROM)] NIL)",
      "* 5 FETCH (UID 0)",
      "* 6 FETCH (UID x)",
      "* 7 FETCH (uid 5 flags NIL)",
      "* 9 EXISTS",
      "* FETCH (UID 99)",
      "{tag} OK done",
      "",
    ].join("\r\n");
    const server = imapFakeServer(mailbox(), { script: (c) => (c.command === "UID FETCH" ? answer : undefined) });
    const connection = await imapClient(clientOptions(server)).open();
    const all = await connection.fetch("1:*");
    expect(all.map((m) => ({ ...m, header: m.header instanceof Uint8Array ? Buffer.from(m.header).toString() : m.header }))).toEqual([
      { uid: 5, flags: [], internalDate: null, size: null, header: null },
      { uid: 10, flags: [], internalDate: "01-Jan-2026 10:00:00 +0000", size: null, header: "From: q@example.test" },
      { uid: 30, flags: ["\\Seen", "\\Flagged"], internalDate: "01-Feb-2026 10:00:00 +0000", size: 900, header: lit },
      { uid: 40, flags: [], internalDate: null, size: null, header: null },
    ]);
    // "n:*" past the end answers with the last message, which was read before.
    expect((await connection.fetch({ after: 30 })).map((m) => m.uid)).toEqual([40]);
    expect(await connection.fetch({ after: 40 })).toEqual([]);
    const sent = server.lines.length;
    expect(await connection.fetch({ after: 4294967295 })).toEqual([]);
    expect(server.lines).toHaveLength(sent);
    expect(server.lines.slice(-3)).toEqual([FETCH("K3", "1:*"), FETCH("K4", "31:*"), FETCH("K5", "41:*")]);
    await connection.close();
  });

  it("keeps an oversized header literal as its size, and stops on a FETCH that doesn't read", async () => {
    const big = "x".repeat(40);
    const server = imapFakeServer(mailbox(), { script: (c) => (c.command === "UID FETCH" ? `* 1 FETCH (UID 1 BODY[HEADER.FIELDS (FROM)] {40}\r\n${big})\r\n{tag} OK done\r\n` : undefined) });
    const connection = await imapClient(clientOptions(server, { maxLiteral: 39, maxLine: 1000 })).open();
    expect((await connection.fetch("1"))[0]!.header).toEqual(new ImapLiteralTooLarge(40));
    await connection.close();
    for (const answer of ["* 1 FETCH (UID 1 FLAGS)\r\n{tag} OK done\r\n", "* 1 FETCH UID\r\n{tag} OK done\r\n", "* 1 FETCH (UID\r\n{tag} OK done\r\n"]) {
      const s = imapFakeServer(mailbox(), { script: (c) => (c.command === "UID FETCH" ? answer : undefined) });
      const c = await imapClient(clientOptions(s)).open();
      const error = (await errorOf(c.fetch("1"))) as ImapError;
      expect([error.retryable, s.closed], answer).toEqual([false, 1]);
      expect(error.message).toMatch(new RegExp(`^the IMAP server at ${HOST.replace(/\./g, "\\.")}:993 sent a FETCH response that doesn't read`));
    }
    const tooLong = imapFakeServer(mailbox(), { script: (c) => (c.command === "UID FETCH" ? `* SEARCH ${"1 ".repeat(40)}\r\n{tag} OK done\r\n` : undefined) });
    const t = await imapClient(clientOptions(tooLong, { maxLine: 50 })).open();
    expect(((await errorOf(t.fetch("1"))) as Error).message).toBe(`the IMAP server at ${HOST}:993 didn't speak IMAP: the server sent a line longer than 50 bytes`);
  });

  it("reads a server that sends text instead of bytes", async () => {
    const server = imapFakeServer(mailbox());
    const connection = await imapClient(clientOptions({ ...server, connect: async () => {
      const t = await server.connect();
      const real = t.emit.bind(t);
      (t as unknown as { emit: (e: string, v?: unknown) => void }).emit = (event: string, value?: unknown) =>
        event === "data" ? real("data", Buffer.from(value as Uint8Array).toString("latin1") as never) : real(event as "close");
      return t;
    } })).open();
    expect((await connection.list()).map((f) => f.name)).toEqual(["INBOX", "Sent"]);
    await connection.close();
  });
});

/**
 * The ClientHello imapTlsConnect sends to localhost, read for its TLS
 * versions, SNI and ALPN, with Node's floor lowered to TLS 1.0 and
 * OpenSSL's security level to 0, so only the client's own pin holds it at 1.2.
 */
async function helloFor(): Promise<{ versions: number[]; sni: string; alpn: string }> {
  let seen: Buffer | null = null;
  const server = createServer((socket) => socket.once("data", (d: Buffer) => ((seen = d), socket.destroy())));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const [floor, ciphers] = [tls.DEFAULT_MIN_VERSION, tls.DEFAULT_CIPHERS];
  tls.DEFAULT_MIN_VERSION = "TLSv1";
  tls.DEFAULT_CIPHERS = "DEFAULT@SECLEVEL=0";
  try {
    await imapTlsConnect({ host: "localhost", port: (server.address() as { port: number }).port, timeoutMs: 5000 }).then((s) => s.destroy(), () => undefined);
  } finally {
    tls.DEFAULT_MIN_VERSION = floor;
    tls.DEFAULT_CIPHERS = ciphers;
    server.close();
  }
  const b = seen! as Buffer;
  // Record (5) and handshake (4) headers, version (2), random (32), then session id, ciphers and compression.
  let at = 5 + 4 + 2 + 32;
  at += 1 + b[at]!;
  at += 2 + b.readUInt16BE(at);
  at += 1 + b[at]!;
  const end = at + 2 + b.readUInt16BE(at);
  at += 2;
  const out = { versions: [] as number[], sni: "", alpn: "" };
  while (at < end) {
    const type = b.readUInt16BE(at);
    const data = b.subarray(at + 4, at + 4 + b.readUInt16BE(at + 2));
    if (type === 0x2b) for (let i = 1; i < data.length; i += 2) out.versions.push(data.readUInt16BE(i));
    if (type === 0x00) out.sni = data.subarray(5).toString("latin1");
    if (type === 0x10) out.alpn = data.subarray(3).toString("latin1");
    at += 4 + data.length;
  }
  return out;
}

describe("IMAP over TLS", () => {
  const listen = (handler: (socket: import("node:net").Socket) => void) =>
    new Promise<{ server: Server; port: number }>((resolve) => {
      const server = createServer(handler);
      server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
    });

  it("fails with a code when the far end doesn't speak TLS, isn't there, or never finishes the handshake", async () => {
    const plain = await listen((socket) => socket.end("* OK plaintext IMAP\r\n"));
    const notTls = await errorOf(imapTlsConnect({ host: "localhost", port: plain.port, timeoutMs: 5000 }));
    expect(notTls).toBeInstanceOf(Error);
    expect(typeof (notTls as { code?: unknown }).code).toBe("string");
    plain.server.close();

    const closed = await listen(() => undefined);
    const port = closed.port;
    await new Promise((r) => closed.server.close(r));
    // Nothing listens there any more: the system's own code for a connection turned down.
    expect((await errorOf(imapTlsConnect({ host: "127.0.0.1", port, timeoutMs: 5000 })) as { code?: unknown }).code).toMatch(/^ECONN[A-Z]+$/);

    const silent = await listen(() => undefined);
    const timedOut = await errorOf(imapTlsConnect({ host: "127.0.0.1", port: silent.port, timeoutMs: 50 }));
    expect([timedOut?.message, (timedOut as { code?: unknown }).code]).toEqual(["timed out", "ETIMEDOUT"]);
    silent.server.close();
    // What the client offers: TLS 1.2 or later even where Node's default allows less, the host name as SNI, and ALPN "imap".
    const hello = await helloFor();
    expect(hello.versions).toEqual([0x0304, 0x0303]);
    expect(hello.sni).toBe("localhost");
    expect(hello.alpn).toBe("imap");
    const viaClient = (await errorOf(imapClient({ host: "localhost.test", port: closed.port, username: USER, password: PASSWORD, timeoutMs: 2000 }).open())) as ImapError;
    expect(viaClient.retryable).toBe(true);
    expect(viaClient.message).toMatch(/^couldn't open a TLS connection to the IMAP server at localhost\.test:\d+/);
  });
});

describe("IMAP events", () => {
  const normalizer = imapNormalizer(KEY);
  const { correspondent } = gmailNormalizer({ correspondentKey: KEY });
  const inbox: ImapMessagePlace = { role: "inbox", mailbox: "INBOX", uidValidity: "7" };
  const header = (lines: string[]) => bytes(`${lines.join("\r\n")}\r\n\r\n`);
  const fetched = (over: Partial<ImapFetched> = {}): ImapFetched => ({
    uid: 4,
    flags: ["\\Seen"],
    internalDate: "17-Jul-2026 02:44:25 -0700",
    size: 900,
    header: header(["From: Customer <customer1@example.test>", "To: Store <store@example.test>, b@example.test", "Cc: c@example.test", "Message-ID: <m1@example.test>"]),
    ...over,
  });
  const one = (over: Partial<ImapFetched> = {}, place = inbox) => normalizer.message(place, fetched(over), RECEIVED)[0]!;

  it("logs a message as Gmail does: references, never addresses, names or subjects", () => {
    const e = one();
    expect(e).toEqual({
      id: e.idempotencyKey.replace(/[^A-Za-z0-9_.:-]/g, "_").replace(/^imap_email:/, "imap_email_"),
      type: "communication.message_logged",
      occurredAt: "2026-07-17T09:44:25.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^imap_email:message:[0-9a-f]{32}:[0-9a-f]{16}$/),
      payload: {
        channel: "email",
        messageId: expect.stringMatching(/^imap_email:message:[0-9a-f]{32}$/),
        threadId: expect.stringMatching(/^imap_email:thread:[0-9a-f]{32}$/),
        direction: "received",
        sentAt: "2026-07-17T09:44:25.000Z",
        from: correspondent("customer1@example.test"),
        to: [correspondent("store@example.test"), correspondent("b@example.test")],
        cc: [correspondent("c@example.test")],
        recipientCount: 3,
        labelIds: ["INBOX"],
      },
    });
    expect(e.id.startsWith("imap_email_message:")).toBe(true);
    synthetic(e.payload);
    const text = JSON.stringify(e);
    for (const leaked of ["customer1", "Customer", "store@", "m1@example.test", "Ring"]) expect(text).not.toContain(leaked);
    // The message's reference is keyed: another instance's key gives another.
    expect(imapNormalizer("z".repeat(32)).message(inbox, fetched(), RECEIVED)[0]!.payload.messageId).not.toBe(e.payload.messageId);
    expect(() => imapNormalizer("short")).toThrow("CORRESPONDENT_HASH_KEY");
    // The key is read as Gmail's is, trimmed.
    expect(imapNormalizer(` ${KEY} `).message(inbox, fetched(), RECEIVED)).toEqual([e]);
  });

  it("reads direction from the folder and labels from the flags, each a version of its own", () => {
    const sent = one({}, { role: "sent", mailbox: "Sent", uidValidity: "9" });
    expect([sent.payload.direction, sent.payload.labelIds]).toEqual(["sent", ["SENT"]]);
    expect(sent.payload.messageId).toBe(one().payload.messageId);
    expect(sent.idempotencyKey).not.toBe(one().idempotencyKey);
    expect(one({ flags: [] }).payload.labelIds).toEqual(["INBOX", "UNREAD"]);
    expect(one({ flags: ["\\FLAGGED", "\\seen", "\\Answered", "$Forwarded", "Customer Smith"] }).payload.labelIds).toEqual(["INBOX", "STARRED"]);
    expect(one({ flags: ["\\Flagged"] }).payload.labelIds).toEqual(["INBOX", "STARRED", "UNREAD"]);
    expect(one({ flags: ["\\Flagged"] }).idempotencyKey).not.toBe(one().idempotencyKey);
    // The same message read again is the same event.
    expect(one({ uid: 99, size: 1 })).toEqual(one());
    expect(normalizer.message(inbox, fetched({ flags: ["\\Draft"] }), RECEIVED)).toEqual([]);
    expect(normalizer.message(inbox, fetched({ flags: ["\\draft", "\\Seen"] }), RECEIVED)).toEqual([]);
  });

  it("threads by the first References id, else In-Reply-To, else the message itself", () => {
    const thread = (lines: string[]) => one({ header: header(lines) }).payload.threadId;
    const own = thread(["Message-ID: <root@example.test>"]);
    expect(thread(["Message-ID: <reply@example.test>", "References: <root@example.test> <mid@example.test>", "In-Reply-To: <mid@example.test>"])).toBe(own);
    expect(thread(["Message-ID: <reply@example.test>", "In-Reply-To: <root@example.test>"])).toBe(own);
    expect(thread(["Message-ID: <reply@example.test>", "References: junk", "In-Reply-To: <root@example.test>"])).toBe(own);
    expect(thread(["Message-ID: <other@example.test>"])).not.toBe(own);
    expect(thread(["From: a@example.test"])).toBeUndefined();
    // A thread's reference isn't its root message's.
    expect(one({ header: header(["Message-ID: <root@example.test>"]) }).payload.messageId).not.toBe(String(own).replace("thread", "message"));
  });

  it("falls back to the folder, UIDVALIDITY and UID for a message without a Message-ID", () => {
    const bare = (uid: number, place = inbox) => one({ uid, header: header(["From: a@example.test"]) }, place).payload.messageId;
    expect(bare(4)).toBe(bare(4));
    expect(bare(5)).not.toBe(bare(4));
    expect(bare(4, { ...inbox, uidValidity: "8" })).not.toBe(bare(4));
    expect(bare(4, { ...inbox, mailbox: "Other" })).not.toBe(bare(4));
    expect(one({ header: header(["Message-ID: junk"]) }).payload.messageId).toBe(bare(4));
  });

  it("keeps 50 addresses a field at most, counting every one once", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `r${i}@example.test`).join(", ");
    const at = (n: number) => one({ header: header([`To: ${list(n)}`, `Cc: ${list(2)}, R0@example.test`]) }).payload;
    expect([(at(50).to as unknown[]).length, at(50).recipientCount]).toEqual([50, 52]);
    expect([(at(51).to as unknown[]).length, at(51).recipientCount]).toEqual([50, 53]);
    expect((at(51).cc as unknown[]).length).toBe(2);
    const empty = one({ header: header(["Message-ID: <x@example.test>"]) }).payload;
    expect([empty.from, empty.to, empty.cc, empty.recipientCount]).toEqual([undefined, [], [], 0]);
    expect(one({ header: header(["From: =?utf-8?B?PGVuY29kZWRAZXhhbXBsZS50ZXN0Pg==?="]) }).payload.from).toEqual(correspondent("encoded@example.test"));
  });

  it("dead-letters a message whose time or header fields don't read, keyed by a digest", () => {
    const dead = (over: Partial<ImapFetched>) => one(over);
    const cases: [Partial<ImapFetched>, string[]][] = [
      [{ internalDate: null }, ["message has no INTERNALDATE that reads"]],
      [{ internalDate: "yesterday" }, ["message has no INTERNALDATE that reads"]],
      [{ header: null }, ["the server didn't return the message's header fields"]],
      [{ header: new ImapLiteralTooLarge(300_000) }, [`the message's header fields are longer than ${IMAP_HEADER_MAX} bytes`]],
      [{ header: new Uint8Array(IMAP_HEADER_MAX + 1) }, [`the message's header fields are longer than ${IMAP_HEADER_MAX} bytes`]],
      [{ internalDate: null, header: null }, ["message has no INTERNALDATE that reads", "the server didn't return the message's header fields"]],
    ];
    for (const [over, problems] of cases) {
      const e = dead(over);
      expect(e).toEqual({ id: expect.stringMatching(/^imap_email_unreadable_message:[0-9a-f]{16}$/), type: "communication.message_logged", occurredAt: undefined, receivedAt: RECEIVED, idempotencyKey: e.id.replace("imap_email_", "imap_email:"), payload: { system: "IMAP", problems } });
    }
    expect(IMAP_HEADER_MAX).toBe(64 * 1024);
    expect(dead({ header: new Uint8Array(IMAP_HEADER_MAX) }).occurredAt).toBe("2026-07-17T09:44:25.000Z");
    // The key is stable for the same message, and differs for another.
    expect(dead({ header: null }).idempotencyKey).toBe(dead({ header: null }).idempotencyKey);
    expect(dead({ header: null, uid: 5 }).idempotencyKey).not.toBe(dead({ header: null }).idempotencyKey);
    expect(dead({ header: new ImapLiteralTooLarge(300_001) }).idempotencyKey).not.toBe(dead({ header: new ImapLiteralTooLarge(300_000) }).idempotencyKey);
    expect(normalizer.message({ ...inbox, uidValidity: "8" }, fetched({ header: null }), RECEIVED)[0]!.idempotencyKey).not.toBe(dead({ header: null }).idempotencyKey);
    expect(normalizer.message({ ...inbox, role: "sent" }, fetched({ header: null }), RECEIVED)[0]!.idempotencyKey).not.toBe(dead({ header: null }).idempotencyKey);
    expect(dead({ header: null, internalDate: "x" }).idempotencyKey).not.toBe(dead({ header: null }).idempotencyKey);
  });

  it("gives a system label for each folder read", () => {
    const labels = normalizer.labels(["inbox", "sent"], RECEIVED);
    expect(labels).toEqual([
      { id: expect.stringMatching(/^imap_email_label:INBOX:[0-9a-f]{16}$/), type: "communication.label_updated", occurredAt: RECEIVED, receivedAt: RECEIVED, idempotencyKey: expect.stringMatching(/^imap_email:label:INBOX:/), payload: { channel: "email", labelId: "imap_email:label:INBOX", kind: "system", name: "INBOX" } },
      { id: expect.stringMatching(/^imap_email_label:SENT:/), type: "communication.label_updated", occurredAt: RECEIVED, receivedAt: RECEIVED, idempotencyKey: expect.stringMatching(/^imap_email:label:SENT:/), payload: { channel: "email", labelId: "imap_email:label:SENT", kind: "system", name: "SENT" } },
    ]);
    expect(normalizer.labels(["inbox"], "2026-01-01T00:00:00.000Z")[0]!.idempotencyKey).toBe(labels[0]!.idempotencyKey);
    expect(labels[0]!.idempotencyKey).not.toBe(labels[1]!.idempotencyKey.replace("SENT", "INBOX"));
  });
});

describe("IMAP folders", () => {
  it("finds INBOX and the Sent folder, by its \\Sent mark or else a usual name, skipping folders that can't be opened", () => {
    const f = (name: string, ...attributes: string[]) => ({ name, attributes });
    expect(imapFolders([f("Inbox"), f("Sent Items"), f("Archive", "\\sent")])).toEqual({ inbox: "Inbox", sent: "Archive" });
    expect(imapFolders([f("INBOX"), f("INBOX.Sent")])).toEqual({ inbox: "INBOX", sent: "INBOX.Sent" });
    for (const name of ["Sent", "sent items", "Sent Messages", "SENT MAIL", "INBOX/Sent", "inbox.sent items", "INBOX.Sent Messages"]) expect(imapFolders([f(name)]).sent, name).toBe(name);
    expect(imapFolders([f("Sent", "\\noselect"), f("Old Sent")])).toEqual({ inbox: "INBOX", sent: null });
    expect(imapFolders([f("x", "\\nonexistent", "\\sent"), f("Sent")])).toEqual({ inbox: "INBOX", sent: "Sent" });
    expect(imapFolders([f("INBOX", "\\noselect"), f("inbox")])).toEqual({ inbox: "inbox", sent: null });
    // INBOX itself is never the Sent folder.
    expect(imapFolders([f("INBOX", "\\sent")])).toEqual({ inbox: "INBOX", sent: null });
    expect(imapFolders([])).toEqual({ inbox: "INBOX", sent: null });
  });
});

/** Everything a pass gave, batch by batch. */
async function drain(pages: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const page of pages) out.push(page);
  return out;
}
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events as ImapEmailEvent[]);
const cursorOf = (batch: SourceBatch | undefined) => JSON.parse(batch!.cursor) as ImapCursor;
const LABEL = imapAccountLabel(HOST, 993, USER);
const connector = (server: ImapFakeServer, over: Partial<ImapEmailOptions> = {}) =>
  imapEmailConnector({ host: HOST, username: USER, password: PASSWORD, correspondentKey: KEY, connect: server.connect, now: NOW, ...over });
const ctx = (cursor: string | null) => ({ organizationId: TEST_ORG, cursor });
const message = (uid: number, iso: string, over: Partial<ImapFakeMessage> = {}): ImapFakeMessage => ({
  uid,
  internalDate: imapDate(iso),
  flags: ["\\Seen"],
  header: `From: customer${uid}@example.test\r\nTo: ${USER}\r\nMessage-ID: <m${uid}-${iso.slice(0, 10)}@example.test>\r\nSubject: Sizing\r\n\r\n`,
  ...over,
});
/** No forbidden command went out, and no message was marked read. */
function readOnly(server: ImapFakeServer, flagsBefore: string): void {
  expect(server.forbidden).toEqual([]);
  for (const c of server.commands) expect(IMAP_COMMANDS as readonly string[], c.command).toContain(c.command);
  for (const line of server.lines) {
    expect(line).not.toMatch(/BODY\[/);
    expect(line).not.toMatch(/^\S+ (UID )?(SELECT|STORE|COPY|MOVE|EXPUNGE|APPEND|CREATE|DELETE|RENAME)\b/i);
  }
  expect(JSON.stringify(server.mailbox.folders.map((f) => f.messages.map((m) => m.flags)))).toBe(flagsBefore);
}
const flagsOf = (box: ImapFakeMailbox) => JSON.stringify(box.folders.map((f) => f.messages.map((m) => m.flags)));

describe("IMAP connector", () => {
  it("passes the shared sync checks", async () => {
    const box = mailbox();
    // SEARCH finds it by its day, but an hour of 25 doesn't read.
    folder({ mailbox: box } as ImapFakeServer, "INBOX").messages.push(message(4, "2026-02-01T00:00:00Z", { internalDate: "01-Feb-2026 25:00:00 +0000" }));
    const flags = flagsOf(box);
    const server = imapFakeServer(box, { chunkSize: 64 });
    const result = await checkConnectorSync({ makeConnector: () => connector(server, { batchSize: 2 }), expected: { ingested: 7, deadLettered: 1 }, payloadSchemas: SCHEMAS });
    expect(result.full.batches).toBe(4);
    readOnly(server, flags);
    // Every connection was signed out and closed.
    expect(server.closed).toBe(server.connections);
  });

  it("imports both folders oldest first in batches, checkpointing each folder's UIDVALIDITY and last UID, and stops for good", async () => {
    const box = mailbox();
    const flags = flagsOf(box);
    const server = imapFakeServer(box);
    const out = await drain(connector(server, { batchSize: 2 }).historicalImport(ctx(null)));
    const since = "2021-11-11T15:00:00.000Z";
    expect(out.map((b) => cursorOf(b))).toEqual([
      { pass: "historical", account: LABEL, step: "inbox", since, folders: { inbox: { mailbox: "INBOX", uidValidity: null, lastUid: 0 }, sent: { mailbox: "Sent", uidValidity: null, lastUid: 0 } } },
      { pass: "historical", account: LABEL, step: "inbox", since, folders: { inbox: { mailbox: "INBOX", uidValidity: "7", lastUid: 2 }, sent: { mailbox: "Sent", uidValidity: null, lastUid: 0 } } },
      { pass: "historical", account: LABEL, step: "sent", since, folders: { inbox: { mailbox: "INBOX", uidValidity: "7", lastUid: 3 }, sent: { mailbox: "Sent", uidValidity: null, lastUid: 0 } } },
      { pass: "historical", account: LABEL, step: "done", since, folders: { inbox: { mailbox: "INBOX", uidValidity: "7", lastUid: 3 }, sent: { mailbox: "Sent", uidValidity: "9", lastUid: 2 } } },
    ]);
    expect(out.map((b) => (b.events as ImapEmailEvent[]).map((e) => `${e.type.split(".")[1]}:${e.occurredAt}`))).toEqual([
      [`label_updated:${RECEIVED}`, `label_updated:${RECEIVED}`],
      ["message_logged:2026-01-01T00:01:00.000Z", "message_logged:2026-01-01T00:02:00.000Z"],
      ["message_logged:2026-01-01T00:03:00.000Z"],
      ["message_logged:2026-01-01T00:04:00.000Z", "message_logged:2026-01-01T00:05:00.000Z"],
    ]);
    expect(eventsOf(out).map((e) => e.payload.direction)).toEqual([undefined, undefined, "received", "received", "received", "sent", "sent"]);
    for (const e of eventsOf(out)) synthetic(e.payload);
    expect(server.lines).toEqual([
      "K1 CAPABILITY",
      `K2 LOGIN "${USER}" "${PASSWORD}"`,
      'K3 LIST "" "*"',
      'K4 EXAMINE "INBOX"',
      "K5 UID SEARCH SINCE 11-Nov-2021",
      FETCH("K6", "1:2"),
      FETCH("K7", "3"),
      'K8 EXAMINE "Sent"',
      "K9 UID SEARCH SINCE 11-Nov-2021",
      FETCH("K10", "1:2"),
      "K11 LOGOUT",
    ]);
    readOnly(server, flags);
    // A finished import reads nothing, and doesn't even connect.
    expect(await drain(connector(server).historicalImport(ctx(out.at(-1)!.cursor)))).toEqual([]);
    expect(server.connections).toBe(1);
    expect(IMAP_BATCH_SIZE).toBe(50);
  });

  it("reads 50 to a batch by default, and searches from five years back by default", async () => {
    const box = mailbox();
    folder({ mailbox: box } as ImapFakeServer, "INBOX").messages = Array.from({ length: 51 }, (_, i) => message(i + 1, "2026-03-01T00:00:00Z"));
    const server = imapFakeServer(box);
    const out = await drain(connector(server).historicalImport(ctx(null)));
    expect(out.map((b) => b.events.length)).toEqual([2, 50, 1, 2]);
    expect(server.lines.filter((l) => l.includes("UID FETCH"))).toEqual([FETCH("K6", "1:50"), FETCH("K7", "51"), FETCH("K10", "1:2")]);
    expect(server.lines[4]).toBe("K5 UID SEARCH SINCE 11-Nov-2021");
    const three = await drain(connector(imapFakeServer(mailbox()), { historyYears: 3 }).historicalImport(ctx(null)));
    expect(cursorOf(three[0]).since).toBe("2023-11-11T15:00:00.000Z");
  });

  it("only reads what SEARCH SINCE finds", async () => {
    const box = mailbox();
    folder({ mailbox: box } as ImapFakeServer, "INBOX").messages = [message(1, "2021-11-10T23:59:59Z"), message(2, "2021-11-11T00:00:00Z"), message(3, "2026-11-11T00:00:00Z")];
    const server = imapFakeServer(box);
    const out = await drain(connector(server).historicalImport(ctx(null)));
    expect(eventsOf(out).filter((e) => e.payload.direction === "received").map((e) => e.occurredAt)).toEqual(["2021-11-11T00:00:00.000Z", "2026-11-11T00:00:00.000Z"]);
  });

  it("resumes an interrupted import past the last UID read", async () => {
    const server = imapFakeServer(mailbox());
    const first = await drain(connector(server, { batchSize: 2 }).historicalImport(ctx(null)));
    const resumeAt = first[1]!.cursor;
    const resumed = imapFakeServer(mailbox());
    const rest = await drain(connector(resumed, { batchSize: 2 }).historicalImport(ctx(resumeAt)));
    expect(rest.map((b) => b.cursor)).toEqual(first.slice(2).map((b) => b.cursor));
    expect(eventsOf(rest)).toEqual(eventsOf(first.slice(2)));
    // The folders were listed before the checkpoint, so LIST isn't sent again.
    expect(resumed.lines.slice(2)).toEqual(['K3 EXAMINE "INBOX"', "K4 UID SEARCH UID 3:* SINCE 11-Nov-2021", FETCH("K5", "3"), 'K6 EXAMINE "Sent"', "K7 UID SEARCH SINCE 11-Nov-2021", FETCH("K8", "1:2"), "K9 LOGOUT"]);
    // Resumed at the Sent folder, INBOX isn't opened again.
    const atSent = imapFakeServer(mailbox());
    await drain(connector(atSent, { batchSize: 2 }).historicalImport(ctx(first[2]!.cursor)));
    expect(atSent.lines.slice(2, 4)).toEqual(['K3 EXAMINE "Sent"', "K4 UID SEARCH SINCE 11-Nov-2021"]);
    const afterList = imapFakeServer(mailbox());
    await drain(connector(afterList, { batchSize: 2 }).historicalImport(ctx(first[0]!.cursor)));
    expect(afterList.lines.slice(2, 4)).toEqual(['K3 EXAMINE "INBOX"', "K4 UID SEARCH SINCE 11-Nov-2021"]);
  });

  it("reads a folder again from the start when its UIDVALIDITY changes, and says so in the checkpoint", async () => {
    const first = await drain(connector(imapFakeServer(mailbox()), { batchSize: 2 }).historicalImport(ctx(null)));
    const box = mailbox();
    folder({ mailbox: box } as ImapFakeServer, "INBOX").uidValidity = 70;
    const server = imapFakeServer(box);
    const out = await drain(connector(server, { batchSize: 2 }).historicalImport(ctx(first[1]!.cursor)));
    expect(server.lines.slice(2, 4)).toEqual(['K3 EXAMINE "INBOX"', "K4 UID SEARCH SINCE 11-Nov-2021"]);
    expect(cursorOf(out[0]).folders.inbox).toEqual({ mailbox: "INBOX", uidValidity: "70", lastUid: 2 });
    expect(eventsOf(out).filter((e) => e.payload.direction === "received")).toHaveLength(3);
    // An import keeps the start it was given, rather than five years back from now.
    const later = imapFakeServer(box);
    await drain(connector(later, { batchSize: 2 }).historicalImport(ctx(JSON.stringify({ ...cursorOf(first[1]), since: "2024-01-01T00:00:00.000Z" }))));
    expect(later.lines[3]).toBe("K4 UID SEARCH SINCE 1-Jan-2024");
  });

  it("starts over for another mailbox, and when a folder is renamed reads it from the start", async () => {
    const first = await drain(connector(imapFakeServer(mailbox()), { batchSize: 2 }).historicalImport(ctx(null)));
    const other = imapFakeServer(mailbox({ username: "other@example.test" }));
    const out = await drain(connector(other, { username: "other@example.test" }).historicalImport(ctx(first.at(-1)!.cursor)));
    expect(cursorOf(out[0]).account).toBe(imapAccountLabel(HOST, 993, "other@example.test"));
    expect(eventsOf(out)).toHaveLength(7);
    expect(imapAccountLabel(HOST, 993, USER)).not.toBe(imapAccountLabel(HOST, 994, USER));
    expect(imapAccountLabel(HOST, 993, USER)).not.toBe(imapAccountLabel("imap2.example.test", 993, USER));

    const box = mailbox();
    folder({ mailbox: box } as ImapFakeServer, "Sent").name = "Sent Items";
    const renamed = imapFakeServer(box);
    const later = await drain(connector(renamed).incrementalSync(ctx(JSON.stringify({ ...cursorOf(first.at(-1)), pass: "incremental", step: "folders" }))));
    expect(cursorOf(later[0]).folders).toEqual({ inbox: { mailbox: "INBOX", uidValidity: "7", lastUid: 3 }, sent: { mailbox: "Sent Items", uidValidity: null, lastUid: 0 } });
    // The renamed folder is read as a new one, searched from the checkpoint's start.
    expect(renamed.lines.slice(-5)).toEqual([FETCH("K5", "4:*"), 'K6 EXAMINE "Sent Items"', "K7 UID SEARCH SINCE 11-Nov-2021", FETCH("K8", "1:2"), "K9 LOGOUT"]);
  });

  it("reads only INBOX when there is no Sent folder, and skips folders that can't be opened", async () => {
    const box = mailbox();
    box.folders = [{ name: "[Mail]", attributes: ["\\Noselect", "\\Sent"], uidValidity: 1, messages: [] }, box.folders[0]!];
    const server = imapFakeServer(box);
    const out = await drain(connector(server).historicalImport(ctx(null)));
    expect(out[0]!.events.map((e) => (e as ImapEmailEvent).payload.name)).toEqual(["INBOX"]);
    expect(cursorOf(out.at(-1)).folders.sent).toBeNull();
    expect(cursorOf(out.at(-1)).step).toBe("done");
    expect(server.lines.filter((l) => l.includes("EXAMINE"))).toEqual(['K4 EXAMINE "INBOX"']);
  });

  it("yields a batch for an empty folder and takes its UIDNEXT, so it isn't read from the start next time", async () => {
    const box = mailbox();
    folder({ mailbox: box } as ImapFakeServer, "Sent").messages = [];
    folder({ mailbox: box } as ImapFakeServer, "Sent").uidNext = 41;
    const out = await drain(connector(imapFakeServer(box)).historicalImport(ctx(null)));
    expect(out.map((b) => b.events.length)).toEqual([2, 3, 0]);
    expect(cursorOf(out.at(-1)).folders.sent).toEqual({ mailbox: "Sent", uidValidity: "9", lastUid: 40 });
    // A folder with mail takes its UIDNEXT too, once its last batch is read.
    const ahead = mailbox();
    folder({ mailbox: ahead } as ImapFakeServer, "INBOX").uidNext = 21;
    const read = await drain(connector(imapFakeServer(ahead), { batchSize: 2 }).historicalImport(ctx(null)));
    expect(read.slice(1, 3).map((b) => cursorOf(b).folders.inbox!.lastUid)).toEqual([2, 20]);
    // Without UIDNEXT, the last UID read stands.
    const noNext = mailbox();
    folder({ mailbox: noNext } as ImapFakeServer, "INBOX").uidNext = null;
    expect(cursorOf((await drain(connector(imapFakeServer(noNext)).historicalImport(ctx(null)))).at(-1)).folders.inbox).toEqual({ mailbox: "INBOX", uidValidity: "7", lastUid: 3 });
    // A UIDNEXT lower than what was read changes nothing.
    const low = mailbox();
    folder({ mailbox: low } as ImapFakeServer, "INBOX").uidNext = 2;
    expect(cursorOf((await drain(connector(imapFakeServer(low)).historicalImport(ctx(null)))).at(-1)).folders.inbox!.lastUid).toBe(3);
  });

  it("reads back 48 hours on a first incremental sync, then fetches past the last UID read", async () => {
    const box = mailbox();
    const inbox = folder({ mailbox: box } as ImapFakeServer, "INBOX");
    inbox.messages = [message(1, "2026-11-01T00:00:00Z"), message(2, "2026-11-09T15:00:00Z"), message(3, "2026-11-10T00:00:00Z")];
    folder({ mailbox: box } as ImapFakeServer, "Sent").messages = [];
    const server = imapFakeServer(box);
    const first = await drain(connector(server).incrementalSync(ctx(null)));
    expect(server.lines[4]).toBe("K5 UID SEARCH SINCE 9-Nov-2026");
    expect(cursorOf(first[0]).since).toBe("2026-11-09T15:00:00.000Z");
    expect(eventsOf(first).filter((e) => e.type.endsWith("message_logged")).map((e) => e.occurredAt)).toEqual(["2026-11-09T15:00:00.000Z", "2026-11-10T00:00:00.000Z"]);
    const done = cursorOf(first.at(-1));
    expect([done.pass, done.step, done.folders]).toEqual(["incremental", "done", { inbox: { mailbox: "INBOX", uidValidity: "7", lastUid: 3 }, sent: { mailbox: "Sent", uidValidity: "9", lastUid: 0 } }]);
    const hours = imapFakeServer(box);
    await drain(connector(hours, { incrementalLookbackHours: 300 }).incrementalSync(ctx(null)));
    expect(hours.lines[4]).toBe("K5 UID SEARCH SINCE 30-Oct-2026");

    // Nothing new: "4:*" answers with message 3, which is dropped.
    const quiet = imapFakeServer(box);
    const none = await drain(connector(quiet).incrementalSync(ctx(first.at(-1)!.cursor)));
    expect(quiet.lines.slice(3)).toEqual(['K4 EXAMINE "INBOX"', FETCH("K5", "4:*"), 'K6 EXAMINE "Sent"', "K7 UID SEARCH SINCE 9-Nov-2026", "K8 LOGOUT"]);
    expect(eventsOf(none).filter((e) => e.type.endsWith("message_logged"))).toEqual([]);

    // New mail is read, in batches, and the last UID moves on.
    inbox.messages.push(message(4, "2026-11-11T10:00:00Z"), message(5, "2026-11-11T11:00:00Z"), message(6, "2026-11-11T12:00:00Z"));
    const busy = imapFakeServer(box);
    const fresh = await drain(connector(busy, { batchSize: 2 }).incrementalSync(ctx(none.at(-1)!.cursor)));
    expect(fresh.slice(1, 3).map((b) => b.events.length)).toEqual([2, 1]);
    expect(fresh.slice(1, 3).map((b) => cursorOf(b).folders.inbox!.lastUid)).toEqual([5, 6]);
    expect(fresh.slice(1, 3).map((b) => cursorOf(b).step)).toEqual(["inbox", "sent"]);
    expect(busy.lines.filter((l) => l.includes("UID FETCH"))).toEqual([FETCH("K5", "4:*")]);
    readOnly(busy, flagsOf(box));
  });

  it("resumes a later sync mid-folder, and starts a fresh pass after a finished one", async () => {
    const box = mailbox();
    folder({ mailbox: box } as ImapFakeServer, "INBOX").messages = [1, 2, 3].map((uid) => message(uid, `2026-11-10T0${uid}:00:00Z`));
    const server = imapFakeServer(box);
    const first = await drain(connector(server, { batchSize: 2 }).incrementalSync(ctx(null)));
    expect(first.map((b) => cursorOf(b).step)).toEqual(["inbox", "inbox", "sent", "done"]);
    const resumed = imapFakeServer(box);
    const rest = await drain(connector(resumed, { batchSize: 2 }).incrementalSync(ctx(first[1]!.cursor)));
    expect(rest.map((b) => b.cursor)).toEqual(first.slice(2).map((b) => b.cursor));
    expect(resumed.lines.slice(2, 4)).toEqual(['K3 EXAMINE "INBOX"', FETCH("K4", "3:*")]);
    // After a finished pass, the next starts with LIST again and keeps each folder's place.
    const next = imapFakeServer(box);
    const again = await drain(connector(next).incrementalSync(ctx(first.at(-1)!.cursor)));
    expect(cursorOf(again[0]).folders).toEqual(cursorOf(first.at(-1)).folders);
    expect(next.lines.slice(2, 5)).toEqual(['K3 LIST "" "*"', 'K4 EXAMINE "INBOX"', FETCH("K5", "4:*")]);
    // An incremental sync doesn't take a historical checkpoint's places.
    const hist = await drain(connector(imapFakeServer(mailbox())).historicalImport(ctx(null)));
    const fromHistory = imapFakeServer(box);
    const fresh = await drain(connector(fromHistory).incrementalSync(ctx(hist.at(-1)!.cursor)));
    expect(cursorOf(fresh[0]).folders.inbox).toEqual({ mailbox: "INBOX", uidValidity: null, lastUid: 0 });
  });

  it("reads a folder again from five years back when its UIDVALIDITY changes between syncs", async () => {
    const box = mailbox();
    const first = await drain(connector(imapFakeServer(box)).incrementalSync(ctx(null)));
    folder({ mailbox: box } as ImapFakeServer, "INBOX").uidValidity = 8;
    const server = imapFakeServer(box);
    const out = await drain(connector(server).incrementalSync(ctx(first.at(-1)!.cursor)));
    expect(server.lines.slice(3, 6)).toEqual(['K4 EXAMINE "INBOX"', "K5 UID SEARCH SINCE 11-Nov-2021", FETCH("K6", "1:3")]);
    expect(cursorOf(out[1]).folders.inbox).toEqual({ mailbox: "INBOX", uidValidity: "8", lastUid: 3 });
    // Messages already stored come back as duplicates.
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    await runSync({ connector: connector(imapFakeServer(box)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    folder({ mailbox: box } as ImapFakeServer, "INBOX").uidValidity = 99;
    const report = await runSync({ connector: connector(imapFakeServer(box)), mode: "historical", pipeline, memory: Object.create(memory, { getCheckpoint: { value: async () => null } }), organizationId: TEST_ORG });
    expect([report.ingested, report.duplicates]).toEqual([0, 7]);
  });

  it("stores its events through the pipeline, dead-lettering what doesn't read", async () => {
    const box = mailbox();
    folder({ mailbox: box } as ImapFakeServer, "INBOX").messages.push(message(4, "2026-02-01T00:00:00Z", { header: `From: a@example.test\r\nX-Pad: ${"p".repeat(IMAP_HEADER_MAX)}\r\n` }));
    folder({ mailbox: box } as ImapFakeServer, "INBOX").messages.push(message(5, "2026-02-02T00:00:00Z", { flags: ["\\Draft"] }));
    const server = imapFakeServer(box);
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(server), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // The padding isn't one of the fields asked for, so message 4 reads; a draft is skipped.
    expect([report.ingested, report.deadLettered, report.duplicates]).toEqual([8, 0, 0]);
    const tiny = imapFakeServer(box);
    const capped = await runSync({ connector: connector(tiny, { maxLiteral: 60 }), mode: "historical", ...testPipeline([], SCHEMAS), organizationId: TEST_ORG });
    // Every header block but message 4's, which has only a From field, is longer than 60 bytes.
    expect([capped.deadLettered, capped.ingested]).toEqual([5, 3]);
  });

  it("stops on a mailbox that turns down its sign-in, explaining the settings, never the password", async () => {
    const server = imapFakeServer(mailbox({ password: "different" }));
    const error = await errorOf(drain(connector(server).historicalImport(ctx(null))));
    expect(error).toBeInstanceOf(ImapConfigError);
    expect(error!.message).toContain("IMAP_USERNAME and IMAP_PASSWORD");
    expect(error!.message).toContain("app password");
    expect(error!.message).not.toContain(PASSWORD);
    expect(server.closed).toBe(1);
    const { memory, pipeline } = testPipeline();
    await expect(runSync({ connector: connector(server), mode: "historical", pipeline, memory, organizationId: TEST_ORG, attempts: 2, sleep: async () => {} })).rejects.toBeInstanceOf(ImapConfigError);
  });

  it("closes the connection when the sync stops partway or fails, and runSync's retry reads on from the checkpoint", async () => {
    const server = imapFakeServer(mailbox());
    for await (const _ of connector(server).historicalImport(ctx(null))) break;
    expect([server.connections, server.closed, server.lines.at(-1)]).toEqual([1, 1, "K4 LOGOUT"]);
    let drops = 1;
    const flaky = imapFakeServer(mailbox(), { script: (c) => (c.command === "UID FETCH" && c.args.startsWith("3 ") && drops-- > 0 ? "close" : undefined) });
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(flaky, { batchSize: 2 }), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: async () => {} });
    expect([report.ingested, report.duplicates, flaky.connections, flaky.closed]).toEqual([7, 0, 2, 2]);
    expect(flaky.lines.filter((l) => l.includes("UID SEARCH"))).toEqual(["K5 UID SEARCH SINCE 11-Nov-2021", "K4 UID SEARCH UID 3:* SINCE 11-Nov-2021", "K7 UID SEARCH SINCE 11-Nov-2021"]);
  });

  it("checks its options and settings before connecting, uses the real clock by default, and declares its writes, turned down", async () => {
    const server = imapFakeServer(mailbox());
    for (const [over, text] of [
      [{ historyYears: 0 }, "historyYears must be a positive whole number"],
      [{ historyYears: 1.5 }, "historyYears must be a positive whole number"],
      [{ incrementalLookbackHours: 0 }, "incrementalLookbackHours must be a positive whole number"],
      [{ incrementalLookbackHours: 2.5 }, "incrementalLookbackHours must be a positive whole number"],
      [{ batchSize: 0 }, "batchSize must be a whole number from 1 to 500"],
      [{ batchSize: 501 }, "batchSize must be a whole number from 1 to 500"],
      [{ batchSize: 2.5 }, "batchSize must be a whole number from 1 to 500"],
      [{ host: "nope" }, "set IMAP_HOST"],
      [{ correspondentKey: "short" }, "CORRESPONDENT_HASH_KEY"],
    ] as const) {
      expect(() => connector(server, over as Partial<ImapEmailOptions>), JSON.stringify(over)).toThrow(text);
    }
    for (const ok of [{ historyYears: 1 }, { incrementalLookbackHours: 1 }, { batchSize: 1 }, { batchSize: 500 }]) expect(() => connector(server, ok)).not.toThrow();
    expect(server.connections).toBe(0);

    const before = Date.now();
    const out = await drain(imapEmailConnector({ host: HOST, username: USER, password: PASSWORD, correspondentKey: KEY, connect: server.connect }).historicalImport(ctx(null)));
    expect(Date.parse((out[0]!.events[0] as ImapEmailEvent).receivedAt)).toBeGreaterThanOrEqual(before);
    // An injected client is used as it is.
    let opened = 0;
    const injected = imapEmailConnector({ host: HOST, username: USER, password: PASSWORD, correspondentKey: KEY, now: NOW, client: { open: async () => (opened++, imapClient(clientOptions(server)).open()) } });
    await drain(injected.historicalImport(ctx(null)));
    expect(opened).toBe(1);

    const c = connector(server);
    expect(c.source).toBe("imap_email");
    expect(c.writes).toBe(IMAP_EMAIL_WRITES);
    expect(IMAP_EMAIL_WRITES).toEqual([
      { integration: "imap_email", name: "draft_reply", description: "Save a draft reply in the mailbox's Drafts folder for a person to review and send", kind: "draft", approval: "each", dailyCap: 20 },
      { integration: "imap_email", name: "flag_message", description: "Set or clear a flag on a message", kind: "update", approval: "each", dailyCap: 20 },
    ]);
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: READ_ONLY, audit });
    let performed = false;
    for (const action of c.writes ?? []) {
      await expect(gate.run(action, "imap-test", async () => void (performed = true))).rejects.toBeInstanceOf(WritesDisabledError);
    }
    expect(performed).toBe(false);
    expect(audit.entries).toMatchObject([{ action: "draft_reply", integration: "imap_email" }, { action: "flag_message", integration: "imap_email" }]);
    expect(audit.entries.map((e) => e.outcome)).not.toContain("performed");
  });

  it("turns down a checkpoint that isn't its own", () => {
    const state = { mailbox: "INBOX", uidValidity: "7", lastUid: 3 };
    const base: ImapCursor = { pass: "historical", account: LABEL, step: "inbox", since: "2021-11-11T15:00:00.000Z", folders: { inbox: state, sent: null } };
    const good: ImapCursor[] = [
      base,
      { ...base, step: "folders", folders: { inbox: null, sent: null } },
      { ...base, pass: "incremental", step: "done" },
      { ...base, step: "sent", folders: { inbox: state, sent: { mailbox: "Sent", uidValidity: null, lastUid: 0 } } },
      { ...base, folders: { inbox: { mailbox: "m".repeat(1000), uidValidity: "4294967295", lastUid: 4294967295 }, sent: null } },
      { ...base, folders: { inbox: { mailbox: "INBOX", uidValidity: "1", lastUid: 0 }, sent: null } },
    ];
    expect(parseImapCursor(null)).toBeNull();
    for (const c of good) expect(parseImapCursor(JSON.stringify(c)), JSON.stringify(c)).toEqual(c);
    const withState = (s: unknown) => ({ ...base, folders: { inbox: s, sent: null } });
    const bad: unknown[] = [
      "{",
      "null",
      "[]",
      "5",
      {},
      { ...base, extra: 1 },
      { ...base, pass: "full" },
      { ...base, account: "account:xyz" },
      { ...base, account: `${LABEL}0` },
      { ...base, account: 5 },
      { ...base, step: "trash" },
      { ...base, since: "2021-11-11" },
      { ...base, since: 5 },
      { ...base, folders: null },
      { ...base, folders: [] },
      { ...base, folders: { inbox: state } },
      { ...base, folders: { inbox: state, sent: null, trash: null } },
      { ...base, folders: { inbox: state, sent: "Sent" } },
      { ...base, folders: { inbox: null, sent: null } },
      { ...base, step: "done", folders: { inbox: null, sent: null } },
      { ...base, step: "sent", folders: { inbox: state, sent: null } },
      withState([]),
      withState("INBOX"),
      withState({ mailbox: "INBOX", uidValidity: "7" }),
      withState({ ...state, extra: 1 }),
      withState({ ...state, mailbox: "" }),
      withState({ ...state, mailbox: "a\r\nb" }),
      withState({ ...state, mailbox: "m".repeat(1001) }),
      withState({ ...state, mailbox: 5 }),
      withState({ ...state, uidValidity: "0" }),
      withState({ ...state, uidValidity: "4294967296" }),
      withState({ ...state, uidValidity: 7 }),
      withState({ ...state, lastUid: -1 }),
      withState({ ...state, lastUid: 1.5 }),
      withState({ ...state, lastUid: 4294967296 }),
      withState({ ...state, lastUid: "3" }),
      withState({ ...state, uidValidity: null, lastUid: 3 }),
      // Another connector's checkpoints.
      { pass: "historical", step: "labels", pageToken: null, since: base.since, historyId: null, nextFrom: base.since },
      { done: false, step: "orders", page: null },
    ];
    for (const raw of bad) expect(() => parseImapCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("IMAP checkpoint is not in the expected shape");
  });
});

describe("Scripted IMAP server", () => {
  const send = async (server: ImapFakeServer, lines: string[]) => {
    const transport = await server.connect();
    let text = "";
    transport.on("data", (chunk: Uint8Array) => {
      text += Buffer.from(chunk).toString("latin1");
    });
    for (const line of lines) transport.write(bytes(`${line}\r\n`));
    await new Promise((r) => setTimeout(r, 20));
    return { text, transport };
  };

  it("uses only synthetic data, writes INTERNALDATE in UTC, and keeps no Subject out of a fetch it wasn't asked for", () => {
    imapMessage.reset();
    const messages = imapMessage.many(3);
    assertSynthetic(messages);
    expect(messages.map((m) => [m.uid, m.internalDate])).toEqual([[1, "01-Jan-2026 00:01:00 +0000"], [2, "01-Jan-2026 00:02:00 +0000"], [3, "01-Jan-2026 00:03:00 +0000"]]);
    expect(imapDate("2026-07-04T09:05:06.000Z")).toBe("04-Jul-2026 09:05:06 +0000");
    expect(imapInternalDate(imapDate("2026-07-04T09:05:06.000Z"))).toBe("2026-07-04T09:05:06.000Z");
  });

  it("answers BAD to, and records, every command a read-only client mustn't send", async () => {
    const server = imapFakeServer(mailbox());
    const { text } = await send(server, [`A1 LOGIN ${USER} ${PASSWORD}`, "A2 SELECT INBOX", "A3 EXAMINE INBOX", "A4 UID STORE 1 +FLAGS (\\Deleted)", "A5 EXPUNGE", "A6 COPY 1 Trash", 'A7 CREATE "New"', "A8 noop"]);
    expect(server.forbidden.map((c) => `${c.tag} ${c.command}`)).toEqual(["A2 SELECT", "A4 UID STORE", "A5 EXPUNGE", "A6 COPY", "A7 CREATE", "A8 NOOP"]);
    expect(text).toContain("A2 BAD This server only opens folders read-only");
    expect(text).toContain("A4 BAD UID STORE isn't allowed");
    expect(text).toContain("A3 OK [READ-ONLY] EXAMINE completed");
    expect(folder(server, "INBOX").messages.map((m) => m.flags)).toEqual([["\\Seen"], ["\\Seen"], ["\\Seen"]]);
  });

  it("marks a message read on a fetch without PEEK, as a real server does, and answers n:* past the end with the last message", async () => {
    const box = mailbox();
    for (const m of folder({ mailbox: box } as ImapFakeServer, "INBOX").messages) m.flags = [];
    const server = imapFakeServer(box);
    const { text } = await send(server, [
      `A1 LOGIN ${USER} ${PASSWORD}`,
      "A2 EXAMINE INBOX",
      "A3 UID FETCH 1 (UID BODY.PEEK[HEADER.FIELDS (FROM)])",
      "A4 UID FETCH 2 (UID BODY[HEADER.FIELDS (FROM)])",
      "A5 UID FETCH 3 (UID RFC822)",
      "A6 UID FETCH 9:* (UID FLAGS)",
      "A7 UID FETCH 1 UID",
      "A8 UID SEARCH UID 2:* SINCE 1-Jan-2026",
      "A9 UID SEARCH BEFORE 1-Jan-2026",
      "A10 UID SEARCH SINCE nonsense",
    ]);
    expect(folder(server, "INBOX").messages.map((m) => m.flags)).toEqual([[], ["\\Seen"], ["\\Seen"]]);
    expect(text).toContain("* 3 FETCH (UID 3 FLAGS (\\Seen)");
    expect(text).toContain("A7 BAD Bad fetch items");
    expect(text).toContain("* SEARCH 2 3\r\nA8 OK");
    expect(text).toContain("A9 BAD Unknown search key BEFORE");
    expect(text).toContain("A10 BAD Bad date");
    expect(text).toContain("BODY[HEADER.FIELDS (FROM)] {52}\r\nFrom: \"Test Customer 1\" <customer1@example.test>\r\n\r\n)");
  });

  it("needs a login first, opens INBOX in any case, and turns down a folder it hasn't or can't open", async () => {
    const box = mailbox();
    box.folders.push({ name: "Hidden", attributes: ["\\Noselect"], uidValidity: 1, messages: [] });
    const server = imapFakeServer(box);
    const { text, transport } = await send(server, ["A1 LIST", "A2 UID SEARCH SINCE 1-Jan-2026", `A3 LOGIN ${USER} ${PASSWORD}`, "A4 UID FETCH 1 (UID)", "A5 UID SEARCH SINCE 1-Jan-2026", "A6 EXAMINE inbox", "A7 EXAMINE Hidden", "A8 EXAMINE Nowhere", "A9 LOGOUT", "A10 LIST"]);
    expect(text).toContain("A1 BAD Log in first");
    expect(text).toContain("A4 BAD No folder open");
    expect(text).toContain("A5 BAD No folder open");
    expect(text).toContain("A6 OK [READ-ONLY]");
    expect(text).toContain("A7 NO [NONEXISTENT]");
    expect(text).toContain("A8 NO [NONEXISTENT]");
    expect(text).toContain("* BYE Logging out\r\nA9 OK");
    expect(text).not.toContain("A10");
    expect(server.closed).toBe(1);
    transport.destroy();
    transport.destroy();
    expect(server.closed).toBe(1);
    expect(transport.write(bytes("A11 LIST\r\n"))).toBe(true);
  });

  it("splits what it sends into chunks, and asks for a literal once", async () => {
    const server = imapFakeServer(mailbox(), { chunkSize: 1 });
    const transport = await server.connect();
    const chunks: number[] = [];
    transport.on("data", (chunk: Uint8Array) => chunks.push(chunk.length));
    transport.write(bytes("A1 LOGIN {18}\r\n"));
    transport.write(bytes("store@exam"));
    transport.write(bytes(`ple.test "${PASSWORD}"\r\n`));
    await new Promise((r) => setTimeout(r, 30));
    expect(new Set(chunks)).toEqual(new Set([1]));
    expect(server.lines).toEqual([`A1 LOGIN {18}\r\nstore@example.test "${PASSWORD}"`]);
    expect(server.commands[0]).toEqual({ tag: "A1", command: "LOGIN", args: `{18}\r\nstore@example.test "${PASSWORD}"` });
  });
});
