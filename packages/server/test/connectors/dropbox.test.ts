import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const settings = { DROPBOX_APP_KEY: "k".repeat(15), DROPBOX_APP_SECRET: "s".repeat(15), DROPBOX_REFRESH_TOKEN: "r".repeat(64), DROPBOX_FOLDER: "/Accounting" };

describe("the Dropbox factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("dropbox", {})).toBe("missing DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN, DROPBOX_FOLDER");
    const { DROPBOX_FOLDER: _, ...rest } = settings;
    expect(skipReason("dropbox", rest)).toBe("missing DROPBOX_FOLDER");
  });

  it("builds the connector from its settings, keeping or dropping names", async () => {
    await buildsFromSettings("dropbox", settings);
    await buildsFromSettings("dropbox", { ...settings, DROPBOX_FILE_NAMES: "drop" });
  });

  it("turns down a folder, name setting or key that doesn't read", async () => {
    await expect(buildsFromSettings("dropbox", { ...settings, DROPBOX_FOLDER: "/" })).rejects.toThrow(/DROPBOX_FOLDER/);
    await expect(buildsFromSettings("dropbox", { ...settings, DROPBOX_FILE_NAMES: "hide" })).rejects.toThrow(/DROPBOX_FILE_NAMES/);
    await expect(buildsFromSettings("dropbox", { ...settings, DROPBOX_APP_KEY: "x" })).rejects.toThrow(/DROPBOX_APP_KEY/);
  });
});
