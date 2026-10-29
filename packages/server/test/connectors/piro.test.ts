import { describe, expect, it } from "vitest";
import { buildsFromSettings, emptyFolder, skipReason } from "../connector-harness.js";

describe("the PIRO factory", () => {
  it("needs the report folder", () => {
    expect(skipReason("piro", {})).toBe("missing PIRO_IMPORT_DIR");
  });

  it("builds the connector from the report folder", async () => {
    await buildsFromSettings("piro", { PIRO_IMPORT_DIR: await emptyFolder("piro") });
  });
});
