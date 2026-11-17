import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

// Key-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const API_KEY = ["acuity", "test", "x".repeat(20)].join("-");
const REF_KEY = "k".repeat(64);
const ALL = { ACUITY_USER_ID: "1234567", ACUITY_API_KEY: API_KEY, CUSTOMER_REF_KEY: REF_KEY };

describe("the Acuity Scheduling factory", () => {
  it("names the settings it is missing, never their values", () => {
    expect(skipReason("acuity", {})).toBe("missing ACUITY_USER_ID, ACUITY_API_KEY, CUSTOMER_REF_KEY");
    const reason = skipReason("acuity", { ACUITY_USER_ID: "1234567", ACUITY_API_KEY: API_KEY });
    expect(reason).toBe("missing CUSTOMER_REF_KEY");
    expect(reason).not.toContain(API_KEY);
    expect(skipReason("acuity", { ...ALL, ACUITY_API_KEY: "  " })).toBe("missing ACUITY_API_KEY");
    expect(skipReason("acuity", { ...ALL, ACUITY_USER_ID: "" })).toBe("missing ACUITY_USER_ID");
    expect(skipReason("acuity", ALL)).toBeNull();
  });

  it("builds the connector from its settings", async () => {
    const connector = await buildsFromSettings("acuity", { ACUITY_USER_ID: " 1234567 ", ACUITY_API_KEY: ` ${API_KEY} `, CUSTOMER_REF_KEY: REF_KEY });
    expect(connector.source).toBe("acuity");
  });

  it("won't build with settings that don't read, and doesn't echo the key", async () => {
    const fails = (env: Record<string, string>) => buildsFromSettings("acuity", env).then(() => null, (e: unknown) => e as Error);
    expect((await fails({ ...ALL, ACUITY_USER_ID: "user@example.test" }))?.message).toBe("set ACUITY_USER_ID to the numeric user id shown with the API key under Integrations > API in Acuity");
    const wrong = `${fakeKey("sk", "live")} x`;
    const error = await fails({ ...ALL, ACUITY_API_KEY: wrong });
    expect(error?.message).toBe("set ACUITY_API_KEY to the API key shown under Integrations > API in Acuity");
    expect(error?.message).not.toContain(wrong);
    expect((await fails({ ...ALL, CUSTOMER_REF_KEY: "short" }))?.message).toMatch(/^CUSTOMER_REF_KEY must be at least/);
  });
});
