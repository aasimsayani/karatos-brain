import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Shaped like a Rapaport client secret, assembled so no scanner mistakes it for a real one.
const secret = ["test", "rapnet", "0".repeat(24)].join("-");

describe("the RapNet factory", () => {
  it("names the settings it is missing, never their values", () => {
    const reason = skipReason("rapnet", { RAPNET_CLIENT_SECRET: secret });
    expect(reason).toBe("missing RAPNET_CLIENT_ID");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings, and rejects a client ID that isn't one", async () => {
    await buildsFromSettings("rapnet", { RAPNET_CLIENT_ID: "kAratOStest01", RAPNET_CLIENT_SECRET: secret });
    await expect(buildsFromSettings("rapnet", { RAPNET_CLIENT_ID: "has spaces in it", RAPNET_CLIENT_SECRET: secret })).rejects.toThrow(/RAPNET_CLIENT_ID is missing or not in the expected shape/);
  });
});
