import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const guid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
const settings = { MICROSOFT_TENANT_ID: guid("a"), MICROSOFT_OUTLOOK_CLIENT_ID: guid("b"), MICROSOFT_OUTLOOK_CLIENT_SECRET: "s".repeat(40), MICROSOFT_OUTLOOK_MAILBOX: "sales@store.test", CORRESPONDENT_HASH_KEY: "k".repeat(40) };

describe("the Microsoft 365 Outlook factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("microsoft_outlook", {})).toBe("missing MICROSOFT_TENANT_ID, MICROSOFT_OUTLOOK_CLIENT_ID, MICROSOFT_OUTLOOK_CLIENT_SECRET, MICROSOFT_OUTLOOK_MAILBOX, CORRESPONDENT_HASH_KEY");
    const { MICROSOFT_OUTLOOK_MAILBOX: _, ...rest } = settings;
    expect(skipReason("microsoft_outlook", rest)).toBe("missing MICROSOFT_OUTLOOK_MAILBOX");
    expect(skipReason("microsoft_outlook", settings)).toBeNull();
  });

  it("builds the connector from its settings, and won't for a setting that doesn't read", async () => {
    await buildsFromSettings("microsoft_outlook", settings);
    await expect(buildsFromSettings("microsoft_outlook", { ...settings, MICROSOFT_OUTLOOK_MAILBOX: "sales" })).rejects.toThrow(/MICROSOFT_OUTLOOK_MAILBOX/);
    await expect(buildsFromSettings("microsoft_outlook", { ...settings, MICROSOFT_OUTLOOK_CLIENT_ID: "app" })).rejects.toThrow(/MICROSOFT_OUTLOOK_CLIENT_ID/);
    await expect(buildsFromSettings("microsoft_outlook", { ...settings, MICROSOFT_TENANT_ID: "contoso" })).rejects.toThrow(/MICROSOFT_TENANT_ID/);
    await expect(buildsFromSettings("microsoft_outlook", { ...settings, MICROSOFT_OUTLOOK_CLIENT_SECRET: "short" })).rejects.toThrow(/MICROSOFT_OUTLOOK_CLIENT_SECRET/);
    await expect(buildsFromSettings("microsoft_outlook", { ...settings, CORRESPONDENT_HASH_KEY: "short" })).rejects.toThrow(/CORRESPONDENT_HASH_KEY/);
  });
});
