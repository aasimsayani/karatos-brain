import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildsFromSettings, emptyFolder, skipReason } from "../connector-harness.js";

// Shaped like a UPS client id and secret, assembled so no scanner mistakes them for real ones.
const id = ["test", "0".repeat(20)].join("");
const secret = ["test", "1".repeat(40)].join("");

describe("the UPS factory", () => {
  it("names the settings it is missing, never their values", () => {
    const reason = skipReason("ups", { UPS_CLIENT_SECRET: secret });
    expect(reason).toBe("missing UPS_CLIENT_ID, UPS_TRACKING_NUMBERS_FILE");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings, and rejects a bad environment or cap", async () => {
    const list = join(await emptyFolder("ups"), "tracking.txt");
    await writeFile(list, "1ZTEST010000000001\n");
    const env = { UPS_CLIENT_ID: id, UPS_CLIENT_SECRET: secret, UPS_TRACKING_NUMBERS_FILE: list };
    await buildsFromSettings("ups", env);
    await buildsFromSettings("ups", { ...env, UPS_ENVIRONMENT: "test", UPS_MAX_TRACKING_PER_SYNC: "50" });
    await expect(buildsFromSettings("ups", { ...env, UPS_ENVIRONMENT: "staging" })).rejects.toThrow(/UPS_ENVIRONMENT must be/);
    await expect(buildsFromSettings("ups", { ...env, UPS_MAX_TRACKING_PER_SYNC: "lots" })).rejects.toThrow(/maxPerSync must be a positive whole number/);
    await expect(buildsFromSettings("ups", { ...env, UPS_CLIENT_ID: "x" })).rejects.toThrow(/UPS_CLIENT_ID/);
  });
});
