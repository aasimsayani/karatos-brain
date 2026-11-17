import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = ["test", "client", "x".repeat(12)].join("-");
const CLIENT_SECRET = ["test", "secret", "y".repeat(24)].join("-");
const STORE = ["5e11e000", "a000", "4000", "a000", "aaaaaaaa0001"].join("-");
const ALL = { EXTEND_CLIENT_ID: CLIENT_ID, EXTEND_CLIENT_SECRET: CLIENT_SECRET, EXTEND_STORE_ID: STORE };

describe("the Extend factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("extend", {})).toBe("missing EXTEND_CLIENT_ID, EXTEND_CLIENT_SECRET, EXTEND_STORE_ID");
    expect(skipReason("extend", { ...ALL, EXTEND_CLIENT_SECRET: "  " })).toBe("missing EXTEND_CLIENT_SECRET");
    expect(skipReason("extend", { ...ALL, EXTEND_STORE_ID: "" })).toBe("missing EXTEND_STORE_ID");
    expect(skipReason("extend", ALL)).toBeNull();
  });

  it("builds the connector from its settings, for production or demo", async () => {
    expect((await buildsFromSettings("extend", { ...ALL, EXTEND_CLIENT_ID: ` ${CLIENT_ID} ` })).source).toBe("extend");
    expect((await buildsFromSettings("extend", { ...ALL, EXTEND_ENVIRONMENT: "demo" })).source).toBe("extend");
    expect((await buildsFromSettings("extend", { ...ALL, EXTEND_ENVIRONMENT: "production" })).source).toBe("extend");
  });

  it("won't build with a store or environment that isn't Extend's, and doesn't echo a secret", async () => {
    const fails = (env: Record<string, string>) => buildsFromSettings("extend", env).then(() => null, (e: unknown) => e as Error);
    const wrong = fakeKey("sk", "live");
    const store = await fails({ ...ALL, EXTEND_STORE_ID: wrong });
    expect(store?.message).toBe("set EXTEND_STORE_ID to the store's ID in Extend, a UUID shown in the Merchant Portal");
    expect(store?.message).not.toContain(wrong);
    expect((await fails({ ...ALL, EXTEND_ENVIRONMENT: "sandbox" }))?.message).toBe("EXTEND_ENVIRONMENT must be production or demo");
    const secret = await fails({ ...ALL, EXTEND_CLIENT_SECRET: "short" });
    expect(secret?.message).toBe("set EXTEND_CLIENT_SECRET to the client secret of the same Extend API Integration");
  });
});
