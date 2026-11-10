import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Shaped like a BILL client id and secret, assembled so no scanner mistakes them for real ones.
const id = ["test", "0".repeat(20)].join("");
const secret = ["test", "1".repeat(40)].join("");

describe("the BILL factory", () => {
  it("names the settings it is missing, never their values", () => {
    const reason = skipReason("bill_com", { BILL_CLIENT_SECRET: secret });
    expect(reason).toBe("missing BILL_CLIENT_ID");
    expect(reason).not.toContain(secret);
    expect(skipReason("bill_com", {})).toBe("missing BILL_CLIENT_ID, BILL_CLIENT_SECRET");
  });

  it("builds the connector from its settings, and rejects a bad environment or id", async () => {
    const env = { BILL_CLIENT_ID: id, BILL_CLIENT_SECRET: secret };
    await buildsFromSettings("bill_com", env);
    await buildsFromSettings("bill_com", { ...env, BILL_ENVIRONMENT: "sandbox" });
    await expect(buildsFromSettings("bill_com", { ...env, BILL_ENVIRONMENT: "stage" })).rejects.toThrow(/BILL_ENVIRONMENT must be/);
    await expect(buildsFromSettings("bill_com", { ...env, BILL_CLIENT_ID: "x" })).rejects.toThrow(/BILL_CLIENT_ID/);
    await expect(buildsFromSettings("bill_com", { ...env, BILL_CLIENT_SECRET: "short" })).rejects.toThrow(/BILL_CLIENT_SECRET/);
  });
});
