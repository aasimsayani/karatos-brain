import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// A credential-shaped value, assembled at runtime so no scanner mistakes the source for a leak.
const SETTINGS = { KATANA_API_KEY: ["katana", "0".repeat(24)].join("-") };

describe("the Katana factory", () => {
  it("names the setting it is missing, never a value", () => {
    expect(skipReason("katana", {})).toBe("missing KATANA_API_KEY");
    expect(skipReason("katana", SETTINGS)).toBeNull();
  });

  it("builds the connector from its setting", async () => {
    expect((await buildsFromSettings("katana", SETTINGS)).source).toBe("katana");
  });

  it("won't build with a key in the wrong shape", async () => {
    await expect(buildsFromSettings("katana", { KATANA_API_KEY: "short" })).rejects.toThrow("KATANA_API_KEY is missing or not in the expected shape");
  });
});
