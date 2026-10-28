import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { GMAIL_HISTORY_TYPES, GMAIL_METADATA_HEADERS, GMAIL_PAGE_SIZE, gmailClient, type GmailClient, type GmailClientOptions } from "./client.js";
import { gmailNormalizer, newestHistoryId, type GmailBrainEvent, type GmailMessage, type GmailNormalizeOptions } from "./normalize.js";

/**
 * Reads one mailbox's labels and message metadata.
 *
 * The historical import reads the labels, then lists every message newest
 * first, 500 to a page, reads each one's metadata and stops after a page in
 * which every message is older than five years. With the metadata scope Gmail
 * won't take a search query, so there is no date filter to send: the cutoff
 * is applied here, by internalDate.
 *
 * Incremental syncs read the labels again, then the mailbox history from the
 * last history id: messages added or deleted and labels added or removed.
 * Each message that changed is read again, so its event carries its whole
 * label set. Gmail keeps history for about a week, sometimes less; when it
 * answers 404 the pass lists messages back to where the previous pass
 * started instead. Label changes on older messages during such a gap aren't
 * seen until the message next changes.
 *
 * Gmail can push changes through Cloud Pub/Sub (users.watch), which needs a
 * Pub/Sub topic in the owner's Google Cloud project. It isn't built: the
 * scheduled sync reads the same history.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the connection itself can only read. */
export const GMAIL_WRITES: WriteAction[] = [
  { integration: "gmail", name: "draft_reply", description: "Save a draft reply in a thread for a person to review and send" },
  { integration: "gmail", name: "apply_label", description: "Add or remove a label on a message" },
];

/** Each incremental pass that falls back to listing reads back this far before the previous pass started. */
export const GMAIL_OVERLAP_MS = 5 * 60_000;

type Step = "labels" | "messages" | "history" | "done";

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface GmailCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** Gmail's page token for the current messages or history listing, or null for its first page. */
  pageToken: string | null;
  /** ISO time: listing stops once a page is wholly older than this. */
  since: string;
  /** Where the next history read starts. Null until a message has been read. */
  historyId: string | null;
  /** ISO time this pass started; a later fallback lists back to here. */
  nextFrom: string;
}

export interface GmailConnectorOptions extends GmailClientOptions, GmailNormalizeOptions {
  /** Years of history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint lists. */
  incrementalLookbackHours?: number;
  /** Messages per list page; Gmail's maximum unless a test says otherwise. */
  pageSize?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: GmailClient;
}

const STEPS: readonly Step[] = ["labels", "messages", "history", "done"];
const KEYS = ["historyId", "nextFrom", "pageToken", "pass", "since", "step"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const TOKEN = /^[A-Za-z0-9_.~-]{1,1024}$/;
const HISTORY_ID = /^\d{1,20}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseGmailCursor(raw: string | null): GmailCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as GmailCursor;
  if (
    !c ||
    typeof c !== "object" ||
    Object.keys(c).sort().join() !== KEYS.join() ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    (c.pass === "historical" && c.step === "history") ||
    !(c.pageToken === null || (typeof c.pageToken === "string" && TOKEN.test(c.pageToken))) ||
    !(c.historyId === null || (typeof c.historyId === "string" && HISTORY_ID.test(c.historyId))) ||
    (c.step === "history" && c.historyId === null) ||
    ![c.since, c.nextFrom].every((t) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t)) && new Date(t).toISOString().slice(0, 19) === t.slice(0, 19))
  ) {
    throw new Error("Gmail checkpoint is not in the expected shape");
  }
  return c;
}

const ids = (list: unknown) =>
  (Array.isArray(list) ? list : [])
    .map((entry) => (entry as { message?: { id?: unknown } } | undefined)?.message?.id ?? (entry as { id?: unknown } | undefined)?.id)
    .filter((id): id is string => typeof id === "string" && ID.test(id));

export function gmailConnector(options: GmailConnectorOptions): Connector {
  const client = options.client ?? gmailClient(options);
  const normalize = gmailNormalizer(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;
  const pageSize = options.pageSize ?? GMAIL_PAGE_SIZE;

  function startHistorical(): GmailCursor {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    return { pass: "historical", step: "labels", pageToken: null, since: start.toISOString(), historyId: null, nextFrom: now().toISOString() };
  }

  function startIncremental(previous: GmailCursor | null): GmailCursor {
    const since = previous ? new Date(Date.parse(previous.nextFrom) - GMAIL_OVERLAP_MS).toISOString() : new Date(now().getTime() - lookbackHours * 3_600_000).toISOString();
    return { pass: "incremental", step: "labels", pageToken: null, since, historyId: previous?.historyId ?? null, nextFrom: now().toISOString() };
  }

  const getMessage = (id: string) => client.read({ method: "messages.get", id, format: "metadata", metadataHeaders: GMAIL_METADATA_HEADERS }) as Promise<GmailMessage | null>;

  /** One page of messages.list: the events for messages inside the window, and whether listing goes on. */
  async function messagesPage(cursor: GmailCursor): Promise<{ events: GmailBrainEvent[]; next: GmailCursor }> {
    const body = (await client.read({ method: "messages.list", maxResults: pageSize, ...(cursor.pageToken ? { pageToken: cursor.pageToken } : {}) })) ?? {};
    const listed = ids(body.messages);
    const cutoff = Date.parse(cursor.since);
    const receivedAt = now().toISOString();
    const events: GmailBrainEvent[] = [];
    const historyIds: unknown[] = [];
    let inWindow = 0;
    for (const id of listed) {
      const message = await getMessage(id);
      // Deleted between the list and the read: nothing to keep.
      if (!message) continue;
      historyIds.push(message.historyId);
      const at = typeof message.internalDate === "string" && /^\d{1,15}$/.test(message.internalDate) ? Number(message.internalDate) : Number.NaN;
      // Older than the window: not kept. A message with no readable time is passed on and dead-lettered.
      if (Number.isFinite(at) && at < cutoff) continue;
      inWindow++;
      events.push(...normalize.messageEvents(message, receivedAt));
    }
    // The first page holds the newest messages; its newest history id is where the next history read starts.
    const historyId = cursor.pageToken === null && cursor.historyId === null ? newestHistoryId(historyIds) : cursor.historyId;
    const nextToken = typeof body.nextPageToken === "string" && TOKEN.test(body.nextPageToken) ? body.nextPageToken : null;
    // Newest first: once a whole page is older than the window, everything after it is too.
    const more = nextToken !== null && (inWindow > 0 || listed.length === 0);
    return { events, next: more ? { ...cursor, pageToken: nextToken, historyId } : { ...cursor, step: "done", pageToken: null, historyId } };
  }

  /** One page of history. Null when Gmail no longer has history that far back. */
  async function historyPage(cursor: GmailCursor): Promise<{ events: GmailBrainEvent[]; next: GmailCursor } | null> {
    const body = await client.read({
      method: "history.list",
      startHistoryId: cursor.historyId!,
      maxResults: GMAIL_PAGE_SIZE,
      historyTypes: GMAIL_HISTORY_TYPES,
      ...(cursor.pageToken ? { pageToken: cursor.pageToken } : {}),
    });
    if (!body) return null;
    const changed = new Set<string>();
    const deleted = new Set<string>();
    for (const record of Array.isArray(body.history) ? (body.history as Record<string, unknown>[]) : []) {
      for (const id of [...ids(record?.messagesAdded), ...ids(record?.labelsAdded), ...ids(record?.labelsRemoved)]) if (!deleted.has(id)) changed.add(id);
      for (const id of ids(record?.messagesDeleted)) {
        changed.delete(id);
        deleted.add(id);
      }
    }
    const receivedAt = now().toISOString();
    const events: GmailBrainEvent[] = [];
    for (const id of changed) {
      const message = await getMessage(id);
      events.push(...(message ? normalize.messageEvents(message, receivedAt) : normalize.deletedEvent(id, receivedAt)));
    }
    for (const id of deleted) events.push(...normalize.deletedEvent(id, receivedAt));
    const nextToken = typeof body.nextPageToken === "string" && TOKEN.test(body.nextPageToken) ? body.nextPageToken : null;
    if (nextToken) return { events, next: { ...cursor, pageToken: nextToken } };
    const latest = typeof body.historyId === "string" && HISTORY_ID.test(body.historyId) ? body.historyId : cursor.historyId;
    return { events, next: { ...cursor, step: "done", pageToken: null, historyId: latest } };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseGmailCursor(context.cursor);
    let cursor: GmailCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved?.pass === "incremental" ? saved : null);
    }

    while (cursor.step !== "done") {
      let events: GmailBrainEvent[] = [];
      if (cursor.step === "labels") {
        const body = (await client.read({ method: "labels.list" })) ?? {};
        events = normalize.labelEvents(body.labels, now().toISOString());
        cursor = { ...cursor, step: cursor.historyId !== null && cursor.pass === "incremental" ? "history" : "messages", pageToken: null };
      } else if (cursor.step === "messages") {
        ({ events, next: cursor } = await messagesPage(cursor));
      } else {
        const page = await historyPage(cursor);
        if (page) {
          ({ events, next: cursor } = page);
        } else {
          // History has expired: list back to where the previous pass started, and take a fresh history id.
          cursor = { ...cursor, step: "messages", pageToken: null, historyId: null };
          continue;
        }
      }
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "gmail",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: GMAIL_WRITES,
  };
}
