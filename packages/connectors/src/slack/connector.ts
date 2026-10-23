import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { SLACK_CHANNEL_ID, SLACK_LIST_PAGE, SLACK_PACING, SLACK_TS, slackClient, type SlackChannelType, type SlackClient, type SlackClientOptions } from "./client.js";
import { slackNormalizer, slackTsFrom, type SlackBrainEvent, type SlackMessage, type SlackNormalizeOptions } from "./normalize.js";
import { slackWebhookEvents } from "./webhooks.js";

/**
 * Reads the messages and threads in the channels a Slack app's bot has been
 * invited to.
 *
 * Each pass lists the workspace's channels (public, and private when the app
 * holds the private-channel scopes) and keeps the ones the bot is a member
 * of. Then, channel by channel, it reads the history newest first, one page
 * per batch, and for each thread parent on the page, the thread's replies.
 *
 * The historical import reads five years back. Incremental syncs read each
 * channel again from seven days before the previous pass started, since a
 * reply doesn't move its thread in the history, and read the replies of any
 * thread with a reply since the previous pass. A channel the bot joined since
 * the previous pass is read five years back. A reply to a thread older than
 * seven days is picked up by the Events API webhook, when it's turned on.
 *
 * The checkpoint holds the step, Slack's page cursors and the channel list,
 * so a crash resumes at the page it stopped on.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the app holds no write scope. */
export const SLACK_WRITES: WriteAction[] = [
  { integration: "slack", name: "post_recommendation", description: "Post a recommendation to a channel the bot is in (chat.postMessage)" },
  { integration: "slack", name: "post_alert", description: "Post an alert to a channel the bot is in (chat.postMessage)" },
];

/** How far back each incremental pass reads a channel's history, before the previous pass started. */
export const SLACK_THREAD_LOOKBACK_MS = 7 * 24 * 3_600_000;
/** Replies since this long before the previous pass started are read again, so nothing posted mid-pass is missed. */
export const SLACK_OVERLAP_MS = 5 * 60_000;
/** Channels read per pass. A workspace whose bot is in more is read in the order Slack lists them, up to this many. */
export const SLACK_MAX_CHANNELS = 1000;

type Step = "channels" | "messages" | "done";

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface SlackCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** conversations.list's next_cursor, or null for the first page. */
  listCursor: string | null;
  /** The channels the bot is in, as listed this pass. */
  channels: string[];
  /** The channel being read. */
  index: number;
  /** conversations.history's next_cursor in that channel, or null for its first page. */
  pageCursor: string | null;
  /** Slack timestamp: history is read back to here. */
  oldest: string;
  /** Slack timestamp: replies are read for threads with a reply since here; "0" for every thread. */
  repliesSince: string;
  /** The channels of the previous pass; a channel not among them is read from importFrom. Null: treat every channel as known. */
  known: string[] | null;
  /** Slack timestamp five years back, for channels new this pass. */
  importFrom: string;
  /** ISO time this pass started. */
  nextFrom: string;
}

export interface SlackConnectorOptions extends SlackClientOptions, SlackNormalizeOptions {
  /** Years of history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint reads. */
  incrementalLookbackHours?: number;
  /** Messages per history page; the distribution's limit unless a test says otherwise. */
  pageSize?: number;
  /** The workspace whose webhooks are accepted; others are ignored. */
  teamId?: string;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: SlackClient;
}

const STEPS: readonly Step[] = ["channels", "messages", "done"];
const KEYS = ["channels", "importFrom", "index", "known", "listCursor", "nextFrom", "oldest", "pageCursor", "pass", "repliesSince", "step"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const CURSOR = /^[A-Za-z0-9+/=_-]{1,512}$/;
const tsOrZero = (v: unknown) => typeof v === "string" && (SLACK_TS.test(v) || v === "0");
const channelList = (v: unknown) => Array.isArray(v) && v.length <= SLACK_MAX_CHANNELS && v.every((id) => typeof id === "string" && SLACK_CHANNEL_ID.test(id));
const cursorOrNull = (v: unknown) => v === null || (typeof v === "string" && CURSOR.test(v));

export function parseSlackCursor(raw: string | null): SlackCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as SlackCursor;
  if (
    !c ||
    typeof c !== "object" ||
    Array.isArray(c) ||
    Object.keys(c).sort().join() !== KEYS.join() ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    !cursorOrNull(c.listCursor) ||
    !cursorOrNull(c.pageCursor) ||
    !channelList(c.channels) ||
    !(c.known === null || channelList(c.known)) ||
    !Number.isSafeInteger(c.index) ||
    c.index < 0 ||
    c.index > c.channels.length ||
    ![c.oldest, c.repliesSince, c.importFrom].every(tsOrZero) ||
    !(typeof c.nextFrom === "string" && ISO.test(c.nextFrom) && !Number.isNaN(Date.parse(c.nextFrom)) && new Date(c.nextFrom).toISOString().slice(0, 19) === c.nextFrom.slice(0, 19))
  ) {
    throw new Error("Slack checkpoint is not in the expected shape");
  }
  return c;
}

const nextCursor = (body: Record<string, unknown>): string | null => {
  const next = (body.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
  return typeof next === "string" && CURSOR.test(next) ? next : null;
};
const messagesOf = (body: Record<string, unknown> | null): SlackMessage[] => (Array.isArray(body?.messages) ? (body!.messages as SlackMessage[]).filter((m) => m && typeof m === "object") : []);
/** Slack timestamps compare as numbers; both parts are fixed-width once padded. */
const tsKey = (ts: string) => ts.padStart(17, "0");

/** A Slack connector, whose webhook handler gives typed events. */
export interface SlackConnector extends Connector {
  handleWebhook(body: unknown): SlackBrainEvent[];
}

export function slackConnector(options: SlackConnectorOptions): SlackConnector {
  const client = options.client ?? slackClient(options);
  const normalize = slackNormalizer(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;
  const pageSize = options.pageSize ?? SLACK_PACING[options.distribution ?? "internal"].historyPage;

  function yearsBack(): string {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    return slackTsFrom(start.getTime());
  }

  function startHistorical(): SlackCursor {
    const from = yearsBack();
    return { pass: "historical", step: "channels", listCursor: null, channels: [], index: 0, pageCursor: null, oldest: from, repliesSince: "0", known: null, importFrom: from, nextFrom: now().toISOString() };
  }

  function startIncremental(previous: SlackCursor | null): SlackCursor {
    const base = previous ? Date.parse(previous.nextFrom) : now().getTime() - lookbackHours * 3_600_000;
    return {
      pass: "incremental",
      step: "channels",
      listCursor: null,
      channels: [],
      index: 0,
      pageCursor: null,
      oldest: slackTsFrom(previous ? base - SLACK_THREAD_LOOKBACK_MS : base),
      repliesSince: slackTsFrom(previous ? base - SLACK_OVERLAP_MS : base),
      known: previous ? previous.channels : null,
      importFrom: yearsBack(),
      nextFrom: now().toISOString(),
    };
  }

  /** The replies in one thread, without its parent, every page. */
  async function replies(channel: string, parent: string, since: string, receivedAt: string): Promise<SlackBrainEvent[]> {
    const events: SlackBrainEvent[] = [];
    let cursor: string | null = null;
    do {
      const body = await client.read({ method: "conversations.replies", channel, ts: parent, limit: pageSize, ...(since !== "0" ? { oldest: since } : {}), ...(cursor ? { cursor } : {}) });
      if (!body) break;
      for (const m of messagesOf(body)) if (m.ts !== parent) events.push(...normalize.messageEvents(channel, m, receivedAt));
      cursor = body.has_more === true ? nextCursor(body) : null;
    } while (cursor);
    return events;
  }

  async function channelsPage(cursor: SlackCursor): Promise<{ events: SlackBrainEvent[]; next: SlackCursor }> {
    const identity = await client.identity();
    const types: SlackChannelType[] = identity.privateChannels ? ["public_channel", "private_channel"] : ["public_channel"];
    const body = (await client.read({ method: "conversations.list", types, limit: SLACK_LIST_PAGE, ...(cursor.listCursor ? { cursor: cursor.listCursor } : {}) })) ?? {};
    const listed = Array.isArray(body.channels) ? (body.channels as { id?: unknown; is_member?: unknown }[]) : [];
    const events = normalize.channelEvents(listed, now().toISOString());
    const channels = [...cursor.channels];
    for (const c of listed) {
      if (c && c.is_member === true && typeof c.id === "string" && SLACK_CHANNEL_ID.test(c.id) && !channels.includes(c.id) && channels.length < SLACK_MAX_CHANNELS) channels.push(c.id);
    }
    const more = nextCursor(body);
    return { events, next: more ? { ...cursor, channels, listCursor: more } : { ...cursor, channels, listCursor: null, step: "messages", index: 0, pageCursor: null } };
  }

  async function messagesPage(cursor: SlackCursor): Promise<{ events: SlackBrainEvent[]; next: SlackCursor }> {
    const channel = cursor.channels[cursor.index]!;
    const isNew = cursor.known !== null && !cursor.known.includes(channel);
    const oldest = isNew ? cursor.importFrom : cursor.oldest;
    const repliesSince = isNew ? "0" : cursor.repliesSince;
    const body = await client.read({ method: "conversations.history", channel, oldest, limit: pageSize, ...(cursor.pageCursor ? { cursor: cursor.pageCursor } : {}) });
    const receivedAt = now().toISOString();
    const events: SlackBrainEvent[] = [];
    for (const message of messagesOf(body)) {
      events.push(...normalize.messageEvents(channel, message, receivedAt));
      const ts = message.ts;
      // A thread parent with a reply since the cutoff: read its replies.
      const latest = typeof message.latest_reply === "string" && SLACK_TS.test(message.latest_reply) ? message.latest_reply : null;
      if (typeof ts === "string" && SLACK_TS.test(ts) && message.thread_ts === ts && (Number(message.reply_count) > 0 || latest) && (repliesSince === "0" || (latest !== null && tsKey(latest) >= tsKey(repliesSince)))) {
        events.push(...(await replies(channel, ts, repliesSince, receivedAt)));
      }
    }
    const more = body && body.has_more === true ? nextCursor(body) : null;
    if (more) return { events, next: { ...cursor, pageCursor: more } };
    const index = cursor.index + 1;
    return { events, next: { ...cursor, index, pageCursor: null, ...(index >= cursor.channels.length ? { step: "done" as const } : {}) } };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseSlackCursor(context.cursor);
    let cursor: SlackCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved?.pass === "incremental" ? saved : null);
    }
    while (cursor.step !== "done") {
      let events: SlackBrainEvent[];
      if (cursor.step === "channels") {
        ({ events, next: cursor } = await channelsPage(cursor));
        if (cursor.step === "messages" && cursor.channels.length === 0) cursor = { ...cursor, step: "done" };
      } else {
        ({ events, next: cursor } = await messagesPage(cursor));
      }
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "slack",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    /** One verified Events API delivery. Check the signature with verifySlackWebhook first. */
    handleWebhook: (body) => slackWebhookEvents(body, normalize, now().toISOString(), options.teamId),
    writes: SLACK_WRITES,
  };
}
