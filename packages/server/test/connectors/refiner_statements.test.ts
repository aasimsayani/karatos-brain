import { describe, expect, it } from "vitest";
import { buildsFromSettings, emptyFolder, skipReason } from "../connector-harness.js";

describe("the refiner statements factory", () => {
  it("needs the import folder", () => {
    expect(skipReason("refiner_statements", {})).toBe("missing REFINER_STATEMENTS_IMPORT_DIR");
  });

  it("builds the connector from the import folder", async () => {
    await buildsFromSettings("refiner_statements", { REFINER_STATEMENTS_IMPORT_DIR: await emptyFolder("refiner") });
  });
});
