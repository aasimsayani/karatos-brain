import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// GUID-shaped values, assembled at runtime so no scanner mistakes the source for a leak.
const guid = (c: string) => [c.repeat(8), c.repeat(4), `4${c.repeat(3)}`, `8${c.repeat(3)}`, c.repeat(12)].join("-");
const SETTINGS = { CIN7_ACCOUNT_ID: guid("a"), CIN7_APPLICATION_KEY: guid("b") };

describe("the Cin7 Core factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("cin7", {})).toBe("missing CIN7_ACCOUNT_ID, CIN7_APPLICATION_KEY");
    expect(skipReason("cin7", { CIN7_ACCOUNT_ID: guid("a") })).toBe("missing CIN7_APPLICATION_KEY");
    expect(skipReason("cin7", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings", async () => {
    expect((await buildsFromSettings("cin7", SETTINGS)).source).toBe("cin7");
  });

  it("won't build with an id or key in the wrong shape, and says which", async () => {
    await expect(buildsFromSettings("cin7", { ...SETTINGS, CIN7_ACCOUNT_ID: "short" })).rejects.toThrow("CIN7_ACCOUNT_ID is missing or isn't a Cin7 Core account id");
    await expect(buildsFromSettings("cin7", { ...SETTINGS, CIN7_APPLICATION_KEY: "short" })).rejects.toThrow("CIN7_APPLICATION_KEY is missing or isn't a Cin7 Core application key");
  });
});
