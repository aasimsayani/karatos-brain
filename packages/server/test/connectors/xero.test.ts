import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Xero factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("xero", { XERO_CLIENT_SECRET: secret, XERO_REFRESH_TOKEN: secret });
    expect(reason).toBe("missing XERO_CLIENT_ID, XERO_TENANT_ID");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from the app's keys, the tenant and a refresh token", async () => {
    await buildsFromSettings("xero", {
      XERO_CLIENT_ID: "client-id",
      XERO_CLIENT_SECRET: "client-secret-value",
      XERO_TENANT_ID: "00000000-0000-4000-8000-00000000a0a0",
      XERO_REFRESH_TOKEN: "refresh-value",
    });
  });
});
