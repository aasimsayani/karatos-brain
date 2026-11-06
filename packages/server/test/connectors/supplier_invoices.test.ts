import { describe, expect, it } from "vitest";
import { buildsFromSettings, emptyFolder, skipReason } from "../connector-harness.js";

describe("the supplier invoices factory", () => {
  it("needs the import folder", () => {
    expect(skipReason("supplier_invoices", {})).toBe("missing SUPPLIER_INVOICES_IMPORT_DIR");
  });

  it("builds the connector from the import folder", async () => {
    await buildsFromSettings("supplier_invoices", { SUPPLIER_INVOICES_IMPORT_DIR: await emptyFolder("supplier") });
  });
});
