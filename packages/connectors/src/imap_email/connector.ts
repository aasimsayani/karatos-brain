import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { createHash } from "node:crypto";
import { imapClient, imapSettings, type ImapClient, type ImapClientOptions, type ImapConnection, type ImapFetched, type ImapFolder } from "./client.js";
import { imapNormalizer, type ImapEmailEvent, type ImapRole } from "./normalize.js";
import { imapSequenceSet } from "./protocol.js";

/**
 * Any other mailbox, over IMAP: one mailbox's INBOX and Sent folder, read
 * as the same message metadata Gmail's connector gives.
 *
 * Each pass signs in once, lists the folders and finds INBOX and the Sent
 * folder: the one LIST marks \Sent (RFC 6154), else one with a usual name
 * such as Sent or Sent Items. Folders marked \Noselect are skipped. Each
 * folder is opened with EXAMINE, so the server keeps it read-only.
 *
 * The historical import searches each folder for messages since five years
 * ago (UID SEARCH SINCE), oldest first, and fetches them 50 to a batch. Each
 * batch's checkpoint keeps, per folder, its UIDVALIDITY and the last UID
 * read, so an interrupted import searches again past that UID and goes on.
 *
 * Incremental syncs fetch each folder's messages past the last UID read
 * (UID FETCH last+1:*). The first, with no checkpoint, reads back 48 hours.
 * When a folder's UIDVALIDITY changes, its UIDs mean nothing any more, so
 * that folder is read again from five years back; messages already stored
 * come back as duplicates. Flags that change on a message already read, and
 * messages deleted later, aren't seen.
 */

/** Declared so they can be gated and audited, as Gmail's are; none runs while writes are off, and the client has no command that could. */
export const IMAP_EMAIL_WRITES: WriteAction[] = [
  { integration: "imap_email", name: "draft_reply", description: "Save a draft reply in the mailbox's Drafts folder for a person to review and send", kind: "draft", approval: "each", dailyCap: 20 },
  { integration: "imap_email", name: "flag_message", description: "Set or clear a flag on a message", kind: "update", approval: "each", dailyCap: 20 },
];

export const IMAP_BATCH_SIZE = 50;
const HOUR_MS = 3_600_000;

/** Names a Sent folder usually has where the server doesn't mark it \Sent. */
const SENT_NAMES = new Set(["sent", "sent items", "sent messages", "sent mail", "inbox.sent", "inbox/sent", "inbox.sent items", "inbox.sent messages"]);

/** Where a folder's read stands. */
export interface ImapFolderState {
  mailbox: string;
  /** Null until the folder has been opened. */
  uidValidity: string | null;
  /** The last UID read, or 0. */
  lastUid: number;
}

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface ImapCursor {
  pass: "historical" | "incremental";
  /** A digest of the server and username this was made for; a change in settings starts over. */
  account: string;
  step: "folders" | ImapRole | "done";
  /** Folders with no state yet are searched from this time. */
  since: string;
  folders: Record<ImapRole, ImapFolderState | null>;
}

export interface ImapEmailOptions extends ImapClientOptions {
  /** The instance's CORRESPONDENT_HASH_KEY. */
  correspondentKey: string;
  /** Years of history the import reads. Defaults to 5. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint reads. Defaults to 48. */
  incrementalLookbackHours?: number;
  /** Messages per batch. Defaults to 50. */
  batchSize?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: ImapClient;
}

const MESSAGE = "IMAP checkpoint is not in the expected shape";
const STEPS = ["folders", "inbox", "sent", "done"];
const isTime = (t: unknown): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t)) && new Date(Date.parse(t)).toISOString() === t;
const isMailbox = (m: unknown): m is string => typeof m === "string" && m.length > 0 && m.length <= 1000 && !/[\r\n\u0000]/.test(m);
const isValidity = (v: unknown) => v === null || (typeof v === "string" && /^[1-9]\d{0,9}$/.test(v) && Number(v) <= 0xffffffff);
const keysAre = (o: object, keys: string) => Object.keys(o).sort().join(",") === keys;

function isState(s: unknown): boolean {
  if (s === null) return true;
  if (typeof s !== "object" || Array.isArray(s) || !keysAre(s, "lastUid,mailbox,uidValidity")) return false;
  const r = s as Record<string, unknown>;
  const uid = r.lastUid;
  return isMailbox(r.mailbox) && isValidity(r.uidValidity) && Number.isInteger(uid) && (uid as number) >= 0 && (uid as number) <= 0xffffffff && (r.uidValidity !== null || uid === 0);
}

export function parseImapCursor(raw: string | null): ImapCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new Error(MESSAGE);
  }
  if (typeof c !== "object" || c === null || Array.isArray(c) || !keysAre(c, "account,folders,pass,since,step")) throw new Error(MESSAGE);
  const r = c as Record<string, unknown>;
  const f = r.folders as Record<string, unknown> | null;
  const ok =
    (r.pass === "historical" || r.pass === "incremental") &&
    typeof r.account === "string" &&
    /^account:[0-9a-f]{16}$/.test(r.account) &&
    STEPS.includes(r.step as string) &&
    isTime(r.since) &&
    typeof f === "object" &&
    f !== null &&
    !Array.isArray(f) &&
    keysAre(f, "inbox,sent") &&
    isState(f.inbox) &&
    isState(f.sent) &&
    (r.step === "folders" || f.inbox !== null) &&
    (r.step !== "sent" || f.sent !== null);
  if (!ok) throw new Error(MESSAGE);
  return c as ImapCursor;
}

/** INBOX and the Sent folder among those LIST gave, leaving out any that can't be opened. */
export function imapFolders(folders: readonly ImapFolder[]): Record<ImapRole, string | null> {
  const open = folders.filter((f) => !f.attributes.includes("\\noselect") && !f.attributes.includes("\\nonexistent"));
  const inbox = open.find((f) => f.name.toUpperCase() === "INBOX")?.name ?? "INBOX";
  const others = open.filter((f) => f.name !== inbox);
  const sent = others.find((f) => f.attributes.includes("\\sent")) ?? others.find((f) => SENT_NAMES.has(f.name.toLowerCase()));
  return { inbox, sent: sent?.name ?? null };
}

export const imapAccountLabel = (host: string, port: number, username: string) =>
  `account:${createHash("sha256").update(`${host}:${port}:${username}`).digest("hex").slice(0, 16)}`;

const chunk = <T>(list: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export function imapEmailConnector(options: ImapEmailOptions): Connector {
  const settings = imapSettings(options);
  const normalizer = imapNormalizer(options.correspondentKey);
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");
  const lookbackHours = options.incrementalLookbackHours ?? 48;
  if (!Number.isInteger(lookbackHours) || lookbackHours < 1) throw new Error("incrementalLookbackHours must be a positive whole number");
  const batchSize = options.batchSize ?? IMAP_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error("batchSize must be a whole number from 1 to 500");
  const client = options.client ?? imapClient(options);
  const now = options.now ?? (() => new Date());
  const label = imapAccountLabel(settings.host, settings.port, settings.username);
  const yearsAgo = () => {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    return start;
  };

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseImapCursor(context.cursor);
    const ours = saved?.account === label ? saved : null;
    let c: ImapCursor;
    // A finished import stays finished: its checkpoint is at "done", so nothing is read and nothing connects.
    if (mode === "historical") {
      c = ours?.pass === "historical" ? ours : { pass: "historical", account: label, step: "folders", since: yearsAgo().toISOString(), folders: { inbox: null, sent: null } };
    } else if (ours?.pass === "incremental" && ours.step !== "done") {
      c = ours;
    } else {
      const folders = ours?.pass === "incremental" ? ours.folders : { inbox: null, sent: null };
      c = { pass: "incremental", account: label, step: "folders", since: new Date(now().getTime() - lookbackHours * HOUR_MS).toISOString(), folders };
    }
    const receivedAt = now().toISOString();
    let connection: ImapConnection | null = null;
    const open = async () => (connection ??= await client.open());
    const batch = (events: ImapEmailEvent[]): SourceBatch => ({ events, cursor: JSON.stringify(c) });

    try {
      while (c.step !== "done") {
        if (c.step === "folders") {
          const found = imapFolders(await (await open()).list());
          const keep = (previous: ImapFolderState | null, mailbox: string | null): ImapFolderState | null =>
            mailbox === null ? null : previous?.mailbox === mailbox ? previous : { mailbox, uidValidity: null, lastUid: 0 };
          c = { ...c, step: "inbox", folders: { inbox: keep(c.folders.inbox, found.inbox), sent: keep(c.folders.sent, found.sent) } };
          yield batch(normalizer.labels(found.sent === null ? ["inbox"] : ["inbox", "sent"], receivedAt));
          continue;
        }
        const role: ImapRole = c.step;
        const nextStep = role === "inbox" && c.folders.sent !== null ? "sent" : "done";
        const mailbox = await open();
        let state = c.folders[role]!;
        const status = await mailbox.examine(state.mailbox);
        // A new UIDVALIDITY means every UID kept for the folder is void: read it again.
        const restarted = state.uidValidity !== null && state.uidValidity !== status.uidValidity;
        if (restarted) state = { mailbox: state.mailbox, uidValidity: null, lastUid: 0 };
        // A folder restarted or never read has no last UID (the checkpoint parser holds it at 0 without a UIDVALIDITY), so it is searched.
        const tail = mode === "incremental" && state.lastUid > 0;
        state = { ...state, uidValidity: status.uidValidity };
        const place = { role, mailbox: state.mailbox, uidValidity: status.uidValidity };

        let groups: { uids: number[]; messages: ImapFetched[] | null }[];
        if (tail) {
          groups = chunk(await mailbox.fetch({ after: state.lastUid }), batchSize).map((messages) => ({ uids: messages.map((m) => m.uid), messages }));
        } else {
          const since = restarted && mode === "incremental" ? yearsAgo() : new Date(c.since);
          groups = chunk(await mailbox.search(since, state.lastUid), batchSize).map((uids) => ({ uids, messages: null }));
        }
        // Once a folder is done, everything below UIDNEXT has been seen.
        const finish = (s: ImapFolderState): ImapFolderState => ({ ...s, lastUid: Math.max(s.lastUid, status.uidNext === null ? 0 : status.uidNext - 1) });
        if (groups.length === 0) {
          c = { ...c, step: nextStep, folders: { ...c.folders, [role]: finish(state) } };
          yield batch([]);
          continue;
        }
        for (let i = 0; i < groups.length; i++) {
          const group = groups[i]!;
          const messages = group.messages ?? (await mailbox.fetch(imapSequenceSet(group.uids)));
          const events = messages.flatMap((m) => normalizer.message(place, m, receivedAt));
          // Every UID searched or fetched is past the last one read.
          state = { ...state, lastUid: Math.max(...group.uids) };
          const last = i === groups.length - 1;
          c = { ...c, step: last ? nextStep : role, folders: { ...c.folders, [role]: last ? finish(state) : state } };
          yield batch(events);
        }
      }
    } finally {
      await (connection as ImapConnection | null)?.close();
    }
  }

  return {
    source: "imap_email",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: IMAP_EMAIL_WRITES,
  };
}
