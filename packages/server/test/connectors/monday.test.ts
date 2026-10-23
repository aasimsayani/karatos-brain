import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

describe("the Monday.com factory", () => {
  it("names the settings it is missing, never their values", () => {
    const reason = skipReason("monday", { MONDAY_OAUTH_SCOPES: "boards:read" });
    expect(reason).toBe("missing MONDAY_API_TOKEN");
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("monday", {
      MONDAY_API_TOKEN: ["monday", "test", "0".repeat(24)].join("-"),
      MONDAY_ALLOWED_COLUMNS: "1000000001:text",
    });
  });
});
