import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// A credential-shaped value, assembled at runtime so no scanner mistakes the source for a leak.
const SETTINGS = { SHIPSTATION_API_KEY: ["TEST", "0".repeat(28)].join("_") };

describe("the ShipStation factory", () => {
  it("names the setting it is missing, never a value", () => {
    expect(skipReason("shipstation", {})).toBe("missing SHIPSTATION_API_KEY");
    expect(skipReason("shipstation", SETTINGS)).toBeNull();
  });

  it("builds the connector from its setting", async () => {
    expect((await buildsFromSettings("shipstation", SETTINGS)).source).toBe("shipstation");
  });

  it("won't build with a key in the wrong shape", async () => {
    await expect(buildsFromSettings("shipstation", { SHIPSTATION_API_KEY: "short" })).rejects.toThrow("SHIPSTATION_API_KEY is missing or not in the expected shape");
  });
});
