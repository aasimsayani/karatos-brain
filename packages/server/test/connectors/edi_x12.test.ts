import { describe, expect, it } from "vitest";
import { buildsFromSettings, emptyFolder, fakeKey, skipReason } from "../connector-harness.js";

describe("the EDI factory", () => {
  it("needs the mailbox folder, and never names a value", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("edi_x12", { EDI_PARTNER_KEY: secret });
    expect(reason).toBe("missing EDI_IMPORT_DIR");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from the mailbox folder", async () => {
    await buildsFromSettings("edi_x12", { EDI_IMPORT_DIR: await emptyFolder("edi") });
  });
});
