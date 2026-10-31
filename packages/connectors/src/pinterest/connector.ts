import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { PINTEREST_ANALYTICS_DAYS, pinterestClient, pinterestDayMs, type PinterestClient, type PinterestClientOptions, type PinterestRange } from "./client.js";
import { pinterestAccountEvents, pinterestPinEvent, pinterestPinPage, pinterestTopPinEvents, type PinterestBrainEvent, type PinterestContext } from "./normalize.js";

/**
 * Reads the account's Pins, then its metrics by day, then its most saved
 * Pins over the last 30 days. Pinterest's analytics reach back 90 days, so
 * the historical import reads all 90; each incremental pass reads the last
 * PINTEREST_REVISIT_DAYS again, since Pinterest keeps refining recent days.
 *
 * The Pin list has no change time, so every pass reads every Pin, and only
 * a Pin whose title, link or metrics changed is stored again.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the connection holds read scopes only. */
export const PINTEREST_WRITES: WriteAction[] = [
  { integration: "pinterest", name: "create_pin", description: "Create a Pin for a product, with its photo and a link to its page", kind: "append", approval: "each", dailyCap: 10 },
];

/** Each incremental pass reads the account's metrics for this many days, today included. */
export const PINTEREST_REVISIT_DAYS = 30;
/** The top Pins report ranks the account's Pins over this many days, today included. */
export const PINTEREST_TOP_PIN_DAYS = 30;

export const PINTEREST_STEPS = ["pins", "account", "top_pins", "done"] as const;
type Step = (typeof PINTEREST_STEPS)[number];

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface PinterestCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** The Pin list's bookmark for the next page, or null for the first. */
  bookmark: string | null;
  /** The pass's last day, YYYY-MM-DD in UTC, fixed when it starts. */
  today: string;
}

export interface PinterestConnectorOptions extends PinterestClientOptions {
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: PinterestClient;
}

const DAY_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function parsePinterestCursor(raw: string | null): PinterestCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as PinterestCursor;
  if (
    !c ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !PINTEREST_STEPS.includes(c.step) ||
    (c.bookmark !== null && typeof c.bookmark !== "string") ||
    // A bookmark belongs to the Pin list only.
    (c.bookmark !== null && c.step !== "pins") ||
    Number.isNaN(pinterestDayMs(c.today))
  ) {
    throw new Error("Pinterest checkpoint is not in the expected shape");
  }
  return c;
}

/** The days ending on `today`, `days` long. */
function lastDays(today: string, days: number): PinterestRange {
  return { startDate: day(pinterestDayMs(today) - (days - 1) * DAY_MS), endDate: today };
}

export function pinterestConnector(options: PinterestConnectorOptions): Connector {
  const client = options.client ?? pinterestClient(options);
  const now = options.now ?? (() => new Date());

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parsePinterestCursor(context.cursor);
    const fresh = (pass: PinterestCursor["pass"]): PinterestCursor => ({ pass, step: "pins", bookmark: null, today: day(now().getTime()) });
    let cursor: PinterestCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : fresh("historical");
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : fresh("incremental");
    }

    while (cursor.step !== "done") {
      const ctx: PinterestContext = { receivedAt: now().toISOString() };
      let events: PinterestBrainEvent[];
      if (cursor.step === "pins") {
        const page = pinterestPinPage(await client.pins(cursor.bookmark));
        events = page.pins.flatMap((pin) => pinterestPinEvent(pin, ctx) ?? []);
        cursor = page.bookmark ? { ...cursor, bookmark: page.bookmark } : { ...cursor, step: "account", bookmark: null };
      } else if (cursor.step === "account") {
        const days = cursor.pass === "historical" ? PINTEREST_ANALYTICS_DAYS : PINTEREST_REVISIT_DAYS;
        events = pinterestAccountEvents(await client.accountAnalytics(lastDays(cursor.today, days)), ctx);
        cursor = { ...cursor, step: "top_pins" };
      } else {
        const range = lastDays(cursor.today, PINTEREST_TOP_PIN_DAYS);
        events = pinterestTopPinEvents(await client.topPins(range), range, ctx);
        cursor = { ...cursor, step: "done" };
      }
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "pinterest",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: PINTEREST_WRITES,
  };
}
