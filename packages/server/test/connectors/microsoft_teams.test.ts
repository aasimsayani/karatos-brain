import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const guid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
const settings = { MICROSOFT_TENANT_ID: guid("a"), MICROSOFT_TEAMS_CLIENT_ID: guid("b"), MICROSOFT_TEAMS_CLIENT_SECRET: "s".repeat(40), MICROSOFT_TEAMS_TEAM_ID: guid("c"), CORRESPONDENT_HASH_KEY: "k".repeat(40) };

describe("the Microsoft Teams factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("microsoft_teams", {})).toBe("missing MICROSOFT_TENANT_ID, MICROSOFT_TEAMS_CLIENT_ID, MICROSOFT_TEAMS_CLIENT_SECRET, MICROSOFT_TEAMS_TEAM_ID, CORRESPONDENT_HASH_KEY");
    const { MICROSOFT_TEAMS_TEAM_ID: _, ...rest } = settings;
    expect(skipReason("microsoft_teams", rest)).toBe("missing MICROSOFT_TEAMS_TEAM_ID");
    expect(skipReason("microsoft_teams", settings)).toBeNull();
  });

  it("builds the connector from its settings, and won't for a setting that doesn't read", async () => {
    await buildsFromSettings("microsoft_teams", settings);
    await expect(buildsFromSettings("microsoft_teams", { ...settings, MICROSOFT_TEAMS_TEAM_ID: "sales" })).rejects.toThrow(/MICROSOFT_TEAMS_TEAM_ID/);
    await expect(buildsFromSettings("microsoft_teams", { ...settings, MICROSOFT_TEAMS_CLIENT_ID: "app" })).rejects.toThrow(/MICROSOFT_TEAMS_CLIENT_ID/);
    await expect(buildsFromSettings("microsoft_teams", { ...settings, MICROSOFT_TENANT_ID: "contoso" })).rejects.toThrow(/MICROSOFT_TENANT_ID/);
    await expect(buildsFromSettings("microsoft_teams", { ...settings, MICROSOFT_TEAMS_CLIENT_SECRET: "short" })).rejects.toThrow(/MICROSOFT_TEAMS_CLIENT_SECRET/);
    await expect(buildsFromSettings("microsoft_teams", { ...settings, CORRESPONDENT_HASH_KEY: "short" })).rejects.toThrow(/CORRESPONDENT_HASH_KEY/);
  });
});
