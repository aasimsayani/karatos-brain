import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Credential-shaped values, assembled at runtime so no scanner mistakes the source for a leak.
const SETTINGS = { ZOOM_ACCOUNT_ID: ["acct", "0".repeat(8)].join("_"), ZOOM_CLIENT_ID: ["cid", "0".repeat(8)].join("_"), ZOOM_CLIENT_SECRET: ["zs", "0".repeat(24)].join("_"), CUSTOMER_REF_KEY: "c".repeat(64) };

describe("the Zoom factory", () => {
  it("names the settings it is missing, never a value", () => {
    const { ZOOM_CLIENT_SECRET: secret, ...rest } = SETTINGS;
    expect(skipReason("zoom", rest)).toBe("missing ZOOM_CLIENT_SECRET");
    expect(skipReason("zoom", { ZOOM_CLIENT_SECRET: secret })).toBe("missing ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, CUSTOMER_REF_KEY");
    expect(skipReason("zoom", { ZOOM_CLIENT_SECRET: secret })).not.toContain(secret);
    expect(skipReason("zoom", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings", async () => {
    expect((await buildsFromSettings("zoom", SETTINGS)).source).toBe("zoom");
  });

  it("won't build with a setting in the wrong shape", async () => {
    await expect(buildsFromSettings("zoom", { ...SETTINGS, ZOOM_ACCOUNT_ID: "short" })).rejects.toThrow("ZOOM_ACCOUNT_ID is missing or not in the expected shape");
    await expect(buildsFromSettings("zoom", { ...SETTINGS, ZOOM_CLIENT_ID: "bad id!!" })).rejects.toThrow("ZOOM_CLIENT_ID is missing or not in the expected shape");
    await expect(buildsFromSettings("zoom", { ...SETTINGS, ZOOM_CLIENT_SECRET: "short" })).rejects.toThrow("ZOOM_CLIENT_SECRET is missing or not in the expected shape");
    await expect(buildsFromSettings("zoom", { ...SETTINGS, CUSTOMER_REF_KEY: "short" })).rejects.toThrow("CUSTOMER_REF_KEY");
  });
});
