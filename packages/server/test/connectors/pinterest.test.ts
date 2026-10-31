import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const SETTINGS = { PINTEREST_CLIENT_ID: "1234567", PINTEREST_CLIENT_SECRET: "s".repeat(40), PINTEREST_REFRESH_TOKEN: `pinr.${"r".repeat(60)}` };

describe("the Pinterest factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    expect(skipReason("pinterest", { PINTEREST_CLIENT_ID: "1", PINTEREST_CLIENT_SECRET: secret })).toBe("missing PINTEREST_REFRESH_TOKEN");
    expect(skipReason("pinterest", { PINTEREST_REFRESH_TOKEN: secret })).toBe("missing PINTEREST_CLIENT_ID, PINTEREST_CLIENT_SECRET");
    expect(skipReason("pinterest", { PINTEREST_CLIENT_ID: "1", PINTEREST_CLIENT_SECRET: secret })).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("pinterest", SETTINGS);
  });

  it("won't build without the app's id and secret", async () => {
    await expect(buildsFromSettings("pinterest", { ...SETTINGS, PINTEREST_CLIENT_ID: "has space" })).rejects.toThrow("set PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET");
  });
});
