import { describe, expect, it } from "vitest";
import { loadInstanceConfig } from "../src/index.js";

const valid = {
  INSTANCE_NAME: "Fuse Jewelry",
  ORGANIZATION_ID: "fuse-jewelry",
  INSTANCE_API_KEY: "a".repeat(64),
  SUPABASE_DB_URL: "postgresql://user:pass@db.example.supabase.co:5432/postgres",
};

describe("loadInstanceConfig", () => {
  it("applies defaults", () => {
    const config = loadInstanceConfig(valid);
    expect(config).toMatchObject({ PORT: 8080, MIGRATE_ON_START: true, DOC_REGISTRY_IDS: [], ENABLED_DEPARTMENTS: [], ENABLED_WRITES: [], ENABLED_INTEGRATIONS: [], SYNC_INTERVAL_MINUTES: 60 });
  });

  it("parses the documentation registry list", () => {
    expect(loadInstanceConfig({ ...valid, DOC_REGISTRY_IDS: "a, b,,c " }).DOC_REGISTRY_IDS).toEqual(["a", "b", "c"]);
  });

  it("requires a long API key", () => {
    expect(() => loadInstanceConfig({ ...valid, INSTANCE_API_KEY: "short" })).toThrow(/INSTANCE_API_KEY/);
  });

  it("requires a slug-style organization id", () => {
    expect(() => loadInstanceConfig({ ...valid, ORGANIZATION_ID: "Fuse Jewelry" })).toThrow(/ORGANIZATION_ID/);
  });

  it("never echoes secret values in errors", () => {
    const secret = "postgresql-not-a-url-but-a-secret";
    try {
      loadInstanceConfig({ ...valid, INSTANCE_API_KEY: "tiny-secret", SUPABASE_DB_URL: secret });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("tiny-secret");
    }
  });

  it("reads the enabled departments and rejects unknown ones without echoing values", () => {
    expect(loadInstanceConfig({ ...valid, ENABLED_DEPARTMENTS: "sales, repairs" }).ENABLED_DEPARTMENTS).toEqual(["sales", "repairs"]);
    expect(() => loadInstanceConfig({ ...valid, ENABLED_DEPARTMENTS: "sales,manufacturing" })).toThrow(/ENABLED_DEPARTMENTS: use any of: sales/);
  });

  it("keeps every integration read-only unless writes are listed", () => {
    expect(loadInstanceConfig({ ...valid, ENABLED_WRITES: "shopify:adjust_inventory, stripe:*" }).ENABLED_WRITES).toEqual([
      "shopify:adjust_inventory",
      "stripe:*",
    ]);
    expect(() => loadInstanceConfig({ ...valid, ENABLED_WRITES: "shopify" })).toThrow(/ENABLED_WRITES: use integration:action/);
  });

  it("reads the enabled integrations and rejects ids outside the catalog", () => {
    expect(loadInstanceConfig({ ...valid, ENABLED_INTEGRATIONS: "shopify, stripe,inventory_pos" }).ENABLED_INTEGRATIONS).toEqual(["shopify", "stripe", "inventory_pos"]);
    expect(() => loadInstanceConfig({ ...valid, ENABLED_INTEGRATIONS: "shopify,constructor" })).toThrow(/ENABLED_INTEGRATIONS: use catalog integration ids/);
  });

  it("keeps the sync interval between 5 minutes and a day", () => {
    expect(loadInstanceConfig({ ...valid, SYNC_INTERVAL_MINUTES: "15" }).SYNC_INTERVAL_MINUTES).toBe(15);
    expect(loadInstanceConfig({ ...valid, SYNC_INTERVAL_MINUTES: "5" }).SYNC_INTERVAL_MINUTES).toBe(5);
    expect(loadInstanceConfig({ ...valid, SYNC_INTERVAL_MINUTES: "1440" }).SYNC_INTERVAL_MINUTES).toBe(1440);
    for (const bad of ["4", "1441", "1.5", "soon"]) expect(() => loadInstanceConfig({ ...valid, SYNC_INTERVAL_MINUTES: bad })).toThrow(/SYNC_INTERVAL_MINUTES/);
  });
});
