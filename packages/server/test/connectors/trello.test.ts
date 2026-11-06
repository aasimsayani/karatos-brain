import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const key = "a".repeat(32);
const token = "x".repeat(64);

describe("the Trello factory", () => {
  it("names the settings it is missing, never their values", () => {
    expect(skipReason("trello", {})).toBe("missing TRELLO_API_KEY, TRELLO_TOKEN");
    const reason = skipReason("trello", { TRELLO_TOKEN: token });
    expect(reason).toBe("missing TRELLO_API_KEY");
    expect(reason).not.toContain(token);
    expect(skipReason("trello", { TRELLO_API_KEY: key })).toBe("missing TRELLO_TOKEN");
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("trello", { TRELLO_API_KEY: key, TRELLO_TOKEN: token });
  });
});
