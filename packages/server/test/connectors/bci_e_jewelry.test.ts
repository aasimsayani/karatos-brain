import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const guid = (k: number) => `0000000${k}-0000-4000-8000-000000000001`;
const SETTINGS = {
  EJEWELRY_TENANT_ID: guid(1),
  EJEWELRY_ENVIRONMENT: "production",
  EJEWELRY_COMPANY_ID: guid(2),
  EJEWELRY_CLIENT_ID: guid(3),
  EJEWELRY_CLIENT_SECRET: ["s", "e", "c"].join("").repeat(8),
};

describe("the e-Jewelry factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("bci_e_jewelry", {})).toBe("missing EJEWELRY_TENANT_ID, EJEWELRY_ENVIRONMENT, EJEWELRY_COMPANY_ID, EJEWELRY_CLIENT_ID, EJEWELRY_CLIENT_SECRET");
    const { EJEWELRY_CLIENT_SECRET: _secret, ...rest } = SETTINGS;
    expect(skipReason("bci_e_jewelry", rest)).toBe("missing EJEWELRY_CLIENT_SECRET");
    expect(skipReason("bci_e_jewelry", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, and won't for a setting that doesn't read", async () => {
    await buildsFromSettings("bci_e_jewelry", SETTINGS);
    await expect(buildsFromSettings("bci_e_jewelry", { ...SETTINGS, EJEWELRY_TENANT_ID: "contoso" })).rejects.toThrow(/EJEWELRY_TENANT_ID/);
    await expect(buildsFromSettings("bci_e_jewelry", { ...SETTINGS, EJEWELRY_ENVIRONMENT: "prod/x" })).rejects.toThrow(/EJEWELRY_ENVIRONMENT/);
    await expect(buildsFromSettings("bci_e_jewelry", { ...SETTINGS, EJEWELRY_COMPANY_ID: "1" })).rejects.toThrow(/EJEWELRY_COMPANY_ID/);
    await expect(buildsFromSettings("bci_e_jewelry", { ...SETTINGS, EJEWELRY_CLIENT_ID: "app" })).rejects.toThrow(/EJEWELRY_CLIENT_ID/);
    await expect(buildsFromSettings("bci_e_jewelry", { ...SETTINGS, EJEWELRY_CLIENT_SECRET: "short" })).rejects.toThrow(/EJEWELRY_CLIENT_SECRET/);
  });
});
