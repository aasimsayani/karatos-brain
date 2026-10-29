import { createHash } from "node:crypto";
import type { ColumnGetter } from "../files/columns.js";
import type { CsvRow } from "../files/csv.js";
import type { SourceFile } from "../files/source.js";
import { parseDate, parseInteger, parseWeightGrams, type WeightUnit } from "../files/values.js";
import type { JobStatus, PiroProfile } from "./profile.js";

/**
 * Turns PIRO job and casting tree report rows into manufacturing events.
 * A job becomes `manufacturing.job_updated` each time its status, stage,
 * dates or weights change, keyed by its job number and a hash of what the
 * row says, so a report exported every day stores only the changes. A
 * casting tree becomes `manufacturing.casting_recorded` with the metal
 * issued, the metal returned and the loss between them, which is where a
 * casting shop's gold goes missing. Customer names are never read: a job
 * keeps only its order number. A row that can't be read becomes an event
 * with no time and the problems it has, which the pipeline dead-letters
 * with the row kept.
 */

export const JOB_EVENT_TYPE = "manufacturing.job_updated";
export const CASTING_EVENT_TYPE = "manufacturing.casting_recorded";

export type PiroMetal = "gold" | "silver" | "platinum" | "palladium";

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface PiroEvent {
  id: string;
  type: typeof JOB_EVENT_TYPE | typeof CASTING_EVENT_TYPE;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface PiroRowContext {
  file: SourceFile;
  profile: PiroProfile;
  receivedAt: string;
  /** Rows dated before this ISO time are skipped. */
  since: string;
}

/** Job columns every job report needs. */
export const JOB_REQUIRED = ["jobId", "status"];
/** Casting columns every casting report needs. */
export const CASTING_REQUIRED = ["treeId", "castDate", "metal"];

const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

const hash12 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

const STATUS_RULES: [RegExp, JobStatus][] = [
  [/\b(?:cancel+ed|void(?:ed)?|scrapped)\b/, "cancelled"],
  [/\b(?:on hold|hold|paused|waiting)\b/, "on_hold"],
  [/\b(?:complete[d]?|finished|done|closed|shipped|delivered|invoiced)\b/, "completed"],
  [/\bnot started\b/, "open"],
  [/\b(?:in progress|wip|started|casting|setting|polishing|finishing|at bench|bench|filing|assembly|qc|quality check)\b/, "in_progress"],
  [/\b(?:open|new|pending|not started|issued|released)\b/, "open"],
];

/** A status label to a status: the profile's own labels first, then the built-in words. */
export function jobStatus(label: string, profile: PiroProfile): JobStatus {
  const t = label.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (Object.hasOwn(profile.statuses, t)) return profile.statuses[t]!;
  return STATUS_RULES.find(([pattern]) => pattern.test(t))?.[1] ?? "other";
}

const METAL_NAMES: [RegExp, PiroMetal][] = [
  [/\b(?:gold|au|yg|wg|rg)\b|\d{1,2}\s?k(?:t)?\b/, "gold"],
  [/\b(?:silver|ag|sterling|925)\b/, "silver"],
  [/\b(?:platinum|pt|plat|pt950)\b/, "platinum"],
  [/\b(?:palladium|pd)\b/, "palladium"],
];

/** "Gold", "14K YG", "Sterling", "PT950" to the metal. Null when no metal or more than one is named. */
export function piroMetal(text: string | undefined): PiroMetal | null {
  if (!present(text)) return null;
  const t = text.toLowerCase();
  const found = METAL_NAMES.filter(([pattern]) => pattern.test(t)).map(([, metal]) => metal);
  return found.length === 1 ? found[0]! : null;
}

/** "14K", "14kt", "14" or "18 KT" to the karat. Null for anything outside 1 to 24. */
export function piroKarat(text: string | undefined): number | null {
  if (!present(text)) return null;
  const m = /^(\d{1,2})\s*(?:k|kt|karat)?$/i.exec(text.trim());
  if (!m) return null;
  const k = Number(m[1]);
  return k >= 1 && k <= 24 ? k : null;
}

/** A measure's weight from whichever unit's column is filled: undefined when none is, null when it can't be read. */
function weight(get: ColumnGetter, row: CsvRow, measure: string): number | null | undefined {
  const units: [string, WeightUnit][] = [
    [`${measure}Grams`, "grams"],
    [`${measure}Dwt`, "dwt"],
  ];
  for (const [field, unit] of units) {
    const text = get(row, field);
    if (present(text)) return parseWeightGrams(text, unit);
  }
  return undefined;
}

function unreadable(kind: "job" | "casting", ctx: PiroRowContext, row: CsvRow, id: string | null, problems: string[]): PiroEvent {
  const where = `${ctx.file.name}:${row.line}`;
  const key = `piro:unreadable_${kind}:${where}`;
  return {
    id: key.replace(/[^A-Za-z0-9_.:-]/g, "_"),
    type: kind === "job" ? JOB_EVENT_TYPE : CASTING_EVENT_TYPE,
    // A row with a problem has no time, so the pipeline dead-letters it with the row kept.
    occurredAt: undefined,
    receivedAt: ctx.receivedAt,
    idempotencyKey: key,
    payload: { system: "PIRO", [kind === "job" ? "jobId" : "treeId"]: id, problems, sourceRow: where },
  };
}

function versioned(type: PiroEvent["type"], prefix: string, id: string, occurredAt: string, ctx: PiroRowContext, says: Record<string, unknown>, sourceRow: string): PiroEvent {
  const key = `piro:${prefix}:${id}:${hash12(says)}`;
  return {
    id: key.replace(/[^A-Za-z0-9_.:-]/g, "_"),
    type,
    occurredAt,
    receivedAt: ctx.receivedAt,
    idempotencyKey: key,
    payload: { ...says, sourceRow },
  };
}

/**
 * One job report row. Its time is the row's last update, or its completed
 * or start date, or when the report was exported, in that order, so a
 * report without dates still orders its changes.
 */
export function jobEvent(row: CsvRow, get: ColumnGetter, ctx: PiroRowContext): PiroEvent | null {
  const { profile } = ctx;
  const jobId = get(row, "jobId")?.trim() ?? "";
  const statusLabel = get(row, "status")?.trim() ?? "";
  if (jobId === "" && statusLabel === "") return null;
  const problems: string[] = [];
  if (jobId === "") problems.push("no job number");
  if (statusLabel === "") problems.push("no status");
  const date = (field: string): string | null | undefined => {
    const text = get(row, field);
    if (!present(text)) return undefined;
    const iso = parseDate(text, profile.dateOrder, profile.utcOffset);
    if (iso === null) problems.push(`${field} ${JSON.stringify(text.trim())} is not a date`);
    return iso;
  };
  const updated = date("updatedDate");
  const started = date("startDate");
  const completed = date("completedDate");
  const due = date("dueDate");
  const optionalText = (field: string) => {
    const text = get(row, field)?.trim().replace(/\s+/g, " ");
    return text ? text : undefined;
  };
  const metalText = optionalText("metal");
  const metal = metalText === undefined ? undefined : piroMetal(metalText);
  if (metal === null) problems.push(`metal ${JSON.stringify(metalText)} is not one metal`);
  const karatText = optionalText("karat");
  const karat = karatText === undefined ? undefined : piroKarat(karatText);
  if (karat === null) problems.push(`karat ${JSON.stringify(karatText)} is not a karat`);
  const quantityText = optionalText("quantity");
  const quantity = quantityText === undefined ? undefined : parseInteger(quantityText);
  if (quantity === null || (quantity !== undefined && quantity < 0)) problems.push(`quantity ${JSON.stringify(quantityText)} is not a count`);
  const estimated = weight(get, row, "estimated");
  const actual = weight(get, row, "actual");
  if (estimated === null) problems.push("the estimated weight is not a weight in its column's unit");
  if (actual === null) problems.push("the actual weight is not a weight in its column's unit");
  if (problems.length) return unreadable("job", ctx, row, jobId || null, problems);

  const say: Record<string, unknown> = { system: "PIRO", jobId, status: jobStatus(statusLabel, profile), statusLabel };
  const add = (key: string, value: unknown) => {
    if (value !== undefined && value !== null) say[key] = value;
  };
  add("stage", optionalText("stage"));
  add("styleNumber", optionalText("styleNumber"));
  add("sku", optionalText("sku"));
  add("orderNumber", optionalText("orderNumber"));
  add("metal", metal);
  add("karat", karat);
  add("quantity", quantity);
  add("startedOn", started?.slice(0, 10));
  add("dueOn", due?.slice(0, 10));
  add("completedOn", completed?.slice(0, 10));
  add("estimatedGrams", estimated);
  add("actualGrams", actual);
  if (typeof estimated === "number" && typeof actual === "number") say.weightVarianceGrams = Math.round((actual - estimated) * 1000) / 1000;
  add("treeId", optionalText("treeId"));
  const occurredAt = updated ?? completed ?? started ?? ctx.file.modifiedAt;
  if (occurredAt < ctx.since) return null;
  return versioned(JOB_EVENT_TYPE, "job", jobId, occurredAt, ctx, say, `${ctx.file.name}:${row.line}`);
}

/**
 * One casting tree. Loss is the metal issued less everything returned
 * (castings plus button, sprues and scrap); the returned weight is summed
 * from castings and scrap when the report has no total.
 */
export function castingEvent(row: CsvRow, get: ColumnGetter, ctx: PiroRowContext): PiroEvent | null {
  const { profile } = ctx;
  const treeId = get(row, "treeId")?.trim() ?? "";
  const dateText = get(row, "castDate");
  if (treeId === "" && !present(dateText)) return null;
  const problems: string[] = [];
  if (treeId === "") problems.push("no tree number");
  const castAt = present(dateText) ? parseDate(dateText, profile.dateOrder, profile.utcOffset) : null;
  if (castAt === null) problems.push(present(dateText) ? `cast date ${JSON.stringify(dateText.trim())} is not a date` : "no cast date");
  const metalText = get(row, "metal")?.trim() ?? "";
  const metal = piroMetal(metalText);
  if (metal === null) problems.push(metalText ? `metal ${JSON.stringify(metalText)} is not one metal` : "no metal");
  const karatText = get(row, "karat")?.trim();
  const karat = karatText ? piroKarat(karatText) : undefined;
  if (karat === null) problems.push(`karat ${JSON.stringify(karatText)} is not a karat`);
  const issued = weight(get, row, "issued");
  const castings = weight(get, row, "castings");
  const scrap = weight(get, row, "scrap");
  let returned = weight(get, row, "returned");
  if (issued === undefined) problems.push("no metal issued");
  for (const [label, value] of [["issued", issued], ["returned", returned], ["castings", castings], ["scrap", scrap]] as const) {
    if (value === null) problems.push(`the ${label} weight is not a weight in its column's unit`);
  }
  if (returned === undefined && typeof castings === "number" && typeof scrap === "number") returned = Math.round((castings + scrap) * 1000) / 1000;
  if (problems.length || castAt === null || metal === null || typeof issued !== "number") return unreadable("casting", ctx, row, treeId || null, problems);
  if (castAt < ctx.since) return null;

  const say: Record<string, unknown> = { system: "PIRO", treeId, castOn: castAt.slice(0, 10), metal, issuedGrams: issued };
  if (karat !== undefined) say.karat = karat;
  const status = get(row, "status")?.trim();
  if (status) say.statusLabel = status;
  if (typeof castings === "number") say.castingsGrams = castings;
  if (typeof scrap === "number") say.scrapGrams = scrap;
  if (typeof returned === "number") {
    say.returnedGrams = returned;
    const loss = Math.round((issued - returned) * 1000) / 1000;
    say.lossGrams = loss;
    say.lossPercent = Math.round((loss / issued) * 10_000) / 100;
  }
  const jobs = get(row, "jobs")?.split(/[,;\s]+/).filter(Boolean);
  if (jobs?.length) say.jobIds = [...new Set(jobs)];
  return versioned(CASTING_EVENT_TYPE, "casting", treeId, castAt, ctx, say, `${ctx.file.name}:${row.line}`);
}
