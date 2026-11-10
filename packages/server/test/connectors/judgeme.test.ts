import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Credential-shaped values, assembled at runtime so no scanner mistakes the source for a leak.
const SETTINGS = { JUDGEME_SHOP_DOMAIN: ["test-shop", "myshopify", "com"].join("."), JUDGEME_API_TOKEN: ["jm", "0".repeat(20)].join("_"), CUSTOMER_REF_KEY: "c".repeat(64) };

describe("the Judge.me factory", () => {
  it("names the settings it is missing, never a value", () => {
    const { JUDGEME_API_TOKEN: token, ...rest } = SETTINGS;
    expect(skipReason("judgeme", rest)).toBe("missing JUDGEME_API_TOKEN");
    expect(skipReason("judgeme", { JUDGEME_API_TOKEN: token })).toBe("missing JUDGEME_SHOP_DOMAIN, CUSTOMER_REF_KEY");
    expect(skipReason("judgeme", { JUDGEME_API_TOKEN: token })).not.toContain(token);
    expect(skipReason("judgeme", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings", async () => {
    expect((await buildsFromSettings("judgeme", SETTINGS)).source).toBe("judgeme");
  });

  it("won't build with a setting in the wrong shape", async () => {
    await expect(buildsFromSettings("judgeme", { ...SETTINGS, JUDGEME_SHOP_DOMAIN: "https://x.com" })).rejects.toThrow("JUDGEME_SHOP_DOMAIN is missing or not a domain");
    await expect(buildsFromSettings("judgeme", { ...SETTINGS, JUDGEME_API_TOKEN: "short" })).rejects.toThrow("JUDGEME_API_TOKEN is missing or not in the expected shape");
    await expect(buildsFromSettings("judgeme", { ...SETTINGS, CUSTOMER_REF_KEY: "short" })).rejects.toThrow("CUSTOMER_REF_KEY");
  });
});
