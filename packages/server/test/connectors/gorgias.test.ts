import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const SETTINGS = { GORGIAS_DOMAIN: "teststore", GORGIAS_CLIENT_ID: "gorgias-client-test", GORGIAS_CLIENT_SECRET: "s".repeat(32), GORGIAS_REFRESH_TOKEN: "r".repeat(32), CUSTOMER_REF_KEY: "c".repeat(64) };

describe("the Gorgias factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("gorgias", {})).toBe("missing GORGIAS_DOMAIN, GORGIAS_CLIENT_ID, GORGIAS_CLIENT_SECRET, GORGIAS_REFRESH_TOKEN, CUSTOMER_REF_KEY");
    const { GORGIAS_REFRESH_TOKEN: _, ...rest } = SETTINGS;
    expect(skipReason("gorgias", rest)).toBe("missing GORGIAS_REFRESH_TOKEN");
    expect(skipReason("gorgias", rest)).not.toContain(SETTINGS.GORGIAS_CLIENT_SECRET);
    expect(skipReason("gorgias", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, and won't for a setting that doesn't read", async () => {
    await buildsFromSettings("gorgias", SETTINGS);
    await expect(buildsFromSettings("gorgias", { ...SETTINGS, GORGIAS_DOMAIN: "store.gorgias.com" })).rejects.toThrow(/GORGIAS_DOMAIN/);
    await expect(buildsFromSettings("gorgias", { ...SETTINGS, GORGIAS_CLIENT_ID: "x" })).rejects.toThrow(/GORGIAS_CLIENT_ID/);
    await expect(buildsFromSettings("gorgias", { ...SETTINGS, GORGIAS_CLIENT_SECRET: "short" })).rejects.toThrow(/GORGIAS_CLIENT_SECRET/);
    await expect(buildsFromSettings("gorgias", { ...SETTINGS, GORGIAS_REFRESH_TOKEN: "short" })).rejects.toThrow(/GORGIAS_REFRESH_TOKEN/);
    await expect(buildsFromSettings("gorgias", { ...SETTINGS, CUSTOMER_REF_KEY: "short" })).rejects.toThrow(/CUSTOMER_REF_KEY/);
  });
});
