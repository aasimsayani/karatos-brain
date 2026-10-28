import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import {
  HUBSPOT_ASSOCIATION_BATCH,
  HUBSPOT_ASSOCIATIONS,
  HUBSPOT_ID,
  HUBSPOT_OBJECTS,
  HUBSPOT_PROPERTIES,
  HUBSPOT_SEARCH_PAGE_SIZE,
  hubSpotClient,
  hubSpotModifiedProperty,
  type HubSpotClient,
  type HubSpotClientOptions,
  type HubSpotObject,
  type HubSpotSearchBody,
} from "./client.js";
import { hubSpotDeletionEvents, hubSpotModified, hubSpotPageEvents, hubSpotTime, type HubSpotLinks, type HubSpotRecord } from "./normalize.js";

/**
 * Reads companies, contacts, deals, tickets and engagements (calls, emails,
 * meetings, notes and tasks). Each object is read in two steps: its changes,
 * through CRM search by last-modified time, oldest first, then its archived
 * records, which search never returns, as deletions. The historical import
 * reads changes back five years; incremental syncs read from where the
 * previous pass started, less an overlap.
 *
 * Search answers at most 10,000 results per query, so the connector never
 * pages one query that far: after each full page it starts a new query from
 * the page's last modified time, skipping the records it has already read at
 * exactly that time. Only when a whole page shares one time does it page with
 * HubSpot's offset, which reaches the cap only if more than 10,000 records
 * were changed in the same millisecond.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the token itself can only read. */
export const HUBSPOT_WRITES: WriteAction[] = [
  { integration: "hubspot", name: "update_contact", description: "Update a contact's properties" },
  { integration: "hubspot", name: "update_deal", description: "Move a deal to another stage or change its amount" },
  { integration: "hubspot", name: "log_activity", description: "Log a call, note or meeting on a contact or deal" },
];

/** Objects in the order a pass reads them; companies and contacts first so deals, tickets and engagements point at known ones. */
export const HUBSPOT_SYNC_ORDER: readonly HubSpotObject[] = HUBSPOT_OBJECTS;
/**
 * Each incremental pass starts this long before the previous one did. Search
 * is fed from an index that can lag a change, so a record saved just before
 * a pass started may only show up in the next one.
 */
export const HUBSPOT_OVERLAP_MS = 10 * 60_000;

type Step = HubSpotObject | "done";

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface HubSpotCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** changes: search by last-modified time; archived: list deleted records. */
  phase: "changes" | "archived";
  /** ISO time the current search starts from (on or after). It moves forward page by page. */
  from: string;
  /** Ids already read whose last-modified time is exactly `from`, so the next query skips them. */
  seen: string[];
  /** HubSpot's paging token: search's offset when a page all shares `from`, or the archived list's cursor. */
  after: string | null;
  /** ISO time the pass started. Changes are read up to, not including, this time, so paging stays stable. */
  until: string;
  /** ISO time the pass reads from: changes start here, and records archived since are deletions. */
  since: string;
  /** ISO time the next incremental pass reads from. */
  nextFrom: string;
}

export interface HubSpotConnectorOptions extends HubSpotClientOptions {
  /** Years of history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: HubSpotClient;
}

const STEPS: Step[] = [...HUBSPOT_SYNC_ORDER, "done"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEARCH_AFTER = /^\d{1,5}$/;
const LIST_AFTER = /^[A-Za-z0-9+/=_-]{1,256}$/;
const isoTime = (t: unknown) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t)) && new Date(t).toISOString() === t;

export function parseHubSpotCursor(raw: string | null): HubSpotCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as HubSpotCursor;
  if (
    !c ||
    typeof c !== "object" ||
    Object.keys(c).sort().join() !== "after,from,nextFrom,pass,phase,seen,since,step,until" ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    (c.phase !== "changes" && c.phase !== "archived") ||
    ![c.from, c.until, c.since, c.nextFrom].every(isoTime) ||
    Date.parse(c.from) < Date.parse(c.since) ||
    Date.parse(c.from) > Date.parse(c.until) ||
    !Array.isArray(c.seen) ||
    c.seen.length > HUBSPOT_SEARCH_PAGE_SIZE ||
    !c.seen.every((s) => typeof s === "string" && HUBSPOT_ID.test(s)) ||
    !(c.after === null || (typeof c.after === "string" && (c.phase === "changes" ? SEARCH_AFTER : LIST_AFTER).test(c.after)))
  ) {
    throw new Error("HubSpot checkpoint is not in the expected shape");
  }
  return c;
}

/** The search for records changed on or after `from` and before `until`, oldest first. */
export function hubSpotSearchBody(object: HubSpotObject, range: { from: string; until: string; after?: string | null }): HubSpotSearchBody {
  const property = hubSpotModifiedProperty(object);
  return {
    filterGroups: [
      {
        filters: [
          { propertyName: property, operator: "GTE", value: String(Date.parse(range.from)) },
          { propertyName: property, operator: "LT", value: String(Date.parse(range.until)) },
        ],
      },
    ],
    sorts: [{ propertyName: property, direction: "ASCENDING" }],
    properties: [...HUBSPOT_PROPERTIES[object]],
    limit: HUBSPOT_SEARCH_PAGE_SIZE,
    ...(range.after ? { after: range.after } : {}),
  };
}

const recordsOf = (body: Record<string, unknown>) => (Array.isArray(body.results) ? (body.results as unknown[]).filter((r): r is HubSpotRecord => !!r && typeof r === "object") : []);
/** HubSpot's next-page token, when there is a next page. */
const nextOf = (body: Record<string, unknown>) => {
  const after = (body.paging as { next?: { after?: unknown } } | undefined)?.next?.after;
  return typeof after === "string" && after ? after : typeof after === "number" ? String(after) : null;
};

export function hubSpotConnector(options: HubSpotConnectorOptions): Connector {
  const client = options.client ?? hubSpotClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;

  const begin = (pass: HubSpotCursor["pass"], since: string): HubSpotCursor => ({
    pass,
    step: HUBSPOT_SYNC_ORDER[0]!,
    phase: "changes",
    from: since,
    seen: [],
    after: null,
    until: now().toISOString(),
    since,
    // The next incremental pass picks up anything changed, or indexed late, while this one ran.
    nextFrom: new Date(now().getTime() - HUBSPOT_OVERLAP_MS).toISOString(),
  });

  function startHistorical(): HubSpotCursor {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    return begin("historical", start.toISOString());
  }

  const startIncremental = (previous: HubSpotCursor | null) =>
    begin("incremental", previous?.nextFrom ?? new Date(now().getTime() - lookbackHours * 3_600_000).toISOString());

  /** The next object's first step, from the start of the pass. */
  const nextObject = (cursor: HubSpotCursor, object: HubSpotObject): HubSpotCursor => ({ ...cursor, step: STEPS[STEPS.indexOf(object) + 1]!, phase: "changes", from: cursor.since, seen: [], after: null });

  /** The contacts, companies and deals each record is associated with, read 100 ids at a time. */
  async function linksFor(object: HubSpotObject, records: HubSpotRecord[]): Promise<HubSpotLinks> {
    const links: HubSpotLinks = {};
    const ids = records.map((r) => r.id).filter((i): i is string => typeof i === "string" && HUBSPOT_ID.test(i));
    for (const to of HUBSPOT_ASSOCIATIONS[object] ?? []) {
      const found: Record<string, string[]> = {};
      for (let i = 0; i < ids.length; i += HUBSPOT_ASSOCIATION_BATCH) {
        const body = await client.associations(object, to, ids.slice(i, i + HUBSPOT_ASSOCIATION_BATCH));
        for (const result of Array.isArray(body.results) ? (body.results as { from?: { id?: unknown }; to?: { toObjectId?: unknown }[] }[]) : []) {
          const fromId = result?.from?.id;
          if ((typeof fromId !== "string" && typeof fromId !== "number") || !Array.isArray(result.to)) continue;
          found[String(fromId)] = result.to.map((t) => String(t?.toObjectId ?? "")).filter((t) => HUBSPOT_ID.test(t));
        }
      }
      links[to] = found;
    }
    return links;
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseHubSpotCursor(context.cursor);
    let cursor: HubSpotCursor;
    if (mode === "historical") {
      // A finished import stays finished (its step is done); an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved);
    }

    while (cursor.step !== "done") {
      const object = cursor.step;
      const receivedAt = now().toISOString();
      if (cursor.phase === "changes") {
        const body = await client.search(object, hubSpotSearchBody(object, cursor));
        const records = recordsOf(body);
        const seen = new Set(cursor.seen);
        const fresh = records.filter((r) => !(hubSpotModified(object, r) === cursor.from && seen.has(String(r.id))));
        const events = hubSpotPageEvents(object, fresh, fresh.length ? await linksFor(object, fresh) : {}, receivedAt);
        const next = nextOf(body);
        if (!next) {
          cursor = { ...cursor, phase: "archived", seen: [], after: null };
        } else {
          // A new query from the page's newest time keeps every query far below search's 10,000-result cap.
          const times = records.map((r) => hubSpotModified(object, r)).filter((t): t is string => !!t);
          const last = times.reduce<string | undefined>((a, t) => (!a || t > a ? t : a), undefined);
          cursor =
            last && last > cursor.from
              ? { ...cursor, from: last, seen: records.filter((r) => hubSpotModified(object, r) === last).map((r) => String(r.id)).filter((i) => HUBSPOT_ID.test(i)).slice(0, HUBSPOT_SEARCH_PAGE_SIZE), after: null }
              : { ...cursor, after: next };
        }
        yield { events, cursor: JSON.stringify(cursor) };
      } else {
        const body = await client.listArchived(object, cursor.after ? { after: cursor.after } : {});
        // Only what was archived since the pass's start counts; older deletions were recorded before.
        const since = Date.parse(cursor.since);
        const archived = recordsOf(body).filter((r) => {
          const at = hubSpotTime(r.archivedAt);
          return !at || Date.parse(at) >= since;
        });
        const events = hubSpotDeletionEvents(object, archived, receivedAt);
        const next = nextOf(body);
        cursor = next ? { ...cursor, after: next } : nextObject(cursor, object);
        yield { events, cursor: JSON.stringify(cursor) };
      }
    }
  }

  return {
    source: "hubspot",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: HUBSPOT_WRITES,
  };
}
