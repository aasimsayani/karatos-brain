import { request, type IncomingMessage } from "node:http";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { INTEGRATIONS } from "@karatos/core";
import { assertSynthetic } from "@karatos/connector-testkit";
import {
  DEMO_CASH_DEPOSITS,
  DEMO_CUSTOMERS,
  DEMO_INVOICES,
  DEMO_ITEMS,
  DEMO_NOT_YET,
  DEMO_ORGANIZATION,
  DEMO_SALES,
  DEMO_SOURCES,
  DEMO_SPOT,
  createDemoApp,
  demoCalendar,
  demoCalls,
  demoChats,
  demoIntegrations,
  demoMessages,
  demoSpot,
  demoTransactions,
  posExports,
  seedDemo,
  startDemo,
  untilMidnight,
  type DemoBrain,
} from "../src/index.js";

const NOW = new Date("2026-10-29T18:00:00Z");
// Assembled at runtime so no key-shaped string sits in the repository.
const KEY = ["demo", "key", "x".repeat(40)].join("-");

/** A recommendation's id without the day it was made, so seeds on different days compare. */
const keyOf = (id: string) => id.replace(/_\d{4}-\d{2}-\d{2}$/, "");

let brain: DemoBrain | undefined;
const seeded = async () => (brain ??= await seedDemo({ now: NOW }));

describe("the demo store", () => {
  it("runs every demo source through its real connector without losing a record", async () => {
    const { sources } = await seeded();
    expect(sources.map((s) => s.integration)).toEqual(["metals_api", "inventory_pos", "plaid", "quickbooks", "twilio", "watchsearch"]);
    for (const source of sources) {
      expect(source.ingested, source.integration).toBeGreaterThan(0);
      expect(source.deadLettered, source.integration).toBe(0);
      expect(source.syncedAt).toBe(NOW.toISOString());
    }
  });

  it("gives the dashboard a recommendation in each department the store's systems feed", async () => {
    const { recommendations } = await seeded();
    expect(recommendations.map((r) => keyOf(r.id)).sort()).toEqual(
      [
        "rec_buying_watch_wanted_Rolex_126500LN",
        "rec_clienteling_lapsed_pos:generic:customer:C-1003",
        "rec_clienteling_missed_calls",
        "rec_compliance_8300_sig_payment.cash_received_order_pos:generic:sale:S-4015#0_pos_generic:sale:S-4015",
        "rec_compliance_structuring_pos:generic:customer:C-1004",
        "rec_finance_cash_gap",
        "rec_finance_overdue_receivables",
        "rec_inventory_aged_ES-1002",
        "rec_inventory_aged_ES-1005",
        "rec_inventory_reorder_ES-1001",
        "rec_inventory_reorder_ES-1003",
        "rec_metals_move_gold",
        "rec_sales_returns_ES-1004",
      ].sort(),
    );
    const text = recommendations.map((r) => r.summary).join("\n");
    expect(text).toContain("Gold is up 6.1%");
    expect(text).toContain("$14,900.00 in cash was received");
    expect(text).toContain("$4,650.00 across 2 invoices");
    // The two branch deposits count; the $14,900 from three days ago hasn't gone in.
    expect(text).toContain("$25,590.00 in cash sales over the last 30 days but only $10,690.00 in cash deposits");
    expect(text).toContain("2 callers rang the store 3 times");
    expect(text).toContain("3 dealers in your WhatsApp groups have asked for the Rolex 126500LN");
    for (const r of recommendations) {
      expect(r.organizationId).toBe(DEMO_ORGANIZATION);
      expect(r.degraded).toBe(false);
      expect(r.provenance.eventIds.length, r.id).toBeGreaterThan(0);
    }
  });

  it("tells the same story whatever day it is seeded", async () => {
    const today = (await seeded()).recommendations.map((r) => keyOf(r.id)).sort();
    for (const day of ["2027-03-01T00:30:00Z", "2028-02-29T23:59:00Z", "2026-12-31T12:00:00Z"]) {
      const other = await seedDemo({ now: new Date(day) });
      expect(other.recommendations.map((r) => keyOf(r.id)).sort(), day).toEqual(today);
      for (const r of other.recommendations) expect(r.createdAt <= day).toBe(true);
    }
  });

  it("needs every source: taking one away takes a recommendation or a kind of signal off the dashboard", async () => {
    // What the console can show: the recommendations, and the kinds of signal its tiles read.
    const shown = async (demo: DemoBrain) => new Set([...demo.recommendations.map((r) => keyOf(r.id)), ...(await demo.memory.recentSignals(demo.organizationId, 10_000)).map((s) => `signal:${s.kind}`)]);
    const all = await shown(await seeded());
    for (const source of DEMO_SOURCES) {
      const left = await shown(await seedDemo({ now: NOW, sources: DEMO_SOURCES.filter((s) => s !== source) }));
      expect([...all].filter((k) => !left.has(k)).length, source.integration).toBeGreaterThan(0);
    }
  });

  it("covers every built connector, either as a source or with a reason it isn't one yet", () => {
    const built = INTEGRATIONS.filter((i) => i.status === "built").map((i) => i.id).sort();
    const sources = DEMO_SOURCES.map((s) => s.integration);
    const later = Object.keys(DEMO_NOT_YET);
    expect([...sources, ...later].sort()).toEqual(built);
    expect(sources.filter((id) => later.includes(id))).toEqual([]);
    for (const reason of Object.values(DEMO_NOT_YET)) expect(reason).toMatch(/^[A-Z].{20,}[^.]$/);
    for (const source of DEMO_SOURCES) expect(source.role).toMatch(/^[A-Z].{20,100}[^.]$/);
  });

  it("is made up: no real-looking email, card or phone number anywhere in it", async () => {
    const calendar = demoCalendar(NOW);
    assertSynthetic({ DEMO_ITEMS, DEMO_CUSTOMERS, DEMO_SALES, DEMO_CASH_DEPOSITS, DEMO_INVOICES });
    assertSynthetic(posExports(calendar));
    assertSynthetic(demoChats(calendar));
    assertSynthetic(demoTransactions(calendar));
    assertSynthetic(demoCalls(calendar));
    assertSynthetic(demoMessages(calendar));
    const { recommendations } = await seeded();
    assertSynthetic(recommendations);
  });
});

describe("the demo calendar", () => {
  it("counts days back from now and never lands in the future", () => {
    const calendar = demoCalendar(new Date("2026-03-05T09:30:00Z"));
    expect(calendar.date(0)).toBe("2026-03-05");
    expect(calendar.date(5)).toBe("2026-02-28");
    expect(calendar.usDate(5)).toBe("02/28/2026");
    expect(calendar.at(2, 15)).toBe("2026-03-03T15:00:00.000Z");
    // 3 pm today is still to come at 9:30 am, so it becomes a minute ago.
    expect(calendar.at(0, 15)).toBe("2026-03-05T09:29:00.000Z");
    expect(calendar.at(0, 6)).toBe("2026-03-05T06:00:00.000Z");
  });

  it("prices metals with a drift to yesterday and today's quote on top", () => {
    expect(demoSpot("XAU", 0)).toBe(DEMO_SPOT.XAU.today);
    expect(demoSpot("XAU", 1)).toBeCloseTo(DEMO_SPOT.XAU.before * 0.9996, 2);
    expect(demoSpot("XAU", 10)).toBeLessThan(demoSpot("XAU", 1));
    expect(demoSpot("XAG", -3)).toBe(DEMO_SPOT.XAG.today);
  });
});

describe("the demo API", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  async function serve(handler: RequestListener) {
    server = createServer(handler);
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    return (method: string, path: string, body?: unknown, key: string | null = KEY) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method, path, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" } }, (res: IncomingMessage) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }));
        });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
  }

  it("reads like any instance and needs the key", async () => {
    const call = await serve(createDemoApp(await seeded(), { apiKey: KEY }));
    expect((await call("GET", "/v1/recommendations", undefined, null)).status).toBe(401);
    expect((await call("GET", "/v1/recommendations", undefined, ["wrong", "x".repeat(40)].join("-"))).status).toBe(401);
    const recs = await call("GET", "/v1/recommendations?limit=200");
    expect(recs.status).toBe(200);
    expect(recs.body.recommendations).toHaveLength(13);
    const signals = await call("GET", "/v1/signals?kind=bank.balance");
    expect(signals.body.signals.length).toBeGreaterThan(0);
    expect((await call("GET", "/healthz", undefined, null)).status).toBe(200);
  });

  it("lists the store's systems as connected, with what each is for, and the rest as available", async () => {
    const demo = await seeded();
    const call = await serve(createDemoApp(demo, { apiKey: KEY }));
    const { body } = await call("GET", "/v1/integrations");
    expect(body.integrations).toEqual(demoIntegrations(demo));
    const connected = body.integrations.filter((i: { configured: boolean }) => i.configured);
    expect(connected.map((i: { id: string }) => i.id).sort()).toEqual(DEMO_SOURCES.map((s) => s.integration).sort());
    const plaid = connected.find((i: { id: string }) => i.id === "plaid");
    expect(plaid).toMatchObject({ missingSettings: [], demo: { role: "Bank balances and transactions, including cash deposits", syncedAt: NOW.toISOString() } });
    expect(plaid.demo.ingested).toBeGreaterThan(0);
    expect(body.integrations.find((i: { id: string }) => i.id === "stuller")).toMatchObject({ configured: false });
    expect(body.integrations.find((i: { id: string }) => i.id === "stuller").demo).toBeUndefined();
  });

  it("is read-only: no new events and no rerunning the brain", async () => {
    const call = await serve(createDemoApp(await seedDemo({ now: NOW }), { apiKey: KEY }));
    const event = { id: "evt_1", type: "sale.completed", occurredAt: NOW.toISOString(), receivedAt: NOW.toISOString(), idempotencyKey: "x", payload: {} };
    expect(await call("POST", "/v1/events", event)).toEqual({ status: 403, body: { error: "the demo store is read-only" } });
    expect(await call("POST", "/v1/reason", {})).toEqual({ status: 403, body: { error: "the demo store is read-only" } });
    expect((await call("GET", "/v1/recommendations")).body.recommendations).toHaveLength(13);
  });

  it("takes Accept and Dismiss as feedback, up to its limit", async () => {
    const demo = await seedDemo({ now: NOW });
    const call = await serve(createDemoApp(demo, { apiKey: KEY, feedbackLimit: 2 }));
    const [first, second] = demo.recommendations;
    const feedback = (id: string) => call("POST", `/v1/recommendations/${encodeURIComponent(id)}/feedback`, { outcome: "accepted", actor: "Demo visitor" });
    expect((await feedback(first!.id)).status).toBe(201);
    expect((await call("POST", "/v1/recommendations/rec_none/feedback", { outcome: "accepted", actor: "Demo visitor" })).status).toBe(404);
    expect((await feedback(second!.id)).status).toBe(201);
    expect(await feedback(first!.id)).toEqual({ status: 429, body: { error: "the demo has taken all the feedback it keeps until tonight's reset" } });
    // Reads still work once feedback is full.
    expect((await call("GET", "/v1/recommendations")).status).toBe(200);
  });
});

describe("startDemo", () => {
  it("seeds a fresh copy at midnight UTC and swaps it in", async () => {
    const timers: { run: () => void; ms: number }[] = [];
    const logs: string[] = [];
    let clock = new Date("2026-10-29T18:00:00Z");
    const seeds: string[] = [];
    const seed = async ({ now }: { now?: Date }) => {
      seeds.push(now!.toISOString());
      return seedDemo({ now: now!, sources: DEMO_SOURCES.slice(0, 1) });
    };
    const demo = await startDemo({ apiKey: KEY, seed, now: () => clock, setTimer: (run, ms) => timers.push({ run, ms }), log: (l) => logs.push(l) });
    expect(timers.map((t) => t.ms)).toEqual([6 * 3_600_000]);
    expect(logs).toEqual([expect.stringMatching(/^demo seeded: 1 systems, \d+ events, 1 recommendations$/)]);
    const before = demo.current();

    clock = new Date("2026-10-30T00:00:00Z");
    timers[0]!.run();
    await new Promise((r) => setTimeout(r, 50));
    expect(seeds).toEqual(["2026-10-29T18:00:00.000Z", "2026-10-30T00:00:00.000Z"]);
    expect(demo.current()).not.toBe(before);
    expect(demo.current().seededAt).toBe("2026-10-30T00:00:00.000Z");
    expect(logs[1]).toMatch(/^demo reseeded: /);
    expect(timers.map((t) => t.ms)).toEqual([6 * 3_600_000, 86_400_000]);

    const call = await new Promise<number>((resolve) => {
      const res = { writeHead: (status: number) => resolve(status), end: () => {} };
      demo.handler({ method: "GET", url: "/healthz", headers: {} } as never, res as never);
    });
    expect(call).toBe(200);
  });

  it("keeps serving yesterday's copy when a reseed fails, and tries again the next night", async () => {
    const timers: { run: () => void; ms: number }[] = [];
    const logs: string[] = [];
    let fail = false;
    const seed = async ({ now }: { now?: Date }) => {
      if (fail) throw new Error("vendor mock broke");
      return seedDemo({ now: now!, sources: DEMO_SOURCES.slice(0, 1) });
    };
    const demo = await startDemo({ apiKey: KEY, seed, now: () => NOW, setTimer: (run, ms) => timers.push({ run, ms }), log: (l) => logs.push(l) });
    const before = demo.current();
    fail = true;
    timers[0]!.run();
    await new Promise((r) => setTimeout(r, 20));
    expect(demo.current()).toBe(before);
    expect(logs[1]).toBe("demo reseed failed, keeping yesterday's copy: vendor mock broke");
    expect(timers).toHaveLength(2);
  });

  it("works out the time to the next midnight UTC", () => {
    expect(untilMidnight(new Date("2026-10-29T23:59:59.000Z"))).toBe(1000);
    expect(untilMidnight(new Date("2026-10-29T00:00:00.000Z"))).toBe(86_400_000);
    expect(untilMidnight(new Date("2026-10-29T12:00:00.000Z"))).toBe(43_200_000);
  });
});
