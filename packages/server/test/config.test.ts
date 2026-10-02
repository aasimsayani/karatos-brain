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
    expect(config).toMatchObject({ PORT: 8080, MIGRATE_ON_START: true, DOC_REGISTRY_IDS: [], ENABLED_DEPARTMENTS: [] });
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
});
