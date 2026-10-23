import { describe, expect, it } from "vitest";
import { buildsFromSettings, emptyFolder, skipReason } from "../connector-harness.js";

describe("the Chase factory", () => {
  it("needs both the import mode and the folder", () => {
    expect(skipReason("chase", { CHASE_IMPORT_MODE: "manual_pdf" })).toBe("missing CHASE_MANUAL_IMPORT_DIR");
    expect(skipReason("chase", { CHASE_MANUAL_IMPORT_DIR: "/data/chase" })).toBe("missing CHASE_IMPORT_MODE");
  });

  it("builds the connector from the mode and folder", async () => {
    await buildsFromSettings("chase", { CHASE_IMPORT_MODE: "manual_csv_and_pdf", CHASE_MANUAL_IMPORT_DIR: await emptyFolder("chase") });
  });
});
