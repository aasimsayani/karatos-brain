import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { GBP_ID, gbpClient, gbpDayMs, type GbpClient, type GbpClientOptions } from "./client.js";
import { gbpLocationEvent, gbpMetricsEvents, gbpReviewEvent, type GbpEvent } from "./normalize.js";

/**
 * Google Business Profile: a store's locations, their Google reviews and
 * their daily views, calls, direction requests and website clicks.
 *
 * Each sync reads the account's locations first, as one batch. Then, for
 * each location, its reviews newest change first, as one batch, down to
 * where the sync starts; then its daily metrics a month-long window at a
 * time, each window a batch.
 *
 * - The historical import reads reviews and metrics from two years back.
 * - Each later sync reads a location's reviews changed since the newest
 *   change the last one saw, less a day, and metrics again from a week
 *   before the last day read, since Google keeps filling in recent days.
 *   The first later sync looks back three days for reviews and ten for
 *   metrics. A row read again unchanged is a duplicate.
 *
 * The checkpoint keeps the stage, the locations, the one being read, the
 * window's start, and the newest review change seen at each location.
 */

/** Declared so it can be gated and audited; it never runs while writes are off, and the client has no way to send it. */
export const GBP_WRITES: WriteAction[] = [{ integration: "google_business_profile", name: "reply_to_review", description: "Reply to a Google review", kind: "append", approval: "each", dailyCap: 20 }];

const DAY_MS = 86_400_000;
/** Longest window of days one metrics request covers. */
export const GBP_WINDOW_DAYS = 31;
/** Later syncs read reviews from this long before the newest change seen. */
export const GBP_REVIEW_OVERLAP_MS = DAY_MS;
/** A first later sync reads reviews this far back. */
export const GBP_FIRST_REVIEW_LOOKBACK_MS = 3 * DAY_MS;
/** Later syncs read metrics again from this many days before the last day read. */
export const GBP_REVISIT_DAYS = 7;
/** A first later sync reads metrics this many days back. */
export const GBP_FIRST_METRICS_DAYS = 10;

type Stage = "locations" | "reviews" | "metrics";
const STAGES: readonly Stage[] = ["locations", "reviews", "metrics"];

/** Where a sync stands. */
export interface GbpPass {
  stage: Stage;
  /** The account's locations, as read at the start of the sync. */
  locations: string[];
  /** The location being read. */
  index: number;
  /** Reviews older than this are left, for a location with no mark. */
  floor: string;
  /** The metrics days read, both inclusive; from after to means none. */
  from: string;
  to: string;
  /** The first day of the metrics window being read. */
  window: string;
}

/** Serialized as the runSync checkpoint. */
export interface GbpCursor {
  /** The historical import finished. */
  done: boolean;
  /** The newest review change seen at each location. */
  marks: [string, string][];
  /** The last metrics day a finished sync read. */
  through: string | null;
  pass: GbpPass | null;
}

export interface GbpOptions extends GbpClientOptions {
  /** How far back the historical import reads. Defaults to 2. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: GbpClient;
}

const MESSAGE = "Google Business Profile checkpoint is not in the expected shape";
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isDay = (v: unknown): v is string => !Number.isNaN(gbpDayMs(v));
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;

export function parseGbpCursor(raw: string | null): GbpCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new Error(MESSAGE);
  }
  const r = (c ?? {}) as Record<string, unknown>;
  const marks = r.marks;
  const marksOk = Array.isArray(marks) && marks.every((m) => Array.isArray(m) && m.length === 2 && GBP_ID.test(String(m[0])) && typeof m[0] === "string" && isTime(m[1]));
  const p = (r.pass ?? {}) as Record<string, unknown>;
  const locations = p.locations;
  const passOk =
    r.pass === null ||
    (STAGES.includes(p.stage as Stage) &&
      Array.isArray(locations) &&
      locations.every((l) => typeof l === "string" && GBP_ID.test(l)) &&
      Number.isSafeInteger(p.index) &&
      (p.index as number) >= 0 &&
      (p.index as number) < locations.length + (p.stage === "reviews" ? 0 : 1) &&
      isTime(p.floor) &&
      isDay(p.from) &&
      isDay(p.to) &&
      isDay(p.window));
  if (typeof r.done !== "boolean" || !marksOk || !(r.through === null || isDay(r.through)) || !passOk) throw new Error(MESSAGE);
  return { done: r.done, marks: marks as [string, string][], through: r.through as string | null, pass: r.pass === null ? null : (p as unknown as GbpPass) };
}

export function gbpConnector(options: GbpOptions): Connector {
  const client = options.client ?? gbpClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 2;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Once every location's reviews are read, the metrics come next. */
  const toMetricsWhenDone = (pass: GbpPass): GbpPass => (pass.index < pass.locations.length ? pass : { ...pass, stage: "metrics", index: 0, window: pass.from });

  async function* read(state: GbpCursor, start: () => GbpPass, doneAtEnd: boolean): AsyncIterable<SourceBatch> {
    const marks = new Map(state.marks);
    let pass = state.pass ?? start();
    for (;;) {
      const receivedAt = now().toISOString();
      const events: GbpEvent[] = [];
      if (pass.stage === "locations") {
        const locations: string[] = [];
        let token: string | null = null;
        do {
          const page = await client.locations(token);
          for (const row of Array.isArray(page.locations) ? page.locations : []) {
            const { ok, event } = gbpLocationEvent(row, { receivedAt });
            events.push(event);
            if (ok) locations.push(String(event.payload.locationId).slice("gbp:location:".length));
          }
          token = typeof page.nextPageToken === "string" && page.nextPageToken !== "" ? page.nextPageToken : null;
        } while (token !== null);
        pass = toMetricsWhenDone({ ...pass, stage: "reviews", locations: [...new Set(locations)], index: 0 });
      } else if (pass.stage === "reviews") {
        const location = pass.locations[pass.index]!;
        const seen = marks.get(location);
        const since = seen ? new Date(Date.parse(seen) - GBP_REVIEW_OVERLAP_MS).toISOString() : pass.floor;
        let top = seen;
        let token: string | null = null;
        do {
          const page = await client.reviews(location, token);
          const rows = Array.isArray(page.reviews) ? page.reviews : [];
          let older = false;
          for (const row of rows) {
            const { ok, event } = gbpReviewEvent(row, { receivedAt, locationId: location });
            // A review that doesn't read has neither time, and compares as neither older nor newer.
            const changed = (event.payload.editedAt ?? event.payload.publishedAt) as string;
            // Newest change first, so the first older than the start ends the location.
            if (changed < since) {
              older = true;
              break;
            }
            events.push(event);
            if (changed > (top ?? "")) top = changed;
          }
          token = !older && typeof page.nextPageToken === "string" && page.nextPageToken !== "" ? page.nextPageToken : null;
        } while (token !== null);
        if (top) marks.set(location, top);
        pass = toMetricsWhenDone({ ...pass, index: pass.index + 1 });
      } else if (pass.index < pass.locations.length && gbpDayMs(pass.window) <= gbpDayMs(pass.to)) {
        const end = day(Math.min(gbpDayMs(pass.window) + (GBP_WINDOW_DAYS - 1) * DAY_MS, gbpDayMs(pass.to)));
        const location = pass.locations[pass.index]!;
        const answer = await client.metrics(location, pass.window, end);
        events.push(...gbpMetricsEvents(answer, { receivedAt, locationId: location, from: pass.window, to: end }).map((r) => r.event));
        const next = day(gbpDayMs(end) + DAY_MS);
        pass = gbpDayMs(next) <= gbpDayMs(pass.to) ? { ...pass, window: next } : { ...pass, index: pass.index + 1, window: pass.from };
      } else {
        const cursor: GbpCursor = { done: doneAtEnd, marks: [...marks], through: gbpDayMs(pass.from) <= gbpDayMs(pass.to) ? pass.to : state.through, pass: null };
        yield { events: [], cursor: JSON.stringify(cursor) };
        return;
      }
      const cursor: GbpCursor = { done: state.done, marks: [...marks], through: state.through, pass };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  const fresh = (): GbpCursor => ({ done: false, marks: [], through: null, pass: null });
  const yesterday = () => day(Date.parse(now().toISOString().slice(0, 10)) - DAY_MS);
  const pass = (floor: string, from: string): GbpPass => ({ stage: "locations", locations: [], index: 0, floor, from, to: yesterday(), window: from });

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseGbpCursor(context.cursor);
    if (saved?.done) return;
    yield* read(
      saved ?? fresh(),
      () => {
        const floor = now();
        floor.setUTCFullYear(floor.getUTCFullYear() - historyYears);
        return pass(floor.toISOString(), floor.toISOString().slice(0, 10));
      },
      true,
    );
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const state = parseGbpCursor(context.cursor) ?? fresh();
    yield* read(
      state,
      () => {
        const today = Date.parse(now().toISOString().slice(0, 10));
        const from = state.through ? gbpDayMs(state.through) - (GBP_REVISIT_DAYS - 1) * DAY_MS : today - GBP_FIRST_METRICS_DAYS * DAY_MS;
        return pass(new Date(now().getTime() - GBP_FIRST_REVIEW_LOOKBACK_MS).toISOString(), day(from));
      },
      state.done,
    );
  }

  return { source: "google_business_profile", historicalImport, incrementalSync, writes: GBP_WRITES };
}
