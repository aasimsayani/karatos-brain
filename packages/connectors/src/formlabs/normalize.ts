import { createHash } from "node:crypto";

/**
 * Turns Formlabs print runs into Brain A events, so a workshop can see what
 * its printers made for casting and models: when, in what resin, how much,
 * and whether it worked.
 *
 * A print run becomes `manufacturing.print_updated`, with its printer, its
 * status and whether it succeeded, the resin and how much it used, its
 * layers, and when it was made, started and finished. Each is keyed by its
 * run and a digest of what was kept, so reading one again unchanged is a
 * duplicate and a run that finishes is a new version.
 *
 * A print's name is not kept, since a workshop often names a job after its
 * customer, and neither are the user who sent it, notes, messages, part
 * names, thumbnails or photo links. A run without an ID or a time that
 * reads is dead-lettered listing what was wrong.
 */

export interface FormlabsEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const FORMLABS_EVENTS = { print: "manufacturing.print_updated" } as const;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Date.parse turns down minute or second 60; hour 24 it reads as the next day, so it is ruled out here.
const TIME = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):\d{2}:\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const STATUSES = new Set(["QUEUED", "PREPRINT", "PRINTING", "PAUSED", "PAUSING", "FINISHED", "ABORTING", "ABORTED", "ERROR", "WAITING_FOR_RESOLUTION", "PREHEAT", "PRECOAT", "POSTCOAT"]);
const SUCCESS = new Set(["UNKNOWN", "SUCCESS", "FAILURE"]);

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
// Anything but an object reads as a record without the fields asked for.
const record = (v: unknown) => (v ?? {}) as Record<string, unknown>;
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);
/** A word from Formlabs' list, lowercased, or "unknown" for one it doesn't list, or null. */
const word = (list: Set<string>, v: unknown): string | null => (typeof v === "string" ? (list.has(v) ? v.toLowerCase() : "unknown") : null);
/** A count or duration: a whole number, 0 or more. */
const count = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);
/** A measure: a finite number, 0 or more. */
const measure = (v: unknown): number | null => (Number.isFinite(v) && (v as number) >= 0 ? (v as number) : null);

export const formlabsRef = (kind: string, id: string) => `formlabs:${kind}:${id}`;

/** A Formlabs time as a UTC ISO time, or undefined. Formlabs writes every time with its zone. */
export function formlabsTime(v: unknown): string | undefined {
  const m = typeof v === "string" ? TIME.exec(v) : null;
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ""}${m[4]}`);
  // Date.parse rolls a day like 02-30 into the next month, so the day must read back as itself.
  if (Number.isNaN(t) || new Date(Date.parse(`${m[1]}T00:00:00Z`)).toISOString().slice(0, 10) !== m[1]) return undefined;
  return new Date(t).toISOString();
}

export interface FormlabsContext {
  receivedAt: string;
}

/** The event for one print run. */
export function formlabsPrintEvent(raw: unknown, ctx: FormlabsContext): FormlabsEvent {
  const r = record(raw);
  const problems: string[] = [];
  const id = typeof r.guid === "string" && GUID.test(r.guid) ? r.guid.toLowerCase() : undefined;
  if (id === undefined) problems.push("print run has no ID that reads");
  const at = formlabsTime(r.created_at);
  if (!at) problems.push("print run has no time that reads");
  const ok = problems.length === 0;
  const printRunId = id === undefined ? null : formlabsRef("print", id);
  const printer = text(r.printer, 60);
  const payload: Record<string, unknown> = ok
    ? {
        system: "Formlabs",
        printRunId,
        printerId: printer === null ? null : formlabsRef("printer", printer),
        printerGroup: text(record(r.group).name, 40),
        status: word(STATUSES, r.status),
        success: word(SUCCESS, record(r.print_run_success).print_run_success),
        material: text(r.material, 40),
        materialName: text(r.material_name, 60),
        volumeMl: measure(r.volume_ml),
        layerCount: count(r.layer_count),
        layerThicknessMm: measure(r.layer_thickness_mm),
        partCount: Array.isArray(r.parts) ? r.parts.length : null,
        estimatedDurationMs: count(r.estimated_duration_ms),
        elapsedDurationMs: count(r.elapsed_duration_ms),
        createdAt: at,
        startedAt: formlabsTime(r.print_started_at) ?? null,
        finishedAt: formlabsTime(r.print_finished_at) ?? null,
      }
    : { system: "Formlabs", printRunId, problems };
  const key = ok ? `formlabs:print:${id}:${short(payload)}` : `formlabs:unreadable_print:${short(raw)}`;
  return { id: key.replace(/:/g, "_"), type: FORMLABS_EVENTS.print, occurredAt: at, receivedAt: ctx.receivedAt, idempotencyKey: key, payload };
}
