import { WHATNOT_USER_AGENT } from "../whatnot/client.js";

/**
 * A small client for the Graph API (v26.0) reads behind Messenger and
 * Instagram direct messages, with a Page access token:
 *
 * - `GET /{page-id}/conversations?platform=messenger|instagram` lists the
 *   Page's conversations, each with its id and `updated_time` (the time of
 *   its last message), with standard Graph cursor paging;
 * - `GET /{conversation-id}?fields=messages` lists the conversation's
 *   message ids with their `created_time`;
 * - `GET /{message-id}?fields=...` reads one message. Only the 20 most
 *   recent messages of a conversation can be read this way.
 *
 * Meta has no read-only messaging permission: `pages_messaging` and
 * `instagram_manage_messages` also send messages. So read-only is held
 * here, in code: the client sends GET requests to those three reads, with
 * query strings it builds itself, never follows a URL Graph returns
 * (`paging.next` only says another page exists), and has no way to send
 * anything else. The token goes in the Authorization header, never in a URL.
 *
 * Graph errors are `{error: {message, type, code, error_subcode,
 * fbtrace_id}}`. Code 190 (the token) and 200 (a permission) stop the sync
 * as a config error naming META_PAGE_ACCESS_TOKEN; 613 and 80006 (too many
 * calls), a 429 and a 500, 502, 503 or 504 are retried with backoff before
 * the error goes to runSync. The pages give no rate-limit numbers.
 */

export const META_MESSAGING_GRAPH_URL = "https://graph.facebook.com/v26.0";
/** The same User-Agent every KaratOS connector sends. */
export const META_MESSAGING_USER_AGENT = WHATNOT_USER_AGENT;
/** The DM platforms the conversations list takes, as the guides write them. */
export const META_MESSAGING_PLATFORMS = ["messenger", "instagram"] as const;
export type MetaPlatform = (typeof META_MESSAGING_PLATFORMS)[number];
/** The fields read of each message. Text is read only to count its length; nothing else about it is kept. */
export const META_MESSAGE_FIELDS = "id,created_time,from,to,message,attachments,is_unsupported";
/** Graph error codes that mean too many calls: retried with backoff. */
export const META_MESSAGING_RETRY_CODES: readonly number[] = [613, 80006];
/** The permissions each platform needs, as the conversations guides list them. */
export const META_MESSAGING_PERMISSIONS: Readonly<Record<MetaPlatform, readonly string[]>> = {
  messenger: ["pages_manage_metadata", "pages_read_engagement", "pages_messaging"],
  instagram: ["instagram_basic", "instagram_manage_messages", "pages_manage_metadata"],
};

/** A Graph id: numeric for a Page, a Page-scoped or Instagram-scoped user and an Instagram account. */
export const META_NUMERIC_ID = /^[1-9][0-9]{0,24}$/;
/** A conversation or message id. The docs give no pattern; examples look like t_123 and m_abc, or base64. */
export const META_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:=+/-]{0,511}$/;
/** The docs give no token format; Graph tokens are long runs of letters and digits. */
const TOKEN = /^[A-Za-z0-9_.-]{20,1024}$/;
/** Graph's paging cursors are opaque; any visible ASCII up to 2048 characters is taken. */
const CURSOR = /^[!-~]{1,2048}$/;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);

export interface MetaMessagingClientOptions {
  /** The Facebook Page's id: its conversations are listed. */
  pageId: string;
  /** A Page access token. It is never logged or shown. */
  pageAccessToken: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate limit or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class MetaMessagingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaMessagingConfigError";
  }
}

/** Graph answered with an error. `code` is Graph's error code, when it gave one. */
export class MetaMessagingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "MetaMessagingApiError";
  }
}

/** One page of conversations, and Graph's cursor for the next page, null after the last. */
export interface MetaConversationPage {
  rows: unknown[];
  after: string | null;
}

export interface MetaMessagingClient {
  conversations(platform: MetaPlatform, after: string | null): Promise<MetaConversationPage>;
  /** A conversation's message ids with their created times, as Graph lists them. */
  conversationMessages(conversationId: string): Promise<unknown[]>;
  message(messageId: string): Promise<unknown>;
}

export const isMetaCursor = (v: unknown): v is string => typeof v === "string" && CURSOR.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Graph's error code and subcode from its error body, when they are whole numbers. */
export function metaGraphError(body: unknown): { code: number | undefined; subcode: number | undefined } {
  const e = isObject(body) && isObject(body.error) ? body.error : {};
  const whole = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
  return { code: whole(e.code), subcode: whole(e.error_subcode) };
}

export function metaMessagingClient(options: MetaMessagingClientOptions): MetaMessagingClient {
  const pageId = options.pageId?.trim() ?? "";
  if (!META_NUMERIC_ID.test(pageId)) throw new MetaMessagingConfigError("set META_PAGE_ID to the Facebook Page's numeric id");
  const token = options.pageAccessToken?.trim() ?? "";
  if (!TOKEN.test(token)) throw new MetaMessagingConfigError("set META_PAGE_ACCESS_TOKEN to a Page access token for the Page in META_PAGE_ID");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  const headers = { accept: "application/json", authorization: `Bearer ${token}`, "user-agent": META_MESSAGING_USER_AGENT };

  async function get(path: string, query: URLSearchParams, what: string): Promise<Record<string, unknown>> {
    const url = `${META_MESSAGING_GRAPH_URL}/${path}?${query}`;
    for (let attempt = 0; ; attempt++) {
      // GET only, with the token in the Authorization header and never in the URL.
      const response = await doFetch(url, { method: "GET", headers });
      const body: unknown = await response.json().catch(() => null);
      const { code, subcode } = metaGraphError(body);
      const limited = RETRIED.has(response.status) || (code !== undefined && META_MESSAGING_RETRY_CODES.includes(code));
      if (limited && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isSafeInteger(after) && after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const said = code === undefined ? "" : ` (code ${code}${subcode === undefined ? "" : `, subcode ${subcode}`})`;
      if (response.status === 401 || response.status === 403 || code === 190) {
        throw new MetaMessagingConfigError(`Meta turned down the Page access token (HTTP ${response.status})${said}; META_PAGE_ACCESS_TOKEN must be a current Page access token for the Page in META_PAGE_ID`);
      }
      if (code === 200) {
        const needs = META_MESSAGING_PLATFORMS.map((p) => `${p} needs ${META_MESSAGING_PERMISSIONS[p].join(", ")}`).join("; ");
        throw new MetaMessagingConfigError(`Meta says META_PAGE_ACCESS_TOKEN lacks a permission to read ${what} (HTTP ${response.status})${said}: ${needs}`);
      }
      if (response.status !== 200) throw new MetaMessagingApiError(`Meta answered HTTP ${response.status} for ${what}${said}`, response.status, code);
      if (!isObject(body)) throw new MetaMessagingApiError(`Meta answered ${what} with a body that isn't a JSON object`, 200);
      return body;
    }
  }

  const node = (id: string, what: string) => {
    if (!META_NODE_ID.test(id)) throw new MetaMessagingApiError(`a ${what} id must be one Meta gave`, 0);
    return encodeURIComponent(id);
  };

  return {
    async conversations(platform, after) {
      if (!META_MESSAGING_PLATFORMS.includes(platform)) throw new MetaMessagingApiError("conversations are listed for messenger or instagram", 0);
      if (after !== null && !isMetaCursor(after)) throw new MetaMessagingApiError("a conversations cursor must be 1 to 2048 visible characters", 0);
      const query = new URLSearchParams({ platform, fields: "id,updated_time" });
      if (after !== null) query.set("after", after);
      const body = await get(`${pageId}/conversations`, query, `the ${platform} conversations`);
      if (!Array.isArray(body.data)) throw new MetaMessagingApiError(`Meta answered the ${platform} conversations without the data list`, 200);
      const paging = isObject(body.paging) ? body.paging : {};
      if (paging.next === undefined || paging.next === null) return { rows: body.data, after: null };
      const next = isObject(paging.cursors) ? paging.cursors.after : undefined;
      if (typeof paging.next !== "string" || !isMetaCursor(next)) throw new MetaMessagingApiError(`Meta answered the ${platform} conversations with a next page but no cursor that reads`, 200);
      if (next === after) throw new MetaMessagingApiError(`Meta answered the ${platform} conversations with the same cursor again`, 200);
      return { rows: body.data, after: next };
    },
    async conversationMessages(conversationId) {
      const body = await get(node(conversationId, "conversation"), new URLSearchParams({ fields: "messages" }), "a conversation's messages");
      const messages = isObject(body.messages) ? body.messages.data : body.messages === undefined ? [] : undefined;
      if (!Array.isArray(messages)) throw new MetaMessagingApiError("Meta answered a conversation's messages without the data list", 200);
      return messages;
    },
    async message(messageId) {
      return get(node(messageId, "message"), new URLSearchParams({ fields: META_MESSAGE_FIELDS }), "a message");
    },
  };
}
