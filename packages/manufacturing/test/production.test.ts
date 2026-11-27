import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, type Recommendation } from "@karatos/core";
import { combineDepartments, RETAIL_DEPARTMENTS, storeHours, type DepartmentModule } from "@karatos/retail";
import {
  bench,
  benchJobs,
  benchPlan,
  figureFor,
  lossTrends,
  MANUFACTURING_DEPARTMENTS,
  manufacturingDepartments,
  parseDailyHours,
  parseJewelerFigures,
  parseLaborRates,
  pieceCosts,
  production,
  PRODUCTION_DAILY_HOURS,
  PRODUCTION_LABOR_RATE_CENTS,
  productionDepartment,
  ProductionSettingsError,
  typicalLabor,
  type ProductionSettings,
} from "../src/index.js";

const ORG = "test-org";
// A Friday: with the default Monday-to-Saturday week, the next 7 days hold 6 working days (Oct 2, 3, 5, 6, 7, 8).
const NOW = "2026-10-02T15:00:00.000Z";
const DAY = 86_400_000;
let counter = 0;

/** A workshop with the retail departments, bench jobs and production planning, and helpers to feed it. */
function shop(departments: DepartmentModule[] = [...RETAIL_DEPARTMENTS, bench, production]) {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({
    memory,
    ...combineDepartments(departments),
    reasoningWindow: 5_000,
    documentation: { current: () => ({ documentIds: [], stale: false }) },
    now: () => new Date(NOW),
  });
  const send = (type: string, payload: Record<string, unknown>, occurredAt = "2026-09-01T12:00:00Z") => {
    counter++;
    return pipeline.ingest({ id: `evt_${counter}`, organizationId: ORG, source: "test", type, occurredAt, receivedAt: occurredAt, idempotencyKey: `k_${counter}`, payload });
  };
  return {
    memory,
    send,
    open: (jobId: string, fields: Record<string, unknown> = {}, at = "2026-09-01T12:00:00Z") => send("bench_job.opened", { jobId, ...fields }, at),
    stage: (jobId: string, stage: string, at: string, extra: Record<string, unknown> = {}) => send("bench_job.stage_recorded", { jobId, stage, ...extra }, at),
    spot: (metal: string, cents: number, at = "2026-10-01T12:00:00Z") => send("metal.price_updated", { metal, spotPerTroyOunceCents: cents }, at),
    repair: (ticketId: string, estimateCents: number, promisedBy = "2026-10-20") =>
      send("repair.received", { ticketId, customerId: "c-1", itemDescription: "Ring", work: "Sizing", promisedBy, estimateCents }),
    order: (orderId: string, quotedCents: number, dueBy = "2026-10-30") => send("custom_order.created", { orderId, customerId: "c-1", description: "Pendant", quotedCents, dueBy }),
    signals: () => memory.recentSignals(ORG, 5_000),
    async jobs() {
      return benchJobs(await memory.recentSignals(ORG, 5_000));
    },
    /** Production planning's recommendations whose key starts with one of `prefixes`, with the key each id carries. */
    async recs(...prefixes: string[]): Promise<(Recommendation & { key: string })[]> {
      const all = await pipeline.reason(ORG);
      return all
        .filter((r) => r.id.startsWith("rec_production_"))
        .map((r) => ({ ...r, key: r.id.slice("rec_production_".length, -"_2026-10-02".length) }))
        .filter((r) => prefixes.length === 0 || prefixes.some((p) => r.key.startsWith(p)));
    },
  };
}
type Shop = ReturnType<typeof shop>;

const keys = (recs: { key: string }[]) => recs.map((r) => r.key).sort();
const only = (recs: (Recommendation & { key: string })[], key: string) => {
  const found = recs.filter((r) => r.key === key);
  expect(found, key).toHaveLength(1);
  return found[0]!;
};
const daysAgo = (days: number, hour = 12) => new Date(Date.parse(`${NOW.slice(0, 10)}T${String(hour).padStart(2, "0")}:00:00Z`) - days * DAY).toISOString();

describe("the production department", () => {
  it("is manufacturing's second department, owns no events and reads bench's", async () => {
    expect(MANUFACTURING_DEPARTMENTS.map((d) => d.id)).toEqual(["bench", "production"]);
    expect(production.id).toBe("production");
    expect(production.name).toBe("Production Planning");
    expect(production.events).toEqual({});
    expect(production.normalizers).toEqual([]);
    expect(production.extractors).toEqual([]);
    expect(production.reasoners.map((r) => r.name)).toEqual(["production.labor-cost", "production.loss-trend", "production.capacity"]);
    expect(() => combineDepartments([...RETAIL_DEPARTMENTS, ...MANUFACTURING_DEPARTMENTS])).not.toThrow();
  });

  it("builds both departments with the instance's settings, each from its own", () => {
    expect(manufacturingDepartments()).toBe(MANUFACTURING_DEPARTMENTS);
    const withProduction = manufacturingDepartments({ production: { dailyHours: { all: 4 } } });
    expect(withProduction.map((d) => d.id)).toEqual(["bench", "production"]);
    expect(withProduction[0]).toBe(bench);
    expect(withProduction[1]).not.toBe(production);
    const withBench = manufacturingDepartments({ bench: { metalLossShare: 0.05 } });
    expect(withBench[0]).not.toBe(bench);
    expect(withBench[1]).toBe(production);
  });

  it("keeps the bench minutes on a stage record, and dead-letters minutes that aren't a positive number", async () => {
    const s = shop();
    const { signals } = await s.stage("J-1", "setting", daysAgo(2), { jeweler: "Ana", laborMinutes: 45.5 });
    expect(signals[0]!.value).toMatchObject({ laborMinutes: 45.5 });
    expect((await s.jobs())[0]!.records[0]!.laborMinutes).toBe(45.5);
    for (const bad of [0, -5, 10_001, "30"]) await expect(s.stage("J-2", "setting", daysAgo(1), { laborMinutes: bad }), String(bad)).rejects.toThrow(/dead-lettered/);
    expect(s.memory.deadLetters.map((d) => d.issues.map((i) => String(i.path)))).toEqual([["payload.laborMinutes"], ["payload.laborMinutes"], ["payload.laborMinutes"], ["payload.laborMinutes"]]);
    await expect(s.stage("J-3", "setting", daysAgo(1), { laborMinutes: 10_000 })).resolves.toBeDefined();
  });

  it("takes a job's price from its custom order's quote, else its repair's estimate", async () => {
    const s = shop();
    await s.repair("R-1", 12_000);
    await s.order("C-1", 300_000);
    await s.open("BOTH", { repairTicketId: "R-1", customOrderId: "C-1" });
    await s.open("REPAIR", { repairTicketId: "R-1" });
    await s.open("NONE", {});
    await s.send("custom_order.stage_changed", { orderId: "C-2", stage: "casting" });
    await s.order("C-2", 50_000);
    const jobs = await s.jobs();
    const price = (id: string) => jobs.find((j) => j.jobId === id)!.price;
    expect(price("BOTH")).toEqual({ cents: 300_000, source: "custom order quote" });
    expect(price("REPAIR")).toEqual({ cents: 12_000, source: "repair estimate" });
    expect(price("NONE")).toBeUndefined();
    expect(price("C-2")).toEqual({ cents: 50_000, source: "custom order quote" });
    expect(jobs.find((j) => j.jobId === "REPAIR")!.forRepair).toBe(true);
    expect(jobs.find((j) => j.jobId === "BOTH")!.forRepair).toBe(true);
    expect(jobs.find((j) => j.jobId === "NONE")!.forRepair).toBe(false);
    expect(jobs.find((j) => j.jobId === "C-2")!.forRepair).toBe(false);
  });
});

describe("pieceCosts and production.labor-cost", () => {
  /** A repair sized by Ana and polished by Ben: 90 and 30 bench minutes, 0.20 g of 14K gold lost. */
  async function sizing(s: Shop, estimateCents = 12_000) {
    await s.spot("gold", 200_000);
    await s.repair("R-1", estimateCents);
    await s.open("J-1", { description: "Ring sizing", repairTicketId: "R-1", metal: "gold", karat: 14 });
    await s.stage("J-1", "setting", daysAgo(4), { jeweler: "Ana", laborMinutes: 90, metalInGrams: 5, metalOutGrams: 4.8 });
    await s.stage("J-1", "finishing", daysAgo(3), { jeweler: "Ben", laborMinutes: 30 });
    await s.stage("J-1", "ready", daysAgo(2));
  }

  it("raises a finished piece whose labor and metal eat into its price, with what quoting it right keeps", async () => {
    const s = shop();
    await sizing(s);
    const [cost] = pieceCosts(await s.jobs(), await s.signals(), {}, NOW);
    expect(cost).toMatchObject({ finished: true, laborMinutes: 120, laborCents: 9_000, metal: { grams: 0.2, basis: "lost", cents: 750 }, costCents: 9_750 });
    expect([...cost!.minutesByJeweler]).toEqual([
      ["Ana", 90],
      ["Ben", 30],
    ]);
    const rec = only(await s.recs("labor_cost"), "labor_cost_J-1");
    // $67.50 + $22.50 of labor; 0.20 g x 14/24 / 31.1035 x $2,000 of gold.
    expect(rec.summary).toBe(
      "Bench job J-1 (Ring sizing) took 2 h at the bench (Ana 1.5 h, Ben 0.5 h): $90.00 of labor and $7.50 of metal (0.20 g lost, at spot), $97.50 in all, 81.3% of its $120.00 repair estimate. Check how this kind of work is quoted before the next one.",
    );
    expect(rec.impact).toEqual({
      kind: "saves",
      cents: 2_550,
      lowCents: 2_550,
      highCents: 2_550,
      basis: "$97.50 of labor and metal is $25.50 more than 60% of the $120.00 repair estimate; quoting work like it from its bench time keeps that margin.",
    });
    expect(rec.confidence).toBe(0.7);
    expect(rec.expectedImpact).toBe("Quotes that cover the bench time the work really takes");
    // The job, ticket, its three records' two with minutes or weights, and the spot price.
    expect(rec.provenance.signalIds.filter((id) => id.startsWith("sig_bench.stage_"))).toHaveLength(2);
    expect(rec.provenance.signalIds.some((id) => id.startsWith("sig_metal.price_"))).toBe(true);
    expect(rec.provenance.signalIds.some((id) => id.startsWith("sig_repair.ticket_"))).toBe(true);
    expect(rec.provenance.signalIds.some((id) => id.startsWith("sig_bench.job_"))).toBe(true);
  });

  it("leaves a piece at 60% of its price alone and raises one a minute over", async () => {
    const s = shop();
    for (const [id, minutes] of [
      ["AT", 120],
      ["OVER", 121],
    ] as const) {
      await s.repair(`R-${id}`, 15_000);
      await s.open(id, { repairTicketId: `R-${id}` });
      await s.stage(id, "setting", daysAgo(3), { jeweler: "Ana", laborMinutes: minutes });
    }
    expect(keys(await s.recs("labor_cost"))).toEqual(["labor_cost_OVER"]);
  });

  it("says when the piece isn't finished yet, and names minutes recorded without a jeweler", async () => {
    const s = shop();
    await s.order("C-1", 10_000);
    await s.open("J-2", { customOrderId: "C-1" });
    await s.stage("J-2", "design", daysAgo(5), { laborMinutes: 60 });
    await s.stage("J-2", "casting", daysAgo(4), { jeweler: "Cy", laborMinutes: 30 });
    await s.stage("J-2", "casting", daysAgo(3), { jeweler: "Cy", laborMinutes: 30 });
    const rec = only(await s.recs("labor_cost"), "labor_cost_J-2");
    expect(rec.summary).toBe(
      "Bench job J-2 (Pendant) has taken 2 h at the bench (Cy 1 h, no jeweler recorded 1 h): $90.00 of labor, $90.00 in all, 90% of its $100.00 custom order quote. It isn't finished yet: talk to the customer or the jeweler before more time goes in.",
    );
  });

  it("prices each record at its jeweler's own rate, matching names whatever their case", async () => {
    const s = shop();
    await sizing(s);
    const settings: ProductionSettings = { laborRateCents: { all: 4_000, jewelers: { ana: 6_000 } } };
    const [cost] = pieceCosts(await s.jobs(), await s.signals(), settings, NOW);
    // 1.5 h at $60 and 0.5 h at $40.
    expect(cost!.laborCents).toBe(11_000);
    const custom = shop([...RETAIL_DEPARTMENTS, bench, productionDepartment(settings)]);
    await sizing(custom);
    expect(only(await custom.recs("labor_cost"), "labor_cost_J-1").summary).toContain("$110.00 of labor and $7.50 of metal");
  });

  it("counts the metal issued for a piece the shop owns, and none it can't value", async () => {
    const s = shop();
    await s.spot("silver", 3_110);
    await s.order("C-1", 18_000);
    await s.open("AG", { customOrderId: "C-1", metal: "silver" });
    await s.stage("AG", "casting", daysAgo(4), { jeweler: "Cy", laborMinutes: 60, metalInGrams: 50, metalOutGrams: 48 });
    await s.stage("AG", "finishing", daysAgo(3), { jeweler: "Cy", laborMinutes: 30, metalInGrams: 48, metalOutGrams: 47.5 });
    await s.open("NO-SPOT", { metal: "platinum" });
    await s.stage("NO-SPOT", "casting", daysAgo(4), { laborMinutes: 60, metalInGrams: 10 });
    await s.open("GAINED", { repairTicketId: "R-9", metal: "silver" });
    await s.stage("GAINED", "setting", daysAgo(4), { laborMinutes: 10, metalInGrams: 5, metalOutGrams: 5.5 });
    await s.open("EVEN", { repairTicketId: "R-8", metal: "silver" });
    await s.stage("EVEN", "setting", daysAgo(4), { laborMinutes: 10, metalInGrams: 5, metalOutGrams: 5 });
    // Metal issued with no labor and no weight back still counts toward what the piece took.
    await s.stage("AG", "design", daysAgo(5), { metalInGrams: 20 });
    const costs = pieceCosts(await s.jobs(), await s.signals(), {}, NOW);
    const of = (id: string) => costs.find((c) => c.job.jobId === id)!;
    // 50 g of silver: 50 x 0.925 / 31.1035 x $31.10, and 1.5 h at $45.
    expect(of("AG")).toMatchObject({ metal: { grams: 50, basis: "issued", cents: 4_624 }, laborCents: 6_750, costCents: 11_374 });
    expect(of("NO-SPOT").metal).toEqual({ grams: 10, basis: "issued" });
    expect(of("NO-SPOT").costCents).toBe(4_500);
    expect(of("GAINED").metal).toBeUndefined();
    expect(of("GAINED").costCents).toBe(750);
    expect(of("GAINED").basedOn.some((x) => x.kind === "metal.price")).toBe(false);
    expect(of("EVEN").metal).toBeUndefined();
    expect(of("AG").basedOn.filter((x) => x.kind === "bench.stage")).toHaveLength(3);
    expect(only(await s.recs("labor_cost"), "labor_cost_AG").summary).toContain("$67.50 of labor and $46.24 of metal (50.00 g issued, at spot), $113.74 in all, 63.2% of");
  });

  it("raises nothing without a price, bench minutes, or bench time in the last 30 days", async () => {
    const s = shop();
    await s.open("NO-PRICE");
    await s.stage("NO-PRICE", "setting", daysAgo(2), { laborMinutes: 600 });
    await s.repair("R-1", 1_000);
    await s.open("NO-MINUTES", { repairTicketId: "R-1" });
    await s.stage("NO-MINUTES", "setting", daysAgo(2), { metalInGrams: 5, metalOutGrams: 4 });
    for (const [id, days] of [
      ["OLD", 31],
      ["EDGE", 30],
    ] as const) {
      await s.repair(`R-${id}`, 1_000);
      await s.open(id, { repairTicketId: `R-${id}` });
      await s.stage(id, "setting", daysAgo(days, 15), { laborMinutes: 600 });
    }
    expect(keys(await s.recs("labor_cost"))).toEqual(["labor_cost_EDGE"]);
    const costs = pieceCosts(await s.jobs(), await s.signals(), {}, NOW);
    expect(costs.map((c) => c.job.jobId).sort()).toEqual(["EDGE", "NO-PRICE", "OLD"]);
    expect(costs.find((c) => c.job.jobId === "NO-PRICE")).toMatchObject({ finished: false, laborCents: 45_000, costCents: 45_000 });
  });

  it("rounds labor to the cent, and checks a piece by its latest bench time", async () => {
    const s = shop([...RETAIL_DEPARTMENTS, bench, productionDepartment({ laborRateCents: { all: 4_550 } })]);
    await s.repair("R-1", 800);
    await s.open("J-1", { repairTicketId: "R-1" });
    await s.stage("J-1", "casting", daysAgo(40), { laborMinutes: 3 });
    await s.stage("J-1", "setting", daysAgo(2), { laborMinutes: 4 });
    // 7 minutes at $45.50 is 530.83 cents.
    expect(pieceCosts(await s.jobs(), await s.signals(), { laborRateCents: { all: 4_550 } }, NOW)[0]!.laborCents).toBe(531);
    expect(keys(await s.recs("labor_cost"))).toEqual(["labor_cost_J-1"]);
  });

  it("values metal at the latest spot from the last 30 days, and gold only with its karat", async () => {
    const s = shop();
    await s.spot("gold", 300_000, "2026-09-30T12:00:00Z");
    await s.spot("gold", 200_000, "2026-09-20T12:00:00Z");
    await s.spot("silver", 3_110, "2026-09-01T12:00:00Z");
    await s.open("AU", { metal: "gold", karat: 24 });
    await s.stage("AU", "casting", daysAgo(2), { laborMinutes: 1, metalInGrams: 31.1035 });
    await s.open("NO-KARAT", { metal: "gold" });
    await s.stage("NO-KARAT", "casting", daysAgo(2), { laborMinutes: 1, metalInGrams: 31.1035 });
    await s.open("OLD-SPOT", { metal: "silver" });
    await s.stage("OLD-SPOT", "casting", daysAgo(2), { laborMinutes: 1, metalInGrams: 31.1035 });
    const costs = pieceCosts(await s.jobs(), await s.signals(), {}, NOW);
    const of = (id: string) => costs.find((c) => c.job.jobId === id)!;
    expect(of("AU").metal).toEqual({ grams: 31.1035, basis: "issued", cents: 300_000 });
    // In whatever order the signals come.
    for (const order of [await s.signals(), [...(await s.signals())].reverse()]) {
      expect(pieceCosts(await s.jobs(), order, {}, NOW).find((c) => c.job.jobId === "AU")!.metal!.cents).toBe(300_000);
    }
    expect(of("NO-KARAT").metal).toEqual({ grams: 31.1035, basis: "issued" });
    expect(of("OLD-SPOT").metal).toEqual({ grams: 31.1035, basis: "issued" });
  });

  it("uses the default rate of $45 an hour", () => {
    expect(PRODUCTION_LABOR_RATE_CENTS).toBe(4_500);
    expect(PRODUCTION_DAILY_HOURS).toBe(6);
  });
});

describe("lossTrends and production.loss-trend", () => {
  /** `count` weighings of `grams` in and `out` back, a day apart from `from` days ago. */
  async function weighings(s: Shop, jobId: string, opened: Record<string, unknown>, from: number, count: number, grams: number, out: number, jeweler?: string) {
    await s.open(jobId, opened);
    for (let i = 0; i < count; i++) {
      await s.stage(jobId, i % 2 ? "finishing" : "casting", daysAgo(from - i), { metalInGrams: grams, metalOutGrams: out, ...(jeweler ? { jeweler } : {}) });
    }
  }

  it("raises an alloy and a jeweler whose loss rate is rising, valued at melt", async () => {
    const s = shop();
    await s.spot("gold", 200_000);
    // 1% lost over the 90 days before, 3% in the last 30.
    await weighings(s, "OLD", { metal: "gold", karat: 14 }, 80, 5, 10, 9.9, "Ana");
    await weighings(s, "NEW", { metal: "gold", karat: 14 }, 20, 5, 10, 9.7, "Ana");
    const recs = await s.recs("loss_trend");
    expect(keys(recs)).toEqual(["loss_trend_alloy_14k-gold", "loss_trend_jeweler_ana"]);
    const alloy = only(recs, "loss_trend_alloy_14k-gold");
    expect(alloy.summary).toBe(
      "Metal loss on 14K gold is rising: 3% of the 50.00 g issued in the last 30 days (5 weighings) didn't come back, up from 1% of 50.00 g over the 90 days before. Most of it at Ana's bench (1.50 g). Check the sweeps, filters and scrap before they go to the refiner.",
    );
    // 2 points more of 50 g: 1 g of 14K gold, x 14/24 / 31.1035 x $2,000.
    expect(alloy.impact).toEqual({
      kind: "protects",
      cents: 3_751,
      lowCents: 3_751,
      highCents: 3_751,
      basis: "2% more of the 50.00 g issued in the last 30 days lost than over the 90 days before: 1.00 g of metal at its melt value at the latest spot.",
    });
    expect(alloy.confidence).toBe(0.7);
    expect(alloy.provenance.signalIds.filter((id) => id.startsWith("sig_bench.stage_"))).toHaveLength(5);
    expect(alloy.provenance.signalIds.filter((id) => id.startsWith("sig_metal.price_"))).toHaveLength(1);
    expect(only(recs, "loss_trend_jeweler_ana").summary).toBe(
      "Metal loss at Ana's bench is rising: 3% of the 50.00 g issued in the last 30 days (5 weighings) didn't come back, up from 1% of 50.00 g over the 90 days before. Most of it on 14K gold (1.50 g). Check the sweeps, filters and scrap before they go to the refiner.",
    );
  });

  it("needs a rise of a full point and five weighings in each window", async () => {
    const point = shop();
    await weighings(point, "OLD", { metal: "silver" }, 80, 5, 100, 99);
    await weighings(point, "NEW", { metal: "silver" }, 20, 5, 100, 98);
    expect(keys(await point.recs("loss_trend"))).toEqual(["loss_trend_alloy_silver"]);
    const under = shop();
    await weighings(under, "OLD", { metal: "silver" }, 80, 5, 100, 99);
    await weighings(under, "NEW", { metal: "silver" }, 20, 5, 100, 98.01);
    expect(await under.recs("loss_trend")).toEqual([]);
    const fewRecent = shop();
    await weighings(fewRecent, "OLD", { metal: "silver" }, 80, 5, 100, 99);
    await weighings(fewRecent, "NEW", { metal: "silver" }, 20, 4, 100, 90);
    expect(await fewRecent.recs("loss_trend")).toEqual([]);
    const fewBefore = shop();
    await weighings(fewBefore, "OLD", { metal: "silver" }, 80, 4, 100, 99);
    await weighings(fewBefore, "NEW", { metal: "silver" }, 20, 5, 100, 90);
    expect(await fewBefore.recs("loss_trend")).toEqual([]);
  });

  it("splits the windows at 30 days and stops 120 days back", async () => {
    const s = shop();
    const jobs = async () => lossTrends(await s.jobs(), NOW);
    await s.open("J", { metal: "silver" });
    // Exactly 30 days back is in the window before; just after it is recent; exactly 120 back is out.
    await s.stage("J", "casting", daysAgo(30, 15), { metalInGrams: 10, metalOutGrams: 9 });
    await s.stage("J", "casting", daysAgo(30, 16), { metalInGrams: 20, metalOutGrams: 19 });
    await s.stage("J", "casting", daysAgo(120, 15), { metalInGrams: 40, metalOutGrams: 39 });
    await s.stage("J", "casting", daysAgo(120, 16), { metalInGrams: 80, metalOutGrams: 79 });
    const [trend] = await jobs();
    expect(trend).toMatchObject({ by: "alloy", name: "silver", recent: { records: 1, inGrams: 20, lostGrams: 1 }, baseline: { records: 2, inGrams: 90, lostGrams: 2 } });
    expect(trend!.weighings).toHaveLength(1);
  });

  it("counts a gain against a loss, leaves records without both weights out, and groups by metal and karat", async () => {
    const s = shop();
    await s.open("A", { metal: "gold", karat: 18 });
    await s.open("B", { metal: "gold", karat: 14 });
    await s.open("C", { metal: "gold" });
    await s.open("D");
    await s.stage("A", "casting", daysAgo(5), { metalInGrams: 10, metalOutGrams: 9, jeweler: "ana" });
    await s.stage("A", "setting", daysAgo(4), { metalInGrams: 9, metalOutGrams: 9.5, jeweler: "Ana" });
    await s.stage("A", "finishing", daysAgo(3), { metalInGrams: 9 });
    await s.stage("B", "casting", daysAgo(5), { metalInGrams: 10, metalOutGrams: 9.8 });
    await s.stage("C", "casting", daysAgo(5), { metalInGrams: 10, metalOutGrams: 9.8 });
    await s.stage("D", "casting", daysAgo(5), { metalInGrams: 10, metalOutGrams: 9.8, jeweler: "Ben" });
    const trends = lossTrends(await s.jobs(), NOW);
    expect(trends.map((t) => [t.by, t.name, t.recent.records, t.recent.inGrams, t.recent.lostGrams])).toEqual([
      ["alloy", "14K gold", 1, 10, 0.2],
      ["alloy", "18K gold", 2, 19, 0.5],
      ["alloy", "gold of no recorded karat", 1, 10, 0.2],
      ["jeweler", "ana", 2, 19, 0.5],
      ["jeweler", "Ben", 1, 10, 0.2],
    ]);
  });

  it("values each alloy at its own spot and says how much it couldn't value", async () => {
    const s = shop();
    await s.spot("gold", 200_000);
    await weighings(s, "OLD-G", { metal: "gold", karat: 14 }, 80, 5, 10, 9.9, "Ana");
    await weighings(s, "OLD-P", { metal: "platinum" }, 70, 5, 10, 9.9, "Ana");
    await weighings(s, "NEW-G", { metal: "gold", karat: 14 }, 20, 3, 10, 9.7, "Ana");
    await weighings(s, "NEW-P", { metal: "platinum" }, 10, 3, 10, 9.7, "Ana");
    await weighings(s, "NEW-X", {}, 5, 2, 10, 9.7, "Ana");
    const rec = only(await s.recs("loss_trend_jeweler"), "loss_trend_jeweler_ana");
    // Only the 30 g of 14K gold has a spot price: 2 points of it is 0.60 g.
    expect(rec.impact).toMatchObject({
      cents: 2_251,
      basis: "2% more of the 30.00 g issued in the last 30 days lost than over the 90 days before: 0.60 g of metal at its melt value at the latest spot; 50.00 g with no karat or recent spot price isn't valued.",
    });
    expect(rec.summary).toContain("Most of it on 14K gold (0.90 g).");
    const unpriced = shop();
    await weighings(unpriced, "OLD", { metal: "palladium" }, 80, 5, 10, 9.9, "Ana");
    await weighings(unpriced, "NEW", { metal: "palladium" }, 20, 5, 10, 9.7, "Ana");
    const recs = await unpriced.recs("loss_trend");
    expect(keys(recs)).toEqual(["loss_trend_alloy_palladium", "loss_trend_jeweler_ana"]);
    for (const r of recs) expect(r.impact, r.key).toBeUndefined();
    expect(only(recs, "loss_trend_alloy_palladium").provenance.signalIds.some((id) => id.startsWith("sig_metal.price_"))).toBe(false);
  });

  it("names nowhere when nothing recent was lost in the other grouping", async () => {
    const s = shop();
    await weighings(s, "OLD", {}, 80, 5, 10, 9.9, "Ana");
    await weighings(s, "NEW", {}, 20, 5, 10, 9.7, "Ana");
    const rec = only(await s.recs("loss_trend"), "loss_trend_jeweler_ana");
    expect(rec.summary).toContain("over the 90 days before. Check the sweeps");
    // The loss is in work with no jeweler; the one jeweler recorded gained weight.
    const gained = shop();
    await weighings(gained, "OLD", { metal: "silver" }, 80, 5, 10, 9.9);
    await weighings(gained, "NEW", { metal: "silver" }, 20, 5, 10, 9.6);
    await gained.stage("NEW", "setting", daysAgo(3), { metalInGrams: 5, metalOutGrams: 5.1, jeweler: "Ben" });
    expect(only(await gained.recs("loss_trend"), "loss_trend_alloy_silver").summary).toContain("over the 90 days before. Check the sweeps");
  });

  it("cites a metal's spot price once however many of its alloys are valued", async () => {
    const s = shop();
    await s.spot("gold", 200_000);
    await weighings(s, "OLD", { metal: "gold", karat: 14 }, 80, 5, 10, 9.9, "Ana");
    await weighings(s, "NEW-14", { metal: "gold", karat: 14 }, 20, 3, 10, 9.7, "Ana");
    await weighings(s, "NEW-18", { metal: "gold", karat: 18 }, 10, 2, 10, 9.7, "Ana");
    const rec = only(await s.recs("loss_trend_jeweler"), "loss_trend_jeweler_ana");
    expect(rec.provenance.signalIds.filter((id) => id.startsWith("sig_metal.price_"))).toHaveLength(1);
  });
});

describe("benchPlan and production.capacity", () => {
  /** Three finished jobs: Cy casts in 60 minutes, Ana sets in 240, Ben finishes in 120. */
  async function history(s: Shop, extra: Record<string, unknown>[] = []) {
    for (let i = 0; i < 3; i++) {
      const id = `H-${i + 1}`;
      await s.stage(id, "casting", daysAgo(20 - i, 9), { jeweler: "Cy", laborMinutes: 60 });
      await s.stage(id, "setting", daysAgo(19 - i, 9), { jeweler: "Ana", laborMinutes: 240, ...extra[i] });
      await s.stage(id, "finishing", daysAgo(18 - i, 9), { jeweler: "Ben", laborMinutes: 120 });
      await s.stage(id, "ready", daysAgo(17 - i, 9));
    }
  }
  /** `count` open jobs in setting with Ana, promised on `due`, or a day apart from Oct 20. */
  async function queue(s: Shop, count: number, due?: string, extra: Record<string, unknown> = {}) {
    for (let i = 0; i < count; i++) {
      const id = `Q-${String(i + 1).padStart(2, "0")}`;
      await s.open(id, { promisedBy: due ?? new Date(Date.parse("2026-10-20T00:00:00Z") + i * DAY).toISOString().slice(0, 10) });
      await s.stage(id, "setting", daysAgo(1, 9 + (i % 10)), { jeweler: "Ana", ...extra });
    }
  }

  it("learns each stage's bench minutes and who does it from finished jobs", async () => {
    const s = shop();
    await history(s, [{ laborMinutes: 200 }, {}, { laborMinutes: 300 }]);
    // Two records of finishing on one job add up.
    await s.stage("H-1", "finishing", daysAgo(18, 10), { jeweler: "Ben", laborMinutes: 30 });
    await s.stage("H-2", "finishing", daysAgo(17, 10), { jeweler: "Ben", laborMinutes: 30 });
    const labor = typicalLabor(await s.jobs());
    expect(Object.fromEntries(labor)).toEqual({ casting: { minutes: 60, jobs: 3 }, setting: { minutes: 240, jobs: 3 }, finishing: { minutes: 150, jobs: 3 } });
    // Fewer than three finished jobs with minutes in a stage: no typical time.
    const few = shop();
    await few.stage("F-1", "qc", daysAgo(3), { laborMinutes: 15 });
    await few.stage("F-1", "ready", daysAgo(2));
    await few.stage("F-2", "qc", daysAgo(3), { laborMinutes: 15 });
    await few.stage("F-2", "ready", daysAgo(2));
    await few.stage("OPEN", "qc", daysAgo(3), { laborMinutes: 15 });
    expect(typicalLabor(await few.jobs()).size).toBe(0);
  });

  it("plans each open job's remaining stages earliest promise first, on its jewelers' hours", async () => {
    const s = shop();
    await history(s);
    await queue(s, 10, "2026-10-07");
    const plan = benchPlan(await s.jobs(), {}, NOW);
    expect(plan.workingDays).toEqual(["2026-10-02", "2026-10-03", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
    expect(plan.jewelers.map((l) => [l.jeweler, l.queuedHours, l.capacityHours])).toEqual([
      ["Ana", 40, 36],
      ["Ben", 20, 36],
      ["Cy", 0, 36],
    ]);
    expect(Object.fromEntries(plan.jewelers[0]!.byStage)).toEqual({ setting: 40 });
    const first = plan.jobs[0]!;
    expect(first.job.jobId).toBe("Q-01");
    expect(first.work).toEqual([
      { stage: "setting", jeweler: "Ana", hours: 4, start: 0, end: 4 / 6 },
      { stage: "finishing", jeweler: "Ben", hours: 2, start: 4 / 6, end: 1 },
    ]);
    expect([first.finishDay, first.aloneDay]).toEqual(["2026-10-02", "2026-10-02"]);
    // The tenth waits behind 36 hours of Ana's setting: done at 6 2/3 working days, finished by Ben at 7.
    const last = plan.jobs[9]!;
    expect(last.job.jobId).toBe("Q-10");
    expect(last.work[1]!.end).toBeCloseTo(7, 9);
    expect([last.finishDay, last.aloneDay]).toEqual(["2026-10-09", "2026-10-02"]);
    expect(plan.unassigned).toEqual([]);
  });

  it("raises a jeweler with more queued than their hours, naming the promises it pushes late and who has room", async () => {
    const s = shop();
    await history(s);
    await queue(s, 10, "2026-10-07");
    const rec = only(await s.recs("capacity"), "capacity_ana");
    // All ten are due Oct 7: the first seven finish by then, the last three behind Ana's queue.
    expect(rec.summary).toBe(
      "Ana has 40 h of bench work queued (stone setting 40 h) against 36 h over the next 7 days (6 working days) at 6 h a day. 3 promised jobs finish after their dates because of the queue, though their own work fits: Bench job Q-08, due 2026-10-07, likely 2026-10-08; Bench job Q-09, due 2026-10-07, likely 2026-10-09; Bench job Q-10, due 2026-10-07, likely 2026-10-09. Move some to Ben (16 h free), Cy (36 h free), or book overtime; the 4 h over is about $180.00 of bench time at $45.00 an hour.",
    );
    expect(rec.confidence).toBe(0.7);
    expect(rec.impact).toBeUndefined();
    expect(rec.expectedImpact).toBe("Keeps promised dates by acting before the queue makes them late");
    expect(rec.provenance.signalIds).toHaveLength(20);
    expect(keys(await s.recs("capacity"))).toEqual(["capacity_ana"]);
    // Promised well ahead: still over, with nothing at risk.
    const ahead = shop();
    await history(ahead);
    await queue(ahead, 10);
    const calm = only(await ahead.recs("capacity"), "capacity_ana");
    expect(calm.confidence).toBe(0.6);
    expect(calm.summary).toContain("at 6 h a day. Move some to Ben (16 h free)");
  });

  it("names only the promises a jeweler's own queue pushes late, and only jewelers with hours free", async () => {
    const s = shop([...RETAIL_DEPARTMENTS, bench, productionDepartment({ dailyHours: { jewelers: { Ben: 5 } } })]);
    await history(s);
    await queue(s, 10);
    // Four late pieces and one due today waiting on Ben's polishing: 10 h, filling his 30 h exactly with the 20 h from Ana's.
    for (const id of ["L-1", "L-2", "L-3", "L-4"]) {
      await s.open(id, { promisedBy: "2026-10-01" });
      await s.stage(id, "finishing", daysAgo(2), { jeweler: "Ben" });
    }
    await s.open("F", { promisedBy: "2026-10-02" });
    await s.stage("F", "finishing", daysAgo(2), { jeweler: "Ben" });
    const plan = benchPlan(await s.jobs(), { dailyHours: { jewelers: { Ben: 5 } } }, NOW);
    const f = plan.jobs.find((p) => p.job.jobId === "F")!;
    expect([f.finishDay, f.aloneDay]).toEqual(["2026-10-03", "2026-10-02"]);
    expect(plan.jewelers.find((l) => l.jeweler === "Ben")).toMatchObject({ queuedHours: 30, capacityHours: 30 });
    expect(keys(await s.recs("capacity"))).toEqual(["capacity_ana"]);
    const rec = only(await s.recs("capacity"), "capacity_ana");
    expect(rec.summary).toContain("at 6 h a day. Move some to Cy (36 h free), or book overtime;");
  });

  it("lists five jobs at risk and counts the rest", async () => {
    const s = shop([...RETAIL_DEPARTMENTS, bench, productionDepartment({ dailyHours: { jewelers: { Ana: 2 } } })]);
    await history(s);
    await queue(s, 9, "2026-10-08");
    const rec = only(await s.recs("capacity"), "capacity_ana");
    expect(rec.summary).toContain("7 promised jobs finish after their dates");
    expect(rec.summary).toContain("Bench job Q-07, due 2026-10-08, likely 2026-10-19; and 2 more.");
  });

  it("leaves a jeweler whose queue fills their hours exactly, and counts minutes already spent", async () => {
    const s = shop();
    await history(s);
    await queue(s, 9);
    expect(await s.recs("capacity")).toEqual([]);
    const spent = shop();
    await history(spent);
    // Ten jobs with an hour already worked: 30 hours left.
    await queue(spent, 10, undefined, { laborMinutes: 60 });
    const plan = benchPlan(await spent.jobs(), {}, NOW);
    expect(plan.jewelers[0]!.queuedHours).toBe(30);
    expect(await spent.recs("capacity")).toEqual([]);
    // Past the typical time already: nothing left of the stage, only what follows.
    const over = shop();
    await history(over);
    await queue(over, 1, undefined, { laborMinutes: 300 });
    const overPlan = benchPlan(await over.jobs(), {}, NOW);
    expect(overPlan.jobs[0]!.work.map((w) => [w.stage, w.jeweler, w.hours])).toEqual([["finishing", "Ben", 2]]);
  });

  it("raises the whole bench when everyone together is over, instead of each jeweler", async () => {
    const s = shop([...RETAIL_DEPARTMENTS, bench, productionDepartment({ dailyHours: { all: 3, jewelers: { Cy: 1 } }, laborRateCents: { jewelers: { Ana: 6_000 } } })]);
    await history(s);
    await queue(s, 10);
    await s.stage("CAST", "casting", daysAgo(1));
    const recs = await s.recs("capacity");
    expect(keys(recs)).toEqual(["capacity_shop"]);
    // Ana 44 h against 18, Ben 22 against 18, Cy 1 against 6: 67 against 42.
    expect(recs[0]!.summary).toBe(
      "The bench has 67 h of work queued (stone setting 44 h, finishing and polish 22 h, casting 1 h) against 42 h across 3 jewelers over the next 7 days (6 working days), so moving work between benches won't clear it; most over: Ana 26 h, Ben 4 h. Book overtime, send work out, or move promise dates now: the 25 h over is about $1,740.00 of bench time at the jewelers' rates.",
    );
    expect(recs[0]!.confidence).toBe(0.6);
  });

  it("uses the store's own working days and closed dates", async () => {
    const s = shop();
    await history(s);
    await queue(s, 9);
    const hours = storeHours("America/New_York", "mon-fri 10:00-18:00; sat-sun closed", "2026-10-05");
    const plan = benchPlan(await s.jobs(), { storeHours: hours }, NOW);
    expect(plan.workingDays).toEqual(["2026-10-02", "2026-10-06", "2026-10-07", "2026-10-08"]);
    expect(plan.jewelers[0]).toMatchObject({ jeweler: "Ana", capacityHours: 24, queuedHours: 36 });
    expect(plan.jobs.at(-1)!.finishDay).toBe("2026-10-13");
    const custom = shop([...RETAIL_DEPARTMENTS, bench, productionDepartment({ storeHours: hours })]);
    await history(custom);
    await queue(custom, 9);
    expect(only(await custom.recs("capacity"), "capacity_ana").summary).toContain("against 24 h over the next 7 days (4 working days)");
    // A week with no open day counts every day.
    const never = { timeZone: "UTC", week: [[], [], [], [], [], [], []], closedDates: [] };
    expect(benchPlan(await s.jobs(), { storeHours: never }, NOW).workingDays).toHaveLength(7);
    // The store's own calendar day: 01:00 UTC on Oct 3 is still Oct 2 in New York.
    expect(benchPlan(await s.jobs(), {}, "2026-10-03T01:00:00.000Z").workingDays[0]).toBe("2026-10-02");
  });

  it("plans only open work stages, gives later stages to who usually does them, and keeps aside work with nobody to do it", async () => {
    const s = shop();
    await history(s);
    await s.stage("HOLD", "on_hold", daysAgo(1), { jeweler: "Ana" });
    await s.stage("DONE", "casting", daysAgo(3), { jeweler: "Ana" });
    await s.stage("DONE", "setting", daysAgo(2), { jeweler: "Ana" });
    // Two finished jobs went from design on: too few to plan what follows design.
    for (const id of ["D-1", "D-2"]) {
      await s.stage(id, "design", daysAgo(12), { jeweler: "Cy" });
      await s.stage(id, "casting", daysAgo(11), { jeweler: "Cy" });
      await s.stage(id, "ready", daysAgo(10));
    }
    await s.stage("DRAWING", "design", daysAgo(1), { jeweler: "Cy" });
    // In setting, but its repair has been picked up.
    await s.repair("R-GONE", 10_000);
    await s.send("repair.status_changed", { ticketId: "R-GONE", status: "picked_up" }, daysAgo(1));
    await s.open("GONE", { repairTicketId: "R-GONE" });
    await s.stage("GONE", "setting", daysAgo(2), { jeweler: "Ana" });
    await s.stage("DONE", "ready", daysAgo(1));
    await s.stage("CAST", "casting", daysAgo(1));
    await s.stage("NOBODY", "design", daysAgo(1));
    const plan = benchPlan(await s.jobs(), {}, NOW);
    expect(plan.jobs.map((p) => p.job.jobId)).toEqual(["CAST"]);
    // Casting goes to Cy, who did it most, as nobody has the job; then setting to Ana and finishing to Ben.
    expect(plan.jobs[0]!.work.map((w) => [w.stage, w.jeweler, w.hours])).toEqual([
      ["casting", "Cy", 1],
      ["setting", "Ana", 4],
      ["finishing", "Ben", 2],
    ]);
    // Design has no history of minutes or of what follows it.
    expect(plan.unassigned).toEqual([]);
    const lone = shop();
    await lone.stage("Q-1", "qc", daysAgo(3), { laborMinutes: 10 });
    for (let i = 0; i < 3; i++) {
      await lone.stage(`H-${i}`, "qc", daysAgo(10), { laborMinutes: 10 });
      await lone.stage(`H-${i}`, "ready", daysAgo(9));
    }
    await lone.stage("Q-2", "qc", daysAgo(1));
    const lonePlan = benchPlan(await lone.jobs(), {}, NOW);
    expect(lonePlan.unassigned.map((j) => j.jobId)).toEqual(["Q-2"]);
    expect(lonePlan.jobs).toEqual([]);
    // A job on hold isn't planned, even where finished jobs went on from a hold to setting.
    const held = shop();
    for (let i = 0; i < 3; i++) {
      await held.stage(`H-${i}`, "on_hold", daysAgo(12), { jeweler: "Ana", laborMinutes: 5 });
      await held.stage(`H-${i}`, "setting", daysAgo(11), { jeweler: "Ana", laborMinutes: 60 });
      await held.stage(`H-${i}`, "ready", daysAgo(10));
    }
    await held.stage("WAIT", "on_hold", daysAgo(1), { jeweler: "Ana" });
    expect(benchPlan(await held.jobs(), {}, NOW).jobs).toEqual([]);
  });

  it("plans a later stage only when at least half the finished jobs went on to it", async () => {
    const s = shop();
    await history(s);
    // Three more finished jobs set and ready, polished only before they were set: 3 of 6 went on, still half.
    for (const id of ["X-1", "X-2", "X-3"]) {
      await s.stage(id, "finishing", daysAgo(13), { jeweler: "Ben" });
      await s.stage(id, "setting", daysAgo(12), { jeweler: "Ana" });
      await s.stage(id, "ready", daysAgo(11));
    }
    await queue(s, 1);
    expect(benchPlan(await s.jobs(), {}, NOW).jobs[0]!.work.map((w) => w.stage)).toEqual(["setting", "finishing"]);
    await s.stage("X-4", "setting", daysAgo(12), { jeweler: "Ana" });
    await s.stage("X-4", "ready", daysAgo(11));
    expect(benchPlan(await s.jobs(), {}, NOW).jobs[0]!.work.map((w) => w.stage)).toEqual(["setting"]);
  });

  it("takes jobs with a promise first, then the oldest, and leaves late work and unpromised work out of the at-risk list", async () => {
    const settings: ProductionSettings = { dailyHours: { jewelers: { Ana: 1 } } };
    const s = shop([...RETAIL_DEPARTMENTS, bench, productionDepartment(settings)]);
    await history(s);
    await s.stage("NO-DATE", "setting", daysAgo(5), { jeweler: "Ana" });
    await s.open("LATE", { promisedBy: "2026-10-01" });
    await s.stage("LATE", "setting", daysAgo(4), { jeweler: "Ana" });
    await s.open("SOON", { promisedBy: "2026-10-02" });
    await s.stage("SOON", "setting", daysAgo(3), { jeweler: "Ana" });
    await s.open("ALONE-LATE", { promisedBy: "2026-10-02" });
    await s.stage("ALONE-LATE", "setting", daysAgo(3, 13), { jeweler: "Ana" });
    await s.open("FITS", { promisedBy: "2026-10-09" });
    await s.stage("FITS", "setting", daysAgo(6), { jeweler: "Ana" });
    const plan = benchPlan(await s.jobs(), settings, NOW);
    expect(plan.jobs.map((p) => p.job.jobId)).toEqual(["LATE", "SOON", "ALONE-LATE", "FITS", "NO-DATE"]);
    // Four days of setting each at an hour a day, then a third of a day of Ben's finishing.
    expect(plan.jobs.map((p) => [p.job.jobId, p.finishDay, p.aloneDay])).toEqual([
      ["LATE", "2026-10-07", "2026-10-07"],
      ["SOON", "2026-10-12", "2026-10-07"],
      ["ALONE-LATE", "2026-10-16", "2026-10-07"],
      ["FITS", "2026-10-21", "2026-10-07"],
      ["NO-DATE", "2026-10-26", "2026-10-07"],
    ]);
    expect(plan.jewelers.find((l) => l.jeweler === "Ana")).toMatchObject({ dailyHours: 1, capacityHours: 6, queuedHours: 20 });
    expect(only(await s.recs("capacity"), "capacity_ana").summary).toBe(
      "Ana has 20 h of bench work queued (stone setting 20 h) against 6 h over the next 7 days (6 working days) at 1 h a day. 1 promised job finishes after its date because of the queue, though its own work fits: Bench job FITS, due 2026-10-09, likely 2026-10-21. Move some to Ben (26 h free), Cy (36 h free), or book overtime; the 14 h over is about $630.00 of bench time at $45.00 an hour.",
    );
  });

  it("counts jewelers named in the settings as at the bench, and leaves out those not seen in 30 days", async () => {
    const s = shop();
    await history(s);
    await s.stage("OLD", "setting", daysAgo(31), { jeweler: "Dee" });
    await s.stage("OLD", "ready", daysAgo(31, 13));
    const plan = benchPlan(await s.jobs(), { dailyHours: { jewelers: { Eve: 5 } } }, NOW);
    expect(plan.jewelers.map((l) => [l.jeweler, l.dailyHours])).toEqual([
      ["Ana", 6],
      ["Ben", 6],
      ["Cy", 6],
      ["Eve", 5],
    ]);
  });
});

describe("BENCH_LABOR_RATE and BENCH_DAILY_HOURS", () => {
  it("reads a figure for everyone, jewelers' own, or both", () => {
    expect(parseLaborRates("")).toEqual({});
    expect(parseLaborRates(" , ")).toEqual({});
    expect(parseLaborRates("45")).toEqual({ all: 4_500 });
    // 4.35 x 100 is 434.99... in floating point.
    expect(parseLaborRates("4.35")).toEqual({ all: 435 });
    expect(parseLaborRates("45.5, Ana=55.25, Ben Ortiz = 40")).toEqual({ all: 4_550, jewelers: { Ana: 5_525, "Ben Ortiz": 4_000 } });
    expect(parseLaborRates("Ana=1, 1000")).toEqual({ all: 100_000, jewelers: { Ana: 100 } });
    expect(parseDailyHours("6, Ana=0.5, Ben=24")).toEqual({ all: 6, jewelers: { Ana: 0.5, Ben: 24 } });
    expect(parseJewelerFigures("a=b=3", { min: 1, max: 5, unit: "x" })).toEqual({ jewelers: { "a=b": 3 } });
  });

  it("names the part it can't read", () => {
    expect(() => parseLaborRates("0")).toThrow(new ProductionSettingsError(`"0" needs dollars an hour from 1 to 1000, with up to two decimals`));
    for (const bad of ["0.99", "1000.01", "45.123", "forty", "$45", "-5", "Ana=", "Ana=0"]) expect(() => parseLaborRates(bad), bad).toThrow(/needs dollars an hour from 1 to 1000/);
    expect(() => parseDailyHours("25")).toThrow(`"25" needs hours from 0.5 to 24, with up to two decimals`);
    expect(() => parseDailyHours("0.49")).toThrow(/needs hours from 0.5 to 24/);
    expect(() => parseLaborRates("45, 50")).toThrow(`"50" is a second figure for everyone; give each jeweler's own as name=figure`);
    expect(() => parseLaborRates("=45")).toThrow(`"=45" needs a jeweler's name before the =`);
    expect(() => parseLaborRates("Ana=45, ana=50")).toThrow(`"ana" is given twice`);
    expect(new ProductionSettingsError("x").name).toBe("ProductionSettingsError");
  });

  it("takes a jeweler's own figure, else everyone's, else the default", () => {
    const figures = { all: 50, jewelers: { "Ana Ruiz": 70 } };
    expect(figureFor(figures, "ana ruiz", 1)).toBe(70);
    expect(figureFor(figures, "Ben", 1)).toBe(50);
    expect(figureFor(figures, undefined, 1)).toBe(50);
    expect(figureFor({ jewelers: { Ana: 70 } }, "Ben", 1)).toBe(1);
    expect(figureFor(undefined, "Ana", 1)).toBe(1);
  });
});
