import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["0a1b2c3d", "4e5f", "4a6b", "8c7d", "9e0f1a2b3c4d"].join("-");
const PASSWORD = ["test", "p".repeat(12)].join("-");
const ALL = { JM_SHIPPING_API_KEY: KEY, JM_SHIPPING_PASSWORD: PASSWORD, JM_SHIPPING_CLIENT_ID: "4321" };

describe("the JM Shipping Solution factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("jm_shipping_solution", {})).toBe("missing JM_SHIPPING_API_KEY, JM_SHIPPING_PASSWORD, JM_SHIPPING_CLIENT_ID");
    expect(skipReason("jm_shipping_solution", { ...ALL, JM_SHIPPING_PASSWORD: "  " })).toBe("missing JM_SHIPPING_PASSWORD");
    expect(skipReason("jm_shipping_solution", { JM_SHIPPING_API_KEY: KEY })).toBe("missing JM_SHIPPING_PASSWORD, JM_SHIPPING_CLIENT_ID");
    expect(skipReason("jm_shipping_solution", ALL)).toBeNull();
  });

  it("builds the connector from its settings, with JM_SHIPPING_API_BASE optional", async () => {
    expect((await buildsFromSettings("jm_shipping_solution", { ...ALL, JM_SHIPPING_API_KEY: ` ${KEY} ` })).source).toBe("jm_shipping_solution");
    expect((await buildsFromSettings("jm_shipping_solution", { ...ALL, JM_SHIPPING_API_BASE: " https://api.transguardian.com " })).source).toBe("jm_shipping_solution");
    expect((await buildsFromSettings("jm_shipping_solution", { ...ALL, JM_SHIPPING_API_BASE: "  " })).source).toBe("jm_shipping_solution");
  });

  it("won't build with a key, client id or host that doesn't read, and doesn't echo the key", async () => {
    const wrong = fakeKey("sk", "live");
    const fail = (env: Record<string, string>) => buildsFromSettings("jm_shipping_solution", env).then(() => null, (e: unknown) => e as Error);
    const error = await fail({ ...ALL, JM_SHIPPING_API_KEY: wrong });
    expect(error?.message).toBe("set JM_SHIPPING_API_KEY to the key JM issued the store, a GUID such as 00000000-0000-0000-0000-000000000000");
    expect(error?.message).not.toContain(wrong);
    expect((await fail({ ...ALL, JM_SHIPPING_CLIENT_ID: "abc" }))?.message).toBe("set JM_SHIPPING_CLIENT_ID to the store's JM client id, a whole number from 1 to 9999999999");
    expect((await fail({ ...ALL, JM_SHIPPING_API_BASE: "https://example.test" }))?.message).toMatch(/^JM_SHIPPING_API_BASE must be the https address of a JM Shipping Solution host on transguardian.com/);
  });
});
