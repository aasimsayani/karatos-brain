import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Assembled at runtime so no key-shaped string sits in the repository.
const KEY = ["test", "0".repeat(28)].join("");

describe("the Metals-API factory", () => {
  it("needs the access key, and never names a value", () => {
    expect(skipReason("metals_api", { METALS_API_HISTORY_DAYS: KEY })).toBe("missing METALS_API_KEY");
    expect(skipReason("metals_api", { METALS_API_KEY: "  " })).toBe("missing METALS_API_KEY");
    expect(skipReason("metals_api", { METALS_API_HISTORY_DAYS: KEY })).not.toContain(KEY);
  });

  it("builds the connector from the key, with or without a history length", async () => {
    await buildsFromSettings("metals_api", { METALS_API_KEY: KEY });
    await buildsFromSettings("metals_api", { METALS_API_KEY: KEY, METALS_API_HISTORY_DAYS: "1825" });
  });

  it("rejects a history length that isn't a whole number of days before reading anything", async () => {
    await expect(buildsFromSettings("metals_api", { METALS_API_KEY: KEY, METALS_API_HISTORY_DAYS: "1y" })).rejects.toThrow("METALS_API_HISTORY_DAYS must be a whole number of days");
    await expect(buildsFromSettings("metals_api", { METALS_API_KEY: KEY, METALS_API_HISTORY_DAYS: "3000" })).rejects.toThrow(/historyDays/);
  });
});
