import { createHash, createHmac } from "node:crypto";
import { gmailNormalizer, type GmailCorrespondent } from "../gmail/normalize.js";
import type { ImapFetched } from "./client.js";
import { imapAddresses, messageIds, parseHeaderBlock } from "./headers.js";
import { ImapLiteralTooLarge, imapInternalDate } from "./protocol.js";

/**
 * Turns messages read over IMAP into the events Gmail's connector gives,
 * so mail from any provider reads like Gmail's:
 *
 * - communication.message_logged for each message, with who it was between,
 *   when, which way it went, its thread and its labels;
 * - communication.label_updated for each folder read (INBOX and SENT).
 *
 * The same things are kept and dropped as Gmail's. Kept: the message's and
 * its thread's references, INTERNALDATE (as Gmail's internalDate),
 * direction (sent for the Sent folder), recipient counts and labels in
 * Gmail's names: the folder (INBOX or SENT), UNREAD for a message without
 * \Seen and STARRED for one with \Flagged. Dropped: bodies and attachments
 * (never fetched), subjects (never asked for), keywords and the \Answered
 * flag, display names and every raw address. Each address becomes the same
 * correspondent reference Gmail's does, from Gmail's own helper, under
 * CORRESPONDENT_HASH_KEY, with the domain kept only for businesses.
 *
 * IMAP has no message or thread ids of its own that last, so the message's
 * reference is a keyed digest of its Message-ID (or, without one, of its
 * folder, UIDVALIDITY and UID), and the thread's a keyed digest of the first
 * id in References, else In-Reply-To, else the message's own. A Message-ID
 * can hold the sender's address, so neither is kept as it was.
 *
 * Drafts (\Draft) are skipped, as Gmail skips DRAFT. A message with no
 * INTERNALDATE that reads, or whose header fields didn't come back or were
 * too long, is dead-lettered with what was wrong, keyed by a sha digest.
 */

export interface ImapEmailEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const IMAP_EMAIL_EVENTS = { message: "communication.message_logged", label: "communication.label_updated" } as const;

/** The folders read, by what they are for, and the label each gives. */
export type ImapRole = "inbox" | "sent";
export const IMAP_ROLE_LABELS: Readonly<Record<ImapRole, string>> = { inbox: "INBOX", sent: "SENT" };

/** Addresses kept per field, as Gmail's connector keeps; the counts stay exact. */
const MAX_ADDRESSES = 50;
/** Longer header blocks are dead-lettered; the six fields asked for are far shorter. */
export const IMAP_HEADER_MAX = 64 * 1024;

const SYSTEM = "IMAP";
const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
export const imapRef = (kind: "message" | "thread" | "label", id: string) => `imap_email:${kind}:${id}`;

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): ImapEmailEvent {
  // Keys are made of hex, folder labels and ":", so they make ids as they are.
  return { id: `imap_email_${key}`, type, occurredAt, receivedAt, idempotencyKey: `imap_email:${key}`, payload };
}

/** Where a message was read: the folder's role, its name and UIDVALIDITY. */
export interface ImapMessagePlace {
  role: ImapRole;
  mailbox: string;
  uidValidity: string;
}

export function imapNormalizer(correspondentKey: string) {
  // Gmail's normalizer checks the key and makes the correspondent references.
  const { correspondent } = gmailNormalizer({ correspondentKey });
  const key = correspondentKey.trim();
  const keyed = (kind: string, text: string) => createHmac("sha256", key).update(`karatos:imap_email:${kind}:v1:${text}`, "utf8").digest("hex").slice(0, 32);

  function people(values: readonly string[] | undefined): { list: GmailCorrespondent[]; count: number } {
    const addresses = [...new Set(imapAddresses(values))];
    return { list: addresses.slice(0, MAX_ADDRESSES).map(correspondent), count: addresses.length };
  }

  return {
    /**
     * The event for one fetched message, none for a draft, or a dead letter.
     * The key is the message's reference plus a hash of its labels, as
     * Gmail's is, so the same message read in two folders, or with other
     * flags, is a new version, and a replay is a duplicate.
     */
    message(place: ImapMessagePlace, message: ImapFetched, receivedAt: string): ImapEmailEvent[] {
      const flags = new Set(message.flags.map((f) => f.toLowerCase()));
      if (flags.has("\\draft")) return [];
      const problems: string[] = [];
      const sentAt = imapInternalDate(message.internalDate);
      if (!sentAt) problems.push("message has no INTERNALDATE that reads");
      const header = message.header;
      if (header === null) problems.push("the server didn't return the message's header fields");
      else if (header instanceof ImapLiteralTooLarge || header.length > IMAP_HEADER_MAX) problems.push(`the message's header fields are longer than ${IMAP_HEADER_MAX} bytes`);
      if (problems.length) {
        const size = header instanceof ImapLiteralTooLarge ? header.size : header === null ? 0 : header.length;
        const digest = createHash("sha256").update(JSON.stringify([place.role, place.uidValidity, message.uid, message.internalDate, size])).digest("hex").slice(0, 16);
        return [event(`unreadable_message:${digest}`, IMAP_EMAIL_EVENTS.message, undefined, receivedAt, { system: SYSTEM, problems })];
      }
      const fields = parseHeaderBlock(header as Uint8Array);
      const own = messageIds(fields.get("message-id"))[0];
      const root = messageIds(fields.get("references"))[0] ?? messageIds(fields.get("in-reply-to"))[0] ?? own;
      const id = own ? keyed("message", own) : keyed("uid", `${place.mailbox}:${place.uidValidity}:${message.uid}`);
      const from = people(fields.get("from"));
      const to = people(fields.get("to"));
      const cc = people(fields.get("cc"));
      const labelIds = [IMAP_ROLE_LABELS[place.role], ...(flags.has("\\seen") ? [] : ["UNREAD"]), ...(flags.has("\\flagged") ? ["STARRED"] : [])].sort();
      return [
        event(`message:${id}:${short(labelIds)}`, IMAP_EMAIL_EVENTS.message, sentAt, receivedAt, defined({
          channel: "email",
          messageId: imapRef("message", id),
          threadId: root === undefined ? undefined : imapRef("thread", keyed("thread", root)),
          direction: place.role === "sent" ? "sent" : "received",
          sentAt,
          from: from.list[0],
          to: to.list,
          cc: cc.list,
          recipientCount: to.count + cc.count,
          labelIds,
        })),
      ];
    },

    /** One event per folder read, as Gmail gives one per system label. Folders carry no time, so each is stamped when read. */
    labels(roles: readonly ImapRole[], receivedAt: string): ImapEmailEvent[] {
      return roles.map((role) => {
        const name = IMAP_ROLE_LABELS[role];
        return event(`label:${name}:${short(`system:${name}`)}`, IMAP_EMAIL_EVENTS.label, receivedAt, receivedAt, { channel: "email", labelId: imapRef("label", name), kind: "system", name });
      });
    },
  };
}

export type ImapNormalizer = ReturnType<typeof imapNormalizer>;
