import { describe, expect, it } from "vitest";
import { checkConfig, loadConfig } from "../src/index.js";

const base = {
  ORGANIZATION_ID: "fuse-jewelry",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key-placeholder-0000",
};

describe("checkConfig", () => {
  it("passes with only the required settings and reports integrations as not configured", () => {
    const report = checkConfig(base);
    expect(report.ok).toBe(true);
    expect(report.integrations.shopify).toBe("not_configured");
  });

  it("treats an integration as configured only when all of its keys are present", () => {
    const partial = checkConfig({ ...base, SHOPIFY_SHOP_DOMAIN: "fuse.myshopify.com" });
    expect(partial.integrations.shopify).toBe("not_configured");
    const full = checkConfig({ ...partial, ...base, SHOPIFY_SHOP_DOMAIN: "fuse.myshopify.com", SHOPIFY_ADMIN_ACCESS_TOKEN: "x" });
    expect(full.integrations.shopify).toBe("configured");
  });

  it("reports missing required settings without echoing values", () => {
    const report = checkConfig({ SUPABASE_ANON_KEY: "secret-value-should-not-leak" });
    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toContain("SUPABASE_URL");
    expect(report.errors.join(" ")).not.toContain("secret-value-should-not-leak");
  });

  it("treats empty strings as unset", () => {
    expect(() => loadConfig({ ...base, SUPABASE_URL: "" })).toThrow();
  });
});
