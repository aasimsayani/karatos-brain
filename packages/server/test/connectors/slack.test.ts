import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Slack factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("slack", { SLACK_BOT_TOKEN: secret });
    expect(reason).toBe("missing CORRESPONDENT_HASH_KEY");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("slack", {
      SLACK_BOT_TOKEN: ["xoxb", "0".repeat(12), "TESTtokenTESTtoken"].join("-"),
      CORRESPONDENT_HASH_KEY: "0".repeat(64),
    });
  });
});
