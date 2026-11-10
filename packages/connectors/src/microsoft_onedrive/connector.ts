import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { createHash } from "node:crypto";
import { MICROSOFT_DELTA_TOKEN, MICROSOFT_DRIVE_ID, MicrosoftConfigError, MicrosoftResyncError, microsoftClient, type MicrosoftClient, type MicrosoftClientOptions } from "./client.js";
import { microsoftItemEvents, type MicrosoftBrainEvent } from "./normalize.js";
import { microsoftClientStateOk, microsoftWebhookPrompts } from "./webhooks.js";

/**
 * OneDrive and SharePoint: the document library a store keeps its
 * statements, invoices, appraisals and design files in.
 *
 * The historical import reads the drive's delta from the start, which lists
 * every folder and file the app can see, keeping every folder and each file
 * changed in the last five years. Graph ends the listing with a delta token,
 * which becomes the change feed: each later sync asks only for what changed
 * since, including deletions, renames and moves, so nothing is listed
 * twice. Every batch's checkpoint keeps Graph's token, so a resumed sync
 * asks again from the page it was on and what it reads twice comes back as
 * duplicates. If Graph answers 410 Gone, the drive is listed again;
 * anything deleted in between can't be seen then.
 *
 * Graph's notifications only say the drive changed, so they prompt a sync
 * (webhookPromptsSync) rather than carrying events.
 */

/** Declared so they can be gated and audited; they never run while writes are off, and the app can only read. */
export const MICROSOFT_ONEDRIVE_WRITES: WriteAction[] = [
  { integration: "microsoft_onedrive", name: "save_report", description: "Save a generated report to a folder in the library" },
  { integration: "microsoft_onedrive", name: "create_subscription", description: "Ask Microsoft Graph to send change notifications for the drive" },
];

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface MicrosoftOneDriveCursor {
  pass: "historical" | "incremental";
  /** The drive this cursor was made for; a change in settings starts over. */
  drive: string;
  /** listing: the drive is being listed; changes: reading what changed since it was. */
  phase: "listing" | "changes";
  /** Graph's token for the next page, or null before the first. */
  token: string | null;
  /** True once Graph gave the delta link that ends a round. */
  done: boolean;
  /** Files changed before this aren't kept while listing. */
  since: string;
}

export interface MicrosoftOneDriveOptions extends Partial<Pick<MicrosoftClientOptions, "fetch" | "sleep" | "rateLimitRetries">> {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** MICROSOFT_ONEDRIVE_DRIVE_ID: the drive (document library) to read. */
  driveId: string;
  /** MICROSOFT_ONEDRIVE_FILE_NAMES: "keep" (default) or "drop". */
  fileNames?: "keep" | "drop";
  /** MICROSOFT_GRAPH_CLIENT_STATE: the secret the subscription was made with, when notifications are on. */
  clientState?: string | undefined;
  /** Years of history a listing keeps. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: MicrosoftClient;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isTime = (t: unknown) => typeof t === "string" && ISO.test(t) && new Date(t).toISOString() === t;
/** Resyncs one sync takes before it stops and leaves the rest to the next. */
const MAX_RESYNCS = 3;
/** Pages one round reads at most, so a link that never ends can't keep a sync going. */
const MAX_PAGES = 100_000;

export function parseMicrosoftOneDriveCursor(raw: string | null): MicrosoftOneDriveCursor | null {
  if (raw === null) return null;
  let c: MicrosoftOneDriveCursor | null;
  try {
    c = JSON.parse(raw) as MicrosoftOneDriveCursor | null;
  } catch {
    c = null;
  }
  const ok =
    typeof c === "object" &&
    c !== null &&
    (c.pass === "historical" || c.pass === "incremental") &&
    typeof c.drive === "string" &&
    MICROSOFT_DRIVE_ID.test(c.drive) &&
    (c.phase === "listing" || c.phase === "changes") &&
    (c.token === null || (typeof c.token === "string" && MICROSOFT_DELTA_TOKEN.test(c.token))) &&
    typeof c.done === "boolean" &&
    // A finished listing or a change feed always has a token.
    (c.token !== null || (!c.done && c.phase === "listing")) &&
    isTime(c.since);
  if (!ok || !c) throw new Error("OneDrive checkpoint is not in the expected shape");
  const { pass, drive, phase, token, done, since } = c;
  return { pass, drive, phase, token, done, since };
}

/** Reads MICROSOFT_ONEDRIVE_DRIVE_ID, or throws a config error naming it. */
export function checkMicrosoftDriveId(value: unknown): string {
  const drive = typeof value === "string" ? value.trim() : "";
  if (!MICROSOFT_DRIVE_ID.test(drive)) throw new MicrosoftConfigError("set MICROSOFT_ONEDRIVE_DRIVE_ID to the library's drive id, which starts with b!");
  return drive;
}

export function microsoftOneDriveConnector(options: MicrosoftOneDriveOptions): Connector & { webhookPromptsSync(body: unknown): boolean } {
  const drive = checkMicrosoftDriveId(options.driveId);
  if (options.fileNames !== undefined && options.fileNames !== "keep" && options.fileNames !== "drop") throw new MicrosoftConfigError("MICROSOFT_ONEDRIVE_FILE_NAMES is keep or drop");
  if (options.clientState !== undefined && !microsoftClientStateOk(options.clientState)) throw new MicrosoftConfigError("MICROSOFT_GRAPH_CLIENT_STATE is 16 to 128 printable characters");
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");
  const client = options.client ?? microsoftClient(options);
  const now = options.now ?? (() => new Date());
  const fileNames = options.fileNames ?? "keep";
  const clientState = options.clientState;

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseMicrosoftOneDriveCursor(context.cursor);
    const at = now();
    const ours = saved?.drive === drive ? saved : null;
    if (mode === "historical" && ours?.pass === "historical" && ours.done) return;
    const start = new Date(at);
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    const fresh: MicrosoftOneDriveCursor = { pass: mode, drive, phase: "listing", token: null, done: false, since: start.toISOString() };
    let c: MicrosoftOneDriveCursor;
    if (mode === "historical") c = ours?.pass === "historical" ? ours : fresh;
    // An incremental sync goes on from any checkpoint for this drive: the rest of a listing, or its changes.
    else c = ours ? { ...ours, pass: "incremental" } : fresh;
    const receivedAt = at.toISOString();
    let resyncs = 0;

    for (let n = 0; ; n++) {
      if (n >= MAX_PAGES) throw new Error("OneDrive's delta kept paging past the most one sync reads");
      let page;
      try {
        page = await client.delta(drive, c.token);
      } catch (error) {
        if (!(error instanceof MicrosoftResyncError) || ++resyncs > MAX_RESYNCS) throw error;
        c = { ...fresh, since: c.since };
        continue;
      }
      const ctx = { receivedAt, fileNames, since: c.phase === "listing" ? c.since : undefined, page: c.token ?? `list:${drive}` };
      const events: MicrosoftBrainEvent[] = page.items.flatMap((item) => microsoftItemEvents(item, ctx));
      const last = page.next === null;
      c = { ...c, token: last ? page.delta! : page.next!, done: last, phase: last ? "changes" : c.phase };
      yield { events, cursor: JSON.stringify(c) };
      if (last) return;
    }
  }

  return {
    source: "microsoft_onedrive",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: MICROSOFT_ONEDRIVE_WRITES,
    webhookPromptsSync(body) {
      // Without a client state, nothing matches.
      return microsoftWebhookPrompts(body, clientState ?? "");
    },
  };
}

/** A short, stable name for a drive, for logs: never the id itself. */
export const microsoftDriveLabel = (drive: string) => `drive:${createHash("sha256").update(drive).digest("hex").slice(0, 8)}`;
