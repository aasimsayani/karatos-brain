import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const token = ["ntn", "x".repeat(46)].join("_");
const source = "1a2b3c4d-1a2b-4c3d-8e9f-1a2b3c4d5e6f";

describe("the Notion factory", () => {
  it("names the setting it is missing, never a value", () => {
    expect(skipReason("notion", {})).toBe("missing NOTION_ACCESS_TOKEN");
    expect(skipReason("notion", { NOTION_DATA_SOURCE_IDS: source })).toBe("missing NOTION_ACCESS_TOKEN");
  });

  it("builds the connector from its settings, with or without data sources", async () => {
    await buildsFromSettings("notion", { NOTION_ACCESS_TOKEN: token });
    await buildsFromSettings("notion", { NOTION_ACCESS_TOKEN: token, NOTION_DATA_SOURCE_IDS: `${source}, ${source.replace(/-/g, "")}` });
  });

  it("turns down data sources that aren't Notion ids", async () => {
    await expect(buildsFromSettings("notion", { NOTION_ACCESS_TOKEN: token, NOTION_DATA_SOURCE_IDS: "Repairs" })).rejects.toThrow(/NOTION_DATA_SOURCE_IDS/);
  });
});
