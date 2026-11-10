import { describe, expect, it } from "vitest";
import { buildsFromSettings, emptyFolder, skipReason } from "../connector-harness.js";

describe("the tray counts factory", () => {
  it("needs the export folder", () => {
    expect(skipReason("rfid_counts", {})).toBe("missing RFID_COUNTS_IMPORT_DIR");
  });

  it("builds the connector from the folder, with any of the three date orders and a UTC offset", async () => {
    const dir = await emptyFolder("rfid-counts");
    await buildsFromSettings("rfid_counts", { RFID_COUNTS_IMPORT_DIR: dir });
    for (const order of ["mdy", "dmy", "ymd"]) await buildsFromSettings("rfid_counts", { RFID_COUNTS_IMPORT_DIR: dir, RFID_COUNTS_DATE_ORDER: order });
    await buildsFromSettings("rfid_counts", { RFID_COUNTS_IMPORT_DIR: dir, RFID_COUNTS_UTC_OFFSET: "-05:00" });
  });

  it("stops on a date order or offset it doesn't know", async () => {
    const dir = await emptyFolder("rfid-counts");
    await expect(buildsFromSettings("rfid_counts", { RFID_COUNTS_IMPORT_DIR: dir, RFID_COUNTS_DATE_ORDER: "md" })).rejects.toThrow("RFID_COUNTS_DATE_ORDER must be mdy, dmy or ymd");
    await expect(buildsFromSettings("rfid_counts", { RFID_COUNTS_IMPORT_DIR: dir, RFID_COUNTS_UTC_OFFSET: "EST" })).rejects.toThrow("utcOffset must be Z or an offset such as -05:00");
  });
});
