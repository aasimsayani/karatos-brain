import { meltValueCents, type Metal, type Signal } from "@karatos/core";
import { daysBetween, dollars, estimate, pct, recommend, STORE_HOURS, value, type DepartmentModule, type StoreHours } from "@karatos/retail";
import {
  BENCH_HISTORY_MIN_JOBS,
  BENCH_SPOT_MAX_AGE_DAYS,
  benchJobs,
  currentStage,
  median,
  PROJECT_STAGES,
  slug,
  STAGE_NAMES,
  type BenchJob,
  type BenchStage,
  type StageRecord,
} from "./bench.js";

/**
 * Production planning: what each piece cost to make, whether the shop is
 * losing more metal than it used to, and whether the work in hand fits the
 * bench's hours before it is promised. It owns no events: it reads the bench
 * department's job and stage records (with the bench minutes worked on each
 * stage), the repair estimates and custom order quotes those jobs are for,
 * and the metals department's spot prices.
 */

/** Dollars an hour of bench time costs, in cents, when no jeweler's own rate is set: BENCH_LABOR_RATE changes it. */
export const PRODUCTION_LABOR_RATE_CENTS = 4_500;
/** Hours of bench work a jeweler does in a working day: BENCH_DAILY_HOURS changes it. */
export const PRODUCTION_DAILY_HOURS = 6;
/** A piece is raised once its labor and metal come to more than this share of what the customer pays. */
export const PRODUCTION_COST_SHARE = 0.6;
/** A piece is checked while bench time was last recorded on it within this many days. */
export const PRODUCTION_COST_LOOKBACK_DAYS = 30;
/** The recent window a loss trend is read over. */
export const PRODUCTION_TREND_RECENT_DAYS = 30;
/** The window before it the recent loss rate is compared with. */
export const PRODUCTION_TREND_BASELINE_DAYS = 90;
/** Weighings each window needs before a trend is read. */
export const PRODUCTION_TREND_MIN_RECORDS = 5;
/** How much higher the recent loss rate must be, in points of the metal issued: 0.01 is one point. */
export const PRODUCTION_TREND_RISE = 0.01;
/** Calendar days ahead the bench's load is compared with its hours. */
export const PRODUCTION_PLAN_DAYS = 7;
/** A later stage is planned for a job once at least this share of finished jobs went on from its current stage to it. */
export const PRODUCTION_FOLLOW_SHARE = 0.5;
/** A jeweler with a stage recorded within this many days is at the bench, and does the stage they did most in it. */
export const PRODUCTION_ACTIVE_DAYS = 30;

const DAY_MS = 86_400_000;
const NO_JEWELER = "";

/** A figure for the whole bench, with jewelers' own where they differ: BENCH_LABOR_RATE=45, Ana=55. */
export interface JewelerFigures {
  /** Everyone's, unless they have their own. */
  all?: number;
  /** By name as written. Names match whatever their case. */
  jewelers?: Record<string, number>;
}

/** The instance's own figures for production planning. Each one left out keeps the default. */
export interface ProductionSettings {
  /** From BENCH_LABOR_RATE, in cents an hour. */
  laborRateCents?: JewelerFigures;
  /** From BENCH_DAILY_HOURS. */
  dailyHours?: JewelerFigures;
  /** From STORE_TIME_ZONE, STORE_HOURS and STORE_CLOSED_DATES: the days the bench works. */
  storeHours?: StoreHours;
}

export class ProductionSettingsError extends Error {
  override name = "ProductionSettingsError";
}

/**
 * Reads a figure for everyone, jewelers' own ("Ana=55"), or both
 * ("45, Ana=55, Ben Ortiz=40"), each with up to two decimals and between
 * `min` and `max`. Empty keeps every default.
 */
export function parseJewelerFigures(text: string, limits: { min: number; max: number; unit: string }): JewelerFigures {
  const out: JewelerFigures = {};
  const jewelers: Record<string, number> = {};
  const figure = (raw: string, entry: string) => {
    if (!/^\d{1,4}(\.\d{1,2})?$/.test(raw) || Number(raw) < limits.min || Number(raw) > limits.max) {
      throw new ProductionSettingsError(`"${entry}" needs ${limits.unit} from ${limits.min} to ${limits.max}, with up to two decimals`);
    }
    return Number(raw);
  };
  for (const entry of text.split(",").map((e) => e.trim()).filter(Boolean)) {
    const at = entry.lastIndexOf("=");
    if (at < 0) {
      if (out.all !== undefined) throw new ProductionSettingsError(`"${entry}" is a second figure for everyone; give each jeweler's own as name=figure`);
      out.all = figure(entry, entry);
      continue;
    }
    const name = entry.slice(0, at).trim();
    if (!name) throw new ProductionSettingsError(`"${entry}" needs a jeweler's name before the =`);
    if (Object.keys(jewelers).some((n) => n.toLowerCase() === name.toLowerCase())) throw new ProductionSettingsError(`"${name}" is given twice`);
    jewelers[name] = figure(entry.slice(at + 1).trim(), entry);
  }
  return Object.keys(jewelers).length ? { ...out, jewelers } : out;
}

/** Reads BENCH_LABOR_RATE: dollars an hour, 1 to 1000, as cents. */
export function parseLaborRates(text: string): JewelerFigures {
  const read = parseJewelerFigures(text, { min: 1, max: 1000, unit: "dollars an hour" });
  const cents = (n: number) => Math.round(n * 100);
  return {
    ...(read.all !== undefined ? { all: cents(read.all) } : {}),
    ...(read.jewelers ? { jewelers: Object.fromEntries(Object.entries(read.jewelers).map(([n, v]) => [n, cents(v)])) } : {}),
  };
}

/** Reads BENCH_DAILY_HOURS: bench hours in a working day, 0.5 to 24. */
export function parseDailyHours(text: string): JewelerFigures {
  return parseJewelerFigures(text, { min: 0.5, max: 24, unit: "hours" });
}

/** A jeweler's own figure, else everyone's, else the default. */
export function figureFor(figures: JewelerFigures | undefined, jeweler: string | undefined, fallback: number): number {
  const own = jeweler === undefined ? undefined : Object.entries(figures?.jewelers ?? {}).find(([n]) => n.toLowerCase() === jeweler.toLowerCase());
  return own ? own[1] : (figures?.all ?? fallback);
}

const hours = (h: number) => `${Math.round(h * 10) / 10} h`;
const g = (grams: number) => `${grams.toFixed(2)} g`;
const mg = (grams: number) => Math.round(grams * 1000) / 1000;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const alloyName = (metal: Metal, karat: number | undefined) => (metal === "gold" ? (karat === undefined ? "gold of no recorded karat" : `${karat}K gold`) : metal);

/** The latest spot price of each metal from the last BENCH_SPOT_MAX_AGE_DAYS, with its signal. */
function spots(signals: Signal[], now: string): Map<Metal, Signal> {
  const out = new Map<Metal, Signal>();
  for (const s of signals) {
    if (s.kind !== "metal.price" || daysBetween(s.observedAt, now) > BENCH_SPOT_MAX_AGE_DAYS) continue;
    const metal = value<{ metal: Metal }>(s).metal;
    const held = out.get(metal);
    if (!held || s.observedAt > held.observedAt) out.set(metal, s);
  }
  return out;
}

/** A job's metal (grams above 0) at melt value, or undefined without a metal, gold's karat or a recent spot price. */
function melt(job: Pick<BenchJob, "metal" | "karat">, grams: number, prices: Map<Metal, Signal>): { cents: number; spot: Signal } | undefined {
  if (job.metal === undefined || (job.metal === "gold" && job.karat === undefined)) return undefined;
  const spot = prices.get(job.metal);
  if (!spot) return undefined;
  const spotPerTroyOunceCents = value<{ spotPerTroyOunceCents: number }>(spot).spotPerTroyOunceCents;
  return { cents: meltValueCents({ metal: job.metal, ...(job.karat !== undefined ? { karat: job.karat } : {}), weightGrams: grams, spotPerTroyOunceCents }), spot };
}

export interface PieceCost {
  job: BenchJob;
  /** Its latest stage is ready. */
  finished: boolean;
  /** Bench minutes recorded on it, by jeweler; NO_JEWELER ("") for minutes recorded without one. */
  minutesByJeweler: Map<string, number>;
  laborMinutes: number;
  /** Each record's minutes at its jeweler's rate. */
  laborCents: number;
  /**
   * The metal that is the shop's: for a repair, what was lost across its
   * stages, since the piece is the customer's; for anything else, the most
   * issued to it in one record.
   */
  metal?: { grams: number; basis: "lost" | "issued"; cents?: number };
  /** Labor, and metal when it has a melt value. */
  costCents: number;
  /** The latest record with bench minutes. */
  lastLaborAt: string;
  /** Records with bench minutes or weights, and the spot price used. */
  basedOn: Signal[];
}

/** What each job with bench minutes recorded on it cost so far: labor at each jeweler's rate, and metal at melt. */
export function pieceCosts(jobs: BenchJob[], signals: Signal[], settings: ProductionSettings, now: string): PieceCost[] {
  const prices = spots(signals, now);
  const out: PieceCost[] = [];
  for (const job of jobs) {
    const worked = job.records.filter((r) => r.laborMinutes !== undefined);
    if (worked.length === 0) continue;
    const minutesByJeweler = new Map<string, number>();
    let labor = 0;
    for (const r of worked) {
      const who = r.jeweler ?? NO_JEWELER;
      minutesByJeweler.set(who, (minutesByJeweler.get(who) ?? 0) + r.laborMinutes!);
      labor += (r.laborMinutes! / 60) * figureFor(settings.laborRateCents, r.jeweler, PRODUCTION_LABOR_RATE_CENTS);
    }
    const laborCents = Math.round(labor);
    const issued = job.records.filter((r) => r.metalIn !== undefined);
    const weighed = job.records.filter((r) => r.metalIn !== undefined && r.metalOut !== undefined);
    const grams = job.forRepair ? mg(weighed.reduce((sum, r) => sum + r.metalIn! - r.metalOut!, 0)) : Math.max(0, ...issued.map((r) => r.metalIn!));
    const valued = grams > 0 ? melt(job, grams, prices) : undefined;
    const metal = grams > 0 ? { grams, basis: job.forRepair ? ("lost" as const) : ("issued" as const), ...(valued ? { cents: valued.cents } : {}) } : undefined;
    out.push({
      job,
      finished: currentStage(job.records)?.since.stage === "ready",
      minutesByJeweler,
      laborMinutes: worked.reduce((sum, r) => sum + r.laborMinutes!, 0),
      laborCents,
      ...(metal ? { metal } : {}),
      costCents: laborCents + (valued?.cents ?? 0),
      lastLaborAt: worked.at(-1)!.at,
      basedOn: [...job.about, ...new Set([...worked, ...(metal ? (job.forRepair ? weighed : issued) : [])].map((r) => r.signal)), ...(valued ? [valued.spot] : [])],
    });
  }
  return out;
}

export interface LossWindow {
  /** Weighings: records with metal in and out. */
  records: number;
  inGrams: number;
  /** Metal in less metal out; a gain offsets a loss. */
  lostGrams: number;
}

export interface LossTrend {
  by: "alloy" | "jeweler";
  name: string;
  recent: LossWindow;
  baseline: LossWindow;
  /** The recent weighings, each with its job. */
  weighings: { record: StageRecord; job: BenchJob }[];
}

const rate = (w: LossWindow) => (w.inGrams > 0 ? w.lostGrams / w.inGrams : 0);

/**
 * The share of metal issued at the bench that didn't come back, by alloy
 * (metal and karat) and by jeweler, over the last PRODUCTION_TREND_RECENT_DAYS
 * and the PRODUCTION_TREND_BASELINE_DAYS before them. Each weighing counts
 * once in its job's alloy and once for the jeweler who worked it.
 */
export function lossTrends(jobs: BenchJob[], now: string): LossTrend[] {
  const groups = new Map<string, LossTrend>();
  const recentFrom = Date.parse(now) - PRODUCTION_TREND_RECENT_DAYS * DAY_MS;
  const baselineFrom = recentFrom - PRODUCTION_TREND_BASELINE_DAYS * DAY_MS;
  const add = (by: LossTrend["by"], name: string, recent: boolean, record: StageRecord, job: BenchJob) => {
    const key = `${by}:${name.toLowerCase()}`;
    let t = groups.get(key);
    if (!t) groups.set(key, (t = { by, name, recent: { records: 0, inGrams: 0, lostGrams: 0 }, baseline: { records: 0, inGrams: 0, lostGrams: 0 }, weighings: [] }));
    const w = recent ? t.recent : t.baseline;
    w.records++;
    w.inGrams = mg(w.inGrams + record.metalIn!);
    w.lostGrams = mg(w.lostGrams + record.metalIn! - record.metalOut!);
    if (recent) t.weighings.push({ record, job });
  };
  for (const job of jobs) {
    for (const r of job.records) {
      if (r.metalIn === undefined || r.metalOut === undefined) continue;
      const at = Date.parse(r.at);
      if (at <= baselineFrom || at > Date.parse(now)) continue;
      const recent = at > recentFrom;
      if (job.metal !== undefined) add("alloy", alloyName(job.metal, job.karat), recent, r, job);
      if (r.jeweler !== undefined) add("jeweler", r.jeweler, recent, r, job);
    }
  }
  return [...groups.values()].sort((a, b) => a.by.localeCompare(b.by) || a.name.localeCompare(b.name));
}

export interface StageLabor {
  /** Median bench minutes a finished job spent in the stage, rework included. */
  minutes: number;
  /** Finished jobs with bench minutes in the stage. */
  jobs: number;
}

const finishedJobs = (jobs: BenchJob[]) => jobs.filter((j) => currentStage(j.records)?.since.stage === "ready");

/** The store's own bench minutes per stage: the median, over finished jobs with minutes in it, of each job's total. */
export function typicalLabor(jobs: BenchJob[]): Map<BenchStage, StageLabor> {
  const samples = new Map<BenchStage, number[]>();
  for (const job of finishedJobs(jobs)) {
    const totals = new Map<BenchStage, number>();
    for (const r of job.records) if (r.laborMinutes !== undefined) totals.set(r.stage, (totals.get(r.stage) ?? 0) + r.laborMinutes);
    for (const [stage, minutes] of totals) samples.set(stage, [...(samples.get(stage) ?? []), minutes]);
  }
  const out = new Map<BenchStage, StageLabor>();
  for (const [stage, list] of samples) if (list.length >= BENCH_HISTORY_MIN_JOBS) out.set(stage, { minutes: median(list), jobs: list.length });
  return out;
}

/**
 * The later stages finished jobs usually went on to from each stage: for
 * each stage, the share of finished jobs that went through it and had a
 * record of a later stage after their first time in it.
 */
function onwardStages(jobs: BenchJob[]): (from: BenchStage) => BenchStage[] {
  const finished = finishedJobs(jobs);
  return (from) => {
    const through = finished.filter((j) => j.records.some((r) => r.stage === from));
    if (through.length < BENCH_HISTORY_MIN_JOBS) return [];
    const later = PROJECT_STAGES.slice(PROJECT_STAGES.indexOf(from) + 1);
    return later.filter((stage) => {
      const went = through.filter((j) => j.records.slice(j.records.findIndex((r) => r.stage === from)).some((r) => r.stage === stage)).length;
      return went / through.length >= PRODUCTION_FOLLOW_SHARE;
    });
  };
}

export interface PlannedWork {
  stage: BenchStage;
  jeweler: string;
  hours: number;
  /** Working days from the start of today. */
  start: number;
  end: number;
}

export interface JobPlan {
  job: BenchJob;
  work: PlannedWork[];
  /** The working day its last planned work ends, with the queue ahead of it. */
  finishDay: string;
  /** The day it would end on its own work alone, with nothing queued ahead. */
  aloneDay: string;
}

export interface JewelerLoad {
  jeweler: string;
  dailyHours: number;
  /** All the work planned for them. */
  queuedHours: number;
  /** Their hours over the planning days. */
  capacityHours: number;
  byStage: Map<BenchStage, number>;
  /** Every job with work planned for them, and their signals. */
  jobs: BenchJob[];
}

export interface BenchPlan {
  /** The working days from today through PRODUCTION_PLAN_DAYS ahead. */
  workingDays: string[];
  jobs: JobPlan[];
  /** Everyone at the bench, by name. */
  jewelers: JewelerLoad[];
  /** Open jobs with planned work but nobody to give it to. */
  unassigned: BenchJob[];
}

const DAY_FORMAT = new Map<string, Intl.DateTimeFormat>();
/** The store's calendar day of a moment. */
function storeDay(iso: string, timeZone: string): string {
  let format = DAY_FORMAT.get(timeZone);
  if (!format) DAY_FORMAT.set(timeZone, (format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })));
  return format.format(new Date(iso));
}
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The store's working days from `today` on: open in its week and not a closed date. A week with no open day counts every day. */
function workingCalendar(today: string, hoursOf: StoreHours): (index: number) => string {
  const openWeekday = (day: string) => (hoursOf.week[new Date(`${day}T00:00:00Z`).getUTCDay()]?.length ?? 0) > 0;
  const anyOpen = [0, 1, 2, 3, 4, 5, 6].some((d) => (hoursOf.week[d]?.length ?? 0) > 0);
  const works = (day: string) => !anyOpen || (openWeekday(day) && !hoursOf.closedDates.includes(day));
  const days: string[] = [];
  let next = today;
  return (index) => {
    while (days.length <= index) {
      if (works(next)) days.push(next);
      next = addDays(next, 1);
    }
    return days[index]!;
  };
}

/**
 * The open work planned against the bench's hours. Each open job in a work
 * stage needs what is left of its current stage's typical bench minutes and
 * the typical minutes of each later stage finished jobs usually went on to.
 * The current stage goes to whoever has the job, a later one to whoever did
 * that stage most in the last PRODUCTION_ACTIVE_DAYS, else whoever has the
 * job. Jobs are taken earliest promise first, each stage starting once the
 * one before ends and its jeweler is free, at their hours a day.
 */
export function benchPlan(jobs: BenchJob[], settings: ProductionSettings, now: string): BenchPlan {
  const store = settings.storeHours ?? STORE_HOURS;
  const today = storeDay(now, store.timeZone);
  const dayAt = workingCalendar(today, store);
  const last = addDays(today, PRODUCTION_PLAN_DAYS - 1);
  const workingDays: string[] = [];
  for (let i = 0; dayAt(i) <= last; i++) workingDays.push(dayAt(i));
  const dateOf = (end: number) => dayAt(Math.max(0, Math.ceil(end - 1e-9) - 1));

  const labor = typicalLabor(jobs);
  const onward = onwardStages(jobs);
  const since = Date.parse(now) - PRODUCTION_ACTIVE_DAYS * DAY_MS;
  const active = new Map<string, string>();
  const doneBy = new Map<BenchStage, Map<string, number>>();
  for (const job of jobs) {
    for (const r of job.records) {
      if (r.jeweler === undefined || Date.parse(r.at) < since) continue;
      active.set(r.jeweler.toLowerCase(), active.get(r.jeweler.toLowerCase()) ?? r.jeweler);
      const by = doneBy.get(r.stage) ?? new Map<string, number>();
      by.set(r.jeweler, (by.get(r.jeweler) ?? 0) + 1);
      doneBy.set(r.stage, by);
    }
  }
  for (const name of Object.keys(settings.dailyHours?.jewelers ?? {})) if (!active.has(name.toLowerCase())) active.set(name.toLowerCase(), name);
  const usual = (stage: BenchStage) => [...(doneBy.get(stage) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const daily = (jeweler: string) => figureFor(settings.dailyHours, jeweler, PRODUCTION_DAILY_HOURS);

  const open = jobs
    .map((job) => ({ job, current: currentStage(job.records) }))
    .filter((o): o is { job: BenchJob; current: NonNullable<ReturnType<typeof currentStage>> } => !o.job.closed && o.current !== undefined && PROJECT_STAGES.includes(o.current.since.stage))
    .sort(
      (a, b) =>
        (a.job.promisedBy ?? "9999-12-31").localeCompare(b.job.promisedBy ?? "9999-12-31") ||
        a.job.records[0]!.at.localeCompare(b.job.records[0]!.at) ||
        a.job.key.localeCompare(b.job.key),
    );

  const free = new Map<string, number>();
  const loads = new Map<string, JewelerLoad>();
  const load = (jeweler: string) => {
    const key = jeweler.toLowerCase();
    let l = loads.get(key);
    if (!l) loads.set(key, (l = { jeweler: active.get(key) ?? jeweler, dailyHours: daily(jeweler), queuedHours: 0, capacityHours: daily(jeweler) * workingDays.length, byStage: new Map(), jobs: [] }));
    return l;
  };
  for (const name of active.values()) load(name);

  const plans: JobPlan[] = [];
  const unassigned: BenchJob[] = [];
  for (const { job, current } of open) {
    const stage = current.since.stage;
    const holder = current.last.jeweler;
    const needs: { stage: BenchStage; minutes: number; jeweler: string | undefined }[] = [];
    const here = labor.get(stage);
    if (here) {
      const spent = job.records.filter((r) => r.stage === stage).reduce((sum, r) => sum + (r.laborMinutes ?? 0), 0);
      needs.push({ stage, minutes: Math.max(0, here.minutes - spent), jeweler: holder ?? usual(stage) });
    }
    for (const later of onward(stage)) {
      const typical = labor.get(later);
      if (typical) needs.push({ stage: later, minutes: typical.minutes, jeweler: usual(later) ?? holder });
    }
    const work = needs.filter((n) => n.minutes > 0);
    if (work.length === 0) continue;
    if (work.some((n) => n.jeweler === undefined)) {
      unassigned.push(job);
      continue;
    }
    let prevEnd = 0;
    let alone = 0;
    const planned: PlannedWork[] = [];
    for (const n of work) {
      const l = load(n.jeweler!);
      const h = n.minutes / 60;
      const key = n.jeweler!.toLowerCase();
      const start = Math.max(free.get(key) ?? 0, prevEnd);
      const end = start + h / l.dailyHours;
      free.set(key, end);
      prevEnd = end;
      alone += h / l.dailyHours;
      l.queuedHours += h;
      l.byStage.set(n.stage, (l.byStage.get(n.stage) ?? 0) + h);
      if (!l.jobs.includes(job)) l.jobs.push(job);
      planned.push({ stage: n.stage, jeweler: l.jeweler, hours: h, start, end });
    }
    plans.push({ job, work: planned, finishDay: dateOf(prevEnd), aloneDay: dateOf(alone) });
  }
  return { workingDays, jobs: plans, jewelers: [...loads.values()].sort((a, b) => a.jeweler.localeCompare(b.jeweler)), unassigned };
}

const overloaded = (l: Pick<JewelerLoad, "queuedHours" | "capacityHours">) => mg(l.queuedHours) > mg(l.capacityHours);
const byStageText = (byStage: Map<BenchStage, number>) =>
  [...byStage.entries()]
    .sort((a, b) => b[1] - a[1] || PROJECT_STAGES.indexOf(a[0]) - PROJECT_STAGES.indexOf(b[0]))
    .map(([stage, h]) => `${STAGE_NAMES[stage]} ${hours(h)}`)
    .join(", ");
const listJobs = (plans: JobPlan[]) => {
  const shown = plans.slice(0, 5).map((p) => `${p.job.label}, due ${p.job.promisedBy}, likely ${p.finishDay}`);
  return `${shown.join("; ")}${plans.length > 5 ? `; and ${plans.length - 5} more` : ""}`;
};

/** Production planning with the instance's own labor rates, daily hours and working days. */
export function productionDepartment(settings: ProductionSettings = {}): DepartmentModule {
  const department = "production";
  return {
    id: department,
    name: "Production Planning",
    purpose: "What each piece costs at the bench, whether the shop is losing more metal than it used to, and whether the work in hand fits the bench's hours before it is promised.",
    events: {},
    normalizers: [],
    extractors: [],
    reasoners: [
      {
        name: "production.labor-cost",
        reason: ({ organizationId, signals, now }) =>
          pieceCosts(benchJobs(signals), signals, settings, now).flatMap((c) => {
            const price = c.job.price;
            if (!price || daysBetween(c.lastLaborAt, now) > PRODUCTION_COST_LOOKBACK_DAYS) return [];
            if (c.costCents <= price.cents * PRODUCTION_COST_SHARE) return [];
            const who = [...c.minutesByJeweler.entries()]
              .sort((a, b) => b[1] - a[1] || Number(a[0] === NO_JEWELER) - Number(b[0] === NO_JEWELER) || a[0].localeCompare(b[0]))
              .map(([name, m]) => `${name === NO_JEWELER ? "no jeweler recorded" : name} ${hours(m / 60)}`)
              .join(", ");
            const metal =
              c.metal?.cents !== undefined ? ` and ${dollars(c.metal.cents)} of metal (${g(c.metal.grams)} ${c.metal.basis === "lost" ? "lost" : "issued"}, at spot)` : "";
            const excess = c.costCents - Math.round(price.cents * PRODUCTION_COST_SHARE);
            return [
              recommend({
                department,
                organizationId,
                now,
                key: `labor_cost_${c.job.key}`,
                summary: `${c.job.label} ${c.finished ? "took" : "has taken"} ${hours(c.laborMinutes / 60)} at the bench (${who}): ${dollars(c.laborCents)} of labor${metal}, ${dollars(c.costCents)} in all, ${pct(c.costCents / price.cents)} of its ${dollars(price.cents)} ${price.source}. ${
                  c.finished ? "Check how this kind of work is quoted before the next one." : "It isn't finished yet: talk to the customer or the jeweler before more time goes in."
                }`,
                confidence: 0.7,
                expectedImpact: "Quotes that cover the bench time the work really takes",
                impact: estimate(
                  "saves",
                  `${dollars(c.costCents)} of labor and metal is ${dollars(excess)} more than ${pct(PRODUCTION_COST_SHARE)} of the ${dollars(price.cents)} ${price.source}; quoting work like it from its bench time keeps that margin.`,
                  () => excess,
                ),
                basedOn: c.basedOn,
              }),
            ];
          }),
      },
      {
        name: "production.loss-trend",
        reason: ({ organizationId, signals, now }) => {
          const prices = spots(signals, now);
          return lossTrends(benchJobs(signals), now).flatMap((t) => {
            if (t.recent.records < PRODUCTION_TREND_MIN_RECORDS || t.baseline.records < PRODUCTION_TREND_MIN_RECORDS) return [];
            const rise = Math.round((rate(t.recent) - rate(t.baseline)) * 1e6) / 1e6;
            if (rise < PRODUCTION_TREND_RISE) return [];
            // The rise in loss rate on each alloy's recent metal, valued at its own spot.
            const byAlloy = new Map<string, { job: BenchJob; grams: number }>();
            for (const { record, job } of t.weighings) {
              if (job.metal === undefined) continue;
              const key = alloyName(job.metal, job.karat);
              byAlloy.set(key, { job, grams: mg((byAlloy.get(key)?.grams ?? 0) + record.metalIn!) });
            }
            let cents = 0;
            let valuedGrams = 0;
            const used: Signal[] = [];
            for (const { job, grams } of byAlloy.values()) {
              const m = melt(job, grams * rise, prices);
              if (!m) continue;
              cents += m.cents;
              valuedGrams = mg(valuedGrams + grams);
              if (!used.includes(m.spot)) used.push(m.spot);
            }
            const unvalued = mg(t.recent.inGrams - valuedGrams);
            const impact =
              valuedGrams > 0
                ? estimate(
                    "protects",
                    `${pct(rise)} more of the ${g(valuedGrams)} issued in the last ${PRODUCTION_TREND_RECENT_DAYS} days lost than over the ${PRODUCTION_TREND_BASELINE_DAYS} days before: ${g(valuedGrams * rise)} of metal at its melt value at the latest spot${unvalued > 0 ? `; ${g(unvalued)} with no karat or recent spot price isn't valued` : ""}.`,
                    () => cents,
                  )
                : undefined;
            // Where the recent loss is: the other grouping's member that lost the most.
            const where = new Map<string, number>();
            for (const { record, job } of t.weighings) {
              const other = t.by === "alloy" ? record.jeweler : job.metal !== undefined ? alloyName(job.metal, job.karat) : undefined;
              if (other !== undefined) where.set(other, mg((where.get(other) ?? 0) + record.metalIn! - record.metalOut!));
            }
            const top = [...where.entries()].filter(([, lost]) => lost > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
            const subject = t.by === "alloy" ? `on ${t.name}` : `at ${t.name}'s bench`;
            const topText = top ? ` Most of it ${t.by === "alloy" ? `at ${top[0]}'s bench` : `on ${top[0]}`} (${g(top[1])}).` : "";
            return [
              recommend({
                department,
                organizationId,
                now,
                key: `loss_trend_${t.by}_${slug(t.name)}`,
                summary: `Metal loss ${subject} is rising: ${pct(rate(t.recent))} of the ${g(t.recent.inGrams)} issued in the last ${PRODUCTION_TREND_RECENT_DAYS} days (${plural(t.recent.records, "weighing")}) didn't come back, up from ${pct(rate(t.baseline))} of ${g(t.baseline.inGrams)} over the ${PRODUCTION_TREND_BASELINE_DAYS} days before.${topText} Check the sweeps, filters and scrap before they go to the refiner.`,
                confidence: 0.7,
                expectedImpact: "Finds a growing metal leak at the bench before more is lost",
                impact,
                basedOn: [...new Set(t.weighings.map((w) => w.record.signal)), ...used],
              }),
            ];
          });
        },
      },
      {
        name: "production.capacity",
        reason: ({ organizationId, signals, now }) => {
          const plan = benchPlan(benchJobs(signals), settings, now);
          // Its own work finishes today or later, so a job whose alone day is by its promise isn't already past it.
          const atRisk = plan.jobs.filter((p) => p.job.promisedBy !== undefined && p.finishDay > p.job.promisedBy && p.aloneDay <= p.job.promisedBy);
          const rateOf = (jeweler: string) => figureFor(settings.laborRateCents, jeweler, PRODUCTION_LABOR_RATE_CENTS);
          const days = `the next ${PRODUCTION_PLAN_DAYS} days (${plural(plan.workingDays.length, "working day")})`;
          const signalsOf = (jobs: BenchJob[]) => [...new Set(jobs.flatMap((j) => [...j.about, ...j.records.map((r) => r.signal)]))];
          const riskText = (risk: JobPlan[]) =>
            risk.length ? ` ${plural(risk.length, "promised job")} ${risk.length === 1 ? "finishes" : "finish"} after ${risk.length === 1 ? "its date" : "their dates"} because of the queue, though ${risk.length === 1 ? "its" : "their"} own work fits: ${listJobs(risk)}.` : "";
          const queued = plan.jewelers.reduce((sum, l) => sum + l.queuedHours, 0);
          const capacity = plan.jewelers.reduce((sum, l) => sum + l.capacityHours, 0);
          if (plan.jewelers.length > 0 && overloaded({ queuedHours: queued, capacityHours: capacity })) {
            const byStage = new Map<BenchStage, number>();
            for (const l of plan.jewelers) for (const [stage, h] of l.byStage) byStage.set(stage, (byStage.get(stage) ?? 0) + h);
            const over = plan.jewelers.filter(overloaded);
            const overCents = Math.round(over.reduce((sum, l) => sum + (l.queuedHours - l.capacityHours) * rateOf(l.jeweler), 0));
            return [
              recommend({
                department,
                organizationId,
                now,
                key: "capacity_shop",
                summary: `The bench has ${hours(queued)} of work queued (${byStageText(byStage)}) against ${hours(capacity)} across ${plural(plan.jewelers.length, "jeweler")} over ${days}, so moving work between benches won't clear it${over.length ? `; most over: ${over.map((l) => `${l.jeweler} ${hours(l.queuedHours - l.capacityHours)}`).join(", ")}` : ""}.${riskText(atRisk)} Book overtime, send work out, or move promise dates now: the ${hours(queued - capacity)} over is about ${dollars(overCents)} of bench time at the jewelers' rates.`,
                confidence: atRisk.length ? 0.7 : 0.6,
                expectedImpact: "Keeps promised dates by acting before the queue makes them late",
                basedOn: signalsOf(plan.jobs.map((p) => p.job)),
              }),
            ];
          }
          return plan.jewelers.filter(overloaded).map((l) => {
            const risk = atRisk.filter((p) => p.work.some((w) => w.jeweler === l.jeweler));
            const spare = plan.jewelers.filter((o) => o !== l && mg(o.capacityHours - o.queuedHours) > 0);
            const overHours = l.queuedHours - l.capacityHours;
            return recommend({
              department,
              organizationId,
              now,
              key: `capacity_${slug(l.jeweler)}`,
              // The bench as a whole has room, or it would have been raised above, so someone has hours free.
              summary: `${l.jeweler} has ${hours(l.queuedHours)} of bench work queued (${byStageText(l.byStage)}) against ${hours(l.capacityHours)} over ${days} at ${hours(l.dailyHours)} a day.${riskText(risk)} Move some to ${spare.map((o) => `${o.jeweler} (${hours(o.capacityHours - o.queuedHours)} free)`).join(", ")}, or book overtime; the ${hours(overHours)} over is about ${dollars(Math.round(overHours * rateOf(l.jeweler)))} of bench time at ${dollars(rateOf(l.jeweler))} an hour.`,
              confidence: risk.length ? 0.7 : 0.6,
              expectedImpact: "Keeps promised dates by acting before the queue makes them late",
              basedOn: signalsOf(l.jobs),
            });
          });
        },
      },
    ],
  };
}

/** Production planning with the default labor rate, daily hours and the default store week. */
export const production: DepartmentModule = productionDepartment();
