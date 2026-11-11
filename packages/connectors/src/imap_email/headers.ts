import { gmailAddresses } from "../gmail/normalize.js";

/**
 * The few RFC 5322 header fields the mail events need (From, To, Cc,
 * Message-ID, In-Reply-To and References), read from the header block the
 * server returns for BODY.PEEK[HEADER.FIELDS (...)], with RFC 2047
 * encoded words decoded where an address can only be found that way.
 */

/** Header fields fetched for each message. No Subject, Date or body is ever asked for. */
export const IMAP_HEADER_FIELDS = ["FROM", "TO", "CC", "MESSAGE-ID", "IN-REPLY-TO", "REFERENCES"] as const;

const FIELD_NAME = /^[!-9;-~]{1,76}$/;

/**
 * A header block's fields, by lower-cased name, each with every value it
 * has. Folded lines are unfolded. A line that is neither a field nor a
 * continuation is skipped, and the block ends at its first empty line.
 * Bytes are read as UTF-8, which RFC 6532 allows in headers; anything else
 * that isn't ASCII becomes U+FFFD and can't be mistaken for an address.
 */
export function parseHeaderBlock(bytes: Uint8Array): Map<string, string[]> {
  const text = new TextDecoder("utf-8").decode(bytes);
  const fields = new Map<string, string[]>();
  let current: { name: string; value: string } | null = null;
  const flush = () => {
    if (!current) return;
    const list = fields.get(current.name) ?? [];
    list.push(current.value.trim());
    fields.set(current.name, list);
    current = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") break;
    if (line[0] === " " || line[0] === "\t") {
      // A continuation: unfolding drops the line break and keeps the white space.
      if (current) (current as { value: string }).value += line;
      continue;
    }
    flush();
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon).trimEnd() : "";
    if (!FIELD_NAME.test(name)) continue;
    current = { name: name.toLowerCase(), value: line.slice(colon + 1) };
  }
  flush();
  return fields;
}

const ENCODED_WORD = /=\?([^?\s*]+)(?:\*[^?\s]*)?\?([BbQq])\?([^?\s]*)\?=/g;
/** Charsets an encoded word may name, mapped to what TextDecoder calls them. */
const CHARSETS = new Map<string, string>([
  ["utf-8", "utf-8"],
  ["utf8", "utf-8"],
  ["us-ascii", "utf-8"],
  ["ascii", "utf-8"],
  ["iso-8859-1", "iso-8859-1"],
  ["latin1", "iso-8859-1"],
  ["iso-8859-15", "iso-8859-15"],
  ["windows-1252", "windows-1252"],
  ["cp1252", "windows-1252"],
]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2,3})?$/;
// Printable ASCII but "=" and "?", or =XX.
const Q_TEXT = /^(?:[!-<>@-~]|=[0-9A-Fa-f]{2})*$/;

/** One encoded word's bytes, or null when it doesn't read. */
function wordBytes(encoding: string, text: string): Uint8Array | null {
  if (encoding === "B") return BASE64.test(text) ? new Uint8Array(Buffer.from(text, "base64")) : null;
  if (!Q_TEXT.test(text)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "_") bytes.push(0x20);
    else if (c === "=") {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(c.charCodeAt(0));
  }
  return new Uint8Array(bytes);
}

/**
 * A header value with its RFC 2047 encoded words (`=?utf-8?B?...?=`,
 * `=?iso-8859-1?Q?...?=`) decoded. White space between two encoded words
 * is dropped, as the RFC says. A word in a charset not listed above, or
 * whose text doesn't read, is left as it was.
 */
export function decodeEncodedWords(value: string): string {
  let out = "";
  let last = 0;
  let previousWasWord = false;
  for (const m of value.matchAll(ENCODED_WORD)) {
    const between = value.slice(last, m.index);
    const charset = CHARSETS.get(m[1]!.toLowerCase());
    const bytes = charset ? wordBytes(m[2]!.toUpperCase(), m[3]!) : null;
    if (bytes === null) {
      out += between + m[0];
      previousWasWord = false;
    } else {
      out += previousWasWord && /^[ \t]*$/.test(between) ? "" : between;
      out += new TextDecoder(charset).decode(bytes);
      previousWasWord = true;
    }
    last = m.index + m[0].length;
  }
  return out + value.slice(last);
}

/**
 * The bare addresses in an address field, lower-cased, as Gmail's
 * connector reads them. Display names are dropped before they are decoded,
 * so a decoded name can't pose as an address. Only when the raw field holds
 * no address at all, as when a mailer has encoded the whole field, is it
 * decoded and read again.
 */
export function imapAddresses(values: readonly string[] | undefined): string[] {
  const raw = (values ?? []).join(", ");
  const found = gmailAddresses(raw);
  if (found.length || !raw.includes("=?")) return found;
  return gmailAddresses(decodeEncodedWords(raw));
}

const MSG_ID = /<([^<>\s]{1,998})>/g;

/** The message ids in a Message-ID, In-Reply-To or References field, in order. */
export function messageIds(values: readonly string[] | undefined): string[] {
  return [...(values ?? []).join(" ").slice(0, 16_384).matchAll(MSG_ID)].map((m) => m[1]!);
}
