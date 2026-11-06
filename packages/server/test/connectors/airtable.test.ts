import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const token = ["pat", "x".repeat(14), ".", "x".repeat(64)].join("");
const base = `app${"x".repeat(14)}`;

describe("the Airtable factory", () => {
  it("names the setting it is missing, never a value", () => {
    expect(skipReason("airtable", {})).toBe("missing AIRTABLE_ACCESS_TOKEN");
    expect(skipReason("airtable", { AIRTABLE_BASE_IDS: base })).toBe("missing AIRTABLE_ACCESS_TOKEN");
  });

  it("builds the connector from its settings, with or without bases", async () => {
    await buildsFromSettings("airtable", { AIRTABLE_ACCESS_TOKEN: token });
    await buildsFromSettings("airtable", { AIRTABLE_ACCESS_TOKEN: token, AIRTABLE_BASE_IDS: `${base}, app${"y".repeat(14)}` });
  });

  it("turns down bases that aren't Airtable ids", async () => {
    await expect(buildsFromSettings("airtable", { AIRTABLE_ACCESS_TOKEN: token, AIRTABLE_BASE_IDS: "Repairs" })).rejects.toThrow(/AIRTABLE_BASE_IDS/);
  });
});
