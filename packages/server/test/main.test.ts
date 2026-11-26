import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ScheduledConnector, SupportStatus } from "../src/index.js";

// The real entry point, with pg backed by an in-process PGlite and one scheduled connector that can't reach its vendor.
const db = vi.hoisted(() => ({ current: undefined as PGlite | undefined }));

vi.mock("pg", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  db.current = new PGlite();
  const query = async (text: string, params?: unknown[]) => {
    if (params === undefined || params.length === 0) return { rows: (await db.current!.exec(text)).at(-1)?.rows ?? [] };
    return { rows: (await db.current!.query(text, params)).rows };
  };
  class Client {
    async connect() {}
    query = query;
    async end() {}
  }
  class Pool {
    query = query;
    async end() {}
  }
  return { default: { Client, Pool } };
});

vi.mock("../src/sync.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/sync.js")>();
  const unreachable: ScheduledConnector = {
    id: "stripe",
    make: async () => {
      throw new Error("vendor unreachable");
    },
  };
  return { ...real, scheduledConnectors: () => ({ connectors: [unreachable], skipped: [{ id: "shopify", reason: "missing SHOPIFY_SHOP_DOMAIN" }] }) };
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer().once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
afterAll(async () => {
  process.emit("SIGTERM");
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  exit.mockRestore();
  await db.current?.close();
});

describe("main: the running instance", () => {
  it("serves its settings and the sync runner's latest runs on GET /v1/support/status", async () => {
    const port = await freePort();
    const supportKey = `s${randomBytes(32).toString("hex")}`;
    const instanceKey = `i${randomBytes(32).toString("hex")}`;
    vi.spyOn(console, "log").mockImplementation(() => {});
    Object.assign(process.env, {
      INSTANCE_NAME: "Example Jewelers",
      ORGANIZATION_ID: "example-jewelers",
      INSTANCE_API_KEY: instanceKey,
      SUPPORT_API_KEY: supportKey,
      SUPABASE_DB_URL: "postgresql://user:pass@db.example.test:5432/postgres",
      PORT: String(port),
      ENABLED_INTEGRATIONS: "stripe, shopify",
      ENABLED_DEPARTMENTS: "repairs, sales, clienteling, bench",
      RAW_RETENTION_DAYS: "45",
      STORE_TIME_ZONE: "America/Phoenix",
      // Open around the clock, so the wait below is the same whenever the test runs.
      STORE_HOURS: "mon-sun 00:00-12:00, 12:00-24:00",
      STORE_CLOSED_DATES: "2026-01-01",
      AWAITING_REPLY_HOURS: "3",
      BENCH_STAGE_LIMIT_DAYS: "casting=1",
      BENCH_METAL_LOSS_PERCENT: "5",
    });
    await import("../src/main.js");

    const status = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/support/status`, { headers: { authorization: `Bearer ${supportKey}` } });
      expect(res.status).toBe(200);
      return (await res.json()) as SupportStatus;
    };
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const first = await status();
    expect(first.instance).toMatchObject({ name: "Example Jewelers", organizationId: "example-jewelers", version });
    expect(first.retention).toEqual({ rawRetentionDays: 45 });
    // The store hours as the instance read them from its settings.
    expect(first.settings).toEqual({
      storeHours: {
        timeZone: "America/Phoenix",
        hours: "mon-sun 00:00-12:00, 12:00-24:00",
        week: Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, ["00:00-12:00", "12:00-24:00"]])),
        closedDates: ["2026-01-01"],
      },
      awaitingReplyHours: 3,
    });
    expect([...first.departments].sort()).toEqual(["bench", "clienteling", "repairs", "sales"]);
    expect(first.migrations.count).toBeGreaterThan(0);
    // Scheduled reasoning is on by default. The only connector brings nothing, so the one run there can be is the
    // daily brief's own, when the instance starts after BRIEF_HOUR on the store's clock.
    expect(first.reasoning).toMatchObject({ scheduled: true, intervalMinutes: 60, consecutiveFailures: 0 });
    if (first.reasoning!.lastRun) expect(first.reasoning!.lastRun).toMatchObject({ trigger: "brief", outcome: "succeeded", error: null });
    expect(first.integrations.find((i) => i.id === "shopify")).toMatchObject({ syncing: false, notSyncingReason: "missing SHOPIFY_SHOP_DOMAIN" });
    // The pipeline counts those hours: a text 3.5 hours old is raised at AWAITING_REPLY_HOURS=3. The default hours and
    // 4-hour wait never would, since no 3.5 hours hold 4 open ones.
    const sentAt = new Date(Date.now() - 210 * 60_000).toISOString();
    const instance = { authorization: `Bearer ${instanceKey}`, "content-type": "application/json" };
    const ingested = await fetch(`http://127.0.0.1:${port}/v1/events`, {
      method: "POST",
      headers: instance,
      body: JSON.stringify({
        id: "evt_quo_main",
        source: "quo",
        type: "communication.message_logged",
        occurredAt: sentAt,
        receivedAt: sentAt,
        idempotencyKey: "quo:main:1",
        payload: { system: "Quo", channel: "sms", messageId: "quo:message:main", direction: "inbound", customerRefs: ["form_customer:mainphone"] },
      }),
    });
    expect(ingested.status).toBe(202);
    const reasoned = await fetch(`http://127.0.0.1:${port}/v1/reason`, { method: "POST", headers: instance });
    const { recommendations } = (await reasoned.json()) as { recommendations: { id: string; summary: string }[] };
    const waiting = recommendations.find((r) => r.id.startsWith("rec_clienteling_awaiting_reply_others_"));
    expect(waiting?.summary).toContain("waited 3 or more business hours");
    // The bench rules read the instance's own limits: a job two days in casting is past BENCH_STAGE_LIMIT_DAYS=casting=1,
    // and 0.40 g lost of 10 g is inside BENCH_METAL_LOSS_PERCENT=5 though past the default 3%.
    const castAt = new Date(Date.now() - 2.5 * 86_400_000).toISOString();
    const staged = await fetch(`http://127.0.0.1:${port}/v1/events`, {
      method: "POST",
      headers: instance,
      body: JSON.stringify({
        id: "evt_bench_main",
        source: "inventory_pos",
        type: "bench_job.stage_recorded",
        occurredAt: castAt,
        receivedAt: castAt,
        idempotencyKey: "pos:main:bench:1",
        payload: { jobId: "J-MAIN", stage: "casting", jeweler: "Ana", metalInGrams: 10, metalOutGrams: 9.6 },
      }),
    });
    expect(staged.status).toBe(202);
    const benchRun = (await (await fetch(`http://127.0.0.1:${port}/v1/reason`, { method: "POST", headers: instance })).json()) as { recommendations: { id: string; summary: string }[] };
    const benchRecs = benchRun.recommendations.filter((r) => r.id.startsWith("rec_bench_"));
    expect(benchRecs.map((r) => r.summary)).toEqual(["Bench job J-MAIN has been in casting for 2 days with Ana, past the 1-day limit. Find out what's holding it up."]);
    await vi.waitFor(async () => {
      const stripe = (await status()).integrations.find((i) => i.id === "stripe");
      expect(stripe?.lastSync).toMatchObject({ mode: "historical", outcome: "failed", error: "Error: vendor unreachable" });
    });
  });
});
