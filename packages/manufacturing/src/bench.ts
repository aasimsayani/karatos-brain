import { meltValueCents, type Metal, type Signal } from "@karatos/core";
import {
  calendarDaysSince,
  daysBetween,
  dollars,
  entityFrom,
  estimate,
  extractor,
  latestBySubject,
  pct,
  recommend,
  signalFrom,
  value,
  type DepartmentModule,
} from "@karatos/retail";
import { z } from "zod";

/**
 * Bench jobs: every piece made or worked on at the bench, through design and
 * CAD, casting, stone setting, finishing and quality control to ready. Each
 * stage a job enters is one record with its time, the bench jeweler and,
 * when weighed, the metal that went in and came back. Custom orders' own
 * stages count as bench records, and a job can name the repair ticket or
 * custom order it is for, so their promised dates and descriptions are used
 * rather than entered twice.
 */

export const BENCH_STAGES = ["design", "casting", "setting", "finishing", "qc", "ready", "on_hold", "cancelled"] as const;
export type BenchStage = (typeof BENCH_STAGES)[number];

/** The stages quality control checks, in the order work usually moves through them. */
export const WORK_STAGES = ["design", "casting", "setting", "finishing"] as const;
export type WorkStage = (typeof WORK_STAGES)[number];

/** The stages a job can sit in too long. */
export const LIMIT_STAGES = ["design", "casting", "setting", "finishing", "qc", "on_hold"] as const;
export type LimitStage = (typeof LIMIT_STAGES)[number];

/** Whole days a job can be in each stage before it counts as stuck: BENCH_STAGE_LIMIT_DAYS changes them. */
export const BENCH_STAGE_LIMIT_DAYS: Readonly<Record<LimitStage, number>> = { design: 7, casting: 4, setting: 4, finishing: 3, qc: 2, on_hold: 14 };
/** Metal a job may lose across its stages, as a share of the most issued to it: BENCH_METAL_LOSS_PERCENT changes it. */
export const BENCH_METAL_LOSS_SHARE = 0.03;
/** Finished jobs a stage needs in the store's own history before its typical time is used. */
export const BENCH_HISTORY_MIN_JOBS = 3;
/** How far back quality control results count toward rework rates. */
export const BENCH_REWORK_LOOKBACK_DAYS = 90;
/** Checks a stage or jeweler needs before a rework rate is raised. */
export const BENCH_REWORK_MIN_CHECKED = 5;
/** Failures a stage or jeweler needs before a rework rate is raised. */
export const BENCH_REWORK_MIN_FAILED = 2;
/** The share of checks failing at which a stage or jeweler is raised. */
export const BENCH_REWORK_RATE = 0.2;
/** A job is checked for metal loss while it was last weighed within this many days. */
export const BENCH_METAL_LOOKBACK_DAYS = 30;
/** A spot price older than this isn't used to value lost metal. */
export const BENCH_SPOT_MAX_AGE_DAYS = 30;
/** Custom orders raises an order stuck this long itself, so bench leaves it alone. */
const CUSTOM_ORDER_STALLED_DAYS = 14;
/** Custom orders raises an order due this soon that hasn't reached finishing itself. */
const CUSTOM_ORDER_AT_RISK_DAYS = 7;

const METALS = ["gold", "silver", "platinum", "palladium"] as const satisfies readonly Metal[];
/** The stages work moves through toward ready, in order. */
export const PROJECT_STAGES: readonly BenchStage[] = ["design", "casting", "setting", "finishing", "qc"];
const DONE: readonly BenchStage[] = ["ready", "cancelled"];
const DAY_MS = 86_400_000;

const id = z.string().min(1);

const BenchJobOpened = z.object({
  jobId: id,
  description: z.string().min(1).optional(),
  promisedBy: z.iso.date().optional(),
  /** The repair ticket this job is for, as the repairs department knows it. */
  repairTicketId: id.optional(),
  /** The custom order this job is for, as the custom orders department knows it. */
  customOrderId: id.optional(),
  metal: z.enum(METALS).optional(),
  karat: z.number().int().min(1).max(24).optional(),
});

const BenchStageRecorded = z
  .object({
    jobId: id,
    /** The stage the job entered at the event's time. */
    stage: z.enum(BENCH_STAGES),
    jeweler: z.string().min(1).optional(),
    /** Metal issued to the bench for this stage, in grams. */
    metalInGrams: z.number().positive().max(100_000).optional(),
    /** Metal back from this stage, piece and returned scrap together, in grams. */
    metalOutGrams: z.number().positive().max(100_000).optional(),
    /** Bench minutes worked on this stage, for labor cost and planning. A stage worked over several records adds them up. */
    laborMinutes: z.number().positive().max(10_000).optional(),
    qcResult: z.enum(["pass", "fail"]).optional(),
    /** On a failed check, the stage the work goes back to. */
    failedStage: z.enum(WORK_STAGES).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.qcResult !== undefined && p.stage !== "qc") ctx.addIssue({ code: "custom", path: ["qcResult"], message: "only a qc stage has a result" });
    if (p.failedStage !== undefined && p.qcResult !== "fail") {
      ctx.addIssue({ code: "custom", path: ["failedStage"], message: "only a failed qc names the stage the work goes back to" });
    }
  });

type Opened = z.infer<typeof BenchJobOpened>;
type Recorded = z.infer<typeof BenchStageRecorded>;

/** A custom order's stages as bench stages. Waiting on the customer's approval is a hold, not bench time. */
const CUSTOM_STAGES: Readonly<Record<string, BenchStage>> = {
  design: "design",
  cad: "design",
  approval: "on_hold",
  casting: "casting",
  setting: "setting",
  finishing: "finishing",
  ready: "ready",
  delivered: "ready",
  cancelled: "cancelled",
};
const REPAIR_CLOSED = ["ready", "picked_up", "cancelled"];
const CUSTOM_CLOSED = ["ready", "delivered", "cancelled"];

export const STAGE_NAMES: Readonly<Record<BenchStage, string>> = {
  design: "design and CAD",
  casting: "casting",
  setting: "stone setting",
  finishing: "finishing and polish",
  qc: "quality control",
  ready: "ready",
  on_hold: "on hold",
  cancelled: "cancelled",
};
const inStage = (stage: BenchStage) => (stage === "on_hold" ? "on hold" : `in ${STAGE_NAMES[stage]}`);
const g = (grams: number) => `${grams.toFixed(2)} g`;
const days1 = (days: number) => `${Math.round(days * 10) / 10}`;

export interface StageRecord {
  stage: BenchStage;
  at: string;
  jeweler?: string;
  metalIn?: number;
  metalOut?: number;
  laborMinutes?: number;
  qcResult?: "pass" | "fail";
  failedStage?: WorkStage;
  signal: Signal;
}

export interface BenchJob {
  /** The job id, or the custom order's id for one that has no bench job of its own. */
  jobId: string;
  /** Part of recommendation ids. */
  key: string;
  /** How a recommendation names it: "Bench job J-1 (Halo ring)". */
  label: string;
  /** Read from a custom order's own stages, with no bench job naming it. */
  fromCustomOrder: boolean;
  /** For a repair ticket or custom order, whose own department raises it once past due. */
  linked: boolean;
  /** For a repair ticket: the piece is the customer's, so only metal lost or added is the shop's. */
  forRepair: boolean;
  promisedBy?: string;
  /** What the customer is paying: the repair's estimate or the custom order's quote. */
  price?: { cents: number; source: "repair estimate" | "custom order quote" };
  metal?: Metal;
  karat?: number;
  /** Oldest first. */
  records: StageRecord[];
  /** Ready or cancelled here, or its repair or custom order is. */
  closed: boolean;
  /** The job's own, repair and custom order signals, without its stage records. */
  about: Signal[];
}

const order = (a: StageRecord, b: StageRecord) => a.at.localeCompare(b.at) || BENCH_STAGES.indexOf(a.stage) - BENCH_STAGES.indexOf(b.stage);

function record(signal: Signal): StageRecord {
  const v = value<Partial<Recorded>>(signal);
  return {
    stage: v.stage!,
    at: signal.observedAt,
    ...(v.jeweler !== undefined ? { jeweler: v.jeweler } : {}),
    ...(v.metalInGrams !== undefined ? { metalIn: v.metalInGrams } : {}),
    ...(v.metalOutGrams !== undefined ? { metalOut: v.metalOutGrams } : {}),
    ...(v.laborMinutes !== undefined ? { laborMinutes: v.laborMinutes } : {}),
    ...(v.qcResult !== undefined ? { qcResult: v.qcResult } : {}),
    ...(v.failedStage !== undefined ? { failedStage: v.failedStage } : {}),
    signal,
  };
}

function group(signals: Signal[], kind: string): Map<string, Signal[]> {
  const out = new Map<string, Signal[]>();
  for (const s of signals) if (s.kind === kind) out.set(s.subject.id, [...(out.get(s.subject.id) ?? []), s]);
  return out;
}

const labelOf = (name: string, description: string | undefined) => (description ? `${name} (${description})` : name);

/** Every job the signals know of: bench jobs with their stage records, and custom orders no bench job names. */
export function benchJobs(signals: Signal[]): BenchJob[] {
  const opened = latestBySubject(signals, ["bench.job"]);
  const stages = group(signals, "bench.stage");
  const tickets = latestBySubject(signals, ["repair.ticket"]);
  const repairStatus = latestBySubject(signals, ["repair.status"]);
  const orders = latestBySubject(signals, ["custom.order"]);
  const orderStage = latestBySubject(signals, ["custom.stage"]);
  const customStages = group(signals, "custom.stage");

  const jobs: BenchJob[] = [];
  const named = new Set<string>();
  const ids = new Set([...[...opened.values()].map((s) => s.subject.id), ...stages.keys()]);
  for (const jobId of ids) {
    const jobSignal = opened.get(`bench_job:${jobId}`);
    const job: Partial<Opened> = jobSignal ? value<Opened>(jobSignal) : {};
    const repairKey = job.repairTicketId === undefined ? undefined : `repair_ticket:${job.repairTicketId}`;
    const orderKey = job.customOrderId === undefined ? undefined : `custom_order:${job.customOrderId}`;
    if (job.customOrderId !== undefined) named.add(job.customOrderId);
    const ticket = repairKey ? tickets.get(repairKey) : undefined;
    const status = repairKey ? repairStatus.get(repairKey) : undefined;
    const customOrder = orderKey ? orders.get(orderKey) : undefined;
    const customStage = orderKey ? orderStage.get(orderKey) : undefined;
    const records = (stages.get(jobId) ?? []).map(record).sort(order);
    const ticketValue = ticket ? value<{ promisedBy?: string; itemDescription?: string; estimateCents?: number }>(ticket) : {};
    const orderValue = customOrder ? value<{ dueBy?: string; description?: string; quotedCents?: number }>(customOrder) : {};
    const price =
      orderValue.quotedCents !== undefined
        ? { cents: orderValue.quotedCents, source: "custom order quote" as const }
        : ticketValue.estimateCents !== undefined
          ? { cents: ticketValue.estimateCents, source: "repair estimate" as const }
          : undefined;
    const promisedBy = job.promisedBy ?? orderValue.dueBy ?? ticketValue.promisedBy;
    const last = records.at(-1);
    jobs.push({
      jobId,
      key: jobId,
      label: labelOf(`Bench job ${jobId}`, job.description ?? orderValue.description ?? ticketValue.itemDescription),
      fromCustomOrder: false,
      linked: repairKey !== undefined || orderKey !== undefined,
      forRepair: repairKey !== undefined,
      ...(promisedBy !== undefined ? { promisedBy } : {}),
      ...(price !== undefined ? { price } : {}),
      ...(job.metal !== undefined ? { metal: job.metal } : {}),
      ...(job.karat !== undefined ? { karat: job.karat } : {}),
      records,
      closed:
        (last !== undefined && DONE.includes(last.stage)) ||
        (status !== undefined && REPAIR_CLOSED.includes(value<{ status: string }>(status).status)) ||
        (customStage !== undefined && CUSTOM_CLOSED.includes(value<{ stage: string }>(customStage).stage)),
      about: [jobSignal, ticket, status, customOrder, customStage].filter((s): s is Signal => s !== undefined),
    });
  }

  for (const [orderId, list] of customStages) {
    if (named.has(orderId)) continue;
    const customOrder = orders.get(`custom_order:${orderId}`);
    const o = customOrder ? value<{ dueBy?: string; description?: string; quotedCents?: number }>(customOrder) : {};
    const records = list
      .filter((s) => CUSTOM_STAGES[value<{ stage: string }>(s).stage] !== undefined)
      .map((s) => ({ stage: CUSTOM_STAGES[value<{ stage: string }>(s).stage]!, at: s.observedAt, signal: s }))
      .sort(order);
    const last = records.at(-1);
    jobs.push({
      jobId: orderId,
      key: `custom_order_${orderId}`,
      label: labelOf(`Custom order ${orderId}`, o.description),
      fromCustomOrder: true,
      linked: true,
      forRepair: false,
      ...(o.dueBy !== undefined ? { promisedBy: o.dueBy } : {}),
      ...(o.quotedCents !== undefined ? { price: { cents: o.quotedCents, source: "custom order quote" as const } } : {}),
      records,
      closed: last !== undefined && DONE.includes(last.stage),
      about: customOrder ? [customOrder] : [],
    });
  }
  return jobs;
}

/** The record that started the job's current stage: the first of its latest records in a row with that stage. */
export function currentStage(records: StageRecord[]): { since: StageRecord; last: StageRecord } | undefined {
  if (records.length === 0) return undefined;
  let i = records.length - 1;
  while (i > 0 && records[i - 1]!.stage === records[i]!.stage) i--;
  return { since: records[i]!, last: records.at(-1)! };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface TypicalTime {
  /** Median days from first entering the stage to ready, rework included. */
  days: number;
  /** Finished jobs it is worked out from. */
  jobs: number;
}

/**
 * The store's own typical time from each stage to ready: the median, over
 * jobs that finished, of the days from first entering the stage to reaching
 * ready. Rework and skipped stages are in the history, so they need no
 * guess. A stage with fewer than BENCH_HISTORY_MIN_JOBS finished jobs has none.
 */
export function typicalTimes(jobs: BenchJob[]): Map<BenchStage, TypicalTime> {
  const samples = new Map<BenchStage, number[]>();
  for (const job of jobs) {
    const current = currentStage(job.records);
    if (!current || current.since.stage !== "ready") continue;
    const readyAt = Date.parse(current.since.at);
    const before = job.records.slice(0, job.records.indexOf(current.since));
    for (const stage of PROJECT_STAGES) {
      const first = before.find((r) => r.stage === stage);
      if (first) samples.set(stage, [...(samples.get(stage) ?? []), (readyAt - Date.parse(first.at)) / DAY_MS]);
    }
  }
  const out = new Map<BenchStage, TypicalTime>();
  for (const [stage, list] of samples) if (list.length >= BENCH_HISTORY_MIN_JOBS) out.set(stage, { days: median(list), jobs: list.length });
  return out;
}

interface Tally {
  checked: number;
  failed: number;
  failures: Signal[];
  /** For a jeweler: failures by stage. For a stage: failures by jeweler. */
  by: Map<string, number>;
}

const tally = (map: Map<string, Tally>, key: string): Tally => {
  let t = map.get(key);
  if (!t) map.set(key, (t = { checked: 0, failed: 0, failures: [], by: new Map() }));
  return t;
};

/**
 * Quality control's results in the lookback, by the stage and the jeweler
 * whose work was checked. Each check counts every work stage the job went
 * through since its last check, with the jeweler who last worked that stage.
 * A failure counts against the stage the work went back to: the one the
 * check names, else the earlier stage the job moves to next, else the last
 * stage worked before the check. A check with no result counts as failed
 * when the job next goes back to an earlier stage and passed when it moves
 * on; one with nothing after it isn't counted yet.
 */
export function reworkTallies(jobs: BenchJob[], now: string): { stages: Map<string, Tally>; jewelers: Map<string, Tally> } {
  const stages = new Map<string, Tally>();
  const jewelers = new Map<string, Tally>();
  const since = Date.parse(now) - BENCH_REWORK_LOOKBACK_DAYS * DAY_MS;
  for (const job of jobs) {
    let worked: StageRecord[] = [];
    job.records.forEach((r, i) => {
      if (r.stage !== "qc") {
        if ((WORK_STAGES as readonly string[]).includes(r.stage)) worked.push(r);
        return;
      }
      const next = job.records[i + 1];
      const backTo = next && (WORK_STAGES as readonly string[]).includes(next.stage) ? (next.stage as WorkStage) : undefined;
      const result = r.qcResult ?? (backTo ? "fail" : next ? "pass" : undefined);
      if (result === undefined) return;
      if (Date.parse(r.at) >= since) {
        const failedStage = result === "fail" ? (r.failedStage ?? backTo ?? worked.at(-1)?.stage) : undefined;
        const checked = new Map<string, StageRecord>();
        for (const w of worked) checked.set(w.stage, w);
        if (failedStage !== undefined && !checked.has(failedStage)) {
          const earlier = job.records.slice(0, i).findLast((w) => w.stage === failedStage);
          if (earlier) checked.set(failedStage, earlier);
        }
        for (const [stage, w] of checked) {
          const failed = stage === failedStage;
          const s = tally(stages, stage);
          s.checked++;
          const j = w.jeweler === undefined ? undefined : tally(jewelers, w.jeweler);
          if (j) j.checked++;
          if (!failed) continue;
          s.failed++;
          s.failures.push(r.signal, w.signal);
          if (w.jeweler !== undefined) s.by.set(w.jeweler, (s.by.get(w.jeweler) ?? 0) + 1);
          if (j) {
            j.failed++;
            j.failures.push(r.signal, w.signal);
            j.by.set(stage, (j.by.get(stage) ?? 0) + 1);
          }
        }
      }
      worked = [];
    });
  }
  return { stages, jewelers };
}

const most = (by: Map<string, number>) => [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unnamed";

/** The instance's own figures for the bench rules. Each one left out keeps the default. */
export interface BenchSettings {
  /** From BENCH_STAGE_LIMIT_DAYS: whole days a job can be in a stage before it is raised as stuck. */
  stageLimitDays?: Partial<Record<LimitStage, number>>;
  /** From BENCH_METAL_LOSS_PERCENT, as a share: 0.03 is 3%. */
  metalLossShare?: number;
}

export class BenchSettingsError extends Error {
  override name = "BenchSettingsError";
}

/**
 * Reads BENCH_STAGE_LIMIT_DAYS: a number of days for every stage, stages
 * with their own ("casting=5, setting=3"), or both ("5, qc=1"). Days are
 * whole, 1 to 365. Empty keeps every default.
 */
export function parseStageLimits(text: string): Partial<Record<LimitStage, number>> {
  const out: Partial<Record<LimitStage, number>> = {};
  const days = (raw: string, entry: string) => {
    if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 365) throw new BenchSettingsError(`"${entry}" needs whole days from 1 to 365`);
    return Number(raw);
  };
  const entries = text.split(",").map((e) => e.trim()).filter(Boolean);
  for (const entry of entries.filter((e) => !e.includes("="))) {
    const n = days(entry, entry);
    for (const stage of LIMIT_STAGES) out[stage] = n;
  }
  for (const entry of entries.filter((e) => e.includes("="))) {
    const [name, raw] = entry.split("=").map((p) => p.trim());
    if (!(LIMIT_STAGES as readonly string[]).includes(name!)) throw new BenchSettingsError(`"${name}" in "${entry}" isn't a stage; use ${LIMIT_STAGES.join(", ")}`);
    out[name as LimitStage] = days(raw!, entry);
  }
  return out;
}

/** Bench jobs with the instance's own stage limits and metal loss tolerance. */
export function benchDepartment(settings: BenchSettings = {}): DepartmentModule {
  const limits: Record<LimitStage, number> = { ...BENCH_STAGE_LIMIT_DAYS, ...settings.stageLimitDays };
  const tolerance = settings.metalLossShare ?? BENCH_METAL_LOSS_SHARE;
  const department = "bench";

  return {
    id: department,
    name: "Bench Jobs",
    purpose: "Every piece at the bench through casting, stone setting, finishing and quality control, so work is on time, right the first time, and no metal goes missing.",
    events: { "bench_job.opened": BenchJobOpened, "bench_job.stage_recorded": BenchStageRecorded },
    normalizers: [
      entityFrom<Opened>("bench-jobs", "bench_job.opened", (p) => ({ ref: { kind: "bench_job", id: p.jobId }, attributes: { ...p } })),
    ],
    extractors: [
      extractor("bench-signals", (event) => {
        if (event.type === "bench_job.opened") {
          const p = BenchJobOpened.parse(event.payload);
          return [signalFrom(event, "bench.job", { kind: "bench_job", id: p.jobId }, { ...p })];
        }
        if (event.type === "bench_job.stage_recorded") {
          const p = BenchStageRecorded.parse(event.payload);
          return [signalFrom(event, "bench.stage", { kind: "bench_job", id: p.jobId }, { ...p })];
        }
        return [];
      }),
    ],
    reasoners: [
      {
        name: "bench.stuck",
        reason: ({ organizationId, signals, now }) =>
          benchJobs(signals).flatMap((job) => {
            const current = currentStage(job.records);
            if (job.closed || !current) return [];
            // Ready and cancelled jobs are closed, so the stage is one with a limit.
            const stage = current.since.stage;
            const limit = limits[stage as LimitStage];
            const days = daysBetween(current.since.at, now);
            if (days <= limit) return [];
            // Custom orders raises its own order once it has sat this long.
            if (job.fromCustomOrder && days >= CUSTOM_ORDER_STALLED_DAYS) return [];
            const who = current.last.jeweler;
            return [
              recommend({
                department,
                organizationId,
                now,
                key: `stuck_${job.key}`,
                summary: `${job.label} has been ${inStage(stage)} for ${days} days${who ? ` with ${who}` : ""}, past the ${limit}-day limit. Find out what's holding it up.`,
                confidence: 0.75,
                expectedImpact: "Keeps bench work moving toward its promised date",
                basedOn: [...job.about, ...job.records.slice(job.records.indexOf(current.since)).map((r) => r.signal)],
              }),
            ];
          }),
      },
      {
        name: "bench.promised-date",
        reason: ({ organizationId, signals, now }) => {
          const jobs = benchJobs(signals);
          const typical = typicalTimes(jobs);
          return jobs.flatMap((job) => {
            const current = currentStage(job.records);
            if (job.closed || !current || job.promisedBy === undefined) return [];
            const stage = current.since.stage;
            if (!PROJECT_STAGES.includes(stage)) return [];
            const basedOn = [...job.about, ...job.records.map((r) => r.signal)];
            const late = calendarDaysSince(job.promisedBy, now);
            if (late > 0) {
              // A repair or custom order past due is raised by its own department.
              if (job.linked) return [];
              return [
                recommend({
                  department,
                  organizationId,
                  now,
                  key: `late_${job.key}`,
                  summary: `${job.label} is ${late} days past its promised date of ${job.promisedBy} and still ${inStage(stage)}. Call the customer with a new date today.`,
                  confidence: 0.9,
                  expectedImpact: "Keeps the customer's trust on late work",
                  basedOn,
                }),
              ];
            }
            // Custom orders already raises an order this close to due that hasn't reached finishing.
            if (job.fromCustomOrder && -late <= CUSTOM_ORDER_AT_RISK_DAYS && !["finishing", "qc"].includes(stage)) return [];
            const time = typical.get(stage);
            if (!time) return [];
            const first = job.records.find((r) => r.stage === stage)!;
            // A job already past its typical time projects to before today, which is never after a promise still to come.
            const projected = new Date(Date.parse(first.at) + time.days * DAY_MS).toISOString().slice(0, 10);
            const over = daysBetween(`${job.promisedBy}T00:00:00Z`, `${projected}T00:00:00Z`);
            if (over <= 0) return [];
            return [
              recommend({
                department,
                organizationId,
                now,
                key: `at_risk_${job.key}`,
                summary: `${job.label} is promised for ${job.promisedBy} and is ${inStage(stage)}. Jobs here take a median of ${days1(time.days)} days from ${STAGE_NAMES[stage]} to ready (${time.jobs} finished jobs), so it is likely ready about ${projected}, ${over} days late. Tell the customer now or move it up the queue.`,
                confidence: 0.7,
                expectedImpact: "Avoids a missed promise by acting before the date",
                basedOn,
              }),
            ];
          });
        },
      },
      {
        name: "bench.rework",
        reason: ({ organizationId, signals, now }) => {
          const { stages, jewelers } = reworkTallies(benchJobs(signals), now);
          const raised = (t: Tally) => t.checked >= BENCH_REWORK_MIN_CHECKED && t.failed >= BENCH_REWORK_MIN_FAILED && t.failed / t.checked >= BENCH_REWORK_RATE;
          const out = [];
          for (const stage of WORK_STAGES) {
            const t = stages.get(stage);
            if (!t || !raised(t)) continue;
            const top = most(t.by);
            out.push(
              recommend({
                department,
                organizationId,
                now,
                key: `rework_stage_${stage}`,
                summary: `Quality control sent back ${t.failed} of ${t.checked} pieces checked after ${STAGE_NAMES[stage]} (${pct(t.failed / t.checked)}) in the last ${BENCH_REWORK_LOOKBACK_DAYS} days${top ? `, ${top[1]} of them ${top[0]}'s` : ""}. Look at what is failing before more work goes back.`,
                confidence: 0.7,
                expectedImpact: "Less rework at the bench and fewer late pieces",
                basedOn: [...new Set(t.failures)],
              }),
            );
          }
          for (const [jeweler, t] of [...jewelers.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            if (!raised(t)) continue;
            const top = most(t.by)!;
            out.push(
              recommend({
                department,
                organizationId,
                now,
                key: `rework_jeweler_${slug(jeweler)}`,
                summary: `${t.failed} of ${t.checked} stages ${jeweler} worked failed quality control (${pct(t.failed / t.checked)}) in the last ${BENCH_REWORK_LOOKBACK_DAYS} days, most at ${STAGE_NAMES[top[0] as WorkStage]} (${top[1]}). Go through the failures together.`,
                confidence: 0.65,
                expectedImpact: "Less rework at the bench and fewer late pieces",
                basedOn: [...new Set(t.failures)],
              }),
            );
          }
          return out;
        },
      },
      {
        name: "bench.metal-loss",
        reason: ({ organizationId, signals, now }) => {
          const prices = signals.filter((s) => s.kind === "metal.price").sort((a, b) => b.observedAt.localeCompare(a.observedAt));
          return benchJobs(signals).flatMap((job) => {
            const weighed = job.records.filter((r) => r.metalIn !== undefined && r.metalOut !== undefined);
            if (weighed.length === 0 || daysBetween(weighed.at(-1)!.at, now) > BENCH_METAL_LOOKBACK_DAYS) return [];
            const issued = Math.max(...weighed.map((r) => r.metalIn!));
            // To the milligram, so a loss right at the tolerance isn't tipped over it by floating point.
            const mg = (grams: number) => Math.round(grams * 1000) / 1000;
            const loss = mg(weighed.reduce((sum, r) => sum + r.metalIn! - r.metalOut!, 0));
            const allowed = mg(issued * tolerance);
            if (loss <= allowed) return [];
            const worst = [...weighed].sort((a, b) => b.metalIn! - b.metalOut! - (a.metalIn! - a.metalOut!))[0]!;
            const excess = mg(loss - allowed);
            const spot = job.metal
              ? prices.find((s) => value<{ metal: string }>(s).metal === job.metal && daysBetween(s.observedAt, now) <= BENCH_SPOT_MAX_AGE_DAYS)
              : undefined;
            const valued = spot !== undefined && (job.metal !== "gold" || job.karat !== undefined);
            const spotCents = spot ? value<{ spotPerTroyOunceCents: number }>(spot).spotPerTroyOunceCents : 0;
            const alloy = job.metal === "gold" ? `${job.karat}K gold` : job.metal;
            const impact = valued
              ? estimate(
                  "protects",
                  `${g(excess)} lost above the ${pct(tolerance)} tolerance on ${g(issued)} issued, as ${alloy} at ${dollars(spotCents)} an ounce spot.`,
                  () => meltValueCents({ metal: job.metal!, ...(job.karat !== undefined ? { karat: job.karat } : {}), weightGrams: excess, spotPerTroyOunceCents: spotCents }),
                )
              : undefined;
            return [
              recommend({
                department,
                organizationId,
                now,
                key: `metal_loss_${job.key}`,
                summary: `${job.label} lost ${g(loss)} of metal (${pct(loss / issued)} of the ${g(issued)} issued), past the ${pct(tolerance)} tolerance; most ${inStage(worst.stage)} (${g(worst.metalIn! - worst.metalOut!)}${worst.jeweler ? `, ${worst.jeweler}` : ""}). Weigh the sweeps and filings before scrap goes to the refiner.`,
                confidence: 0.8,
                expectedImpact: "Finds metal lost at the bench while it can still be recovered",
                impact,
                basedOn: [...job.about, ...weighed.map((r) => r.signal), ...(valued ? [spot] : [])],
              }),
            ];
          });
        },
      },
    ],
  };
}

/** Bench jobs with the default stage limits and metal loss tolerance. */
export const bench: DepartmentModule = benchDepartment();
