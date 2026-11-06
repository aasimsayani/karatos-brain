import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const token = ["2", "x".repeat(40)].join("/");

describe("the Asana factory", () => {
  it("names the setting it is missing, never a value", () => {
    expect(skipReason("asana", {})).toBe("missing ASANA_ACCESS_TOKEN");
    expect(skipReason("asana", { ASANA_WORKSPACE_GID: "1001" })).toBe("missing ASANA_ACCESS_TOKEN");
  });

  it("builds the connector from its settings, with or without a workspace", async () => {
    await buildsFromSettings("asana", { ASANA_ACCESS_TOKEN: token });
    await buildsFromSettings("asana", { ASANA_ACCESS_TOKEN: token, ASANA_WORKSPACE_GID: "1001" });
  });

  it("turns down a workspace that isn't an Asana id", async () => {
    await expect(buildsFromSettings("asana", { ASANA_ACCESS_TOKEN: token, ASANA_WORKSPACE_GID: "my workspace" })).rejects.toThrow(/ASANA_WORKSPACE_GID/);
  });
});
