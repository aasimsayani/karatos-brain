import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Clover factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("clover", { CLOVER_REFRESH_TOKEN: secret });
    expect(reason).toBe("missing CLOVER_MERCHANT_ID, CLOVER_REGION, CUSTOMER_REF_KEY, CLOVER_APP_ID, CLOVER_APP_SECRET");
    expect(reason).not.toContain(secret);
    const reason2 = skipReason("clover", { CLOVER_API_TOKEN: secret, CLOVER_MERCHANT_ID: "MTEST0000000A", CLOVER_REGION: "sandbox" });
    expect(reason2).toBe("missing CUSTOMER_REF_KEY");
    expect(reason2).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("clover", {
      CLOVER_MERCHANT_ID: "MTEST0000000A",
      CLOVER_REGION: "north_america",
      CLOVER_APP_ID: "APPTEST00000A",
      CLOVER_APP_SECRET: "app-secret-value-0000",
      CLOVER_REFRESH_TOKEN: "refresh-value",
      CUSTOMER_REF_KEY: "k".repeat(64),
    });
  });
});
