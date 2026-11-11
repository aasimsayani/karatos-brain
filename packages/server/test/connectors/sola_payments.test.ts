import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// A credential-shaped value, assembled at runtime so no scanner mistakes the source for a leak.
const SETTINGS = { SOLA_API_KEY: ["sola", "0".repeat(24)].join("_"), CUSTOMER_REF_KEY: "c".repeat(64) };

describe("the Sola Payments factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("sola_payments", { CUSTOMER_REF_KEY: SETTINGS.CUSTOMER_REF_KEY })).toBe("missing SOLA_API_KEY");
    expect(skipReason("sola_payments", { SOLA_API_KEY: SETTINGS.SOLA_API_KEY })).toBe("missing CUSTOMER_REF_KEY");
    expect(skipReason("sola_payments", { SOLA_API_KEY: SETTINGS.SOLA_API_KEY })).not.toContain(SETTINGS.SOLA_API_KEY);
    expect(skipReason("sola_payments", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, with or without a time zone", async () => {
    expect((await buildsFromSettings("sola_payments", SETTINGS)).source).toBe("sola_payments");
    expect((await buildsFromSettings("sola_payments", { ...SETTINGS, SOLA_TIME_ZONE: "America/Chicago" })).source).toBe("sola_payments");
  });

  it("won't build with a setting in the wrong shape", async () => {
    await expect(buildsFromSettings("sola_payments", { ...SETTINGS, SOLA_API_KEY: "short" })).rejects.toThrow("SOLA_API_KEY is missing or not in the expected shape");
    await expect(buildsFromSettings("sola_payments", { ...SETTINGS, SOLA_TIME_ZONE: "Nowhere/Land" })).rejects.toThrow("SOLA_TIME_ZONE is not an IANA time zone");
    await expect(buildsFromSettings("sola_payments", { ...SETTINGS, CUSTOMER_REF_KEY: "short" })).rejects.toThrow("CUSTOMER_REF_KEY");
  });
});
