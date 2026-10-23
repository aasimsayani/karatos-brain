import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Authorize.net factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("authorize_net", { AUTHORIZE_NET_TRANSACTION_KEY: secret });
    expect(reason).toBe("missing AUTHORIZE_NET_API_LOGIN_ID, AUTHORIZE_NET_ENVIRONMENT");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("authorize_net", {
      AUTHORIZE_NET_API_LOGIN_ID: "testlogin0",
      // Shaped like a Transaction Key, assembled so no scanner mistakes it for one.
      AUTHORIZE_NET_TRANSACTION_KEY: ["TEST", "0".repeat(12)].join(""),
      AUTHORIZE_NET_ENVIRONMENT: "sandbox",
    });
  });
});
