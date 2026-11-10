import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildsFromSettings, emptyFolder, skipReason } from "../connector-harness.js";

// Shaped like a FedEx client id and secret, assembled so no scanner mistakes them for real ones.
const id = ["test", "0".repeat(20)].join("");
const secret = ["test", "1".repeat(40)].join("");

describe("the FedEx factory", () => {
  it("names the settings it is missing, never their values", () => {
    const reason = skipReason("fedex", { FEDEX_CLIENT_SECRET: secret });
    expect(reason).toBe("missing FEDEX_CLIENT_ID, FEDEX_TRACKING_NUMBERS_FILE");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings, and rejects a bad environment or cap", async () => {
    const list = join(await emptyFolder("fedex"), "tracking.txt");
    await writeFile(list, "990000000001\n");
    const env = { FEDEX_CLIENT_ID: id, FEDEX_CLIENT_SECRET: secret, FEDEX_TRACKING_NUMBERS_FILE: list };
    await buildsFromSettings("fedex", env);
    await buildsFromSettings("fedex", { ...env, FEDEX_ENVIRONMENT: "test", FEDEX_MAX_TRACKING_PER_SYNC: "50" });
    await expect(buildsFromSettings("fedex", { ...env, FEDEX_ENVIRONMENT: "staging" })).rejects.toThrow(/FEDEX_ENVIRONMENT must be/);
    await expect(buildsFromSettings("fedex", { ...env, FEDEX_MAX_TRACKING_PER_SYNC: "lots" })).rejects.toThrow(/maxPerSync must be a positive whole number/);
    await expect(buildsFromSettings("fedex", { ...env, FEDEX_CLIENT_ID: "x" })).rejects.toThrow(/FEDEX_CLIENT_ID/);
  });
});
