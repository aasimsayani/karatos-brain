import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { createHash } from "node:crypto";
import { MicrosoftConfigError, microsoftGuid } from "../microsoft_onedrive/client.js";
import { outlookTime } from "../microsoft_outlook/normalize.js";
import { TEAMS_CHANNEL_ID, TEAMS_SKIP_TOKEN, teamsClient, type TeamsClient, type TeamsClientOptions } from "./client.js";
import { teamsNormalizer, type TeamsEvent } from "./normalize.js";

/**
 * Microsoft Teams: one team's channel messages, so the hand-offs about
 * repairs and custom jobs that happen there reach the rest of the business.
 *
 * Graph has no change feed for a team's channels that an app scoped to one
 * team can read, so each sync lists every channel's threads, each with its
 * replies, newest change first, and stops at the first thread that hasn't
 * changed since the last sync (less five minutes, for clocks that differ).
 * The historical import reads back five years. Each page is one batch whose
 * checkpoint keeps the channel being read, Graph's skip token and, for each
 * channel, the newest change already read, so a resumed sync asks again
 * from the page it was on. A thread with more replies than the listing
 * carries has the rest read on their own.
 */

/** Declared so they can be gated and audited; they never run while writes are off, and the app can only read. */
export const TEAMS_WRITES: WriteAction[] = [
  { integration: "microsoft_teams", name: "post_alert", description: "Post an alert to a channel of the team", kind: "append", approval: "each", dailyCap: 20 },
  { integration: "microsoft_teams", name: "post_daily_summary", description: "Post the day's summary to a channel of the team", kind: "append", approval: "each", dailyCap: 1 },
];

/** A later sync reads back this far past the newest change it last read. */
export const TEAMS_OVERLAP_MS = 5 * 60_000;
/** Channels read in a team: Teams allows 1,000. */
export const TEAMS_MAX_CHANNELS = 1000;
/** Pages of one thread's replies read: 5,000 replies. */
const MAX_REPLY_PAGES = 100;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface TeamsCursor {
  pass: "historical" | "incremental";
  /** A digest of the team this was made for; a change in settings starts over. */
  team: string;
  /** The channels this round reads, or null until they are listed. */
  channels: string[] | null;
  /** The channel being read. */
  index: number;
  /** Graph's skip token for the channel's next page, or null for its first. */
  skip: string | null;
  /** The newest change read so far in this channel this round. */
  top: string | null;
  /** For each channel, the newest change a finished round read. */
  marks: Record<string, string>;
  /** True once the historical import has read every channel. */
  done: boolean;
  /** Nothing older than this is read. */
  since: string;
}

export interface TeamsOptions extends Partial<Pick<TeamsClientOptions, "fetch" | "sleep" | "retries">> {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  teamId: string;
  /** The instance's CORRESPONDENT_HASH_KEY. */
  correspondentKey: string;
  /** Years of history the import reads. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: TeamsClient;
}

const isTime = (t: unknown): t is string => typeof t === "string" && outlookTime(t) === t;
const isChannel = (c: unknown): c is string => typeof c === "string" && TEAMS_CHANNEL_ID.test(c);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => typeof x === "object" && x !== null) : []);
export const teamsTeamLabel = (team: string) => `team:${createHash("sha256").update(team).digest("hex").slice(0, 16)}`;

export function parseTeamsCursor(raw: string | null): TeamsCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    // Unreadable JSON leaves c undefined, which the checks below turn down.
  }
  const r = (c ?? {}) as Record<string, unknown>;
  const channels = r.channels;
  const marks = (r.marks ?? []) as Record<string, unknown>;
  const ok =
    (r.pass === "historical" || r.pass === "incremental") &&
    typeof r.team === "string" &&
    /^team:[0-9a-f]{16}$/.test(r.team) &&
    (channels === null || (Array.isArray(channels) && channels.length <= TEAMS_MAX_CHANNELS && channels.every(isChannel))) &&
    Number.isInteger(r.index) &&
    (r.index as number) >= 0 &&
    (r.index as number) < Math.max(1, (channels as string[] | null)?.length ?? 1) &&
    (r.skip === null || (typeof r.skip === "string" && TEAMS_SKIP_TOKEN.test(r.skip))) &&
    (r.top === null || isTime(r.top)) &&
    typeof marks === "object" &&
    !Array.isArray(marks) &&
    Object.keys(marks).length <= TEAMS_MAX_CHANNELS &&
    Object.entries(marks).every(([k, v]) => isChannel(k) && isTime(v)) &&
    typeof r.done === "boolean" &&
    isTime(r.since);
  if (!ok) throw new Error("Teams checkpoint is not in the expected shape");
  return { pass: r.pass as TeamsCursor["pass"], team: r.team as string, channels: channels as string[] | null, index: r.index as number, skip: r.skip as string | null, top: r.top as string | null, marks: marks as Record<string, string>, done: r.done as boolean, since: r.since as string };
}

export function teamsConnector(options: TeamsOptions): Connector {
  const team = microsoftGuid(options.teamId);
  if (!team) throw new MicrosoftConfigError("MICROSOFT_TEAMS_TEAM_ID is missing or not a team's group id");
  const normalizer = teamsNormalizer(options.correspondentKey);
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");
  const client = options.client ?? teamsClient(options);
  const now = options.now ?? (() => new Date());
  const label = teamsTeamLabel(team);

  /** A thread's replies: the ones the listing carried, or all of them when it carried only some. */
  async function repliesOf(channel: string, root: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    if (!root["replies@odata.nextLink"]) return list(root.replies);
    const all: Record<string, unknown>[] = [];
    let skip: string | null = null;
    for (let n = 0; n < MAX_REPLY_PAGES; n++) {
      const page = await client.replies(channel, String(root.id), skip);
      all.push(...page.items);
      skip = page.next;
      if (skip === null) break;
    }
    return all;
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseTeamsCursor(context.cursor);
    const at = now();
    const ours = saved?.team === label ? saved : null;
    if (mode === "historical" && ours?.pass === "historical" && ours.done) return;
    const start = new Date(at);
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    const fresh: TeamsCursor = { pass: mode, team: label, channels: null, index: 0, skip: null, top: null, marks: {}, done: false, since: start.toISOString() };
    let c: TeamsCursor;
    if (mode === "historical") c = ours?.pass === "historical" ? ours : fresh;
    // An incremental sync goes on from any checkpoint for this team: the rest of a round, or the changes since one.
    else c = ours ? { ...ours, pass: "incremental" } : fresh;
    const receivedAt = at.toISOString();
    if (c.channels === null) {
      const listed = (await client.channels()).map((ch) => ch.id).filter(isChannel);
      c = { ...c, channels: [...new Set(listed)].slice(0, TEAMS_MAX_CHANNELS), index: 0, skip: null, top: null };
    }
    const channels = c.channels!;
    if (channels.length === 0) {
      yield { events: [], cursor: JSON.stringify({ ...c, channels: null, done: true }) };
      return;
    }
    while (true) {
      const channel = channels[c.index]!;
      // Only a finished channel has a mark, so the import never stops early at one.
      const mark = c.marks[channel];
      const floor = mark === undefined ? c.since : new Date(Date.parse(mark) - TEAMS_OVERLAP_MS).toISOString();
      const page = await client.messages(channel, c.skip);
      const events: TeamsEvent[] = [];
      let top = c.top;
      let reached = false;
      for (const root of page.items) {
        const replies = await repliesOf(channel, root);
        // A thread's change time is the newest of its message's and its replies'.
        const changed = [root, ...replies].map((m) => outlookTime(m.lastModifiedDateTime) ?? outlookTime(m.createdDateTime)).filter((t) => t !== undefined).sort().at(-1);
        if ((changed ?? floor) < floor) {
          reached = true;
          break;
        }
        if (changed !== undefined && (top === null || changed > top)) top = changed;
        events.push(...normalizer.message(channel, root, receivedAt), ...replies.flatMap((m) => normalizer.message(channel, m, receivedAt)));
      }
      const ended = reached || page.next === null;
      const last = ended && c.index === channels.length - 1;
      if (!ended) c = { ...c, skip: page.next, top };
      else c = { ...c, index: last ? 0 : c.index + 1, skip: null, top: null, marks: top === null ? c.marks : { ...c.marks, [channel]: top }, channels: last ? null : channels, done: last };
      yield { events, cursor: JSON.stringify(c) };
      if (last) return;
    }
  }

  return {
    source: "microsoft_teams",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: TEAMS_WRITES,
  };
}
