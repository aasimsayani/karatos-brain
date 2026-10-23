import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Google Workspace and Drive factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("google_workspace", { GOOGLE_CLIENT_SECRET: secret, GOOGLE_WORKSPACE_REFRESH_TOKEN: secret });
    expect(reason).toBe("missing GOOGLE_CLIENT_ID, GOOGLE_DRIVE_ROOT_FOLDER_ID, CORRESPONDENT_HASH_KEY");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("google_workspace", {
      GOOGLE_CLIENT_ID: "000000000000-test.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "client-secret-value",
      GOOGLE_WORKSPACE_REFRESH_TOKEN: "refresh-value",
      GOOGLE_DRIVE_ROOT_FOLDER_ID: "1TestRootFolder_abcdefghij",
      GOOGLE_DRIVE_FILE_NAMES: "drop",
      CORRESPONDENT_HASH_KEY: "0".repeat(64),
    });
  });
});
