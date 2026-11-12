import type { InMemoryStore, IntegrationStatus } from "@karatos/core";
import type { SqlClient } from "@karatos/store-postgres";
import type { SkippedIntegration, SyncStatus } from "./sync.js";

/**
 * Support access: what someone debugging an instance may see without seeing
 * the client's business. Everything here is operational metadata (versions,
 * timings, setting names, counts). Payloads, entity ids, customer references,
 * amounts, names, recommendation text and signal values never reach it.
 */

/** Days of event counts the status covers when the caller doesn't say. */
export const SUPPORT_EVENT_DAYS = 14;
/** The most days of event counts one status covers. */
export const MAX_SUPPORT_EVENT_DAYS = 90;
/** The longest error message the status shows, after scrubbing. */
export const MAX_SUPPORT_ERROR_CHARS = 200;

export interface DeadLetterCount {
  /** Null when the input didn't name a source. */
  source: string | null;
  reason: string;
  count: number;
}

export interface EventDayCount {
  /** YYYY-MM-DD, UTC, by when the event was received. */
  day: string;
  source: string;
  type: string;
  count: number;
}

/** Read-only queries for the support status. Each returns names and counts only. */
export interface SupportDiagnostics {
  /** Names of the migrations applied to the database, in order. */
  appliedMigrations(): Promise<string[]>;
  deadLetterCounts(organizationId: string): Promise<DeadLetterCount[]>;
  /** Events received at or after `since`, counted by day, source and type. */
  eventCountsByDay(organizationId: string, since: Date): Promise<EventDayCount[]>;
}

/** The diagnostics queries against the instance's Postgres database. */
export function postgresDiagnostics(db: SqlClient): SupportDiagnostics {
  return {
    async appliedMigrations() {
      const { rows } = await db.query<{ name: string }>("select name from schema_migrations order by name");
      return rows.map((r) => r.name);
    },
    async deadLetterCounts(organizationId) {
      // A dead letter that couldn't name an organization still arrived at this one-client instance.
      const { rows } = await db.query<{ source: string | null; reason: string; count: string | number }>(
        `select source, reason, count(*) as count from dead_letter_events
          where organization_id = $1 or organization_id is null
          group by source, reason`,
        [organizationId],
      );
      return rows.map((r) => ({ source: r.source, reason: r.reason, count: Number(r.count) }));
    },
    async eventCountsByDay(organizationId, since) {
      const { rows } = await db.query<{ day: string; source: string; type: string; count: string | number }>(
        `select to_char(received_at at time zone 'UTC', 'YYYY-MM-DD') as day, source, type, count(*) as count from events
          where organization_id = $1 and received_at >= $2
          group by 1, 2, 3`,
        [organizationId, since.toISOString()],
      );
      return rows.map((r) => ({ day: r.day, source: r.source, type: r.type, count: Number(r.count) }));
    },
  };
}

/** The same queries over an in-process store, for tests and local runs. */
export function inMemoryDiagnostics(store: InMemoryStore, migrations: readonly string[] = []): SupportDiagnostics {
  const tally = <T>(items: T[], key: (item: T) => string) => {
    const counts = new Map<string, { item: T; count: number }>();
    for (const item of items) {
      const k = key(item);
      const entry = counts.get(k);
      if (entry) entry.count++;
      else counts.set(k, { item, count: 1 });
    }
    return [...counts.values()];
  };
  return {
    async appliedMigrations() {
      return [...migrations];
    },
    async deadLetterCounts(organizationId) {
      const mine = store.deadLetters.filter((d) => d.organizationId === undefined || d.organizationId === organizationId);
      return tally(mine, (d) => JSON.stringify([d.source ?? null, d.reason])).map(({ item, count }) => ({ source: item.source ?? null, reason: item.reason, count }));
    },
    async eventCountsByDay(organizationId, since) {
      const mine = store.events
        .filter((e) => e.organizationId === organizationId && Date.parse(e.receivedAt) >= since.getTime())
        .map((e) => ({ day: new Date(e.receivedAt).toISOString().slice(0, 10), source: e.source, type: e.type }));
      return tally(mine, (e) => JSON.stringify([e.day, e.source, e.type])).map(({ item, count }) => ({ ...item, count }));
    },
  };
}

/** Source names and reason classes the status shows as they are; anything else is grouped as "other". */
const LABEL = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/**
 * A source or type name fit to show. Sources come from callers and from
 * input that failed validation, so a free-text one is grouped as "other"
 * rather than shown.
 */
export function supportLabel(value: string | null | undefined): string {
  if (value === null || value === undefined) return "unknown";
  return LABEL.test(value) ? value : "other";
}

/**
 * Makes an error message fit to show someone who may not see the client's
 * data: email addresses, bearer tokens, URL paths and query strings,
 * secret-named values, other key-shaped runs and numbers of six or more
 * digits are replaced, control characters dropped, and the result capped at
 * `max` characters. Vendor text can still name something it doesn't mark as
 * sensitive, so the status shows only each connector's last error.
 */
export function scrubSupportText(text: string, max: number = MAX_SUPPORT_ERROR_CHARS): string {
  const scrubbed = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/g, "[email]")
    .replace(/\b(bearer|basic)\s+\S+/gi, "$1 [redacted]")
    // A URL keeps only its host: paths and query strings can carry ids, names and keys.
    .replace(/\b(https?:\/\/[^\s/?#]+)\S*/gi, "$1/[redacted]")
    .replace(/\b([a-z0-9_-]*(?:key|token|secret|password|passwd|pwd|signature|sig|authorization|auth|session|cookie))(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;]+)/gi, "$1$2[redacted]")
    .replace(/[A-Za-z0-9_+/=.-]{20,}/g, (run) => ((/[0-9]/.test(run) && /[A-Za-z]/.test(run)) || run.length >= 32 ? "[redacted]" : run))
    .replace(/\d[\d -]{4,}\d/g, (run) => (/^\d{4}-\d{2}-\d{2}$/.test(run) || run.replace(/\D/g, "").length < 6 ? run : "[number]"))
    .replace(/\s+/g, " ")
    .trim();
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed;
}

export interface SupportStatusOptions {
  instanceName: string;
  /** The image's package version. */
  version: string;
  startedAt: Date;
  retentionDays: number;
  /** Department ids the instance runs. */
  departments: readonly string[];
  /** ENABLED_INTEGRATIONS. */
  enabledIntegrations: readonly string[];
  /** Integrations listed but not syncing, with why: setting names only. */
  skipped?: readonly SkippedIntegration[];
  /** The last run of each syncing connector. */
  syncStatus?: () => readonly SyncStatus[];
  diagnostics: SupportDiagnostics;
  now?: () => Date;
}

export interface SupportLastSync {
  mode: SyncStatus["mode"];
  outcome: SyncStatus["outcome"];
  startedAt: string;
  finishedAt: string;
  ingested: number | null;
  duplicates: number | null;
  deadLettered: number | null;
  batches: number | null;
  error: string | null;
}

export interface SupportIntegrationStatus {
  id: string;
  configured: boolean;
  missingSettings: string[];
  syncing: boolean;
  /** Why it isn't syncing, naming settings but never their values. Null when it is. */
  notSyncingReason: string | null;
  /** Null until it has run since the instance started. */
  lastSync: SupportLastSync | null;
}

export interface SupportStatus {
  instance: { name: string; organizationId: string; version: string; startedAt: string; uptimeSeconds: number };
  migrations: { count: number; applied: string[] };
  retention: { rawRetentionDays: number };
  departments: string[];
  integrations: SupportIntegrationStatus[];
  deadLetters: { total: number; bySource: Record<string, number>; byReason: Record<string, number> };
  events: { days: number; since: string; total: number; byDay: EventDayCount[] };
}

const DAY_MS = 86_400_000;

function add(into: Record<string, number>, key: string, count: number): void {
  into[key] = (into[key] ?? 0) + count;
}

/** Builds the support status: operational metadata and counts, never business data. */
export async function supportStatus(
  organizationId: string,
  options: SupportStatusOptions,
  integrations: readonly IntegrationStatus[],
  days: number = SUPPORT_EVENT_DAYS,
): Promise<SupportStatus> {
  const now = (options.now ?? (() => new Date()))();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = new Date(todayStart - (days - 1) * DAY_MS);
  const [migrations, deadLetters, events] = await Promise.all([
    options.diagnostics.appliedMigrations(),
    options.diagnostics.deadLetterCounts(organizationId),
    options.diagnostics.eventCountsByDay(organizationId, since),
  ]);

  const bySource: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  for (const d of deadLetters) {
    add(bySource, supportLabel(d.source), d.count);
    add(byReason, supportLabel(d.reason), d.count);
  }

  const grouped = new Map<string, EventDayCount>();
  for (const e of events) {
    const row = { day: e.day, source: supportLabel(e.source), type: supportLabel(e.type), count: e.count };
    const key = JSON.stringify([row.day, row.source, row.type]);
    const seen = grouped.get(key);
    if (seen) seen.count += row.count;
    else grouped.set(key, row);
  }
  const byDay = [...grouped.values()].sort((a, b) => a.day.localeCompare(b.day) || a.source.localeCompare(b.source) || a.type.localeCompare(b.type));

  const runs = new Map((options.syncStatus?.() ?? []).map((s) => [s.id, s]));
  const skipped = new Map((options.skipped ?? []).map((s) => [s.id, s.reason]));
  const catalog = new Map(integrations.map((i) => [i.id, i]));

  return {
    instance: {
      name: options.instanceName,
      organizationId,
      version: options.version,
      startedAt: options.startedAt.toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((now.getTime() - options.startedAt.getTime()) / 1000)),
    },
    migrations: { count: migrations.length, applied: migrations },
    retention: { rawRetentionDays: options.retentionDays },
    departments: [...options.departments],
    integrations: [...new Set(options.enabledIntegrations)].map((id) => {
      const run = runs.get(id);
      const reason = skipped.get(id);
      return {
        id,
        configured: catalog.get(id)?.configured ?? false,
        missingSettings: [...(catalog.get(id)?.missingSettings ?? [])],
        syncing: reason === undefined,
        notSyncingReason: reason ?? null,
        lastSync: run
          ? {
              mode: run.mode,
              outcome: run.outcome,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
              ingested: run.report?.ingested ?? null,
              duplicates: run.report?.duplicates ?? null,
              deadLettered: run.report?.deadLettered ?? null,
              batches: run.report?.batches ?? null,
              error: run.error === undefined ? null : scrubSupportText(run.error),
            }
          : null,
      };
    }),
    deadLetters: { total: deadLetters.reduce((n, d) => n + d.count, 0), bySource, byReason },
    events: { days, since: since.toISOString(), total: byDay.reduce((n, e) => n + e.count, 0), byDay },
  };
}
