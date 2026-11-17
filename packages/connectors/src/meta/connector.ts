import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import {
  META_MESSAGING_PLATFORMS,
  META_NODE_ID,
  META_NUMERIC_ID,
  MetaMessagingApiError,
  MetaMessagingConfigError,
  isMetaCursor,
  metaMessagingClient,
  type MetaMessagingClient,
  type MetaMessagingClientOptions,
  type MetaPlatform,
} from "./client.js";
import { metaConversationProblem, metaMessageEvent, metaMessageProblem, metaRefs, metaTime, type MetaEvent } from "./normalize.js";
import { MetaWebhookDeduper, metaWebhookChallenge, verifyMetaWebhook, whatsappWebhookEvents, type MetaChallengeQuery, type MetaSignatureCheck } from "./webhooks.js";

/**
 * Instagram DMs, Facebook Messenger and WhatsApp Business: every message a
 * customer sends the store and each reply, so clienteling, marketing and
 * sales see who wrote and how fast the store answered.
 *
 * Messenger and Instagram are read with a Page access token. Graph lists a
 * Page's conversations by the time of their last message, newest first, with
 * cursor paging and no time filter, and only the 20 most recent messages of
 * a conversation can be read; older ones answer that the message was
 * deleted. So a pass reads, for each channel that is on (Messenger, then
 * Instagram), page by page:
 *
 * - each conversation's message list (one request), then
 * - each of its 20 most recent messages from the pass's window (up to 20
 *   requests). Older message ids say only when they were sent, not who sent
 *   them, so they give no event.
 *
 * The historical import walks every conversation updated in the last five
 * years, and stops for good. Each later sync reads the conversations
 * updated since the last pass began, less an hour, and stops at the first
 * one older, since the list is newest first.
 *
 * Each conversation is one batch and one checkpoint, which keeps the pass's
 * window, the channel, Graph's cursor for the page and how many of its
 * conversations are done, so a resumed pass goes on from that conversation.
 * A sync sends at most META_MESSAGING_MAX_REQUESTS requests (2,100: about
 * 100 conversations of 21 reads each); past that it stops at a checkpoint
 * and the next sync of the same kind goes on from it.
 *
 * WhatsApp has no history to read: it arrives only by signed webhook (see
 * webhooks.ts), through handleWebhook.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const META_WRITES: WriteAction[] = [
  { integration: "meta", name: "send_reply", description: "Reply to a customer in a Messenger, Instagram or WhatsApp conversation", kind: "append", approval: "each", dailyCap: 10 },
  { integration: "meta", name: "mark_read", description: "Mark a Messenger, Instagram or WhatsApp conversation as read", kind: "update", approval: "each", dailyCap: 25 },
];

const HOUR_MS = 3_600_000;
/** Only this many of a conversation's most recent messages can be read. */
export const META_MESSAGING_READABLE_MESSAGES = 20;
/** The most requests one sync sends: about 100 conversations, each its message list and 20 messages. */
export const META_MESSAGING_MAX_REQUESTS = 2_100;
/** One conversation's worth of requests: its message list and the messages that can be read. */
const PER_CONVERSATION = 1 + META_MESSAGING_READABLE_MESSAGES;
/** The fewest requests a sync may be held to, so each sync gets through a page and one conversation. */
const MIN_REQUESTS = 1 + PER_CONVERSATION;
/** Each later pass starts this much before the last one began, for clock skew. */
export const META_MESSAGING_OVERLAP_MS = HOUR_MS;
/** With no checkpoint, the first later sync looks this far back. */
export const META_MESSAGING_FIRST_LOOKBACK_MS = 48 * HOUR_MS;

/** Where a pass stands: the channel, Graph's cursor for its current page, how many of that page's conversations are done, and the window. */
export interface MetaPass {
  channel: MetaPlatform;
  /** The cursor the current page was fetched with, or null for the first page. */
  after: string | null;
  skip: number;
  /** Conversations and messages before this are left out. */
  since: string;
  /** When the pass began; the next later sync starts from here, less the overlap. */
  started: string;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes. */
export interface MetaCursor {
  /** The historical import finished. Later syncs keep a checkpoint of their own, where it stays false. */
  done: boolean;
  pass: MetaPass | null;
  /** Where the next later sync starts, once a pass has finished. */
  nextSince: string | null;
}

export interface MetaOptions extends Partial<Pick<MetaMessagingClientOptions, "fetch" | "sleep" | "retries">> {
  pageId: string;
  pageAccessToken: string;
  /** The Instagram professional account linked to the Page; needed when Instagram is on, to tell the store's messages from the customer's. */
  instagramAccountId?: string;
  /** Which DM channels are read. Both by default. */
  channels?: readonly MetaPlatform[];
  /** The Meta app's secret, which signs webhook deliveries. */
  appSecret: string;
  /** The token Meta's webhook verification GET must carry. */
  verifyToken: string;
  /** The store's WhatsApp phone number id; deliveries for any other number are left out. */
  whatsappPhoneNumberId: string;
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** Conversations older than this many years are skipped. Defaults to 5. */
  historyYears?: number;
  /** The most requests one sync sends. Defaults to META_MESSAGING_MAX_REQUESTS. */
  maxRequests?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: MetaMessagingClient;
}

/** The Meta connector, with what its webhook route needs. */
export interface MetaConnector extends Connector {
  /** One verified WhatsApp delivery's events, less any already taken. Check the signature with verifyWebhook first. */
  handleWebhook(body: unknown): MetaEvent[];
  /** Checks X-Hub-Signature-256 against the raw body. */
  verifyWebhook(rawBody: string | Buffer, header: string | undefined | null): MetaSignatureCheck;
  /** The challenge to answer the verification GET with, or null to turn it down. */
  webhookChallenge(query: MetaChallengeQuery): string | null;
}

const isTime = (v: unknown): v is string => typeof v === "string" && metaTime(v) === v;
const MESSAGE = "Meta checkpoint is not in the expected shape";

export function parseMetaCursor(raw: string | null): MetaCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new Error(MESSAGE);
  }
  if (typeof c !== "object" || c === null || Array.isArray(c)) throw new Error(MESSAGE);
  const r = c as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "done,nextSince,pass" || typeof r.done !== "boolean" || (r.nextSince !== null && !isTime(r.nextSince))) throw new Error(MESSAGE);
  if (r.pass === null) return { done: r.done, pass: null, nextSince: r.nextSince as string | null };
  const p = r.pass as Record<string, unknown>;
  const passOk =
    !r.done &&
    typeof p === "object" &&
    p !== null &&
    !Array.isArray(p) &&
    Object.keys(p).sort().join(",") === "after,channel,since,skip,started" &&
    META_MESSAGING_PLATFORMS.includes(p.channel as MetaPlatform) &&
    (p.after === null || isMetaCursor(p.after)) &&
    Number.isSafeInteger(p.skip) &&
    (p.skip as number) >= 0 &&
    isTime(p.since) &&
    isTime(p.started);
  if (!passOk) throw new Error(MESSAGE);
  return { done: false, pass: { channel: p.channel as MetaPlatform, after: p.after as string | null, skip: p.skip as number, since: p.since as string, started: p.started as string }, nextSince: r.nextSince as string | null };
}

/** META_CHANNELS: messenger, instagram or both, separated by commas. Both when empty. */
export function parseMetaChannels(raw: string | undefined): MetaPlatform[] {
  if (raw === undefined || !raw.trim()) return [...META_MESSAGING_PLATFORMS];
  const names = raw.split(",").map((s) => s.trim());
  if (!names.every((n) => META_MESSAGING_PLATFORMS.includes(n as MetaPlatform))) throw new MetaMessagingConfigError("META_CHANNELS must be messenger, instagram or both, separated by a comma");
  return META_MESSAGING_PLATFORMS.filter((p) => names.includes(p));
}

const APP_SECRET = /^[a-f0-9]{32}$/;
const VERIFY_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

export function metaConnector(options: MetaOptions): MetaConnector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const refs = metaRefs(customerKey);
  const channels = options.channels === undefined ? [...META_MESSAGING_PLATFORMS] : META_MESSAGING_PLATFORMS.filter((p) => options.channels!.includes(p));
  if (channels.length === 0) throw new MetaMessagingConfigError("META_CHANNELS must turn on messenger, instagram or both");
  const pageId = options.pageId?.trim() ?? "";
  const instagramAccountId = options.instagramAccountId?.trim() ?? "";
  if (channels.includes("instagram") && !META_NUMERIC_ID.test(instagramAccountId)) {
    throw new MetaMessagingConfigError("set META_INSTAGRAM_ACCOUNT_ID to the numeric id of the Instagram account linked to the Page, or leave instagram out of META_CHANNELS");
  }
  const appSecret = options.appSecret?.trim() ?? "";
  if (!APP_SECRET.test(appSecret)) throw new MetaMessagingConfigError("set META_APP_SECRET to the Meta app's secret, 32 hex characters");
  const verifyToken = options.verifyToken?.trim() ?? "";
  if (!VERIFY_TOKEN.test(verifyToken)) throw new MetaMessagingConfigError("set WHATSAPP_VERIFY_TOKEN to 16 to 256 letters, digits, dashes or underscores");
  const whatsappPhoneNumberId = options.whatsappPhoneNumberId?.trim() ?? "";
  if (!META_NUMERIC_ID.test(whatsappPhoneNumberId)) throw new MetaMessagingConfigError("set WHATSAPP_PHONE_NUMBER_ID to the WhatsApp phone number's numeric id, not the number");
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");
  const maxRequests = options.maxRequests ?? META_MESSAGING_MAX_REQUESTS;
  if (!Number.isInteger(maxRequests) || maxRequests < MIN_REQUESTS) throw new Error(`maxRequests must be a whole number of at least ${MIN_REQUESTS}`);
  const client = options.client ?? metaMessagingClient({ ...options, pageId, pageAccessToken: options.pageAccessToken });
  const now = options.now ?? (() => new Date());
  const business: Record<MetaPlatform, string> = { messenger: pageId, instagram: instagramAccountId };
  const deduper = new MetaWebhookDeduper();

  /** The events for one conversation's readable messages in the window, and the requests they took. */
  async function conversationEvents(channel: MetaPlatform, conversationId: string, since: number, receivedAt: string): Promise<{ events: MetaEvent[]; requests: number }> {
    const listed = await client.conversationMessages(conversationId);
    const conversationRef = refs.node(channel, "conversation", conversationId);
    const ctx = { channel, businessId: business[channel], refs, conversationRef, receivedAt };
    const events: MetaEvent[] = [];
    const readable: { id: string; at: number }[] = [];
    for (const entry of listed) {
      const e = (typeof entry === "object" && entry !== null ? entry : {}) as { id?: unknown; created_time?: unknown };
      const at = metaTime(e.created_time);
      if (typeof e.id === "string" && META_NODE_ID.test(e.id) && at) readable.push({ id: e.id, at: Date.parse(at) });
      // A listed message without an id or time can't be read; it is dead-lettered.
      else events.push(metaMessageEvent(entry, ctx).event);
    }
    // Only the 20 most recent can be read; of those, the ones in the window are.
    const recent = readable.sort((a, b) => b.at - a.at).slice(0, META_MESSAGING_READABLE_MESSAGES).filter((m) => m.at >= since);
    for (const { id } of recent) {
      try {
        events.push(metaMessageEvent(await client.message(id), ctx).event);
      } catch (error) {
        // Code 100 is a bad parameter: what Meta answers for a message it says was deleted.
        if (!(error instanceof MetaMessagingApiError && error.code === 100)) throw error;
        events.push(metaMessageProblem(channel, refs.node(channel, "message", id), "Meta answered code 100: the message can't be read", receivedAt));
      }
    }
    return { events, requests: 1 + recent.length };
  }

  /** Reads a pass on from where it stands. `cursorOf` turns a pass (or null at its end) into the checkpoint. */
  async function* walk(start: MetaPass, cursorOf: (pass: MetaPass | null) => MetaCursor): AsyncIterable<SourceBatch> {
    const at = (pass: MetaPass | null) => JSON.stringify(cursorOf(pass));
    const since = Date.parse(start.since);
    let used = 0;
    // A channel turned off since the checkpoint is skipped, keeping the order Messenger then Instagram.
    let ci = channels.findIndex((c) => META_MESSAGING_PLATFORMS.indexOf(c) >= META_MESSAGING_PLATFORMS.indexOf(start.channel));
    let { after, skip } = channels[ci] === start.channel ? start : { after: null, skip: 0 };
    while (ci >= 0 && ci < channels.length) {
      const channel = channels[ci]!;
      const here = (a: string | null, s: number): MetaPass => ({ ...start, channel, after: a, skip: s });
      const next = ci + 1 < channels.length ? { ...start, channel: channels[ci + 1]!, after: null, skip: 0 } : null;
      // A page is read only when a conversation's worth of requests can follow it.
      if (used + MIN_REQUESTS > maxRequests) return;
      const page = await client.conversations(channel, after);
      used++;
      const receivedAt = now().toISOString();
      let older = false;
      for (let i = skip; i < page.rows.length; i++) {
        const row = page.rows[i];
        const c = (typeof row === "object" && row !== null ? row : {}) as { id?: unknown; updated_time?: unknown };
        const updated = metaTime(c.updated_time);
        let events: MetaEvent[];
        if (typeof c.id !== "string" || !META_NODE_ID.test(c.id) || !updated) events = [metaConversationProblem(row, channel, receivedAt)];
        else if (Date.parse(updated) < since) {
          // Newest first, so the rest of this channel is older still.
          older = true;
          break;
        } else {
          if (used + PER_CONVERSATION > maxRequests) return;
          const read = await conversationEvents(channel, c.id, since, receivedAt);
          used += read.requests;
          events = read.events;
        }
        yield { events, cursor: at(here(after, i + 1)) };
      }
      if (!older && page.after !== null) {
        [after, skip] = [page.after, 0];
        yield { events: [], cursor: at(here(after, 0)) };
        continue;
      }
      yield { events: [], cursor: at(next) };
      [ci, after, skip] = [ci + 1, null, 0];
    }
    if (ci < 0) yield { events: [], cursor: at(null) };
  }

  const nextSinceOf = (pass: MetaPass) => new Date(Date.parse(pass.started) - META_MESSAGING_OVERLAP_MS).toISOString();

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseMetaCursor(context.cursor);
    if (saved?.done) return;
    let pass = saved?.pass;
    if (!pass) {
      const t = now();
      const from = new Date(t.getTime());
      from.setUTCFullYear(from.getUTCFullYear() - historyYears);
      pass = { channel: channels[0]!, after: null, skip: 0, since: from.toISOString(), started: t.toISOString() };
    }
    const started = pass;
    yield* walk(pass, (p) => (p ? { done: false, pass: p, nextSince: null } : { done: true, pass: null, nextSince: nextSinceOf(started) }));
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseMetaCursor(context.cursor);
    const nextSince = saved?.nextSince ?? null;
    let pass = saved?.pass;
    if (!pass) {
      const t = now();
      const since = nextSince ?? new Date(t.getTime() - META_MESSAGING_FIRST_LOOKBACK_MS).toISOString();
      pass = { channel: channels[0]!, after: null, skip: 0, since, started: t.toISOString() };
    }
    const started = pass;
    yield* walk(pass, (p) => (p ? { done: false, pass: p, nextSince } : { done: false, pass: null, nextSince: nextSinceOf(started) }));
  }

  return {
    source: "meta",
    historicalImport,
    incrementalSync,
    handleWebhook: (body) => deduper.fresh(whatsappWebhookEvents(body, { phoneNumberId: whatsappPhoneNumberId, refs, receivedAt: now().toISOString(), now: now().getTime() })),
    verifyWebhook: (rawBody, header) => verifyMetaWebhook(appSecret, rawBody, header),
    webhookChallenge: (query) => metaWebhookChallenge(verifyToken, query),
    writes: META_WRITES,
  };
}
