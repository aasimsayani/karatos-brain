import type { MemoryStore, VerifySource, VerifySubject } from "@karatos/core";
import {
  compareRecords,
  sourceFor,
  syncedRecords,
  systemStatus,
  unavailableMetrics,
  VERIFY_EVENT_TYPES,
  VERIFY_MAX_SYNCED_EVENTS,
  type VerifyPeriodReport,
  type VerifyStatus,
  type VerifySystemReport,
} from "@karatos/retail";
import type { ScheduledConnector, SkippedIntegration } from "./sync.js";

/**
 * Sync verification on a running instance: for each system asked about, the
 * connector reads the source system's own totals for the period (read-only,
 * with the scopes it already syncs with), the store is read for what has
 * synced, and the two are compared. One run at a time. Nothing here writes
 * to a vendor or goes near the WriteGate. See docs/verify-sync.md.
 */

/** The systems sync verification can check, and what it checks for each. */
export const VERIFIABLE_SYSTEMS: Readonly<Record<string, readonly VerifySubject[]>> = {
  shopify: ["sales"],
  square: ["sales"],
  stripe: ["charges"],
  klaviyo: ["profiles"],
};

export interface VerifyReport {
  generatedAt: string;
  period: VerifyPeriodReport;
  /** Counts of systems by status. */
  summary: Record<VerifyStatus, number>;
  systems: VerifySystemReport[];
}

export interface VerifierOptions {
  memory: MemoryStore;
  organizationId: string;
  /** The connectors the instance syncs, as the sync runner has them. */
  connectors: readonly ScheduledConnector[];
  /** Connectors turned on but not syncing, with why. */
  skipped: readonly SkippedIntegration[];
  now?: () => Date;
}

/** A verification is already running; the caller should try again once it ends. */
export class VerifyBusyError extends Error {
  constructor() {
    super("a sync verification is already running; try again once it finishes");
    this.name = "VerifyBusyError";
  }
}

/**
 * What a failure may say: the error's class, and its HTTP status when it has
 * one. Never its message, which can quote what the vendor sent back.
 * KaratOS's own limit errors are the exception, since they quote nothing.
 */
export function describeVerifyError(error: unknown): string {
  if (!(error instanceof Error)) return "the source system couldn't be read";
  if (error.name === "VerifyLimitError") return error.message.slice(0, 200);
  const status = (error as { status?: unknown }).status;
  return `the source system couldn't be read (${error.name.slice(0, 60)}${typeof status === "number" ? `, HTTP ${status}` : ""})`;
}

/** What one run checks beyond its period. */
export interface VerifyRunOptions {
  /** One system; every system in VERIFIABLE_SYSTEMS when absent. */
  system?: string;
  /** The largest money difference, in cents, that still matches. 0 when absent. */
  toleranceCents?: number;
}

export function createVerifier(options: VerifierOptions) {
  const now = options.now ?? (() => new Date());
  let running = false;

  /** Which systems a run covers: the one asked for, or every system verification knows. */
  function systemsFor(system: string | undefined): string[] {
    return system === undefined ? Object.keys(VERIFIABLE_SYSTEMS) : [system];
  }

  function notSyncing(system: string): string | null {
    if (options.connectors.some((c) => c.id === system)) return null;
    const skipped = options.skipped.find((s) => s.id === system);
    return skipped ? `${system} is turned on but not syncing (${skipped.reason})` : `${system} isn't turned on for this instance`;
  }

  async function verifySystem(system: string, period: VerifyPeriodReport, toleranceCents: number | undefined): Promise<VerifySystemReport> {
    const subjects = Object.hasOwn(VERIFIABLE_SYSTEMS, system) ? VERIFIABLE_SYSTEMS[system]! : [];
    const unavailable = (reason: string): VerifySystemReport => ({ system, status: "unavailable", period, metrics: unavailableMetrics(subjects, reason), reason });
    if (!subjects.length) return unavailable(`KaratOS can't verify ${system} yet`);
    const off = notSyncing(system);
    if (off) return unavailable(off);

    let sources: VerifySource[];
    try {
      const connector = await options.connectors.find((c) => c.id === system)!.make();
      if (!connector.verify) return unavailable(`the ${system} connector has no verify support`);
      sources = await connector.verify({ from: period.from, to: period.to });
    } catch (error) {
      return unavailable(describeVerifyError(error));
    }

    const metrics = [];
    const basis = { source: [] as string[], synced: [] as string[] };
    let uncountedEvents = 0;
    for (const subject of subjects) {
      const source = sourceFor(sources, subject);
      if (!source) {
        metrics.push(...unavailableMetrics([subject], `the ${system} connector didn't report ${subject}`));
        continue;
      }
      // Profiles are dated by creation but stored by update, so every profile event from the period's start on is read.
      const to = subject === "profiles" ? new Date(Math.max(now().getTime(), Date.parse(period.to)) + 1000).toISOString() : period.to;
      const events = await options.memory.eventsBetween(options.organizationId, VERIFY_EVENT_TYPES[subject], period.from, to, VERIFY_MAX_SYNCED_EVENTS + 1);
      if (events.length > VERIFY_MAX_SYNCED_EVENTS) {
        metrics.push(...unavailableMetrics([subject], `more than ${VERIFY_MAX_SYNCED_EVENTS} synced events in the period; verify a shorter period`));
        continue;
      }
      const synced = syncedRecords(subject, system, events, period);
      metrics.push(...compareRecords({ subject, source: source.records, synced: synced.records, ...(toleranceCents !== undefined ? { toleranceCents } : {}) }));
      basis.source.push(source.basis);
      basis.synced.push(synced.basis);
      uncountedEvents += synced.uncounted;
    }
    return {
      system,
      status: systemStatus(metrics),
      period,
      metrics,
      ...(basis.source.length ? { basis: { source: basis.source.join("; "), synced: basis.synced.join("; ") } } : {}),
      ...(uncountedEvents ? { uncountedEvents } : {}),
    };
  }

  return {
    /** True while a run is in progress. */
    running: () => running,
    /** One verification. A second call while one runs is turned down with VerifyBusyError, never queued. */
    async run(period: VerifyPeriodReport, run: VerifyRunOptions = {}): Promise<VerifyReport> {
      if (running) throw new VerifyBusyError();
      running = true;
      try {
        const systems: VerifySystemReport[] = [];
        // One system at a time, so a run never puts more than one connector's load on the vendors.
        for (const id of systemsFor(run.system)) systems.push(await verifySystem(id, period, run.toleranceCents));
        const summary: Record<VerifyStatus, number> = { match: 0, mismatch: 0, unavailable: 0 };
        for (const s of systems) summary[s.status]++;
        return { generatedAt: now().toISOString(), period, summary, systems };
      } finally {
        running = false;
      }
    },
  };
}

export type Verifier = ReturnType<typeof createVerifier>;
