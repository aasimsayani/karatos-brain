import { connect as tlsConnect } from "node:tls";
import { IMAP_HEADER_FIELDS } from "./headers.js";
import {
  ImapLiteralTooLarge,
  ImapProtocolError,
  ImapReader,
  imapAstring,
  imapSearchDate,
  isUid,
  parseImapValues,
  readImapResponse,
  type ImapReaderOptions,
  type ImapResponse,
  type ImapValue,
} from "./protocol.js";

/**
 * A small, read-only IMAP4rev1 client (RFC 3501) for one mailbox, over
 * implicit TLS (port 993 unless IMAP_PORT says otherwise) and nothing else:
 * no STARTTLS, no plaintext. It signs in with LOGIN, the username and an
 * app password, only once TLS is up.
 *
 * Read-only is enforced here, in code. The client can send seven commands
 * and nothing else: CAPABILITY, LOGIN, LIST, EXAMINE, UID SEARCH, UID FETCH
 * and LOGOUT. A folder is opened with EXAMINE, which the server opens
 * read-only, never SELECT. A message is fetched with exactly
 * IMAP_FETCH_ITEMS, whose BODY.PEEK leaves the \Seen flag alone. There is
 * no way to send STORE, COPY, MOVE, EXPUNGE, APPEND, CREATE or DELETE.
 *
 * The password goes to the server inside the TLS connection and nowhere
 * else: no error message, log line or checkpoint holds it.
 */

export const IMAP_DEFAULT_PORT = 993;
/** The only commands the client sends. */
export const IMAP_COMMANDS = ["CAPABILITY", "LOGIN", "LIST", "EXAMINE", "UID SEARCH", "UID FETCH", "LOGOUT"] as const;
export type ImapCommand = (typeof IMAP_COMMANDS)[number];
/** What every UID FETCH asks for: no body, only the header fields the events need, read with PEEK so nothing is marked read. */
export const IMAP_FETCH_ITEMS = `(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (${IMAP_HEADER_FIELDS.join(" ")})])`;
/** How long the client waits for the server before it gives up on the connection. */
export const IMAP_TIMEOUT_MS = 60_000;

/** The settings, checked. */
export interface ImapSettings {
  host: string;
  port: number;
  username: string;
  password: string;
}

/** What a connection must offer: a TLS socket, or a scripted server in tests. */
export interface ImapTransport {
  write(data: Uint8Array): unknown;
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  destroy(): unknown;
}

export type ImapConnect = (target: { host: string; port: number; timeoutMs: number }) => Promise<ImapTransport>;

export interface ImapClientOptions extends ImapReaderOptions {
  /** IMAP_HOST: the server's host name. */
  host: string;
  /** IMAP_PORT: 993 unless given. */
  port?: string | number;
  /** IMAP_USERNAME: the mailbox's sign-in name, usually its address. */
  username: string;
  /** IMAP_PASSWORD: an app password. Never logged or shown. */
  password: string;
  /** Opens the TLS connection; replaced in tests by a scripted server. */
  connect?: ImapConnect;
  /** How long to wait for the server; IMAP_TIMEOUT_MS unless given. */
  timeoutMs?: number;
}

export class ImapConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapConfigError";
  }
}

/** The server or the connection failed. `retryable` says whether a later attempt may go through. */
export class ImapError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ImapError";
  }
}

const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The settings, checked before anything is sent. The messages name the setting, never its value. */
export function imapSettings(options: Pick<ImapClientOptions, "host" | "port" | "username" | "password">): ImapSettings {
  const host = typeof options.host === "string" ? options.host.trim().toLowerCase() : "";
  if (!HOST.test(host)) throw new ImapConfigError("set IMAP_HOST to the IMAP server's host name, such as imap.example.com, without imaps:// or a port");
  const raw = options.port;
  const port = raw === undefined || raw === "" ? IMAP_DEFAULT_PORT : typeof raw === "number" ? raw : /^\d{1,5}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ImapConfigError("IMAP_PORT must be a whole number from 1 to 65535; leave it empty for 993, IMAP over TLS");
  const username = typeof options.username === "string" ? options.username.trim() : "";
  if (!username || username.length > 320 || CONTROL.test(username)) throw new ImapConfigError("set IMAP_USERNAME to the mailbox's sign-in name, usually its address");
  const password = typeof options.password === "string" ? options.password : "";
  if (!password || password.length > 1024 || CONTROL.test(password)) {
    throw new ImapConfigError("set IMAP_PASSWORD to the mailbox's app password, on one line with no control characters");
  }
  return { host, port, username, password };
}

/** One request the client may send. Anything else can't be written. */
export type ImapRequest =
  | { command: "CAPABILITY" }
  | { command: "LOGIN"; username: string; password: string }
  | { command: "LIST" }
  | { command: "EXAMINE"; mailbox: string }
  | { command: "UID SEARCH"; since: Date; afterUid: number }
  | { command: "UID FETCH"; uids: string }
  | { command: "LOGOUT" };

/** The keys each request may carry. */
const ALLOWED = new Map<string, readonly string[]>([
  ["CAPABILITY", ["command"]],
  ["LOGIN", ["command", "username", "password"]],
  ["LIST", ["command"]],
  ["EXAMINE", ["command", "mailbox"]],
  ["UID SEARCH", ["command", "since", "afterUid"]],
  ["UID FETCH", ["command", "uids"]],
  ["LOGOUT", ["command"]],
]);
const UID_SET = /^[1-9]\d{0,9}(?::(?:[1-9]\d{0,9}|\*))?(?:,[1-9]\d{0,9}(?::(?:[1-9]\d{0,9}|\*))?)*$/;

export type ImapCommandPart = string | { literal: Uint8Array };

/**
 * The parts of one command line, ending CRLF: text, and literals the client
 * sends once the server says to go on. This is the allow-list; anything not
 * on it throws an ImapConfigError before a byte is written.
 */
export function imapCommandParts(tag: string, request: ImapRequest): ImapCommandPart[] {
  if (!/^K\d{1,9}$/.test(tag)) throw new ImapConfigError("a command tag is K and a number");
  const command = (request as { command?: unknown })?.command;
  const keys = typeof command === "string" ? ALLOWED.get(command) : undefined;
  if (!keys) throw new ImapConfigError("the IMAP connector only sends its listed commands");
  const extra = Object.keys(request).filter((k) => !keys.includes(k));
  if (extra.length) throw new ImapConfigError(`${command} doesn't take ${extra.slice(0, 3).join(", ")}`);
  const r = request as Record<string, unknown>;
  const head = `${tag} ${command}`;
  switch (command as ImapCommand) {
    case "LOGIN":
      if (typeof r.username !== "string" || typeof r.password !== "string") throw new ImapConfigError("LOGIN takes a username and a password");
      return [`${head} `, imapAstring(r.username), " ", imapAstring(r.password), "\r\n"];
    case "LIST":
      return [`${head} "" "*"\r\n`];
    case "EXAMINE":
      if (typeof r.mailbox !== "string" || !r.mailbox || r.mailbox.length > 1000) throw new ImapConfigError("EXAMINE takes a folder name");
      return [`${head} `, imapAstring(r.mailbox), "\r\n"];
    case "UID SEARCH": {
      const since = r.since;
      if (!(since instanceof Date) || Number.isNaN(since.getTime())) throw new ImapConfigError("UID SEARCH takes a day to search since");
      const after = r.afterUid;
      if (!(after === 0 || (isUid(after) && after < 0xffffffff))) throw new ImapConfigError("UID SEARCH takes the last UID read, or 0");
      return [`${head}${after ? ` UID ${after + 1}:*` : ""} SINCE ${imapSearchDate(since)}\r\n`];
    }
    case "UID FETCH":
      if (typeof r.uids !== "string" || r.uids.length > 8192 || !UID_SET.test(r.uids)) throw new ImapConfigError("UID FETCH takes a set of UIDs");
      return [`${head} ${r.uids} ${IMAP_FETCH_ITEMS}\r\n`];
    default:
      return [`${head}\r\n`];
  }
}

/** A folder as LIST gives it. Attributes are lower-cased, such as \noselect or \sent. */
export interface ImapFolder {
  name: string;
  attributes: string[];
}

/** What EXAMINE says about a folder. */
export interface ImapFolderStatus {
  uidValidity: string;
  /** The UID the next message will get, when the server says. */
  uidNext: number | null;
}

/** One message as UID FETCH gives it. Anything the server left out or sent unreadably is null. */
export interface ImapFetched {
  uid: number;
  flags: string[];
  /** INTERNALDATE as the server wrote it. */
  internalDate: string | null;
  size: number | null;
  /** The header fields asked for, or ImapLiteralTooLarge when they were longer than the reader keeps. */
  header: Uint8Array | ImapLiteralTooLarge | null;
}

export interface ImapConnection {
  /** Every folder LIST gives. */
  list(): Promise<ImapFolder[]>;
  /** Opens a folder read-only. */
  examine(mailbox: string): Promise<ImapFolderStatus>;
  /** UIDs of messages since a day, past afterUid, oldest first. */
  search(since: Date, afterUid: number): Promise<number[]>;
  /** The messages with these UIDs, or every one past `after`, oldest first. */
  fetch(uids: string | { after: number }): Promise<ImapFetched[]>;
  /** Signs out and closes the connection; never throws. */
  close(): Promise<void>;
}

export interface ImapClient {
  /** Connects, checks the server speaks IMAP4rev1 and signs in. */
  open(): Promise<ImapConnection>;
}

const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
};
const codeName = (response: ImapResponse) => (response.code && /^[A-Z-]{1,40}$/.test(response.code.name) ? ` ${response.code.name}` : "");

/** Connects over TLS, checking the server's certificate against the host name as Node does by default. */
export const imapTlsConnect: ImapConnect = ({ host, port, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername: host, minVersion: "TLSv1.2", ALPNProtocols: ["imap"] });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

/** One signed-in conversation with the server: commands go out one at a time, and responses come back in order. */
class ImapSession {
  private readonly reader: ImapReader;
  private readonly queue: ImapResponse[] = [];
  private waiter: { resolve: (r: ImapResponse) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  private tags = 0;

  constructor(
    private readonly transport: ImapTransport,
    private readonly where: string,
    private readonly timeoutMs: number,
    reader: ImapReaderOptions,
  ) {
    this.reader = new ImapReader(reader);
    transport.on("data", (chunk) => {
      if (this.failure) return;
      try {
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
        for (const raw of this.reader.feed(bytes)) this.queue.push(readImapResponse(raw));
      } catch (error) {
        this.fail(new ImapError(`the IMAP server at ${where} didn't speak IMAP: ${(error as Error).message}`, false));
        return;
      }
      this.wake();
    });
    transport.on("error", (error) => this.fail(new ImapError(`lost the connection to the IMAP server at ${where}${errorCode(error) ? ` (${errorCode(error)})` : ""}`, true)));
    transport.on("close", () => this.fail(new ImapError(`the IMAP server at ${where} closed the connection`, true)));
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.transport.destroy();
    const w = this.waiter;
    this.waiter = null;
    w?.reject(error);
  }

  private wake(): void {
    if (!this.waiter || !this.queue.length) return;
    const w = this.waiter;
    this.waiter = null;
    w.resolve(this.queue.shift()!);
  }

  /** The next response, waiting at most timeoutMs. */
  next(): Promise<ImapResponse> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new ImapError(`the IMAP server at ${this.where} didn't answer within ${Math.round(this.timeoutMs / 1000)} s`, true)), this.timeoutMs);
      this.waiter = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  /** Sends one command and returns its untagged responses and its tagged one. */
  async run(request: ImapRequest): Promise<{ untagged: ImapResponse[]; done: ImapResponse }> {
    if (this.failure) throw this.failure;
    const tag = `K${++this.tags}`;
    const parts = imapCommandParts(tag, request);
    const untagged: ImapResponse[] = [];
    let text = "";
    const take = async (): Promise<ImapResponse | "go on"> => {
      const r = await this.next();
      if (r.tag === "*") {
        untagged.push(r);
        if (r.kind === "BYE" && request.command !== "LOGOUT") throw this.endWith(new ImapError(`the IMAP server at ${this.where} ended the session${codeName(r)}`, true));
        return take();
      }
      if (r.tag === "+") return "go on";
      if (r.tag !== tag) throw this.endWith(new ImapError(`the IMAP server at ${this.where} answered a command it wasn't sent`, false));
      return r;
    };
    for (const part of parts) {
      if (typeof part === "string") {
        text += part;
        continue;
      }
      this.transport.write(new TextEncoder().encode(`${text}{${part.literal.length}}\r\n`));
      text = "";
      const answer = await take();
      // Turned down before the literal was asked for, as a server may do with a LOGIN it won't take.
      if (answer !== "go on") return { untagged, done: answer };
      this.transport.write(part.literal);
    }
    this.transport.write(new TextEncoder().encode(text));
    for (;;) {
      const answer = await take();
      if (answer === "go on") throw this.endWith(new ImapError(`the IMAP server at ${this.where} asked for a literal that wasn't sent`, false));
      return { untagged, done: answer };
    }
  }

  private endWith(error: ImapError): ImapError {
    this.fail(error);
    return error;
  }

  destroy(): void {
    this.failure ??= new ImapError("the connection is closed", true);
    this.transport.destroy();
  }
}

const isList = (v: ImapValue | undefined): v is ImapValue[] => Array.isArray(v);
const asText = (v: ImapValue | undefined): string | null =>
  typeof v === "string" ? v : v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("latin1") : null;
const UID_VALIDITY = /^[1-9]\d{0,9}$/;

export function imapClient(options: ImapClientOptions): ImapClient {
  const settings = imapSettings(options);
  const connect = options.connect ?? imapTlsConnect;
  const timeoutMs = options.timeoutMs ?? IMAP_TIMEOUT_MS;
  const where = `${settings.host}:${settings.port}`;
  const reader: ImapReaderOptions = {
    ...(options.maxLine === undefined ? {} : { maxLine: options.maxLine }),
    ...(options.maxLiteral === undefined ? {} : { maxLiteral: options.maxLiteral }),
  };

  async function ok(session: ImapSession, request: ImapRequest): Promise<ImapResponse[]> {
    const { untagged, done } = await session.run(request);
    if (done.kind !== "OK") throw new ImapError(`the IMAP server at ${where} answered ${request.command} with ${done.kind}${codeName(done)}`, done.kind === "NO");
    return untagged;
  }

  /** Values of a data response; one that doesn't read means the server isn't speaking IMAP. */
  function values(session: ImapSession, response: ImapResponse): ImapValue[] {
    try {
      return parseImapValues(response);
    } catch (error) {
      session.destroy();
      throw new ImapError(`the IMAP server at ${where} sent a ${response.kind} response that doesn't read (${(error as ImapProtocolError).message})`, false);
    }
  }

  return {
    async open() {
      let transport: ImapTransport;
      try {
        transport = await connect({ host: settings.host, port: settings.port, timeoutMs });
      } catch (error) {
        const code = errorCode(error);
        throw new ImapError(`couldn't open a TLS connection to the IMAP server at ${where}${code ? ` (${code})` : ""}; check IMAP_HOST and IMAP_PORT`, true);
      }
      const session = new ImapSession(transport, where, timeoutMs, reader);
      try {
        const greeting = await session.next();
        if (greeting.tag !== "*" || !["OK", "PREAUTH"].includes(greeting.kind)) {
          throw new ImapError(`the IMAP server at ${where} turned the connection away${greeting.kind === "BYE" ? `${codeName(greeting)} (BYE)` : ""}`, true);
        }
        const caps = (await ok(session, { command: "CAPABILITY" }))
          .filter((r) => r.kind === "CAPABILITY")
          .flatMap((r) => values(session, r))
          .map((v) => (typeof v === "string" ? v.toUpperCase() : ""));
        if (!caps.includes("IMAP4REV1") && !caps.includes("IMAP4REV2")) throw new ImapError(`the server at ${where} doesn't speak IMAP4rev1`, false);
        if (greeting.kind !== "PREAUTH") {
          if (caps.includes("LOGINDISABLED")) throw new ImapConfigError(`the IMAP server at ${where} doesn't take LOGIN; IMAP_USERNAME and IMAP_PASSWORD can't sign in there`);
          const { done } = await session.run({ command: "LOGIN", username: settings.username, password: settings.password });
          if (done.kind !== "OK") {
            throw new ImapConfigError(
              `the IMAP server turned down IMAP_USERNAME and IMAP_PASSWORD (${done.kind}${codeName(done)}); check both, and use an app password if the provider asks for one, as most do once two-step sign-in is on`,
            );
          }
        }
      } catch (error) {
        session.destroy();
        throw error;
      }

      return {
        async list() {
          const folders: ImapFolder[] = [];
          for (const r of (await ok(session, { command: "LIST" })).filter((x) => x.kind === "LIST")) {
            const [attributes, , name] = values(session, r);
            const text = asText(name);
            if (!isList(attributes) || text === null || !text || text.length > 1000 || /[\r\n\u0000]/.test(text)) continue;
            folders.push({ name: text, attributes: attributes.filter((a): a is string => typeof a === "string").map((a) => a.toLowerCase()) });
          }
          return folders;
        },

        async examine(mailbox) {
          const untagged = await ok(session, { command: "EXAMINE", mailbox });
          const code = (name: string) => untagged.find((r) => r.kind === "OK" && r.code?.name === name)?.code?.args.trim();
          const uidValidity = code("UIDVALIDITY");
          if (!uidValidity || !UID_VALIDITY.test(uidValidity) || Number(uidValidity) > 0xffffffff) {
            session.destroy();
            throw new ImapError(`the IMAP server at ${where} didn't give a folder's UIDVALIDITY`, false);
          }
          const next = Number(code("UIDNEXT") ?? Number.NaN);
          return { uidValidity, uidNext: isUid(next) ? next : null };
        },

        async search(since, afterUid) {
          const found = new Set<number>();
          for (const r of (await ok(session, { command: "UID SEARCH", since, afterUid })).filter((x) => x.kind === "SEARCH")) {
            for (const v of values(session, r)) {
              const n = typeof v === "string" && /^\d{1,10}$/.test(v) ? Number(v) : Number.NaN;
              if (!isUid(n)) {
                session.destroy();
                throw new ImapError(`the IMAP server at ${where} answered UID SEARCH with something that isn't a UID`, false);
              }
              // "n:*" takes in the last message even when its UID is lower, so anything at or below afterUid is dropped.
              if (n > afterUid) found.add(n);
            }
          }
          return [...found].sort((a, b) => a - b);
        },

        async fetch(uids) {
          const after = typeof uids === "string" ? 0 : uids.after;
          if (typeof uids !== "string" && after >= 0xffffffff) return [];
          const set = typeof uids === "string" ? uids : `${after + 1}:*`;
          const bySeq = new Map<number, Map<string, ImapValue>>();
          for (const r of (await ok(session, { command: "UID FETCH", uids: set })).filter((x) => x.kind === "FETCH" && x.number !== undefined)) {
            const [list] = values(session, r);
            if (!isList(list) || list.length % 2) {
              session.destroy();
              throw new ImapError(`the IMAP server at ${where} sent a FETCH response that doesn't read`, false);
            }
            // A server may split one message's items over several responses.
            const items = bySeq.get(r.number!) ?? new Map<string, ImapValue>();
            for (let i = 0; i < list.length; i += 2) {
              const key = list[i];
              if (typeof key === "string") items.set(key.toUpperCase(), list[i + 1]!);
            }
            bySeq.set(r.number!, items);
          }
          const out = new Map<number, ImapFetched>();
          for (const items of bySeq.values()) {
            const uidText = items.get("UID");
            const uid = typeof uidText === "string" && /^\d{1,10}$/.test(uidText) ? Number(uidText) : Number.NaN;
            // Without a UID it is an unasked-for flag update; "n:*" also takes in the last message, which was read before.
            if (!isUid(uid) || uid <= after) continue;
            const flags = items.get("FLAGS");
            const size = items.get("RFC822.SIZE");
            const headerKey = [...items.keys()].find((k) => k.startsWith("BODY[HEADER.FIELDS"));
            const header = headerKey === undefined ? null : items.get(headerKey)!;
            out.set(uid, {
              uid,
              flags: isList(flags) ? flags.filter((f): f is string => typeof f === "string") : [],
              internalDate: asText(items.get("INTERNALDATE")),
              size: typeof size === "string" && /^\d{1,15}$/.test(size) ? Number(size) : null,
              header: header instanceof ImapLiteralTooLarge || header instanceof Uint8Array ? header : typeof header === "string" ? new TextEncoder().encode(header) : null,
            });
          }
          return [...out.values()].sort((a, b) => a.uid - b.uid);
        },

        async close() {
          await session.run({ command: "LOGOUT" }).catch(() => undefined);
          session.destroy();
        },
      };
    },
  };
}
