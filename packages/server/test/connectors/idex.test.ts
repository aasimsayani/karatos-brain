import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Shaped like an IDEX API secret, assembled so no scanner mistakes it for a real one.
const secret = ["test", "idex", "0".repeat(24)].join("-");
const key = "idexKeyTest01";

describe("the IDEX factory", () => {
  it("names the settings it is missing, never their values", () => {
    const reason = skipReason("idex", { IDEX_API_SECRET: secret });
    expect(reason).toBe("missing IDEX_API_KEY");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings, and rejects feeds and caps that aren't ones", async () => {
    const env = { IDEX_API_KEY: key, IDEX_API_SECRET: secret };
    await buildsFromSettings("idex", env);
    await buildsFromSettings("idex", { ...env, IDEX_FEEDS: "natural, lab-grown", IDEX_MAX_STONES: "80000" });
    await expect(buildsFromSettings("idex", { ...env, IDEX_FEEDS: "colored" })).rejects.toThrow(/IDEX_FEEDS must be natural, lab_grown or both/);
    await expect(buildsFromSettings("idex", { ...env, IDEX_MAX_STONES: "lots" })).rejects.toThrow(/maxStones must be a positive whole number/);
  });
});
