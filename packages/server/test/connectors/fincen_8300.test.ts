import { describe, expect, it } from "vitest";
import { buildsFromSettings, emptyFolder, skipReason } from "../connector-harness.js";

describe("the Form 8300 factory", () => {
  it("needs the filings log folder", () => {
    expect(skipReason("fincen_8300", {})).toBe("missing FINCEN_8300_IMPORT_DIR");
  });

  it("builds the connector from the folder, with any of the three date orders", async () => {
    const dir = await emptyFolder("fincen-8300");
    await buildsFromSettings("fincen_8300", { FINCEN_8300_IMPORT_DIR: dir });
    for (const order of ["mdy", "dmy", "ymd"]) await buildsFromSettings("fincen_8300", { FINCEN_8300_IMPORT_DIR: dir, FINCEN_8300_DATE_ORDER: order });
  });

  it("stops on a date order it doesn't know", async () => {
    const dir = await emptyFolder("fincen-8300");
    await expect(buildsFromSettings("fincen_8300", { FINCEN_8300_IMPORT_DIR: dir, FINCEN_8300_DATE_ORDER: "md" })).rejects.toThrow("FINCEN_8300_DATE_ORDER must be mdy, dmy or ymd");
  });
});
