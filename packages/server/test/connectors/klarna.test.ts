import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Credential-shaped values, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["klarna", "live", "api", "0".repeat(24)].join("_");
const TEST_KEY = ["klarna", "test", "api", "0".repeat(24)].join("_");
const LOGIN = { KLARNA_USERNAME: ["0".repeat(8), "0000", "4000", "8000", "0".repeat(12)].join("-"), KLARNA_PASSWORD: ["pw", "0".repeat(16)].join("_") };

describe("the Klarna factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("klarna", {})).toBe("missing KLARNA_API_KEY");
    expect(skipReason("klarna", { KLARNA_PASSWORD: LOGIN.KLARNA_PASSWORD })).toBe("missing KLARNA_API_KEY");
    expect(skipReason("klarna", { KLARNA_USERNAME: LOGIN.KLARNA_USERNAME })).toBe("missing KLARNA_PASSWORD");
    expect(skipReason("klarna", { KLARNA_USERNAME: LOGIN.KLARNA_USERNAME })).not.toContain(LOGIN.KLARNA_USERNAME);
    expect(skipReason("klarna", { KLARNA_API_KEY: KEY })).toBeNull();
    expect(skipReason("klarna", LOGIN)).toBeNull();
  });

  it("builds the connector from a key or a username and password, in any region", async () => {
    expect((await buildsFromSettings("klarna", { KLARNA_API_KEY: KEY })).source).toBe("klarna");
    expect((await buildsFromSettings("klarna", { ...LOGIN, KLARNA_REGION: "eu" })).source).toBe("klarna");
    expect((await buildsFromSettings("klarna", { KLARNA_API_KEY: TEST_KEY, KLARNA_ENVIRONMENT: "playground", KLARNA_REGION: "OC" })).source).toBe("klarna");
  });

  it("won't build with a setting in the wrong shape", async () => {
    await expect(buildsFromSettings("klarna", { KLARNA_API_KEY: "short" })).rejects.toThrow("KLARNA_API_KEY is not in the expected shape");
    await expect(buildsFromSettings("klarna", { KLARNA_API_KEY: TEST_KEY })).rejects.toThrow("KLARNA_API_KEY is a test key, so it can't be used with the production API");
    await expect(buildsFromSettings("klarna", { KLARNA_API_KEY: KEY, KLARNA_REGION: "us" })).rejects.toThrow("KLARNA_REGION must be eu, na or oc");
    await expect(buildsFromSettings("klarna", { KLARNA_API_KEY: KEY, KLARNA_ENVIRONMENT: "staging" })).rejects.toThrow("KLARNA_ENVIRONMENT must be production or playground");
    await expect(buildsFromSettings("klarna", { ...LOGIN, KLARNA_PASSWORD: "has spaces in it" })).rejects.toThrow("KLARNA_PASSWORD is missing or not in the expected shape");
  });
});
