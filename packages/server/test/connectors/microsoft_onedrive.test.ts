import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const guid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
const settings = { MICROSOFT_TENANT_ID: guid("a"), MICROSOFT_CLIENT_ID: guid("b"), MICROSOFT_CLIENT_SECRET: "s".repeat(40), MICROSOFT_ONEDRIVE_DRIVE_ID: `b!${"d".repeat(64)}` };

describe("the OneDrive and SharePoint factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("microsoft_onedrive", {})).toBe("missing MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_ONEDRIVE_DRIVE_ID");
    const { MICROSOFT_ONEDRIVE_DRIVE_ID: _, ...rest } = settings;
    expect(skipReason("microsoft_onedrive", rest)).toBe("missing MICROSOFT_ONEDRIVE_DRIVE_ID");
  });

  it("builds the connector from its settings, keeping or dropping names, with or without notifications", async () => {
    await buildsFromSettings("microsoft_onedrive", settings);
    await buildsFromSettings("microsoft_onedrive", { ...settings, MICROSOFT_ONEDRIVE_FILE_NAMES: "drop", MICROSOFT_GRAPH_CLIENT_STATE: "c".repeat(32) });
  });

  it("turns down a drive, name setting, client state or id that doesn't read", async () => {
    await expect(buildsFromSettings("microsoft_onedrive", { ...settings, MICROSOFT_ONEDRIVE_DRIVE_ID: "Documents" })).rejects.toThrow(/MICROSOFT_ONEDRIVE_DRIVE_ID/);
    await expect(buildsFromSettings("microsoft_onedrive", { ...settings, MICROSOFT_ONEDRIVE_FILE_NAMES: "hide" })).rejects.toThrow(/MICROSOFT_ONEDRIVE_FILE_NAMES/);
    await expect(buildsFromSettings("microsoft_onedrive", { ...settings, MICROSOFT_GRAPH_CLIENT_STATE: "short" })).rejects.toThrow(/MICROSOFT_GRAPH_CLIENT_STATE/);
    await expect(buildsFromSettings("microsoft_onedrive", { ...settings, MICROSOFT_TENANT_ID: "contoso.onmicrosoft.com" })).rejects.toThrow(/MICROSOFT_TENANT_ID/);
  });
});
