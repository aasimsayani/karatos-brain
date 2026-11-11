import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildsFromSettings, emptyFolder, skipReason } from "../connector-harness.js";

// Shaped like an HRD token, assembled so no scanner mistakes it for a real one.
const token = ["test", "hrd", "0".repeat(24)].join("-");

describe("the HRD factory", () => {
  it("names the settings it is missing, never their values", () => {
    const reason = skipReason("hrd", { HRD_API_TOKEN: token });
    expect(reason).toBe("missing HRD_REPORT_NUMBERS_FILE");
    expect(reason).not.toContain(token);
    expect(skipReason("hrd", {})).toBe("missing HRD_API_TOKEN, HRD_REPORT_NUMBERS_FILE");
  });

  it("builds the connector from its settings, and rejects a lookup cap that isn't a whole number", async () => {
    const list = join(await emptyFolder("hrd"), "reports.txt");
    await writeFile(list, "220000000003\n");
    const env = { HRD_API_TOKEN: token, HRD_REPORT_NUMBERS_FILE: list };
    await buildsFromSettings("hrd", env);
    await buildsFromSettings("hrd", { ...env, HRD_MAX_LOOKUPS_PER_SYNC: "20" });
    await expect(buildsFromSettings("hrd", { ...env, HRD_MAX_LOOKUPS_PER_SYNC: "lots" })).rejects.toThrow(/maxLookups must be a positive whole number/);
    await expect(buildsFromSettings("hrd", { ...env, HRD_API_TOKEN: "short" })).rejects.toThrow(/HRD_API_TOKEN is missing or not in the expected shape/);
  });
});
