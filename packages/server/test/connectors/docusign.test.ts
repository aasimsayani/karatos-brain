import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const settings = {
  DOCUSIGN_INTEGRATION_KEY: "1a2b3c4d-1a2b-4c3d-8e9f-1a2b3c4d5e6f",
  DOCUSIGN_USER_ID: "2b3c4d5e-2b3c-4d5e-9f0a-2b3c4d5e6f7a",
  DOCUSIGN_ACCOUNT_ID: "3c4d5e6f-3c4d-4e5f-8a1b-3c4d5e6f7a8b",
  DOCUSIGN_PRIVATE_KEY: Buffer.from(pem).toString("base64"),
  CUSTOMER_REF_KEY: "k".repeat(64),
};

describe("the Docusign factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("docusign", {})).toBe("missing DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, DOCUSIGN_ACCOUNT_ID, DOCUSIGN_PRIVATE_KEY, CUSTOMER_REF_KEY");
    const { CUSTOMER_REF_KEY: _, ...rest } = settings;
    expect(skipReason("docusign", rest)).toBe("missing CUSTOMER_REF_KEY");
  });

  it("builds the connector from its settings, for production or the developer environment", async () => {
    await buildsFromSettings("docusign", settings);
    await buildsFromSettings("docusign", { ...settings, DOCUSIGN_ENVIRONMENT: "developer", DOCUSIGN_PRIVATE_KEY: pem });
  });

  it("turns down an environment, id or key that doesn't read", async () => {
    await expect(buildsFromSettings("docusign", { ...settings, DOCUSIGN_ENVIRONMENT: "sandbox" })).rejects.toThrow(/DOCUSIGN_ENVIRONMENT/);
    await expect(buildsFromSettings("docusign", { ...settings, DOCUSIGN_ACCOUNT_ID: "12345" })).rejects.toThrow(/DOCUSIGN_ACCOUNT_ID/);
    await expect(buildsFromSettings("docusign", { ...settings, DOCUSIGN_PRIVATE_KEY: "not a key" })).rejects.toThrow(/DOCUSIGN_PRIVATE_KEY/);
  });
});
