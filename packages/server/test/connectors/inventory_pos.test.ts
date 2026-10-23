import { describe, expect, it } from "vitest";
import { buildsFromSettings, emptyFolder, fakeKey, skipReason } from "../connector-harness.js";

describe("the inventory and POS factory", () => {
  it("needs the import folder, and never names a value", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("inventory_pos", { POS_MAPPING_PROFILE: secret });
    expect(reason).toBe("missing POS_IMPORT_DIR");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from the import folder", async () => {
    await buildsFromSettings("inventory_pos", { POS_IMPORT_DIR: await emptyFolder("pos") });
  });
});
