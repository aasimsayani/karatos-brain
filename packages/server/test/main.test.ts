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
    vi.spyOn(console, "log").mockImplementation(() => {});
    Object.assign(process.env, {
      INSTANCE_NAME: "Example Jewelers",
      ORGANIZATION_ID: "example-jewelers",
      INSTANCE_API_KEY: `i${randomBytes(32).toString("hex")}`,
      SUPPORT_API_KEY: supportKey,
      SUPABASE_DB_URL: "postgresql://user:pass@db.example.test:5432/postgres",
      PORT: String(port),
      ENABLED_INTEGRATIONS: "stripe, shopify",
      ENABLED_DEPARTMENTS: "repairs, sales",
      RAW_RETENTION_DAYS: "45",
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
    expect([...first.departments].sort()).toEqual(["repairs", "sales"]);
    expect(first.migrations.count).toBeGreaterThan(0);
    // Scheduled reasoning is on by default. The only connector brings nothing, so the one run there can be is the
    // daily brief's own, when the instance starts after BRIEF_HOUR on the store's clock.
    expect(first.reasoning).toMatchObject({ scheduled: true, intervalMinutes: 60, consecutiveFailures: 0 });
    if (first.reasoning!.lastRun) expect(first.reasoning!.lastRun).toMatchObject({ trigger: "brief", outcome: "succeeded", error: null });
    expect(first.integrations.find((i) => i.id === "shopify")).toMatchObject({ syncing: false, notSyncingReason: "missing SHOPIFY_SHOP_DOMAIN" });
    await vi.waitFor(async () => {
      const stripe = (await status()).integrations.find((i) => i.id === "stripe");
      expect(stripe?.lastSync).toMatchObject({ mode: "historical", outcome: "failed", error: "Error: vendor unreachable" });
    });
  });
});
