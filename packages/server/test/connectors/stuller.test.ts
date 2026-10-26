import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Shaped like a Stuller developer password, assembled so no scanner mistakes it for a real one.
const password = ["test", "stuller", "0".repeat(16)].join("-");

describe("the Stuller factory", () => {
  it("names the settings it is missing, never their values", () => {
    const reason = skipReason("stuller", { STULLER_PASSWORD: password });
    expect(reason).toBe("missing STULLER_USERNAME");
    expect(reason).not.toContain(password);
  });

  it("builds the connector from its settings, and rejects a username that isn't one", async () => {
    await buildsFromSettings("stuller", { STULLER_USERNAME: "karatos-dev", STULLER_PASSWORD: password });
    await expect(buildsFromSettings("stuller", { STULLER_USERNAME: "has:colon", STULLER_PASSWORD: password })).rejects.toThrow(/STULLER_USERNAME is missing or not in the expected shape/);
  });
});
