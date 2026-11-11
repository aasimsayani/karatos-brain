/**
 * The IMAP4rev1 wire format (RFC 3501), as much of it as a read-only client
 * needs: a reader that cuts the server's byte stream into responses (lines,
 * with any `{n}` literals they carry), a parser for the values in them
 * (atoms, quoted strings, literals, parenthesised lists and NIL), and the
 * writer for the few commands the client may send.
 *
 * The reader caps both a line and a literal. A literal over its cap is read
 * and thrown away, so the stream stays in step, and is handed on as an
 * ImapLiteralTooLarge so that one message can be dead-lettered. A line over
 * its cap, or one holding a NUL, means the server isn't speaking IMAP and
 * ends the connection.
 */

/** A literal that was longer than the reader keeps. Only its size is known. */
export class ImapLiteralTooLarge {
  constructor(readonly size: number) {}
}

/** A value in a server response. Atoms and quoted strings are strings; NIL is null. */
export type ImapValue = string | Uint8Array | ImapLiteralTooLarge | null | ImapValue[];

/** One server response: its text, with each literal standing where `{n}` ended a line. */
export interface ImapRawResponse {
  /** The text pieces around each literal, read as Latin-1 so every byte stays as it was. */
  text: string[];
  /** The literals, one fewer than the text pieces. */
  literals: (Uint8Array | ImapLiteralTooLarge)[];
}

export class ImapProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapProtocolError";
  }
}

/** The longest line kept, literals aside. A UID SEARCH over years of mail is one long line. */
export const IMAP_MAX_LINE = 16 * 1024 * 1024;
/** The longest literal kept. Only the header fields the events need are fetched, so a real one is far shorter. */
export const IMAP_MAX_LITERAL = 256 * 1024;

const CRLF = /\r?\n/;
const LITERAL_END = /\{(\d{1,10})\}$/;
/** Stands in a response's text where a literal was; a NUL can't come from the server, which is checked. */
const MARK = "\u0000";

export interface ImapReaderOptions {
  maxLine?: number;
  maxLiteral?: number;
}

/**
 * Cuts a byte stream into responses. Feed it chunks as they come; each call
 * returns the responses the chunk completed. Chunks may split a line, a
 * CRLF or a literal anywhere.
 */
export class ImapReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private text: string[] = [];
  private literals: (Uint8Array | ImapLiteralTooLarge)[] = [];
  /** Bytes of literal still to come, and whether they are being kept. */
  private literalLeft = 0;
  private literalParts: Uint8Array[] | null = null;
  private literalSize = 0;
  private lineLength = 0;
  private readonly maxLine: number;
  private readonly maxLiteral: number;

  constructor(options: ImapReaderOptions = {}) {
    this.maxLine = options.maxLine ?? IMAP_MAX_LINE;
    this.maxLiteral = options.maxLiteral ?? IMAP_MAX_LITERAL;
  }

  feed(chunk: Uint8Array): ImapRawResponse[] {
    this.buffer = this.buffer.length ? concat([this.buffer, chunk]) : chunk;
    const out: ImapRawResponse[] = [];
    for (;;) {
      if (this.literalLeft > 0) {
        const take = Math.min(this.literalLeft, this.buffer.length);
        if (this.literalParts) this.literalParts.push(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        this.literalLeft -= take;
        if (this.literalLeft > 0) return out;
        this.literals.push(this.literalParts ? concat(this.literalParts) : new ImapLiteralTooLarge(this.literalSize));
        continue;
      }
      const end = this.buffer.indexOf(0x0a);
      if (end < 0) {
        // The last byte may be the CR of a CRLF still coming.
        if (this.lineLength + this.buffer.length > this.maxLine + 1) throw new ImapProtocolError(`the server sent a line longer than ${this.maxLine} bytes`);
        return out;
      }
      const line = latin1(this.buffer.subarray(0, end + 1)).replace(CRLF, "");
      this.buffer = this.buffer.subarray(end + 1);
      this.lineLength += line.length;
      if (this.lineLength > this.maxLine) throw new ImapProtocolError(`the server sent a line longer than ${this.maxLine} bytes`);
      if (line.includes(MARK)) throw new ImapProtocolError("the server sent a NUL byte");
      this.text.push(line);
      const literal = LITERAL_END.exec(line);
      if (literal) {
        const size = Number(literal[1]);
        if (size === 0) {
          this.literals.push(new Uint8Array(0));
          continue;
        }
        this.literalSize = size;
        this.literalParts = size > this.maxLiteral ? null : [];
        this.literalLeft = size;
        continue;
      }
      out.push({ text: this.text, literals: this.literals });
      this.text = [];
      this.literals = [];
      this.lineLength = 0;
    }
  }
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");

/** What a status response's bracketed code says, such as `UIDVALIDITY 3857529045`. */
export interface ImapCode {
  name: string;
  args: string;
}

/** A response with its tag and kind read, and the rest left for parseImapValues. */
export interface ImapResponse {
  /** `*` for untagged data, `+` for a continuation, otherwise the command's tag. */
  tag: string;
  /** Upper-cased: OK, NO, BAD, BYE, PREAUTH, CAPABILITY, LIST, SEARCH, FETCH, EXISTS and so on. Empty for a continuation. */
  kind: string;
  /** The number before the kind, as in `* 12 FETCH`. */
  number?: number;
  /** A status response's bracketed code. */
  code?: ImapCode;
  /** A status response's human text, or the raw rest of a data response. */
  rest: string;
  raw: ImapRawResponse;
}

const STATUS = new Set(["OK", "NO", "BAD", "BYE", "PREAUTH"]);
const TAG = /^[!#-'*,-[\]-z|~]+$/;

/** Reads a response's tag, kind, number and status code. */
export function readImapResponse(raw: ImapRawResponse): ImapResponse {
  const line = raw.text.join(MARK);
  if (line.startsWith("+")) return { tag: "+", kind: "", rest: line.slice(1).trimStart(), raw };
  const space = line.indexOf(" ");
  const tag = space < 0 ? line : line.slice(0, space);
  if (!TAG.test(tag)) throw new ImapProtocolError("the server sent a response without a tag");
  let rest = space < 0 ? "" : line.slice(space + 1);
  let number: number | undefined;
  const numbered = tag === "*" ? /^(\d{1,10}) /.exec(rest) : null;
  if (numbered) {
    number = Number(numbered[1]);
    rest = rest.slice(numbered[0].length);
  }
  const kindEnd = rest.indexOf(" ");
  const kind = (kindEnd < 0 ? rest : rest.slice(0, kindEnd)).toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]*$/.test(kind)) throw new ImapProtocolError("the server sent a response without a kind");
  rest = kindEnd < 0 ? "" : rest.slice(kindEnd + 1);
  const response: ImapResponse = { tag, kind, rest, raw, ...(number === undefined ? {} : { number }) };
  if (STATUS.has(kind) && number === undefined && rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close > 0) {
      const inside = rest.slice(1, close);
      const gap = inside.indexOf(" ");
      response.code = { name: (gap < 0 ? inside : inside.slice(0, gap)).toUpperCase(), args: gap < 0 ? "" : inside.slice(gap + 1) };
      response.rest = rest.slice(close + 1).trimStart();
    }
  }
  return response;
}

/**
 * The values in a data response's rest: `(UID 4 FLAGS (\Seen) BODY[...] {12}...)`
 * gives one list. An atom may hold a bracketed section with spaces and
 * parentheses in it, as `BODY[HEADER.FIELDS (FROM TO)]` does. Throws an
 * ImapProtocolError on anything that doesn't read.
 */
export function parseImapValues(response: ImapResponse): ImapValue[] {
  const text = response.rest;
  const literals = response.raw.literals;
  // The tag, number and kind are atoms, so every literal in the response is in its rest.
  let literal = 0;
  let i = 0;
  const fail = (what: string): never => {
    throw new ImapProtocolError(`the server sent ${what}`);
  };

  function value(): ImapValue {
    const c = text[i];
    if (c === "(") {
      i++;
      const list: ImapValue[] = [];
      for (;;) {
        while (text[i] === " ") i++;
        if (i >= text.length) fail("a list that doesn't end");
        if (text[i] === ")") {
          i++;
          return list;
        }
        list.push(value());
      }
    }
    if (c === '"') {
      i++;
      let out = "";
      for (;;) {
        if (i >= text.length || text[i] === MARK) fail("a quoted string that doesn't end");
        const ch = text[i]!;
        if (ch === "\\") {
          const next = text[i + 1];
          if (next !== "\\" && next !== '"') fail("a quoted string with a bad escape");
          out += next;
          i += 2;
          continue;
        }
        if (ch === '"') {
          i++;
          return out;
        }
        out += ch;
        i++;
      }
    }
    if (c === "{") {
      const m = /^\{(\d{1,10})\}\u0000/.exec(text.slice(i, i + 13));
      if (!m) fail("a literal that doesn't read");
      i += m![0].length;
      const lit = literals[literal++];
      if (lit === undefined) fail("a literal it didn't send");
      if (!(lit instanceof ImapLiteralTooLarge) && lit!.length !== Number(m![1])) fail("a literal of the wrong length");
      return lit!;
    }
    const start = i;
    let depth = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === MARK) fail("a literal inside an atom");
      if (depth > 0) {
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
      } else if (ch === "[") depth++;
      else if (ch === " " || ch === "(" || ch === ")" || ch === '"' || ch === "{") break;
      i++;
    }
    if (depth > 0) fail("a section that doesn't end");
    const atom = text.slice(start, i);
    if (!atom) fail("an empty value");
    return atom.toUpperCase() === "NIL" ? null : atom;
  }

  const out: ImapValue[] = [];
  for (;;) {
    while (text[i] === " ") i++;
    if (i >= text.length) return out;
    out.push(value());
  }
}

/**
 * An astring as the client writes it: a quoted string when it is printable
 * ASCII, a literal otherwise. Quoted strings escape `\` and `"`; CR, LF and
 * NUL can't be sent either way.
 */
export function imapAstring(value: string): string | { literal: Uint8Array } {
  if (/[\r\n\u0000]/.test(value)) throw new ImapProtocolError("a value sent to the server can't hold CR, LF or NUL");
  if (/^[\x20-\x7e]*$/.test(value)) return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return { literal: new TextEncoder().encode(value) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A day as SEARCH SINCE takes it, `1-Feb-2021`, in UTC. */
export function imapSearchDate(date: Date): string {
  return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

const INTERNALDATE = /^([ \d]?\d)-([A-Z][a-z]{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;

/** An INTERNALDATE, `17-Jul-1996 02:44:25 -0700`, as an ISO time, or undefined when it doesn't read. */
export function imapInternalDate(value: unknown): string | undefined {
  const m = typeof value === "string" ? INTERNALDATE.exec(value) : null;
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[2] as (typeof MONTHS)[number]);
  const [day, year, hour, minute, second, zh, zm] = [m[1], m[3], m[4], m[5], m[6], m[8], m[9]].map((v) => Number(v!.trim()));
  if (month < 0 || minute! > 59 || second! > 59 || zh! > 23 || zm! > 59) return undefined;
  const local = Date.UTC(year!, month, day!, hour!, minute!, second!);
  // Day 0, a day past the month's end and an hour past 23 all roll the day over; it must read back as itself.
  if (new Date(local).getUTCDate() !== day) return undefined;
  const offset = (zh! * 60 + zm!) * 60_000 * (m[7] === "-" ? -1 : 1);
  return new Date(local - offset).toISOString();
}

/** A sorted, de-duplicated list of UIDs as a sequence set: `1:3,7,9:10`. */
export function imapSequenceSet(uids: readonly number[]): string {
  const list = [...new Set(uids)].sort((a, b) => a - b);
  if (!list.length || !list.every(isUid)) throw new ImapProtocolError("a UID set needs whole numbers from 1 to 4294967295");
  const parts: string[] = [];
  let start = list[0]!;
  let prev = start;
  for (const uid of [...list.slice(1), Number.NaN]) {
    if (uid === prev + 1) {
      prev = uid;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}:${prev}`);
    start = prev = uid;
  }
  return parts.join(",");
}

/** A UID: a whole number from 1 to 2^32 - 1. */
export const isUid = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 0xffffffff;
