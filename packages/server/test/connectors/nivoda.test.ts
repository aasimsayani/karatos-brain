import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Shaped like a Nivoda password, assembled so no scanner mistakes it for a real one.
const password = ["test", "nivoda", "x".repeat(16)].join("-");
const username = "buyer@example.test";

describe("the Nivoda factory", () => {
  it("names the settings it is missing, never their values", () => {
    const reason = skipReason("nivoda", { NIVODA_PASSWORD: password });
    expect(reason).toBe("missing NIVODA_USERNAME");
    expect(reason).not.toContain(password);
  });

  it("builds the connector from its settings, and rejects environments, searches and caps that aren't ones", async () => {
    const env = { NIVODA_USERNAME: username, NIVODA_PASSWORD: password };
    await buildsFromSettings("nivoda", env);
    await buildsFromSettings("nivoda", { ...env, NIVODA_ENVIRONMENT: "Staging", NIVODA_QUERY: '{"labgrown":false}', NIVODA_MAX_STONES: "5000" });
    await expect(buildsFromSettings("nivoda", { ...env, NIVODA_ENVIRONMENT: "test" })).rejects.toThrow(/NIVODA_ENVIRONMENT must be production or staging/);
    await expect(buildsFromSettings("nivoda", { ...env, NIVODA_QUERY: "[1]" })).rejects.toThrow(/NIVODA_QUERY must be a JSON object/);
    await expect(buildsFromSettings("nivoda", { ...env, NIVODA_MAX_STONES: "60000" })).rejects.toThrow(/maxStones must be a whole number from 1 to 50,000/);
    await expect(buildsFromSettings("nivoda", { ...env, NIVODA_USERNAME: "a b" })).rejects.toThrow(/NIVODA_USERNAME is missing or not in the expected shape/);
  });
});
