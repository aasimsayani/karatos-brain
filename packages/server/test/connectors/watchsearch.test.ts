import { describe, expect, it } from "vitest";
import { buildsFromSettings, emptyFolder, skipReason } from "../connector-harness.js";

// Assembled at runtime so no key-shaped string sits in the repository.
const KEY = ["test", "dealer", "key", "0".repeat(24)].join("-");

describe("the TheWatchSearch factory", () => {
  it("needs the export folder and the dealer key, and never names a value", () => {
    expect(skipReason("watchsearch", { WATCHSEARCH_DEALER_KEY: KEY })).toBe("missing WATCHSEARCH_IMPORT_DIR");
    const reason = skipReason("watchsearch", { WATCHSEARCH_IMPORT_DIR: "/data/watch-groups", WATCHSEARCH_DEALER_KEY: " " });
    expect(reason).toBe("missing WATCHSEARCH_DEALER_KEY");
    expect(skipReason("watchsearch", { WATCHSEARCH_DATE_ORDER: KEY })).not.toContain(KEY);
  });

  it("builds the connector from the folder and key, with or without the optional settings", async () => {
    const dir = await emptyFolder("watchsearch");
    await buildsFromSettings("watchsearch", { WATCHSEARCH_IMPORT_DIR: dir, WATCHSEARCH_DEALER_KEY: KEY });
    await buildsFromSettings("watchsearch", {
      WATCHSEARCH_IMPORT_DIR: dir,
      WATCHSEARCH_DEALER_KEY: KEY,
      WATCHSEARCH_DATE_ORDER: "mdy",
      WATCHSEARCH_UTC_OFFSET: "-05:00",
      WATCHSEARCH_CURRENCY: "USD",
    });
  });

  it("rejects a date order it doesn't know before reading anything", async () => {
    const dir = await emptyFolder("watchsearch");
    await expect(buildsFromSettings("watchsearch", { WATCHSEARCH_IMPORT_DIR: dir, WATCHSEARCH_DEALER_KEY: KEY, WATCHSEARCH_DATE_ORDER: "ymd" })).rejects.toThrow(
      "WATCHSEARCH_DATE_ORDER must be auto, dmy or mdy",
    );
  });
});
