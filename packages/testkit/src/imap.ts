import { fixtureBuilder } from "./fixtures.js";

/**
 * A scripted IMAP4rev1 server (RFC 3501, https://www.rfc-editor.org/rfc/rfc3501)
 * for connector tests. IMAP isn't HTTP, so this isn't a doc mock: there is
 * no vendor page to build one from and no fetch to answer. Instead it plays
 * the server's side of the protocol over an in-memory transport the
 * connector's client takes in place of a TLS socket.
 *
 * It answers CAPABILITY, LOGIN (quoted or as a literal), LIST, SELECT and
 * EXAMINE, UID SEARCH (SINCE and a UID set) and UID FETCH (UID, FLAGS,
 * INTERNALDATE, RFC822.SIZE and BODY or BODY.PEEK of the HEADER.FIELDS
 * asked for), and LOGOUT. Any other command, from STORE to EXPUNGE, is
 * answered BAD and kept in `forbidden`, so a test can show none was sent.
 * As a real server does, a non-PEEK BODY[...] fetch sets \Seen, and
 * `UID FETCH n:*` past the last UID still returns the last message.
 */

export interface ImapFakeMessage {
  uid: number;
  /** INTERNALDATE as the server writes it, e.g. `17-Jul-2026 02:44:25 -0700`. */
  internalDate: string;
  flags: string[];
  /** The message's header block, lines ending CRLF. Bodies are never needed. */
  header: string;
}

export interface ImapFakeFolder {
  name: string;
  /** LIST attributes, such as \Sent or \Noselect. */
  attributes: string[];
  uidValidity: number;
  /** Defaults to one past the highest UID. Null leaves UIDNEXT out of EXAMINE. */
  uidNext?: number | null;
  messages: ImapFakeMessage[];
}

export interface ImapFakeMailbox {
  username: string;
  password: string;
  folders: ImapFakeFolder[];
}

/** A command as the server received it. */
export interface ImapFakeCommand {
  tag: string;
  /** Upper-cased, with UID joined to its command: `UID FETCH`. */
  command: string;
  /** The rest of the line, with any literal written in as `{n}` and its bytes. */
  args: string;
}

export interface ImapFakeOptions {
  /** Sent first; an untagged OK unless given. */
  greeting?: string;
  /** CAPABILITY's list. */
  capabilities?: string[];
  /** Cuts everything the server writes into chunks of this many bytes, to split lines, CRLFs and literals. */
  chunkSize?: number;
  /**
   * Answers a command instead of the server: return the raw text to send
   * (lines ending CRLF, with {tag} standing for the command's tag), "hang"
   * to send nothing, "close" to drop the connection, or undefined to let
   * the server answer.
   */
  script?: (command: ImapFakeCommand, connection: number) => string | "hang" | "close" | undefined;
}

/** What a test reads back. */
export interface ImapFakeServer {
  /** Opens one connection, as the client's `connect` option. */
  connect: () => Promise<ImapFakeTransport>;
  /** Every command received, in order, across connections. */
  commands: ImapFakeCommand[];
  /** Every line the client wrote, as text, across connections. */
  lines: string[];
  /** Commands not on a read-only client's list, which the server answered BAD. */
  forbidden: ImapFakeCommand[];
  connections: number;
  /** Connections the client closed or that the server dropped. */
  closed: number;
  mailbox: ImapFakeMailbox;
}

type Listener = (...args: never[]) => void;

/** The client's end of a connection. */
export class ImapFakeTransport {
  private readonly listeners = new Map<string, Listener[]>();
  destroyed = false;

  constructor(private readonly onWrite: (data: Uint8Array) => void, private readonly onDestroy: () => void) {}

  on(event: "data" | "error" | "close", listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  write(data: Uint8Array): boolean {
    if (!this.destroyed) this.onWrite(data);
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.onDestroy();
  }

  /** Delivers bytes, an error or a close to the client, a tick later as a socket would. */
  emit(event: "data", chunk: Uint8Array): void;
  emit(event: "error", error: Error): void;
  emit(event: "close"): void;
  emit(event: string, value?: unknown): void {
    setImmediate(() => {
      if (this.destroyed && event !== "close") return;
      for (const listener of this.listeners.get(event) ?? []) (listener as (v: unknown) => void)(value);
    });
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An ISO time as an INTERNALDATE in UTC: `17-Jul-2026 02:44:25 +0000`. */
export function imapDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** Synthetic messages: from a customer on example.test to the store, a minute apart from 2026-01-01. */
export const imapMessage = fixtureBuilder<ImapFakeMessage>((n) => ({
  uid: n,
  internalDate: imapDate(new Date(Date.parse("2026-01-01T00:00:00Z") + n * 60_000).toISOString()),
  flags: ["\\Seen"],
  header: [
    `From: "Test Customer ${n}" <customer${n}@example.test>`,
    "To: Store <store@example.test>",
    `Subject: Ring sizing ${n}`,
    `Message-ID: <message-${n}@example.test>`,
    "",
    "",
  ].join("\r\n"),
}));

const enc = new TextEncoder();
const quote = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** Reads a client's arguments: atoms, quoted strings, literals and lists, flattened to strings. */
function words(args: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === " ") {
      i++;
      continue;
    }
    if (args[i] === '"') {
      let s = "";
      i++;
      while (i < args.length && args[i] !== '"') {
        if (args[i] === "\\") i++;
        s += args[i];
        i++;
      }
      i++;
      out.push(s);
      continue;
    }
    const lit = /^\{(\d+)\}\r\n/.exec(args.slice(i));
    if (lit) {
      const n = Number(lit[1]);
      // Literals are bytes; the client sends text in them as UTF-8.
      out.push(Buffer.from(args.slice(i + lit[0].length, i + lit[0].length + n), "latin1").toString("utf8"));
      i += lit[0].length + n;
      continue;
    }
    let depth = 0;
    const start = i;
    while (i < args.length && (depth > 0 || args[i] !== " ")) {
      if (args[i] === "(" || args[i] === "[") depth++;
      if (args[i] === ")" || args[i] === "]") depth--;
      i++;
    }
    out.push(args.slice(start, i));
  }
  return out;
}

/** The UIDs a sequence set names, `*` being the highest UID in the folder. */
function inSet(set: string, uid: number, max: number): boolean {
  return set.split(",").some((part) => {
    const [a, b] = part.split(":") as [string, string | undefined];
    const lo = a === "*" ? max : Number(a);
    const hi = b === undefined ? lo : b === "*" ? max : Number(b);
    return uid >= Math.min(lo, hi) && uid <= Math.max(lo, hi);
  });
}

const dayOf = (internalDate: string) => {
  const m = /^ ?(\d{1,2})-(\w{3})-(\d{4})/.exec(internalDate);
  return m ? Date.UTC(Number(m[3]), MONTHS.indexOf(m[2]!), Number(m[1])) : Number.NaN;
};

/** The named fields of a header block, folded lines and all, then the blank line. */
function headerFields(header: string, names: string[]): string {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const lines = header.split("\r\n");
  const out: string[] = [];
  let keep = false;
  for (const line of lines) {
    if (line === "") break;
    if (line[0] === " " || line[0] === "\t") {
      if (keep) out.push(line);
      continue;
    }
    keep = want.has(line.slice(0, line.indexOf(":")).toLowerCase());
    if (keep) out.push(line);
  }
  return `${out.map((l) => `${l}\r\n`).join("")}\r\n`;
}

export function imapFakeServer(mailbox: ImapFakeMailbox, options: ImapFakeOptions = {}): ImapFakeServer {
  const server: ImapFakeServer = {
    connect: async () => open(),
    commands: [],
    lines: [],
    forbidden: [],
    connections: 0,
    closed: 0,
    mailbox,
  };
  const capabilities = options.capabilities ?? ["IMAP4rev1", "AUTH=PLAIN", "SPECIAL-USE"];

  function open(): ImapFakeTransport {
    const connection = ++server.connections;
    let pending = "";
    let literalWanted = 0;
    let selected: ImapFakeFolder | null = null;
    let authed = false;
    let hung = false;
    const transport: ImapFakeTransport = new ImapFakeTransport(
      (data) => {
        pending += Buffer.from(data).toString("latin1");
        drain();
      },
      () => count(),
    );
    let dropped = false;
    let counted = false;
    const count = () => {
      if (!counted) server.closed++;
      counted = true;
    };
    const send = (text: string) => {
      if (transport.destroyed || dropped) return;
      const bytes = Buffer.from(text, "latin1");
      const size = options.chunkSize ?? bytes.length;
      for (let i = 0; i < bytes.length; i += size) transport.emit("data", new Uint8Array(bytes.subarray(i, i + size)));
    };
    const drop = () => {
      transport.emit("close");
      dropped = true;
      count();
    };

    function drain(): void {
      for (;;) {
        if (hung || dropped) return;
        // A line, plus any literals it announced.
        let end = 0;
        let full: string | null = null;
        for (;;) {
          const lf = pending.indexOf("\r\n", end);
          if (lf < 0) return;
          const line = pending.slice(end, lf);
          const lit = /\{(\d+)\}$/.exec(line);
          if (!lit) {
            full = pending.slice(0, lf);
            pending = pending.slice(lf + 2);
            break;
          }
          const n = Number(lit[1]);
          if (pending.length < lf + 2 + n) {
            // Ask for the literal once, as a synchronizing literal needs.
            if (literalWanted !== lf) {
              literalWanted = lf;
              send("+ Ready for literal data\r\n");
            }
            return;
          }
          end = lf + 2 + n;
          literalWanted = 0;
        }
        server.lines.push(full);
        handle(full);
      }
    }

    function handle(line: string): void {
      const space = line.indexOf(" ");
      const tag = line.slice(0, space < 0 ? line.length : space);
      let rest = space < 0 ? "" : line.slice(space + 1);
      let [command = ""] = rest.split(" ", 1);
      command = command.toUpperCase();
      rest = rest.slice(command.length).trimStart();
      if (command === "UID") {
        const [sub = ""] = rest.split(" ", 1);
        command = `UID ${sub.toUpperCase()}`;
        rest = rest.slice(sub.length).trimStart();
      }
      const received: ImapFakeCommand = { tag, command, args: rest };
      server.commands.push(received);
      const scripted = options.script?.(received, connection);
      if (scripted === "hang") {
        hung = true;
        return;
      }
      if (scripted === "close") return drop();
      if (scripted !== undefined) return send(scripted.replaceAll("{tag}", tag));
      send(answer(received));
      if (command === "LOGOUT") drop();
    }

    function answer({ tag, command, args }: ImapFakeCommand): string {
      const ok = (text = `${command} completed`) => `${tag} OK ${text}\r\n`;
      const bad = (text: string) => `${tag} BAD ${text}\r\n`;
      switch (command) {
        case "CAPABILITY":
          return `* CAPABILITY ${capabilities.join(" ")}\r\n${ok()}`;
        case "LOGOUT":
          return `* BYE Logging out\r\n${ok()}`;
        case "LOGIN": {
          const [user, pass] = words(args);
          if (user !== mailbox.username || pass !== mailbox.password) return `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`;
          authed = true;
          return ok("LOGIN completed");
        }
      }
      if (!authed) return bad("Log in first");
      switch (command) {
        case "LIST":
          return `${mailbox.folders.map((f) => `* LIST (${f.attributes.join(" ")}) "/" ${quote(f.name)}\r\n`).join("")}${ok()}`;
        case "SELECT":
        case "EXAMINE": {
          const [name] = words(args);
          const folder = mailbox.folders.find((f) => f.name === name || (f.name.toUpperCase() === "INBOX" && name?.toUpperCase() === "INBOX"));
          if (!folder || folder.attributes.some((a) => a.toLowerCase() === "\\noselect")) return `${tag} NO [NONEXISTENT] No such folder\r\n`;
          if (command === "SELECT") {
            server.forbidden.push({ tag, command, args });
            return bad("This server only opens folders read-only");
          }
          selected = folder;
          const max = Math.max(0, ...folder.messages.map((m) => m.uid));
          const next = folder.uidNext === undefined ? max + 1 : folder.uidNext;
          return [
            "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)",
            `* ${folder.messages.length} EXISTS`,
            "* 0 RECENT",
            `* OK [UIDVALIDITY ${folder.uidValidity}] UIDs valid`,
            ...(next === null ? [] : [`* OK [UIDNEXT ${next}] Predicted next UID`]),
            "* OK [PERMANENTFLAGS ()] No permanent flags permitted",
            `${tag} OK [READ-ONLY] EXAMINE completed`,
            "",
          ].join("\r\n");
        }
        case "UID SEARCH": {
          if (!selected) return bad("No folder open");
          const w = words(args);
          let since = Number.NEGATIVE_INFINITY;
          let set: string | null = null;
          for (let i = 0; i < w.length; i++) {
            const k = w[i]!.toUpperCase();
            if (k === "SINCE") since = dayOf(w[++i] ?? "");
            else if (k === "UID") set = w[++i] ?? "";
            else return bad(`Unknown search key ${k}`);
          }
          if (Number.isNaN(since)) return bad("Bad date");
          const max = Math.max(0, ...selected.messages.map((m) => m.uid));
          const found = selected.messages.filter((m) => dayOf(m.internalDate) >= since && (set === null || inSet(set, m.uid, max))).map((m) => m.uid);
          return `* SEARCH${found.map((u) => ` ${u}`).join("")}\r\n${ok()}`;
        }
        case "UID FETCH": {
          if (!selected) return bad("No folder open");
          const [set = "", items = ""] = words(args);
          if (!/^\(.*\)$/.test(items)) return bad("Bad fetch items");
          const max = Math.max(0, ...selected.messages.map((m) => m.uid));
          const section = /BODY(\.PEEK)?\[HEADER\.FIELDS \(([^)]*)\)\]/i.exec(items);
          const otherBody = /BODY\[(?!HEADER\.FIELDS)/i.test(items) || /RFC822(?![.]SIZE)/i.test(items);
          let out = "";
          selected.messages.forEach((m, index) => {
            if (!inSet(set, m.uid, max)) return;
            // A fetch without PEEK marks the message read, as RFC 3501 says.
            if ((section && !section[1]) || otherBody) {
              if (!m.flags.includes("\\Seen")) m.flags.push("\\Seen");
            }
            const parts = [`UID ${m.uid}`, `FLAGS (${m.flags.join(" ")})`, `INTERNALDATE "${m.internalDate}"`, `RFC822.SIZE ${enc.encode(m.header).length + 100}`];
            let literal = "";
            if (section) {
              const body = Buffer.from(headerFields(m.header, section[2]!.split(" ").filter(Boolean)), "utf8").toString("latin1");
              literal = `BODY[HEADER.FIELDS (${section[2]!.toUpperCase()})] {${body.length}}\r\n${body}`;
            }
            out += `* ${index + 1} FETCH (${parts.join(" ")}${literal ? ` ${literal}` : ""})\r\n`;
          });
          return out + ok();
        }
        default:
          server.forbidden.push({ tag, command, args });
          return bad(`${command} isn't allowed`);
      }
    }

    send(options.greeting ?? "* OK [CAPABILITY IMAP4rev1] Fake IMAP server ready\r\n");
    return transport;
  }

  return server;
}
