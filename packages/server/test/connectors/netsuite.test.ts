import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Credential-shaped values, assembled at runtime so no scanner mistakes the source for a leak; the key is made fresh each run.
const KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const SETTINGS = { NETSUITE_ACCOUNT_ID: "1234567", NETSUITE_CLIENT_ID: ["cl", "a".repeat(30)].join(""), NETSUITE_CERTIFICATE_ID: ["cert", "-b".repeat(10)].join(""), NETSUITE_PRIVATE_KEY: KEY };

describe("the NetSuite factory", () => {
  it("names the settings it is missing, never a value", () => {
    const { NETSUITE_ACCOUNT_ID: account, NETSUITE_PRIVATE_KEY: key, ...rest } = SETTINGS;
    expect(skipReason("netsuite", rest)).toBe("missing NETSUITE_ACCOUNT_ID, NETSUITE_PRIVATE_KEY");
    expect(skipReason("netsuite", { ...rest, NETSUITE_ACCOUNT_ID: account })).toBe("missing NETSUITE_PRIVATE_KEY");
    expect(skipReason("netsuite", { NETSUITE_PRIVATE_KEY: key })).toBe("missing NETSUITE_ACCOUNT_ID, NETSUITE_CLIENT_ID, NETSUITE_CERTIFICATE_ID");
    expect(skipReason("netsuite", { NETSUITE_PRIVATE_KEY: key })).not.toContain("PRIVATE KEY-----");
    expect(skipReason("netsuite", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings", async () => {
    expect((await buildsFromSettings("netsuite", SETTINGS)).source).toBe("netsuite");
  });

  it("won't build with a setting in the wrong shape", async () => {
    await expect(buildsFromSettings("netsuite", { ...SETTINGS, NETSUITE_ACCOUNT_ID: "acme" })).rejects.toThrow("NETSUITE_ACCOUNT_ID is missing or not in the expected shape");
    await expect(buildsFromSettings("netsuite", { ...SETTINGS, NETSUITE_PRIVATE_KEY: "not a key" })).rejects.toThrow("NETSUITE_PRIVATE_KEY is missing or isn't the certificate's private key");
  });
});
