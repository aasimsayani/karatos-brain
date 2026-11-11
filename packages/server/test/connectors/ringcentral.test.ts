import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const JWT = [`eyJ${"a".repeat(20)}`, "b".repeat(30), "c".repeat(40)].join(".");
const SETTINGS = { RINGCENTRAL_CLIENT_ID: "rcclienttest", RINGCENTRAL_CLIENT_SECRET: "s".repeat(32), RINGCENTRAL_JWT: JWT, CUSTOMER_REF_KEY: "c".repeat(64) };

describe("the RingCentral factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("ringcentral", {})).toBe("missing RINGCENTRAL_CLIENT_ID, RINGCENTRAL_CLIENT_SECRET, RINGCENTRAL_JWT, CUSTOMER_REF_KEY");
    const { RINGCENTRAL_JWT: _, ...rest } = SETTINGS;
    expect(skipReason("ringcentral", rest)).toBe("missing RINGCENTRAL_JWT");
    expect(skipReason("ringcentral", rest)).not.toContain(SETTINGS.RINGCENTRAL_CLIENT_SECRET);
    expect(skipReason("ringcentral", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, and won't for a setting that doesn't read", async () => {
    await buildsFromSettings("ringcentral", SETTINGS);
    await expect(buildsFromSettings("ringcentral", { ...SETTINGS, RINGCENTRAL_CLIENT_ID: "x" })).rejects.toThrow(/RINGCENTRAL_CLIENT_ID/);
    await expect(buildsFromSettings("ringcentral", { ...SETTINGS, RINGCENTRAL_CLIENT_SECRET: "short" })).rejects.toThrow(/RINGCENTRAL_CLIENT_SECRET/);
    await expect(buildsFromSettings("ringcentral", { ...SETTINGS, RINGCENTRAL_JWT: "not-a-jwt" })).rejects.toThrow(/RINGCENTRAL_JWT/);
    await expect(buildsFromSettings("ringcentral", { ...SETTINGS, CUSTOMER_REF_KEY: "short" })).rejects.toThrow(/CUSTOMER_REF_KEY/);
  });
});
