import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { yextClient, yextDayMs, type YextClient, type YextClientOptions } from "./client.js";
import { yextLocationEvent, yextPage, yextReviewEvent, type YextBrainEvent, type YextContext } from "./normalize.js";

/**
 * Reads the account's locations, then the reviews Yext last updated in a
 * range of days: the last two years on the historical import, and on each
 * incremental pass the days since the last pass ended, less
 * YEXT_OVERLAP_DAYS, so a review updated late on a day a pass already read
 * is read again. Unchanged reviews are duplicates.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client sends only GETs. */
export const YEXT_WRITES: WriteAction[] = [
  { integration: "yext", name: "reply_to_review", description: "Post the store's public reply to a review", kind: "append", approval: "each", dailyCap: 20 },
  { integration: "yext", name: "update_hours", description: "Change a location's opening hours on every listing Yext manages", kind: "update", approval: "each", dailyCap: 5 },
];

/** The historical import reads reviews last updated in this many days. */
export const YEXT_HISTORY_DAYS = 731;
/** An incremental pass with no earlier pass to follow reads this many days. */
export const YEXT_FIRST_PASS_DAYS = 7;
/** Each incremental pass starts this many days before the last pass ended. */
export const YEXT_OVERLAP_DAYS = 2;

export const YEXT_STEPS = ["locations", "reviews", "done"] as const;
type Step = (typeof YEXT_STEPS)[number];

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface YextCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** The list's page token for the next page, or null for the first. */
  pageToken: string | null;
  /** The reviews' range, YYYY-MM-DD in UTC, fixed when the pass starts. */
  from: string;
  until: string;
}

export interface YextConnectorOptions extends YextClientOptions {
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: YextClient;
}

const DAY_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function parseYextCursor(raw: string | null): YextCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as YextCursor;
  if (
    !c ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !YEXT_STEPS.includes(c.step) ||
    (c.pageToken !== null && typeof c.pageToken !== "string") ||
    (c.pageToken !== null && c.step === "done") ||
    Number.isNaN(yextDayMs(c.from)) ||
    Number.isNaN(yextDayMs(c.until)) ||
    c.from > c.until
  ) {
    throw new Error("Yext checkpoint is not in the expected shape");
  }
  return c;
}

export function yextConnector(options: YextConnectorOptions): Connector {
  const client = options.client ?? yextClient(options);
  const now = options.now ?? (() => new Date());

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseYextCursor(context.cursor);
    const today = day(now().getTime());
    let cursor: YextCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : { pass: "historical", step: "locations", pageToken: null, from: day(now().getTime() - YEXT_HISTORY_DAYS * DAY_MS), until: today };
    } else if (saved && saved.step !== "done" && saved.pass === "incremental") {
      cursor = saved;
    } else {
      // Follow on from the last finished pass, whichever kind it was.
      const after = saved?.step === "done" ? yextDayMs(saved.until) - YEXT_OVERLAP_DAYS * DAY_MS : now().getTime() - (YEXT_FIRST_PASS_DAYS - 1) * DAY_MS;
      const from = day(Math.max(Math.min(after, yextDayMs(today)), now().getTime() - YEXT_HISTORY_DAYS * DAY_MS));
      cursor = { pass: "incremental", step: "locations", pageToken: null, from, until: today };
    }

    while (cursor.step !== "done") {
      const ctx: YextContext = { receivedAt: now().toISOString() };
      let events: YextBrainEvent[];
      let next: string | undefined;
      if (cursor.step === "locations") {
        const page = yextPage(await client.locations(cursor.pageToken), "entities");
        events = page.items.flatMap((e) => yextLocationEvent(e, ctx) ?? []);
        next = page.pageToken;
      } else {
        const page = yextPage(await client.reviews({ from: cursor.from, until: cursor.until }, cursor.pageToken), "reviews");
        events = page.items.flatMap((r) => yextReviewEvent(r, ctx) ?? []);
        next = page.pageToken;
      }
      const following: Step = cursor.step === "locations" ? "reviews" : "done";
      cursor = next ? { ...cursor, pageToken: next } : { ...cursor, step: following, pageToken: null };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "yext",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: YEXT_WRITES,
  };
}
