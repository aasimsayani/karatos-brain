import { createHash, createHmac } from "node:crypto";

/**
 * Turns Gmail message metadata and labels into Brain A events:
 * communication.message_logged for each version of a message's labels,
 * communication.message_deleted when one is deleted, and
 * communication.label_updated for each label.
 *
 * Email is the most personal source Brain A reads, so a message keeps only
 * who it was between, when, which way it went, its thread and its labels.
 * Kept: the message and thread ids, label ids, internalDate, direction (sent
 * when it carries the SENT label) and recipient counts. Dropped: bodies,
 * attachments and file names (never fetched: the scope can't see them),
 * subjects (never requested: they often hold a customer's name, a ring size
 * or an order number), the snippet Gmail sends with every message, display
 * names and every raw address.
 *
 * Each address becomes a correspondent reference: an HMAC-SHA256 of the
 * address under a key only this instance holds, so the same person is the
 * same reference across messages, but the reference can't be turned back
 * into an address or matched against another instance's. The domain is kept
 * beside it only for business domains, so a vendor's mail can be told apart
 * from a customer's; addresses at consumer mail services (gmail.com,
 * outlook.com, yahoo.com, icloud.com, ...) keep no domain.
 *
 * Drafts and spam are skipped: a draft isn't a conversation yet, and spam
 * isn't one with anybody the business knows.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface GmailBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface GmailNormalizeOptions {
  /** This instance's key for correspondent references (CORRESPONDENT_HASH_KEY). At least 32 characters. */
  correspondentKey: string;
  /** "keep" (default) keeps user label names that don't look like an address or a number; "drop" keeps none. */
  labelNames?: "keep" | "drop";
}

export interface GmailCorrespondent {
  correspondentId: string;
  /** Only for business domains. */
  domain?: string;
}

/**
 * Consumer mail services: an address there is a person's, so its domain says
 * nothing about a business and isn't kept. Country variants of the big ones
 * (yahoo.co.uk, hotmail.fr, outlook.de, ...) are matched by name below.
 */
export const GMAIL_CONSUMER_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "passport.com",
  "yahoo.com", "ymail.com", "rocketmail.com", "aol.com", "aim.com", "verizon.net",
  "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "protonmail.ch", "pm.me", "tutanota.com", "tuta.io",
  "gmx.com", "gmx.net", "gmx.de", "mail.com", "email.com", "zoho.com", "zohomail.com", "hey.com", "fastmail.com", "fastmail.fm",
  "yandex.com", "yandex.ru", "mail.ru", "inbox.ru", "list.ru", "bk.ru",
  "comcast.net", "att.net", "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net", "spectrum.net", "earthlink.net",
  "optonline.net", "frontier.com", "windstream.net", "centurylink.net", "juno.com", "netzero.net", "rogers.com", "shaw.ca", "sympatico.ca",
  "btinternet.com", "sky.com", "virginmedia.com", "talktalk.net", "web.de", "t-online.de", "freenet.de",
  "orange.fr", "wanadoo.fr", "free.fr", "laposte.net", "sfr.fr", "libero.it", "virgilio.it", "tiscali.it",
  "bigpond.com", "optusnet.com.au", "xtra.co.nz", "rediffmail.com",
  "qq.com", "163.com", "126.com", "sina.com", "naver.com", "daum.net", "hanmail.net",
]);
const CONSUMER_FAMILY = /^(yahoo|ymail|hotmail|outlook|live|msn|aol|gmx|yandex)\.([a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/;

/** Labels whose messages aren't kept. */
const SKIPPED_LABELS = new Set(["DRAFT", "SPAM"]);
/** Addresses kept per header, so a mailing to hundreds can't make one event huge. The counts stay exact. */
const MAX_ADDRESSES = 50;
const ADDRESS = /^[^\s@<>()",;:[\]\\]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const LABEL_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MS = /^\d{1,15}$/;
const HISTORY_ID = /^\d{1,20}$/;

/** True for an address domain at a consumer mail service. */
export function isConsumerDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return GMAIL_CONSUMER_DOMAINS.has(d) || CONSUMER_FAMILY.test(d);
}

/**
 * The bare addresses in an address header, lower-cased, without display
 * names. Handles `Name <a@b>`, quoted names with commas, bare addresses and
 * groups (`Team: a@b, c@d;`). Anything that isn't an address is skipped.
 */
export function gmailAddresses(header: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < header.length; i++) {
    const c = header[i]!;
    if (c === "\\" && quoted) {
      current += c + (header[++i] ?? "");
      continue;
    }
    if (c === '"' && !angle && !comment) quoted = !quoted;
    else if (!quoted && c === "(") comment++;
    else if (!quoted && c === ")" && comment) comment--;
    else if (!quoted && !comment && c === "<") angle++;
    else if (!quoted && !comment && c === ">" && angle) angle--;
    if (!quoted && !angle && !comment && (c === "," || c === ";")) {
      parts.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  parts.push(current);
  const out: string[] = [];
  for (const part of parts) {
    // Display names and comments go first, so an address-like name can't stand in for the address.
    const unquoted = part.replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/\([^()]*\)/g, "");
    const inAngles = /<([^<>]*)>/.exec(unquoted);
    // A group's name ends at its colon: "Team: a@b" leaves a@b.
    const bare = unquoted.replace(/^[^@]*:/, "").trim();
    const candidate = (inAngles ? inAngles[1]! : bare).trim().toLowerCase();
    if (ADDRESS.test(candidate)) out.push(candidate);
  }
  return out;
}

const shortHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const iso = (ms: unknown) => (typeof ms === "string" && MS.test(ms) ? new Date(Number(ms)).toISOString() : undefined);

export const gmailRef = (kind: "message" | "thread" | "label", id: string) => `gmail:${kind}:${id}`;

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): GmailBrainEvent {
  return { id: `gmail_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `gmail:${key}`, payload };
}

/** A message as messages.get answers with format=metadata. */
export interface GmailMessage {
  id?: unknown;
  threadId?: unknown;
  labelIds?: unknown;
  snippet?: unknown;
  historyId?: unknown;
  internalDate?: unknown;
  sizeEstimate?: unknown;
  payload?: { headers?: { name?: unknown; value?: unknown }[]; [field: string]: unknown };
}

/** A label as labels.list answers. */
export interface GmailLabel {
  id?: unknown;
  name?: unknown;
  type?: unknown;
}

/** The newest of a set of Gmail history ids, compared as numbers. Null when none is valid. */
export function newestHistoryId(ids: readonly unknown[]): string | null {
  let best: bigint | null = null;
  for (const id of ids) {
    if (typeof id !== "string" || !HISTORY_ID.test(id)) continue;
    const n = BigInt(id);
    if (best === null || n > best) best = n;
  }
  return best === null ? null : String(best);
}

export function gmailNormalizer(options: GmailNormalizeOptions) {
  const key = options.correspondentKey?.trim() ?? "";
  if (key.length < 32) throw new Error("set CORRESPONDENT_HASH_KEY to at least 32 characters; npm run secrets:setup generates one");
  const keepLabelNames = (options.labelNames ?? "keep") === "keep";

  /** The keyed reference for one address, with its domain if that's a business's. */
  function correspondent(address: string): GmailCorrespondent {
    const a = address.trim().toLowerCase();
    const digest = createHmac("sha256", key).update(`karatos:correspondent:v1:${a}`, "utf8").digest("hex").slice(0, 32);
    const domain = a.slice(a.lastIndexOf("@") + 1);
    return defined({ correspondentId: `correspondent:${digest}`, domain: isConsumerDomain(domain) ? undefined : domain }) as unknown as GmailCorrespondent;
  }

  function header(message: GmailMessage, name: string): string {
    const headers = Array.isArray(message.payload?.headers) ? message.payload!.headers : [];
    return headers
      .filter((h) => typeof h?.name === "string" && h.name.toLowerCase() === name.toLowerCase() && typeof h.value === "string")
      .map((h) => h.value as string)
      .join(", ");
  }

  function people(message: GmailMessage, name: string): { list: GmailCorrespondent[]; count: number } {
    const addresses = [...new Set(gmailAddresses(header(message, name)))];
    return { list: addresses.slice(0, MAX_ADDRESSES).map(correspondent), count: addresses.length };
  }

  return {
    correspondent,

    /**
     * The event for one message's current labels, or none for a draft, spam
     * or a message with no usable id. A message with no internalDate has no
     * occurredAt and is dead-lettered. The key is the message id plus a hash
     * of its label set, so a label change is a new version and a replay is a
     * duplicate.
     */
    messageEvents(message: GmailMessage, receivedAt: string): GmailBrainEvent[] {
      if (!message || typeof message !== "object") return [];
      const id = typeof message.id === "string" && ID.test(message.id) ? message.id : undefined;
      if (!id) return [];
      const labelIds = [...new Set(Array.isArray(message.labelIds) ? message.labelIds.filter((l): l is string => typeof l === "string" && LABEL_ID.test(l)) : [])].sort();
      if (labelIds.some((l) => SKIPPED_LABELS.has(l))) return [];
      const threadId = typeof message.threadId === "string" && ID.test(message.threadId) ? message.threadId : undefined;
      const from = people(message, "From");
      const to = people(message, "To");
      const cc = people(message, "Cc");
      const version = shortHash(labelIds.join(","));
      return [
        event(`message:${id}:${version}`, "communication.message_logged", iso(message.internalDate), receivedAt, defined({
          channel: "email",
          messageId: gmailRef("message", id),
          threadId: threadId && gmailRef("thread", threadId),
          direction: labelIds.includes("SENT") ? "sent" : "received",
          sentAt: iso(message.internalDate),
          from: from.list[0],
          to: to.list,
          cc: cc.list,
          recipientCount: to.count + cc.count,
          labelIds,
        })),
      ];
    },

    /** A message Gmail says was deleted, or that answered 404 when re-read. */
    deletedEvent(id: string, receivedAt: string): GmailBrainEvent[] {
      if (!ID.test(id)) return [];
      return [event(`message:${id}:deleted`, "communication.message_deleted", receivedAt, receivedAt, { channel: "email", messageId: gmailRef("message", id) })];
    },

    /**
     * One event per label. System labels (INBOX, SENT, IMPORTANT, CATEGORY_*)
     * keep their names. A user label's name is kept unless it holds an @ or a
     * run of four digits (an address, an order or phone number) or label
     * names are turned off, since a label can be named after a customer.
     * Labels carry no time, so each is stamped when read and keyed by its
     * name, so a rename is a new version.
     */
    labelEvents(labels: unknown, receivedAt: string): GmailBrainEvent[] {
      if (!Array.isArray(labels)) return [];
      return (labels as GmailLabel[]).flatMap((label) => {
        if (!label || typeof label.id !== "string" || !LABEL_ID.test(label.id)) return [];
        const kind = label.type === "system" ? "system" : "user";
        const raw = typeof label.name === "string" ? label.name.trim().slice(0, 60) : "";
        const name = kind === "system" ? raw || label.id : keepLabelNames && raw && !/@|\d{4}/.test(raw) ? raw : undefined;
        const version = shortHash(`${kind}:${name ?? ""}`);
        return [
          event(`label:${label.id}:${version}`, "communication.label_updated", receivedAt, receivedAt, defined({
            channel: "email",
            labelId: gmailRef("label", label.id),
            kind,
            name,
            nameWithheld: kind === "user" && name === undefined ? true : undefined,
          })),
        ];
      });
    },
  };
}

export type GmailNormalizer = ReturnType<typeof gmailNormalizer>;
