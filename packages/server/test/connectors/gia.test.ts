import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildsFromSettings, emptyFolder, skipReason } from "../connector-harness.js";

// Shaped like a GIA API key, assembled so no scanner mistakes it for a real one.
const key = ["test", "gia", "0".repeat(24)].join("-");

describe("the GIA factory", () => {
  it("names the settings it is missing, never their values", () => {
    const reason = skipReason("gia", { GIA_API_KEY: key });
    expect(reason).toBe("missing GIA_API_URL, GIA_REPORT_NUMBERS_FILE");
    expect(reason).not.toContain(key);
  });

  it("builds the connector from its settings, and rejects a lookup cap that isn't a whole number", async () => {
    const list = join(await emptyFolder("gia"), "reports.txt");
    await writeFile(list, "2141438169\n");
    const env = { GIA_API_URL: "https://api.reportresults.gia.edu", GIA_API_KEY: key, GIA_REPORT_NUMBERS_FILE: list };
    await buildsFromSettings("gia", env);
    await buildsFromSettings("gia", { ...env, GIA_MAX_LOOKUPS_PER_SYNC: "20" });
    await expect(buildsFromSettings("gia", { ...env, GIA_MAX_LOOKUPS_PER_SYNC: "lots" })).rejects.toThrow(/maxLookups must be a positive whole number/);
    await expect(buildsFromSettings("gia", { ...env, GIA_API_URL: "https://api.example.test" })).rejects.toThrow(/gia\.edu host/);
  });
});
