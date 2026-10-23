import { describe, expect, it } from "vitest";
import { buildsFromSettings, emptyFolder, skipReason } from "../connector-harness.js";

describe("the bank statements factory", () => {
  it("needs the import folder", () => {
    expect(skipReason("bank_statements", {})).toBe("missing BANK_STATEMENTS_IMPORT_DIR");
  });

  it("builds the connector from the import folder", async () => {
    await buildsFromSettings("bank_statements", { BANK_STATEMENTS_IMPORT_DIR: await emptyFolder("bank") });
  });
});
